import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { ApiCollection, ApiRequest, newCollection, newRequest } from '../src/api/model';
import { authorize, prepare, TokenCache, Values } from '../src/api/send';
import { toFeature } from '../src/api/feature';
import { importOpenApi } from '../src/api/openapi';
import { exportCollection } from '../src/api/collectionExport';
import { importCollection } from '../src/api/collectionImport';
import { CollectionRunner, RunnerJob, runnerReport } from '../src/api/runner';

const V = (vars: Record<string, string> = {}, config: Record<string, string> = {}, env: Record<string, string> = {}): Values => ({ vars, config, env });
const flat = (c: ApiCollection): ApiRequest[] => { const o: ApiRequest[] = []; const w = (xs: ApiCollection['items']) => { for (const x of xs) x.kind === 'folder' ? w(x.items) : o.push(x); }; w(c.items); return o; };

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
    return new Promise((res) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() })); });
}
const bodyOf = (req: http.IncomingMessage) => new Promise<string>((res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => res(b)); });

test('OAuth2: the token request is a form POST, the token is used as Bearer and reused (cached)', async () => {
    let tokenCalls = 0; let form = '';
    const s = await server(async (req, res) => { form = await bodyOf(req); tokenCalls++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ access_token: 'tk-1', expires_in: 3600 })); });
    try {
        const c = { auth: { type: 'oauth2' as const, grant: 'password' as const, tokenUrl: `${s.url}/token`, clientId: 'cid', clientSecret: '{env:SEC}', scope: 'read', username: '{{u}}', password: 'p&w' } };
        const r = newRequest('x');
        const cache: TokenCache = new Map();
        const p0 = prepare({ baseUrl: 'http://h', auth: c.auth }, r, V({ u: 'ann' }, {}, { SEC: 's3' }));
        const p1 = await authorize(c, r, V({ u: 'ann' }, {}, { SEC: 's3' }), p0, undefined, cache);
        assert.equal(p1.headers.Authorization, 'Bearer tk-1');
        assert.deepEqual(Object.fromEntries(new URLSearchParams(form)), { grant_type: 'password', client_id: 'cid', client_secret: 's3', scope: 'read', username: 'ann', password: 'p&w' });
        await authorize(c, r, V({ u: 'ann' }, {}, { SEC: 's3' }), p0, undefined, cache);
        assert.equal(tokenCalls, 1);
        const miss = await authorize(c, r, V({}, {}, { SEC: 's3' }), p0, undefined, new Map());
        assert.ok(miss.missing.includes('{{u}}') && tokenCalls === 1, 'a missing value stops the token request');
    } finally { s.close(); }
    const bad = await server((_q, res) => { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"invalid_client"}'); });
    try {
        const c = { auth: { type: 'oauth2' as const, tokenUrl: `${bad.url}/t`, clientId: 'a', clientSecret: 'b' } };
        await assert.rejects(authorize(c, newRequest('x'), V(), { method: 'GET', url: 'http://h', headers: {}, missing: [] }, undefined, new Map()), /HTTP 401 invalid_client/);
    } finally { bad.close(); }
});

test('multipart: text fields and files with names, file types and one boundary; a missing file is reported', () => {
    const r: ApiRequest = { ...newRequest('up'), method: 'POST', headers: [{ key: 'content-type', value: 'application/json' }], body: { mode: 'multipart', parts: [{ key: 'title', value: '{{t}}' }, { key: 'doc', value: 'data/a.txt', type: 'file' }, { key: 'off', value: 'x', enabled: false }] } };
    const p = prepare({ baseUrl: 'http://h', auth: { type: 'none' } }, r, V({ t: 'Hi' }), { readFile: (rel) => { assert.equal(rel, 'data/a.txt'); return Buffer.from('FILE'); } });
    const ct = p.headers['Content-Type']; const boundary = ct.split('boundary=')[1];
    assert.ok(ct.startsWith('multipart/form-data; boundary=') && !('content-type' in p.headers));
    const b = (p.body as Buffer).toString();
    assert.ok(b.includes(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHi\r\n`));
    assert.ok(b.includes('name="doc"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nFILE\r\n'));
    assert.ok(b.endsWith(`--${boundary}--\r\n`) && !b.includes('name="off"'));
    const m = prepare({ baseUrl: 'http://h', auth: { type: 'none' } }, r, V({ t: 'Hi' }), { readFile: () => { throw new Error('ENOENT'); } });
    assert.deepEqual(m.missing, ['the file data/a.txt (not found in the project)']);
});

test('feature: OAuth2 as the framework\'s data-table step, multipart steps with a warning', () => {
    const c = newCollection('Svc');
    c.auth = { type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://id/token', clientId: 'cid', clientSecret: '{env:SEC}', scope: 'a|b' };
    c.items.push({ ...newRequest('Upload'), method: 'POST', url: 'https://x/up', body: { mode: 'multipart', parts: [{ key: 'f', value: 'data/a.txt', type: 'file' }, { key: 'n', value: '1' }] } });
    const f = toFeature(c);
    assert.match(f.text, /I use OAuth2 with client credentials:/);
    assert.match(f.text, /\| clientSecret \| \{env:SEC\} \|/);
    assert.match(f.text, /\| scope \| a\\\|b \|/);
    assert.match(f.text, /user adds file "data\/a.txt" as "f" to multipart/);
    assert.match(f.text, /user sets multipart field "n" to "1"/);
    assert.ok(f.warnings.some((w) => /multipart/.test(w)));
});

test('OpenAPI 3 (YAML): folders by tag, path params as variables, body sample, auth, status check', () => {
    const spec = `openapi: 3.0.0
info: { title: Pets }
servers: [{ url: https://pets.test/v1 }]
components:
  securitySchemes: { bearerAuth: { type: http, scheme: bearer } }
  schemas:
    Pet: { type: object, required: [name], properties: { name: { type: string, example: Rex }, age: { type: integer } } }
security: [{ bearerAuth: [] }]
paths:
  /pets/{petId}:
    get:
      tags: [pets]
      summary: Get a pet
      parameters: [{ name: petId, in: path, required: true, schema: { type: string } }, { name: verbose, in: query, schema: { type: boolean } }]
      responses: { '200': { description: ok } }
  /pets:
    post:
      tags: [admin]
      operationId: addPet
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } }
      responses: { '201': { description: made } }
`;
    const { collection: c, report } = importOpenApi(spec);
    assert.equal(c.name, 'Pets'); assert.equal(report.operations, 2);
    assert.match(c.baseUrl, /pets\.test\/v1/);
    assert.equal(c.auth.type, 'bearer');
    const reqs = flat(c);
    const get = reqs.find((r) => r.method === 'GET')!; const post = reqs.find((r) => r.method === 'POST')!;
    assert.deepEqual(c.items.map((x) => `${x.kind}:${x.name}`).sort(), ['folder:admin', 'folder:pets']);
    assert.match(get.url, /\/pets\/\{\{petId\}\}/);
    assert.ok(get.query.some((q) => q.key === 'verbose' && q.enabled === false));
    assert.ok(get.checks.some((k) => k.kind === 'status' && k.value === '200'));
    assert.equal(post.body.mode, 'json'); assert.equal(JSON.parse(post.body.text!).name, 'Rex');
    assert.ok(post.checks.some((k) => k.kind === 'status' && k.value === '201'));
});

test('Swagger 2.0 (JSON) imports; something else is refused with a clear message', () => {
    const spec = JSON.stringify({ swagger: '2.0', info: { title: 'Old' }, host: 'old.test', basePath: '/api', schemes: ['https'], paths: { '/items': { get: { responses: { 200: { description: 'ok' } } } } } });
    const { collection } = importOpenApi(spec);
    assert.equal(collection.baseUrl, 'https://old.test/api');
    assert.equal(flat(collection).length, 1);
    assert.throws(() => importOpenApi('{"hello": 1}'), /not an OpenAPI/);
    assert.throws(() => importOpenApi('a: [b'), /not valid JSON or YAML/);
});

test('export → import keeps requests, folders, auth, bodies, checks and saved values', () => {
    const c = newCollection('Round');
    c.baseUrl = 'https://r.test'; c.auth = { type: 'bearer', token: '{{tok}}' };
    const login: ApiRequest = { ...newRequest('Login'), method: 'POST', url: '/login', body: { mode: 'json', text: '{"u":"a"}' }, checks: [{ kind: 'status', value: '200' }, { kind: 'jsonEquals', target: '$.ok', value: 'true' }, { kind: 'jsonEquals', target: '$.a-b[0].c', value: 'x "q"' }, { kind: 'statusBetween', min: 200, max: 204 }, { kind: 'jsonExists', target: '$.id' }, { kind: 'jsonNotContains', target: '$.list', value: 'bad' }, { kind: 'bodyContains', value: 'ok' }, { kind: 'bodyNotContains', value: 'err' }, { kind: 'bodyEmpty' }, { kind: 'headerExists', target: 'X-Id' }, { kind: 'headerEquals', target: 'X-A', value: '1' }, { kind: 'headerContains', target: 'Content-Type', value: 'json' }, { kind: 'timeBelow', value: '900' }], extract: [{ from: 'json', variable: 'tok', path: '$.token' }] };
    c.items.push({ kind: 'folder', id: 'f1', name: 'Auth', items: [login] } as never);
    c.items.push({ ...newRequest('Form'), method: 'POST', url: '/f', body: { mode: 'form', form: [{ key: 'a', value: '1' }] } });
    const out = exportCollection(c);
    const back = importCollection(JSON.parse(JSON.stringify(out))).collection;
    assert.equal(back.name, 'Round');
    assert.equal(back.auth.type, 'bearer');
    const reqs = flat(back);
    assert.deepEqual(reqs.map((r) => r.name), ['Login', 'Form']);
    const l = reqs[0];
    assert.equal(l.body.mode, 'json'); assert.equal(l.body.text, '{"u":"a"}');
    assert.deepEqual(l.checks, login.checks, 'every check kind survives export and import');
    assert.deepEqual(l.notes ?? [], []);
    assert.ok(l.extract.some((x) => x.variable === 'tok' && x.path === '$.token'));
    assert.equal(reqs[1].body.mode, 'form');
});

test('collection runner: data rows, values saved between requests, checks, stop on failure, report escaped', async () => {
    const s = await server(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/login') { const b = JSON.parse(await bodyOf(req)); res.end(JSON.stringify({ token: `t-${b.user}` })); }
        else if (req.url === '/me') res.end(JSON.stringify({ auth: req.headers.authorization }));
        else { res.statusCode = 500; res.end('{}'); }
    });
    const wait = async (r: CollectionRunner, id: string): Promise<RunnerJob> => { for (let i = 0; i < 200; i++) { const j = r.get(id)!; if (j.state !== 'running') return j; await new Promise((x) => setTimeout(x, 20)); } throw new Error('timeout'); };
    try {
        const login: ApiRequest = { ...newRequest('Login <1>'), method: 'POST', url: '/login', body: { mode: 'json', text: '{"user":"{{user}}"}' }, extract: [{ from: 'json', variable: 'tok', path: '$.token' }], checks: [] };
        const me: ApiRequest = { ...newRequest('Me'), url: '/me', headers: [{ key: 'Authorization', value: '{{tok}}' }], checks: [{ kind: 'jsonEquals', target: '$.auth', value: 't-{{user}}' }] };
        const boom: ApiRequest = { ...newRequest('Boom'), url: '/boom', checks: [] };
        const base = { collection: { name: 'C & <D>', baseUrl: s.url, auth: { type: 'none' as const } }, file: 'test/p/api/c.collection.json', project: 'p', env: 'dev', values: V(), iterations: 1, delayMs: 0, timeoutMs: 5000, mask: (t: string) => t };
        const r = new CollectionRunner();
        const j = await wait(r, r.start({ ...base, requests: [login, me], rows: [{ user: 'ann' }, { user: 'bob' }], stopOnFailure: false }).id);
        assert.equal(j.state, 'finished'); assert.equal(j.iterations, 2);
        assert.deepEqual(j.summary, { ...j.summary, requests: 4, passed: 4, failed: 0, checks: 2, checksPassed: 2 });
        const j2 = await wait(r, r.start({ ...base, requests: [boom, login], rows: [], iterations: 3, stopOnFailure: true }).id);
        assert.equal(j2.state, 'stopped'); assert.equal(j2.steps.length, 1); assert.equal(j2.steps[0].error, 'HTTP 500');
        assert.equal(r.list()[0].id, j2.id);
        const html = runnerReport(j);
        assert.ok(html.includes('C &amp; &lt;D&gt;') && html.includes('Login &lt;1&gt;') && !html.includes('<D>') && !/<script/i.test(html));
    } finally { s.close(); }
});

test('OpenAPI contract: the success response\'s schema as a schema check (references inlined, nullable, a type that contains itself)', async () => {
    const { importOpenApi } = await import('../src/api/openapi');
    const { evaluateExtra } = await import('../src/api/checks');
    const spec = JSON.stringify({
        openapi: '3.0.3', info: { title: 'Shop' }, servers: [{ url: 'https://shop.example/api' }],
        paths: {
            '/orders/{id}': { get: { summary: 'Get an order', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
                responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } }, 404: { description: 'none' } } } },
            '/ping': { get: { responses: { 204: { description: 'no content' } } } },
        },
        components: { schemas: {
            Order: { type: 'object', required: ['id', 'total', 'status'], properties: { id: { type: 'integer' }, total: { type: 'number', example: 9.5 }, status: { type: 'string', enum: ['open', 'paid'] },
                note: { type: 'string', nullable: true }, lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } }, parent: { $ref: '#/components/schemas/Order' } } },
            Line: { type: 'object', required: ['sku'], properties: { sku: { type: 'string', pattern: '^SKU-' }, qty: { type: 'integer', minimum: 1 } } },
        } },
    });
    const { collection, report } = importOpenApi(spec);
    assert.equal(report.contracts, 1, 'a contract for the operation with a JSON success body only');
    const reqs = collection.items as Array<{ name: string; checks: Array<{ kind: string; schema?: string }> }>;
    const get = reqs.find((r) => r.name === 'Get an order')!;
    const ch = get.checks.find((c) => c.kind === 'schema')!;
    const s = JSON.parse(ch.schema!);
    assert.equal(s.properties.lines.items.properties.sku.pattern, '^SKU-', 'references inlined');
    assert.deepEqual(s.properties.note.type, ['string', 'null'], 'nullable');
    assert.deepEqual(s.properties.parent, {}, 'a type that contains itself is left open');
    assert.equal(s.properties.total.example, undefined, 'only keywords that check data');
    assert.ok(!reqs.find((r) => r.name === 'GET /ping')!.checks.some((c) => c.kind === 'schema'), 'no body: no contract');
    const res = (body: unknown) => ({ status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeMs: 1, size: 1 }) as never;
    const good = await evaluateExtra(ch as never, res({ id: 7, total: 9.5, status: 'paid', note: null, lines: [{ sku: 'SKU-1', qty: 2 }], parent: { anything: true } }), { vars: {} } as never);
    assert.equal(good?.pass, true, good?.message);
    const bad = await evaluateExtra(ch as never, res({ id: '7', total: 9.5, status: 'shipped', lines: [{ sku: 'X-1' }] }), { vars: {} } as never);
    assert.equal(bad?.pass, false);
    assert.match(bad!.message, /id|status|sku/);
});

test('Swagger 2.0 contract: the response schema of the success code', async () => {
    const { importOpenApi } = await import('../src/api/openapi');
    const spec = JSON.stringify({ swagger: '2.0', info: { title: 'Old' }, host: 'old.example', basePath: '/v1', paths: { '/items': { get: { responses: { 200: { description: 'ok', schema: { type: 'array', items: { $ref: '#/definitions/Item' } } } } } } },
        definitions: { Item: { type: 'object', required: ['name'], properties: { name: { type: 'string', 'x-nullable': true } } } } });
    const { collection } = importOpenApi(spec);
    const ch = (collection.items as Array<{ checks: Array<{ kind: string; schema?: string }> }>)[0].checks.find((c) => c.kind === 'schema')!;
    const s = JSON.parse(ch.schema!);
    assert.equal(s.type, 'array');
    assert.deepEqual(s.items.properties.name.type, ['string', 'null']);
});
