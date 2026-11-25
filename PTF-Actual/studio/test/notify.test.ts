import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { NotifyChannel, payload, previousState, RunNote, runNote, shouldNotify, validateChannels, validateWebhook } from '../src/notify/notify';
import type { RunInfo } from '../src/run/runner';

const ch = (o: Partial<NotifyChannel> = {}): NotifyChannel => ({ id: 'abcd', name: 'QA channel', kind: 'teams', when: 'failures', enabled: true, ...o });
const note = (o: Partial<RunNote> = {}): RunNote => ({ id: 'r1', state: 'failed', project: 'shop', env: 'qa', what: 'tags @smoke', startedAt: '2026-01-01T10:00:00Z', passed: 3, failed: 1, skipped: 0, failures: [{ name: 'Checkout', feature: 'Cart', error: 'expected 2 got 3' }], ...o });

test('shouldNotify: failures, always, changes; project and environment filters; disabled and stopped runs never', () => {
    assert.equal(shouldNotify(ch(), note()), true);
    assert.equal(shouldNotify(ch(), note({ state: 'passed' })), false);
    assert.equal(shouldNotify(ch({ when: 'always' }), note({ state: 'passed' })), true);
    assert.equal(shouldNotify(ch({ when: 'always' }), note({ state: 'stopped' })), false);
    assert.equal(shouldNotify(ch({ when: 'changes' }), note(), 'passed'), true, 'broke');
    assert.equal(shouldNotify(ch({ when: 'changes' }), note({ state: 'passed' }), 'failed'), true, 'fixed');
    assert.equal(shouldNotify(ch({ when: 'changes' }), note(), 'failed'), false);
    assert.equal(shouldNotify(ch({ when: 'changes' }), note(), undefined), false, 'no earlier run');
    assert.equal(shouldNotify(ch({ envs: ['prod'] }), note()), false);
    assert.equal(shouldNotify(ch({ projects: ['shop'], envs: ['qa'] }), note()), true);
    assert.equal(shouldNotify(ch({ enabled: false }), note()), false);
});

test('payloads: Teams adaptive card, Slack blocks, plain webhook JSON; long failure lists cut', () => {
    const many = note({ failures: Array.from({ length: 11 }, (_, i) => ({ name: `S${i}`, error: 'x'.repeat(500) })) });
    const t = payload('teams', many) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(t.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    const body = t.attachments[0].content.body;
    assert.match(body[0].text, /FAILED: shop on qa — 10 passed|FAILED: shop on qa — 3 passed, 1 failed/);
    assert.equal(body.filter((b: { text?: string }) => /^\*\*S\d/.test(b.text ?? '')).length, 8);
    assert.equal(body.at(-1).text, '…and 3 more');
    assert.ok(body.every((b: { text?: string }) => (b.text ?? '').length < 400));
    const s = payload('slack', note()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.match(s.text, /❌ FAILED: shop on qa — 3 passed, 1 failed/);
    assert.match(s.blocks[2].text.text, /Cart: Checkout\*\n {2}`expected 2 got 3`/);
    assert.deepEqual(payload('webhook', note()), { event: 'run.finished', run: note() });
});

test('validation: channel names unique, webhook addresses https and the service\'s own host', () => {
    assert.throws(() => validateChannels([ch(), ch({ id: 'efgh', name: 'qa CHANNEL' })]), /Two channels/);
    assert.throws(() => validateChannels([ch({ name: ' ' })]), /needs a name/);
    assert.equal(validateChannels([{ name: 'x', kind: 'nope', when: 'never' }])[0].kind, 'webhook');
    assert.throws(() => validateWebhook('slack', 'https://evil.example/hook'), /hooks\.slack\.com/);
    assert.ok(validateWebhook('slack', 'https://hooks.slack.com/services/T/B/x'));
    assert.ok(validateWebhook('teams', 'https://prod-01.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x'));
    assert.throws(() => validateWebhook('teams', 'https://example.com/x'), /Workflows/);
    assert.throws(() => validateWebhook('webhook', 'http://example.com/x'), /https/);
    assert.ok(validateWebhook('webhook', 'http://127.0.0.1:9/x'));
});

test('runNote / previousState: what ran, the failures; the previous run of the same tests', () => {
    const run = (id: string, state: string, at: string, tags = '@smoke'): RunInfo => ({ id, state, startedAt: at, endedAt: at.replace('00Z', '30Z'), request: { project: 'shop', env: 'qa', tags },
        summary: { total: 2, passed: 1, failed: 1, skipped: 0, duration: 1, reportDir: '', hasHtml: false, scenarios: [{ name: 'A', feature: 'F', status: 'passed', duration: 1 }, { name: 'B', feature: 'F', status: 'failed', duration: 1, error: 'boom' }] } } as unknown as RunInfo);
    const runs = [run('3', 'failed', '2026-01-03T00:00:00Z'), run('2', 'passed', '2026-01-02T00:00:00Z'), run('x', 'failed', '2026-01-02T12:00:00Z', '@other'), run('1', 'failed', '2026-01-01T00:00:00Z')];
    assert.equal(previousState(runs, runs[0]), 'passed');
    assert.equal(previousState(runs, runs[3]), undefined);
    const n = runNote(runs[0], 'Dana', 'main');
    assert.equal(n.what, 'tags @smoke');
    assert.equal(n.durationMs, 30_000);
    assert.deepEqual(n.failures, [{ name: 'B', feature: 'F', error: 'boom' }]);
    assert.equal(n.branch, 'main');
});

test('notification routes: channels saved with the webhook in the secret store (never returned), test message delivered', async () => {
    const got: Array<{ url: string; body: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const hook = http.createServer((req, res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { got.push({ url: req.url!, body: JSON.parse(d) }); res.writeHead(req.url === '/bad' ? 400 : 200); res.end(req.url === '/bad' ? 'Invalid payload' : '1'); }); });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    const port = (hook.address() as { port: number }).port;
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
    try {
        const dir = path.join(tmp, 'shop-tests');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        const home = path.join(tmp, 'home');
        const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
        store.setStudio('X', 'y');
        const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk', home });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: r.json() as any, body: r.body }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.deepEqual((await call('GET', '/api/notifications')).json.channels, []);
        assert.equal((await call('PUT', '/api/notifications', { channels: [{ id: 'abcd', name: 'QA', kind: 'slack', when: 'failures' }] })).status, 400, 'needs its webhook');
        const saved = await call('PUT', '/api/notifications', { channels: [{ id: 'abcd', name: 'QA', kind: 'webhook', when: 'always' }, { id: 'bad1', name: 'Broken', kind: 'webhook', when: 'always' }],
            webhooks: { abcd: `http://127.0.0.1:${port}/ok?sig=SECRET`, bad1: `http://127.0.0.1:${port}/bad` } });
        assert.equal(saved.status, 200, saved.body);
        assert.deepEqual(saved.json.channels.map((c: { name: string; hasWebhook: boolean }) => [c.name, c.hasWebhook]), [['QA', true], ['Broken', true]]);
        assert.doesNotMatch(saved.body, /SECRET/);
        const sent = await call('POST', '/api/notifications/test', { id: 'abcd' });
        assert.equal(sent.json.ok, true, sent.body);
        assert.equal(got[0].url, '/ok?sig=SECRET');
        assert.equal(got[0].body.event, 'run.finished');
        const bad = await call('POST', '/api/notifications/test', { id: 'bad1' });
        assert.deepEqual([bad.json.ok, bad.json.detail], [false, 'HTTP 400: Invalid payload']);
        const v = await call('GET', '/api/notifications');
        assert.equal(v.json.deliveries.length, 2);
        assert.doesNotMatch(v.body, /SECRET/);
        // Saved again without the address: the stored one is kept; a removed channel's address is deleted.
        assert.equal((await call('PUT', '/api/notifications', { channels: [{ id: 'abcd', name: 'QA', kind: 'webhook', when: 'failures' }] })).status, 200);
        assert.equal(store.getStudio('NOTIFY_WEBHOOK_BAD1'), undefined);
        assert.ok(store.getStudio('NOTIFY_WEBHOOK_ABCD'));
        await srv.app.close();
    } finally { hook.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
