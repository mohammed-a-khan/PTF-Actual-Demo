/**
 * Missions: agents that work toward a goal alone — in their own copy of the repository, within a budget — and are
 * checked by the Studio. Start one, answer it when it asks, review the result, then bring it in, publish it as a
 * pull request, or discard it. Team notes for agents and the team's triggers are here too.
 */
import React from 'react';
import { Alert, App, Button, Card, Col, Descriptions, Drawer, Empty, Form, Input, List, Modal, Popconfirm, Progress, Radio, Result, Row, Select, Space, Table, Tabs, Tag, Timeline, Tooltip, Typography } from 'antd';
import { AimOutlined, BranchesOutlined, CheckCircleFilled, CloseCircleFilled, DeleteOutlined, ExperimentOutlined, FileTextOutlined, PauseCircleOutlined, PullRequestOutlined, ReloadOutlined, TeamOutlined, HistoryOutlined, RocketOutlined, SafetyCertificateOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api, ApiError, ExploreNoteDef, MissionDef, MissionStateDef, MissionSummaryDef, MissionTemplateDef, RunInfo } from '../api';
import { errText, useStudio } from '../state';
import { navigate, useRoute } from '../route';
import { DiffView } from '../components/DiffView';
import { isTab, useRememberedTab } from '../agents-tabs';
import { useUnsaved } from '../unsaved';
import { Markdown } from '../components/Markdown';
import { Replay } from '../components/Replay';
import { agentsApi, AgentTriggerView, MissionsView } from '../agents-api';
import { askChangedElsewhere, isChangedElsewhere } from '../components/ChangedElsewhere';
import { useValidity, WholeNumber } from '../components/WholeNumber';
import { openAgentEditor } from './AgentBuilder';

/** What a mission agent's trigger does, in words. */
const agentTriggerText = (t: AgentTriggerView) => t.on === 'schedule' ? `schedule ${t.cron}` : t.on === 'run-failed' ? 'when a run fails' : t.on === 'work-item' ? 'new or changed work items' : `pull requests${t.target ? ` into ${t.target}` : ''}`;

const STATE: Record<MissionStateDef, { label: string; color: string }> = {
    queued: { label: 'Queued', color: 'default' }, preparing: { label: 'Preparing', color: 'processing' }, working: { label: 'Working', color: 'processing' }, waiting: { label: 'Waiting for you', color: 'warning' },
    verifying: { label: 'Verifying', color: 'processing' }, succeeded: { label: 'Done', color: 'success' }, partial: { label: 'Partly done', color: 'gold' },
    failed: { label: 'Failed', color: 'error' }, blocked: { label: 'Blocked', color: 'orange' }, 'over-budget': { label: 'Over budget', color: 'error' }, stopped: { label: 'Stopped', color: 'default' },
};
const MISSION_TABS = ['start', 'running', 'finished', 'triggers'];
/** A budget bar: amber when nearly used, red when used up or over. */
const budgetBar = (used: number, budget: number, label: string) => {
    const r = budget > 0 ? used / budget : 0;
    return <Progress size="small" percent={Math.min(100, Math.round(r * 100))} status={r >= 1 ? 'exception' : 'normal'} strokeColor={r >= 1 ? undefined : r >= 0.8 ? '#faad14' : undefined} format={() => label} />;
};
const LIVE: MissionStateDef[] = ['queued', 'preparing', 'working', 'waiting', 'verifying'];
const mins = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);
const ago = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString(); };

// Set by another screen ("Run under Missions") to open that agent's start dialog when this page loads.
let startNext: string | null = null;
export function startMissionFor(key: string): void { startNext = key; }

export function Missions({ openConversation }: { openConversation: (session: string) => void }) {
    const { message } = App.useApp();
    const route = useRoute();
    // #/missions/<tab> is a tab (start, running, finished, triggers); anything else, a mission.
    const open = isTab(route[1], MISSION_TABS) ? undefined : route[1];
    const [d, setD] = React.useState<MissionsView | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [starting, setStarting] = React.useState<MissionTemplateDef | null>(null);
    const [notesOpen, setNotesOpen] = React.useState(false);
    const [tab, setTab] = useRememberedTab('missions', 'start', MISSION_TABS, 'missions', { items: true });
    const load = React.useCallback(() => { agentsApi.missions().then((r) => { setD(r); setErr(null); }).catch((e) => { startNext = null; setErr(errText(e)); }); }, []);
    React.useEffect(load, [load]);
    React.useEffect(() => {
        if (!d || !startNext) return;
        const t = d.templates.find((x) => x.key === startNext);
        startNext = null;
        if (t) setStarting(t); else message.warning('That agent is not among the missions yet: check it in Agent builder.');
    }, [d, message]);
    // Live missions change by themselves: refresh while one works.
    React.useEffect(() => {
        if (!d?.runs.some((r) => LIVE.includes(r.state))) return;
        const t = setInterval(load, 3000);
        return () => clearInterval(t);
    }, [d, load]);
    if (err) return <Alert type="error" showIcon message={err} />;
    if (!d) return null;
    const running = d.runs.find((r) => LIVE.includes(r.state));
    const live = d.runs.filter((r) => LIVE.includes(r.state));
    const done = d.runs.filter((r) => !LIVE.includes(r.state));
    // The triggers that are on: the team's (missions.json) and the mission agents' own (Agent builder).
    const agentTriggers = d.agentTriggers ?? [];
    const triggersOn = d.triggers.filter((t) => t.enabled !== false).length + agentTriggers.filter((t) => t.enabled !== false).length;
    const remove = async (id: string) => { try { await agentsApi.deleteMission(id); message.success('Mission deleted'); if (open === id) navigate(['missions', 'finished']); load(); } catch (e) { message.error(errText(e)); } };
    const table = (rows: MissionSummaryDef[], empty: string) => rows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} /> : (
        <Table<MissionSummaryDef> size="small" rowKey="id" dataSource={rows} pagination={{ pageSize: 15, hideOnSinglePage: true }} onRow={(r) => ({ onClick: () => navigate(['missions', r.id]), style: { cursor: 'pointer' } })} columns={[
            { title: 'Mission', dataIndex: 'title', render: (v: string, r) => <Space direction="vertical" size={0}><Typography.Text strong>{v}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.trigger.kind === 'manual' ? `by ${r.trigger.by}` : r.trigger.kind === 'run-failed' ? `after failed run ${r.trigger.ref ?? ''}` : r.trigger.kind === 'pipeline' ? 'from a pipeline' : `on schedule ${r.trigger.ref ?? ''}`} · {ago(r.createdAt)}</Typography.Text></Space> },
            { title: 'State', width: 190, render: (_: unknown, r) => <Space size={4} wrap><Tag color={STATE[r.state].color}>{STATE[r.state].label}</Tag>{r.verified && <Tooltip title="The Studio ran the proof itself and it passed"><Tag icon={<SafetyCertificateOutlined />} color="green">verified</Tag></Tooltip>}</Space> },
            { title: 'Work', width: 220, render: (_: unknown, r) => <Space direction="vertical" size={0} style={{ width: '100%' }}>{budgetBar(r.used.activeMs, r.budget.minutes * 60000, mins(r.used.activeMs))}<Typography.Text type={r.used.modelCalls >= r.budget.modelCalls ? 'danger' : 'secondary'} style={{ fontSize: 11 }}>{r.used.modelCalls}/{r.budget.modelCalls} model calls</Typography.Text></Space> },
            { title: 'Changes', dataIndex: 'changes', width: 140, render: (n: number, r) => (n ? `${n} file${n === 1 ? '' : 's'}` : '—') + (r.result ? ` · ${r.result}` : '') },
            ...(rows.some((r) => !LIVE.includes(r.state)) ? [{ title: '', width: 50, render: (_: unknown, r: MissionSummaryDef) => LIVE.includes(r.state) ? null : (
                <span onClick={(e) => e.stopPropagation()}>
                    <Popconfirm title="Delete this mission?" description={deleteText(r)} okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => remove(r.id)}>
                        <Tooltip title="Delete the mission"><Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Delete the mission ${r.title}`} /></Tooltip>
                    </Popconfirm>
                </span>) }] : []),
        ]} />
    );
    return (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {d.problems.length > 0 && <Alert type="warning" showIcon message={`${d.file}: ${d.problems.join(' ')}`} />}
            {running?.state === 'waiting' && <Alert type="warning" showIcon message={<>The mission <b>{running.title}</b> is waiting for you.</>} action={<Button size="small" type="primary" onClick={() => navigate(['missions', running.id])}>Answer</Button>} />}
            {open && <MissionDrawer key={open} id={open} onClose={() => navigate(['missions'])} onChanged={load} openConversation={openConversation} onDelete={remove} />}
            <Tabs size="small" activeKey={tab} onChange={setTab} tabBarExtraContent={<Space><Tooltip title="Every agent and mission reads these notes first"><Button size="small" icon={<FileTextOutlined />} onClick={() => setNotesOpen(true)}>Team notes for agents</Button></Tooltip><Tooltip title="Refresh"><Button size="small" icon={<ReloadOutlined />} onClick={load} aria-label="Refresh" /></Tooltip></Space>} items={[
                { key: 'start', icon: <RocketOutlined />, label: <span>Start a mission</span>, children: (
                    <Row gutter={[12, 12]}>
                        {d.templates.map((t) => (
                            <Col key={t.key} xs={24} md={12} xl={8}>
                                <Card size="small" hoverable style={{ height: '100%' }} onClick={() => setStarting(t)}
                                    title={<Space><AimOutlined /><Typography.Text ellipsis={{ tooltip: t.title }} style={{ maxWidth: 230 }}>{t.title}</Typography.Text></Space>} extra={t.writes ? <Tooltip title="Works in its own copy of the repository and branch; your working copy is not touched"><Tag icon={<BranchesOutlined />}>own copy</Tag></Tooltip> : <Tag>reads only</Tag>}>
                                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 2, tooltip: t.about }} style={{ marginBottom: 6, fontSize: 13 }}>{t.about}</Typography.Paragraph>
                                    {t.team?.length ? <Tooltip title={t.team.map((x) => x.name).join(', ')}><Tag icon={<TeamOutlined />} style={{ marginBottom: 6 }}>team of {t.team.length}</Tag></Tooltip> : null}
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Budget {t.budget.minutes} min · {t.budget.modelCalls} model calls{t.writes ? ` · ${t.budget.attempts} attempts` : ''}</Typography.Text>
                                </Card>
                            </Col>
                        ))}
                    </Row>
                ) },
                { key: 'running', label: <span>Running <Tag bordered={false} color={live.length ? 'processing' : undefined} style={{ marginInlineEnd: 0 }}>{live.length}</Tag></span>, children: <Card size="small">{table(live, 'No mission is working now: start one from the first tab.')}</Card> },
                { key: 'finished', label: <span>Finished <Tag bordered={false} style={{ marginInlineEnd: 0 }}>{done.length}</Tag></span>, children: <Card size="small">{table(done, 'No finished missions yet.')}</Card> },
                { key: 'triggers', icon: <ThunderboltOutlined />, label: <Tooltip title="Triggers that are on: the team's and the mission agents' own"><span>Triggers <Tag bordered={false} style={{ marginInlineEnd: 0 }}>{triggersOn}</Tag></span></Tooltip>, children: (
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    <Card size="small" title="Mission agents' triggers" extra={<Button size="small" type="link" onClick={() => navigate(['agent-builder', 'mission'])}>Agent builder</Button>}>
                        {agentTriggers.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No mission agent starts by itself. Add a trigger in Agent builder (a mission agent's Triggers tab)." /> : (
                            <List size="small" dataSource={agentTriggers} renderItem={(t) => (
                                <List.Item><Space wrap><Tag color={t.enabled === false ? 'default' : 'blue'}>{agentTriggerText(t)}</Tag><Tooltip title={`Open ${t.name} in Agent builder (its Triggers tab)`}><Typography.Link onClick={() => openAgentEditor(t.agent, 'mission', 'triggers')}>{t.name}</Typography.Link></Tooltip>
                                    <Typography.Text type="secondary">· at most {t.maxPerDay ?? 3} a day</Typography.Text>{t.enabled === false && <Tag>off</Tag>}</Space></List.Item>
                            )} />
                        )}
                    </Card>
                    <Card size="small" title="Team triggers" extra={<Space><Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{d.file}</Typography.Text><Tooltip title="Mission agents' own triggers are set in their editor"><Button size="small" type="link" onClick={() => navigate(['agent-builder'])}>Agent builder</Button></Tooltip></Space>}>
                        {d.triggers.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No team triggers. A mission agent's triggers are set in Agent builder (Triggers tab)." /> : (
                            <List size="small" dataSource={d.triggers} renderItem={(t) => (
                                <List.Item><Space wrap><Tag color={t.enabled === false ? 'default' : 'blue'}>{t.on === 'schedule' ? `schedule ${t.cron}` : 'when a run fails'}</Tag><Typography.Text>{d.templates.find((x) => x.key === t.mission)?.title ?? t.mission}</Typography.Text>
                                    {t.envs?.length ? <Typography.Text type="secondary">in {t.envs.join(', ')}</Typography.Text> : null}<Typography.Text type="secondary">· at most {t.maxPerDay ?? 3} a day</Typography.Text>{t.enabled === false && <Tag>off</Tag>}</Space></List.Item>
                            )} />
                        )}
                    </Card>
                    </Space>
                ) },
            ]} />
            {starting && <StartMission queue={!!running} t={starting} onClose={() => setStarting(null)} onStarted={(id) => { setStarting(null); setTab('running'); load(); navigate(['missions', id]); }} />}
            {notesOpen && <TeamNotes onClose={() => setNotesOpen(false)} />}
        </Space>
    );
}

function StartMission({ t, queue, onClose, onStarted }: { t: MissionTemplateDef; queue: boolean; onClose: () => void; onStarted: (id: string) => void }) {
    const { message } = App.useApp();
    const { env } = useStudio();
    const [v, setV] = React.useState<Record<string, string>>({});
    const [autonomy, setAutonomy] = React.useState<'autonomous' | 'supervised'>('autonomous');
    const [budget, setBudget] = React.useState(t.budget);
    const [runs, setRuns] = React.useState<RunInfo[]>([]);
    const [busy, setBusy] = React.useState(false);
    const startingNow = React.useRef(false);
    // Whole-number fields in error (a budget, a number input): the mission does not start until put right.
    const numbers = useValidity();
    const { modal } = App.useApp();
    // Typed into the dialog: Esc, the close button and Cancel ask before it is thrown away.
    const typed = Object.values(v).some((x) => (x ?? '').trim() !== '') || numbers.bad.length > 0;
    useUnsaved('start-mission', typed, `the "${t.title}" mission not started`, { lostOnLeave: true });
    const cancel = () => { if (!typed || busy) { if (!busy) onClose(); return; } modal.confirm({ title: 'Leave without starting?', content: 'What you typed for this mission is lost.', okText: 'Leave', okButtonProps: { danger: true }, cancelText: 'Stay', onOk: onClose }); };
    React.useEffect(() => { if (t.inputs.some((i) => i.kind === 'run')) api.runs().then((r) => setRuns(r.filter((x) => x.state === 'failed' && !x.workdir && (x.summary?.failed ?? 0) > 0).slice(0, 30))).catch(() => undefined); }, [t]);
    const projects = env?.projects ?? [];
    const envs = v.project ? env?.environments[v.project] ?? [] : [];
    const go = async () => {
        if (busy || startingNow.current) return;
        if (numbers.bad.length) { message.warning(`Put right first: ${numbers.bad.join(', ')} (a whole number in range).`); return; }
        const missing = t.inputs.filter((i) => i.required && !(v[i.key] ?? '').trim()).map((i) => i.label);
        if (missing.length) { message.warning(`Fill in: ${missing.join(', ')}`); return; }
        const badUrl = t.inputs.find((i) => i.key === 'url' && (v[i.key] ?? '').trim() && !/^https?:\/\/[^\s/?#]+\S*$/i.test((v[i.key] ?? '').trim()));
        if (badUrl) { message.warning(`${badUrl.label}: a web address starting with http:// or https://, or leave it empty for the environment's BASE_URL.`); return; }
        if (t.oneOf?.length && !t.oneOf.some((k) => (v[k] ?? '').trim())) { message.warning(`Fill in one of: ${t.oneOf.map((k) => t.inputs.find((i) => i.key === k)?.label ?? k).join(' or ')}`); return; }
        setBusy(true); startingNow.current = true;
        try { const m = await api.missionStart(t.key, v, autonomy, budget, queue); message.success(queue ? 'Mission queued: it starts when the one working ends' : 'Mission started'); onStarted(m.id); }
        catch (e) { message.error(errText(e)); } finally { setBusy(false); startingNow.current = false; }
    };
    return (
        <Modal open title={t.title} onCancel={cancel} maskClosable={!typed} onOk={go} okText={queue ? 'Queue the mission' : 'Start the mission'} confirmLoading={busy} width={640} okButtonProps={{ icon: <RocketOutlined /> }}>
            <Typography.Paragraph type="secondary" ellipsis={{ rows: 2, expandable: true, symbol: 'more' }} style={{ fontSize: 13 }}>{t.about}</Typography.Paragraph>
            <Form layout="vertical" size="small">
                <Row gutter={12}>{t.inputs.map((i) => (
                    <Col key={i.key} span={i.kind === 'project' || i.kind === 'env' || i.kind === 'number' ? 12 : 24}><Form.Item label={i.label} required={i.required}>
                        {i.kind === 'project' ? <Select value={v.project} onChange={(x) => setV({ ...v, project: x, env: '' })} options={projects.map((p) => ({ value: p }))} />
                            : i.kind === 'env' ? <Select value={v.env || undefined} onChange={(x) => setV({ ...v, env: x })} options={envs.map((p) => ({ value: p }))} disabled={!v.project} />
                            : i.kind === 'run' ? <Select value={v.run} onChange={(x) => setV({ ...v, run: x })} placeholder={runs.length ? 'A run with failures' : 'No failed run on this computer yet'} options={runs.map((r) => ({ value: r.id, label: `${new Date(r.startedAt).toLocaleString()} · ${r.request.project}/${r.request.env} · ${r.summary?.failed} failed${r.request.tags ? ` · ${r.request.tags}` : ''}` }))} />
                            : i.kind === 'number' ? <WholeNumber min={1} max={i.key === 'explorers' ? 3 : i.key === 'repeat' ? 20 : 999999999} fallback={1} label={i.label} onValidity={numbers.ok(i.label)} value={v[i.key] ? Number(v[i.key]) : undefined} onChange={(x) => setV({ ...v, [i.key]: String(x) })} />
                            : i.multiline ? <Input.TextArea rows={4} placeholder={i.placeholder} value={v[i.key]} onChange={(e) => setV({ ...v, [i.key]: e.target.value })} />
                            : <Input placeholder={i.placeholder} value={v[i.key]} onChange={(e) => setV({ ...v, [i.key]: e.target.value })} />}
                    </Form.Item></Col>
                ))}</Row>
                {t.writes && (
                    <Form.Item label="Autonomy">
                        <Radio.Group value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
                            <Tooltip title="File changes in its own copy need no approval; anything outside it asks you"><Radio value="autonomous">Work alone in its own copy</Radio></Tooltip>
                            <Tooltip title="Approval cards in the agent conversation"><Radio value="supervised">Ask me for every change</Radio></Tooltip>
                        </Radio.Group>
                    </Form.Item>
                )}
                <Form.Item label="Budget" tooltip="The mission stops when it uses more. Time waiting for you does not count." style={{ marginBottom: 0 }}>
                    <Row gutter={8}>
                        <Col span={8}><WholeNumber min={5} max={480} fallback={t.budget.minutes} value={budget.minutes} onChange={(x) => setBudget((b) => ({ ...b, minutes: x }))} suffix="min" label="Minutes" onValidity={numbers.ok('Minutes')} /></Col>
                        <Col span={8}><WholeNumber min={10} max={2000} fallback={t.budget.modelCalls} value={budget.modelCalls} onChange={(x) => setBudget((b) => ({ ...b, modelCalls: x }))} suffix="calls" label="Model calls" onValidity={numbers.ok('Model calls')} /></Col>
                        {t.writes && <Col span={8}><WholeNumber min={1} max={10} fallback={t.budget.attempts} value={budget.attempts} onChange={(x) => setBudget((b) => ({ ...b, attempts: x }))} suffix="attempts" label="Verification attempts" onValidity={numbers.ok('Verification attempts')} /></Col>}
                    </Row>
                </Form.Item>
            </Form>
        </Modal>
    );
}

function MissionDrawer({ id, onClose, onChanged, openConversation, onDelete }: { id: string; onClose: () => void; onChanged: () => void; openConversation: (session: string) => void; onDelete: (id: string) => Promise<void> }) {
    const { message, modal } = App.useApp();
    const [m, setM] = React.useState<MissionDef | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [diff, setDiff] = React.useState<string | null>(null);
    const [answer, setAnswer] = React.useState('');
    const [prOpen, setPrOpen] = React.useState(false);
    const [replay, setReplay] = React.useState<{ session: string; title: string } | null>(null);
    const [missing, setMissing] = React.useState(false);
    const load = React.useCallback(() => { api.mission(id).then((x) => { setM(x); setMissing(false); }).catch((e) => { if (e instanceof ApiError && e.status === 404) setMissing(true); else setErr(errText(e)); }); }, [id]);
    React.useEffect(load, [load]);
    React.useEffect(() => {
        if (!m || !LIVE.includes(m.state)) return;
        const t = setInterval(load, 2500);
        return () => clearInterval(t);
    }, [m, load]);
    const acting = React.useRef(false);
    const act = async (f: () => Promise<unknown>, ok: string) => { if (acting.current) return; acting.current = true; try { await f(); message.success(ok); load(); onChanged(); } catch (e) { message.error(errText(e)); } finally { acting.current = false; } };
    const cp = m?.checkpoints.find((c) => c.answer === undefined);
    const v = m?.verifications.at(-1);
    const finished = m && !LIVE.includes(m.state);
    // An address naming no mission (deleted, mistyped): said in place of the drawer.
    if (missing) return (
        <Card size="small"><Result status="404" title="Mission not found" subTitle={`There is no mission "${id}": it may have been deleted, or the address is mistyped.`}
            extra={<Button type="primary" onClick={onClose}>Back to the missions</Button>} /></Card>
    );
    return (
        <Drawer open width="min(980px, calc(100vw - 32px))" onClose={onClose} title={m ? <Space wrap><span>{m.title}</span><Tag color={STATE[m.state].color}>{STATE[m.state].label}</Tag>{v?.passed && <Tag icon={<SafetyCertificateOutlined />} color="green">verified by the Studio</Tag>}</Space> : 'Mission'}
            extra={m && <Space>
                {!finished && <Button danger icon={<StopOutlined />} onClick={() => modal.confirm({ title: 'Stop the mission?', content: 'What it changed so far is kept on its branch.', okText: 'Stop', okButtonProps: { danger: true }, onOk: () => act(() => api.missionStop(m.id), 'Stopped') })}>Stop</Button>}
                {m.session && <Button onClick={() => openConversation(m.session!)}>Conversation</Button>}
                {m.session && <Button icon={<HistoryOutlined />} onClick={() => setReplay({ session: m.session!, title: m.title })}>Replay</Button>}
                {finished && <Button danger icon={<DeleteOutlined />} onClick={() => modal.confirm({ title: 'Delete this mission?', content: deleteText(m), okText: 'Delete', okButtonProps: { danger: true }, onOk: () => onDelete(m.id) })}>Delete</Button>}
            </Space>}>
            {err && <Alert type="error" showIcon message={err} />}
            {m && (
                <Space direction="vertical" size={14} style={{ width: '100%' }}>
                    {m.reason && <Alert type={m.state === 'succeeded' ? 'success' : m.state === 'partial' || m.state === 'waiting' ? 'warning' : finished ? 'error' : 'info'} showIcon message={m.state === 'over-budget' && /model calls/.test(m.reason) ? `Over budget: ${m.used.modelCalls} model calls used (the budget is ${m.budget.modelCalls}).` : m.reason} />}
                    {m.approvals?.map((ap) => (
                        <Card key={ap.id} size="small" style={{ borderColor: '#d48806' }} title={<Space><PauseCircleOutlined />The agent waits for your approval</Space>}>
                            <Typography.Paragraph strong>{ap.title}</Typography.Paragraph>
                            {ap.detail && <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 12, background: 'rgba(127,127,127,.08)', padding: 10, borderRadius: 6 }}>{ap.detail}</pre>}
                            <Space>
                                <Button type="primary" onClick={() => act(() => api.missionApprove(m.id, ap.id, 'once'), 'Approved')}>Approve</Button>
                                <Tooltip title={`Every ${ap.kind} request of this mission`}><Button onClick={() => act(() => api.missionApprove(m.id, ap.id, 'session'), 'Approved for the mission')}>Approve for this mission</Button></Tooltip>
                                <Button danger onClick={() => act(() => api.missionApprove(m.id, ap.id, 'reject'), 'Rejected')}>Reject</Button>
                            </Space>
                        </Card>
                    ))}
                    {cp && (
                        <Card size="small" title={<Space><PauseCircleOutlined />{cp.kind === 'plan' ? 'The agent asks you to approve its plan' : 'The agent asks you'}</Space>} style={{ borderColor: '#d48806' }}>
                            <Typography.Paragraph>{cp.question}</Typography.Paragraph>
                            {cp.content && <pre style={{ maxHeight: 320, overflow: 'auto', fontSize: 12, background: 'rgba(127,127,127,.08)', padding: 10, borderRadius: 6 }}>{cp.content}</pre>}
                            <Space direction="vertical" style={{ width: '100%' }}>
                                {cp.options?.length ? <Space wrap>{cp.options.map((o) => <Button key={o} onClick={() => act(() => api.missionAnswer(m.id, cp.id, o), 'Answered')}>{o}</Button>)}</Space> : null}
                                <Input.TextArea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={cp.kind === 'plan' ? 'What to change in the plan (or approve it as it is)' : 'Your answer'} />
                                <Space>
                                    {cp.kind === 'plan' && <Button type="primary" onClick={() => act(() => api.missionAnswer(m.id, cp.id, 'Approved'), 'Plan approved')}>Approve the plan</Button>}
                                    <Button type={cp.kind === 'plan' ? 'default' : 'primary'} disabled={!answer.trim()} onClick={() => act(async () => { await api.missionAnswer(m.id, cp.id, answer); setAnswer(''); }, 'Answered')}>{cp.kind === 'plan' ? 'Ask for changes' : 'Answer'}</Button>
                                </Space>
                            </Space>
                        </Card>
                    )}
                    <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} layout="vertical" bordered items={[
                        { key: 't', label: 'Started', children: `${new Date(m.createdAt).toLocaleString()} (${m.trigger.kind === 'manual' ? m.trigger.by : m.trigger.kind})` },
                        { key: 'a', label: 'Autonomy', children: !m.copy ? 'reads only' : m.autonomy === 'autonomous' ? 'alone in its own copy' : 'asks for every change' },
                        { key: 'b', label: 'Branch', children: m.copy ? <Typography.Text code>{m.copy.branch}</Typography.Text> : 'reads only' },
                        { key: 'w', label: 'Work time', children: budgetBar(m.used.activeMs, m.budget.minutes * 60000, `${mins(m.used.activeMs)} / ${m.budget.minutes} min`) },
                        { key: 'c', label: 'Model calls', children: budgetBar(m.used.modelCalls, m.budget.modelCalls, `${m.used.modelCalls} / ${m.budget.modelCalls}`) },
                        { key: 'v', label: 'Verification', children: `${m.used.attempts} / ${m.budget.attempts} attempt(s)` },
                    ]} />
                    <Tabs items={[
                        ...(m.exploration?.notes.length ? [{ key: 'explore', label: `Exploration (${m.exploration.notes.length})`, children: <Exploration id={m.id} notes={m.exploration.notes} /> }] : []),
                        ...(m.team?.length ? [{ key: 'team', label: `Team (${m.team.length})`, children: (
                            <List size="small" dataSource={m.team} renderItem={(x) => (
                                <List.Item><Space direction="vertical" size={2} style={{ width: '100%' }}>
                                    <Space wrap><TeamOutlined /><Typography.Text strong>{x.name}</Typography.Text>
                                        <Tag color={x.state === 'done' ? 'green' : x.state === 'working' ? 'processing' : x.state === 'failed' ? 'red' : 'default'}>{x.state}</Tag>
                                        {x.used && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{x.used.modelCalls} model calls</Typography.Text>}
                                        {x.endedAt && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{mins(new Date(x.endedAt).getTime() - new Date(x.startedAt).getTime())}</Typography.Text>}
                                        {x.session && <Button size="small" type="link" icon={<HistoryOutlined />} onClick={() => setReplay({ session: x.session!, title: `${m.title}: ${x.name}` })}>Replay</Button>}</Space>
                                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>Task: {x.task}</Typography.Text>
                                    {x.answer && <Card size="small" styles={{ body: { padding: '6px 10px' } }}><Markdown text={x.answer} /></Card>}
                                </Space></List.Item>
                            )} />
                        ) }] : []),
                        { key: 'report', label: 'Result', children: (
                            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                                {!m.report && !m.verifications.length ? <Empty description={finished ? 'No report.' : 'The agent is working on it.'} /> : null}
                                {m.report && <Card size="small" title={`Report (${m.report.outcome})`}><Markdown text={m.report.summary} /></Card>}
                                {m.report?.findings?.length ? <Table size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={m.report.findings} columns={[
                                    { title: 'Scenario', dataIndex: 'scenario', width: 220, render: (x?: string) => x ?? '—' },
                                    { title: 'Cause', dataIndex: 'cause', width: 110, render: (x?: string) => (x ? <Tag color={x === 'product' ? 'red' : x === 'test' ? 'blue' : 'default'}>{x}</Tag> : null) },
                                    { title: 'Finding', dataIndex: 'detail' },
                                    { title: 'Fixed', dataIndex: 'fixed', width: 70, render: (x?: boolean) => (x ? <CheckCircleFilled style={{ color: '#2e7d32' }} /> : null) },
                                ]} /> : null}
                                {m.report?.bugs?.length ? <Card size="small" title="Application bugs found"><List size="small" dataSource={m.report.bugs} renderItem={(b, i) => (
                                    <List.Item actions={[b.filed ? <a key="f" href={b.filed.url} target="_blank" rel="noreferrer">Bug {b.filed.id}</a> : <Button key="f" size="small" disabled={!finished} onClick={() => modal.confirm({ title: 'File this bug in Azure DevOps?', content: <><b>{b.title}</b><br />{b.detail}<br /><br />Tagged cs-mission, with the mission's findings and verification.</>, okText: 'File the bug', onOk: () => act(() => api.missionBug(m.id, i), 'Bug filed') })}>File in Azure DevOps…</Button>]}>
                                        <Space direction="vertical" size={0}><Typography.Text strong>{b.title}</Typography.Text><Typography.Text type="secondary">{b.detail}</Typography.Text></Space></List.Item>)} /></Card> : null}
                                {m.verifications.length > 0 && <Card size="small" title="Verification by the Studio">
                                    <List size="small" dataSource={m.verifications} renderItem={(x) => (
                                        <List.Item><Space direction="vertical" size={2} style={{ width: '100%' }}>
                                            <Space>{x.passed ? <CheckCircleFilled style={{ color: '#2e7d32' }} /> : <CloseCircleFilled style={{ color: '#c62828' }} />}<Typography.Text>Attempt {x.attempt}: {x.why}</Typography.Text></Space>
                                            {x.runs.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{x.runs.map((r) => `run ${r.id}: ${r.passed ?? 0} passed, ${r.failed ?? 0} failed`).join(' · ')}</Typography.Text>}
                                            {x.failures.map((f, i) => <Typography.Text key={i} type="danger" style={{ fontSize: 12 }}>{f.name}{f.error ? `: ${f.error.split('\n')[0].slice(0, 300)}` : ''}</Typography.Text>)}
                                        </Space></List.Item>
                                    )} />
                                </Card>}
                                {m.memory.some((n) => n.state === 'proposed') && <Card size="small" title="Proposed notes for the team">
                                    <List size="small" dataSource={m.memory.filter((n) => n.state === 'proposed')} renderItem={(n) => (
                                        <List.Item actions={[<Button key="a" size="small" type="link" onClick={() => act(() => api.missionMemory(m.id, n.id, true), 'Added to the team notes')}>Add to team notes</Button>, <Button key="d" size="small" type="link" onClick={() => act(() => api.missionMemory(m.id, n.id, false), 'Dismissed')}>Dismiss</Button>]}>{n.note}</List.Item>
                                    )} />
                                </Card>}
                            </Space>
                        ) },
                        { key: 'changes', label: `Changes (${m.changes.length})`, children: (
                            <Space direction="vertical" size={10} style={{ width: '100%' }}>
                                {m.copy?.dirtyAtStart && <Alert type="info" showIcon message="Your working copy had changes not committed when the mission started: it did not see them." />}
                                {m.changes.length === 0 ? <Empty description="No files changed." /> : <>
                                    <List size="small" dataSource={m.changes} renderItem={(c) => <List.Item><Space><Tag>{c.status === 'A' ? 'new' : c.status === 'D' ? 'deleted' : 'changed'}</Tag><Typography.Text code>{c.path}</Typography.Text></Space></List.Item>} />
                                    {diff === null ? <Button onClick={() => api.missionDiff(m.id).then((t) => setDiff(t ?? '')).catch((e) => message.error(errText(e)))}>Show the changes</Button> : <DiffView diff={diff} />}
                                </>}
                                {finished && m.commit && !m.result && (
                                    <Space wrap>
                                        <Button type="primary" icon={<ExperimentOutlined />} onClick={() => modal.confirm({ title: 'Bring the changes into your working copy?', content: 'They are added as changes not committed, on your current branch. Review and commit them yourself.', okText: 'Bring them in', onOk: () => act(() => api.missionApply(m.id), 'The changes are in your working copy') })}>Bring into my working copy</Button>
                                        <Button icon={<PullRequestOutlined />} onClick={() => setPrOpen(true)}>Open a pull request…</Button>
                                        <Button danger onClick={() => modal.confirm({ title: 'Discard the mission\'s work?', content: `The copy and the branch ${m.copy?.branch} are deleted.`, okText: 'Discard', okButtonProps: { danger: true }, onOk: () => act(() => api.missionDiscard(m.id), 'Discarded') })}>Discard</Button>
                                    </Space>
                                )}
                                {m.result && <Alert type="info" showIcon message={m.result.kind === 'applied' ? 'Brought into the working copy.' : m.result.kind === 'pr' ? `Pull request ${m.result.detail ?? ''}` : 'Discarded.'} />}
                            </Space>
                        ) },
                        { key: 'timeline', label: 'Timeline', children: (
                            <Timeline items={m.timeline.map((x) => ({ color: x.kind === 'error' ? 'red' : x.kind === 'verify' ? 'green' : x.kind === 'ask' ? 'orange' : x.kind === 'tool' ? 'gray' : 'blue', children: <Space direction="vertical" size={0}><Typography.Text style={{ fontSize: x.kind === 'tool' ? 12 : 13 }} type={x.kind === 'tool' ? 'secondary' : undefined}>{x.text}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 11 }}>{new Date(x.at).toLocaleTimeString()}</Typography.Text></Space> }))} />
                        ) },
                    ]} />
                </Space>
            )}
            {replay && <Replay session={replay.session} title={replay.title} onClose={() => setReplay(null)} />}
            {m && prOpen && <PublishMission m={m} onClose={() => setPrOpen(false)} onDone={() => { setPrOpen(false); load(); onChanged(); }} />}
        </Drawer>
    );
}

function PublishMission({ m, onClose, onDone }: { m: MissionDef; onClose: () => void; onDone: () => void }) {
    const { message } = App.useApp();
    const [repos, setRepos] = React.useState<Array<{ name: string; defaultBranch?: string; here: boolean }>>([]);
    const [o, setO] = React.useState({ repository: '', target: 'main', title: m.title, draft: true });
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => { api.prRepos().then((r) => { setRepos(r.repos); const here = r.repos.find((x) => x.here); if (here) setO((x) => ({ ...x, repository: here.name, target: (here.defaultBranch ?? 'refs/heads/main').replace(/^refs\/heads\//, '') })); }).catch(() => undefined); }, []);
    const go = async () => {
        setBusy(true);
        try { const r = await api.missionPublish(m.id, o); message.success(<>Pull request {r.id} opened. <a href={r.url} target="_blank" rel="noreferrer">Open it</a></>, 8); onDone(); }
        catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    return (
        <Modal open title="Publish the mission as a pull request" onCancel={onClose} onOk={go} okText="Push and open" confirmLoading={busy} okButtonProps={{ disabled: !o.repository || !o.target }}>
            <Typography.Paragraph type="secondary">Pushes <Typography.Text code>{m.copy?.branch}</Typography.Text> and opens a pull request with the mission's report and verification as its description.</Typography.Paragraph>
            <Form layout="vertical" size="small">
                <Form.Item label="Repository"><Select value={o.repository || undefined} onChange={(v) => setO({ ...o, repository: v })} options={repos.map((r) => ({ value: r.name, label: r.name + (r.here ? ' (this one)' : '') }))} /></Form.Item>
                <Form.Item label="Into branch"><Input value={o.target} onChange={(e) => setO({ ...o, target: e.target.value })} /></Form.Item>
                <Form.Item label="Title"><Input value={o.title} onChange={(e) => setO({ ...o, title: e.target.value })} /></Form.Item>
                <Radio.Group value={o.draft} onChange={(e) => setO({ ...o, draft: e.target.value })}><Radio value>Draft</Radio><Radio value={false}>Ready for review</Radio></Radio.Group>
            </Form>
        </Modal>
    );
}

function TeamNotes({ onClose }: { onClose: () => void }) {
    const { message, modal } = App.useApp();
    const [t, setT] = React.useState<{ file: string; text: string; version?: string } | null>(null);
    const [saved, setSaved] = React.useState<string | null>(null);
    const read = React.useCallback(() => { agentsApi.teamNotes().then((x) => { setT(x); setSaved(x.text); }).catch((e) => message.error(errText(e))); }, [message]);
    React.useEffect(read, [read]);
    // Saved with the version read: changed meanwhile (another tab, a pull) → reload or overwrite.
    const save = async (force = false) => {
        if (!t) return;
        try { await agentsApi.saveTeamNotes(t.text, t.version, force); message.success(`Saved ${t.file}: commit it to share it`); onClose(); }
        catch (e) { if (isChangedElsewhere(e)) askChangedElsewhere(modal, e, 'The team notes', { reload: read, overwrite: () => save(true) }); else message.error(errText(e)); }
    };
    const dirty = !!t && saved !== null && t.text !== saved;
    useUnsaved('team-notes', dirty, 'team notes for agents', { lostOnLeave: true });
    // Esc, the close button and Cancel ask first when the notes were changed.
    const cancel = () => { if (!dirty) { onClose(); return; } modal.confirm({ title: 'Leave without saving?', content: 'Your changes to the team notes are lost.', okText: 'Leave', okButtonProps: { danger: true }, cancelText: 'Stay', onOk: onClose }); };
    return (
        <Modal open width={760} title="Team notes for agents" onCancel={cancel} maskClosable={!dirty} okText="Save" onOk={() => save()}>
            <Typography.Paragraph type="secondary">Every agent and mission reads these notes first: how to sign in, the application's quirks, the team's conventions. Missions propose notes; you accept them. Kept in {t?.file ?? '.cs-studio/agent-memory.md'} (commit it so the team shares it).</Typography.Paragraph>
            <Input.TextArea rows={16} value={t?.text ?? ''} onChange={(e) => t && setT({ ...t, text: e.target.value })} placeholder={'# Notes for agents\n- Sign in as the "qa-buyer" account; it has orders.\n- Close the cookie banner before anything else.'} style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }} />
        </Modal>
    );
}

const KIND: Record<ExploreNoteDef['kind'], { label: string; color: string }> = {
    bug: { label: 'Bugs', color: 'red' }, risk: { label: 'Risks', color: 'orange' }, question: { label: 'Questions', color: 'blue' }, idea: { label: 'Test ideas', color: 'purple' }, covered: { label: 'Covered', color: 'green' },
};
/** An exploration's log: findings first (bugs, risks, questions, ideas), then what was covered; screenshots on demand. */
function Exploration({ id, notes }: { id: string; notes: ExploreNoteDef[] }) {
    const [shot, setShot] = React.useState<{ title: string; url: string } | null>(null);
    const { message } = App.useApp();
    const open = async (n: ExploreNoteDef) => { try { setShot({ title: n.title, url: await api.missionShot(id, n.shot!) }); } catch (e) { message.error(errText(e)); } };
    React.useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);
    const order: Array<ExploreNoteDef['kind']> = ['bug', 'risk', 'question', 'idea', 'covered'];
    return (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>{order.map((k) => <Tag key={k} color={KIND[k].color}>{KIND[k].label}: {notes.filter((n) => n.kind === k).length}</Tag>)}</Space>
            {order.filter((k) => notes.some((n) => n.kind === k)).map((k) => (
                <Card key={k} size="small" title={KIND[k].label}>
                    <List size="small" dataSource={notes.filter((n) => n.kind === k)} renderItem={(n) => (
                        <List.Item actions={n.shot ? [<Button key="s" size="small" type="link" onClick={() => void open(n)}>Screenshot</Button>] : []}>
                            <Space direction="vertical" size={2} style={{ width: '100%' }}>
                                <Space wrap>{n.severity && <Tag color={n.severity === 'high' ? 'red' : n.severity === 'medium' ? 'orange' : 'default'}>{n.severity}</Tag>}<Typography.Text strong>{n.title}</Typography.Text>
                                    {n.by && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{n.by}</Typography.Text>}</Space>
                                {n.screen && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{n.screen}</Typography.Text>}
                                {n.detail && <Typography.Text style={{ fontSize: 13 }}>{n.detail}</Typography.Text>}
                                {n.steps?.length ? <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>{n.steps.map((x, i) => <li key={i}>{x}</li>)}</ol> : null}
                            </Space>
                        </List.Item>
                    )} />
                </Card>
            ))}
            <Modal open={!!shot} width={1000} title={shot?.title} footer={null} onCancel={() => setShot(null)}>{shot && <img src={shot.url} alt={shot.title} style={{ width: '100%' }} />}</Modal>
        </Space>
    );
}

/** What deleting a finished mission removes (asked first). */
function deleteText(m: { changes: number | unknown[]; result?: unknown }): string {
    const n = Array.isArray(m.changes) ? m.changes.length : m.changes;
    const kind = typeof m.result === 'string' ? m.result : (m.result as { kind?: string } | undefined)?.kind;
    return `It is removed from the list with its screenshots${n ? kind === 'pr' ? '; its branch stays (a pull request uses it)' : kind ? ', its copy and its branch' : ', its copy and its branch: its changes were not brought in or published and are lost' : ''}.`;
}
