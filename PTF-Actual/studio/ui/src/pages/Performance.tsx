/**
 * Performance: load scenarios (a user path made of an API collection's requests, data, think time,
 * pacing, a load policy and service levels) and their runs: live charts while they run, then
 * transactions, SLAs, comparison with an earlier run, and a JUnit file for pipelines.
 */
import React from 'react';
import { DataSourceEditor } from '../components/DataSourceEditor';
import { Alert, App, Button, Checkbox, Col, Collapse, Dropdown, Empty, Form, Input, InputNumber, Modal, Progress, Row, Segmented, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography, Upload } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, DashboardOutlined, DeleteOutlined, DownloadOutlined, ImportOutlined, PlusOutlined, QuestionCircleOutlined, SaveOutlined, StopOutlined } from '@ant-design/icons';
import { api, ApiCollectionDef, ApiCollectionInfo, BrowserActionDef, BrowserPathDef, BrowserPathInfo, LoadErrorSample, LoadMonitorDef, LoadPolicyDef, LoadPopulationDef, LoadRunDetailDef, LoadRunInfoDef, LoadPhases, LoadScenarioDef, LoadSla, LoadSlaLevels, LoadSlaProfileInfo, LoadTx, LoadWanDef, LoadAnalysisDef, LoadRangeTx, LoadTeamRunDef, LoadGeneratorDef, LoadGeneratorHealth, LoadScheduleDef, LoadInsightsDef, LoadExplainDef, LoadCompareDef } from '../api';
import { useUnsaved } from '../unsaved';
import { errText } from '../state';
import { navigate, useRoute } from '../route';
import { askCopilot, useAgentContext } from '../agentContext';
import { Split } from '../components/Split';
import { LineChart } from '../components/LineChart';
import { curveFromCsv, curveProblems, policyCurve, validPolicy } from '../../../src/load/policy';
import { ago } from '../format';
import { LogicEditor } from '../components/LogicEditor';
import { RecordPathModal } from '../components/RecordPathModal';
import { SectionTitle, shownTab, useRememberedTab } from '../apiperf-ui';

const C = { users: '#8250df', rps: '#0969da', avg: '#1a7f37', p95: '#bf8700', errors: '#cf222e' };
const dur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${Math.round(s % 60)} s` : ''}` : `${Math.round(s)} s`);
const ms = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const loadPref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const savePref = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

function newScenario(name: string, collection: string): LoadScenarioDef {
    return { format: 'cs-studio-load/1', name, collection, requests: [], thinkTime: { min: 1000, max: 3000 }, pacing: 0, timeout: 30_000, policy: { type: 'ramp', users: 10, duration: 300, rampUp: 60, rampDown: 30 }, slas: [{ target: '*', p95: 1000, errorRate: 1 }] };
}
type Req = { id: string; name: string; method: string; recordedThinkMs?: number };
/** A recorded browser step in words. */
const VERB: Record<string, string> = { click: 'Click', fill: 'Fill', type: 'Fill', select: 'Select', navigate: 'Open', check: 'Check', uncheck: 'Uncheck', hover: 'Hover', press: 'Press', assertion: 'Check', validation: 'Check', verify: 'Check', wait: 'Wait', conditional: 'If', dialog_accept: 'Accept the next dialog', dialog_dismiss: 'Dismiss the next dialog' };
/** A recorded browser step in words (as in the results: src/load/browserPath.ts actionLabel). */
const stepText = (a: BrowserActionDef): string => a.description || `${VERB[a.type] ?? a.type} ${a.semanticOverride || (a.element?.text?.trim() ? `"${a.element.text.trim()}"` : '') || a.selector || a.url || a.key || ''}`.trim();
const flatRequests = (c: ApiCollectionDef): Req[] => {
    const out: Req[] = [];
    const walk = (items: ApiCollectionDef['items']) => { for (const it of items) { if (it.kind === 'folder') walk(it.items); else out.push({ id: it.id, name: it.name, method: it.method, ...(it.recordedThinkMs !== undefined ? { recordedThinkMs: it.recordedThinkMs } : {}) }); } };
    walk(c.items);
    return out;
};

// ---------------------------------------------------------------- editors

/** Another user path of the scenario: what it runs and its share of the users. */
function PopulationRow({ p, index, onChange, onRemove, collections, browserPaths, onReqs }: { p: LoadPopulationDef; index: number; onChange: (p: LoadPopulationDef) => void; onRemove: () => void; collections: ApiCollectionInfo[]; browserPaths: BrowserPathInfo[]; onReqs: (i: number, r: Req[]) => void }) {
    const [reqs, setReqs] = React.useState<Req[] | null>(null);
    React.useEffect(() => {
        setReqs(null);
        if (p.collection && !p.browserPath) api.apiCollection(p.collection).then((r) => { const l = flatRequests(r.collection); setReqs(l); onReqs(index, l); }).catch(() => setReqs([]));
        else onReqs(index, []);
    }, [p.collection, p.browserPath]); // eslint-disable-line react-hooks/exhaustive-deps
    const browser = p.browserPath !== undefined;
    return (
        <div className="pop-row">
            <Input size="small" style={{ width: 160 }} value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} placeholder="Name, e.g. Buyers" aria-label="User path name" />
            <Segmented size="small" value={browser ? 'browser' : 'api'} onChange={(k) => onChange(k === 'browser' ? { name: p.name, share: p.share, requests: [], browserPath: browserPaths[0]?.file ?? '' } : { name: p.name, share: p.share, requests: [], collection: collections[0]?.file ?? '' })}
                options={[{ value: 'api', label: 'API', disabled: !collections.length }, { value: 'browser', label: 'Browser', disabled: !browserPaths.length }]} />
            {browser
                ? <Select size="small" style={{ width: 260 }} value={p.browserPath || undefined} onChange={(v) => onChange({ ...p, browserPath: v })} aria-label="Browser path" options={browserPaths.map((b) => ({ value: b.file, label: `${b.name} (${b.actions} steps)` }))} />
                : <Select size="small" style={{ width: 260 }} value={p.collection || undefined} onChange={(v) => onChange({ ...p, collection: v, requests: [] })} aria-label="Collection" options={collections.map((c) => ({ value: c.file, label: `${c.name} (${c.requests})` }))} />}
            {!browser && <Select size="small" mode="multiple" maxTagCount="responsive" style={{ width: 260 }} placeholder="All requests, in order" value={p.requests} loading={reqs === null} onChange={(v) => onChange({ ...p, requests: (reqs ?? []).map((r) => r.id).filter((id) => v.includes(id)) })} aria-label="Requests"
                options={(reqs ?? []).map((r, i) => ({ value: r.id, label: `${i + 1}. ${r.method} ${r.name}` }))} />}
            {!p.policy && <InputNumber size="small" min={1} max={99} value={p.share} onChange={(v) => onChange({ ...p, share: Math.round(v ?? 10) })} addonAfter="% of users" style={{ width: 150 }} aria-label="Share of users" />}
            <Tooltip title="Its own users over time (and start / stop), instead of a share of the scenario's"><Checkbox checked={!!p.policy} onChange={(e) => onChange({ ...p, policy: e.target.checked ? { type: 'constant', users: 5, duration: 300 } : undefined })}>Own load</Checkbox></Tooltip>
            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={onRemove} aria-label="Remove user path" />
            {p.policy && <div style={{ width: '100%', paddingInlineStart: 12, borderInlineStart: '2px solid var(--panel-border)' }}>
                <Space wrap style={{ marginBottom: 6 }}>
                    <InputNumber size="small" min={0} value={p.startDelay} placeholder="0" addonBefore="Start after" addonAfter="s" onChange={(v) => onChange({ ...p, startDelay: v ?? undefined })} style={{ width: 180 }} aria-label="Start after" />
                    <InputNumber size="small" min={1} value={p.stopAfter} placeholder="the end" addonBefore="Stop at" addonAfter="s" onChange={(v) => onChange({ ...p, stopAfter: v ?? undefined })} style={{ width: 190 }} aria-label="Stop at" />
                </Space>
                <PolicyEditor p={p.policy} onChange={(policy) => onChange({ ...p, policy })} />
            </div>}
            <div style={{ width: '100%' }}><WanEditor value={p.wan} onChange={(wan) => onChange({ ...p, wan })} /></div>
        </div>
    );
}

/** Network emulation of a kind of user: a slower, farther network (mobile, another continent) that loses requests. */
function WanEditor({ value, onChange }: { value?: LoadWanDef; onChange: (w: LoadWanDef | undefined) => void }) {
    const set = (x: Partial<LoadWanDef>) => { const n = Object.fromEntries(Object.entries({ ...(value ?? {}), ...x }).filter(([, v]) => v !== undefined && v !== null && v !== 0)); onChange(Object.keys(n).length ? n : undefined); };
    const preset = (w: LoadWanDef | undefined) => () => onChange(w);
    return (
        <Space wrap size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Network</Typography.Text>
            <InputNumber size="small" min={0} value={value?.latencyMs} placeholder="0" addonBefore="+" addonAfter="ms" onChange={(v) => set({ latencyMs: v ?? undefined })} style={{ width: 130 }} aria-label="Added latency" />
            <InputNumber size="small" min={0} value={value?.bandwidthKbps} placeholder="no limit" addonAfter="kbit/s" onChange={(v) => set({ bandwidthKbps: v ?? undefined })} style={{ width: 160 }} aria-label="Bandwidth" />
            <InputNumber size="small" min={0} max={100} value={value?.lossPercent} placeholder="0" addonAfter="% lost" onChange={(v) => set({ lossPercent: v ?? undefined })} style={{ width: 130 }} aria-label="Requests lost" />
            <Button size="small" type="link" onClick={preset({ latencyMs: 150, bandwidthKbps: 1600, lossPercent: 1 })}>3G</Button>
            <Button size="small" type="link" onClick={preset({ latencyMs: 50, bandwidthKbps: 12000 })}>4G</Button>
            <Button size="small" type="link" onClick={preset({ latencyMs: 120 })}>Other continent</Button>
            {value && <Button size="small" type="link" onClick={preset(undefined)}>None</Button>}
        </Space>
    );
}

function PolicyEditor({ p, onChange }: { p: LoadPolicyDef; onChange: (p: LoadPolicyDef) => void }) {
    const num = (label: string, key: keyof LoadPolicyDef, o: { min?: number; max?: number; suffix?: string; tip?: string } = {}) => (
        <Form.Item label={label} tooltip={o.tip} className="field">
            <InputNumber size="small" min={o.min ?? 0} max={o.max} value={p[key] as number | undefined} onChange={(v) => onChange({ ...p, [key]: v ?? undefined })} style={{ width: 120 }} aria-label={label} addonAfter={o.suffix} />
        </Form.Item>
    );
    const err = validPolicy(p);
    const curve = err ? [] : policyCurve(p);
    const shape: Record<LoadPolicyDef['type'], string> = { constant: 'Constant', ramp: 'Ramp up / down', steps: 'Steps', peaks: 'Peaks', wave: 'Wave', arrival: 'Arrival rate', custom: 'Custom curve' };
    const arrival = p.type === 'arrival';
    return (
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Segmented size="small" style={{ maxWidth: '100%', overflowX: 'auto' }} value={p.type} onChange={(t) => onChange({ ...p, type: t as LoadPolicyDef['type'], ...(t === 'arrival' && !p.rate ? { rate: 10 } : {}), ...(t === 'custom' && !p.points?.length ? { points: [{ t: 0, users: 0 }, { t: Math.round(p.duration / 3), users: p.users }, { t: Math.round((2 * p.duration) / 3), users: p.users }, { t: p.duration, users: 0 }] } : {}) })} options={Object.entries(shape).map(([value, label]) => ({ value, label }))} />
            <Form layout="vertical" size="small" className="field-row">
                {p.type !== 'custom' && num('Run for', 'duration', { min: 1, suffix: 's' })}
                {arrival && num('Rate', 'rate', { min: 0.1, max: 10000, suffix: '/ s', tip: 'Iterations started per second, however long each takes (open model)' })}
                {p.type !== 'custom' && num(arrival ? 'Most users' : p.type === 'peaks' ? 'Base users' : p.type === 'steps' ? 'Up to users' : p.type === 'wave' ? 'Middle users' : 'Users', 'users', { min: 1, ...(arrival ? { tip: 'Users at most at once: an iteration due when all are busy is dropped (the system cannot keep the rate)' } : {}) })}
                {p.type !== 'custom' && num('Ramp up', 'rampUp', { suffix: 's', tip: arrival ? 'Seconds to reach the rate at the start' : 'Seconds to reach the users at the start' })}
                {p.type !== 'custom' && num('Ramp down', 'rampDown', { suffix: 's', tip: 'Seconds to go back to 0 at the end' })}
                {arrival && num('Start rate', 'startRate', { suffix: '/ s', tip: 'The rate at the start of the ramp-up' })}
                {(p.type === 'ramp' || p.type === 'steps' || p.type === 'wave') && num('Start with', 'startUsers', { tip: 'Users at the very start' })}
                {p.type === 'steps' && <>{num('Add', 'stepUsers', { min: 1, suffix: 'users' })}{num('Every', 'stepEvery', { min: 1, suffix: 's' })}</>}
                {p.type === 'peaks' && <>{num('Peak users', 'peakUsers', { min: 1 })}{num('Every', 'peakEvery', { min: 1, suffix: 's' })}{num('For', 'peakLength', { min: 1, suffix: 's' })}</>}
                {p.type === 'wave' && <>{num('Plus/minus', 'amplitude', { suffix: 'users' })}{num('Period', 'period', { min: 1, suffix: 's' })}</>}
            </Form>
            {p.type === 'custom' && <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Users at given seconds, one point per line ("second,users"), straight lines between: paste a CSV (from production traffic, a spreadsheet) or type it.</Typography.Text>
                <CurveInput initial={(p.points ?? []).map((x) => `${x.t},${x.users}`).join('\n')}
                    onPoints={(pts) => onChange({ ...p, points: pts, users: Math.max(1, ...pts.map((x) => x.users)), duration: Math.max(1, pts.at(-1)?.t ?? 1), rampUp: 0, rampDown: 0 })} />
            </Space>}
            {err ? <Alert type="warning" showIcon message={err} /> : arrival
                ? <LineChart height={120} x={curve.map((c) => c.t)} series={[{ name: 'Iterations per second', color: C.users, values: curve.map((c) => c.rate ?? 0), area: true }]} />
                : <LineChart height={120} x={curve.map((c) => c.t)} series={[{ name: 'Users', color: C.users, values: curve.map((c) => c.users), area: true }]} />}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{err ? '' : arrival
                ? `${p.rate} new iterations per second for ${dur(p.duration)}, by up to ${p.users} user${p.users === 1 ? '' : 's'} at once: a slower system does not get fewer requests. Iterations that find every user busy are counted as dropped.`
                : (() => { const n = Math.max(...curve.map((c) => c.users)); return `Up to ${n} virtual user${n === 1 ? '' : 's'} for ${dur(p.duration)}. ${n === 1 ? 'It runs' : 'Each one runs'} the user path again and again.`; })()}</Typography.Text>
        </Space>
    );
}

const dataLabel = (d: NonNullable<LoadScenarioDef['data']>) => d.source ? (d.source.kind === 'file' ? d.source.file : d.source.kind === 'query' ? `${d.source.connection} query` : d.source.kind === 'procedure' ? `${d.source.connection} ${d.source.procedure}` : d.source.kind === 'api' ? 'API response' : 'generated') : d.file;

function ScenarioEditor({ sc, onChange, reqs, collections, onCollection, browserPaths, bpath, project, env }: { project: string; env?: string; sc: LoadScenarioDef; onChange: (s: LoadScenarioDef) => void; reqs: Req[] | null; collections: ApiCollectionInfo[]; onCollection: (file: string) => void; browserPaths: BrowserPathInfo[]; bpath: BrowserPathDef | null }) {
    const set = (patch: Partial<LoadScenarioDef>) => onChange({ ...sc, ...patch });
    const pops = sc.populations ?? [];
    const [popReqs, setPopReqs] = React.useState<Record<number, Req[]>>({});
    const onPopReqs = React.useCallback((i: number, r: Req[]) => setPopReqs((x) => ({ ...x, [i]: r })), []);
    const setPops = (next: LoadPopulationDef[]) => set({ populations: next.length ? next : undefined, ...(next.length ? {} : { mainName: undefined }) });
    const mainShare = 100 - pops.reduce((n, p) => n + (p.share || 0), 0);
    const mainName = sc.mainName?.trim() || 'Main';
    // Service levels can target a request of any user path (ids of other paths: p<n>:<request id>).
    const slaTargets = [{ value: '*', label: 'All requests together' },
        ...(reqs ?? []).map((r) => ({ value: r.id, label: pops.length ? `${mainName} › ${r.name}` : r.name })),
        ...pops.flatMap((p, i) => (popReqs[i] ?? []).filter((r) => !p.requests.length || p.requests.includes(r.id)).map((r) => ({ value: `p${i + 1}:${r.id}`, label: `${p.name || `Path ${i + 2}`} › ${r.name}` })))];
    const chosen = sc.requests.length ? sc.requests : (reqs ?? []).map((r) => r.id);
    const toggle = (id: string, on: boolean) => {
        const all = (reqs ?? []).map((r) => r.id);
        const next = on ? all.filter((x) => chosen.includes(x) || x === id) : chosen.filter((x) => x !== id);
        set({ requests: next.length === all.length ? [] : next });
    };
    const setSla = (i: number, s: LoadSla) => set({ slas: sc.slas.map((x, j) => (j === i ? s : x)) });
    const [tab, setTab] = useRememberedTab('perf-scenario', 'path');
    const tag = (n: number | string | undefined, color?: string) => (n ? <Tag bordered={false} color={color} style={{ marginInlineStart: 4 }}>{n}</Tag> : null);
    const advancedCount = [sc.iterationsPerUser, sc.wan, sc.generators?.length, sc.apm].filter(Boolean).length;
    const policyErr = validPolicy(sc.policy);
    const userPath = (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {sc.browserPath ? <div>
                <SectionTitle help="Each virtual user is a real browser: it opens the start page, signs in once with its own session, then repeats the recorded steps. Each step is a transaction in the results. About 50–200 browser users fit on one computer.">Browser path</SectionTitle>
                <Select style={{ width: '100%', maxWidth: 520 }} value={sc.browserPath} onChange={(v) => set({ browserPath: v })} aria-label="Browser path"
                    options={browserPaths.map((b) => ({ value: b.file, label: `${b.name} (${b.actions} steps)` }))} />
                {bpath === null ? <Spin size="small" /> : <div className="tx-list" style={{ marginTop: 8 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Start page: <span className="mono">{bpath.startUrl}</span> · {bpath.browser}</Typography.Text>
                    {bpath.signIn.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Sign in ({bpath.signIn.length} steps, once per user): {bpath.signIn.map(stepText).join(' → ')}</Typography.Text>}
                    {bpath.actions.map((a, i) => <span key={i}><span className="item-id">{i + 1}.</span> {stepText(a)}</span>)}
                </div>}
                <Checkbox style={{ marginTop: 8 }} checked={!!sc.showBrowsers} onChange={(e) => set({ showBrowsers: e.target.checked || undefined })}>Show the browsers while it runs (a few users only)</Checkbox>
            </div> : <div>
                <SectionTitle help="The requests of an API collection, in order, with their checks and saved values (each user logs in with its own token, etc.). Each request is a transaction in the results.">API collection</SectionTitle>
                <Select style={{ width: '100%', maxWidth: 520 }} value={sc.collection} onChange={(v) => { onCollection(v); set({ collection: v, requests: [], slas: sc.slas.filter((s) => s.target === '*') }); }} aria-label="API collection"
                    options={collections.map((c) => ({ value: c.file, label: `${c.name} (${c.requests} request${c.requests === 1 ? '' : 's'})` }))} />
                {reqs === null ? <div><Spin size="small" /></div> : <div className="tx-list" style={{ marginTop: 8 }}>{reqs.map((r, i) => (
                    <Checkbox key={r.id} checked={chosen.includes(r.id)} onChange={(e) => toggle(r.id, e.target.checked)}>
                        <span className="item-id">{i + 1}.</span> <b style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{r.method}</b> {r.name}
                    </Checkbox>))}</div>}
            </div>}
            <Form layout="vertical" size="small" className="ap-form" style={{ maxWidth: 720 }}>
                <Row gutter={16}>
                    <Col xs={12} md={8}><Form.Item label="Think time from" tooltip="Pause after each step, chosen at random between the two values"><InputNumber min={0} value={sc.thinkTime.min} onChange={(v) => set({ thinkTime: { min: v ?? 0, max: Math.max(v ?? 0, sc.thinkTime.max) } })} aria-label="Think time from" addonAfter="ms" /></Form.Item></Col>
                    <Col xs={12} md={8}><Form.Item label="Think time to"><InputNumber min={0} value={sc.thinkTime.max} onChange={(v) => set({ thinkTime: { ...sc.thinkTime, max: Math.max(v ?? 0, sc.thinkTime.min) } })} aria-label="Think time to" addonAfter="ms" /></Form.Item></Col>
                    <Col xs={12} md={8}><Form.Item label="Pacing" tooltip="Minimum time one pass through the steps takes; 0: none"><InputNumber min={0} value={sc.pacing} onChange={(v) => set({ pacing: v ?? 0 })} aria-label="Pacing" addonAfter="ms" /></Form.Item></Col>
                </Row>
            </Form>
            <div>
                <SectionTitle help={pops.length ? 'Each user takes one path; the shares say how many users take each.' : 'All users take the path above. Add another path to mix kinds of users (for example 70% browse, 30% buy).'}
                    extra={<Button size="small" icon={<PlusOutlined />} disabled={pops.length >= 10 || mainShare <= 10} onClick={() => setPops([...pops, { name: `Path ${pops.length + 2}`, collection: collections[0]?.file, browserPath: collections.length ? undefined : browserPaths[0]?.file, requests: [], share: Math.min(30, mainShare - 1) }])}>Add a user path</Button>}>
                    User paths {pops.length ? tag(pops.length + 1) : <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>(one: all users take the path above)</Typography.Text>}</SectionTitle>
                {pops.length > 0 && <div className="pops">
                    <div className="pop-row">
                        <Input size="small" style={{ width: 160 }} value={sc.mainName ?? ''} placeholder="Main" onChange={(e) => set({ mainName: e.target.value || undefined })} aria-label="Main path name" />
                        <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>The path above</Typography.Text>
                        <Tag bordered={false} color={mainShare >= 1 ? 'purple' : 'error'}>{mainShare}% of users</Tag>
                    </div>
                    {pops.map((p, i) => <PopulationRow key={i} p={p} index={i} collections={collections} browserPaths={browserPaths} onReqs={onPopReqs}
                        onChange={(x) => setPops(pops.map((y, j) => (j === i ? x : y)))} onRemove={() => {
                            const next = pops.filter((_, j) => j !== i);
                            // Service levels of the removed path go; those of later paths follow their new number.
                            const slas = sc.slas.filter((x) => x.target !== '*' && /^p\d+:/.test(x.target) ? Number(/^p(\d+):/.exec(x.target)![1]) !== i + 1 : true)
                                .map((x) => { const m = /^p(\d+):(.*)$/.exec(x.target); return m && Number(m[1]) > i + 1 ? { ...x, target: `p${Number(m[1]) - 1}:${m[2]}` } : x; });
                            set({ populations: next.length ? next : undefined, mainName: next.length ? sc.mainName : undefined, slas });
                        }} />)}
                    {mainShare < 1 && <Alert type="warning" showIcon message="The shares of the other paths must leave some users for the main path (under 100% together)." />}
                </div>}
            </div>
            {!sc.browserPath && <Collapse size="small" defaultActiveKey={sc.logic ? ['l'] : []} items={[
                { key: 'l', label: <span>Logic {sc.logic ? <Tag bordered={false} color="purple">Init / Actions / End</Tag> : <Typography.Text type="secondary">(the requests in order)</Typography.Text>}</span>, children: <LogicEditor logic={sc.logic} reqs={reqs ?? []} onChange={(logic) => set({ logic })} /> },
            ]} />}
            {!sc.browserPath && <Collapse size="small" defaultActiveKey={sc.data ? ['d'] : []} items={[{ key: 'd', label: <span>Test data {sc.data ? <Tag bordered={false}>{dataLabel(sc.data)}</Tag> : <Typography.Text type="secondary">(none)</Typography.Text>} <Tooltip title={<>Rows from a file, a database query or stored procedure, an API or generated; each column is {'{{column}}'} in the requests (accounts, order numbers… for many users). Loaded once when the test starts.</>}><QuestionCircleOutlined style={{ color: 'var(--muted)', fontSize: 12 }} /></Tooltip></span>, children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                    <DataSourceEditor project={project} env={env} collections={collections} value={sc.data?.source ?? (sc.data?.file ? { kind: 'file', file: sc.data.file } : undefined)}
                        onChange={(d) => set({ data: d ? { source: d, mode: sc.data?.mode ?? 'sequential' } : undefined })} />
                    {sc.data && <Select size="small" style={{ width: 300 }} value={sc.data.mode} onChange={(m) => sc.data && set({ data: { ...sc.data, mode: m } })} aria-label="Use of the rows"
                        options={[{ value: 'sequential', label: 'Next row each iteration (then again)' }, { value: 'random', label: 'Random row each iteration' }, { value: 'perUser', label: 'One row per user' }, { value: 'unique', label: 'Each row once (the test ends when all are used)' }]} />}
                </Space>) }]} />}
        </Space>
    );
    const slaPane = (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <SlaProfilePicker project={project} sc={sc} set={set} />
            <div>
                <SectionTitle help="A run fails when a level is missed. Over the whole run, or over every interval (a slow minute fails it even when the run's average is fine)."
                    extra={<Button size="small" icon={<PlusOutlined />} onClick={() => set({ slas: [...sc.slas, { target: (reqs ?? [])[0]?.id ?? '*', p95: 1000 }] })}>Add a service level</Button>}>Service levels {tag(sc.slas.length)}</SectionTitle>
                {!sc.slas.length && <Typography.Text type="secondary" className="ap-note">None{sc.slaProfile ? ' besides the profile\'s' : ''}.</Typography.Text>}
                {sc.slas.map((s, i) => (
                    <div key={i} className="ap-card">
                        <div className="ap-card-head">
                            <Select size="small" style={{ width: 260, maxWidth: '50%' }} value={s.target} onChange={(t) => setSla(i, { ...s, target: t })} aria-label="Applies to" options={slaTargets} />
                            <Select size="small" style={{ width: 140 }} value={s.per ?? 'run'} onChange={(per) => setSla(i, { ...s, per: per === 'run' ? undefined : per })} aria-label="Checked over"
                                options={[{ value: 'run', label: 'whole run' }, { value: 'interval', label: 'every interval' }]} />
                            <span className="ap-grow" />
                            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => set({ slas: sc.slas.filter((_, j) => j !== i) })} aria-label="Remove SLA" />
                        </div>
                        <div className="check-row">
                            <SlaLevelsInputs s={s} onChange={(x) => setSla(i, x)} />
                            {sc.policy.type === 'arrival' && s.target === '*' && <Tooltip title="Iterations that came due while every user was busy (the system could not keep the rate)">
                                <InputNumber size="small" min={0} step={0.1} placeholder="%" value={s.dropped} onChange={(v) => setSla(i, { ...s, dropped: v ?? undefined })} addonBefore="dropped at most" addonAfter="%" style={{ width: 210 }} aria-label="Dropped iterations at most" />
                            </Tooltip>}
                        </div>
                    </div>
                ))}
                {sc.slas.some((x) => x.per === 'interval') && <div style={{ marginTop: 8 }}><Tooltip title="Length of an interval; an interval missing a level raises an alert while running"><InputNumber size="small" min={1} max={3600} value={sc.slaInterval ?? 10} onChange={(v) => set({ slaInterval: v && v !== 10 ? v : undefined })} addonBefore="interval" addonAfter="s" style={{ width: 160 }} aria-label="Interval" /></Tooltip></div>}
            </div>
            <div>
                <SectionTitle help="Stop a run that is clearly failing, or fail a run that is worse than the scenario's baseline run (set a baseline on a run's page).">Gates</SectionTitle>
                <Space direction="vertical" size={8}>
                    <Space wrap>
                        <Checkbox checked={sc.stopOnErrorRate !== undefined} onChange={(e) => set({ stopOnErrorRate: e.target.checked ? 20 : undefined })}>Stop early when errors exceed</Checkbox>
                        {sc.stopOnErrorRate !== undefined && <InputNumber size="small" min={1} max={100} value={sc.stopOnErrorRate} onChange={(v) => set({ stopOnErrorRate: v ?? 20 })} addonAfter="%" style={{ width: 100 }} aria-label="Stop when errors exceed" />}
                    </Space>
                    <Space wrap><RegressionGateInputs sc={sc} set={set} /></Space>
                </Space>
            </div>
        </Space>
    );
    const advanced = (
        <Space direction="vertical" style={{ width: '100%' }} size={14}>
            <Form layout="vertical" size="small" className="ap-form" style={{ maxWidth: 720 }}>
                <Row gutter={16}>
                    <Col xs={12} md={8}><Form.Item label="Timeout" tooltip="A step that takes longer fails"><InputNumber min={100} value={sc.timeout} onChange={(v) => set({ timeout: v ?? 30000 })} aria-label="Timeout" addonAfter="ms" /></Form.Item></Col>
                    <Col xs={12} md={8}><Form.Item label="Iterations per user" tooltip="Each user does this many iterations, then stops; the run ends when all are done (the duration is then the longest it may take)"><InputNumber min={1} value={sc.iterationsPerUser} placeholder="until the end" onChange={(v) => set({ iterationsPerUser: v ?? undefined })} aria-label="Iterations per user" /></Form.Item></Col>
                </Row>
            </Form>
            {!sc.browserPath && <div>
                <SectionTitle help="A slower, farther network (mobile, another continent) that loses requests, for every user of the main path.">Network emulation</SectionTitle>
                <WanEditor value={sc.wan} onChange={(wan) => set({ wan })} />
            </div>}
            <div><GeneratorsEditor sc={sc} set={set} /></div>
            <div><ApmEditor sc={sc} set={set} /></div>
        </Space>
    );
    return (
        <div className="ap-editor">
            <div className="ap-editor-inner">
                <Input variant="borderless" value={sc.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} onBlur={() => { if (!sc.name.trim()) set({ name: 'Untitled scenario' }); }} style={{ fontWeight: 600, fontSize: 16, paddingInline: 0 }} aria-label="Scenario name" placeholder="Scenario name" />
                <Tabs size="small" className="ap-tabs" activeKey={shownTab(tab, ['path', 'load', 'sla', 'monitors', 'advanced'])} onChange={setTab} items={[
                    { key: 'path', label: <span>Requests &amp; data{sc.browserPath ? tag('browser') : tag(reqs ? chosen.length : undefined)}</span>, children: userPath },
                    { key: 'load', label: <span>Load{policyErr ? tag('!', 'error') : tag(`${maxUsersOf(sc)} users`)}</span>, children: <PolicyEditor p={sc.policy} onChange={(policy) => set({ policy })} /> },
                    { key: 'sla', label: <span>Service levels{tag(sc.slas.length + (sc.slaProfile ? 1 : 0))}</span>, children: slaPane },
                    { key: 'monitors', label: <span>Monitors{tag(sc.monitors?.length)}</span>, children: <MonitorsEditor sc={sc} set={set} /> },
                    { key: 'advanced', label: <span>Advanced{tag(advancedCount)}</span>, children: advanced },
                ]} />
            </div>
        </div>
    );
}

/** Load generators (cs-test-studio agent): none means this computer; with some, each runs its share of the users. */
function GeneratorsEditor({ sc, set }: { sc: LoadScenarioDef; set: (p: Partial<LoadScenarioDef>) => void }) {
    const list = sc.generators ?? [];
    const put = (next: LoadGeneratorDef[]) => set({ generators: next.length ? next : undefined });
    const upd = (i: number, p: Partial<LoadGeneratorDef>) => put(list.map((g, j) => (j === i ? { ...g, ...p } : g)));
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <SectionTitle help="Load generators (cs-test-studio agent, or its Docker image) spread a large test over several computers or zones; they start together and this Studio adds their numbers up."
                extra={<Button size="small" icon={<PlusOutlined />} disabled={list.length >= 50} onClick={() => put([...list, { name: `gen-${list.length + 1}`, url: '', token: '{env:LOADGEN_TOKEN}' }])}>Add a load generator</Button>}>Where the load comes from</SectionTitle>
            <Typography.Text type="secondary" className="ap-note">{list.length ? `The ${maxUsersOf(sc)} user${maxUsersOf(sc) === 1 ? '' : 's'} ${maxUsersOf(sc) === 1 ? 'is' : 'are'} shared out among ${list.length} generator${list.length === 1 ? '' : 's'}.` : 'This computer runs the users.'}</Typography.Text>
            {list.length > 0 && <Form layout="vertical" size="small" className="ap-form">
                {list.map((g, i) => (
                    <Row key={i} gutter={8} align="bottom">
                        <Col xs={12} md={5}><Form.Item label={i ? undefined : 'Name'}><Input value={g.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="gen-eu-1" aria-label="Generator name" /></Form.Item></Col>
                        <Col xs={12} md={8}><Form.Item label={i ? undefined : 'Address'}><Input className="mono" value={g.url} onChange={(e) => upd(i, { url: e.target.value })} placeholder="https://loadgen-eu1.example.com:4720" aria-label="Generator address" /></Form.Item></Col>
                        <Col xs={8} md={4}><Form.Item label={i ? undefined : 'Zone'}><Input value={g.zone ?? ''} onChange={(e) => upd(i, { zone: e.target.value || undefined })} placeholder="zone" aria-label="Zone" /></Form.Item></Col>
                        <Col xs={12} md={6}><Form.Item label={i ? undefined : 'Token'} tooltip={i ? undefined : 'The agent\'s token as a reference to a secret ({env:NAME}) or setting ({config:KEY}); the token itself is never saved in the scenario'}><Input className="mono" value={g.token} onChange={(e) => upd(i, { token: e.target.value })} placeholder="{env:LOADGEN_TOKEN}" aria-label="Token reference" /></Form.Item></Col>
                        <Col xs={4} md={1}><Form.Item><Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => put(list.filter((_, j) => j !== i))} aria-label="Remove generator" /></Form.Item></Col>
                    </Row>
                ))}
            </Form>}
        </Space>
    );
}
const maxUsersOf = (sc: LoadScenarioDef) => { const p = sc.policy as { users?: number; maxUsers?: number; steps?: Array<{ users: number }> }; return p.maxUsers ?? p.users ?? Math.max(0, ...(p.steps ?? []).map((x) => x.users)); };

/** The generators of a distributed run: state, zone, users, CPU and memory. */
function GeneratorsHealth({ gens }: { gens: LoadGeneratorHealth[] }) {
    return (
        <Table<LoadGeneratorHealth> size="small" rowKey="name" pagination={false} dataSource={gens} columns={[
            { title: 'Load generator', render: (_, g) => <><b>{g.name}</b>{g.zone ? <Tag style={{ marginLeft: 6 }}>{g.zone}</Tag> : null}</> },
            { title: 'State', render: (_, g) => <Tag color={g.state === 'finished' ? 'success' : g.state === 'running' ? 'processing' : g.state === 'error' || g.state === 'unreachable' ? 'error' : 'default'}>{g.state}</Tag> },
            { title: 'Users', align: 'right', render: (_, g) => g.users ?? '' },
            { title: 'Requests', align: 'right', render: (_, g) => g.requests?.toLocaleString() ?? '' },
            { title: 'CPU', align: 'right', render: (_, g) => (g.cpu !== undefined ? <span style={{ color: g.cpu >= 90 ? '#cf222e' : undefined }}>{g.cpu}%</span> : '') },
            { title: 'Memory', align: 'right', render: (_, g) => (g.memory !== undefined ? `${g.memory}%` : '') },
            { title: '', render: (_, g) => <Typography.Text type="danger" style={{ fontSize: 12 }}>{g.error ?? ''}</Typography.Text> },
        ]} />
    );
}


const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Schedules of a scenario (while the Studio is open): once, every day, or on weekdays. */
function ScheduleButton({ file, env }: { file: string; env?: string }) {
    const { message } = App.useApp();
    const [open, setOpen] = React.useState(false);
    const [list, setList] = React.useState<LoadScheduleDef[]>([]);
    const [draft, setDraft] = React.useState<Partial<LoadScheduleDef>>({ kind: 'daily', at: '02:00', days: [1, 2, 3, 4, 5] });
    const reload = React.useCallback(() => api.loadSchedules().then((r) => setList(r.schedules.filter((s) => s.file === file)), () => undefined), [file]);
    React.useEffect(() => { void reload(); }, [reload]);
    const add = async () => {
        try { await api.loadSaveSchedule({ ...draft, file, ...(env ? { env } : {}), ...(draft.kind === 'once' ? { at: new Date(draft.at ?? '').toISOString() } : {}) }); message.success('Scheduled'); void reload(); }
        catch (e) { message.error(errText(e)); }
    };
    const when = (s: LoadScheduleDef) => (s.kind === 'once' ? new Date(s.at).toLocaleString() : `${s.kind === 'daily' ? 'every day' : (s.days ?? []).map((d) => DAYS[d]).join(', ')} at ${s.at}`);
    return (
        <>
            <Button size="small" onClick={() => setOpen(true)}>{list.length ? `Scheduled (${list.length})` : 'Schedule'}</Button>
            <Modal open={open} title="Run this scenario on a schedule" footer={null} onCancel={() => setOpen(false)} width={620}>
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Runs while the Studio is open on this computer (this computer's time{env ? `, environment ${env}` : ''}). For nightly runs without anyone's computer, use the load-test pipeline.</Typography.Text>
                    {list.map((s) => (
                        <div key={s.id} className="check-row">
                            <Tag color={s.enabled ? 'blue' : 'default'}>{when(s)}</Tag>
                            <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>{s.next ? `next ${new Date(s.next).toLocaleString()}` : 'done'}{s.last ? ` · last ${new Date(s.last.at).toLocaleString()}${s.last.error ? `: ${s.last.error}` : ''}` : ''}</Typography.Text>
                            <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Remove schedule" onClick={async () => { try { await api.loadDeleteSchedule(s.id); void reload(); } catch (e) { message.error(errText(e)); } }} />
                        </div>
                    ))}
                    <Space wrap>
                        <Segmented size="small" value={draft.kind} onChange={(k) => setDraft({ ...draft, kind: k as LoadScheduleDef['kind'], at: k === 'once' ? '' : '02:00' })} options={[{ value: 'once', label: 'Once' }, { value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'On days' }]} />
                        {draft.kind === 'once'
                            ? <Input size="small" type="datetime-local" style={{ width: 210 }} value={draft.at} onChange={(e) => setDraft({ ...draft, at: e.target.value })} aria-label="When" />
                            : <Input size="small" type="time" style={{ width: 110 }} value={draft.at} onChange={(e) => setDraft({ ...draft, at: e.target.value })} aria-label="At" />}
                        {draft.kind === 'weekly' && <Checkbox.Group value={draft.days} onChange={(v) => setDraft({ ...draft, days: v as number[] })} options={DAYS.map((d, i) => ({ value: i, label: d }))} />}
                        <Button size="small" type="primary" onClick={() => void add()}>Add</Button>
                    </Space>
                </Space>
            </Modal>
        </>
    );
}


/** An Azure DevOps pipeline for the scenario: parallel generators, a nightly schedule, the baseline gate, reports. */
function PipelineButton({ file }: { file: string }) {
    const { message } = App.useApp();
    const [open, setOpen] = React.useState(false);
    const [o, setO] = React.useState<{ generators: number; schedule: string; variableGroup: string; pool: string; teamFolder: string }>({ generators: 1, schedule: '0 2 * * 1-5', variableGroup: '', pool: '', teamFolder: '' });
    const [r, setR] = React.useState<{ yaml: string; file: string; secretNames: string[] } | null>(null);
    const build = React.useCallback(async (save = false) => {
        try {
            const x = await api.loadPipeline({ file, generators: o.generators, ...(o.schedule.trim() ? { schedule: o.schedule.trim() } : {}), ...(o.variableGroup.trim() ? { variableGroup: o.variableGroup.trim() } : {}), ...(o.pool.trim() ? { pool: o.pool.trim() } : {}), ...(o.teamFolder.trim() ? { teamFolder: o.teamFolder.trim() } : {}), save });
            setR(x); if (save) message.success(`Wrote ${x.file}`);
        } catch (e) { message.error(errText(e)); }
    }, [file, o, message]);
    React.useEffect(() => { if (open) void build(); }, [open, build]);
    return (
        <>
            <Button size="small" onClick={() => setOpen(true)}>Pipeline</Button>
            <Modal open={open} title="Azure DevOps load-test pipeline" width={820} onCancel={() => setOpen(false)}
                footer={[<Button key="c" onClick={() => { void navigator.clipboard.writeText(r?.yaml ?? ''); message.success('Copied'); }}>Copy</Button>, <Button key="s" type="primary" onClick={() => void build(true)}>Save to the repository</Button>]}>
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Space wrap>
                        <InputNumber size="small" min={1} max={50} value={o.generators} onChange={(v) => setO({ ...o, generators: v ?? 1 })} addonBefore="generators" style={{ width: 150 }} aria-label="Load generators" />
                        <Tooltip title="Cron line in UTC; empty: run by hand only"><Input size="small" className="mono" style={{ width: 150 }} value={o.schedule} onChange={(e) => setO({ ...o, schedule: e.target.value })} placeholder="0 2 * * 1-5" aria-label="Schedule" /></Tooltip>
                        <Input size="small" style={{ width: 170 }} value={o.variableGroup} onChange={(e) => setO({ ...o, variableGroup: e.target.value })} placeholder="variable group (secrets)" aria-label="Variable group" />
                        <Tooltip title="An agent pool for the generators (e.g. a scale-set pool that starts agents on demand); empty: Microsoft-hosted"><Input size="small" style={{ width: 150 }} value={o.pool} onChange={(e) => setO({ ...o, pool: e.target.value })} placeholder="agent pool" aria-label="Agent pool" /></Tooltip>
                        <Input size="small" className="mono" style={{ width: 170 }} value={o.teamFolder} onChange={(e) => setO({ ...o, teamFolder: e.target.value })} placeholder="team results folder" aria-label="Team folder" />
                    </Space>
                    {r?.secretNames.length ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>Secrets it reads (put them in the variable group): {r.secretNames.join(', ')}</Typography.Text> : null}
                    <pre className="mono" style={{ maxHeight: 420, overflow: 'auto', fontSize: 11.5, background: 'var(--cs-code-bg, #f6f8fa)', padding: 10 }}>{r?.yaml ?? ''}</pre>
                    {r && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Saved as {r.file}: commit it, then create the pipeline from it in Azure DevOps.</Typography.Text>}
                </Space>
            </Modal>
        </>
    );
}


/** What the run says (worked out from its numbers), and the assistant to ask about it. */
function InsightsPanel({ d }: { d: LoadRunDetailDef }) {
    const [x, setX] = React.useState<LoadInsightsDef | null>(null);
    React.useEffect(() => { void api.loadInsights(d.id).then(setX, () => setX(null)); }, [d.id]);
    if (!x) return null;
    const ask = () => askCopilot(`Help me understand the load test "${d.name}" (${d.project}/${d.env}, run ${d.id}).\n\n${x.summary}\n\nFindings:\n${x.insights.map((i) => `- [${i.severity}] ${i.title}: ${i.detail}`).join('\n')}\n\nWhat are the most likely causes, what should we check on the servers first, and what should the next test change? Read the run's results and the scenario in the project if you need more detail.`);
    return (
        <Alert type={d.result?.passed ? 'info' : 'warning'} showIcon message={<b>What the run says</b>}
            description={<Space direction="vertical" size={4} style={{ width: '100%' }}>
                <span>{x.summary}</span>
                {x.insights.map((i, k) => <div key={k} style={{ fontSize: 12.5 }}><Tag color={i.severity === 'critical' ? 'red' : i.severity === 'warning' ? 'orange' : 'default'}>{i.kind}</Tag><b>{i.title}</b> — {i.detail}</div>)}
                <Button size="small" onClick={ask}>Ask the assistant about this run</Button>
            </Space>} />
    );
}


const STATUS_COLOR: Record<string, string> = { green: '#1a7f37', amber: '#b45309', red: '#cf222e' };
const RATING_TAG: Record<string, { color: string; text: string }> = { good: { color: 'success', text: 'Good' }, acceptable: { color: 'processing', text: 'Acceptable' }, poor: { color: 'warning', text: 'Poor' }, critical: { color: 'error', text: 'Not acceptable' }, info: { color: 'default', text: '—' } };
function StatusBanner({ status, headline, answer }: { status: string; headline: string; answer: string }) {
    return (
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', border: `2px solid ${STATUS_COLOR[status]}`, borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ background: STATUS_COLOR[status], color: '#fff', fontWeight: 700, padding: '8px 12px', borderRadius: 6, fontSize: 16 }}>{status.toUpperCase()}</div>
            <div><b>{headline.replace(/^\w+ — /, '')}</b><div style={{ marginTop: 2 }}>{answer}</div></div>
        </div>
    );
}

/** A run in plain language: the status, every number explained and rated, behaviour over time, risks, next steps. */
function RunSummary({ id }: { id: string }) {
    const [x, setX] = React.useState<LoadExplainDef | null>(null);
    React.useEffect(() => { void api.loadExplain(id).then(setX, () => setX(null)); }, [id]);
    if (!x) return null;
    return (
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <StatusBanner status={x.status} headline={x.headline} answer={x.answer} />
            <Table size="small" rowKey="key" pagination={false} dataSource={x.metrics} columns={[
                { title: 'Measure', dataIndex: 'label', width: 190 },
                { title: 'Result', dataIndex: 'value', width: 130, render: (v: string) => <b>{v}</b> },
                { title: 'Rating', dataIndex: 'rating', width: 120, render: (r: string) => <Tag color={RATING_TAG[r].color}>{RATING_TAG[r].text}</Tag> },
                { title: 'What it means', render: (_, m) => <>{m.meaning}{m.rating !== 'info' && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>Judged against {m.basis}.</Typography.Text></div>}</> },
            ]} />
            <Row gutter={16}>
                <Col xs={24} lg={8}><Typography.Text strong>Over time: {x.behaviour.verdict}</Typography.Text><div style={{ fontSize: 13 }}>{x.behaviour.text}</div></Col>
                <Col xs={24} lg={8}><Typography.Text strong>Risks and issues</Typography.Text>{x.risks.length ? <ul style={{ paddingLeft: 18, margin: '4px 0', fontSize: 13 }}>{x.risks.map((t, k) => <li key={k}>{t}</li>)}</ul> : <div style={{ fontSize: 13 }}>None found in this run.</div>}</Col>
                <Col xs={24} lg={8}><Typography.Text strong>Recommended next steps</Typography.Text><ol style={{ paddingLeft: 18, margin: '4px 0', fontSize: 13 }}>{x.recommendations.map((t, k) => <li key={k}>{t}</li>)}</ol></Col>
            </Row>
        </Space>
    );
}

/** Two runs of a scenario side by side: verdict, measures with their change and meaning, transactions, both over time, reports. */
function CompareView({ file, runs, a, b }: { file: string; runs: LoadRunInfoDef[]; a?: string; b?: string }) {
    const { message } = App.useApp();
    const list = runs.filter((r) => r.scenario === file && r.state === 'finished' && r.summary).sort((x, y) => y.startedAt.localeCompare(x.startedAt));
    const ids = { a: a ?? list[1]?.id, b: b ?? list[0]?.id };
    const [c, setC] = React.useState<LoadCompareDef | null>(null);
    const [tab, setTab] = useRememberedTab('perf-compare', 'overview');
    React.useEffect(() => { setC(null); if (ids.a && ids.b && ids.a !== ids.b) void api.loadCompare(ids.a, ids.b).then(setC, (e) => message.error(errText(e))); }, [ids.a, ids.b, message]);
    if (list.length < 2) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="This scenario needs at least two finished runs to compare." />;
    const pick = (k: 'a' | 'b', v: string) => navigate(['perf-compare', ...file.split('/'), '@', k === 'a' ? v : ids.a!, k === 'b' ? v : ids.b!]);
    const opts = list.map((r) => ({ value: r.id, label: `${new Date(r.startedAt).toLocaleString()} · ${r.env} · p95 ${ms(r.summary!.p95)}${r.baseline ? ' · baseline' : ''}` }));
    const download = async (format: 'html' | 'pdf' | 'docx') => { try { const r = await api.loadReport(ids.a!, format, [ids.b!]); const el = document.createElement('a'); el.href = URL.createObjectURL(r.blob); el.download = r.name; el.click(); URL.revokeObjectURL(el.href); } catch (e) { message.error(errText(e)); } };
    const vColor = (v: string) => (v === 'worse' ? '#cf222e' : v === 'better' ? '#1a7f37' : undefined);
    const xs = c ? [...new Set([...c.series, ...c.throughput].flatMap((s) => s.points.map((p) => p.t)))].sort((p, q) => p - q) : [];
    const values = (s: LoadCompareDef['series'][number]) => { const m = new Map(s.points.map((p) => [p.t, p.v])); return xs.map((x) => m.get(x) ?? NaN); };
    return (
        <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
                <Form layout="vertical" size="small" className="ap-form">
                    <Row gutter={12} align="bottom">
                        <Col xs={24} lg={10}><Form.Item label="Run A (reference)"><Select value={ids.a} onChange={(v: string) => pick('a', v)} options={opts} aria-label="Run A" /></Form.Item></Col>
                        <Col xs={24} lg={10}><Form.Item label="Run B"><Select value={ids.b} onChange={(v: string) => pick('b', v)} options={opts} aria-label="Run B" /></Form.Item></Col>
                        <Col xs={24} lg={4}><Form.Item><Dropdown menu={{ items: [{ key: 'html', label: 'HTML report' }, { key: 'pdf', label: 'PDF report' }, { key: 'docx', label: 'Word document' }], onClick: ({ key }) => void download(key as 'html' | 'pdf' | 'docx') }}><Button size="small" icon={<DownloadOutlined />} disabled={!c}>Report</Button></Dropdown></Form.Item></Col>
                    </Row>
                </Form>
                {ids.a === ids.b && <Alert type="info" showIcon message="Choose two different runs." />}
                {c && <>
                    <StatusBanner status={c.comparison.status} headline={c.comparison.headline} answer={c.comparison.answer} />
                    <Tabs size="small" className="ap-tabs" activeKey={shownTab(tab, ['overview', 'charts', 'tx'])} onChange={setTab} items={[
                        { key: 'overview', label: 'Measures', children: <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <Table size="small" rowKey="label" pagination={false} dataSource={c.comparison.metrics} columns={[
                                { title: 'Measure', dataIndex: 'label', width: 190 },
                                { title: 'A', dataIndex: 'a', width: 110 }, { title: 'B', dataIndex: 'b', width: 110, render: (v: string) => <b>{v}</b> },
                                { title: 'Change', width: 140, render: (_, m) => <span style={{ color: vColor(m.verdict), fontWeight: m.verdict === 'same' ? 400 : 600 }}>{m.change} {m.verdict === 'worse' ? '▲ worse' : m.verdict === 'better' ? '▼ better' : '≈ same'}</span> },
                                { title: 'What it means', dataIndex: 'meaning' },
                            ]} />
                            {c.comparison.findings.length > 0 && <Alert type={c.comparison.status === 'green' ? 'success' : 'warning'} showIcon message="What changed" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{c.comparison.findings.map((f, k) => <li key={k}>{f}</li>)}</ul>} />}
                        </Space> },
                        { key: 'charts', label: 'Charts', children: <Row gutter={16}>
                            <Col xs={24} xl={12}><LineChart title="95% response time (ms), seconds from the start" x={xs} series={c.series.map((s, k) => ({ name: `Run ${s.label}`, color: k ? C.p95 : C.avg, values: values(s), unit: ' ms' }))} xFormat={(v) => `${v} s`} /></Col>
                            <Col xs={24} xl={12}><LineChart title="Requests per second" x={xs} series={c.throughput.map((s, k) => ({ name: `Run ${s.label}`, color: k ? C.p95 : C.avg, values: values(s) }))} xFormat={(v) => `${v} s`} /></Col>
                        </Row> },
                        { key: 'tx', label: <span>Transactions <Tag bordered={false}>{c.comparison.transactions.length}</Tag></span>, children: <Table size="small" rowKey="name" pagination={false} dataSource={c.comparison.transactions} columns={[
                            { title: 'Transaction', dataIndex: 'name' },
                            { title: 'A: 95% within', width: 130, align: 'right', render: (_, t) => (t.verdict === 'new' ? '—' : ms(t.aP95)) },
                            { title: 'B: 95% within', width: 130, align: 'right', render: (_, t) => (t.verdict === 'gone' ? '—' : <b>{ms(t.bP95)}</b>) },
                            { title: 'Change', width: 150, render: (_, t) => (t.verdict === 'new' ? 'new in B' : t.verdict === 'gone' ? 'not run in B' : <span style={{ color: vColor(t.verdict), fontWeight: t.verdict === 'same' ? 400 : 600 }}>{t.changePct >= 0 ? '+' : ''}{t.changePct}% {t.verdict === 'worse' ? '▲ worse' : t.verdict === 'better' ? '▼ better' : '≈ same'}</span>) },
                        ]} /> },
                    ]} />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.comparison.notes.join(' ')}</Typography.Text>
                </>}
            </Space>
        </div>
    );
}

/** How much worse than the baseline run a run may be (set a baseline on a run's page). */
function RegressionGateInputs({ sc, set }: { sc: LoadScenarioDef; set: (p: Partial<LoadScenarioDef>) => void }) {
    const g = sc.regression;
    const put = (p: Partial<NonNullable<LoadScenarioDef['regression']>>) => { const n = { ...(g ?? {}), ...p }; set({ regression: Object.values(n).some((v) => v !== undefined && v !== false) ? n : undefined }); };
    return (
        <>
            <Checkbox checked={!!g} onChange={(e) => set({ regression: e.target.checked ? { p95Percent: 10, errorRatePoints: 1 } : undefined })}>
                <Tooltip title="Compared with the scenario's baseline run (its steady part): a run worse than this fails">Fail when worse than the baseline</Tooltip>
            </Checkbox>
            {g && <>
                <InputNumber size="small" min={0} value={g.p95Percent} placeholder="—" onChange={(v) => put({ p95Percent: v ?? undefined })} addonBefore="p95 +" addonAfter="%" style={{ width: 140 }} aria-label="p95 worse by at most" />
                <InputNumber size="small" min={0} value={g.avgPercent} placeholder="—" onChange={(v) => put({ avgPercent: v ?? undefined })} addonBefore="avg +" addonAfter="%" style={{ width: 140 }} aria-label="Average worse by at most" />
                <InputNumber size="small" min={0} step={0.1} value={g.errorRatePoints} placeholder="—" onChange={(v) => put({ errorRatePoints: v ?? undefined })} addonBefore="errors +" addonAfter="pts" style={{ width: 150 }} aria-label="Errors up by at most" />
                <InputNumber size="small" min={0} value={g.throughputPercent} placeholder="—" onChange={(v) => put({ throughputPercent: v ?? undefined })} addonBefore="req/s −" addonAfter="%" style={{ width: 150 }} aria-label="Throughput down by at most" />
            </>}
        </>
    );
}

const SLA_FIELDS: Array<{ key: keyof LoadSlaLevels; label: string; unit: string; step?: number; atLeast?: boolean }> = [
    { key: 'p95', label: '95% under', unit: 'ms' }, { key: 'avg', label: 'average under', unit: 'ms' }, { key: 'errorRate', label: 'errors at most', unit: '%', step: 0.1 },
    { key: 'p90', label: '90% under', unit: 'ms' }, { key: 'p99', label: '99% under', unit: 'ms' }, { key: 'throughput', label: 'at least', unit: 'req/s', step: 0.5, atLeast: true },
];

/** The levels of a service level: failing ones in the row, warning ones (and the less used measures) behind "More". */
function SlaLevelsInputs({ s, onChange }: { s: LoadSla; onChange: (s: LoadSla) => void }) {
    const extra = SLA_FIELDS.slice(3).some((f) => s[f.key] !== undefined) || !!s.warn;
    const [more, setMore] = React.useState(extra);
    const setLevel = (k: keyof LoadSlaLevels, v: number | null) => onChange({ ...s, [k]: v ?? undefined });
    const setWarn = (k: keyof LoadSlaLevels, v: number | null) => { const w = { ...(s.warn ?? {}), [k]: v ?? undefined }; const keep = Object.values(w).some((x) => x !== undefined); onChange({ ...s, warn: keep ? w : undefined }); };
    const fields = more ? SLA_FIELDS : SLA_FIELDS.slice(0, 3);
    return (
        <>
            {fields.map((f) => (
                <span key={f.key} style={{ display: 'inline-flex', gap: 2 }}>
                    <InputNumber size="small" min={0} step={f.step ?? 1} placeholder={f.unit} value={s[f.key]} onChange={(v) => setLevel(f.key, v)} addonBefore={f.label} addonAfter={f.unit} style={{ width: f.key === 'throughput' ? 190 : 200 }} aria-label={`${f.label} (fails)`} />
                    {more && <Tooltip title={`Warning level: over it the run still passes, with a warning${f.atLeast ? ' (at least this many)' : ''}`}><InputNumber size="small" min={0} step={f.step ?? 1} placeholder="warn" value={s.warn?.[f.key]} onChange={(v) => setWarn(f.key, v)} style={{ width: 70 }} aria-label={`${f.label} (warning)`} /></Tooltip>}
                </span>
            ))}
            <Button size="small" type="link" onClick={() => setMore(!more)}>{more ? 'Fewer' : 'More levels, warnings'}</Button>
        </>
    );
}

/** A reusable profile of service levels (test/<project>/load/sla/*.sla.json): use one, or save the scenario's levels as one. */
function SlaProfilePicker({ project, sc, set }: { project: string; sc: LoadScenarioDef; set: (p: Partial<LoadScenarioDef>) => void }) {
    const { message } = App.useApp();
    const [list, setList] = React.useState<LoadSlaProfileInfo[]>([]);
    const reload = React.useCallback(() => { if (project) api.loadSlaProfiles(project).then((r) => setList(r.profiles), () => setList([])); }, [project]);
    React.useEffect(reload, [reload]);
    const save = () => {
        let name = sc.name ? `${sc.name} levels` : 'Service levels';
        let busy = false;
        const submit = async (close: () => void) => {
            if (busy) return; // a double click saves once
            if (!name.trim()) { message.error('Give the profile a name.'); return; }
            busy = true;
            inst.update({ okButtonProps: { loading: true } });
            try { const r = await api.loadSaveSlaProfile(project, { name: name.trim(), slas: sc.slas, ...(sc.slaInterval ? { interval: sc.slaInterval } : {}) }); message.success(`Saved ${r.file}`); reload(); set({ slaProfile: r.file, slas: [] }); close(); }
            catch (e) { message.error(errText(e)); }
            finally { busy = false; inst.update({ okButtonProps: { loading: false } }); }
        };
        const inst = Modal.confirm({
            title: 'Save the service levels as a profile', okText: 'Save',
            content: <Input autoFocus defaultValue={name} maxLength={120} onChange={(e) => { name = e.target.value; }} onPressEnter={() => void submit(() => inst.destroy())} aria-label="Profile name" />,
            onOk: (close) => { void submit(close); },
        });
    };
    return (
        <Space wrap>
            <Typography.Text style={{ fontSize: 12 }}>Profile</Typography.Text>
            <Select size="small" style={{ width: 280 }} allowClear placeholder="none (only the levels below)" value={sc.slaProfile} onChange={(v) => set({ slaProfile: v || undefined })} aria-label="Service-level profile"
                options={list.map((p) => ({ value: p.file, label: p.error ? `${p.name} (invalid)` : `${p.name} · ${p.slas} level${p.slas === 1 ? '' : 's'}`, disabled: !!p.error }))} />
            {sc.slaProfile && <Typography.Text type="secondary" style={{ fontSize: 12 }}>its levels are checked too</Typography.Text>}
            <Button size="small" disabled={!sc.slas.length || !project} onClick={save}>Save these as a profile</Button>
        </Space>
    );
}

/** Where a monitor reads from, by kind (what the fields mean). */
const MONITOR_KINDS: Array<{ value: LoadMonitorDef['kind']; label: string }> = [
    { value: 'prometheus', label: 'Prometheus' }, { value: 'json', label: 'JSON value' }, { value: 'ssh', label: 'Linux (SSH)' },
    { value: 'perfmon', label: 'Windows counter' }, { value: 'jolokia', label: 'JMX (Jolokia)' }, { value: 'sql', label: 'Database query' },
];
/** Counters teams usually watch, by kind (a click fills them in). */
const MONITOR_PRESETS: Partial<Record<LoadMonitorDef['kind'], Array<{ label: string; set: Partial<LoadMonitorDef> }>>> = {
    perfmon: [
        { label: 'CPU', set: { counter: '\\Processor(_Total)\\% Processor Time', unit: '%' } },
        { label: 'Free memory', set: { counter: '\\Memory\\Available MBytes', unit: 'MB' } },
        { label: 'IIS connections', set: { counter: '\\Web Service(_Total)\\Current Connections', unit: '' } },
        { label: 'ASP.NET queued', set: { counter: '\\ASP.NET\\Requests Queued', unit: '' } },
        { label: '.NET exceptions/s', set: { counter: '\\.NET CLR Exceptions(_Global_)\\# of Exceps Thrown / sec', unit: '/s' } },
        { label: 'SQL Server batches/s', set: { counter: '\\SQLServer:SQL Statistics\\Batch Requests/sec', unit: '/s' } },
    ],
    jolokia: [
        { label: 'Heap used', set: { mbean: 'java.lang:type=Memory', attribute: 'HeapMemoryUsage', innerPath: 'used', scale: 1 / 1048576, unit: 'MB' } },
        { label: 'Threads', set: { mbean: 'java.lang:type=Threading', attribute: 'ThreadCount', innerPath: undefined, scale: undefined, unit: '' } },
        { label: 'GC time/s', set: { mbean: 'java.lang:type=GarbageCollector,name=*', attribute: 'CollectionTime', innerPath: undefined, rate: true, scale: undefined, unit: 'ms/s' } },
    ],
    sql: [
        { label: 'SQL Server batches/s', set: { query: "SELECT cntr_value FROM sys.dm_os_performance_counters WHERE counter_name = 'Batch Requests/sec'", rate: true, unit: '/s' } },
        { label: 'SQL Server sessions', set: { query: 'SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1', rate: undefined, unit: '' } },
        { label: 'Oracle commits/s', set: { query: "SELECT value FROM v$sysstat WHERE name = 'user commits'", rate: true, unit: '/s' } },
        { label: 'PostgreSQL active', set: { query: "SELECT count(*) FROM pg_stat_activity WHERE state = 'active'", rate: undefined, unit: '' } },
        { label: 'PostgreSQL commits/s', set: { query: 'SELECT sum(xact_commit) FROM pg_stat_database', rate: true, unit: '/s' } },
    ],
};

/** Servers to watch during the run (Prometheus, JSON, Linux over SSH, Windows counters, JMX, database counters); the load generator is always watched. */
function MonitorsEditor({ sc, set }: { sc: LoadScenarioDef; set: (p: Partial<LoadScenarioDef>) => void }) {
    const list = sc.monitors ?? [];
    const put = (next: LoadMonitorDef[]) => set({ monitors: next.length ? next : undefined, ...(next.length ? {} : { monitorEvery: undefined }) });
    const upd = (i: number, p: Partial<LoadMonitorDef>) => put(list.map((m, j) => (j === i ? { ...m, ...p } : m)));
    const kindChange = (m: LoadMonitorDef, kind: LoadMonitorDef['kind']): LoadMonitorDef => ({ name: m.name, kind, url: kind === 'prometheus' || kind === 'json' || kind === 'jolokia' ? m.url : '',
        ...(m.max !== undefined ? { max: m.max } : {}), ...(m.warn !== undefined ? { warn: m.warn } : {}),
        ...(kind === 'prometheus' ? { metric: '' } : kind === 'json' ? { path: '$.measurements[0].value' } : kind === 'ssh' ? { host: '', preset: 'cpu' as const } : kind === 'perfmon' ? { counter: '\\Processor(_Total)\\% Processor Time', unit: '%' } : kind === 'jolokia' ? { mbean: 'java.lang:type=Memory', attribute: 'HeapMemoryUsage', innerPath: 'used', scale: 1 / 1048576, unit: 'MB' } : { connection: '', query: '' }) });
    const alerting = sc.alerting ?? {};
    const src = (m: LoadMonitorDef, i: number) => {
        const f = (span: number, el: React.ReactNode, label: string) => <Col xs={24} md={span}><Form.Item label={label}>{el}</Form.Item></Col>;
        return <>
            {(m.kind === 'prometheus' || m.kind === 'json' || m.kind === 'jolokia') && f(12, <Input className="mono" value={m.url} onChange={(e) => upd(i, { url: e.target.value })} placeholder={m.kind === 'prometheus' ? 'http://api-host:9100/metrics' : m.kind === 'jolokia' ? 'http://app-host:8778/jolokia' : '{config:API_BASE_URL}/actuator/metrics/system.cpu.usage'} aria-label="Monitor URL" />, 'Address')}
            {m.kind === 'prometheus' && f(12, <Input className="mono" value={m.metric ?? ''} onChange={(e) => upd(i, { metric: e.target.value })} placeholder={'node_load1  or  http_requests_total{status="500"}'} aria-label="Metric" />, 'Metric')}
            {m.kind === 'json' && f(12, <Input className="mono" value={m.path ?? ''} onChange={(e) => upd(i, { path: e.target.value })} placeholder="$.measurements[0].value" aria-label="JSON path" />, 'JSON path')}
            {m.kind === 'ssh' && <>
                {f(8, <Input className="mono" value={m.host ?? ''} onChange={(e) => upd(i, { host: e.target.value })} placeholder="ops@app01:22" aria-label="SSH computer" />, 'Computer')}
                {f(8, <Select value={m.preset ?? 'command'} onChange={(v) => upd(i, v === 'command' ? { preset: undefined, command: m.command ?? '' } : { preset: v as LoadMonitorDef['preset'], command: undefined, unit: v === 'load' ? '' : '%' })} aria-label="Measure"
                    options={[{ value: 'cpu', label: 'CPU busy %' }, { value: 'memory', label: 'Memory used %' }, { value: 'load', label: 'Load average' }, { value: 'disk', label: 'Disk used % (/)' }, { value: 'command', label: 'A command…' }]} />, 'Measure')}
                {f(8, <Tooltip title="Private key file (default: your SSH configuration and agent)"><Input className="mono" value={m.identity ?? ''} onChange={(e) => upd(i, { identity: e.target.value || undefined })} placeholder="key file (optional)" aria-label="Key file" /></Tooltip>, 'Key file')}
                {!m.preset && f(24, <Input className="mono" value={m.command ?? ''} onChange={(e) => upd(i, { command: e.target.value })} placeholder="ss -t state established | wc -l" aria-label="Command" />, 'Command')}
            </>}
            {m.kind === 'perfmon' && <>
                {f(16, <Input className="mono" value={m.counter ?? ''} onChange={(e) => upd(i, { counter: e.target.value })} placeholder="\\Processor(_Total)\\% Processor Time" aria-label="Counter" />, 'Counter')}
                {f(8, <Input value={m.host ?? ''} onChange={(e) => upd(i, { host: e.target.value || undefined })} placeholder="computer" aria-label="Windows computer" />, 'Computer')}
            </>}
            {m.kind === 'jolokia' && <>
                {f(10, <Input className="mono" value={m.mbean ?? ''} onChange={(e) => upd(i, { mbean: e.target.value })} placeholder="java.lang:type=Memory" aria-label="MBean" />, 'MBean')}
                {f(8, <Input className="mono" value={m.attribute ?? ''} onChange={(e) => upd(i, { attribute: e.target.value })} placeholder="HeapMemoryUsage" aria-label="Attribute" />, 'Attribute')}
                {f(6, <Input className="mono" value={m.innerPath ?? ''} onChange={(e) => upd(i, { innerPath: e.target.value || undefined })} placeholder="used" aria-label="Inner path" />, 'Inner path')}
            </>}
            {m.kind === 'sql' && <>
                {f(6, <Input className="mono" value={m.connection ?? ''} onChange={(e) => upd(i, { connection: e.target.value.toUpperCase() })} placeholder="ORDERS" aria-label="Connection" />, 'Connection')}
                {f(18, <Input className="mono" value={m.query ?? ''} onChange={(e) => upd(i, { query: e.target.value })} placeholder="SELECT count(*) FROM pg_stat_activity" aria-label="Query" />, 'Query')}
            </>}
        </>;
    };
    return (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <SectionTitle help="What the servers do while the users hit them, next to the response times. The load generator's own CPU and memory are always recorded. Over the warning level or the maximum, an alert is raised while running; a maximum also fails the run like a service level."
                extra={<>
                    {list.length > 0 && <InputNumber size="small" min={1} max={300} value={sc.monitorEvery ?? 5} onChange={(v) => set({ monitorEvery: v ?? undefined })} addonBefore="every" addonAfter="s" style={{ width: 150 }} aria-label="Monitor interval" />}
                    <Button size="small" icon={<PlusOutlined />} disabled={list.length >= 20} onClick={() => put([...list, { name: `Monitor ${list.length + 1}`, kind: 'prometheus', url: '', metric: '' }])}>Add a monitor</Button>
                </>}>Server monitors {list.length ? <Tag bordered={false}>{list.length}</Tag> : null}</SectionTitle>
            {!list.length && <Typography.Text type="secondary" className="ap-note">None: only the load generator's CPU and memory are recorded.</Typography.Text>}
            {list.map((m, i) => (
                <div key={i} className="ap-card monitor-row">
                    <div className="ap-card-head">
                        <Input size="small" style={{ width: 200, maxWidth: '100%' }} value={m.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="Name, e.g. API CPU" aria-label="Monitor name" />
                        <Select size="small" style={{ width: 160 }} value={m.kind} onChange={(k) => put(list.map((x, j) => (j === i ? kindChange(x, k) : x)))} aria-label="Monitor kind" options={MONITOR_KINDS} />
                        {MONITOR_PRESETS[m.kind] && <Select size="small" style={{ width: 150 }} value={null} placeholder="Common…" onChange={(k: number) => upd(i, MONITOR_PRESETS[m.kind]![k].set)} aria-label="Common counters" options={MONITOR_PRESETS[m.kind]!.map((x, k) => ({ value: k, label: x.label }))} />}
                        <span className="ap-grow" />
                        <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => put(list.filter((_, j) => j !== i))} aria-label="Remove monitor" />
                    </div>
                    <Form layout="vertical" size="small" className="ap-form">
                        <Row gutter={12}>{src(m, i)}</Row>
                        <Row gutter={12} align="bottom">
                            <Col xs={12} md={5}><Form.Item label="Scale" tooltip="Multiply each value, e.g. 0.000001 for bytes to MB"><InputNumber value={m.scale} placeholder="× 1" onChange={(v) => upd(i, { scale: v ?? undefined })} aria-label="Scale" /></Form.Item></Col>
                            <Col xs={12} md={4}><Form.Item label="Unit"><Input value={m.unit ?? ''} onChange={(e) => upd(i, { unit: e.target.value || undefined })} placeholder="unit" aria-label="Unit" /></Form.Item></Col>
                            <Col xs={12} md={5}><Form.Item label="Warning at"><InputNumber value={m.warn} placeholder="none" onChange={(v) => upd(i, { warn: v ?? undefined })} aria-label="Warning level" /></Form.Item></Col>
                            <Col xs={12} md={5}><Form.Item label="Maximum"><InputNumber value={m.max} placeholder="none" onChange={(v) => upd(i, { max: v ?? undefined })} aria-label="Maximum" /></Form.Item></Col>
                            <Col xs={24} md={5}><Form.Item><Tooltip title="A counter (a total that only grows): show how much it grows per second"><Checkbox checked={!!m.rate} onChange={(e) => upd(i, { rate: e.target.checked || undefined })}>per second</Checkbox></Tooltip></Form.Item></Col>
                        </Row>
                    </Form>
                </div>
            ))}
            {list.length > 0 && <div>
                <SectionTitle help="Teams or Slack incoming webhook (or any URL taking JSON with a text field); {config:KEY} or {env:NAME} keeps it out of the file">Alerts</SectionTitle>
                <Space wrap>
                    <Input size="small" className="mono" style={{ width: 320 }} value={alerting.webhook ?? ''} onChange={(e) => { const w = e.target.value; set({ alerting: w || alerting.stopOnCritical ? { ...alerting, webhook: w || undefined } : undefined }); }} placeholder="webhook: {config:LOAD_ALERT_WEBHOOK}" aria-label="Alert webhook" />
                    <Checkbox checked={!!alerting.stopOnCritical} onChange={(e) => set({ alerting: e.target.checked || alerting.webhook ? { ...alerting, stopOnCritical: e.target.checked || undefined } : undefined })}>Stop the run when a monitor goes over its maximum</Checkbox>
                </Space>
            </div>}
        </Space>
    );
}

/** Headers that let the application's APM tool tie its traces to the load test. */
function ApmEditor({ sc, set }: { sc: LoadScenarioDef; set: (p: Partial<LoadScenarioDef>) => void }) {
    const apm = sc.apm ?? {};
    const setApm = (p: Partial<NonNullable<LoadScenarioDef['apm']>>) => { const n = { ...apm, ...p }; set({ apm: n.traceparent || n.dynatrace || n.header ? n : undefined }); };
    return (
        <>
            <SectionTitle help="Headers sent with every request so the application's APM tool can tie its traces to the test.">APM tags</SectionTitle>
            <Space wrap>
                <Tooltip title="W3C Trace Context: a new trace per request, continued by OpenTelemetry, Application Insights, Datadog, New Relic, Dynatrace and AppDynamics agents; failed requests keep their trace id"><Checkbox checked={!!apm.traceparent} onChange={(e) => setApm({ traceparent: e.target.checked || undefined })}>traceparent</Checkbox></Tooltip>
                <Tooltip title="x-dynatrace-test: virtual user, transaction, scenario and run, as Dynatrace's load-testing integration reads them"><Checkbox checked={!!apm.dynatrace} onChange={(e) => setApm({ dynatrace: e.target.checked || undefined })}>Dynatrace test header</Checkbox></Tooltip>
                <Input size="small" className="mono" style={{ width: 150 }} value={apm.header?.name ?? ''} onChange={(e) => setApm({ header: e.target.value ? { name: e.target.value, value: apm.header?.value ?? '{scenario}/{transaction}' } : undefined })} placeholder="Own header: X-Load-Test" aria-label="Own header name" />
                {apm.header && <Input size="small" className="mono" style={{ width: 240 }} value={apm.header.value} onChange={(e) => setApm({ header: { name: apm.header!.name, value: e.target.value } })} placeholder="{scenario}/{transaction}/{user}" aria-label="Own header value" />}
            </Space>
        </>
    );
}

// ---------------------------------------------------------------- run view

function Kpi({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'good' | 'bad' }) {
    return <div className="kpi"><b style={{ color: tone === 'bad' ? '#cf222e' : tone === 'good' ? '#1a7f37' : undefined }}>{value}</b><span>{label}</span></div>;
}

function Delta({ a, b, lowerIsBetter = true, unit = '' }: { a: number; b?: number; lowerIsBetter?: boolean; unit?: string }) {
    if (b === undefined || !Number.isFinite(b) || b === 0) return null;
    const d = ((a - b) / b) * 100;
    if (Math.abs(d) < 1) return <Typography.Text type="secondary" style={{ fontSize: 11 }}> (same)</Typography.Text>;
    const worse = lowerIsBetter ? d > 0 : d < 0;
    return <Tooltip title={`Baseline: ${b}${unit}`}><span style={{ fontSize: 11, color: worse ? '#cf222e' : '#1a7f37' }}> {d > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{Math.abs(d).toFixed(0)}%</span></Tooltip>;
}

const TX_COLORS = ['#0969da', '#1a7f37', '#bf8700', '#8250df', '#cf222e', '#1b7c83', '#bc4c00', '#6e7781'];

/** One failed exchange: what was sent and what came back (secrets masked by the engine). */
function Sample({ s }: { s: LoadErrorSample }) {
    const head = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');
    return (
        <div className="sample">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>At {dur(s.t)}{s.user !== undefined ? ` · user ${s.user + 1}` : ''}{s.response ? ` · HTTP ${s.response.status} in ${s.response.timeMs} ms` : ''}{s.page ? ` · on ${s.page}` : ''}</Typography.Text>
            {s.request && <pre aria-label="Request">{`${s.request.method} ${s.request.url}\n${head(s.request.headers)}${s.request.body ? `\n\n${s.request.body}` : ''}`}</pre>}
            {s.response && <pre aria-label="Response">{`HTTP ${s.response.status} ${s.response.statusText ?? ''}\n${head(s.response.headers)}${s.response.body ? `\n\n${s.response.body}` : ''}`}</pre>}
        </div>
    );
}

const PHASES: Array<{ key: keyof LoadPhases; label: string; color: string }> = [
    { key: 'blocked', label: 'Waiting for a connection', color: '#d0d7de' },
    { key: 'dns', label: 'DNS', color: '#8250df' },
    { key: 'connect', label: 'Connect', color: '#bf8700' },
    { key: 'tls', label: 'TLS', color: '#bc4c00' },
    { key: 'send', label: 'Send', color: '#0969da' },
    { key: 'wait', label: 'Waiting for the server (first byte)', color: '#1a7f37' },
    { key: 'download', label: 'Download', color: '#54aeff' },
];

/** The average exchange split into its phases (a bar; the numbers on hover). */
function PhaseBar({ p }: { p: LoadPhases }) {
    const total = PHASES.reduce((n, x) => n + p[x.key], 0);
    if (total <= 0) return null;
    return (
        <Tooltip title={<div>{PHASES.filter((x) => p[x.key] > 0).map((x) => <div key={x.key}><span style={{ display: 'inline-block', width: 8, height: 8, background: x.color, marginRight: 6 }} />{x.label}: {p[x.key]} ms</div>)}</div>}>
            <div className="phase-bar" role="img" aria-label={PHASES.filter((x) => p[x.key] > 0).map((x) => `${x.label} ${p[x.key]} ms`).join(', ')}>
                {PHASES.filter((x) => p[x.key] > 0).map((x) => <span key={x.key} style={{ width: `${(100 * p[x.key]) / total}%`, background: x.color }} />)}
            </div>
        </Tooltip>
    );
}

function TxErrors({ t }: { t: LoadTx }) {
    return (
        <Space direction="vertical" style={{ width: '100%' }} size={2}>
            {t.topErrors.map((e, i) => (
                <Collapse key={i} size="small" ghost items={[{ key: 'x', label: <Typography.Text type="danger" className="mono">{e.count.toLocaleString()} × {e.message}</Typography.Text>,
                    children: e.samples?.length ? e.samples.map((x, j) => <Sample key={j} s={x} />) : <Typography.Text type="secondary">No details were kept for this error.</Typography.Text> }]} />
            ))}
        </Space>
    );
}


const OVERLAY_COLORS = ['#1677ff', '#d4380d', '#389e0d', '#722ed1'];
/** Analysis of a finished run: a range (default the steady part), monitors against response times, the baseline, other runs on one axis. */
function AnalysisPanel({ d, others, bare }: { d: LoadRunDetailDef; others: LoadRunInfoDef[]; bare?: boolean }) {
    const { message } = App.useApp();
    const [a, setA] = React.useState<LoadAnalysisDef | null>(null);
    const [range, setRange] = React.useState<[number, number] | null>(null);
    const [with_, setWith] = React.useState<string[]>([]);
    const [metric, setMetric] = React.useState<'p95' | 'avg' | 'throughput' | 'errors' | 'users'>('p95');
    const [ov, setOv] = React.useState<Array<{ id: string; label: string; points: Array<{ t: number; v: number }> }> | null>(null);
    const load = React.useCallback((r?: [number, number]) => api.loadAnalysis(d.id, r ? { from: r[0], to: r[1] } : undefined).then((x) => { setA(x); if (!r) setRange(x.steady ? [x.steady.from, x.steady.to] : null); }, (e) => message.error(errText(e))), [d.id, message]);
    React.useEffect(() => { void load(); }, [load]);
    React.useEffect(() => { if (!with_.length) { setOv(null); return; } void api.loadOverlay([d.id, ...with_], metric).then((x) => setOv(x.series), () => setOv(null)); }, [d.id, with_, metric]);
    if (!a) return null;
    const bounds = a.intervals.length ? [a.intervals[0].t0, a.intervals[a.intervals.length - 1].t1] : [0, 0];
    const marks = [...new Set(a.intervals.flatMap((i) => [i.t0, i.t1]))];
    const t = a.range.total;
    const cols = [
        { title: 'Transaction', dataIndex: 'name' }, { title: 'Requests', dataIndex: 'count', align: 'right' as const },
        { title: 'Errors', render: (_: unknown, x: LoadRangeTx) => `${x.errorRate.toFixed(2)}%`, align: 'right' as const },
        ...(['avg', 'p50', 'p90', 'p95', 'p99'] as const).map((k) => ({ title: k === 'avg' ? 'Average' : k, render: (_: unknown, x: LoadRangeTx) => `${x[k]} ms`, align: 'right' as const })),
        { title: 'Req/s', render: (_: unknown, x: LoadRangeTx) => x.throughput.toFixed(1), align: 'right' as const },
    ];
    const toggleBaseline = async () => { try { await api.loadSetBaseline(d.id, !a.isBaseline); message.success(a.isBaseline ? 'No longer the baseline' : 'This run is now the baseline of its scenario'); void load(range ?? undefined); } catch (e) { message.error(errText(e)); } };
    const body = (
            <Space direction="vertical" style={{ width: '100%' }} size={14}>
                {a.intervals.length > 1 && <div>
                    <Space wrap>
                        <Typography.Text style={{ fontSize: 12 }}>Range</Typography.Text>
                        <Select size="small" style={{ width: 90 }} value={range?.[0] ?? bounds[0]} onChange={(v: number) => setRange([v, Math.max(v, range?.[1] ?? bounds[1])])} options={marks.slice(0, -1).map((m) => ({ value: m, label: `${m} s` }))} aria-label="From" />
                        <Select size="small" style={{ width: 90 }} value={range?.[1] ?? bounds[1]} onChange={(v: number) => setRange([Math.min(range?.[0] ?? bounds[0], v), v])} options={marks.slice(1).map((m) => ({ value: m, label: `${m} s` }))} aria-label="To" />
                        <Button size="small" onClick={() => range && void load(range)}>Apply</Button>
                        {a.steady && <Button size="small" type="link" onClick={() => { setRange([a.steady!.from, a.steady!.to]); void load([a.steady!.from, a.steady!.to]); }}>Steady part ({a.steady.from}–{a.steady.to} s)</Button>}
                        <Button size="small" type="link" onClick={() => { setRange([bounds[0], bounds[1]]); void load([bounds[0], bounds[1]]); }}>Whole run</Button>
                    </Space>
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '6px 0' }}>{a.range.from}–{a.range.to} s ({a.range.intervals} intervals): {t.count.toLocaleString()} requests, {t.errorRate.toFixed(2)}% errors, p95 {t.p95} ms, p99 {t.p99} ms, {t.throughput.toFixed(1)} req/s{a.range.exact ? '' : ' (percentiles approximate: an older result)'}.</Typography.Paragraph>
                    <Table size="small" rowKey="id" pagination={false} dataSource={[t, ...a.range.tx]} columns={cols} />
                </div>}
                {a.correlation.length > 0 && <div>
                    <Typography.Text strong style={{ fontSize: 13 }}>Monitors and response times</Typography.Text>
                    <div style={{ fontSize: 12 }}>{a.correlation.map((c) => <div key={c.monitor}><Tag color={c.strength === 'strong' ? 'red' : c.strength === 'moderate' ? 'orange' : 'default'}>{c.strength === 'none' ? 'no link' : `${c.strength} ${c.r > 0 ? 'rise together' : 'move apart'}`}</Tag>{c.monitor}: r = {c.r} over {c.n} samples</div>)}</div>
                </div>}
                <div>
                    <Space wrap>
                        <Typography.Text strong style={{ fontSize: 13 }}>Baseline</Typography.Text>
                        <Button size="small" type={a.isBaseline ? 'primary' : 'default'} onClick={() => void toggleBaseline()}>{a.isBaseline ? 'This run is the baseline' : 'Make this run the baseline'}</Button>
                    </Space>
                    {a.baseline && <div style={{ marginTop: 6 }}>
                        <Alert type={a.baseline.regression.pass ? 'success' : 'error'} showIcon message={`${a.baseline.regression.pass ? 'Not worse than' : 'Worse than'} the baseline of ${new Date(a.baseline.startedAt).toLocaleString()}${a.baseline.gateFromScenario ? '' : ' (default gate: p95 / average +10%, errors +1 point, throughput −10%; set the scenario\'s own gate to fail runs)'}`} description={a.baseline.regression.details.join(' · ')} />
                    </div>}
                </div>
                {others.length > 0 && <div>
                    <Space wrap>
                        <Typography.Text strong style={{ fontSize: 13 }}>Side by side</Typography.Text>
                        <Select size="small" mode="multiple" style={{ minWidth: 320 }} placeholder="Other runs of this scenario (up to 3)" value={with_} onChange={(v: string[]) => setWith(v.slice(0, 3))} aria-label="Runs to compare"
                            options={others.map((r) => ({ value: r.id, label: `${new Date(r.startedAt).toLocaleString()}${r.baseline ? ' (baseline)' : ''}` }))} />
                        {with_.length > 0 && <Dropdown menu={{ items: [{ key: 'html', label: 'Comparison report (HTML)' }, { key: 'pdf', label: 'Comparison report (PDF)' }], onClick: async ({ key }) => {
                            try { const r = await api.loadReport(d.id, key as 'html' | 'pdf', with_); const el = document.createElement('a'); el.href = URL.createObjectURL(r.blob); el.download = r.name; el.click(); URL.revokeObjectURL(el.href); } catch (e) { message.error(errText(e)); }
                        } }}><Button size="small" icon={<DownloadOutlined />}>Comparison report</Button></Dropdown>}
                        <Segmented size="small" value={metric} onChange={(v) => setMetric(v as typeof metric)} options={[{ value: 'p95', label: 'p95' }, { value: 'avg', label: 'Average' }, { value: 'throughput', label: 'Req/s' }, { value: 'errors', label: 'Errors' }, { value: 'users', label: 'Users' }]} />
                    </Space>
                    {ov && ov.length > 0 && (() => {
                        const xs = [...new Set(ov.flatMap((s) => s.points.map((p) => p.t)))].sort((x, y) => x - y);
                        return <LineChart height={200} x={xs} series={ov.map((s, k) => { const m = new Map(s.points.map((p) => [p.t, p.v])); return { name: k === 0 ? 'This run' : s.label, color: OVERLAY_COLORS[k], values: xs.map((x) => m.get(x) ?? NaN), unit: metric === 'p95' || metric === 'avg' ? 'ms' : '' }; })} xFormat={(v) => `${v} s`} />;
                    })()}
                </div>}
            </Space>
    );
    return bare ? body : <Collapse size="small" items={[{ key: 'a', label: <b>Analysis</b>, children: body }]} />;
}

function RunView({ id, runs, onChanged }: { id: string; runs: LoadRunInfoDef[]; onChanged: () => void }) {
    const { message, modal } = App.useApp();
    const [d, setD] = React.useState<LoadRunDetailDef | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [baseId, setBaseId] = React.useState<string | undefined>();
    const [base, setBase] = React.useState<LoadRunDetailDef | null>(null);
    const [txSel, setTxSel] = React.useState<string | null>(null);
    const [tab, setTab] = useRememberedTab('perf-run', 'summary');
    const load = React.useCallback(() => api.loadRun(id).then(setD).catch((e) => setErr(errText(e))), [id]);
    React.useEffect(() => { setD(null); setBaseId(undefined); void load(); }, [load]);
    const live = d && (d.state === 'running' || d.state === 'stopping');
    React.useEffect(() => { if (!live) return; const t = setInterval(() => { void load(); }, 1000); return () => clearInterval(t); }, [live, load]);
    React.useEffect(() => { if (d && !live) onChanged(); }, [d?.state]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { setBase(null); if (baseId) api.loadRun(baseId).then(setBase).catch(() => setBase(null)); }, [baseId]);
    if (err) return <Alert type="error" showIcon style={{ margin: 12 }} message={err} />;
    if (!d) return <Spin style={{ margin: 40 }} />;
    const s = d.result ?? d.live;
    const tl = s?.timeline ?? [];
    const others = runs.filter((r) => r.id !== id && r.scenario === d.scenario && r.state === 'finished');
    const bt = base?.result?.total;
    const btx = new Map((base?.result?.transactions ?? []).map((t) => [t.id, t]));
    const downloadJunit = async () => {
        try {
            const xml = await api.loadJunit(id);
            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' })); a.download = `load-${id}.junit.xml`; a.click(); URL.revokeObjectURL(a.href);
        } catch (e) { message.error(errText(e)); }
    };
    const report = async (format: 'html' | 'xlsx' | 'pdf' | 'docx') => {
        try { const r = await api.loadReport(id, format); const a = document.createElement('a'); a.href = URL.createObjectURL(r.blob); a.download = r.name; a.click(); URL.revokeObjectURL(a.href); }
        catch (e) { message.error(errText(e)); }
    };
    // Per transaction: one chart for the chosen one, and the 95% of the busiest ones together.
    const txt = s?.txTimeline ?? {};
    const seconds = tl.map((x) => x.t);
    const fill = (id: string, key: 'p95' | 'avg') => { const m = new Map((txt[id] ?? []).map((p) => [p.t, p[key]])); let last = 0; return seconds.map((t) => { const v = m.get(t); if (v !== undefined) last = v; return last; }); };
    const busiest = [...(s?.transactions ?? [])].sort((a, b) => b.count - a.count).slice(0, TX_COLORS.length);
    const chosen = s?.transactions.find((t) => t.id === txSel) ?? null;
    const chosenTl = chosen ? txt[chosen.id] ?? [] : [];
    const pops = s?.populations ?? [];
    const verdict = d.state === 'error' ? <Tag color="error">Could not run</Tag> : live ? <Tag color="processing">{d.state === 'stopping' ? 'Stopping…' : 'Running'}</Tag>
        : <>{d.result?.passed ? <Tag color="success" icon={<CheckCircleFilled />}>Passed</Tag> : <Tag color="error" icon={<CloseCircleFilled />}>Failed</Tag>}{d.result?.stopReason === 'stopped' && <Tag color="warning" icon={<StopOutlined />}>Stopped at {Math.round(d.result.elapsed)} s of {d.definition.policy.duration} s</Tag>}</>;
    return (
        <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    {verdict}
                    <Typography.Text strong style={{ fontSize: 15 }}>{d.name}</Typography.Text>
                    <Typography.Text type="secondary">{d.project} / {d.env} · {new Date(d.startedAt).toLocaleString()}{d.result ? ` · ${dur(d.result.elapsed)}` : ''}</Typography.Text>
                    <div style={{ flex: 1 }} />
                    {live && d.state === 'running' && <Space.Compact>
                        {[0.5, 1, 1.5, 2].map((f) => <Tooltip key={f} title={`Run at ${f * 100}% of the planned load from now`}><Button size="small" type={(d.loadFactor ?? 1) === f ? 'primary' : 'default'} onClick={async () => { try { await api.loadAdjust(id, f); void load(); } catch (e) { message.error(errText(e)); } }}>{f * 100}%</Button></Tooltip>)}
                    </Space.Compact>}
                    {live && <Button danger icon={<StopOutlined />} disabled={d.state === 'stopping'} onClick={async () => { try { await api.loadStop(id); void load(); } catch (e) { message.error(errText(e)); } }}>Stop</Button>}
                    {d.state === 'finished' && <>
                        {others.length > 0 && <Select size="small" allowClear placeholder="Compare with an earlier run" style={{ width: 260 }} value={baseId} onChange={setBaseId}
                            options={others.map((r) => ({ value: r.id, label: `${new Date(r.startedAt).toLocaleString()} · p95 ${r.summary?.p95 ?? '?'} ms` }))} />}
                        <Dropdown menu={{ items: [{ key: 'html', label: 'HTML report (charts, errors; to share or print)' }, { key: 'pdf', label: 'PDF report' }, { key: 'docx', label: 'Word document' }, { key: 'xlsx', label: 'Excel workbook (all numbers, timelines)' }, { type: 'divider' }, { key: 'junit', label: 'JUnit XML (one test per service level, for a pipeline)' }],
                            onClick: ({ key }) => (key === 'junit' ? void downloadJunit() : void report(key as 'html' | 'xlsx' | 'pdf' | 'docx')) }}>
                            <Button size="small" icon={<DownloadOutlined />}>Report</Button>
                        </Dropdown>
                        {others.length > 0 && <Button size="small" onClick={() => navigate(['perf-compare', ...d.scenario.split('/'), '@', others[0].id, id])}>Compare with…</Button>}
                        <Button size="small" onClick={async () => { try { const t = await api.loadShare(id); message.success(`Shared with the team: ${t.file}`); } catch (e) { message.error(errText(e)); } }}>Share with the team</Button>
                        <Dropdown menu={{ items: [{ key: 'del', danger: true, icon: <DeleteOutlined />, label: 'Delete this run…' }], onClick: () => modal.confirm({ title: 'Delete this run?', content: 'Its results are removed from this computer.', okButtonProps: { danger: true }, onOk: async () => { try { await api.loadDeleteRun(id); onChanged(); navigate(['perf-runs']); } catch (e) { message.error(errText(e)); } } }) }}><Button size="small" aria-label="More">⋯</Button></Dropdown>
                    </>}
                </div>
                {d.message && <Alert type={d.state === 'error' ? 'error' : 'info'} showIcon message={d.message} />}
                {d.result?.stopReason === 'data-used' && <Alert type="info" showIcon message="Ended when every test data row had been used once." />}
                {d.result?.stopReason === 'error-rate' && <Alert type="error" showIcon message={`Stopped early: more than ${d.definition.stopOnErrorRate}% of the requests failed.`} />}
                {d.result?.stopReason === 'stopped' && <Alert type="info" showIcon message="Stopped before the end." />}
                {d.result?.stopReason === 'alert' && <Alert type="error" showIcon message="Stopped: a monitor went over its maximum." />}
                {!!s?.alerts?.length && <Alert type={s.alerts.some((a) => a.level === 'critical') ? 'error' : 'warning'} showIcon message={`Alerts (${s.alerts.length})`}
                    description={<div className="mono" style={{ fontSize: 12 }}>{s.alerts.slice(-8).map((a, k) => <div key={k}>{a.level === 'critical' ? '🔴' : a.level === 'warning' ? '🟠' : '🟢'} {Math.round(a.t)} s · {a.message}</div>)}</div>} />}
                {s?.overload && <Alert type="warning" showIcon message="The load generator was the bottleneck" description={s.overload} />}
                {!!d.generators?.length && <GeneratorsHealth gens={d.generators} />}
                {live && <Progress percent={Math.min(100, Math.round(((s?.elapsed ?? 0) / d.duration) * 100))} format={() => `${dur(s?.elapsed ?? 0)} of ${dur(d.duration)}`} />}
                {s && <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                    <Kpi label="Users now" value={s.users} />
                    <Kpi label="Requests" value={<>{s.total.count.toLocaleString()}{bt && <Delta a={s.total.count} b={bt.count} lowerIsBetter={false} />}</>} />
                    <Kpi label="Requests / s" value={<>{s.total.throughput.toFixed(1)}{bt && <Delta a={s.total.throughput} b={bt.throughput} lowerIsBetter={false} />}</>} />
                    <Kpi label="Errors" value={<>{s.total.errorRate.toFixed(2)}%{bt && <Delta a={s.total.errorRate} b={bt.errorRate} unit="%" />}</>} tone={s.total.errorRate > 0 ? 'bad' : 'good'} />
                    <Kpi label="Average" value={<>{ms(s.total.avg)}{bt && <Delta a={s.total.avg} b={bt.avg} unit=" ms" />}</>} />
                    <Kpi label="95% under" value={<>{ms(s.total.p95)}{bt && <Delta a={s.total.p95} b={bt.p95} unit=" ms" />}</>} />
                    <Kpi label="99% under" value={ms(s.total.p99)} />
                    <Kpi label="Iterations" value={s.iterations.toLocaleString()} />
                    {s.dropped !== undefined && <Kpi label="Dropped" value={s.dropped.toLocaleString()} tone={s.dropped > 0 ? 'bad' : 'good'} />}
                </div>}
                {pops.length > 1 && <div className="pop-row" aria-label="User paths">
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>User paths:</Typography.Text>
                    {pops.map((p, i) => <Tag key={p.name} bordered={false} color={['purple', 'blue', 'green', 'gold', 'magenta', 'cyan'][i % 6]}>{p.name} · {p.share}%{live ? ` · ${p.users} user${p.users === 1 ? '' : 's'} now` : ''}</Tag>)}
                </div>}
                <Tabs size="small" className="ap-tabs" activeKey={shownTab(tab, [d.state === 'finished' && !!d.result && 'summary', 'charts', !!s?.transactions.length && 'tx', d.state === 'finished' && !!d.result && 'analysis'])} onChange={setTab} items={[
                    ...(d.state === 'finished' && d.result ? [{ key: 'summary', label: <span>Summary{d.result.slas.length ? <Tag bordered={false} color={d.result.slas.every((x) => x.pass) ? 'success' : 'error'} style={{ marginInlineStart: 4 }}>{d.result.slas.filter((x) => x.pass).length}/{d.result.slas.length}</Tag> : null}</span>, children: <Space direction="vertical" size={14} style={{ width: '100%' }}>
                        <RunSummary id={d.id} />
                        {d.result && d.result.slas.length > 0 && <div>
                            <SectionTitle>Service levels</SectionTitle>
                            <Space direction="vertical">{d.result.slas.map((x, i) => <span key={i}>{!x.pass ? <CloseCircleFilled style={{ color: '#cf1322' }} /> : x.level === 'warning' ? <CheckCircleFilled style={{ color: '#d48806' }} /> : <CheckCircleFilled style={{ color: '#389e0d' }} />} <b>{x.name}</b>{x.sla.per === 'interval' ? ' (every interval)' : ''}: {x.details.join(', ')}{x.level === 'warning' ? ' — warning' : ''}</span>)}</Space>
                        </div>}
                        <InsightsPanel d={d} />
                    </Space> }] : []),
                    { key: 'charts', label: 'Charts', children: <Space direction="vertical" size={14} style={{ width: '100%' }}>
                        {tl.length <= 1 && <Typography.Text type="secondary">{live ? 'The charts start after a couple of seconds…' : 'The run was too short for charts.'}</Typography.Text>}
                        {tl.length > 1 && <Row gutter={16}>
                            <Col xs={24} xl={12}><LineChart title="Load" x={tl.map((x) => x.t)} xMax={d.duration} series={[{ name: 'Users', color: C.users, values: tl.map((x) => x.users), area: true }, { name: 'Requests/s', color: C.rps, values: tl.map((x) => x.requests), right: true }]} /></Col>
                            <Col xs={24} xl={12}><LineChart title="Response time" x={tl.map((x) => x.t)} xMax={d.duration} series={[{ name: 'Average', color: C.avg, values: tl.map((x) => x.avg), unit: ' ms' }, { name: '95%', color: C.p95, values: tl.map((x) => x.p95), unit: ' ms' }, { name: 'Errors/s', color: C.errors, values: tl.map((x) => x.errors), right: true }]} /></Col>
                        </Row>}
                        {tl.length > 1 && busiest.length > 1 && Object.keys(txt).length > 0 && <LineChart title="95% response time by transaction" x={seconds} xMax={d.duration}
                            series={busiest.map((t, i) => ({ name: t.name, color: TX_COLORS[i], values: fill(t.id, 'p95'), unit: ' ms' }))} />}
                        {(s?.monitors ?? []).some((m) => m.points.length > 1 || m.error) && <div>
                            <SectionTitle>Monitoring</SectionTitle>
                            <Row gutter={[16, 8]}>{(s?.monitors ?? []).map((m) => (
                                <Col key={m.name} xs={24} lg={12} xl={8}>
                                    {m.points.length > 1 ? <LineChart height={130} title={`${m.name}${m.unit ? ` (${m.unit})` : ''}${m.max !== undefined ? ` · max ${m.max}` : ''}`} x={m.points.map((p) => p.t)} xMax={d.duration}
                                        series={[{ name: m.name, color: m.generator ? '#6e7781' : m.max !== undefined && m.points.some((p) => p.v > m.max!) ? C.errors : C.users, values: m.points.map((p) => p.v), unit: m.unit ? ` ${m.unit}` : '', area: true }]} />
                                        : <Typography.Text type="secondary" style={{ fontSize: 12 }}><b>{m.name}</b>: {m.error ? <Typography.Text type="danger">{m.error}</Typography.Text> : live ? 'waiting for values…' : 'no values were recorded'}</Typography.Text>}
                                    {m.error && m.points.length > 1 && <Typography.Text type="danger" style={{ fontSize: 11 }}>Last read failed: {m.error}</Typography.Text>}
                                </Col>))}
                            </Row>
                        </div>}
                    </Space> },
                    ...(s && s.transactions.length > 0 ? [{ key: 'tx', label: <span>Transactions<Tag bordered={false} style={{ marginInlineStart: 4 }}>{s.transactions.length}</Tag></span>, children: <div>
                    <Typography.Text type="secondary" className="ap-note" style={{ marginBottom: 6 }}>Click a row for its chart; open a row with errors for what was sent and received.</Typography.Text>
                    <Table<LoadTx> size="small" rowKey="id" pagination={false} dataSource={s.transactions} scroll={{ x: 1100 }}
                        rowClassName={(t) => (t.id === txSel ? 'ant-table-row-selected' : '')}
                        onRow={(t) => ({ onClick: () => setTxSel(t.id === txSel ? null : t.id), style: { cursor: 'pointer' } })}
                        expandable={{ rowExpandable: (t) => t.topErrors.length > 0, expandedRowRender: (t) => <TxErrors t={t} /> }}
                        columns={[
                            { title: 'Request', dataIndex: 'name', width: 240, fixed: 'left', ellipsis: { showTitle: true } },
                            { title: 'Count', dataIndex: 'count', width: 80, align: 'right', render: (v: number) => v.toLocaleString() },
                            { title: 'Errors', dataIndex: 'errorRate', width: 100, align: 'right', render: (v: number, t) => <span style={{ color: v > 0 ? '#cf222e' : undefined }}>{v.toFixed(2)}%{btx.get(t.id) && <Delta a={v} b={btx.get(t.id)!.errorRate} />}</span> },
                            { title: 'Avg', dataIndex: 'avg', width: 100, align: 'right', render: (v: number, t) => <>{ms(v)}{btx.get(t.id) && <Delta a={v} b={btx.get(t.id)!.avg} />}</> },
                            { title: '50%', dataIndex: 'p50', width: 80, align: 'right', render: ms },
                            { title: '90%', dataIndex: 'p90', width: 80, align: 'right', render: ms },
                            { title: '95%', dataIndex: 'p95', width: 100, align: 'right', render: (v: number, t) => <>{ms(v)}{btx.get(t.id) && <Delta a={v} b={btx.get(t.id)!.p95} />}</> },
                            { title: '99%', dataIndex: 'p99', width: 80, align: 'right', render: ms },
                            { title: 'Max', dataIndex: 'max', width: 80, align: 'right', render: ms },
                            { title: 'Per second', dataIndex: 'throughput', width: 90, align: 'right', render: (v: number) => v.toFixed(1) },
                            { title: 'Where the time goes', key: 'phases', width: 200, render: (_, t) => (t.phases ? <PhaseBar p={t.phases} /> : null) },
                        ]} />
                    {chosen && <div style={{ marginTop: 12 }}>
                        {chosenTl.length > 1 ? <Row gutter={16}>
                            <Col xs={24} xl={12}><LineChart title={`${chosen.name}: response time`} x={chosenTl.map((p) => p.t)} xMax={d.duration} series={[{ name: 'Average', color: C.avg, values: chosenTl.map((p) => p.avg), unit: ' ms' }, { name: '95%', color: C.p95, values: chosenTl.map((p) => p.p95), unit: ' ms' }]} /></Col>
                            <Col xs={24} xl={12}><LineChart title={`${chosen.name}: per second`} x={chosenTl.map((p) => p.t)} xMax={d.duration} series={[{ name: 'Requests/s', color: C.rps, values: chosenTl.map((p) => p.n) }, { name: 'Errors/s', color: C.errors, values: chosenTl.map((p) => p.e), right: true }]} /></Col>
                        </Row> : <Typography.Text type="secondary">{chosen.name} ran in fewer than two seconds of the run: not enough for a chart.</Typography.Text>}
                    </div>}
                    </div> }] : []),
                    ...(d.state === 'finished' && d.result ? [{ key: 'analysis', label: 'Analysis', children: <AnalysisPanel d={d} others={others} bare /> }] : []),
                ]} />
            </Space>
        </div>
    );
}

/** One scenario across its runs: is it getting slower, failing more, serving less? */
type TrendRun = LoadRunInfoDef & { teamFile?: string; by?: LoadTeamRunDef['by'] };
/** Trends of a scenario: this computer's runs, or the team's (the shared results folder). */
function Trends({ file, runs, name }: { file: string; runs: LoadRunInfoDef[]; name: string }) {
    const { message } = App.useApp();
    const [source, setSource] = React.useState<'mine' | 'team'>('mine');
    const [team, setTeam] = React.useState<{ folder: string | null; runs: LoadTeamRunDef[]; error?: string } | null>(null);
    const project = file.split('/')[1];
    React.useEffect(() => { if (source === 'team') void api.loadTeam(project, file).then(setTeam, (e) => message.error(errText(e))); }, [source, project, file, message]);
    const mine: TrendRun[] = runs.filter((r) => r.scenario === file && r.state === 'finished' && r.summary);
    const shared: TrendRun[] = (team?.runs ?? []).map((t) => ({ id: t.id, scenario: t.scenario, name: t.name, project: t.project, env: t.env, startedAt: t.startedAt, state: 'finished', maxUsers: t.maxUsers, duration: t.duration, passed: t.passed, summary: t.summary, teamFile: t.file, by: t.by }));
    const list = (source === 'team' ? shared : mine).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const open = async (r: TrendRun) => {
        if (!r.teamFile) { navigate(['perf-runs', r.id]); return; }
        try { const info = await api.loadTeamOpen(r.teamFile); navigate(['perf-runs', info.id]); } catch (e) { message.error(errText(e)); }
    };
    const switcher = <Segmented size="small" value={source} onChange={(v) => setSource(v as 'mine' | 'team')} options={[{ value: 'mine', label: 'This computer' }, { value: 'team', label: 'Team' }]} />;
    if (source === 'team' && team && !team.folder) return <div style={{ padding: 16 }}>{switcher}<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 60 }} description={<>Set the team's shared results folder to see everyone's runs.<br /><Button size="small" type="link" onClick={() => navigate(['settings'])}>Open Settings</Button></>} /></div>;
    if (!list.length) return <div style={{ padding: 16 }}>{switcher}<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 60 }} description={team?.error ?? `"${name}" has no finished runs ${source === 'team' ? 'shared with the team' : 'on this computer'} yet.`} /></div>;
    const x = list.map((_, i) => i + 1);
    // Run number, and its date (or time, when all runs are on one day); only at whole run numbers.
    const oneDay = new Set(list.map((r) => new Date(r.startedAt).toDateString())).size === 1;
    const label = (v: number) => {
        if (Math.abs(v - Math.round(v)) > 0.01) return '';
        const r = list[Math.round(v) - 1];
        if (!r) return '';
        const d = new Date(r.startedAt);
        return `#${Math.round(v)} ${oneDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    };
    const last = list[list.length - 1].summary!, prev = list.length > 1 ? list[list.length - 2].summary! : undefined;
    return (
        <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
                <Space wrap><Typography.Text strong style={{ fontSize: 15 }}>{name} <Typography.Text type="secondary" style={{ fontWeight: 400 }}>· {list.length} run{list.length === 1 ? '' : 's'}</Typography.Text></Typography.Text>{switcher}</Space>
                <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                    <Kpi label="Latest: 95% under" value={<>{ms(last.p95)}{prev && <Delta a={last.p95} b={prev.p95} unit=" ms" />}</>} />
                    <Kpi label="Latest: average" value={<>{ms(last.avg)}{prev && <Delta a={last.avg} b={prev.avg} unit=" ms" />}</>} />
                    <Kpi label="Latest: errors" value={<>{last.errorRate.toFixed(2)}%{prev && <Delta a={last.errorRate} b={prev.errorRate} unit="%" />}</>} tone={last.errorRate > 0 ? 'bad' : 'good'} />
                    <Kpi label="Latest: requests / s" value={<>{last.throughput.toFixed(1)}{prev && <Delta a={last.throughput} b={prev.throughput} lowerIsBetter={false} />}</>} />
                    <Kpi label="Passed" value={`${list.filter((r) => r.passed).length} of ${list.length}`} />
                </div>
                {list.length > 1 && <Row gutter={16}>
                    <Col xs={24} xl={12}><LineChart title="Response time per run" x={x} xMin={1} xMax={list.length} xFormat={label} series={[{ name: '95%', color: C.p95, values: list.map((r) => r.summary!.p95), unit: ' ms' }, { name: 'Average', color: C.avg, values: list.map((r) => r.summary!.avg), unit: ' ms' }]} /></Col>
                    <Col xs={24} xl={12}><LineChart title="Throughput and errors per run" x={x} xMin={1} xMax={list.length} xFormat={label} series={[{ name: 'Requests/s', color: C.rps, values: list.map((r) => r.summary!.throughput) }, { name: 'Errors %', color: C.errors, values: list.map((r) => r.summary!.errorRate), unit: '%', right: true }]} /></Col>
                </Row>}
                <Table<TrendRun> size="small" rowKey={(r) => r.teamFile ?? r.id} pagination={false} dataSource={[...list].reverse()}
                    onRow={(r) => ({ onClick: () => void open(r), style: { cursor: 'pointer' } })}
                    columns={[
                        { title: 'Run', dataIndex: 'startedAt', render: (v: string) => new Date(v).toLocaleString() },
                        ...(source === 'team' ? [{ title: 'By', width: 170, render: (_: unknown, r: TrendRun) => (r.by?.pipeline ? `Pipeline ${r.by.pipeline}` : `${r.by?.user ?? ''} on ${r.by?.machine ?? ''}`) }] : []),
                        { title: 'Environment', dataIndex: 'env', width: 110 },
                        { title: 'Users', dataIndex: 'maxUsers', width: 70, align: 'right' },
                        { title: 'Requests', width: 100, align: 'right', render: (_, r) => r.summary!.requests.toLocaleString() },
                        { title: '95%', width: 90, align: 'right', render: (_, r) => ms(r.summary!.p95) },
                        { title: 'Average', width: 90, align: 'right', render: (_, r) => ms(r.summary!.avg) },
                        { title: 'Errors', width: 80, align: 'right', render: (_, r) => `${r.summary!.errorRate.toFixed(2)}%` },
                        { title: 'Per second', width: 95, align: 'right', render: (_, r) => r.summary!.throughput.toFixed(1) },
                        { title: 'Verdict', width: 90, render: (_, r) => (r.passed ? <Tag color="success">Passed</Tag> : <Tag color="error">Failed</Tag>) },
                    ]} />
            </Space>
        </div>
    );
}

// ---------------------------------------------------------------- page

export type PerfMode = 'scenarios' | 'runs' | 'trends' | 'compare';
const KEY: Record<PerfMode, string> = { scenarios: 'perf', runs: 'perf-runs', trends: 'perf-trends', compare: 'perf-compare' };

/** Performance: Scenarios (edit, run), Runs (live and results), Trends (one scenario across runs). */
export function Performance({ mode }: { mode: PerfMode }) {
    const { message, modal } = App.useApp();
    const route = useRoute();
    const here = route[0] === KEY[mode];
    const [meta, setMeta] = React.useState<Awaited<ReturnType<typeof api.loadScenarios>> | null>(null);
    const [runs, setRuns] = React.useState<LoadRunInfoDef[]>([]);
    const [project, setProjectRaw] = React.useState<string>(() => loadPref('cs-studio-perf-project', ''));
    const [env, setEnv] = React.useState<string | undefined>(() => loadPref<string | undefined>('cs-studio-perf-env', undefined));
    const [open, setOpen] = React.useState<{ file: string | null; sc: LoadScenarioDef; dirty: boolean } | null>(null);
    useUnsaved('load-scenario', !!open?.dirty, 'a load scenario', { lostOnLeave: true });
    useAgentContext('perf', { project, environment: env, scenario: open?.file ?? null, scenarioName: open?.sc.name, unsaved: open?.dirty });
    const [reqs, setReqs] = React.useState<Req[] | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [creating, setCreating] = React.useState(false);
    const [form, setForm] = React.useState<{ name: string; kind: 'api' | 'browser'; coll?: string; bpath?: string }>({ name: '', kind: 'api' });
    const [bpath, setBpath] = React.useState<BrowserPathDef | null>(null);
    const [importing, setImporting] = React.useState(false);
    const [importText, setImportText] = React.useState('');
    // Addresses: #/perf/<scenario file>, #/perf-runs/<run id>, #/perf-trends/<scenario file>
    const runId = mode === 'runs' && here ? route[1] : undefined;
    const scenarioFile = mode === 'scenarios' && here && route[1] ? decodeURIComponent(route.slice(1).join('/')) : null;
    const trendFile = mode === 'trends' && here && route[1] ? decodeURIComponent(route.slice(1).join('/')) : null;
    // #/perf-compare/<scenario file>[/@/<run A>/<run B>]
    const cmpAt = route.indexOf('@');
    const compareFile = mode === 'compare' && here && route[1] ? decodeURIComponent(route.slice(1, cmpAt > 0 ? cmpAt : undefined).join('/')) : null;
    const compareIds = mode === 'compare' && cmpAt > 0 ? { a: route[cmpAt + 1], b: route[cmpAt + 2] } : {};
    const view = mode === 'runs' ? 'run' : 'scenario';

    const refresh = React.useCallback(async () => {
        try {
            const [m, r] = await Promise.all([api.loadScenarios(), api.loadRuns()]);
            setMeta(m); setRuns(r.runs);
            setProjectRaw((p) => (p && m.projects.includes(p) ? p : m.scenarios[0]?.project ?? m.collections[0]?.project ?? m.projects[0] ?? ''));
        } catch (e) { setErr(errText(e)); }
    }, []);
    React.useEffect(() => { if (here) void refresh(); }, [here, refresh]);
    // While a run is going, keep the list (and its "running" badge) fresh.
    React.useEffect(() => { if (!here || !runs.some((r) => r.state === 'running' || r.state === 'stopping')) return; const t = setInterval(() => { void api.loadRuns().then((r) => setRuns(r.runs)).catch(() => {}); }, 3000); return () => clearInterval(t); }, [here, runs]);
    React.useEffect(() => {
        if (!scenarioFile || open?.file === scenarioFile) return;
        api.loadScenario(scenarioFile).then((r) => setOpen({ file: r.file, sc: r.scenario, dirty: false })).catch((e) => setErr(errText(e)));
    }, [scenarioFile]); // eslint-disable-line react-hooks/exhaustive-deps
    // Requests of the scenario's collection.
    React.useEffect(() => { setReqs(null); if (open?.sc.collection && !open.sc.browserPath) api.apiCollection(open.sc.collection).then((r) => setReqs(flatRequests(r.collection))).catch(() => setReqs([])); }, [open?.sc.collection, open?.sc.browserPath]);
    React.useEffect(() => { setBpath(null); if (open?.sc.browserPath) api.loadBrowserPath(open.sc.browserPath).then((r) => setBpath(r.path)).catch((e) => setErr(errText(e))); }, [open?.sc.browserPath]);
    const projectOf = (sc: LoadScenarioDef) => (sc.browserPath ?? sc.collection).split('/')[1];
    const setProject = (p: string) => { setProjectRaw(p); savePref('cs-studio-perf-project', p); setEnv(undefined); };
    const envs = meta?.environments[project] ?? [];

    // A double click saves (and starts) once: a new scenario would otherwise be written twice.
    const busy = React.useRef(false);
    const save = async (): Promise<string | null> => {
        if (!open || busy.current) return null;
        busy.current = true;
        try { return await saveNow(); } finally { busy.current = false; }
    };
    const saveNow = async (): Promise<string | null> => {
        if (!open) return null;
        if (curveInvalid) { message.error('The custom curve has mistakes (shown under it): fix them before saving.'); return null; }
        try {
            const r = await api.loadSaveScenario(projectOf(open.sc), open.sc, open.file ?? undefined);
            setOpen({ ...open, file: r.file, dirty: false }); message.success('Saved'); await refresh();
            if (!open.file) navigate(['perf', ...r.file.split('/')], true);
            return r.file;
        } catch (e) { message.error(errText(e)); return null; }
    };
    const starting = React.useRef(false);
    const run = async () => {
        if (starting.current) return;
        if (curveInvalid) { message.error('The custom curve has mistakes (shown under it): fix them before running.'); return; }
        starting.current = true;
        const file = open?.dirty || !open?.file ? await save() : open.file;
        if (!file || !open) { starting.current = false; return; }
        const users = Math.max(...policyCurve(open.sc.policy).map((c) => c.users));
        modal.confirm({
            title: `Start "${open.sc.name}"?`, okText: 'Start',
            content: <Space direction="vertical"><span>Up to <b>{users}</b> virtual user{users === 1 ? '' : 's'} for <b>{dur(open.sc.policy.duration)}</b> against the servers of <b>{env ?? envs[0] ?? 'the default environment'}</b>.</span><Typography.Text type="warning">Only load-test systems you are allowed to put under load (usually a test environment, never production without agreement).</Typography.Text></Space>,
            onOk: async () => { try { const r = await api.loadStart(file, env); await refresh(); navigate(['perf-runs', r.id]); } catch (e) { message.error(errText(e)); } },
            afterClose: () => { starting.current = false; },
        });
    };
    const leave = (then: () => void) => {
        if (!open?.dirty) { then(); return; }
        (() => {
            // Save, Discard or Stay (Escape and the close button stay: unsaved changes are never dropped by accident).
            const inst = modal.confirm({ title: `Save the changes to "${open.sc.name}"?`, okText: 'Save', closable: true, onOk: async () => { if (await save()) then(); },
                footer: (_: React.ReactNode, { OkBtn }: { OkBtn: React.FC }) => <><Button onClick={() => inst.destroy()}>Stay</Button><Button danger onClick={() => { inst.destroy(); then(); }}>Discard</Button><OkBtn /></> });
        })();
    };

    const scenarios = (meta?.scenarios ?? []).filter((s) => s.project === project);
    const collections = (meta?.collections ?? []).filter((c) => c.project === project);
    const projectRuns = runs.filter((r) => r.project === project);
    // Several tests can run at once; a scenario runs once at a time.
    const running = runs.find((r) => (r.state === 'running' || r.state === 'stopping') && r.scenario === open?.file);
    const paths = (meta?.browserPaths ?? []).filter((b) => b.project === project);
    const [recording, setRecording] = React.useState(false);
    const createScenario = () => {
                const user = form.kind === 'api' ? form.coll : form.bpath;
                if (!form.name.trim() || !user) { message.info(`Give it a name and choose ${form.kind === 'api' ? 'a collection' : 'a browser path'}.`); return; }
                const sc = form.kind === 'api' ? newScenario(form.name.trim(), user) : { ...newScenario(form.name.trim(), ''), browserPath: user, thinkTime: { min: 2000, max: 5000 }, policy: { type: 'ramp' as const, users: 5, duration: 300, rampUp: 60, rampDown: 30 }, slas: [{ target: '*', p95: 5000, errorRate: 1 }], timeout: 45_000 };
                setCreating(false);
                leave(() => { setOpen({ file: null, sc, dirty: true }); navigate(['perf'], true); });
    };
    return (<>
        <Split id="perf-list" initial={300} min={220} max={520} style={{ height: 'calc(100vh - var(--chrome))' }}>
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="toolbar" style={{ display: 'block' }}>
                    <div className="filter-row">
                        <Select size="small" style={{ flex: 1, minWidth: 110 }} value={project || undefined} placeholder="Project" onChange={setProject} options={(meta?.projects ?? []).map((p) => ({ value: p, label: p }))} aria-label="Project" />
                        <Select size="small" style={{ width: 96 }} value={env} placeholder={envs[0] ?? 'env'} allowClear disabled={!envs.length} onChange={(v) => { setEnv(v); savePref('cs-studio-perf-env', v); }} options={envs.map((e) => ({ value: e, label: e }))} aria-label="Environment" />
                    </div>
                    {mode === 'runs' && <div className="filter-row">
                        <Tooltip title="Results of a pipeline (cs-test-studio load … --json). Several files are the parts of one distributed run: they are merged.">
                            <Upload accept=".json" multiple showUploadList={false} beforeUpload={(_f, files) => {
                                if (_f !== files[0]) return false;
                                void Promise.all(files.map((f) => f.text())).then(async (texts) => { try { const r = await api.loadImportRuns(texts); message.success(texts.length > 1 ? `Merged ${texts.length} parts` : 'Imported'); await refresh(); navigate(['perf-runs', r.id]); } catch (e) { message.error(errText(e)); } });
                                return false;
                            }}><Button size="small" icon={<ImportOutlined />}>Import results</Button></Upload>
                        </Tooltip>
                        <Tooltip title="A pipeline run that published its load results as a pipeline artifact (named like load-results); they are shared with the team too when a team folder is set">
                            <Button size="small" disabled={!project} onClick={() => {
                                let runId = '', busy = false;
                                const inst = modal.confirm({ title: 'Load results from an Azure DevOps pipeline run', okText: 'Import',
                                    content: <Input placeholder="Run id (the number in the run's address: buildId=…)" onChange={(e) => { runId = e.target.value.trim(); }} aria-label="Pipeline run id" />,
                                    onOk: (close) => { void (async () => {
                                        if (busy) return;
                                        if (!/^\d+$/.test(runId)) { message.error('The run id is a number (buildId=… in the run\'s address).'); return; }
                                        busy = true; inst.update({ okButtonProps: { loading: true } });
                                        try { const r = await api.loadAdoImport(Number(runId), project, env); message.success(`Imported ${r.imported.length} run${r.imported.length === 1 ? '' : 's'}${r.shared.length ? ', shared with the team' : ''}`); await refresh(); navigate(['perf-runs', r.imported[0].id]);  close(); }
                                        catch (e) { message.error(errText(e)); }
                                        finally { busy = false; inst.update({ okButtonProps: { loading: false } }); }
                                    })(); } });
                            }}>From a pipeline run…</Button>
                        </Tooltip>
                    </div>}
                    {mode === 'scenarios' && <div className="filter-row">
                        <Tooltip title={collections.length || paths.length ? undefined : 'Create an API collection first (API → Requests), or import a recorded browser path.'}>
                            <Button size="small" type="primary" icon={<PlusOutlined />} disabled={!collections.length && !paths.length} onClick={() => { setForm({ name: '', kind: collections.length ? 'api' : 'browser', coll: collections[0]?.file, bpath: paths[0]?.file }); setCreating(true); }}>New scenario</Button>
                            <Tooltip title="Record what an app, a browser or the BDD tests send, as a user path"><Button size="small" disabled={!project} onClick={() => setRecording(true)}>Record</Button></Tooltip>
                        </Tooltip>
                        <Tooltip title="Recorded browser scenarios (for example the performance app's scenarios.json) become browser paths"><Button size="small" icon={<ImportOutlined />} disabled={!project} onClick={() => { setImportText(''); setImporting(true); }}>Import recorded</Button></Tooltip>
                    </div>}
                </div>
                {err && <Alert type="error" showIcon closable onClose={() => setErr(null)} style={{ margin: 8 }} message={err} />}
                <div style={{ flex: 1, overflow: 'auto' }}>
                    {mode === 'runs' ? <>
                    {projectRuns.length === 0 ? <Typography.Text type="secondary" style={{ display: 'block', padding: '4px 12px', fontSize: 12 }}>No runs yet</Typography.Text> : projectRuns.map((r) => (
                        <div key={r.id} className={`item-row${runId === r.id ? ' selected' : ''}`} onClick={() => navigate(['perf-runs', r.id])}>
                            <div className="item-title">
                                {r.state === 'running' || r.state === 'stopping' ? <Spin size="small" /> : r.state === 'error' ? <CloseCircleFilled style={{ color: '#cf222e' }} /> : !r.passed ? <CloseCircleFilled style={{ color: '#cf222e' }} /> : r.stopReason === 'stopped' ? <StopOutlined style={{ color: '#bf8700' }} aria-label="Stopped" /> : <CheckCircleFilled style={{ color: '#389e0d' }} />}
                                <span className="t">{(meta?.scenarios ?? []).find((x) => x.file === r.scenario)?.name ?? r.name}</span><span className="item-id">{r.env}</span>
                            </div>
                            <div className="item-meta">{ago(r.startedAt)}{r.stopReason === 'stopped' ? ' · stopped' : ''}{r.summary ? ` · p95 ${ms(r.summary.p95)} · ${r.summary.errorRate.toFixed(1)}% errors · ${r.summary.throughput.toFixed(0)}/s` : r.state === 'running' ? ' · running' : ''}</div>
                        </div>))}
                    </> : <>
                    {meta === null ? <Spin style={{ margin: 16 }} /> : scenarios.length === 0 && !(open && !open.file) ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={collections.length ? 'No load scenarios yet' : <>No API collections in {project || 'this project'}.<br />Create one under API → Requests first.</>} />
                        : scenarios.map((s) => (
                            <div key={s.file} className={`item-row${(mode === 'trends' ? trendFile : mode === 'compare' ? compareFile : open?.file) === s.file ? ' selected' : ''}`} onClick={() => (mode === 'trends' || mode === 'compare' ? navigate([mode === 'trends' ? 'perf-trends' : 'perf-compare', ...s.file.split('/')]) : leave(() => { setOpen(null); navigate(['perf', ...s.file.split('/')]); }))}>
                                <div className="item-title"><DashboardOutlined /><span className="t">{s.name}</span></div>
                                <div className="item-meta">{s.users} user{s.users === 1 ? '' : 's'} · {dur(s.duration)}</div>
                            </div>))}
                    {mode === 'scenarios' && open && !open.file && <div className="item-row selected"><div className="item-title"><DashboardOutlined /><span className="t">{open.sc.name}</span><Tag bordered={false} color="warning">not saved</Tag></div></div>}
                    </>}
                </div>
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {mode === 'runs' ? (runId ? <RunView key={runId} id={runId} runs={runs} onChanged={() => void refresh()} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description={projectRuns.length ? 'Select a run' : 'No load test has run in this project yet. Start one from Scenarios.'} />)
                    : mode === 'compare' ? (compareFile ? <CompareView key={compareFile} file={compareFile} runs={runs} a={compareIds.a} b={compareIds.b} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="Select a scenario to compare two of its runs" />)
                    : mode === 'trends' ? (trendFile ? <Trends file={trendFile} runs={runs} name={scenarios.find((x) => x.file === trendFile)?.name ?? trendFile} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="Select a scenario to see how its results changed from run to run" />)
                    : open ? <>
                        <div className="toolbar">
                            <Typography.Text type="secondary" style={{ flex: 1, fontSize: 12 }} ellipsis>{open.file ?? `Not saved yet — will be test/${projectOf(open.sc)}/load/…`}{open.dirty && <span className="dirty-dot" title="Not saved" />}</Typography.Text>
                            <Button size="small" icon={<SaveOutlined />} type={open.dirty ? 'primary' : 'default'} onClick={() => void save()}>Save</Button>
                            <Tooltip title={running ? `"${running.name}" is running` : undefined}><Button size="small" type="primary" icon={<CaretRightOutlined />} disabled={!!running || !!validPolicy(open.sc.policy)} onClick={() => void run()}>Run</Button></Tooltip>
                            {open.file && <ScheduleButton file={open.file} env={env} />}
                            {open.file && <PipelineButton file={open.file} />}
                            {open.file && <Dropdown menu={{ items: [{ key: 'd', danger: true, label: 'Delete this scenario…' }], onClick: () => modal.confirm({ title: `Delete "${open.sc.name}"?`, okButtonProps: { danger: true }, onOk: async () => { try { await api.loadDeleteScenario(open.file!); setOpen(null); navigate(['perf']); await refresh(); } catch (e) { message.error(errText(e)); } } }) }}><Button size="small">⋯</Button></Dropdown>}
                        </div>
                        <ScenarioEditor project={project} env={env} sc={open.sc} onChange={(sc) => setOpen({ ...open, sc, dirty: true })} reqs={reqs} collections={collections} onCollection={() => setReqs(null)} browserPaths={paths} bpath={bpath} />
                    </>
                    : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description={<>Load-test your APIs: virtual users run the requests of an API collection<br />under a load policy, and the results are checked against your service levels.</>} />}
            </div>
        </Split>
        <RecordPathModal open={recording} project={project} collections={collections} onClose={() => setRecording(false)} onSaved={() => void refresh()} />
        <Modal open={creating} title="New load scenario" okText="Create" onCancel={() => setCreating(false)} destroyOnClose
            onOk={createScenario}>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Input placeholder="Name, e.g. Checkout under peak load" value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} onPressEnter={createScenario} aria-label="Scenario name" autoFocus />
                <Segmented block value={form.kind} onChange={(k) => setForm({ ...form, kind: k as 'api' | 'browser' })} options={[{ value: 'api', label: <Tooltip title={!collections.length ? 'Create an API collection in this project first (API → Requests → New)' : undefined}>API requests</Tooltip>, disabled: !collections.length }, { value: 'browser', label: <Tooltip title={!paths.length ? 'Import a recorded browser path first' : 'Real browsers running a recorded user path'}>Browser users</Tooltip>, disabled: !paths.length }]} />
                {form.kind === 'api'
                    ? <Select style={{ width: '100%' }} value={form.coll} onChange={(v) => setForm({ ...form, coll: v })} options={collections.map((c) => ({ value: c.file, label: `${c.name} (${c.requests} request${c.requests === 1 ? '' : 's'})` }))} aria-label="Collection" />
                    : <Select style={{ width: '100%' }} value={form.bpath} onChange={(v) => setForm({ ...form, bpath: v })} options={paths.map((b) => ({ value: b.file, label: `${b.name} (${b.actions} steps)` }))} aria-label="Browser path" />}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{form.kind === 'api' ? 'The virtual users send this collection\'s requests (light: many users per computer).' : 'Each virtual user is a real browser replaying the recorded steps (heavy: tens to a few hundred per computer).'}</Typography.Text>
            </Space>
        </Modal>
        <Modal open={importing} title="Import recorded browser scenarios" okText="Import" okButtonProps={{ disabled: !importText.trim() }} onCancel={() => setImporting(false)}
            onOk={async () => { try { const r = await api.loadImportBrowserPaths(project, importText); message.success(`Imported ${r.files.length}: ${r.files.map((f) => f.split('/').pop()).join(', ')}`); setImporting(false); await refresh(); } catch (e) { message.error(errText(e)); } }}>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">The performance app keeps its recorded scenarios in <Typography.Text code>data/scenarios.json</Typography.Text>: choose that file (all its scenarios are imported) or a single exported scenario. They are saved in <Typography.Text code>test/{project}/load/</Typography.Text>.</Typography.Text>
                <Upload accept=".json" showUploadList={false} beforeUpload={(f) => { void f.text().then(setImportText); return false; }}><Button icon={<ImportOutlined />}>Choose a file</Button></Upload>
                <Input.TextArea className="mono" autoSize={{ minRows: 5, maxRows: 12 }} placeholder="…or paste the JSON" value={importText} onChange={(e) => setImportText(e.target.value)} aria-label="Recorded scenarios JSON" />
            </Space>
        </Modal>
    </>);
}


/** The custom curve's points: each wrong line is said as it is typed; the curve takes the points when they are all right. */
/** Set while the custom curve on screen has mistakes: Save is refused (it would keep the last good curve). */
let curveInvalid = false;
function CurveInput({ initial, onPoints }: { initial: string; onPoints: (pts: Array<{ t: number; users: number }>) => void }) {
    const [text, setText] = React.useState(initial);
    const problems = curveProblems(text);
    curveInvalid = problems.length > 0;
    React.useEffect(() => () => { curveInvalid = false; }, []);
    return <>
        <Input.TextArea className="mono" autoSize={{ minRows: 3, maxRows: 10 }} aria-label="Custom curve points" value={text} status={problems.length ? 'error' : undefined}
            onChange={(e) => { setText(e.target.value); if (!curveProblems(e.target.value).length) onPoints(curveFromCsv(e.target.value)); }} />
        {problems.slice(0, 5).map((x) => <Typography.Text key={x} type="danger" style={{ fontSize: 12, display: 'block' }}>{x}</Typography.Text>)}{problems.length > 5 && <Typography.Text type="danger" style={{ fontSize: 12, display: 'block' }}>… and {problems.length - 5} more</Typography.Text>}
    </>;
}
