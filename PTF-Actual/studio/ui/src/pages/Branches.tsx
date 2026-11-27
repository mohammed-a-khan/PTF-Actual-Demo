/** Branches & tags (TortoiseGit "Browse references"). */
import React from 'react';
import { useSwitchBranch } from '../branchSwitch';
import { App, Button, Dropdown, Empty, Form, Input, Modal, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { BranchesOutlined, CloudUploadOutlined, DeleteOutlined, MoreOutlined, PlusOutlined, SearchOutlined, TagOutlined } from '@ant-design/icons';
import { api, BranchInfo, NameStatus, TagInfo } from '../api';
import { errText, useStudio } from '../state';
import { MergeDialog } from '../components/MergeDialog';
import { RemotesTable } from '../components/RemotesTable';
import { DiffView, useDiffPrefs } from '../components/DiffView';
import { DiffToolbar } from '../components/DiffToolbar';
import { useReloadOnRemoteSync, useStoredTab } from '../datagit-common';
import { navigate, useRoute } from '../route';

/** Why git would refuse this tag name (the same rules the server checks), or null. */
export function tagNameProblem(name: string, branchNames: string[], tagNames: string[]): string | null {
    if (!name) return null;
    if (name.startsWith('-')) return 'A tag name must not start with "-".';
    if (name.startsWith('.') || name.includes('/.')) return 'A tag name (or a part after "/") must not start with ".".';
    if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return 'A tag name must not contain spaces or any of ~ ^ : ? * [ \\.';
    if (name.includes('..') || name.includes('@{') || name.includes('//') || name === '@') return 'A tag name must not contain "..", "@{" or "//" (or be just "@").';
    if (/(\/|\.|\.lock)$/.test(name) || /\.lock\//.test(name)) return 'A tag name must not end with "/", "." or ".lock".';
    if (name.length > 200) return 'A tag name can have at most 200 characters.';
    if (tagNames.includes(name)) return `A tag named "${name}" exists already: choose another name.`;
    if (branchNames.includes(name)) return `A branch is named "${name}": a tag with the same name would be ambiguous. Choose another name.`;
    return null;
}

type BranchPart = 'local' | 'remote' | 'tags' | 'remotes';
const PARTS: readonly BranchPart[] = ['local', 'remote', 'tags', 'remotes'];

/** The tag name git gets for what was typed: spaces (inside) become "-", as for a branch. */
export function tagFinalName(typed: string): string {
    return typed.trim().replace(/\s+/g, '-');
}

/** The name git gets for what was typed (the same clean-up as New branch): no spaces or ~ ^ : ? * [ \, no "..". */
export function branchFinalName(typed: string): string {
    return typed.trim().replace(/\s+/g, '-').replace(/[~^:?*[\\\x00-\x1f\x7f]+/g, '').replace(/\.{2,}/g, '.').replace(/\/{2,}/g, '/').replace(/@\{/g, '@').replace(/^[-./]+/, '').replace(/(\.lock|[./])+$/, '');
}
/** Why a branch cannot be renamed to this (typed) name, or null. */
export function renameProblem(typed: string, from: string, localNames: string[]): string | null {
    const to = branchFinalName(typed);
    if (!typed.trim()) return null;
    if (!to) return 'Give the branch a name with letters or digits.';
    if (to.length > 255) return `Too long: at most 255 characters (it has ${to.length}).`;
    if (to === from) return null;
    if (localNames.includes(to)) return `A branch named "${to}" exists already: choose another name.`;
    return null;
}

export function Branches() {
    const { message, modal } = App.useApp();
    const { status, branches, refresh } = useStudio();
    const [tags, setTags] = React.useState<TagInfo[]>([]);
    const [merge, setMerge] = React.useState<string | null>(null);
    const [rename, setRename] = React.useState<{ from: string; to: string } | null>(null);
    const [newTag, setNewTag] = React.useState<{ name: string; rev: string; message: string } | null>(null);
    const [cmp, setCmp] = React.useState<{ a: string; b: string; files: NameStatus[]; file?: string; diff?: string } | null>(null);
    const [prefs, setPrefs] = useDiffPrefs();
    const [storedPart, storePart] = useStoredTab<BranchPart>('git-branches', PARTS, 'local');
    // The view is in the address (#/git/branches/tags): Back and Forward move between views, a link opens one.
    const route = useRoute();
    const here = route[0] === 'git' && route[1] === 'branches';
    const part: BranchPart = here && PARTS.includes(route[2] as BranchPart) ? route[2] as BranchPart : storedPart;
    const setPart = (v: BranchPart) => { storePart(v); navigate(['git', 'branches', v]); };
    React.useEffect(() => {
        if (!here) return;
        if (route[2] !== part) navigate(['git', 'branches', part], true); // missing or wrong: the address says what is shown
        else if (part !== storedPart) storePart(part);
    }, [here, route.join('/')]); // eslint-disable-line react-hooks/exhaustive-deps
    // How many remotes there are (none: the remote views say so, and pushing a tag is off).
    const [remoteCount, setRemoteCount] = React.useState<number | null>(null);
    const loadRemotes = React.useCallback(() => { api.remotes().then((r) => setRemoteCount(r.length)).catch(() => setRemoteCount(null)); }, []);
    React.useEffect(loadRemotes, [loadRemotes, status?.upstream, part]);
    const [find, setFind] = React.useState('');

    const loadTags = React.useCallback(() => { api.tags().then(setTags).catch((e) => message.error(errText(e))); }, [message]);
    React.useEffect(loadTags, [loadTags, status?.head]);
    // The remote's state (new, moved or deleted tags) is read again after Fetch/Pull/Push, when the window gets focus
    // and when this view is opened again; not in the background while another screen is shown.
    useReloadOnRemoteSync(() => { if (here) { loadTags(); loadRemotes(); } });
    const wasHere = React.useRef(here);
    React.useEffect(() => { if (here && !wasHere.current) loadTags(); wasHere.current = here; }, [here, loadTags]);

    /** true when it worked (a dialog stays open on a problem, with the typed values). */
    const switchBranch = useSwitchBranch();
    const run = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
        try { await fn(); message.success(label); await refresh(); loadTags(); return true; } catch (e) { modal.error({ title: 'That did not work', content: errText(e) }); return false; }
    };
    // Create tag (button or Enter), once even when clicked twice.
    const tagBusy = React.useRef(false);
    // What was typed stays in the field; the name Git gets (spaces as "-") is shown under it when it differs.
    const tagFinal = newTag ? tagFinalName(newTag.name) : '';
    const tagProblem = newTag ? tagNameProblem(tagFinal, branches.filter((b) => !b.remote).map((b) => b.name), tags.map((t) => t.name)) : null;
    const createTag = () => {
        if (!newTag || !tagFinal || tagProblem || tagBusy.current) return;
        tagBusy.current = true;
        void run(`Created tag ${tagFinal}`, () => api.createTag(tagFinal, newTag.rev, newTag.message)).then((ok) => { tagBusy.current = false; if (ok) setNewTag(null); });
    };
    // Push a tag once even when clicked twice (the second click would race the first and fail with a lock error).
    const [pushingTag, setPushingTag] = React.useState<string | null>(null);
    const pushingTagRef = React.useRef(false);
    const pushTag = async (name: string) => {
        if (pushingTagRef.current) return;
        pushingTagRef.current = true; setPushingTag(name);
        try {
            const r = await api.pushTag(name);
            message.success(r.already ? `Tag ${name} is already on the remote` : `Pushed tag ${name}`);
            loadTags();
        } catch (e) { modal.error({ title: `Could not push tag ${name}`, content: errText(e) }); }
        finally { pushingTagRef.current = false; setPushingTag(null); }
    };

    // Rename (button or Enter), once even when clicked twice; the dialog stays open if Git refuses.
    const [renameBusy, setRenameBusy] = React.useState(false);
    // Git's refusal, shown in the dialog (not a second dialog on top of it).
    const [renameErr, setRenameErr] = React.useState<string | null>(null);
    const renameTo = rename ? branchFinalName(rename.to) : '';
    const renameBad = rename ? renameProblem(rename.to, rename.from, branches.filter((b) => !b.remote).map((b) => b.name)) : null;
    const doRename = async () => {
        if (!rename || !renameTo || renameTo === rename.from || renameBad || renameBusy) return;
        setRenameBusy(true);
        try { await api.renameBranch(rename.from, renameTo); message.success(`Renamed to ${renameTo}`); setRename(null); await refresh(); }
        catch (e) { setRenameErr(errText(e)); }
        finally { setRenameBusy(false); }
    };
    const del = (b: BranchInfo) => modal.confirm({
        title: `Delete branch ${b.name}?`, okText: 'Delete', okButtonProps: { danger: true },
        content: 'Only the branch name is removed on this computer. Commits that are also on other branches stay.',
        onOk: async () => {
            const r = await api.deleteBranch(b.name);
            if (r.status === 'not-merged') {
                modal.confirm({ title: `${b.name} has unmerged commits`, content: r.message, okText: 'Delete anyway', okButtonProps: { danger: true },
                    onOk: () => run(`Deleted ${b.name}`, () => api.deleteBranch(b.name, true)) });
            } else { message.success(`Deleted ${b.name}`); await refresh(); }
        },
    });

    const compare = async (a: string, b: string) => {
        try { setCmp({ a, b, files: await api.compare(a, b, true) }); } catch (e) { message.error(errText(e)); }
    };
    const openCmpFile = async (file: string) => {
        if (!cmp) return;
        try { const r = await api.compareDiff(cmp.a, cmp.b, file, true, prefs); setCmp({ ...cmp, file, diff: r.diff }); } catch (e) { message.error(errText(e)); }
    };
    React.useEffect(() => { if (cmp?.file) void openCmpFile(cmp.file); }, [prefs]); // eslint-disable-line react-hooks/exhaustive-deps

    const localMenu = (b: BranchInfo): MenuProps => ({
        items: [
            { key: 'switch', label: 'Switch to this branch', disabled: b.current },
            { key: 'merge', label: `Merge into ${status?.branch}…`, disabled: b.current },
            { key: 'rebase', label: `Rebase ${status?.branch ?? 'current branch'} onto ${b.name}…`, disabled: b.current || !status?.branch },
            { key: 'compare', label: `Compare with ${status?.branch}`, disabled: b.current },
            { key: 'tag', label: 'Create tag at its tip…' },
            { type: 'divider' },
            { key: 'rename', label: 'Rename…' },
            { key: 'upstream', label: 'Track a remote branch…', disabled: !b.current },
            { key: 'delete', label: 'Delete…', danger: true, disabled: b.current },
        ],
        onClick: ({ key }) => {
            if (key === 'switch') void switchBranch(b.name).then(() => loadTags());
            if (key === 'merge') setMerge(b.name);
            if (key === 'rebase') modal.confirm({
                title: `Rebase ${status?.branch} onto ${b.name}?`,
                content: `The commits of ${status?.branch} are replayed on top of ${b.name} (new commit ids; uncommitted edits are put aside and back). If ${status?.branch} is already pushed, you will need to push with force-with-lease.`,
                okText: 'Rebase',
                onOk: async () => {
                    try {
                        const r = await api.rebase(b.name);
                        await refresh();
                        if (r.status === 'conflicts') modal.warning({ title: 'Rebase needs your decision', content: `${r.conflicts?.length} file(s) conflict. Resolve them in Changes, then press Continue in the banner at the top.` });
                        else if (r.status === 'rejected') modal.error({ title: 'Rebase did not complete', content: r.message });
                        else message.success(`${status?.branch} is now on top of ${b.name}`);
                    } catch (e) { modal.error({ title: 'Rebase failed', content: errText(e) }); }
                },
            });
            if (key === 'compare' && status?.branch) void compare(status.branch, b.name);
            if (key === 'tag') setNewTag({ name: '', rev: b.name, message: '' });
            if (key === 'rename') { setRenameErr(null); setRename({ from: b.name, to: b.name }); }
            if (key === 'delete') del(b);
            if (key === 'upstream') {
                const remotes = branches.filter((x) => x.remote);
                let pick = remotes.find((r) => r.name.endsWith('/' + b.name))?.name ?? remotes[0]?.name;
                modal.confirm({
                    title: `${b.name} should track…`,
                    content: <select defaultValue={pick} onChange={(e) => { pick = e.target.value; }} style={{ width: '100%', marginTop: 8 }}>{remotes.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</select>,
                    onOk: () => pick ? run(`${b.name} now tracks ${pick}`, () => api.setUpstream(pick!)) : undefined,
                });
            }
        },
    });

    const q = find.trim().toLowerCase();
    const match = (x: { name: string }) => !q || x.name.toLowerCase().includes(q);
    const local = branches.filter((b) => !b.remote);
    const remote = branches.filter((b) => b.remote);
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="dg-toolbar" style={{ marginBottom: 0 }}>
                <Segmented value={part} onChange={(v) => setPart(v as BranchPart)} options={[
                    { value: 'local', label: <span><BranchesOutlined /> On this computer ({local.length})</span> },
                    { value: 'remote', label: <span><CloudUploadOutlined /> On the remote ({remote.length})</span> },
                    { value: 'tags', label: <span><TagOutlined /> Tags ({tags.length})</span> },
                    { value: 'remotes', label: 'Remotes' },
                ]} />
                {part !== 'remotes' && <Input allowClear prefix={<SearchOutlined />} placeholder={part === 'tags' ? 'Find a tag' : 'Find a branch'} aria-label={part === 'tags' ? 'Find a tag' : 'Find a branch'} value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 240 }} />}
                <span className="dg-spacer" />
                {part === 'tags' && <Button icon={<PlusOutlined />} onClick={() => setNewTag({ name: '', rev: 'HEAD', message: '' })}>New tag</Button>}
            </div>
            {part === 'local' && <>
            <Table<BranchInfo> size="small" rowKey="name" dataSource={local.filter(match)} pagination={false}
                locale={{ emptyText: q ? 'No branch matches.' : 'No branches.' }}
                columns={[
                    { title: 'Branch', dataIndex: 'name', render: (n: string, b) => <Space><Typography.Text strong={b.current}>{n}</Typography.Text>{b.current && <Tag color="magenta">current</Tag>}</Space> },
                    { title: 'Tracks', dataIndex: 'upstream', render: (u: string | null, b) => !u ? <Typography.Text type="secondary">not published</Typography.Text>
                        // The remote branch was deleted: say so here (not only in the header), struck through.
                        : b.upstreamGone ? <Tooltip title={`${u} was deleted on the remote. Push publishes ${b.name} again; or delete this branch if it was merged.`}><Space size={4} wrap><Tag style={{ textDecoration: 'line-through' }}>{u}</Tag><Typography.Text type="warning">deleted on the remote</Typography.Text></Space></Tooltip>
                        : <Tag color="orange">{u}</Tag> },
                    { title: 'Last commit', dataIndex: 'sha', width: 120, render: (s: string) => <Typography.Text code>{s.slice(0, 7)}</Typography.Text> },
                    { title: '', width: 220, render: (_: unknown, b) => (
                        <Space>
                            {!b.current && <Button size="small" onClick={() => void switchBranch(b.name).then(() => loadTags())}>Switch</Button>}
                            {!b.current && <Button size="small" onClick={() => setMerge(b.name)}>Merge…</Button>}
                            <Dropdown menu={localMenu(b)} trigger={['click']}><Button size="small" icon={<MoreOutlined />} aria-label={`More actions for ${b.name}`} /></Dropdown>
                        </Space>) },
                ]} />

            </>}
            {part === 'remote' && <>
            <Table<BranchInfo> size="small" rowKey="name" dataSource={remote.filter(match)} pagination={false}
                locale={{ emptyText: q && remote.length ? 'No branch matches.' : remoteCount === 0 ? <span>This repository has no remote, so there are no remote branches. <Typography.Link onClick={() => setPart('remotes')}>Add a remote</Typography.Link>, then Fetch to see your team’s branches.</span> : 'No remote branches yet. Fetch to see your team’s branches.' }}
                columns={[
                    { title: 'Branch', dataIndex: 'name' },
                    { title: 'Last commit', dataIndex: 'sha', width: 120, render: (s: string) => <Typography.Text code>{s.slice(0, 7)}</Typography.Text> },
                    { title: '', width: 330, render: (_: unknown, b) => {
                        const localName = b.name.replace(/^[^/]+\//, '');
                        const exists = local.some((l) => l.name === localName);
                        return (
                            <Space>
                                {!exists && <Tooltip title={`Creates ${localName} on this computer, tracking ${b.name}`}><Button size="small" onClick={() => void switchBranch(localName).then(() => loadTags())}>Check out</Button></Tooltip>}
                                {status?.branch && <Button size="small" onClick={() => compare(status.branch!, b.name)}>Compare</Button>}
                                <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={() => modal.confirm({
                                    title: `Delete ${b.name} on the remote?`, content: 'This removes the branch for everyone. Commits that are on other branches are kept.',
                                    okText: 'Delete on remote', okButtonProps: { danger: true }, onOk: () => run(`Deleted ${b.name} on the remote`, () => api.deleteRemoteBranch(b.name)),
                                })}>Delete</Button>
                            </Space>
                        );
                    } },
                ]} />

            </>}
            {part === 'remotes' && <RemotesTable onChanged={() => { void refresh(); loadRemotes(); }} />}
            {part === 'tags' && <>
            <Table<TagInfo> size="small" rowKey="name" dataSource={tags.filter(match)} pagination={false}
                locale={{ emptyText: q && tags.length ? 'No tag matches.' : 'No tags yet. Tags mark a version, e.g. the code a regression run used.' }}
                columns={[
                    { title: 'Tag', dataIndex: 'name', render: (n: string, t) => <Space wrap><Tag color="gold">{n}</Tag>
                        {t.onRemote === 'yes' && <Tooltip title="This tag is on the remote (pushed)"><Tag icon={<CloudUploadOutlined />} color="green">on the remote</Tag></Tooltip>}
                        {t.onRemote === 'different' && <Tooltip title="The remote has a tag of this name that points elsewhere: pushing is refused. Delete one of them, or use another name."><Tag color="red">differs on the remote</Tag></Tooltip>}
                        {t.annotated && <Typography.Text type="secondary">{t.message}</Typography.Text>}</Space> },
                    { title: 'Commit', dataIndex: 'sha', width: 120, render: (s: string) => <Typography.Text code>{s.slice(0, 7)}</Typography.Text> },
                    { title: 'Created', dataIndex: 'date', width: 200, render: (d: string) => d ? new Date(d).toLocaleString() : '' },
                    { title: '', width: 230, render: (_: unknown, t) => (
                        <Space>
                            {t.onRemote !== 'yes' && <Tooltip title={remoteCount === 0 ? 'This repository has no remote to push to: add one under Remotes.' : undefined}>
                                <Button size="small" icon={<CloudUploadOutlined />} disabled={remoteCount === 0 || (!!pushingTag && pushingTag !== t.name)} loading={pushingTag === t.name} onClick={() => void pushTag(t.name)}>Push</Button>
                            </Tooltip>}
                            <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={() => {
                                let alsoRemote = false;
                                // The remote option only when there is a remote (else the tag exists on this computer only).
                                void api.remotes().catch((): unknown[] => []).then((rs) => { modal.confirm({
                                    title: `Delete tag ${t.name}?`, okText: 'Delete', okButtonProps: { danger: true },
                                    content: rs.length ? <label style={{ display: 'block', marginTop: 8 }}><input type="checkbox" onChange={(e) => { alsoRemote = e.target.checked; }} /> Also delete it on the remote</label> : 'The tag is removed from this computer (the repository has no remote).',
                                    onOk: () => run(`Deleted tag ${t.name}`, () => api.deleteTag(t.name, alsoRemote)),
                                }); });
                            }}>Delete</Button>
                        </Space>) },
                ]} />

            </>}

            <MergeDialog open={!!merge} initial={merge ?? undefined} onClose={() => setMerge(null)} />
            <Modal open={!!rename} title={`Rename ${rename?.from}`} okText="Rename" onCancel={() => setRename(null)} okButtonProps={{ disabled: !renameTo || renameTo === rename?.from || !!renameBad }}
                confirmLoading={renameBusy} onOk={() => void doRename()} destroyOnClose>
                <Form layout="vertical"><Form.Item label="New name" htmlFor="cs-branches-rename" style={{ marginBottom: 0 }} tooltip="Only the name on this computer changes. If the branch was published, publish it again under the new name and delete the old remote branch."
                    validateStatus={renameBad || renameErr ? 'error' : undefined}
                    help={<div style={{ overflowWrap: 'anywhere' }}>{renameBad ?? renameErr ?? (rename && renameTo && renameTo !== rename.to.trim() ? <Typography.Text type="warning">It will be renamed to <Typography.Text code>{renameTo}</Typography.Text> (branch names have no spaces or {'~ ^ : ? * [ \\'}).</Typography.Text> : undefined)}</div>}>
                    <Input id="cs-branches-rename" autoFocus value={rename?.to} maxLength={250} onPressEnter={() => void doRename()} onChange={(e) => { setRenameErr(null); if (rename) setRename({ ...rename, to: e.target.value.replace(/^\s+/, '') }); }} />
                </Form.Item></Form>
            </Modal>
            <Modal open={!!newTag} title="New tag" okText="Create tag" onCancel={() => setNewTag(null)} okButtonProps={{ disabled: !tagFinal || !!tagProblem }}
                onOk={createTag}>
                {newTag && <Form layout="vertical">
                    <Form.Item label="Tag name" help={<div style={{ overflowWrap: 'anywhere' }}>{tagProblem ?? (tagFinal && tagFinal !== newTag.name.trim() ? <Typography.Text type="warning">It will be created as <Typography.Text code>{tagFinal}</Typography.Text> (tag names have no spaces).</Typography.Text> : 'For example v1.4.0 or regression-2026-11')}</div>} validateStatus={tagProblem ? 'error' : undefined} htmlFor="cs-branches-tag-name"><Input id="cs-branches-tag-name" value={newTag.name} onChange={(e) => setNewTag({ ...newTag, name: e.target.value.replace(/^\s+/, '') })} onPressEnter={createTag} autoFocus /></Form.Item>
                    <Form.Item label="At" htmlFor="cs-branches-at"><Input id="cs-branches-at" value={newTag.rev} onChange={(e) => setNewTag({ ...newTag, rev: e.target.value })} className="mono" /></Form.Item>
                    <Form.Item label="Description (optional — makes an annotated tag)" htmlFor="cs-branches-description-optional-makes-an-"><Input.TextArea id="cs-branches-description-optional-makes-an-" value={newTag.message} onChange={(e) => setNewTag({ ...newTag, message: e.target.value })} /></Form.Item>
                </Form>}
            </Modal>
            <Modal open={!!cmp} onCancel={() => setCmp(null)} footer={null} width="90vw" title={cmp ? `What ${cmp.b} has that ${cmp.a} does not (${cmp.files.length} files)` : ''}>
                {cmp && (cmp.files.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`${cmp.b} has no changes that ${cmp.a} is missing.`} /> : (
                    <div style={{ display: 'flex', gap: 12, height: '65vh' }}>
                        <div style={{ width: 300, overflow: 'auto', borderRight: '1px solid var(--panel-border)' }}>
                            {cmp.files.map((f) => <div key={f.path} className={`file-row${cmp.file === f.path ? ' selected' : ''}`} onClick={() => openCmpFile(f.path)}><Tag style={{ marginInlineEnd: 0 }}>{f.status}</Tag><span className="name mono">{f.path}</span></div>)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                            <div style={{ paddingBottom: 6 }}><DiffToolbar prefs={prefs} onChange={setPrefs} /></div>
                            <div style={{ flex: 1, overflow: 'auto' }}>{cmp.diff !== undefined ? <DiffView diff={cmp.diff} mode={prefs.mode} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Click a file" />}</div>
                        </div>
                    </div>
                ))}
            </Modal>
        </div>
    );
}
