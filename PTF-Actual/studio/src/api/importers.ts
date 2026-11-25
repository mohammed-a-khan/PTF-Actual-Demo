/**
 * Importers of other tools' files into a collection: Insomnia (export v4), SoapUI / ReadyAPI projects (SOAP and REST
 * test steps), JMeter test plans (.jmx: HTTP samplers, headers, bodies, transactions as folders), RAML 1.0, AsyncAPI
 * 2 / 3 (channels as MQTT / Kafka / WebSocket exchanges) and a GraphQL schema (an operation per query and mutation).
 * Each says what it could not carry over.
 */
import * as yaml from 'js-yaml';
import { DOMParser } from '@xmldom/xmldom';
import { buildSchema } from 'graphql';
import { ApiAuth, ApiCollection, ApiFolder, ApiItem, ApiRequest, httpMethod, KV, MsgProtocol, newCollection, newRequest, randomId } from './model';
import { operationFor } from './graphql';

export interface ImportResult { collection: ApiCollection; report: { requests: number; folders: number; warnings: string[] } }
const folder = (name: string, items: ApiItem[]): ApiFolder => ({ kind: 'folder', id: randomId(), name, items });
const count = (items: ApiItem[]): { requests: number; folders: number } => items.reduce((n, x) => (x.kind === 'folder' ? { requests: n.requests + count(x.items).requests, folders: n.folders + 1 + count(x.items).folders } : { ...n, requests: n.requests + 1 }), { requests: 0, folders: 0 });
const done = (c: ApiCollection, warnings: string[]): ImportResult => ({ collection: c, report: { ...count(c.items), warnings } });
const bodyMode = (ct: string, text: string): ApiRequest['body']['mode'] => (/json/i.test(ct) || /^\s*[[{]/.test(text) ? 'json' : /xml/i.test(ct) || /^\s*</.test(text) ? 'xml' : 'text');

// ---------------------------------------------------------------------------------------------------- Insomnia
type InsRes = { _id: string; _type: string; parentId?: string | null; name?: string; method?: string; url?: string; headers?: Array<{ name: string; value: string; disabled?: boolean }>; parameters?: Array<{ name: string; value: string; disabled?: boolean }>;
    body?: { mimeType?: string; text?: string; params?: Array<{ name: string; value: string; disabled?: boolean; type?: string; fileName?: string }> }; authentication?: Record<string, unknown>; data?: Record<string, unknown>; description?: string };

/** {{ _.name }} and {{name}} (Insomnia's template tags) → {{name}}; other tags are reported. */
const insVars = (s: string, warn: (t: string) => void) => s.replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, '{{$1}}').replace(/\{%[^%]*%\}/g, (m) => { warn(m); return m; });

export function importInsomnia(json: unknown): ImportResult {
    const x = json as { _type?: string; __export_format?: number; resources?: InsRes[] };
    if (x?._type !== 'export' || !Array.isArray(x.resources)) throw new Error('Not an Insomnia export (Application → Export data → Insomnia v4 JSON).');
    const warnings: string[] = [];
    const tags = new Set<string>();
    const v = (s: string | undefined) => insVars(s ?? '', (t) => tags.add(t));
    const ws = x.resources.find((r) => r._type === 'workspace');
    const c = newCollection(ws?.name ?? 'Insomnia');
    // Base environment and its sub-environments: the variables (the first sub-environment's values over the base's).
    const envs = x.resources.filter((r) => r._type === 'environment');
    const base = envs.find((e) => e.parentId === ws?._id) ?? envs[0];
    const sub = envs.find((e) => e.parentId === base?._id);
    const data = { ...(base?.data ?? {}), ...(sub?.data ?? {}) };
    c.variables = Object.entries(data).filter(([, val]) => typeof val !== 'object').map(([key, val]) => ({ key, value: String(val) }));
    if (Object.values(data).some((val) => val && typeof val === 'object')) warnings.push('Nested environment values (objects) were left out: only plain values became variables.');
    if (envs.length > 2) warnings.push(`${envs.length - 1} environments: the variables of "${sub?.name ?? base?.name}" were imported; make the others Studio environments.`);
    const auth = (a?: Record<string, unknown>): ApiAuth => {
        if (!a || !a.type || a.disabled) return { type: 'inherit' };
        if (a.type === 'basic') return { type: 'basic', username: v(String(a.username ?? '')), password: v(String(a.password ?? '')) };
        if (a.type === 'bearer') return { type: 'bearer', token: v(String(a.token ?? '')) };
        if (a.type === 'apikey') return { type: 'apikey', key: String(a.key ?? ''), value: v(String(a.value ?? '')), in: a.addTo === 'queryParams' ? 'query' : 'header' };
        if (a.type === 'oauth2') return { type: 'oauth2', grant: a.grantType === 'password' ? 'password' : a.grantType === 'authorization_code' ? 'authorization_code' : a.grantType === 'implicit' ? 'implicit' : 'client_credentials', tokenUrl: v(String(a.accessTokenUrl ?? '')), authUrl: a.authorizationUrl ? v(String(a.authorizationUrl)) : undefined, clientId: v(String(a.clientId ?? '')), clientSecret: v(String(a.clientSecret ?? '')), scope: a.scope ? String(a.scope) : undefined, username: a.username ? v(String(a.username)) : undefined, password: a.password ? v(String(a.password)) : undefined, pkce: a.usePkce === true };
        if (a.type === 'ntlm') return { type: 'ntlm', username: v(String(a.username ?? '')), password: v(String(a.password ?? '')) };
        if (a.type === 'digest') return { type: 'digest', username: v(String(a.username ?? '')), password: v(String(a.password ?? '')) };
        if (a.type === 'hawk') return { type: 'hawk', hawkId: String(a.id ?? ''), hawkKey: v(String(a.key ?? '')), ...(a.algorithm === 'sha1' || a.algorithm === 'sha256' ? { algorithm: a.algorithm } : {}) } as ApiAuth;
        if (a.type === 'iam') return { type: 'aws', accessKey: v(String(a.accessKeyId ?? '')), secretKey: v(String(a.secretAccessKey ?? '')), region: String(a.region ?? ''), service: String(a.service ?? ''), ...(a.sessionToken ? { sessionToken: v(String(a.sessionToken)) } : {}) };
        warnings.push(`Authentication "${String(a.type)}" is not imported.`);
        return { type: 'inherit' };
    };
    const kv = (a?: Array<{ name: string; value: string; disabled?: boolean }>): KV[] => (a ?? []).map((h) => ({ key: v(h.name), value: v(h.value), ...(h.disabled ? { enabled: false } : {}) }));
    const children = (parent: string | undefined): ApiItem[] => x.resources!.filter((r) => r.parentId === parent && (r._type === 'request' || r._type === 'request_group' || r._type === 'grpc_request' || r._type === 'websocket_request')).map((r): ApiItem | null => {
        if (r._type === 'request_group') return folder(r.name ?? 'Folder', children(r._id));
        if (r._type !== 'request') { warnings.push(`"${r.name}": ${r._type === 'grpc_request' ? 'a gRPC request' : 'a WebSocket request'} is not imported (create it with the method list: gRPC / WS).`); return null; }
        const q: ApiRequest = { ...newRequest(r.name ?? 'Request'), method: httpMethod(r.method ?? 'GET') ?? 'GET', url: v(r.url), headers: kv(r.headers), query: kv(r.parameters), auth: auth(r.authentication), ...(r.description ? { description: r.description } : {}) };
        const b = r.body;
        if (b?.mimeType === 'application/x-www-form-urlencoded') q.body = { mode: 'form', form: kv(b.params) };
        else if (b?.mimeType === 'multipart/form-data') q.body = { mode: 'multipart', parts: (b.params ?? []).map((p) => (p.type === 'file' ? { key: p.name, value: p.fileName ?? '', type: 'file' as const } : { key: p.name, value: v(p.value) })) };
        else if (b?.mimeType === 'application/graphql') { try { const g = JSON.parse(b.text ?? '{}'); q.body = { mode: 'graphql', graphql: { query: v(g.query ?? ''), ...(g.variables ? { variables: typeof g.variables === 'string' ? v(g.variables) : JSON.stringify(g.variables, null, 2) } : {}), ...(g.operationName ? { operationName: g.operationName } : {}) } }; } catch { q.body = { mode: 'json', text: v(b.text) }; } }
        else if (b?.text !== undefined) q.body = { mode: bodyMode(b.mimeType ?? '', b.text), text: v(b.text) };
        return q;
    }).filter((i): i is ApiItem => !!i);
    c.items = children(ws?._id);
    if (tags.size) warnings.push(`Insomnia template tags were kept as written (they need a value or a pre-request script): ${[...tags].slice(0, 5).join(', ')}${tags.size > 5 ? '…' : ''}`);
    return done(c, warnings);
}

// ---------------------------------------------------------------------------------------------------- XML helpers
const parseXml = (text: string) => {
    const errors: string[] = [];
    const doc = new DOMParser({ errorHandler: { error: (m: string) => errors.push(m), fatalError: (m: string) => errors.push(m), warning: () => undefined } }).parseFromString(text, 'text/xml');
    if (!doc.documentElement) throw new Error(`Not XML: ${errors[0] ?? ''}`);
    return doc;
};
const els = (e: Element | Document, local: string): Element[] => Array.from((e as Element).getElementsByTagNameNS ? (e as Element).getElementsByTagNameNS('*', local) : []);
const kidsNamed = (e: Element, local: string): Element[] => { const out: Element[] = []; for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && ((n as Element).localName === local || (n as Element).nodeName === local)) out.push(n as Element); return out; };
const kidNamed = (e: Element, local: string) => kidsNamed(e, local)[0];
const textOf = (e?: Element) => (e?.textContent ?? '');

// ---------------------------------------------------------------------------------------------------- SoapUI / ReadyAPI
/** ${#Project#name} / ${#TestCase#name} / ${name} property expansions → {{name}}. */
const soapuiVars = (s: string) => s.replace(/\$\{#(?:Project|TestSuite|TestCase|Global|Env)#([\w.-]+)\}/g, '{{$1}}').replace(/\$\{([\w.-]+)\}/g, '{{$1}}');

export function importSoapUi(text: string): ImportResult {
    const doc = parseXml(text);
    const root = doc.documentElement;
    if (root.localName !== 'soapui-project') throw new Error('Not a SoapUI / ReadyAPI project (soapui-project).');
    const warnings: string[] = [];
    const c = newCollection(root.getAttribute('name') || 'SoapUI project');
    const props = (e: Element) => kidsNamed(kidNamed(e, 'properties') ?? e, 'property').map((p) => ({ key: textOf(kidNamed(p, 'name')), value: soapuiVars(textOf(kidNamed(p, 'value'))) })).filter((p) => p.key);
    if (kidNamed(root, 'properties')) c.variables = props(root);
    const soapRequest = (name: string, endpoint: string, action: string, version: string, body: string, cred?: Element): ApiRequest => {
        const r: ApiRequest = { ...newRequest(name), method: 'POST', url: soapuiVars(endpoint), body: { mode: 'xml', text: soapuiVars(body) } };
        r.headers = version === '1_2' ? [{ key: 'Content-Type', value: `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}` }] : [{ key: 'Content-Type', value: 'text/xml; charset=utf-8' }, { key: 'SOAPAction', value: `"${action}"` }];
        r.checks = [{ kind: 'status', value: '200' }, { kind: 'bodyNotContains', value: ':Fault>' } as ApiRequest['checks'][number]];
        if (cred && textOf(kidNamed(cred, 'username'))) r.auth = { type: textOf(kidNamed(cred, 'authType')) === 'NTLM' ? 'ntlm' : 'basic', username: soapuiVars(textOf(kidNamed(cred, 'username'))), password: soapuiVars(textOf(kidNamed(cred, 'password'))), ...(textOf(kidNamed(cred, 'domain')) ? { domain: textOf(kidNamed(cred, 'domain')) } : {}) };
        return r;
    };
    const items: ApiItem[] = [];
    // Interfaces: SOAP operations' saved requests, REST resources' methods.
    for (const itf of kidsNamed(root, 'interface')) {
        const type = itf.getAttribute('xsi:type') ?? itf.getAttribute('type') ?? '';
        const out: ApiItem[] = [];
        if (/Wsdl/i.test(type) || itf.getAttribute('soapVersion')) {
            const version = itf.getAttribute('soapVersion') ?? '1_1';
            for (const op of kidsNamed(itf, 'operation')) for (const call of kidsNamed(op, 'call'))
                out.push(soapRequest(`${op.getAttribute('name')} · ${call.getAttribute('name')}`, textOf(kidNamed(call, 'endpoint')), op.getAttribute('action') ?? '', version, textOf(kidNamed(call, 'request')), kidNamed(call, 'credentials')));
        } else {
            const walk = (res: Element, prefix: string) => {
                const p = `${prefix}${res.getAttribute('path') ?? ''}`.replace(/\/{2,}/g, '/');
                for (const m of kidsNamed(res, 'method')) for (const rq of kidsNamed(m, 'request')) {
                    const method = httpMethod(m.getAttribute('method') ?? 'GET') ?? 'GET';
                    const q: ApiRequest = { ...newRequest(`${m.getAttribute('name') ?? method} · ${rq.getAttribute('name') ?? ''}`.replace(/ · $/, '')), method, url: soapuiVars(`${textOf(kidNamed(rq, 'endpoint'))}${p}`).replace(/\{(\w+)\}/g, '{{$1}}') };
                    const params = kidsNamed(kidNamed(rq, 'parameters') ?? rq, 'entry');
                    q.query = params.map((e) => ({ key: e.getAttribute('key') ?? '', value: soapuiVars(e.getAttribute('value') ?? '') })).filter((e) => e.key && !/\{\{/.test(e.key));
                    const body = textOf(kidNamed(rq, 'request'));
                    if (body.trim()) q.body = { mode: bodyMode(rq.getAttribute('mediaType') ?? '', body), text: soapuiVars(body) };
                    out.push(q);
                }
                for (const child of kidsNamed(res, 'resource')) walk(child, p);
            };
            for (const res of kidsNamed(itf, 'resource')) walk(res, '');
        }
        if (out.length) items.push(folder(itf.getAttribute('name') ?? 'Interface', out));
    }
    // Test suites → folders, test cases → folders, request steps → requests with their assertions.
    for (const suite of kidsNamed(root, 'testSuite')) {
        const cases: ApiItem[] = [];
        for (const tc of kidsNamed(suite, 'testCase')) {
            const steps: ApiItem[] = [];
            for (const st of kidsNamed(tc, 'testStep')) {
                const type = st.getAttribute('type') ?? '';
                const cfg = kidNamed(st, 'config');
                if (type === 'request' && cfg) {
                    const rq = kidNamed(cfg, 'request');
                    const r = soapRequest(st.getAttribute('name') ?? 'Step', textOf(kidNamed(rq, 'endpoint')), '', '1_1', textOf(kidNamed(rq, 'request')), kidNamed(rq, 'credentials'));
                    const opName = textOf(kidNamed(cfg, 'operation'));
                    const op = els(root, 'operation').find((o) => o.getAttribute('name') === opName);
                    if (op?.getAttribute('action')) r.headers = r.headers.map((h) => (h.key === 'SOAPAction' ? { ...h, value: `"${op.getAttribute('action')}"` } : h));
                    for (const a of kidsNamed(rq, 'assertion')) {
                        const at = a.getAttribute('type') ?? '';
                        const acfg = kidNamed(a, 'configuration');
                        if (at === 'Simple Contains') r.checks.push({ kind: 'bodyContains', value: soapuiVars(textOf(kidNamed(acfg, 'token'))) } as ApiRequest['checks'][number]);
                        else if (at === 'Simple NotContains') r.checks.push({ kind: 'bodyNotContains', value: soapuiVars(textOf(kidNamed(acfg, 'token'))) } as ApiRequest['checks'][number]);
                        else if (at === 'Valid HTTP Status Codes') r.checks = r.checks.map((ch) => (ch.kind === 'status' ? { ...ch, value: textOf(kidNamed(acfg, 'codes')).split(',')[0].trim() || '200' } : ch));
                        else if (!/SOAP Response|Schema Compliance|SOAP Fault/.test(at)) warnings.push(`${tc.getAttribute('name')} / ${st.getAttribute('name')}: the assertion "${at}" is not imported.`);
                    }
                    steps.push(r);
                } else if (type === 'restrequest' && cfg) {
                    const rq = kidNamed(cfg, 'restRequest');
                    const q: ApiRequest = { ...newRequest(st.getAttribute('name') ?? 'Step'), method: httpMethod(rq?.getAttribute('method') ?? 'GET') ?? 'GET', url: soapuiVars(textOf(kidNamed(rq, 'endpoint')) + (cfg.getAttribute('resourcePath') ?? '')) };
                    const body = textOf(kidNamed(rq, 'request'));
                    if (body.trim()) q.body = { mode: bodyMode(rq?.getAttribute('mediaType') ?? '', body), text: soapuiVars(body) };
                    steps.push(q);
                } else if (type) warnings.push(`${tc.getAttribute('name')} / ${st.getAttribute('name')}: a "${type}" step (Groovy, property transfer, delay…) is not imported.`);
            }
            if (steps.length) cases.push(folder(tc.getAttribute('name') ?? 'Test case', steps));
        }
        if (cases.length) items.push(folder(suite.getAttribute('name') ?? 'Test suite', cases));
    }
    if (!items.length) throw new Error('No requests or test steps in this project.');
    c.items = items;
    return done(c, warnings);
}

// ---------------------------------------------------------------------------------------------------- JMeter
/** ${name} and ${__function(...)} → {{name}} (functions are reported). */
const jmVars = (s: string, warn: (f: string) => void) => s.replace(/\$\{__(\w+)\([^}]*\)\}/g, (m) => { warn(m); return m; }).replace(/\$\{([\w.-]+)\}/g, '{{$1}}');

export function importJmeter(text: string): ImportResult {
    const doc = parseXml(text);
    const root = doc.documentElement;
    if (root.nodeName !== 'jmeterTestPlan') throw new Error('Not a JMeter test plan (.jmx).');
    const warnings: string[] = [];
    const fns = new Set<string>();
    const v = (s: string) => jmVars(s, (f) => fns.add(f));
    const prop = (e: Element, name: string) => { for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as Element).getAttribute('name') === name) return n as Element; return undefined; };
    const str = (e: Element, name: string) => textOf(prop(e, name));
    const plan = els(root, 'TestPlan')[0] ?? Array.from(root.getElementsByTagName('TestPlan'))[0];
    const c = newCollection(plan?.getAttribute('testname') || 'JMeter test plan');
    // User-defined variables of the plan.
    const udv = plan ? prop(plan, 'TestPlan.user_defined_variables') : undefined;
    if (udv) c.variables = Array.from(udv.getElementsByTagName('elementProp')).map((e) => ({ key: str(e, 'Argument.name'), value: v(str(e, 'Argument.value')) })).filter((x) => x.key);
    // Request defaults (protocol, host, port) → base URL.
    const defaults = Array.from(root.getElementsByTagName('ConfigTestElement')).find((e) => e.getAttribute('guiclass') === 'HttpDefaultsGui');
    if (defaults) { const proto = str(defaults, 'HTTPSampler.protocol') || 'https', host = str(defaults, 'HTTPSampler.domain'), port = str(defaults, 'HTTPSampler.port'); if (host) c.baseUrl = v(`${proto}://${host}${port ? `:${port}` : ''}`); }
    const headersOf = (hashTree: Element | null): KV[] => {
        const out: KV[] = [];
        if (!hashTree) return out;
        for (let n = hashTree.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as Element).nodeName === 'HeaderManager')
            for (const h of Array.from((n as Element).getElementsByTagName('elementProp'))) out.push({ key: str(h, 'Header.name'), value: v(str(h, 'Header.value')) });
        return out;
    };
    // An element's children are in the hashTree right after it.
    const walk = (tree: Element, inherited: KV[]): ApiItem[] => {
        const items: ApiItem[] = [];
        const own = [...inherited, ...headersOf(tree)];
        for (let n = tree.firstChild; n; n = n.nextSibling) {
            if (n.nodeType !== 1) continue;
            const e = n as Element;
            let next = e.nextSibling; while (next && next.nodeType !== 1) next = next.nextSibling;
            const sub = next && (next as Element).nodeName === 'hashTree' ? next as Element : null;
            if (e.getAttribute('enabled') === 'false') continue;
            const name = e.getAttribute('testname') ?? e.nodeName;
            if (e.nodeName === 'HTTPSamplerProxy' || e.nodeName === 'HTTPSampler') {
                const proto = str(e, 'HTTPSampler.protocol'), host = str(e, 'HTTPSampler.domain'), port = str(e, 'HTTPSampler.port'), p = str(e, 'HTTPSampler.path');
                const url = host ? `${proto || 'https'}://${host}${port ? `:${port}` : ''}${p.startsWith('/') || !p ? p : `/${p}`}` : p;
                const r: ApiRequest = { ...newRequest(name), method: httpMethod(str(e, 'HTTPSampler.method') || 'GET') ?? 'GET', url: v(url), headers: [...own, ...headersOf(sub)] };
                const args = Array.from(e.getElementsByTagName('elementProp')).filter((a) => a.getAttribute('elementType') === 'HTTPArgument');
                if (str(e, 'HTTPSampler.postBodyRaw') === 'true') {
                    const raw = args.map((a) => str(a, 'Argument.value')).join('');
                    const ct = r.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
                    r.body = { mode: bodyMode(ct, raw), text: v(raw) };
                } else if (args.length) {
                    const kv = args.map((a) => ({ key: v(str(a, 'Argument.name')), value: v(str(a, 'Argument.value')) }));
                    if (['GET', 'DELETE', 'HEAD'].includes(r.method)) r.query = kv; else r.body = { mode: 'form', form: kv };
                }
                if (Array.from(e.getElementsByTagName('elementProp')).some((a) => a.getAttribute('elementType') === 'HTTPFileArg' && str(a, 'File.path'))) warnings.push(`${name}: file uploads are not imported.`);
                // Response assertions → checks; JSON / regex extractors → saved values.
                if (sub) for (let m = sub.firstChild; m; m = m.nextSibling) {
                    if (m.nodeType !== 1) continue;
                    const x = m as Element;
                    if (x.nodeName === 'ResponseAssertion') {
                        const field = str(x, 'Assertion.test_field');
                        const tests = Array.from(x.getElementsByTagName('stringProp')).filter((s) => (s.parentNode as Element)?.getAttribute?.('name') === 'Asserion.test_strings' || (s.parentNode as Element)?.getAttribute?.('name') === 'Assertion.test_strings').map((s) => textOf(s));
                        if (field === 'Assertion.response_code' && tests.length) r.checks = [{ kind: 'status', value: tests[0] }, ...r.checks.filter((ch) => ch.kind !== 'status')];
                        else for (const t of tests) r.checks.push({ kind: 'bodyContains', value: v(t) } as ApiRequest['checks'][number]);
                    } else if (x.nodeName === 'JSONPostProcessor') {
                        const names = str(x, 'JSONPostProcessor.referenceNames').split(';'), paths = str(x, 'JSONPostProcessor.jsonPathExprs').split(';');
                        names.forEach((nm, i) => { if (nm.trim() && paths[i]) r.extract.push({ variable: nm.trim(), from: 'json', path: paths[i].trim() }); });
                    } else if (x.nodeName === 'RegexExtractor') {
                        const nm = str(x, 'RegexExtractor.refname');
                        if (nm) r.extract.push({ variable: nm, from: 'regex', path: str(x, 'RegexExtractor.regex') });
                    } else if (x.nodeName === 'JSR223PostProcessor' || x.nodeName === 'BeanShellPostProcessor' || x.nodeName === 'JSR223PreProcessor') warnings.push(`${name}: a script (${x.getAttribute('testname')}) is not imported.`);
                }
                items.push(r);
            } else if (['ThreadGroup', 'SetupThreadGroup', 'PostThreadGroup', 'TransactionController', 'GenericController', 'LoopController', 'IfController', 'OnceOnlyController', 'SimpleController'].includes(e.nodeName) || /ThreadGroup$/.test(e.nodeName)) {
                const inner = sub ? walk(sub, own) : [];
                if (/IfController|LoopController/.test(e.nodeName) && inner.length) warnings.push(`${name}: the ${e.nodeName === 'IfController' ? 'condition' : 'loop'} is not imported (its requests are).`);
                if (inner.length) items.push(folder(name, inner));
            } else if (e.nodeName === 'TestPlan' || e.nodeName === 'hashTree') {
                if (sub) items.push(...walk(sub, own));
            } else if (sub && e.nodeName !== 'HeaderManager') items.push(...walk(sub, own));
            if (e.nodeName === 'CSVDataSet') warnings.push(`${name}: the CSV data set ${str(e, 'filename')} is test data: choose it under the runner's Test data.`);
        }
        return items;
    };
    const top = Array.from(root.childNodes).find((n) => n.nodeType === 1 && (n as Element).nodeName === 'hashTree') as Element | undefined;
    c.items = top ? walk(top, []) : [];
    // One plan with a single thread group: no extra folder levels.
    while (c.items.length === 1 && c.items[0].kind === 'folder' && c.items[0].items.every((i) => i.kind === 'folder' || i.kind === 'request') && c.items[0].items.length && c.items[0].items.some((i) => i.kind === 'request')) c.items = c.items[0].items;
    if (!count(c.items).requests) throw new Error('No HTTP requests in this test plan.');
    if (fns.size) warnings.push(`JMeter functions kept as written (use a dynamic value such as <uuid> or <timestamp>): ${[...fns].slice(0, 5).join(', ')}`);
    return done(c, warnings);
}

// ---------------------------------------------------------------------------------------------------- RAML
const RAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('!include', { kind: 'scalar', construct: (d) => `!include ${d}` })]);

export function importRaml(text: string): ImportResult {
    if (!/^#%RAML\s+1\.0/.test(text.trim())) throw new Error('Not a RAML 1.0 document (#%RAML 1.0 on the first line).');
    const doc = yaml.load(text, { schema: RAML_SCHEMA }) as Record<string, unknown>;
    const warnings: string[] = [];
    const c = newCollection(String(doc.title ?? 'RAML API'));
    c.baseUrl = String(doc.baseUri ?? '').replace(/\{version\}/g, String(doc.version ?? 'v1')).replace(/\{(\w+)\}/g, '{{$1}}');
    if (JSON.stringify(doc).includes('!include ')) warnings.push('Included files (!include) are not read: their examples and types are missing.');
    const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    const items: ApiItem[] = [];
    const walk = (node: Record<string, unknown>, p: string, into: ApiItem[]) => {
        for (const [k, val] of Object.entries(node)) {
            if (!k.startsWith('/') || !val || typeof val !== 'object') continue;
            const path0 = `${p}${k}`;
            const res = val as Record<string, unknown>;
            const own: ApiItem[] = [];
            for (const m of methods) {
                const op = res[m] as Record<string, unknown> | null | undefined;
                if (op === undefined) continue;
                const o = op ?? {};
                const r: ApiRequest = { ...newRequest(String(o.displayName ?? `${m.toUpperCase()} ${path0}`)), method: m.toUpperCase() as ApiRequest['method'], url: path0.replace(/\{(\w+)\}/g, '{{$1}}'), ...(o.description ? { description: String(o.description) } : {}) };
                const qp = (o.queryParameters ?? {}) as Record<string, { required?: boolean; example?: unknown; default?: unknown }>;
                r.query = Object.entries(qp).map(([key, q]) => ({ key, value: String(q?.example ?? q?.default ?? `{{${key}}}`), ...(q?.required === false ? { enabled: false } : {}) }));
                const hs = (o.headers ?? {}) as Record<string, { example?: unknown }>;
                r.headers = Object.entries(hs).map(([key, h]) => ({ key, value: String(h?.example ?? `{{${key}}}`) }));
                const body = o.body as Record<string, { example?: unknown }> | undefined;
                if (body) {
                    const [ct, b] = Object.entries(body)[0] ?? [];
                    if (ct && b && b.example !== undefined) { const ex = typeof b.example === 'string' ? b.example : JSON.stringify(b.example, null, 2); r.body = { mode: bodyMode(ct, ex), text: ex }; r.headers.push({ key: 'Content-Type', value: ct }); }
                    else if (ct) { r.body = { mode: bodyMode(ct, ''), text: '' }; r.headers.push({ key: 'Content-Type', value: ct }); }
                }
                const codes = Object.keys((o.responses ?? {}) as object).filter((x) => /^2\d\d$/.test(x));
                if (codes.length) r.checks = [{ kind: 'status', value: codes[0] }];
                own.push(r);
            }
            const deeper: ApiItem[] = [];
            walk(res, path0, deeper);
            into.push(...own, ...deeper);
        }
    };
    for (const [k, val] of Object.entries(doc)) {
        if (!k.startsWith('/') || !val || typeof val !== 'object') continue;
        const inner: ApiItem[] = [];
        walk({ [k]: val }, '', inner);
        if (inner.length) items.push(folder(k, inner));
    }
    if (doc.securitySchemes) warnings.push('Security schemes: set the sign-in on the collection (Settings → Authorization).');
    c.items = items.length === 1 && items[0].kind === 'folder' ? items[0].items : items;
    if (!count(c.items).requests) throw new Error('No resources with methods in this RAML document.');
    return done(c, warnings);
}

// ---------------------------------------------------------------------------------------------------- AsyncAPI
export function importAsyncApi(text: string): ImportResult {
    const doc = (text.trim().startsWith('{') ? JSON.parse(text) : yaml.load(text)) as Record<string, any>;
    const ver = String(doc?.asyncapi ?? '');
    if (!/^[23]\./.test(ver)) throw new Error('Not an AsyncAPI 2 or 3 document.');
    const warnings: string[] = [];
    const c = newCollection(String(doc.info?.title ?? 'AsyncAPI'));
    const servers = Object.entries((doc.servers ?? {}) as Record<string, any>);
    const [sname, server] = servers[0] ?? ['', {}];
    const proto = String(server?.protocol ?? '').toLowerCase();
    const protocol: MsgProtocol = /mqtt/.test(proto) ? 'mqtt' : /kafka/.test(proto) ? 'kafka' : /ws|websocket/.test(proto) ? 'websocket' : /socket\.?io/.test(proto) ? 'socketio' : 'websocket';
    if (!/mqtt|kafka|wss?|websocket|socket/.test(proto)) warnings.push(`Server protocol "${proto || 'none'}": imported as WebSocket exchanges; change the protocol of each request if needed.`);
    const host = ver.startsWith('3') ? `${server?.host ?? ''}${server?.pathname ?? ''}` : String(server?.url ?? '').replace(/^[a-z+]+:\/\//i, '');
    const scheme = protocol === 'mqtt' ? (/mqtts|secure/.test(proto) ? 'mqtts' : 'mqtt') : protocol === 'kafka' ? (/secure|ssl/.test(proto) ? 'kafkas' : 'kafka') : protocol === 'socketio' ? 'https' : (/wss|secure/.test(proto) ? 'wss' : 'ws');
    const url = host ? `${scheme}://${host}`.replace(/\{(\w+)\}/g, '{{$1}}') : '';
    if (servers.length > 1) warnings.push(`${servers.length} servers: the first (${sname}) was used.`);
    const resolve = (o: any): any => { if (o && o.$ref && typeof o.$ref === 'string') { const p = o.$ref.replace(/^#\//, '').split('/'); let x: any = doc; for (const k of p) x = x?.[k]; return resolve(x); } return o; };
    const sample = (s: any, d = 0): unknown => { s = resolve(s); if (!s || d > 5) return null; if (s.example !== undefined) return s.example; if (s.examples?.[0] !== undefined) return s.examples[0]; if (s.enum) return s.enum[0];
        if (s.type === 'object' || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, x]) => [k, sample(x, d + 1)])); if (s.type === 'array') return [sample(s.items, d + 1)];
        return s.type === 'integer' || s.type === 'number' ? 0 : s.type === 'boolean' ? false : s.format === 'date-time' ? '2026-01-31T10:00:00Z' : ''; };
    const msgText = (m: any): string => { m = resolve(m); const ex = m?.examples?.[0]?.payload ?? m?.payload?.example; const v = ex !== undefined ? ex : sample(m?.payload); return typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
    const items: ApiItem[] = [];
    const channels = (doc.channels ?? {}) as Record<string, any>;
    // AsyncAPI 2: publish = the application receives (we send), subscribe = the application sends (we expect).
    // AsyncAPI 3: operations with action send / receive on a channel.
    const add = (name: string, topic: string, send: boolean, message: any, desc?: string) => {
        const r: ApiRequest = { ...newRequest(name), url, checks: [], ...(desc ? { description: desc } : {}) };
        const t = topic.replace(/\{(\w+)\}/g, '{{$1}}');
        const options = protocol === 'mqtt' || protocol === 'kafka' ? { subscribe: [protocol === 'mqtt' ? t.replace(/\{\{\w+\}\}/g, '+') : t] } : undefined;
        r.ws = { protocol, ...(options ? { options } : {}), steps: send ? [{ kind: 'send', text: msgText(message), ...(protocol === 'websocket' ? {} : { topic: t }) }, { kind: 'expect', text: '', ...(protocol === 'websocket' ? {} : { topic: t }), timeoutMs: 10_000 }]
            : [{ kind: 'expect', text: '', ...(protocol === 'websocket' ? {} : { topic: t }), timeoutMs: 30_000 }] };
        items.push(r);
    };
    if (ver.startsWith('2')) {
        for (const [name, ch] of Object.entries(channels)) {
            if (ch.publish) add(ch.publish.operationId ?? `Send to ${name}`, name, true, ch.publish.message?.oneOf?.[0] ?? ch.publish.message, ch.publish.summary ?? ch.description);
            if (ch.subscribe) add(ch.subscribe.operationId ?? `Receive from ${name}`, name, false, ch.subscribe.message, ch.subscribe.summary ?? ch.description);
        }
    } else {
        for (const [id, op0] of Object.entries((doc.operations ?? {}) as Record<string, any>)) {
            const op = resolve(op0);
            const ch = resolve(op.channel);
            const chName = ch?.address ?? Object.keys(channels).find((k) => resolve(channels[k]) === ch) ?? id;
            const msg = op.messages?.[0] ?? Object.values(ch?.messages ?? {})[0];
            add(op.title ?? id, String(chName), op.action === 'send', msg, op.summary ?? op.description);
        }
    }
    if (!items.length) throw new Error('No channels with operations in this AsyncAPI document.');
    c.items = items;
    warnings.push(`${items.length} ${protocol === 'websocket' ? 'WebSocket' : protocol.toUpperCase()} exchange(s): "send" operations publish a sample message and wait for an answer; "receive" ones wait for a message. Adjust the expected texts.`);
    return done(c, warnings);
}

// ---------------------------------------------------------------------------------------------------- GraphQL schema
export function importGraphqlSchema(text: string, endpoint = '{{graphqlUrl}}'): ImportResult {
    let schema;
    try { schema = buildSchema(text); } catch (e) { throw new Error(`Not a GraphQL schema (SDL): ${(e as Error).message}`); }
    const c = newCollection('GraphQL API');
    c.variables = endpoint === '{{graphqlUrl}}' ? [{ key: 'graphqlUrl', value: 'https://api.example.com/graphql' }] : [];
    const items: ApiItem[] = [];
    for (const root of ['query', 'mutation'] as const) {
        const t = root === 'query' ? schema.getQueryType() : schema.getMutationType();
        if (!t) continue;
        const reqs = Object.keys(t.getFields()).map((f) => {
            const op = operationFor(schema, root, f);
            return { ...newRequest(`${root === 'query' ? 'Query' : 'Mutation'} ${f}`), method: 'POST' as const, url: endpoint, body: { mode: 'graphql' as const, graphql: { query: op.query, ...(op.variables ? { variables: op.variables } : {}), operationName: op.operationName } },
                checks: [{ kind: 'status' as const, value: '200' }, { kind: 'bodyNotContains', value: '"errors"' } as ApiRequest['checks'][number]] };
        });
        if (reqs.length) items.push(folder(root === 'query' ? 'Queries' : 'Mutations', reqs));
    }
    if (!items.length) throw new Error('The schema has no Query or Mutation type.');
    c.items = items;
    return done(c, schema.getSubscriptionType() ? ['Subscriptions are not imported (they need a WebSocket GraphQL client).'] : []);
}

/** The importer for a file, by its content. */
export function detectImport(text: string): 'insomnia' | 'soapui' | 'jmeter' | 'raml' | 'asyncapi' | 'graphql' | 'postman' | 'openapi' | 'wsdl' | 'har' | null {
    const t = text.trim();
    if (/^#%RAML/.test(t)) return 'raml';
    if (t.startsWith('<')) return /<jmeterTestPlan/.test(t) ? 'jmeter' : /soapui-project/.test(t) ? 'soapui' : /wsdl|definitions/.test(t.slice(0, 2000)) ? 'wsdl' : null;
    if (/^(type|schema|scalar|enum|input|interface|union|directive|extend)\s/m.test(t) && !t.startsWith('{')) return 'graphql';
    let o: any;
    try { o = t.startsWith('{') ? JSON.parse(t) : yaml.load(t); } catch { return null; }
    if (o?._type === 'export') return 'insomnia';
    if (o?.asyncapi) return 'asyncapi';
    if (o?.openapi || o?.swagger) return 'openapi';
    if (o?.info?.schema?.includes?.('getpostman') || (o?.info && Array.isArray(o?.item))) return 'postman';
    if (o?.log?.entries) return 'har';
    return null;
}
