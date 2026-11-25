import React from 'react';
import { Alert, App, Badge, Button, Checkbox, Dropdown, Empty, Input, Modal, Popconfirm, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { ClearOutlined, EditOutlined, HistoryOutlined, MinusOutlined, PlusOutlined, UndoOutlined, WarningOutlined } from '@ant-design/icons';
import { api, ApiError, FileStatus, GateResult } from '../api';
import { errText, openInEditor, useStudio } from '../state';
import { useKept } from '../kept';
import { DiffView, useDiffPrefs } from '../components/DiffView';
import { DiffToolbar } from '../components/DiffToolbar';
import { History } from './History';
import { Branches } from './Branches';
import { Stashes } from './Stashes';
import { ConflictView } from '../components/ConflictView';
import { VirtualRows } from '../components/VirtualRows';
import { navigate, useRoute } from '../route';
import { ScanGate } from '../components/ScanGate';
import { setStoredTab } from '../datagit-common';

type Sel = { path: string; area: 'staged' | 'changes' | 'conflict' } | null;

const STATE_LABEL: Record<string, { label: string; color: string }> = {
    M: { label: 'Modified', color: 'blue' }, A: { label: 'Added', color: 'green' }, D: { label: 'Deleted', color: 'red' },
    R: { label: 'Renamed', color: 'purple' }, C: { label: 'Copied', color: 'purple' }, T: { label: 'Type changed', color: 'default' },
    '!': { label: 'Conflict — needs your decision', color: 'volcano' }, '?': { label: 'New file (not tracked yet)', color: 'green' },
};

function split(p: string) { const i = p.lastIndexOf('/'); return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i) }; }

function FileRow({ f, code, selected, onSelect, action }: { f: FileStatus; code: string; selected: boolean; onSelect: () => void; action?: React.ReactNode }) {
    const { name, dir } = split(f.path);
    const st = STATE_LABEL[code] ?? { label: code, color: 'default' };
    return (
        <div className={`file-row${selected ? ' selected' : ''}`} onClick={onSelect} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect()} title={f.path}>
            <span className="name">{name}<span className="dir">{dir}</span></span>
            <span className="acts" onClick={(e) => e.stopPropagation()}>{action}</span>
            <Tooltip title={st.label}><Tag color={st.color} style={{ marginInlineEnd: 0, minWidth: 22, textAlign: 'center' }}>{code === '?' ? 'U' : code}</Tag></Tooltip>
        </div>
    );
}

function Section({ title, count, extra, children }: { title: string; count: number; extra?: React.ReactNode; children: React.ReactNode }) {
    if (count === 0) return null;
    return (
        <div style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px' }}>
                <Typography.Text strong style={{ flex: 1, fontSize: 12, textTransform: 'uppercase', letterSpacing: .4 }}>{title} <Badge count={count} color="#8c8c8c" size="small" /></Typography.Text>
                {extra}
            </div>
            {children}
        </div>
    );
}

const AREAS = ['staged', 'changes', 'conflict'] as const;
/** The file chosen in Changes, from the address (#/git/changes/<area>/<path>). */
function selFromRoute(route: string[]): Sel {
    const area = AREAS.find((a) => a === route[2]);
    return area && route[3] ? { path: route[3], area } : null;
}
const sameSel = (a: Sel, b: Sel) => (a?.path ?? '') === (b?.path ?? '') && (a?.area ?? '') === (b?.area ?? '');

function Changes() {
    const { message } = App.useApp();
    const { status, refresh } = useStudio();
    // The selected file is part of the address, so a reload or Back keeps it.
    const route = useRoute();
    const onTab = route[0] === 'git' && (!route[1] || route[1] === 'changes');
    const [sel, setSelState] = React.useState<Sel>(() => (onTab ? selFromRoute(route) : null));
    const wasOnTab = React.useRef(onTab);
    React.useEffect(() => {
        const arrived = onTab && !wasOnTab.current;
        wasOnTab.current = onTab;
        if (!onTab) return;
        const r = selFromRoute(route);
        // Back on this tab from another one (no file in the address): show the file chosen before.
        if (arrived && !r && sel) { navigate(['git', 'changes', sel.area, sel.path], true); return; }
        if (!sameSel(r, sel)) setSelState(r);
    }, [route]); // eslint-disable-line react-hooks/exhaustive-deps
    const setSel = React.useCallback((x: Sel) => {
        setSelState(x);
        if (onTab) navigate(x ? ['git', 'changes', x.area, x.path] : ['git', 'changes'], !x);
    }, [onTab]);
    const [diff, setDiff] = React.useState('');
    const [loadingDiff, setLoadingDiff] = React.useState(false);
    // A half-typed message is kept while you visit another screen and across a reload of the tab (cleared once committed).
    const [msg, setMsg] = useKept<string>('git-commit-message', '');
    const [busy, setBusy] = React.useState(false);
    const [gate, setGate] = React.useState<Extract<GateResult, { status: 'blocked' }> | null>(null);
    const [amend, setAmend] = React.useState(false);
    const [pushAfter, setPushAfter] = React.useState(false);
    const [recent, setRecent] = React.useState<string[]>([]);
    const [signoff, setSignoff] = React.useState(() => { try { return localStorage.getItem('cs.signoff') === '1'; } catch { return false; } });
    const [template, setTemplate] = React.useState('');
    const [clean, setClean] = React.useState<null | { files: string[]; chosen: string[]; ignored: boolean }>(null);
    // The team's commit template (commit.template) starts an empty message.
    React.useEffect(() => { api.commitTemplate().then((r) => setTemplate(r.template)).catch(() => { /* none */ }); }, []);
    React.useEffect(() => { if (template && !msg) setMsg(template); }, [template]); // eslint-disable-line react-hooks/exhaustive-deps
    // Submodules not checked out, LFS files not downloaded: shown with the fix.
    const [subs, setSubs] = React.useState<Array<{ path: string; state: string }>>([]);
    const [lfs, setLfs] = React.useState<{ used: boolean; installed: boolean; missing: string[] } | null>(null);
    React.useEffect(() => {
        api.submodules().then(setSubs).catch(() => setSubs([]));
        api.lfs().then(setLfs).catch(() => setLfs(null));
    }, [status?.head]);
    const subsOff = subs.filter((x) => x.state === 'not-initialized' || x.state === 'different-commit');
    const openClean = async (ignored: boolean) => { try { const r = await api.cleanPreview(ignored); setClean({ files: r.files, chosen: r.files, ignored }); } catch (e) { message.error(errText(e)); } };
    const [prefs, setPrefs] = useDiffPrefs();
    const { modal } = App.useApp();

    const files = status?.files ?? [];
    const conflicts = files.filter((f) => f.conflicted);
    const staged = files.filter((f) => !f.conflicted && f.staged !== '.' && !f.untracked);
    const changes = files.filter((f) => !f.conflicted && (f.unstaged !== '.' || f.untracked));

    // The status is read again every few seconds while this screen is shown: the diff is then read again quietly
    // (the spinner only shows for another file or other options; an unchanged diff does not re-render).
    const diffFor = React.useRef('');
    React.useEffect(() => {
        if (!sel || sel.area === 'conflict') { setDiff(''); diffFor.current = ''; return; }
        let cancelled = false;
        const key = JSON.stringify([sel, prefs]);
        if (diffFor.current !== key) { diffFor.current = key; setLoadingDiff(true); }
        api.diff(sel.path, sel.area === 'staged', prefs).then((r) => { if (!cancelled) setDiff(r.diff); })
            .catch((e) => { if (!cancelled) { setDiff(''); message.error(errText(e)); } })
            .finally(() => { if (!cancelled) setLoadingDiff(false); });
        return () => { cancelled = true; };
    }, [sel, status, message, prefs]);

    React.useEffect(() => {
        if (status?.mergeMessage && !msg) setMsg(status.mergeMessage);
    }, [status?.mergeMessage]); // eslint-disable-line react-hooks/exhaustive-deps

    const act = async (fn: () => Promise<unknown>) => {
        try { await fn(); await refresh(); } catch (e) { message.error(errText(e)); }
    };

    const afterCommit = async (sha?: string) => {
        message.success(`${amend ? 'Amended' : 'Committed'} ${sha?.slice(0, 7) ?? ''}`);
        setMsg(template); setSel(null); setAmend(false);
        await refresh();
        if (pushAfter) {
            const p = await api.push();
            if (p.status === 'ok') message.success('Pushed');
            else if (p.status === 'blocked') modal.warning({ title: 'Push stopped by the secret scan', content: 'Use Push at the top to review the findings.' });
            else modal.warning({ title: 'Committed, but the push did not go through', content: p.message });
            await refresh();
        }
    };

    const op = status?.operation;
    // A pull whose put-aside edits clashed with the pulled changes (no merge runs): undo it, or resolve and finish.
    const ps = status?.pullStash;
    const [psBusy, setPsBusy] = React.useState(false);
    const pullStashAct = (action: 'undo' | 'finish') => async () => {
        if (psBusy) return;
        setPsBusy(true);
        try { const r = await api.pullAutostash(action); message.success(r.message, 8); setSel(null); await refresh(); }
        catch (e) { modal.error({ title: action === 'undo' ? 'Could not undo the pull' : 'Could not finish', content: errText(e) }); await refresh(); }
        finally { setPsBusy(false); }
    };
    const undoPull = () => modal.confirm({
        title: 'Undo the pull?', okText: 'Undo pull', okButtonProps: { danger: true },
        content: <>Your branch goes back to where it was before the pull{ps ? <> (<Typography.Text code>{ps.before.slice(0, 7)}</Typography.Text>)</> : null} and your uncommitted edits come back exactly as they were, from the copy kept in the stash. Any choices you made in the clashing files are dropped. The pulled commits stay on {ps?.upstream ?? 'the remote'}: commit your edits, then Pull again.</>,
        onOk: pullStashAct('undo'),
    });
    const sequencing = op === 'cherry-pick' || op === 'revert' || op === 'rebase' || op === 'am';
    const commit = async (allowRewritePushed = false) => {
        setBusy(true);
        try {
            if (sequencing) {
                // Finish the cherry-pick / revert / rebase / git am (it may have more commits to apply); still scan-gated.
                const r = await api.continueOp();
                if (r.status === 'ok') { message.success(`Finished the ${op}`); setMsg(''); setSel(null); await refresh(); }
                else if (r.status === 'blocked') setGate(r);
                else message.warning(r.message);
                return;
            }
            // The branch this tab shows goes with it: another tab or a terminal may have switched since (refused then).
            const r = await api.commit(msg, undefined, { amend, allowRewritePushed, signoff, expectBranch: status?.branch ?? null });
            if (r.status === 'ok') await afterCommit(r.sha);
            else if (r.status === 'blocked') setGate(r);
            else if (amend && /already pushed/.test(r.message)) {
                modal.confirm({ title: 'Amend a pushed commit?', content: r.message, okText: 'Amend anyway', okButtonProps: { danger: true }, onOk: () => commit(true) });
            } else if (/^This tab shows /.test(r.message)) {
                modal.warning({ title: 'Another branch is checked out now', content: r.message, okText: 'Reload', onOk: () => refresh() });
                await refresh();
            } else {
                message.warning(r.message);
                // Refused (nothing staged, say): what this tab shows may be stale (another tab committed): read it again.
                await refresh();
            }
        } catch (e) { message.error(errText(e)); }
        finally { setBusy(false); }
    };

    const toggleAmend = async (on: boolean) => {
        setAmend(on);
        if (on && !msg.trim()) { try { const m = await api.messages(); if (m[0]) setMsg(m[0]); } catch { /* ignore */ } }
    };

    const discard = (paths: string[]) => modal.confirm({
        title: paths.length === 1 ? `Discard your changes to ${paths[0]}?` : `Discard changes in ${paths.length} files?`,
        content: 'The files go back to their last committed version (new files are removed). A copy of your version is kept in the recovery folder, just in case.',
        okText: 'Discard', okButtonProps: { danger: true },
        onOk: async () => {
            try {
                const r = await api.discard(paths);
                const short = r.recoveryDir.replace(/\\/g, '/').replace(/^.*?(\.git\/)/, '$1');
                message.success(`Discarded. A copy of your version is in ${short}`);
                setSel(null); await refresh();
            } catch (e) { message.error(errText(e)); }
        },
    });

    const stageHunk = async (h: number) => {
        if (!sel) return;
        try {
            // Stage exactly the change on screen: find it by its header among the current changes
            // and send its id; if the file changed meanwhile the server refuses and we refresh.
            const shown = diff.split('\n').filter((l) => l.startsWith('@@'))[h];
            const r = await api.hunks(sel.path, sel.area === 'staged');
            const hunk = r.hunks.find((x, i) => x.header === shown && r.hunks.findIndex((y) => y.header === shown) === i);
            if (!hunk) { message.warning('This file changed since it was shown. The view has been refreshed; please try again.'); await refresh(); return; }
            await api.stageHunks(sel.path, [hunk.id], sel.area === 'staged');
            await refresh();
        } catch (e) {
            if (e instanceof ApiError && e.code === 'stale-hunk') { message.warning(e.message); await refresh(); }
            else message.error(errText(e));
        }
    };
    const stageLines = async (h: number, lines: number[]) => {
        if (!sel) return;
        try {
            const shown = diff.split('\n').filter((l) => l.startsWith('@@'))[h];
            const r = await api.hunks(sel.path, sel.area === 'staged');
            const hunk = r.hunks.find((x) => x.header === shown);
            if (!hunk) { message.warning('This file changed since it was shown. The view has been refreshed; please try again.'); await refresh(); return; }
            await api.stageLines(sel.path, hunk.id, lines, sel.area === 'staged');
            await refresh();
        } catch (e) {
            if (e instanceof ApiError && e.code === 'stale-hunk') { message.warning(e.message); await refresh(); }
            else message.error(errText(e));
        }
    };
    const selFile = sel ? files.find((f) => f.path === sel.path) : undefined;

    const nothing = files.length === 0;
    // What the commit button says matches what it would do now.
    const commitLabel = conflicts.length && !sequencing
        ? (ps ? `Resolve ${conflicts.length} clashing file${conflicts.length === 1 ? '' : 's'} first` : `Resolve ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} first`)
        : sequencing ? `Continue ${op}` : amend ? 'Amend last commit'
        : !staged.length && !status?.mergeMessage ? `Commit to ${status?.branch ?? 'HEAD'} (nothing staged)`
        : `Commit ${staged.length ? `${staged.length} file${staged.length === 1 ? '' : 's'}` : ''} to ${status?.branch ?? 'HEAD'}`;
    return (
        <div style={{ display: 'flex', gap: 12, height: '100%', minHeight: 0 }}>
            <div className="panel" style={{ width: 360, minWidth: 300, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ padding: 10, borderBottom: '1px solid var(--panel-border)' }}>
                    <div style={{ position: 'relative' }}>
                        <Input.TextArea placeholder={staged.length ? 'Describe your change (commit message)' : 'Stage files, then describe your change'}
                            value={msg} onChange={(e) => setMsg(e.target.value)} autoSize={{ minRows: 2, maxRows: 6 }}
                            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && msg.trim() && (staged.length || amend)) void commit(); }} />
                        <Dropdown trigger={['click']} onOpenChange={(o) => { if (o) api.messages().then(setRecent).catch(() => undefined); }}
                            menu={{ items: recent.length ? recent.slice(0, 15).map((m, i) => ({ key: String(i), label: <span style={{ maxWidth: 420, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.split('\n')[0]}</span> })) : [{ key: 'none', label: 'No earlier messages', disabled: true }],
                                onClick: ({ key }) => { if (recent[Number(key)]) setMsg(recent[Number(key)]); } }}>
                            <Tooltip title="Recent messages"><Button aria-label="Recent messages" size="small" type="text" icon={<HistoryOutlined />} style={{ position: 'absolute', right: 2, top: 2 }} /></Tooltip>
                        </Dropdown>
                    </div>
                    <Space style={{ marginTop: 6 }} size={12} wrap>
                        <Tooltip title="Replace the last commit with this message and the staged changes (git commit --amend)"><Checkbox checked={amend} onChange={(e) => void toggleAmend(e.target.checked)} disabled={!!status?.operation}>Amend last commit</Checkbox></Tooltip>
                        <Checkbox checked={pushAfter} onChange={(e) => setPushAfter(e.target.checked)}>Push after commit</Checkbox>
                        <Tooltip title="Add a Signed-off-by line with your name (git commit --signoff), as some teams require"><Checkbox checked={signoff} onChange={(e) => { setSignoff(e.target.checked); try { localStorage.setItem('cs.signoff', e.target.checked ? '1' : '0'); } catch { /* ignore */ } }}>Sign off</Checkbox></Tooltip>
                    </Space>
                    <Tooltip title={conflicts.length ? 'Resolve all conflicts first' : !staged.length && !amend ? 'Stage at least one file' : !msg.trim() ? 'Write a commit message first' : 'Ctrl+Enter'}>
                        <Button type="primary" block style={{ marginTop: 8 }} loading={busy}
                            disabled={(!sequencing && !msg.trim()) || (!staged.length && !status?.mergeMessage && !amend && !sequencing) || conflicts.length > 0} onClick={() => commit()}>
                            {commitLabel}{pushAfter && !sequencing && !conflicts.length ? ' & push' : ''}
                        </Button>
                    </Tooltip>
                    <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>Checked for passwords and keys before it is committed.</Typography.Text>
                </div>
                <div style={{ overflow: 'auto', padding: '8px 4px', flex: 1 }}>
                    {subsOff.length > 0 && <Alert type="warning" showIcon style={{ margin: '0 4px 8px' }} message={`${subsOff.length} submodule${subsOff.length === 1 ? '' : 's'} not at the expected commit`}
                        description={subsOff.map((x) => x.path).join(', ')}
                        action={<Button size="small" onClick={() => act(async () => { setSubs(await api.updateSubmodules()); })}>Update</Button>} />}
                    {lfs?.used && !lfs.installed && <Alert type="warning" showIcon style={{ margin: '0 4px 8px' }} message="This repository stores large files with Git LFS, which is not installed" description="Install Git LFS (git-lfs.com, or it comes with Git for Windows), then reopen the repository." />}
                    {lfs?.used && lfs.installed && lfs.missing.length > 0 && <Alert type="warning" showIcon style={{ margin: '0 4px 8px' }} message={`${lfs.missing.length} large file${lfs.missing.length === 1 ? ' is' : 's are'} not downloaded (Git LFS)`}
                        action={<Button size="small" onClick={() => act(async () => { setLfs(await api.lfsPull()); })}>Download</Button>} />}
                    {ps && <Alert type="warning" showIcon style={{ margin: '0 4px 8px' }} data-testid="pull-stash"
                        message={conflicts.length ? 'Your uncommitted edits clash with the pulled changes' : 'A copy of your edits from the pull is still in the stash'}
                        description={conflicts.length
                            ? <>The pull went through, but your uncommitted edits clash with it in {conflicts.length} file{conflicts.length === 1 ? '' : 's'}. No merge is running. Resolve each file below (<b>Yours</b> is your edit, <b>Pulled</b> the pulled version), or undo the pull. Until then a copy of your edits is kept in the stash ({ps.ref}).</>
                            : <>All clashes are resolved{ps.headMoved ? ' and committed' : ''}. The copy of your edits from before the pull is still in the stash ({ps.ref}): remove it when you no longer need it.</>}
                        action={<Space direction="vertical">
                            {!ps.headMoved && <Button size="small" danger loading={psBusy} onClick={undoPull}>Undo pull</Button>}
                            {!conflicts.length && <Button size="small" loading={psBusy} onClick={pullStashAct('finish')}>Remove the copy</Button>}
                        </Space>} />}
                    {nothing && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes. Your work is committed." style={{ marginTop: 40 }} />}
                    <Section title={ps || !op ? 'Conflicts' : 'Merge conflicts'} count={conflicts.length}
                        extra={ps ? (ps.headMoved ? undefined : <Button size="small" danger type="text" onClick={undoPull}>Undo pull</Button>)
                            : op ? <Popconfirm title={`Stop the ${op} and go back to how things were before it?`} onConfirm={() => act(async () => { const r = await api.abortOp(); if (r.message) message.info(r.message); else message.success(`Stopped the ${op}`); })}><Button size="small" danger type="text">Abort {op}</Button></Popconfirm>
                            : undefined}>
                        <VirtualRows items={conflicts} rowHeight={30} keyOf={(f) => 'c' + f.path} render={(f) => <FileRow f={f} code="!" selected={sel?.path === f.path && sel.area === 'conflict'} onSelect={() => setSel({ path: f.path, area: 'conflict' })} />} />
                    </Section>
                    <Section title="Staged — in the next commit" count={staged.length}
                        extra={<Tooltip title="Unstage all"><Button aria-label="Unstage all" size="small" type="text" icon={<MinusOutlined />} onClick={() => act(() => api.unstage(staged.map((f) => f.path)))} /></Tooltip>}>
                        <VirtualRows items={staged} rowHeight={30} height="35vh" keyOf={(f) => 's' + f.path} render={(f) => <FileRow f={f} code={f.staged} selected={sel?.path === f.path && sel.area === 'staged'} onSelect={() => setSel({ path: f.path, area: 'staged' })}
                            action={<Tooltip title="Unstage"><Button aria-label="Unstage" size="small" type="text" icon={<MinusOutlined />} onClick={() => act(() => api.unstage([f.path]))} /></Tooltip>} />} />
                    </Section>
                    <Section title="Changes" count={changes.length}
                        extra={<Space size={0}>
                            <Tooltip title="Discard all changes"><Button aria-label="Discard all changes" size="small" type="text" icon={<UndoOutlined />} onClick={() => discard(changes.map((f) => f.path))} /></Tooltip>
                            <Dropdown menu={{ items: [{ key: 'u', label: 'Delete untracked files…' }, { key: 'i', label: 'Delete untracked and ignored files (build output…)…' }], onClick: ({ key }) => void openClean(key === 'i') }}>
                                <Tooltip title="Delete untracked files (git clean)"><Button aria-label="Clean untracked files" size="small" type="text" icon={<ClearOutlined />} /></Tooltip>
                            </Dropdown>
                            <Tooltip title="Stage all"><Button aria-label="Stage all" size="small" type="text" icon={<PlusOutlined />} onClick={() => act(() => api.stage(changes.map((f) => f.path)))} /></Tooltip>
                        </Space>}>
                        <VirtualRows items={changes} rowHeight={30} height="35vh" keyOf={(f) => 'u' + f.path} render={(f) => <FileRow f={f} code={f.untracked ? '?' : f.unstaged} selected={sel?.path === f.path && sel.area === 'changes'} onSelect={() => setSel({ path: f.path, area: 'changes' })}
                            action={<Space size={0}>
                                <Tooltip title="Discard changes"><Button aria-label="Discard changes" size="small" type="text" icon={<UndoOutlined />} onClick={() => discard([f.path])} /></Tooltip>
                                <Tooltip title="Stage"><Button aria-label="Stage" size="small" type="text" icon={<PlusOutlined />} onClick={() => act(() => api.stage([f.path]))} /></Tooltip>
                            </Space>} />} />
                    </Section>
                </div>
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--panel-border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {sel ? <Typography.Text strong className="mono" style={{ flex: '1 1 220px', minWidth: 0 }} ellipsis={{ tooltip: sel.path }}>{sel.path}</Typography.Text> : <Typography.Text type="secondary" style={{ flex: 1 }}>What changed</Typography.Text>}
                    {sel && sel.area !== 'conflict' && <DiffToolbar prefs={prefs} onChange={setPrefs} />}
                    {sel && sel.area !== 'conflict' && <Tag>{sel.area === 'staged' ? 'Staged version' : 'Not staged yet'}</Tag>}
                    {sel && !(selFile && (selFile.unstaged === 'D' || (selFile.staged === 'D' && selFile.unstaged === '.'))) /* not on disk: nothing to open */ &&
                        <Tooltip title="Open the file in the Code editor (your working copy)"><Button size="small" icon={<EditOutlined />} onClick={() => openInEditor(sel.path)}>Open in editor</Button></Tooltip>}
                </div>
                <div style={{ flex: 1, overflow: sel?.area === 'conflict' ? 'hidden' : 'auto', minHeight: 0 }}>
                    {!sel ? (status?.hasConflicts
                        ? (ps ? <Alert style={{ margin: 12 }} type="warning" showIcon icon={<WarningOutlined />} message="Your uncommitted edits clash with the pulled changes" description="Select a file under Conflicts to resolve it: Yours is your edit, Pulled the pulled version. When the last one is resolved your edits stay as uncommitted changes on top of the pulled commits (nothing is committed). Or press Undo pull." />
                            : !op ? <Alert style={{ margin: 12 }} type="warning" showIcon icon={<WarningOutlined />} message="Some files have conflicts" description="No merge is running: these conflicts come from applying stashed changes. Select a file under Conflicts to resolve it; nothing needs to be committed to finish." />
                            : <Alert style={{ margin: 12 }} type="warning" showIcon icon={<WarningOutlined />} message={`A ${op} needs your decision`} description={op === 'merge' ? 'Select a file under Merge conflicts to resolve it. When all are resolved, commit to finish the merge.' : 'Select a file under Merge conflicts to resolve it. When all are resolved, press Continue.'} />)
                        : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="Click a file on the left" />)
                        : sel.area === 'conflict' ? <ConflictView file={sel.path} onResolved={() => setSel(null)} />
                            : <DiffView diff={diff} loading={loadingDiff} mode={prefs.mode}
                                hunkAction={selFile && !selFile.untracked && prefs.ws === 'none' && !prefs.eol ? { label: sel.area === 'staged' ? 'Unstage this change' : 'Stage this change', onClick: stageHunk } : undefined}
                                lineAction={selFile && !selFile.untracked && prefs.ws === 'none' && !prefs.eol && prefs.mode === 'unified' ? { label: (n) => `${sel.area === 'staged' ? 'Unstage' : 'Stage'} ${n} line${n === 1 ? '' : 's'}`, onClick: stageLines } : undefined} />}
                            {selFile?.untracked && sel?.area !== 'staged' && <Button size="small" style={{ marginTop: 8 }} onClick={() => act(() => api.intentToAdd(selFile.path))}>Stage parts of this new file…</Button>}
                </div>
            </div>
            {clean && <Modal open title={clean.ignored ? 'Delete untracked and ignored files' : 'Delete untracked files'} okText={`Delete ${clean.chosen.length}`} okButtonProps={{ danger: true, disabled: !clean.chosen.length }}
                onCancel={() => setClean(null)}
                onOk={async () => { try { const r = await api.clean(clean.chosen, clean.ignored); message.success(`Deleted ${r.removed.length}. A copy is kept in .git/cs-studio/recovery.`); setClean(null); await refresh(); } catch (e) { message.error(errText(e)); } }}>
                {!clean.files.length ? <Typography.Text type="secondary">Nothing to delete.</Typography.Text> : <>
                    <Typography.Paragraph type="secondary">Only the ticked files are deleted. A copy of each is kept first.</Typography.Paragraph>
                    <Checkbox.Group style={{ display: 'flex', flexDirection: 'column', maxHeight: 360, overflow: 'auto' }} value={clean.chosen} onChange={(v) => setClean({ ...clean, chosen: v as string[] })}
                        options={clean.files.map((f) => ({ value: f, label: <Typography.Text className="mono">{f}</Typography.Text> }))} />
                </>}
            </Modal>}
            {gate && <ScanGate mode="commit" blocked={gate} message={msg} amend={amend} signoff={signoff} proceed={sequencing ? (ov) => api.continueOp(ov) : undefined} onClose={() => { setGate(null); void refresh(); }}
                onDone={async (sha) => { setGate(null); await afterCommit(sha); }} />}
        </div>
    );
}

const TABS = ['changes', 'history', 'branches', 'stash'];

export function SourceControl() {
    const { status, refresh } = useStudio();
    const count = status?.files.length ?? 0;
    // The tab is part of the address (#/git/history …), so Back returns to the previous tab.
    const route = useRoute();
    const tab = TABS.includes(route[1]) ? route[1] : 'changes';
    // Another tab or a terminal may commit, stage or switch meanwhile: while Source control is shown (and the browser
    // tab visible), read the repository again every few seconds, so buttons such as "Commit 1 file" stay true.
    const shown = route[0] === 'git';
    React.useEffect(() => {
        if (!shown) return;
        const t = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
        return () => window.clearInterval(t);
    }, [shown, refresh]);
    // Spellings people type for a tab (#/git/stashes, #/git/tags …) open it instead of falling back to Changes.
    React.useEffect(() => {
        const alias: Record<string, string> = { stashes: 'stash', branch: 'branches', tags: 'branches', log: 'history', commits: 'history' };
        if (route[0] !== 'git' || !route[1]) return;
        if (route[1] === 'tags') {
            // Branches & tags, on its Tags view (the view is in the address: #/git/branches/tags).
            setStoredTab('git-branches', 'tags');
            navigate(['git', 'branches', 'tags'], true);
            return;
        }
        if (alias[route[1]]) navigate(['git', alias[route[1]], ...route.slice(2)], true);
        else if (!TABS.includes(route[1])) navigate(['git', 'changes'], true); // an unknown tab: the address says what is shown
    }, [route]);
    return (
        <Tabs style={{ height: '100%' }} className="fill-tabs" activeKey={tab} onChange={(k) => navigate(['git', k])} destroyInactiveTabPane={false} items={[
            { key: 'changes', label: <span>Changes <Badge count={count} size="small" color="#93186C" /></span>, children: <div style={{ height: 'calc(100vh - var(--chrome) - 70px)' }}><Changes /></div> },
            { key: 'history', label: 'History', children: <div style={{ height: 'calc(100vh - var(--chrome) - 70px)' }}><History /></div> },
            { key: 'branches', label: 'Branches & tags', children: <Branches /> },
            { key: 'stash', label: 'Stashes', children: <div style={{ height: 'calc(100vh - var(--chrome) - 70px)' }}><Stashes /></div> },
        ]} />
    );
}
