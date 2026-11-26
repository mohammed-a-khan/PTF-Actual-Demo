/**
 * Copilot inline suggestions in the Studio's editor: the status (one store for the whole page, asked
 * for while an editor shows it), the status-bar item, the setup panel (install, sign in, on/off; also
 * on Agents › Setup) and the provider the editor asks for ghost text.
 */
import React from 'react';
import { Alert, Button, Modal, Progress, Space, Spin, Switch, Tag, Tooltip, Typography } from 'antd';
import { CloudDownloadOutlined, CopyOutlined, GithubOutlined, LogoutOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, CopilotStatusDef } from '../api';
import { errText } from '../state';
import type { InlineProvider } from './CodeEditor';

// ---------------------------------------------------------------- the status store
let current: CopilotStatusDef | null = null;
let pending = 0;
let failed: string | null = null;
const subs = new Set<() => void>();
let timer: number | undefined;
let wantStart = false;
const emit = () => { for (const f of subs) f(); };

/** Use a status an action returned (no wait for the next poll). */
export function setCopilotStatus(s: CopilotStatusDef) { current = s; failed = null; emit(); schedule(); }
const transitional = (s: CopilotStatusDef | null) => !!s && (s.state === 'installing' || s.state === 'starting' || s.state === 'working' || !!s.signIn || (s.state === 'stopped' && wantStart));

function poll() {
    window.clearTimeout(timer);
    timer = undefined;
    if (!subs.size) return;
    api.copilotStatus(wantStart).then((s) => { current = s; failed = null; emit(); }, (e) => { failed = errText(e); emit(); }).finally(schedule);
}
function schedule() {
    window.clearTimeout(timer);
    if (!subs.size) return;
    timer = window.setTimeout(poll, transitional(current) ? 1500 : 15000);
}

/**
 * The status, kept fresh while a component shows it. start: the editor is open, so the language
 * server may start (on demand, once it is installed and turned on).
 */
export function useCopilotStatus(start = false): { status: CopilotStatusDef | null; busy: boolean; error: string | null } {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => {
        if (start) wantStart = true;
        subs.add(force);
        if (subs.size === 1 || !current) poll();
        return () => { subs.delete(force); if (!subs.size) { window.clearTimeout(timer); timer = undefined; } };
    }, [start]);
    return { status: current, busy: pending > 0, error: failed };
}

/** The editor's source of ghost text for a file (asks only while Copilot is ready). */
export function copilotProvider(path: string): InlineProvider {
    return {
        suggest: async (text, offset, o) => {
            const st = current;
            // Stopped (not used for a while, or it crashed): the request starts it again.
            if (!st || (st.state !== 'ready' && st.state !== 'working' && !(st.state === 'stopped' && st.user))) return [];
            pending++; emit();
            try {
                const r = await api.copilotSuggest(path, text, offset, { invoked: o.invoked, tabSize: o.tabSize, insertSpaces: o.insertSpaces }, o.signal);
                return r.items;
            } finally { pending--; emit(); }
        },
        shown: (id) => { void api.copilotShown(id).catch(() => undefined); },
        accepted: (id, acceptedLength) => { void api.copilotAccepted(id, acceptedLength).catch(() => undefined); },
    };
}

// ---------------------------------------------------------------- status bar item
const LABEL: Record<string, string> = {
    off: 'off', 'not-installed': 'set up', installing: 'installing…', stopped: 'idle', starting: 'starting…', 'sign-in': 'sign in', ready: 'ready', working: 'working…', error: 'error',
};
const DOT: Record<string, string> = { off: 'off', 'not-installed': 'warn', installing: 'busy', stopped: 'ok', starting: 'busy', 'sign-in': 'warn', ready: 'ok', working: 'busy', error: 'err' };

/** "Copilot: ready" in the editor's status bar; a click opens the setup. */
export function CopilotStatusItem() {
    const { status, busy, error } = useCopilotStatus(true);
    const [open, setOpen] = React.useState(false);
    const state = error ? 'error' : !status ? null : busy && status.state === 'ready' ? 'working' : status.state;
    if (!state) return null;
    const why = error ?? status?.reason ?? (state === 'sign-in' ? 'Sign in to GitHub to get inline suggestions.' : state === 'not-installed' ? 'Install the Copilot language server to get inline suggestions.' : state === 'ready' || state === 'working' ? `Inline suggestions${status?.user ? ` as ${status.user}` : ''}: Tab accepts, Ctrl+→ accepts a word, Alt+] next, Esc dismisses.` : '');
    return (
        <>
            <Tooltip title={why || undefined}>
                <button type="button" className={`ed-copilot ${DOT[state] ?? ''}`} onClick={() => setOpen(true)} aria-label={`Copilot: ${LABEL[state] ?? state}${why ? `. ${why}` : ''}`}>
                    <GithubOutlined /> Copilot: {LABEL[state] ?? state}
                </button>
            </Tooltip>
            <Modal open={open} onCancel={() => setOpen(false)} footer={null} title="GitHub Copilot inline suggestions" width={560} destroyOnClose>
                <CopilotSetup />
            </Modal>
        </>
    );
}

// ---------------------------------------------------------------- setup panel
/** Install, sign in, turn on or off: in the editor's status-bar dialog and on Agents › Setup. */
export function CopilotSetup() {
    const { status: st, error } = useCopilotStatus(false);
    const [busy, setBusy] = React.useState('');
    const [msg, setMsg] = React.useState<string | null>(null);
    const opened = React.useRef('');
    const act = async (key: string, f: () => Promise<CopilotStatusDef>) => {
        setBusy(key); setMsg(null);
        try { setCopilotStatus(await f()); } catch (e) { setMsg(errText(e)); } finally { setBusy(''); }
    };
    // The GitHub page opens once, by itself (the code is shown to type there).
    React.useEffect(() => {
        const u = st?.signIn?.verificationUri;
        if (u && opened.current !== u + st?.signIn?.userCode) { opened.current = u + st?.signIn?.userCode; window.open(u, '_blank', 'noopener'); }
    }, [st?.signIn?.verificationUri, st?.signIn?.userCode]);
    if (!st) return error ? <Alert type="error" showIcon message={error} /> : <Spin size="small" />;
    const toggle = (
        <Space size={8} align="center">
            <Switch size="small" checked={st.enabled} loading={busy === 'toggle'} onChange={(v) => void act('toggle', () => api.copilotSetEnabled(v))} aria-label="Inline suggestions in the editor" />
            <Typography.Text>Inline suggestions in the editor (ghost text)</Typography.Text>
        </Space>
    );
    const note = msg ? <Alert type="error" showIcon message={msg} closable onClose={() => setMsg(null)} /> : null;
    let body: React.ReactNode = null;
    const inst = st.install;
    if (st.state === 'off') body = st.reason && st.enabled ? <Alert type="info" showIcon message={st.reason} /> : null;
    else if (st.state === 'installing') {
        const elapsed = inst.startedAt ? Math.round((Date.now() - inst.startedAt) / 1000) : 0;
        body = <Alert type="info" showIcon icon={<Spin size="small" />} message={`Installing the Copilot language server (${inst.target ?? ''})…`}
            description={<Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Progress percent={Math.min(95, Math.round(elapsed * 2))} size="small" status="active" showInfo={false} aria-label="Install progress" />
                <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }} ellipsis>{inst.log[inst.log.length - 1] ?? ''}</Typography.Text>
            </Space>}
            action={<Button size="small" onClick={() => void act('cancel', api.copilotInstallCancel)}>Cancel</Button>} />;
    } else if (st.state === 'not-installed') {
        body = <Alert type={inst.ok === false ? 'error' : 'info'} showIcon icon={<CloudDownloadOutlined />}
            message={inst.ok === false ? 'The Copilot language server could not be installed' : 'Install the Copilot language server'}
            description={inst.ok === false && inst.error ? inst.error : 'GitHub\'s official Copilot language server gives the editor its inline suggestions. The Studio installs it once for this computer (about 90 MB, with your npm and network settings), next to the agents runtime.'}
            action={<Button type="primary" size="small" loading={busy === 'install'} icon={inst.ok === false ? <ReloadOutlined /> : <CloudDownloadOutlined />} onClick={() => void act('install', () => api.copilotInstall())}>{inst.ok === false ? 'Try again' : `Install (${st.tested})`}</Button>} />;
    } else if (st.signIn) {
        const s = st.signIn;
        body = <Alert type="info" showIcon icon={<GithubOutlined />} message="Sign in to GitHub"
            description={<Space direction="vertical" size={6}>
                <Typography.Text>Enter this code on the GitHub page:</Typography.Text>
                <Space>
                    <Typography.Text className="mono" style={{ fontSize: 24, letterSpacing: 4, fontWeight: 600 }} aria-label="Sign-in code">{s.userCode}</Typography.Text>
                    <Tooltip title="Copy"><Button size="small" icon={<CopyOutlined />} aria-label="Copy the code" onClick={() => { void navigator.clipboard?.writeText(s.userCode); }} /></Tooltip>
                </Space>
                <Space wrap><Button size="small" type="primary" icon={<GithubOutlined />} href={s.verificationUri} target="_blank" rel="noopener">Open {s.verificationUri.replace(/^https?:\/\//, '')}</Button><Spin size="small" /><Typography.Text type="secondary">Waiting for GitHub… (code valid for {Math.max(0, Math.round((s.expiresAt - Date.now()) / 60000))} min)</Typography.Text></Space>
            </Space>}
            action={<Button size="small" onClick={() => void act('cancel', api.copilotSignInCancel)}>Cancel</Button>} />;
    } else if (st.state === 'sign-in') {
        body = <Alert type="warning" showIcon icon={<GithubOutlined />} message="Sign in to GitHub Copilot"
            description={<Space direction="vertical" size={6}>
                <Typography.Text>Suggestions use your GitHub Copilot plan (Copilot Free works). Sign in with a code you enter on github.com.</Typography.Text>
                {st.reason && <Typography.Text type="danger">{st.reason}</Typography.Text>}
                {!!st.existing?.length && <Space wrap size={4}><Typography.Text type="secondary">Already signed in in another Copilot editor on this computer:</Typography.Text>
                    {st.existing.map((x) => <Button key={x.tokenId} size="small" loading={busy === `use${x.tokenId}`} onClick={() => void act(`use${x.tokenId}`, () => api.copilotUseExisting(x.tokenId))}>Use {x.login}</Button>)}</Space>}
            </Space>}
            action={<Button type="primary" size="small" icon={<GithubOutlined />} loading={busy === 'signin'} onClick={() => void act('signin', api.copilotSignIn)}>Sign in with GitHub</Button>} />;
    } else if (st.state === 'error') {
        body = <Alert type="error" showIcon message="Copilot is not working" description={st.reason ?? st.message}
            action={<Button size="small" icon={<ReloadOutlined />} loading={busy === 'restart'} onClick={() => void act('restart', api.copilotRestart)}>Start again</Button>} />;
    } else if (st.state === 'starting' || st.state === 'stopped') {
        body = <Space><Spin size="small" spinning={st.state === 'starting'} /><Typography.Text type="secondary">{st.state === 'starting' ? 'Starting the Copilot language server…' : st.reason ?? 'It starts when you open a file in the editor.'}</Typography.Text>
            {st.state === 'stopped' && <Button size="small" loading={busy === 'check'} onClick={() => void act('check', api.copilotCheck)}>Start now</Button>}</Space>;
    } else {
        body = <Space wrap size={8}>
            <GithubOutlined /><Typography.Text>Signed in{st.user ? <> as <b>{st.user}</b></> : ''}</Typography.Text>
            <Tag bordered={false} color="green">ready</Tag>
            <Button size="small" icon={<LogoutOutlined />} loading={busy === 'signout'} onClick={() => void act('signout', api.copilotSignOut)}>Sign out</Button>
        </Space>;
    }
    return (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {toggle}
            {note}
            {body}
            {st.installed && st.state !== 'installing' && <Space size={8} wrap style={{ fontSize: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Copilot language server {st.custom ? '(custom command, CS_STUDIO_COPILOT_LSP)' : st.version}</Typography.Text>
                {!st.custom && st.version !== st.tested && <Button size="small" type="link" onClick={() => void act('install', () => api.copilotInstall())}>Install {st.tested}</Button>}
                {!st.custom && <Button size="small" type="link" onClick={() => void act('install', () => api.copilotInstall('latest'))}>Update to latest</Button>}
                {!st.custom && <Button size="small" type="link" danger onClick={() => void act('remove', api.copilotRemove)}>Remove</Button>}
            </Space>}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                In the editor: Tab accepts a suggestion, Ctrl+→ accepts the next word, Alt+] / Alt+[ show other suggestions, Esc dismisses.
                Files that may hold secrets (.env, keys, saved sessions) are never sent, and secret values the Studio knows are blanked out first.
                The company proxy and certificates from Settings › Network are used.
            </Typography.Text>
        </Space>
    );
}
