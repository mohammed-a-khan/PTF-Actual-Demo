/**
 * Other repositories: clone one (the sign-in sent only to its host, never kept in the clone), open another
 * repository as its own Studio, and the recently opened list.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { cloneFolderName, cloneRepo, recentRepos, rememberRepo } from '../src/git/workspaces';
import { runGit } from '../src/git/run';

test('clone: the folder name, the repository, nothing of the sign-in kept; recently opened', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    try {
        assert.equal(cloneFolderName('https://dev.azure.com/acme/qa/_git/Shop%20Tests'), 'Shop-Tests');
        assert.equal(cloneFolderName('git@ssh.dev.azure.com:v3/acme/qa/orders.git'), 'orders');
        const src = path.join(tmp, 'src');
        await runGit(['init', '-q', '-b', 'main', src], { cwd: tmp });
        fs.writeFileSync(path.join(src, 'a.txt'), 'x');
        await runGit(['-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-qm', 'one', '--allow-empty'], { cwd: src });
        const out = path.join(tmp, 'work'); fs.mkdirSync(out);
        const dest = await cloneRepo({ url: `file://${src}`, parent: out, name: 'orders' });
        assert.equal(dest, path.join(out, 'orders'));
        assert.ok(fs.existsSync(path.join(dest, '.git')));
        await assert.rejects(cloneRepo({ url: `file://${src}`, parent: out, name: 'orders' }), /already exists/);
        await assert.rejects(cloneRepo({ url: '--upload-pack=x', parent: out }), /Not a repository address|https/);
        await assert.rejects(cloneRepo({ url: `file://${src}`, parent: out, name: '../x' }), /letters, digits/);
        // Over https: the Authorization header goes to its host only, for this one command.
        const seen: string[] = [];
        const srv = http.createServer((q, r) => { seen.push(String(q.headers.authorization ?? '')); r.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); r.end(); });
        const port = await new Promise<number>((res) => srv.listen(0, '127.0.0.1', () => res((srv.address() as net.AddressInfo).port)));
        try {
            await assert.rejects(cloneRepo({ url: `http://127.0.0.1:${port}/acme/_git/shop`, parent: out, authHeader: 'Basic c2VjcmV0', authHost: '127.0.0.1' }), /git clone failed/);
            assert.ok(seen.length && seen.every((h) => h === ''), 'not sent over plain http');
            seen.length = 0;
            // The same host but https only: a git https remote with the header (here refused, but the config never kept).
            await assert.rejects(cloneRepo({ url: `http://localhost:${port}/acme/_git/shop`, parent: out, authHeader: 'Basic c2VjcmV0', authHost: '127.0.0.1' }), /git clone failed/);
            assert.ok(seen.every((h) => h === ''), 'another host: not sent');
        } finally { srv.close(); }
        assert.ok(!fs.readFileSync(path.join(dest, '.git', 'config'), 'utf8').includes('extraHeader'));
        const home = path.join(tmp, 'home');
        rememberRepo(home, dest); rememberRepo(home, src); rememberRepo(home, dest);
        assert.deepEqual(recentRepos(home).map((r) => r.name), ['orders', 'src']);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('open another repository as its own Studio (programs in its Git settings shown first)', { timeout: 90_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws2-'));
    const prevHome = process.env.CS_STUDIO_HOME;
    process.env.CS_STUDIO_HOME = path.join(tmp, 'home');
    try {
        const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
        for (const d of [a, b]) await runGit(['init', '-q', '-b', 'main', d], { cwd: tmp });
        await runGit(['config', 'core.hooksPath', '/opt/hooks'], { cwd: b });
        const { SecretStore } = await import('../src/secrets/store');
        const { KeyFileProtector } = await import('../src/secrets/protector');
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const { createServer } = await import('../src/server/server');
        const s = createServer({ repoRoot: a, store, userName: 'T', home: path.join(tmp, 'home'), token: 'tk' });
        const call = async (url: string, payload?: object) => { const r = await s.app.inject({ method: payload ? 'POST' : 'GET', url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, json: JSON.parse(r.body) }; };
        try {
            assert.equal((await call('/api/workspaces')).json.current, a);
            assert.match((await call('/api/workspaces/open', { path: path.join(tmp, 'nope') })).json.error, /not a folder/);
            assert.deepEqual((await call('/api/workspaces/open', { path: a })).json, { url: null, same: true });
            const first = await call('/api/workspaces/open', { path: b });
            assert.deepEqual(first.json.needsTrust, ['core.hookspath = /opt/hooks']);
            const r = await call('/api/workspaces/open', { path: b, trustRepoConfig: true });
            assert.equal(r.status, 200, JSON.stringify(r.json));
            assert.match(r.json.url, /^http:\/\/127\.0\.0\.1:\d+\//);
            const res = await fetch(new URL('api/workspaces', r.json.url.split('#')[0]), { headers: { authorization: `Bearer ${/token=([^&]+)/.exec(r.json.url)![1]}` } });
            const other = await res.json() as { current: string; recent: Array<{ path: string }> };
            assert.equal(other.current, b, 'the other Studio works on the other repository');
            assert.deepEqual((await call('/api/workspaces')).json.recent.map((x: { path: string }) => x.path).slice(0, 2).sort(), [a, b].sort());
        } finally { await s.app.close(); }
    } finally {
        // Stop the other Studio (its process listens on the port it printed).
        try { require('child_process').execSync(`pkill -f "start --repo ${path.join(tmp, 'b')}"`); } catch { /* gone */ }
        if (prevHome === undefined) delete process.env.CS_STUDIO_HOME; else process.env.CS_STUDIO_HOME = prevHome;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
