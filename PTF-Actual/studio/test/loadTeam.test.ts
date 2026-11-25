/**
 * Team results: runs shared in a folder the team reaches (whose, from where), listed and trended together,
 * opened on another computer; load results of Azure DevOps pipeline runs imported (and shared).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findRunResults, listTeamRuns, publishRun, readTeamRun } from '../src/load/teamStore';
import { newScenario } from '../src/load/scenario';
import type { LoadRunDetail } from '../src/load/runs';
import type { RunResult } from '../src/load/engine';
import { runGit } from '../src/git/run';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';

const sc = newScenario('Checkout', 'test/orders/api/a.collection.json');
function run(id: string, startedAt: string, p95: number): LoadRunDetail {
    const total = { count: 1000, errors: 2, errorRate: 0.2, avg: p95 / 2, p50: p95 / 2, p90: p95 - 10, p95, p99: p95 + 50, max: p95 * 2, throughput: 50 };
    const result = { state: 'finished', elapsed: 20, users: 0, requests: 1000, errors: 2, iterations: 500, timeline: [], transactions: [{ id: 'pay', name: 'Pay', ...total, min: 1, topErrors: [] }], txTimeline: {}, populations: [], monitors: [], alerts: [],
        total, startedAt, endedAt: startedAt, stopReason: 'completed', slas: [], passed: p95 < 500, histograms: { total: { b: [], count: 0, sum: 0, min: 0, max: 0 }, tx: {} } } as unknown as RunResult;
    return { id, scenario: 'test/orders/load/checkout.load.json', name: 'Checkout', project: 'orders', env: 'qa', startedAt, state: 'finished', maxUsers: 20, duration: 20, definition: sc, result };
}

test('a shared folder: publish from two computers, list newest first, read back; results found in a downloaded artifact', () => {
    const share = fs.mkdtempSync(path.join(os.tmpdir(), 'team-'));
    try {
        assert.throws(() => publishRun(path.join(share, 'missing'), run('a', '2026-11-01T10:00:00.000Z', 300)), /cannot be reached/);
        assert.throws(() => publishRun('', run('a', '2026-11-01T10:00:00.000Z', 300)), /Set the team results folder/);
        const a = publishRun(share, run('a', '2026-11-01T10:00:00.000Z', 300), { user: 'ann', machine: 'LAPTOP-ANN' });
        publishRun(share, run('b', '2026-11-02T10:00:00.000Z', 620), { user: 'pipeline', machine: 'Azure DevOps', pipeline: 'perf-nightly #2026.11.02' });
        assert.throws(() => publishRun(share, { ...run('c', '2026-11-03T10:00:00.000Z', 1), state: 'running' }), /finished run/);
        assert.equal(a.file, 'orders/checkout/20261101T100000Z-a.json');
        assert.ok(!fs.readdirSync(path.join(share, 'orders/checkout')).some((f) => f.endsWith('.tmp')), 'no temporary files left');
        const list = listTeamRuns(share, { project: 'orders', scenario: 'test/orders/load/checkout.load.json' });
        assert.deepEqual(list.map((r) => [r.id, r.summary.p95, r.passed, r.by.pipeline ?? r.by.machine]), [['b', 620, false, 'perf-nightly #2026.11.02'], ['a', 300, true, 'LAPTOP-ANN']]);
        assert.equal(listTeamRuns(share, { scenario: 'test/orders/load/other.load.json' }).length, 0);
        assert.equal(readTeamRun(share, list[1].file).result!.total.p95, 300);
        for (const bad of ['../x.json', 'orders/checkout/20261101T100000Z-a.summary.json', 'orders/../../etc/passwd']) assert.throws(() => readTeamRun(share, bad), /Not a shared run/, bad);
        // A pipeline artifact as downloaded: the --json results somewhere inside, besides other files.
        const art = path.join(share, 'artifact');
        fs.mkdirSync(path.join(art, 'load', 'part1'), { recursive: true });
        fs.writeFileSync(path.join(art, 'load', 'part1', 'results.json'), JSON.stringify(run('p1', '2026-11-04T10:00:00.000Z', 200)));
        fs.writeFileSync(path.join(art, 'package.json'), '{"name":"x"}');
        fs.writeFileSync(path.join(art, 'junit.xml'), '<testsuites/>');
        assert.deepEqual(findRunResults(art).map((d) => d.id), ['p1']);
    } finally { fs.rmSync(share, { recursive: true, force: true }); }
});

test('through the server: team folder setting, share a run, team list, open it elsewhere, import a pipeline run\'s load results', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-srv-'));
    const dir = path.join(tmp, 'repo'), share = path.join(tmp, 'share'), home = path.join(tmp, 'home');
    fs.mkdirSync(share);
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\nADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    fs.mkdirSync(path.join(dir, 'config/orders/environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/orders/environments/qa.env'), 'ENVIRONMENT=qa\n');
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const transport = async (req: { url: string }) => {
        const u = new URL(req.url);
        if (u.pathname.endsWith('/_apis/build/builds/314')) return { status: 200, body: JSON.stringify({ id: 314, buildNumber: '2026.11.05', status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/main', reason: 'schedule', definition: { id: 9, name: 'perf-nightly' } }) };
        if (u.pathname.endsWith('/_apis/build/builds/314/timeline')) return { status: 200, body: JSON.stringify({ records: [] }) };
        if (u.pathname.endsWith('/_apis/build/builds/314/artifacts')) return { status: 200, body: JSON.stringify({ value: [{ name: 'drop', resource: { type: 'PipelineArtifact' } }, { name: 'load-results', resource: { type: 'PipelineArtifact', properties: { artifactsize: '5000' } } }] }) };
        return { status: 404, body: '' };
    };
    const { createServer } = await import('../src/server/server');
    const s = createServer({ repoRoot: dir, store, userName: 'Ann', home, adoTransport: transport, token: 'tk' });
    const call = async (method: string, url: string, payload?: unknown) => { const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as object } : {}) }); return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null }; };
    try {
        assert.deepEqual((await call('GET', '/api/load/team')).json, { folder: null, runs: [] });
        assert.match((await call('PUT', '/api/settings', { loadTeamFolder: path.join(tmp, 'nope') })).json.error, /cannot be reached/);
        assert.equal((await call('PUT', '/api/settings', { loadTeamFolder: share })).json.loadTeamFolder, share);
        const local = await call('POST', '/api/load/runs/import', { text: JSON.stringify(run('x', '2026-11-05T09:00:00.000Z', 280)) });
        assert.equal(local.status, 200, JSON.stringify(local.json));
        const shared = await call('POST', `/api/load/runs/${local.json.id}/share`);
        assert.equal(shared.status, 200, JSON.stringify(shared.json));
        assert.equal(shared.json.by.user, 'Ann');
        const team = await call('GET', '/api/load/team?project=orders');
        assert.deepEqual(team.json.runs.map((r: { summary: { p95: number } }) => r.summary.p95), [280], JSON.stringify(team.json));
        const opened = await call('POST', '/api/load/team/open', { file: team.json.runs[0].file });
        assert.equal(opened.status, 200);
        assert.equal((await call('GET', `/api/load/runs/${opened.json.id}`)).json.result.total.p95, 280);
        // A pipeline run's artifact, already downloaded into the pipelines cache.
        const gitDir = path.join(dir, '.git');
        const cached = path.join(gitDir, 'cs-studio', 'pipelines', '314', 'load-results');
        fs.mkdirSync(cached, { recursive: true });
        fs.writeFileSync(path.join(cached, 'checkout.json'), JSON.stringify(run('cli', '2026-11-05T02:00:00.000Z', 450)));
        fs.writeFileSync(path.join(cached, '.complete'), 'x');
        const imp = await call('POST', '/api/load/team/ado-import', { runId: 314, project: 'orders' });
        assert.equal(imp.status, 200, JSON.stringify(imp.json));
        assert.equal(imp.json.imported.length, 1);
        assert.match(imp.json.imported[0].message, /From pipeline run 2026\.11\.05 \(load-results\)/);
        const after = await call('GET', '/api/load/team?project=orders');
        assert.deepEqual(after.json.runs.map((r: { summary: { p95: number }; by: { pipeline?: string } }) => [r.summary.p95, r.by.pipeline ?? null]), [[280, null], [450, 'perf-nightly #2026.11.05']]);
        assert.match((await call('POST', '/api/load/team/ado-import', { runId: 315, project: 'orders' })).json.error ?? '', /./);
    } finally { await s.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
