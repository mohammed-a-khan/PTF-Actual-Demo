import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentHost, loadSdk } from '../src/agents/host';
import { installedVersion, npmProblem, pruneOtherPlatforms, RuntimeInstaller, SDK_TESTED_VERSION } from '../src/agents/runtime';
import { writeFakeCopilotSdk, writeFakeNpm } from './fakeCopilot';

const until = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const reset = () => { delete (global as { __fakeCopilot?: unknown }).__fakeCopilot; for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}copilot-sdk${path.sep}`) && k.includes('agents-signin-')) delete require.cache[k]; };

function setup(scenario: string, delayMs?: number) {
    reset();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-signin-'));
    const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
    const runtimeDir = path.join(home, 'agents-runtime');
    writeFakeCopilotSdk(runtimeDir, { scenario, delayMs });
    const logs: string[] = [];
    const host = new AgentHost({ repoRoot: repo, home, runtimeDir, browser: { running: false } as never, secret: () => undefined, call: async () => ({ status: 200, body: {} }), projects: () => [], log: (a, t) => logs.push(`${a}: ${t}`) });
    return { home, repo, runtimeDir, host, logs, done: () => { fs.rmSync(home, { recursive: true, force: true }); reset(); } };
}

test('runtime: the Studio\'s own folder is used when the repository has none', () => {
    const { repo, runtimeDir, done } = setup('device');
    const l = loadSdk(repo, runtimeDir);
    assert.equal(l?.source, 'studio'); assert.equal(l?.version, '9.9.9');
    done();
});

test('sign in with a code: the code is shown, the account is signed in, the runtime restarts; status has account, quota, models (with multipliers), accounts without tokens', async () => {
    const { host, logs, done } = setup('device');
    let s = await host.signInBegin('githubDotCom', 'device-code');
    assert.equal(s.active, true);
    assert.deepEqual(s.step && { ...s.step, expiresAt: 0 }, { kind: 'device-code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 0 });
    await until(() => !host.signInState().active);
    s = host.signInState();
    assert.deepEqual(s.step, { kind: 'done', login: 'akhan', host: 'https://github.com' });
    assert.ok(logs.some((l) => l === 'agent.signin: Signed in to GitHub Copilot as akhan'));
    const st = await host.status() as Record<string, any>;
    assert.equal(st.auth.isAuthenticated, true); assert.equal(st.auth.login, 'akhan');
    assert.deepEqual(st.models, [{ id: 'gpt-mini', name: 'GPT mini', multiplier: 0 }, { id: 'big-model', name: 'Big model', multiplier: 1 }, { id: 'off-model', name: 'Off model', enabled: false }]);
    assert.equal(st.quota.premium_interactions.used, 42); assert.equal(st.quota.premium_interactions.entitlement, 300);
    assert.deepEqual(st.accounts.map((a: { login: string; active: boolean }) => `${a.login}:${a.active}`), ['akhan:true', 'akhan-work:false']);
    assert.ok(!JSON.stringify(st).includes('never-shown'), 'tokens never leave the host');
    assert.equal(st.runtime.source, 'studio');
    // Switch, then sign out.
    await host.switchAccount('sel-work');
    assert.equal(((await host.status()) as any).auth.login, 'akhan-work');
    await host.signOut();
    assert.equal(((await host.status()) as any).auth.isAuthenticated, false);
    assert.ok(logs.includes('agent.signin: Signed out of GitHub Copilot'));
    done();
});

test('sign in in the browser on GitHub Enterprise Cloud: the host is asked for; a wrong host is an error', async () => {
    const { host, done } = setup('device');
    let s = await host.signInBegin('proxima', 'web');
    assert.equal(s.step?.kind, 'input-required');
    await assert.rejects(host.signInAnswer({ input: ' ' }), /Enter the address/);
    s = await host.signInAnswer({ input: 'https://contoso.ghe.com' });
    await until(() => host.signInState().step?.kind === 'open-url' || !host.signInState().active);
    assert.match((host.signInState().step as { url: string }).url, /^https:\/\/contoso\.ghe\.com\/login\/oauth\/authorize/);
    await until(() => !host.signInState().active);
    assert.deepEqual(host.signInState().step, { kind: 'done', login: 'akhan', host: 'https://contoso.ghe.com' });
    // A wrong host.
    await host.signInBegin('proxima', 'web');
    await host.signInAnswer({ input: 'https://evil.example.com' });
    await until(() => !host.signInState().active);
    assert.deepEqual(host.signInState().step, { kind: 'error', message: 'Not a GitHub Enterprise Cloud host: https://evil.example.com' });
    done();
});

test('sign in: choosing an account; consent to keep the sign-in without a keychain (or not); cancel; failure', async () => {
    let t = setup('accounts');
    await t.host.signInBegin('githubDotCom', 'web');
    await until(() => t.host.signInState().step?.kind === 'choose-account');
    await assert.rejects(t.host.signInAnswer({ selectionId: 'nope' }), /Choose one of the accounts/);
    await t.host.signInAnswer({ selectionId: 'sel-work' });
    await until(() => !t.host.signInState().active);
    assert.deepEqual(t.host.signInState().step, { kind: 'done', login: 'akhan-work', host: 'https://github.com' });
    t.done();

    t = setup('consent');
    await t.host.signInBegin('githubDotCom', 'web');
    await until(() => t.host.signInState().step?.kind === 'store-consent');
    await t.host.signInAnswer({ consent: false });
    assert.deepEqual(t.host.signInState(), { active: false, step: { kind: 'cancelled' } });
    await t.host.signInBegin('githubDotCom', 'web');
    await until(() => t.host.signInState().step?.kind === 'store-consent');
    await t.host.signInAnswer({ consent: true });
    await until(() => !t.host.signInState().active);
    assert.equal(t.host.signInState().step?.kind, 'done');
    t.done();

    t = setup('device', 5000);
    await t.host.signInBegin('githubDotCom', 'device-code');
    await t.host.signInCancel();
    assert.deepEqual(t.host.signInState(), { active: false, step: { kind: 'cancelled' } });
    assert.equal((global as any).__fakeCopilot.cancelled, 1);
    await assert.rejects(t.host.signInAnswer({ input: 'x' }), /No sign-in in progress/);
    t.done();

    t = setup('fail');
    await t.host.signInBegin('githubDotCom', 'device-code');
    await until(() => !t.host.signInState().active);
    assert.deepEqual(t.host.signInState().step, { kind: 'error', message: 'The device code expired.' });
    t.done();
});

test('sign in: only for GitHub Copilot as the provider', async () => {
    const { host, done } = setup('device');
    await host.saveSettings({ provider: 'custom', model: 'gpt-4o', custom: { type: 'openai', baseUrl: 'http://localhost:9' }, approvals: { files: 'ask', shell: 'ask', mcp: 'ask', studio: 'ask', urls: 'ask' } });
    await assert.rejects(host.signInBegin('githubDotCom', 'web'), /choose GitHub Copilot/);
    done();
});

test('runtime install: npm into the Studio\'s folder (tested version, latest, team pin); registry problems in plain words', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-rt-'));
    const fake = path.join(home, 'npm.js');
    const dir = path.join(home, 'agents-runtime');
    const run = async (mode: 'ok' | 'e401' | 'e404', version: string, repoRoot?: string) => {
        writeFakeNpm(fake, mode);
        const i = new RuntimeInstaller(dir, { command: process.execPath, prefixArgs: [fake] });
        i.install(version, { repoRoot });
        assert.throws(() => i.install(version), /already being installed/);
        await until(() => !i.state().running, 15000);
        return i;
    };
    const repo = path.join(home, 'repo'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, '.npmrc'), 'registry=https://registry.example/\n');
    let i = await run('ok', SDK_TESTED_VERSION, repo);
    assert.equal(i.state().ok, true, i.state().log.join('\n'));
    assert.equal(installedVersion(dir), SDK_TESTED_VERSION);
    assert.equal(fs.readFileSync(path.join(dir, '.npmrc'), 'utf8'), 'registry=https://registry.example/\n', 'the repository\'s registry settings apply');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).private, true);
    i = await run('ok', 'latest');
    assert.equal(installedVersion(dir), '2.0.0');
    i = await run('e401', '1.0.0');
    assert.equal(i.state().ok, false);
    assert.match(i.state().error!, /registry refused the request/);
    assert.equal(installedVersion(dir), '2.0.0', 'a failed update keeps the installed runtime');
    i = await run('e404', '1.0.0');
    assert.match(i.state().error!, /does not have @github\/copilot-sdk/);
    assert.throws(() => i.install('1.0; rm -rf /'), /Version/);
    i.remove();
    assert.ok(!fs.existsSync(dir));

    assert.match(npmProblem(['npm error code SELF_SIGNED_CERT_IN_CHAIN']) ?? '', /certificate/);
    assert.match(npmProblem(['npm error network request failed, reason: getaddrinfo ENOTFOUND registry']) ?? '', /proxy/);
    assert.equal(npmProblem(['all good']), null);
    fs.rmSync(home, { recursive: true, force: true });
});

test('runtime install through the host: the team policy pins the version; agents off means no install', async () => {
    const t = setup('device');
    const fake = path.join(t.home, 'npm.js'); writeFakeNpm(fake, 'ok');
    (t.host.installer as unknown as { npm: unknown }).npm = { command: process.execPath, prefixArgs: [fake] };
    fs.mkdirSync(path.join(t.repo, '.cs-studio'));
    fs.writeFileSync(path.join(t.repo, '.cs-studio', 'agents-policy.json'), JSON.stringify({ runtimeVersion: '1.0.30' }));
    const r = t.host.installRuntime('latest');
    assert.equal(r.install.target, '@github/copilot-sdk@1.0.30');
    assert.equal(r.pinned, '1.0.30');
    await until(() => !t.host.installer.state().running, 15000);
    assert.equal(installedVersion(t.runtimeDir), '1.0.30');
    fs.writeFileSync(path.join(t.repo, '.cs-studio', 'agents-policy.json'), JSON.stringify({ enabled: false }));
    assert.throws(() => t.host.installRuntime(), /turned off/);
    t.done();
});

test('runtime: platform packages for other computers are removed (glibc/musl, os, cpu); unknown ones kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-prune-'));
    const pkg = (n: string, j: object) => { const d = path.join(dir, 'node_modules', '@github', n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(j)); };
    pkg('copilot-sdk', { name: '@github/copilot-sdk', version: '1.0.34' });
    pkg('copilot-sdk-linux-x64', { os: ['linux'], cpu: ['x64'], libc: ['glibc'] });
    pkg('copilot-sdk-linuxmusl-x64', { os: ['linux'], cpu: ['x64'], libc: ['musl'] });
    pkg('copilot-sdk-win32-x64', { os: ['win32'], cpu: ['x64'] });
    pkg('copilot-sdk-linux-arm64', { os: ['linux'], cpu: ['arm64'], libc: ['glibc'] });
    pkg('copilot-sdk-other', {});
    assert.deepEqual(pruneOtherPlatforms(dir, { os: 'linux', cpu: 'x64', libc: 'glibc' }).sort(), ['@github/copilot-sdk-linux-arm64', '@github/copilot-sdk-linuxmusl-x64', '@github/copilot-sdk-win32-x64']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'node_modules', '@github')).sort(), ['copilot-sdk', 'copilot-sdk-linux-x64', 'copilot-sdk-other']);
    assert.deepEqual(pruneOtherPlatforms(path.join(dir, 'none')), []);
    fs.rmSync(dir, { recursive: true, force: true });
});
