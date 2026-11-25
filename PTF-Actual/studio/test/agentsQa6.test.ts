/**
 * QA round 6 (agents): commands only through the permission check (tool group + "runs commands" setting),
 * evaluations never run commands, tool servers only for agents that use them (and a broken one fails fast),
 * "Explorers at once" as a real limit.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentHost, SHELL_TOOLS, type MissionSessionOptions } from '../src/agents/host';
import { EvalRunner, saveSuite } from '../src/agents/evals';
import { saveAgent, type AgentProfile } from '../src/agents/builder';
import { MissionEngine, type MissionAgent } from '../src/agents/missions';
import { writeFakeCopilotSdk } from './fakeCopilot';
import { runGit } from '../src/git/run';

const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastConfig = (): any => (global as unknown as { __fakeCopilot: { lastConfig: unknown } }).__fakeCopilot.lastConfig;
const READER: AgentProfile = { id: 'reader', name: 'Reader', instructions: 'Read the Studio and answer the question.', tools: ['knowledge', 'studio-read'] };
const SHELLER: AgentProfile = { id: 'sheller', name: 'Sheller', instructions: 'Run commands to answer the question.', tools: ['knowledge', 'studio-read', 'shell'] };

function setup(o: { probe?: (name: string, ms: number) => Promise<{ ok: boolean; error?: string }>; servers?: string[] } = {}) {
    delete (global as { __fakeCopilot?: unknown }).__fakeCopilot;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-qa6-'));
    const repoDir = path.join(home, 'repo');
    fs.mkdirSync(path.join(repoDir, '.cs-studio'), { recursive: true });
    writeFakeCopilotSdk(path.join(home, 'rt'));
    const logs: string[] = [];
    const host = new AgentHost({
        repoRoot: repoDir, home, runtimeDir: path.join(home, 'rt'), browser: { running: false } as never, secret: () => undefined,
        call: async () => ({ status: 200, body: {} }), projects: () => [], log: (_a, t) => logs.push(t),
        toolServers: () => (o.servers ?? []).map((name) => ({ name, changes: true, config: { type: 'local', command: 'node' } })),
        ...(o.probe ? { probeToolServer: o.probe } : {}),
    });
    const cleanup = async () => { await host.stop().catch(() => undefined); delete (global as { __fakeCopilot?: unknown }).__fakeCopilot; fs.rmSync(home, { recursive: true, force: true }); };
    return { host, home, repoDir, logs, cleanup };
}

test('an agent without "Run commands" cannot run any command: the runtime\'s command tools are not offered, and a call is refused (even one the runtime thinks read-only)', async () => {
    const { host, cleanup } = setup();
    try {
        const { id } = await host.create({ title: 'Reader chat', profile: READER });
        const cfg = lastConfig();
        for (const t of SHELL_TOOLS) assert.ok(cfg.excludedTools.includes(t), `${t} is not offered`);
        assert.ok(cfg.excludedTools.includes('task'), 'no sub-agent that could run commands either');
        const pre = await cfg.hooks.onPreToolUse({ toolName: 'bash', toolArgs: { command: 'git status --short' } }, { sessionId: id });
        assert.equal(pre.permissionDecision, 'deny');
        assert.match(pre.permissionDecisionReason, /not allowed to run commands/);
        const perm = await cfg.onPermissionRequest({ kind: 'shell', fullCommandText: 'git status --short' });
        assert.equal(perm.kind, 'reject');
        assert.equal((host.events(id) as { pending?: string[] }).pending?.length ?? 0, 0, 'nothing waits for the person: refused');
        // Other tools are not touched by the hook.
        assert.equal(await cfg.hooks.onPreToolUse({ toolName: 'view', toolArgs: { path: 'x' } }, { sessionId: id }), undefined);
    } finally { await cleanup(); }
});

test('"runs commands: Ask me": every command waits for the person, a read-only one too; approved once, the runtime is not asked again; rejected, it does not run', async () => {
    const { host, cleanup } = setup();
    try {
        const { id } = await host.create({ title: 'Copilot' });
        const cfg = lastConfig();
        assert.equal(cfg.excludedTools, undefined, 'the default Copilot may run commands (with approval)');
        let decided: { permissionDecision: string } | undefined;
        void cfg.hooks.onPreToolUse({ toolName: 'bash', toolArgs: { command: 'git status --short', description: 'read-only check' } }, { sessionId: id }).then((d: { permissionDecision: string }) => { decided = d; });
        await later(60);
        assert.equal(decided, undefined, 'waits for the person');
        const ev = host.events(id) as { events: Array<{ type: string; id?: string; title?: string; kind?: string }> };
        const ap = ev.events.find((e) => e.type === 'approval')!;
        assert.equal(ap.title, 'Run: git status --short');
        assert.equal(ap.kind, 'shell');
        host.decide(id, ap.id!, 'once');
        await until(() => !!decided);
        assert.equal(decided!.permissionDecision, 'allow');
        // The runtime asks too for this command: decided already, not asked twice.
        assert.deepEqual(await cfg.onPermissionRequest({ kind: 'shell', fullCommandText: 'git status --short' }), { kind: 'approve-once' });
        // The same command again: asks again (approved once only).
        let second: { permissionDecision: string } | undefined;
        void cfg.hooks.onPreToolUse({ toolName: 'bash', toolArgs: { command: 'git status --short' } }, { sessionId: id }).then((d: { permissionDecision: string }) => { second = d; });
        await later(60);
        assert.equal(second, undefined);
        const ap2 = (host.events(id) as { events: Array<{ type: string; id?: string }> }).events.filter((e) => e.type === 'approval').at(-1)!;
        host.decide(id, ap2.id!, 'reject');
        await until(() => !!second);
        assert.equal(second!.permissionDecision, 'deny');
        // Input typed into a running shell is a command too.
        let typed: { permissionDecision: string } | undefined;
        void cfg.hooks.onPreToolUse({ toolName: 'write_bash', toolArgs: { input: 'rm -rf build\n' } }, { sessionId: id }).then((d: { permissionDecision: string }) => { typed = d; });
        await later(60);
        assert.equal(typed, undefined, 'asks');
        const ap3 = (host.events(id) as { events: Array<{ type: string; id?: string }> }).events.filter((e) => e.type === 'approval').at(-1)!;
        host.decide(id, ap3.id!, 'reject');
        await until(() => !!typed);
        assert.equal(typed!.permissionDecision, 'deny');
    } finally { await cleanup(); }
});

test('an agent with "Run commands" asks too; "Never" turns commands off for every agent', async () => {
    const { host, home, cleanup } = setup();
    try {
        const { id } = await host.create({ title: 'Sheller chat', profile: SHELLER });
        const cfg = lastConfig();
        assert.ok(!(cfg.excludedTools ?? []).includes('bash'), 'its commands are offered (it has no "Change files": only file tools are left out)');
        let d: { permissionDecision: string } | undefined;
        void cfg.hooks.onPreToolUse({ toolName: 'bash', toolArgs: { command: 'ls' } }, { sessionId: id }).then((x: { permissionDecision: string }) => { d = x; });
        await later(60);
        assert.equal(d, undefined, 'waits for an approval');
        const ap = (host.events(id) as { events: Array<{ type: string; id?: string }> }).events.find((e) => e.type === 'approval')!;
        host.decide(id, ap.id!, 'once');
        await until(() => !!d);
        assert.equal(d!.permissionDecision, 'allow');
        // Settings: commands never.
        const settings = host.settings();
        await host.saveSettings({ ...settings, approvals: { ...settings.approvals, shell: 'deny' } });
        await host.create({ title: 'Sheller again', profile: SHELLER });
        const cfg2 = lastConfig();
        assert.ok(cfg2.excludedTools.includes('bash'));
        assert.equal((await cfg2.onPermissionRequest({ kind: 'shell', fullCommandText: 'ls' })).kind, 'reject');
        void home;
    } finally { await cleanup(); }
});

test('an evaluation never runs a command, whatever the agent\'s tools: none offered, every call refused without asking', async () => {
    const { host, repoDir, cleanup } = setup();
    try {
        await runGit(['init', '-q', '-b', 'main', repoDir], { cwd: path.dirname(repoDir) });
        for (const a of [READER, SHELLER]) {
            saveAgent(repoDir, { ...a, mode: 'assistant' } as never, 'Tester');
            saveSuite(repoDir, a.id, { cases: [{ id: 'c1', name: 'Status', prompt: 'What changed in the repository?', checks: [{ kind: 'not-contains', text: 'zzz' }] }] } as never, 'Tester');
        }
        const configs: Array<{ title: string; cfg: any; id: string }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
        // The evaluation's sessions are real host sessions: what the runtime gets is checked, then the agent "answers".
        const agent: MissionAgent = {
            async start(x) { const s = await host.createMission(x); configs.push({ title: x.title, cfg: lastConfig(), id: s.id }); return s; },
            async send(id) {
                const c = configs.find((y) => y.id === id)!;
                // The model tries the command anyway (as the mock model did): through the hook and the permission check.
                const pre = await c.cfg.hooks.onPreToolUse({ toolName: 'bash', toolArgs: { command: 'git status --short' } }, { sessionId: id });
                const perm = await c.cfg.onPermissionRequest({ kind: 'shell', fullCommandText: 'git status --short' });
                const mission = (host as unknown as { sessions: Map<string, { mission?: MissionSessionOptions }> }).sessions.get(id)!.mission!;
                setImmediate(() => {
                    mission.listener?.({ type: 'assistant', text: `${pre.permissionDecision} / ${perm.kind}`, seq: 1000, at: Date.now() });
                    mission.listener?.({ type: 'idle', seq: 1001, at: Date.now() });
                });
            },
            async abort() { /* done */ },
            usageOf: () => ({ usage: { calls: 1, inputTokens: 1, outputTokens: 1, cost: 0 }, busy: false, pending: 0 }),
        };
        const r = new EvalRunner({ repoRoot: repoDir, gitDir: path.join(repoDir, '.git'), agent, log: () => undefined });
        for (const a of [READER, SHELLER]) {
            const run = r.start(a.id, 'Tester');
            await until(() => run.state !== 'running');
            assert.equal(run.cases[0].attempts[0].answer, 'deny / reject', `${a.name}: the command was refused`);
        }
        assert.equal(configs.length, 2);
        for (const c of configs) {
            assert.ok(SHELL_TOOLS.every((t) => c.cfg.excludedTools.includes(t)), `${c.title}: no command tools`);
            assert.equal(c.cfg.mcpServers, undefined, `${c.title}: no tool servers started`);
            const ev = host.events(c.id) as { events: Array<{ type: string; text?: string }>; pending?: string[] };
            assert.equal(ev.events.filter((e) => e.type === 'approval').length, 0, 'nothing asked: refused at once');
            assert.ok(ev.events.some((e) => e.type === 'info' && /^Refused \(read only\): shell git status/.test(e.text ?? '')));
        }
    } finally { await cleanup(); }
});

test('tool servers start only for agents with "Tool servers"; one that does not answer is left out quickly and the conversation says which', async () => {
    const probed: Array<[string, number]> = [];
    const { host, cleanup } = setup({
        servers: ['good-srv', 'qa6-srv'],
        probe: async (name, ms) => { probed.push([name, ms]); return name === 'qa6-srv' ? { ok: false, error: 'MCP lifecycle negotiation did not complete within 15000 ms' } : { ok: true }; },
    });
    try {
        // An agent without the tool group: no server started, none checked, nothing waited for.
        const t0 = Date.now();
        await host.create({ title: 'Reader chat', profile: READER });
        assert.equal(lastConfig().mcpServers, undefined);
        assert.equal(probed.length, 0);
        assert.ok(Date.now() - t0 < 5000);
        // An agent that uses tool servers: the broken one is left out, named in the conversation.
        const { id } = await host.create({ title: 'Tools chat', profile: { ...READER, id: 'tools', name: 'Tools', tools: ['knowledge', 'tool-servers'] } });
        assert.deepEqual(Object.keys(lastConfig().mcpServers), ['good-srv']);
        assert.ok(probed.every(([, ms]) => ms <= 15_000), 'a short start timeout');
        const info = (host.events(id) as { events: Array<{ type: string; text?: string }> }).events.filter((e) => e.type === 'info').map((e) => e.text);
        assert.ok(info.some((t) => /^Tool server qa6-srv could not start \(MCP lifecycle negotiation did not complete within 15000 ms\): it is left out of this conversation/.test(t ?? '')), info.join('\n'));
        // A second session soon after does not wait on the checks again.
        const n = probed.length;
        await host.create({ title: 'Tools chat 2', profile: { ...READER, id: 'tools', name: 'Tools', tools: ['knowledge', 'tool-servers'] } });
        assert.equal(probed.length, n);
    } finally { await cleanup(); }
});

test('"Explorers at once" = 1: tours are handed out one after the other (the rest wait their turn)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa6-explore-'));
    const dir = path.join(tmp, 'shop-tests');
    try {
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
        fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
        await runGit(['add', '-A'], { cwd: dir });
        await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
        let working = 0, maxWorking = 0, n = 0;
        const order: string[] = [];
        const sessions = new Map<string, { title: string; o: MissionSessionOptions; step: number }>();
        const agent: MissionAgent = {
            async start(x) { const id = `s${++n}`; sessions.set(id, { title: x.title, o: x.mission, step: 0 }); return { id }; },
            async send(id, text) {
                const s = sessions.get(id)!;
                const tool = (t: string, a: unknown) => s.o.tools.find((x) => x.name === t)!.handler(a) as Promise<unknown>;
                setImmediate(async () => {
                    if (s.title.endsWith(': Application explorer')) {
                        working++; maxWorking = Math.max(maxWorking, working);
                        order.push(`start ${text.slice(0, 6)}`);
                        await tool('explore_note', { kind: 'covered', title: text.slice(0, 20) });
                        await later(80);
                        order.push(`end ${text.slice(0, 6)}`);
                        working--;
                        s.o.listener?.({ type: 'assistant', text: 'Toured.', seq: 1, at: Date.now() });
                    } else if (s.step++ === 0) {
                        await Promise.all([
                            tool('team_delegate', { member: 'explorer', task: 'Tour 1: the cart with wrong quantities.' }),
                            tool('team_delegate', { member: 'explorer', task: 'Tour 2: the cart after back and refresh.' }),
                        ]);
                        await tool('mission_report', { outcome: 'done', summary: 'Covered the cart.' });
                    }
                    s.o.listener?.({ type: 'idle', seq: 2, at: Date.now() });
                });
            },
            async abort() { /* done */ },
            usageOf: (id) => (sessions.has(id) ? { usage: { calls: 1, inputTokens: 1, outputTokens: 1, cost: 0 }, busy: false, pending: 0 } : null),
        };
        const newBrowser = () => ({ pageNow: () => ({}), screenshot: async () => Buffer.from('png'), close: async () => undefined }) as never;
        const e = new MissionEngine({ repoRoot: dir, gitDir: path.join(dir, '.git'), agent, log: () => undefined, tickMs: 30, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed' }), newBrowser });
        const m = await e.start('explore-app', { project: 'shop', env: 'qa', charter: 'The cart', explorers: '1' });
        await until(() => m.state === 'succeeded');
        assert.equal(maxWorking, 1, 'one explorer at a time');
        assert.deepEqual(order, ['start Tour 1', 'end Tour 1', 'start Tour 2', 'end Tour 2']);
        assert.ok(m.timeline.some((x) => x.kind === 'team' && /^Queued for Application explorer \(1 at once\)/.test(x.text)));
        assert.equal(m.team!.length, 2);
        assert.equal(e.parallelOf(m), 1);
        assert.equal(e.parallelOf({ ...m, inputs: { ...m.inputs, explorers: '7' } }), 3);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
