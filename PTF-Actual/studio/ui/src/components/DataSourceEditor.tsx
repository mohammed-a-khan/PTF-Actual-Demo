/**
 * Test data for an API run or a load test: a file (CSV, Excel, JSON, XML), a database query or stored
 * procedure (the project's connections), an API response or generated rows; the framework's filter,
 * shuffle and limit; and a preview. Each column is used as {{column}} in the requests.
 */
import React from 'react';
import { Alert, Button, Checkbox, Input, InputNumber, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import { api, ApiCollectionDef, ApiCollectionInfo, DataPreview, DataSourceDef, DbConnection } from '../api';
import { errText } from '../state';

const KINDS: Array<{ value: DataSourceDef['kind']; label: string }> = [
    { value: 'file', label: 'File (CSV, Excel, JSON, XML)' },
    { value: 'query', label: 'Database query' },
    { value: 'procedure', label: 'Stored procedure / function' },
    { value: 'api', label: 'API response' },
    { value: 'generate', label: 'Generated rows' },
];

const flatRequests = (c: ApiCollectionDef) => { const out: Array<{ id: string; name: string; method: string }> = []; const w = (xs: ApiCollectionDef['items']) => { for (const x of xs) { if (x.kind === 'folder') w(x.items); else out.push({ id: x.id, name: x.name, method: x.method }); } }; w(c.items); return out; };

export function DataSourceEditor({ project, env, value, onChange, collections }: { project: string; env?: string; value?: DataSourceDef; onChange: (v: DataSourceDef | undefined) => void; collections?: ApiCollectionInfo[] }) {
    const [conns, setConns] = React.useState<DbConnection[] | null>(null);
    const [requests, setRequests] = React.useState<Array<{ id: string; name: string; method: string }>>([]);
    const [preview, setPreview] = React.useState<DataPreview | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const v = value;
    const set = (p: Partial<DataSourceDef>) => { if (v) onChange({ ...v, ...p }); setPreview(null); };
    const db = v?.kind === 'query' || v?.kind === 'procedure';
    React.useEffect(() => { if (db && project && !conns) api.dbConnections(project, env).then((r) => setConns(r.connections)).catch(() => setConns([])); }, [db, project, env, conns]);
    React.useEffect(() => { setConns(null); }, [project, env]);
    React.useEffect(() => { setRequests([]); if (v?.kind === 'api' && v.collection) api.apiCollection(v.collection).then((r) => setRequests(flatRequests(r.collection))).catch(() => {}); }, [v?.kind, v?.collection]);
    const ext = (v?.file ?? '').split('.').pop()?.toLowerCase() ?? '';

    const run = async () => {
        if (!v) return;
        setLoading(true); setErr(null); setPreview(null);
        try { setPreview(await api.dataPreview(project, env, v)); } catch (e) { setErr(errText(e)); } finally { setLoading(false); }
    };

    return (
        <Space direction="vertical" style={{ width: '100%' }} size={6}>
            <Select size="small" style={{ width: '100%' }} value={v?.kind ?? 'none'} aria-label="Test data source"
                onChange={(k) => { setPreview(null); setErr(null); onChange(k === 'none' ? undefined : { kind: k as DataSourceDef['kind'], ...(k === 'generate' ? { generate: '10:id=number,email=email' } : {}), ...(k === 'file' ? { file: `test/${project}/data/` } : {}) }); }}
                options={[{ value: 'none', label: 'None' }, ...KINDS]} />
            {v?.kind === 'file' && <>
                <Input size="small" className="mono" value={v.file} placeholder={`test/${project}/data/users.csv`} onChange={(e) => set({ file: e.target.value })} aria-label="Data file"
                    suffix={<Tooltip title="{env} is replaced by the environment, as in the framework"><Typography.Text type="secondary" style={{ fontSize: 11 }}>.csv .xlsx .json .xml</Typography.Text></Tooltip>} />
                {(ext === 'xlsx' || ext === 'xls') && <Input size="small" addonBefore="Sheet" value={v.sheet} placeholder="first sheet" onChange={(e) => set({ sheet: e.target.value || undefined })} aria-label="Sheet" />}
                {ext === 'json' && <Input size="small" className="mono" addonBefore="JSONPath" value={v.path} placeholder="$.data.users[*]" onChange={(e) => set({ path: e.target.value || undefined })} aria-label="JSON path" />}
                {ext === 'xml' && <Input size="small" className="mono" addonBefore="XPath" value={v.xpath} placeholder="/orders/order or //order" onChange={(e) => set({ xpath: e.target.value || undefined })} aria-label="XPath" />}
                {ext === 'csv' && <Input size="small" style={{ width: 160 }} addonBefore="Delimiter" value={v.delimiter} placeholder="," onChange={(e) => set({ delimiter: e.target.value || undefined })} aria-label="Delimiter" />}
            </>}
            {db && <>
                <Select size="small" style={{ width: '100%' }} value={v?.connection} placeholder="Connection" loading={!conns} aria-label="Connection" showSearch
                    options={(conns ?? []).map((c) => ({ value: c.alias, label: `${c.alias} · ${c.type} · ${c.database}` }))} onChange={(c) => set({ connection: c })} />
                {v?.kind === 'query'
                    ? <Input.TextArea className="mono" autoSize={{ minRows: 3, maxRows: 10 }} value={v.sql} placeholder="SELECT account_id, username FROM accounts WHERE status = ? AND region = '{config:REGION}'" onChange={(e) => set({ sql: e.target.value })} aria-label="Query" />
                    : <Input size="small" className="mono" value={v?.procedure} placeholder="schema.procedure_name" onChange={(e) => set({ procedure: e.target.value })} aria-label="Procedure" />}
                <Select size="small" mode="tags" style={{ width: '100%' }} value={v?.params ?? []} onChange={(p) => set({ params: p.length ? p : undefined })} aria-label="Parameters" open={false} tokenSeparators={['\n']}
                    placeholder={v?.kind === 'query' ? 'Values for the ? parameters, in order (Enter after each; {config:KEY}, {env:NAME}, null)' : 'Parameter values, in order (Enter after each)'} />
            </>}
            {v?.kind === 'api' && <>
                <Select size="small" style={{ width: '100%' }} value={v.collection} placeholder="Collection" showSearch aria-label="Data collection" onChange={(c) => set({ collection: c, request: undefined })}
                    options={(collections ?? []).filter((c) => c.project === project).map((c) => ({ value: c.file, label: c.name }))} />
                <Select size="small" style={{ width: '100%' }} value={v.request} placeholder="Request whose response holds the rows" showSearch aria-label="Data request" onChange={(r) => set({ request: r })}
                    options={requests.map((r) => ({ value: r.id, label: `${r.method} ${r.name}` }))} />
                <Input size="small" className="mono" addonBefore="Rows at" value={v.path} placeholder="$.data.items (the whole response when empty)" onChange={(e) => set({ path: e.target.value || undefined })} aria-label="Rows path" />
            </>}
            {v?.kind === 'generate' && <Input size="small" className="mono" value={v.generate} onChange={(e) => set({ generate: e.target.value })} aria-label="Generate"
                addonBefore={<Tooltip title="rows:column=type,… types: number, email, name, phone, uuid, date, string…">Rows</Tooltip>} />}
            {v && <div className="field-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                <Input size="small" className="mono" style={{ flex: '1 1 220px' }} value={v.filter} placeholder="Filter: status=active;amount>100 (| for OR)" onChange={(e) => set({ filter: e.target.value || undefined })} aria-label="Filter" />
                <InputNumber size="small" min={1} max={1000000} style={{ width: 110 }} value={v.limit} placeholder="All rows" onChange={(n) => set({ limit: n ?? undefined })} aria-label="Limit" />
                <Checkbox checked={!!v.randomize} onChange={(e) => set({ randomize: e.target.checked || undefined })}>Shuffle</Checkbox>
                <Button size="small" icon={<EyeOutlined />} loading={loading} onClick={() => void run()}>Preview</Button>
            </div>}
            {err && <Alert type="error" showIcon message={<pre className="db-error" style={{ margin: 0 }}>{err}</pre>} />}
            {preview && <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{preview.total.toLocaleString()} row{preview.total === 1 ? '' : 's'}{preview.readOnly ? ` · read only (${preview.readOnly})` : ''} · use </Typography.Text>
                {preview.columns.slice(0, 30).map((c) => <Tag key={c} bordered={false} className="mono" style={{ fontSize: 11 }}>{`{{${c}}}`}</Tag>)}
                <Table size="small" style={{ marginTop: 4 }} pagination={false} scroll={{ x: true, y: 220 }} rowKey={(_, i) => String(i)} dataSource={preview.rows.slice(0, 20)}
                    columns={preview.columns.slice(0, 30).map((c) => ({ title: c, dataIndex: c, key: c, ellipsis: true, width: 140 }))} />
            </div>}
        </Space>
    );
}
