import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiCollection, newCollection, newRequest, validCollection } from '../src/api/model';
import { checkValue, readPath, sameValue, supportedPath } from '../src/api/jsonPath';
import { evaluate, extract, fill, prepare, send, Values } from '../src/api/send';
import { quote, toFeature } from '../src/api/feature';
import { convertTests, importCollection } from '../src/api/collectionImport';
import { parseCurl, tokenize } from '../src/api/curl';
import { listCollections, readCollection, writeCollection } from '../src/api/store';

const V = (vars: Record<string, string> = {}, config: Record<string, string> = {}, env: Record<string, string> = {}): Values => ({ vars, config, env });

test('JSON paths read like the framework (its JSON path engine: dots, [n], [*], .., filters) and compare "200" with 200', () => {
    const body = { items: [{ id: 7, tags: ['a', 'b'] }], m: [[1, 2]], n: { ok: true } };
    assert.equal(readPath(body, '$.items[0].id'), 7);
    assert.equal(readPath(body, '$.items[0].tags[1]'), 'b');
    assert.equal(readPath(body, '$.m[0][1]'), 2);
    assert.equal(readPath(body, '$.n.ok'), true);
    assert.equal(readPath(body, '$.nope.deeper'), undefined);
    assert.equal(readPath([{ a: 1 }], '$[0].a'), 1);
    assert.ok(supportedPath('$.a.b[0].c') && supportedPath('$[0].a') && supportedPath('$.b-c.x') && supportedPath('$..a') && supportedPath("$['a']") && supportedPath('$.a[*]') && supportedPath("$.a[?(@.b=='x')].c"));
    assert.ok(!supportedPath('a.b') && !supportedPath('$.a[') && !supportedPath('$.a b'));
    assert.deepEqual(readPath(body, '$.items[*].id'), [7]);
    assert.deepEqual(readPath(body, '$.items[?(@.id == 7)].tags[0]'), ['a'], 'a path that selects several: the list');
    assert.equal(checkValue(body, '$.items[?(@.id >= 7)].tags[0]'), 'a', 'checked: its one match');
    assert.ok(sameValue('200', 200) && sameValue(1.5, '1.5') && !sameValue(null, 'null') && sameValue({ a: 1 }, { a: 1 }));
});

test('values: {{vars}}, {config:KEY}, {env:NAME}; missing ones are reported', () => {
    const missing = new Set<string>();
    assert.equal(fill('{{a}}/{config:B}/{env:C}/{{x}}', V({ a: '1' }, { B: '2' }, { C: '3' }), missing), '1/2/3/{{x}}');
    assert.deepEqual([...missing], ['{{x}}']);
});

test('prepare: base URL, query, auth, body and Content-Type', () => {
    const c = { baseUrl: '{config:BASE}/', auth: { type: 'bearer' as const, token: '{env:TOK}' } };
    const r = { ...newRequest('x'), method: 'POST' as const, url: 'users/{{id}}', query: [{ key: 'q', value: 'a b&c' }, { key: 'off', value: '1', enabled: false }], headers: [{ key: 'X-A', value: '{{id}}' }], body: { mode: 'json' as const, text: '{"n": "{{id}}"}' } };
    const p = prepare(c, r, V({ id: '42' }, { BASE: 'https://api.test' }, { TOK: 't0k' }));
    assert.equal(p.url, 'https://api.test/users/42?q=a%20b%26c');
    assert.deepEqual(p.headers, { 'X-A': '42', Authorization: 'Bearer t0k', 'Content-Type': 'application/json' });
    assert.equal(p.body, '{"n": "42"}');
    const form = prepare({ baseUrl: '', auth: { type: 'none' } }, { ...r, url: 'http://h/x', auth: { type: 'apikey', key: 'k', value: 'v', in: 'query' }, body: { mode: 'form', form: [{ key: 'a', value: '1&2' }] }, headers: [] }, V());
    assert.equal(form.url, 'http://h/x?q=a%20b%26c&k=v');
    assert.equal(form.body, 'a=1%262');
    assert.equal(form.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('send to a real local server; checks and saved values like the framework', async () => {
    const srv = http.createServer((req, res) => {
        if (req.url === '/redirect') { res.writeHead(302, { Location: '/users/1' }); res.end(); return; }
        let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
            res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json', 'X-Id': 'r1' });
            res.end(JSON.stringify({ id: 1, name: 'A', got: b, list: [{ v: 'x' }], flag: false }));
        });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
        const c = { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' as const } };
        const req = { ...newRequest('t'), method: 'POST' as const, url: '/users', body: { mode: 'text' as const, text: 'hello' },
            checks: [{ kind: 'status' as const, value: '201' }, { kind: 'jsonEquals' as const, target: '$.id', value: '1' }, { kind: 'jsonEquals' as const, target: '$.flag', value: 'false' },
                { kind: 'jsonEquals' as const, target: '$.list[0].v', value: 'x' }, { kind: 'headerEquals' as const, target: 'x-id', value: 'r1' }, { kind: 'bodyContains' as const, value: 'hello' },
                { kind: 'jsonEquals' as const, target: '$.name', value: 'B' }, { kind: 'timeBelow' as const, value: '5000' }],
            extract: [{ from: 'json' as const, path: '$.list[0].v', variable: 'v' }, { from: 'header' as const, path: 'X-Id', variable: 'rid' }, { from: 'json' as const, path: '$.no', variable: 'none' }] };
        const res = await send(prepare(c, req, V()));
        assert.equal(res.status, 201);
        assert.deepEqual(evaluate(req.checks, res, V()).map((x) => x.pass), [true, true, true, true, true, true, false, true]);
        assert.deepEqual(extract(req.extract, res), [{ variable: 'v', value: 'x', found: true }, { variable: 'rid', value: 'r1', found: true }, { variable: 'none', found: false }]);
        const red = await send(prepare(c, { ...newRequest(), url: '/redirect' }, V()));
        assert.equal(red.status, 200);
        assert.deepEqual(red.redirects, [`http://127.0.0.1:${port}/users/1`]);
        await assert.rejects(send(prepare({ baseUrl: 'http://127.0.0.1:1', auth: { type: 'none' } }, newRequest(), V()), undefined, 3000), /refused|127\.0\.0\.1/);
    } finally { srv.close(); }
});

test('feature: framework steps, query in the URL, body Content-Type, chained requests, header reset', () => {
    const c: ApiCollection = { ...newCollection('Orders API'), baseUrl: '{config:API_BASE_URL}', variables: [{ key: 'who', value: 'it\'s "me"' }, { key: 'tok', value: '{env:TOKEN}', secret: true }] };
    const login = { ...newRequest('Log in', 'a'), method: 'POST' as const, url: '/login', body: { mode: 'json' as const, text: '{"p":"{env:PW}"}' }, extract: [{ from: 'json' as const, path: '$.token', variable: 'token' }] };
    const get = { ...newRequest('Get order', 'b'), url: '/orders/{{id}}', query: [{ key: 'x', value: 'a b' }], auth: { type: 'bearer' as const, token: '{{token}}' },
        checks: [{ kind: 'status' as const, value: '200' }, { kind: 'jsonEquals' as const, target: '$.n', value: '-3' }, { kind: 'jsonEquals' as const, target: '$.s', value: '"7"' }] };
    const other = { ...newRequest('Health', 'c'), method: 'HEAD' as const, url: '/health' };
    c.items = [{ kind: 'folder', id: 'f', name: 'Order flow', items: [login, get] }, other];
    const f = toFeature(c);
    const t = f.text;
    assert.match(t, /^@api @orders-api\nFeature: Orders API\n/);
    assert.match(t, /Given user is working with "Orders API" API\n    And the API base URL is "\{config:API_BASE_URL\}"\n    And user clears all request headers\n    And I clear authentication\n/);
    assert.match(t, /And I set variable "tok" to "\{env:TOKEN\}"/);
    assert.ok(f.warnings.some((w) => /both " and '/.test(w)), 'a value with both quotes is reported');
    assert.match(t, /# And I set variable "who" to "[^\n]*\\"/);
    assert.match(t, /@order-flow\n  Scenario: Log in, then Get order\n/);
    assert.match(t, /Given I set request header "Content-Type" to "application\/json"\n    And I set variable "env_PW" to "\{env:PW\}"\n    And I set request body to:\n      """\n      \{\n        "p": "\{\{env_PW\}\}"\n      \}\n      """\n    When I send a POST request to "\/login"/);
    assert.match(t, /Given user clears all request headers\n    And I clear authentication\n    And I set request header "Authorization" to "Bearer \{\{token\}\}"\n    When I send a GET request to "\/orders\/\{\{id\}\}\?x=a%20b"/);
    assert.match(t, /And the response body JSON path "\$\.n" should be "-3"/);
    assert.match(t, /And the response body JSON path "\$\.s" should be "7"/);
    assert.match(t, /When user sends "HEAD" request to "\/health"/, 'any method: the framework step that takes the method');
    assert.equal(f.scenarios, 2);
    // Form bodies: the framework's form step (it URL-encodes values, so "s&cret" stays one field);
    // a later request of the scenario starts from an empty body.
    const form = toFeature({ ...newCollection('F'), items: [
        { ...newRequest('A', 'a'), method: 'POST', url: '/a', body: { mode: 'json', text: '{"x":1}' }, extract: [{ from: 'json', path: '$.t', variable: 't' }] },
        { ...newRequest('B', 'b'), method: 'POST', url: '/b?t={{t}}', body: { mode: 'form', form: [{ key: 'pass', value: '{{t}}' }, { key: 'off', value: '1', enabled: false }] } },
    ] }).text;
    assert.ok(form.includes([
        '    And I clear authentication',
        '    And I set request header "Content-Type" to "application/x-www-form-urlencoded"',
        '    And I set request body to:',
        '      """',
        '      """',
        '    And user sets form field "pass" to "{{t}}"',
        '    When I send a POST request to "/b?t={{t}}"',
    ].join('\n')), form);
    assert.ok(!form.includes('"off"'));
    assert.equal(quote('a"b'), "'a\"b'");
    assert.equal(quote(`a"b'c`), null);
});

test('collection file v2.1: folders, URL objects, path variables, bodies, auth, scripts, environment secrets', () => {
    const file = {
        info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        variable: [{ key: 'baseUrl', value: 'https://shop.test/api' }],
        auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
        item: [{ name: 'Orders', item: [
            { name: 'Get order', request: { method: 'GET', url: { raw: '{{baseUrl}}/orders/:id?expand=items', host: ['{{baseUrl}}'], path: ['orders', ':id'], query: [{ key: 'expand', value: 'items' }], variable: [{ key: 'id', value: '42' }] } },
                event: [{ listen: 'test', script: { exec: ['pm.test("ok", function () {', '    pm.response.to.have.status(200);', '});', 'var jsonData = pm.response.json();', 'pm.expect(jsonData.items[0].sku).to.eql("A-1");', 'pm.expect(jsonData.paid).to.be.true;', 'pm.environment.set("orderId", jsonData.id);', 'pm.collectionVariables.set("etag", pm.response.headers.get("ETag"));', 'pm.expect(pm.response.responseTime).to.be.below(800);', 'console.log(jsonData);'] } }] },
            { name: 'Create', request: { method: 'POST', url: '{{baseUrl}}/orders', header: [{ key: 'X-Trace', value: '1' }, { key: 'X-Off', value: '0', disabled: true }], body: { mode: 'raw', raw: '{"sku":"A-1"}', options: { raw: { language: 'json' } } }, auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] } } },
            { name: 'Login', request: { method: 'POST', url: '{{baseUrl}}/login', body: { mode: 'urlencoded', urlencoded: [{ key: 'u', value: 'x' }] } } },
            { name: 'Upload', request: { method: 'POST', url: '{{baseUrl}}/files', body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: '/x' }, { key: 'note', value: 'n', type: 'text' }] } } },
            { name: 'Graph', request: { method: 'POST', url: '{{baseUrl}}/graphql', body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } }, auth: { type: 'oauth2' } } },
        ] }],
    };
    const env = { name: 'dev', values: [{ key: 'token', value: 's3cr3t', type: 'secret', enabled: true }, { key: 'region', value: 'eu', enabled: true }] };
    const { collection: c, report } = importCollection(file, env);
    assert.equal(c.name, 'Shop');
    assert.equal(c.baseUrl, 'https://shop.test/api');
    assert.deepEqual(c.variables, [{ key: 'token', value: '{env:TOKEN}', secret: true }, { key: 'region', value: 'eu' }]);
    assert.deepEqual(report.secrets, { TOKEN: 's3cr3t' });
    assert.deepEqual(c.auth, { type: 'bearer', token: '{{token}}' });
    const folder = c.items[0];
    assert.ok(folder.kind === 'folder');
    const [get, create, login, upload, graph] = folder.items as Array<Extract<typeof folder.items[number], { kind: 'request' }>>;
    assert.equal(get.url, '/orders/42');
    assert.deepEqual(get.query, [{ key: 'expand', value: 'items' }]);
    assert.deepEqual(get.checks, [{ kind: 'status', value: '200' }, { kind: 'jsonEquals', target: '$.items[0].sku', value: 'A-1' }, { kind: 'jsonEquals', target: '$.paid', value: 'true' }, { kind: 'timeBelow', value: '800' }]);
    assert.deepEqual(get.extract, [{ from: 'json', path: '$.id', variable: 'orderId' }, { from: 'header', path: 'ETag', variable: 'etag' }]);
    assert.deepEqual(get.notes, ['Test script not converted: console.log(jsonData);']);
    assert.deepEqual(create.headers, [{ key: 'X-Trace', value: '1' }, { key: 'X-Off', value: '0', enabled: false }]);
    assert.deepEqual(create.body, { mode: 'json', text: '{"sku":"A-1"}' });
    assert.deepEqual(create.auth, { type: 'basic', username: 'u', password: 'p' });
    assert.deepEqual(create.checks, [{ kind: 'statusBetween', min: 200, max: 299 }]);
    assert.deepEqual(login.body, { mode: 'form', form: [{ key: 'u', value: 'x' }] });
    assert.deepEqual(upload.body, { mode: 'multipart', parts: [{ key: 'f', value: 'x', type: 'file' }, { key: 'note', value: 'n', type: 'text' }] });
    assert.deepEqual(graph.body, { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } }, 'GraphQL stays GraphQL (query and variables)');
    assert.deepEqual(graph.auth, { type: 'oauth2', grant: 'authorization_code', tokenUrl: '', clientId: '', clientSecret: '', authUrl: '', pkce: false });
    assert.equal(report.requests, 5);
    assert.ok(report.warnings.some((w) => /file field/.test(w)) && !report.warnings.some((w) => /OAuth/.test(w)), 'the authorization code grant is imported (a browser sign-in in the Studio)');
    assert.throws(() => importCollection({ hello: 1 }), /not a collection file/);
    // A quoted number stays a string; a bare one is a number.
    assert.deepEqual(convertTests(['const d = pm.response.json();', 'pm.expect(d.a).to.eql("5");', 'pm.expect(d["b-c"].x).to.equal(5);']).checks,
        [{ kind: 'jsonEquals', target: '$.a', value: '"5"' }, { kind: 'jsonEquals', target: '$.b-c.x', value: '5' }]);
});

test('cURL: bash and Windows quoting, headers, data, auth, -G, --json, form', () => {
    assert.deepEqual(tokenize(`curl 'https://x.test/a?b=1' -H "A: \\"q\\"" \\\n --data-raw $'line1\\nline2'`), ['curl', 'https://x.test/a?b=1', '-H', 'A: "q"', '--data-raw', 'line1\nline2']);
    const a = parseCurl(`curl 'https://api.test/v1/users?page=2' -X PUT -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' --data-raw '{"name":"x"}' --compressed -k`).request;
    assert.equal(a.method, 'PUT'); assert.equal(a.url, 'https://api.test/v1/users'); assert.deepEqual(a.query, [{ key: 'page', value: '2' }]);
    assert.deepEqual(a.body, { mode: 'json', text: '{"name":"x"}' });
    assert.equal(a.name, 'PUT v1/users');
    // As Chrome's "Copy as cURL (cmd)" writes it: ^ before { } and ^\^" for a quote.
    const w = parseCurl('curl "https://api.test/x" ^\n  -H "Accept: */*" ^\n  --data-raw "^{^\\^"a^\\^":1^}"').request;
    assert.equal(w.method, 'POST'); assert.deepEqual(w.body, { mode: 'json', text: '{"a":1}' });
    const g = parseCurl(`curl -G https://api.test/s -d q=a+b -d n=1 -u me:p:w`).request;
    assert.equal(g.method, 'GET'); assert.deepEqual(g.query, [{ key: 'q', value: 'a b' }, { key: 'n', value: '1' }]);
    assert.deepEqual(g.auth, { type: 'basic', username: 'me', password: 'p:w' });
    const j = parseCurl(`curl --json '{"a":1}' https://api.test/j`).request;
    assert.equal(j.method, 'POST'); assert.ok(j.headers.some((h) => h.key === 'Content-Type' && h.value === 'application/json'));
    const f = parseCurl(`curl https://api.test/f -d 'a=1&b=x%20y'`).request;
    assert.deepEqual(f.body, { mode: 'form', form: [{ key: 'a', value: '1' }, { key: 'b', value: 'x y' }] });
    const up = parseCurl(`curl https://api.test/u -F name=n -F file=@/tmp/a.txt`);
    assert.deepEqual(up.request.body, { mode: 'multipart', parts: [{ key: 'name', value: 'n', type: 'text' }, { key: 'file', value: 'a.txt', type: 'file' }] }); assert.ok(up.warnings.length === 1);
    assert.equal(up.request.method, 'POST');
    const up2 = parseCurl(`curl https://api.test/u -F "doc=@C:\\docs\\r.pdf;type=application/pdf" -H "Content-Type: multipart/form-data"`);
    assert.deepEqual(up2.request.body, { mode: 'multipart', parts: [{ key: 'doc', value: 'r.pdf', type: 'file' }] });
    assert.deepEqual(up2.request.headers, []);
    assert.throws(() => parseCurl('wget x'), /does not start with "curl"/);
    assert.throws(() => parseCurl("curl 'unclosed"), /not closed/);
});

test('collections are stored in test/<project>/api and validated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apiws-'));
    const c = { ...newCollection('Pet Store'), items: [newRequest('List pets')] };
    const rel = writeCollection(root, 'shop', c);
    assert.equal(rel, 'test/shop/api/pet-store.collection.json');
    assert.deepEqual(readCollection(root, rel).items.length, 1);
    assert.deepEqual(listCollections(root, ['shop', 'none']).map((x) => [x.name, x.requests, x.file]), [['Pet Store', 1, rel]]);
    assert.throws(() => readCollection(root, '../etc/passwd'), /Not a collection file/);
    assert.throws(() => writeCollection(root, 'shop', c, 'test/other/api/x.collection.json'), /Not a collection file/);
    assert.throws(() => validCollection({ ...c, items: [{ ...newRequest(), method: 'GET X' }] }), /method GET X/);
});

test('any HTTP method: kept on import and from cURL; sent by the framework step that takes the method, with its body', async () => {
    const { httpMethod } = await import('../src/api/model');
    const { parseCurl } = await import('../src/api/curl');
    const { importCollection } = await import('../src/api/collectionImport');
    assert.deepEqual(['purge', 'PROPFIND', ' report ', 'M-SEARCH', 'CONNECT', 'GET X', '', 'é'].map(httpMethod), ['PURGE', 'PROPFIND', 'REPORT', 'M-SEARCH', null, null, null, null]);
    assert.equal(parseCurl('curl -X PURGE https://cdn.example.test/img/1.png').request.method, 'PURGE');
    assert.throws(() => parseCurl('curl -X "GET X" https://a.test/'), /"GET X" is not an HTTP method/);
    const imp = importCollection(({ info: { name: 'DAV', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [
        { name: 'Props', request: { method: 'propfind', url: 'https://dav.test/files/', body: { mode: 'raw', raw: '<propfind xmlns="DAV:"><allprop/></propfind>', options: { raw: { language: 'xml' } } } } },
        { name: 'Bad', request: { method: 'GET X', url: 'https://dav.test/' } }] }));
    const reqs = imp.collection.items.map((i) => (i as { method: string }).method);
    assert.deepEqual(reqs, ['PROPFIND', 'GET']);
    assert.deepEqual(imp.report.warnings.filter((w) => /HTTP method/.test(w)), ['"Bad": "GET X" is not an HTTP method; imported as GET.']);
    const c = { ...newCollection('DAV'), items: [
        { ...newRequest('Props', 'a'), method: 'PROPFIND', url: '/files/', body: { mode: 'xml' as const, text: '<propfind xmlns="DAV:"><allprop/></propfind>' } },
        { ...newRequest('Remove', 'b'), method: 'DELETE', url: '/orders', body: { mode: 'json' as const, text: '{"ids":[1,2]}' } },
        { ...newRequest('Plain delete', 'd'), method: 'DELETE', url: '/orders/1' }] };
    const t = toFeature(c).text;
    assert.match(t, /Given I set request header "Content-Type" to "application\/xml"\n    And I set request body to:\n      """\n      <propfind xmlns="DAV:"><allprop\/><\/propfind>\n      """\n    When user sends "PROPFIND" request to "\/files\/"/);
    assert.match(t, /And I set request body to:\n      """\n      \{\n        "ids": \[\n          1,\n          2\n        \]\n      \}\n      """\n    When user sends "DELETE" request to "\/orders"/, 'a DELETE with a body keeps it');
    assert.match(t, /When I send a DELETE request to "\/orders\/1"/);
});

test('Postman: tests written on one line become checks and saved values', async () => {
    const { convertTests, unwrapOneLineTests } = await import('../src/api/collectionImport');
    assert.deepEqual(unwrapOneLineTests(['pm.test("a; b", function () { pm.response.to.have.status(201); pm.expect(pm.response.text()).to.include("x;y"); });']),
        ['pm.response.to.have.status(201)', 'pm.expect(pm.response.text()).to.include("x;y")']);
    const c = convertTests(['pm.test("ok", () => pm.response.to.have.status(200));', 'pm.environment.set("mid", pm.response.json().method);']);
    assert.deepEqual(c.checks, [{ kind: 'status', value: '200' }]);
    assert.deepEqual(c.extract, [{ from: 'json', path: '$.method', variable: 'mid' }]);
    assert.deepEqual(c.notes, []);
});
