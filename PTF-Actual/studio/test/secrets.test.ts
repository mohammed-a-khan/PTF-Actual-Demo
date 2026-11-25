import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyFileProtector } from '../src/secrets/protector';
import { SecretStore, secretsAsEnv } from '../src/secrets/store';
import { studioHome } from '../src/core/paths';
import { GitService } from '../src/git/service';
import { runGit } from '../src/git/run';
import { allowlistFinding, ignoreFile, moveToStore, removeValue, replacementFor } from '../src/scanner/fixes';

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-sec-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const newStore = (name: string) => {
    const home = path.join(tmp, name);
    return { home, store: new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key'))) };
};

test('studioHome per OS', () => {
    assert.equal(studioHome({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32'), path.join('C:\\Users\\a\\AppData\\Local', 'CsTestStudio'));
    assert.match(studioHome({}, 'darwin'), /Library\/Application Support\/CsTestStudio$/);
    assert.equal(studioHome({ XDG_DATA_HOME: '/x' }, 'linux'), path.join('/x', 'cs-test-studio'));
    assert.equal(studioHome({ CS_STUDIO_HOME: '/p' }, 'linux'), path.resolve('/p'));
});

test('values are encrypted at rest and the key file is private', () => {
    const { home, store } = newStore('enc');
    store.set({ name: 'QA_PASSWORD' }, 'Tr0ub4dor&3');
    const raw = fs.readFileSync(path.join(home, 'secrets', 'secrets.json'), 'utf8');
    assert.ok(!raw.includes('Tr0ub4dor'));
    assert.equal(store.resolve('QA_PASSWORD'), 'Tr0ub4dor&3');
    assert.equal(fs.statSync(path.join(home, 'keys', 'secrets.key')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, 'secrets', 'secrets.json')).mode & 0o777, 0o600);
    // A new process (fresh protector instance) can read it.
    const again = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    assert.equal(again.resolve('QA_PASSWORD'), 'Tr0ub4dor&3');
});

test('tampering is detected', () => {
    const { home, store } = newStore('tamper');
    store.set({ name: 'A_KEY' }, 'value-1234');
    const file = path.join(home, 'secrets', 'secrets.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const parts = data.secrets[0].sealed.split(':');
    const ct = Buffer.from(parts[3], 'base64'); ct[0] ^= 1; parts[3] = ct.toString('base64');
    data.secrets[0].sealed = parts.join(':');
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(() => store.resolve('A_KEY'));
});

test('most specific scope wins; list never exposes values', () => {
    const { store } = newStore('scope');
    store.set({ name: 'DB_PASSWORD' }, 'all');
    store.set({ name: 'DB_PASSWORD', env: 'qa' }, 'all-qa');
    store.set({ name: 'DB_PASSWORD', project: 'orders' }, 'orders');
    store.set({ name: 'DB_PASSWORD', project: 'orders', env: 'qa' }, 'orders-qa');
    assert.equal(store.resolve('DB_PASSWORD', { project: 'orders', env: 'qa' }), 'orders-qa');
    assert.equal(store.resolve('DB_PASSWORD', { project: 'orders', env: 'uat' }), 'orders');
    assert.equal(store.resolve('DB_PASSWORD', { project: 'billing', env: 'qa' }), 'all-qa');
    assert.equal(store.resolve('DB_PASSWORD', { project: 'billing' }), 'all');
    assert.equal(store.resolve('NOPE'), undefined);
    assert.ok(!JSON.stringify(store.list()).includes('orders-qa'));
    assert.equal(store.list({ project: 'billing' }).length, 2);
    assert.deepEqual(secretsAsEnv(store, { project: 'orders', env: 'qa' }), { DB_PASSWORD: 'orders-qa' });
    assert.ok(store.delete({ name: 'DB_PASSWORD', project: 'orders', env: 'qa' }));
    assert.equal(store.resolve('DB_PASSWORD', { project: 'orders', env: 'qa' }), 'orders');
});

test('names are validated', () => {
    const { store } = newStore('names');
    assert.throws(() => store.set({ name: 'lower' }, 'x'));
    assert.throws(() => store.set({ name: 'A B' }, 'x'));
    assert.throws(() => store.set({ name: 'OK', env: '../x' }, 'x'));
    assert.throws(() => store.set({ name: 'OK' }, ''));
});

test('replacementFor: code literal vs config value', () => {
    const line = 'const login = { password: "Tr0ub4dor&3" };';
    const col = line.indexOf('Tr0ub4dor') + 1;
    const r = replacementFor('src/a.ts', 'QA_PASSWORD', line, col, 'Tr0ub4dor&3');
    assert.equal(line.slice(0, r.start) + r.text + line.slice(r.end), "const login = { password: (process.env.QA_PASSWORD ?? '') };");
    const env = 'DB_PASSWORD=Q4!zr7Lm-x';
    const r2 = replacementFor('config/qa.env', 'QA_DB_PASSWORD', env, 13, 'Q4!zr7Lm-x');
    assert.equal(env.slice(0, r2.start) + r2.text + env.slice(r2.end), 'DB_PASSWORD={env:QA_DB_PASSWORD}');
});

async function repo(name: string) {
    const dir = path.join(tmp, name);
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    await runGit(['config', 'user.name', 'T'], { cwd: dir });
    await runGit(['config', 'user.email', 't@x.invalid'], { cwd: dir });
    return { dir, git: await GitService.open(dir) };
}

test('fix: move to secret store, then the commit goes through', async () => {
    const { dir, git } = await repo('fix-move');
    const { store } = newStore('fix-move-store');
    fs.mkdirSync(path.join(dir, 'config/qa'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/qa/qa.env'), 'BASE_URL=https://qa.example.invalid\r\nDB_PASSWORD=Q4!zr7Lm-x\r\n');
    await git.stage(['config/qa/qa.env']);
    const r = await git.commit('qa env');
    assert.equal(r.status, 'blocked');
    if (r.status !== 'blocked') return;
    const f = r.findings[0];
    const res = await moveToStore(git, store, f, { name: 'QA_DB_PASSWORD', env: 'qa' });
    assert.equal(res.replacedWith, '{env:QA_DB_PASSWORD}');
    assert.equal(fs.readFileSync(path.join(dir, 'config/qa/qa.env'), 'utf8'), 'BASE_URL=https://qa.example.invalid\r\nDB_PASSWORD={env:QA_DB_PASSWORD}\r\n');
    assert.equal(store.resolve('QA_DB_PASSWORD', { env: 'qa' }), 'Q4!zr7Lm-x');
    assert.equal((await git.commit('qa env')).status, 'ok');
});

test('fix refuses when the working copy differs from what is staged', async () => {
    const { dir, git } = await repo('fix-dirty');
    const { store } = newStore('fix-dirty-store');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const login = { password: "Tr0ub4dor&3" };\n');
    await git.stage(['a.ts']);
    fs.appendFileSync(path.join(dir, 'a.ts'), '// more\n');
    const r = await git.commit('x');
    if (r.status !== 'blocked') return assert.fail('expected blocked');
    await assert.rejects(moveToStore(git, store, r.findings[0], { name: 'QA_PASSWORD' }), /unstaged edits/);
    assert.equal(store.list().length, 0, 'nothing stored when the fix did not apply');
});

test('fix: remove value, ignore file, allowlist', async () => {
    const { dir, git } = await repo('fix-other');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const login = { password: "Tr0ub4dor&3" };\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'X=1\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'const t = { token: "Zz9!abcdefg" };\n');
    await git.stage(['a.ts', '.env.local', 'b.ts']);
    const r = await git.commit('x');
    if (r.status !== 'blocked') return assert.fail('expected blocked');
    assert.equal(r.findings.length, 3);
    const byFile = Object.fromEntries(r.findings.map((f) => [f.file, f]));
    await removeValue(git, byFile['a.ts']);
    assert.equal(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8'), 'const login = { password: "" };\n');
    await ignoreFile(git, '.env.local');
    assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\/\.env\.local$/m);
    await allowlistFinding(git, byFile['b.ts'], 'fake token used by the mock server', 'T');
    const c = await git.commit('x');
    assert.equal(c.status, 'ok', JSON.stringify(c));
    const files = (await runGit(['show', '--name-only', '--format=', 'HEAD'], { cwd: dir })).stdout.trim().split('\n').sort();
    assert.deepEqual(files, ['.cs-studio/secret-allowlist.json', '.gitignore', 'a.ts', 'b.ts']);
});
