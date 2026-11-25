/** Correlation rules: an ASP.NET Web Forms and a JSF application recorded; their view state and anti-forgery tokens become saved values, and the recorded session runs again for another user. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { boundaryRegex, findByRules } from '../src/api/correlationRules';
import { recordForLoad } from '../src/load/recordLoad';
import { allRequests } from '../src/api/model';
import { LoadEngine } from '../src/load/engine';
import { newScenario } from '../src/load/scenario';

test('the rules find each framework\'s values (attributes in any order, either quote)', () => {
    const html = `<form><input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEPDwUKLTk=" />
      <input value='EV123456' name='__EVENTVALIDATION' type='hidden'>
      <input type="hidden" name="javax.faces.ViewState" value="-123:456" />
      <meta name="_csrf" content="c5f-77aa"/><input type="hidden" name="flag" value="1">
      <a href="start.swe?SWECmd=GotoView&SWEC=12&_sn=AbC-9xY">go</a><input type="hidden" name="draftId" value="d-00042"></form>`;
    const f = findByRules(html, [{ name: 'X-CSRF-Token', value: 'sap-tok-1' }, { name: 'x-csrf-token', value: 'Fetch' }]);
    const by = Object.fromEntries(f.map((x) => [x.key, x]));
    assert.equal(by.viewstate.value, '/wEPDwUKLTk=');
    assert.equal(by.eventvalidation.value, 'EV123456');
    assert.equal(by.facesViewState.value, '-123:456');
    assert.equal(by.csrfToken.value, 'c5f-77aa');
    assert.deepEqual([by.swec.value, by.siebelSession.value], ['12', 'AbC-9xY']);
    assert.deepEqual([by.sapCsrfToken.kind, by.sapCsrfToken.value], ['header', 'sap-tok-1']);
    assert.equal(by.draftId.rule, 'Hidden form field');
    assert.ok(!f.some((x) => x.value === '1'), 'short flags are not values to correlate');
    for (const x of f.filter((y) => y.kind === 'regex')) assert.equal(new RegExp(x.path).exec(html)?.[1], x.value, `${x.key}: its regex finds it again`);
    assert.equal(new RegExp(boundaryRegex('orderNo: <b>', '</b>')).exec('x orderNo: <b>A-77</b> y')?.[1], 'A-77');
});

test('an ASP.NET Web Forms page recorded: view state and event validation correlated, the session replayed under load', { timeout: 60_000 }, async () => {
    const issued = new Set<string>();
    const s = http.createServer((q, r) => {
        let b = ''; q.on('data', (c) => (b += c));
        q.on('end', () => {
            if (q.method === 'GET' && q.url === '/Order.aspx') {
                const vs = `vs${require('crypto').randomBytes(8).toString('hex')}`, ev = `ev${require('crypto').randomBytes(8).toString('hex')}`;
                issued.add(`${vs}|${ev}`);
                r.writeHead(200, { 'Content-Type': 'text/html' });
                r.end(`<html><form method="post"><input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${vs}" /><input type="hidden" name="__EVENTVALIDATION" value="${ev}" /><input name="qty"></form></html>`);
                return;
            }
            if (q.method === 'POST' && q.url === '/Order.aspx') {
                const f = new URLSearchParams(b);
                const ok = issued.has(`${f.get('__VIEWSTATE')}|${f.get('__EVENTVALIDATION')}`);
                r.writeHead(ok ? 200 : 500, { 'Content-Type': 'text/html' }); r.end(ok ? '<p>Thank you</p>' : '<p>Invalid viewstate</p>');
                return;
            }
            r.writeHead(404); r.end();
        });
    });
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    try {
        const rec = await recordForLoad(`http://127.0.0.1:${port}`);
        const page = await (await fetch(`${rec.url}/Order.aspx`)).text();
        const vs = /__VIEWSTATE" id="__VIEWSTATE" value="([^"]+)"/.exec(page)![1], ev = /__EVENTVALIDATION" value="([^"]+)"/.exec(page)![1];
        const post = await fetch(`${rec.url}/Order.aspx`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ __VIEWSTATE: vs, __EVENTVALIDATION: ev, qty: '2' }).toString() });
        assert.equal(post.status, 200);
        const { collection: c, report } = await rec.stop();
        assert.deepEqual(report.correlations.map((x) => [x.rule, x.kind]).sort(), [['ASP.NET Web Forms', 'regex'], ['ASP.NET Web Forms', 'regex']]);
        const reqs = allRequests(c.items).map((x) => x.request);
        const body = JSON.stringify(reqs[1].body);
        assert.ok(!body.includes(vs) && !body.includes(ev) && /\{\{viewstate\}\}/.test(body) && /\{\{eventvalidation\}\}/.test(body), body);
        const r = await new LoadEngine({ scenario: { ...newScenario('t', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], policy: { type: 'constant', users: 3, duration: 1 } },
            collection: { baseUrl: c.baseUrl, auth: c.auth }, requests: reqs, values: { vars: {}, config: {}, env: {} }, rows: [] }).run();
        assert.ok(r.total.count >= 6 && r.total.errors === 0, `${r.total.count} requests, ${r.total.errors} errors`);
    } finally { s.close(); }
});
