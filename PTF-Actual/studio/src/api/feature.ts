/**
 * Turn an API collection into a framework feature file that uses only the framework's built-in
 * API steps (the "I …" steps of CSAPIGenericSteps / CSAPIRequestSteps / CSAPIValidationSteps, the
 * way the akhan-api examples are written), so no step code has to be written.
 *
 * Rules that keep the feature correct (verified against framework 1.54):
 *  - @api tag: the framework starts no browser and loads its API steps.
 *  - Query parameters go into the URL of the send step: the framework keeps "I set query parameter"
 *    values for every later request of the scenario.
 *  - One scenario per request; requests that use a value saved by an earlier one ({{name}}) stay in
 *    the same scenario, in order.
 *  - Bearer tokens and API keys are request headers (the header step fills {{name}}).
 *  - Headers and basic authentication stay on the API context for every later request (even the next
 *    scenario): the Background clears them, and so does each later request of a chained scenario.
 *  - A body always comes with its Content-Type: with a form Content-Type left over, the framework
 *    would send a JSON body as form fields.
 *  - Form bodies use "user sets form field": the framework URL-encodes the values when it sends them
 *    (a doc string would be sent as written, and a {{value}} containing & would split the field).
 *  - {config:KEY} / {env:NAME} in step text are filled by the framework; inside a request body they
 *    are not, so they are copied into a variable first ("I set variable …") and used as {{name}}.
 *  - {string} is "…" or '…' without escapes; {int} only matches 0-9 digits.
 */
import { allRequests, ApiAuth, ApiCheck, ApiCollection, ApiData, ApiExtract, ApiRequest, Expected, graphqlAsJson, KV, PROTOCOL_LABEL, slug } from './model';
import { expectedValue } from './jsonPath';
import type { CollectionCode } from './codegen/collection';

/** usesChecks: the feature uses the project's generic response steps (helpers/ApiResponseChecks.ts). */
export interface FeatureResult { text: string; scenarios: number; warnings: string[]; usesChecks: boolean }

export interface FeatureOptions {
    tags?: string[];
    /** The collection's own code (database checks, prepared data): the steps the feature uses for them. */
    code?: CollectionCode | null;
    /** The columns of a request's data file (to set the payload template's values from the row). */
    columns?: (data: ApiData) => string[];
    /** The {{names}} of a payload template file. */
    templateVars?: (file: string) => string[];
    /** The project's framework has WebSocket steps: WebSocket requests are written with them (else left out). */
    wsSteps?: boolean;
    /** The framework has the messaging steps (Socket.IO, MQTT, Kafka, gRPC). */
    msgSteps?: boolean;
    /** Whether a file a multipart part sends is in the project (a missing one is said in the warnings). */
    fileExists?: (path: string) => boolean;
}

/** The text of an expected value in a step: as written, {{saved}}, <column> or {config:KEY}. */
export function expectedText(e: Expected | undefined): string {
    if (!e) return '';
    const v = e.value.trim();
    switch (e.from) {
        case 'saved': return `{{${v}}}`;
        case 'data': return `<${v}>`;
        case 'config': return `{config:${v}}`;
        default: return e.value;
    }
}

/** A value reference of the project's generic steps: $.path, xml:/path, header:Name, cookie:name, status, time, size, body. */
export function valueRef(ch: Pick<ApiCheck, 'source' | 'target'>): string {
    const t = (ch.target ?? '').trim();
    switch (ch.source ?? 'json') {
        case 'json': return t || '$';
        case 'xml': return `xml:${t}`;
        case 'header': return `header:${t}`;
        case 'cookie': return `cookie:${t}`;
        default: return ch.source ?? 'body';
    }
}

/** A {string} argument, or null when it cannot be written (contains both quote kinds). */
export function quote(s: string): string | null {
    // A step is one line: a value with a line break cannot be an argument (it would break the feature).
    if (/[\r\n]/.test(s)) return null;
    if (!s.includes('"')) return `"${s}"`;
    if (!s.includes("'")) return `'${s}'`;
    return null;
}

const on = (kv: KV) => kv.enabled !== false && kv.key.trim() !== '';
const usesVar = (s: string | undefined) => [...(s ?? '').matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]);

/** Text of a request that may use {{variables}} (to find which earlier request it depends on). */
function requestText(r: ApiRequest, a: ApiAuth): string {
    return [r.url, ...r.query.filter(on).flatMap((q) => [q.key, q.value]), ...r.headers.filter(on).flatMap((h) => [h.key, h.value]), r.body.text ?? '',
        ...(r.body.form ?? []).flatMap((f) => [f.key, f.value]), a.username ?? '', a.password ?? '', a.token ?? '', a.value ?? '',
        r.body.graphql?.query ?? '', r.body.graphql?.variables ?? '', ...(r.ws?.steps ?? []).flatMap((s) => [s.text, s.topic ?? '', s.key ?? ''])].join('\n');
}

export function toFeature(c: ApiCollection, opts: FeatureOptions = {}): FeatureResult {
    const warnings: string[] = [];
    const used = { checks: false };
    const lines: string[] = [];
    const q = (s: string, where: string): string => {
        const x = quote(s);
        if (x === null) { warnings.push(`${where}: the value ${/[\r\n]/.test(s) ? 'has a line break' : 'contains both " and \''}, which a step cannot hold; written as a comment.`); return `\u0000${JSON.stringify(s)}\u0001`; }
        return x;
    };
    const tags = ['@api', `@${slug(c.name)}`, ...(opts.tags ?? [])];
    lines.push(tags.join(' '));
    lines.push(`Feature: ${oneLine(c.name)}`);
    for (const d of (c.description ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 10)) lines.push(`  ${d}`);
    lines.push('');

    // Background: the API context, the base URL, the collection's variables.
    const bg: string[] = [];
    bg.push(`Given user is working with ${q(oneLine(c.name), 'Collection name')} API`);
    const base = c.baseUrl.trim();
    if (base) {
        bg.push(`And the API base URL is ${q(base, 'Base URL')}`);
    }
    // Headers and basic auth set by an earlier scenario would still be sent.
    bg.push('And user clears all request headers');
    bg.push('And I clear authentication');
    const saved = new Set(allRequests(c.items).flatMap(({ request }) => request.extract.map((e) => e.variable)));
    for (const v of c.variables.filter(on)) {
        if (saved.has(v.key)) continue; // set by a request
        bg.push(`And I set variable ${q(v.key, `Variable ${v.key}`)} to ${q(v.value, `Variable ${v.key}`)}`);
    }
    lines.push('  Background:');
    for (const s of bg) lines.push(s.includes('\u0000') ? `    # ${s.replace(/\u0000(.*?)\u0001/g, '$1')}` : `    ${s}`);

    // Group requests: a request that uses a value saved earlier joins that request's scenario.
    const all = allRequests(c.items);
    // WebSocket exchanges: with the framework's WebSocket steps, or (an older framework) left to the Studio.
    const isMsg = (r: ApiRequest) => !!r.ws?.protocol && r.ws.protocol !== 'websocket';
    const wsReqs = all.filter((x) => x.request.ws && !isMsg(x.request));
    const msgReqs = all.filter((x) => isMsg(x.request));
    if (wsReqs.length && !opts.wsSteps) warnings.push(`${wsReqs.map((x) => `"${x.request.name}"`).join(', ')}: WebSocket exchanges are not written to the feature (the project's framework version has no WebSocket steps); run them with the collection runner or a load test.`);
    if (msgReqs.length && !opts.msgSteps) warnings.push(`${msgReqs.map((x) => `"${x.request.name}"`).join(', ')}: Socket.IO, MQTT, Kafka and gRPC exchanges are not written to the feature (the project's framework version has no messaging steps); run them with the collection runner or a load test.`);
    const reqs = all.filter((x) => !x.request.ws || (isMsg(x.request) ? opts.msgSteps : opts.wsSteps));
    const groups = scenarioGroups(c, reqs);

    for (const g of groups) {
        const first = g[0];
        lines.push('');
        const scTags = [...new Set(g.flatMap((x) => x.folders.map((f) => `@${slug(f)}`)))];
        if (scTags.length) lines.push(`  ${scTags.join(' ')}`);
        const data = g.find((x) => x.request.data?.source?.trim())?.request.data;
        lines.push(`  Scenario${data ? ' Outline' : ''}: ${oneLine(g.length > 1 ? g.map((x) => x.request.name).join(', then ') : first.request.name)}`);
        g.forEach((item, i) => {
            const steps = requestSteps(c, item.request, q, i > 0, warnings, { ...opts, data, used });
            if (i > 0) lines.push('');
            if (g.length > 1) lines.push(`    # ${oneLine(item.request.name)}`);
            for (const s of steps) lines.push(s.includes('\u0000') ? `    # ${s.replace(/\u0000(.*?)\u0001/g, '$1')}` : `    ${s}`);
        });
        if (data) {
            // The framework's external Examples: the project's data file, one run per row (filtered).
            const ex: Record<string, string> = { type: data.type, source: data.source.trim() };
            if (data.type === 'excel' && data.sheet?.trim()) ex.sheet = data.sheet.trim();
            if (data.type === 'json') ex.path = data.path?.trim() || '$';
            if (data.filter?.trim()) ex.filter = data.filter.trim();
            lines.push('', `    Examples: {${Object.entries(ex).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`);
        }
    }
    return { text: lines.join('\n') + '\n', scenarios: groups.length, warnings, usesChecks: used.checks };
}

/**
 * The scenarios of a collection's feature: requests in order; a request that uses a value saved by an earlier one
 * joins that one's scenario (so the value is there), the others start a scenario of their own.
 */
export function scenarioGroups<T extends { request: ApiRequest }>(c: Pick<ApiCollection, 'auth'>, reqs: T[]): T[][] {
    const groups: T[][] = [];
    const savedBy = new Map<string, number>();
    for (const item of reqs) {
        const auth = item.request.auth.type === 'inherit' ? c.auth : item.request.auth;
        const needs = usesVar(requestText(item.request, auth)).filter((n) => savedBy.has(n));
        const from = [...new Set(needs.map((n) => savedBy.get(n)!))].sort((a, b) => a - b);
        // Values saved in several scenarios: they become one scenario (the earliest), in their order.
        for (const other of from.slice(1)) {
            groups[from[0]].push(...groups[other]);
            groups[other] = [];
            for (const [k, v] of savedBy) if (v === other) savedBy.set(k, from[0]);
        }
        const g = from.length ? from[0] : groups.push([]) - 1;
        groups[g].push(item);
        for (const e of item.request.extract) if (e.variable.trim()) savedBy.set(e.variable.trim(), g);
        for (const st of item.request.ws?.steps ?? []) if (st.save?.variable?.trim()) savedBy.set(st.save.variable.trim(), g);
    }
    return groups.filter((g) => g.length);
}

/** {{names}} a request uses (URL, headers, body, sign-in, messages). */
export function requestUses(r: ApiRequest, c: Pick<ApiCollection, 'auth'>): string[] {
    return usesVar(requestText(r, r.auth.type === 'inherit' ? c.auth : r.auth));
}

function oneLine(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

/** Steps of one request: headers/auth, body, send, checks, saved values (with keywords). */
function requestSteps(c: ApiCollection, r: ApiRequest, q: (s: string, where: string) => string, later: boolean, warnings: string[],
    o: FeatureOptions & { data?: ApiData; used: { checks: boolean } } = { used: { checks: false } }): string[] {
    const where = `Request "${r.name}"`;
    // GraphQL: the framework sends it as the JSON body it is (query, variables).
    r = graphqlAsJson(r);
    const comments: string[] = [];
    for (const n of r.notes ?? []) comments.push(`# ${oneLine(n)}`);
    for (const d of (r.description ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 5)) comments.push(`# ${d}`);

    const setup: string[] = [];   // steps without keyword
    // Prepared test data first (the row's values, or defaults): the request below uses them.
    const prep = o.code?.prepareStep.get(r);
    if (prep) setup.push(prep);
    else if ((r.prepare ?? []).some((p) => p.name.trim())) warnings.push(`${where}: its prepared test data needs the collection's code.`);
    // A later request of a chained scenario: the earlier request's headers and auth would be sent too.
    if (later) setup.push('user clears all request headers', 'I clear authentication');
    const body: string[] = [];    // doc string lines of the last setup step
    const headers: Array<[string, string]> = r.headers.filter(on).map((h) => [h.key, h.value]);
    // The request's own Authorization header wins over the collection's authentication (as when sending).
    const auth = r.auth.type === 'inherit' ? (headers.some(([k]) => k.toLowerCase() === 'authorization') && !(c.auth.type === 'none' || (c.auth.type === 'apikey' && (c.auth.in === 'query' || (c.auth.key ?? '').toLowerCase() !== 'authorization'))) ? { type: 'none' as const } : c.auth) : r.auth;
    const query: Array<[string, string]> = r.query.filter(on).map((x) => [x.key, x.value]);
    const tables: Record<number, string[]> = {}; // data-table lines after a setup step
    const cell = (v?: string) => (v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    if (auth.type === 'basic') setup.push(`I use basic authentication with username ${q(auth.username ?? '', where)} and password ${q(auth.password ?? '', where)}`);
    else if (auth.type === 'oauth2') {
        // The framework fills {env:}/{config:} in table cells (verified); a {{value}} is not filled there.
        const rows: Array<[string, string | undefined]> = [['clientId', auth.clientId], ['clientSecret', auth.clientSecret], ['tokenUrl', auth.tokenUrl], ['scope', auth.scope]];
        if (auth.grant === 'password') rows.push(['username', auth.username], ['password', auth.password]);
        if (rows.some(([, v]) => /\{\{/.test(v ?? ''))) warnings.push(`${where}: OAuth2 values with {{…}} are not filled in by the framework's OAuth2 step; use {env:NAME} or {config:KEY}.`);
        const browser = auth.grant === 'authorization_code' || auth.grant === 'implicit' || auth.grant === 'device_code';
        if (browser || auth.grant === 'refresh_token') {
            // A browser sign-in cannot run in a pipeline: the test renews tokens with a refresh token (a secret).
            const rt = auth.grant === 'refresh_token' && auth.refreshToken ? auth.refreshToken : '{env:OAUTH_REFRESH_TOKEN}';
            if (browser) warnings.push(`${where}: OAuth 2.0 ${auth.grant} signs in through a browser, which a pipeline cannot do: the test uses a refresh token instead (secret OAUTH_REFRESH_TOKEN, from a sign-in in the Studio or the provider).`);
            setup.push('I use OAuth2 with refresh token:');
            tables[setup.length - 1] = ([['tokenUrl', auth.tokenUrl], ['clientId', auth.clientId], ['clientSecret', auth.clientSecret], ['refreshToken', rt], ['scope', auth.scope]] as Array<[string, string | undefined]>)
                .filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `  | ${k} | ${cell(v)} |`);
        } else {
            setup.push(auth.grant === 'password' ? 'I use OAuth2 with password grant:' : 'I use OAuth2 with client credentials:');
            tables[setup.length - 1] = rows.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `  | ${k} | ${cell(v)} |`);
        }
    }
    else if (auth.type === 'jwt') {
        const alg = auth.algorithm ?? 'HS256';
        setup.push(`I use JWT signed with ${q(alg, where)} and key ${q(/^HS/.test(alg) ? auth.secret ?? '' : auth.privateKey ?? '', where)} with claims:`);
        let claims = auth.payload?.trim() || '{}';
        try { claims = JSON.stringify(JSON.parse(claims), null, 2); } catch { /* as written ({{vars}}) */ }
        tables[setup.length - 1] = ['  """', ...claims.split('\n').map((l) => `  ${l}`), '  """'];
        if (auth.queryKey?.trim() || (auth.prefix && auth.prefix !== 'Bearer') || auth.jwtHeader?.trim()) warnings.push(`${where}: the framework's JWT step sends "Authorization: Bearer <token>" without extra header fields; the query parameter / prefix / header set here are not in the test.`);
    }
    else if (auth.type === 'aws') setup.push(`I use AWS signature authentication with access key ${q(auth.accessKey ?? '', where)} secret key ${q(auth.secretKey ?? '', where)} region ${q(auth.region ?? 'us-east-1', where)} and service ${q(auth.service ?? 'execute-api', where)}`);
    else if (auth.type === 'oauth1') {
        setup.push('I use OAuth 1.0 with:');
        tables[setup.length - 1] = ([['consumerKey', auth.consumerKey], ['consumerSecret', auth.consumerSecret], ['token', auth.token], ['tokenSecret', auth.tokenSecret], ['signatureMethod', auth.signatureMethod], ['privateKey', auth.privateKey], ['realm', auth.realm]] as Array<[string, string | undefined]>)
            .filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `  | ${k} | ${cell(v)} |`);
    }
    else if (auth.type === 'hawk') {
        setup.push('I use Hawk authentication with:');
        tables[setup.length - 1] = ([['id', auth.hawkId], ['key', auth.hawkKey], ['algorithm', auth.algorithm ?? 'sha256'], ['ext', auth.ext], ['payloadHash', auth.payloadHash ? 'true' : undefined]] as Array<[string, string | undefined]>)
            .filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `  | ${k} | ${cell(v)} |`);
    }
    else if (auth.type === 'negotiate') setup.push(auth.spn ? `I use Kerberos authentication with service principal ${q(auth.spn, where)}` : 'I use Kerberos authentication');
    else if (auth.type === 'edgegrid') setup.push(`I use Akamai EdgeGrid with client token ${q(auth.clientToken ?? '', where)} client secret ${q(auth.clientSecret ?? '', where)} and access token ${q(auth.accessToken ?? '', where)}`);
    else if (auth.type === 'asap') setup.push(`I use ASAP authentication with issuer ${q(auth.issuer ?? '', where)} audience ${q(auth.audience ?? '', where)} key id ${q(auth.keyId ?? '', where)} and private key ${q(auth.privateKey ?? '', where)}`);
    else if (auth.type === 'digest') setup.push(`I use digest authentication with username ${q(auth.username ?? '', where)} and password ${q(auth.password ?? '', where)}`);
    else if (auth.type === 'ntlm') setup.push(`I use NTLM authentication with domain ${q(auth.domain ?? '', where)} username ${q(auth.username ?? '', where)} and password ${q(auth.password ?? '', where)}`);
    else if (auth.type === 'bearer') { if ((auth.token ?? '').trim()) headers.unshift(['Authorization', `Bearer ${auth.token}`]); else warnings.push(`${where}: the bearer token is empty; no Authorization header is sent.`); }
    else if (auth.type === 'apikey' && auth.key) (auth.in === 'query' ? query : headers).unshift([auth.key, auth.value ?? '']);

    let bodyText: string | undefined;
    const payloadFile = r.body.mode === 'file' && r.body.file?.trim() ? r.body.file.trim() : undefined;
    if (r.body.mode === 'file' && !payloadFile) warnings.push(`${where}: no payload file chosen.`);
    const formFields = r.body.mode === 'form' ? (r.body.form ?? []).filter(on) : [];
    const parts = r.body.mode === 'multipart' ? (r.body.parts ?? []).filter(on) : [];
    if (r.body.mode === 'form') {
        if (!headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    } else if (r.body.mode !== 'none' && r.body.mode !== 'multipart' && r.body.mode !== 'file') bodyText = r.body.text ?? '';
    // A body goes with POST/PUT/PATCH, and with any other method that has one (DELETE with a body, PROPFIND, REPORT…).
    const hasBody = r.body.mode !== 'none' && (bodyText !== undefined ? bodyText.trim() !== '' : true);
    const withBody = ['POST', 'PUT', 'PATCH'].includes(r.method) || hasBody;
    // The framework's "I send a GET/DELETE request" steps send no body; "user sends "<METHOD>" request" sends any method with the body set.
    const named = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && !(hasBody && (r.method === 'GET' || r.method === 'DELETE'));
    if (bodyText !== undefined && r.body.mode !== 'form' && r.body.mode !== 'multipart' && withBody && !headers.some(([k]) => k.toLowerCase() === 'content-type')) {
        headers.push(['Content-Type', r.body.mode === 'json' ? 'application/json' : r.body.mode === 'xml' ? 'application/xml' : 'text/plain']);
    }
    for (const [k, v] of headers) setup.push(`I set request header ${q(k, where)} to ${q(v, where)}`);
    // How it is sent: the framework's own steps for each setting.
    const st = r.settings;
    if (st?.timeoutMs) setup.push(`user sets request timeout to ${Math.max(1, Math.round(st.timeoutMs / 1000))} seconds`);
    if (st?.followRedirects === false) setup.push('user disables redirect following for request');
    if (st?.retries) setup.push(`user sets retry count to ${st.retries}`);
    if (st?.retries && st.retryDelayMs !== undefined) setup.push(`user sets retry delay to ${st.retryDelayMs} milliseconds`);
    if (st?.insecure) setup.push('user disables SSL certificate validation');

    if (payloadFile && withBody) {
        // The template's {{names}} come from the test data: the row's columns are set as test data.
        const cols = o.data && o.columns ? o.columns(o.data) : [];
        const prepared = new Set((r.prepare ?? []).map((p) => p.name.trim()));
        for (const v of o.templateVars?.(payloadFile) ?? []) if (cols.includes(v) && !prepared.has(v)) setup.push(`user set test data ${q(v, where)} to ${q(`<${v}>`, where)}`);
    } else if (bodyText !== undefined && withBody) {
        // {config:}/{env:} are not filled inside a doc string: through a variable.
        bodyText = bodyText.replace(/\{(config|env):([\w.-]+)\}/g, (_m, kind: string, key: string) => {
            const name = `${kind}_${key}`.replace(/[^\w]/g, '_');
            setup.push(`I set variable ${q(name, where)} to ${q(`{${kind}:${key}}`, where)}`);
            return `{{${name}}}`;
        });
        if (r.body.mode === 'json' && bodyText.trim()) { try { bodyText = JSON.stringify(JSON.parse(bodyText), null, 2); } catch { /* {{vars}} outside strings: keep as written */ } }
        if (bodyText.includes('"""')) warnings.push(`${where}: the body contains """, which ends a Gherkin doc string.`);
        setup.push('I set request body to:');
        body.push('  """', ...bodyText.split('\n').map((l) => `  ${l}`), '  """');
    } else if (parts.length && withBody) {
        warnings.push(`${where}: multipart uploads need framework 1.55.0 or later (in 1.54.0 and earlier the multipart steps send "[object Object]" instead of the fields and files).`);
        if (later) setup.push('I set request body to:');
        for (const part of parts) if (part.type === 'file' && o.fileExists && !/\{\{/.test(part.value) && !o.fileExists(part.value)) warnings.push(`${where}: the file "${part.value}" of the part "${part.key}" is not in the project: add it before running the test.`);
        for (const part of parts) setup.push(part.type === 'file' ? `user adds file ${q(part.value, where)} as ${q(part.key, where)} to multipart` : `user sets multipart field ${q(part.key, where)} to ${q(part.value, where)}`);
    } else if (formFields.length && withBody) {
        // Form fields through the framework's form step: it fills {{name}} / {env:} / {config:} and
        // URL-encodes the values when sending (a value with & or = stays whole). It adds to an
        // object body set earlier in the scenario, so a later request starts from an empty body.
        if (later) setup.push('I set request body to:');
        for (const f of formFields) setup.push(`user sets form field ${q(f.key, where)} to ${q(f.value, where)}`);
    } else if (later && (withBody || !named)) {
        // The body of an earlier request of the scenario would be sent again.
        setup.push('I set request body to:');
        body.push('  """', '  """');
    }

    let url = r.url.trim();
    if (query.length) url += (url.includes('?') ? '&' : '?') + query.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
    // A WebSocket exchange: connect (with the headers set above), its steps in order, close.
    if (r.ws && r.ws.protocol && r.ws.protocol !== 'websocket') {
        // Socket.IO, MQTT, Kafka, gRPC: the framework's messaging steps (connect with its options, send, expect, save).
        const x = r.ws, op = x.options ?? {};
        const label = PROTOCOL_LABEL[x.protocol ?? 'websocket'];
        const out = [...comments];
        setup.forEach((st, i) => { out.push(`${i ? 'And' : 'Given'} ${st}`); if (tables[i]) out.push(...tables[i]); });
        const rows: Array<[string, string]> = [];
        if (op.path) rows.push(['path', op.path]);
        if (op.subscribe?.length) rows.push(['subscribe', op.subscribe.join(', ')]);
        if (op.qos !== undefined) rows.push(['qos', String(op.qos)]);
        if (op.clientId) rows.push(['clientId', op.clientId]);
        if (op.groupId) rows.push(['groupId', op.groupId]);
        if (op.sasl) rows.push(['sasl', op.sasl]);
        if (op.fromBeginning) rows.push(['fromBeginning', 'true']);
        if (op.protoFile) rows.push(['protoFile', op.protoFile]);
        if (op.reflection) rows.push(['reflection', 'true']);
        if (op.service) rows.push(['service', op.service]);
        if (op.method) rows.push(['method', op.method]);
        const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `${c.baseUrl.replace(/\/+$/, '')}${url.startsWith('/') || !url ? '' : '/'}${url}`;
        out.push(`When user connects to ${q(absolute, where)} over ${q(label, where)}${rows.length ? ' with:' : ''}`);
        const cellOf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
        for (const [k, v] of rows) out.push(`  | ${k} | ${cellOf(v)} |`);
        let expectSeen = false;
        for (const st of x.steps) {
            if (st.kind === 'send') {
                const doc = /[\n"]/.test(st.text) && !st.text.includes('"""');
                if (st.key) out.push(`And user sends message ${q(st.text, where)} to ${q(st.topic ?? '', where)} with key ${q(st.key, where)}`);
                else if (st.topic) { if (doc) out.push(`And user sends message to ${q(st.topic, where)}:`, '  """', ...st.text.split('\n').map((l) => `  ${l}`), '  """'); else out.push(`And user sends message ${q(st.text, where)} to ${q(st.topic, where)}`); }
                else if (doc) out.push('And user sends message:', '  """', ...st.text.split('\n').map((l) => `  ${l}`), '  """');
                else out.push(`And user sends message ${q(st.text, where)}`);
                continue;
            }
            const secs = Math.max(1, Math.round((st.timeoutMs ?? 30000) / 1000));
            const kw = expectSeen ? 'And' : 'Then';
            out.push(`${kw} ${st.text ? `user should receive a message containing ${q(st.text, where)}${st.topic ? ` on ${q(st.topic, where)}` : ''} within ${secs} seconds` : st.topic ? `user should receive a message on ${q(st.topic, where)} within ${secs} seconds` : `user should receive a message within ${secs} seconds`}`);
            expectSeen = true;
            if (st.save?.variable?.trim() && st.save.path?.trim()) out.push(`And user saves ${q(st.save.path.trim(), where)} of the message as ${q(st.save.variable.trim(), where)}`);
        }
        out.push('And user closes the connection');
        if (r.checks.length || r.extract.length) warnings.push(`${where}: a ${label} request's HTTP checks and saved values do not apply (its steps check the messages).`);
        return out;
    }
    if (r.ws) {
        const out = [...comments];
        setup.forEach((st, i) => { out.push(`${i ? 'And' : 'Given'} ${st}`); if (tables[i]) out.push(...tables[i]); });
        out.push(`When user connects to WebSocket ${q(url, where)}`);
        let expectSeen = false;
        for (const st of r.ws.steps) {
            if (st.kind === 'send') {
                // A message with line breaks or quotes reads better as a doc string.
                if (/[\n"]/.test(st.text) && !st.text.includes('"""')) out.push('And user sends WebSocket message:', '  """', ...st.text.split('\n').map((l) => `  ${l}`), '  """');
                else out.push(`And user sends WebSocket message ${q(st.text, where)}`);
                continue;
            }
            const secs = Math.max(1, Math.round((st.timeoutMs ?? 30000) / 1000));
            out.push(`${expectSeen ? 'And' : 'Then'} ${st.text ? `user should receive a WebSocket message containing ${q(st.text, where)} within ${secs} seconds` : `user should receive a WebSocket message within ${secs} seconds`}`);
            expectSeen = true;
            if (st.save?.variable?.trim() && st.save.path?.trim()) out.push(`And user saves ${q(st.save.path.trim(), where)} of the WebSocket message as ${q(st.save.variable.trim(), where)}`);
        }
        out.push('And user closes the WebSocket');
        if (r.checks.length || r.extract.length) warnings.push(`${where}: a WebSocket request's HTTP checks and saved values do not apply (its steps check the messages).`);
        return out;
    }
    const send = payloadFile && withBody ? `user send a ${q(r.method, where)} request to ${q(url, where)} with payload file ${q(payloadFile, where)}`
        : named ? `I send a ${r.method} request to ${q(url, where)}` : `user sends ${q(r.method, where)} request to ${q(url, where)}`;

    const after: string[] = [];
    // Values saved first: checks may compare with them ({{name}}).
    for (const e of r.extract.filter((x) => x.variable.trim() && (x.path.trim() || ['status', 'body'].includes(x.from)))) {
        const st = extractStep(e, q, where);
        if (!st.startsWith('user saves response ')) o.used.checks = true;
        after.push(st);
    }
    for (const ch of r.checks) {
        if (ch.kind === 'dbItems') {
            const st = ch.db ? o.code?.dbStep.get(ch.db) : undefined;
            if (st) after.push(st); else warnings.push(`${where}: a database check needs the collection's code.`);
            continue;
        }
        const st = checkStep(ch, q, where);
        if (!st) { warnings.push(`${where}: a "${ch.op ?? ch.kind}" check is incomplete and was left out.`); continue; }
        // A step with a doc string (a JSON schema): its lines follow it, marked.
        const [line, ...doc] = st.split('\n');
        after.push(line, ...doc.map((l) => `\u0001${l}`));
        if (/^the response value /.test(st)) o.used.checks = true;
    }

    const out = [...comments];
    setup.forEach((st, i) => {
        out.push(`${i ? 'And' : 'Given'} ${st}`);
        // The doc string belongs to "I set request body to:" (an empty one when only resetting the body).
        if (st === 'I set request body to:') out.push(...(body.length ? body : ['  """', '  """']));
        if (tables[i]) out.push(...tables[i]);
    });
    if (parts.length) out.unshift('# Note: multipart uploads need framework 1.55.0 or later.');
    out.push(`When ${send}`);
    let first = true;
    for (const st of after) {
        if (st.startsWith('\u0001')) { out.push(st.slice(1)); continue; }
        out.push(`${first ? 'Then' : 'And'} ${st}`);
        first = false;
    }
    return out;
}

/** Keep {{variables}} readable in a URL; encode only what would break it. */
function enc(s: string): string {
    return s.split(/(\{\{[\w.-]+\}\}|\{(?:config|env):[\w.-]+\})/).map((part, i) => (i % 2 ? part : encodeURIComponent(part))).join('');
}

/** The framework step for a check (without its keyword). */
export function checkStep(ch: ApiCheck, q: (s: string, where: string) => string, where: string): string | null {
    const t = ch.target ?? '', v = ch.value ?? '';
    switch (ch.kind) {
        case 'status': return /^\d+$/.test(v.trim()) ? `the response status should be ${v.trim()}` : null;
        case 'statusBetween': return `the response status should be between ${ch.min ?? 200} and ${ch.max ?? 299}`;
        case 'jsonExists': return `the response body JSON path ${q(t, where)} should exist`;
        case 'jsonNotContains': return `the response body JSON path ${q(t, where)} should not contain ${q(v, where)}`;
        case 'jsonEquals': {
            const x = expectedValue(v);
            if (x === true) return `the response body JSON path ${q(t, where)} should be true`;
            if (x === false) return `the response body JSON path ${q(t, where)} should be false`;
            if (x === null) return `the response body JSON path ${q(t, where)} should be null`;
            // {int} only matches 0-9 digits; other numbers compare as text (the framework accepts "1.5" for 1.5).
            if (typeof x === 'number') return Number.isInteger(x) && x >= 0 ? `the response body JSON path ${q(t, where)} should be ${x}` : `the response body JSON path ${q(t, where)} should be ${q(String(x), where)}`;
            return `the response body JSON path ${q(t, where)} should be ${q(String(x), where)}`;
        }
        case 'bodyContains': return `the response body should contain ${q(v, where)}`;
        case 'bodyNotContains': return `the response body should not contain ${q(v, where)}`;
        case 'bodyEmpty': return 'the response body should be empty';
        case 'headerExists': return `the response header ${q(t, where)} should exist`;
        case 'headerEquals': return `the response header ${q(t, where)} should be ${q(v, where)}`;
        case 'headerContains': return `the response header ${q(t, where)} should contain ${q(v, where)}`;
        case 'timeBelow': return /^\d+$/.test(v.trim()) ? `the response time should be less than ${v.trim()} ms` : null;
        case 'schema': {
            if (ch.schemaFile?.trim()) return `response body should match JSON schema in ${q(ch.schemaFile.trim(), where)}`;
            if (!ch.schema?.trim()) return null;
            let text: string;
            try { text = JSON.stringify(JSON.parse(ch.schema), null, 2); } catch { return null; }
            return ['the response body should match schema:', '  """', ...text.split('\n').map((l) => `  ${l}`), '  """'].join('\n');
        }
        case 'rule': return ruleStep(ch, q, where);
        default: return null;
    }
}

/** The step that saves a value of the response. */
export function extractStep(e: ApiExtract, q: (s: string, where: string) => string, where: string): string {
    const name = q(e.variable.trim(), where);
    switch (e.from) {
        case 'header': return `user saves response header ${q(e.path.trim(), where)} as ${name}`;
        case 'json': return `user saves response JSON path ${q(e.path.trim(), where)} as ${name}`;
        case 'regex': return `user saves the match of ${q(e.path, where)} in the response as ${name}`;
        default: return `user saves the response value ${q(valueRef({ source: e.from, target: e.path }), where)} as ${name}`;
    }
}

/**
 * A rule's step: the framework's built-in step where it does exactly this (verified against the
 * framework), else the project's generic step ("the response value … should …").
 */
export function ruleStep(ch: ApiCheck, q: (s: string, where: string) => string, where: string): string | null {
    const op = ch.op ?? 'equals';
    const src = ch.source ?? 'json';
    const t = (ch.target ?? '').trim();
    if (['json', 'xml', 'header', 'cookie'].includes(src) && !t) return null;
    const needs = !['exists', 'notExists', 'empty', 'notEmpty'].includes(op);
    const e = ch.expected;
    if (needs && (!e || (!e.value.trim() && e.from !== 'text' && e.from !== 'query') || (e.from === 'query' && (!e.query?.trim() || !e.connection?.trim() || !e.column?.trim())))) return null;
    if (op === 'between' && (!ch.expected2 || !expectedText(ch.expected2).trim())) return null;
    const exp = expectedText(e);
    const plain = (!ch.compare || ch.compare === 'text') && !ch.ignoreCase && ch.tolerance === undefined;
    const ref = q(valueRef(ch), where);
    // An expected value from a database query (the first row's column).
    if (e?.from === 'query') {
        if (op !== 'equals') return null;
        const params = (e.params ?? []).map((x) => x.trim()).filter(Boolean);
        return `the response value ${ref} should be the ${q(e.column!.trim(), where)} of query ${q(e.query!.trim(), where)} on ${q(e.connection!.trim(), where)}${params.length ? ` with parameters ${q(params.join(' | '), where)}` : ''}`;
    }
    // The framework's built-in steps, where they do exactly this.
    if (src === 'status' && op === 'equals' && (/^\d+$/.test(exp.trim()) || e?.from === 'data')) return `the response status should be ${exp.trim()}`;
    if (src === 'time' && op === 'less' && /^\d+$/.test(exp.trim())) return `the response time should be less than ${exp.trim()} ms`;
    if (src === 'json' && plain) {
        if (op === 'equals') return `the response body JSON path ${q(t, where)} should be ${q(exp, where)}`;
        if (op === 'exists') return `the response body JSON path ${q(t, where)} should exist`;
        if (op === 'type' && ['string', 'number', 'boolean', 'object', 'array', 'null'].includes(exp.trim())) return `response JSON path ${q(t, where)} should be of type ${q(exp.trim(), where)}`;
        if (op === 'count' && /^\d+$/.test(exp.trim())) return `response JSON path ${q(t, where)} array should have length ${exp.trim()}`;
    }
    if (src === 'header' && plain) {
        if (op === 'equals') return `the response header ${q(t, where)} should be ${q(exp, where)}`;
        if (op === 'contains') return `the response header ${q(t, where)} should contain ${q(exp, where)}`;
        if (op === 'exists') return `the response header ${q(t, where)} should exist`;
    }
    if (src === 'cookie' && op === 'exists') return `response cookie ${q(t, where)} should exist`;
    // The framework's XML step reads absolute paths of elements, [n] and a last @attribute (not //).
    if (src === 'xml' && op === 'equals' && plain && /^\/[\w:.-]+(\[\d+\])?(\/[\w:.-]+(\[\d+\])?)*(\/@[\w:.-]+)?$/.test(t)) return `response XML path ${q(t, where)} should equal ${q(exp, where)}`;
    if (src === 'body' && plain && op === 'contains') return `the response body should contain ${q(exp, where)}`;
    if (src === 'body' && plain && op === 'notContains') return `the response body should not contain ${q(exp, where)}`;
    // The project's generic steps.
    const x = q(exp, where);
    switch (op) {
        case 'equals':
            if (ch.compare === 'number') return `the response value ${ref} should be the number ${x} within ${q(String(ch.tolerance ?? 0.0001), where)}`;
            if (ch.compare === 'date') return `the response value ${ref} should be the date ${x}`;
            if (ch.compare === 'datetime') return `the response value ${ref} should be the moment ${x}`;
            if (ch.ignoreCase) return `the response value ${ref} should be ${x} ignoring case`;
            return `the response value ${ref} should be ${x}`;
        case 'notEquals': return `the response value ${ref} should not be ${x}`;
        case 'contains': return `the response value ${ref} should contain ${x}`;
        case 'notContains': return `the response value ${ref} should not contain ${x}`;
        case 'matches': return `the response value ${ref} should match ${x}`;
        case 'exists': return `the response value ${ref} should exist`;
        case 'notExists': return `the response value ${ref} should not exist`;
        case 'empty': return `the response value ${ref} should be empty`;
        case 'notEmpty': return `the response value ${ref} should not be empty`;
        case 'type': return `the response value ${ref} should be of type ${x}`;
        case 'count': return `the response value ${ref} should have ${x} items`;
        case 'greater': return `the response value ${ref} should be greater than ${x}`;
        case 'less': return `the response value ${ref} should be less than ${x}`;
        case 'atLeast': return `the response value ${ref} should be at least ${x}`;
        case 'atMost': return `the response value ${ref} should be at most ${x}`;
        case 'between': return `the response value ${ref} should be between ${x} and ${q(expectedText(ch.expected2), where)}`;
        case 'oneOf': return `the response value ${ref} should be one of ${x}`;
        default: return null;
    }
}
