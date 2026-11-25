/**
 * Run output with filters that match how the framework writes its log:
 *   "[2026-…Z] [INFO] text", "[DEBUG] text", "[PERF] …", and multi-line blocks (JSON of the
 *   options, Playwright's boxed messages) whose following lines carry no level of their own.
 * Every line gets a level; a continuation line takes the level of the line it belongs to, so hiding
 * debug hides the whole debug block.
 */
import React from 'react';
import { Button, Input, Segmented, Tooltip, Typography } from 'antd';
import { CopyOutlined, VerticalAlignBottomOutlined } from '@ant-design/icons';
import type { LogLine } from '../api';
import { Ansi, stripAnsi } from './Ansi';

export type Level = 'error' | 'warn' | 'info' | 'debug' | 'studio';
const TAG = /^\s*(?:\[[0-9T:.\-Z]+\]\s*)?\[([A-Z]+)\]/;
const LEVEL_OF: Record<string, Level> = {
    ERROR: 'error', FAIL: 'error', FAILED: 'error', FATAL: 'error',
    WARN: 'warn', WARNING: 'warn',
    DEBUG: 'debug', PERF: 'debug', TRACE: 'debug', VERBOSE: 'debug',
};

/** Level of every line (continuations inherit). */
export function levels(lines: LogLine[]): Level[] {
    const out: Level[] = [];
    let prev: Level = 'info';
    for (const l of lines) {
        if (l.stream === 'studio') { out.push('studio'); prev = 'info'; continue; }
        const t = stripAnsi(l.text);
        const m = TAG.exec(t);
        let lv: Level;
        if (m) lv = LEVEL_OF[m[1]] ?? 'info';
        else if (/^(\s|[}\]║╔╚╟│|]|at\s)/.test(t) || t === '') lv = prev;
        else if (l.stream === 'err') lv = /error|fail|exception|cannot|could not/i.test(t) ? 'error' : 'warn';
        else lv = /^(error|.*\berror:)/i.test(t) ? 'error' : 'info';
        out.push(lv); prev = lv;
    }
    return out;
}

const SHOW: Record<string, Level[]> = {
    errors: ['error', 'studio'],
    normal: ['error', 'warn', 'info', 'studio'],
    all: ['error', 'warn', 'info', 'debug', 'studio'],
};

export function RunLog({ log, running }: { log: LogLine[]; running: boolean }) {
    const [mode, setMode] = React.useState<string>(() => { try { return localStorage.getItem('cs-studio-log-mode') ?? 'normal'; } catch { return 'normal'; } });
    const [q, setQ] = React.useState('');
    const [stick, setStick] = React.useState(true);
    const ref = React.useRef<HTMLDivElement>(null);
    const lv = React.useMemo(() => levels(log), [log]);
    const counts = React.useMemo(() => ({ error: lv.filter((x) => x === 'error').length, warn: lv.filter((x) => x === 'warn').length, debug: lv.filter((x) => x === 'debug').length }), [lv]);
    const query = q.trim().toLowerCase();
    const shown = React.useMemo(() => {
        const allow = new Set(SHOW[mode] ?? SHOW.normal);
        const r: LogLine[] = [];
        log.forEach((l, i) => { if (allow.has(lv[i]) && (!query || stripAnsi(l.text).toLowerCase().includes(query))) r.push(l); });
        return r.slice(-5000);
    }, [log, lv, mode, query]);
    const setM = (m: string) => { setMode(m); try { localStorage.setItem('cs-studio-log-mode', m); } catch { /* ignore */ } };

    React.useEffect(() => { const el = ref.current; if (el && stick) el.scrollTop = el.scrollHeight; }, [shown, stick]);
    const onScroll = () => { const el = ref.current; if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
    const lvOf = new Map(log.map((l, i) => [l.n, lv[i]]));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--panel-border)', flexWrap: 'wrap' }}>
                <Typography.Text strong>Output</Typography.Text>
                <Segmented size="small" value={mode} onChange={(v) => setM(String(v))} options={[
                    { value: 'errors', label: <Tooltip title="Only errors and failures">Errors{counts.error ? ` (${counts.error})` : ''}</Tooltip> },
                    { value: 'normal', label: <Tooltip title="Everything except debug messages">Normal</Tooltip> },
                    { value: 'all', label: <Tooltip title="Including the framework's debug messages">All{counts.debug ? ` (+${counts.debug} debug)` : ''}</Tooltip> },
                ]} />
                <Input size="small" allowClear placeholder="Find in output" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
                <div style={{ flex: 1 }} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{shown.length} of {log.length} lines</Typography.Text>
                <Tooltip title="Copy the shown lines"><Button aria-label="Copy the shown lines" size="small" type="text" icon={<CopyOutlined />} onClick={() => void navigator.clipboard?.writeText(shown.map((l) => stripAnsi(l.text)).join('\n'))} /></Tooltip>
                {!stick && <Tooltip title="Follow new output"><Button size="small" icon={<VerticalAlignBottomOutlined />} onClick={() => setStick(true)}>Follow</Button></Tooltip>}
            </div>
            <div ref={ref} className="run-log" onScroll={onScroll}>
                {shown.map((l) => <div key={l.n} className={`run-line ${l.stream} lv-${lvOf.get(l.n)}`}><Ansi text={l.text} /></div>)}
                {running && log.length <= 2 && <div className="run-line studio">Starting the framework (loading configuration and step definitions)…</div>}
                {!running && shown.length === 0 && log.length > 0 && <div className="run-line studio">No lines match this filter.</div>}
                {!running && log.length === 0 && <div className="run-line studio">The output of this run was not kept (it ran before this version of the Studio). Its results and report are still available.</div>}
            </div>
        </div>
    );
}

/** What the run is doing now, read from the framework's "[TEST] Starting test: …" lines. */
export function progressOf(log: LogLine[]): { started: number; current?: string; passed: number; failed: number } {
    let started = 0, passed = 0, failed = 0, current: string | undefined;
    for (const l of log) {
        if (l.stream === 'studio') continue;
        const t = stripAnsi(l.text);
        const s = /\[TEST\] Starting test: (.*)$/.exec(t);
        if (s) { started++; current = s[1].trim(); continue; }
        if (/\[PASS\]\s*(Scenario|Test) (passed|completed)/i.test(t)) passed++;
        else if (/\[FAIL\]\s*(Scenario|Test) failed/i.test(t)) failed++;
    }
    return { started, current, passed, failed };
}
