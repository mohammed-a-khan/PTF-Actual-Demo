import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { execFileSync } from 'child_process';
import { bypassed, checkConnection, connection, DEFAULT_NETWORK, NetworkSettings, readCaFile, runEnvFor, validateNetwork } from '../src/core/network';
import { gitNetworkCommands, applyGitNetwork, gitNetworkState } from '../src/git/network';
import { SecretStore, secretsAsEnv } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-net-'));
const net0 = (o: Partial<NetworkSettings> = {}): NetworkSettings => ({ ...DEFAULT_NETWORK, ...o });

/** A private "company" root CA and a server certificate for localhost signed by it. */
function makeCerts(dir: string) {
    const o = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test Company Inspection Root']);
    o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost']);
    fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    o(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf']);
    return { ca: path.join(dir, 'ca.pem'), key: fs.readFileSync(path.join(dir, 'srv.key')), cert: fs.readFileSync(path.join(dir, 'srv.pem')) };
}

const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

test('settings: off by default, validated, bypass rules', () => {
    assert.equal(DEFAULT_NETWORK.proxyMode, 'off');
    assert.equal(DEFAULT_NETWORK.useSystemCerts, false);
    assert.equal(DEFAULT_NETWORK.caFile, '');
    assert.throws(() => validateNetwork(net0({ proxyMode: 'manual', proxyUrl: 'proxy:8080' })), /http:\/\//);
    assert.throws(() => validateNetwork(net0({ proxyMode: 'manual', proxyUrl: 'http://u:p@proxy:8080' })), /own fields/);
    assert.equal(validateNetwork(net0({ proxyMode: 'manual', proxyUrl: ' http://proxy.corp:8080 ' })).proxyUrl, 'http://proxy.corp:8080');
    assert.ok(bypassed('build.corp.local', ['.corp.local']));
    assert.ok(bypassed('corp.local', ['corp.local']) && bypassed('a.corp.local', ['corp.local']));
    assert.ok(!bypassed('evilcorp.local', ['corp.local']));
    assert.ok(bypassed('anything', ['*']));
    // Off → no proxy even when the environment has one.
    assert.equal(connection(net0(), { HTTPS_PROXY: 'http://env-proxy:1' }).proxyLabel('https://dev.azure.com/x'), null);
    assert.equal(connection(net0({ proxyMode: 'environment' }), { HTTPS_PROXY: 'http://u:secret@env-proxy:1', NO_PROXY: 'internal.corp' }).proxyLabel('https://dev.azure.com/x'), 'http://env-proxy:1/');
    assert.equal(connection(net0({ proxyMode: 'environment' }), { HTTPS_PROXY: 'http://env-proxy:1', NO_PROXY: 'internal.corp' }).proxyLabel('https://ado.internal.corp/x'), null);
    assert.deepEqual(runEnvFor(net0(), {}), {});
});

test('a hidden proxy address never blocks saving "Off" or "PAC" (QA3 M3)', () => {
    const long = 'http://' + 'a'.repeat(3000) + ':8080';
    // Off: the address is not used, so an invalid one is dropped, a valid one kept for later.
    assert.equal(validateNetwork(net0({ proxyMode: 'off', proxyUrl: long })).proxyUrl, '');
    assert.equal(validateNetwork(net0({ proxyMode: 'off', proxyUrl: 'not a url' })).proxyUrl, '');
    assert.equal(validateNetwork(net0({ proxyMode: 'off', proxyUrl: 'http://u:p@proxy:8080' })).proxyUrl, '');
    assert.equal(validateNetwork(net0({ proxyMode: 'off', proxyUrl: 'http://proxy.corp:8080' })).proxyUrl, 'http://proxy.corp:8080');
    assert.equal(validateNetwork(net0({ proxyMode: 'off', proxyUser: 'bad user', bypass: ['ok.corp', 'bad host!'] })).proxyUser, '');
    // PAC: only the PAC address is checked.
    assert.equal(validateNetwork(net0({ proxyMode: 'pac', pacUrl: 'http://wpad/proxy.pac', proxyUrl: 'nope' })).pacUrl, 'http://wpad/proxy.pac');
    assert.throws(() => validateNetwork(net0({ proxyMode: 'pac', pacUrl: '' })), /PAC file address/);
    // Manual still checks the address.
    assert.throws(() => validateNetwork(net0({ proxyMode: 'manual', proxyUrl: long })), /too long/);
    assert.throws(() => validateNetwork(net0({ proxyMode: 'manual', proxyUrl: '' })), /Give the proxy address/);
    assert.equal(validateNetwork(net0({ proxyMode: 'manual', proxyUrl: 'http://proxy.corp:8080', pacUrl: 'ftp://x' })).pacUrl, '');
});

test('a certificate file is read and shown; test runs get it', { skip: !hasOpenssl }, () => {
    const d = tmp();
    const c = makeCerts(d);
    const certs = readCaFile(c.ca);
    assert.equal(certs.length, 1);
    assert.match(certs[0].subject, /Test Company Inspection Root/);
    assert.deepEqual(runEnvFor(net0({ caFile: c.ca }), {}), { NODE_EXTRA_CA_CERTS: c.ca });
    assert.deepEqual(runEnvFor(net0({ caFile: c.ca, certsForTestRuns: false }), {}), {});
    fs.writeFileSync(path.join(d, 'not.pem'), 'hello');
    assert.throws(() => readCaFile(path.join(d, 'not.pem')), /no PEM certificates/);
});

test('connection test: untrusted company certificate is explained, then trusted via the file', { skip: !hasOpenssl }, async () => {
    const d = tmp();
    const c = makeCerts(d);
    const seenAuth: Array<string | undefined> = [];
    const srv = https.createServer({ key: c.key, cert: c.cert }, (req, res) => { seenAuth.push(req.headers.authorization); res.end('{}'); });
    const port = await listen(srv);
    const url = `https://localhost:${port}/_apis/connectionData`;
    const bad = await checkConnection(url, connection(net0(), {}), 'Basic dG9rZW4=');
    assert.equal(bad.ok, false);
    assert.equal(bad.stage, 'certificate');
    assert.match(bad.message, /Test Company Inspection Root/);
    assert.deepEqual(seenAuth, [undefined], 'the token is never sent over the untrusted connection (only the credential-free probe reached the server)');
    const good = await checkConnection(url, connection(net0({ caFile: c.ca }), {}), 'Basic dG9rZW4=');
    assert.equal(good.ok, true, good.message);
    assert.equal(seenAuth[1], 'Basic dG9rZW4=');
    srv.close();
});

test('connection test through a proxy that asks for a login', { skip: !hasOpenssl }, async () => {
    const d = tmp();
    const c = makeCerts(d);
    const target = https.createServer({ key: c.key, cert: c.cert }, (_req, res) => res.end('{}'));
    const tport = await listen(target);
    const proxyAuth: Array<string | undefined> = [];
    const proxy = http.createServer();
    proxy.on('connect', (req: http.IncomingMessage, sock: net.Socket) => {
        proxyAuth.push(req.headers['proxy-authorization'] as string | undefined);
        if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('jdoe:p@ss:w0rd').toString('base64')}`) {
            sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n'); return;
        }
        const up = net.connect(tport, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
        up.on('error', () => sock.destroy());
    });
    const pport = await listen(proxy);
    const url = `https://localhost:${tport}/_apis/connectionData`;
    const settings = net0({ proxyMode: 'manual', proxyUrl: `http://127.0.0.1:${pport}`, proxyUser: 'jdoe', bypass: [], caFile: c.ca });
    const noPw = await checkConnection(url, connection(settings, {}, 'wrong'));
    assert.equal(noPw.stage, 'proxy');
    assert.match(noPw.message, /407/);
    const ok = await checkConnection(url, connection(settings, {}, 'p@ss:w0rd'));
    assert.equal(ok.ok, true, ok.message);
    assert.match(ok.message, new RegExp(`Connected through http://127.0.0.1:${pport}`));
    assert.ok(!ok.message.includes('p@ss'));
    const unreachable = await checkConnection(url, connection(net0({ proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:1', bypass: [] }), {}));
    assert.equal(unreachable.stage, 'proxy');
    proxy.close(); target.close();
});

test('the proxy password is a Studio secret: not listed, not given to test runs', () => {
    const home = tmp();
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'k')));
    store.set({ name: 'QA_PASSWORD' }, 'qa-value');
    store.setStudio('NETWORK_PROXY_PASSWORD', 'proxy-pass');
    assert.equal(store.getStudio('NETWORK_PROXY_PASSWORD'), 'proxy-pass');
    assert.deepEqual(store.list().map((s) => s.name), ['QA_PASSWORD']);
    assert.deepEqual(Object.keys(secretsAsEnv(store, { project: 'any', env: 'qa' })), ['QA_PASSWORD']);
    assert.equal(store.resolve('NETWORK_PROXY_PASSWORD', { project: 'any' }), undefined);
    assert.ok(store.knownSecrets().some((k) => k.value === 'proxy-pass'), 'still masked and caught by the commit scan');
});

test('Git network settings: exact commands, applied to the global config only', async () => {
    const home = tmp();
    const repo = tmp();
    execFileSync('git', ['init', '-q', repo]);
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
    // Never touch the real global config of the machine running the tests.
    process.env.HOME = home; process.env.XDG_CONFIG_HOME = path.join(home, '.config'); process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig');
    try {
        assert.deepEqual(gitNetworkCommands({ proxy: 'http://proxy.corp:8080' }), [['config', '--global', 'http.proxy', 'http://proxy.corp:8080']]);
        assert.throws(() => gitNetworkCommands({ proxy: 'http://u:pw@proxy.corp:8080' }), /plain text/);
        assert.throws(() => gitNetworkCommands({ proxy: 'proxy.corp' }), /http:\/\//);
        if (process.platform !== 'win32') assert.throws(() => gitNetworkCommands({ sslBackend: 'schannel' }), /Git for Windows/);
        const ran = await applyGitNetwork(repo, { proxy: 'http://proxy.corp:8080', restoreSslVerify: true });
        assert.deepEqual(ran, ['git config --global http.proxy http://proxy.corp:8080', 'git config --global --unset-all http.sslVerify']);
        const st = await gitNetworkState(repo, {});
        assert.equal(st.global['http.proxy'], 'http://proxy.corp:8080');
        assert.equal(st.effective['http.proxy']?.value, 'http://proxy.corp:8080');
        assert.match(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8'), /proxy = http:\/\/proxy.corp:8080/);
        await applyGitNetwork(repo, { proxy: null });
        assert.equal((await gitNetworkState(repo, {})).global['http.proxy'], undefined);
    } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
});
