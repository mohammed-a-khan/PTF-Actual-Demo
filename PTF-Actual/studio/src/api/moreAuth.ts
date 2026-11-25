/**
 * More request signing schemes (shared by the Studio and the framework):
 *  - OAuth 1.0a (RFC 5849): HMAC-SHA1, HMAC-SHA256, RSA-SHA1, PLAINTEXT; body parameters of form posts signed;
 *  - Hawk (1.0): MAC over the normalized request, optional payload hash;
 *  - Akamai EdgeGrid (EG1-HMAC-SHA256);
 *  - Atlassian ASAP (a short-lived RS256 JWT with iss/sub/aud/jti, key id).
 * Each one returns the Authorization header value for one request.
 */
import * as crypto from 'crypto';
import { signJwt } from './httpAuth';

/** RFC 3986 percent-encoding (OAuth 1.0 §3.6): only unreserved characters stay. */
export function pct(s: string): string {
    return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface OAuth1Input {
    method: string;
    url: string;
    consumerKey: string;
    consumerSecret: string;
    token?: string;
    tokenSecret?: string;
    signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'RSA-SHA1' | 'PLAINTEXT';
    /** RSA-SHA1: the private key (PEM). */
    privateKey?: string;
    /** application/x-www-form-urlencoded body parameters (they are signed). */
    form?: Array<[string, string]>;
    realm?: string;
    callback?: string;
    verifier?: string;
    /** Tests: fixed values. */
    timestamp?: string;
    nonce?: string;
    version?: boolean;
}

/** The OAuth 1.0a Authorization header. */
export function oauth1Header(o: OAuth1Input): string {
    const method = o.signatureMethod ?? 'HMAC-SHA1';
    const oauth: Array<[string, string]> = [
        ['oauth_consumer_key', o.consumerKey],
        ['oauth_nonce', o.nonce ?? crypto.randomBytes(16).toString('hex')],
        ['oauth_signature_method', method],
        ['oauth_timestamp', o.timestamp ?? String(Math.floor(Date.now() / 1000))],
        ...(o.token ? [['oauth_token', o.token] as [string, string]] : []),
        ...(o.callback ? [['oauth_callback', o.callback] as [string, string]] : []),
        ...(o.verifier ? [['oauth_verifier', o.verifier] as [string, string]] : []),
        ...(o.version === false ? [] : [['oauth_version', '1.0'] as [string, string]]),
    ];
    const u = new URL(o.url);
    const query: Array<[string, string]> = [...u.searchParams.entries()];
    // Base string URI: scheme and host lower case, default port left out, no query or fragment.
    const port = u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) ? `:${u.port}` : '';
    const baseUri = `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${u.pathname}`;
    const params = [...query, ...(o.form ?? []), ...oauth].map(([k, v]) => [pct(k), pct(v)] as [string, string])
        .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`).join('&');
    const base = `${o.method.toUpperCase()}&${pct(baseUri)}&${pct(params)}`;
    const key = `${pct(o.consumerSecret)}&${pct(o.tokenSecret ?? '')}`;
    let sig: string;
    if (method === 'PLAINTEXT') sig = key;
    else if (method === 'RSA-SHA1') {
        if (!o.privateKey) throw new Error('OAuth 1.0 RSA-SHA1 needs a private key.');
        sig = crypto.sign('sha1', Buffer.from(base), o.privateKey).toString('base64');
    } else sig = crypto.createHmac(method === 'HMAC-SHA256' ? 'sha256' : 'sha1', key).update(base).digest('base64');
    const all = [...oauth, ['oauth_signature', sig] as [string, string]];
    return `OAuth ${o.realm !== undefined ? `realm="${o.realm}", ` : ''}${all.map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ')}`;
}

export interface HawkInput {
    method: string;
    url: string;
    id: string;
    key: string;
    algorithm?: 'sha256' | 'sha1';
    /** The body and its content type: a payload hash is included when given. */
    payload?: string | Buffer;
    contentType?: string;
    ext?: string;
    app?: string;
    dlg?: string;
    /** Tests: fixed values. */
    ts?: number;
    nonce?: string;
}

/** The Hawk Authorization header (hawk.1.header). */
export function hawkHeader(o: HawkInput): string {
    const alg = o.algorithm ?? 'sha256';
    const u = new URL(o.url);
    const ts = o.ts ?? Math.floor(Date.now() / 1000);
    const nonce = o.nonce ?? crypto.randomBytes(6).toString('base64url');
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    let hash: string | undefined;
    if (o.payload !== undefined) {
        const type = (o.contentType ?? '').split(';')[0].trim().toLowerCase();
        hash = crypto.createHash(alg).update(`hawk.1.payload\n${type}\n`).update(o.payload).update('\n').digest('base64');
    }
    const ext = (o.ext ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
    const normalized = `hawk.1.header\n${ts}\n${nonce}\n${o.method.toUpperCase()}\n${u.pathname}${u.search}\n${u.hostname.toLowerCase()}\n${port}\n${hash ?? ''}\n${ext}\n${o.app ? `${o.app}\n${o.dlg ?? ''}\n` : ''}`;
    const mac = crypto.createHmac(alg, o.key).update(normalized).digest('base64');
    const parts = [`id="${o.id}"`, `ts="${ts}"`, `nonce="${nonce}"`, ...(hash ? [`hash="${hash}"`] : []), ...(o.ext ? [`ext="${o.ext.replace(/["\\]/g, '\\$&')}"`] : []), `mac="${mac}"`, ...(o.app ? [`app="${o.app}"`, ...(o.dlg ? [`dlg="${o.dlg}"`] : [])] : [])];
    return `Hawk ${parts.join(', ')}`;
}

export interface EdgeGridInput {
    method: string;
    url: string;
    clientToken: string;
    clientSecret: string;
    accessToken: string;
    body?: string | Buffer;
    /** Headers to sign (names), as the API client was set up; usually none. */
    headersToSign?: Record<string, string>;
    /** POST bodies are hashed up to this many bytes (default 131072). */
    maxBody?: number;
    /** Tests: fixed values. */
    timestamp?: string;
    nonce?: string;
}

/** Akamai EdgeGrid (EG1-HMAC-SHA256) Authorization header. */
export function edgegridHeader(o: EdgeGridInput): string {
    // yyyyMMddTHH:mm:ss+0000 (UTC), as Akamai's clients write it.
    const ts = o.timestamp ?? new Date().toISOString().replace(/-/g, '').replace(/\.\d{3}Z$/, '+0000');
    const nonce = o.nonce ?? crypto.randomUUID();
    const u = new URL(o.url);
    const authNoSig = `EG1-HMAC-SHA256 client_token=${o.clientToken};access_token=${o.accessToken};timestamp=${ts};nonce=${nonce};`;
    const canonHeaders = Object.entries(o.headersToSign ?? {}).map(([k, v]) => `${k.toLowerCase()}:${String(v).trim().replace(/\s+/g, ' ')}`).join('\t');
    let contentHash = '';
    if (o.method.toUpperCase() === 'POST' && o.body !== undefined && Buffer.byteLength(o.body) > 0) {
        const b = Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
        contentHash = crypto.createHash('sha256').update(b.subarray(0, o.maxBody ?? 131072)).digest('base64');
    }
    const data = [o.method.toUpperCase(), u.protocol.replace(':', ''), u.host, `${u.pathname}${u.search}`, canonHeaders, contentHash, authNoSig].join('\t');
    const signingKey = crypto.createHmac('sha256', o.clientSecret).update(ts).digest('base64');
    const signature = crypto.createHmac('sha256', signingKey).update(data).digest('base64');
    return `${authNoSig}signature=${signature}`;
}

export interface AsapInput {
    issuer: string;
    audience: string;
    keyId: string;
    privateKey: string;
    subject?: string;
    /** Seconds the token is valid (at most 3600; default 60). */
    expiresIn?: number;
    additionalClaims?: Record<string, unknown>;
    algorithm?: 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512' | 'PS256';
    now?: number;
}

/** An Atlassian ASAP bearer token (JWT with iss, sub, aud, jti, iat, exp and the key id). */
export function asapToken(o: AsapInput): string {
    const iat = Math.floor((o.now ?? Date.now()) / 1000);
    const claims = { ...(o.additionalClaims ?? {}), iss: o.issuer, sub: o.subject ?? o.issuer, aud: o.audience, jti: crypto.randomUUID(), iat, exp: iat + Math.min(Math.max(o.expiresIn ?? 60, 1), 3600) };
    return signJwt(o.algorithm ?? 'RS256', o.privateKey, claims, { kid: o.keyId });
}
