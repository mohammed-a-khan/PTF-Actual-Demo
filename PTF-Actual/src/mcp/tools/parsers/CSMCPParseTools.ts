/**
 * PTF-ADO MCP Parser Tools
 *
 *   - data_parse         xlsx/csv/json/xml/yaml/tsv/properties → canonical scenarios JSON
 *   - legacy_parse       Java+TestNG / C#+NUnit source → canonical IR
 *   - extract_db_calls   Inline SQL / JDBC / Hibernate → migration plan
 *
 * All are deterministic and LLM-free.
 *
 * @module CSMCPParseTools
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { MCPToolDefinition, MCPToolResult } from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// ============================================================================
// Helpers
// ============================================================================

function createJsonResult(data: unknown): MCPToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function createErrorResult(message: string): MCPToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function readFileSafe(p: string): string | null {
    try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

// ============================================================================
// Shared shapes
// ============================================================================

interface ScenarioRow {
    scenarioId: string;
    scenarioName: string;
    runFlag: 'Yes' | 'No';
    [key: string]: unknown;
}

// ============================================================================
// data_parse — format-agnostic conversion to scenarios JSON
// ============================================================================

function parseCsvLine(line: string, delimiter: string): string[] {
    const cells: string[] = [];
    let buf = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { buf += '"'; i++; }
                else inQuotes = false;
            } else buf += ch;
        } else {
            if (ch === delimiter) { cells.push(buf); buf = ''; }
            else if (ch === '"') inQuotes = true;
            else buf += ch;
        }
    }
    cells.push(buf);
    return cells.map(c => c.trim());
}

function splitCsvRows(text: string): string[] {
    const rows: string[] = [];
    let buf = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            if (inQuotes && text[i + 1] === '"') { buf += '""'; i++; }
            else { inQuotes = !inQuotes; buf += ch; }
        } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            rows.push(buf); buf = '';
        } else buf += ch;
    }
    if (buf.length) rows.push(buf);
    return rows;
}

function parseDelimited(content: string, delimiter: string, idColumn?: string): ScenarioRow[] {
    const rawRows = splitCsvRows(content).filter(r => r.trim().length);
    if (rawRows.length === 0) return [];
    const header = parseCsvLine(rawRows[0], delimiter);
    const idIdx = idColumn
        ? header.indexOf(idColumn)
        : header.findIndex(h => /^(scenario[_ ]?id|test[_ ]?id|tc[_ ]?id|id)$/i.test(h));
    const nameIdx = header.findIndex(h => /^(scenario[_ ]?name|test[_ ]?name|name|description)$/i.test(h));
    const runIdx = header.findIndex(h => /^(runflag|run[_ ]?flag|run)$/i.test(h));

    const rows: ScenarioRow[] = [];
    for (let i = 1; i < rawRows.length; i++) {
        const cells = parseCsvLine(rawRows[i], delimiter);
        const obj: Record<string, unknown> = {};
        header.forEach((h, hi) => {
            if (h) obj[toCamelCaseKey(h)] = (cells[hi] ?? '').trim();
        });
        const scenarioId = idIdx >= 0 ? (cells[idIdx] ?? '').trim() : `TC_${String(i).padStart(3, '0')}`;
        const scenarioName = nameIdx >= 0 ? (cells[nameIdx] ?? '').trim() : scenarioId;
        const runFlag = (runIdx >= 0 ? cells[runIdx] : 'Yes').trim() === 'No' ? 'No' : 'Yes';
        rows.push({ scenarioId, scenarioName, runFlag, ...obj });
    }
    return rows;
}

function toCamelCaseKey(header: string): string {
    return header
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .map((w, i) => i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
}

function parseJsonToRows(content: string): ScenarioRow[] {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return []; }
    if (Array.isArray(parsed)) {
        return parsed.map((r, i) => normaliseRow(r as Record<string, unknown>, i));
    }
    if (parsed && typeof parsed === 'object') {
        // object-with-keyed-rows → one row per key
        return Object.entries(parsed as Record<string, unknown>).map(([k, v], i) =>
            normaliseRow({ ...(v as Record<string, unknown>), scenarioId: k }, i)
        );
    }
    return [];
}

function parseYamlToRows(content: string): ScenarioRow[] {
    try {
        const parsed = yaml.load(content);
        if (Array.isArray(parsed)) return parsed.map((r, i) => normaliseRow(r as Record<string, unknown>, i));
        if (parsed && typeof parsed === 'object') {
            return Object.entries(parsed as Record<string, unknown>).map(([k, v], i) =>
                normaliseRow({ ...(v as Record<string, unknown>), scenarioId: k }, i)
            );
        }
    } catch { /* fallthrough */ }
    return [];
}

function parsePropertiesToRows(content: string): ScenarioRow[] {
    // Flat key=value groups are ambiguous as scenario rows; we group by leading prefix.
    // Pattern: scenario1.userName=alice, scenario1.role=admin → row scenarioId="scenario1"
    const byScenario = new Map<string, Record<string, unknown>>();
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        const dot = key.indexOf('.');
        if (dot > 0) {
            const sid = key.slice(0, dot);
            const sub = key.slice(dot + 1);
            if (!byScenario.has(sid)) byScenario.set(sid, {});
            byScenario.get(sid)![toCamelCaseKey(sub)] = value;
        }
    }
    const rows: ScenarioRow[] = [];
    let i = 0;
    for (const [sid, obj] of byScenario) {
        rows.push(normaliseRow({ scenarioId: sid, ...obj }, i++));
    }
    return rows;
}

async function parseXmlToRows(content: string): Promise<ScenarioRow[]> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const xml2js = require('xml2js');
        const parsed = await xml2js.parseStringPromise(content, { explicitArray: false, mergeAttrs: true });
        // Best-effort: find array-ish child that looks like scenarios
        const flatten = (obj: unknown): ScenarioRow[] => {
            if (Array.isArray(obj)) {
                return obj.map((r, i) => normaliseRow(r as Record<string, unknown>, i));
            }
            if (obj && typeof obj === 'object') {
                for (const v of Object.values(obj as Record<string, unknown>)) {
                    if (Array.isArray(v)) return v.map((r, i) => normaliseRow(r as Record<string, unknown>, i));
                    if (v && typeof v === 'object') {
                        const r = flatten(v);
                        if (r.length) return r;
                    }
                }
            }
            return [];
        };
        return flatten(parsed);
    } catch {
        return [];
    }
}

function parseXlsxToRows(absPath: string, sheetName?: string): ScenarioRow[] {
    let XLSX: any;
    try {
        // xlsx is a peer dependency
        const mod = 'xlsx';
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        XLSX = require(mod);
    } catch {
        throw new Error('xlsx module not installed (peer dependency). Run: npm install xlsx');
    }
    const workbook = XLSX.readFile(absPath);
    const chosen = sheetName ?? workbook.SheetNames[0];
    const sheet = workbook.Sheets[chosen];
    if (!sheet) throw new Error(`Sheet not found: ${chosen}`);
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }) as Record<string, unknown>[];
    return rawRows.map((r, i) => {
        const obj: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) obj[toCamelCaseKey(k)] = String(v ?? '');
        return normaliseRow(obj, i);
    });
}

function normaliseRow(obj: Record<string, unknown>, index: number): ScenarioRow {
    const pick = (...keys: string[]): string | undefined => {
        for (const k of keys) {
            if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).length) return String(obj[k]);
        }
        return undefined;
    };
    const scenarioId = pick('scenarioId', 'testId', 'tcId', 'id') ?? `TC_${String(index + 1).padStart(3, '0')}`;
    const scenarioName = pick('scenarioName', 'testName', 'name', 'description') ?? scenarioId;
    const rawRun = pick('runFlag', 'run') ?? 'Yes';
    const runFlag = /^(no|false|0|skip)$/i.test(rawRun) ? 'No' : 'Yes';
    return { scenarioId, scenarioName, runFlag, ...obj };
}

const dataParseTool = defineTool()
    .name('data_parse')
    .title('Parse Data File')
    .description(
        'Convert a legacy data file (xlsx/xls/csv/tsv/json/xml/yaml/yml/properties/ini) ' +
        'into canonical scenarios JSON. Auto-detects format by extension.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            scenarios: { type: 'array', items: { type: 'object' } },
            rowCount: { type: 'number' },
            format: { type: 'string' },
        },
    })
    .category('audit')
    .stringParam('path', 'Data file path', { required: true })
    .stringParam('sheet', 'Excel sheet name (xlsx only; defaults to first sheet)')
    .stringParam('idColumn', 'Source column to use as scenarioId (auto-detected if omitted)')
    .handler(async (params) => {
        const filePath = params.path as string;
        const sheet = params.sheet as string | undefined;
        const idColumn = params.idColumn as string | undefined;
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        if (!fs.existsSync(absPath)) return createErrorResult(`File not found: ${absPath}`);
        const ext = path.extname(absPath).toLowerCase();

        try {
            let rows: ScenarioRow[] = [];
            let format = ext;
            if (ext === '.xlsx' || ext === '.xls') {
                rows = parseXlsxToRows(absPath, sheet);
                format = 'xlsx';
            } else if (ext === '.csv') {
                rows = parseDelimited(readFileSafe(absPath) ?? '', ',', idColumn);
                format = 'csv';
            } else if (ext === '.tsv') {
                rows = parseDelimited(readFileSafe(absPath) ?? '', '\t', idColumn);
                format = 'tsv';
            } else if (ext === '.json') {
                rows = parseJsonToRows(readFileSafe(absPath) ?? '');
                format = 'json';
            } else if (ext === '.yaml' || ext === '.yml') {
                rows = parseYamlToRows(readFileSafe(absPath) ?? '');
                format = 'yaml';
            } else if (ext === '.xml') {
                rows = await parseXmlToRows(readFileSafe(absPath) ?? '');
                format = 'xml';
            } else if (ext === '.properties' || ext === '.ini') {
                rows = parsePropertiesToRows(readFileSafe(absPath) ?? '');
                format = 'properties';
            } else {
                return createErrorResult(`Unsupported data-file extension: ${ext}`);
            }

            const placeholders = rows.filter(r =>
                Object.values(r).some(v => typeof v === 'string' && /REPLACE_WITH_/.test(v))
            );

            return createJsonResult({
                source: absPath,
                format,
                sheet: sheet ?? null,
                rowCount: rows.length,
                placeholderRows: placeholders.length,
                scenarios: rows,
            });
        } catch (err: any) {
            return createErrorResult(`Parse failed (${ext}): ${err.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// legacy_parse — Java+TestNG / C#+NUnit source → canonical IR
// ============================================================================

interface IRStep {
    action: string;
    target?: { type: string; value: string };
    element?: { locator_type: string; value: string; description: string };
    expected?: string;
    value?: string;
    rawLine: string;
}

interface IRTest {
    id: string;
    name: string;
    description?: string;
    tags: string[];
    data_refs: Array<{ key: string; source_file: string }>;
    steps: IRStep[];
    db_ops: Array<{ type: string; sql_raw: string; params: string[]; suggested_name: string; return_shape: string }>;
}

interface IRDoc {
    source: { path: string; language: string; test_runner: string; hash: string };
    tests: IRTest[];
    page_objects: Array<{ name: string; elements: Array<{ field: string; locator_type: string; value: string; description: string }> }>;
    summary: { test_count: number; parse_confidence: string };
}

import * as crypto from 'crypto';

function detectJavaRunner(content: string): string {
    if (/org\.testng/.test(content)) return 'testng';
    if (/org\.junit\.jupiter/.test(content)) return 'junit5';
    if (/org\.junit/.test(content)) return 'junit4';
    return 'testng';
}

function detectCsharpRunner(content: string): string {
    if (/using\s+NUnit\.Framework/.test(content)) return 'nunit';
    if (/using\s+Xunit/.test(content)) return 'xunit';
    if (/using\s+Microsoft\.VisualStudio\.TestTools/.test(content)) return 'mstest';
    return 'nunit';
}

function extractJavaTests(content: string): IRTest[] {
    const tests: IRTest[] = [];
    // Match @Test(...) optional, followed by method
    const re = /@Test\b(?:\s*\([^)]*\))?\s*(?:public|protected|private)?\s*\w+\s+(\w+)\s*\(\s*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{([\s\S]*?)^\s*\}/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const name = m[1];
        const body = m[2];
        const steps = extractStepsFromMethodBody(body);
        const dataRefs = extractDataRefsFromBody(body);
        const dbOps = extractDbOpsFromBody(body);
        tests.push({
            id: name,
            name,
            tags: [],
            data_refs: dataRefs,
            steps,
            db_ops: dbOps,
        });
    }
    return tests;
}

function extractCsharpTests(content: string): IRTest[] {
    const tests: IRTest[] = [];
    const re = /\[Test(?:Case[^\]]*)?\](?:\s*\[[^\]]*\])*\s*(?:public|protected|private)?\s*\w+\s+(\w+)\s*\(\s*\)\s*\{([\s\S]*?)^\s*\}/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const name = m[1];
        const body = m[2];
        tests.push({
            id: name,
            name,
            tags: [],
            data_refs: extractDataRefsFromBody(body),
            steps: extractStepsFromMethodBody(body),
            db_ops: extractDbOpsFromBody(body),
        });
    }
    return tests;
}

function extractStepsFromMethodBody(body: string): IRStep[] {
    const steps: IRStep[] = [];
    const lines = body.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;

        // driver.get("URL")  /  page.navigate("URL")
        let m: RegExpMatchArray | null;
        if ((m = trimmed.match(/(?:driver|page|browser)\.(get|navigate|navigateTo)\s*\(\s*"([^"]+)"/))) {
            steps.push({ action: 'navigate', target: { type: 'url', value: m[2] }, rawLine: trimmed });
            continue;
        }
        // .click() on an element
        if ((m = trimmed.match(/(\w+)\.click\s*\(\s*\)/))) {
            steps.push({ action: 'click', element: { locator_type: 'field', value: m[1], description: m[1] }, rawLine: trimmed });
            continue;
        }
        // .sendKeys("...") / .fill("...")
        if ((m = trimmed.match(/(\w+)\.(sendKeys|fill|type|setText)\s*\(\s*"([^"]*)"/))) {
            steps.push({ action: 'fill', element: { locator_type: 'field', value: m[1], description: m[1] }, value: m[3], rawLine: trimmed });
            continue;
        }
        // assertEquals / Assert.AreEqual
        if ((m = trimmed.match(/(?:assertEquals|Assert\.AreEqual)\s*\(\s*"([^"]*)"\s*,/))) {
            steps.push({ action: 'assert_text', expected: m[1], rawLine: trimmed });
            continue;
        }
        // assertTrue(element.isDisplayed())
        if (/(?:assertTrue|Assert\.IsTrue).*isDisplayed/.test(trimmed)) {
            const elm = trimmed.match(/(\w+)\.isDisplayed/);
            steps.push({ action: 'assert_visible', element: elm ? { locator_type: 'field', value: elm[1], description: elm[1] } : undefined, rawLine: trimmed });
            continue;
        }
    }
    return steps;
}

function extractDataRefsFromBody(body: string): Array<{ key: string; source_file: string }> {
    const refs: Array<{ key: string; source_file: string }> = [];
    const re = /"([\w./\\-]+\.(xlsx|xls|csv|tsv|json|yaml|yml|xml|properties))"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        refs.push({ key: path.basename(m[1], path.extname(m[1])), source_file: m[1] });
    }
    return refs;
}

function extractDbOpsFromBody(body: string): Array<{ type: string; sql_raw: string; params: string[]; suggested_name: string; return_shape: string }> {
    const ops: Array<{ type: string; sql_raw: string; params: string[]; suggested_name: string; return_shape: string }> = [];
    // Rough capture of SQL string literals
    const re = /"((?:SELECT|INSERT|UPDATE|DELETE)\s[\s\S]*?)"/gi;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(body)) !== null) {
        const sql = m[1];
        const lower = sql.toLowerCase();
        const type = lower.startsWith('select') ? 'select' :
            lower.startsWith('insert') ? 'insert' :
            lower.startsWith('update') ? 'update' : 'delete';
        const tableMatch = sql.match(/FROM\s+(\w+)|INTO\s+(\w+)|UPDATE\s+(\w+)/i);
        const table = (tableMatch?.[1] ?? tableMatch?.[2] ?? tableMatch?.[3] ?? 'UNKNOWN').toUpperCase();
        ops.push({
            type,
            sql_raw: sql,
            params: [],
            suggested_name: `${table}_${type.toUpperCase()}_${++idx}`,
            return_shape: type === 'select' ? 'list' : 'void',
        });
    }
    return ops;
}

function extractJavaPageObjects(content: string): Array<{ name: string; elements: Array<{ field: string; locator_type: string; value: string; description: string }> }> {
    const pages: Array<{ name: string; elements: Array<{ field: string; locator_type: string; value: string; description: string }> }> = [];
    const classRe = /public\s+class\s+(\w+Page)[^{]*\{([\s\S]*?)^}/gm;
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(content)) !== null) {
        const className = m[1];
        const body = m[2];
        const elements: Array<{ field: string; locator_type: string; value: string; description: string }> = [];
        // @FindBy(id="..."), @FindBy(xpath="..."), @FindBy(css="...")
        const fbRe = /@FindBy\s*\(\s*(id|xpath|css|name)\s*=\s*"([^"]+)"\s*\)\s*(?:public|protected|private)?\s*\w+\s+(\w+)\s*;/g;
        let fm: RegExpExecArray | null;
        while ((fm = fbRe.exec(body)) !== null) {
            elements.push({
                field: fm[3],
                locator_type: fm[1],
                value: fm[2],
                description: fm[3],
            });
        }
        pages.push({ name: className, elements });
    }
    return pages;
}

const legacyParseTool = defineTool()
    .name('legacy_parse')
    .title('Parse Legacy Source')
    .description(
        'Parse a legacy source file (Java+TestNG/JUnit, C#+NUnit/xUnit) into canonical IR. ' +
        'Auto-detects language by extension; auto-detects runner from imports.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            source: { type: 'object' },
            tests: { type: 'array', items: { type: 'object' } },
            page_objects: { type: 'array', items: { type: 'object' } },
            summary: { type: 'object' },
        },
    })
    .category('audit')
    .stringParam('file', 'Source file path', { required: true })
    .stringParam('language', 'java | csharp (auto if omitted)')
    .stringParam('runner', 'testng | junit4 | junit5 | nunit | xunit | mstest (auto if omitted)')
    .handler(async (params) => {
        const file = params.file as string;
        const absFile = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
        const content = readFileSafe(absFile);
        if (content === null) return createErrorResult(`Cannot read file: ${absFile}`);

        const lang = (params.language as string | undefined)
            ?? (absFile.endsWith('.java') ? 'java' : absFile.endsWith('.cs') ? 'csharp' : '');
        if (lang !== 'java' && lang !== 'csharp') {
            return createErrorResult(`Unsupported or undetected language: ${lang}`);
        }
        const runner = (params.runner as string | undefined)
            ?? (lang === 'java' ? detectJavaRunner(content) : detectCsharpRunner(content));

        const tests = lang === 'java' ? extractJavaTests(content) : extractCsharpTests(content);
        const pageObjects = lang === 'java' ? extractJavaPageObjects(content) : [];
        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

        const confidence = tests.length > 0
            ? (tests.every(t => t.steps.length > 0) ? 'high' : 'medium')
            : 'low';

        const ir: IRDoc = {
            source: { path: absFile, language: lang, test_runner: runner, hash: `sha256-${hash}` },
            tests,
            page_objects: pageObjects,
            summary: { test_count: tests.length, parse_confidence: confidence },
        };
        return createJsonResult(ir);
    })
    .readOnly()
    .build();

// ============================================================================
// extract_db_calls — pull inline SQL into migration plan
// ============================================================================

interface DbCallPlanEntry {
    callSite: { file: string; line: number };
    originalSql: string;
    parameterised: string;
    params: string[];
    suggestedName: string;
    returnShape: 'single-row' | 'list' | 'void';
    table: string;
    /**
     * When true, schema_lookup should verify this op's table before ship.
     * Extracted legacy SQL is `false` by default — it's been running in
     * production, so there is no fabrication risk. Only LLM-proposed new
     * SQL should set this to `true`.
     */
    verificationNeeded: boolean;
    /** Where the SQL came from — useful for tracing and the Healer. */
    sourceKind: 'inline' | 'properties' | 'mybatis-xml' | 'hibernate-xml' | 'sql-file';
}

function classifySqlType(sql: string): 'select' | 'insert' | 'update' | 'delete' {
    const s = sql.trim().toLowerCase();
    if (s.startsWith('select') || s.startsWith('with ')) return 'select';
    if (s.startsWith('insert')) return 'insert';
    if (s.startsWith('update')) return 'update';
    return 'delete';
}

function extractTable(sql: string): string {
    const m = sql.match(/FROM\s+([\w.$]+)|INTO\s+([\w.$]+)|UPDATE\s+([\w.$]+)/i);
    return ((m?.[1] ?? m?.[2] ?? m?.[3] ?? 'UNKNOWN') as string).toUpperCase();
}

function inferReturnShape(type: string, sql: string): 'single-row' | 'list' | 'void' {
    if (type !== 'select') return 'void';
    return /COUNT\(|MAX\(|MIN\(|SUM\(|LIMIT\s+1|ROWNUM\s*<\s*=\s*1/i.test(sql) ? 'single-row' : 'list';
}

/**
 * Parse a Java .properties file. Handles line continuations (trailing \),
 * `#`/`!` comments, keys with dots / dashes / underscores.
 * Returns entries whose value starts with SELECT|INSERT|UPDATE|DELETE|WITH.
 */
function extractSqlFromProperties(content: string, absFile: string): DbCallPlanEntry[] {
    const plan: DbCallPlanEntry[] = [];
    const lines = content.split(/\r?\n/);
    let idx = 0;

    // Join continuation lines
    const logicalLines: Array<{ text: string; lineNo: number }> = [];
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const trimLeft = line.replace(/^\s+/, '');
        if (!trimLeft || trimLeft.startsWith('#') || trimLeft.startsWith('!')) continue;
        let lineNo = i + 1;
        while (line.endsWith('\\') && i + 1 < lines.length) {
            line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
        }
        logicalLines.push({ text: line.trim(), lineNo });
    }

    for (const { text, lineNo } of logicalLines) {
        const eq = text.search(/[=:]/);
        if (eq < 0) continue;
        const key = text.slice(0, eq).trim();
        const value = text.slice(eq + 1).trim();
        if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(value)) continue;

        const type = classifySqlType(value);
        const table = extractTable(value);
        const { parameterised, params } = parameteriseSql(value, value, idx);
        plan.push({
            callSite: { file: absFile, line: lineNo },
            originalSql: value,
            parameterised,
            params,
            suggestedName: key.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
            returnShape: inferReturnShape(type, value),
            table,
            verificationNeeded: false,
            sourceKind: 'properties',
        });
        idx++;
    }
    return plan;
}

/**
 * Parse MyBatis XML mapper. Captures <select|insert|update|delete id="...">
 * bodies. Converts #{name} placeholders to :1 :2 :3 positional markers.
 */
function extractSqlFromMyBatisXml(content: string, absFile: string): DbCallPlanEntry[] {
    const plan: DbCallPlanEntry[] = [];
    const re = /<(select|insert|update|delete)\b[^>]*\bid\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    let idx = 0;
    const lineOffsets: number[] = [];
    { let pos = 0; for (const l of content.split('\n')) { lineOffsets.push(pos); pos += l.length + 1; } }

    while ((m = re.exec(content)) !== null) {
        const type = m[1].toLowerCase() as 'select' | 'insert' | 'update' | 'delete';
        const id = m[2];
        let sql = m[3]
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const named: string[] = [];
        sql = sql.replace(/#\{(\w+)[^}]*\}/g, (_, n) => {
            named.push(n);
            return `:${named.length}`;
        });

        let lineNo = 1;
        for (let i = lineOffsets.length - 1; i >= 0; i--) {
            if (lineOffsets[i] <= m.index) { lineNo = i + 1; break; }
        }

        plan.push({
            callSite: { file: absFile, line: lineNo },
            originalSql: sql,
            parameterised: sql,
            params: named,
            suggestedName: id.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
            returnShape: inferReturnShape(type, sql),
            table: extractTable(sql),
            verificationNeeded: false,
            sourceKind: 'mybatis-xml',
        });
        idx++;
    }
    return plan;
}

/**
 * Parse Hibernate mapping XML — named queries.
 */
function extractSqlFromHibernateXml(content: string, absFile: string): DbCallPlanEntry[] {
    const plan: DbCallPlanEntry[] = [];
    const re = /<sql-query\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/sql-query>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const name = m[1];
        let sql = m[2]
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const named: string[] = [];
        sql = sql.replace(/:(\w+)/g, (_, n) => { named.push(n); return `:${named.length}`; });
        const type = classifySqlType(sql);
        plan.push({
            callSite: { file: absFile, line: 1 },
            originalSql: sql,
            parameterised: sql,
            params: named,
            suggestedName: name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
            returnShape: inferReturnShape(type, sql),
            table: extractTable(sql),
            verificationNeeded: false,
            sourceKind: 'hibernate-xml',
        });
    }
    return plan;
}

/**
 * Parse a standalone .sql file — split on `;` at line boundaries,
 * ignore blank statements and `-- comments`.
 */
function extractSqlFromSqlFile(content: string, absFile: string): DbCallPlanEntry[] {
    const plan: DbCallPlanEntry[] = [];
    const stripped = content
        .split('\n')
        .map(l => l.replace(/--.*$/, '').trimEnd())
        .join('\n');
    const statements = stripped.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);
    let idx = 0;
    for (const sql of statements) {
        if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) continue;
        const type = classifySqlType(sql);
        plan.push({
            callSite: { file: absFile, line: 1 },
            originalSql: sql,
            parameterised: sql,
            params: [],
            suggestedName: `${extractTable(sql)}_${type.toUpperCase()}_${String(++idx).padStart(2, '0')}`,
            returnShape: inferReturnShape(type, sql),
            table: extractTable(sql),
            verificationNeeded: false,
            sourceKind: 'sql-file',
        });
    }
    return plan;
}

function parameteriseSql(sql: string, body: string, idx: number): { parameterised: string; params: string[] } {
    // Handle simple "WHERE X = " + var patterns, and ? placeholders.
    const parts = sql.split(/"\s*\+\s*|"\s*,\s*/);
    if (parts.length === 1 && !/\?/.test(sql)) {
        return { parameterised: sql, params: [] };
    }
    // Very conservative — look for concatenation before the closing quote in the broader context
    const concatRe = /"\s*\+\s*(\w+)\s*(?:\+\s*"|,)/g;
    const params: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = concatRe.exec(body)) !== null) {
        params.push(m[1]);
        if (params.length >= 10) break;
    }
    let parameterised = sql;
    params.forEach((_, i) => {
        parameterised = parameterised.replace(/\+\s*\w+/, `:${i + 1}`);
    });
    if (/\?/.test(parameterised)) {
        // Replace ? with :N sequentially
        let n = params.length;
        parameterised = parameterised.replace(/\?/g, () => `:${++n}`);
    }
    return { parameterised, params };
}

function detectSqlSourceKind(absFile: string, content: string): DbCallPlanEntry['sourceKind'] {
    const ext = path.extname(absFile).toLowerCase();
    if (ext === '.properties') return 'properties';
    if (ext === '.sql') return 'sql-file';
    if (ext === '.xml') {
        if (/<mapper\b|<select\b[^>]*\bid\s*=|<insert\b[^>]*\bid\s*=/i.test(content)) return 'mybatis-xml';
        if (/<sql-query\b|<hibernate-mapping\b/i.test(content)) return 'hibernate-xml';
        return 'mybatis-xml';
    }
    return 'inline';
}

function extractInlineSql(content: string, absFile: string): DbCallPlanEntry[] {
    const plan: DbCallPlanEntry[] = [];
    const re = /"((?:SELECT|INSERT|UPDATE|DELETE)\s[^"]+)"/gi;
    let m: RegExpExecArray | null;
    let idx = 0;
    const lines = content.split('\n');
    const lineIndex: number[] = [];
    { let pos = 0; for (let i = 0; i < lines.length; i++) { lineIndex.push(pos); pos += lines[i].length + 1; } }

    while ((m = re.exec(content)) !== null) {
        const sql = m[1];
        const offset = m.index;
        let lineNo = 1;
        for (let i = lineIndex.length - 1; i >= 0; i--) {
            if (lineIndex[i] <= offset) { lineNo = i + 1; break; }
        }
        const from = Math.max(0, offset - 200);
        const to = Math.min(content.length, offset + sql.length + 200);
        const window = content.substring(from, to);
        const { parameterised, params } = parameteriseSql(sql, window, idx);
        const type = classifySqlType(sql);
        const table = extractTable(sql);
        plan.push({
            callSite: { file: absFile, line: lineNo },
            originalSql: sql,
            parameterised,
            params,
            suggestedName: `${table}_${type.toUpperCase()}_${String(++idx).padStart(2, '0')}`,
            returnShape: inferReturnShape(type, sql),
            table,
            verificationNeeded: false,
            sourceKind: 'inline',
        });
    }
    return plan;
}

const extractDbCallsTool = defineTool()
    .name('extract_db_calls')
    .title('Extract DB Calls')
    .description(
        'Extract SQL from a legacy source into a migration plan. Supports: ' +
        'inline SQL in .java/.cs source; key=sql entries in .properties; ' +
        '<select|insert|update|delete> in MyBatis mapper .xml; <sql-query> in ' +
        'Hibernate mapping .xml; and raw statements in .sql files. Every ' +
        'extracted op is tagged verificationNeeded:false — SQL pulled from ' +
        'production code is not fabricated and does not need schema_lookup.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            file: { type: 'string' },
            sourceKind: { type: 'string' },
            opCount: { type: 'number' },
            plan: { type: 'array', items: { type: 'object' } },
            nextSteps: { type: 'string' },
        },
    })
    .category('audit')
    .stringParam('file', 'Source file to scan (.java, .cs, .properties, .xml, .sql)', { required: true })
    .handler(async (params) => {
        const file = params.file as string;
        const absFile = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
        const content = readFileSafe(absFile);
        if (content === null) return createErrorResult(`Cannot read file: ${absFile}`);

        const sourceKind = detectSqlSourceKind(absFile, content);
        let plan: DbCallPlanEntry[];
        switch (sourceKind) {
            case 'properties':    plan = extractSqlFromProperties(content, absFile); break;
            case 'mybatis-xml':   plan = extractSqlFromMyBatisXml(content, absFile); break;
            case 'hibernate-xml': plan = extractSqlFromHibernateXml(content, absFile); break;
            case 'sql-file':      plan = extractSqlFromSqlFile(content, absFile); break;
            case 'inline':
            default:              plan = extractInlineSql(content, absFile); break;
        }

        return createJsonResult({
            file: absFile,
            sourceKind,
            opCount: plan.length,
            plan,
            nextSteps: plan.length > 0
                ? 'For each entry: (1) add to <project>-db-queries.env as DB_QUERY_<suggestedName>, ' +
                  '(2) generate helper method, (3) if verificationNeeded=true call schema_lookup first. ' +
                  'Extracted legacy SQL sets verificationNeeded=false; the fabrication gate is skipped.'
                : `No SQL found in ${sourceKind} source. No DB migration needed for this file.`,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Export + registration
// ============================================================================

export const parseTools: MCPToolDefinition[] = [
    dataParseTool,
    legacyParseTool,
    extractDbCallsTool,
];

export function registerParseTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(parseTools);
}
