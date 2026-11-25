/**
 * What a conversation changed, for review before committing: each file with its state and diff; open it
 * in the editor, or discard it (a copy is kept in the Studio's recovery folder).
 */
import React from 'react';
import { App, Button, Empty, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { EditOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import { AgentChange, api } from '../api';
import { errText, openInEditor } from '../state';
import { DiffView } from './DiffView';

const STATE: Record<AgentChange['state'], { color: string; label: string }> = {
    new: { color: 'green', label: 'new' }, modified: { color: 'gold', label: 'changed' }, deleted: { color: 'red', label: 'deleted' },
    unchanged: { color: 'default', label: 'committed or reverted' }, gone: { color: 'default', label: 'not there' },
};

export function AgentChanges({ session, active, version }: { session: string | null; active: boolean; version: number }) {
    const { message, modal } = App.useApp();
    const [files, setFiles] = React.useState<AgentChange[] | null>(null);
    const [sel, setSel] = React.useState<string | null>(null);
    const [diff, setDiff] = React.useState<{ text: string; loading: boolean }>({ text: '', loading: false });
    const load = React.useCallback(() => { if (session) api.agentChanges(session).then((r) => setFiles(r.files)).catch((e) => message.error(errText(e))); }, [session, message]);
    React.useEffect(() => { if (active) load(); }, [active, load, version]);
    React.useEffect(() => { setSel(null); setFiles(null); }, [session]);
    React.useEffect(() => {
        if (!sel || !files) return;
        const f = files.find((x) => x.path === sel);
        if (!f) return;
        setDiff({ text: '', loading: true });
        // A new file has no diff: show its content as added lines.
        const p = f.state === 'new' ? api.readFile(sel).then((r) => { const lines = (r.content ?? '').split('\n'); return `--- /dev/null\n+++ b/${sel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`; })
            : f.state === 'modified' || f.state === 'deleted' ? api.diff(sel, f.staged).then((r) => r.diff) : Promise.resolve('');
        p.then((t) => setDiff({ text: t, loading: false })).catch((e) => setDiff({ text: errText(e), loading: false }));
    }, [sel, files]);
    const discard = (paths: string[]) => modal.confirm({
        title: paths.length === 1 ? `Discard the agent's change to ${paths[0]}?` : `Discard all ${paths.length} changes of this conversation?`,
        content: 'New files are removed and changed files go back to their last committed state. A copy is kept in the Studio\'s recovery folder.', okText: 'Discard', okButtonProps: { danger: true },
        onOk: async () => { try { const r = await api.discard(paths); message.success(`Discarded (copy in ${r.recoveryDir}).`); setSel(null); load(); } catch (e) { message.error(errText(e)); } },
    });
    if (!session) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No conversation" />;
    if (!files) return <Spin />;
    const open = files.filter((f) => f.state === 'new' || f.state === 'modified' || f.state === 'deleted');
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Typography.Text type="secondary" style={{ flex: 1, fontSize: 12 }}>{open.length ? `${open.length} file${open.length === 1 ? '' : 's'} changed by this conversation, not yet committed: review before committing (Source control).` : 'No uncommitted changes from this conversation.'}</Typography.Text>
                <Tooltip title="Refresh"><Button size="small" icon={<ReloadOutlined />} aria-label="Refresh changes" onClick={load} /></Tooltip>
                <Button size="small" danger icon={<RollbackOutlined />} disabled={!open.length} onClick={() => discard(open.map((f) => f.path))}>Discard all</Button>
            </div>
            <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--panel-border)', borderRadius: 6 }}>
                {!files.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing changed yet" /> : files.map((f) => (
                    <div key={f.path} className={`item-row${sel === f.path ? ' active' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} onClick={() => setSel(f.path)}>
                        <Tag color={STATE[f.state].color} bordered={false} style={{ marginInlineEnd: 0 }}>{STATE[f.state].label}</Tag>
                        <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }} title={f.path}>{f.path}</span>
                        <Space size={0}>
                            {f.state !== 'deleted' && f.state !== 'gone' && <Tooltip title="Open in the editor"><Button size="small" type="text" icon={<EditOutlined />} aria-label={`Open ${f.path}`} onClick={(e) => { e.stopPropagation(); openInEditor(f.path); }} /></Tooltip>}
                            {(f.state === 'new' || f.state === 'modified' || f.state === 'deleted') && <Tooltip title="Discard this change"><Button size="small" type="text" danger icon={<RollbackOutlined />} aria-label={`Discard ${f.path}`} onClick={(e) => { e.stopPropagation(); discard([f.path]); }} /></Tooltip>}
                        </Space>
                    </div>))}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                {sel ? <DiffView diff={diff.text} loading={diff.loading} /> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>Choose a file to see what the agent changed.</Typography.Text>}
            </div>
        </div>
    );
}
