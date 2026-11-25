import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { StudioRecorder } from '../src/recorder/studioRecorder';
import { repoPlaywright } from '../src/agents/browser';

/**
 * A small shop: "Add to cart" raises the cart counter and shows a message; "Clear" removes an error message;
 * "Checkout" opens another page with a heading. A field has a generated id (mat-input-7).
 */
function app(): Promise<{ url: string; close: () => void }> {
    const html = (t: string, b: string) => `<!doctype html><html><head><title>${t}</title></head><body style="margin:20px;font:16px sans-serif">${b}</body></html>`;
    const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (req.url?.startsWith('/done')) return res.end(html('Order placed', '<h1>Thank you for your order</h1><p>Order SO-1005</p>'));
        res.end(html('Shop', `<p id="cart">Cart (0)</p><div id="msgs"></div>
            <div role="alert" id="err">Card declined</div>
            <label>Coupon <input id="mat-input-7"></label>
            <span class="clock">10:41</span>
            <button type="button" onclick="document.getElementById('cart').textContent='Cart (1)'; var m=document.createElement('div'); m.className='toast toast-success'; m.textContent='Added to cart'; document.getElementById('msgs').appendChild(m); document.querySelector('.clock').textContent='10:42'">Add to cart</button>
            <button type="button" onclick="document.getElementById('err').remove()">Clear</button>
            <button type="button" onclick="location.href='/done'">Checkout</button>`));
    });
    return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() })));
}

test('in-Studio recorder: checks suggested from what a click changed; accepted ones are steps; the locator policy applies', async (t) => {
    const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
    const pw = repoPlaywright(repoRoot);
    if (!pw) { t.skip('Playwright is not installed'); return; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return; }
    const a = await app();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const file = path.join(dir, 'r.spec.ts');
    const r = new StudioRecorder({ repoRoot, file, testIdAttribute: 'data-testid', policy: { ignoreId: '^mat-' }, onClosed: () => {} });
    // The suggestions are worked out after the click (the next input waits for them): wait for the queue.
    const settled = async () => { await r.hover(1, 1); return r.suggested(); };
    try {
        await r.start(`${a.url}/shop`);
        const page = r.browser.pageNow();
        const at = async (sel: string) => { const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] as const; };

        // The policy: the generated id is never the locator (the label is).
        await r.click(...(await at('#mat-input-7')));
        await r.type('SAVE10');
        await r.key('Tab');
        assert.ok(r.steps().some((s) => s.line === "await page.getByRole('textbox', { name: 'Coupon' }).fill('SAVE10');"), r.steps().map((s) => s.line).join('\n'));
        assert.ok(!fs.readFileSync(file, 'utf8').includes('mat-input-7'), 'the generated id is not in the recording (nor its framework locators)');

        await r.click(...(await at('text=Add to cart')));
        const s1 = await settled();
        assert.ok(s1, 'checks are suggested');
        const items = s1!.items.map((x) => `${x.kind}|${x.expected}|${x.why}`);
        // The message first (it announces), then the counter that changed; the clock is not worth a check.
        assert.match(items[0], /^contains\|Added to cart\|A message appeared$/);
        assert.ok(items.some((x) => /^text\|Cart \(1\)\|A text changed \(was "Cart \(0\)"\)$/.test(x)), items.join('\n'));
        assert.ok(!items.some((x) => x.includes('10:42')), 'a clock is not suggested');
        assert.ok(!items.some((x) => x.startsWith('url|')), 'the address did not change');
        // Accept the counter: a step with the confirmed locator; it is no longer suggested.
        const cart = s1!.items.find((x) => x.kind === 'text')!;
        const { step } = await r.confirm(cart.kind, cart.code, cart.expected);
        assert.equal(step, "await expect(page.locator('#cart')).toHaveText('Cart (1)');");
        assert.ok(!r.suggested()!.items.some((x) => x.code === cart.code));
        // Dismiss the message.
        const msg = r.suggested()!.items[0];
        r.dropSuggestion(msg.kind, msg.code, msg.expected);
        assert.equal(r.suggested(), null, 'nothing left');

        // A message that goes away: "not shown".
        await r.click(...(await at('text=Clear')));
        const s2 = await settled();
        assert.deepEqual(s2?.items.map((x) => `${x.kind}|${x.code}|${x.expected}`), ['hidden|page|Card declined']);

        // Another page: the address, the title and its heading; not every text of the new page.
        await r.click(...(await at('text=Checkout')));
        await page.waitForURL(/done/);
        const s3 = await settled();
        assert.deepEqual(s3?.items.map((x) => `${x.kind}|${x.expected}`), ['url|/done', 'title|Order placed', 'text|Thank you for your order']);
        assert.equal(s3!.items[2].code, "page.getByRole('heading', { name: 'Thank you for your order' })");
        // The next action clears them.
        await r.navigate(`${a.url}/shop`);
        assert.equal(r.suggested(), null);

        // An input that comes while the click is still being handled: the click's changes are not suggested
        // (they would mix with the input's), and nothing appears after that input.
        const quick = r.click(...(await at('text=Add to cart')));
        const typed = r.key('Escape');
        await quick; await typed;
        assert.equal(await settled(), null, 'a suggestion worked out for an earlier action is dropped');

        // Off: nothing suggested.
        r.suggest = false;
        await r.click(...(await at('text=Add to cart')));
        assert.equal(await settled(), null);
        await r.close();
        const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('await expect'));
        assert.deepEqual(lines, ["await expect(page.locator('#cart')).toHaveText('Cart (1)');"], 'only the accepted check is a step');
    } finally {
        await r.close().catch(() => {});
        a.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
