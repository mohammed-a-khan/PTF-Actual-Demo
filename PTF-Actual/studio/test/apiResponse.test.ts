/**
 * The response viewer's data: TLS details (version, cipher, the certificate chain, trusted or not), binary bodies
 * kept as bytes (images, PDF), the connection's address and timings; and History keeping the whole exchange (the
 * request as defined, what was sent, the response), so it can be looked at and restored.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { send } from '../src/api/send';
import { createServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';
import { newCollection, newRequest } from '../src/api/model';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('TLS: version, cipher and the certificate chain; trusted with the CA, not trusted without', async (t) => {
    try { execFileSync('openssl', ['version']); } catch { t.skip('openssl is not installed'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tls-'));
    try {
        const o = (...a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
        o('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Lab Root CA/O=Lab');
        o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 's.key', '-out', 's.csr', '-subj', '/CN=localhost');
        fs.writeFileSync(path.join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
        o('x509', '-req', '-in', 's.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 's.pem', '-days', '2', '-extfile', 'san.ext');
        const read = (f: string) => fs.readFileSync(path.join(dir, f));
        const s = https.createServer({ key: read('s.key'), cert: Buffer.concat([read('s.pem'), read('ca.pem')]) }, (q, r) => {
            if (q.url === '/logo.png') { r.writeHead(200, { 'Content-Type': 'image/png' }); r.end(PNG); return; }
            r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<h1>Hi</h1>');
        });
        const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
        try {
            const conn = { ca: [read('ca.pem').toString()], agentFor: () => undefined } as never;
            const r = await send({ method: 'GET', url: `https://localhost:${port}/logo.png`, headers: {}, missing: [] }, conn, 5000);
            assert.equal(r.status, 200);
            assert.equal(r.bodyBase64, PNG.toString('base64'), 'the image bytes, unchanged');
            assert.match(r.remote!, /^(127\.0\.0\.1|::1):\d+$/);
            assert.match(r.tls!.protocol, /^TLSv1\.[23]$/);
            assert.ok(r.tls!.cipher);
            assert.equal(r.tls!.authorized, true);
            assert.deepEqual(r.tls!.chain.map((c) => c.subject), ['CN=localhost', 'CN=Lab Root CA, O=Lab']);
            assert.match(r.tls!.chain[0].altNames!, /DNS:localhost/);
            assert.ok(r.timings!.tls > 0 && r.timings!.connect >= 0, JSON.stringify(r.timings));
            const html = await send({ method: 'GET', url: `https://localhost:${port}/`, headers: {}, missing: [] }, conn, 5000);
            assert.equal(html.bodyBase64, undefined, 'text bodies stay text');
            assert.equal(html.body, '<h1>Hi</h1>');
            // Without the CA: refused, with the reason.
            await assert.rejects(send({ method: 'GET', url: `https://localhost:${port}/`, headers: {}, missing: [] }, undefined, 5000), /not trusted \(certificate\)/);
        } finally { s.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('History keeps the whole exchange: the request as defined, what was sent, the response (masked), the checks', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-hist-'));
    const app = http.createServer((q, r) => { r.writeHead(201, { 'Content-Type': 'application/json', 'X-Trace': 't-1' }); r.end(JSON.stringify({ id: 9, echo: q.headers['x-key'] })); });
    const port = await new Promise<number>((res) => app.listen(0, '127.0.0.1', () => res((app.address() as { port: number }).port)));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'config', 'shop', 'common'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'config', 'shop', 'environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'shop', 'common', 'common.env'), 'PROJECT_NAME=shop\n');
    fs.writeFileSync(path.join(dir, 'config', 'shop', 'environments', 'dev.env'), 'ENVIRONMENT=dev\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T' });
    try {
        const c = { ...newCollection('Shop'), baseUrl: `http://127.0.0.1:${port}`, variables: [{ key: 'apiKey', value: 'k-123456789' }] };
        const r = { ...newRequest('Create'), id: 'r1', method: 'POST' as const, url: '/orders', headers: [{ key: 'X-Key', value: '{{apiKey}}' }], body: { mode: 'json' as const, text: '{"item":"book"}' }, checks: [{ kind: 'status' as const, value: '201' }] };
        const auth = { authorization: `Bearer ${srv.token}` };
        const sent = await srv.app.inject({ method: 'POST', url: '/api/apiws/send', headers: auth, payload: { project: 'shop', env: 'dev', file: 'test/shop/api/shop.json', collection: { ...c, items: [r] }, request: r } });
        assert.equal(sent.statusCode, 200, sent.body);
        const res = sent.json().response;
        assert.equal(res.status, 201);
        assert.ok(res.timings, 'timings for the Timing tab');
        assert.match(res.remote, /127\.0\.0\.1:\d+/);
        const list = (await srv.app.inject({ method: 'GET', url: '/api/apiws/history', headers: auth })).json().items;
        assert.equal(list.length, 1);
        assert.ok(/^[a-z0-9]{6,40}$/.test(list[0].id));
        const d = (await srv.app.inject({ method: 'GET', url: `/api/apiws/history/${list[0].id}`, headers: auth })).json();
        assert.deepEqual(d.def, r, 'the request as defined (to restore)');
        assert.equal(d.sent.headers['X-Key'], 'k-123456789');
        assert.equal(d.sent.body, '{"item":"book"}');
        assert.equal(d.response.status, 201);
        assert.equal(d.response.headers['x-trace'], 't-1');
        assert.deepEqual(JSON.parse(d.response.body), { id: 9, echo: 'k-123456789' });
        assert.deepEqual(d.checks.map((x: { pass: boolean }) => x.pass), [true]);
        assert.equal((await srv.app.inject({ method: 'GET', url: '/api/apiws/history/..%2f..%2fx', headers: auth })).statusCode, 400);
        assert.equal((await srv.app.inject({ method: 'DELETE', url: '/api/apiws/history?confirm=true', headers: auth })).statusCode, 200);
        assert.equal((await srv.app.inject({ method: 'GET', url: `/api/apiws/history/${list[0].id}`, headers: auth })).statusCode, 400);
    } finally { await srv.app.close(); app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
