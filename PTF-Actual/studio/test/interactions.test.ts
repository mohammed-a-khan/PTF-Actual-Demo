import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { convertScript } from '../src/recorder/convert';
import { frameSpec, markedBreaks, plan } from '../src/recorder/generate';
import { checkPlan } from '../src/framework/standards';
import { parsePageObject } from '../src/framework/code';
import { StudioRecorder } from '../src/recorder/studioRecorder';
import { repoPlaywright } from '../src/agents/browser';
import type { ProjectContext } from '../src/framework/model';

const ctx = (): ProjectContext => ({
    project: 'lab', env: 'dev', featureFolder: 'test/lab/features', pagesFolder: 'test/lab/pages', stepsFolder: 'test/lab/steps', dataFolder: 'test/lab/data',
    pages: [], steps: [], files: {},
    config: { exists: true, common: { path: 'config/lab/common/common.env', text: 'BROWSER=chromium\n' }, envFile: { path: 'config/lab/environments/dev.env', text: 'BASE_URL=https://lab.test\n' }, values: { BASE_URL: 'https://lab.test' }, stepPath: null, stepsLoaded: true },
} as ProjectContext);

/** As the in-Studio recorder writes them (lines from a real recording of the interaction lab). */
const LAB = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://lab.test/lab');
  await page.locator('#outer').contentFrame().locator('#inner').contentFrame().getByRole('textbox', { name: 'Card number' }).fill('4111');
  await page.locator('#outer').contentFrame().locator('#inner').contentFrame().getByRole('button', { name: 'Pay' }).click();
  await page.getByRole('button', { name: 'Open editor' }).click();
  await cs.switchTab('new'); // https://lab.test/popup
  // cs-page https://lab.test/popup
  await page.getByRole('textbox', { name: 'Name' }).fill('Ada');
  await page.getByRole('button', { name: 'Save' }).click();
  await cs.switchTab(0);
  // cs-page https://lab.test/lab
  await page.getByRole('link', { name: 'Terms' }).click();
  await cs.switchTab('new'); // https://lab.test/terms
  // cs-page https://lab.test/terms
  await page.getByRole('checkbox', { name: 'I agree' }).check();
  await cs.closeTab();
  await cs.switchTab(0);
  // cs-page https://lab.test/lab
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Country' }).press('ArrowDown');
  await page.getByTestId('title').dblclick();
  await page.getByTestId('row').click({ button: 'right' });
  await page.getByRole('button', { name: 'Products' }).hover();
  await page.getByText('Task A').dragTo(page.getByText('Done', { exact: true }));
  await page.getByRole('slider', { name: 'Volume' }).dragTo(page.getByRole('slider', { name: 'Volume' }), { targetPosition: { x: 210, y: 8 } }); // of 300x16
  await page.getByRole('listbox', { name: 'Fruits' }).selectOption(['Apple', 'Cherry']);
});`;

test('interactions: frames, windows, tabs closed, keys, mouse, drag and drop, sliders and multi-select into framework code', () => {
    const c = convertScript(ts, LAB);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.actions.map((a) => a.kind), ['goto', 'fill', 'click', 'click', 'switchTab', 'fill', 'click', 'switchTab', 'click', 'switchTab', 'check', 'closeTab', 'switchTab',
        'pressKey', 'press', 'dblclick', 'rightclick', 'hover', 'drag', 'drag', 'select']);
    const p = plan(ts, c.actions, ctx(), { name: 'Interaction lab', breaks: markedBreaks(LAB, c.actions), values: { 1: { mode: 'fixed' }, 5: { mode: 'fixed' } } });
    const f = p.files.find((x) => x.kind === 'feature')!.text;
    for (const line of [
        'And the user switches to the new tab\n    And the user enters "Ada" in Name field on the Popup page\n    And the user clicks Save button on the Popup page\n    And the user switches to tab 1',
        'And the user checks I agree checkbox on the Terms page\n    And the user closes the tab\n    And the user switches to tab 1',
        'the user presses "Escape"\n', 'the user presses "ArrowDown" in Country field on the Lab page', 'the user double-clicks title on the Lab page',
        'the user right-clicks row on the Lab page', 'the user points at Products button on the Lab page', 'the user drags Task A onto Done on the Lab page',
        'the user drags Volume slider to "70% across, 50% down" on the Lab page', 'the user selects "<fruits>" in Fruits list on the Lab page',
    ]) assert.ok(f.includes(line), `feature has: ${line}\n${f}`);
    // Several options chosen are one value of the data row, written as a | b.
    assert.equal(JSON.parse(p.files.find((x) => x.kind === 'data')!.text).data[0].fruits, 'Apple | Cherry');
    // Frames the framework's way: the frame's elements on a CSFramePage (its frames outermost first), embedded with @CSIframe.
    const page = p.files.find((x) => x.path === 'test/lab/pages/LabPage.ts')!.text;
    assert.match(page, /import \{ CSBasePage, CSPage, CSGetElement, CSIframe \} from '@mdakhan\.mak\/cs-playwright-test-framework\/core';/);
    assert.match(page, /import \{ LabInnerFramePage \} from '\.\/LabInnerFramePage';/);
    assert.match(page, /@CSIframe\(LabInnerFramePage\)\n    public innerFrame!: LabInnerFramePage;/);
    assert.doesNotMatch(page, /frame:|Card number/, 'no frame elements on the page itself');
    const frame = p.files.find((x) => x.path === 'test/lab/pages/LabInnerFramePage.ts')!;
    assert.equal(frame.kind, 'page');
    assert.match(frame.text, /@CSPage\('lab-inner-frame'\)\nexport class LabInnerFramePage extends CSFramePage \{\n    protected frame = \[\{ id: 'outer' \}, \{ id: 'inner' \}\];/);
    assert.match(frame.text, /@CSGetElement\(\{ css: 'internal:role=textbox\[name="Card number"i\]', description: 'Card number field \(inner frame of the Lab page\)' \}\)\n    public cardNumberField!: CSWebElement;/);
    assert.doesNotMatch(frame.text, /frame: /, 'elements inherit the frame page\'s frames');
    const steps = p.files.find((x) => x.path === 'test/lab/steps/lab.steps.ts')!.text;
    assert.match(steps, /await this\.labPage\.innerFrame\.cardNumberField\.fill\(value\);/);
    assert.match(steps, /await this\.labPage\.innerFrame\.payButton\.click\(\);/);
    const findings = checkPlan(ts, { title: 'rec', warnings: [], files: p.files.map((x) => ({ path: x.path, kind: x.kind, text: x.text })) }, { ...ctx(), allSteps: [], loadedStepFolders: ['test/lab/steps'] } as never);
    assert.deepEqual(findings.filter((x) => x.level === 'error' || x.rule === 'naming').map((x) => `${x.rule}: ${x.message}`), [], 'the framework check passes');
    assert.match(steps, /this\.labPage\.row\.rightClick\(\)/);
    assert.match(steps, /this\.labPage\.title\.dblclick\(\)/);
    assert.match(steps, /this\.labPage\.productsButton\.hover\(\)/);
    assert.match(steps, /this\.labPage\.taskA\.dragTo\(this\.labPage\.done\)/);
    assert.match(steps, /dragToWithTargetPosition\(box\.width \* across \/ 100, box\.height \* \(down \?\? 50\) \/ 100, this\.labPage\.volumeSlider\)/);
    assert.match(steps, /selectOption\(option\.split\(' \| '\)\)/);
    assert.match(steps, /this\.labPage\.countryField\.press\(key\)/);
    const browser = p.files.find((x) => x.path === 'test/lab/steps/browser.steps.ts')!.text;
    assert.match(browser, /@CSBDDStepDef\('the user closes the tab'\)[\s\S]*getPage\(\)\.close\(\)/);
    assert.match(browser, /@CSBDDStepDef\('the user presses \{string\}'\)[\s\S]*keyboard\.press\(key\)/);
});

test('frames: the framework\'s frame forms; a frame page the project has is used and embedded', () => {
    assert.deepEqual(['#pay', 'iframe[name="editor"]', 'iframe[title="Payment"]', 'xpath=//iframe[2]', 'frame[name="top"]', 'iframe[title="say \\"hi\\""]'].map(frameSpec),
        ["{ id: 'pay' }", "{ name: 'editor' }", "{ title: 'Payment' }", "{ xpath: '//iframe[2]' }", "{ css: 'frame[name=\"top\"]' }", "{ css: 'iframe[title=\"say \\\\\"hi\\\\\"\"]' }"]);
    // The team's own frame page (frames written in any of the framework's forms, resolved like CSFrameResolver).
    const theirs = `import { CSFramePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';
@CSPage('payment-frame')
export class PaymentFramePage extends CSFramePage {
    protected frame = [{ id: 'outer' }, '#inner'];
    @CSGetElement({ css: 'internal:role=textbox[name="Card number"i]', description: 'Card number' })
    public cardNumber!: CSWebElement;
}
`;
    const existing = parsePageObject(ts, theirs, 'test/lab/pages/PaymentFramePage.ts')!;
    assert.deepEqual(existing.frameChain, ['#outer', '#inner']);
    const c = convertScript(ts, `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://lab.test/lab');
  await page.locator('#outer').contentFrame().locator('#inner').contentFrame().getByRole('textbox', { name: 'Card number' }).fill('4111');
  await page.locator('#outer').contentFrame().locator('#inner').contentFrame().getByRole('button', { name: 'Pay' }).click();
});`);
    const p = plan(ts, c.actions, { ...ctx(), pages: [existing], files: { [existing.file]: theirs } }, { name: 'Pay', values: { 1: { mode: 'fixed' } } });
    assert.ok(!p.files.some((f) => /LabInnerFramePage/.test(f.path)), 'no second frame page');
    const upd = p.files.find((f) => f.path === existing.file)!;
    assert.equal(upd.change, 'update');
    assert.match(upd.text, /public payButton!: CSWebElement;/, 'the new element is added to their frame page');
    assert.doesNotMatch(upd.text, /cardNumberField/, 'their element is reused');
    const host = p.files.find((f) => f.path === 'test/lab/pages/LabPage.ts')!.text;
    assert.match(host, /import \{ PaymentFramePage \} from '\.\/PaymentFramePage';/);
    assert.match(host, /@CSIframe\(PaymentFramePage\)\n    public innerFrame!: PaymentFramePage;/);
    const steps = p.files.find((f) => f.path === 'test/lab/steps/lab.steps.ts')!.text;
    assert.match(steps, /this\.labPage\.innerFrame\.cardNumber\.fill\('4111'\)|this\.labPage\.innerFrame\.cardNumber\.fill\(value\)/);
    assert.match(steps, /this\.labPage\.innerFrame\.payButton\.click\(\)/);
});

test('in-Studio recorder: nested frames, a web component, a popup window that closes itself, keys, mouse, drag and a list box', async (t) => {
    const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
    const pw = repoPlaywright(repoRoot);
    if (!pw) { t.skip('Playwright is not installed'); return; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return; }
    const html = (b: string, js = '') => `<!doctype html><html><body style="margin:20px;font:16px sans-serif">${b}<script>${js}</script></body></html>`;
    const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (req.url === '/outer') return res.end(html('<iframe id="inner" src="/inner" style="width:400px;height:60px"></iframe>'));
        if (req.url === '/inner') return res.end(html('<label>Card number <input id="card"></label>'));
        if (req.url === '/popup') return res.end(html('<label>Name <input></label><button type="button" onclick="window.close()">Save</button>'));
        res.end(html(`<iframe id="outer" src="/outer" style="width:500px;height:120px"></iframe><x-card></x-card>
            <button type="button" onclick="window.open('/popup', 'ed', 'width=400,height=300')">Open editor</button>
            <span data-testid="title">Untitled</span> <div data-testid="row" style="display:inline-block">Row</div> <button type="button">Products</button>
            <div id="a" draggable="true" style="display:inline-block;width:80px">Task A</div> <div id="d" style="display:inline-block;width:120px;height:40px">Done</div>
            <label>Fruits <select multiple size="3"><option>Apple</option><option>Banana</option><option>Cherry</option></select></label>`,
        `customElements.define('x-card', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button type="button">Add to cart</button>'; } });`));
    });
    const url = await new Promise<string>((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const file = path.join(dir, 'r.spec.ts');
    const r = new StudioRecorder({ repoRoot, file, testIdAttribute: 'data-testid', onClosed: () => {} });
    const sleep = (ms: number) => new Promise((x) => setTimeout(x, ms));
    try {
        await r.start(`${url}/`);
        const P = () => r.browser.pageNow();
        const mid = async (l: any) => { await l.waitFor(); const b = await l.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] as [number, number]; };
        await r.click(...await mid(P().frameLocator('#outer').frameLocator('#inner').locator('#card')));
        await r.type('4111');
        assert.match((await r.click(...await mid(P().locator('x-card').getByRole('button')))).step!, /getByRole\('button', \{ name: 'Add to cart' \}\)\.click\(\)/);
        await r.click(...await mid(P().getByRole('button', { name: 'Open editor' })));
        for (let i = 0; i < 50 && r.browser.tabs().length < 2; i++) await sleep(100);
        await sleep(300);
        await r.click(...await mid(P().getByRole('textbox')));
        await r.type('Ada');
        await r.click(...await mid(P().getByRole('button', { name: 'Save' })));
        for (let i = 0; i < 50 && r.browser.tabs().length > 1; i++) await sleep(100);
        await sleep(300);
        await r.key('Escape');
        await r.dblclick(...await mid(P().getByTestId('title')));
        await r.rightClick(...await mid(P().getByTestId('row')));
        await r.hoverOn(...await mid(P().getByRole('button', { name: 'Products' })));
        const [ax, ay] = await mid(P().locator('#a')); const [dx, dy] = await mid(P().locator('#d'));
        await r.drag(ax, ay, dx, dy);
        const s = await r.click(...await mid(P().getByRole('option', { name: 'Banana' })));
        assert.equal(s.select?.label, 'Fruits', 'a row of a list box is the list');
        assert.equal(s.select?.multiple, true);
        await r.choose(['Apple', 'Cherry']);
        await r.close();
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^ {2}await /.test(l)).map((l) => l.trim()).slice(1);
        assert.deepEqual(lines, [
            "await page.locator('#outer').contentFrame().locator('#inner').contentFrame().getByRole('textbox', { name: 'Card number' }).fill('4111');",
            "await page.getByRole('button', { name: 'Add to cart' }).click();",
            "await page.getByRole('button', { name: 'Open editor' }).click();",
            `await cs.switchTab('new'); // ${url}/popup`,
            "await page.getByRole('textbox', { name: 'Name' }).fill('Ada');",
            "await page.getByRole('button', { name: 'Save' }).click();",
            'await cs.switchTab(0);',
            "await page.keyboard.press('Escape');",
            "await page.getByTestId('title').dblclick();",
            "await page.getByTestId('row').click({ button: 'right' });",
            "await page.getByRole('button', { name: 'Products' }).hover();",
            "await page.getByText('Task A').dragTo(page.getByText('Done'));",
            "await page.getByRole('listbox', { name: 'Fruits' }).selectOption(['Apple', 'Cherry']);",
        ]);
    } finally {
        await r.close().catch(() => {});
        srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
