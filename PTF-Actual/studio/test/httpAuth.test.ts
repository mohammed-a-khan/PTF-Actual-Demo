import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as http from 'http';
import { md4, ntowfv2, ntlmv2Responses, digestAuthorization } from '../src/api/httpAuth';
import { prepare, send } from '../src/api/send';
import { newRequest, ApiAuth } from '../src/api/model';
import { LoadEngine } from '../src/load/engine';
import { newScenario } from '../src/load/scenario';
import { toFeature } from '../src/api/feature';

test('NTLMv2, MD4 and Digest against the specifications\' examples', () => {
    assert.equal(md4(Buffer.from('')).toString('hex'), '31d6cfe0d16ae931b73c59d7e0c089c0');
    assert.equal(md4(Buffer.from('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toString('hex'), 'e33b4ddc9c38f2199c3e7b164fcc0536');
    assert.equal(ntowfv2('User', 'Password', 'Domain').toString('hex'), '0c868a403bfd7a93a3001ef22ef02e3f');
    const r = ntlmv2Responses({ user: 'User', password: 'Password', domain: 'Domain', serverChallenge: Buffer.from('0123456789abcdef', 'hex'), targetInfo: Buffer.from('02000c0044006f006d00610069006e0001000c0053006500720076006500720000000000', 'hex'), clientChallenge: Buffer.from('aaaaaaaaaaaaaaaa', 'hex'), time: Buffer.alloc(8) });
    assert.equal(r.proof.toString('hex'), '68cd0ab851e51c96aabc927bebef6a1c');
    const sha = digestAuthorization({ realm: 'http-auth@example.org', nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v', qop: 'auth', opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS', algorithm: 'SHA-256' }, { username: 'Mufasa', password: 'Circle of Life', method: 'GET', uri: '/dir/index.html', nc: 1, cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ' });
    assert.match(sha, /response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"/);
});

/** A server like IIS: NTLM per connection (proof checked with the password), Digest MD5 / SHA-256. */
function windowsLikeServer() {
    const USER = 'tester', PASS = 'S3cret!';
    const conn = new WeakMap<object, { challenge: Buffer; ok?: boolean }>();
    const s = http.createServer((req, res) => {
        const a = req.headers.authorization ?? '';
        const deny = (h: Record<string, string>) => { res.writeHead(401, h); res.end('denied'); };
        if (req.url!.startsWith('/ntlm')) {
            const m = /^NTLM (.+)$/.exec(a);
            if (!m) return deny({ 'WWW-Authenticate': 'NTLM' });
            const msg = Buffer.from(m[1], 'base64');
            if (msg.readUInt32LE(8) === 1) {
                const challenge = crypto.randomBytes(8);
                const ti = Buffer.concat([Buffer.from([2, 0, 6, 0]), Buffer.from('LAB', 'utf16le'), Buffer.alloc(4)]);
                const t2 = Buffer.alloc(48);
                Buffer.from('NTLMSSP\0').copy(t2); t2.writeUInt32LE(2, 8);
                t2.writeUInt16LE(6, 12); t2.writeUInt16LE(6, 14); t2.writeUInt32LE(48, 16);
                t2.writeUInt32LE(0x00888201, 20); challenge.copy(t2, 24);
                t2.writeUInt16LE(ti.length, 40); t2.writeUInt16LE(ti.length, 42); t2.writeUInt32LE(54, 44);
                conn.set(req.socket, { challenge });
                return deny({ 'WWW-Authenticate': `NTLM ${Buffer.concat([t2, Buffer.from('LAB', 'utf16le'), ti]).toString('base64')}` });
            }
            const st = conn.get(req.socket);
            if (!st) return deny({ 'WWW-Authenticate': 'NTLM' });
            const field = (at: number) => msg.subarray(msg.readUInt32LE(at + 4), msg.readUInt32LE(at + 4) + msg.readUInt16LE(at));
            const nt = field(20), dom = field(28).toString('utf16le'), user = field(36).toString('utf16le');
            const proof = crypto.createHmac('md5', ntowfv2(user, PASS, dom)).update(Buffer.concat([st.challenge, nt.subarray(16)])).digest();
            if (user !== USER || !proof.equals(nt.subarray(0, 16))) return deny({ 'WWW-Authenticate': 'NTLM' });
            if (req.url === '/ntlm/redirect') { res.writeHead(302, { Location: '/ntlm/target' }); res.end(); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ user: `${dom}\\${user}`, path: req.url }));
            return;
        }
        if (req.url!.startsWith('/digest')) {
            const algorithm = req.url!.includes('sha') ? 'SHA-256' : 'MD5';
            const nonce = `n-${algorithm}`;
            const m = /^Digest (.+)$/.exec(a);
            if (!m) return deny({ 'WWW-Authenticate': `Digest realm="lab", qop="auth", nonce="${nonce}", algorithm=${algorithm}` });
            const p = Object.fromEntries([...m[1].matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((x) => [x[1], x[2] ?? x[3]]));
            const H = (t: string) => crypto.createHash(algorithm === 'MD5' ? 'md5' : 'sha256').update(t).digest('hex');
            const want = H(`${H(`${USER}:lab:${PASS}`)}:${nonce}:${p.nc}:${p.cnonce}:auth:${H(`${req.method}:${req.url}`)}`);
            if (p.response !== want) return deny({ 'WWW-Authenticate': `Digest realm="lab", qop="auth", nonce="${nonce}", algorithm=${algorithm}` });
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ user: p.username, algorithm }));
            return;
        }
        res.writeHead(404); res.end();
    });
    return { s, listen: () => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port))) };
}

test('NTLM and Digest in Send, a redirect, a load test; the feature uses the framework\'s steps', async () => {
    const { s, listen } = windowsLikeServer();
    const port = await listen();
    const coll = { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' as const } };
    const v = { vars: {}, config: {}, env: { WIN_PASS: 'S3cret!' } };
    const req = (url: string, auth: ApiAuth) => ({ ...newRequest('r', 'r'), url, auth });
    try {
        const ntlm: ApiAuth = { type: 'ntlm', domain: 'LAB', username: 'tester', password: '{env:WIN_PASS}' };
        let r = await send(prepare(coll, req('/ntlm/data', ntlm), v), undefined, 5000);
        assert.deepEqual([r.status, JSON.parse(r.body).user], [200, 'LAB\\tester']);
        r = await send(prepare(coll, req('/ntlm/data', { ...ntlm, domain: '', username: 'LAB\\tester' }), v), undefined, 5000);
        assert.equal(r.status, 200, 'DOMAIN\\user');
        r = await send(prepare(coll, req('/ntlm/redirect', ntlm), v), undefined, 5000);
        assert.deepEqual([r.status, JSON.parse(r.body).path, r.redirects.length], [200, '/ntlm/target', 1], 'a redirect is authenticated again');
        r = await send(prepare(coll, req('/ntlm/data', { ...ntlm, password: 'wrong' }), v), undefined, 5000);
        assert.equal(r.status, 401);
        for (const path of ['/digest/md5', '/digest/sha?q=1']) {
            r = await send(prepare(coll, req(path, { type: 'digest', username: 'tester', password: '{env:WIN_PASS}' }), v), undefined, 5000);
            assert.equal(r.status, 200, path);
        }
        assert.equal((await send(prepare(coll, req('/digest/md5', { type: 'digest', username: 'tester', password: 'no' }), v), undefined, 5000)).status, 401);
        // Under load: every user's every request completes the handshake.
        const lr = await new LoadEngine({ scenario: { ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], policy: { type: 'constant', users: 3, duration: 1 } },
            collection: coll, requests: [{ ...req('/ntlm/data', ntlm), id: 'n' }, { ...req('/digest/sha', { type: 'digest', username: 'tester', password: '{env:WIN_PASS}' }), id: 'd' }], values: v, rows: [] }).run();
        assert.ok(lr.total.count > 10);
        assert.equal(lr.total.errors, 0);
        // The generated feature uses the framework's NTLM / Digest steps.
        const f = toFeature({ format: 'cs-studio-api/1', name: 'win', baseUrl: coll.baseUrl, variables: [], auth: { type: 'none' }, items: [req('/ntlm/data', ntlm), { ...req('/digest/md5', { type: 'digest', username: 'tester', password: '{env:WIN_PASS}' }), id: 'r2' }] } as never, {} as never);
        const text = typeof f === 'string' ? f : (f as { feature?: string; text?: string }).feature ?? (f as { text?: string }).text ?? JSON.stringify(f);
        assert.match(text, /I use NTLM authentication with domain "LAB" username "tester" and password "\{env:WIN_PASS\}"/);
        assert.match(text, /I use digest authentication with username "tester" and password "\{env:WIN_PASS\}"/);
    } finally { s.close(); }
});
