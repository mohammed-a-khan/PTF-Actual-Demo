/**
 * Postman scripts (pm API) in the Studio: a collection as teams write it in Postman (a login whose token a
 * pre-request script sets, chai assertions, pm.sendRequest, setNextRequest to loop, collection-level scripts) is
 * imported, run by the Studio's runner and by Postman's own runner (Newman), and every pm.test has the same result.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { importCollection } from '../src/api/collectionImport';
import { exportReport } from '../src/api/collectionExport';
import { allRequests } from '../src/api/model';
import { CollectionRunner } from '../src/api/runner';
import { runScript } from '../src/api/scripts';

function app() {
    let pages = 0;
    const s = http.createServer((q, r) => {
        let b = ''; q.on('data', (c) => (b += c));
        q.on('end', () => {
            const json = (st: number, o: unknown) => { r.writeHead(st, { 'Content-Type': 'application/json', 'X-Trace': 'tr-1' }); r.end(JSON.stringify(o)); };
            if (q.url === '/login') { const u = JSON.parse(b || '{}'); return u.user === 'qa' ? json(200, { token: 'tok-123', expires: 60 }) : json(401, { error: 'bad user' }); }
            if (q.url!.startsWith('/orders?page=')) {
                if (q.headers.authorization !== 'Bearer tok-123') return json(401, { error: 'no token' });
                const page = Number(q.url!.split('=')[1]);
                pages++;
                return json(200, { page, items: [{ id: page * 10 + 1, total: 25.5 }, { id: page * 10 + 2, total: 4.5 }], next: page < 3 ? page + 1 : null });
            }
            if (q.url === '/config') return json(200, { currency: 'EUR', minTotal: 1 });
            if (q.url === '/settings') return json(200, { currency: 'EUR' });
            r.writeHead(404); r.end();
        });
    });
    return { s, pages: () => pages };
}

const collection = (base: string) => ({
    info: { name: 'Scripted', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'baseUrl', value: base }, { key: 'user', value: 'qa' }],
    event: [
        { listen: 'prerequest', script: { exec: ["pm.collectionVariables.set('requestedAt', String(Date.now()));"] } },
        { listen: 'test', script: { exec: ["pm.test('every response is JSON', function () { pm.response.to.be.json; });"] } },
    ],
    item: [
        { name: 'Login', request: { method: 'POST', url: '{{baseUrl}}/login', header: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: '{"user":"{{user}}"}' } },
            event: [{ listen: 'test', script: { exec: [
                "const body = pm.response.json();",
                "pm.test('login works', () => { pm.expect(pm.response.code).to.equal(200); pm.expect(body.token).to.be.a('string').and.match(/^tok-/); });",
                "pm.environment.set('token', body.token);",
                "pm.environment.set('page', '1');",
                "pm.test('the trace header is there', () => pm.response.to.have.header('X-Trace', 'tr-1'));",
            ] } }] },
        { name: 'Orders page', request: { method: 'GET', url: '{{baseUrl}}/orders?page={{page}}', header: [] },
            event: [
                { listen: 'prerequest', script: { exec: ["pm.request.headers.upsert({ key: 'Authorization', value: 'Bearer ' + pm.environment.get('token') });"] } },
                { listen: 'test', script: { exec: [
                    "const j = pm.response.json();",
                    "pm.test('page ' + j.page + ' has 2 items', () => pm.expect(j.items).to.have.lengthOf(2));",
                    "pm.test('totals over ' + pm.environment.get('minTotal'), () => j.items.forEach((i) => pm.expect(i.total).to.be.above(Number(pm.environment.get('minTotal')))));",
                    "pm.test('a deliberately wrong expectation', () => pm.expect(j.items[0].total).to.equal(30));",
                    "const sum = require('lodash').sumBy(j.items, 'total');",
                    "pm.test('lodash sums the page', () => pm.expect(sum).to.equal(30));",
                    "if (j.next) { pm.environment.set('page', String(j.next)); postman.setNextRequest('Orders page'); } else { postman.setNextRequest('Config'); }",
                ] } },
            ] },
        { name: 'Skipped by the loop', request: { method: 'GET', url: '{{baseUrl}}/nothing-here' },
            event: [{ listen: 'test', script: { exec: ["pm.test('never runs', () => pm.expect(true).to.be.false);"] } }] },
        { name: 'Config', request: { method: 'GET', url: '{{baseUrl}}/config' },
            event: [
                { listen: 'prerequest', script: { exec: ["pm.sendRequest(pm.variables.get('baseUrl') + '/settings', function (err, res) { pm.environment.set('fromSend', res.json().currency); });"] } },
                { listen: 'test', script: { exec: [
                    "pm.test('sendRequest result was set before the request', () => pm.expect(pm.environment.get('fromSend')).to.eql('EUR'));",
                    "pm.test('currency', () => pm.expect(pm.response.json()).to.have.property('currency', 'EUR'));",
                    "postman.setNextRequest(null);",
                ] } },
            ] },
    ],
});

test('scripts: the sandbox (variables, request changes, chai, errors, time limit, no Node access)', async () => {
    const scopes = () => ({ globals: {}, collection: { a: '1' }, environment: {}, data: { row: 'r' }, local: {} });
    let r = await runScript("pm.environment.set('x', 5); pm.variables.set('y', 'local'); pm.request.headers.add({ key: 'X-A', value: pm.variables.get('row') }); pm.request.url = pm.request.url.toString() + '?z=1';", { stage: 'pre', request: { method: 'GET', url: '/p', headers: [] }, scopes: scopes() });
    assert.deepEqual([r.request.headers, r.request.url, r.error], [[{ key: 'X-A', value: 'r' }], '/p?z=1', undefined]);
    r = await runScript("require('fs')", { stage: 'pre', request: { method: 'GET', url: '/', headers: [] }, scopes: scopes() });
    assert.match(r.error!, /require\('fs'\) is not available/);
    r = await runScript("process.exit(1)", { stage: 'pre', request: { method: 'GET', url: '/', headers: [] }, scopes: scopes() });
    assert.match(r.error!, /process is not defined/);
    r = await runScript("while (true) {}", { stage: 'pre', request: { method: 'GET', url: '/', headers: [] }, scopes: scopes(), timeoutMs: 200 });
    assert.match(r.error!, /timed out/i);
    r = await runScript("pm.test('fails', () => pm.expect(pm.response.code).to.equal(201)); pm.test('async', async () => { await Promise.resolve(); pm.expect(1).to.equal(1); }); tests['old style'] = responseCode.code === 200; console.log('hi', {a: 1});",
        { stage: 'test', request: { method: 'GET', url: '/', headers: [] }, response: { status: 200, statusText: 'OK', headers: {}, body: '{}', timeMs: 5, size: 2 }, scopes: scopes() });
    assert.deepEqual(r.tests.map((t) => [t.name, t.pass]).sort(), [['async', true], ['fails', false], ['old style', true]]);
    assert.match(r.tests.find((t) => t.name === 'fails')!.error!, /expected 200 to equal 201/);
    assert.deepEqual(r.logs, [{ level: 'log', text: 'hi {"a":1}' }]);
});

test('a scripted Postman collection: the Studio runner and Newman give every pm.test the same result', async () => {
    const a = app();
    const port = await new Promise<number>((res) => a.s.listen(0, '127.0.0.1', () => res((a.s.address() as { port: number }).port)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scripts-'));
    try {
        const pm = collection(`http://127.0.0.1:${port}`);
        const { collection: c } = importCollection(pm);
        const reqs = allRequests(c.items).map((x) => x.request);
        assert.ok(reqs.every((r) => r.scripts), 'every request keeps its scripts');
        assert.ok(c.scripts?.pre && c.scripts.test, 'the collection keeps its scripts');
        // The Studio's runner (environment minTotal = 1 from the configuration).
        const runner = new CollectionRunner();
        const job = runner.start({ collection: c, file: 'x', project: 'p', env: 'dev', requests: reqs, values: { vars: Object.fromEntries(c.variables.map((v) => [v.key, v.value])), config: { minTotal: '1' }, env: {} }, rows: [], iterations: 1, delayMs: 0, stopOnFailure: false, timeoutMs: 5000, mask: (t) => t });
        for (let i = 0; i < 100 && runner.get(job.id)!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
        const studio = runner.get(job.id)!.steps.map((s) => ({ name: s.name, tests: s.checks.map((x) => `${x.message}:${x.pass}`).sort() }));
        assert.deepEqual(studio.map((s) => s.name), ['Login', 'Orders page', 'Orders page', 'Orders page', 'Config'], 'setNextRequest: three pages, the skipped request never runs, null stops');
        // Newman on the same collection, exported again by the Studio (scripts carried over).
        const newman = process.env.CS_NEWMAN;
        if (!newman || !fs.existsSync(newman)) return;
        const file = path.join(dir, 'c.json'), report = path.join(dir, 'r.json');
        fs.writeFileSync(file, JSON.stringify(exportReport(c, {}).collection));
        await new Promise<void>((res) => execFile(newman, ['run', file, '--env-var', 'minTotal=1', '-r', 'json', '--reporter-json-export', report, '--timeout-request', '5000'], () => res()));
        const run = JSON.parse(fs.readFileSync(report, 'utf8')).run;
        // Newman's JSON report lists an execution twice when its pre-request script used pm.sendRequest (the same
        // cursor reference and response): one execution each.
        type Exec = { item: { name: string }; cursor?: { ref?: string }; assertions?: Array<{ assertion: string; error?: unknown; skipped?: boolean }> };
        const seen = new Set<string>();
        const postman = (run.executions as Exec[]).filter((e) => { const k = e.cursor?.ref ?? ''; if (k && seen.has(k)) return false; seen.add(k); return true; })
            .map((e) => ({ name: e.item.name, tests: (e.assertions ?? []).filter((x) => !x.skipped).map((x) => `${x.assertion}:${!x.error}`).sort() }));
        assert.deepEqual(studio, postman);
        assert.equal(run.failures.filter((f: { error?: { name?: string } }) => f.error?.name !== 'AssertionError').length, 0, 'no script errors in Postman');
    } finally { a.s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
