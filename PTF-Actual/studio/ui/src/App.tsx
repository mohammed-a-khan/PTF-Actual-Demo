import React from 'react';
import { Alert, App, Badge, Button, Divider, Drawer, Dropdown, Form, Input, Layout, Menu, Modal, Result, Select, Space, Tooltip, Typography } from 'antd';
import {
    ArrowLeftOutlined,
    ApiOutlined, ArrowDownOutlined, DashboardOutlined, DatabaseOutlined, FilePdfOutlined, FieldTimeOutlined, LineChartOutlined, PlayCircleOutlined, RiseOutlined, SwapOutlined, ArrowUpOutlined, BranchesOutlined, CloudSyncOutlined, DownOutlined, EnvironmentOutlined,
    VideoCameraOutlined, RobotOutlined, CloudServerOutlined, CodeOutlined, MenuFoldOutlined, MenuUnfoldOutlined, PullRequestOutlined, ExperimentOutlined, SafetyCertificateOutlined, CheckSquareOutlined, AimOutlined, BuildOutlined, ReadOutlined, BellOutlined, MedicineBoxOutlined, EyeOutlined, HistoryOutlined, LockOutlined, MergeCellsOutlined, MoonOutlined, PlusOutlined, ProfileOutlined, DeploymentUnitOutlined, SettingOutlined, SunOutlined,
    InboxOutlined,
} from '@ant-design/icons';
import { api, GateResult, hasToken, setProtectedRunConfirm } from './api';
import { errText, StudioProvider, useStudio } from './state';
import { canSaveLost, discardLost, lostOnLeave, saveLost } from './unsaved';
import { cameFrom, goBack, navigate, questionClosed, setPopGuard, useRoute } from './route';
import { SourceControl } from './pages/SourceControl';
import { RepoSwitcher } from './components/RepoSwitcher';
import { Environments } from './pages/Environments';
import { Secrets } from './pages/Secrets';
import { Activity } from './pages/Activity';
import { PipelineSecrets } from './pages/PipelineSecrets';
import { Code } from './pages/Code';
import { Settings } from './pages/Settings';
import { WorkItems } from './pages/WorkItems';
import { PullRequests } from './pages/PullRequests';
import { Pipelines } from './pages/Pipelines';
import { Runs } from './pages/Runs';
import { ApiWorkspace } from './pages/ApiWorkspace';
import { Performance } from './pages/Performance';
import { Recorder } from './pages/Recorder';
import { Agents } from './pages/Agents';
import { AgentPanel } from './components/AgentPanel';
import { onAgentContext, setAgentScreen } from './agentContext';
import { ApiRunner } from './pages/ApiRunner';
import { Database } from './pages/Database';
import { PdfChecks } from './pages/PdfChecks';
import { Health } from './pages/Health';
import { Missions } from './pages/Missions';
import { Inbox } from './pages/Inbox';
import { Knowledge } from './pages/Knowledge';
import { AgentBuilder } from './pages/AgentBuilder';
import { Notifications } from './pages/Notifications';
import { ApiHistory } from './pages/ApiHistory';
import { ApiMocks } from './pages/ApiMocks';
import { Quality } from './pages/Quality';
import { Healing } from './pages/Healing';
import { VisualReview } from './pages/VisualReview';
import { TestPlans } from './pages/TestPlans';
import { ScanGate } from './components/ScanGate';
import { MergeDialog } from './components/MergeDialog';

type Page = 'code' | 'testplans' | 'runs' | 'quality' | 'healing' | 'visual' | 'recorder' | 'agents' | 'api' | 'api-runner' | 'api-history' | 'api-mocks' | 'perf' | 'perf-runs' | 'perf-trends' | 'perf-compare' | 'db' | 'pdf' | 'git' | 'prs' | 'work' | 'pipelines' | 'env' | 'secrets' | 'pipeline' | 'activity' | 'settings' | 'health' | 'notify' | 'missions' | 'knowledge' | 'agent-builder' | 'inbox';
/** Title and one line on what the screen is for (shown at the top of each screen). */
const PAGE_INFO: Record<Page, { title: string; about: string }> = {
    code: { title: 'Code', about: '' },
    runs: { title: 'Run tests', about: 'Pick features, tags or scenarios and run them on this computer.' },
    visual: { title: 'Visual review', about: 'Screenshots and accessibility checks from the runs: see what changed and approve it as the new baseline.' },
    healing: { title: 'Healed locators', about: 'Elements the framework found with another locator than the page object\'s: update the page object or dismiss.' },
    quality: { title: 'Quality', about: 'How each scenario does across runs: new failures, failing, flaky, causes, quarantine and the quality gate.' },
    'agent-builder': { title: 'Agent builder', about: 'Your team\'s own agents: an assistant to chat with, or a mission that works alone and is checked by the Studio. Kept in the repository.' },
    knowledge: { title: 'Knowledge', about: 'What agents look up before they act: documents, test and application code, work items, the wiki and what earlier runs learned. Every answer names its source.' },
    inbox: { title: 'Inbox', about: 'What agents wait for you on, work ready to review and agents that got worse. Answer here; new items also go to the channels that ask for them.' },
    missions: { title: 'Missions', about: 'Agents that work toward a goal alone, in their own copy and within a budget, checked by the Studio before you see the result.' },
    agents: { title: 'Agents', about: 'Copilot agents that read the application, run it in the Studio browser, write framework tests and fix them.' },
    recorder: { title: 'Recorder', about: 'Record a browser session and save it as a framework test: feature, page objects and steps.' },
    api: { title: 'API requests', about: 'Build and send requests, check the responses, and turn them into framework tests.' },
    'api-runner': { title: 'Collection runner', about: 'Run a collection\'s requests in order, with their checks, and get a report.' },
    'api-history': { title: 'Request history', about: 'Requests sent from API → Requests on this computer.' },
    'api-mocks': { title: 'API mocks', about: 'Services that answer like the real API, with faults to test how the application copes.' },
    perf: { title: 'Load scenarios', about: 'What virtual users do, how many, for how long, and when the result is good enough.' },
    'perf-runs': { title: 'Load test runs', about: 'Live progress, results per step, service levels, comparison with an earlier run.' },
    'perf-compare': { title: 'Compare load test runs', about: 'Two runs of a scenario side by side: what got better or worse, by how much, and whether it matters.' },
    'perf-trends': { title: 'Performance trends', about: 'How a scenario\'s response time, errors and throughput change from run to run.' },
    pdf: { title: 'PDF checks', about: 'Compare a PDF with data, a query, another PDF or values, and save the check as a test.' },
    db: { title: 'Database', about: 'Query the project\'s databases with its own settings, browse tables, save queries and turn them into tests.' },
    git: { title: 'Source control', about: 'Commit your changes, switch branches, look at history and stashes.' },
    prs: { title: 'Pull requests', about: 'Review a pull request, run its tests and vote.' },
    testplans: { title: 'Test plans', about: 'Test plans, suites and test cases in Azure DevOps, their latest outcomes, and the scenarios that automate them.' },
    pipelines: { title: 'Pipelines', about: 'Pipeline runs in Azure DevOps and their test results.' },
    work: { title: 'Work items', about: 'Stories, bugs and test cases, and the scenarios that automate them.' },
    env: { title: 'Environments', about: 'The settings each project and environment runs with.' },
    secrets: { title: 'Secrets', about: 'Passwords and tokens, kept on this computer only.' },
    pipeline: { title: 'Pipeline secrets', about: 'Secret variables your Azure DevOps pipeline must provide.' },
    health: { title: 'Health check', about: 'What a test run needs on this computer and in this repository, with a fix where the Studio has one.' },
    notify: { title: 'Notifications', about: 'A message to Teams, Slack or a webhook when a run ends; webhook addresses stay in your secrets.' },
    settings: { title: 'Settings', about: 'Your name on commits, Azure DevOps and network. Kept on this computer only.' },
    activity: { title: 'Activity', about: 'What was done with the Studio in this project.' },
};
const PAGES: Page[] = ['code', 'testplans', 'runs', 'quality', 'healing', 'visual', 'recorder', 'agents', 'api', 'api-runner', 'api-history', 'api-mocks', 'perf', 'perf-runs', 'perf-trends', 'perf-compare', 'db', 'pdf', 'git', 'prs', 'work', 'pipelines', 'env', 'secrets', 'pipeline', 'activity', 'settings', 'health', 'notify', 'missions', 'knowledge', 'agent-builder', 'inbox'];

/** Runs against a protected (production-like) environment: the user confirms each one. */
function ProtectedRunPrompt() {
    const { modal } = App.useApp();
    React.useEffect(() => {
        setProtectedRunConfirm((msg) => new Promise<boolean>((resolve) => {
            modal.confirm({ title: 'Protected environment', content: msg, okText: 'Run anyway', okButtonProps: { danger: true }, cancelText: 'Cancel', onOk: () => resolve(true), onCancel: () => resolve(false) });
        }));
    }, [modal]);
    return null;
}

/** Git left an index.lock behind (crashed Git): offer to remove it if it is old enough. */
function IndexLockPrompt() {
    const { message, modal } = App.useApp();
    const open = React.useRef(false);
    React.useEffect(() => {
        const h = () => {
            if (open.current) return;
            open.current = true;
            modal.confirm({
                title: 'Git is busy in this repository',
                content: 'Another Git program (a terminal, another editor) is working here, or a Git process crashed and left its lock file behind. If nothing else is running, the Studio can remove the stale lock (only if it is more than a minute old).',
                okText: 'Remove stale lock', cancelText: 'Wait',
                onOk: async () => { try { const r = await api.removeStaleLock(); (r.removed ? message.success : message.info)(r.message); } catch (e) { message.error(errText(e)); } },
                afterClose: () => { open.current = false; },
            });
        };
        window.addEventListener('cs-studio:index-lock', h);
        return () => window.removeEventListener('cs-studio:index-lock', h);
    }, [message, modal]);
    return null;
}

function BranchMenu() {
    const { message, modal } = App.useApp();
    const { status, branches, refresh } = useStudio();
    const [dialog, setDialog] = React.useState<'new' | 'merge' | null>(null);
    const [name, setName] = React.useState('');
    const local = branches.filter((b) => !b.remote);
    const remoteOnly = branches.filter((b) => b.remote && !local.some((l) => b.name.endsWith('/' + l.name)));
    // Missions' own branches (cs-studio/mission-…) are kept for review: listed apart, folded, so the list stays short.
    const isMission = (n: string) => /^(?:[^/]+\/)?cs-studio\/mission-/.test(n);
    const missionLocal = local.filter((b) => isMission(b.name) && !b.current);
    const shownLocal = local.filter((b) => !missionLocal.includes(b));
    const shownRemote = remoteOnly.filter((b) => !isMission(b.name));
    // The name Git gets: spaces become -, characters Git refuses are dropped (shown before it is created).
    const finalName = name.trim().replace(/\s+/g, '-').replace(/[~^:?*[\\\x00-\x1f\x7f]+/g, '').replace(/\.{2,}/g, '.').replace(/\/{2,}/g, '/').replace(/@\{/g, '@').replace(/^[-./]+/, '').replace(/(\.lock|[./])+$/, '');

    const switchTo = async (b: string) => {
        try { await api.switchBranch(b); message.success(`Switched to ${b}`); await refresh(); }
        catch (e) { modal.error({ title: `Could not switch to ${b}`, content: errText(e) }); }
    };

    // The server takes branch names up to 255 characters; a longer one is refused here, with a message.
    const BRANCH_MAX = 255;
    const tooLong = finalName.length > BRANCH_MAX;
    const shortName = finalName.length > 40 ? `${finalName.slice(0, 37)}…` : finalName;
    const createBranch = async () => {
        if (!finalName || tooLong) return;
        try { await api.createBranch(finalName); message.success(`Created ${finalName} and switched to it`); setDialog(null); await refresh(); } catch (e) { message.error(errText(e)); }
    };
    return (
        <>
            {/* Re-read branches on open: they may have been created in a terminal meanwhile. */}
            <Dropdown trigger={['click']} onOpenChange={(o) => { if (o) void refresh(); }} menu={{
                items: [
                    { type: 'group', label: 'Switch to branch', children: shownLocal.map((b) => ({ key: 'b:' + b.name, label: <Space>{b.name}{b.current && <Typography.Text type="secondary">(current)</Typography.Text>}</Space>, disabled: b.current })) },
                    ...(missionLocal.length ? [{ key: 'missions', label: `Mission branches (${missionLocal.length})`, children: missionLocal.map((b) => ({ key: 'b:' + b.name, label: b.name })) }] : []),
                    ...(shownRemote.length ? [{ type: 'group' as const, label: 'From the remote', children: shownRemote.map((b) => ({ key: 'b:' + b.name.replace(/^[^/]+\//, ''), label: b.name })) }] : []),
                    { type: 'divider' },
                    { key: 'new', icon: <PlusOutlined />, label: 'New branch…' },
                    { key: 'merge', icon: <MergeCellsOutlined />, label: `Merge a branch into ${status?.branch ?? 'this branch'}…`, disabled: !status?.branch },
                ],
                onClick: ({ key }) => {
                    if (key === 'new') { setName(''); setDialog('new'); }
                    else if (key === 'merge') setDialog('merge');
                    else if (key.startsWith('b:')) void switchTo(key.slice(2));
                },
            }}>
                <Button icon={<BranchesOutlined />}>{status?.branch ?? (status?.head ? `detached at ${status.head.slice(0, 7)}` : 'no commits yet')} <DownOutlined /></Button>
            </Dropdown>
            <Modal open={dialog === 'new'} title="New branch" okText={finalName && !tooLong ? <span title={finalName}>Create {shortName} and switch</span> : 'Create and switch'} onCancel={() => setDialog(null)} okButtonProps={{ disabled: !finalName || tooLong, style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' } }} destroyOnClose
                afterOpenChange={(o) => { if (o) document.getElementById('cs-new-branch')?.focus(); }}
                onOk={createBranch}>
                <Form layout="vertical"><Form.Item label="Branch name" htmlFor="cs-new-branch" validateStatus={tooLong ? 'error' : undefined} help={<div style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{tooLong ? <><Typography.Text type="danger">Too long: at most {BRANCH_MAX} characters (it has {finalName.length}).</Typography.Text><br /></> : null}{finalName && !tooLong && finalName !== name.trim() ? <><Typography.Text type="warning">It will be created as <Typography.Text code style={{ wordBreak: 'break-all' }}>{finalName}</Typography.Text> (branch names have no spaces or {'~ ^ : ? * [ \\'}).</Typography.Text><br /></> : null}Starts from {status?.branch ?? 'the current commit'}. Example: feature/login-tests</div>}>
                    <Input id="cs-new-branch" value={name} onChange={(e) => setName(e.target.value)} onPressEnter={() => { if (finalName && !tooLong) void createBranch(); }} /></Form.Item></Form>
            </Modal>
            <MergeDialog open={dialog === 'merge'} onClose={() => setDialog(null)} />
        </>
    );
}

function SyncButtons() {
    const { message, modal } = App.useApp();
    const { status, refresh } = useStudio();
    const [busy, setBusy] = React.useState<string | null>(null);
    const [gate, setGate] = React.useState<Extract<GateResult, { status: 'blocked' }> | null>(null);
    const run = async (k: string, fn: () => Promise<void>) => { setBusy(k); try { await fn(); } catch (e) { modal.error({ title: 'Something went wrong', content: errText(e) }); } finally { setBusy(null); await refresh(); } };

    const push = (opts?: { forceWithLease?: boolean; tags?: boolean }) => run('push', async () => {
        const r = await api.push(undefined, opts);
        if (r.status === 'ok') message.success('Pushed');
        else if (r.status === 'blocked') setGate(r);
        else modal.warning({ title: 'Push did not go through', content: r.message });
    });
    const pull = () => run('pull', async () => {
        const r = await api.pull();
        if (r.status === 'ok') message.success(r.message?.includes('Already up to date') ? 'Already up to date' : `Pulled the latest changes${r.mode === 'rebase' ? ' (rebased, as this repository is set up)' : r.mode === 'ff-only' ? ' (fast-forward)' : ''}`);
        else if (r.status === 'conflicts') modal.warning({ title: 'Pull needs your decision', content: `${r.conflicts?.length} file(s) were changed both here and on the remote. Open Source control → Merge conflicts.` });
        else modal.warning({ title: 'Pull did not go through', content: r.message });
    });
    const noUpstream = status && status.branch && (!status.upstream || status.upstreamGone);
    // Remotes of the repository (none: Fetch and Pull say so instead of "up to date").
    const [remotes, setRemotes] = React.useState<number | null>(null);
    React.useEffect(() => { api.remotes().then((r) => setRemotes(r.length)).catch(() => setRemotes(null)); }, [status?.branch, status?.upstream]);
    const NO_REMOTE = 'This repository has no remote (nothing to fetch from or pull). Add one in Source control › Branches & tags › Remotes.';
    const fetchNow = () => run('fetch', async () => {
        const rs = await api.remotes();
        setRemotes(rs.length);
        if (!rs.length) { message.info(NO_REMOTE); return; }
        await api.fetch();
        message.success(rs.length === 1 ? `Fetched from ${rs[0].name}: up to date with the remote` : `Fetched from ${rs.length} remotes`);
    });
    // Why Pull is off, in its tooltip.
    const pullOff = remotes === 0 ? NO_REMOTE : !status?.branch ? 'Pull needs a branch (this is a detached commit): switch to a branch first.' : status.upstreamGone ? `${status.upstream ?? 'The remote branch'} was deleted on the remote: nothing to pull.` : !status.upstream ? `${status.branch} is not on the remote yet (Publish branch first), so there is nothing to pull.` : null;
    return (
        <Space>
            <Tooltip title={remotes === 0 ? NO_REMOTE : 'Check the remote for new commits (changes nothing here)'}><Button icon={<CloudSyncOutlined />} loading={busy === 'fetch'} onClick={fetchNow}>Fetch</Button></Tooltip>
            <Tooltip title={pullOff ?? (status?.behind ? `${status.behind} new commit(s) on the remote` : 'Get the latest commits from the remote')}>
                <Badge count={status?.behind ?? 0} size="small"><Button icon={<ArrowDownOutlined />} loading={busy === 'pull'} disabled={!status?.upstream || !!status?.upstreamGone} onClick={pull}
                    // A disabled button gets no hover: the badge around it shows why it is off.
                    style={!status?.upstream || status?.upstreamGone ? { pointerEvents: 'none' } : undefined}>Pull</Button></Badge>
            </Tooltip>
            <Tooltip title={noUpstream ? 'First push: publishes this branch to the remote' : status?.ahead ? `${status.ahead} commit(s) to send` : 'Nothing to push'}>
                <Badge count={status?.ahead ?? 0} size="small" color="#93186C">
                    <Dropdown.Button type="primary" buttonsRender={([main, more]) => [main, React.isValidElement(more) ? React.cloneElement(more as React.ReactElement<{ 'aria-label'?: string }>, { 'aria-label': 'More push and pull actions' }) : more]} loading={busy === 'push'} disabled={!noUpstream && !status?.ahead && !status?.behind} onClick={() => push()}
                        menu={{
                            items: [
                                { key: 'tags', label: 'Push, including tags on these commits' },
                                { type: 'divider' },
                                { key: 'force', danger: true, label: 'Force push (with lease)…' },
                            ],
                            onClick: ({ key }) => {
                                if (key === 'tags') void push({ tags: true });
                                if (key === 'force') modal.confirm({
                                    title: 'Force push (with lease)?',
                                    content: <>Use this only after you rewrote commits that were already pushed (amend or reset). It replaces <b>{status?.upstream ?? 'the remote branch'}</b> with your version. <br /><br />“With lease” is the safe kind: if someone else pushed in the meantime, it stops instead of deleting their work.</>,
                                    okText: 'Force push', okButtonProps: { danger: true },
                                    onOk: () => push({ forceWithLease: true }),
                                });
                            },
                        }}>
                        <ArrowUpOutlined /> {noUpstream ? 'Publish branch' : 'Push'}
                    </Dropdown.Button>
                </Badge>
            </Tooltip>
            {gate && <ScanGate mode="push" blocked={gate} onClose={() => setGate(null)} onDone={async () => { setGate(null); await refresh(); }} />}
        </Space>
    );
}

/** A cherry-pick or revert stopped for conflicts: say so everywhere and offer Continue / Abort. */
function OperationBanner() {
    const { message, modal } = App.useApp();
    const { status, refresh } = useStudio();
    const [gate, setGate] = React.useState<Extract<GateResult, { status: 'blocked' }> | null>(null);
    const op = status?.operation;
    if (!op || op === 'merge') return null;
    const label = op === 'cherry-pick' ? 'cherry-pick' : op === 'revert' ? 'revert' : op === 'am' ? 'patch apply (git am)' : 'rebase';
    const cont = async () => {
        try {
            const r = await api.continueOp();
            // An empty pick/revert (the change is already there) is skipped: say so instead of "finished".
            if (r.status === 'ok') message.success(r.output && /nothing new was added/.test(r.output) ? r.output : `Finished the ${label}`);
            else if (r.status === 'blocked') setGate(r);
            else modal.warning({ title: `Could not continue the ${label}`, content: r.message });
            await refresh();
        } catch (e) { message.error(errText(e)); }
    };
    return (
        <>
            <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                message={`A ${label} is in progress`}
                description={<>
                    {status.hasConflicts ? 'Resolve the conflicts under Source control → Changes → Merge conflicts, then press Continue.' : 'All conflicts are resolved. Press Continue to finish.'}
                    {status.sidesSwapped && <div style={{ marginTop: 4 }}>During a rebase the sides are reversed: <b>Current</b> is {status.rebaseOnto ? <Typography.Text code>{status.rebaseOnto}</Typography.Text> : 'the branch you rebase onto'}, <b>Incoming</b> is your commit{status.rebaseBranch ? <> from <Typography.Text code>{status.rebaseBranch}</Typography.Text></> : ''}.</div>}
                </>}
                action={<Space direction="vertical">
                    <Button type="primary" size="small" disabled={status.hasConflicts} onClick={cont}>Continue {label}</Button>
                    <Tooltip title={`Leave out the ${op === 'am' ? 'patch' : 'commit'} being applied (its changes are dropped) and carry on with the rest`}>
                        <Button size="small" onClick={() => modal.confirm({ title: `Skip this ${op === 'am' ? 'patch' : 'commit'}?`, content: 'Its changes, and your conflict resolution for it, are not kept. The rest goes on.', okText: 'Skip', onOk: async () => {
                            try { const r = await api.skipOp(); if (r.status === 'conflicts') message.warning('The next commit also has conflicts: resolve them and continue.'); else if (r.status === 'rejected') modal.warning({ title: 'Could not skip', content: r.message }); else message.success(r.message || `Skipped; the ${label} carried on`); await refresh(); }
                            catch (e) { message.error(errText(e)); }
                        } })}>Skip this {op === 'am' ? 'patch' : 'commit'}</Button>
                    </Tooltip>
                    <Button size="small" danger onClick={() => modal.confirm({ title: `Abort the ${label}?`, content: 'Everything goes back to how it was before it started.', onOk: async () => { try { await api.abortOp(); await refresh(); } catch (e) { message.error(errText(e)); } } })}>Abort</Button>
                </Space>} />
            {gate && <ScanGate mode="commit" blocked={gate} proceed={(ov) => api.continueOp(ov)} onClose={() => setGate(null)} onDone={async () => { setGate(null); message.success(`Finished the ${label}`); await refresh(); }} />}
        </>
    );
}

function Shell({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
    const { message: shellMessage, modal: shellModal } = App.useApp();
    // "Leave without saving?": Save (when the screen can save), Discard, or Stay.
    const askLeave = (lose: string[], leave: () => void) => {
        const canSave = canSaveLost();
        const inst = shellModal.confirm({
            title: 'Unsaved changes', content: `Not saved: ${lose.join(', ')}.`,
            afterClose: questionClosed,
            footer: () => <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <Button onClick={() => { inst.destroy(); questionClosed(); }}>Stay</Button>
                <Button danger onClick={() => { inst.destroy(); questionClosed(); discardLost(); leave(); }}>Discard</Button>
                {canSave && <Button type="primary" onClick={() => { void saveLost().then((ok) => { if (ok) { inst.destroy(); questionClosed(); leave(); } }); }}>Save</Button>}
            </Space>,
        });
    };
    // The browser's Back/Forward to another screen asks too, like the menu, when that screen's work would be lost.
    React.useEffect(() => {
        setPopGuard((_to, _from, leave) => {
            const lose = lostOnLeave();
            if (!lose.length) return false;
            askLeave(lose, leave);
            return true;
        });
        return () => setPopGuard(null);
    }, [shellModal]);
    const { repoRoot, status, error } = useStudio();
    // The screen comes from the address (#/runs/…), so Back/Forward work; the last screen is
    // remembered for the next start.
    const route = useRoute();
    const page: Page = PAGES.includes(route[0] as Page) ? route[0] as Page : 'git';
    React.useEffect(() => {
        if (PAGES.includes(route[0] as Page)) { try { localStorage.setItem('cs-studio-page', route[0]); } catch { /* ignore */ } return; }
        let last: Page = 'git';
        try { const p = localStorage.getItem('cs-studio-page') as Page; if (PAGES.includes(p)) last = p; } catch { /* ignore */ }
        // An address that is not a screen (an old bookmark, a typo): said, then the last screen is shown.
        if (route[0]) shellMessage.warning(`"#/${route.join('/')}" is not a Studio screen: showing ${last} instead.`);
        navigate([last], true);
    }, [route]);
    const go = (p: Page) => {
        if (!(p !== page || route.length > 1)) return;
        // A screen that does not keep unsaved edits (a load scenario, a mock): asked before they are thrown away.
        const lose = lostOnLeave();
        if (lose.length && p !== page) askLeave(lose, () => navigate([p]));
        else navigate([p], false, { menu: true });
    };
    const [collapsed, setCollapsed] = React.useState(() => { try { return localStorage.getItem('cs-studio-menu') === 'collapsed'; } catch { return false; } });
    const toggleMenu = () => setCollapsed((c) => { try { localStorage.setItem('cs-studio-menu', c ? 'open' : 'collapsed'); } catch { /* ignore */ } return !c; });
    // The menu's width: dragged at its right edge (remembered); dragged very narrow it collapses; double-click resets.
    const MENU_MIN = 160, MENU_MAX = 420, MENU_DEFAULT = 204;
    const [menuWidth, setMenuWidth] = React.useState(() => { try { const w = Number(localStorage.getItem('cs-studio-menu-width')); return w >= MENU_MIN && w <= MENU_MAX ? w : MENU_DEFAULT; } catch { return MENU_DEFAULT; } });
    const saveWidth = (w: number) => { try { localStorage.setItem('cs-studio-menu-width', String(w)); } catch { /* ignore */ } };
    const startResize = (e: React.PointerEvent) => {
        e.preventDefault();
        const x0 = e.clientX, w0 = collapsed ? 56 : menuWidth;
        let last = w0;
        const move = (ev: PointerEvent) => {
            const w = w0 + ev.clientX - x0;
            if (w < 110) { if (!collapsed) setCollapsed(true); return; }
            last = Math.max(MENU_MIN, Math.min(MENU_MAX, w));
            setCollapsed(false); setMenuWidth(last);
        };
        const up = () => {
            window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
            document.body.style.cursor = ''; document.body.style.userSelect = ''; document.body.classList.remove('menu-resizing');
            setCollapsed((c) => { try { localStorage.setItem('cs-studio-menu', c ? 'collapsed' : 'open'); } catch { /* ignore */ } return c; });
            saveWidth(last);
        };
        document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; document.body.classList.add('menu-resizing');
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
    React.useEffect(() => {
        // Opening a file from another screen: the Code screen navigates (#/code/<file>/<line>).
        const r = (e: Event) => navigate(['runs', (e as CustomEvent).detail?.id]);
        window.addEventListener('cs-show-run', r);
        return () => { window.removeEventListener('cs-show-run', r); };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    // Copilot panel (every screen) and the screen it is told about.
    const [agentOpen, setAgentOpen] = React.useState(false);
    const closeAgent = React.useCallback(() => setAgentOpen(false), []);
    const [agentSession, setAgentSession] = React.useState<string | null>(null);
    // What waits for the person: the menu shows how many (the Inbox page keeps it current while open).
    const [inboxCount, setInboxCount] = React.useState(0);
    React.useEffect(() => { const load = () => { void api.inbox().then((r) => setInboxCount(r.items.length)).catch(() => undefined); }; load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
    React.useEffect(() => { onAgentContext((c) => { void api.agentContext(c).catch(() => undefined); }); }, []);
    // Screens stay loaded when hidden: a dialog still open on the screen left behind is closed with it.
    const prevPage = React.useRef(page);
    React.useEffect(() => { if (prevPage.current !== page) { Modal.destroyAll(); questionClosed(); prevPage.current = page; } }, [page]);
    React.useEffect(() => { setAgentScreen({ page: PAGE_INFO[page].title, screen: page, route: route.join('/') }); }, [page, route.join('/')]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => {
        const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); setAgentOpen((o) => !o); } };
        const ask = () => setAgentOpen(true);
        window.addEventListener('cs-studio:ask-copilot', ask);
        window.addEventListener('keydown', k);
        return () => { window.removeEventListener('keydown', k); window.removeEventListener('cs-studio:ask-copilot', ask); };
    }, []);
    const changes = status?.files.length ?? 0;

    return (
        <Layout style={{ height: '100%' }}>
            <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 16, paddingInline: 16, height: 56, lineHeight: '56px', background: dark ? '#141414' : '#fff', borderBottom: '1px solid var(--panel-border)' }}>
                <Space size={10}>
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: '#93186C', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, lineHeight: 1 }}>CS</div>
                    <Typography.Text strong style={{ fontSize: 15 }}>Test Studio</Typography.Text>
                </Space>
                <Divider type="vertical" />
                <RepoSwitcher repoRoot={repoRoot} />
                <BranchMenu />
                {status?.upstreamGone && <Tooltip title={`${status.upstream ?? 'The remote branch'} was deleted on the server (often after its pull request was merged). Push publishes it again; or switch to another branch.`}><Badge status="warning" text="remote branch deleted" /></Tooltip>}
                <div style={{ flex: 1 }} />
                <SyncButtons />
                <Tooltip title="Copilot: ask about this screen or give a task (Ctrl+I)"><Button type={agentOpen ? 'primary' : 'default'} icon={<RobotOutlined />} onClick={() => setAgentOpen((o) => !o)} aria-label="Copilot">Copilot</Button></Tooltip>
                <Tooltip title={dark ? 'Light theme' : 'Dark theme'}><Button type="text" aria-label={dark ? 'Light theme' : 'Dark theme'} icon={dark ? <SunOutlined /> : <MoonOutlined />} onClick={onToggleTheme} /></Tooltip>
            </Layout.Header>
            <Layout>
                <Layout.Sider width={menuWidth} collapsedWidth={56} collapsed={collapsed} theme="light" style={{ borderRight: '1px solid var(--panel-border)', display: 'flex', flexDirection: 'column', position: 'relative' }}>
                    <div role="separator" aria-orientation="vertical" aria-label="Resize the menu" aria-valuemin={MENU_MIN} aria-valuemax={MENU_MAX} aria-valuenow={collapsed ? 56 : menuWidth} tabIndex={0} className="menu-resizer" title="Drag to resize the menu (double-click: default width)"
                        onPointerDown={startResize}
                        onDoubleClick={() => { setCollapsed(false); setMenuWidth(MENU_DEFAULT); saveWidth(MENU_DEFAULT); try { localStorage.setItem('cs-studio-menu', 'open'); } catch { /* ignore */ } }}
                        onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const w = Math.max(MENU_MIN, Math.min(MENU_MAX, menuWidth + (e.key === 'ArrowRight' ? 16 : -16))); setCollapsed(false); setMenuWidth(w); saveWidth(w); } }} />
                    <Menu mode="inline" selectedKeys={[page]} onClick={({ key }) => go(key as Page)} className="side-menu" items={[
                        { type: 'group', label: collapsed ? null : 'Tests', children: [
                            { key: 'code', icon: <CodeOutlined />, label: 'Code' },
                            { key: 'runs', icon: <ExperimentOutlined />, label: 'Run tests' },
                            { key: 'quality', icon: <SafetyCertificateOutlined />, label: 'Quality' },
                            { key: 'healing', icon: <MedicineBoxOutlined />, label: 'Healed locators' },
                            { key: 'visual', icon: <EyeOutlined />, label: 'Visual review' },
                            { key: 'recorder', icon: <VideoCameraOutlined />, label: 'Recorder' },
                        ] },
                        { type: 'group', label: collapsed ? null : 'Agents', children: [
                            { key: 'inbox', icon: collapsed ? <Badge dot={inboxCount > 0} offset={[-2, 2]}><InboxOutlined /></Badge> : <InboxOutlined />, label: <span className="side-label">Inbox{inboxCount > 0 && <Badge count={inboxCount} size="small" overflowCount={99} />}</span> },
                            { key: 'agents', icon: <RobotOutlined />, label: 'Agents' },
                            { key: 'agent-builder', icon: <BuildOutlined />, label: 'Agent builder' },
                            { key: 'missions', icon: <AimOutlined />, label: 'Missions' },
                            { key: 'knowledge', icon: <ReadOutlined />, label: 'Knowledge' },
                        ] },
                        { type: 'group', label: collapsed ? null : 'API', children: [
                            { key: 'api', icon: <ApiOutlined />, label: 'Requests' },
                            { key: 'api-runner', icon: <PlayCircleOutlined />, label: 'Runner' },
                            { key: 'api-history', icon: <FieldTimeOutlined />, label: 'History' },
                            { key: 'api-mocks', icon: <CloudServerOutlined />, label: 'Mocks' },
                        ] },
                        { type: 'group', label: collapsed ? null : 'Performance', children: [
                            { key: 'perf', icon: <DashboardOutlined />, label: 'Scenarios' },
                            { key: 'perf-runs', icon: <LineChartOutlined />, label: 'Runs' },
                            { key: 'perf-trends', icon: <RiseOutlined />, label: 'Trends' },
                            { key: 'perf-compare', icon: <SwapOutlined />, label: 'Compare' },
                        ] },
                        { type: 'group', label: collapsed ? null : 'Data', children: [
                            { key: 'db', icon: <DatabaseOutlined />, label: 'Database' },
                            { key: 'pdf', icon: <FilePdfOutlined />, label: 'PDF checks' },
                        ] },
                        { type: 'group', label: collapsed ? null : 'Git', children: [
                            { key: 'git', icon: <BranchesOutlined />, label: <span className="side-label">Source control{changes > 0 && <Badge count={changes} size="small" color="#93186C" />}{status?.hasConflicts && <Badge status="error" />}</span> },
                        ] },
                        { type: 'group', label: collapsed ? null : 'Azure DevOps', children: [
                            { key: 'prs', icon: <PullRequestOutlined />, label: 'Pull requests' },
                            { key: 'pipelines', icon: <DeploymentUnitOutlined />, label: 'Pipelines' },
                            { key: 'work', icon: <ProfileOutlined />, label: 'Work items' },
                            { key: 'testplans', icon: <CheckSquareOutlined />, label: 'Test plans' },
                        ] },
                        { type: 'group', label: collapsed ? null : 'Setup', children: [
                            { key: 'env', icon: <EnvironmentOutlined />, label: 'Environments' },
                            { key: 'secrets', icon: <LockOutlined />, label: 'Secrets' },
                            { key: 'pipeline', icon: <CloudServerOutlined />, label: 'Pipeline secrets' },
                            { key: 'settings', icon: <SettingOutlined />, label: 'Settings' },
                            { key: 'health', icon: <MedicineBoxOutlined />, label: 'Health check' },
                            { key: 'notify', icon: <BellOutlined />, label: 'Notifications' },
                            { key: 'activity', icon: <HistoryOutlined />, label: 'Activity' },
                        ] },
                    ]} />
                    <Tooltip title={collapsed ? 'Show menu labels' : 'Collapse the menu (more room for your work)'} placement="right">
                        <Button type="text" size="small" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={toggleMenu} className="side-collapse" aria-label={collapsed ? 'Show the menu labels' : 'Collapse the menu'} />
                    </Tooltip>
                </Layout.Sider>
                <Layout.Content className="page" style={{ ['--chrome' as string]: page === 'code' ? (cameFrom() && cameFrom()!.route[0] !== 'code' ? '112px' : '80px') : '132px' }}>
                    {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }}
                        action={/safe\.directory|does not trust this folder/i.test(error) ? <Button size="small" onClick={async () => { try { await api.trustFolder(); window.location.reload(); } catch (e) { Modal.error({ title: "Could not trust the folder", content: errText(e) }); } }}>Trust this folder</Button> : undefined} />}
                    <OperationBanner />
                    {(() => {
                        // Opened from another screen (a link, not the menu): a way back to where the person was.
                        const from = cameFrom();
                        const fromPage = from?.route[0] as Page | undefined;
                        const back = from && fromPage && fromPage !== page && PAGE_INFO[fromPage]
                            ? <Button size="small" icon={<ArrowLeftOutlined />} className="back-to" onClick={() => goBack(from)} title={`Back to ${PAGE_INFO[fromPage].title}, as you left it`}>Back to {PAGE_INFO[fromPage].title}</Button>
                            : null;
                        if (page === 'code') return back ? <div className="page-back">{back}</div> : null;
                        return <div className="page-head">{back}<h1>{PAGE_INFO[page].title}</h1><span>{PAGE_INFO[page].about}</span></div>;
                    })()}
                    {/* Code stays mounted so open tabs and unsaved edits survive switching screens. */}
                    <div style={{ display: page === 'code' ? 'block' : 'none', height: 'calc(100vh - var(--chrome))' }}><Code /></div>
                    <div style={{ display: page === 'runs' ? 'block' : 'none', height: 'calc(100vh - var(--chrome))' }}><Runs /></div>
                    <div style={{ display: page === 'api' ? 'block' : 'none' }}><ApiWorkspace /></div>
                    <div style={{ display: page === 'db' ? 'block' : 'none' }}><Database /></div>
                    {page === 'pdf' && <PdfChecks />}
                    {page === 'health' && <Health />}
                    {page === 'notify' && <Notifications />}
                    <div style={{ display: page === 'recorder' ? 'block' : 'none' }}><Recorder /></div>
                    {page === 'api-runner' && <ApiRunner />}
                    {page === 'api-history' && <ApiHistory />}
                    {page === 'api-mocks' && <ApiMocks />}
                    {page === 'quality' && <Quality />}
                    {page === 'healing' && <Healing />}
                    {page === 'visual' && <VisualReview />}
                    {page === 'perf' && <Performance mode="scenarios" />}
                    {page === 'perf-runs' && <Performance mode="runs" />}
                    {page === 'perf-trends' && <Performance mode="trends" />}
                    {page === 'perf-compare' && <Performance mode="compare" />}
                    {page === 'git' && <SourceControl />}
                    {page === 'prs' && <PullRequests />}
                    {page === 'work' && <WorkItems />}
                    {page === 'testplans' && <TestPlans />}
                    {page === 'pipelines' && <Pipelines />}
                    {page === 'env' && <Environments />}
                    {page === 'secrets' && <Secrets />}
                    {page === 'pipeline' && <PipelineSecrets />}
                    {page === 'activity' && <Activity />}
                    {page === 'settings' && <Settings />}
                    {page === 'knowledge' && <Knowledge />}
                    {page === 'agent-builder' && <AgentBuilder openConversation={(id) => { setAgentSession(id); setAgentOpen(true); }} />}
                    {page === 'inbox' && <Inbox onCount={setInboxCount} openConversation={(id) => { setAgentSession(id); setAgentOpen(true); }} />}
                    {page === 'missions' && <Missions openConversation={(id) => { setAgentSession(id); setAgentOpen(true); }} />}
                    {page === 'agents' && <Agents openPanel={(id) => { setAgentSession(id); setAgentOpen(true); }} />}
                    <IndexLockPrompt />
                    <ProtectedRunPrompt />
                </Layout.Content>
            </Layout>
            <Drawer open={agentOpen} onClose={() => setAgentOpen(false)} mask={false} placement="right" width={560} title={<Space><RobotOutlined />Copilot</Space>} styles={{ body: { padding: 12, display: 'flex', flexDirection: 'column' } }} destroyOnClose={false}>
                <AgentPanel open={agentOpen} initialSession={agentSession} onClose={closeAgent} />
            </Drawer>
        </Layout>
    );
}

export function StudioApp(props: { dark: boolean; onToggleTheme: () => void }) {
    if (!hasToken()) {
        return <Result status="403" title="Open the Studio from its start link"
            subTitle={<>Run <Typography.Text code>cs-test-studio start</Typography.Text> and open the link it prints. The link contains a one-time key that only your computer knows.</>} />;
    }
    return <StudioProvider><Shell {...props} /></StudioProvider>;
}
