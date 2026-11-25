/**
 * Live steps of a run, read from the framework's output as it comes: each scenario (and each retry of it), its steps
 * with how long each took, the step running now, and a failed step's error — before the run ends and its report exists.
 */
import React from 'react';
import { Empty, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined, MinusCircleOutlined } from '@ant-design/icons';
import type { LogLine } from '../api';
import { stripAnsi } from './Ansi';

export type StepState = 'running' | 'passed' | 'failed' | 'skipped';
export interface TimelineStep { text: string; at: number; ms?: number; state: StepState; error?: string }
export interface TimelineScenario { feature: string; name: string; attempt: number; at: number; ms?: number; state: StepState; steps: TimelineStep[]; /** An error before any step ran (the browser did not start, a hook failed). */ error?: string }

const TIME = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]\s*/;
/** The framework's output (lines may arrive split or joined) as scenarios and steps. */
export function parseTimeline(log: Array<Pick<LogLine, 'text' | 'stream'>>, running = false): TimelineScenario[] {
    const text = log.filter((l) => l.stream !== 'studio').map((l) => stripAnsi(l.text)).join('');
    const lines = text.split(/\r?\n|(?=\[\d{4}-\d\d-\d\dT[\d:.]+Z\])/);
    const out: TimelineScenario[] = [];
    let feature = '', attempt = 1, lastAt = 0;
    const cur = () => out[out.length - 1];
    const step = () => { const s = cur(); return s?.state === 'running' ? s.steps[s.steps.length - 1] : undefined; };
    const endStep = (at: number, state: StepState) => { const st = step(); if (st && st.state === 'running') { st.state = state; st.ms = Math.max(0, at - st.at); } };
    const endScenario = (at: number, state: StepState) => {
        const s = cur();
        if (!s || s.state !== 'running') return;
        endStep(at, state === 'failed' && step()?.state === 'running' ? 'failed' : 'passed');
        // No step ran: not a pass (failed when an error was seen, else it did not run).
        s.state = !s.steps.length && state === 'passed' ? (s.error ? 'failed' : 'skipped') : state; s.ms = Math.max(0, at - s.at);
    };
    for (const raw of lines) {
        const m = TIME.exec(raw);
        const at = m ? Date.parse(m[1]) : lastAt;
        if (m) lastAt = at;
        const l = raw.slice(m?.[0].length ?? 0).trim();
        if (!l) continue;
        let x: RegExpExecArray | null;
        if ((x = /^\[FEATURE\] Starting feature: (.+)$/.exec(l))) { feature = x[1].trim(); continue; }
        if ((x = /^\[INFO\] Retrying scenario \(attempt (\d+)\)/.exec(l))) { attempt = (cur()?.attempt ?? 1) + 1; continue; }
        if ((x = /^\[INFO\]\s+Scenario(?: Outline)?: (.+)$/.exec(l))) {
            endScenario(at, 'passed');
            const name = x[1].trim();
            const prev = cur();
            out.push({ feature, name, attempt: prev && prev.name === name && prev.feature === feature && attempt > 1 ? attempt : 1, at, state: 'running', steps: [] });
            attempt = 1;
            continue;
        }
        if ((x = /^\[STEP\] (.+)$/.exec(l))) {
            const s = cur();
            if (!s || s.state !== 'running') continue;
            endStep(at, 'passed');
            s.steps.push({ text: x[1].trim(), at, state: 'running' });
            continue;
        }
        if ((x = /^\[FAIL\] Test completed: /.exec(l)) || /^\[FAIL\]\s*(Scenario|Test) failed/.test(l)) { endScenario(at, 'failed'); continue; }
        if (/^\[PASS\]\s*(Test completed|Scenario passed|Test passed)/.test(l)) { endScenario(at, 'passed'); continue; }
        if ((x = /^\[(FAIL|ERROR)\]\s+(.+)$/.exec(l))) {
            // Playwright frames some messages with box-drawing lines (╔═║): the text only.
            x[2] = x[2].replace(/[\u2500-\u257F]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
            if (!x[2]) continue;
            const st = step();
            if (st) { st.state = 'failed'; st.ms ??= Math.max(0, at - st.at); st.error = st.error ? `${st.error}\n${x[2]}` : x[2]; if (st.error.length > 2000) st.error = st.error.slice(0, 2000); }
            else { const sc = cur(); if (sc?.state === 'running' && !sc.steps.length && !/could not be decrypted|^⚠/i.test(x[2])) sc.error = sc.error ? `${sc.error}\n${x[2]}`.slice(0, 2000) : x[2]; }
            continue;
        }
        if (/^\[FEATURE\] Feature completed/.test(l) || /^\[INFO\] Test execution completed/.test(l)) endScenario(at, 'passed');
    }
    // A failed step ends its scenario as failed; steps after a failure did not run.
    for (const s of out) {
        const f = s.steps.findIndex((x) => x.state === 'failed');
        if (f >= 0 && s.state !== 'running') s.state = 'failed';
        if (!running && s.state === 'running' && s.error) { s.state = 'failed'; continue; }
        if (!running && s.state === 'running') { s.state = 'skipped'; for (const st of s.steps) if (st.state === 'running') st.state = 'skipped'; }
    }
    return out;
}

const ICON: Record<StepState, React.ReactNode> = {
    running: <LoadingOutlined style={{ color: '#1677ff' }} />, passed: <CheckCircleFilled style={{ color: '#2e7d32' }} />,
    failed: <CloseCircleFilled style={{ color: '#c62828' }} />, skipped: <MinusCircleOutlined style={{ color: '#999' }} />,
};
const dur = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function StepTimeline({ log, running }: { log: LogLine[]; running: boolean }) {
    const all = React.useMemo(() => parseTimeline(log, running), [log, running]);
    const bottom = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => { if (running) bottom.current?.scrollIntoView({ block: 'nearest' }); }, [all, running]);
    if (!all.length) return <Empty style={{ marginTop: 40 }} description={running ? 'Waiting for the first scenario…' : 'No steps in this run\'s output.'} />;
    // Counted once per scenario: its last attempt (a retried scenario is one scenario).
    const last = [...new Map(all.map((s) => [`${s.feature}\u0000${s.name}`, s])).values()];
    const passed = last.filter((s) => s.state === 'passed').length, failed = last.filter((s) => s.state === 'failed').length, notRun = last.filter((s) => s.state === 'skipped').length;
    return (
        <div style={{ padding: '8px 12px', overflow: 'auto', flex: 1 }}>
            <Space size={8} style={{ marginBottom: 8 }}><Tag color="green">{passed} passed</Tag>{failed > 0 && <Tag color="red">{failed} failed</Tag>}{notRun > 0 && <Tag>{notRun} did not run</Tag>}{running && <Tag color="processing">running</Tag>}</Space>
            {all.map((s, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                    <Space size={6}>{ICON[s.state]}<Typography.Text strong>{s.name}</Typography.Text>{s.attempt > 1 && <Tag color="gold">retry {s.attempt - 1}</Tag>}<Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.feature}{s.ms !== undefined ? ` · ${dur(s.ms)}` : ''}</Typography.Text></Space>
                    <div style={{ marginLeft: 22, borderLeft: '1px solid rgba(127,127,127,.25)', paddingLeft: 10, marginTop: 2 }}>
                        {s.error && !s.steps.length && <div style={{ color: '#c62828', whiteSpace: 'pre-wrap', fontSize: 12 }}>{s.error.split('\n').slice(0, 4).join('\n')}</div>}
                        {!s.error && !s.steps.length && s.state === 'skipped' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>No step ran.</Typography.Text>}
                        {s.steps.map((st, j) => (
                            <div key={j} style={{ fontSize: 12.5, lineHeight: '20px' }}>
                                <Space size={6} align="start">{ICON[st.state]}<span className="mono">{st.text}</span>{st.ms !== undefined && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{dur(st.ms)}</Typography.Text>}</Space>
                                {st.error && <Tooltip title={st.error}><div style={{ color: '#c62828', marginLeft: 20, whiteSpace: 'pre-wrap', fontSize: 12 }}>{st.error.split('\n').slice(0, 3).join('\n')}</div></Tooltip>}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
            <div ref={bottom} />
        </div>
    );
}
