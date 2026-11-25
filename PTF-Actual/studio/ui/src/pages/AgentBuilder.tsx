/**
 * Agent Builder: the team's own agents, made here and kept in the repository (.cs-studio/agents). An assistant is a
 * chat with its own instructions, tools and knowledge; a mission agent works on a goal alone and is checked by the
 * Studio, started by a person or by a trigger (a failed run, a schedule, new work items, new pull requests).
 */
import React from 'react';
import { Alert, App, Button, Card, Checkbox, Col, Dropdown, Empty, Form, Input, Modal, Radio, Row, Select, Space, Switch, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, DownOutlined, ExperimentOutlined, MessageOutlined, PlusOutlined, QuestionCircleOutlined, RobotOutlined, RocketOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { AgentBuilderDef, AgentTriggerDef, api, MissionInputDef, TeamAgentDef, ToolGroupId } from '../api';
import { errText, useStudio } from '../state';
import { navigate, useRoute } from '../route';
import { useUnsaved } from '../unsaved';
import { AgentEvals } from '../components/AgentEvals';
import { startMissionFor } from './Missions';
import { useRememberedTab } from '../agents-tabs';
import { agentsApi, AgentBuilderView } from '../agents-api';
import { askChangedElsewhere, isChangedElsewhere } from '../components/ChangedElsewhere';
import { useValidity, WholeNumber } from '../components/WholeNumber';
import { agentIdProblem, cronProblem, instructionsProblem } from '../agents-checks';

/** "storyId" → "Story id": the label an input gets until someone writes their own. */
function labelOf(key: string): string {
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : '';
}

const blank = (): TeamAgentDef => ({ id: '', name: '', mode: 'assistant', instructions: '', tools: ['knowledge', 'studio-read'], starters: [] });
/** An agent id from its name; a name with no Latin letters or digits gets a short stable code. */
export const slug = (s: string) => {
    const out = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    if (out.length >= 2) return out;
    if (!s.trim()) return '';
    let h = 0x811c9dc5;
    for (const ch of s.trim()) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    return `agent-${h.toString(36)}`;
};
const TRIGGER_LABEL: Record<AgentTriggerDef['on'], string> = { 'run-failed': 'When a run fails', schedule: 'On a schedule', 'work-item': 'New or changed work items', 'pull-request': 'New or updated pull requests' };

/** The editor tab to open with the next linked agent (e.g. 'triggers' from Missions › Triggers). */
let openTabNext: string | null = null;
/** Open a team agent's editor in Agent builder (on a tab of it). */
export function openAgentEditor(id: string, mode: 'assistant' | 'mission', tab?: string): void { openTabNext = tab ?? null; navigate(['agent-builder', mode, id]); }

export function AgentBuilder({ openConversation }: { openConversation: (session: string) => void }) {
    const { message } = App.useApp();
    const [d, setD] = React.useState<AgentBuilderView | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<{ agent: TeamAgentDef; isNew: boolean } | null>(null);
    const [evaluating, setEvaluating] = React.useState<TeamAgentDef | null>(null);
    const [showProblems, setShowProblems] = React.useState(false);
    const [kind, setKind] = useRememberedTab('agent-builder', 'all', ['all', 'assistant', 'mission'], 'agent-builder');
    const load = React.useCallback(() => { api.agentBuilder().then((r) => { setD(r); setErr(null); }).catch((e) => setErr(errText(e))); }, []);
    // "Reload" after a save refused because the agent changed elsewhere: the editor shows the saved agent.
    const reloadAgent = React.useCallback(async (id: string) => {
        try {
            const r: AgentBuilderView = await api.agentBuilder();
            setD(r);
            const fresh = r.agents.find((x) => x.id === id);
            if (fresh) setEditing({ agent: fresh, isNew: false }); else { setEditing(null); message.warning('That agent was deleted meanwhile.'); }
        } catch (e) { message.error(errText(e)); }
    }, [message]);
    React.useEffect(load, [load]);
    // #/agent-builder/<kind>/<agent id> (a link from Missions › Triggers): that agent's editor opens (on the tab asked
    // for), and the address goes back to the list in place, so Back returns to where the link was.
    const route = useRoute();
    const linked = route[0] === 'agent-builder' && route[2] ? route[2] : null;
    React.useEffect(() => {
        if (!d || !linked) return;
        const a = d.agents.find((x) => x.id === linked);
        if (a) { setEditing({ agent: a, isNew: false }); if (openTabNext) { try { localStorage.setItem('cs-studio-tab-agent-editor', openTabNext); } catch { /* storage off */ } } }
        else message.warning(`No agent "${linked}" in Agent builder (deleted or renamed?).`);
        openTabNext = null;
        navigate(['agent-builder', kind], true);
    }, [d, linked]); // eslint-disable-line react-hooks/exhaustive-deps
    const chatting = React.useRef(false);
    const chat = async (a: TeamAgentDef) => { if (chatting.current) return; chatting.current = true; try { const s = await api.agentCreate(a.name, undefined, a.id); openConversation(s.id); } catch (e) { message.error(errText(e)); } finally { chatting.current = false; } };
    if (err) return <Alert type="error" showIcon message={err} />;
    if (!d) return null;
    const shown = d.agents.filter((a) => kind === 'all' || a.mode === kind);
    const count = (m: string) => d.agents.filter((a) => a.mode === m).length;
    return (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {d.problems.length > 0 && <Alert type="warning" showIcon message={`${d.problems.length} agent file${d.problems.length === 1 ? '' : 's'} could not be read`}
                action={<Button size="small" type="link" onClick={() => setShowProblems(!showProblems)}>{showProblems ? 'Hide' : 'Details'}</Button>}
                description={showProblems ? <ul style={{ margin: 0, paddingLeft: 18 }}>{d.problems.map((p) => <li key={p}>{p}</li>)}</ul> : undefined} />}
            <Tabs size="small" activeKey={kind} onChange={setKind} items={[
                { key: 'all', label: `All (${d.agents.length})` }, { key: 'assistant', icon: <RobotOutlined />, label: <span>Assistants ({count('assistant')})</span> }, { key: 'mission', icon: <RocketOutlined />, label: <span>Missions ({count('mission')})</span> },
            ]} tabBarExtraContent={<Space>
                <Tooltip title={`Saved in ${d.dir}/ — commit them to share the agents with the team.`}><QuestionCircleOutlined style={{ color: 'var(--ant-color-text-tertiary, #999)' }} /></Tooltip>
                <Dropdown menu={{ items: d.templates.map((t) => ({ key: t.id, label: <Space direction="vertical" size={0}><span>{t.name} <Tag>{t.mode}</Tag></span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{t.description}</Typography.Text></Space> })),
                    onClick: ({ key }) => { const t = d.templates.find((x) => x.id === key)!; let id = t.id; for (let n = 2; d.agents.some((a) => a.id === id); n++) id = `${t.id}-${n}`; setEditing({ agent: { ...t, id }, isNew: true }); } }}>
                    <Button size="small">From a template <DownOutlined /></Button>
                </Dropdown>
                <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ agent: blank(), isNew: true })}>New agent</Button>
            </Space>} />
            {shown.length === 0 ? <Card><Empty description={d.agents.length ? 'None of this kind.' : 'No team agents yet: start from a template, or make a new one.'} /></Card> : (
                <Row gutter={[12, 12]}>
                    {shown.map((a) => (
                        <Col key={a.id} xs={24} md={12} xl={8}>
                            <Card size="small" hoverable style={{ height: '100%', display: 'flex', flexDirection: 'column' }} styles={{ body: { flex: 1 } }} onClick={() => setEditing({ agent: a, isNew: false })}
                                title={<Space>{a.mode === 'assistant' ? <RobotOutlined /> : <RocketOutlined />}<Typography.Text ellipsis={{ tooltip: a.name }} style={{ maxWidth: 220 }}>{a.name}</Typography.Text></Space>} extra={<Tag color={a.mode === 'assistant' ? 'blue' : 'purple'}>{a.mode}</Tag>}
                                actions={[a.mode === 'assistant'
                                    ? <Button key="c" type="link" size="small" icon={<MessageOutlined />} onClick={(e) => { e.stopPropagation(); void chat(a); }}>Chat</Button>
                                    : <Button key="m" type="link" size="small" icon={<RocketOutlined />} onClick={(e) => { e.stopPropagation(); startMissionFor(a.id); navigate(['missions']); }}>Run under Missions</Button>,
                                    <Button key="e" type="link" size="small" icon={<ExperimentOutlined />} onClick={(e) => { e.stopPropagation(); setEvaluating(a); }}>Evaluate</Button>]}>
                                <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ marginBottom: 6, fontSize: 13 }}>{a.description || a.instructions}</Typography.Paragraph>
                                <Space size={[4, 4]} wrap>{a.tools.slice(0, 4).map((t) => <Tag key={t} style={{ fontSize: 11 }}>{d.groups.find((g) => g.id === t)?.label ?? t}</Tag>)}{a.tools.length > 4 && <Tooltip title={a.tools.slice(4).map((t) => d.groups.find((g) => g.id === t)?.label ?? t).join(', ')}><Tag style={{ fontSize: 11 }}>+{a.tools.length - 4}</Tag></Tooltip>}
                                    {!!a.triggers?.length && <Tooltip title={a.triggers.map((t) => TRIGGER_LABEL[t.on] + (t.enabled === false ? ' (off)' : '')).join(', ')}><Tag icon={<ThunderboltOutlined />} color={a.triggers.some((t) => t.enabled !== false) ? 'gold' : 'default'} style={{ fontSize: 11 }}>{a.triggers.length} trigger{a.triggers.length === 1 ? '' : 's'}</Tag></Tooltip>}</Space>
                                <div><Typography.Text type="secondary" style={{ fontSize: 11 }}>{[a.updatedBy, a.updatedAt ? new Date(a.updatedAt).toLocaleDateString() : ''].filter(Boolean).join(', ')}</Typography.Text></div>
                            </Card>
                        </Col>
                    ))}
                </Row>
            )}
            {evaluating && <AgentEvals agent={evaluating} onClose={() => setEvaluating(null)} />}
            {editing && <AgentEditor key={`${editing.agent.id}:${editing.isNew ? 'new' : d.versions?.[editing.agent.id] ?? ''}`} d={d} agent={editing.agent} isNew={editing.isNew} onClose={() => setEditing(null)} onSaved={(r) => { setD(r); setEditing(null); }} onChat={chat} onReload={(id) => void reloadAgent(id)} />}
        </Space>
    );
}

/** What an id field keeps while someone types (lower-case letters, digits and -); trimmed of - when saved. */
const idTyping = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+/, '').slice(0, 40);
const INPUT_KINDS = [{ value: 'text', label: 'Text' }, { value: 'project', label: 'Project' }, { value: 'env', label: 'Environment' }, { value: 'run', label: 'Failed run' }, { value: 'number', label: 'Number' }];

/** The editor tab where a problem the server found is fixed (its message says what it is about). */
function tabOfError(t: string, mission: boolean): string | null {
    if (/agent id|an agent "|built-in mission|give the agent a name|mode:/i.test(t)) return 'basics';
    if (/the goal|goal uses|instructions|starter/i.test(t)) return 'instructions';
    if (!mission) return /tool group|knowledge source|tools/i.test(t) ? 'tools' : null;
    if (/^(two inputs|input ")/i.test(t)) return 'inputs';
    if (/team|tool group|knowledge source|"change files" tools/i.test(t)) return 'tools';
    if (/trigger|schedule|start by themselves/i.test(t)) return 'triggers';
    if (/proof|budget|minutes|model calls|attempts/i.test(t)) return 'limits';
    return null;
}

function AgentEditor({ d, agent, isNew, onClose, onSaved, onChat, onReload }: { d: AgentBuilderView; agent: TeamAgentDef; isNew: boolean; onClose: () => void; onSaved: (r: AgentBuilderDef) => void; onChat: (a: TeamAgentDef) => void; onReload: (id: string) => void }) {
    const { message, modal } = App.useApp();
    const { env } = useStudio();
    const [a, setA] = React.useState<TeamAgentDef>(agent);
    const [busy, setBusy] = React.useState(false);
    // The version of the agent's file this editor started from: a save over a newer one (another tab) is refused.
    const [version] = React.useState<string | undefined>(() => (isNew ? undefined : d.versions?.[agent.id]));
    const mission = a.mode === 'mission';
    const tabKeys = mission ? ['basics', 'instructions', 'inputs', 'tools', 'triggers', 'limits'] : ['basics', 'instructions', 'tools'];
    const [tab, setTab] = useRememberedTab('agent-editor', 'basics', tabKeys);
    const up = (p: Partial<TeamAgentDef>) => setA((x) => ({ ...x, ...p }));
    // Unsaved work: closing asks first, and so does leaving the page.
    // Whole-number fields in error (a budget, a trigger's daily limit): not saved until put right (and not lost silently).
    const numbers = useValidity();
    const dirty = JSON.stringify(a) !== JSON.stringify(agent) || numbers.bad.length > 0;
    // Another screen (the menu, Back, an address typed) asks first: Save, Discard or Stay.
    const saveRef = React.useRef<() => Promise<boolean>>(async () => false);
    useUnsaved('agent-editor', dirty, `the agent "${a.name || 'new agent'}"`, { lostOnLeave: true, save: () => saveRef.current(), discard: onClose });
    const close = () => { if (!dirty) { onClose(); return; } modal.confirm({ title: 'Discard your changes to this agent?', okText: 'Discard', okButtonProps: { danger: true }, cancelText: 'Keep editing', onOk: onClose }); };
    const toggle = (g: ToolGroupId, on: boolean) => up({ tools: on ? [...new Set([...a.tools, g])] : a.tools.filter((x) => x !== g) });
    const finalId = isNew ? (a.id.replace(/^-+|-+$/g, '') || slug(a.name)) : a.id;
    const fail = (t: string, text: string) => { setTab(t); message.error({ content: text, key: 'agent-editor-check' }); };
    // Checked as you type (the server's rules): each problem next to its field, and Save waits until they are put right.
    const idProblem = isNew ? agentIdProblem(finalId, { reserved: d.reserved, existing: d.agents.map((x) => x.id) }) : null;
    const nameProblem = a.name.trim() ? null : 'Give the agent a name.';
    const instrProblem = instructionsProblem(a.instructions ?? '');
    const goalProblem = mission && !a.goal?.trim() ? 'Write the mission\'s goal.' : null;
    const cronProblems = mission ? (a.triggers ?? []).map((t) => (t.on === 'schedule' ? cronProblem(t.cron ?? '') : null)) : [];
    const problems: Array<[string, string]> = [
        ...(nameProblem ? [['basics', `Name: ${nameProblem}`] as [string, string]] : []),
        ...(idProblem ? [['basics', `Id: ${idProblem}`] as [string, string]] : []),
        ...(goalProblem ? [['instructions', goalProblem] as [string, string]] : []),
        ...(instrProblem ? [['instructions', `Instructions: ${instrProblem}`] as [string, string]] : []),
        ...cronProblems.flatMap((c, i) => (c ? [['triggers', `Trigger ${i + 1}, schedule: ${c}`] as [string, string]] : [])),
    ];
    const saving = React.useRef(false);
    const save = async (): Promise<boolean> => {
        if (busy || saving.current) return false;
        if (problems.length) { fail(problems[0][0], `Put right first: ${problems.map((x) => x[1]).join(' ')}`); return false; }
        if (!a.name.trim()) { fail('basics', 'Give the agent a name.'); return false; }
        if (isNew && !finalId) { fail('basics', 'Give the agent an id (letters, digits and -).'); return false; }
        if (!a.instructions.trim()) { fail('instructions', 'Write how it works (its instructions).'); return false; }
        if (mission && !a.goal?.trim()) { fail('instructions', 'Write the mission\'s goal.'); return false; }
        if (mission && (a.inputs ?? []).some((x) => !x.key)) { fail('inputs', 'Every input needs a name (or remove the empty one).'); return false; }
        if (mission && numbers.bad.length) { const b = numbers.bad[0]; fail(/^Trigger/.test(b) ? 'triggers' : 'limits', `Put right first: ${numbers.bad.join(', ')} (a whole number in range).`); return false; }
        saving.current = true;
        setBusy(true);
        const out: TeamAgentDef = { ...a, name: a.name.trim(), id: finalId, ...(mission ? {} : { goal: undefined, inputs: undefined, writes: undefined, budget: undefined, verify: undefined, triggers: undefined, team: undefined }) };
        const put = async (force: boolean) => {
            const r = await agentsApi.saveTeamAgent(out, isNew, version, force);
            message.success({ content: `Saved ${r.agent.name}`, key: 'agent-editor-check' });
            onSaved(r);
        };
        try { await put(false); return true; }
        catch (e) {
            // Changed in another tab or by someone else since this editor opened: reload it, or overwrite on purpose.
            if (isChangedElsewhere(e)) {
                return new Promise<boolean>((resolve) => askChangedElsewhere(modal, e, `The agent "${agent.name}"`, {
                    reload: () => { resolve(false); onReload(agent.id); },
                    overwrite: () => put(true).then(() => resolve(true), (x) => { const t = errText(x); fail(tabOfError(t, mission) ?? tab, t); resolve(false); }),
                    keepEditing: () => resolve(false),
                }));
            }
            const t = errText(e); fail(tabOfError(t, mission) ?? tab, t); return false;
        } finally { saving.current = false; setBusy(false); }
    };
    saveRef.current = save;
    const del = () => modal.confirm({ title: `Delete ${a.name}?`, content: `Its file ${d.dir}/${a.id}.json and its evaluation cases (.cs-studio/evals/${a.id}.json, if any) are deleted (commit to share that).`, okText: 'Delete', okButtonProps: { danger: true },
        onOk: async () => { try { onSaved(await api.deleteTeamAgent(a.id)); message.success('Deleted'); } catch (e) { message.error(errText(e)); } } });
    const inputs = a.inputs ?? [];
    const setInput = (i: number, p: Partial<MissionInputDef>) => up({ inputs: inputs.map((x, j) => (j === i ? { ...x, ...p } : x)) });
    const triggers = a.triggers ?? [];
    const setTrigger = (i: number, t: AgentTriggerDef) => up({ triggers: triggers.map((x, j) => (j === i ? t : x)) });
    const projects = env?.projects ?? [];
    const lbl = (t: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t}</Typography.Text>;
    const verifyKind = a.verify?.kind === 'report' ? 'report' : a.verify?.kind === 'tests' && a.verify.tags !== undefined ? 'tags' : 'changed';
    const items = [
        { key: 'basics', label: 'Basics', children: (
            <Form layout="vertical" size="small">
                <Row gutter={12}>
                    <Col xs={24} md={12}><Form.Item label="Name" required validateStatus={nameProblem && dirty ? 'error' : undefined} help={dirty ? nameProblem : undefined}><Input value={a.name} maxLength={80} showCount aria-label="Name" placeholder="e.g. Checkout test reviewer" onChange={(e) => up({ name: e.target.value, ...(isNew && (!a.id || a.id === slug(a.name)) ? { id: slug(e.target.value) } : {}) })} /></Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item label="Id (its file name)" tooltip="Lower-case letters, digits and -; it cannot change later" validateStatus={idProblem && (a.id || a.name) ? 'error' : undefined} help={idProblem && (a.id || a.name) ? idProblem : undefined}><Input value={a.id} disabled={!isNew} maxLength={40} aria-label="Id" placeholder={slug(a.name) || 'my-agent'} onChange={(e) => up({ id: idTyping(e.target.value) })} /></Form.Item></Col>
                </Row>
                <Form.Item label="Description"><Input value={a.description} maxLength={200} aria-label="Description" placeholder="What it is for, in one sentence" onChange={(e) => up({ description: e.target.value })} /></Form.Item>
                <Row gutter={12}>
                    <Col xs={24} md={12}><Form.Item label="Kind" tooltip="Assistant: a chat — people ask, it answers and acts with its tools. Mission: works on a goal alone, in its own copy, checked by the Studio; can start by itself.">
                        <Radio.Group optionType="button" buttonStyle="solid" value={a.mode} aria-label="Kind" onChange={(e) => up({ mode: e.target.value, ...(e.target.value === 'mission' && !a.inputs ? { inputs: [{ key: 'project', label: 'Project', required: true, kind: 'project' }, { key: 'env', label: 'Environment', required: true, kind: 'env' }], writes: true, verify: { kind: 'tests', features: 'changed' }, tools: [...new Set([...a.tools, 'files' as ToolGroupId])] } : {}) })}
                            options={[{ value: 'assistant', label: <span><RobotOutlined /> Assistant</span> }, { value: 'mission', label: <span><RocketOutlined /> Mission</span> }]} />
                    </Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item label="Model" tooltip={d.policyModels ? `The repository's policy allows: ${d.policyModels.join(', ')}` : 'Empty: each person\'s own model setting'}>
                        {d.policyModels ? <Select allowClear value={a.model} aria-label="Model" onChange={(v) => up({ model: v })} options={d.policyModels.map((m) => ({ value: m }))} placeholder="Each person's setting" /> : <Input value={a.model} aria-label="Model" placeholder="Each person's setting" onChange={(e) => up({ model: e.target.value || undefined })} />}
                    </Form.Item></Col>
                </Row>
            </Form>
        ) },
        { key: 'instructions', label: 'Instructions', children: (
            <Form layout="vertical" size="small">
                {mission && <Form.Item label="Goal" required tooltip="What done means. {name} is filled from an input (Inputs tab)." validateStatus={goalProblem && dirty ? 'error' : undefined} help={dirty ? goalProblem : undefined}><Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={a.goal} aria-label="Goal" onChange={(e) => up({ goal: e.target.value })} placeholder="Automate the work item {story} in project {project}, environment {env}." /></Form.Item>}
                <Form.Item label="How it works" required tooltip="Its role, the rules it follows, the steps it takes, and what a good result is" validateStatus={instrProblem && (dirty || !isNew) ? 'error' : undefined} help={dirty || !isNew ? instrProblem : undefined}>
                    <Input.TextArea rows={mission ? 9 : 12} value={a.instructions} aria-label="Instructions" onChange={(e) => up({ instructions: e.target.value })} placeholder={'You review test code for the checkout team.\n- Always search the knowledge for the team\'s standards first.\n- Never change files: suggest the change with the file and line.\n- Finish with a short list of the most important improvements.'} />
                </Form.Item>
                {!mission && <Form.Item label="Conversation starters" tooltip="Shown when someone starts a chat with it (up to 6)">
                    <Select mode="tags" maxCount={6} value={a.starters ?? []} aria-label="Conversation starters" onChange={(v: string[]) => up({ starters: v.map((x) => x.trim()).filter(Boolean) })} placeholder="Type a question and press Enter" open={false} />
                </Form.Item>}
            </Form>
        ) },
        ...(mission ? [{ key: 'inputs', label: `Inputs (${inputs.length})`, children: (
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
                {inputs.length > 0 && <Row gutter={8}><Col span={6}>{lbl('Name')}</Col><Col span={8}>{lbl('Label')}</Col><Col span={5}>{lbl('Kind')}</Col><Col span={4}>{lbl('Required')}</Col></Row>}
                {inputs.map((i, j) => (
                    <Row key={j} gutter={8} align="middle">
                        <Col span={6}><Input size="small" value={i.key} placeholder="name" maxLength={30} aria-label={`Input ${j + 1} name`} status={!i.key ? 'warning' : undefined} title="Letters and digits (story_id and story-id become storyId)" onChange={(e) => { const key = e.target.value.replace(/[_\- ]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, ''); const follows = !i.label || i.label === i.key || i.label === labelOf(i.key); setInput(j, { key, ...(follows ? { label: labelOf(key) } : {}) }); }} /></Col>
                        <Col span={8}><Input size="small" value={i.label} placeholder="Label" maxLength={60} aria-label={`Input ${j + 1} label`} onChange={(e) => setInput(j, { label: e.target.value })} /></Col>
                        <Col span={5}><Select size="small" style={{ width: '100%' }} value={i.kind ?? 'text'} aria-label={`Input ${j + 1} kind`} onChange={(v) => setInput(j, { kind: v })} options={INPUT_KINDS} /></Col>
                        <Col span={4}><Checkbox checked={!!i.required} onChange={(e) => setInput(j, { required: e.target.checked })}>required</Checkbox></Col>
                        <Col span={1}><Tooltip title="Remove the input"><Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Remove input ${j + 1}`} onClick={() => up({ inputs: inputs.filter((_, k) => k !== j) })} /></Tooltip></Col>
                    </Row>
                ))}
                {!inputs.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No inputs: the goal is the same every time." />}
                <div><Button size="small" icon={<PlusOutlined />} onClick={() => up({ inputs: [...inputs, { key: '', label: '' }] })}>Add an input</Button></div>
            </Space>
        ) }] : []),
        { key: 'tools', label: 'Tools & knowledge', children: (
            <Form layout="vertical" size="small">
                <Form.Item label="Tools it may use" tooltip="Anything else is refused; the repository's agent policy and approvals still apply.">
                    <Row gutter={[12, 6]}>{d.groups.map((g) => (
                        <Col key={g.id} xs={24} md={12}><Checkbox checked={a.tools.includes(g.id)} onChange={(e) => toggle(g.id, e.target.checked)}>{g.label} <Tooltip title={g.about}><QuestionCircleOutlined style={{ color: 'var(--ant-color-text-tertiary, #999)', fontSize: 12 }} /></Tooltip></Checkbox></Col>
                    ))}</Row>
                </Form.Item>
                <Row gutter={12}>
                    <Col xs={24} md={mission ? 12 : 24}><Form.Item label="Knowledge it may search" tooltip="Empty: every knowledge source (Agents → Knowledge). Needs the Knowledge tool.">
                        <Select mode="multiple" allowClear value={a.knowledge ?? []} aria-label="Knowledge" onChange={(v) => up({ knowledge: v.length ? v : undefined })} options={d.knowledge.map((k) => ({ value: k.id, label: k.name }))} placeholder="All sources" disabled={!a.tools.includes('knowledge')} />
                    </Form.Item></Col>
                    {mission && <Col xs={24} md={12}><Form.Item label="Team" tooltip="Agents it can hand work to: each works in its own session with its own tools, up to 3 at once; their model calls count in the budget. It leads, combines their answers and reports.">
                        <Select mode="multiple" maxCount={8} allowClear style={{ width: '100%' }} aria-label="Team" placeholder="No team: it works alone" value={a.team ?? []} onChange={(v: string[]) => up({ team: v.length ? v : undefined })}
                            options={(d.teamCandidates ?? []).filter((c) => c.id !== a.id).map((c) => ({ value: c.id, label: `${c.name}${c.builtIn ? ' (built in)' : ''}`, title: c.description }))} />
                    </Form.Item></Col>}
                </Row>
            </Form>
        ) },
        ...(mission ? [{ key: 'triggers', label: `Triggers (${triggers.length})`, children: (
            <Space direction="vertical" style={{ width: '100%' }}>
                {triggers.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No triggers: it starts only when someone starts it under Missions." />}
                {triggers.map((t, i) => (
                    <Card key={i} size="small" title={<Space><ThunderboltOutlined />{TRIGGER_LABEL[t.on]}</Space>} extra={<Space><Tooltip title={t.enabled !== false ? 'On' : 'Off'}><Switch size="small" checked={t.enabled !== false} aria-label={`Trigger ${i + 1} on`} onChange={(v) => setTrigger(i, { ...t, enabled: v })} /></Tooltip><Tooltip title="Remove the trigger"><Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Remove trigger ${i + 1}`} onClick={() => up({ triggers: triggers.filter((_, k) => k !== i) })} /></Tooltip></Space>}>
                        <Form layout="vertical" size="small">
                            <Row gutter={12}>
                                {t.on === 'run-failed' && <><Col xs={24} md={9}><Form.Item label="Projects"><Select mode="multiple" placeholder="Any project" aria-label={`Trigger ${i + 1}: projects`} value={t.projects ?? []} onChange={(v) => setTrigger(i, { ...t, projects: v })} options={projects.map((p) => ({ value: p }))} /></Form.Item></Col>
                                    <Col xs={24} md={9}><Form.Item label="Environments"><Select mode="tags" placeholder="Any environment" aria-label={`Trigger ${i + 1}: environments`} value={t.envs ?? []} onChange={(v) => setTrigger(i, { ...t, envs: v })} open={false} /></Form.Item></Col></>}
                                {t.on === 'schedule' && <Col xs={24} md={18}><Form.Item label="Schedule (cron)" tooltip="Minute hour day month weekday, on this computer's clock; e.g. 0 2 * * 1-5 is 02:00 on weekdays" validateStatus={cronProblems[i] ? 'error' : undefined} help={cronProblems[i] ?? undefined}><Input className="mono" aria-label={`Trigger ${i + 1}: schedule (cron)`} value={t.cron} onChange={(e) => setTrigger(i, { ...t, cron: e.target.value })} placeholder="0 2 * * 1-5" /></Form.Item></Col>}
                                {t.on === 'work-item' && <><Col xs={24} md={12}><Form.Item label="WIQL query"><Input.TextArea autoSize={{ minRows: 1, maxRows: 5 }} aria-label={`Trigger ${i + 1}: WIQL query`} value={t.query} onChange={(e) => setTrigger(i, { ...t, query: e.target.value })} placeholder="SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS 'automate'" /></Form.Item></Col>
                                    <Col xs={24} md={6}><Form.Item label="The work item fills"><Select aria-label={`Trigger ${i + 1}: the work item fills`} value={t.input ?? 'story'} onChange={(v) => setTrigger(i, { ...t, input: v })} options={inputs.filter((x) => x.key).map((x) => ({ value: x.key, label: x.key }))} /></Form.Item></Col></>}
                                {t.on === 'pull-request' && <><Col xs={24} md={9}><Form.Item label="Into branch"><Input aria-label={`Trigger ${i + 1}: into branch`} value={t.target} placeholder="main" onChange={(e) => setTrigger(i, { ...t, target: e.target.value })} /></Form.Item></Col>
                                    <Col xs={24} md={9}><Form.Item label="Repository"><Input aria-label={`Trigger ${i + 1}: repository`} value={t.repository} placeholder="Any" onChange={(e) => setTrigger(i, { ...t, repository: e.target.value || undefined })} /></Form.Item></Col></>}
                                <Col xs={24} md={6}><Form.Item label="At most"><WholeNumber min={1} max={50} fallback={3} label={`Trigger ${i + 1}: at most, a day`} onValidity={numbers.ok(`Trigger ${i + 1}: at most, a day`)} value={t.maxPerDay ?? 3} onChange={(v) => setTrigger(i, { ...t, maxPerDay: v })} suffix="a day" style={{ width: '100%' }} /></Form.Item></Col>
                            </Row>
                            {(t.on === 'schedule' || t.on === 'work-item' || t.on === 'pull-request') && inputs.some((x) => x.key) && (
                                <Form.Item label="Inputs given by this trigger" style={{ marginBottom: 0 }}>
                                    <Row gutter={[8, 8]}>{inputs.filter((x) => x.key && !(t.on === 'work-item' && x.key === (t.input ?? 'story')) && !(t.on === 'pull-request' && (x.key === 'pr' || x.key === 'repository'))).map((x) => (
                                        <Col key={x.key} xs={24} md={8}><Input size="small" addonBefore={x.key} aria-label={`Trigger ${i + 1}: input ${x.key}`} value={(t as { inputs?: Record<string, string> }).inputs?.[x.key] ?? ''} onChange={(e) => setTrigger(i, { ...t, inputs: { ...((t as { inputs?: Record<string, string> }).inputs ?? {}), [x.key]: e.target.value } } as AgentTriggerDef)} /></Col>
                                    ))}</Row>
                                </Form.Item>
                            )}
                        </Form>
                    </Card>
                ))}
                <Space>
                    <Dropdown menu={{ items: (Object.keys(TRIGGER_LABEL) as AgentTriggerDef['on'][]).map((k) => ({ key: k, label: TRIGGER_LABEL[k] })), onClick: ({ key }) => up({ triggers: [...triggers, key === 'schedule' ? { on: 'schedule', cron: '0 2 * * 1-5' } : key === 'work-item' ? { on: 'work-item', query: '' } : key === 'pull-request' ? { on: 'pull-request', target: 'main' } : { on: 'run-failed' }] }) }}>
                        <Button size="small" icon={<PlusOutlined />}>Add a trigger <DownOutlined /></Button>
                    </Dropdown>
                    <Tooltip title="One mission at a time; others wait in the queue. Each trigger has a daily limit."><QuestionCircleOutlined style={{ color: 'var(--ant-color-text-tertiary, #999)' }} /></Tooltip>
                </Space>
            </Space>
        ) }, { key: 'limits', label: 'Limits', children: (
            <Form layout="vertical" size="small">
                <Row gutter={12}>
                    <Col xs={24} md={12}><Form.Item label="It changes files" tooltip={a.writes !== false ? 'Works in its own copy of the repository, on its own branch' : 'Reads only; its report is the result'}>
                        <Space><Switch checked={a.writes !== false} aria-label="It changes files" onChange={(v) => up({ writes: v, ...(v ? { tools: [...new Set([...a.tools, 'files' as ToolGroupId])], ...(a.verify?.kind === 'report' ? { verify: { kind: 'tests', features: 'changed' } } : {}) } : { verify: { kind: 'report' } }) })} /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{a.writes !== false ? 'In its own copy' : 'Reads only'}</Typography.Text></Space>
                    </Form.Item></Col>
                    <Col xs={24} md={12}><Form.Item label="Proof the Studio runs when it reports done">
                        <Row gutter={8}>
                            <Col flex="auto"><Select style={{ width: '100%' }} value={verifyKind} aria-label="Proof" onChange={(v) => up({ verify: v === 'report' ? { kind: 'report' } : v === 'tags' ? { kind: 'tests', tags: '@smoke' } : { kind: 'tests', features: 'changed' } })}
                                options={[{ value: 'changed', label: 'Run the features it changed', disabled: a.writes === false }, { value: 'tags', label: 'Run tests with tags' }, { value: 'report', label: 'Its report (read-only missions)' }]} /></Col>
                            {verifyKind === 'tags' && <Col flex="140px"><Input value={a.verify?.kind === 'tests' ? a.verify.tags : ''} aria-label="Tags" onChange={(e) => up({ verify: { kind: 'tests', tags: e.target.value } })} placeholder="@smoke or {tags}" /></Col>}
                        </Row>
                    </Form.Item></Col>
                </Row>
                <Form.Item label="Budget" tooltip="The mission stops when it uses more; time waiting for a person does not count.">
                    <Row gutter={8}>
                        <Col xs={24} md={8}><WholeNumber min={5} max={480} fallback={45} value={a.budget?.minutes ?? 45} label="Minutes" onValidity={numbers.ok('Minutes')} onChange={(v) => up({ budget: { ...a.budget, minutes: v } })} suffix="min" style={{ width: '100%' }} /></Col>
                        <Col xs={24} md={8}><WholeNumber min={10} max={2000} fallback={120} value={a.budget?.modelCalls ?? 120} label="Model calls" onValidity={numbers.ok('Model calls')} onChange={(v) => up({ budget: { ...a.budget, modelCalls: v } })} suffix="model calls" style={{ width: '100%' }} /></Col>
                        <Col xs={24} md={8}><WholeNumber min={1} max={10} fallback={3} value={a.budget?.attempts ?? 3} label="Attempts" onValidity={numbers.ok('Attempts')} onChange={(v) => up({ budget: { ...a.budget, attempts: v } })} suffix="attempts" style={{ width: '100%' }} /></Col>
                    </Row>
                </Form.Item>
            </Form>
        ) }] : []),
    ];
    return (
        <Modal open width={900} title={<Space>{mission ? <RocketOutlined /> : <RobotOutlined />}{isNew ? 'New agent' : `Agent: ${agent.name}`}{dirty && <Tag color="gold" bordered={false}>unsaved</Tag>}</Space>} onCancel={close} maskClosable={false}
            styles={{ body: { minHeight: 380 } }}
            footer={<Space wrap>{!isNew && <Button danger icon={<DeleteOutlined />} onClick={del}>Delete</Button>}{!isNew && a.mode === 'assistant' && <Button icon={<MessageOutlined />} onClick={() => { if (dirty) { message.warning('Save your changes first, then chat with it.'); return; } onClose(); onChat(a); }}>Chat with it</Button>}<Button onClick={close}>Cancel</Button><Tooltip title={problems.length ? <span>Put right first:{problems.map((x, k) => <div key={k}>{x[1]}</div>)}</span> : undefined}><Button type="primary" loading={busy} disabled={problems.length > 0} onClick={() => void save()}>Save</Button></Tooltip></Space>}>
            <Tabs size="small" activeKey={tab} onChange={setTab} items={items.map((it) => ((dirty || !isNew) && problems.some((x) => x[0] === it.key) ? { ...it, label: <Tooltip title={problems.filter((x) => x[0] === it.key).map((x) => x[1]).join(' ')}><Typography.Text type="danger">{it.label} !</Typography.Text></Tooltip> } : it))} />
        </Modal>
    );
}
