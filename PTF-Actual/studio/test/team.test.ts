import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MissionAgent, MissionEngine, TEAM_PARALLEL, templates } from '../src/agents/missions';
import { asTeamMission, saveAgent, teamCandidates, teamMember, validateAgent } from '../src/agents/builder';
import type { MissionSessionOptions } from '../src/agents/host';
import type { RunRequest, RunSummary } from '../src/run/runner';
import { runGit } from '../src/git/run';

type Ctx = { tool: (n: string, a: unknown) => Promise<unknown>; dir: string; text: string; opts: MissionSessionOptions };
/**
 * A scripted agent with many sessions: the lead runs its steps one per message; a member (by its name in the
 * session title) runs its function and answers with what it returns.
 */
function teamAgent(lead: Array<(c: Ctx) => Promise<void>>, members: Record<string, (c: Ctx) => Promise<string>>) {
    const sessions = new Map<string, { title: string; opts: MissionSessionOptions; step: number; seq: number; aborted: boolean }>();
    const pending = new Map<string, Array<{ id: string; title: string; detail: string; kind: string }>>();
    const decided: Array<[string, string, string]> = [];
    const aborted: string[] = [];
    let n = 0, working = 0, maxWorking = 0;
    const agent: MissionAgent = {
        async start(x) { const id = `s${++n}`; sessions.set(id, { title: x.title, opts: x.mission, step: 0, seq: 0, aborted: false }); return { id }; },
        async send(id, text) {
            const s = sessions.get(id)!;
            const ctx: Ctx = { tool: (t, a) => s.opts.tools.find((x) => x.name === t)!.handler(a) as Promise<unknown>, dir: s.opts.workdir, text, opts: s.opts };
            const member = Object.keys(members).find((k) => s.title.endsWith(`: ${k}`));
            setImmediate(async () => {
                if (member) {
                    working++; maxWorking = Math.max(maxWorking, working);
                    const answer = await members[member](ctx);
                    working--;
                    if (s.aborted) return;
                    s.opts.listener?.({ type: 'assistant', text: answer, seq: ++s.seq, at: Date.now() });
                } else {
                    const fn = lead[s.step++];
                    if (fn && !s.aborted) await fn(ctx);
                }
                if (!s.aborted) s.opts.listener?.({ type: 'idle', seq: ++s.seq, at: Date.now() });
            });
        },
        async abort(id) { aborted.push(id); const s = sessions.get(id); if (s) s.aborted = true; },
        usageOf: (id) => (sessions.has(id) ? { usage: { calls: 3, inputTokens: 100, outputTokens: 50, cost: 0.01 }, busy: false, pending: 0 } : null),
        pendingOf: (id) => pending.get(id) ?? [],
        decide: (id, a, d) => { decided.push([id, a, d]); pending.set(id, (pending.get(id) ?? []).filter((x) => x.id !== a)); },
    };
    return { agent, sessions, pending, decided, aborted, maxWorking: () => maxWorking };
}

const summary = (scen: Array<[string, string]>): RunSummary => ({ total: scen.length, passed: scen.filter((s) => s[1] === 'passed').length, failed: scen.filter((s) => s[1] === 'failed').length, skipped: 0, duration: 1, reportDir: '', hasHtml: false, scenarios: scen.map(([name, status]) => ({ name, feature: 'F', status, duration: 1 })) });

async function repo() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-'));
    const dir = path.join(tmp, 'shop-tests');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'test/shop/features'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/shop/features/login.feature'), 'Feature: Login\n');
    await runGit(['add', '-A'], { cwd: dir });
    await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
    return { tmp, dir, gitDir: path.join(dir, '.git') };
}
const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a team mission: the lead hands work to members in parallel, each with its own tools, in the copy; their use counts; the Studio verifies', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        const answers: string[] = [];
        const t = teamAgent([
            async ({ tool, opts }) => {
                assert.ok(opts.tools.some((x) => x.name === 'team_delegate'), 'the lead can delegate');
                // Analyst and explorer at the same time.
                const [an, ex] = await Promise.all([
                    tool('team_delegate', { member: 'analyst', task: 'List the scenarios for paying by card.' }),
                    tool('team_delegate', { member: 'explorer', task: 'Walk the checkout screens and report locators.' }),
                ]) as string[];
                answers.push(an, ex);
                assert.match(String(await tool('team_delegate', { member: 'nobody', task: 'Do something useful here.' })), /No team member "nobody"/);
                await tool('mission_ask', { kind: 'plan', question: 'Approve?', content: 'Feature: Checkout' });
                answers.push(await tool('team_delegate', { member: 'author', task: 'Write checkout.feature from the plan and run it.' }) as string);
                answers.push(await tool('team_delegate', { member: 'test-reviewer', task: 'Review test/shop/features/checkout.feature.' }) as string);
                await tool('mission_report', { outcome: 'done', summary: 'Checkout automated by the team.' });
            },
        ], {
            'Requirements analyst': async ({ opts }) => { assert.deepEqual(opts.profile?.tools, ['knowledge', 'studio-read', 'app-code']); assert.deepEqual(opts.tools.map((x) => x.name), ['tests_run']); await later(60); return 'Scenarios: pay by card; card declined.'; },
            'Application explorer': async ({ opts }) => { assert.ok(opts.profile?.tools.includes('browser')); await later(60); return 'Pay button: role button "Pay".'; },
            'Test author': async ({ dir: wd, opts }) => {
                assert.notEqual(wd, dir, 'the mission copy');
                assert.ok(opts.isolated && opts.profile?.tools.includes('files'));
                fs.writeFileSync(path.join(wd, 'test/shop/features/checkout.feature'), 'Feature: Checkout\n  Scenario: Pay\n');
                const r = await opts.tools[0].handler({ project: 'shop', env: 'qa', features: ['test/shop/features/checkout.feature'] }) as { passed: number };
                return `Wrote test/shop/features/checkout.feature; ${r.passed} passed.`;
            },
            'Test reviewer': async ({ opts }) => { assert.ok(!opts.profile?.tools.includes('files'), 'the reviewer only reads'); return 'Looks good.'; },
        });
        const ran: Array<{ req: RunRequest; workdir?: string }> = [];
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: t.agent, userName: 'Tester', log: () => undefined, tickMs: 30, runInfo: () => undefined,
            runTests: async (req, workdir) => { ran.push({ req, workdir }); return { id: `r${ran.length}`, state: 'passed', summary: summary([['Pay', 'passed']]) }; } });
        const m = await e.start('team-story', { project: 'shop', env: 'qa', story: 'As a buyer I pay by card' });
        await until(() => m.state === 'waiting');
        assert.equal(t.maxWorking(), 2, 'analyst and explorer worked at the same time');
        e.answer(m.id, m.checkpoints[0].id, 'Approved', 'Tester');
        await until(() => m.state === 'succeeded');
        assert.equal(m.reason, 'Done and verified.');
        assert.match(answers[0], /^Requirements analyst \(done\):\nScenarios: pay by card/);
        assert.match(answers[2], /Wrote test\/shop\/features\/checkout.feature; 1 passed/);
        assert.deepEqual(m.team!.map((x) => [x.member, x.state]), [['analyst', 'done'], ['explorer', 'done'], ['author', 'done'], ['test-reviewer', 'done']]);
        assert.ok(m.team!.every((x) => x.session && x.endedAt && x.answer));
        assert.equal(m.used.modelCalls, 15, 'the lead\'s 3 calls and 3 for each of the 4 members');
        assert.ok(m.timeline.some((x) => x.kind === 'team' && x.text.startsWith('Handed to Test author')));
        assert.deepEqual(ran.map((r) => r.workdir), [m.copy!.rel, m.copy!.rel], 'the author\'s run and the proof, both in the copy');
        assert.deepEqual(m.changes, [{ status: 'A', path: 'test/shop/features/checkout.feature' }]);
        assert.ok(m.commit);
        const workflow = [...t.sessions.values()][0];
        assert.ok(workflow.opts.tools.find((x) => x.name === 'team_delegate')!.description.includes('analyst (Requirements analyst)'));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('team limits: members at once, read-only missions keep members read-only, members\' approvals in the mission, stop ends every member', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        fs.mkdirSync(path.join(dir, '.cs-studio'));
        fs.writeFileSync(path.join(dir, '.cs-studio/missions.json'), JSON.stringify({ missions: [{ key: 'look', title: 'Look around', goal: 'Find gaps in {project}.', writes: false, team: ['author', 'analyst', 'explorer', 'test-reviewer', 'not-there'] }] }));
        let release!: () => void;
        const hold = new Promise<void>((r) => { release = r; });
        let results: string[] = [];
        const t = teamAgent([
            async ({ tool, opts }) => {
                assert.deepEqual((opts.tools.find((x) => x.name === 'team_delegate')!.parameters as { properties: { member: { enum: string[] } } }).properties.member.enum, ['author', 'analyst', 'explorer', 'test-reviewer'], 'unknown members are left out');
                results = await Promise.all(['author', 'analyst', 'explorer', 'test-reviewer'].map((member) => tool('team_delegate', { member, task: `Task for ${member}, please do it.` }) as Promise<string>));
            },
        ], {
            'Test author': async ({ opts }) => { assert.ok(!opts.profile!.tools.includes('files'), 'no file changes in a mission that only reads'); assert.deepEqual(opts.profile!.tools, ['knowledge', 'studio-read', 'tests', 'browser']); assert.equal(opts.isolated, false); await hold; return 'author done'; },
            'Requirements analyst': async () => { await hold; return 'analyst done'; },
            'Application explorer': async () => { await hold; return 'explorer done'; },
        });
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: t.agent, log: () => undefined, tickMs: 30, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed' }) });
        assert.deepEqual(templates(dir).find((x) => x.key === 'look')!.team, ['author', 'analyst', 'explorer', 'test-reviewer', 'not-there']);
        const m = await e.start('look', { project: 'shop', env: 'qa' });
        await until(() => (m.team ?? []).filter((x) => x.session).length === TEAM_PARALLEL);
        assert.equal(m.team!.length, 3, `the fourth was refused: ${TEAM_PARALLEL} work at once`);
        // A member's approval shows in the mission with whose it is; approving it answers that member's session.
        const author = m.team!.find((x) => x.member === 'author')!;
        t.pending.set(author.session!, [{ id: 'ap1', title: 'Run npm test', detail: 'npm test', kind: 'shell' }]);
        await until(() => m.state === 'waiting');
        assert.deepEqual(m.approvals!.map((a) => [a.title, a.who, a.session]), [['Test author: Run npm test', 'Test author', author.session]]);
        e.approve(m.id, 'ap1', 'once', 'Tester');
        assert.deepEqual(t.decided, [[author.session, 'ap1', 'once']]);
        await until(() => m.state === 'working');
        await e.stop(m.id, 'Tester');
        assert.equal(m.state, 'stopped');
        assert.deepEqual(m.team!.map((x) => x.state), ['stopped', 'stopped', 'stopped']);
        for (const x of m.team!) assert.ok(t.aborted.includes(x.session!));
        await until(() => results.length === 4);
        assert.match(results[3], /3 members are already working/);
        assert.match(results[0], /The mission has ended/);
        release();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Agent Builder: a mission agent\'s team (validated), built-in specialists, the team\'s own agents first', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-b-'));
    try {
        const base = { id: 'checkout-team', name: 'Checkout team', mode: 'mission', instructions: 'Lead the team that automates checkout stories.', tools: ['knowledge', 'files', 'tests'], goal: 'Automate {story}.', inputs: [{ key: 'story', label: 'Story' }] };
        assert.deepEqual(validateAgent({ ...base, team: ['analyst', 'author', 'author'] }).team, ['analyst', 'author']);
        assert.throws(() => validateAgent({ ...base, mode: 'assistant', goal: undefined, inputs: undefined, team: ['analyst'] }), /Only a mission agent leads a team/);
        assert.throws(() => validateAgent({ ...base, team: ['checkout-team'] }), /not a member of its own team/);
        assert.throws(() => validateAgent({ ...base, team: ['Bad Id'] }), /Team member "Bad Id"/);
        assert.deepEqual(asTeamMission(validateAgent({ ...base, team: ['analyst'] })).team, ['analyst']);
        // The team's own agent with a built-in id comes first; built-ins fill the rest.
        saveAgent(tmp, { id: 'analyst', name: 'Our analyst', mode: 'assistant', instructions: 'Analyse stories the way our team does it.', tools: ['knowledge'] }, 'Tester');
        assert.equal(teamMember(tmp, 'analyst')!.name, 'Our analyst');
        assert.equal(teamMember(tmp, 'explorer')!.name, 'Application explorer');
        assert.equal(teamMember(tmp, 'test-reviewer')!.name, 'Test reviewer');
        assert.equal(teamMember(tmp, 'story-to-tests'), undefined, 'a mission template is not a member');
        const c = teamCandidates(tmp);
        assert.deepEqual(c.filter((x) => x.id === 'analyst').map((x) => [x.name, x.builtIn]), [['Our analyst', false]]);
        assert.ok(c.some((x) => x.id === 'author' && x.builtIn));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('exploration: explorers at once, each in its own browser (closed after); notes with screenshots; no report before coverage; bugs into the report', async () => {
    const { tmp, dir, gitDir } = await repo();
    try {
        const browsers: Array<{ closed: boolean; shots: number }> = [];
        const newBrowser = () => {
            const b = { closed: false, shots: 0 };
            browsers.push(b);
            return { pageNow: () => ({}), screenshot: async () => { b.shots++; return Buffer.from('\x89PNG fake'); }, close: async () => { b.closed = true; } } as never;
        };
        let refused = '';
        const t = teamAgent([
            async ({ tool, text }) => {
                assert.match(text, /Split the charter into 2 tours/);
                refused = String(await tool('mission_report', { outcome: 'done', summary: 'Nothing yet.' }));
                await Promise.all([
                    tool('team_delegate', { member: 'explorer', task: 'Tour 1: the cart with wrong quantities.' }),
                    tool('team_delegate', { member: 'explorer', task: 'Tour 2: the cart after back and refresh.' }),
                ]);
                await tool('explore_note', { kind: 'idea', title: 'Automate: quantity limits in the cart' });
                await tool('mission_report', { outcome: 'done', summary: 'Covered the cart; one bug.' });
            },
        ], {
            'Application explorer': async ({ opts, tool, text }) => {
                assert.ok(opts.browser, 'its own browser');
                assert.deepEqual(opts.tools.map((x) => x.name).sort(), ['explore_note', 'tests_run']);
                await later(50);
                if (/Tour 1/.test(text)) {
                    await tool('explore_note', { kind: 'covered', title: 'Cart: quantity field', detail: 'Tried 0, -1, 999999, letters', screen: '/cart' });
                    assert.match(String(await tool('explore_note', { kind: 'bug', title: 'Quantity -1 accepted', severity: 'high', steps: ['Open the cart', 'Type -1', 'Update'], screen: '/cart', screenshot: true })), /Logged/);
                } else await tool('explore_note', { kind: 'covered', title: 'Cart after refresh keeps items', screen: '/cart' });
                return 'Toured.';
            },
        });
        const e = new MissionEngine({ repoRoot: dir, gitDir, agent: t.agent, log: () => undefined, tickMs: 30, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed' }), newBrowser });
        const m = await e.start('explore-app', { project: 'shop', env: 'qa', charter: 'The cart', explorers: '2' });
        await until(() => m.state === 'succeeded');
        assert.match(refused, /^Not reported: log the screens and flows you covered/);
        assert.equal(t.maxWorking(), 2);
        assert.equal(browsers.length, 2, 'one browser per explorer');
        assert.ok(browsers.every((b) => b.closed), 'closed when their tasks ended');
        assert.equal(browsers.reduce((n, b) => n + b.shots, 0), 1);
        assert.equal(m.copy, undefined, 'an exploration changes nothing');
        const notes = m.exploration!.notes;
        assert.deepEqual(notes.map((n) => n.kind).sort(), ['bug', 'covered', 'covered', 'idea']);
        const bug = notes.find((n) => n.kind === 'bug')!;
        assert.equal(bug.by, 'Application explorer');
        assert.ok(bug.shot && fs.readFileSync(e.shot(m.id, bug.shot)!).toString().includes('PNG'));
        assert.equal(e.shot(m.id, '../x.png'), null);
        assert.deepEqual(m.report!.bugs!.map((b) => b.title), ['Quantity -1 accepted']);
        assert.match(m.report!.bugs![0].detail, /Severity: high\.\nWhere: \/cart\.\nSteps:\n1\. Open the cart\n2\. Type -1\n3\. Update/);
        assert.equal(m.reason, 'Done and verified.');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
