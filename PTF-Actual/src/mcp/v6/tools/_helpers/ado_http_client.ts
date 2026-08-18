/**
 * Canonical HTTP client for every v6 ADO tool. Enforced properties:
 *
 * 1. Honors `Retry-After` on 429/503 (seconds or HTTP-date). When the server
 *    tells us exactly how long to wait we respect it — pure exponential backoff
 *    is both slower and more likely to re-hit the throttle.
 * 2. Response-body size cap (default 20MB) so a hostile attachment cannot OOM
 *    the process.
 * 3. PAT never appears in `AdoHttpError` messages or logs — Authorization is
 *    redacted before any error surfaces.
 * 4. Content-type-aware body handling — `/wit/workitems` paths default to
 *    `application/json-patch+json` (ADO WI PATCH REQUIRES this MIME); every
 *    other JSON write uses `application/json`.
 * 5. Per-attempt timeout via `AbortSignal.timeout` — a per-try clock rather
 *    than a global watchdog that could fire mid-retry.
 *
 * Not opinionated about ADO API shape — this is a transport, not a client.
 */

export interface AdoCreds {
    orgUrl: string;
    project: string;
    pat: string;
}

export interface AdoHttpOptions {
    /** Per-attempt timeout in ms; default 30_000. */
    timeoutMs?: number;
    /** Total attempts (initial + retries); default 3. */
    maxAttempts?: number;
    /** Extra headers to merge; Authorization is always overwritten. */
    headers?: Record<string, string>;
    /** Override the response cap (bytes); default 20 * 1024 * 1024. */
    maxResponseBytes?: number;
    /**
     * Whether to prepend `${orgUrl}/${project}` (default true).
     * Set false for calls that live above the project scope (e.g. /_apis/projects).
     */
    scopeToProject?: boolean;
    /** Override the initial retry backoff base ms; default 100. */
    retryBaseMs?: number;
    /** Cap on any single backoff wait; default 30_000. */
    retryCapMs?: number;
    /** Retryable HTTP status codes; default [408, 429, 500, 502, 503, 504]. */
    retryableStatus?: number[];
    /**
     * Optional structured logger; receives every attempt + outcome. Never receives
     * the PAT — headers are redacted before handing them over.
     */
    onEvent?: (evt: AdoHttpEvent) => void;
    /** If true, expect binary payload and return the raw Buffer + metadata. */
    binary?: boolean;
    /** Optional injected fetch implementation for tests. Falls back to global fetch. */
    fetchImpl?: typeof fetch;
}

export type AdoHttpEvent =
    | { kind: 'attempt-start'; method: string; url: string; attempt: number; maxAttempts: number }
    | { kind: 'attempt-success'; method: string; url: string; attempt: number; status: number; durationMs: number }
    | { kind: 'attempt-retry'; method: string; url: string; attempt: number; status?: number; waitMs: number; reason: string }
    | { kind: 'attempt-fail'; method: string; url: string; attempt: number; status?: number; error: string };

export interface AdoBinaryResponse {
    status: number;
    contentType: string;
    contentLength: number;
    body: Buffer;
    headers: Record<string, string>;
    truncated: boolean;
}

export class AdoHttpError extends Error {
    public readonly status: number;
    public readonly method: string;
    public readonly url: string;
    public readonly attempts: number;
    public readonly bodySnippet: string;

    constructor(args: { message: string; status: number; method: string; url: string; attempts: number; bodySnippet: string }) {
        super(args.message);
        this.name = 'AdoHttpError';
        this.status = args.status;
        this.method = args.method;
        this.url = args.url;
        this.attempts = args.attempts;
        this.bodySnippet = args.bodySnippet;
    }
}

const DEFAULT_RETRYABLE: readonly number[] = [408, 429, 500, 502, 503, 504];
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export class AdoHttpClient {
    private readonly cfg: AdoCreds;
    private readonly authHeader: string;

    constructor(cfg: AdoCreds) {
        if (!cfg.orgUrl) throw new Error('AdoHttpClient: orgUrl is required');
        if (!cfg.project) throw new Error('AdoHttpClient: project is required');
        if (!cfg.pat) throw new Error('AdoHttpClient: pat is required');
        this.cfg = { ...cfg, orgUrl: cfg.orgUrl.replace(/\/$/, '') };
        this.authHeader = 'Basic ' + Buffer.from(`:${this.cfg.pat}`).toString('base64');
    }

    public async get<T = unknown>(pathAndQuery: string, opts: AdoHttpOptions = {}): Promise<T> {
        return this.request<T>('GET', pathAndQuery, undefined, opts);
    }

    public async post<T = unknown>(pathAndQuery: string, body?: unknown, opts: AdoHttpOptions = {}): Promise<T> {
        return this.request<T>('POST', pathAndQuery, body, opts);
    }

    public async patch<T = unknown>(pathAndQuery: string, body?: unknown, opts: AdoHttpOptions = {}): Promise<T> {
        return this.request<T>('PATCH', pathAndQuery, body, opts);
    }

    public async put<T = unknown>(pathAndQuery: string, body?: unknown, opts: AdoHttpOptions = {}): Promise<T> {
        return this.request<T>('PUT', pathAndQuery, body, opts);
    }

    public async delete<T = unknown>(pathAndQuery: string, opts: AdoHttpOptions = {}): Promise<T> {
        return this.request<T>('DELETE', pathAndQuery, undefined, opts);
    }

    public async getBinary(pathAndQuery: string, opts: AdoHttpOptions = {}): Promise<AdoBinaryResponse> {
        const merged: AdoHttpOptions = { ...opts, binary: true };
        // request<> will actually return AdoBinaryResponse when binary=true, but we
        // erase that from the type signature to keep the generic ergonomic — cast here.
        return this.request<AdoBinaryResponse>('GET', pathAndQuery, undefined, merged);
    }

    private buildUrl(pathAndQuery: string, scopeToProject: boolean): string {
        const suffix = pathAndQuery.replace(/^\//, '');
        return scopeToProject
            ? `${this.cfg.orgUrl}/${encodeURIComponent(this.cfg.project)}/${suffix}`
            : `${this.cfg.orgUrl}/${suffix}`;
    }

    private pickContentType(pathAndQuery: string, method: string): string {
        // ADO's Work Item PATCH endpoint requires application/json-patch+json.
        // Everything else uses plain application/json.
        if ((method === 'POST' || method === 'PATCH') && /\/wit\/workitems(\/|$|\?)/.test(pathAndQuery)) {
            return 'application/json-patch+json';
        }
        return 'application/json';
    }

    private parseRetryAfterMs(raw: string | null): number | null {
        if (!raw) return null;
        const trimmed = raw.trim();
        // Seconds
        if (/^\d+(\.\d+)?$/.test(trimmed)) {
            return Math.max(0, Math.floor(Number(trimmed) * 1000));
        }
        // HTTP-date
        const dateMs = Date.parse(trimmed);
        if (!Number.isNaN(dateMs)) {
            return Math.max(0, dateMs - Date.now());
        }
        return null;
    }

    private computeBackoffMs(attempt: number, baseMs: number, capMs: number, retryAfterMs: number | null): number {
        if (retryAfterMs !== null) return Math.min(retryAfterMs, capMs);
        // Exponential with full jitter.
        const exp = Math.min(capMs, baseMs * Math.pow(2, attempt - 1));
        return Math.floor(Math.random() * exp);
    }

    private static sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }

    private redactHeaders(h: Record<string, string>): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(h)) {
            if (/^authorization$/i.test(k)) out[k] = '***REDACTED***';
            else out[k] = v;
        }
        return out;
    }

    private redactPatText(msg: string): string {
        // Belt-and-braces: also strip any raw PAT that somehow leaked into a body/error.
        if (!this.cfg.pat) return msg;
        return msg.split(this.cfg.pat).join('***REDACTED***');
    }

    private async readCapped(res: Response, maxBytes: number, binary: boolean): Promise<{ buf: Buffer; truncated: boolean }> {
        const reader = (res.body as unknown as { getReader?: () => { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel?: () => Promise<void> } })?.getReader?.();
        if (!reader) {
            // Fallback: no stream available. Use text/arrayBuffer with cap-after-fetch.
            if (binary) {
                const ab = await res.arrayBuffer();
                const buf = Buffer.from(ab);
                return { buf: buf.length > maxBytes ? buf.slice(0, maxBytes) : buf, truncated: buf.length > maxBytes };
            }
            const t = await res.text();
            const buf = Buffer.from(t, 'utf-8');
            return { buf: buf.length > maxBytes ? buf.slice(0, maxBytes) : buf, truncated: buf.length > maxBytes };
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
        return { buf: Buffer.concat(chunks), truncated };
    }

    private async request<T>(method: string, pathAndQuery: string, body: unknown, opts: AdoHttpOptions): Promise<T> {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
        const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
        const scopeToProject = opts.scopeToProject !== false;
        const retryBaseMs = opts.retryBaseMs ?? 100;
        const retryCapMs = opts.retryCapMs ?? 30_000;
        const retryable = new Set(opts.retryableStatus ?? DEFAULT_RETRYABLE);
        const binary = opts.binary === true;
        const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);

        const url = this.buildUrl(pathAndQuery, scopeToProject);
        const contentType = this.pickContentType(pathAndQuery, method);

        const requestHeaders: Record<string, string> = {
            Authorization: this.authHeader,
            Accept: binary ? '*/*' : 'application/json',
            ...(opts.headers ?? {}),
        };
        // Only set Content-Type when we're sending a body.
        let bodyBuf: BodyInit | undefined;
        if (body !== undefined && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
            requestHeaders['Content-Type'] = contentType;
            bodyBuf = typeof body === 'string' ? body : JSON.stringify(body);
        }
        // Always overwrite auth with our canonical value (never let opts.headers leak a PAT).
        requestHeaders.Authorization = this.authHeader;

        let lastError: unknown = null;
        let lastStatus = 0;
        let lastBodyText = '';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const started = Date.now();
            opts.onEvent?.({ kind: 'attempt-start', method, url, attempt, maxAttempts });
            try {
                const signal = AbortSignal.timeout(timeoutMs);
                const res = await fetchImpl(url, { method, headers: requestHeaders, body: bodyBuf, signal });
                const status = res.status;

                if (res.ok) {
                    const capped = await this.readCapped(res, maxResponseBytes, binary);
                    opts.onEvent?.({ kind: 'attempt-success', method, url, attempt, status, durationMs: Date.now() - started });
                    if (binary) {
                        const headers: Record<string, string> = {};
                        res.headers.forEach((v, k) => { headers[k] = v; });
                        const contentLen = Number(res.headers.get('content-length') ?? capped.buf.length);
                        const respBinary: AdoBinaryResponse = {
                            status,
                            contentType: res.headers.get('content-type') ?? 'application/octet-stream',
                            contentLength: Number.isFinite(contentLen) ? contentLen : capped.buf.length,
                            body: capped.buf,
                            headers,
                            truncated: capped.truncated,
                        };
                        return respBinary as unknown as T;
                    }
                    const text = capped.buf.toString('utf-8');
                    if (text.length === 0) return undefined as unknown as T;
                    // Some ADO endpoints return non-JSON text (e.g. work item comments as HTML) —
                    // fall back gracefully so the caller can inspect .toString().
                    try {
                        return JSON.parse(text) as T;
                    } catch {
                        return text as unknown as T;
                    }
                }

                // Non-2xx.
                lastStatus = status;
                lastBodyText = await res.text().catch(() => '');
                if (retryable.has(status) && attempt < maxAttempts) {
                    const retryAfterMs = this.parseRetryAfterMs(res.headers.get('retry-after'));
                    const waitMs = this.computeBackoffMs(attempt, retryBaseMs, retryCapMs, retryAfterMs);
                    opts.onEvent?.({ kind: 'attempt-retry', method, url, attempt, status, waitMs, reason: retryAfterMs !== null ? 'retry-after-header' : 'exponential-backoff' });
                    await AdoHttpClient.sleep(waitMs);
                    continue;
                }
                // Non-retryable or out of attempts.
                const snippet = this.redactPatText(lastBodyText).slice(0, 500);
                throw new AdoHttpError({
                    message: `ADO ${method} ${url} → ${status} ${res.statusText || ''}`.trim() + (snippet ? ` :: ${snippet}` : ''),
                    status,
                    method,
                    url,
                    attempts: attempt,
                    bodySnippet: snippet,
                });
            } catch (err) {
                if (err instanceof AdoHttpError) {
                    opts.onEvent?.({ kind: 'attempt-fail', method, url, attempt, status: err.status, error: err.message });
                    throw err;
                }
                lastError = err;
                const errName = (err as { name?: string } | null)?.name ?? '';
                const isAbort = errName === 'AbortError' || errName === 'TimeoutError';
                // Network / abort / DNS — retry if we have budget.
                if (attempt < maxAttempts) {
                    const waitMs = this.computeBackoffMs(attempt, retryBaseMs, retryCapMs, null);
                    opts.onEvent?.({ kind: 'attempt-retry', method, url, attempt, waitMs, reason: isAbort ? 'timeout' : 'network-error' });
                    await AdoHttpClient.sleep(waitMs);
                    continue;
                }
                const msg = this.redactPatText((err as Error)?.message ?? String(err));
                opts.onEvent?.({ kind: 'attempt-fail', method, url, attempt, error: msg });
                throw new AdoHttpError({
                    message: `ADO ${method} ${url} failed after ${attempt} attempts: ${msg}`,
                    status: lastStatus,
                    method,
                    url,
                    attempts: attempt,
                    bodySnippet: this.redactPatText(lastBodyText).slice(0, 500),
                });
            }
        }
        // Unreachable but keeps TS happy.
        throw new AdoHttpError({
            message: `ADO ${method} ${url}: exhausted attempts without response`,
            status: lastStatus,
            method,
            url,
            attempts: maxAttempts,
            bodySnippet: this.redactPatText(String(lastError ?? '')).slice(0, 500),
        });
    }
}
