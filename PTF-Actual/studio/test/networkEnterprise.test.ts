import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { connection, DEFAULT_NETWORK, NetworkSettings } from '../src/core/network';
import { pacEvaluator, parsePacResult, parseWindowsOverride, parseWindowsProxyServer, readSystemProxy } from '../src/core/systemProxy';
import { ProxyTunnelAgent, ProxyTunnelHttpAgent } from '../src/core/proxyTunnel';
import { send } from '../src/api/send';
import { wsExchange } from '../src/api/ws';

const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

/** A CONNECT proxy that records which hosts it was asked for. */
function connectProxy() {
    const seen: string[] = [];
    const s = http.createServer((_q, r) => { r.writeHead(405); r.end(); });
    s.on('connect', (req, sock, head) => {
        seen.push(String(req.url));
        const [h, p] = String(req.url).split(':');
        const up = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 Connection established\r\n\r\n'); if (head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
        up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
    });
    return { s, seen };
}

test('client certificates (mutual TLS) per host: the server that requires one accepts the Studio, other hosts get none', async (t) => {
    let dir: string;
    try { execFileSync('openssl', ['version']); } catch { t.skip('openssl is not installed'); return; }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mtls-'));
    try {
        const o = (...a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
        o('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test CA');
        o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
        fs.writeFileSync(path.join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
        o('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'san.ext');
        o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=qa-tester');
        o('x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem', '-days', '2');
        o('pkcs12', '-export', '-out', 'client.pfx', '-inkey', 'client.key', '-in', 'client.pem', '-passout', 'pass:pfx-pass-1');
        const read = (f: string) => fs.readFileSync(path.join(dir, f));
        const s = https.createServer({ key: read('server.key'), cert: read('server.pem'), ca: read('ca.pem'), requestCert: true, rejectUnauthorized: true }, (q, r) => {
            const peer = (q.socket as import('tls').TLSSocket).getPeerCertificate();
            r.end(JSON.stringify({ client: peer?.subject?.CN ?? null }));
        });
        const port = await listen(s);
        try {
            const base: NetworkSettings = { ...DEFAULT_NETWORK, caFile: path.join(dir, 'ca.pem') };
            const url = `https://localhost:${port}/who`;
            // PEM certificate and key.
            const pem = connection({ ...base, clientCerts: [{ host: 'localhost', certFile: path.join(dir, 'client.pem'), keyFile: path.join(dir, 'client.key') }] }, {});
            assert.deepEqual(JSON.parse((await send({ method: 'GET', url, headers: {}, missing: [] }, pem)).body), { client: 'qa-tester' });
            // A .pfx with its passphrase from a Studio secret.
            const pfx = connection({ ...base, clientCerts: [{ host: '.localhost', pfxFile: path.join(dir, 'client.pfx'), passphraseSecret: 'CLIENT_PFX_PASS' }] }, {}, undefined, { secret: (n) => (n === 'CLIENT_PFX_PASS' ? 'pfx-pass-1' : undefined) });
            assert.deepEqual(JSON.parse((await send({ method: 'GET', url, headers: {}, missing: [] }, pfx)).body), { client: 'qa-tester' });
            // Another host's certificate: none presented, the server refuses the connection.
            const other = connection({ ...base, clientCerts: [{ host: 'api.other.test', certFile: path.join(dir, 'client.pem'), keyFile: path.join(dir, 'client.key') }] }, {});
            await assert.rejects(send({ method: 'GET', url, headers: {}, missing: [] }, other, 5000));
        } finally { s.close(); }
    } finally { fs.rmSync(dir!, { recursive: true, force: true }); }
});

test('PAC files: the standard helpers, the proxy chosen per address, DIRECT; requests and WebSockets go through that proxy', async () => {
    const pac = `function FindProxyForURL(url, host) {
        if (isPlainHostName(host) || dnsDomainIs(host, ".corp.local")) return "DIRECT";
        if (shExpMatch(host, "*.socks.test")) return "SOCKS5 127.0.0.1:1080";
        if (isInNet(host, "10.0.0.0", "255.0.0.0")) return "DIRECT";
        return "PROXY PROXYPORT; DIRECT";
    }`;
    const p = connectProxy();
    const pport = await listen(p.s);
    const app = http.createServer((_q, r) => r.end('ok'));
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ server: app });
    wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
    const aport = await listen(app);
    try {
        const ev = pacEvaluator(pac.replace('PROXYPORT', `127.0.0.1:${pport}`));
        assert.deepEqual(ev('http://intranet/x'), ['DIRECT']);
        assert.deepEqual(ev('https://app.corp.local/x'), ['DIRECT']);
        assert.deepEqual(ev('https://a.socks.test/x'), ['socks5://127.0.0.1:1080']);
        assert.deepEqual(ev('http://10.1.2.3/x'), ['DIRECT']);
        assert.deepEqual(ev('https://api.example.test/x'), [`http://127.0.0.1:${pport}`, 'DIRECT']);
        assert.deepEqual(parsePacResult('PROXY a:1; HTTPS b:2;SOCKS c:3; DIRECT'), ['http://a:1', 'https://b:2', 'socks4://c:3', 'DIRECT']);
        assert.throws(() => pacEvaluator('var x = 1;'), /no FindProxyForURL/);
        assert.throws(() => pacEvaluator('function FindProxyForURL(){ while(true){} } FindProxyForURL()'), /timed out/i);
        // A PAC that sends 127.0.0.1 through the proxy (no bypass): the request goes through it.
        const n: NetworkSettings = { ...DEFAULT_NETWORK, bypass: [], proxyMode: 'pac', pacUrl: 'http://wpad/proxy.pac' };
        const conn = connection(n, {}, undefined, { pacScript: `function FindProxyForURL(u, h) { return "PROXY 127.0.0.1:${pport}"; }` });
        assert.equal(conn.proxyLabel(`http://127.0.0.1:${aport}/`), `http://127.0.0.1:${pport} (PAC)`);
        assert.equal((await send({ method: 'GET', url: `http://127.0.0.1:${aport}/`, headers: {}, missing: [] }, conn)).body, 'ok');
        assert.deepEqual(p.seen, [`127.0.0.1:${aport}`]);
        // A new connection (the HTTP request's tunnel would be reused otherwise).
        const conn2 = connection(n, {}, undefined, { pacScript: `function FindProxyForURL(u, h) { return "PROXY 127.0.0.1:${pport}"; }` });
        const w = await wsExchange({ url: `ws://127.0.0.1:${aport}/ws`, headers: {} }, [{ kind: 'send', text: 'hi' }, { kind: 'expect', text: 'echo:hi' }], { vars: {}, config: {}, env: {} }, 5000, conn2);
        assert.equal(w.error, undefined, JSON.stringify(w));
        assert.equal(p.seen.length, 2, 'the WebSocket went through the proxy too');
        // A broken PAC file: direct, with the reason.
        const bad = connection(n, {}, undefined, { pacScript: 'function FindProxyForURL( {' });
        assert.ok(bad.pacError);
        assert.equal(bad.proxyLabel('https://x.test/'), null);
    } finally { wss.close(); app.close(); p.s.close(); }
});

test('system proxy: Windows settings parsed; NTLM / Digest proxy sign-in uses the challenge tunnel', async () => {
    assert.deepEqual(parseWindowsProxyServer('proxy.bank.local:8080'), { http: 'proxy.bank.local:8080', https: 'proxy.bank.local:8080' });
    assert.deepEqual(parseWindowsProxyServer('http=p1:80;https=p2:8443;socks=s:1080'), { http: 'p1:80', https: 'p2:8443' });
    assert.deepEqual(parseWindowsOverride('<local>;*.bank.local;10.*'), ['<local>', '.bank.local', '10.*']);
    const sys = await readSystemProxy('linux', { HTTPS_PROXY: 'http://px:3128', NO_PROXY: 'localhost,.corp' });
    assert.deepEqual([sys.httpsProxy, sys.bypass], ['http://px:3128', ['localhost', '.corp']]);
    // System mode with the Windows values: plain names direct (<local>), the rest through the proxy.
    const n: NetworkSettings = { ...DEFAULT_NETWORK, bypass: [], proxyMode: 'system', proxyUser: 'CORP\\qa', proxyAuth: 'ntlm', proxyDomain: 'CORP' };
    const conn = connection(n, {}, 'pw', { system: { proxy: 'http://proxy.bank.local:8080', httpsProxy: 'http://proxy.bank.local:8080', bypass: ['<local>', '.bank.local'], source: 'Windows Internet settings' } });
    assert.equal(conn.agentFor('https://intranet/x'), undefined);
    assert.equal(conn.agentFor('https://app.bank.local/x'), undefined);
    assert.ok(conn.agentFor('https://api.partner.test/x') instanceof ProxyTunnelAgent);
    assert.ok(conn.agentFor('http://api.partner.test/x') instanceof ProxyTunnelHttpAgent);
    assert.equal(conn.proxyLabel('https://api.partner.test/x'), 'http://proxy.bank.local:8080 (Windows Internet settings)');
    assert.ok(!String(conn.proxyLabel('https://api.partner.test/x')).includes('pw'), 'no password in labels');
});
