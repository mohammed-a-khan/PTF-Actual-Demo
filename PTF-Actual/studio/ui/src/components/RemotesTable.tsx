/** The repository's remotes: add, rename, change the address, remove (QA teams often have a fork and an upstream). */
import React from 'react';
import { App, Button, Form, Input, Modal, Space, Table, Typography } from 'antd';
import { CloudServerOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { api, GitRemote } from '../api';
import { errText } from '../state';

export function RemotesTable({ onChanged }: { onChanged?: () => void }) {
    const { message, modal } = App.useApp();
    const [list, setList] = React.useState<GitRemote[]>([]);
    const [edit, setEdit] = React.useState<null | { mode: 'add' | 'edit'; name: string; from?: string; url: string }>(null);
    const load = React.useCallback(() => { api.remotes().then(setList).catch((e) => message.error(errText(e))); }, [message]);
    React.useEffect(load, [load]);
    const save = async () => {
        if (!edit) return;
        try {
            let r: GitRemote[];
            if (edit.mode === 'add') r = await api.remoteChange({ action: 'add', name: edit.name.trim(), url: edit.url.trim() });
            else {
                r = list;
                if (edit.from && edit.from !== edit.name.trim()) r = await api.remoteChange({ action: 'rename', name: edit.from, to: edit.name.trim() });
                if (edit.url.trim() !== list.find((x) => x.name === edit.from)?.fetchUrl) r = await api.remoteChange({ action: 'set-url', name: edit.name.trim(), url: edit.url.trim() });
            }
            setList(r); setEdit(null); onChanged?.(); message.success('Saved');
        } catch (e) { message.error(errText(e)); }
    };
    return (
        <>
            <Table<GitRemote> size="small" rowKey="name" dataSource={list} pagination={false}
                locale={{ emptyText: 'No remote: this repository is only on this computer.' }}
                title={() => <Space><CloudServerOutlined /><Typography.Text strong>Remotes</Typography.Text><Button size="small" icon={<PlusOutlined />} onClick={() => setEdit({ mode: 'add', name: list.length ? 'upstream' : 'origin', url: '' })}>Add remote</Button></Space>}
                columns={[
                    { title: 'Name', dataIndex: 'name', width: 160, render: (n: string) => <Typography.Text strong>{n}</Typography.Text> },
                    { title: 'Address', render: (_, r) => <Typography.Text className="mono" copyable={{ text: r.fetchUrl }}>{r.fetchUrl}{r.pushUrl && r.pushUrl !== r.fetchUrl ? ` (push: ${r.pushUrl})` : ''}</Typography.Text> },
                    { title: '', width: 90, render: (_, r) => (
                        <Space>
                            <Button size="small" type="text" aria-label={`Edit ${r.name}`} icon={<EditOutlined />} onClick={() => setEdit({ mode: 'edit', name: r.name, from: r.name, url: r.fetchUrl })} />
                            <Button size="small" type="text" danger aria-label={`Remove ${r.name}`} icon={<DeleteOutlined />} onClick={() => modal.confirm({
                                title: `Remove the remote ${r.name}?`, content: 'Only the link on this computer is removed (and its remote branches here); nothing changes on the server.', okButtonProps: { danger: true }, okText: 'Remove',
                                onOk: async () => { try { setList(await api.remoteChange({ action: 'remove', name: r.name })); onChanged?.(); } catch (e) { message.error(errText(e)); } },
                            })} />
                        </Space>
                    ) },
                ]} />
            <Modal open={!!edit} title={edit?.mode === 'add' ? 'Add a remote' : `Remote ${edit?.from}`} onCancel={() => setEdit(null)} onOk={save} okText="Save"
                okButtonProps={{ disabled: !edit?.name.trim() || !edit?.url.trim() }}>
                <Form layout="vertical">
                    <Form.Item label="Name"><Input value={edit?.name} onChange={(e) => setEdit({ ...edit!, name: e.target.value })} placeholder="origin, upstream…" /></Form.Item>
                    <Form.Item label="Address" extra="https://dev.azure.com/org/project/_git/repo, git@ssh.dev.azure.com:v3/org/project/repo, or a folder"><Input value={edit?.url} onChange={(e) => setEdit({ ...edit!, url: e.target.value })} /></Form.Item>
                </Form>
            </Modal>
        </>
    );
}
