/**
 * Quality: how each scenario does across runs (the Studio's runs and report folders on disk).
 * Overview (gate, counts, trend), Scenarios (by class, with their history), Failure causes (failures
 * grouped by cause), Quarantine (@quarantine scenarios and whether runs leave them out).
 */
import React from 'react';
import { Alert, App, Badge, Button, Card, Checkbox, Col, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Radio, Row, Segmented, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { BugOutlined, CheckCircleFilled, CloseCircleFilled, CodeOutlined, ExportOutlined, FlagOutlined, PlayCircleOutlined, ReloadOutlined, SettingOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { api, FailureCategory, FailureGroup, GateSettings, QualityClass, QualityReport, QualityResult, QualityScenario, TriageBug, TriageVerdict , BugActionDef } from '../api';
import { errText, loadRunTarget, useStudio } from '../state';
import { navigate, useRoute } from '../route';
import { LineChart } from '../components/LineChart';
import { TeamTrends } from '../components/TeamTrends';
import { useKept } from '../kept';
import { askChangedElsewhere, isChangedElsewhere } from '../components/ChangedElsewhere';
import '../styles-tests.css';

const CLASS: Record<QualityClass, { label: string; color: string; about: string }> = {
    'new-failure': { label: 'New failure', color: 'error', about: 'Failed in its latest run after passing before.' },
    failing: { label: 'Failing', color: 'volcano', about: 'Failed in its latest runs, one after another.' },
    flaky: { label: 'Flaky', color: 'warning', about: 'Passes and fails without a change (switches back and forth, or passed only after a retry).' },
    fixed: { label: 'Fixed', color: 'cyan', about: 'Failed earlier in these runs and has passed since.' },
    stable: { label: 'Stable', color: 'success', about: 'Passed in every run.' },
    skipped: { label: 'Skipped', color: 'default', about: 'Did not run (skipped) in these runs.' },
};
const CLASS_ORDER: QualityClass[] = ['new-failure', 'failing', 'flaky', 'fixed', 'stable', 'skipped'];
const CATEGORY: Record<FailureCategory, { label: string; color: string }> = {
    element: { label: 'Element not found', color: 'magenta' }, timeout: { label: 'Timeout', color: 'orange' },
    assertion: { label: 'Check failed', color: 'red' }, api: { label: 'API / network', color: 'geekblue' },
    database: { label: 'Database', color: 'purple' }, step: { label: 'Missing step', color: 'volcano' },
    script: { label: 'Code error', color: 'gold' }, other: { label: 'Other', color: 'default' },
};
export const VERDICT: Record<TriageVerdict, { label: string; color: string; about: string }> = {
    'product-bug': { label: 'Product bug', color: 'red', about: 'The application is wrong: the test caught it.' },
    'test-issue': { label: 'Test issue', color: 'orange', about: 'The test is wrong or out of date (locator, data, expectation).' },
    environment: { label: 'Environment', color: 'gold', about: 'The environment or its data (down, slow, reset).' },
    flaky: { label: 'Flaky', color: 'purple', about: 'Fails now and then for no change: timing, order, shared data.' },
    expected: { label: 'Expected', color: 'default', about: 'A known, accepted failure (a feature not done yet).' },
};
const DONE_STATES = /^(resolved|closed|done|removed)$/i;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '–');
const ago = (iso?: string) => {
    if (!iso) return '–';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const secs = (ms: number) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const firstLine = (t?: string) => (t ?? '').replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).find((l) => l.trim()) ?? '';
/** The written scenario of an outline row ("name_Iteration-2"), as the run command selects it. */
const writtenName = (n: string) => n.replace(/_Iteration-\d+$/, '');

/** One dot per run: passed, passed after a retry, failed, skipped. */
function History({ results, max = 20 }: { results: QualityResult[]; max?: number }) {
    const shown = results.slice(-max);
    return (
        <span className="q-dots" aria-label={`${shown.length} results`}>
            {shown.map((r, i) => (
                <Tooltip key={i} title={<>{when(r.at)}<br />{r.status === 'passed' && r.retries ? `Passed after ${r.retries} retr${r.retries === 1 ? 'y' : 'ies'}` : r.status}{r.error ? <><br />{firstLine(r.error).slice(0, 160)}</> : null}</>}>
                    <i className={`q-dot ${r.status === 'passed' ? (r.retries ? 'retried' : 'pass') : r.status === 'failed' ? 'fail' : 'skip'}`} />
                </Tooltip>
            ))}
        </span>
    );
}

/**
 * What the team decided about a cause of failure: its verdict and note, its bugs (with their state), and a
 * warning when it fails again after its bug was resolved.
 */
function TriageLine({ g, bugs, onTriage, onFile }: { g: FailureGroup; bugs: TriageBug[]; onTriage: () => void; onFile: () => void }) {
    const t = g.triage;
    const back = bugs.find((b) => DONE_STATES.test(b.state) && Date.parse(g.lastSeen) > Date.parse(b.resolved ?? b.changed));
    return (
        <div className="q-triage">
            <Space size={[6, 4]} wrap>
                {t?.verdict ? <Tooltip title={VERDICT[t.verdict].about}><Tag bordered={false} color={VERDICT[t.verdict].color}>{VERDICT[t.verdict].label}</Tag></Tooltip>
                    : <Typography.Text type="secondary" style={{ fontSize: 12 }}>Not triaged</Typography.Text>}
                {bugs.map((b) => (
                    <Tooltip key={b.id} title={b.title}>
                        <a href={b.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12 }}><BugOutlined /> {b.id} <Tag bordered={false} color={DONE_STATES.test(b.state) ? 'default' : 'processing'} style={{ marginInlineStart: 2 }}>{b.state}</Tag></a>
                    </Tooltip>
                ))}
                {t?.bug && !bugs.some((b) => b.id === t.bug) && <Typography.Text type="secondary" style={{ fontSize: 12 }}><BugOutlined /> {t.bug}</Typography.Text>}
                {back && <Tooltip title={`Bug ${back.id} is ${back.state.toLowerCase()} (${new Date(back.resolved ?? back.changed).toLocaleDateString()}), and this failed again after it.`}><Tag bordered={false} color="error">Failed again after bug {back.id} was {back.state.toLowerCase()}</Tag></Tooltip>}
                <span style={{ flex: 1 }} />
                <Button size="small" type="text" icon={<FlagOutlined />} onClick={onTriage}>{t ? 'Edit triage' : 'Triage'}</Button>
                {!bugs.some((b) => !DONE_STATES.test(b.state)) && <Button size="small" type="text" icon={<BugOutlined />} onClick={onFile}>File bug</Button>}
            </Space>
            {t?.note && <div className="q-triage-note">{t.note}<Typography.Text type="secondary" style={{ fontSize: 11 }}> — {t.by ?? ''}{t.at ? `, ${new Date(t.at).toLocaleDateString()}` : ''}</Typography.Text></div>}
        </div>
    );
}

/** Set the verdict, a note and the bug of a cause of failure (kept in .cs-studio/triage.json, committed). */

const ACTION_LABEL: Record<string, { text: string; color: string }> = { file: { text: 'File', color: 'red' }, update: { text: 'Comment', color: 'blue' }, reopen: { text: 'Reopen', color: 'orange' }, resolve: { text: 'Resolve', color: 'green' } };
/** Bugs kept in step with the results: file, comment, reopen, resolve — chosen one by one, then applied in Azure DevOps. */
function BugSync({ project, onDone }: { project?: string; onDone: () => void }) {
    const { message } = App.useApp();
    const [plan, setPlan] = React.useState<BugActionDef[] | null>(null);
    const [chosen, setChosen] = React.useState<number[]>([]);
    const [busy, setBusy] = React.useState(false);
    const open = async () => {
        setBusy(true);
        try { const r = await api.triageBugPlan({ ...(project ? { project, qualityProject: project } : {}) }); setPlan(r.actions); setChosen(r.actions.map((_, i) => i)); }
        catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    const apply = async () => {
        setBusy(true);
        try {
            const r = await api.triageBugApply(chosen.map((i) => plan![i]), project);
            const bad = r.results.filter((x) => !x.ok);
            if (bad.length) message.warning(`${r.results.length - bad.length} done; ${bad.length} failed: ${bad.map((x) => `${x.kind} ${x.bug ?? ''}: ${x.error}`).join('; ')}`, 8);
            else message.success(`${r.results.length} bug change${r.results.length === 1 ? '' : 's'} made in Azure DevOps.`);
            setPlan(null); onDone();
        } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    return (
        <>
            <Tooltip title="File bugs for new product failures, comment when they go on, reopen closed bugs that fail again, resolve bugs whose tests pass again"><Button size="small" icon={<BugOutlined />} loading={busy && !plan} onClick={() => void open()}>Bring bugs up to date</Button></Tooltip>
            <Modal open={!!plan} title="Bring the bugs up to date" width={760} okText={`Apply ${chosen.length}`} okButtonProps={{ disabled: !chosen.length, loading: busy }} onOk={() => void apply()} onCancel={() => setPlan(null)}>
                {plan && !plan.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Every bug already matches the latest results." /> : <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Nothing changes in Azure DevOps until you apply. Untick what you want to leave as it is.</Typography.Text>
                    {plan?.map((a, i) => (
                        <div key={i} className="check-row" style={{ alignItems: 'flex-start' }}>
                            <Checkbox checked={chosen.includes(i)} onChange={(e) => setChosen(e.target.checked ? [...chosen, i] : chosen.filter((x) => x !== i))} aria-label={`${a.kind} ${a.bug ?? ''}`} />
                            <Tag color={ACTION_LABEL[a.kind].color}>{ACTION_LABEL[a.kind].text}{a.bug ? ` ${a.bug}` : ''}</Tag>
                            <div style={{ flex: 1, fontSize: 13 }}>{a.kind === 'file' ? <b>{a.title}</b> : a.from ? <b>{a.from} → {a.to}</b> : null}<div>{a.why}</div></div>
                        </div>
                    ))}
                </Space>}
            </Modal>
        </>
    );
}

function TriageModal({ g, onClose, onSaved }: { g: FailureGroup | null; onClose: () => void; onSaved: () => void }) {
    const { message } = App.useApp();
    const [verdict, setVerdict] = React.useState<TriageVerdict | undefined>();
    const [note, setNote] = React.useState('');
    const [bug, setBug] = React.useState<number | null>(null);
    React.useEffect(() => { setVerdict(g?.triage?.verdict); setNote(g?.triage?.note ?? ''); setBug(g?.triage?.bug ?? null); }, [g]);
    const [busy, setBusy] = React.useState(false);
    const save = async (clear = false) => {
        if (!g || busy) return;
        setBusy(true);
        try {
            await api.triageSet({ tag: g.tag, signature: g.signature, ...(clear ? {} : { ...(verdict ? { verdict } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(bug ? { bug } : {}) }) });
            message.success(clear ? 'Triage removed.' : 'Saved in .cs-studio/triage.json: commit it to share it with the team.');
            onSaved();
        } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    return (
        <Modal open={!!g} onCancel={onClose} title="Triage this cause of failure" okText="Save" okButtonProps={{ loading: busy }} onOk={() => void save()} width={560}
            footer={(_, { OkBtn, CancelBtn }) => <>{g?.triage && <Button danger style={{ float: 'left' }} onClick={() => void save(true)}>Remove triage</Button>}<CancelBtn /><OkBtn /></>}>
            {g && <Form layout="vertical" component={false}>
                <div className="mono q-sig" style={{ marginBottom: 12 }}>{g.signature}</div>
                <Form.Item label="Verdict" style={{ marginBottom: 10 }}>
                    <Radio.Group size="small" optionType="button" buttonStyle="solid" value={verdict ?? ''} onChange={(e) => setVerdict((e.target.value || undefined) as TriageVerdict | undefined)} aria-label="Verdict"
                        style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {(Object.keys(VERDICT) as TriageVerdict[]).map((k) => <Tooltip key={k} title={VERDICT[k].about}><Radio.Button value={k} style={{ borderRadius: 6 }}>{VERDICT[k].label}</Radio.Button></Tooltip>)}
                        <Radio.Button value="" style={{ borderRadius: 6 }}>None</Radio.Button>
                    </Radio.Group>
                </Form.Item>
                <Form.Item label="Note" style={{ marginBottom: 10 }}>
                    <Input.TextArea value={note} onChange={(e) => setNote(e.target.value)} autoSize={{ minRows: 2, maxRows: 6 }} maxLength={2000} showCount placeholder="What it is, who looks at it, the workaround…" aria-label="Note" />
                </Form.Item>
                <Form.Item label="Bug" style={{ marginBottom: 6 }} tooltip={`The next runs that fail the same way show this. Bugs tagged ${g.tag} are found by themselves.`}>
                    <InputNumber value={bug} onChange={(v) => setBug(typeof v === 'number' ? v : null)} min={1} precision={0} placeholder="Work item id" style={{ width: 200 }} aria-label="Bug id" />
                </Form.Item>
            </Form>}
        </Modal>
    );
}

export function Quality() {
    const { message, modal } = App.useApp();
    const { env: disc } = useStudio();
    const route = useRoute();
    const here = route[0] === 'quality';
    const tab = (['overview', 'scenarios', 'causes', 'quarantine', 'team'].includes(route[1] ?? '') ? route[1] : 'overview') as string;
    // A wrong address (#/quality/bogus) is replaced by the tab shown.
    React.useEffect(() => { if (here && route[1] !== undefined && route[1] !== tab) navigate(['quality', tab], true); }, [here, route[1], tab]); // eslint-disable-line react-hooks/exhaustive-deps
    const [windowSize, setWindowSize] = useKept('quality.window', 30);
    const [project, setProject] = useKept<string | undefined>('quality.project', undefined);
    const [data, setData] = React.useState<QualityReport | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [cls, setCls] = useKept<QualityClass | 'all'>('quality.class', 'all');
    const [onlyQuarantined, setOnlyQuarantined] = useKept('quality.quarantined', false);
    const [find, setFind] = useKept('quality.find', '');
    const [open, setOpen] = useKept<string | null>('quality.open', null);
    const [selected, setSelected] = React.useState<string[]>([]);
    const [gateOpen, setGateOpen] = React.useState(false);
    // The bugs of the causes: named in the triage, or carrying a cause's tag (filed by a run or here).
    const [bugs, setBugs] = React.useState<TriageBug[] | null>(null);
    const [triaging, setTriaging] = React.useState<FailureGroup | null>(null);
    React.useEffect(() => {
        setBugs(null);
        if (!data?.groups.length) return;
        let live = true;
        const ids = data.groups.map((g) => g.triage?.bug).filter((n): n is number => !!n);
        api.triageBugs({ tags: data.groups.map((g) => g.tag), ids, ...(data.project ? { project: data.project } : {}) })
            .then((r) => live && setBugs(r.bugs)).catch(() => live && setBugs([]));
        return () => { live = false; };
    }, [data]);

    const load = React.useCallback(async () => {
        setLoading(true);
        try { setData(await api.quality(windowSize, project)); } catch (e) { message.error(errText(e)); } finally { setLoading(false); }
    }, [windowSize, project, message]);
    React.useEffect(() => { if (here) void load(); }, [here, load]);

    const byKey = React.useMemo(() => new Map((data?.scenarios ?? []).map((s) => [s.key, s])), [data]);
    const current = open ? byKey.get(open) : undefined;
    const goTab = (t: string) => navigate(['quality', t]);
    const showClass = (c: QualityClass | 'all') => { setCls(c); setOnlyQuarantined(false); goTab('scenarios'); };

    const runAgain = async (list: QualityScenario[]) => {
        const projects = [...new Set(list.map((s) => s.project ?? data?.project ?? ''))];
        if (projects.length !== 1 || !projects[0]) { message.warning(projects.length > 1 ? 'Pick scenarios of one project.' : 'The project of these scenarios is not known: start them from Run tests.'); return; }
        const p = projects[0];
        const names = [...new Set(list.map((s) => writtenName(s.name)))];
        if (names.some((n) => n.includes(','))) { message.warning('A scenario name with a comma cannot be chosen on its own: run its feature, or give it a tag, from Run tests.'); return; }
        const start = async (env: string) => {
            // Only the feature files these scenarios are in (same-named scenarios elsewhere must not run), with the
            // browser as Run tests last used it (hidden unless chosen).
            const files = [...new Set(list.map((s) => s.file).filter((f): f is string => !!f))];
            const saved = loadRunTarget();
            try {
                const run = await api.startRun({ project: p, env, scenarios: names, ...(files.length && list.every((s) => s.file) ? { features: files } : {}),
                    headless: saved?.project === p ? saved.headless ?? true : true, ...(saved?.project === p && saved.browser ? { browser: saved.browser } : {}) });
                navigate(['runs', run.id]);
            } catch (e) { message.error(errText(e)); }
        };
        const envs = [...new Set(list.map((s) => s.env).filter((e): e is string => !!e))];
        if (envs.length === 1) { await start(envs[0]); return; }
        // Ran from the command line or a pipeline (the environment is not recorded), or in several: choose one.
        const choices = disc?.environments[p] ?? [];
        const saved = loadRunTarget();
        let env = (saved?.project === p && saved.env && choices.includes(saved.env) ? saved.env : choices[0]) ?? 'dev';
        modal.confirm({
            title: `Run ${names.length === 1 ? `"${names[0]}"` : `${names.length} scenarios`} again`, okText: 'Run', icon: <PlayCircleOutlined />,
            content: <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">Project {p}. Environment:</Typography.Text>
                <Select defaultValue={env} style={{ width: 200 }} onChange={(v) => { env = v; }} options={(choices.length ? choices : [env]).map((e) => ({ value: e, label: e }))} aria-label="Environment" />
            </Space>,
            onOk: () => start(env),
        });
    };
    const quarantine = (s: QualityScenario, on: boolean) => {
        if (!s.file || !s.line) { message.warning('The feature file of this scenario was not found.'); return; }
        let reason = '';
        const go = async () => {
            try {
                const r = await api.quarantine({ key: s.key, file: s.file!, line: s.line!, name: writtenName(s.name), on, reason });
                message.success(r.changed ? `${on ? 'Added' : 'Removed'} @quarantine in ${s.file}. Commit it under Source control.` : 'Nothing to change.');
                void load();
            } catch (e) { message.error(errText(e)); }
        };
        if (!on) { void go(); return; }
        modal.confirm({
            title: `Quarantine "${writtenName(s.name)}"?`, okText: 'Quarantine', icon: <StopOutlined />,
            content: <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">Adds the tag @quarantine to the scenario. Runs leave it out when EXCLUDE_TAGS includes @quarantine (see the Quarantine tab), and the gate does not count it.</Typography.Text>
                <Input placeholder="Why (optional), e.g. waits for a fix in the test data" maxLength={500} onChange={(e) => { reason = e.target.value; }} />
            </Space>,
            onOk: go,
        });
    };

    if (!data) return <div className="panel" style={{ padding: 24 }}>{loading ? 'Loading…' : null}</div>;
    const latest = data.runs[data.runs.length - 1];
    const shown = data.scenarios.filter((s) => (cls === 'all' || s.cls === cls) && (!onlyQuarantined || s.quarantined)
        && (!find.trim() || `${s.name} ${s.feature}`.toLowerCase().includes(find.trim().toLowerCase())));
    const noRuns = !data.runs.length;
    const fromStudio = data.runs.filter((r) => r.source === 'studio').length, fromReports = data.runs.length - fromStudio;

    const toolbar = (
        <div className="toolbar">
            {data.projects.length > 1 && <Select size="small" value={data.project ?? 'all'} onChange={setProject} style={{ width: 170 }} aria-label="Project"
                options={[...data.projects.map((p) => ({ value: p, label: `Project ${p}` })), { value: 'all', label: 'All projects' }]} />}
            <Select size="small" value={windowSize} onChange={setWindowSize} style={{ width: 140 }} aria-label="Runs"
                options={[10, 30, 100].map((n) => ({ value: n, label: `Last ${n} runs` }))} />
            <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                {noRuns ? '' : <>
                    {/* Run tests lists only the runs started in the Studio; Quality also counts the reports found on disk. */}
                    <Tooltip title={fromReports ? `${fromStudio} started in the Studio (listed under Run tests) and ${fromReports} found as report folders on disk (command line, pipeline, older runs). Pull request and debug-copy runs are not counted.` : 'All started in the Studio (listed under Run tests).'}>
                        <span style={{ cursor: 'help', textDecoration: 'underline dotted' }}>{data.runs.length} run{data.runs.length === 1 ? '' : 's'}{fromReports ? ` (${fromStudio} from Run tests, ${fromReports} from reports on disk)` : ''}</span>
                    </Tooltip>
                    {`, ${new Date(data.runs[0].at).toLocaleDateString()} – ${new Date(latest.at).toLocaleDateString()} · ${data.scenarios.length} scenarios`}
                </>}
            </Typography.Text>
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} aria-label="Refresh" />
        </div>
    );
    if (noRuns) return <div className="panel">{toolbar}<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 60 }} description="No results yet. Run tests under Run tests (or from the command line): their results appear here." /></div>;

    const overview = (
        <div className="q-body">
            <Row gutter={[12, 12]}>
                <Col xs={24} lg={9}>
                    <Card size="small" className={`q-gate ${data.gate.ok ? 'ok' : 'bad'}`}
                        title={<Space>{data.gate.ok ? <CheckCircleFilled style={{ color: '#1a7f37' }} /> : <CloseCircleFilled style={{ color: '#cf222e' }} />}{data.gate.ok ? 'Quality gate passed' : 'Quality gate failed'}</Space>}
                        extra={<Button size="small" type="text" icon={<SettingOutlined />} onClick={() => setGateOpen(true)}>Gate</Button>}>
                        {data.gate.rules.map((r) => (
                            <div key={r.name} className="q-rule">
                                {r.ok ? <CheckCircleFilled style={{ color: '#1a7f37' }} /> : <CloseCircleFilled style={{ color: '#cf222e' }} />}
                                <div><div>{r.name}</div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.detail}</Typography.Text></div>
                            </div>
                        ))}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Latest run: {when(latest.at)}{latest.project ? ` · ${latest.project}` : ''}{latest.env ? ` / ${latest.env}` : ''}{latest.source === 'report' ? ' · from a report folder' : ''}</Typography.Text>
                    </Card>
                </Col>
                <Col xs={24} lg={15}>
                    <div className="q-tiles">
                        {CLASS_ORDER.filter((c) => c !== 'skipped' || data.counts.skipped).map((c) => (
                            <Tooltip key={c} title={CLASS[c].about}>
                                <button className={`q-tile q-${c}`} onClick={() => showClass(c)}>
                                    <b>{data.counts[c]}</b><span>{CLASS[c].label}</span>
                                </button>
                            </Tooltip>
                        ))}
                        <Tooltip title="Scenarios tagged @quarantine.">
                            <button className="q-tile q-quarantined" onClick={() => goTab('quarantine')}><b>{data.counts.quarantined}</b><span>Quarantined</span></button>
                        </Tooltip>
                    </div>
                    <Card size="small" style={{ marginTop: 12 }} title="Pass rate per run">
                        <LineChart height={150} yMax={100} x={data.runs.map((_, i) => i + 1)} xMin={1} xMax={Math.max(2, data.runs.length)} xFormat={(v) => (Math.abs(v - Math.round(v)) < 0.01 ? `#${Math.round(v)}` : '')}
                            series={[{ name: 'Pass rate', color: '#1a7f37', values: data.runs.map((r) => r.passRate), unit: '%', area: true }, { name: 'Failed', color: '#cf222e', values: data.runs.map((r) => r.failed), right: true, integer: true }]} />
                    </Card>
                </Col>
                <Col xs={24} lg={12}>
                    <Card size="small" title="Top failure causes" extra={data.groups.length ? <a onClick={() => goTab('causes')}>All {data.groups.length}</a> : null}>
                        {data.groups.length ? data.groups.slice(0, 5).map((g) => (
                            <div key={g.signature} className="q-line" onClick={() => goTab('causes')}>
                                <Tag bordered={false} color={CATEGORY[g.category].color}>{CATEGORY[g.category].label}</Tag>
                                <span className="mono q-ellipsis">{g.signature}</span>
                                <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{g.scenarios.length} scenario{g.scenarios.length === 1 ? '' : 's'}</Typography.Text>
                            </div>
                        )) : <Typography.Text type="secondary">No failures in these runs.</Typography.Text>}
                    </Card>
                </Col>
                <Col xs={24} lg={12}>
                    <Card size="small" title="Least stable" extra={<a onClick={() => showClass('flaky')}>Flaky</a>}>
                        {(() => {
                            const worst = data.scenarios.filter((s) => s.cls === 'flaky' || s.cls === 'failing' || s.cls === 'new-failure').sort((a, b) => a.passRate - b.passRate).slice(0, 5);
                            return worst.length ? worst.map((s) => (
                                <div key={s.key} className="q-line" onClick={() => setOpen(s.key)}>
                                    <Tag bordered={false} color={CLASS[s.cls].color}>{CLASS[s.cls].label}</Tag>
                                    <span className="q-ellipsis">{s.name}</span>
                                    <History results={s.results} max={10} />
                                </div>
                            )) : <Typography.Text type="secondary">Every scenario passed in every run.</Typography.Text>;
                        })()}
                    </Card>
                </Col>
            </Row>
        </div>
    );

    const scenarios = (
        <div className="q-body">
            <div className="toolbar" style={{ paddingInline: 0 }}>
                <Segmented size="small" value={cls} onChange={(v) => setCls(v as QualityClass | 'all')}
                    options={[{ value: 'all', label: `All ${data.scenarios.length}` }, ...CLASS_ORDER.filter((c) => data.counts[c]).map((c) => ({ value: c, label: `${CLASS[c].label} ${data.counts[c]}` }))]} />
                <Checkbox checked={onlyQuarantined} onChange={(e) => setOnlyQuarantined(e.target.checked)}>Quarantined</Checkbox>
                <Input size="small" allowClear placeholder="Find a scenario or feature" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 240 }} aria-label="Find" />
                <span style={{ flex: 1 }} />
                {selected.length > 0 && <>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{selected.length} selected</Typography.Text>
                    <Button size="small" icon={<PlayCircleOutlined />} onClick={() => void runAgain(selected.map((k) => byKey.get(k)!).filter(Boolean))}>Run again</Button>
                </>}
            </div>
            <Table<QualityScenario> size="small" rowKey="key" dataSource={shown} pagination={shown.length > 100 ? { pageSize: 100, size: 'small' } : false} sticky
                rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
                onRow={(s) => ({ onClick: () => setOpen(s.key), style: { cursor: 'pointer' } })}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No scenarios match." /> }}
                columns={[
                    { title: 'Scenario', key: 'name', ellipsis: true, render: (_, s) => <div className="q-name"><span>{s.name}{s.quarantined && <Tag bordered={false} style={{ marginInlineStart: 6 }}>Quarantined</Tag>}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.feature}</Typography.Text></div> },
                    { title: 'Class', dataIndex: 'cls', width: 120, render: (c: QualityClass, s) => <Tooltip title={CLASS[c].about}><Tag bordered={false} color={CLASS[c].color}>{CLASS[c].label}{c === 'failing' && s.failingFor > 1 ? ` ×${s.failingFor}` : ''}</Tag></Tooltip> },
                    { title: 'Last runs', key: 'h', width: 230, render: (_, s) => <History results={s.results} /> },
                    { title: 'Pass rate', dataIndex: 'passRate', width: 90, align: 'right', sorter: (a, b) => a.passRate - b.passRate, render: (v: number) => `${v}%` },
                    { title: 'Last failure', dataIndex: 'lastFailure', width: 110, sorter: (a, b) => (a.lastFailure ?? '').localeCompare(b.lastFailure ?? ''), render: (v?: string) => <Tooltip title={when(v)}>{ago(v)}</Tooltip> },
                    { title: 'Avg time', dataIndex: 'avgDuration', width: 90, align: 'right', sorter: (a, b) => a.avgDuration - b.avgDuration, render: secs },
                ]} />
        </div>
    );

    const bugsFor = (g: FailureGroup): TriageBug[] => (bugs ?? []).filter((b) => b.id === g.triage?.bug || b.tags.includes(g.tag));
    const fileBug = (g: FailureGroup) => {
        let title = `Fails: ${g.signature}`.slice(0, 200);
        let filing = false;
        const inst = modal.confirm({
            title: 'File a bug in Azure DevOps', okText: 'File the bug', icon: <BugOutlined />, width: 560,
            content: <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">With the scenarios it fails in and the latest message. It is tagged <span className="mono">{g.tag}</span>: runs that fail the same way add a comment to it instead of filing another (ADO_CREATE_BUGS_ON_FAILURE).</Typography.Text>
                <Input.TextArea defaultValue={title} autoSize maxLength={255} onChange={(e) => { title = e.target.value; }} aria-label="Bug title" />
            </Space>,
            onOk: (close) => { void (async () => {
                if (filing) return; // a double click files one bug
                filing = true; inst.update({ okButtonProps: { loading: true } });
                try { const r = await api.triageFileBug({ tag: g.tag, title, ...(data?.project ? { project: data.project, qualityProject: data.project } : {}) }); message.success(`Bug ${r.id} filed.`); await load();  close(); } catch (e) { message.error(errText(e)); } finally { filing = false; inst.update({ okButtonProps: { loading: false } }); }
            })(); },
        });
    };

    const causes = (
        <div className="q-body">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}><BugSync project={data.project ?? undefined} onDone={() => void load()} /></div>
            {data.groups.length ? data.groups.map((g: FailureGroup) => (
                <Card key={g.signature} size="small" className="q-cause"
                    title={<Space size={8} wrap><Tag bordered={false} color={CATEGORY[g.category].color}>{CATEGORY[g.category].label}</Tag>{g.inLatest && <Badge status="error" text={<span style={{ fontSize: 12 }}>in the latest run</span>} />}</Space>}
                    extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{g.scenarios.length} scenario{g.scenarios.length === 1 ? '' : 's'} · {g.failures} failure{g.failures === 1 ? '' : 's'} in {g.runs} run{g.runs === 1 ? '' : 's'} · last {ago(g.lastSeen)}</Typography.Text>}>
                    <div className="mono q-sig">{g.signature}</div>
                    <TriageLine g={g} bugs={bugsFor(g)} onTriage={() => setTriaging(g)} onFile={() => fileBug(g)} />
                    <Space size={[4, 4]} wrap style={{ margin: '8px 0' }}>
                        {g.scenarios.map((s) => <Tag key={s.key} style={{ cursor: 'pointer' }} onClick={() => setOpen(s.key)}>{s.name}</Tag>)}
                    </Space>
                    <details><summary className="q-summary">Latest message</summary><pre className="q-pre">{g.sample}</pre></details>
                </Card>
            )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description="No failures in these runs." />}
        </div>
    );

    const q = data.quarantine;
    const quarantined = data.scenarios.filter((s) => s.quarantined);
    const quarantineTab = (
        <div className="q-body">
            {q.frameworkSupports === false
                ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="The installed framework version does not leave tagged scenarios out (EXCLUDE_TAGS). Update the framework package; until then quarantined scenarios still run." />
                : q.skipsQuarantined
                    ? <Alert type="success" showIcon style={{ marginBottom: 12 }} message={<>Runs leave out scenarios tagged @quarantine (EXCLUDE_TAGS={q.excludeTags}{q.from ? ` in ${q.from}` : ''}).</>} />
                    : <Alert type="info" showIcon style={{ marginBottom: 12 }}
                        message={<Tooltip title="Adding EXCLUDE_TAGS=@quarantine to the configuration makes every run (here, on the command line and in the pipeline) skip them. The gate leaves them out either way.">Quarantined scenarios still run: the configuration does not leave @quarantine out.</Tooltip>}
                        action={<Button size="small" onClick={async () => { try { const r = await api.excludeQuarantined(); message.success(`EXCLUDE_TAGS set in ${r.file}. Commit it under Source control.`); void load(); } catch (e) { message.error(errText(e)); } }}>Leave them out of runs</Button>} />}
            <Table<QualityScenario> size="small" rowKey="key" dataSource={quarantined} pagination={false}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing is quarantined. Quarantine a flaky scenario from its details (Scenarios tab)." /> }}
                onRow={(s) => ({ onClick: () => setOpen(s.key), style: { cursor: 'pointer' } })}
                columns={[
                    { title: 'Scenario', key: 'name', ellipsis: true, render: (_, s) => <div className="q-name"><span>{s.name}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.feature}</Typography.Text></div> },
                    { title: 'Why', key: 'why', ellipsis: true, render: (_, s) => s.note?.reason || <Typography.Text type="secondary">–</Typography.Text> },
                    { title: 'Since', key: 'since', width: 110, render: (_, s) => <Tooltip title={when(s.note?.at)}>{s.note ? ago(s.note.at) : '–'}</Tooltip> },
                    { title: 'Last runs', key: 'h', width: 230, render: (_, s) => <History results={s.results} /> },
                    { title: '', key: 'a', width: 100, render: (_, s) => <Button size="small" icon={<UndoOutlined />} onClick={(e) => { e.stopPropagation(); quarantine(s, false); }}>Release</Button> },
                ]} />
        </div>
    );

    return (
        <div className="panel quality" style={{ height: 'calc(100vh - var(--chrome))', display: 'flex', flexDirection: 'column' }}>
            {toolbar}
            <Tabs size="small" activeKey={tab} onChange={goTab} className="q-tabs" items={[
                { key: 'overview', label: 'Overview', children: overview },
                { key: 'scenarios', label: <>Scenarios <span className="q-count">{data.scenarios.length}</span></>, children: scenarios },
                { key: 'causes', label: <>Failure causes <span className="q-count">{data.groups.length}</span></>, children: causes },
                { key: 'quarantine', label: <>Quarantine <span className="q-count">{data.counts.quarantined}</span></>, children: quarantineTab },
                { key: 'team', label: 'Team (Azure DevOps)', children: tab === 'team' ? <div style={{ padding: 12 }}><TeamTrends project={data.project ?? undefined} localScenario={(n) => { const sc = data.scenarios.find((x) => x.name === n && x.file); return sc ? { file: sc.file!, line: sc.line } : undefined; }} /></div> : null },
            ]} />

            <TriageModal g={triaging} onClose={() => setTriaging(null)} onSaved={() => { setTriaging(null); void load(); }} />
            <Drawer open={!!current} onClose={() => setOpen(null)} width={640} title={<Typography.Text ellipsis={{ tooltip: current?.name }}>{current?.name}</Typography.Text>} destroyOnClose
                extra={current && <Space>
                    {current.file && <Button size="small" icon={<CodeOutlined />} onClick={() => navigate(['code', current.file!, current.line ?? 1])}>Open</Button>}
                    <Button size="small" icon={<PlayCircleOutlined />} onClick={() => void runAgain([current])}>Run again</Button>
                    {current.quarantined
                        ? <Button size="small" icon={<UndoOutlined />} onClick={() => quarantine(current, false)}>Release</Button>
                        : <Button size="small" icon={<StopOutlined />} onClick={() => quarantine(current, true)}>Quarantine</Button>}
                </Space>}>
                {current && <>
                    <Space size={6} style={{ marginBottom: 8 }} wrap>
                        <Tooltip title={CLASS[current.cls].about}><Tag bordered={false} color={CLASS[current.cls].color}>{CLASS[current.cls].label}</Tag></Tooltip>
                        {current.quarantined && <Tag bordered={false}>Quarantined{current.note?.reason ? `: ${current.note.reason}` : ''}</Tag>}
                    </Space>
                    <Tabs size="small" defaultActiveKey="summary" items={[
                        { key: 'summary', label: 'Summary', children: <Descriptions size="small" column={2} bordered items={[
                            { label: 'Feature', children: current.feature, span: 2 },
                            ...(current.file ? [{ label: 'File', children: <span className="mono" style={{ overflowWrap: 'anywhere' }}>{current.file}:{current.line}</span>, span: 2 }] : []),
                            { label: 'Pass rate', children: `${current.passRate}% of ${current.results.filter((r) => r.status !== 'skipped').length} runs` },
                            { label: 'Average time', children: secs(current.avgDuration) },
                            { label: 'Switched pass ↔ fail', children: `${current.flips} time${current.flips === 1 ? '' : 's'}` },
                            { label: 'Passed after a retry', children: `${current.retriedPasses} run${current.retriedPasses === 1 ? '' : 's'}` },
                            { label: 'Last passed', children: when(current.lastPass) },
                            { label: 'Last failed', children: when(current.lastFailure) },
                        ]} /> },
                        { key: 'runs', label: <>Runs <span className="q-count">{current.results.length}</span></>, children: [...current.results].reverse().map((r, i) => (
                            <div key={i} className="q-result">
                                <i className={`q-dot ${r.status === 'passed' ? (r.retries ? 'retried' : 'pass') : r.status === 'failed' ? 'fail' : 'skip'}`} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div className="q-result-head">
                                        <span>{when(r.at)}</span>
                                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.status}{r.retries ? ` after ${r.retries} retr${r.retries === 1 ? 'y' : 'ies'}` : ''} · {secs(r.duration)}</Typography.Text>
                                        {!r.run.startsWith('report:') && <a style={{ fontSize: 12 }} onClick={() => navigate(['runs', r.run])}>Run</a>}
                                    </div>
                                    {r.error && <details><summary className="q-summary mono">{firstLine(r.error).slice(0, 200)}</summary><pre className="q-pre">{r.error}</pre></details>}
                                </div>
                            </div>
                        )) },
                    ]} />
                </>}
            </Drawer>

            <GateModal open={gateOpen} value={data.settings} version={data.settingsVersion} onClose={() => setGateOpen(false)} onSaved={() => { setGateOpen(false); void load(); }} onReload={() => void load()} />
        </div>
    );
}

/**
 * A gate number as typed. InputNumber keeps its last good value when letters are typed ("abc" + Enter saved the old
 * value and said "Gate saved."), so the field holds the text and the rule says what is wrong with it.
 */
function GateNumber({ value, onChange, id, addonAfter, label }: { value?: number | string | null; onChange?: (v: number | string | null) => void; id?: string; addonAfter?: string; label: string }) {
    return (
        <Input id={id} inputMode="numeric" aria-label={label} addonAfter={addonAfter} value={value === null || value === undefined ? '' : String(value)}
            onChange={(e) => { const t = e.target.value; const x = t.trim(); onChange?.(x === '' ? null : /^\d+$/.test(x) ? Number(x) : t); }} />
    );
}

const wholeRule = (what: string, min: number, max: number | undefined, empty: string | null) => ({ validator: (_: unknown, v: unknown) => {
    const range = max === undefined ? `a whole number, ${min} or more` : `a whole number from ${min} to ${max}`;
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return empty ? Promise.reject(new Error(empty)) : Promise.resolve();
    if (typeof v === 'number' && Number.isInteger(v) && v >= min && (max === undefined || v <= max)) return Promise.resolve();
    const t = String(v).trim();
    const why = /^-/.test(t) ? 'no negative numbers' : /^-?\d*[.,]\d*$/.test(t) ? 'no decimals' : /^\d+$/.test(t) ? `not ${t}` : 'numbers only';
    return Promise.reject(new Error(`${what}: ${why} (${range}).`));
} });

function GateModal({ open, value, version, onClose, onSaved, onReload }: { open: boolean; value: GateSettings; version?: string; onClose: () => void; onSaved: () => void; onReload: () => void }) {
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<GateSettings & { limitFlaky: boolean }>();
    React.useEffect(() => { if (open) form.setFieldsValue({ ...value, limitFlaky: value.maxFlaky !== null, maxFlaky: value.maxFlaky ?? 0 }); }, [open, value, form]);
    const limit = Form.useWatch('limitFlaky', form);
    const [saving, setSaving] = React.useState(false);
    const saveGate = async () => {
        let v: GateSettings & { limitFlaky: boolean };
                try { v = await form.validateFields(); } catch { return; }
                if (saving) return;
                setSaving(true);
                const g = { minPassRate: v.minPassRate, noNewFailures: v.noNewFailures, ignoreQuarantined: v.ignoreQuarantined, maxFlaky: v.limitFlaky ? v.maxFlaky ?? 0 : null };
                const put = async (force: boolean): Promise<void> => {
                    try { await api.qualityGate(g, version, force); message.success('Gate saved.'); onSaved(); }
                    catch (e) {
                        // Saved in another tab since this one read it: Reload / Overwrite / Keep editing.
                        if (isChangedElsewhere(e)) askChangedElsewhere(modal, e, 'The quality gate', { reload: onReload, overwrite: () => put(true) });
                        else message.error(errText(e));
                    }
                };
                try { await put(false); } finally { setSaving(false); }
    };
    return (
        <Modal open={open} title="Quality gate" okText="Save" onCancel={onClose} destroyOnClose
            okButtonProps={{ loading: saving }}
            onOk={() => void saveGate()}>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>Checked on the latest run. Kept on this computer for this repository.</Typography.Text>
            <Form form={form} layout="vertical" requiredMark={false} onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); void saveGate(); } }}>
                <Row gutter={16}>
                    <Col span={12}><Form.Item name="minPassRate" label="Pass rate at least" rules={[wholeRule('The pass rate', 0, 100, 'Give a pass rate (0–100).')]}><GateNumber addonAfter="%" label="Pass rate at least" /></Form.Item></Col>
                    <Col span={12}><Form.Item name="noNewFailures" label="No new failures" valuePropName="checked"><Switch size="small" /></Form.Item></Col>
                    <Col span={12}><Form.Item name="limitFlaky" label="Limit flaky scenarios" valuePropName="checked"><Switch size="small" /></Form.Item></Col>
                    <Col span={12}>{limit && <Form.Item name="maxFlaky" label="At most" rules={[wholeRule('The number of flaky scenarios', 0, undefined, null)]}><GateNumber addonAfter="flaky" label="At most flaky scenarios" /></Form.Item>}</Col>
                    <Col span={12}><Form.Item name="ignoreQuarantined" label="Leave out quarantined" valuePropName="checked"><Switch size="small" /></Form.Item></Col>
                </Row>
            </Form>
        </Modal>
    );
}
