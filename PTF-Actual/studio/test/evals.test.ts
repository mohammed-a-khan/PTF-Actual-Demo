import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvalRunner, evalJUnit, grade, saveSuite, validateSuite, type EvalRun } from '../src/agents/evals';
import { saveAgent } from '../src/agents/builder';
import type { MissionAgent } from '../src/agents/missions';
import type { MissionSessionOptions } from '../src/agents/host';
import { createServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';

/** A fake agent: answer(title, message, options) gives the tools it "calls" and its answer. */
function fakeAgent(answer: (title: string, message: string, o: MissionSessionOptions) => { tools?: Array<[string, unknown]>; text: string; calls?: number }) {
    const opened: Array<{ title: string; o: MissionSessionOptions }> = [];
    const aborted: string[] = [];
    let n = 0;
    const s = new Map<string, { title: string; o: MissionSessionOptions; calls: number }>();
    const agent: MissionAgent = {
        async start(x) { const id = `e${++n}`; s.set(id, { title: x.title, o: x.mission, calls: 0 }); opened.push({ title: x.title, o: x.mission }); return { id }; },
        async send(id, text) {
            const ss = s.get(id)!;
            setImmediate(() => {
                const r = answer(ss.title, text, ss.o);
                ss.calls = r.calls ?? 2;
                let seq = 0;
                for (const [tool, args] of r.tools ?? []) ss.o.listener?.({ type: 'tool-start', id: `t${seq}`, tool, args: JSON.stringify(args), seq: ++seq, at: Date.now() });
                ss.o.listener?.({ type: 'assistant', text: r.text, seq: ++seq, at: Date.now() });
                ss.o.listener?.({ type: 'idle', seq: ++seq, at: Date.now() });
            });
        },
        async abort(id) { aborted.push(id); },
        usageOf: (id) => (s.has(id) ? { usage: { calls: s.get(id)!.calls, inputTokens: 1, outputTokens: 1, cost: 0 }, busy: false, pending: 0 } : null),
    };
    return { agent, opened, aborted };
}
const until = async (f: () => boolean, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const REVIEWER = { id: 'catalog-reviewer', name: 'Catalog reviewer', mode: 'assistant', instructions: 'Review catalog tests against the team guide and cite it.', tools: ['knowledge', 'studio-read'] };

test('evaluation suites: validated (ids, prompts, checks, patterns); checks graded without a model', () => {
    assert.throws(() => validateSuite({ cases: [{ name: 'x', prompt: 'p', checks: [] }] }, 'a'), /at least one check/);
    assert.throws(() => validateSuite({ cases: [{ prompt: '', checks: [{ kind: 'contains', text: 'x' }] }] }, 'a'), /write the prompt/);
    assert.throws(() => validateSuite({ cases: [{ prompt: 'p', checks: [{ kind: 'matches', pattern: '(' }] }] }, 'a'), /Case 1: \( is not a valid pattern/);
    // A path is text, not a pattern (it used to be read as /…/).
    assert.doesNotThrow(() => validateSuite({ cases: [{ prompt: 'p', checks: [{ kind: 'contains', text: '/api/products' }] }] }, 'a'));
    assert.throws(() => validateSuite({ cases: [{ id: 'a', prompt: 'p', checks: [{ kind: 'cites-knowledge' }] }, { id: 'a', prompt: 'q', checks: [{ kind: 'cites-knowledge' }] }] }, 'a'), /Two cases are "a"/);
    assert.throws(() => validateSuite({ cases: [{ prompt: 'p', checks: [{ kind: 'judge', criteria: 'ok' }] }] }, 'a'), /grader's criteria/);
    assert.throws(() => validateSuite({ cases: [{ prompt: 'p', checks: [{ kind: 'nope' }] }] }, 'a'), /unknown check/);
    const s = validateSuite({ cases: [{ name: 'V2', prompt: 'Which version?', checks: [{ kind: 'contains', text: 'v2' }], repeat: 50 }] }, 'a');
    assert.deepEqual(s.cases.map((c) => [c.id, c.repeat]), [['case-1', 10]]);
    const a = { answer: 'Use /catalog/v2 [K:guide:1]', tools: [{ tool: 'knowledge_search', args: '{"query":"catalog version"}' }], calls: 3, ms: 4000 };
    assert.equal(grade({ kind: 'contains', text: 'CATALOG/V2' }, a)!.pass, true);
    assert.equal(grade({ kind: 'matches', pattern: 'catalog\\/v\\d' }, a)!.pass, true);
    assert.equal(grade({ kind: 'contains', text: '/catalog/v2' }, a)!.pass, true);
    assert.equal(grade({ kind: 'contains', text: '/catalog/m' }, { ...a, answer: 'The Catalog moved' })!.pass, false, 'a path is not read as a pattern with flags');
    assert.equal(grade({ kind: 'not-contains', text: 'v1' }, a)!.pass, true);
    assert.equal(grade({ kind: 'tool-called', tool: 'knowledge_search', args: 'version' }, a)!.pass, true);
    assert.match(grade({ kind: 'tool-called', tool: 'knowledge_search', args: 'login' }, a)!.detail, /never with "login"/);
    assert.match(grade({ kind: 'tool-called', tool: 'studio_call' }, a)!.detail, /was not called \(called: knowledge_search\)/);
    assert.equal(grade({ kind: 'tool-not-called', tool: 'studio_call' }, a)!.pass, true);
    assert.equal(grade({ kind: 'cites-knowledge' }, a)!.pass, true);
    assert.equal(grade({ kind: 'max-calls', calls: 2 }, a)!.pass, false);
    assert.equal(grade({ kind: 'max-seconds', seconds: 5 }, a)!.pass, true);
    assert.equal(grade({ kind: 'judge', criteria: 'x' }, a), null);
});

test('evaluation runs: safe sessions with the agent\'s profile, a grader, pass rates; the next run shows regressions and fixes; JUnit', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
    try {
        const gitDir = path.join(tmp, '.git');
        saveAgent(tmp, REVIEWER, 'Tester');
        saveSuite(tmp, 'catalog-reviewer', { cases: [
            { id: 'version', name: 'Knows the catalog version', prompt: 'Which catalog path should tests expect?', checks: [{ kind: 'contains', text: '/catalog/v2' }, { kind: 'tool-called', tool: 'knowledge_search' }, { kind: 'cites-knowledge' }, { kind: 'max-calls', calls: 5 }] },
            { id: 'no-edits', name: 'Suggests, does not edit', prompt: 'Fix catalog.feature.', checks: [{ kind: 'tool-not-called', tool: 'edit' }, { kind: 'judge', criteria: 'It suggests the exact change instead of making it.' }] },
            { id: 'steady', name: 'Steady answer', prompt: 'Say the guide name.', repeat: 3, checks: [{ kind: 'contains', text: 'team guide' }] },
        ] }, 'Tester');
        let good = false, steady = 0;
        const f = fakeAgent((title, msg, o) => {
            if (title.startsWith('Evaluation grader')) {
                assert.deepEqual(o.profile!.tools, [], 'the grader has no tools');
                assert.match(msg, /Criteria:\nIt suggests the exact change/);
                return { text: /would change/.test(msg) ? 'PASS\nIt proposes the change and edits nothing.' : 'FAIL: it edited the file.' };
            }
            assert.ok(o.readOnly && o.unattended && o.isolated && !o.autoFiles, 'a safe session');
            assert.equal(o.profile!.id, 'catalog-reviewer');
            if (/Which catalog path/.test(msg)) return good ? { tools: [['knowledge_search', { query: 'catalog path' }]], text: 'Expect /catalog/v2 [K:guide:3].' } : { text: 'Expect /catalog/v1.' };
            if (/Fix catalog/.test(msg)) return good ? { text: 'I would change "/catalog/v1" to "/catalog/v2" in catalog.feature.' } : { tools: [['edit', { path: 'catalog.feature' }]], text: 'Edited it.' };
            steady++;
            return { text: steady === 2 ? 'I do not know.' : 'The team guide.' };
        });
        const logs: string[] = [];
        const r = new EvalRunner({ repoRoot: tmp, gitDir, agent: f.agent, log: (_a, t) => logs.push(t) });
        assert.throws(() => r.start('nobody', 'Tester'), /No agent "nobody"/);
        const run1 = r.start('catalog-reviewer', 'Tester');
        assert.throws(() => r.start('catalog-reviewer', 'Tester'), /being evaluated now/);
        await until(() => !r.isRunning('catalog-reviewer'));
        const done1 = r.get('catalog-reviewer', run1.id)!;
        assert.equal(done1.state, 'done');
        assert.deepEqual(done1.cases.map((c) => [c.id, c.pass, c.passRate]), [['version', false, 0], ['no-edits', false, 0], ['steady', false, 2 / 3]]);
        assert.match(done1.cases[0].attempts[0].checks.map((k) => k.detail).join(' | '), /"\/catalog\/v2" is not in the answer \| knowledge_search was not called .* \| no \[K:…\] citation \| 2 model call\(s\)/);
        assert.deepEqual(done1.cases[1].attempts[0].checks.map((k) => [k.check.kind, k.pass, k.detail]), [['tool-not-called', false, 'called 1 time(s)'], ['judge', false, 'it edited the file.']]);
        assert.equal(done1.compared, undefined, 'nothing to compare with');
        assert.equal(f.aborted.length, f.opened.length, 'every session closed');
        // The agent improves: two cases fixed; the steady case still varies.
        good = true; steady = 0;
        await new Promise((res) => setTimeout(res, 5));
        const run2 = r.start('catalog-reviewer', 'Tester', ['version', 'no-edits']);
        await until(() => !r.isRunning('catalog-reviewer'));
        const done2 = r.get('catalog-reviewer', run2.id)!;
        assert.deepEqual(done2.cases.map((c) => [c.id, c.pass, !!c.fixed]), [['version', true, true], ['no-edits', true, true]]);
        assert.deepEqual(done2.compared, { run: run1.id, regressions: 0, fixed: 2 });
        assert.match(done2.cases[1].attempts[0].checks[1].detail, /proposes the change and edits nothing/);
        // It gets worse again: a regression.
        good = false;
        await new Promise((res) => setTimeout(res, 5));
        const run3 = r.start('catalog-reviewer', 'Tester', ['version']);
        await until(() => !r.isRunning('catalog-reviewer'));
        const done3 = r.get('catalog-reviewer', run3.id)!;
        assert.equal(done3.cases[0].regression, true);
        assert.deepEqual(done3.compared, { run: run2.id, regressions: 1, fixed: 0 });
        assert.deepEqual(r.runs('catalog-reviewer').map((x) => x.id), [run3.id, run2.id, run1.id]);
        const xml = evalJUnit(done1 as EvalRun);
        assert.match(xml, /<testsuite name="Evaluation: Catalog reviewer" tests="3" failures="3">/);
        assert.match(xml, /<failure message="67% of attempts passed">attempt 2: contains: &quot;team guide&quot; is not in the answer<\/failure>/);
        assert.ok(logs.some((l) => /Evaluated Catalog reviewer: 2 of 2 case\(s\) passed/.test(l)));
        assert.ok(logs.some((l) => /1 regression\(s\)/.test(l)));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('evaluation routes: suite saved and validated, runs listed; agents cannot start evaluations or edit agents', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-r-'));
    try {
        const dir = path.join(tmp, 'repo');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        saveAgent(dir, REVIEWER, 'Tester');
        const f = fakeAgent(() => ({ text: 'Use /catalog/v2.' }));
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const srv = createServer({ repoRoot: dir, store, userName: 'Tester', token: 'tk', missionAgent: f.agent });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.equal((await call('GET', '/api/evals/nobody')).status, 400);
        assert.deepEqual((await call('GET', '/api/evals/catalog-reviewer')).json.suite.cases, []);
        assert.match((await call('POST', '/api/evals/catalog-reviewer/run', {})).json.error, /No evaluation cases/);
        const bad = await call('PUT', '/api/evals/catalog-reviewer', { suite: { cases: [{ prompt: 'x', checks: [] }] } });
        assert.equal(bad.status, 400);
        assert.equal((await call('PUT', '/api/evals/catalog-reviewer', { suite: { cases: [{ id: 'v', name: 'Version', prompt: 'Which?', checks: [{ kind: 'contains', text: 'v2' }] }] } })).status, 200);
        assert.ok(fs.existsSync(path.join(dir, '.cs-studio/evals/catalog-reviewer.json')));
        // A built-in specialist can be evaluated too.
        assert.equal((await call('GET', '/api/evals/explorer')).status, 200);
        const started = await call('POST', '/api/evals/catalog-reviewer/run', {});
        assert.equal(started.status, 200);
        let v: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        await until(() => { void call('GET', '/api/evals/catalog-reviewer').then((x) => { v = x.json; }); return v && !v.running && v.runs[0]?.state === 'done'; });
        assert.deepEqual([v.runs[0].passed, v.runs[0].total], [1, 1]);
        const full = await call('GET', `/api/evals/catalog-reviewer/runs/${v.runs[0].id}`);
        assert.equal(full.json.cases[0].attempts[0].answer, 'Use /catalog/v2.');
        // Agents cannot reach these.
        const tools = (await import('../src/agents/tools')).studioTools({ repoRoot: dir, browser: {} as never, context: () => ({}), call: async () => ({ status: 200, body: {} }), approve: async () => true, changesNeedApproval: () => false, appsDir: tmp });
        const sc = tools.find((t) => t.name === 'studio_call')!;
        await assert.rejects(() => sc.handler({ method: 'POST', path: '/api/evals/catalog-reviewer/run' }) as Promise<unknown>, /not available to agents/);
        await assert.rejects(() => sc.handler({ method: 'PUT', path: '/api/agent-builder/catalog-reviewer' }) as Promise<unknown>, /not available to agents/);
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
