/**
 * PTF-ADO MCP Pipeline Tools
 *
 * Deterministic tools that underpin the agentic migration pipeline:
 *   - state_write                Persist orchestrator session state
 *   - correction_memory_query    Look up prior verified fix patterns
 *   - correction_memory_record   Append a new verified fix pattern
 *   - schema_lookup              Verify a schema.table against project reference
 *   - locator_diff               Compare IR-suggested vs live-DOM locator
 *   - discover_dependencies      Recursively find references in a legacy source file
 *   - enumerate_test_suite       List legacy test files + @Test methods
 *   - classify_failure           Classify a test failure (LOW / MEDIUM / HIGH)
 *
 * All tools follow the deterministic contract — no LLM, reproducible output,
 * structured return.
 *
 * @module CSMCPPipelineTools
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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

function writeFileSafe(p: string, content: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
}

function agentRunsDir(cwd: string): string {
    return path.join(cwd, '.agent-runs');
}

// ============================================================================
// state_write — persist orchestrator session state
// ============================================================================

const stateWriteTool = defineTool()
    .name('state_write')
    .title('Write Session State')
    .description(
        'Persist orchestrator session state to .agent-runs/session-<runId>.json. ' +
        'Merges the provided patch object into the existing session file (shallow merge).'
    )
    .outputSchema({
        type: 'object',
        properties: {
            written: { type: 'boolean' },
            path: { type: 'string' },
        },
    })
    .category('audit')
    .stringParam('runId', 'Session run id', { required: true })
    .stringParam('patchJson', 'JSON object to merge into session state', { required: true })
    .stringParam('cwd', 'Workspace root (defaults to process.cwd())')
    .handler(async (params) => {
        const runId = params.runId as string;
        const cwd = (params.cwd as string | undefined) ?? process.cwd();
        let patch: Record<string, unknown>;
        try {
            patch = JSON.parse(params.patchJson as string);
        } catch (err: any) {
            return createErrorResult(`patchJson is not valid JSON: ${err.message}`);
        }

        const target = path.join(agentRunsDir(cwd), `session-${runId}.json`);
        let current: Record<string, unknown> = {};
        const existing = readFileSafe(target);
        if (existing) {
            try { current = JSON.parse(existing); } catch { /* start fresh */ }
        }
        const merged = { ...current, ...patch, _updatedAt: new Date().toISOString() };
        try {
            writeFileSafe(target, JSON.stringify(merged, null, 2));
            return createJsonResult({ written: true, path: target, keys: Object.keys(merged) });
        } catch (err: any) {
            return createErrorResult(`Failed to write session: ${err.message}`);
        }
    })
    .build();

// ============================================================================
// correction_memory_query — look up prior verified fixes by signature
// ============================================================================

interface CorrectionEntry {
    signature: string;
    hash: string;
    failureClass: 'LOW' | 'MEDIUM' | 'HIGH';
    rootCause: string;
    fixStrategy: string;
    verifiedGreen: boolean;
    recordedAt: string;
    examplePatch?: string;
}

function parseCorrectionMemory(content: string): CorrectionEntry[] {
    // Format: each entry is a ```jsonc block prefixed by "## Entry"
    const entries: CorrectionEntry[] = [];
    const re = /```json\s*\n([\s\S]*?)\n```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        try {
            const entry = JSON.parse(m[1]) as CorrectionEntry;
            if (entry && entry.signature && entry.hash) {
                entries.push(entry);
            }
        } catch { /* skip malformed entry */ }
    }
    return entries;
}

function hashSignature(signature: string): string {
    return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 16);
}

const correctionMemoryQueryTool = defineTool()
    .name('correction_memory_query')
    .title('Query Correction Memory')
    .description(
        'Search .agent-runs/correction-patterns.md for prior verified fix patterns ' +
        'matching the given failure signature. Returns ranked hits (exact match first, ' +
        'then substring matches).'
    )
    .outputSchema({
        type: 'object',
        properties: {
            exactHit: { type: 'object' },
            partialHits: { type: 'array', items: { type: 'object' } },
        },
    })
    .category('audit')
    .stringParam('signature', 'Failure signature to look up', { required: true })
    .stringParam('cwd', 'Workspace root (defaults to process.cwd())')
    .handler(async (params) => {
        const signature = params.signature as string;
        const cwd = (params.cwd as string | undefined) ?? process.cwd();
        const memoryPath = path.join(agentRunsDir(cwd), 'correction-patterns.md');
        const content = readFileSafe(memoryPath);
        if (!content) {
            return createJsonResult({ hits: [], exactHit: null, queried: memoryPath, empty: true });
        }

        const entries = parseCorrectionMemory(content);
        const hash = hashSignature(signature);

        const exact = entries.find(e => e.hash === hash || e.signature === signature);
        const partial = entries.filter(e =>
            e.signature.toLowerCase().includes(signature.toLowerCase()) ||
            signature.toLowerCase().includes(e.signature.toLowerCase())
        );

        return createJsonResult({
            queried: memoryPath,
            totalEntries: entries.length,
            exactHit: exact ?? null,
            hits: partial.slice(0, 5),
        });
    })
    .readOnly()
    .build();

// ============================================================================
// correction_memory_record — append a verified fix pattern
// ============================================================================

const correctionMemoryRecordTool = defineTool()
    .name('correction_memory_record')
    .title('Record Correction Memory')
    .description(
        'Append a verified fix pattern to .agent-runs/correction-patterns.md. ' +
        'Only call this after confirming the fix produced a green test run.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            recorded: { type: 'boolean' },
            hash: { type: 'string' },
        },
    })
    .category('audit')
    .stringParam('signature', 'Failure signature', { required: true })
    .stringParam('failureClass', 'Classification', { required: true, enum: ['LOW', 'MEDIUM', 'HIGH'] })
    .stringParam('rootCause', 'Human-readable root cause', { required: true })
    .stringParam('fixStrategy', 'Strategy applied that worked', { required: true })
    .booleanParam('verifiedGreen', 'Confirmed green after the fix', { required: true })
    .stringParam('examplePatch', 'Optional before/after snippet')
    .stringParam('cwd', 'Workspace root (defaults to process.cwd())')
    .handler(async (params) => {
        const entry: CorrectionEntry = {
            signature: params.signature as string,
            hash: hashSignature(params.signature as string),
            failureClass: params.failureClass as CorrectionEntry['failureClass'],
            rootCause: params.rootCause as string,
            fixStrategy: params.fixStrategy as string,
            verifiedGreen: params.verifiedGreen as boolean,
            recordedAt: new Date().toISOString(),
            examplePatch: params.examplePatch as string | undefined,
        };
        if (!entry.verifiedGreen) {
            return createErrorResult('Refusing to record a correction with verifiedGreen=false — only record after confirmed green run');
        }
        const cwd = (params.cwd as string | undefined) ?? process.cwd();
        const memoryPath = path.join(agentRunsDir(cwd), 'correction-patterns.md');

        let doc = readFileSafe(memoryPath) ?? '# Correction Patterns\n\nVerified fix patterns. Each entry is a JSON block with signature, hash, and metadata.\n\n';

        doc += `\n## ${entry.hash} — ${entry.failureClass}\n\n\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\`\n`;

        try {
            writeFileSafe(memoryPath, doc);
            return createJsonResult({ recorded: true, path: memoryPath, hash: entry.hash });
        } catch (err: any) {
            return createErrorResult(`Failed to write memory: ${err.message}`);
        }
    })
    .build();

// ============================================================================
// schema_lookup — verify schema.table against project reference
// ============================================================================

type SqlVerificationMode = 'strict' | 'best-effort' | 'off';

/**
 * Resolve the sql_verification mode in this priority order:
 *   1. The explicit `mode` param on the tool call (overrides everything)
 *   2. `sql_verification:` in `.agent-pipeline.yaml` at workspace root
 *   3. Default: 'strict'
 *
 * The config is read via flat regex — we don't need a full YAML parser for a
 * single scalar field, and pulling in js-yaml here would be overkill.
 */
function resolveSqlVerificationMode(cwd: string, explicit?: string): SqlVerificationMode {
    if (explicit === 'strict' || explicit === 'best-effort' || explicit === 'off') {
        return explicit;
    }
    try {
        const cfgPath = path.join(cwd, '.agent-pipeline.yaml');
        if (fs.existsSync(cfgPath)) {
            const raw = fs.readFileSync(cfgPath, 'utf-8');
            const m = raw.match(/^\s*sql_verification\s*:\s*["']?(strict|best-effort|off)["']?\s*$/m);
            if (m) return m[1] as SqlVerificationMode;
        }
    } catch { /* fall through */ }
    return 'strict';
}

interface SchemaRefTable { schema: string; table: string; columns: string[]; }

function parseSchemaReference(content: string): SchemaRefTable[] {
    // Simple format expected: markdown tables with "## <SCHEMA>.<TABLE>" headings
    // followed by column lists. Accept either markdown (### TABLE (SCHEMA))
    // or JSON blocks. We use a flexible regex-based parser so consumer projects
    // can structure their schema docs naturally.
    const tables: SchemaRefTable[] = [];

    // Pattern A: "### TABLE_NAME (SCHEMA)" or "## SCHEMA.TABLE"
    const headingRe = /^##+\s+([A-Z_][A-Z0-9_]*)\s*(?:\(([A-Z_][A-Z0-9_]*)\)|\.([A-Z_][A-Z0-9_]*))?/gm;
    const sections: Array<{ table: string; schema: string; start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(content)) !== null) {
        let schema = m[2] ?? '';
        let table = m[1];
        if (m[3]) { schema = m[1]; table = m[3]; }
        sections.push({ table, schema, start: m.index, end: content.length });
    }
    for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        if (i + 1 < sections.length) s.end = sections[i + 1].start;
        const section = content.substring(s.start, s.end);
        // Extract column names — words in first column of a markdown table body row
        const cols: string[] = [];
        const colRe = /^\|\s*([A-Z_][A-Z0-9_]*)\s*\|/gm;
        let cm: RegExpExecArray | null;
        while ((cm = colRe.exec(section)) !== null) {
            cols.push(cm[1]);
        }
        tables.push({ schema: s.schema, table: s.table, columns: cols });
    }
    return tables;
}

const schemaLookupTool = defineTool()
    .name('schema_lookup')
    .title('Schema Lookup')
    .description(
        'Verify a table against the project schema reference. Respects sql_verification mode (strict / best-effort / off). Returns schema + columns or skipped:true.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            found: { type: 'boolean' },
            skipped: { type: 'boolean' },
            mode: { type: 'string' },
            schema: { type: 'string' },
            table: { type: 'string' },
            columns: { type: 'array', items: { type: 'object' } },
        },
    })
    .category('audit')
    .stringParam('table', 'Table name to verify', { required: true })
    .stringParam('schema', 'Optional schema hint')
    .stringParam('referenceFile', 'Schema reference doc path (defaults to docs/<project>-db-schema.md)')
    .stringParam('mode', 'Verification mode', { enum: ['strict', 'best-effort', 'off'] })
    .stringParam('cwd', 'Workspace root')
    .handler(async (params) => {
        const table = (params.table as string).toUpperCase();
        const schemaHint = (params.schema as string | undefined)?.toUpperCase();
        const cwd = (params.cwd as string | undefined) ?? process.cwd();
        const refFile = (params.referenceFile as string | undefined);
        const mode = resolveSqlVerificationMode(cwd, params.mode as string | undefined);

        if (mode === 'off') {
            return createJsonResult({
                found: true,
                skipped: true,
                mode,
                table,
                schema: schemaHint ?? null,
                note: 'sql_verification: off — fabrication gate disabled; trusting SQL verbatim.',
            });
        }

        // Default: scan docs/*-db-schema.md or docs/<PROJECT>_DB_SCHEMA.md style names
        const candidates: string[] = [];
        if (refFile) candidates.push(path.resolve(cwd, refFile));
        const docsDir = path.join(cwd, 'docs');
        if (fs.existsSync(docsDir)) {
            try {
                const files = fs.readdirSync(docsDir)
                    .filter(f => /schema\.md$/i.test(f) || /db[_-]schema/i.test(f));
                for (const f of files) candidates.push(path.join(docsDir, f));
            } catch { /* ignore */ }
        }

        let content: string | null = null;
        let usedFile = '';
        for (const c of candidates) {
            const got = readFileSafe(c);
            if (got) { content = got; usedFile = c; break; }
        }
        if (!content) {
            if (mode === 'best-effort') {
                return createJsonResult({
                    found: false,
                    skipped: true,
                    mode,
                    table,
                    schema: schemaHint ?? null,
                    warning: 'Schema reference doc not found — emit SCHEMA REFERENCE NEEDED marker and proceed.',
                });
            }
            return createJsonResult({
                error: 'schema-reference-not-found',
                mode,
                candidatesTried: candidates,
                hint: 'Create docs/<project>-db-schema.md, pass referenceFile explicitly, or set sql_verification: best-effort / off.',
            });
        }

        const parsed = parseSchemaReference(content);
        const matches = parsed.filter(t =>
            t.table === table && (!schemaHint || t.schema === schemaHint)
        );
        if (matches.length === 0) {
            if (mode === 'best-effort') {
                return createJsonResult({
                    found: false,
                    skipped: true,
                    mode,
                    table,
                    schema: schemaHint ?? null,
                    searched: usedFile,
                    tablesInDoc: parsed.length,
                    warning: `Table '${table}' not in schema reference — emit SCHEMA REFERENCE NEEDED marker and proceed.`,
                });
            }
            return createJsonResult({
                error: 'not-found',
                mode,
                table,
                schema: schemaHint ?? null,
                searched: usedFile,
                tablesInDoc: parsed.length,
            });
        }
        if (matches.length > 1 && !schemaHint) {
            return createJsonResult({
                error: 'ambiguous',
                table,
                candidates: matches.map(m => ({ schema: m.schema, table: m.table })),
                hint: 'Pass schema to disambiguate',
            });
        }
        const hit = matches[0];
        return createJsonResult({
            found: true,
            skipped: false,
            mode,
            schema: hit.schema,
            table: hit.table,
            columns: hit.columns,
            source: usedFile,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// locator_diff — compare IR-suggested vs live-DOM locator
// ============================================================================

interface LocatorShape {
    locator_type?: string;
    value?: string;
    primary?: { locator_type: string; value: string; confidence?: number };
    alternatives?: string[];
}

const locatorDiffTool = defineTool()
    .name('locator_diff')
    .title('Locator Diff')
    .description(
        'Compare an IR-suggested locator with a live-DOM-ranked locator. ' +
        'Returns divergence fields + confidence delta + recommendation.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            drift: { type: 'boolean' },
            recommended: { type: 'object' },
            alternatives: { type: 'array', items: { type: 'string' } },
        },
    })
    .category('audit')
    .stringParam('irLocatorJson', 'IR locator object as JSON', { required: true })
    .stringParam('liveLocatorJson', 'Live-DOM locator object as JSON', { required: true })
    .handler(async (params) => {
        let irLoc: LocatorShape;
        let liveLoc: LocatorShape;
        try {
            irLoc = JSON.parse(params.irLocatorJson as string);
            liveLoc = JSON.parse(params.liveLocatorJson as string);
        } catch (err: any) {
            return createErrorResult(`Locator JSON parse error: ${err.message}`);
        }
        const irVal = irLoc.primary?.value ?? irLoc.value ?? '';
        const liveVal = liveLoc.primary?.value ?? liveLoc.value ?? '';
        const irType = irLoc.primary?.locator_type ?? irLoc.locator_type ?? '';
        const liveType = liveLoc.primary?.locator_type ?? liveLoc.locator_type ?? '';
        const match = irVal === liveVal && irType === liveType;
        return createJsonResult({
            match,
            divergence: match ? null : {
                primary_type: { ir: irType, live: liveType },
                primary_value: { ir: irVal, live: liveVal },
            },
            confidence: liveLoc.primary?.confidence ?? null,
            recommendation: match ? 'keep-ir' : 'prefer-live',
        });
    })
    .readOnly()
    .build();

// ============================================================================
// discover_dependencies — parse a legacy file + recursively walk references
// ============================================================================

interface DependencyRef {
    symbol: string;
    kind: 'import' | 'super-class' | 'field-type' | 'data-file' | 'named-query' | 'sql-string';
    expectedPath: string | null;
    found: boolean;
    resolvedPath: string | null;
}

/**
 * Walk projectRoot once and build a map from path-suffix → absolute path for
 * every source file. Lets us resolve imports like
 *   com.example.app.common.BaseTestCase
 * to any file on disk ending with
 *   .../com/example/app/common/BaseTestCase.java
 * regardless of whether the project follows Maven (src/test/java/…),
 * flat (src/…), or any other layout.
 *
 * Directories named node_modules, target, bin, obj, .git, dist, build are
 * pruned to keep the walk cheap on large repos.
 */
interface SourceIndex {
    // Map of suffix starting at first package segment → absolute path.
    // E.g. 'com/example/common/BaseTestCase.java' → '/abs/path/...'
    byPathSuffix: Map<string, string>;
    // Map of basename → all absolute paths (fallback when import is suffix-truncated).
    byBasename: Map<string, string[]>;
    // Map of fully-qualified class / namespace name → absolute path.
    // Derived from parsing the `package <...>;` or `namespace <...>;` declaration
    // inside each source file — ground truth regardless of where the file lives.
    // This makes flat-dumped folders work correctly even with duplicate basenames.
    byFqcn: Map<string, string>;
}

/**
 * Read the first ~40 lines of a source file and return its fully-qualified
 * class / namespace name (if discoverable), else null. Cheap: we bail as soon
 * as we see the package declaration. Multi-class-per-file uses the first one.
 */
function extractFqcnFromFile(absPath: string): string | null {
    try {
        const ext = path.extname(absPath);
        const buf = fs.readFileSync(absPath, { encoding: 'utf-8' }).slice(0, 4000);
        if (ext === '.java') {
            const pkgM = buf.match(/^\s*package\s+([\w.]+)\s*;/m);
            const clsM = buf.match(/(?:public\s+|abstract\s+|final\s+)*(?:class|interface|enum|record)\s+(\w+)/);
            if (pkgM && clsM) return `${pkgM[1]}.${clsM[1]}`;
            if (clsM) return clsM[1]; // default package
        } else if (ext === '.cs') {
            const nsM = buf.match(/^\s*namespace\s+([\w.]+)/m);
            const clsM = buf.match(/(?:public\s+|internal\s+|abstract\s+|sealed\s+|static\s+)*(?:class|interface|struct|enum|record)\s+(\w+)/);
            if (nsM && clsM) return `${nsM[1]}.${clsM[1]}`;
            if (clsM) return clsM[1];
        }
    } catch { /* swallow */ }
    return null;
}

const PRUNED_DIRS = new Set(['node_modules', 'target', 'bin', 'obj', '.git', 'dist', 'build', '.gradle', '.idea', '.vscode']);

function indexSourceFiles(root: string, extensions: string[]): SourceIndex {
    const idx: SourceIndex = { byPathSuffix: new Map(), byBasename: new Map(), byFqcn: new Map() };
    if (!fs.existsSync(root)) return idx;

    const isCodeExt = extensions.some(e => e === '.java' || e === '.cs');

    const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (!PRUNED_DIRS.has(e.name)) walk(path.join(dir, e.name));
                continue;
            }
            const ext = path.extname(e.name);
            if (!extensions.includes(ext)) continue;
            const abs = path.join(dir, e.name);
            const rel = path.relative(root, abs).replace(/\\/g, '/');

            // Index by basename
            const list = idx.byBasename.get(e.name) ?? [];
            list.push(abs);
            idx.byBasename.set(e.name, list);

            // Index by every suffix starting at a '/' boundary so that
            // 'com/x/y/Bar.java' matches whether the file lives at
            // 'src/com/x/y/Bar.java' or 'src/test/java/com/x/y/Bar.java'.
            let i = 0;
            while (i < rel.length) {
                idx.byPathSuffix.set(rel.substring(i), abs);
                const next = rel.indexOf('/', i);
                if (next < 0) break;
                i = next + 1;
            }

            // Index by fully-qualified name parsed from the `package`/`namespace`
            // declaration inside the file. This is ground truth and handles
            // flat-dumped folders (no directory hierarchy) correctly even when
            // multiple files share a basename.
            if (isCodeExt && (ext === '.java' || ext === '.cs')) {
                const fqcn = extractFqcnFromFile(abs);
                if (fqcn) idx.byFqcn.set(fqcn, abs);
            }
        }
    };
    walk(root);
    return idx;
}

function resolveJavaImport(imp: string, idx: SourceIndex): string | null {
    // 1. Authoritative: match against each file's own `package <...>;` declaration.
    if (idx.byFqcn.has(imp)) return idx.byFqcn.get(imp)!;
    // 2. Path-suffix lookup — works for any layout that mirrors the package structure.
    const suffix = imp.replace(/\./g, '/') + '.java';
    if (idx.byPathSuffix.has(suffix)) return idx.byPathSuffix.get(suffix)!;
    // 3. Fallback: unique basename match.
    const className = imp.split('.').pop() + '.java';
    const bases = idx.byBasename.get(className);
    if (bases && bases.length === 1) return bases[0];
    return null;
}

function resolveCsharpNamespace(ns: string, idx: SourceIndex): string | null {
    if (idx.byFqcn.has(ns)) return idx.byFqcn.get(ns)!;
    const suffix = ns.replace(/\./g, '/') + '.cs';
    if (idx.byPathSuffix.has(suffix)) return idx.byPathSuffix.get(suffix)!;
    const className = ns.split('.').pop() + '.cs';
    const bases = idx.byBasename.get(className);
    if (bases && bases.length === 1) return bases[0];
    return null;
}

function extractJavaReferences(content: string, projectRoot: string): DependencyRef[] {
    const refs: DependencyRef[] = [];
    const imports: string[] = [];
    const importRe = /^import\s+([a-zA-Z_][\w.]*\.[A-Z]\w*);/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) imports.push(m[1]);

    const srcIndex = indexSourceFiles(projectRoot, ['.java']);

    for (const imp of imports) {
        // Skip framework / standard-library imports
        if (/^(java|javax|org\.testng|org\.junit|org\.openqa|io\.cucumber|com\.google|org\.apache|org\.slf4j)\./.test(imp)) {
            continue;
        }
        const resolved = resolveJavaImport(imp, srcIndex);
        refs.push({
            symbol: imp,
            kind: 'import',
            expectedPath: imp.replace(/\./g, '/') + '.java',
            found: resolved !== null,
            resolvedPath: resolved,
        });
    }

    // Data-file string refs ("something.xlsx", "something.csv", etc.)
    const dataFileRe = /"([\w./\\-]+\.(xlsx|xls|csv|tsv|json|yaml|yml|xml|properties))"/g;
    const dataFiles = new Set<string>();
    while ((m = dataFileRe.exec(content)) !== null) dataFiles.add(m[1]);

    const dataIndex = indexSourceFiles(projectRoot, ['.xlsx', '.xls', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.properties']);

    for (const f of dataFiles) {
        const basename = path.basename(f);
        const suffix = f.replace(/\\/g, '/');
        let resolved: string | null = dataIndex.byPathSuffix.get(suffix) ?? null;
        if (!resolved) {
            const bases = dataIndex.byBasename.get(basename);
            if (bases && bases.length >= 1) resolved = bases[0];
        }
        refs.push({
            symbol: f,
            kind: 'data-file',
            expectedPath: f,
            found: resolved !== null,
            resolvedPath: resolved,
        });
    }

    return refs;
}

function extractCsharpReferences(content: string, projectRoot: string): DependencyRef[] {
    const refs: DependencyRef[] = [];
    const usingRe = /^using\s+([A-Z]\w*(?:\.[A-Z]\w*)*);/gm;
    let m: RegExpExecArray | null;
    const namespaces: string[] = [];
    while ((m = usingRe.exec(content)) !== null) {
        const ns = m[1];
        if (/^(System|Microsoft|NUnit|Moq|Xunit|FluentAssertions)\b/.test(ns)) continue;
        namespaces.push(ns);
    }

    const srcIndex = indexSourceFiles(projectRoot, ['.cs']);

    for (const ns of namespaces) {
        const resolved = resolveCsharpNamespace(ns, srcIndex);
        refs.push({
            symbol: ns,
            kind: 'import',
            expectedPath: ns.replace(/\./g, '/') + '.cs',
            found: resolved !== null,
            resolvedPath: resolved,
        });
    }
    return refs;
}

const discoverDependenciesTool = defineTool()
    .name('discover_dependencies')
    .title('Discover Dependencies')
    .description(
        'Parse a legacy Java/C# file and return referenced symbols/files/named-queries with found/missing flags. Used to halt migration on unresolved dependencies.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            complete: { type: 'boolean' },
            resolved: { type: 'array', items: { type: 'object' } },
            missing: { type: 'array', items: { type: 'object' } },
        },
    })
    .category('audit')
    .stringParam('file', 'Legacy source file to scan', { required: true })
    .stringParam('language', 'java | csharp (auto-detected by extension if omitted)')
    .stringParam('projectRoot', 'Project root for resolving imports', { required: true })
    .handler(async (params) => {
        const file = params.file as string;
        const lang = (params.language as string | undefined)
            ?? (file.endsWith('.cs') ? 'csharp' : file.endsWith('.java') ? 'java' : '');
        const projectRoot = params.projectRoot as string;

        const content = readFileSafe(file);
        if (content === null) return createErrorResult(`Cannot read ${file}`);

        let refs: DependencyRef[];
        if (lang === 'java') refs = extractJavaReferences(content, projectRoot);
        else if (lang === 'csharp') refs = extractCsharpReferences(content, projectRoot);
        else return createErrorResult(`Unsupported / undetected language: ${lang}`);

        const missing = refs.filter(r => !r.found);
        return createJsonResult({
            file,
            language: lang,
            total: refs.length,
            found: refs.length - missing.length,
            missing: missing.length,
            complete: missing.length === 0,
            references: refs,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// enumerate_test_suite — list legacy test files + @Test methods
// ============================================================================

interface TestSuiteEntry {
    file: string;
    language: string;
    testMethods: string[];
}

function findTestFiles(dir: string, language: 'java' | 'csharp' | 'any'): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const ext = language === 'java' ? '.java' : language === 'csharp' ? '.cs' : null;
    const walk = (d: string) => {
        try {
            const entries = fs.readdirSync(d, { withFileTypes: true });
            for (const e of entries) {
                const full = path.join(d, e.name);
                if (e.isDirectory()) {
                    walk(full);
                } else if (e.isFile()) {
                    if (ext && !full.endsWith(ext)) continue;
                    if (language === 'any' && !/\.(java|cs)$/.test(full)) continue;
                    if (/Test(s)?\.(java|cs)$/.test(full)) {
                        results.push(full);
                    }
                }
            }
        } catch { /* ignore unreadable dirs */ }
    };
    walk(dir);
    return results;
}

function extractTestMethods(content: string, language: 'java' | 'csharp'): string[] {
    const methods: string[] = [];
    const re = language === 'java'
        ? /@Test\b[^;{]*\n\s*(?:public|protected|private)?\s*\w+\s+(\w+)\s*\(/g
        : /\[Test\][^;{]*\n\s*(?:public|protected|private)?\s*\w+\s+(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) methods.push(m[1]);
    return methods;
}

const enumerateTestSuiteTool = defineTool()
    .name('enumerate_test_suite')
    .title('Enumerate Test Suite')
    .description(
        'List every legacy test file and its methods from a directory or TestNG suite XML. Used for user test selection.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            files: { type: 'array', items: { type: 'object' } },
        },
    })
    .category('audit')
    .stringParam('path', 'Directory or TestNG XML file path', { required: true })
    .stringParam('language', 'java | csharp | any', { required: false, enum: ['java', 'csharp', 'any'] })
    .handler(async (params) => {
        const inputPath = params.path as string;
        const lang = (params.language as 'java' | 'csharp' | 'any' | undefined) ?? 'any';

        if (!fs.existsSync(inputPath)) {
            return createErrorResult(`Path does not exist: ${inputPath}`);
        }

        const stat = fs.statSync(inputPath);
        if (stat.isFile() && /\.xml$/.test(inputPath)) {
            // Parse TestNG suite XML — extract <class name="..."/>
            const content = readFileSafe(inputPath) ?? '';
            const classes = Array.from(content.matchAll(/<class\s+name="([^"]+)"/g)).map(m => m[1]);
            return createJsonResult({
                source: inputPath,
                type: 'testng-suite',
                classCount: classes.length,
                classes,
            });
        }

        const files = findTestFiles(inputPath, lang);
        const entries: TestSuiteEntry[] = [];
        let totalMethods = 0;
        for (const f of files) {
            const content = readFileSafe(f) ?? '';
            const fLang: 'java' | 'csharp' = f.endsWith('.java') ? 'java' : 'csharp';
            const methods = extractTestMethods(content, fLang);
            entries.push({ file: f, language: fLang, testMethods: methods });
            totalMethods += methods.length;
        }

        return createJsonResult({
            source: inputPath,
            type: 'directory-scan',
            fileCount: entries.length,
            testMethodTotal: totalMethods,
            files: entries,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// classify_failure — classify a test failure as LOW / MEDIUM / HIGH
// ============================================================================

const classifyFailureTool = defineTool()
    .name('classify_failure')
    .title('Classify Test Failure')
    .description(
        'Classify a test failure by error text: LOW (auto-heal), MEDIUM (cautious heal), HIGH (escalate). Drives Healer retry vs escalate decision.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            class: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
            reason: { type: 'string' },
            autoHeal: { type: 'boolean' },
        },
    })
    .category('audit')
    .stringParam('errorMessage', 'The raw error / stack trace from the test run', { required: true })
    .stringParam('scenarioId', 'Scenario id for context')
    .handler(async (params) => {
        const err = (params.errorMessage as string).toLowerCase();

        // HIGH — env / regression / framework issues
        const highPatterns: Array<{ pattern: RegExp; reason: string }> = [
            { pattern: /401\s+unauthorized|authentication\s+(failed|expired)/i, reason: 'Authentication failure — test env credentials expired or wrong' },
            { pattern: /403\s+forbidden|access\s+denied/i, reason: 'Access denied — user role lacks permission' },
            { pattern: /500\s+internal\s+server\s+error/i, reason: 'Server 500 — application-side regression' },
            { pattern: /econnrefused|enotfound|connection\s+refused|connection\s+reset/i, reason: 'Network unreachable — VPN / DB / app endpoint down' },
            { pattern: /ora-|db.*error|database.*unavailable/i, reason: 'Database error — unreachable or invalid state' },
            { pattern: /framework\s+version\s+mismatch|incompatible\s+version/i, reason: 'Framework version mismatch' },
        ];
        for (const { pattern, reason } of highPatterns) {
            if (pattern.test(err)) {
                return createJsonResult({ class: 'HIGH', reason, autoHeal: false });
            }
        }

        // MEDIUM — structural fixes
        const mediumPatterns: Array<{ pattern: RegExp; reason: string }> = [
            { pattern: /step.*not.*found|undefined\s+step|missing\s+step\s+definition/i, reason: 'Missing step definition' },
            { pattern: /expected.*but\s+(received|was|got).*different\s+(shape|structure)/i, reason: 'Data shape mismatch' },
            { pattern: /wrong.*assertion|unexpected\s+assertion\s+type/i, reason: 'Wrong assertion verb' },
        ];
        for (const { pattern, reason } of mediumPatterns) {
            if (pattern.test(err)) {
                return createJsonResult({ class: 'MEDIUM', reason, autoHeal: true });
            }
        }

        // LOW — default for locator / timing / typos
        const lowPatterns: Array<{ pattern: RegExp; reason: string }> = [
            { pattern: /locator.*did not match|element.*not\s+found|timeout.*waiting\s+for\s+selector/i, reason: 'Locator drift — element not found' },
            { pattern: /timeout.*exceeded|page\.waitfor/i, reason: 'Timing flake — needs wait adjustment' },
            { pattern: /expected.*text.*but\s+got|expected.*to\s+equal/i, reason: 'Visible-text mismatch' },
            { pattern: /cannot\s+find\s+module|typeerror|referenceerror/i, reason: 'Import or reference error' },
        ];
        for (const { pattern, reason } of lowPatterns) {
            if (pattern.test(err)) {
                return createJsonResult({ class: 'LOW', reason, autoHeal: true });
            }
        }

        return createJsonResult({
            class: 'LOW',
            reason: 'Unclassified failure — default to LOW, LLM should inspect',
            autoHeal: true,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// emit_provenance_header — standard provenance block for any generated file
// ============================================================================

const emitProvenanceHeaderTool = defineTool()
    .name('emit_provenance_header')
    .title('Emit Provenance Header')
    .description(
        'Return the standard provenance comment block for a generated file. ' +
        'Every LLM-assisted file should start with this header so reviewers see ' +
        'what the source was, when the pipeline ran, and that human review is required.'
    )
    .outputSchema({
        type: 'object',
        properties: { header: { type: 'string' } },
    })
    .category('audit')
    .stringParam('sourcePath', 'Legacy source file path', { required: true })
    .stringParam('sourceHash', 'sha256 of source file (optional)')
    .stringParam('projectName', 'Project name', { required: true })
    .stringParam('pipelineVersion', 'cs-playwright-mcp version', { required: true })
    .stringParam('correctionPatterns', 'JSON array of patterns applied (optional)')
    .stringParam('commentStyle', 'Comment style', { enum: ['double-slash', 'hash', 'gherkin'] })
    .handler(async (params) => {
        const style = (params.commentStyle as string | undefined) ?? 'double-slash';
        const prefix = style === 'hash' ? '# ' : style === 'gherkin' ? '# ' : '// ';
        const ts = new Date().toISOString();
        const patterns = params.correctionPatterns
            ? ` (${(JSON.parse(params.correctionPatterns as string) as unknown[]).length} pattern(s))`
            : '';
        const lines = [
            `${prefix}@generated cs-playwright-mcp v${params.pipelineVersion}`,
            `${prefix}@source-legacy ${params.sourcePath}${params.sourceHash ? ` (sha256: ${params.sourceHash})` : ''}`,
            `${prefix}@project ${params.projectName}`,
            `${prefix}@migration-run ${ts}`,
            `${prefix}@correction-patterns applied${patterns}`,
            `${prefix}@review-status AI-assisted — human review required before merge`,
        ];
        return createJsonResult({ header: lines.join('\n') + '\n' });
    })
    .readOnly()
    .build();

// ============================================================================
// record_skipped_gap — append to dropped-scenarios report
// ============================================================================

const recordSkippedGapTool = defineTool()
    .name('record_skipped_gap')
    .title('Record Skipped Gap')
    .description(
        'Append one row to .agent-runs/dropped-<runId>.md under the "Skipped during migration" section. ' +
        'Called by subagents when the user picks option 3 (skip) on an interactive clarification.'
    )
    .outputSchema({
        type: 'object',
        properties: { recorded: { type: 'boolean' }, path: { type: 'string' } },
    })
    .category('audit')
    .stringParam('runId', 'Session run id', { required: true })
    .stringParam('stage', 'Pipeline stage where gap arose', { required: true })
    .stringParam('gap', 'One-line description of what was missing', { required: true })
    .stringParam('userChoice', 'User choice', { enum: ['provide', 'suggest', 'skip', 'abort'], required: true })
    .stringParam('impact', 'What this means downstream if unresolved', { required: true })
    .stringParam('cwd', 'Workspace root')
    .handler(async (params) => {
        const runId = params.runId as string;
        const cwd = (params.cwd as string | undefined) ?? process.cwd();
        const target = path.join(agentRunsDir(cwd), `dropped-${runId}.md`);

        let content = readFileSafe(target);
        if (!content) {
            content = `# Dropped / skipped during migration — run ${runId}\n\n## Skipped during migration\n\n| Stage | Gap | User choice | Impact if unresolved |\n|---|---|---|---|\n`;
        }

        const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        const row = `| ${escape(params.stage as string)} | ${escape(params.gap as string)} | ${params.userChoice} | ${escape(params.impact as string)} |\n`;
        content += row;

        try {
            writeFileSafe(target, content);
            return createJsonResult({ recorded: true, path: target });
        } catch (err: any) {
            return createErrorResult(`Failed to write dropped report: ${err.message}`);
        }
    })
    .build();

// ============================================================================
// migration_cache_lookup / migration_cache_store — input-hash idempotence
// ============================================================================

function buildCacheKey(input: { sourceContent: string; projectName: string; pipelineVersion: string; extras?: string }): string {
    const canonical = JSON.stringify({
        source: input.sourceContent,
        project: input.projectName,
        pipelineVer: input.pipelineVersion,
        extras: input.extras ?? '',
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

const migrationCacheLookupTool = defineTool()
    .name('migration_cache_lookup')
    .title('Migration Cache Lookup')
    .description(
        'Check whether a prior migration run produced output for the same input. ' +
        'Key = sha256(sourceContent + projectName + pipelineVersion + extras). ' +
        'Returns cached file map if hit, or { hit: false } if miss. ' +
        'Enables idempotent re-runs: same input produces bit-identical output.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            hit: { type: 'boolean' },
            cacheKey: { type: 'string' },
            files: { type: 'object' },
            cachedAt: { type: 'string' },
        },
    })
    .category('audit')
    .stringParam('sourceFile', 'Absolute path to source file', { required: true })
    .stringParam('projectName', 'Project name', { required: true })
    .stringParam('pipelineVersion', 'Pipeline version', { required: true })
    .stringParam('extras', 'Extra key material (e.g., config hash)')
    .stringParam('cwd', 'Workspace root')
    .handler(async (params) => {
        const cwd = (params.cwd as string | undefined) ?? process.cwd();
        const sourcePath = params.sourceFile as string;
        const sourceContent = readFileSafe(sourcePath);
        if (sourceContent === null) return createErrorResult(`Cannot read source: ${sourcePath}`);

        const key = buildCacheKey({
            sourceContent,
            projectName: params.projectName as string,
            pipelineVersion: params.pipelineVersion as string,
            extras: params.extras as string | undefined,
        });

        const cacheDir = path.join(agentRunsDir(cwd), 'cache', key);
        const metaPath = path.join(cacheDir, 'meta.json');
        const meta = readFileSafe(metaPath);
        if (!meta) {
            return createJsonResult({ hit: false, cacheKey: key });
        }

        let metaParsed: { cachedAt: string; files: string[] };
        try { metaParsed = JSON.parse(meta); } catch {
            return createJsonResult({ hit: false, cacheKey: key });
        }

        const files: Record<string, string> = {};
        for (const rel of metaParsed.files) {
            const p = path.join(cacheDir, 'files', rel);
            const c = readFileSafe(p);
            if (c !== null) files[rel] = c;
        }
        return createJsonResult({ hit: true, cacheKey: key, files, cachedAt: metaParsed.cachedAt });
    })
    .readOnly()
    .build();

const migrationCacheStoreTool = defineTool()
    .name('migration_cache_store')
    .title('Migration Cache Store')
    .description(
        'Store the output of a successful migration under the input-hash key for future idempotent replays. ' +
        'Call this only after Stage 6 (commit-ready gate) passes.'
    )
    .outputSchema({
        type: 'object',
        properties: { stored: { type: 'boolean' }, cacheKey: { type: 'string' }, path: { type: 'string' } },
    })
    .category('audit')
    .stringParam('cacheKey', 'The key returned by migration_cache_lookup', { required: true })
    .stringParam('filesJson', 'JSON object { relPath: content } of files to cache', { required: true })
    .stringParam('cwd', 'Workspace root')
    .handler(async (params) => {
        const cwd = (params.cwd as string | undefined) ?? process.cwd();
        const key = params.cacheKey as string;
        let files: Record<string, string>;
        try {
            files = JSON.parse(params.filesJson as string);
        } catch (err: any) {
            return createErrorResult(`filesJson invalid: ${err.message}`);
        }

        const cacheDir = path.join(agentRunsDir(cwd), 'cache', key);
        try {
            for (const [rel, content] of Object.entries(files)) {
                writeFileSafe(path.join(cacheDir, 'files', rel), content);
            }
            const meta = {
                cachedAt: new Date().toISOString(),
                files: Object.keys(files),
            };
            writeFileSafe(path.join(cacheDir, 'meta.json'), JSON.stringify(meta, null, 2));
            return createJsonResult({ stored: true, cacheKey: key, path: cacheDir });
        } catch (err: any) {
            return createErrorResult(`Failed to write cache: ${err.message}`);
        }
    })
    .build();

// ============================================================================
// Export + registration
// ============================================================================

export const pipelineTools: MCPToolDefinition[] = [
    stateWriteTool,
    correctionMemoryQueryTool,
    correctionMemoryRecordTool,
    schemaLookupTool,
    locatorDiffTool,
    discoverDependenciesTool,
    enumerateTestSuiteTool,
    classifyFailureTool,
    emitProvenanceHeaderTool,
    recordSkippedGapTool,
    migrationCacheLookupTool,
    migrationCacheStoreTool,
];

export function registerPipelineTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(pipelineTools);
}
