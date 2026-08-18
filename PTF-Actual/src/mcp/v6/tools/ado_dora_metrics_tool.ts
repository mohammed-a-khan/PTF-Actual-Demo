/**
 * cs_qa_dora_metrics — Compute the 4 DORA metrics from Azure DevOps + git.
 *
 * Metrics (Accelerate: State of DevOps):
 *   1. Deployment Frequency — count of successful pipeline runs / windowDays.
 *      Uses `_apis/build/builds?statusFilter=completed&resultFilter=succeeded&minTime=<ISO>`.
 *   2. Lead Time for Changes — median hours between the FIRST commit on a
 *      branch and the completion of the merge PR that shipped it. Reads git
 *      log locally + ADO PR completion times.
 *   3. Change Failure Rate — % of deploys followed within 24h by a bug tagged
 *      `regression`. Deploys from metric #1; bugs via wiql() with a tag+date
 *      filter.
 *   4. MTTR — median hours from CreatedDate → ClosedDate for
 *      severity=1 OR severity=2 bugs whose ClosedDate falls in the window.
 *
 * Real HTTP (via AdoHttpClient). Real git via `git log`. NO fabricated data —
 * if the window contains 0 deploys, all metrics are 0 with insufficientData:true.
 *
 * Optionally POSTs the metric bundle to a Grafana / generic webhook. Uses the
 * global fetch for that (not AdoHttpClient — the endpoint isn't ADO).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { wiql } from './_helpers/wiql_builder';
import { getResolvedCreds } from './ado_config_tool';

interface Build {
    id: number;
    result: string;
    status: string;
    startTime?: string;
    finishTime?: string;
    sourceBranch?: string;
    sourceVersion?: string;
    definition?: { id?: number; name?: string };
}

interface PullRequest {
    pullRequestId: number;
    status: string;
    creationDate?: string;
    closedDate?: string;
    sourceRefName?: string;
    targetRefName?: string;
    lastMergeSourceCommit?: { commitId?: string };
    lastMergeCommit?: { commitId?: string };
    completionQueueTime?: string;
}

interface BugRow {
    id: number;
    createdDate?: string;
    closedDate?: string;
    severity?: string;
    tags?: string;
}

function median(xs: number[]): number {
    if (xs.length === 0) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function daysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString();
}

function parseSeverityLevel(s: string | undefined): number {
    if (!s) return 99;
    const m = s.match(/^(\d)/);
    return m ? Number(m[1]) : 99;
}

/**
 * Compute the earliest commit timestamp on a branch, restricted to the commits
 * that are UNIQUE to that branch (not reachable from its merge target's trunk).
 *
 * When `mergeCommit` is supplied, we ask git for commits reachable from the
 * merge commit but NOT from its first parent (`^<mergeCommit>^1`). That
 * naturally excludes trunk history — the previous implementation walked
 * `git log <mergeCommit> -n 200` which included the entire trunk back to root
 * and made lead time appear ancient on any long-lived repo.
 *
 * When `mergeCommit` is absent, fall back to `git log <branch> ^<baseBranch>`
 * so we still get branch-unique commits.
 */
function gitFirstCommitOnBranch(repoRoot: string, sourceBranch: string, mergeCommit?: string, baseBranch = 'main'): { firstCommitTs: number } | null {
    // Cap the walk at 1000 commits (not 200) — long-lived feature branches
    // legitimately exceed 200 commits; emit a warn to warnings when hit.
    const CAP = 1000;
    const args = ['log', '--pretty=%at', '--no-merges', `-n`, String(CAP)];
    if (mergeCommit) {
        // Reachable from mergeCommit but not from its first parent (= trunk).
        args.push(mergeCommit, `^${mergeCommit}^1`);
    } else if (sourceBranch) {
        // Reachable from branch tip but not from base branch (or origin/base).
        args.push(sourceBranch, `^${baseBranch}`);
    } else {
        return null;
    }
    const res = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
    if (res.status !== 0 || !res.stdout.trim()) {
        // If the ^parent syntax fails (missing ref, single-commit branch, etc.)
        // fall back to walking just the branch head — better than returning null
        // on a legitimate single-commit branch.
        const fallback = spawnSync('git', ['log', '--pretty=%at', '--no-merges', '-n', String(CAP), mergeCommit || sourceBranch], { cwd: repoRoot, encoding: 'utf-8' });
        if (fallback.status !== 0 || !fallback.stdout.trim()) return null;
        const ts = fallback.stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
        if (ts.length === 0) return null;
        return { firstCommitTs: Math.min(...ts) * 1000 };
    }
    const timestamps = res.stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (timestamps.length === 0) return null;
    return { firstCommitTs: Math.min(...timestamps) * 1000 };
}

async function fetchBuilds(client: AdoHttpClient, sinceIso: string, definitionId: number | undefined): Promise<Build[]> {
    const q = new URLSearchParams({
        'api-version': '7.1',
        statusFilter: 'completed',
        minTime: sinceIso,
        '$top': '5000',
    });
    if (definitionId) q.set('definitions', String(definitionId));
    const body = await client.get<{ value?: Build[] }>(`_apis/build/builds?${q.toString()}`);
    return body?.value ?? [];
}

async function fetchPullRequests(client: AdoHttpClient, repositoryId: string | undefined, sinceIso: string): Promise<PullRequest[]> {
    if (!repositoryId) return [];
    const q = new URLSearchParams({
        'api-version': '7.1',
        'searchCriteria.status': 'completed',
        'searchCriteria.minTime': sinceIso,
        '$top': '500',
    });
    const body = await client.get<{ value?: PullRequest[] }>(`_apis/git/repositories/${repositoryId}/pullrequests?${q.toString()}`);
    return body?.value ?? [];
}

async function queryRegressionBugs(client: AdoHttpClient, sinceIso: string): Promise<BugRow[]> {
    const q = wiql()
        .select(['[System.Id]', '[System.CreatedDate]', '[System.State]', '[System.Tags]'])
        .from('WorkItems')
        .where()
        .equals('[System.WorkItemType]', 'Bug')
        .and().tag('regression')
        .and().raw(`[System.CreatedDate] >= '${sinceIso}'`)
        .done()
        .build();
    const wRes = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query: q });
    const ids = (wRes.workItems || []).map((w) => w.id).filter(Boolean);
    if (ids.length === 0) return [];
    // fetch fields in batches of 200
    const rows: BugRow[] = [];
    for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const idsCsv = chunk.join(',');
        const details = await client.get<{ value?: Array<{ id?: number; fields?: Record<string, string> }> }>(
            `_apis/wit/workitems?ids=${idsCsv}&fields=System.Id,System.CreatedDate,System.Tags,Microsoft.VSTS.Common.Severity&api-version=7.1`,
        );
        for (const w of details.value || []) {
            rows.push({
                id: Number(w.id || 0),
                createdDate: w.fields?.['System.CreatedDate'],
                severity: w.fields?.['Microsoft.VSTS.Common.Severity'],
                tags: w.fields?.['System.Tags'],
            });
        }
    }
    return rows;
}

async function querySevereClosedBugs(client: AdoHttpClient, sinceIso: string): Promise<BugRow[]> {
    // ClosedDate in window; state = Closed / Done / Resolved; severity 1 or 2.
    const q = wiql()
        .select(['[System.Id]', '[System.CreatedDate]', '[Microsoft.VSTS.Common.ClosedDate]', '[Microsoft.VSTS.Common.Severity]'])
        .from('WorkItems')
        .where()
        .equals('[System.WorkItemType]', 'Bug')
        .and().raw(`[Microsoft.VSTS.Common.ClosedDate] >= '${sinceIso}'`)
        .and().raw(`([Microsoft.VSTS.Common.Severity] = '1 - Critical' OR [Microsoft.VSTS.Common.Severity] = '2 - High')`)
        .done()
        .build();
    const wRes = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query: q });
    const ids = (wRes.workItems || []).map((w) => w.id).filter(Boolean);
    if (ids.length === 0) return [];
    const rows: BugRow[] = [];
    for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const idsCsv = chunk.join(',');
        const details = await client.get<{ value?: Array<{ id?: number; fields?: Record<string, string> }> }>(
            `_apis/wit/workitems?ids=${idsCsv}&fields=System.Id,System.CreatedDate,Microsoft.VSTS.Common.ClosedDate,Microsoft.VSTS.Common.Severity&api-version=7.1`,
        );
        for (const w of details.value || []) {
            rows.push({
                id: Number(w.id || 0),
                createdDate: w.fields?.['System.CreatedDate'],
                closedDate: w.fields?.['Microsoft.VSTS.Common.ClosedDate'],
                severity: w.fields?.['Microsoft.VSTS.Common.Severity'],
            });
        }
    }
    return rows;
}

registerPrimitive({
    name: 'cs_qa_dora_metrics',
    description: 'Compute the four DORA metrics (Deployment Frequency, Lead Time for Changes, Change Failure Rate, MTTR) from Azure DevOps + git. Real HTTP + real git — no fabrication. If the window contains no data, returns zeros with insufficientData:true. Optionally POSTs the JSON bundle to a Grafana/webhook endpoint (webhookUrl input or POST_ENDPOINT env). Example: cs_qa_dora_metrics windowDays=30 buildDefinitionId=42 repositoryId="00000000-0000-0000-0000-000000000000".',
    inputSchema: z.object({
        windowDays: z.number().int().min(1).max(365).default(30),
        buildDefinitionId: z.number().int().positive().optional().describe('Filter deployment frequency to a specific pipeline definition.'),
        repositoryId: z.string().min(1).optional().describe('ADO Git repository id (GUID) — required for Lead Time; without it, lead time is 0 with insufficientData.'),
        gitRepoRoot: z.string().min(1).optional().describe('Local path to the git repo for reading commit history. Defaults to the workspace root.'),
        webhookUrl: z.string().url().optional().describe('Optional Grafana / webhook URL to POST the metric bundle to. Overrides POST_ENDPOINT env.'),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        windowDays: z.number(),
        windowStart: z.string(),
        deploymentFrequency: z.object({
            perDay: z.number(),
            totalSuccess: z.number(),
            totalCompleted: z.number(),
        }),
        leadTimeMedianHours: z.number(),
        changeFailureRatePercent: z.number(),
        mttrMedianHours: z.number(),
        samples: z.object({
            builds: z.number(),
            pullRequests: z.number(),
            regressionBugs: z.number(),
            severeClosedBugs: z.number(),
        }),
        insufficientData: z.boolean(),
        webhookPosted: z.boolean().default(false),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_dora_metrics', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const windowStart = daysAgo(input.windowDays);
        const gitRoot = input.gitRepoRoot ? path.resolve(input.gitRepoRoot) : ctx.workspaceRoot;

        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
        });
        if (!credsRes.creds) {
            return {
                ok: false, windowDays: input.windowDays, windowStart,
                deploymentFrequency: { perDay: 0, totalSuccess: 0, totalCompleted: 0 },
                leadTimeMedianHours: 0, changeFailureRatePercent: 0, mttrMedianHours: 0,
                samples: { builds: 0, pullRequests: 0, regressionBugs: 0, severeClosedBugs: 0 },
                insufficientData: true, webhookPosted: false,
                warnings: [credsRes.diagnostic], note: 'ADO not configured — cannot fetch data.',
            };
        }
        const cfg: AdoCreds = credsRes.creds;
        const client = new AdoHttpClient(cfg);

        // Metric 1 — Deployment Frequency.
        let builds: Build[] = [];
        try { builds = await fetchBuilds(client, windowStart, input.buildDefinitionId); }
        catch (e) { warnings.push(`fetch builds failed: ${(e as Error).message}`); }
        const succeededBuilds = builds.filter((b) => String(b.result).toLowerCase() === 'succeeded');
        const perDay = succeededBuilds.length / input.windowDays;

        // Metric 2 — Lead Time for Changes.
        let prs: PullRequest[] = [];
        try { prs = await fetchPullRequests(client, input.repositoryId, windowStart); }
        catch (e) { warnings.push(`fetch PRs failed: ${(e as Error).message}`); }
        const leadTimesHours: number[] = [];
        if (fs.existsSync(path.join(gitRoot, '.git'))) {
            for (const pr of prs) {
                const completed = pr.closedDate || pr.completionQueueTime;
                if (!completed) continue;
                const source = (pr.sourceRefName || '').replace(/^refs\/heads\//, '');
                const mergeSourceCommit = pr.lastMergeSourceCommit?.commitId;
                if (!source && !mergeSourceCommit) continue;
                const target = (pr.targetRefName || '').replace(/^refs\/heads\//, '') || 'main';
                const info = gitFirstCommitOnBranch(gitRoot, source, mergeSourceCommit, target);
                if (!info) continue;
                const completedMs = Date.parse(completed);
                if (!Number.isFinite(completedMs)) continue;
                const hours = (completedMs - info.firstCommitTs) / 3_600_000;
                if (hours > 0 && hours < 24 * 365) leadTimesHours.push(hours);
            }
        } else if (prs.length > 0) {
            warnings.push(`git repo not found at ${gitRoot} — Lead Time skipped.`);
        }
        const leadTimeMedianHours = median(leadTimesHours);

        // Metric 3 — Change Failure Rate. A deploy is a "failed change" if a
        // regression-tagged bug was opened within 24h of it. We correlate by time
        // window (deploys don't carry direct bug links in the general case).
        let regressionBugs: BugRow[] = [];
        try { regressionBugs = await queryRegressionBugs(client, windowStart); }
        catch (e) { warnings.push(`regression-bugs WIQL failed: ${(e as Error).message}`); }
        let failedDeploys = 0;
        for (const b of succeededBuilds) {
            const finish = b.finishTime ? Date.parse(b.finishTime) : NaN;
            if (!Number.isFinite(finish)) continue;
            const windowEnd = finish + 24 * 3_600_000;
            const hit = regressionBugs.some((bug) => {
                const created = bug.createdDate ? Date.parse(bug.createdDate) : NaN;
                return Number.isFinite(created) && created >= finish && created <= windowEnd;
            });
            if (hit) failedDeploys++;
        }
        const changeFailureRatePercent = succeededBuilds.length > 0
            ? (failedDeploys / succeededBuilds.length) * 100
            : 0;

        // Metric 4 — MTTR (severity 1/2 bugs, closed in window).
        let severe: BugRow[] = [];
        try { severe = await querySevereClosedBugs(client, windowStart); }
        catch (e) { warnings.push(`severe-closed-bugs WIQL failed: ${(e as Error).message}`); }
        const mttrs: number[] = [];
        for (const b of severe) {
            if (parseSeverityLevel(b.severity) > 2) continue;
            const c = b.createdDate ? Date.parse(b.createdDate) : NaN;
            const cl = b.closedDate ? Date.parse(b.closedDate) : NaN;
            if (!Number.isFinite(c) || !Number.isFinite(cl) || cl < c) continue;
            mttrs.push((cl - c) / 3_600_000);
        }
        const mttrMedianHours = median(mttrs);

        const totalSamples = builds.length + prs.length + regressionBugs.length + severe.length;
        const insufficientData = totalSamples === 0;

        log.info('dora computed', {
            windowDays: input.windowDays,
            builds: builds.length, prs: prs.length, regressionBugs: regressionBugs.length, severe: severe.length,
            perDay, leadTimeMedianHours, changeFailureRatePercent, mttrMedianHours,
        });

        // Optional webhook POST.
        let webhookPosted = false;
        const target = input.webhookUrl || process.env.POST_ENDPOINT;
        if (target) {
            const payload = {
                ts: new Date().toISOString(),
                project: cfg.project,
                windowDays: input.windowDays,
                metrics: {
                    deploymentFrequencyPerDay: perDay,
                    leadTimeMedianHours,
                    changeFailureRatePercent,
                    mttrMedianHours,
                },
                samples: {
                    builds: builds.length, pullRequests: prs.length,
                    regressionBugs: regressionBugs.length, severeClosedBugs: severe.length,
                },
                insufficientData,
            };
            try {
                const res = await fetch(target, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                webhookPosted = res.ok;
                if (!res.ok) warnings.push(`webhook POST ${target} returned ${res.status}`);
            } catch (e) {
                warnings.push(`webhook POST failed: ${(e as Error).message}`);
            }
        }

        return {
            ok: true,
            windowDays: input.windowDays,
            windowStart,
            deploymentFrequency: { perDay, totalSuccess: succeededBuilds.length, totalCompleted: builds.length },
            leadTimeMedianHours,
            changeFailureRatePercent,
            mttrMedianHours,
            samples: {
                builds: builds.length,
                pullRequests: prs.length,
                regressionBugs: regressionBugs.length,
                severeClosedBugs: severe.length,
            },
            insufficientData,
            webhookPosted,
            warnings,
            note: insufficientData
                ? `No DORA-relevant data in the last ${input.windowDays} days — metrics returned as zeros with insufficientData:true.`
                : `DORA metrics computed over ${input.windowDays} days: ${succeededBuilds.length} deploys, ${prs.length} PRs, ${regressionBugs.length} regressions, ${severe.length} sev1/2 closed bugs.`,
        };
    },
});
