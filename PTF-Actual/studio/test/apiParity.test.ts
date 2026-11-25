import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { CookieJar, mergeCookieHeader } from '../src/api/cookies';
import { dynamicValue, fillDynamic, normalizeSyntax, TemplateResolver } from '../src/api/dynamic';
import { fill, fillTemplate, prepare, send, evaluateAll } from '../src/api/send';
import { newRequest, ApiCheck } from '../src/api/model';
import { CollectionRunner } from '../src/api/runner';
import { LoadEngine } from '../src/load/engine';
import { newScenario } from '../src/load/scenario';

test('cookie jar: domain, host-only, path, secure, expiry, replace, delete, order; request cookies win', () => {
    const j = new CookieJar();
    const t0 = Date.parse('2026-11-23T10:00:00Z');
    j.setFrom('https://app.example.com/account/login', [
        'SID=abc; Path=/; HttpOnly; Secure',
        'pref=dark; Domain=example.com; Path=/',
        'scoped=1',                                        // path /account (the request's directory)
        'other=x; Domain=evil.com',                       // another site: refused
        'tld=x; Domain=com',                              // a bare top-level label: refused
        'short=1; Max-Age=60',
        'gone=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT',  // already expired
    ], t0);
    // scoped and short got the login's directory (/account) as their path: they come first, oldest first.
    assert.equal(j.header('https://app.example.com/account/x', t0), 'scoped=1; short=1; SID=abc; pref=dark', 'longest path first, then oldest');
    assert.equal(j.header('http://app.example.com/', t0), 'pref=dark', 'Secure cookies only over https; /account cookies not on /');
    assert.equal(j.header('https://api.example.com/', t0), 'pref=dark', 'domain cookie on a subdomain; host-only cookies not');
    assert.equal(j.header('https://evil.com/', t0), undefined);
    assert.equal(j.header('https://app.example.com/', t0 + 61_000), 'SID=abc; pref=dark', 'Max-Age expires');
    j.setFrom('https://app.example.com/', ['SID=new; Path=/'], t0);
    assert.match(j.header('https://app.example.com/', t0)!, /SID=new/);
    j.setFrom('https://app.example.com/', ['SID=; Path=/; Max-Age=0'], t0);
    assert.doesNotMatch(j.header('https://app.example.com/', t0) ?? '', /SID=/, 'Max-Age=0 deletes');
    assert.equal(mergeCookieHeader('a=1; SID=mine', 'SID=jar; b=2'), 'a=1; SID=mine; b=2');
    j.clear(); assert.equal(j.size, 0);
});

test('dynamic values as the framework fills them; XML and data columns left as written', () => {
    assert.match(dynamicValue('uuid')!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(dynamicValue('timestamp')!, /^\d{13}$/);
    assert.match(dynamicValue('date:YYYY-MM-DD')!, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(dynamicValue('generate:email')!, /^test_\d+@example\.com$/);
    assert.equal(dynamicValue('generate:unknown'), undefined);
    const xml = '<Order><Id>{{id}}</Id><Ref><uuid></Ref></Order>';
    const out = fill(xml, { vars: { id: '7' }, config: {}, env: {} });
    assert.match(out, /^<Order><Id>7<\/Id><Ref>[0-9a-f-]{36}<\/Ref><\/Order>$/);
    assert.equal(fill('<email>', { vars: {}, config: {}, env: {}, row: { email: 'a@b.c' } }), 'a@b.c', 'a data column wins');
    assert.equal(fillDynamic('<Customer> <email>'), '<Customer> <email>');
});

test('payload templates as the framework\'s payload loader fills them: ${x}, functions, pipes, paths', () => {
    const v = { vars: { order: '{"id":5,"items":[{"sku":"A1"},{"sku":"B2"}]}', name: 'ada' }, config: {}, env: { REGION: 'eu' }, row: { qty: '3' } };
    const out = fillTemplate('{"n":"{{name | uppercase}}","q":{{qty}},"first":"{{order.items[0].sku}}","sku":"{{order.items.1.sku}}","b64":"{{base64(name)}}","sum":{{add(qty, 2)}},"region":"${config.REGION}","enc":{{jsonEncode(name)}},"all":{{order}},"id":"{{uuid()}}","mail":"{{faker.email()}}","kept":"{{nope}}"}', v);
    const j = JSON.parse(out.replace('"kept":"{{nope}}"', '"kept":null'));
    assert.deepEqual([j.n, j.q, j.sku, j.b64, j.sum, j.region, j.enc, j.all.id], ['ADA', 3, 'B2', 'YWRh', 5, 'eu', 'ada', 5]);
    assert.match(j.id, /^[0-9a-f-]{36}$/);
    assert.match(j.mail, /@/);
    assert.equal(normalizeSyntax('${testData.a} ${b} ${response.c}'), '{{a}} {{b}} {{responses.last.body.c}}');
    // Fresh values every time (no cached template).
    assert.notEqual(new TemplateResolver(new Map()).resolve('{{uuid()}}'), new TemplateResolver(new Map()).resolve('{{uuid()}}'));
});

test('templates: the Studio fills them exactly as the project\'s framework does', { skip: !process.env.CS_RECORDER_TEST_REPO && 'Needs a repository with the framework (CS_RECORDER_TEST_REPO)' }, () => {
    const f = path.join(process.env.CS_RECORDER_TEST_REPO!, 'node_modules', '@mdakhan.mak', 'cs-playwright-test-framework', 'dist', 'api', 'templates', 'CSPlaceholderResolver.js');
    if (!fs.existsSync(f)) return;
    const { CSPlaceholderResolver } = require(f); // eslint-disable-line @typescript-eslint/no-require-imports
    const templates = ['{{name | uppercase | substring(0, 2)}}', '{{base64(name)}}', '{{add(qty, 2)}}', '{{round(3.14159, 2)}}', '{{order.items}}', '{{order.items[1]}}', '{{jsonEncode(name)}}',
        '{{date("YYYY")}}', '{{sha256(name)}}', '{{hmac(name, "k")}}', '{{urlEncode("a b&c")}}', '{{if(true, "y", "n")}}', '{{switch(name, "ada", 1, 2)}}', '{{default(missing, "d")}}', '{{length(name)}}', '{{nope}}', '{{replace(name, "a", "o")}}', '{{capitalize(name)}}'];
    for (const t of templates) {
        const fw = new CSPlaceholderResolver();
        fw.setVariable('name', 'ada'); fw.setVariable('qty', 3); fw.setVariable('order', { items: ['A1', 'B2'] });
        const ours = new TemplateResolver(new Map<string, unknown>([['name', 'ada'], ['qty', 3], ['order', '{"items":["A1","B2"]}']]));
        const expected = fw.resolve(t);
        assert.equal(ours.resolve(t), expected, t);
    }
});

/** An app that keeps sessions in cookies: login sets the session through a redirect. */
function sessionApp() {
    const sessions = new Map<string, string>();
    let n = 0;
    const seen = { wrong: 0, me: 0, logins: 0 };
    const s = http.createServer((req, res) => {
        let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
            const u = new URL(req.url!, 'http://x');
            const sid = /(?:^|;\s*)SID=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
            if (u.pathname === '/login') {
                const user = new URLSearchParams(b).get('user') ?? JSON.parse(b || '{}').user;
                const id = `s${++n}`; sessions.set(id, user); seen.logins++;
                res.writeHead(302, { Location: '/home', 'Set-Cookie': [`SID=${id}; Path=/; HttpOnly`, 'theme=dark; Path=/'] }); res.end(); return;
            }
            if (u.pathname === '/home') { res.writeHead(sid ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ user: sid ? sessions.get(sid) : null })); return; }
            if (u.pathname === '/me') {
                seen.me++;
                const user = sid ? sessions.get(sid) : undefined;
                if (!user || user !== u.searchParams.get('user')) seen.wrong++;
                res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ user: user ?? null, orders: [{ id: 1, total: 9.5 }] }));
                return;
            }
            res.writeHead(404); res.end();
        });
    });
    return { s, seen, listen: () => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port))) };
}

test('session cookies: Send keeps them (redirect too), the runner per iteration, a load test per user and iteration; rule and schema checks run under load', async () => {
    const { s, seen, listen } = sessionApp();
    const port = await listen();
    const base = `http://127.0.0.1:${port}`;
    const coll = { baseUrl: base, auth: { type: 'none' as const } };
    const login = { ...newRequest('Login', 'login'), method: 'POST' as const, url: '/login', body: { mode: 'form' as const, form: [{ key: 'user', value: '{{user}}' }] } };
    const ruleChecks: ApiCheck[] = [
        { kind: 'rule', source: 'json', target: '$.user', op: 'equals', expected: { from: 'saved', value: 'user' } },
        { kind: 'schema', schema: JSON.stringify({ type: 'object', required: ['orders'], properties: { orders: { type: 'array', items: { type: 'object', required: ['id', 'total'] } } } }) },
    ];
    const me = { ...newRequest('Me', 'me'), url: '/me', query: [{ key: 'user', value: '{{user}}' }], checks: ruleChecks };
    try {
        // Send with a jar: the cookie set at the redirect is used on the redirected request and the next one.
        const jar = new CookieJar();
        const v = { vars: { user: 'ada' }, config: {}, env: {} };
        const r1 = await send(prepare(coll, login, v), undefined, 5000, jar);
        assert.deepEqual([r1.status, JSON.parse(r1.body).user], [200, 'ada']);
        const r2 = await send(prepare(coll, me, v), undefined, 5000, jar);
        assert.equal(r2.status, 200);
        assert.ok((await evaluateAll(ruleChecks, r2, v)).every((c) => c.pass));
        assert.deepEqual(jar.list().map((c) => c.name).sort(), ['SID', 'theme']);
        // Without a jar (as before): no session.
        assert.equal((await send(prepare(coll, me, v), undefined, 5000)).status, 401);

        // The runner: each iteration logs in and uses its own session.
        const runner = new CollectionRunner();
        const job = runner.start({ collection: { ...coll, name: 'c', variables: [], items: [] } as never, requests: [login, me], values: { vars: {}, config: {}, env: {} }, rows: [{ user: 'u1' }, { user: 'u2' }], iterations: 2, delayMs: 0, stopOnFailure: false, timeoutMs: 5000, mask: (t: string) => t } as never);
        for (let i = 0; i < 100 && runner.get(job.id)?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 30));
        const steps = runner.get(job.id)!.steps;
        assert.equal(steps.length, 4);
        assert.ok(steps.every((x) => x.passed), JSON.stringify(steps.map((x) => [x.name, x.error, x.checks])));

        // A load test: each user its own session, a new one each iteration; rule and schema checks pass under load.
        seen.wrong = 0;
        const rows = Array.from({ length: 4 }, (_, i) => ({ user: `lu${i}` }));
        const eng = new LoadEngine({ scenario: { ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], policy: { type: 'constant', users: 4, duration: 2 }, data: { file: 'd.csv', mode: 'perUser' } },
            collection: coll, requests: [login, me], values: { vars: {}, config: {}, env: {} }, rows });
        const lr = await eng.run();
        assert.equal(seen.wrong, 0, 'no user saw another user\'s session');
        assert.ok(lr.total.count > 20);
        assert.equal(lr.total.errors, 0, JSON.stringify(lr.errors ?? lr.transactions.map((t) => t.errors)));
        assert.ok(seen.logins > 8, 'a new session at each iteration');
    } finally { s.close(); }
});

test('schema files are read and checked as the framework finds them (TEST_DATA_PATH/api/schemas, then the project folder)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-schema-'));
    try {
        fs.mkdirSync(path.join(dir, 'test-data', 'api', 'schemas'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'test-data', 'api', 'schemas', 'order.json'), JSON.stringify({ type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }));
        const readFile = (rel: string) => fs.readFileSync(path.join(dir, rel));
        const res = { status: 200, statusText: 'OK', headers: {}, body: '{"id":"x"}', truncated: false, size: 10, timeMs: 1, redirects: [], json: { id: 'x' } };
        const check: ApiCheck = { kind: 'schema', schemaFile: 'order.json' };
        const [bad] = await evaluateAll([check], res, { vars: {}, config: {}, env: {}, readFile });
        assert.equal(bad.pass, false);
        assert.match(bad.message, /order\.json: \$\.id: must be integer/);
        const [good] = await evaluateAll([check], { ...res, json: { id: 3 }, body: '{"id":3}' }, { vars: {}, config: {}, env: {}, readFile });
        assert.equal(good.pass, true);
        const [missing] = await evaluateAll([{ kind: 'schema', schemaFile: 'nope.json' }], res, { vars: {}, config: {}, env: {}, readFile });
        assert.deepEqual([missing.pass, /not found/.test(missing.message)], [false, true]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('JSON schema: the Studio and the project\'s framework give the same verdict', { skip: !process.env.CS_RECORDER_TEST_REPO && 'Needs a repository with the framework (CS_RECORDER_TEST_REPO)' }, async () => {
    const f = path.join(process.env.CS_RECORDER_TEST_REPO!, 'node_modules', '@mdakhan.mak', 'cs-playwright-test-framework', 'dist', 'api', 'validators', 'CSSchemaValidator.js');
    if (!fs.existsSync(f)) return;
    const { CSSchemaValidator } = require(f); // eslint-disable-line @typescript-eslint/no-require-imports
    const { schemaErrors } = await import('../src/api/schema');
    const schema = { type: 'object', required: ['id'], properties: { id: { oneOf: [{ type: 'integer' }, { type: 'string', format: 'uuid' }] }, tags: { type: 'array', items: { type: 'string' }, maxItems: 2 }, at: { type: 'string', format: 'date' } }, additionalProperties: false };
    for (const body of [{ id: 1 }, { id: 'x' }, { id: 1, tags: ['a', 'b', 'c'] }, { id: 1, at: '2026-13-40' }, { id: 1, extra: true }, {}, { id: 1, tags: ['a'], at: '2026-11-23' }]) {
        const fw = new CSSchemaValidator().validate({ status: 200, headers: {}, body }, { schema });
        const ours = schemaErrors(body, schema);
        assert.equal(fw.valid, ours.length === 0, JSON.stringify(body));
        assert.deepEqual((fw.errors ?? []).map((e: { message: string }) => e.message), ours, JSON.stringify(body));
    }
});
