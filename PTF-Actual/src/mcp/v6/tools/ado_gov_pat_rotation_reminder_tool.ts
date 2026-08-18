/**
 * cs_qa_gov_pat_rotation_reminder — Read/write .cs-qa/gov/pat-history.json to
 * track when every ADO PAT was last rotated. Warns at 60 days from last
 * rotation, fails at 85 days (ADO default expiry is 90 days).
 *
 * Verbs:
 *   list                 → read + report per-PAT age + status
 *   register             → add a new PAT metadata entry (id, scope, createdAt,
 *                          lastRotatedAt, expiresAt?, notes?). NEVER stores
 *                          the PAT itself.
 *   rotate               → mark a PAT as freshly rotated (updates
 *                          lastRotatedAt to now, optionally expiresAt).
 *   remove               → delete an entry by id.
 *
 * Emits an actionable next-step for every warn/fail entry: the exact URL to
 * regenerate the PAT (derived from the ADO orgUrl in the resolved cascade).
 * PAT bodies are NEVER logged, stored, or echoed. Only id + scope surface.
 */

import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import { loadPatHistory, ensurePatHistoryFile, writePatHistory, type PatHistoryEntry } from './_helpers/governance_config';

const RegisterEntrySchema = z.object({
    id: z.string().min(1).describe('Stable human-readable id — never the PAT itself. E.g. "ado-pat-ci", "ado-pat-alice-laptop".'),
    scope: z.string().min(1).describe('Descriptive scope tag: "read", "read-write", "full-access", "test-plans", etc.'),
    createdAt: z.string().min(1).optional().describe('ISO date; defaults to now.'),
    lastRotatedAt: z.string().min(1).optional().describe('ISO date; defaults to createdAt or now.'),
    expiresAt: z.string().min(1).optional().describe('ISO date; the expiry set on the ADO PAT issuance page.'),
    notes: z.string().optional().describe('Free-form note — owner, purpose, host. Never the token.'),
});

const InputSchema = z.discriminatedUnion('verb', [
    z.object({ verb: z.literal('list'), warnDays: z.number().int().positive().default(60), failDays: z.number().int().positive().default(85) }),
    z.object({ verb: z.literal('register'), entry: RegisterEntrySchema, warnDays: z.number().int().positive().default(60), failDays: z.number().int().positive().default(85) }),
    z.object({ verb: z.literal('rotate'), id: z.string().min(1), rotatedAtIso: z.string().min(1).optional(), newExpiresAt: z.string().min(1).optional() }),
    z.object({ verb: z.literal('remove'), id: z.string().min(1) }),
]);

const ReportEntrySchema = z.object({
    id: z.string(),
    scope: z.string(),
    createdAt: z.string(),
    lastRotatedAt: z.string(),
    expiresAt: z.string().optional(),
    ageDays: z.number(),
    daysToExpiry: z.number().optional(),
    status: z.enum(['ok', 'warn', 'fail']),
    action: z.string().optional(),
    notes: z.string().optional(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.string(),
    historyPath: z.string(),
    verdict: z.enum(['pass', 'warn', 'fail']),
    entries: z.array(ReportEntrySchema),
    regenerateUrl: z.string().optional(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

function daysAgo(iso: string, now: Date): number {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return Number.NaN;
    return Math.floor((now.getTime() - ms) / (24 * 60 * 60 * 1000));
}

function daysUntil(iso: string, now: Date): number {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return Number.NaN;
    return Math.floor((ms - now.getTime()) / (24 * 60 * 60 * 1000));
}

function deriveRegenerateUrl(orgUrl?: string | null): string | undefined {
    if (!orgUrl) return undefined;
    return `${orgUrl.replace(/\/$/, '')}/_usersSettings/tokens`;
}

registerPrimitive({
    name: 'cs_qa_gov_pat_rotation_reminder',
    description: 'Governance hook — track ADO PAT rotation age via .cs-qa/gov/pat-history.json. Verbs: list (report every PAT with age + status), register (add a metadata entry — NEVER the PAT itself), rotate (mark PAT as freshly rotated), remove. Warns at 60 days from lastRotatedAt, fails at 85 days (ADO default expiry is 90 days). Emits actionable next-step: the exact ADO URL to regenerate. PATs themselves are never logged, stored, or echoed. Inputs: {verb, entry?, id?, warnDays?, failDays?}. Example: {verb:"list"} — summary. {verb:"register", entry:{id:"ado-pat-ci", scope:"read-write", lastRotatedAt:"2026-06-01T00:00:00Z"}}.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gov_pat_rotation_reminder', { workspaceRoot: ctx.workspaceRoot });
        const now = new Date();
        const warnings: string[] = [];
        const ensuredPath = ensurePatHistoryFile(ctx.workspaceRoot);
        const { history, warning: loadWarn, path: p } = loadPatHistory(ctx.workspaceRoot);
        if (loadWarn) warnings.push(loadWarn);
        const credsRes = getResolvedCreds(ctx.workspaceRoot, {});
        const regenUrl = deriveRegenerateUrl(credsRes.creds?.orgUrl ?? credsRes.trace.orgUrl.value?.toString());

        const buildReport = (entries: PatHistoryEntry[], warnDays: number, failDays: number): Array<z.infer<typeof ReportEntrySchema>> => {
            return entries.map((entry) => {
                const ageDays = daysAgo(entry.lastRotatedAt, now);
                const daysToExpiry = entry.expiresAt ? daysUntil(entry.expiresAt, now) : undefined;
                let status: 'ok' | 'warn' | 'fail' = 'ok';
                if (!Number.isFinite(ageDays)) {
                    status = 'warn';
                } else {
                    if (ageDays >= failDays) status = 'fail';
                    else if (ageDays >= warnDays) status = 'warn';
                }
                if (daysToExpiry !== undefined && Number.isFinite(daysToExpiry)) {
                    if (daysToExpiry <= 5) status = 'fail';
                    else if (daysToExpiry <= 14 && status === 'ok') status = 'warn';
                }
                const action = status === 'ok'
                    ? undefined
                    : regenUrl
                        ? `Regenerate at ${regenUrl}. Then update lastRotatedAt via cs_qa_gov_pat_rotation_reminder verb=rotate id=${JSON.stringify(entry.id)}.`
                        : `Regenerate the PAT in ADO user settings, then update lastRotatedAt via cs_qa_gov_pat_rotation_reminder verb=rotate id=${JSON.stringify(entry.id)}.`;
                return {
                    id: entry.id,
                    scope: entry.scope,
                    createdAt: entry.createdAt,
                    lastRotatedAt: entry.lastRotatedAt,
                    expiresAt: entry.expiresAt,
                    ageDays: Number.isFinite(ageDays) ? ageDays : -1,
                    daysToExpiry: daysToExpiry !== undefined && Number.isFinite(daysToExpiry) ? daysToExpiry : undefined,
                    status,
                    action,
                    notes: entry.notes,
                };
            });
        };

        if (input.verb === 'list') {
            const report = buildReport(history.pats, input.warnDays, input.failDays);
            const verdict: 'pass' | 'warn' | 'fail' = report.some((r) => r.status === 'fail')
                ? 'fail'
                : report.some((r) => r.status === 'warn')
                    ? 'warn' : 'pass';
            log.info('pat list', { count: report.length, verdict });
            return {
                ok: verdict !== 'fail',
                verb: 'list',
                historyPath: p,
                verdict,
                entries: report,
                regenerateUrl: regenUrl,
                warnings,
                note: history.pats.length === 0
                    ? `No PAT metadata registered. Bootstrap with verb=register.`
                    : `${history.pats.length} PAT(s) tracked — ${report.filter((r) => r.status === 'ok').length} ok, ${report.filter((r) => r.status === 'warn').length} warn, ${report.filter((r) => r.status === 'fail').length} fail.`,
            };
        }

        if (input.verb === 'register') {
            const nowIso = now.toISOString();
            const entry: PatHistoryEntry = {
                id: input.entry.id,
                scope: input.entry.scope,
                createdAt: input.entry.createdAt ?? nowIso,
                lastRotatedAt: input.entry.lastRotatedAt ?? input.entry.createdAt ?? nowIso,
                expiresAt: input.entry.expiresAt,
                notes: input.entry.notes,
            };
            if (history.pats.some((p) => p.id === entry.id)) {
                warnings.push(`Entry ${entry.id} already exists — use verb=rotate to refresh timestamps or verb=remove first.`);
                const report = buildReport(history.pats, input.warnDays, input.failDays);
                const verdict: 'pass' | 'warn' | 'fail' = report.some((r) => r.status === 'fail') ? 'fail' : report.some((r) => r.status === 'warn') ? 'warn' : 'pass';
                return {
                    ok: false, verb: 'register', historyPath: p, verdict, entries: report, regenerateUrl: regenUrl,
                    warnings, note: `Register rejected — id "${entry.id}" already tracked.`,
                };
            }
            history.pats.push(entry);
            writePatHistory(ctx.workspaceRoot, history);
            log.info('pat registered', { id: entry.id, scope: entry.scope });
            const report = buildReport(history.pats, input.warnDays, input.failDays);
            const verdict: 'pass' | 'warn' | 'fail' = report.some((r) => r.status === 'fail') ? 'fail' : report.some((r) => r.status === 'warn') ? 'warn' : 'pass';
            return {
                ok: true, verb: 'register', historyPath: p, verdict, entries: report, regenerateUrl: regenUrl,
                warnings, note: `Registered PAT metadata for id "${entry.id}" (scope: ${entry.scope}).`,
            };
        }

        if (input.verb === 'rotate') {
            const idx = history.pats.findIndex((p) => p.id === input.id);
            if (idx < 0) {
                warnings.push(`No PAT with id "${input.id}" found.`);
                return {
                    ok: false, verb: 'rotate', historyPath: p, verdict: 'warn' as const,
                    entries: buildReport(history.pats, 60, 85), regenerateUrl: regenUrl, warnings,
                    note: `Rotate rejected — id "${input.id}" not found.`,
                };
            }
            history.pats[idx].lastRotatedAt = input.rotatedAtIso ?? now.toISOString();
            if (input.newExpiresAt) history.pats[idx].expiresAt = input.newExpiresAt;
            writePatHistory(ctx.workspaceRoot, history);
            log.info('pat rotated', { id: input.id });
            const report = buildReport(history.pats, 60, 85);
            const verdict: 'pass' | 'warn' | 'fail' = report.some((r) => r.status === 'fail') ? 'fail' : report.some((r) => r.status === 'warn') ? 'warn' : 'pass';
            return {
                ok: true, verb: 'rotate', historyPath: p, verdict, entries: report, regenerateUrl: regenUrl, warnings,
                note: `Rotation timestamp updated for id "${input.id}".`,
            };
        }

        // remove
        const before = history.pats.length;
        history.pats = history.pats.filter((p) => p.id !== input.id);
        if (before === history.pats.length) {
            warnings.push(`No PAT with id "${input.id}" found.`);
            return {
                ok: false, verb: 'remove', historyPath: p, verdict: 'warn' as const,
                entries: buildReport(history.pats, 60, 85), regenerateUrl: regenUrl, warnings,
                note: `Remove rejected — id "${input.id}" not found.`,
            };
        }
        writePatHistory(ctx.workspaceRoot, history);
        log.info('pat removed', { id: input.id });
        const report = buildReport(history.pats, 60, 85);
        const verdict: 'pass' | 'warn' | 'fail' = report.some((r) => r.status === 'fail') ? 'fail' : report.some((r) => r.status === 'warn') ? 'warn' : 'pass';
        void ensuredPath;
        return {
            ok: true, verb: 'remove', historyPath: p, verdict, entries: report, regenerateUrl: regenUrl, warnings,
            note: `Removed PAT metadata for id "${input.id}".`,
        };
    },
});
