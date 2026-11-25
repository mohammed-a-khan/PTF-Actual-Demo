/**
 * The repository name in the header: switch to a recently opened repository, open another folder, or clone one
 * from Azure DevOps. Another repository opens as its own Studio in a new tab; this one stays as it is.
 */
import React from 'react';
import { App, Button, Dropdown, Form, Input, List, Modal, Space, Tooltip, Typography } from 'antd';
import { CloudDownloadOutlined, DownOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { api } from '../api';
import { errText } from '../state';

const sizeText = (n?: number) => (n === undefined ? '' : n > 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n > 1 << 20 ? `${Math.round(n / (1 << 20))} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function RepoSwitcher({ repoRoot }: { repoRoot: string }) {
    const { message, modal } = App.useApp();
    const [recent, setRecent] = React.useState<Array<{ path: string; name: string }>>([]);
    const [parent, setParent] = React.useState('');
    const [openFolder, setOpenFolder] = React.useState(false);
    const [clone, setClone] = React.useState(false);
    const name = repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? '';
    const load = () => { void api.workspaces().then((w) => { setRecent(w.recent.filter((r) => r.path !== w.current)); setParent(w.parent); }).catch(() => undefined); };
    React.useEffect(load, []);

    const open = async (path: string, trustRepoConfig = false): Promise<void> => {
        const hide = message.loading('Starting a Studio for that repository…', 0);
        try {
            const r = await api.workspaceOpen({ path, trustRepoConfig });
            if (r.needsTrust) {
                hide();
                modal.confirm({
                    title: 'This repository\'s Git settings run programs',
                    content: <><Typography.Paragraph>Git will run these when the Studio works with it. Open it only if you trust where it came from.</Typography.Paragraph><ul>{r.needsTrust.map((x) => <li key={x}><Typography.Text code>{x}</Typography.Text></li>)}</ul></>,
                    okText: 'Trust and open', onOk: () => open(r.path ?? path, true),
                });
                return;
            }
            if (r.same) { message.info('That is the repository open here.'); return; }
            if (r.url) { window.open(r.url, '_blank', 'noopener'); message.success('Opened in a new tab.'); }
            load();
        } catch (e) { message.error(errText(e)); } finally { hide(); }
    };

    return (
        <>
            <Dropdown trigger={['click']} menu={{
                items: [
                    { key: 'here', disabled: true, label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>{repoRoot}</Typography.Text> },
                    { type: 'divider' as const },
                    ...(recent.length ? [{ type: 'group' as const, label: 'Recently opened', children: recent.slice(0, 8).map((r) => ({ key: 'r:' + r.path, label: <Tooltip title={r.path} placement="right"><span>{r.name}</span></Tooltip> })) }, { type: 'divider' as const }] : []),
                    { key: 'open', icon: <FolderOpenOutlined />, label: 'Open another repository…' },
                    { key: 'clone', icon: <CloudDownloadOutlined />, label: 'Clone a repository…' },
                ],
                onClick: ({ key }) => { if (key === 'open') setOpenFolder(true); else if (key === 'clone') setClone(true); else void open(key.slice(2)); },
            }}>
                <Button type="text" style={{ fontWeight: 600, paddingInline: 6 }} aria-label={`Repository ${name}: switch or clone`}>{name} <DownOutlined style={{ fontSize: 10 }} /></Button>
            </Dropdown>
            {openFolder && <OpenFolder parent={parent} onClose={() => setOpenFolder(false)} onOpen={(p) => { setOpenFolder(false); void open(p); }} />}
            {clone && <CloneRepo parent={parent} onClose={() => setClone(false)} onCloned={(p) => { setClone(false); load(); modal.confirm({ title: 'Cloned', content: <Typography.Text code>{p}</Typography.Text>, okText: 'Open it', cancelText: 'Later', onOk: () => open(p) }); }} />}
        </>
    );
}

function OpenFolder({ parent, onClose, onOpen }: { parent: string; onClose: () => void; onOpen: (p: string) => void }) {
    const [path, setPath] = React.useState(parent ? parent.replace(/[\\/]?$/, '/') : '');
    return (
        <Modal open title="Open another repository" okText="Open" okButtonProps={{ disabled: !path.trim() }} onOk={() => onOpen(path.trim())} onCancel={onClose}>
            <Form layout="vertical">
                <Form.Item label="Folder of the repository on this computer" htmlFor="cs-ws-path" extra="It opens as its own Studio in a new tab; this one stays as it is.">
                    <Input id="cs-ws-path" value={path} onChange={(e) => setPath(e.target.value)} onPressEnter={() => path.trim() && onOpen(path.trim())} autoFocus />
                </Form.Item>
            </Form>
        </Modal>
    );
}

function CloneRepo({ parent, onClose, onCloned }: { parent: string; onClose: () => void; onCloned: (p: string) => void }) {
    const { message } = App.useApp();
    const [repos, setRepos] = React.useState<Array<{ name: string; url: string; defaultBranch?: string; size?: number }> | null>(null);
    const [reposError, setReposError] = React.useState('');
    const [filter, setFilter] = React.useState('');
    const [url, setUrl] = React.useState('');
    const [folder, setFolder] = React.useState(parent);
    const [name, setName] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => { void api.workspaceAdoRepos().then((r) => setRepos(r.repos)).catch((e) => { setRepos([]); setReposError(errText(e)); }); }, []);
    const shown = (repos ?? []).filter((r) => r.name.toLowerCase().includes(filter.toLowerCase()));
    const go = async () => {
        setBusy(true);
        try { const r = await api.workspaceClone({ url: url.trim(), parent: folder.trim(), ...(name.trim() ? { name: name.trim() } : {}) }); message.success(`Cloned into ${r.path}`); onCloned(r.path); }
        catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    return (
        <Modal open width={640} title="Clone a repository" okText="Clone" confirmLoading={busy} okButtonProps={{ disabled: !url.trim() || !folder.trim() }} onOk={go} onCancel={onClose}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>Uses your Azure DevOps sign-in for this one clone; nothing of it is saved in the copy.</Typography.Paragraph>
            <Input.Search placeholder="Filter this project's repositories" value={filter} onChange={(e) => setFilter(e.target.value)} allowClear style={{ marginBottom: 8 }} aria-label="Filter repositories" />
            <List size="small" bordered loading={repos === null} style={{ maxHeight: 220, overflow: 'auto', marginBottom: 12 }}
                locale={{ emptyText: reposError ? `Could not list repositories: ${reposError}` : 'No repositories' }}
                dataSource={shown}
                renderItem={(r) => (
                    <List.Item style={{ cursor: 'pointer', background: url === r.url ? 'var(--ant-color-primary-bg, rgba(22,119,255,.08))' : undefined }} onClick={() => setUrl(r.url)}>
                        <Space><Typography.Text strong>{r.name}</Typography.Text>{r.defaultBranch && <Typography.Text type="secondary">{r.defaultBranch}</Typography.Text>}</Space>
                        <Typography.Text type="secondary">{sizeText(r.size)}</Typography.Text>
                    </List.Item>
                )} />
            <Form layout="vertical">
                <Form.Item label="Repository address" htmlFor="cs-clone-url" style={{ marginBottom: 8 }}><Input id="cs-clone-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://dev.azure.com/org/project/_git/repo" /></Form.Item>
                <Space.Compact block>
                    <Form.Item label="Into folder" htmlFor="cs-clone-parent" style={{ flex: 2, marginBottom: 0 }}><Input id="cs-clone-parent" value={folder} onChange={(e) => setFolder(e.target.value)} /></Form.Item>
                    <Form.Item label="Name (optional)" htmlFor="cs-clone-name" style={{ flex: 1, marginBottom: 0 }}><Input id="cs-clone-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="the repository's name" /></Form.Item>
                </Space.Compact>
            </Form>
        </Modal>
    );
}
