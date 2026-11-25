import React from 'react';
import { App, Checkbox, Modal, Select, Space, Typography } from 'antd';
import { api } from '../api';
import { errText, useStudio } from '../state';

/** Merge a branch into the current one, with TortoiseGit's options explained. */
export function MergeDialog({ open, initial, onClose }: { open: boolean; initial?: string; onClose: () => void }) {
    const { message, modal } = App.useApp();
    const { status, branches, refresh } = useStudio();
    const [from, setFrom] = React.useState<string | undefined>(initial);
    const [o, setO] = React.useState({ noFastForward: false, squash: false, noCommit: false });
    React.useEffect(() => { if (open) { setFrom(initial); setO({ noFastForward: false, squash: false, noCommit: false }); } }, [open, initial]);
    return (
        <Modal open={open} title={`Merge into ${status?.branch}`} okText="Merge" onCancel={onClose} okButtonProps={{ disabled: !from }}
            onOk={async () => {
                try {
                    const r = await api.merge(from!, o);
                    onClose(); await refresh();
                    if (r.status === 'ok') message.success(o.squash ? `Changes from ${from} are staged — review and commit them` : o.noCommit ? `Merged ${from} — review, then commit to finish` : `Merged ${from}`);
                    else if (r.status === 'conflicts') modal.warning({ title: 'Merge needs your decision', content: `${r.conflicts?.length} file(s) were changed on both branches. Open Changes → Merge conflicts.` });
                    else modal.error({ title: 'Merge did not start', content: r.message });
                } catch (e) { message.error(errText(e)); }
            }}>
            <Typography.Paragraph>Bring the commits from another branch into <b>{status?.branch}</b>.</Typography.Paragraph>
            <Select style={{ width: '100%', marginBottom: 12 }} placeholder="Choose a branch" value={from} onChange={setFrom} showSearch
                options={branches.filter((b) => !b.current).map((b) => ({ value: b.name, label: b.name }))} />
            <Space direction="vertical">
                <Checkbox checked={o.noFastForward} disabled={o.squash} onChange={(e) => setO({ ...o, noFastForward: e.target.checked })}>
                    Always create a merge commit <Typography.Text type="secondary">(--no-ff: keeps a visible record that the branch was merged)</Typography.Text></Checkbox>
                <Checkbox checked={o.squash} onChange={(e) => setO({ ...o, squash: e.target.checked, noFastForward: false, noCommit: false })}>
                    Squash into one change <Typography.Text type="secondary">(--squash: all its changes staged as one new commit you write)</Typography.Text></Checkbox>
                <Checkbox checked={o.noCommit} disabled={o.squash} onChange={(e) => setO({ ...o, noCommit: e.target.checked })}>
                    Don&apos;t commit yet <Typography.Text type="secondary">(--no-commit: review the merged result before committing)</Typography.Text></Checkbox>
            </Space>
        </Modal>
    );
}
