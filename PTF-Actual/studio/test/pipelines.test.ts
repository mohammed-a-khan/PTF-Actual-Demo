import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { crc32, extractZip, listZip } from '../src/core/zip';
import { AdoClient, AdoRequest, AdoResponse } from '../src/ado/client';
import { findReports, isReportArtifact, Pipelines } from '../src/ado/pipelines';

/** A tiny ZIP writer for tests (stored or deflated entries; optional unix mode, wrong CRC). */
function makeZip(entries: Array<{ name: string; data?: Buffer | string; deflate?: boolean; mode?: number; badCrc?: boolean }>): Buffer {
    const locals: Buffer[] = [], centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const data = Buffer.from(e.data ?? '');
        const body = e.deflate ? zlib.deflateRawSync(data) : data;
        const name = Buffer.from(e.name, 'utf8');
        const crc = e.badCrc ? (crc32(data) ^ 1) >>> 0 : crc32(data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
        locals.push(lh, name, body);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((e.mode !== undefined ? 3 : 0) << 8 | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
        ch.writeUInt16LE(e.deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(((e.mode ?? 0) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
        centrals.push(ch, name);
        offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pl-'));

test('zip: extracts stored and deflated files, refuses escapes and links, checks CRC and size', () => {
    const d = tmp();
    const out = path.join(d, 'out');
    const zip = makeZip([
        { name: 'test-reports-1/', data: '' },
        { name: 'test-reports-1/A/reports/report-data.json', data: '{"suite":{"scenarios":[]}}', deflate: true },
        { name: 'test-reports-1/A/screenshots/s.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { name: '../evil.txt', data: 'x' },
        { name: '/abs/evil.txt', data: 'x' },
        { name: 'C:/evil.txt', data: 'x' },
        { name: 'a/../../evil2.txt', data: 'x' },
        { name: 'link', data: '/etc/passwd', mode: 0o120777 },
    ]);
    assert.equal(listZip(zip).length, 8);
    const r = extractZip(zip, out);
    assert.deepEqual(r.files.sort(), ['test-reports-1/A/reports/report-data.json', 'test-reports-1/A/screenshots/s.png']);
    assert.equal(r.skipped.length, 5);
    assert.ok(!fs.existsSync(path.join(d, 'evil.txt')) && !fs.existsSync(path.join(out, 'link')));
    assert.equal(fs.readFileSync(path.join(out, 'test-reports-1/A/reports/report-data.json'), 'utf8'), '{"suite":{"scenarios":[]}}');
    assert.throws(() => extractZip(makeZip([{ name: 'x.txt', data: 'hello', badCrc: true }]), path.join(d, 'o2')), /checksum/);
    // A highly compressible 20 MB entry: refused as a likely zip bomb (ratio limit).
    assert.throws(() => extractZip(makeZip([{ name: 'big.bin', data: Buffer.alloc(20 * 1024 * 1024), deflate: true }]), path.join(d, 'o3')), /zip bomb/);
    assert.throws(() => listZip(Buffer.from('not a zip')), /Not a ZIP/);
});

test('report folders inside a pipeline artifact (multi-project)', () => {
    const d = tmp();
    const w = (f: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), '{}'); };
    w('test-reports-162/test-results-x/Akhan/reports/report-data.json');
    w('test-reports-162/test-results-x/akhan-api/reports/report-data.json');
    w('test-reports-162/test-results-x/consolidated-data.json');
    const f = findReports(d);
    assert.deepEqual(f.reports.map((r) => r.name), ['Akhan', 'akhan-api']);
    assert.ok(f.consolidated?.endsWith('consolidated-data.json'));
    assert.ok(isReportArtifact({ name: 'test-reports-162', type: 'PipelineArtifact' }));
    assert.ok(!isReportArtifact({ name: 'drop', type: 'Container' }));
});

test('pipelines: runs, timeline and logs are read; starting a run sends exactly the branch and parameters', async () => {
    const calls: AdoRequest[] = [];
    const transport = async (req: AdoRequest) => {
        calls.push(req);
        const u = new URL(req.url);
        if (u.pathname.endsWith('/_apis/build/builds') && req.method === 'GET') return { status: 200, body: JSON.stringify({ value: [
            { id: 162, buildNumber: '20251212.18', status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/main', reason: 'manual', definition: { id: 2, name: 'demo' }, requestedFor: { displayName: 'Mo' } }] }) };
        if (u.pathname.endsWith('/_apis/build/builds/162/timeline')) return { status: 200, body: JSON.stringify({ records: [
            { id: 's', parentId: null, type: 'Stage', name: 'Test Automation', state: 'completed', result: 'succeeded', order: 1 },
            { id: 'c', parentId: null, type: 'Checkpoint', name: 'Checkpoint', state: 'completed', order: 0 },
            { id: 't', parentId: 's', type: 'Task', name: 'Test Execution', state: 'completed', result: 'succeeded', order: 2, log: { id: 9 }, issues: [{ type: 'warning', message: 'w' }] }] }) };
        if (u.pathname.endsWith('/_apis/build/builds/162/logs/9')) return { status: 200, body: 'line 1\nline 2' };
        if (u.pathname.endsWith('/_apis/pipelines/2/runs') && req.method === 'POST') return { status: 200, body: JSON.stringify({ id: 163 }) };
        if (u.pathname.endsWith('/_apis/build/builds/163')) return { status: 200, body: JSON.stringify({ id: 163, buildNumber: '20251212.19', status: 'notStarted', sourceBranch: 'refs/heads/feature/x', reason: 'manual', definition: { id: 2, name: 'demo' } }) };
        return { status: 404, body: '' };
    };
    const p = new Pipelines(new AdoClient({ orgUrl: 'https://dev.azure.com/mdakhan', project: 'myproject', pat: 'x', transport }));
    const runs = (await p.runs({ pipelineId: 2, branch: 'main' })).items;
    assert.deepEqual(runs.map((r) => [r.id, r.branch, r.result, r.url]), [[162, 'main', 'succeeded', 'https://dev.azure.com/mdakhan/myproject/_build/results?buildId=162']]);
    assert.match(calls[0].url, /definitions=2/);
    assert.match(calls[0].url, /branchName=refs%2Fheads%2Fmain/);
    const tl = await p.timeline(162);
    assert.deepEqual(tl.map((n) => [n.type, n.name, n.logId]), [['Stage', 'Test Automation', undefined], ['Task', 'Test Execution', 9]]);
    assert.deepEqual(await p.log(162, 9), { text: 'line 1\nline 2', truncated: false, totalLines: undefined });
    // Reading never writes.
    assert.ok(calls.every((c) => c.method === 'GET'));
    const queued = await p.queue(2, 'feature/x', { targetEnv: 'qa' });
    const post = calls.find((c) => c.method === 'POST')!;
    assert.deepEqual(JSON.parse(post.body!), { resources: { repositories: { self: { refName: 'refs/heads/feature/x' } } }, templateParameters: { targetEnv: 'qa' } });
    assert.equal(queued.id, 163);
});

// A large organization's build-and-deploy pipeline, as Azure DevOps reports it (timeline records).
const DEPLOY_TIMELINE = [
    { id: 'b', type: 'Stage', name: 'Build', identifier: 'Build', state: 'completed', result: 'succeeded', order: 1, attempt: 1, previousAttempts: [] },
    { id: 'bj', parentId: 'b', type: 'Job', name: 'Compile', state: 'completed', result: 'succeeded', order: 1 },
    { id: 'd1', type: 'Stage', name: 'Deploy DEV', state: 'completed', result: 'succeeded', order: 2, attempt: 1, previousAttempts: [] },
    { id: 't1', type: 'Stage', name: 'Test DEV', state: 'completed', result: 'failed', order: 3, attempt: 1, previousAttempts: [] },
    { id: 't1p', parentId: 't1', type: 'Phase', name: 'Playwright', state: 'completed', result: 'failed', order: 1 },
    { id: 't1j', parentId: 't1p', type: 'Job', name: 'Run UI tests', state: 'completed', result: 'failed', order: 1 },
    { id: 'd2', type: 'Stage', name: 'Deploy QA', state: 'pending', order: 4, attempt: 1, previousAttempts: [] },
    { id: 'cp', parentId: 'd2', type: 'Checkpoint', name: 'Checkpoint', state: 'inProgress', order: 1 },
    { id: 'ap', parentId: 'cp', type: 'Checkpoint.Approval', name: 'Checkpoint.Approval', state: 'inProgress', order: 1 },
    { id: 't2', type: 'Stage', name: 'Test QA', state: 'completed', result: 'succeeded', order: 5, attempt: 2, previousAttempts: [{ attempt: 1 }] },
    { id: 't2j', parentId: 't2', type: 'Job', name: 'Regression', state: 'completed', result: 'succeeded', order: 1 },
    { id: 'u', type: 'Stage', name: 'Deploy UAT', state: 'completed', result: 'skipped', order: 6, attempt: 1, previousAttempts: [] },
];

test('large pipelines: stages with approvals, retries and skips; artifacts attributed to stages', async () => {
    const { Pipelines: P, reportCandidates, AUTO_DOWNLOAD_BYTES } = await import('../src/ado/pipelines');
    const st = P.stages(DEPLOY_TIMELINE as Array<Record<string, unknown>>);
    assert.deepEqual(st.map((s) => [s.name, s.state, s.result ?? '', s.waiting, s.retried]), [
        ['Build', 'completed', 'succeeded', false, false], ['Deploy DEV', 'completed', 'succeeded', false, false], ['Test DEV', 'completed', 'failed', false, false],
        ['Deploy QA', 'pending', '', true, false], ['Test QA', 'completed', 'succeeded', false, true], ['Deploy UAT', 'completed', 'skipped', false, false]]);
    const transport = async (req: AdoRequest) => {
        if (new URL(req.url).pathname.endsWith('/artifacts')) return { status: 200, body: JSON.stringify({ value: [
            { name: 'drop', source: 'bj', resource: { type: 'PipelineArtifact', properties: { artifactsize: String(5 * 1024 ** 3) } } },
            { name: 'ui-results', source: 't1j', resource: { type: 'PipelineArtifact', properties: { artifactsize: '3500000' } } },
            { name: 'qa-output', source: 't2j', resource: { type: 'PipelineArtifact', properties: { artifactsize: String(AUTO_DOWNLOAD_BYTES + 1) } } },
            { name: 'legacy-tests', source: 't1j', resource: { type: 'Container' } },
        ] }) };
        return { status: 404, body: '' };
    };
    const p = new P(new AdoClient({ orgUrl: 'https://dev.azure.com/big', project: 'Platform', pat: 'x', transport }));
    const arts = await p.artifacts(1, P.toNodes(DEPLOY_TIMELINE as Array<Record<string, unknown>>));
    assert.deepEqual(arts.map((a) => [a.name, a.stage, a.job]), [['drop', 'Build', 'Compile'], ['ui-results', 'Test DEV', 'Run UI tests'], ['qa-output', 'Test QA', 'Regression'], ['legacy-tests', 'Test DEV', 'Run UI tests']]);
    // Auto: a test stage's small pipeline artifact. Not: the 5 GB build drop, the oversized QA output, the legacy container.
    assert.deepEqual(reportCandidates(arts).map((a) => a.name), ['ui-results']);
});

test('busy organizations: throttling is waited out, pages continue, long logs are read from the end', async () => {
    const waits: number[] = [];
    let calls = 0;
    const seen: string[] = [];
    const transport = async (req: AdoRequest): Promise<AdoResponse> => {
        seen.push(req.url);
        const u = new URL(req.url);
        if (u.pathname.endsWith('/_apis/build/builds') && calls++ < 2) return { status: 429, body: '', headers: { 'retry-after': '7' } };
        if (u.pathname.endsWith('/_apis/build/builds')) return { status: 200, body: JSON.stringify({ value: [] }), headers: { 'x-ms-continuationtoken': '2026-01-01T00:00:00Z' } };
        if (u.pathname.endsWith('/_apis/build/builds/5/logs')) return { status: 200, body: JSON.stringify({ value: [{ id: 3, lineCount: 120000 }] }) };
        if (u.pathname.endsWith('/_apis/build/builds/5/logs/3')) return { status: 200, body: 'tail…' };
        return { status: 404, body: '' };
    };
    const p = new Pipelines(new AdoClient({ orgUrl: 'https://dev.azure.com/big', project: 'Platform', pat: 'x', transport, sleep: async (ms) => { waits.push(ms); } }));
    const page1 = await p.runs({ pipelineId: 7, result: 'failed', requestedFor: 'me-id' });
    assert.deepEqual(waits, [7000, 7000], 'waited as Retry-After said');
    assert.equal(page1.next, '2026-01-01T00:00:00Z');
    assert.match(seen[seen.length - 1], /resultFilter=failed/);
    assert.match(seen[seen.length - 1], /requestedFor=me-id/);
    await p.runs({ pipelineId: 7, continuation: page1.next });
    assert.match(seen[seen.length - 1], /continuationToken=2026-01-01T00%3A00%3A00Z/);
    const log = await p.log(5, 3);
    assert.equal(log.truncated, true);
    assert.equal(log.totalLines, 120000);
    assert.match(seen[seen.length - 1], /logs\/3\?startLine=115001/);
    // Throttled for good: a clear message after the retries.
    const always = new AdoClient({ orgUrl: 'https://dev.azure.com/big', project: 'P', pat: 'x', transport: async () => ({ status: 429, body: '', headers: {} }), sleep: async () => undefined });
    await assert.rejects(always.get('build/builds'), /limiting requests/);
});

test('published test runs (PublishTestResults / framework ADO publishing), grouped by stage', async () => {
    const transport = async (req: AdoRequest) => {
        const u = new URL(req.url);
        if (u.pathname.endsWith('/_apis/test/runs')) return { status: 200, body: JSON.stringify({ value: [
            { id: 901, name: 'UI regression', state: 'Completed', totalTests: 120, passedTests: 112, unanalyzedTests: 6, notApplicableTests: 2,
                pipelineReference: { stageReference: { stageName: 'Test_QA' }, jobReference: { jobName: 'Regression' } } }] }) };
        if (u.pathname.endsWith('/_apis/test/Runs/901/results')) return { status: 200, body: JSON.stringify({ value: [
            { id: 1, testCaseTitle: 'Login works', outcome: 'Passed', durationInMs: 1200 },
            { id: 2, testCaseTitle: 'Order total', outcome: 'Failed', errorMessage: 'expected 10 got 9', stackTrace: 'at x', testCase: { id: '1240' } }] }) };
        return { status: 404, body: '' };
    };
    const p = new Pipelines(new AdoClient({ orgUrl: 'https://dev.azure.com/big', project: 'Platform', pat: 'x', transport }));
    const runs = await p.publishedTestRuns(5);
    assert.deepEqual(runs.map((r) => [r.name, r.total, r.passed, r.failed, r.stage, r.job]), [['UI regression', 120, 112, 6, 'Test_QA', 'Regression']]);
    const res = await p.publishedTestResults(901);
    assert.deepEqual(res.map((r) => [r.title, r.outcome, r.testCaseId]), [['Order total', 'Failed', 1240], ['Login works', 'Passed', undefined]]);
});

test('artifact cache keeps the most recent runs within the limits', async () => {
    const { pruneCache } = await import('../src/ado/pipelines');
    const d = tmp();
    for (let i = 1; i <= 5; i++) {
        const r = path.join(d, String(i));
        fs.mkdirSync(r);
        fs.writeFileSync(path.join(r, 'f'), Buffer.alloc(1000));
        fs.utimesSync(r, new Date(2026, 0, i), new Date(2026, 0, i));
    }
    assert.deepEqual(pruneCache(d, 3).sort(), ['1', '2']);
    assert.deepEqual(pruneCache(d, 10, 1500).sort(), ['3', '4']);
    assert.deepEqual(fs.readdirSync(d), ['5']);
});

test('published test run as Azure DevOps really reports it: job "__default" → the phase name', async () => {
    // Shape observed on a real run (studio-lab-cd, test run 453).
    const transport = async (req: AdoRequest) => {
        const u = new URL(req.url);
        if (u.pathname.endsWith('/_apis/test/runs')) return { status: 200, body: JSON.stringify({ value: [
            { id: 453, name: 'API tests (DEV)', state: 'Completed', totalTests: 6, passedTests: 4, unanalyzedTests: 2,
                pipelineReference: { pipelineId: 300, stageReference: { stageName: 'Test_DEV', attempt: 1 }, phaseReference: { phaseName: 'UiTests', attempt: 1 }, jobReference: { jobName: '__default', attempt: 1 } } }] }) };
        return { status: 404, body: '' };
    };
    const p = new Pipelines(new AdoClient({ orgUrl: 'https://dev.azure.com/mdakhan', project: 'myproject', pat: 'x', transport }));
    const runs = await p.publishedTestRuns(300);
    assert.deepEqual(runs.map((r) => [r.total, r.passed, r.failed, r.stage, r.job]), [[6, 4, 2, 'Test_DEV', 'UiTests']]);
});

test('classic build artifacts (Container): listed, only report files fetched, gzip decoded', async () => {
    const { containerReportFiles, fetchArtifact } = await import('../src/ado/pipelines');
    const report = JSON.stringify({ suite: { scenarios: [] } });
    const files: Record<string, string> = {
        'ui-reports/test-results-2026-11-19_10-00-00/Shop/reports/report-data.json': report,
        'ui-reports/test-results-2026-11-19_10-00-00/Shop/screenshots/a.png': 'PNG',
        'ui-reports/build-log.txt': 'not needed',
    };
    const asked: string[] = [];
    const transport = async (req: AdoRequest): Promise<AdoResponse> => {
        const u = new URL(req.url);
        if (u.pathname.endsWith('/_apis/build/builds/7/artifacts')) return { status: 200, body: JSON.stringify({ value: [
            { name: 'ui-reports', source: 'job-1', resource: { type: 'Container', data: '#/75192449/ui-reports' } }] }) };
        if (u.pathname === '/mdakhan/_apis/resources/Containers/75192449') {
            assert.equal(u.searchParams.get('api-version'), '7.1-preview.4');
            const item = u.searchParams.get('itemPath')!;
            if (req.headers.Accept === 'application/json') return { status: 200, body: JSON.stringify({ value: [
                { path: 'ui-reports', itemType: 'folder' },
                ...Object.entries(files).map(([p, c]) => ({ path: p, itemType: 'file', fileLength: c.length }))] }) };
            asked.push(item);
            return { status: 200, body: '', headers: { 'content-encoding': 'gzip' }, raw: zlib.gzipSync(Buffer.from(files[item])) };
        }
        return { status: 404, body: '' };
    };
    const p = new Pipelines(new AdoClient({ orgUrl: 'https://dev.azure.com/mdakhan', project: 'myproject', pat: 'x', transport }));
    const arts = await p.artifacts(7);
    assert.deepEqual(arts[0].container, { id: 75192449, path: 'ui-reports' });
    assert.equal(isReportArtifact(arts[0]), true);
    const cache = tmp();
    const run = { id: 7, status: 'completed', pipeline: { id: 3 } } as never;
    const dir = await fetchArtifact(p, run, arts[0], cache, undefined);
    assert.deepEqual(asked.sort(), Object.keys(files).filter((f) => !f.endsWith('.txt')).sort());
    assert.equal(fs.readFileSync(path.join(dir, 'test-results-2026-11-19_10-00-00/Shop/reports/report-data.json'), 'utf8'), report);
    assert.deepEqual(findReports(dir).reports.map((r) => r.name), ['Shop']);
    // Without a report nothing is downloaded.
    assert.deepEqual(containerReportFiles([{ path: 'x/api-tests.xml', rel: 'api-tests.xml', size: 10 }]), []);
});

test('a single-project report (test-results-<time>/reports) has no project name; the artifact name is shown', () => {
    const d = tmp();
    const r = path.join(d, 'test-results-2026-11-19_20-32-07', 'reports');
    fs.mkdirSync(r, { recursive: true });
    fs.writeFileSync(path.join(r, 'report-data.json'), '{}');
    assert.deepEqual(findReports(d).reports.map((x) => [x.name, x.reportDir]), [['', r]]);
});

test('an approval sits under its stage as "Approval" (the Checkpoint record only groups checks)', () => {
    // Shape observed on a real run (studio-lab-cd 302): Stage → Checkpoint → Checkpoint.Approval.
    const nodes = Pipelines.toNodes([
        { id: 's1', type: 'Stage', name: 'Deploy QA', parentId: null },
        { id: 'c1', type: 'Checkpoint', name: 'Checkpoint', parentId: 's1' },
        { id: 'a1', type: 'Checkpoint.Approval', name: 'Checkpoint.Approval', parentId: 'c1', state: 'completed', result: 'succeeded' },
    ]);
    assert.deepEqual(nodes.map((n) => [n.id, n.type, n.name, n.parentId]), [['s1', 'Stage', 'Deploy QA', null], ['a1', 'Check', 'Approval', 's1']]);
});
