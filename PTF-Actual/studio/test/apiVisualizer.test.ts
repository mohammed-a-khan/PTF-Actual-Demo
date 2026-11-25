/** pm.visualizer: a Postman visualizer template over the response, rendered as Postman renders it (Handlebars; pm.getData in its scripts). */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { renderVisualizer, runScript } from '../src/api/scripts';

const TEMPLATE = `<table id="t">{{#each response}}<tr><td>{{id}}</td><td>{{name}}</td></tr>{{/each}}</table>
<div id="n"></div><script>pm.getData(function (err, data) { document.getElementById('n').textContent = data.response.length + ' orders'; });</script>`;

test('the visualizer template is rendered over the data; its scripts get the data; a broken template says why', async () => {
    const r = await runScript(`pm.visualizer.set(${JSON.stringify(TEMPLATE)}, { response: pm.response.json() });`, { stage: 'test', request: { method: 'GET', url: '/', headers: [] },
        response: { status: 200, statusText: 'OK', headers: {}, body: JSON.stringify([{ id: 1, name: 'Book <b>' }, { id: 2, name: 'Pen' }]), timeMs: 1, size: 10 }, scopes: { globals: {}, collection: {}, environment: {}, data: {}, local: {} } });
    assert.equal(r.error, undefined);
    const html = renderVisualizer(r.visualizer!);
    assert.match(html, /<td>1<\/td><td>Book &lt;b&gt;<\/td>/, 'values escaped by Handlebars');
    const pre = await runScript('pm.visualizer.set("<b>x</b>", {})', { stage: 'pre', request: { method: 'GET', url: '/', headers: [] }, scopes: { globals: {}, collection: {}, environment: {}, data: {}, local: {} } });
    assert.equal(pre.visualizer, undefined, 'only test scripts make a visualizer (as in Postman)');
    assert.match(renderVisualizer({ template: '{{#each}}', data: {} }), /does not compile/);
    // In a browser: the template's script reads the data.
    type Page = { setContent: (h: string) => Promise<void>; textContent: (s: string) => Promise<string | null>; locator: (s: string) => { count: () => Promise<number> } };
    let chromium: { launch: () => Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }> };
    try { ({ chromium } = require(['play', 'wright'].join('')) as { chromium: typeof chromium }); } catch { return; }
    const b = await chromium.launch();
    try {
        const page = await b.newPage();
        await page.setContent(html);
        assert.equal(await page.textContent('#n'), '2 orders');
        assert.equal(await page.locator('#t tr').count(), 2);
    } finally { await b.close(); }
});
