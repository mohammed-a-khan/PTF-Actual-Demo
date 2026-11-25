import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { convertScript } from '../src/recorder/convert';
import { addressFor, Plan, plan } from '../src/recorder/generate';
import { parsePageObject } from '../src/framework/code';
import type { ProjectContext } from '../src/framework/model';
import { patternToRegex } from '../src/lang/steps';
import { codegenArgs } from '../src/recorder/session';

const script = (body: string) => `import { test, expect } from '@playwright/test';\n\ntest('test', async ({ page }) => {\n${body}\n});\n`;
const conv = (body: string, o = {}) => convertScript(ts, script(body), o);

test('convert: locators become the selectors Playwright uses for them', () => {
    const c = conv(`
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Docs', exact: true }).click();
  await page.getByRole('heading', { level: 2 }).click();
  await page.getByText('Orders').first().click();
  await page.getByText(/total: \\d+/i).click();
  await page.getByLabel('Email').fill('a@b.c');
  await page.getByPlaceholder('Search').fill('x');
  await page.getByAltText('Logo').click();
  await page.getByTitle('Close').click();
  await page.getByTestId('save').click();
  await page.locator('#main').getByRole('row').filter({ hasText: 'Alice' }).last().click();
  await page.locator('div', { hasText: 'Total' }).nth(2).click();`);
    assert.deepEqual(c.actions.map((a) => a.target!.selector), [
        'internal:role=button[name="Sign in"i]', 'internal:role=link[name="Docs"s]', 'internal:role=heading[level=2]',
        'internal:text="Orders"i >> nth=0', 'internal:text=/total: \\d+/i', 'internal:label="Email"i', 'internal:attr=[placeholder="Search"i]',
        'internal:attr=[alt="Logo"i]', 'internal:attr=[title="Close"i]', 'internal:testid=[data-testid="save"s]',
        '#main >> internal:role=row >> internal:has-text="Alice"i >> nth=-1', 'div >> internal:has-text="Total"i >> nth=2',
    ]);
    assert.equal(c.actions[9].target!.testId, 'save');
    assert.deepEqual(c.warnings, []);
    // A custom test id attribute.
    assert.equal(conv(`  await page.getByTestId('save').click();`, { testIdAttribute: 'data-qa' }).actions[0].target!.selector, 'internal:testid=[data-qa="save"s]');
});

test('convert: frames, expectations, values; recorder noise dropped; other tabs and handlers reported', () => {
    const c = conv(`
  await page.goto('https://shop.test/login?x=1');
  await page.getByRole('textbox', { name: 'User' }).click();
  await page.getByRole('textbox', { name: 'User' }).fill('a');
  await page.getByRole('textbox', { name: 'User' }).fill('alice');
  await page.getByRole('textbox', { name: 'User' }).press('Tab');
  await page.getByLabel('Country').press('ArrowDown');
  await page.getByLabel('Country').selectOption(['IN', 'US']);
  await page.locator('iframe[name="pay"]').contentFrame().locator('#inner').contentFrame().getByPlaceholder('Card').fill('4111');
  await page.frameLocator('#f').getByRole('button').click();
  await expect(page.getByRole('heading')).toContainText('Welcome');
  await expect(page.getByTestId('c')).toHaveText(/IN|US/);
  await expect(page.getByLabel('User')).toHaveValue('alice');
  await expect(page.getByRole('checkbox')).toBeChecked();
  await expect(page).toHaveURL(/dashboard/);
  await expect(page).toHaveTitle('Shop');
  await expect(page.getByText('x')).not.toBeVisible();
  await page.getByRole('button').click({ button: 'right' });
  page.once('dialog', dialog => { dialog.dismiss().catch(() => {}); });
  const page1Promise = page.waitForEvent('popup');
  await page.getByRole('link').click();
  const page1 = await page1Promise;
  await page1.getByRole('button').click();
  await page.close();`);
    const k = c.actions.map((a) => a.kind);
    assert.deepEqual(k, ['goto', 'fill', 'select', 'fill', 'click', 'expectContains', 'expectText', 'expectValue', 'expectChecked', 'expectUrl', 'expectTitle', 'rightclick', 'click', 'switchTab', 'click']);
    assert.equal(c.actions[13].value, 'new', 'the popup: the steps after act in the new tab');
    assert.equal(c.actions[1].value, 'alice');
    assert.deepEqual(c.actions[2].values, ['IN', 'US']);
    assert.deepEqual(c.actions[3].target!.frames, ['iframe[name="pay"]', '#inner']);
    assert.deepEqual(c.actions[4].target!.frames, ['#f']);
    assert.equal(c.actions[6].regex, true);
    assert.equal(c.actions[9].value, 'dashboard');
    assert.ok(c.warnings.some((w) => /not\.toBeVisible is not converted/.test(w)));
    assert.ok(!c.warnings.some((w) => /click options/.test(w)), 'a right-click is its own step');
    assert.ok(c.warnings.some((w) => /dialog/.test(w)));
    assert.ok(!c.warnings.some((w) => /tab/.test(w)), c.warnings.join('\n'));
});

test("Playwright's own tabs: a popup and a new page, back to the first tab, a tab closed", () => {
    const c = convertScript(ts, script(`
  await page.goto('https://shop.test/');
  const page1Promise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Help' }).click();
  const page1 = await page1Promise;
  await page1.getByRole('textbox', { name: 'Search' }).fill('returns');
  await page1.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Cart' }).click();
  await page1.getByRole('link', { name: 'Returns' }).click();
  await page1.close();
  const page2 = await context.newPage();
  await page2.goto('https://shop.test/orders');
  await page.getByRole('button', { name: 'Checkout' }).click();`));
    assert.deepEqual(c.actions.map((a) => `${a.kind}${a.value !== undefined ? ` ${a.value}` : ''}`), [
        'goto https://shop.test/', 'click', 'switchTab new', 'fill returns', 'pressKey Enter',
        'switchTab 0', 'click', 'switchTab 1', 'click', 'closeTab',
        'switchTab new', 'goto https://shop.test/orders', 'switchTab 0', 'click',
    ]);
    assert.deepEqual(c.warnings, []);
});

const LOGIN = script(`
  await page.goto('https://shop.test/login');
  await page.getByRole('textbox', { name: 'Username' }).fill('alice');
  await page.getByLabel('Password').fill('pw-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading')).toContainText('Welcome, alice');
  await expect(page.getByTestId('country')).toHaveText('Country: IN');
  await page.goto('https://pay.example.com/checkout');
  await page.getByPlaceholder('Card number').fill('4111');`);

const ctxOf = (over: Partial<ProjectContext> = {}, config: Partial<ProjectContext['config']> = {}): ProjectContext => ({
    project: 'shop', env: 'dev', featureFolder: 'test/shop/features', pagesFolder: 'test/shop/pages', stepsFolder: 'test/shop/steps', dataFolder: 'test/shop/data',
    pages: [], steps: [], files: {},
    config: { exists: true, common: { path: 'config/shop/common/common.env', text: 'BROWSER=chromium\n' }, envFile: { path: 'config/shop/environments/dev.env', text: 'BASE_URL=https://shop.test\n' },
        values: { BASE_URL: 'https://shop.test' }, stepPath: null, stepsLoaded: true, ...config },
    ...over,
});
const file = (p: Plan, path: string) => p.files.find((f) => f.path === path);
/** Each feature line matches exactly one definition (existing or generated). */
function linesMatch(p: Plan, existing: string[] = []) {
    const feature = p.files.find((f) => f.kind === 'feature')!.text;
    const defs = [...existing, ...p.files.filter((f) => f.kind === 'steps').flatMap((f) => [...f.text.matchAll(/@CSBDDStepDef\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1].replace(/\\'/g, "'")))];
    const res = [...new Set(defs)].map(patternToRegex);
    const lines = feature.split('\n').map((l) => l.trim()).filter((l) => /^(Given|When|Then|And) /.test(l)).map((l) => l.replace(/^\w+ /, '').replace(/"<\w+>"/g, '"x"'));
    for (const l of lines) assert.equal(res.filter((r) => r.test(l)).length, 1, l);
    return lines.length;
}

test('plan: test data in a JSON file read by Examples; secrets encrypted; checks that use typed values', () => {
    const c = convertScript(ts, LOGIN);
    const p = plan(ts, c.actions, ctxOf(), { name: 'Shop login' });
    const feature = p.files[0];
    assert.equal(feature.path, 'test/shop/features/shop-login.feature');
    assert.match(feature.text, /Scenario Outline: Shop login - <testCaseId>/);
    assert.match(feature.text, /Examples: \{"type": "json", "source": "test\/shop\/data\/shop-login\.json", "path": "\$\.data\[\*\]", "filter": "runFlag=Yes"\}/);
    assert.match(feature.text, /the user enters "<username>" in Username field on the Login page/);
    assert.match(feature.text, /the user enters "<password>" in Password field on the Login page/);
    assert.match(feature.text, /heading should contain "<expectedHeading>" on the Login page/, 'a check that depends on a typed value is data');
    assert.match(feature.text, /country should show "Country: IN" on the Login page/, 'other checks are fixed');
    const data = JSON.parse(file(p, 'test/shop/data/shop-login.json')!.text);
    assert.deepEqual(Object.keys(data.data[0]), ['testCaseId', 'description', 'runFlag', 'username', 'password', 'expectedHeading', 'cardNumber']);
    assert.equal(data.data[0].runFlag, 'Yes');
    assert.equal(data.data[0].password, '__CS_ENCRYPT_1__');
    assert.deepEqual(p.encrypt.map((x) => x.value), ['pw-123', '4111']);
    assert.doesNotMatch(p.files.map((f) => f.text).join('\n'), /pw-123/);
    assert.deepEqual(p.pages.map((x) => x.className), ['LoginPage', 'CheckoutPage']);
    assert.ok(file(p, 'test/shop/steps/login.steps.ts') && file(p, 'test/shop/steps/checkout.steps.ts'), 'one step file per page');
    assert.match(file(p, 'test/shop/pages/LoginPage.ts')!.text, /new URL\('\/login', String\(this\.config\.get\('BASE_URL'\)\)\)/);
    // The second site gets its own address key, added to the project's common configuration.
    assert.match(file(p, 'test/shop/pages/CheckoutPage.ts')!.text, /this\.config\.get\('PAY_EXAMPLE_URL'\)/);
    assert.match(file(p, 'config/shop/common/common.env')!.text, /^BROWSER=chromium\n\n# Address of pay\.example\.com.*\nPAY_EXAMPLE_URL=https:\/\/pay\.example\.com\n$/);
    assert.equal(linesMatch(p), 8);
    // Studio secrets instead; and a value made fixed / renamed by the tester.
    const q = plan(ts, c.actions, ctxOf(), { name: 'Shop login', secretMode: 'studio', values: { 1: { mode: 'fixed' }, 4: { mode: 'data', column: 'greeting' } } });
    assert.match(q.files[0].text, /enters "alice" in Username/);
    assert.match(q.files[0].text, /heading should contain "<greeting>"/);
    assert.equal(JSON.parse(file(q, 'test/shop/data/shop-login.json')!.text).data[0].password, '{env:LOGIN_PASSWORD_FIELD}');
    assert.deepEqual(q.secrets, [{ name: 'LOGIN_PASSWORD_FIELD', value: 'pw-123' }, { name: 'CHECKOUT_CARD_NUMBER_FIELD', value: '4111' }]);
});

test('plan: extends the project\'s page object, step file and data file; reuses steps that exist', () => {
    const page = `import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';

@CSPage('shop-login')
export class LoginPage extends CSBasePage {
    @CSGetElement({ css: 'internal:role=textbox[name="Username"i]', description: 'user name (Login page)' })
    public userName!: CSWebElement;

    protected initializeElements(): void {}

    public async open(): Promise<void> { await this.navigate('https://shop.test/login'); }
}
`;
    const steps = `import { CSBDDStepDef, Page, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { LoginPage } from '../pages/LoginPage';

@StepDefinitions
export class LoginSteps {
    @Page('shop-login')
    private login!: LoginPage;

    @CSBDDStepDef('the user opens the Login page')
    async open(): Promise<void> { await this.login.open(); }

    @CSBDDStepDef('the user enters {string} in user name on the Login page')
    async user(v: string): Promise<void> { await this.login.userName.fill(v); }
}
`;
    const existingDefs = ['the user opens the Login page', 'the user enters {string} in user name on the Login page'];
    const ctx = ctxOf({
        pages: [parsePageObject(ts, page, 'test/shop/pages/LoginPage.ts')!],
        steps: existingDefs.map((pattern) => ({ pattern, regex: patternToRegex(pattern), file: 'test/shop/steps/login-steps.ts', builtIn: false })),
        files: { 'test/shop/steps/login-steps.ts': steps, 'test/shop/data/shop-login.json': JSON.stringify({ data: [{ testCaseId: 'TC01', runFlag: 'Yes', username: 'bob' }, { testCaseId: 'TC02', runFlag: 'No', username: 'carol' }] }) },
    });
    const c = convertScript(ts, script(`
  await page.goto('https://shop.test/login');
  await page.getByRole('textbox', { name: 'Username' }).fill('alice');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Sign in' }).click();`));
    const p = plan(ts, c.actions, ctx, { name: 'Shop login' });
    assert.deepEqual(p.summary, { stepsReused: 2, stepsNew: 2, elementsReused: 1, elementsNew: 2 });
    assert.match(p.files[0].text, /the user enters "<username>" in user name on the Login page/);
    const pg = file(p, 'test/shop/pages/LoginPage.ts')!;
    assert.equal(pg.change, 'update');
    assert.equal((pg.text.match(/@CSGetElement\(/g) ?? []).length, 3);
    assert.equal((pg.text.match(/async open\(/g) ?? []).length, 1, 'the page keeps its own open()');
    assert.ok(pg.text.startsWith(page.slice(0, page.indexOf('    protected'))), 'the existing code is unchanged');
    const st = file(p, 'test/shop/steps/login-steps.ts')!;
    assert.equal(st.change, 'update');
    assert.match(st.text, /@CSBDDStepDef\('the user enters \{string\} in Password field on the Login page'\)\n {4}async enterLoginPasswordField\(value: string\): Promise<void> \{\n {8}await this\.login\.passwordField\.fill\(value\);/);
    assert.equal((st.text.match(/@Page\(/g) ?? []).length, 1, 'the class\'s own @Page field is used');
    assert.ok(!file(p, 'test/shop/steps/login.steps.ts'));
    const data = JSON.parse(file(p, 'test/shop/data/shop-login.json')!.text).data;
    assert.deepEqual(data.map((r: Record<string, string>) => [r.testCaseId, r.username, r.password]), [['TC01', 'bob', '__CS_ENCRYPT_1__'], ['TC02', 'carol', '__CS_ENCRYPT_1__']]);
    linesMatch(p, existingDefs);
});

test('plan: a new project gets its configuration; the step folder is added to STEP_DEFINITIONS_PATH', () => {
    const c = convertScript(ts, script(`  await page.goto('https://crm.test/home');\n  await page.getByRole('link', { name: 'Leads' }).click();`));
    const p = plan(ts, c.actions, ctxOf({}, { exists: false, common: { path: 'config/shop/common/common.env', text: null }, envFile: { path: 'config/shop/environments/dev.env', text: null }, values: {} }), { name: 'Leads' });
    // The shared default already loads test/shop/steps: the new project keeps it (its own value would drop shared folders).
    assert.equal(file(p, 'config/shop/common/common.env')!.text, '# Project shop: created by CS Test Studio for recorded tests\nBROWSER=chromium\nHEADLESS=false\n');
    // When the shared value does not load the project's steps folder: extended, not replaced.
    const g = plan(ts, c.actions, ctxOf({}, { exists: false, common: { path: 'config/shop/common/common.env', text: null }, envFile: { path: 'config/shop/environments/dev.env', text: null }, values: {}, stepsLoaded: false,
        stepPath: { value: 'test/common/steps;node_modules/fw/dist/steps', file: { path: 'config/global.env', text: 'STEP_DEFINITIONS_PATH=test/common/steps;node_modules/fw/dist/steps\n' } } }), { name: 'Leads' });
    assert.match(file(g, 'config/shop/common/common.env')!.text, /^STEP_DEFINITIONS_PATH=test\/shop\/steps;test\/common\/steps;node_modules\/fw\/dist\/steps$/m);
    assert.equal(file(p, 'config/shop/environments/dev.env')!.text, '# Address of the application in dev\nBASE_URL=https://crm.test\n');
    assert.match(p.files[0].text, /Scenario: Leads/, 'no typed values: a plain scenario, no data file');
    assert.ok(!p.files.some((f) => f.kind === 'data'));
    const q = plan(ts, c.actions, ctxOf({}, { stepPath: { value: 'test/other/steps;node_modules/x', file: { path: 'config/shop/environments/dev.env', text: 'BASE_URL=https://shop.test\nSTEP_DEFINITIONS_PATH=test/other/steps;node_modules/x\n' } }, stepsLoaded: false }), { name: 'Leads' });
    assert.match(file(q, 'config/shop/environments/dev.env')!.text, /^STEP_DEFINITIONS_PATH=test\/shop\/steps;test\/other\/steps;node_modules\/x$/m);
    // Known address keys of the project are used.
    assert.deepEqual(addressFor('https://crm.test/a?b=1', { BASE_URL: 'https://shop.test', CRM_URL: 'https://crm.test/app' }), { key: 'CRM_URL', path: '/a?b=1' });
});

test('codegenArgs: browser, channel, test id attribute, proxy, device', () => {
    assert.deepEqual(codegenArgs('/r/x.spec.ts', { url: 'https://a.test/', browser: 'msedge', testIdAttribute: 'data-qa', device: 'iPhone 13', ignoreHttpsErrors: true, proxy: { server: 'http://proxy:8080', bypass: 'localhost' } }),
        ['codegen', '--target', 'playwright-test', '--output', '/r/x.spec.ts', '--channel', 'msedge', '--test-id-attribute', 'data-qa', '--device', 'iPhone 13', '--ignore-https-errors', '--proxy-server', 'http://proxy:8080', '--proxy-bypass', 'localhost', 'https://a.test/']);
});

test('addressFor: keys for other sites, IP addresses and hosts', () => {
    assert.deepEqual(addressFor('http://127.0.0.1:8080/x', { BASE_URL: 'https://shop.test' }), { key: 'APP_URL', path: '/x', newKey: 'APP_URL' });
    assert.deepEqual(addressFor('https://login.microsoftonline.com/t', { BASE_URL: 'https://shop.test' }), { key: 'LOGIN_MICROSOFTONLINE_URL', path: '/t', newKey: 'LOGIN_MICROSOFTONLINE_URL' });
    assert.deepEqual(addressFor('https://shop.test/a', {}), { key: 'BASE_URL', path: '/a', newKey: 'BASE_URL' });
});

import { checkPlan } from '../src/framework/standards';
test('plan → framework core check: a recording passes the standards (every line defined by the steps it writes or reuses)', () => {
    const c = convertScript(ts, LOGIN);
    const ctx = ctxOf();
    const p = plan(ts, c.actions, ctx, { name: 'Shop login' });
    const framework = [{ pattern: 'a framework step', regex: patternToRegex('a framework step'), file: 'node_modules/fw/steps.js', line: 1, builtIn: true }];
    const findings = checkPlan(ts, { title: 'rec', warnings: [], files: p.files.map((f) => ({ path: f.path, kind: f.kind, text: f.text })) }, { ...ctx, allSteps: framework, loadedStepFolders: [ctx.stepsFolder] });
    assert.deepEqual(findings.filter((f) => f.level === 'error').map((f) => `${f.rule} ${f.message}`), []);
});

test('plan: uploads, downloads and the newer checks (state, attribute, count, table cell, not shown) become framework steps', () => {
    const c = conv(`
  await page.goto('https://shop.test/orders');
  await page.locator('#file-upload').setInputFiles(['a.txt', 'b.csv']);
  await expect(page.getByText('Upload failed')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Go' })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/home');
  await expect(page.locator('#orders > tbody > tr')).toHaveCount(4);
  await expect(page.getByRole('row', { name: 'Smith John' }).locator(':scope > *').nth(2)).toHaveText('jsmith@x.com');
  await expect(page).toHaveDownloaded(/^report-\\d+\\.csv$/);`);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.actions.map((a) => a.kind), ['goto', 'upload', 'expectHidden', 'expectDisabled', 'expectEnabled', 'expectAttribute', 'expectCount', 'expectText', 'expectDownload']);
    const p = plan(ts, c.actions, ctxOf(), { name: 'Orders' });
    linesMatch(p);
    const feature = p.files.find((f) => f.kind === 'feature')!.text;
    assert.match(feature, /the file "\/\^report-\\d\+\\\.csv\$\/" should be downloaded/);
    assert.match(feature, /uploads "a\.txt \| b\.csv" to/);
    const steps = p.files.filter((f) => f.kind === 'steps').map((f) => f.text).join('\n');
    // Helpers in one module beside the step folder: the framework checks function names across step files.
    const helpers = file(p, 'test/shop/support/recording-helpers.ts')!;
    assert.equal(helpers.kind, 'other');
    assert.match(helpers.text, /import \{ CSTestResultsManager \} from '@mdakhan\.mak\/cs-playwright-test-framework\/reporter';/);
    assert.match(helpers.text, /export async function downloaded\(expected: string\)/);
    assert.match(helpers.text, /export async function eventually\(/);
    assert.match(helpers.text, /path\.resolve\('test\/shop\/data\/uploads', f\)/);
    assert.match(steps, /import \{ eventually, downloaded, uploadFiles \} from '\.\.\/support\/recording-helpers';/);
    assert.doesNotMatch(steps, /function |const \w+ = \(/, 'no helper functions in the step file');
    assert.match(steps, /\.setInputFiles\(uploadFiles\(fileName\)\)/);
    assert.match(steps, /isDisabled\(\)/); assert.match(steps, /isEnabled\(\)/);
    assert.match(steps, /getAttribute\('href'\)/);
    assert.match(steps, /\.count\(\)/);
    assert.ok(p.warnings.some((w) => /test\/shop\/data\/uploads/.test(w)), 'where upload files are read from');
});

test('plan: the shared helpers module is extended with what it lacks; a step file with its own helper keeps it', () => {
    const helpers = `/** Helpers. */\nexport async function eventually(read: () => Promise<string | null>, expected: string, mode: 'equals' | 'contains', what: string): Promise<void> {\n    return;\n}\n`;
    const oldSteps = `import { CSBDDStepDef, Page, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { OrdersPage } from '../pages/OrdersPage';

async function eventually(read: () => Promise<string | null>, expected: string, mode: 'equals' | 'contains', what: string): Promise<void> {
    return;
}

@StepDefinitions
export class OrdersPageSteps {
    @Page('orders')
    private ordersPage!: OrdersPage;
}
`;
    const ctx = ctxOf({ files: { 'test/shop/support/recording-helpers.ts': helpers, 'test/shop/steps/orders.steps.ts': oldSteps } });
    const c = conv(`
  await page.goto('https://shop.test/orders');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.getByRole('link', { name: 'Export' }).click();
  await expect(page).toHaveDownloaded('orders.csv');`);
    const p = plan(ts, c.actions, ctx, { name: 'Orders export' });
    const h = file(p, 'test/shop/support/recording-helpers.ts')!;
    assert.equal(h.change, 'update');
    assert.ok(h.text.startsWith("import { CSTestResultsManager } from '@mdakhan.mak/cs-playwright-test-framework/reporter';\n/** Helpers. */"), 'the import it needs, above what it had');
    assert.equal((h.text.match(/export async function eventually\(/g) ?? []).length, 1, 'not added twice');
    assert.match(h.text, /export async function downloaded\(/);
    const s = file(p, 'test/shop/steps/orders.steps.ts')!;
    assert.match(s.text, /^import \{ downloaded \} from '\.\.\/support\/recording-helpers';$/m, 'only what the file does not define itself');
    assert.equal((s.text.match(/function eventually\(/g) ?? []).length, 1);
});
