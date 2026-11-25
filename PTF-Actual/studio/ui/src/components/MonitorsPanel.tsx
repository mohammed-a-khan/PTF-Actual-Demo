/**
 * Monitors: a collection run on a schedule while the Studio is open, an alert to Teams / Slack (an incoming webhook,
 * its address kept as a Studio secret) when it fails or when the result changes. For runs without the Studio, a
 * pipeline with a schedule (the collection's "Run it in a pipeline").
 */
import React from 'react';
import { App, Button, Col, Form, Input, Modal, Popconfirm, Radio, Row, Select, Switch, Tag, Tooltip, Typography } from 'antd';
import { CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { api, ApiCollectionInfo, ApiMonitorDef } from '../api';
import { errText } from '../state';
import { navigate, useRoute } from '../route';
import { ago } from '../format';
import { FieldProblems, NumField, useEscapeCloses, useFieldProblems } from '../apiperf-ui';

type Edit = Omit<ApiMonitorDef, 'id' | 'last'> & { id?: string };

export function MonitorsPanel({ collections, environments, file }: { collections: ApiCollectionInfo[]; environments: Record<string, string[]>; file: string | null }) {
    const { message } = App.useApp();
    const [list, setList] = React.useState<ApiMonitorDef[]>([]);
    const [edit, setEdit] = React.useState<Edit | null>(null);
    const load = React.useCallback(() => { void api.apiMonitors().then((r) => setList(r.monitors)).catch(() => undefined); }, []);
    // Kept fresh while the Runner screen is shown in a visible tab (not polled from other screens).
    const shown = useRoute()[0] === 'api-runner';
    React.useEffect(() => {
        if (!shown) return;
        load();
        const t = setInterval(() => { if (!document.hidden) load(); }, 15_000);
        return () => clearInterval(t);
    }, [load, shown]);
    const project = (f: string) => f.split('/')[1];
    const [saving, setSaving] = React.useState(false);
    const savingRef = React.useRef(false);
    // The name is the person's own (never filled in from the collection): an empty one is said under the field and Save stays off.
    const [nameTouched, setNameTouched] = React.useState(false);
    const fields = useFieldProblems();
    // "Run now" starts one run per click: a double click (or a click while it starts) does not start a second.
    const [starting, setStarting] = React.useState<Set<string>>(new Set());
    const startingRef = React.useRef(new Set<string>());
    const runNow = (m: ApiMonitorDef) => {
        if (startingRef.current.has(m.id)) return;
        startingRef.current.add(m.id); setStarting(new Set(startingRef.current));
        void api.apiRunMonitor(m.id).then((j) => { load(); navigate(['api-runner', 'run', j.id]); }).catch((e) => message.error(errText(e)))
            .finally(() => { startingRef.current.delete(m.id); setStarting(new Set(startingRef.current)); });
    };
    const save = async () => {
        if (edit && !edit.name.trim()) { setNameTouched(true); return; }
        if (fields.problem) return;
        if (!edit || savingRef.current) return;
        savingRef.current = true; setSaving(true);
        try { await api.apiSaveMonitor({ ...edit, name: edit.name.trim() }); setEdit(null); load(); message.success('Saved: it runs while the Studio is open.'); }
        catch (e) { message.error(errText(e)); }
        finally { savingRef.current = false; setSaving(false); }
    };
    useEscapeCloses(!!edit, () => setEdit(null));
    const every = (m: number) => (m % 1440 === 0 ? `every ${m / 1440 === 1 ? 'day' : `${m / 1440} days`}` : m % 60 === 0 ? `every ${m / 60 === 1 ? 'hour' : `${m / 60} hours`}` : `every ${m} min`);
    return (
        <>
            <div className="side-section" style={{ display: 'flex', alignItems: 'center' }}>
                <span style={{ flex: 1 }}>Monitors</span>
                <Tooltip title="Run a collection on a schedule while the Studio is open, with an alert"><Button size="small" type="text" icon={<PlusOutlined />} aria-label="New monitor"
                    onClick={() => { const f = file ?? collections[0]?.file; if (!f) { message.info('Choose a collection first.'); return; } setNameTouched(false); setEdit({ name: '', file: f, env: environments[project(f)]?.[0] ?? 'dev', everyMinutes: 60, enabled: true, alertOn: 'failure' }); }} /></Tooltip>
            </div>
            {!list.length ? <Typography.Text type="secondary" style={{ display: 'block', padding: '4px 14px', fontSize: 12 }}>None yet: + runs a collection on a schedule, with an alert.</Typography.Text> : list.map((m) => (
                <div key={m.id} className="item-row" onClick={() => m.last?.runId && navigate(['api-runner', 'run', m.last.runId])}>
                    <div className="item-title">
                        {!m.last ? <Tag bordered={false}>not run</Tag> : m.last.passed ? <CheckCircleFilled style={{ color: '#389e0d' }} /> : <CloseCircleFilled style={{ color: '#cf222e' }} />}
                        <span className="t">{m.name.trim() || <Typography.Text type="secondary" italic>(no name)</Typography.Text>}</span>
                        <Switch size="small" checked={m.enabled} onClick={(_c, e) => e.stopPropagation()} onChange={(on) => void api.apiSaveMonitor({ ...m, enabled: on }).then(load).catch((e) => message.error(errText(e)))} aria-label={`Monitor ${m.name.trim() || '(no name)'} on`} />
                    </div>
                    <div className="item-meta">{m.env} · {every(m.everyMinutes)}{m.last ? ` · ${ago(m.last.at)} ${m.last.passed ? 'passed' : `${m.last.failed} failed`}` : ''}{m.last?.alert ? ` · ${m.last.alert}` : ''}</div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 2 }} onClick={(e) => e.stopPropagation()}>
                        <Button size="small" icon={<CaretRightOutlined />} loading={starting.has(m.id)} onClick={() => runNow(m)}>Run now</Button>
                        <Button size="small" onClick={() => { setNameTouched(true); setEdit({ ...m }); }}>Edit</Button>
                        <Popconfirm title={`Delete the monitor "${m.name.trim() || '(no name)'}"?`} okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => void api.apiDeleteMonitor(m.id).then(load).catch((e) => message.error(errText(e)))}><Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Delete the monitor" /></Popconfirm>
                    </div>
                </div>))}
            <Modal open={!!edit} title={edit?.id ? 'Monitor' : 'New monitor'} okText="Save" okButtonProps={{ disabled: !edit?.name.trim() || !!fields.problem, loading: saving, title: edit && !edit.name.trim() ? 'Give the monitor a name first.' : fields.problem ?? undefined }} onOk={() => void save()} onCancel={() => setEdit(null)}>
                {edit && <FieldProblems value={fields.report}><Form layout="vertical" size="small">
                    <Form.Item label="Name" required validateStatus={nameTouched && !edit.name.trim() ? 'error' : undefined} help={!edit.name.trim() ? (nameTouched ? 'Give the monitor a name.' : 'Required: the monitor is saved (and starts) once it has a name.') : undefined}><Input value={edit.name} maxLength={120} autoFocus placeholder={`e.g. ${collections.find((c) => c.file === edit.file)?.name ?? 'Shop'} health`} onChange={(e) => { setNameTouched(true); setEdit({ ...edit, name: e.target.value }); }} onBlur={() => setNameTouched(true)} onPressEnter={() => void save()} aria-label="Monitor name" /></Form.Item>
                    <Form.Item label="Collection"><Select showSearch optionFilterProp="label" value={edit.file} onChange={(f) => setEdit({ ...edit, file: f, env: environments[project(f)]?.[0] ?? 'dev' })} options={collections.map((c) => ({ value: c.file, label: `${c.name} · ${c.project}` }))} aria-label="Collection" /></Form.Item>
                    <Row gutter={12}>
                        <Col span={12}><Form.Item label="Environment"><Select style={{ width: '100%' }} value={edit.env} onChange={(v) => setEdit({ ...edit, env: v })} options={(environments[project(edit.file)] ?? ['dev']).map((e) => ({ value: e, label: e }))} aria-label="Environment" /></Form.Item></Col>
                        <Col span={12}><Form.Item label="Every" tooltip="At least 5 minutes"><NumField min={5} max={10080} value={edit.everyMinutes} onChange={(v) => setEdit((x) => (x ? { ...x, everyMinutes: v ?? x.everyMinutes } : x))} addonAfter="min" width="100%" label="Every (minutes)" /></Form.Item></Col>
                    </Row>
                    <Form.Item label="Alert (optional)" tooltip="A Teams or Slack incoming webhook: save its address as a Studio secret (Secrets), then name the secret here">
                        <Input value={edit.webhookSecret ?? ''} placeholder="Studio secret with the webhook address, e.g. TEAMS_WEBHOOK" onChange={(e) => setEdit({ ...edit, webhookSecret: e.target.value.trim() || undefined })} aria-label="Webhook secret" />
                    </Form.Item>
                    <Radio.Group value={edit.alertOn} onChange={(e) => setEdit({ ...edit, alertOn: e.target.value })}>
                        <Radio value="failure">On every failed run</Radio><Radio value="change">When it starts failing or recovers</Radio>
                    </Radio.Group>
                    <Tooltip title={'For a schedule without the Studio, use the collection\'s "Run it in a pipeline".'}><Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>Runs while the Studio is open on this computer.</Typography.Text></Tooltip>
                </Form></FieldProblems>}
            </Modal>
        </>
    );
}
