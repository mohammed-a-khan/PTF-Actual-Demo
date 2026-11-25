import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { applyPlan, ChangePlan, hashOf, PlanConflictError, reviewPlan, safePath } from '../src/framework/plan';
import { checkPlan } from '../src/framework/standards';
import type { ProjectModel } from '../src/framework/model';
import { extractStepDefs } from '../src/lang/steps';
import { quote, quoted, kebab, pascal } from '../src/framework/text';

const repo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fw-core-'));

test('text: one set of naming and quoting rules', () => {
    assert.equal(pascal('login page'), 'LoginPage');
    assert.equal(kebab('Checkout Flow v2'), 'checkout-flow-v2');
    assert.equal(quote('a "b"'), "'a \"b\"'");
    assert.equal(quote(`a "b" 'c'`), null);
    assert.equal(quoted(`a "b" 'c'`), `"a 'b' 'c'"`);
});

test('review: each file before and after with its diff; nothing is written', async () => {
    const root = repo();
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test/a.feature'), 'Feature: A\n  Scenario: one\n    Given x\n');
    fs.writeFileSync(path.join(root, 'test/same.json'), '{}\n');
    const plan: ChangePlan = { title: 't', warnings: ['look'], files: [
        { path: 'test/a.feature', kind: 'feature', text: 'Feature: A\n  Scenario: one\n    Given y\n' },
        { path: 'test/b.feature', kind: 'feature', text: 'Feature: B\n' },
        { path: 'test/same.json', kind: 'data', text: '{}\n' },
    ] };
    const r = await reviewPlan(root, plan, [{ level: 'warning', rule: 'x', message: 'm' }]);
    const [a, b, same] = r.files;
    assert.equal(a.change, 'update'); assert.equal(a.added, 1); assert.equal(a.removed, 1);
    assert.match(a.diff, /^-    Given x$/m); assert.match(a.diff, /^\+    Given y$/m);
    assert.equal(a.baseHash, hashOf('Feature: A\n  Scenario: one\n    Given x\n'));
    assert.equal(b.change, 'new'); assert.equal(b.before, null); assert.equal(b.baseHash, null); assert.match(b.diff, /^\+Feature: B$/m);
    assert.equal(same.change, 'same'); assert.equal(same.diff, '');
    assert.equal(r.blocked, false); assert.deepEqual(r.warnings, ['look']);
    assert.ok(!fs.existsSync(path.join(root, 'test/b.feature')), 'review writes nothing');
    await assert.rejects(reviewPlan(root, { title: 't', warnings: [], files: [plan.files[1], plan.files[1]] }, []), /planned twice/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('apply: writes, keeps copies of replaced files, refuses files changed since the review and paths outside the repository', async () => {
    const root = repo();
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'test/a.feature'), 'old\n');
    const plan: ChangePlan = { title: 't', warnings: [], files: [{ path: 'test/a.feature', kind: 'feature', text: 'new\n' }, { path: 'test/n/b.json', kind: 'data', text: 'X' }] };
    const r = await reviewPlan(root, plan, []);
    const baseHashes = Object.fromEntries(r.files.map((f) => [f.path, f.baseHash]));
    // Someone edits the file after the review: nothing is written.
    fs.writeFileSync(path.join(root, 'test/a.feature'), 'edited by a person\n');
    assert.throws(() => applyPlan(root, plan, { baseHashes }), (e: unknown) => e instanceof PlanConflictError && e.paths.join() === 'test/a.feature');
    assert.ok(!fs.existsSync(path.join(root, 'test/n/b.json')));
    // A new review, then apply: the replaced file is kept in the recovery folder; a transform runs last.
    const r2 = await reviewPlan(root, plan, []);
    const rec = path.join(root, '.git', 'cs-studio', 'recovery', 'x');
    const out = applyPlan(root, plan, { baseHashes: Object.fromEntries(r2.files.map((f) => [f.path, f.baseHash])), recoveryDir: rec, transform: (f, t) => (f.kind === 'data' ? t.replace('X', 'Y') : t) });
    assert.deepEqual(out.written, [{ path: 'test/a.feature', change: 'update' }, { path: 'test/n/b.json', change: 'new' }]);
    assert.equal(fs.readFileSync(path.join(root, 'test/a.feature'), 'utf8'), 'new\n');
    assert.equal(fs.readFileSync(path.join(root, 'test/n/b.json'), 'utf8'), 'Y');
    assert.equal(fs.readFileSync(path.join(rec, 'test/a.feature'), 'utf8'), 'edited by a person\n');
    // Applying again changes nothing.
    assert.deepEqual(applyPlan(root, plan, { transform: (f, t) => (f.kind === 'data' ? t.replace('X', 'Y') : t) }).unchanged.sort(), ['test/a.feature', 'test/n/b.json']);
    for (const bad of ['../x', '/etc/passwd', '.git/config', 'a/../../x', 'C:/x']) assert.throws(() => safePath(root, bad), /not a file of the repository/);
    fs.rmSync(root, { recursive: true, force: true });
});

const model = (over: Partial<ProjectModel> = {}): ProjectModel => {
    const framework = extractStepDefs(`@CSBDDStepDef('user is working with {string} API')\n@CSBDDStepDef('I send a GET request to {string}')\n@CSBDDStepDef('the response status should be {int}')`, 'node_modules/fw/dist/steps/api.js', true);
    const project = extractStepDefs(`@CSBDDStepDef('the user opens the Login page')`, 'test/shop/steps/login.steps.ts', false);
    const hidden = extractStepDefs(`@CSBDDStepDef('a step in an unloaded folder')`, 'test/shop/other/x.steps.ts', false).map((d) => ({ ...d, notLoaded: true }));
    return {
        project: 'shop', env: 'dev', featureFolder: 'test/shop/features', pagesFolder: 'test/shop/pages', stepsFolder: 'test/shop/steps', dataFolder: 'test/shop/data',
        pages: [], steps: [], files: {}, allSteps: [...framework, ...project, ...hidden], loadedStepFolders: ['test/shop/steps'],
        config: { exists: true, common: { path: 'config/shop/common/common.env', text: '' }, envFile: { path: 'config/shop/environments/dev.env', text: '' }, values: {}, stepPath: null, stepsLoaded: true },
        ...over,
    };
};
const rules = (fs2: ReturnType<typeof checkPlan>) => fs2.map((f) => `${f.level}:${f.rule}${f.line ? `@${f.line}` : ''}`);

test('standards: every feature line has a definition the project loads (data-driven lines too, and steps the same plan adds)', () => {
    const feature = `@api\nFeature: Orders\n  Scenario Outline: get - <id>\n    Given user is working with "Shop" API\n    When I send a GET request to "/orders/<id>"\n    Then the response status should be <status>\n    And the user checks the order total\n    And a step in an unloaded folder\n    Examples: {"type": "json", "source": "x.json"}\n`;
    let f = checkPlan(ts, { title: '', warnings: [], files: [{ path: 'test/shop/features/orders.feature', kind: 'feature', text: feature }] }, model());
    assert.deepEqual(rules(f), ['error:undefined-step@7', 'error:step-not-loaded@8']);
    assert.match(f[1].message, /test\/shop\/other\/x\.steps\.ts/);
    // The same plan adds the missing definition, in a loaded folder: defined.
    const steps = { path: 'test/shop/steps/orders.steps.ts', kind: 'steps' as const, text: `@CSBDDStepDef('the user checks the order total')` };
    f = checkPlan(ts, { title: '', warnings: [], files: [{ path: 'test/shop/features/orders.feature', kind: 'feature', text: feature.replace('    And a step in an unloaded folder\n', '') }, steps] }, model());
    assert.deepEqual(rules(f), []);
    // In a folder the framework does not load: reported, unless the plan adds it to STEP_DEFINITIONS_PATH.
    const elsewhere = { ...steps, path: 'test/shop/more/orders.steps.ts' };
    f = checkPlan(ts, { title: '', warnings: [], files: [elsewhere] }, model());
    assert.deepEqual(rules(f), ['error:steps-folder-not-loaded']);
    f = checkPlan(ts, { title: '', warnings: [], files: [elsewhere, { path: 'config/shop/common/common.env', kind: 'config', text: 'STEP_DEFINITIONS_PATH=test/shop/more;test/shop/steps\n' }] }, model());
    assert.deepEqual(rules(f), []);
    // Empty feature.
    assert.deepEqual(rules(checkPlan(ts, { title: '', warnings: [], files: [{ path: 'test/shop/features/e.feature', kind: 'feature', text: 'Feature: E\n' }] }, model())), ['error:empty-feature']);
});

test('standards: duplicates, secrets, readable passwords, addresses, names, data, fragile locators', () => {
    const page = `import { CSBasePage, CSPage, CSGetElement } from 'fw/core';
@CSPage('cart')
export class Cart extends CSBasePage {
    @CSGetElement({ css: '#total', description: 'Total' })
    public total!: CSWebElement;
    @CSGetElement({ css: 'ul > li:nth-child(3) > a', description: 'Third' })
    public third!: CSWebElement;
    @CSGetElement({ css: '.css-1x2y3z4 button', description: 'Gen' })
    public gen!: CSWebElement;
    public async open() { await this.navigate('https://shop.example.com/cart'); }
}`;
    const f = checkPlan(ts, { title: '', warnings: [], files: [
        { path: 'test/shop/steps/dup.steps.ts', kind: 'steps', text: `@CSBDDStepDef('the user opens the Login page')\n@CSBDDStepDef('fresh step')` },
        { path: 'test/shop/steps/helpers.ts', kind: 'steps', text: '' },
        { path: 'test/shop/data/login.json', kind: 'data', text: JSON.stringify({ data: [{ user: 'a', password: 'hunter2', pin: 'ENCRYPTED:abc', token: '{env:TOKEN}' }] }, null, 2) },
        { path: 'test/shop/data/bad.json', kind: 'data', text: '{ nope' },
        { path: 'config/shop/environments/dev.env', kind: 'config', text: 'BASE_URL=https://x\nDB_PASSWORD=plain\nAPI_KEY={env:K}\n' },
        { path: 'test/shop/features/Checkout Flow.feature', kind: 'feature', text: 'Feature: C\n  Scenario: s\n    Given I send a GET request to "https://shop.example.com/x"\n    # Given I send a GET request to "https://comment.example.com"\n' },
        { path: 'test/shop/pages/CartPage.ts', kind: 'page', text: page },
        { path: 'test/shop/data/notes.json', kind: 'data', text: '{"note": "the key is S3cr3t-Value-9"}' },
    ] }, model(), { secretValues: ['S3cr3t-Value-9', 'abc'] });
    const r = rules(f);
    for (const want of ['warning:duplicate-step@1', 'error:naming', 'warning:plain-password@5', 'error:invalid-data', 'warning:plain-password@2', 'warning:naming', 'warning:hard-coded-url@3', 'warning:hard-coded-url@10', 'warning:fragile-locator@7', 'warning:fragile-locator@9', 'error:secret-in-file@1']) assert.ok(r.includes(want), `${want} in ${r.join(', ')}`);
    assert.equal(r.filter((x) => x.startsWith('warning:plain-password')).length, 2, 'ENCRYPTED: and {env:} values are fine');
    assert.equal(r.filter((x) => x.startsWith('warning:hard-coded-url')).length, 2, 'commented lines are not checked');
    assert.ok(!r.some((x) => x.startsWith('warning:fragile-locator@5')), '#total is fine');
    assert.equal(r.filter((x) => x === 'warning:naming').length, 3, 'feature name, Page suffix, file name');
    assert.ok(f.findIndex((x) => x.level === 'error') < f.findIndex((x) => x.level === 'warning'), 'errors first');
});

test('standards: only what the change adds is reported (lines the file already had are not its problem)', () => {
    const before: Record<string, string> = { 'config/shop/environments/dev.env': 'BASE_URL=https://x\nADMIN_PASSWORD=old-plain\n', 'test/shop/data/d.json': '{"data":[{"password":"kept"}]}' };
    const f = checkPlan(ts, { title: '', warnings: [], files: [
        { path: 'config/shop/environments/dev.env', kind: 'config', text: 'BASE_URL=https://x\nADMIN_PASSWORD=old-plain\nNEW_SECRET=fresh-plain\n' },
        { path: 'test/shop/data/d.json', kind: 'data', text: JSON.stringify({ data: [{ password: 'kept' }, { password: 'added' }] }, null, 2) },
        { path: 'test/shop/data/s.json', kind: 'data', text: '{"note": "old S3cr3t-Value-9"}' },
    ] }, model(), { secretValues: ['S3cr3t-Value-9'], before: (p) => before[p] ?? (p === 'test/shop/data/s.json' ? '{"note": "old S3cr3t-Value-9"}' : null) });
    assert.deepEqual(rules(f), ['warning:plain-password@3', 'warning:plain-password@7', 'warning:secret-in-file@1']);
    assert.match(f.find((x) => x.rule === 'secret-in-file')!.message, /already holds/);
});

test('standards: a project configuration that sets STEP_DEFINITIONS_PATH replaces what is loaded (steps it drops are not loaded)', () => {
    const shared = extractStepDefs(`@CSBDDStepDef('a shared step')`, 'test/common/steps/shared.steps.ts', false);
    const m = model({ allSteps: [...model().allSteps, ...shared], loadedStepFolders: ['test/shop/steps', 'test/common/steps'] });
    const feature = { path: 'test/shop/features/x.feature', kind: 'feature' as const, text: 'Feature: X\n  Scenario: s\n    Given a shared step\n' };
    assert.deepEqual(rules(checkPlan(ts, { title: '', warnings: [], files: [feature] }, m)), []);
    const cfg = { path: 'config/shop/common/common.env', kind: 'config' as const, text: 'STEP_DEFINITIONS_PATH=test/shop/steps;node_modules/fw/dist/steps\n' };
    assert.deepEqual(rules(checkPlan(ts, { title: '', warnings: [], files: [feature, cfg] }, m)), ['error:step-not-loaded@3']);
    // {project} in the value is the project.
    const cfg2 = { ...cfg, text: 'STEP_DEFINITIONS_PATH=test/common/steps;test/{project}/steps\n' };
    assert.deepEqual(rules(checkPlan(ts, { title: '', warnings: [], files: [feature, cfg2] }, m)), []);
});

test('standards: a locator inside a labelled group is not "a long chain" (text in Playwright parts is not CSS)', () => {
    const page = `import { CSBasePage, CSPage, CSGetElement } from 'fw/core';
@CSPage('users')
export class UsersPage extends CSBasePage {
    @CSGetElement({ css: 'div.oxd-input-group >> internal:has-text="User Role"i >> internal:text="-- Select --"i', description: 'User Role' })
    public userRole!: CSWebElement;
    @CSGetElement({ css: '#app > div > div > div > div > div > span', description: 'Deep' })
    public deep!: CSWebElement;
    @CSGetElement({ css: 'internal:role=row[name="Smith"i] >> :scope > * >> nth=2', description: 'Smith column 3 cell' })
    public smithEmail!: CSWebElement;
    @CSGetElement({ css: 'table tr >> nth=2', description: 'Third row' })
    public thirdRow!: CSWebElement;
}`;
    const f = checkPlan(ts, { title: '', warnings: [], files: [{ path: 'test/shop/pages/UsersPage.ts', kind: 'page', text: page }] }, model());
    // A cell found by its row's text and its column is not "by position"; the third row is.
    assert.deepEqual(f.filter((x) => x.rule === 'fragile-locator').map((x) => x.message.split(' is found')[0]), ['deep', 'thirdRow']);
    // Another project's step with the same words is not a duplicate (this project does not load it).
    const other = extractStepDefs(`@CSBDDStepDef('the user opens the Home page')`, 'test/other/steps/a.steps.ts', false).map((d) => ({ ...d, notLoaded: true }));
    const g = checkPlan(ts, { title: '', warnings: [], files: [{ path: 'test/shop/steps/home.steps.ts', kind: 'steps', text: `@CSBDDStepDef('the user opens the Home page')` }] }, model({ allSteps: [...model().allSteps, ...other] }));
    assert.deepEqual(rules(g), []);
});
