/**
 * cs_qa_gov_audit_trail — Query the append-only audit JSONL at
 * `.cs-qa/audit/ado-audit.jsonl` written by createLogger.
 *
 * Filters (all optional; AND-combined):
 *   toolName          — exact tool name (e.g. cs_qa_ado_write)
 *   correlationId     — invocationId prefix or full match
 *   level             — 'info' | 'warn' | 'error'
 *   sinceIso / untilIso — ISO timestamps bounding [since, until]
 *   messageContains   — case-insensitive substring
 *   verifyPatRedaction — when true, scan every returned row for PAT-shape
 *                        tokens and surface any un-redacted leakage as a
 *                        governance violation
 *
 * Returns matched rows (already redacted by the logger) + aggregate counts
 * by tool / level / hour. Read-only — no elicitation. Never emits raw PATs;
 * pipes every returned row through redactSecrets() as a belt-and-braces
 * second pass.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger, redactSecrets } from './_helpers/structured_logger';

const InputSchema = z.object({
    toolName: z.string().min(1).optional().describe('Exact match on the emitted toolName field.'),
    correlationId: z.string().min(1).optional().describe('Exact or prefix match on invocationId.'),
    level: z.enum(['info', 'warn', 'error']).optional(),
    sinceIso: z.string().min(1).optional().describe('ISO datetime; rows with ts >= sinceIso pass.'),
    untilIso: z.string().min(1).optional().describe('ISO datetime; rows with ts <= untilIso pass.'),
    messageContains: z.string().min(1).optional().describe('Case-insensitive substring match on msg field.'),
    verifyPatRedaction: z.boolean().default(true).describe('When true, scan every returned row for PAT-shape leakage and surface violations.'),
    limit: z.number().int().positive().max(20000).default(500).describe('Max rows to return.'),
    auditFilePath: z.string().min(1).optional().describe('Override audit JSONL path (defaults to <workspaceRoot>/.cs-qa/audit/ado-audit.jsonl).'),
});

const RowSchema = z.object({
    ts: z.string().optional(),
    invocationId: z.string().optional(),
    toolName: z.string().optional(),
    level: z.string().optional(),
    msg: z.string().optional(),
    extra: z.record(z.string(), z.any()).optional(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    auditPath: z.string(),
    fileExists: z.boolean(),
    totalScanned: z.number(),
    matched: z.number(),
    rows: z.array(RowSchema),
    aggregate: z.object({
        byTool: z.record(z.string(), z.number()),
        byLevel: z.record(z.string(), z.number()),
        byHour: z.record(z.string(), z.number()),
    }),
    redactionViolations: z.array(z.object({
        line: z.number(),
        kind: z.string(),
        snippet: z.string(),
    })),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

const PAT_SHAPE_RE = /\b[A-Za-z0-9]{52}\b/g;
const GITHUB_PAT_RE = /\b(gh[pousr])_[A-Za-z0-9_]{20,}\b/g;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g;

function parseIsoOrNull(iso?: string): number | null {
    if (!iso) return null;
    const n = Date.parse(iso);
    return Number.isFinite(n) ? n : null;
}

registerPrimitive({
    name: 'cs_qa_gov_audit_trail',
    description: 'Governance hook — query the append-only ADO audit JSONL (.cs-qa/audit/ado-audit.jsonl) with filters (toolName, correlationId, level, timeRange, messageContains) and get aggregate counts by tool/level/hour. Optionally verifies PAT redaction by scanning every returned row for un-redacted PAT-shape tokens and surfaces leakage as governance violations. Read-only — no confirmation prompt. Example: {toolName:"cs_qa_ado_write", level:"error", sinceIso:"2026-08-01T00:00:00Z", limit:100}.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gov_audit_trail', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const auditPath = input.auditFilePath
            ?? path.join(ctx.workspaceRoot, '.cs-qa', 'audit', 'ado-audit.jsonl');
        if (!fs.existsSync(auditPath)) {
            log.info('audit file missing', { auditPath });
            return {
                ok: true,
                auditPath,
                fileExists: false,
                totalScanned: 0,
                matched: 0,
                rows: [],
                aggregate: { byTool: {}, byLevel: {}, byHour: {} },
                redactionViolations: [],
                warnings: [`Audit file not found: ${auditPath}. First tool invocation will create it.`],
                note: 'Audit trail is empty — nothing to report.',
            };
        }
        const sinceMs = parseIsoOrNull(input.sinceIso);
        const untilMs = parseIsoOrNull(input.untilIso);
        if (input.sinceIso && sinceMs === null) warnings.push(`sinceIso not parseable: ${input.sinceIso}`);
        if (input.untilIso && untilMs === null) warnings.push(`untilIso not parseable: ${input.untilIso}`);
        // Stream the audit file line-by-line so audit logs measured in hundreds of
        // MB don't have to fit in memory. `crlfDelay: Infinity` normalises CRLF/LF.
        const rows: Array<z.infer<typeof RowSchema>> = [];
        const byTool: Record<string, number> = {};
        const byLevel: Record<string, number> = {};
        const byHour: Record<string, number> = {};
        const violations: Array<{ line: number; kind: string; snippet: string }> = [];
        const needle = input.messageContains ? input.messageContains.toLowerCase() : null;
        let totalScanned = 0;
        let matched = 0;
        let lineNumber = 0;
        const stream = fs.createReadStream(auditPath, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const raw of rl) {
            lineNumber++;
            if (!raw.trim()) continue;
            totalScanned++;
            let parsed: Record<string, unknown> | null = null;
            try { parsed = JSON.parse(raw) as Record<string, unknown>; }
            catch { continue; }
            if (!parsed) continue;
            const toolName = typeof parsed.toolName === 'string' ? parsed.toolName : (typeof parsed.tool === 'string' ? parsed.tool : undefined);
            const level = typeof parsed.level === 'string' ? parsed.level : undefined;
            const msg = typeof parsed.msg === 'string' ? parsed.msg : (typeof parsed.message === 'string' ? parsed.message : '');
            const ts = typeof parsed.ts === 'string' ? parsed.ts : undefined;
            const invocationId = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
            if (input.toolName && toolName !== input.toolName) continue;
            if (input.correlationId && (!invocationId || !invocationId.startsWith(input.correlationId))) continue;
            if (input.level && level !== input.level) continue;
            if (needle && !msg.toLowerCase().includes(needle)) continue;
            if (ts) {
                const tsMs = Date.parse(ts);
                if (Number.isFinite(tsMs)) {
                    if (sinceMs !== null && tsMs < sinceMs) continue;
                    if (untilMs !== null && tsMs > untilMs) continue;
                }
            }
            if (input.verifyPatRedaction) {
                PAT_SHAPE_RE.lastIndex = 0;
                GITHUB_PAT_RE.lastIndex = 0;
                PRIVATE_KEY_RE.lastIndex = 0;
                if (PAT_SHAPE_RE.test(raw)) violations.push({ line: lineNumber, kind: 'ado-pat-shape', snippet: raw.slice(0, 120) });
                if (GITHUB_PAT_RE.test(raw)) violations.push({ line: lineNumber, kind: 'github-pat', snippet: raw.slice(0, 120) });
                if (PRIVATE_KEY_RE.test(raw)) violations.push({ line: lineNumber, kind: 'private-key-block', snippet: raw.slice(0, 120) });
            }
            matched++;
            if (rows.length < input.limit) {
                // Belt-and-braces: scrub again before returning.
                const scrubbed = redactSecrets(parsed) as Record<string, unknown>;
                const extra: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(scrubbed)) {
                    if (k === 'ts' || k === 'invocationId' || k === 'toolName' || k === 'level' || k === 'msg') continue;
                    extra[k] = v;
                }
                rows.push({
                    ts,
                    invocationId,
                    toolName,
                    level,
                    msg,
                    extra,
                });
            }
            if (toolName) byTool[toolName] = (byTool[toolName] ?? 0) + 1;
            if (level) byLevel[level] = (byLevel[level] ?? 0) + 1;
            if (ts) {
                const hour = ts.slice(0, 13); // yyyy-mm-ddTHH
                byHour[hour] = (byHour[hour] ?? 0) + 1;
            }
        }
        log.info('audit trail query complete', { totalScanned, matched, violations: violations.length });
        return {
            ok: violations.length === 0,
            auditPath,
            fileExists: true,
            totalScanned,
            matched,
            rows,
            aggregate: { byTool, byLevel, byHour },
            redactionViolations: violations,
            warnings,
            note: violations.length === 0
                ? `Scanned ${totalScanned} row(s); ${matched} matched filter(s); no PAT-shape leakage detected.`
                : `Scanned ${totalScanned} row(s); ${matched} matched; ${violations.length} redaction violation(s) — audit-log leak. Rotate any exposed PAT and inspect the offending line(s).`,
        };
    },
});
