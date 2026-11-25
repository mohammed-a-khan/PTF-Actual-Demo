/**
 * The team around a request: comments (kept in the collection file, so they go through review with the change and
 * reach everyone with Git) and the request's history (every commit that changed it, with what changed).
 */
import React from 'react';
import { App, Button, Checkbox, Empty, Input, List, Space, Spin, Tag, Typography } from 'antd';
import { api, ApiCommentDef, ApiRequestChange } from '../api';
import { errText } from '../state';
import { DiffView } from './DiffView';
import { ago } from '../format';

let me: string | null = null;

export function RequestComments({ comments, onChange }: { comments: ApiCommentDef[]; onChange: (c: ApiCommentDef[] | undefined) => void }) {
    const [text, setText] = React.useState('');
    const [reply, setReply] = React.useState<string | null>(null);
    const [name, setName] = React.useState(me);
    const [showResolved, setShowResolved] = React.useState(false);
    React.useEffect(() => { if (!me) void api.apiMe().then((r) => { me = r.name; setName(r.name); }).catch(() => undefined); }, []);
    const add = () => {
        if (!text.trim()) return;
        onChange([...comments, { id: `c${Date.now().toString(36)}`, author: name ?? 'me', at: new Date().toISOString(), text: text.trim(), ...(reply ? { replyTo: reply } : {}) }]);
        setText(''); setReply(null);
    };
    const roots = comments.filter((c) => !c.replyTo && (showResolved || !c.resolved));
    const open = comments.filter((c) => !c.replyTo && !c.resolved).length;
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Kept in the collection file: they are part of the change you commit, reviewed in its pull request and seen by everyone after it is merged. {open ? `${open} open.` : ''} {comments.some((c) => c.resolved) && <Checkbox checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)}>Show resolved</Checkbox>}</Typography.Text>
            {!roots.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No comments" /> : <List size="small" dataSource={roots} renderItem={(c) => (
                <List.Item style={{ display: 'block', opacity: c.resolved ? 0.6 : 1 }}>
                    <Space size={6}><b>{c.author}</b><Typography.Text type="secondary" style={{ fontSize: 12 }}>{ago(c.at)}</Typography.Text>{c.resolved && <Tag bordered={false} color="success">resolved</Tag>}</Space>
                    <div style={{ whiteSpace: 'pre-wrap', margin: '2px 0 4px' }}>{c.text}</div>
                    {comments.filter((x) => x.replyTo === c.id).map((x) => <div key={x.id} style={{ marginInlineStart: 18, borderInlineStart: '2px solid var(--panel-border)', paddingInlineStart: 8, marginBottom: 4 }}>
                        <Space size={6}><b>{x.author}</b><Typography.Text type="secondary" style={{ fontSize: 12 }}>{ago(x.at)}</Typography.Text></Space><div style={{ whiteSpace: 'pre-wrap' }}>{x.text}</div></div>)}
                    <Space size={4}>
                        <Button size="small" type="link" onClick={() => setReply(c.id)}>Reply</Button>
                        <Button size="small" type="link" onClick={() => onChange(comments.map((x) => (x.id === c.id ? { ...x, resolved: !x.resolved || undefined } : x)))}>{c.resolved ? 'Reopen' : 'Resolve'}</Button>
                        {c.author === name && <Button size="small" type="link" danger onClick={() => { const left = comments.filter((x) => x.id !== c.id && x.replyTo !== c.id); onChange(left.length ? left : undefined); }}>Delete</Button>}
                    </Space>
                </List.Item>)} />}
            {reply && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Replying to {comments.find((c) => c.id === reply)?.author} <Typography.Link onClick={() => setReply(null)}>cancel</Typography.Link></Typography.Text>}
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 8 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="A comment for the team (e.g. why this check, what is still open)…" aria-label="Comment"
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add(); }} />
            <Button size="small" type="primary" disabled={!text.trim()} onClick={add}>{reply ? 'Reply' : 'Comment'}</Button>
        </Space>
    );
}

export function RequestHistoryView({ file, id }: { file: string | null; id: string }) {
    const { message } = App.useApp();
    const [changes, setChanges] = React.useState<ApiRequestChange[] | null>(null);
    const [open, setOpen] = React.useState<string | null>(null);
    React.useEffect(() => { setChanges(null); if (file) api.apiRequestHistory(file, id).then((r) => { setChanges(r.changes); setOpen(r.changes[0]?.sha ?? null); }).catch((e) => message.error(errText(e))); }, [file, id, message]);
    if (!file) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Save the collection: its history comes from Git." />;
    if (!changes) return <Spin />;
    if (!changes.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Not committed yet: commit the collection to start its history." />;
    const cur = changes.find((c) => c.sha === open);
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <List size="small" dataSource={changes} renderItem={(c) => (
                <List.Item onClick={() => setOpen(c.sha)} style={{ cursor: 'pointer', background: c.sha === open ? 'var(--ant-color-primary-bg, rgba(22,119,255,.08))' : undefined }}>
                    <Space size={8} wrap>
                        <Tag bordered={false} color={c.kind === 'added' ? 'success' : c.kind === 'removed' ? 'error' : 'processing'}>{c.kind}</Tag>
                        <Typography.Text strong>{c.message}</Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.author} · {ago(c.date)} · <span className="mono">{c.sha.slice(0, 8)}</span></Typography.Text>
                        {c.kind === 'changed' && <Typography.Text style={{ fontSize: 12 }}><span style={{ color: '#1a7f37' }}>+{c.added}</span> <span style={{ color: '#cf222e' }}>−{c.removed}</span></Typography.Text>}
                    </Space>
                </List.Item>)} />
            {cur && <DiffView diff={cur.diff} />}
        </Space>
    );
}
