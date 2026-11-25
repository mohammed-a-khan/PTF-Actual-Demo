/**
 * Azure DevOps pipelines, for small and large organizations:
 *  - choose the ADO project; find a pipeline by name or folder (thousands of pipelines); filter
 *    runs by branch, result or "started by me"; page through them;
 *  - a run's stages (build, deploy, test stages; approvals waiting; retries; skipped);
 *  - test results per stage: the framework's reports in the run's artifacts (Feature → Scenario →
 *    Step → Action) and test runs published to Azure DevOps (PublishTestResults / framework);
 *  - steps (stage → job → task) with logs (long logs: the end), artifacts; start a run (asks first).
 */
import React from 'react';
import { Alert, App, Button, Collapse, Empty, Input, Modal, Segmented, Select, Space, Spin, Switch, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CaretRightOutlined, ClockCircleOutlined, DownOutlined, ExportOutlined, InfoCircleOutlined, ReloadOutlined, RightOutlined, SyncOutlined } from '@ant-design/icons';
import { api, PipelineDef, PipelineResults, PipelineRun, PipelineRunDetail, PublishedTestResult, PublishedTestRun, ScenarioResult, StageSummary, TimelineNode } from '../api';
import { navigate, useRoute } from '../route';
import { ErrorAlert } from '../components/ErrorAlert';
import { AdoNotSetUp, isAdoNotSetUp } from '../datagit-common';
import { errText, openInEditor, useStudio } from '../state';
import { RunTree, StatusIcon, fmtDur } from '../components/RunTree';
import { Ansi } from '../components/Ansi';
import { ago, firstName, shortRef } from '../format';

const dur = (a?: string, b?: string) => (a && b ? fmtDur(Date.parse(b) - Date.parse(a)) : '');
const runStatus = (r: { status: string; result?: string }) => r.status !== 'completed' ? r.status : r.result ?? 'unknown';
const statusTag = (r: { status: string; result?: string }) => {
    const s = runStatus(r);
    const color = s === 'succeeded' ? 'success' : s === 'failed' ? 'error' : s === 'partiallySucceeded' ? 'warning' : s === 'canceled' ? 'default' : 'processing';
    return <Tag color={color} style={{ marginInlineEnd: 0 }}>{s === 'partiallySucceeded' ? 'partially succeeded' : s === 'inProgress' ? 'running' : s}</Tag>;
};
/** A run's state as one icon (lists). */
const runIcon = (r: { status: string; result?: string }) => {
    const s = runStatus(r);
    const label = s === 'partiallySucceeded' ? 'partially succeeded' : s === 'inProgress' ? 'running' : s;
    const icon = s === 'inProgress' || s === 'notStarted' ? <SyncOutlined spin={s === 'inProgress'} style={{ color: '#1677ff' }} />
        : <StatusIcon status={s === 'succeeded' ? 'passed' : s === 'failed' ? 'failed' : s === 'canceled' ? 'not run' : 'warning'} size={14} />;
    return <Tooltip title={label}><span style={{ display: 'inline-flex', flex: 'none' }}>{icon}</span></Tooltip>;
};
const nodeStatus = (n: { state: string; result?: string }) => n.state !== 'completed' ? (n.state === 'inProgress' ? 'running' : 'not run') : n.result === 'succeeded' ? 'passed' : n.result === 'failed' ? 'failed' : n.result ?? 'skipped';
const mb = (n?: number) => (n === undefined ? '' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(n >= 10 * 1024 ** 2 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** Stage strip: Build → Deploy DEV → Test DEV → … with approvals, retries and skips. */
function StageStrip({ stages }: { stages: StageSummary[] }) {
    if (stages.length <= 1) return null;
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            {stages.map((s, i) => (
                <React.Fragment key={s.id}>
                    {i > 0 && <RightOutlined style={{ fontSize: 10, color: 'var(--gutter)' }} />}
                    <Tooltip title={<>{s.name}: {s.waiting ? 'waiting for an approval or check' : nodeStatus(s)}{s.retried ? ` (attempt ${s.attempt})` : ''}{s.started && s.finished ? ` · ${dur(s.started, s.finished)}` : ''}</>}>
                        <span className={`stage-chip ${s.waiting ? 'waiting' : nodeStatus(s).replace(' ', '-')}`}>
                            {s.waiting ? <ClockCircleOutlined style={{ color: '#d48806' }} /> : <StatusIcon status={nodeStatus(s)} size={12} />}
                            <span>{s.name}</span>
                            {s.retried && <Tag color="blue" style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}><SyncOutlined /> {s.attempt}</Tag>}
                        </span>
                    </Tooltip>
                </React.Fragment>
            ))}
        </div>
    );
}

function StepsView({ runId, timeline, adoProject }: { runId: number; timeline: TimelineNode[]; adoProject?: string }) {
    const { message } = App.useApp();
    // Small pipelines open fully; large ones (many stages) open only what failed.
    const [open, setOpen] = React.useState<Set<string>>(() => {
        const stages = timeline.filter((n) => n.type === 'Stage');
        if (stages.length <= 3) return new Set(timeline.filter((n) => n.type !== 'Task').map((n) => n.id));
        const failed = new Set(stages.filter((n) => n.result === 'failed').map((n) => n.id));
        // …and the jobs inside a failed stage.
        for (const n of timeline) if (n.type !== 'Task' && n.parentId && failed.has(n.parentId)) failed.add(n.id);
        return failed;
    });
    const [log, setLog] = React.useState<{ title: string; text: string; truncated: boolean; totalLines?: number } | null>(null);
    const kidsOf = React.useMemo(() => {
        const m = new Map<string | null, TimelineNode[]>();
        for (const n of timeline) { const k = n.parentId && timeline.some((x) => x.id === n.parentId) ? n.parentId : null; if (!m.has(k)) m.set(k, []); m.get(k)!.push(n); }
        for (const l of m.values()) l.sort((a, b) => a.order - b.order);
        return m;
    }, [timeline]);
    const showLog = async (n: TimelineNode) => {
        if (!n.logId) return;
        try { const l = await api.pipelineLog(runId, n.logId, adoProject); setLog({ title: n.name, ...l }); } catch (e) { message.error(errText(e)); }
    };
    const row = (n: TimelineNode, depth: number): React.ReactNode => {
        const kids = kidsOf.get(n.id) ?? [];
        const isOpen = open.has(n.id);
        return (
            <div key={n.id}>
                <div className={`run-step-head pl-row${n.result === 'failed' ? ' failed' : ''}`} style={{ paddingLeft: 8 + depth * 18, cursor: kids.length || n.logId ? 'pointer' : 'default' }}
                    onClick={() => { if (kids.length) setOpen((o) => { const s = new Set(o); if (s.has(n.id)) s.delete(n.id); else s.add(n.id); return s; }); else void showLog(n); }}>
                    <span className="run-caret">{kids.length ? (isOpen ? <DownOutlined /> : <RightOutlined />) : null}</span>
                    <StatusIcon status={nodeStatus(n)} />
                    <span className="run-step-text">{n.type !== 'Task' && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{n.type === 'Phase' ? 'Job' : n.type} </Typography.Text>}{n.name}</span>
                    {n.errors > 0 && <Tag color="error">{n.errors} error{n.errors === 1 ? '' : 's'}</Tag>}
                    {n.warnings > 0 && <Tag color="warning">{n.warnings} warning{n.warnings === 1 ? '' : 's'}</Tag>}
                    {n.logId && <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={(e) => { e.stopPropagation(); void showLog(n); }}>Log</Button>}
                    <span className="run-dur">{dur(n.started, n.finished)}</span>
                </div>
                {n.issues.length > 0 && <div style={{ paddingLeft: 44 + depth * 18 }}>{n.issues.slice(0, 5).map((i, k) => <div key={k}><Typography.Text type={i.type === 'error' ? 'danger' : 'warning'} style={{ fontSize: 12 }}>{i.message}</Typography.Text></div>)}</div>}
                {isOpen && kids.map((k) => row(k, depth + 1))}
            </div>
        );
    };
    return (
        <div className="run-tree">
            {(kidsOf.get(null) ?? []).map((n) => row(n, 0))}
            <Modal open={!!log} title={log?.title} width={1100} footer={null} onCancel={() => setLog(null)}>
                {log && <>
                    {log.truncated && <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`Long log: showing the last part${log.totalLines ? ` (of ${log.totalLines.toLocaleString()} lines)` : ''}. Open the run in Azure DevOps for the full log.`} />}
                    <div className="run-log" style={{ maxHeight: '70vh' }}>{log.text.split('\n').map((l, i) => <div key={i} className={`run-line${/##\[error\]/.test(l) ? ' stderr' : ''}`}><Ansi text={l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '')} /></div>)}</div>
                </>}
            </Modal>
        </div>
    );
}

function PublishedRunView({ tr, adoProject }: { tr: PublishedTestRun; adoProject?: string }) {
    const [res, setRes] = React.useState<PublishedTestResult[] | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    React.useEffect(() => { api.publishedTestResults(tr.id, adoProject).then((r) => setRes(r.results)).catch((e) => setErr(errText(e))); }, [tr.id, adoProject]);
    if (err) return <Alert type="error" showIcon message={err} />;
    if (!res) return <Spin size="small" />;
    const failed = res.filter((r) => !/^(Passed|NotExecuted|NotApplicable)$/i.test(r.outcome));
    return (
        <div className="run-tree">
            {failed.length === 0 && <Typography.Text type="secondary">No failures.</Typography.Text>}
            <Collapse size="small" items={failed.slice(0, 500).map((r) => ({
                key: r.id,
                label: <Space size={8}><StatusIcon status={/^Passed$/i.test(r.outcome) ? 'passed' : 'failed'} /><span>{r.title}</span><Tag>{r.outcome}</Tag>{r.testCaseId && <Tag color="purple">test case #{r.testCaseId}</Tag>}<Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtDur(r.durationMs)}</Typography.Text></Space>,
                children: <>
                    {r.automatedTestName && <div><Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{r.automatedTestName}</Typography.Text></div>}
                    {r.errorMessage && <pre className="mono run-error" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '6px 0' }}>{r.errorMessage}</pre>}
                    {r.stackTrace && <details><summary style={{ cursor: 'pointer', fontSize: 12 }}>Stack trace</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{r.stackTrace}</pre></details>}
                </>,
            }))} />
            {failed.length > 500 && <Typography.Text type="secondary">Showing the first 500 failures. Open the run in Azure DevOps for all of them.</Typography.Text>}
        </div>
    );
}

function TestResults({ detail, adoProject, onCount }: { detail: PipelineRunDetail; adoProject?: string; onCount: (n: { failed: number; total: number } | null) => void }) {
    const { message } = App.useApp();
    const [res, setRes] = React.useState<PipelineResults | null>(null);
    const [extra, setExtra] = React.useState<PipelineResults['projects']>([]);
    const [err, setErr] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState<string | null>(null);
    const run = detail.run;
    const hasCandidates = detail.artifacts.some((a) => a.candidate);
    React.useEffect(() => {
        if (!hasCandidates) return;
        let c = false;
        setLoading('auto'); setErr(null);
        api.pipelineResults(run.id, { adoProject }).then((r) => { if (!c) setRes(r); }).catch((e) => { if (!c) setErr(errText(e)); }).finally(() => { if (!c) setLoading(null); });
        return () => { c = true; };
    }, [run.id, adoProject, hasCandidates]);
    const projects = [...(res?.projects ?? []), ...extra];
    const pub = detail.publishedTestRuns;
    React.useEffect(() => {
        const all = projects.flatMap((p) => p.scenarios);
        const pubTotal = pub.reduce((t, r) => t + r.total, 0), pubFailed = pub.reduce((t, r) => t + r.failed, 0);
        onCount(all.length + pubTotal ? { total: all.length + pubTotal, failed: all.filter((s) => s.status === 'failed' || s.status === 'broken').length + pubFailed } : null);
    }, [res, extra, pub]); // eslint-disable-line react-hooks/exhaustive-deps

    const lookIn = async (name: string) => {
        setLoading(name);
        try {
            const r = await api.pipelineResults(run.id, { adoProject, artifact: name });
            if (!r.projects.length) message.info(r.errors[0]?.message ?? `No framework report found in ${name}.`);
            setExtra((x) => [...x.filter((p) => p.artifact !== name), ...r.projects]);
            if (r.errors.length) message.error(r.errors[0].message);
        } catch (e) { message.error(errText(e)); }
        finally { setLoading(null); }
    };
    // Group by stage (artifacts know their stage; published runs may).
    const stageNames = [...new Set([...projects.map((p) => p.stage ?? ''), ...pub.map((r) => r.stage ?? '')])];
    const stageOrder = (s: string) => { const i = detail.stages.findIndex((x) => x.name === s || x.identifier === s); return i < 0 ? 999 : i; };
    stageNames.sort((a, b) => stageOrder(a) - stageOrder(b));
    const searched = new Set([...(res?.looked ?? []), ...extra.map((p) => p.artifact)]);
    const others = detail.artifacts.filter((a) => !searched.has(a.name));

    return (
        <Space direction="vertical" size={14} style={{ display: 'flex' }}>
            {loading === 'auto' && <Spin tip="Downloading the test reports from the run's artifacts…"><div style={{ height: 50 }} /></Spin>}
            {err && <Alert type="info" showIcon message="Test reports" description={err} />}
            {res?.errors.map((e) => <Alert key={e.artifact} type="warning" showIcon message={`${e.artifact}: ${e.message}`} />)}
            {detail.publishedTestRunsError && <Alert type="info" showIcon message="Published test runs could not be read" description={detail.publishedTestRunsError} />}
            {stageNames.map((stage) => (
                <div key={stage || '-'}>
                    {(stageNames.length > 1 || stage) && <Typography.Title level={5} style={{ margin: '0 0 6px' }}>{stage ? `Stage: ${stage}` : 'Other'}</Typography.Title>}
                    <Space direction="vertical" size={10} style={{ display: 'flex' }}>
                        {projects.filter((p) => (p.stage ?? '') === stage).map((p) => {
                            const rows: ScenarioResult[] = p.scenarios.map((s) => ({ name: s.name, feature: s.feature, status: s.status, duration: s.durationMs ?? 0, error: s.failedStep?.error }));
                            const failed = rows.filter((r) => r.status === 'failed' || r.status === 'broken').length;
                            return (
                                <div key={`${p.artifact}/${p.name}`}>
                                    <Space style={{ marginBottom: 4 }} wrap>
                                        <Typography.Text strong>{p.name}</Typography.Text>
                                        <Tag color={failed ? 'error' : 'success'}>{rows.length - failed} passed{failed ? ` · ${failed} failed` : ''}</Tag>
                                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>framework report in {p.artifact}{p.job ? ` (job ${p.job})` : ''}{p.alsoIn?.length ? ` · the same report is also in ${p.alsoIn.join(', ')}` : ''}</Typography.Text>
                                        {p.reportIndex && <Typography.Link href={`${p.base}/${p.reportIndex}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Open the framework report</Typography.Link>}
                                    </Space>
                                    <RunTree runId={`pipeline-${run.id}`} base={p.base} scenarios={rows} ev={{ scenarios: p.scenarios, hasPlaywright: false }}
                                        onOpenScenario={(_sc, se) => { if (se?.location) openInEditor(se.location.file, se.location.line); }} />
                                </div>
                            );
                        })}
                        {pub.filter((r) => (r.stage ?? '') === stage).map((tr) => (
                            <div key={tr.id}>
                                <Space style={{ marginBottom: 4 }} wrap>
                                    <Typography.Text strong>{tr.name}</Typography.Text>
                                    <Tag color={tr.failed ? 'error' : 'success'}>{tr.passed} passed{tr.failed ? ` · ${tr.failed} failed` : ''}{tr.notExecuted ? ` · ${tr.notExecuted} not run` : ''}</Tag>
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>published test run{tr.job ? ` (job ${tr.job})` : ''}</Typography.Text>
                                    <Typography.Link href={tr.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Open in Azure DevOps</Typography.Link>
                                </Space>
                                <PublishedRunView tr={tr} adoProject={adoProject} />
                            </div>
                        ))}
                    </Space>
                </div>
            ))}
            {!loading && !projects.length && !pub.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hasCandidates ? 'No framework report found in the likely artifacts.' : 'This run has no test results the Studio recognises yet.'} />}
            {others.length > 0 && <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Other artifacts of this run (not opened automatically: other names or large). Look inside one for framework reports:</Typography.Text>
                <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 4 }}>
                    {others.map((a) => <Space key={a.name} size={8}>
                        <Typography.Text className="mono" style={{ fontSize: 12 }}>{a.name}</Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{[a.stage && `stage ${a.stage}`, a.job && `job ${a.job}`, mb(a.size), a.type === 'Container' ? 'classic build artifact' : a.type !== 'PipelineArtifact' && a.type].filter(Boolean).join(' · ')}</Typography.Text>
                        <Button size="small" loading={loading === a.name} disabled={!!loading || !/^(PipelineArtifact|Container)$/.test(a.type)} onClick={() => void lookIn(a.name)}>Look for test reports</Button>
                    </Space>)}
                </Space>
            </div>}
        </Space>
    );
}

function RunDetail({ id, adoProject }: { id: number; adoProject?: string }) {
    const [d, setD] = React.useState<PipelineRunDetail | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [tests, setTests] = React.useState<{ failed: number; total: number } | null>(null);
    React.useEffect(() => {
        let c = false; setD(null); setErr(null); setTests(null);
        api.pipelineRun(id, adoProject).then((x) => { if (!c) setD(x); }).catch((e) => { if (!c) setErr(errText(e)); });
        return () => { c = true; };
    }, [id, adoProject]);
    if (err) return <Alert type="error" showIcon message={`Could not load run ${id}`} description={err} />;
    if (!d) return <Spin style={{ margin: 40 }} />;
    const r = d.run;
    const hidden = tests && tests.failed > 0 && runStatus(r) === 'succeeded';
    return (
        <div>
            <Space direction="vertical" size={4} style={{ display: 'flex', marginBottom: 8 }}>
                <Space wrap>{statusTag(r)}<Typography.Text strong>{r.pipeline.name}</Typography.Text><Typography.Text type="secondary">#{r.number}</Typography.Text>
                    {tests && <Tag color={tests.failed ? 'error' : 'success'}>Tests: {tests.total - tests.failed} passed{tests.failed ? `, ${tests.failed} failed` : ''}</Tag>}</Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.branch} · {r.reason}{r.requestedFor ? ` · ${r.requestedFor}` : ''}{r.queued ? ` · ${new Date(r.queued).toLocaleString()}` : ''}{r.started && r.finished ? ` · ${dur(r.started, r.finished)}` : ''}</Typography.Text>
                <Space><Button size="small" icon={<ExportOutlined />} href={r.url} target="_blank" rel="noreferrer">Open in Azure DevOps</Button></Space>
            </Space>
            <StageStrip stages={d.stages} />
            {hidden && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`The pipeline says "succeeded", but ${tests!.failed} of ${tests!.total} tests failed.`}
                description="The framework ends with success even when scenarios fail, so the pipeline result alone does not show test failures." />}
            <Tabs size="small" items={[
                { key: 'tests', label: 'Test results', children: <TestResults detail={d} adoProject={adoProject} onCount={setTests} /> },
                { key: 'steps', label: 'Steps', children: <StepsView runId={id} timeline={d.timeline} adoProject={adoProject} /> },
                { key: 'artifacts', label: <span>Artifacts <Tag style={{ marginInlineEnd: 0 }}>{d.artifacts.length}</Tag></span>, children: d.artifacts.length
                    ? <Space direction="vertical">{d.artifacts.map((a) => <Space key={a.name}><Typography.Text className="mono">{a.name}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{[a.stage && `stage ${a.stage}`, a.job && `job ${a.job}`, mb(a.size), a.type].filter(Boolean).join(' · ')}</Typography.Text></Space>)}<Typography.Text type="secondary" style={{ fontSize: 12 }}>Download them from the run in Azure DevOps.</Typography.Text></Space>
                    : <Typography.Text type="secondary">No artifacts.</Typography.Text> },
            ]} />
        </div>
    );
}

export function Pipelines() {
    const { message, modal } = App.useApp();
    const { status } = useStudio();
    const [adoProject, setAdoProject] = React.useState<string | undefined>();
    const [projects, setProjects] = React.useState<{ projects: string[]; configured: string } | null>(null);
    const [defs, setDefs] = React.useState<{ items: PipelineDef[]; next?: string; folders: string[] }>({ items: [], folders: [] });
    const [search, setSearch] = React.useState('');
    const [folder, setFolder] = React.useState<string | undefined>();
    const [pipeline, setPipeline] = React.useState<number | undefined>();
    const [filters, setFilters] = React.useState<{ branch: string; result: string; mine: boolean }>({ branch: '', result: '', mine: false });
    const [runs, setRuns] = React.useState<{ items: PipelineRun[]; next?: string; label?: string }>({ items: [] });
    const [err, setErr] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    // The open item is part of the address (#/pipelines/<id>): Back returns to the previous one.
    const route = useRoute();
    const sel = route[0] === 'pipelines' && /^\d+$/.test(route[1] ?? '') ? Number(route[1]) : null;
    const setSel = (id: number | null) => navigate(['pipelines', id ?? undefined]);

    React.useEffect(() => { api.adoProjects().then(setProjects).catch(() => undefined); }, []);
    const loadDefs = React.useCallback(async (more = false) => {
        try {
            const r = await api.pipelineDefinitions({ adoProject, search: search || undefined, folder, next: more ? defs.next : undefined });
            setDefs((d) => ({ items: more ? [...d.items, ...r.items] : r.items, next: r.next, folders: r.folders ?? d.folders }));
        } catch (e) { setErr(errText(e)); }
    }, [adoProject, search, folder, defs.next]);
    React.useEffect(() => { void loadDefs(); }, [adoProject, folder]); // eslint-disable-line react-hooks/exhaustive-deps
    const loadRuns = React.useCallback(async (more = false) => {
        setLoading(true); setErr(null);
        try {
            const r = await api.pipelines({ adoProject, pipeline, branch: filters.branch || undefined, result: filters.result || undefined, mine: filters.mine, next: more ? runs.next : undefined });
            setRuns((x) => ({ items: more ? [...x.items, ...r.runs] : r.runs, next: r.next, label: `Azure DevOps project ${r.adoProject} · settings from config/${r.project} (${r.env})` }));
        } catch (e) { setErr(errText(e)); }
        finally { setLoading(false); }
    }, [adoProject, pipeline, filters, runs.next]);
    React.useEffect(() => { void loadRuns(); }, [adoProject, pipeline, filters]); // eslint-disable-line react-hooks/exhaustive-deps

    const queue = () => {
        const def = defs.items.find((d) => d.id === pipeline);
        if (!def) { message.info('Choose a pipeline first.'); return; }
        let branch = status?.branch ?? 'main';
        modal.confirm({
            title: `Start the pipeline "${def.name}" in Azure DevOps?`,
            content: <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text>This queues a real run in Azure DevOps. In a build-and-deploy pipeline that can deploy to environments, use agents, and send emails.</Typography.Text>
                <Typography.Text>Branch:</Typography.Text>
                <Input aria-label="Branch" defaultValue={branch} onChange={(e) => { branch = e.target.value.trim(); }} className="mono" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>The branch must be pushed. Your token needs the "Build (Read &amp; execute)" scope.</Typography.Text>
            </Space>,
            okText: 'Start run',
            onOk: (close) => { void (async () => { if (!branch) { message.error('Give the branch to run (for example main).'); return; } try { const r = await api.queuePipeline(def.id, branch, {}, adoProject); message.success(`Started run ${r.number}`); await loadRuns(); setSel(r.id); close(); } catch (e) { message.error(errText(e)); } })(); },
        });
    };

    // Azure DevOps not set up here: one short state with the way to set it up, not an error under empty filters.
    if (isAdoNotSetUp(err) && !runs.items.length) return <AdoNotSetUp what="Pipeline runs" error={err!} onRetry={() => { void loadDefs(); void loadRuns(); }} />;
    return (
        <div style={{ display: 'flex', gap: 12, height: 'calc(100vh - var(--chrome) - 8px)', minHeight: 0 }}>
            <div className="panel" style={{ flex: '0 1 460px', minWidth: 340, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="toolbar">
                    <Space direction="vertical" size={6} style={{ display: 'flex', width: '100%' }}>
                        {((projects && projects.projects.length > 1) || defs.folders.length > 0) && <Space wrap>
                            {projects && projects.projects.length > 1 && <Select aria-label="Azure DevOps project" style={{ width: 200 }} value={adoProject ?? projects.configured} onChange={(v) => { setAdoProject(v === projects.configured ? undefined : v); setPipeline(undefined); setSel(null); setFolder(undefined); }}
                                options={projects.projects.map((p) => ({ value: p, label: p === projects.configured ? `${p} (from config)` : p }))} showSearch />}
                            {defs.folders.length > 0 && <Select aria-label="Folder" allowClear placeholder="All folders" style={{ width: 180 }} value={folder} onChange={(v) => { setFolder(v); setPipeline(undefined); }} options={defs.folders.map((f) => ({ value: f, label: f }))} showSearch />}
                        </Space>}
                        <Space wrap>
                            <Select aria-label="Pipeline" allowClear showSearch filterOption={false} placeholder="All pipelines (type to search)" style={{ width: 260 }} value={pipeline}
                                onSearch={(v) => setSearch(v)} onDropdownVisibleChange={(o) => { if (o) void loadDefs(); }} onChange={(v) => { setPipeline(v); setSel(null); }}
                                options={defs.items.map((d) => ({ value: d.id, label: d.folder ? `${d.folder}\\${d.name}` : d.name }))}
                                dropdownRender={(menu) => <>{menu}{defs.next && <Button type="link" size="small" block onClick={() => void loadDefs(true)}>More pipelines…</Button>}</>}
                                onInputKeyDown={(e) => { if (e.key === 'Enter') void loadDefs(); }} />
                            <Button aria-label="Refresh the runs" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadRuns()} />
                            <Tooltip title={pipeline ? 'Start a run of this pipeline' : 'Choose a pipeline first'}><Button icon={<CaretRightOutlined />} disabled={!pipeline} onClick={queue}>Run</Button></Tooltip>
                        </Space>
                        <Space wrap size={8}>
                            <Input size="small" placeholder="Branch" style={{ width: 150 }} defaultValue={filters.branch} onPressEnter={(e) => setFilters({ ...filters, branch: (e.target as HTMLInputElement).value.trim() })} allowClear onChange={(e) => { if (!e.target.value) setFilters({ ...filters, branch: '' }); }} />
                            <Segmented size="small" value={filters.result} onChange={(v) => setFilters({ ...filters, result: String(v) })} options={[{ value: '', label: 'All' }, { value: 'failed', label: 'Failed' }, { value: 'partiallySucceeded', label: 'Partial' }, { value: 'running', label: 'Running' }]} />
                            <Space size={4}><Switch aria-label="Started by me" size="small" checked={filters.mine} onChange={(v) => setFilters({ ...filters, mine: v })} /><Typography.Text style={{ fontSize: 12 }}>Started by me</Typography.Text></Space>
                            {runs.label && <Tooltip title={runs.label}><InfoCircleOutlined style={{ color: 'var(--muted)' }} /></Tooltip>}
                        </Space>
                    </Space>
                </div>
                {err && <ErrorAlert style={{ margin: 10 }} title="Azure DevOps" error={err} />}
                <div style={{ flex: 1, overflow: 'auto' }}>
                    {runs.items.map((r) => (
                        <div key={r.id} className={`item-row${r.id === sel ? ' selected' : ''}`} onClick={() => setSel(r.id)}>
                            <div className="item-title">
                                {runIcon(r)}
                                <span className="t">{r.pipeline.name}</span>
                                {r.result === 'partiallySucceeded' && <Tag bordered={false} color="warning">partial</Tag>}
                                {r.result === 'canceled' && <Tag bordered={false}>canceled</Tag>}
                                <span className="item-id">#{r.number}</span>
                            </div>
                            <div className="item-meta" title={`${r.branch} · ${r.reason}${r.requestedFor ? ` · ${r.requestedFor}` : ''} · ${r.queued ? new Date(r.queued).toLocaleString() : ''}`}>
                                {shortRef(r.branch)} · {r.reason}{r.requestedFor ? ` · ${firstName(r.requestedFor)}` : ''}{r.queued ? ` · ${ago(r.queued)}` : ''}{r.started && r.finished ? ` · took ${dur(r.started, r.finished)}` : ''}
                            </div>
                        </div>
                    ))}
                    {runs.next && <Button type="link" block loading={loading} onClick={() => void loadRuns(true)}>Load more runs</Button>}
                    {!loading && !runs.items.length && !err && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description="No runs match." />}
                </div>
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 380, overflow: 'auto', padding: 14 }}>
                {sel ? <RunDetail key={`${adoProject ?? ''}/${sel}`} id={sel} adoProject={adoProject} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="Select a run" />}
            </div>
        </div>
    );
}
