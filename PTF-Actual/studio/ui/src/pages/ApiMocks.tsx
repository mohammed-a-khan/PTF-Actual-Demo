/**
 * API → Mocks: services that answer like the real API, made from its OpenAPI document and kept with the tests
 * (test/<project>/mocks/<name>.mock.json). Each route's answer (status, body, delay) and a fault to test how the
 * application copes (a slow answer, an error, a dropped connection, a body that does not parse), on every request or a
 * share of them. Started here on this computer, or in a test ("the API mock … is running").
 */
import React from 'react';
import { Alert, App, Button, Col, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Segmented, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CaretRightOutlined, CopyOutlined, DeleteOutlined, PlusOutlined, SaveOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons';
import { api, ApiCollectionInfo, MockDef, MockFaultKind, MockInfo, MockLogEntryDef, MockRouteDef } from '../api';
import { useUnsaved } from '../unsaved';
import { errText } from '../state';
import { useRoute } from '../route';
import { Split } from '../components/Split';
import { SectionTitle, shownTab, useRememberedTab } from '../apiperf-ui';

const FAULTS: Array<{ value: MockFaultKind; label: string; help: string }> = [
    { value: 'none', label: 'None', help: 'Answers as set' },
    { value: 'delay', label: 'Slow', help: 'Waits before answering' },
    { value: 'error', label: 'Error', help: 'Answers an error status' },
    { value: 'drop', label: 'Drop', help: 'Closes the connection without an answer' },
    { value: 'malformed', label: 'Malformed', help: 'Answers half of the body (it does not parse)' },
];
const METHOD_COLOR: Record<string, string> = { GET: 'green', POST: 'blue', PUT: 'orange', PATCH: 'gold', DELETE: 'red' };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'api';

export function ApiMocks() {
    const { message, modal } = App.useApp();
    const [tab, setTab] = useRememberedTab('api-mocks', 'routes');
    const here = useRoute()[0] === 'api-mocks';
    const [projects, setProjects] = React.useState<string[]>([]);
    const [project, setProject] = React.useState('');
    const [list, setList] = React.useState<MockInfo[] | null>(null);
    const [cur, setCur] = React.useState<{ file: string; mock: MockDef; dirty: boolean } | null>(null);
    useUnsaved('api-mock', !!cur?.dirty, 'a mock', { lostOnLeave: true });
    const [url, setUrl] = React.useState<string | null>(null);
    const [log, setLog] = React.useState<MockLogEntryDef[]>([]);
    const [port, setPort] = React.useState<number | null>(null);
    const [creating, setCreating] = React.useState<{ text: string; name: string; from?: 'openapi' | 'collection' | 'record'; collection?: string; target?: string } | null>(null);
    const [collections, setCollections] = React.useState<ApiCollectionInfo[]>([]);
    const [recording, setRecording] = React.useState<{ url: string; target: string; count: number } | null>(null);
    const [editAnswers, setEditAnswers] = React.useState<{ i: number; text: string; error?: string } | null>(null);
    React.useEffect(() => { if (creating?.from === 'collection') void api.apiCollections().then((r) => setCollections(r.collections.filter((c) => c.project === project))).catch(() => undefined); }, [creating?.from, project]);
    // While recording: how many answers were kept.
    React.useEffect(() => {
        if (!recording) return;
        const t = setInterval(() => { void api.mockRecordStatus().then((r) => setRecording((x) => (x && r.url ? { ...x, count: r.count ?? 0 } : x))).catch(() => undefined); }, 1500);
        return () => clearInterval(t);
    }, [recording?.url]); // eslint-disable-line react-hooks/exhaustive-deps
    const [editBody, setEditBody] = React.useState<{ i: number; text: string } | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const [createErr, setCreateErr] = React.useState<string | null>(null);

    React.useEffect(() => { if (here) api.apiCollections().then((r) => { setProjects(r.projects); setProject((p) => p || r.projects[0] || ''); }).catch((e) => setErr(errText(e))); }, [here]);
    const refresh = React.useCallback(() => { if (project) api.mocks(project).then((r) => setList(r.mocks)).catch((e) => setErr(errText(e))); }, [project]);
    React.useEffect(() => { setCur(null); setList(null); refresh(); }, [project, refresh]);
    // The running mock's requests, live.
    React.useEffect(() => {
        if (!cur || !url) return;
        let stop = false;
        const tick = () => api.mockLog(project, cur.file).then((r) => { if (stop) return; setLog(r.log); if (!r.running) setUrl(null); }).catch(() => {}).finally(() => { if (!stop) setTimeout(tick, 1000); });
        void tick();
        return () => { stop = true; };
    }, [cur?.file, url, project]); // eslint-disable-line react-hooks/exhaustive-deps

    const open = (m: MockInfo) => {
        const go = () => api.mockGet(project, m.file).then((r) => { setCur({ file: r.file, mock: r.mock, dirty: false }); setUrl(r.url ?? null); setLog([]); setPort(r.mock.port ? r.mock.port : null); setErr(null); }).catch((e) => setErr(errText(e)));
        if (cur?.file === m.file) return;
        leave(() => void go());
    };
    const route = (i: number, patch: Partial<MockRouteDef>) => cur && setCur({ ...cur, dirty: true, mock: { ...cur.mock, routes: cur.mock.routes.map((r, j) => (j === i ? { ...r, ...patch } : r)) } });
    const fault = (i: number, patch: Partial<NonNullable<MockRouteDef['fault']>>) => cur && route(i, { fault: { kind: 'none', ...(cur.mock.routes[i].fault ?? {}), ...patch } });
    const saving = React.useRef(false);
    const save = async () => {
        if (!cur || saving.current) return false;
        saving.current = true;
        try { return await saveNow(); } finally { saving.current = false; }
    };
    const saveNow = async () => {
        if (!cur) return false;
        setBusy(true);
        setErr(null);
        try { const r = await api.mockSave(project, cur.file, { ...cur.mock, ...(port !== null ? { port } : {}) }); setCur({ ...cur, dirty: false }); refresh(); if (r.restartForPort) message.warning('Saved. The running mock answers with the changes now; stop and start it to use the new port.'); else message.success(r.applied ? 'Saved: the running mock answers with the changes now' : 'Saved'); return true; }
        catch (e) { setErr(errText(e)); return false; } finally { setBusy(false); }
    };
    const start = async () => {
        if (!cur) return;
        if (cur.dirty && !(await save())) return;
        setBusy(true); setErr(null);
        try { const r = await api.mockStart(project, cur.file, port ?? undefined); setUrl(r.url); setLog([]); refresh(); }
        catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };
    const stop = async () => { if (cur) { await api.mockStop(project, cur.file).catch(() => {}); setUrl(null); refresh(); } };
    const create = async () => {
        if (!creating) return;
        setCreateErr(null);
        const taken = (n: string) => list?.some((x) => x.file === `test/${project}/mocks/${slug(n)}.mock.json` || x.name.trim().toLowerCase() === n.trim().toLowerCase());
        // A name the person typed that is in use: said here, before anything is made (a recording is not lost).
        if (creating.name.trim() && taken(creating.name.trim())) { setCreateErr(`A mock named "${creating.name.trim()}" exists: choose another name.`); return; }
        setBusy(true);
        try {
            const from = creating.from ?? 'openapi';
            if (from === 'record' && !recording) {
                const r0 = await api.mockRecordStart(creating.target ?? '');
                setRecording({ url: r0.url, target: r0.target, count: 0 });
                return;
            }
            const r = from === 'collection' ? await api.mockFromCollection(creating.collection ?? '', creating.name.trim() || undefined)
                : from === 'record' ? await api.mockRecordStop(creating.name.trim() || undefined)
                    : await api.mockFromOpenApi({ text: creating.text, name: creating.name.trim() || undefined });
            if (from === 'record') setRecording(null);
            // A name from the document in use: the next free one ("Pets 2").
            let name = creating.name.trim() || r.mock.name;
            for (let n = 2; taken(name) && n < 1000; n++) name = `${creating.name.trim() || r.mock.name} ${n}`;
            const file = `test/${project}/mocks/${slug(name)}.mock.json`;
            r.mock.name = name;
            await api.mockSave(project, file, r.mock);
            for (const w of r.warnings) message.warning(w);
            setCreating(null); refresh();
            setCur({ file, mock: r.mock, dirty: false }); setUrl(null); setLog([]); setPort(r.mock.port ? r.mock.port : null);
        } catch (e) { setCreateErr(errText(e)); } finally { setBusy(false); }
    };

    /** Save, Discard or Stay before the open mock is left (Escape and the close button stay). */
    function leave(then: () => void) {
        if (!cur?.dirty) { then(); return; }
        const inst = modal.confirm({ title: `Save the changes to "${cur.mock.name || 'the mock'}"?`, okText: 'Save', closable: true, onOk: async () => { if (await save()) then(); },
            footer: (_: React.ReactNode, { OkBtn }: { OkBtn: React.FC }) => <><Button onClick={() => inst.destroy()}>Stay</Button><Button danger onClick={() => { inst.destroy(); setCur(null); setUrl(null); setLog([]); then(); }}>Discard</Button><OkBtn /></> });
    }
    const m = cur?.mock;
    const fileBase = cur ? cur.file.split('/').pop()!.replace(/\.mock\.json$/, '') : '';
    const routeLabel = (r: MockRouteDef) => <span><Tag bordered={false} color={METHOD_COLOR[r.method] ?? 'default'} style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{r.method}</Tag><span className="mono" style={{ fontSize: 12, wordBreak: 'break-word' }}>{r.path}</span></span>;
    return (<>
        <Split id="api-mocks" initial={300} min={240} max={460} style={{ height: 'calc(100vh - var(--chrome))' }}>
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="toolbar">
                    <Select size="small" style={{ flex: 1 }} value={project || undefined} onChange={(p) => leave(() => setProject(p))} options={projects.map((p) => ({ value: p, label: p }))} placeholder="Project" aria-label="Project" />
                    <Button size="small" type="primary" icon={<PlusOutlined />} disabled={!project} onClick={() => leave(() => setCreating({ text: '', name: '' }))}>New</Button>
                </div>
                <div style={{ flex: 1, overflow: 'auto' }}>
                    {list && !list.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description={<span>No mocks yet.<br />New makes one from an OpenAPI document.</span>} />}
                    {(list ?? []).map((x) => (
                        <div key={x.file} className={`item-row${cur?.file === x.file ? ' selected' : ''}`} onClick={() => open(x)}>
                            <div className="item-title"><span className="t">{x.name}</span>{x.url && <Tag color="green" bordered={false} style={{ marginInlineEnd: 0 }}>running</Tag>}</div>
                            <div className="item-meta">{x.routes} route{x.routes === 1 ? '' : 's'} · {x.file.split('/').pop()}{x.problems.length ? <Typography.Text type="danger"> · {x.problems[0]}</Typography.Text> : null}</div>
                        </div>))}
                </div>
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {err && <Alert type="error" showIcon closable onClose={() => setErr(null)} message={err} style={{ margin: 8 }} />}
                {!m || !cur ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="Choose a mock, or make one from an OpenAPI document" /> : <>
                    <div className="toolbar ap-toolbar-wrap">
                        <Input size="small" style={{ width: 220 }} status={m.name.trim() ? undefined : "error"} placeholder="Name (required)" value={m.name} maxLength={200} onChange={(e) => setCur({ ...cur, dirty: true, mock: { ...m, name: e.target.value } })} aria-label="Mock name" />
                        {cur.dirty && <span className="dirty-dot" title="Not saved" />}
                        <Button size="small" icon={<SaveOutlined />} type={cur.dirty ? 'primary' : 'default'} loading={busy} disabled={!cur.dirty} onClick={() => void save()}>Save</Button>
                        {url ? <Button size="small" danger icon={<StopOutlined />} onClick={() => void stop()}>Stop</Button>
                            : <Button size="small" type="primary" icon={<CaretRightOutlined />} loading={busy} onClick={() => void start()}>Start</Button>}
                        {url && <Space size={4}><Tag color="green" bordered={false} className="mono">{url}</Tag><Button size="small" type="text" icon={<CopyOutlined />} aria-label="Copy the URL" onClick={() => void navigator.clipboard?.writeText(url).then(() => message.success('Copied'))} /></Space>}
                        <span style={{ flex: 1 }} />
                        <Popconfirm title={`Delete ${cur.file}?`} okText="Delete" okButtonProps={{ danger: true }} onConfirm={async () => { try { await api.mockDelete(project, cur.file); setCur(null); setUrl(null); refresh(); } catch (e) { setErr(errText(e)); } }}>
                            <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Delete the mock" /></Popconfirm>
                    </div>
                    <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 10px' }}>
                        <Tabs size="small" className="ap-tabs" activeKey={shownTab(tab, ['routes', 'faults', 'log', 'settings'])} onChange={setTab} items={[
                            { key: 'routes', label: <span>Routes <Tag bordered={false}>{m.routes.length}</Tag></span>, children: <>
                                <Typography.Text type="secondary" className="ap-note" style={{ marginBottom: 6 }}>A body can answer with the request's values: {'{{path.id}}'}, {'{{query.name}}'}, {'{{body.field}}'}.</Typography.Text>
                                <Table<MockRouteDef> size="small" tableLayout="fixed" pagination={false} rowKey={(_r, i) => String(i)} dataSource={m.routes}
                                    columns={[
                                        { title: 'On', width: 56, render: (_v, r, i) => <Switch size="small" checked={r.enabled !== false} onChange={(on) => route(i, { enabled: on })} aria-label={`Serve ${r.method} ${r.path}`} /> },
                                        { title: 'Route', ellipsis: true, render: (_v, r) => <span title={`${r.method.toUpperCase()} ${r.path}`}>{routeLabel(r)}</span> },
                                        { title: 'Status', width: 90, render: (_v, r, i) => <InputNumber size="small" min={100} max={599} style={{ width: 76 }} value={r.status} onChange={(v) => route(i, { status: Number(v ?? 200) })} aria-label={`Status of ${r.method} ${r.path}`} /> },
                                        { title: 'Body', width: 96, render: (_v, r, i) => <Button size="small" onClick={() => setEditBody({ i, text: r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2) })}>{r.body === undefined ? 'None' : 'Edit'}</Button> },
                                        { title: <Tooltip title="Other answers chosen by query, headers or body; or answers in turn (stateful)">Answers</Tooltip>, width: 130, render: (_v, r, i) => <Button size="small" onClick={() => setEditAnswers({ i, text: JSON.stringify({ sequence: !!r.sequence, responses: r.responses ?? [] }, null, 2) })}>{r.responses?.length ? `${r.responses.length} more${r.sequence ? ' · in turn' : ''}` : 'Add'}</Button> },
                                    ]} />
                            </> },
                            { key: 'faults', label: <span>Delays &amp; faults{m.routes.some((r) => (r.fault && r.fault.kind !== 'none') || r.delayMs) ? <Tag bordered={false} color="orange" style={{ marginInlineStart: 4 }}>{m.routes.filter((r) => (r.fault && r.fault.kind !== 'none') || r.delayMs).length}</Tag> : null}</span>, children: <>
                                <Typography.Text type="secondary" className="ap-note" style={{ marginBottom: 6 }}>Test how the application copes: a slow answer, an error, a dropped connection, a body that does not parse.</Typography.Text>
                                <Table<MockRouteDef> size="small" tableLayout="fixed" pagination={false} rowKey={(_r, i) => String(i)} dataSource={m.routes}
                                    columns={[
                                        { title: 'Route', ellipsis: true, render: (_v, r) => <span title={`${r.method.toUpperCase()} ${r.path}`}>{routeLabel(r)}</span> },
                                        { title: <Tooltip title="Wait before every answer (ms)">Delay</Tooltip>, width: 110, render: (_v, r, i) => <InputNumber size="small" min={0} max={300000} step={100} style={{ width: 96 }} value={r.delayMs ?? 0} onChange={(v) => route(i, { delayMs: Number(v ?? 0) })} aria-label={`Delay of ${r.method} ${r.path}`} /> },
                                        { title: 'Fault', width: 230, render: (_v, r, i) => {
                                            const f = r.fault ?? { kind: 'none' as MockFaultKind };
                                            return <Space size={4} wrap>
                                                <Select size="small" style={{ width: 110 }} value={f.kind} onChange={(k: MockFaultKind) => fault(i, { kind: k })} aria-label={`Fault of ${r.method} ${r.path}`}
                                                    options={FAULTS.map((x) => ({ value: x.value, label: <Tooltip title={x.help} placement="left">{x.label}</Tooltip> }))} />
                                                {f.kind !== 'none' && <Tooltip title="The share of requests it applies to"><InputNumber size="small" min={0} max={100} style={{ width: 76 }} value={f.rate ?? 100} formatter={(v) => `${v}%`} parser={(v) => Number(String(v).replace('%', ''))} onChange={(v) => fault(i, { rate: Number(v ?? 100) })} aria-label="Share of requests" /></Tooltip>}
                                                {f.kind === 'error' && <Tooltip title="Error status"><InputNumber size="small" min={400} max={599} style={{ width: 70 }} value={f.status ?? 503} onChange={(v) => fault(i, { status: Number(v ?? 503) })} aria-label="Error status" /></Tooltip>}
                                                {f.kind === 'delay' && <InputNumber size="small" min={1} max={300000} step={500} style={{ width: 100 }} value={f.delayMs ?? 3000} formatter={(v) => `${v} ms`} parser={(v) => Number(String(v).replace(/\D/g, ''))} onChange={(v) => fault(i, { delayMs: Number(v ?? 3000) })} aria-label="Fault delay" />}
                                            </Space>;
                                        } },
                                    ]} />
                            </> },
                            { key: 'log', label: <span>Requests{url ? <Tag bordered={false} color="green" style={{ marginInlineStart: 4 }}>{log.length}</Tag> : null}</span>, children: !url
                                ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Start the mock: the requests it receives appear here." />
                                : !log.length ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>Send requests to {url}: they appear here.</Typography.Text>
                                    : <Table<MockLogEntryDef> size="small" pagination={false} rowKey={(e, i) => `${e.at}-${i}`} dataSource={[...log].reverse()}
                                        columns={[
                                            { title: 'When', dataIndex: 'at', width: 100, render: (v: string) => new Date(v).toLocaleTimeString() },
                                            { title: 'Request', render: (_v, e) => <span className="mono" style={{ fontSize: 12 }}>{e.method} {e.path}</span> },
                                            { title: 'Answer', width: 150, render: (_v, e) => <Space size={4}><Tag bordered={false} color={e.status === 0 ? 'red' : e.status < 400 ? 'success' : 'error'}>{e.status || 'dropped'}</Tag>{e.fault && <Tag bordered={false} color="orange">{e.fault}</Tag>}</Space> },
                                            { title: 'Time', dataIndex: 'ms', width: 80, align: 'right', render: (v: number) => `${v} ms` },
                                        ]} /> },
                            { key: 'settings', label: 'Settings', children: <Form layout="vertical" size="small" className="ap-form" style={{ maxWidth: 720 }}>
                                <Row gutter={16}>
                                    <Col xs={24} md={12}><Form.Item label="Port" tooltip="The port it listens on (empty: any free port)"><InputNumber min={0} max={65535} placeholder="any free port" value={port ?? undefined} onChange={(v) => { setPort(v === null || v === undefined ? null : Number(v)); setCur({ ...cur, dirty: true }); }} aria-label="Port" /></Form.Item></Col>
                                    <Col xs={24} md={12}><Form.Item label="File"><Input readOnly className="mono" value={cur.file} aria-label="Mock file" /></Form.Item></Col>
                                </Row>
                                <SectionTitle help="Start the mock from a feature file; the base URL step points the API steps at it.">Use it in a test</SectionTitle>
                                <pre className="code-box" style={{ margin: 0 }}>{`Given the API mock "${fileBase}" is running
And the API base URL is "{{mockUrl}}"`}</pre>
                            </Form> },
                        ]} />
                    </div>
                </>}
            </div>
        </Split>
            <Modal open={!!creating} title="New mock" width={720} confirmLoading={busy}
                onCancel={() => { setCreateErr(null); if (recording) void api.mockRecordStop().catch(() => undefined); setRecording(null); setCreating(null); }} onOk={() => void create()}
                okText={creating?.from === 'record' ? (recording ? 'Stop and make the mock' : 'Start recording') : 'Make the mock'}
                okButtonProps={{ disabled: !creating || ((creating.from ?? 'openapi') === 'openapi' ? !creating.text.trim() : creating.from === 'collection' ? !creating.collection : !recording && !/^https?:\/\//.test(creating.target ?? '')) }}>
                {creating && <Space direction="vertical" style={{ width: '100%' }}>
                    {createErr && <Alert type="error" showIcon message={createErr} closable onClose={() => setCreateErr(null)} />}
                    <Segmented value={creating.from ?? 'openapi'} onChange={(v) => !recording && setCreating({ ...creating, from: v as 'openapi' })} options={[{ value: 'openapi', label: 'From an OpenAPI document' }, { value: 'collection', label: "From a collection's examples" }, { value: 'record', label: 'Record the real service' }]} />
                    <Input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="Name (default: the document's title)" aria-label="New mock name" />
                    {creating.from === 'collection' ? <>
                        <Select style={{ width: '100%' }} value={creating.collection} onChange={(v) => setCreating({ ...creating, collection: v })} placeholder="Collection" aria-label="Collection" options={collections.map((c) => ({ value: c.file, label: `${c.name} (${c.file})` }))} />
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Each request with saved examples becomes a route; its examples answer the requests they were saved for (by query or body). Save examples under API → Requests ("Save as example" on a response).</Typography.Text>
                    </> : creating.from === 'record' ? <>
                        <Input className="mono" disabled={!!recording} value={creating.target ?? ''} onChange={(e) => setCreating({ ...creating, target: e.target.value })} placeholder="https://api.example.com/v2" aria-label="Service to record" />
                        {recording ? <Alert type="info" showIcon message={<span>Recording: send requests to <Typography.Text code copyable>{recording.url}</Typography.Text> (instead of {recording.target}).</span>} description={`${recording.count} answer${recording.count === 1 ? '' : 's'} kept. Run your tests or the app against that address, then stop.`} />
                            : <Typography.Text type="secondary" style={{ fontSize: 12 }}>A recording address forwards to the service (through the network settings) and keeps each answer. Stopped, every method and path becomes a route; answers that differ by query or body are kept apart.</Typography.Text>}
                    </> : <>
                    <Input.TextArea className="mono" autoSize={{ minRows: 8, maxRows: 18 }} value={creating.text} onChange={(e) => setCreating({ ...creating, text: e.target.value })} placeholder="Paste the OpenAPI document (JSON or YAML), or choose its file" aria-label="OpenAPI document" />
                    <label className="ant-btn ant-btn-default ant-btn-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}><UploadOutlined />Choose a file
                        <input type="file" accept=".json,.yaml,.yml" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((t) => setCreating((c) => (c ? { ...c, text: t } : c))); }} /></label>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Each operation answers its success response: the document's example, or a sample from its schema. Saved in test/{project}/mocks/.</Typography.Text>
                    </>}
                </Space>}
            </Modal>
            <Modal open={!!editAnswers} title="More answers of this route" okText="Keep" width={720} onCancel={() => setEditAnswers(null)}
                onOk={() => {
                    if (!editAnswers) return;
                    try {
                        const v = JSON.parse(editAnswers.text) as { sequence?: boolean; responses?: MockRouteDef['responses'] };
                        if (!Array.isArray(v.responses) || v.responses.some((x) => !Number.isInteger(x?.status))) throw new Error('"responses" is a list of answers, each with a status.');
                        route(editAnswers.i, { responses: v.responses.length ? v.responses : undefined, sequence: v.sequence || undefined });
                        setEditAnswers(null);
                    } catch (e) { setEditAnswers({ ...editAnswers, error: (e as Error).message }); }
                }}>
                {editAnswers && <Space direction="vertical" style={{ width: '100%' }}>
                    <Input.TextArea className="mono" autoSize={{ minRows: 10, maxRows: 24 }} value={editAnswers.text} onChange={(e) => setEditAnswers({ i: editAnswers.i, text: e.target.value })} aria-label="Answers" spellCheck={false} />
                    {editAnswers.error && <Alert type="error" showIcon message={editAnswers.error} />}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Each answer: <span className="mono">{'{ "when": { "query": { "status": "shipped" }, "headers": { "X-Tenant": "eu" }, "body": "{\"item\":\"rare\"}" }, "status": 409, "body": { … } }'}</span>. The first whose "when" matches answers (a JSON body matches when the request has those fields); else the route's own. With <span className="mono">"sequence": true</span> the route answers in turn instead: its own answer first, then each one, the last repeating (a job that is queued, then running, then done).</Typography.Text>
                </Space>}
            </Modal>
            <Modal open={!!editBody} title="Response body" okText="Keep" onCancel={() => setEditBody(null)} width={680}
                onOk={() => { if (!editBody) return; const t = editBody.text; let v: unknown = t; if (!t.trim()) v = undefined; else { try { v = JSON.parse(t); } catch { v = t; } } route(editBody.i, { body: v }); setEditBody(null); }}>
                {editBody && <><Input.TextArea className="mono" autoSize={{ minRows: 8, maxRows: 22 }} value={editBody.text} onChange={(e) => setEditBody({ ...editBody, text: e.target.value })} aria-label="Response body" />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>JSON (sent as application/json) or text. {'{{path.id}}'}, {'{{query.name}}'} and {'{{body.field}}'} are the request's values.</Typography.Text></>}
            </Modal>
        </>);
}
