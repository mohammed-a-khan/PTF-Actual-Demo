/**
 * The Authorization tab of a request or collection: every sign-in the Studio can send, with the values as
 * {env:NAME} secrets. OAuth 2.0 browser grants sign in from here (Get new token) and the token is kept by the Studio.
 */
import React from 'react';
import { Alert, App, Button, Checkbox, Input, InputNumber, Modal, Segmented, Select, Space, Tag, Typography } from 'antd';
import { api, ApiAuth, ApiCollectionDef } from '../api';
import { errText } from '../state';

/** What a sign-in needs to resolve the auth's values (the open collection, its project and environment). */
export const AuthContext = React.createContext<{ project: string; env?: string; collection: ApiCollectionDef } | null>(null);

const TYPES: Array<{ value: ApiAuth['type']; label: string }> = [
    { value: 'none', label: 'No authentication' },
    { value: 'bearer', label: 'Bearer token' },
    { value: 'basic', label: 'Basic (user name and password)' },
    { value: 'apikey', label: 'API key' },
    { value: 'oauth2', label: 'OAuth 2.0' },
    { value: 'jwt', label: 'JWT (signed by the Studio)' },
    { value: 'aws', label: 'AWS Signature v4' },
    { value: 'ntlm', label: 'NTLM (Windows)' },
    { value: 'digest', label: 'Digest' },
    { value: 'negotiate', label: 'Kerberos (Negotiate, Windows sign-in)' },
    { value: 'oauth1', label: 'OAuth 1.0a' },
    { value: 'hawk', label: 'Hawk' },
    { value: 'edgegrid', label: 'Akamai EdgeGrid' },
    { value: 'asap', label: 'ASAP (Atlassian)' },
];
const JWT_ALGS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
const BROWSER_GRANTS = ['authorization_code', 'implicit', 'device_code'];

function Field({ label, value, onChange, placeholder, secret, area }: { label: string; value?: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean; area?: boolean }) {
    if (area) return <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text><Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 8 }} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} /></div>;
    return <Input addonBefore={label} className={secret ? 'mono' : undefined} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? (secret ? '{env:NAME}' : undefined)} aria-label={label} />;
}

function OAuthSignIn({ auth }: { auth: ApiAuth }) {
    const { message } = App.useApp();
    const ctx = React.useContext(AuthContext);
    const [st, setSt] = React.useState<{ signedIn: boolean; until?: number; refreshable?: boolean } | null>(null);
    const [device, setDevice] = React.useState<null | { id: string; userCode: string; verificationUri: string; verificationUriComplete?: string }>(null);
    const body = ctx ? { project: ctx.project, env: ctx.env, collection: ctx.collection, auth } : null;
    const refresh = React.useCallback(() => { if (body) api.oauthStatus(body).then(setSt).catch(() => setSt(null)); }, [JSON.stringify(auth), ctx?.project, ctx?.env]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(refresh, [refresh]);
    if (!body) return null;
    const signIn = async () => {
        try {
            if (auth.grant === 'device_code') {
                const d = await api.oauthDevice(body);
                setDevice(d);
                for (;;) {
                    await new Promise((r) => setTimeout(r, 2000));
                    const s = await api.oauthDeviceStatus(d.id);
                    if (s.state === 'done') { message.success('Signed in'); break; }
                    if (s.state === 'failed') { message.error(s.error ?? 'Sign-in failed'); break; }
                }
                setDevice(null); refresh();
                return;
            }
            const r = await api.oauthStart(body);
            const w = window.open(r.url, 'cs-oauth', 'width=560,height=720');
            if (!w) { message.warning('The sign-in window was blocked: allow pop-ups for the Studio.'); return; }
            const t = setInterval(() => { if (w.closed) { clearInterval(t); refresh(); } }, 700);
        } catch (e) { message.error(errText(e)); }
    };
    return (
        <Space direction="vertical" size={4}>
            <Space wrap>
                <Button type="primary" size="small" onClick={() => void signIn()}>Get new token</Button>
                {st?.signedIn ? <Tag color="green">Signed in{st.until && st.until > Date.now() ? ` until ${new Date(st.until).toLocaleTimeString()}` : ''}{st.refreshable ? ' · renews itself' : ''}</Tag> : <Tag>Not signed in</Tag>}
                {st?.signedIn && <Button size="small" type="link" onClick={async () => { await api.oauthForget(body); refresh(); }}>Sign out</Button>}
            </Space>
            {auth.grant !== 'device_code' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Register this redirect address with the provider: <Typography.Text code copyable>{`${window.location.origin}/oauth/callback`}</Typography.Text></Typography.Text>}
            <Modal open={!!device} footer={null} closable={false} title="Sign in on another device">
                {device && <Space direction="vertical">
                    <Typography.Text>Open <a href={device.verificationUriComplete ?? device.verificationUri} target="_blank" rel="noreferrer">{device.verificationUri}</a> and enter this code:</Typography.Text>
                    <Typography.Title level={3} copyable className="mono" style={{ margin: 0 }}>{device.userCode}</Typography.Title>
                    <Typography.Text type="secondary">Waiting for the sign-in…</Typography.Text>
                </Space>}
            </Modal>
        </Space>
    );
}

export function AuthEditor({ auth, onChange, inherit }: { auth: ApiAuth; onChange: (a: ApiAuth) => void; inherit: boolean }) {
    const set = (p: Partial<ApiAuth>) => onChange({ ...auth, ...p });
    const grant = auth.grant ?? 'client_credentials';
    return (
        <Space direction="vertical" style={{ width: '100%', maxWidth: 620 }}>
            <Select value={auth.type} onChange={(t) => onChange({ type: t })} style={{ width: 280 }} aria-label="Authentication"
                options={[...(inherit ? [{ value: 'inherit', label: 'Same as the collection' }] : []), ...TYPES]} />
            {auth.type === 'bearer' && <Field label="Token" secret value={auth.token} onChange={(token) => set({ token })} placeholder="{{token}} or {env:API_TOKEN}" />}
            {auth.type === 'basic' && <>
                <Field label="User name" value={auth.username} onChange={(username) => set({ username })} />
                <Field label="Password" secret value={auth.password} onChange={(password) => set({ password })} placeholder="{env:API_PASSWORD}" />
            </>}
            {(auth.type === 'ntlm' || auth.type === 'digest') && <>
                {auth.type === 'ntlm' && <Field label="Domain" value={auth.domain} onChange={(domain) => set({ domain })} placeholder="CORP (or write the user as CORP\\user)" />}
                <Field label="User name" value={auth.username} onChange={(username) => set({ username })} />
                <Field label="Password" secret value={auth.password} onChange={(password) => set({ password })} placeholder="{env:API_PASSWORD}" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{auth.type === 'ntlm' ? 'Windows sign-in (NTLMv2): the Studio answers the server\'s challenge over one connection, as the framework\'s NTLM step does.' : 'The Studio answers the server\'s Digest challenge (MD5 or SHA-256), as the framework\'s Digest step does.'}</Typography.Text>
            </>}
            {auth.type === 'oauth2' && <>
                <Select size="small" style={{ width: 320 }} value={grant} onChange={(g) => set({ grant: g })} aria-label="Grant"
                    options={[{ value: 'client_credentials', label: 'Client credentials' }, { value: 'password', label: 'Password' }, { value: 'authorization_code', label: 'Authorization code (browser sign-in, PKCE)' }, { value: 'implicit', label: 'Implicit (browser sign-in)' }, { value: 'device_code', label: 'Device code (sign in on another device)' }, { value: 'refresh_token', label: 'Refresh token (from a secret)' }]} />
                {(grant === 'authorization_code' || grant === 'implicit') && <Field label="Authorization URL" value={auth.authUrl} onChange={(authUrl) => set({ authUrl })} placeholder="https://login.example.com/oauth2/authorize" />}
                {grant === 'device_code' && <Field label="Device URL" value={auth.deviceUrl} onChange={(deviceUrl) => set({ deviceUrl })} placeholder="https://login.example.com/oauth2/devicecode" />}
                {grant !== 'implicit' && <Field label="Token URL" value={auth.tokenUrl} onChange={(tokenUrl) => set({ tokenUrl })} placeholder="https://login.example.com/oauth2/token" />}
                <Field label="Client id" value={auth.clientId} onChange={(clientId) => set({ clientId })} />
                {grant !== 'implicit' && <Field label="Client secret" secret value={auth.clientSecret} onChange={(clientSecret) => set({ clientSecret })} placeholder="{env:CLIENT_SECRET} (empty for public clients)" />}
                <Field label="Scope" value={auth.scope} onChange={(scope) => set({ scope })} placeholder="optional, e.g. openid api://my-api/.default" />
                {BROWSER_GRANTS.includes(grant) && <Field label="Audience" value={auth.audience} onChange={(audience) => set({ audience })} placeholder="optional (some providers)" />}
                {grant === 'authorization_code' && <Checkbox checked={auth.pkce !== false} onChange={(e) => set({ pkce: e.target.checked })}>PKCE (S256) — keep on unless the provider refuses it</Checkbox>}
                {grant === 'refresh_token' && <Field label="Refresh token" secret value={auth.refreshToken} onChange={(refreshToken) => set({ refreshToken })} placeholder="{env:REFRESH_TOKEN}" />}
                {grant === 'password' && <>
                    <Field label="User name" value={auth.username} onChange={(username) => set({ username })} />
                    <Field label="Password" secret value={auth.password} onChange={(password) => set({ password })} placeholder="{env:API_PASSWORD}" />
                </>}
                {BROWSER_GRANTS.includes(grant) ? <OAuthSignIn auth={auth} /> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>The token is requested when needed and reused until it expires, as the framework's OAuth2 steps do.</Typography.Text>}
                {BROWSER_GRANTS.includes(grant) && <Alert type="info" showIcon message="A browser sign-in cannot run in a pipeline: the generated test uses the framework's OAuth2 steps with a refresh token or client credentials." />}
            </>}
            {auth.type === 'apikey' && <>
                <Space.Compact style={{ width: '100%' }}>
                    <Select value={auth.in ?? 'header'} onChange={(v) => set({ in: v })} style={{ width: 160 }} options={[{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query parameter' }]} />
                    <Input placeholder="Name, e.g. X-API-Key" value={auth.key} onChange={(e) => set({ key: e.target.value })} />
                </Space.Compact>
                <Field label="Value" secret value={auth.value} onChange={(value) => set({ value })} placeholder="{env:API_KEY}" />
            </>}
            {auth.type === 'jwt' && <>
                <Select style={{ width: 160 }} value={auth.algorithm ?? 'HS256'} onChange={(algorithm) => set({ algorithm })} options={JWT_ALGS.map((a) => ({ value: a, label: a }))} aria-label="Algorithm" />
                {/^HS/.test(auth.algorithm ?? 'HS256') ? <Field label="Secret" secret value={auth.secret} onChange={(secret) => set({ secret })} placeholder="{env:JWT_SECRET}" />
                    : <Field label="Private key (PEM)" area value={auth.privateKey} onChange={(privateKey) => set({ privateKey })} placeholder="{env:JWT_PRIVATE_KEY} or -----BEGIN PRIVATE KEY-----…" />}
                <Field label="Payload (claims, JSON)" area value={auth.payload} onChange={(payload) => set({ payload })} placeholder={'{"sub": "{{userId}}", "role": "tester", "exp": <timestamp>}'} />
                <Field label="Extra header (JSON, optional)" area value={auth.jwtHeader} onChange={(jwtHeader) => set({ jwtHeader })} placeholder={'{"kid": "key-1"}'} />
                <Space.Compact style={{ width: '100%' }}>
                    <Field label="Header prefix" value={auth.prefix} onChange={(prefix) => set({ prefix })} placeholder="Bearer" />
                    <Field label="…or query parameter" value={auth.queryKey} onChange={(queryKey) => set({ queryKey })} placeholder="(header when empty)" />
                </Space.Compact>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>A new token is signed for every request; "iat" is added.</Typography.Text>
            </>}
            {auth.type === 'aws' && <>
                <Field label="Access key" secret value={auth.accessKey} onChange={(accessKey) => set({ accessKey })} placeholder="{env:AWS_ACCESS_KEY_ID}" />
                <Field label="Secret key" secret value={auth.secretKey} onChange={(secretKey) => set({ secretKey })} placeholder="{env:AWS_SECRET_ACCESS_KEY}" />
                <Field label="Session token" secret value={auth.sessionToken} onChange={(sessionToken) => set({ sessionToken })} placeholder="optional: {env:AWS_SESSION_TOKEN}" />
                <Space.Compact style={{ width: '100%' }}>
                    <Field label="Region" value={auth.region} onChange={(region) => set({ region })} placeholder="eu-west-1" />
                    <Field label="Service" value={auth.service} onChange={(service) => set({ service })} placeholder="execute-api, s3, sqs…" />
                </Space.Compact>
            </>}
            {auth.type === 'negotiate' && <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Signs in as you (the Windows account you are logged in with, or a kinit ticket): no password here. Needs the "kerberos" package on this computer.</Typography.Text>
                <Field label="Service principal" value={auth.spn} onChange={(spn) => set({ spn })} placeholder="optional, default HTTP@<host>" />
            </>}
            {auth.type === 'oauth1' && <>
                <Select style={{ width: 200 }} value={auth.signatureMethod ?? 'HMAC-SHA1'} onChange={(signatureMethod) => set({ signatureMethod })} options={['HMAC-SHA1', 'HMAC-SHA256', 'RSA-SHA1', 'PLAINTEXT'].map((x) => ({ value: x, label: x }))} aria-label="Signature method" />
                <Field label="Consumer key" value={auth.consumerKey} onChange={(consumerKey) => set({ consumerKey })} />
                {auth.signatureMethod === 'RSA-SHA1' ? <Field label="Private key (PEM)" area value={auth.privateKey} onChange={(privateKey) => set({ privateKey })} placeholder="{env:OAUTH1_PRIVATE_KEY}" />
                    : <Field label="Consumer secret" secret value={auth.consumerSecret} onChange={(consumerSecret) => set({ consumerSecret })} />}
                <Field label="Access token" secret value={auth.token} onChange={(token) => set({ token })} placeholder="optional" />
                <Field label="Token secret" secret value={auth.tokenSecret} onChange={(tokenSecret) => set({ tokenSecret })} placeholder="optional" />
                <Field label="Realm" value={auth.realm} onChange={(realm) => set({ realm })} placeholder="optional" />
            </>}
            {auth.type === 'hawk' && <>
                <Field label="Hawk id" value={auth.hawkId} onChange={(hawkId) => set({ hawkId })} />
                <Field label="Hawk key" secret value={auth.hawkKey} onChange={(hawkKey) => set({ hawkKey })} />
                <Select style={{ width: 160 }} value={auth.algorithm ?? 'sha256'} onChange={(algorithm) => set({ algorithm })} options={[{ value: 'sha256', label: 'sha256' }, { value: 'sha1', label: 'sha1' }]} aria-label="Algorithm" />
                <Field label="ext" value={auth.ext} onChange={(ext) => set({ ext })} placeholder="optional application data" />
                <Checkbox checked={!!auth.payloadHash} onChange={(e) => set({ payloadHash: e.target.checked })}>Include a hash of the body</Checkbox>
            </>}
            {auth.type === 'edgegrid' && <>
                <Field label="Client token" secret value={auth.clientToken} onChange={(clientToken) => set({ clientToken })} />
                <Field label="Client secret" secret value={auth.clientSecret} onChange={(clientSecret) => set({ clientSecret })} />
                <Field label="Access token" secret value={auth.accessToken} onChange={(accessToken) => set({ accessToken })} />
            </>}
            {auth.type === 'asap' && <>
                <Field label="Issuer" value={auth.issuer} onChange={(issuer) => set({ issuer })} />
                <Field label="Audience" value={auth.audience} onChange={(audience) => set({ audience })} />
                <Field label="Key id" value={auth.keyId} onChange={(keyId) => set({ keyId })} placeholder="issuer/key-name" />
                <Field label="Private key (PEM)" area value={auth.privateKey} onChange={(privateKey) => set({ privateKey })} placeholder="{env:ASAP_PRIVATE_KEY}" />
                <Space><Typography.Text type="secondary">Valid for</Typography.Text><InputNumber size="small" min={1} max={3600} value={auth.expiresIn ?? 60} onChange={(v) => set({ expiresIn: v ?? 60 })} addonAfter="s" /></Space>
            </>}
            {auth.type !== 'none' && auth.type !== 'inherit' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Keep passwords, keys and tokens out of the file: write <Typography.Text code>{'{env:NAME}'}</Typography.Text> and add NAME under Secrets.</Typography.Text>}
        </Space>
    );
}
