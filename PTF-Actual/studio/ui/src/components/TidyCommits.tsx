/**
 * Clean up commits before a pull request (interactive rebase, without an editor): each commit after the chosen one
 * is kept, reworded, squashed into the one above, folded in silently (fixup) or dropped, in the order shown.
 */
import React from 'react';
import { Alert, App, Button, Input, Modal, Select, Space, Spin, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { api } from '../api';
import { errText } from '../state';

type Action = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';
interface Row { sha: string; subject: string; body: string; action: Action; message: string; merge: boolean }

const ACTIONS: Array<{ value: Action; label: string }> = [
    { value: 'pick', label: 'Keep' },
    { value: 'reword', label: 'Keep, new message' },
    { value: 'squash', label: 'Squash into the one above (new message)' },
    { value: 'fixup', label: 'Fold into the one above (keep its message)' },
    { value: 'drop', label: 'Drop' },
];

export function TidyCommits({ base, branch, onClose, onDone }: { base: string; branch: string; onClose: () => void; onDone: (r: { status: string; message?: string; conflicts?: string[] }) => void }) {
    const { message } = App.useApp();
    const [rows, setRows] = React.useState<Row[] | null>(null);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        api.commitsSince(base).then((list) => setRows(list.map((c) => ({ ...c, action: 'pick', message: c.body ? `${c.subject}\n\n${c.body}` : c.subject })))).catch((e) => { message.error(errText(e)); onClose(); });
    }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
    const set = (i: number, p: Partial<Row>) => setRows((r) => r!.map((x, j) => (j === i ? { ...x, ...p } : x)));
    const move = (i: number, d: number) => setRows((r) => { const a = [...r!]; [a[i], a[i + d]] = [a[i + d], a[i]]; return a; });
    const firstFolds = !!rows?.length && (rows[0].action === 'squash' || rows[0].action === 'fixup');
    const merges = rows?.some((r) => r.merge);
    const apply = async () => {
        setBusy(true);
        try {
            const r = await api.rebase(base, rows!.map((x) => ({ sha: x.sha, action: x.action, ...(x.action === 'reword' || x.action === 'squash' ? { message: x.message } : {}) })));
            onDone(r);
        } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    return (
        <Modal open width={860} title={`Clean up the commits of ${branch}`} onCancel={onClose} okText="Rewrite these commits" onOk={apply} confirmLoading={busy}
            okButtonProps={{ disabled: !rows?.length || firstFolds || merges }}>
            <Typography.Paragraph type="secondary">The commits after <Typography.Text code>{base.slice(0, 7)}</Typography.Text>, oldest first. They get new ids: if {branch} is already pushed, push with force-with-lease afterwards.</Typography.Paragraph>
            {merges && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="These commits include a merge: pick a commit after the merge." />}
            {firstFolds && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="The first commit has nothing above it to be squashed into." />}
            {!rows ? <Spin /> : !rows.length ? <Typography.Text type="secondary">No commits after this one.</Typography.Text> : (
                <Space direction="vertical" style={{ width: '100%' }}>
                    {rows.map((r, i) => (
                        <div key={r.sha} className="tidy-row" style={{ opacity: r.action === 'drop' ? 0.5 : 1 }}>
                            <Space align="start" style={{ width: '100%' }}>
                                <Space direction="vertical" size={0}>
                                    <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" />
                                    <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down" />
                                </Space>
                                <Select size="small" style={{ width: 280 }} value={r.action} options={ACTIONS} onChange={(action) => set(i, { action })} aria-label={`Action for ${r.subject}`} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <Typography.Text code>{r.sha.slice(0, 7)}</Typography.Text> <Typography.Text delete={r.action === 'drop'}>{r.subject}</Typography.Text>
                                    {(r.action === 'reword' || r.action === 'squash') && <Input.TextArea style={{ marginTop: 6 }} autoSize={{ minRows: 1, maxRows: 6 }} value={r.message} onChange={(e) => set(i, { message: e.target.value })} aria-label={`New message for ${r.subject}`} />}
                                </div>
                            </Space>
                        </div>
                    ))}
                </Space>
            )}
        </Modal>
    );
}
