import React from 'react';
import { Alert, App, Badge, Button, Drawer, Dropdown, Empty, Form, Input, List, Modal, Popover, Radio, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DiffOutlined, DownOutlined, EditOutlined, SearchOutlined, LockOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, EffectiveEntry, Problem, ResolveResult } from '../api';
import { errText, useStudio } from '../state';
import { NewProjectWizard } from '../components/NewProjectWizard';
import { useStoredTab } from '../datagit-common';

const SEV_COLOR = { error: 'red', warning: 'gold', info: 'default' } as const;

/** File the user most likely wants to change for a key: where it currently wins, else the environment file. */
function defaultTarget(e: EffectiveEntry | null, project: string, env: string) {
    if (e && e.from.source.startsWith('config/')) return e.from.source;
    return `config/${project}/environments/${env}.env`;
}

function EditModal({ project, env, entry, keyName, existing = [], onClose, onSaved }: { project: string; env: string; entry: EffectiveEntry | null; keyName?: string; existing?: EffectiveEntry[]; onClose: () => void; onSaved: () => void }) {
    const { message, modal } = App.useApp();
    const [key, setKey] = React.useState(entry?.key ?? keyName ?? '');
    const sensitiveGuess = /(PASSWORD|PASSWD|PWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|_PAT|CREDENTIALS?)(_?\d+)?$/i.test(key);
    const [mode, setMode] = React.useState<'value' | 'secret'>(sensitiveGuess ? 'secret' : 'value');
    const [file, setFile] = React.useState(defaultTarget(entry, project, env));
    const [value, setValue] = React.useState(entry && !entry.sensitive ? (entry.from.raw ?? '') : '');
    // Reuse the name the file already refers to ({env:NAME}); otherwise suggest one from the key.
    const existingRef = entry ? /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(entry.from.raw)?.[1] : undefined;
    const [secretName, setSecretName] = React.useState(existingRef ?? (key ? key.toUpperCase().replace(/[^A-Z0-9_]/g, '_') : ''));
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => { if (sensitiveGuess) setMode('secret'); }, [sensitiveGuess]);

    const files = React.useMemo(() => {
        const s = new Set<string>([`config/${project}/environments/${env}.env`, `config/${project}/common/common.env`, 'config/global.env']);
        if (entry) { if (entry.from.source.startsWith('config/')) s.add(entry.from.source); entry.overrides.forEach((o) => o.source.startsWith('config/') && s.add(o.source)); }
        return [...s].map((f) => ({ value: f, label: f }));
    }, [entry, project, env]);

    const save = async (confirmed = false) => {
        // A new setting whose name is set already: say where, and replace or override only when asked.
        const there = !entry && existing.find((x) => x.key === key.trim());
        const caseTwin = !entry && !there && existing.find((x) => x.key.toLowerCase() === key.trim().toLowerCase());
        if (caseTwin && !confirmed) {
            modal.confirm({ title: `${caseTwin.key} is set already`, okText: 'Add anyway', cancelText: 'Cancel',
                content: `${key.trim()} differs from ${caseTwin.key} only in upper and lower case. On Windows they are the same setting; on Linux build agents they are two. Use ${caseTwin.key} (Change) unless you mean a separate setting.`,
                onOk: () => save(true) });
            return;
        }
        if (there && !confirmed) {
            const same = [there.from, ...there.overrides].some((d) => d.source === file);
            modal.confirm({ title: `${there.key} is set already`, okText: same ? 'Replace' : 'Save', okButtonProps: same ? { danger: true } : {},
                content: same ? `${file} already has ${there.key}. Replace its value?` : `${there.key} comes from ${there.from.source} now. Saving it in ${file} ${file.includes('/environments/') ? 'overrides it for this environment' : 'adds another definition'}.`,
                onOk: () => save(true) });
            return;
        }
        setBusy(true);
        try {
            if (mode === 'secret') {
                const r = await api.envSecret({ file, key, secretName, value, env });
                message.success(`${key} now uses ${r.reference}; the value is in your secret store`);
            } else {
                await api.envSet(file, key, value);
                message.success(`${key} saved in ${file}`);
            }
            onSaved();
        } catch (e) { message.error(errText(e)); }
        finally { setBusy(false); }
    };

    return (
        <Modal open title={entry ? `Change ${entry.key}` : 'Add a setting'} onCancel={onClose} onOk={() => void save()} okText="Save" confirmLoading={busy}
            footer={(_, { OkBtn, CancelBtn }) => <>
                {entry && entry.from.source.startsWith('config/') && <Button danger style={{ float: 'left' }} onClick={() => modal.confirm({
                    title: `Delete ${entry.key} from ${entry.from.source}?`, okText: 'Delete', okButtonProps: { danger: true },
                    content: entry.overrides.length ? `Then ${entry.overrides[entry.overrides.length - 1].source} gives its value.` : 'Nothing else sets it: tests that read it get no value.',
                    onOk: async () => { try { await api.envRemove(entry.from.source, entry.key); message.success(`Deleted ${entry.key} from ${entry.from.source}`); onSaved(); } catch (e) { message.error(errText(e)); } },
                })}>Delete</Button>}
                <CancelBtn /><OkBtn />
            </>}
            okButtonProps={{ disabled: !key || !file || (mode === 'secret' && (!secretName || !value)) }} width={620}>
            <Form layout="vertical">
                {!entry && <Form.Item label="Setting name" htmlFor="cs-environments-setting-name"><Input id="cs-environments-setting-name" value={key} onChange={(e) => setKey(e.target.value)} onPressEnter={() => { if (key && file && !(mode === 'secret' && (!secretName || !value))) void save(); }} placeholder="BASE_URL" /></Form.Item>}
                <Form.Item label="Save in file" htmlFor="cs-environments-file" help="Files lower in the list are overridden by files above them for this environment.">
                    <Select id="cs-environments-file" value={file} onChange={setFile} options={files} showSearch />
                </Form.Item>
                <Form.Item label="What kind of value?">
                    <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
                        <Radio.Button value="value">Normal value</Radio.Button>
                        <Radio.Button value="secret"><LockOutlined /> Secret (password, token…)</Radio.Button>
                    </Radio.Group>
                </Form.Item>
                {mode === 'value' ? (
                    <Form.Item label="Value" htmlFor="cs-environments-value"><Input id="cs-environments-value" value={value} onChange={(e) => setValue(e.target.value)} className="mono" /></Form.Item>
                ) : (
                    <>
                        <Form.Item label="Secret value" htmlFor="cs-environments-secret-value" help="Encrypted on this computer. It is never written to the file.">
                            <Input.Password id="cs-environments-secret-value" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
                        </Form.Item>
                        <Form.Item label="Secret name" htmlFor="cs-environments-secret-name" help={<>The file will contain <Typography.Text code>{`${key || 'KEY'}={env:${secretName || 'NAME'}}`}</Typography.Text>. In ADO pipelines the same name comes from the environment&apos;s secret variables.</>}>
                            <Input id="cs-environments-secret-name" value={secretName} onChange={(e) => setSecretName(e.target.value.toUpperCase())} className="mono" />
                        </Form.Item>
                    </>
                )}
            </Form>
        </Modal>
    );
}

function Provenance({ e }: { e: EffectiveEntry }) {
    const chain = [...e.overrides, e.from];
    return (
        <div style={{ maxWidth: 520 }}>
            <Typography.Text strong>Where {e.key} comes from (last one wins)</Typography.Text>
            <List size="small" dataSource={chain.map((d, i) => ({ d, win: i === chain.length - 1 }))} renderItem={({ d, win }) => (
                <List.Item style={{ opacity: win ? 1 : .6 }}>
                    <Space direction="vertical" size={0}>
                        <Typography.Text className="mono" strong={win}>{d.source}{d.line ? `:${d.line}` : ''} {win && <Tag color="green">used</Tag>}</Typography.Text>
                        <Typography.Text type="secondary" className="mono">{d.raw || '(empty)'}</Typography.Text>
                    </Space>
                </List.Item>
            )} />
        </div>
    );
}

type EnvTab = 'settings' | 'problems' | 'files';

export function Environments() {
    const { message } = App.useApp();
    const { env: disc, refresh: refreshStudio } = useStudio();
    const projects = disc?.projects ?? [];
    // The list of things to fix can be long: shown on demand (remembered), the count always.
    const [tab, setTab] = useStoredTab<EnvTab>('environments', ['settings', 'problems', 'files'], 'settings');
    const [project, setProject] = React.useState<string>('');
    const [env, setEnv] = React.useState<string>('');
    const [data, setData] = React.useState<ResolveResult | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [filter, setFilter] = React.useState('');
    const [onlyProject, setOnlyProject] = React.useState(true);
    const [editing, setEditing] = React.useState<{ entry: EffectiveEntry | null; key?: string } | null>(null);
    const [compare, setCompare] = React.useState<string | null>(null);
    const [diffRows, setDiffRows] = React.useState<Array<{ key: string; a?: string; b?: string; aFrom?: string; bFrom?: string }>>([]);
    const [creating, setCreating] = React.useState(false);
    const [creatingBusy, setCreatingBusy] = React.useState(false);
    const [newProject, setNewProject] = React.useState(false);
    const [newEnv, setNewEnv] = React.useState({ name: '', copyFrom: '' });

    React.useEffect(() => { if (!project && projects.length) setProject(projects[0]); }, [projects, project]);
    const envs = project ? (disc?.environments[project] ?? []) : [];
    const envChoices = envs.length ? envs : ['dev'];
    React.useEffect(() => { if (project && (!env || !envChoices.includes(env))) setEnv(envChoices[0]); }, [project, envChoices.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

    const load = React.useCallback(async () => {
        if (!project || !env) return;
        setLoading(true);
        try { setData(await api.envResolve(project, env)); } catch (e) { message.error(errText(e)); }
        finally { setLoading(false); }
    }, [project, env, message]);
    React.useEffect(() => { void load(); }, [load]);

    React.useEffect(() => {
        if (!compare || !project || !env) return;
        api.envCompare(project, env, compare).then((r) => setDiffRows(r.differences)).catch((e) => message.error(errText(e)));
    }, [compare, project, env, message]);

    if (projects.length === 0) {
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description={<>No framework configuration found.<br />Projects live in <Typography.Text code>config/&lt;project&gt;/</Typography.Text> with environments in <Typography.Text code>config/&lt;project&gt;/environments/&lt;env&gt;.env</Typography.Text>.</>} />;
    }

    const projectPrefix = `config/${project}/`;
    const rows = (data?.entries ?? []).filter((e) =>
        (!filter || e.key.toLowerCase().includes(filter.toLowerCase()) || e.value.toLowerCase().includes(filter.toLowerCase()))
        && (!onlyProject || e.from.source.startsWith(projectPrefix) || !e.from.source.startsWith('config/')));
    const problems = data?.problems.filter((p) => p.severity !== 'info') ?? [];

    const envNameOk = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(newEnv.name) && !envs.includes(newEnv.name);
    const createEnv = async () => {
        if (!envNameOk || creatingBusy) return;
        setCreatingBusy(true);
        try {
            const r = await api.envCreate(project, newEnv.name, newEnv.copyFrom || undefined);
            message.success(`Created ${r.file}${r.secretKeys.length ? ` — set ${r.secretKeys.length} secret(s) for it` : ''}`);
            setCreating(false); await refreshStudio(); setEnv(newEnv.name);
        } catch (e) { message.error(errText(e)); }
        finally { setCreatingBusy(false); }
    };
    const fixProblem = (p: Problem) => {
        const entry = data?.entries.find((e) => e.key === p.key) ?? null;
        setEditing({ entry, key: p.key });
    };

    return (
        <div>
            <div className="dg-toolbar">
                <Select aria-label="Project" value={project} onChange={(v) => { setProject(v); setEnv(''); }} options={projects.map((p) => ({ value: p, label: p }))} style={{ width: 180 }} prefix={<Typography.Text type="secondary">Project</Typography.Text>} />
                <Select aria-label="Environment" value={env} onChange={setEnv} options={envChoices.map((e) => ({ value: e, label: e }))} style={{ width: 170 }} prefix={<Typography.Text type="secondary">Env</Typography.Text>} />
                <Tooltip title="Read the settings again"><Button aria-label="Read the settings again" icon={<ReloadOutlined />} loading={loading} onClick={load} /></Tooltip>
                <Tooltip title={envChoices.length < 2 ? 'Only one environment: nothing to compare with' : `Compare ${env} with another environment`}><Button icon={<DiffOutlined />} disabled={envChoices.length < 2} onClick={() => setCompare(envChoices.find((e) => e !== env) ?? null)}>Compare…</Button></Tooltip>
                <span className="dg-spacer" />
                <Dropdown menu={{ items: [{ key: 'env', label: `New environment for ${project}` }, { key: 'project', label: 'New project' }], onClick: ({ key }) => {
                    if (key === 'env') { setNewEnv({ name: '', copyFrom: envs.includes(env) ? env : '' }); setCreating(true); } else setNewProject(true);
                } }}><Button icon={<PlusOutlined />}>New <DownOutlined /></Button></Dropdown>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ entry: null })}>Add setting</Button>
            </div>

            {problems.length > 0 && tab === 'settings' && <Alert type={problems.some((p) => p.severity === 'error') ? 'error' : 'warning'} showIcon style={{ marginBottom: 12, padding: '4px 12px' }}
                message={<Space>{`${problems.length} setting${problems.length === 1 ? ' needs' : 's need'} attention in ${project} / ${env}`}
                    <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setTab('problems')}>Show</Button></Space>} />}
            <Tabs size="small" className="dg-tabs" activeKey={tab} onChange={(k) => setTab(k as EnvTab)} items={[
                {
                    key: 'settings', label: `Settings${data ? ` (${rows.length})` : ''}`, children: <>
            <Table<EffectiveEntry> className="surface" size="small" rowKey="key" loading={loading} dataSource={rows} pagination={{ pageSize: 100, hideOnSinglePage: true, showSizeChanger: false }}
                title={() => (
                    <Space wrap>
                        <Input allowClear prefix={<SearchOutlined />} placeholder="Find a setting or value" aria-label="Find a setting or value" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 280 }} />
                        <Radio.Group size="small" value={onlyProject} onChange={(e) => setOnlyProject(e.target.value)}>
                            <Radio.Button value={true}>Set by {project}</Radio.Button>
                            <Radio.Button value={false}>All {data?.entries.length ?? 0} settings</Radio.Button>
                        </Radio.Group>
                    </Space>
                )}
                columns={[
                    { title: 'Setting', dataIndex: 'key', width: 240, render: (k: string, e) => <Space><Typography.Text className="mono" strong>{k}</Typography.Text>{e.sensitive && <Tooltip title="Secret: value hidden"><LockOutlined /></Tooltip>}</Space> },
                    { title: 'Value', dataIndex: 'value', ellipsis: true, render: (v: string, e) => (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                            <Typography.Text className="mono" type={e.sensitive ? 'secondary' : undefined} ellipsis={{ tooltip: v }} style={{ minWidth: 0 }}>{v || <Typography.Text type="secondary">(empty)</Typography.Text>}</Typography.Text>
                            {e.runtimePlaceholders && <Tag>set at run time</Tag>}
                            {!e.runtimePlaceholders && /<[^<>\s]+>/.test(e.from.raw ?? '') && <Tooltip title={`The framework reads <…> in a value as a placeholder filled when tests run, so "${e.from.raw}" shows as "${v}". Use the value without < > if it is meant literally.`}><Tag color="gold">placeholder</Tag></Tooltip>}
                        </div>) },
                    { title: 'Comes from', width: '32%', render: (_: unknown, e) => (
                        <Popover content={<Provenance e={e} />} placement="left">
                            <Typography.Text className="mono" style={{ cursor: 'help' }}>{e.from.source}{e.from.line ? `:${e.from.line}` : ''}</Typography.Text>
                            {e.overrides.length > 0 && <Tag style={{ marginLeft: 6 }}>overrides {e.overrides.length}</Tag>}
                        </Popover>) },
                    { title: '', width: 48, render: (_: unknown, e) => <Tooltip title="Change"><Button aria-label="Change" size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing({ entry: e })} /></Tooltip> },
                ]} />

                    </>,
                },
                {
                    key: 'problems', label: <span>Needs attention {problems.length > 0 && <Badge count={problems.length} size="small" color={problems.some((p) => p.severity === 'error') ? '#cf222e' : '#d48806'} />}</span>, children: problems.length === 0
                        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`Nothing needs attention in ${project} / ${env}.`} />
                        : <div className="panel" style={{ padding: '0 12px' }}>
                        <List size="small" aria-label="Settings that need attention" dataSource={problems} renderItem={(p) => (
                            <List.Item actions={p.key ? [<Button key="f" size="small" onClick={() => fixProblem(p)}>{p.code === 'legacy-encrypted-value' || p.code === 'literal-secret-in-config' || p.code === 'missing-env-reference' ? 'Store as secret' : 'Edit'}</Button>] : []}>
                                <Space direction="vertical" size={0}>
                                    <span>{p.severity === 'error' && <Tag bordered={false} color={SEV_COLOR[p.severity]}>error</Tag>}{p.message}</span>
                                    {p.source && <Typography.Text type="secondary" className="mono">{p.source}{p.line ? `:${p.line}` : ''}</Typography.Text>}
                                </Space>
                            </List.Item>
                        )} />
                        </div>,
                },
                {
                    key: 'files', label: `Files${data ? ` (${data.layers.filter((l) => l.exists && l.keys > 0).length})` : ''}`, children: data ? <div className="panel" style={{ padding: 12, maxWidth: 820 }}>
                        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>What a run with PROJECT={project} ENVIRONMENT={env} sees, built like the framework does: each file overrides the ones before it.</Typography.Paragraph>
                    {data.layers.filter((l) => l.exists && l.keys > 0).map((l, i) => <div key={l.source} className="mono" style={{ padding: '2px 0' }}>{i + 1}. {l.source} <Typography.Text type="secondary">({l.keys})</Typography.Text></div>)}
                    </div> : <Spin />,
                },
            ]} />

            {editing && <EditModal project={project} env={env} entry={editing.entry} keyName={editing.key} existing={data?.entries ?? []} onClose={() => setEditing(null)}
                onSaved={() => { setEditing(null); void load(); void refreshStudio(); }} />}

            <Drawer open={!!compare} onClose={() => setCompare(null)} width={820} title={
                <Space>Compare <Tag>{env}</Tag> with
                    <Select aria-label="Compare with environment" size="small" value={compare ?? undefined} onChange={setCompare} options={envChoices.filter((e) => e !== env).map((e) => ({ value: e, label: e }))} style={{ width: 140 }} />
                </Space>}>
                <Table size="small" rowKey="key" dataSource={diffRows} pagination={false}
                    locale={{ emptyText: 'These environments have the same settings.' }}
                    columns={[
                        { title: 'Setting', dataIndex: 'key', render: (k: string) => <Typography.Text className="mono">{k}</Typography.Text> },
                        { title: env, dataIndex: 'a', render: (v?: string) => v === undefined ? <Tag>not set</Tag> : <Typography.Text className="mono">{v}</Typography.Text> },
                        { title: compare ?? '', dataIndex: 'b', render: (v?: string) => v === undefined ? <Tag>not set</Tag> : <Typography.Text className="mono">{v}</Typography.Text> },
                    ]} />
            </Drawer>

            <NewProjectWizard open={newProject} onClose={() => setNewProject(false)} onCreated={async (slug, first) => { await refreshStudio(); setProject(slug); setEnv(first); }} />
            <Modal open={creating} title={`New environment for ${project}`} onCancel={() => setCreating(false)} okText="Create"
                okButtonProps={{ disabled: !envNameOk }} destroyOnClose
                confirmLoading={creatingBusy} onOk={() => void createEnv()}>
                <Form layout="vertical">
                    {(() => {
                        // Why Create is off, said under the name (a file name: letters, digits, - and _).
                        const n = newEnv.name;
                        const why = !n ? null : /\s/.test(n) ? 'No spaces: use - or _ (for example uat-2).' : !/^[A-Za-z0-9]/.test(n) ? 'Start with a letter or a digit.' : !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n) ? 'Only Latin letters, digits, - and _ (it becomes a file name and the --env value).' : envs.includes(n) ? `${n} exists already.` : null;
                        return <Form.Item label="Name" validateStatus={why ? 'error' : undefined} help={why ?? 'For example sit, uat or perf'} htmlFor="cs-environments-name"><Input id="cs-environments-name" autoFocus value={n} maxLength={40} onPressEnter={() => void createEnv()} onChange={(e) => setNewEnv({ ...newEnv, name: e.target.value })} /></Form.Item>;
                    })()}
                    <Form.Item label="Start from" htmlFor="cs-environments-start-from" help="Settings are copied; secret values are never copied — they become references you fill in.">
                        <Select id="cs-environments-start-from" value={newEnv.copyFrom} onChange={(v) => setNewEnv({ ...newEnv, copyFrom: v })}
                            options={[{ value: '', label: 'Empty file' }, ...envs.map((e) => ({ value: e, label: `Copy of ${e}` }))]} />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
