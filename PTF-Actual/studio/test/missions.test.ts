import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cronMatches, MissionAgent, MissionDeps, MissionEngine, MissionRun, MissionTriggers, parseCron } from '../src/agents/missions';
import type { MissionSessionOptions } from '../src/agents/host';
import type { RunInfo, RunRequest, RunSummary } from '../src/run/runner';
import { runGit } from '../src/git/run';

/** A scripted agent: each message runs the next step of the script with the mission's tools, then goes idle. */
function fakeAgent(script: Array<(ctx: { tool: (n: string, a: unknown) => Promise<unknown>; dir: string; text: string }) => Promise<void>>, o: { calls?: () => number } = {}) {
    const sent: string[] = [];
    let opts: MissionSessionOptions | null = null;
    let step = 0, seq = 0, aborted = false;
    const agent: MissionAgent = {
        async start(x) { opts = x.mission; return { id: 'sess-1' }; },
        async send(_id, text) {
            sent.push(text);
            const fn = script[step++];
            setImmediate(async () => {
                if (fn && !aborted) await fn({ tool: (n, a) => opts!.tools.find((t) => t.name === n)!.handler(a) as Promise<unknown>, dir: opts!.workdir, text });
                if (!aborted) opts!.listener?.({ type: 'idle', seq: ++seq, at: Date.now() });
            });
        },
        async abort() { aborted = true; },
        usageOf: () => ({ usage: { calls: o.calls?.() ?? 3, inputTokens: 100, outputTokens: 50, cost: 0 }, busy: false, pending: 0 }),
    };
    return { agent, sent, opts: () => opts };
}

const summary = (scen: Array<[string, string, string?]>): RunSummary => ({ total: scen.length, passed: scen.filter((s) => s[1] === 'passed').length, failed: scen.filter((s) => s[1] === 'failed').length, skipped: 0, duration: 1, reportDir: '', hasHtml: false, scenarios: scen.map(([name, status, error]) => ({ name, feature: 'F', status, duration: 1, ...(error ? { error } : {}) })) });

async function repo() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-'));
    const dir = path.join(tmp, 'shop-tests');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'test/shop/features'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/shop/features/login.feature'), 'Feature: Login\n');
    fs.writeFileSync(path.join(dir, 'test/shop/pages/LoginPage.ts'.replace('pages/', '')), '');
    await runGit(['add', '-A'], { cwd: dir });
    await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
    return { tmp, dir, gitDir: path.join(dir, '.git') };
}
const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('automate a story: plan checkpoint, work in its own copy, verified by the Studio, brought into the working copy', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        const ran: Array<{ req: RunRequest; workdir?: string }> = [];
        const notified: string[] = [];
        const a = fakeAgent([
            async ({ tool, dir: wd }) => {
                assert.notEqual(wd, dir, 'its own copy');
                const answer = await tool('mission_ask', { kind: 'plan', question: 'Approve the plan?', content: 'Feature: Checkout\n  Scenario: Pay' });
                assert.equal(answer, 'Approved. Go on with the plan as it is.');
                fs.writeFileSync(path.join(wd, 'test/shop/features/checkout.feature'), 'Feature: Checkout\n  Scenario: Pay\n');
                fs.mkdirSync(path.join(wd, '.flaky-test-data')); fs.writeFileSync(path.join(wd, '.flaky-test-data/flaky-results.json'), '{}');
                fs.mkdirSync(path.join(wd, 'reports')); fs.writeFileSync(path.join(wd, 'reports/index.html'), 'x');
                await tool('memory_propose', { note: 'The checkout page needs the cookie banner closed first.' });
                await tool('mission_report', { outcome: 'done', summary: 'Checkout automated.', verify: { features: ['test/shop/features/checkout.feature'] } });
            },
        ]);
        const deps: MissionDeps = {
            repoRoot: dir, gitDir, agent: a.agent, userName: 'Tester', log: () => undefined, tickMs: 50, runInfo: () => undefined,
            notify: (m) => notified.push(m.state),
            runTests: async (req, workdir) => { ran.push({ req, workdir }); return { id: `r${ran.length}`, state: 'passed', summary: summary([['Pay', 'passed']]) }; },
        };
        const e = new MissionEngine(deps);
        const m = await e.start('automate-story', { project: 'shop', env: 'qa', story: 'As a buyer I pay' });
        await until(() => m.state === 'waiting');
        assert.deepEqual(notified, ['waiting']);
        const cp = m.checkpoints[0];
        assert.equal(cp.kind, 'plan');
        assert.throws(() => e.answer(m.id, 'nope', 'x', 'Tester'), /No such question/);
        e.answer(m.id, cp.id, 'Approved', 'Tester');
        await until(() => m.state === 'succeeded');
        assert.equal(m.reason, 'Done and verified.');
        assert.deepEqual(ran.map((r) => [r.req.features, r.workdir]), [[['test/shop/features/checkout.feature'], m.copy!.rel]], 'the Studio ran the proof in the mission copy');
        assert.deepEqual(m.changes, [{ status: 'A', path: 'test/shop/features/checkout.feature' }]);
        assert.ok(m.commit, 'committed on its branch: ' + JSON.stringify(m.timeline.filter((x) => x.kind === 'error')));
        assert.equal((await runGit(['log', '-1', '--format=%an', m.copy!.branch], { cwd: dir })).stdout.trim(), 'Tester');
        assert.ok(!fs.existsSync(path.join(dir, 'test/shop/features/checkout.feature')), 'the working copy is untouched');
        assert.match(await e.diff(m.id), /\+Feature: Checkout/);
        assert.equal(m.memory[0].state, 'proposed');
        assert.equal(e.memory(m.id, m.memory[0].id, true), 'The checkout page needs the cookie banner closed first.');
        assert.deepEqual(notified, ['waiting', 'succeeded']);
        // Brought in as changes; refused when the same file has changes in the working copy.
        const r = await e.apply(m.id, 'Tester');
        assert.deepEqual(r.files, ['test/shop/features/checkout.feature']);
        assert.ok(fs.existsSync(path.join(dir, 'test/shop/features/checkout.feature')));
        assert.equal((await runGit(['status', '--porcelain'], { cwd: dir })).stdout.trim(), '?? test/shop/features/checkout.feature');
        assert.ok(!fs.existsSync(path.resolve(dir, m.copy!.rel)), 'the copy is removed');
        await assert.rejects(e.apply(m.id, 'Tester'), /Already applied/);
        // Kept after a restart.
        assert.equal(new MissionEngine(deps).get(m.id)?.state, 'succeeded');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('verification fails: the failures go back to the agent, which fixes and reports again; attempts counted', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        let n = 0;
        const a = fakeAgent([
            async ({ tool, dir: wd }) => { fs.writeFileSync(path.join(wd, 'test/shop/features/a.feature'), 'Feature: A\n'); await tool('mission_report', { outcome: 'done', summary: 'v1' }); },
            async ({ tool, text }) => { assert.match(text, /verification failed[\s\S]*Locator #pay not found/i); await tool('mission_report', { outcome: 'done', summary: 'v2' }); },
        ]);
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: a.agent, log: () => undefined, tickMs: 50, runInfo: () => undefined,
            runTests: async () => (++n === 1 ? { id: 'r1', state: 'failed', summary: summary([['Pay', 'failed', 'Locator #pay not found']]) } : { id: 'r2', state: 'passed', summary: summary([['Pay', 'passed']]) }) });
        const m = await e.start('automate-story', { project: 'shop', env: 'qa', story: 'x' });
        await until(() => m.state === 'succeeded');
        assert.deepEqual(m.verifications.map((v) => v.passed), [false, true]);
        assert.equal(m.used.attempts, 2);
        assert.equal(m.report?.summary, 'v2');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('fix a failed run: reproduced first; only scenarios reported fixed are rerun; product bugs reported, not fixed', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        const failedRun = { id: 'run9', state: 'failed', request: { project: 'shop', env: 'qa' }, startedAt: '', summary: summary([['Login works', 'failed', 'timeout'], ['Total is right', 'failed', 'expected 10 got 11'], ['Search', 'passed']]) } as unknown as RunInfo;
        const ran: RunRequest[] = [];
        const a = fakeAgent([async ({ tool, dir: wd, text }) => {
            assert.match(text, /The Studio ran them again in your copy before you started: 2 still fail/);
            fs.writeFileSync(path.join(wd, 'test/shop/features/login.feature'), 'Feature: Login\n# fixed wait\n');
            await tool('mission_report', { outcome: 'done', summary: 'One test fixed, one application bug.', findings: [{ scenario: 'Login works', cause: 'test', detail: 'waited for a removed spinner', fixed: true }, { scenario: 'Total is right', cause: 'product', detail: 'tax added twice' }], bugs: [{ title: 'Tax added twice', detail: '...' }] });
        }]);
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: a.agent, log: () => undefined, tickMs: 50, runInfo: (id) => (id === 'run9' ? failedRun : undefined),
            runTests: async (req) => { ran.push(req); return ran.length === 1 ? { id: 'rep', state: 'failed', summary: summary([['Login works', 'failed'], ['Total is right', 'failed']]) } : { id: 'ver', state: 'passed', summary: summary([['Login works', 'passed']]) }; } });
        await assert.rejects(e.start('fix-failing', { run: 'nope' }), /No run nope/);
        const m = await e.start('fix-failing', { run: 'run9' });
        assert.deepEqual([m.inputs.project, m.inputs.env], ['shop', 'qa']);
        await until(() => m.state === 'succeeded');
        assert.deepEqual(ran.map((r) => r.scenarios), [['Login works', 'Total is right'], ['Login works']]);
        assert.equal(m.report?.bugs?.[0].title, 'Tax added twice');
        assert.deepEqual(m.changes.map((c) => c.path), ['test/shop/features/login.feature']);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('fix a failed run: failures that do not happen again end the mission without the agent; budget and silent agents stop missions', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        const failedRun = { id: 'run1', state: 'failed', request: { project: 'shop', env: 'qa' }, startedAt: '', summary: summary([['A', 'failed']]) } as unknown as RunInfo;
        let started = 0;
        const quiet = fakeAgent([]);
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: { ...quiet.agent, start: async (x) => { started++; return quiet.agent.start(x); } }, log: () => undefined, tickMs: 30, runInfo: () => failedRun,
            runTests: async () => ({ id: 'r', state: 'passed', summary: summary([['A', 'passed']]) }) });
        const m = await e.start('fix-failing', { run: 'run1' });
        await until(() => m.state === 'succeeded');
        assert.equal(started, 0, 'no agent needed');
        assert.equal(m.report?.findings?.[0].cause, 'flaky');
        // An agent that never reports: asked twice, then failed.
        const m2 = await e.start('automate-story', { project: 'shop', env: 'qa', story: 'x' });
        await until(() => m2.state === 'failed');
        assert.equal(m2.reason, 'The agent stopped without reporting a result.');
        assert.equal(quiet.sent.length, 3);
        // Over budget on model calls.
        let calls = 0;
        const busy = fakeAgent([async () => { calls = 500; await new Promise((r) => setTimeout(r, 300)); }], { calls: () => calls });
        const e2 = new MissionEngine({ repoRoot: dir, gitDir, agent: busy.agent, log: () => undefined, tickMs: 20, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed' }) });
        const m3 = await e2.start('automate-story', { project: 'shop', env: 'qa', story: 'x' }, { budget: { modelCalls: 10 } });
        await until(() => m3.state === 'over-budget');
        assert.match(m3.reason!, /500 model calls used \(the budget is 10\)/);
        await assert.rejects(e2.start('nope', {}), /No mission/);
        await assert.rejects(e2.start('automate-story', { project: 'shop' }), /Environment is needed/);
        await e2.discard(m3.id, 'Tester');
        assert.equal((await runGit(['branch', '--list', m3.copy!.branch], { cwd: dir })).stdout.trim(), '', 'branch deleted');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('model-call budget: every session stops at the call that reaches it (never more); a report made by then is still verified', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        // An agent that keeps calling the model (each call reported to the engine, as the runtime does) until stopped.
        const looping = (reportAt?: number) => {
            let calls = 0, aborted = false, opts: MissionSessionOptions | null = null;
            const agent: MissionAgent = {
                async start(x) { opts = x.mission; return { id: 'sess-b' }; },
                async send() {
                    setImmediate(async () => {
                        while (!aborted && calls < 100) {
                            calls++;
                            if (calls === reportAt) fs.writeFileSync(path.join(opts!.workdir, 'test/shop/features/b.feature'), 'Feature: B\n');
                            if (calls === reportAt) await opts!.tools.find((t) => t.name === 'mission_report')!.handler({ outcome: 'done', summary: 'in budget' });
                            opts!.onCall?.();
                            await new Promise((r) => setImmediate(r));
                        }
                    });
                },
                async abort() { aborted = true; },
                usageOf: () => ({ usage: { calls, inputTokens: 0, outputTokens: 0, cost: 0 }, busy: !aborted, pending: 0 }),
            };
            return { agent, calls: () => calls };
        };
        const a = looping();
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: a.agent, log: () => undefined, tickMs: 5000, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed', summary: summary([['Pay', 'passed']]) }) });
        const m = await e.start('automate-story', { project: 'shop', env: 'qa', story: 'x' }, { budget: { modelCalls: 10 } });
        await until(() => m.state === 'over-budget');
        assert.equal(a.calls(), 10, 'no call beyond the budget');
        assert.equal(m.used.modelCalls, 10);
        assert.match(m.reason!, /all 10 model calls of the budget are used \(10\)/);
        await e.discard(m.id, 'Tester');
        // The last call of the budget made the report: verified, not over budget.
        const b = looping(10);
        const e2 = new MissionEngine({ repoRoot: dir, gitDir, agent: b.agent, log: () => undefined, tickMs: 5000, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed', summary: summary([['Pay', 'passed']]) }) });
        const m2 = await e2.start('automate-story', { project: 'shop', env: 'qa', story: 'x' }, { budget: { modelCalls: 10 } });
        await until(() => m2.state === 'succeeded');
        assert.equal(b.calls(), 10);
        await e2.discard(m2.id, 'Tester');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('cron: fields, ranges, steps, lists, day-of-month or day-of-week', () => {
    assert.equal(parseCron('daily'), null);
    assert.equal(parseCron('60 * * * *'), null);
    assert.ok(parseCron('*/15 2-4 * * 1-5'));
    const d = new Date(2026, 10, 23, 2, 30); // Monday 23 Nov 2026 02:30
    assert.equal(cronMatches('30 2 * * 1-5', d), true);
    assert.equal(cronMatches('*/15 2 * * *', d), true);
    assert.equal(cronMatches('30 2 * * 0,6', d), false);
    assert.equal(cronMatches('30 2 1 * 1', d), true, 'day of month OR day of week');
    assert.equal(cronMatches('30 2 * * 7', new Date(2026, 10, 22, 2, 30)), true, '7 is Sunday');
});

test('triggers: a failed run starts its mission (filters, one at a time, a daily limit); schedules', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        fs.mkdirSync(path.join(dir, '.cs-studio'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.cs-studio/missions.json'), JSON.stringify({
            missions: [{ key: 'nightly-review', title: 'Nightly review', goal: 'Look at {project}', writes: false }],
            triggers: [{ mission: 'fix-failing', on: 'run-failed', envs: ['qa'], maxPerDay: 1 }, { mission: 'nightly-review', on: 'schedule', cron: '0 3 * * *', inputs: { project: 'shop', env: 'qa' } }],
        }));
        const a = fakeAgent([async ({ tool }) => { await tool('mission_report', { outcome: 'done', summary: 'ok', findings: [{ scenario: 'A', cause: 'product', detail: 'bug' }] }); }, async ({ tool }) => { await tool('mission_report', { outcome: 'done', summary: 'reviewed' }); }]);
        const run = (id: string, env: string, extra: Partial<RunInfo> = {}) => ({ id, state: 'failed', request: { project: 'shop', env }, startedAt: '', summary: summary([['A', 'failed']]), ...extra }) as unknown as RunInfo;
        const runs = new Map([['1', run('1', 'qa')], ['2', run('2', 'uat')], ['3', run('3', 'qa', { workdir: '.git/cs-studio/missions/x' })]]);
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: a.agent, log: () => undefined, tickMs: 50, runInfo: (id) => runs.get(id),
            runTests: async () => ({ id: 'rep', state: 'failed', summary: summary([['A', 'failed']]) }) });
        const t = new MissionTriggers(e, dir, () => undefined);
        assert.equal(await t.onRunEnded(runs.get('2')!), null, 'other environment');
        assert.equal(await t.onRunEnded(runs.get('3')!), null, 'a run in a mission copy');
        const m = (await t.onRunEnded(runs.get('1')!)) as MissionRun;
        assert.equal(m.trigger.kind, 'run-failed');
        await until(() => m.state === 'succeeded');
        assert.equal(await t.onRunEnded(runs.get('1')!), null, 'once a day');
        assert.deepEqual(await t.tick(new Date(2026, 10, 23, 2, 59)), []);
        const [s] = await t.tick(new Date(2026, 10, 23, 3, 0));
        assert.equal(s.key, 'nightly-review');
        assert.equal(s.copy, undefined, 'a read-only team mission has no copy');
        await until(() => s.state === 'succeeded');
        assert.equal(s.verifications[0].why, 'The team mission ends with its report.');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('mission routes: templates, start with a fake agent, answer, memory accepted into the team notes; agents cannot call missions', async () => {
    const { tmp, dir } = await repo();
    try {
        const { createServer } = await import('../src/server/server');
        const { SecretStore } = await import('../src/secrets/store');
        const { KeyFileProtector } = await import('../src/secrets/protector');
        fs.mkdirSync(path.join(dir, 'config/shop/environments'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'config/shop/environments/qa.env'), 'BASE_URL=http://localhost\n');
        const a = fakeAgent([async ({ tool }) => { await tool('memory_propose', { note: 'Use the qa2 tenant.' }); await tool('mission_report', { outcome: 'done', summary: 'gaps found', findings: [{ detail: 'Story 12 has no test' }] }); }]);
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'Tester', token: 'tk', missionAgent: a.agent, missionRunTests: async () => ({ id: 'x', state: 'passed' }) });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        const list = await call('GET', '/api/missions');
        assert.deepEqual(list.json.templates.map((t: { key: string }) => t.key), ['fix-failing', 'automate-story', 'heal-locators', 'flaky-hunter', 'coverage-gaps', 'review-pr', 'team-story', 'explore-app']);
        assert.equal((await call('POST', '/api/missions', { key: 'coverage-gaps', inputs: {} })).status, 400);
        const st = await call('POST', '/api/missions', { key: 'coverage-gaps', inputs: { project: 'shop', scope: 'sprint 12' } });
        assert.equal(st.status, 200, JSON.stringify(st.json));
        await until(() => false || true);
        let m: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (let i = 0; i < 200; i++) { m = (await call('GET', `/api/missions/${st.json.id}`)).json; if (m.state === 'succeeded') break; await new Promise((r) => setTimeout(r, 20)); }
        assert.equal(m.state, 'succeeded');
        assert.equal(m.report.findings[0].detail, 'Story 12 has no test');
        assert.equal((await call('POST', `/api/missions/${m.id}/memory/${m.memory[0].id}`, { accept: true })).status, 200);
        assert.match((await call('GET', '/api/missions-memory')).json.text, /# Notes for agents\n- Use the qa2 tenant\.\n/);
        assert.equal((await call('POST', `/api/missions/${m.id}/apply`, {})).status, 400, 'needs confirmation');
        assert.equal((await call('POST', `/api/missions/${m.id}/apply`, { confirm: true })).status, 400, 'nothing to bring in');
        const { isReadOnlyCall } = await import('../src/agents/tools');
        void isReadOnlyCall;
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('mission sessions: their own folder; Studio calls that would write into the working copy refused; file changes inside the copy need no approval, outside they ask; team notes in the instructions', async () => {
    const { AgentHost } = await import('../src/agents/host');
    const { writeFakeCopilotSdk } = await import('./fakeCopilot');
    delete (global as { __fakeCopilot?: unknown }).__fakeCopilot;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-host-'));
    try {
        const repoDir = path.join(home, 'repo'), copy = path.join(home, 'copy');
        fs.mkdirSync(path.join(repoDir, '.cs-studio'), { recursive: true }); fs.mkdirSync(copy);
        fs.writeFileSync(path.join(repoDir, '.cs-studio/agent-memory.md'), '- The app needs the cookie banner closed.\n');
        writeFakeCopilotSdk(path.join(home, 'rt'));
        const calls: string[] = [];
        const host = new AgentHost({ repoRoot: repoDir, home, runtimeDir: path.join(home, 'rt'), browser: { running: false } as never, secret: () => undefined, call: async (m, u) => { calls.push(`${m} ${u}`); return { status: 200, body: {} }; }, projects: () => [], log: () => undefined });
        const mine = { name: 'tests_run', description: 'in the copy', parameters: {}, handler: async () => 'ran in copy' };
        const { id: sid } = await host.createMission({ title: 'M', workflow: 'Goal', mission: { workdir: copy, isolated: true, autoFiles: true, tools: [mine] } });
        const cfg = (global as unknown as { __fakeCopilot: { lastConfig: any } }).__fakeCopilot.lastConfig; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.equal(cfg.workingDirectory, copy);
        assert.match(cfg.systemMessage.content, /cookie banner closed/);
        const tool = (n: string) => cfg.tools.find((t: { name: string }) => t.name === n);
        assert.equal(cfg.tools.filter((t: { name: string }) => t.name === 'tests_run').length, 1);
        assert.equal(await tool('tests_run').handler({}), 'ran in copy');
        const w = JSON.parse(await tool('studio_call').handler({ method: 'PUT', path: '/api/files', body: { path: 'x' } }));
        assert.equal(w.status, 409);
        assert.match(w.body, /your own copy of the repository/);
        await tool('studio_call').handler({ method: 'GET', path: '/api/runs' });
        assert.deepEqual(calls, ['GET /api/runs']);
        assert.deepEqual(await cfg.onPermissionRequest({ kind: 'write', fileName: path.join(copy, 'a.feature') }), { kind: 'approve-once' });
        assert.deepEqual(await cfg.onPermissionRequest({ kind: 'write', fileName: 'test/b.feature' }), { kind: 'approve-once' }, 'relative to the copy');
        let asked = false;
        void cfg.onPermissionRequest({ kind: 'write', fileName: path.join(repoDir, 'a.feature') }).then(() => { asked = true; });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(asked, false, 'outside the copy: waits for the person');
        // The repository's policy asks for every file change: no auto approval even in the copy.
        fs.writeFileSync(path.join(repoDir, '.cs-studio/agents-policy.json'), JSON.stringify({ approvals: { files: 'ask' } }));
        let asked2 = false;
        void cfg.onPermissionRequest({ kind: 'write', fileName: path.join(copy, 'c.feature') }).then(() => { asked2 = true; });
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(asked2, false);
        for (const aid of (host.events(sid) as { pending?: string[] }).pending ?? []) host.decide(sid, aid, 'reject');
        await until(() => asked && asked2);
        await host.stop();
    } finally { delete (global as { __fakeCopilot?: unknown }).__fakeCopilot; fs.rmSync(home, { recursive: true, force: true }); }
});

test('an approval the agent waits for makes the mission wait for the person; approved from the mission, it works on', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        let pending: Array<{ id: string; title: string; detail: string; kind: string }> = [];
        let resolve: (d: string) => void = () => undefined;
        const notified: string[] = [];
        const a = fakeAgent([async ({ tool, dir: wd }) => {
            pending = [{ id: 'ap1', title: 'Run: npm run lint', detail: 'npm run lint', kind: 'shell' }];
            const d = await new Promise<string>((r) => { resolve = r; });
            assert.equal(d, 'once');
            fs.writeFileSync(path.join(wd, 'test/shop/features/x.feature'), 'Feature: X\n');
            await tool('mission_report', { outcome: 'done', summary: 'ok' });
        }]);
        const agent: MissionAgent = { ...a.agent, pendingOf: () => pending, decide: (_s, id, d) => { pending = pending.filter((p) => p.id !== id); resolve(d); } };
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent, log: () => undefined, tickMs: 20, runInfo: () => undefined, notify: (m) => notified.push(m.state),
            runTests: async () => ({ id: 'r', state: 'passed', summary: summary([['X', 'passed']]) }) });
        const m = await e.start('automate-story', { project: 'shop', env: 'qa', story: 'x' });
        await until(() => m.state === 'waiting');
        assert.equal(m.approvals?.[0].title, 'Run: npm run lint');
        assert.deepEqual(notified, ['waiting']);
        assert.throws(() => e.approve(m.id, 'nope', 'once', 'Tester'), /No such approval/);
        e.approve(m.id, 'ap1', 'once', 'Tester');
        await until(() => m.state === 'succeeded');
        assert.ok(m.timeline.some((t) => t.text === 'Tester approved: Run: npm run lint'));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('queue: a second mission waits and starts when the first ends; a queued one can be taken out', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        const a = fakeAgent([
            async ({ tool }) => { await new Promise((r) => setTimeout(r, 150)); await tool('mission_report', { outcome: 'done', summary: 'one' }); },
            async ({ tool }) => { await tool('mission_report', { outcome: 'done', summary: 'two' }); },
        ]);
        let started = 0;
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: { ...a.agent, start: async (x) => { started++; return a.agent.start(x); } }, log: () => undefined, tickMs: 30, runInfo: () => undefined,
            runTests: async () => ({ id: 'r', state: 'passed' }) });
        const m1 = await e.start('coverage-gaps', { project: 'shop', scope: 'all' });
        await assert.rejects(e.start('coverage-gaps', { project: 'shop', scope: 'x' }), /queue this one/);
        const m2 = await e.start('coverage-gaps', { project: 'shop', scope: 'x' }, { queue: true });
        const m3 = await e.start('coverage-gaps', { project: 'shop', scope: 'y' }, { queue: true });
        assert.equal(m2.state, 'queued');
        await e.stop(m3.id, 'Tester');
        assert.equal(m3.state, 'stopped');
        await until(() => m1.state === 'succeeded' && m2.state === 'succeeded');
        assert.equal(started, 2, 'the third never started');
        assert.ok(m2.timeline[0].text.startsWith('Queued behind'));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('unattended (a pipeline): questions decided by the agent, plans go on, approvals refused; fix-failing runs the tests first; JUnit and Markdown', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        let pending: Array<{ id: string; title: string; detail: string; kind: string }> = [];
        const decided: string[] = [];
        const a = fakeAgent([async ({ tool, dir: wd, text }) => {
            assert.match(text, /The Studio ran them again in your copy before you started: 1 still fail/, 'the first run counts as the reproduction');
            assert.match(String(await tool('mission_ask', { question: 'Which account?' })), /Decide yourself/);
            pending = [{ id: 'p1', title: 'Run: rm -rf /', detail: '', kind: 'shell' }];
            await new Promise((r) => setTimeout(r, 120));
            fs.writeFileSync(path.join(wd, 'test/shop/features/login.feature'), 'Feature: Login\n# fixed\n');
            await tool('mission_report', { outcome: 'done', summary: 'Fixed the login wait.', findings: [{ scenario: 'Login', cause: 'test', detail: 'old wait', fixed: true }], bugs: [{ title: 'Typo on page', detail: 'Sign inn' }] });
        }]);
        const runs = new Map<string, RunInfo>();
        let n = 0;
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: { ...a.agent, pendingOf: () => pending, decide: (_s, id, d) => { decided.push(`${id}:${d}`); pending = []; } }, log: () => undefined, tickMs: 20,
            runInfo: (id) => runs.get(id),
            runTests: async (req) => {
                const id = `r${++n}`;
                const s = n === 1 ? summary([['Login', 'failed', 'timeout'], ['Home', 'passed']]) : summary([['Login', 'passed']]);
                runs.set(id, { id, state: n === 1 ? 'failed' : 'passed', request: req, startedAt: '', summary: s } as unknown as RunInfo);
                return { id, state: n === 1 ? 'failed' : 'passed', summary: s };
            } });
        await assert.rejects(e.start('fix-failing', { project: 'shop' }), /a project and environment/);
        const m = await e.start('fix-failing', { project: 'shop', env: 'qa', tags: '@smoke' }, { unattended: true, trigger: { kind: 'pipeline', by: 'ci' } });
        await until(() => m.state === 'succeeded');
        assert.equal(m.inputs.run, 'r1');
        assert.deepEqual(decided, ['p1:reject']);
        assert.equal(m.checkpoints[0].by, 'unattended');
        assert.equal(n, 2, 'the tests, then the verification: no second reproduction');
        const { missionJUnit, missionMarkdown } = await import('../src/agents/missions');
        assert.match(missionJUnit(m), /<testsuites name="CS Test Studio missions" tests="1" failures="0"/);
        assert.doesNotMatch(missionJUnit(m), /<failure/);
        const md = missionMarkdown(m);
        assert.match(md, /\*\*Done\*\* — Done and verified\. · verified by CS Test Studio/);
        assert.match(md, /\| Login \| test \| old wait \| yes \|/);
        assert.match(md, /- \*\*Typo on page\*\*: Sign inn/);
        assert.match(missionJUnit({ ...m, state: 'failed', reason: 'x < y' }), /<failure message="Failed: x &lt; y">/);
        // Nothing failed: done without the agent.
        const m2 = await e.start('fix-failing', { project: 'shop', env: 'qa' }, { unattended: true });
        n = 5; // the next run passes
        await until(() => m2.state === 'succeeded');
        assert.equal(m2.reason, 'Nothing failed.');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a bug from a mission\'s report filed in Azure DevOps (confirmed once; tagged; recorded on the mission)', async () => {
    const { tmp, dir } = await repo();
    try {
        const { createServer } = await import('../src/server/server');
        const { SecretStore } = await import('../src/secrets/store');
        const { KeyFileProtector } = await import('../src/secrets/protector');
        fs.mkdirSync(path.join(dir, 'config/shop/environments'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\nADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
        fs.writeFileSync(path.join(dir, 'config/shop/environments/qa.env'), 'ENVIRONMENT=qa\n');
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        store.set({ name: 'ADO_PAT' }, 'pat-1');
        const posted: Array<{ url: string; body: string }> = [];
        const transport = async (req: { url: string; body?: string | Buffer }) => { posted.push({ url: req.url, body: String(req.body ?? '') }); return { status: 200, body: JSON.stringify({ id: 4242 }) }; };
        const a = fakeAgent([async ({ tool }) => { await tool('mission_report', { outcome: 'done', summary: 'Found one.', findings: [{ scenario: 'Total', cause: 'product', detail: 'tax twice' }], bugs: [{ title: 'Tax added twice', detail: 'Cart total includes tax twice' }] }); }]);
        const srv = createServer({ repoRoot: dir, store, userName: 'Tester', token: 'tk', adoTransport: transport as never, missionAgent: a.agent, missionRunTests: async () => ({ id: 'x', state: 'passed' }) });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        const st = await call('POST', '/api/missions', { key: 'coverage-gaps', inputs: { project: 'shop', scope: 'all' } });
        let m: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (let i = 0; i < 200; i++) { m = (await call('GET', `/api/missions/${st.json.id}`)).json; if (m.state === 'succeeded') break; await new Promise((r) => setTimeout(r, 20)); }
        assert.equal((await call('POST', `/api/missions/${m.id}/bugs/0`, {})).status, 400, 'needs confirmation');
        assert.equal((await call('POST', `/api/missions/${m.id}/bugs/7`, { confirm: true })).status, 400);
        const r = await call('POST', `/api/missions/${m.id}/bugs/0`, { confirm: true });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.id, 4242);
        const req = posted.find((p) => /workitems\/\$Bug/.test(decodeURIComponent(p.url)))!;
        assert.match(req.body, /Tax added twice/);
        assert.match(req.body, /automation; cs-mission; cs-mission-/);
        assert.match(req.body, /tax twice/);
        assert.equal((await call('GET', `/api/missions/${m.id}`)).json.report.bugs[0].filed.id, 4242);
        assert.equal((await call('POST', `/api/missions/${m.id}/bugs/0`, { confirm: true })).status, 400, 'once');
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('unattended mission sessions refuse what would ask the person, at once, and say why; read-only requests still pass', async () => {
    const { AgentHost } = await import('../src/agents/host');
    const { writeFakeCopilotSdk } = await import('./fakeCopilot');
    delete (global as { __fakeCopilot?: unknown }).__fakeCopilot;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-unatt-'));
    try {
        const repoDir = path.join(home, 'repo'), copy = path.join(home, 'copy');
        fs.mkdirSync(repoDir); fs.mkdirSync(copy);
        writeFakeCopilotSdk(path.join(home, 'rt'));
        const events: string[] = [];
        const host = new AgentHost({ repoRoot: repoDir, home, runtimeDir: path.join(home, 'rt'), browser: { running: false } as never, secret: () => undefined, call: async () => ({ status: 200, body: {} }), projects: () => [], log: () => undefined });
        await host.createMission({ title: 'M', workflow: 'Goal', mission: { workdir: copy, isolated: true, autoFiles: true, unattended: true, tools: [], listener: (e) => { if (e.type === 'info') events.push(e.text); } } });
        const cfg = (global as unknown as { __fakeCopilot: { lastConfig: any } }).__fakeCopilot.lastConfig; // eslint-disable-line @typescript-eslint/no-explicit-any
        const shell = await cfg.onPermissionRequest({ kind: 'shell', fullCommandText: 'rm -rf build' });
        assert.equal(shell.kind, 'reject');
        assert.match(shell.feedback, /unattended run \(no one can approve\)/);
        assert.deepEqual(events, ['Refused (unattended): Run: rm -rf build']);
        assert.deepEqual(await cfg.onPermissionRequest({ kind: 'read', path: 'x' }), { kind: 'approve-once' });
        assert.deepEqual(await cfg.onPermissionRequest({ kind: 'write', fileName: path.join(copy, 'a.feature') }), { kind: 'approve-once' }, 'its own copy still works');
        assert.equal((await cfg.onPermissionRequest({ kind: 'write', fileName: path.join(repoDir, 'b.feature') })).kind, 'reject', 'outside its copy: refused, not waiting');
        const call = await cfg.tools.find((t: { name: string }) => t.name === 'studio_call').handler({ method: 'POST', path: '/api/ado/workitems', body: {} });
        assert.match(String(call), /^Not done: this is an unattended run/, 'a Studio change that needs approval is refused, and the agent is told why');
        assert.equal(events.at(-1), 'Refused (unattended): POST /api/ado/workitems');
        await host.stop();
    } finally { delete (global as { __fakeCopilot?: unknown }).__fakeCopilot; fs.rmSync(home, { recursive: true, force: true }); }
});
