/**
 * Copilot in the Studio, on every screen: chat with an agent that knows the screen you are on (sent
 * with each message), uses the Studio's tools, the Studio browser (Browser tab, live) and the
 * framework's QA tools, and asks before changing anything (approval cards).
 */
import React from 'react';
import { Alert, App, Button, Empty, Input, Select, Space, Spin, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, DeleteOutlined, DownloadOutlined, HistoryOutlined, PlusOutlined, SendOutlined, SettingOutlined, StopOutlined, ToolOutlined } from '@ant-design/icons';
import { AgentEventDef, AgentSessionInfo, AgentStatus, AgentUsage, api, TeamAgentDef } from '../api';
import { AgentChanges } from './AgentChanges';
import { Replay } from './Replay';
import { AccountSetup, RuntimeSetup } from './AgentSetup';
import { errText } from '../state';
import { navigate } from '../route';
import { Markdown } from './Markdown';
import { AgentBrowser } from './AgentBrowser';
import { agentContext, subscribeAgentContext, takePendingAsk } from '../agentContext';
import { tokens, toItems } from '../agentEvents';
export { toItems };

const ctxLabel = (c: Record<string, unknown>) => [c.page, c.project, c.file ?? c.collection ?? c.scenario ?? c.connection ?? c.run].filter(Boolean).map(String).join(' · ');

export function AgentPanel({ open, initialSession, onClose }: { open: boolean; initialSession?: string | null; onClose?: () => void }) {
    const { message, modal } = App.useApp();
    const [status, setStatus] = React.useState<AgentStatus | null>(null);
    const [sessions, setSessions] = React.useState<AgentSessionInfo[]>([]);
    const [replaying, setReplaying] = React.useState(false);
    const [current, setCurrent] = React.useState<string | null>(() => { try { return localStorage.getItem('cs-studio-agent-session'); } catch { return null; } });
    const [events, setEvents] = React.useState<AgentEventDef[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [text, setText] = React.useState('');
    const [tab, setTab] = React.useState('chat');
    const [ctx, setCtx] = React.useState(agentContext());
    const [loading, setLoading] = React.useState(false);
    const [usage, setUsage] = React.useState<AgentUsage | null>(null);
    const [changes, setChanges] = React.useState(0);
    const seq = React.useRef(0);
    const bottom = React.useRef<HTMLDivElement>(null);
    const rootRef = React.useRef<HTMLDivElement>(null);
    // Esc closes the panel when it is the top layer (also over a mission's drawer), not while a dialog or a list is open.
    React.useEffect(() => {
        if (!open || !onClose) return;
        const f = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            if (document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal, .ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-dropdown:not(.ant-dropdown-hidden), .ant-popover:not(.ant-popover-hidden), .ant-image-preview-wrap')) return;
            const mine = rootRef.current?.closest('.ant-drawer');
            const drawers = [...document.querySelectorAll('.ant-drawer.ant-drawer-open')];
            if (!mine || drawers[drawers.length - 1] !== mine) return;
            e.stopPropagation();
            onClose();
        };
        window.addEventListener('keydown', f, true);
        return () => window.removeEventListener('keydown', f, true);
    }, [open, onClose]);

    // A screen asks the panel to close (the Inbox, when Back undoes its "Open" of a conversation).
    React.useEffect(() => {
        if (!open || !onClose) return;
        const f = () => onClose();
        window.addEventListener('cs-studio:close-copilot', f);
        return () => window.removeEventListener('cs-studio:close-copilot', f);
    }, [open, onClose]);
    React.useEffect(() => subscribeAgentContext(() => setCtx(agentContext())), []);
    React.useEffect(() => { if (initialSession) setCurrent(initialSession); }, [initialSession]);
    React.useEffect(() => { try { if (current) localStorage.setItem('cs-studio-agent-session', current); } catch { /* private mode */ } }, [current]);
    const refresh = React.useCallback(() => api.agentSessions().then((r) => setSessions(r.sessions)).catch(() => {}), []);
    const reload = React.useCallback(() => { api.agentStatus().then(setStatus).catch((e) => setStatus({ error: errText(e) } as AgentStatus)); }, []);
    React.useEffect(() => {
        if (!open) return;
        setLoading(true);
        api.agentStatus().then(setStatus).catch((e) => setStatus({ error: errText(e) } as AgentStatus)).finally(() => setLoading(false));
        void refresh();
    }, [open, refresh]);

    // Follow the session: fast while it works or waits for an approval.
    React.useEffect(() => { seq.current = 0; setEvents([]); setUsage(null); setChanges(0); }, [current]);
    const exportTranscript = async () => {
        if (!current) return;
        try {
            const md = await api.agentTranscript(current);
            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' })); a.download = `agent-conversation-${current}.md`; a.click(); URL.revokeObjectURL(a.href);
        } catch (e) { message.error(errText(e)); }
    };
    React.useEffect(() => {
        if (!open || !current) return;
        let stop = false;
        const tick = async () => {
            try {
                const r = await api.agentEvents(current, seq.current);
                if (stop) return;
                // Not a conversation (a mistyped or old address, or deleted elsewhere): said, and not shown as an empty one.
                if (r.known === false && !r.events.length && seq.current === 0) {
                    message.warning(`Conversation "${current.slice(0, 80)}" not found: it may have been deleted.`);
                    try { localStorage.removeItem('cs-studio-agent-session'); } catch { /* private mode */ }
                    setCurrent(null);
                    return;
                }
                if (r.events.length) { seq.current = r.events[r.events.length - 1].seq; setEvents((x) => [...x, ...r.events]); }
                setBusy(r.busy);
                if (r.usage) setUsage(r.usage);
                setChanges(r.changes ?? 0);
                if (!stop) setTimeout(tick, r.busy || r.events.length ? 500 : 2000);
            } catch { if (!stop) setTimeout(tick, 3000); }
        };
        void tick();
        return () => { stop = true; };
    }, [open, current]);
    React.useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [events.length]);

    const items = React.useMemo(() => toItems(events), [events]);
    // Conversations only: missions, their team members and evaluation runs have their own screens.
    const chats = sessions.filter((s) => !s.id.startsWith('mission-'));
    const ready = status?.sdk?.installed && status.auth?.isAuthenticated !== false && !status.error && !status.policyProblems?.length;
    // Why the message box is off, in the box itself.
    const notReady = !status ? 'Checking the agents…' : status.policyProblems?.length ? 'Agents are not allowed by this repository\'s policy (see above)' : status.runtime?.install.running ? 'Wait for the agents runtime to finish installing…'
        : !status.sdk?.installed ? (status.runtime?.problem ? 'The agents runtime cannot start (see above)' : 'Install the agents runtime above to start') : status.auth?.isAuthenticated === false ? 'Sign in to GitHub Copilot above to start (or choose another model provider in Agents → Settings)' : status.error ? 'The agents could not start (see above)' : '';

    // One conversation per click: a double click (or a click while one is being made) makes no second one.
    const creating = React.useRef(false);
    const [makingChat, setMakingChat] = React.useState(false);
    const newChat = async () => {
        if (creating.current) return;
        creating.current = true; setMakingChat(true);
        try { const s = await api.agentCreate(); setCurrent(s.id); await refresh(); } catch (e) { message.error(errText(e)); } finally { creating.current = false; setMakingChat(false); }
    };
    // A question handed over by a screen ("Explain with Copilot"): in the box, ready to send.
    React.useEffect(() => {
        const first = takePendingAsk();
        if (first) setText(first);
        const f = (e: Event) => { setText((e as CustomEvent<string>).detail); takePendingAsk(); };
        window.addEventListener('cs-studio:ask-copilot', f);
        return () => window.removeEventListener('cs-studio:ask-copilot', f);
    }, []);
    // A team agent's conversation: its description and starters (Agent Builder).
    const sessionAgent = sessions.find((x) => x.id === current)?.agent;
    const [teamAgent, setTeamAgent] = React.useState<TeamAgentDef | null>(null);
    React.useEffect(() => { if (!sessionAgent) { setTeamAgent(null); return; } api.agentBuilder().then((r) => setTeamAgent(r.agents.find((a) => a.id === sessionAgent.id) ?? null)).catch(() => setTeamAgent(null)); }, [sessionAgent?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    const send = async () => {
        const t = text.trim();
        if (!t) return;
        try {
            let id = current;
            if (!id) { if (creating.current) return; creating.current = true; try { const s = await api.agentCreate(); id = s.id; setCurrent(id); } finally { creating.current = false; } }
            setText('');
            setBusy(true);
            await api.agentSend(id, t, agentContext());
            void refresh();
        } catch (e) { setBusy(false); message.error(errText(e)); }
    };
    const decide = (id: string, d: 'once' | 'session' | 'reject') => current && api.agentDecide(current, id, d).catch((e) => message.error(errText(e)));

    const head = (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Select size="small" style={{ flex: 1, minWidth: 0 }} value={current ?? undefined} placeholder="Conversations" aria-label="Conversation" showSearch optionFilterProp="label"
                onChange={setCurrent} options={chats.map((s) => ({ value: s.id, label: `${s.busy ? '● ' : ''}${s.title}${chats.filter((x) => x.title === s.title).length > 1 ? ` · ${new Date(s.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ''}` }))} />
            <Tooltip title="New conversation"><Button size="small" icon={<PlusOutlined />} aria-label="New conversation" disabled={!ready} loading={makingChat} onClick={() => void newChat()} /></Tooltip>
            <Tooltip title="Delete this conversation"><Button size="small" icon={<DeleteOutlined />} aria-label="Delete conversation" disabled={!current}
                onClick={() => modal.confirm({ title: 'Delete this conversation?', okText: 'Delete', okButtonProps: { danger: true }, onOk: async () => { try { await api.agentDelete(current!); setCurrent(null); await refresh(); } catch (e) { message.error(errText(e)); } } })} /></Tooltip>
            <Tooltip title="Export the conversation (Markdown: messages, tools, approvals, changed files, usage)"><Button size="small" icon={<DownloadOutlined />} aria-label="Export conversation" disabled={!current} onClick={() => void exportTranscript()} /></Tooltip>
            <Tooltip title="Replay the conversation step by step"><Button size="small" icon={<HistoryOutlined />} aria-label="Replay conversation" disabled={!current} onClick={() => setReplaying(true)} /></Tooltip>
            <Tooltip title="Agents: setup & settings"><Button size="small" icon={<SettingOutlined />} aria-label="Agent settings" onClick={() => navigate(['agents', 'setup'])} /></Tooltip>
        </div>
    );

    // An MCP client's conversation needs no runtime or sign-in here (the assistant runs in its own app).
    const setup = !status || current?.startsWith('mcp-') ? null : !status.sdk?.installed || status.runtime?.install.running
        ? <RuntimeSetup status={status} onChange={reload} compact />
        : status.policyProblems?.length ? <Alert type="error" showIcon message="Not allowed by this repository's agent policy" description={status.policyProblems.join(' ')} />
        : status.error ? <Alert type="error" showIcon message="The agent runtime could not start" description={status.error} />
            : <AccountSetup status={status} onChange={reload} compact />;

    return (
        <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8, minHeight: 0 }}>
            {head}
            {replaying && current && <Replay session={current} title={sessions.find((x) => x.id === current)?.title ?? current} onClose={() => setReplaying(false)} />}
            {loading && !status ? <Spin /> : setup}
            <Tabs size="small" activeKey={tab} onChange={setTab} style={{ flex: 1, minHeight: 0 }} className="agent-tabs" items={[
                { key: 'chat', label: 'Chat', children: (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                        <div style={{ flex: 1, overflow: 'auto', paddingRight: 4 }} aria-live="polite">
                            {!items.length && (teamAgent ? (
                                <Space direction="vertical" style={{ width: '100%', padding: 12 }}>
                                    <Typography.Text strong>{teamAgent.name}</Typography.Text>
                                    {teamAgent.description && <Typography.Text type="secondary">{teamAgent.description}</Typography.Text>}
                                    {(teamAgent.starters ?? []).map((st) => <Button key={st} size="small" style={{ textAlign: 'left', whiteSpace: 'normal', height: 'auto' }} onClick={() => setText(st)}>{st}</Button>)}
                                </Space>
                            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>Ask about this screen, or give a task: <i>"Automate story 1234 end to end"</i>, <i>"Add a negative test for this request"</i>, <i>"Why did this run fail? Fix it."</i></span>} />)}
                            {items.map((it) => it.kind === 'user' ? <div key={it.seq} className="agent-msg agent-user">{it.text}</div>
                                : it.kind === 'assistant' ? <div key={it.seq} className="agent-msg agent-assistant"><Markdown text={it.text} />{it.streaming && <span className="agent-caret" />}</div>
                                    : it.kind === 'tool' ? <details key={it.seq} className="agent-tool">
                                        <summary><ToolOutlined /> <b>{it.server ? `${it.server} › ` : ''}{it.tool}</b> {!it.done ? <Spin size="small" /> : it.done.ok ? <Tag color="green" bordered={false}>done</Tag> : <Tag color="red" bordered={false}>failed</Tag>}</summary>
                                        <pre className="code-box" style={{ maxHeight: 160 }}>{it.args}</pre>{it.done && <pre className="code-box" style={{ maxHeight: 220 }}>{it.done.result}</pre>}</details>
                                        : it.kind === 'approval' ? <div key={it.seq} className="agent-approval">
                                            <Typography.Text strong>{it.title}</Typography.Text>
                                            {it.detail && <pre className="code-box" style={{ maxHeight: it.what === 'plan' ? 420 : 200 }}>{it.detail}</pre>}
                                            {it.decided ? <Tag color={it.decided === 'reject' ? 'red' : 'green'} bordered={false}>{it.decided === 'reject' ? 'Rejected' : it.decided === 'session' ? 'Approved for this conversation' : 'Approved'}</Tag>
                                                : <Space size={4} wrap>
                                                    {/* A test plan: read (and change) it in the editor, then approve or reject this one plan. */}
                                                    {it.what === 'plan' && /: (.+\.feature)$/.test(it.title) && <Button size="small" onClick={() => navigate(['code', /: (.+\.feature)$/.exec(it.title)![1]])}>Open the plan</Button>}
                                                    <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => void decide(it.id, 'once')}>Approve</Button>
                                                    {it.what !== 'plan' && <Button size="small" onClick={() => void decide(it.id, 'session')}>Approve for this conversation</Button>}
                                                    <Button size="small" danger icon={<CloseOutlined />} onClick={() => void decide(it.id, 'reject')}>{it.what === 'plan' ? 'Change it' : 'Reject'}</Button></Space>}
                                        </div>
                                            : <div key={it.seq} className={`agent-note${it.error ? ' agent-error' : ''}`}>{it.text}</div>)}
                            {busy && <div className="agent-note"><Spin size="small" /> Working…</div>}
                            <div ref={bottom} />
                        </div>
                        {usage && usage.calls > 0 && <Typography.Text type="secondary" style={{ fontSize: 11, marginTop: 4 }}>{usage.model ? `${usage.model} · ` : ''}{usage.calls} model call{usage.calls === 1 ? '' : 's'} · {tokens(usage.inputTokens + usage.outputTokens)}{usage.cost ? ` · ${Math.round(usage.cost * 100) / 100} premium requests` : ''}</Typography.Text>}
                        {ctxLabel(ctx) && <Tooltip title={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(ctx, null, 1)}</pre>}><Tag bordered={false} style={{ alignSelf: 'flex-start', marginTop: 6 }}>Screen: {ctxLabel(ctx)}</Tag></Tooltip>}
                        {current?.startsWith('mcp-') ? <Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 6 }}>An assistant outside the Studio (over MCP) works here: write to it in that app. Its tool calls show above; approve or reject its changes here.</Typography.Text>
                        : <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 8 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={ready ? 'Ask or give a task (Enter sends, Shift+Enter: new line)' : notReady} aria-label="Message to the agent" disabled={!ready}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) void send(); } }} />
                            {busy ? <Tooltip title="Stop"><Button danger icon={<StopOutlined />} aria-label="Stop the agent" onClick={() => current && void api.agentAbort(current)} /></Tooltip>
                                : <Tooltip title="Send"><Button type="primary" icon={<SendOutlined />} aria-label="Send" disabled={!ready || !text.trim()} onClick={() => void send()} /></Tooltip>}
                        </div>}
                    </div>) },
                { key: 'changes', label: <span>Changes{changes ? <Tag bordered={false} color="gold" style={{ marginLeft: 6, marginInlineEnd: 0 }}>{changes}</Tag> : null}</span>, children: <AgentChanges session={current} active={open && tab === 'changes'} version={changes + events.length} /> },
                { key: 'browser', label: 'Browser', children: <AgentBrowser active={open && tab === 'browser'} /> },
            ]} />
        </div>
    );
}
