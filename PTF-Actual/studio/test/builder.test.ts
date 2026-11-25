import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_TEMPLATES, deleteAgent, listAgents, saveAgent, validateAgent } from '../src/agents/builder';
import { MissionAgent, MissionEngine, PolledTriggers, templates } from '../src/agents/missions';
import { runGit } from '../src/git/run';

const assistant = { id: 'test-reviewer', name: 'Test reviewer', mode: 'assistant', instructions: 'Review the test code against the team standards and list improvements.', tools: ['knowledge', 'studio-read'] };
const mission = { id: 'story-bot', name: 'Story bot', mode: 'mission', instructions: 'Plan first, then write the feature and run it until it passes.', goal: 'Automate {story} in {project} / {env}.',
    inputs: [{ key: 'project', label: 'Project', required: true, kind: 'project' }, { key: 'env', label: 'Environment', required: true, kind: 'env' }, { key: 'story', label: 'Story', required: true }],
    tools: ['knowledge', 'studio-read', 'tests', 'files'], knowledge: ['repo'], verify: { kind: 'tests', features: 'changed' }, budget: { minutes: 30 } };

test('validateAgent: names, instructions, tool groups, knowledge sources; missions need a goal with its inputs, file tools to change files, a query for work-item triggers', () => {
    assert.equal(validateAgent(assistant).tools.length, 2);
    for (const [bad, re] of [
        [{ ...assistant, id: 'Bad Id' }, /lower-case/], [{ ...assistant, name: ' ' }, /name/], [{ ...assistant, instructions: 'short' }, /instructions/],
        [{ ...assistant, tools: ['root'] }, /Unknown tool group/], [{ ...assistant, mode: 'robot' }, /Mode/],
        [{ ...mission, goal: '' }, /goal/], [{ ...mission, goal: 'Do {ticket}' }, /\{ticket\}: add that input/],
        [{ ...mission, tools: ['tests'] }, /Change files/], [{ ...mission, triggers: [{ on: 'work-item', query: 'all of them' }] }, /WIQL/],
        [{ ...mission, triggers: [{ on: 'pull-request' }] }, /"repository" and "pr"/], [{ ...assistant, triggers: [{ on: 'schedule', cron: '0 2 * * *' }] }, /Only mission agents/],
        [{ ...mission, triggers: [{ on: 'schedule', cron: 'nightly' }] }, /is not a schedule: five fields/],
        [{ ...mission, triggers: [{ on: 'schedule', cron: '99 99 99 99 99' }] }, /is not a schedule/],
        [{ ...mission, triggers: [{ on: 'schedule', cron: '0 2 * * *', inputs: { story: '1' } }] }, /must give the required inputs? .*Project/],
        [{ ...mission, inputs: [...mission.inputs, { key: 'story', label: 'Again' }] }, /Two inputs are named "story"/],
        [{ ...assistant, starters: ['1', '2', '3', '4', '5', '6', '7'] }, /At most 6 conversation starters \(now 7\)/],
        [{ ...assistant, instructions: 'Do the job.' }, /at least 20 characters \(now 11\)/],
    ] as const) assert.throws(() => validateAgent(bad), re as RegExp, JSON.stringify(bad).slice(0, 60));
    assert.throws(() => validateAgent({ ...assistant, knowledge: ['nope'] }, { knowledgeIds: ['repo'] }), /Unknown knowledge source "nope"/);
    assert.equal(validateAgent({ ...mission, tools: ['tests'], writes: false }).writes, false, 'a read-only mission needs no file tools');
    for (const t of AGENT_TEMPLATES) assert.doesNotThrow(() => validateAgent(t), t.id);
});

test('agents are files in the repository; a mission agent is a mission (with its profile); delete', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-'));
    try {
        const a = saveAgent(dir, assistant, 'Tester', { isNew: true });
        assert.equal(a.updatedBy, 'Tester');
        assert.throws(() => saveAgent(dir, assistant, 'Tester', { isNew: true }), /exists/);
        assert.throws(() => saveAgent(dir, { ...mission, id: 'fix-failing' }, 'Tester', { reserved: ['fix-failing'] }), /built-in mission/);
        saveAgent(dir, mission, 'Tester');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.cs-studio/agents/story-bot.json'), 'utf8')).tools, ['knowledge', 'studio-read', 'tests', 'files']);
        fs.writeFileSync(path.join(dir, '.cs-studio/agents/broken.json'), '{ "id": "other" }');
        const l = listAgents(dir);
        assert.deepEqual(l.agents.map((x) => x.id), ['story-bot', 'test-reviewer']);
        assert.match(l.problems[0], /^\.cs-studio\/agents\/broken\.json: /);
        const t = templates(dir).find((x) => x.key === 'story-bot')!;
        assert.equal(t.title, 'Story bot');
        assert.deepEqual(t.profile?.knowledge, ['repo']);
        assert.match(t.goal({ inputs: { story: '42', project: 'shop', env: 'qa' }, changedFiles: [] }), /^Goal: Automate 42 in shop \/ qa\.[\s\S]*How to work \(the team's instructions for this agent\):\nPlan first/);
        assert.ok(!templates(dir).some((x) => x.key === 'test-reviewer'), 'assistants are not missions');
        deleteAgent(dir, 'test-reviewer');
        assert.throws(() => deleteAgent(dir, 'test-reviewer'), /No such agent/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a team agent\'s session: only its tool groups; Studio changes, files and commands refused when not allowed; its model and instructions', async () => {
    const { AgentHost } = await import('../src/agents/host');
    const { writeFakeCopilotSdk } = await import('./fakeCopilot');
    delete (global as { __fakeCopilot?: unknown }).__fakeCopilot;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-host-'));
    try {
        const repoDir = path.join(home, 'repo'); fs.mkdirSync(repoDir);
        writeFakeCopilotSdk(path.join(home, 'rt'));
        const calls: string[] = [];
        const host = new AgentHost({ repoRoot: repoDir, home, runtimeDir: path.join(home, 'rt'), browser: { running: false } as never, secret: () => undefined, call: async (m, u) => { calls.push(`${m} ${u}`); return { status: 200, body: {} }; }, projects: () => [], log: () => undefined,
            knowledge: () => [{ name: 'knowledge_search', description: '', parameters: {}, handler: async () => [] }, { name: 'knowledge_read', description: '', parameters: {}, handler: async () => '' }] });
        await host.create({ title: 'Reviewer', profile: { id: 'test-reviewer', name: 'Test reviewer', instructions: 'Review only; never change files.', tools: ['knowledge', 'studio-read'], model: 'gpt-mini' } });
        const cfg = (global as unknown as { __fakeCopilot: { lastConfig: any } }).__fakeCopilot.lastConfig; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.deepEqual(cfg.tools.map((t: { name: string }) => t.name).sort(), ['knowledge_read', 'knowledge_search', 'studio_call', 'studio_catalog', 'studio_context']);
        assert.equal(cfg.model, 'gpt-mini');
        assert.match(cfg.systemMessage.content, /You are the team's agent "Test reviewer"[\s\S]*Review only; never change files\.\nYou may use only these tool groups: knowledge, studio-read\./);
        const call = (b: unknown) => cfg.tools.find((t: { name: string }) => t.name === 'studio_call').handler(b);
        await call({ method: 'GET', path: '/api/runs' });
        assert.match(await call({ method: 'PUT', path: '/api/file', body: { path: 'x' } }), /may only read through the Studio/);
        assert.deepEqual(calls, ['GET /api/runs']);
        const w = await cfg.onPermissionRequest({ kind: 'write', fileName: path.join(repoDir, 'a.feature') });
        assert.deepEqual([w.kind, /not allowed to change files/.test(w.feedback)], ['reject', true]);
        assert.equal((await cfg.onPermissionRequest({ kind: 'shell', fullCommandText: 'npm test' })).kind, 'reject');
        assert.deepEqual(await cfg.onPermissionRequest({ kind: 'read', path: 'x' }), { kind: 'approve-once' });
        await host.stop();
    } finally { delete (global as { __fakeCopilot?: unknown }).__fakeCopilot; fs.rmSync(home, { recursive: true, force: true }); }
});

test('polled triggers: the first check only records what is there; new work items and updated pull requests start the agent\'s mission', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-poll-'));
    try {
        const dir = path.join(tmp, 'repo');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        saveAgent(dir, { ...mission, writes: false, tools: ['knowledge', 'studio-read'], verify: { kind: 'report' }, triggers: [{ on: 'work-item', query: 'SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS \'automate\'', inputs: { project: 'shop', env: 'qa' } }] }, 'T');
        saveAgent(dir, { id: 'pr-bot', name: 'PR bot', mode: 'mission', instructions: 'Review the pull request\'s tests and report.', goal: 'Review {pr} in {repository}.', inputs: [{ key: 'repository', label: 'Repository', required: true }, { key: 'pr', label: 'PR', required: true }], tools: ['knowledge', 'studio-read'], writes: false, verify: { kind: 'report' }, triggers: [{ on: 'pull-request', target: 'main' }] }, 'T');
        let items = [1, 2];
        let prs = [{ repository: 'shop', id: 7, updated: 'a1' }];
        const asked: unknown[] = [];
        const agent: MissionAgent = { start: async () => ({ id: 's' }), send: async () => undefined, abort: async () => undefined, usageOf: () => null };
        const e = new MissionEngine({ repoRoot: dir, gitDir: path.join(dir, '.git'), agent, log: () => undefined, tickMs: 1000, runInfo: () => undefined, runTests: async () => ({ id: 'r', state: 'passed' }) });
        const p = new PolledTriggers(e, dir, path.join(tmp, 'state.json'), { workItems: async () => items, pullRequests: async (o) => { asked.push(o); return prs; } }, () => undefined);
        assert.deepEqual(await p.check(), [], 'first check: nothing starts');
        items = [1, 2, 3];
        prs = [{ repository: 'shop', id: 7, updated: 'b2' }, { repository: 'shop', id: 8, updated: 'c3' }];
        const started = await p.check();
        assert.deepEqual(started.map((m) => `${m.key} ${m.trigger.kind} ${m.trigger.ref} ${m.state}`).sort(), ['pr-bot pull-request shop/7 working', 'pr-bot pull-request shop/8 queued', 'story-bot work-item 3 queued'].sort());
        assert.deepEqual(e.list().find((m) => m.key === 'story-bot')?.inputs, { project: 'shop', env: 'qa', story: '3' });
        assert.deepEqual(asked[0], { target: 'main', repository: undefined, project: undefined });
        assert.deepEqual(await new PolledTriggers(e, dir, path.join(tmp, 'state.json'), { workItems: async () => items, pullRequests: async () => prs }, () => undefined).check(), [], 'remembered across restarts');
        for (const m of e.running()) await e.stop(m.id, 'T');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('builder routes: list with templates and tool groups; save (policy models), chat with a team agent, delete', async () => {
    const { createServer } = await import('../src/server/server');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-srv-'));
    try {
        const dir = path.join(tmp, 'repo');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        fs.mkdirSync(path.join(dir, '.cs-studio'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.cs-studio/agents-policy.json'), JSON.stringify({ models: ['gpt-mini'] }));
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'Tester', token: 'tk' });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        const v = (await call('GET', '/api/agent-builder')).json;
        assert.deepEqual(v.agents, []);
        assert.deepEqual(v.templates.map((t: { id: string }) => t.id), ['test-reviewer', 'failure-analyst', 'story-to-tests', 'nightly-health']);
        assert.ok(v.groups.some((g: { id: string }) => g.id === 'files'));
        assert.deepEqual(v.policyModels, ['gpt-mini']);
        assert.ok(v.reserved.includes('fix-failing'));
        assert.equal((await call('PUT', '/api/agent-builder/test-reviewer', { agent: { ...assistant, model: 'big-model' }, isNew: true })).status, 400, 'model outside the policy');
        assert.equal((await call('PUT', '/api/agent-builder/other', { agent: assistant, isNew: true })).status, 400, 'id must match');
        const saved = await call('PUT', '/api/agent-builder/test-reviewer', { agent: { ...assistant, model: 'gpt-mini' }, isNew: true });
        assert.equal(saved.status, 200, JSON.stringify(saved.json));
        assert.equal(saved.json.agent.updatedBy, 'Tester');
        assert.equal((await call('PUT', '/api/agent-builder/story-bot', { agent: mission, isNew: true })).status, 200);
        assert.ok((await call('GET', '/api/missions')).json.templates.some((t: { key: string }) => t.key === 'story-bot'), 'a mission agent shows under Missions');
        // A team: members must exist; the mission shows its team by name.
        assert.ok(v.teamCandidates.some((c: { id: string; builtIn: boolean }) => c.id === 'explorer' && c.builtIn));
        const bad = await call('PUT', '/api/agent-builder/story-bot', { agent: { ...mission, team: ['explorer', 'ghost'] } });
        assert.equal(bad.status, 400); assert.match(bad.json.error, /ghost/);
        assert.equal((await call('PUT', '/api/agent-builder/story-bot', { agent: { ...mission, team: ['explorer', 'test-reviewer'] } })).status, 200);
        assert.deepEqual((await call('GET', '/api/missions')).json.templates.find((t: { key: string }) => t.key === 'story-bot').team, [{ id: 'explorer', name: 'Application explorer' }, { id: 'test-reviewer', name: 'Test reviewer' }]);
        assert.equal((await call('POST', '/api/agents/sessions', { agent: 'story-bot' })).status, 400, 'a mission agent is not a chat');
        assert.equal((await call('POST', '/api/agents/sessions', { agent: 'nope' })).status, 400);
        // Its evaluation cases go with it (a new agent with the same id does not inherit them).
        fs.mkdirSync(path.join(dir, '.cs-studio/evals'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.cs-studio/evals/test-reviewer.json'), JSON.stringify({ agent: 'test-reviewer', cases: [] }));
        assert.equal((await call('DELETE', '/api/agent-builder/test-reviewer', {})).status, 400, 'needs confirmation');
        assert.deepEqual((await call('DELETE', '/api/agent-builder/test-reviewer', { confirm: true })).json.agents.map((a: { id: string }) => a.id), ['story-bot']);
        assert.equal(fs.existsSync(path.join(dir, '.cs-studio/evals/test-reviewer.json')), false, 'its evaluation cases deleted too');
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
