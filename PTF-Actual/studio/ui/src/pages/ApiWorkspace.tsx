/**
 * API workspace: collections of requests kept in the project
 * (test/<project>/api/*.collection.json), sent from here with the project's settings and secrets,
 * checked, and turned into a framework feature that uses the framework's own API steps.
 */
import React from 'react';
import { useUnsaved } from '../unsaved';
import { Alert, App, Button, Checkbox, Col, Drawer, Dropdown, Empty, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Tree, Typography, Upload , Switch } from 'antd';
import type { InputRef } from 'antd';
import { ApiOutlined, EllipsisOutlined, EditOutlined, CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, DeleteOutlined, DownOutlined, ExperimentOutlined, FileAddOutlined, FolderAddOutlined, FolderOutlined, ImportOutlined, LockOutlined, PlusOutlined, SaveOutlined, SettingOutlined, CodeOutlined } from '@ant-design/icons';
import {
    api, ApiAuth, ApiCheck, ApiCheckKind, ApiCollectionDef, CorrelationCandidateDef, CorrelationStep, ApiCollectionInfo, ApiExtract, ApiFeaturePreview, baseHashesOf, ApiItemDef, ApiKV, ApiPart, ApiRequestDef, ApiSendResult, ApiScripts as ApiScriptsDef, ApiScopeEntry, ApiScopeName, ApiMsgProtocol, HarReportDef, HttpMethod,
} from '../api';
import { AuthContext, AuthEditor } from '../components/AuthEditor';
import { GraphqlEditor } from '../components/GraphqlEditor';
import { MessagingEditor, PROTOCOLS, protocolOf } from '../components/MessagingEditor';
import { ResponseView } from '../components/ResponseView';
import { ExamplesEditor } from '../components/ExamplesEditor';
import { SnippetModal } from '../components/SnippetModal';
import { FlowView } from '../components/FlowView';
import { RequestComments, RequestHistoryView } from '../components/RequestTeam';
import { findingsSummary, PlanReview } from '../components/PlanReview';
import { ChecksEditor, ExtractEditor, TestDataEditor } from '../components/ApiValidation';
import { collectionNameProblem, collectionSlug, splitUrlQuery } from '../components/collectionName';
import { errText, openInEditor, showRun } from '../state';
import { navigate, useRoute } from '../route';
import { askCopilot, useAgentContext } from '../agentContext';
import { Split } from '../components/Split';
import { SectionTitle, shownTab, useRememberedTab } from '../apiperf-ui';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
/** Other methods (PURGE, PROPFIND…) in grey. */
const methodColor = (m: string) => METHOD_COLOR[m] ?? '#6e7781';
/** A method typed by the user, as HTTP allows it (upper case), or null. */
const typedMethod = (t: string) => { const m = t.trim().toUpperCase(); return /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/.test(m) && m !== 'CONNECT' ? m : null; };
const METHOD_COLOR: Record<string, string> = { GET: '#1a7f37', POST: '#b35900', PUT: '#0550ae', PATCH: '#8250df', DELETE: '#cf222e', HEAD: '#6e7781', OPTIONS: '#6e7781' };
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const newCollection = (name: string): ApiCollectionDef => ({ format: 'cs-studio-api/1', name, baseUrl: '', variables: [], auth: { type: 'none' }, items: [] });
const newRequest = (name = 'New request'): ApiRequestDef => ({ kind: 'request', id: rid(), name, method: 'GET', url: '', query: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, checks: [{ kind: 'status', value: '200' }], extract: [] });
const loadPref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const savePref = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

/** Find / replace / remove an item anywhere in the tree (immutable). */
function mapItems(items: ApiItemDef[], f: (it: ApiItemDef) => ApiItemDef | null): ApiItemDef[] {
    const out: ApiItemDef[] = [];
    for (const it of items) {
        const x = f(it);
        if (!x) continue;
        out.push(x.kind === 'folder' ? { ...x, items: mapItems(x.items, f) } : x);
    }
    return out;
}
function findItem(items: ApiItemDef[], id: string): ApiItemDef | null {
    for (const it of items) {
        if (it.id === id) return it;
        if (it.kind === 'folder') { const x = findItem(it.items, id); if (x) return x; }
    }
    return null;
}
const allRequests = (items: ApiItemDef[]): ApiRequestDef[] => items.flatMap((it) => (it.kind === 'folder' ? allRequests(it.items) : [it]));
const countRequests = (items: ApiItemDef[]): number => items.reduce((n, it) => n + (it.kind === 'folder' ? countRequests(it.items) : 1), 0);

// ---------------------------------------------------------------- small editors

function KvTable({ rows, onChange, keyLabel = 'Key', valueLabel = 'Value', secrets }: { rows: ApiKV[]; onChange: (r: ApiKV[]) => void; keyLabel?: string; valueLabel?: string; secrets?: { onStore: (row: number) => void } }) {
    const all = [...rows, { key: '', value: '' }];
    const set = (i: number, patch: Partial<ApiKV>) => {
        const next = all.map((r, j) => (j === i ? { ...r, ...patch } : r));
        onChange(next.filter((r, j) => j < rows.length || r.key || r.value));
    };
    return (
        <table className="kv-table">
            <thead><tr><th style={{ width: 28 }} /><th>{keyLabel}</th><th>{valueLabel}</th><th style={{ width: secrets ? 64 : 32 }} /></tr></thead>
            <tbody>
                {all.map((r, i) => (
                    <tr key={i} className={r.enabled === false ? 'off' : ''}>
                        <td>{i < rows.length && <Checkbox checked={r.enabled !== false} onChange={(e) => set(i, { enabled: e.target.checked ? undefined : false })} aria-label="Use this row" />}</td>
                        <td><Input size="small" variant="borderless" value={r.key} placeholder={i === rows.length ? `Add ${keyLabel.toLowerCase()}` : ''} onChange={(e) => set(i, { key: e.target.value })} aria-label={keyLabel} /></td>
                        <td>{r.secret
                            ? <Tooltip title="Stored as a Studio secret; the collection file only refers to it"><Input size="small" variant="borderless" value={r.value} readOnly prefix={<LockOutlined />} /></Tooltip>
                            : <Input size="small" variant="borderless" value={r.value} onChange={(e) => set(i, { value: e.target.value })} aria-label={valueLabel} className="mono" />}</td>
                        <td>{i < rows.length && <Space size={0}>
                            {secrets && !r.secret && <Tooltip title="Keep the value out of the file: store it as a Studio secret"><Button size="small" type="text" icon={<LockOutlined />} onClick={() => secrets.onStore(i)} aria-label="Store as secret" /></Tooltip>}
                            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove row" />
                        </Space>}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

/** Multipart parts: a text value, or a file of the project (path from the repository root). */
function PartsTable({ parts, onChange }: { parts: ApiPart[]; onChange: (p: ApiPart[]) => void }) {
    const all = [...parts, { key: '', value: '', type: 'text' as const }];
    const set = (i: number, patch: Partial<ApiPart>) => onChange(all.map((r, j) => (j === i ? { ...r, ...patch } : r)).filter((r, j) => j < parts.length || r.key || r.value));
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <table className="kv-table">
                <thead><tr><th style={{ width: 28 }} /><th>Field</th><th style={{ width: 90 }}>Kind</th><th>Value, or file in the project</th><th style={{ width: 32 }} /></tr></thead>
                <tbody>{all.map((r, i) => (
                    <tr key={i} className={r.enabled === false ? 'off' : ''}>
                        <td>{i < parts.length && <Checkbox checked={r.enabled !== false} onChange={(e) => set(i, { enabled: e.target.checked ? undefined : false })} aria-label="Use this part" />}</td>
                        <td><Input size="small" variant="borderless" value={r.key} placeholder={i === parts.length ? 'Add field' : ''} onChange={(e) => set(i, { key: e.target.value })} aria-label="Field" /></td>
                        <td><Select size="small" variant="borderless" value={r.type ?? 'text'} onChange={(t) => set(i, { type: t })} options={[{ value: 'text', label: 'Text' }, { value: 'file', label: 'File' }]} aria-label="Kind" /></td>
                        <td><Input size="small" variant="borderless" className="mono" value={r.value} placeholder={r.type === 'file' ? 'test/my-project/data/invoice.pdf' : ''} onChange={(e) => set(i, { value: e.target.value })} aria-label="Value" /></td>
                        <td>{i < parts.length && <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onChange(parts.filter((_, j) => j !== i))} aria-label="Remove part" />}</td>
                    </tr>))}</tbody>
            </table>
            <Tooltip title={'Note: the framework\'s multipart steps (1.54) do not send files correctly; "Create test" warns about it.'}><Typography.Text type="secondary" style={{ fontSize: 12 }}>Files are read from the project when the request is sent.</Typography.Text></Tooltip>
        </Space>
    );
}

const SCOPE_LABEL: Record<ApiScopeName, { text: string; color: string; tip: string }> = {
    missing: { text: 'Not defined', color: 'error', tip: 'No scope has this value: the request will say "Not filled in".' },
    saved: { text: 'Saved', color: 'processing', tip: 'Saved in this session, from a response or by a script; it wins over the collection variable.' },
    collection: { text: 'Collection', color: 'default', tip: "The collection's variables (Settings)." },
    global: { text: 'Global', color: 'purple', tip: 'Set by a script with pm.globals; used when no other scope has it.' },
    config: { text: 'Configuration', color: 'cyan', tip: "The project's configuration for this environment ({config:KEY})." },
    secret: { text: 'Secret / machine', color: 'gold', tip: 'A Studio secret or an environment variable of this machine ({env:NAME}).' },
};

/** Every value the collection uses and where it comes from, highest scope first. */
function ScopesDrawer({ open, project, env, collection, saved, onClose, onForget }: { open: boolean; project: string; env?: string; collection: ApiCollectionDef; saved: Record<string, string>; onClose: () => void; onForget: (name: string) => void }) {
    const { message } = App.useApp();
    const [data, setData] = React.useState<{ env: string; entries: ApiScopeEntry[] } | null>(null);
    const [filter, setFilter] = React.useState('');
    const load = React.useCallback(() => { void api.apiScopes({ project, env, collection, saved }).then(setData).catch((e) => message.error(errText(e))); }, [project, env, collection, saved, message]);
    React.useEffect(() => { if (open) load(); }, [open, load]);
    const rows = (data?.entries ?? []).filter((e) => !filter || e.ref.toLowerCase().includes(filter.toLowerCase()) || e.usedBy.some((u) => u.toLowerCase().includes(filter.toLowerCase())));
    return (
        <Drawer open={open} onClose={onClose} width={860} title={`Variables${data ? ` (${data.env})` : ''}`} extra={<Space><Button size="small" onClick={() => void api.apiClearGlobals(collection.name).then(load)}>Clear globals</Button><Button size="small" onClick={load}>Refresh</Button></Space>}>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Tooltip title="{config:KEY} and {env:NAME} come from the environment's configuration and the secrets."><Typography.Text type="secondary" style={{ fontSize: 12 }}>For {'{{name}}'} the highest scope wins: saved (this session) → collection → global.</Typography.Text></Tooltip>
                <Input.Search allowClear placeholder="Find a value or a request" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <Table size="small" rowKey="ref" pagination={false} dataSource={rows} loading={!data}
                    columns={[
                        { title: 'Value', dataIndex: 'ref', width: 200, render: (r: string) => <Typography.Text code>{r}</Typography.Text> },
                        { title: 'From', width: 130, render: (_, e: ApiScopeEntry) => <Tooltip title={SCOPE_LABEL[e.from].tip}><Tag color={SCOPE_LABEL[e.from].color}>{SCOPE_LABEL[e.from].text}</Tag></Tooltip> },
                        { title: 'Now', render: (_, e: ApiScopeEntry) => <Space direction="vertical" size={0}>
                            {e.value !== undefined ? <Typography.Text className="mono" style={{ fontSize: 12 }} ellipsis={{ tooltip: e.value }}>{e.value || <i>(empty)</i>}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>}
                            {e.shadowed.map((x, i) => <Typography.Text key={i} type="secondary" delete style={{ fontSize: 11 }}>{SCOPE_LABEL[x.from].text}: {x.value}</Typography.Text>)}
                        </Space> },
                        { title: 'Used by', width: 190, render: (_, e: ApiScopeEntry) => e.usedBy.length ? <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: e.usedBy.join(', ') }}>{e.usedBy.join(', ')}</Typography.Text> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>not used</Typography.Text> },
                        { title: 'Set by', width: 190, render: (_, e: ApiScopeEntry) => <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: e.setBy.join(', ') }}>{e.setBy.join(', ')}</Typography.Text> },
                        { title: '', width: 40, render: (_, e: ApiScopeEntry) => e.from === 'saved' ? <Tooltip title="Forget the saved value"><Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onForget(e.name)} /></Tooltip> : null },
                    ]} />
            </Space>
        </Drawer>
    );
}

const PRE_EXAMPLE = `// Runs before the request is sent (Postman's pm API).
// pm.environment.set('requestId', pm.variables.replaceIn('{{$guid}}'));
// pm.request.headers.upsert({ key: 'X-Request-Id', value: pm.environment.get('requestId') });`;
const TEST_EXAMPLE = `// Runs after the response (Postman's pm API): each pm.test is a check.
// pm.test('status is 200', () => pm.response.to.have.status(200));
// const body = pm.response.json();
// pm.test('has an id', () => pm.expect(body.id).to.be.a('number'));
// pm.environment.set('orderId', body.id);
// postman.setNextRequest('Get order');  // the runner goes on with that request`;

/** Checks suggested from the last response: each with why; the chosen ones are added. */
function SuggestModal({ response, checks, onClose, onAdd }: { response: NonNullable<ApiSendResult['response']>; checks: ApiCheck[]; onClose: () => void; onAdd: (c: ApiCheck[]) => void }) {
    const { message } = App.useApp();
    const [list, setList] = React.useState<Array<{ check: ApiCheck; why: string; selected: boolean }> | null>(null);
    React.useEffect(() => { api.apiSuggest(response, checks).then((r) => setList(r.suggestions)).catch((e) => { message.error(errText(e)); onClose(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const label = (c: ApiCheck) => c.kind === 'schema' ? 'The body matches its current shape (JSON schema)' : c.kind === 'status' ? `Status is ${c.value}` : c.kind === 'headerContains' ? `${c.target} contains ${c.value}` : c.kind === 'jsonExists' ? `${c.target} is there` : c.kind === 'jsonEquals' ? `${c.target} is ${c.value}` : `Body contains ${c.value}`;
    return (
        <Modal open title="Suggested checks" width={720} okText={`Add ${list?.filter((x) => x.selected).length ?? 0}`} onCancel={onClose} onOk={() => onAdd((list ?? []).filter((x) => x.selected).map((x) => x.check))}>
            {!list ? <Spin /> : !list.length ? <Typography.Text type="secondary">Nothing new to suggest: the checks already cover this response.</Typography.Text> : <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Made from the last response. Values that change between runs (times, tokens, counters) are only checked to be there.</Typography.Text>
                {list.map((x, i) => <Checkbox key={i} checked={x.selected} onChange={(e) => setList(list.map((y, j) => (j === i ? { ...y, selected: e.target.checked } : y)))}>
                    <span className="mono" style={{ fontSize: 12 }}>{label(x.check)}</span> <Typography.Text type="secondary" style={{ fontSize: 12 }}>— {x.why}</Typography.Text></Checkbox>)}
            </Space>}
        </Modal>
    );
}

/** How a request is sent: timeout, redirects, retries, untrusted certificates (the framework has a step for each). */
function RequestSettingsEditor({ value, onChange }: { value?: ApiRequestDef['settings']; onChange: (s: ApiRequestDef['settings']) => void }) {
    const s = value ?? {};
    const set = (p: Partial<NonNullable<ApiRequestDef['settings']>>) => { const n = Object.fromEntries(Object.entries({ ...s, ...p }).filter(([, v]) => v !== undefined && v !== null)); onChange(Object.keys(n).length ? n : undefined); };
    const sw = (label: string, tip: string, checked: boolean, on: (v: boolean) => void) => (
        <Col xs={12} md={6}><Form.Item label={label} tooltip={tip}><Switch checked={checked} onChange={on} aria-label={label} /></Form.Item></Col>);
    return (
        <Form layout="vertical" size="small" className="ap-form" style={{ maxWidth: 760 }}>
            <Row gutter={16}>
                <Col xs={12} md={8}><Form.Item label="Timeout" tooltip="Empty: the default"><InputNumber min={0.1} max={600} step={1} value={s.timeoutMs ? s.timeoutMs / 1000 : undefined} placeholder="default" addonAfter="s" onChange={(v) => set({ timeoutMs: v ? Math.round(Number(v) * 1000) : undefined })} aria-label="Timeout (seconds)" /></Form.Item></Col>
                <Col xs={12} md={8}><Form.Item label="Retries" tooltip="Sent again after a connection error, a 5xx or a 429 (not in load tests)."><InputNumber min={0} max={10} value={s.retries} placeholder="0" onChange={(v) => set({ retries: v ? Number(v) : undefined })} aria-label="Retries" /></Form.Item></Col>
                <Col xs={12} md={8}><Form.Item label="Retry delay"><InputNumber min={0} max={60000} step={250} value={s.retryDelayMs} placeholder="1000" addonAfter="ms" disabled={!s.retries} onChange={(v) => set({ retryDelayMs: v ?? undefined })} aria-label="Retry delay" /></Form.Item></Col>
            </Row>
            <Row gutter={16}>
                {sw('Follow redirects', 'On: a 3xx answer is followed to its Location. Off: the 3xx answer is the response (to check its Location).', s.followRedirects !== false, (on) => set({ followRedirects: on ? undefined : false }))}
                {sw('Accept any certificate', 'The server\'s certificate is not checked: only for test servers.', !!s.insecure, (on) => set({ insecure: on || undefined }))}
                {sw('HTTP/2', 'One connection, requests multiplexed (as browsers do with servers that offer it; no proxy).', !!s.http2, (on) => set({ http2: on || undefined }))}
                {sw("Load the page's resources", 'Load tests: scripts, styles and images of the page too, through each user\'s browser cache.', !!s.resources, (on) => set({ resources: on || undefined }))}
            </Row>
            {s.insecure && <Typography.Text type="warning" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>The server's certificate is not checked: only for test servers.</Typography.Text>}
            <Typography.Text type="secondary" className="ap-note">The test the Studio writes sets the same with the framework's steps.</Typography.Text>
        </Form>
    );
}

/** Pre-request and test scripts (JavaScript, Postman's pm API). */
function ScriptsEditor({ scripts, onChange }: { scripts?: ApiScriptsDef; onChange: (s: ApiScriptsDef | undefined) => void }) {
    const set = (k: 'pre' | 'test', v: string) => { const n = { ...(scripts ?? {}), [k]: v }; onChange(n.pre?.trim() || n.test?.trim() ? n : undefined); };
    return (
        <Row gutter={16}>
            <Col xs={24} xl={12}>
                <SectionTitle help={<>JavaScript with Postman's pm API (variables, pm.request, pm.response, pm.test / pm.expect, pm.sendRequest, setNextRequest; require: chai, lodash, ajv, uuid). Scripts run in Send, the runner and load tests, and go to Postman with the export; a framework test does not run them.</>}>Before the request</SectionTitle>
                <Input.TextArea className="mono" autoSize={{ minRows: 4, maxRows: 16 }} value={scripts?.pre ?? ''} onChange={(e) => set('pre', e.target.value)} placeholder={PRE_EXAMPLE} aria-label="Pre-request script" spellCheck={false} />
            </Col>
            <Col xs={24} xl={12}>
                <SectionTitle help="Each pm.test is a check; values set with pm.environment.set are saved for the next requests.">After the response (tests)</SectionTitle>
                <Input.TextArea className="mono" autoSize={{ minRows: 4, maxRows: 24 }} value={scripts?.test ?? ''} onChange={(e) => set('test', e.target.value)} placeholder={TEST_EXAMPLE} aria-label="Test script" spellCheck={false} />
            </Col>
        </Row>
    );
}

// ---------------------------------------------------------------- request & collection editors

/** WebSocket steps: send a message, or wait for one containing a text (and save a value from it). */
function RequestEditor({ req, onChange, onSend, sending, result, project, env, row, onRow, saved, file }: {
    req: ApiRequestDef; onChange: (r: ApiRequestDef) => void; onSend: () => void; sending: boolean; result: ApiSendResult | null;
    project: string; env?: string; row: number; onRow: (index: number, row: Record<string, string> | undefined) => void; saved: Record<string, string>; file?: string | null;
}) {
    const [codeOpen, setCodeOpen] = React.useState(false);
    const [suggesting, setSuggesting] = React.useState(false);
    const set = (patch: Partial<ApiRequestDef>) => onChange({ ...req, ...patch });
    const [columns, setColumns] = React.useState<string[]>([]);
    const [methodSearch, setMethodSearch] = React.useState('');
    const hasBody = !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method) || req.body.mode !== 'none';
    const count = (n: number) => (n ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>{n}</Tag> : null);
    const settingsCount = req.settings ? Object.keys(req.settings).length : 0;
    const hasScripts = !!(req.scripts?.pre?.trim() || req.scripts?.test?.trim());
    const openComments = (req.comments ?? []).filter((c) => !c.replyTo && !c.resolved).length;
    // The inner tab is remembered for every request (the editor is re-created per request).
    const [tab0, setTab] = useRememberedTab('api-request', 'params');
    const [settingsTab, setSettingsTab] = useRememberedTab('api-request-settings', 'options');
    const [moreTab, setMoreTab] = useRememberedTab('api-request-more', 'examples');
    const activeTab = shownTab(tab0, ['params', 'headers', !!req.ws && 'ws', hasBody && !req.ws && 'body', 'auth', !req.ws && 'checks', !req.ws && 'save', !req.ws && 'data', 'settings', 'more']);
    return (
        <>
        <SnippetModal open={codeOpen} req={req} saved={saved} onClose={() => setCodeOpen(false)} />
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0, overflow: 'auto' }}>
            <Input variant="borderless" className="name-edit" value={req.name} placeholder="Request name" suffix={<EditOutlined className="name-edit-icon" />} maxLength={200}
                onChange={(e) => set({ name: e.target.value })} onBlur={() => { if (!req.name.trim()) set({ name: 'Untitled request' }); }} style={{ fontWeight: 600, fontSize: 15 }} aria-label="Request name" />
            <Space.Compact style={{ width: '100%' }}>
                <Select showSearch searchValue={methodSearch} onSearch={setMethodSearch} onBlur={() => setMethodSearch('')} filterOption={false} value={req.ws ? `@${req.ws.protocol ?? 'websocket'}` : req.method} onChange={(m) => (m.startsWith('@') ? set({ method: 'GET', body: { mode: 'none' }, ws: { steps: req.ws?.steps ?? [{ kind: 'send', text: '' }, { kind: 'expect', text: '' }], ...(m === '@websocket' ? {} : { protocol: m.slice(1) as ApiMsgProtocol }), ...(req.ws?.protocol === m.slice(1) && req.ws.options ? { options: req.ws.options } : {}) } }) : set({ method: m as HttpMethod, ws: undefined }))} style={{ width: 110 }} aria-label="Method"
                    options={[...[...METHODS, ...(METHODS.includes(req.method) || req.ws ? [] : [req.method]), ...(typedMethod(methodSearch) && !METHODS.includes(typedMethod(methodSearch)!) && typedMethod(methodSearch) !== req.method ? [typedMethod(methodSearch)!] : [])]
                        .filter((m) => !methodSearch || m.includes(methodSearch.trim().toUpperCase())).map((m) => ({ value: m, label: <span style={{ color: methodColor(m), fontWeight: 600 }}>{m}</span> })), ...PROTOCOLS.filter((x) => !methodSearch || x.short.includes(methodSearch.trim().toUpperCase()) || x.label.toUpperCase().includes(methodSearch.trim().toUpperCase())).map((x) => ({ value: `@${x.value}`, label: <Tooltip title={x.label} placement="right"><span style={{ color: x.color, fontWeight: 600 }}>{x.short}</span></Tooltip> }))]} />
                <Input className="mono" value={req.url} onChange={(e) => set({ url: e.target.value })} onPressEnter={onSend}
                    onBlur={() => { if (!req.ws) { const m = splitUrlQuery(req.url, req.query); if (m) set(m); } }} placeholder={req.ws ? protocolOf(req.ws).url : '/users/{{id}}  or  https://api.example.com/users'} aria-label="URL" />
                <Button type="primary" icon={<CaretRightOutlined />} loading={sending} onClick={onSend}>{req.ws ? 'Connect' : 'Send'}</Button>
                {!req.ws && <Tooltip title="The request as code (cURL, Python, Java, C#…)"><Button icon={<CodeOutlined />} onClick={() => setCodeOpen(true)} aria-label="Code" /></Tooltip>}
            </Space.Compact>
            {req.notes?.length ? <Alert type="info" showIcon closable message={`${req.notes.length} imported line${req.notes.length === 1 ? '' : 's'} could not be converted`} description={<pre className="code-box" style={{ maxHeight: 120 }}>{req.notes.join('\n')}</pre>} /> : null}
            <Tabs size="small" className="ap-tabs" tabBarGutter={14} more={{ icon: <EllipsisOutlined aria-label="More tabs" /> }} activeKey={activeTab} onChange={setTab} items={[
                { key: 'params', label: <span>Params{count(req.query.length)}</span>, children: <KvTable rows={req.query} onChange={(query) => set({ query })} keyLabel="Parameter" /> },
                { key: 'headers', label: <span>Headers{count(req.headers.length)}</span>, children: <KvTable rows={req.headers} onChange={(headers) => set({ headers })} keyLabel="Header" /> },
                ...(req.ws ? [{ key: 'ws', label: <span>Messages{count(req.ws.steps.length)}</span>, children: <MessagingEditor req={req} ws={req.ws} results={result?.checks} onChange={(ws) => set({ ws })} /> }] : []),
                ...(hasBody && !req.ws ? [{ key: 'body', label: <span>Body{req.body.mode !== 'none' ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>{req.body.mode}</Tag> : null}</span>, children: <Space direction="vertical" style={{ width: '100%' }}>
                    <Segmented size="small" value={req.body.mode} onChange={(m) => set({ body: { ...req.body, mode: m as ApiRequestDef['body']['mode'], ...(m === 'graphql' && !req.body.graphql ? { graphql: { query: '' } } : {}) }, ...(m === 'graphql' && req.method === 'GET' ? { method: 'POST' as HttpMethod } : {}) })} options={[{ value: 'none', label: 'None' }, { value: 'json', label: 'JSON' }, { value: 'graphql', label: 'GraphQL' }, { value: 'form', label: 'Form' }, { value: 'multipart', label: 'Multipart (files)' }, { value: 'xml', label: 'XML' }, { value: 'text', label: 'Text' }, { value: 'file', label: 'Payload file' }]} />
                    {req.body.mode === 'file' ? <Form layout="vertical" size="small" className="ap-form" style={{ maxWidth: 560 }}>
                        <Form.Item label="Payload file" tooltip={<>A template under the project's PAYLOAD_BASE_PATH: its {'{{name}}'} are filled from the test data row and saved values; {'{{jsonEncode(codes)}}'} writes a list as JSON.</>}>
                            <Input className="mono" value={req.body.file} placeholder="request-payload-template.json" onChange={(e) => set({ body: { ...req.body, file: e.target.value } })} aria-label="Payload file" />
                        </Form.Item>
                    </Form>
                    : req.body.mode === 'graphql' ? <GraphqlEditor req={req} onChange={(graphql) => set({ body: { ...req.body, graphql } })} />
                    : req.body.mode === 'multipart' ? <PartsTable parts={req.body.parts ?? []} onChange={(parts) => set({ body: { ...req.body, parts } })} />
                        : req.body.mode === 'form' ? <KvTable rows={req.body.form ?? []} onChange={(form) => set({ body: { ...req.body, form } })} keyLabel="Field" />
                        : req.body.mode !== 'none' && (() => {
                            // JSON that does not parse ({{names}} filled in as 0 for the check): said under the box.
                            const bad = req.body.mode === 'json' && req.body.text?.trim() ? (() => { try { JSON.parse(req.body.text!.replace(/"?\{\{[^}]+\}\}"?/g, '0')); return null; } catch (e) { return (e as Error).message; } })() : null;
                            return <>
                                <Input.TextArea className="mono" autoSize={{ minRows: 6, maxRows: 18 }} value={req.body.text} onChange={(e) => set({ body: { ...req.body, text: e.target.value } })} aria-label="Body" status={bad ? 'warning' : undefined} />
                                {bad && <Typography.Text type="warning" style={{ fontSize: 12 }}>Not valid JSON: {bad}. It is sent as written.</Typography.Text>}
                            </>;
                        })()}
                </Space> }] : []),
                { key: 'auth', label: <span>Auth{req.auth.type !== 'inherit' && req.auth.type !== 'none' ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>{req.auth.type}</Tag> : null}</span>, children: <AuthEditor auth={req.auth} inherit onChange={(auth) => set({ auth })} /> },
                ...(req.ws ? [] : [
                    { key: 'checks', label: <span>Checks{count(req.checks.length)}</span>, children: <Space direction="vertical" style={{ width: '100%' }}>
                        <Space wrap>
                            <Tooltip title={result?.response ? 'Checks made from the last response (status, type, shape, stable values): pick the ones to keep' : 'Send the request first'}><Button size="small" disabled={!result?.response} onClick={() => setSuggesting(true)}>Suggest checks</Button></Tooltip>
                            {result?.checks?.some((c) => !c.pass) && <Button size="small" onClick={() => askCopilot(`The request "${req.name}" (${req.method} ${req.url}) failed these checks:\n${result.checks!.filter((c) => !c.pass).map((c) => `- ${c.message}${c.actual !== undefined ? ` (got ${c.actual})` : ''}`).join('\n')}\nThe response was ${result.response?.status ?? 'not received'}${result.response ? `:\n${result.response.body.slice(0, 1500)}` : ''}\nExplain why, and whether the check or the API is wrong.`)}>Explain the failures with Copilot</Button>}
                        </Space>
                        <ChecksEditor checks={req.checks} results={result?.checks} columns={columns} onChange={(checks) => set({ checks })} />
                        {suggesting && result?.response && <SuggestModal response={result.response} checks={req.checks} onClose={() => setSuggesting(false)} onAdd={(add) => { set({ checks: [...req.checks, ...add] }); setSuggesting(false); }} />}
                    </Space> },
                    { key: 'save', label: <span>Save values{count(req.extract.length)}</span>, children: <ExtractEditor rules={req.extract} results={result?.extracted} onChange={(extract) => set({ extract })} /> },
                    { key: 'data', label: <span>Test data{req.data?.source ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>rows</Tag> : null}{count(req.prepare?.length ?? 0)}</span>, forceRender: true,
                        children: <TestDataEditor project={project} env={env} data={req.data} prepare={req.prepare} row={row} onRow={onRow} onColumns={setColumns} onChange={(p) => set({ data: p.data, prepare: p.prepare?.length ? p.prepare : undefined })} /> },
                ]),
                { key: 'settings', label: <span>Settings{settingsCount ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>{settingsCount}</Tag> : null}{hasScripts ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>JS</Tag> : null}</span>, children: (
                    <Tabs size="small" className="ap-inner-tabs" activeKey={shownTab(settingsTab, [!req.ws && 'options', 'scripts'])} onChange={setSettingsTab} items={[
                        ...(req.ws ? [] : [{ key: 'options', label: 'Sending', children: <RequestSettingsEditor value={req.settings} onChange={(settings) => set({ settings })} /> }]),
                        { key: 'scripts', label: <span>Scripts{hasScripts ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>JS</Tag> : null}</span>, children: <ScriptsEditor scripts={req.scripts} onChange={(scripts) => set({ scripts })} /> },
                    ]} />) },
                { key: 'more', label: <span>Examples &amp; notes{openComments ? <Tag bordered={false} color="processing" style={{ marginInlineStart: 4 }}>{openComments}</Tag> : count(req.examples?.length ?? 0)}</span>, children: (
                    <Tabs size="small" className="ap-inner-tabs" activeKey={shownTab(moreTab, [!req.ws && 'examples', 'comments', 'history'])} onChange={setMoreTab} items={[
                        ...(req.ws ? [] : [{ key: 'examples', label: <span>Examples{count(req.examples?.length ?? 0)}</span>, children: <ExamplesEditor examples={req.examples ?? []} onChange={(examples) => set({ examples })} /> }]),
                        { key: 'comments', label: <span>Comments{openComments ? <Tag bordered={false} color="processing" style={{ marginInlineStart: 4 }}>{openComments}</Tag> : null}</span>, children: <RequestComments comments={req.comments ?? []} onChange={(comments) => set({ comments })} /> },
                        { key: 'history', label: 'Changes', children: <RequestHistoryView file={file ?? null} id={req.id} /> },
                    ]} />) },
            ]} />
        </div>
        </>
    );
}

function CollectionSettings({ c, onChange, project, env }: { c: ApiCollectionDef; onChange: (c: ApiCollectionDef) => void; project: string; env?: string }) {
    const { message } = App.useApp();
    const [store, setStore] = React.useState<{ row: number; name: string; value: string } | null>(null);
    const [tab, setTab] = useRememberedTab('api-collection', 'general');
    const storing = React.useRef(false);
    const storeNow = async () => {
        if (!store || storing.current) return;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(store.name)) { message.error('Use letters, digits and _ for the name.'); return; }
        storing.current = true;
        try {
            await api.setSecret(store.name, store.value, env);
            onChange({ ...c, variables: c.variables.map((v, i) => (i === store.row ? { ...v, value: `{env:${store.name}}`, secret: true } : v)) });
            message.success(`Stored ${store.name}. The collection now refers to it as {env:${store.name}}.`);
            setStore(null);
        } catch (e) { message.error(errText(e)); }
        finally { storing.current = false; }
    };
    return (
        <div className="ap-editor">
            <div className="ap-editor-inner">
                <Input variant="borderless" className="name-edit" value={c.name} placeholder="Collection name" suffix={<EditOutlined className="name-edit-icon" />} maxLength={200}
                    onChange={(e) => onChange({ ...c, name: e.target.value })} status={c.name.trim() ? undefined : 'error'} style={{ fontWeight: 600, fontSize: 16 }} aria-label="Collection name" />
                {!c.name.trim() && <Typography.Text type="danger" style={{ fontSize: 12 }}>Give the collection a name (it cannot be saved without one).</Typography.Text>}
                <Tabs size="small" className="ap-tabs" activeKey={shownTab(tab, ['general', 'variables', 'auth', 'scripts'])} onChange={setTab} items={[
                    { key: 'general', label: 'General', children: <Form layout="vertical" size="small" className="ap-form">
                        <Form.Item label="Base URL" tooltip="Use {config:API_BASE_URL} so each environment (dev, sit, uat) uses its own server, as set under Environments.">
                            <Input className="mono" value={c.baseUrl} onChange={(e) => onChange({ ...c, baseUrl: e.target.value })} placeholder="{config:API_BASE_URL}  or  https://api.example.com" aria-label="Base URL" />
                        </Form.Item>
                        <Form.Item label="Description" tooltip="Becomes the description of the feature made with Create test">
                            <Input.TextArea placeholder="What these requests cover" autoSize={{ minRows: 2, maxRows: 6 }} value={c.description} onChange={(e) => onChange({ ...c, description: e.target.value })} aria-label="Description" />
                        </Form.Item>
                        <Typography.Text type="secondary" className="ap-note">{'{config:…}'} values come from project <b>{project}</b>{env ? <>, environment <b>{env}</b></> : null}.</Typography.Text>
                    </Form> },
                    { key: 'variables', label: <span>Variables{c.variables.length ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>{c.variables.length}</Tag> : null}</span>, children: <>
                        <SectionTitle help="Used as {{name}} in the requests. The lock keeps a value out of the file, as a Studio secret.">Collection variables</SectionTitle>
                        <KvTable rows={c.variables} onChange={(variables) => onChange({ ...c, variables })} keyLabel="Name"
                            secrets={{ onStore: (row) => setStore({ row, name: c.variables[row].key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase(), value: c.variables[row].value }) }} />
                    </> },
                    { key: 'auth', label: <span>Auth{c.auth.type !== 'none' ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>{c.auth.type}</Tag> : null}</span>, children: <>
                        <SectionTitle help="Used by every request that does not set its own.">Authentication</SectionTitle>
                        <AuthEditor auth={c.auth} inherit={false} onChange={(auth) => onChange({ ...c, auth })} />
                    </> },
                    { key: 'scripts', label: <span>Scripts{c.scripts?.pre?.trim() || c.scripts?.test?.trim() ? <Tag bordered={false} style={{ marginInlineStart: 4 }}>JS</Tag> : null}</span>, children: <>
                        <Typography.Text type="secondary" className="ap-note" style={{ marginBottom: 6 }}>Run around every request of the collection, before the request's own.</Typography.Text>
                        <ScriptsEditor scripts={c.scripts} onChange={(scripts) => onChange({ ...c, scripts })} />
                    </> },
                ]} />
            </div>
            <Modal open={!!store} title="Store as a Studio secret" okText="Store secret" onCancel={() => setStore(null)} onOk={() => void storeNow()}>
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary">The value is kept in your secret store on this computer (and given to test runs). The collection file only keeps <Typography.Text code>{`{env:${store?.name ?? 'NAME'}}`}</Typography.Text>.</Typography.Text>
                    <Input addonBefore="Name" value={store?.name} maxLength={120} onChange={(e) => store && setStore({ ...store, name: e.target.value })} onPressEnter={() => void storeNow()} aria-label="Secret name" />
                    <Input.Password addonBefore="Value" value={store?.value} onChange={(e) => store && setStore({ ...store, value: e.target.value })} onPressEnter={() => void storeNow()} aria-label="Secret value" />
                    {env && <Typography.Text type="secondary" style={{ fontSize: 12 }}>For environment {env} of this project.</Typography.Text>}
                </Space>
            </Modal>
        </div>
    );
}

function FeatureModal({ open, project, env, collection, onClose }: { open: boolean; project: string; env?: string; collection: ApiCollectionDef; onClose: () => void }) {
    const { message, modal } = App.useApp();
    const [p, setP] = React.useState<ApiFeaturePreview | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => { if (!open) return; setP(null); setErr(null); api.apiFeature(project, collection, false, false, { env }).then(setP).catch((e) => setErr(errText(e))); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    const save = (run: boolean) => {
        if (p?.review?.blocked) modal.confirm({ title: 'Save although the framework check found problems?', content: findingsSummary(p.review), okText: 'Save anyway', okButtonProps: { danger: true }, onOk: () => doSave(run, true) });
        else void doSave(run, false);
    };
    const doSave = async (run: boolean, force: boolean) => {
        setBusy(true);
        try {
            const r = await api.apiFeature(project, collection, true, true, { baseHashes: baseHashesOf(p?.review), force, env });
            message.success(`Saved ${r.file}`);
            onClose();
            if (run) { const x = await api.startRun({ project, env: env ?? 'dev', features: [r.file], headless: true, workers: 1 }); showRun(x.id); }
            else openInEditor(r.file, 1);
        } catch (e) { setErr(errText(e)); }
        finally { setBusy(false); }
    };
    return (
        <Modal open={open} width={900} onCancel={onClose} title={<Space><ExperimentOutlined />{`Create a test from “${collection.name}”`}</Space>}
            footer={<Space><Button onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!p} onClick={() => save(false)}>Save and open</Button><Button type="primary" loading={busy} disabled={!p} icon={<CaretRightOutlined />} onClick={() => save(true)}>Save and run</Button></Space>}>
            {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} />}
            {!p ? <Spin /> : <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text>{p.scenarios} scenario{p.scenarios === 1 ? '' : 's'} (the framework's API steps; checks they do not have use the project's response steps, written with the test), saved as <Typography.Text code>{p.file}</Typography.Text>{p.exists ? <Typography.Text type="warning"> (replaces the existing file)</Typography.Text> : null}.</Typography.Text>
                {p.warnings.length > 0 && <Alert type="warning" showIcon message={`${p.warnings.length} thing${p.warnings.length === 1 ? '' : 's'} to look at`} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{p.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>} />}
                {p.review ? <PlanReview review={{ ...p.review, warnings: [] }} height={380} /> : <pre className="code-box" style={{ maxHeight: 460 }}>{p.text}</pre>}
            </Space>}
        </Modal>
    );
}

type ImportKind = 'collection' | 'curl' | 'openapi' | 'wsdl' | 'other';
function ImportModal({ open, kind, onClose, onCollection, onCurl, onOpenApi, onWsdl, onOther }: { open: boolean; kind: ImportKind; onClose: () => void; onCollection: (text: string, env?: string) => Promise<void>; onCurl: (text: string) => Promise<void>; onOpenApi: (text: string) => Promise<void>; onWsdl: (b: { text?: string; url?: string }) => Promise<void>; onOther: (text: string) => Promise<void> }) {
    const [url, setUrl] = React.useState('');
    const [text, setText] = React.useState('');
    const [envText, setEnvText] = React.useState<string | undefined>();
    const [envName, setEnvName] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    React.useEffect(() => { if (open) { setText(''); setUrl(''); setEnvText(undefined); setEnvName(''); setErr(null); } }, [open, kind]);
    // A new file (or pasted text) replaces the earlier one: its old error goes.
    const readFile = (f: File, then: (t: string) => void) => { setErr(null); f.text().then(then).catch((e) => setErr(String(e))); return false; };
    React.useEffect(() => { setErr(null); }, [text]);
    const go = async () => {
        setBusy(true); setErr(null);
        try { if (kind === 'collection') await onCollection(text, envText); else if (kind === 'openapi') await onOpenApi(text); else if (kind === 'wsdl') await onWsdl(text.trim() ? { text } : { url }); else if (kind === 'other') await onOther(text); else await onCurl(text); onClose(); }
        catch (e) { setErr(errText(e)); }
        finally { setBusy(false); }
    };
    return (
        <Modal open={open} width={720} onCancel={onClose} okText="Import" confirmLoading={busy} okButtonProps={{ disabled: !text.trim() && !(kind === 'wsdl' && /^https?:\/\//.test(url.trim())) }} onOk={go}
            title={kind === 'collection' ? 'Import a collection file' : kind === 'openapi' ? 'Import an OpenAPI / Swagger file' : kind === 'wsdl' ? 'Import a SOAP service (WSDL)' : kind === 'other' ? 'Import from another tool' : 'Import a cURL command'}>
            <Space direction="vertical" style={{ width: '100%' }}>
                {kind === 'collection' ? <>
                    <Tooltip title="Tests like pm.response.to.have.status(200) become checks; values set with pm.environment.set become saved values."><Typography.Text type="secondary">A "Collection v2.1" JSON export from your API client.</Typography.Text></Tooltip>
                    <Space wrap>
                        <Upload accept=".json" showUploadList={false} beforeUpload={(f) => readFile(f, setText)}><Button icon={<ImportOutlined />}>Choose the collection file</Button></Upload>
                        <Upload accept=".json" showUploadList={false} beforeUpload={(f) => { setEnvName(f.name); return readFile(f, setEnvText); }}><Button>Add an environment file (optional)</Button></Upload>
                        {envName && <Tag closable onClose={() => { setEnvName(''); setEnvText(undefined); }}>{envName}</Tag>}
                    </Space>
                    <Input.TextArea className="mono" autoSize={{ minRows: 6, maxRows: 14 }} placeholder="…or paste the collection JSON here" value={text} onChange={(e) => setText(e.target.value)} aria-label="Collection JSON" />
                </> : kind === 'other' ? <>
                    <Tooltip title="Insomnia, SoapUI / ReadyAPI, JMeter (.jmx), RAML 1.0, AsyncAPI or a GraphQL schema. What cannot be carried over (scripts, conditions) is listed after the import."><Typography.Text type="secondary">The format is recognised from the file.</Typography.Text></Tooltip>
                    <Upload accept=".json,.xml,.jmx,.raml,.yaml,.yml,.graphql,.gql,.wsdl" showUploadList={false} beforeUpload={(f) => readFile(f, setText)}><Button icon={<ImportOutlined />}>Choose the file</Button></Upload>
                    <Input.TextArea className="mono" autoSize={{ minRows: 6, maxRows: 14 }} placeholder="…or paste it here" value={text} onChange={(e) => setText(e.target.value)} aria-label="File to import" />
                </> : kind === 'wsdl' ? <>
                    <Tooltip title={<>One request per operation of each SOAP 1.1 / 1.2 port, with an envelope built from the schema, the SOAP action and checks (status, no Fault). Values to fill in are left as {'{{name}}'}.</>}><Typography.Text type="secondary">A WSDL 1.1 file, or the service's address (…?wsdl).</Typography.Text></Tooltip>
                    <Input className="mono" placeholder="https://services.example.com/OrderService.svc?wsdl" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="WSDL address" />
                    <Upload accept=".wsdl,.xml" showUploadList={false} beforeUpload={(f) => readFile(f, setText)}><Button icon={<ImportOutlined />}>…or choose the WSDL file</Button></Upload>
                    <Input.TextArea className="mono" autoSize={{ minRows: 4, maxRows: 12 }} placeholder="…or paste it here" value={text} onChange={(e) => setText(e.target.value)} aria-label="WSDL document" />
                </> : kind === 'openapi' ? <>
                    <Tooltip title="One request per operation, grouped by tag, with example bodies, required parameters, authentication and a status check."><Typography.Text type="secondary">An OpenAPI 3 or Swagger 2 description (JSON or YAML).</Typography.Text></Tooltip>
                    <Upload accept=".json,.yaml,.yml" showUploadList={false} beforeUpload={(f) => readFile(f, setText)}><Button icon={<ImportOutlined />}>Choose the file</Button></Upload>
                    <Input.TextArea className="mono" autoSize={{ minRows: 6, maxRows: 14 }} placeholder="…or paste it here" value={text} onChange={(e) => setText(e.target.value)} aria-label="OpenAPI document" />
                </> : <>
                    <Typography.Text type="secondary">Paste a "Copy as cURL" command (bash or Windows format).</Typography.Text>
                    <Input.TextArea className="mono" autoSize={{ minRows: 6, maxRows: 14 }} placeholder={'curl https://api.example.com/users -H "Accept: application/json"'} value={text} onChange={(e) => setText(e.target.value)} aria-label="cURL command" />
                </>}
                {err && <Alert type="error" showIcon message={err} />}
            </Space>
        </Modal>
    );
}

/**
 * A HAR recording (browser developer tools → Network → "Save all as HAR"): first the hosts and the
 * values to correlate are shown, then the chosen ones are imported.
 */
function HarModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (r: Awaited<ReturnType<typeof api.apiImportHar>>) => void }) {
    const [text, setText] = React.useState('');
    const [preview, setPreview] = React.useState<HarReportDef | null>(null);
    const [hosts, setHosts] = React.useState<string[]>([]);
    const [skip, setSkip] = React.useState<string[]>([]);
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    React.useEffect(() => { if (open) { setText(''); setPreview(null); setErr(null); setSkip([]); } }, [open]);
    const analyse = async (t: string) => {
        setBusy(true); setErr(null); setPreview(null);
        try {
            const r = await api.apiImportHar(t);
            setPreview(r.report);
            // Hosts the requests mostly go to (the API), not one-off third parties.
            const top = r.report.hosts[0]?.requests ?? 0;
            setHosts(r.report.hosts.filter((h) => h.requests >= Math.max(2, top * 0.1) || r.report.hosts.length === 1).map((h) => h.host));
        } catch (e) { setErr(errText(e)); }
        finally { setBusy(false); }
    };
    const go = async () => {
        setBusy(true); setErr(null);
        try { onImported(await api.apiImportHar(text, { hosts, skipCorrelations: skip })); onClose(); }
        catch (e) { setErr(errText(e)); }
        finally { setBusy(false); }
    };
    const sk = preview?.skipped;
    return (
        <Modal open={open} width={820} onCancel={onClose} title="Import a browser recording (HAR)" confirmLoading={busy}
            okText={preview ? 'Import' : 'Read the recording'} okButtonProps={{ disabled: !text.trim() || (!!preview && !hosts.length) }} onOk={() => (preview ? void go() : void analyse(text))}>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Tooltip title="Developer tools → Network → use the application → right-click a request → Save all as HAR. Pages, scripts, styles and images are left out."><Typography.Text type="secondary">The API requests of a browser recording become a collection.</Typography.Text></Tooltip>
                <Space wrap>
                    <Upload accept=".har,.json" showUploadList={false} beforeUpload={(f) => { f.text().then((t) => { setText(t); void analyse(t); }).catch((e) => setErr(String(e))); return false; }}><Button icon={<ImportOutlined />}>Choose the .har file</Button></Upload>
                    {text && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{(text.length / 1024).toFixed(0)} KB</Typography.Text>}
                </Space>
                {!preview && <Input.TextArea className="mono" autoSize={{ minRows: 4, maxRows: 10 }} placeholder="…or paste the HAR JSON here" value={text} onChange={(e) => setText(e.target.value)} aria-label="HAR JSON" />}
                {preview && sk && <>
                    <Typography.Text>{preview.entries} recorded requests: {sk.static} static files, {sk.preflight} preflight{sk.preflight === 1 ? '' : 's'}{sk.other ? `, ${sk.other} other` : ''} left out.{preview.medianPause !== undefined && preview.medianPause >= 100 ? ` Median pause between requests: ${(preview.medianPause / 1000).toFixed(1)} s (a starting point for think time).` : ''}</Typography.Text>
                    <div>
                        <Typography.Text strong>Hosts to import</Typography.Text>
                        <div className="tx-list" style={{ marginTop: 4 }}>{preview.hosts.map((h) => <Checkbox key={h.host} checked={hosts.includes(h.host)} onChange={(e) => setHosts(e.target.checked ? [...hosts, h.host] : hosts.filter((x) => x !== h.host))}><span className="mono">{h.host}</span> <Typography.Text type="secondary">({h.requests})</Typography.Text></Checkbox>)}</div>
                    </div>
                    <div>
                        <Typography.Text strong>Correlation</Typography.Text>{' '}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Values the server returned that later requests send back. Each one is saved from its response and reused, so every run (and every virtual user) uses fresh ids and tokens instead of the recorded ones.</Typography.Text>
                        {preview.correlations.length === 0 ? <div><Typography.Text type="secondary">None found.</Typography.Text></div> :
                            <Table size="small" rowKey="variable" pagination={false} style={{ marginTop: 6 }} dataSource={preview.correlations}
                                rowSelection={{ selectedRowKeys: preview.correlations.map((c) => c.variable).filter((v) => !skip.includes(v)), onChange: (keys) => setSkip(preview.correlations.map((c) => c.variable).filter((v) => !keys.includes(v))) }}
                                columns={[
                                    { title: 'Saved as', dataIndex: 'variable', render: (v: string) => <span className="mono">{`{{${v}}}`}</span> },
                                    { title: 'From the response of', render: (_, c) => <>{c.fromName} <span className="mono" style={{ fontSize: 11 }}>{c.path}</span></> },
                                    { title: 'Recorded value', dataIndex: 'preview', render: (v: string) => <span className="mono" style={{ fontSize: 11 }}>{v}</span> },
                                    { title: 'Sent back by', dataIndex: 'usedBy', render: (u: string[]) => <Tooltip title={u.join(', ')}>{u.length} request{u.length === 1 ? '' : 's'}</Tooltip> },
                                ]} />}
                    </div>
                    {preview.warnings.map((w, i) => <Typography.Text key={i} type="warning">• {w}</Typography.Text>)}
                    {Object.keys(preview.secrets).length > 0 && <Alert type="info" showIcon message={`Recorded credentials (${Object.keys(preview.secrets).join(', ')}) are not written to the collection; you can store them as secrets after the import.`} />}
                </>}
                {err && <Alert type="error" showIcon message={err} />}
            </Space>
        </Modal>
    );
}

// ---------------------------------------------------------------- page


/**
 * Correlate: replay the collection twice; values that change between the replays (a token, an id) and that later
 * requests send fixed are proposed: save the value, send {{name}} there. Applied, it replays again, until clean.
 */
function CorrelateModal({ open, onClose, project, env, collection, onApply }: { open: boolean; onClose: () => void; project: string; env?: string; collection: ApiCollectionDef; onApply: (c: ApiCollectionDef) => void }) {
    const [busy, setBusy] = React.useState(false);
    const [round, setRound] = React.useState(0);
    const [res, setRes] = React.useState<{ steps: CorrelationStep[]; candidates: CorrelationCandidateDef[] } | null>(null);
    const [picked, setPicked] = React.useState<number[]>([]);
    const [err, setErr] = React.useState<string | null>(null);
    const [applied, setApplied] = React.useState(0);
    const replay = async (c: ApiCollectionDef) => {
        setBusy(true); setErr(null);
        try { const r = await api.apiCorrelate({ project, env, collection: c }); setRes(r); setPicked(r.candidates.map((_x, i) => i)); setRound((n) => n + 1); }
        catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };
    React.useEffect(() => { if (open) { setRes(null); setRound(0); setApplied(0); void replay(collection); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    const apply = async () => {
        if (!res) return;
        setBusy(true); setErr(null);
        try {
            const r = await api.apiCorrelateApply({ collection, candidates: res.candidates.filter((_x, i) => picked.includes(i)) });
            onApply(r.collection); setApplied((n) => n + r.changed);
            await replay(r.collection);
        } catch (e) { setErr(errText(e)); setBusy(false); }
    };
    const clean = res && !res.candidates.length && res.steps.every((x) => x.ok);
    const where: Record<string, string> = { query: 'query', header: 'header', json: 'body', form: 'form field', path: 'path' };
    return (
        <Modal open={open} onCancel={onClose} width={980} title="Correlate dynamic values" footer={[
            <Button key="close" onClick={onClose}>Close</Button>,
            <Button key="again" disabled={busy} onClick={() => void replay(collection)}>Replay again</Button>,
            <Button key="apply" type="primary" loading={busy} disabled={!res?.candidates.length || !picked.length} onClick={() => void apply()}>Apply {picked.length || ''} and replay</Button>]}>
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <Tooltip title={<>A value of a response that changes between the two replays (a token, an id) and that a later request sends with a fixed, recorded value is proposed: saved from the response, sent as {'{{name}}'}. Applied, the collection changes here (Save to keep it) and is replayed again.</>}><Typography.Text type="secondary" style={{ fontSize: 12 }}>The requests are sent twice, in order, as one user ({env ?? 'the first environment'}).</Typography.Text></Tooltip>
                {err && <Alert type="error" showIcon message={err} />}
                {busy && !res && <Spin />}
                {res && <>
                    <Alert type={clean ? 'success' : res.candidates.length ? 'info' : 'warning'} showIcon
                        message={clean ? `Clean: every request passes${round > 1 ? ` after ${round} replays` : ''}${applied ? ` (${applied} value${applied === 1 ? '' : 's'} now sent from earlier responses)` : ''}.`
                            : res.candidates.length ? `Replay ${round}: ${res.steps.filter((x) => x.ok).length} of ${res.steps.length} requests pass; ${res.candidates.length} dynamic value${res.candidates.length === 1 ? '' : 's'} to correlate.`
                            : `Replay ${round}: ${res.steps.filter((x) => !x.ok).length} request(s) fail and no dynamic value explains it: check them in the request editor.`} />
                    <div className="corr-steps">{res.steps.map((x) => <Tooltip key={x.id} title={x.error ?? `${x.timeMs} ms`}><Tag bordered={false} color={x.ok ? 'success' : 'error'}>{x.name} · {x.status || '—'}</Tag></Tooltip>)}</div>
                    {res.candidates.length > 0 && <Table<CorrelationCandidateDef> size="small" pagination={false} rowKey={(_x) => String(res.candidates.indexOf(_x))} dataSource={res.candidates}
                        rowSelection={{ selectedRowKeys: picked.map(String), onChange: (k) => setPicked(k.map(Number)) }}
                        columns={[
                            { title: 'Value from', render: (_v, k) => <span><b>{k.fromName}</b> <span className="mono" style={{ fontSize: 12 }}>{k.source === 'json' ? k.path : `${k.source} ${k.path}`}</span></span> },
                            { title: 'Saved as', width: 120, render: (_v, k) => <span className="mono">{`{{${k.variable}}}`}</span> },
                            { title: 'Changed between replays', width: 230, render: (_v, k) => <Typography.Text className="mono" style={{ fontSize: 11 }} ellipsis={{ tooltip: k.samples.join(' → ') }}>{k.samples[0]} → {k.samples[1]}</Typography.Text> },
                            { title: 'Sent by', render: (_v, k) => <Space direction="vertical" size={0}>{k.to.map((t) => <span key={`${t.request}${t.where}${t.field}`} style={{ fontSize: 12 }}>{t.requestName} · {where[t.where]} <span className="mono">{t.where === 'path' ? `segment ${Number(t.field) + 1}` : t.field}</span> <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>(now {t.current.length > 40 ? `${t.current.slice(0, 40)}…` : t.current})</Typography.Text></span>)}</Space> },
                        ]} />}
                </>}
            </Space>
        </Modal>);
}

interface Open { file: string | null; project: string; collection: ApiCollectionDef; dirty: boolean }

export function ApiWorkspace() {
    const { message, modal } = App.useApp();
    const route = useRoute();
    const here = route[0] === 'api';
    const [meta, setMeta] = React.useState<{ projects: string[]; environments: Record<string, string[]>; collections: ApiCollectionInfo[] } | null>(null);
    const [project, setProjectRaw] = React.useState<string>(() => loadPref('cs-studio-api-project', ''));
    const [env, setEnv] = React.useState<string | undefined>(() => loadPref<string | undefined>('cs-studio-api-env', undefined));
    const [open, setOpen] = React.useState<Open | null>(null);
    const [sel, setSel] = React.useState<string | null>(null); // request id, or null: the collection's settings
    // Folders closed by the person (all open otherwise; a folder a request is added to opens).
    const [collapsed, setCollapsed] = React.useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('cs-api-collapsed') ?? '[]') as string[]); } catch { return new Set(); } });
    React.useEffect(() => { try { localStorage.setItem('cs-api-collapsed', JSON.stringify([...collapsed].slice(-500))); } catch { /* private mode */ } }, [collapsed]);
    const agentRoute = useRoute();
    useAgentContext('api', { project, environment: env, collection: open?.file ?? null, collectionName: open?.collection.name, request: sel }, agentRoute[0] === 'api');
    const [saved, setSaved] = React.useState<Record<string, string>>({});
    const [scopesOpen, setScopesOpen] = React.useState(false);
    const [flowOpen, setFlowOpen] = React.useState(false);
    const [pipeline, setPipeline] = React.useState<{ group: string; schedule: string; yaml: string | null; file?: string; secrets?: string[]; saved?: boolean } | null>(null);
    const docs = async (kind: 'html' | 'md' | 'wiki') => {
        if (!open?.file) return;
        if (open.dirty) { message.info('Save the collection first: the documentation is made from the saved file.'); return; }
        try {
            if (kind === 'wiki') {
                let page = `API/${open.collection.name}`;
                modal.confirm({ title: 'Publish to the Azure DevOps wiki', okText: 'Publish', content: <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary">The project's wiki gets (or updates) this page with the collection's documentation, as Markdown. Your access token needs the Wiki (Read &amp; write) scope.</Typography.Text>
                    <Input defaultValue={page} onChange={(e) => { page = e.target.value; }} aria-label="Wiki page" />
                </Space>, onOk: async () => { try { const r = await api.apiDocsWiki({ file: open.file!, path: page }); message.success(<span>{r.created ? 'Created' : 'Updated'} <a href={r.url} target="_blank" rel="noreferrer">{r.page}</a></span>); } catch (e) { message.error(errText(e)); } } });
                return;
            }
            const text = await api.apiDocs(open.file, kind);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: kind === 'html' ? 'text/html' : 'text/markdown' }));
            a.download = `${open.collection.name.replace(/[^\w.-]+/g, '-')}.${kind}`; a.click(); URL.revokeObjectURL(a.href);
        } catch (e) { message.error(errText(e)); }
    };
    const previewPipeline = async (save = false) => {
        if (!open?.file || !pipeline) return;
        try { const r = await api.apiPipeline({ file: open.file, variableGroup: pipeline.group || undefined, schedule: pipeline.schedule || undefined, save }); setPipeline({ ...pipeline, yaml: r.yaml, file: r.file, secrets: r.secretNames, saved: r.saved }); if (save) message.success(`Saved ${r.file}: commit it, then create the pipeline from it in Azure DevOps.`); }
        catch (e) { message.error(errText(e)); }
    };
    React.useEffect(() => { if (pipeline && pipeline.yaml === null) void previewPipeline(); }, [pipeline?.yaml === null]); // eslint-disable-line react-hooks/exhaustive-deps
    const [result, setResult] = React.useState<Record<string, ApiSendResult>>({});
    const [sending, setSending] = React.useState(false);
    const [importing, setImporting] = React.useState<ImportKind | null>(null);
    const [harOpen, setHarOpen] = React.useState(false);
    const [naming, setNaming] = React.useState(false);
    useUnsaved('api-collection', !!open?.dirty, `the API collection "${open?.collection.name ?? ''}"`);
    const [find, setFind] = React.useState('');
    const [feature, setFeature] = React.useState(false);
    const [correlating, setCorrelating] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);

    const loadMeta = React.useCallback(() => api.apiCollections().then((m) => {
        setMeta(m);
        setProjectRaw((p) => (p && m.projects.includes(p) ? p : m.projects.find((x) => /api/i.test(x)) ?? m.projects[0] ?? ''));
    }).catch((e) => setErr(errText(e))), []);
    React.useEffect(() => { if (here && !meta) void loadMeta(); }, [here, meta, loadMeta]);
    const setProject = (p: string) => { setProjectRaw(p); savePref('cs-studio-api-project', p); setEnv(undefined); };
    const envs = meta?.environments[project] ?? [];
    // An environment is always chosen: the remembered one when this project has it, else its first.
    React.useEffect(() => { if (envs.length && (!env || !envs.includes(env))) setEnv(envs[0]); }, [envs.join(','), env]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (env && envs.length && !envs.includes(env)) setEnv(undefined); }, [envs, env]);

    // The collection in the address: #/api/<file>
    const fileInRoute = here && route[1] ? decodeURIComponent(route.slice(1).join('/')) : null;
    React.useEffect(() => {
        if (!fileInRoute || open?.file === fileInRoute) return;
        api.apiCollection(fileInRoute).then((r) => { setOpen({ file: r.file, project: r.file.split('/')[1], collection: r.collection, dirty: false }); setSel(null); setResult({}); }).catch((e) => setErr(errText(e)));
    }, [fileInRoute]); // eslint-disable-line react-hooks/exhaustive-deps

    // A request restored from History: a copy of it as it was sent, added to its collection (nothing replaced).
    React.useEffect(() => {
        if (!open?.file) return;
        let x: { file: string; def: ApiRequestDef; at: string } | null = null;
        try { x = JSON.parse(sessionStorage.getItem('cs-api-restore') ?? 'null'); } catch { /* none */ }
        if (!x || x.file !== open.file) return;
        sessionStorage.removeItem('cs-api-restore');
        const copy: ApiRequestDef = { ...x.def, id: `r${Date.now().toString(36)}`, name: `${x.def.name} (from ${new Date(x.at).toLocaleString()})` };
        setOpen((o) => (o ? { ...o, collection: { ...o.collection, items: [...o.collection.items, copy] }, dirty: true } : o));
        setSel(copy.id);
        message.info('Restored from History as a copy at the end of the collection: Send it again, or Save to keep it.');
    }, [open?.file]); // eslint-disable-line react-hooks/exhaustive-deps

    const update = (c: ApiCollectionDef) => setOpen((o) => (o ? { ...o, collection: c, dirty: true } : o));
    const req = open && sel ? findItem(open.collection.items, sel) : null;
    const setReq = (r: ApiRequestDef) => open && update({ ...open.collection, items: mapItems(open.collection.items, (it) => (it.id === r.id ? r : it)) });

    // A double click on Save writes once (a new collection would otherwise be created twice).
    const saving = React.useRef(false);
    const save = async (): Promise<boolean> => {
        if (!open || saving.current) return false;
        saving.current = true;
        try { return await saveNow(); } finally { saving.current = false; }
    };
    const saveNow = async (): Promise<boolean> => {
        if (!open) return false;
        const problem = collectionNameProblem(open.collection.name, open.project, collections, open.file);
        if (problem) { message.error(problem); setSel(null); return false; }
        try {
            const r = await api.apiSaveCollection(open.project, open.collection, open.file ?? undefined);
            setOpen({ ...open, file: r.file, dirty: false });
            message.success('Saved');
            await loadMeta();
            if (!open.file) navigate(['api', ...r.file.split('/')], true);
            return true;
        } catch (e) { message.error(errText(e)); return false; }
    };
    const leave = (then: () => void) => {
        if (!open?.dirty) { then(); return; }
        (() => {
            // Save, Discard or Stay (Escape and the close button stay: unsaved changes are never dropped by accident).
            const inst = modal.confirm({ title: `Save the changes to "${open.collection.name}"?`, okText: 'Save', closable: true, onOk: async () => { if (await save()) then(); },
                footer: (_: React.ReactNode, { OkBtn }: { OkBtn: React.FC }) => <><Button onClick={() => inst.destroy()}>Stay</Button><Button danger onClick={() => { inst.destroy(); then(); }}>Discard</Button><OkBtn /></> });
        })();
    };
    const openFile = (file: string) => leave(() => { setOpen(null); navigate(['api', ...file.split('/')]); });
    /** Open a collection that is not saved yet; an imported one opens on its settings (base URL, variables). */
    const startNew = (c0: ApiCollectionDef, settings = false) => leave(() => {
        // An imported collection whose name is in use (the same host imported again) gets the next free one ("… 2").
        let c = c0;
        if (collectionNameProblem(c.name, project, collections)) for (let n = 2; n < 100; n++) { const name = `${c0.name} ${n}`; if (!collectionNameProblem(name, project, collections)) { c = { ...c0, name }; break; } }
        setOpen({ file: null, project, collection: c, dirty: true }); setSel(settings ? null : c.items.find((x) => x.kind === 'request')?.id ?? null); setResult({}); navigate(['api'], true); });

    /** The test data row each request sends with (its scenario's <column> values). */
    const [dataRow, setDataRow] = React.useState<Record<string, { index: number; row?: Record<string, string> }>>({});
    // One request at a time: quick repeated clicks (or Enter) while one is on its way do not send it again.
    const inFlight = React.useRef(false);
    const sendNow = async () => {
        if (!open || !req || req.kind !== 'request' || inFlight.current) return;
        inFlight.current = true;
        setSending(true);
        try {
            const r = await api.apiSend({ project: open.project, env, file: open.file ?? undefined, collection: open.collection, request: req, saved, ...(dataRow[req.id]?.row ? { row: dataRow[req.id].row } : {}) });
            // A {{value}} saved by another request: say which one to send first.
            const savers = (r.prepared.missing ?? []).map((m) => /^\{\{(.+)\}\}$/.exec(m)?.[1]).filter((n): n is string => !!n)
                .map((n) => { const by = allRequests(open.collection.items).find((x) => x.extract.some((e) => e.variable === n)); return by ? `{{${n}}} is saved by "${by.name}": send that first.` : null; })
                .filter(Boolean);
            if (savers.length && r.error) r.error = `${r.error} ${savers.join(' ')}`;
            setResult((x) => ({ ...x, [req.id]: r }));
            const got = (r.extracted ?? []).filter((x) => x.found && x.value !== undefined);
            if (got.length || r.scriptVars) setSaved((s) => ({ ...s, ...Object.fromEntries(got.map((x) => [x.variable, x.value!])), ...(r.scriptVars ?? {}) }));
        } catch (e) { message.error(errText(e)); }
        finally { setSending(false); inFlight.current = false; }
    };

    const addItem = (kind: 'request' | 'folder', inFolder?: string) => {
        if (!open) return;
        const it: ApiItemDef = kind === 'request' ? newRequest() : { kind: 'folder', id: rid(), name: 'New folder', items: [] };
        const items = inFolder ? mapItems(open.collection.items, (x) => (x.id === inFolder && x.kind === 'folder' ? { ...x, items: [...x.items, it] } : x)) : [...open.collection.items, it];
        update({ ...open.collection, items });
        if (kind === 'request') setSel(it.id);
        if (inFolder) setCollapsed((c) => { const n = new Set(c); n.delete(inFolder); return n; });
    };
    const removeItem = (id: string) => open && modal.confirm({ title: (() => {
        const it = findItem(open.collection.items, id);
        if (!it) return 'Remove it from the collection?';
        if (it.kind !== 'folder') return `Remove the request "${it.name}" from the collection?`;
        let n = 0; const walk = (xs: ApiItemDef[]) => { for (const x of xs) if (x.kind === 'folder') walk(x.items); else n++; }; walk(it.items);
        return `Remove the folder "${it.name}"${n ? ` and its ${n} request${n === 1 ? '' : 's'}` : ' (empty)'}?`;
    })(), content: 'Nothing is written until you Save.', okText: 'Remove', okButtonProps: { danger: true }, onOk: () => { update({ ...open.collection, items: mapItems(open.collection.items, (x) => (x.id === id ? null : x)) }); if (sel === id) setSel(null); } });
    /** A name asked in a dialog: trimmed, not empty (an empty name keeps the old one). */
    const askName = (title: string, current: string, done: (name: string) => void) => {
        let v = current;
        // Rename stays off while the name is empty (no error thrown from the dialog).
        const inst = modal.confirm({ title, icon: null, okText: 'Rename', autoFocusButton: null, okButtonProps: { disabled: !current.trim() },
            content: <Input autoFocus ref={(el) => { if (el) setTimeout(() => el.focus({ cursor: 'all' }), 60); }} defaultValue={current} maxLength={200} aria-label="Name" placeholder="A name"
                onChange={(e) => { v = e.target.value; inst.update({ okButtonProps: { disabled: !v.trim() } }); }}
                onPressEnter={() => { const n = v.trim(); if (!n) return; if (n !== current) done(n); inst.destroy(); }} />,
            onOk: () => { const n = v.trim(); if (n && n !== current) done(n); } });
    };
    const renameFolder = (id: string, name: string) => open && update({ ...open.collection, items: mapItems(open.collection.items, (x) => (x.id === id ? { ...x, name } : x)) });

    const onCollection = async (text: string, envText?: string) => {
        const r = await api.apiImportCollection(text, envText);
        const secrets = Object.entries(r.report.secrets);
        startNew(r.collection, true);
        modal.info({
            title: `Imported "${r.collection.name}"`, width: 620,
            content: <Space direction="vertical">
                <span>{r.report.requests} request{r.report.requests === 1 ? '' : 's'} in {r.report.folders} folder{r.report.folders === 1 ? '' : 's'}. {r.report.converted} script line{r.report.converted === 1 ? '' : 's'} became checks or saved values{r.report.notConverted ? `; ${r.report.notConverted} could not be converted (shown on each request)` : ''}.</span>
                {r.report.warnings.map((w, i) => <Typography.Text key={i} type="warning">• {w}</Typography.Text>)}
                {secrets.length > 0 && <Alert type="info" showIcon message={`${secrets.length === 1 ? 'A secret value' : `${secrets.length} secret values`} (${secrets.map(([k]) => k).join(', ')}) ${secrets.length === 1 ? 'was' : 'were'} not written to the collection.`}
                    action={<Button size="small" onClick={async () => { try { for (const [k, v] of secrets) await api.setSecret(k, v, env); message.success('Stored as Studio secrets'); } catch (e) { message.error(errText(e)); } }}>Store them as secrets</Button>} />}
                <Typography.Text type="secondary">Check the requests, then Save. Nothing is written until you do.</Typography.Text>
            </Space>,
        });
    };
    const onHar = (r: Awaited<ReturnType<typeof api.apiImportHar>>) => {
        const secrets = Object.entries(r.report.secrets);
        startNew(r.collection, true);
        modal.info({ title: `Imported "${r.collection.name}"`, width: 620, content: <Space direction="vertical">
            <span>{r.report.imported} request{r.report.imported === 1 ? '' : 's'}; {r.report.correlations.length} value{r.report.correlations.length === 1 ? '' : 's'} correlated. Each request checks the status it got when it was recorded.</span>
            {secrets.length > 0 && <Alert type="info" showIcon message={`${secrets.length === 1 ? 'A recorded credential' : `${secrets.length} recorded credentials`} (${secrets.map(([k]) => k).join(', ')}) ${secrets.length === 1 ? 'was' : 'were'} not written to the collection.`}
                action={<Button size="small" onClick={async () => { try { for (const [k, v] of secrets) await api.setSecret(k, v, env); message.success('Stored as Studio secrets'); } catch (e) { message.error(errText(e)); } }}>Store them as secrets</Button>} />}
            <Typography.Text type="secondary">Send the requests once to check them, then Save. Nothing is written until you do.</Typography.Text>
        </Space> });
    };
    const onOpenApi = async (text: string) => {
        const r = await api.apiImportOpenApi(text);
        startNew(r.collection, true);
        modal.info({ title: `Imported "${r.collection.name}"`, width: 600, content: <Space direction="vertical">
            <span>{r.report.operations} operation{r.report.operations === 1 ? '' : 's'}{r.report.folders > 1 ? ` in ${r.report.folders} folders` : ''}. Fill in the variables (ids, tokens) under the collection's settings, then Save.</span>
            {r.report.warnings.map((w, i) => <Typography.Text key={i} type="warning">• {w}</Typography.Text>)}
        </Space> });
    };
    const onOther = async (text: string) => {
        const r = await api.apiImportOther(text);
        startNew(r.collection, true);
        modal.info({ title: `Imported "${r.collection.name}" (${r.format})`, width: 640, content: <Space direction="vertical">
            <span>{r.report.requests} request{r.report.requests === 1 ? '' : 's'}{r.report.folders ? ` in ${r.report.folders} folder${r.report.folders === 1 ? '' : 's'}` : ''}. Check the variables under the collection's settings, then Save.</span>
            {r.report.warnings.map((w, i) => <Typography.Text key={i} type="warning">• {w}</Typography.Text>)}
        </Space> });
    };
    const onWsdl = async (b: { text?: string; url?: string }) => {
        const r = await api.apiImportWsdl(b);
        startNew(r.collection, true);
        modal.info({ title: `Imported "${r.collection.name}"`, width: 600, content: <Space direction="vertical">
            <span>{r.report.operations} operation{r.report.operations === 1 ? '' : 's'} of {r.report.services} service{r.report.services === 1 ? '' : 's'}. Fill in the {'{{values}}'} of each envelope (or the collection's variables), then Save.</span>
            {r.report.warnings.map((w, i) => <Typography.Text key={i} type="warning">• {w}</Typography.Text>)}
        </Space> });
    };
    const duplicate = (id: string) => {
        if (!open) return;
        const it = findItem(open.collection.items, id);
        if (!it || it.kind !== 'request') return;
        const copy: ApiRequestDef = { ...JSON.parse(JSON.stringify(it)), id: rid(), name: `${it.name} (copy)` };
        const insert = (items: ApiItemDef[]): ApiItemDef[] => items.flatMap((x) => (x.id === id ? [x, copy] : x.kind === 'folder' ? [{ ...x, items: insert(x.items) }] : [x]));
        update({ ...open.collection, items: insert(open.collection.items) });
        setSel(copy.id);
    };
    /** Drag and drop in the tree: before/after an item, or into a folder. */
    const move = (dragId: string, targetId: string, into: boolean, after: boolean) => {
        if (!open || dragId === targetId) return;
        const dragged = findItem(open.collection.items, dragId);
        if (!dragged || (dragged.kind === 'folder' && findItem(dragged.items, targetId))) return;
        const without = mapItems(open.collection.items, (x) => (x.id === dragId ? null : x));
        const put = (items: ApiItemDef[]): ApiItemDef[] => items.flatMap((x) => {
            if (x.id === targetId) return into && x.kind === 'folder' ? [{ ...x, items: [dragged, ...x.items] }] : after ? [x, dragged] : [dragged, x];
            return x.kind === 'folder' ? [{ ...x, items: put(x.items) }] : [x];
        });
        update({ ...open.collection, items: put(without) });
    };
    const exportFile = async () => {
        if (!open) return;
        try {
            const { collection: json, warnings } = await api.apiExport(open.collection);
            if (warnings.length) Modal.info({ title: 'Exported, with notes', width: 620, content: <ul style={{ paddingLeft: 18 }}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }));
            a.download = `${open.collection.name.replace(/[^\w.-]+/g, '_')}.collection.v2.1.json`; a.click(); URL.revokeObjectURL(a.href);
        } catch (e) { message.error(errText(e)); }
    };
    const matches = (it: ApiItemDef): boolean => !find || (it.kind === 'folder' ? it.items.some(matches) : `${it.name} ${it.method} ${it.url}`.toLowerCase().includes(find.toLowerCase()));
    const onCurl = async (text: string) => {
        const r = await api.apiImportCurl(text);
        if (open) { update({ ...open.collection, items: [...open.collection.items, r.request] }); setSel(r.request.id); }
        else startNew({ ...newCollection('New collection'), items: [r.request] });
        if (r.warnings.length) modal.warning({ title: 'Imported, with notes', content: <ul>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> });
    };

    // Tree of the open collection
    const treeData = (items: ApiItemDef[]): Array<{ key: string; title: React.ReactNode; isLeaf?: boolean; children?: unknown[] }> => items.filter(matches).map((it) => it.kind === 'folder'
        ? { key: it.id, title: <span className="api-node"><FolderOutlined /> <span className="t">{it.name}</span><Dropdown trigger={['click']} menu={{ items: [{ key: 'r', label: 'Add request' }, { key: 'n', label: 'Rename' }, { key: 'd', label: 'Remove', danger: true }], onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); if (key === 'r') addItem('request', it.id); else if (key === 'd') removeItem(it.id); else askName('Rename folder', it.name, (v) => renameFolder(it.id, v)); } }}><Button size="small" type="text" className="node-more" onClick={(e) => e.stopPropagation()}>⋯</Button></Dropdown></span>, children: treeData(it.items) }
        : { key: it.id, isLeaf: true, title: <span className="api-node"><span className="method" style={{ color: it.ws ? protocolOf(it.ws).color : methodColor(it.method) }}>{it.ws ? protocolOf(it.ws).short : it.method}</span><span className="t">{it.name}</span>{result[it.id]?.checks && <span>{result[it.id].checks!.every((c) => c.pass) ? <CheckCircleFilled style={{ color: '#389e0d', fontSize: 11 }} /> : <CloseCircleFilled style={{ color: '#cf1322', fontSize: 11 }} />}</span>}<Dropdown trigger={['click']} menu={{ items: [{ key: 'ren', label: 'Rename' }, { key: 'dup', label: 'Duplicate' }, { key: 'del', label: 'Remove', danger: true }], onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); if (key === 'dup') duplicate(it.id); else if (key === 'ren') askName('Rename request', it.name, (v) => renameFolder(it.id, v)); else removeItem(it.id); } }}><Button size="small" type="text" className="node-more" onClick={(e) => e.stopPropagation()} aria-label="Request actions">⋯</Button></Dropdown></span> });

    const collections = (meta?.collections ?? []).filter((c) => c.project === project);
    const nameProblem = (n: string) => collectionNameProblem(n, open?.project ?? project, collections, open?.file);
    return (<>
        <Split id="api-tree" initial={300} min={220} max={520} style={{ height: 'calc(100vh - var(--chrome))' }}>
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="toolbar" style={{ display: 'block' }}>
                    <div className="filter-row">
                        <Select size="small" style={{ flex: 1, minWidth: 110 }} value={project || undefined} placeholder="Project" onChange={setProject} options={(meta?.projects ?? []).map((p) => ({ value: p, label: p }))} aria-label="Project" />
                        <Select size="small" style={{ width: 96 }} value={env} placeholder={envs.length ? envs[0] : 'No environments'} onChange={(v) => { setEnv(v); savePref('cs-studio-api-env', v); }} options={envs.map((e) => ({ value: e, label: e }))} aria-label="Environment" disabled={!envs.length} />
                    </div>
                    <div className="filter-row">
                        <Dropdown menu={{ items: [{ key: 'c', icon: <ApiOutlined />, label: 'New collection' }, { key: 'p', icon: <ImportOutlined />, label: 'Import a collection file…' }, { key: 'o', icon: <ImportOutlined />, label: 'Import an OpenAPI / Swagger file…' }, { key: 'w', icon: <ImportOutlined />, label: 'Import a SOAP service (WSDL)…' }, { key: 'x', icon: <ImportOutlined />, label: 'Import from Insomnia, SoapUI, JMeter, RAML, AsyncAPI, GraphQL…' }, { key: 'ai', icon: <ApiOutlined />, label: 'Draft requests with Copilot from a story or a spec…' }, { key: 'h', icon: <ImportOutlined />, label: 'Import a browser recording (HAR)…' }, { key: 'u', icon: <ImportOutlined />, label: 'Import a cURL command…' }],
                            onClick: ({ key }) => { if (key === 'ai') { askCopilot('Draft API requests for this story (with their checks and the values passed between them), as a collection of this project:\n\n<paste the story, acceptance criteria or the part of the API description here>'); return; } if (key === 'c') setNaming(true); else if (key === 'h') setHarOpen(true); else setImporting(key === 'p' ? 'collection' : key === 'o' ? 'openapi' : key === 'w' ? 'wsdl' : key === 'x' ? 'other' : 'curl'); } }}>
                            <Button size="small" type="primary" icon={<PlusOutlined />}>New <DownOutlined /></Button>
                        </Dropdown>
                    </div>
                </div>
                {err && <Alert type="error" showIcon closable onClose={() => setErr(null)} style={{ margin: 8 }} message={err} />}
                <div style={{ overflow: 'auto', maxHeight: '34%', borderBottom: '1px solid var(--panel-border)' }}>
                    {meta === null ? <Spin style={{ margin: 16 }} /> : collections.length === 0 && !open ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<>No API collections in {project || 'this project'} yet.<br />New → New collection, or import a collection file.</>} />
                        : collections.map((c) => (
                            <div key={c.file} className={`item-row${open?.file === c.file ? ' selected' : ''}`} onClick={() => openFile(c.file)}>
                                <div className="item-title"><ApiOutlined /><span className="t">{c.name}</span><span className="item-id">{open?.file === c.file && open.dirty ? (() => { let n = 0; const w = (xs: ApiItemDef[]) => { for (const x of xs) if (x.kind === 'folder') w(x.items); else n++; }; w(open.collection.items); return n; })() : c.requests}</span></div>
                            </div>
                        ))}
                    {open && !open.file && <div className="item-row selected"><div className="item-title"><ApiOutlined /><span className="t">{open.collection.name}</span><Tag bordered={false} color="warning">not saved</Tag></div></div>}
                </div>
                {open && <>
                    <div className="toolbar">
                        <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0 }} title="Click to rename"
                            editable={{ tooltip: 'Rename the collection', triggerType: ['text', 'icon'], onChange: (v) => { const p = nameProblem(v); if (p) { message.error(p); return; } if (v.trim() !== open.collection.name) update({ ...open.collection, name: v.trim() }); },
                                onEnd: () => { if (open.file) message.info(`Renamed. The file stays ${open.file}; Save to keep the new name.`, 4); } }}>{open.collection.name}</Typography.Text>
                        {open.dirty && <span className="dirty-dot" title="Not saved" />}
                        <Tooltip title="Collection settings: base URL, variables, authentication"><Button aria-label="Collection settings: base URL, variables, authentication" size="small" icon={<SettingOutlined />} type={sel === null ? 'primary' : 'default'} ghost={sel === null} onClick={() => setSel(null)} /></Tooltip>
                        <Tooltip title="New request"><Button aria-label="New request" size="small" icon={<FileAddOutlined />} onClick={() => addItem('request')} /></Tooltip>
                        <Tooltip title="New folder"><Button aria-label="New folder" size="small" icon={<FolderAddOutlined />} onClick={() => addItem('folder')} /></Tooltip>
                    </div>
                    <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
                        {countRequests(open.collection.items) === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No requests yet" />
                            : <>
                                <div style={{ padding: '2px 10px 6px' }}><Input size="small" allowClear placeholder="Find a request" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a request" /></div>
                                {find.trim() && !treeData(open.collection.items).length ? <Typography.Text type="secondary" style={{ display: 'block', padding: '8px 12px' }}>No request matches "{find.trim()}"</Typography.Text> : (
                                <Tree blockNode draggable={!find && { icon: false }}
                                    expandedKeys={(() => { const ids: string[] = []; const walk = (xs: ApiItemDef[]) => { for (const x of xs) if (x.kind === 'folder') { if (find || !collapsed.has(x.id)) ids.push(x.id); walk(x.items); } }; walk(open.collection.items); return ids; })()}
                                    onExpand={(_k, info) => setCollapsed((c) => { const n = new Set(c); const id = String(info.node.key); if (info.expanded) n.delete(id); else n.add(id); return n; })} selectedKeys={sel ? [sel] : []} treeData={treeData(open.collection.items) as never}
                                    onSelect={(k) => { const id = String(k[0] ?? ''); const it = id && findItem(open.collection.items, id); if (it && it.kind === 'request') setSel(id); }}
                                    onDrop={(info) => { const rel = info.dropPosition - Number(String(info.node.pos).split('-').pop()); move(String(info.dragNode.key), String(info.node.key), !info.dropToGap, rel > 0); }} />
                                )}
                            </>}
                    </div>
                    <div className="toolbar" style={{ borderTop: '1px solid var(--panel-border)', borderBottom: 0 }}>
                        <Button size="small" onClick={() => setScopesOpen(true)}>Variables</Button>
                        <Button size="small" onClick={() => setFlowOpen(true)}>Flow</Button>
                        {Object.keys(saved).length > 0 && <>
                            <Tooltip title={<pre style={{ margin: 0 }}>{Object.entries(saved).map(([k, v]) => `{{${k}}} = ${v}`).join('\n')}</pre>}><Typography.Text type="secondary" style={{ fontSize: 12 }}>{Object.keys(saved).length} saved value{Object.keys(saved).length === 1 ? '' : 's'}</Typography.Text></Tooltip>
                            <Button size="small" type="link" onClick={() => setSaved({})}>Clear</Button>
                        </>}
                    </div>
                </>}
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {!open ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="Open a collection, or create one with New" /> : <>
                    <div className="toolbar">
                        <Typography.Text type="secondary" style={{ flex: 1, fontSize: 12 }} ellipsis>{open.file ?? `Not saved yet — will be test/${open.project}/api/…`}</Typography.Text>
                        <Button size="small" icon={<SaveOutlined />} type={open.dirty ? 'primary' : 'default'} onClick={() => void save()}>Save</Button>
                        <Tooltip title="Run every request in order, with checks, and get a report"><Button size="small" icon={<CaretRightOutlined />} disabled={countRequests(open.collection.items) === 0} onClick={() => leave(() => navigate(['api-runner', ...(open.file ? open.file.split('/') : [])]))}>Run collection</Button></Tooltip>
                        <Tooltip title={countRequests(open.collection.items) < 2 ? 'Needs at least 2 requests: a value is correlated when a later request sends what an earlier one received' : 'Replay the requests twice and save the values that change (tokens, ids) where later requests send them fixed'}><Button size="small" disabled={countRequests(open.collection.items) < 2} onClick={() => setCorrelating(true)}>Correlate</Button></Tooltip>
                        <Tooltip title="Write a framework feature (Gherkin) that runs these requests with the framework's API steps"><Button size="small" icon={<ExperimentOutlined />} disabled={countRequests(open.collection.items) === 0} onClick={() => setFeature(true)}>Create test</Button></Tooltip>
                        <Dropdown menu={{ items: [{ key: 'exp', label: 'Export as a collection v2.1 file' }, ...(open.file ? [{ key: 'doc-html', label: 'Documentation (HTML page)' }, { key: 'doc-md', label: 'Documentation (Markdown)' }, { key: 'doc-wiki', label: 'Publish the documentation to the Azure DevOps wiki…' }, { key: 'pipe', label: 'Run it in a pipeline…' }, { key: 'del', danger: true, label: 'Delete this collection…' }] : [])], onClick: ({ key }) => (key === 'exp' ? void exportFile() : key.startsWith('doc-') ? void docs(key.slice(4) as 'html') : key === 'pipe' ? leave(() => setPipeline({ group: '', schedule: '', yaml: null })) : modal.confirm({ title: `Delete "${open.collection.name}"?`, content: `${open.file} is deleted from the project (Git keeps it in history if it was committed).`, okText: 'Delete', okButtonProps: { danger: true }, onOk: async () => { try { await api.apiDeleteCollection(open.file!); setOpen(null); navigate(['api']); await loadMeta(); } catch (e) { message.error(errText(e)); } } })) }}><Button size="small">⋯</Button></Dropdown>
                    </div>
                    <AuthContext.Provider value={{ project: open.project, env: env ?? envs[0], collection: open.collection }}>
                    {req && req.kind === 'request'
                        ? <Split id="api-response" direction="column" sizeOf="second" initial={300} min={120} max={900} style={{ flex: 1, minHeight: 0 }}>
                            <RequestEditor key={req.id} saved={saved} file={open.file} req={req} onChange={setReq} onSend={() => void sendNow()} sending={sending} result={result[req.id] ?? null}
                                project={open.project} env={env} row={dataRow[req.id]?.index ?? 0} onRow={(index, row) => setDataRow((x) => ({ ...x, [req.id]: { index, row } }))} />
                            <div style={{ height: '100%', minHeight: 0, borderTop: '1px solid var(--panel-border)' }}><ResponseView result={result[req.id] ?? null} sending={sending}
                                onSaveExample={req.ws ? undefined : () => {
                                    const res = result[req.id]?.response;
                                    if (!res) return;
                                    let query: Record<string, string> = {};
                                    try { query = Object.fromEntries(new URL(result[req.id]!.prepared.url).searchParams); } catch { /* no query */ }
                                    const headers = Object.fromEntries(Object.entries(res.headers).filter(([k]) => /^(content-type|location|etag|cache-control|x-[\w-]+)$/i.test(k)).map(([k, v]) => [k.replace(/(^|-)\w/g, (c) => c.toUpperCase()), v]));
                                    const ex = { id: `ex${Date.now().toString(36)}`, name: `${res.status} ${res.statusText}`.trim(), status: res.status, ...(Object.keys(headers).length ? { headers } : {}), body: res.body, ...(Object.keys(query).length ? { when: { query } } : {}) };
                                    setReq({ ...req, examples: [...(req.examples ?? []), ex] });
                                    message.success(`Saved as example "${ex.name}" (Examples tab)`);
                                }}
                                onRemoveCookie={(name, domain) => { if (!open) return; void api.apiClearCookies(open.project, env, open.collection.name, name, domain).then((x) => setResult((all) => ({ ...all, [req.id]: { ...all[req.id], cookies: x.cookies } }))).catch((e) => message.error(errText(e))); }} /></div>
                        </Split>
                        : <CollectionSettings c={open.collection} onChange={update} project={open.project} env={env ?? envs[0]} />}
                    </AuthContext.Provider>
                </>}
            </div>
        </Split>
        {open && <ScopesDrawer open={scopesOpen} project={open.project} env={env ?? envs[0]} collection={open.collection} saved={saved} onClose={() => setScopesOpen(false)} onForget={(name) => setSaved((x) => { const n = { ...x }; delete n[name]; return n; })} />}
        {naming && <NewCollection project={project} problem={(n) => collectionNameProblem(n, project, collections)} onClose={() => setNaming(false)}
            onCreate={(name) => { setNaming(false); startNew({ ...newCollection(name), items: [newRequest()] }, true); }} />}
        {open && <Drawer open={flowOpen} width="80%" title={`Flow of ${open.collection.name}`} onClose={() => setFlowOpen(false)} destroyOnClose>
            <FlowView collection={open.collection} onOpen={(id) => { setSel(id); setFlowOpen(false); }} />
        </Drawer>}
        <Modal open={!!pipeline} width={820} title="Run this collection in a pipeline" onCancel={() => setPipeline(null)}
            footer={pipeline ? <Space><Button onClick={() => void navigator.clipboard?.writeText(pipeline.yaml ?? '').then(() => message.success('Copied'))}>Copy</Button><Button type="primary" disabled={!pipeline.yaml} onClick={() => void previewPipeline(true)}>{pipeline.saved ? 'Saved' : `Save as ${pipeline.file?.split('/').pop() ?? 'a file'}`}</Button></Space> : null}>
            {pipeline && <Space direction="vertical" style={{ width: '100%' }}>
                <Tooltip title="Runs on changes to the collection (and on a schedule), for the environment chosen when it runs, and publishes the results as test results. The same command runs on any machine with the project installed."><Typography.Text type="secondary" style={{ fontSize: 12 }}>A pipeline that runs <Typography.Text code>npx cs-test-studio run {open?.file}</Typography.Text>.</Typography.Text></Tooltip>
                <Space wrap>
                    <Input style={{ width: 260 }} value={pipeline.group} placeholder="Variable group with the secrets" onChange={(e) => setPipeline({ ...pipeline, group: e.target.value })} onBlur={() => void previewPipeline()} aria-label="Variable group" />
                    <Select style={{ width: 260 }} value={pipeline.schedule} onChange={(v) => { setPipeline({ ...pipeline, schedule: v, yaml: null }); }} aria-label="Schedule"
                        options={[{ value: '', label: 'No schedule (on changes only)' }, { value: '0 6 * * 1-5', label: 'Weekdays at 06:00 (UTC)' }, { value: '0 */4 * * *', label: 'Every 4 hours' }, { value: '0 2 * * *', label: 'Every night at 02:00 (UTC)' }]} />
                </Space>
                {pipeline.secrets?.length ? <Alert type="info" showIcon message={<span>The collection reads {pipeline.secrets.map((n) => <Typography.Text key={n} code>{n}</Typography.Text>)}: add {pipeline.secrets.length === 1 ? 'it' : 'them'} to the variable group as secret variables.</span>} /> : null}
                <pre className="code-box" style={{ maxHeight: 420 }}>{pipeline.yaml ?? 'Preparing…'}</pre>
            </Space>}
        </Modal>
        <HarModal open={harOpen} onClose={() => setHarOpen(false)} onImported={onHar} />
        <ImportModal open={!!importing} kind={importing ?? 'collection'} onClose={() => setImporting(null)} onCollection={onCollection} onCurl={onCurl} onOpenApi={onOpenApi} onWsdl={onWsdl} onOther={onOther} />
        {open && <CorrelateModal open={correlating} project={open.project} env={env ?? envs[0]} collection={open.collection} onClose={() => setCorrelating(false)} onApply={(c) => update(c)} />}
        {open && <FeatureModal open={feature} project={open.project} env={env ?? envs[0]} collection={open.collection} onClose={() => setFeature(false)} />}
    </>);
}

/** A new collection: its name first (the file it will be saved as, shown; empty and taken names refused). */
function NewCollection({ project, problem, onClose, onCreate }: { project: string; problem: (name: string) => string | null; onClose: () => void; onCreate: (name: string) => void }) {
    const [name, setName] = React.useState('');
    const [touched, setTouched] = React.useState(false);
    const p = problem(name);
    const input = React.useRef<InputRef>(null);
    // Focus stays in the name (also after Create with a problem, so Escape still closes the dialog).
    const go = () => { setTouched(true); if (!p) onCreate(name.trim()); else input.current?.focus(); };
    return (
        <Modal open title="New collection" okText="Create" onOk={go} onCancel={onClose} okButtonProps={{ disabled: !name.trim() || (touched && !!p) }} destroyOnClose
            afterOpenChange={(o) => { if (o) input.current?.focus(); }}>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Input ref={input} autoFocus value={name} maxLength={200} placeholder="e.g. Orders API" aria-label="Collection name" status={touched && p ? 'error' : undefined}
                    onChange={(e) => { setName(e.target.value); setTouched(true); }} onPressEnter={go} />
                {touched && p ? <Typography.Text type="danger" style={{ fontSize: 12 }}>{p}</Typography.Text>
                    : <Typography.Text type="secondary" style={{ fontSize: 12 }}>Saved as test/{project}/api/{collectionSlug(name || 'name')}.collection.json</Typography.Text>}
            </Space>
        </Modal>
    );
}
