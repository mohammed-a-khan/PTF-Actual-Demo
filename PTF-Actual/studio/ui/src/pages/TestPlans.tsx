/**
 * Azure DevOps → Test plans: plans and their suites; a suite's test cases (test points) with their latest
 * outcome and the scenarios tagged with them, and whether each scenario's results really go to this suite.
 *
 * As the framework publishes (CSADOTagExtractor / CSADOPublisher): a scenario's results go to the test points
 * of its test cases (@TestCaseId on the scenario, else on the feature) in ONE plan and suite: @TestPlanId /
 * @TestSuiteId of the scenario, else of the feature, else ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID of the
 * project's configuration, and only when ADO_INTEGRATION_ENABLED is on. A test case that is not in that suite
 * gets nothing; with several configurations in the suite, one test point per test case is used.
 */
import React from 'react';
import { ErrorAlert } from '../components/ErrorAlert';
import { Alert, App, Button, Checkbox, Dropdown, Empty, Input, Modal, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Tree, Typography } from 'antd';
import { CodeOutlined, ExportOutlined, MoreOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, SyncOutlined, WarningOutlined } from '@ant-design/icons';
import { AdoPublishing, AdoScope, api, RepoScenario, TestPlanDef, TestPointDef, TestSuiteDef } from '../api';
import { errText, loadRunTarget, useStudio } from '../state';
import { navigate, useRoute } from '../route';
import '../styles-tests.css';

const OUTCOME: Record<string, string> = { passed: 'success', failed: 'error', blocked: 'warning', 'not applicable': 'default', 'in progress': 'processing', paused: 'default', 'not run': 'default' };
const OUTCOME_ORDER = ['passed', 'failed', 'blocked', 'in progress', 'not applicable', 'paused', 'not run'];
const FROM: Record<string, string> = { scenario: 'scenario tags', feature: 'feature tags', config: 'configuration' };
const ago = (iso?: string) => {
    if (!iso) return '–';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const target = (s: RepoScenario) => (s.plan && s.suite ? `plan ${s.plan}, suite ${s.suite}` : !s.plan && !s.suite ? 'no plan or suite' : !s.plan ? `suite ${s.suite}, no plan` : `plan ${s.plan}, no suite`);
const targetFrom = (s: RepoScenario) => [s.planFrom && `plan from ${FROM[s.planFrom]}`, s.suiteFrom && `suite from ${FROM[s.suiteFrom]}`].filter(Boolean).join(', ');
type Steps = Array<{ action: string; expected: string }>;

function StepsTable({ steps }: { steps: Steps }) {
    return <Table size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={steps} columns={[
        { title: '#', width: 40, render: (_, __, i) => i + 1 },
        { title: 'Action', dataIndex: 'action', render: (v: string) => <span style={{ whiteSpace: 'pre-wrap' }}>{v}</span> },
        { title: 'Expected result', dataIndex: 'expected', render: (v: string) => <span style={{ whiteSpace: 'pre-wrap' }}>{v || <Typography.Text type="secondary">–</Typography.Text>}</span> },
    ]} />;
}

/** The scenarios tagged with a test case, and where their results go. */
function Automation({ p, plan, suite, combines }: { p: TestPointDef; plan: number; suite: number; combines: boolean }) {
    const [all, setAll] = React.useState(false);
    if (!p.scenarios.length) {
        return p.automationStatus === 'Automated'
            ? <Tooltip title={`Azure DevOps says automated by "${p.automatedTestName ?? ''}", but no scenario here is tagged @TestCaseId:${p.testCase}.`}><Tag bordered={false} color="warning">Automated elsewhere</Tag></Tooltip>
            : <Typography.Text type="secondary">Not automated</Typography.Text>;
    }
    const here = p.scenarios.filter((s) => s.status === 'here').length;
    const list = all ? p.scenarios : p.scenarios.slice(0, 3);
    return <div className="tp-scenarios">
        {here > 1 && (combines
            ? <Tooltip title={`The test case's result in a run combines these ${here} scenarios: it fails when any of them fails, and its comment lists each one.`}>
                <Tag bordered={false} style={{ alignSelf: 'flex-start' }}>{here} scenarios share this test case: any failure fails it</Tag></Tooltip>
            : <Tooltip title={`The installed framework version updates this test case's one result for each of these ${here} scenarios: the run keeps the outcome of the scenario that ran last, so an earlier failure can be replaced by a later pass. Newer versions combine them.`}>
                <Tag bordered={false} color="warning" style={{ alignSelf: 'flex-start' }}><WarningOutlined /> {here} scenarios share this test case: the last result wins</Tag></Tooltip>)}
        {list.map((s) => (
        <div key={`${s.file}:${s.line}`}>
            <a onClick={() => navigate(['code', s.file, s.line])} title={`${s.file}:${s.line}`}><CodeOutlined /> {s.name}</a>
            {s.status === 'here'
                ? <Tooltip title={`Results are published here (${targetFrom(s)}).`}><Tag bordered={false} color="success">publishes here</Tag></Tooltip>
                : s.status === 'elsewhere'
                    ? <Tooltip title={`Its results go to ${target(s)} (${targetFrom(s)}), not to plan ${plan}, suite ${suite}.`}><Tag bordered={false} color="warning">publishes to {s.plan}/{s.suite}</Tag></Tooltip>
                    : <Tooltip title={`No ${!s.plan ? 'plan' : 'suite'}: tag the feature or scenario (@TestPlanId / @TestSuiteId) or set ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID. The framework publishes nothing for it.`}><Tag bordered={false}>not published</Tag></Tooltip>}
        </div>
    ))}
        {p.scenarios.length > 3 && <a style={{ fontSize: 12 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `${p.scenarios.length - 3} more`}</a>}
    </div>;
}

export function TestPlans() {
    const { message, modal } = App.useApp();
    const { env: disc } = useStudio();
    const route = useRoute();
    const here = route[0] === 'testplans';
    const planId = here && /^\d+$/.test(route[1] ?? '') ? Number(route[1]) : null;
    const suiteId = here && /^\d+$/.test(route[2] ?? '') ? Number(route[2]) : null;
    const saved = loadRunTarget();
    // Which project and environment's settings (ADO_PROJECT, ADO_TEST_PLAN_ID…) apply.
    const [scope, setScope] = React.useState<AdoScope>(() => (saved?.project ? { project: saved.project, env: saved.env } : {}));
    const [plans, setPlans] = React.useState<{ adoProject: string; project: string; env: string; plans: TestPlanDef[] } | null>(null);
    const [suites, setSuites] = React.useState<TestSuiteDef[] | null>(null);
    const [data, setData] = React.useState<{ points: TestPointDef[]; publishing: AdoPublishing; missing: Array<{ testCase: number; file: string; line: number; name: string }> } | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [find, setFind] = React.useState('');
    const [adding, setAdding] = React.useState(false);
    // The suite's test cases, or how they are covered and published (remembered on this computer).
    const [tpTab, setTpTabRaw] = React.useState<string>(() => { try { return localStorage.getItem('cs-studio-testplans-tab') === 'coverage' ? 'coverage' : 'cases'; } catch { return 'cases'; } });
    const setTpTab = (k: string) => { setTpTabRaw(k); try { localStorage.setItem('cs-studio-testplans-tab', k); } catch { /* private mode */ } };

    const loadPlans = React.useCallback(async () => {
        setErr(null);
        try { const r = await api.testPlans(scope); setPlans(r); if (!scope.project) setScope((s) => ({ ...s, project: r.project, env: r.env })); } catch (e) { setErr(errText(e)); }
    }, [scope]);
    React.useEffect(() => { if (here) void loadPlans(); }, [here, scope.project, scope.env, scope.adoProject]); // eslint-disable-line react-hooks/exhaustive-deps
    // An address that is not a plan (#/testplans/bogus) is rewritten in place to the screen's own (then its first plan).
    React.useEffect(() => { if (here && route.length > 1 && (planId === null || (route.length > 2 && suiteId === null) || route.length > 3)) navigate(planId === null ? ['testplans'] : ['testplans', planId], true); }, [here, route, planId, suiteId]);
    React.useEffect(() => { if (here && plans?.plans.length && (planId === null || !plans.plans.some((p) => p.id === planId))) navigate(['testplans', plans.plans[0].id], true); }, [here, plans, planId]);
    const plan = plans?.plans.find((p) => p.id === planId) ?? null;
    React.useEffect(() => {
        setSuites(null);
        if (!plan) return;
        api.testSuites(plan.id, scope).then((r) => { setSuites(r.suites); if (suiteId === null || !r.suites.some((s) => s.id === suiteId)) navigate(['testplans', plan.id, plan.rootSuite], true); }).catch((e) => setErr(errText(e)));
    }, [plan?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    const suite = suites?.find((s) => s.id === suiteId) ?? null;
    const loadPoints = React.useCallback(async () => {
        if (!plan || !suite) return;
        setLoading(true);
        try { setData(await api.testPoints(plan.id, suite.id, scope)); } catch (e) { setErr(errText(e)); } finally { setLoading(false); }
    }, [plan, suite, scope]);
    React.useEffect(() => { setData(null); void loadPoints(); }, [loadPoints]);

    const tree = React.useMemo(() => {
        const kids = new Map<number | null, TestSuiteDef[]>();
        for (const s of suites ?? []) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
        const node = (s: TestSuiteDef): { key: number; title: React.ReactNode; children: unknown[] } => ({
            key: s.id,
            title: <span>{s.name} <Typography.Text type="secondary" style={{ fontSize: 11 }}>{s.id}</Typography.Text>{s.type !== 'staticTestSuite' && <Tag bordered={false} style={{ marginInlineStart: 6, fontSize: 11 }}>{s.type === 'requirementTestSuite' ? `story ${s.requirementId ?? ''}` : 'query'}</Tag>}</span>,
            children: (kids.get(s.id) ?? []).map(node),
        });
        return (kids.get(null) ?? []).map(node);
    }, [suites]);

    const points = data?.points ?? [];
    const shown = points.filter((p) => !find || `${p.testCase} ${p.title} ${p.configuration}`.toLowerCase().includes(find.toLowerCase()));
    const cases = new Set(points.map((p) => p.testCase));
    const publishing = new Set(points.filter((p) => p.scenarios.some((s) => s.status === 'here')).map((p) => p.testCase));
    const tagged = new Set(points.filter((p) => p.scenarios.length).map((p) => p.testCase));
    const outcomes = OUTCOME_ORDER.map((o) => ({ o, n: points.filter((p) => p.outcome === o).length })).filter((x) => x.n);
    // Test cases with a test point per configuration: the framework publishes to one of them.
    const perCase = new Map<number, number>();
    for (const p of points) perCase.set(p.testCase, (perCase.get(p.testCase) ?? 0) + 1);
    const multiConfig = [...perCase.values()].filter((n) => n > 1).length;

    const runScenarios = (list: TestPointDef[]) => {
        const sc = list.flatMap((p) => p.scenarios);
        if (!sc.length) { message.warning('None of these test cases has a scenario in this repository.'); return; }
        const names = [...new Set(sc.map((s) => s.name))];
        const p = data?.publishing.project ?? plans?.project;
        if (!p) return;
        const choices = disc?.environments[p] ?? [];
        let env = data?.publishing.env ?? 'dev';
        modal.confirm({
            title: `Run ${names.length} scenario${names.length === 1 ? '' : 's'}`, okText: 'Run', icon: <PlayCircleOutlined />,
            content: <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">On this computer, project {p}. {data?.publishing.enabled ? 'ADO_INTEGRATION_ENABLED is on: results are published to Azure DevOps (to each scenario\'s plan and suite).' : 'Results are not published to Azure DevOps (ADO_INTEGRATION_ENABLED is off for this environment).'}</Typography.Text>
                <Select defaultValue={env} style={{ width: 200 }} onChange={(v) => { env = v; }} options={(choices.length ? choices : [env]).map((e) => ({ value: e, label: e }))} aria-label="Environment" />
            </Space>,
            onOk: async () => { try { const run = await api.startRun({ project: p, env, scenarios: names }); navigate(['runs', run.id]); } catch (e) { message.error(errText(e)); } },
        });
    };
    const syncSteps = async (pt: TestPointDef) => {
        const sc = pt.scenarios.find((s) => s.status === 'here') ?? pt.scenarios[0];
        let steps: Steps;
        try { steps = (await api.scenarioSteps(sc)).steps; } catch (e) { message.error(errText(e)); return; }
        let mark = true;
        let busy = false;
        const inst = modal.confirm({
            title: `Update test case ${pt.testCase} from its scenario?`, width: 760, okText: 'Update in Azure DevOps',
            content: <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">Replaces the steps of "{pt.title}" in Azure DevOps with the steps of "{sc.name}" ({sc.file}:{sc.line}):</Typography.Text>
                <StepsTable steps={steps} />
                <Checkbox defaultChecked onChange={(e) => { mark = e.target.checked; }}>Mark it as automated by this scenario</Checkbox>
            </Space>,
            onOk: (close) => { void (async () => { if (busy) return; busy = true; inst.update({ okButtonProps: { loading: true } }); try { await api.syncTestCase(pt.testCase, sc, mark, scope); message.success(`Test case ${pt.testCase} updated.`); void loadPoints();  close(); } catch (e) { message.error(errText(e)); } finally { busy = false; inst.update({ okButtonProps: { loading: false } }); } })(); },
        });
    };

    const projects = disc?.projects ?? [];
    const envs = scope.project ? disc?.environments[scope.project] ?? [] : [];
    const scopeBar = (
        <Space size={6} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Settings of</Typography.Text>
            <Select size="small" value={scope.project ?? plans?.project} style={{ width: 140 }} aria-label="Project" onChange={(v) => setScope((s) => ({ ...s, project: v, env: (disc?.environments[v] ?? [])[0] }))} options={projects.map((p) => ({ value: p, label: p }))} />
            <Select size="small" value={scope.env ?? plans?.env} style={{ width: 100 }} aria-label="Environment" onChange={(v) => setScope((s) => ({ ...s, env: v }))} options={envs.map((e) => ({ value: e, label: e }))} />
        </Space>
    );

    if (err && !plans) return <div className="panel" style={{ padding: 16 }}><Space direction="vertical" style={{ width: '100%' }}>{scopeBar}<ErrorAlert title="Azure DevOps test plans could not be read" error={err} onRetry={() => void loadPlans()} /></Space></div>;
    if (!plans) return <div className="panel" style={{ padding: 24 }}><Spin /></div>;
    if (!plans.plans.length) return <div className="panel" style={{ padding: 16 }}>{scopeBar}<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 60 }} description={`No active test plans in ${plans.adoProject}.`} /></div>;
    const pub = data?.publishing;

    return (
        <div className="panel tp" style={{ height: 'calc(100vh - var(--chrome))', display: 'flex', minHeight: 0 }}>
            <div className="tp-side">
                <Select showSearch size="small" value={plan?.id} style={{ width: '100%' }} aria-label="Test plan" optionFilterProp="label"
                    onChange={(id) => navigate(['testplans', id])} options={plans.plans.map((p) => ({ value: p.id, label: `${p.name} (${p.id})` }))} />
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '6px 2px' }}>{plans.adoProject}{plan?.iteration ? ` · ${plan.iteration}` : ''}</Typography.Text>
                {!suites ? <Spin size="small" /> : <Tree blockNode defaultExpandAll selectedKeys={suite ? [suite.id] : []} treeData={tree as never}
                    onSelect={(k) => k.length && plan && navigate(['testplans', plan.id, Number(k[0])])} />}
            </div>
            <div className="tp-main">
                <div className="toolbar">
                    {scopeBar}
                    <span style={{ flex: 1 }} />
                    {pub && <Tooltip title="Where results of scenarios without @TestPlanId / @TestSuiteId tags go (ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID), and whether runs publish at all (ADO_INTEGRATION_ENABLED).">
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            Publishing {pub.enabled ? <Tag bordered={false} color="success">on</Tag> : <Tag bordered={false}>off</Tag>}
                            default {pub.plan ? `plan ${pub.plan}` : 'no plan'}, {pub.suite ? `suite ${pub.suite}` : 'no suite'}
                        </Typography.Text>
                    </Tooltip>}
                </div>
                {err && <Alert type="warning" showIcon closable onClose={() => setErr(null)} message={err} style={{ margin: 12 }} />}
                {suite && plan && <>
                    <div className="toolbar">
                        <b>{suite.name}</b>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>suite {suite.id} · {cases.size} test case{cases.size === 1 ? '' : 's'}</Typography.Text>
                        <span style={{ flex: 1 }} />
                        <Input size="small" allowClear placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 160 }} aria-label="Find" />
                        <Button size="small" icon={<PlayCircleOutlined />} disabled={!tagged.size} onClick={() => runScenarios(points)}>Run automated ({tagged.size})</Button>
                        <Tooltip title={suite.type !== 'staticTestSuite' ? 'Test cases can be added to static suites only.' : ''}>
                            <Button size="small" icon={<PlusOutlined />} disabled={suite.type !== 'staticTestSuite'} onClick={() => setAdding(true)}>Add scenarios</Button>
                        </Tooltip>
                        <Button size="small" icon={<ExportOutlined />} href={plan.web.replace(/suiteId=\d+/, `suiteId=${suite.id}`)} target="_blank" rel="noreferrer" aria-label="Open in Azure DevOps" />
                        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadPoints()} aria-label="Refresh" />
                    </div>
                    <Tabs size="small" className="tests-panel-tabs" activeKey={tpTab} onChange={setTpTab} items={[
                        { key: 'cases', label: <>Test cases <span className="q-count">{cases.size}</span></>, children: <div style={{ height: '100%', overflow: 'auto' }}>
                        <Table<TestPointDef> size="small" rowKey="id" loading={loading && !data} dataSource={shown} pagination={shown.length > 100 ? { pageSize: 100, size: 'small' } : false} sticky scroll={{ x: 1040 }} tableLayout="fixed"
                            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={data ? 'This suite has no test cases.' : 'Loading…'} /> }}
                            columns={[
                                { title: 'Test case', key: 'tc', width: 280, ellipsis: { showTitle: false }, render: (_, p) => <Tooltip title={`${p.testCase} ${p.title}`}><span><Typography.Text type="secondary" className="mono" style={{ fontSize: 12, marginInlineEnd: 6 }}>{p.testCase}</Typography.Text><a onClick={() => navigate(['work', p.testCase])}>{p.title}</a></span></Tooltip> },
                                { title: 'Configuration', dataIndex: 'configuration', width: 130, ellipsis: true },
                                { title: 'Outcome', dataIndex: 'outcome', width: 105, render: (o: string) => <Tag bordered={false} color={OUTCOME[o] ?? 'default'}>{o}</Tag> },
                                { title: 'Last run', key: 'last', width: 110, render: (_, p) => p.lastRun ? <Tooltip title={`${new Date(p.lastRun).toLocaleString()}${p.lastRunBy ? ` by ${p.lastRunBy}` : ''}`}>{ago(p.lastRun)}</Tooltip> : <Typography.Text type="secondary">never</Typography.Text> },
                                { title: 'Scenario and where its results go', key: 'auto', width: 340, render: (_, p) => <Automation p={p} plan={plan.id} suite={suite.id} combines={!!data?.publishing.combines} /> },
                                { title: '', key: 'act', width: 44, render: (_, p) => <Dropdown trigger={['click']} menu={{ items: [
                                    { key: 'run', icon: <PlayCircleOutlined />, label: 'Run its scenario', disabled: !p.scenarios.length, onClick: () => runScenarios([p]) },
                                    { key: 'sync', icon: <SyncOutlined />, label: 'Update steps from its scenario…', disabled: !p.scenarios.length, onClick: () => void syncSteps(p) },
                                    { key: 'new', icon: <PlusOutlined />, label: 'Write a scenario for it', disabled: p.scenarios.length > 0, onClick: () => navigate(['work', p.testCase]) },
                                    { key: 'ado', icon: <ExportOutlined />, label: <a href={`${plan.web.replace(/\/_testPlans.*$/, '')}/_workitems/edit/${p.testCase}`} target="_blank" rel="noreferrer">Open in Azure DevOps</a> },
                                ] }}><Button size="small" type="text" icon={<MoreOutlined />} aria-label="Actions" /></Dropdown> },
                            ]} />
                    </div> },
                        { key: 'coverage', label: <>Coverage and publishing{data && (data.missing.length + (multiConfig ? 1 : 0)) > 0 ? <span className="q-count" style={{ color: '#d48806' }}>{data.missing.length + (multiConfig ? 1 : 0)}</span> : null}</>, children: <div style={{ padding: '8px 0' }}>
                    {data && (data.missing.length > 0 || multiConfig > 0) && <div style={{ padding: '0 12px' }}>
                        {data.missing.length > 0 && <Alert type="warning" showIcon icon={<WarningOutlined />} style={{ marginBottom: 8 }}
                            message={`${data.missing.length} scenario${data.missing.length === 1 ? ' publishes' : 's publish'} to this suite for test cases that are not in it: the framework finds no test point and publishes nothing for them.`}
                            description={<Space size={[6, 4]} wrap>{data.missing.map((m) => <a key={`${m.file}:${m.line}:${m.testCase}`} onClick={() => navigate(['code', m.file, m.line])}>{m.name} (@TestCaseId:{m.testCase})</a>)}</Space>} />}
                        {multiConfig > 0 && <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`${multiConfig} test case${multiConfig === 1 ? ' has' : 's have'} several configurations in this suite. ${
                            data.publishing.chooses
                                ? (data.publishing.configuration ? `Results go to the configuration(s) in ADO_TEST_CONFIGURATION (${data.publishing.configuration}).` : 'Without ADO_TEST_CONFIGURATION, results go to the first configuration Azure DevOps lists; set it (e.g. ADO_TEST_CONFIGURATION=Chrome) to choose.')
                                : 'The installed framework version publishes to the first configuration Azure DevOps lists; newer versions choose with ADO_TEST_CONFIGURATION.'}`} />}
                    </div>}
                    {points.length > 0 && <div className="tp-summary">
                        <div>
                            <span>Published here by a scenario of this repository</span>
                            <div className="tp-bar"><i style={{ width: `${(publishing.size / Math.max(1, cases.size)) * 100}%` }} /></div>
                            <b>{publishing.size} of {cases.size}{tagged.size > publishing.size ? ` (${tagged.size - publishing.size} more tagged but publishing elsewhere)` : ''}</b>
                        </div>
                        <div>
                            <span>Latest outcomes</span>
                            <div className="tp-bar tp-stack">{outcomes.map((x) => <i key={x.o} className={`tp-o-${x.o.replace(/ /g, '-')}`} style={{ width: `${(x.n / points.length) * 100}%` }} />)}</div>
                            <Space size={10} wrap>{outcomes.map((x) => <span key={x.o} className="tp-legend"><i className={`tp-o-${x.o.replace(/ /g, '-')}`} />{x.n} {x.o}</span>)}</Space>
                        </div>
                    </div>}
                        {data && !points.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="This suite has no test cases." />}
                        </div> },
                    ]} />
                </>}
            </div>
            {plan && suite && <AddScenarios open={adding} plan={plan} suite={suite} scope={scope} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void loadPoints(); }} />}
        </div>
    );
}

/** Pick scenarios; preview their test steps and the tags they get; create them as test cases in the suite. */
function AddScenarios({ open, plan, suite, scope, onClose, onDone }: { open: boolean; plan: TestPlanDef; suite: TestSuiteDef; scope: AdoScope; onClose: () => void; onDone: () => void }) {
    const { message } = App.useApp();
    const [all, setAll] = React.useState<RepoScenario[] | null>(null);
    const [picked, setPicked] = React.useState<string[]>([]);
    const [find, setFind] = React.useState('');
    const [showLinked, setShowLinked] = React.useState(false);
    const [preview, setPreview] = React.useState<{ s: RepoScenario; steps: Steps } | null>(null);
    const [mark, setMark] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => { if (open) { setPicked([]); setPreview(null); api.repoScenarios(scope).then((r) => setAll(r.scenarios)).catch((e) => message.error(errText(e))); } }, [open, message]); // eslint-disable-line react-hooks/exhaustive-deps
    const key = (s: RepoScenario) => `${s.file}:${s.line}`;
    const list = (all ?? []).filter((s) => (showLinked || !s.testCases.length) && (!find || `${s.name} ${s.feature} ${s.file}`.toLowerCase().includes(find.toLowerCase())));
    const chosen = (all ?? []).filter((s) => picked.includes(key(s)));
    const goesHere = (s: RepoScenario) => s.plan === plan.id && s.suite === suite.id;
    const show = async (s: RepoScenario) => { try { setPreview({ s, steps: (await api.scenarioSteps(s)).steps }); } catch (e) { message.error(errText(e)); } };
    return (
        <Modal open={open} width={940} title={`Add scenarios to "${suite.name}" (suite ${suite.id})`} onCancel={onClose} destroyOnClose
            okText={`Create ${chosen.length || ''} test case${chosen.length === 1 ? '' : 's'} in Azure DevOps`} okButtonProps={{ disabled: !chosen.length, loading: busy }}
            onOk={async () => {
                setBusy(true);
                try {
                    const r = await api.addScenariosToSuite(plan.id, suite.id, chosen.map((s) => ({ file: s.file, line: s.line, name: s.name })), mark, scope);
                    message.success(`Created ${r.created.map((c) => c.id).join(', ')} and tagged the scenarios. Commit the feature files under Source control.`);
                    onDone();
                } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
            }}>
            <Tooltip title={`Each scenario becomes a test case in this suite (the plan's area and iteration), with its steps as test steps, and is tagged @TestCaseId with the new id. A scenario whose results would go to another plan or suite also gets @TestPlanId:${plan.id} @TestSuiteId:${suite.id}, so the framework publishes its results here.`}>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>Each chosen scenario becomes a test case here and is tagged with its id.</Typography.Text>
            </Tooltip>
            <Space style={{ marginBottom: 8 }} wrap>
                <Input size="small" allowClear placeholder="Find a scenario" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 240 }} aria-label="Find a scenario" />
                <Checkbox checked={showLinked} onChange={(e) => setShowLinked(e.target.checked)}>Also scenarios that already have a test case</Checkbox>
                <Checkbox checked={mark} onChange={(e) => setMark(e.target.checked)}>Mark them as automated</Checkbox>
            </Space>
            <div style={{ display: 'flex', gap: 12, minHeight: 320 }}>
                <div style={{ flex: 1.1, maxHeight: 440, overflow: 'auto' }}>
                    <Table<RepoScenario> size="small" rowKey={key} dataSource={list} loading={!all} pagination={false}
                        rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as string[]) }}
                        onRow={(s) => ({ onClick: () => void show(s), style: { cursor: 'pointer' } })}
                        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Every scenario already has a test case." /> }}
                        columns={[
                            { title: 'Scenario', key: 'n', ellipsis: true, render: (_, s) => <div className="q-name"><span>{s.name}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.file}</Typography.Text></div> },
                            { title: 'Results go to', key: 't', width: 150, render: (_, s) => <Tooltip title={targetFrom(s) || 'No @TestPlanId / @TestSuiteId tags and no ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID.'}>
                                {goesHere(s) ? <Tag bordered={false} color="success">this suite</Tag> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>{target(s)}</Typography.Text>}</Tooltip> },
                        ]} />
                </div>
                <div style={{ flex: 1, maxHeight: 440, overflow: 'auto' }}>
                    {preview ? <>
                        <Typography.Text strong>Tags it gets</Typography.Text>
                        <div className="mono" style={{ fontSize: 12, margin: '4px 0 10px' }}>@TestCaseId:&lt;new id&gt;{goesHere(preview.s) ? '' : ` @TestPlanId:${plan.id} @TestSuiteId:${suite.id}`}</div>
                        <Typography.Text strong>Test steps</Typography.Text>
                        <StepsTable steps={preview.steps} />
                    </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Click a scenario to see its test steps and the tags it gets." />}
                </div>
            </div>
        </Modal>
    );
}
