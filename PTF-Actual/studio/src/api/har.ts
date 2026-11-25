/**
 * HAR (HTTP Archive: the browser's "Save all as HAR" of the Network tab, or a proxy recording) → an
 * API collection for functional or load tests:
 *  - static files (images, styles, scripts, fonts), CORS preflights and other hosts are left out;
 *  - browser-only headers are dropped; cookies are dropped (named in a warning);
 *  - each request checks the status it got when it was recorded;
 *  - correlation: a value the server returned (a JSON field or a token header) that later requests
 *    send back is saved from the first response ({{variable}}) and used by the later requests, so
 *    each run (and each virtual user) uses its own ids and tokens instead of the recorded ones;
 *  - credentials that are not correlated (Authorization, API keys) are not written to the collection:
 *    they become {env:NAME} references and are returned to be stored as secrets.
 */
import { ApiBody, ApiCheck, ApiCollection, ApiExtract, ApiRequest, HttpMethod, httpMethod, KV, newCollection, randomId } from './model';
import { findByRules } from './correlationRules';

interface HarHeader { name: string; value: string }
interface HarEntry {
    startedDateTime?: string;
    time?: number;
    _resourceType?: string;
    request: { method: string; url: string; headers?: HarHeader[]; postData?: { mimeType?: string; text?: string; params?: Array<{ name: string; value?: string; fileName?: string }> } };
    response?: { status?: number; headers?: HarHeader[]; content?: { mimeType?: string; text?: string; encoding?: string } };
}

export interface HarCorrelation {
    variable: string;
    /** Request (index among the imported requests) whose response gives the value. */
    from: number;
    fromName: string;
    kind: 'json' | 'header' | 'regex';
    /** JSON path, header name, or a regular expression (correlation rules: view state, anti-forgery tokens…). */
    path: string;
    /** The correlation rule that found it (ASP.NET, JSF, Siebel, SAP…). */
    rule?: string;
    /** The recorded value, shortened. */
    preview: string;
    /** Names of the requests that send it back. */
    usedBy: string[];
}

export interface HarReport {
    entries: number;
    imported: number;
    skipped: { static: number; preflight: number; otherHosts: number; other: number };
    hosts: Array<{ host: string; requests: number }>;
    correlations: HarCorrelation[];
    /** Median pause between requests in the recording (ms): a starting point for think time. */
    medianPause?: number;
    warnings: string[];
    secrets: Record<string, string>;
}

export interface HarOptions {
    /** Hosts to keep (default: every host with requests that are not static files). */
    hosts?: string[];
    /** Correlation variables not to apply. */
    skipCorrelations?: string[];
    name?: string;
    /** Keep the HTML pages the browser opened (a load test loads them; an API collection leaves them out). */
    pages?: boolean;
}

const STATIC_EXT = /\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i;
const STATIC_TYPES = new Set(['image', 'stylesheet', 'script', 'font', 'media', 'manifest', 'texttrack', 'ping', 'websocket', 'eventsource']);
const STATIC_MIME = /^(image\/|font\/|text\/css|(text|application)\/(x-)?javascript|application\/font|video\/|audio\/)/i;
/** Headers a browser adds on its own (or that must be computed per request). */
const DROP_HEADER = /^(:.*|host|content-length|connection|keep-alive|accept-encoding|cookie|origin|referer|user-agent|upgrade-insecure-requests|priority|te|dnt|pragma|cache-control|if-none-match|if-modified-since|sec-.*)$/i;
const CREDENTIAL_HEADER = /^(authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|ocp-apim-subscription-key)$/i;

export function parseHar(text: string): HarEntry[] {
    let j: unknown;
    try { j = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`The file is not valid JSON: ${(e as Error).message}`); }
    const entries = (j as { log?: { entries?: unknown } })?.log?.entries;
    if (!Array.isArray(entries)) throw new Error('This is not a HAR file (no log.entries). In the browser: Developer tools → Network → right-click → "Save all as HAR".');
    return entries.filter((e): e is HarEntry => !!e && typeof e === 'object' && typeof (e as HarEntry).request?.url === 'string' && typeof (e as HarEntry).request?.method === 'string');
}

const isStatic = (e: HarEntry) => {
    if (e._resourceType && STATIC_TYPES.has(e._resourceType.toLowerCase())) return true;
    let p = '';
    try { p = new URL(e.request.url).pathname; } catch { return false; }
    return STATIC_EXT.test(p) || STATIC_MIME.test(e.response?.content?.mimeType ?? '');
};
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return ''; } };

/** Leaf values of a JSON document with their framework-style paths ($.a.b[0].c). */
export function leaves(v: unknown, at = '$', out: Array<{ path: string; value: string; key: string }> = [], depth = 0): typeof out {
    if (depth > 12 || out.length > 5000) return out;
    if (Array.isArray(v)) v.slice(0, 50).forEach((x, i) => leaves(x, `${at}[${i}]`, out, depth + 1));
    else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (/^[\w-]+$/.test(k)) leaves(x, `${at}.${k}`, out, depth + 1);
    } else if (typeof v === 'string' || typeof v === 'number') out.push({ path: at, value: String(v), key: /([\w-]+)(\[\d+\])*$/.exec(at)?.[1] ?? 'value' });
    return out;
}

/** Worth correlating: ids and tokens, not words, flags, small numbers or dates. */
export function candidate(v: string): boolean {
    if (v.length < 4 || v.length > 4096) return false;
    if (/^(true|false|null|ok|success|active|yes|no)$/i.test(v)) return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return false;
    if (/^\d+$/.test(v)) return v.length >= 4;
    if (/^https?:\/\//i.test(v)) return false;
    if (v.length >= 16 && !/\s/.test(v)) return true;
    return /\d/.test(v) && /^[\w.~+/=-]+$/.test(v) && v.length >= 6;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Short values must be a whole token (not part of a longer number or word). */
const finder = (v: string) => (v.length >= 16 ? new RegExp(escapeRe(v), 'g') : new RegExp(`(?<![\\w-])${escapeRe(v)}(?![\\w-])`, 'g'));

const varName = (key: string, used: Set<string>) => {
    let base = key.replace(/[^\w]/g, '_').replace(/^(\d)/, '_$1') || 'value';
    if (/^(id|value|data|token|key)$/i.test(base)) base = base.toLowerCase();
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}${i}`;
    used.add(n);
    return n;
};

function body(e: HarEntry, warnings: string[]): ApiBody {
    const pd = e.request.postData;
    if (!pd || (pd.text === undefined && !pd.params)) return { mode: 'none' };
    const mime = (pd.mimeType ?? '').toLowerCase();
    if (mime.includes('application/x-www-form-urlencoded')) {
        const form: KV[] = pd.params?.length ? pd.params.map((p) => ({ key: decodeURIComponent(p.name.replace(/\+/g, ' ')), value: decodeURIComponent((p.value ?? '').replace(/\+/g, ' ')) }))
            : [...new URLSearchParams(pd.text ?? '')].map(([key, value]) => ({ key, value }));
        return { mode: 'form', form };
    }
    if (mime.includes('multipart/form-data')) {
        warnings.push(`${e.request.method} ${e.request.url}: a multipart upload was recorded; add the files under Body → Multipart.`);
        return { mode: 'multipart', parts: (pd.params ?? []).map((p) => (p.fileName ? { key: p.name, value: `test/<project>/data/${p.fileName}`, type: 'file' as const } : { key: p.name, value: p.value ?? '' })) };
    }
    const t = pd.text ?? '';
    if (mime.includes('json') || /^\s*[[{]/.test(t)) return { mode: 'json', text: t };
    if (mime.includes('xml')) return { mode: 'xml', text: t };
    return { mode: 'text', text: t };
}

export function importHar(text: string, o: HarOptions = {}): { collection: ApiCollection; report: HarReport } {
    const all = parseHar(text);
    const report: HarReport = { entries: all.length, imported: 0, skipped: { static: 0, preflight: 0, otherHosts: 0, other: 0 }, hosts: [], correlations: [], warnings: [], secrets: {} };
    const hostCount = new Map<string, number>();
    const dynamic: HarEntry[] = [];
    for (const e of all) {
        if (!/^https?:/i.test(e.request.url)) { report.skipped.other++; continue; }
        if (e.request.method.toUpperCase() === 'OPTIONS') { report.skipped.preflight++; continue; }
        if (isStatic(e)) { report.skipped.static++; continue; }
        // An HTML page the browser navigated to (GET, answered with text/html; not an API call).
        if (!o.pages && e.request.method.toUpperCase() === 'GET' && (e._resourceType?.toLowerCase() === 'document' || /^text\/html/i.test(e.response?.content?.mimeType ?? ''))) { report.skipped.static++; continue; }
        if (!httpMethod(e.request.method)) { report.skipped.other++; continue; }
        const h = hostOf(e.request.url);
        hostCount.set(h, (hostCount.get(h) ?? 0) + 1);
        dynamic.push(e);
    }
    report.hosts = [...hostCount].sort((a, b) => b[1] - a[1]).map(([host, requests]) => ({ host, requests }));
    const keep = new Set(o.hosts?.length ? o.hosts : report.hosts.map((h) => h.host));
    const entries = dynamic.filter((e) => keep.has(hostOf(e.request.url)));
    report.skipped.otherHosts = dynamic.length - entries.length;
    if (!entries.length) throw new Error(all.length ? 'No API requests to import (only static files, preflights or other hosts).' : 'The recording has no requests.');

    // Base URL: the most used origin.
    const origins = new Map<string, number>();
    for (const e of entries) { const u = new URL(e.request.url); origins.set(u.origin, (origins.get(u.origin) ?? 0) + 1); }
    const base = [...origins].sort((a, b) => b[1] - a[1])[0][0];

    const c = newCollection(o.name?.trim() || `Recording ${hostOf(base)}`);
    c.baseUrl = base;
    const cookieHosts = new Set<string>();
    const reqs: ApiRequest[] = entries.map((e) => {
        const u = new URL(e.request.url);
        const query: KV[] = [...u.searchParams].map(([key, value]) => ({ key, value }));
        const headers: KV[] = [];
        for (const h of e.request.headers ?? []) {
            if (/^cookie$/i.test(h.name)) { cookieHosts.add(u.host); continue; }
            if (DROP_HEADER.test(h.name)) continue;
            if (/^content-type$/i.test(h.name) && /multipart\/form-data/i.test(h.value)) continue;
            if (!headers.some((x) => x.key.toLowerCase() === h.name.toLowerCase())) headers.push({ key: h.name, value: h.value });
        }
        const status = e.response?.status;
        const checks: ApiCheck[] = status && status >= 100 && status < 400 ? [{ kind: 'status', value: String(status) }] : [{ kind: 'statusBetween', min: 200, max: 399 }];
        return { kind: 'request', id: randomId(), name: '', method: e.request.method.toUpperCase() as HttpMethod, url: (u.origin === base ? '' : u.origin) + u.pathname, query, headers, body: body(e, report.warnings), auth: { type: 'inherit' }, checks, extract: [] };
    });
    if (cookieHosts.size) report.warnings.push(`Cookies were recorded for ${[...cookieHosts].join(', ')} and are not kept: a session that depends on cookies needs a sign-in request whose token is sent as a header.`);

    // ---- Correlation: values from responses that later requests send back.
    const sentBefore = (i: number, v: string) => entries.slice(0, i + 1).some((e) => requestText(e).includes(v));
    const usedVars = new Set<string>();
    const corr: Array<Omit<HarCorrelation, 'fromName' | 'usedBy'> & { value: string; users: number[] }> = [];
    const taken = new Set<string>();
    entries.forEach((e, i) => {
        const found: Array<{ kind: 'json' | 'header' | 'regex'; path: string; value: string; key: string; rule?: string }> = [];
        const ct = (e.response?.content?.mimeType ?? '').toLowerCase();
        const t = e.response?.content?.encoding === 'base64' ? '' : e.response?.content?.text ?? '';
        if (t && (ct.includes('json') || /^\s*[[{]/.test(t))) { try { for (const l of leaves(JSON.parse(t))) found.push({ kind: 'json', ...l }); } catch { /* not JSON */ } }
        for (const h of e.response?.headers ?? []) if (/^(x-csrf-token|x-xsrf-token|x-auth-token|x-access-token|x-session-id|x-request-token)$/i.test(h.name)) found.push({ kind: 'header', path: h.name, value: h.value, key: h.name.replace(/^x-/i, '') });
        // The correlation rules of web frameworks (view state, anti-forgery tokens, session ids in links).
        if (t && !ct.includes('json')) for (const f of findByRules(t, e.response?.headers ?? [])) if (!found.some((x) => x.value === f.value)) found.push(f);
        for (const f of found) {
            if (!candidate(f.value) || taken.has(f.value) || sentBefore(i, f.value)) continue;
            const re = finder(f.value);
            const users = entries.slice(i + 1).map((x, k) => (requestText(x).match(re) ? i + 1 + k : -1)).filter((k) => k >= 0);
            if (!users.length) continue;
            taken.add(f.value);
            corr.push({ variable: varName(f.key, usedVars), from: i, kind: f.kind, path: f.path, value: f.value, preview: f.value.length > 24 ? `${f.value.slice(0, 10)}…${f.value.slice(-6)}` : f.value, users, ...(f.rule ? { rule: f.rule } : {}) });
        }
    });
    const skip = new Set(o.skipCorrelations ?? []);
    for (const x of corr) {
        if (skip.has(x.variable)) continue;
        reqs[x.from].extract.push({ from: x.kind, path: x.path, variable: x.variable } as ApiExtract);
        const re = finder(x.value);
        const put = (s: string) => s.replace(re, `{{${x.variable}}}`);
        for (const r of reqs.slice(x.from + 1)) {
            r.url = put(r.url);
            r.query = r.query.map((q) => ({ ...q, value: put(q.value) }));
            r.headers = r.headers.map((h) => ({ ...h, value: put(h.value) }));
            if (r.body.text !== undefined) r.body = { ...r.body, text: put(r.body.text) };
            if (r.body.form) r.body = { ...r.body, form: r.body.form.map((f) => ({ ...f, value: put(f.value) })) };
        }
    }
    // Names from the URL as it is now ("GET users/{{id}}/cart" rather than a recorded id).
    const usedNames = new Map<string, number>();
    for (const r of reqs) {
        const last = r.url.replace(/^https?:\/\/[^/]+/i, '').split('/').filter(Boolean).slice(-3).join('/') || '/';
        let name = `${r.method} ${last}`;
        const n = (usedNames.get(name) ?? 0) + 1; usedNames.set(name, n);
        r.name = n > 1 ? `${name} (${n})` : name;
    }
    report.correlations = corr.map(({ value: _v, users, ...rest }) => ({ ...rest, fromName: reqs[rest.from].name, usedBy: users.map((k) => reqs[k].name) }));

    // ---- Credentials still written as recorded → secrets.
    const secretFor = new Map<string, string>();
    for (const r of reqs) {
        r.headers = r.headers.map((h) => {
            if (!CREDENTIAL_HEADER.test(h.key) || h.value.includes('{{')) return h;
            const m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(h.value);
            const secret = m ? m[2] : h.value;
            let name = secretFor.get(secret);
            if (!name) {
                name = `HAR_${h.key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}${secretFor.size ? `_${secretFor.size + 1}` : ''}`;
                secretFor.set(secret, name); report.secrets[name] = secret;
            }
            return { ...h, value: m ? `${m[1]} {env:${name}}` : `{env:${name}}` };
        });
    }

    // Pauses between requests (start to start, minus the request's own time).
    const starts = entries.map((e) => ({ at: Date.parse(e.startedDateTime ?? ''), time: e.time ?? 0 })).filter((x) => Number.isFinite(x.at));
    const pauses = starts.slice(1).map((x, k) => x.at - (starts[k].at + starts[k].time)).filter((p) => p >= 0).sort((a, b) => a - b);
    if (pauses.length) { const m = pauses.length >> 1; report.medianPause = Math.round(pauses.length % 2 ? pauses[m] : (pauses[m - 1] + pauses[m]) / 2); }
    // Each request keeps the pause the person made after it (a load path can use the recorded think times).
    entries.forEach((e, i) => {
        const a = Date.parse(e.startedDateTime ?? ''), b = Date.parse(entries[i + 1]?.startedDateTime ?? '');
        if (Number.isFinite(a) && Number.isFinite(b)) { const p = Math.round(b - (a + (e.time ?? 0))); if (p > 0) reqs[i].recordedThinkMs = Math.min(p, 600_000); }
    });

    c.items = reqs;
    report.imported = reqs.length;
    return { collection: c, report };
}

function requestText(e: HarEntry): string {
    return `${e.request.url}\n${(e.request.headers ?? []).filter((h) => !/^cookie$/i.test(h.name)).map((h) => `${h.name}: ${h.value}`).join('\n')}\n${e.request.postData?.text ?? (e.request.postData?.params ?? []).map((p) => `${p.name}=${p.value ?? ''}`).join('&')}`;
}
