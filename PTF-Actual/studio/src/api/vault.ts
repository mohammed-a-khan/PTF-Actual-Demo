/**
 * Secrets kept in a vault, written as references in configuration or secret values (shared by the Studio and the
 * framework, so a test reads the same value on a laptop and in a pipeline):
 *   {kv:VAULT/SECRET}          Azure Key Vault (VAULT is the vault's name or its https://… address)
 *   {vault:PATH::FIELD}        HashiCorp Vault (KV version 1 or 2; PATH as in the API, e.g. secret/data/qa/db)
 *   {awssm:NAME}  {awssm:NAME::FIELD}  AWS Secrets Manager (FIELD: a key of a JSON secret; NAME may be an ARN)
 * The field separator is "::" (safe in .env files, where # starts a comment); "#" works too where it is not a comment.
 * Sign-in, from the environment (the pipeline's or this computer's):
 *   Azure: AZURE_CLIENT_ID + AZURE_CLIENT_SECRET + AZURE_TENANT_ID (a service principal), else a managed identity
 *          (IDENTITY_ENDPOINT + IDENTITY_HEADER, or AZURE_USE_MANAGED_IDENTITY=true), else the Azure CLI's sign-in
 *          (az login / the AzureCLI pipeline task);
 *   HashiCorp: VAULT_ADDR with VAULT_TOKEN, or VAULT_ROLE_ID + VAULT_SECRET_ID (AppRole); VAULT_NAMESPACE optional;
 *   AWS: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN), AWS_REGION.
 * Values are kept for the process (one read per reference); tokens until they expire.
 */
import * as http from 'http';
import * as https from 'https';
import { execFile } from 'child_process';
import { sigv4 } from './httpAuth';

export type VaultHttp = (method: string, url: string, headers: Record<string, string>, body?: string) => Promise<{ status: number; body: string }>;

export const VAULT_REF = /\{(kv|vault|awssm):([^{}]+)\}/g;
/** A whole value that is one reference. */
export const isVaultRef = (v: string) => /^\{(kv|vault|awssm):[^{}]+\}$/.test(v.trim());

/** Plain HTTPS (through HTTPS_PROXY when set). */
export function defaultVaultHttp(env: NodeJS.ProcessEnv = process.env): VaultHttp {
    return (method, url, headers, body) => new Promise((resolve, reject) => {
        const u = new URL(url);
        let agent: http.Agent | undefined;
        const proxy = env.HTTPS_PROXY || env.https_proxy;
        if (proxy && u.protocol === 'https:' && !(env.NO_PROXY || env.no_proxy || '').split(',').some((h) => h.trim() && u.hostname.endsWith(h.trim().replace(/^\*/, '')))) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { HttpsProxyAgent } = require('https-proxy-agent');
            agent = new HttpsProxyAgent(proxy);
        }
        const req = (u.protocol === 'http:' ? http : https).request(u, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) }, timeout: 30_000, ...(agent ? { agent } : {}) }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(new Error(`No answer from ${u.host}`)));
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

const json = (t: string): any => { try { return JSON.parse(t); } catch { return undefined; } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const az = (args: string[]) => new Promise<string>((res, rej) => execFile(process.platform === 'win32' ? 'az.cmd' : 'az', args, { windowsHide: true, timeout: 60_000, shell: process.platform === 'win32' }, (e, out, err) => (e ? rej(new Error(String(err || e.message).split('\n')[0])) : res(String(out)))));

/** "PATH::FIELD" or "PATH#FIELD" → [PATH, FIELD]. */
export function splitField(ref: string): [string, string | undefined] {
    const i = ref.lastIndexOf('::'), j = ref.lastIndexOf('#');
    if (i >= 0 && i > j) return [ref.slice(0, i), ref.slice(i + 2)];
    if (j >= 0) return [ref.slice(0, j), ref.slice(j + 1)];
    return [ref, undefined];
}

/**
 * An Entra ID (Azure AD) access token for a resource: a service principal (AZURE_CLIENT_ID / AZURE_CLIENT_SECRET /
 * AZURE_TENANT_ID), else a managed identity, else the Azure CLI's sign-in (az login).
 */
export async function azureAccessToken(resource: string, env: NodeJS.ProcessEnv, httpCall: VaultHttp = defaultVaultHttp(env)): Promise<{ token: string; expiresIn: number }> {
    const e = env;
    if (e.AZURE_CLIENT_ID && e.AZURE_CLIENT_SECRET && e.AZURE_TENANT_ID) {
        const host = (e.AZURE_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, '');
        const r = await httpCall('POST', `${host}/${encodeURIComponent(e.AZURE_TENANT_ID)}/oauth2/v2.0/token`, { 'Content-Type': 'application/x-www-form-urlencoded' },
            new URLSearchParams({ grant_type: 'client_credentials', client_id: e.AZURE_CLIENT_ID, client_secret: e.AZURE_CLIENT_SECRET, scope: `${resource}/.default` }).toString());
        const j = json(r.body);
        if (r.status >= 400 || !j?.access_token) throw new Error(`Azure sign-in (service principal) failed: HTTP ${r.status}${j?.error_description ? ` ${String(j.error_description).split('\n')[0]}` : ''}`);
        return { token: j.access_token, expiresIn: Number(j.expires_in ?? 3000) };
    }
    if (e.IDENTITY_ENDPOINT && e.IDENTITY_HEADER) {
        const r = await httpCall('GET', `${e.IDENTITY_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01${e.AZURE_CLIENT_ID ? `&client_id=${encodeURIComponent(e.AZURE_CLIENT_ID)}` : ''}`, { 'X-IDENTITY-HEADER': e.IDENTITY_HEADER });
        const j = json(r.body);
        if (r.status >= 400 || !j?.access_token) throw new Error(`Azure sign-in (managed identity) failed: HTTP ${r.status}`);
        return { token: j.access_token, expiresIn: 3000 };
    }
    if (/^(1|true|yes)$/i.test(e.AZURE_USE_MANAGED_IDENTITY ?? '')) {
        const r = await httpCall('GET', `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(resource)}${e.AZURE_CLIENT_ID ? `&client_id=${encodeURIComponent(e.AZURE_CLIENT_ID)}` : ''}`, { Metadata: 'true' });
        const j = json(r.body);
        if (r.status >= 400 || !j?.access_token) throw new Error(`Azure sign-in (managed identity) failed: HTTP ${r.status}`);
        return { token: j.access_token, expiresIn: 3000 };
    }
    let out: string;
    try { out = await az(['account', 'get-access-token', '--resource', resource, '-o', 'json']); }
    catch (err) { throw new Error(`No Azure sign-in: set AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID, or sign in with "az login" (${(err as Error).message}).`); }
    const j = json(out);
    if (!j?.accessToken) throw new Error('The Azure CLI did not return a token.');
    return { token: j.accessToken, expiresIn: j.expiresOn ? Math.max(60, (Date.parse(j.expiresOn) - Date.now()) / 1000) : 3000 };
}

/** Azure DevOps' Entra ID application (the resource of an Azure DevOps token). */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

export class SecretVault {
    private readonly values = new Map<string, Promise<string>>();
    private azureToken: { token: string; until: number } | null = null;
    private vaultToken: string | null = null;
    constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly httpCall: VaultHttp = defaultVaultHttp(env)) {}

    /** The secret a reference names ("kv:vault/name" etc., without braces), read once. */
    get(kind: string, ref: string): Promise<string> {
        const key = `${kind}:${ref}`;
        let p = this.values.get(key);
        if (!p) {
            p = kind === 'kv' ? this.keyVault(ref) : kind === 'vault' ? this.hashicorp(ref) : kind === 'awssm' ? this.awsSm(ref) : Promise.reject(new Error(`Unknown vault "${kind}"`));
            // A failed read is tried again next time (the sign-in may have been fixed).
            p.catch(() => this.values.delete(key));
            this.values.set(key, p);
        }
        return p;
    }

    /** Every {kv:…}/{vault:…}/{awssm:…} in a text replaced by its secret. */
    async resolveText(text: string): Promise<string> {
        const refs = [...text.matchAll(VAULT_REF)];
        if (!refs.length) return text;
        const got = await Promise.all(refs.map((m) => this.get(m[1], m[2].trim())));
        let i = 0;
        return text.replace(VAULT_REF, () => got[i++]);
    }

    /** The values of a map that hold references, resolved in place; returns the names it changed. */
    async resolveMap(map: Record<string, string | undefined>): Promise<string[]> {
        const names = Object.keys(map).filter((k) => typeof map[k] === 'string' && /\{(kv|vault|awssm):/.test(map[k]!));
        await Promise.all(names.map(async (k) => { map[k] = await this.resolveText(map[k]!); }));
        return names;
    }

    // ---------------------------------------------------------------- Azure Key Vault

    private async azure(): Promise<string> {
        if (this.azureToken && this.azureToken.until > Date.now()) return this.azureToken.token;
        const t = await azureAccessToken('https://vault.azure.net', this.env, this.httpCall);
        this.azureToken = { token: t.token, until: Date.now() + (t.expiresIn - 120) * 1000 };
        return t.token;
    }

    private async keyVault(ref: string): Promise<string> {
        const i = ref.lastIndexOf('/');
        if (i <= 0) throw new Error(`{kv:${ref}}: write {kv:VAULT/SECRET}`);
        const vault = ref.slice(0, i), name = ref.slice(i + 1);
        const base = /^https:\/\//i.test(vault) ? vault.replace(/\/+$/, '') : `https://${vault}.vault.azure.net`;
        const r = await this.httpCall('GET', `${base}/secrets/${encodeURIComponent(name)}?api-version=7.4`, { Authorization: `Bearer ${await this.azure()}`, Accept: 'application/json' });
        const j = json(r.body);
        if (r.status === 404) throw new Error(`{kv:${ref}}: no secret "${name}" in ${base}`);
        if (r.status === 403) throw new Error(`{kv:${ref}}: not allowed to read secrets of ${base} (ask for the "Key Vault Secrets User" role)`);
        if (r.status >= 400 || typeof j?.value !== 'string') throw new Error(`{kv:${ref}}: HTTP ${r.status}`);
        return j.value;
    }

    // ---------------------------------------------------------------- HashiCorp Vault

    private async hashicorpToken(): Promise<string> {
        const e = this.env;
        if (this.vaultToken) return this.vaultToken;
        if (e.VAULT_TOKEN) return (this.vaultToken = e.VAULT_TOKEN);
        if (e.VAULT_ROLE_ID && e.VAULT_SECRET_ID) {
            const r = await this.httpCall('POST', `${this.vaultAddr()}/v1/auth/approle/login`, { 'Content-Type': 'application/json', ...(e.VAULT_NAMESPACE ? { 'X-Vault-Namespace': e.VAULT_NAMESPACE } : {}) }, JSON.stringify({ role_id: e.VAULT_ROLE_ID, secret_id: e.VAULT_SECRET_ID }));
            const t = json(r.body)?.auth?.client_token;
            if (r.status >= 400 || !t) throw new Error(`HashiCorp Vault sign-in (AppRole) failed: HTTP ${r.status}`);
            return (this.vaultToken = t);
        }
        throw new Error('No HashiCorp Vault sign-in: set VAULT_TOKEN, or VAULT_ROLE_ID and VAULT_SECRET_ID.');
    }
    private vaultAddr(): string {
        const a = this.env.VAULT_ADDR;
        if (!a) throw new Error('VAULT_ADDR is not set (the HashiCorp Vault address).');
        return a.replace(/\/+$/, '');
    }

    private async hashicorp(ref: string): Promise<string> {
        const [p, field] = splitField(ref);
        if (!field) throw new Error(`{vault:${ref}}: write {vault:PATH::FIELD}`);
        const r = await this.httpCall('GET', `${this.vaultAddr()}/v1/${p.replace(/^\/+/, '')}`, { 'X-Vault-Token': await this.hashicorpToken(), ...(this.env.VAULT_NAMESPACE ? { 'X-Vault-Namespace': this.env.VAULT_NAMESPACE } : {}) });
        const j = json(r.body);
        if (r.status >= 400) throw new Error(`{vault:${ref}}: HTTP ${r.status}${j?.errors?.length ? ` ${j.errors.join('; ')}` : ''}`);
        // KV v2 nests the fields one level deeper (data.data).
        const data = j?.data?.data && typeof j.data.data === 'object' && j.data.metadata ? j.data.data : j?.data;
        const v = data?.[field];
        if (v === undefined) throw new Error(`{vault:${ref}}: no field "${field}"`);
        return typeof v === 'string' ? v : JSON.stringify(v);
    }

    // ---------------------------------------------------------------- AWS Secrets Manager

    private async awsSm(ref: string): Promise<string> {
        const e = this.env;
        const [name, field] = splitField(ref);
        const region = e.AWS_REGION || e.AWS_DEFAULT_REGION;
        if (!region) throw new Error('AWS_REGION is not set (for AWS Secrets Manager).');
        if (!e.AWS_ACCESS_KEY_ID || !e.AWS_SECRET_ACCESS_KEY) throw new Error('No AWS sign-in: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary keys).');
        const url = e.AWS_SECRETSMANAGER_ENDPOINT || `https://secretsmanager.${region}.amazonaws.com/`;
        const body = JSON.stringify({ SecretId: name });
        const headers: Record<string, string> = { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'secretsmanager.GetSecretValue' };
        Object.assign(headers, sigv4({ method: 'POST', url, headers, body, accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY, sessionToken: e.AWS_SESSION_TOKEN, region, service: 'secretsmanager' }));
        const r = await this.httpCall('POST', url, headers, body);
        const j = json(r.body);
        if (r.status >= 400) throw new Error(`{awssm:${ref}}: HTTP ${r.status}${j?.message || j?.Message ? ` ${j.message ?? j.Message}` : ''}`);
        const s = typeof j?.SecretString === 'string' ? j.SecretString : j?.SecretBinary ? Buffer.from(j.SecretBinary, 'base64').toString('utf8') : undefined;
        if (s === undefined) throw new Error(`{awssm:${ref}}: the secret has no value`);
        if (!field) return s;
        const o = json(s);
        if (!o || o[field] === undefined) throw new Error(`{awssm:${ref}}: no key "${field}" in the secret`);
        return typeof o[field] === 'string' ? o[field] : JSON.stringify(o[field]);
    }
}
