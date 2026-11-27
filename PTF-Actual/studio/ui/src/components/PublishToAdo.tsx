/**
 * Publish a finished run's results to Azure DevOps Test Plans. Only this run's results are sent.
 *
 * Where: the Azure DevOps organization and project come from the run's configuration (ADO_ORGANIZATION,
 * ADO_PROJECT); the project can be changed. Then either the scenarios' tags decide the plan, suite and test
 * cases (as the framework does in the pipeline), or a plan and suite are chosen here and a scenario of the run
 * is picked for each test case (one scenario can serve several test cases). Every test case and test point has
 * a tick box (all ticked to start with). Optionally the mapping is written back to the feature files as tags.
 */
import React from 'react';
import { Alert, App, Button, Checkbox, Input, Modal, Segmented, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import { api, PublishDoneDef, PublishGroupDef, PublishItemDef, PublishOutcome, PublishPreviewDef, PublishScenarioDef, RunInfo, TestPlanDef, TestSuiteDef } from '../api';
import { errText } from '../state';

type Mode = 'tags' | 'suite';
/** What is ticked for one test case of one suite. */
interface Pick { points: number[]; scenarios: string[] }
const caseKey = (g: { plan: number; suite: number }, tc: number) => `${g.plan}/${g.suite}/${tc}`;
const RANK: Record<PublishOutcome, number> = { Failed: 3, Blocked: 2, NotExecuted: 1, Passed: 0 };
const worst = (list: PublishOutcome[]) => (list.length ? list.reduce((a, b) => (RANK[a] >= RANK[b] ? a : b)) : null);
const outcomeTag = (o: PublishOutcome | null) => (o ? <Tag color={o === 'Passed' ? 'green' : o === 'Failed' ? 'red' : 'default'}>{o === 'NotExecuted' ? 'Not run' : o}</Tag> : null);
const fromText: Record<string, string> = { scenario: 'scenario tags', feature: 'feature tags', config: 'config ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID', chosen: 'chosen here' };

/** Suites with their path ("Root › Login › Smoke"). */
function suitePaths(list: TestSuiteDef[]): Array<{ id: number; path: string }> {
    const by = new Map(list.map((s) => [s.id, s]));
    const pathOf = (id: number, depth = 0): string => { const s = by.get(id)!; return s.parent && by.has(s.parent) && depth < 30 ? `${pathOf(s.parent, depth + 1)} › ${s.name}` : s.name; };
    return list.map((s) => ({ id: s.id, path: pathOf(s.id) })).sort((a, b) => a.path.localeCompare(b.path));
}

/** All points ticked for each test case in its suite that has a scenario. */
function defaultPicks(groups: PublishGroupDef[]): Record<string, Pick> {
    const out: Record<string, Pick> = {};
    for (const g of groups) for (const c of g.cases) out[caseKey(g, c.testCase)] = { points: c.inSuite && c.scenarios.length ? c.points.map((p) => p.id) : [], scenarios: c.scenarios };
    return out;
}

export function PublishToAdo({ run, open, onClose }: { run: RunInfo; open: boolean; onClose: () => void }) {
    const { modal } = App.useApp();
    const scope = { project: run.request.project, env: run.request.env };
    const [projects, setProjects] = React.useState<string[] | null>(null);
    const [adoProject, setAdoProject] = React.useState<string | undefined>(undefined);
    const [mode, setMode] = React.useState<Mode>('tags');
    const [inactive, setInactive] = React.useState(false);
    const [plans, setPlans] = React.useState<TestPlanDef[] | null>(null);
    const [suites, setSuites] = React.useState<Array<{ id: number; path: string }>>([]);
    const [plan, setPlan] = React.useState<number | undefined>(undefined);
    const [chosenSuites, setChosenSuites] = React.useState<number[]>([]);
    const [projectsErr, setProjectsErr] = React.useState<string | null>(null);
    const [projectSearch, setProjectSearch] = React.useState('');
    const [preview, setPreview] = React.useState<PublishPreviewDef | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [picks, setPicks] = React.useState<Record<string, Pick>>({});
    const [writeTags, setWriteTags] = React.useState(false);
    const [runName, setRunName] = React.useState('');
    const [err, setErr] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [done, setDone] = React.useState<PublishDoneDef | null>(null);
    const ado = adoProject ? { adoProject } : {};

    React.useEffect(() => { if (open) api.adoProjects(scope).then((r) => setProjects(r.projects)).catch((e) => { setProjects([]); setProjectsErr(errText(e)); }); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    // Plans of the project (for choosing a plan and suite).
    React.useEffect(() => {
        if (!open || mode !== 'suite') return;
        setPlans(null);
        api.testPlans({ ...scope, ...ado, inactive }).then((r) => setPlans(r.plans)).catch((e) => { setPlans([]); setErr(errText(e)); });
    }, [open, mode, adoProject, inactive]); // eslint-disable-line react-hooks/exhaustive-deps
    // The suites of the chosen plan (a late answer for a plan no longer chosen is dropped).
    React.useEffect(() => {
        setSuites([]);
        if (!plan) return;
        let live = true;
        api.testSuites(plan, { ...scope, ...ado }).then((r) => { if (live) setSuites(suitePaths(r.suites)); }).catch((e) => { if (live) setErr(errText(e)); });
        return () => { live = false; };
    }, [plan, adoProject]); // eslint-disable-line react-hooks/exhaustive-deps
    // The list: from the tags, or the chosen suite's test cases.
    React.useEffect(() => {
        if (!open || done) return;
        if (mode === 'suite' && !(plan && chosenSuites.length)) { setLoading(false); setPreview((p) => (p ? { ...p, groups: [], notLinked: [], noPlan: [] } : p)); setPicks({}); return; }
        let live = true;
        setLoading(true); setErr(null);
        api.publishRunPreview(run.id, { ...ado, ...(mode === 'suite' ? { plan, suites: chosenSuites } : {}) })
            .then((r) => {
                if (!live) return;
                setPreview(r);
                // Test cases already shown keep what was ticked and picked (adding a suite does not reset the others).
                setPicks((old) => { const d = defaultPicks(r.groups); for (const k of Object.keys(d)) if (old[k]) d[k] = old[k]; return d; });
                setRunName((n) => n || r.run.name);
            })
            .catch((e) => { if (live) setErr(errText(e)); })
            .finally(() => { if (live) setLoading(false); });
        return () => { live = false; };
    }, [open, run.id, mode, plan, chosenSuites, adoProject]); // eslint-disable-line react-hooks/exhaustive-deps // eslint-disable-line react-hooks/exhaustive-deps

    const scen = React.useMemo(() => new Map((preview?.scenarios ?? []).map((s) => [s.key, s])), [preview]);
    const groups = preview?.groups ?? [];
    const allCases = groups.flatMap((g) => g.cases.filter((c) => c.inSuite && c.points.length).map((c) => ({ g, c, k: caseKey(g, c.testCase) })));
    const ticked = allCases.filter((x) => (picks[x.k]?.points.length ?? 0) > 0);
    const pointCount = ticked.reduce((n, x) => n + picks[x.k].points.length, 0);
    const noScenario = ticked.filter((x) => !picks[x.k].scenarios.length);
    const allPoints = allCases.reduce((n, x) => n + x.c.points.length, 0);
    const setPick = (k: string, p: Partial<Pick>) => setPicks((o) => ({ ...o, [k]: { ...(o[k] ?? { points: [], scenarios: [] }), ...p } }));
    const tickAll = (on: boolean) => setPicks((o) => { const n = { ...o }; for (const x of allCases) n[x.k] = { ...(n[x.k] ?? { scenarios: [] }), points: on ? x.c.points.map((p) => p.id) : [] }; return n; });

    const publish = async () => {
        const items: PublishItemDef[] = ticked.map((x) => ({ plan: x.g.plan, suite: x.g.suite, testCase: x.c.testCase, points: picks[x.k].points, scenarios: picks[x.k].scenarios }));
        const ok = await new Promise<boolean>((resolve) => modal.confirm({
            onOk: () => resolve(true), onCancel: () => resolve(false),
            title: `Publish to ${pointCount} test point${pointCount === 1 ? '' : 's'} in ${preview!.ado.project}?`,
            content: `This run's results for ${items.length} test case${items.length === 1 ? '' : 's'} become a new test run in Azure DevOps.${writeTags ? ' The @TestCaseId tags are also written to the feature files.' : ''}`,
            okText: 'Publish',
        }));
        if (!ok) return;
        setBusy(true); setErr(null);
        try { setDone(await api.publishRun(run.id, { ...ado, items, writeTags, runName })); }
        catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };

    const scenarioLabel = (s: PublishScenarioDef) => `${s.name}${s.iterations.length > 1 ? ` (${s.iterations.length} iterations)` : ''}`;
    const scenarioOptions = (preview?.scenarios ?? []).map((s) => ({ value: s.key, label: scenarioLabel(s), title: `${s.feature}: ${s.name} — ${s.outcome}${s.file ? ` (${s.file}:${s.line})` : ''}` }));

    return (
        <Modal open={open} onCancel={onClose} width={980} title={<Space><CloudUploadOutlined />Publish run {run.id} results to Azure DevOps</Space>} destroyOnClose
            footer={done ? <Button onClick={onClose}>Close</Button> : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <Checkbox checked={writeTags} onChange={(e) => setWriteTags(e.target.checked)} data-testid="write-tags">Also add the @TestCaseId tags to the scenarios (feature files)</Checkbox>
                    <span style={{ flex: 1 }} />
                    <Typography.Text type="secondary">{ticked.length} test case{ticked.length === 1 ? '' : 's'} · {pointCount} test point{pointCount === 1 ? '' : 's'}</Typography.Text>
                    <Button onClick={onClose}>Cancel</Button>
                    <Tooltip title={noScenario.length ? `Choose a scenario for test case ${noScenario.map((x) => x.c.testCase).join(', ')}` : undefined}>
                        <Button type="primary" loading={busy} disabled={!pointCount || noScenario.length > 0} onClick={() => void publish()}>Publish to {pointCount} test point{pointCount === 1 ? '' : 's'}</Button>
                    </Tooltip>
                </div>)}>
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <Space wrap align="end" size={12}>
                    <div><div className="cs-field-label">Azure DevOps URL</div><Input readOnly value={preview?.ado.org ?? ''} placeholder="from the project's config" style={{ width: 300 }} aria-label="Azure DevOps URL" /></div>
                    <div>
                        <div className="cs-field-label">Project {preview && <Typography.Text type="secondary" style={{ fontSize: 12 }}>(config: {preview.ado.from.project} / {preview.ado.from.env}{preview.ado.configured ? ` → ${preview.ado.configured}` : ''})</Typography.Text>}</div>
                        <Select style={{ width: 280 }} showSearch loading={projects === null} disabled={!!done} aria-label="Azure DevOps project"
                            value={adoProject ?? preview?.ado.project} searchValue={projectSearch} onSearch={setProjectSearch} filterOption={(input, o) => String(o?.value ?? '').toLowerCase().includes(input.toLowerCase())}
                            onChange={(v: string) => { setProjectSearch(''); setAdoProject(v === preview?.ado.configured ? undefined : v); setPlan(undefined); setChosenSuites([]); }}
                            notFoundContent={projectsErr ? 'Type the project name' : undefined}
                            options={[...new Set([...(projects ?? []), ...(preview?.ado.configured ? [preview.ado.configured] : []), ...(adoProject ? [adoProject] : [])])].sort((a, b) => a.localeCompare(b))
                                .map((p) => ({ value: p, label: p === preview?.ado.configured ? `${p} (configured)` : p }))
                                .concat(projectSearch.trim() && !(projects ?? []).some((p) => p.toLowerCase() === projectSearch.trim().toLowerCase()) ? [{ value: projectSearch.trim(), label: `Use "${projectSearch.trim()}"` }] : [])} />
                        {projectsErr && <div><Typography.Text type="warning" style={{ fontSize: 11 }}>Could not list the organization's projects: type the name. ({projectsErr})</Typography.Text></div>}
                    </div>
                </Space>
                {!done && <Segmented value={mode} onChange={(v) => setMode(v as Mode)} options={[{ value: 'tags', label: 'Use tags from feature files' }, { value: 'suite', label: 'Select plan, suite and test cases' }]} />}
                {!done && mode === 'suite' && (
                    <Space wrap align="end" size={12}>
                        <div><div className="cs-field-label">Test plan {plans && <Typography.Text type="secondary" style={{ fontSize: 12 }}>({plans.length} in {preview?.ado.project ?? 'the project'})</Typography.Text>}</div>
                            <Select style={{ width: 320 }} showSearch optionFilterProp="label" loading={plans === null} placeholder="Choose a test plan" value={plan} onChange={(v: number) => { setChosenSuites([]); setPlan(v); }} aria-label="Test plan"
                                options={(plans ?? []).map((p) => ({ value: p.id, label: `${p.id} · ${p.name}${p.state && p.state !== 'Active' ? ` (${p.state})` : ''}${p.owner ? ` — ${p.owner}` : ''}` }))} /></div>
                        <div><div className="cs-field-label">Suites</div>
                            <Select mode="multiple" style={{ width: 400 }} showSearch optionFilterProp="label" disabled={!plan} placeholder="Choose one or more suites" value={chosenSuites} onChange={(v: number[]) => setChosenSuites(v)} aria-label="Test suite" maxTagCount="responsive" loading={!!plan && !suites.length}
                                options={suites.map((s) => ({ value: s.id, label: `${s.id} · ${s.path}` }))} /></div>
                        <Checkbox checked={inactive} onChange={(e) => setInactive(e.target.checked)}>Include inactive plans</Checkbox>
                    </Space>)}
                {err && <Alert type="error" showIcon message={err} />}
                {done ? <Done d={done} project={preview?.ado.project ?? ''} /> : loading || (!preview && !err && mode === 'tags') ? <Spin /> : (<>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Results of run {run.id} only. {mode === 'tags' ? 'Plan, suite and test case come from each scenario\'s tags (else its feature\'s, else the config), as in the pipeline.' : 'Pick the scenario whose result goes to each test case: one scenario can be picked for several test cases.'}
                    </Typography.Text>
                    {mode === 'suite' && !(plan && chosenSuites.length) ? <Alert type="info" showIcon message="Choose a test plan and one or more suites to list their test cases." /> : groups.length === 0 ? (
                        <Alert type="info" showIcon message={mode === 'tags' ? 'None of this run\'s scenarios has a @TestCaseId with a plan and suite.' : 'That suite has no test cases.'}
                            description={mode === 'tags' ? 'Use "Select plan, suite and test cases" to map them.' : undefined} />
                    ) : (
                        <table className="cs-publish-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead><tr>
                                <th style={{ width: 34 }}><Checkbox aria-label="Tick every test point" checked={allPoints > 0 && pointCount === allPoints} indeterminate={pointCount > 0 && pointCount < allPoints} onChange={(e) => tickAll(e.target.checked)} /></th>
                                <th style={{ width: 280 }}>Test case / test point</th><th>Scenario result from this run</th><th style={{ width: 90 }}>Outcome</th>
                            </tr></thead>
                            <tbody>{groups.map((g) => (
                                <React.Fragment key={`${g.plan}/${g.suite}`}>
                                    <tr className="cs-publish-group"><td colSpan={4}>
                                        <b>Plan {g.plan}{g.planName ? ` ${g.planName}` : ''} › Suite {g.suite}{g.suiteName ? ` ${g.suiteName}` : ''}</b>
                                        <Typography.Text type="secondary" style={{ fontSize: 12 }}> · from {g.from.map((f) => fromText[f] ?? f).join(', ')} · {g.cases.length} test case{g.cases.length === 1 ? '' : 's'}</Typography.Text>
                                        {g.error && <div><Typography.Text type="danger" style={{ fontSize: 12 }}>{g.error}</Typography.Text></div>}
                                    </td></tr>
                                    {g.cases.map((c) => {
                                        const k = caseKey(g, c.testCase);
                                        const p = picks[k] ?? { points: [], scenarios: [] };
                                        const usable = c.inSuite && c.points.length > 0;
                                        const outcome = worst(p.scenarios.map((s) => scen.get(s)?.outcome).filter(Boolean) as PublishOutcome[]);
                                        return (
                                            <React.Fragment key={k}>
                                                <tr className="cs-publish-case" data-testid={`case-${c.testCase}`}>
                                                    <td><Checkbox aria-label={`Test case ${c.testCase}`} disabled={!usable} checked={usable && p.points.length === c.points.length} indeterminate={p.points.length > 0 && p.points.length < c.points.length}
                                                        onChange={(e) => setPick(k, { points: e.target.checked ? c.points.map((x) => x.id) : [] })} /></td>
                                                    <td><b>{c.testCase}</b> {c.title}{!c.inSuite && <> <Tag color="orange">not in this suite</Tag></>}</td>
                                                    <td>{mode === 'suite' ? (
                                                        <Select mode="multiple" size="small" style={{ width: '100%' }} placeholder="Choose a scenario" value={p.scenarios} options={scenarioOptions} optionFilterProp="label" maxTagCount="responsive" aria-label={`Scenario for test case ${c.testCase}`}
                                                            status={p.points.length && !p.scenarios.length ? 'error' : undefined}
                                                            onChange={(v: string[]) => setPick(k, { scenarios: v, points: v.length && !p.scenarios.length && usable ? c.points.map((x) => x.id) : v.length ? p.points : [] })} />
                                                    ) : p.scenarios.map((s) => { const x = scen.get(s); return <div key={s}>{x ? scenarioLabel(x) : s}{x?.file && <Typography.Text type="secondary" style={{ fontSize: 11 }}> · {x.file}:{x.line}</Typography.Text>}</div>; })}</td>
                                                    <td>{outcomeTag(outcome)}</td>
                                                </tr>
                                                {c.points.map((pt) => (
                                                    <tr key={pt.id} className="cs-publish-point">
                                                        <td style={{ paddingLeft: 26 }}><Checkbox aria-label={`Test point ${pt.id}`} checked={p.points.includes(pt.id)}
                                                            onChange={(e) => setPick(k, { points: e.target.checked ? [...p.points, pt.id] : p.points.filter((x) => x !== pt.id) })} /></td>
                                                        <td colSpan={3}>Point {pt.id} · {pt.configuration || 'default configuration'}{pt.tester ? ` · ${pt.tester}` : ''}</td>
                                                    </tr>))}
                                            </React.Fragment>);
                                    })}
                                </React.Fragment>))}</tbody>
                        </table>)}
                    <Unmapped title="have no @TestCaseId" keys={preview?.notLinked ?? []} scen={scen} hint={mode === 'tags' ? 'Use "Select plan, suite and test cases" to map them.' : 'Pick them for a test case above to publish them.'} />
                    {mode === 'tags' && <Unmapped title="have a @TestCaseId but no plan and suite (tags or config)" keys={preview?.noPlan ?? []} scen={scen} hint='Use "Select plan, suite and test cases".' />}
                    <div><div className="cs-field-label">Test run name in Azure DevOps</div><Input value={runName} onChange={(e) => setRunName(e.target.value)} maxLength={250} aria-label="Test run name" /></div>
                </>)}
            </Space>
        </Modal>
    );
}

function Unmapped({ title, keys, scen, hint }: { title: string; keys: string[]; scen: Map<string, PublishScenarioDef>; hint?: string }) {
    if (!keys.length) return null;
    return (
        <details>
            <summary><Typography.Text type="secondary" style={{ fontSize: 12 }}>{keys.length} scenario{keys.length === 1 ? '' : 's'} of this run {title}.{hint ? ` ${hint}` : ''}</Typography.Text></summary>
            <ul style={{ margin: '4px 0 0', fontSize: 12 }}>{keys.map((k) => { const s = scen.get(k); return <li key={k}>{s ? `${s.feature}: ${s.name}` : k} {s && outcomeTag(s.outcome)}</li>; })}</ul>
        </details>
    );
}

function Done({ d, project }: { d: PublishDoneDef; project: string }) {
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <Alert type="success" showIcon message={`Published to ${project}`} description={<div>{d.published.map((p) => (
                <div key={p.runId}>Test run <b>{p.runId}</b> — plan {p.plan} › suite{p.suites.length === 1 ? '' : 's'} {p.suites.join(', ')}: {p.published} test point result{p.published === 1 ? '' : 's'} for {p.testCases} test case{p.testCases === 1 ? '' : 's'}. <a href={p.url} target="_blank" rel="noreferrer">Open in Azure DevOps</a></div>))}</div>} />
            {d.tagged.length > 0 && <Alert type="info" showIcon message={`Tags written to ${d.tagged.length} scenario${d.tagged.length === 1 ? '' : 's'}`} description={<ul style={{ margin: 0 }}>{d.tagged.map((t) => <li key={`${t.file}:${t.line}`}>{t.file}:{t.line} {t.name} — {t.tags.join(' ')}</li>)}</ul>} />}
            {d.notTagged.length > 0 && <Alert type="warning" showIcon message={`Tags not changed for ${d.notTagged.length} scenario${d.notTagged.length === 1 ? '' : 's'} (the results were published)`} description={<ul style={{ margin: 0 }}>{d.notTagged.map((t) => <li key={t.scenario}>{t.scenario} — {t.reason}</li>)}</ul>} />}
        </Space>
    );
}
