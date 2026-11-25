/**
 * History (TortoiseGit "Show log"): commit graph with branch/tag labels, search and filters, commit
 * details with changed files and their diffs, and the actions TortoiseGit offers on a commit —
 * compare, create branch/tag, switch to, revert, cherry-pick, reset (with recovery points), copy.
 * Ctrl/Cmd-click selects a second commit to compare two commits.
 */
import React from 'react';
import { Alert, App, Button, Checkbox, Descriptions, Drawer, Dropdown, Empty, Form, Input, List, Modal, Radio, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { ArrowLeftOutlined, CopyOutlined, EditOutlined, DownOutlined, HistoryOutlined, InfoCircleOutlined, MoreOutlined, ReloadOutlined, RollbackOutlined, SearchOutlined, UpOutlined } from '@ant-design/icons';
import { api, Backup, CommitDetails, HistoryQuery, LogCommit, NameStatus, GraphRow } from '../api';
import { errText, openInEditor, useStudio } from '../state';
import { GraphCell, LANE, ROW } from '../components/Graph';
import { DiffView, useDiffPrefs } from '../components/DiffView';
import { DiffToolbar } from '../components/DiffToolbar';
import { Split } from '../components/Split';
import { VirtualRows } from '../components/VirtualRows';
import { TidyCommits } from '../components/TidyCommits';
import { navigate, useRoute } from '../route';
import { plural } from '../datagit-common';

const REF_COLOR: Record<string, string> = { head: 'magenta', branch: 'green', remote: 'orange', tag: 'gold', stash: 'default' };
const STATUS: Record<string, { t: string; c: string }> = { A: { t: 'Added', c: 'green' }, M: { t: 'Modified', c: 'blue' }, D: { t: 'Deleted', c: 'red' }, R: { t: 'Renamed', c: 'purple' }, C: { t: 'Copied', c: 'purple' }, T: { t: 'Type', c: 'default' } };
const ago = (d: string) => {
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${plural(Math.floor(s / 86400), 'day')} ago`; return new Date(d).toLocaleDateString();
};

function FileList({ files, selected, onSelect }: { files: NameStatus[]; selected?: string; onSelect: (f: NameStatus) => void }) {
    return (
        <div>
            <VirtualRows items={files} rowHeight={30} height="60vh" keyOf={(f) => f.path} render={(f) => (
                <div className={`file-row${selected === f.path ? ' selected' : ''}`} onClick={() => onSelect(f)}
                    ref={selected === f.path ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
                    <Tag color={STATUS[f.status]?.c} style={{ marginInlineEnd: 0, minWidth: 22, textAlign: 'center' }}>{f.status}</Tag>
                    <span className="name" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                        {f.path.split('/').pop()}
                        <span className="dir">{f.oldPath ? `from ${f.oldPath}` : f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                    </span>
                </div>
            )} />
            {files.length === 0 && <Typography.Text type="secondary" style={{ padding: 8, display: 'block' }}>No file changes.</Typography.Text>}
        </div>
    );
}

export function History() {
    const { message, modal } = App.useApp();
    const { status, refresh } = useStudio();
    const [query, setQuery] = React.useState<HistoryQuery>({ all: false, field: 'message', limit: 300 });
    const [text, setText] = React.useState('');
    const [data, setData] = React.useState<{ commits: LogCommit[]; graph: GraphRow[]; more: boolean } | null>(null);
    const [loading, setLoading] = React.useState(false);
    // The commit and the open file come from the address (#/git/history/<sha>/<file>), so the
    // browser's Back button returns from a file to the commit, and from the commit to the list.
    const route = useRoute();
    const here = route[0] === 'git' && route[1] === 'history';
    const sel = here ? route[2] ?? null : null;
    const filePath = here ? route[3] ?? null : null;
    const setSel = (sha: string | null) => navigate(['git', 'history', sha], true);
    const [sel2, setSel2] = React.useState<string | null>(null);
    const [details, setDetails] = React.useState<CommitDetails | null>(null);
    const [cmpFiles, setCmpFiles] = React.useState<NameStatus[] | null>(null);
    const files = cmpFiles ?? details?.files ?? [];
    const file = filePath ? files.find((f) => f.path === filePath) ?? null : null;
    const fileIndex = file ? files.indexOf(file) : -1;
    // Opened from the list in this tab: "back" is the browser's Back (no extra history entry).
    const openedHere = React.useRef(false);
    const openFile = (f: NameStatus) => { if (!sel) return; navigate(['git', 'history', sel, f.path], !!filePath); if (!filePath) openedHere.current = true; };
    const closeFile = () => { if (openedHere.current) { openedHere.current = false; window.history.back(); } else navigate(['git', 'history', sel], true); };
    const [diff, setDiff] = React.useState('');
    const [prefs, setPrefs] = useDiffPrefs();
    const [dialog, setDialog] = React.useState<null | { kind: 'branch' | 'tag' | 'reset'; sha: string }>(null);
    const [form, setForm] = React.useState({ name: '', message: '', mode: 'mixed' as 'soft' | 'mixed' | 'hard', switchTo: true });
    const [backups, setBackups] = React.useState<Backup[] | null>(null);
    const [reflog, setReflog] = React.useState<Array<{ sha: string; ref: string; date: string; subject: string }> | null>(null);
    const [tidy, setTidy] = React.useState<{ base: string } | null>(null);

    const load = React.useCallback(async (q: HistoryQuery) => {
        setLoading(true);
        try { setData(await api.history(q)); } catch (e) { message.error(errText(e)); }
        finally { setLoading(false); }
    }, [message]);
    React.useEffect(() => { void load(query); }, [query, load, status?.head]);

    // Details of one commit, or the comparison of two.
    // sel2: another commit to compare with, or 'WORKTREE' for "compare with working tree".
    React.useEffect(() => {
        setDiff(''); setDetails(null); setCmpFiles(null);
        if (!sel) return;
        if (sel2 === 'WORKTREE') api.compare(sel, 'WORKTREE').then(setCmpFiles).catch((e) => message.error(errText(e)));
        else if (sel2) api.compare(sel2, sel).then(setCmpFiles).catch((e) => message.error(errText(e)));
        else api.commitDetails(sel).then(setDetails).catch((e) => message.error(errText(e)));
    }, [sel, sel2, message]);
    React.useEffect(() => {
        setDiff('');
        if (!sel || !file) return;
        const p = sel2 === 'WORKTREE' ? api.compareDiff(sel, 'WORKTREE', file.path, false, prefs)
            : sel2 ? api.compareDiff(sel2, sel, file.path, false, prefs) : api.commitDiff(sel, file.path, prefs);
        p.then((r) => setDiff(r.diff)).catch((e) => message.error(errText(e)));
    }, [file?.path, sel, sel2, prefs, message]); // eslint-disable-line react-hooks/exhaustive-deps
    // In the file view: [ and ] (or Alt+↑/↓) for the previous/next file, Esc for back.
    React.useEffect(() => {
        if (!file) return;
        const h = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (e.key === ']' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); if (fileIndex < files.length - 1) openFile(files[fileIndex + 1]); }
            else if (e.key === '[' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); if (fileIndex > 0) openFile(files[fileIndex - 1]); }
            else if (e.key === 'Escape') closeFile();
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }); // eslint-disable-line react-hooks/exhaustive-deps

    const commits = data?.commits ?? [];
    const width = Math.max(1, ...(data?.graph.map((g) => g.width) ?? [1]));
    // A narrow commit list (a 1024px window): one badge per row, author and SHA left to the details, so the message stays readable.
    const listRef = React.useRef<HTMLDivElement>(null);
    const [narrow, setNarrow] = React.useState(false);
    React.useEffect(() => {
        const el = listRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 600));
        ro.observe(el);
        return () => ro.disconnect();
    }, [file, sel]);
    const short = (s: string) => s.slice(0, 7);
    /**
     * The Code editor edits your working copy, not a commit: open the current file, and say when it is not the version
     * shown here (changed since that commit) or is not there any more.
     */
    const openCurrent = async (path: string) => {
        const rev = sel2 === 'WORKTREE' ? null : sel;
        if (!rev) { openInEditor(path); return; }
        try {
            const d = (await api.compareDiff(rev, 'WORKTREE', path)).diff;
            const goneNow = /^\+\+\+ \/dev\/null/m.test(d) || (!d.trim() && file?.status === 'D' && !sel2);
            if (goneNow) { message.warning(`${path} is not in your working copy any more: there is nothing to open. Use "Restore this version" to bring it back.`); return; }
            openInEditor(path);
            if (d.trim()) message.info(`Opened your current ${path}: it has changed since ${short(rev)}, so the editor shows a newer version than this commit.`, 6);
        } catch (e) { message.error(errText(e)); }
    };

    const op = async (label: string, fn: () => Promise<{ status: string; message?: string; conflicts?: string[] } | void>) => {
        try {
            const r = await fn();
            await refresh();
            if (r && r.status === 'conflicts') modal.warning({ title: `${label} needs your decision`, content: `${r.conflicts?.length} file(s) conflict. Open Changes → Merge conflicts, resolve them, then press Continue in the banner at the top.` });
            else if (r && r.status === 'rejected') modal.error({ title: `${label} did not complete`, content: r.message });
            else message.success(r && r.message && !/^\[/.test(r.message) ? r.message : `${label} done`);
            await load(query);
        } catch (e) { modal.error({ title: `${label} failed`, content: errText(e) }); }
    };

    const busyOp = status?.operation ?? null;
    const menu = (c: LogCommit): MenuProps => ({
        items: [
            { key: 'cmpwt', label: 'Compare with working tree' },
            ...(sel && sel !== c.sha ? [{ key: 'cmpsel', label: `Compare with selected (${short(sel)})` }] : []),
            { type: 'divider' as const },
            { key: 'branch', label: 'Create branch here…' },
            { key: 'tag', label: 'Create tag here…' },
            { key: 'switch', label: 'Switch to this commit (read-only look)', disabled: !!busyOp },
            { type: 'divider' as const },
            { key: 'revert', label: 'Revert this commit (undo it with a new commit)', disabled: !!busyOp },
            { key: 'pick', label: `Cherry-pick onto ${status?.branch ?? 'current branch'}`, disabled: !!busyOp },
            ...(busyOp ? [{ key: 'busy', disabled: true, label: <Typography.Text type="warning" style={{ fontSize: 12 }}>Finish or abort the {busyOp} in progress first</Typography.Text> }] : []),
            { key: 'reset', label: `Reset ${status?.branch ?? 'current branch'} to here…`, danger: true },
            { key: 'irebase', label: `Clean up the commits after this one (squash, reword, drop)…`, disabled: !!busyOp || !status?.branch },
            { type: 'divider' as const },
            { key: 'copy', label: 'Copy commit SHA' },
            { key: 'copymsg', label: 'Copy message' },
        ],
        onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === 'cmpwt') { setSel(c.sha); setSel2('WORKTREE'); }
            if (key === 'cmpsel' && sel) setSel2(c.sha);
            if (key === 'branch') { setForm({ ...form, name: '', switchTo: true }); setDialog({ kind: 'branch', sha: c.sha }); }
            if (key === 'tag') { setForm({ ...form, name: '', message: '' }); setDialog({ kind: 'tag', sha: c.sha }); }
            if (key === 'reset') { setForm({ ...form, mode: 'mixed' }); setDialog({ kind: 'reset', sha: c.sha }); }
            if (key === 'switch') modal.confirm({
                title: `Switch to commit ${short(c.sha)}?`,
                content: 'You will be looking at the files as they were in this commit ("detached HEAD"). New commits made here belong to no branch — create a branch first if you want to keep work. Switch back with the branch menu.',
                onOk: () => op('Switch', () => api.switchBranch(c.sha).then(() => undefined)),
            });
            if (key === 'revert') modal.confirm({
                title: `Revert "${c.subject}"?`, content: 'A new commit is added that undoes exactly what this commit changed. History is not rewritten, so this is safe even if it is already pushed.',
                okText: 'Revert', onOk: () => op('Revert', () => api.revert(c.sha)),
            });
            if (key === 'pick') modal.confirm({
                title: `Cherry-pick "${c.subject}"?`, content: `The changes of this commit are copied onto ${status?.branch} as a new commit.`,
                okText: 'Cherry-pick', onOk: () => op('Cherry-pick', () => api.cherryPick([c.sha])),
            });
            if (key === 'irebase') setTidy({ base: c.sha });
            if (key === 'copy') { void navigator.clipboard?.writeText(c.sha); message.success('SHA copied'); }
            if (key === 'copymsg') { void navigator.clipboard?.writeText(c.subject); message.success('Message copied'); }
        },
    });

    const submitDialog = async () => {
        if (!dialog) return;
        if (dialog.kind === 'branch') await op('Create branch', () => api.createBranch(form.name.trim(), dialog.sha).then(() => undefined));
        if (dialog.kind === 'tag') await op('Create tag', () => api.createTag(form.name.trim(), dialog.sha, form.message).then(() => undefined));
        if (dialog.kind === 'reset') await op('Reset', async () => { const r = await api.reset(dialog.sha, form.mode); return { status: 'ok', message: `Reset done. Recovery point saved (${r.backup.split('/').pop()}).` }; });
        setDialog(null);
    };

    const head = commits.find((c) => c.refs.some((r) => r.kind === 'head'));
    return (
        <div className="dg-history" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8 }}>
            <Space wrap>
                <Space.Compact>
                    <Select value={query.field} onChange={(v) => setQuery({ ...query, field: v })} style={{ width: 120 }}
                        options={[{ value: 'message', label: 'Message' }, { value: 'author', label: 'Author' }, { value: 'path', label: 'File path' }]} />
                    <Input allowClear placeholder={/^[0-9a-f]{7,40}$/i.test(text) ? 'Press Enter to jump to this commit' : 'Search history (Enter)'} value={text} onChange={(e) => setText(e.target.value)} style={{ width: 280 }}
                        onPressEnter={() => {
                            const hit = /^[0-9a-f]{7,40}$/i.test(text.trim()) && commits.find((c) => c.sha.startsWith(text.trim().toLowerCase()));
                            if (hit) { setSel(hit.sha); setSel2(null); document.getElementById('c-' + hit.sha)?.scrollIntoView({ block: 'center' }); }
                            else setQuery({ ...query, text: text.trim() || undefined });
                        }} prefix={<SearchOutlined />} />
                </Space.Compact>
                <Checkbox checked={query.all} onChange={(e) => setQuery({ ...query, all: e.target.checked })}>All branches</Checkbox>
                <Tooltip title="Only the main line of this branch (hide the commits merged in)"><Checkbox checked={query.firstParent} onChange={(e) => setQuery({ ...query, firstParent: e.target.checked })}>First parent</Checkbox></Tooltip>
                <Checkbox checked={query.noMerges} onChange={(e) => setQuery({ ...query, noMerges: e.target.checked })}>No merges</Checkbox>
                <Tooltip title="Refresh"><Button icon={<ReloadOutlined />} aria-label="Refresh history" onClick={() => load(query)} /></Tooltip>
                <Button icon={<RollbackOutlined />} onClick={() => { api.backups().then(setBackups).catch((e) => message.error(errText(e))); api.reflog(100).then(setReflog).catch(() => setReflog([])); }}>Recovery points</Button>
                {sel && sel2 && <Tag closable onClose={() => setSel2(null)} color="purple">{sel2 === 'WORKTREE' ? `Comparing ${short(sel)} → working files` : `Comparing ${short(sel2)} → ${short(sel)}`}</Tag>}
                <Tooltip title="Ctrl/⌘-click a second commit to compare two commits. Right-click a commit for actions."><InfoCircleOutlined aria-label="How to compare commits" style={{ color: 'var(--muted)' }} /></Tooltip>
            </Space>

            {file && sel ? (
                // A file of the commit: its file list stays on the left, with previous/next and back.
                <div className="panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--panel-border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Tooltip title="Back to the commit (Esc)"><Button size="small" icon={<ArrowLeftOutlined />} onClick={closeFile}>Back to commits</Button></Tooltip>
                        <Typography.Text code>{short(sel)}</Typography.Text>
                        <Typography.Text ellipsis style={{ maxWidth: 360 }} title={details?.message}>{sel2 ? (sel2 === 'WORKTREE' ? 'compared with your working files' : `compared with ${short(sel2)}`) : details?.message.split('\n')[0]}</Typography.Text>
                        <div style={{ flex: 1 }} />
                        <Space.Compact>
                            <Tooltip title="Previous file ( [ )"><Button aria-label="Previous file ( [ )" size="small" icon={<UpOutlined />} disabled={fileIndex <= 0} onClick={() => openFile(files[fileIndex - 1])} /></Tooltip>
                            <Button size="small" disabled style={{ cursor: 'default' }}>File {fileIndex + 1} of {files.length}</Button>
                            <Tooltip title="Next file ( ] )"><Button aria-label="Next file ( ] )" size="small" icon={<DownOutlined />} disabled={fileIndex >= files.length - 1} onClick={() => openFile(files[fileIndex + 1])} /></Tooltip>
                        </Space.Compact>
                        <DiffToolbar prefs={prefs} onChange={setPrefs} />
                        <Tooltip title="Open your current version of this file in the Code editor"><Button size="small" icon={<EditOutlined />} onClick={() => void openCurrent(file.path)}>Open in editor</Button></Tooltip>
                        {!sel2 && file.status !== 'D' && (
                                                <Button size="small" icon={<HistoryOutlined />} onClick={() => modal.confirm({
                                                    title: `Restore ${file.path} as it was in ${short(sel)}?`,
                                                    content: 'Your current version of this file is replaced (a copy is kept in the recovery folder). Review and commit afterwards.',
                                                    onOk: () => op('Restore file', async () => { await api.restoreFile(sel, file.path); }),
                                                })}>Restore this version</Button>
                                            )}
                    </div>
                    <Split id="history-files" initial={300} min={180} max={700}>
                        <div style={{ flex: 1, overflow: 'auto', padding: 4 }}><FileList files={files} selected={file.path} onSelect={openFile} /></div>
                        <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
                            <Typography.Text strong className="mono" style={{ display: 'block', padding: '6px 10px', borderBottom: '1px solid var(--panel-border)' }}>{file.oldPath ? `${file.oldPath} → ` : ''}{file.path}</Typography.Text>
                            {diff ? <DiffView diff={diff} mode={prefs.mode} /> : <Spin style={{ margin: 40 }} />}
                        </div>
                    </Split>
                </div>
            ) : (
            <Split id="history-detail" sizeOf="second" initial={420} min={320} max={1000} style={{ gap: 0 }}>
                <div ref={listRef} className={`panel${narrow ? ' dg-narrow' : ''}`} style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
                    {loading && !data && <Spin style={{ margin: 40 }} />}
                    {data && commits.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 60 }} description="No commits match." />}
                    {commits.map((c, i) => {
                        const g = data!.graph[i];
                        const isSel = c.sha === sel, isSel2 = sel2 !== null && c.sha === sel2;
                        return (
                            <Dropdown key={c.sha} menu={menu(c)} trigger={['contextMenu']}>
                                <div id={'c-' + c.sha} className={`log-row${isSel ? ' selected' : ''}${isSel2 ? ' selected2' : ''}${c === head ? ' head' : ''}`} style={{ height: ROW }}
                                    onClick={(e) => { if ((e.ctrlKey || e.metaKey) && sel && sel !== c.sha) setSel2(c.sha); else { setSel(c.sha); setSel2(null); } }}>
                                    <GraphCell row={g} width={width} isMerge={c.parents.length > 1} isHead={c === head} />
                                    <span className="log-subject">
                                        {(() => {
                                            // At most two badges (shortened), the rest as "+N": the message stays readable.
                                            const refs = c.refs.filter((r) => r.kind !== 'head');
                                            const max = narrow ? 1 : 2;
                                            return <>{refs.slice(0, max).map((r) => <Tag key={r.kind + r.name} color={REF_COLOR[r.kind]} title={r.kind === 'tag' ? `Tag ${r.name}` : r.name} style={{ marginInlineEnd: 4, verticalAlign: 'middle' }}>{r.kind === 'tag' ? '🏷 ' : ''}{r.name}</Tag>)}
                                                {refs.length > max && <Tooltip title={refs.slice(max).map((r) => r.name).join(', ')}><Tag className="dg-more" style={{ marginInlineEnd: 4 }}>+{refs.length - max}</Tag></Tooltip>}</>;
                                        })()}
                                        <span className="log-message" title={c.subject}>{c.subject}</span>
                                    </span>
                                    <span className="log-meta log-author" title={c.authorName}>{c.authorName}</span>
                                    <span className="log-meta" title={new Date(c.date).toLocaleString()}>{ago(c.date)}</span>
                                    <Typography.Text code className="log-sha">{short(c.sha)}</Typography.Text>
                                    <Dropdown menu={menu(c)} trigger={['click']}><Button size="small" type="text" icon={<MoreOutlined />} onClick={(e) => e.stopPropagation()} /></Dropdown>
                                </div>
                            </Dropdown>
                        );
                    })}
                    {data?.more && <div style={{ padding: 8, textAlign: 'center' }}><Button onClick={() => setQuery({ ...query, limit: (query.limit ?? 300) + 500 })}>Show more</Button></div>}
                    <div style={{ height: 1, width: width * LANE }} />
                </div>
                <div className="panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    {!sel ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="Select a commit" /> : (
                        <>
                            <div style={{ padding: 10, borderBottom: '1px solid var(--panel-border)', maxHeight: '40%', overflow: 'auto' }}>
                                {sel2 === 'WORKTREE' ? (
                                    <Typography.Text>Differences between <Typography.Text code>{short(sel)}</Typography.Text> and your working files ({cmpFiles?.length ?? '…'} files)</Typography.Text>
                                ) : sel2 ? (
                                    <Typography.Text>Differences from <Typography.Text code>{short(sel2)}</Typography.Text> to <Typography.Text code>{short(sel)}</Typography.Text> ({cmpFiles?.length ?? '…'} files)</Typography.Text>
                                ) : details ? (
                                    <>
                                        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 8, fontWeight: 500 }}>{details.message}</Typography.Paragraph>
                                        <Descriptions size="small" column={1} className="dg-commit-desc" items={[
                                            { key: 'a', label: 'Author', children: `${details.authorName} <${details.authorEmail}>` },
                                            { key: 'd', label: 'Date', children: new Date(details.date).toLocaleString() },
                                            { key: 's', label: 'Commit', children: <Typography.Text code copyable={{ text: details.sha, icon: <CopyOutlined /> }} title={details.sha} style={{ wordBreak: 'break-all' }}>{details.sha}</Typography.Text> },
                                            { key: 'p', label: details.parents.length > 1 ? 'Parents (merge)' : 'Parent', children: details.parents.map((p) => <Typography.Link key={p} code onClick={() => setSel(p)} style={{ marginRight: 6 }}>{short(p)}</Typography.Link>) },
                                            { key: 'b', label: 'On branches', children: details.branches.slice(0, 8).map((b) => <Tag key={b}>{b}</Tag>) },
                                            { key: 'u', label: 'Pushed', children: details.pushed ? <Tag color="green">yes — shared with others</Tag> : <Tag>not yet</Tag> },
                                        ]} />
                                    </>
                                ) : <Spin />}
                            </div>
                            <div style={{ padding: '6px 10px 2px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 8 }}>
                                <Typography.Text strong style={{ flex: 1, whiteSpace: 'nowrap' }}>Changed files ({files.length})</Typography.Text>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Click a file to see its changes</Typography.Text>
                            </div>
                            <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
                                <FileList files={files} onSelect={openFile} />
                            </div>
                        </>
                    )}
                </div>
            </Split>
            )}

            <Modal open={dialog?.kind === 'branch'} title={`New branch at ${dialog ? short(dialog.sha) : ''}`} okText="Create" onCancel={() => setDialog(null)} onOk={submitDialog} okButtonProps={{ disabled: !form.name.trim() }}>
                <Form layout="vertical"><Form.Item label="Branch name" htmlFor="cs-history-branch-name"><Input id="cs-history-branch-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.replace(/^\s+/, '').replace(/\s+/g, '-') })} autoFocus /></Form.Item></Form>
            </Modal>
            <Modal open={dialog?.kind === 'tag'} title={`New tag at ${dialog ? short(dialog.sha) : ''}`} okText="Create tag" onCancel={() => setDialog(null)} onOk={submitDialog} okButtonProps={{ disabled: !form.name.trim() }}>
                <Form layout="vertical">
                    <Form.Item label="Tag name" help="For example v1.4.0 or regression-2026-11" htmlFor="cs-history-tag-name"><Input id="cs-history-tag-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.replace(/^\s+/, '').replace(/\s+/g, '-') })} autoFocus /></Form.Item>
                    <Form.Item label="Description (optional — makes an annotated tag)" htmlFor="cs-history-description-optional-makes-an-"><Input.TextArea id="cs-history-description-optional-makes-an-" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Form.Item>
                </Form>
                <Typography.Text type="secondary">Tags stay on this computer until you push them (Branches &amp; tags → Push tag).</Typography.Text>
            </Modal>
            <Modal open={dialog?.kind === 'reset'} title={`Reset ${status?.branch ?? 'the current branch'} to ${dialog ? short(dialog.sha) : ''}`} okText="Reset" okButtonProps={{ danger: form.mode === 'hard' }} onCancel={() => setDialog(null)} onOk={submitDialog} width={620}>
                <Typography.Paragraph>Moves <b>{status?.branch}</b> back to this commit. Commits after it leave the branch. A recovery point is saved first, so you can undo this from <i>Recovery points</i>.</Typography.Paragraph>
                <Radio.Group value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Radio value="soft"><b>Soft</b> — keep all changes, staged and ready to commit again (e.g. to redo the last commits as one).</Radio>
                    <Radio value="mixed"><b>Mixed</b> (default) — keep all changes in your files, but unstaged.</Radio>
                    <Radio value="hard"><b>Hard</b> — make the files exactly like this commit. Uncommitted work is replaced (a snapshot is kept in Recovery points).</Radio>
                </Radio.Group>
                {dialog && commits.findIndex((c) => c.sha === dialog.sha) > 0 && commits.slice(0, commits.findIndex((c) => c.sha === dialog.sha)).length > 0 && (
                    <Alert style={{ marginTop: 12 }} type="warning" showIcon message="If the commits after this one are already pushed, others may have them. Prefer Revert for shared history; after a reset you would need Push → force-with-lease." />
                )}
            </Modal>
            <Drawer open={!!backups} onClose={() => setBackups(null)} width={560} title="Recovery points">
                <Typography.Paragraph type="secondary">Saved automatically before every reset. Restoring one is itself undoable (a new recovery point is saved first).</Typography.Paragraph>
                <List dataSource={backups ?? []} locale={{ emptyText: 'No recovery points yet.' }} renderItem={(b) => (
                    <List.Item actions={[<Button key="r" size="small" onClick={() => modal.confirm({
                        title: b.ref.endsWith('-uncommitted') ? 'Bring back the uncommitted work from this point?' : `Move ${status?.branch} back to this point?`,
                        onOk: () => op('Restore', async () => { await api.restoreBackup(b.ref); setBackups(await api.backups()); }),
                    })}>Restore</Button>]}>
                        <List.Item.Meta title={<Space>{b.ref.endsWith('-uncommitted') ? <Tag color="orange">uncommitted work</Tag> : <Tag>branch position</Tag>}<Typography.Text code>{b.sha.slice(0, 7)}</Typography.Text></Space>}
                            description={<>{b.subject} · {new Date(b.date).toLocaleString()}</>} />
                    </List.Item>
                )} />
                <Typography.Title level={5} style={{ marginTop: 16 }}>Where HEAD has been</Typography.Title>
                <Typography.Paragraph type="secondary">Every commit, merge, rebase, reset and switch (git reflog): create a branch at an earlier position to get back commits that seem lost.</Typography.Paragraph>
                <List size="small" dataSource={reflog ?? []} locale={{ emptyText: 'Nothing yet.' }} renderItem={(e) => (
                    <List.Item actions={[<Button key="b" size="small" onClick={() => { setBackups(null); setForm({ ...form, name: '', switchTo: false }); setDialog({ kind: 'branch', sha: e.sha }); }}>Branch here…</Button>]}>
                        <List.Item.Meta title={<Space><Typography.Text code>{e.sha.slice(0, 7)}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.ref}</Typography.Text></Space>} description={<>{e.subject} · {new Date(e.date).toLocaleString()}</>} />
                    </List.Item>
                )} />
            </Drawer>
            {tidy && status?.branch && <TidyCommits base={tidy.base} branch={status.branch} onClose={() => setTidy(null)}
                onDone={(r) => { setTidy(null); void op('Clean-up', async () => r); }} />}
        </div>
    );
}
