import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as http from 'http';
import { OAuthFlows, tokenKey, TokenStore } from '../src/api/oauth2';
import { authorize, prepare, send, TokenCache, Values } from '../src/api/send';
import { asapToken, edgegridHeader, hawkHeader, oauth1Header } from '../src/api/moreAuth';
import { ApiAuth, newCollection, newRequest } from '../src/api/model';

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));
const vals = (): Values => ({ vars: {}, config: {}, env: {} });
/** The browser at the provider: where it is sent back to (not followed). */
const location = (url: string) => new Promise<string>((res, rej) => http.get(url, (r) => { r.resume(); res(String(r.headers.location)); }).on('error', rej));

/** A provider: authorize (records the PKCE challenge), token (checks the verifier, issues and refreshes), device code. */
function provider() {
    const codes = new Map<string, { challenge?: string; redirect: string }>();
    let deviceApproved = false, devicePolls = 0;
    const issued: string[] = [];
    const s = http.createServer((q, r) => {
        const u = new URL(q.url!, 'http://x');
        let b = ''; q.on('data', (c) => (b += c));
        q.on('end', () => {
            const f = new URLSearchParams(b);
            const json = (st: number, o: unknown) => { r.writeHead(st, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
            if (u.pathname === '/authorize') {
                const code = crypto.randomBytes(8).toString('hex');
                codes.set(code, { challenge: u.searchParams.get('code_challenge') ?? undefined, redirect: u.searchParams.get('redirect_uri')! });
                if (u.searchParams.get('response_type') === 'token') { r.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}#access_token=imp-1&token_type=Bearer&expires_in=600&state=${u.searchParams.get('state')}` }); r.end(); return; }
                r.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` }); r.end(); return;
            }
            if (u.pathname === '/token') {
                if (f.get('client_id') !== 'studio') return json(401, { error: 'invalid_client' });
                const g = f.get('grant_type');
                if (g === 'authorization_code') {
                    const c = codes.get(f.get('code') ?? ''); codes.delete(f.get('code') ?? '');
                    if (!c || c.redirect !== f.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
                    const ok = c.challenge && crypto.createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === c.challenge;
                    if (!ok) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
                    issued.push('code'); return json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' });
                }
                if (g === 'refresh_token') {
                    if (f.get('refresh_token') !== 'rt-1') return json(400, { error: 'invalid_grant' });
                    issued.push('refresh'); return json(200, { access_token: 'at-2', expires_in: 3600 });
                }
                if (g === 'urn:ietf:params:oauth:grant-type:device_code') {
                    devicePolls++;
                    if (!deviceApproved) return json(400, { error: 'authorization_pending' });
                    return json(200, { access_token: 'dev-1', expires_in: 600 });
                }
                return json(400, { error: 'unsupported_grant_type' });
            }
            if (u.pathname === '/device') return json(200, { device_code: 'dc-1', user_code: 'WDJB-MJHT', verification_uri: 'https://provider.test/device', expires_in: 60, interval: 1 });
            if (u.pathname === '/api/me') { json(200, { auth: q.headers.authorization ?? null }); return; }
            r.writeHead(404); r.end();
        });
    });
    return { s, issued, approve: () => { deviceApproved = true; }, polls: () => devicePolls };
}

test('OAuth 2.0 authorization code with PKCE: sign-in, the token used by requests, renewed with its refresh token', async () => {
    const p = provider();
    const port = await listen(p.s);
    try {
        const base = `http://127.0.0.1:${port}`;
        const store: TokenStore = new Map();
        const flows = new OAuthFlows(store, () => undefined);
        const a: ApiAuth = { type: 'oauth2', grant: 'authorization_code', authUrl: `${base}/authorize`, tokenUrl: `${base}/token`, clientId: 'studio', scope: 'read write' };
        const redirect = 'http://127.0.0.1:47999/oauth/callback';
        const { url, state } = flows.start(a, redirect);
        const u = new URL(url);
        assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(u.searchParams.get('scope'), 'read write');
        // The browser: the provider redirects back with the code.
        const back = new URL(await location(url));
        assert.equal(back.searchParams.get('state'), state);
        await assert.rejects(flows.complete('forged', back.searchParams.get('code')!), /unknown or expired/);
        await flows.complete(state, back.searchParams.get('code')!);
        await assert.rejects(flows.complete(state, 'again'), /unknown or expired/, 'state is single use');
        assert.equal(flows.status(a).signedIn, true);
        // A request with this auth gets the token.
        const c = newCollection('o'); c.baseUrl = base; c.auth = a;
        const r = { ...newRequest('Me', 'me'), url: '/api/me' };
        const cache = store as TokenCache;
        let pr = await authorize(c, r, vals(), prepare(c, r, vals()), undefined, cache);
        assert.equal(pr.headers.Authorization, 'Bearer at-1');
        // Expired: renewed with the refresh token, no new sign-in.
        store.set(tokenKey(a), { ...store.get(tokenKey(a))!, until: Date.now() - 1 });
        pr = await authorize(c, r, vals(), prepare(c, r, vals()), undefined, cache);
        assert.equal(pr.headers.Authorization, 'Bearer at-2');
        assert.deepEqual(p.issued, ['code', 'refresh']);
        // A load worker gets the tokens through the values (another cache).
        const worker: TokenCache = new Map();
        pr = await authorize(c, r, { ...vals(), tokens: Object.fromEntries(store) }, prepare(c, r, vals()), undefined, worker);
        assert.equal(pr.headers.Authorization, 'Bearer at-2');
        // Not signed in: a clear message.
        await assert.rejects(authorize({ ...c, auth: { ...a, clientId: 'studio', scope: 'other' } }, r, vals(), prepare(c, r, vals()), undefined, new Map()), /Not signed in.*Get new token/);
        // Wrong verifier: the provider refuses (a code stolen without the verifier is useless).
        const s2 = flows.start(a, redirect);
        const code2 = new URL(await location(s2.url)).searchParams.get('code')!;
        const bad = await flows.tokenRequest(a, { grant_type: 'authorization_code', code: code2, redirect_uri: redirect, code_verifier: 'wrong' });
        assert.equal(bad.json.error_description, 'PKCE verification failed');
    } finally { p.s.close(); }
});

test('OAuth 2.0 device code: the code to enter, polling until approved; implicit: the token from the fragment; fixed refresh token', async () => {
    const p = provider();
    const port = await listen(p.s);
    try {
        const base = `http://127.0.0.1:${port}`;
        const store: TokenStore = new Map();
        const flows = new OAuthFlows(store, () => undefined);
        const a: ApiAuth = { type: 'oauth2', grant: 'device_code', deviceUrl: `${base}/device`, tokenUrl: `${base}/token`, clientId: 'studio' };
        const d = await flows.startDevice(a);
        assert.equal(d.userCode, 'WDJB-MJHT');
        await new Promise((r) => setTimeout(r, 1300));
        assert.equal(flows.deviceStatus(d.id).state, 'waiting');
        p.approve();
        for (let i = 0; i < 30 && flows.deviceStatus(d.id).state === 'waiting'; i++) await new Promise((r) => setTimeout(r, 200));
        assert.equal(flows.deviceStatus(d.id).state, 'done');
        assert.equal(store.get(tokenKey(a))!.token, 'dev-1');
        assert.ok(p.polls() >= 2);

        const imp: ApiAuth = { type: 'oauth2', grant: 'implicit', authUrl: `${base}/authorize`, clientId: 'studio' };
        const s = flows.start(imp, 'http://127.0.0.1:47999/oauth/callback');
        assert.equal(new URL(s.url).searchParams.get('response_type'), 'token');
        assert.equal(new URL(s.url).searchParams.get('code_challenge'), null, 'no PKCE for implicit');
        flows.completeImplicit(s.state, { access_token: 'imp-1', expires_in: '600', state: s.state });
        assert.equal(store.get(tokenKey(imp))!.token, 'imp-1');

        // A fixed refresh token (a secret): exchanged unattended.
        const c = newCollection('o'); c.baseUrl = base;
        c.auth = { type: 'oauth2', grant: 'refresh_token', tokenUrl: `${base}/token`, clientId: 'studio', refreshToken: '{env:RT}' };
        const r = { ...newRequest('Me', 'me'), url: '/api/me' };
        const v = { ...vals(), env: { RT: 'rt-1' } };
        const pr = await authorize(c, r, v, prepare(c, r, v), undefined, new Map());
        assert.equal(pr.headers.Authorization, 'Bearer at-2');
    } finally { p.s.close(); }
});

test('request signing: OAuth 1.0a, Hawk and EdgeGrid equal the reference libraries; ASAP and JWT verify; AWS signed in Send', async () => {
    // OAuth 1.0a: the same signature as oauthlib (Python) for the well-known example request.
    const o1 = oauth1Header({ method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true', consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE', nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: '1318622958', form: [['status', 'Hello Ladies + Gentlemen, a signed OAuth request!']] });
    assert.match(o1, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
    // Hawk: the specification's example.
    const hk = hawkHeader({ method: 'GET', url: 'http://example.com:8000/resource/1?b=1&a=2', id: 'dh37fgj492je', key: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn', ts: 1353832234, nonce: 'j4h3g2', ext: 'some-app-ext-data' });
    assert.match(hk, /mac="6R4rV5iE\+NPoym\+WwjeHzjAGXUtLNIxmo1vpMofpLAE="/);
    // EdgeGrid: the same as Akamai's edgegrid-python for a GET with a query and a POST with a body.
    const eg = { clientToken: 'akab-client-token-xxx-xxxxxxxxxxxxxxxx', clientSecret: 'SOMESECRET/withslashes+=', accessToken: 'akab-access-token-xxx-xxxxxxxxxxxxxxxx', timestamp: '20140321T19:34:21+0000', nonce: 'nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' };
    assert.match(edgegridHeader({ ...eg, method: 'GET', url: 'https://akaa-baseurl-xxxxxxxxxxx-xxxxxxxxxxxxx.luna.akamaiapis.net/testapi/v1/t1?p1=1&p2=2' }), /signature=O0jyRIIZb8iAK3wDUqXSr2ozbzWoSr3ScXBRVDSTFes=$/);
    assert.match(edgegridHeader({ ...eg, method: 'POST', url: 'https://akaa-baseurl-xxxxxxxxxxx-xxxxxxxxxxxxx.luna.akamaiapis.net/testapi/v1/t3', body: 'datadatadatadatadatadatadatadata' }), /signature=ksgxkWxse0\/mqM7LEkbDhf5ht5bqpj\+\/db71XFjqbsw=$/);
    // ASAP: an RS256 JWT with the key id, verifiable with the public key.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const t = asapToken({ issuer: 'svc-a', audience: 'svc-b', keyId: 'svc-a/key1', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string });
    const [h, c, sig] = t.split('.');
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')));
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.deepEqual([JSON.parse(Buffer.from(h, 'base64url').toString()).kid, claims.iss, claims.aud, claims.exp - claims.iat], ['svc-a/key1', 'svc-a', 'svc-b', 60]);

    // In Send: each type puts its header on the request (values filled in), last, over the final URL and body.
    let seen: http.IncomingHttpHeaders = {};
    let seenUrl = '';
    const s = http.createServer((q, r) => { seen = q.headers; seenUrl = q.url!; r.end('{}'); });
    const port = await listen(s);
    try {
        const c0 = newCollection('s'); c0.baseUrl = `http://127.0.0.1:${port}`;
        const r = { ...newRequest('X', 'x'), method: 'POST' as const, url: '/things?b=2&a=1', body: { mode: 'json' as const, text: '{"n":1}' } };
        const v: Values = { vars: {}, config: { REGION: 'eu-west-1' }, env: { AK: 'AKIDEXAMPLE', SK: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', HS: 'top-secret' } };
        const run = async (auth: ApiAuth) => { const c = { ...c0, auth }; const p = prepare(c, r, v); assert.deepEqual(p.missing, []); await send(p); return seen; };
        let h2 = await run({ type: 'aws', accessKey: '{env:AK}', secretKey: '{env:SK}', region: '{config:REGION}', service: 'execute-api' });
        assert.match(String(h2.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/execute-api\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
        h2 = await run({ type: 'jwt', algorithm: 'HS256', secret: '{env:HS}', payload: '{"sub":"tester","role":"qa"}' });
        const [jh, jc, js] = String(h2.authorization).replace(/^Bearer /, '').split('.');
        assert.equal(crypto.createHmac('sha256', 'top-secret').update(`${jh}.${jc}`).digest('base64url'), js);
        assert.equal(JSON.parse(Buffer.from(jc, 'base64url').toString()).role, 'qa');
        await run({ type: 'jwt', algorithm: 'HS256', secret: 'k', payload: '{}', queryKey: 'jwt' });
        assert.match(seenUrl, /\?b=2&a=1&jwt=ey/);
        h2 = await run({ type: 'oauth1', consumerKey: 'ck', consumerSecret: 'cs', token: 'tk', tokenSecret: 'ts' });
        assert.match(String(h2.authorization), /^OAuth oauth_consumer_key="ck", oauth_nonce="[0-9a-f]{32}", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="tk", oauth_version="1.0", oauth_signature="[^"]+"$/);
        h2 = await run({ type: 'hawk', hawkId: 'id1', hawkKey: 'k1', payloadHash: true });
        assert.match(String(h2.authorization), /^Hawk id="id1", ts="\d+", nonce="[^"]+", hash="[^"]+", mac="[^"]+"$/);
        h2 = await run({ type: 'edgegrid', clientToken: 'ct', clientSecret: 'cs', accessToken: 'at' });
        assert.match(String(h2.authorization), /^EG1-HMAC-SHA256 client_token=ct;access_token=at;timestamp=\d{8}T\d\d:\d\d:\d\d\+0000;nonce=[0-9a-f-]{36};signature=/);
        assert.throws(() => prepare({ ...c0, auth: { type: 'jwt', algorithm: 'HS256', secret: 'k', payload: '{not json' } }, r, v), /JWT payload is not a JSON object/);
    } finally { s.close(); }
});

test('Kerberos (Negotiate): the challenge answered with the operating system\'s token, on the same connection; a missing library says how to add it', async () => {
    const { setNegotiateFactory } = await import('../src/api/negotiate');
    const sockets = new Set<unknown>();
    const s = http.createServer((q, r) => {
        sockets.add(q.socket);
        const a = String(q.headers.authorization ?? '');
        if (a === 'Negotiate dGlja2V0LWZvci1IVFRQQDEyNy4wLjAuMQ==') { r.writeHead(200, { 'WWW-Authenticate': 'Negotiate b2s=' }); r.end('{"user":"CORP\\\\qa"}'); return; }
        r.writeHead(401, { 'WWW-Authenticate': 'Negotiate' }); r.end();
    });
    const port = await listen(s);
    try {
        const services: string[] = [];
        setNegotiateFactory(async (service) => { services.push(service); return { step: async () => Buffer.from(`ticket-for-${service}`).toString('base64') }; });
        const c = newCollection('k'); c.baseUrl = `http://127.0.0.1:${port}`; c.auth = { type: 'negotiate' };
        const r = { ...newRequest('Me', 'me'), url: '/me' };
        const res = await send(prepare(c, r, vals()));
        assert.equal(res.status, 200);
        assert.deepEqual(services, ['HTTP@127.0.0.1']);
        // A service principal of the team's choosing.
        const c2 = { ...c, auth: { type: 'negotiate' as const, spn: 'HTTP@api.bank.local' } };
        assert.equal((await send(prepare(c2, r, vals()))).status, 401, 'the server only knows the default name');
        assert.equal(services[1], 'HTTP@api.bank.local');
        setNegotiateFactory(null);
        await assert.rejects(send(prepare(c, r, vals())), /needs the "kerberos" package/);
    } finally { setNegotiateFactory(null); s.close(); }
});

test('a request\'s own Authorization header wins over inherited auth; an empty bearer token is not sent', async () => {
    const { toFeature } = await import('../src/api/feature');
    const c = newCollection('h'); c.baseUrl = 'http://h.example'; c.auth = { type: 'bearer', token: 'collection-token' } as ApiAuth;
    const own = { ...newRequest('Own', 'own'), url: '/a', headers: [{ key: 'authorization', value: 'Basic abc', enabled: true }] };
    assert.equal(prepare(c, own, vals()).headers.authorization, 'Basic abc');
    assert.equal(prepare(c, own, vals()).headers.Authorization, undefined);
    const plain = { ...newRequest('Plain', 'plain'), url: '/a' };
    assert.equal(prepare(c, plain, vals()).headers.Authorization, 'Bearer collection-token');
    const empty = { ...c, auth: { type: 'bearer', token: '  ' } as ApiAuth };
    assert.deepEqual(prepare(empty, plain, vals()).missing, ['the bearer token (Auth)']);
    // The generated test does the same.
    const f1 = toFeature({ ...c, items: [own as never] });
    assert.ok(!f1.text.includes('collection-token'), f1.text);
    const f2 = toFeature({ ...empty, items: [plain as never] });
    assert.ok(!/Bearer\s*"?\s*$/m.test(f2.text) && f2.warnings.some((w) => /bearer token is empty/.test(w)), f2.text);
});

test('checks: a status that is not a number and a JSON path that cannot be read are said as such', async () => {
    const { evaluate } = await import('../src/api/send');
    const res = { status: 200, statusText: 'OK', headers: {}, body: '{"a":1}', json: { a: 1 }, size: 7, timeMs: 1, redirects: [], truncated: false } as never;
    const [s, p, ok] = evaluate([{ kind: 'status', value: 'abc' }, { kind: 'jsonExists', target: '$$[bad' }, { kind: 'jsonExists', target: '$.a' }], res, vals());
    assert.equal(s.pass, false); assert.match(s.message, /not a status code/);
    assert.equal(p.pass, false); assert.match(p.message, /is not a JSON path/);
    assert.equal(ok.pass, true);
});
