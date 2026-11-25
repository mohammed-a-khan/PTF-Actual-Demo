import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { usersAt, validPolicy, policyCurve, maxUsers, LoadPolicy } from '../src/load/policy';
import { Histogram } from '../src/load/metrics';
import { checkSlas, newScenario, parseCsv, validScenario, LoadScenario } from '../src/load/scenario';
import { LoadEngine } from '../src/load/engine';
import { newRequest } from '../src/api/model';

test('load policies: users at each second, ramp-up and ramp-down on every shape', () => {
    const ramp: LoadPolicy = { type: 'ramp', users: 100, duration: 100, rampUp: 20, rampDown: 10 };
    assert.deepEqual([0, 10, 19, 20, 50, 89, 90, 95, 99, 100].map((t) => usersAt(ramp, t)), [0, 50, 95, 100, 100, 100, 100, 50, 10, 0]);
    const steps: LoadPolicy = { type: 'steps', users: 25, duration: 60, startUsers: 5, stepUsers: 10, stepEvery: 10 };
    assert.deepEqual([0, 9, 10, 20, 30, 59].map((t) => usersAt(steps, t)), [5, 5, 15, 25, 25, 25]);
    const peaks: LoadPolicy = { type: 'peaks', users: 10, duration: 120, peakUsers: 50, peakEvery: 60, peakLength: 10 };
    assert.deepEqual([0, 49, 50, 59, 60, 110].map((t) => usersAt(peaks, t)), [10, 10, 50, 50, 10, 50]);
    const wave: LoadPolicy = { type: 'wave', users: 20, amplitude: 10, period: 40, duration: 80 };
    assert.deepEqual([0, 10, 20, 30].map((t) => usersAt(wave, t)), [20, 30, 20, 10]);
    assert.equal(usersAt({ type: 'constant', users: 7, duration: 5 }, 4.9), 7);
    assert.equal(maxUsers(ramp), 100);
    assert.equal(policyCurve(ramp).at(-1)!.users, 0);
    assert.match(validPolicy({ type: 'ramp', users: 10, duration: 10, rampUp: 8, rampDown: 5 })!, /longer than the run/);
    assert.match(validPolicy({ type: 'steps', users: 10, duration: 10 })!, /Steps need/);
    assert.equal(validPolicy(ramp), null);
});

test('percentiles from the histogram are within about 1% of the exact values', () => {
    const h = new Histogram();
    const xs: number[] = [];
    for (let i = 0; i < 20000; i++) { const v = 5 + Math.pow(Math.random(), 3) * 3000; xs.push(v); h.add(v); }
    xs.sort((a, b) => a - b);
    for (const p of [50, 90, 95, 99]) {
        const exact = xs[Math.ceil((p / 100) * xs.length) - 1];
        assert.ok(Math.abs(h.percentile(p) - exact) / exact < 0.012, `p${p}: ${h.percentile(p)} vs ${exact}`);
    }
    assert.equal(Math.round(h.max), Math.round(xs.at(-1)!));
});

test('CSV data files: header, quotes, escaped quotes, CRLF, BOM, blank lines', () => {
    const c = parseCsv('﻿user,pass,note\r\nasha,"s,cret","say ""hi"""\r\n\r\nravi,pw,\n');
    assert.deepEqual(c.columns, ['user', 'pass', 'note']);
    assert.deepEqual(c.rows, [{ user: 'asha', pass: 's,cret', note: 'say "hi"' }, { user: 'ravi', pass: 'pw', note: '' }]);
});

test('SLAs: global and per request, pass and fail with the numbers', () => {
    const tx = [{ id: 'a', name: 'Login', count: 10, errorRate: 0, avg: 120, p95: 300 }, { id: 'b', name: 'Search', count: 10, errorRate: 5, avg: 900, p95: 1500 }];
    const r = checkSlas([{ target: '*', p95: 2000, errorRate: 3 }, { target: 'a', p95: 250 }, { target: 'b', errorRate: 10, avg: 1000 }, { target: 'zz', p95: 1 }], tx, { errorRate: 2.5, avg: 510, p95: 1400 });
    assert.deepEqual(r.map((x) => x.pass), [true, false, true, false]);
    assert.deepEqual(r[1].details, ['p95 300 ms > 250 ms']);
    assert.match(r[3].details[0], /No requests/);
    assert.throws(() => validScenario({ ...newScenario('x', 'test/p/api/a.collection.json'), collection: '../x' }), /collection/);
    assert.throws(() => validScenario({ ...newScenario('x', 'test/p/api/a.collection.json'), data: { file: '../../etc/passwd.csv', mode: 'random' } }), /data file/);
});

/** A server where each login returns a new token, and /me only accepts the token of that user. */
function server(delay = 5) {
    const tokens = new Map<string, string>();
    let n = 0;
    const seen = { logins: 0, me: 0, wrong: 0, users: new Set<string>() };
    const s = http.createServer((req, res) => {
        let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => setTimeout(() => {
            const u = new URL(req.url!, 'http://x');
            if (u.pathname === '/login') {
                const user = JSON.parse(b).user; const t = `t${++n}`; tokens.set(t, user); seen.logins++; seen.users.add(user);
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ token: t })); return;
            }
            if (u.pathname === '/me') {
                seen.me++;
                const t = (req.headers.authorization ?? '').replace('Bearer ', '');
                const ok = tokens.get(t) === u.searchParams.get('user');
                if (!ok) seen.wrong++;
                res.writeHead(ok ? 200 : 403); res.end(ok ? '{"ok":true}' : '{"ok":false}'); return;
            }
            if (u.pathname === '/flaky') { res.writeHead(500); res.end('no'); return; }
            res.writeHead(404); res.end();
        }, delay));
    });
    return { s, seen, listen: () => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port))) };
}

function scenario(p: Partial<LoadScenario>): LoadScenario {
    return { ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], ...p };
}

test('engine: each virtual user logs in and uses its own token; data row per user; counts and stats', async () => {
    const { s, seen, listen } = server();
    const port = await listen();
    try {
        const login = { ...newRequest('Login', 'login'), method: 'POST' as const, url: '/login', body: { mode: 'json' as const, text: '{"user":"{{user}}"}' }, extract: [{ from: 'json' as const, path: '$.token', variable: 'token' }] };
        const me = { ...newRequest('Me', 'me'), url: '/me', query: [{ key: 'user', value: '{{user}}' }], auth: { type: 'bearer' as const, token: '{{token}}' } };
        const rows = Array.from({ length: 5 }, (_, i) => ({ user: `u${i}` }));
        const eng = new LoadEngine({ scenario: scenario({ policy: { type: 'constant', users: 5, duration: 2 }, data: { file: 'd.csv', mode: 'perUser' }, slas: [{ target: '*', errorRate: 0 }, { target: 'me', p95: 5000 }] }),
            collection: { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' } }, requests: [login, me], values: { vars: {}, config: {}, env: {} }, rows });
        const snaps: number[] = [];
        const r = await eng.run((x) => snaps.push(x.users));
        assert.equal(seen.wrong, 0, 'no user used another user\'s token');
        assert.equal(seen.users.size, 5);
        assert.ok(seen.me > 50, `${seen.me} /me requests`);
        assert.equal(r.total.errors, 0);
        assert.equal(r.total.count, seen.logins + seen.me);
        const tx = Object.fromEntries(r.transactions.map((t) => [t.id, t]));
        assert.equal(tx.login.count, seen.logins); assert.equal(tx.me.count, seen.me);
        assert.ok(tx.me.p50 >= 5 && tx.me.p95 >= tx.me.p50 && tx.me.max >= tx.me.p99);
        assert.equal(r.stopReason, 'completed'); assert.equal(r.passed, true);
        assert.ok(r.timeline.length >= 2 && r.timeline.every((x) => x.users <= 5));
        assert.ok(snaps.length >= 2);
        assert.ok(r.iterations > 10);
    } finally { s.close(); }
});

test('engine: think time slows users down; Stop ends a run early; error rate stops it', async () => {
    const { s, listen } = server(1);
    const port = await listen();
    try {
        const base = { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' as const } };
        const a = { ...newRequest('A', 'a'), method: 'POST' as const, url: '/login', body: { mode: 'json' as const, text: '{"user":"x"}' } };
        // 2 users, 300 ms think time after each request, 2 s: about 2 × (2 s / 0.3 s) ≈ 13 requests (hundreds without).
        const slow = await new LoadEngine({ scenario: scenario({ policy: { type: 'constant', users: 2, duration: 2 }, thinkTime: { min: 300, max: 300 } }), collection: base, requests: [a, { ...a, id: 'b' }], values: { vars: {}, config: {}, env: {} }, rows: [] }).run();
        assert.ok(slow.total.count >= 8 && slow.total.count <= 20, `${slow.total.count} requests`);
        const eng = new LoadEngine({ scenario: scenario({ policy: { type: 'constant', users: 3, duration: 60 } }), collection: base, requests: [a], values: { vars: {}, config: {}, env: {} }, rows: [] });
        setTimeout(() => eng.stop(), 700);
        const t = Date.now();
        const stopped = await eng.run();
        assert.ok(Date.now() - t < 3000); assert.equal(stopped.stopReason, 'stopped');
        const flaky = { ...newRequest('Flaky', 'f'), url: '/flaky', checks: [{ kind: 'status' as const, value: '200' }] };
        const bad = await new LoadEngine({ scenario: scenario({ policy: { type: 'constant', users: 4, duration: 60 }, stopOnErrorRate: 10, slas: [{ target: '*', errorRate: 1 }] }), collection: base, requests: [flaky], values: { vars: {}, config: {}, env: {} }, rows: [] }).run();
        assert.equal(bad.stopReason, 'error-rate'); assert.equal(bad.passed, false);
        assert.equal(bad.transactions[0].topErrors[0].message, 'Status is 200 (got 500)');
        assert.ok(bad.elapsed < 5);
    } finally { s.close(); }
});

test('prepareLoad reads the scenario, its collection and data; refuses files outside the project', async () => {
    const fs = await import('fs'); const os = await import('os'); const path = await import('path');
    const { prepareLoad } = await import('../src/load/prepare');
    const { junit } = await import('../src/load/runs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadprep-'));
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    w('config/shop/environments/dev.env', 'API_BASE_URL=https://shop.test\n');
    const r1 = { ...newRequest('A', 'a'), url: '/a' }, r2 = { ...newRequest('B', 'b'), url: '/b' };
    w('test/shop/api/c.collection.json', JSON.stringify({ format: 'cs-studio-api/1', name: 'C', baseUrl: '{config:API_BASE_URL}', variables: [{ key: 'k', value: '{env:SECRET_K}' }], auth: { type: 'none' }, items: [r1, r2] }));
    w('test/shop/data/users.csv', 'user\nu1\nu2\n');
    const sc = { ...newScenario('S', 'test/shop/api/c.collection.json'), requests: ['b'], data: { file: 'test/shop/data/users.csv', mode: 'perUser' as const } };
    w('test/shop/load/s.load.json', JSON.stringify(sc));
    const x = await prepareLoad(root, 'test/shop/load/s.load.json', undefined, () => ({ SECRET_K: 'v1' }));
    assert.equal(x.environment, 'dev');
    assert.deepEqual(x.input.requests.map((r) => r.id), ['b']);
    assert.equal(x.input.rows.length, 2);
    assert.equal(x.input.values.config.API_BASE_URL, 'https://shop.test');
    assert.equal(x.input.values.vars.k, 'v1');
    await assert.rejects(() => prepareLoad(root, 'test/shop/load/none.load.json', 'dev', () => ({})), /does not exist/);
    await assert.rejects(() => prepareLoad(root, '../x.load.json', 'dev', () => ({})), /Not a load scenario file/);
    w('test/shop/load/bad.load.json', JSON.stringify({ ...sc, data: { file: 'test/../../../etc/x.csv', mode: 'random' } }));
    await assert.rejects(() => prepareLoad(root, 'test/shop/load/bad.load.json', 'dev', () => ({})), /data file/);
    const xml = junit({ id: 'i', scenario: 's', name: 'S <1>', project: 'shop', env: 'dev', startedAt: 'now', state: 'finished', maxUsers: 1, duration: 1, definition: sc,
        result: { slas: [{ sla: { target: '*', p95: 1 }, name: 'All requests', pass: false, details: ['p95 5 ms > 1 ms'] }], stopReason: 'completed', elapsed: 1 } as never });
    assert.match(xml, /<testsuite name="S &lt;1&gt;" tests="2" failures="1"/);
    assert.match(xml, /<failure message="p95 5 ms &gt; 1 ms"\/>/);
});

test('browser paths: recorded scenarios import, smart selectors, step names', async () => {
    const { importRecordedScenarios, smartSelector, actionLabel, validBrowserPath } = await import('../src/load/browserPath');
    // The performance app's scenarios.json: [[id, scenario], …]
    const paths = importRecordedScenarios([['a', { name: 'Checkout', url: 'https://shop.test/app', authActions: [{ type: 'fill', selector: '#u', value: 'x' }], actions: [{ type: 'click', selector: '#go' }], browser: 'firefox' }],
        ['b', { name: 'No url', actions: [{ type: 'navigate', url: 'https://shop.test/x' }] }], ['c', { name: 'Broken' }]]);
    assert.deepEqual(paths.map((p) => [p.name, p.startUrl, p.signIn.length, p.actions.length, p.browser]), [['Checkout', 'https://shop.test/app', 1, 1, 'firefox'], ['No url', 'https://shop.test/x', 0, 1, 'chromium']]);
    assert.equal(validBrowserPath(paths[0]), paths[0]);
    assert.throws(() => importRecordedScenarios({ hello: 1 }), /No recorded scenario/);
    assert.throws(() => validBrowserPath({ ...paths[0], startUrl: 'file:///etc/passwd' }), /start URL/);
    // Bare tag / class-only list item → pinned by text; dynamic id → aria-label, then name.
    assert.equal(smartSelector({ type: 'click', selector: 'span', element: { text: 'Save' } }), 'span:has-text("Save")');
    assert.equal(smartSelector({ type: 'click', selector: 'li.item', element: { text: 'Cherries' } }), 'li.item:has-text("Cherries")');
    assert.equal(smartSelector({ type: 'click', selector: '#buy-17321234567890', element: { tagName: 'BUTTON', attributes: { 'aria-label': 'Buy now' } } }), 'button[aria-label="Buy now"]');
    assert.equal(smartSelector({ type: 'click', selector: '#x-a1b2c3d4-1234', element: { tagName: 'INPUT', attributes: { name: 'qty' } } }), 'input[name="qty"]');
    assert.equal(smartSelector({ type: 'click', selector: '#stable' }), '#stable');
    assert.equal(actionLabel({ type: 'click', selector: 'li.item', element: { text: 'Cherries' } }), 'Click "Cherries"');
    assert.equal(actionLabel({ type: 'dialog_accept' }), 'Accept the next dialog');
    assert.equal(actionLabel({ type: 'fill', selector: '#u', description: 'Type the user name' }), 'Type the user name');
});

test('engine: a request that cannot be sent (a value not filled in, no think time) does not spin; Stop ends the run', async () => {
    const r = { ...newRequest('Me', 'me'), url: 'http://127.0.0.1:9/me', auth: { type: 'bearer' as const, token: '' } };
    const eng = new LoadEngine({ scenario: scenario({ policy: { type: 'constant', users: 3, duration: 30 }, thinkTime: { min: 0, max: 0 } }), collection: { baseUrl: '', auth: { type: 'none' as const } } as never, requests: [r], values: { vars: {}, config: {}, env: {} }, rows: [] });
    const t0 = Date.now();
    const done = eng.run();
    setTimeout(() => eng.stop(), 1500);
    const res = await done;
    assert.ok(Date.now() - t0 < 8000, `stopped in ${Date.now() - t0} ms`);
    assert.equal(res.stopReason, 'stopped');
    assert.ok(res.total.count < 50, `few attempts, not a tight loop (${res.total.count})`);
});

test('engine: a target that refuses at once (no think time) is not retried in a tight loop', async () => {
    const net = await import('net');
    const srv = net.createServer(); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port; await new Promise<void>((r) => srv.close(() => r())); // now refused
    const r = { ...newRequest('Me', 'me'), url: `http://127.0.0.1:${port}/me` };
    const eng = new LoadEngine({ scenario: scenario({ policy: { type: 'constant', users: 1, duration: 30 }, thinkTime: { min: 0, max: 0 } }), collection: { baseUrl: '', auth: { type: 'none' as const } } as never, requests: [r], values: { vars: {}, config: {}, env: {} }, rows: [] });
    const done = eng.run();
    setTimeout(() => eng.stop(), 2000);
    const res = await done;
    assert.equal(res.total.errors, res.total.count);
    assert.ok(res.total.count > 2 && res.total.count < 20, `about 4 attempts a second, not thousands (${res.total.count})`);
});
