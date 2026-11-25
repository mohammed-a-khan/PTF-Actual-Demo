/**
 * Send a request from the API workspace and evaluate its checks, the way the framework's API steps
 * would (see jsonPath.ts). Values come from:
 *   {{name}}      the collection's variables and values saved by earlier requests;
 *   {config:KEY}  the project/environment configuration (as a test run sees it);
 *   {env:NAME}    the Studio's secrets for this project/environment, then the process environment.
 * Network: the Studio's Settings → Network (proxy, trusted certificates).
 */
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { performance } from 'perf_hooks';
import type { Connection } from '../core/network';
import { ApiAuth, ApiCheck, ApiCollection, ApiExtract, ApiRequest, graphqlJson, KV } from './model';
import { checkValue as pathCheckValue, expectedValue, JsonPath, readPath, sameValue } from './jsonPath';
import { evaluateExtra, extractExtra, type QueryRows } from './checks';
import { fillDynamic, normalizeSyntax, TemplateResolver } from './dynamic';
import { CookieJar, mergeCookieHeader } from './cookies';
import { digestAuthorization, ntlmParseType2, ntlmType1, ntlmType3, parseDigest, sigv4, signJwt } from './httpAuth';
import { asapToken, edgegridHeader, hawkHeader, oauth1Header } from './moreAuth';
import { storedAccessToken, tokenKey, type StoredToken } from './oauth2';
import { negotiateClient } from './negotiate';

export interface Values {
    vars: Record<string, string>;
    config: Record<string, string>;
    env: Record<string, string | undefined>;
    /** A test data row (a Scenario Outline's <column> values). */
    row?: Record<string, string>;
    /** Reads a file of the project (schema files, payloads). */
    readFile?: (rel: string) => Buffer;
    /** OAuth2 tokens from browser sign-ins (authorization code, implicit, device code), by tokenKey (they cross to load workers). */
    tokens?: Record<string, StoredToken>;
}

/**
 * Replace <column> (a test data row's value), the framework's dynamic values (<uuid>, <timestamp>, <random>,
 * <date:FORMAT>, <generate:TYPE>), {{name}}, {config:KEY} and {env:NAME}; names that are not known are reported.
 */
export function fill(text: string, v: Values, missing?: Set<string>): string {
    const row = v.row;
    return fillDynamic(row ? text.replace(/<([\w .-]+)>/g, (m, n: string) => (n in row ? row[n] : m)) : text, v.env)
        .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, n: string) => { if (n in v.vars) return v.vars[n]; missing?.add(`{{${n}}}`); return m; })
        .replace(/\{config:([\w.-]+)\}/g, (m, k: string) => { if (k in v.config) return v.config[k]; missing?.add(`{config:${k}}`); return m; })
        .replace(/\{env:([\w.-]+)\}/g, (m, k: string) => { const x = v.env[k]; if (x !== undefined) return x; missing?.add(`{env:${k}}`); return m; });
}

/**
 * A payload template, filled as the framework's payload loader fills it: ${x} → {{x}}, then {{name}}, {{a.b[0]}},
 * functions ({{uuid()}}, {{jsonEncode(name)}}, {{date("YYYY-MM-DD")}}, {{faker.email()}}…) and pipes
 * ({{name | uppercase}}) over the saved values and the row's columns (see dynamic.ts); then <column>, dynamic values,
 * {config:KEY}, {env:NAME}.
 */
export function fillTemplate(text: string, v: Values, missing?: Set<string>): string {
    const vars = new Map<string, unknown>(Object.entries({ ...(v.row ?? {}), ...v.vars }));
    return fill(new TemplateResolver(vars, v.env).resolve(normalizeSyntax(text)), v, missing);
}

export interface PreparedRequest {
    method: string; url: string; headers: Record<string, string>; body?: string | Buffer; missing: string[];
    /** NTLM / Digest: answered when the server challenges (see send). */
    challenge?: { type: 'ntlm' | 'digest' | 'negotiate'; username: string; password: string; domain?: string; workstation?: string; spn?: string };
}

const on = (kv: KV) => kv.enabled !== false && kv.key.trim() !== '';

/** The request as it goes on the wire (values filled in). OAuth2 needs `authorize` (a token request). */
export function prepare(c: Pick<ApiCollection, 'baseUrl' | 'auth'>, r: ApiRequest, v: Values, o: { readFile?: (rel: string) => Buffer } = {}): PreparedRequest {
    const missing = new Set<string>();
    const f = (s: string) => fill(s, v, missing);
    let url = f(r.url.trim());
    // Absolute: http(s), and the other protocols' addresses (ws://, mqtt://, kafka://, grpc://…).
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        const base = f(c.baseUrl.trim()).replace(/\/+$/, '');
        url = base + (url && !url.startsWith('/') && !url.startsWith('?') ? '/' : '') + url;
    }
    const params = r.query.filter(on).map((q) => `${encodeURIComponent(f(q.key))}=${encodeURIComponent(f(q.value))}`);
    const headers: Record<string, string> = {};
    for (const h of r.headers.filter(on)) headers[f(h.key)] = f(h.value);
    // An Authorization header written on the request itself wins over the collection's authentication.
    const ownAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
    // (Only a sign-in that writes Authorization is replaced: an API key in its own header, X-Key, is still sent.)
    const writesAuthorization = (a: ApiAuth) => !(a.type === 'none' || a.type === 'inherit' || (a.type === 'apikey' && (a.in === 'query' || (a.key ?? '').toLowerCase() !== 'authorization')));
    const auth: ApiAuth = r.auth.type === 'inherit' ? (ownAuthHeader && writesAuthorization(c.auth) ? { type: 'none' } : c.auth) : r.auth;
    if (auth.type === 'bearer' && !f(auth.token ?? '').trim()) missing.add('the bearer token (Auth)');
    if (auth.type === 'basic') headers.Authorization = 'Basic ' + Buffer.from(`${f(auth.username ?? '')}:${f(auth.password ?? '')}`).toString('base64');
    else if (auth.type === 'bearer') headers.Authorization = `Bearer ${f(auth.token ?? '')}`;
    else if (auth.type === 'apikey' && auth.key) {
        if (auth.in === 'query') params.push(`${encodeURIComponent(f(auth.key))}=${encodeURIComponent(f(auth.value ?? ''))}`);
        else headers[f(auth.key)] = f(auth.value ?? '');
    }
    const challenge = auth.type === 'ntlm' || auth.type === 'digest'
        ? { type: auth.type, username: f(auth.username ?? ''), password: f(auth.password ?? ''), ...(auth.type === 'ntlm' ? { domain: f(auth.domain ?? ''), workstation: f(auth.workstation ?? '') } : {}) }
        : auth.type === 'negotiate' ? { type: 'negotiate' as const, username: '', password: '', ...(auth.spn ? { spn: f(auth.spn) } : {}) } : undefined;
    if (params.length) url += (url.includes('?') ? '&' : '?') + params.join('&');
    let body: string | Buffer | undefined;
    const has = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name);
    if (r.body.mode === 'multipart') {
        const boundary = `----CSStudio${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        const parts: Buffer[] = [];
        for (const part of (r.body.parts ?? []).filter(on)) {
            const name = f(part.key).replace(/"/g, '%22');
            if (part.type === 'file') {
                const rel = f(part.value).trim();
                if (!rel) { missing.add(`the file of the part "${f(part.key)}" (choose a file of the project)`); continue; }
                let data: Buffer;
                try { data = o.readFile ? o.readFile(rel) : Buffer.alloc(0); } catch { missing.add(`the file ${rel} (not found in the project)`); continue; }
                const file = rel.split(/[\\/]/).pop()!.replace(/"/g, '%22');
                parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${file}"\r\nContent-Type: ${mimeOf(file)}\r\n\r\n`), data, Buffer.from('\r\n'));
            } else parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${f(part.value)}\r\n`));
        }
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        body = Buffer.concat(parts);
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else if (r.body.mode === 'form') {
        body = (r.body.form ?? []).filter(on).map((p) => `${encodeURIComponent(f(p.key))}=${encodeURIComponent(f(p.value))}`).join('&');
        if (!has('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (r.body.mode === 'file') {
        // A payload template of the project (PAYLOAD_BASE_PATH), filled as the framework fills it.
        const rel = `${(v.config.PAYLOAD_BASE_PATH || 'test-data/payloads').replace(/[\\/]+$/, '')}/${(r.body.file ?? '').trim()}`;
        let t = '';
        if (!(r.body.file ?? '').trim()) missing.add('payload file');
        else { try { t = (o.readFile ? o.readFile(rel) : Buffer.alloc(0)).toString('utf8'); } catch { missing.add(`file ${rel}`); } }
        body = fillTemplate(t, v, missing);
        if (!has('content-type')) headers['Content-Type'] = /^\s*</.test(body) ? 'application/xml' : 'application/json';
    } else if (r.body.mode === 'graphql') {
        body = f(graphqlJson(r.body.graphql));
        if (!has('content-type')) headers['Content-Type'] = 'application/json';
    } else if (r.body.mode !== 'none' && r.body.text !== undefined) {
        body = f(r.body.text);
        if (!has('content-type')) headers['Content-Type'] = r.body.mode === 'json' ? 'application/json' : r.body.mode === 'xml' ? 'application/xml' : 'text/plain';
    }
    const out: PreparedRequest = { method: r.method, url, headers, body, missing: [...missing], ...(challenge ? { challenge } : {}) };
    if (missing.size === 0) signRequest(auth, out, f);
    // One Authorization header: the request's own sign-in (Auth tab) replaces a header of the same name in another case.
    if (out.headers.Authorization !== undefined) for (const k of Object.keys(out.headers)) if (k !== 'Authorization' && k.toLowerCase() === 'authorization') delete out.headers[k];
    return out;
}

/** JSON written by the user (claims, header): parsed, or an error that says where. */
function jsonObject(text: string | undefined, what: string): Record<string, unknown> {
    if (!text?.trim()) return {};
    try { const o = JSON.parse(text); if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>; } catch { /* below */ }
    throw new Error(`The ${what} is not a JSON object.`);
}

/**
 * Signatures over the final request (URL, body): JWT, AWS Signature v4, OAuth 1.0a, Hawk, Akamai EdgeGrid, ASAP.
 * Done last, so the signature covers exactly what is sent.
 */
export function signRequest(auth: ApiAuth, p: PreparedRequest, f: (s: string) => string): void {
    const bodyText = p.body === undefined ? undefined : Buffer.isBuffer(p.body) ? p.body : p.body;
    switch (auth.type) {
        case 'jwt': {
            const alg = f(auth.algorithm ?? 'HS256');
            const key = /^(HS)/.test(alg) ? f(auth.secret ?? '') : f(auth.privateKey ?? '');
            const now = Math.floor(Date.now() / 1000);
            const claims = { iat: now, ...jsonObject(f(auth.payload ?? ''), 'JWT payload') };
            const token = signJwt(alg, key, claims, jsonObject(f(auth.jwtHeader ?? ''), 'JWT header'));
            if (auth.queryKey?.trim()) p.url += (p.url.includes('?') ? '&' : '?') + `${encodeURIComponent(f(auth.queryKey))}=${encodeURIComponent(token)}`;
            else p.headers.Authorization = `${f(auth.prefix ?? 'Bearer')} ${token}`.trim();
            return;
        }
        case 'aws': {
            const signed = sigv4({ method: p.method, url: p.url, headers: p.headers, body: bodyText, accessKeyId: f(auth.accessKey ?? ''), secretAccessKey: f(auth.secretKey ?? ''), sessionToken: auth.sessionToken ? f(auth.sessionToken) : undefined, region: f(auth.region ?? 'us-east-1'), service: f(auth.service ?? 'execute-api') });
            Object.assign(p.headers, signed);
            return;
        }
        case 'oauth1': {
            const ct = Object.entries(p.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
            const form = typeof p.body === 'string' && /application\/x-www-form-urlencoded/i.test(ct) ? [...new URLSearchParams(p.body).entries()] : undefined;
            p.headers.Authorization = oauth1Header({ method: p.method, url: p.url, consumerKey: f(auth.consumerKey ?? ''), consumerSecret: f(auth.consumerSecret ?? ''), token: auth.token ? f(auth.token) : undefined, tokenSecret: auth.tokenSecret ? f(auth.tokenSecret) : undefined, signatureMethod: auth.signatureMethod, privateKey: auth.privateKey ? f(auth.privateKey) : undefined, realm: auth.realm ? f(auth.realm) : undefined, form });
            return;
        }
        case 'hawk': {
            const ct = Object.entries(p.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
            p.headers.Authorization = hawkHeader({ method: p.method, url: p.url, id: f(auth.hawkId ?? ''), key: f(auth.hawkKey ?? ''), algorithm: (f(auth.algorithm ?? 'sha256') as 'sha256' | 'sha1'), ext: auth.ext ? f(auth.ext) : undefined, ...(auth.payloadHash ? { payload: bodyText ?? '', contentType: ct } : {}) });
            return;
        }
        case 'edgegrid':
            p.headers.Authorization = edgegridHeader({ method: p.method, url: p.url, clientToken: f(auth.clientToken ?? ''), clientSecret: f(auth.clientSecret ?? ''), accessToken: f(auth.accessToken ?? ''), body: bodyText });
            return;
        case 'asap':
            p.headers.Authorization = `Bearer ${asapToken({ issuer: f(auth.issuer ?? ''), audience: f(auth.audience ?? ''), keyId: f(auth.keyId ?? ''), privateKey: f(auth.privateKey ?? ''), subject: auth.subject ? f(auth.subject) : undefined, expiresIn: auth.expiresIn, algorithm: (auth.algorithm as 'RS256') || undefined })}`;
            return;
        default:
    }
}

const MIME: Record<string, string> = { txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', html: 'text/html' };
export const mimeOf = (file: string) => MIME[(file.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream';

/** OAuth2 tokens, reused until shortly before they expire (one cache per run or session). */
export type TokenCache = Map<string, StoredToken>;

/**
 * The request's OAuth2 token as an Authorization header (the framework's OAuth2 steps send the same
 * token request: grant_type, client_id, client_secret, scope [, username, password] as a form).
 */
export async function authorize(c: Pick<ApiCollection, 'auth'>, r: ApiRequest, v: Values, p: PreparedRequest, conn: Connection | undefined, cache: TokenCache, timeoutMs = 30_000): Promise<PreparedRequest> {
    const a: ApiAuth = r.auth.type === 'inherit' ? c.auth : r.auth;
    if (a.type !== 'oauth2') return p;
    const missing = new Set<string>(p.missing);
    const g = (s?: string) => fill(s ?? '', v, missing);
    const grant = a.grant ?? 'client_credentials';
    if (grant !== 'client_credentials' && grant !== 'password') {
        // Signed in from the Studio (browser / device), or a fixed refresh token: the stored token, renewed when it expires.
        const r: ApiAuth = { ...a, tokenUrl: g(a.tokenUrl), authUrl: a.authUrl ? g(a.authUrl) : undefined, clientId: g(a.clientId), clientSecret: a.clientSecret ? g(a.clientSecret) : undefined, scope: a.scope ? g(a.scope) : undefined, audience: a.audience ? g(a.audience) : undefined, refreshToken: a.refreshToken ? g(a.refreshToken) : undefined };
        if (missing.size > p.missing.length) return { ...p, missing: [...missing] };
        const key = tokenKey(r);
        if (!cache.has(key) && v.tokens?.[key]) cache.set(key, v.tokens[key]);
        const token = await storedAccessToken(r, cache, async (form) => {
            const f: Record<string, string> = { ...form, client_id: r.clientId ?? '' };
            if (r.clientSecret) f.client_secret = r.clientSecret;
            const res = await send({ method: 'POST', url: r.tokenUrl ?? '', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(f).toString(), missing: [] }, conn, timeoutMs);
            return { status: res.status, json: (res.json ?? {}) as Record<string, never> };
        });
        return { ...p, headers: { ...p.headers, Authorization: `Bearer ${token}` } };
    }
    const tokenUrl = g(a.tokenUrl), form: Record<string, string> = { grant_type: a.grant ?? 'client_credentials', client_id: g(a.clientId), client_secret: g(a.clientSecret) };
    if (a.scope) form.scope = g(a.scope);
    if ((a.grant ?? 'client_credentials') === 'password') { form.username = g(a.username); form.password = g(a.password); }
    if (missing.size > p.missing.length) return { ...p, missing: [...missing] };
    const key = JSON.stringify([tokenUrl, form]);
    const hit = cache.get(key);
    let token = hit && hit.until > Date.now() ? hit.token : '';
    if (!token) {
        const res = await send({ method: 'POST', url: tokenUrl, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form).toString(), missing: [] }, conn, timeoutMs);
        const j = res.json as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | undefined;
        if (res.status >= 400 || !j?.access_token) throw new Error(`OAuth2 token request to ${tokenUrl} failed: HTTP ${res.status}${j?.error ? ` ${j.error}${j.error_description ? `: ${j.error_description}` : ''}` : ''}`);
        token = j.access_token;
        cache.set(key, { token, until: Date.now() + Math.max(30, (j.expires_in ?? 3600) - 60) * 1000 });
    }
    return { ...p, headers: { ...p.headers, Authorization: `Bearer ${token}` } };
}

export interface ApiResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    /** Text of the body (decoded), cut at the size limit. */
    body: string;
    truncated: boolean;
    size: number;
    timeMs: number;
    /** URLs followed (redirects). */
    redirects: string[];
    json?: unknown;
    /** The Set-Cookie lines (the cookies the response sets). */
    setCookies?: string[];
    /** Where the time went (milliseconds, all exchanges of the request added up: redirects, sign-in handshakes). */
    timings?: Timings;
    /** A body that is not text (image, PDF, archive…): its bytes (base64, up to the size limit). */
    bodyBase64?: string;
    /** The connection: the server's address, and for https the TLS version, cipher and the server's certificate chain. */
    remote?: string;
    /** '2' when sent over HTTP/2. */
    httpVersion?: string;
    tls?: TlsInfo;
}

export interface TlsCert { subject: string; issuer: string; validFrom: string; validTo: string; fingerprint256: string; altNames?: string; serial?: string }
export interface TlsInfo { protocol: string; cipher: string; authorized: boolean; authorizationError?: string; chain: TlsCert[] }

/** A body type to show as text (others are kept as bytes for previews and saving). */
export const isTextType = (ct: string) => !ct || /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|html|svg/i.test(ct);

function tlsOf(sock: unknown): TlsInfo | undefined {
    const s = sock as import('tls').TLSSocket;
    if (!s || typeof s.getPeerCertificate !== 'function') return undefined;
    const chain: TlsCert[] = [];
    let c = s.getPeerCertificate(true) as import('tls').DetailedPeerCertificate | undefined;
    const seen = new Set<string>();
    const name = (x: Record<string, unknown> | undefined) => (x ? Object.entries(x).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : String(v)}`).join(', ') : '');
    while (c && c.fingerprint256 && !seen.has(c.fingerprint256) && chain.length < 6) {
        seen.add(c.fingerprint256);
        chain.push({ subject: name(c.subject as unknown as Record<string, unknown>), issuer: name(c.issuer as unknown as Record<string, unknown>), validFrom: c.valid_from, validTo: c.valid_to, fingerprint256: c.fingerprint256, ...(c.subjectaltname ? { altNames: c.subjectaltname } : {}), ...(c.serialNumber ? { serial: c.serialNumber } : {}) });
        c = c.issuerCertificate;
    }
    return { protocol: s.getProtocol() ?? '', cipher: s.getCipher()?.name ?? '', authorized: s.authorized, ...(s.authorizationError ? { authorizationError: String(s.authorizationError) } : {}), chain };
}

/**
 * The phases of an exchange: waiting for a connection of the pool (blocked), name lookup (dns), TCP connect, TLS
 * handshake, sending the request, waiting for the first byte of the answer (wait) and reading the rest (download).
 * A kept-alive connection has no dns / connect / tls.
 */
export interface Timings { blocked: number; dns: number; connect: number; tls: number; send: number; wait: number; download: number }
export const TIMING_PHASES: Array<keyof Timings> = ['blocked', 'dns', 'connect', 'tls', 'send', 'wait', 'download'];
const addTimings = (a: Timings | undefined, b: Timings): Timings => (a ? Object.fromEntries(TIMING_PHASES.map((k) => [k, a[k] + b[k]])) as unknown as Timings : b);

const MAX_BODY = 10 * 1024 * 1024;

/**
 * Send it. Redirects are followed (at most 10), as the framework's client does by default. With a cookie jar,
 * cookies set by each response (redirects too) are kept and sent to matching requests, as the framework's client
 * does; the request's own Cookie header is kept (its values win).
 */
/**
 * A virtual user's own connections: one kept-alive connection per origin (through the proxy as the network settings
 * say), not shared with other users, closed with `close()`.
 */
export class AgentPool {
    private readonly agents = new Map<string, http.Agent>();
    constructor(private readonly conn?: Connection) {}
    for(url: string): http.Agent {
        const key = new URL(url).origin;
        let a = this.agents.get(key);
        if (!a) {
            a = this.conn?.agentFor(url, { exclusive: true }) ?? (url.startsWith('https:') ? new https.Agent({ keepAlive: true, maxSockets: 1 }) : new http.Agent({ keepAlive: true, maxSockets: 1 }));
            this.agents.set(key, a);
        }
        return a;
    }
    private readonly sessions = new Map<string, import('http2').ClientHttp2Session>();
    /** The user's HTTP/2 session to an origin (one, its requests multiplexed). */
    h2(origin: string, open: () => import('http2').ClientHttp2Session): import('http2').ClientHttp2Session {
        let s = this.sessions.get(origin);
        if (!s || s.closed || s.destroyed) { s = open(); s.on('error', () => this.sessions.delete(origin)); this.sessions.set(origin, s); }
        return s;
    }
    /** Connections opened (for tests). */
    get size() { return this.agents.size + this.sessions.size; }
    close() { for (const a of this.agents.values()) a.destroy(); this.agents.clear(); for (const s of this.sessions.values()) s.close(); this.sessions.clear(); }
}

export async function send(p: PreparedRequest, conn?: Connection, timeoutMs = 60_000, jar?: CookieJar, pool?: AgentPool, how: { followRedirects?: boolean; insecure?: boolean; http2?: boolean } = {}): Promise<ApiResponse> {
    if (how.http2) return sendHttp2(p, conn, timeoutMs, jar, how, pool);
    const started = Date.now();
    const redirects: string[] = [];
    let { method, url, body } = p;
    const headers = { ...p.headers };
    const ownCookieKey = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
    const ownCookie = ownCookieKey ? headers[ownCookieKey] : undefined;
    if (ownCookieKey) delete headers[ownCookieKey];
    // NTLM: Type 1 → the server's challenge → Type 3, over one kept-alive connection. Digest: answer the 401 challenge.
    const ch = p.challenge;
    let agent: http.Agent | undefined;
    let answered = false;
    const startHandshake = (u: string) => {
        if (ch?.type !== 'ntlm') return;
        agent?.destroy();
        agent = conn?.agentFor(u, { exclusive: true }) ?? (u.startsWith('https:') ? new https.Agent({ keepAlive: true, maxSockets: 1 }) : new http.Agent({ keepAlive: true, maxSockets: 1 }));
        headers.Authorization = `NTLM ${ntlmType1()}`;
    };
    startHandshake(url);
    let timings: Timings | undefined;
    try {
    for (let hop = 0; ; hop++) {
        const cookie = mergeCookieHeader(ownCookie, jar?.header(url));
        const res = await once(method, url, cookie ? { ...headers, Cookie: cookie } : headers, body, conn, timeoutMs, agent ?? pool?.for(url), how.insecure);
        jar?.setFrom(url, res.cookies);
        timings = addTimings(timings, res.timings);
        if (ch && res.status === 401 && !answered && hop < 10) {
            const wa = res.headers['www-authenticate'] ?? '';
            if (ch.type === 'ntlm' && /NTLM\s+[A-Za-z0-9+/=]{20,}/i.test(wa)) {
                headers.Authorization = `NTLM ${ntlmType3(ntlmParseType2(wa), ch.username, ch.password, ch.domain, ch.workstation)}`;
                answered = true;
                continue;
            }
            if (ch.type === 'negotiate' && /\bNegotiate\b/i.test(wa)) {
                // The operating system's Kerberos ticket (SSPI / GSSAPI), on the same connection.
                const c = await negotiateClient(new URL(url).hostname, ch.spn);
                headers.Authorization = `Negotiate ${await c.step(/Negotiate\s+([A-Za-z0-9+/=]+)/i.exec(wa)?.[1] ?? '')}`;
                answered = true;
                continue;
            }
            const dc = ch.type === 'digest' ? parseDigest(wa) : null;
            if (dc) {
                const u = new URL(url);
                headers.Authorization = digestAuthorization(dc, { username: ch.username, password: ch.password, method, uri: u.pathname + u.search });
                answered = true;
                continue;
            }
        }
        const loc = res.headers.location;
        if (loc && [301, 302, 303, 307, 308].includes(res.status) && hop < 10 && how.followRedirects !== false) {
            url = new URL(loc, url).href;
            redirects.push(url);
            // A new resource: a new challenge.
            if (ch) { answered = false; if (ch.type === 'digest') delete headers.Authorization; else startHandshake(url); }
            if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; delete headers['Content-Type']; }
            continue;
        }
        const text = res.raw.subarray(0, MAX_BODY).toString('utf8');
        let json: unknown;
        if (/json/i.test(res.headers['content-type'] ?? '') || /^\s*[[{]/.test(text)) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
        const binary = !isTextType(res.headers['content-type'] ?? '') && res.raw.length > 0;
        return { status: res.status, statusText: res.statusText, headers: res.headers, body: text, truncated: res.raw.length > MAX_BODY, size: res.raw.length, timeMs: Date.now() - started, redirects, ...(json !== undefined ? { json } : {}), ...(res.cookies.length ? { setCookies: res.cookies } : {}), ...(timings ? { timings: round(timings) } : {}),
            ...(binary ? { bodyBase64: res.raw.subarray(0, MAX_BODY).toString('base64') } : {}), ...(res.tls ? { tls: res.tls } : {}), ...(res.remote ? { remote: res.remote } : {}) };
    }
    } finally { agent?.destroy(); }
}

function once(method: string, url: string, headers: Record<string, string>, body: string | Buffer | undefined, conn: Connection | undefined, timeoutMs: number, agent?: http.Agent, insecure?: boolean) {
    return new Promise<{ status: number; statusText: string; headers: Record<string, string>; raw: Buffer; cookies: string[]; timings: Timings; tls?: TlsInfo; remote?: string }>((resolve, reject) => {
        const t0 = performance.now();
        let tSocket: number | undefined, tDns: number | undefined, tConnect: number | undefined, tTls: number | undefined, tSent: number | undefined, tFirst: number | undefined;
        let u: URL;
        // No address at all (an empty URL and no base URL): said in words, not "Not a valid URL: ".
        if (!url.trim()) { reject(new Error('No address to send to: type the request\'s URL (or set the collection\'s base URL).')); return; }
        try { u = new URL(url); } catch { reject(new Error(`Not a valid URL: ${url}`)); return; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error('Only http:// and https:// URLs can be sent.')); return; }
        const h: Record<string, string> = { 'User-Agent': 'CS-Test-Studio', Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br', ...headers };
        if (body !== undefined) h['Content-Length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.length);
        const req = (u.protocol === 'http:' ? http : https).request(u, { method, headers: h, agent: insecure && u.protocol === 'https:' && !agent && !conn?.agentFor(url) ? new https.Agent({ rejectUnauthorized: false }) : agent ?? conn?.agentFor(url), ...(conn?.ca ? { ca: conn.ca } : {}), ...(insecure ? { rejectUnauthorized: false } : {}), timeout: timeoutMs }, (res) => {
            tFirst = performance.now();
            const tls = u.protocol === 'https:' ? tlsOf(res.socket) : undefined;
            const remote = res.socket?.remoteAddress ? `${res.socket.remoteAddress}:${res.socket.remotePort}` : undefined;
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (c: Buffer) => { total += c.length; if (total <= MAX_BODY * 2) chunks.push(c); });
            res.on('end', () => {
                let raw = Buffer.concat(chunks);
                const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
                try {
                    if (enc === 'gzip') raw = zlib.gunzipSync(raw);
                    else if (enc === 'deflate') raw = zlib.inflateSync(raw);
                    else if (enc === 'br') raw = zlib.brotliDecompressSync(raw);
                } catch { /* keep as received */ }
                const out: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
                const end = performance.now();
                // Each phase from the previous mark (a kept-alive socket: none of dns / connect / tls).
                const s0 = tSocket ?? t0, sDns = tDns ?? s0, sConn = tConnect ?? sDns, sTls = tTls ?? sConn, sent = Math.max(tSent ?? sTls, sTls), first = Math.max(tFirst ?? sent, sent);
                const timings: Timings = { blocked: s0 - t0, dns: sDns - s0, connect: sConn - sDns, tls: sTls - sConn, send: sent - sTls, wait: first - sent, download: end - first };
                resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: out, raw, cookies: ([] as string[]).concat(res.headers['set-cookie'] ?? []), timings, ...(tls ? { tls } : {}), ...(remote ? { remote } : {}) });
            });
            res.on('error', reject);
        });
        req.on('socket', (sock: import('net').Socket) => {
            tSocket = performance.now();
            // A new connection: its lookup, connect and TLS handshake (a reused one is already connected).
            if (sock.connecting || (sock as { pending?: boolean }).pending) {
                sock.once('lookup', () => { tDns = performance.now(); });
                sock.once('connect', () => { tConnect = performance.now(); });
                sock.once('secureConnect', () => { tTls = performance.now(); });
            }
        });
        req.on('finish', () => { tSent = performance.now(); });
        req.on('timeout', () => req.destroy(new Error(`No answer within ${Math.round(timeoutMs / 100) / 10} s.`)));
        req.on('error', (e: NodeJS.ErrnoException) => reject(new Error(reachMessage(e, url))));
        if (body !== undefined) req.write(body);
        req.end();
    });
}

function reachMessage(e: NodeJS.ErrnoException, url: string): string {
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    if (/CERT|SELF_SIGNED|ISSUER/i.test(e.code ?? '') || /certificate/i.test(e.message)) return `${host}: the connection is not trusted (certificate). On a company network, trust the company root certificate in Settings → Network.`;
    if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return `${host}: the name was not found (DNS). Check the URL, or the proxy in Settings → Network.`;
    if (e.code === 'ECONNREFUSED') return `${host}: the connection was refused. Is the service running on that port?`;
    if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') return `${host}: the connection was dropped (${e.code}). On a company network, check the proxy in Settings → Network.`;
    return `${host}: ${e.message}`;
}

export interface CheckResult { check: ApiCheck; pass: boolean; actual?: string; message: string }

const header = (r: ApiResponse, name: string) => r.headers[name.toLowerCase()];
const show = (v: unknown) => (v === undefined ? '(missing)' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));

/** Evaluate the checks as the framework's validation steps do. */
export function evaluate(checks: ApiCheck[], r: ApiResponse, v: Values): CheckResult[] {
    const f = (s: string) => fill(s, v);
    return checks.map((c) => {
        const t = f(c.target ?? ''), val = f(c.value ?? '');
        // A JSON path that cannot be read is said as such (not as a value that is missing); an empty one means the whole body.
        if ((c.kind === 'jsonExists' || c.kind === 'jsonEquals' || c.kind === 'jsonNotContains') && t.trim() && (() => { try { JsonPath.parse(t.trim()); return false; } catch { return true; } })())
            return { check: c, pass: false, message: `"${t}" is not a JSON path: start with $ and use .name or [index] (for example $.items[0].id)` };
        switch (c.kind) {
            case 'status': return /^\s*\d{3}\s*$/.test(val) ? { check: c, pass: r.status === Number(val), actual: String(r.status), message: `Status is ${val}` } : { check: c, pass: false, actual: String(r.status), message: `The expected status "${val}" is not a status code (a number from 100 to 599): fix the check` };
            case 'statusBetween': return { check: c, pass: r.status >= (c.min ?? 0) && r.status <= (c.max ?? 999), actual: String(r.status), message: `Status between ${c.min} and ${c.max}` };
            case 'jsonExists': { const x = readPath(r.json, t); return { check: c, pass: x !== undefined, actual: show(x), message: `${t.trim() || '$ (the whole body)'} exists` }; }
            case 'jsonEquals': { const x = pathCheckValue(r.json, t); return { check: c, pass: sameValue(x, expectedValue(val)), actual: show(x), message: `${t.trim() || '$ (the whole body)'} is ${val}` }; }
            case 'jsonNotContains': { const x = pathCheckValue(r.json, t); return { check: c, pass: x !== undefined && !JSON.stringify(x ?? '').includes(val), actual: show(x), message: `${t.trim() || '$ (the whole body)'} does not contain ${JSON.stringify(val)}` }; }
            case 'bodyContains': return { check: c, pass: r.body.includes(val), message: `Body contains ${JSON.stringify(val)}` };
            case 'bodyNotContains': return { check: c, pass: !r.body.includes(val), message: `Body does not contain ${JSON.stringify(val)}` };
            case 'bodyEmpty': return { check: c, pass: r.body.trim() === '', actual: `${r.size} bytes`, message: 'Body is empty' };
            case 'headerExists': return { check: c, pass: header(r, t) !== undefined, actual: header(r, t), message: `Header ${t} exists` };
            case 'headerEquals': return { check: c, pass: header(r, t) === val, actual: header(r, t) ?? '(missing)', message: `Header ${t} is ${JSON.stringify(val)}` };
            case 'headerContains': return { check: c, pass: (header(r, t) ?? '').includes(val), actual: header(r, t) ?? '(missing)', message: `Header ${t} contains ${JSON.stringify(val)}` };
            case 'timeBelow': return { check: c, pass: r.timeMs < Number(val), actual: `${r.timeMs} ms`, message: `Time below ${val} ms` };
            default: return { check: c, pass: false, message: c.kind === 'rule' || c.kind === 'schema' || c.kind === 'dbItems' ? 'Checked with evaluateAll' : 'Unknown check' };
        }
    });
}

/** Every check, the rule, schema and database ones too (database ones run the project's queries). */
export async function evaluateAll(checks: ApiCheck[], r: ApiResponse, v: Values, queryRows?: QueryRows): Promise<CheckResult[]> {
    const out: CheckResult[] = [];
    for (const c of checks) {
        const extra = await evaluateExtra(c, r, v, queryRows);
        out.push(extra ?? evaluate([c], r, v)[0]);
    }
    return out;
}

/** Values saved from the response for the next requests ({{variable}}). */
export function extract(rules: ApiExtract[], r: ApiResponse): Array<{ variable: string; value?: string; found: boolean }> {
    return rules.filter((x) => x.variable.trim()).map((x) => {
        const extra = extractExtra(x, r);
        // A JSON path that selects several values with one match saves that value (as the framework does).
        const v = extra ? extra.value : x.from === 'header' ? header(r, x.path) : pathCheckValue(r.json, x.path);
        return v === undefined ? { variable: x.variable, found: false } : { variable: x.variable, value: typeof v === 'string' ? v : JSON.stringify(v), found: true };
    });
}

function round(t: Timings): Timings {
    return Object.fromEntries(TIMING_PHASES.map((k) => [k, Math.round(Math.max(0, t[k]) * 100) / 100])) as unknown as Timings;
}

/**
 * A request sent as its settings say: its own timeout, redirects followed or not, an untrusted certificate accepted,
 * and sent again (after a delay) on a connection error, a 5xx or a 429, up to its retries.
 */
export async function sendWith(p: PreparedRequest, settings: import('./model').RequestSettings | undefined, conn?: Connection, timeoutMs = 60_000, jar?: CookieJar, pool?: AgentPool): Promise<ApiResponse> {
    const s = settings ?? {};
    const tries = 1 + Math.max(0, Math.min(10, s.retries ?? 0));
    let last: ApiResponse | undefined;
    for (let i = 0; i < tries; i++) {
        if (i) await new Promise((r) => setTimeout(r, Math.max(0, Math.min(60_000, s.retryDelayMs ?? 1000))));
        try {
            last = await send(p, conn, s.timeoutMs ?? timeoutMs, jar, pool, { followRedirects: s.followRedirects, insecure: s.insecure, http2: s.http2 });
            if (last.status < 500 && last.status !== 429) return last;
        } catch (e) { if (i === tries - 1) throw e; }
    }
    return last!;
}

/**
 * HTTP/2: one session per origin (kept by the pool: a user's requests are multiplexed on it, as a browser's), the
 * response decoded as over HTTP/1.1. Redirects are followed unless asked not to. A proxy is not used (HTTP/2 goes
 * direct); certificates of the network settings are.
 */
async function sendHttp2(p: PreparedRequest, conn: Connection | undefined, timeoutMs: number, jar: CookieJar | undefined, how: { followRedirects?: boolean; insecure?: boolean }, pool?: AgentPool): Promise<ApiResponse> {
    const h2 = await import('http2');
    const started = Date.now();
    const redirects: string[] = [];
    let { method, url, body } = p;
    for (let hop = 0; ; hop++) {
        const u = new URL(url);
        const t0 = performance.now();
        const session = pool?.h2(u.origin, () => h2.connect(u.origin, { ...(conn?.ca ? { ca: conn.ca } : {}), ...(how.insecure ? { rejectUnauthorized: false } : {}) })) ?? h2.connect(u.origin, { ...(conn?.ca ? { ca: conn.ca } : {}), ...(how.insecure ? { rejectUnauthorized: false } : {}) });
        const cookie = jar?.header(url);
        const headers: Record<string, string> = { ':method': method, ':path': u.pathname + u.search, 'user-agent': 'CS-Test-Studio', accept: '*/*', 'accept-encoding': 'gzip, deflate, br' };
        for (const [k, v] of Object.entries(p.headers)) if (!/^(host|connection|content-length|transfer-encoding|keep-alive|upgrade)$/i.test(k)) headers[k.toLowerCase()] = v;
        if (cookie) headers.cookie = cookie;
        const res = await new Promise<{ status: number; headers: Record<string, string>; raw: Buffer; cookies: string[]; tFirst: number }>((resolve, reject) => {
            const req = session.request(headers);
            const timer = setTimeout(() => { req.close(); reject(new Error(`No answer within ${Math.round(timeoutMs / 100) / 10} s.`)); }, timeoutMs);
            let status = 0, out: Record<string, string> = {}, cookies: string[] = [], tFirst = 0;
            const chunks: Buffer[] = [];
            req.on('response', (hs) => {
                tFirst = performance.now();
                status = Number(hs[':status']);
                out = Object.fromEntries(Object.entries(hs).filter(([k]) => !k.startsWith(':')).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));
                cookies = ([] as string[]).concat((hs['set-cookie'] as string[] | undefined) ?? []);
            });
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                clearTimeout(timer);
                let raw = Buffer.concat(chunks);
                const enc = (out['content-encoding'] ?? '').toLowerCase();
                try { if (enc === 'gzip') raw = zlib.gunzipSync(raw); else if (enc === 'deflate') raw = zlib.inflateSync(raw); else if (enc === 'br') raw = zlib.brotliDecompressSync(raw); } catch { /* as received */ }
                resolve({ status, headers: out, raw, cookies, tFirst });
            });
            req.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new Error(reachMessage(e, url))); });
            if (body !== undefined) req.write(body);
            req.end();
        }).finally(() => { if (!pool) session.close(); });
        jar?.setFrom(url, res.cookies);
        const loc = res.headers.location;
        if (loc && [301, 302, 303, 307, 308].includes(res.status) && hop < 10 && how.followRedirects !== false) {
            url = new URL(loc, url).href; redirects.push(url);
            if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
            continue;
        }
        const text = res.raw.subarray(0, MAX_BODY).toString('utf8');
        let json: unknown;
        if (/json/i.test(res.headers['content-type'] ?? '') || /^\s*[[{]/.test(text)) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
        const end = performance.now();
        const binary = !isTextType(res.headers['content-type'] ?? '') && res.raw.length > 0;
        return { status: res.status, statusText: '', headers: res.headers, body: text, truncated: res.raw.length > MAX_BODY, size: res.raw.length, timeMs: Date.now() - started, redirects,
            ...(json !== undefined ? { json } : {}), ...(res.cookies.length ? { setCookies: res.cookies } : {}), ...(binary ? { bodyBase64: res.raw.subarray(0, MAX_BODY).toString('base64') } : {}),
            timings: round({ blocked: 0, dns: 0, connect: 0, tls: 0, send: 0, wait: res.tFirst - t0, download: end - res.tFirst }), httpVersion: '2' } as ApiResponse;
    }
}
