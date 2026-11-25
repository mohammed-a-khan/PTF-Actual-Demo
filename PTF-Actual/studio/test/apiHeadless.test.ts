/**
 * `cs-test-studio run <collection>`: the collection runs from the command line (configuration, secrets from the
 * environment, test data, a folder only, --var), prints each request and check, writes JUnit / JSON / HTML, and exits 1
 * on a failure. The generated Azure DevOps pipeline is valid YAML that runs it and publishes the results.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { DOMParser } from '@xmldom/xmldom';
import { execFile } from 'child_process';
import { main } from '../src/cli';

/** The command itself (compiled), as a pipeline runs it. */
const CLI = path.join(__dirname, '..', 'src', 'cli.js');
function cli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
    return new Promise((res) => execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 120_000 }, (e, o, er) => res({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out: `${o}${er}` })));
}
import { collectionPipeline } from '../src/api/headless';
import { newCollection, newRequest } from '../src/api/model';
import { runGit } from '../src/git/run';

async function scenario(t: { skip: (m: string) => void }, withData: boolean) {
    const fw = process.env.CS_FRAMEWORK_PROJECT;
    if (!fs.existsSync(CLI)) { t.skip('runs on the compiled command (npm test)'); return; }
    if (withData && (!fw || !fs.existsSync(path.join(fw, 'node_modules')))) { t.skip('test data files are read by the project\'s framework: set CS_FRAMEWORK_PROJECT'); return; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-run-'));
    const project = withData ? `hl${process.pid}` : 'shop';
    const seen: string[] = [];
    const s = http.createServer((q, r) => { seen.push(`${q.method} ${q.url} ${q.headers['x-api-key'] ?? ''}`); r.writeHead(q.url!.startsWith('/missing') ? 404 : 200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ ok: true, url: q.url })); });
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    const made: string[] = [];
    try {
        const dir = withData ? fw! : path.join(tmp, 'repo');
        if (!withData) await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
        made.push(path.join(dir, 'config', project), path.join(dir, 'test', project));
        const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
        w(`config/${project}/common/common.env`, `PROJECT_NAME=${project}\n`);
        w(`config/${project}/environments/qa.env`, `ENVIRONMENT=qa\nAPI_URL=http://127.0.0.1:${port}\n`);
        w(`test/${project}/data/orders.csv`, 'orderId,region\n11,eu\n12,us\n');
        const c = { ...newCollection('Shop API'), baseUrl: '{config:API_URL}', variables: [{ key: 'key', value: '{env:SHOP_API_KEY}' }] };
        c.items = [
            { kind: 'folder', id: 'f', name: 'Orders', items: [{ ...newRequest('Get order'), id: 'a', url: '/orders/{{orderId}}?r={{region}}', headers: [{ key: 'X-Api-Key', value: '{{key}}' }] }] },
            { ...newRequest('Missing'), id: 'b', url: '/missing/{{who}}' },
        ] as typeof c.items;
        const file = `test/${project}/api/shop.collection.json`;
        w(file, JSON.stringify(c));
        const env = { SHOP_API_KEY: 'secret-key-1234' };
        const results = path.join(tmp, 'results');
        let r = await cli(['run', file, '--repo', dir, '--env', 'qa', ...(withData ? ['--data', `test/${project}/data/orders.csv`] : ['--iterations', '2', '--var', 'orderId=11', '--var', 'region=eu']), '--var', 'who=ada', '--junit', `${results}/j.xml`, '--json', `${results}/r.json`, '--html', `${results}/r.html`], env);
        assert.equal(r.code, 1, `a failed request: exit 1\n${r.out}`);
        assert.deepEqual(seen, ['GET /orders/11?r=eu secret-key-1234', 'GET /missing/ada ', `GET /orders/${withData ? '12?r=us' : '11?r=eu'} secret-key-1234`, 'GET /missing/ada ']);
        const text = r.out;
        assert.match(text, withData ? new RegExp(`Shop API \\(${project}/qa\\): 2 request\\(s\\), 2 data row\\(s\\)`) : /Shop API \(shop\/qa\): 2 request\(s\) × 2/);
        assert.match(text, /✓ Get order {2}GET http:\/\/127\.0\.0\.1:\d+\/orders\/11\?r=eu {2}\[200, \d+ ms\]/);
        assert.match(text, /✗ Missing/);
        assert.match(text, /2\/4 requests passed/);
        assert.ok(!text.includes('secret-key-1234'), 'secrets masked in the output');
        const doc = new DOMParser().parseFromString(fs.readFileSync(`${results}/j.xml`, 'utf8'), 'text/xml');
        assert.deepEqual([doc.documentElement.getAttribute('tests'), doc.documentElement.getAttribute('failures')], ['4', '2']);
        assert.equal(JSON.parse(fs.readFileSync(`${results}/r.json`, 'utf8')).summary.passed, 2);
        assert.match(fs.readFileSync(`${results}/r.html`, 'utf8'), /<h1>Shop API<\/h1>/);
        if (withData) return;
        // Only a folder: all pass, exit 0.
        seen.length = 0;
        r = await cli(['run', file, '--repo', dir, '--env', 'qa', '--folder', 'Orders', '--iterations', '2', '--var', 'orderId=7', '--var', 'region=apac'], env);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual(seen, ['GET /orders/7?r=apac secret-key-1234', 'GET /orders/7?r=apac secret-key-1234']);
        // Usage and a wrong file.
        assert.equal(await main(['run', '--repo', dir]), 2);
        await assert.rejects(main(['run', 'test/shop/api/none.collection.json', '--repo', dir]), /ENOENT|no such file/);
    } finally { s.close(); fs.rmSync(tmp, { recursive: true, force: true }); if (withData) for (const d of made) fs.rmSync(d, { recursive: true, force: true }); }
}

test('cs-test-studio run: a collection from the command line (iterations, --var, a folder), results files, exit codes', (t) => scenario(t, false));
test('cs-test-studio run --data: one iteration per row of a test data file (read by the project\'s framework)', (t) => scenario(t, true));

test('the generated pipeline is valid Azure DevOps YAML: parameters, variable group, secrets as environment variables, results published', () => {
    const text = collectionPipeline('test/shop/api/shop.collection.json', { name: "Shop's API", envs: ['qa', 'uat'], variableGroup: 'shop-secrets', schedule: '0 6 * * 1-5', secretNames: ['SHOP_API_KEY', 'bad-name'] });
    const p = yaml.load(text) as Record<string, any>;
    assert.equal(p.name, "Shop's API $(Date:yyyyMMdd)$(Rev:.r)");
    assert.deepEqual(p.trigger.paths.include, ['test/shop/api/*']);
    assert.equal(p.schedules[0].cron, '0 6 * * 1-5');
    assert.deepEqual(p.parameters[0].values, ['qa', 'uat']);
    assert.deepEqual(p.variables[0], { group: 'shop-secrets' });
    const run = p.steps.find((s: { displayName?: string }) => s.displayName === "Run Shop's API");
    assert.match(run.script, /^npx cs-test-studio run 'test\/shop\/api\/shop\.collection\.json' --env \$\{\{ parameters\.environment \}\} --junit/);
    assert.deepEqual(run.env, { SHOP_API_KEY: '$(SHOP_API_KEY)' });
    const pub = p.steps.find((s: { task?: string }) => s.task === 'PublishTestResults@2');
    assert.deepEqual([pub.inputs.testResultsFormat, pub.condition], ['JUnit', 'succeededOrFailed()']);
});
