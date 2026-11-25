/**
 * Replay an agent conversation or mission session step by step: what it was asked, each tool it called (arguments,
 * result, time), approvals and how they were answered, warnings (possible prompt injection, refusals), its answers.
 * A session can become an evaluation case (its first request, checks suggested from what it did).
 */
import React from 'react';
import { Alert, App, Button, Card, Checkbox, Drawer, Empty, Input, List, Modal, Radio, Select, Slider, Space, Tag, Tooltip, Typography } from 'antd';
import { CaretRightOutlined, ExperimentOutlined, PauseOutlined, StepBackwardOutlined, StepForwardOutlined, WarningFilled } from '@ant-design/icons';
import { api, EvalCheckDef } from '../api';
import { errText } from '../state';
import { Markdown } from './Markdown';
import { toSteps, type ReplayStep } from './replaySteps';

const COLOR: Record<ReplayStep['kind'], string> = { user: 'blue', assistant: 'green', tool: 'geekblue', approval: 'orange', info: 'default', error: 'red', reasoning: 'default' };
const pretty = (s?: string) => { if (!s) return ''; try { return JSON.stringify(JSON.parse(s), null, 1); } catch { return s; } };

export function Replay({ session, title, onClose }: { session: string; title: string; onClose: () => void }) {
    const { message } = App.useApp();
    const [steps, setSteps] = React.useState<ReplayStep[] | null>(null);
    const [at, setAt] = React.useState(0);
    const [playing, setPlaying] = React.useState(false);
    const [speed, setSpeed] = React.useState(1);
    const [filter, setFilter] = React.useState<'all' | 'tools' | 'flagged'>('all');
    const [saving, setSaving] = React.useState(false);
    React.useEffect(() => {
        api.agentEvents(session, 0).then((r) => setSteps(toSteps(r.events))).catch((e) => { message.error(errText(e)); setSteps([]); });
    }, [session, message]);
    const shown = React.useMemo(() => (steps ?? []).filter((s) => filter === 'all' ? s.kind !== 'reasoning' : filter === 'tools' ? s.kind === 'tool' : s.flagged), [steps, filter]);
    React.useEffect(() => { setAt(0); }, [filter]);
    React.useEffect(() => {
        if (!playing) return;
        if (at >= shown.length - 1) { setPlaying(false); return; }
        const t = setTimeout(() => setAt((x) => x + 1), 1500 / speed);
        return () => clearTimeout(t);
    }, [playing, at, shown.length, speed]);
    const cur = shown[at];
    const flagged = (steps ?? []).filter((s) => s.flagged).length;
    const toolsUsed = [...new Set((steps ?? []).filter((s) => s.kind === 'tool').map((s) => s.title.split(' · ').pop()!))];
    return (
        <Drawer open width={1100} title={`Replay: ${title}`} onClose={onClose}
            extra={<Button icon={<ExperimentOutlined />} disabled={!steps?.some((s) => s.kind === 'user')} onClick={() => setSaving(true)}>Save as an evaluation case</Button>}>
            {!steps ? null : steps.length === 0 ? <Empty description="Nothing recorded for this session." /> : (
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    {flagged > 0 && <Alert type="warning" showIcon message={`${flagged} step(s) flagged: possible prompt injection, refusals or errors.`} action={<Button size="small" onClick={() => setFilter('flagged')}>Show them</Button>} />}
                    <Space wrap>
                        <Button icon={<StepBackwardOutlined />} disabled={at === 0} onClick={() => { setPlaying(false); setAt((x) => Math.max(0, x - 1)); }} aria-label="Previous step" />
                        <Button type="primary" icon={playing ? <PauseOutlined /> : <CaretRightOutlined />} onClick={() => { if (at >= shown.length - 1) setAt(0); setPlaying((p) => !p); }}>{playing ? 'Pause' : 'Play'}</Button>
                        <Button icon={<StepForwardOutlined />} disabled={at >= shown.length - 1} onClick={() => { setPlaying(false); setAt((x) => Math.min(shown.length - 1, x + 1)); }} aria-label="Next step" />
                        <Select size="small" value={speed} style={{ width: 80 }} onChange={setSpeed} options={[0.5, 1, 2, 4].map((v) => ({ value: v, label: `${v}×` }))} aria-label="Speed" />
                        <Radio.Group size="small" value={filter} onChange={(e) => setFilter(e.target.value)} optionType="button" options={[{ value: 'all', label: 'All' }, { value: 'tools', label: 'Tools' }, { value: 'flagged', label: `Flagged (${flagged})` }]} />
                        <Typography.Text type="secondary">Step {shown.length ? at + 1 : 0} of {shown.length}</Typography.Text>
                    </Space>
                    {shown.length > 1 && <Slider min={0} max={shown.length - 1} value={at} onChange={(v) => { setPlaying(false); setAt(v); }} tooltip={{ formatter: (v) => shown[v ?? 0]?.title }} />}
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <List size="small" bordered style={{ width: 340, maxHeight: '62vh', overflow: 'auto', flex: 'none' }} dataSource={shown} renderItem={(s, k) => (
                            <List.Item onClick={() => { setPlaying(false); setAt(k); }} style={{ cursor: 'pointer', background: k === at ? 'rgba(22,119,255,0.08)' : undefined }}>
                                <Space size={6} style={{ minWidth: 0 }}>
                                    {s.flagged ? <WarningFilled style={{ color: '#d46b08' }} /> : null}
                                    <Tag color={COLOR[s.kind]} style={{ marginInlineEnd: 0 }}>{s.kind}</Tag>
                                    <Typography.Text ellipsis style={{ maxWidth: 220 }} type={s.ok === false ? 'danger' : undefined}>{s.title}</Typography.Text>
                                </Space>
                            </List.Item>
                        )} />
                        {cur && (
                            <Card size="small" style={{ flex: 1, minWidth: 0 }} title={<Space wrap><Tag color={COLOR[cur.kind]}>{cur.kind}</Tag><span>{cur.title}</span>{cur.ms !== undefined && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{cur.ms < 1000 ? `${cur.ms} ms` : `${(cur.ms / 1000).toFixed(1)} s`}</Typography.Text>}
                                {cur.decision && <Tag color={cur.decision === 'reject' ? 'red' : 'green'}>{cur.decision === 'reject' ? 'rejected' : cur.decision === 'auto' ? 'allowed by the settings' : 'approved'}</Tag>}{cur.flagged && <Tag color="orange">flagged</Tag>}</Space>}
                                extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(cur.at).toLocaleTimeString()}</Typography.Text>}>
                                {cur.kind === 'tool' ? (
                                    <Space direction="vertical" style={{ width: '100%' }}>
                                        <Typography.Text strong>Arguments</Typography.Text>
                                        <pre style={{ margin: 0, maxHeight: 180, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>{pretty(cur.detail)}</pre>
                                        <Typography.Text strong>Result{cur.ok === false ? ' (failed)' : ''}</Typography.Text>
                                        <pre style={{ margin: 0, maxHeight: '38vh', overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>{cur.result === undefined ? '(no result: still running or stopped)' : pretty(cur.result)}</pre>
                                    </Space>
                                ) : cur.kind === 'approval' ? <pre style={{ margin: 0, maxHeight: '50vh', overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>{cur.detail}</pre>
                                    : <div style={{ maxHeight: '56vh', overflow: 'auto' }}><Markdown text={cur.detail ?? ''} /></div>}
                            </Card>
                        )}
                    </div>
                </Space>
            )}
            {saving && steps && <SaveCase steps={steps} tools={toolsUsed} onClose={() => setSaving(false)} />}
        </Drawer>
    );
}

/** The session's first request as an evaluation case of an agent, with checks to keep. */
function SaveCase({ steps, tools, onClose }: { steps: ReplayStep[]; tools: string[]; onClose: () => void }) {
    const { message } = App.useApp();
    const [agents, setAgents] = React.useState<Array<{ value: string; label: string }>>([]);
    const [agent, setAgent] = React.useState<string>();
    const first = steps.find((s) => s.kind === 'user')?.detail ?? '';
    const [name, setName] = React.useState(first.split('\n')[0].slice(0, 80));
    const [prompt, setPrompt] = React.useState(first);
    const [keep, setKeep] = React.useState<string[]>(tools.filter((t) => !['studio_context', 'studio_catalog'].includes(t)));
    const [criteria, setCriteria] = React.useState('');
    React.useEffect(() => { api.agentBuilder().then((d) => setAgents([...d.agents, ...d.teamCandidates.filter((c) => c.builtIn)].map((a) => ({ value: a.id, label: a.name })))).catch(() => undefined); }, []);
    const save = async () => {
        if (!agent) return;
        const checks: EvalCheckDef[] = [...keep.map((t) => ({ kind: 'tool-called' as const, tool: t })), ...(criteria.trim().length >= 10 ? [{ kind: 'judge' as const, criteria: criteria.trim() }] : [])];
        if (!checks.length) { message.warning('Keep at least one check.'); return; }
        try {
            const cur = await api.evals(agent);
            const id = `case-${Date.now().toString(36)}`;
            await api.saveEvals(agent, { cases: [...cur.suite.cases, { id, name: name || id, prompt, checks }] });
            message.success('Added to the agent\'s evaluation cases');
            onClose();
        } catch (e) { message.error(errText(e)); }
    };
    return (
        <Modal open width={720} title="Save as an evaluation case" okText="Add the case" okButtonProps={{ disabled: !agent || !prompt.trim() }} onOk={() => void save()} onCancel={onClose}>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Select style={{ width: '100%' }} placeholder="The agent it tests" value={agent} onChange={setAgent} options={agents} showSearch optionFilterProp="label" />
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Case name" />
                <Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                <Typography.Text strong>Checks: it calls these tools again</Typography.Text>
                {tools.length ? <Checkbox.Group value={keep} onChange={(v) => setKeep(v as string[])} options={tools.map((t) => ({ value: t, label: t }))} /> : <Typography.Text type="secondary">It called no tools.</Typography.Text>}
                <Tooltip title="A grader agent judges the answer against this (optional)"><Input.TextArea autoSize={{ minRows: 2 }} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="What a good answer does (optional), e.g. It names the cause with evidence and changes nothing." /></Tooltip>
            </Space>
        </Modal>
    );
}
