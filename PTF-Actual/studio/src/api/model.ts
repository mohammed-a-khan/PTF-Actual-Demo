/**
 * The API workspace's data: collections of requests, kept as JSON files in the project
 * (test/<project>/api/<name>.collection.json) so they are reviewed and shared through Git like
 * the tests made from them. Secret values are never stored here: a collection refers to them as
 * {env:NAME} (a Studio secret, given to test runs as an environment variable) or {config:KEY}.
 */
/** An HTTP method: the common ones, or any other the API uses (PURGE, PROPFIND, REPORT, LINK…), upper case. */
export type HttpMethod = string;
/** The common methods (offered first). */
export const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
/** A method name as HTTP allows it (a token), upper-cased; null when it is not one. CONNECT cannot be sent as a request. */
export function httpMethod(m: unknown): HttpMethod | null {
    const t = String(m ?? '').trim().toUpperCase();
    return /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(t) && t !== 'CONNECT' ? t : null;
}

export interface KV { key: string; value: string; enabled?: boolean; description?: string }

export type BodyMode = 'none' | 'json' | 'text' | 'xml' | 'form' | 'multipart' | 'file' | 'graphql';
/** A multipart part: a text value, or a file of the project (path from the repository root). */
export interface MultipartPart extends KV { type?: 'text' | 'file' }
/**
 * file: a payload template of the project (a file name under PAYLOAD_BASE_PATH) whose {{name}} are
 * filled from the test data (the framework's "user send a … request to … with payload file …").
 */
export interface ApiBody { mode: BodyMode; text?: string; form?: KV[]; parts?: MultipartPart[]; file?: string; graphql?: GraphqlBody }
/** A GraphQL request: the query (or mutation), its variables (JSON text, may hold {{name}}), the operation to run. */
export interface GraphqlBody { query: string; variables?: string; operationName?: string }

/** The JSON a GraphQL request sends (POST): {"query", "variables", "operationName"}; the variables as written (filled later). */
export function graphqlJson(g: GraphqlBody | undefined): string {
    const vars = g?.variables?.trim() || '{}';
    return `{\n  "query": ${JSON.stringify(g?.query ?? '')},\n  "variables": ${vars}${g?.operationName?.trim() ? `,\n  "operationName": ${JSON.stringify(g.operationName.trim())}` : ''}\n}`;
}

/** A GraphQL request as the JSON request it is on the wire (for the framework's steps and other formats). */
export function graphqlAsJson<T extends { body: ApiBody }>(r: T): T {
    return r.body.mode === 'graphql' ? { ...r, body: { mode: 'json', text: graphqlJson(r.body.graphql) } } : r;
}

export interface ApiAuth {
    /** inherit: the collection's auth. */
    type: 'inherit' | 'none' | 'basic' | 'bearer' | 'apikey' | 'oauth2' | 'ntlm' | 'digest' | 'jwt' | 'aws' | 'oauth1' | 'hawk' | 'edgegrid' | 'asap' | 'negotiate';
    /** Kerberos (Negotiate): the service principal when it is not HTTP@<host>. */
    spn?: string;
    username?: string;
    password?: string;
    /** NTLM: the Windows domain (or write the user as DOMAIN\\user); workstation name (optional). */
    domain?: string;
    workstation?: string;
    token?: string;
    /** API key: header (or query parameter) name and value. */
    key?: string;
    value?: string;
    in?: 'header' | 'query';
    /**
     * OAuth2: a token from tokenUrl. client_credentials and password run unattended; authorization_code (with PKCE),
     * implicit and device_code sign in through the browser once (the Studio keeps and refreshes the token).
     */
    grant?: 'client_credentials' | 'password' | 'authorization_code' | 'implicit' | 'device_code' | 'refresh_token';
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    /** OAuth2 browser grants: the sign-in page, the device code endpoint, PKCE on/off (default on), a fixed refresh token, extra parameters. */
    authUrl?: string;
    deviceUrl?: string;
    pkce?: boolean;
    refreshToken?: string;
    audience?: string;
    /** JWT (signed by the Studio): algorithm (HS256…, RS256…, ES256…, PS256…), HMAC secret or PEM private key, claims (JSON), extra header (JSON), how it is sent. */
    algorithm?: string;
    secret?: string;
    privateKey?: string;
    payload?: string;
    jwtHeader?: string;
    /** Where a JWT goes: Authorization header with this prefix (default Bearer), or a query parameter. */
    prefix?: string;
    queryKey?: string;
    /** AWS Signature v4. */
    accessKey?: string;
    secretKey?: string;
    sessionToken?: string;
    region?: string;
    service?: string;
    /** OAuth 1.0a: consumer key/secret, token (the `token` field) and token secret. */
    consumerKey?: string;
    consumerSecret?: string;
    tokenSecret?: string;
    signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'RSA-SHA1' | 'PLAINTEXT';
    realm?: string;
    /** Hawk. */
    hawkId?: string;
    hawkKey?: string;
    ext?: string;
    payloadHash?: boolean;
    /** Akamai EdgeGrid: client token, client secret (`clientSecret`), access token. */
    clientToken?: string;
    accessToken?: string;
    /** Atlassian ASAP: issuer, audience (`audience`), key id, private key (`privateKey`), subject, lifetime in seconds. */
    issuer?: string;
    keyId?: string;
    subject?: string;
    expiresIn?: number;
}

export type CheckKind =
    /** A pm.test of the request's test script (its result only; not editable as a check). */
    | 'script'
    | 'status' | 'statusBetween' | 'jsonExists' | 'jsonEquals' | 'jsonNotContains'
    | 'bodyContains' | 'bodyNotContains' | 'bodyEmpty'
    | 'headerExists' | 'headerEquals' | 'headerContains' | 'timeBelow'
    /** A value of the response compared with an expected value (any operator, any source of the expected value). */
    | 'rule'
    /** The body matches a JSON schema (written here, or a schema file of the project). */
    | 'schema'
    /** Each item of a list in the response matches the rows a database query returns for it. */
    | 'dbItems';

/** Where a checked (or saved) value comes from in the response. */
export type ValueSource = 'json' | 'xml' | 'header' | 'cookie' | 'status' | 'time' | 'size' | 'body';
export const VALUE_SOURCES: ValueSource[] = ['json', 'xml', 'header', 'cookie', 'status', 'time', 'size', 'body'];

export type Operator =
    | 'equals' | 'notEquals' | 'contains' | 'notContains' | 'matches' | 'exists' | 'notExists'
    | 'empty' | 'notEmpty' | 'type' | 'count' | 'greater' | 'less' | 'atLeast' | 'atMost' | 'between' | 'oneOf';
export const OPERATORS: Operator[] = ['equals', 'notEquals', 'contains', 'notContains', 'matches', 'exists', 'notExists', 'empty', 'notEmpty', 'type', 'count', 'greater', 'less', 'atLeast', 'atMost', 'between', 'oneOf'];

/**
 * An expected value:
 *   text    as written ({{saved}} and <column> inside are filled too)
 *   saved   a value saved earlier in the scenario ({{name}})
 *   data    a column of the scenario's test data row (<column>)
 *   config  a configuration key ({config:KEY})
 *   query   the first row's column of a database query (a DB_QUERY_<NAME> of the project, on a connection)
 */
export interface Expected {
    from: 'text' | 'saved' | 'data' | 'config' | 'query';
    value: string;
    /** query: DB_QUERY_<query> on connection DB_<connection>_*, with parameters (each text, {{saved}} or <column>), the value of column. */
    query?: string;
    connection?: string;
    params?: string[];
    column?: string;
}

/** How two values are compared: as text, as numbers (within a tolerance), as dates (the day only) or as moments. */
export type Compare = 'text' | 'number' | 'date' | 'datetime';

/**
 * Each item of a list in the response checked against a database query run for that item:
 *   items      the list ($.orders)
 *   params     the query's parameters for an item: an item field (orderNo), {{saved}}, <column> or text
 *   rows       the item's list compared with the rows (lines); empty: the item itself with the first row
 *   matchBy    how a row is found for an element of rows (shipDate = SHIP_DT); empty: in order
 *   fields     field = column, compared as text/number/date/datetime
 *   whenNoRows the item's fields expected when the query returns no rows (an error the API reports)
 */
export interface DbItemsRule {
    /** Step wording: "each <title> should match the database" (e.g. "order"). */
    title: string;
    items: string;
    connection: string;
    query: string;
    /** The query's SQL, written to the project's queries file when DB_QUERY_<query> is not there yet. */
    sql?: string;
    params: string[];
    rows?: string;
    matchBy?: { field: string; column: string };
    /** The number of elements of rows equals the number of rows. */
    count?: boolean;
    fields: Array<{ field: string; column: string; compare: Compare; tolerance?: number }>;
    whenNoRows?: Array<{ field: string; value: string }>;
}

export interface ApiCheck {
    kind: CheckKind;
    /** JSON path ($.a.b[0].c), XML path (/a/b), header or cookie name. */
    target?: string;
    /** Expected value. For jsonEquals: its JSON text (42, true, null, "text") or plain text. */
    value?: string;
    min?: number;
    max?: number;
    /** rule: where the value comes from, the operator, the expected value(s) and how they compare. */
    source?: ValueSource;
    op?: Operator;
    expected?: Expected;
    /** between: the upper bound. */
    expected2?: Expected;
    compare?: Compare;
    tolerance?: number;
    ignoreCase?: boolean;
    /** schema: the JSON schema (text), or a schema file of the project (path from the repository root). */
    schema?: string;
    schemaFile?: string;
    /** dbItems: the rule. */
    db?: DbItemsRule;
}

/**
 * Save a value from the response for later requests and checks ({{variable}}): a JSON path, a header,
 * a cookie, the status, an XML path, the first group (or the match) of a regular expression on the
 * body, or the whole body.
 */
export interface ApiExtract { from: 'json' | 'header' | 'cookie' | 'status' | 'xml' | 'regex' | 'body'; path: string; variable: string }

/**
 * The scenario's test data: a data file of the project (JSON, CSV or Excel), one run per row (a
 * Scenario Outline whose Examples read the file), rows chosen by a filter (runFlag=Yes).
 */
export interface ApiData { source: string; type: 'json' | 'csv' | 'excel'; sheet?: string; path?: string; filter?: string }

/**
 * A request value prepared before the request: a test data field that, when the row leaves it empty,
 * takes a value from a database query (all rows' column as a list, or the first row's), today's date,
 * the previous business day, or a fixed text.
 */
export interface ApiPrepare {
    name: string;
    whenEmpty: 'query' | 'today' | 'previousBusinessDay' | 'text';
    /** today / previousBusinessDay: the date format (YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY…). */
    format?: string;
    value?: string;
    query?: string;
    connection?: string;
    params?: string[];
    column?: string;
    /** query: every row's column as a list (orderNos), or only the first row's. */
    list?: boolean;
}

/**
 * A WebSocket exchange (instead of an HTTP request): connect to the URL (ws:// or wss://; an http(s)
 * base URL is switched to ws(s)), then the steps in order: send a message, or wait for a message
 * containing a text (any message when empty), optionally saving a value from it (JSON path).
 */
export interface WsStep {
    kind: 'send' | 'expect'; text: string; timeoutMs?: number; save?: { path: string; variable: string };
    /** MQTT / Kafka topic, Socket.IO event (send: where to; expect: only messages from there, MQTT wildcards + and #). */
    topic?: string;
    /** Kafka message key. */
    key?: string;
}
/** The protocols of a message exchange (connect, send and expect messages). */
export type MsgProtocol = 'websocket' | 'socketio' | 'mqtt' | 'kafka' | 'grpc' | 'amqp' | 'mcp' | 'sql';
export const MSG_PROTOCOLS: MsgProtocol[] = ['websocket', 'socketio', 'mqtt', 'kafka', 'grpc', 'amqp', 'mcp', 'sql'];
export const PROTOCOL_LABEL: Record<MsgProtocol, string> = { websocket: 'WebSocket', socketio: 'Socket.IO', mqtt: 'MQTT', kafka: 'Kafka', grpc: 'gRPC', amqp: 'AMQP', mcp: 'MCP', sql: 'SQL' };
export interface MsgOptions {
    /** Socket.IO: the server's path (default /socket.io). */
    path?: string;
    /** MQTT / Kafka: topics to receive from (subscribed on connect); AMQP: queues / topic subscriptions to receive from. */
    subscribe?: string[];
    /** MQTT: quality of service of publish and subscribe (default 0); client id. */
    qos?: 0 | 1 | 2;
    clientId?: string;
    /** Kafka: consumer group (default: a new one per exchange), SASL mechanism for the request's basic sign-in. */
    groupId?: string;
    sasl?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    /** Kafka: also receive the messages already in the topics (default: only new ones). */
    fromBeginning?: boolean;
    /** gRPC: the .proto file of the project (or the server's reflection), the service (package.Service) and method. */
    protoFile?: string;
    reflection?: boolean;
    service?: string;
    method?: string;
}
export interface WsExchange { steps: WsStep[]; protocol?: MsgProtocol; options?: MsgOptions }

export interface ApiRequest {
    kind: 'request';
    id: string;
    name: string;
    description?: string;
    method: HttpMethod;
    /** Full URL, or a path after the collection's base URL. May use {{variables}}. */
    url: string;
    query: KV[];
    headers: KV[];
    body: ApiBody;
    auth: ApiAuth;
    checks: ApiCheck[];
    extract: ApiExtract[];
    /** Imported parts that could not be converted (e.g. test-script lines), kept for the reader. */
    notes?: string[];
    /** A WebSocket exchange instead of an HTTP request. */
    ws?: WsExchange;
    /** Test data: the scenario of this request runs once per row (only the first request of a scenario). */
    data?: ApiData;
    /** Test data fields prepared before the request (default values when the row leaves them empty). */
    prepare?: ApiPrepare[];
    /** JavaScript with Postman's pm API: before the request is sent, and after the response (pm.test). */
    scripts?: ApiScripts;
    /** Saved example responses (documentation, mocks): what the API answers to this request. */
    examples?: ApiExample[];
    /** How this request is sent (the framework's steps for the same: timeout, redirects, retries, SSL validation). */
    settings?: RequestSettings;
    /** The team's discussion of this request (kept in the file, so it goes through review with the change). */
    comments?: ApiComment[];
    /** The pause after this request when it was recorded (ms): a load path's think time can follow it. */
    recordedThinkMs?: number;
}

export interface ApiComment { id: string; author: string; at: string; text: string; resolved?: boolean; replyTo?: string }

export interface RequestSettings {
    /** Wait at most this long for the answer (default: the runner's). */
    timeoutMs?: number;
    /** false: a redirect (3xx) is the answer, not followed. */
    followRedirects?: boolean;
    /** Send again after a connection error, a 5xx or a 429 (each after retryDelayMs). */
    retries?: number;
    retryDelayMs?: number;
    /** Accept a server certificate that is not trusted (test servers with their own certificate). */
    insecure?: boolean;
    /** Send over HTTP/2 (one connection, requests multiplexed), as browsers do with servers that offer it. */
    http2?: boolean;
    /** Load tests: also load the page's resources (scripts, styles, images of the same site) as a browser does, with its cache. */
    resources?: boolean;
}

export interface ApiScripts { pre?: string; test?: string }

/** An example response of a request; with the request's values it matches (a mock picks the example by them). */
export interface ApiExample {
    id: string;
    name: string;
    status: number;
    headers?: Record<string, string>;
    body?: string;
    /** The request it answers: query parameters and body that must match (empty: any). */
    when?: { query?: Record<string, string>; body?: string };
}
export interface ApiFolder { kind: 'folder'; id: string; name: string; description?: string; items: ApiItem[] }
export type ApiItem = ApiRequest | ApiFolder;

export interface ApiCollection {
    format: 'cs-studio-api/1';
    name: string;
    description?: string;
    /** Prefix for relative request URLs: a URL, or {config:KEY} (e.g. {config:API_BASE_URL}). */
    baseUrl: string;
    /** {{name}} values. Secrets: a reference only ({env:NAME}), never the value. */
    variables: Array<KV & { secret?: boolean }>;
    auth: ApiAuth;
    items: ApiItem[];
    /** Scripts for every request of the collection (run before the request's own). */
    scripts?: ApiScripts;
}

export function newCollection(name: string): ApiCollection {
    return { format: 'cs-studio-api/1', name, baseUrl: '', variables: [], auth: { type: 'none' }, items: [] };
}

export function newRequest(name = 'New request', id = randomId()): ApiRequest {
    return { kind: 'request', id, name, method: 'GET', url: '', query: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, checks: [{ kind: 'status', value: '200' }], extract: [] };
}

export function randomId(): string {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Every request, depth first, with the names of the folders it is in. */
export function allRequests(items: ApiItem[], folders: string[] = []): Array<{ request: ApiRequest; folders: string[] }> {
    const out: Array<{ request: ApiRequest; folders: string[] }> = [];
    for (const it of items) {
        if (it.kind === 'request') out.push({ request: it, folders });
        else out.push(...allRequests(it.items, [...folders, it.name]));
    }
    return out;
}

/** A name usable in a file name and a tag: "User API (v2)" → "user-api-v2". */
export function slug(s: string): string {
    const out = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (out) return out;
    // A name with no Latin letters or digits (Arabic, Chinese, Hindi…): a short stable code from it, so two such names do not share a file.
    const t = s.trim();
    if (!t) return 'api';
    let h = 0x811c9dc5;
    for (const ch of t) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    return `api-${h.toString(36)}`;
}

/** Check a collection read from a file or sent by the browser (shape, sizes); returns it typed. */
export function validCollection(x: unknown): ApiCollection {
    const fail = (m: string): never => { throw new Error(`Not a valid API collection: ${m}`); };
    if (!x || typeof x !== 'object') fail('not an object');
    const c = x as ApiCollection;
    if (c.format !== 'cs-studio-api/1') fail('unknown format');
    if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 200) fail('name');
    if (typeof c.baseUrl !== 'string' || c.baseUrl.length > 2000) fail('baseUrl');
    if (!Array.isArray(c.variables) || c.variables.length > 1000) fail('variables');
    if (!Array.isArray(c.items)) fail('items');
    let count = 0;
    const walk = (items: ApiItem[], depth: number) => {
        if (depth > 20) fail('folders nested too deep');
        for (const it of items) {
            if (++count > 5000) fail('too many requests');
            if (it.kind === 'folder') { if (typeof it.name !== 'string' || !Array.isArray(it.items)) fail('folder'); walk(it.items, depth + 1); continue; }
            if (it.kind !== 'request' || typeof it.id !== 'string' || typeof it.name !== 'string') fail('request');
            if (httpMethod(it.method) !== it.method) fail(`method ${String(it.method)}`);
            if (typeof it.url !== 'string' || it.url.length > 8000) fail('url');
            if (!Array.isArray(it.query) || !Array.isArray(it.headers) || !Array.isArray(it.checks) || !Array.isArray(it.extract)) fail(`request "${it.name}"`);
            if (it.body?.text && it.body.text.length > 5 * 1024 * 1024) fail('body larger than 5 MB');
            if (it.comments !== undefined && (!Array.isArray(it.comments) || it.comments.length > 500 || it.comments.some((m) => !m || typeof m.text !== 'string' || m.text.length > 10_000 || typeof m.author !== 'string'))) fail(`comments of "${it.name}"`);
            if (it.settings !== undefined && (typeof it.settings !== 'object' || it.settings === null)) fail(`settings of "${it.name}"`);
            // Whole numbers (milliseconds, times): a decimal is refused, not rounded.
            const st = it.settings ?? {};
            const whole = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
            if (st.timeoutMs !== undefined && !whole(st.timeoutMs, 100, 600_000)) fail(`settings of "${it.name}": the timeout is 0.1 to 600 seconds, in whole milliseconds (not ${st.timeoutMs} ms)`);
            if (st.retries !== undefined && !whole(st.retries, 0, 10)) fail(`settings of "${it.name}": retries are a whole number from 0 to 10 (not ${st.retries})`);
            if (st.retryDelayMs !== undefined && !whole(st.retryDelayMs, 0, 60_000)) fail(`settings of "${it.name}": the retry delay is a whole number of ms from 0 to 60000 (not ${st.retryDelayMs})`);
            if (it.examples !== undefined && (!Array.isArray(it.examples) || it.examples.length > 100 || it.examples.some((e) => !e || typeof e.name !== 'string' || !Number.isInteger(e.status) || (e.body !== undefined && (typeof e.body !== 'string' || e.body.length > 1024 * 1024))))) fail(`examples of "${it.name}"`);
            if (it.body?.mode === 'graphql' && (!it.body.graphql || typeof it.body.graphql.query !== 'string' || it.body.graphql.query.length > 1024 * 1024)) fail(`GraphQL query of "${it.name}"`);
            if (it.ws !== undefined && (!it.ws || !Array.isArray(it.ws.steps) || it.ws.steps.length > 200 || it.ws.steps.some((s) => !s || (s.kind !== 'send' && s.kind !== 'expect') || typeof s.text !== 'string'))) fail(`WebSocket steps of "${it.name}"`);
            if (it.ws?.protocol !== undefined && !MSG_PROTOCOLS.includes(it.ws.protocol)) fail(`protocol of "${it.name}"`);
            if (it.ws?.options !== undefined && (typeof it.ws.options !== 'object' || it.ws.options === null || (it.ws.options.subscribe !== undefined && (!Array.isArray(it.ws.options.subscribe) || it.ws.options.subscribe.some((t) => typeof t !== 'string'))))) fail(`connection options of "${it.name}"`);
            if (it.ws?.steps.some((s) => (s.topic !== undefined && typeof s.topic !== 'string') || (s.key !== undefined && typeof s.key !== 'string'))) fail(`message topics of "${it.name}"`);
        }
    };
    walk(c.items, 0);
    return c;
}
