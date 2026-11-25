import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { discover, fileLayerPaths } from '../src/env/layers';
import { compareEnvironments, resolveConfig } from '../src/env/resolve';
import { createEnvironment, formatValue, removeKey, setValue, storeSecret } from '../src/env/edit';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';
import { encryptedKeyId } from '../src/core/encrypted';

let repo: string;
const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
const r = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');

before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-env-'));
    w('config/global.env', 'BROWSER=chromium\nTIMEOUT=30000\nBASE_URL=http://localhost\nAPP_NAME=global\n');
    w('config/common/common.env', 'TIMEOUT=45000\n');
    w('config/common/ai.env', 'AI_ENABLED=false\n');
    w('config/common/environments/qa.env', 'LOG_LEVEL=INFO\n');
    w('config/orders/common/common.env', 'APP_NAME=orders\nAPI_PATH=/api/v1\n');
    w('config/orders/orders.env', 'HEADLESS=true\nAPI_URL={BASE_URL}{API_PATH}\n');
    w('config/orders/environments/qa.env', [
        '# QA environment',
        'BASE_URL=https://qa.orders.example',
        'DB_PASSWORD={env:QA_DB_PASSWORD}',
        'API_TOKEN=ENCRYPTED:U2FsdGVkX19abcdefghijklmnop',
        'ADMIN_PASSWORD=admin123',
        'GREETING=Hello {upper:APP_NAME}',
        'ORDER_ID=<random>',
        'REPORT=${REPORT_DIR:-reports}',
        'MISSING={NOT_DEFINED}',
        'RUN_NAME=Run {date} {testName}',
        'TIMEOUT=60000',
        'TIMEOUT=61000',
        '',
    ].join('\n'));
    w('config/orders/environments/uat.env', 'BASE_URL=https://uat.orders.example\nDB_PASSWORD={env:UAT_DB_PASSWORD}\nENVIRONMENT=uat\n');
    w('config/report-specs/example.json', '{}');
});
after(() => fs.rmSync(repo, { recursive: true, force: true }));

test('discover projects and environments (report-specs is not a project)', () => {
    const d = discover(repo);
    assert.deepEqual(d.projects, ['orders']);
    assert.deepEqual(d.environments.orders, ['qa', 'uat']);
    assert.deepEqual(d.commonEnvironments, ['qa']);
});

test('layer order matches the framework code', () => {
    assert.deepEqual(fileLayerPaths(repo, 'orders', 'qa').map((l) => l.source), [
        'config/global.env',
        'config/common/common.env',
        'config/common/ai.env',
        'config/common/environments/qa.env',
        'config/orders/common/common.env',
        'config/orders/orders.env',
        'config/orders/environments/qa.env',
    ]);
});

test('effective values, provenance, interpolation, masking and problems', () => {
    const res = resolveConfig({ repoRoot: repo, project: 'orders', environment: 'qa', secretEnv: { QA_DB_PASSWORD: 'bluehorse42' }, processEnv: { HEADLESS: 'false' } });
    const e = Object.fromEntries(res.entries.map((x) => [x.key, x]));
    assert.equal(e.BASE_URL.value, 'https://qa.orders.example');
    assert.deepEqual(e.BASE_URL.overrides.map((o) => o.source), ['config/global.env']);
    assert.equal(e.BASE_URL.from.line, 2);
    assert.equal(e.API_URL.value, 'https://qa.orders.example/api/v1');
    assert.equal(e.TIMEOUT.value, '61000');
    assert.equal(e.HEADLESS.value, 'false');
    assert.equal(e.HEADLESS.from.source, '(environment variables)');
    assert.equal(e.GREETING.value, 'Hello ORDERS');
    assert.equal(e.REPORT.value, 'reports');
    assert.equal(e.ORDER_ID.runtimePlaceholders, true);
    assert.equal(e.DB_PASSWORD.sensitive, true);
    assert.equal(e.DB_PASSWORD.value, '••••••');
    assert.equal(e.DB_PASSWORD.from.raw, '{env:QA_DB_PASSWORD}');
    assert.ok(!JSON.stringify(res).includes('bluehorse42'), 'secret value never in the result');
    assert.ok(!JSON.stringify(res).includes('admin123'), 'literal secret value never in the result');
    const codes = res.problems.map((p) => `${p.code}:${p.key ?? ''}`);
    assert.ok(codes.includes('legacy-encrypted-value:API_TOKEN'));
    assert.equal(encryptedKeyId('ENCRYPTED:' + Buffer.from(JSON.stringify({ encrypted: 'a', iv: 'b', tag: 'c', kid: '3f9a01bc77de' })).toString('base64')), '3f9a01bc77de');
    assert.equal(encryptedKeyId('ENCRYPTED:' + Buffer.from(JSON.stringify({ encrypted: 'a', iv: 'b', tag: 'c' })).toString('base64')), null);
    assert.ok(codes.includes('literal-secret-in-config:ADMIN_PASSWORD'));
    assert.ok(codes.includes('unresolved-reference:MISSING'));
    assert.ok(codes.includes('duplicate-key:TIMEOUT'));
    assert.ok(!codes.includes('unresolved-reference:RUN_NAME'), 'lower-case template names are not config keys');
    assert.ok(!codes.some((c) => c.startsWith('missing-env-reference')));
});

test('missing {env:} reference is an error (framework would silently use empty)', () => {
    const res = resolveConfig({ repoRoot: repo, project: 'orders', environment: 'uat' });
    const p = res.problems.find((x) => x.code === 'missing-env-reference');
    assert.ok(p);
    assert.equal(p!.severity, 'error');
    assert.equal(p!.key, 'DB_PASSWORD');
    assert.equal(p!.line, 2);
});

test('missing environment file warning only when the project uses environments', () => {
    const res = resolveConfig({ repoRoot: repo, project: 'orders', environment: 'nope' });
    assert.ok(res.problems.some((p) => p.code === 'missing-environment-file'));
    w('config/billing/billing.env', 'BASE_URL=https://billing\n');
    const b = resolveConfig({ repoRoot: repo, project: 'billing', environment: 'dev' });
    assert.ok(!b.problems.some((p) => p.code === 'missing-environment-file'));
    fs.rmSync(path.join(repo, 'config/billing'), { recursive: true });
});

test('compare environments', () => {
    const qa = resolveConfig({ repoRoot: repo, project: 'orders', environment: 'qa' });
    const uat = resolveConfig({ repoRoot: repo, project: 'orders', environment: 'uat' });
    const diff = compareEnvironments(qa, uat);
    const keys = diff.map((d) => d.key);
    assert.ok(keys.includes('BASE_URL'));
    assert.ok(keys.includes('LOG_LEVEL'), 'only qa has the common qa file');
    assert.ok(!keys.includes('BROWSER'));
});

test('formatValue round-trips through dotenv', () => {
    for (const v of ['plain', 'has space', 'a#b', "it's", 'say "hi"', 'both \'"', 'tab\there', '{env:X}', 'line1\nline2', 'x=y', 'C:\\path\\dir', '']) {
        assert.equal(dotenv.parse(`K=${formatValue(v)}\n`).K, v, JSON.stringify(v));
    }
});

test('setValue keeps comments, order and CRLF; refuses literal secrets', () => {
    w('config/orders/environments/sit.env', '# header\r\nBASE_URL=https://old # note\r\n\r\nOTHER="x" # quoted note\r\n');
    setValue(repo, 'config/orders/environments/sit.env', 'BASE_URL', 'https://new.example');
    assert.equal(r('config/orders/environments/sit.env'), '# header\r\nBASE_URL=https://new.example # note\r\n\r\nOTHER="x" # quoted note\r\n');
    setValue(repo, 'config/orders/environments/sit.env', 'OTHER', 'a b');
    assert.match(r('config/orders/environments/sit.env'), /\r\nOTHER='a b' # quoted note\r\n/);
    assert.equal(dotenv.parse(r('config/orders/environments/sit.env')).OTHER, 'a b');
    setValue(repo, 'config/orders/environments/sit.env', 'NEW_KEY', 'with space');
    assert.match(r('config/orders/environments/sit.env'), /\r\nNEW_KEY='with space'\r\n$/);
    assert.throws(() => setValue(repo, 'config/orders/environments/sit.env', 'DB_PASSWORD', 'hunter22'), /secret store/);
    setValue(repo, 'config/orders/environments/sit.env', 'DB_PASSWORD', '{env:SIT_DB_PASSWORD}');
    assert.throws(() => setValue(repo, '../outside.env', 'A', '1'), /Only \.env files/);
    assert.throws(() => setValue(repo, 'config/orders/x.txt', 'A', '1'));
    assert.equal(removeKey(repo, 'config/orders/environments/sit.env', 'OTHER'), 1);
    assert.ok(!r('config/orders/environments/sit.env').includes('OTHER='));
});

test('storeSecret saves the value and writes a reference', () => {
    const home = path.join(repo, '..', path.basename(repo) + '-home');
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'k.key')));
    storeSecret(repo, store, { file: 'config/orders/environments/qa.env', key: 'ADMIN_PASSWORD', secretName: 'QA_ADMIN_PASSWORD', value: 'admin123', project: 'orders', env: 'qa' });
    assert.match(r('config/orders/environments/qa.env'), /^ADMIN_PASSWORD=\{env:QA_ADMIN_PASSWORD\}$/m);
    assert.equal(store.resolve('QA_ADMIN_PASSWORD', { project: 'orders', env: 'qa' }), 'admin123');
    fs.rmSync(home, { recursive: true, force: true });
});

test('createEnvironment copies settings but never secret values', () => {
    const res = createEnvironment(repo, 'orders', 'perf', 'qa');
    const text = r(res.file);
    assert.match(text, /BASE_URL=https:\/\/qa\.orders\.example/);
    assert.match(text, /API_TOKEN=\{env:PERF_API_TOKEN\}/);
    assert.ok(!text.includes('ENCRYPTED:'));
    assert.ok(res.secretKeys.includes('API_TOKEN'));
    assert.throws(() => createEnvironment(repo, 'orders', 'perf', 'qa'), /already exists/);
    assert.throws(() => createEnvironment(repo, 'orders', '../x'), /not a valid/);
    assert.deepEqual(discover(repo).environments.orders, ['perf', 'qa', 'sit', 'uat']);
});
