/** An Azure DevOps pipeline (YAML) for the chosen tests: preview, then write it to pipelines/ in the repository. */
import React from 'react';
import { Alert, App, Checkbox, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Typography } from 'antd';
import { api, RunRequest } from '../api';
import { errText } from '../state';

export function MakePipeline({ open, onClose, request, envs }: { open: boolean; onClose: () => void; request: RunRequest; envs: string[] }) {
    const { message } = App.useApp();
    const [o, setO] = React.useState({ name: '', envs: [] as string[], agents: 1, schedule: '', prValidation: false, branch: 'main', variableGroup: '', pool: '', fix: false, pushBranch: true, agentOs: 'linux' as 'linux' | 'windows', evalAgents: [] as string[], evalRegressionsOnly: false });
    const [agentIds, setAgentIds] = React.useState<Array<{ value: string; label: string }>>([]);
    React.useEffect(() => { if (open) api.agentBuilder().then((d) => setAgentIds(d.agents.map((a) => ({ value: a.id, label: a.name })))).catch(() => undefined); }, [open]);
    const [preview, setPreview] = React.useState<{ yaml: string; file: string; exists: boolean; secretNames: string[]; variableGroup: string } | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => { if (open) { setO((x) => ({ ...x, name: x.name || `${request.project} ${request.tags ? request.tags.replace(/[@()]/g, '').split(/\s+/)[0] : 'tests'}`, envs: [request.env] })); setPreview(null); } }, [open, request.project, request.env, request.tags]);
    const payload = () => ({ ...o, project: request.project, tags: request.tags, features: request.features, browser: request.browser, workers: request.workers, retries: request.retries,
        schedule: o.schedule.trim() || undefined, variableGroup: o.variableGroup.trim() || undefined, pool: o.pool.trim() || undefined, fixMission: o.fix ? { pushBranch: o.pushBranch } : undefined,
        evalAgents: o.evalAgents.length ? { agents: o.evalAgents, allowFailures: o.evalRegressionsOnly } : undefined });
    // Preview whenever the options change (debounced).
    React.useEffect(() => {
        if (!open || !o.name.trim() || !o.envs.length) return;
        const t = setTimeout(() => { api.testPipeline(payload()).then((r) => { setPreview(r); setErr(null); }).catch((e) => setErr(errText(e))); }, 300);
        return () => clearTimeout(t);
    }, [open, o, JSON.stringify(request)]); // eslint-disable-line react-hooks/exhaustive-deps
    const save = async () => {
        const go = async (overwrite: boolean) => {
            setBusy(true);
            try { const r = await api.testPipeline({ ...payload(), save: true, overwrite }); message.success(`Wrote ${r.file}. Commit it, then create the pipeline from it in Azure DevOps (Pipelines → New → Existing YAML file).`, 8); onClose(); } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
        };
        if (preview?.exists) Modal.confirm({ title: `Replace ${preview.file}?`, okText: 'Replace', okButtonProps: { danger: true }, onOk: () => go(true) }); else await go(false);
    };
    return (
        <Modal open={open} width={980} title="Run these tests in an Azure DevOps pipeline" onCancel={onClose} okText={preview ? `Write ${preview.file}` : 'Write'} onOk={save} confirmLoading={busy} okButtonProps={{ disabled: !preview || !!err }}>
            <Row gutter={16}>
                <Col span={10}>
                    <Form layout="vertical" size="small">
                        <Form.Item label="Name"><Input value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} /></Form.Item>
                        <Form.Item label="Environments (the first is the default)"><Select mode="multiple" value={o.envs} onChange={(v) => setO({ ...o, envs: v })} options={envs.map((e) => ({ value: e }))} /></Form.Item>
                        <Row gutter={8}>
                            <Col span={12}><Form.Item label="Agents" tooltip="Agents that split the feature files between them"><InputNumber min={1} max={20} value={o.agents} onChange={(v) => setO({ ...o, agents: v ?? 1 })} style={{ width: '100%' }} /></Form.Item></Col>
                            <Col span={12}><Form.Item label="Branch"><Input value={o.branch} onChange={(e) => setO({ ...o, branch: e.target.value })} /></Form.Item></Col>
                        </Row>
                        <Form.Item label="Schedule (cron, UTC)" tooltip="e.g. 0 2 * * 1-5 — 02:00 UTC on weekdays. Empty: no schedule."><Input placeholder="0 2 * * 1-5" value={o.schedule} onChange={(e) => setO({ ...o, schedule: e.target.value })} /></Form.Item>
                        <Form.Item><Checkbox checked={o.prValidation} onChange={(e) => setO({ ...o, prValidation: e.target.checked })}>Run for pull requests into {o.branch || 'main'}</Checkbox></Form.Item>
                        <Form.Item tooltip="A second job, only when tests fail: a Studio mission finds the causes, fixes the tests where the test is wrong, proves it by running them, and reports. Needs AGENTS_PROVIDER_API_KEY or COPILOT_GITHUB_TOKEN in the variable group.">
                            <Checkbox checked={o.fix} onChange={(e) => setO({ ...o, fix: e.target.checked })}>When tests fail, run a fix mission</Checkbox>
                            {o.fix && <div style={{ marginLeft: 24 }}><Checkbox checked={o.pushBranch} onChange={(e) => setO({ ...o, pushBranch: e.target.checked })}>Push its branch for review</Checkbox></div>}
                        </Form.Item>
                        <Form.Item label="Evaluate the team's agents" tooltip="A job beside the tests runs these agents' evaluation cases (Agent builder → Evaluate) with the same model variables as the fix mission. It fails when a case fails.">
                            <Select mode="multiple" allowClear placeholder={agentIds.length ? 'No agents' : 'No team agents yet'} value={o.evalAgents} onChange={(v) => setO({ ...o, evalAgents: v })} options={agentIds} />
                            {o.evalAgents.length > 0 && <Checkbox style={{ marginTop: 4 }} checked={o.evalRegressionsOnly} onChange={(e) => setO({ ...o, evalRegressionsOnly: e.target.checked })}>Fail only when a case that passed before fails now</Checkbox>}
                        </Form.Item>
                        <Form.Item label="Variable group (secrets)"><Input placeholder={preview?.variableGroup} value={o.variableGroup} onChange={(e) => setO({ ...o, variableGroup: e.target.value })} /></Form.Item>
<Row gutter={8}>
                            <Col span={14}><Form.Item label="Agent pool" tooltip="Empty: Microsoft-hosted ubuntu-latest"><Input placeholder="ubuntu-latest" value={o.pool} onChange={(e) => setO({ ...o, pool: e.target.value })} /></Form.Item></Col>
                            <Col span={10}><Form.Item label="Agents run on" tooltip="Windows agents (e.g. a self-hosted Windows machine) get batch-file and PowerShell steps"><Select value={o.agentOs} onChange={(v) => setO({ ...o, agentOs: v })} options={[{ value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' }]} /></Form.Item></Col>
                        </Row>
                    </Form>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Tests: {request.features?.length ? `${request.features.length} feature file(s)` : 'all'}{request.tags ? ` · ${request.tags}` : ''}{request.workers && request.workers > 1 ? ` · ${request.workers} workers` : ''}{request.retries ? ` · ${request.retries} retries` : ''}</Typography.Text>
                    {preview && preview.secretNames.length > 0 && <Alert style={{ marginTop: 8 }} type="info" showIcon message={`Secrets read from the variable group: ${preview.secretNames.join(', ')}`} description="Check them under Setup → Pipeline secrets." />}
                </Col>
                <Col span={14}>
                    {err ? <Alert type="error" showIcon message={err} /> : (
                        <Space direction="vertical" style={{ width: '100%' }} size={4}>
                            {preview && <Typography.Text type="secondary">{preview.file}{preview.exists ? ' (exists: it will be replaced)' : ''}</Typography.Text>}
                            <pre style={{ maxHeight: 460, overflow: 'auto', fontSize: 11.5, margin: 0, padding: 10, background: 'var(--code-bg, rgba(127,127,127,.08))', borderRadius: 6 }}>{preview?.yaml ?? ''}</pre>
                        </Space>
                    )}
                </Col>
            </Row>
        </Modal>
    );
}
