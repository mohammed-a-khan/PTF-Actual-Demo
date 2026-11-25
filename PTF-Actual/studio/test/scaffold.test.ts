import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldProject } from '../src/framework/scaffold';
import { frameworkPackage } from '../src/framework/package';

/** A repository with the framework installed (its newest build): CS_RECORDER_TEST_REPO. */
const REPO = process.env.CS_RECORDER_TEST_REPO;

/** A repository with a stand-in framework package (its defaults template, its encryption). */
function fakeRepo(scope: string, o: { template?: boolean; globalEnv?: boolean } = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'));
    const pkg = path.join(dir, 'node_modules', scope, 'cs-playwright-test-framework');
    fs.mkdirSync(path.join(pkg, 'dist', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: `${scope}/cs-playwright-test-framework` }));
    // A stand-in for the framework's encryption (the real one is used with CS_RECORDER_TEST_REPO).
    fs.writeFileSync(path.join(pkg, 'dist', 'utils', 'CSEncryptionUtil.js'), "exports.CSEncryptionUtil = { getInstance: () => ({ createEncryptedConfigValue: (t) => 'ENCRYPTED:' + Buffer.from(t).toString('base64').split('').reverse().join('') }) };");
    if (o.template !== false) { fs.mkdirSync(path.join(pkg, 'templates', 'config'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'templates', 'config', 'global.env'), '# FRAMEWORK DEFAULTS\nBROWSER=chrome\n'); }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [`${scope}/cs-playwright-test-framework`]: '^1.55.0' } }));
    if (o.globalEnv) { fs.mkdirSync(path.join(dir, 'config'), { recursive: true }); fs.writeFileSync(path.join(dir, 'config', 'global.env'), '# THE TEAM\'S DEFAULTS\n'); }
    return dir;
}

test('new project: laid out as the team\'s projects (defaults in global.env, project commons + queries, environment overrides)', () => {
    const repo = fakeRepo('@mdakhan.mak');
    try {
        assert.deepEqual(frameworkPackage(repo)?.name, '@mdakhan.mak/cs-playwright-test-framework');
        const s = scaffoldProject(repo, { slug: 'claims-portal', displayName: 'Claims Portal', dbType: 'oracle',
            environments: [{ name: 'dev', baseUrl: 'https://claims-dev.example.test', loginUrl: 'https://claims-dev.example.test/sso' }, { name: 'sit', baseUrl: 'https://claims-sit.example.test' }],
            credentials: { username: 'qa.user', password: 'Claims-Pass-1!' } });
        assert.deepEqual(s.plan.files.map((f) => f.path), ['config/global.env', 'config/claims-portal/common/common.env', 'config/claims-portal/common/claims-portal-db-queries.env', 'config/claims-portal/environments/dev.env', 'config/claims-portal/environments/sit.env']);
        assert.equal(s.globalEnv, 'written');
        assert.equal(s.plan.files[0].text, '# FRAMEWORK DEFAULTS\nBROWSER=chrome\n', 'the framework\'s own defaults, as shipped');
        assert.equal(s.alias, 'CLAIMS_PORTAL');
        const common = s.plan.files[1].text;
        for (const line of ['PROJECT=claims-portal', 'PROJECT_NAME=Claims Portal', 'FEATURE_PATH=test/claims-portal/features/',
            'STEP_DEFINITIONS_PATH=test/claims-portal/steps;test/common/steps;node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/steps',
            'DB_ENABLED=true', 'DATABASE_CONNECTIONS=CLAIMS_PORTAL', 'DB_CLAIMS_PORTAL_TYPE=oracle', 'DB_CLAIMS_PORTAL_POOL_MAX=10']) assert.ok(common.split('\n').includes(line), line);
        assert.doesNotMatch(common, /^(BROWSER|HEADLESS|TIMEOUT|BASE_URL)=/m, 'defaults stay in global.env');
        assert.match(s.plan.files[2].text, /DB_QUERY_<NAME>=<SQL with \? for each parameter>/);
        assert.doesNotMatch(s.plan.files[2].text, /^DB_QUERY_/m, 'no invented queries');
        const dev = s.plan.files[3].text.split('\n');
        for (const line of ['ENVIRONMENT=dev', 'BASE_URL=https://claims-dev.example.test', 'LOGIN_URL=https://claims-dev.example.test/sso', 'DB_CLAIMS_PORTAL_HOST=', 'DB_CLAIMS_PORTAL_PORT=1521', 'DB_CLAIMS_PORTAL_PASSWORD=', 'CLAIMS_PORTAL_USERNAME=qa.user']) assert.ok(dev.includes(line), line);
        assert.ok(dev.some((l) => /^CLAIMS_PORTAL_PASSWORD=ENCRYPTED:\S+$/.test(l)));
        assert.ok(!s.plan.files.some((f) => f.text.includes('Claims-Pass-1!')), 'never in plain text');
        assert.ok(!s.plan.files[4].text.includes('LOGIN_URL='), 'only what was given');
        assert.deepEqual(s.dirs, ['test/claims-portal/features', 'test/claims-portal/pages', 'test/claims-portal/steps', 'test/claims-portal/data', 'test/claims-portal/helpers']);
        assert.ok(!fs.existsSync(path.join(repo, 'config', 'claims-portal')), 'nothing written');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('new project: the repository\'s own global.env is kept; without a database no queries file; older frameworks', () => {
    const repo = fakeRepo('@mdakhan.mak', { globalEnv: true });
    try {
        const s = scaffoldProject(repo, { slug: 'web', dbType: 'none', environments: [{ name: 'uat', baseUrl: 'https://web-uat.example.test' }] });
        assert.equal(s.globalEnv, 'kept');
        assert.deepEqual(s.plan.files.map((f) => f.path), ['config/web/common/common.env', 'config/web/environments/uat.env']);
        assert.doesNotMatch(s.plan.files[0].text, /DB_/);
        assert.match(s.plan.files[1].text, /^WEB_PASSWORD=$/m);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
    const old = fakeRepo('@mdakhan.mak', { template: false });
    try {
        const s = scaffoldProject(old, { slug: 'web', dbType: 'none', environments: [{ name: 'dev', baseUrl: 'https://web.example.test' }] });
        assert.equal(s.globalEnv, 'unavailable');
        assert.ok(s.notes.some((n) => /does not ship its defaults/.test(n)));
        fs.mkdirSync(path.join(old, 'config', 'web'), { recursive: true });
        assert.throws(() => scaffoldProject(old, { slug: 'web', dbType: 'none', environments: [{ name: 'dev', baseUrl: 'https://web.example.test' }] }), /exists already/);
    } finally { fs.rmSync(old, { recursive: true, force: true }); }
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'no-fw-'));
    try { assert.throws(() => scaffoldProject(none, { slug: 'x', dbType: 'none', environments: [{ name: 'dev', baseUrl: 'https://x.example.test' }] }), /not installed/); }
    finally { fs.rmSync(none, { recursive: true, force: true }); }
});

test('new project with the real framework: its defaults template and its encryption', (t) => {
    if (!REPO || !fs.existsSync(path.join(frameworkPackage(REPO)?.dir ?? '/none', 'templates', 'config', 'global.env'))) { t.skip('Needs the newest framework build (CS_RECORDER_TEST_REPO)'); return; }
    const s = scaffoldProject(REPO, { slug: 'unit-crm', dbType: 'postgresql', environments: [{ name: 'dev', baseUrl: 'https://crm-dev.example.test' }], credentials: { username: 'qa', password: 'Unit-Pass-42!' } });
    assert.equal(s.globalEnv, 'kept', 'the repository has its own');
    assert.match(s.plan.files.find((f) => f.path.endsWith('dev.env'))!.text, /^UNIT_CRM_PASSWORD=ENCRYPTED:[A-Za-z0-9+/=]+$/m);
    assert.match(s.plan.files[0].text, /^DB_UNIT_CRM_TYPE=postgresql$/m);
});
