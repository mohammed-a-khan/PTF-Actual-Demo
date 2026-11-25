/**
 * Pull requests (Azure DevOps), the way a test engineer reviews one:
 *   1. see what it changes, who reviews it, which checks block it, what was said;
 *   2. get it locally (its merge result, next to the project — the working copy is not touched)
 *      and run the tests it calls for (changed features, features using changed steps, scenarios
 *      of linked test cases);
 *   3. post the results to the pull request and vote (approve, wait for author, …).
 * Writing to Azure DevOps (comments, votes) always asks first.
 */
import React from 'react';
import { Alert, App, Badge, Button, Card, Checkbox, Col, Descriptions, Dropdown, Empty, Form, Input, InputNumber, List, Modal, Row, Segmented, Select, Space, Spin, Switch, Tabs, Tag, Tooltip, Typography } from 'antd';
import { BranchesOutlined, CaretRightOutlined, CheckCircleOutlined, CloseCircleOutlined, CommentOutlined, DeleteOutlined, DownOutlined, ExperimentOutlined, ExportOutlined, LoadingOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { api, ImpactLevel, PrDetail, PrGlance, PrImpact, PrImpactFeature, PrRepo, PrSummary, RunInfo, SelectionCheck, setPrProject , PrNewDef } from '../api';
import { errText, loadRunTarget, openInEditor, useStudio } from '../state';
import { navigate, useRoute } from '../route';
import { Split } from '../components/Split';
import { DiffView, useDiffPrefs } from '../components/DiffView';
import { DiffToolbar } from '../components/DiffToolbar';
import { ErrorAlert } from '../components/ErrorAlert';
import { AdoNotSetUp, isAdoNotSetUp } from '../datagit-common';
import { PrPostResults } from '../components/PrPostResults';
import { fmtDur } from '../components/RunTree';
import { Markdown } from '../components/Markdown';

const VOTES: Array<{ vote: number; label: string; color: string; help: string }> = [
    { vote: 10, label: 'Approve', color: 'success', help: 'The changes are good to merge.' },
    { vote: 5, label: 'Approve with suggestions', color: 'success', help: 'Good to merge; your comments are optional improvements.' },
    { vote: -5, label: 'Wait for author', color: 'warning', help: 'The author needs to change something before it can be merged.' },
    { vote: -10, label: 'Reject', color: 'error', help: 'This should not be merged.' },
    { vote: 0, label: 'Reset my vote', color: 'default', help: 'Remove your vote.' },
];
const voteTag = (v?: number) => {
    const x = VOTES.find((o) => o.vote === v);
    return !x || v === 0 ? <Tag>No vote</Tag> : <Tag color={x.color}>{x.label}</Tag>;
};
const ago = (d: string) => {
    const s = (Date.now() - Date.parse(d)) / 1000;
    return s < 3600 ? `${Math.max(1, Math.floor(s / 60))} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : s < 86400 * 30 ? `${Math.floor(s / 86400)} days ago` : new Date(d).toLocaleDateString();
};
const STATUS_LABEL: Record<string, string> = { succeeded: 'passed', failed: 'failed', error: 'error', pending: 'running', notApplicable: 'not needed', notSet: 'waiting' };
/** A branch policy's evaluation in words (a build policy: passed/failed; others: approved/rejected). */
function policyState(status: string, build: boolean): { label: string; color: string; icon: React.ReactNode } {
    if (/approved/i.test(status)) return { label: build ? 'passed' : 'approved', color: 'success', icon: <CheckCircleOutlined /> };
    if (/rejected|broken/i.test(status)) return { label: build ? 'failed' : 'not met', color: 'error', icon: <CloseCircleOutlined /> };
    if (/running/i.test(status)) return { label: 'running', color: 'processing', icon: <SyncOutlined spin /> };
    if (/notApplicable/i.test(status)) return { label: 'not needed', color: 'default', icon: null };
    return { label: build ? 'waiting' : 'waiting', color: 'warning', icon: <SyncOutlined /> };
}
const THREAD_LABEL: Record<string, string> = { active: 'Active', pending: 'Pending', fixed: 'Resolved', closed: 'Closed', wontFix: "Won't fix", byDesign: 'By design' };
const STATE_TAG: Record<string, { color: string; label: string }> = {
    running: { color: 'processing', label: 'Running' }, passed: { color: 'success', label: 'Passed' }, failed: { color: 'error', label: 'Failed' },
    stopped: { color: 'default', label: 'Stopped' }, error: { color: 'warning', label: 'Could not run' },
};

/** At most a few glance requests at a time (a page of 50 pull requests must not flood Azure DevOps). */
const glanceQueue: Array<() => void> = [];
let glanceRunning = 0;
function queued<T>(f: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const go = () => { glanceRunning++; f().then(resolve, reject).finally(() => { glanceRunning--; glanceQueue.shift()?.(); }); };
        if (glanceRunning < 4) go(); else glanceQueue.push(go);
    });
}

/** One line on a pull request's tests: can they run here, and what does it change. */
function Glance({ p }: { p: PrSummary }) {
    const [g, setG] = React.useState<PrGlance | null | 'error'>(null);
    React.useEffect(() => { let gone = false; queued(() => api.prGlance(p.repository.name, p.id, p.target)).then((x) => { if (!gone) setG(x); }).catch(() => { if (!gone) setG('error'); }); return () => { gone = true; }; }, [p.repository.name, p.id, p.target]);
    if (g === null) return <span className="glance muted"><LoadingOutlined /> checking…</span>;
    if (g === 'error') return null;
    const c = g.counts;
    const parts = [c.feature && `${c.feature} feature${c.feature === 1 ? '' : 's'}`, c.steps && `${c.steps} step file${c.steps === 1 ? '' : 's'}`, c.code && `${c.code} code`, c.config && `${c.config} config`, c.data && `${c.data} data`].filter(Boolean) as string[];
    const testsTouched = c.feature + c.steps > 0 || (g.automatedHere ?? 0) > 0;
    return (
        <span className="glance">
            {g.here
                ? <Tooltip title="This folder is a clone of its repository: you can get the pull request and run its tests here."><Tag bordered={false} color={testsTouched ? 'purple' : 'default'} icon={<ExperimentOutlined />}>{testsTouched ? 'Tests to run here' : 'Testable here'}</Tag></Tooltip>
                : <Tooltip title={`Open the Studio in a clone of ${p.repository.name} to run its tests.`}><Tag bordered={false}>Other repo</Tag></Tooltip>}
            <span className="muted">{parts.length ? parts.join(' · ') : g.files ? `${g.files} other file${g.files === 1 ? '' : 's'}` : 'no file changes'}</span>
            {g.testCases > 0 && <Tooltip title={g.automatedHere !== undefined ? `${g.automatedHere} of them automated by a scenario on ${p.target} (@TestCaseId)` : g.here ? `Fetch to see whether scenarios on ${p.target} automate them` : undefined}><span className="muted"> · {g.testCases} linked test case{g.testCases === 1 ? '' : 's'}{g.automatedHere !== undefined ? ` (${g.automatedHere} automated)` : ''}</span></Tooltip>}
        </span>
    );
}

const PAGE = 50;
const loadPref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const savePref = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
// The Azure DevOps project chosen last time, before the first request.
setPrProject(loadPref<string | undefined>('cs-studio-pr-project', undefined));

interface PrFilter { scope: 'review' | 'mine' | 'all'; status: 'active' | 'completed' | 'abandoned'; repository?: string; target?: string }


/** A pull request for the current branch: drafted from its commits, reviewers from the project's teams. */
function NewPrButton({ adoProject, onCreated }: { adoProject?: string; onCreated: () => void }) {
    const { message } = App.useApp();
    const [d, setD] = React.useState<PrNewDef | null>(null);
    const [form, setForm] = React.useState<{ repository: string; target: string; title: string; description: string; draft: boolean; reviewers: string[]; required: string[]; workItems: string }>({ repository: '', target: '', title: '', description: '', draft: false, reviewers: [], required: [], workItems: '' });
    const [busy, setBusy] = React.useState(false);
    const load = async (o: { repository?: string; target?: string } = {}) => {
        setBusy(true);
        try {
            const x = await api.prNew({ ...o, ...(adoProject ? { adoProject } : {}) });
            setD(x);
            setForm((f) => ({ ...f, repository: x.repository ?? o.repository ?? '', target: x.target ?? '', ...(x.title !== undefined ? { title: x.title, description: x.description ?? '', workItems: (x.workItems ?? []).join(', ') } : {}) }));
        } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    const create = async () => {
        setBusy(true);
        try {
            const r = await api.prCreate({ repository: form.repository, target: form.target, title: form.title, description: form.description, draft: form.draft, reviewers: form.reviewers.map((id) => ({ id, ...(form.required.includes(id) ? { required: true } : {}) })),
                workItems: form.workItems.split(/[ ,;]+/).map(Number).filter((n) => n > 0), ...(adoProject ? { adoProject } : {}) });
            message.success(<>Pull request {r.id} opened. <a href={r.url} target="_blank" rel="noreferrer">Open in Azure DevOps</a></>, 8);
            setD(null); onCreated();
        } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    return (
        <>
            <Button size="small" type="primary" loading={busy && !d} onClick={() => void load()}>New pull request</Button>
            <Modal open={!!d} title={d ? `New pull request from ${d.branch}` : ''} width={680} okText={form.draft ? 'Create as draft' : 'Create'} okButtonProps={{ disabled: !!d?.problem || !form.title.trim() || !form.repository, loading: busy }} onOk={() => void create()} onCancel={() => setD(null)}>
                {d && <Form layout="vertical" size="small">
                    {d.problem && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message={d.problem} />}
                    <Space wrap>
                        <Form.Item label="Repository"><Select style={{ width: 220 }} value={form.repository || undefined} onChange={(v) => void load({ repository: v })} options={d.repositories.map((r) => ({ value: r.name, label: r.name }))} /></Form.Item>
                        <Form.Item label="Into"><Input style={{ width: 160 }} value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} onBlur={() => form.target && form.target !== d.target && void load({ repository: form.repository, target: form.target })} /></Form.Item>
                        {d.commits !== undefined && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{d.commits} commit{d.commits === 1 ? '' : 's'}</Typography.Text>}
                    </Space>
                    <Form.Item label="Title"><Input value={form.title} maxLength={400} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Form.Item>
                    <Form.Item label="Description (Markdown)"><Input.TextArea value={form.description} autoSize={{ minRows: 4, maxRows: 12 }} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Form.Item>
                    <Form.Item label="Reviewers">
                        <Select mode="multiple" showSearch optionFilterProp="label" value={form.reviewers} onChange={(v) => setForm({ ...form, reviewers: v, required: form.required.filter((x) => v.includes(x)) })}
                            options={(d.reviewers ?? []).map((r) => ({ value: r.id, label: `${r.name}${r.email ? ` (${r.email})` : ''} · ${r.team}` }))} placeholder="People of the project's teams" />
                    </Form.Item>
                    {form.reviewers.length > 0 && <Form.Item label="Required to approve"><Checkbox.Group value={form.required} onChange={(v) => setForm({ ...form, required: v as string[] })} options={form.reviewers.map((id) => ({ value: id, label: d.reviewers?.find((r) => r.id === id)?.name ?? id }))} /></Form.Item>}
                    <Space wrap>
                        <Form.Item label="Work items"><Input style={{ width: 220 }} value={form.workItems} onChange={(e) => setForm({ ...form, workItems: e.target.value })} placeholder="1234, 1240" /></Form.Item>
                        <Form.Item label=" "><Checkbox checked={form.draft} onChange={(e) => setForm({ ...form, draft: e.target.checked })}>Draft (not ready for review yet)</Checkbox></Form.Item>
                    </Space>
                </Form>}
            </Modal>
        </>
    );
}

export function PullRequests() {
    const route = useRoute();
    const here = route[0] === 'prs';
    const sel = here && route[1] && /^\d+$/.test(route[2] ?? '') ? { repo: route[1], id: Number(route[2]) } : null;
    const [adoProject, setAdoProjectRaw] = React.useState<string | undefined>(() => loadPref<string | undefined>('cs-studio-pr-project', undefined));
    const [projects, setProjects] = React.useState<{ projects: string[]; configured: string } | null>(null);
    const [repos, setRepos] = React.useState<{ adoProject: string; repos: PrRepo[] } | null>(null);
    const [f, setFRaw] = React.useState<PrFilter>(() => ({ scope: 'review', status: 'active', ...loadPref<Partial<PrFilter>>(`cs-studio-pr-filter:${loadPref('cs-studio-pr-project', '')}`, {}) }));
    const [target, setTarget] = React.useState(f.target ?? '');
    const [list, setList] = React.useState<PrSummary[] | null>(null);
    const [more, setMore] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const [filter, setFilter] = React.useState('');
    const setF = (next: PrFilter) => { setFRaw(next); savePref(`cs-studio-pr-filter:${adoProject ?? ''}`, next); };
    const setAdoProject = (p: string | undefined) => {
        setPrProject(p); setAdoProjectRaw(p); savePref('cs-studio-pr-project', p);
        setRepos(null); setList(null);
        setFRaw({ scope: f.scope, status: f.status, ...loadPref<Partial<PrFilter>>(`cs-studio-pr-filter:${p ?? ''}`, {}) });
        if (sel) navigate(['prs']);
    };
    React.useEffect(() => { if (here && !repos) api.prRepos().then(setRepos).catch(() => { /* the list shows the error */ }); }, [here, repos, adoProject]);
    const load = React.useCallback(async (append = false) => {
        setErr(null); setLoading(true);
        try {
            const r = await api.prs({ ...f, top: PAGE, skip: append ? (list?.length ?? 0) : 0 });
            setList((x) => (append ? [...(x ?? []), ...r.prs] : r.prs)); setMore(r.more);
        } catch (e) { setErr(errText(e)); if (!append) setList([]); }
        finally { setLoading(false); }
    }, [f, list?.length]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (here) void load(); }, [f, adoProject, here]); // eslint-disable-line react-hooks/exhaustive-deps
    const shown = (list ?? []).filter((p) => !filter || `${p.id} ${p.title} ${p.repository.name} ${p.source} ${p.author.name}`.toLowerCase().includes(filter.toLowerCase()));
    const hereRepos = (repos?.repos ?? []).filter((r) => r.here);
    const project = adoProject ?? repos?.adoProject;

    // Azure DevOps not set up here: one short state with the way to set it up, not an error under empty filters.
    if (isAdoNotSetUp(err) && !list?.length) return <AdoNotSetUp what="Pull requests" error={err!} onRetry={() => void load()} />;
    return (
        <Split id="prs-list" initial={520} min={360} max={900} style={{ height: 'calc(100vh - var(--chrome))' }}>
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="toolbar" style={{ display: 'block' }}>
                    <div className="filter-row">
                        <Select showSearch size="small" style={{ width: 160 }} value={project} placeholder="Project" aria-label="Azure DevOps project"
                            onDropdownVisibleChange={(o) => { if (o && !projects) api.adoProjects().then(setProjects).catch((e) => setErr(errText(e))); }}
                            onChange={(v) => setAdoProject(v === projects?.configured ? undefined : v)}
                            options={(projects?.projects ?? (project ? [project] : [])).map((p) => ({ value: p, label: p === projects?.configured ? `${p} (from config)` : p }))} />
                        <Select showSearch allowClear size="small" style={{ width: 220 }} placeholder="All repositories" aria-label="Repository" value={f.repository}
                            onChange={(v) => setF({ ...f, repository: v })} notFoundContent={repos ? undefined : <Spin size="small" />}
                            options={[
                                ...(hereRepos.length ? [{ label: 'This folder (tests run here)', options: hereRepos.map((r) => ({ value: r.name, label: r.name })) }] : []),
                                { label: 'All repositories', options: (repos?.repos ?? []).filter((r) => !r.here).map((r) => ({ value: r.name, label: r.name })) },
                            ]} />
                        <Input size="small" allowClear style={{ width: 130 }} placeholder="Target branch" aria-label="Target branch" value={target}
                            onChange={(e) => { setTarget(e.target.value); if (!e.target.value) setF({ ...f, target: undefined }); }} onPressEnter={() => setF({ ...f, target: target.trim() || undefined })} onBlur={() => { if ((target.trim() || undefined) !== f.target) setF({ ...f, target: target.trim() || undefined }); }} />
                    </div>
                    <div className="filter-row">
                        <Segmented size="small" value={f.scope} onChange={(v) => setF({ ...f, scope: v as PrFilter['scope'] })}
                            options={[{ value: 'review', label: 'To review' }, { value: 'mine', label: 'Mine' }, { value: 'all', label: 'All' }]} />
                        <Select size="small" value={f.status} onChange={(v) => setF({ ...f, status: v })} style={{ width: 110 }} aria-label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'completed', label: 'Completed' }, { value: 'abandoned', label: 'Abandoned' }]} />
                        <Input size="small" allowClear style={{ flex: 1, minWidth: 140 }} placeholder="Find (title, branch, author, !id)" aria-label="Find in the list" value={filter} onChange={(e) => setFilter(e.target.value)} />
                        <Tooltip title="Refresh"><Button aria-label="Refresh" size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} /></Tooltip>
                        <NewPrButton adoProject={adoProject} onCreated={() => void load()} />
                    </div>
                </div>
                {err && <ErrorAlert style={{ margin: 10 }} title="Azure DevOps" error={err} />}
                <div style={{ flex: 1, overflow: 'auto' }}>
                    {list === null ? (err ? null : <Spin style={{ margin: 40 }} />) : shown.length === 0 ? (err ? null : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description={filter ? 'Nothing in this list matches.' : f.scope === 'review' ? 'No pull requests are waiting for your review here.' : 'No pull requests match.'} />) : shown.map((p) => (
                        <div key={`${p.repository.id}/${p.id}`} className={`item-row${sel?.id === p.id && sel.repo === p.repository.name ? ' selected' : ''}`}
                            onClick={() => navigate(['prs', p.repository.name, p.id])}>
                            <div className="item-title">
                                <span className="item-id">!{p.id}</span>
                                <span className="t" title={p.title}>{p.title}</span>
                                {p.isDraft && <Tag bordered={false}>Draft</Tag>}
                                {p.mergeStatus === 'conflicts' && <Tag bordered={false} color="error">Conflicts</Tag>}
                                {!!p.myVote && voteTag(p.myVote)}
                                {(() => { const ok = p.reviewers.filter((r) => !r.isMe && r.vote > 0); return ok.length ? <Tooltip title={`Approved by ${ok.map((r) => r.name).join(', ')}`}><Tag bordered={false} color="green">✓ {ok.length}</Tag></Tooltip> : null; })()}
                            </div>
                            <div className="item-meta" title={`${p.repository.name} · ${p.source} → ${p.target} · ${p.author.name}`}>
                                <span className="repo-chip">{p.repository.name}</span> {p.source} → {p.target} · {p.author.name.split(' ')[0]} · {ago(p.created)}
                            </div>
                            <div className="item-meta"><Glance p={p} /></div>
                        </div>
                    ))}
                    {more && <Button type="link" block loading={loading} onClick={() => void load(true)}>Load more pull requests</Button>}
                </div>
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
                {sel ? <PrView key={`${project}/${sel.repo}/${sel.id}`} repo={sel.repo} id={sel.id} tab={route[3]} fileArg={route[3] === 'files' ? route[4] : undefined} onChanged={() => void load()} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="Select a pull request" />}
            </div>
        </Split>
    );
}

function PrView({ repo, id, tab, fileArg, onChanged }: { repo: string; id: number; tab?: string; fileArg?: string; onChanged: () => void }) {
    const { message, modal } = App.useApp();
    const [d, setD] = React.useState<PrDetail | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const load = React.useCallback(() => { api.pr(repo, id).then(setD).catch((e) => setErr(errText(e))); }, [repo, id]);
    React.useEffect(load, [load]);
    // Runs of this pull request change while tests run: refresh now and then.
    React.useEffect(() => {
        if (!d?.runs.some((r) => r.state === 'running')) return;
        const t = setInterval(load, 4000);
        return () => clearInterval(t);
    }, [d, load]);
    const [posting, setPosting] = React.useState<string | null>(null);
    const [askVote, setAskVote] = React.useState(false);
    const [completing, setCompleting] = React.useState<'complete' | 'auto-complete' | null>(null);

    const finish = (action: 'cancel-auto-complete' | 'abandon' | 'reactivate') => modal.confirm({
        title: action === 'abandon' ? `Abandon pull request !${id}?` : action === 'reactivate' ? `Reactivate pull request !${id}?` : `Cancel auto-complete of !${id}?`,
        content: action === 'abandon' ? 'The pull request is closed without merging. It can be reactivated later.' : action === 'reactivate' ? 'The pull request is opened again for review.' : 'The pull request stays open and is no longer completed by itself when the checks pass.',
        okText: action === 'abandon' ? 'Abandon' : action === 'reactivate' ? 'Reactivate' : 'Cancel auto-complete', okButtonProps: { danger: action === 'abandon' },
        onOk: async () => { try { await api.prFinish(repo, id, { action }); message.success('Done'); load(); onChanged(); } catch (e) { message.error(errText(e)); } },
    });

    const vote = (v: (typeof VOTES)[number]) => modal.confirm({
        title: `${v.label}: pull request !${id}?`,
        content: <>{v.help}<br /><br />Your vote is shown to everyone on the pull request in Azure DevOps.</>,
        okText: v.label, okButtonProps: { danger: v.vote < 0 },
        onOk: async () => { try { await api.prVote(repo, id, v.vote); message.success(v.vote ? `Voted "${v.label}"` : 'Vote removed'); load(); onChanged(); } catch (e) { message.error(errText(e)); } },
    });

    if (err) return isAdoNotSetUp(err) ? <AdoNotSetUp compact what="Pull requests" error={err} onRetry={() => { setErr(null); load(); }} /> : <ErrorAlert style={{ margin: 12 }} title={`Could not load pull request !${id}`} error={err} />;
    if (!d) return <Spin style={{ margin: 60 }} />;
    const blocking = d.policies.filter((p) => p.blocking && !/approved/i.test(p.status));
    const lastRun = d.runs.find((r) => r.state !== 'running' && r.summary);
    const tabKey = ['overview', 'files', 'tests', 'discussion'].includes(tab ?? '') ? tab! : 'tests';
    const openThreads = d.threads.filter((t) => !t.comments[0]?.system && t.status === 'active').length;

    return (
        <div style={{ padding: 14 }}>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space wrap align="center">
                    <Typography.Title level={5} style={{ margin: 0 }}>!{d.id} {d.title}</Typography.Title>
                    {d.isDraft && <Tag>Draft</Tag>}
                    <Tag color={d.status === 'active' ? 'processing' : d.status === 'completed' ? 'success' : 'default'}>{d.status}</Tag>
                </Space>
                <Typography.Text type="secondary"><BranchesOutlined /> <Typography.Text code>{d.source}</Typography.Text> → <Typography.Text code>{d.target}</Typography.Text> · {d.repository.name} · {d.author.name} · {ago(d.created)}{d.iterations > 1 ? ` · updated ${d.iterations - 1} time${d.iterations === 2 ? '' : 's'}` : ''}</Typography.Text>
                <Space wrap>
                    <Typography.Text>Your vote:</Typography.Text> {voteTag(d.myVote)}
                    <Dropdown trigger={['click']} disabled={d.status !== 'active'} menu={{ items: VOTES.map((v) => ({ key: String(v.vote), label: <Tooltip title={v.help} placement="left">{v.label}</Tooltip>, danger: v.vote < 0 })), onClick: ({ key }) => vote(VOTES.find((v) => String(v.vote) === key)!) }}>
                        <Button type="primary">Vote <DownOutlined /></Button>
                    </Dropdown>
                    {lastRun && <Button icon={<CommentOutlined />} onClick={() => setPosting(lastRun.id)}>Post latest results</Button>}
                    {d.status === 'active' && <Dropdown.Button trigger={['click']} disabled={d.isDraft} onClick={() => setCompleting('complete')} menu={{
                        items: [d.autoComplete ? { key: 'cancel-auto-complete', label: 'Cancel auto-complete' } : { key: 'auto-complete', label: 'Set auto-complete…' }, { type: 'divider' }, { key: 'abandon', label: 'Abandon', danger: true }],
                        onClick: ({ key }) => key === 'auto-complete' ? setCompleting('auto-complete') : finish(key as 'cancel-auto-complete' | 'abandon'),
                    }}>{d.isDraft ? 'Draft: publish to complete' : 'Complete…'}</Dropdown.Button>}
                    {d.autoComplete && d.status === 'active' && <Tag color="processing">Auto-complete set</Tag>}
                    {d.status === 'abandoned' && <Button onClick={() => finish('reactivate')}>Reactivate</Button>}
                    <Button icon={<ExportOutlined />} href={d.url} target="_blank" rel="noreferrer">Open in Azure DevOps</Button>
                </Space>
                <Space wrap size={[4, 4]}>
                    {d.reviewers.map((r) => <Tag key={r.id} color={r.vote >= 5 ? 'green' : r.vote < 0 ? 'orange' : undefined}>{r.name}{r.required ? ' (required)' : ''}: {VOTES.find((v) => v.vote === r.vote && r.vote !== 0)?.label ?? 'no vote'}</Tag>)}
                </Space>
                {(d.policies.length > 0 || d.statuses.length > 0 || d.mergeStatus === 'conflicts') && (
                    <Space wrap size={[4, 4]}>
                        {d.mergeStatus === 'conflicts' && <Tag color="error">Merge conflicts: the source branch is tested</Tag>}
                        {d.policies.map((p, i) => {
                            const st = policyState(p.status, !!p.buildId);
                            return <Tooltip key={i} title={<>{p.detail ?? p.name}{p.blocking ? ' — required before it can be completed' : ' — optional'}{p.buildId ? '. Click to open the build.' : ''}</>}>
                                <Tag icon={st.icon} color={st.color} style={p.buildId ? { cursor: 'pointer' } : undefined} onClick={p.buildId ? () => navigate(['pipelines', p.buildId]) : undefined}>{p.name}: {st.label}{p.blocking ? '' : ' (optional)'}</Tag>
                            </Tooltip>;
                        })}
                        {d.statuses.map((s, i) => <Tooltip key={'s' + i} title={s.description}><Tag color={s.state === 'succeeded' ? 'success' : s.state === 'failed' || s.state === 'error' ? 'error' : s.state === 'notApplicable' ? 'default' : 'processing'}>{s.name.split('/').pop()}: {STATUS_LABEL[s.state] ?? s.state}</Tag></Tooltip>)}
                    </Space>
                )}
                {blocking.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{blocking.length} required check{blocking.length === 1 ? '' : 's'} still open.</Typography.Text>}
            </Space>
            <Tabs activeKey={tabKey} onChange={(k) => navigate(['prs', repo, id, k], true)} style={{ marginTop: 6 }} items={[
                { key: 'tests', label: <span>Tests{d.runs.length ? <Badge count={d.runs.length} size="small" color="#93186C" style={{ marginLeft: 6 }} /> : null}</span>, children: <TestsTab d={d} reload={load} onPost={setPosting} /> },
                { key: 'files', label: `Files (${d.changes.length})`, children: <FilesTab d={d} initial={fileArg} /> },
                { key: 'overview', label: 'Overview', children: <Overview d={d} /> },
                { key: 'discussion', label: <span>Discussion{openThreads ? <Badge count={openThreads} size="small" style={{ marginLeft: 6 }} /> : null}</span>, children: <Discussion d={d} reload={load} /> },
            ]} />
            <CompletePr repo={repo} d={d} mode={completing} onClose={() => setCompleting(null)} onDone={() => { setCompleting(null); load(); onChanged(); }} blocking={blocking.length} />
            <PrPostResults repo={repo} id={id} run={posting} open={!!posting} onClose={() => setPosting(null)} onPosted={() => { load(); if (d.status === 'active') setAskVote(true); }} />
            <Modal open={askVote} title="Vote now?" footer={null} onCancel={() => setAskVote(false)}>
                <Typography.Paragraph>The results are on the pull request. Approve it, or ask the author to change something.</Typography.Paragraph>
                <Space wrap>{VOTES.filter((v) => v.vote !== 0).map((v) => <Button key={v.vote} danger={v.vote < 0} type={v.vote === 10 ? 'primary' : 'default'} onClick={() => { setAskVote(false); vote(v); }}>{v.label}</Button>)}
                    <Button type="text" onClick={() => setAskVote(false)}>Later</Button></Space>
            </Modal>
        </div>
    );
}

function Overview({ d }: { d: PrDetail }) {
    return (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Card size="small" title="Description">{d.description ? <Markdown text={d.description} /> : <Typography.Text type="secondary">No description.</Typography.Text>}</Card>
            <Card size="small" title={`Linked work items (${d.workItemDetails.length})`}>
                {d.workItemDetails.length === 0 ? <Typography.Text type="secondary">None. Link the story or bug in Azure DevOps to see its test cases here.</Typography.Text> : (
                    <List size="small" dataSource={d.workItemDetails} renderItem={(w) => (
                        <List.Item style={{ cursor: 'pointer' }} onClick={() => navigate(['work', w.id])}>
                            <Space><Tag>{w.type}</Tag><Typography.Text strong>#{w.id}</Typography.Text>{w.title}<Tag color="blue">{w.state}</Tag></Space>
                        </List.Item>
                    )} />
                )}
                {d.testCaseIds.length > 0 && <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>Test cases: {d.testCaseIds.map((t) => `#${t}`).join(', ')} (their automated scenarios are suggested under Tests).</Typography.Paragraph>}
            </Card>
            <Descriptions size="small" column={1} bordered items={[
                { key: 's', label: 'Source commit', children: <Typography.Text code>{d.commits.source?.slice(0, 10)}</Typography.Text> },
                { key: 't', label: 'Target commit', children: <Typography.Text code>{d.commits.target?.slice(0, 10)}</Typography.Text> },
                { key: 'm', label: 'Merge result', children: d.commits.merge ? <Typography.Text code>{d.commits.merge.slice(0, 10)}</Typography.Text> : <Typography.Text type="secondary">none (conflicts)</Typography.Text> },
            ]} />
        </Space>
    );
}

/** Chosen when the suggestions come: tied to the change. 'steps' (wider) and 'recent' are offered. */
const SUGGESTED: ImpactLevel[] = ['direct', 'code', 'data', 'coverage'];
const GROUPS: Array<{ level: ImpactLevel; title: string; help: string }> = [
    { level: 'direct', title: 'Directly affected', help: 'Features this pull request changes, and scenarios of its linked test cases.' },
    { level: 'code', title: 'Use changed code', help: 'Their steps use a changed page object or helper (imported, or a page found by name).' },
    { level: 'data', title: 'Use changed data', help: 'They name a changed data file.' },
    { level: 'coverage', title: 'Seen in recorded runs', help: 'A recorded run of these scenarios loaded a changed file (the framework\'s IMPACT_COLLECT data).' },
    { level: 'steps', title: 'Also use changed steps', help: 'Features of projects that load the changed step files and use a changed step: wider regression.' },
    { level: 'recent', title: 'Failing recently', help: 'Their latest run failed: likely to fail again whatever the change.' },
];

function TestsTab({ d, reload, onPost }: { d: PrDetail; reload: () => void; onPost: (run: string) => void }) {
    const { message, modal } = App.useApp();
    const { env: disc } = useStudio();
    const [busy, setBusy] = React.useState(false);
    const [impact, setImpact] = React.useState<PrImpact | null>(null);
    const [checkout, setCheckout] = React.useState(d.local.checkout);
    const [picked, setPicked] = React.useState<Set<string>>(new Set());
    const saved = loadRunTarget();
    const projects = disc?.projects ?? [];
    const [opts, setOpts] = React.useState({ env: saved?.env ?? 'dev', browser: saved?.browser ?? 'chromium', headless: saved?.headless ?? true, workers: saved?.workers ?? 1 });
    const [starting, setStarting] = React.useState<string | null>(null);
    const [showAll, setShowAll] = React.useState<Set<string>>(new Set());
    const [observe, setObserve] = React.useState(false);
    const [fullProject, setFullProject] = React.useState<string | undefined>(undefined);

    const getLocally = async () => {
        setBusy(true);
        try {
            const r = await api.prCheckout(d.repository.name, d.id, d.testCaseIds);
            setCheckout(r.checkout); setImpact(r.impact);
            setPicked(new Set(r.impact.features.filter((f) => SUGGESTED.includes(f.level)).map((f) => f.path)));
            for (const n of r.checkout.notes ?? []) message.info(n, 6);
            reload();
        } catch (e) { modal.error({ title: 'Could not get the pull request', content: errText(e) }); }
        finally { setBusy(false); }
    };
    // A copy from earlier: work out the suggestions again (this also brings it up to date).
    React.useEffect(() => { if (d.local.checkout && !impact && d.local.canTest && d.status === 'active') void getLocally(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    if (d.status !== 'active') {
        return <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="info" showIcon message={`This pull request is ${d.status}`} description={d.status === 'completed' ? `Its changes are in ${d.target}: test that branch from Run tests.` : 'There is nothing to test.'} />
            {d.runs.length > 0 && <Typography.Text type="secondary">Earlier runs of this pull request: {d.runs.map((r) => <Button key={r.id} size="small" type="link" onClick={() => navigate(['runs', r.id])}>{new Date(r.startedAt).toLocaleString()}</Button>)}</Typography.Text>}
        </Space>;
    }
    if (!d.local.canTest) {
        return <Alert type="info" showIcon message="Its tests cannot run in this project"
            description={<>This pull request is for the repository <b>{d.repository.name}</b>; the project open in the Studio is a different repository. Start the Studio in a clone of {d.repository.name} to run its tests. You can still read it, comment and vote here.</>} />;
    }
    const sel = (impact?.features ?? []).filter((f) => picked.has(f.path));
    const byProject = new Map<string, PrImpactFeature[]>();
    for (const f of sel) { const p = f.project ?? (saved?.project && projects.includes(saved.project) ? saved.project : projects[0] ?? ''); byProject.set(p, [...(byProject.get(p) ?? []), f]); }
    /** No features: every test of the project. Observe: every test, the chosen ones kept to check the choice. */
    const run = async (project: string, feats: PrImpactFeature[], watch = false) => {
        setStarting(project);
        try {
            // Whole features, plus single scenarios where only a test case's scenario is wanted.
            const onlyScenarios = feats.length > 0 && feats.every((f) => f.scenarios.length > 0);
            const r = await api.prRun(d.repository.name, d.id, {
                project, env: opts.env, browser: opts.browser, headless: opts.headless, workers: opts.workers, title: d.title,
                ...(feats.length ? { features: feats.map((f) => f.path) } : {}), ...(onlyScenarios ? { scenarios: [...new Set(feats.flatMap((f) => f.scenarios))] } : {}),
                ...(watch ? { observe: true } : {}),
            });
            navigate(['runs', r.id]);
        } catch (e) { modal.error({ title: 'Could not start the tests', content: errText(e) }); }
        finally { setStarting(null); }
    };
    const group = (level: ImpactLevel) => (impact?.features ?? []).filter((f) => f.level === level);
    const postStatus = (runId: string) => modal.confirm({
        title: 'Post the result as a status of the pull request?',
        content: 'Azure DevOps shows it with the build checks as cs-test-studio/tests (a branch policy can require it). A later post replaces it.',
        okText: 'Post status',
        onOk: async () => {
            try { const st = await api.prStatus(d.repository.name, d.id, runId); message.success(`Posted: ${st.state}, ${st.description}`); }
            catch (e) { modal.error({ title: 'Could not post the status', content: errText(e) }); }
        },
    });
    const toggle = (paths: string[], on: boolean) => setPicked((s) => { const n = new Set(s); for (const p of paths) { if (on) n.add(p); else n.delete(p); } return n; });
    const FeatureRow = ({ f }: { f: PrImpactFeature }) => (
        <div style={{ display: 'flex', gap: 8, padding: '4px 0', alignItems: 'flex-start' }}>
            <Checkbox checked={picked.has(f.path)} onChange={(e) => toggle([f.path], e.target.checked)} />
            <div style={{ minWidth: 0 }}>
                <Typography.Text strong>{f.path.split('/').pop()}</Typography.Text> <Typography.Text type="secondary" style={{ fontSize: 12 }}>{f.name} · {f.project ?? 'no project folder'} · {f.scenarios.length ? `${f.scenarios.length} of ${f.total} scenarios` : `${f.total} scenario${f.total === 1 ? '' : 's'}`}</Typography.Text>
                {f.reasons.map((r) => <div key={r} style={{ fontSize: 12, opacity: .7 }}>• {r}</div>)}
                {f.scenarios.length > 0 && <div style={{ fontSize: 12 }}>Only: {f.scenarios.join(', ')}</div>}
            </div>
        </div>
    );

    return (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Card size="small" title="1. Get the pull request locally"
                extra={checkout && <Tooltip title="Remove the local copy of this pull request"><Button aria-label="Remove the local copy of this pull request" size="small" type="text" icon={<DeleteOutlined />} onClick={async () => { await api.prRemoveCheckout(d.repository.name, d.id); setCheckout(null); setImpact(null); reload(); }} /></Tooltip>}>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>The {d.mergeStatus === 'conflicts' ? 'source branch' : 'merge result (what will land in ' + d.target + ')'} is put in its own folder next to your project. Your branch and your unsaved work are not touched; the installed packages are shared.</Typography.Text>
                    <Space wrap>
                        <Button type={checkout ? 'default' : 'primary'} loading={busy} icon={<SyncOutlined />} onClick={getLocally}>{checkout ? 'Update to the latest version' : 'Get it locally'}</Button>
                        {checkout && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Local copy at <Typography.Text code>{checkout.commit.slice(0, 8)}</Typography.Text>{checkout.based ? ` (${checkout.based === 'merge' ? 'merge result' : 'source branch'})` : ''}</Typography.Text>}
                    </Space>
                </Space>
            </Card>

            {impact && (
                <Card size="small" title="2. Choose the tests"
                    extra={<Space><Button size="small" onClick={() => setPicked(new Set(impact.features.filter((f) => SUGGESTED.includes(f.level)).map((f) => f.path)))}>Suggested</Button><Button size="small" onClick={() => toggle(impact.features.map((f) => f.path), true)}>Everything affected</Button><Button size="small" type="text" onClick={() => setPicked(new Set())}>None</Button></Space>}>
                    {impact.fullSuite.length > 0 && <Alert style={{ marginBottom: 10 }} type="warning" showIcon message="Run the full suite"
                        description={<>{impact.fullSuite.map((r) => <div key={r}>• {r}</div>)}<div style={{ marginTop: 4 }}>The tests below are tied to the change; the rest may be affected too.</div></>} />}
                    {impact.features.length === 0 && <Alert type="info" showIcon message="No feature is tied to these changes" description="The pull request changes no feature file, no step or code a feature uses, no data file a feature names, and links no automated test case. Run the tests you judge relevant from Run tests." />}
                    {GROUPS.filter((g) => group(g.level).length > 0).map((g, i) => {
                        const items = group(g.level);
                        const all = showAll.has(g.level) || items.length <= 5;
                        return <div key={g.level} style={{ marginTop: i ? 10 : 0 }}>
                            <Typography.Text strong>{g.title} ({items.length})</Typography.Text>
                            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{g.help}</Typography.Text>
                            {(all ? items : items.slice(0, 5)).map((f) => <FeatureRow key={f.path} f={f} />)}
                            {items.length > 5 && <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => setShowAll((x) => { const n = new Set(x); if (n.has(g.level)) n.delete(g.level); else n.add(g.level); return n; })}>{showAll.has(g.level) ? 'Show fewer' : `Show all ${items.length}`}</Button>}
                        </div>;
                    })}
                    {impact.testCases.filter((t) => t.scenarios.length === 0).length > 0 && <Alert style={{ marginTop: 8 }} type="warning" showIcon message={`Linked test case${impact.testCases.filter((t) => !t.scenarios.length).length === 1 ? '' : 's'} without an automated scenario: ${impact.testCases.filter((t) => !t.scenarios.length).map((t) => '#' + t.id).join(', ')}`} description="No scenario is tagged @TestCaseId with it: test it by hand, or automate it." />}
                    {impact.other.length > 0 && <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>Also changed, tied to no feature: {impact.other.join(', ')}</Typography.Paragraph>}
                    {impact.deletedFeatures.length > 0 && <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>Removed features: {impact.deletedFeatures.join(', ')}</Typography.Paragraph>}
                </Card>
            )}

            {impact && (sel.length > 0 || impact.fullSuite.length > 0) && (
                <Card size="small" title="3. Run">
                    <Form layout="vertical" size="small">
                        <Row gutter={8}>
                            <Col span={6}><Form.Item label="Environment" htmlFor="cs-pr-env" style={{ marginBottom: 8 }}><Select id="cs-pr-env" value={opts.env} onChange={(v) => setOpts({ ...opts, env: v })} options={[...new Set(Object.values(disc?.environments ?? {}).flat())].map((e) => ({ value: e, label: e }))} /></Form.Item></Col>
                            <Col span={7}><Form.Item label="Browser" htmlFor="cs-pr-browser" style={{ marginBottom: 8 }}><Select id="cs-pr-browser" value={opts.browser} onChange={(v) => setOpts({ ...opts, browser: v })} options={['chromium', 'chrome', 'msedge', 'firefox', 'webkit'].map((b) => ({ value: b, label: b }))} /></Form.Item></Col>
                            <Col span={5}><Form.Item label="Workers" htmlFor="cs-pr-workers" style={{ marginBottom: 8 }}><InputNumber id="cs-pr-workers" min={1} max={16} value={opts.workers} onChange={(v) => setOpts({ ...opts, workers: v ?? 1 })} style={{ width: '100%' }} /></Form.Item></Col>
                            <Col span={6}><Form.Item label="Show browser" style={{ marginBottom: 8 }}><Switch checked={!opts.headless} onChange={(v) => setOpts({ ...opts, headless: !v })} /></Form.Item></Col>
                        </Row>
                    </Form>
                    {sel.length > 0 && <Checkbox style={{ marginBottom: 8 }} checked={observe} onChange={(e) => setObserve(e.target.checked)}>
                        Run every test and check the choice <Typography.Text type="secondary" style={{ fontSize: 12 }}>(observation: shows whether the chosen tests alone would have caught every failure)</Typography.Text>
                    </Checkbox>}
                    {[...byProject].map(([project, feats]) => (
                        <Space key={project} style={{ marginBottom: 6, display: 'flex' }} wrap>
                            <Button type="primary" icon={<CaretRightOutlined />} loading={starting === project} disabled={!!starting || d.runs.some((r) => r.state === 'running')} onClick={() => run(project, feats, observe)}>
                                {observe ? `Run every test${byProject.size > 1 ? ` of ${project}` : ''}, check the ${feats.length} chosen` : `Run ${feats.length} feature${feats.length === 1 ? '' : 's'}${byProject.size > 1 ? ` of ${project}` : ''}`}
                            </Button>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>project {project}, environment {opts.env}</Typography.Text>
                        </Space>
                    ))}
                    {impact.fullSuite.length > 0 && !observe && (() => {
                        const target = fullProject ?? [...byProject.keys()][0] ?? (saved?.project && projects.includes(saved.project) ? saved.project : projects[0]);
                        return <Space style={{ display: 'flex' }} wrap>
                            <Button icon={<CaretRightOutlined />} loading={!!target && starting === target} disabled={!target || !!starting || d.runs.some((r) => r.state === 'running')} onClick={() => void run(target!, [])}>Run every test of</Button>
                            <Select size="small" aria-label="Project to run in full" style={{ minWidth: 140 }} value={target} onChange={setFullProject} options={projects.map((p) => ({ value: p, label: p }))} />
                        </Space>;
                    })()}
                    {byProject.size > 1 && <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>The chosen features belong to {byProject.size} projects; each project runs separately.</Typography.Text>}
                </Card>
            )}

            {d.runs.length > 0 && (
                <Card size="small" title="Runs of this pull request">
                    <List size="small" dataSource={d.runs} renderItem={(r: RunInfo & { check?: SelectionCheck | null }) => (
                        <List.Item actions={[
                            <Button key="o" size="small" onClick={() => navigate(['runs', r.id])}>Open</Button>,
                            ...(r.summary ? [<Button key="p" size="small" icon={<CommentOutlined />} onClick={() => onPost(r.id)}>Post to PR</Button>] : []),
                            ...(r.state !== 'running' ? [<Button key="s" size="small" onClick={() => postStatus(r.id)}>Post status</Button>] : []),
                        ]}>
                            <Space wrap size={6}>
                                <Tag color={STATE_TAG[r.state].color} icon={r.state === 'running' ? <LoadingOutlined /> : undefined}>{STATE_TAG[r.state].label}</Tag>
                                {r.summary && <Typography.Text>{r.summary.passed} passed, {r.summary.failed} failed</Typography.Text>}
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.request.project} / {r.request.env} · {new Date(r.startedAt).toLocaleString()}{r.endedAt ? ` · ${fmtDur(Date.parse(r.endedAt) - Date.parse(r.startedAt))}` : ''} · {r.pr?.commit.slice(0, 8)}</Typography.Text>
                                {checkout && r.pr && r.pr.commit !== checkout.commit && <Tooltip title="The pull request changed after this run"><Tag color="orange">older version</Tag></Tooltip>}
                                {r.pr?.selection && !r.pr.selection.observe && <Tag>{r.pr.selection.features.length} chosen feature{r.pr.selection.features.length === 1 ? '' : 's'}</Tag>}
                                {r.check && (r.check.missed.length
                                    ? <Tooltip title={r.check.missed.map((m) => `${m.feature} › ${m.scenario}`).join('\n')}><Tag color="red">choice would have missed {r.check.missed.length} failure{r.check.missed.length === 1 ? '' : 's'}</Tag></Tooltip>
                                    : <Tag color="green">choice caught {r.check.failed ? `all ${r.check.failed} failure${r.check.failed === 1 ? '' : 's'}` : 'every failure'}</Tag>)}
                            </Space>
                        </List.Item>
                    )} />
                </Card>
            )}
        </Space>
    );
}

function FilesTab({ d, initial }: { d: PrDetail; initial?: string }) {
    const [file, setFile] = React.useState<string | null>(initial ?? d.changes[0]?.path ?? null);
    React.useEffect(() => { if (initial) setFile(initial); }, [initial]);
    const changed = !!file && d.changes.some((c) => c.path === file);
    const [diff, setDiff] = React.useState<string | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [prefs, setPrefs] = useDiffPrefs();
    const co = d.local.checkout;
    React.useEffect(() => {
        setDiff(null); setErr(null);
        if (!file || !co || !d.commits.target || !changed) return;
        api.prDiff(d.repository.name, d.id, d.commits.target, co.commit, file, d.changes.find((c) => c.path === file)?.originalPath).then((r) => setDiff(r.diff)).catch((e) => setErr(errText(e)));
    }, [file, co?.commit]); // eslint-disable-line react-hooks/exhaustive-deps
    return (
        <div style={{ display: 'flex', height: 'calc(100vh - var(--chrome) - 250px)', minHeight: 300 }}>
            <Split id="pr-files" initial={280} min={180} max={600}>
                <div style={{ overflow: 'auto', flex: 1 }}>
                    {d.changes.map((c) => (
                        <div key={c.path} className={`file-row${file === c.path ? ' selected' : ''}`} onClick={() => setFile(c.path)} title={c.path}>
                            <Tag color={/add/.test(c.changeType) ? 'green' : /delete/.test(c.changeType) ? 'red' : 'blue'} style={{ marginInlineEnd: 0 }}>{/add/.test(c.changeType) ? 'A' : /delete/.test(c.changeType) ? 'D' : /rename/.test(c.changeType) ? 'R' : 'M'}</Tag>
                            <span className="name">{c.path.split('/').pop()}<span className="dir">{c.originalPath ? `from ${c.originalPath}` : c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''}</span></span>
                        </div>
                    ))}
                </div>
                <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
                    {file && !changed ? <Alert style={{ margin: 12 }} type="info" showIcon message={`${file} is not changed by this pull request`}
                        description={<>It is the same as in {d.target}. <Button size="small" onClick={() => openInEditor(file)}>Open your project's copy</Button></>} />
                    : !co ? <Alert style={{ margin: 12 }} type="info" showIcon message="Get the pull request locally (Tests tab) to see its changes here" description={<a href={`${d.url}?_a=files`} target="_blank" rel="noreferrer">Or see them in Azure DevOps</a>} />
                        : err ? <Alert style={{ margin: 12 }} type="error" showIcon message={err} />
                            : <>
                                <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--panel-border)' }}><DiffToolbar prefs={prefs} onChange={setPrefs} /></div>
                                {diff === null ? <Spin style={{ margin: 40 }} />
                                    : !/^@@/m.test(diff) && /^rename from /m.test(diff) ? <Alert style={{ margin: 12 }} type="info" showIcon message={`Renamed from ${d.changes.find((c) => c.path === file)?.originalPath ?? 'another name'}, without other changes`} />
                                    : !diff.trim() ? <Alert style={{ margin: 12 }} type="info" showIcon message="No changes in this file's content (for example only its file mode changed)." />
                                    : <DiffView diff={diff} mode={prefs.mode} />}
                            </>}
                </div>
            </Split>
        </div>
    );
}

function Discussion({ d, reload }: { d: PrDetail; reload: () => void }) {
    const { message, modal } = App.useApp();
    const [text, setText] = React.useState('');
    const [replies, setReplies] = React.useState<Record<number, string>>({});
    const [showSystem, setShowSystem] = React.useState(false);
    const threads = d.threads.filter((t) => showSystem || !t.comments[0]?.system);
    // Shown at once; the pull request is read again in the background.
    const [statusOf, setStatusOf] = React.useState<Record<number, string>>({});
    const act = async (fn: () => Promise<unknown>, done: string, after?: () => void) => { try { await fn(); after?.(); message.success(done); reload(); } catch (e) { message.error(errText(e)); } };
    const post = () => modal.confirm({
        title: 'Post this comment?', content: 'Everyone on the pull request sees it.', okText: 'Post',
        onOk: () => act(async () => { await api.prComment(d.repository.name, d.id, text); setText(''); }, 'Comment posted'),
    });
    return (
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <Card size="small">
                <Input.TextArea value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 2, maxRows: 8 }} placeholder="Write a comment for the pull request (Markdown)" aria-label="New comment" />
                <Space style={{ marginTop: 6 }}><Button type="primary" disabled={!text.trim()} onClick={post}>Comment</Button>
                    <Checkbox checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)}>Show updates (pushes, votes)</Checkbox></Space>
            </Card>
            {threads.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No comments yet." />}
            {threads.map((t0) => { const t = { ...t0, status: statusOf[t0.id] ?? t0.status }; return (
                <Card key={t.id} size="small" title={<Space size={6}>{t.file ? <Typography.Text code>{t.file}{t.line ? `:${t.line}` : ''}</Typography.Text> : <Typography.Text type="secondary">General</Typography.Text>}
                    {!t.comments[0]?.system && <Tag color={t.status === 'active' || t.status === 'pending' ? 'orange' : 'green'}>{THREAD_LABEL[t.status] ?? 'Closed'}</Tag>}</Space>}
                    extra={!t.comments[0]?.system && <Button size="small" type="link" onClick={() => { const next = t.status === 'active' ? 'fixed' : 'active'; void act(() => api.prThread(d.repository.name, d.id, t.id, { status: next }), next === 'fixed' ? 'Resolved' : 'Reopened', () => setStatusOf({ ...statusOf, [t.id]: next })); }}>{t.status === 'active' ? 'Resolve' : 'Reopen'}</Button>}>
                    {t.comments.map((c, i) => (
                        <div key={i} style={{ marginBottom: 6 }}>
                            <Typography.Text strong style={{ fontSize: 12 }}>{c.author}</Typography.Text> <Typography.Text type="secondary" style={{ fontSize: 11 }}>{c.date ? new Date(c.date).toLocaleString() : ''}</Typography.Text>
                            <Markdown text={c.content} />
                        </div>
                    ))}
                    {!t.comments[0]?.system && <Space.Compact style={{ width: '100%' }}>
                        <Input size="small" placeholder="Reply" aria-label={`Reply to thread ${t.id}`} value={replies[t.id] ?? ''} onChange={(e) => setReplies({ ...replies, [t.id]: e.target.value })} />
                        <Button size="small" disabled={!(replies[t.id] ?? '').trim()} onClick={() => act(async () => { await api.prThread(d.repository.name, d.id, t.id, { reply: replies[t.id] }); setReplies({ ...replies, [t.id]: '' }); }, 'Reply posted')}>Reply</Button>
                    </Space.Compact>}
                </Card>
            ); })}
        </Space>
    );
}

/** Complete a pull request now, or set it to complete by itself once the required checks pass. */
function CompletePr({ repo, d, mode, onClose, onDone, blocking }: { repo: string; d: PrDetail; mode: 'complete' | 'auto-complete' | null; onClose: () => void; onDone: () => void; blocking: number }) {
    const { message } = App.useApp();
    const [o, setO] = React.useState({ strategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true, message: '' });
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => { if (mode) setO({ strategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true, message: `Merged PR ${d.id}: ${d.title}` }); }, [mode, d.id, d.title]);
    const go = async () => {
        setBusy(true);
        try {
            const r = await api.prFinish(repo, d.id, { action: mode!, ...o, message: o.message.trim() || undefined, expectedCommit: d.commits.source });
            message.success(mode === 'complete' ? (r.status === 'completed' ? 'Pull request completed' : `Completing (${r.status})`) : 'Auto-complete set: it completes when the required checks pass');
            onDone();
        } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    return (
        <Modal open={!!mode} title={mode === 'auto-complete' ? `Set auto-complete: !${d.id}` : `Complete pull request !${d.id}`} onCancel={onClose} onOk={go} confirmLoading={busy}
            okText={mode === 'auto-complete' ? 'Set auto-complete' : 'Complete merge'} okButtonProps={{ disabled: mode === 'complete' && d.mergeStatus === 'conflicts' }}>
            {mode === 'complete' && d.mergeStatus === 'conflicts' && <Alert type="error" showIcon style={{ marginBottom: 10 }} message="The branches have merge conflicts. Resolve them first." />}
            {mode === 'complete' && blocking > 0 && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message={`${blocking} required check${blocking === 1 ? ' is' : 's are'} still open. Azure DevOps refuses to complete unless you may override them; use auto-complete instead.`} />}
            <Form layout="vertical">
                <Form.Item label="Merge type">
                    <Select value={o.strategy} onChange={(v) => setO({ ...o, strategy: v })} options={[
                        { value: 'squash', label: 'Squash commit' }, { value: 'noFastForward', label: 'Merge (no fast-forward)' },
                        { value: 'rebase', label: 'Rebase and fast-forward' }, { value: 'rebaseMerge', label: 'Semi-linear merge' }]} />
                </Form.Item>
                <Form.Item label="Commit message"><Input.TextArea rows={2} value={o.message} onChange={(e) => setO({ ...o, message: e.target.value })} /></Form.Item>
                <Checkbox checked={o.deleteSourceBranch} onChange={(e) => setO({ ...o, deleteSourceBranch: e.target.checked })}>Delete {d.source} after merging</Checkbox><br />
                <Checkbox checked={o.transitionWorkItems} onChange={(e) => setO({ ...o, transitionWorkItems: e.target.checked })}>Complete the linked work items</Checkbox>
            </Form>
            <Typography.Paragraph type="secondary" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>Only the commit you reviewed is merged: if someone pushed since, nothing is merged and you are asked to reload.</Typography.Paragraph>
        </Modal>
    );
}
