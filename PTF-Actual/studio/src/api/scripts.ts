/**
 * Pre-request and test scripts with Postman's `pm` API, run in an isolated context (no file system, process or
 * network except pm.sendRequest), with a time limit:
 *  - variables: pm.variables (local, then the data row, the environment, the collection), pm.environment,
 *    pm.collectionVariables, pm.globals, pm.iterationData: get / set / unset / has / toObject / replaceIn;
 *  - pm.request: url (string, or the parts), method, headers (get / add / upsert / remove), body.raw; changed by a
 *    pre-request script, the request is sent as changed;
 *  - pm.response (test scripts): code, status, responseTime, responseSize, headers.get, json(), text(),
 *    cookies.get; pm.response.to.have.status / header / jsonBody / body, to.be.ok / success / json;
 *  - pm.test(name, fn) and pm.expect (chai); pm.test.skip; failures are the request's checks;
 *  - pm.sendRequest(url or request, callback): a real request, awaited before the script ends;
 *  - pm.execution.setNextRequest(name | null) / postman.setNextRequest: the runner goes on with that request;
 *  - pm.execution.skipRequest() (pre-request), pm.info, console.log / warn / error (kept);
 *  - require: chai, lodash, uuid, ajv, crypto-js-like helpers are not available (only these modules).
 * The Studio's own checks and saved values run as well; scripts are for what they cannot express.
 */
import * as vm from 'vm';
import * as crypto from 'crypto';

export interface ScriptRequest { method: string; url: string; headers: Array<{ key: string; value: string }>; body?: string }
export interface ScriptResponse { status: number; statusText: string; headers: Record<string, string>; body: string; timeMs: number; size: number; cookies?: Array<{ name: string; value: string }> }
export interface ScriptTest { name: string; pass: boolean; skipped?: boolean; error?: string }
export interface ScriptResult {
    tests: ScriptTest[];
    logs: Array<{ level: 'log' | 'info' | 'warn' | 'error'; text: string }>;
    /** A pre-request script changed the request. */
    request: ScriptRequest;
    /** undefined: go on in order; null: stop the run; a name: that request next. */
    nextRequest?: string | null;
    skipRequest?: boolean;
    /** pm.visualizer.set(template, data): a Handlebars template over the response, shown as a page. */
    visualizer?: { template: string; data: unknown; options?: unknown };
    /** The script threw (or timed out). */
    error?: string;
}

/** The variable scopes a script reads and writes (changes are kept by the caller). */
export interface ScriptScopes {
    globals: Record<string, string>;
    collection: Record<string, string>;
    environment: Record<string, string>;
    data: Record<string, string>;
    local: Record<string, string>;
}

export type ScriptSend = (r: ScriptRequest) => Promise<ScriptResponse>;

const MAX_LOG = 200;
const asText = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? 'undefined' : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());

function scope(map: Record<string, string>, name: string) {
    return {
        get: (k: string) => map[k],
        set: (k: string, v: unknown) => { map[k] = typeof v === 'string' ? v : asText(v); },
        unset: (k: string) => { delete map[k]; },
        has: (k: string) => Object.prototype.hasOwnProperty.call(map, k),
        clear: () => { for (const k of Object.keys(map)) delete map[k]; },
        toObject: () => ({ ...map }),
        replaceIn: (t: string) => String(t).replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, k: string) => (map[k] !== undefined ? map[k] : m)),
        name,
    };
}

function headerList(list: Array<{ key: string; value: string }>) {
    const find = (k: string) => list.findIndex((h) => h.key.toLowerCase() === String(k).toLowerCase());
    return {
        get: (k: string) => list[find(k)]?.value,
        has: (k: string) => find(k) >= 0,
        add: (h: { key: string; value: string } | string, v?: string) => { const x = typeof h === 'string' ? { key: h, value: String(v ?? '') } : h; list.push({ key: x.key, value: String(x.value) }); },
        upsert: (h: { key: string; value: string }) => { const i = find(h.key); if (i >= 0) list[i].value = String(h.value); else list.push({ key: h.key, value: String(h.value) }); },
        remove: (k: string) => { let i; while ((i = find(k)) >= 0) list.splice(i, 1); },
        toObject: () => Object.fromEntries(list.map((h) => [h.key, h.value])),
        each: (fn: (h: { key: string; value: string }) => void) => list.forEach(fn),
        all: () => list.map((h) => ({ ...h })),
        count: () => list.length,
    };
}

/** Run one script. `stage`: 'pre' (before the request is sent) or 'test' (after the response). */
export async function runScript(code: string, o: { stage: 'pre' | 'test'; request: ScriptRequest; response?: ScriptResponse; scopes: ScriptScopes; send?: ScriptSend; info?: { requestName: string; iteration: number; requestId?: string }; timeoutMs?: number }): Promise<ScriptResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chai = require('chai') as typeof import('chai');
    const result: ScriptResult = { tests: [], logs: [], request: { ...o.request, headers: o.request.headers.map((h) => ({ ...h })) } };
    const req = result.request;
    const s = o.scopes;
    const pending: Array<Promise<unknown>> = [];
    const log = (level: ScriptResult['logs'][number]['level']) => (...a: unknown[]) => { if (result.logs.length < MAX_LOG) result.logs.push({ level, text: a.map(asText).join(' ').slice(0, 4000) }); };
    const asyncTests: Array<Promise<void>> = [];

    const test = (name: string, fn: () => unknown) => {
        try {
            const r = fn?.();
            if (r && typeof (r as Promise<unknown>).then === 'function') {
                asyncTests.push((r as Promise<unknown>).then(() => { result.tests.push({ name, pass: true }); }, (e: Error) => { result.tests.push({ name, pass: false, error: e?.message ?? String(e) }); }));
            } else result.tests.push({ name, pass: true });
        } catch (e) { result.tests.push({ name, pass: false, error: (e as Error)?.message ?? String(e) }); }
    };
    (test as unknown as { skip: (n: string) => void }).skip = (name: string) => { result.tests.push({ name, pass: true, skipped: true }); };

    const variables = {
        ...scope(s.local, 'local'),
        // pm.variables.get: the closest scope that has the name (local, data, environment, collection, global).
        get: (k: string) => s.local[k] ?? s.data[k] ?? s.environment[k] ?? s.collection[k] ?? s.globals[k],
        has: (k: string) => [s.local, s.data, s.environment, s.collection, s.globals].some((m) => k in m),
        toObject: () => ({ ...s.globals, ...s.collection, ...s.environment, ...s.data, ...s.local }),
        replaceIn: (t: string) => String(t).replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, k: string) => (s.local[k] ?? s.data[k] ?? s.environment[k] ?? s.collection[k] ?? s.globals[k] ?? m)),
    };

    const u = () => new URL(req.url.replace(/\{\{[^}]+\}\}/g, 'x'), 'http://placeholder');
    const request = {
        get method() { return req.method; }, set method(m: string) { req.method = String(m).toUpperCase(); },
        get url() {
            return {
                toString: () => req.url,
                getHost: () => { try { return u().hostname; } catch { return ''; } },
                getPath: () => { try { return u().pathname; } catch { return ''; } },
                getQueryString: () => req.url.split('?')[1] ?? '',
                query: { get: (k: string) => { try { return new URL(req.url).searchParams.get(k); } catch { return null; } }, toObject: () => { try { return Object.fromEntries(new URL(req.url).searchParams); } catch { return {}; } } },
                update: (v: string) => { req.url = String(v); },
                addQueryParams: (p: string | Array<{ key: string; value: string }>) => {
                    const add = typeof p === 'string' ? p : p.map((x) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value)}`).join('&');
                    req.url += (req.url.includes('?') ? '&' : '?') + add;
                },
            };
        },
        set url(v: unknown) { req.url = String(v); },
        headers: headerList(req.headers),
        get body() { return { raw: req.body ?? '', mode: 'raw', toString: () => req.body ?? '', update: (v: unknown) => { req.body = typeof v === 'string' ? v : asText((v as { raw?: unknown })?.raw ?? v); } }; },
        set body(v: unknown) { req.body = typeof v === 'string' ? v : asText((v as { raw?: unknown })?.raw ?? v); },
    };

    let response: unknown;
    if (o.response) {
        const r = o.response;
        const lower = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
        const json = () => { try { return JSON.parse(r.body); } catch { throw new Error(`The response is not JSON: ${r.body.slice(0, 80)}`); } };
        const has = {
            status: (x: number | string) => { if (typeof x === 'number') chai.expect(r.status, 'status').to.equal(x); else chai.expect(r.statusText, 'status text').to.equal(x); },
            header: (k: string, v?: string) => { chai.expect(lower, `header ${k}`).to.have.property(k.toLowerCase()); if (v !== undefined) chai.expect(lower[k.toLowerCase()]).to.equal(v); },
            jsonBody: (p?: string, v?: unknown) => { const j = json(); if (p !== undefined) { const val = p.split('.').reduce((a: any, k) => a?.[k], j); if (v === undefined) chai.expect(val, p).to.not.equal(undefined); else chai.expect(val).to.deep.equal(v); } }, // eslint-disable-line @typescript-eslint/no-explicit-any
            body: (x?: string | RegExp) => { if (x === undefined) chai.expect(r.body.length).to.be.greaterThan(0); else if (x instanceof RegExp) chai.expect(r.body).to.match(x); else chai.expect(r.body).to.equal(x); },
            responseTime: { below: (ms: number) => chai.expect(r.timeMs).to.be.below(ms), above: (ms: number) => chai.expect(r.timeMs).to.be.above(ms) },
        };
        const to = {
            have: has,
            be: {
                get ok() { chai.expect(r.status, 'status').to.be.within(200, 299); return true; },
                get success() { chai.expect(r.status, 'status').to.be.within(200, 299); return true; },
                get json() { json(); return true; },
                get clientError() { chai.expect(r.status).to.be.within(400, 499); return true; },
                get serverError() { chai.expect(r.status).to.be.within(500, 599); return true; },
                get notFound() { chai.expect(r.status).to.equal(404); return true; },
            },
            not: { have: { status: (x: number) => chai.expect(r.status).to.not.equal(x), header: (k: string) => chai.expect(lower).to.not.have.property(k.toLowerCase()) } },
        };
        response = {
            code: r.status, status: r.statusText, responseTime: r.timeMs, responseSize: r.size,
            headers: { get: (k: string) => lower[String(k).toLowerCase()], has: (k: string) => String(k).toLowerCase() in lower, toObject: () => ({ ...r.headers }), all: () => Object.entries(r.headers).map(([key, value]) => ({ key, value })) },
            cookies: { get: (n: string) => r.cookies?.find((c) => c.name === n)?.value, has: (n: string) => !!r.cookies?.some((c) => c.name === n), toObject: () => Object.fromEntries((r.cookies ?? []).map((c) => [c.name, c.value])) },
            json, text: () => r.body,
            to, have: has,
        };
    }

    const sendRequest = (x: string | { url: string; method?: string; header?: Array<{ key: string; value: string }> | Record<string, string>; body?: { mode?: string; raw?: string } }, cb?: (err: Error | null, res: unknown) => void) => {
        if (!o.send) throw new Error('pm.sendRequest is not available here.');
        const r: ScriptRequest = typeof x === 'string' ? { method: 'GET', url: x, headers: [] }
            : { method: (x.method ?? 'GET').toUpperCase(), url: x.url, headers: Array.isArray(x.header) ? x.header : Object.entries(x.header ?? {}).map(([key, value]) => ({ key, value: String(value) })), body: x.body?.raw };
        const p = o.send(r).then((res) => {
            const lower = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
            const view = { code: res.status, status: res.statusText, responseTime: res.timeMs, headers: { get: (k: string) => lower[k.toLowerCase()] }, json: () => JSON.parse(res.body), text: () => res.body };
            cb?.(null, view);
            return view;
        }, (e: Error) => { cb?.(e, undefined); throw e; });
        pending.push(p.catch(() => undefined));
        return p;
    };

    const execution = {
        setNextRequest: (n: string | null) => { result.nextRequest = n === null ? null : String(n); },
        skipRequest: () => { if (o.stage === 'pre') result.skipRequest = true; },
        location: { current: o.info?.requestName ?? '' },
    };
    const allowed: Record<string, unknown> = { chai, lodash: require('lodash'), ajv: require('ajv'), uuid: { v4: () => crypto.randomUUID() } };
    const pm = {
        variables, environment: scope(s.environment, 'environment'), collectionVariables: scope(s.collection, 'collection'), globals: scope(s.globals, 'globals'), iterationData: scope(s.data, 'data'),
        request, response, test, expect: chai.expect, sendRequest, execution,
        visualizer: { set: (template: string, data?: unknown, options?: unknown) => { if (o.stage === 'test') result.visualizer = { template: String(template ?? ''), data: JSON.parse(JSON.stringify(data ?? {})), ...(options ? { options } : {}) }; }, clear: () => { delete result.visualizer; } },
        info: { requestName: o.info?.requestName ?? '', requestId: o.info?.requestId ?? '', iteration: o.info?.iteration ?? 0, eventName: o.stage === 'pre' ? 'prerequest' : 'test' },
    };
    const ctx = vm.createContext({
        pm, postman: { setNextRequest: execution.setNextRequest, setEnvironmentVariable: (k: string, v: unknown) => pm.environment.set(k, v), getEnvironmentVariable: (k: string) => pm.environment.get(k), setGlobalVariable: (k: string, v: unknown) => pm.globals.set(k, v), getGlobalVariable: (k: string) => pm.globals.get(k) },
        console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('log') },
        require: (m: string) => { if (m in allowed) return allowed[m]; throw new Error(`require('${m}') is not available in Studio scripts (available: ${Object.keys(allowed).join(', ')}).`); },
        _: allowed.lodash, JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Error, Promise, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
        atob: (b: string) => Buffer.from(b, 'base64').toString('latin1'), btoa: (t: string) => Buffer.from(t, 'latin1').toString('base64'),
        setTimeout: (f: () => void, ms: number) => { const p = new Promise<void>((r) => setTimeout(() => { try { f(); } finally { r(); } }, Math.min(ms, 10_000))); pending.push(p); return 0; },
        // Old Postman globals still found in imported scripts.
        responseBody: o.response?.body, responseCode: o.response ? { code: o.response.status, name: o.response.statusText } : undefined, responseTime: o.response?.timeMs,
        tests: new Proxy({}, { set: (_t, k, v) => { result.tests.push({ name: String(k), pass: !!v }); return true; } }),
    });
    try {
        new vm.Script(code, { filename: o.stage === 'pre' ? 'pre-request.js' : 'tests.js' }).runInContext(ctx, { timeout: o.timeoutMs ?? 5000 });
        // Requests and timers the script started, then its async tests (bounded by the same limit).
        const limit = new Promise((_r, rej) => setTimeout(() => rej(new Error('The script did not finish in time (pm.sendRequest / setTimeout).')), (o.timeoutMs ?? 5000) + 25_000));
        await Promise.race([Promise.all(pending).then(() => Promise.all(asyncTests)), limit]);
    } catch (e) {
        result.error = (e as Error)?.message ?? String(e);
    }
    return result;
}

// ---------------------------------------------------------------- with the Studio's requests

import type { ApiCollection, ApiRequest } from './model';
import { graphqlJson } from './model';
import type { ApiResponse, CheckResult, PreparedRequest, Values } from './send';
import { fill } from './send';

/** The collection's base URL as the variable baseUrl (as Postman collections name it), when no variable has that name. */
function withBase(sc: ScriptScopes, c: Pick<ApiCollection, 'baseUrl'>, v: Values): ScriptScopes {
    if (c.baseUrl && sc.collection.baseUrl === undefined) sc.collection.baseUrl = fill(c.baseUrl, v).replace(/\/+$/, '');
    return sc;
}

/** The scopes as a script sees them (globals are kept by the caller across requests). */
export function scopesFor(v: Values, globals: Record<string, string>): ScriptScopes {
    // The environment: the configuration, and what scripts set earlier in the run (kept with the saved values).
    return { globals, collection: { ...v.vars }, environment: { ...v.config, ...v.vars }, data: { ...(v.row ?? {}) }, local: {} };
}

/** What scripts set goes where {{name}} finds it: the saved values (environment, collection and local sets), the globals. */
function keep(v: Values, before: ScriptScopes, after: ScriptScopes) {
    for (const [k, x] of Object.entries(after.environment)) if (before.environment[k] !== x) v.vars[k] = x;
    for (const k of Object.keys(before.environment)) if (!(k in after.environment)) delete v.vars[k];
    for (const [k, x] of Object.entries(after.collection)) if (before.collection[k] !== x) v.vars[k] = x;
    for (const k of Object.keys(before.collection)) if (!(k in after.collection)) delete v.vars[k];
    for (const [k, x] of Object.entries(after.local)) v.vars[k] = x;
}

/** {{name}} also finds the scripts' globals (lowest scope, as in Postman). */
export function withGlobals(v: Values, globals: Record<string, string>): Values {
    return Object.keys(globals).length ? { ...v, vars: { ...globals, ...v.vars } } : v;
}

export interface PreOutcome { request: ApiRequest; logs: ScriptResult['logs']; skip: boolean; next?: string | null; tests: ScriptTest[]; error?: string }

/**
 * The collection's and the request's pre-request scripts: variables they set are used by the request; a changed
 * URL, method, header or body is what is sent. The request as scripts see it: its URL after the base URL.
 */
export async function runPreScripts(c: Pick<ApiCollection, 'baseUrl' | 'scripts'>, r: ApiRequest, v: Values, globals: Record<string, string>, send?: ScriptSend, iteration = 0): Promise<PreOutcome> {
    const codes = [c.scripts?.pre, r.scripts?.pre].filter((x): x is string => !!x?.trim());
    if (!codes.length) return { request: r, logs: [], skip: false, tests: [] };
    const bodyIn = r.body.mode === 'graphql' ? graphqlJson(r.body.graphql) : r.body.text;
    let sreq: ScriptRequest = { method: r.method, url: r.url, headers: r.headers.filter((h) => h.enabled !== false && h.key).map((h) => ({ key: h.key, value: h.value })), body: bodyIn };
    const out: PreOutcome = { request: r, logs: [], skip: false, tests: [] };
    for (const code of codes) {
        const before = withBase(scopesFor(v, globals), c, v);
        const sc: ScriptScopes = JSON.parse(JSON.stringify(before));
        sc.globals = globals;
        const res = await runScript(code, { stage: 'pre', request: sreq, scopes: sc, send, info: { requestName: r.name, requestId: r.id, iteration } });
        keep(v, before, sc);
        out.logs.push(...res.logs); out.tests.push(...res.tests);
        if (res.nextRequest !== undefined) out.next = res.nextRequest;
        if (res.skipRequest) out.skip = true;
        if (res.error) { out.error = `Pre-request script: ${res.error}`; break; }
        sreq = res.request;
    }
    const changedHeaders = JSON.stringify(sreq.headers) !== JSON.stringify(r.headers.filter((h) => h.enabled !== false && h.key).map((h) => ({ key: h.key, value: h.value })));
    if (sreq.url !== r.url || sreq.method !== r.method || changedHeaders || sreq.body !== bodyIn) {
        out.request = { ...r, method: sreq.method as ApiRequest['method'], url: sreq.url, headers: changedHeaders ? sreq.headers.map((h) => ({ ...h })) : r.headers,
            body: sreq.body !== bodyIn ? { ...r.body, mode: r.body.mode === 'none' ? 'text' : r.body.mode === 'graphql' ? 'json' : r.body.mode, text: sreq.body } : r.body };
    }
    return out;
}

export interface TestOutcome { checks: CheckResult[]; logs: ScriptResult['logs']; next?: string | null; error?: string; visualizer?: ScriptResult['visualizer'] }

/** The request's and the collection's test scripts over the response: each pm.test a check. */
export async function runTestScripts(c: Pick<ApiCollection, 'scripts' | 'baseUrl'>, r: ApiRequest, p: PreparedRequest, res: ApiResponse, v: Values, globals: Record<string, string>, send?: ScriptSend, iteration = 0): Promise<TestOutcome> {
    const codes = [c.scripts?.test, r.scripts?.test].filter((x): x is string => !!x?.trim());
    if (!codes.length) return { checks: [], logs: [] };
    const sreq: ScriptRequest = { method: p.method, url: p.url, headers: Object.entries(p.headers).map(([key, value]) => ({ key, value })), body: typeof p.body === 'string' ? p.body : undefined };
    const sres: ScriptResponse = { status: res.status, statusText: res.statusText, headers: res.headers, body: res.body, timeMs: res.timeMs, size: res.size,
        cookies: (res.setCookies ?? []).map((l) => { const [nv] = l.split(';'); const i = nv.indexOf('='); return { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim() }; }) };
    const out: TestOutcome = { checks: [], logs: [] };
    for (const code of codes) {
        const before = withBase(scopesFor(v, globals), c, v);
        const sc: ScriptScopes = JSON.parse(JSON.stringify(before));
        sc.globals = globals;
        const x = await runScript(code, { stage: 'test', request: sreq, response: sres, scopes: sc, send, info: { requestName: r.name, requestId: r.id, iteration } });
        keep(v, before, sc);
        out.logs.push(...x.logs);
        if (x.nextRequest !== undefined) out.next = x.nextRequest;
        if (x.visualizer) out.visualizer = x.visualizer;
        out.checks.push(...x.tests.filter((t) => !t.skipped).map((t): CheckResult => ({ check: { kind: 'script', target: t.name }, pass: t.pass, message: t.name, ...(t.error ? { actual: t.error } : {}) })));
        if (x.error) { out.error = `Test script: ${x.error}`; out.checks.push({ check: { kind: 'script', target: 'script error' }, pass: false, message: 'The test script failed', actual: x.error }); }
    }
    return out;
}

/** pm.sendRequest through the Studio's own sending (network settings, certificates). */
export function scriptSender(sendFn: (p: PreparedRequest) => Promise<ApiResponse>): ScriptSend {
    return async (r) => {
        const res = await sendFn({ method: r.method, url: r.url, headers: Object.fromEntries(r.headers.map((h) => [h.key, h.value])), body: r.body, missing: [] });
        return { status: res.status, statusText: res.statusText, headers: res.headers, body: res.body, timeMs: res.timeMs, size: res.size };
    };
}

/**
 * A visualizer page: the Handlebars template over its data (as Postman renders pm.visualizer.set), in a page of its
 * own. The Studio shows it in a sandboxed frame (no access to the Studio or its sign-in); scripts and styles of the
 * template run there.
 */
export function renderVisualizer(v: NonNullable<ScriptResult['visualizer']>): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Handlebars = require('handlebars') as typeof import('handlebars');
    const h = Handlebars.create();
    let body: string;
    try { body = h.compile(v.template)(v.data); }
    catch (e) { body = `<pre style="color:#cf222e">The visualizer template does not compile: ${String((e as Error).message).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</pre>`; }
    // pm.getData(callback) inside the template's scripts, as in Postman.
    const data = JSON.stringify(v.data ?? {}).replace(/</g, '\\u003c');
    return `<!doctype html><html><head><meta charset="utf-8"><script>window.pm={getData:function(cb){cb(null, ${data});}};</script></head><body>${body}</body></html>`;
}
