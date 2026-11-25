/**
 * An API collection → the common collection v2.1 JSON format (for other API clients and colleagues
 * who do not use the Studio). Every check and saved value becomes a test script those clients run, with the same
 * verdict as in the Studio: rule checks and saved values use a small runtime with the Studio's own rules
 * (postmanRuntime.ts), schema checks Postman's jsonSchema. Each is marked, so importing the export back into the
 * Studio gives the same collection. Secrets stay references ({env:NAME} becomes {{NAME}}). What the format cannot
 * hold is listed in the warnings: database checks (kept as skipped tests), WebSocket exchanges (left out).
 */
import { ApiAuth, ApiCheck, ApiCollection, ApiExtract, ApiItem, ApiRequest, PROTOCOL_LABEL } from './model';
import { extraCheckScript, runtimeSource, saveScript } from './postmanRuntime';

const v = (s: string) => s.replace(/\{env:([\w.-]+)\}/g, '{{$1}}').replace(/\{config:([\w.-]+)\}/g, '{{$1}}');
const js = (s: unknown) => JSON.stringify(s);

function pathJs(p: string): string {
    // $.a.b[0].c → json.a.b[0].c (names that are not identifiers as ["name"])
    return 'json' + p.replace(/^\$/, '').split('.').filter(Boolean).map((part) => {
        const m = /^([^[]*)((?:\[\d+\])*)$/.exec(part)!;
        return (m[1] ? (/^[A-Za-z_$][\w$]*$/.test(m[1]) ? `.${m[1]}` : `[${js(m[1])}]`) : '') + m[2];
    }).join('');
}

/** A check as a test block (the usual multi-line form, which the Studio's import reads back). */
export function checkScript(c: ApiCheck): string[] | null {
    const t = c.target ?? '', val = c.value ?? '';
    const lit = (x: string) => (/^(true|false|null|-?\d+(\.\d+)?)$/.test(x.trim()) ? x.trim() : /^".*"$/.test(x.trim()) ? x.trim() : js(x));
    const block = (name: string, ...body: string[]) => [`pm.test(${js(name)}, function () {`, ...body.map((l) => `    ${l}`), '});'];
    const J = 'const json = pm.response.json();';
    switch (c.kind) {
        case 'status': return block(`Status is ${val}`, `pm.response.to.have.status(${Number(val)});`);
        case 'statusBetween': return block(`Status between ${c.min ?? 200} and ${c.max ?? 299}`, `pm.expect(pm.response.code).to.be.within(${c.min ?? 200}, ${c.max ?? 299});`);
        case 'jsonExists': return block(`${t} exists`, J, `pm.expect(${pathJs(t)}).to.not.be.undefined;`);
        case 'jsonEquals': return block(`${t} is ${val}`, J, `pm.expect(${pathJs(t)}).to.eql(${lit(val)});`);
        case 'jsonNotContains': return block(`${t} does not contain ${val}`, J, `pm.expect(JSON.stringify(${pathJs(t)})).to.not.include(${js(val)});`);
        case 'bodyContains': return block(`Body contains ${val}`, `pm.expect(pm.response.text()).to.include(${js(val)});`);
        case 'bodyNotContains': return block(`Body does not contain ${val}`, `pm.expect(pm.response.text()).to.not.include(${js(val)});`);
        case 'bodyEmpty': return block('Body is empty', 'pm.expect(pm.response.text()).to.equal("");');
        case 'headerExists': return block(`Header ${t} exists`, `pm.response.to.have.header(${js(t)});`);
        case 'headerEquals': return block(`Header ${t} is ${val}`, `pm.expect(pm.response.headers.get(${js(t)})).to.eql(${js(val)});`);
        case 'headerContains': return block(`Header ${t} contains ${val}`, `pm.expect(pm.response.headers.get(${js(t)})).to.include(${js(val)});`);
        case 'timeBelow': return block(`Time below ${val} ms`, `pm.expect(pm.response.responseTime).to.be.below(${Number(val)});`);
        default: return null;
    }
}
/** Reads a project file (payload templates, schema files) for the export. */
export interface ExportOptions { readFile?: (rel: string) => string | undefined; payloadBase?: string; schemaBase?: string }
void ({} as ApiExtract);

function auth(a: ApiAuth): Record<string, unknown> | undefined {
    const kv = (o: Record<string, string | undefined>) => Object.entries(o).filter(([, x]) => x !== undefined).map(([key, value]) => ({ key, value: v(value!), type: 'string' }));
    switch (a.type) {
        case 'inherit': return undefined;
        case 'none': return { type: 'noauth' };
        case 'bearer': return { type: 'bearer', bearer: kv({ token: a.token }) };
        case 'basic': return { type: 'basic', basic: kv({ username: a.username, password: a.password }) };
        case 'apikey': return { type: 'apikey', apikey: kv({ key: a.key, value: a.value, in: a.in ?? 'header' }) };
        case 'ntlm': return { type: 'ntlm', ntlm: kv({ username: a.username, password: a.password, domain: a.domain, workstation: a.workstation }) };
        case 'digest': return { type: 'digest', digest: kv({ username: a.username, password: a.password }) };
        case 'oauth2': {
            const g = a.grant ?? 'client_credentials';
            const grant = g === 'password' ? 'password_credentials' : g === 'authorization_code' ? (a.pkce === false ? 'authorization_code' : 'authorization_code_with_pkce') : g === 'implicit' ? 'implicit' : 'client_credentials';
            return { type: 'oauth2', oauth2: kv({ grant_type: grant, accessTokenUrl: a.tokenUrl, authUrl: a.authUrl, clientId: a.clientId, clientSecret: a.clientSecret, scope: a.scope, username: a.username, password: a.password, refreshToken: a.refreshToken, ...(grant === 'authorization_code_with_pkce' ? { challengeAlgorithm: 'S256' } : {}) }) };
        }
        case 'aws': return { type: 'awsv4', awsv4: kv({ accessKey: a.accessKey, secretKey: a.secretKey, region: a.region, service: a.service, sessionToken: a.sessionToken }) };
        case 'oauth1': return { type: 'oauth1', oauth1: kv({ consumerKey: a.consumerKey, consumerSecret: a.consumerSecret, token: a.token, tokenSecret: a.tokenSecret, signatureMethod: a.signatureMethod ?? 'HMAC-SHA1', realm: a.realm, privateKey: a.privateKey, version: '1.0', addParamsToHeader: 'true' }) };
        case 'hawk': return { type: 'hawk', hawk: kv({ authId: a.hawkId, authKey: a.hawkKey, algorithm: a.algorithm ?? 'sha256', ext: a.ext, includePayloadHash: a.payloadHash ? 'true' : undefined }) };
        case 'edgegrid': return { type: 'edgegrid', edgegrid: kv({ clientToken: a.clientToken, clientSecret: a.clientSecret, accessToken: a.accessToken }) };
        case 'jwt': return { type: 'jwt', jwt: kv({ algorithm: a.algorithm ?? 'HS256', secret: a.secret, privateKey: a.privateKey, payload: a.payload, header: a.jwtHeader, addTokenTo: a.queryKey ? 'queryParam' : 'header', headerPrefix: a.prefix ?? 'Bearer', queryParamKey: a.queryKey }) };
        case 'asap': return { type: 'asap', asap: kv({ alg: a.algorithm ?? 'RS256', iss: a.issuer, aud: a.audience, kid: a.keyId, sub: a.subject, privateKey: a.privateKey, exp: a.expiresIn ? `${a.expiresIn}s` : undefined }) };
        default: return undefined;
    }
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

function request(r: ApiRequest, base: string, o: ExportOptions, warnings: string[]) {
    if (r.auth.type !== 'inherit' && !auth(r.auth)) warnings.push(`"${r.name}": ${r.auth.type === 'negotiate' ? 'Kerberos (Negotiate)' : r.auth.type} sign-in has no equivalent in this format: the request is exported without it.`);
    if (r.auth.type === 'oauth2' && (r.auth.grant === 'device_code' || r.auth.grant === 'refresh_token')) warnings.push(`"${r.name}": OAuth 2.0 ${r.auth.grant} is exported as client credentials (this format has no ${r.auth.grant} grant).`);
    const url = /^https?:\/\//.test(r.url) || /^\{\{/.test(r.url) ? r.url : `{{baseUrl}}${r.url.startsWith('/') ? '' : '/'}${r.url}`;
    const q = r.query.filter((x) => x.key);
    const raw = v(url) + (q.length ? `?${q.filter((x) => x.enabled !== false).map((x) => `${x.key}=${v(x.value)}`).join('&')}` : '');
    let body: Record<string, unknown> | undefined;
    if (r.body.mode === 'graphql') body = { mode: 'graphql', graphql: { query: v(r.body.graphql?.query ?? ''), variables: v(r.body.graphql?.variables ?? '') } };
    else if (r.body.mode === 'json' || r.body.mode === 'xml' || r.body.mode === 'text') body = { mode: 'raw', raw: v(r.body.text ?? ''), options: { raw: { language: r.body.mode === 'text' ? 'text' : r.body.mode } } };
    else if (r.body.mode === 'form') body = { mode: 'urlencoded', urlencoded: (r.body.form ?? []).map((x) => ({ key: x.key, value: v(x.value), ...(x.enabled === false ? { disabled: true } : {}) })) };
    else if (r.body.mode === 'multipart') body = { mode: 'formdata', formdata: (r.body.parts ?? []).map((x) => (x.type === 'file' ? { key: x.key, type: 'file', src: x.value } : { key: x.key, value: v(x.value), type: 'text' })) };
    else if (r.body.mode === 'file') {
        // A payload template of the project: its text (the client fills {{name}} itself).
        const rel = `${(o.payloadBase || 'test-data/payloads').replace(/[\\/]+$/, '')}/${(r.body.file ?? '').trim()}`;
        const text = r.body.file?.trim() ? o.readFile?.(rel) : undefined;
        if (text === undefined) warnings.push(`"${r.name}": the payload file ${r.body.file ?? ''} could not be read; the request has no body.`);
        else body = { mode: 'raw', raw: v(text.replace(/\$\{(?!config\.|response\.)([^}]+)\}/g, '{{$1}}')), options: { raw: { language: /^\s*</.test(text) ? 'xml' : 'json' } } };
    }
    const tests: string[] = [];
    for (const c of r.checks) {
        if (c.kind === 'rule' || c.kind === 'schema' || c.kind === 'dbItems') {
            let schemaText: string | undefined;
            if (c.kind === 'schema' && c.schemaFile?.trim()) for (const rel of [`${(o.schemaBase || 'test-data').replace(/[\\/]+$/, '')}/api/schemas/${c.schemaFile.trim()}`, c.schemaFile.trim()]) { schemaText = o.readFile?.(rel); if (schemaText !== undefined) break; }
            const x = extraCheckScript(c, schemaText);
            tests.push(...x.lines);
            if (x.warning) warnings.push(`"${r.name}": ${x.warning}`);
        } else {
            const lines = checkScript(c);
            if (lines) tests.push(`// cs-studio:check ${js(c)}`, ...lines, '// cs-studio:end');
        }
    }
    for (const e of r.extract.filter((x) => x.variable && (x.path || x.from === 'status' || x.from === 'body'))) tests.push(...saveScript(e));
    if (tests.some((l) => /\bcs\./.test(l) && !l.startsWith('// cs-studio:'))) tests.unshift(...runtimeSource().split('\n'));
    // The request's own scripts (pm API) as they are: they run in Postman unchanged.
    if (r.scripts?.test?.trim()) tests.push(...r.scripts.test.split('\n'));
    const pre = r.scripts?.pre?.trim() ? r.scripts.pre.split('\n') : [];
    void base;
    return {
        name: r.name,
        request: {
            method: r.method,
            header: r.headers.filter((h) => h.key).map((h) => ({ key: h.key, value: v(h.value), ...(h.enabled === false ? { disabled: true } : {}) })),
            url: { raw, ...urlParts(raw), ...(q.length ? { query: q.map((x) => ({ key: x.key, value: v(x.value), ...(x.enabled === false ? { disabled: true } : {}) })) } : {}) },
            ...(body ? { body } : {}),
            ...(auth(r.auth) ? { auth: auth(r.auth) } : {}),
            ...(r.description ? { description: r.description } : {}),
        },
        ...(r.settings && (r.settings.followRedirects === false || r.settings.insecure) ? { protocolProfileBehavior: { ...(r.settings.followRedirects === false ? { followRedirects: false } : {}), ...(r.settings.insecure ? { strictSSL: false } : {}) } } : {}),
        ...(r.examples?.length ? { response: r.examples.map((e) => ({
            name: e.name, code: e.status, status: STATUS_TEXT[e.status] ?? '',
            header: Object.entries(e.headers ?? {}).map(([key, value]) => ({ key, value })),
            ...(e.body !== undefined ? { body: e.body } : {}),
            _postman_previewlanguage: /json/i.test(e.headers?.['Content-Type'] ?? e.headers?.['content-type'] ?? '') ? 'json' : /xml/i.test(e.headers?.['Content-Type'] ?? e.headers?.['content-type'] ?? '') ? 'xml' : 'text',
            originalRequest: { method: r.method, header: [], url: { raw: raw + (e.when?.query ? `${raw.includes('?') ? '&' : '?'}${Object.entries(e.when.query).map(([k, x]) => `${k}=${x}`).join('&')}` : ''), ...urlParts(raw), ...(e.when?.query ? { query: Object.entries(e.when.query).map(([key, value]) => ({ key, value })) } : {}) },
                ...(e.when?.body ? { body: { mode: 'raw', raw: e.when.body } } : {}) },
        })) } : {}),
        ...(tests.length || pre.length ? { event: [
            ...(pre.length ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } }] : []),
            ...(tests.length ? [{ listen: 'test', script: { type: 'text/javascript', exec: tests } }] : []),
        ] } : {}),
    };
}

export function exportCollection(c: ApiCollection, o: ExportOptions = {}): Record<string, unknown> {
    return exportReport(c, o).collection;
}

/** The export and what it could not carry over (warnings). */
export function exportReport(c: ApiCollection, o: ExportOptions = {}): { collection: Record<string, unknown>; warnings: string[] } {
    const warnings: string[] = [];
    const items = (xs: ApiItem[]): unknown[] => xs.filter((x) => {
        if (x.kind === 'request' && x.ws) { warnings.push(`"${x.name}": a ${PROTOCOL_LABEL[x.ws.protocol ?? 'websocket']} exchange has no place in this format: left out.`); return false; }
        return true;
    }).map((x) => (x.kind === 'folder' ? { name: x.name, item: items(x.items), ...(x.description ? { description: x.description } : {}) } : request(x, c.baseUrl, o, warnings)));
    const variable = [{ key: 'baseUrl', value: v(c.baseUrl) }, ...c.variables.filter((x) => x.key).map((x) => ({ key: x.key, value: x.secret ? '' : v(x.value) }))];
    const collection = {
        info: { name: c.name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', ...(c.description ? { description: c.description } : {}) },
        item: items(c.items),
        variable,
        ...(auth(c.auth) && c.auth.type !== 'none' ? { auth: auth(c.auth) } : {}),
        ...(c.scripts?.pre?.trim() || c.scripts?.test?.trim() ? { event: [
            ...(c.scripts?.pre?.trim() ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: c.scripts.pre.split('\n') } }] : []),
            ...(c.scripts?.test?.trim() ? [{ listen: 'test', script: { type: 'text/javascript', exec: c.scripts.test.split('\n') } }] : []),
        ] } : {}),
    };
    return { collection, warnings };
}

/** The parts Postman builds a request's address from (it does not read `raw` when the parts are missing). */
function urlParts(raw: string): { protocol?: string; host: string[]; port?: string; path: string[] } {
    let rest = raw.split('?')[0].split('#')[0];
    let protocol: string | undefined;
    const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
    if (m) { protocol = m[1]; rest = rest.slice(m[0].length); }
    const slash = rest.indexOf('/');
    let hostPart = slash < 0 ? rest : rest.slice(0, slash);
    const pathPart = slash < 0 ? '' : rest.slice(slash + 1);
    let port: string | undefined;
    const pm = /:(\d+|\{\{[^}]+\}\})$/.exec(hostPart);
    if (pm && !/^\{\{[^}]*$/.test(hostPart.slice(0, pm.index))) { port = pm[1]; hostPart = hostPart.slice(0, pm.index); }
    const host = /^\{\{.*\}\}$/.test(hostPart) || /^\[/.test(hostPart) ? [hostPart] : hostPart.split('.');
    return { ...(protocol ? { protocol } : {}), host, ...(port ? { port } : {}), path: pathPart ? pathPart.split('/') : [] };
}
