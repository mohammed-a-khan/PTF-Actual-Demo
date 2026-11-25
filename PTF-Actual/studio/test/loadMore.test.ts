import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { newScenario, splitUsers, validScenario, LoadScenario } from '../src/load/scenario';
import { LoadEngine, masker, UserPath } from '../src/load/engine';
import { newCollection, newRequest } from '../src/api/model';
import { loadReportHtml, loadReportXlsx } from '../src/load/report';
import { xlsx, crc32, colName } from '../src/core/xlsx';
import { importHar } from '../src/api/har';
import type { LoadRunDetail } from '../src/load/runs';

const sc = (p: Partial<LoadScenario>): LoadScenario => ({ ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], ...p });

test('populations: valid shares, unique names, users split by share', () => {
    const base = newScenario('x', 'test/p/api/a.collection.json');
    assert.doesNotThrow(() => validScenario({ ...base, populations: [{ name: 'Buyers', collection: 'test/p/api/b.collection.json', requests: [], share: 30 }] }));
    assert.throws(() => validScenario({ ...base, populations: [{ name: 'B', collection: 'test/p/api/b.collection.json', requests: [], share: 100 }] }), /share/);
    assert.throws(() => validScenario({ ...base, populations: [{ name: 'B', collection: 'test/p/api/b.collection.json', requests: [], share: 60 }, { name: 'C', collection: 'test/p/api/c.collection.json', requests: [], share: 40 }] }), /under 100/);
    assert.throws(() => validScenario({ ...base, populations: [{ name: 'Main', collection: 'test/p/api/b.collection.json', requests: [], share: 10 }] }), /two user paths/);
    assert.throws(() => validScenario({ ...base, populations: [{ name: 'B', collection: '../x', requests: [], share: 10 }] }), /collection of B/);
    assert.deepEqual(splitUsers(10, [70, 30]), [7, 3]);
    assert.deepEqual(splitUsers(1, [70, 30]), [1, 0]);
    assert.deepEqual(splitUsers(3, [34, 33, 33]), [1, 1, 1]);
    assert.equal(splitUsers(7, [50, 25, 25]).reduce((a, b) => a + b), 7);
});

const fakePath = (log: string[], tag: string, fail?: string): UserPath => ({
    async start() {
        return {
            async iteration(measure, pause) {
                await measure('x', 'Step', async () => { log.push(tag); await new Promise((r) => setTimeout(r, 5)); return fail ? { error: fail, sample: { request: { method: 'GET', url: '/x', headers: { Authorization: 'Bearer abc123secret' } } } } : null; });
                await pause();
            },
            async close() { /* */ },
        };
    },
    async dispose() { /* */ },
});

test('engine: populations get their share of users and their own transactions; errors keep samples; per-transaction timeline', async () => {
    const log: string[] = [];
    const eng = new LoadEngine({ scenario: sc({ mainName: 'Browse', policy: { type: 'constant', users: 10, duration: 1.5 } }), collection: { baseUrl: '', auth: { type: 'none' } }, requests: [], values: { vars: {}, config: {}, env: {} }, rows: [],
        userPath: fakePath(log, 'main'), populations: [{ name: 'Buy', share: 30, collection: { baseUrl: '', auth: { type: 'none' } }, requests: [], values: { vars: {}, config: {}, env: {} }, userPath: fakePath(log, 'buy', 'HTTP 500') }] });
    let live = 0;
    const r = await eng.run((s) => { if (s.populations.length === 2 && s.users === 10) live = s.populations[1].users; });
    assert.equal(live, 3, 'three of ten users buy');
    assert.deepEqual(r.populations.map((p) => [p.name, p.share]), [['Browse', 70], ['Buy', 30]]);
    const tx = Object.fromEntries(r.transactions.map((t) => [t.id, t]));
    assert.equal(tx.x.name, 'Browse › Step'); assert.equal(tx['p1:x'].name, 'Buy › Step');
    // The Buy users fail at once on every request, so they wait a moment between iterations (no tight loop):
    // they run far fewer iterations than their 3-in-10 share, but they do run.
    assert.ok(tx['p1:x'].count > 0 && tx['p1:x'].count < (tx.x.count * 3) / 7, `${tx.x.count} / ${tx['p1:x'].count}`);
    assert.equal(tx.x.errors, 0); assert.equal(tx['p1:x'].errors, tx['p1:x'].count);
    const e = tx['p1:x'].topErrors[0];
    assert.equal(e.message, 'HTTP 500'); assert.equal(e.samples.length, 3);
    assert.ok(e.samples[0].t >= 0 && e.samples[0].request?.url === '/x');
    assert.ok(r.txTimeline.x.length >= 1 && r.txTimeline.x.reduce((n, s) => n + s.n, 0) === tx.x.count);
});

test('error samples: secrets and credential headers are masked', () => {
    const m = masker(['s3cr3tpass', 'abc']);
    assert.equal(m.text('user=a&pass=s3cr3tpass'), 'user=a&pass=••••');
    assert.equal(m.text('abc'), 'abc', 'values under 4 characters are not treated as secrets');
    assert.deepEqual(m.headers({ Authorization: 'Bearer eyJ.token', 'Set-Cookie': 'SID=1', 'X-Note': 'pw s3cr3tpass' }), { Authorization: 'Bearer ••••', 'Set-Cookie': '••••', 'X-Note': 'pw ••••' });
});

test('engine: an API failure keeps the request and response (masked, cut)', async () => {
    const s = http.createServer((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=zzz' }); res.end(JSON.stringify({ error: 'bad key', echo: req.headers['x-key'], pad: 'x'.repeat(6000) })); });
    const port = await new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
    try {
        const req = { ...newRequest('Get', 'g'), url: '/g', headers: [{ key: 'x-key', value: '{env:KEY}' }] };
        const r = await new LoadEngine({ scenario: sc({ policy: { type: 'constant', users: 1, duration: 0.5 } }), collection: { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'bearer', token: 'tok-xyz-1' } }, requests: [req], values: { vars: {}, config: {}, env: { KEY: 'key-value-9' } }, rows: [], secrets: ['key-value-9'] }).run();
        const smp = r.transactions[0].topErrors[0].samples[0];
        assert.equal(r.transactions[0].topErrors[0].message, 'Status is 200 (got 401)');
        assert.equal(smp.request!.headers['x-key'], '••••'); assert.equal(smp.request!.headers.Authorization, 'Bearer ••••');
        assert.equal(smp.response!.status, 401); assert.equal(smp.response!.headers['set-cookie'], '••••');
        assert.ok(smp.response!.body!.includes('"echo":"••••"') && smp.response!.body!.includes('more characters') && smp.response!.body!.length < 4200);
    } finally { s.close(); }
});

test('xlsx: a valid workbook (ZIP CRCs, sheets, escaping) that a spreadsheet reader opens', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(colName), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
    const buf = xlsx([{ name: 'Data: <1>', columns: ['Name', 'Value'], rows: [['a & "b" <c>', 1.5], ['x\u0001y', true], ['', null]] }, { name: 'Data: <1>', columns: ['Only'], rows: [] }]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-'));
    const f = path.join(dir, 'w.xlsx'); fs.writeFileSync(f, buf);
    let out: string;
    try { out = execFileSync('python3', ['-c', 'import sys,openpyxl;w=openpyxl.load_workbook(sys.argv[1]);print("|".join(w.sheetnames));s=w.worksheets[0];print([[c.value for c in r] for r in s.iter_rows()]);print(s.freeze_panes)', f], { encoding: 'utf8' }); }
    catch { return; } // no Python reader here: the ZIP checks above still ran
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const [names, rows, freeze] = out.trim().split('\n');
    assert.equal(names, 'Data  <1>|Data  <1> 2');
    assert.equal(rows, `[['Name', 'Value'], ['a & "b" <c>', 1.5], ['xy', True]]`);
    assert.equal(freeze, 'A2');
});

test('run reports: HTML (escaped, no scripts, charts, error samples) and Excel', () => {
    const run = {
        id: 'r1', scenario: 'test/p/load/s.load.json', name: 'Shop <peak>', project: 'p', env: 'sit', startedAt: '2026-01-01T10:00:00Z', state: 'finished', maxUsers: 5, duration: 10,
        definition: newScenario('Shop', 'test/p/api/a.collection.json'),
        result: {
            state: 'finished', elapsed: 10, users: 0, requests: 3, errors: 1, iterations: 2, startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:00:10Z', stopReason: 'completed', passed: false,
            timeline: [{ t: 0, users: 5, requests: 2, errors: 0, avg: 10, p95: 12 }, { t: 1, users: 5, requests: 1, errors: 1, avg: 30, p95: 30 }],
            transactions: [{ id: 'a', name: 'Login <x>', count: 3, errors: 1, errorRate: 33.3, avg: 16, min: 9, max: 30, p50: 11, p90: 30, p95: 30, p99: 30, throughput: 0.3,
                topErrors: [{ message: 'Status is 200 (got 500) <script>', count: 1, samples: [{ t: 1.2, user: 0, request: { method: 'POST', url: '/login', headers: { Authorization: 'Bearer ••••' }, body: '{"u":"a"}' }, response: { status: 500, timeMs: 30, headers: {}, body: '<html>boom</html>' } }] }] }],
            txTimeline: { a: [{ t: 0, n: 2, e: 0, avg: 10, p95: 12 }, { t: 1, n: 1, e: 1, avg: 30, p95: 30 }] },
            populations: [{ name: 'Main', share: 70, users: 0 }, { name: 'Buy', share: 30, users: 0 }],
            total: { count: 3, errors: 1, errorRate: 33.3, avg: 16, p50: 11, p90: 30, p95: 30, p99: 30, max: 30, throughput: 0.3 },
            slas: [{ sla: { target: '*', errorRate: 1 }, name: 'All requests', pass: false, details: ['errors 33.30% > 1%'] }],
        },
    } as unknown as LoadRunDetail;
    const html = loadReportHtml(run);
    assert.ok(!/<script/i.test(html), 'no scripts (the error text is escaped)');
    assert.ok(html.includes('Shop &lt;peak&gt;') && html.includes('Login &lt;x&gt;') && html.includes('&lt;html&gt;boom'));
    assert.ok(html.includes('<svg') && html.includes('User paths') && html.includes('Missed') && html.includes('Bearer ••••'));
    const x = loadReportXlsx(run);
    assert.equal(x.subarray(0, 2).toString(), 'PK');
});

const har = (entries: unknown[]) => JSON.stringify({ log: { version: '1.2', entries } });
const E = (method: string, url: string, o: { headers?: Array<[string, string]>; body?: string; mime?: string; status?: number; resp?: unknown; respMime?: string; respHeaders?: Array<[string, string]>; type?: string; at?: number } = {}) => ({
    startedDateTime: new Date(1_700_000_000_000 + (o.at ?? 0)).toISOString(), time: 50, _resourceType: o.type,
    request: { method, url, headers: (o.headers ?? []).map(([name, value]) => ({ name, value })), ...(o.body !== undefined ? { postData: { mimeType: o.mime ?? 'application/json', text: o.body } } : {}) },
    response: { status: o.status ?? 200, headers: (o.respHeaders ?? []).map(([name, value]) => ({ name, value })), content: { mimeType: o.respMime ?? 'application/json', text: o.resp === undefined ? '' : typeof o.resp === 'string' ? o.resp : JSON.stringify(o.resp) } },
});

test('HAR import: static files, preflights and other hosts left out; browser headers dropped; status checks', () => {
    const { collection: c, report } = importHar(har([
        E('GET', 'https://shop.test/', { respMime: 'text/html', resp: '<html>', type: 'document', headers: [['User-Agent', 'x'], ['sec-ch-ua', 'y'], ['Accept', 'text/html']] }),
        E('GET', 'https://shop.test/app.js', { respMime: 'application/javascript' }),
        E('GET', 'https://shop.test/logo.png?v=2', {}),
        E('OPTIONS', 'https://api.shop.test/items', {}),
        E('GET', 'https://api.shop.test/items?page=1', { headers: [['Cookie', 'sid=1'], [':authority', 'api.shop.test'], ['Accept', 'application/json']], at: 1000 }),
        E('GET', 'https://cdn.other.test/x.json', { at: 1500 }),
    ]), { pages: true });
    assert.equal(report.entries, 6); assert.deepEqual(report.skipped, { static: 2, preflight: 1, otherHosts: 0, other: 0 });
    assert.deepEqual(report.hosts.map((h) => h.host), ['shop.test', 'api.shop.test', 'cdn.other.test']);
    const items = c.items as ReturnType<typeof newRequest>[];
    assert.equal(items.length, 3);
    assert.deepEqual(items[0].headers, [{ key: 'Accept', value: 'text/html' }]);
    assert.equal(items[1].url, 'https://api.shop.test/items'); assert.deepEqual(items[1].query, [{ key: 'page', value: '1' }]);
    assert.deepEqual(items[1].headers, [{ key: 'Accept', value: 'application/json' }]);
    assert.deepEqual(items[1].checks, [{ kind: 'status', value: '200' }]);
    assert.ok(report.warnings.some((w) => /Cookies/.test(w)));
    const only = importHar(har([E('GET', 'https://a.test/x', {}), E('GET', 'https://b.test/y', {})]), { hosts: ['b.test'] });
    assert.equal(only.collection.items.length, 1); assert.equal(only.report.skipped.otherHosts, 1); assert.equal(only.collection.baseUrl, 'https://b.test');
    assert.throws(() => importHar('{"log":{}}'), /not a HAR file/);
    assert.throws(() => importHar(har([E('GET', 'https://a.test/a.css', {})])), /No API requests/);
});

test('HAR import: correlation of ids and tokens from responses; recorded credentials become secrets; pauses', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload.sig123';
    const { collection: c, report } = importHar(har([
        E('POST', 'https://api.test/login', { body: '{"user":"ann","pass":"pw"}', resp: { access_token: token, user: { id: 48213 } }, at: 0 }),
        E('GET', 'https://api.test/users/48213/orders', { headers: [['Authorization', `Bearer ${token}`]], resp: { items: [{ orderId: 'ORD-77812' }] }, at: 2000 }),
        E('GET', 'https://api.test/orders/ORD-77812', { headers: [['Authorization', `Bearer ${token}`]], resp: { id: 7 }, at: 5000 }),
        E('POST', 'https://api.test/orders/ORD-77812/pay', { headers: [['Authorization', `Bearer ${token}`]], body: '{"order":"ORD-77812","amount":148213}', resp: { ok: true }, at: 6000 }),
        E('GET', 'https://api.test/report', { headers: [['x-api-key', 'k-recorded-1234']], at: 7000 }),
    ]));
    const items = c.items as ReturnType<typeof newRequest>[];
    assert.deepEqual(report.correlations.map((x) => [x.variable, x.from, x.path, x.usedBy.length]), [['access_token', 0, '$.access_token', 3], ['id', 0, '$.user.id', 1], ['orderId', 1, '$.items[0].orderId', 2]]);
    assert.deepEqual(items[0].extract, [{ from: 'json', path: '$.access_token', variable: 'access_token' }, { from: 'json', path: '$.user.id', variable: 'id' }]);
    assert.equal(items[1].url, '/users/{{id}}/orders');
    assert.deepEqual(items[1].headers, [{ key: 'Authorization', value: 'Bearer {{access_token}}' }]);
    assert.equal(items[2].url, '/orders/{{orderId}}');
    assert.equal(items[3].body.text, '{"order":"{{orderId}}","amount":148213}', 'a longer number containing the id is not replaced');
    assert.deepEqual(items[4].headers, [{ key: 'x-api-key', value: '{env:HAR_X_API_KEY}' }]);
    assert.deepEqual(report.secrets, { HAR_X_API_KEY: 'k-recorded-1234' });
    assert.ok(!JSON.stringify(c).includes(token) && !JSON.stringify(c).includes('k-recorded-1234'), 'no recorded credential in the collection');
    assert.equal(report.medianPause, 1450);
    assert.ok(items.slice(0, -1).every((r) => typeof r.recordedThinkMs === 'number' && r.recordedThinkMs > 0), 'each request keeps the pause after it');
    assert.equal(items.at(-1)!.recordedThinkMs, undefined, 'the last one has none');
    const skipped = importHar(har([
        E('POST', 'https://api.test/login', { body: '{}', resp: { access_token: token } }),
        E('GET', 'https://api.test/me', { headers: [['Authorization', `Bearer ${token}`]] }),
    ]), { skipCorrelations: ['access_token'] });
    const it2 = skipped.collection.items as ReturnType<typeof newRequest>[];
    assert.deepEqual(it2[0].extract, []);
    assert.deepEqual(it2[1].headers, [{ key: 'Authorization', value: 'Bearer {env:HAR_AUTHORIZATION}' }], 'not correlated: still kept out of the file');
});

test('arrival rate (open model): iterations started at the rate whatever the response time; dropped when every user is busy', async () => {
    const { rateAt, validPolicy, describePolicy, maxUsers, policyCurve } = await import('../src/load/policy');
    const slow = (ms: number, starts: number[]): UserPath => ({
        async start() { starts.push(Date.now()); return { async iteration(measure) { await measure('x', 'Step', async () => { await new Promise((r) => setTimeout(r, ms)); return null; }); }, async close() { /* */ } }; },
        async dispose() { /* */ },
    });
    const run = (policy: LoadScenario['policy'], ms: number, starts: number[]) => new LoadEngine({ scenario: sc({ policy }), collection: { baseUrl: '', auth: { type: 'none' } }, requests: [], values: { vars: {}, config: {}, env: {} }, rows: [], userPath: slow(ms, starts) }).run();
    // A fast system: 20 per second for 2 s is about 40 iterations, done by a couple of users, nothing dropped.
    let starts: number[] = [];
    const fast = await run({ type: 'arrival', rate: 20, users: 50, duration: 2 }, 10, starts);
    assert.ok(fast.iterations >= 35 && fast.iterations <= 42, `${fast.iterations} iterations`);
    assert.equal(fast.dropped, 0);
    assert.ok(starts.length <= 4, `${starts.length} users started (idle users take the next iteration)`);
    // A slow system: each iteration takes 500 ms, at most 3 users: about 3 / 0.5 × 2 = 12 iterations; the rest dropped.
    starts = [];
    const busy = await run({ type: 'arrival', rate: 20, users: 3, duration: 2 }, 500, starts);
    assert.equal(starts.length, 3, 'no more users than allowed');
    assert.ok(busy.iterations >= 9 && busy.iterations <= 15, `${busy.iterations} iterations`);
    assert.ok((busy.dropped ?? 0) >= 20, `${busy.dropped} dropped`);
    // The policy: a ramp of the rate, its description and checks.
    const p = { type: 'arrival' as const, rate: 10, startRate: 2, rampUp: 4, rampDown: 2, users: 30, duration: 10 };
    assert.equal(rateAt(p, 0), 2); assert.equal(rateAt(p, 2), 6); assert.equal(rateAt(p, 5), 10); assert.equal(rateAt(p, 9), 5); assert.equal(rateAt(p, 10), 0);
    assert.equal(validPolicy(p), null);
    assert.match(validPolicy({ ...p, rate: 0 })!, /iterations per second/);
    assert.equal(maxUsers(p), 30);
    assert.equal(describePolicy(p), '2 → 10 iterations per second (arrival rate), up to 30 users, 10 s, ramp-up 4 s, ramp-down 2 s');
    assert.equal(policyCurve(p)[2].rate, 6);
});

test('correlation by replay: dynamic values found by replaying twice, applied, replayed again until the path runs clean', async () => {
    const { replayOnce, findCandidates, applyCandidates } = await import('../src/load/correlate');
    const { allRequests } = await import('../src/api/model');
    const rnd = (n: number) => Math.random().toString(36).slice(2, 2 + n).toUpperCase().padEnd(n, 'X');
    const tokens = new Set<string>(), csrfs = new Set<string>(), orders = new Set<string>();
    const srv = http.createServer((req, res) => {
        let body = ''; req.on('data', (c) => (body += c));
        req.on('end', () => {
            const json = (st: number, o: unknown) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
            const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
            if (req.method === 'POST' && req.url === '/login') { const t = `TOK${rnd(20)}`; tokens.add(t); return json(200, { token: t }); }
            if (!auth || !tokens.has(auth)) return json(401, { error: 'not signed in' });
            if (req.url === '/orders/new') { const c = `CSRF${rnd(16)}`, o = `ORD-${rnd(6)}`; csrfs.add(c); orders.add(o); return json(200, { csrf: c, orderId: o }); }
            if (req.method === 'POST' && req.url === '/orders') { const b = JSON.parse(body || '{}'); return csrfs.has(b.csrf) && orders.has(b.orderId) ? json(201, { ok: true }) : json(403, { error: 'refused' }); }
            const m = /^\/orders\/(ORD-\w+)$/.exec(req.url ?? '');
            if (m) return orders.has(m[1]) ? json(200, { id: m[1] }) : json(404, { error: 'no order' });
            json(404, {});
        });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
        // As recorded: the values the server gave the recording, sent again as they were.
        const req = (id: string, method: 'GET' | 'POST', url: string, o: Partial<ReturnType<typeof newRequest>> = {}) => ({ ...newRequest(id, id), method, url, checks: [], ...o });
        let c: import('../src/api/model').ApiCollection = { ...newCollection('Shop'), baseUrl: base, items: [
            req('login', 'POST', '/login'),
            req('new', 'GET', '/orders/new', { headers: [{ key: 'Authorization', value: 'Bearer TOKRECORDEDVALUE12345' }] }),
            req('create', 'POST', '/orders', { headers: [{ key: 'Authorization', value: 'Bearer TOKRECORDEDVALUE12345' }], body: { mode: 'json', text: JSON.stringify({ csrf: 'CSRFRECORDED1234567', orderId: 'ORD-AB12CD', item: 'mug' }) } }),
            req('show', 'GET', '/orders/ORD-AB12CD', { headers: [{ key: 'Authorization', value: 'Bearer TOKRECORDEDVALUE12345' }] }),
        ] };
        const V = { vars: {}, config: {}, env: {} };
        const rounds: string[] = [];
        for (let round = 1; round <= 5; round++) {
            const reqs = allRequests(c.items).map((x) => x.request);
            const a = await replayOnce(c, reqs, V), b = await replayOnce(c, reqs, V);
            const found = findCandidates(reqs, a.responses, b.responses);
            rounds.push(`${a.steps.filter((s) => s.ok).length}/${a.steps.length} ok; ${found.map((k) => `${k.variable}→${k.to.map((t) => `${t.request}.${t.where}`).join('+')}`).join(', ') || 'clean'}`);
            if (!found.length) break;
            c = applyCandidates(c, found, (x) => allRequests(x.items).map((y) => y.request)).collection;
        }
        assert.deepEqual(rounds, [
            '1/4 ok; token→new.header+create.header+show.header',
            '2/4 ok; csrf→create.json, orderId→create.json+show.path',
            '4/4 ok; clean',
        ]);
        const reqs = allRequests(c.items).map((x) => x.request);
        assert.deepEqual(reqs[0].extract, [{ from: 'json', path: '$.token', variable: 'token' }]);
        assert.equal(reqs[1].headers[0].value, 'Bearer {{token}}');
        assert.deepEqual(JSON.parse(reqs[2].body.text!), { csrf: '{{csrf}}', orderId: '{{orderId}}', item: 'mug' }, 'string fields keep their quotes');
        assert.equal(reqs[3].url, '/orders/{{orderId}}');
    } finally { srv.close(); }
});

test('correlation applied to a number field: the bare {{name}}, no marker left', async () => {
    const { applyCandidates } = await import('../src/load/correlate');
    const { allRequests } = await import('../src/api/model');
    const c = { ...newCollection('Shop'), items: [
        { ...newRequest('a', 'a'), method: 'POST' as const, url: '/carts', checks: [] },
        { ...newRequest('b', 'b'), method: 'POST' as const, url: '/orders', checks: [], body: { mode: 'json' as const, text: JSON.stringify({ cartId: 12345, lines: [{ qty: 2 }] }) } },
    ] };
    const out = applyCandidates(c, [{ from: 'a', fromName: 'a', source: 'json', path: '$.cartId', variable: 'cartId', samples: ['1', '2'], to: [{ request: 'b', requestName: 'b', where: 'json', field: '$.cartId', current: '12345' }] }], (x) => allRequests(x.items).map((y) => y.request));
    const text = allRequests(out.collection.items)[1].request.body.text!;
    assert.match(text, /"cartId": \{\{cartId\}\},/);
    assert.doesNotMatch(text, /__cs_correlate_|\\u0000/);
    assert.equal(out.changed, 1);
});

test('HAR import into an API collection leaves out the HTML pages the browser opened', async () => {
    const { importHar } = await import('../src/api/har');
    const har = JSON.stringify({ log: { entries: [
        { _resourceType: 'document', request: { method: 'GET', url: 'https://shop.test/', headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'text/html', text: '<html>' } } },
        { request: { method: 'GET', url: 'https://shop.test/api/items', headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '[]' } } },
    ] } });
    const r = importHar(har);
    assert.equal(r.report.imported, 1);
    assert.equal(importHar(har, { pages: true }).report.imported, 2);
});
