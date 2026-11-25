import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { collectInbox, InboxNotifier, type InboxItem } from '../src/agents/inbox';
import { inboxPayload } from '../src/notify/notify';
import type { MissionAgent, MissionRun } from '../src/agents/missions';
import type { MissionSessionOptions } from '../src/agents/host';
import type { EvalRun } from '../src/agents/evals';
import { createServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';

const mission = (o: Partial<MissionRun>): MissionRun => ({ id: 'm1', key: 'automate-story', title: 'Automate checkout', inputs: {}, state: 'working', trigger: { kind: 'manual', by: 'T' }, autonomy: 'autonomous', createdAt: '2026-11-24T10:00:00.000Z', budget: { minutes: 1, modelCalls: 1, attempts: 1 }, used: { activeMs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, attempts: 0 }, changes: [], timeline: [], checkpoints: [], verifications: [], memory: [], ...o } as MissionRun);

test('inbox items: questions, plans and approvals of working missions (with the member), work to review, conversation approvals, evaluation regressions; newest first', () => {
    const items = collectInbox({
        missions: () => [
            mission({ id: 'm1', state: 'waiting', checkpoints: [{ id: 'c1', kind: 'plan', question: 'Approve the plan?', content: 'Feature: Pay', at: '2026-11-24T10:05:00.000Z' }, { id: 'c0', kind: 'question', question: 'Old', answer: 'x', at: '2026-11-24T10:01:00.000Z' }],
                approvals: [{ id: 'a1', title: 'Test author: Run npm test', detail: 'npm test', kind: 'shell', who: 'Test author' }], timeline: [{ at: '2026-11-24T10:06:00.000Z', text: 'Waiting', kind: 'ask' }] }),
            mission({ id: 'm2', title: 'Fix run', state: 'succeeded', commit: 'abc', changes: [{ path: 'a.feature', status: 'M' }], endedAt: '2026-11-24T09:00:00.000Z', report: { outcome: 'done', summary: 'Fixed.' } }),
            mission({ id: 'm3', state: 'succeeded', commit: 'def', result: { kind: 'applied', at: 'x' } }),
            mission({ id: 'm4', state: 'stopped', checkpoints: [{ id: 'c9', kind: 'question', question: 'Never answered', at: '2026-11-24T08:00:00.000Z' }] }),
        ],
        conversations: () => [{ id: 's1', title: 'Login story', pending: [{ id: 'p1', title: 'Change a.ts', detail: 'diff', kind: 'write', at: '2026-11-24T11:00:00.000Z' }] }],
        evaluations: () => [
            { id: 'r1', agent: 'rev', agentName: 'Reviewer', state: 'done', startedAt: '2026-11-24T07:00:00.000Z', endedAt: '2026-11-24T07:01:00.000Z', compared: { run: 'r0', regressions: 1, fixed: 0 }, cases: [{ id: 'a', name: 'Cites the guide', regression: true }] } as unknown as EvalRun,
            { id: 'r2', agent: 'ok', agentName: 'Fine', state: 'done', startedAt: '2026-11-24T07:00:00.000Z', compared: { run: 'r1', regressions: 0, fixed: 1 }, cases: [] } as unknown as EvalRun,
        ],
    });
    assert.deepEqual(items.map((i) => [i.id, i.kind]), [['c:s1:p1', 'approval'], ['m:m1:ap:a1', 'approval'], ['m:m1:cp:c1', 'plan'], ['m:m2:review', 'review'], ['e:rev:r1', 'regression']]);
    assert.equal(items[1].who, 'Test author');
    assert.deepEqual(items[1].actions, ['approve', 'approve-session', 'reject', 'open']);
    assert.equal(items[2].detail, 'Feature: Pay');
    assert.deepEqual(items[3].actions, ['open']);
    assert.match(items[3].title, /1 file\(s\) ready to review/);
    assert.equal(items[4].detail, '- Cites the guide');
});

test('inbox notifier: what waits at start is not sent; each new item once; an item that goes and comes back is sent again', () => {
    const sent: string[] = [];
    const n = new InboxNotifier((i) => sent.push(i.id));
    const it = (id: string): InboxItem => ({ id, kind: 'question', title: id, source: { type: 'mission', id: 'm', title: 'M' }, at: '2026-11-24T10:00:00.000Z', actions: ['answer'] });
    assert.deepEqual(n.update([it('a')]), []);
    assert.deepEqual(n.update([it('a'), it('b')]).map((i) => i.id), ['b']);
    n.update([it('a'), it('b')]);
    n.update([it('b')]);
    n.update([it('a'), it('b')]);
    assert.deepEqual(sent, ['b', 'a']);
    const all: string[] = [];
    new InboxNotifier((i) => all.push(i.id), { notifyExisting: true }).update([it('x')]);
    assert.deepEqual(all, ['x']);
    // The messages: Teams card, Slack blocks, plain JSON.
    const note = { ...it('m:m1:cp:c1'), kind: 'plan', title: 'Approve the plan?', detail: 'Feature: Pay', who: 'Test author' };
    const teams = JSON.stringify(inboxPayload('teams', note));
    assert.match(teams, /A plan to approve: Approve the plan\?/);
    assert.match(teams, /Mission: M \(Test author\) · answer it in CS Test Studio → Inbox/);
    assert.match(JSON.stringify(inboxPayload('slack', note)), /"text":"🔔 A plan to approve: Approve the plan\?"/);
    assert.deepEqual(inboxPayload('webhook', note), { event: 'inbox.item', item: note });
});

test('inbox routes: a mission\'s plan shows in the inbox, is sent to an inbox channel once and answered from the inbox; agents cannot reach it', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
    const got: unknown[] = [];
    const hook = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { got.push(JSON.parse(b)); r.end('ok'); }); });
    await new Promise<void>((res) => hook.listen(0, '127.0.0.1', () => res()));
    const port = (hook.address() as { port: number }).port;
    try {
        const dir = path.join(tmp, 'repo');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        for (const [k, v] of [['user.name', 'Tester'], ['user.email', 't@example.test']]) await runGit(['config', k, v], { cwd: dir });
        fs.mkdirSync(path.join(dir, 'test/shop/features'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'test/shop/features/a.feature'), 'Feature: A\n');
        await runGit(['add', '-A'], { cwd: dir }); await runGit(['commit', '-q', '-m', 'init'], { cwd: dir });
        // A fake agent that asks for a plan and then reports blocked.
        let opts: MissionSessionOptions | null = null; let step = 0; let answer = '';
        const agent: MissionAgent = {
            async start(x) { opts = x.mission; return { id: 's1' }; },
            async send() {
                const n = step++;
                setImmediate(async () => {
                    const tool = (t: string, a: unknown) => opts!.tools.find((x) => x.name === t)!.handler(a) as Promise<string>;
                    if (n === 0) { answer = await tool('mission_ask', { kind: 'plan', question: 'Approve the checkout plan?', content: 'Feature: Checkout' }); await tool('mission_report', { outcome: 'blocked', summary: 'Stopping here.' }); }
                    opts!.listener?.({ type: 'idle', seq: n + 1, at: Date.now() });
                });
            },
            async abort() { /* */ }, usageOf: () => ({ usage: { calls: 1, inputTokens: 1, outputTokens: 1, cost: 0 }, busy: false, pending: 0 }),
        };
        const home = path.join(tmp, 'home');
        const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
        store.setStudio('X', 'y');
        const srv = createServer({ repoRoot: dir, store, home, userName: 'Tester', token: 'tk', missionAgent: agent });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.equal((await call('PUT', '/api/notifications', { channels: [{ id: 'abcd', name: 'QA', kind: 'webhook', when: 'failures', inbox: true }], webhooks: { abcd: `http://127.0.0.1:${port}/in` } })).status, 200);
        assert.deepEqual((await call('GET', '/api/inbox')).json.items, []);
        const m = await call('POST', '/api/missions', { key: 'automate-story', inputs: { project: 'shop', env: 'qa', story: 'Pay' }, autonomy: 'autonomous' });
        assert.equal(m.status, 200, JSON.stringify(m.json));
        let items: Array<{ id: string; kind: string; actions: string[] }> = [];
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) { items = (await call('GET', '/api/inbox')).json.items; if (items.length) break; await new Promise((r) => setTimeout(r, 30)); }
        assert.deepEqual(items.map((i) => i.kind), ['plan']);
        const id = items[0].id;
        assert.match(id, new RegExp(`^m:${m.json.id}:cp:`));
        // Sent to the inbox channel, once (the mission's own "waiting" notification is not sent to it as well).
        const t1 = Date.now();
        while (!got.length && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 30));
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(got.length, 1, JSON.stringify(got));
        assert.deepEqual((got[0] as { event: string; item: { id: string; title: string } }).event, 'inbox.item');
        assert.equal((got[0] as { item: { title: string } }).item.title, 'Approve the checkout plan?');
        // Answered from the inbox.
        assert.equal((await call('POST', '/api/inbox/act', { id, action: 'approve' })).status, 400, 'a plan is answered, not approved');
        assert.equal((await call('POST', '/api/inbox/act', { id: 'm:nope:cp:x', action: 'answer', text: 'ok' })).status, 400);
        const done = await call('POST', '/api/inbox/act', { id, action: 'answer', text: 'Approved' });
        assert.equal(done.status, 200, JSON.stringify(done.json));
        assert.deepEqual(done.json.items, []);
        const t2 = Date.now();
        while (answer === '' && Date.now() - t2 < 5000) await new Promise((r) => setTimeout(r, 20));
        assert.equal(answer, 'Approved. Go on with the plan as it is.');
        // Agents cannot answer their own questions through the Studio.
        const tools = (await import('../src/agents/tools')).studioTools({ repoRoot: dir, browser: {} as never, context: () => ({}), call: async () => ({ status: 200, body: {} }), approve: async () => true, changesNeedApproval: () => false, appsDir: tmp });
        await assert.rejects(() => tools.find((t) => t.name === 'studio_call')!.handler({ method: 'POST', path: '/api/inbox/act', body: { id, action: 'answer', text: 'yes' } }) as Promise<unknown>, /not available to agents/);
        await srv.app.close();
    } finally { hook.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
