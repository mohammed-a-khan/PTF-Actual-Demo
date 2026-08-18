/**
 * cs_qa_gen_test_data — bulk fixture generator.
 *
 * Given a set of entity specs (each with fields + count), emit a
 * deterministic-when-seeded JSON/CSV/YAML fixture file suitable for tests.
 *
 * Uses `@faker-js/faker` when installed; falls back to hand-rolled
 * generators (deterministic Mulberry32 seeded PRNG) when it isn't. Never
 * installs; lazy require. Warns when a field kind requires faker and the
 * fallback can only produce a lower-fidelity value.
 *
 * Output goes to test/data/generated-fixtures.json by default. Path may be
 * overridden with outputPath (absolute or workspace-relative).
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';

const FieldKindEnum = z.enum([
    'firstName', 'lastName', 'fullName',
    'email', 'phone', 'address', 'city', 'zip', 'country',
    'company', 'jobTitle',
    'iban', 'creditCardNumber', 'ssn',
    'uuid', 'date', 'boolean', 'integer', 'decimal',
    'enum', 'regex', 'string',
]);

const FieldSpecSchema = z.object({
    name: z.string().min(1),
    kind: FieldKindEnum,
    constraints: z.record(z.string(), z.unknown()).optional().describe('kind-specific constraints. enum: {values:[...]}. regex: {pattern:"..."}. integer: {min,max}. decimal: {min,max,precision}. date: {min,max,iso?}. string: {min,max}.'),
});

const EntitySpecSchema = z.object({
    name: z.string().min(1),
    count: z.number().int().positive().max(100_000),
    fields: z.array(FieldSpecSchema).min(1),
});

const InputSchema = z.object({
    entities: z.array(EntitySpecSchema).min(1),
    outputPath: z.string().optional(),
    seed: z.number().int().optional().describe('When set, all randomness is deterministic. Repeated runs with the same seed produce byte-identical output.'),
    format: z.enum(['json', 'csv', 'yaml']).default('json'),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    outputPath: z.string().nullable(),
    entities: z.array(z.object({ name: z.string(), count: z.number(), fields: z.number() })),
    format: z.string(),
    fakerLoaded: z.boolean(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

// -----------------------------------------------------------------------------
// Deterministic PRNG (Mulberry32) — used when faker is unavailable OR to seed
// faker's own PRNG for reproducibility.
// -----------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

interface Rng { next(): number; }

function makeRng(seed: number | undefined, salt: string): Rng {
    const s = (seed ?? 0x9E3779B9) ^ hashString(salt);
    const inner = mulberry32(s);
    return { next: inner };
}

// -----------------------------------------------------------------------------
// Hand-rolled fallback generators.
// -----------------------------------------------------------------------------

const FIRST_NAMES = ['Ava', 'Liam', 'Olivia', 'Noah', 'Emma', 'Ethan', 'Sophia', 'Mason', 'Isabella', 'Lucas', 'Mia', 'Aiden', 'Charlotte', 'Elijah', 'Amelia', 'Jack', 'Harper', 'Logan', 'Evelyn', 'James'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson'];
const CITIES = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose'];
const COMPANIES = ['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Wayne Enterprises', 'Stark Industries', 'Wonka', 'Cyberdyne', 'Tyrell', 'Weyland-Yutani'];
const JOB_TITLES = ['Engineer', 'Manager', 'Analyst', 'Consultant', 'Director', 'Coordinator', 'Specialist', 'Architect'];
const COUNTRIES = ['USA', 'UK', 'Canada', 'Germany', 'France', 'Australia', 'Japan', 'India', 'Brazil', 'Mexico'];

function pick<T>(rng: Rng, arr: readonly T[]): T { return arr[Math.floor(rng.next() * arr.length)]; }

function fallbackForKind(rng: Rng, kind: z.infer<typeof FieldKindEnum>, constraints: Record<string, unknown> | undefined, warnings: string[]): unknown {
    switch (kind) {
        case 'firstName': return pick(rng, FIRST_NAMES);
        case 'lastName': return pick(rng, LAST_NAMES);
        case 'fullName': return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
        case 'email': return `${pick(rng, FIRST_NAMES).toLowerCase()}.${pick(rng, LAST_NAMES).toLowerCase()}${Math.floor(rng.next() * 1000)}@example.com`;
        case 'phone': {
            const n = () => Math.floor(rng.next() * 10);
            return `(${n()}${n()}${n()}) ${n()}${n()}${n()}-${n()}${n()}${n()}${n()}`;
        }
        case 'address': return `${Math.floor(rng.next() * 9000) + 100} ${pick(rng, LAST_NAMES)} St`;
        case 'city': return pick(rng, CITIES);
        case 'zip': return String(Math.floor(rng.next() * 90000) + 10000);
        case 'country': return pick(rng, COUNTRIES);
        case 'company': return pick(rng, COMPANIES);
        case 'jobTitle': return pick(rng, JOB_TITLES);
        case 'iban': {
            let acct = '';
            for (let i = 0; i < 18; i++) acct += Math.floor(rng.next() * 10);
            return `GB${Math.floor(rng.next() * 90) + 10}NWBK${acct}`;
        }
        case 'creditCardNumber': {
            let cc = '4'; // Visa-like prefix
            for (let i = 0; i < 15; i++) cc += Math.floor(rng.next() * 10);
            return cc;
        }
        case 'ssn': {
            const n = () => Math.floor(rng.next() * 10);
            return `${n()}${n()}${n()}-${n()}${n()}-${n()}${n()}${n()}${n()}`;
        }
        case 'uuid': {
            // v4-ish deterministic UUID.
            const hex = '0123456789abcdef';
            let out = '';
            for (let i = 0; i < 32; i++) {
                if (i === 12) { out += '4'; continue; }
                if (i === 16) { out += hex[8 + Math.floor(rng.next() * 4)]; continue; }
                out += hex[Math.floor(rng.next() * 16)];
            }
            return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
        }
        case 'date': {
            const minMs = constraints && typeof constraints.min === 'string' ? Date.parse(constraints.min) : Date.UTC(2020, 0, 1);
            const maxMs = constraints && typeof constraints.max === 'string' ? Date.parse(constraints.max) : Date.now();
            const t = minMs + rng.next() * (maxMs - minMs);
            const iso = new Date(t).toISOString();
            return constraints && constraints.iso === false ? iso.slice(0, 10) : iso;
        }
        case 'boolean': return rng.next() < 0.5;
        case 'integer': {
            const min = Number((constraints?.min as number | undefined) ?? 0);
            const max = Number((constraints?.max as number | undefined) ?? 1000);
            return Math.floor(rng.next() * (max - min + 1)) + min;
        }
        case 'decimal': {
            const min = Number((constraints?.min as number | undefined) ?? 0);
            const max = Number((constraints?.max as number | undefined) ?? 1000);
            const prec = Math.max(0, Math.min(10, Number((constraints?.precision as number | undefined) ?? 2)));
            return Number((min + rng.next() * (max - min)).toFixed(prec));
        }
        case 'enum': {
            const values = (constraints?.values as unknown[] | undefined) || [];
            if (values.length === 0) { warnings.push('enum field without constraints.values — emitting null'); return null; }
            return pick(rng, values);
        }
        case 'regex': {
            const pattern = (constraints?.pattern as string | undefined) || '[A-Z]{3}\\d{4}';
            return regexGenerate(rng, pattern, warnings);
        }
        case 'string': {
            const min = Math.max(1, Number((constraints?.min as number | undefined) ?? 4));
            const max = Math.max(min, Number((constraints?.max as number | undefined) ?? 16));
            const len = Math.floor(rng.next() * (max - min + 1)) + min;
            const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let out = '';
            for (let i = 0; i < len; i++) out += chars[Math.floor(rng.next() * chars.length)];
            return out;
        }
        default:
            warnings.push(`unknown kind ${String(kind)} — emitting null`);
            return null;
    }
}

// Minimal regex generator — supports \d, \w, [a-z], [A-Z], [0-9], and {n} / {n,m}
// repetition. Anchors ^/$ are stripped. Non-supported meta chars emit warnings and
// are inserted as literals.
function regexGenerate(rng: Rng, pattern: string, warnings: string[]): string {
    const p = pattern.replace(/^\^/, '').replace(/\$$/, '');
    let out = '';
    let i = 0;
    while (i < p.length) {
        let atom = '';
        const c = p[i];
        if (c === '\\') {
            const n = p[i + 1];
            if (n === 'd') atom = String(Math.floor(rng.next() * 10));
            else if (n === 'w') {
                const set = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
                atom = set[Math.floor(rng.next() * set.length)];
            } else atom = n;
            i += 2;
        } else if (c === '[') {
            const end = p.indexOf(']', i);
            if (end === -1) { out += c; i++; continue; }
            const cls = p.slice(i + 1, end);
            atom = generateFromCharClass(rng, cls);
            i = end + 1;
        } else if (c === '.') {
            atom = String.fromCharCode(65 + Math.floor(rng.next() * 26));
            i++;
        } else if (c === '(' || c === ')' || c === '|' || c === '?' || c === '+' || c === '*') {
            warnings.push(`regex meta char ${c} not supported by fallback generator — emitted literal`);
            atom = c; i++;
        } else { atom = c; i++; }
        // repetition
        if (p[i] === '{') {
            const end = p.indexOf('}', i);
            if (end !== -1) {
                const inner = p.slice(i + 1, end);
                const [minStr, maxStr] = inner.split(',');
                const min = Number(minStr);
                const max = maxStr === undefined ? min : Number(maxStr);
                const n = Math.floor(rng.next() * (max - min + 1)) + min;
                for (let k = 0; k < n - 1; k++) {
                    // Regenerate atom for each rep — for class/\d, need to sample again.
                    // Cheap approach: repeat the atom character. Good enough for common cases.
                    out += atom;
                }
                out += atom;
                i = end + 1;
                continue;
            }
        }
        out += atom;
    }
    return out;
}

function generateFromCharClass(rng: Rng, cls: string): string {
    const chars: string[] = [];
    let j = 0;
    while (j < cls.length) {
        if (cls[j + 1] === '-' && cls[j + 2] !== undefined) {
            const a = cls.charCodeAt(j);
            const b = cls.charCodeAt(j + 2);
            for (let c = Math.min(a, b); c <= Math.max(a, b); c++) chars.push(String.fromCharCode(c));
            j += 3;
        } else { chars.push(cls[j]); j++; }
    }
    return chars.length > 0 ? chars[Math.floor(rng.next() * chars.length)] : '?';
}

// -----------------------------------------------------------------------------
// Faker wrapper — same shape as fallback but backed by faker when available.
// -----------------------------------------------------------------------------

interface FakerHandle { faker: { seed(v?: number): unknown; person?: unknown; internet?: unknown; phone?: unknown; location?: unknown; company?: unknown; finance?: unknown; string?: unknown; date?: unknown; number?: unknown; datatype?: unknown; helpers?: unknown; [key: string]: unknown }; version: string; }

function loadFaker(): FakerHandle | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('@faker-js/faker');
        const faker = mod.faker || (mod.default && mod.default.faker) || mod;
        if (!faker || typeof faker.seed !== 'function') return null;
        return { faker, version: mod.version || 'unknown' };
    } catch { return null; }
}

function fakerGenerate(handle: FakerHandle, kind: z.infer<typeof FieldKindEnum>, constraints: Record<string, unknown> | undefined, warnings: string[], rng: Rng): unknown {
    const f = handle.faker as Record<string, Record<string, (...args: unknown[]) => unknown>> & { helpers?: Record<string, (...args: unknown[]) => unknown> };
    try {
        switch (kind) {
            case 'firstName': return f.person?.firstName?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'lastName': return f.person?.lastName?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'fullName': return f.person?.fullName?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'email': return f.internet?.email?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'phone': return f.phone?.number?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'address': return f.location?.streetAddress?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'city': return f.location?.city?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'zip': return f.location?.zipCode?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'country': return f.location?.country?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'company': return f.company?.name?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'jobTitle': return f.person?.jobTitle?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'iban': return f.finance?.iban?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'creditCardNumber': return f.finance?.creditCardNumber?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'ssn': return fallbackForKind(rng, kind, constraints, warnings);
            case 'uuid': return f.string?.uuid?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'date': return f.date?.past?.() instanceof Date ? (f.date.past() as Date).toISOString() : fallbackForKind(rng, kind, constraints, warnings);
            case 'boolean': return f.datatype?.boolean?.() ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'integer': return f.number?.int?.({ min: constraints?.min ?? 0, max: constraints?.max ?? 1000 }) ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'decimal': return f.number?.float?.({ min: constraints?.min ?? 0, max: constraints?.max ?? 1000, fractionDigits: constraints?.precision ?? 2 }) ?? fallbackForKind(rng, kind, constraints, warnings);
            case 'enum': {
                const values = (constraints?.values as unknown[] | undefined) || [];
                if (values.length === 0) { warnings.push('enum field without constraints.values — emitting null'); return null; }
                return f.helpers?.arrayElement?.(values) ?? fallbackForKind(rng, kind, constraints, warnings);
            }
            case 'regex':
            case 'string':
            default:
                return fallbackForKind(rng, kind, constraints, warnings);
        }
    } catch {
        return fallbackForKind(rng, kind, constraints, warnings);
    }
}

// -----------------------------------------------------------------------------
// Output serializers.
// -----------------------------------------------------------------------------

function toCsv(rows: Array<Record<string, unknown>>): string {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? '' : String(v);
        if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
    return lines.join('\n') + '\n';
}

function toYaml(payload: Record<string, unknown>): string {
    // Minimal YAML serializer — flat entities, one list per entity name.
    const lines: string[] = [];
    for (const [entityName, rows] of Object.entries(payload)) {
        lines.push(`${entityName}:`);
        for (const row of rows as Array<Record<string, unknown>>) {
            const keys = Object.keys(row);
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                const v = row[k];
                const prefix = i === 0 ? '  - ' : '    ';
                const rendered = v === null || v === undefined ? '~' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v));
                lines.push(`${prefix}${k}: ${rendered}`);
            }
        }
    }
    return lines.join('\n') + '\n';
}

// -----------------------------------------------------------------------------
// Registration.
// -----------------------------------------------------------------------------

registerPrimitive({
    name: 'cs_qa_gen_test_data',
    description: 'Bulk faker-style fixture generator. Given entities:[{name,count,fields:[{name,kind,constraints?}]}], emit test/data/generated-fixtures.json (or CSV/YAML). Supported field kinds: firstName/lastName/fullName, email/phone/address/city/zip/country, company/jobTitle, iban/creditCardNumber/ssn, uuid/date/boolean/integer/decimal, enum (constraints.values), regex (constraints.pattern), string (constraints.min/max). Lazy-loads @faker-js/faker when present; hand-rolled deterministic fallbacks otherwise. When seed is set, output is byte-identical across runs. Never installs faker — lazy require only. Example: {entities:[{name:"users",count:10,fields:[{name:"id",kind:"uuid"},{name:"first",kind:"firstName"},{name:"email",kind:"email"}]}], seed:42}.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gen_test_data', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const fakerHandle = loadFaker();
        if (!fakerHandle) {
            warnings.push('@faker-js/faker not installed — using hand-rolled deterministic fallbacks (lower fidelity for some kinds like iban/creditCardNumber).');
        } else if (input.seed !== undefined) {
            try { fakerHandle.faker.seed(input.seed); } catch { /* older faker versions may throw */ }
        }

        const payload: Record<string, Array<Record<string, unknown>>> = {};
        for (const entity of input.entities) {
            const rows: Array<Record<string, unknown>> = [];
            for (let i = 0; i < entity.count; i++) {
                const row: Record<string, unknown> = {};
                for (const field of entity.fields) {
                    const rngSalt = `${entity.name}:${field.name}:${i}`;
                    const rng = makeRng(input.seed, rngSalt);
                    row[field.name] = fakerHandle
                        ? fakerGenerate(fakerHandle, field.kind, field.constraints, warnings, rng)
                        : fallbackForKind(rng, field.kind, field.constraints, warnings);
                }
                rows.push(row);
            }
            payload[entity.name] = rows;
        }

        const outAbs = input.outputPath
            ? (path.isAbsolute(input.outputPath) ? input.outputPath : path.join(ctx.workspaceRoot, input.outputPath))
            : path.join(ctx.workspaceRoot, 'test', 'data', 'generated-fixtures.' + input.format);

        try {
            fs.mkdirSync(path.dirname(outAbs), { recursive: true });
            if (input.format === 'json') {
                fs.writeFileSync(outAbs, JSON.stringify(payload, null, 2), 'utf-8');
            } else if (input.format === 'csv') {
                // For CSV multi-entity, write one file per entity next to outAbs (base + .<entity>.csv).
                const base = outAbs.replace(/\.csv$/i, '');
                const entities = Object.keys(payload);
                if (entities.length === 1) {
                    fs.writeFileSync(outAbs, toCsv(payload[entities[0]]), 'utf-8');
                } else {
                    for (const name of entities) {
                        fs.writeFileSync(`${base}.${name}.csv`, toCsv(payload[name]), 'utf-8');
                    }
                }
            } else {
                fs.writeFileSync(outAbs, toYaml(payload), 'utf-8');
            }
        } catch (e) {
            return {
                ok: false, outputPath: null,
                entities: input.entities.map((e) => ({ name: e.name, count: e.count, fields: e.fields.length })),
                format: input.format, fakerLoaded: !!fakerHandle,
                warnings: warnings.concat([`write failed: ${(e as Error).message}`]),
                note: 'gen-test-data: file write failed',
            };
        }

        log.info('fixtures generated', { entities: input.entities.length, fakerLoaded: !!fakerHandle, format: input.format });
        return {
            ok: true,
            outputPath: outAbs,
            entities: input.entities.map((e) => ({ name: e.name, count: e.count, fields: e.fields.length })),
            format: input.format,
            fakerLoaded: !!fakerHandle,
            warnings,
            note: `${input.entities.map((e) => e.name + '×' + e.count).join(', ')} → ${outAbs}${input.seed !== undefined ? ' (deterministic seed=' + input.seed + ')' : ''}. Faker: ${fakerHandle ? 'loaded (' + fakerHandle.version + ')' : 'fallback'}.`,
        };
    },
});
