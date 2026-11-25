import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { StudioRecorder } from '../src/recorder/studioRecorder';
import { repoPlaywright } from '../src/agents/browser';
import { convertScript } from '../src/recorder/convert';
import * as ts from 'typescript';

/** A small application: a sign-in page (labels, a list, a check box) and a page with a frame. */
function app(): Promise<{ url: string; close: () => void }> {
    const html = (t: string, b: string) => `<!doctype html><html><head><title>${t}</title></head><body style="margin:20px;font:16px sans-serif">${b}</body></html>`;
    const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (req.url?.startsWith('/home')) return res.end(html('Home', `<h1>Welcome</h1><p data-testid="who">Signed in as alice</p><iframe name="pay" srcdoc="<label>Card number <input></label>" style="width:400px;height:60px"></iframe>`));
        res.end(html('Sign in', `<form action="/home"><label>User name <input name="u"></label><br><label>Password <input type="password" name="p"></label><br>
            <label><input type="checkbox" name="r"> Remember me</label><br><label>Country <select name="c"><option value="US">United States</option><option value="IN">India</option></select></label><br>
            <button>Sign in</button> <button type="button">Sign in with a code</button></form>`));
    });
    return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() })));
}

test('in-Studio recorder: each action is a step with a locator Playwright confirms, written before the page reacts', async (t) => {
    // A repository with Playwright (CS_RECORDER_TEST_REPO), else the framework's own.
    const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
    const pw = repoPlaywright(repoRoot);
    if (!pw) { t.skip('Playwright is not installed'); return; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return; }
    const a = await app();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const file = path.join(dir, 'r.spec.ts');
    let closed = false;
    const r = new StudioRecorder({ repoRoot, file, testIdAttribute: 'data-testid', onClosed: () => { closed = true; } });
    try {
        await r.start(`${a.url}/login`);
        const page = r.browser.pageNow();
        const at = async (sel: string) => { const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] as const; };
        await r.click(...(await at('input[name=u]')));
        await r.type('alice');
        await r.key('Tab');
        await r.type('pw-123');
        assert.deepEqual(await r.click(...(await at('input[name=r]'))), { step: "await page.getByRole('checkbox', { name: 'Remember me' }).check();" });
        const s = await r.click(...(await at('select')));
        assert.equal(s.select?.label, 'Country'); assert.deepEqual(s.select?.options.map((o) => o.value), ['US', 'IN']);
        await r.choose(['IN']);
        // "Sign in" also matches "Sign in with a code": the locator must be exact (Playwright confirms it).
        assert.deepEqual(await r.click(...(await at('button >> nth=0'))), { step: "await page.getByRole('button', { name: 'Sign in', exact: true }).click();" });
        await page.waitForURL(/home/);
        const p = await r.propose('contains', ...(await at('[data-testid=who]')));
        assert.equal(p.code, "page.getByTestId('who')"); assert.equal(p.expected, 'Signed in as alice');
        await r.confirm('contains', p.code!, 'Signed in as');
        await assert.rejects(r.confirm('visible', "page.locator('x').click(); //"), /not proposed/);
        const u = await r.propose('url'); assert.equal(u.expected, '/home');
        await r.confirm('url', u.code, u.expected);
        const fr = await page.locator('iframe').boundingBox();
        await r.click(fr.x + 200, fr.y + 25);
        await r.type('4111');
        await r.close();
        const script = fs.readFileSync(file, 'utf8');
        assert.match(script, /await page\.goto\('http:\/\/127\.0\.0\.1:\d+\/login'\);/);
        const lines = script.split('\n').filter((l) => l.startsWith('  await')).map((l) => l.trim()).slice(1);
        assert.deepEqual(lines, [
            "await page.getByRole('textbox', { name: 'User name' }).fill('alice');",
            "await page.getByRole('textbox', { name: 'Password' }).fill('pw-123');",
            "await page.getByRole('checkbox', { name: 'Remember me' }).check();",
            "await page.getByRole('combobox', { name: 'Country' }).selectOption('IN');",
            "await page.getByRole('button', { name: 'Sign in', exact: true }).click();",
            "await expect(page.getByTestId('who')).toContainText('Signed in as');",
            'await expect(page).toHaveURL(/\\/home/);',
            "await page.locator('iframe[name=\"pay\"]').contentFrame().getByRole('textbox', { name: 'Card number' }).fill('4111');",
        ]);
        // The Recorder's conversion reads every step (nothing is lost on the way to framework code).
        assert.match(script, /\/\/ cs-page http:\/\/127\.0\.0\.1:\d+\/home\?/, 'the move to another page is marked (a new page object from there on)');
        const c = convertScript(ts, script);
        assert.deepEqual(c.warnings, []);
        assert.deepEqual(c.actions.map((x) => x.kind), ['goto', 'fill', 'fill', 'check', 'select', 'click', 'expectContains', 'expectUrl', 'fill']);
        assert.deepEqual(c.actions[8].target?.frames, ['iframe[name="pay"]']);
        await new Promise((res) => setTimeout(res, 1500));
        assert.ok(closed, 'closing the browser ends the recording');
    } finally {
        await r.close().catch(() => undefined);
        a.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** A page with a file field, a styled "Browse" button (hidden field), a download, a table and a disabled button. */
function app2(): Promise<{ url: string; close: () => void }> {
    const srv = http.createServer((req, res) => {
        if (req.url?.startsWith('/report')) { res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report-20261121.csv"' }); return res.end('a,b\n1,2\n'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Files</title></head><body style="margin:20px;font:16px sans-serif">
            <label>Attachment <input type="file" id="att"></label><br>
            <input type="file" id="hidden-file" multiple style="display:none"><button type="button" onclick="document.getElementById('hidden-file').click()">Browse…</button><br>
            <a href="/report" download>Download report</a><br>
            <button type="button" disabled>Submit</button><br>
            <table id="users"><thead><tr><th>Name</th><th>Role</th><th>Email</th></tr></thead><tbody>
              <tr><td>Smith John</td><td>Admin</td><td>js@x.test</td></tr><tr><td>Lee Ann</td><td>User</td><td>la@x.test</td></tr><tr><td>Ray Bo</td><td>User</td><td>rb@x.test</td></tr>
            </tbody></table></body></html>`);
    });
    return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() })));
}

test('in-Studio recorder: uploads (file field and a "Browse" button), downloads, state, attribute, count and table-cell checks', async (t) => {
    const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
    const pw = repoPlaywright(repoRoot);
    if (!pw) { t.skip('Playwright is not installed'); return; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return; }
    const a = await app2();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const file = path.join(dir, 'r.spec.ts');
    const r = new StudioRecorder({ repoRoot, file, uploadDir: path.join(dir, 'files'), testIdAttribute: 'data-testid', onClosed: () => undefined });
    try {
        await r.start(`${a.url}/files`);
        const page = r.browser.pageNow();
        const at = async (sel: string) => { const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] as const; };
        // A file field: the Studio asks for the files; they are set on the page and kept with the recording.
        assert.deepEqual(await r.click(...(await at('#att'))), { file: { label: 'Attachment', multiple: false } });
        await r.upload([{ name: 'notes.txt', data: Buffer.from('hello') }]);
        assert.equal(await page.locator('#att').evaluate((e: any) => e.files[0]?.name), 'notes.txt');
        // A styled button that opens the file chooser: the upload is the step (not the click).
        assert.deepEqual(await r.click(...(await at('button >> text=Browse'))), { file: { label: 'Browse…', multiple: true } });
        await r.upload([{ name: 'a.csv', data: Buffer.from('1') }, { name: '../b.csv', data: Buffer.from('2') }]);
        assert.deepEqual(await page.locator('#hidden-file').evaluate((e: any) => [...e.files].map((f: any) => f.name)), ['a.csv', 'b.csv']);
        assert.deepEqual(fs.readdirSync(path.join(dir, 'files')).sort(), ['a.csv', 'b.csv', 'notes.txt'], 'names only (no folders)');
        // A download becomes a check (digits in the name may change).
        await r.click(...(await at('text=Download report')));
        for (let i = 0; i < 40 && !r.steps().some((s) => /toHaveDownloaded/.test(s.line)); i++) await new Promise((res) => setTimeout(res, 100));
        // State, attribute, count, cell.
        const st = await r.propose('enabled', ...(await at('button:has-text("Submit")')));
        assert.equal(st.expected, 'disabled');
        await r.confirm('disabled', st.code, '');
        const at2 = await r.propose('attribute', ...(await at('text=Download report')));
        assert.deepEqual((at2 as { attributes?: Array<{ name: string }> }).attributes?.map((x) => x.name).includes('href'), true);
        await r.confirm('attribute', at2.code, '/report', { attribute: 'href' });
        await assert.rejects(r.confirm('attribute', at2.code, 'x', { attribute: 'on"click' }), /attribute/);
        const n = await r.propose('count', ...(await at('text=Lee Ann')));
        assert.equal(n.expected, '3');
        await r.confirm('count', n.code, n.expected);
        const c = await r.propose('cell', ...(await at('text=la@x.test')));
        assert.equal(c.expected, 'la@x.test');
        await r.confirm('cell', c.code, c.expected);
        const h = await r.propose('hidden');
        await r.confirm('hidden', h.code, 'Upload failed');
        await r.close();
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('  await')).map((l) => l.trim()).slice(1);
        assert.deepEqual(lines, [
            "await page.getByLabel('Attachment').setInputFiles('notes.txt');",
            "await page.locator('#hidden-file').setInputFiles(['a.csv', 'b.csv']);",
            "await page.getByRole('link', { name: 'Download report' }).click();",
            'await expect(page).toHaveDownloaded(/^report-\\d+\\.csv$/);',
            "await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();",
            "await expect(page.getByRole('link', { name: 'Download report' })).toHaveAttribute('href', '/report');",
            "await expect(page.locator('#users > tbody > tr')).toHaveCount(3);",
            "await expect(page.getByRole('row', { name: 'Lee Ann' }).locator(':scope > *').nth(2)).toHaveText('la@x.test');",
            "await expect(page.getByText('Upload failed')).toBeHidden();",
        ]);
        const conv = convertScript(ts, fs.readFileSync(file, 'utf8'));
        assert.deepEqual(conv.warnings, []);
        assert.deepEqual(conv.actions.map((x) => x.kind), ['goto', 'upload', 'upload', 'click', 'expectDownload', 'expectDisabled', 'expectAttribute', 'expectCount', 'expectText', 'expectHidden']);
    } finally {
        await r.close().catch(() => undefined);
        a.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('in-Studio recorder: a test data value into the focused field or a list, marked with its source; removing the step removes the mark', async (t) => {
    const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
    const pw = repoPlaywright(repoRoot);
    if (!pw) { t.skip('Playwright is not installed'); return; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return; }
    const a = await app();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const file = path.join(dir, 'r.spec.ts');
    const r = new StudioRecorder({ repoRoot, file, testIdAttribute: 'data-testid', onClosed: () => undefined });
    try {
        await r.start(`${a.url}/login`);
        const page = r.browser.pageNow();
        const at = async (sel: string) => { const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] as const; };
        const binding = { name: 'users', column: 'login', mode: 'file' as const, source: { kind: 'file', file: 'test/x/data/users.csv' } };
        await assert.rejects(r.inject('bob', binding), /Click the field/);
        await r.click(...(await at('input[name=u]')));
        assert.deepEqual(await r.inject('bob', binding), { step: "await page.getByRole('textbox', { name: 'User name' }).fill('bob');" });
        assert.equal(await page.locator('input[name=u]').inputValue(), 'bob');
        await r.click(...(await at('select')));
        await r.inject('India', { ...binding, column: 'country' });
        assert.equal(await page.locator('select').inputValue(), 'IN', 'a list takes the value or the label');
        const lines = r.steps().map((s) => s.line);
        assert.deepEqual(lines.slice(1), [
            `// cs-data ${JSON.stringify(binding)}`,
            "await page.getByRole('textbox', { name: 'User name' }).fill('bob');",
            `// cs-data ${JSON.stringify({ ...binding, column: 'country' })}`,
            "await page.getByRole('combobox', { name: 'Country' }).selectOption('IN');",
        ]);
        r.remove(2);
        assert.deepEqual(r.steps().map((s) => s.line).slice(1), lines.slice(3), 'the step and its mark');
        const conv = convertScript(ts, fs.readFileSync(file, 'utf8'));
        assert.deepEqual(conv.actions.map((x) => x.kind), ['goto', 'select']);
    } finally {
        await r.close().catch(() => undefined);
        a.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('in-Studio recorder: remembering a value of the page (the line keeps the value seen); names checked', async (t) => {
    const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
    const pw = repoPlaywright(repoRoot);
    if (!pw) { t.skip('Playwright is not installed'); return; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return; }
    const a = await app();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const file = path.join(dir, 'r.spec.ts');
    const r = new StudioRecorder({ repoRoot, file, testIdAttribute: 'data-testid', onClosed: () => undefined });
    try {
        await r.start(`${a.url}/home`);
        const page = r.browser.pageNow();
        const b = await page.locator('[data-testid=who]').boundingBox();
        const p = await r.propose('text', b.x + 5, b.y + 5);
        assert.deepEqual(await r.remember(p.code, 'signedInAs'), { step: "const signedInAs = await page.getByTestId('who').textContent(); // = \"Signed in as alice\"", value: 'Signed in as alice' });
        await assert.rejects(r.remember(p.code, 'signedInAs'), /remembered already/);
        await assert.rejects(r.remember(p.code, 'bad name'), /A name/);
        await assert.rejects(r.remember("page.locator('x')", 'other'), /not proposed/);
        await r.close();
        const conv = convertScript(ts, fs.readFileSync(file, 'utf8'));
        assert.deepEqual(conv.actions.map((x) => `${x.kind}:${x.value}`).slice(1), ['remember:signedInAs']);
    } finally {
        await r.close().catch(() => undefined);
        a.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('in-Studio recorder: a dialog the click opens is answered from the Studio (written before the click)', async (t) => {
    const repoRoot = process.env.CS_RECORDER_TEST_REPO ?? path.resolve(__dirname, '..', '..', '..');
    const pw = repoPlaywright(repoRoot);
    if (!pw) { t.skip('Playwright is not installed'); return; }
    try { const b = await pw.chromium.launch(); await b.close(); } catch { t.skip('No Playwright browser on this computer'); return; }
    const srv = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><button onclick="document.title = confirm('Sure?') ? 'yes' : 'no'">Delete</button><button onclick="document.title = prompt('Name?', 'a') ?? 'none'">Rename</button>`); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const file = path.join(dir, 'r.spec.ts');
    const r = new StudioRecorder({ repoRoot, file, testIdAttribute: 'data-testid', onClosed: () => undefined });
    try {
        await r.start(`http://127.0.0.1:${(srv.address() as { port: number }).port}/`);
        const page = r.browser.pageNow();
        const at = async (sel: string) => { const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] as const; };
        const c1 = await r.click(...(await at('text=Delete')));
        assert.deepEqual(c1.dialog, { type: 'confirm', message: 'Sure?', defaultValue: '' });
        await r.answerDialog('dismiss');
        await page.waitForFunction(() => (globalThis as any).document.title === 'no');
        const c2 = await r.click(...(await at('text=Rename')));
        assert.equal(c2.dialog?.type, 'prompt');
        await r.answerDialog('accept', 'Bob');
        await page.waitForFunction(() => (globalThis as any).document.title === 'Bob');
        await assert.rejects(r.answerDialog('accept'), /No dialog/);
        assert.deepEqual(r.steps().map((s) => s.line).slice(1), [
            "await cs.dialog('dismiss', 'Sure?');",
            "await page.getByRole('button', { name: 'Delete' }).click();",
            "await cs.dialog('accept', 'Name?', 'Bob');",
            "await page.getByRole('button', { name: 'Rename' }).click();",
        ]);
    } finally {
        await r.close().catch(() => undefined);
        srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
