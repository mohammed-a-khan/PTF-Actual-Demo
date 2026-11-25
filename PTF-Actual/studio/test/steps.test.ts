import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkFeature, definitionFor, extractStepDefs, featureSteps, patternToRegex, projectOfFeature, alwaysLoadedGroups, isInside, StepIndex, stepFolders, stepSnippet, tableCells } from '../src/lang/steps';

test('pattern conversion matches the framework', () => {
    const r = patternToRegex('I enter {string} into the {string} field');
    assert.ok(r.test('I enter "bob" into the "Username" field'));
    assert.ok(r.test("I enter 'bob' into the 'Username' field"));
    assert.ok(!r.test('I enter bob into the "Username" field'));
    assert.ok(patternToRegex('I wait {int} seconds').test('I wait 5 seconds'));
    assert.ok(!patternToRegex('I wait {int} seconds').test('I wait five seconds'));
    assert.ok(patternToRegex('price is {float} (incl. tax)').test('price is 12.50 (incl. tax)'), 'regex characters are literal');
    assert.ok(patternToRegex('I open {word} page').test('I open orders page'));
    assert.ok(!patternToRegex('I click {string}').test('I click "Save" now'), 'whole-step match');
});

test('extract definitions from TypeScript and compiled JavaScript', () => {
    const ts = `export class S {\n  @CSBDDStepDef('I open order {string}')\n  async a() {}\n  @CSBDDStepDef("it\\'s \\"quoted\\"")\n  async b() {}\n  @CSBDDStepDef(\`I see \${x}\`)\n  async c() {}\n}`;
    const d = extractStepDefs(ts, 'steps.ts', false);
    assert.deepEqual(d.map((x) => [x.pattern, x.line]), [['I open order {string}', 2], [`it's "quoted"`, 4]]);
    const js = `__decorate([(0, CSStepRegistry_1.CSBDDStepDef)('user navigates to {string}'), __metadata("design:type", Function)], X.prototype, "nav", null);`;
    assert.deepEqual(extractStepDefs(js, 'x.js', true).map((x) => x.pattern), ['user navigates to {string}']);
});

test('feature steps, outline substitution, problems, definitions', () => {
    const defs = [
        ...extractStepDefs(`@CSBDDStepDef('I log in as {string}')\n@CSBDDStepDef('I see {int} orders')\n@CSBDDStepDef('I see {int} orders')`, 'a.ts', false),
    ];
    const feat = [
        'Feature: Orders',
        '  Scenario Outline: list',
        '    Given I log in as "<user>"',
        '    Then I see <count> orders',
        '    And I fly away',
        '    """',
        '    Given not a step',
        '    """',
        '    Examples:',
        '      | user | count |',
        '      | bob  | 3     |',
    ].join('\n');
    const steps = featureSteps(feat);
    assert.deepEqual(steps.map((s) => s.resolvedText), ['I log in as "bob"', 'I see 3 orders', 'I fly away']);
    const probs = checkFeature(feat, defs);
    assert.deepEqual(probs.map((p) => [p.line, p.severity]), [[4, 'info'], [5, 'error']]);
    assert.equal(probs[1].column, 9);
    assert.equal(definitionFor(feat, 3, defs)?.line, 1);
    assert.equal(definitionFor(feat, 5, defs), null);
    assert.equal(stepSnippet('I enter {string} and wait {int}'), 'I enter "" and wait 1');
});

test('index scans the project and the installed framework package', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-steps-'));
    fs.mkdirSync(path.join(root, 'test/common/steps'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test/common/steps/a.steps.ts'), `@CSBDDStepDef('I open order {string}')`);
    const pkg = path.join(root, 'node_modules/@mdakhan.mak/cs-playwright-test-framework');
    fs.mkdirSync(path.join(pkg, 'dist/steps'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(pkg, f)), { recursive: true }); fs.writeFileSync(path.join(pkg, f), t); };
    w('dist/steps/common/CSNavSteps.js', `(0, r.CSBDDStepDef)('user navigates to {string}')`);
    w('dist/steps/ai/CSAISteps.js', `(0, r.CSBDDStepDef)('AI {string}')`);
    w('dist/steps/auth/CSSSOSteps.js', `(0, r.CSBDDStepDef)('I log in with SSO')`); // always loaded (1.54)
    w('dist/steps/accessibility/CSA11ySteps.js', `(0, r.CSBDDStepDef)('the page is accessible')`); // not a loaded group
    w('dist/steps/common/helpers.js', `(0, r.CSBDDStepDef)('helper')`); // not a step file name
    fs.mkdirSync(path.join(root, 'node_modules/other'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/other/x.js'), `CSBDDStepDef('not scanned')`);
    const names = (all: ReturnType<StepIndex['all']>) => all.filter((d) => !d.notLoaded).map((d) => [d.pattern, d.builtIn]);
    // Without the framework in STEP_DEFINITIONS_PATH only the always-loaded groups (ai, auth, report-validation) count.
    assert.deepEqual(names(new StepIndex(root).all()), [['I open order {string}', false], ['AI {string}', true], ['I log in with SSO', true]]);
    const fw = 'test/common/steps;node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/steps';
    assert.deepEqual(names(new StepIndex(root, () => [{ value: fw }]).all()), [['I open order {string}', false], ['AI {string}', true], ['I log in with SSO', true], ['user navigates to {string}', true]]);
    fs.rmSync(root, { recursive: true, force: true });
});

test('Cucumber-style decorators (Given/When/Then/And/But/Step) are step definitions too', () => {
    const defs = extractStepDefs(`class S {\n  @Given('I am on the {string} page')\n  a() {}\n  @When("I click {string}") b() {}\n  @Then(\`I see {int} rows\`) c() {}\n  @And('x') d() {}\n  @But('y') e() {}\n  @Step('z') f() {}\n  @defineStep('w') g() {}\n  Given('not a decorator')\n}`, 'a.steps.ts', false);
    assert.deepEqual(defs.map((d) => [d.pattern, d.line]), [['I am on the {string} page', 2], ['I click {string}', 4], ['I see {int} rows', 5], ['x', 6], ['y', 7], ['z', 8], ['w', 9]]);
});

test('a feature is checked against its own project\'s steps only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-steps-'));
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    w('test/shop/steps/a.steps.ts', `@CSBDDStepDef('I log in')`);
    w('test/perf/steps/b.steps.ts', `@CSBDDStepDef('I log in')`);
    const idx = new StepIndex(root, () => [{ project: 'shop', value: 'test/shop/steps' }, { project: 'perf', value: 'test/perf/steps' }]);
    const loaded = (p?: string) => idx.all(p).filter((d) => !d.notLoaded).map((d) => d.file);
    assert.deepEqual(loaded('shop'), ['test/shop/steps/a.steps.ts']);
    assert.deepEqual(loaded('perf'), ['test/perf/steps/b.steps.ts']);
    assert.equal(checkFeature('Feature: f\n  Scenario: s\n    Given I log in\n', idx.all('shop')).length, 0);
    assert.equal(projectOfFeature('test/shop/features/a.feature', ['shop', 'perf']), 'shop');
    assert.equal(projectOfFeature('test/examples/a.feature', ['shop', 'perf']), undefined);
    fs.rmSync(root, { recursive: true, force: true });
});

test('index follows STEP_DEFINITIONS_PATH and the framework file rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-steps-'));
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    w('test/orders/steps/order.steps.ts', `@CSBDDStepDef('I open the orders page')`);
    w('test/orders/steps/order.steps.js', `CSBDDStepDef('I open the orders page')`); // compiled copy: one entry
    w('test/orders/steps/helper.ts', `// mentions CSBDDStepDef('helper is not a step file')`);
    w('test/orders/steps/x.spec.steps.ts', `@CSBDDStepDef('spec file')`);
    w('test/orders/steps/LoginSteps.ts', `// @CSBDDStepDef('commented out')\n/* @CSBDDStepDef('also commented') */\n@CSBDDStepDef('I log in // really')`);
    w('dist/test/orders/steps/order.steps.js', `CSBDDStepDef('build output')`);
    w('custom/steps/extra.step.ts', `@CSBDDStepDef('custom folder step')`);
    const patterns = (cfg: Array<{ project?: string; value: string }>) => new StepIndex(root, () => cfg).all().filter((d) => !d.notLoaded).map((d) => d.pattern).sort();
    assert.deepEqual(patterns([]), ['I log in // really', 'I open the orders page']);
    assert.deepEqual(patterns([{ project: 'orders', value: 'custom/steps;test/{project}/steps' }]), ['I log in // really', 'I open the orders page', 'custom folder step']);
    assert.deepEqual(stepFolders(root, [{ value: '../outside;node_modules/x/dist/steps' }]), []);
    fs.rmSync(root, { recursive: true, force: true });
});

test('feature parsing: doc strings, descriptions, every Examples row, columns, escaped pipes', () => {
    const feat = [
        'Feature: Orders',
        '  Given this description line is not a step',
        '  Scenario Outline: open',
        '    When  I open order "<id>"',
        '    """',
        '    Then ``` is not a delimiter here',
        '    Given still inside',
        '    """',
        '    Then I see "<what>"',
        '    Examples:',
        '      | id | what |',
        '      | 1  | a \\| b |',
        '    Examples: more',
        '      | id | what |',
        '      | 2  | zzz |',
    ].join('\n');
    const steps = featureSteps(feat);
    assert.deepEqual(steps.map((s) => s.line), [4, 9]);
    assert.equal(steps[0].column, '    When  '.length + 1);
    assert.deepEqual(steps[0].variants, ['I open order "1"', 'I open order "2"']);
    assert.deepEqual(steps[1].variants, ['I see "a | b"', 'I see "zzz"']);
    assert.deepEqual(tableCells('| a \\| b | c |'), ['a | b', 'c']);
    const defs = extractStepDefs(`@CSBDDStepDef('I open order {string}') @CSBDDStepDef('I see "a | b"')`, 's.ts', false);
    const problems = checkFeature(feat, defs);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /Examples row giving "I see "zzz""/);
});

test('slow patterns are only tried on short steps', () => {
    const [d] = extractStepDefs(`@CSBDDStepDef('{word}{word}{word}{word}x')`, 's.ts', false);
    assert.ok(d.risky);
    const t = Date.now();
    checkFeature('Feature: f\nScenario: s\nGiven ' + 'a'.repeat(5000), [d]);
    assert.ok(Date.now() - t < 500);
});

test('a step defined only in a folder the framework does not load is explained', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-steps-'));
    fs.mkdirSync(path.join(root, 'test/orders/steps'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test/orders/steps/o.steps.ts'), `@CSBDDStepDef('I open the orders page')`);
    const defs = new StepIndex(root, () => [{ project: 'akhan', value: 'test/akhan/steps' }]).all();
    assert.ok(defs.every((d) => d.notLoaded));
    const [p] = checkFeature('Feature: f\nScenario: s\nGiven I open the orders page', defs);
    assert.match(p.message, /defined in test\/orders\/steps\/o\.steps\.ts:1, but the framework does not load/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('an undefined step suggests the closest existing wording', () => {
    const defs = extractStepDefs(`@CSBDDStepDef('user switches to database {string}')\n@CSBDDStepDef('user opens the login page')`, 'db.steps.ts', true);
    const [p] = checkFeature('Feature: f\n  Scenario: s\n    When user switches to "MAIN" database\n', defs);
    assert.match(p.message, /Closest existing step: "user switches to database \{string\}" \(db\.steps\.ts:1\)/);
    // Nothing alike: no suggestion.
    const [q] = checkFeature('Feature: f\n  Scenario: s\n    When the moon is full\n', defs);
    assert.doesNotMatch(q.message, /Closest/);
});

test('step folders on Windows: Git reports the root with forward slashes (E:/project)', () => {
    const conf = [{ project: 'orangehrm', value: 'test/orangehrm/steps;test/akhan/steps;../elsewhere/steps;node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/steps' }];
    const want = ['E:\\PTF-Demo-Project\\test\\orangehrm\\steps', 'E:\\PTF-Demo-Project\\test\\akhan\\steps'];
    assert.deepEqual(stepFolders('E:/PTF-Demo-Project', conf, path.win32), want);
    assert.deepEqual(stepFolders('E:\\PTF-Demo-Project', conf, path.win32), want);
    // Drive letter in another case (cwd vs Git output).
    assert.deepEqual(stepFolders('e:/PTF-Demo-Project', conf, path.win32).length, 2);
    assert.ok(isInside('E:/PTF-Demo-Project', 'e:\\ptf-demo-project\\test\\x', path.win32));
    assert.ok(!isInside('E:/PTF-Demo-Project', 'E:\\PTF-Demo-Project2\\test', path.win32));
    assert.ok(!isInside('E:/PTF-Demo-Project', 'D:\\PTF-Demo-Project\\test', path.win32));
});

test('always-loaded framework step groups are read from the installed loader', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwload-'));
    fs.mkdirSync(path.join(dir, 'dist', 'core'), { recursive: true });
    // As in 1.54.0: ai, auth and report-validation before the STEP_DEFINITIONS_PATH check.
    fs.writeFileSync(path.join(dir, 'dist', 'core', 'CSStepLoader.js'), `
    async loadRequiredSteps(requirements, features) {
        if (!this.loadedGroups.has('ai')) { await this.loadStepGroup('ai'); }
        if (!this.loadedGroups.has('auth')) { await this.loadStepGroup('auth'); }
        if (!this.loadedGroups.has('report-validation')) { await this.loadStepGroup("report-validation"); }
        const shouldLoadFrameworkSteps = stepPaths.includes('node_modules');
        for (const group of groupsToLoad) { await this.loadStepGroup(group); await this.loadStepGroup('common'); }
    }`);
    assert.deepEqual(alwaysLoadedGroups(dir), ['ai', 'auth', 'report-validation']);
    // Unknown layout: the 1.54 list.
    assert.deepEqual(alwaysLoadedGroups(path.join(dir, 'nope')), ['ai', 'auth', 'report-validation']);
    const real = path.resolve(__dirname, '../../node_modules/@mdakhan.mak/cs-playwright-test-framework');
    if (fs.existsSync(path.join(real, 'dist', 'core', 'CSStepLoader.js'))) assert.ok(alwaysLoadedGroups(real).includes('auth'));
});
