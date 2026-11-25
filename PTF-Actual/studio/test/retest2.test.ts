/** Fixes from the second QA retest: settings, mocks, checks, cURL, load curves and explanations. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fillJsonText } from '../src/api/mock';
import { curveProblems } from '../src/load/policy';
import { parseCurl } from '../src/api/curl';
import { evaluateExtra } from '../src/api/checks';
import { createServer } from '../src/server/server';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { runGit } from '../src/git/run';

const V = { vars: {}, config: {}, env: {} } as never;

test('check a value: a JSON path that cannot be read is said as such', async () => {
    const r = { status: 200, headers: {}, body: '{"a":1}', json: { a: 1 }, size: 7, timeMs: 1 } as never;
    const badPath = '$' + '$[bad';
    const bad = await evaluateExtra({ kind: 'rule', source: 'json', target: badPath, op: 'equals', expected: { from: 'text', value: '1' } } as never, r, V);
    assert.equal(bad?.pass, false);
    assert.match(bad!.message, /is not a JSON path/);
    const ok = await evaluateExtra({ kind: 'rule', source: 'json', target: '$.a', op: 'equals', expected: { from: 'text', value: '1' } } as never, r, V);
    assert.equal(ok?.pass, true, ok?.message);
});

test('mocks: a value the request does not have is null wherever the placeholder is the whole value', () => {
    const req = { path: {}, query: new URLSearchParams('a=1'), body: undefined } as never;
    const out = fillJsonText('{"q":"{{query.name}}","n":{{query.name}},"a":"{{query.a}}","t":"x {{query.name}}"}', req);
    assert.equal(out, '{"q":null,"n":null,"a":"1","t":"x "}');
    assert.deepEqual(JSON.parse(out), { q: null, n: null, a: '1', t: 'x ' });
});

test('cURL: -G with -F keeps the form and says so', () => {
    const r = parseCurl('curl -G -F x=1 https://api.example.test/upload');
    assert.equal(r.request.method, 'POST');
    assert.ok(r.warnings.some((w) => /-G/.test(w)));
});

test('custom curve: whole users, at most 100000, not all zero, a header after blank lines', () => {
    assert.match(curveProblems('0,1.5\n10,2').join(' '), /whole number/);
    assert.match(curveProblems('0,200000\n10,2').join(' '), /at most 100000/);
    assert.match(curveProblems('0,0\n10,0').join(' '), /0 users/);
    assert.deepEqual(curveProblems('\n\nsecond,users\n0,1\n10,5'), []);
});

test('server: settings save returns the whole view; mocks need a unique name; PDF names differing in capitals are one file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rt2-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'config', 'mk'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'mk', 'common.env'), 'PROJECT_NAME=mk\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const s = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk', home: path.join(tmp, 'home2') });
    const auth = { authorization: 'Bearer tk' };
    try {
        const set = await s.app.inject({ method: 'PUT', url: '/api/settings', headers: auth, payload: { openBrowser: false } });
        assert.equal(set.statusCode, 200, set.body);
        assert.equal(set.json().openBrowser, false);
        assert.equal(typeof set.json().networkInfo?.environmentProxy, 'string');

        const put = (file: string, name: string) => s.app.inject({ method: 'PUT', url: '/api/mocks/file', headers: auth, payload: { project: 'mk', file: `test/mk/mocks/${file}.mock.json`, mock: { name, routes: [] } } });
        assert.equal((await put('a', 'Orders')).statusCode, 200);
        assert.equal((await put('b', 'Payments')).statusCode, 200);
        const dup = await put('b', ' orders ');
        assert.equal(dup.statusCode, 400); assert.match(dup.json().error, /already called/);
        const empty = await put('b', '   ');
        assert.equal(empty.statusCode, 400); assert.match(empty.json().error, /needs a name/);
        assert.equal((await put('a', 'Orders')).statusCode, 200, 'saving a mock under its own name is fine');

        const pdf = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');
        const up = (name: string, replace = false) => s.app.inject({ method: 'POST', url: '/api/pdf/upload', headers: auth, payload: { project: 'mk', name, data: pdf, replace } });
        assert.equal((await up('INVOICE.pdf')).statusCode, 200);
        const clash = await up('invoice.pdf');
        assert.equal(clash.statusCode, 409);
        assert.match(clash.json().error, /INVOICE\.pdf exists/);
        const replaced = await up('invoice.pdf', true);
        assert.equal(replaced.json().path, 'test/mk/data/pdf/INVOICE.pdf');
        assert.deepEqual(fs.readdirSync(path.join(dir, 'test/mk/data/pdf')), ['INVOICE.pdf']);
    } finally { await s.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('run configurations: a save over a newer file (another tab) is refused with 409', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rc-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'config', 'mk'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'mk', 'common.env'), 'PROJECT_NAME=mk\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    const s = createServer({ repoRoot: dir, store, userName: 'T', token: 'tk', home: path.join(tmp, 'home2') });
    const auth = { authorization: 'Bearer tk' };
    try {
        const v0 = (await s.app.inject({ method: 'GET', url: '/api/run-configs', headers: auth })).json().version;
        const cfg = (name: string) => ({ name, request: { project: 'mk', env: 'dev' } });
        const a = await s.app.inject({ method: 'PUT', url: '/api/run-configs', headers: auth, payload: { configs: [cfg('A')], version: v0 } });
        assert.equal(a.statusCode, 200, a.body);
        // The second tab still has the first version.
        const b = await s.app.inject({ method: 'PUT', url: '/api/run-configs', headers: auth, payload: { configs: [cfg('B')], version: v0 } });
        assert.equal(b.statusCode, 409);
        assert.match(b.json().error, /another tab/);
        // Saving from the version it got back works.
        const c = await s.app.inject({ method: 'PUT', url: '/api/run-configs', headers: auth, payload: { configs: [cfg('A'), cfg('C')], version: a.json().version } });
        assert.equal(c.statusCode, 200, c.body);
    } finally { await s.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
