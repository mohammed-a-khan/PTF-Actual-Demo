/**
 * Code screen: search & replace (shared matcher, scopes, ignored folders), go to definition / find
 * usages through the language service (page classes, framework packages, Windows path spellings).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { expandReplacement, globFilter, inScope, isExcluded, matcher, matchesIn, normalizeRel, replaceIn } from '../src/workspace/textSearch';
import { fileKey, repoPathOf, TsService } from '../src/lang/tsService';

test('search matcher: case, whole word, regex, per line; CRLF line ends kept', () => {
    const t = 'const usernameField = 1;\r\nthis.usernameField.fill(x); // UsernameField\r\nusernameFieldX\n';
    assert.equal(matchesIn(t, matcher({ q: 'usernameField' })).length, 4);
    assert.equal(matchesIn(t, matcher({ q: 'usernameField', caseSensitive: true })).length, 3);
    assert.equal(matchesIn(t, matcher({ q: 'usernameField', caseSensitive: true, wholeWord: true })).length, 2);
    const m = matchesIn(t, matcher({ q: 'fill' }));
    assert.deepEqual(m.map((x) => [x.line, x.column, x.length]), [[2, 20, 4]]);
    assert.equal(m[0].text, 'this.usernameField.fill(x); // UsernameField', 'no \\r in the line shown');
    assert.equal(matchesIn('a$b', matcher({ q: '$b', wholeWord: true })).length, 0, '$ is part of a word in JavaScript');
    assert.throws(() => matcher({ q: '(', regex: true }), /Not a valid regular expression/);
    // Empty matches find nothing (and do not loop).
    assert.equal(matchesIn('abc\n', matcher({ q: 'x*', regex: true })).length, 0);
    assert.equal(matchesIn('ab\n', matcher({ q: '^', regex: true })).length, 0);
});

test('replace: groups with regex, text as typed without, one match only, line ends kept', () => {
    const t = 'await this.loginPage.enterUsername(a);\r\nawait this.loginPage.enterPassword(b);\r\n';
    const r = replaceIn(t, { q: 'loginPage\\.enter(\\w+)', regex: true, caseSensitive: true }, 'signIn.type$1');
    assert.equal(r.count, 2);
    assert.equal(r.text, 'await this.signIn.typeUsername(a);\r\nawait this.signIn.typePassword(b);\r\n');
    // Without regex, "$1" is just text.
    assert.equal(replaceIn('a.b a.b', { q: 'a.b' }, '$1').text, '$1 $1');
    assert.equal(replaceIn('axb', { q: 'a.b' }, 'z').count, 0, 'the dot is a dot');
    // Case-insensitive, whole word.
    assert.equal(replaceIn('Page page pages', { q: 'page', wholeWord: true }, 'screen').text, 'screen screen pages');
    // Only the match at a line and column.
    assert.deepEqual(replaceIn('x x\nx', { q: 'x' }, 'y', { line: 1, column: 3 }), { text: 'x y\nx', count: 1 });
    // Named groups, $& and $$.
    const m = /(?<first>\w+) (\w+)/.exec('hello world')!;
    assert.equal(expandReplacement(m, '$<first>|$2|$&|$$|$9', true), 'hello|world|hello world|$|$9');
    // Nothing found: the same text back (not re-joined).
    const same = 'a\r\nb';
    assert.equal(replaceIn(same, { q: 'zz' }, 'y').text, same);
});

test('scope, "Only in" and the folders left out by default; Windows spellings of paths', () => {
    assert.equal(normalizeRel('test\\weblab\\'), 'test/weblab');
    assert.equal(normalizeRel('./test//a.ts'), 'test/a.ts');
    for (const p of ['.debug-build/test/a.js', 'dist/x.js', 'node_modules/p/index.d.ts', 'reports/r.json', 'test-results/x.txt', 'sub/dist/y.js'])
        assert.equal(isExcluded(p), true, p);
    for (const p of ['test/dist.feature', 'src/reports.ts', 'distance/a.ts']) assert.equal(isExcluded(p), false, p);
    const only = globFilter('*.feature, test\\weblab\\steps\\, !**/old/**');
    assert.equal(only('test/a/b.feature'), true);
    assert.equal(only('test/weblab/steps/shop.steps.ts'), true);
    assert.equal(only('test/weblab/pages/LoginPage.ts'), false);
    assert.equal(only('test/old/b.feature'), false);
    assert.equal(globFilter('test/**/*.ts')('test/a/b/c.ts'), true);
    assert.equal(globFilter('test/**/*.ts')('src/c.ts'), false);
    assert.equal(globFilter('')('anything'), true);
    assert.equal(inScope('test/weblab/a.ts', { folder: 'test\\weblab' }), true);
    assert.equal(inScope('test/weblab2/a.ts', { folder: 'test/weblab' }), false);
    assert.equal(inScope('test/weblab/a.ts', { file: 'test\\weblab\\a.ts' }), true);
});

test('language service file names on Windows: one key for every spelling, repository paths with "/"', () => {
    const w = path.win32;
    // TypeScript's spelling, the Studio's, and a drive letter / folder in another case: one file.
    const k = fileKey('C:\\Users\\Me\\Repo\\test\\pages\\LoginPage.ts', false, w);
    assert.equal(fileKey('C:/Users/Me/Repo/test/pages/LoginPage.ts', false, w), k);
    assert.equal(fileKey('c:\\users\\me\\repo\\TEST\\pages\\loginpage.ts', false, w), k);
    assert.notEqual(fileKey('/r/A.ts', true, path.posix), fileKey('/r/a.ts', true, path.posix), 'Linux: case matters');
    const root = 'C:\\Users\\Me\\Repo';
    assert.equal(repoPathOf(root, 'C:/Users/Me/Repo/test/pages/LoginPage.ts', false, w), 'test/pages/LoginPage.ts');
    assert.equal(repoPathOf(root, 'c:/users/me/repo/test/steps/a.steps.ts', false, w), 'test/steps/a.steps.ts');
    assert.equal(repoPathOf('c:\\users\\me\\repo', 'C:/Users/Me/Repo/node_modules/@scope/fw/dist/x.d.ts', false, w), 'node_modules/@scope/fw/dist/x.d.ts');
    // A package installed as a link (npm link / a junction): shown under node_modules, not outside the project.
    const links: Array<[string, string]> = [['D:\\work\\framework', 'C:\\Users\\Me\\Repo\\node_modules\\@mdakhan.mak\\cs-playwright-test-framework']];
    assert.equal(repoPathOf(root, 'D:/work/framework/dist/core/CSBasePage.d.ts', false, w, links), 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/core/CSBasePage.d.ts');
    assert.equal(repoPathOf(root, 'd:/WORK/framework/dist/lib/bdd.d.ts', false, w, links), 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/lib/bdd.d.ts');
    assert.match(repoPathOf(root, 'E:/elsewhere/a.d.ts', false, w, links), /^\.\.\//);
    // macOS (case-insensitive, posix paths): a case-only difference in the root.
    assert.equal(repoPathOf('/Users/me/Repo', '/users/me/repo/test/a.ts', false, path.posix), 'test/a.ts');
});

/** A framework project: a page class with @CSGetElement fields and methods, a step file calling them, a framework package with "exports" only. */
function frameworkLab(opts: { moduleResolution: string; crlf?: boolean; linkFramework?: boolean }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nav-'));
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), opts.crlf ? t.replace(/\n/g, '\r\n') : t); };
    w('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'commonjs', moduleResolution: opts.moduleResolution, strict: true, experimentalDecorators: true, emitDecoratorMetadata: true, skipLibCheck: true, baseUrl: '.', paths: { '*': ['node_modules/*'] } }, include: ['test/**/*'] }));
    const fwDir = opts.linkFramework ? fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fw-')) : path.join(root, 'node_modules/@acme/fw');
    const fw = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(fwDir, f)), { recursive: true }); fs.writeFileSync(path.join(fwDir, f), t); };
    fw('package.json', JSON.stringify({ name: '@acme/fw', version: '1.0.0', exports: { './core': { types: './dist/lib/core.d.ts', default: './dist/lib/core.js' }, './bdd': { types: './dist/lib/bdd.d.ts', default: './dist/lib/bdd.js' } } }));
    fw('dist/lib/core.d.ts', "export { CSBasePage } from '../core/CSBasePage';\nexport declare function CSGetElement(o: { xpath: string; description?: string }): (t: any, k: any) => void;\nexport declare class CSWebElement { fill(v: string): Promise<void>; click(): Promise<void>; }\n");
    fw('dist/core/CSBasePage.d.ts', 'export declare abstract class CSBasePage {\n    /** Go to the page. */\n    navigate(url?: string): Promise<void>;\n    protected abstract initializeElements(): void;\n}\n');
    fw('dist/lib/bdd.d.ts', 'export declare function CSBDDStepDef(p: string): (t: any, k: any, d: PropertyDescriptor) => void;\nexport declare function Page(name: string): (t: any, k: any) => void;\nexport declare function StepDefinitions(c: any): any;\n');
    if (opts.linkFramework) { fs.mkdirSync(path.join(root, 'node_modules/@acme'), { recursive: true }); fs.symlinkSync(fwDir, path.join(root, 'node_modules/@acme/fw'), 'dir'); }
    w('test/shop/pages/LoginPage.ts', [
        "import { CSBasePage, CSGetElement, CSWebElement } from '@acme/fw/core';",
        '',
        'export class LoginPage extends CSBasePage {',
        "    @CSGetElement({ xpath: '//input[@name=\"username\"]', description: 'Username' })",
        '    public usernameField!: CSWebElement;',
        '',
        '    protected initializeElements(): void {}',
        '',
        '    public async enterUsername(name: string): Promise<void> {',
        '        await this.usernameField.fill(name);',
        '    }',
        '}',
        ''].join('\n'));
    const steps = [
        "import { CSBDDStepDef, Page, StepDefinitions } from '@acme/fw/bdd';",
        "import { LoginPage } from '../pages/LoginPage';",
        '',
        '@StepDefinitions',
        'export class LoginSteps {',
        "    @Page('login')",
        '    private loginPage!: LoginPage;',
        '',
        "    @CSBDDStepDef('I log in as {string}')",
        '    async logIn(user: string) {',
        '        await this.loginPage.navigate();',
        '        await this.loginPage.enterUsername(user);',
        '        await this.loginPage.usernameField.click();',
        '    }',
        '}',
        ''].join('\n');
    w('test/shop/steps/login.steps.ts', steps);
    return { root, steps, fwDir, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); if (opts.linkFramework) fs.rmSync(fwDir, { recursive: true, force: true }); } };
}

test('go to definition: a page method in another file, framework classes from a package with "exports" only (moduleResolution node)', () => {
    const lab = frameworkLab({ moduleResolution: 'node' });
    try {
        const svc = new TsService(lab.root);
        const f = path.join(lab.root, 'test/shop/steps/login.steps.ts');
        svc.update(f, lab.steps);
        const at = (s: string) => lab.steps.indexOf(s) + 2;
        assert.deepEqual(svc.definition(f, at('enterUsername(user)')).map((d) => `${d.path}:${d.line}`), ['test/shop/pages/LoginPage.ts:9']);
        assert.deepEqual(svc.definition(f, at('usernameField.click')).map((d) => `${d.path}:${d.line}`), ['test/shop/pages/LoginPage.ts:5']);
        // Inherited from the framework's base class: into its .d.ts (the old "node" resolution ignores "exports").
        assert.deepEqual(svc.definition(f, at('navigate()')).map((d) => `${d.path}:${d.line}`), ['node_modules/@acme/fw/dist/core/CSBasePage.d.ts:3']);
        assert.deepEqual(svc.definition(f, at('click()')).map((d) => d.path), ['node_modules/@acme/fw/dist/lib/core.d.ts']);
        // No "cannot find module" for the framework's entry points.
        assert.deepEqual(svc.diagnostics(f).filter((d) => d.code === 2307), []);
        // Usages of a page element across the project: the declaration, its use in the page and in the step.
        const refs = svc.references(f, at('usernameField.click'));
        assert.deepEqual(refs.map((r) => `${r.path}:${r.line}${r.definition ? ' (definition)' : ''}`), ['test/shop/pages/LoginPage.ts:5 (definition)', 'test/shop/pages/LoginPage.ts:10', 'test/shop/steps/login.steps.ts:13']);
        assert.equal(refs[2].text, 'await this.loginPage.usernameField.click();');
        // A method: declared in the page, called from the step.
        assert.deepEqual(svc.references(f, at('enterUsername(user)')).map((r) => `${r.path}:${r.line}`), ['test/shop/pages/LoginPage.ts:9', 'test/shop/steps/login.steps.ts:12']);
    } finally { lab.cleanup(); }
});

test('go to definition follows the editor text when the file on disk has Windows line ends (CRLF)', () => {
    const lab = frameworkLab({ moduleResolution: 'node16', crlf: true });
    try {
        const svc = new TsService(lab.root);
        const f = path.join(lab.root, 'test/shop/steps/login.steps.ts');
        // The editor sends "\n" text; offsets are in that text (the file on disk has "\r\n").
        svc.update(f, lab.steps);
        const off = lab.steps.indexOf('enterUsername(user)') + 3;
        assert.deepEqual(svc.definition(f, off).map((d) => `${d.path}:${d.line}:${d.column}`), ['test/shop/pages/LoginPage.ts:9:18']);
        // Another spelling of the same file (as TypeScript writes names, with "/"): the same unsaved text.
        svc.update(f.split(path.sep).join('/'), lab.steps + '\n// more');
        assert.equal(svc.definition(f, off).length, 1);
        assert.match(svc.quickInfo(f, off)!.text, /enterUsername\(name: string\): Promise<void>/);
    } finally { lab.cleanup(); }
});

test('a framework package installed as a link (npm link) opens under node_modules/', { skip: process.platform === 'win32' ? 'symlinks need rights on Windows' : false }, () => {
    const lab = frameworkLab({ moduleResolution: 'node16', linkFramework: true });
    try {
        const svc = new TsService(lab.root);
        const f = path.join(lab.root, 'test/shop/steps/login.steps.ts');
        svc.update(f, lab.steps);
        const d = svc.definition(f, lab.steps.indexOf('navigate()') + 2);
        assert.equal(d.length, 1);
        assert.equal(d[0].path.startsWith('..'), false, d[0].path);
        assert.match(d[0].path, /^node_modules\/@acme\/fw\/dist\/core\/CSBasePage\.d\.ts$/);
    } finally { lab.cleanup(); }
});

test('server: search with scopes and ignored folders; usages in a step body are TypeScript usages; library files read-only', async () => {
    const { createServer } = await import('../src/server/server');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const lab = frameworkLab({ moduleResolution: 'node' });
    const dir = lab.root;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nav-home-'));
    const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
    w('config/shop/common/common.env', 'PROJECT=shop\nSTEP_DEFINITIONS_PATH=test/shop/steps\n');
    w('config/shop/environments/dev.env', 'BASE_URL=http://localhost\n');
    w('test/shop/features/login.feature', 'Feature: Login\n  Scenario: a\n    Given I log in as "admin"\n');
    w('.gitignore', 'node_modules\nreports\nscratch/\n');
    w('.debug-build/test/shop/steps/login.steps.js', 'this.loginPage.enterUsername(user);\n');
    w('reports/run/log.txt', 'enterUsername\n');
    w('scratch/notes.txt', 'enterUsername here\n');
    w('test/shop/data/users.txt', 'enterUsername\r\nenterUsername twice: enterUsername\r\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['add', '-f', '.debug-build'], { cwd: dir });
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 't', home });
    const { url } = await srv.listen(0);
    const base = new URL(url).origin;
    const H = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };
    const post = async (p: string, b: unknown) => { const x = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: x.status, body: await x.json() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const get = async (p: string) => { const x = await fetch(base + p, { headers: H }); return { status: x.status, body: await x.json() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
        // Whole project: build output, reports and ignored files are left out.
        const all = await get('/api/search/text?q=enterUsername&case=true');
        assert.equal(all.status, 200, JSON.stringify(all.body));
        assert.deepEqual(all.body.files.map((f: { path: string; count: number }) => `${f.path}:${f.count}`), ['test/shop/data/users.txt:3', 'test/shop/pages/LoginPage.ts:1', 'test/shop/steps/login.steps.ts:1']);
        assert.equal(all.body.total, 5);
        // ... unless asked for.
        const ign = await get('/api/search/text?q=enterUsername&case=true&ignored=true');
        const ignPaths = ign.body.files.map((f: { path: string }) => f.path);
        for (const p of ['.debug-build/test/shop/steps/login.steps.js', 'reports/run/log.txt', 'scratch/notes.txt']) assert.ok(ignPaths.includes(p), `${p} in ${ignPaths}`);
        // A folder (Windows spelling accepted), one file, "Only in".
        assert.deepEqual((await get('/api/search/text?q=enterUsername&folder=' + encodeURIComponent('test\\shop\\pages'))).body.files.map((f: { path: string }) => f.path), ['test/shop/pages/LoginPage.ts']);
        assert.deepEqual((await get('/api/search/text?q=enterUsername&file=test/shop/data/users.txt')).body.hits.map((h: { line: number; column: number; length: number }) => [h.line, h.column, h.length]), [[1, 1, 13], [2, 1, 13], [2, 22, 13]]);
        assert.deepEqual((await get('/api/search/text?q=enterUsername&glob=*.ts')).body.files.map((f: { path: string }) => f.path), ['test/shop/pages/LoginPage.ts', 'test/shop/steps/login.steps.ts']);
        // The older address (other screens): the results as a list.
        const old = await get('/api/search?q=log%20in&glob=*.feature');
        assert.ok(Array.isArray(old.body));
        assert.deepEqual(old.body.map((h: { path: string; line: number }) => `${h.path}:${h.line}`), ['test/shop/features/login.feature:3']);
        assert.match((await get('/api/search/text?q=(&regex=true')).body.error, /Not a valid regular expression/);

        // Usages: on the decorator a step's feature usages; in the method body the symbol's references.
        const at = (s: string) => lab.steps.indexOf(s) + 2;
        const step = await post('/api/lang/step-usages', { path: 'test/shop/steps/login.steps.ts', content: lab.steps, offset: at("@CSBDDStepDef('I log in") });
        assert.equal(step.status, 200, JSON.stringify(step.body));
        assert.deepEqual(step.body.usages.map((u: { path: string; line: number }) => `${u.path}:${u.line}`), ['test/shop/features/login.feature:3']);
        const inBody = await post('/api/lang/step-usages', { path: 'test/shop/steps/login.steps.ts', content: lab.steps, offset: at('enterUsername(user)') });
        assert.equal(inBody.status, 400, 'not a step: the editor asks TypeScript instead');
        const refs = await post('/api/lang/references', { path: 'test/shop/steps/login.steps.ts', content: lab.steps, offset: at('enterUsername(user)') });
        assert.deepEqual(refs.body.locations.map((l: { path: string; line: number; definition?: boolean }) => `${l.path}:${l.line}${l.definition ? '*' : ''}`), ['test/shop/pages/LoginPage.ts:9*', 'test/shop/steps/login.steps.ts:12']);

        // Go to definition into the framework; that file can then be read (read-only), others under node_modules cannot.
        const def = await post('/api/lang/definition', { path: 'test/shop/steps/login.steps.ts', content: lab.steps, offset: at('navigate()') });
        assert.equal(def.body.locations[0].path, 'node_modules/@acme/fw/dist/core/CSBasePage.d.ts');
        const lib = await get('/api/file/library?path=' + encodeURIComponent('node_modules/@acme/fw/dist/core/CSBasePage.d.ts'));
        assert.equal(lib.status, 200, JSON.stringify(lib.body));
        assert.equal(lib.body.readOnly, true);
        assert.match(lib.body.content, /navigate\(url\?: string\)/);
        assert.equal((await get('/api/file/library?path=' + encodeURIComponent('node_modules/@acme/fw/package.json'))).status, 400);
    } finally {
        await srv.app.close();
        lab.cleanup();
        fs.rmSync(home, { recursive: true, force: true });
    }
});
