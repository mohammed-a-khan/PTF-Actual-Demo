/**
 * The inbox: what agents wait for you on (questions, plans, approvals), work ready to review and agents that got
 * worse, answered here or opened where they come from.
 */
import React from 'react';
import { App, Button, Card, Empty, Input, List, Radio, Space, Tabs, Tag, Typography } from 'antd';
import { AimOutlined, CheckOutlined, CloseOutlined, ExperimentOutlined, MessageOutlined } from '@ant-design/icons';
import { api, InboxItemDef } from '../api';
import { errText } from '../state';
import { navigate, useRoute } from '../route';
import { Markdown } from '../components/Markdown';
import { useRememberedTab } from '../agents-tabs';

const KIND: Record<InboxItemDef['kind'], { label: string; color: string }> = {
    question: { label: 'Question', color: 'blue' }, plan: { label: 'Plan to approve', color: 'purple' }, approval: { label: 'Approval', color: 'orange' },
    review: { label: 'Ready to review', color: 'green' }, regression: { label: 'Got worse', color: 'red' },
};
const ago = (at: string) => { const m = Math.round((Date.now() - Date.parse(at)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

function Item({ it, onDone, openConversation }: { it: InboxItemDef; onDone: (items: InboxItemDef[]) => void; openConversation: (id: string) => void }) {
    const { message } = App.useApp();
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const acting = React.useRef(false);
    const act = async (action: InboxItemDef['actions'][number], t?: string) => {
        if (acting.current) return;
        acting.current = true;
        setBusy(true);
        try { const r = await api.inboxAct(it.id, action, t); onDone(r.items); message.success(action === 'reject' ? 'Rejected' : action === 'answer' ? 'Answered' : 'Approved'); }
        catch (e) { message.error(errText(e)); } finally { acting.current = false; setBusy(false); }
    };
    const open = () => (it.source.type === 'mission' ? navigate(['missions', it.source.id]) : it.source.type === 'conversation' ? openConversation(it.source.id) : navigate(['agent-builder']));
    return (
        // A long title (a shell command) ends with "…" on narrow screens; the whole of it shows on hover.
        <Card size="small" title={<div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}><Tag color={KIND[it.kind].color} style={{ flex: 'none' }}>{KIND[it.kind].label}</Tag><Typography.Text strong ellipsis={{ tooltip: it.title }} style={{ minWidth: 0, flex: 1 }}>{it.title}</Typography.Text></div>}
            extra={<Button size="small" type="link" icon={it.source.type === 'mission' ? <AimOutlined /> : it.source.type === 'conversation' ? <MessageOutlined /> : <ExperimentOutlined />} onClick={open}>Open</Button>}>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{it.source.type === 'mission' ? 'Mission' : it.source.type === 'conversation' ? 'Conversation' : 'Evaluation'}: {it.source.title}{it.who ? ` · ${it.who}` : ''} · {ago(it.at)}</Typography.Text>
                {it.detail && (it.kind === 'approval' ? <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>{it.detail}</pre> : <div style={{ maxHeight: 300, overflow: 'auto' }}><Markdown text={it.kind === 'plan' ? `\`\`\`gherkin\n${it.detail}\n\`\`\`` : it.detail} /></div>)}
                {it.actions.includes('answer') && (
                    <Space direction="vertical" style={{ width: '100%' }}>
                        {it.options?.length ? <Radio.Group value={text} onChange={(e) => setText(e.target.value)} options={it.options} /> : null}
                        <Input.TextArea autoSize={{ minRows: 1 }} value={text} placeholder={it.kind === 'plan' ? 'Approved, or what to change' : 'Your answer'} onChange={(e) => setText(e.target.value)} />
                        <Space>
                            {it.kind === 'plan' && <Button type="primary" loading={busy} onClick={() => void act('answer', 'Approved')}>Approve the plan</Button>}
                            <Button type={it.kind === 'plan' ? 'default' : 'primary'} disabled={!text.trim()} loading={busy} onClick={() => void act('answer', text.trim())}>{it.kind === 'plan' ? 'Send changes' : 'Answer'}</Button>
                        </Space>
                    </Space>
                )}
                {it.actions.includes('approve') && (
                    <Space>
                        <Button type="primary" icon={<CheckOutlined />} loading={busy} onClick={() => void act('approve')}>Approve</Button>
                        <Button loading={busy} onClick={() => void act('approve-session')}>Approve for this {it.source.type === 'mission' ? 'mission' : 'conversation'}</Button>
                        <Button danger icon={<CloseOutlined />} loading={busy} onClick={() => void act('reject')}>Reject</Button>
                    </Space>
                )}
            </Space>
        </Card>
    );
}

/** Ask the Copilot panel to close (AgentPanel listens). */
export const closeCopilot = () => window.dispatchEvent(new Event('cs-studio:close-copilot'));

export function Inbox({ openConversation, onCount }: { openConversation: (id: string) => void; onCount?: (n: number) => void }) {
    const [items, setItems] = React.useState<InboxItemDef[] | null>(null);
    const [filter, setFilter] = useRememberedTab('inbox', 'all', ['all', 'answer', 'review'], 'inbox');
    // "Open" on a conversation is a step of its own (#/inbox/<tab>/conversation/<id>): Back closes the panel and
    // stays in the Inbox, instead of leaving the Inbox with the panel still open.
    const route = useRoute();
    const conv = route[0] === 'inbox' && route[2] === 'conversation' && route[3] ? route[3] : null;
    // The conversation opened by the address, and its place in the browser's history.
    const shownByAddress = React.useRef<{ id: string; idx: number | null } | null>(null);
    const placeNow = () => { const i = (history.state as { idx?: unknown } | null)?.idx; return typeof i === 'number' ? i : null; };
    React.useEffect(() => {
        if (conv) { if (shownByAddress.current?.id !== conv) { shownByAddress.current = { id: conv, idx: placeNow() }; openConversation(conv); } return; }
        const was = shownByAddress.current;
        shownByAddress.current = null;
        // Back from that step (an earlier place in the history) closes the panel; switching the Inbox's tab does not.
        const now = placeNow();
        if (was && was.idx !== null && now !== null && now < was.idx) closeCopilot();
    }, [conv]); // eslint-disable-line react-hooks/exhaustive-deps
    const openConv = React.useCallback((id: string) => { if (conv === id) openConversation(id); else navigate(['inbox', filter, 'conversation', id]); }, [conv, filter, openConversation]);
    const set = React.useCallback((x: InboxItemDef[]) => { setItems(x); onCount?.(x.length); }, [onCount]);
    React.useEffect(() => {
        let live = true;
        const load = () => { void api.inbox().then((r) => { if (live) set(r.items); }).catch(() => undefined); };
        load();
        const t = setInterval(load, 4000);
        return () => { live = false; clearInterval(t); };
    }, [set]);
    if (!items) return null;
    const shown = items.filter((i) => filter === 'all' || (filter === 'answer' ? ['question', 'plan', 'approval'].includes(i.kind) : ['review', 'regression'].includes(i.kind)));
    return (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Tabs size="small" activeKey={filter} onChange={setFilter} style={{ marginBottom: -12 }} items={[
                { key: 'all', label: `All (${items.length})` },
                { key: 'answer', label: `To answer (${items.filter((i) => ['question', 'plan', 'approval'].includes(i.kind)).length})` },
                { key: 'review', label: `To review (${items.filter((i) => ['review', 'regression'].includes(i.kind)).length})` },
            ]} />
            {shown.length === 0 ? <Card><Empty description={filter === 'all' ? 'Nothing waits for you.' : filter === 'answer' ? 'No question, plan or approval waits for you.' : 'Nothing to review.'} /></Card>
                : <List dataSource={shown} split={false} renderItem={(it) => <List.Item style={{ padding: '0 0 10px' }}><div style={{ width: '100%' }}><Item it={it} onDone={set} openConversation={openConv} /></div></List.Item>} />}
        </Space>
    );
}
