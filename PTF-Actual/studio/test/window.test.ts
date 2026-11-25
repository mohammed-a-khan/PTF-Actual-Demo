import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WINDOW_BINDING, WINDOW_JS, type WindowMessage } from '../src/recorder/window';
import { StudioRecorder } from '../src/recorder/studioRecorder';
import { repoPlaywright } from '../src/agents/browser';

const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
const sleep = (ms: number) => new Promise((x) => setTimeout(x, ms));
const html = (b: string, js = '') => `<!doctype html><html><body style="margin:20px;font:16px sans-serif">${b}<script>${js}</script></body></html>`;

async function playwright(t: { skip(m: string): void }): Promise<any> {
    const pw = repoPlaywright(repoRoot);
    if (!pw) { t.skip('Playwright is not installed'); return null; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return null; }
    return pw;
}

const PAGE = html(`<button id="b" type="button">Go</button> <span id="n">0</span>
    <input id="f" value="ab"> <div id="a" style="display:inline-block;width:80px;height:30px">Task A</div> <div id="d" style="display:inline-block;width:120px;height:40px">Done</div>`,
`window.clicks = 0; document.getElementById('b').addEventListener('click', () => { window.clicks++; document.getElementById('n').textContent = String(window.clicks); });
 window.keys = []; document.addEventListener('keydown', (e) => window.keys.push(e.key));`);

test('window script: the person\'s mouse and keys are sent to the recorder and kept from the page; typing is the browser\'s own', async (t) => {
    const pw = await playwright(t);
    if (!pw) return;
    const srv = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); });
    const url = await new Promise<string>((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as { port: number }).port}/`)));
    const browser = await pw.chromium.launch();
    try {
        const page = await (await browser.newContext({ viewport: { width: 800, height: 400 } })).newPage();
        const got: WindowMessage[] = [];
        await page.exposeBinding(WINDOW_BINDING, (_s: unknown, m: WindowMessage) => { got.push(m); });
        await page.addInitScript(WINDOW_JS);
        await page.goto(url);
        const mid = async (sel: string) => { const b = (await page.locator(sel).boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2] as [number, number]; };
        const next = async (n = 1) => { for (let i = 0; i < 40 && got.length < n; i++) await sleep(25); return got.splice(0); };
        const [bx, by] = await mid('#b');

        // A click: sent (after the double-click wait), not seen by the page.
        await page.mouse.click(bx, by);
        assert.deepEqual(await next(), [{ type: 'click', x: bx, y: by }]);
        assert.equal(await page.evaluate(() => (globalThis as any).clicks), 0, 'the page did not get the click');
        // A double-click: one message, not two clicks.
        await page.mouse.dblclick(bx, by);
        await sleep(400);
        assert.deepEqual(got.splice(0).map((m) => m.type), ['dblclick']);
        // A right-click; a drag.
        await page.mouse.click(bx, by, { button: 'right' });
        assert.deepEqual((await next()).map((m) => m.type), ['rightclick']);
        const [ax, ay] = await mid('#a'), [dx, dy] = await mid('#d');
        await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(dx, dy, { steps: 5 }); await page.mouse.up();
        assert.deepEqual(await next(), [{ type: 'drag', x: ax, y: ay, x2: dx, y2: dy }]);

        // Keys that act are sent (and kept from the page); typing is told (with the text before it) and typed by the browser.
        await page.locator('#f').evaluate((e: any) => { e.focus(); e.setSelectionRange(2, 2); });
        await page.keyboard.type('c');
        assert.deepEqual(await next(), [{ type: 'typing', value: 'ab' }]);
        assert.equal(await page.locator('#f').inputValue(), 'abc');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Control+KeyS');
        await page.keyboard.press('Shift+Tab');
        assert.deepEqual((await next(3)).map((m) => m.key), ['Enter', 'Control+s', 'Shift+Tab']);
        assert.deepEqual((await page.evaluate(() => (globalThis as any).keys)).filter((k: string) => !['Control', 'Shift'].includes(k)), ['c'], 'only the typed letter reached the page (and the modifier keys alone)');
        await page.keyboard.press('Control+KeyA'); // select all: the browser's own
        assert.deepEqual(await next(), []);

        // Pick mode: the element under the pointer outlined, a click picks it.
        await page.evaluate(() => { (globalThis as any).__csPick = true; });
        await page.mouse.move(bx, by);
        assert.match(await page.locator('#b').evaluate((e: any) => e.style.outline), /solid/);
        await page.mouse.click(bx, by);
        assert.deepEqual(await next(), [{ type: 'pick', x: bx, y: by }]);
        await page.evaluate(() => { (globalThis as any).__csPick = false; (globalThis as any).dispatchEvent(new Event('__csPickOff')); });
        assert.equal(await page.locator('#b').evaluate((e: any) => e.style.outline), '');

        // The page's own (untrusted) events, and the recorder's actions, are left alone.
        await page.locator('#b').evaluate((e: any) => e.click());
        assert.equal(await page.evaluate(() => (globalThis as any).clicks), 1);
        assert.deepEqual(await next(), []);
    } finally { await browser.close(); srv.close(); }
});

test('recording in a real window: the person\'s click is recorded and done, typing written when the focus moves on, a check picked in a frame', async (t) => {
    if (process.platform === 'linux' && !process.env.DISPLAY) { t.skip('No display for a visible browser window'); return; }
    const pw = await playwright(t);
    if (!pw) return;
    const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (req.url === '/inner') return res.end(html('<p data-testid="msg">Hello frame</p>'));
        res.end(html(`<label>Name <input id="name"></label> <button type="button" onclick="document.getElementById('out').textContent = 'Saved ' + document.getElementById('name').value">Save</button>
            <span id="out" data-testid="out">none</span><iframe id="fr" src="/inner" style="width:300px;height:80px"></iframe>`));
    });
    const url = await new Promise<string>((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as { port: number }).port}`)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-win-'));
    const file = path.join(dir, 'r.spec.ts');
    const r = new StudioRecorder({ repoRoot, file, testIdAttribute: 'data-testid', window: true, viewport: { width: 900, height: 500 }, onClosed: () => {} });
    try {
        await r.start(`${url}/`);
        assert.equal(r.inWindow, true);
        const P = () => r.browser.pageNow();
        const mid = async (l: any) => { await l.waitFor(); const b = await l.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] as [number, number]; };
        const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await sleep(50); };
        await P().mouse.click(...await mid(P().locator('#name')));
        await until(() => r.steps().length >= 2);
        await P().keyboard.type('Ada', { delay: 20 });
        await sleep(200);
        await P().mouse.click(...await mid(P().getByRole('button', { name: 'Save' })));
        await until(() => r.steps().some((s) => /Save/.test(s.line)));
        await P().getByTestId('out').filter({ hasText: 'Saved Ada' }).waitFor({ timeout: 5000 }); // the click was done in the window
        // A check: chosen in the Studio, picked in the window (inside a frame).
        await r.setPick('contains');
        const before = r.windowState().picked?.seq ?? 0;
        await P().mouse.click(...await mid(P().frameLocator('#fr').getByTestId('msg')));
        await until(() => (r.windowState().picked?.seq ?? 0) > before);
        const pk = r.windowState().picked!;
        const pr = await r.propose('contains', pk.x, pk.y);
        assert.match(pr.code, /locator\('#fr'\)\.contentFrame\(\)\.getByTestId\('msg'\)/);
        await r.confirm('contains', pr.code, pr.expected);
        const lines = r.steps().map((s) => s.line).filter((l) => !l.startsWith('//'));
        assert.match(lines[1], /getByRole\('textbox', \{ name: 'Name' \}\)\.fill\('Ada'\)/);
        assert.match(lines[2], /getByRole\('button', \{ name: 'Save' \}\)\.click\(\)/);
        assert.match(lines[3], /contentFrame\(\)\.getByTestId\('msg'\)\)\.toContainText\('Hello frame'\)/);
    } finally {
        await r.close().catch(() => undefined);
        srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
