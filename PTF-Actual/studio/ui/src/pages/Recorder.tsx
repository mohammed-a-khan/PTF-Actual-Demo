/**
 * Tests → Recorder: record a browser session with Playwright's recorder (a browser window opens on
 * this computer) and turn it into a framework test: a feature, page objects and steps in the project.
 * The recording shows live; pages can be split and renamed before saving; password-like values become
 * Studio secrets. A Playwright script can also be pasted and converted.
 */
import React from 'react';
import { Alert, App, AutoComplete, Button, Checkbox, Col, Collapse, Empty, Form, Input, Modal, Popover, Row, Select, Space, Table, Tabs, Tag, Tooltip, Typography, Popconfirm } from 'antd';
import { BlockOutlined, CaretRightOutlined, DeleteOutlined, FileTextOutlined, PlusOutlined, ScissorOutlined, StopOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { api, baseHashesOf, RecDataChoice, RecDataFileInfo, RecLocator, RecordingInfo, RecPreview, RecRow, RecValueMode } from '../api';
import { findingsSummary, PlanReview } from '../components/PlanReview';
import { LiveRecorder } from '../components/LiveRecorder';
import { errText, openInEditor, showRun } from '../state';
import { useRoute } from '../route';
import { useAgentContext } from '../agentContext';
import { RECORDER_IMPORT_KEY } from '../components/AgentBrowser';
import { Split } from '../components/Split';
import { ago } from '../format';
import { useUnsaved } from '../unsaved';
import '../styles-tests.css';

const loadPref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const savePref = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const KIND_LABEL: Record<string, string> = {
    goto: 'Open', click: 'Click', dblclick: 'Double-click', fill: 'Enter', press: 'Press', check: 'Check', uncheck: 'Uncheck', select: 'Select', hover: 'Point at', upload: 'Upload',
    expectVisible: 'Check visible', expectHidden: 'Check hidden', expectText: 'Check text', expectContains: 'Check contains', expectValue: 'Check value', expectChecked: 'Check checked', expectUrl: 'Check address', expectTitle: 'Check title',
};

/** A recording name from its address (the last part of the path, or the host). */
const nameFromUrl = (url: string) => { try { const u = new URL(url); const p = u.pathname.split('/').filter(Boolean).pop(); const host = /^[\d.]+$|^\[|^localhost$/i.test(u.hostname) ? '' : u.hostname.replace(/^www\./, '').split('.')[0]; return (p ? p.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ') : host || 'Recording').replace(/^\w/, (c) => c.toUpperCase()); } catch { return 'Recording'; } };

const TIER_COLOR: Record<string, string> = { stable: 'green', acceptable: 'blue', fragile: 'orange', 'anti-pattern': 'red' };
const KEY_WORD: Record<RecLocator['key'], string> = { testId: 'test id', id: 'id', name: 'name', role: 'role', text: 'text', placeholder: 'placeholder' };
const PRIMARY: RecLocator['key'][] = ['testId', 'id', 'name', 'role', 'text'];

/**
 * The locator written for a recorded element, and the others that find it (each confirmed while recording, graded by
 * the framework's locator linter). The one chosen is the element's locator; the others the linter accepts become its
 * alternative locators (self-healing).
 */
function LocatorPick({ row, onPick }: { row: RecRow; onPick: (l: { key: RecLocator['key']; value: string }) => void }) {
    const list = row.locators ?? [];
    const cur = list.find((l) => l.key === row.locator?.key && l.value === row.locator?.value) ?? list[0];
    if (!cur) return null;
    const content = (
        <div className="rec-locs" role="listbox" aria-label="Locators">
            {list.map((l) => {
                const can = PRIMARY.includes(l.key);
                const on = l === cur;
                return (
                    <div key={`${l.key}:${l.value}`} className="rec-loc" role="option" aria-selected={on} aria-disabled={!can} style={{ opacity: can ? 1 : 0.6, cursor: can ? 'pointer' : 'default', fontWeight: on ? 600 : undefined }}
                        onClick={() => { if (can && !on) onPick({ key: l.key, value: l.value }); }}>
                        <span className="score">{l.score}</span>
                        {l.tier && <Tag bordered={false} color={TIER_COLOR[l.tier] ?? 'default'} style={{ margin: 0 }}>{l.tier}</Tag>}
                        <span style={{ width: 70, flexShrink: 0, fontSize: 12 }}>{KEY_WORD[l.key]}</span>
                        <Typography.Text className="mono" style={{ fontSize: 12, flex: 1 }} ellipsis={{ tooltip: l.value }}>{l.value}</Typography.Text>
                        {!can ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>alternative only</Typography.Text> : on ? <Typography.Text type="success" style={{ fontSize: 11 }}>used</Typography.Text> : null}
                        {!!l.reasons?.length && <Tooltip title={<ul style={{ margin: 0, paddingLeft: 16 }}>{l.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}><Typography.Text type="secondary" style={{ fontSize: 11, cursor: 'help' }}>why</Typography.Text></Tooltip>}
                    </div>);
            })}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>Each one finds exactly this element (checked while recording). The others the framework's linter accepts are written as alternatives.</Typography.Text>
        </div>);
    return (
        <Popover trigger="click" title="Locator" content={content}>
            <Tag bordered={false} color={TIER_COLOR[cur.tier ?? ''] ?? 'default'} style={{ marginLeft: 4, cursor: 'pointer' }} aria-label={`Locator: ${KEY_WORD[cur.key]} ${cur.value}, score ${cur.score}`}>{KEY_WORD[cur.key]} · {cur.score}{list.length > 1 ? ` · ${list.length}` : ''}</Tag>
        </Popover>);
}

export function Recorder() {
    const { message, modal } = App.useApp();
    const [meta, setMeta] = React.useState<{ projects: string[]; environments: Record<string, string[]> } | null>(null);
    const [project, setProjectRaw] = React.useState<string>(() => loadPref('cs-studio-rec-project', ''));
    const [env, setEnv] = React.useState<string | undefined>(() => loadPref<string | undefined>('cs-studio-rec-env', undefined));
    const [start, setStart] = React.useState({ url: '', browser: 'chromium', testIdAttribute: '', device: '', ignoreHttpsErrors: false });
    const [list, setList] = React.useState<RecordingInfo[]>([]);
    const [cur, setCur] = React.useState<RecordingInfo | null>(null);
    const [name, setName] = React.useState('');
    const [secretMode, setSecretMode] = React.useState<'encrypted' | 'studio'>(() => loadPref('cs-studio-rec-secrets', 'encrypted'));
    const [breaks, setBreaks] = React.useState<Record<number, string>>({});
    const [labels, setLabels] = React.useState<Record<string, string>>({});
    // The locator chosen for an element (element key → one of the locators confirmed while recording).
    const [locators, setLocators] = React.useState<Record<string, { key: RecLocator['key']; value: string }>>({});
    const [values, setValues] = React.useState<Record<number, { mode?: RecValueMode; column?: string; when?: string; format?: string }>>({});
    // Test data: a new file (JSON, CSV, Excel) or one of the project's data files.
    const [data, setData] = React.useState<RecDataChoice>(() => ({ format: loadPref('cs-studio-rec-data-format', 'json') as RecDataChoice['format'] }));
    const [dataFiles, setDataFiles] = React.useState<Array<{ path: string; format: string }>>([]);
    const [dataInfo, setDataInfo] = React.useState<RecDataFileInfo | null>(null);
    // The sign-in: the steps up to a check that shows the user is signed in.
    const [signIn, setSignIn] = React.useState<number | null>(null);
    // Steps done only when their element is shown (a dialog that appears now and then).
    const [optional, setOptional] = React.useState<number[]>([]);
    const [signInChecks, setSignInChecks] = React.useState<Array<{ index: number; line: string }>>([]);
    // Reusable steps (ranges of steps as one step), the rows chosen for the next one, the one being named.
    const [blocks, setBlocks] = React.useState<Array<{ from: number; to: number; name: string; text?: string }>>([]);
    const [picked, setPicked] = React.useState<number[]>([]);
    const [naming, setNaming] = React.useState<{ from: number; to: number; name: string; text: string } | null>(null);
    const [engine, setEngine] = React.useState<'studio' | 'window' | 'playwright'>(() => loadPref('cs-studio-rec-engine', 'studio') as 'studio' | 'window' | 'playwright');
    const [newProject, setNewProject] = React.useState<string | null>(null);
    const agentRoute = useRoute();
    const [preview, setPreview] = React.useState<RecPreview | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [pasting, setPasting] = React.useState<string | null>(null);
    const [splitAt, setSplitAt] = React.useState<{ index: number; name: string } | null>(null);
    // The review of a recording, one concern per tab (remembered on this computer).
    const [reviewTab, setReviewTabRaw] = React.useState<string>(() => loadPref('cs-studio-rec-review-tab', 'steps'));
    const setReviewTab = (k: string) => { setReviewTabRaw(k); savePref('cs-studio-rec-review-tab', k); };

    useAgentContext('recorder', { project, environment: env, recording: cur?.url, testName: name, actions: preview?.rows.length }, agentRoute[0] === 'recorder');
    // A manual run handed over from the Studio browser (Copilot panel): open it as a script.
    React.useEffect(() => {
        if (agentRoute[0] !== 'recorder') return;
        let s: string | null = null;
        try { s = localStorage.getItem(RECORDER_IMPORT_KEY); localStorage.removeItem(RECORDER_IMPORT_KEY); } catch { /* private mode */ }
        if (s) { const url = /page\.goto\(\s*['"`]([^'"`]+)/.exec(s)?.[1] ?? 'Studio browser'; setCur({ id: 'pasted', url, state: 'finished', startedAt: new Date().toISOString(), testIdAttribute: 'data-testid', script: s }); setName(nameFromUrl(url)); setBreaks({}); setLabels({}); setLocators({}); setValues({}); }
    }, [agentRoute[0]]); // eslint-disable-line react-hooks/exhaustive-deps
    const setProject = (p: string) => { setProjectRaw(p); savePref('cs-studio-rec-project', p); setEnv(undefined); setData((d) => ({ format: d.format })); };
    const envs = meta?.environments[project] ?? [];
    const projects = meta ? (meta.projects.includes(project) || !project ? meta.projects : [...meta.projects, project]) : [];
    const refresh = React.useCallback(() => api.recList().then((r) => setList(r.recordings)).catch(() => {}), []);
    React.useEffect(() => { api.dbConnections().then((r) => { setMeta({ projects: r.projects, environments: r.environments }); if (!project && r.projects[0]) setProject(r.projects[0]); }).catch((e) => setErr(errText(e))); void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // The review's changes live in this screen until a test is made: a reload or leaving asks first.
    const reviewEdited = !!cur && cur.state === 'finished' && (name.trim() !== (cur.name || nameFromUrl(cur.url)).trim() || Object.keys(labels).length > 0 || Object.keys(values).length > 0 || Object.keys(locators).length > 0);
    const reviewSig = JSON.stringify({ n: name.trim(), labels, values, locators });
    const [savedSig, setSavedSig] = React.useState<string | null>(null);
    useUnsaved('recorder-review', reviewEdited && reviewSig !== savedSig, `the review of the recording "${name || 'recording'}"`, { lostOnLeave: true });
    const open = (r: RecordingInfo) => { setSavedSig(null); setCur(r); setName(r.name || nameFromUrl(r.url)); setBreaks({}); setLabels({}); setLocators({}); setValues({}); setSignIn(null); setSignInChecks([]); setOptional([]); setBlocks([]); setPicked([]); setPreview(null); setErr(null); };

    // Follow a recording: its script grows with every action in the recorded browser.
    React.useEffect(() => {
        if (!cur || cur.id === 'pasted' || cur.state !== 'recording') return;
        const t = setInterval(() => {
            api.recGet(cur.id).then((r) => { setCur((c) => (c && c.id === r.id ? { ...r, warnings: c.warnings } : c)); if (r.state !== 'recording') void refresh(); }).catch(() => {});
        }, 1200);
        return () => clearInterval(t);
    }, [cur?.id, cur?.state]); // eslint-disable-line react-hooks/exhaustive-deps

    // The rows ticked for a reusable step: one range of steps in a row.
    const pickedRange = picked.length && picked[picked.length - 1] - picked[0] === picked.length - 1 ? { from: picked[0], to: picked[picked.length - 1] } : null;
    const request = React.useMemo(() => (cur?.script && project ? { project, env, name: name || 'Recording', script: cur.script, breaks, labels, ...(Object.keys(locators).length ? { locators } : {}), values, secretMode, testIdAttribute: cur.testIdAttribute, data, ...(signIn !== null ? { signIn: { marker: signIn } } : {}), ...(optional.length ? { optional } : {}), ...(blocks.length ? { blocks } : {}), ...(cur.engine === 'studio' ? { recording: cur.id } : {}) } : null), [cur?.script, cur?.testIdAttribute, cur?.engine, cur?.id, project, env, name, breaks, labels, locators, values, secretMode, data, signIn, optional, blocks]);
    React.useEffect(() => {
        if (preview && signIn === null) setSignInChecks(preview.rows.filter((r) => ['expectVisible', 'expectText', 'expectContains'].includes(r.kind) && r.index > 0).map((r) => ({ index: r.index, line: r.line.replace(/^(Then|And|When|Given) /, '') })));
    }, [preview, signIn]);
    React.useEffect(() => { if (project) api.recDataFiles(project).then((r) => setDataFiles(r.files)).catch(() => setDataFiles([])); }, [project, cur?.id]);
    React.useEffect(() => {
        setDataInfo(null);
        if (data.file) api.recDataFile(data.file, data.sheet, data.path).then(setDataInfo).catch((e) => setErr(errText(e)));
    }, [data.file, data.sheet, data.path]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => {
        if (!request) { setPreview(null); return; }
        const t = setTimeout(() => { api.recPreview(request).then((p) => { setPreview(p); setErr(null); }).catch((e) => { setErr(errText(e)); setPreview(null); }); }, 300);
        return () => clearTimeout(t);
    }, [request]);

    const record = async () => {
        setBusy(true); setErr(null);
        try {
            const r = await api.recStart({ project, env, url: start.url.trim() || undefined, browser: start.browser, testIdAttribute: start.testIdAttribute.trim() || undefined, device: start.device.trim() || undefined, ignoreHttpsErrors: start.ignoreHttpsErrors, engine: engine === 'playwright' ? 'playwright' : 'studio', ...(engine === 'window' ? { window: true } : {}) });
            open({ ...r, script: '' });
            for (const w of r.warnings ?? []) message.warning(w);
            void refresh();
        } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };

    const save = async (run: boolean, confirmed = false, force = false) => {
        if (!request || !preview) return;
        if (preview.review?.blocked && !force) {
            modal.confirm({ title: 'Save although the framework check found problems?', width: 560, content: findingsSummary(preview.review), okText: 'Save anyway', okButtonProps: { danger: true }, onOk: () => save(run, confirmed, true) });
            return;
        }
        const updates = preview.files.filter((f) => f.change === 'update');
        if (updates.length && !confirmed) {
            modal.confirm({ title: 'Update existing files?', width: 560, okText: 'Save',
                content: <div>These files of the project are updated (see each file's tab):<ul>{updates.map((f) => <li key={f.path}><Typography.Text code>{f.path}</Typography.Text> {f.kind === 'feature' ? 'replaced by this recording' : f.kind === 'data' ? 'rows kept, new columns added' : f.kind === 'config' ? 'keys added' : f.kind === 'other' ? 'shared helpers added' : 'new members added at the end of the class'}</li>)}</ul></div>,
                onOk: () => save(run, true, force) });
            return;
        }
        setBusy(true);
        try {
            const r = await api.recSave({ ...request, baseHashes: baseHashesOf(preview.review), force });
            // Opened again later, the recording keeps the name it was saved under (saving again updates, not duplicates).
            if (cur!.id !== 'pasted') void api.recUpdate(cur!.id, { name: request.name }).catch(() => undefined);
            setSavedSig(reviewSig);
            message.success(`Saved: ${r.files.filter((f) => f.change === 'new').length} new and ${r.files.filter((f) => f.change === 'update').length} updated files${r.secretsSaved.length ? `, ${r.secretsSaved.length} Studio secret${r.secretsSaved.length === 1 ? '' : 's'}` : ''}.`);
            if (run && r.feature) { const x = await api.startRun({ project: r.project, env: r.env, features: [r.feature], workers: 1 }); showRun(x.id); }
            else if (r.feature) openInEditor(r.feature);
            api.dbConnections().then((m) => setMeta({ projects: m.projects, environments: m.environments })).catch(() => {});
            setPreview(await api.recPreview(request));
        } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };

    // Record from a step of a recording made in the Studio (its steps up to there done again first).
    const canContinue = !!cur && cur.engine === 'studio' && cur.id !== 'pasted' && cur.state !== 'recording' && !!preview?.rows.length;
    /** A mis-recorded step out: its line leaves the script; the choices made for later steps move up with them. */
    const deleteStep = (r: RecRow) => {
        if (!cur?.script || !r.scriptLine || cur.state === 'recording') return;
        const lines = cur.script.split('\n');
        lines.splice(r.scriptLine - 1, 1);
        const at = r.index;
        const shift = <T,>(o: Record<number, T>) => Object.fromEntries(Object.entries(o).filter(([k]) => Number(k) !== at).map(([k, v]) => [Number(k) > at ? Number(k) - 1 : Number(k), v])) as Record<number, T>;
        setBreaks(shift(breaks)); setValues(shift(values));
        setOptional(optional.filter((x) => x !== at).map((x) => (x > at ? x - 1 : x)));
        setBlocks(blocks.filter((b) => at < b.from || at > b.to).map((b) => (b.from > at ? { ...b, from: b.from - 1, to: b.to - 1 } : b)));
        if (signIn !== null) setSignIn(signIn === at ? null : signIn > at ? signIn - 1 : signIn);
        setPicked([]);
        const script = lines.join('\n');
        setCur({ ...cur, script });
        // Kept with the recording: opened again (here or in another browser), the step stays deleted.
        if (cur.id !== 'pasted') void api.recUpdate(cur.id, { script }).catch((e) => message.error(errText(e)));
        message.success(`Step ${at + 1} deleted`);
    };
    const recordFrom = async (at: number) => {
        if (!cur || !project) return;
        setBusy(true); setErr(null);
        try { const r = await api.recContinue(cur.id, { project, env, at, ignoreHttpsErrors: start.ignoreHttpsErrors }); setCur({ ...r, script: '' }); void refresh(); }
        catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };

    const remove = (r: RecordingInfo) => modal.confirm({ title: 'Delete this recording?', content: 'The recorded script is removed (tests saved from it stay).', okText: 'Delete', okButtonProps: { danger: true },
        onOk: (close) => { void (async () => { try { await api.recDelete(r.id); if (cur?.id === r.id) setCur(null); close(); await refresh(); } catch (e) { message.error(errText(e)); } })(); } });

    const pageStarts = React.useMemo(() => {
        const out: Record<number, string> = {};
        preview?.rows.forEach((a, i) => { if (i === 0 || a.page !== preview.rows[i - 1].page) out[i] = a.page; });
        return out;
    }, [preview]);

    // Recording in the Studio: the application takes the whole page (the list comes back when it stops).
    if (cur?.state === 'recording' && cur.engine === 'studio') {
        return <div className="panel" style={{ height: 'calc(100vh - var(--chrome))', overflow: 'auto', padding: 14 }}>
            <LiveRecorder id={cur.id} project={project} env={env} inWindow={!!cur.window} onStopped={() => { void api.recGet(cur.id).then((r) => open(r)).catch(() => {}); void refresh(); }} />
        </div>;
    }
    return (<>
        <Split id="recorder" initial={360} min={300} max={560} style={{ height: 'calc(100vh - var(--chrome))' }}>
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
                <div style={{ padding: 14 }}>
                    <Form layout="vertical" size="small" className="tests-rec-form">
                        <Row gutter={10}>
                            <Col span={15}><Form.Item label="Project" htmlFor="cs-rec-project">
                                <Select id="cs-rec-project" value={project || undefined} placeholder="Project" onChange={(v) => (v === '\u0000new' ? setNewProject('') : setProject(v))} aria-label="Project"
                                    options={[...projects.map((p) => ({ value: p, label: p })), { value: '\u0000new', label: <span><PlusOutlined /> New project…</span> }]} /></Form.Item></Col>
                            <Col span={9}><Form.Item label="Environment" htmlFor="cs-rec-env">
                                <Select id="cs-rec-env" value={env} placeholder={envs[0] ?? 'env'} allowClear disabled={!envs.length} onChange={(v) => { setEnv(v); savePref('cs-studio-rec-env', v); }} options={envs.map((e) => ({ value: e, label: e }))} aria-label="Environment" /></Form.Item></Col>
                        </Row>
                        <Form.Item label="Start address" htmlFor="cs-rec-url" tooltip="Empty: the BASE_URL of the environment">
                            <Input id="cs-rec-url" className="mono" placeholder="BASE_URL of the environment" value={start.url} onChange={(e) => setStart({ ...start, url: e.target.value })} aria-label="Start address" onPressEnter={() => { if (project && !busy) void record(); }} />
                        </Form.Item>
                        <Row gutter={10}>
                            <Col span={15}><Form.Item label="Browser" htmlFor="cs-rec-browser">
                                <Select id="cs-rec-browser" value={start.browser} onChange={(b) => setStart({ ...start, browser: b })} aria-label="Browser"
                                    options={[{ value: 'chromium', label: 'Chromium' }, { value: 'chrome', label: 'Google Chrome' }, { value: 'msedge', label: 'Microsoft Edge' }, { value: 'firefox', label: 'Firefox' }, { value: 'webkit', label: 'WebKit' }]} /></Form.Item></Col>
                            <Col span={9}><Form.Item label=" " colon={false}>
                                <Tooltip title={engine === 'studio'
                                    ? 'The application opens here, in the Studio: use it as usual (sign-in pages too), add checks from the toolbar, and press Stop when done.'
                                    : engine === 'window' ? 'A browser window opens on this computer (single sign-on, client certificates); the steps and toolbar stay here. Press Stop when done.'
                                    : 'A browser window opens with Playwright\'s recorder: use its toolbar to add checks. Close the window or press Stop when done.'}>
                                    <Button type="primary" block icon={<VideoCameraOutlined />} loading={busy} disabled={!project || cur?.state === 'recording'} onClick={() => void record()}>Record</Button>
                                </Tooltip></Form.Item></Col>
                        </Row>
                        <Collapse ghost size="small" className="run-options" items={[{ key: 'o', label: <span>Advanced{engine !== 'studio' && <Typography.Text type="secondary" style={{ fontSize: 12 }}> · {engine === 'window' ? 'in a browser window' : "in Playwright's recorder"}</Typography.Text>}</span>, children: (
                            <>
                                <Form.Item label="Record in" htmlFor="cs-rec-engine">
                                    <Select id="cs-rec-engine" value={engine} onChange={(v) => { setEngine(v); savePref('cs-studio-rec-engine', v); }} aria-label="Record in" popupMatchSelectWidth={false}
                                        options={[{ value: 'studio', label: 'The Studio (the application shown here)' }, { value: 'window', label: 'A browser window on this computer (single sign-on, certificates…)' }, { value: 'playwright', label: 'Playwright\'s recorder window' }]} />
                                </Form.Item>
                                <Row gutter={10}>
                                    <Col span={12}><Form.Item label="Test id attribute" htmlFor="cs-rec-testid"><Input id="cs-rec-testid" placeholder="data-testid" value={start.testIdAttribute} onChange={(e) => setStart({ ...start, testIdAttribute: e.target.value })} aria-label="Test id attribute" /></Form.Item></Col>
                                    <Col span={12}><Form.Item label="Device" htmlFor="cs-rec-device" tooltip="A Playwright device name, e.g. iPhone 13, Pixel 7 (desktop when empty)"><Input id="cs-rec-device" placeholder="Desktop" value={start.device} onChange={(e) => setStart({ ...start, device: e.target.value })} aria-label="Device" /></Form.Item></Col>
                                </Row>
                                <Checkbox checked={start.ignoreHttpsErrors} onChange={(e) => setStart({ ...start, ignoreHttpsErrors: e.target.checked })}>Ignore certificate errors</Checkbox>
                            </>) }]} />
                        <Space size={6} wrap style={{ marginTop: 6 }}>
                            <Tooltip title="Convert a Playwright script (test file) you already have"><Button size="small" icon={<FileTextOutlined />} disabled={!project} onClick={() => setPasting('')}>Convert a script</Button></Tooltip>
                            {engine !== 'studio' && <Tooltip title="Chosen under Advanced → Record in (remembered on this computer)">
                                <Tag closable onClose={(e) => { e.preventDefault(); setEngine('studio'); savePref('cs-studio-rec-engine', 'studio'); }}>
                                    {engine === 'window' ? 'in a browser window' : "in Playwright's recorder"}
                                </Tag>
                            </Tooltip>}
                        </Space>
                    </Form>
                </div>
                <div className="side-section">Recordings</div>
                {!list.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="None yet" /> : list.map((r) => (
                    <div key={r.id} className={`item-row${cur?.id === r.id ? ' active' : ''}`} onClick={() => void api.recGet(r.id).then(open).catch((e) => setErr(errText(e)))} style={{ cursor: 'pointer' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className={r.name ? undefined : 'mono'} title={r.url}>{r.name || r.url}</span>
                            {r.state === 'recording' ? <Tag color="red" bordered={false}>Recording</Tag> : r.state === 'failed' ? <Tag color="error" bordered={false}>Failed</Tag> : null}
                            <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Delete recording" onClick={(e) => { e.stopPropagation(); remove(r); }} />
                        </div>
                        <div className="item-id">{ago(r.startedAt)}{r.savedAs ? ` · saved as ${r.savedAs.split('/').pop()}` : ' · not saved'}{r.name ? ` · ${r.url}` : ''}</div>
                    </div>))}
            </div>
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
                {err && <Alert type="error" showIcon closable onClose={() => setErr(null)} style={{ margin: 12 }} message={<pre className="db-error" style={{ margin: 0 }}>{err}</pre>} />}
                {!cur ? <Empty style={{ marginTop: 80 }} description="Record a session, or open a recording" /> : <div style={{ padding: 14 }}>
                    <Space direction="vertical" style={{ width: '100%' }} size={10}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            {cur.state === 'recording' ? <Tag color="red">● Recording</Tag> : cur.state === 'failed' ? <Tag color="error">Failed</Tag> : <Tag>{cur.id === 'pasted' ? 'Converted script' : 'Recorded'}</Tag>}
                            <Typography.Text className="mono" ellipsis={{ tooltip: cur.url }} style={{ flex: '1 1 120px', minWidth: 80 }}>{cur.url}</Typography.Text>
                            {cur.state === 'recording' && <Button size="small" danger icon={<StopOutlined />} onClick={() => void api.recStop(cur.id).then(refresh)}>Stop</Button>}
                            <Input size="small" style={{ width: 240 }} addonBefore="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Recording name" status={name.trim() ? undefined : 'error'} placeholder="Name the recording" />
                            {canContinue && <Tooltip title="Record more at the end: the steps are done again in the Studio's browser, then you go on">
                                <Button size="small" icon={<VideoCameraOutlined />} loading={busy} onClick={() => void recordFrom(preview!.rows.length - 1)}>Record more</Button></Tooltip>}
                            <Button size="small" loading={busy} disabled={!preview?.rows.length || cur.state === 'recording' || !name.trim()} title={!name.trim() ? 'Name the recording first' : undefined} onClick={() => void save(false)}>Save</Button>
                            <Button size="small" type="primary" icon={<CaretRightOutlined />} loading={busy} disabled={!preview?.rows.length || cur.state === 'recording' || !name.trim()} onClick={() => void save(true)}>Save and run</Button>
                            </div>
                        {cur.state === 'failed' && cur.error && <Alert type="error" showIcon message={<pre className="db-error" style={{ margin: 0 }}>{cur.error}</pre>} />}
                        {cur.saveProblem && <Alert type="warning" showIcon message={cur.saveProblem} description="The recording goes on, but its details may be missing after the Studio restarts." />}
                        <Tabs size="small" className="tests-tabs" activeKey={reviewTab} onChange={setReviewTab} items={[
                            { key: 'steps', label: <>Steps <span className="q-count">{preview?.rows.length ?? 0}</span></>, children: (<Space direction="vertical" style={{ width: '100%' }} size={8}>
                            <Space size={6} wrap><Tooltip title="Steps used together in many tests (sign up, add to cart, pay): tick their rows, then make them one step other recordings and tests can use, with their values as parameters">
                                <Button size="small" icon={<BlockOutlined />} disabled={!pickedRange} onClick={() => pickedRange && setNaming({ ...pickedRange, name: '', text: '' })}>Reusable step{picked.length ? ` (${picked.length})` : ''}</Button>
                            </Tooltip>{blocks.map((b, k) => <Tag key={k} color="geekblue" closable onClose={() => setBlocks(blocks.filter((_x, j) => j !== k))}>{b.name}: steps {b.from + 1}–{b.to + 1}</Tag>)}</Space>
                        {preview && preview.rows.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            Steps: {preview.summary.stepsReused} existing, {preview.summary.stepsNew} new · Elements: {preview.summary.elementsReused} existing, {preview.summary.elementsNew} new · Pages: {preview.pages.map((p) => `${p.className}${p.existing ? ' (existing)' : ''}`).join(', ')}
                        </Typography.Text>}
                        {!!preview?.warnings.length && <Alert type="warning" showIcon message={<ul style={{ margin: 0, paddingLeft: 18 }}>{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>} />}
                        {!cur.script?.trim() && cur.state === 'recording' && <Alert type="info" showIcon message="Waiting for the first action in the recorded browser…" />}
                        {preview && <Table size="small" pagination={false} rowKey={(r) => String(r.index)} dataSource={preview.rows} scroll={{ x: 980, y: 'calc(100vh - var(--chrome) - 330px)' }} tableLayout="fixed"
                            rowSelection={{ columnWidth: 32, selectedRowKeys: picked.map(String), onChange: (keys) => setPicked(keys.map(Number).sort((a, b) => a - b)), getCheckboxProps: (r) => ({ disabled: !!r.block || !!r.signIn, 'aria-label': `Step ${r.index + 1}` }) }}
                            columns={[
                                { title: '#', width: 86, render: (_v, r) => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><span className="item-id">{r.index + 1}</span>
                                    {canContinue && r.index < (preview?.rows.length ?? 0) - 1 && <Tooltip title={`Record from here: steps 1–${r.index + 1} are done again in the Studio's browser, then new steps go after step ${r.index + 1} (the steps after it stay)`}>
                                        <Button size="small" type="text" className="rec-from" icon={<VideoCameraOutlined />} aria-label={`Record from step ${r.index + 1}`} disabled={busy} onClick={() => void recordFrom(r.index)} /></Tooltip>}
                                    {r.scriptLine && cur.state !== 'recording' && <Popconfirm title={`Delete step ${r.index + 1}?`} description={r.line} okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => deleteStep(r)}>
                                        <Button size="small" type="text" danger className="rec-from" icon={<DeleteOutlined />} aria-label={`Delete step ${r.index + 1}`} /></Popconfirm>}</span> },
                                { title: 'Page', width: 110, render: (_v, r, i) => pageStarts[i] !== undefined
                                    ? <Popover trigger="click" title="Page (one of the project's, or a new name)" content={<AutoComplete size="small" style={{ width: 240 }} autoFocus defaultValue={r.page} aria-label="Page name"
                                        options={(preview.existingPages ?? []).map((c) => ({ value: c.replace(/Page$/, '') }))} filterOption={(q, o) => String(o?.value ?? '').toLowerCase().includes(q.toLowerCase())}
                                        onSelect={(v: string) => setBreaks({ ...breaks, [i]: v })} onKeyDown={(e) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) setBreaks({ ...breaks, [i]: v }); } }} />}>
                                        <Tag color={r.pageExisting ? 'blue' : 'purple'} style={{ cursor: 'pointer' }}>{r.page}{r.pageExisting ? ' ·' : ''}</Tag></Popover>
                                    : <Tooltip title="Start a new page here"><Button size="small" type="text" icon={<ScissorOutlined />} aria-label="New page here" onClick={() => setSplitAt({ index: i, name: '' })} /></Tooltip> },
                                { title: 'Element', width: 140, render: (_v, r) => r.elementKey
                                    ? <><Tooltip title={<span className="mono">{r.selector}{r.frames.length ? ` (in ${r.frames.join(' › ')})` : ''}</span>}>
                                        <Typography.Text editable={r.elementReused ? false : { tooltip: 'Rename', onChange: (v) => { if (v.trim()) setLabels({ ...labels, [r.elementKey!]: v.trim() }); } }}>{r.element}</Typography.Text>
                                        {r.elementReused && <Tag bordered={false} color="blue" style={{ marginLeft: 4 }}>existing</Tag>}</Tooltip>
                                        {!!r.locators?.length && <LocatorPick row={r} onPick={(l) => setLocators({ ...locators, [r.elementKey!]: l })} />}</>
                                    : <Typography.Text type="secondary">{KIND_LABEL[r.kind] ?? r.kind}</Typography.Text> },
                                { title: 'Step', render: (_v, r) => <span><span className="mono" style={{ fontSize: 12 }}>{r.line}</span> {r.signIn ? <Tag bordered={false} color="purple">steps 1–{r.index + 1}</Tag> : null}{r.block ? <Tooltip title={`Part of the reusable step "${r.block}"`}><Tag bordered={false} color="geekblue">reusable</Tag></Tooltip> : null}{r.stepReused ? <Tag bordered={false} color="blue">existing step</Tag> : null}</span> },
                                { title: 'Value', width: 250, fixed: 'right' as const, render: (_v, r) => ['click', 'dblclick', 'check', 'uncheck'].includes(r.kind)
                                    ? <Tooltip title="For a dialog or banner that appears now and then: the test waits up to 5 s for it, and goes on without it">
                                        <Checkbox checked={optional.includes(r.index)} onChange={(e) => setOptional(e.target.checked ? [...optional, r.index] : optional.filter((x) => x !== r.index))}>Only if shown</Checkbox></Tooltip>
                                    : r.kind === 'remember' ? <Tag bordered={false} color="geekblue" className="mono">remembered as {r.value}</Tag>
                                    : r.remembered ? <Tooltip title="The value remembered earlier in the scenario (read from the page in each run)"><Tag bordered={false} color="geekblue" className="mono">remembered {r.remembered}</Tag></Tooltip>
                                    : r.testData ? <Tooltip title="Read in every run (test data sources: a database query or an API request)"><Tag bordered={false} color="cyan" className="mono">{r.testData}</Tag></Tooltip> : r.mode === undefined ? <span className="mono">{r.value}</span> : <Space size={4} wrap>
                                    <span className="mono" style={{ maxWidth: 110, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }} title={r.sensitive ? undefined : r.value}>{r.value}</span>
                                    <Select size="small" style={{ width: 90 }} value={r.mode} aria-label="Value as" onChange={(m) => setValues({ ...values, [r.index]: { ...values[r.index], mode: m } })}
                                        options={[{ value: 'data', label: 'Data' }, { value: 'fixed', label: 'Fixed' }, { value: 'secret', label: 'Secret' }, ...(r.kind === 'fill' ? [{ value: 'unique', label: 'Unique' }] : []), ...(r.dateLike || r.mode === 'date' ? [{ value: 'date', label: 'Date' }] : [])]} />
                                    {r.date && <>
                                        <Tooltip title='When, from the day of the run: "today", "today + 7 days", "today - 1 month", "today + 2 weeks"'>
                                            <Typography.Text code editable={{ tooltip: 'When', onChange: (v) => { if (v.trim()) setValues({ ...values, [r.index]: { ...values[r.index], mode: 'date', when: v.trim() } }); } }}>{r.date.when}</Typography.Text>
                                        </Tooltip>
                                        <Select size="small" style={{ width: 110 }} aria-label="Date format" value={r.date.format} onChange={(format) => setValues({ ...values, [r.index]: { ...values[r.index], mode: 'date', format } })}
                                            options={[...new Set([r.date.format, 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd-MMM-yyyy', 'd MMM yyyy', 'MMM d, yyyy', 'dd.MM.yyyy'])].map((f) => ({ value: f, label: f }))} />
                                    </>}
                                    {r.column && (dataInfo?.columns.length
                                        // A column of the chosen data file, or a new one.
                                        ? <AutoComplete size="small" style={{ width: 130 }} className="mono" aria-label="Data column" defaultValue={r.column} key={`${r.index}-${r.column}`}
                                            options={dataInfo.columns.map((c) => ({ value: c }))} filterOption={(q, o) => String(o?.value ?? '').toLowerCase().includes(q.toLowerCase())}
                                            onSelect={(v: string) => setValues({ ...values, [r.index]: { ...values[r.index], mode: r.mode, column: v } })}
                                            onBlur={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== r.column) setValues({ ...values, [r.index]: { ...values[r.index], mode: r.mode, column: v } }); }} />
                                        : <Typography.Text code editable={{ tooltip: 'Data column', onChange: (v) => { if (v.trim()) setValues({ ...values, [r.index]: { ...values[r.index], mode: r.mode, column: v.trim() } }); } }}>{r.column}</Typography.Text>)}
                                </Space> },
                            ]} />}
                            </Space>) },
                            { key: 'data', label: 'Test data & sign-in', children: (<Form layout="vertical" size="small" className="tests-rec-form" style={{ maxWidth: 760 }}>
                            <Row gutter={12}>
        <Col xs={24} md={12}><Form.Item label="Passwords"><Tooltip title={<span>ENCRYPTED: values in the data file work everywhere, also in pipelines; the framework's key is in its package, so they hide passwords from casual reading only. Studio secrets stay on this computer ({'{env:NAME}'}; pipeline variables in a pipeline).</span>}>
                                <Select size="small" style={{ width: '100%' }} value={secretMode} onChange={(m) => { setSecretMode(m); savePref('cs-studio-rec-secrets', m); }} aria-label="Secrets"
                                    options={[{ value: 'encrypted', label: 'ENCRYPTED: values in the test data' }, { value: 'studio', label: 'Studio secrets (this computer)' }]} />
                            </Tooltip></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item label="Test data"><Tooltip title="Where the test data goes: a new file in the format the team uses, or one of the project's data files (its rows are kept; the recording's values go to the columns you choose, new columns are added)">
                                <Select size="small" style={{ width: '100%' }} aria-label="Test data" showSearch optionFilterProp="label"
                                    value={data.file ?? `\u0000${data.format ?? 'json'}`}
                                    onChange={(v: string) => {
                                        if (v.startsWith('\u0000')) { const format = v.slice(1) as RecDataChoice['format']; setData({ format }); savePref('cs-studio-rec-data-format', format ?? 'json'); }
                                        else setData({ file: v });
                                    }}
                                    options={[
                                        { label: 'New file', options: [{ value: '\u0000json', label: 'New JSON file' }, { value: '\u0000csv', label: 'New CSV file' }, { value: '\u0000excel', label: 'New Excel file' }] },
                                        ...(dataFiles.length ? [{ label: 'The project\'s data files', options: dataFiles.map((f) => ({ value: f.path, label: f.path.replace(/^test\/[^/]+\/data\//, '') })) }] : []),
                                    ]} />
                            </Tooltip></Form.Item></Col>
                            </Row>
                            <Row gutter={12}>
        {data.file && dataInfo?.format === 'excel' && <Col xs={24} md={12}><Form.Item label="Sheet"><Select size="small" style={{ width: '100%' }} aria-label="Sheet" value={data.sheet ?? dataInfo.sheets[0]} onChange={(sheet) => setData({ ...data, sheet })} options={dataInfo.sheets.map((x) => ({ value: x, label: x }))} /></Form.Item></Col>}
        {data.file && dataInfo?.format === 'json' && <Col xs={24} md={12}><Form.Item label="JSON path of the rows"><Input size="small" style={{ width: '100%' }} className="mono" placeholder="$.data[*]" defaultValue={data.path} aria-label="JSON path of the rows" onBlur={(e) => setData({ ...data, path: e.target.value.trim() || undefined })} /></Form.Item></Col>}
        <Col xs={24} md={12}><Form.Item label="Rows that run"><Tooltip title="Which rows run (the framework's filter): e.g. runFlag=Yes, or env=dev;priority>1, or name~smith. Empty: runFlag=Yes when the file has that column, else every row.">
                                <Input size="small" style={{ width: '100%' }} className="mono" placeholder={dataInfo && !dataInfo.columns.includes('runFlag') ? 'every row' : 'runFlag=Yes'} defaultValue={data.filter} key={data.file ?? data.format} aria-label="Rows that run"
                                    onBlur={(e) => setData({ ...data, filter: e.target.value.trim() || undefined })} />
                            </Tooltip></Form.Item></Col>
                            </Row>
                            {data.file && dataInfo && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{dataInfo.rows} row{dataInfo.rows === 1 ? '' : 's'} · {dataInfo.columns.length} columns{dataInfo.readOnly ? ' · read only: use its columns' : ''}</Typography.Text>}
                            <Row gutter={12} style={{ marginTop: 8 }}>
        <Col xs={24} md={12}><Form.Item label="Sign-in"><Tooltip title="Sign-in (e.g. a company gateway): the steps up to this check sign in. They become one step that signs in, or finds the user still signed in: the session is saved (AUTH_STORAGE_STATE_PATH) and reused by the next scenarios. The values go to the environment's settings.">
                                <Select size="small" style={{ width: '100%' }} aria-label="Signed in when" value={signIn ?? -1} onChange={(v: number) => setSignIn(v < 0 ? null : v)}
                                    options={[{ value: -1, label: 'No sign-in steps' }, ...signInChecks.map((c) => ({ value: c.index, label: `Signed in when: ${c.line.replace(/ on the .* page$/, '')}` }))]} />
                            </Tooltip></Form.Item></Col>
                            </Row>
                            </Form>) },
                            { key: 'files', label: <>Files <span className="q-count">{preview?.files.length ?? 0}</span></>, children: (<>                        {preview?.review && preview.files.length > 0 ? <PlanReview review={{ ...preview.review, warnings: [] }} height={460} /> : preview && preview.files.length > 0 && <Tabs size="small" items={preview.files.map((f) => ({ key: f.path, label: <span>{f.path.split('/').pop()}<Tag bordered={false} color={f.change === 'new' ? 'green' : 'gold'} style={{ marginLeft: 6 }}>{f.change === 'new' ? 'new' : 'update'}</Tag></span>,
                            children: <div><Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{f.path}</Typography.Text><pre className="code-box" style={{ maxHeight: 460 }}>{f.text}</pre></div> }))} />}{!preview?.files.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No files yet: record or convert some steps first." />}</>) },
                        ]} />
                    </Space>
                </div>}
            </div>
        </Split>
            <Modal open={naming !== null} title={naming ? `Reusable step: steps ${naming.from + 1}–${naming.to + 1}` : ''} okText="Make it one step" okButtonProps={{ disabled: !naming?.name.trim() }}
                onCancel={() => setNaming(null)} afterOpenChange={(o) => { if (o) (document.querySelector('input[aria-label="Reusable step name"]') as HTMLInputElement | null)?.focus(); }}
                onOk={() => { if (!naming) return; setBlocks([...blocks, { from: naming.from, to: naming.to, name: naming.name.trim(), ...(naming.text.trim() ? { text: naming.text.trim() } : {}) }]); setPicked([]); setNaming(null); }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Input addonBefore="Name" placeholder="the user pays" value={naming?.name ?? ''} onChange={(e) => naming && setNaming({ ...naming, name: e.target.value })} aria-label="Reusable step name" autoFocus />
                    <Input className="mono" addonBefore="Step text" placeholder="optional: the user pays {string} with the card {string}" value={naming?.text ?? ''} onChange={(e) => naming && setNaming({ ...naming, text: e.target.value })} aria-label="Reusable step text" />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Its values (typed text, checked text) are its parameters, in order: one {'{string}'} each in the step text. Without a text: the name, then "with {'{string}'} and …".
                        Steps that switch tabs, press a key of the page, check test data or sign in cannot be part of it.
                    </Typography.Text>
                </Space>
            </Modal>
            <Modal open={pasting !== null} title="Convert a Playwright script" okText="Convert" width={760} onCancel={() => setPasting(null)} okButtonProps={{ disabled: !pasting?.trim() }}
                afterOpenChange={(o) => { if (o) (document.querySelector('textarea[aria-label="Playwright script"]') as HTMLTextAreaElement | null)?.focus(); }}
                onOk={() => { const s = pasting ?? ''; const url = /page\.goto\(\s*['"`]([^'"`]+)/.exec(s)?.[1] ?? 'Playwright script'; open({ id: 'pasted', url, state: 'finished', startedAt: new Date().toISOString(), testIdAttribute: 'data-testid', script: s }); setPasting(null); }}>
                <Typography.Paragraph type="secondary">A Playwright test (TypeScript or JavaScript), for example one recorded with <Typography.Text code>npx playwright codegen</Typography.Text>.</Typography.Paragraph>
                <Input.TextArea autoFocus className="mono" autoSize={{ minRows: 12, maxRows: 24 }} value={pasting ?? ''} onChange={(e) => setPasting(e.target.value)} aria-label="Playwright script" />
            </Modal>
            <Modal open={newProject !== null} title="New project" okText="Use it" onCancel={() => setNewProject(null)} afterOpenChange={(o) => { if (o) (document.querySelector('input[aria-label="New project name"]') as HTMLInputElement | null)?.focus(); }} okButtonProps={{ disabled: !/^[A-Za-z0-9][\w.-]{0,63}$/.test(newProject ?? '') }}
                onOk={() => { setProject(newProject!.trim()); setNewProject(null); }}>
                <Typography.Paragraph type="secondary">Its configuration (config/&lt;project&gt;) and folders are created when the first recording is saved; record with the application's address.</Typography.Paragraph>
                <Input autoFocus placeholder="e.g. crm" value={newProject ?? ''} onChange={(e) => setNewProject(e.target.value.trim())} aria-label="New project name" />
            </Modal>
            <Modal open={!!splitAt} title="Start a new page here" okText="Start page" onCancel={() => setSplitAt(null)} afterOpenChange={(o) => { if (o) (document.querySelector('input[aria-label="New page name"]') as HTMLInputElement | null)?.focus(); }} okButtonProps={{ disabled: !splitAt?.name.trim() }}
                onOk={() => { if (splitAt) setBreaks({ ...breaks, [splitAt.index]: splitAt.name.trim() }); setSplitAt(null); }}>
                <Input autoFocus placeholder="Page name, e.g. Checkout" value={splitAt?.name ?? ''} onChange={(e) => splitAt && setSplitAt({ ...splitAt, name: e.target.value })} aria-label="New page name"
                    onPressEnter={() => { if (splitAt?.name.trim()) { setBreaks({ ...breaks, [splitAt.index]: splitAt.name.trim() }); setSplitAt(null); } }} />
            </Modal>
                            </>);
}
