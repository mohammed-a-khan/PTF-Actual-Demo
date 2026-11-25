import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bugReproHtml, bugsForTagsQuery, readTriage, signatureTag, TRIAGE_PATH, writeTriage } from '../src/quality/triage';
import { failureSignature } from '../src/quality/quality';
import { runGit } from '../src/git/run';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';

test('signature tags are the framework\'s (same signature, same tag)', () => {
    // The framework's smoke test pins these signatures for the same messages (test/ado-publish-smoke).
    const sig = failureSignature('Timeout 30000ms exceeded waiting for locator "#result-12"');
    assert.equal(sig, 'Timeout <n> exceeded waiting for locator "#result-<n>"', 'the element a locator names is kept, its numbers not');
    assert.equal(signatureTag(sig), signatureTag(failureSignature('Timeout 45000ms exceeded waiting for locator "#result-7"')), 'rows of a list: one cause');
    assert.notEqual(failureSignature('Timeout 30000ms exceeded waiting for locator "#checkout-total"'), sig, 'another element: another cause');
    assert.equal(failureSignature('Expected total "10.25" but got "9.00"'), 'Expected total "…" but got "…"', 'data values left out');
    const ex = (l: string) => `Error: expect(locator).toHaveText(expected) failed\n\nLocator: ${l}\nExpected: "Paid"\nReceived: "Unpaid"`;
    assert.equal(failureSignature(ex("getByTestId('status')")), "Error: expect(locator).toHaveText(expected) failed @ getByTestId('status')");
    assert.notEqual(failureSignature(ex("getByTestId('status')")), failureSignature(ex("getByTestId('total')")));
    assert.equal(failureSignature('Expected status 503 but got 200 from https://shop.example/api/x'), 'Expected status 503 but got 200 from <url>');
    assert.match(signatureTag('x'), /^cs-failure-[0-9a-f]{12}$/);
});

test('triage file: set, change, remove; sorted, tags only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    const a = signatureTag('A'), b = signatureTag('B');
    writeTriage(root, b, { signature: 'B', verdict: 'flaky', note: 'shared data', by: 'T' });
    writeTriage(root, a, { signature: 'A', verdict: 'product-bug', bug: 42, by: 'T' });
    const text = fs.readFileSync(path.join(root, TRIAGE_PATH), 'utf8');
    assert.ok(text.indexOf(a) < text.indexOf(b) === a < b, 'keys sorted');
    assert.deepEqual(readTriage(root)[a], { signature: 'A', verdict: 'product-bug', bug: 42, by: 'T', at: readTriage(root)[a].at });
    writeTriage(root, b, null);
    assert.deepEqual(Object.keys(readTriage(root)), [a]);
    writeTriage(root, a, { signature: 'A' });
    assert.deepEqual(readTriage(root), {}, 'nothing left in it: removed');
    assert.throws(() => writeTriage(root, '../x', { signature: 'x', verdict: 'flaky' }), /Invalid/);
    fs.writeFileSync(path.join(root, TRIAGE_PATH), JSON.stringify({ entries: { 'not-a-tag': { verdict: 'flaky' }, [a]: { verdict: 'nonsense', bug: -1, note: 'n' } } }));
    assert.deepEqual(Object.keys(readTriage(root)), [a], 'unknown keys dropped');
    assert.equal(readTriage(root)[a].verdict, undefined, 'unknown verdict dropped');
    assert.equal(readTriage(root)[a].bug, undefined);
    fs.rmSync(root, { recursive: true, force: true });
});

test('bug text is escaped HTML; the bug query takes tags only', () => {
    const html = bugReproHtml({ signature: 'Expected <b>', sample: 'got <script>', failures: 3, runs: 2, firstSeen: 'a', lastSeen: 'b', scenarios: [{ name: 'Pay & go', feature: 'Shop' }] });
    assert.match(html, /Pay &amp; go/);
    assert.ok(!html.includes('<script>') && html.includes('got &lt;script&gt;') && html.includes('Expected &lt;b&gt;'));
    assert.match(bugsForTagsQuery([signatureTag('A'), "x' OR 1=1"]), /CONTAINS 'cs-failure-[0-9a-f]{12}'\)/);
    assert.ok(!bugsForTagsQuery([signatureTag('A'), "x' OR 1=1"]).includes('1=1'));
    assert.throws(() => bugsForTagsQuery(['nope']), /No failure tags/);
});

test('triage over the API: causes carry their tag and triage, bugs found by tag, a bug filed, run failures matched (simulated ADO)', async () => {
    const { createServer } = await import('../src/server/server');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-srv-'));
    const dir = path.join(tmp, 'shop-tests');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'config', 'shop', 'environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'global.env'), 'ADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    fs.writeFileSync(path.join(dir, 'config', 'shop', 'environments', 'dev.env'), 'BASE_URL=http://localhost\n');
    const report = (name: string, at: string, error: string) => {
        const d = path.join(dir, 'reports', name, 'reports');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'report-data.json'), JSON.stringify({ suite: { startTime: at, scenarios: [{ name: 'Search', feature: 'Shop', status: 'failed', duration: 5, error }, { name: 'Basket', feature: 'Shop', status: 'passed', duration: 5 }] } }));
    };
    report('test-results-1', '2026-11-20T08:00:00.000Z', 'Timeout 30000ms exceeded waiting for locator "#result-12"');
    report('test-results-2', '2026-11-21T08:00:00.000Z', 'Timeout 31000ms exceeded waiting for locator "#result-3"');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const tag = signatureTag(failureSignature('Timeout 30000ms exceeded waiting for locator "#result-12"'));
    const calls: Array<{ method: string; path: string; body?: any; type?: string }> = [];
    const transport = async (req: any) => {
        const u = new URL(req.url);
        calls.push({ method: req.method, path: u.pathname, body: req.body ? JSON.parse(req.body) : undefined, type: req.headers?.['Content-Type'] ?? req.headers?.['content-type'] });
        if (u.pathname.endsWith('/_apis/wit/wiql')) return { status: 200, body: JSON.stringify({ workItems: [{ id: 501 }] }) };
        if (u.pathname.endsWith('/_apis/wit/workitems')) return { status: 200, body: JSON.stringify({ value: [
            { id: 501, fields: { 'System.Title': 'Search times out', 'System.State': 'Resolved', 'System.Tags': `automation; ${tag}`, 'System.ChangedDate': '2026-11-20T12:00:00Z', 'Microsoft.VSTS.Common.ResolvedDate': '2026-11-20T12:00:00Z', 'System.WorkItemType': 'Bug' } },
        ] }) };
        if (u.pathname.endsWith('/_apis/wit/workitems/$Bug')) return { status: 200, body: JSON.stringify({ id: 777 }) };
        return { status: 404, body: '' };
    };
    const srv = createServer({ repoRoot: dir, store, userName: 'T', adoTransport: transport, token: 'tk' });
    const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as any, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as any } : {}) }); return { status: r.statusCode, json: r.json() as any }; };

    const q = await call('GET', '/api/quality?project=all');
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const g = q.json.groups[0];
    assert.equal(g.tag, tag, 'the cause\'s tag is the one the framework tags its bugs with');
    assert.equal(g.triage, undefined);

    const bugs = await call('POST', '/api/triage/bugs', { tags: [g.tag], ids: [] });
    assert.equal(bugs.status, 200, JSON.stringify(bugs.json));
    assert.deepEqual(bugs.json.bugs.map((b: any) => [b.id, b.state, b.tags, b.url]), [[501, 'Resolved', [tag], 'https://dev.azure.com/acme/qa/_workitems/edit/501']]);
    assert.match(calls.find((c) => c.path.endsWith('/wiql'))!.body.query, new RegExp(`CONTAINS '${tag}'`));

    assert.equal((await call('PUT', '/api/triage', { tag: 'cs-failure-zzz', signature: 's', verdict: 'flaky' })).status, 400);
    assert.equal((await call('PUT', '/api/triage', { tag, signature: g.signature, verdict: 'wrong' })).status, 400);
    const set = await call('PUT', '/api/triage', { tag, signature: g.signature, verdict: 'environment', note: 'search index rebuilds at 08:00' });
    assert.equal(set.status, 200);
    assert.equal((await call('GET', '/api/quality?project=all')).json.groups[0].triage.verdict, 'environment');
    assert.ok(fs.existsSync(path.join(dir, '.cs-studio', 'triage.json')), 'kept in the repository (committed with the team)');

    const m = await call('POST', '/api/triage/match', { errors: ['Timeout 99ms exceeded waiting for locator "#result-5"', 'Something else', ''] });
    assert.deepEqual(m.json.matches.map((x: any) => x && x.verdict), ['environment', null, null], 'a run\'s failure with the same cause is known');

    assert.equal((await call('POST', '/api/triage/bug', { tag, title: 'Search times out' })).status, 400, 'filing needs confirmation');
    const filed = await call('POST', '/api/triage/bug', { tag, title: 'Search times out', confirm: true });
    assert.equal(filed.status, 200, JSON.stringify(filed.json));
    assert.equal(filed.json.id, 777);
    const create = calls.find((c) => c.path.endsWith('/$Bug'))!;
    assert.match(create.type ?? '', /json-patch/);
    const fields = Object.fromEntries(create.body.map((o: any) => [o.path, o.value]));
    assert.equal(fields['/fields/System.Tags'], `automation; ${tag}`, 'tagged like the framework\'s bugs');
    assert.match(fields['/fields/Microsoft.VSTS.TCM.ReproSteps'], /Search \(Shop\)/);
    const entry = readTriage(dir)[tag];
    assert.deepEqual([entry.verdict, entry.bug, entry.note], ['environment', 777, 'search index rebuilds at 08:00'], 'the bug is linked, the verdict and note kept');
    assert.equal((await call('POST', '/api/triage/bug', { tag: signatureTag('gone'), title: 'x', confirm: true })).status, 400, 'a cause not in the runs');
    await srv.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});
