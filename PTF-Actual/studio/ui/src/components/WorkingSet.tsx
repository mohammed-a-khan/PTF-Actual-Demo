/**
 * The files a conversation changed and nobody kept or undid yet, above the chat box (as VS Code's working
 * set): each opens in the editor at its first change; Keep all / Undo all for the conversation.
 */
import React from 'react';
import { App, Button, Tooltip, Typography } from 'antd';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { api } from '../api';
import { refreshAgentReview, useAgentReview } from '../agentReview';
import { errText, openInEditor } from '../state';
import { hunksOf } from '../../../src/agents/hunks';

export function WorkingSet({ session }: { session: string }) {
    const { message, modal } = App.useApp();
    const all = useAgentReview();
    const files = all.filter((f) => f.session === session);
    const [open, setOpen] = React.useState(false);
    if (!files.length) return null;
    const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0);
    const show = (path: string, before: string | null, after: string | null) => openInEditor(path, (hunksOf(before, after)[0]?.afterStart ?? 0) + 1);
    const keepAll = async () => { try { await api.agentKeep(session); await refreshAgentReview(); message.success(`Kept ${files.length} file${files.length === 1 ? '' : 's'}`); } catch (e) { message.error(errText(e)); } };
    const undoAll = () => modal.confirm({
        title: `Undo every change this conversation made to ${files.length} file${files.length === 1 ? '' : 's'}?`,
        content: 'Each file goes back to how it was before the agent first changed it; files it created are removed. A copy is kept in the Studio\'s recovery folder.',
        okText: 'Undo all', okButtonProps: { danger: true },
        onOk: async () => { try { const r = await api.agentUndo(session); await refreshAgentReview(); message.success(`Undid the changes to ${r.files} file${r.files === 1 ? '' : 's'}`); } catch (e) { message.error(errText(e)); } },
    });
    return (
        <div className="working-set" role="region" aria-label="Files this conversation changed">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Button size="small" type="text" icon={open ? <DownOutlined /> : <RightOutlined />} aria-expanded={open} onClick={() => setOpen(!open)} style={{ paddingInline: 4 }}>
                    {files.length} file{files.length === 1 ? '' : 's'} changed
                </Button>
                <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}><span style={{ color: '#1a7f37' }}>+{added}</span> <span style={{ color: '#cf222e' }}>−{removed}</span></Typography.Text>
                <Tooltip title="Open the first changed file in the editor, at its first change"><Button size="small" onClick={() => show(files[0].path, files[0].before, files[0].after)}>Review</Button></Tooltip>
                <Button size="small" type="primary" onClick={() => void keepAll()}>Keep all</Button>
                <Button size="small" danger onClick={undoAll}>Undo all</Button>
            </div>
            {open && files.map((f) => (
                <div key={f.path} className="item-row" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }} onClick={() => show(f.path, f.before, f.after)} title={`Open ${f.path} at its first change`}>
                    <span className="mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path.split('/').pop()} <Typography.Text type="secondary" style={{ fontSize: 11 }}>{f.path.split('/').slice(0, -1).join('/')}</Typography.Text></span>
                    {f.state === 'new' && <Typography.Text type="secondary" style={{ fontSize: 11 }}>new</Typography.Text>}
                    <span style={{ color: '#1a7f37' }}>+{f.added}</span><span style={{ color: '#cf222e' }}>−{f.removed}</span>
                </div>
            ))}
        </div>
    );
}
