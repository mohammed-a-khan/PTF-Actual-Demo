/** Stash: put unfinished work aside, switch tasks, and bring it back later. */
import React from 'react';
import { App, Button, Checkbox, Empty, Input, List, Modal, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import '../styles-datagit.css';
import { InboxOutlined } from '@ant-design/icons';
import { api, NameStatus, StashEntry } from '../api';
import { errText, useStudio } from '../state';
import { DiffView } from '../components/DiffView';

export function Stashes() {
    const { message, modal } = App.useApp();
    const { status, refresh } = useStudio();
    const [list, setList] = React.useState<StashEntry[]>([]);
    const [sel, setSel] = React.useState<number | null>(null);
    const [files, setFiles] = React.useState<NameStatus[]>([]);
    const [file, setFile] = React.useState<string | null>(null);
    const [diff, setDiff] = React.useState('');
    const [saving, setSaving] = React.useState<{ message: string; untracked: boolean } | null>(null);

    const load = React.useCallback(() => { api.stashes().then(setList).catch((e) => message.error(errText(e))); }, [message]);
    React.useEffect(load, [load, status?.head]);
    React.useEffect(() => {
        setFiles([]); setFile(null); setDiff('');
        if (sel !== null) api.stashFiles(sel).then(setFiles).catch((e) => message.error(errText(e)));
    }, [sel, list, message]);
    React.useEffect(() => { if (sel !== null && file) api.stashDiff(sel, file).then((r) => setDiff(r.diff)).catch((e) => message.error(errText(e))); }, [sel, file, message]);

    // One stash action at a time (a double click must not run it twice: the second would report a wrong failure).
    const acting = React.useRef(false);
    const [busy, setBusy] = React.useState(false);
    const once = async (f: () => Promise<void>) => { if (acting.current) return; acting.current = true; setBusy(true); try { await f(); } finally { acting.current = false; setBusy(false); } };
    const apply = (e: StashEntry, pop: boolean) => once(async () => {
        try {
            const r = await api.stashApply(e.index, pop, e.sha);
            await refresh(); load(); setSel(null);
            if (r.status === 'ok') message.success(pop ? 'Changes brought back and the stash entry removed' : 'Changes brought back (stash entry kept)');
            else if (r.status === 'conflicts') modal.warning({ title: 'Some changes clash with your current files', content: 'Resolve them under Changes → Merge conflicts. In this case "Incoming" means the stashed version. The stash entry is kept until you remove it.' });
            else modal.error({ title: 'Could not bring the changes back', content: r.message });
        } catch (err) { modal.error({ title: 'Could not bring the changes back', content: errText(err) }); }
    });

    const stashNow = () => once(async () => {
        if (!saving) return;
        try { await api.stashSave(saving.message, saving.untracked); message.success('Changes stashed. Your files are back to the last commit.'); setSaving(null); await refresh(); load(); }
        catch (e) { message.error(errText(e)); }
    });
    const changes = status?.files.length ?? 0;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
            <div className="dg-toolbar" style={{ marginBottom: 0 }}>
                <Tooltip title={changes === 0 ? 'No changes to put aside' : undefined}><Button type="primary" icon={<InboxOutlined />} disabled={changes === 0} onClick={() => setSaving({ message: '', untracked: true })}>Stash my {changes} change{changes === 1 ? '' : 's'}</Button></Tooltip>
                <span className="dg-hint">Puts unfinished changes aside so you can switch branch or pull; bring them back later with Pop or Apply.</span>
            </div>
            <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
                <div className="panel" style={{ flex: '0 1 420px', minWidth: 300, overflow: 'auto' }}>
                    <List dataSource={list} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing stashed." /> }} renderItem={(e) => (
                        <List.Item style={{ padding: '8px 12px', cursor: 'pointer', background: sel === e.index ? 'rgba(147,24,108,.10)' : undefined }} onClick={() => setSel(e.index)}
                            actions={[
                                <Button key="p" size="small" type="primary" disabled={busy} onClick={(ev) => { ev.stopPropagation(); void apply(e, true); }}>Pop</Button>,
                                <Button key="a" size="small" disabled={busy} onClick={(ev) => { ev.stopPropagation(); void apply(e, false); }}>Apply</Button>,
                                <Popconfirm key="d" title="Delete this stash entry? Its changes are lost." onConfirm={async (ev) => { ev?.stopPropagation(); try { await api.stashDrop(e.index, e.sha); load(); setSel(null); } catch (err) { message.error(errText(err)); } }}>
                                    <Button size="small" danger type="text" onClick={(ev) => ev.stopPropagation()}>Delete</Button></Popconfirm>,
                            ]}>
                            <List.Item.Meta title={e.message || '(no description)'} description={<>{new Date(e.date).toLocaleString()} · <Typography.Text code>{e.ref}</Typography.Text></>} />
                        </List.Item>
                    )} />
                </div>
                <div className="panel" style={{ flex: 1, minWidth: 0, display: 'flex' }}>
                    {sel === null ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: 'auto' }} description="Select a stash entry to see what is in it" /> : (
                        <>
                            <div style={{ flex: '0 1 260px', minWidth: 160, borderRight: '1px solid var(--panel-border)', overflow: 'auto', padding: 4 }}>
                                {files.map((f) => <div key={f.path} className={`file-row${file === f.path ? ' selected' : ''}`} onClick={() => setFile(f.path)}><Tag style={{ marginInlineEnd: 0 }}>{f.status}</Tag><span className="name mono">{f.path}</span></div>)}
                            </div>
                            <div style={{ flex: 1, overflow: 'auto' }}>{file ? <DiffView diff={diff} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description="Click a file" />}</div>
                        </>
                    )}
                </div>
            </div>
            <Modal open={!!saving} title="Stash my changes" okText="Stash" onCancel={() => setSaving(null)} confirmLoading={busy}
                onOk={() => void stashNow()} destroyOnClose>
                {saving && <Space direction="vertical" style={{ width: '100%' }}>
                    <Input aria-label="Stash description" maxLength={200} placeholder="What were you working on? (e.g. half-done login test)" value={saving.message} onChange={(e) => setSaving({ ...saving, message: e.target.value })} onPressEnter={() => void stashNow()} autoFocus />
                    <Checkbox checked={saving.untracked} onChange={(e) => setSaving({ ...saving, untracked: e.target.checked })}>Include new files that are not committed yet</Checkbox>
                </Space>}
            </Modal>
        </div>
    );
}
