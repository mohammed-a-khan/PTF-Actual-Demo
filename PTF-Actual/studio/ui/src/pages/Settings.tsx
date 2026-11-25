/**
 * Personal settings: stored on this computer only (never in the repository), so a cloned project
 * cannot change who the Studio sends your Azure DevOps token to.
 */
import React from 'react';
import { Alert, App, Button, Card, Col, Form, Input, InputNumber, Radio, Row, Segmented, Select, Space, Switch, Tabs, Tooltip, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { api, McpSettings, StudioSettings } from '../api';
import { errText } from '../state';
import { GitNetworkCard, StudioNetworkCard } from './NetworkSettings';
import { navigate, useRoute } from '../route';
import { asciiDigits, charCount, useStoredTab } from '../datagit-common';

/** The same limits as the server (src/git/identity.ts): what Git is given as your name and email. */
export const IDENTITY_NAME_MAX = 100;
const HIDDEN = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
export function identityNameProblem(name: string): string | null {
    const n = name.trim();
    if (!n) return name ? 'Enter your name (not only spaces).' : 'Enter your name.';
    const len = charCount(n);
    if (len > IDENTITY_NAME_MAX) return `Too long: at most ${IDENTITY_NAME_MAX} characters (it has ${len}).`;
    if (/[<>]/.test(n)) return 'A name cannot contain < or > (Git writes it as "Name <email>").';
    if (HIDDEN.test(n)) return 'No line breaks, tabs or hidden direction marks (such as right-to-left override) in the name.';
    return null;
}
export function identityEmailProblem(email: string): string | null {
    const e = email.trim();
    if (!e) return 'Enter your email address: Git puts it on every commit, next to your name.';
    if (e.length > 254) return 'Too long: at most 254 characters.';
    if (HIDDEN.test(e) || !/^[^\s@<>]+@[^\s@<>]+$/.test(e)) return 'Enter an email address, such as name@company.com.';
    return null;
}
/** A secret name, as the server keeps it. */
export const SECRET_NAME_MAX = 64;

const SETTINGS_TABS = ['general', 'ado', 'network', 'assistants'] as const;
type SettingsTab = typeof SETTINGS_TABS[number];

export function Settings() {
    const { message } = App.useApp();
    const [s, setS] = React.useState<StudioSettings | null>(null);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [name, setName] = React.useState('');
    const [email, setEmail] = React.useState('');
    const [scope, setScope] = React.useState<'repository' | 'global'>('repository');
    const [busy, setBusy] = React.useState<string | null>(null);
    const [netPart, setNetPart] = useStoredTab<'studio' | 'git'>('settings-network', ['studio', 'git'], 'studio');
    // The tab is in the address (#/settings/ado), so other screens can open it; the last one is remembered.
    const route = useRoute();
    const [storedTab, storeTab] = useStoredTab<SettingsTab>('settings', SETTINGS_TABS, 'general');
    // No tab in the address: the one used last; a wrong one (#/settings/bogus): General.
    const tab: SettingsTab = SETTINGS_TABS.includes(route[1] as SettingsTab) ? route[1] as SettingsTab : route[1] ? 'general' : storedTab;
    const setTab = (t: SettingsTab) => { storeTab(t); navigate(['settings', t]); };
    React.useEffect(() => { if (route[0] === 'settings' && route[1] !== tab) navigate(['settings', tab], true); }, [route, tab]);
    React.useEffect(() => { if (SETTINGS_TABS.includes(route[1] as SettingsTab) && route[1] !== storedTab) storeTab(route[1] as SettingsTab); }, [route]); // eslint-disable-line react-hooks/exhaustive-deps

    const load = React.useCallback(async () => {
        try {
            const r = await api.settings();
            setS(r); setName(r.git.name); setEmail(r.git.email); setScope(r.git.scope === 'global' ? 'global' : 'repository'); setLoadError(null);
        } catch (e) { setLoadError(errText(e)); }
    }, []);
    React.useEffect(() => { void load(); }, [load]);

    // Bumped when a value is refused: the fields are drawn again from the saved settings (not what was typed).
    const [rev, setRev] = React.useState(0);
    const reset = () => setRev((x) => x + 1);
    const save = async (k: string, patch: Partial<Omit<StudioSettings, 'git'>>) => {
        setBusy(k);
        try { const r = await api.saveSettings(patch); setS(r); message.success('Saved'); }
        catch (e) { message.error(errText(e)); reset(); }
        finally { setBusy(null); }
    };

    // Said as you type (the server refuses the same): an empty email too, once the name is there or the email was touched.
    const [emailTouched, setEmailTouched] = React.useState(false);
    const nameProblem = identityNameProblem(name);
    const emailProblem = identityEmailProblem(email);
    const idOk = !nameProblem && !emailProblem;
    const saveIdentity = async () => {
        if (!s || !idOk || busy === 'git') return;
        setBusy('git');
        try { const g = await api.setGitIdentity(name.trim(), email.trim(), scope); setS({ ...s, git: g }); message.success('Saved'); }
        catch (e) { message.error(errText(e)); }
        finally { setBusy(null); }
    };

    if (loadError) return <Alert type="error" showIcon message="Could not load settings" description={loadError} />;
    if (!s) return null;

    const tabs = [
        {
            key: 'general', label: 'General', children: <div className="dg-settings-col">
                <Card title="Your name on commits" size="small">
                    {s.git.scope === 'none' && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Git does not know your name and email yet, so commits will fail. Fill them in below." />}
                    <Form layout="vertical" onFinish={() => void saveIdentity()}>
                        <Row gutter={16}>
                            <Col xs={24} md={12}>
                                <Form.Item label="Name" htmlFor="cs-settings-name" validateStatus={nameProblem ? 'error' : undefined} help={nameProblem ?? undefined}>
                                    <Input id="cs-settings-name" value={name} count={{ show: true, max: IDENTITY_NAME_MAX, strategy: charCount }} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item label="Email" htmlFor="cs-settings-email" tooltip="The address your team knows you by (the one in Azure DevOps)." validateStatus={emailProblem && (email || emailTouched || name.trim()) ? 'error' : undefined} help={emailProblem && (email || emailTouched || name.trim()) ? emailProblem : undefined}>
                                    <Input id="cs-settings-email" value={email} onChange={(e) => { setEmail(e.target.value); setEmailTouched(true); }} onBlur={() => setEmailTouched(true)} placeholder="name@company.com" />
                                </Form.Item>
                            </Col>
                        </Row>
                        <Form.Item label="Use for">
                            <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
                                <Radio value="repository">This project only</Radio>
                                <Radio value="global">All projects on this computer</Radio>
                            </Radio.Group>
                        </Form.Item>
                        <Tooltip title={nameProblem ?? emailProblem ?? undefined}><Button type="primary" htmlType="submit" loading={busy === 'git'} disabled={!idOk}>Save name and email</Button></Tooltip>
                    </Form>
                </Card>
                <Card title="Starting the Studio" size="small">
                    <Form layout="vertical">
                        <Row gutter={16}>
                            <Col xs={24} md={12}>
                                <Form.Item label="Port" htmlFor="cs-settings-port" tooltip="A fixed port keeps your bookmark working. If it is busy, the next free one is used. Takes effect the next time you start the Studio.">
                                    <InputNumber id="cs-settings-port" precision={0} style={{ width: '100%' }} defaultValue={s.port} key={`${s.port}-${rev}`} addonAfter={s.port === 0 ? 'any free port' : undefined}
                                        parser={(t) => Number(asciiDigits(t ?? '').replace(/[\s,]/g, ''))}
                                        onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
                                        onBlur={(e) => {
                                            // Digits of other scripts (١٢٣٤) count as 0-9; anything else is said, never dropped silently.
                                            const raw = asciiDigits(String(e.target.value)).replace(/[\s,]/g, ''), v = Number(raw);
                                            if (raw === '') { reset(); return; }
                                            if (!/^\d+$/.test(raw)) { message.error(`Port: digits only, 0 (any free port) or 1024–65535: still ${s.port}.`); reset(); return; }
                                            if (v === s.port) return;
                                            // 0: any free port; otherwise 1024–65535 (lower ports need administrator rights).
                                            if (!Number.isInteger(v) || (v !== 0 && (v < 1024 || v > 65535))) { message.error(`Port: 0 (any free port) or 1024–65535: still ${s.port}.`); reset(); return; }
                                            void save('port', { port: v });
                                        }} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item label="Open the browser when the Studio starts">
                                    <Switch aria-label="Open the browser when the Studio starts" checked={s.openBrowser} loading={busy === 'open'} onChange={(v) => void save('open', { openBrowser: v })} />
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Card>
                <Card title="Team results" size="small">
                    <Form layout="vertical">
                        <Form.Item label="Shared folder for load-test results" htmlFor="cs-settings-team" style={{ marginBottom: 0 }}
                            tooltip="A network share or synced folder the team can reach (e.g. \\files\perf-results). Runs you share, and results imported from pipelines, go there; everyone sees the same history and trends.">
                            <Input id="cs-settings-team" className="mono" defaultValue={s.loadTeamFolder ?? ''} key={`${s.loadTeamFolder ?? ''}-${rev}`} placeholder="\\files\perf-results" allowClear count={{ show: (o) => o.count > 400, max: 500 }}
                                onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
                                onBlur={(e) => {
                                    const raw = e.target.value, v = raw.trim();
                                    // Only spaces, or longer than the limit: said, and the saved folder shown again.
                                    if (raw && !v) { message.warning(s.loadTeamFolder ? `Only spaces: still ${s.loadTeamFolder}. Clear the field (×) to stop sharing.` : 'Only spaces: no shared folder is set.'); reset(); return; }
                                    if (v.length > 500) { message.error(`The folder path is too long: at most 500 characters (it has ${v.length}).`); reset(); return; }
                                    if (v !== (s.loadTeamFolder ?? '')) void save('team', { loadTeamFolder: v });
                                }} />
                        </Form.Item>
                    </Form>
                </Card>
            </div>,
        },
        {
            key: 'ado', label: 'Azure DevOps', children: <div className="dg-settings-col">
                <Card title="Azure DevOps" size="small">
                    <Form layout="vertical">
                        <Form.Item label="How you sign in"
                            tooltip={s.adoAuth === 'entra' ? 'Your Azure sign-in ("az login" on this computer), or a service principal / managed identity set in the environment (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID). No token to store or renew.' : 'A personal access token kept in your secret store.'}>
                            <Radio.Group value={s.adoAuth ?? 'pat'} onChange={(e) => void save('auth', { adoAuth: e.target.value })}>
                                <Radio value="pat">Personal access token</Radio>
                                <Radio value="entra">Entra ID (Azure sign-in, no PAT)</Radio>
                            </Radio.Group>
                        </Form.Item>
                        <Row gutter={16}>
                            {(s.adoAuth ?? 'pat') === 'pat' && <Col xs={24} md={10}>
                                <Form.Item label="Secret that holds your token" htmlFor="ado-pat-secret"
                                    tooltip="Add it under Secrets with this name. It is sent only to Azure DevOps (dev.azure.com, *.visualstudio.com, or a server you list), and only over https."
                                    extra={<Button type="link" size="small" style={{ padding: 0 }} onClick={() => navigate(['secrets', 'add', s.adoPatSecret])}>Add or replace {s.adoPatSecret} in Secrets</Button>}>
                                    <Input defaultValue={s.adoPatSecret} key={`${s.adoPatSecret}-${rev}`} id="ado-pat-secret" className="mono" count={{ show: true, max: SECRET_NAME_MAX }}
                                        onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
                                        onBlur={(e) => {
                                            const v = e.target.value.trim().toUpperCase();
                                            // Empty or not a secret name: said, and the saved name shown again.
                                            if (!v) { message.warning(`The secret name cannot be empty: still ${s.adoPatSecret}.`); reset(); return; }
                                            if (v.length > SECRET_NAME_MAX) { message.error(`The secret name is too long: at most ${SECRET_NAME_MAX} characters (it has ${v.length}): still ${s.adoPatSecret}.`); reset(); return; }
                                            if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(v)) { message.error(`A secret name: Latin letters (A-Z), digits and _, not starting with a digit (for example ADO_PAT): still ${s.adoPatSecret}.`); reset(); return; }
                                            if (v !== s.adoPatSecret) void save('pat', { adoPatSecret: v }); else if (e.target.value.trim() !== v) reset(); // ado_pat → ADO_PAT
                                        }} />
                                </Form.Item>
                            </Col>}
                            <Col xs={24} md={(s.adoAuth ?? 'pat') === 'pat' ? 14 : 24}>
                                <Form.Item label="Azure DevOps Server hosts (on-premises)" tooltip="Host names only, e.g. tfs.mycompany.com. Leave empty if you use dev.azure.com.">
                                    <Select aria-label="Trusted Azure DevOps hosts" mode="tags" value={s.trustedAdoHosts} tokenSeparators={[',', ' ']} placeholder="tfs.mycompany.com (type, then Enter)"
                                        open={false} onChange={(v: string[]) => {
                                            const hosts = v.map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '')).filter(Boolean);
                                            // A host that is not a plain host name is said, not dropped without a word.
                                            const bad = hosts.filter((h) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h));
                                            if (bad.length) { message.error(`Not a host name: ${bad.join(', ')} (for example tfs.mycompany.com).`); return; }
                                            void save('hosts', { trustedAdoHosts: [...new Set(hosts)] });
                                        }} />
                                </Form.Item>
                            </Col>
                        </Row>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>The organization and project come from the project's config (ADO_ORGANIZATION, ADO_PROJECT): see <Typography.Link onClick={() => navigate(['env'])}>Environments</Typography.Link>.</Typography.Text>
                    </Form>
                </Card>
            </div>,
        },
        {
            key: 'network', label: 'Network', children: <div className="dg-settings-col">
                <Segmented value={netPart} onChange={(v) => setNetPart(v as 'studio' | 'git')} style={{ alignSelf: 'flex-start' }}
                    options={[{ value: 'studio', label: 'Studio connections' }, { value: 'git', label: 'Git (Fetch, Pull, Push)' }]} />
                {netPart === 'studio' ? <StudioNetworkCard s={s} onChange={setS} /> : <GitNetworkCard studioProxy={s.network.proxyMode === 'manual' ? s.network.proxyUrl : ''} />}
            </div>,
        },
        { key: 'assistants', label: 'Assistants & tools', children: <div className="dg-settings-col"><McpCard /></div> },
    ];
    return (
        <Tabs size="small" activeKey={tab} onChange={(k) => setTab(k as SettingsTab)} items={tabs} className="dg-tabs" destroyInactiveTabPane={false} />
    );
}

/** The Studio as an MCP server: any MCP client connects straight to it (address + token), nothing in between. */
function McpCard() {
    const { message, modal } = App.useApp();
    const [m, setM] = React.useState<McpSettings | null>(null);
    const [show, setShow] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => { api.mcpSettings().then(setM).catch(() => setM(null)); }, []);
    if (!m) return null;
    const copy = (t: string, what: string) => { void navigator.clipboard?.writeText(t).then(() => message.success(`${what} copied`), () => message.info(t)); };
    const config = JSON.stringify({ 'cs-test-studio': { type: 'http', url: m.url, headers: { Authorization: `Bearer ${show ? m.token : '<token>'}` } } }, null, 2);
    const toggle = async (v: boolean) => { setBusy(true); try { setM(await api.mcpSetEnabled(v)); message.success(v ? 'MCP server on' : 'MCP server off'); } catch (e) { message.error(errText(e)); } finally { setBusy(false); } };
    return (
        <Card title="Assistants over MCP" size="small" className="dg-settings-card">
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
                Optional: lets an AI assistant in another app (your editor, a command-line agent) work with the Studio.{' '}
                <Tooltip title="The Studio's own agents do not need it. When on, that assistant connects straight to the Studio with the address and token below, every call shows in Agents, and you approve its changes there."><InfoCircleOutlined /></Tooltip>
                {' '}To give the Studio's agents more tools, use <Typography.Link onClick={() => navigate(['agents'])}>Agents → Tool servers</Typography.Link>.
            </Typography.Paragraph>
            <Form layout="vertical">
                <Form.Item label="MCP server">
                    <Switch aria-label="MCP server" checked={m.enabled} loading={busy} onChange={(v) => void toggle(v)} />
                    {m.refusal && <Typography.Text type="warning" style={{ marginLeft: 10, fontSize: 12 }}>{m.refusal}</Typography.Text>}
                </Form.Item>
                {m.enabled && <>
                    <Form.Item label="Address" tooltip="Streamable HTTP. A fixed port (Settings → General) keeps the address the same.">
                        <Space.Compact style={{ width: '100%', maxWidth: 520 }}><Input readOnly value={m.url} aria-label="MCP address" className="mono" /><Button onClick={() => copy(m.url, 'Address')}>Copy</Button></Space.Compact>
                    </Form.Item>
                    <Form.Item label="Token" tooltip="Sent as Authorization: Bearer <token>. Only for /mcp (not the Studio's link). Renew it if it leaked: clients then need the new one.">
                        <Space.Compact style={{ width: '100%', maxWidth: 520 }}>
                            <Input.Password readOnly value={m.token} visibilityToggle={{ visible: show, onVisibleChange: setShow }} aria-label="MCP token" className="mono" />
                            <Button onClick={() => copy(m.token, 'Token')}>Copy</Button>
                            <Button onClick={() => modal.confirm({ title: 'Renew the MCP token?', content: 'Connected assistants stop working until they get the new token.', okText: 'Renew', onOk: async () => { try { setM(await api.mcpRenewToken()); message.success('New token made'); } catch (e) { message.error(errText(e)); } } })}>Renew</Button>
                        </Space.Compact>
                    </Form.Item>
                    <Form.Item label="Client configuration" tooltip="The usual shape of an MCP client's server entry; put it where your client keeps its MCP servers.">
                        <pre className="code-box" style={{ margin: 0, maxWidth: 520 }}>{config}</pre>
                        <Button size="small" style={{ marginTop: 6 }} onClick={() => copy(JSON.stringify({ 'cs-test-studio': { type: 'http', url: m.url, headers: { Authorization: `Bearer ${m.token}` } } }, null, 2), 'Configuration')}>Copy with the token</Button>
                    </Form.Item>
                </>}
            </Form>
        </Card>
    );
}
