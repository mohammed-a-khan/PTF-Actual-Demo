/**
 * ADO pipeline secrets: what the pipeline must provide for a project + environment, what you have
 * on this computer, what the environment's ADO variable group already has — and a one-click,
 * confirmed copy from your secret store into ADO.
 */
import React from 'react';
import { Alert, App, Button, Card, Empty, Form, Input, Modal, Select, Space, Table, Tabs, Tooltip, Typography } from 'antd';
import { CheckCircleTwoTone, CloseCircleTwoTone, CloudUploadOutlined, ExclamationCircleTwoTone, InfoCircleOutlined, LockOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, PipelineRow, PipelineSecrets as PS } from '../api';
import { errText, useStudio } from '../state';
import { navigate } from '../route';
import { isAdoNotSetUp, useStoredTab } from '../datagit-common';

const yes = <CheckCircleTwoTone twoToneColor="#52c41a" />;
const no = <CloseCircleTwoTone twoToneColor="#cf1322" />;

export function PipelineSecrets() {
    const { message, modal } = App.useApp();
    const { env: disc, refresh: refreshStudio } = useStudio();
    const projects = disc?.projects ?? [];
    const [project, setProject] = React.useState('');
    const [env, setEnv] = React.useState('');
    const [data, setData] = React.useState<PS | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [selected, setSelected] = React.useState<string[]>([]);
    const [pattern, setPattern] = React.useState('');
    const [adding, setAdding] = React.useState<{ name: string; value: string } | null>(null);
    const [savingValue, setSavingValue] = React.useState(false);
    const [savingPattern, setSavingPattern] = React.useState(false);
    const [tab, setTab] = useStoredTab<'secrets' | 'setup'>('pipeline-secrets', ['secrets', 'setup'], 'secrets');

    React.useEffect(() => { if (!project && projects.length) setProject(projects[0]); }, [projects, project]);
    const envs = project ? (disc?.environments[project] ?? []) : [];
    React.useEffect(() => { if (project && envs.length && !envs.includes(env)) setEnv(envs[0]); }, [project, envs.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { api.pipelineSettings().then((s) => setPattern(s.variableGroup)).catch(() => undefined); }, []);

    const load = React.useCallback(async (check: boolean) => {
        if (!project || !env) return;
        setLoading(true);
        try { const d = await api.pipelineSecrets(project, env, check); setData(d); setSelected(d.rows.filter((r) => r.local && r.inAdo === 'missing').map((r) => r.name)); }
        catch (e) { message.error(errText(e)); }
        finally { setLoading(false); }
    }, [project, env, message]);
    React.useEffect(() => { void load(false); }, [load]);
    const savePattern = async () => {
        if (!pattern.trim() || savingPattern) return;
        setSavingPattern(true);
        try { await api.setPipelineSettings(pattern.trim()); message.success('Saved in .cs-studio/pipeline.json — commit it so your team uses the same name'); await load(false); await refreshStudio(); }
        catch (e) { message.error(errText(e)); }
        finally { setSavingPattern(false); }
    };

    if (projects.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="No framework projects found under config/." />;
    if (project && envs.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description={`${project} has no environments yet. Create one in Environments.`} />;

    const send = () => modal.confirm({
        title: `Send ${selected.length} secret${selected.length === 1 ? '' : 's'} to Azure DevOps?`,
        content: <>They will be saved as <b>secret</b> variables in the variable group <Typography.Text code>{data?.variableGroup}</Typography.Text>{data?.groupExists === false ? ' (it will be created)' : ''} on <Typography.Text strong>{data?.adoHost}</Typography.Text>. Other variables in the group are kept. ADO never shows secret values again.
            <div style={{ marginTop: 8 }}><Typography.Text type="secondary">Check that this is your organization's Azure DevOps server: the values (and your access token) are sent there.</Typography.Text></div></>,
        okText: 'Send to ADO',
        onOk: async () => {
            try {
                const r = await api.syncPipelineSecrets(project, env, selected, data?.adoHost ?? '');
                message.success(`${r.created ? 'Created' : 'Updated'} ${r.variableGroup}: ${r.sent.join(', ')}`);
                await load(true);
            } catch (e) { message.error(errText(e)); }
        },
    });

    const adoCell = (r: PipelineRow) => {
        if (!data?.adoChecked) return <Typography.Text type="secondary">not checked</Typography.Text>;
        if (r.inAdo === 'secret') return <Space>{yes}Secret variable</Space>;
        if (r.inAdo === 'plain') return <Tooltip title="Stored as a normal (visible) variable. Make it secret in ADO, or send it again from here."><Space><ExclamationCircleTwoTone twoToneColor="#d48806" />Not marked secret</Space></Tooltip>;
        return <Space>{no}Missing</Space>;
    };

    const missingLocal = data?.rows.filter((r) => !r.local).length ?? 0;
    const missingAdo = data?.adoChecked ? data.rows.filter((r) => r.inAdo !== 'secret').length : 0;
    const saveAdding = async () => {
        if (!adding?.value || savingValue) return;
        setSavingValue(true);
        try { await api.setSecret(adding.name, adding.value, env); message.success(`Saved ${adding.name} for ${env}`); setAdding(null); await load(!!data?.adoChecked); }
        catch (e) { message.error(errText(e)); }
        finally { setSavingValue(false); }
    };
    const notSetUp = isAdoNotSetUp(data?.adoError);
    return (
        <div>
            <div className="dg-toolbar">
                <Select aria-label="Project" value={project} onChange={(v) => { setProject(v); setEnv(''); }} options={projects.map((p) => ({ value: p, label: p }))} style={{ width: 180 }} />
                <Select aria-label="Environment" value={env} onChange={setEnv} options={envs.map((e) => ({ value: e, label: e }))} style={{ width: 140 }} />
                <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(true)}>Check Azure DevOps</Button>
                <Button type="primary" icon={<CloudUploadOutlined />} disabled={!selected.length || !data?.adoChecked} onClick={send}>Send selected to ADO</Button>
                <span className="dg-spacer" />
                <span className="dg-hint">Secrets the pipeline must provide for {project}/{env}
                    <Tooltip title={<>On your computer the Studio gives each secret to the test run. In an ADO pipeline the same names come from the environment&apos;s variable group, and the pipeline passes them to the test step. Your config files stay the same in both places.</>}><InfoCircleOutlined /></Tooltip></span>
            </div>

            <Tabs size="small" className="dg-tabs" activeKey={tab} onChange={(k) => setTab(k as 'secrets' | 'setup')} items={[
                {
                    key: 'secrets', label: `Secrets${data ? ` (${data.rows.length})` : ''}`, children: <>
                        {data?.adoError && (notSetUp
                            ? <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Azure DevOps is not set up, so the ADO column cannot be checked." description={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{data.adoError}</Typography.Text>}
                                action={<Space direction="vertical" size={4}>
                                    {/access token|secret/i.test(data.adoError) && <Button size="small" type="primary" icon={<LockOutlined />} onClick={() => navigate(['secrets', 'add', /\bsecret ([A-Z][A-Z0-9_]{1,63})\b/.exec(data.adoError ?? '')?.[1] ?? 'ADO_PAT'])}>Add {/\bsecret ([A-Z][A-Z0-9_]{1,63})\b/.exec(data.adoError ?? '')?.[1] ?? 'ADO_PAT'}</Button>}
                                    <Button size="small" onClick={() => navigate(['settings', 'ado'])}>Azure DevOps settings</Button></Space>} />
                            : <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Could not check Azure DevOps" description={data.adoError} />)}
                        {data?.adoChecked && missingAdo === 0 && missingLocal === 0 && data.rows.length > 0 &&
                            <Alert type="success" showIcon style={{ marginBottom: 12 }} message={`Ready: ${data.variableGroup} has every secret ${project}/${env} needs.`} />}

                        <Table<PipelineRow> size="small" rowKey="name" loading={loading} dataSource={data?.rows ?? []} pagination={false}
                            locale={{ emptyText: `No {env:…} secrets are used by ${project}/${env}.` }}
                            rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]), getCheckboxProps: (r) => ({ disabled: !r.local, 'aria-label': `Select ${r.name}` }) }}
                            columns={[
                                { title: 'Secret name', dataIndex: 'name', render: (n: string) => <Typography.Text className="mono" strong>{n}</Typography.Text> },
                                { title: 'Used by', render: (_: unknown, r) => <Space direction="vertical" size={0}>{r.usedBy.slice(0, 3).map((u, i) => <Typography.Text key={i} type="secondary" className="mono">{u.key ? `${u.key} — ` : ''}{u.file}{u.line ? `:${u.line}` : ''}</Typography.Text>)}{r.usedBy.length > 3 && <Typography.Text type="secondary">and {r.usedBy.length - 3} more</Typography.Text>}</Space> },
                                { title: 'On this computer', width: 170, render: (_: unknown, r) => r.local ? <Space>{yes}Saved</Space> : <Space>{no}<Button size="small" onClick={() => setAdding({ name: r.name, value: '' })}>Add value</Button></Space> },
                                { title: `In ADO (${data?.variableGroup ?? '…'})`, width: 220, render: (_: unknown, r) => adoCell(r) },
                            ]} />
                    </>,
                },
                {
                    key: 'setup', label: 'Pipeline set-up', children: <Card size="small" style={{ maxWidth: 900 }}>
                        <Form layout="vertical">
                            <Form.Item label="Variable group name for each environment" htmlFor="cs-pipeline-pattern" tooltip="{project} and {env} are filled in. Saved in .cs-studio/pipeline.json: commit it so your team uses the same name.">
                                <Space.Compact style={{ width: '100%', maxWidth: 420 }}>
                                    <Input id="cs-pipeline-pattern" aria-label="Variable name pattern" value={pattern} maxLength={200} onChange={(e) => setPattern(e.target.value)} onPressEnter={() => void savePattern()} className="mono" placeholder="{project}-{env}-secrets" />
                                    <Button loading={savingPattern} disabled={!pattern.trim()} onClick={() => void savePattern()}>Save</Button>
                                </Space.Compact>
                            </Form.Item>
                            <Form.Item label={<span>Parameters for the <Typography.Text code>ado-playwright-shared</Typography.Text> stage template</span>} style={{ marginBottom: 0 }}
                                tooltip="The shared template needs the optional secretsVariableGroup and secretNames parameters (a change to the shared pipeline template, made by its owners). Pipelines that do not pass them behave exactly as today.">
                                <Typography.Paragraph copyable={{ text: data?.yaml ?? '', tooltips: ['Copy', 'Copied'] }} style={{ marginBottom: 0, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                    <pre className="code-box" style={{ margin: 0, flex: 1 }}>{data?.yaml ?? ''}</pre>
                                </Typography.Paragraph>
                            </Form.Item>
                        </Form>
                    </Card>,
                },
            ]} />

            <Modal open={!!adding} title={`Value for ${adding?.name}`} okText="Save on this computer" onCancel={() => setAdding(null)} okButtonProps={{ disabled: !adding?.value }} confirmLoading={savingValue}
                onOk={() => void saveAdding()} destroyOnClose>
                <Typography.Paragraph type="secondary">Saved encrypted on this computer for the <b>{env}</b> environment. Use “Send selected to ADO” afterwards to give it to the pipeline.</Typography.Paragraph>
                <Input.Password aria-label="Secret value" autoFocus autoComplete="new-password" onPressEnter={() => void saveAdding()} value={adding?.value} onChange={(e) => adding && setAdding({ ...adding, value: e.target.value })} />
            </Modal>
        </div>
    );
}
