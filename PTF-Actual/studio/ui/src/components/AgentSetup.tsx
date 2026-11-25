/**
 * Getting agents ready, in the Studio: the agents runtime (installed once per computer, one click) and the
 * GitHub account (signed in from the Studio, like an editor: in the browser, or with a code).
 */
import React from 'react';
import { Alert, App, Button, Dropdown, Input, Progress, Radio, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { CloudDownloadOutlined, CopyOutlined, DownOutlined, GithubOutlined, LogoutOutlined, ReloadOutlined } from '@ant-design/icons';
import { AgentRuntimeDef, AgentStatus, api, SignInStateDef } from '../api';
import { errText } from '../state';

/** The runtime: install (with npm's progress), update, remove. */
export function RuntimeSetup({ status, onChange, compact }: { status: AgentStatus; onChange: () => void; compact?: boolean }) {
    const { message, modal } = App.useApp();
    const [rt, setRt] = React.useState<AgentRuntimeDef | null>(status.runtime ?? null);
    const [showLog, setShowLog] = React.useState(false);
    React.useEffect(() => { if (status.runtime) setRt(status.runtime); }, [status.runtime]);
    React.useEffect(() => {
        if (!rt?.install.running) return;
        const t = setInterval(() => {
            api.agentRuntime().then((r) => { setRt(r); if (!r.install.running) { clearInterval(t); if (r.install.ok) { message.success(`Agents runtime ${r.studioVersion ?? ''} installed.`); onChange(); } } }).catch(() => {});
        }, 1000);
        return () => clearInterval(t);
    }, [rt?.install.running, message, onChange]);
    if (!rt) return null;
    const install = async (version?: string) => { try { setRt(await api.agentRuntimeInstall(version)); } catch (e) { message.error(errText(e)); } };
    const inst = rt.install;
    const version = rt.pinned ?? rt.tested;
    const lastLine = inst.log[inst.log.length - 1] ?? '';
    const elapsed = inst.running && inst.startedAt ? Math.round((Date.now() - inst.startedAt) / 1000) : 0;

    if (inst.running) {
        return <Alert type="info" showIcon icon={<Spin size="small" />} message={`Installing the agents runtime (${inst.target})…`}
            description={<Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Progress percent={Math.min(95, Math.round(elapsed / 1.2))} size="small" status="active" showInfo={false} aria-label="Install progress" />
                <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }} ellipsis>{lastLine}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>About 200 MB, once for this computer. You can keep working meanwhile.</Typography.Text>
            </Space>}
            action={<Button size="small" onClick={() => void api.agentRuntimeCancel()}>Cancel</Button>} />;
    }
    const failed = inst.ok === false && inst.error;
    // Installed, but it does not start (an older Node.js, a damaged install): the reason, not another install.
    if (!rt.installed && rt.problem) {
        return <Alert type="error" showIcon message="The agents runtime is installed but cannot start"
            description={<Space direction="vertical" size={4}><Typography.Text>{rt.problem}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Folder: {rt.folder}</Typography.Text></Space>}
            action={<Space direction="vertical"><Button size="small" icon={<ReloadOutlined />} onClick={onChange}>Check again</Button>
                <Button size="small" onClick={() => modal.confirm({ title: 'Install the agents runtime again?', content: 'Use this when the install is damaged. It does not help with an older Node.js.', okText: 'Install again', onOk: () => install() })}>Install again</Button></Space>} />;
    }
    if (!rt.installed) {
        return <Alert type={failed ? 'error' : 'info'} showIcon icon={<CloudDownloadOutlined />}
            message={failed ? 'The agents runtime could not be installed' : 'Install the agents runtime'}
            description={<Space direction="vertical" size={4}>
                {failed ? <Typography.Text>{inst.error}</Typography.Text>
                    : <Typography.Text>Agents run on the GitHub Copilot runtime. The Studio installs it once for this computer (about 200 MB, with your npm and network settings); your projects and pipelines do not change.</Typography.Text>}
                {rt.pinned && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Version {rt.pinned}, set by the team's agent policy.</Typography.Text>}
                {failed && !!inst.log.length && <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide' : 'Show'} npm's output</Button>}
                {showLog && <pre className="code-box" style={{ maxHeight: 200, overflow: 'auto', fontSize: 11 }}>{inst.log.join('\n')}</pre>}
            </Space>}
            action={<Button type="primary" size="small" icon={failed ? <ReloadOutlined /> : <CloudDownloadOutlined />} onClick={() => void install()}>{failed ? 'Try again' : `Install (${version})`}</Button>} />;
    }
    if (compact) return null;
    const where = rt.source === 'repository' ? 'from this repository' : rt.source === 'studio' ? 'installed by the Studio' : 'next to the Studio';
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
            <Typography.Text type="secondary">Agents runtime</Typography.Text><Tag bordered={false} color="green">{rt.version}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{where}</Typography.Text>
            {failed && <Tag color="red" bordered={false}>last update failed: {inst.error}</Tag>}
            {rt.source !== 'repository' && <>
                {!rt.pinned && <Tooltip title="Install the newest published version"><Button size="small" onClick={() => void install('latest')}>Update to latest</Button></Tooltip>}
                {rt.pinned && rt.pinned !== rt.version && <Button size="small" onClick={() => void install()}>Install {rt.pinned} (team policy)</Button>}
                {rt.studioVersion && <Button size="small" type="text" danger onClick={() => modal.confirm({ title: 'Remove the agents runtime from this computer?', content: 'Agents stop working until it is installed again. Conversations are kept.', okText: 'Remove', okButtonProps: { danger: true }, onOk: async () => { try { setRt(await api.agentRuntimeRemove()); onChange(); } catch (e) { message.error(errText(e)); } } })}>Remove</Button>}
            </>}
        </div>
    );
}

/** The GitHub account for Copilot: sign in (browser or code; github.com or Enterprise Cloud), switch, sign out, plan usage. */
export function AccountSetup({ status, onChange, compact }: { status: AgentStatus; onChange: () => void; compact?: boolean }) {
    const { message, modal } = App.useApp();
    const [si, setSi] = React.useState<SignInStateDef>(status.signIn ?? { active: false });
    const [input, setInput] = React.useState('');
    const [choice, setChoice] = React.useState<string>('');
    const opened = React.useRef('');
    React.useEffect(() => { if (status.signIn) setSi(status.signIn); }, [status.signIn]);
    React.useEffect(() => {
        if (!si.active) return;
        const t = setInterval(() => {
            api.agentSignIn().then((s) => {
                setSi(s);
                if (!s.active) { clearInterval(t); if (s.step?.kind === 'done') { message.success(`Signed in${s.step.login ? ` as ${s.step.login}` : ''}.`); setTimeout(onChange, 800); } }
            }).catch(() => {});
        }, 1500);
        return () => clearInterval(t);
    }, [si.active, message, onChange]);
    // The GitHub page opens once, by itself (the person can open it again).
    React.useEffect(() => {
        const st = si.step;
        const url = st?.kind === 'open-url' ? st.url : st?.kind === 'device-code' ? st.verificationUri : '';
        if (url && opened.current !== url) { opened.current = url; window.open(url, '_blank', 'noopener'); }
    }, [si.step]);

    const begin = async (provider: 'githubDotCom' | 'proxima', method: 'web' | 'device-code') => {
        opened.current = '';
        try { setSi(await api.agentSignInBegin(provider, method)); } catch (e) { message.error(errText(e)); }
    };
    const answer = async (a: { input?: string; selectionId?: string; consent?: boolean }) => { try { setSi(await api.agentSignInAnswer(a)); } catch (e) { message.error(errText(e)); } };
    const cancel = async () => { try { setSi(await api.agentSignInCancel()); } catch (e) { message.error(errText(e)); } };
    const auth = status.auth;
    const menu = { items: [
        { key: 'code', label: 'Sign in with a code (device)' },
        { key: 'ghe', label: 'GitHub Enterprise Cloud (*.ghe.com)' },
        { key: 'ghe-code', label: 'GitHub Enterprise Cloud, with a code' },
    ], onClick: ({ key }: { key: string }) => void begin(key.startsWith('ghe') ? 'proxima' : 'githubDotCom', key.endsWith('code') ? 'device-code' : 'web') };
    const signInButton = <Dropdown.Button type="primary" size="small" icon={<DownOutlined />} menu={menu} onClick={() => void begin('githubDotCom', 'web')}><GithubOutlined /> Sign in with GitHub</Dropdown.Button>;

    if (si.active && si.step) {
        const st = si.step;
        const body = st.kind === 'open-url' ? <Space direction="vertical" size={4}>
            <Typography.Text>Continue in your browser: GitHub asks you to authorize GitHub Copilot.</Typography.Text>
            <Space><Button size="small" type="primary" icon={<GithubOutlined />} href={st.url} target="_blank" rel="noopener">Open the GitHub page</Button><Spin size="small" /><Typography.Text type="secondary">Waiting for GitHub…</Typography.Text></Space>
        </Space>
            : st.kind === 'device-code' ? <Space direction="vertical" size={6}>
                <Typography.Text>Enter this code on the GitHub page:</Typography.Text>
                <Space>
                    <Typography.Text className="mono" style={{ fontSize: 26, letterSpacing: 4, fontWeight: 600 }} aria-label="Sign-in code">{st.userCode}</Typography.Text>
                    <Tooltip title="Copy"><Button size="small" icon={<CopyOutlined />} aria-label="Copy the code" onClick={() => { void navigator.clipboard?.writeText(st.userCode); message.success('Copied.'); }} /></Tooltip>
                </Space>
                <Space><Button size="small" type="primary" icon={<GithubOutlined />} href={st.verificationUri} target="_blank" rel="noopener">Open {st.verificationUri.replace(/^https?:\/\//, '')}</Button><Spin size="small" /><Typography.Text type="secondary">Waiting for GitHub… (code valid for {Math.max(0, Math.round((st.expiresAt - Date.now()) / 60000))} min)</Typography.Text></Space>
            </Space>
                : st.kind === 'input-required' ? <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Typography.Text>{st.prompt}</Typography.Text>
                    <Space.Compact style={{ maxWidth: 420, width: '100%' }}><Input size="small" placeholder="https://your-company.ghe.com" value={input} onChange={(e) => setInput(e.target.value)} onPressEnter={() => void answer({ input })} aria-label="GitHub Enterprise address" /><Button size="small" type="primary" onClick={() => void answer({ input })}>Continue</Button></Space.Compact>
                </Space>
                    : st.kind === 'choose-account' ? <Space direction="vertical" size={4}>
                        <Typography.Text>Which account should Copilot use?</Typography.Text>
                        <Radio.Group value={choice} onChange={(e) => setChoice(e.target.value)}><Space direction="vertical">{st.accounts.map((a) => <Radio key={a.selectionId} value={a.selectionId}>{a.login} <Typography.Text type="secondary">({a.host.replace(/^https?:\/\//, '')})</Typography.Text></Radio>)}</Space></Radio.Group>
                        <Button size="small" type="primary" disabled={!choice} onClick={() => void answer({ selectionId: choice })}>Use this account</Button>
                    </Space>
                        : st.kind === 'store-consent' ? <Space direction="vertical" size={4}>
                            <Typography.Text>{st.text}</Typography.Text>
                            <Space><Button size="small" type="primary" onClick={() => void answer({ consent: true })}>Keep the sign-in</Button><Button size="small" onClick={() => void answer({ consent: false })}>Don't keep it</Button></Space>
                        </Space>
                            : <Space><Spin size="small" /><Typography.Text type="secondary">Starting the sign-in…</Typography.Text></Space>;
        return <Alert type="info" showIcon icon={<GithubOutlined />} message={`Signing in to ${si.provider === 'proxima' ? 'GitHub Enterprise Cloud' : 'GitHub'}`} description={body}
            action={<Button size="small" onClick={() => void cancel()}>Cancel</Button>} />;
    }
    const last = si.step;
    const lastNote = last?.kind === 'error' ? <Alert type="error" showIcon message="Sign-in did not complete" description={last.message} closable style={{ marginBottom: 8 }} /> : null;

    if (!auth?.isAuthenticated) {
        if (status.settings?.provider !== 'copilot') return lastNote;
        return <>{lastNote}<Alert type="warning" showIcon icon={<GithubOutlined />} message="Sign in to GitHub Copilot"
            description={compact ? 'Agents use your GitHub Copilot licence.' : <span>Agents use your GitHub Copilot licence: sign in with your GitHub account (the browser opens GitHub to authorize). On GitHub Enterprise Cloud, or without a browser here, use the arrow. A token for automation is in Settings.</span>}
            action={signInButton} /></>;
    }
    if (compact) return lastNote;
    const premium = status.quota?.premium_interactions;
    const others = (status.accounts ?? []).filter((a) => !a.active);
    const host = auth.host && !/github\.com/.test(auth.host) ? auth.host.replace(/^https?:\/\//, '') : '';
    return (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {lastNote}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
                <GithubOutlined /><Typography.Text>Signed in as <b>{auth.login ?? 'GitHub user'}</b>{host ? ` (${host})` : ''}</Typography.Text>
                {auth.tokenFromStudio && <Tag bordered={false}>token from the Studio</Tag>}
                {!!others.length && <Select size="small" style={{ width: 200 }} placeholder="Switch account" aria-label="Switch account" value={null}
                    options={others.map((a) => ({ value: a.selectionId, label: `${a.login} (${a.host.replace(/^https?:\/\//, '')})` }))}
                    onChange={(v: string) => void api.agentSwitchAccount(v).then(() => { message.success('Switched.'); onChange(); }).catch((e) => message.error(errText(e)))} />}
                <Dropdown menu={menu}><Button size="small">Add an account <DownOutlined /></Button></Dropdown>
                <Button size="small" icon={<LogoutOutlined />} onClick={() => modal.confirm({
                    title: 'Sign out of GitHub Copilot?', content: auth.tokenFromStudio ? 'The GitHub token kept in the Studio is forgotten as well.' : 'Conversations are kept; agents need a sign-in again.', okText: 'Sign out',
                    onOk: async () => { try { await api.agentSignOut(!!auth.tokenFromStudio); message.success('Signed out.'); onChange(); } catch (e) { message.error(errText(e)); } },
                })}>Sign out</Button>
            </div>
            {premium && <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Premium requests</Typography.Text>
                {premium.unlimited ? <Tag bordered={false} color="green">unlimited</Tag> : <>
                    <Progress style={{ width: 160, margin: 0 }} size="small" percent={Math.round(100 - premium.remainingPercent)} status={premium.remainingPercent < 10 ? 'exception' : 'normal'} showInfo={false} aria-label="Premium requests used" />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{premium.used} of {premium.entitlement} used{premium.overage ? `, ${premium.overage} over` : ''}{premium.resetDate ? ` · resets ${premium.resetDate.slice(0, 10)}` : ''}</Typography.Text>
                </>}
            </div>}
        </Space>
    );
}
