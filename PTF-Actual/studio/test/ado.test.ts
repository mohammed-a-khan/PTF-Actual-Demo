import { DEFAULT_SETTINGS } from '../src/core/settings';
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdoClient, AdoRequest } from '../src/ado/client';
import { adoSettingsFor, checkInAdo, pipelineYaml, requirements, syncToAdo } from '../src/ado/pipelineSecrets';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';

let repo: string; let home: string; let store: SecretStore;
const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };

before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-ado-'));
    home = repo + '-home';
    store = new SecretStore(home, new KeyFileProtector(path.join(home, 'k.key')));
    w('config/global.env', 'ADO_ORGANIZATION=acme\nADO_ORGANIZATION_URL=https://dev.azure.com/{ADO_ORGANIZATION}\nADO_PROJECT=QA Project\nADO_API_VERSION=7.0\nADO_PAT={env:MY_ADO_PAT}\n');
    w('config/orders/environments/SIT.env', 'BASE_URL=https://sit\nDB_PASSWORD={env:DB_PASSWORD_SECRET}\nBUILD={env:BUILD_BUILDID}\n');
    w('test/orders/features/login.feature', 'When I enter "{env:APP_PASSWORD_SECRET}" into the "Password" field\n');
    store.set({ name: 'DB_PASSWORD_SECRET', project: 'repo', env: 'SIT' }, 'sit-db-pw');
    store.set({ name: 'ADO_PAT', project: 'repo' }, 'pat-value-123');
});
after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

test('requirements: config + feature references, agent variables excluded, local presence', () => {
    const r = requirements(repo, store, 'repo', 'orders', 'SIT');
    assert.equal(r.variableGroup, 'orders-SIT-secrets');
    assert.deepEqual(r.rows.map((x) => [x.name, x.local]), [['APP_PASSWORD_SECRET', false], ['DB_PASSWORD_SECRET', true], ['MY_ADO_PAT', false]]);
    assert.deepEqual(r.rows.find((x) => x.name === 'DB_PASSWORD_SECRET')!.usedBy, [{ key: 'DB_PASSWORD', file: 'config/orders/environments/SIT.env', line: 2 }]);
    assert.equal(r.yaml, '    secretsVariableGroup: "orders-SIT-secrets"\n    secretNames:\n    - APP_PASSWORD_SECRET\n    - DB_PASSWORD_SECRET\n    - MY_ADO_PAT');
    assert.equal(pipelineYaml('g', []), '    secretsVariableGroup: "g"\n    secretNames: []');
});

test('the token only goes to trusted https hosts and comes from the personal-settings secret', async () => {
    const { adoSettingsFor: ads } = await import('../src/ado/pipelineSecrets');
    const evil = path.join(repo, 'config/evil/environments');
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'qa.env'), 'ADO_ORGANIZATION_URL=http://attacker.example/org\n');
    assert.throws(() => ads(repo, store, 'repo', 'evil', 'qa', {}), /only sent over https/);
    fs.writeFileSync(path.join(evil, 'qa.env'), 'ADO_ORGANIZATION_URL=https://attacker.example/org\n');
    assert.throws(() => ads(repo, store, 'repo', 'evil', 'qa', {}), /not a trusted Azure DevOps host/);
    const s = ads(repo, store, 'repo', 'evil', 'qa', {}, { ...DEFAULT_SETTINGS, trustedAdoHosts: ['attacker.example'], openBrowser: false, port: 0 });
    assert.equal(s.orgUrl, 'https://attacker.example/org', 'only after the user trusts the host in personal settings');
    fs.rmSync(path.join(repo, 'config/evil'), { recursive: true, force: true });
});

test('ADO settings come from framework config; PAT from the store', () => {
    const s = adoSettingsFor(repo, store, 'repo', 'orders', 'SIT', {});
    assert.equal(s.orgUrl, 'https://dev.azure.com/acme');
    assert.equal(s.project, 'QA Project');
    assert.equal(s.pat, 'pat-value-123');
    // The Studio's proxy is never taken from the repository's config or the environment on its own:
    // it is only what the user sets in Settings → Network (off by default).
    const withEnvProxy = adoSettingsFor(repo, store, 'repo', 'orders', 'SIT', { HTTPS_PROXY: 'http://proxy.example:8080' });
    assert.equal((withEnvProxy as { connection?: unknown }).connection, undefined);
});

function fakeAdo(groups: any[]) {
    const calls: AdoRequest[] = [];
    let nextId = 100;
    const transport = async (req: AdoRequest) => {
        calls.push(req);
        const u = new URL(req.url);
        assert.equal(req.headers.Authorization, 'Basic ' + Buffer.from(':pat-value-123').toString('base64'));
        assert.equal(u.searchParams.get('api-version'), '7.1');
        if (req.method === 'GET' && u.pathname === '/acme/QA%20Project/_apis/distributedtask/variablegroups') {
            const name = u.searchParams.get('groupName');
            return { status: 200, body: JSON.stringify({ count: 1, value: groups.filter((g) => g.name === name).map((g) => ({ ...g, variables: Object.fromEntries(Object.entries(g.variables).map(([k, v]: any) => [k, v.isSecret ? { isSecret: true, value: null } : v])) })) }) };
        }
        if (req.method === 'GET' && u.pathname === '/acme/_apis/projects/QA%20Project') return { status: 200, body: JSON.stringify({ id: 'proj-guid' }) };
        if (req.method === 'POST' && u.pathname === '/acme/_apis/distributedtask/variablegroups') {
            const b = JSON.parse(req.body!); const g = { ...b, id: nextId++ }; groups.push(g); return { status: 200, body: JSON.stringify(g) };
        }
        const m = /^\/acme\/_apis\/distributedtask\/variablegroups\/(\d+)$/.exec(u.pathname);
        if (req.method === 'PUT' && m) {
            const b = JSON.parse(req.body!); const i = groups.findIndex((g) => g.id === Number(m[1]));
            // Real ADO keeps a secret's stored value when it is sent with value null.
            for (const [k, v] of Object.entries<any>(b.variables)) if (v.isSecret && v.value === null) b.variables[k] = groups[i].variables[k];
            groups[i] = { ...b, id: groups[i].id }; return { status: 200, body: JSON.stringify(groups[i]) };
        }
        return { status: 404, body: '' };
    };
    return { calls, transport, groups };
}

test('check, then create the group with secrets, then add to it without losing existing secrets', async () => {
    const ado = fakeAdo([]);
    const client = new AdoClient({ ...adoSettingsFor(repo, store, 'repo', 'orders', 'SIT', {}), transport: ado.transport });
    const req = requirements(repo, store, 'repo', 'orders', 'SIT');
    const c1 = await checkInAdo(req, client);
    assert.equal(c1.groupExists, false);
    assert.ok(c1.rows.every((r) => r.inAdo === 'missing'));

    const s1 = await syncToAdo(req, ['DB_PASSWORD_SECRET'], store, 'repo', client);
    assert.deepEqual(s1, { created: true, sent: ['DB_PASSWORD_SECRET'] });
    const post = ado.calls.find((c) => c.method === 'POST')!;
    const body = JSON.parse(post.body!);
    assert.deepEqual(body.variables, { DB_PASSWORD_SECRET: { isSecret: true, value: 'sit-db-pw' } });
    assert.deepEqual(body.variableGroupProjectReferences[0].projectReference, { id: 'proj-guid', name: 'QA Project' });

    ado.groups[0].variables.PLAIN = { value: 'keep-me' };
    store.set({ name: 'APP_PASSWORD_SECRET', project: 'repo', env: 'SIT' }, 'app-pw');
    const req2 = requirements(repo, store, 'repo', 'orders', 'SIT');
    const s2 = await syncToAdo(req2, ['APP_PASSWORD_SECRET'], store, 'repo', client);
    assert.equal(s2.created, false);
    const put = JSON.parse(ado.calls.find((c) => c.method === 'PUT')!.body!);
    assert.deepEqual(put.variables, { DB_PASSWORD_SECRET: { isSecret: true, value: null }, PLAIN: { value: 'keep-me' }, APP_PASSWORD_SECRET: { isSecret: true, value: 'app-pw' } });
    assert.equal(ado.groups[0].variables.DB_PASSWORD_SECRET.value, 'sit-db-pw', 'existing secret kept');

    const c2 = await checkInAdo(req2, client);
    assert.deepEqual(c2.rows.map((r) => [r.name, r.inAdo]), [['APP_PASSWORD_SECRET', 'secret'], ['DB_PASSWORD_SECRET', 'secret'], ['MY_ADO_PAT', 'missing']]);
    await assert.rejects(syncToAdo(req2, ['NOPE'], store, 'repo', client), /Choose at least one/);
});

test('ADO errors are explained', async () => {
    const mk = (status: number) => new AdoClient({ orgUrl: 'https://dev.azure.com/acme', project: 'p', pat: 'x', transport: async () => ({ status, body: '{"message":"boom"}' }) });
    await assert.rejects(mk(401).findVariableGroup('g'), /rejected the access token/);
    await assert.rejects(mk(403).findVariableGroup('g'), /Variable Groups/);
    await assert.rejects(mk(500).findVariableGroup('g'), /error 500: boom/);
    assert.throws(() => new AdoClient({ orgUrl: 'https://dev.azure.com/acme', project: 'p', pat: '' }), /personal access token/);
});

test('a token Azure DevOps rejects with a redirect to sign-in is reported as a rejected token', async () => {
    const { AdoClient } = await import('../src/ado/client');
    const c = new AdoClient({ orgUrl: 'https://dev.azure.com/acme', project: 'P', pat: 'old', transport: async () => ({
        status: 302, body: '<html><head><title>Object moved</title></head></html>',
        headers: { location: 'https://spsprodcin3.vssps.visualstudio.com/_signin?realm=dev.azure.com' } }) });
    await assert.rejects(c.get('build/builds'), /rejected the access token \(ADO_PAT\)/);
});
