/**
 * Recording inside the Studio: the application, live, in a Playwright browser the Studio runs; the
 * person clicks and types in the picture (every action becomes a step before the page reacts); the
 * toolbar adds checks (pick the check, then the element); lists show their options here; steps appear
 * as they are recorded and can be removed. Stop ends the recording and opens the review.
 */
import React from 'react';
import { Alert, App, Button, Checkbox, Empty, InputNumber, Input, Modal, Radio, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, CheckSquareOutlined, DeleteOutlined, EyeOutlined, FieldStringOutlined, FontSizeOutlined, LinkOutlined, PauseOutlined, CaretRightOutlined, ReloadOutlined, StopOutlined, TagOutlined, NumberOutlined, EyeInvisibleOutlined, PoweroffOutlined, CodeOutlined, OrderedListOutlined, TableOutlined, UploadOutlined, DatabaseOutlined, SaveOutlined, CalculatorOutlined, BarsOutlined, FieldTimeOutlined, AimOutlined, CloseOutlined } from '@ant-design/icons';
import { api, DataPreview, DataSourceDef, RecCheckKind, RecDialog, RecProposal, RecReplay, RecSuggestions } from '../api';
import { DataSourceEditor } from './DataSourceEditor';
import { errText } from '../state';
import { partsOf, stepWords } from '../recStep';

type Frame = { data: string; seq: number; url: string; width: number; height: number; at: number };
type Box = { x: number; y: number; width: number; height: number };

const CHECKS: Array<{ kind: RecCheckKind; label: string; icon: React.ReactNode; pick: boolean; help: string }> = [
    { kind: 'visible', label: 'Shown', icon: <EyeOutlined />, pick: true, help: 'The element is shown' },
    { kind: 'contains', label: 'Text contains', icon: <FontSizeOutlined />, pick: true, help: 'The element\'s text contains…' },
    { kind: 'text', label: 'Text is', icon: <FieldStringOutlined />, pick: true, help: 'The element\'s text is exactly…' },
    { kind: 'value', label: 'Value', icon: <NumberOutlined />, pick: true, help: 'The field\'s value is…' },
    { kind: 'checked', label: 'Ticked', icon: <CheckSquareOutlined />, pick: true, help: 'The check box or option is ticked' },
    { kind: 'url', label: 'Page address', icon: <LinkOutlined />, pick: false, help: 'The page address (its path, the same in every environment)' },
    { kind: 'title', label: 'Page title', icon: <TagOutlined />, pick: false, help: 'The page title' },
    { kind: 'hidden', label: 'Not shown', icon: <EyeInvisibleOutlined />, pick: false, help: 'A text is not shown (e.g. no error message)' },
    { kind: 'enabled', label: 'Enabled', icon: <PoweroffOutlined />, pick: true, help: 'The element is enabled, or disabled' },
    { kind: 'attribute', label: 'Attribute', icon: <CodeOutlined />, pick: true, help: 'An attribute of the element has a value' },
    { kind: 'count', label: 'Count', icon: <OrderedListOutlined />, pick: true, help: 'The number of rows or items like the one clicked' },
    { kind: 'cell', label: 'Table cell', icon: <TableOutlined />, pick: true, help: 'A table cell (found by its row) shows…' },
    { kind: 'column', label: 'Every row', icon: <BarsOutlined />, pick: true, help: 'Every row of a table column has a text, contains it, or the column is sorted' },
    { kind: 'wait', label: 'Wait until', icon: <FieldTimeOutlined />, pick: true, help: 'Wait until the element shows a text (or is shown / gone), refreshing the page while waiting if needed' },
    { kind: 'compare', label: 'Compare', icon: <CalculatorOutlined />, pick: true, help: 'A number shown is greater, less or equal (to a number, or to a remembered value ± an amount)' },
];
/** Files sent with an upload (base64 in the request; the Studio accepts about 8 MB at a time). */
const UPLOAD_LIMIT = 8 * 1024 * 1024;
const toBase64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
const SPECIAL = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', ...Array.from({ length: 12 }, (_x, i) => `F${i + 1}`)]);

/** A name for test data from its source: the file, the table of a query, the procedure, the request. */
function sourceName(s: DataSourceDef): string {
    const raw = s.kind === 'file' ? (s.file ?? '').split('/').pop()?.replace(/\.\w+$/, '') : s.kind === 'query' ? /\bfrom\s+([\w.]+)/i.exec(s.sql ?? '')?.[1]?.split('.').pop() : s.kind === 'procedure' ? s.procedure?.split('.').pop() : s.kind === 'api' ? s.request : 'generated';
    return (raw ?? 'data').replace(/[^\w-]+/g, '_').replace(/^[^A-Za-z]+/, '').slice(0, 40) || 'data';
}

/** How a suggested check reads. */
const SUGGEST_WORDS: Partial<Record<RecCheckKind, string>> = { url: 'Address is', title: 'Title is', text: 'Text is', contains: 'Shows', hidden: 'Not shown', visible: 'Visible' };

/**
 * An address typed without a scheme: a host (example.com, 127.0.0.1:8080, localhost:3000) gets one; anything with its
 * own scheme (file:, javascript:, ftp:) is passed as typed, so the Studio refuses it with a clear message.
 */
export function withScheme(u: string): string {
    if (/^[a-z][a-z\d+.-]*:/i.test(u) && !/^(localhost|[\w.-]+\.[a-z]{2,}|\d{1,3}(\.\d{1,3}){3}):\d+/i.test(u)) return u;
    return `${/^(localhost|127\.|\[?::1|\d{1,3}(\.\d{1,3}){3})/i.test(u) ? 'http' : 'https'}://${u}`;
}

export function LiveRecorder({ id, onStopped, project, env, inWindow = false }: { id: string; onStopped: () => void; project: string; env?: string; /** Recording in a browser window on this computer (no picture). */ inWindow?: boolean }) {
    const { message } = App.useApp();
    const [frame, setFrame] = React.useState<Frame | null>(null);
    const [steps, setSteps] = React.useState<Array<{ index: number; line: string }>>([]);
    const [paused, setPaused] = React.useState(false);
    const [address, setAddress] = React.useState('');
    const [mode, setMode] = React.useState<RecCheckKind | 'remember' | 'hover' | null>(null);
    // A click waits a moment: a double-click is one action, not two clicks. A press-move-release is a drag.
    const pendingClick = React.useRef<number | null>(null);
    const down = React.useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
    const dragged = React.useRef(false);
    // Remember a value of the page (an order number) for later steps.
    // A dialog of the page (alert / confirm / prompt) waiting for an answer; the open tabs.
    const [dialog, setDialog] = React.useState<(RecDialog & { text: string }) | null>(null);
    const [tabs, setTabs] = React.useState<Array<{ index: number; url: string; current: boolean }>>([]);
    // Checks suggested from what the last click or Enter changed on the page.
    const [suggest, setSuggest] = React.useState(true);
    const [suggestions, setSuggestions] = React.useState<RecSuggestions | null>(null);
    // Recording from a step: the replay of the steps before it; where new steps go.
    const [replay, setReplay] = React.useState<RecReplay | null>(null);
    const [insertAt, setInsertAt] = React.useState<number | null>(null);
    const [rememberAsk, setRememberAsk] = React.useState<{ code: string; value: string; name: string; label: string; pattern?: string } | null>(null);
    const [hit, setHit] = React.useState<{ box: Box | null; label: string } | null>(null);
    const [proposal, setProposal] = React.useState<RecProposal | null>(null);
    const [upload, setUpload] = React.useState<{ label: string; multiple: boolean; files: File[]; busy: boolean } | null>(null);
    const [select, setSelect] = React.useState<{ options: Array<{ value: string; label: string; selected: boolean }>; multiple: boolean; label: string; chosen: string[] } | null>(null);
    const [stopping, setStopping] = React.useState(false);
    // Test data: a source, its rows, the row whose values go into fields.
    const [dataOpen, setDataOpen] = React.useState(false);
    const [source, setSource] = React.useState<DataSourceDef | undefined>();
    const [dataName, setDataName] = React.useState('');
    const [dataMode, setDataMode] = React.useState<'run' | 'copy' | 'file'>('file');
    const [rows, setRows] = React.useState<DataPreview | null>(null);
    const [rowAt, setRowAt] = React.useState(0);
    const [loadingRows, setLoadingRows] = React.useState(false);
    const modesFor = (s?: DataSourceDef): Array<{ value: 'run' | 'copy' | 'file'; label: string }> => !s ? [] : s.kind === 'file'
        ? [{ value: 'file', label: 'The file is the test\'s data (one run per row)' }]
        : s.kind === 'query' || s.kind === 'procedure' || s.kind === 'api'
            ? [{ value: 'run', label: 'Read in every run (first row)' }, { value: 'copy', label: 'Copy the rows into the data file now' }]
            : [{ value: 'copy', label: 'Copy the rows into the data file now' }];
    const pickSource = (s: DataSourceDef | undefined) => {
        setSource(s); setRows(null); setRowAt(0);
        if (s) { setDataName(sourceName(s)); const m = modesFor(s); if (!m.some((x) => x.value === dataMode)) setDataMode(m[0].value); }
    };
    const loadRows = async () => {
        if (!source) return;
        setLoadingRows(true);
        try { setRows(await api.dataPreview(project, env, source, id)); setRowAt(0); } catch (e) { message.error(errText(e)); } finally { setLoadingRows(false); }
    };
    const putValue = async (column: string, check = false) => {
        if (!source || !rows) return;
        const value = rows.rows[rowAt]?.[column] ?? '';
        try { await api.recData(id, value, { name: dataName, column, mode: dataMode, source }, check); if (check) message.success(`Check added: ${dataName}.${column} = "${value}"`); img.current?.focus(); } catch (e) { message.error(errText(e)); }
    };
    const seq = React.useRef(0);
    const img = React.useRef<HTMLImageElement>(null);
    // The recording window: the check being picked there, the latest pick and request seen.
    const modeRef = React.useRef(mode);
    const lastPicked = React.useRef(0), lastUi = React.useRef(0);
    React.useEffect(() => { modeRef.current = mode; if (inWindow) void api.recPick(id, mode).catch(() => undefined); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
    const lastHover = React.useRef(0);
    const list = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const r = await api.recLive(id, seq.current);
                if (stop) return;
                if (r.frame) { seq.current = r.frame.seq; setFrame(r.frame); }
                setSteps(r.steps); setPaused(r.paused); setTabs(r.tabs ?? []);
                if (r.suggest !== undefined) setSuggest(r.suggest);
                setSuggestions(r.suggestions ?? null);
                setReplay(r.replay ?? null); setInsertAt(r.insertAt ?? null);
                if (r.dialog) setDialog((d) => d ?? { ...r.dialog!, text: r.dialog!.defaultValue });
                // The recording window: an element picked for a check; what an action there needs (a list, files, a dialog).
                if (r.window?.picked && r.window.picked.seq !== lastPicked.current) {
                    lastPicked.current = r.window.picked.seq;
                    const k = modeRef.current;
                    if (k) { setMode(null); void pickAt(k, r.window.picked); }
                }
                if (r.window?.ui && r.window.ui.seq !== lastUi.current) { lastUi.current = r.window.ui.seq; afterInput(r.window.ui); }
                if (!r.running) { onStopped(); return; }
            } catch { if (!stop) { onStopped(); return; } }
            if (!stop) setTimeout(tick, 200);
        };
        void tick();
        return () => { stop = true; };
    }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [steps.length]);

    const point = (e: React.MouseEvent) => {
        const el = img.current, f = frame;
        if (!el || !f) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(((e.clientX - r.left) / r.width) * f.width), y: Math.round(((e.clientY - r.top) / r.height) * f.height) };
    };
    const fail = (e: unknown) => message.error(errText(e));
    const onClick = async (e: React.MouseEvent) => {
        const p = point(e);
        img.current?.focus();
        if (!p) return;
        if (dragged.current) { dragged.current = false; return; }
        if (mode) {
            const k = mode;
            setMode(null); setHit(null);
            await pickAt(k, p);
            return;
        }
        // The second click of a double-click: the double-click handles it.
        if (e.detail > 1) { if (pendingClick.current) { window.clearTimeout(pendingClick.current); pendingClick.current = null; } return; }
        await new Promise<void>((res) => { pendingClick.current = window.setTimeout(() => { pendingClick.current = null; res(); }, 220); });
        if (dragged.current) { dragged.current = false; return; }
        try { afterInput(await api.recInput(id, { type: 'click', ...p })); } catch (x) { fail(x); }
    };
    /** What an action needs from the Studio: a list to choose in, files to upload, a dialog's answer. */
    const afterInput = (r: { select?: { options: Array<{ value: string; label: string; selected: boolean }>; multiple: boolean; label: string }; file?: { label: string; multiple: boolean }; dialog?: RecDialog | null; note?: string }) => {
        if (r.select) setSelect({ ...r.select, chosen: r.select.options.filter((o) => o.selected).map((o) => o.value) });
        if (r.file) setUpload({ ...r.file, files: [], busy: false });
        if (r.dialog) setDialog({ ...r.dialog, text: r.dialog.defaultValue });
        if (r.note) message.info(r.note);
    };
    /** An element pointed at for a check (on the picture, or clicked in the recording window). */
    const pickAt = async (k: RecCheckKind | 'remember' | 'hover', p: { x: number; y: number }) => {
        {
            if (k === 'hover') { try { await api.recInput(id, { type: 'hover', ...p }); } catch (x) { fail(x); } return; }
            if (k === 'remember') {
                try {
                    const pr = await api.recPropose(id, 'text', p.x, p.y);
                    // A name from the element's test id, label or id (not from the value it shows now).
                    const src = /getByTestId\('([^']+)'/.exec(pr.code)?.[1] ?? /getBy(?:Label|Placeholder)\('([^']+)'/.exec(pr.code)?.[1] ?? /locator\('#([\w-]+)'/.exec(pr.code)?.[1]
                        ?? (/getByRole\('\w+', \{ name: '([^']+)'/.exec(pr.code)?.[1] !== pr.expected ? /getByRole\('\w+', \{ name: '([^']+)'/.exec(pr.code)?.[1] : undefined) ?? 'value';
                    const name = src.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).map((w, n) => (n ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('').replace(/^[^A-Za-z_]+/, '').slice(0, 40) || 'value';
                    setRememberAsk({ code: pr.code, value: pr.expected, name, label: pr.label });
                } catch (x) { fail(x); }
                return;
            }
            try { const pr = await api.recPropose(id, k, p.x, p.y); if (k === 'visible' || k === 'checked') await api.recConfirm(id, k, pr.code, pr.expected); else setProposal(k === 'enabled' ? { ...pr, kind: pr.expected === 'disabled' ? 'disabled' : 'enabled' } : pr); } catch (x) { fail(x); }
        }
    };
    const onDouble = async (e: React.MouseEvent) => {
        const p = point(e);
        if (!p || mode) return;
        if (pendingClick.current) { window.clearTimeout(pendingClick.current); pendingClick.current = null; }
        try { await api.recInput(id, { type: 'dblclick', ...p }); } catch (x) { fail(x); }
    };
    const onRight = async (e: React.MouseEvent) => {
        e.preventDefault();
        const p = point(e);
        if (!p || mode) return;
        try { await api.recInput(id, { type: 'rightclick', ...p }); } catch (x) { fail(x); }
    };
    const onDown = (e: React.MouseEvent) => { if (e.button === 0 && !mode) { const p = point(e); if (p) down.current = { ...p, cx: e.clientX, cy: e.clientY }; } };
    const onUp = async (e: React.MouseEvent) => {
        const d = down.current;
        down.current = null;
        if (!d || Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 6) return;
        // Pressed, moved and released: a drag (drag and drop, a slider).
        dragged.current = true;
        const p = point(e);
        if (!p) return;
        try { await api.recInput(id, { type: 'drag', x: d.x, y: d.y, x2: p.x, y2: p.y }); } catch (x) { fail(x); }
    };
    const onMove = (e: React.MouseEvent) => {
        if (!mode || Date.now() - lastHover.current < 150) return;
        lastHover.current = Date.now();
        const p = point(e);
        if (p) api.recHover(id, p.x, p.y).then((r) => setHit(r.hit)).catch(() => {});
    };
    const onKey = (e: React.KeyboardEvent) => {
        // Text from an input method (Chinese, Japanese, …) or the emoji picker is composed first: it arrives as input
        // in the typing field (onTyped), not as keys.
        if (e.nativeEvent.isComposing || e.key === 'Process' || e.key === 'Unidentified' || e.key === 'Dead') return;
        if (e.key === 'Escape' && mode) { setMode(null); setHit(null); return; }
        const mod = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta'].filter(Boolean) as string[];
        if (mod.length && (e.key === 'v' || e.key === 'V')) return; // paste: onPaste
        e.preventDefault();
        if (mod.length && e.key.length === 1) { void api.recInput(id, { type: 'key', key: `${[...mod, ...(e.shiftKey ? ['Shift'] : [])].join('+')}+${e.key.toUpperCase() === e.key && e.shiftKey ? e.key : e.key.toLowerCase()}` }).catch(fail); return; }
        if (e.key.length === 1) void api.recInput(id, { type: 'type', text: e.key }).catch(fail);
        else if (SPECIAL.has(e.key)) void api.recInput(id, { type: 'key', key: [...mod, ...(e.shiftKey && e.key !== 'Tab' ? ['Shift'] : [])].concat(e.shiftKey && e.key === 'Tab' ? ['Shift+Tab'] : [e.key]).join('+') }).catch(fail);
    };
    // The application's window is a picture: a hidden field next to it receives the keyboard (and composed text).
    const typer = React.useRef<HTMLTextAreaElement>(null);
    const onTyped = (text: string) => { if (text) void api.recInput(id, { type: 'type', text }).catch(fail); if (typer.current) typer.current.value = ''; };
    const f = frame;
    const box = hit?.box && f && img.current ? (() => {
        const r = img.current!.getBoundingClientRect(), s = r.width / f.width;
        return { left: hit.box!.x * s, top: hit.box!.y * s, width: hit.box!.width * s, height: hit.box!.height * s };
    })() : null;

    /** A step of the list (a page change, or an action / check with its test data). */
    const renderStep = (s: { index: number; line: string }, k: number, w: ReturnType<typeof stepWords>) => {
                            const bound = (() => { const prev = steps[k - 1]?.line; if (!prev?.startsWith('// cs-data ')) return null; try { return JSON.parse(prev.slice(11)) as { name: string; column: string; mode: string }; } catch { return null; } })();
                            if (w.kind === 'page') return (
                                <div key={`${s.index}-${s.line}`} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'var(--ant-color-fill-quaternary, #fafafa)', borderTop: '1px solid var(--panel-border)' }}>
                                    <Tag bordered={false} color="purple" style={{ margin: 0, fontSize: 11 }}>Page</Tag>
                                    <Typography.Text type="secondary" className="mono" ellipsis style={{ flex: 1, fontSize: 11 }} title={s.line.replace(/^\/\/ cs-page /, '')}>{w.text}</Typography.Text>
                                    <Tooltip title="Keep these steps on the page before"><Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Remove the page change" onClick={() => void api.recRemoveStep(id, s.index).then((r) => setSteps(r.steps)).catch(fail)} /></Tooltip>
                                </div>);
                            return (
                                <div key={`${s.index}-${s.line}`} className="item-row" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '5px 8px' }}>
                                    <span className="item-id" style={{ width: 20, flexShrink: 0 }}>{steps.slice(0, s.index + 1).filter((x) => !/^\/\/ cs-(page|data) /.test(x.line)).length}</span>
                                    <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 12, color: w.kind === 'check' ? '#389e0d' : w.kind === 'note' ? 'var(--muted, #888)' : undefined }}>{w.text}
                                        {bound && <Tooltip title={bound.mode === 'run' ? 'Read in every run (database query or API request)' : bound.mode === 'copy' ? 'The rows are copied into the data file' : 'From the data file (one run per row)'}><Tag bordered={false} color="cyan" style={{ marginLeft: 6, fontSize: 11 }}>{bound.name}.{bound.column}</Tag></Tooltip>}</span>
                                    <Tooltip title="Remove this step"><Button size="small" type="text" icon={<DeleteOutlined />} aria-label={`Remove step ${s.index + 1}`} onClick={() => void api.recRemoveStep(id, s.index).then((r) => setSteps(r.steps)).catch(fail)} /></Tooltip>
                                </div>);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {paused ? <Tag color="default">Paused</Tag> : <Tag color="red">● Recording</Tag>}
                <Tooltip title={paused ? 'Record again' : 'Pause: use the application without recording (e.g. to get to a page)'}>
                    <Button size="small" icon={paused ? <CaretRightOutlined /> : <PauseOutlined />} onClick={() => void api.recPause(id, !paused).then((r) => setPaused(r.paused)).catch(fail)}>{paused ? 'Resume' : 'Pause'}</Button>
                </Tooltip>
                <Tooltip title="Back"><Button size="small" icon={<ArrowLeftOutlined />} aria-label="Back" onClick={() => void api.recBack(id).catch(fail)} /></Tooltip>
                <Tooltip title="Reload"><Button size="small" icon={<ReloadOutlined />} aria-label="Reload" onClick={() => void api.recReload(id).catch(fail)} /></Tooltip>
                <Input size="small" className="mono" style={{ flex: 1, minWidth: 200 }} placeholder={f?.url ?? 'Address'} value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Address"
                    onPressEnter={() => { const u = address.trim(); if (u) void api.recNavigate(id, withScheme(u)).then(() => setAddress('')).catch(fail); }} />
                {tabs.length > 1 && <Tooltip title="Close the tab shown (the test closes it too)"><Button size="small" icon={<CloseOutlined />} aria-label="Close tab" onClick={() => void api.recCloseTab(id).catch(fail)}>Close tab</Button></Tooltip>}
                {tabs.length > 1 && <Tooltip title="Tabs of the application: the steps act in the tab shown (the test switches tabs too)">
                    <Select size="small" style={{ width: 220 }} aria-label="Tab" value={tabs.find((t) => t.current)?.index ?? 0} onChange={(i: number) => void api.recTab(id, i).catch(fail)}
                        options={tabs.map((t) => ({ value: t.index, label: `Tab ${t.index + 1}: ${t.url.replace(/^https?:\/\//, '').slice(0, 40)}` }))} />
                </Tooltip>}
                <Button size="small" danger icon={<StopOutlined />} loading={stopping} onClick={() => { setStopping(true); void api.recStop(id).finally(() => { setStopping(false); onStopped(); }); }}>Stop</Button>
            </div>
            {replay && !replay.finished && <Alert type="info" showIcon message={`Doing the recorded steps again: ${replay.done} of ${replay.total}. Recording starts after step ${replay.after + 1}.`} />}
            {replay?.error && paused && <Alert type="warning" showIcon message={replay.error} />}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>Add a check:</Typography.Text>
                {CHECKS.map((c) => (
                    <Tooltip key={c.kind} title={c.pick ? `${c.help}: click this, then the element` : c.help}>
                        <Button size="small" type={mode === c.kind ? 'primary' : 'default'} icon={c.icon} onClick={() => {
                            if (c.pick) { setMode(mode === c.kind ? null : c.kind); setHit(null); img.current?.focus(); return; }
                            void api.recPropose(id, c.kind).then(setProposal).catch(fail);
                        }}>{c.label}</Button>
                    </Tooltip>))}
                <Tooltip title="Point at an element (a menu that opens when the mouse is over it): click this, then the element">
                    <Button size="small" type={mode === 'hover' ? 'primary' : 'default'} icon={<AimOutlined />} onClick={() => { setMode(mode === 'hover' ? null : 'hover'); setHit(null); img.current?.focus(); }}>Point at</Button>
                </Tooltip>
                <Tooltip title="Remember a value of the page (an order number, a total) for later steps: click this, then the element. Later steps with the same value use the remembered one in each run.">
                    <Button size="small" type={mode === 'remember' ? 'primary' : 'default'} icon={<SaveOutlined />} onClick={() => { setMode(mode === 'remember' ? null : 'remember'); setHit(null); img.current?.focus(); }}>Remember</Button>
                </Tooltip>
                {mode && <Typography.Text type="warning" style={{ fontSize: 12 }}>{mode === 'remember' ? 'Click the element whose text to remember' : mode === 'hover' ? 'Click the element to point at' : 'Click the element to check'} (Esc: cancel)</Typography.Text>}
                <span style={{ flex: 1 }} />
                <Tooltip title="Values from test data (a file, a database, an API): click a field in the application, then a value">
                    <Button size="small" icon={<DatabaseOutlined />} type={dataOpen ? 'primary' : 'default'} onClick={() => setDataOpen(!dataOpen)}>Test data</Button>
                </Tooltip>
            </div>
            <div style={{ display: 'flex', gap: 8, minHeight: 0, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0, position: 'relative', border: '1px solid var(--panel-border)', borderRadius: 6, background: '#111', overflow: 'hidden' }}>
                    {inWindow ? <div style={{ padding: 24, background: 'var(--panel-bg, #fff)', minHeight: 300 }}>
                        <Typography.Title level={5} style={{ marginTop: 0 }}>Recording in a browser window on this computer</Typography.Title>
                        <Typography.Paragraph>Use the application in that window as usual: clicks, typing, keys, menus, drag and drop, other tabs and windows are recorded here.</Typography.Paragraph>
                        <Typography.Paragraph>To add a check, choose it in the toolbar above, then click the element in the window (it is outlined under the pointer).{mode ? <Tag color="blue" style={{ marginLeft: 8 }}>Now: click the element in the window</Tag> : null}</Typography.Paragraph>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Lists, file uploads and dialogs the application opens are answered here. Press Stop when done.</Typography.Text>
                    </div>
                    : f ? <img ref={img} tabIndex={0} alt={`Application: ${f.url}`} src={`data:image/jpeg;base64,${f.data}`} draggable={false}
                        onClick={(e) => void onClick(e)} onDoubleClick={(e) => void onDouble(e)} onContextMenu={(e) => void onRight(e)} onMouseDown={onDown} onMouseUp={(e) => void onUp(e)} onMouseMove={onMove} onKeyDown={onKey} onWheel={(e) => void api.recInput(id, { type: 'scroll', dy: Math.round(e.deltaY) }).catch(() => {})}
                        onFocus={() => typer.current?.focus()}
                        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); void api.recInput(id, { type: 'type', text: t }).catch(fail); } }}
                        style={{ width: '100%', maxWidth: f.width, height: 'auto', display: 'block', cursor: mode ? 'crosshair' : 'default', outline: 'none' }} />
                    : null}
                    {!inWindow && f && <textarea ref={typer} aria-label="Typing into the application" autoComplete="off" spellCheck={false}
                        style={{ position: 'fixed', left: -1000, top: 0, width: 10, height: 10, opacity: 0 }}
                        onKeyDown={onKey}
                        onCompositionEnd={(e) => onTyped(e.data)}
                        onInput={(e) => { const n = e.nativeEvent as InputEvent; if (!n.isComposing && (n.inputType === 'insertText' || n.inputType === 'insertFromPaste' || n.inputType === 'insertReplacementText')) onTyped(n.data ?? (e.target as HTMLTextAreaElement).value); }}
                        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); onTyped(t); } }} />}
                    {!inWindow && !f && <div style={{ height: 360, display: 'grid', placeItems: 'center' }}><Spin tip="Opening the application…"><span /></Spin></div>}
                    {box && <div style={{ position: 'absolute', pointerEvents: 'none', left: box.left, top: box.top, width: box.width, height: box.height, border: '2px solid #1677ff', background: 'rgba(22,119,255,0.12)', borderRadius: 3 }}>
                        <span style={{ position: 'absolute', top: -22, left: 0, background: '#1677ff', color: '#fff', fontSize: 11, padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap' }}>{hit?.label}</span></div>}
                </div>
                <div style={{ width: dataOpen ? 400 : 320, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
                {dataOpen && <div className="rec-data-panel" style={{ border: '1px solid var(--panel-border)', borderRadius: 6, padding: 10, maxHeight: 420, overflow: 'auto' }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                        <Typography.Text strong style={{ flex: 1 }}>Test data</Typography.Text>
                        <Button size="small" type="text" aria-label="Close test data" onClick={() => setDataOpen(false)}>✕</Button>
                    </div>
                    <Space direction="vertical" style={{ width: '100%' }} size={8}>
                        <DataSourceEditor project={project} env={env} value={source} onChange={pickSource} />
                        {source && <>
                            <Input size="small" addonBefore="Name" className="mono" value={dataName} onChange={(e) => setDataName(e.target.value.replace(/[^\w-]/g, ''))} aria-label="Test data name" />
                            <Radio.Group size="small" value={dataMode} onChange={(e) => setDataMode(e.target.value)} options={modesFor(source)} style={{ display: 'flex', flexDirection: 'column', gap: 2 }} />
                            <Button size="small" icon={<DatabaseOutlined />} loading={loadingRows} onClick={() => void loadRows()}>Load the rows</Button>
                        </>}
                        {rows && (rows.rows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No rows" /> : <>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Click a field in the application, then a value of the chosen row{dataMode === 'run' ? ' (or ✓ to check the value at this point: data the application wrote; parameters may use {remembered:name})' : ''}{dataMode === 'run' ? ` (the test reads its row from the ${source?.kind === 'api' ? 'API' : 'database'} in every run)` : dataMode === 'copy' ? ' (these rows go into the data file: one run per row)' : ' (one run per row of the file)'}:</Typography.Text>
                            <Space size={4} wrap>
                                {rows.columns.map((c) => <Space.Compact key={c} size="small">
                                    <Button size="small" onClick={() => void putValue(c)} title={`Type ${rows.rows[rowAt]?.[c] ?? ''} into the field`}>
                                        <span className="mono" style={{ fontSize: 11 }}>{c}</span>: {String(rows.rows[rowAt]?.[c] ?? '').slice(0, 24) || '∅'}</Button>
                                    {dataMode === 'run' && <Tooltip title={`Check: at this point of the test, ${dataName}.${c} is "${rows.rows[rowAt]?.[c] ?? ''}" (read again in every run)`}>
                                        <Button size="small" icon={<CheckSquareOutlined />} aria-label={`Check ${c}`} onClick={() => void putValue(c, true)} /></Tooltip>}
                                </Space.Compact>)}
                            </Space>
                        <Table size="small" pagination={false} scroll={{ x: true, y: 150 }} rowKey={(_r, i) => String(i)} dataSource={rows.rows.slice(0, 50)}
                                rowSelection={{ type: 'radio', selectedRowKeys: [String(rowAt)], onChange: (k) => setRowAt(Number(k[0])) }}
                                onRow={(_r, i) => ({ onClick: () => setRowAt(i ?? 0) })}
                                columns={rows.columns.map((c) => ({ title: c, dataIndex: c, ellipsis: true, width: 120 }))} />
                            </>)}
                    </Space>
                </div>}
                <div ref={list} style={{ flex: 1, minHeight: 120, maxHeight: dataOpen ? 260 : 640, overflow: 'auto', border: '1px solid var(--panel-border)', borderRadius: 6 }}>
                    <div className="side-section" style={{ position: 'sticky', top: 0, background: 'var(--panel-bg, #fff)', zIndex: 1 }}>Steps ({steps.filter((x) => !/^\/\/ cs-(page|data) /.test(x.line)).length})</div>
                    {!steps.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Use the application: each action becomes a step" />
                        : steps.map((s, k) => {
                            if (s.line.startsWith('// cs-data ')) return null;
                            const w = stepWords(s.line);
                            const here = insertAt !== null && s.index === insertAt
                                ? <div key="insert-here" className="rec-insert" role="note">New steps go here</div> : null;
                            const row = renderStep(s, k, w);
                            return here ? <React.Fragment key={`${s.index}-${s.line}`}>{here}{row}</React.Fragment> : row;
                        })}
                    {insertAt === null ? null : insertAt >= steps.length && <div className="rec-insert" role="note">New steps go here</div>}
                </div>
                <div className="rec-suggest" aria-label="Suggested checks">
                    <div className="rec-suggest-head">
                        <span>Suggested checks</span>
                        <Tooltip title="After each click or Enter, suggest checks for what changed on the page (a message, a heading, a counter, the address)">
                            <Switch size="small" checked={suggest} aria-label="Suggest checks" onChange={(on) => void api.recSuggest(id, { on }).then((r) => { setSuggest(r.suggest); setSuggestions(r.suggestions); }).catch(fail)} />
                        </Tooltip>
                    </div>
                    {suggest && (suggestions?.items.length ? suggestions.items.map((g) => (
                        <div key={`${suggestions.seq}-${g.kind}-${g.code}-${g.expected}`} className="rec-suggest-row">
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 12, overflowWrap: 'anywhere' }}><b>{SUGGEST_WORDS[g.kind] ?? g.kind}</b> {g.kind === 'url' || g.kind === 'title' ? '' : <Typography.Text type="secondary">{g.label} </Typography.Text>}{g.expected && <span className="mono">"{g.expected.length > 90 ? `${g.expected.slice(0, 90)}…` : g.expected}"</span>}</div>
                                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{g.why}</Typography.Text>
                            </div>
                            <Button size="small" type="primary" ghost onClick={() => void api.recConfirm(id, g.kind, g.code, g.expected).then(() => setSuggestions((x) => (x ? { ...x, items: x.items.filter((y) => y !== g) } : x))).catch(fail)}>Add</Button>
                            <Tooltip title="Not this one"><Button size="small" type="text" icon={<CloseOutlined />} aria-label={`Dismiss: ${SUGGEST_WORDS[g.kind] ?? g.kind} ${g.expected}`} onClick={() => void api.recSuggest(id, { dismiss: g }).then((r) => setSuggestions(r.suggestions)).catch(fail)} /></Tooltip>
                        </div>))
                        : <Typography.Text type="secondary" style={{ fontSize: 12, padding: '2px 8px', display: 'block' }}>Checks for what the next click changes appear here.</Typography.Text>)}
                </div>
                </div>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{inWindow
                ? 'Use the application in its window. Pause to get somewhere without recording. Stop when done: the steps open for review.'
                : 'Click, double-click, right-click, drag and type in the picture to use the application (keys and shortcuts too; paste works). Pause to get somewhere without recording. Stop when done: the steps open for review.'}</Typography.Text>
            <Modal open={!!proposal} title={proposal ? `Check: ${CHECKS.find((c) => c.kind === (proposal.kind === 'disabled' ? 'enabled' : proposal.kind))?.help}` : ''} okText="Add the check" onCancel={() => setProposal(null)}
                okButtonProps={{ disabled: !!proposal && ((proposal.kind === 'hidden' && !proposal.expected.trim()) || (proposal.kind === 'count' && !/^\d+$/.test(proposal.expected.trim()))) }}
                onOk={() => { const p = proposal!; setProposal(null); void api.recConfirm(id, p.kind, p.code, p.expected, p.attribute, { op: p.op, name: p.name, plus: p.plus, column: p.column, reload: p.reload, seconds: p.seconds }).catch(fail); }}>
                {proposal && <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary">{proposal.label}</Typography.Text>
                    {proposal.kind === 'contains' || proposal.kind === 'text' ? <Radio.Group size="small" value={proposal.kind} onChange={(e) => setProposal({ ...proposal, kind: e.target.value })}
                        options={[{ value: 'contains', label: 'contains' }, { value: 'text', label: 'is exactly' }]} optionType="button" /> : null}
                    {proposal.kind === 'enabled' || proposal.kind === 'disabled' ? <Radio.Group size="small" value={proposal.kind} onChange={(e) => setProposal({ ...proposal, kind: e.target.value })}
                        options={[{ value: 'enabled', label: 'is enabled' }, { value: 'disabled', label: 'is disabled' }]} optionType="button" /> : null}
                    {proposal.kind === 'attribute' && <Select size="small" style={{ width: '100%' }} value={proposal.attribute} aria-label="Attribute"
                        options={(proposal.attributes ?? []).map((a) => ({ value: a.name, label: <span className="mono">{a.name}</span> }))}
                        onChange={(v) => setProposal({ ...proposal, attribute: v, expected: proposal.attributes?.find((a) => a.name === v)?.value ?? '' })} />}
                    {proposal.kind === 'compare' && <Space wrap size={6}>
                        <Select size="small" style={{ width: 140 }} aria-label="Comparison" value={proposal.op ?? 'eq'} onChange={(op) => setProposal({ ...proposal, op })}
                            options={[{ value: 'eq', label: 'equal to' }, { value: 'ne', label: 'different from' }, { value: 'gt', label: 'greater than' }, { value: 'ge', label: 'at least' }, { value: 'lt', label: 'less than' }, { value: 'le', label: 'at most' }]} />
                        <Select size="small" style={{ width: 200 }} aria-label="Compare with" value={proposal.name ?? ''} onChange={(name) => setProposal({ ...proposal, name: name || undefined })}
                            options={[{ value: '', label: 'a number' }, ...(proposal.remembered ?? []).map((n) => ({ value: n, label: `the remembered ${n}` }))]} />
                        {proposal.name
                            ? <InputNumber size="small" addonBefore="plus" value={proposal.plus ?? 0} onChange={(v) => setProposal({ ...proposal, plus: Number(v ?? 0) })} aria-label="Plus" style={{ width: 130 }} />
                            : <Input size="small" style={{ width: 120 }} value={proposal.expected} onChange={(e) => setProposal({ ...proposal, expected: e.target.value })} aria-label="Number" inputMode="decimal" />}
                    </Space>}
                    {proposal.kind === 'column' && <>
                        <Radio.Group size="small" value={proposal.op} onChange={(e) => setProposal({ ...proposal, op: e.target.value })} optionType="button"
                            options={[{ value: 'equals', label: 'every row is' }, { value: 'contains', label: 'every row contains' }, { value: 'asc', label: 'sorted ascending' }, { value: 'desc', label: 'sorted descending' }]} />
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Now: {(proposal.values ?? []).slice(0, 8).join(' · ')}{(proposal.values ?? []).length > 8 ? ' …' : ''}</Typography.Text>
                    </>}
                    {proposal.kind === 'wait' && <Space wrap size={6}>
                        <Select size="small" style={{ width: 170 }} aria-label="Wait for" value={proposal.op ?? 'contains'} onChange={(op) => setProposal({ ...proposal, op })}
                            options={[{ value: 'contains', label: 'until it shows' }, { value: 'visible', label: 'until it is shown' }, { value: 'hidden', label: 'until it is gone' }]} />
                        <Checkbox checked={!!proposal.reload} onChange={(e) => setProposal({ ...proposal, reload: e.target.checked })}>refresh the page while waiting</Checkbox>
                        <InputNumber size="small" min={1} max={3600} addonAfter="s" value={proposal.seconds ?? 60} onChange={(v) => setProposal({ ...proposal, seconds: Number(v ?? 60) })} aria-label="Seconds" style={{ width: 110 }} />
                    </Space>}
                    {proposal.kind === 'enabled' || proposal.kind === 'disabled' || proposal.kind === 'compare' || (proposal.kind === 'column' && (proposal.op === 'asc' || proposal.op === 'desc')) || (proposal.kind === 'wait' && proposal.op !== 'contains' && proposal.op !== undefined) ? null : proposal.kind === 'count'
                        ? <Input value={proposal.expected} onChange={(e) => setProposal({ ...proposal, expected: e.target.value })} aria-label="Number of items" inputMode="numeric" style={{ width: 120 }} />
                        : <Input.TextArea autoSize={{ minRows: 1, maxRows: 6 }} value={proposal.expected} placeholder={proposal.kind === 'hidden' ? 'The text that should not be shown' : undefined} onChange={(e) => setProposal({ ...proposal, expected: e.target.value })} aria-label="Expected" />}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{proposal.kind === 'url' ? 'The path of the address: the same in every environment.'
                        : proposal.kind === 'hidden' ? 'The check passes when no element shows this text.'
                        : proposal.kind === 'count' ? 'Counted on the page now: the rows or items with the same place and look as the one clicked.'
                        : proposal.kind === 'cell' ? 'The cell is found by a text of its row and its column, so it is found again when the rows change order.'
                        : proposal.kind === 'enabled' || proposal.kind === 'disabled' ? 'The element is now ' + proposal.expected + '.'
                        : proposal.kind === 'column' ? 'Checked in every run on all the rows shown then (e.g. after filtering by status).'
                        : proposal.kind === 'wait' ? 'For work the application finishes later (a report, an import): the test waits, refreshing the page if asked, then goes on.'
                        : proposal.kind === 'compare' ? `It shows ${proposal.expected} now. With a remembered value: e.g. a cart count that should be the one remembered plus 1.`
                        : 'Taken from the page now: shorten it to the part that matters (e.g. without changing numbers).'}</Typography.Text>
                </Space>}
            </Modal>
            <Modal open={!!dialog} closable={false} maskClosable={false} title={`The page shows a${dialog?.type === 'alert' ? 'n alert' : dialog?.type === 'prompt' ? ' question' : ' confirmation'}`}
                footer={dialog && [
                    ...(dialog.type !== 'alert' ? [<Button key="c" onClick={() => { setDialog(null); void api.recDialog(id, 'dismiss').catch(fail); }}>Cancel</Button>] : []),
                    <Button key="o" type="primary" onClick={() => { const d = dialog; setDialog(null); void api.recDialog(id, 'accept', d.type === 'prompt' ? d.text : undefined).catch(fail); }}>OK</Button>,
                ]}>
                {dialog && <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{dialog.message}</Typography.Paragraph>
                    {dialog.type === 'prompt' && <Input value={dialog.text} onChange={(e) => setDialog({ ...dialog, text: e.target.value })} aria-label="Answer" autoFocus />}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>The test answers it the same way, and checks its message.</Typography.Text>
                </Space>}
            </Modal>
            <Modal open={!!rememberAsk} title="Remember for later steps" okText="Remember" onCancel={() => setRememberAsk(null)}
                okButtonProps={{ disabled: !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(rememberAsk?.name ?? '') }}
                onOk={() => { const r = rememberAsk!; setRememberAsk(null); void api.recRemember(id, r.code, r.name, r.pattern).catch(fail); }}>
                {rememberAsk && <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary">Seen now: <Typography.Text code>{rememberAsk.value || '(empty)'}</Typography.Text></Typography.Text>
                    <Input addonBefore="Name" className="mono" value={rememberAsk.name} onChange={(e) => setRememberAsk({ ...rememberAsk, name: e.target.value.trim() })} aria-label="Remember as" autoFocus />
                    {partsOf(rememberAsk.value).length > 0 && <Radio.Group size="small" value={rememberAsk.pattern ?? ''} onChange={(e) => setRememberAsk({ ...rememberAsk, pattern: e.target.value || undefined })} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
                        options={[{ value: '', label: 'The whole text' }, ...partsOf(rememberAsk.value).map((x) => ({ value: x.pattern, label: <span>Only the part like <Typography.Text code>{x.part}</Typography.Text> <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }}>{x.pattern}</Typography.Text></span> }))]} />}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Each run reads the value from the page; later steps that type or check this same value use what was read.</Typography.Text>
                </Space>}
            </Modal>
            <Modal open={!!upload} title={`Upload to "${upload?.label ?? ''}"`} okText="Upload" onCancel={() => setUpload(null)}
                okButtonProps={{ disabled: !upload?.files.length || upload.files.reduce((n, f) => n + f.size, 0) > UPLOAD_LIMIT, loading: upload?.busy }}
                onOk={async () => {
                    const u = upload!;
                    setUpload({ ...u, busy: true });
                    try { await api.recUpload(id, await Promise.all(u.files.map(async (f) => ({ name: f.name, data: await toBase64(f) })))); setUpload(null); }
                    catch (x) { setUpload({ ...u, busy: false }); fail(x); }
                }}>
                {upload && <Space direction="vertical" style={{ width: '100%' }}>
                    <input type="file" multiple={upload.multiple} aria-label="Files" onChange={(e) => setUpload({ ...upload, files: Array.from(e.target.files ?? []) })} />
                    {upload.files.reduce((n, f) => n + f.size, 0) > UPLOAD_LIMIT && <Typography.Text type="danger" style={{ fontSize: 12 }}>Up to 8 MB at a time: for bigger files, put them in the data folder's uploads and write the step in the feature.</Typography.Text>}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}><UploadOutlined /> The files are given to the application now and copied to the project's test data (uploads) when the test is saved.</Typography.Text>
                </Space>}
            </Modal>
            <Modal open={!!select} title={`Choose in "${select?.label ?? ''}"`} okText="Choose" onCancel={() => setSelect(null)} okButtonProps={{ disabled: !select?.chosen.length }}
                onOk={() => { const s = select!; setSelect(null); void api.recSelect(id, s.chosen).catch(fail); }}>
                {select && (select.multiple
                    ? <Checkbox.Group value={select.chosen} onChange={(v) => setSelect({ ...select, chosen: v as string[] })} options={select.options.map((o) => ({ value: o.value, label: o.label }))} style={{ display: 'flex', flexDirection: 'column', gap: 4 }} />
                    : <Select style={{ width: '100%' }} autoFocus showSearch optionFilterProp="label" value={select.chosen[0]} onChange={(v) => setSelect({ ...select, chosen: [v] })} options={select.options.map((o) => ({ value: o.value, label: o.label }))} aria-label="Option" />)}
            </Modal>
        </div>
    );
}
