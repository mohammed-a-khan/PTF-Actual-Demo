import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { htmlText, KnowledgeBase, passages, readFolder, validateSources, words } from '../src/agents/knowledge';

test('words: split the way code names things; plurals and endings; stop words dropped', () => {
    assert.deepEqual(words('loginPage'), ['login', 'page', 'loginpage']);
    assert.deepEqual(words('LOGIN_PAGE_URL'), ['login', 'page', 'url', 'loginpageurl']);
    assert.deepEqual(words('The orders are failing'), ['order', 'fail']);
    assert.deepEqual(words('HTTPServer'), ['http', 'server', 'httpserver']);
});

test('passages: Markdown by headings, features by scenarios (with the feature line and tags), code by blocks of lines', () => {
    const md = passages({ path: 'a.md', title: 'a.md', type: 'markdown', text: '# Setup\nInstall node.\n## Sign in\nUse the qa-buyer account.\n## Data\nOrders come from SHOP_DB.' });
    assert.deepEqual(md.map((p) => [p.title, p.lines]), [['Setup', [1, 2]], ['Sign in', [3, 4]], ['Data', [5, 6]]]);
    const f = passages({ path: 'c.feature', title: 'c.feature', type: 'feature', text: '@shop\nFeature: Checkout\n\n  @smoke\n  Scenario: Pay by card\n    Given I am signed in\n\n  Scenario: Pay later\n    Given I am signed in' });
    assert.deepEqual(f.map((p) => p.title), ['Pay by card', 'Pay later']);
    assert.match(f[0].text, /^@shop\nFeature: Checkout\n {2}@smoke\n {2}Scenario: Pay by card/);
    assert.deepEqual(f[0].lines, [4, 7]);
    const code = passages({ path: 'p.ts', title: 'p.ts', type: 'code', text: Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join('\n') });
    assert.deepEqual(code.map((p) => p.lines), [[1, 60], [53, 112], [105, 130]], 'blocks of 60 lines that overlap by 8');
    assert.equal(htmlText('<h2>Orders</h2><p>Create &amp; <b>pay</b></p><script>x()</script>'), '## Orders\nCreate & pay');
});

function repo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'know-'));
    const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
    w('docs/testing.md', '# Test accounts\nSign in to the shop as **qa-buyer**; its password is the secret QA_BUYER_PASSWORD (value s3cr3t-Pa55).\n## Cookie banner\nClose the cookie banner before any click.');
    w('test/shop/features/checkout.feature', 'Feature: Checkout\n  Scenario: Pay by card\n    Given I am signed in as "qa-buyer"\n    When I pay the order by card\n    Then the order is confirmed');
    w('test/shop/pages/CheckoutPage.ts', 'export class CheckoutPage {\n  // the pay button\n  payButton = "#pay";\n  async payByCard() { /* card form */ }\n}');
    w('test/shop/data/orders.json', '{ "orders": [{ "id": 42, "total": 99.5 }] }');
    w('node_modules/x/readme.md', '# Order sign in card');
    w('reports/index.html', '<h1>Order</h1>');
    w('img/logo.png', 'PNG\u0000\u0000');
    return dir;
}

test('readFolder: readable documents only (no packages, reports, binaries); only included sub-folders', () => {
    const dir = repo();
    try {
        assert.deepEqual(readFolder(dir, undefined).map((d) => d.path).sort(), ['docs/testing.md', 'test/shop/data/orders.json', 'test/shop/features/checkout.feature', 'test/shop/pages/CheckoutPage.ts']);
        assert.deepEqual(readFolder(dir, ['docs']).map((d) => d.path), ['docs/testing.md']);
        assert.deepEqual(readFolder(dir, ['../etc']).map((d) => d.path), [], 'never outside the folder');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('index and search: the right passage first, with its source and lines; secrets masked; incremental rebuild', async () => {
    const dir = repo();
    const idx = fs.mkdtempSync(path.join(os.tmpdir(), 'know-idx-'));
    try {
        const kb = new KnowledgeBase(dir, idx, {
            mask: (t) => t.replace(/s3cr3t-Pa55/g, '••••'),
            history: () => [{ path: 'failure/abc', title: 'Checkout: payment timeout', type: 'learned', text: 'Pay by card failed with a timeout on #pay; cause: the cookie banner covered the button; fix: close it first.' }],
        });
        const r = await kb.build();
        assert.deepEqual(r.map((x) => [x.source, x.docs, x.changed]), [['repo', 4, 4], ['history', 1, 1]]);
        const hits = kb.search('how do I sign in as the buyer account');
        assert.equal(hits[0].path, 'docs/testing.md');
        assert.equal(hits[0].title, 'docs/testing.md › Test accounts');
        assert.deepEqual(hits[0].lines, [1, 2]);
        assert.equal(hits[0].sourceName, 'This repository');
        assert.match(hits[0].snippet, /qa-buyer/);
        assert.doesNotMatch(JSON.stringify(kb.read(hits[0].id)), /s3cr3t-Pa55/, 'secret values never stored');
        assert.equal(kb.search('pay button')[0].path, 'test/shop/pages/CheckoutPage.ts', 'code names split: payButton');
        assert.equal(kb.search('pay by card timeout cause')[0].source, 'history');
        assert.equal(kb.search('cookie banner', { sources: ['repo'] })[0].path, 'docs/testing.md');
        assert.deepEqual(kb.search('cookie banner', { types: ['learned'] }).map((h) => h.source), ['history']);
        assert.deepEqual(kb.search('zzz qqq'), []);
        // Read around a passage.
        const full = kb.read(kb.search('cookie banner', { sources: ['repo'] })[0].id)!;
        assert.match(full.text, /Close the cookie banner/);
        // Only the changed document is cut again.
        fs.appendFileSync(path.join(dir, 'docs/testing.md'), '\n## Refunds\nRefunds go back to the card in 3 days.');
        const r2 = await kb.build('repo');
        assert.deepEqual(r2.map((x) => [x.docs, x.changed]), [[4, 1]]);
        assert.equal(kb.search('refunds card days')[0].title, 'docs/testing.md › Refunds');
        // A new KnowledgeBase reads the stored index.
        assert.equal(new KnowledgeBase(dir, idx).search('refunds')[0].path, 'docs/testing.md');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(idx, { recursive: true, force: true }); }
});

test('sources: the team file (validated), folders, web pages; an agent limited to some sources', async () => {
    const dir = repo();
    const idx = fs.mkdtempSync(path.join(os.tmpdir(), 'know-idx-'));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'know-app-'));
    try {
        fs.writeFileSync(path.join(app, 'OrderService.java'), 'class OrderService {\n  // refunds are processed nightly by the RefundJob\n}');
        const kb = new KnowledgeBase(dir, idx, { web: async (u) => ({ title: 'API guide', text: `# Orders API\nGET /orders returns the orders (${u}).` }) });
        assert.throws(() => kb.saveSources([{ id: 'Bad Id', kind: 'repo' }]), /lower-case/);
        assert.throws(() => kb.saveSources([{ id: 'a', kind: 'repo' }, { id: 'a', kind: 'history' }]), /Two sources/);
        assert.throws(() => kb.saveSources([{ id: 'w', kind: 'url', urls: ['ftp://x'] }]), /not a web address/);
        kb.saveSources([{ id: 'repo', name: 'Tests', kind: 'repo' }, { id: 'app', name: 'Application code', kind: 'folder', path: app }, { id: 'api-docs', name: 'API docs', kind: 'url', urls: ['https://docs.example.test/orders'] }]);
        assert.ok(fs.existsSync(path.join(dir, '.cs-studio/knowledge.json')));
        await kb.build();
        assert.equal(kb.search('when are refunds processed')[0].source, 'app');
        assert.equal(kb.search('GET orders API')[0].url, 'https://docs.example.test/orders');
        assert.deepEqual(kb.status().map((s) => [s.id, s.docs]), [['repo', 5], ['app', 1], ['api-docs', 1]], 'repo: the knowledge file itself is readable too');
        // An agent with only the application's code.
        const [search, read] = kb.tools(['app']);
        const hits = await search.handler({ query: 'refunds cookie banner' }) as Array<{ source: string }>;
        assert.ok(hits.length && hits.every((h) => h.source === 'app'));
        assert.equal(await read.handler({ id: 'repo:0' }), 'That source is not available to this agent.');
        assert.match(search.description, /Application code \(app\)/);
        assert.doesNotMatch(search.description, /Tests \(repo\)/);
        // Removing a source removes its index.
        kb.saveSources([{ id: 'repo', name: 'Tests', kind: 'repo' }]);
        assert.ok(!fs.existsSync(path.join(idx, 'app.json')));
        assert.deepEqual(kb.search('refunds processed nightly').map((h) => h.source), []);
        assert.deepEqual(validateSources([{ id: 'x', kind: 'repo', include: ['docs'] }]), [{ id: 'x', name: 'x', kind: 'repo', enabled: true, include: ['docs'] }]);
    } finally { for (const d of [dir, idx, app]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('knowledge routes: work items (query) and wiki pages from Azure DevOps, built in the background, searched with links back', async () => {
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'know-srv-'));
    try {
        const dir = path.join(tmp, 'repo');
        await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
        w('config/global.env', 'ADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
        w('config/shop/environments/qa.env', 'ENVIRONMENT=qa\n');
        w('docs/notes.md', '# Notes\nThe shop runs on port 8080.');
        const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
        store.set({ name: 'ADO_PAT' }, 'pat-1');
        const asked: string[] = [];
        const transport = async (req: { url: string; method: string; body?: string | Buffer }) => {
            const u = new URL(req.url);
            asked.push(`${req.method} ${u.pathname}`);
            const json = (b: unknown) => ({ status: 200, body: JSON.stringify(b) });
            if (u.pathname.endsWith('/wit/wiql')) { assert.match(String(req.body), /IN \('User Story'/); return json({ workItems: [{ id: 501 }, { id: 502 }] }); }
            if (u.pathname.endsWith('/wit/workitems')) return json({ value: [
                { id: 501, fields: { 'System.Title': 'Refund an order', 'System.WorkItemType': 'User Story', 'System.State': 'Active', 'System.Description': '<p>A buyer asks for a <b>refund</b>.</p>', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>Refund goes back to the card within 3 days</li></ul>' } },
                { id: 502, fields: { 'System.Title': 'Checkout total wrong', 'System.WorkItemType': 'Bug', 'System.State': 'New' } }] });
            if (u.pathname.endsWith('/wiki/wikis')) return json({ value: [{ name: 'qa.wiki', type: 'projectWiki' }] });
            if (u.pathname.endsWith('/pages') && u.searchParams.get('recursionLevel') === 'full') return json({ path: '/', subPages: [{ path: '/Environments', subPages: [{ path: '/Environments/QA' }] }] });
            if (u.pathname.endsWith('/pages') && u.searchParams.get('path') === '/Environments/QA') return json({ content: '# QA\nQA uses the test card 4111 1111 1111 1111 for payments.', remoteUrl: 'https://dev.azure.com/acme/qa/_wiki/wikis/qa.wiki/2/QA' });
            if (u.pathname.endsWith('/pages')) return json({ content: '' });
            return { status: 404, body: '' };
        };
        const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk', adoTransport: transport as never });
        const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as never, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as never } : {}) }); return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return r.body; } })() as any }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.deepEqual((await call('GET', '/api/knowledge')).json.sources.map((s: { id: string }) => s.id), ['repo', 'history']);
        const put = await call('PUT', '/api/knowledge/sources', { sources: [{ id: 'repo', name: 'Tests', kind: 'repo' }, { id: 'stories', name: 'Stories and bugs', kind: 'ado-workitems' }, { id: 'wiki', name: 'Team wiki', kind: 'ado-wiki' }] });
        assert.equal(put.status, 200, JSON.stringify(put.json));
        assert.equal((await call('PUT', '/api/knowledge/sources', { sources: [{ id: 'x', kind: 'nope' }] })).status, 400);
        assert.equal((await call('POST', '/api/knowledge/build', {})).json.started, true);
        let st: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (let i = 0; i < 200; i++) { st = (await call('GET', '/api/knowledge')).json; if (!st.building && st.sources.every((s: { builtAt: string | null }) => s.builtAt)) break; await new Promise((r) => setTimeout(r, 20)); }
        assert.deepEqual(st.sources.map((s: { id: string; docs: number; errors: string[] }) => [s.id, s.docs, s.errors]), [['repo', 4, []], ['stories', 2, []], ['wiki', 1, []]]);
        const hits = (await call('GET', '/api/knowledge/search?q=' + encodeURIComponent('refund back to the card'))).json.hits;
        assert.equal(hits[0].title, 'User Story 501: Refund an order');
        assert.equal(hits[0].url, 'https://dev.azure.com/acme/qa/_workitems/edit/501');
        assert.match((await call('GET', `/api/knowledge/read?id=${hits[0].id}`)).json.text, /Acceptance criteria:\nRefund goes back to the card within 3 days/);
        const wiki = (await call('GET', '/api/knowledge/search?q=' + encodeURIComponent('test card payments QA') + '&sources=wiki')).json.hits;
        assert.equal(wiki[0].url, 'https://dev.azure.com/acme/qa/_wiki/wikis/qa.wiki/2/QA');
        assert.equal((await call('GET', '/api/knowledge/search?q=port&sources=repo')).json.hits[0].path, 'docs/notes.md');
        assert.ok(asked.some((a) => a.endsWith('/wit/wiql')) && asked.some((a) => a.endsWith('/wiki/wikis')));
        await srv.app.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('agent sessions get knowledge_search and knowledge_read, limited to the sources given; the instructions say to look things up', async () => {
    const { AgentHost } = await import('../src/agents/host');
    const { writeFakeCopilotSdk } = await import('./fakeCopilot');
    delete (global as { __fakeCopilot?: unknown }).__fakeCopilot;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'know-host-'));
    try {
        const repoDir = path.join(home, 'repo'), copy = path.join(home, 'copy');
        fs.mkdirSync(repoDir); fs.mkdirSync(copy);
        writeFakeCopilotSdk(path.join(home, 'rt'));
        const asked: Array<string[] | undefined> = [];
        const host = new AgentHost({ repoRoot: repoDir, home, runtimeDir: path.join(home, 'rt'), browser: { running: false } as never, secret: () => undefined, call: async () => ({ status: 200, body: {} }), projects: () => [], log: () => undefined,
            knowledge: (sources) => { asked.push(sources); return [{ name: 'knowledge_search', description: 'k', parameters: {}, handler: async () => 'found' }, { name: 'knowledge_read', description: 'k', parameters: {}, handler: async () => 'read' }]; } });
        await host.createMission({ title: 'M', workflow: 'G', mission: { workdir: copy, isolated: true, autoFiles: true, tools: [], knowledgeSources: ['app'] } });
        const cfg = (global as unknown as { __fakeCopilot: { lastConfig: any } }).__fakeCopilot.lastConfig; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.deepEqual(cfg.tools.filter((t: { name: string }) => t.name.startsWith('knowledge_')).map((t: { name: string }) => t.name), ['knowledge_search', 'knowledge_read']);
        assert.deepEqual(asked, [['app']]);
        assert.match(cfg.systemMessage.content, /Look things up before you assume them: knowledge_search/);
        await host.stop();
    } finally { delete (global as { __fakeCopilot?: unknown }).__fakeCopilot; fs.rmSync(home, { recursive: true, force: true }); }
});

test('search: the same text from several places is shown once (so other documents are not crowded out)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'know-dup-'));
    const idx = fs.mkdtempSync(path.join(os.tmpdir(), 'know-dup-idx-'));
    try {
        fs.mkdirSync(path.join(dir, 'docs'));
        fs.writeFileSync(path.join(dir, 'docs/guide.md'), '# Catalog\nThe catalog moved to v2; tests expect the v2 catalog version.');
        const same = (id: string) => ({ path: `mission/${id}`, title: `Mission ${id}`, type: 'learned' as const, text: `Mission ${id}abc123 fixed the catalog test: it expected catalog v1, the catalog version is v2 now.` });
        const kb = new KnowledgeBase(dir, idx, { history: () => [same('m1aaaaaaaa'), same('m2bbbbbbbb'), same('m3cccccccc')] });
        await kb.build();
        const hits = kb.search('catalog version expect v2', { k: 3 });
        assert.deepEqual(hits.map((h) => h.source).sort(), ['history', 'repo'], JSON.stringify(hits.map((h) => h.path)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(idx, { recursive: true, force: true }); }
});
