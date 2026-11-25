/**
 * Azure DevOps pipelines for the Studio: pipelines, runs, the stage/job/task timeline, task logs,
 * artifacts — and the framework's test results inside a run's artifacts (the same report files a
 * local run produces), shown in the Studio's Feature → Scenario → Step → Action view.
 *
 * Verified against a real organization (REST 7.1):
 *  - Runs: GET build/builds?definitions=&branchName=&$top=&queryOrder=queueTimeDescending.
 *  - Timeline: GET build/builds/{id}/timeline → records (Stage/Phase/Job/Task, parentId, log.id).
 *  - Logs: GET build/builds/{id}/logs/{logId} (plain text).
 *  - The ADO test pipeline (ado-playwright-shared) publishes the framework reports as a
 *    PipelineArtifact (test-reports-<buildId>): test-results-<time>/<Project>/reports/report-data.json
 *    plus consolidated-data.json for multi-project suites.
 *  - Artifact content is served from *.artifacts.visualstudio.com; GET pipelines/{p}/runs/{r}/artifacts
 *    ?artifactName=…&$expand=signedContent returns a time-limited signed URL, downloaded WITHOUT the token.
 *  - Classic build artifacts ("Container", PublishBuildArtifacts): resource.data is
 *    "#/{containerId}/{path}". GET {org}/_apis/resources/Containers/{id}?itemPath={path}
 *    &api-version=7.1-preview.4 lists the files (path, itemType, fileLength); the same URL with
 *    the file's path and Accept: application/octet-stream returns it gzip-encoded.
 *  - The framework exits 0 even when scenarios fail, so a run can be "succeeded" with failing tests:
 *    the test outcome is read from the reports, not from the run result.
 */
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { AdoClient } from './client';
import type { Connection } from '../core/network';
import { extractZip, safeEntryPath } from '../core/zip';
import { UserError } from '../core/errors';

export interface PipelineDef { id: number; name: string; folder: string }
export interface PipelineRun {
    id: number; number: string; pipeline: { id: number; name: string };
    status: string; result?: string; branch: string; reason: string; requestedFor?: string;
    queued?: string; started?: string; finished?: string; url: string;
}
export interface TimelineNode {
    id: string; parentId: string | null; type: string; name: string; state: string; result?: string;
    started?: string; finished?: string; errors: number; warnings: number; logId?: number;
    issues: Array<{ type: string; message: string }>; order: number;
}
export interface RunArtifact {
    name: string; type: string;
    /** Size in bytes when Azure DevOps reports it (pipeline artifacts do). */
    size?: number;
    /** The job that published it (artifact.source = timeline job id), and that job's stage. */
    job?: string; stage?: string;
    /** Classic build artifacts (type Container): the file container holding it. */
    container?: { id: number; path: string };
}
export interface StageSummary {
    id: string; identifier?: string; name: string; state: string; result?: string; order: number;
    attempt: number; retried: boolean; started?: string; finished?: string;
    /** Waiting for an approval or check (a Checkpoint.Approval / check record in progress). */
    waiting: boolean; errors: number;
}
export interface PublishedTestRun {
    id: number; name: string; state: string; total: number; passed: number; failed: number; notExecuted: number;
    started?: string; completed?: string; url: string;
    /** Stage/job the results were published from (YAML PublishTestResults fills this). */
    stage?: string; job?: string;
}
export interface PublishedTestResult {
    id: number; title: string; automatedTestName?: string; outcome: string; durationMs?: number;
    errorMessage?: string; stackTrace?: string; testCaseId?: number; priority?: number;
}

const BUILD_READ = 'Build (Read)';

function runSummary(b: Record<string, unknown>, webBase: string): PipelineRun {
    const def = (b.definition ?? {}) as { id?: number; name?: string };
    return {
        id: Number(b.id), number: String(b.buildNumber ?? ''), pipeline: { id: Number(def.id), name: String(def.name ?? '') },
        status: String(b.status ?? ''), result: b.result ? String(b.result) : undefined,
        branch: String(b.sourceBranch ?? '').replace(/^refs\/heads\//, ''), reason: String(b.reason ?? ''),
        requestedFor: (b.requestedFor as { displayName?: string } | undefined)?.displayName,
        queued: b.queueTime as string | undefined, started: b.startTime as string | undefined, finished: b.finishTime as string | undefined,
        url: `${webBase}/_build/results?buildId=${b.id}`,
    };
}

export class Pipelines {
    constructor(private readonly ado: AdoClient) {}
    private get webBase(): string { return `${this.ado.orgUrl}/${encodeURIComponent(this.ado.projectName)}`; }

    /**
     * Pipelines, a page at a time (large organizations have thousands): optionally only those whose
     * name contains `search`, or in a folder (and its sub-folders).
     */
    async definitions(opts: { search?: string; folder?: string; continuation?: string; top?: number } = {}): Promise<{ items: PipelineDef[]; next?: string }> {
        const q = [`$top=${Math.min(Math.max(opts.top ?? 100, 1), 500)}`, 'queryOrder=definitionNameAscending'];
        if (opts.search) q.push(`name=${encodeURIComponent(`*${opts.search.replace(/\*/g, '')}*`)}`);
        if (opts.folder) q.push(`path=${encodeURIComponent('\\' + opts.folder.replace(/^[\\/]+/, '').replace(/\//g, '\\'))}`);
        if (opts.continuation) q.push(`continuationToken=${encodeURIComponent(opts.continuation)}`);
        const r = await this.ado.page<{ value: Array<{ id: number; name: string; path?: string }> }>(`build/definitions?${q.join('&')}`, BUILD_READ);
        return { items: r.data.value.map((d) => ({ id: d.id, name: d.name, folder: (d.path ?? '\\').replace(/^\\/, '') })), next: r.next };
    }

    async folders(): Promise<string[]> {
        const r = await this.ado.get<{ value: Array<{ path: string }> }>('build/folders', 'project', BUILD_READ);
        return r.value.map((f) => f.path.replace(/^\\/, '')).filter(Boolean).sort();
    }

    /** Runs, newest first, a page at a time, with the filters people use in a busy organization. */
    async runs(opts: { pipelineId?: number; branch?: string; result?: 'succeeded' | 'failed' | 'partiallySucceeded' | 'canceled'; running?: boolean; requestedFor?: string; top?: number; continuation?: string } = {}): Promise<{ items: PipelineRun[]; next?: string }> {
        const q = [`$top=${Math.min(Math.max(opts.top ?? 30, 1), 200)}`, 'queryOrder=queueTimeDescending'];
        if (opts.pipelineId) q.push(`definitions=${opts.pipelineId}`);
        if (opts.branch) q.push(`branchName=${encodeURIComponent(opts.branch.startsWith('refs/') ? opts.branch : `refs/heads/${opts.branch}`)}`);
        if (opts.result) q.push(`resultFilter=${opts.result}`);
        if (opts.running) q.push('statusFilter=inProgress,notStarted,postponed');
        if (opts.requestedFor) q.push(`requestedFor=${encodeURIComponent(opts.requestedFor)}`);
        if (opts.continuation) q.push(`continuationToken=${encodeURIComponent(opts.continuation)}`);
        const r = await this.ado.page<{ value: Array<Record<string, unknown>> }>(`build/builds?${q.join('&')}`, BUILD_READ);
        return { items: r.data.value.map((b) => runSummary(b, this.webBase)), next: r.next };
    }

    /**
     * Stages of a run from the raw timeline records: retries (attempt / previousAttempts), approvals
     * or checks still waiting (Checkpoint.* records in progress under the stage), skipped stages.
     */
    static stages(raw: Array<Record<string, unknown>>): StageSummary[] {
        const byId = new Map(raw.map((x) => [String(x.id), x]));
        const stageOf = (x: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
            for (let i = 0; x && i < 20; i++) { if (x.type === 'Stage') return x; x = x.parentId ? byId.get(String(x.parentId)) : undefined; }
            return undefined;
        };
        const waiting = new Set<string>();
        for (const x of raw) if (/^Checkpoint/.test(String(x.type)) && x.state !== 'completed') { const st = stageOf(x); if (st) waiting.add(String(st.id)); }
        return raw.filter((x) => x.type === 'Stage').sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)).map((x) => {
            const attempt = Number(x.attempt ?? 1);
            const prev = Array.isArray(x.previousAttempts) ? (x.previousAttempts as unknown[]).length : 0;
            return {
                id: String(x.id), identifier: x.identifier ? String(x.identifier) : undefined, name: String(x.name ?? ''),
                state: String(x.state ?? ''), result: x.result ? String(x.result) : undefined, order: Number(x.order ?? 0),
                attempt, retried: prev > 0 || attempt > 1, started: x.startTime as string | undefined, finished: x.finishTime as string | undefined,
                waiting: waiting.has(String(x.id)), errors: Number(x.errorCount ?? 0),
            };
        });
    }

    /** Test runs published to Azure DevOps for this run (PublishTestResults, or the framework's ADO publishing). */
    async publishedTestRuns(buildId: number): Promise<PublishedTestRun[]> {
        const r = await this.ado.get<{ value: Array<Record<string, unknown>> }>(`test/runs?buildUri=${encodeURIComponent(`vstfs:///Build/Build/${buildId}`)}&includeRunDetails=true`, 'project', 'Test Management (Read)');
        return r.value.map((t) => {
            const pr = (t.pipelineReference ?? {}) as { stageReference?: { stageName?: string }; jobReference?: { jobName?: string }; phaseReference?: { phaseName?: string } };
            const total = Number(t.totalTests ?? 0), passed = Number(t.passedTests ?? 0), notExecuted = Number(t.notApplicableTests ?? 0) + Number(t.incompleteTests ?? 0);
            return { id: Number(t.id), name: String(t.name ?? ''), state: String(t.state ?? ''), total, passed, failed: Math.max(0, Number(t.unanalyzedTests ?? (total - passed - notExecuted))), notExecuted,
                started: t.startedDate as string | undefined, completed: t.completedDate as string | undefined,
                url: `${this.webBase}/_testManagement/runs?runId=${t.id}`,
                // Verified on a real run: stageName is the stage IDENTIFIER (Test_DEV, not "Test DEV") and
                // jobName is "__default" for a single-job phase; the phase name is the readable one.
                stage: pr.stageReference?.stageName,
                job: pr.jobReference?.jobName && pr.jobReference.jobName !== '__default' ? pr.jobReference.jobName : pr.phaseReference?.phaseName };
        });
    }

    /** Results of a published test run (failed ones first), at most `max`. */
    async publishedTestResults(runId: number, max = 2000): Promise<PublishedTestResult[]> {
        const out: PublishedTestResult[] = [];
        for (let skip = 0; out.length < max; skip += 1000) {
            const r = await this.ado.get<{ value: Array<Record<string, unknown>> }>(`test/Runs/${runId}/results?$top=1000&$skip=${skip}`, 'project', 'Test Management (Read)');
            for (const x of r.value) out.push({
                id: Number(x.id), title: String(x.testCaseTitle ?? x.automatedTestName ?? ''), automatedTestName: x.automatedTestName ? String(x.automatedTestName) : undefined,
                outcome: String(x.outcome ?? ''), durationMs: typeof x.durationInMs === 'number' ? x.durationInMs : undefined,
                errorMessage: x.errorMessage ? String(x.errorMessage).slice(0, 8000) : undefined, stackTrace: x.stackTrace ? String(x.stackTrace).slice(0, 16000) : undefined,
                testCaseId: (x.testCase as { id?: string } | undefined)?.id ? Number((x.testCase as { id: string }).id) : undefined,
                priority: typeof x.priority === 'number' ? x.priority : undefined,
            });
            if (r.value.length < 1000) break;
        }
        const rank = (o: string) => (/^(Failed|Error|Timeout|Aborted|Blocked)$/i.test(o) ? 0 : /^Passed$/i.test(o) ? 2 : 1);
        return out.slice(0, max).sort((a, b) => rank(a.outcome) - rank(b.outcome));
    }

    async run(id: number): Promise<PipelineRun> {
        return runSummary(await this.ado.get<Record<string, unknown>>(`build/builds/${id}`, 'project', BUILD_READ), this.webBase);
    }

    /** Raw timeline records (stage attempts and previousAttempts are only there). */
    async rawTimeline(id: number): Promise<Array<Record<string, unknown>>> {
        const r = await this.ado.get<{ records?: Array<Record<string, unknown>> } | null>(`build/builds/${id}/timeline`, 'project', BUILD_READ);
        return r?.records ?? [];
    }

    static toNodes(records: Array<Record<string, unknown>>): TimelineNode[] {
        // A Checkpoint record only groups the checks of a stage (Stage → Checkpoint →
        // Checkpoint.Approval): leave it out and hang its checks on the stage. "Checkpoint.Approval"
        // is shown as "Approval" (other checks: "Check: <kind>").
        const checkpoints = new Map(records.filter((x) => x.type === 'Checkpoint').map((x) => [String(x.id), x.parentId ? String(x.parentId) : null]));
        const label = (t: string, n: string) => t === 'Checkpoint.Approval' ? 'Approval' : t.startsWith('Checkpoint.') ? `Check: ${t.slice('Checkpoint.'.length)}` : n;
        return records.filter((x) => x.type !== 'Checkpoint').map((x) => ({
            id: String(x.id),
            parentId: x.parentId ? (checkpoints.has(String(x.parentId)) ? checkpoints.get(String(x.parentId))! : String(x.parentId)) : null,
            type: String(x.type).startsWith('Checkpoint.') ? 'Check' : String(x.type), name: label(String(x.type), String(x.name ?? '')),
            state: String(x.state ?? ''), result: x.result ? String(x.result) : undefined,
            started: x.startTime as string | undefined, finished: x.finishTime as string | undefined,
            errors: Number(x.errorCount ?? 0), warnings: Number(x.warningCount ?? 0),
            logId: (x.log as { id?: number } | null)?.id, order: Number(x.order ?? 0),
            issues: ((x.issues as Array<{ type?: string; message?: string }> | null) ?? []).slice(0, 50).map((i) => ({ type: String(i.type ?? ''), message: String(i.message ?? '') })),
        }));
    }

    async timeline(id: number): Promise<TimelineNode[]> { return Pipelines.toNodes(await this.rawTimeline(id)); }

    /**
     * A task log. Long logs (tens of MB in big pipelines) are not downloaded whole: only the last
     * `tailLines` lines are fetched (startLine), using the line count Azure DevOps reports.
     */
    async log(id: number, logId: number, tailLines = 5000, maxChars = 2_000_000): Promise<{ text: string; truncated: boolean; totalLines?: number }> {
        let total: number | undefined;
        try {
            const list = await this.ado.get<{ value: Array<{ id: number; lineCount?: number }> }>(`build/builds/${id}/logs`, 'project', BUILD_READ);
            total = list.value.find((l) => l.id === logId)?.lineCount;
        } catch { /* fall back to the whole log */ }
        const start = total && total > tailLines ? total - tailLines + 1 : undefined;
        let text = await this.ado.getText(`build/builds/${id}/logs/${logId}${start ? `?startLine=${start}` : ''}`, BUILD_READ);
        let truncated = !!start;
        if (text.length > maxChars) { text = text.slice(-maxChars); truncated = true; }
        return { text, truncated, totalLines: total };
    }

    /** Artifacts with their size and the job/stage that published them (when the timeline is given). */
    async artifacts(id: number, timeline?: TimelineNode[]): Promise<RunArtifact[]> {
        const r = await this.ado.get<{ value: Array<{ name: string; source?: string; resource?: { type?: string; data?: string; properties?: Record<string, string> } }> }>(`build/builds/${id}/artifacts`, 'project', BUILD_READ);
        const byId = new Map((timeline ?? []).map((n) => [n.id, n]));
        return r.value.map((a) => {
            const job = a.source ? byId.get(a.source) : undefined;
            let st = job; while (st && st.type !== 'Stage') st = st.parentId ? byId.get(st.parentId) : undefined;
            const size = Number(a.resource?.properties?.artifactsize);
            const c = /^Container$/i.test(a.resource?.type ?? '') ? /^#\/(\d+)\/(.+)$/.exec(a.resource?.data ?? '') : null;
            return {
                name: a.name, type: a.resource?.type ?? '', ...(Number.isFinite(size) && size > 0 ? { size } : {}),
                ...(job ? { job: job.name } : {}), ...(st ? { stage: st.name } : {}),
                ...(c ? { container: { id: Number(c[1]), path: c[2] } } : {}),
            };
        });
    }

    /** Time-limited signed download URL for a pipeline artifact (no token needed to download). */
    async signedArtifactUrl(pipelineId: number, runId: number, name: string): Promise<string> {
        const r = await this.ado.get<{ signedContent?: { url?: string } }>(`pipelines/${pipelineId}/runs/${runId}/artifacts?artifactName=${encodeURIComponent(name)}&$expand=signedContent`, 'project', BUILD_READ);
        const u = r.signedContent?.url;
        if (!u || !/^https:\/\//.test(u)) throw new UserError(`Azure DevOps did not give a download link for the artifact ${name}.`);
        return u;
    }

    /** Files of a classic build artifact (its file container), with their sizes. */
    async containerFiles(c: { id: number; path: string }): Promise<ContainerFile[]> {
        const r = await this.ado.get<{ value: Array<{ path: string; itemType: string; fileLength?: number }> }>(
            `resources/Containers/${c.id}?itemPath=${encodeURIComponent(c.path)}&api-version=${CONTAINER_API}`, 'org', BUILD_READ);
        const prefix = c.path.replace(/\/+$/, '') + '/';
        return r.value.filter((i) => i.itemType === 'file' && i.path.startsWith(prefix))
            .map((i) => ({ path: i.path, rel: i.path.slice(prefix.length), size: i.fileLength ?? 0 }));
    }

    /** One file of a file container (Azure DevOps sends it gzip-encoded; returned decoded). */
    async containerFile(id: number, itemPath: string, conn: Connection | undefined, maxBytes: number): Promise<Buffer> {
        const r = await this.ado.getBinary(`resources/Containers/${id}?itemPath=${encodeURIComponent(itemPath)}&api-version=${CONTAINER_API}`, maxBytes, BUILD_READ);
        return 'data' in r ? r.data : downloadSigned(r.redirect, conn, maxBytes);
    }

    /**
     * Queue a run of a pipeline on a branch (WRITE: needs the "Build (Read & execute)" scope).
     * The UI asks the user to confirm first.
     */
    async queue(pipelineId: number, branch: string, parameters: Record<string, string> = {}): Promise<PipelineRun> {
        const body = { resources: { repositories: { self: { refName: branch.startsWith('refs/') ? branch : `refs/heads/${branch}` } } }, templateParameters: parameters };
        const r = await this.ado.post<{ id: number }>(`pipelines/${pipelineId}/runs`, body, 'project', 'Build (Read & execute)');
        return this.run(r.id);
    }
}

/** Download a signed URL (no Authorization header), through the Studio's network settings. */
export function downloadSigned(url: string, conn: Connection | undefined, maxBytes = 1024 ** 3): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const go = (u: string, hops: number) => {
            const req = https.get(u, { agent: conn?.agentFor(u), ...(conn?.ca ? { ca: conn.ca } : {}), timeout: 60_000 }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location && hops < 5) {
                    res.resume();
                    const next = new URL(res.headers.location, u);
                    if (next.protocol !== 'https:') { reject(new UserError('The artifact download was redirected to a non-https address.')); return; }
                    go(next.href, hops + 1); return;
                }
                if (res.statusCode !== 200) { res.resume(); reject(new UserError(`Downloading the artifact failed (HTTP ${res.statusCode}).`)); return; }
                const chunks: Buffer[] = []; let n = 0;
                res.on('data', (c: Buffer) => { n += c.length; if (n > maxBytes) { req.destroy(new UserError('The artifact is too large to download.')); return; } chunks.push(c); });
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new UserError('The artifact download timed out.')));
            req.on('error', reject);
        };
        go(url, 0);
    });
}

const CONTAINER_API = '7.1-preview.4';

export interface ContainerFile {
    /** Full item path in the container (starts with the artifact name). */
    path: string;
    /** Path inside the artifact. */
    rel: string;
    size: number;
}

const SKIP_DIRS = ['node_modules'];

/**
 * The files of a classic artifact the Studio needs for test reports: everything under each
 * project folder that holds a reports/report-data.json (its screenshots, videos and traces sit
 * next to reports/), plus consolidated-data.json. Nothing when the artifact has no report.
 */
export function containerReportFiles(files: ContainerFile[]): ContainerFile[] {
    const roots = new Set<string>();
    for (const f of files) {
        const m = /^(?:(.*)\/)?report-data\.json$/.exec(f.rel);
        if (!m) continue;
        const dir = m[1] ?? '';
        roots.add(dir.endsWith('/reports') ? dir.slice(0, -'/reports'.length) : dir === 'reports' ? '' : dir);
    }
    if (!roots.size) return [];
    const under = (rel: string) => [...roots].some((r) => r === '' || rel === r || rel.startsWith(r + '/'));
    return files.filter((f) => (under(f.rel) || /(^|\/)consolidated-data\.json$/.test(f.rel))
        && !f.rel.split('/').some((s) => SKIP_DIRS.includes(s)));
}

export interface ReportLocation {
    /** Project name (folder above reports/); '' for a single-project run (no project folder). */
    name: string;
    /** Folder holding report-data.json. */
    reportDir: string;
}

/** report-data.json files in an extracted artifact (one per project for multi-project suites). */
export function findReports(root: string): { reports: ReportLocation[]; consolidated?: string } {
    const reports: ReportLocation[] = [];
    let consolidated: string | undefined;
    const walk = (dir: string, depth: number) => {
        if (depth > 8) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const a = path.join(dir, e.name);
            if (e.isDirectory()) { if (!['screenshots', 'videos', 'traces', 'har', 'downloads', 'node_modules'].includes(e.name)) walk(a, depth + 1); }
            else if (e.name === 'report-data.json') {
                // <Project>/reports/report-data.json → "Project"; otherwise the folder holding the file.
                // A single-project run has no project folder (test-results-<time>/reports): name ''
                // so the caller shows the artifact's name instead of the timestamp folder.
                const folder = path.basename(dir) === 'reports' ? path.basename(path.dirname(dir)) : path.basename(dir);
                const name = /^test-results-/.test(folder) || dir === root ? '' : folder;
                reports.push({ name, reportDir: dir });
            } else if (e.name === 'consolidated-data.json' && !consolidated) consolidated = a;
        }
    };
    walk(root, 0);
    reports.sort((a, b) => a.name.localeCompare(b.name));
    return { reports, consolidated };
}

/** Artifacts that look like test reports by name (the ADO test pipeline names them test-reports-<id>). */
export const isReportArtifact = (a: RunArtifact) => /report|test|result/i.test(a.name) && /PipelineArtifact|Container/i.test(a.type);

/** Largest artifact the Studio downloads by itself (anything bigger: only when the user asks). */
export const AUTO_DOWNLOAD_BYTES = 300 * 1024 * 1024;

/**
 * Artifacts worth looking into for test reports, without the user asking: named like reports, or
 * published by a job/stage whose name says it tests — and not too large.
 */
export function reportCandidates(arts: RunArtifact[]): RunArtifact[] {
    const testy = /test|qa|e2e|automation|regression|smoke|sanity|playwright/i;
    return arts.filter((a) => (/^PipelineArtifact$/i.test(a.type) || !!a.container)
        && (isReportArtifact(a) || testy.test(a.stage ?? '') || testy.test(a.job ?? ''))
        && (a.size === undefined || a.size <= AUTO_DOWNLOAD_BYTES));
}

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

/**
 * Download one artifact of a run into the cache (once; reused afterwards).
 *  - Pipeline artifacts: the whole artifact as a ZIP, unpacked.
 *  - Classic build artifacts (Container): only the report files (see containerReportFiles),
 *    one by one; an artifact without a report downloads nothing.
 */
export async function fetchArtifact(p: Pipelines, run: PipelineRun, a: RunArtifact, cacheDir: string, conn: Connection | undefined, maxBytes = 2 * 1024 ** 3): Promise<string> {
    if (!/^PipelineArtifact$/i.test(a.type) && !a.container) throw new UserError(`${a.name} is a "${a.type}" artifact, which the Studio cannot open. Download it from Azure DevOps instead.`);
    if (a.size !== undefined && a.size > maxBytes) throw new UserError(`${a.name} is ${(a.size / 1024 ** 3).toFixed(1)} GB, too large to open here. Download it from Azure DevOps.`);
    const dir = path.join(cacheDir, String(run.id), safeName(a.name));
    const done = path.join(dir, '.complete');
    if (fs.existsSync(done)) { touch(path.join(cacheDir, String(run.id))); return dir; }
    if (run.status !== 'completed' && !a.size && !a.container) throw new UserError('The run has not finished yet.');
    fs.rmSync(dir, { recursive: true, force: true });
    if (a.container) await fetchContainer(p, a.container, dir, conn, maxBytes);
    else extractZip(await downloadSigned(await p.signedArtifactUrl(run.pipeline.id, run.id, a.name), conn, maxBytes), dir);
    fs.writeFileSync(done, new Date().toISOString());
    touch(path.join(cacheDir, String(run.id)));
    pruneCache(cacheDir);
    return dir;
}

async function fetchContainer(p: Pipelines, c: { id: number; path: string }, dir: string, conn: Connection | undefined, maxBytes: number): Promise<void> {
    const want = containerReportFiles(await p.containerFiles(c));
    const total = want.reduce((n, f) => n + f.size, 0);
    if (total > maxBytes) throw new UserError(`The report files in this artifact are ${(total / 1024 ** 3).toFixed(1)} GB, too large to open here. Download it from Azure DevOps.`);
    if (want.length > 20_000) throw new UserError(`The artifact has too many report files (${want.length}).`);
    const root = path.resolve(dir);
    fs.mkdirSync(root, { recursive: true });
    let next = 0;
    const worker = async () => {
        while (next < want.length) {
            const f = want[next++];
            const rel = safeEntryPath(f.rel);
            if (!rel) continue;
            const target = path.resolve(root, rel);
            const r = path.relative(root, target);
            if (!r || r.startsWith('..') || path.isAbsolute(r)) continue;
            // Allow for a size the listing did not know, but never far beyond it.
            const data = await p.containerFile(c.id, f.path, conn, Math.max(f.size * 2, 1024 * 1024));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data, { flag: 'wx' });
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, want.length) }, worker));
}

function touch(dir: string) { try { const now = new Date(); fs.utimesSync(dir, now, now); } catch { /* gone */ } }

function dirSize(dir: string): number {
    let n = 0;
    const walk = (d: string) => { let es: fs.Dirent[] = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const a = path.join(d, e.name); if (e.isDirectory()) walk(a); else { try { n += fs.statSync(a).size; } catch { /* gone */ } } } };
    walk(dir);
    return n;
}

/** Keep the cache small: the 20 most recently opened runs, and at most 3 GB in total. */
export function pruneCache(cacheDir: string, keepRuns = 20, maxBytes = 3 * 1024 ** 3): string[] {
    let runs: Array<{ dir: string; t: number; size: number }> = [];
    try {
        runs = fs.readdirSync(cacheDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
            .map((e) => { const d = path.join(cacheDir, e.name); return { dir: d, t: fs.statSync(d).mtimeMs, size: dirSize(d) }; })
            .sort((a, b) => b.t - a.t);
    } catch { return []; }
    const removed: string[] = [];
    let total = 0;
    runs.forEach((r, i) => {
        total += r.size;
        if (i >= keepRuns || (i > 0 && total > maxBytes)) { fs.rmSync(r.dir, { recursive: true, force: true }); removed.push(path.basename(r.dir)); }
    });
    return removed;
}
