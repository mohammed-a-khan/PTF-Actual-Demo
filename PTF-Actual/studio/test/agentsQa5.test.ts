import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../src/git/run';
import { validateAgent, wholeProblem } from '../src/agents/builder';
import { validateSources } from '../src/agents/knowledge';
import { EvalRunner, saveSuite } from '../src/agents/evals';
import type { MissionAgent } from '../src/agents/missions';

const ASSISTANT = { id: 'qa-five', name: 'QA five', mode: 'assistant', instructions: 'Review the test code against the team standards and list improvements.', tools: ['knowledge', 'studio-read'] };
const MISSION = { id: 'qa-five-m', name: 'QA five mission', mode: 'mission', instructions: 'Explore the application and report what looks wrong, with evidence.', goal: 'Explore the shop.', inputs: [], writes: false, tools: ['knowledge', 'studio-read'], verify: { kind: 'report' } };
const CASES = { cases: [{ id: 'one', name: 'One', prompt: 'Which version?', checks: [{ kind: 'contains', text: 'v2' }] }] };

async function server(o: { missionAgent?: MissionAgent } = {}) {
    const { createServer } = await import('../src/server/server');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-qa5-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, '.cs-studio'), { recursive: true });
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'Tester', token: 'tk', home: path.join(tmp, 'home'), ...(o.missionAgent ? { missionAgent: o.missionAgent } : {}) });
    const call = async (method: string, url: string, payload?: unknown) => {
        const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) });
        return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    return { tmp, dir, srv, call };
}

test('evaluation cases saved from two tabs: the second save (with the version it read) is refused with 409; overwrite on purpose works', async () => {
    const { tmp, dir, srv, call } = await server();
    try {
        assert.equal((await call('PUT', '/api/agent-builder/qa-five', { agent: ASSISTANT, isNew: true })).status, 200);
        const first = await call('GET', '/api/evals/qa-five');
        assert.equal(first.json.version, '', 'no file yet');
        // Both tabs read the same version; A saves.
        const a = await call('PUT', '/api/evals/qa-five', { suite: { cases: [{ ...CASES.cases[0], name: 'QA5 path A' }] }, version: first.json.version });
        assert.equal(a.status, 200, JSON.stringify(a.json));
        assert.match(a.json.version, /^[0-9a-f]{16}$/);
        // B still has the version before A's save: refused, A's change kept.
        const b = await call('PUT', '/api/evals/qa-five', { suite: { cases: [{ ...CASES.cases[0], name: 'QA5 path B' }] }, version: first.json.version });
        assert.equal(b.status, 409);
        assert.match(b.json.error, /Changed in another tab or by someone else/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.cs-studio/evals/qa-five.json'), 'utf8')).cases[0].name, 'QA5 path A');
        // A save with the version now: fine. Overwrite on purpose (force): fine too.
        const now = (await call('GET', '/api/evals/qa-five')).json.version;
        assert.equal(now, a.json.version);
        assert.equal((await call('PUT', '/api/evals/qa-five', { suite: { cases: [{ ...CASES.cases[0], name: 'QA5 path B' }] }, version: first.json.version, force: true })).status, 200);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.cs-studio/evals/qa-five.json'), 'utf8')).cases[0].name, 'QA5 path B');
        // A caller that sends no version (a script) saves as before.
        assert.equal((await call('PUT', '/api/evals/qa-five', { suite: CASES })).status, 200);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('saveSuite: refused (ChangedElsewhere) when the file changed since the version given', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-qa5-suite-'));
    try {
        saveSuite(tmp, 'x', CASES, 'A', { version: '' });
        assert.throws(() => saveSuite(tmp, 'x', CASES, 'B', { version: '' }), /Changed in another tab/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('whole numbers (a budget, a trigger\'s daily limit): decimals, negative numbers, text and out-of-range values are refused, never rounded', () => {
    assert.equal(wholeProblem(15, 'Minutes', 5, 480), null);
    assert.equal(wholeProblem('15', 'Minutes', 5, 480), null);
    assert.match(wholeProblem(1.5, 'Minutes', 5, 480)!, /Minutes: no decimals/);
    assert.match(wholeProblem('1.5', 'Minutes', 5, 480)!, /no decimals/);
    assert.match(wholeProblem(-1, 'Attempts', 1, 10)!, /no negative numbers/);
    assert.match(wholeProblem('abc', 'Attempts', 1, 10)!, /numbers only/);
    assert.match(wholeProblem(2, 'Minutes', 5, 480)!, /a whole number from 5 to 480 \(not 2\)/);
    const m = (p: Record<string, unknown>) => () => validateAgent({ ...MISSION, ...p });
    assert.doesNotThrow(m({ budget: { minutes: 15, modelCalls: 20, attempts: 1 } }));
    assert.throws(m({ budget: { minutes: 1.5 } }), /Minutes: no decimals/);
    assert.throws(m({ budget: { modelCalls: -1 } }), /Model calls: no negative numbers/);
    assert.throws(m({ budget: { attempts: 11 } }), /Attempts: a whole number from 1 to 10/);
    assert.throws(m({ triggers: [{ on: 'run-failed', maxPerDay: 1.5 }] }), /at most, a day: no decimals/);
    assert.throws(m({ triggers: [{ on: 'run-failed', maxPerDay: 0 }] }), /from 1 to 50 \(not 0\)/);
    assert.doesNotThrow(m({ triggers: [{ on: 'run-failed', maxPerDay: 5 }] }));
});

test('a mission started with a budget that is not a whole number in range is refused (400), not rounded; an unknown mission is 404', async () => {
    const started: string[] = [];
    const agent: MissionAgent = { start: async (o) => { started.push(o.title); return { id: 's' }; }, send: async () => undefined, abort: async () => undefined, usageOf: () => null };
    const { tmp, srv, call } = await server({ missionAgent: agent });
    try {
        for (const budget of [{ minutes: 1.5 }, { minutes: '1.5' }, { modelCalls: -1 }, { attempts: 'abc' }, { minutes: 4 }]) {
            const r = await call('POST', '/api/missions', { key: 'coverage-gaps', inputs: {}, budget });
            assert.equal(r.status, 400, JSON.stringify(budget));
            assert.match(r.json.error, /no decimals|no negative|numbers only|a whole number from/, JSON.stringify(r.json));
        }
        assert.deepEqual(started, []);
        const nf = await call('GET', '/api/missions/doesnotexist');
        assert.equal(nf.status, 404);
        assert.match(nf.json.error, /Mission not found/);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('knowledge sources: a problem names the source as the person named it; ".." in the sub-folders is said plainly', () => {
    assert.throws(() => validateSources([{ id: 'qa5-docs', name: 'QA5 docs', kind: 'folder', path: 'docs', include: ['../../..'] }]), /Source "QA5 docs": only sub-folders inside it, without "\.\.": "\.\.\/\.\.\/\.\."\./);
    assert.throws(() => validateSources([{ id: 'qa5-docs', name: 'QA5 docs', kind: 'folder' }]), /Source "QA5 docs": the folder/);
});

test('an evaluation run records the model that answered (not "setting")', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-qa5-evals-'));
    try {
        const dir = path.join(tmp, 'repo');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        fs.mkdirSync(path.join(dir, '.cs-studio', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.cs-studio', 'agents', 'qa-five.json'), JSON.stringify(ASSISTANT));
        saveSuite(dir, 'qa-five', CASES, 'Tester');
        let n = 0;
        const sessions = new Map<string, { listener?: (e: never) => void }>();
        const agent: MissionAgent = {
            async start(x) { const id = `e${++n}`; sessions.set(id, { listener: x.mission.listener as never }); return { id }; },
            async send(id) { const l = sessions.get(id)!.listener as unknown as (e: unknown) => void; setImmediate(() => { l({ type: 'assistant', text: 'v2', seq: 1, at: Date.now() }); l({ type: 'idle', seq: 2, at: Date.now() }); }); },
            async abort() { /* */ },
            usageOf: () => ({ usage: { calls: 1, inputTokens: 1, outputTokens: 1, cost: 0, model: 'mock-1' }, busy: false, pending: 0 }),
        };
        const r = new EvalRunner({ repoRoot: dir, gitDir: path.join(dir, '.git'), agent, log: () => undefined });
        const run = r.start('qa-five', 'Tester');
        const t0 = Date.now();
        while (r.isRunning('qa-five')) { if (Date.now() - t0 > 8000) throw new Error('timed out'); await new Promise((x) => setTimeout(x, 20)); }
        const done = r.get('qa-five', run.id)!;
        assert.equal(done.passed, 1);
        assert.deepEqual(done.models, ['mock-1']);
        assert.equal(done.cases[0].attempts[0].model, 'mock-1');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
