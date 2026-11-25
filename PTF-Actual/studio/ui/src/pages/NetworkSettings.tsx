/**
 * Network settings (company proxy and certificates), off by default:
 *  - for the Studio's own connections to Azure DevOps (personal settings, this computer only);
 *  - for Git (the user's global Git configuration), changed one shown command at a time.
 */
import React from 'react';
import { Alert, App, Button, Card, Collapse, Descriptions, Form, Input, Radio, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, InfoCircleOutlined } from '@ant-design/icons';
import { api, ClientCert, ConnectionCheck, GitConnectionCheck, GitNetworkChange, GitNetworkState, NetworkSettings, StudioSettings } from '../api';
import { errText } from '../state';
import { datagitApi } from '../datagit-api';
import { askStaleSave } from '../datagit-common';
import { useUnsaved } from '../unsaved';

function Result({ r }: { r: { ok: boolean; message: string; detail?: string; certificateChain?: ConnectionCheck['certificateChain'] } }) {
    return (
        <Alert type={r.ok ? 'success' : 'error'} showIcon icon={r.ok ? <CheckCircleFilled /> : <CloseCircleFilled />} style={{ marginTop: 8 }}
            message={r.message}
            description={(r.certificateChain?.length || r.detail) ? <Space direction="vertical" size={2}>
                {r.certificateChain?.length ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>Certificate presented: {r.certificateChain.map((c) => `${c.subject} (issued by ${c.issuer})`).join(' → ')}</Typography.Text> : null}
                {r.detail ? <Typography.Text type="secondary" className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{r.detail}</Typography.Text> : null}
            </Space> : undefined} />
    );
}

function ClientCerts({ value, onChange }: { value: ClientCert[]; onChange: (v: ClientCert[]) => void }) {
    const { message } = App.useApp();
    const [pass, setPass] = React.useState<Record<number, string>>({});
    const set = (i: number, p: Partial<ClientCert>) => onChange(value.map((c, j) => (j === i ? { ...c, ...p } : c)));
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            {value.map((c, i) => (
                <Card key={i} size="small" styles={{ body: { padding: 8 } }}>
                    <Space wrap>
                        <Input value={c.host} onChange={(e) => set(i, { host: e.target.value })} placeholder="api.bank.local or .bank.local" style={{ width: 220 }} aria-label="Host" className="mono" />
                        <Input value={c.pfxFile} onChange={(e) => set(i, { pfxFile: e.target.value || undefined })} placeholder=".pfx / .p12 file (full path)" style={{ width: 300 }} aria-label="PFX file" className="mono" />
                        <Typography.Text type="secondary">or</Typography.Text>
                        <Input value={c.certFile} onChange={(e) => set(i, { certFile: e.target.value || undefined })} placeholder="certificate .pem" style={{ width: 220 }} aria-label="Certificate file" className="mono" />
                        <Input value={c.keyFile} onChange={(e) => set(i, { keyFile: e.target.value || undefined })} placeholder="key .pem" style={{ width: 200 }} aria-label="Key file" className="mono" />
                    </Space>
                    <Space wrap style={{ marginTop: 6 }}>
                        <Input value={c.passphraseSecret} onChange={(e) => set(i, { passphraseSecret: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') || undefined })} placeholder="Passphrase secret name, e.g. CLIENT_CERT_PASS" style={{ width: 300 }} aria-label="Passphrase secret name" className="mono" />
                        <Input.Password value={pass[i] ?? ''} onChange={(e) => setPass({ ...pass, [i]: e.target.value })} placeholder="Passphrase (saved encrypted)" style={{ width: 220 }} autoComplete="new-password" aria-label="Passphrase" />
                        <Button disabled={!c.passphraseSecret || !pass[i]} onClick={async () => { try { await api.setNetworkSecret(c.passphraseSecret!, pass[i]); setPass({ ...pass, [i]: '' }); message.success('Passphrase saved in your secret store'); } catch (e) { message.error(errText(e)); } }}>Save passphrase</Button>
                        <Button type="link" danger onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove</Button>
                    </Space>
                </Card>
            ))}
            <Button size="small" onClick={() => onChange([...value, { host: '' }])}>Add a client certificate</Button>
        </Space>
    );
}

/** Why the server would refuse this proxy address (manual mode), or null. Same rules as the server. */
export function proxyUrlProblem(raw: string): string | null {
    const url = raw.trim();
    if (!url) return 'Give the proxy address, e.g. http://proxy.company.com:8080';
    if (url.length > 2048) return 'The proxy address is too long (at most 2,048 characters).';
    let u: URL;
    try { u = new URL(url); } catch { return 'Proxy address must look like http://proxy.company.com:8080'; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Proxy address must start with http:// or https://';
    if (u.username || u.password) return 'Put the proxy user name and password in their own fields, not in the address.';
    if (u.pathname !== '/' || u.search || u.hash) return 'Proxy address is just the server and port, e.g. http://proxy.company.com:8080';
    return null;
}

/** Why the server would refuse this PAC file address (PAC mode), or null. */
export function pacUrlProblem(raw: string): string | null {
    const pac = raw.trim();
    if (!pac) return 'Give the PAC file address (http://wpad.company.local/proxy.pac) or its path.';
    if (pac.length > 2048) return 'The PAC file address is too long (at most 2,048 characters).';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pac) && !/^(https?|file):\/\//i.test(pac)) return 'A PAC file address starts with http://, https:// or file://, or is a file path.';
    return null;
}

/**
 * What to send: the fields the chosen mode does not use (hidden on the screen) go back as saved when the
 * typed value would be refused, so they never block the save.
 */
export function networkToSave(n: NetworkSettings, saved: NetworkSettings): NetworkSettings {
    const out = { ...n };
    if (n.proxyMode !== 'manual' && n.proxyUrl.trim() && proxyUrlProblem(n.proxyUrl)) out.proxyUrl = saved.proxyUrl;
    if (n.proxyMode !== 'pac' && (n.pacUrl ?? '').trim() && pacUrlProblem(n.pacUrl ?? '')) out.pacUrl = saved.pacUrl;
    if (n.proxyMode === 'off' || n.proxyMode === 'environment') {
        if (/[\s:]/.test(n.proxyUser) || n.proxyUser.length > 200) out.proxyUser = saved.proxyUser;
        if ((n.proxyDomain ?? '').length > 100 || /[\s\\/@:]/.test(n.proxyDomain ?? '')) out.proxyDomain = saved.proxyDomain;
    }
    return out;
}

export function StudioNetworkCard({ s, onChange }: { s: StudioSettings; onChange: (s: StudioSettings) => void }) {
    const app = App.useApp();
    const { message } = app;
    /** Keep editing after a refusal: the version saved now, so the next Save goes over it. */
    const [kept, setKept] = React.useState<{ version: string | undefined } | null>(null);
    const [n, setN] = React.useState<NetworkSettings>(s.network);
    const [pw, setPw] = React.useState('');
    const [busy, setBusy] = React.useState<string | null>(null);
    const [check, setCheck] = React.useState<ConnectionCheck | null>(null);
    const [certs, setCerts] = React.useState<Array<{ subject: string; issuer: string; validTo: string }> | null>(null);
    React.useEffect(() => setN(s.network), [s.network]);
    const [sysInfo, setSysInfo] = React.useState<Awaited<ReturnType<typeof api.networkInfo>> | null>(null);
    React.useEffect(() => { api.networkInfo().then(setSysInfo).catch(() => setSysInfo(null)); }, [s.network]);
    const dirty = JSON.stringify(n) !== JSON.stringify(s.network);
    const info = s.networkInfo ?? { systemCertsSupported: false, nodeVersion: '', hasProxyPassword: false, environmentProxy: '', environmentNoProxy: '' };

    const urlProblem = n.proxyMode === 'manual' ? proxyUrlProblem(n.proxyUrl) : null;
    const pacProblem = n.proxyMode === 'pac' ? pacUrlProblem(n.pacUrl ?? '') : null;
    const loginShown = n.proxyMode !== 'off' && n.proxyMode !== 'environment';
    const userProblem = loginShown && (/[\s:]/.test(n.proxyUser) || n.proxyUser.length > 200) ? 'The user name cannot contain spaces or ":" (at most 200 characters).' : null;
    const domainProblem = loginShown && n.proxyAuth === 'ntlm' && ((n.proxyDomain ?? '').length > 100 || /[\s\\/@:]/.test(n.proxyDomain ?? '')) ? 'The Windows domain is a name such as CORP (no spaces, \\ / @ or :).' : null;
    const problem = urlProblem ?? pacProblem ?? userProblem ?? domainProblem;
    /** true when saved (also for "Leave without saving?" → Save). */
    const save = async (force = false): Promise<boolean> => {
        if (problem) return false;
        setBusy('save');
        // The version this tab read: a save over network settings changed since (another tab) is refused, not merged away.
        const version = kept ? kept.version : (s as StudioSettings & { networkVersion?: string }).networkVersion;
        try { onChange(await datagitApi.saveNetwork(networkToSave(n, s.network), version, force)); setKept(null); message.success('Network settings saved'); setCheck(null); return true; }
        catch (e) {
            askStaleSave(app, e, 'The network settings', {
                reload: () => { setKept(null); void api.settings().then((x) => { onChange(x); setN(x.network); }).catch((x) => message.error(errText(x))); },
                overwrite: () => { setBusy(null); return save(true); },
                keep: (v) => setKept({ version: v }),
            });
            return false;
        } finally { setBusy(null); }
    };
    // Network settings changed but not saved: leaving the screen (menu, Back, a typed address) asks first.
    useUnsaved('settings-network', dirty, 'the network settings', { lostOnLeave: true, save: () => save(), discard: () => setN(s.network) });
    return (
        <Card size="small" title={<span>Studio connections <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>Azure DevOps, API requests, load tests</Typography.Text>{' '}
            <Tooltip title="Off by default. Set this on a company network (VDI). Git and the framework's own test runs have their own settings (the Git view, and ADO_PROXY_* in the project's config)."><InfoCircleOutlined style={{ color: 'var(--ant-color-text-tertiary, #999)' }} /></Tooltip></span>}>
            <Form layout="vertical">
                <Form.Item label="Proxy">
                    <Radio.Group value={n.proxyMode} onChange={(e) => setN({ ...n, proxyMode: e.target.value })}>
                        <Space direction="vertical">
                            <Radio value="off">Off: connect directly</Radio>
                            <Radio value="environment">Use the environment's proxy (HTTPS_PROXY){info.environmentProxy ? <Typography.Text type="secondary">: {info.environmentProxy}</Typography.Text> : <Typography.Text type="secondary">: not set on this computer</Typography.Text>}</Radio>
                            <Radio value="system">This computer's proxy settings (Windows / macOS, their PAC file too){sysInfo?.system ? <Typography.Text type="secondary">: {sysInfo.system.pacUrl ? `PAC ${sysInfo.system.pacUrl}` : sysInfo.system.httpsProxy ?? sysInfo.system.proxy ?? 'none set'}</Typography.Text> : null}</Radio>
                            <Radio value="pac">A PAC file (proxy auto-configuration):</Radio>
                            <Radio value="manual">This proxy:</Radio>
                        </Space>
                    </Radio.Group>
                </Form.Item>
                {n.proxyMode === 'pac' && <div style={{ paddingLeft: 24 }}>
                    <Form.Item label="PAC file address" htmlFor="cs-networksettings-pac" validateStatus={pacProblem ? 'error' : undefined} help={pacProblem ?? undefined} tooltip="http://wpad.company.local/wpad.dat, or a file path">
                        <Input id="cs-networksettings-pac" value={n.pacUrl} onChange={(e) => setN({ ...n, pacUrl: e.target.value })} placeholder="http://wpad.company.local/proxy.pac" style={{ maxWidth: 420 }} className="mono" />
                    </Form.Item>
                </div>}
                {(n.proxyMode === 'pac' || n.proxyMode === 'system') && sysInfo && (sysInfo.error ? <Alert type="warning" showIcon message={sysInfo.error} style={{ marginBottom: 12 }} />
                    : sysInfo.pacFrom ? <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{sysInfo.pacLoaded ? 'PAC file loaded from' : 'PAC file not loaded yet:'} {sysInfo.pacFrom}</Typography.Paragraph> : null)}
                {n.proxyMode !== 'off' && n.proxyMode !== 'environment' && <div style={{ paddingLeft: 24 }}>
                    {n.proxyMode === 'manual' && <Form.Item label="Address" htmlFor="cs-networksettings-address" validateStatus={urlProblem ? 'error' : undefined} help={urlProblem ?? undefined} tooltip="Server and port, e.g. http://proxy.company.com:8080">
                        <Input id="cs-networksettings-address" value={n.proxyUrl} onChange={(e) => setN({ ...n, proxyUrl: e.target.value })} placeholder="http://proxy.company.com:8080" style={{ maxWidth: 420 }} className="mono" />
                    </Form.Item>}
                    <Form.Item label="How the proxy signs you in" validateStatus={domainProblem ? 'error' : undefined} help={domainProblem ?? undefined}>
                        <Space wrap>
                            <Select value={n.proxyAuth ?? 'basic'} onChange={(v) => setN({ ...n, proxyAuth: v })} style={{ width: 240 }} aria-label="Proxy sign-in"
                                options={[{ value: 'basic', label: 'Basic (or no sign-in)' }, { value: 'ntlm', label: 'NTLM (Windows)' }, { value: 'digest', label: 'Digest' }]} />
                            {n.proxyAuth === 'ntlm' && <Input value={n.proxyDomain} onChange={(e) => setN({ ...n, proxyDomain: e.target.value })} placeholder="Windows domain, e.g. CORP" style={{ width: 200 }} aria-label="Windows domain" />}
                        </Space>
                    </Form.Item>
                    <Form.Item label="Login (only if the proxy asks for one)" validateStatus={userProblem ? 'error' : undefined} help={userProblem ?? undefined} tooltip="The password is kept in your secret store (encrypted), never in a settings file, and is not given to test runs.">
                        <Space wrap>
                            <Input value={n.proxyUser} onChange={(e) => setN({ ...n, proxyUser: e.target.value })} placeholder="User name" style={{ width: 200 }} />
                            <Input.Password value={pw} onChange={(e) => setPw(e.target.value)} placeholder={info.hasProxyPassword ? 'Password saved; type to replace' : 'Password'} style={{ width: 220 }} autoComplete="new-password" />
                            <Button disabled={!pw} loading={busy === 'pw'} onClick={async () => { setBusy('pw'); try { onChange(await api.setProxyPassword(pw)); setPw(''); message.success('Proxy password saved in your secret store'); } catch (e) { message.error(errText(e)); } finally { setBusy(null); } }}>Save password</Button>
                            {info.hasProxyPassword && <Button type="link" danger onClick={async () => { try { onChange(await api.setProxyPassword(null)); message.success('Proxy password removed'); } catch (e) { message.error(errText(e)); } }}>Remove</Button>}
                        </Space>
                    </Form.Item>
                    <Form.Item label="Connect directly to (bypass)" htmlFor="cs-networksettings-connect-directly-to-bypass" tooltip="Host names or suffixes such as .company.local">
                        <Select id="cs-networksettings-connect-directly-to-bypass" mode="tags" open={false} placeholder=".company.local (type, then Enter)" value={n.bypass} onChange={(v: string[]) => setN({ ...n, bypass: v })} tokenSeparators={[',', ' ']} style={{ maxWidth: 520 }} />
                    </Form.Item>
                </div>}
                <Collapse size="small" style={{ marginBottom: 16 }} defaultActiveKey={(n.clientCerts?.length || n.caFile || n.useSystemCerts) ? ['certs'] : []}
                    items={[{ key: 'certs', label: <span>Certificates <Typography.Text type="secondary" style={{ fontSize: 12 }}>company root, client certificates</Typography.Text></span>, children: <>
                <Form.Item label="Client certificates (mutual TLS)" tooltip="For APIs that ask for your certificate: per host (or .suffix), a .pfx/.p12 file, or a PEM certificate and key. The passphrase goes in your secret store.">
                    <ClientCerts value={n.clientCerts ?? []} onChange={(clientCerts) => setN({ ...n, clientCerts })} />
                </Form.Item>
                <Form.Item label="Trusted certificates" tooltip="A company proxy that inspects HTTPS (e.g. Zscaler) re-signs sites with the company's root certificate. Trust it here, never by turning certificate checks off.">
                    <Space direction="vertical" style={{ width: '100%' }}>
                        <Space>
                            <Switch aria-label="Use this computer's certificate store" checked={n.useSystemCerts} disabled={!info.systemCertsSupported && !n.useSystemCerts} onChange={(v) => setN({ ...n, useSystemCerts: v })} />
                            <span>Use this computer's certificates (Windows certificate store / macOS keychain), where IT installs the company root</span>
                        </Space>
                        {!info.systemCertsSupported && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Not available with Node.js {info.nodeVersion} (needs 22.15 or later). Use a certificate file instead.</Typography.Text>}
                        <Space wrap>
                            <Input value={n.caFile} onChange={(e) => { setN({ ...n, caFile: e.target.value }); setCerts(null); }} placeholder="Company root certificate file (.pem / Base-64 .cer), full path" style={{ width: 460 }} className="mono" />
                            <Button disabled={!n.caFile} onClick={async () => { try { setCerts((await api.readCertificates(n.caFile)).certificates); } catch (e) { setCerts(null); message.error(errText(e)); } }}>Check file</Button>
                        </Space>
                        {certs && <Space direction="vertical" size={0}>{certs.map((c, i) => <Typography.Text key={i} style={{ fontSize: 12 }}><Tag color="green">will be trusted</Tag>{c.subject} <Typography.Text type="secondary">(valid until {c.validTo})</Typography.Text></Typography.Text>)}</Space>}
                        <Space>
                            <Switch aria-label="Also trust them in test runs" size="small" checked={n.certsForTestRuns} onChange={(v) => setN({ ...n, certsForTestRuns: v })} />
                            <span style={{ fontSize: 13 }}>Also trust them in test runs (for the framework's own Azure DevOps publishing)</span>
                        </Space>
                    </Space>
                </Form.Item>
                    </> }]} />
                <Space>
                    <Button type="primary" disabled={!dirty || !!problem} title={problem ?? undefined} loading={busy === 'save'} onClick={() => void save()}>Save network settings</Button>
                    <Button loading={busy === 'test'} disabled={dirty} title={dirty ? 'Save first' : undefined}
                        onClick={async () => { setBusy('test'); setCheck(null); try { setCheck(await api.testNetwork()); } catch (e) { message.error(errText(e)); } finally { setBusy(null); } }}>Test connection</Button>
                    {check && !check.tokenChecked && check.ok && <Typography.Text type="secondary" style={{ fontSize: 12 }}>(network only: no Azure DevOps token or project config to check)</Typography.Text>}
                </Space>
                {check && <Result r={check} />}
            </Form>
        </Card>
    );
}

export function GitNetworkCard({ studioProxy }: { studioProxy: string }) {
    const { message, modal } = App.useApp();
    const [st, setSt] = React.useState<GitNetworkState | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [proxy, setProxy] = React.useState('');
    const [caInfo, setCaInfo] = React.useState('');
    const [check, setCheck] = React.useState<GitConnectionCheck | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const load = React.useCallback(async () => {
        try { const s = await api.gitNetwork(); setSt(s); setProxy(s.global['http.proxy'] ?? ''); setCaInfo(s.global['http.sslCAInfo'] ?? ''); setErr(null); }
        catch (e) { setErr(errText(e)); }
    }, []);
    React.useEffect(() => { void load(); }, [load]);
    // A Git proxy or certificate file typed but not applied: leaving the screen asks first.
    const gitDirty = !!st && (proxy.trim() !== (st.global['http.proxy'] ?? '') || caInfo.trim() !== (st.global['http.sslCAInfo'] ?? ''));
    useUnsaved('settings-git-network', gitDirty, 'the Git network settings (not applied)', { lostOnLeave: true, discard: () => { if (st) { setProxy(st.global['http.proxy'] ?? ''); setCaInfo(st.global['http.sslCAInfo'] ?? ''); } } });
    if (err) return <Alert type="error" showIcon message="Git network settings" description={err} />;
    if (!st) return null;

    // Show the exact git commands, then run them on confirmation.
    const change = async (c: GitNetworkChange) => {
        try {
            const { commands } = await api.previewGitNetwork(c);
            if (!commands.length) { message.info('Nothing to change'); return; }
            modal.confirm({
                title: 'Change your global Git settings?',
                content: <><Typography.Paragraph>These commands change Git for every repository on this computer:</Typography.Paragraph>
                    <pre className="mono" style={{ fontSize: 12, background: 'rgba(127,127,127,0.08)', padding: 8, borderRadius: 4, whiteSpace: 'pre-wrap' }}>{commands.join('\n')}</pre></>,
                okText: 'Run them',
                onOk: async () => { try { const r = await api.applyGitNetwork(c); setSt(r.state); setProxy(r.state.global['http.proxy'] ?? ''); setCaInfo(r.state.global['http.sslCAInfo'] ?? ''); message.success('Git settings changed'); setCheck(null); } catch (e) { message.error(errText(e)); } },
            });
        } catch (e) { message.error(errText(e)); }
    };
    const win = st.platform === 'win32';
    const verifyOff = /^(false|0|no|off)$/i.test(st.effective['http.sslVerify']?.value ?? '') || !!st.environment.GIT_SSL_NO_VERIFY;
    const overridden = (['http.proxy', 'http.sslBackend', 'http.sslCAInfo'] as const).filter((k) => st.effective[k] && st.effective[k]!.value !== st.global[k]);

    return (
        <Card size="small" title={<span>Git <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>Fetch, Pull, Push · Git {st.gitVersion}</Typography.Text></span>}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>Git's own global settings on this computer. Nothing changes until you confirm the exact commands.</Typography.Paragraph>
            {verifyOff && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="Git certificate checks are turned OFF"
                description={<>{st.environment.GIT_SSL_NO_VERIFY ? 'GIT_SSL_NO_VERIFY is set in the environment. ' : ''}With checks off, anyone between you and the server can read your code and credentials. Trust the company certificate instead (below).</>}
                action={st.effective['http.sslVerify'] ? <Button size="small" danger onClick={() => void change({ restoreSslVerify: true })}>Turn checks back on</Button> : undefined} />}
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }} items={[
                { key: 'p', label: 'Proxy (http.proxy)', children: st.effective['http.proxy'] ? <span className="mono">{st.effective['http.proxy'].value}</span> : <Typography.Text type="secondary">none{st.environment.HTTPS_PROXY ? ` (environment: ${st.environment.HTTPS_PROXY})` : ''}</Typography.Text> },
                { key: 'b', label: 'SSL backend (http.sslBackend)', children: st.effective['http.sslBackend']?.value ?? <Typography.Text type="secondary">Git's default</Typography.Text> },
                { key: 'c', label: 'Certificate file (http.sslCAInfo)', children: st.effective['http.sslCAInfo'] ? <span className="mono">{st.effective['http.sslCAInfo'].value}</span> : <Typography.Text type="secondary">Git's default</Typography.Text> },
            ]} />
            {overridden.length > 0 && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`This repository or the system overrides: ${overridden.map((k) => `${k} (${st.effective[k]!.origin})`).join(', ')}`} />}
            <Form layout="vertical">
                <Form.Item label="Proxy for Git" tooltip="Leave empty for no proxy. Do not put the password in the address (Git would store it in plain text); Git Credential Manager asks for the proxy login.">
                    <Space wrap>
                        <Input value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://proxy.company.com:8080" style={{ width: 360 }} className="mono" />
                        <Button onClick={() => void change({ proxy: proxy.trim() || null })} disabled={proxy.trim() === (st.global['http.proxy'] ?? '')}>Apply</Button>
                        {studioProxy && studioProxy !== proxy && <Button type="link" onClick={() => setProxy(studioProxy)}>Use the Studio's proxy</Button>}
                    </Space>
                </Form.Item>
                {win && <Form.Item label="Certificates" tooltip="Recommended on a company network: Git uses the Windows certificate store, where IT installs the company root.">
                    <Space>
                        <Button type={st.global['http.sslBackend'] === 'schannel' ? 'default' : 'primary'} disabled={st.global['http.sslBackend'] === 'schannel'} onClick={() => void change({ sslBackend: 'schannel' })}>Use the Windows certificate store (schannel)</Button>
                        {st.global['http.sslBackend'] && <Button type="link" onClick={() => void change({ sslBackend: null })}>Back to Git's default</Button>}
                    </Space>
                </Form.Item>}
                <Form.Item label="Company root certificate file for Git (http.sslCAInfo)" tooltip={win ? 'Only needed if you do not use the Windows certificate store.' : 'A PEM file with the company root certificate.'}>
                    <Space wrap>
                        <Input value={caInfo} onChange={(e) => setCaInfo(e.target.value)} placeholder="Full path to the .pem file" style={{ width: 420 }} className="mono" />
                        <Button onClick={() => void change({ sslCAInfo: caInfo.trim() || null })} disabled={caInfo.trim() === (st.global['http.sslCAInfo'] ?? '')}>Apply</Button>
                    </Space>
                </Form.Item>
                <Button loading={busy === 'test'} onClick={async () => { setBusy('test'); setCheck(null); try { setCheck(await api.testGitNetwork()); } catch (e) { message.error(errText(e)); } finally { setBusy(null); } }}>Test Git connection</Button>
                {check && <Result r={check} />}
            </Form>
        </Card>
    );
}
