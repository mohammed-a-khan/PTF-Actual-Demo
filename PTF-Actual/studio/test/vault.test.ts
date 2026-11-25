import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SecretVault, VaultHttp } from '../src/api/vault';
import { withVault } from '../src/load/prepare';
import { sigv4 } from '../src/api/httpAuth';

/** Stand-ins for Entra ID, Azure Key Vault, HashiCorp Vault and AWS Secrets Manager (each checks its sign-in). */
function fakeClouds() {
    const calls: string[] = [];
    const http: VaultHttp = async (method, url, headers, body) => {
        const u = new URL(url);
        calls.push(`${method} ${u.host}${u.pathname}`);
        const ok = (o: unknown) => ({ status: 200, body: JSON.stringify(o) });
        if (u.host === 'login.microsoftonline.com') {
            const f = new URLSearchParams(body);
            if (u.pathname !== '/tenant-1/oauth2/v2.0/token' || f.get('client_secret') !== 'sp-secret' || f.get('scope') !== 'https://vault.azure.net/.default') return { status: 401, body: '{"error_description":"bad client"}' };
            return ok({ access_token: 'aad-token', expires_in: 3599 });
        }
        if (u.host === 'qa-vault.vault.azure.net') {
            if (headers.Authorization !== 'Bearer aad-token') return { status: 401, body: '{}' };
            if (u.pathname === '/secrets/db-password' && u.searchParams.get('api-version') === '7.4') return ok({ value: 'S3cr3t-from-KV', id: 'x' });
            return { status: 404, body: '{}' };
        }
        if (u.host === 'vault.bank.local:8200') {
            if (u.pathname === '/v1/auth/approle/login') return JSON.parse(body ?? '{}').secret_id === 'sid' ? ok({ auth: { client_token: 'hv-token' } }) : { status: 400, body: '{"errors":["invalid secret id"]}' };
            if (headers['X-Vault-Token'] !== 'hv-token') return { status: 403, body: '{"errors":["permission denied"]}' };
            if (u.pathname === '/v1/secret/data/qa/api') return ok({ data: { data: { key: 'kv2-value', n: 7 }, metadata: { version: 3 } } });
            if (u.pathname === '/v1/kv1/qa') return ok({ data: { key: 'kv1-value' } });
            return { status: 404, body: '{"errors":[]}' };
        }
        if (u.host === 'secretsmanager.eu-west-1.amazonaws.com') {
            // Recompute the signature the way AWS does (same request, same time).
            const date = headers['X-Amz-Date'];
            const again = sigv4({ method, url, headers: { 'Content-Type': headers['Content-Type'], 'X-Amz-Target': headers['X-Amz-Target'] }, body, accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'aws-secret', region: 'eu-west-1', service: 'secretsmanager', date: new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`) });
            if (headers.Authorization !== again.Authorization) return { status: 403, body: '{"message":"The request signature we calculated does not match"}' };
            const id = JSON.parse(body ?? '{}').SecretId;
            if (id === 'qa/api-keys') return ok({ SecretString: '{"partner":"pk-123","other":"x"}' });
            if (id === 'qa/plain') return ok({ SecretString: 'plain-value' });
            return { status: 400, body: '{"__type":"ResourceNotFoundException","message":"Secrets Manager can\'t find the specified secret."}' };
        }
        return { status: 404, body: '' };
    };
    return { http, calls };
}

test('vault references: Azure Key Vault (service principal), HashiCorp (KV v2, v1, AppRole), AWS Secrets Manager (signed); read once; clear errors', async () => {
    const f = fakeClouds();
    const v = new SecretVault({ AZURE_CLIENT_ID: 'app-1', AZURE_CLIENT_SECRET: 'sp-secret', AZURE_TENANT_ID: 'tenant-1', VAULT_ADDR: 'http://vault.bank.local:8200', VAULT_ROLE_ID: 'rid', VAULT_SECRET_ID: 'sid', AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'aws-secret' }, f.http);
    assert.equal(await v.resolveText('{kv:qa-vault/db-password}'), 'S3cr3t-from-KV');
    assert.equal(await v.resolveText('Server=db;Password={kv:qa-vault/db-password};User={vault:secret/data/qa/api#key}'), 'Server=db;Password=S3cr3t-from-KV;User=kv2-value');
    assert.equal(await v.resolveText('{vault:secret/data/qa/api::n}'), '7');
    assert.equal(await v.resolveText('{vault:kv1/qa#key}'), 'kv1-value');
    assert.equal(await v.resolveText('{awssm:qa/api-keys::partner}'), 'pk-123');
    assert.equal(await v.resolveText('{awssm:qa/api-keys#partner}'), 'pk-123');
    assert.equal(await v.resolveText('{awssm:qa/plain}'), 'plain-value');
    // Each sign-in once, each secret once.
    assert.equal(f.calls.filter((c) => c.includes('oauth2')).length, 1);
    assert.equal(f.calls.filter((c) => c.endsWith('/secrets/db-password')).length, 1);
    assert.equal(f.calls.filter((c) => c.includes('approle')).length, 1);
    // Errors say what to do.
    await assert.rejects(v.resolveText('{kv:qa-vault/missing}'), /no secret "missing" in https:\/\/qa-vault\.vault\.azure\.net/);
    await assert.rejects(v.resolveText('{kv:just-a-name}'), /write \{kv:VAULT\/SECRET\}/);
    await assert.rejects(v.resolveText('{vault:secret/data/qa/api#nope}'), /no field "nope"/);
    await assert.rejects(v.resolveText('{awssm:qa/none}'), /can't find the specified secret/);
    await assert.rejects(new SecretVault({}, f.http).resolveText('{vault:x#y}'), /VAULT_ADDR is not set/);
    await assert.rejects(new SecretVault({ AWS_REGION: 'eu-west-1' }, f.http).resolveText('{awssm:x}'), /No AWS sign-in/);
});

test('in the Studio: configuration values that are vault references are read before requests, the collection variables use them, and they are masked', async () => {
    const f = fakeClouds();
    const vault = new SecretVault({ AZURE_CLIENT_ID: 'app-1', AZURE_CLIENT_SECRET: 'sp-secret', AZURE_TENANT_ID: 'tenant-1' }, f.http);
    const r = await withVault({ values: { vars: {}, config: { DB_PASSWORD: '{kv:qa-vault/db-password}', BASE_URL: 'https://api.test' }, env: {} }, secrets: [] },
        { variables: [{ key: 'auth', value: 'Basic {config:DB_PASSWORD}' }] }, vault);
    assert.equal(r.values.config.DB_PASSWORD, 'S3cr3t-from-KV');
    assert.equal(r.values.vars.auth, 'Basic S3cr3t-from-KV');
    assert.ok(r.secrets.includes('S3cr3t-from-KV'), 'masked in what the Studio shows');
});

test('Azure DevOps with Entra ID instead of a PAT: a token for the Azure DevOps resource, sent as Bearer, renewed only when it expires', async () => {
    const { azureAccessToken, AZURE_DEVOPS_RESOURCE } = await import('../src/api/vault');
    const { AdoClient } = await import('../src/ado/client');
    let scope = '';
    const t = await azureAccessToken(AZURE_DEVOPS_RESOURCE, { AZURE_CLIENT_ID: 'app', AZURE_CLIENT_SECRET: 's', AZURE_TENANT_ID: 't' }, async (_m, _u, _h, body) => { scope = new URLSearchParams(body).get('scope') ?? ''; return { status: 200, body: '{"access_token":"ado-entra-token","expires_in":3600}' }; });
    assert.equal(scope, '499b84ac-1321-427f-aa17-267ca6975798/.default');
    assert.equal(t.token, 'ado-entra-token');
    const seen: string[] = [];
    let issued = 0;
    const client = new AdoClient({ orgUrl: 'https://dev.azure.com/org', project: 'p', pat: '', bearer: async () => { issued++; return t.token; },
        transport: async (req) => { seen.push(req.headers.Authorization); return { status: 200, body: '{"value":[]}' }; } });
    await client.findVariableGroup('qa');
    assert.deepEqual(seen, ['Bearer ado-entra-token']);
    assert.equal(issued, 1);
});

test('Azure DevOps Server collections are accepted as the organization address', async () => {
    const { AdoClient } = await import('../src/ado/client');
    const urls: string[] = [];
    const c = new AdoClient({ orgUrl: 'https://tfs.bank.local/tfs/DefaultCollection', project: 'Payments', pat: 'x', transport: async (r) => { urls.push(r.url); return { status: 200, body: '{"value":[]}' }; } });
    await c.findVariableGroup('qa');
    assert.match(urls[0], /^https:\/\/tfs\.bank\.local\/tfs\/DefaultCollection\/Payments\/_apis\/distributedtask\/variablegroups\?/);
    assert.throws(() => new AdoClient({ orgUrl: 'https://tfs.bank.local/a/b/c', project: 'p', pat: 'x' }), /looks wrong/);
});
