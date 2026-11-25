/**
 * QA round 7 (agents): an agent's tool groups hold for every Studio tool (Run tests, Change files), "Approve for this
 * conversation" covers only that command (one that writes files always asks again), a finished mission waits for no
 * approval, a read-only mission does not claim a fix, two explorers each keep their steps in the timeline.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentHost, approvalKey, commandWrites, FILE_WRITE_TOOLS, type MissionSessionOptions } from '../src/agents/host';
import { saveAgent, type AgentProfile } from '../src/agents/builder';
import { MissionEngine, type MissionAgent } from '../src/agents/missions';
import type { ToolDef } from '../src/agents/tools';
import { writeFakeCopilotSdk } from './fakeCopilot';
import { runGit } from '../src/git/run';

const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastConfig = (): any => (global as unknown as { __fakeCopilot: { lastConfig: unknown } }).__fakeCopilot.lastConfig;
const READER: AgentProfile = { id: 'reader', name: 'Reader', instructions: 'Read the Studio and answer the question.', tools: ['knowledge', 'studio-read'] };
const TESTER: AgentProfile = { id: 'tester', name: 'Tester', instructions: 'Run the tests and report.', tools: ['knowledge', 'studio-read', 'tests', 'files'] };

function setup() {
    delete (global as { __fakeCopilot?: unknown }).__fakeCopilot;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-qa7-'));
    const repoDir = path.join(home, 'repo');
    fs.mkdirSync(path.join(repoDir, '.cs-studio'), { recursive: true });
    writeFakeCopilotSdk(path.join(home, 'rt'));
    const calls: Array<[string, string]> = [];
    const host = new AgentHost({
        repoRoot: repoDir, home, runtimeDir: path.join(home, 'rt'), browser: { running: false } as never, secret: () => undefined,
        call: async (m, u) => { calls.push([m, u]); return { status: 200, body: { id: 'run-1', state: 'passed' } }; }, projects: () => [], log: () => undefined,
    });
    const cleanup = async () => { await host.stop().catch(() => undefined); delete (global as { __fakeCopilot?: unknown }).__fakeCopilot; fs.rmSync(home, { recursive: true, force: true }); };
    return { host, home, repoDir, calls, cleanup };
}

const missionTool = (ran: string[]): ToolDef => ({ name: 'tests_run', description: 'Run tests', parameters: {}, skipPermission: true, handler: async () => { ran.push('ran'); return 'ran'; } });
const missionOpts = (repoDir: string, profile: AgentProfile, ran: string[]): MissionSessionOptions => ({
    workdir: repoDir, isolated: false, autoFiles: false, profile,
    tools: [missionTool(ran), { name: 'mission_report', description: 'Report', parameters: {}, skipPermission: true, handler: async () => 'ok' }],
});

test('a mission agent without "Run tests" cannot start a run: tests_run is not offered, and a run through the Studio is refused', async () => {
    const { host, repoDir, calls, cleanup } = setup();
    try {
        const ran: string[] = [];
        await host.createMission({ title: 'Mission: QA7', workflow: 'Check', mission: missionOpts(repoDir, READER, ran) });
        const cfg = lastConfig();
        const names = cfg.tools.map((t: { name: string }) => t.name);
        assert.ok(!names.includes('tests_run'), 'the mission\'s own tests_run is not offered without "Run tests"');
        assert.ok(names.includes('mission_report'), 'the mission\'s own tools of no group stay');
        // Starting a run through the Studio's API is a change: refused for an agent that only reads the Studio.
        const call = cfg.tools.find((t: { name: string }) => t.name === 'studio_call');
        const r = await call.handler({ method: 'POST', path: '/api/runs', body: { project: 'shop', env: 'qa' } });
        assert.match(String(r), /may only read through the Studio/);
        assert.ok(!calls.some(([m]) => m === 'POST'), 'no run was started');
        assert.deepEqual(ran, []);
        // An agent with "Run tests" gets it.
        await host.createMission({ title: 'Mission: tester', workflow: 'Check', mission: missionOpts(repoDir, TESTER, ran) });
        const cfg2 = lastConfig();
        const t = cfg2.tools.find((x: { name: string }) => x.name === 'tests_run');
        assert.ok(t, 'offered with "Run tests"');
        await t.handler({});
        assert.deepEqual(ran, ['ran']);
    } finally { await cleanup(); }
});

test('the mission engine refuses tests_run itself for an agent without "Run tests" (defence in depth)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa7-tests-'));
    const dir = path.join(tmp, 'shop-tests');
    try {
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
        saveAgent(dir, { id: 'qa7-mission', name: 'QA7 Mission', mode: 'mission', instructions: 'Read the repository and report what you find, nothing else.', goal: 'Check {project} quickly', tools: ['knowledge', 'studio-read'], writes: false, inputs: [{ key: 'project', label: 'Project', required: true, kind: 'project' }, { key: 'env', label: 'Environment', required: true, kind: 'env' }] }, 'Tester', { isNew: true });
        await runGit(['add', '-A'], { cwd: dir });
        await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
        let opts: MissionSessionOptions | null = null;
        let answer: unknown = null;
        const ran: unknown[] = [];
        const agent: MissionAgent = {
            async start(x) { opts = x.mission; return { id: 's1' }; },
            async send() {
                setImmediate(async () => {
                    const tool = (n: string, a: unknown) => opts!.tools.find((t) => t.name === n)!.handler(a) as Promise<unknown>;
                    if (answer === null) {
                        answer = await tool('tests_run', { project: 'shop', env: 'qa' });
                        await tool('mission_report', { outcome: 'done', summary: 'Looked at the repository.' });
                    }
                    opts!.listener?.({ type: 'idle', seq: 1, at: Date.now() });
                });
            },
            async abort() { /* done */ },
            usageOf: () => ({ usage: { calls: 1, inputTokens: 1, outputTokens: 1, cost: 0 }, busy: false, pending: 0 }),
        };
        const e = new MissionEngine({ repoRoot: dir, gitDir: path.join(dir, '.git'), agent, log: () => undefined, tickMs: 30, runInfo: () => undefined, runTests: async (req) => { ran.push(req); return { id: 'r', state: 'passed' }; } });
        const m = await e.start('qa7-mission', { project: 'shop', env: 'qa' });
        await until(() => m.state === 'succeeded');
        assert.match(String(answer), /^Refused: this agent is not allowed to run tests/);
        assert.deepEqual(ran, [], 'no run');
        assert.ok(m.timeline.some((x) => /may not run tests/.test(x.text)));
        // Verified on the report alone: said so, and not called a team mission.
        assert.equal(m.verifications[0].why, 'A read-only mission: the report is the result.');
        assert.equal(m.verifications[0].reportOnly, true);
        assert.doesNotMatch(m.reason!, /verified/i);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('an agent without "Change files" cannot edit: the file tools are not offered, and an edit is refused before it runs', async () => {
    const { host, repoDir, cleanup } = setup();
    try {
        const { id } = await host.createMission({ title: 'Mission: QA7', workflow: 'Check', mission: missionOpts(repoDir, READER, []) });
        const cfg = lastConfig();
        for (const t of ['edit', 'create']) assert.ok(cfg.excludedTools.includes(t), `${t} is not offered`);
        const pre = await cfg.hooks.onPreToolUse({ toolName: 'edit', toolArgs: { path: 'test/shoplab/features/catalog.feature', old_str: 'a', new_str: 'b' } }, { sessionId: id });
        assert.equal(pre.permissionDecision, 'deny');
        assert.match(pre.permissionDecisionReason, /not allowed to change files/);
        const perm = await cfg.onPermissionRequest({ kind: 'write', fileName: 'x.txt' });
        assert.equal(perm.kind, 'reject');
        const ev = host.events(id) as { events: Array<{ type: string; text?: string }> };
        assert.ok(ev.events.some((e) => e.type === 'info' && /^Not allowed for Reader: edit/.test(e.text ?? '')));
        // An agent with "Change files": the file tools are there and not refused by the hook.
        await host.createMission({ title: 'Mission: tester', workflow: 'Check', mission: missionOpts(repoDir, TESTER, []) });
        const cfg2 = lastConfig();
        assert.ok(!(cfg2.excludedTools ?? []).some((t: string) => FILE_WRITE_TOOLS.includes(t)));
        assert.equal(await cfg2.hooks.onPreToolUse({ toolName: 'edit', toolArgs: { path: 'x' } }, { sessionId: 'x' }), undefined);
    } finally { await cleanup(); }
});

test('commands that write files are recognised', () => {
    for (const c of ['echo x > file', 'echo x >> log.txt', 'ls | tee out.txt', 'rm -rf build', 'mv a b', 'cp a b', 'sed -i s/a/b/ f', 'git commit -m x', 'git checkout main', 'git branch new-one', 'npm install', 'touch x', 'cat a &> b', 'git -C dir status'])
        assert.equal(commandWrites(c), true, c);
    for (const c of ['git status --short', 'git log --oneline -5', 'ls -la', 'cat README.md', 'grep -rn foo src', 'git diff HEAD~1', 'wc -l README.md 2>/dev/null', 'git branch -a', 'ls 2>&1', 'git status --short 2>/dev/null'])
        assert.equal(commandWrites(c), false, c);
    assert.equal(approvalKey('shell', 'Run: git status --short', 'git status --short'), 'shell:git status --short');
    assert.equal(approvalKey('shell', 'Run: echo x > f', 'echo x > f'), null);
    assert.equal(approvalKey('plan', 'Approve the test plan: a.feature', ''), null);
});

test('"Approve for this conversation" on git status --short covers that command only: another command asks, and echo x > file always asks', async () => {
    const { host, cleanup } = setup();
    try {
        const { id } = await host.create({ title: 'Copilot' });
        const cfg = lastConfig();
        const approvals = () => (host.events(id) as { events: Array<{ type: string; id?: string; title?: string; once?: boolean }> }).events.filter((e) => e.type === 'approval');
        const run = (command: string) => { let d: { permissionDecision: string } | undefined; void cfg.hooks.onPreToolUse({ toolName: 'bash', toolArgs: { command } }, { sessionId: id }).then((x: { permissionDecision: string }) => { d = x; }); return () => d; };
        // 1. git status --short: asked, approved for the conversation.
        const first = run('git status --short');
        await later(50);
        assert.equal(first(), undefined);
        assert.equal(approvals().length, 1);
        assert.notEqual(approvals()[0].once, true, 'can be approved for the conversation');
        host.decide(id, approvals()[0].id!, 'session');
        await until(() => !!first());
        assert.equal(first()!.permissionDecision, 'allow');
        // 2. The same command again: not asked.
        const again = run('git status --short');
        await until(() => !!again());
        assert.equal(again()!.permissionDecision, 'allow');
        assert.equal(approvals().length, 1, 'not asked again');
        // 3. A command that writes a file: asked (and it can only be approved once).
        const write = run('echo unattended > shell-wrote.txt');
        await later(50);
        assert.equal(write(), undefined, 'waits for the person');
        assert.equal(approvals().length, 2);
        const w = approvals()[1];
        assert.equal(w.title, 'Run: echo unattended > shell-wrote.txt');
        assert.equal(w.once, true, 'no "for this conversation" for a command that writes files');
        host.decide(id, w.id!, 'session');
        await until(() => !!write());
        assert.equal(write()!.permissionDecision, 'allow');
        // …and the next time, it asks again.
        const write2 = run('echo unattended > shell-wrote.txt');
        await later(50);
        assert.equal(write2(), undefined, 'asked again');
        host.decide(id, approvals()[2].id!, 'reject');
        await until(() => !!write2());
        assert.equal(write2()!.permissionDecision, 'deny');
        // 4. Another read-only command: asked too.
        const other = run('git log --oneline -3');
        await later(50);
        assert.equal(other(), undefined, 'a different command asks');
        host.decide(id, approvals()[3].id!, 'reject');
        await until(() => !!other());
    } finally { await cleanup(); }
});

test('a stopped mission waits for no approval: its approvals are cleared (also after a restart) and approving says it ended', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa7-stop-'));
    const dir = path.join(tmp, 'shop-tests');
    try {
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
        await runGit(['add', '-A'], { cwd: dir });
        await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
        const decided: string[] = [];
        let pending = [{ id: 'ap1', title: 'Run: git status --short', detail: 'git status --short', kind: 'shell' }];
        const agent: MissionAgent = {
            async start() { return { id: 's1' }; },
            async send() { /* waits */ },
            async abort() { /* stopped */ },
            usageOf: () => ({ usage: { calls: 1, inputTokens: 1, outputTokens: 1, cost: 0 }, busy: true, pending: pending.length }),
            pendingOf: () => pending,
            decide: (_s, aid, d) => { decided.push(`${aid}:${d}`); pending = []; },
        };
        const deps = { repoRoot: dir, gitDir: path.join(dir, '.git'), agent, log: () => undefined, tickMs: 30, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed' }) };
        const e = new MissionEngine(deps);
        const m = await e.start('coverage-gaps', { project: 'shop', scope: 'the current sprint' });
        await until(() => m.state === 'waiting' && !!m.approvals?.length);
        await e.stop(m.id, 'Tester');
        assert.equal(m.state, 'stopped');
        assert.deepEqual(m.approvals, [], 'closed with the mission');
        assert.deepEqual(decided, ['ap1:reject'], 'the agent was told no');
        assert.throws(() => e.approve(m.id, 'ap1', 'once', 'Tester'), /The mission has ended \(stopped\): it waits for no approval any more/);
        // An older file that still lists approvals of a finished mission: read without them.
        const file = path.join(dir, '.git', 'cs-studio', 'missions.json');
        const runs = JSON.parse(fs.readFileSync(file, 'utf8'));
        runs[0].approvals = [{ id: 'old', title: 'x', detail: '', kind: 'shell' }];
        fs.writeFileSync(file, JSON.stringify(runs));
        const e2 = new MissionEngine(deps);
        assert.deepEqual(e2.get(m.id)!.approvals, []);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('two explorers at once: each one\'s steps stay in the timeline (named apart); one note is "1 note"; refused calls are marked', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa7-explore-'));
    const dir = path.join(tmp, 'shop-tests');
    try {
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
        await runGit(['add', '-A'], { cwd: dir });
        await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
        let n = 0, seq = 0;
        const logged: unknown[] = [];
        const sessions = new Map<string, { title: string; o: MissionSessionOptions; step: number }>();
        const agent: MissionAgent = {
            async start(x) { const id = `s${++n}`; sessions.set(id, { title: x.title, o: x.mission, step: 0 }); return { id }; },
            async send(id, text) {
                const s = sessions.get(id)!;
                const tool = (t: string, a: unknown) => s.o.tools.find((x) => x.name === t)!.handler(a) as Promise<unknown>;
                setImmediate(async () => {
                    if (s.title.endsWith(': Application explorer')) {
                        const call = `c${++seq}`;
                        s.o.listener?.({ type: 'tool-start', id: call, tool: 'browser_open', args: JSON.stringify({ url: `http://127.0.0.1/${text.slice(0, 6).replace(/\W/g, '')}` }), seq: ++seq, at: Date.now() });
                        s.o.listener?.({ type: 'tool-end', id: call, ok: true, result: 'opened', seq: ++seq, at: Date.now() });
                        await later(40);
                        logged.push(await tool('explore_note', { kind: 'covered', title: text.slice(0, 20) }));
                        s.o.listener?.({ type: 'assistant', text: 'Toured.', seq: ++seq, at: Date.now() });
                    } else if (s.step++ === 0) {
                        // A refused call of the lead.
                        s.o.listener?.({ type: 'tool-start', id: 'lead-1', tool: 'bash', args: '{"command":"git status"}', seq: ++seq, at: Date.now() });
                        s.o.listener?.({ type: 'tool-end', id: 'lead-1', ok: false, result: 'Denied by preToolUse hook: The agent "Explorer" is not allowed to run commands.', seq: ++seq, at: Date.now() });
                        await Promise.all([
                            tool('team_delegate', { member: 'explorer', task: 'Tour 1: the cart with wrong quantities.' }),
                            tool('team_delegate', { member: 'explorer', task: 'Tour 2: the cart after back and refresh.' }),
                        ]);
                        await tool('mission_report', { outcome: 'done', summary: 'Covered the cart.' });
                    }
                    s.o.listener?.({ type: 'idle', seq: ++seq, at: Date.now() });
                });
            },
            async abort() { /* done */ },
            usageOf: (id) => (sessions.has(id) ? { usage: { calls: 1, inputTokens: 1, outputTokens: 1, cost: 0 }, busy: false, pending: 0 } : null),
        };
        const newBrowser = () => ({ pageNow: () => ({}), screenshot: async () => Buffer.from('png'), close: async () => undefined }) as never;
        const e = new MissionEngine({ repoRoot: dir, gitDir: path.join(dir, '.git'), agent, log: () => undefined, tickMs: 30, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed' }), newBrowser });
        const m = await e.start('explore-app', { project: 'shop', env: 'qa', charter: 'The cart', explorers: '2' });
        await until(() => m.state === 'succeeded');
        const opens = m.timeline.filter((x) => x.kind === 'tool' && / browser_open /.test(x.text)).map((x) => x.text.split(':')[0]);
        assert.deepEqual(opens.sort(), ['Application explorer 1', 'Application explorer 2'], m.timeline.map((x) => x.text).join('\n'));
        assert.ok(logged.some((x) => /^Logged \(1 note\)\./.test(String(x))), String(logged));
        assert.ok(logged.some((x) => /^Logged \(2 notes\)\./.test(String(x))));
        const refused = m.timeline.find((x) => x.text.startsWith('bash '))!;
        assert.equal(refused.refused, true);
        assert.match(refused.text, /— refused: The agent "Explorer" is not allowed to run commands/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a read-only mission cannot claim a fix: asked to correct its report once, then the report says nothing was changed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa7-claim-'));
    const dir = path.join(tmp, 'shop-tests');
    try {
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
        await runGit(['add', '-A'], { cwd: dir });
        await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
        let opts: MissionSessionOptions | null = null;
        const answers: unknown[] = [];
        const agent: MissionAgent = {
            async start(x) { opts = x.mission; return { id: 's1' }; },
            async send() {
                setImmediate(async () => {
                    const tool = (n: string, a: unknown) => opts!.tools.find((t) => t.name === n)!.handler(a) as Promise<unknown>;
                    if (answers.length < 2) {
                        const report = { outcome: 'done', summary: 'Updated the expected path; the scenario passes.', findings: [{ scenario: 'Catalog', cause: 'test', detail: 'Expected v1', fixed: true }] };
                        answers.push(await tool('mission_report', report));
                        if (answers.length === 1) answers.push(await tool('mission_report', report));
                    }
                    opts!.listener?.({ type: 'idle', seq: 1, at: Date.now() });
                });
            },
            async abort() { /* done */ },
            usageOf: () => ({ usage: { calls: 1, inputTokens: 1, outputTokens: 1, cost: 0 }, busy: false, pending: 0 }),
        };
        const e = new MissionEngine({ repoRoot: dir, gitDir: path.join(dir, '.git'), agent, log: () => undefined, tickMs: 30, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed' }) });
        const m = await e.start('coverage-gaps', { project: 'shop', scope: 'the current sprint' });
        await until(() => m.state === 'succeeded');
        assert.match(String(answers[0]), /^Not reported: this mission only reads/);
        assert.match(m.report!.summary, /^Nothing was changed \(this mission only reads\)\. The agent reported: Updated/);
        assert.equal(m.report!.findings![0].fixed, false);
        assert.equal(m.verifications.at(-1)!.reportOnly, true);
        assert.match(m.reason!, /^Done: reported \(the mission only reads: nothing was changed\); no test run verifies it\.$/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a read-only mission whose agent stops instead of correcting its claim ends with the corrected report (not a failure)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa7-claim2-'));
    const dir = path.join(tmp, 'shop-tests');
    try {
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
        await runGit(['add', '-A'], { cwd: dir });
        await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
        let opts: MissionSessionOptions | null = null;
        const answers: unknown[] = [];
        const agent: MissionAgent = {
            async start(x) { opts = x.mission; return { id: 's1' }; },
            async send() {
                setImmediate(async () => {
                    const tool = (n: string, a: unknown) => opts!.tools.find((t) => t.name === n)!.handler(a) as Promise<unknown>;
                    if (answers.length < 2) {
                        const report = { outcome: 'done', summary: 'Updated the expected path; the scenario passes.', findings: [{ scenario: 'Catalog', cause: 'test', detail: 'Expected v1', fixed: true }] };
                        answers.push(await tool('mission_report', report));
                        /* stops instead of reporting again */
                    }
                    opts!.listener?.({ type: 'idle', seq: 1, at: Date.now() });
                });
            },
            async abort() { /* done */ },
            usageOf: () => ({ usage: { calls: 1, inputTokens: 1, outputTokens: 1, cost: 0 }, busy: false, pending: 0 }),
        };
        const e = new MissionEngine({ repoRoot: dir, gitDir: path.join(dir, '.git'), agent, log: () => undefined, tickMs: 30, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed' }) });
        const m = await e.start('coverage-gaps', { project: 'shop', scope: 'the current sprint' });
        await until(() => m.state === 'succeeded');
        assert.match(String(answers[0]), /^Not reported: this mission only reads/);
        assert.match(m.report!.summary, /^Nothing was changed \(this mission only reads\)\. The agent reported: Updated/);
        assert.equal(m.report!.findings![0].fixed, false);
        assert.equal(m.verifications.at(-1)!.reportOnly, true);
        assert.match(m.reason!, /^Done: reported \(the mission only reads: nothing was changed\); no test run verifies it\.$/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
