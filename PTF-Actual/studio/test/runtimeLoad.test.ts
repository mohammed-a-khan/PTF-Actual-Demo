import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSdk, nodeSatisfies } from '../src/agents/host';

test('Node versions against an engines range (the agents runtime needs ^20.19.0 || >=22.12.0)', () => {
    const r = '^20.19.0 || >=22.12.0';
    assert.equal(nodeSatisfies('20.19.0', r), true);
    assert.equal(nodeSatisfies('20.20.1', r), true);
    assert.equal(nodeSatisfies('20.11.1', r), false);
    assert.equal(nodeSatisfies('18.20.4', r), false);
    assert.equal(nodeSatisfies('22.11.0', r), false);
    assert.equal(nodeSatisfies('22.12.0', r), true);
    assert.equal(nodeSatisfies('24.1.0', r), true);
    assert.equal(nodeSatisfies('21.7.0', r), false);
    assert.equal(nodeSatisfies('18.0.0', '>=18'), true);
    assert.equal(nodeSatisfies('16.9.0', '>=18'), false);
    assert.equal(nodeSatisfies('20.1.0', '20.x'), true);
    assert.equal(nodeSatisfies('20.5.3', '~20.5.0'), true);
    assert.equal(nodeSatisfies('20.6.0', '~20.5.0'), false);
});

test('an agents runtime that is installed but cannot start says why (not "not installed", so the Studio does not ask to install it again)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-load-'));
    try {
        const pkgDir = (base: string) => path.join(base, 'node_modules', '@github', 'copilot-sdk');
        const write = (base: string, pkg: object, main: string) => {
            fs.mkdirSync(pkgDir(base), { recursive: true });
            fs.writeFileSync(path.join(pkgDir(base), 'package.json'), JSON.stringify({ name: '@github/copilot-sdk', version: '1.0.34', main: 'index.js', ...pkg }));
            fs.writeFileSync(path.join(pkgDir(base), 'index.js'), main);
        };
        // Needs a newer Node.
        const old = path.join(tmp, 'old');
        write(old, { engines: { node: '>=99.0.0' } }, 'module.exports = { CopilotClient: class {} };');
        const p1: string[] = [];
        assert.equal(loadSdk(path.join(tmp, 'repo'), old, p1), null);
        assert.match(p1[0], /^The agents runtime in the Studio's folder is installed but cannot start: it needs Node\.js >=99\.0\.0; this Studio runs on Node\.js \d+\.\d+\.\d+\. Install a newer Node\.js/);
        // Damaged: it throws when loaded.
        const bad = path.join(tmp, 'bad');
        write(bad, {}, 'throw new Error("Cannot find module \'./dist/cjs/client.js\'");');
        const p2: string[] = [];
        assert.equal(loadSdk(path.join(tmp, 'repo'), bad, p2), null);
        assert.match(p2[0], /installed but cannot start: Cannot find module/);
        // Fine.
        const ok = path.join(tmp, 'ok');
        write(ok, { engines: { node: '>=18' } }, 'module.exports = { CopilotClient: class {} };');
        const p3: string[] = [];
        const l = loadSdk(path.join(tmp, 'repo'), ok, p3);
        assert.equal(l?.version, '1.0.34'); assert.equal(l?.source, 'studio'); assert.deepEqual(p3, []);
        // Not installed at all: no problem, just not found.
        const p4: string[] = [];
        assert.equal(loadSdk(path.join(tmp, 'repo'), path.join(tmp, 'none'), p4), null);
        assert.deepEqual(p4.filter((x) => !/the Studio's package/.test(x)), []);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
