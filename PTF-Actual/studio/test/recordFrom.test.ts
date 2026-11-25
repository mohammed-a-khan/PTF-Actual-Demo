import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { StudioRecorder } from '../src/recorder/studioRecorder';
import { RecorderSessions } from '../src/recorder/session';
import { repoPlaywright } from '../src/agents/browser';

/** A shop: a coupon field, "Add to cart", "Remove", a confirm dialog, "Checkout" to another page. */
function app(): Promise<{ url: string; close: () => void }> {
    const html = (t: string, b: string) => `<!doctype html><html><head><title>${t}</title></head><body style="margin:20px;font:16px sans-serif">${b}</body></html>`;
    const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (req.url?.startsWith('/done')) return res.end(html('Done', '<h1>Thank you</h1>'));
        res.end(html('Shop', `<p id="cart">Cart (0)</p>
            <label>Coupon <input name="coupon"></label>
            <button type="button" onclick="document.getElementById('cart').textContent='Cart (1)'">Add to cart</button>
            <button type="button" onclick="if (confirm('Remove it?')) document.getElementById('cart').textContent='Cart (0)'">Remove</button>
            <button type="button" onclick="location.href='/done'">Checkout</button>`));
    });
    return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() })));
}

const steps = (file: string) => fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('await ') || l.startsWith('// cs-page'));

test('record from a step: the steps up to it are done again, new steps go after it, the later ones stay', async (t) => {
    const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
    const pw = repoPlaywright(repoRoot);
    if (!pw) { t.skip('Playwright is not installed'); return; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return; }
    const a = await app();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recfrom-'));
    const sessions = new RecorderSessions({ repoRoot, dir });
    let r: StudioRecorder | null = null;
    try {
        // 1. A recording: open, coupon, add to cart, checkout.
        const rec = await sessions.startStudio({ url: `${a.url}/shop` });
        r = sessions.studioOf(rec.id)!;
        const at = async (sel: string) => { const b = await r!.browser.pageNow().locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] as const; };
        await r.click(...(await at('input[name=coupon]')));
        await r.type('SAVE10');
        await r.key('Tab');
        await r.click(...(await at('text=Add to cart')));
        await r.click(...(await at('text=Checkout')));
        await r.browser.pageNow().waitForURL(/done/);
        await sessions.stopAndWait(rec.id);
        const file = path.join(dir, `${rec.id}.spec.ts`);
        const before = steps(file);
        assert.equal(before.filter((l) => l.startsWith('await')).length, 4, before.join('\n'));
        await assert.rejects(sessions.continueStudio('nope', 0, {}), /No such recording/);

        // 2. From step 2 (the coupon): open and coupon are done again; a new step goes after the coupon.
        const again = await sessions.continueStudio(rec.id, 1, {});
        assert.equal(again.state, 'recording');
        r = sessions.studioOf(rec.id)!;
        await r.hover(1, 1); // the replay is queued: wait for it
        assert.deepEqual({ ...r.replayState, error: r.replayState?.error ?? null }, { done: 2, total: 2, after: 1, error: null, finished: true });
        assert.equal(r.paused, false);
        const page = r.browser.pageNow();
        assert.equal(await page.locator('input[name=coupon]').inputValue(), 'SAVE10', 'the page is as it was after step 2');
        assert.equal(await page.locator('#cart').textContent(), 'Cart (0)', 'step 3 was not done');
        // A click that opens a dialog: the answer goes before that click, both after step 2.
        const d = await r.click(...(await at('text=Remove')));
        assert.equal(d.dialog?.message, 'Remove it?');
        await r.answerDialog('accept');
        await sessions.stopAndWait(rec.id);
        const after = steps(file);
        const acts = after.filter((l) => l.startsWith('await'));
        assert.deepEqual(acts.map((l) => l.replace(/\(.*$/, '').replace(/^await (page\.)?/, '')), ['goto', 'getByRole', 'cs.dialog', 'getByRole', 'getByRole', 'getByRole'], acts.join('\n'));
        assert.match(acts[2], /cs\.dialog\('accept', 'Remove it\?'\)/);
        assert.match(acts[3], /name: 'Remove'/);
        assert.match(acts[4], /name: 'Add to cart'/, 'the steps after step 2 stay, after the new ones');
        assert.match(acts[5], /name: 'Checkout'/);
        assert.equal(after.filter((l) => l.startsWith('// cs-page')).length, before.filter((l) => l.startsWith('// cs-page')).length, 'page change marks as they were');
        assert.ok(fs.readFileSync(file, 'utf8').includes('// cs-locator'), 'the framework locators of the steps stay');

        // 3. A step that cannot be done again: the replay stops there and the recording waits (paused).
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("name: 'Add to cart'", "name: 'Add to basket'"));
        await sessions.continueStudio(rec.id, 4, {});
        r = sessions.studioOf(rec.id)!;
        await r.hover(1, 1);
        assert.match(r.replayState?.error ?? '', /^Step 5 could not be done again \(.*\)\. The recording is paused: get the application to where step 5 left it, then resume\.$/);
        assert.equal(r.paused, true);
        assert.equal(r.replayState?.done, 4);
        await sessions.stopAndWait(rec.id);
        assert.deepEqual(steps(file).filter((l) => l.startsWith('await')).length, 6, 'the recording is unchanged');
    } finally {
        await r?.close().catch(() => {});
        a.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
