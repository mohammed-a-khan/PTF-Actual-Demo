/**
 * An agent's evaluations: its test cases (prompt + checks), runs in safe sessions, the latest results with
 * regressions against the run before, and the history.
 */
import React from 'react';
import { Alert, App, Button, Card, Collapse, Drawer, Empty, Input, InputNumber, List, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, DeleteOutlined, PlayCircleOutlined, PlusOutlined, QuestionCircleOutlined, StopOutlined } from '@ant-design/icons';
import { api, EvalCaseDef, EvalCheckDef, TeamAgentDef } from '../api';
import { useUnsaved } from '../unsaved';
import { errText } from '../state';
import { Markdown } from './Markdown';
import { agentsApi, EvalRunSummaryView, EvalRunView, EvalsView } from '../agents-api';
import { askChangedElsewhere, isChangedElsewhere } from './ChangedElsewhere';
import { evalCheckProblem, evalPromptProblem, type EvalCheckLike } from '../agents-checks';

/** The model a run used: as recorded (newer runs), else the agent's own model, else "not recorded" (older runs). */
export const runModel = (r: EvalRunSummaryView): string => r.models?.length ? r.models.join(', ') : r.subject.model ?? 'not recorded';

const CHECKS: Array<{ value: EvalCheckDef['kind']; label: string }> = [
    { value: 'contains', label: 'The answer contains' }, { value: 'not-contains', label: 'The answer does not contain' }, { value: 'matches', label: 'The answer matches a pattern' },
    { value: 'tool-called', label: 'It calls the tool' }, { value: 'tool-not-called', label: 'It does not call the tool' },
    { value: 'cites-knowledge', label: 'It cites the knowledge' }, { value: 'max-calls', label: 'At most N model calls' },
    { value: 'max-seconds', label: 'At most N seconds' }, { value: 'judge', label: 'A grader judges it against criteria' },
];
const fresh = (k: EvalCheckDef['kind']): EvalCheckDef => (k === 'contains' || k === 'not-contains' ? { kind: k, text: '' } : k === 'matches' ? { kind: k, pattern: '' } : k === 'tool-called' || k === 'tool-not-called' ? { kind: k, tool: '' } : k === 'max-calls' ? { kind: k, calls: 10 } : k === 'max-seconds' ? { kind: k, seconds: 120 } : k === 'judge' ? { kind: k, criteria: '' } : { kind: 'cites-knowledge' });
const describe = (c: EvalCheckDef) => (c.kind === 'contains' ? `contains "${c.text}"` : c.kind === 'not-contains' ? `not "${c.text}"` : c.kind === 'matches' ? `matches /${c.pattern}/` : c.kind === 'tool-called' ? `calls ${c.tool}${c.args ? ` (${c.args})` : ''}` : c.kind === 'tool-not-called' ? `never ${c.tool}` : c.kind === 'cites-knowledge' ? 'cites knowledge' : c.kind === 'max-calls' ? `≤ ${c.calls} calls` : c.kind === 'max-seconds' ? `≤ ${c.seconds} s` : 'grader');

function CheckEditor({ c, onChange, onRemove }: { c: EvalCheckDef; onChange: (c: EvalCheckDef) => void; onRemove: () => void }) {
    const problem = evalCheckProblem(c as EvalCheckLike);
    const st = problem ? 'error' as const : undefined;
    return (
        <div>
        <Space wrap align="start" style={{ width: '100%' }}>
            <Select style={{ width: 250 }} value={c.kind} options={CHECKS} onChange={(k) => onChange(fresh(k))} />
            {(c.kind === 'contains' || c.kind === 'not-contains') && <Input style={{ width: 300 }} status={st} aria-label="Text to look for" value={c.text} placeholder="Text, as written (not case-sensitive)" onChange={(e) => onChange({ ...c, text: e.target.value })} />}
            {c.kind === 'matches' && <Input className="mono" style={{ width: 300 }} status={st} aria-label="Pattern" value={c.pattern} placeholder="A regular expression, e.g. catalog/v\d+" onChange={(e) => onChange({ ...c, pattern: e.target.value })} />}
            {(c.kind === 'tool-called' || c.kind === 'tool-not-called') && <Input style={{ width: 200 }} status={st} aria-label="Tool name" value={c.tool} placeholder="knowledge_search" onChange={(e) => onChange({ ...c, tool: e.target.value })} />}
            {c.kind === 'tool-called' && <Input style={{ width: 200 }} value={c.args ?? ''} placeholder="Arguments contain (optional)" onChange={(e) => onChange({ ...c, args: e.target.value || undefined })} />}
            {c.kind === 'max-calls' && <InputNumber min={1} status={st} value={c.calls} onChange={(v) => onChange({ ...c, calls: v ?? 1 })} />}
            {c.kind === 'max-seconds' && <InputNumber min={1} status={st} value={c.seconds} onChange={(v) => onChange({ ...c, seconds: v ?? 1 })} />}
            {c.kind === 'judge' && <Input.TextArea style={{ width: 420 }} status={st} aria-label="Grader's criteria" autoSize={{ minRows: 2 }} value={c.criteria} placeholder="What a good answer does, e.g. It names the cause with evidence and does not change files." onChange={(e) => onChange({ ...c, criteria: e.target.value })} />}
            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="Remove the check" onClick={onRemove} />
        </Space>
        {problem && <Typography.Text type="danger" role="alert" style={{ fontSize: 12, display: 'block' }}>{problem}</Typography.Text>}
        </div>
    );
}

export function AgentEvals({ agent, onClose }: { agent: TeamAgentDef; onClose: () => void }) {
    const { message, modal } = App.useApp();
    const [d, setD] = React.useState<EvalsView | null>(null);
    const [cases, setCases] = React.useState<EvalCaseDef[]>([]);
    // The first problem that keeps the cases from being saved (each is also shown next to its field).
    const casesProblem = cases.map((c, i) => {
        const where = c.name?.trim() ? `"${c.name.trim()}"` : `case ${i + 1}`;
        const p = evalPromptProblem(c.prompt) ?? (!c.checks.length ? 'Add at least one check.' : c.checks.map((k) => evalCheckProblem(k as EvalCheckLike)).find(Boolean) ?? null);
        return p ? `${where}: ${p}` : null;
    }).find(Boolean) ?? null;
    const [dirty, setDirty] = React.useState(false);
    // The version of the cases file these cases came from: a save over a newer one (another tab) is refused.
    const version = React.useRef<string | undefined>(undefined);
    const [run, setRun] = React.useState<EvalRunView | null>(null);
    const [tab, setTab] = React.useState('cases');
    const load = React.useCallback(async () => {
        try {
            const r = await agentsApi.evals(agent.id);
            setD(r);
            if (r.runs[0]) setRun(await agentsApi.evalRun(agent.id, r.runs[0].id));
            return r;
        } catch (e) { message.error(errText(e)); return null; }
    }, [agent.id, message]);
    /** The cases as saved now (after "Reload", and when the drawer opens). */
    const reloadCases = React.useCallback(() => load().then((r) => { if (r) { setCases(r.suite.cases); version.current = r.version; setDirty(false); } return r; }), [load]);
    React.useEffect(() => { void reloadCases().then((r) => { if (r?.runs.length) setTab('results'); }); }, [reloadCases]);
    // While it runs: the results as they come.
    React.useEffect(() => { if (!d?.running) return; const t = setInterval(() => { void load(); }, 2000); return () => clearInterval(t); }, [d?.running, load]);
    const up = (i: number, c: Partial<EvalCaseDef>) => { setCases((cs) => cs.map((x, k) => (k === i ? { ...x, ...c } : x))); setDirty(true); };
    // One save at a time (a double click saves once); a case without a name gets "Case N".
    const saving = React.useRef<Promise<boolean> | null>(null);
    const [savingNow, setSavingNow] = React.useState(false);
    const put = async (force: boolean): Promise<boolean> => {
        const r = await agentsApi.saveEvals(agent.id, { cases: cases.map((c, i) => ({ ...c, name: c.name.trim() || `Case ${i + 1}` })) }, version.current, force);
        setCases(r.suite.cases); version.current = r.version; setDirty(false);
        message.success({ content: `Saved ${d?.file}: commit it to share the cases`, key: 'agent-evals-save' });
        return true;
    };
    const save = (): Promise<boolean> => {
        if (saving.current) return saving.current;
        // Not saved while a field needs putting right (each says what, next to it).
        if (casesProblem) { message.warning({ content: `Put right first: ${casesProblem}`, key: 'agent-evals-save' }); return Promise.resolve(false); }
        setSavingNow(true);
        saving.current = (async () => {
            try { return await put(false); }
            catch (e) {
                // Saved in another tab (or by someone else, or a pull) since these cases were read: reload or overwrite on purpose.
                if (isChangedElsewhere(e)) {
                    return new Promise<boolean>((resolve) => askChangedElsewhere(modal, e, `The evaluation cases of ${agent.name}`, {
                        reload: () => { void reloadCases(); resolve(false); },
                        overwrite: () => put(true).then(resolve, (x) => { message.error({ content: errText(x), key: 'agent-evals-save' }); resolve(false); }),
                        keepEditing: () => resolve(false),
                    }));
                }
                message.error({ content: errText(e), key: 'agent-evals-save' }); return false;
            } finally { saving.current = null; setSavingNow(false); }
        })();
        return saving.current;
    };
    // Unsaved cases: another screen (the menu, Back, an address typed) asks first: Save, Discard or Stay.
    useUnsaved('agent-evals', dirty, `the evaluation cases of ${agent.name}`, { lostOnLeave: true, save, discard: onClose });
    // One run at a time: a second click while the first is starting is ignored.
    const starting = React.useRef(false);
    const [startingNow, setStartingNow] = React.useState(false);
    const start = async () => {
        if (starting.current || d?.running) return;
        starting.current = true; setStartingNow(true);
        try { if (dirty && !(await save())) return; await api.runEvals(agent.id); setTab('results'); await load(); }
        catch (e) { message.error(errText(e)); }
        finally { starting.current = false; setStartingNow(false); }
    };
    return (
        <Drawer open width="min(980px, calc(100vw - 32px))" title={`Evaluations: ${agent.name}`} onClose={() => (dirty ? modal.confirm({ title: 'Discard the changes to the cases?', okText: 'Discard', okButtonProps: { danger: true }, cancelText: 'Keep editing', onOk: onClose }) : onClose())}
            extra={<Space>{d?.running ? <Button icon={<StopOutlined />} onClick={() => { void api.stopEvals(agent.id).then(load).catch((e) => message.error(errText(e))); }}>Stop</Button>
                : <Button type="primary" icon={<PlayCircleOutlined />} disabled={!cases.length || (dirty && !!casesProblem)} loading={startingNow} onClick={() => void start()}>Run all cases</Button>}</Space>}>
            {d?.problem && <Alert type="warning" showIcon message={d.problem} style={{ marginBottom: 12 }} />}
            <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>Run the cases after changing the agent: a case that passed before and fails now is a regression. <Tooltip title="Each case is a fresh session with the agent's instructions, tools and knowledge that cannot change anything."><QuestionCircleOutlined /></Tooltip></Typography.Paragraph>
            <Tabs size="small" activeKey={tab} onChange={setTab} items={[
                { key: 'cases', label: `Cases (${cases.length})`, children: (
                    <Space direction="vertical" style={{ width: '100%' }}>
                        {cases.map((c, i) => (
                            <Card key={i} size="small" title={<Input variant="borderless" value={c.name} placeholder={`Case ${i + 1} (name it)`} onChange={(e) => up(i, { name: e.target.value })} style={{ fontWeight: 600 }} />}
                                extra={<Space><Tooltip title="Runs of this case (a pass rate, for answers that vary)"><InputNumber size="small" min={1} max={10} value={c.repeat ?? 1} addonAfter="×" style={{ width: 90 }} onChange={(v) => up(i, { repeat: v && v > 1 ? v : undefined })} /></Tooltip>
                                    <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="Remove the case" onClick={() => { setCases((cs) => cs.filter((_, k) => k !== i)); setDirty(true); }} /></Space>}>
                                <Input.TextArea autoSize={{ minRows: 2 }} value={c.prompt} placeholder="What the person asks the agent" aria-label="Prompt" status={evalPromptProblem(c.prompt) ? 'error' : undefined} onChange={(e) => up(i, { prompt: e.target.value })} style={{ marginBottom: evalPromptProblem(c.prompt) ? 0 : 8 }} />
                                {evalPromptProblem(c.prompt) && <Typography.Text type="danger" role="alert" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{evalPromptProblem(c.prompt)}</Typography.Text>}
                                {!c.checks.length && <Typography.Text type="danger" role="alert" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>Add at least one check.</Typography.Text>}
                                {agent.mode === 'mission' && !!agent.inputs?.length && <Space wrap style={{ marginBottom: 8 }}>{agent.inputs.map((inp) => <Input key={inp.key} addonBefore={inp.label} style={{ width: 280 }} value={c.inputs?.[inp.key] ?? ''} onChange={(e) => up(i, { inputs: { ...c.inputs, [inp.key]: e.target.value } })} />)}</Space>}
                                <Space direction="vertical" style={{ width: '100%' }}>
                                    {c.checks.map((k, j) => <CheckEditor key={j} c={k} onChange={(nk) => up(i, { checks: c.checks.map((x, m) => (m === j ? nk : x)) })} onRemove={() => up(i, { checks: c.checks.filter((_, m) => m !== j) })} />)}
                                    <Button size="small" icon={<PlusOutlined />} onClick={() => up(i, { checks: [...c.checks, fresh('contains')] })}>Add a check</Button>
                                </Space>
                            </Card>
                        ))}
                        <Space>
                            <Button icon={<PlusOutlined />} onClick={() => { setCases((cs) => [...cs, { id: `case-${Date.now().toString(36)}`, name: '', prompt: '', checks: [fresh('contains')] }]); setDirty(true); }}>Add a case</Button>
                            <Button type="primary" disabled={!dirty || !!casesProblem} loading={savingNow} onClick={() => void save()}>Save cases</Button>
                            {dirty && casesProblem && <Typography.Text type="danger" style={{ fontSize: 12 }}>Put right first: {casesProblem}</Typography.Text>}
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{d?.file}</Typography.Text>
                        </Space>
                    </Space>
                ) },
                { key: 'results', label: 'Latest results', children: !run ? <Empty description="Not run yet." /> : (
                    <Space direction="vertical" style={{ width: '100%' }}>
                        <Space wrap>
                            <Tag color={run.state === 'running' ? 'processing' : run.passed === run.total ? 'green' : 'red'}>{run.state === 'running' ? 'running' : `${run.passed} of ${run.total} passed`}</Tag>
                            {run.compared && <Tag color={run.compared.regressions ? 'red' : 'default'}>{run.compared.regressions} regression(s), {run.compared.fixed} fixed since the run before</Tag>}
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(run.startedAt).toLocaleString()} · {run.by} · model {runModel(run)}</Typography.Text>
                        </Space>
                        {run.error && <Alert type="error" showIcon message={run.error} />}
                        <Collapse items={run.cases.map((c) => ({
                            key: c.id,
                            label: <Space wrap>{c.pass ? <CheckCircleFilled style={{ color: '#2e7d32' }} /> : <CloseCircleFilled style={{ color: '#c62828' }} />}<Typography.Text strong>{c.name}</Typography.Text>
                                {c.attempts.length > 1 && <Tag>{Math.round(c.passRate * 100)}% of {c.attempts.length}</Tag>}{c.regression && <Tag color="red">regression</Tag>}{c.fixed && <Tag color="green">fixed</Tag>}</Space>,
                            children: (
                                <List size="small" dataSource={c.attempts} renderItem={(a, i) => (
                                    <List.Item><Space direction="vertical" style={{ width: '100%' }}>
                                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Attempt {i + 1}: {a.calls} model call(s), {Math.round(a.ms / 1000)} s{a.tools.length ? `, tools: ${[...new Set(a.tools.map((t) => t.tool))].join(', ')}` : ''}</Typography.Text>
                                        {a.error && <Alert type="error" showIcon message={a.error} />}
                                        <Table size="small" pagination={false} rowKey={(_, k) => String(k)} dataSource={a.checks} columns={[
                                            { title: '', width: 30, render: (_: unknown, k) => (k.pass ? <CheckCircleFilled style={{ color: '#2e7d32' }} /> : <CloseCircleFilled style={{ color: '#c62828' }} />) },
                                            { title: 'Check', width: 220, render: (_: unknown, k) => describe(k.check) },
                                            { title: 'Result', dataIndex: 'detail' },
                                        ]} />
                                        <Card size="small" title="Answer" styles={{ body: { maxHeight: 260, overflow: 'auto' } }}><Markdown text={a.answer || '(no answer)'} /></Card>
                                    </Space></List.Item>
                                )} />
                            ),
                        }))} />
                    </Space>
                ) },
                { key: 'history', label: `History (${d?.runs.length ?? 0})`, children: (
                    <Table size="small" rowKey="id" dataSource={d?.runs ?? []} pagination={{ pageSize: 15 }} onRow={(r) => ({ onClick: () => { void agentsApi.evalRun(agent.id, r.id).then((x) => { setRun(x); setTab('results'); }).catch((e) => message.error(errText(e))); }, style: { cursor: 'pointer' } })} columns={[
                        { title: 'When', dataIndex: 'startedAt', render: (x: string) => new Date(x).toLocaleString() },
                        { title: 'By', dataIndex: 'by', width: 140 },
                        { title: 'Passed', width: 110, render: (_: unknown, r) => <Tag color={r.state === 'running' ? 'processing' : r.passed === r.total ? 'green' : 'red'}>{r.state === 'running' ? 'running' : `${r.passed} / ${r.total}`}</Tag> },
                        { title: 'Against the run before', render: (_: unknown, r) => (r.compared ? <Space>{r.compared.regressions ? <Tag color="red">{r.compared.regressions} regression(s)</Tag> : null}{r.compared.fixed ? <Tag color="green">{r.compared.fixed} fixed</Tag> : null}{!r.compared.regressions && !r.compared.fixed ? 'no change' : null}</Space> : '—') },
                        { title: 'Model', width: 160, render: (_: unknown, r) => { const m = runModel(r); return m === 'not recorded' ? <Tooltip title="This run is older than the record of the model used"><Typography.Text type="secondary">not recorded</Typography.Text></Tooltip> : <Typography.Text className="mono" style={{ fontSize: 12 }}>{m}</Typography.Text>; } },
                    ]} />
                ) },
            ]} />
        </Drawer>
    );
}
