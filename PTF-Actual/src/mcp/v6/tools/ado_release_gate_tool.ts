/**
 * cs_qa_release_gate — HTTP-callable release gate.
 *
 * Given a pipeline run + iteration + story ids + SLA profile, compute a
 * verdict (`proceed` | `warn` | `block`) from these signals:
 *   1. Acceptance-criteria coverage % (from wiql-derived story AC vs the
 *      @TestCaseId tags on feature files) — under threshold ⇒ block.
 *   2. Test pass rate for the iteration (last N test runs) — under
 *      threshold ⇒ block; between threshold and warn-band ⇒ warn.
 *   3. Open regression bug count (WIQL: Bug + tag "regression" + state<>Closed)
 *   4. Perf regression (from an optional analyze-perf result JSON on disk;
 *      any severity != info ⇒ block).
 *   5. Security bug open Sev 1/2 count — any ⇒ block.
 *
 * When `serve:true`, boots a real Node http server on `PORT` env (default
 * 7391) exposing `POST /gate` — accepts the same JSON body, returns the
 * verdict. Server is NEVER started at import time.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { wiql } from './_helpers/wiql_builder';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

// -----------------------------------------------------------------------------
// AC-checkpoint-backed coverage.
// -----------------------------------------------------------------------------

interface AcCheckpoint {
    storyId: number;
    acs: Array<{ index: number; tag: string; text: string }>;
}

function loadAcCheckpoint(workspaceRoot: string, storyId: number): AcCheckpoint | null {
    const p = path.join(workspaceRoot, '.cs-qa', 'run-state', `story-${storyId}-acs.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as AcCheckpoint; } catch { return null; }
}

/**
 * Walk `test/` for every .feature file and collect the set of @ac<N> tags used.
 * Matches both `@ac<n>` and `@AC<n>`.
 */
function collectImplementedAcTagsFromFeatures(workspaceRoot: string): Set<string> {
    const acTags = new Set<string>();
    const testRoot = path.join(workspaceRoot, 'test');
    if (!fs.existsSync(testRoot)) return acTags;
    const stack: string[] = [testRoot];
    const AC_TAG_RE = /@ac(\d+)/gi;
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.git')) continue;
            const full = path.join(cur, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.feature')) {
                try {
                    const content = fs.readFileSync(full, 'utf-8');
                    let m: RegExpExecArray | null;
                    AC_TAG_RE.lastIndex = 0;
                    while ((m = AC_TAG_RE.exec(content)) !== null) acTags.add(`ac${m[1]}`);
                } catch { /* ignore per-file errors */ }
            }
        }
    }
    return acTags;
}

const SlaProfileSchema = z.object({
    minAcCoveragePercent: z.number().min(0).max(100).default(95),
    minTestPassPercent: z.number().min(0).max(100).default(98),
    testPassWarnPercent: z.number().min(0).max(100).default(95),
    maxOpenRegressionBugs: z.number().int().min(0).default(0),
    maxOpenSevereSecurityBugs: z.number().int().min(0).default(0),
    perfMustPass: z.boolean().default(true),
});

type SlaProfile = z.infer<typeof SlaProfileSchema>;

interface Signal {
    id: string;
    label: string;
    value: number | string;
    threshold: number | string;
    pass: boolean;
    isBlocker: boolean;
    isWarning: boolean;
}

interface Verdict {
    verdict: 'proceed' | 'warn' | 'block';
    overallScore: number;
    signals: Signal[];
    blockers: string[];
    warnings: string[];
}

interface StoryCoverage {
    storyId: number;
    totalAcs: number;
    coveredAcs: number;
    uncoveredAcs: number[];
    coveragePercent: number;
    source: 'checkpoint' | 'naive-linked-relations';
}

interface AcCoverage {
    percent: number;
    totalAcs: number;
    coveredAcs: number;
    perStory: StoryCoverage[];
    warnings: string[];
    naive: boolean;
}

/**
 * Real AC coverage:
 *   1. For every storyId, read `.cs-qa/run-state/story-<id>-acs.json` — that is
 *      the SOURCE OF TRUTH for how many ACs the story has and their text
 *      (populated by cs_qa_ado_read for the story).
 *   2. Cross-reference the workspace `test/**\/*.feature` files for `@ac<n>` /
 *      `@AC<n>` tags — an AC is covered when its index appears in ANY scenario tag.
 *   3. Fall back to the old naive "linked-relation count == AC count" only when
 *      no checkpoint exists, and mark the result naive:true so the caller can
 *      surface it as a warning.
 *
 * All story ids are processed (previously a silent 200-cap sliced away the tail);
 * chunking via bulkExecute keeps request size safe.
 */
async function computeAcCoverage(client: AdoHttpClient, storyIds: number[], workspaceRoot: string): Promise<AcCoverage> {
    if (storyIds.length === 0) {
        return { percent: 100, totalAcs: 0, coveredAcs: 0, perStory: [], warnings: [], naive: false };
    }
    const warnings: string[] = [];
    const implementedAcTags = collectImplementedAcTagsFromFeatures(workspaceRoot);

    // Split storyIds into checkpoint-backed vs. naive.
    const checkpointStories: Array<{ storyId: number; ck: AcCheckpoint }> = [];
    const naiveIds: number[] = [];
    for (const id of storyIds) {
        const ck = loadAcCheckpoint(workspaceRoot, id);
        if (ck && Array.isArray(ck.acs) && ck.acs.length > 0) checkpointStories.push({ storyId: id, ck });
        else naiveIds.push(id);
    }

    const perStory: StoryCoverage[] = [];
    let totalAcs = 0;
    let coveredAcs = 0;

    // Checkpoint-backed stories — no ADO round-trip needed for these.
    for (const { storyId, ck } of checkpointStories) {
        const total = ck.acs.length;
        const uncovered: number[] = [];
        let covered = 0;
        for (const ac of ck.acs) {
            if (implementedAcTags.has(`ac${ac.index}`)) covered++;
            else uncovered.push(ac.index);
        }
        totalAcs += total;
        coveredAcs += covered;
        perStory.push({
            storyId,
            totalAcs: total,
            coveredAcs: covered,
            uncoveredAcs: uncovered,
            coveragePercent: total === 0 ? 100 : (covered / total) * 100,
            source: 'checkpoint',
        });
    }

    // Naive-fallback stories — process ALL of them via bulkExecute (200-per-chunk,
    // concurrency 4). Previously a silent `.slice(0, 200)` capped the tail.
    let naiveFallbackUsed = false;
    if (naiveIds.length > 0) {
        naiveFallbackUsed = true;
        warnings.push(`[info] AC coverage: ${naiveIds.length} story/ies had no AC checkpoint at .cs-qa/run-state/story-<id>-acs.json — falling back to naive "linked-relation count" heuristic for those. Run cs_qa_ado_read for each story to persist a checkpoint.`);
        const bulk = await bulkExecute<number, StoryCoverage>(naiveIds, {
            chunkSize: 200,
            concurrency: 4,
            workFn: async (chunk) => {
                const idsCsv = chunk.join(',');
                const details = await client.get<{ value?: Array<{ id?: number; fields?: Record<string, string>; relations?: Array<{ rel?: string; url?: string }> }> }>(
                    `_apis/wit/workitems?ids=${idsCsv}&fields=System.Id,Microsoft.VSTS.Common.AcceptanceCriteria&$expand=relations&api-version=7.1`,
                );
                const rows: StoryCoverage[] = [];
                for (const w of details.value || []) {
                    const acHtml = w.fields?.['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
                    const cleaned = acHtml.replace(/<[^>]+>/g, '\n');
                    const items = cleaned.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 4);
                    const total = items.length;
                    const testedBy = (w.relations || []).filter((r) => (r.rel || '').includes('Tests') || (r.rel || '').includes('Related')).length;
                    const covered = Math.min(total, testedBy);
                    rows.push({
                        storyId: Number(w.id ?? 0),
                        totalAcs: total,
                        coveredAcs: covered,
                        uncoveredAcs: [],
                        coveragePercent: total === 0 ? 100 : (covered / total) * 100,
                        source: 'naive-linked-relations',
                    });
                }
                return rows;
            },
            onChunkError: (err, chunk) => {
                warnings.push(`AC coverage chunk (ids ${chunk[0]}..${chunk[chunk.length - 1]}) failed: ${err.message.slice(0, 200)}`);
            },
        });
        if (bulk.failedChunks > 0) {
            warnings.push(`AC coverage: ${bulk.failedChunks} chunk(s) failed — partial coverage percent may under-count.`);
        }
        for (const row of bulk.ok) {
            totalAcs += row.totalAcs;
            coveredAcs += row.coveredAcs;
            perStory.push(row);
        }
    }

    const percent = totalAcs === 0 ? 100 : (coveredAcs / totalAcs) * 100;
    return { percent, totalAcs, coveredAcs, perStory, warnings, naive: naiveFallbackUsed };
}

interface TestPassRate {
    percent: number;
    total: number;
    passed: number;
    failed: number;
    iterationScoped: boolean;
    warnings: string[];
}

async function computeTestPassRate(client: AdoHttpClient, iterationPath: string, lastN: number): Promise<TestPassRate> {
    const warnings: string[] = [];
    // ADO's `_apis/test/runs` does NOT accept an iteration-path filter directly —
    // to scope to an iteration we'd need to join through the build (System.IterationPath
    // tag on the pipeline definition) and then filter runs by buildUri. That join
    // is expensive and often inaccurate on multi-stage pipelines that fan out.
    //
    // Rather than silently return global data (misrepresenting the gate as
    // iteration-scoped), we compute over the global run set and flag
    // iterationScoped:false when an iterationPath was requested — the caller
    // surfaces this as a warning so operators know the pass-rate is broader
    // than the iteration they asked about.
    const list = await client.get<{ value?: Array<{ id: number; totalTests?: number; passedTests?: number; unanalyzedTests?: number; incompleteTests?: number; state?: string }> }>(
        `_apis/test/runs?$top=${lastN}&api-version=7.1`,
    );
    let total = 0, passed = 0;
    for (const r of list.value || []) {
        total += Number(r.totalTests || 0);
        passed += Number(r.passedTests || 0);
    }
    const failed = Math.max(0, total - passed);
    const percent = total === 0 ? 100 : (passed / total) * 100;
    const iterationScoped = false; // never true today — kept for future tightening
    if (iterationPath && iterationPath.trim().length > 0) {
        warnings.push(`[info] Test pass rate: ADO REST does not support an iteration-path filter on _apis/test/runs — pass rate covers the last ${lastN} runs GLOBALLY, not just iteration "${iterationPath}". iterationScoped:false.`);
    }
    return { percent, total, passed, failed, iterationScoped, warnings };
}

async function countOpenRegressionBugs(client: AdoHttpClient): Promise<number> {
    const q = wiql()
        .select(['[System.Id]'])
        .from('WorkItems')
        .where()
        .equals('[System.WorkItemType]', 'Bug')
        .and().tag('regression')
        .and().notEquals('[System.State]', 'Closed')
        .and().notEquals('[System.State]', 'Done')
        .and().notEquals('[System.State]', 'Resolved')
        .done()
        .build();
    const res = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query: q });
    return (res.workItems || []).length;
}

async function countOpenSevereSecurityBugs(client: AdoHttpClient): Promise<number> {
    const q = wiql()
        .select(['[System.Id]'])
        .from('WorkItems')
        .where()
        .equals('[System.WorkItemType]', 'Bug')
        .and().tag('security')
        .and().raw(`([Microsoft.VSTS.Common.Severity] = '1 - Critical' OR [Microsoft.VSTS.Common.Severity] = '2 - High')`)
        .and().notEquals('[System.State]', 'Closed')
        .and().notEquals('[System.State]', 'Done')
        .and().notEquals('[System.State]', 'Resolved')
        .done()
        .build();
    const res = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query: q });
    return (res.workItems || []).length;
}

function readPerfVerdict(pathAbs: string): { hasResult: boolean; regressions: number; verdict: string } {
    if (!fs.existsSync(pathAbs)) return { hasResult: false, regressions: 0, verdict: 'unknown' };
    try {
        const j = JSON.parse(fs.readFileSync(pathAbs, 'utf-8')) as { verdict?: string; regressions?: Array<{ severity?: string }> };
        const regs = (j.regressions || []).filter((r) => r.severity && r.severity !== 'info').length;
        return { hasResult: true, regressions: regs, verdict: String(j.verdict || 'unknown') };
    } catch {
        return { hasResult: false, regressions: 0, verdict: 'parse-failed' };
    }
}

async function computeVerdict(
    creds: AdoCreds,
    pipelineRunId: number | undefined,
    iterationPath: string,
    storyIds: number[],
    sla: SlaProfile,
    perfResultPath: string | undefined,
    workspaceRoot: string,
): Promise<Verdict> {
    const client = new AdoHttpClient(creds);
    const signals: Signal[] = [];
    const blockers: string[] = [];
    const warnings: string[] = [];

    // 1) AC coverage.
    let acCov: AcCoverage = { percent: 100, totalAcs: 0, coveredAcs: 0, perStory: [], warnings: [], naive: false };
    try { acCov = await computeAcCoverage(client, storyIds, workspaceRoot); }
    catch (e) { warnings.push(`AC coverage compute failed: ${(e as Error).message}`); }
    warnings.push(...acCov.warnings);
    const acPass = acCov.percent >= sla.minAcCoveragePercent;
    signals.push({
        id: 'ac-coverage',
        label: `AC coverage % (${acCov.coveredAcs}/${acCov.totalAcs})${acCov.naive ? ' [naive]' : ''}`,
        value: Number(acCov.percent.toFixed(2)),
        threshold: `>= ${sla.minAcCoveragePercent}`,
        pass: acPass,
        isBlocker: !acPass,
        isWarning: false,
    });
    if (!acPass) blockers.push(`AC coverage ${acCov.percent.toFixed(1)}% < ${sla.minAcCoveragePercent}%.`);

    // 2) Test pass rate.
    let pr: TestPassRate = { percent: 100, total: 0, passed: 0, failed: 0, iterationScoped: false, warnings: [] };
    try { pr = await computeTestPassRate(client, iterationPath, 10); }
    catch (e) { warnings.push(`test pass rate compute failed: ${(e as Error).message}`); }
    warnings.push(...pr.warnings);
    const passBlock = pr.percent < sla.minTestPassPercent;
    const passWarn = !passBlock && pr.percent < sla.testPassWarnPercent;
    signals.push({
        id: 'test-pass-rate',
        label: `Test pass % (${pr.passed}/${pr.total})`,
        value: Number(pr.percent.toFixed(2)),
        threshold: `>= ${sla.minTestPassPercent} (warn @ ${sla.testPassWarnPercent})`,
        pass: !passBlock,
        isBlocker: passBlock,
        isWarning: passWarn,
    });
    if (passBlock) blockers.push(`Test pass ${pr.percent.toFixed(1)}% < ${sla.minTestPassPercent}%.`);
    else if (passWarn) warnings.push(`Test pass ${pr.percent.toFixed(1)}% below warn band ${sla.testPassWarnPercent}%.`);

    // 3) Open regression bugs.
    let reg = 0;
    try { reg = await countOpenRegressionBugs(client); }
    catch (e) { warnings.push(`open regression bugs query failed: ${(e as Error).message}`); }
    const regPass = reg <= sla.maxOpenRegressionBugs;
    signals.push({
        id: 'open-regression-bugs',
        label: 'Open regression bugs',
        value: reg,
        threshold: `<= ${sla.maxOpenRegressionBugs}`,
        pass: regPass,
        isBlocker: !regPass,
        isWarning: false,
    });
    if (!regPass) blockers.push(`${reg} open regression bug(s) exceed max ${sla.maxOpenRegressionBugs}.`);

    // 4) Perf regression.
    if (perfResultPath) {
        const abs = path.isAbsolute(perfResultPath) ? perfResultPath : path.join(workspaceRoot, perfResultPath);
        const perf = readPerfVerdict(abs);
        const perfPass = perf.hasResult ? perf.regressions === 0 : true;
        signals.push({
            id: 'perf-regression',
            label: `Perf verdict (${perf.hasResult ? perf.verdict : 'no result file'})`,
            value: perf.regressions,
            threshold: '0 non-info regressions',
            pass: perfPass,
            isBlocker: sla.perfMustPass && !perfPass,
            isWarning: !sla.perfMustPass && !perfPass,
        });
        if (sla.perfMustPass && !perfPass) blockers.push(`${perf.regressions} perf regression(s) found — verdict ${perf.verdict}.`);
    }

    // 5) Sev 1/2 security bugs.
    let sec = 0;
    try { sec = await countOpenSevereSecurityBugs(client); }
    catch (e) { warnings.push(`open severe security bugs query failed: ${(e as Error).message}`); }
    const secPass = sec <= sla.maxOpenSevereSecurityBugs;
    signals.push({
        id: 'open-severe-security-bugs',
        label: 'Open Sev1/Sev2 security bugs',
        value: sec,
        threshold: `<= ${sla.maxOpenSevereSecurityBugs}`,
        pass: secPass,
        isBlocker: !secPass,
        isWarning: false,
    });
    if (!secPass) blockers.push(`${sec} open severe security bug(s) exceed max ${sla.maxOpenSevereSecurityBugs}.`);

    const passing = signals.filter((s) => s.pass).length;
    const overallScore = Math.round((passing / signals.length) * 100);
    const signalWarnings = warnings.filter((w) => !w.startsWith('[info]'));
    const verdict: Verdict['verdict'] = blockers.length > 0 ? 'block' : signalWarnings.length > 0 ? 'warn' : 'proceed';
    // If pipelineRunId supplied, decorate the label so the caller can correlate.
    if (pipelineRunId) signals.unshift({
        id: 'pipeline-run',
        label: 'Pipeline run id',
        value: pipelineRunId, threshold: '(reference)', pass: true, isBlocker: false, isWarning: false,
    });
    return { verdict, overallScore, signals, blockers, warnings };
}

// -----------------------------------------------------------------------------
// HTTP server (opt-in — never started at import).
// -----------------------------------------------------------------------------

const RUNNING_SERVERS = new Map<number, http.Server>();

interface ServeOptions {
    port: number;
    bindHost: string;
    authToken: string | null;
    workspaceRoot: string;
    log: ReturnType<typeof createLogger>;
    resolvedCredsProvider: () => AdoCreds | null;
}

function startServer(opts: ServeOptions): { port: number; server: http.Server } {
    const { port, bindHost, authToken, workspaceRoot, log, resolvedCredsProvider } = opts;
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/gate') {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found — POST /gate is the only endpoint' }));
            return;
        }
        // Bearer-token auth when configured. Without it, the server accepts any
        // caller — which is why the default bind is 127.0.0.1 rather than 0.0.0.0.
        if (authToken) {
            const authHeader = String(req.headers['authorization'] || '');
            const expected = `Bearer ${authToken}`;
            // Constant-time compare to avoid trivial timing sidechannels.
            const ok = authHeader.length === expected.length && (() => {
                let diff = 0;
                for (let i = 0; i < expected.length; i++) diff |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i);
                return diff === 0;
            })();
            if (!ok) {
                res.statusCode = 401;
                res.setHeader('WWW-Authenticate', 'Bearer');
                res.end(JSON.stringify({ error: 'unauthorized — POST /gate requires "Authorization: Bearer <authToken>".' }));
                return;
            }
        }
        try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const body = Buffer.concat(chunks).toString('utf-8');
            const json = JSON.parse(body) as Record<string, unknown>;
            const creds = resolvedCredsProvider();
            if (!creds) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'ADO creds not resolvable on server side' }));
                return;
            }
            const sla = SlaProfileSchema.parse(json.slaProfile || {});
            const verdict = await computeVerdict(
                creds,
                typeof json.pipelineRunId === 'number' ? json.pipelineRunId : undefined,
                String(json.iterationPath || ''),
                Array.isArray(json.storyIds) ? (json.storyIds as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0) : [],
                sla,
                typeof json.perfResultPath === 'string' ? json.perfResultPath : undefined,
                workspaceRoot,
            );
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 200;
            res.end(JSON.stringify(verdict));
            log.info('gate served', { verdict: verdict.verdict, score: verdict.overallScore });
        } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: (e as Error).message }));
        }
    });
    server.listen(port, bindHost);
    log.info('release-gate server up', { port, bindHost, authEnabled: authToken !== null });
    return { port, server };
}

function escapeHtml(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderReleaseReportMarkdown(v: Verdict, input: { iterationPath?: string; storyIds?: number[]; pipelineRunId?: number }): string {
    const lines: string[] = [];
    lines.push(`# Release report`);
    lines.push('');
    lines.push(`*Generated: ${new Date().toISOString()}*`);
    if (input.iterationPath) lines.push(`- Iteration: \`${input.iterationPath}\``);
    if (input.pipelineRunId) lines.push(`- Pipeline run: ${input.pipelineRunId}`);
    if (input.storyIds && input.storyIds.length > 0) lines.push(`- Stories: ${input.storyIds.join(', ')}`);
    lines.push('');
    lines.push(`## Verdict: **${v.verdict.toUpperCase()}**`);
    lines.push('');
    lines.push(`Overall score: **${v.overallScore}/100**.`);
    lines.push('');
    if (v.blockers.length > 0) {
        lines.push('## Blockers');
        lines.push('');
        for (const b of v.blockers) lines.push(`- ${b}`);
        lines.push('');
    }
    lines.push('## Signals');
    lines.push('');
    lines.push('| Signal | Value | Threshold | Pass |');
    lines.push('|---|---|---|---|');
    for (const s of v.signals) lines.push(`| ${s.label} | ${s.value} | ${s.threshold} | ${s.pass ? 'yes' : 'NO'} |`);
    lines.push('');
    if (v.warnings.length > 0) {
        lines.push('## Warnings');
        lines.push('');
        for (const w of v.warnings) lines.push(`- ${w}`);
        lines.push('');
    }
    return lines.join('\n') + '\n';
}

function renderReleaseReportHtml(v: Verdict, input: { iterationPath?: string; storyIds?: number[]; pipelineRunId?: number }): string {
    const rows = v.signals.map((s) => `<tr><td>${escapeHtml(s.label)}</td><td>${escapeHtml(String(s.value))}</td><td>${escapeHtml(String(s.threshold))}</td><td>${s.pass ? 'yes' : '<b>NO</b>'}</td></tr>`).join('');
    const blockers = v.blockers.map((b) => `<li>${escapeHtml(b)}</li>`).join('');
    const warns = v.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    const badgeColor = v.verdict === 'proceed' ? '#2ecc71' : v.verdict === 'warn' ? '#f39c12' : '#e74c3c';
    return `<!doctype html><html><head><meta charset="utf-8"><title>Release report ${escapeHtml(input.iterationPath || '')}</title>
<style>body{font-family:sans-serif;margin:2em;color:#222}table{border-collapse:collapse;margin:1em 0}th,td{padding:6px 12px;border:1px solid #ccc}.badge{display:inline-block;padding:8px 16px;color:#fff;border-radius:6px;font-weight:bold;background:${badgeColor}}</style>
</head><body>
<h1>Release report</h1>
<p>Generated: ${escapeHtml(new Date().toISOString())}</p>
${input.iterationPath ? '<p>Iteration: <code>' + escapeHtml(input.iterationPath) + '</code></p>' : ''}
${input.pipelineRunId ? '<p>Pipeline run: ' + input.pipelineRunId + '</p>' : ''}
${input.storyIds && input.storyIds.length > 0 ? '<p>Stories: ' + escapeHtml(input.storyIds.join(', ')) + '</p>' : ''}
<h2>Verdict: <span class="badge">${escapeHtml(v.verdict.toUpperCase())}</span></h2>
<p>Overall score: <b>${v.overallScore}/100</b></p>
${blockers ? '<h3>Blockers</h3><ul>' + blockers + '</ul>' : ''}
<h3>Signals</h3>
<table><thead><tr><th>Signal</th><th>Value</th><th>Threshold</th><th>Pass</th></tr></thead><tbody>${rows}</tbody></table>
${warns ? '<h3>Warnings</h3><ul>' + warns + '</ul>' : ''}
</body></html>`;
}

export function _stopServerForTests(port: number): void {
    const s = RUNNING_SERVERS.get(port);
    if (s) { try { s.close(); } catch { /* ignore */ } RUNNING_SERVERS.delete(port); }
}

registerPrimitive({
    name: 'cs_qa_release_gate',
    description: 'HTTP-callable release gate. Computes a verdict (proceed/warn/block) from 5 signals: AC coverage %, test pass rate, open regression bugs, perf regressions, open severe security bugs. When serve:true, boots a Node HTTP server on PORT env (default 7391) exposing POST /gate — accepts the same JSON body and returns the verdict. Server is opt-in — never started at import time. Example: cs_qa_release_gate serve:true port:7500 (start server); cs_qa_release_gate storyIds:[123] iterationPath:"Proj\\Sprint 1" (one-shot verdict).',
    inputSchema: z.object({
        verb: z.enum(['evaluate', 'report', 'sign-off']).default('evaluate').describe('evaluate = compute verdict (default; existing behavior). report = generate HTML+MD release report from an evaluate. sign-off = mark a Story as QA-signed-off in ADO (two-phase confirm).'),
        pipelineRunId: z.number().int().positive().optional(),
        iterationPath: z.string().default(''),
        storyIds: z.array(z.number().int().positive()).default([]),
        slaProfile: SlaProfileSchema.partial().optional(),
        perfResultPath: z.string().optional(),
        serve: z.boolean().default(false),
        port: z.number().int().min(1024).max(65535).optional(),
        bindHost: z.string().min(1).default('127.0.0.1').describe('Network interface for the release-gate HTTP server. Defaults to 127.0.0.1 (loopback-only). Set explicitly to 0.0.0.0 to accept off-host callers — only do that when also setting authToken.'),
        authToken: z.string().min(8).optional().describe('When set, POST /gate requires "Authorization: Bearer <authToken>" — otherwise the server responds 401. Required in practice for any non-loopback bind.'),
        stopServer: z.boolean().default(false).describe('If true and a server is running for the port, stop it and return.'),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
        // report verb inputs
        reportFormats: z.array(z.enum(['md', 'html'])).default(['md', 'html']).describe('report verb only — which report formats to write.'),
        // sign-off verb inputs
        storyId: z.number().int().positive().optional().describe('sign-off verb — target Story id.'),
        signOffBy: z.string().min(1).optional().describe('sign-off verb — display name / email of the signer for the history comment.'),
        comment: z.string().min(1).optional().describe('sign-off verb — history comment recording the sign-off.'),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        mode: z.enum(['one-shot', 'served', 'stopped', 'report', 'sign-off']),
        verb: z.string().optional(),
        verdict: z.enum(['proceed', 'warn', 'block']).optional(),
        overallScore: z.number().optional(),
        signals: z.array(z.object({
            id: z.string(), label: z.string(),
            value: z.union([z.number(), z.string()]),
            threshold: z.union([z.number(), z.string()]),
            pass: z.boolean(), isBlocker: z.boolean(), isWarning: z.boolean(),
        })).default([]),
        blockers: z.array(z.string()).default([]),
        warnings: z.array(z.string()).default([]),
        serverPort: z.number().optional(),
        serverUrl: z.string().optional(),
        reportPaths: z.object({ md: z.string().optional(), html: z.string().optional() }).optional(),
        signOff: z.object({ storyId: z.number(), tag: z.string(), historyAppended: z.boolean(), requiresConfirmation: z.boolean().optional(), confirmationHint: z.string().optional() }).optional(),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_release_gate', { workspaceRoot: ctx.workspaceRoot });
        const sla = SlaProfileSchema.parse(input.slaProfile || {});
        const port = input.port ?? Number(process.env.PORT ?? '7391');

        // ---- verb: sign-off (two-phase confirm gate) ----
        if (input.verb === 'sign-off') {
            if (!input.storyId) {
                return { ok: false, mode: 'sign-off' as const, verb: 'sign-off', signals: [], blockers: [], warnings: ['sign-off requires storyId'], note: 'sign-off requires storyId' };
            }
            const isConfirmed = (input as { confirmed?: boolean }).confirmed === true;
            if (!isConfirmed) {
                return {
                    ok: true, mode: 'sign-off' as const, verb: 'sign-off', signals: [], blockers: [], warnings: [],
                    signOff: {
                        storyId: input.storyId, tag: 'qa-signed-off', historyAppended: false,
                        requiresConfirmation: true,
                        confirmationHint: `Will mark ADO Story ${input.storyId} as QA-signed-off (Microsoft.VSTS.Common.ClosedReason='QA Sign-off', add tag 'qa-signed-off', append System.History). No write performed. Retry the SAME call with confirmed:true.`,
                    },
                    note: 'requires confirmation — retry with confirmed:true',
                };
            }
            const credsRes = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
            if (!credsRes.creds) {
                return { ok: false, mode: 'sign-off' as const, verb: 'sign-off', signals: [], blockers: [], warnings: [credsRes.diagnostic], note: 'ADO not configured — cannot sign off.' };
            }
            try {
                const client = new AdoHttpClient(credsRes.creds);
                // Preserve existing tags: fetch, split, add tag if missing.
                const wi = await client.get<{ fields?: Record<string, unknown> }>(`_apis/wit/workitems/${input.storyId}?api-version=7.0&fields=System.Tags`);
                const existingTags = String(wi.fields?.['System.Tags'] || '').split(';').map((s) => s.trim()).filter(Boolean);
                if (!existingTags.includes('qa-signed-off')) existingTags.push('qa-signed-off');
                const historyBody = `<p><b>QA sign-off</b>${input.signOffBy ? ` by <b>${escapeHtml(input.signOffBy)}</b>` : ''} at ${new Date().toISOString()}.${input.comment ? ' — ' + escapeHtml(input.comment) : ''}</p>`;
                const patch: Array<Record<string, unknown>> = [
                    { op: 'add', path: '/fields/System.Tags', value: existingTags.join('; ') },
                    { op: 'add', path: '/fields/Microsoft.VSTS.Common.ClosedReason', value: 'QA Sign-off' },
                    { op: 'add', path: '/fields/System.History', value: historyBody },
                ];
                await client.patch(`_apis/wit/workitems/${input.storyId}?api-version=7.0`, patch);
                log.info('story signed off', { storyId: input.storyId, signOffBy: input.signOffBy });
                return {
                    ok: true, mode: 'sign-off' as const, verb: 'sign-off', signals: [], blockers: [], warnings: [],
                    signOff: { storyId: input.storyId, tag: 'qa-signed-off', historyAppended: true },
                    note: `Story ${input.storyId} marked QA-signed-off (tag added, ClosedReason set, history appended).`,
                };
            } catch (e) {
                return { ok: false, mode: 'sign-off' as const, verb: 'sign-off', signals: [], blockers: [], warnings: [(e as Error).message], note: `sign-off failed: ${(e as Error).message}` };
            }
        }

        // ---- verb: report (evaluate + emit human-readable release report) ----
        if (input.verb === 'report') {
            const credsRes = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
            if (!credsRes.creds) {
                return { ok: false, mode: 'report' as const, verb: 'report', signals: [], blockers: [], warnings: [credsRes.diagnostic], note: 'ADO not configured — cannot generate report.' };
            }
            const verdict = await computeVerdict(credsRes.creds, input.pipelineRunId, input.iterationPath, input.storyIds, sla, input.perfResultPath, ctx.workspaceRoot);
            const reportDir = path.join(ctx.workspaceRoot, '.cs-qa', 'release-reports');
            fs.mkdirSync(reportDir, { recursive: true });
            const iterSlug = (input.iterationPath || 'no-iteration').replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const base = `${iterSlug || 'iter'}-${ts}`;
            const paths: { md?: string; html?: string } = {};
            const md = renderReleaseReportMarkdown(verdict, input);
            const html = renderReleaseReportHtml(verdict, input);
            if (input.reportFormats.includes('md')) {
                paths.md = path.join(reportDir, `${base}.md`);
                try { fs.writeFileSync(paths.md, md, 'utf-8'); }
                catch (e) { verdict.warnings.push(`.md write failed: ${(e as Error).message}`); }
            }
            if (input.reportFormats.includes('html')) {
                paths.html = path.join(reportDir, `${base}.html`);
                try { fs.writeFileSync(paths.html, html, 'utf-8'); }
                catch (e) { verdict.warnings.push(`.html write failed: ${(e as Error).message}`); }
            }
            log.info('release report generated', { verdict: verdict.verdict, paths });
            return {
                ok: true,
                mode: 'report' as const,
                verb: 'report',
                verdict: verdict.verdict,
                overallScore: verdict.overallScore,
                signals: verdict.signals,
                blockers: verdict.blockers,
                warnings: verdict.warnings,
                reportPaths: paths,
                note: `release report: verdict=${verdict.verdict} score=${verdict.overallScore}/100. Written to ${Object.values(paths).join(', ')}.`,
            };
        }

        if (input.stopServer) {
            const s = RUNNING_SERVERS.get(port);
            if (!s) return { ok: true, mode: 'stopped' as const, signals: [], blockers: [], warnings: [], note: `no server running on port ${port}` };
            try { s.close(); } catch { /* ignore */ }
            RUNNING_SERVERS.delete(port);
            return { ok: true, mode: 'stopped' as const, signals: [], blockers: [], warnings: [], note: `stopped server on port ${port}` };
        }

        if (input.serve) {
            if (RUNNING_SERVERS.has(port)) {
                return { ok: true, mode: 'served' as const, signals: [], blockers: [], warnings: [], serverPort: port, serverUrl: `http://${input.bindHost}:${port}/gate`, note: `server already running on port ${port}` };
            }
            const provider = (): AdoCreds | null => {
                const r = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
                return r.creds;
            };
            const serveWarnings: string[] = [];
            if (input.bindHost !== '127.0.0.1' && input.bindHost !== 'localhost' && !input.authToken) {
                serveWarnings.push(`Release-gate server binding to ${input.bindHost} without authToken — POST /gate is accessible without authentication from any host that can reach this port. Set authToken to require Bearer auth.`);
            }
            const { server } = startServer({
                port,
                bindHost: input.bindHost,
                authToken: input.authToken ?? null,
                workspaceRoot: ctx.workspaceRoot,
                log,
                resolvedCredsProvider: provider,
            });
            RUNNING_SERVERS.set(port, server);
            return {
                ok: true,
                mode: 'served' as const,
                signals: [], blockers: [], warnings: serveWarnings,
                serverPort: port,
                serverUrl: `http://${input.bindHost}:${port}/gate`,
                note: `Release-gate HTTP server listening on ${input.bindHost}:${port} (auth ${input.authToken ? 'REQUIRED (Bearer)' : 'disabled'}). POST /gate with {pipelineRunId, iterationPath, storyIds, slaProfile, perfResultPath} to receive a verdict.`,
            };
        }

        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
        });
        if (!credsRes.creds) {
            return {
                ok: false, mode: 'one-shot' as const, signals: [],
                blockers: [], warnings: [credsRes.diagnostic],
                note: 'ADO not configured — cannot compute verdict.',
            };
        }
        const verdict = await computeVerdict(
            credsRes.creds,
            input.pipelineRunId,
            input.iterationPath,
            input.storyIds,
            sla,
            input.perfResultPath,
            ctx.workspaceRoot,
        );
        log.info('gate computed', { verdict: verdict.verdict, score: verdict.overallScore });
        return {
            ok: true, mode: 'one-shot' as const,
            verb: input.verb,
            verdict: verdict.verdict,
            overallScore: verdict.overallScore,
            signals: verdict.signals,
            blockers: verdict.blockers,
            warnings: verdict.warnings,
            note: `verdict=${verdict.verdict} score=${verdict.overallScore}/100`,
        };
    },
});
