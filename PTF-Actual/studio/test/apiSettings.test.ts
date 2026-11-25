/** Per-request settings: retries on 5xx / 429 / connection errors, redirects not followed, a timeout, an untrusted certificate accepted only when asked; Postman's settings carried over. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { sendWith } from '../src/api/send';
import { exportReport } from '../src/api/collectionExport';
import { importCollection } from '../src/api/collectionImport';
import { allRequests, newCollection, newRequest } from '../src/api/model';

test('retries, redirects, timeout', async () => {
    let calls = 0;
    const s = http.createServer((q, r) => {
        if (q.url === '/flaky') { calls++; r.writeHead(calls < 3 ? (calls === 1 ? 503 : 429) : 200); r.end(String(calls)); return; }
        if (q.url === '/moved') { r.writeHead(302, { Location: '/flaky' }); r.end(); return; }
        if (q.url === '/slow') { setTimeout(() => { r.writeHead(200); r.end('late'); }, 800); return; }
        r.writeHead(404); r.end();
    });
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    const p = (u: string) => ({ method: 'GET', url: `http://127.0.0.1:${port}${u}`, headers: {}, missing: [] });
    try {
        let r = await sendWith(p('/flaky'), { retries: 3, retryDelayMs: 10 });
        assert.deepEqual([r.status, calls], [200, 3]);
        calls = 0;
        r = await sendWith(p('/flaky'), { retries: 1, retryDelayMs: 10 });
        assert.deepEqual([r.status, calls], [429, 2], 'the last answer when retries run out');
        r = await sendWith(p('/moved'), { followRedirects: false });
        assert.deepEqual([r.status, r.headers.location], [302, '/flaky']);
        await assert.rejects(sendWith(p('/slow'), { timeoutMs: 200 }), /No answer within/);
        // A connection error retried: the port closes, then nothing answers.
        await assert.rejects(sendWith({ ...p('/x'), url: 'http://127.0.0.1:1/x' }, { retries: 2, retryDelayMs: 10 }), /refused/);
    } finally { s.close(); }
});

test('an untrusted certificate: refused, accepted when the request says so', async (t) => {
    try { execFileSync('openssl', ['version']); } catch { t.skip('openssl is not installed'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ins-'));
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '1', '-subj', '/CN=localhost'], { cwd: dir, stdio: 'pipe' });
        const s = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (_q, r) => r.end('ok'));
        const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
        try {
            const p = { method: 'GET', url: `https://localhost:${port}/`, headers: {}, missing: [] };
            await assert.rejects(sendWith(p, undefined), /not trusted/);
            assert.equal((await sendWith(p, { insecure: true })).body, 'ok');
            await assert.rejects(sendWith(p, undefined), /not trusted/, 'only that request: the next one checks again');
        } finally { s.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Postman: follow redirects off and SSL verification off carried both ways', () => {
    const c = { ...newCollection('S'), baseUrl: 'https://x.test', items: [{ ...newRequest('A'), id: 'a', url: '/a', settings: { followRedirects: false, insecure: true } }] };
    const pm = exportReport(c, {}).collection as { item: Array<{ protocolProfileBehavior?: unknown }> };
    assert.deepEqual(pm.item[0].protocolProfileBehavior, { followRedirects: false, strictSSL: false });
    assert.deepEqual(allRequests(importCollection(pm).collection.items)[0].request.settings, { followRedirects: false, insecure: true });
});
