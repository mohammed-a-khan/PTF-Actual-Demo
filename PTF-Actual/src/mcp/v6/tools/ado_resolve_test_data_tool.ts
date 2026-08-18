/**
 * cs_qa_resolve_test_data — for each fieldNeeded, produce a validated value
 * whose origin is auditable. Never invented; every value comes from a real
 * source and every source is stamped in the output.
 *
 * Precedence per field:
 *   1. User-provided (providedData[fieldName]) — validate; use if valid.
 *   2. Fixture files under fixtureRoots — parse .json/.csv/.yaml (xlsx
 *      parsed via `xlsx` package when installed; skipped with a warning
 *      otherwise).
 *   3. DB query — invoke cs_qa_db_select with a SELECT DISTINCT on the
 *      mapped column, filter results against constraints.
 *   4. Synthetic — respect constraints (minLength, maxLength, pattern,
 *      enumValues, min/max). Deterministic when syntheticSeed is set.
 *   5. Ask user via ctx.elicit — only when allowAskUser:true.
 *
 * Also generates a matching INVALID sample per field (for negative-path
 * scenarios) that violates one of the field's constraints.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive, getPrimitive, type PrimitiveContext } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';

// ---------------------------------------------------------------------------
// Schema.
// ---------------------------------------------------------------------------

const FieldTypeSchema = z.enum(['string', 'integer', 'decimal', 'date', 'boolean', 'enum', 'email', 'phone']);

const ConstraintSchema = z.object({
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().positive().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional().describe('Regex pattern the value must match.'),
    enumValues: z.array(z.string()).optional(),
    required: z.boolean().default(true),
});

const DbColumnSchema = z.object({
    tableName: z.string().min(1),
    columnName: z.string().min(1),
    alias: z.string().min(1),
    whereClause: z.string().optional().describe('Optional additional WHERE clause (e.g. "STATUS = \'ACTIVE\'"). Concatenated with the NOT NULL filter.'),
});

const FixtureHintSchema = z.object({
    entity: z.string().min(1).describe('Top-level entity name (e.g. "Employee", "Order").'),
    field: z.string().min(1).describe('Property/column on the entity that maps to the fieldName.'),
});

const FieldNeededSchema = z.object({
    fieldName: z.string().min(1),
    expectedType: FieldTypeSchema,
    constraints: ConstraintSchema.optional(),
    dbColumn: DbColumnSchema.optional(),
    fixtureHint: FixtureHintSchema.optional(),
    description: z.string().optional(),
});

const InputSchema = z.object({
    fieldsNeeded: z.array(FieldNeededSchema).min(1),
    providedData: z.record(z.string(), z.unknown()).optional(),
    fixtureRoots: z.array(z.string()).default(['test/data']),
    allowDbQuery: z.boolean().default(true),
    allowAskUser: z.boolean().default(false),
    syntheticSeed: z.number().int().optional(),
    generateInvalidSamples: z.boolean().default(true),
    dbAliasFallback: z.string().optional().describe('DB alias to use when a field\'s dbColumn.alias is not defined in the workspace env.'),
});

const ResolvedFieldSchema = z.object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    source: z.enum(['user', 'fixture', 'db', 'generator', 'asked']),
    why: z.string(),
    alsoInvalidSample: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    invalidReason: z.string().optional(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    resolvedData: z.record(z.string(), ResolvedFieldSchema),
    unresolved: z.array(z.object({ fieldName: z.string(), reason: z.string() })),
    warnings: z.array(z.string()),
    sourceBreakdown: z.record(z.string(), z.number()),
    note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;
type FieldNeeded = z.infer<typeof FieldNeededSchema>;
type Constraint = z.infer<typeof ConstraintSchema>;
type ResolvedField = z.infer<typeof ResolvedFieldSchema>;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so syntheticSeed produces reproducible values.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// Constraint validation.
// ---------------------------------------------------------------------------

function coerceValue(value: unknown, type: FieldNeeded['expectedType']): { ok: boolean; value?: string | number | boolean; reason?: string } {
    if (value === null || value === undefined) return { ok: false, reason: 'null/undefined' };
    switch (type) {
        case 'string':
        case 'email':
        case 'phone':
        case 'enum':
        case 'date':
            return { ok: true, value: String(value) };
        case 'integer': {
            const n = Number(value);
            if (!Number.isFinite(n) || Math.trunc(n) !== n) return { ok: false, reason: `not-an-integer (got ${value})` };
            return { ok: true, value: n };
        }
        case 'decimal': {
            const n = Number(value);
            if (!Number.isFinite(n)) return { ok: false, reason: `not-a-number (got ${value})` };
            return { ok: true, value: n };
        }
        case 'boolean': {
            if (typeof value === 'boolean') return { ok: true, value };
            const s = String(value).toLowerCase().trim();
            if (['true', '1', 'yes', 'y'].includes(s)) return { ok: true, value: true };
            if (['false', '0', 'no', 'n'].includes(s)) return { ok: true, value: false };
            return { ok: false, reason: `not-a-boolean (got ${value})` };
        }
        default:
            return { ok: true, value: String(value) };
    }
}

function validateAgainstConstraints(value: string | number | boolean, type: FieldNeeded['expectedType'], c: Constraint | undefined): { ok: boolean; reason?: string } {
    if (!c) return { ok: true };
    if (c.required && (value === '' || value === null || value === undefined)) return { ok: false, reason: 'required-empty' };
    if (typeof value === 'string') {
        if (c.minLength !== undefined && value.length < c.minLength) return { ok: false, reason: `length ${value.length} < minLength ${c.minLength}` };
        if (c.maxLength !== undefined && value.length > c.maxLength) return { ok: false, reason: `length ${value.length} > maxLength ${c.maxLength}` };
        if (c.pattern) {
            try {
                if (!new RegExp(c.pattern).test(value)) return { ok: false, reason: `does not match pattern ${c.pattern}` };
            } catch {
                return { ok: false, reason: `invalid pattern regex ${c.pattern}` };
            }
        }
        if (c.enumValues && c.enumValues.length > 0 && !c.enumValues.includes(value)) return { ok: false, reason: `not in enum {${c.enumValues.join(',')}}` };
        // Email / phone shape sanity when type says so.
        if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { ok: false, reason: 'not-email-shape' };
        if (type === 'phone' && !/^[+0-9()\s-]{7,}$/.test(value)) return { ok: false, reason: 'not-phone-shape' };
    }
    if (typeof value === 'number') {
        if (c.min !== undefined && value < c.min) return { ok: false, reason: `value ${value} < min ${c.min}` };
        if (c.max !== undefined && value > c.max) return { ok: false, reason: `value ${value} > max ${c.max}` };
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Fixture file discovery + parsing.
// ---------------------------------------------------------------------------

function findFixtureFiles(workspaceRoot: string, roots: string[]): string[] {
    const out: string[] = [];
    for (const r of roots) {
        const abs = path.isAbsolute(r) ? r : path.resolve(workspaceRoot, r);
        if (!fs.existsSync(abs)) continue;
        walkFixtures(abs, out);
    }
    return out;
}

function walkFixtures(dir: string, out: string[]): void {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e);
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) walkFixtures(full, out);
        else if (stat.isFile() && /\.(json|csv|ya?ml|xlsx)$/i.test(e)) out.push(full);
    }
}

function parseFixtureFile(file: string, warnings: string[]): { rows: Array<Record<string, unknown>>; entity: string } | null {
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file, ext);
    const entityFromFile = base.replace(/[^a-z0-9]/gi, '');
    try {
        if (ext === '.json') {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (Array.isArray(parsed)) return { rows: parsed as Array<Record<string, unknown>>, entity: entityFromFile };
            if (parsed && typeof parsed === 'object') {
                // { Employee: [...] } shape.
                for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                    if (Array.isArray(v)) return { rows: v as Array<Record<string, unknown>>, entity: k };
                }
                return { rows: [parsed as Record<string, unknown>], entity: entityFromFile };
            }
            return null;
        }
        if (ext === '.csv') {
            const raw = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter((l) => l.length > 0);
            if (raw.length < 2) return null;
            const headers = raw[0].split(',').map((h) => h.trim());
            const rows: Array<Record<string, unknown>> = [];
            for (let i = 1; i < raw.length; i++) {
                const cells = parseCsvLine(raw[i]);
                const row: Record<string, unknown> = {};
                for (let c = 0; c < headers.length; c++) row[headers[c]] = cells[c] ?? '';
                rows.push(row);
            }
            return { rows, entity: entityFromFile };
        }
        if (ext === '.yaml' || ext === '.yml') {
            // Minimal YAML: key: value pairs OR a top-level list. If yaml pkg
            // is installed, use it; else use a naive line-based parser.
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const yaml = require('js-yaml') as { load(s: string): unknown };
                const parsed = yaml.load(fs.readFileSync(file, 'utf-8'));
                if (Array.isArray(parsed)) return { rows: parsed as Array<Record<string, unknown>>, entity: entityFromFile };
                if (parsed && typeof parsed === 'object') {
                    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                        if (Array.isArray(v)) return { rows: v as Array<Record<string, unknown>>, entity: k };
                    }
                    return { rows: [parsed as Record<string, unknown>], entity: entityFromFile };
                }
                return null;
            } catch {
                warnings.push(`js-yaml not installed — skipping ${file}. Install js-yaml for YAML fixtures.`);
                return null;
            }
        }
        if (ext === '.xlsx') {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const XLSX = require('xlsx') as { readFile(p: string): { SheetNames: string[]; Sheets: Record<string, unknown> }; utils: { sheet_to_json(ws: unknown): Array<Record<string, unknown>> } };
                const wb = XLSX.readFile(file);
                if (wb.SheetNames.length === 0) return null;
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
                return { rows, entity: wb.SheetNames[0] };
            } catch {
                warnings.push(`xlsx not installed — skipping ${file}. Install xlsx for Excel fixtures.`);
                return null;
            }
        }
    } catch (e) {
        warnings.push(`fixture parse failed ${file}: ${(e as Error).message}`);
    }
    return null;
}

function parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && !inQuote) { inQuote = true; continue; }
        if (ch === '"' && inQuote) {
            if (line[i + 1] === '"') { cur += '"'; i++; continue; }
            inQuote = false; continue;
        }
        if (ch === ',' && !inQuote) { cells.push(cur); cur = ''; continue; }
        cur += ch;
    }
    cells.push(cur);
    return cells;
}

// ---------------------------------------------------------------------------
// Resolvers.
// ---------------------------------------------------------------------------

function tryUserProvided(field: FieldNeeded, providedData: Record<string, unknown> | undefined, warnings: string[]): ResolvedField | null {
    if (!providedData || !(field.fieldName in providedData)) return null;
    const raw = providedData[field.fieldName];
    const coerced = coerceValue(raw, field.expectedType);
    if (!coerced.ok) {
        warnings.push(`providedData[${field.fieldName}] failed type coercion: ${coerced.reason}. Falling through.`);
        return null;
    }
    const check = validateAgainstConstraints(coerced.value!, field.expectedType, field.constraints);
    if (!check.ok) {
        warnings.push(`providedData[${field.fieldName}] failed constraint: ${check.reason}. Falling through.`);
        return null;
    }
    return { value: coerced.value ?? null, source: 'user', why: 'accepted from providedData' };
}

function tryFixture(field: FieldNeeded, fixtures: Array<{ file: string; rows: Array<Record<string, unknown>>; entity: string }>, warnings: string[]): ResolvedField | null {
    if (!field.fixtureHint) return null;
    const wantedEntity = field.fixtureHint.entity.toLowerCase();
    const wantedField = field.fixtureHint.field;
    for (const fx of fixtures) {
        if (fx.entity.toLowerCase() !== wantedEntity) continue;
        for (const row of fx.rows) {
            if (row[wantedField] === undefined) continue;
            const coerced = coerceValue(row[wantedField], field.expectedType);
            if (!coerced.ok) continue;
            const check = validateAgainstConstraints(coerced.value!, field.expectedType, field.constraints);
            if (!check.ok) continue;
            return {
                value: coerced.value ?? null,
                source: 'fixture',
                why: `matched fixture ${path.basename(fx.file)}::${fx.entity}.${wantedField}`,
            };
        }
    }
    // Also fall back to a case-insensitive property match by fieldName if entity name matched but wantedField didn't hit.
    for (const fx of fixtures) {
        if (fx.entity.toLowerCase() !== wantedEntity) continue;
        for (const row of fx.rows) {
            for (const [k, v] of Object.entries(row)) {
                if (k.toLowerCase() === field.fieldName.toLowerCase()) {
                    const coerced = coerceValue(v, field.expectedType);
                    if (!coerced.ok) continue;
                    const check = validateAgainstConstraints(coerced.value!, field.expectedType, field.constraints);
                    if (!check.ok) continue;
                    return {
                        value: coerced.value ?? null,
                        source: 'fixture',
                        why: `matched fixture ${path.basename(fx.file)}::${fx.entity}.${k} (case-insensitive)`,
                    };
                }
            }
        }
    }
    void warnings;
    return null;
}

async function tryDbQuery(field: FieldNeeded, ctx: PrimitiveContext, allowDb: boolean, aliasFallback: string | undefined, warnings: string[]): Promise<ResolvedField | null> {
    if (!allowDb || !field.dbColumn) return null;
    const dbTool = getPrimitive('cs_qa_db_select');
    if (!dbTool) {
        warnings.push('cs_qa_db_select not registered — DB fallback skipped');
        return null;
    }
    const alias = field.dbColumn.alias || aliasFallback;
    if (!alias) {
        warnings.push(`no db alias for ${field.fieldName} — DB fallback skipped`);
        return null;
    }
    const table = field.dbColumn.tableName;
    const column = field.dbColumn.columnName;
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
        warnings.push(`unsafe table/column identifier — DB fallback skipped for ${field.fieldName}`);
        return null;
    }
    const where = field.dbColumn.whereClause ? ` AND (${field.dbColumn.whereClause})` : '';
    const sql = `SELECT DISTINCT ${column} FROM ${table} WHERE ${column} IS NOT NULL${where}`;
    try {
        const result = await dbTool.run(ctx, { alias, sql, params: [], rowCap: 25 }) as { rows: Array<Record<string, unknown>>; rowsReturned: number; note?: string };
        if (result.note) warnings.push(`db_select note: ${result.note}`);
        if (!result.rows || result.rows.length === 0) return null;
        for (const row of result.rows) {
            const raw = row[column] ?? row[column.toLowerCase()] ?? row[column.toUpperCase()] ?? Object.values(row)[0];
            const coerced = coerceValue(raw, field.expectedType);
            if (!coerced.ok) continue;
            const check = validateAgainstConstraints(coerced.value!, field.expectedType, field.constraints);
            if (!check.ok) continue;
            return {
                value: coerced.value ?? null,
                source: 'db',
                why: `DB SELECT DISTINCT ${column} FROM ${table} (alias=${alias}) returned ${result.rows.length} row(s); first valid pick`,
            };
        }
    } catch (e) {
        warnings.push(`db_select failed for ${field.fieldName}: ${(e as Error).message}`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Synthetic generation.
// ---------------------------------------------------------------------------

function generateSynthetic(field: FieldNeeded, rand: () => number): ResolvedField {
    const c = field.constraints;
    let value: string | number | boolean;
    let why: string;
    switch (field.expectedType) {
        case 'string': {
            const min = c?.minLength ?? 3;
            const max = Math.min(c?.maxLength ?? 20, 60);
            const target = Math.max(min, Math.min(max, Math.floor(rand() * (max - min + 1)) + min));
            if (c?.enumValues && c.enumValues.length > 0) {
                value = c.enumValues[Math.floor(rand() * c.enumValues.length)];
            } else if (c?.pattern) {
                value = generateFromPattern(c.pattern, target, rand) || makeRandomString(target, rand);
            } else {
                value = makeRandomString(target, rand);
            }
            why = `synthetic string len=${(value as string).length} (min=${min}, max=${max})`;
            break;
        }
        case 'email': {
            const localLen = Math.max(3, Math.min(10, c?.maxLength ? Math.floor(c.maxLength / 2) : 8));
            value = `${makeRandomString(localLen, rand).toLowerCase()}@example.com`;
            why = 'synthetic email';
            break;
        }
        case 'phone': {
            const digits = Array.from({ length: 10 }, () => Math.floor(rand() * 10)).join('');
            value = `+1${digits}`;
            why = 'synthetic phone (E.164)';
            break;
        }
        case 'integer': {
            const min = c?.min !== undefined ? Math.ceil(c.min) : 1;
            const max = c?.max !== undefined ? Math.floor(c.max) : 9999;
            value = Math.floor(rand() * (max - min + 1)) + min;
            why = `synthetic integer in [${min},${max}]`;
            break;
        }
        case 'decimal': {
            const min = c?.min ?? 0;
            const max = c?.max ?? 1000;
            value = Number((min + rand() * (max - min)).toFixed(2));
            why = `synthetic decimal in [${min},${max}]`;
            break;
        }
        case 'boolean': {
            value = rand() < 0.5;
            why = 'synthetic boolean';
            break;
        }
        case 'date': {
            const now = new Date();
            const off = Math.floor(rand() * 365);
            const d = new Date(now.getTime() - off * 86400_000);
            value = d.toISOString().slice(0, 10);
            why = 'synthetic date (last 365 days)';
            break;
        }
        case 'enum': {
            if (c?.enumValues && c.enumValues.length > 0) {
                value = c.enumValues[Math.floor(rand() * c.enumValues.length)];
                why = `enum pick from ${c.enumValues.length} option(s)`;
            } else {
                value = 'OPTION_A';
                why = 'enum default (no enumValues supplied)';
            }
            break;
        }
        default:
            value = 'value';
            why = 'default synthetic';
    }
    return { value, source: 'generator', why };
}

function makeRandomString(length: number, rand: () => number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet.charAt(Math.floor(rand() * alphabet.length));
    return out;
}

function generateFromPattern(pattern: string, target: number, rand: () => number): string | null {
    // Handle the very common cases (\d+, \w+, [A-Z]{n,m}) so the generated
    // value passes the pattern check. Everything else falls back to a
    // random string; the caller re-validates and drops if it fails.
    try {
        if (/^\\d\{(\d+),(\d+)\}$/.test(pattern)) {
            const m = /^\\d\{(\d+),(\d+)\}$/.exec(pattern)!;
            const len = Math.max(Number(m[1]), Math.min(Number(m[2]), target));
            return Array.from({ length: len }, () => Math.floor(rand() * 10)).join('');
        }
        if (pattern === '\\d+') return Array.from({ length: target }, () => Math.floor(rand() * 10)).join('');
        if (pattern === '[A-Z]+') return makeRandomString(target, rand).toUpperCase();
        if (pattern === '[a-z]+') return makeRandomString(target, rand).toLowerCase();
    } catch { /* ignore */ }
    return null;
}

function generateInvalid(field: FieldNeeded, rand: () => number): { value: string | number | boolean | null; reason: string } {
    const c = field.constraints;
    switch (field.expectedType) {
        case 'string':
        case 'email':
        case 'phone':
            if (c?.minLength && c.minLength > 0) return { value: makeRandomString(Math.max(0, c.minLength - 1), rand), reason: `length < minLength ${c.minLength}` };
            if (c?.maxLength) return { value: makeRandomString(c.maxLength + 5, rand), reason: `length > maxLength ${c.maxLength}` };
            if (c?.enumValues && c.enumValues.length > 0) return { value: '__NOT_IN_ENUM__', reason: `not in enum {${c.enumValues.join(',')}}` };
            if (field.expectedType === 'email') return { value: 'not-an-email', reason: 'invalid email shape' };
            if (field.expectedType === 'phone') return { value: 'ABC', reason: 'invalid phone shape' };
            return { value: '', reason: 'empty string' };
        case 'integer':
        case 'decimal':
            if (c?.max !== undefined) return { value: c.max + 1, reason: `> max ${c.max}` };
            if (c?.min !== undefined) return { value: c.min - 1, reason: `< min ${c.min}` };
            return { value: 'not-a-number', reason: 'non-numeric' };
        case 'boolean':
            return { value: 'not-a-bool', reason: 'non-boolean' };
        case 'date':
            return { value: '2026-13-45', reason: 'invalid date' };
        case 'enum':
            return { value: '__NOT_IN_ENUM__', reason: 'value not in enum' };
        default:
            return { value: null, reason: 'null' };
    }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

registerPrimitive<Input, Output>({
    name: 'cs_qa_resolve_test_data',
    description: 'For each fieldNeeded, resolve a valid test value with an auditable source. Precedence: (1) user-provided (validated against constraints), (2) fixture files (.json/.csv/.yaml/.xlsx under fixtureRoots — parse-and-match by fixtureHint entity+field), (3) DB SELECT DISTINCT via cs_qa_db_select on dbColumn, (4) synthetic (deterministic when syntheticSeed set; respects minLength/maxLength/pattern/enumValues/min/max), (5) elicit user when allowAskUser:true. Also generates an alsoInvalidSample per field (for negative-path scenarios) that violates a real constraint. Never invents values; every resolvedData entry names its source.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_resolve_test_data', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        log.info('resolve-test-data-start', {
            fieldCount: input.fieldsNeeded.length,
            allowDbQuery: input.allowDbQuery,
            allowAskUser: input.allowAskUser,
            fixtureRoots: input.fixtureRoots,
        });

        // Deterministic PRNG when seeded; time-based otherwise.
        const seed = input.syntheticSeed ?? Math.floor(Date.now() ^ (Math.random() * 0xffffffff));
        const rand = mulberry32(seed);

        // Preload fixtures once.
        const files = findFixtureFiles(ctx.workspaceRoot, input.fixtureRoots);
        const fixtures: Array<{ file: string; rows: Array<Record<string, unknown>>; entity: string }> = [];
        for (const f of files) {
            const parsed = parseFixtureFile(f, warnings);
            if (parsed) fixtures.push({ file: f, ...parsed });
        }
        log.info('fixtures-loaded', { fileCount: files.length, parsedCount: fixtures.length });

        const resolvedData: Record<string, ResolvedField> = {};
        const unresolved: Array<{ fieldName: string; reason: string }> = [];
        const sourceBreakdown: Record<string, number> = { user: 0, fixture: 0, db: 0, generator: 0, asked: 0 };

        for (const field of input.fieldsNeeded) {
            let resolved: ResolvedField | null = null;

            // 1. User-provided.
            resolved = tryUserProvided(field, input.providedData, warnings);

            // 2. Fixture.
            if (!resolved) resolved = tryFixture(field, fixtures, warnings);

            // 3. DB query.
            if (!resolved) resolved = await tryDbQuery(field, ctx, input.allowDbQuery, input.dbAliasFallback, warnings);

            // 4. Synthetic.
            if (!resolved) {
                // Only retry up to 5 times if constraints aren't satisfiable.
                for (let attempt = 0; attempt < 5; attempt++) {
                    const candidate = generateSynthetic(field, rand);
                    const check = validateAgainstConstraints(candidate.value as string | number | boolean, field.expectedType, field.constraints);
                    if (check.ok) { resolved = candidate; break; }
                }
                if (!resolved) {
                    // 5. Ask user (last resort).
                    if (input.allowAskUser) {
                        try {
                            const askResp = await ctx.elicit({
                                message: `resolve_test_data: unable to synthesize valid value for ${field.fieldName} (type=${field.expectedType}). Enter a value:`,
                                schema: 'text',
                            });
                            if (askResp.accepted && askResp.value !== undefined) {
                                const coerced = coerceValue(askResp.value, field.expectedType);
                                if (coerced.ok) {
                                    const check = validateAgainstConstraints(coerced.value!, field.expectedType, field.constraints);
                                    if (check.ok) resolved = { value: coerced.value ?? null, source: 'asked', why: 'user-supplied via elicit' };
                                }
                            }
                        } catch (e) {
                            warnings.push(`elicit failed for ${field.fieldName}: ${(e as Error).message}`);
                        }
                    }
                }
            }

            if (resolved) {
                // Attach invalid sample when requested.
                if (input.generateInvalidSamples) {
                    const inv = generateInvalid(field, rand);
                    resolved.alsoInvalidSample = inv.value;
                    resolved.invalidReason = inv.reason;
                }
                resolvedData[field.fieldName] = resolved;
                sourceBreakdown[resolved.source] = (sourceBreakdown[resolved.source] || 0) + 1;
            } else {
                unresolved.push({
                    fieldName: field.fieldName,
                    reason: field.constraints?.required
                        ? `required field could not be resolved from user/fixture/db/synthetic; ${input.allowAskUser ? 'ask-user declined/failed' : 'allowAskUser=false'}`
                        : `optional field left blank (no source produced a valid value)`,
                });
            }
        }

        log.info('resolve-test-data-done', {
            resolved: Object.keys(resolvedData).length,
            unresolved: unresolved.length,
            breakdown: sourceBreakdown,
        });

        const note = `Resolved ${Object.keys(resolvedData).length}/${input.fieldsNeeded.length} field(s). Sources: user=${sourceBreakdown.user}, fixture=${sourceBreakdown.fixture}, db=${sourceBreakdown.db}, generator=${sourceBreakdown.generator}, asked=${sourceBreakdown.asked}. Unresolved=${unresolved.length}.`;

        return {
            ok: unresolved.length === 0,
            resolvedData,
            unresolved,
            warnings,
            sourceBreakdown,
            note,
        };
    },
});
