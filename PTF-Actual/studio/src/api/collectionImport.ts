/**
 * Import of a collection file in the common v2.0 / v2.1 JSON format (with its environment file),
 * as exported by API clients.
 *
 *
 *  - Folders, requests, URL (raw, or host/path/query objects), path variables (:id), headers,
 *    bodies (raw JSON/XML/text, x-www-form-urlencoded, form-data text fields, GraphQL), auth
 *    (basic, bearer, API key; collection/folder level inherited), variables, descriptions.
 *  - Test scripts: the common lines become checks and saved values —
 *      pm.response.to.have.status(201)           → status 201
 *      pm.expect(pm.response.code).to.eql(200)   → status 200
 *      pm.expect(pm.response.responseTime).to.be.below(500) → time below 500 ms
 *      pm.expect(pm.response.text()).to.include("x")         → body contains "x"
 *      pm.response.to.have.header("X")           → header X exists
 *      pm.expect(json.a.b).to.eql(5) / .equal / .to.be.true  → JSON path $.a.b is 5
 *      pm.expect(json).to.have.property("x")     → JSON path $.x exists
 *      pm.environment.set("k", json.a[0].id) (or collectionVariables / globals / variables)
 *                                                 → save $.a[0].id as k
 *      pm.environment.set("k", pm.response.headers.get("X")) → save header X as k
 *    Everything else is kept as a note on the request (and a comment in the feature): nothing is
 *    dropped silently. Pre-request scripts are listed the same way.
 *  - Secrets: environment values of type "secret" are not written to the collection; they become
 *    {env:NAME} references and are returned separately so the Studio can offer to store them.
 */
import { ApiAuth, ApiBody, ApiCheck, ApiCollection, ApiExtract, ApiFolder, ApiItem, ApiRequest, httpMethod, KV, MultipartPart, newCollection, randomId } from './model';

type CfKV = { key?: string; value?: unknown; disabled?: boolean; type?: string; description?: unknown; enabled?: boolean };
interface CfUrl { raw?: string; protocol?: string; host?: string | string[]; path?: string | string[]; query?: CfKV[]; variable?: CfKV[] }
interface CfAuth { type?: string; [k: string]: unknown }
interface CfEvent { listen?: string; script?: { exec?: string | string[] } }
interface CfRequest { method?: string; url?: string | CfUrl; header?: CfKV[] | string; body?: { mode?: string; raw?: string; urlencoded?: CfKV[]; formdata?: CfKV[]; graphql?: { query?: string; variables?: string }; options?: { raw?: { language?: string } } }; auth?: CfAuth; description?: unknown }
interface CfResponse { name?: string; code?: number; status?: string; header?: CfKV[] | string; body?: string; originalRequest?: CfRequest; _postman_previewlanguage?: string }
interface CfItem { name?: string; item?: CfItem[]; request?: CfRequest | string; event?: CfEvent[]; description?: unknown; auth?: CfAuth; response?: CfResponse[]; protocolProfileBehavior?: { followRedirects?: boolean; strictSSL?: boolean } }
interface CfCollection { info?: { name?: string; schema?: string; description?: unknown }; item?: CfItem[]; variable?: CfKV[]; auth?: CfAuth; event?: CfEvent[] }

export interface ImportReport {
    requests: number;
    folders: number;
    /** Script lines turned into checks / saved values. */
    converted: number;
    /** Lines kept as notes (not converted). */
    notConverted: number;
    /** Things worth knowing (file uploads, unsupported auth…). */
    warnings: string[];
    /** Secret values found (name → value): to be stored as Studio secrets, never in the file. */
    secrets: Record<string, string>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { content?: unknown }).content === 'string' ? (v as { content: string }).content : '');
const str = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const kv = (list: CfKV[] | undefined): KV[] => (list ?? []).filter((x) => x && typeof x.key === 'string').map((x) => ({ key: x.key!, value: str(x.value), ...(x.disabled ? { enabled: false } : {}), ...(text(x.description) ? { description: text(x.description) } : {}) }));

/** A variable name usable as {env:NAME} (secret store names: letters, digits, _). */
export const secretName = (k: string) => k.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

export function isCollectionFile(x: unknown): x is CfCollection {
    const c = x as CfCollection;
    return !!c && typeof c === 'object' && Array.isArray(c.item) && !!c.info && (typeof c.info.schema !== 'string' || /getpostman\.com\/json\/collection\/v2/.test(c.info.schema));
}

export function importCollection(json: unknown, env?: unknown): { collection: ApiCollection; report: ImportReport } {
    if (!isCollectionFile(json)) throw new Error('This is not a collection file in the v2.0 / v2.1 format. Export the collection as "Collection v2.1".');
    const report: ImportReport = { requests: 0, folders: 0, converted: 0, notConverted: 0, warnings: [], secrets: {} };
    const c = newCollection(json.info?.name?.trim() || 'Imported collection');
    const desc = text(json.info?.description);
    if (desc) c.description = desc;
    c.variables = kv(json.variable).map((v) => ({ ...v }));
    if (json.auth) c.auth = auth(json.auth, report, 'collection');
    if (env !== undefined) applyEnvironment(c, env, report);
    // The collection's own scripts run around every request (as in Postman).
    const cPre = rawScript(json.event, 'prerequest'), cTest = rawScript(json.event, 'test');
    if (cPre || cTest) c.scripts = { ...(cPre ? { pre: cPre } : {}), ...(cTest ? { test: cTest } : {}) };
    c.items = items(json.item ?? [], report, { type: 'inherit' });
    // A base URL every request starts with ({{baseUrl}}/…) becomes the collection's base URL.
    const prefix = commonVarPrefix(c.items);
    if (prefix) {
        const v = c.variables.find((x) => x.key === prefix);
        if (v && /^https?:\/\//.test(v.value)) {
            c.baseUrl = v.value;
            stripPrefix(c.items, `{{${prefix}}}`);
            c.variables = c.variables.filter((x) => x.key !== prefix);
        }
    }
    return { collection: c, report };
}

/** An environment file: its values become collection variables (secrets as {env:NAME}). */
export function applyEnvironment(c: ApiCollection, env: unknown, report: ImportReport): void {
    const e = env as { values?: Array<CfKV & { type?: string }>; name?: string };
    if (!e || !Array.isArray(e.values)) throw new Error('This is not an environment file (it has no "values").');
    for (const v of e.values) {
        if (!v || typeof v.key !== 'string' || v.enabled === false) continue;
        const secret = v.type === 'secret' || /pass(word)?|secret|token|api[_-]?key|client[_-]?secret/i.test(v.key);
        const value = secret ? `{env:${secretName(v.key)}}` : str(v.value);
        if (secret && str(v.value)) report.secrets[secretName(v.key)] = str(v.value);
        const i = c.variables.findIndex((x) => x.key === v.key);
        const entry = { key: v.key, value, ...(secret ? { secret: true } : {}) };
        if (i >= 0) c.variables[i] = entry; else c.variables.push(entry);
    }
}

function items(list: CfItem[], report: ImportReport, parentAuth: ApiAuth): ApiItem[] {
    const out: ApiItem[] = [];
    for (const it of list) {
        if (Array.isArray(it.item)) {
            report.folders++;
            const folderAuth = it.auth ? auth(it.auth, report, `folder "${it.name}"`) : parentAuth;
            const f: ApiFolder = { kind: 'folder', id: randomId(), name: it.name?.trim() || 'Folder', items: items(it.item, report, folderAuth) };
            const d = text(it.description);
            if (d) f.description = d;
            out.push(f);
        } else if (it.request !== undefined) {
            report.requests++;
            out.push(request(it, report, parentAuth));
        }
    }
    return out;
}

function request(it: CfItem, report: ImportReport, inherited: ApiAuth): ApiRequest {
    const pr: CfRequest = typeof it.request === 'string' ? { method: 'GET', url: it.request } : it.request ?? {};
    const name = it.name?.trim() || 'Request';
    const method = httpMethod(pr.method ?? 'GET');
    const r: ApiRequest = { kind: 'request', id: randomId(), name, method: method ?? 'GET', url: '', query: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, checks: [], extract: [] };
    if (!method) report.warnings.push(`"${name}": "${String(pr.method)}" is not an HTTP method; imported as GET.`);
    const d = text(pr.description) || text(it.description);
    if (d) r.description = d;
    // URL
    const u = pr.url;
    if (typeof u === 'string') splitUrl(u, r);
    else if (u) {
        if (u.raw) splitUrl(u.raw, r);
        else {
            const host = Array.isArray(u.host) ? u.host.join('.') : u.host ?? '';
            const path = Array.isArray(u.path) ? u.path.join('/') : u.path ?? '';
            r.url = `${u.protocol ? `${u.protocol}://` : ''}${host}${path ? `/${path}` : ''}`;
        }
        if (Array.isArray(u.query)) r.query = kv(u.query);
        // :id path variables → their value (or {{id}})
        for (const pv of u.variable ?? []) if (pv.key) r.url = r.url.replace(new RegExp(`:${pv.key}(?=/|$|\\?)`), str(pv.value) || `{{${pv.key}}}`);
    }
    r.headers = Array.isArray(pr.header) ? kv(pr.header) : typeof pr.header === 'string' ? pr.header.split('\n').map((l) => l.split(/:(.*)/s)).filter((p) => p[0]?.trim()).map((p) => ({ key: p[0].trim(), value: (p[1] ?? '').trim() })) : [];
    r.body = body(pr.body, report, name);
    r.auth = pr.auth ? auth(pr.auth, report, `"${name}"`) : inherited.type === 'inherit' ? { type: 'inherit' } : inherited;
    // Scripts
    const tests = scriptLines(it.event, 'test');
    const pre = scriptLines(it.event, 'prerequest');
    const conv = convertTests(tests);
    r.checks = conv.checks;
    r.extract = conv.extract;
    report.converted += conv.converted;
    // A script the Studio cannot turn into checks completely runs as it is (pm API): kept whole, without the
    // checks made from part of it (they would run twice). The Studio's own exported checks stay checks.
    const preRaw = rawScript(it.event, 'prerequest');
    const testRaw = rawScript(it.event, 'test', true);
    // Lines that only log do not make a script worth keeping (the checks made from it are kept).
    const meaningful = conv.notes.filter((l) => !/^console\.\w+\(.*\);?$/.test(l.trim()));
    if (meaningful.length && testRaw) {
        const marked = convertTests(tests.filter((l, i, all) => isMarkedLine(all, i)));
        r.checks = marked.checks; r.extract = marked.extract;
        report.converted -= conv.converted - marked.converted;
    }
    if (preRaw || (meaningful.length && testRaw)) r.scripts = { ...(preRaw ? { pre: preRaw } : {}), ...(meaningful.length && testRaw ? { test: testRaw } : {}) };
    if (!meaningful.length && conv.notes.length) { r.notes = conv.notes.map((l) => `Test script not converted: ${l}`).slice(0, 50); report.notConverted += conv.notes.length; }
    void pre;
    // A plain collection: at least a status check. One exported by the Studio comes back exactly as it was.
    if (!tests.some((l) => l.startsWith('// cs-studio:')) && !r.scripts?.test && !r.checks.some((c) => c.kind === 'status' || c.kind === 'statusBetween')) r.checks.unshift({ kind: 'statusBetween', min: 200, max: 299 });
    // Postman's per-request settings.
    const ppb = it.protocolProfileBehavior;
    if (ppb && (ppb.followRedirects === false || ppb.strictSSL === false)) r.settings = { ...(ppb.followRedirects === false ? { followRedirects: false } : {}), ...(ppb.strictSSL === false ? { insecure: true } : {}) };
    // Saved responses → examples (with the query of the request they answer).
    const ex = (it.response ?? []).filter((x) => x && typeof x === 'object');
    if (ex.length) r.examples = ex.slice(0, 100).map((x, n) => {
        const hs = Array.isArray(x.header) ? x.header : [];
        const ou = x.originalRequest?.url;
        const q: CfKV[] = typeof ou === 'object' && Array.isArray(ou?.query) ? ou.query : typeof ou === 'string' && ou.includes('?') ? ou.split('?')[1].split('&').map((p) => { const [k, ...v] = p.split('='); return { key: decodeURIComponent(k), value: decodeURIComponent(v.join('=')) }; }) : [];
        const qm = Object.fromEntries(q.filter((p) => p.key && !p.disabled).map((p) => [String(p.key), String(p.value ?? '')]));
        const ob = x.originalRequest?.body?.mode === 'raw' ? x.originalRequest.body.raw : undefined;
        return { id: randomId(), name: x.name?.trim() || `Example ${n + 1}`, status: Number.isInteger(x.code) ? x.code! : 200,
            ...(hs.length ? { headers: Object.fromEntries(hs.filter((h) => h.key).map((h) => [String(h.key), String(h.value ?? '')])) } : {}),
            ...(x.body !== undefined ? { body: String(x.body) } : {}),
            ...(Object.keys(qm).length || ob ? { when: { ...(Object.keys(qm).length ? { query: qm } : {}), ...(ob ? { body: ob } : {}) } } : {}) };
    });
    return r;
}

function splitUrl(raw: string, r: ApiRequest) {
    const i = raw.indexOf('?');
    r.url = (i >= 0 ? raw.slice(0, i) : raw).trim();
    if (i >= 0 && !r.query.length) {
        r.query = raw.slice(i + 1).split('&').filter(Boolean).map((p) => {
            const [k, v = ''] = p.split(/=(.*)/s);
            const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
            return { key: dec(k), value: dec(v) };
        });
    }
}

function body(b: CfRequest['body'], report: ImportReport, name: string): ApiBody {
    if (!b || !b.mode) return { mode: 'none' };
    if (b.mode === 'raw') {
        const lang = b.options?.raw?.language;
        const t = b.raw ?? '';
        if (!t.trim()) return { mode: 'none' };
        const mode = lang === 'json' || (!lang && /^\s*[[{]/.test(t)) ? 'json' : lang === 'xml' ? 'xml' : 'text';
        return { mode, text: t };
    }
    if (b.mode === 'urlencoded') return { mode: 'form', form: kv(b.urlencoded) };
    if (b.mode === 'formdata') {
        // multipart/form-data. A file part keeps its name; the file is chosen from the project's payload folder.
        const list = (b.formdata ?? []).filter((x) => x && typeof x.key === 'string');
        const files = list.filter((x) => x.type === 'file');
        if (files.length) report.warnings.push(`"${name}": ${files.length} file field(s): put the file(s) in the project's payload folder and choose them in the body.`);
        // A file field with several files (src: [a, b]) is one part per file, all with the field's name.
        return { mode: 'multipart', parts: list.flatMap((x): MultipartPart[] => {
            const src = (x as { src?: unknown }).src;
            const off = x.disabled ? { enabled: false } : {};
            if (x.type !== 'file') return [{ key: x.key!, value: str(x.value), type: 'text' as const, ...off }];
            const srcs = Array.isArray(src) ? src.map((f) => String(f ?? '')) : [typeof src === 'string' ? src : str(x.value)];
            return (srcs.length ? srcs : ['']).map((file) => ({ key: x.key!, value: file.split(/[\\/]/).pop() ?? '', type: 'file' as const, ...off }));
        }) };
    }
    if (b.mode === 'graphql') {
        return { mode: 'graphql', graphql: { query: b.graphql?.query ?? '', ...(b.graphql?.variables?.trim() ? { variables: b.graphql.variables } : {}) } };
    }
    report.warnings.push(`"${name}": body type "${b.mode}" is not imported.`);
    return { mode: 'none' };
}

function auth(a: CfAuth, report: ImportReport, where: string): ApiAuth {
    const get = (k: string): string => {
        const v = a[a.type ?? ''] as unknown;
        if (Array.isArray(v)) return str((v as CfKV[]).find((x) => x.key === k)?.value);
        if (v && typeof v === 'object') return str((v as Record<string, unknown>)[k]);
        return '';
    };
    switch (a.type) {
        case 'noauth': return { type: 'none' };
        case 'basic': return { type: 'basic', username: get('username'), password: get('password') };
        case 'bearer': return { type: 'bearer', token: get('token') };
        case 'apikey': return { type: 'apikey', key: get('key') || 'X-API-Key', value: get('value'), in: get('in') === 'query' ? 'query' : 'header' };
        case 'ntlm': return { type: 'ntlm', username: get('username'), password: get('password'), ...(get('domain') ? { domain: get('domain') } : {}), ...(get('workstation') ? { workstation: get('workstation') } : {}) };
        case 'digest': return { type: 'digest', username: get('username'), password: get('password') };
        case 'oauth2': {
            // Postman's default grant (none stored) is the authorization code.
            const grant = get('grant_type') || 'authorization_code';
            const common = { tokenUrl: get('accessTokenUrl'), clientId: get('clientId'), clientSecret: get('clientSecret'), ...(get('scope') ? { scope: get('scope') } : {}) };
            if (grant === 'authorization_code' || grant === 'authorization_code_with_pkce') return { type: 'oauth2', grant: 'authorization_code', ...common, authUrl: get('authUrl'), ...(grant === 'authorization_code' && get('challengeAlgorithm') === '' ? { pkce: false } : {}), ...(get('refreshToken') ? { refreshToken: get('refreshToken') } : {}) };
            if (grant === 'implicit') return { type: 'oauth2', grant: 'implicit', authUrl: get('authUrl'), clientId: get('clientId'), ...(get('scope') ? { scope: get('scope') } : {}) };
            if (grant !== 'client_credentials' && grant !== 'password_credentials') {
                report.warnings.push(`${where}: OAuth 2.0 "${grant}" is not a grant the Studio knows; set the token with a Bearer value.`);
                return { type: 'none' };
            }
            return { type: 'oauth2', grant: grant === 'password_credentials' ? 'password' : 'client_credentials', ...common, ...(grant === 'password_credentials' ? { username: get('username'), password: get('password') } : {}) };
        }
        case 'awsv4': return { type: 'aws', accessKey: get('accessKey'), secretKey: get('secretKey'), region: get('region') || 'us-east-1', service: get('service') || 'execute-api', ...(get('sessionToken') ? { sessionToken: get('sessionToken') } : {}) };
        case 'oauth1': return { type: 'oauth1', consumerKey: get('consumerKey'), consumerSecret: get('consumerSecret'), ...(get('token') ? { token: get('token') } : {}), ...(get('tokenSecret') ? { tokenSecret: get('tokenSecret') } : {}), signatureMethod: (['HMAC-SHA1', 'HMAC-SHA256', 'RSA-SHA1', 'PLAINTEXT'].includes(get('signatureMethod')) ? get('signatureMethod') : 'HMAC-SHA1') as ApiAuth['signatureMethod'], ...(get('realm') ? { realm: get('realm') } : {}), ...(get('privateKey') ? { privateKey: get('privateKey') } : {}) };
        case 'hawk': return { type: 'hawk', hawkId: get('authId'), hawkKey: get('authKey'), algorithm: get('algorithm') === 'sha1' ? 'sha1' : 'sha256', ...(get('ext') ? { ext: get('ext') } : {}), ...(get('includePayloadHash') === 'true' ? { payloadHash: true } : {}) };
        case 'edgegrid': return { type: 'edgegrid', clientToken: get('clientToken'), clientSecret: get('clientSecret'), accessToken: get('accessToken') };
        case 'jwt': {
            const alg = get('algorithm') || 'HS256';
            if (get('isSecretBase64Encoded') === 'true') report.warnings.push(`${where}: the JWT secret is Base64 in Postman; the Studio uses the secret as written (decode it, or give the raw secret).`);
            return { type: 'jwt', algorithm: alg, ...(/^HS/.test(alg) ? { secret: get('secret') } : { privateKey: get('privateKey') }), payload: get('payload') || '{}', ...(get('header') && get('header') !== '{}' ? { jwtHeader: get('header') } : {}), ...(get('addTokenTo') === 'queryParam' ? { queryKey: get('queryParamKey') || 'token' } : get('headerPrefix') && get('headerPrefix') !== 'Bearer' ? { prefix: get('headerPrefix') } : {}) };
        }
        case 'asap': return { type: 'asap', issuer: get('iss'), audience: get('aud'), keyId: get('kid'), privateKey: get('privateKey'), ...(get('sub') ? { subject: get('sub') } : {}), ...(get('alg') ? { algorithm: get('alg') } : {}), ...(get('exp') ? { expiresIn: Math.min(3600, Number(get('exp').replace(/s$/, '')) || 60) } : {}) };
        case undefined: case 'inherit': return { type: 'inherit' };
        default:
            report.warnings.push(`${where}: "${a.type}" authentication is not imported; set it up with the framework's authentication steps.`);
            return { type: 'none' };
    }
}

/** A script as written (all its lines, comments too); without the Studio's exported blocks when asked. '' when none. */
function rawScript(events: CfEvent[] | undefined, listen: string, withoutStudioBlocks = false): string {
    const lines: string[] = [];
    for (const e of events ?? []) {
        if (e?.listen !== listen) continue;
        const exec = e.script?.exec;
        lines.push(...(Array.isArray(exec) ? exec : typeof exec === 'string' ? exec.split('\n') : []).map((l) => String(l)));
    }
    let out = lines;
    if (withoutStudioBlocks) {
        // The exported runtime (cs = …) and each // cs-studio:… // cs-studio:end block are the Studio's own.
        out = [];
        let inBlock = false, inRuntime = false;
        for (const l of lines) {
            const t = l.trim();
            if (t.startsWith('// cs-studio:runtime')) { inRuntime = true; continue; }
            if (inRuntime) { if (t.startsWith('// cs-studio:end')) inRuntime = false; continue; }
            if (t.startsWith('// cs-studio:') && !t.startsWith('// cs-studio:end')) { inBlock = true; continue; }
            if (inBlock) { if (t.startsWith('// cs-studio:end')) inBlock = false; continue; }
            out.push(l);
        }
    }
    const text = out.join('\n').trim();
    return text;
}

/** A line inside one of the Studio's exported blocks (its marker included). */
function isMarkedLine(all: string[], i: number): boolean {
    let open = false;
    for (let j = 0; j <= i; j++) {
        const t = all[j];
        if (t.startsWith('// cs-studio:') && !t.startsWith('// cs-studio:end')) open = true;
        else if (t.startsWith('// cs-studio:end')) { if (j === i) return true; open = false; }
    }
    return open;
}

function scriptLines(events: CfEvent[] | undefined, listen: string): string[] {
    const out: string[] = [];
    for (const e of events ?? []) {
        if (e?.listen !== listen) continue;
        const exec = e.script?.exec;
        const lines = Array.isArray(exec) ? exec : typeof exec === 'string' ? exec.split('\n') : [];
        out.push(...lines.map((l) => String(l)));
    }
    // Comments dropped, except the Studio's own markers (an exported check / saved value).
    return out.map((l) => l.trim()).filter((l) => l && (!l.startsWith('//') || l.startsWith('// cs-studio:')));
}

/** Common test-script lines → checks and saved values (see the file header). */
export function convertTests(lines: string[]): { checks: ApiCheck[]; extract: ApiExtract[]; notes: string[]; converted: number } {
    const checks: ApiCheck[] = [], extract: ApiExtract[] = [], notes: string[] = [];
    let converted = 0;
    // Names bound to the parsed body: var jsonData = pm.response.json();
    const jsonNames = new Set<string>(['pm.response.json()']);
    const lit = (s: string): string | null => {
        const t = s.trim();
        if (/^(true|false|null)$/.test(t) || /^-?\d+(\.\d+)?$/.test(t)) return t;
        const m = /^(['"`])(.*)\1$/s.exec(t);
        return m ? un(m[2]) : null;
    };
    const pathOf = (expr: string): string | null => {
        const t = expr.trim();
        for (const n of jsonNames) {
            if (t === n) return '$';
            if (t.startsWith(n)) {
                const rest = t.slice(n.length);
                // .a.b[0]["c"]  →  .a.b[0].c
                const norm = rest.replace(/\[\s*(['"])([\w-]+)\1\s*\]/g, '.$2');
                // The framework splits on "." (so "b-c" is a key) and reads name[0] as an element.
                if (/^(\.[\w-]+|\[\d+\])+$/.test(norm)) return '$' + norm;
                return null;
            }
        }
        return null;
    };
    // A string literal's text: \" → ", \\ → \ (and \n, \t).
    const un = (x: string) => x.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
    let block = 0;
    // A part exported by the Studio (cs-studio:check / save / runtime … end): the marker says exactly what it is.
    let marked = false;
    for (const raw of unwrapOneLineTests(lines)) {
        const l = raw.replace(/;\s*$/, '').trim();
        if (marked) { if (l === '// cs-studio:end') marked = false; continue; }
        const mk = /^\/\/ cs-studio:(check|save|runtime)\b\s*(.*)$/.exec(l);
        if (mk) {
            marked = true;
            if (mk[1] !== 'runtime') {
                try { const x = JSON.parse(mk[2]); if (mk[1] === 'check') checks.push(x as ApiCheck); else extract.push(x as ApiExtract); converted++; }
                catch { notes.push(`An exported ${mk[1]} could not be read back: ${mk[2].slice(0, 120)}`); }
            }
            continue;
        }
        let m: RegExpExecArray | null;
        if ((m = /^(?:var|let|const)\s+(\w+)\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*responseBody\s*\))$/.exec(l))) { jsonNames.add(m[1]); converted++; continue; }
        if (/^pm\.test\(.*function\s*\(\s*\)\s*\{$|^pm\.test\(.*\(\s*\)\s*=>\s*\{$/.test(l)) { block++; continue; }
        if (/^\}\s*\)?$/.test(l) && block > 0) { block--; continue; }
        if ((m = /^pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)$/.exec(l)) || (m = /^pm\.expect\(\s*pm\.response\.code\s*\)\.to\.(?:eql|equal|be\.equal|eq)\(\s*(\d{3})\s*\)$/.exec(l))) { checks.push({ kind: 'status', value: m[1] }); converted++; continue; }
        if ((m = /^pm\.expect\(\s*pm\.response\.code\s*\)\.to\.be\.within\(\s*(\d{3})\s*,\s*(\d{3})\s*\)$/.exec(l))) { checks.push({ kind: 'statusBetween', min: Number(m[1]), max: Number(m[2]) }); converted++; continue; }
        if ((m = /^pm\.expect\(\s*pm\.response\.text\(\)\s*\)\.to\.not\.(?:include|contain)\(\s*(['"`])(.*)\1\s*\)$/.exec(l))) { checks.push({ kind: 'bodyNotContains', value: un(m[2]) }); converted++; continue; }
        if (/^pm\.expect\(\s*pm\.response\.text\(\)\s*\)\.to\.(?:equal|eql)\(\s*(['"`])\1\s*\)$/.test(l) || /^pm\.response\.to\.(?:have\.body\(\s*(['"`])\1\s*\)|not\.have\.body)$/.test(l)) { checks.push({ kind: 'bodyEmpty' }); converted++; continue; }
        if ((m = /^pm\.expect\(\s*JSON\.stringify\(\s*(.+?)\s*\)\s*\)\.to\.not\.(?:include|contain)\(\s*(['"`])(.*)\2\s*\)$/.exec(l))) {
            const p = pathOf(m[1]);
            if (p && p !== '$') { checks.push({ kind: 'jsonNotContains', target: p, value: un(m[3]) }); converted++; continue; }
        }
        if ((m = /^pm\.expect\(\s*pm\.response\.responseTime\s*\)\.to\.be\.(?:below|lessThan)\(\s*(\d+)\s*\)$/.exec(l))) { checks.push({ kind: 'timeBelow', value: m[1] }); converted++; continue; }
        if ((m = /^pm\.expect\(\s*pm\.response\.text\(\)\s*\)\.to\.(?:include|contain)\(\s*(['"`])(.*)\1\s*\)$/.exec(l))) { checks.push({ kind: 'bodyContains', value: un(m[2]) }); converted++; continue; }
        if ((m = /^pm\.response\.to\.have\.header\(\s*(['"`])([^'"`]+)\1\s*\)$/.exec(l))) { checks.push({ kind: 'headerExists', target: m[2] }); converted++; continue; }
        if ((m = /^pm\.expect\(\s*pm\.response\.headers\.get\(\s*(['"`])([^'"`]+)\1\s*\)\s*\)\.to\.(?:eql|equal)\(\s*(['"`])(.*)\3\s*\)$/.exec(l))) { checks.push({ kind: 'headerEquals', target: m[2], value: un(m[4]) }); converted++; continue; }
        if ((m = /^pm\.expect\(\s*pm\.response\.headers\.get\(\s*(['"`])([^'"`]+)\1\s*\)\s*\)\.to\.(?:include|contain)\(\s*(['"`])(.*)\3\s*\)$/.exec(l))) { checks.push({ kind: 'headerContains', target: m[2], value: un(m[4]) }); converted++; continue; }
        if ((m = /^pm\.expect\(\s*(.+?)\s*\)\.to\.(?:eql|equal|eq|be\.equal|deep\.equal)\(\s*(.+)\s*\)$/.exec(l))) {
            const p = pathOf(m[1]), v = lit(m[2]);
            if (p && v !== null && p !== '$') { checks.push({ kind: 'jsonEquals', target: p, value: /^(['"`])/.test(m[2].trim()) && /^(true|false|null|-?\d+(\.\d+)?)$/.test(v) ? JSON.stringify(v) : v }); converted++; continue; }
        }
        if ((m = /^pm\.expect\(\s*(.+?)\s*\)\.to\.be\.(true|false|null)$/.exec(l))) {
            const p = pathOf(m[1]);
            if (p && p !== '$') { checks.push({ kind: 'jsonEquals', target: p, value: m[2] }); converted++; continue; }
        }
        if ((m = /^pm\.expect\(\s*(.+?)\s*\)\.to\.(?:exist|not\.be\.undefined|be\.ok)$/.exec(l))) {
            const p = pathOf(m[1]);
            if (p && p !== '$') { checks.push({ kind: 'jsonExists', target: p }); converted++; continue; }
        }
        if ((m = /^pm\.expect\(\s*(.+?)\s*\)\.to\.have\.(?:property|ownProperty)\(\s*(['"`])([\w-]+)\2\s*\)$/.exec(l))) {
            const p = pathOf(m[1]);
            if (p) { checks.push({ kind: 'jsonExists', target: `${p}.${m[3]}` }); converted++; continue; }
        }
        if ((m = /^(?:pm\.(?:environment|collectionVariables|globals|variables)\.set|postman\.setEnvironmentVariable|postman\.setGlobalVariable)\(\s*(['"`])([\w.-]+)\1\s*,\s*(.+)\s*\)$/.exec(l))) {
            const h = /^pm\.response\.headers\.get\(\s*(['"`])([^'"`]+)\1\s*\)$/.exec(m[3].trim());
            if (h) { extract.push({ from: 'header', path: h[2], variable: m[2] }); converted++; continue; }
            const p = pathOf(m[3]);
            if (p && p !== '$') { extract.push({ from: 'json', path: p, variable: m[2] }); converted++; continue; }
        }
        notes.push(raw.trim());
    }
    return { checks, extract, notes, converted };
}

/** Statements split at ";" outside quotes. */
function statements(code: string): string[] {
    const out: string[] = [];
    let cur = '', q = '';
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (q) { cur += ch; if (ch === '\\') { cur += code[++i] ?? ''; continue; } if (ch === q) q = ''; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
        if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/**
 * A test written on one line, pm.test("ok", () => pm.response.to.have.status(200)) or
 * pm.test("ok", function () { a; b; }), as its statements (each is then converted like any line).
 */
export function unwrapOneLineTests(lines: string[]): string[] {
    const out: string[] = [];
    for (const raw of lines) {
        const m = /^\s*pm\.test\(\s*(['"`])(?:\\.|(?!\1).)*\1\s*,\s*(?:function\s*\(\s*\)|\(\s*\)\s*=>)\s*(\{([\s\S]*)\}|([\s\S]*?))\s*\)\s*;?\s*$/.exec(raw);
        if (!m) { out.push(raw); continue; }
        const body = m[3] !== undefined ? m[3] : m[4] ?? '';
        if (!body.trim()) { out.push(raw); continue; }
        out.push(...statements(body));
    }
    return out;
}

/** The {{variable}} every request URL starts with, if there is one. */
function commonVarPrefix(list: ApiItem[]): string | null {
    const urls: string[] = [];
    const walk = (xs: ApiItem[]) => { for (const x of xs) { if (x.kind === 'folder') walk(x.items); else urls.push(x.url); } };
    walk(list);
    if (!urls.length) return null;
    const m = urls.map((u) => /^\{\{\s*([\w.-]+)\s*\}\}/.exec(u)?.[1] ?? null);
    return m.every((x) => x && x === m[0]) ? m[0] : null;
}

function stripPrefix(list: ApiItem[], prefix: string) {
    for (const x of list) {
        if (x.kind === 'folder') stripPrefix(x.items, prefix);
        else { x.url = x.url.replace(/^\{\{\s*[\w.-]+\s*\}\}/, ''); if (!x.url.startsWith('/') && x.url) x.url = `/${x.url}`; }
    }
}
