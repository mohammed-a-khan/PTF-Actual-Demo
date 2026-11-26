/**
 * Copilot inline suggestions (lang/copilot.ts) against a stand-in for GitHub's Copilot language
 * server (test/fixtures/copilot-lsp-mock.js): no network.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { changeBetween, CopilotInline, CopilotDeps, isSecretPath, LSP_PACKAGE, LSP_TESTED_VERSION, maskSameLength, offsetAt, positionAt } from '../src/lang/copilot';
import { installedVersion } from '../src/agents/runtime';

const MOCK = [path.join(__dirname, '..', '..', 'test', 'fixtures', 'copilot-lsp-mock.js'), path.join(__dirname, 'fixtures', 'copilot-lsp-mock.js')].find((f) => fs.existsSync(f))!;
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(o: { signedIn?: boolean; existing?: boolean; crash?: boolean; delay?: number; deps?: Partial<CopilotDeps>; mockPath?: string | null } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-copilot-'));
    const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
    const state = path.join(home, 'mock-state.json');
    const logFile = path.join(home, 'mock-log.ndjson');
    fs.writeFileSync(state, JSON.stringify({ signedIn: !!o.signedIn, user: 'mock-user' }));
    const env: Record<string, string | undefined> = {
        CS_STUDIO_COPILOT_LSP: o.mockPath === null ? undefined : (o.mockPath ?? MOCK), MOCK_COPILOT_STATE: state, MOCK_COPILOT_LOG: logFile,
        MOCK_COPILOT_EXISTING: o.existing ? '1' : undefined, MOCK_COPILOT_CRASH: o.crash ? '1' : undefined, MOCK_COPILOT_DELAY: String(o.delay ?? 20), MOCK_COPILOT_SIGNIN_MS: '100',
    };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const logs: string[] = [];
    const c = new CopilotInline({
        home, repoRoot: repo, studioVersion: '0.1.0', env: () => ({}), proxy: () => 'http://proxy.example:8080', token: () => undefined,
        knownSecrets: () => ['S3cretValue!'], blocked: () => null, log: (_a, t) => logs.push(t), ...(o.deps ?? {}),
    });
    const sent = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method: string; params: any }) : []); // eslint-disable-line @typescript-eslint/no-explicit-any
    const done = async () => { await c.stop(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(home, { recursive: true, force: true }); };
    return { c, home, repo, sent, logs, done };
}

test('text helpers: positions, the one changed range, secret files, same-length masking', () => {
    const t = 'ab\ncd😀e\n';
    assert.deepEqual(positionAt(t, 5), { line: 1, character: 2 });
    assert.equal(offsetAt(t, { line: 1, character: 2 }), 5);
    assert.equal(offsetAt(t, { line: 1, character: 99 }), t.indexOf('\n', 3), 'clamped to the line');
    assert.equal(offsetAt(t, { line: 9, character: 0 }), t.length);
    assert.equal(changeBetween('abc', 'abc'), null);
    assert.deepEqual(changeBetween('hello\nworld', 'hello\nbig world'), { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: 'big ' });
    assert.deepEqual(changeBetween('a\nb\nc', 'a\nc'), { range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, text: '' });
    for (const f of ['.env', 'config/app/environments/dev.env', '.env.local', 'secrets/db.json', 'test/x/credentials.ts', 'certs/client.pfx', 'keys/server.key', '.npmrc', 'auth/storage-state.json'])
        assert.ok(isSecretPath(f, f.endsWith('.json') ? '{"cookies": [], "origins": []}' : ''), f);
    for (const f of ['test/weblab/steps/shop.steps.ts', 'src/environment.ts', 'README.md']) assert.ok(!isSecretPath(f, 'x'), f);
    const masked = maskSameLength('const p = "S3cretValue!";\nconst k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n', ['S3cretValue!']);
    assert.ok(!masked.includes('S3cretValue!'));
    assert.ok(!masked.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'what the secret scanner finds is blanked too');
    assert.equal(masked.length, 'const p = "S3cretValue!";\nconst k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n'.length, 'positions stay right');
});

test('start, device-code sign-in, suggestions with offsets, shown / accepted / partly accepted', async () => {
    const t = setup();
    try {
        assert.equal(t.c.status().state, 'stopped');
        await t.c.start();
        assert.equal(t.c.status().state, 'sign-in');
        const init = t.sent().find((m) => m.method === 'initialize')!;
        assert.equal(init.params.initializationOptions.editorInfo.name, 'CS Test Studio');
        assert.equal(init.params.initializationOptions.editorPluginInfo.name, 'CS Test Studio Copilot');
        const conf = t.sent().find((m) => m.method === 'workspace/didChangeConfiguration')!;
        assert.equal(conf.params.settings.http.proxy, 'http://proxy.example:8080', 'the Studio\'s proxy');
        assert.equal((await t.c.inline('a.ts', 'x', 1)).skipped, 'Sign in to GitHub Copilot.');

        const st = await t.c.signIn();
        assert.equal(st.signIn?.userCode, 'MOCK-1234');
        assert.equal(st.signIn?.verificationUri, 'https://github.com/login/device');
        await until(() => t.c.status().state === 'ready');
        assert.equal(t.c.status().user, 'mock-user');
        assert.equal(t.c.status().signIn, undefined);
        assert.ok(t.logs.some((l) => /Signed in .* as mock-user/.test(l)));

        const text = "class A {\n    run() {\n        const value: string = 'x'; value.\n    }\n}\n";
        const off = text.indexOf('value.\n') + 'value.'.length;
        const r = await t.c.inline('test/a.steps.ts', text, off);
        assert.equal(r.items.length, 1, 'automatic: one');
        const it = r.items[0];
        assert.equal(it.start, text.lastIndexOf('\n', off - 1) + 1, 'the range starts at the line');
        assert.equal(it.end, off);
        assert.equal(it.text, "        const value: string = 'x'; value.toUpperCase();");
        const invoked = await t.c.inline('test/a.steps.ts', text, off, { invoked: true });
        assert.equal(invoked.items.length, 2, 'asked for (cycling): alternatives');
        const open = t.sent().filter((m) => m.method === 'textDocument/didOpen');
        assert.equal(open.length, 1);
        assert.equal(open[0].params.textDocument.languageId, 'typescript');
        assert.match(open[0].params.textDocument.uri, /^file:\/\/.*\/repo\/test\/a\.steps\.ts$/);

        // Incremental sync: the server's copy matches the editor's text after an edit.
        const text2 = text.replace('value.', 'value.trim();\n        const greeting = ');
        const off2 = text2.indexOf('const greeting = ') + 'const greeting = '.length;
        const r2 = await t.c.inline('test/a.steps.ts', text2, off2);
        assert.match(r2.items[0].text, /Hello, world/);
        const copies = t.sent().filter((m) => m.method === 'mock/text');
        assert.equal(copies[copies.length - 1].params.text, text2);
        assert.ok(t.sent().some((m) => m.method === 'textDocument/didChange' && m.params.contentChanges[0].range), 'incremental changes');

        t.c.shown(it.id);
        await t.c.accepted(it.id, 12);
        await t.c.accepted(r2.items[0].id);
        await sleep(100);
        const m = t.sent();
        assert.equal(m.find((x) => x.method === 'textDocument/didShowCompletion')?.params.item.command.arguments[0], 'mock-upper');
        assert.equal(m.find((x) => x.method === 'textDocument/didPartiallyAcceptCompletion')?.params.acceptedLength, 12);
        assert.deepEqual(m.find((x) => x.method === 'workspace/executeCommand' && x.params.command === 'github.copilot.didAcceptCompletionItem')?.params.arguments, ['mock-greet']);
    } finally { await t.done(); }
});

test('secrets never leave: secret files are not sent, known and scanned secret values are blanked', async () => {
    const t = setup({ signedIn: true });
    try {
        const r = await t.c.inline('config/app/environments/dev.env', 'PASSWORD=x\n', 3);
        assert.deepEqual(r.items, []);
        assert.match(r.skipped!, /never sent/);
        const text = 'const p = "S3cretValue!";\nconst greeting = ';
        await t.c.inline('src/a.ts', text, text.length);
        const all = JSON.stringify(t.sent());
        assert.ok(!all.includes('dev.env'), 'the .env file was not opened');
        assert.ok(!all.includes('S3cretValue!'), 'the secret value was blanked');
        assert.ok(all.includes('••••••••••••'));
    } finally { await t.done(); }
});

test('a newer request cancels the one still waiting; the caller\'s abort cancels too', async () => {
    const t = setup({ signedIn: true, delay: 300 });
    try {
        const text = 'const greeting = ';
        const first = t.c.inline('a.ts', text, text.length);
        await sleep(50);
        const second = t.c.inline('a.ts', text, text.length);
        assert.equal((await first).skipped, 'cancelled');
        assert.equal((await second).items.length, 1);
        const ac = new AbortController();
        const third = t.c.inline('a.ts', text, text.length, { signal: ac.signal });
        await sleep(50); ac.abort();
        assert.equal((await third).skipped, 'cancelled');
        await sleep(50);
        assert.ok(t.sent().some((m) => m.method === '$/cancelRequest'));
    } finally { await t.done(); }
});

test('an existing sign-in from another Copilot editor; sign out; turned off; blocked by policy', async () => {
    let blocked: string | null = null;
    const t = setup({ existing: true, deps: { blocked: () => blocked } });
    try {
        await t.c.start();
        const st = t.c.status();
        assert.equal(st.state, 'sign-in');
        assert.deepEqual(st.existing, [{ tokenId: 7, login: 'other-editor-user', host: 'https://github.com' }]);
        const after = await t.c.useExisting(7);
        assert.equal(after.state, 'ready');
        assert.equal(after.user, 'other-editor-user');
        assert.equal((await t.c.signOut()).state, 'sign-in');
        await t.c.setEnabled(false);
        assert.equal(t.c.status().state, 'off');
        await assert.rejects(t.c.inline('a.ts', 'x', 1), /turned off/);
        await t.c.setEnabled(true);
        blocked = 'Turned off by this repository\'s agent policy.';
        assert.equal(t.c.status().state, 'off');
        assert.equal(t.c.status().reason, blocked);
        await assert.rejects(t.c.start(), /agent policy/);
    } finally { await t.done(); }
});

test('a crash: started again on the next request; stopping repeatedly is reported; idle stop', async () => {
    const t = setup({ signedIn: true, crash: true, deps: { idleMs: 400 } });
    try {
        const crash = 'const crash = ';
        await t.c.start();
        await assert.rejects(t.c.inline('a.ts', crash, crash.length));
        await until(() => t.c.status().state === 'stopped');
        assert.match(t.c.status().reason ?? '', /starts again/);
        const ok = 'const greeting = ';
        assert.equal((await t.c.inline('a.ts', ok, ok.length)).items.length, 1, 'restarted');
        await assert.rejects(t.c.inline('a.ts', crash, crash.length));
        await until(() => t.c.status().state === 'stopped');
        await t.c.start();
        await assert.rejects(t.c.inline('a.ts', crash, crash.length));
        await until(() => t.c.status().state === 'error');
        assert.match(t.c.status().reason ?? '', /stopped 3 times/);
        await t.c.restart();
        assert.equal(t.c.status().state, 'ready');
        await until(() => t.c.status().state === 'stopped', 3000);
        assert.ok(t.logs.some((l) => /not used for a while/.test(l)), 'idle: stopped');
        assert.equal(t.c.status().user, 'mock-user', 'who was signed in is kept');
        const g = 'const greeting = ';
        assert.equal((await t.c.inline('a.ts', g, g.length)).items.length, 1, 'the next request starts it again');
        t.c.startOnce();
        assert.equal(t.c.status().state, 'ready', 'startOnce does not start a second one');
    } finally { await t.done(); }
});

test('install: npm into the Studio\'s folder without the platform binaries, then it runs with the Studio\'s Node.js', async () => {
    const t = setup({ mockPath: null, signedIn: true });
    try {
        const fake = path.join(t.home, 'npm.js');
        fs.writeFileSync(fake, `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
fs.writeFileSync(path.join(prefix, 'npm-args.json'), JSON.stringify(args));
const v = args[1].split('@').pop();
const d = path.join(prefix, 'node_modules', '@github', 'copilot-language-server');
fs.mkdirSync(path.join(d, 'dist'), { recursive: true });
fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: '@github/copilot-language-server', version: v }));
fs.writeFileSync(path.join(d, 'dist', 'language-server.js'), 'require(' + JSON.stringify(${JSON.stringify(MOCK)}) + ');');
console.log('added 1 package');
`);
        const c = new CopilotInline({ home: t.home, repoRoot: t.repo, studioVersion: '0.1.0', env: () => ({}), proxy: () => undefined, token: () => undefined, knownSecrets: () => [], blocked: () => null, log: () => undefined, npm: { command: process.execPath, prefixArgs: [fake] } });
        assert.equal(c.status().state, 'not-installed');
        c.install();
        assert.equal(c.status().state, 'installing');
        await until(() => !c.installer.state().running, 10000);
        assert.equal(c.installer.state().ok, true, c.installer.state().log.join('\n'));
        assert.equal(installedVersion(c.installer.folder, LSP_PACKAGE), LSP_TESTED_VERSION);
        const args = JSON.parse(fs.readFileSync(path.join(c.installer.folder, 'npm-args.json'), 'utf8')) as string[];
        assert.equal(args[1], `${LSP_PACKAGE}@${LSP_TESTED_VERSION}`);
        assert.ok(args.includes('--omit=optional'), 'Node.js 22.13+: no platform binaries');
        const st = c.status();
        assert.equal(st.installed, true);
        assert.equal(st.version, LSP_TESTED_VERSION);
        assert.equal(st.state, 'stopped');
        await c.start();
        assert.equal(c.status().state, 'ready');
        await c.remove();
        assert.equal(c.status().state, 'not-installed');
    } finally { await t.done(); }
});
