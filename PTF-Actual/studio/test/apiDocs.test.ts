/** Collection documentation: HTML (self-contained, escaped, secrets as references), Markdown, and a page of the Azure DevOps wiki (created, then updated with its version). */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { collectionHtml, collectionMarkdown } from '../src/api/docs';
import { AdoClient } from '../src/ado/client';
import { ApiCollection, newCollection, newRequest } from '../src/api/model';

function coll(): ApiCollection {
    const c = { ...newCollection('Orders <API>'), baseUrl: '{config:API_URL}', description: 'Orders of the shop.', auth: { type: 'bearer', token: '{env:API_TOKEN}' } as ApiCollection['auth'],
        variables: [{ key: 'region', value: 'eu' }, { key: 'apiKey', value: '{env:PARTNER_KEY}', secret: true }] };
    c.items = [{ kind: 'folder', id: 'f', name: 'Orders', items: [
        { ...newRequest('Create order'), id: 'a', method: 'POST', url: '/orders', description: 'Places an order.\nNeeds stock.', headers: [{ key: 'X-Key', value: '{{apiKey}}' }], body: { mode: 'json', text: '{"sku":"<b>x</b>","qty":1}' },
            checks: [{ kind: 'status', value: '201' }], extract: [{ variable: 'orderId', from: 'json', path: '$.id' }], examples: [{ id: 'e', name: 'Created', status: 201, body: '{"id":"o-1"}' }] },
        { ...newRequest('Watch'), id: 'b', url: 'mqtt://broker.test', checks: [], ws: { protocol: 'mqtt', steps: [{ kind: 'expect', text: 'shipped', topic: 'orders/+' }] } },
    ] }, { ...newRequest('Health'), id: 'c', url: '/health', query: [{ key: 'deep', value: 'true' }] }] as ApiCollection['items'];
    return c;
}

test('HTML and Markdown documentation', () => {
    const h = collectionHtml(coll());
    assert.match(h, /^<!doctype html>/);
    assert.ok(!/<script|src=|href="http/i.test(h), 'self-contained: no scripts, nothing loaded');
    assert.match(h, /<title>Orders &lt;API&gt; — API<\/title>/);
    assert.match(h, /&lt;b&gt;x&lt;\/b&gt;/, 'bodies escaped');
    assert.match(h, /<b style="background:#9a6700">POST<\/b><code>\/orders<\/code>/);
    assert.match(h, /<td><code>\{\{apiKey\}\}<\/code><\/td><td><i>\(secret\)<\/i><\/td>/);
    assert.match(h, /Example: Created <span class="st">201<\/span><\/h4><pre>\{\n {2}&quot;id&quot;: &quot;o-1&quot;\n\}<\/pre>/);
    assert.match(h, /<b style="background:#57606a">MQTT<\/b>/);
    assert.match(h, /Expect <i>\(orders\/\+\)<\/i>: <code>shipped<\/code>/);
    const m = collectionMarkdown(coll());
    assert.match(m, /^# Orders <API>\n\nOrders of the shop\.\n\n\*\*Base URL:\*\* `\{config:API_URL\}` {2}\n\*\*Sign-in:\*\* Bearer token {2}\n\*\*Requests:\*\* 3/);
    assert.match(m, /\| `\{\{apiKey\}\}` \| \(secret\) \|/);
    assert.match(m, /- Orders \/ \[Create order\]\(#create-order\)/);
    assert.match(m, /## Orders\n\n### Create order\n\n`POST \/orders`\n\nPlaces an order\.\nNeeds stock\./);
    assert.match(m, /\*\*Saves\*\* `\{\{orderId\}\}` from json \$\.id/);
    assert.match(m, /`GET \/health\?deep=true`/);
    assert.ok(!m.includes('PARTNER_KEY') && !h.includes('PARTNER_KEY'), 'secret variables are shown as (secret)');
});

test('published to the Azure DevOps wiki: parents made, created, then updated with the page version', async () => {
    const calls: string[] = [];
    const pages = new Map<string, { content: string; etag: string }>();
    let n = 0;
    const client = new AdoClient({ orgUrl: 'https://dev.azure.com/lab', project: 'Shop', pat: 'x', transport: async (r) => {
        const u = new URL(r.url);
        calls.push(`${r.method} ${u.pathname.replace('/lab/Shop/_apis/', '')}${u.searchParams.get('path') ? ` ${u.searchParams.get('path')}` : ''}${r.headers['If-Match'] ? ` if-match ${r.headers['If-Match']}` : ''}`);
        if (u.pathname.endsWith('/wiki/wikis')) return { status: 200, body: JSON.stringify({ value: [{ name: 'Shop.wiki', type: 'projectWiki' }] }) };
        const p = u.searchParams.get('path')!;
        if (r.method === 'GET') { const x = pages.get(p); return x ? { status: 200, body: JSON.stringify({ path: p, content: x.content }), headers: { etag: x.etag } } : { status: 404, body: '{}' }; }
        if (pages.has(p) && r.headers['If-Match'] !== pages.get(p)!.etag) return { status: 412, body: '{"message":"The page was changed"}' };
        pages.set(p, { content: JSON.parse(r.body!).content, etag: `"v${++n}"` });
        return { status: pages.size ? 201 : 200, body: JSON.stringify({ path: p, remoteUrl: `https://dev.azure.com/lab/Shop/_wiki/wikis/Shop.wiki/1/${encodeURIComponent(p)}` }) };
    } });
    const md = collectionMarkdown(coll());
    const a = await client.putWikiPage('API/Orders', md);
    assert.equal(a.created, true);
    assert.match(a.url, /_wiki\/wikis\/Shop\.wiki/);
    assert.deepEqual(calls, ['GET wiki/wikis', 'GET wiki/wikis/Shop.wiki/pages /API/Orders', 'GET wiki/wikis/Shop.wiki/pages /API', 'PUT wiki/wikis/Shop.wiki/pages /API', 'PUT wiki/wikis/Shop.wiki/pages /API/Orders']);
    calls.length = 0;
    const b = await client.putWikiPage('API/Orders', `${md}\nchanged`, 'Shop.wiki');
    assert.equal(b.created, false);
    assert.deepEqual(calls, ['GET wiki/wikis/Shop.wiki/pages /API/Orders', 'PUT wiki/wikis/Shop.wiki/pages /API/Orders if-match "v2"']);
    assert.match(pages.get('/API/Orders')!.content, /changed$/);
});
