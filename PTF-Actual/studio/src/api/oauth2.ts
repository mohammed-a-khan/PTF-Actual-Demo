/**
 * OAuth 2.0 sign-in for the grants that need a person (RFC 6749, RFC 7636 PKCE, RFC 8628 device code, RFC 8252
 * loopback redirect):
 *  - authorization code (with PKCE, S256): the browser opens the provider's sign-in page; the provider sends it back
 *    to the Studio (http://127.0.0.1:<port>/oauth/callback); the code is exchanged at the token URL;
 *  - implicit: the token comes back in the address fragment (read by the callback page);
 *  - device code: the person enters a short code on another device; the Studio polls the token URL;
 *  - refresh token: a fixed refresh token (from a secret) exchanged for access tokens, unattended.
 * Tokens are kept in memory with their refresh token and renewed shortly before they expire. `state` is random,
 * single use and expires after 10 minutes.
 */
import * as crypto from 'crypto';
import type { ApiAuth } from './model';
import type { Connection } from '../core/network';
import { send } from './send';

export interface StoredToken { token: string; until: number; refresh?: string; tokenType?: string; scope?: string }
export type TokenStore = Map<string, StoredToken>;

/** The key a token is kept under: the same provider, client, scope and audience share it. */
export function tokenKey(a: Pick<ApiAuth, 'grant' | 'tokenUrl' | 'authUrl' | 'clientId' | 'scope' | 'audience'>): string {
    return JSON.stringify(['oauth2', a.grant ?? '', a.tokenUrl ?? a.authUrl ?? '', a.clientId ?? '', a.scope ?? '', a.audience ?? '']);
}

const b64url = (b: Buffer) => b.toString('base64url');
export function pkcePair(): { verifier: string; challenge: string } {
    const verifier = b64url(crypto.randomBytes(32));
    return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

interface Pending { key: string; a: ApiAuth; verifier?: string; redirectUri: string; until: number }

export interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string; error?: string; error_description?: string; interval?: number }

export class OAuthFlows {
    private readonly pending = new Map<string, Pending>();
    private readonly devices = new Map<string, { key: string; state: 'waiting' | 'done' | 'failed'; error?: string; userCode: string; verificationUri: string; until: number }>();
    constructor(private readonly store: TokenStore, private readonly conn: () => Connection | undefined) {}

    /** Store a token response under `key`; returns the stored token. */
    save(key: string, j: TokenResponse, previousRefresh?: string): StoredToken {
        if (!j.access_token) throw new Error(`The token endpoint answered without an access token${j.error ? `: ${j.error}${j.error_description ? ` (${j.error_description})` : ''}` : ''}.`);
        const t: StoredToken = { token: j.access_token, until: Date.now() + Math.max(30, (j.expires_in ?? 3600) - 60) * 1000, refresh: j.refresh_token ?? previousRefresh, tokenType: j.token_type, scope: j.scope };
        this.store.set(key, t);
        return t;
    }

    /** A form POST to the token URL (client secret as client_secret, as most providers accept). */
    async tokenRequest(a: ApiAuth, form: Record<string, string>): Promise<{ status: number; json: TokenResponse }> {
        const f: Record<string, string> = { ...form, client_id: a.clientId ?? '' };
        if (a.clientSecret) f.client_secret = a.clientSecret;
        const res = await send({ method: 'POST', url: a.tokenUrl ?? '', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(f).toString(), missing: [] }, this.conn(), 30_000);
        let json = (res.json ?? {}) as TokenResponse;
        // Some providers answer form-encoded (GitHub without Accept): read that too.
        if (!res.json && /=/.test(res.body)) json = Object.fromEntries(new URLSearchParams(res.body)) as unknown as TokenResponse;
        return { status: res.status, json };
    }

    /** Authorization code / implicit: the sign-in address to open in the browser. */
    start(a: ApiAuth, redirectUri: string): { url: string; state: string } {
        if (!a.authUrl) throw new Error('Give the authorization URL (the provider\'s sign-in page).');
        if (!a.clientId) throw new Error('Give the client id.');
        const now = Date.now();
        for (const [k, p] of this.pending) if (p.until < now) this.pending.delete(k);
        const state = b64url(crypto.randomBytes(24));
        const implicit = a.grant === 'implicit';
        const pkce = !implicit && a.pkce !== false ? pkcePair() : undefined;
        const u = new URL(a.authUrl);
        u.searchParams.set('response_type', implicit ? 'token' : 'code');
        u.searchParams.set('client_id', a.clientId);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('state', state);
        if (a.scope) u.searchParams.set('scope', a.scope);
        if (a.audience) u.searchParams.set('audience', a.audience);
        if (pkce) { u.searchParams.set('code_challenge', pkce.challenge); u.searchParams.set('code_challenge_method', 'S256'); }
        this.pending.set(state, { key: tokenKey(a), a, verifier: pkce?.verifier, redirectUri, until: now + 10 * 60_000 });
        return { url: u.href, state };
    }

    private take(state: string): Pending {
        const p = this.pending.get(state);
        this.pending.delete(state);
        if (!p || p.until < Date.now()) throw new Error('This sign-in is unknown or expired (more than 10 minutes). Start it again from the Studio.');
        return p;
    }

    /** The provider sent the browser back with a code: exchange it. */
    async complete(state: string, code: string): Promise<StoredToken> {
        const p = this.take(state);
        const r = await this.tokenRequest(p.a, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, ...(p.verifier ? { code_verifier: p.verifier } : {}) });
        if (r.status >= 400 || !r.json.access_token) throw new Error(`The token request failed: HTTP ${r.status}${r.json.error ? ` ${r.json.error}${r.json.error_description ? `: ${r.json.error_description}` : ''}` : ''}`);
        return this.save(p.key, r.json);
    }

    /** Implicit grant: the token from the address fragment. */
    completeImplicit(state: string, fragment: Record<string, string>): StoredToken {
        const p = this.take(state);
        if (fragment.error) throw new Error(`Sign-in refused: ${fragment.error}${fragment.error_description ? ` (${fragment.error_description})` : ''}`);
        return this.save(p.key, { access_token: fragment.access_token, expires_in: fragment.expires_in ? Number(fragment.expires_in) : undefined, token_type: fragment.token_type, scope: fragment.scope });
    }

    /** Device code: ask for a code the person enters on the verification page; the Studio polls in the background. */
    async startDevice(a: ApiAuth): Promise<{ id: string; userCode: string; verificationUri: string; verificationUriComplete?: string; expiresIn: number }> {
        if (!a.deviceUrl) throw new Error('Give the device authorization URL.');
        const f: Record<string, string> = { client_id: a.clientId ?? '' };
        if (a.scope) f.scope = a.scope;
        if (a.audience) f.audience = a.audience;
        const res = await send({ method: 'POST', url: a.deviceUrl, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(f).toString(), missing: [] }, this.conn(), 30_000);
        const j = (res.json ?? {}) as { device_code?: string; user_code?: string; verification_uri?: string; verification_url?: string; verification_uri_complete?: string; expires_in?: number; interval?: number; error?: string };
        if (res.status >= 400 || !j.device_code || !j.user_code) throw new Error(`The device authorization request failed: HTTP ${res.status}${j.error ? ` ${j.error}` : ''}`);
        const id = b64url(crypto.randomBytes(12));
        const expiresIn = j.expires_in ?? 900;
        const d = { key: tokenKey(a), state: 'waiting' as const, userCode: j.user_code, verificationUri: j.verification_uri ?? j.verification_url ?? '', until: Date.now() + expiresIn * 1000 };
        this.devices.set(id, d);
        void this.pollDevice(id, a, j.device_code, Math.max(1, j.interval ?? 5));
        return { id, userCode: j.user_code, verificationUri: d.verificationUri, ...(j.verification_uri_complete ? { verificationUriComplete: j.verification_uri_complete } : {}), expiresIn };
    }

    private async pollDevice(id: string, a: ApiAuth, deviceCode: string, interval: number): Promise<void> {
        const d = this.devices.get(id)!;
        let wait = interval;
        while (d.state === 'waiting' && Date.now() < d.until) {
            await new Promise((r) => setTimeout(r, wait * 1000));
            try {
                const r = await this.tokenRequest(a, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
                if (r.json.access_token) { this.save(d.key, r.json); this.devices.set(id, { ...d, state: 'done' }); return; }
                if (r.json.error === 'authorization_pending') continue;
                if (r.json.error === 'slow_down') { wait += 5; continue; }
                this.devices.set(id, { ...d, state: 'failed', error: r.json.error_description ?? r.json.error ?? `HTTP ${r.status}` });
                return;
            } catch (e) { this.devices.set(id, { ...d, state: 'failed', error: (e as Error).message }); return; }
        }
        if (this.devices.get(id)?.state === 'waiting') this.devices.set(id, { ...d, state: 'failed', error: 'The code expired before it was entered.' });
    }

    deviceStatus(id: string): { state: 'waiting' | 'done' | 'failed'; error?: string } {
        const d = this.devices.get(id);
        if (!d) return { state: 'failed', error: 'Unknown sign-in.' };
        return { state: d.state, ...(d.error ? { error: d.error } : {}) };
    }

    /** What the Studio holds for this auth: signed in or not, until when, renewable or not. */
    status(a: ApiAuth): { signedIn: boolean; until?: number; refreshable?: boolean } {
        const t = this.store.get(tokenKey(a));
        return t ? { signedIn: t.until > Date.now() || !!t.refresh, until: t.until, refreshable: !!t.refresh } : { signedIn: false };
    }
    forget(a: ApiAuth): void { this.store.delete(tokenKey(a)); }
}

/**
 * The access token for an OAuth2 auth that needs a sign-in (or a fixed refresh token): from the store, renewed with
 * its refresh token when expired. Throws when there is none (the person must sign in from the Studio).
 */
export async function storedAccessToken(a: ApiAuth, store: TokenStore, request: (form: Record<string, string>) => Promise<{ status: number; json: TokenResponse }>): Promise<string> {
    const key = tokenKey(a);
    const t = store.get(key);
    if (t && t.until > Date.now()) return t.token;
    const refresh = t?.refresh ?? (a.grant === 'refresh_token' ? a.refreshToken : undefined);
    if (refresh) {
        const r = await request({ grant_type: 'refresh_token', refresh_token: refresh, ...(a.scope ? { scope: a.scope } : {}) });
        if (r.status < 400 && r.json.access_token) {
            const s: StoredToken = { token: r.json.access_token, until: Date.now() + Math.max(30, (r.json.expires_in ?? 3600) - 60) * 1000, refresh: r.json.refresh_token ?? refresh, tokenType: r.json.token_type };
            store.set(key, s);
            return s.token;
        }
        store.delete(key);
        throw new Error(`Renewing the OAuth2 token failed (HTTP ${r.status}${r.json.error ? ` ${r.json.error}` : ''}): sign in again (Authorization → Get new token).`);
    }
    throw new Error('Not signed in: open the Authorization tab and press "Get new token" (OAuth 2.0 sign-in).');
}
