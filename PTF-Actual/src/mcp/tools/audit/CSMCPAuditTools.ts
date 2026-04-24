/**
 * PTF-ADO MCP Audit Tools
 *
 * Deterministic rule-based auditing of generated framework files, plus
 * thin wrappers for compile-check and project detection. These tools are
 * the quality backbone of the agentic migration pipeline — they let
 * agents validate output without relying on LLM self-checks.
 *
 * Exposed tools:
 *   - audit_file          Audit a file on disk against MANDATED rules
 *   - audit_content       Audit inline content (for pre-write validation)
 *   - compile_check       Run `npx tsc --noEmit`, return structured errors
 *   - detect_project      Auto-detect project name from workspace signals
 *
 * @module CSMCPAuditTools
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    MCPToolDefinition,
    MCPToolResult,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';
import { AuditEngine, FileType } from './AuditEngine';

// ============================================================================
// Lazy-loaded audit engine (rules parsed once per process)
// ============================================================================

let _engine: AuditEngine | null = null;

function engine(): AuditEngine {
    if (_engine === null) {
        _engine = new AuditEngine();
    }
    return _engine;
}

// ============================================================================
// Result helpers (mirror the local helpers used by sibling tool modules)
// ============================================================================

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(data, null, 2),
            },
        ],
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [
            {
                type: 'text',
                text: message,
            },
        ],
        isError: true,
    };
}

// ============================================================================
// audit_file — read a file from disk and audit it
// ============================================================================

const auditFileTool = defineTool()
    .name('audit_file')
    .title('Audit File')
    .description(
        'Audit a TypeScript, Gherkin, or JSON file against the MANDATED ' +
        'framework rules. Optionally also runs tsc and attaches TypeScript ' +
        'compile errors for the same file. Returns structured violations ' +
        'with rule IDs, severities, and line numbers. pass=false if any ' +
        'error-severity rule violation or TS error is present.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            file: { type: 'string' },
            fileType: { type: 'string' },
            pass: { type: 'boolean' },
            violations: { type: 'array', items: { type: 'object' } },
            stats: { type: 'object' },
            compileChecked: { type: 'boolean' },
        },
    })
    .category('audit')
    .stringParam('path', 'Absolute or workspace-relative file path', { required: true })
    .stringParam('fileType', 'Which rule set to apply', {
        required: true,
        enum: ['page', 'step', 'feature', 'data', 'helper', 'ts'],
    })
    .booleanParam('includeCompileErrors', 'Also run tsc and include compile errors for this file')
    .stringParam('cwd', 'Workspace root for tsc (defaults to process.cwd())')
    .handler(async (params) => {
        const rel = params.path as string;
        const fileType = params.fileType as FileType;
        const includeCompile = params.includeCompileErrors === true;
        const cwd = (params.cwd as string | undefined) ?? process.cwd();
        const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);

        let content: string;
        try {
            content = fs.readFileSync(abs, 'utf-8');
        } catch (err: any) {
            return createErrorResult(`Unable to read ${abs}: ${err.message}`);
        }

        let ruleResult;
        try {
            ruleResult = engine().audit(content, fileType);
        } catch (err: any) {
            return createErrorResult(`Audit engine failure: ${err.message}`);
        }

        // Optional TS compile pass — file-scoped filter
        let compileErrors: TsCompileError[] = [];
        let compileChecked = false;
        if (includeCompile && /\.ts$/.test(abs)) {
            compileChecked = true;
            try {
                execSync('npx tsc --noEmit', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (err: any) {
                const combined = (err.stdout ? String(err.stdout) : '') + '\n' + (err.stderr ? String(err.stderr) : '');
                const all = parseTsErrors(combined);
                const relFromCwd = path.relative(cwd, abs).replace(/\\/g, '/');
                compileErrors = all.filter(e => {
                    const rf = e.file.replace(/\\/g, '/');
                    return rf === relFromCwd || rf === abs || rf.endsWith('/' + path.basename(abs));
                });
            }
        }

        // Fold TS errors into violations as pseudo-rule TS_COMPILE
        const tsViolations = compileErrors.map(e => ({
            ruleId: 'TS_COMPILE_' + e.code,
            severity: 'error' as const,
            line: e.line,
            message: `${e.code}: ${e.message}`,
        }));

        const allViolations = [...ruleResult.violations, ...tsViolations];
        const errors = allViolations.filter(v => v.severity === 'error').length;
        const warnings = allViolations.length - errors;

        return createJsonResult({
            file: abs,
            fileType,
            pass: errors === 0,
            violations: allViolations,
            stats: {
                ...ruleResult.stats,
                tsCompileErrors: compileErrors.length,
                errors,
                warnings,
            },
            compileChecked,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// audit_content — audit a string (pre-write validation)
// ============================================================================

const auditContentTool = defineTool()
    .name('audit_content')
    .title('Audit Content')
    .description(
        'Audit inline file content before writing it to disk. Use this to ' +
        'validate proposed content (e.g., a draft page object) against the ' +
        'MANDATED rules without an intermediate write-and-read cycle.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            fileType: { type: 'string' },
            pass: { type: 'boolean' },
            violations: { type: 'array', items: { type: 'object' } },
            stats: { type: 'object' },
        },
    })
    .category('audit')
    .stringParam('content', 'File content to audit', { required: true })
    .stringParam('fileType', 'Which rule set to apply', {
        required: true,
        enum: ['page', 'step', 'feature', 'data', 'helper', 'ts'],
    })
    .handler(async (params) => {
        const content = params.content as string;
        const fileType = params.fileType as FileType;
        try {
            const result = engine().audit(content, fileType);
            return createJsonResult({ fileType, ...result });
        } catch (err: any) {
            return createErrorResult(`Audit engine failure: ${err.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// compile_check — thin structured wrapper over `tsc --noEmit`
// ============================================================================

interface TsCompileError {
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
}

/**
 * Parse TypeScript compiler output of the form:
 *   src/foo.ts(42,10): error TS1234: Missing semicolon.
 */
function parseTsErrors(output: string): TsCompileError[] {
    const pattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
    const errors: TsCompileError[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(output)) !== null) {
        errors.push({
            file: m[1],
            line: Number(m[2]),
            column: Number(m[3]),
            code: m[4],
            message: m[5].trim(),
        });
    }
    return errors;
}

const compileCheckTool = defineTool()
    .name('compile_check')
    .title('Compile Check')
    .description(
        'Run `npx tsc --noEmit` in the given workspace root and return ' +
        'structured compile errors. Returns clean=true if the project ' +
        'compiles with zero errors.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            clean: { type: 'boolean' },
            errors: { type: 'array', items: { type: 'object' } },
        },
    })
    .category('audit')
    .stringParam('cwd', 'Workspace root (defaults to process.cwd())')
    .handler(async (params) => {
        const cwd = (params.cwd as string | undefined) || process.cwd();
        try {
            execSync('npx tsc --noEmit', {
                cwd,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return createJsonResult({ clean: true, errors: [], cwd });
        } catch (err: any) {
            const stdout = err.stdout ? String(err.stdout) : '';
            const stderr = err.stderr ? String(err.stderr) : '';
            const combined = stdout + '\n' + stderr;
            const errors = parseTsErrors(combined);
            return createJsonResult({
                clean: false,
                errors,
                errorCount: errors.length,
                raw: combined.trim().slice(0, 8000), // cap for MCP payload size
                cwd,
            });
        }
    })
    .readOnly()
    .build();

// ============================================================================
// detect_project — auto-detect project name from workspace signals
// ============================================================================

interface ProjectCandidate {
    name: string;
    source: string;
    confidence: number;
}

function readFileSafe(p: string): string | null {
    try {
        return fs.readFileSync(p, 'utf-8');
    } catch {
        return null;
    }
}

function detectProjectCandidates(cwd: string): ProjectCandidate[] {
    const candidates: ProjectCandidate[] = [];

    // Signal 1 (highest): explicit .agent-pipeline.yaml with project_name
    const pipelineCfg = path.join(cwd, '.agent-pipeline.yaml');
    const pipelineContent = readFileSafe(pipelineCfg);
    if (pipelineContent) {
        const m = pipelineContent.match(/^project_name\s*:\s*["']?([\w-]+)["']?\s*$/m);
        if (m) {
            candidates.push({
                name: m[1],
                source: '.agent-pipeline.yaml project_name',
                confidence: 100,
            });
        }
    }

    // Signal 2: config/<name>/common/common.env PROJECT_NAME=<value>
    const configDir = path.join(cwd, 'config');
    let configSubdirs: string[] = [];
    if (fs.existsSync(configDir)) {
        try {
            configSubdirs = fs
                .readdirSync(configDir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => e.name);
        } catch { /* ignore */ }
        for (const sub of configSubdirs) {
            const envPath = path.join(configDir, sub, 'common', 'common.env');
            const envContent = readFileSafe(envPath);
            if (envContent) {
                const m = envContent.match(/^PROJECT_NAME\s*=\s*([^\r\n#]+?)\s*$/m);
                if (m) {
                    candidates.push({
                        name: m[1].trim(),
                        source: `config/${sub}/common/common.env PROJECT_NAME`,
                        confidence: 90,
                    });
                }
            }
        }
    }

    // Signal 3: package.json scripts with --project=<name>
    const pkgPath = path.join(cwd, 'package.json');
    const pkgContent = readFileSafe(pkgPath);
    if (pkgContent) {
        try {
            const pkg = JSON.parse(pkgContent) as { scripts?: Record<string, string> };
            const scripts = pkg.scripts || {};
            const nameSet = new Set<string>();
            for (const cmd of Object.values(scripts)) {
                if (typeof cmd !== 'string') continue;
                const re = /--project[=\s]+([\w-]+)/g;
                let m: RegExpExecArray | null;
                while ((m = re.exec(cmd)) !== null) {
                    nameSet.add(m[1]);
                }
            }
            for (const n of nameSet) {
                candidates.push({
                    name: n,
                    source: 'package.json scripts --project flag',
                    confidence: 80,
                });
            }
        } catch { /* ignore malformed package.json */ }
    }

    // Signal 4: single non-shared subfolder under config/
    const sharedNames = new Set(['common', 'environments', 'shared', '_shared']);
    const realConfigSubs = configSubdirs.filter(n => !sharedNames.has(n));
    if (realConfigSubs.length === 1) {
        candidates.push({
            name: realConfigSubs[0],
            source: `sole non-shared subfolder: config/${realConfigSubs[0]}`,
            confidence: 70,
        });
    }

    // Signal 5: single non-hidden subfolder under test/
    const testDir = path.join(cwd, 'test');
    if (fs.existsSync(testDir)) {
        try {
            const testSubs = fs
                .readdirSync(testDir, { withFileTypes: true })
                .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
                .map(e => e.name);
            if (testSubs.length === 1) {
                candidates.push({
                    name: testSubs[0],
                    source: `sole subfolder: test/${testSubs[0]}`,
                    confidence: 60,
                });
            }
        } catch { /* ignore */ }
    }

    // Deduplicate by name, keeping the highest-confidence entry
    const byName = new Map<string, ProjectCandidate>();
    for (const c of candidates) {
        const prev = byName.get(c.name);
        if (!prev || prev.confidence < c.confidence) {
            byName.set(c.name, c);
        }
    }
    return [...byName.values()].sort((a, b) => b.confidence - a.confidence);
}

const detectProjectTool = defineTool()
    .name('detect_project')
    .title('Detect Project')
    .description(
        'Auto-detect the consumer project name by scanning workspace ' +
        'signals: .agent-pipeline.yaml, config/<name>/common.env, ' +
        'package.json scripts, folder structure. Returns ranked candidates.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            candidates: { type: 'array', items: { type: 'object' } },
            selected: { type: 'string' },
        },
    })
    .category('audit')
    .stringParam('cwd', 'Workspace root (defaults to process.cwd())')
    .handler(async (params) => {
        const cwd = (params.cwd as string | undefined) || process.cwd();
        const candidates = detectProjectCandidates(cwd);
        const ambiguous = candidates.length > 1;
        const recommended = candidates.length > 0 ? candidates[0] : null;

        return createJsonResult({
            cwd,
            candidates,
            recommended,
            ambiguous,
            count: candidates.length,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// commit_ready_check — the 9-gate exit bar
// ============================================================================

interface GateResult {
    id: number;
    name: string;
    pass: boolean;
    details: unknown;
}

function inferFileType(p: string): FileType {
    const base = path.basename(p).toLowerCase();
    if (/\.feature$/.test(base)) return 'feature';
    if (/_scenarios\.json$/.test(base) || /^scenarios.*\.json$/.test(base)) return 'data';
    if (/helper\.ts$/.test(base)) return 'helper';
    if (/page\.ts$/.test(base)) return 'page';
    if (/steps\.ts$/.test(base) || /\.steps\.ts$/.test(base)) return 'step';
    return 'ts';
}

const commitReadyCheckTool = defineTool()
    .name('commit_ready_check')
    .title('Commit Ready Check')
    .description(
        'Run the 9-gate exit bar on a set of generated files. Returns { ready, gates[] } ' +
        'where ready is true iff every gate passes. Never claims ready with failing tests — ' +
        'the healerGreen flag must be true (set by pipeline-healer on SUCCESS).'
    )
    .outputSchema({
        type: 'object',
        properties: {
            ready: { type: 'boolean' },
            gates: { type: 'array', items: { type: 'object' } },
        },
    })
    .category('audit')
    .arrayParam('files', 'Absolute or relative paths of generated files', 'string', { required: true })
    .booleanParam('healerGreen', 'True iff pipeline-healer returned SUCCESS', { required: true })
    .stringParam('featuresDir', 'Relative path to features dir (for scenarioId coverage check)')
    .stringParam('dataDir', 'Relative path to data dir (for scenarioId coverage check)')
    .stringParam('dbQueriesEnv', 'Path to <project>-db-queries.env (for SQL-grounded gate)')
    .stringParam('cwd', 'Workspace root (defaults to process.cwd())')
    .handler(async (params) => {
        const files = params.files as string[];
        const healerGreen = params.healerGreen as boolean;
        const cwd = (params.cwd as string | undefined) ?? process.cwd();
        const dbQueriesEnv = params.dbQueriesEnv as string | undefined;
        const featuresDir = params.featuresDir as string | undefined;
        const dataDir = params.dataDir as string | undefined;

        const gates: GateResult[] = [];

        // Gate 1: compile
        let compileClean = true;
        let compileDetails: unknown = null;
        try {
            execSync('npx tsc --noEmit', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err: any) {
            compileClean = false;
            const combined = (err.stdout ? String(err.stdout) : '') + '\n' + (err.stderr ? String(err.stderr) : '');
            compileDetails = { errors: parseTsErrors(combined), raw: combined.slice(0, 4000) };
        }
        gates.push({ id: 1, name: 'compile', pass: compileClean, details: compileDetails });

        // Gate 2: audit each file
        const allViolations: Array<{ file: string; ruleId: string; severity: string; line: number | null; message: string }> = [];
        for (const f of files) {
            const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
            const content = readFileSafeLocal(abs);
            if (content === null) continue;
            const ft = inferFileType(abs);
            const r = engine().audit(content, ft);
            for (const v of r.violations.filter(x => x.severity === 'error')) {
                allViolations.push({ file: abs, ruleId: v.ruleId, severity: v.severity, line: v.line, message: v.message });
            }
        }
        gates.push({ id: 2, name: 'audit', pass: allViolations.length === 0, details: allViolations.length === 0 ? null : { violations: allViolations } });

        // Gate 3: tests green (delegated — healer must have returned SUCCESS)
        gates.push({
            id: 3,
            name: 'tests_green',
            pass: healerGreen === true,
            details: healerGreen ? null : { reason: 'Caller passed healerGreen=false; pipeline-healer did not return SUCCESS' },
        });

        // Gate 4: no placeholder tokens
        const placeholderPattern = /\b(TODO|FIXME|XXX|HACK|PLACEHOLDER|REPLACE_WITH_)/;
        const placeholderHits: Array<{ file: string; line: number; text: string }> = [];
        for (const f of files) {
            const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
            const content = readFileSafeLocal(abs);
            if (!content) continue;
            content.split('\n').forEach((line, i) => {
                if (placeholderPattern.test(line)) placeholderHits.push({ file: abs, line: i + 1, text: line.trim().slice(0, 200) });
            });
        }
        gates.push({ id: 4, name: 'no_placeholders', pass: placeholderHits.length === 0, details: placeholderHits.length === 0 ? null : { hits: placeholderHits } });

        // Gate 5: no raw API usage (console.log / page.locator / @playwright/test imports)
        const rawPatterns = [/\bconsole\.log\s*\(/, /\bpage\.locator\s*\(/, /from\s+['"]@playwright\/test['"]/];
        const rawHits: Array<{ file: string; line: number; text: string }> = [];
        for (const f of files) {
            if (!/\.ts$/.test(f)) continue;
            const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
            const content = readFileSafeLocal(abs);
            if (!content) continue;
            content.split('\n').forEach((line, i) => {
                if (rawPatterns.some(p => p.test(line))) rawHits.push({ file: abs, line: i + 1, text: line.trim().slice(0, 200) });
            });
        }
        gates.push({ id: 5, name: 'no_raw_apis', pass: rawHits.length === 0, details: rawHits.length === 0 ? null : { hits: rawHits } });

        // Gate 6: SQL grounded — every SQL string in a helper/step/page must resolve to a named query
        const sqlHits: Array<{ file: string; line: number; text: string }> = [];
        if (dbQueriesEnv) {
            const envAbs = path.isAbsolute(dbQueriesEnv) ? dbQueriesEnv : path.resolve(cwd, dbQueriesEnv);
            const envContent = readFileSafeLocal(envAbs) ?? '';
            const knownQueries = new Set<string>();
            envContent.split('\n').forEach(line => {
                const m = line.match(/^\s*DB_QUERY_(\w+)=/);
                if (m) knownQueries.add(m[1]);
            });
            // Spot-check: each file's executeQuery(alias, 'NAME', …) name must be in knownQueries
            for (const f of files.filter(x => /\.ts$/.test(x))) {
                const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
                const content = readFileSafeLocal(abs);
                if (!content) continue;
                const re = /executeQuery\s*\(\s*[^,]+,\s*['"]([\w]+)['"]/g;
                let mm: RegExpExecArray | null;
                while ((mm = re.exec(content)) !== null) {
                    const name = mm[1];
                    if (!knownQueries.has(name)) {
                        const lineNo = content.substring(0, mm.index).split('\n').length;
                        sqlHits.push({ file: abs, line: lineNo, text: `executeQuery(..., '${name}', ...) — not registered in ${dbQueriesEnv}` });
                    }
                }
                // Catch inline SQL too
                if (/"\s*(SELECT|INSERT|UPDATE|DELETE)\s/i.test(content)) {
                    sqlHits.push({ file: abs, line: 0, text: 'Inline SQL present — use CSDBUtils named queries' });
                }
            }
        }
        gates.push({
            id: 6,
            name: 'sql_grounded',
            pass: sqlHits.length === 0,
            details: dbQueriesEnv ? (sqlHits.length === 0 ? null : { hits: sqlHits }) : { skipped: 'dbQueriesEnv not provided' },
        });

        // Gate 7: imports resolve — implicitly covered by compile (gate 1)
        gates.push({
            id: 7,
            name: 'imports_resolve',
            pass: compileClean,
            details: compileClean ? null : { inheritedFrom: 'compile gate' },
        });

        // Gate 8: data-JSON coverage — every scenarioId in feature files has a row in matching _scenarios.json
        const coverageIssues: Array<{ feature: string; scenarioId: string; dataFile: string; reason: string }> = [];
        if (featuresDir && dataDir) {
            const featAbs = path.isAbsolute(featuresDir) ? featuresDir : path.resolve(cwd, featuresDir);
            const dataAbs = path.isAbsolute(dataDir) ? dataDir : path.resolve(cwd, dataDir);
            const featureFiles = files.filter(f => /\.feature$/.test(f));
            for (const ff of featureFiles) {
                const absFF = path.isAbsolute(ff) ? ff : path.resolve(cwd, ff);
                const content = readFileSafeLocal(absFF) ?? '';
                // Extract Examples source + filter scenarioId=<id>
                const exampleRe = /Examples:\s*(\{[^}]+\})/g;
                let mm: RegExpExecArray | null;
                while ((mm = exampleRe.exec(content)) !== null) {
                    const raw = mm[1];
                    const sourceMatch = raw.match(/"source"\s*:\s*"([^"]+)"/);
                    const filterMatch = raw.match(/"filter"\s*:\s*"([^"]+)"/);
                    if (!sourceMatch || !filterMatch) continue;
                    const dataPath = path.isAbsolute(sourceMatch[1]) ? sourceMatch[1] : path.resolve(cwd, sourceMatch[1]);
                    const scenarioIdMatch = filterMatch[1].match(/scenarioId\s*=\s*([\w-]+)/);
                    if (!scenarioIdMatch) continue;
                    const scenarioId = scenarioIdMatch[1];
                    const dataContent = readFileSafeLocal(dataPath);
                    if (!dataContent) {
                        coverageIssues.push({ feature: absFF, scenarioId, dataFile: dataPath, reason: 'data file not found' });
                        continue;
                    }
                    try {
                        const rows = JSON.parse(dataContent) as Array<Record<string, unknown>>;
                        const hit = rows.find(r => r.scenarioId === scenarioId && (r.runFlag === undefined || r.runFlag === 'Yes'));
                        if (!hit) coverageIssues.push({ feature: absFF, scenarioId, dataFile: dataPath, reason: 'scenarioId row missing or runFlag=No' });
                    } catch {
                        coverageIssues.push({ feature: absFF, scenarioId, dataFile: dataPath, reason: 'data file not valid JSON' });
                    }
                }
            }
        }
        gates.push({
            id: 8,
            name: 'data_coverage',
            pass: coverageIssues.length === 0,
            details: featuresDir && dataDir ? (coverageIssues.length === 0 ? null : { issues: coverageIssues }) : { skipped: 'featuresDir/dataDir not provided' },
        });

        // Gate 9: no orphans — every provided file must exist on disk
        const missing = files.filter(f => {
            const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
            return !fs.existsSync(abs);
        });
        gates.push({ id: 9, name: 'no_orphans', pass: missing.length === 0, details: missing.length === 0 ? null : { missing } });

        const ready = gates.every(g => g.pass);
        return createJsonResult({
            ready,
            gates,
            summary: {
                totalGates: gates.length,
                passed: gates.filter(g => g.pass).length,
                failed: gates.filter(g => !g.pass).length,
            },
        });
    })
    .readOnly()
    .build();

function readFileSafeLocal(p: string): string | null {
    try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

// ============================================================================
// Export + registration
// ============================================================================

export const auditTools: MCPToolDefinition[] = [
    auditFileTool,
    auditContentTool,
    compileCheckTool,
    detectProjectTool,
    commitReadyCheckTool,
];

export function registerAuditTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(auditTools);
}
