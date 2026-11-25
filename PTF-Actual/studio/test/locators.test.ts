import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { convertScript } from '../src/recorder/convert';
import { plan } from '../src/recorder/generate';
import { StudioRecorder } from '../src/recorder/studioRecorder';
import { repoPlaywright } from '../src/agents/browser';
import { alternativeOf, frameworkDir, locatorPolicy, locatorSupport, rankLocators, roleName } from '../src/framework/locators';
import { checkPlan } from '../src/framework/standards';
import type { ProjectContext } from '../src/framework/model';

/** A repository with the framework installed (its newest build): CS_RECORDER_TEST_REPO. */
const REPO = process.env.CS_RECORDER_TEST_REPO;
const latest = () => !!REPO && fs.existsSync(path.join(frameworkDir(REPO) ?? '/none', 'dist', 'element', 'CSRoleSelector.js'));

const ctx = (): ProjectContext => ({
    project: 'lab', env: 'dev', featureFolder: 'test/lab/features', pagesFolder: 'test/lab/pages', stepsFolder: 'test/lab/steps', dataFolder: 'test/lab/data',
    pages: [], steps: [], files: {},
    config: { exists: true, common: { path: 'config/lab/common/common.env', text: '' }, envFile: { path: 'config/lab/environments/dev.env', text: 'BASE_URL=https://lab.test\n' }, values: { BASE_URL: 'https://lab.test' }, stepPath: null, stepsLoaded: true },
} as ProjectContext);

const mark = (code: string, fw: Array<{ key: string; value: string; score: number }>) => `  // cs-locator ${JSON.stringify({ code, fw })}`;

test('framework locators: role names quoted as the framework reads them; alternatives with its prefixes', () => {
    assert.equal(roleName('button', 'Pay', false), 'button[name="Pay"]');
    assert.equal(roleName('button', 'Say "hi" \\ now', true), 'button[name="Say \\"hi\\" \\\\ now"s]');
    assert.deepEqual([{ key: 'testId', value: 'pay' }, { key: 'role', value: 'button[name="Pay"]' }, { key: 'text', value: 'Pay' }, { key: 'placeholder', value: 'Card' }, { key: 'id', value: 'pay' }, { key: 'name', value: 'u' }]
        .map((x) => alternativeOf(x as never)), ['testId:pay', 'role:button[name="Pay"]', 'text:Pay', 'placeholder:Card', 'css:#pay', 'css:[name="u"]']);
});

test('framework locators confirmed while recording become the element: best as its locator, the others as alternatives with selfHeal', () => {
    const pay = "page.getByRole('button', { name: 'Pay' })";
    const card = "page.getByPlaceholder('Card number')";
    const status = "page.getByTestId('status')";
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://lab.test/pay');
  await ${card}.fill('4111');
  await ${pay}.click();
  await expect(${status}).toContainText('Paid');
${mark(pay, [{ key: 'id', value: 'pay', score: 100 }, { key: 'role', value: 'button[name="Pay"]', score: 90 }, { key: 'name', value: 'payBtn', score: 95 }, { key: 'text', value: 'Pay', score: 70 }])}
${mark(card, [{ key: 'placeholder', value: 'Card number', score: 80 }])}
${mark(status, [{ key: 'testId', value: 'status', score: 100 }])}
  // cs-locator {"code": "page.getByText('x')", "fw": [{"key": "label", "value": "x", "score": 99}]}
});`;
    const c = convertScript(ts, script);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.actions.map((a) => a.target?.fw?.map((x) => x.key).join(',') ?? ''), ['', 'placeholder', 'id,role,name,text', 'testId']);
    const p = plan(ts, c.actions, ctx(), { name: 'Pay', values: { 1: { mode: 'fixed' } } });
    const page = p.files.find((f) => f.path === 'test/lab/pages/PayPage.ts')!.text;
    // id first (100); role and text as alternatives; the name alternative would be css: (not written).
    assert.match(page, /@CSGetElement\(\{ id: 'pay', selfHeal: true, alternativeLocators: \['role:button\[name="Pay"\]', 'text:Pay'\], description: 'Pay button \(Pay page\)' \}\)/);
    // A placeholder is not an option the framework finds an element by: the recorded locator, the placeholder as alternative.
    assert.match(page, /@CSGetElement\(\{ css: 'internal:attr=\[placeholder="Card number"i\]', selfHeal: true, alternativeLocators: \['placeholder:Card number'\]/);
    assert.match(page, /@CSGetElement\(\{ testId: 'status', description: 'status \(Pay page\)' \}\)/, 'no alternatives: no selfHeal');
    assert.doesNotMatch(page, /\bpage\.(locator|getBy)/, 'comments do not look like raw page.locator() calls');
    assert.match(page, /\/\/ Recorded as getByRole\('button', \{ name: 'Pay' \}\)/);
});

test('an element the page object has is reused when a confirmed framework locator matches it', () => {
    const theirs = `import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';
@CSPage('pay')
export class PayPage extends CSBasePage {
    @CSGetElement({ role: 'button[name="Pay"]', description: 'Pay' })
    public payNow!: CSWebElement;
    protected initializeElements(): void {}
}
`;
    const pay = "page.getByRole('button', { name: 'Pay' })";
    const c = convertScript(ts, `import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://lab.test/pay');
  await ${pay}.click();
${mark(pay, [{ key: 'id', value: 'pay', score: 100 }, { key: 'role', value: 'button[name="Pay"]', score: 90 }])}
});`);
    const { parsePageObject } = require('../src/framework/code') as typeof import('../src/framework/code');
    const existing = parsePageObject(ts, theirs, 'test/lab/pages/PayPage.ts')!;
    const p = plan(ts, c.actions, { ...ctx(), pages: [existing], files: { [existing.file]: theirs } }, { name: 'Pay' });
    // Their element (same role and name) is used: the page only gets the open() it lacked for the recorded goto.
    const upd = p.files.find((f) => f.path === existing.file)!.text;
    assert.equal((upd.match(/@CSGetElement/g) ?? []).length, 1, 'no new element');
    assert.match(upd, /public async open\(\)/);
    assert.match(p.files.find((f) => f.path === 'test/lab/steps/pay.steps.ts')!.text, /this\.payPage\.payNow\.click\(\)/);
});

test('the review uses the framework\'s own locator linter on page objects (what the change adds)', (t) => {
    if (!REPO || !locatorSupport(REPO).parseFile) { t.skip('No framework with the locator linter (CS_RECORDER_TEST_REPO)'); return; }
    const sup = locatorSupport(REPO);
    assert.equal(sup.score('testId', 'x'), 100);
    if (latest()) { assert.equal(sup.roleNames, true); assert.equal(sup.score('role', 'button[name="Pay"]'), 90); }
    const before = `@CSPage('pay')
export class PayPage extends CSBasePage {
    @CSGetElement({ css: 'div > div > span > a > b', description: 'old' })
    public old!: CSWebElement;
}
`;
    const after = before.replace('}\n', `    // Recorded as page.locator('#total')
    @CSGetElement({ css: 'internal:role=button[name="Pay"i]', description: 'Pay' })
    public pay!: CSWebElement;
    @CSGetElement({ role: 'button[name="Save"]', selfHeal: true, alternativeLocators: ['testId:save', 'text:Save'], description: 'Save' })
    public save!: CSWebElement;
}
`);
    const model = { ...ctx(), allSteps: [], loadedStepFolders: ['test/lab/steps'], pages: [] } as never;
    const f = checkPlan(ts, { title: 'x', warnings: [], files: [{ path: 'test/lab/pages/PayPage.ts', kind: 'page', text: after }] }, model, { repoRoot: REPO, before: () => before })
        .filter((x) => x.rule === 'locator-lint');
    assert.equal(f.length, 2, JSON.stringify(f));
    assert.ok(f.some((x) => x.level === 'warning' && /css "internal:role=button\[name="Pay"i\]" 45 \(fragile\)/.test(x.message)), 'a css locator is fragile for the framework');
    assert.ok(f.some((x) => x.level === 'error' && /page\.locator\('#total'\)/.test(x.message)), 'raw page.locator() (here in a comment) is the framework\'s policy');
    assert.ok(!f.some((x) => /div > div/.test(x.message)), 'what the file already had is not reported');
});

test('in-Studio recorder: each element\'s framework locators are confirmed on the page and written as marks', async (t) => {
    if (!REPO || !latest()) { t.skip('Needs a repository with the newest framework build (CS_RECORDER_TEST_REPO)'); return; }
    const pw = repoPlaywright(REPO);
    if (!pw) { t.skip('Playwright is not installed'); return; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return; }
    const srv = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><html><body style="margin:20px">
            <button type="button" id="pay" onclick="document.getElementById('st').textContent='Paid 1'">Pay</button>
            <button type="button">Pay later</button>
            <input name="card" placeholder="Card number" aria-label="Card number">
            <span data-testid="status" id="st">Unpaid</span></body></html>`);
    });
    const url = await new Promise<string>((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const file = path.join(dir, 'r.spec.ts');
    const r = new StudioRecorder({ repoRoot: REPO, file, testIdAttribute: 'data-testid', onClosed: () => {} });
    try {
        await r.start(`${url}/`);
        const P = r.browser.pageNow();
        const mid = async (sel: string) => { const b = (await P.locator(sel).boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2] as [number, number]; };
        await r.click(...await mid('#pay'));
        const st = await r.propose('contains', ...await mid('#st'));
        await r.confirm('contains', st.code!, 'Paid');
        await r.click(...await mid('input'));
        await r.type('4111');
        await r.close();
        const marks = fs.readFileSync(file, 'utf8').split('\n').map((l) => /\/\/ cs-locator (\{.*\})$/.exec(l)?.[1]).filter(Boolean).map((j) => JSON.parse(j!));
        const by = (code: RegExp) => marks.find((m) => code.test(m.code))?.fw.map((x: { key: string; value: string }) => `${x.key}=${x.value}`);
        // "Pay" also names "Pay later": the role name is exact; the label text "Pay" is not unique (substring), so not used.
        assert.deepEqual(by(/name: 'Pay'/), ['id=pay', 'role=button[name="Pay"s]']);
        // The status's text is what the check reads: never a text locator.
        assert.deepEqual(by(/getByTestId\('status'\)/), ['testId=status', 'id=st']);
        assert.deepEqual(by(/Card number/), ['name=card', 'role=textbox[name="Card number"]', 'placeholder=Card number']);
    } finally {
        await r.close().catch(() => {});
        srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('locator policy: the team\'s order and the ids it ignores; a pattern that does not read is reported', () => {
    const { policy, problems } = locatorPolicy({ RECORDER_LOCATOR_ORDER: 'role, testId, bogus', RECORDER_IGNORE_ID_PATTERN: '^(mat-|cdk-)', RECORDER_IGNORE_CLASS_PATTERN: '(' });
    assert.deepEqual(policy.order, ['role', 'testId']);
    assert.ok(policy.ignoreId?.test('mat-input-3'));
    assert.equal(policy.ignoreClass, undefined);
    assert.equal(problems.length, 2, problems.join(' | '));
    assert.ok(problems.some((x) => /RECORDER_LOCATOR_ORDER: unknown bogus/.test(x)));
    assert.ok(problems.some((x) => /RECORDER_IGNORE_CLASS_PATTERN is not a regular expression/.test(x)));
    const list = [{ key: 'id', value: 'mat-input-3', score: 100 }, { key: 'testId', value: 'user', score: 100 }, { key: 'text', value: 'User', score: 70 }, { key: 'role', value: 'textbox[name="User"]', score: 85 }] as never[];
    const keys = (l: Array<{ key: string }>) => l.map((x) => x.key).join(',');
    assert.equal(keys(rankLocators(list)), 'id,testId,role,text', 'no policy: the linter\'s score (ties as recorded)');
    assert.equal(keys(rankLocators(list, policy)), 'role,testId,text', 'the policy: its order first, then the score; the generated id is gone');
    assert.deepEqual(locatorPolicy({}), { policy: {}, problems: [] });
    // It runs on every element of the application's pages: nested repetition is refused.
    const slow = locatorPolicy({ RECORDER_IGNORE_ID_PATTERN: '^(a+)+$' });
    assert.equal(slow.policy.ignoreId, undefined);
    assert.match(slow.problems[0], /nested repetition/);
});

test('the locator picker: the tester\'s choice is the element\'s locator; the policy orders the rest', () => {
    const pay = "page.getByRole('button', { name: 'Pay' })";
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://lab.test/pay');
  await ${pay}.click();
${mark(pay, [{ key: 'id', value: 'mat-button-7', score: 100 }, { key: 'testId', value: 'pay', score: 100 }, { key: 'role', value: 'button[name="Pay"]', score: 90 }, { key: 'text', value: 'Pay', score: 70 }, { key: 'placeholder', value: 'x', score: 80 }])}
});`;
    const c = convertScript(ts, script);
    const page = (o: Parameters<typeof plan>[3]) => plan(ts, c.actions, ctx(), o).files.find((f) => f.path === 'test/lab/pages/PayPage.ts')!.text;
    const el = (t: string) => /@CSGetElement\(\{ ([^\n]*) \}\)/.exec(t)![1];
    // As recorded: the best by score (the id, listed first of the 100s).
    assert.match(el(page({ name: 'Pay' })), /^id: 'mat-button-7', selfHeal: true, alternativeLocators: \['testId:pay', 'role:button\[name="Pay"\]', 'placeholder:x'\]/);
    // The project ignores generated ids: never written, not even as an alternative.
    const pol = locatorPolicy({ RECORDER_IGNORE_ID_PATTERN: '^mat-' }).policy;
    assert.match(el(page({ name: 'Pay', policy: pol })), /^testId: 'pay', selfHeal: true, alternativeLocators: \['role:button\[name="Pay"\]', 'placeholder:x', 'text:Pay'\]/);
    const p0 = plan(ts, c.actions, ctx(), { name: 'Pay', policy: pol });
    const key = p0.rows[1].elementKey!;
    assert.deepEqual(p0.rows[1].locator, { key: 'testId', value: 'pay' }, 'the review shows the locator written');
    assert.deepEqual(p0.rows[1].locators?.map((x) => x.key), ['testId', 'role', 'placeholder', 'text'], 'and the others, best first');
    // The tester picks the role: it is the locator, the test id an alternative.
    assert.match(el(page({ name: 'Pay', policy: pol, locators: { [key]: { key: 'role', value: 'button[name="Pay"]' } } })), /^role: 'button\[name="Pay"\]', selfHeal: true, alternativeLocators: \['testId:pay', 'placeholder:x', 'text:Pay'\]/);
    // A choice that is not one of the element's locators (or only an alternative) changes nothing.
    assert.match(el(page({ name: 'Pay', policy: pol, locators: { [key]: { key: 'text', value: 'Nope' } } })), /^testId: 'pay'/);
    assert.match(el(page({ name: 'Pay', policy: pol, locators: { [key]: { key: 'placeholder' as never, value: 'x' } } })), /^testId: 'pay'/);
});

test('an element only an ignored id finds: written as recorded, and the review says so', () => {
    const script = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://lab.test/pay');
  await page.locator('#mat-button-7').click();
});`;
    const c = convertScript(ts, script);
    const p = plan(ts, c.actions, ctx(), { name: 'Pay', policy: locatorPolicy({ RECORDER_IGNORE_ID_PATTERN: '^mat-' }).policy });
    assert.ok(p.warnings.some((w) => /only "#mat-button-7" finds it, an id RECORDER_IGNORE_ID_PATTERN ignores/.test(w)), p.warnings.join(' | '));
});
