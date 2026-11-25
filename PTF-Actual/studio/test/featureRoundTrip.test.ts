/**
 * The test the Studio writes runs on the real framework with the Studio's verdicts: a collection (JSON and XML
 * checks, saved values chained into headers and bodies, a multipart upload, a scenario that must fail) is turned into
 * a feature, the framework runs it against a local app, and each scenario passes or fails as the Studio's Send says.
 *
 * Runs when CS_FRAMEWORK_PROJECT names a project with the framework installed (node_modules), e.g.
 *   CS_FRAMEWORK_PROJECT=/path/to/demo-project npx tsx --test test/featureRoundTrip.test.ts
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { execFile } from 'child_process';
import { apiTestPlan } from '../src/api/codegen/plan';
import { ApiCheck, ApiCollection, ApiRequest, newCollection, newRequest, allRequests } from '../src/api/model';
import { evaluateAll, extract, prepare, sendWith, Values } from '../src/api/send';
import { edgegridHeader, hawkHeader, oauth1Header } from '../src/api/moreAuth';
import * as crypto from 'crypto';

const rule = (c: Partial<ApiCheck>): ApiCheck => ({ kind: 'rule', ...c } as ApiCheck);

/** Orders (JSON), echo (JSON body + headers), upload (multipart: fields and a file), xml. */
function app() {
    const s = http.createServer((q, r) => {
        const chunks: Buffer[] = [];
        q.on('data', (c: Buffer) => chunks.push(c));
        q.on('end', () => {
            const body = Buffer.concat(chunks);
            const json = (status: number, o: unknown) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
            if (q.url!.startsWith('/orders')) {
                r.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'req-77' });
                r.end(JSON.stringify({ customer: { id: 7, name: 'Ada Lovelace', tier: 'Gold' }, total: 30.005, items: [{ sku: 'A1', qty: 2 }, { sku: 'B2', qty: 1 }], tags: ['new'] }));
            } else if (q.url!.startsWith('/echo')) {
                let got: unknown = null;
                try { got = JSON.parse(body.toString('utf8') || 'null'); } catch { got = body.toString('utf8'); }
                json(200, { got, saved: q.headers['x-saved'] ?? null, contentType: q.headers['content-type'] ?? null });
            } else if (q.url!.startsWith('/upload')) {
                // The parts as the server sees them: field values, file names and sizes.
                const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(q.headers['content-type'] ?? ''));
                if (!m) return json(400, { error: 'not multipart', contentType: q.headers['content-type'] ?? null });
                const boundary = `--${m[1] ?? m[2]}`;
                const fields: Record<string, string> = {}, files: Record<string, { name: string; size: number; text: string }> = {};
                for (const raw of body.toString('latin1').split(boundary).slice(1, -1)) {
                    const at = raw.indexOf('\r\n\r\n');
                    const head = raw.slice(0, at), value = raw.slice(at + 4, raw.length - 2);
                    const name = /name="([^"]*)"/.exec(head)?.[1] ?? '';
                    const file = /filename="([^"]*)"/.exec(head)?.[1];
                    if (file !== undefined) files[name] = { name: file, size: Buffer.byteLength(value, 'latin1'), text: value };
                    else fields[name] = value;
                }
                json(200, { fields, files });
            } else if (q.url!.startsWith('/signed/')) {
                // The server checks the signature with the same keys (recomputed from the header's own nonce/time).
                const kind = q.url!.split('/')[2].split('?')[0];
                const a = String(q.headers.authorization ?? '');
                const url = `http://${q.headers.host}${q.url}`;
                const attr = (n: string) => new RegExp(`${n}="([^"]*)"`).exec(a)?.[1] ?? '';
                let valid = false;
                try {
                    if (kind === 'jwt') {
                        const [h, c, sig] = a.replace(/^Bearer /, '').split('.');
                        valid = crypto.createHmac('sha256', 'jwt-secret-1').update(`${h}.${c}`).digest('base64url') === sig && JSON.parse(Buffer.from(c, 'base64url').toString()).role === 'tester';
                    } else if (kind === 'oauth1') {
                        valid = a === oauth1Header({ method: q.method!, url, consumerKey: 'ck', consumerSecret: 'cs-1', token: 'tk', tokenSecret: 'ts-1', nonce: decodeURIComponent(attr('oauth_nonce')), timestamp: attr('oauth_timestamp') });
                    } else if (kind === 'hawk') {
                        valid = a === hawkHeader({ method: q.method!, url, id: 'hawk-id', key: 'hawk-key-1', ts: Number(attr('ts')), nonce: attr('nonce') });
                    } else if (kind === 'edgegrid') {
                        const f = Object.fromEntries(a.replace(/^EG1-HMAC-SHA256 /, '').split(';').filter(Boolean).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
                        valid = a === edgegridHeader({ method: q.method!, url, clientToken: 'ct-1', clientSecret: 'eg-secret', accessToken: 'at-1', timestamp: f.timestamp, nonce: f.nonce, body });
                    }
                } catch { valid = false; }
                json(200, { valid, scheme: a.split(' ')[0] });
            } else if (q.url!.startsWith('/moved')) {
                // A redirect: with redirects not followed, the 302 is the answer.
                r.writeHead(302, { Location: '/orders', 'X-Moved': 'yes' }); r.end();
            } else if (q.url!.startsWith('/xml')) {
                r.writeHead(200, { 'Content-Type': 'application/xml' });
                r.end('<Order id="9"><Customer><Name>Ada</Name></Customer><Line no="1"><Sku>A1</Sku></Line><Line no="2"><Sku>B2</Sku></Line></Order>');
            } else { r.writeHead(404); r.end(); }
        });
    });
    return { s, listen: () => new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port))) };
}

function collection(port: number, uploadFile: string): ApiCollection {
    const c = newCollection('Round trip');
    c.baseUrl = `http://127.0.0.1:${port}`;
    const orders: ApiRequest = { ...newRequest('Orders', 'orders'), url: '/orders', checks: [
        { kind: 'status', value: '200' },
        { kind: 'jsonEquals', target: '$.customer.id', value: '7' },
        { kind: 'headerContains', target: 'Content-Type', value: 'json' },
        rule({ source: 'json', target: '$.customer.name', op: 'equals', expected: { from: 'text', value: 'Ada Lovelace' } }),
        rule({ source: 'json', target: '$.total', op: 'equals', expected: { from: 'text', value: '30' }, compare: 'number', tolerance: 0.01 }),
        rule({ source: 'json', target: '$.items', op: 'count', expected: { from: 'text', value: '2' } }),
        rule({ source: 'json', target: '$.customer.tier', op: 'oneOf', expected: { from: 'text', value: 'Silver, Gold' } }),
        rule({ source: 'json', target: '$.customer.name', op: 'matches', expected: { from: 'text', value: '^Ada\\s' } }),
        rule({ source: 'header', target: 'x-request-id', op: 'equals', expected: { from: 'text', value: 'req-77' } }),
        rule({ source: 'body', op: 'contains', expected: { from: 'text', value: 'Lovelace' } }),
        { kind: 'schema', schema: JSON.stringify({ type: 'object', required: ['customer', 'items'], properties: { items: { type: 'array', items: { type: 'object', required: ['sku', 'qty'] } } } }) },
    ], extract: [
        { from: 'json', path: '$.customer.name', variable: 'customerName' },
        { from: 'header', path: 'X-Request-Id', variable: 'requestId' },
        { from: 'json', path: '$.items[1].sku', variable: 'secondSku' },
    ] };
    const echo: ApiRequest = { ...newRequest('Echo', 'echo'), method: 'POST', url: '/echo', headers: [{ key: 'X-Saved', value: '{{requestId}}' }],
        body: { mode: 'json', text: '{"sku": "{{secondSku}}", "who": "{{customerName}}", "qty": 3}' }, checks: [
            { kind: 'status', value: '200' },
            rule({ source: 'json', target: '$.saved', op: 'equals', expected: { from: 'saved', value: 'requestId' } }),
            rule({ source: 'json', target: '$.got.sku', op: 'equals', expected: { from: 'text', value: 'B2' } }),
            rule({ source: 'json', target: '$.got.who', op: 'equals', expected: { from: 'saved', value: 'customerName' } }),
            rule({ source: 'json', target: '$.got.qty', op: 'equals', expected: { from: 'text', value: '3' } }),
        ], extract: [] };
    const upload: ApiRequest = { ...newRequest('Upload', 'upload'), method: 'POST', url: '/upload',
        body: { mode: 'multipart', parts: [{ key: 'note', value: 'quarterly', type: 'text' }, { key: 'doc', value: uploadFile, type: 'file' }] }, checks: [
            { kind: 'status', value: '200' },
            rule({ source: 'json', target: '$.fields.note', op: 'equals', expected: { from: 'text', value: 'quarterly' } }),
            rule({ source: 'json', target: '$.files.doc.name', op: 'equals', expected: { from: 'text', value: 'upload.txt' } }),
            rule({ source: 'json', target: '$.files.doc.text', op: 'contains', expected: { from: 'text', value: 'line two' } }),
            rule({ source: 'json', target: '$.files.doc.size', op: 'equals', expected: { from: 'text', value: '17' } }),
            // A line break cannot go in a step: written as a comment, with a warning (the feature still parses).
            rule({ source: 'json', target: '$.files.doc.text', op: 'equals', expected: { from: 'text', value: 'line one\nline two' } }),
        ], extract: [] };
    const xml: ApiRequest = { ...newRequest('Xml', 'xml'), url: '/xml', checks: [
        { kind: 'status', value: '200' },
        rule({ source: 'xml', target: '/Order/Customer/Name', op: 'equals', expected: { from: 'text', value: 'Ada' } }),
        rule({ source: 'xml', target: '/Order/@id', op: 'equals', expected: { from: 'text', value: '9' } }),
        rule({ source: 'xml', target: '//Line[2]/Sku', op: 'equals', expected: { from: 'text', value: 'B2' } }),
    ], extract: [] };
    // Must fail in both: the tier is Gold.
    const wrong: ApiRequest = { ...newRequest('Wrong tier', 'wrong'), url: '/orders', checks: [
        { kind: 'status', value: '200' },
        rule({ source: 'json', target: '$.customer.tier', op: 'equals', expected: { from: 'text', value: 'Platinum' } }),
    ], extract: [] };
    // Signed requests: the server verifies each signature.
    const signed = (kind: string, auth: ApiRequest['auth'], method: 'GET' | 'POST' = 'GET'): ApiRequest => ({ ...newRequest(`Signed ${kind}`, `signed-${kind}`), method, url: `/signed/${kind}?b=2&a=1`, auth,
        ...(method === 'POST' ? { body: { mode: 'json' as const, text: '{"amount":10}' } } : {}),
        checks: [{ kind: 'status', value: '200' }, rule({ source: 'json', target: '$.valid', op: 'equals', expected: { from: 'text', value: 'true' } })], extract: [] });
    // Settings: redirects not followed, a timeout; the framework's steps for them.
    const moved: ApiRequest = { ...newRequest('Moved', 'moved'), url: '/moved', settings: { followRedirects: false, timeoutMs: 20_000 }, checks: [
        { kind: 'status', value: '302' },
        rule({ source: 'header', target: 'x-moved', op: 'equals', expected: { from: 'text', value: 'yes' } }),
    ], extract: [] };
    c.items.push(orders, echo, upload, xml, wrong, moved,
        signed('jwt', { type: 'jwt', algorithm: 'HS256', secret: 'jwt-secret-1', payload: '{"sub":"qa-user","role":"tester"}' }),
        signed('oauth1', { type: 'oauth1', consumerKey: 'ck', consumerSecret: 'cs-1', token: 'tk', tokenSecret: 'ts-1' }),
        signed('hawk', { type: 'hawk', hawkId: 'hawk-id', hawkKey: 'hawk-key-1' }),
        signed('edgegrid', { type: 'edgegrid', clientToken: 'ct-1', clientSecret: 'eg-secret', accessToken: 'at-1' }, 'POST'));
    return c;
}

/** Runs `cmd` without blocking this process (the app answers from it). */
function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
    return new Promise((res) => {
        execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, timeout: 300_000 }, (e, stdout, stderr) =>
            res({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, out: `${stdout}\n${stderr}` }));
    });
}

test('a generated feature runs on the framework with the Studio\'s verdicts (JSON, XML, chaining, multipart, a failing check)', { timeout: 400_000 }, async (t) => {
    const projectDir = process.env.CS_FRAMEWORK_PROJECT;
    if (!projectDir || !fs.existsSync(path.join(projectDir, 'node_modules'))) { t.skip('CS_FRAMEWORK_PROJECT is not set'); return; }
    const { s, listen } = app();
    const port = await listen();
    const project = `rt${process.pid}`;
    const made = [path.join(projectDir, 'config', project), path.join(projectDir, 'test', project)];
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
        const name = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).find((d) => /cs-playwright-test-framework|cs-test-automation-framework/.test(d));
        assert.ok(name, 'the project has no framework dependency');
        // The project: config (API, no browser; its steps and the framework's API steps) and the upload file.
        const env = path.join(projectDir, 'config', project);
        fs.mkdirSync(path.join(env, 'common'), { recursive: true });
        fs.mkdirSync(path.join(env, 'environments'), { recursive: true });
        fs.writeFileSync(path.join(env, 'common', 'common.env'), [
            `PROJECT_NAME=${project}`, 'PROJECT_TYPE=api', 'DEFAULT_BROWSER=none', 'BROWSER_LAUNCH_REQUIRED=false', 'HEADLESS=true',
            'BROWSER_VIDEO=off', 'HAR_CAPTURE_MODE=never', 'TRACE_CAPTURE_MODE=never', 'SCREENSHOT_ON_FAILURE=false', 'API_RETRY_COUNT=0', 'RETRY_COUNT=0',
            `STEP_DEFINITIONS_PATH=test/${project}/steps;node_modules/${name}/dist/steps/api`, '',
        ].join('\n'));
        fs.writeFileSync(path.join(env, 'environments', 'dev.env'), 'ENVIRONMENT=dev\n');
        const dataDir = path.join(projectDir, 'test', project, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'upload.txt'), 'line one\nline two');
        const uploadRel = `test/${project}/data/upload.txt`;
        const c = collection(port, uploadRel);

        // The Studio's verdict per request (one scenario each).
        const values: Values = { vars: {}, config: {}, env: {}, row: {}, readFile: (rel) => fs.readFileSync(path.join(projectDir, rel)) };
        const studio: Record<string, boolean> = {};
        for (const r of allRequests(c.items).map((x) => x.request)) {
            const res = await sendWith(prepare(c, r, values, { readFile: values.readFile }), r.settings, undefined, 5000);
            for (const x of extract(r.extract, res)) if (x.found && x.value !== undefined) values.vars[x.variable] = x.value;
            const verdicts = await evaluateAll(r.checks, res, values);
            studio[r.name] = verdicts.every((x) => x.pass);
            if (r.name !== 'Wrong tier') assert.ok(studio[r.name], `${r.name} in the Studio: ${JSON.stringify(verdicts.filter((x) => !x.pass))}`);
        }
        assert.equal(studio['Wrong tier'], false);

        // The test, as the Studio's Save writes it: the feature and the project code its steps need.
        const plan = apiTestPlan(c, { project, featureFolder: `test/${project}/features`, stepsFolder: `test/${project}/steps`, pkg: name!, config: {},
            read: (rel) => { try { return fs.readFileSync(path.join(projectDir, rel), 'utf8'); } catch { return null; } } });
        const unexpected = plan.warnings.filter((w) => !/multipart uploads need a framework version|has a line break, which a step cannot hold/.test(w));
        assert.deepEqual(unexpected, []);
        assert.ok(plan.warnings.some((w) => /has a line break/.test(w)), JSON.stringify(plan.warnings));
        for (const f of plan.files) {
            assert.ok(f.path.startsWith(`test/${project}/`), f.path);
            fs.mkdirSync(path.dirname(path.join(projectDir, f.path)), { recursive: true });
            fs.writeFileSync(path.join(projectDir, f.path), f.text);
        }

        // The framework runs it.
        const bin = path.join(projectDir, 'node_modules', name, 'dist', 'index.js');
        const { out } = await run(process.execPath, [bin, `--project=${project}`, '--env=dev', `--features=${plan.feature}`, '--headless=true'], projectDir);
        if (process.env.CS_ROUNDTRIP_LOG) fs.writeFileSync(process.env.CS_ROUNDTRIP_LOG, `${plan.files.map((x) => `---- ${x.path}\n${x.text}`).join('\n')}\n\n==== framework ====\n${out}`);
        const framework = scenarioResults(out);
        // A request runs in the scenario named after it ("Orders, then Echo" holds both).
        const scenarioOf = (req: string) => Object.keys(framework).find((n) => n.split(', then ').includes(req));
        assert.equal(Object.keys(framework).length, plan.scenarios, `scenarios reported: ${JSON.stringify(framework)}\n${out.slice(-3000)}`);
        for (const req of Object.keys(studio)) {
            const sc = scenarioOf(req);
            assert.ok(sc, `the framework did not report "${req}": ${JSON.stringify(framework)}\n${out.slice(-3000)}`);
            const expected = Object.keys(studio).filter((r) => scenarioOf(r) === sc).every((r) => studio[r]);
            assert.equal(framework[sc], expected, `${sc}: framework ${framework[sc] ? 'passed' : 'failed'}, Studio ${expected ? 'passed' : 'failed'}\n${out.slice(-4000)}`);
        }
    } finally {
        s.close();
        for (const d of made) fs.rmSync(d, { recursive: true, force: true });
    }
});

/** Scenario name → passed, from the framework's log ("[PASS] Test completed: name" / "[FAIL] Test completed: name"). */
function scenarioResults(out: string): Record<string, boolean> {
    const r: Record<string, boolean> = {};
    for (const m of out.replace(/\x1b\[[0-9;]*m/g, '').matchAll(/\[(PASS|FAIL)\] Test completed: (.+?)\s*$/gm)) r[m[2]] = m[1] === 'PASS';
    return r;
}
