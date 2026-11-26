/**
 * Duplicate in the Code file tree: POST /api/file/copy copies a file, with the same path rules as rename.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { createServer, StudioServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';
import { ActivityLog } from '../src/core/activity';
import { Workspace } from '../src/workspace/files';

let tmp: string;
let srv: StudioServer;
let port: number;
let dir: string;

before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-copy-'));
    dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'test/qa/features'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/qa/features/login.feature'), 'Feature: Login\r\n  Scenario: ok\r\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const activity = new ActivityLog(path.join(tmp, 'home'), () => []);
    srv = createServer({ repoRoot: dir, store, userName: 'T', activity });
    port = (await srv.listen(0)).port;
});
after(async () => { await srv.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const headers: Record<string, string> = { authorization: `Bearer ${srv.token}` };
        if (data) headers['content-type'] = 'application/json';
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let json: any = t; try { json = JSON.parse(t); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, json }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

test('copies a file byte for byte (line endings kept) into a new name', async () => {
    const r = await call('POST', '/api/file/copy', { from: 'test/qa/features/login.feature', to: 'test/qa/features/login copy.feature' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { ok: true });
    assert.equal(fs.readFileSync(path.join(dir, 'test/qa/features/login copy.feature'), 'utf8'), 'Feature: Login\r\n  Scenario: ok\r\n');
    // The original is untouched.
    assert.ok(fs.existsSync(path.join(dir, 'test/qa/features/login.feature')));
    // Folders on the way are created.
    const r2 = await call('POST', '/api/file/copy', { from: 'test/qa/features/login.feature', to: 'test/qa/other/login.feature' });
    assert.equal(r2.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'test/qa/other/login.feature')));
});

test('never overwrites, and refuses what rename refuses', async () => {
    const exists = await call('POST', '/api/file/copy', { from: 'test/qa/features/login.feature', to: 'test/qa/features/login copy.feature' });
    assert.equal(exists.status, 400);
    assert.match(exists.json.error ?? exists.json.message ?? JSON.stringify(exists.json), /already exists/);
    const missing = await call('POST', '/api/file/copy', { from: 'test/qa/nope.feature', to: 'test/qa/nope2.feature' });
    assert.equal(missing.status, 400);
    assert.match(JSON.stringify(missing.json), /does not exist/);
    const folder = await call('POST', '/api/file/copy', { from: 'test/qa/features', to: 'test/qa/features2' });
    assert.equal(folder.status, 400);
    assert.match(JSON.stringify(folder.json), /only files/);
    for (const to of ['../outside.feature', '/etc/x.feature', '.git/hooks/pre-commit', 'test/qa/CON.feature', 'test/qa/a?b.feature']) {
        const r = await call('POST', '/api/file/copy', { from: 'test/qa/features/login.feature', to });
        assert.ok(r.status >= 400 && r.status < 500, `${to}: ${r.status}`);
    }
    for (const from of ['../x', '.git/config']) {
        const r = await call('POST', '/api/file/copy', { from, to: 'test/qa/stolen.txt' });
        assert.ok(r.status >= 400 && r.status < 500, `${from}: ${r.status}`);
    }
    assert.ok(!fs.existsSync(path.join(tmp, 'outside.feature')));
    assert.ok(!fs.existsSync(path.join(dir, 'test/qa/stolen.txt')));
    const body = await call('POST', '/api/file/copy', { from: 'test/qa/features/login.feature' });
    assert.equal(body.status, 400);
});

test('Workspace.copy: same rules directly', () => {
    const ws = new Workspace(dir);
    assert.throws(() => ws.copy('test/qa/features/login.feature', 'test/qa/features/login.feature'), /already exists/);
    ws.copy('test/qa/features/login.feature', 'test/qa/features/login copy 2.feature');
    assert.ok(fs.existsSync(path.join(dir, 'test/qa/features/login copy 2.feature')));
});
