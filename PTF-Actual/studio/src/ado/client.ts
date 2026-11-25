/**
 * Minimal Azure DevOps REST client for the Studio, using the same settings as the framework:
 * ADO_ORGANIZATION_URL (or ADO_ORGANIZATION), ADO_PROJECT, ADO_API_VERSION, and a PAT sent as
 * Basic ":PAT" (as CSADOClient does). The PAT comes from the user's secret store, never a file.
 * Proxy and trusted certificates come from the Studio's Settings → Network (off by default).
 */
import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';
import type { Connection } from '../core/network';
import { UserError } from '../core/errors';

export interface AdoSettings {
    orgUrl: string; // https://dev.azure.com/org
    project: string;
    pat: string;
    /** Instead of a PAT: an Entra ID token (Azure CLI sign-in, service principal, managed identity), renewed as it expires. */
    bearer?: () => Promise<string>;
    apiVersion?: string;
    /** Proxy and trusted certificates (Settings → Network). */
    connection?: Connection;
    /** Test hook: send requests here instead of the real server. */
    transport?: (req: AdoRequest) => Promise<AdoResponse>;
    /** Test hook: how to wait between retries (default: a real timer). */
    sleep?: (ms: number) => Promise<void>;
}

export interface AdoRequest { method: string; url: string; headers: Record<string, string>; body?: string; /** Keep the response as bytes only. */ binary?: boolean }
export interface AdoResponse { status: number; body: string; headers?: Record<string, string>; /** The undecoded bytes (binary downloads). */ raw?: Buffer }

/** Throttled (429) or briefly unavailable (503): wait as told (Retry-After), at most this many times. */
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 30_000;

export interface VariableGroup {
    id: number;
    name: string;
    type?: string;
    description?: string;
    variables: Record<string, { value?: string | null; isSecret?: boolean }>;
    variableGroupProjectReferences?: Array<{ name: string; description?: string; projectReference: { id?: string; name: string } }>;
}

/** "Could not reach" in words that point to the fix (Settings → Network). */
function reachError(e: NodeJS.ErrnoException): string {
    const code = e.code ?? '';
    if (/CERT|SELF_SIGNED|ISSUER/i.test(code) || /certificate/i.test(e.message)) {
        return 'Could not reach Azure DevOps: the connection is not trusted (certificate). On a company network, go to Settings → Network and turn on "Use this computer\'s certificates" or choose the company root certificate, then use "Test connection".';
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
        return `Could not reach Azure DevOps (${code}). If you are on a company network, set the proxy in Settings → Network and use "Test connection".`;
    }
    if (/407/.test(e.message)) return 'Could not reach Azure DevOps: the proxy asks for a login (407). Enter the proxy user name and password in Settings → Network.';
    return `Could not reach Azure DevOps: ${e.message}`;
}

/**
 * Azure DevOps answers an invalid or expired token with 401, with 203 (a sign-in page), or with a
 * redirect (302) to its sign-in page.
 */
const REJECTED = 'Azure DevOps rejected the access token (ADO_PAT). Check that it is valid, not expired, and for this organization; replace it under Secrets.';
function rejected(res: AdoResponse): boolean {
    if (res.status === 401 || res.status === 203) return true;
    return [301, 302, 303, 307].includes(res.status) && /_signin|signin|login\.microsoftonline|vssps\.visualstudio\.com/i.test(res.headers?.location ?? res.body.slice(0, 2000));
}

export class AdoError extends UserError {
    constructor(message: string, public readonly status: number) { super(message); }
}

function realTransport(conn?: Connection) {
    return (req: AdoRequest) => new Promise<AdoResponse>((resolve, reject) => {
        const u = new URL(req.url);
        const agent = conn?.agentFor(req.url);
        const r = (u.protocol === 'http:' ? http : https).request(u, { method: req.method, headers: req.headers, agent, ...(conn?.ca ? { ca: conn.ca } : {}), timeout: 30_000 }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
                const raw = Buffer.concat(chunks);
                resolve({ status: res.statusCode ?? 0, body: req.binary ? '' : raw.toString('utf8'), headers, raw });
            });
        });
        r.on('timeout', () => r.destroy(new Error('Azure DevOps did not answer within 30 seconds.')));
        r.on('error', reject);
        if (req.body) r.write(req.body);
        r.end();
    });
}

export class AdoClient {
    private readonly raw: (req: AdoRequest) => Promise<AdoResponse>;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly api: string;

    constructor(private readonly s: AdoSettings) {
        // https://dev.azure.com/org, https://org.visualstudio.com, or an Azure DevOps Server collection
        // (https://tfs.bank.local/tfs/DefaultCollection, https://ado.bank.local/Collection).
        if (!/^https:\/\/[^/]+(\/[^/]+){0,2}\/?$/.test(s.orgUrl)) throw new UserError(`ADO organization URL looks wrong: ${s.orgUrl}`);
        if (!s.project) throw new UserError('ADO_PROJECT is not set for this environment.');
        if (!s.pat && !s.bearer) throw new UserError('No ADO personal access token. Save it as a secret (Secrets → Add secret), or sign in with Entra ID (Settings → Azure DevOps).');
        this.raw = s.transport ?? realTransport(s.connection);
        this.sleep = s.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.api = s.apiVersion && /^\d+\.\d+$/.test(s.apiVersion) && Number(s.apiVersion) >= 7.1 ? s.apiVersion : '7.1';
    }

    /**
     * Send, waiting and retrying when Azure DevOps throttles (429) or is briefly unavailable (503).
     * Busy organizations rate-limit heavy users; Retry-After says how long to wait.
     */
    private async send(req: AdoRequest): Promise<AdoResponse> {
        for (let attempt = 0; ; attempt++) {
            const res = await this.raw(req);
            if ((res.status !== 429 && res.status !== 503) || attempt >= MAX_RETRIES) return res;
            const after = Number(res.headers?.['retry-after']);
            const wait = Math.min(MAX_WAIT_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
            await this.sleep(wait);
        }
    }

    /** The same client for another Azure DevOps project of the organization. */
    forProject(project: string): AdoClient {
        if (!project || project.length > 64 || /[\/:*?"<>|]/.test(project)) throw new UserError('Invalid Azure DevOps project name.');
        return new AdoClient({ ...this.s, project, transport: this.raw, sleep: this.sleep });
    }

    /** A page of a list: the items and the continuation token for the next page (if any). */
    async page<T>(pathAndQuery: string, need = 'Build (Read)'): Promise<{ data: T; next?: string }> {
        const { data, headers } = await this.callFull<T>('GET', pathAndQuery, undefined, 'project', need);
        return { data, next: headers['x-ms-continuationtoken'] || undefined };
    }

    private base(): string { return `${this.s.orgUrl.replace(/\/$/, '')}/${encodeURIComponent(this.s.project)}`; }

    /** Read helpers for other features (work items…); `need` names the token scope for a 403. */
    get<T>(pathAndQuery: string, scope: 'project' | 'org' | { team: string } = 'project', need = 'Work Items (Read)'): Promise<T> { return this.call<T>('GET', pathAndQuery, undefined, scope, need); }
    post<T>(pathAndQuery: string, body: unknown, scope: 'project' | 'org' | { team: string } = 'project', need = 'Work Items (Read)'): Promise<T> { return this.call<T>('POST', pathAndQuery, body, scope, need); }
    put<T>(pathAndQuery: string, body: unknown, scope: 'project' | 'org' | { team: string } = 'project', need = 'Code (Read & write)'): Promise<T> { return this.call<T>('PUT', pathAndQuery, body, scope, need); }
    patch<T>(pathAndQuery: string, body: unknown, scope: 'project' | 'org' | { team: string } = 'project', need = 'Code (Read & write)'): Promise<T> { return this.call<T>('PATCH', pathAndQuery, body, scope, need); }
    /** A JSON Patch document (creating or changing a work item). */
    jsonPatch<T>(method: 'POST' | 'PATCH', pathAndQuery: string, ops: unknown[], need = 'Work Items (Read & write)'): Promise<T> {
        return this.callFull<T>(method, pathAndQuery, ops, 'project', need, 'application/json-patch+json').then((r) => r.data);
    }

    /** A plain-text resource (e.g. a pipeline task log). */
    async getText(pathAndQuery: string, need = 'Build (Read)'): Promise<string> {
        const sep = pathAndQuery.includes('?') ? '&' : '?';
        const res = await this.send({
            method: 'GET', url: `${this.base()}/_apis/${pathAndQuery}${sep}api-version=${this.api}`,
            headers: { Authorization: await this.auth(), Accept: 'text/plain' },
        }).catch((e: NodeJS.ErrnoException) => { throw new AdoError(reachError(e), 0); });
        if (rejected(res)) throw new AdoError(REJECTED, res.status);
        if (res.status === 403) throw new AdoError(`Your access token is not allowed to do this. It needs the "${need}" scope.`, res.status);
        if (res.status < 200 || res.status >= 300) throw new AdoError(`Azure DevOps error ${res.status}.`, res.status);
        return res.body;
    }

    /**
     * A binary resource of the organization (e.g. a file of a build container), gunzipped when
     * Azure DevOps sends it compressed. A redirect to storage is returned as `{ redirect }` so the
     * caller downloads it without the token.
     */
    async getBinary(pathAndQuery: string, maxBytes: number, need = 'Build (Read)'): Promise<{ data: Buffer } | { redirect: string }> {
        const res = await this.send({
            method: 'GET', url: `${this.orgUrl}/_apis/${pathAndQuery}`, binary: true,
            headers: { Authorization: await this.auth(), Accept: 'application/octet-stream' },
        }).catch((e: NodeJS.ErrnoException) => { throw new AdoError(reachError(e), 0); });
        if ([301, 302, 303, 307, 308].includes(res.status) && res.headers?.location) return { redirect: new URL(res.headers.location, this.orgUrl).href };
        if (rejected(res)) throw new AdoError(REJECTED, res.status);
        if (res.status === 403) throw new AdoError(`Your access token is not allowed to do this. It needs the "${need}" scope.`, res.status);
        if (res.status < 200 || res.status >= 300) throw new AdoError(`Azure DevOps error ${res.status}.`, res.status);
        let data = res.raw ?? Buffer.from(res.body, 'utf8');
        // Only the transfer encoding is undone; a file that is itself a .gz stays as it is.
        if (/gzip/i.test(res.headers?.['content-encoding'] ?? '')) {
            data = zlib.gunzipSync(data, { maxOutputLength: maxBytes });
        }
        if (data.length > maxBytes) throw new UserError('The file is too large to download.');
        return { data };
    }

    /**
     * Analytics (OData) of the project: analytics.dev.azure.com for dev.azure.com, <org>.analytics.visualstudio.com
     * for <org>.visualstudio.com, the collection itself for Azure DevOps Server. Follows @odata.nextLink (up to
     * `maxPages`).
     */
    async odata<T>(entityAndQuery: string, maxPages = 10): Promise<T[]> {
        const u = new URL(this.orgUrl);
        const root = /(^|\.)dev\.azure\.com$/i.test(u.hostname) ? `https://analytics.dev.azure.com${u.pathname.replace(/\/$/, '')}`
            : /\.visualstudio\.com$/i.test(u.hostname) ? `https://${u.hostname.replace(/\.visualstudio\.com$/i, '.analytics.visualstudio.com')}`
                : this.orgUrl;
        let url: string | undefined = `${root}/${encodeURIComponent(this.s.project)}/_odata/v4.0-preview/${entityAndQuery}`;
        const out: T[] = [];
        const need = 'Analytics (Read)';
        for (let page = 0; url && page < maxPages; page++) {
            const res: AdoResponse = await this.send({ method: 'GET', url, headers: { Authorization: await this.auth(), Accept: 'application/json' } })
                .catch((e: NodeJS.ErrnoException) => { throw new AdoError(reachError(e), 0); });
            if (rejected(res)) throw new AdoError(REJECTED, res.status);
            if (res.status === 401 || res.status === 403) throw new AdoError(`Your access token cannot read Analytics. It needs the "${need}" scope, and you need the "View analytics" permission in the project.`, res.status);
            if (res.status === 404 || res.status === 410) throw new AdoError('Analytics is not available for this project (it may be turned off for the organization, or not installed on this Azure DevOps Server).', res.status);
            if (res.status < 200 || res.status >= 300) { let msg = res.body.slice(0, 300); try { const j = JSON.parse(res.body); msg = j.error?.message ?? j.message ?? msg; } catch { /* text */ } throw new AdoError(`Azure DevOps Analytics error ${res.status}: ${msg}`, res.status); }
            const j = JSON.parse(res.body) as { value: T[]; '@odata.nextLink'?: string };
            out.push(...j.value);
            url = j['@odata.nextLink'];
        }
        return out;
    }

    /** The Authorization header: the Entra ID token when set up, else the PAT. */
    private async auth(): Promise<string> {
        return this.s.bearer ? `Bearer ${await this.s.bearer()}` : `Basic ${Buffer.from(`:${this.s.pat}`).toString('base64')}`;
    }

    /** The organization URL (for links to the web UI). */
    get orgUrl(): string { return this.s.orgUrl.replace(/\/$/, ''); }
    get projectName(): string { return this.s.project; }

    private async call<T>(method: string, pathAndQuery: string, body?: unknown, scope: 'project' | 'org' | { team: string } = 'project', need = 'Variable Groups (Read, create, & manage)'): Promise<T> {
        return (await this.callFull<T>(method, pathAndQuery, body, scope, need)).data;
    }

    private async callFull<T>(method: string, pathAndQuery: string, body: unknown, scope: 'project' | 'org' | { team: string }, need: string, contentType = 'application/json'): Promise<{ data: T; headers: Record<string, string> }> {
        const sep = pathAndQuery.includes('?') ? '&' : '?';
        const root = scope === 'org' ? this.s.orgUrl.replace(/\/$/, '') : typeof scope === 'object' ? `${this.base()}/${encodeURIComponent(scope.team)}` : this.base();
        const res = await this.send({
            method,
            url: `${root}/_apis/${pathAndQuery}${/[?&]api-version=/.test(pathAndQuery) ? '' : `${sep}api-version=${this.api}`}`,
            headers: {
                Authorization: await this.auth(),
                Accept: 'application/json',
                ...(body !== undefined ? { 'Content-Type': contentType } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        }).catch((e: NodeJS.ErrnoException) => { throw new AdoError(reachError(e), 0); });
        if (rejected(res)) throw new AdoError(REJECTED, res.status);
        if (res.status === 403) throw new AdoError(`Your access token is not allowed to do this. It needs the "${need}" scope.`, res.status);
        if (res.status === 404) throw new AdoError(`Not found in Azure DevOps (organization or project "${this.s.project}").`, res.status);
        if (res.status === 429) throw new AdoError('Azure DevOps is limiting requests right now (too many in a short time). Wait a minute and try again.', res.status);
        if (res.status < 200 || res.status >= 300) {
            let msg = res.body.slice(0, 300);
            try { msg = JSON.parse(res.body).message ?? msg; } catch { /* not json */ }
            throw new AdoError(`Azure DevOps error ${res.status}: ${msg}`, res.status);
        }
        return { data: (res.body ? JSON.parse(res.body) : undefined) as T, headers: res.headers ?? {} };
    }

    /**
     * A page of the project's wiki (or the named wiki), created or replaced with Markdown: the page's version (ETag)
     * is read first, as the wiki requires to change a page. Returns the page's web address.
     */
    async putWikiPage(pagePath: string, markdown: string, wiki?: string): Promise<{ url: string; created: boolean }> {
        const need = 'Wiki (Read & write)';
        let w = wiki;
        if (!w) {
            const all = await this.call<{ value: Array<{ name: string; type: string }> }>('GET', 'wiki/wikis', undefined, 'project', need);
            w = all.value.find((x) => x.type === 'projectWiki')?.name ?? all.value[0]?.name;
            if (!w) throw new AdoError('This project has no wiki yet: create it in Azure DevOps (Overview → Wiki) first.', 404);
        }
        const p = `/${pagePath.replace(/^\/+/, '')}`;
        const url = `${this.base()}/_apis/wiki/wikis/${encodeURIComponent(w)}/pages?path=${encodeURIComponent(p)}&api-version=7.1`;
        const auth = await this.auth();
        const head = await this.send({ method: 'GET', url, headers: { Authorization: auth, Accept: 'application/json' } }).catch((e: NodeJS.ErrnoException) => { throw new AdoError(reachError(e), 0); });
        if (rejected(head)) throw new AdoError(REJECTED, head.status);
        const etag = head.status === 200 ? (head.headers?.etag ?? head.headers?.ETag) : undefined;
        // Parent pages must exist: each missing one is made (empty).
        if (head.status === 404) {
            const parts = p.split('/').filter(Boolean);
            for (let i = 1; i < parts.length; i++) {
                const parent = `/${parts.slice(0, i).join('/')}`;
                const pu = `${this.base()}/_apis/wiki/wikis/${encodeURIComponent(w)}/pages?path=${encodeURIComponent(parent)}&api-version=7.1`;
                const g = await this.send({ method: 'GET', url: pu, headers: { Authorization: auth, Accept: 'application/json' } });
                if (g.status === 404) await this.send({ method: 'PUT', url: pu, headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '' }) });
            }
        }
        const res = await this.send({ method: 'PUT', url, headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) }, body: JSON.stringify({ content: markdown }) })
            .catch((e: NodeJS.ErrnoException) => { throw new AdoError(reachError(e), 0); });
        if (res.status === 403) throw new AdoError(`Your access token is not allowed to do this. It needs the "${need}" scope.`, 403);
        if (res.status < 200 || res.status >= 300) { let msg = res.body.slice(0, 300); try { msg = JSON.parse(res.body).message ?? msg; } catch { /* text */ } throw new AdoError(`Azure DevOps error ${res.status}: ${msg}`, res.status); }
        let remote = '';
        try { remote = JSON.parse(res.body).remoteUrl ?? ''; } catch { /* none */ }
        return { url: remote || `${this.base()}/_wiki/wikis/${encodeURIComponent(w)}?pagePath=${encodeURIComponent(p)}`, created: !etag };
    }

    async findVariableGroup(name: string): Promise<VariableGroup | null> {
        const r = await this.call<{ value: VariableGroup[] }>('GET', `distributedtask/variablegroups?groupName=${encodeURIComponent(name)}`);
        return r.value.find((g) => g.name.toLowerCase() === name.toLowerCase()) ?? null;
    }

    async projectId(): Promise<string> {
        const r = await this.send({
            method: 'GET',
            url: `${this.s.orgUrl.replace(/\/$/, '')}/_apis/projects/${encodeURIComponent(this.s.project)}?api-version=${this.api}`,
            headers: { Authorization: await this.auth(), Accept: 'application/json' },
        });
        if (r.status !== 200) throw new AdoError(`Could not look up project "${this.s.project}" (HTTP ${r.status}).`, r.status);
        return JSON.parse(r.body).id;
    }

    /**
     * Add or replace secret variables in a variable group, creating the group if needed.
     * Existing variables are sent back unchanged: Azure DevOps keeps a secret's stored value when
     * it is sent with isSecret=true and no value (it never returns secret values).
     */
    async upsertSecrets(groupName: string, secrets: Record<string, string>, description: string): Promise<{ created: boolean; group: VariableGroup }> {
        const existing = await this.findVariableGroup(groupName);
        const vars: VariableGroup['variables'] = {};
        if (existing) for (const [k, v] of Object.entries(existing.variables)) vars[k] = v.isSecret ? { isSecret: true, value: null } : { value: v.value ?? '' };
        for (const [k, v] of Object.entries(secrets)) vars[k] = { isSecret: true, value: v };
        const projectId = existing?.variableGroupProjectReferences?.[0]?.projectReference.id ?? await this.projectId();
        const body = {
            name: existing?.name ?? groupName,
            description: existing?.description ?? description,
            type: 'Vsts',
            variables: vars,
            variableGroupProjectReferences: [{ name: existing?.name ?? groupName, description: existing?.description ?? description, projectReference: { id: projectId, name: this.s.project } }],
        };
        if (existing) {
            const g = await this.call<VariableGroup>('PUT', `distributedtask/variablegroups/${existing.id}`, body, 'org');
            return { created: false, group: g };
        }
        const g = await this.call<VariableGroup>('POST', 'distributedtask/variablegroups', body, 'org');
        return { created: true, group: g };
    }
}
