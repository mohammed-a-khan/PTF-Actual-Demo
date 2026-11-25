/**
 * Results of a run as the framework executed them: Feature → Scenario → Step → Actions.
 * Failed scenarios open automatically, on their Steps tab with the failed step expanded.
 * Steps that never ran (after a failure) are listed greyed out, taken from the feature file.
 */
import React from 'react';
import { Button, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, DownOutlined, ExclamationCircleFilled, FileSearchOutlined, InfoCircleOutlined, MinusCircleOutlined, RightOutlined, WarningFilled } from '@ant-design/icons';
import type { RunEvidence, ScenarioEvidence, ScenarioResult, StepAction, StepDetail, TriageEntry } from '../api';
import { api } from '../api';
import { ScenarioEvidenceView } from './Evidence';
import { Ansi } from './Ansi';

export const fmtDur = (ms?: number) => ms === undefined ? '' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s`
    : ms < 3600000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`
    : ms < 86400000 ? `${Math.floor(ms / 3600000)} h ${Math.round((ms % 3600000) / 60000)} min`
    : `${Math.floor(ms / 86400000)} d ${Math.round((ms % 86400000) / 3600000)} h`;

const KNOWN: Record<string, string> = { 'product-bug': 'product bug', 'test-issue': 'test issue', environment: 'environment', flaky: 'flaky', expected: 'expected' };
const isFail = (st: string) => st === 'failed' || st === 'broken';

export function StatusIcon({ status, size = 14 }: { status: string; size?: number }) {
    const style = { fontSize: size };
    if (status === 'passed') return <CheckCircleFilled style={{ ...style, color: '#389e0d' }} />;
    if (isFail(status)) return <CloseCircleFilled style={{ ...style, color: '#cf1322' }} />;
    if (status === 'not run') return <Tooltip title="Did not run (a step before it failed)"><MinusCircleOutlined style={{ ...style, color: 'var(--muted, #aaa)' }} /></Tooltip>;
    return <Tooltip title={status}><ExclamationCircleFilled style={{ ...style, color: '#d48806' }} /></Tooltip>;
}

function ActionRow({ a }: { a: StepAction }) {
    const icon = a.kind === 'pass' ? <CheckCircleFilled style={{ color: '#389e0d' }} />
        : a.kind === 'fail' ? <CloseCircleFilled style={{ color: '#cf1322' }} />
        : a.kind === 'warn' ? <WarningFilled style={{ color: '#d48806' }} />
        : <InfoCircleOutlined style={{ color: 'var(--muted, #888)' }} />;
    return (
        <div className="run-action">
            <span className="run-action-icon">{icon}</span>
            <span className={`run-action-text${a.kind === 'fail' ? ' fail' : ''}`}>{a.text}</span>
            {a.durationMs !== undefined && <span className="run-dur">{fmtDur(a.durationMs)}</span>}
        </div>
    );
}

function StepRow({ st, open, onToggle }: { st: StepDetail; open: boolean; onToggle: () => void }) {
    const m = /^(Given|When|Then|And|But|\*)\s+(.*)$/.exec(st.text);
    const expandable = st.actions.length > 0 || !!st.error;
    return (
        <div className={`run-step${st.status === 'not run' ? ' not-run' : ''}${isFail(st.status) ? ' failed' : ''}`}>
            <div className="run-step-head" onClick={expandable ? onToggle : undefined} style={{ cursor: expandable ? 'pointer' : 'default' }}>
                <span className="run-caret">{expandable ? (open ? <DownOutlined /> : <RightOutlined />) : null}</span>
                <StatusIcon status={st.status} />
                <span className="run-step-text">{m ? <><b>{m[1]}</b> {m[2]}</> : st.text}</span>
                {expandable && !open && st.actions.length > 0 && <span className="run-count">{st.actions.length} action{st.actions.length === 1 ? '' : 's'}</span>}
                <span className="run-dur">{fmtDur(st.durationMs)}</span>
            </div>
            {open && <div className="run-step-body">
                {st.error && <pre className="mono run-error"><Ansi text={st.error} /></pre>}
                {st.actions.map((a, i) => <ActionRow key={i} a={a} />)}
                {!st.actions.length && !st.error && <Typography.Text type="secondary" style={{ fontSize: 12 }}>No actions were recorded for this step.</Typography.Text>}
            </div>}
        </div>
    );
}

export function StepsView({ ev }: { ev: ScenarioEvidence }) {
    const [open, setOpen] = React.useState<Set<number>>(() => new Set(ev.steps.map((s, i) => (isFail(s.status) ? i : -1)).filter((i) => i >= 0)));
    if (!ev.steps.length) return <Typography.Text type="secondary">The report has no steps for this scenario.</Typography.Text>;
    const ran = ev.steps.filter((s) => s.status !== 'not run').length;
    const notRun = ev.steps.length - ran;
    return (
        <div>
            <Space size={8} style={{ marginBottom: 6 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {ran} of {ev.steps.length} steps ran{notRun ? ` · ${notRun} did not run after the failure` : ''}
                </Typography.Text>
                <Button size="small" type="link" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={() => setOpen(new Set(ev.steps.map((_, i) => i)))}>Expand all</Button>
                <Button size="small" type="link" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={() => setOpen(new Set())}>Collapse all</Button>
            </Space>
            {ev.steps.map((st, i) => <StepRow key={i} st={st} open={open.has(i)} onToggle={() => setOpen((o) => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />)}
        </div>
    );
}

type Row = ScenarioResult & { _i: number };

export function RunTree({ runId, reportKey, scenarios, ev, onOpenScenario, base }: {
    runId: string; reportKey?: string; scenarios: ScenarioResult[]; ev: Pick<RunEvidence, 'scenarios' | 'hasPlaywright'> | null;
    onOpenScenario: (sc: ScenarioResult, ev?: ScenarioEvidence) => void;
    /** Pipeline results: files are served from here (instead of the local run's report route). */
    base?: string;
}) {
    const rows: Row[] = scenarios.map((s, _i) => ({ ...s, _i }));
    const features = React.useMemo(() => {
        const m = new Map<string, Row[]>();
        for (const r of rows) { const k = r.feature || '(no feature name)'; if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
        // Features with failures first, then in run order.
        return [...m.entries()].sort((a, b) => Number(b[1].some((r) => isFail(r.status))) - Number(a[1].some((r) => isFail(r.status))));
    }, [scenarios]); // eslint-disable-line react-hooks/exhaustive-deps
    const evFor = (r: Row) => ev ? (ev.scenarios[r._i] && ev.scenarios[r._i].name === r.name ? ev.scenarios[r._i] : ev.scenarios.find((x) => x.name === r.name && x.feature === r.feature)) : undefined;

    const [openFeatures, setOpenFeatures] = React.useState<Set<string>>(new Set());
    const [openScenarios, setOpenScenarios] = React.useState<Set<number>>(new Set());
    // When the details arrive: open features (all when there are few) and the first failed scenarios.
    React.useEffect(() => {
        const failed = rows.filter((r) => isFail(r.status));
        setOpenFeatures(new Set(features.length <= 3 ? features.map(([f]) => f) : failed.map((r) => r.feature || '(no feature name)')));
        setOpenScenarios(new Set(ev ? failed.slice(0, 3).map((r) => r._i) : []));
    // Only when another run or its details arrive: a new list of the same run (the screen redrawn) keeps what the person opened.
    }, [runId, !!ev, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

    // Failures the team already triaged (Quality, failure causes): the same cause shows its verdict and bug.
    const [known, setKnown] = React.useState<Map<number, TriageEntry>>(new Map());
    React.useEffect(() => {
        // Another run: nothing of the one before stays while its matches are read.
        setKnown(new Map());
        const failed = rows.filter((r) => isFail(r.status) && r.error);
        if (!failed.length) return;
        let live = true;
        api.triageMatch(failed.map((r) => r.error!)).then((res) => {
            if (!live) return;
            const m = new Map<number, TriageEntry>();
            res.matches.forEach((e, i) => { if (e) m.set(failed[i]._i, e); });
            setKnown(m);
        }).catch(() => undefined);
        return () => { live = false; };
    }, [scenarios]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No scenarios in the report." />;
    const toggle = <T,>(set: React.Dispatch<React.SetStateAction<Set<T>>>, k: T) => set((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });

    return (
        <div className="run-tree">
            {features.map(([feature, list]) => {
                const passed = list.filter((r) => r.status === 'passed').length;
                const failed = list.filter((r) => isFail(r.status)).length;
                const other = list.length - passed - failed;
                const fOpen = openFeatures.has(feature);
                return (
                    <div key={feature} className="run-feature">
                        <div className="run-feature-head" onClick={() => toggle(setOpenFeatures, feature)}>
                            <span className="run-caret">{fOpen ? <DownOutlined /> : <RightOutlined />}</span>
                            <StatusIcon status={failed ? 'failed' : other ? 'skipped' : 'passed'} size={15} />
                            <span className="run-feature-name">Feature: {feature}</span>
                            <Space size={4} className="run-counts">
                                {passed > 0 && <Tag color="success">{passed} passed</Tag>}
                                {failed > 0 && <Tag color="error">{failed} failed</Tag>}
                                {other > 0 && <Tag>{other} other</Tag>}
                            </Space>
                            <span className="run-dur">{fmtDur(list.reduce((t, r) => t + (r.duration || 0), 0))}</span>
                        </div>
                        {fOpen && list.map((r) => {
                            const se = evFor(r);
                            const sOpen = openScenarios.has(r._i);
                            return (
                                <div key={r._i} className={`run-scenario${isFail(r.status) ? ' failed' : ''}`}>
                                    <div className="run-scenario-head" onClick={() => toggle(setOpenScenarios, r._i)}>
                                        <span className="run-caret">{sOpen ? <DownOutlined /> : <RightOutlined />}</span>
                                        <StatusIcon status={r.status} />
                                        <span className="run-scenario-name">{r.name}</span>
                                        {known.get(r._i) && (() => { const k = known.get(r._i)!; return (
                                            <Tooltip title={<>Triaged{k.by ? ` by ${k.by}` : ''}{k.at ? ` on ${new Date(k.at).toLocaleDateString()}` : ''}{k.note ? <>: {k.note}</> : ''}</>}>
                                                <Tag color="purple" style={{ marginInlineEnd: 0 }}>Known: {KNOWN[k.verdict ?? ''] ?? 'triaged'}{k.bug ? ` · bug ${k.bug}` : ''}</Tag>
                                            </Tooltip>); })()}
                                        {!!r.retries && <Tooltip title={r.flaky ? `It failed ${r.retries === 1 ? 'once' : `${r.retries} times`} and passed when the framework ran it again (RETRY_COUNT): flaky, look at why.` : `The framework ran it ${r.retries + 1} times (RETRY_COUNT); every attempt failed.`}>
                                            <Tag color={r.flaky ? 'warning' : 'default'} style={{ marginInlineEnd: 0 }}>{r.flaky ? `passed after ${r.retries} retr${r.retries === 1 ? 'y' : 'ies'}` : `${r.retries + 1} attempts`}</Tag></Tooltip>}
                                        {!sOpen && r.error && <Typography.Text type="danger" className="mono run-scenario-err" ellipsis>{r.error}</Typography.Text>}
                                        {se && <span className="run-count">{se.steps.filter((s) => s.status !== 'not run').length}/{se.steps.length} steps</span>}
                                        <Tooltip title="Open in the editor"><Button aria-label="Open in the editor" size="small" type="text" icon={<FileSearchOutlined />} onClick={(e) => { e.stopPropagation(); onOpenScenario(r, se); }} /></Tooltip>
                                        <span className="run-dur">{fmtDur(r.duration)}</span>
                                    </div>
                                    {sOpen && <div className="run-scenario-body">
                                        {se && (reportKey || base)
                                            ? <ScenarioEvidenceView runId={runId} reportKey={reportKey ?? ''} ev={se} hasPlaywright={ev!.hasPlaywright} base={base} />
                                            : <Typography.Text type="secondary">{ev ? 'No details for this scenario in the report.' : 'Loading details…'}</Typography.Text>}
                                    </div>}
                                </div>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
}
