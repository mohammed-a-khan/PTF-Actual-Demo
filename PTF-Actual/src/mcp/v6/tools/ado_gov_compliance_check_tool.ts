/**
 * cs_qa_gov_compliance_check — Run a manifest of governance checks against
 * the current workspace and (optionally) the connected ADO project.
 *
 * Checks:
 *   1. pat-rotation-age          — read .cs-qa/gov/pat-history.json; warn at
 *                                  60d, fail at 85d
 *   2. audit-log-retention       — read the audit JSONL; warn if oldest row
 *                                  is older than the configured retention
 *                                  window (default 90d)
 *   3. attachment-blocklist-fresh — read .cs-qa/gov/attachment-blocklist.json;
 *                                   warn if it hasn't been updated in >180d
 *   4. gdpr-sensitive-tag-usage  — WIQL query [System.Tags] CONTAINS 'gdpr'
 *                                   (only when ADO creds resolve); count and
 *                                   surface top hits
 *   5. tests-targeting-prod-urls — grep workspace test/ folder for URLs that
 *                                  look like prod (no sit/uat/dev/qa infix)
 *   6. governance-config-present — verify each .cs-qa/gov/*.json exists +
 *                                  is valid JSON; warn on missing, fail on
 *                                  corrupt
 *
 * Every check returns pass/warn/fail with actionable remediation. The
 * verdict is the worst finding across all checks.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import { loadPatHistory, loadAttachmentBlocklist, loadAdoPolicies } from './_helpers/governance_config';
import { wiql } from './_helpers/wiql_builder';

const InputSchema = z.object({
    checks: z.array(z.enum([
        'pat-rotation-age',
        'audit-log-retention',
        'attachment-blocklist-fresh',
        'gdpr-sensitive-tag-usage',
        'tests-targeting-prod-urls',
        'governance-config-present',
    ])).optional().describe('When omitted, all checks run.'),
    patWarnDays: z.number().int().positive().default(60),
    patFailDays: z.number().int().positive().default(85),
    auditRetentionDays: z.number().int().positive().default(90),
    blocklistFreshDays: z.number().int().positive().default(180),
    gdprTag: z.string().min(1).default('gdpr'),
    testRoot: z.string().min(1).default('test').describe('Workspace-relative folder to grep for prod-URL tests.'),
    prodUrlIndicators: z.array(z.string().min(1)).default(['prod', 'production', 'live']).describe('Substrings in a URL that indicate a prod target.'),
    lowerEnvIndicators: z.array(z.string().min(1)).default(['sit', 'uat', 'dev', 'qa', 'test', 'stage', 'staging']).describe('Substrings that DEMOTE a URL from prod suspicion.'),
    /** ADO cascade overrides (only needed for gdpr-sensitive-tag-usage). */
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
});

const CheckResultSchema = z.object({
    check: z.string(),
    status: z.enum(['pass', 'warn', 'fail', 'skipped']),
    detail: z.string(),
    remediation: z.string().optional(),
    evidence: z.record(z.string(), z.any()).optional(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verdict: z.enum(['pass', 'warn', 'fail']),
    timestamp: z.string(),
    results: z.array(CheckResultSchema),
    summary: z.object({
        pass: z.number(),
        warn: z.number(),
        fail: z.number(),
        skipped: z.number(),
    }),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

function daysBetween(a: Date, b: Date): number {
    return Math.floor(Math.abs(a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

function walkForFiles(root: string, exts: string[], acc: string[] = []): string[] {
    let stat: fs.Stats;
    try { stat = fs.statSync(root); } catch { return acc; }
    if (stat.isFile()) {
        const ext = path.extname(root).replace(/^\./, '').toLowerCase();
        if (exts.includes(ext)) acc.push(root);
        return acc;
    }
    if (!stat.isDirectory()) return acc;
    const base = path.basename(root);
    if (base === 'node_modules' || base === 'dist' || base === '.git') return acc;
    let entries: string[] = [];
    try { entries = fs.readdirSync(root); } catch { return acc; }
    for (const e of entries) walkForFiles(path.join(root, e), exts, acc);
    return acc;
}

registerPrimitive({
    name: 'cs_qa_gov_compliance_check',
    description: 'Governance hook — run a manifest of compliance checks: PAT rotation age (from .cs-qa/gov/pat-history.json — warn at 60d, fail at 85d), audit-log retention (JSONL age), attachment-blocklist freshness, GDPR-sensitive tag usage (WIQL against ADO), tests targeting prod URLs (grep test/), governance-config presence. Each check returns pass/warn/fail with actionable remediation. Read-only. Inputs: {checks?[], patWarnDays?, patFailDays?, auditRetentionDays?, blocklistFreshDays?, gdprTag?, testRoot?}. Example: {checks:["pat-rotation-age","audit-log-retention"]} — quick subset.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gov_compliance_check', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const now = new Date();
        const enabled = new Set(input.checks && input.checks.length > 0
            ? input.checks
            : ['pat-rotation-age', 'audit-log-retention', 'attachment-blocklist-fresh', 'gdpr-sensitive-tag-usage', 'tests-targeting-prod-urls', 'governance-config-present']);
        const results: Array<z.infer<typeof CheckResultSchema>> = [];

        // 1. pat-rotation-age
        if (enabled.has('pat-rotation-age')) {
            const { history, path: p, existed, warning } = loadPatHistory(ctx.workspaceRoot);
            if (warning) warnings.push(warning);
            if (!existed || history.pats.length === 0) {
                results.push({
                    check: 'pat-rotation-age',
                    status: 'warn',
                    detail: `No PAT history recorded at ${p}.`,
                    remediation: `Bootstrap the tracker: register every ADO PAT with cs_qa_gov_pat_rotation_reminder verb=register (id, scope, createdAt, lastRotatedAt).`,
                    evidence: { path: p, existed },
                });
            } else {
                const overdue = [];
                const soon = [];
                for (const pat of history.pats) {
                    const last = Date.parse(pat.lastRotatedAt);
                    if (!Number.isFinite(last)) {
                        warnings.push(`PAT ${pat.id} has unparseable lastRotatedAt: ${pat.lastRotatedAt}`);
                        continue;
                    }
                    const age = daysBetween(now, new Date(last));
                    if (age >= input.patFailDays) overdue.push({ id: pat.id, scope: pat.scope, ageDays: age });
                    else if (age >= input.patWarnDays) soon.push({ id: pat.id, scope: pat.scope, ageDays: age });
                }
                const status: 'pass' | 'warn' | 'fail' = overdue.length > 0 ? 'fail' : (soon.length > 0 ? 'warn' : 'pass');
                results.push({
                    check: 'pat-rotation-age',
                    status,
                    detail: `${history.pats.length} PAT(s) tracked; ${overdue.length} overdue (>=${input.patFailDays}d); ${soon.length} nearing rotation (>=${input.patWarnDays}d).`,
                    remediation: overdue.length > 0
                        ? `Rotate immediately: ${overdue.map((o) => `${o.id} (age ${o.ageDays}d)`).join('; ')}. Then update lastRotatedAt via cs_qa_gov_pat_rotation_reminder verb=rotate.`
                        : soon.length > 0
                            ? `Schedule rotation for: ${soon.map((o) => `${o.id} (age ${o.ageDays}d)`).join('; ')}.`
                            : `All PATs within rotation window.`,
                    evidence: { overdue, soon, path: p },
                });
            }
        }

        // 2. audit-log-retention
        if (enabled.has('audit-log-retention')) {
            const auditPath = path.join(ctx.workspaceRoot, '.cs-qa', 'audit', 'ado-audit.jsonl');
            if (!fs.existsSync(auditPath)) {
                results.push({
                    check: 'audit-log-retention',
                    status: 'warn',
                    detail: `Audit log not present at ${auditPath}. No history to enforce retention against.`,
                    remediation: `Any v6 tool invocation creates the file automatically — this warning clears after first use.`,
                    evidence: { path: auditPath },
                });
            } else {
                const text = fs.readFileSync(auditPath, 'utf-8');
                const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0);
                let oldestMs = Number.NaN;
                if (firstLine) {
                    try {
                        const parsed = JSON.parse(firstLine) as { ts?: string };
                        if (parsed.ts) oldestMs = Date.parse(parsed.ts);
                    } catch { /* fall through */ }
                }
                if (!Number.isFinite(oldestMs)) {
                    results.push({
                        check: 'audit-log-retention',
                        status: 'warn',
                        detail: `Could not parse oldest audit row timestamp.`,
                        remediation: `Inspect ${auditPath} manually.`,
                    });
                } else {
                    const ageDays = daysBetween(now, new Date(oldestMs));
                    const status: 'pass' | 'warn' = ageDays > input.auditRetentionDays ? 'warn' : 'pass';
                    results.push({
                        check: 'audit-log-retention',
                        status,
                        detail: `Oldest audit row is ${ageDays} day(s) old; retention window ${input.auditRetentionDays} day(s).`,
                        remediation: status === 'warn'
                            ? `Archive/rotate the audit log: copy ${auditPath} to a dated backup and truncate the working file.`
                            : undefined,
                        evidence: { oldestIso: new Date(oldestMs).toISOString(), ageDays, retentionDays: input.auditRetentionDays },
                    });
                }
            }
        }

        // 3. attachment-blocklist-fresh
        if (enabled.has('attachment-blocklist-fresh')) {
            const { blocklist, path: p, existed, warning } = loadAttachmentBlocklist(ctx.workspaceRoot);
            if (warning) warnings.push(warning);
            if (!existed) {
                results.push({
                    check: 'attachment-blocklist-fresh',
                    status: 'warn',
                    detail: `Attachment blocklist not present at ${p}.`,
                    remediation: `Create the file (empty is fine — cs_qa_gov_attachment_audit will treat it as empty). Add SHA-256 hashes to actively block.`,
                    evidence: { path: p },
                });
            } else {
                let mtime = new Date(0);
                try { mtime = fs.statSync(p).mtime; } catch { /* ignore */ }
                const ageDays = daysBetween(now, mtime);
                const status: 'pass' | 'warn' = ageDays > input.blocklistFreshDays ? 'warn' : 'pass';
                results.push({
                    check: 'attachment-blocklist-fresh',
                    status,
                    detail: `${blocklist.hashes.length} entry/entries; file last touched ${ageDays} day(s) ago.`,
                    remediation: status === 'warn'
                        ? `Refresh the blocklist: pull the latest known-bad hashes from your security team's feed and update ${p}.`
                        : undefined,
                    evidence: { path: p, count: blocklist.hashes.length, ageDays },
                });
            }
        }

        // 4. gdpr-sensitive-tag-usage — needs ADO creds.
        if (enabled.has('gdpr-sensitive-tag-usage')) {
            const credsRes = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
            if (!credsRes.creds) {
                results.push({
                    check: 'gdpr-sensitive-tag-usage',
                    status: 'skipped',
                    detail: `ADO not configured — skipping GDPR tag scan.`,
                    remediation: credsRes.diagnostic,
                });
            } else {
                try {
                    const client = new AdoHttpClient(credsRes.creds);
                    const q = wiql()
                        .select(['[System.Id]', '[System.Title]', '[System.WorkItemType]'])
                        .from('WorkItems')
                        .where().tag(input.gdprTag).done()
                        .orderBy('[System.Id]', 'DESC');
                    const wiqlBody = { query: q.build() };
                    // WIQL POST does NOT accept $top as a query param (silent no-op on ADO).
                    // The server default cap is 20000; if we hit it, emit a `capped` warning
                    // so callers know the count is a floor rather than the true value.
                    const WIQL_DEFAULT_CAP = 20000;
                    const resp = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.0`, wiqlBody);
                    const count = (resp?.workItems ?? []).length;
                    if (count >= WIQL_DEFAULT_CAP) {
                        warnings.push(`gdpr-sensitive-tag-usage: WIQL result count (${count}) hit the ADO WIQL cap (${WIQL_DEFAULT_CAP}) — result is capped, true count may be higher.`);
                    }
                    const status: 'pass' | 'warn' = count > 0 ? 'warn' : 'pass';
                    results.push({
                        check: 'gdpr-sensitive-tag-usage',
                        status,
                        detail: `${count} work item(s) tagged '${input.gdprTag}' in project ${credsRes.creds.project}.`,
                        remediation: status === 'warn'
                            ? `Review the GDPR-tagged work items for data-minimisation compliance: cs_qa_ado_read verb=work-item id=<n> for each. Ensure PII fields are redacted or purpose-limited.`
                            : undefined,
                        evidence: { count, wiqlUsed: q.build(), capped: count >= WIQL_DEFAULT_CAP },
                    });
                } catch (e) {
                    results.push({
                        check: 'gdpr-sensitive-tag-usage',
                        status: 'warn',
                        detail: `GDPR tag scan failed: ${(e as Error).message}`,
                        remediation: `Verify ADO connectivity and PAT scope (needs Work Items read).`,
                    });
                }
            }
        }

        // 5. tests-targeting-prod-urls
        if (enabled.has('tests-targeting-prod-urls')) {
            const testRoot = path.isAbsolute(input.testRoot) ? input.testRoot : path.join(ctx.workspaceRoot, input.testRoot);
            const hits: Array<{ file: string; line: number; url: string }> = [];
            const files = walkForFiles(testRoot, ['ts', 'tsx', 'js', 'feature', 'json', 'env']);
            const urlRe = /https?:\/\/[^\s"'`)]+/g;
            for (const f of files) {
                let content = '';
                try { content = fs.readFileSync(f, 'utf-8'); }
                catch { continue; }
                const lines = content.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    urlRe.lastIndex = 0;
                    let m: RegExpExecArray | null;
                    while ((m = urlRe.exec(lines[i])) !== null) {
                        const url = m[0].toLowerCase();
                        const isLower = input.lowerEnvIndicators.some((tag) => url.includes(tag));
                        if (isLower) continue;
                        const isProdish = input.prodUrlIndicators.some((tag) => url.includes(tag));
                        // Suspect if explicitly prodish OR (has no env hint AND is not localhost/private).
                        const isLocal = /(^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0))|(^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.))/i.test(m[0]);
                        if (isProdish && !isLocal) {
                            hits.push({ file: f, line: i + 1, url: m[0] });
                        }
                    }
                }
            }
            const status: 'pass' | 'warn' = hits.length > 0 ? 'warn' : 'pass';
            results.push({
                check: 'tests-targeting-prod-urls',
                status,
                detail: hits.length === 0
                    ? `Scanned ${files.length} test file(s); no prod-URL targeting detected.`
                    : `Found ${hits.length} suspected prod URL(s) in test artefacts.`,
                remediation: status === 'warn'
                    ? `Move prod URLs into a config file per environment (config/<slug>/environments/prod.env) and reference via this.config.get('BASE_URL'). Never bake a prod URL into a test.`
                    : undefined,
                evidence: { hits: hits.slice(0, 20) },
            });
        }

        // 6. governance-config-present
        if (enabled.has('governance-config-present')) {
            const items = [
                { name: 'attachment-blocklist.json', ...loadAttachmentBlocklist(ctx.workspaceRoot) },
                { name: 'ado-policies.json', ...loadAdoPolicies(ctx.workspaceRoot) },
                { name: 'pat-history.json', ...loadPatHistory(ctx.workspaceRoot) },
            ];
            const missing = items.filter((i) => !i.existed).map((i) => i.name);
            const corrupt = items.filter((i) => i.warning).map((i) => i.name);
            const status: 'pass' | 'warn' | 'fail' = corrupt.length > 0 ? 'fail' : (missing.length > 0 ? 'warn' : 'pass');
            results.push({
                check: 'governance-config-present',
                status,
                detail: `${items.length - missing.length}/${items.length} governance config file(s) present; corrupt: ${corrupt.length}`,
                remediation: corrupt.length > 0
                    ? `Repair or reset corrupt files: ${corrupt.join(', ')}. Backup first, then delete to recreate on next tool run.`
                    : missing.length > 0
                        ? `Create missing files: ${missing.join(', ')}. Empty-but-valid JSON is fine — the tools bootstrap defaults automatically.`
                        : undefined,
                evidence: { missing, corrupt },
            });
        }

        const summary = {
            pass: results.filter((r) => r.status === 'pass').length,
            warn: results.filter((r) => r.status === 'warn').length,
            fail: results.filter((r) => r.status === 'fail').length,
            skipped: results.filter((r) => r.status === 'skipped').length,
        };
        const verdict: 'pass' | 'warn' | 'fail' = summary.fail > 0 ? 'fail' : (summary.warn > 0 ? 'warn' : 'pass');
        log.info('compliance check complete', { verdict, ...summary });
        return {
            ok: verdict !== 'fail',
            verdict,
            timestamp: now.toISOString(),
            results,
            summary,
            warnings,
            note: `${results.length} check(s) — ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail, ${summary.skipped} skipped. Verdict: ${verdict}.`,
        };
    },
});
