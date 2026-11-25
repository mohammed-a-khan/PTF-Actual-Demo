import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { formatOf, jsonRowsPath, parseCsv, readTable, repoModule, toCsv, workbookBytes, writeJson } from '../src/data/tables';
import { convertScript } from '../src/recorder/convert';
import { dataBindings, dateOf, markedBreaks, plan, rememberedValues, whenOf } from '../src/recorder/generate';
import { applyPlan, reviewPlan } from '../src/framework/plan';
import { checkPlan } from '../src/framework/standards';
import type { ProjectContext } from '../src/framework/model';

const ctxOf = (over: Partial<ProjectContext> = {}): ProjectContext => ({
    project: 'shop', env: 'dev', featureFolder: 'test/shop/features', pagesFolder: 'test/shop/pages', stepsFolder: 'test/shop/steps', dataFolder: 'test/shop/data',
    pages: [], steps: [], files: {},
    config: { exists: true, common: { path: 'config/shop/common/common.env', text: 'BROWSER=chromium\n' }, envFile: { path: 'config/shop/environments/dev.env', text: 'BASE_URL=https://shop.test\n' }, values: { BASE_URL: 'https://shop.test' }, stepPath: null, stepsLoaded: true },
    ...over,
} as ProjectContext);
const LOGIN = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/login');
  await page.getByLabel('User name').fill('alice');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('who')).toContainText('Welcome, alice');
});`;
const featureOf = (p: ReturnType<typeof plan>) => p.files.find((f) => f.kind === 'feature')!.text;
const dataOf = (p: ReturnType<typeof plan>) => p.files.find((f) => f.kind === 'data');

test('tables: CSV written and read back exactly (commas, quotes, line breaks, spaces); formats; JSON paths', () => {
    const rows = [{ a: 'x,y', b: 'say "hi"', c: 'two\nlines' }, { a: ' padded ', b: '', c: 'plain' }];
    const csv = toCsv(['a', 'b', 'c'], rows);
    assert.equal(csv, 'a,b,c\n"x,y","say ""hi""","two\nlines"\n" padded ",,plain\n');
    assert.deepEqual(parseCsv(csv), { columns: ['a', 'b', 'c'], rows });
    assert.deepEqual(parseCsv('a;b\r\n1;2\r\n\r\n', ';'), { columns: ['a', 'b'], rows: [{ a: '1', b: '2' }] });
    assert.deepEqual(['x.json', 'x.CSV', 'x.xlsx', 'x.xls', 'x.xml', 'x.txt'].map(formatOf), ['json', 'csv', 'excel', 'excel', 'xml', null]);
    assert.deepEqual(jsonRowsPath(undefined), ['data']);
    assert.deepEqual(jsonRowsPath('$.suite.users[*]'), ['suite', 'users']);
    assert.deepEqual(jsonRowsPath('$[*]'), []);
    assert.equal(jsonRowsPath('$..users[?(@.a)]'), null);
    // The rest of a JSON document is kept.
    assert.deepEqual(JSON.parse(writeJson('{"meta":{"v":1},"suite":{"users":[]}}', '$.suite.users[*]', ['u'], [{ u: 'a' }])), { meta: { v: 1 }, suite: { users: [{ u: 'a' }] } });
});

test('plan: a CSV or Excel data file, with the framework\'s Examples for it', () => {
    const c = convertScript(ts, LOGIN);
    const csv = plan(ts, c.actions, ctxOf(), { name: 'Shop login', data: { format: 'csv' } });
    assert.equal(dataOf(csv)!.path, 'test/shop/data/shop-login.csv');
    assert.match(dataOf(csv)!.text, /^testCaseId,description,runFlag,userName,expectedWho\nTC01,Shop login \(recorded \d{4}-\d\d-\d\d\),Yes,alice,"Welcome, alice"\n$/);
    assert.match(featureOf(csv), /Examples: \{"type": "csv", "source": "test\/shop\/data\/shop-login\.csv", "filter": "runFlag=Yes"\}/);
    const xl = plan(ts, c.actions, ctxOf(), { name: 'Shop login', data: { format: 'excel' } });
    const f = dataOf(xl)!;
    assert.equal(f.path, 'test/shop/data/shop-login.xlsx');
    assert.deepEqual(f.encode, { as: 'xlsx', sheet: 'Data' });
    assert.equal(f.shownBefore, null);
    assert.match(featureOf(xl), /Examples: \{"type": "excel", "source": "test\/shop\/data\/shop-login\.xlsx", "sheet": "Data", "filter": "runFlag=Yes"\}/);
});

test('plan: a data file the project has: its rows and column names kept, new columns added, its filter', () => {
    const c = convertScript(ts, LOGIN);
    const existing = { columns: ['user', 'greeting'], rows: [{ user: 'bob', greeting: 'Welcome, bob' }, { user: 'carol', greeting: 'Welcome, carol' }] };
    // The typed name goes to the file's "user" column; the check gets its own new column.
    const p = plan(ts, c.actions, ctxOf(), { name: 'Shop login', values: { 1: { column: 'user' } }, data: { file: 'test/shop/data/users.csv', existing, filter: 'user!=carol' } });
    assert.equal(dataOf(p)!.path, 'test/shop/data/users.csv');
    assert.equal(dataOf(p)!.change, 'update');
    assert.equal(dataOf(p)!.text, 'user,greeting,expectedWho\nbob,"Welcome, bob","Welcome, alice"\ncarol,"Welcome, carol","Welcome, alice"\n');
    const feature = featureOf(p);
    assert.match(feature, /When the user enters "<user>" in/);
    assert.match(feature, /Scenario Outline: Shop login\n/, 'no <testCaseId> in the name when the file has none');
    assert.match(feature, /Examples: \{"type": "csv", "source": "test\/shop\/data\/users\.csv", "filter": "user!=carol"\}/);
    // The check can use the file's column too: then nothing is added.
    const q = plan(ts, c.actions, ctxOf(), { name: 'Shop login', values: { 1: { column: 'user' }, 3: { mode: 'data', column: 'greeting' } }, data: { file: 'test/shop/data/users.csv', existing } });
    assert.equal(dataOf(q), undefined, 'the file has every column: it is used as it is');
    assert.match(featureOf(q), /Examples: \{"type": "csv", "source": "test\/shop\/data\/users\.csv"\}/, 'every row runs: no runFlag column');
    // XML is read only: values must use its columns.
    const x = plan(ts, c.actions, ctxOf(), { name: 'Shop login', values: { 1: { column: 'user' } }, data: { file: 'test/shop/data/users.xml', existing } });
    assert.equal(dataOf(x), undefined);
    assert.ok(x.warnings.some((w) => /XML, which the Studio does not write: choose one of its columns for expectedWho/.test(w)));
});

test('Excel through the repository\'s SheetJS: written, other sheets kept, read back as the framework reads it', async (t) => {
    const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
    const X = repoModule(repoRoot, 'xlsx');
    if (!X) { t.skip('No xlsx package in the repository'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tables-'));
    try {
        // A workbook the team made: two sheets.
        const wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['user', 'greeting'], ['bob', 'Welcome, bob']]), 'Logins');
        X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['notes'], ['keep me']]), 'Notes');
        fs.mkdirSync(path.join(dir, 'test/shop/data'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'test/shop/data/users.xlsx'), X.write(wb, { type: 'buffer', bookType: 'xlsx' }));
        const existing = readTable(dir, 'test/shop/data/users.xlsx', { sheet: 'Logins', modules: repoRoot });
        assert.deepEqual(existing, { columns: ['user', 'greeting'], rows: [{ user: 'bob', greeting: 'Welcome, bob' }], sheets: ['Logins', 'Notes'] });
        const c = convertScript(ts, LOGIN);
        const p = plan(ts, c.actions, ctxOf(), { name: 'Shop login', values: { 1: { column: 'user' } }, data: { file: 'test/shop/data/users.xlsx', sheet: 'Logins', existing } });
        const f = p.files.find((x) => x.kind === 'data')!;
        assert.match(featureOf(p), /"type": "excel", "source": "test\/shop\/data\/users\.xlsx", "sheet": "Logins"/);
        // The review shows the sheet as CSV, before and after; the hash is of the workbook itself.
        const change = { title: 't', warnings: [], files: [{ path: f.path, kind: f.kind, text: f.text, encode: f.encode, shownBefore: f.shownBefore }] };
        const r = await reviewPlan(dir, change, []);
        assert.equal(r.files[0].before, 'user,greeting\nbob,"Welcome, bob"\n');
        assert.match(r.files[0].diff, /\+user,greeting,expectedWho/);
        applyPlan(dir, change, { encode: (pf, text) => workbookBytes(dir, pf.path, pf.encode!.sheet, text, repoRoot), recoveryDir: path.join(dir, 'rec') });
        assert.deepEqual(readTable(dir, 'test/shop/data/users.xlsx', { sheet: 'Logins', modules: repoRoot }).rows, [{ user: 'bob', greeting: 'Welcome, bob', expectedWho: 'Welcome, alice' }]);
        assert.deepEqual(readTable(dir, 'test/shop/data/users.xlsx', { sheet: 'Notes', modules: repoRoot }).rows, [{ notes: 'keep me' }], 'other sheets kept');
        // The replaced workbook is kept byte for byte.
        assert.ok(fs.readFileSync(path.join(dir, 'rec/test/shop/data/users.xlsx')).subarray(0, 2).equals(Buffer.from('PK')));
        // As the framework reads it (sheet_to_json, the first row names the columns).
        const ws = X.read(fs.readFileSync(path.join(dir, 'test/shop/data/users.xlsx')), { type: 'buffer' }).Sheets.Logins;
        assert.deepEqual(X.utils.sheet_to_json(ws), [{ user: 'bob', greeting: 'Welcome, bob', expectedWho: 'Welcome, alice' }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('test data taken while recording: the marks; a database read in every run (its sources, read step and helpers)', () => {
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/inputs');
  // cs-data {"name":"customer","column":"lucky_number","mode":"run","source":{"kind":"query","connection":"SHOP","sql":"SELECT * FROM customers"}}
  await page.getByLabel('Number').fill('27');
  // cs-data {broken
  await expect(page.getByLabel('Number')).toHaveValue('27');
});`;
    const c = convertScript(ts, script);
    assert.deepEqual(c.warnings, []);
    const b = dataBindings(script, c.actions);
    assert.deepEqual(Object.keys(b), ['1'], 'a mark goes with the action after it; a broken mark is ignored');
    assert.equal(b[1].name, 'customer');
    const p = plan(ts, c.actions, ctxOf(), { name: 'Lucky', fetched: { 1: { name: b[1].name, column: b[1].column } }, sources: { customer: { kind: 'query', connection: 'SHOP', sql: 'SELECT * FROM customers' } } });
    const feature = featureOf(p);
    assert.match(feature, /Scenario: Lucky\n    Given the test data "customer" is read\n    And the user opens the Inputs page\n    When the user enters test data "customer\.lucky_number" in Number field on the Inputs page\n    Then Number field should have the value of test data "customer\.lucky_number" on the Inputs page/);
    assert.doesNotMatch(feature, /Examples/, 'nothing goes to a data file');
    assert.equal(dataOf(p)?.path, 'test/shop/data/test-data-sources.json');
    assert.deepEqual(JSON.parse(dataOf(p)!.text), { customer: { kind: 'query', connection: 'SHOP', sql: 'SELECT * FROM customers' } });
    const reads = p.files.find((f) => f.path === 'test/shop/steps/test-data.steps.ts')!;
    assert.match(reads.text, /@CSBDDStepDef\('the test data \{string\} is read'\)/);
    assert.match(reads.text, /import \{ readTestData \} from '\.\.\/support\/recording-helpers';/);
    const helpers = p.files.find((f) => f.path === 'test/shop/support/recording-helpers.ts')!.text;
    assert.match(helpers, /const \{ CSDBUtils \} = await import\('@mdakhan\.mak\/cs-playwright-test-framework\/database-utils'\);/);
    assert.match(helpers, /import \{ CSScenarioContext \} from '@mdakhan\.mak\/cs-playwright-test-framework\/bdd';/);
    assert.match(helpers, /export async function readTestData\(name: string\)/);
    assert.match(helpers, /export function testData\(ref: string\)/);
    const steps = p.files.find((f) => f.path.endsWith('inputs.steps.ts'))!.text;
    assert.match(steps, /\.fill\(testData\(ref\)\)/);
    assert.match(steps, /const expected = testData\(ref\);/);
    assert.match(steps, /import \{ eventually, testData \} from '\.\.\/support\/recording-helpers';/);
    // A project that has them: the read step is reused, the sources file extended, the helpers kept.
    const q = plan(ts, c.actions, ctxOf({
        steps: [{ pattern: 'the test data {string} is read', regex: /^the test data "([^"]*)" is read$/, file: 'test/shop/steps/test-data.steps.ts', line: 7 }] as unknown as ProjectContext['steps'],
        files: { 'test/shop/data/test-data-sources.json': '{"orders":{"kind":"query","connection":"SHOP","sql":"SELECT 1"}}', 'test/shop/support/recording-helpers.ts': helpers },
    }), { name: 'Lucky', fetched: { 1: { name: 'customer', column: 'lucky_number' } }, sources: { customer: { kind: 'query', connection: 'SHOP', sql: 'SELECT * FROM customers' } } });
    assert.equal(q.files.some((f) => f.path.endsWith('test-data.steps.ts')), false);
    assert.equal(q.files.some((f) => f.path.endsWith('recording-helpers.ts')), false);
    assert.deepEqual(Object.keys(JSON.parse(q.files.find((f) => f.path.endsWith('test-data-sources.json'))!.text)), ['orders', 'customer']);
});

test('test data read in every run from an API request: its source, and the helper that sends it through the framework', () => {
    const c = convertScript(ts, LOGIN);
    const p = plan(ts, c.actions, ctxOf(), { name: 'Shop login', fetched: { 1: { name: 'user', column: 'login' } }, sources: { user: { kind: 'api', collection: 'test/shop/api/users.collection.json', request: 'r1', path: '$.items[*]' } } });
    assert.match(featureOf(p), /Given the test data "user" is read\n    And the user opens the Login page\n    When the user enters test data "user\.login" in User name field/);
    assert.deepEqual(JSON.parse(dataOf(p)!.text), { user: { kind: 'api', collection: 'test/shop/api/users.collection.json', request: 'r1', path: '$.items[*]' } });
    const h = p.files.find((f) => f.path.endsWith('recording-helpers.ts'))!.text;
    // Multipart requests (fields and the project's files) and payload templates are sent too.
    assert.match(h, /multipart\/form-data; boundary=/);
    assert.match(h, /fs\.readFileSync\(path\.resolve\(rel\)\)/);
    assert.match(h, /PAYLOAD_BASE_PATH/);
    assert.doesNotMatch(h, /multipart request is not supported/);
    assert.match(h, /if \(s\.kind === 'api'\) row = \(await readApiRows\(s\)\)\[0\];/);
    assert.match(h, /const \{ CSAPIClient \} = await import\('@mdakhan\.mak\/cs-playwright-test-framework\/api'\);/, 'loaded only when an API source is read');
    assert.match(h, /const \{ CSDBUtils \} = await import\('@mdakhan\.mak\/cs-playwright-test-framework\/database-utils'\);/);
    assert.match(h, /\.replace\(\/\\\{config:\(\[\\w\.-\]\+\)\\\}\/g/, '{config:KEY} from the framework configuration');
    assert.match(h, /auth\.type === 'oauth2'/);
});

test('sign-in: the steps up to the signed-in check become one step that reuses the saved session; values in the environment settings', () => {
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/home');
  await page.getByLabel('User name').fill('alice');
  await page.getByLabel('Password').fill('pw-123');
  await page.getByRole('button', { name: 'Log On' }).click();
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
  await page.getByLabel('Customer').fill('north');
});`;
    const c = convertScript(ts, script);
    const p = plan(ts, c.actions, ctxOf({ files: { '.gitignore': 'node_modules/\n' } }), { name: 'Search', signIn: { marker: 4 } });
    const feature = featureOf(p);
    assert.match(feature, /Scenario Outline: Search - <testCaseId>\n    Given the user is signed in\n    When the user enters "<customer>" in Customer field/);
    assert.doesNotMatch(feature, /alice|Log On|User name/, 'the sign-in steps are folded into one');
    const steps = p.files.find((f) => f.path === 'test/shop/steps/sign-in.steps.ts')!.text;
    assert.match(steps, /@CSBDDStepDef\('the user is signed in'\)/);
    assert.match(steps, /this\.homePage\.ordersHeading\.waitForVisible\(60000\)\.then\(\(\) => 'signed in', \(\) => 'none'\)/);
    assert.match(steps, /this\.homePage\.userNameField\.waitForVisible\(60000\)\.then\(\(\) => 'sign in', \(\) => 'none'\)/);
    assert.match(steps, /\.fill\(setting\('SIGNIN_USER_NAME'\)\);[\s\S]*\.fill\(setting\('SIGNIN_PASSWORD'\)\);[\s\S]*logOnButton\.click\(\);/);
    assert.match(steps, /if \(setting\('AUTH_STORAGE_STATE_PATH'\)\) await CSBrowserManager\.getInstance\(\)\.saveStorageState\(\);/);
    const env = p.files.find((f) => f.path === 'config/shop/environments/dev.env')!.text;
    assert.match(env, /^SIGNIN_USER_NAME=alice$/m);
    assert.match(env, /^SIGNIN_PASSWORD=__CS_ENCRYPT_1__$/m, 'the password is encrypted when saved');
    assert.match(p.files.find((f) => f.path === 'config/shop/common/common.env')!.text, /^AUTH_STORAGE_STATE_PATH=\.auth\/shop-session\.json$/m);
    assert.equal(p.files.find((f) => f.path === '.gitignore')!.text, 'node_modules/\n# Signed-in sessions of test runs (CS Test Studio)\n.auth/\n');
    assert.match(p.files.find((f) => f.path.endsWith('recording-helpers.ts'))!.text, /export function setting\(key: string\): string/);
    // Studio secrets instead: the setting refers to the secret.
    const q = plan(ts, c.actions, ctxOf(), { name: 'Search', signIn: { marker: 4 }, secretMode: 'studio' });
    assert.match(q.files.find((f) => f.path === 'config/shop/environments/dev.env')!.text, /^SIGNIN_PASSWORD=\{env:HOME_PASSWORD_FIELD\}$/m);
    // Not a check of an element: no sign-in, said so.
    const x = plan(ts, c.actions, ctxOf(), { name: 'Search', signIn: { marker: 2 } });
    assert.ok(x.warnings.some((w) => /The sign-in needs/.test(w)));
});

test('business logic: a value remembered from the page and used later; a step only if shown; a unique value in each run', () => {
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/');
  await page.getByRole('button', { name: 'Accept cookies' }).click();
  await page.getByLabel('Email').fill('alice@shop.test');
  await page.getByRole('button', { name: 'Create order' }).click();
  const orderNumber = await page.getByTestId('order-no').textContent(); // = "SO-1005"
  await expect(page.getByTestId('message')).toContainText('Order SO-1005 created for alice@shop.test');
  await page.getByLabel('Search').fill('SO-1005');
  await expect(page.getByTestId('first')).toHaveText('SO-1005');
  await expect(page.getByTestId('other')).toHaveText('SO-9999');
});`;
    const c = convertScript(ts, script);
    assert.deepEqual(c.warnings, []);
    assert.equal(c.actions[4].kind, 'remember');
    assert.equal(c.actions[4].value, 'orderNumber');
    assert.deepEqual(rememberedValues(script), { orderNumber: 'SO-1005' });
    const p = plan(ts, c.actions, ctxOf(), { name: 'Order', remembered: rememberedValues(script), optional: { 1: true }, values: { 2: { mode: 'unique' } } });
    const f = featureOf(p);
    assert.match(f, /When the user clicks Accept cookies button if it is shown on the Shop Home page/);
    assert.match(f, /And the user enters a unique value like "alice@shop\.test" in Email field/);
    assert.match(f, /And the user remembers the text of order no as "orderNumber"/);
    assert.match(f, /Then message should contain the remembered "orderNumber"/, 'the most recent remembered value it contains');
    assert.match(f, /When the user enters the remembered "orderNumber" in Search field/);
    assert.match(f, /Then first should show the remembered "orderNumber"/);
    assert.match(f, /And other should show "SO-9999"/, 'another value stays as recorded');
    assert.doesNotMatch(f, /Examples/, 'nothing goes to a data file');
    const steps = p.files.filter((x) => x.kind === 'steps').map((x) => x.text).join('\n');
    assert.match(steps, /if \(await this\.shopHomePage\.acceptCookiesButton\.waitForVisible\(5000\)\.then\(\(\) => true, \(\) => false\)\) await this\.shopHomePage\.acceptCookiesButton\.click\(\);/);
    assert.match(steps, /const value = unique\(pattern\);\n        await this\.shopHomePage\.emailField\.fill\(value\);\n        remember\('email', value\);/);
    assert.match(steps, /remember\(name, \(\(await this\.shopHomePage\.orderNo\.textContent\(\)\) \?\? ''\)\.trim\(\)\);/);
    assert.match(steps, /import \{ [^}]*\bremembered\b[^}]* \} from '\.\.\/support\/recording-helpers';/);
    const h = p.files.find((x) => x.path.endsWith('recording-helpers.ts'))!.text;
    for (const fn of ['remember', 'remembered', 'unique']) assert.match(h, new RegExp(`export function ${fn}\\(`));
    // The tester's choice wins: a fixed value stays as recorded.
    const q = plan(ts, c.actions, ctxOf(), { name: 'Order', remembered: rememberedValues(script), values: { 6: { mode: 'fixed' } } });
    assert.match(featureOf(q), /When the user enters "SO-1005" in Search field/);
});

test('dates relative to today, a part of a text remembered, numbers compared with a remembered value', () => {
    // Dates: the format read from the value, or the tester's.
    assert.equal(dateOf('2026-11-28')?.format, 'yyyy-MM-dd');
    assert.equal(dateOf('28/11/2026')?.format, 'dd/MM/yyyy');
    assert.equal(dateOf('11/28/2026')?.format, 'MM/dd/yyyy');
    assert.equal(dateOf('3.4.26')?.format, 'd.M.yy');
    assert.equal(dateOf('28 Nov 2026')?.format, 'dd MMM yyyy');
    assert.equal(dateOf('Nov 28, 2026')?.format, 'MMM d, yyyy');
    assert.equal(dateOf('31/02/2026'), null, 'not a real day');
    assert.equal(dateOf('03/04/2026', 'MM/dd/yyyy')?.date.getMonth(), 2);
    const now = new Date(2026, 10, 21, 9);
    assert.equal(whenOf(new Date(2026, 10, 28, 12), now), 'today + 7 days');
    assert.equal(whenOf(new Date(2026, 10, 20, 12), now), 'today - 1 day');
    assert.equal(whenOf(new Date(2026, 10, 21, 23), now), 'today');
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/order');
  const orderNo = (await page.getByTestId('message').textContent())?.match(/SO-\\d+/)?.[0]; // = "SO-1005"
  const cartCount = await page.getByTestId('cart').textContent(); // = "2"
  await expect(Number((await page.getByTestId('cart').textContent())?.replace(/[^\\d.-]/g, ''))).toBe(Number(cartCount) + 1);
  await expect(Number((await page.getByTestId('total').textContent())?.replace(/[^\\d.-]/g, ''))).toBeGreaterThanOrEqual(100);
  await expect(Number((await page.getByTestId('cart').textContent())?.replace(/[^\\d.-]/g, ''))).not.toBe(Number(cartCount));
  await page.getByLabel('Delivery').fill('28/11/2026');
  await expect(page.getByTestId('delivery')).toContainText('28/11/2026');
});`;
    const c = convertScript(ts, script);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.actions.slice(1, 6).map((a) => `${a.kind}:${a.attribute ?? ''}:${a.value}:${a.pattern ?? ''}`), ['remember:text:orderNo:SO-\\d+', 'remember:text:cartCount:', 'expectNumber:eq:@cartCount+1:', 'expectNumber:ge:100:', 'expectNumber:ne:@cartCount+0:']);
    assert.deepEqual(rememberedValues(script), { orderNo: 'SO-1005', cartCount: '2' });
    const p = plan(ts, c.actions, ctxOf(), { name: 'Order', remembered: rememberedValues(script), values: { 6: { mode: 'date', when: 'today + 3 days' } } });
    const f = featureOf(p);
    assert.match(f, /When the user remembers the part of message like "SO-\\d\+" as "orderNo"/);
    assert.match(f, /Then cart should be equal to the remembered "cartCount" plus 1/);
    assert.match(f, /And total should be at least "100"/);
    assert.match(f, /And cart should be different from the remembered "cartCount" on/);
    assert.match(f, /When the user enters the date "today \+ 3 days" in Delivery field as dd\/MM\/yyyy/);
    assert.match(f, /Then delivery should contain the remembered "delivery"/, 'the check uses the date typed in the run');
    const steps = p.files.filter((x) => x.kind === 'steps').map((x) => x.text).join('\n');
    assert.match(steps, /const found = new RegExp\(pattern\)\.exec/);
    assert.match(steps, /await eventuallyNumber\(\(\) => this\.orderPage\.cart\.textContent\(\), 'eq', Number\(remembered\(name\)\) \+ plus,/);
    assert.match(steps, /async \w+\(name: string, plus: number\)/);
    assert.match(steps, /const value = dateFrom\(when, 'dd\/MM\/yyyy'\);/);
    const h = p.files.find((x) => x.path.endsWith('recording-helpers.ts'))!.text;
    for (const fn of ['eventuallyNumber', 'dateFrom', 'remember', 'remembered']) assert.match(h, new RegExp(`export (async )?function ${fn}\\(`));
    // The generated date helper, run: today + 3 days in the format.
    const src = /export function dateFrom[\s\S]*?\n}\n/.exec(h)![0].replace('export function', 'function').replace(/: (string|number)|as Record<string, string>/g, '');
    const dateFrom = new Function(`${src}; return dateFrom;`)() as (w: string, f: string) => string;
    const d = new Date(); d.setDate(d.getDate() + 3);
    assert.equal(dateFrom('today + 3 days', 'dd/MM/yyyy'), `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`);
    assert.match(dateFrom('today - 1 month', 'MMM d, yyyy'), /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    assert.throws(() => dateFrom('next friday', 'dd/MM/yyyy'), /A date like/);
});

test('every row of a table column (same text, containing, sorted) and waiting until a text shows (refreshing)', async () => {
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/orders-list');
  await cs.column(page.locator('#orders > tbody > tr > td:nth-child(2)'), 'equals', 'Open', { column: 'Status' });
  await cs.column(page.locator('#orders > tbody > tr > td:nth-child(1)'), 'asc', { column: 'Order' });
  await cs.column(page.locator('#orders > tbody > tr > td:nth-child(3)'), 'contains', 'Contoso', { column: 'Customer' });
  await cs.waitFor(page.getByTestId('report-status'), 'contains', 'Completed', { reload: true, seconds: 120 });
  await cs.waitFor(page.getByTestId('spinner'), 'hidden', { seconds: 30 });
});`;
    const c = convertScript(ts, script);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.actions.slice(1).map((a) => `${a.kind}:${a.attribute}:${a.value ?? ''}:${a.target?.name ?? ''}:${a.wait ? `${a.wait.reload}/${a.wait.seconds}` : ''}`), [
        'expectColumn:equals:Open:Status column:', 'expectColumn:asc::Order column:', 'expectColumn:contains:Contoso:Customer column:',
        'waitFor:contains:Completed:report-status:true/120', 'waitFor:hidden::spinner:false/30',
    ]);
    const p = plan(ts, c.actions, ctxOf(), { name: 'Orders' });
    const f = featureOf(p);
    assert.match(f, /Then every Status column should be "Open" on the Orders List page/);
    assert.match(f, /And the Order column should be sorted ascending on/);
    assert.match(f, /And every Customer column should contain "Contoso" on/);
    assert.match(f, /When the user waits until report status shows "Completed", refreshing the page, for up to 120 seconds on/);
    assert.match(f, /And the user waits until spinner is gone for up to 30 seconds on/);
    const steps = p.files.filter((x) => x.kind === 'steps').map((x) => x.text).join('\n');
    assert.match(steps, /await checkColumn\(\(\) => this\.ordersListPage\.statusColumn\.allTextContents\(\), 'equals', expected, 'The Status column'\);/);
    assert.match(steps, /await waitUntil\(async \(\) => \(await this\.ordersListPage\.reportStatus\.textContent\(\)\) \?\? '', 'contains', expected, \{ reload: true, seconds: 120 \}, 'report status'\);/);
    assert.match(steps, /await waitUntil\(async \(\) => String\(await this\.ordersListPage\.spinner\.isVisible\(\)\), 'equals', 'false', \{ reload: false, seconds: 30 \}/);
    const h = p.files.find((x) => x.path.endsWith('recording-helpers.ts'))!.text;
    assert.match(h, /import \{ CSBrowserManager \} from '@mdakhan\.mak\/cs-playwright-test-framework\/browser';/);
    // A column of a table is not "found by its position" for the standards check.
    const findings = checkPlan(ts, { title: '', warnings: [], files: p.files.map((x) => ({ path: x.path, kind: x.kind, text: x.text })) }, { ...ctxOf(), allSteps: [], loadedStepFolders: ['test/shop/steps'] } as never);
    assert.deepEqual(findings.filter((x) => x.rule === 'fragile-locator'), []);
    // The generated column check, run: natural order for codes, numbers as numbers.
    const src = ts.transpileModule(/export async function checkColumn[\s\S]*?\n}\n/.exec(h)![0].replace('export async function', 'async function'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const checkColumn = new Function(`${src}; return checkColumn;`)() as (r: () => Promise<string[]>, m: string, e: string, w: string) => Promise<void>;
    await checkColumn(async () => ['SO-9', 'SO-10', 'SO-100'], 'asc', '', 'codes');
    await checkColumn(async () => ['1,250.00', '980.50', '-3'], 'desc', '', 'amounts');
    await checkColumn(async () => ['Open ', 'Open'], 'equals', 'Open', 'status');
    await assert.rejects(checkColumn(async () => ['Open', 'Shipped'], 'equals', 'Open', 'The Status column'), /The Status column: "Shipped" is not "Open"/);
});

test('dialogs answered (OK, Cancel, a prompt) and checked; tabs switched with shared steps', () => {
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/orders-list');
  await cs.dialog('accept', 'New list name?', 'Open orders');
  await page.getByRole('button', { name: 'Rename list' }).click();
  await cs.dialog('dismiss', 'Delete order SO-0904?');
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('link', { name: 'Help' }).click();
  await cs.switchTab('new'); // https://shop.test/help
  // cs-page https://shop.test/help
  await expect(page.getByRole('heading', { name: 'Shop help' })).toBeVisible();
  await cs.switchTab(0);
});`;
    const c = convertScript(ts, script);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.actions.map((a) => `${a.kind}:${a.attribute ?? ''}:${a.value ?? ''}:${a.values?.[0] ?? ''}`), ['goto::https://shop.test/orders-list:', 'dialog:accept:New list name?:Open orders', 'click:::', 'dialog:dismiss:Delete order SO-0904?:', 'click:::', 'click:::', 'switchTab::new:', 'expectVisible:::', 'switchTab::0:']);
    const p = plan(ts, c.actions, ctxOf(), { name: 'Dialogs', values: { 1: { mode: 'fixed' } }, breaks: markedBreaks(script, c.actions) });
    const f = featureOf(p);
    assert.match(f, /When the user answers the next dialog with "Open orders" on the Orders List page\n    And the user clicks Rename list button on the Orders List page\n    Then the dialog should have said "New list name\?" on the Orders List page/);
    assert.match(f, /When the user answers the next dialog with Cancel on the Orders List page\n    And the user clicks Delete button on the Orders List page\n    Then the dialog should have said "Delete order SO-0904\?"/);
    assert.match(f, /And the user switches to the new tab\n    Then Shop help heading should be visible on the Help page\n    When the user switches to tab 1/);
    const steps = p.files.find((x) => x.path.endsWith('orders-list.steps.ts'))!.text;
    assert.match(steps, /this\.ordersListPage\.clearLastDialog\(\);\n        await this\.ordersListPage\.acceptNextDialogWithText\(answer\);/);
    assert.match(steps, /await this\.ordersListPage\.dismissNextDialog\(\);/);
    assert.match(steps, /this\.ordersListPage\.getLastDialogMessage\(\) \?\? ''/);
    assert.equal((steps.match(/the dialog should have said \{string\}/g) ?? []).length, 1, 'one check definition per page');
    const tabs = p.files.find((x) => x.path === 'test/shop/steps/browser.steps.ts')!.text;
    assert.match(tabs, /@CSBDDStepDef\('the user switches to the new tab'\)[\s\S]*switchToLatestPage\(\)/);
    assert.match(tabs, /@CSBDDStepDef\('the user switches to tab \{int\}'\)[\s\S]*switchToPage\(tab - 1\)/);
    assert.match(tabs, /No new tab opened/, 'it waits for the tab the action opened');
});

test('a check of the application data at a point of the test (read again there, with remembered values)', () => {
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/order');
  const orderNo = await page.getByTestId('order-no').textContent(); // = "SO-1005"
  // cs-data {"name":"order","column":"status","mode":"run","source":{"kind":"api","collection":"test/shop/api/shop.collection.json","request":"order1","path":"$"}}
  await cs.dataCheck('order', 'status', 'Open');
  // cs-data {"name":"row","column":"total","mode":"run","source":{"kind":"query","connection":"SHOP","sql":"SELECT total FROM orders WHERE no = ?","params":["{remembered:orderNo}"]}}
  await cs.dataCheck('row', 'total', '42.00');
});`;
    const c = convertScript(ts, script);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.actions.slice(2).map((a) => `${a.kind}:${a.values?.[0]}:${a.attribute}:${a.value}`), ['dataCheck:order:status:Open', 'dataCheck:row:total:42.00']);
    const b = dataBindings(script, c.actions);
    const p = plan(ts, c.actions, ctxOf(), { name: 'Backend', remembered: rememberedValues(script), fetched: { 2: { name: 'order', column: 'status' }, 3: { name: 'row', column: 'total' } }, sources: { order: b[2].source as never, row: b[3].source as never } });
    const f = featureOf(p);
    assert.match(f, /Then the test data "order" should have "status" equal to "Open"\n    And the test data "row" should have "total" equal to "42\.00"/);
    assert.doesNotMatch(f, /is read/, 'read where it is checked, not at the start');
    assert.deepEqual(Object.keys(JSON.parse(p.files.find((x) => x.path.endsWith('test-data-sources.json'))!.text)), ['order', 'row']);
    const s = p.files.find((x) => x.path.endsWith('test-data.steps.ts'))!.text;
    assert.match(s, /@CSBDDStepDef\('the test data \{string\} should have \{string\} equal to \{string\}'\)/);
    assert.doesNotMatch(s, /is read'\)/, 'no read step when nothing reads at the start');
    const h = p.files.find((x) => x.path.endsWith('recording-helpers.ts'))!.text;
    assert.match(h, /\{remembered:\(\\w\+\)\\\}/, 'query parameters take remembered values');
    assert.match(h, /CSScenarioContext\.getInstance\(\)\.get\(`remembered\.\$\{n\}`\) \?\? m/, 'API {{name}} takes remembered values');
});
