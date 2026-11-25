/**
 * The API workspace's checks, saved values and test data: a value of the response (JSON path, XML
 * path, header, cookie, status, time, size, body) with an operator and an expected value (as written, a
 * saved value, a test data column, a setting, a database query), a JSON schema, each item of a list
 * against a database query, values saved for later requests, a data file the scenario runs over and
 * the defaults of its empty fields.
 */
import React from 'react';
import { Button, Checkbox, Dropdown, Input, InputNumber, Modal, Segmented, Select, Space, Table, Tag, Tooltip, Typography, Popover } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, DatabaseOutlined, DeleteOutlined, DownOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, ApiCheck, ApiCheckKind, ApiCompare, ApiData, ApiDbItemsRule, ApiExpected, ApiExtract, ApiOperator, ApiPrepare, ApiSendResult, ApiValueSource, DataPreview } from '../api';
import { errText } from '../state';

const SOURCES: Array<{ value: ApiValueSource; label: string; target?: string }> = [
    { value: 'json', label: 'JSON path', target: '$.items[0].id' },
    { value: 'xml', label: 'XML path', target: '/order/status' },
    { value: 'header', label: 'Header', target: 'Content-Type' },
    { value: 'cookie', label: 'Cookie', target: 'session' },
    { value: 'status', label: 'Status' },
    { value: 'time', label: 'Time (ms)' },
    { value: 'size', label: 'Size (bytes)' },
    { value: 'body', label: 'Body text' },
];
const OPS: Array<{ value: ApiOperator; label: string; noValue?: boolean }> = [
    { value: 'equals', label: 'is' }, { value: 'notEquals', label: 'is not' },
    { value: 'contains', label: 'contains' }, { value: 'notContains', label: 'does not contain' },
    { value: 'matches', label: 'matches (regex)' }, { value: 'oneOf', label: 'is one of (a, b)' },
    { value: 'greater', label: '>' }, { value: 'atLeast', label: '≥' }, { value: 'less', label: '<' }, { value: 'atMost', label: '≤' }, { value: 'between', label: 'is between' },
    { value: 'count', label: 'has … items' }, { value: 'type', label: 'is of type' },
    { value: 'exists', label: 'exists', noValue: true }, { value: 'notExists', label: 'does not exist', noValue: true },
    { value: 'empty', label: 'is empty', noValue: true }, { value: 'notEmpty', label: 'is not empty', noValue: true },
];
const COMPARES: Array<{ value: ApiCompare; label: string }> = [{ value: 'text', label: 'as text' }, { value: 'number', label: 'as numbers' }, { value: 'date', label: 'as dates (day)' }, { value: 'datetime', label: 'as moments' }];
const FROMS: Array<{ value: ApiExpected['from']; label: string; hint: string }> = [
    { value: 'text', label: 'Value', hint: 'as written ({{saved}} and <column> inside are filled too)' },
    { value: 'saved', label: 'Saved value', hint: 'a value saved by an earlier request ({{name}})' },
    { value: 'data', label: 'Test data', hint: 'a column of the scenario\'s test data row (<column>)' },
    { value: 'config', label: 'Setting', hint: 'a configuration key ({config:KEY})' },
    { value: 'query', label: 'Database', hint: 'the first row\'s column of a DB_QUERY_<name> of the project' },
];

/** The old check kinds (kept as they are). */
const SIMPLE: Array<{ value: ApiCheckKind; label: string; target?: string; val?: string }> = [
    { value: 'status', label: 'Status is', val: '200' },
    { value: 'statusBetween', label: 'Status between' },
    { value: 'jsonEquals', label: 'JSON value is', target: '$.id', val: 'value' },
    { value: 'jsonExists', label: 'JSON value exists', target: '$.id' },
    { value: 'jsonNotContains', label: 'JSON value does not contain', target: '$.name', val: 'text' },
    { value: 'bodyContains', label: 'Body contains', val: 'text' },
    { value: 'bodyNotContains', label: 'Body does not contain', val: 'text' },
    { value: 'bodyEmpty', label: 'Body is empty' },
    { value: 'headerExists', label: 'Header exists', target: 'Location' },
    { value: 'headerEquals', label: 'Header is', target: 'Content-Type', val: 'value' },
    { value: 'headerContains', label: 'Header contains', target: 'Content-Type', val: 'json' },
    { value: 'timeBelow', label: 'Time below (ms)', val: '1000' },
];

const mark = (r?: { pass: boolean }) => <span className="check-mark">{r ? (r.pass ? <CheckCircleFilled style={{ color: '#389e0d' }} /> : <CloseCircleFilled style={{ color: '#cf1322' }} />) : null}</span>;

/** An expected value: where it comes from and its value (a database query's settings for "Database"). */
function ExpectedInput({ e, onChange, columns, label }: { e: ApiExpected; onChange: (e: ApiExpected) => void; columns: string[]; label: string }) {
    const from = FROMS.find((f) => f.value === e.from)!;
    return (
        <Space.Compact>
            <Tooltip title={from.hint}><Select size="small" value={e.from} style={{ width: 112 }} onChange={(v) => onChange({ from: v, value: '' })} options={FROMS.map((f) => ({ value: f.value, label: f.label }))} aria-label={`${label}: from`} /></Tooltip>
            {e.from === 'query' ? <>
                <Input size="small" className="mono" style={{ width: 110 }} value={e.connection} placeholder="connection" onChange={(x) => onChange({ ...e, connection: x.target.value.replace(/[^\w]/g, '').toUpperCase() })} aria-label={`${label}: connection`} />
                <Input size="small" className="mono" style={{ width: 150 }} value={e.query} placeholder="query (DB_QUERY_…)" onChange={(x) => onChange({ ...e, query: x.target.value.replace(/^DB_QUERY_/i, '') })} aria-label={`${label}: query`} />
                <Input size="small" className="mono" style={{ width: 150 }} value={(e.params ?? []).join(' | ')} placeholder="parameters a | {{b}}" onChange={(x) => onChange({ ...e, params: x.target.value.split('|').map((p) => p.trim()) })} aria-label={`${label}: parameters`} />
                <Input size="small" className="mono" style={{ width: 110 }} value={e.column} placeholder="column" onChange={(x) => onChange({ ...e, column: x.target.value })} aria-label={`${label}: column`} />
            </> : e.from === 'data' && columns.length ? <Select size="small" showSearch style={{ width: 180 }} value={e.value || undefined} placeholder="column" onChange={(v) => onChange({ ...e, value: v })} options={columns.map((c) => ({ value: c, label: c }))} aria-label={label} />
                : <Input size="small" className="mono" style={{ width: 160 }} value={e.value} placeholder={e.from === 'saved' ? 'name' : e.from === 'config' ? 'KEY' : e.from === 'data' ? 'column' : 'value'} onChange={(x) => onChange({ ...e, value: x.target.value })} aria-label={label} />}
        </Space.Compact>
    );
}

function RuleRow({ c, onChange, columns }: { c: ApiCheck; onChange: (c: ApiCheck) => void; columns: string[] }) {
    const src = SOURCES.find((s) => s.value === (c.source ?? 'json'))!;
    const op = OPS.find((o) => o.value === (c.op ?? 'equals'))!;
    const exp = c.expected ?? { from: 'text', value: '' };
    // Status, time and size are numbers: no comparison options.
    const numeric = src.value === 'status' || src.value === 'time' || src.value === 'size';
    const valueLike = !numeric && !op.noValue && op.value !== 'type' && op.value !== 'count' && op.value !== 'matches' && op.value !== 'oneOf';
    return <>
        <Select size="small" value={src.value} style={{ width: 118 }} onChange={(v) => onChange({ ...c, source: v, target: SOURCES.find((s) => s.value === v)?.target ? c.target : undefined })} options={SOURCES.map((s) => ({ value: s.value, label: s.label }))} aria-label="Value of the response" />
        {src.target && <Input size="small" className="mono" style={{ width: 210 }} value={c.target} placeholder={src.target} onChange={(e) => onChange({ ...c, target: e.target.value })} aria-label="Path or name" />}
        <Select size="small" value={op.value} style={{ width: 132 }} onChange={(v) => onChange({ ...c, op: v, ...(OPS.find((o) => o.value === v)?.noValue ? { expected: undefined, expected2: undefined } : {}) })} options={OPS.map((o) => ({ value: o.value, label: o.label }))} aria-label="Operator" />
        {op.value === 'type'
            ? <Select size="small" style={{ width: 110 }} value={exp.value || undefined} placeholder="type" onChange={(v) => onChange({ ...c, expected: { from: 'text', value: v } })} options={['string', 'number', 'boolean', 'object', 'array', 'null'].map((t) => ({ value: t, label: t }))} aria-label="Type" />
            : !op.noValue && <ExpectedInput e={exp} columns={columns} label="Expected" onChange={(e) => onChange({ ...c, expected: e })} />}
        {op.value === 'between' && <><span>and</span><ExpectedInput e={c.expected2 ?? { from: 'text', value: '' }} columns={columns} label="Upper bound" onChange={(e) => onChange({ ...c, expected2: e })} /></>}
        {valueLike && <Select size="small" style={{ width: 128 }} value={c.compare ?? 'text'} onChange={(v) => onChange({ ...c, compare: v === 'text' ? undefined : v, ...(v !== 'number' ? { tolerance: undefined } : {}), ...(v !== 'text' ? { ignoreCase: undefined } : {}) })} options={COMPARES} aria-label="Compare" />}
        {valueLike && c.compare === 'number' && <Tooltip title="Tolerance: the largest difference allowed"><InputNumber size="small" style={{ width: 92 }} min={0} step={0.0001} value={c.tolerance ?? 0.0001} onChange={(v) => onChange({ ...c, tolerance: v ?? undefined })} aria-label="Tolerance" /></Tooltip>}
        {!numeric && (valueLike || op.value === 'contains' || op.value === 'matches' || op.value === 'oneOf') && (c.compare ?? 'text') === 'text' && <Checkbox checked={!!c.ignoreCase} onChange={(e) => onChange({ ...c, ignoreCase: e.target.checked || undefined })}>ignore case</Checkbox>}
    </>;
}

/** Each item of a list in the response against a database query run for it. */
function DbRuleModal({ rule, open, onClose, onSave }: { rule: ApiDbItemsRule | null; open: boolean; onClose: () => void; onSave: (r: ApiDbItemsRule) => void }) {
    const empty: ApiDbItemsRule = { title: 'item', items: '$.items', connection: '', query: '', params: [], rows: '', fields: [{ field: '', column: '', compare: 'text' }], count: true };
    const [r, setR] = React.useState<ApiDbItemsRule>(rule ?? empty);
    React.useEffect(() => { if (open) setR(rule ?? empty); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    const set = (p: Partial<ApiDbItemsRule>) => setR({ ...r, ...p });
    const row = (label: string, child: React.ReactNode, hint?: string) => <div className="check-row" style={{ alignItems: 'flex-start' }}><span style={{ width: 170, paddingTop: 2 }}>{label}</span><div style={{ flex: 1 }}>{child}{hint && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text></div>}</div></div>;
    const ok = r.items.trim() && r.connection.trim() && r.query.trim() && r.fields.some((f) => f.field.trim() && f.column.trim());
    return (
        <Modal open={open} width={900} title="Database check: each item of the response" okText="Done" okButtonProps={{ disabled: !ok }} onCancel={onClose}
            onOk={() => onSave({ ...r, title: r.title.trim() || 'item', fields: r.fields.filter((f) => f.field.trim() && f.column.trim()), whenNoRows: r.whenNoRows?.filter((w) => w.field.trim()), matchBy: r.matchBy?.field?.trim() && r.matchBy.column?.trim() ? r.matchBy : undefined, rows: r.rows?.trim() || undefined })}>
            <Space direction="vertical" style={{ width: '100%' }}>
                {row('Step', <Input addonBefore="each" addonAfter="should match the database" value={r.title} onChange={(e) => set({ title: e.target.value })} aria-label="Item name" />, 'The words of the step in the feature (e.g. "order").')}
                {row('Items', <Input className="mono" value={r.items} onChange={(e) => set({ items: e.target.value })} placeholder="$.orders" aria-label="Items" />, 'The list in the response: each of its items is checked.')}
                {row('Query', <Space.Compact style={{ width: '100%' }}>
                    <Input className="mono" style={{ width: 200 }} value={r.connection} onChange={(e) => set({ connection: e.target.value.replace(/[^\w]/g, '').toUpperCase() })} placeholder="connection" aria-label="Connection" />
                    <Input className="mono" value={r.query} onChange={(e) => set({ query: e.target.value.replace(/^DB_QUERY_/i, '') })} placeholder="query name" aria-label="Query name" />
                </Space.Compact>, 'A connection (DB_<NAME>_*) and a query (DB_QUERY_<name>) of the project.')}
                {row('Its SQL (if new)', <Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 6 }} value={r.sql} onChange={(e) => set({ sql: e.target.value })} placeholder="SELECT … WHERE code = ? AND day = ?" aria-label="SQL" />, 'Written to the project\'s queries file when the project has no such query yet.')}
                {row('Parameters', <Select mode="tags" style={{ width: '100%' }} value={r.params} onChange={(v) => set({ params: v })} placeholder="orderNo, orderDate" tokenSeparators={[',']} aria-label="Parameters" />, 'For each item, in order: a field of the item (orderNo), a saved value ({{name}}) or a text in quotes (\'WEB\').')}
                {row('Rows compared with', <Input className="mono" value={r.rows} onChange={(e) => set({ rows: e.target.value })} placeholder="lines (empty: the item itself)" aria-label="Rows field" />, 'The item\'s list compared with the query\'s rows (e.g. lines); empty: the item with the first row.')}
                {row('Match a row by', <Space.Compact>
                    <Input className="mono" style={{ width: 200 }} value={r.matchBy?.field} onChange={(e) => set({ matchBy: { field: e.target.value, column: r.matchBy?.column ?? '' } })} placeholder="field (shipDate)" aria-label="Match field" />
                    <Input className="mono" style={{ width: 200 }} value={r.matchBy?.column} onChange={(e) => set({ matchBy: { field: r.matchBy?.field ?? '', column: e.target.value } })} placeholder="column (SHIP_DT)" aria-label="Match column" />
                </Space.Compact>, 'Rows in any order: each element finds its row by this field (empty: in order).')}
                {row('', <Checkbox checked={!!r.count} onChange={(e) => set({ count: e.target.checked })}>The number of elements equals the number of rows</Checkbox>)}
                {row('Fields', <Table size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={[...r.fields, { field: '', column: '', compare: 'text' as ApiCompare }]}
                    columns={[
                        { title: 'Response field', render: (_: unknown, f, i) => <Input size="small" className="mono" value={f.field} placeholder="price" onChange={(e) => set({ fields: upd(r.fields, i, { ...f, field: e.target.value }) })} aria-label="Response field" /> },
                        { title: 'Column', render: (_: unknown, f, i) => <Input size="small" className="mono" value={f.column} placeholder="PRICE" onChange={(e) => set({ fields: upd(r.fields, i, { ...f, column: e.target.value }) })} aria-label="Column" /> },
                        { title: 'Compared', width: 150, render: (_: unknown, f, i) => <Select size="small" style={{ width: 140 }} value={f.compare} onChange={(v) => set({ fields: upd(r.fields, i, { ...f, compare: v }) })} options={COMPARES} aria-label="Compared" /> },
                        { title: 'Tolerance', width: 110, render: (_: unknown, f, i) => f.compare === 'number' ? <InputNumber size="small" min={0} step={0.0001} value={f.tolerance ?? 0.0001} onChange={(v) => set({ fields: upd(r.fields, i, { ...f, tolerance: v ?? undefined }) })} aria-label="Tolerance" /> : null },
                        { width: 40, render: (_: unknown, _f, i) => i < r.fields.length ? <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => set({ fields: r.fields.filter((_x, j) => j !== i) })} aria-label="Remove field" /> : null },
                    ]} />)}
                {row('When there are no rows', <Table size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={[...(r.whenNoRows ?? []), { field: '', value: '' }]}
                    columns={[
                        { title: 'Item field', render: (_: unknown, w, i) => <Input size="small" className="mono" value={w.field} placeholder="error.code" onChange={(e) => set({ whenNoRows: upd(r.whenNoRows ?? [], i, { ...w, field: e.target.value }) })} aria-label="No rows: field" /> },
                        { title: 'Should be', render: (_: unknown, w, i) => <Input size="small" className="mono" value={w.value} placeholder="204" onChange={(e) => set({ whenNoRows: upd(r.whenNoRows ?? [], i, { ...w, value: e.target.value }) })} aria-label="No rows: value" /> },
                        { width: 40, render: (_: unknown, _w, i) => i < (r.whenNoRows?.length ?? 0) ? <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => set({ whenNoRows: (r.whenNoRows ?? []).filter((_x, j) => j !== i) })} aria-label="Remove" /> : null },
                    ]} />, 'The error the API reports for an item the database has no rows for (none: no rows is a failure).')}
            </Space>
        </Modal>
    );
}

const upd = <T,>(list: T[], i: number, v: T): T[] => (i < list.length ? list.map((x, j) => (j === i ? v : x)) : [...list, v]);

/** The checks of a request: values of the response, a JSON schema, database checks, and the earlier kinds. */
export function ChecksEditor({ checks, results, onChange, columns = [] }: { checks: ApiCheck[]; results?: ApiSendResult['checks']; onChange: (c: ApiCheck[]) => void; columns?: string[] }) {
    const set = (i: number, c: ApiCheck) => onChange(checks.map((x, j) => (j === i ? c : x)));
    const [db, setDb] = React.useState<{ index: number } | null>(null);
    const add = (c: ApiCheck) => onChange([...checks, c]);
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            {checks.map((c, i) => {
                const r = results?.[i];
                const remove = <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onChange(checks.filter((_, j) => j !== i))} aria-label="Remove check" />;
                const got = r && !r.pass ? <Typography.Text type="danger" style={{ fontSize: 12, maxWidth: 420 }} ellipsis={{ tooltip: r.message }}>{r.message}</Typography.Text> : null;
                if (c.kind === 'rule') return <div key={i} className="check-row" style={{ flexWrap: 'wrap' }}>{mark(r)}<RuleRow c={c} columns={columns} onChange={(x) => set(i, x)} />{got}{remove}</div>;
                if (c.kind === 'schema') return (
                    <div key={i} className="check-row" style={{ alignItems: 'flex-start' }}>{mark(r)}
                        <Space direction="vertical" style={{ flex: 1 }}>
                            <Space><Typography.Text>The body matches the JSON schema</Typography.Text><Segmented size="small" value={c.schemaFile !== undefined ? 'file' : 'here'} onChange={(v) => set(i, v === 'file' ? { kind: 'schema', schemaFile: '' } : { kind: 'schema', schema: c.schema ?? '{\n  "type": "object",\n  "required": []\n}' })} options={[{ value: 'here', label: 'written here' }, { value: 'file', label: 'a file' }]} /></Space>
                            {c.schemaFile !== undefined
                                ? <Input size="small" className="mono" value={c.schemaFile} placeholder="test/<project>/schemas/order.json" onChange={(e) => set(i, { ...c, schemaFile: e.target.value })} aria-label="Schema file" />
                                : <Input.TextArea className="mono" autoSize={{ minRows: 4, maxRows: 14 }} value={c.schema} onChange={(e) => set(i, { ...c, schema: e.target.value })} aria-label="JSON schema"
                                    status={(() => { try { JSON.parse(c.schema ?? ''); return undefined; } catch { return 'error'; } })()} />}
                            {got}
                        </Space>{remove}
                    </div>);
                if (c.kind === 'dbItems') return (
                    <div key={i} className="check-row">{mark(r)}<DatabaseOutlined />
                        <Typography.Text>Each <b>{c.db?.title || 'item'}</b> of <Typography.Text code>{c.db?.items}</Typography.Text> matches <Typography.Text code>{c.db?.query}</Typography.Text> on {c.db?.connection || '?'}{c.db?.fields?.length ? ` (${c.db.fields.length} field${c.db.fields.length === 1 ? '' : 's'})` : ''}</Typography.Text>
                        <Button size="small" icon={<EditOutlined />} onClick={() => setDb({ index: i })}>Edit</Button>{got}{remove}
                    </div>);
                const def = SIMPLE.find((d) => d.value === c.kind)!;
                return (
                    <div key={i} className="check-row">{mark(r)}
                        <Select size="small" value={c.kind} style={{ width: 210 }} onChange={(k) => set(i, { kind: k })} options={SIMPLE.map((d) => ({ value: d.value, label: d.label }))} aria-label="Check" />
                        {def.target !== undefined && <Input size="small" className="mono" style={{ width: 200 }} value={c.target} placeholder={def.target} onChange={(e) => set(i, { ...c, target: e.target.value })} aria-label="JSON path or header" />}
                        {c.kind === 'statusBetween'
                            ? <><InputNumber size="small" min={100} max={599} value={c.min ?? 200} onChange={(v) => set(i, { ...c, min: v ?? 200 })} /> and <InputNumber size="small" min={100} max={599} value={c.max ?? 299} onChange={(v) => set(i, { ...c, max: v ?? 299 })} /></>
                            : def.val !== undefined && (() => {
                                // A status is a 3-digit code; a time a number of milliseconds ({{values}} are filled when sent).
                                const v = (c.value ?? '').trim();
                                const bad = !/\{\{/.test(v) && (c.kind === 'status' ? !/^\d{3}$/.test(v) || Number(v) < 100 || Number(v) > 599 : c.kind === 'timeBelow' ? !/^\d+(\.\d+)?$/.test(v) : false);
                                return <Tooltip open={bad ? undefined : false} title={c.kind === 'status' ? 'A status code: 3 digits, 100–599' : 'A number of milliseconds'}>
                                    <Input size="small" className="mono" style={{ width: 200 }} value={c.value} placeholder={def.val} status={bad ? 'error' : undefined} onChange={(e) => set(i, { ...c, value: e.target.value })} aria-label="Expected value" />
                                </Tooltip>;
                            })()}
                        {got}{remove}
                    </div>);
            })}
            <Space wrap>
                <Button size="small" icon={<PlusOutlined />} onClick={() => add({ kind: 'rule', source: 'json', target: '', op: 'equals', expected: { from: 'text', value: '' } })}>Check a value</Button>
                <Button size="small" icon={<PlusOutlined />} onClick={() => add({ kind: 'schema', schema: '{\n  "type": "object",\n  "required": []\n}' })}>JSON schema</Button>
                <Button size="small" icon={<DatabaseOutlined />} onClick={() => setDb({ index: -1 })}>Each item against the database…</Button>
                <Dropdown menu={{ items: SIMPLE.map((d) => ({ key: d.value, label: d.label })), onClick: ({ key }) => { const d = SIMPLE.find((x) => x.value === key)!; add({ kind: d.value, ...(d.value === 'status' ? { value: '200' } : {}), ...(d.value === 'statusBetween' ? { min: 200, max: 299 } : {}) }); } }}>
                    <Button size="small">Quick checks <DownOutlined /></Button>
                </Dropdown>
            </Space>
            <Tooltip title="Checks the framework's own steps do are written with them; the others with the project's response steps (written with the test).">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Paths: <span className="mono">$.items[0].id</span>, <span className="mono">$.items[*].id</span>, <span className="mono">{"$.items[?(@.sku=='A1')].qty"}</span>; XML <span className="mono">/order/status</span>, <span className="mono">/order/@id</span></Typography.Text>
            </Tooltip>
            <DbRuleModal open={!!db} rule={db && db.index >= 0 ? checks[db.index]?.db ?? null : null} onClose={() => setDb(null)}
                onSave={(rule) => { if (db && db.index >= 0) set(db.index, { kind: 'dbItems', db: rule }); else add({ kind: 'dbItems', db: rule }); setDb(null); }} />
        </Space>
    );
}

const EXTRACT: Array<{ value: ApiExtract['from']; label: string; placeholder?: string }> = [
    { value: 'json', label: 'JSON path', placeholder: "$.id   $.items[?(@.name=='x')].id" },
    { value: 'header', label: 'Header', placeholder: 'Location' },
    { value: 'cookie', label: 'Cookie', placeholder: 'session' },
    { value: 'xml', label: 'XML path', placeholder: '/order/@id' },
    { value: 'regex', label: 'Text match', placeholder: '"orderNo":"(SO-\\d+)"' },
    { value: 'status', label: 'Status' },
    { value: 'body', label: 'Whole body' },
];

/** Values saved from the response for the next requests and checks ({{name}}). */
export function ExtractEditor({ rules, results, onChange }: { rules: ApiExtract[]; results?: ApiSendResult['extracted']; onChange: (r: ApiExtract[]) => void }) {
    const set = (i: number, x: ApiExtract) => onChange(rules.map((r, j) => (j === i ? x : r)));
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <Tooltip title="An id, a token, a number the next request needs. A text match saves its first group (in brackets)."><Typography.Text type="secondary" style={{ fontSize: 12 }}>Save a value of the response; later requests and checks use it as <Typography.Text code>{'{{name}}'}</Typography.Text>.</Typography.Text></Tooltip>
            {rules.map((r, i) => {
                const res = results?.find((x) => x.variable === r.variable);
                const def = EXTRACT.find((e) => e.value === r.from) ?? EXTRACT[0];
                return (
                    <div key={i} className="check-row">
                        <Select size="small" value={r.from} style={{ width: 120 }} onChange={(v) => set(i, { ...r, from: v })} options={EXTRACT.map((e) => ({ value: e.value, label: e.label }))} aria-label="From" />
                        {def.placeholder && <Input size="small" className="mono" style={{ width: 260 }} value={r.path} placeholder={def.placeholder} onChange={(e) => set(i, { ...r, path: e.target.value })} aria-label="Path or name" />}
                        {r.from === 'regex' && <BoundaryButton onPick={(re) => set(i, { ...r, path: re })} />}
                        <span>as</span>
                        <Input size="small" className="mono" style={{ width: 160 }} value={r.variable} placeholder="name" onChange={(e) => set(i, { ...r, variable: e.target.value.replace(/[^\w.-]/g, '') })} aria-label="Variable name" />
                        {res && (res.found ? <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: res.value }}>= {res.value}</Typography.Text> : <Typography.Text type="danger" style={{ fontSize: 12 }}>not found</Typography.Text>)}
                        <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onChange(rules.filter((_, j) => j !== i))} aria-label="Remove" />
                    </div>
                );
            })}
            <Button size="small" icon={<PlusOutlined />} onClick={() => onChange([...rules, { from: 'json', path: '', variable: '' }])}>Save a value</Button>
        </Space>
    );
}

const WHEN_EMPTY: Array<{ value: ApiPrepare['whenEmpty']; label: string }> = [
    { value: 'query', label: 'a database query' }, { value: 'today', label: 'today' }, { value: 'previousBusinessDay', label: 'the previous business day' }, { value: 'text', label: 'a value' },
];

/**
 * The request's test data: a data file of the project its scenario runs over (one run per row, the
 * rows a filter keeps), a row to send with now, and the defaults of fields a row leaves empty.
 */
export function TestDataEditor({ project, env, data, prepare, onChange, row, onRow, onColumns }: {
    project: string; env?: string; data?: ApiData; prepare?: ApiPrepare[];
    onChange: (p: { data?: ApiData; prepare?: ApiPrepare[] }) => void;
    row: number; onRow: (index: number, row: Record<string, string> | undefined) => void; onColumns: (c: string[]) => void;
}) {
    const [rows, setRows] = React.useState<DataPreview | null>(null);
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const d = data ?? { source: '', type: 'json' as const, filter: 'runFlag=Yes' };
    const setData = (p: Partial<ApiData>) => onChange({ data: { ...d, ...p }, prepare });
    const list = prepare ?? [];
    const setPrep = (i: number, p: ApiPrepare) => onChange({ data, prepare: upd(list, i, p) });
    const load = React.useCallback(async () => {
        if (!d.source.trim()) return;
        setLoading(true); setError('');
        try {
            const r = await api.dataPreview(project, env, { kind: 'file', file: d.source.trim(), sheet: d.sheet, path: d.type === 'json' ? d.path || '$' : undefined, filter: d.filter });
            setRows(r); onColumns(r.columns);
            onRow(0, r.rows[0]);
        } catch (e) { setError(errText(e)); setRows(null); }
        finally { setLoading(false); }
    }, [project, env, d.source, d.sheet, d.path, d.type, d.filter]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (data?.source) void load(); }, [data?.source]); // eslint-disable-line react-hooks/exhaustive-deps
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <Tooltip title={<>A Scenario Outline whose Examples read the file. Use {'<column>'} in the URL, headers, body and checks; a payload template file reads {'{{column}}'}.</>}><Typography.Text type="secondary" style={{ fontSize: 12 }}>The test runs once per row of a data file.</Typography.Text></Tooltip>
            <div className="check-row">
                <Input size="small" className="mono" style={{ width: 360 }} value={d.source} placeholder={`test/${project}/data/….json`} onChange={(e) => setData({ source: e.target.value })} aria-label="Data file" />
                <Select size="small" style={{ width: 90 }} value={d.type} onChange={(v) => setData({ type: v })} options={[{ value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }, { value: 'excel', label: 'Excel' }]} aria-label="Data type" />
                {d.type === 'excel' && <Input size="small" style={{ width: 120 }} value={d.sheet} placeholder="sheet" onChange={(e) => setData({ sheet: e.target.value })} aria-label="Sheet" />}
                {d.type === 'json' && <Input size="small" className="mono" style={{ width: 110 }} value={d.path} placeholder="$" onChange={(e) => setData({ path: e.target.value })} aria-label="Rows path" />}
                <Tooltip title="Rows to run: column=value; several separated by ; (runFlag=Yes)"><Input size="small" className="mono" style={{ width: 160 }} value={d.filter} placeholder="runFlag=Yes" onChange={(e) => setData({ filter: e.target.value })} aria-label="Filter" /></Tooltip>
                <Button size="small" icon={<ReloadOutlined />} loading={loading} disabled={!d.source.trim()} onClick={() => void load()}>Rows</Button>
                {data && <Button size="small" type="text" danger onClick={() => { onChange({ data: undefined, prepare }); setRows(null); onColumns([]); onRow(-1, undefined); }}>No data file</Button>}
            </div>
            {error && <Typography.Text type="danger">{error}</Typography.Text>}
            {rows && <Table size="small" pagination={false} scroll={{ x: true, y: 200 }} rowKey={(_, i) => String(i)} dataSource={rows.rows}
                rowSelection={{ type: 'radio', selectedRowKeys: [String(row)], onChange: (keys) => { const i = Number(keys[0]); onRow(i, rows.rows[i]); }, columnTitle: <Tooltip title="The row Send uses"><span>Send</span></Tooltip> }}
                columns={rows.columns.map((c) => ({ title: c, dataIndex: c, ellipsis: true, width: 140, render: (v: string) => <span className="mono">{v}</span> }))} />}
            <Typography.Text strong style={{ marginTop: 8 }}>When a row leaves a field empty</Typography.Text>
            {list.map((p, i) => (
                <div key={i} className="check-row" style={{ flexWrap: 'wrap' }}>
                    <Input size="small" className="mono" style={{ width: 150 }} value={p.name} placeholder="field" onChange={(e) => setPrep(i, { ...p, name: e.target.value.replace(/[^\w.-]/g, '') })} aria-label="Field" />
                    <span>takes</span>
                    <Select size="small" style={{ width: 190 }} value={p.whenEmpty} onChange={(v) => setPrep(i, { name: p.name, whenEmpty: v })} options={WHEN_EMPTY} aria-label="Default" />
                    {(p.whenEmpty === 'today' || p.whenEmpty === 'previousBusinessDay') && <Input size="small" className="mono" style={{ width: 120 }} value={p.format} placeholder="YYYY-MM-DD" onChange={(e) => setPrep(i, { ...p, format: e.target.value })} aria-label="Date format" />}
                    {p.whenEmpty === 'text' && <Input size="small" className="mono" style={{ width: 200 }} value={p.value} placeholder="value" onChange={(e) => setPrep(i, { ...p, value: e.target.value })} aria-label="Value" />}
                    {p.whenEmpty === 'query' && <Space.Compact>
                        <Input size="small" className="mono" style={{ width: 110 }} value={p.connection} placeholder="connection" onChange={(e) => setPrep(i, { ...p, connection: e.target.value.replace(/[^\w]/g, '').toUpperCase() })} aria-label="Connection" />
                        <Input size="small" className="mono" style={{ width: 170 }} value={p.query} placeholder="query (DB_QUERY_…)" onChange={(e) => setPrep(i, { ...p, query: e.target.value.replace(/^DB_QUERY_/i, '') })} aria-label="Query" />
                        <Input size="small" className="mono" style={{ width: 110 }} value={p.column} placeholder="column" onChange={(e) => setPrep(i, { ...p, column: e.target.value })} aria-label="Column" />
                    </Space.Compact>}
                    {p.whenEmpty === 'query' && <Checkbox checked={!!p.list} onChange={(e) => setPrep(i, { ...p, list: e.target.checked || undefined })}>every row (a list)</Checkbox>}
                    <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onChange({ data, prepare: list.filter((_, j) => j !== i) })} aria-label="Remove" />
                </div>
            ))}
            <Button size="small" icon={<PlusOutlined />} onClick={() => onChange({ data, prepare: [...list, { name: '', whenEmpty: 'today', format: 'YYYY-MM-DD' }] })}>Default for an empty field</Button>
            {list.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Written as a step of the test (<Typography.Text code>user prepares the … request data</Typography.Text>) with its code in the project.</Typography.Text>}
            {rows && <Tag>{rows.total} row{rows.total === 1 ? '' : 's'}{d.filter ? ` (${d.filter})` : ''}</Tag>}
        </Space>
    );
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A regular expression from the text just before and just after the value (left / right boundaries). */
function BoundaryButton({ onPick }: { onPick: (re: string) => void }) {
    const [open, setOpen] = React.useState(false);
    const [left, setLeft] = React.useState('');
    const [right, setRight] = React.useState('');
    return (
        <Popover open={open} onOpenChange={setOpen} trigger="click" title="The value between two texts" content={<Space direction="vertical" style={{ width: 320 }}>
            <Input size="small" className="mono" value={left} onChange={(e) => setLeft(e.target.value)} placeholder='Text before, e.g. name="token" value="' aria-label="Left boundary" />
            <Input size="small" className="mono" value={right} onChange={(e) => setRight(e.target.value)} placeholder='Text after, e.g. "' aria-label="Right boundary" />
            <Button size="small" type="primary" disabled={!left} onClick={() => { onPick(`${escRe(left)}([\\s\\S]*?)${right ? escRe(right) : '$'}`); setOpen(false); }}>Use</Button>
        </Space>}><Button size="small">Between…</Button></Popover>
    );
}
