/**
 * API → Runner: run a collection's requests in order (iterations, or once per row of test data: a file,
 * a database query or stored procedure, an API response or generated rows),
 * with their checks and saved values, and get a report.
 */
import React from 'react';
import { Alert, App, Button, Checkbox, Col, Drawer, Dropdown, Empty, Form, Progress, Row, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, DeleteOutlined, DownloadOutlined, DiffOutlined, StopOutlined } from '@ant-design/icons';
import { api, ApiCollectionDef, ApiCollectionInfo, ApiRunChange, ApiRunComparison, ApiRunJob, ApiRunStep, DataSourceDef } from '../api';
import { DataSourceEditor } from '../components/DataSourceEditor';
import { MonitorsPanel } from '../components/MonitorsPanel';
import { errText } from '../state';
import { navigate, useRoute } from '../route';
import { Split } from '../components/Split';
import { ago } from '../format';
import { FieldProblems, NumField, runnerRoute, RunnerTab, useFieldProblems, useRememberedTab } from '../apiperf-ui';

/** A step with its exchange (kept by the Studio for the first steps of a run). */
type StepDetail = { request: { headers: Record<string, string>; body?: string }; response?: { statusText: string; headers: Record<string, string>; body: string; cut: boolean } };
type Step = ApiRunStep & { detail?: StepDetail };
const headerText = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');
const pretty = (t: string) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; } };

/** An expanded row: the error, the checks, the request as sent and the response, and a link to the request. */
function StepView({ s, file }: { s: Step; file: string }) {
    const d = s.detail;
    return (
        <Space direction="vertical" size={8} style={{ width: '100%', minWidth: 0 }}>
            <Space wrap size={8}>
                <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}><b>{s.method}</b> {s.url || '(not sent)'}</span>
                {s.status !== undefined && <Tag bordered={false} color={s.status < 300 ? 'success' : s.status < 400 ? 'processing' : 'error'}>{s.status}{d?.response?.statusText ? ` ${d.response.statusText}` : ''}</Tag>}
                {s.timeMs !== undefined && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.timeMs} ms{s.size !== undefined ? ` · ${s.size.toLocaleString()} bytes` : ''}</Typography.Text>}
                {file && s.requestId && <Typography.Link style={{ fontSize: 12 }} onClick={() => navigate(['api', ...file.split('/'), s.requestId])}>Open the request in API requests</Typography.Link>}
            </Space>
            {s.error && <Typography.Text type="danger">{s.error}</Typography.Text>}
            {s.checks.map((c, i) => <span key={i}>{c.pass ? <CheckCircleFilled style={{ color: '#389e0d' }} /> : <CloseCircleFilled style={{ color: '#cf1322' }} />} {c.message}{!c.pass && c.actual !== undefined ? <Typography.Text type="secondary"> (got {c.actual})</Typography.Text> : null}</span>)}
            {s.logs?.length ? <pre className="code-box" style={{ margin: 0 }}>{s.logs.join('\n')}</pre> : null}
            {d ? <Tabs size="small" className="ap-tabs" items={[
                ...(d.response ? [{ key: 'res', label: 'Response', children: <pre className="code-box" style={{ margin: 0, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{pretty(d.response.body) || '(empty body)'}{d.response.cut ? '\n… (cut)' : ''}</pre> },
                    { key: 'resh', label: 'Response headers', children: <pre className="code-box" style={{ margin: 0, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{headerText(d.response.headers) || '(none)'}</pre> }] : []),
                { key: 'req', label: 'Request sent', children: <pre className="code-box" style={{ margin: 0, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{`${s.method} ${s.url}\n${headerText(d.request.headers)}${d.request.body ? `\n\n${pretty(d.request.body)}` : ''}`}</pre> },
            ]} /> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>The request and response are not kept for this step (runs before this version, or after the first 200 steps of a run).</Typography.Text>}
        </Space>
    );
}

const flat = (c: ApiCollectionDef) => { const out: Array<{ id: string; name: string; method: string }> = []; const w = (xs: ApiCollectionDef['items']) => { for (const x of xs) { if (x.kind === 'folder') w(x.items); else out.push({ id: x.id, name: x.name, method: x.method }); } }; w(c.items); return out; };

export function ApiRunner() {
    const { message } = App.useApp();
    const route = useRoute();
    const here = route[0] === 'api-runner';
    // #/api-runner/<collection file> (Run), #/api-runner/monitors, #/api-runner/runs, #/api-runner/run/<id> (Past runs, that run shown).
    const rr = runnerRoute(here ? route : []);
    const fileInRoute = rr.file;
    const runIdInRoute = rr.runId;
    const [meta, setMeta] = React.useState<{ projects: string[]; environments: Record<string, string[]>; collections: ApiCollectionInfo[] } | null>(null);
    const [file, setFile] = React.useState<string | null>(null);
    const [coll, setColl] = React.useState<ApiCollectionDef | null>(null);
    const [chosen, setChosen] = React.useState<string[]>([]);
    const [opts, setOpts] = React.useState({ env: undefined as string | undefined, iterations: 1, data: undefined as DataSourceDef | undefined, delayMs: 0, stopOnFailure: false });
    const [runs, setRuns] = React.useState<Array<Omit<ApiRunJob, 'steps'>>>([]);
    const [job, setJob] = React.useState<ApiRunJob | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [onlyFailed, setOnlyFailed] = React.useState(false);
    // The order the requests run in (moved here without changing the collection).
    const [order, setOrder] = React.useState<string[]>([]);
    const [cmpWith, setCmpWith] = React.useState<string | null>(null);
    const [cmp, setCmp] = React.useState<ApiRunComparison | null>(null);
    const [kept, keepTab] = useRememberedTab('api-runner', 'run');
    // The inner tab is the address's (a link opens it); a bare #/api-runner shows the one used last.
    const tab: RunnerTab = rr.tab ?? (['run', 'monitors', 'runs'].includes(kept) ? kept as RunnerTab : 'run');
    React.useEffect(() => { if (rr.tab) keepTab(rr.tab); }, [rr.tab]); // eslint-disable-line react-hooks/exhaustive-deps
    const tabRoute = (t: RunnerTab, f = file, j = job?.id) => (t === 'monitors' ? ['api-runner', 'monitors'] : t === 'runs' ? (j ? ['api-runner', 'run', j] : ['api-runner', 'runs']) : f ? ['api-runner', ...f.split('/')] : ['api-runner']);
    const setTab = (k: string) => { keepTab(k); navigate(tabRoute(k as RunnerTab)); };
    // A bare address gets the tab shown written into it (in place), so a copied link opens the same tab.
    React.useEffect(() => { if (here && route.length === 1 && (tab !== 'run' || file)) navigate(tabRoute(tab), true); }, [here, route.length]); // eslint-disable-line react-hooks/exhaustive-deps
    const fields = useFieldProblems();

    React.useEffect(() => { if (here && !meta) api.apiCollections().then(setMeta).catch((e) => setErr(errText(e))); }, [here, meta]);
    React.useEffect(() => { if (here) api.apiRuns().then((r) => setRuns(r.runs)).catch(() => {}); }, [here, job?.state]);
    React.useEffect(() => { if (fileInRoute && fileInRoute !== file) setFile(fileInRoute); }, [fileInRoute]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { setColl(null); setChosen([]); setOrder([]); if (file) api.apiCollection(file).then((r) => { setColl(r.collection); setChosen(flat(r.collection).map((x) => x.id)); setOrder(flat(r.collection).map((x) => x.id)); }).catch((e) => setErr(errText(e))); }, [file]);
    React.useEffect(() => { if (!cmpWith || !job) { setCmp(null); return; } api.apiRunCompare(cmpWith, job.id).then(setCmp).catch((e) => message.error(errText(e))); }, [cmpWith, job?.id, job?.state]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (runIdInRoute && runIdInRoute !== job?.id) api.apiRun(runIdInRoute).then((j) => { setJob(j); if (j && !file) setFile(j.collection); }).catch((e) => setErr(errText(e))); }, [runIdInRoute]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => {
        if (!job || job.state !== 'running') return;
        const t = setInterval(() => { api.apiRun(job.id).then(setJob).catch(() => {}); }, 700);
        return () => clearInterval(t);
    }, [job?.id, job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

    const project = file?.split('/')[1] ?? '';
    const envs = meta?.environments[project] ?? [];
    const reqs = coll ? flat(coll).sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id)) : [];
    const move = (id: string, d: -1 | 1) => { const o = reqs.map((r) => r.id); const i = o.indexOf(id), j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; setOrder(o); };
    const reordered = coll ? reqs.map((r) => r.id).join() !== flat(coll).map((r) => r.id).join() : false;
    // One run per click: a double click (or a click while the first one is being started) does not start two.
    const [starting, setStarting] = React.useState(false);
    const startingRef = React.useRef(false);
    const start = async () => {
        if (!coll || !file || startingRef.current || fields.problem) return;
        startingRef.current = true; setStarting(true);
        try {
            const j = await api.apiStartRun({ project, env: opts.env ?? envs[0], file, collection: coll, requests: chosen.length === reqs.length && !reordered ? [] : reqs.filter((r) => chosen.includes(r.id)).map((r) => r.id), iterations: opts.iterations, data: opts.data, delayMs: opts.delayMs, stopOnFailure: opts.stopOnFailure });
            setJob(j); navigate(['api-runner', 'run', j.id]);
        } catch (e) { message.error(errText(e)); }
        finally { startingRef.current = false; setStarting(false); }
    };
    const report = async (format: 'html' | 'junit' | 'json' = 'html') => {
        if (!job) return;
        try {
            const text = format === 'html' ? await api.apiRunReport(job.id) : await api.apiRunExport(job.id, format);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: format === 'html' ? 'text/html' : format === 'junit' ? 'application/xml' : 'application/json' }));
            a.download = `${job.name.replace(/[^\w.-]+/g, '_')}-run.${format === 'junit' ? 'xml' : format}`; a.click(); URL.revokeObjectURL(a.href);
        } catch (e) { message.error(errText(e)); }
    };
    const steps = (job?.steps ?? []).filter((s) => !onlyFailed || !s.passed);
    return (
        <>
        <Split id="api-runner" initial={380} min={300} max={600} style={{ height: 'calc(100vh - var(--chrome))' }}>
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {err && <Alert type="error" showIcon closable onClose={() => setErr(null)} style={{ margin: 8 }} message={err} />}
                <Tabs size="small" className="ap-tabs fill-tabs" style={{ flex: 1, minHeight: 0, paddingInline: 12 }} activeKey={tab} onChange={setTab} items={[
                    { key: 'run', label: 'Run', children: <div style={{ height: '100%', overflow: 'auto', paddingBottom: 12 }}>
                    <FieldProblems value={fields.report}><Form layout="vertical" size="small">
                        <Form.Item label="Collection">
                            <Select showSearch value={file ?? undefined} placeholder="Choose a collection" onChange={(v) => navigate(['api-runner', ...v.split('/')])} aria-label="Collection"
                                options={(meta?.collections ?? []).map((c) => ({ value: c.file, label: `${c.name} · ${c.project} (${c.requests})` }))} />
                        </Form.Item>
                        {coll && <>
                            <Form.Item label={`Requests (${chosen.length} of ${reqs.length})`}>
                                <div className="tx-list">{reqs.map((r, i) => <div key={r.id} style={{ display: 'flex', alignItems: 'center' }}>
                                    <Checkbox style={{ flex: 1 }} checked={chosen.includes(r.id)} onChange={(e) => setChosen(e.target.checked ? reqs.filter((x) => chosen.includes(x.id) || x.id === r.id).map((x) => x.id) : chosen.filter((x) => x !== r.id))}><span className="item-id">{i + 1}.</span> <b style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{r.method}</b> {r.name}</Checkbox>
                                    <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={!i} onClick={() => move(r.id, -1)} aria-label={`Move ${r.name} up`} />
                                    <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === reqs.length - 1} onClick={() => move(r.id, 1)} aria-label={`Move ${r.name} down`} />
                                </div>)}</div>
                                {reordered && <Typography.Link style={{ fontSize: 12 }} onClick={() => coll && setOrder(flat(coll).map((x) => x.id))}>Back to the collection's order</Typography.Link>}
                            </Form.Item>
                            <Row gutter={12}>
                                <Col span={8}><Form.Item label="Environment"><Select style={{ width: '100%' }} value={opts.env ?? envs[0]} placeholder="default" disabled={!envs.length} onChange={(v) => setOpts({ ...opts, env: v })} options={envs.map((e) => ({ value: e, label: e }))} aria-label="Environment" /></Form.Item></Col>
                                <Col span={8}><Form.Item label="Iterations" tooltip="How many times to run the requests (ignored with test data: one iteration per row)"><NumField min={1} max={1000} value={opts.iterations} disabled={!!opts.data} onChange={(v) => setOpts((o) => ({ ...o, iterations: v ?? 1 }))} width="100%" label="Iterations" /></Form.Item></Col>
                                <Col span={8}><Form.Item label="Delay" tooltip="Pause between requests"><NumField min={0} max={60000} value={opts.delayMs} onChange={(v) => setOpts((o) => ({ ...o, delayMs: v ?? 0 }))} addonAfter="ms" width="100%" label="Delay" /></Form.Item></Col>
                            </Row>
                            <Form.Item label="Test data (optional)" tooltip="One iteration per row; each column is {{column}} in the requests (values saved by a request are used by the next ones)"><DataSourceEditor project={project} env={opts.env ?? envs[0]} value={opts.data} onChange={(d) => setOpts({ ...opts, data: d })} collections={meta?.collections} /></Form.Item>
                            <Checkbox checked={opts.stopOnFailure} onChange={(e) => setOpts({ ...opts, stopOnFailure: e.target.checked })}>Stop at the first failure</Checkbox>
                            <div style={{ marginTop: 12 }}><Tooltip title={fields.problem ?? undefined}><Button type="primary" icon={<CaretRightOutlined />} loading={starting} disabled={!chosen.length || job?.state === 'running' || !!fields.problem} onClick={() => void start()}>Run {chosen.length} request{chosen.length === 1 ? '' : 's'}{opts.data ? ' per data row' : opts.iterations > 1 && Number.isInteger(opts.iterations) ? ` × ${opts.iterations}` : ''}</Button></Tooltip></div>
                        </>}
                    </Form></FieldProblems>
                    </div> },
                    { key: 'monitors', label: 'Monitors', children: <div style={{ height: '100%', overflow: 'auto', marginInline: -12 }}><MonitorsPanel collections={meta?.collections ?? []} environments={meta?.environments ?? {}} file={file} /></div> },
                    { key: 'runs', label: <span>Past runs{runs.length ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>{runs.length}</Tag> : null}</span>, children: <div style={{ height: '100%', overflow: 'auto', marginInline: -12 }}>
                        <Typography.Text type="secondary" style={{ display: 'block', padding: '0 14px 4px', fontSize: 12 }}>The last 50 runs are kept on this computer.</Typography.Text>
                        {runs.length === 0 ? <Typography.Text type="secondary" style={{ display: 'block', padding: '4px 14px', fontSize: 12 }}>None yet</Typography.Text> : runs.map((r) => (
                            <div key={r.id} className={`item-row${job?.id === r.id ? ' selected' : ''}`} onClick={() => navigate(['api-runner', 'run', r.id])}>
                                <div className="item-title">{r.state === 'running' ? <Spin size="small" /> : r.summary.failed ? <CloseCircleFilled style={{ color: '#cf222e' }} /> : r.state === 'stopped' ? <StopOutlined style={{ color: '#bf8700' }} aria-label="Stopped" /> : <CheckCircleFilled style={{ color: '#389e0d' }} />}<span className="t">{r.name}</span><span className="item-id">{r.env}</span>
                                    {r.state !== 'running' && <Button size="small" type="text" className="node-more" icon={<DeleteOutlined />} aria-label="Delete this run" onClick={(e) => { e.stopPropagation(); void api.apiRunDelete(r.id).then(() => api.apiRuns().then((x) => setRuns(x.runs))).catch((e) => message.error(errText(e))); }} />}</div>
                                <div className="item-meta">{ago(r.startedAt)}{r.state === 'stopped' ? ' · stopped' : ''} · {r.summary.passed}/{r.summary.requests} passed{r.state === 'stopped' ? ` of ${r.total}` : ''} · {r.iterations} iteration{r.iterations === 1 ? '' : 's'}</div>
                            </div>))}
                    </div> },
                ]} />
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 16 }}>
                {!job ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="Choose a collection and press Run" /> : (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            {job.state === 'running' ? <Tag color="processing">Running</Tag> : job.summary.failed ? <Tag color="error" icon={<CloseCircleFilled />}>{job.summary.failed} failed{job.state === 'stopped' ? ` · stopped: ${job.summary.requests} of ${job.total} ran` : ''}</Tag> : job.state === 'stopped' ? <Tag color="warning" icon={<StopOutlined />}>Stopped: {job.summary.requests} of {job.total} ran</Tag> : <Tag color="success" icon={<CheckCircleFilled />}>All passed</Tag>}
                            <Typography.Text strong style={{ fontSize: 15 }}>{job.name}</Typography.Text>
                            <Typography.Text type="secondary">{job.project} / {job.env} · {new Date(job.startedAt).toLocaleString()}</Typography.Text>
                            <div style={{ flex: 1 }} />
                            {job.state === 'running' && <Button danger size="small" icon={<StopOutlined />} onClick={() => void api.apiStopRun(job.id).catch((e) => message.error(errText(e)))}>Stop</Button>}
                            {job.state !== 'running' && <Select size="small" allowClear style={{ width: 220 }} placeholder={<span><DiffOutlined /> Compare with a run…</span>} value={cmpWith ?? undefined} onChange={(v) => setCmpWith(v ?? null)} aria-label="Compare with"
                                options={runs.filter((r) => r.id !== job.id && r.state !== 'running' && r.collection === job.collection).map((r) => ({ value: r.id, label: `${new Date(r.startedAt).toLocaleString()} · ${r.env} · ${r.summary.passed}/${r.summary.requests}` }))} />}
                            {job.state !== 'running' && <Dropdown menu={{ items: [{ key: 'html', label: 'HTML report (to share)' }, { key: 'junit', label: 'JUnit XML (pipelines: Publish test results)' }, { key: 'json', label: 'JSON (every request and check)' }], onClick: ({ key }) => void report(key as 'html') }}>
                                <Button size="small" icon={<DownloadOutlined />}>Report</Button></Dropdown>}
                        </div>
                        <Progress percent={Math.round((job.steps.length / Math.max(1, job.total)) * 100)} status={job.state === 'running' ? 'active' : job.summary.failed ? 'exception' : 'success'} format={() => `${job.steps.length} / ${job.total}`} />
                        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                            <div className="kpi"><b>{job.summary.passed}/{job.summary.requests}</b><span>Requests passed</span></div>
                            <div className="kpi"><b>{job.summary.checksPassed}/{job.summary.checks}</b><span>Checks passed</span></div>
                            <div className="kpi"><b>{job.summary.avgMs} ms</b><span>Average time</span></div>
                            <div className="kpi"><b>{job.iterations}</b><span>Iterations</span></div>
                        </div>
                        <Checkbox checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)}>Only failures</Checkbox>
                        <Table<Step> size="small" scroll={{ x: 620 }} rowKey={(s) => `${s.iteration}-${s.requestId}`} dataSource={steps} pagination={steps.length > 100 ? { pageSize: 100, showSizeChanger: false } : false}
                            expandable={{ rowExpandable: (s) => !!s.requestId || s.checks.length > 0 || !!s.error || !!s.logs?.length, expandedRowRender: (s) => <StepView s={s} file={job.collection} /> }}
                            columns={[
                                { title: '#', dataIndex: 'iteration', width: 50 },
                                { title: 'Request', dataIndex: 'name', ellipsis: true, width: 220, render: (n: string, s) => <><b style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{s.method}</b> {n}</> },
                                { title: 'Status', dataIndex: 'status', width: 80 },
                                { title: 'Time', dataIndex: 'timeMs', width: 90, align: 'right', render: (v?: number) => (v === undefined ? '' : `${v} ms`) },
                                { title: 'Checks', width: 90, render: (_, s) => `${s.checks.filter((c) => c.pass).length}/${s.checks.length}` },
                                { title: 'Result', width: 110, render: (_, s) => (s.passed ? <Tag color="success">Passed</Tag> : <Tooltip title={s.error ?? s.checks.find((c) => !c.pass)?.message}><Tag color="error">Failed</Tag></Tooltip>) },
                            ]} />
                    </Space>)}
            </div>
        </Split>
            <Drawer open={!!cmp} onClose={() => setCmpWith(null)} width={880} title={cmp ? `Compared with the run of ${new Date(cmp.a.startedAt).toLocaleString()} (${cmp.a.env})` : ''}>
                {cmp && <Space direction="vertical" style={{ width: '100%' }}>
                    <Space wrap>
                        {(['broke', 'fixed', 'still failing', 'same', 'new', 'gone'] as ApiRunChange[]).filter((k) => cmp.counts[k]).map((k) => <Tag key={k} color={CHANGE_COLOR[k]}>{cmp.counts[k]} {k}</Tag>)}
                        <Typography.Text type="secondary">Average time {cmp.a.summary.avgMs} → {cmp.b.summary.avgMs} ms ({cmp.avgDelta >= 0 ? '+' : ''}{cmp.avgDelta} ms)</Typography.Text>
                    </Space>
                    <Table size="small" pagination={false} rowKey="key" dataSource={[...cmp.rows].sort((x, y) => CHANGE_ORDER.indexOf(x.change) - CHANGE_ORDER.indexOf(y.change))}
                        expandable={{ rowExpandable: (r) => !!r.checksChanged?.length, expandedRowRender: (r) => <Space direction="vertical" size={2}>{r.checksChanged!.map((c, i) => <Typography.Text key={i} type={c.startsWith('now fails') ? 'danger' : 'success'}>{c}</Typography.Text>)}</Space> }}
                        columns={[
                            { title: '#', dataIndex: 'iteration', width: 46 },
                            // Paired by the request (not its name): its place in the run and its method and URL tell two "New request"s apart.
                            { title: 'Request', dataIndex: 'name', render: (n: string, r) => <div style={{ minWidth: 0 }}>
                                <div>{r.position ? <span className="item-id">{r.position}.</span> : null} {n}</div>
                                {(r.method || r.url) && <Typography.Text type="secondary" className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{r.method} {r.url || '(not sent)'}</Typography.Text>}
                            </div> },
                            { title: 'Change', width: 120, render: (_, r) => <Tag color={CHANGE_COLOR[r.change]}>{r.change}</Tag> },
                            { title: 'Before', width: 120, render: (_, r) => (r.a ? (r.a.status === undefined && r.a.timeMs === undefined ? <span>{r.a.passed ? 'passed' : 'not sent'}</span> : <span>{r.a.status ?? 'no answer'}{r.a.timeMs !== undefined ? ` · ${r.a.timeMs} ms` : ''}</span>) : '—') },
                            { title: 'Now', width: 120, render: (_, r) => (r.b ? (r.b.status === undefined && r.b.timeMs === undefined ? <span>{r.b.passed ? 'passed' : 'not sent'}</span> : <span>{r.b.status ?? 'no answer'}{r.b.timeMs !== undefined ? ` · ${r.b.timeMs} ms` : ''}</span>) : '—') },
                            { title: 'Time', width: 90, align: 'right', render: (_, r) => (r.timeDelta === undefined ? '' : <Typography.Text type={r.timeDelta > 200 ? 'warning' : 'secondary'}>{r.timeDelta >= 0 ? '+' : ''}{r.timeDelta} ms</Typography.Text>) },
                        ]} />
                </Space>}
            </Drawer>
        </>
    );
}

const CHANGE_ORDER: ApiRunChange[] = ['broke', 'still failing', 'fixed', 'new', 'gone', 'same'];
const CHANGE_COLOR: Record<ApiRunChange, string> = { broke: 'error', fixed: 'success', 'still failing': 'warning', same: 'default', new: 'processing', gone: 'default' };
