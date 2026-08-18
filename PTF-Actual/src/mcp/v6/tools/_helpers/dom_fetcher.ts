/**
 * dom_fetcher — HTTP fetch of a live application URL with SSO detection,
 * redirect chain tracking, response-size cap, and a per-attempt timeout.
 *
 * NOT for ADO API calls — that's `AdoHttpClient`. This is for the live
 * application-under-test whose DOM we want to snapshot for locator
 * extraction. The two have different needs:
 *
 *  - No PAT; auth is optional and comes from the caller (Basic, Bearer,
 *    or plain header pass-through).
 *  - Redirect chain must be surfaced so SSO gate detection is possible
 *    (Okta/AAD/ADFS/microsoftonline/PingIdentity/Auth0).
 *  - Response-size cap prevents an unbounded page (10 MB default).
 *  - Never retries — a static HTML fetch that fails is a signal, not
 *    something to hammer.
 *
 * SSO detection is deliberately conservative: hostname regex only. If a
 * caller's app happens to have the substring "auth" in the URL for
 * non-auth reasons, they can pass `disableSsoDetection: true`.
 */

const SSO_HOST_PATTERNS: RegExp[] = [
    /\.okta(preview)?\.com$/i,
    /login\.microsoftonline\.com$/i,
    /login\.microsoft\.com$/i,
    /login\.live\.com$/i,
    /accounts\.google\.com$/i,
    /adfs\./i,
    /auth\d?\./i,
    /pingidentity\.com$/i,
    /pingone\.com$/i,
    /\.auth0\.com$/i,
    /identity(server|provider)\./i,
    /sso\./i,
];

export interface DomFetchOptions {
    url: string;
    /**
     * Additional headers to send. `Authorization` may be included for
     * Basic/Bearer-protected pages. Never logged.
     */
    headers?: Record<string, string>;
    userAgent?: string;
    followRedirects?: boolean;
    maxRedirects?: number;
    timeoutMs?: number;
    /** Cap on the response body in bytes (default 10 MB). */
    maxResponseBytes?: number;
    /** Disable Okta/AAD/etc. hostname sniffing on the final URL. */
    disableSsoDetection?: boolean;
    /** Injected fetch for tests. */
    fetchImpl?: typeof fetch;
}

export interface RedirectHop {
    from: string;
    to: string;
    status: number;
}

export interface DomFetchResult {
    ok: boolean;
    /** The starting URL. */
    startUrl: string;
    /** The URL of the response we ultimately received (== startUrl if no redirects). */
    finalUrl: string;
    /** Complete redirect chain, empty when no redirects were followed. */
    redirectChain: RedirectHop[];
    /** HTTP status of the FINAL response. */
    status: number;
    contentType: string;
    /** The HTML body — empty string when authRequired or when fetch failed. */
    html: string;
    /** true when we hit the response-size cap; body is truncated at the cap. */
    truncated: boolean;
    /**
     * True when the final URL host matches an SSO gate pattern OR the response
     * status is 401/407. In either case `html` will typically be a login page
     * and locator extraction against it is worthless — caller should surface
     * `authRequired: true` in the tool's output rather than trying to parse.
     */
    authRequired: boolean;
    /** Populated when authRequired: which pattern matched, or "401", "407". */
    authReason?: string;
    /** Everything the caller might want to know that didn't fit a first-class field. */
    warnings: string[];
    /** Populated when a network / DNS / timeout / cert error prevented any response. */
    fetchError?: string;
}

function isSsoUrl(urlStr: string): { matched: boolean; reason?: string } {
    try {
        const u = new URL(urlStr);
        for (const pat of SSO_HOST_PATTERNS) {
            if (pat.test(u.hostname)) return { matched: true, reason: pat.source };
        }
    } catch {
        /* invalid URL — never treated as SSO */
    }
    return { matched: false };
}

const DEFAULT_UA = 'cs-qa-mcp/dom-fetcher (compatible; scaffold)';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

async function readCappedText(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    // Prefer the streaming reader (bounded memory); fall back to text() when unavailable.
    const anyRes = res as unknown as { body?: { getReader?: () => { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel?: () => Promise<void> } } };
    const reader = anyRes.body?.getReader?.();
    if (!reader) {
        const t = await res.text();
        if (t.length > maxBytes) return { text: t.slice(0, maxBytes), truncated: true };
        return { text: t, truncated: false };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk = Buffer.from(value);
        if (total + chunk.length > maxBytes) {
            const remaining = maxBytes - total;
            if (remaining > 0) chunks.push(chunk.slice(0, remaining));
            truncated = true;
            try { await reader.cancel?.(); } catch { /* ignore */ }
            break;
        }
        chunks.push(chunk);
        total += chunk.length;
    }
    return { text: Buffer.concat(chunks).toString('utf-8'), truncated };
}

export async function fetchDom(opts: DomFetchOptions): Promise<DomFetchResult> {
    const startUrl = opts.url;
    const followRedirects = opts.followRedirects !== false;
    const maxRedirects = Math.max(0, opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS);
    const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxBytes = Math.max(1024, opts.maxResponseBytes ?? DEFAULT_MAX_BYTES);
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (typeof fetchImpl !== 'function') {
        return {
            ok: false, startUrl, finalUrl: startUrl, redirectChain: [], status: 0,
            contentType: '', html: '', truncated: false, authRequired: false, warnings: [],
            fetchError: 'global fetch is not available in this runtime',
        };
    }

    const headers: Record<string, string> = {
        'User-Agent': opts.userAgent || DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        ...(opts.headers || {}),
    };

    const redirectChain: RedirectHop[] = [];
    let currentUrl = startUrl;
    const warnings: string[] = [];

    for (let hop = 0; hop <= maxRedirects; hop++) {
        let signal: AbortSignal | undefined;
        try { signal = AbortSignal.timeout(timeoutMs); } catch { /* older runtimes */ }
        let res: Response;
        try {
            // `redirect: 'manual'` gives us the redirect chain so we can surface it.
            res = await fetchImpl(currentUrl, { method: 'GET', headers, redirect: 'manual', signal });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                ok: false, startUrl, finalUrl: currentUrl, redirectChain, status: 0,
                contentType: '', html: '', truncated: false, authRequired: false, warnings,
                fetchError: msg,
            };
        }
        const status = res.status;
        const isRedirect = status >= 300 && status < 400 && !!res.headers.get('location');
        if (isRedirect && followRedirects && hop < maxRedirects) {
            const loc = res.headers.get('location') || '';
            let nextUrl: string;
            try { nextUrl = new URL(loc, currentUrl).toString(); }
            catch { warnings.push(`invalid Location header at ${currentUrl}: ${loc}`); break; }
            redirectChain.push({ from: currentUrl, to: nextUrl, status });
            // SSO gate detection on the REDIRECT TARGET — surface authRequired
            // instead of blindly following into a login page we can't parse.
            const preSso = opts.disableSsoDetection ? { matched: false } : isSsoUrl(nextUrl);
            if (preSso.matched) {
                return {
                    ok: false, startUrl, finalUrl: nextUrl, redirectChain, status,
                    contentType: res.headers.get('content-type') || '', html: '', truncated: false,
                    authRequired: true,
                    authReason: preSso.reason,
                    warnings,
                };
            }
            currentUrl = nextUrl;
            continue;
        }
        if (isRedirect && (!followRedirects || hop >= maxRedirects)) {
            const reason = !followRedirects ? 'followRedirects=false' : `maxRedirects=${maxRedirects} exhausted`;
            warnings.push(`stopped at redirect (${reason}): ${status} → ${res.headers.get('location') ?? ''}`);
            const sso = opts.disableSsoDetection ? { matched: false } : isSsoUrl(res.headers.get('location') || '');
            return {
                ok: false, startUrl, finalUrl: currentUrl, redirectChain, status,
                contentType: res.headers.get('content-type') || '', html: '', truncated: false,
                authRequired: sso.matched,
                authReason: sso.matched ? sso.reason : undefined,
                warnings,
            };
        }

        // Terminal response.
        const contentType = res.headers.get('content-type') || '';
        // 401/407 are always auth-required regardless of Content-Type.
        if (status === 401 || status === 407) {
            return {
                ok: false, startUrl, finalUrl: currentUrl, redirectChain, status,
                contentType, html: '', truncated: false, authRequired: true,
                authReason: String(status),
                warnings,
            };
        }
        // SSO gate detection on the FINAL host.
        const sso = opts.disableSsoDetection ? { matched: false } : isSsoUrl(currentUrl);
        if (sso.matched) {
            return {
                ok: status >= 200 && status < 300,
                startUrl, finalUrl: currentUrl, redirectChain, status, contentType,
                html: '', truncated: false, authRequired: true,
                authReason: sso.reason,
                warnings,
            };
        }
        if (status < 200 || status >= 300) {
            let bodySnippet = '';
            try { bodySnippet = (await res.text()).slice(0, 500); } catch { /* ignore */ }
            return {
                ok: false, startUrl, finalUrl: currentUrl, redirectChain, status, contentType,
                html: bodySnippet, truncated: false, authRequired: false, warnings,
            };
        }
        const { text, truncated } = await readCappedText(res, maxBytes);
        if (truncated) warnings.push(`response truncated at ${maxBytes} bytes`);
        return {
            ok: true, startUrl, finalUrl: currentUrl, redirectChain, status, contentType,
            html: text, truncated, authRequired: false, warnings,
        };
    }
    // Unreachable — the loop always returns or continues.
    return {
        ok: false, startUrl, finalUrl: currentUrl, redirectChain, status: 0,
        contentType: '', html: '', truncated: false, authRequired: false, warnings,
        fetchError: 'exceeded redirect budget without terminal response',
    };
}
