import React from 'react';
import { Alert, App, Button, Col, Form, Input, List, Modal, Popconfirm, Popover, Row, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, InfoCircleOutlined, LockOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import '../styles-datagit.css';
import { api, SecretMeta, SecretUsageDef } from '../api';
import { errText, openInEditor, useStudio } from '../state';
import { navigate, useRoute } from '../route';
import { plural } from '../datagit-common';
import { datagitApi, isStale } from '../datagit-api';

export function Secrets() {
    const { message, modal } = App.useApp();
    const { env, projectId } = useStudio();
    const [rows, setRows] = React.useState<SecretMeta[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [adding, setAdding] = React.useState<{ name: string; value: string; env: string; scope: 'project' | 'all-projects'; /** Replace: this secret, its name and where it applies fixed. */ replace?: boolean } | null>(null);

    const [usage, setUsage] = React.useState<SecretUsageDef | null>(null);
    const [find, setFind] = React.useState('');
    const load = React.useCallback(() => {
        setLoading(true);
        api.secrets().then(setRows).catch((e) => message.error(errText(e))).finally(() => setLoading(false));
        api.secretUsage().then(setUsage).catch(() => setUsage(null));
    }, [message]);
    const usesOf = (r: SecretMeta) => usage?.secrets.find((x) => x.name === r.name && (x.env ?? '') === (r.env ?? '') && (x.project ?? '') === (r.project ?? ''));
    const usesList = (uses: SecretUsageDef['missing'][number]['uses']) => (
        <List size="small" style={{ maxWidth: 520, maxHeight: 320, overflow: 'auto' }} dataSource={uses} renderItem={(u) => (
            <List.Item style={{ padding: '4px 0' }}><Space size={6}><Tag>{u.where}</Tag><Typography.Link className="mono" style={{ fontSize: 12 }} onClick={() => openInEditor(u.file, u.line)}>{u.file}{u.line ? `:${u.line}` : ''}</Typography.Link>{u.key && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{u.key}</Typography.Text>}{u.env && <Tag color="blue">{u.env}</Tag>}</Space></List.Item>
        )} />);
    React.useEffect(load, [load]);
    // #/secrets/add/<NAME>: another screen asked for this secret (e.g. ADO_PAT for Azure DevOps).
    const route = useRoute();
    React.useEffect(() => {
        if (route[0] === 'secrets' && route[1] === 'add') {
            // Names are capital letters: "lower_bad" opens as LOWER_BAD; a name that is still not valid opens
            // with the reason under the field, never silently nothing.
            setAdding({ name: (route[2] ?? '').toUpperCase().slice(0, 64), value: '', env: '', scope: 'project' });
            navigate(['secrets'], true);
        } else if (route[0] === 'secrets' && route[1]) navigate(['secrets'], true);
    }, [route]);

    const envOptions = React.useMemo(() => {
        const all = new Set<string>();
        Object.values(env?.environments ?? {}).forEach((l) => l.forEach((e) => all.add(e)));
        return [{ value: '', label: 'Every environment' }, ...[...all].sort().map((e) => ({ value: e, label: e }))];
    }, [env]);

    const saving = React.useRef(false);
    const save = async () => {
        if (!adding || saving.current) return;
        saving.current = true;
        try { await saveNow(); } finally { saving.current = false; }
    };
    const saveNow = async () => {
        if (!adding) return;
        // Adding a secret that exists (same name, environment and projects) replaces its value: asked first.
        const same = rows.some((r) => r.name === adding.name && (r.env ?? '') === adding.env && (adding.scope === 'all-projects' ? !r.project : !!r.project));
        if (same && !adding.replace) {
            modal.confirm({ title: `${adding.name} exists`, content: `There is already a secret ${adding.name}${adding.env ? ` for ${adding.env}` : ''}. Replace its value?`, okText: 'Replace', okButtonProps: { danger: true },
                onOk: async () => { try { await datagitApi.setSecret(adding.name, adding.value, adding.env || undefined, adding.scope === 'all-projects' ? 'all-projects' : undefined, 'existing'); message.success(`Replaced ${adding.name}`); setAdding(null); load(); } catch (e) { message.error(errText(e)); load(); } } });
            return;
        }
        const a = adding;
        const put = (expect?: 'new' | 'existing') => datagitApi.setSecret(a.name, a.value, a.env || undefined, a.scope === 'all-projects' ? 'all-projects' : undefined, expect);
        try {
            // What the list showed: Add expects no such secret, Replace expects it still there (another tab may differ).
            await put(a.replace ? 'existing' : 'new');
            message.success(`Saved ${a.name}`);
            setAdding(null); load();
        } catch (e) {
            if (!isStale(e)) { message.error(errText(e)); return; }
            load();
            modal.confirm({
                title: a.replace ? `${a.name} was deleted elsewhere` : `${a.name} exists now`, content: `${errText(e)} ${a.replace ? 'Add it again with this value?' : 'Replace its value?'}`,
                okText: a.replace ? 'Add it again' : 'Replace', okButtonProps: { danger: true }, cancelText: 'Keep editing',
                onOk: async () => { try { await put(); message.success(`${a.replace ? 'Added' : 'Replaced'} ${a.name}`); setAdding(null); load(); } catch (x) { message.error(errText(x)); } },
            });
        }
    };

    const q = find.trim().toLowerCase();
    const shown = q ? rows.filter((r) => `${r.name} ${r.env ?? ''} ${r.project ?? ''}`.toLowerCase().includes(q)) : rows;
    const nameOk = !!adding && /^[A-Z][A-Z0-9_]{0,63}$/.test(adding.name);
    return (
        <div>
            <div className="dg-toolbar">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding({ name: '', value: '', env: '', scope: 'project' })}>Add secret</Button>
                <Input allowClear prefix={<SearchOutlined />} placeholder="Find a secret" aria-label="Find a secret" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 240 }} />
                <span className="dg-spacer" />
                <span className="dg-hint"><LockOutlined /> Encrypted on this computer only; values are never shown again.
                    <Tooltip title={<>Config and tests refer to a secret by name, for example DB_PASSWORD={'{env:QA_DB_PASSWORD}'}. When you run tests from the Studio, the value is handed to the test process only. Values can be replaced but never shown again.</>}><InfoCircleOutlined /></Tooltip></span>
            </div>
            {usage && usage.missing.length > 0 && (
                <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={<Space wrap size={[6, 6]}><span>{usage.missing.length} name{usage.missing.length === 1 ? ' is' : 's are'} read by the tests but not stored here (click to add):</span>{usage.missing.map((m) => <Popover key={m.name} content={usesList(m.uses)} title={`Where ${m.name} is read`}><Tag style={{ cursor: 'pointer' }} className="mono" onClick={() => setAdding({ name: m.name, value: '', env: '', scope: 'project' })}>{m.name} +</Tag></Popover>)}</Space>} />
            )}
            <Table<SecretMeta> size="small" loading={loading} dataSource={shown} rowKey={(r) => `${r.name}|${r.project ?? ''}|${r.env ?? ''}`} pagination={false} className="dg-secrets-table"
                locale={{ emptyText: find && rows.length ? 'No secret matches.' : 'No secrets yet.' }}
                columns={[
                    { title: 'Name', dataIndex: 'name', render: (n: string) => <Typography.Text className="mono" strong style={{ overflowWrap: 'break-word' }}>{n.split('_').map((part, i) => <React.Fragment key={i}>{i > 0 && <>_<wbr /></>}{part}</React.Fragment>)}</Typography.Text> },
                    { title: 'Used in', render: (_: unknown, r) => <Space size={[4, 4]} wrap><Tag>{r.project ? `this project (${r.project})` : 'all projects'}</Tag><Tag color={r.env ? 'blue' : undefined}>{r.env ?? 'every environment'}</Tag></Space> },
                    { title: 'Value', render: (_: unknown, r) => <Typography.Text type="secondary"><span style={{ whiteSpace: 'nowrap' }}>{'•'.repeat(Math.min(12, Math.max(6, r.length)))}</span> <span style={{ whiteSpace: 'nowrap' }}>({plural(r.length, 'character')})</span></Typography.Text> },
                    { title: 'Read by', render: (_: unknown, r) => {
                        const u = usesOf(r);
                        if (!u) return null;
                        return u.uses.length ? <Popover content={usesList(u.uses)} title={`Where ${r.name} is read`}><Typography.Link>{u.uses.length} place{u.uses.length === 1 ? '' : 's'}</Typography.Link></Popover>
                            : <Tooltip title="Nothing in this repository reads it (configuration, features, API collections, load scenarios, tool servers). Other repositories may."><Tag>not used here</Tag></Tooltip>;
                    } },
                    { title: 'Last changed', dataIndex: 'updatedAt', render: (d: string, r) => { const u = usesOf(r); return <Space size={6} wrap><span style={{ whiteSpace: 'nowrap' }}>{new Date(d).toLocaleDateString()}</span>{u?.rotate && <Tooltip title={`Changed ${plural(u.ageDays, 'day')} ago: time to rotate it (every ${usage?.rotateDays ?? 90} days).`}><Tag color="orange">rotate</Tag></Tooltip>}</Space>; } },
                    { title: '', width: 120, render: (_: unknown, r) => (
                        <Space size={4} style={{ whiteSpace: 'nowrap' }}>
                            <Button size="small" onClick={() => setAdding({ name: r.name, value: '', env: r.env ?? '', scope: r.project ? 'project' : 'all-projects', replace: true })}>Replace</Button>
                            <Popconfirm title={`Delete ${r.name}${r.env ? ` (${r.env})` : ''}?`} description={(() => { const u = usesOf(r); return u?.uses.length ? `${u.uses.length} place${u.uses.length === 1 ? '' : 's'} read it: they will get an empty value.` : 'Nothing in this repository reads it.'; })()} okText="Delete" okButtonProps={{ danger: true }}
                                onConfirm={async () => { try { const x = await api.deleteSecret(r.name, r.env, r.project ? undefined : 'all-projects'); if (x.removed) message.success(`Deleted ${r.name}${r.env ? ` (${r.env})` : ''}`); else message.info(`${r.name} was already gone.`); load(); } catch (e) { message.error(errText(e)); } }}>
                                <Button size="small" danger type="text" icon={<DeleteOutlined />} aria-label={`Delete ${r.name}`} title={`Delete ${r.name}`} />
                            </Popconfirm>
                        </Space>) },
                ]} />
            <Modal open={!!adding} title={adding?.replace ? `Replace ${adding.name}` : 'Add secret'} onCancel={() => setAdding(null)} onOk={save} okText="Save" destroyOnClose
                okButtonProps={{ disabled: !nameOk || !adding?.value }}>
                {adding && (
                    <Form layout="vertical">
                        <Form.Item label="Name" htmlFor="cs-secrets-name" tooltip="Capital letters, digits and _ — for example QA_DB_PASSWORD"
                            validateStatus={adding.name && !nameOk ? 'error' : undefined} help={adding.name && !nameOk ? 'Capital letters, digits and _, starting with a letter (at most 64).' : undefined}>
                            <Input id="cs-secrets-name" className="mono" autoFocus={!adding.name} maxLength={64} disabled={adding.replace} value={adding.name} placeholder="QA_DB_PASSWORD"
                                onChange={(e) => setAdding({ ...adding, name: e.target.value.toUpperCase() })} onPressEnter={() => { if (nameOk && adding.value) void save(); }} /></Form.Item>
                        <Form.Item label="Value" htmlFor="cs-secrets-value"><Input.Password id="cs-secrets-value" autoFocus={!!adding.name} value={adding.value} autoComplete="new-password" onChange={(e) => setAdding({ ...adding, value: e.target.value })} onPressEnter={() => { if (nameOk && adding.value) void save(); }} /></Form.Item>
                        <Row gutter={12}>
                            <Col span={12}><Form.Item label="Environment" htmlFor="cs-secrets-environment" style={{ marginBottom: 0 }}><Select id="cs-secrets-environment" disabled={adding.replace} value={adding.env} onChange={(v) => setAdding({ ...adding, env: v })} options={envOptions} /></Form.Item></Col>
                            <Col span={12}><Form.Item label="Projects" htmlFor="cs-secrets-projects" style={{ marginBottom: 0 }}><Select id="cs-secrets-projects" disabled={adding.replace} value={adding.scope} onChange={(v) => setAdding({ ...adding, scope: v })}
                                options={[{ value: 'project', label: `Only ${projectId}` }, { value: 'all-projects', label: 'All my projects' }]} /></Form.Item></Col>
                        </Row>
                    </Form>
                )}
            </Modal>
        </div>
    );
}
