/**
 * OpenAPI 3.x / Swagger 2.0 (JSON or YAML) → an API collection: one request per operation, folders by
 * tag, path parameters as {{variables}}, required query/header parameters (optional ones switched off),
 * a body from the spec's example or a sample built from its schema, authentication from the security
 * schemes (secret values are never invented: {{token}}, {env:CLIENT_SECRET}…), and a status check for
 * the operation's documented success code.
 */
import * as yaml from 'js-yaml';
import { ApiAuth, ApiBody, ApiCollection, ApiFolder, ApiRequest, HttpMethod, KV, newCollection, randomId } from './model';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

export function parseSpec(text: string): J {
    const t = text.trim();
    let doc: unknown;
    try { doc = t.startsWith('{') ? JSON.parse(t) : yaml.load(t, { schema: yaml.JSON_SCHEMA }); }
    catch (e) { throw new Error(`The file is not valid JSON or YAML: ${(e as Error).message.split('\n')[0]}`); }
    const d = doc as J;
    if (!d || typeof d !== 'object' || (!d.openapi && !d.swagger) || !d.paths) throw new Error('This is not an OpenAPI (3.x) or Swagger (2.0) document: it has no "openapi"/"swagger" version and "paths".');
    return d;
}

export interface OpenApiReport { operations: number; folders: number; warnings: string[]; /** Requests given the response's contract (a schema check). */ contracts?: number }

export function importOpenApi(text: string): { collection: ApiCollection; report: OpenApiReport } {
    const d = parseSpec(text);
    const v2 = !!d.swagger;
    const report: OpenApiReport = { operations: 0, folders: 0, warnings: [] };
    const c = newCollection(String(d.info?.title ?? 'API'));
    if (d.info?.description) c.description = String(d.info.description).slice(0, 2000);
    // Base URL
    if (v2) c.baseUrl = d.host ? `${(d.schemes?.[0] ?? 'https')}://${d.host}${d.basePath ?? ''}`.replace(/\/$/, '') : '';
    else if (Array.isArray(d.servers) && d.servers[0]?.url) {
        const s = d.servers[0];
        c.baseUrl = String(s.url).replace(/\{([^}]+)\}/g, (_m: string, n: string) => String(s.variables?.[n]?.default ?? '')).replace(/\/$/, '');
    }
    if (!c.baseUrl || !/^https?:\/\//.test(c.baseUrl)) { if (c.baseUrl) report.warnings.push(`The server URL "${c.baseUrl}" is relative: set the full base URL (or {config:API_BASE_URL}).`); c.baseUrl = c.baseUrl && /^https?:\/\//.test(c.baseUrl) ? c.baseUrl : '{config:API_BASE_URL}'; }
    const ref = (x: J | undefined, depth = 0): J | undefined => {
        if (!x || depth > 20) return x;
        if (typeof x.$ref === 'string') {
            const parts = x.$ref.replace(/^#\//, '').split('/').map((p: string) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
            let cur: J | undefined = d;
            for (const p of parts) cur = cur?.[p];
            return ref(cur, depth + 1);
        }
        return x;
    };
    const sample = (schema: J | undefined, depth = 0): unknown => {
        const s = ref(schema);
        if (!s || depth > 5) return null;
        if (s.example !== undefined) return s.example;
        if (s.default !== undefined) return s.default;
        if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
        if (s.allOf) return Object.assign({}, ...s.allOf.map((x: J) => sample(x, depth + 1)).filter((x: unknown) => x && typeof x === 'object'));
        if (s.oneOf || s.anyOf) return sample((s.oneOf ?? s.anyOf)[0], depth + 1);
        const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type ?? (s.properties ? 'object' : s.items ? 'array' : 'string');
        if (type === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).slice(0, 50).map(([k, p]) => [k, sample(p as J, depth + 1)]));
        if (type === 'array') return [sample(s.items, depth + 1)];
        if (type === 'integer' || type === 'number') return s.minimum ?? 0;
        if (type === 'boolean') return true;
        const f = s.format ?? '';
        return f === 'date' ? '2024-01-31' : f === 'date-time' ? '2024-01-31T12:00:00Z' : f === 'email' ? 'user@example.com' : f === 'uuid' ? '00000000-0000-0000-0000-000000000000' : f === 'uri' ? 'https://example.com' : 'string';
    };
    /**
     * The response's contract as a self-contained JSON schema the framework's schema step reads: references inlined
     * (a type that contains itself is left open past a few levels), OpenAPI's nullable as a "null" type, only the
     * keywords that check data.
     */
    const KEEP = ['type', 'properties', 'required', 'items', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'uniqueItems', 'format', 'additionalProperties'];
    const contract = (schema: J | undefined, depth = 0, seen: string[] = []): J => {
        if (!schema || typeof schema !== 'object') return {};
        const refName = typeof schema.$ref === 'string' ? schema.$ref : '';
        if (refName && (seen.includes(refName) || depth > 12)) return {};
        const s = ref(schema);
        if (!s || typeof s !== 'object') return {};
        const next = refName ? [...seen, refName] : seen;
        const out: J = {};
        for (const k of KEEP) {
            if (s[k] === undefined) continue;
            if (k === 'properties') out.properties = Object.fromEntries(Object.entries(s.properties as J).map(([n, p]) => [n, contract(p as J, depth + 1, next)]));
            else if (k === 'items') out.items = Array.isArray(s.items) ? s.items.map((x: J) => contract(x, depth + 1, next)) : contract(s.items, depth + 1, next);
            else if (k === 'allOf' || k === 'anyOf' || k === 'oneOf') out[k] = (s[k] as J[]).map((x) => contract(x, depth + 1, next));
            else if (k === 'additionalProperties') out.additionalProperties = typeof s.additionalProperties === 'boolean' ? s.additionalProperties : contract(s.additionalProperties, depth + 1, next);
            else out[k] = s[k];
        }
        if (!out.type && out.properties) out.type = 'object';
        if (s.nullable === true || s['x-nullable'] === true) {
            if (out.type) out.type = [...(Array.isArray(out.type) ? out.type : [out.type]), 'null'].filter((t, i, a) => a.indexOf(t) === i);
            if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
        }
        return out;
    };
    const exampleOf = (media: J | undefined): unknown => {
        if (!media) return undefined;
        if (media.example !== undefined) return media.example;
        const ex = media.examples && Object.values(media.examples as J)[0];
        if (ex) return (ref(ex as J) as J)?.value ?? ex;
        return sample(media.schema);
    };
    // Authentication
    const schemes: J = (v2 ? d.securityDefinitions : d.components?.securitySchemes) ?? {};
    const authFor = (req: J[] | undefined): ApiAuth | null => {
        if (!req) return null;
        if (req.length === 0) return { type: 'none' };
        const name = Object.keys(req[0] ?? {})[0];
        const s = ref(schemes[name]);
        if (!s) return null;
        const t = String(s.type).toLowerCase(), sch = String(s.scheme ?? '').toLowerCase();
        if ((t === 'http' && sch === 'bearer') || t === 'openidconnect') return { type: 'bearer', token: '{{token}}' };
        if ((t === 'http' && sch === 'basic') || t === 'basic') return { type: 'basic', username: '{{username}}', password: '{env:API_PASSWORD}' };
        if (t === 'apikey') return s.in === 'query' ? { type: 'apikey', key: s.name, value: '{env:API_KEY}', in: 'query' } : { type: 'apikey', key: s.name, value: '{env:API_KEY}', in: 'header' };
        if (t === 'oauth2') {
            const cc = v2 ? (s.flow === 'application' ? s : null) : s.flows?.clientCredentials;
            const pw = v2 ? (s.flow === 'password' ? s : null) : s.flows?.password;
            const f = cc ?? pw;
            if (f?.tokenUrl) return { type: 'oauth2', grant: cc ? 'client_credentials' : 'password', tokenUrl: f.tokenUrl, clientId: '{{clientId}}', clientSecret: '{env:CLIENT_SECRET}', ...(Object.keys(f.scopes ?? {}).length ? { scope: Object.keys(f.scopes).join(' ') } : {}), ...(pw && !cc ? { username: '{{username}}', password: '{env:API_PASSWORD}' } : {}) };
            report.warnings.push(`OAuth2 scheme "${name}" uses a flow that needs a browser sign-in; set the token yourself (Bearer {{token}}).`);
            return { type: 'bearer', token: '{{token}}' };
        }
        return null;
    };
    c.auth = authFor(d.security) ?? { type: 'none' };
    const vars = new Map<string, string>();
    if (c.auth.type === 'bearer') vars.set('token', '');
    if (c.auth.type === 'oauth2') vars.set('clientId', '');
    if (c.auth.type === 'basic' || (c.auth.type === 'oauth2' && c.auth.grant === 'password')) vars.set('username', '');
    const folders = new Map<string, ApiFolder>();
    for (const [p, item] of Object.entries(d.paths as J)) {
        const pathItem = ref(item as J) ?? {};
        for (const m of METHODS) {
            const op = pathItem[m] as J | undefined;
            if (!op) continue;
            report.operations++;
            const params: J[] = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])].map((x: J) => ref(x) ?? x);
            const r: ApiRequest = { kind: 'request', id: randomId(), name: String(op.summary || op.operationId || `${m.toUpperCase()} ${p}`).slice(0, 200), method: m.toUpperCase() as HttpMethod, url: p.replace(/\{([^}]+)\}/g, '{{$1}}'), query: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, checks: [], extract: [] };
            if (op.description) r.description = String(op.description).slice(0, 1000);
            const valueOf = (x: J) => { const v = x.example ?? x.schema?.example ?? x.default ?? x.schema?.default ?? (Array.isArray(x.schema?.enum ?? x.enum) ? (x.schema?.enum ?? x.enum)[0] : undefined); return v === undefined ? '' : String(v); };
            for (const x of params) {
                if (x.in === 'path') { if (!vars.has(x.name)) vars.set(x.name, valueOf(x)); }
                else if (x.in === 'query') r.query.push({ key: x.name, value: valueOf(x), ...(x.required ? {} : { enabled: false }) });
                else if (x.in === 'header' && !/^(accept|content-type|authorization)$/i.test(x.name)) r.headers.push({ key: x.name, value: valueOf(x), ...(x.required ? {} : { enabled: false }) });
            }
            // Body
            let body: ApiBody = { mode: 'none' };
            if (v2) {
                const b = params.find((x) => x.in === 'body');
                const form = params.filter((x) => x.in === 'formData');
                if (b) body = { mode: 'json', text: JSON.stringify(sample(b.schema), null, 2) };
                else if (form.length) {
                    const files = form.some((x) => x.type === 'file');
                    body = files ? { mode: 'multipart', parts: form.map((x) => ({ key: x.name, value: '', type: x.type === 'file' ? 'file' as const : 'text' as const, ...(x.required ? {} : { enabled: false }) })) }
                        : { mode: 'form', form: form.map((x) => ({ key: x.name, value: valueOf(x), ...(x.required ? {} : { enabled: false }) })) };
                }
            } else if (op.requestBody) {
                const rb = ref(op.requestBody) ?? {};
                const content: J = rb.content ?? {};
                const json = Object.keys(content).find((k) => /json/i.test(k));
                if (json) body = { mode: 'json', text: JSON.stringify(exampleOf(content[json]), null, 2) };
                else if (content['application/x-www-form-urlencoded']) {
                    const s = ref(content['application/x-www-form-urlencoded'].schema) ?? {};
                    body = { mode: 'form', form: Object.entries(s.properties ?? {}).map(([k, pr]) => ({ key: k, value: String(sample(pr as J) ?? '') })) };
                } else if (content['multipart/form-data']) {
                    const s = ref(content['multipart/form-data'].schema) ?? {};
                    body = { mode: 'multipart', parts: Object.entries(s.properties ?? {}).map(([k, pr]) => { const x = ref(pr as J) ?? {}; const file = x.format === 'binary' || x.format === 'base64'; return { key: k, value: file ? '' : String(sample(x) ?? ''), type: file ? 'file' as const : 'text' as const }; }) };
                } else if (content['application/xml'] || content['text/xml']) body = { mode: 'xml', text: '' };
                else if (Object.keys(content).length) body = { mode: 'text', text: '' };
            }
            r.body = body;
            const a = authFor(op.security);
            if (a) r.auth = a;
            const ok = Object.keys(op.responses ?? {}).find((k) => /^2\d\d$/.test(k));
            r.checks = ok ? [{ kind: 'status', value: ok }] : [{ kind: 'statusBetween', min: 200, max: 299 }];
            // The contract: the success response's JSON body matches the spec's schema.
            if (ok) {
                const res = ref(op.responses[ok]) ?? {};
                const schema = v2 ? res.schema : (() => { const ct = Object.keys(res.content ?? {}).find((k) => /json/i.test(k)); return ct ? res.content[ct]?.schema : undefined; })();
                const c2 = schema ? contract(schema) : null;
                if (c2 && Object.keys(c2).length) { r.checks.push({ kind: 'schema', schema: JSON.stringify(c2, null, 2) }); report.contracts = (report.contracts ?? 0) + 1; }
            }
            const tag = String(op.tags?.[0] ?? 'Other');
            if (!folders.has(tag)) folders.set(tag, { kind: 'folder', id: randomId(), name: tag, items: [] });
            folders.get(tag)!.items.push(r);
        }
    }
    report.folders = folders.size;
    c.items = folders.size === 1 ? [...folders.values()][0].items : [...folders.values()];
    c.variables = [...vars].map(([key, value]): KV => ({ key, value }));
    if (!report.operations) report.warnings.push('The document has no operations.');
    return { collection: c, report };
}
