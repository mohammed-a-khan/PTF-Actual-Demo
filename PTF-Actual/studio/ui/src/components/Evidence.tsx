/**
 * Failure evidence of a scenario: the failed step and its error, the screenshot taken when it
 * failed, and the run's traces and videos. Files are served by the Studio from the run's results
 * folder (the same files the framework's HTML report shows).
 */
import React from 'react';
import { App, Button, Image, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DownloadOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { api, EvidenceFile, ScenarioEvidence } from '../api';
import { errText } from '../state';
import { Ansi } from './Ansi';
import { StepsView } from './RunTree';
import { useKept } from '../kept';
import '../styles-tests.css';

/** URL of an evidence file: a local run's report route, or `base` (pipeline results) when given. */
export const evidenceUrl = (runId: string, key: string, f: EvidenceFile, base?: string) =>
    `${base ?? `/report/${encodeURIComponent(runId)}/${encodeURIComponent(key)}`}/${f.file.split('/').map(encodeURIComponent).join('/')}`;

/**
 * In the user's own time format, as the run list shows times (1:24:53.229 PM, or 13:24:53.229): the milliseconds
 * tell apart files saved in the same second.
 */
const time = (f: EvidenceFile) => {
    if (!f.time) return '';
    return new Date(f.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
};
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function TraceButtons({ runId, reportKey, f, hasPlaywright, base }: { runId: string; reportKey: string; f: EvidenceFile; hasPlaywright: boolean; base?: string }) {
    const { message } = App.useApp();
    return (
        <Space size={4}>
            {!base && <Tooltip title={hasPlaywright ? 'Opens Playwright’s Trace Viewer (from this project) in its own window: every action, with DOM snapshots, network and console.' : 'Playwright was not found in this project’s node_modules; download the trace instead.'}>
                <Button size="small" icon={<PlayCircleOutlined />} disabled={!hasPlaywright}
                    onClick={async () => { try { await api.openTrace(runId, f.file); message.success('Opening the Trace Viewer…'); } catch (e) { message.error(errText(e)); } }}>Open trace</Button>
            </Tooltip>}
            <Button size="small" type="text" icon={<DownloadOutlined />} href={evidenceUrl(runId, reportKey, f, base)} download={f.name}>{size(f.size)}</Button>
        </Space>
    );
}

export function ScenarioEvidenceView({ runId, reportKey, ev, hasPlaywright, base }: { runId: string; reportKey: string; ev: ScenarioEvidence; hasPlaywright: boolean; base?: string }) {
    const [evTab, setEvTab] = useKept<string>('evidence.tab', '');
    const traces = ev.files.filter((f) => f.kind === 'trace');
    const videos = ev.files.filter((f) => f.kind === 'video');
    const shot = ev.failedStep?.screenshot;
    const count = (n: number) => <Tag style={{ marginInlineStart: 6, marginInlineEnd: 0 }}>{n}</Tag>;
    // One kind of evidence per tab; tabs without anything to show are left out.
    type Item = { key: string; label: React.ReactNode; children: React.ReactNode };
    const items = ([
        // Every step that ran (and the ones that did not), each with the actions it performed.
        ev.steps.length > 0 && {
            key: 'steps', label: <span>Steps{count(ev.steps.length)}</span>,
            children: <StepsView ev={ev} />,
        },
        ev.failedStep && {
            key: 'error', label: 'Error',
            children: <Space direction="vertical" size={6} style={{ display: 'flex' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Failed step</Typography.Text>
                <Typography.Text strong className="mono">{ev.failedStep.name}</Typography.Text>
                {ev.failedStep.error
                    ? <pre className="mono run-error" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 220, overflow: 'auto' }}><Ansi text={ev.failedStep.error} /></pre>
                    : <Typography.Text type="secondary">The report has no error text for this step.</Typography.Text>}
            </Space>,
        },
        shot && {
            key: 'screenshot', label: 'Screenshot',
            children: <Space direction="vertical" size={4}>
                <Image src={evidenceUrl(runId, reportKey, shot, base)} width={520} alt="Screenshot when the step failed" style={{ border: '1px solid var(--panel-border)', borderRadius: 4 }} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Taken when the step failed{shot.time ? `, ${time(shot)}` : ''}. Click to enlarge.</Typography.Text>
            </Space>,
        },
        traces.length > 0 && {
            key: 'traces', label: <span>Traces{count(traces.length)}</span>,
            children: <Space direction="vertical" size={6} style={{ display: 'flex' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <Tooltip title="A trace replays every action with page snapshots, network and console.">{traces.length > 1 ? `${traces.length} traces (the scenario was retried): the largest usually has the most to replay.` : 'Replays every action with page snapshots, network and console.'}</Tooltip>
                    {ev.matchedByTime && <Tooltip title="The framework lists traces for the whole run; these were saved while this scenario ran."> <Tag>matched by time</Tag></Tooltip>}
                </Typography.Text>
                {traces.map((t) => <Space key={t.file} size={10}>
                    <Tooltip title={t.name}><Typography.Text className="mono" style={{ fontSize: 12 }}>Saved {time(t)}</Typography.Text></Tooltip>
                    <TraceButtons runId={runId} reportKey={reportKey} f={t} hasPlaywright={hasPlaywright} base={base} />
                </Space>)}
            </Space>,
        },
        videos.length > 0 && {
            key: 'video', label: <span>Video{videos.length > 1 ? count(videos.length) : null}</span>,
            children: <Space direction="vertical" size={8}>
                {videos.map((v) => <Space key={v.file} direction="vertical" size={2}>
                    <video src={evidenceUrl(runId, reportKey, v, base)} controls preload="metadata" style={{ maxWidth: 640, borderRadius: 4 }} />
                    <Space size={8}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v.name}</Typography.Text>
                        <Button size="small" type="text" icon={<DownloadOutlined />} href={evidenceUrl(runId, reportKey, v, base)} download={v.name}>{size(v.size)}</Button>
                        {ev.matchedByTime && <Tooltip title="The framework lists videos for the whole run; this one was saved while this scenario ran."><Tag>matched by time</Tag></Tooltip>}
                    </Space>
                </Space>)}
            </Space>,
        },
    ] as Array<Item | false | undefined | null | ''>).filter((x): x is Item => !!x);

    if (!items.length) {
        return <Tooltip title="The framework settings BROWSER_VIDEO and TRACE_CAPTURE_MODE control them (e.g. retain-on-failure, on-failure)."><Typography.Text type="secondary" style={{ fontSize: 12 }}>
            No steps, error, screenshot, trace or video were recorded for this scenario.
        </Typography.Text></Tooltip>;
    }
    const active = items.some((x) => x.key === evTab) ? evTab : items[0].key;
    return <div className="evidence"><Tabs size="small" items={items} activeKey={active} onChange={setEvTab} destroyInactiveTabPane={false} /></div>;
}

/** Everything the run saved that is not shown with a scenario (videos, console logs, other traces). */
export function RunEvidenceList({ runId, reportKey, files, hasPlaywright, base }: { runId: string; reportKey: string; files: EvidenceFile[]; hasPlaywright: boolean; base?: string }) {
    const [playing, setPlaying] = React.useState<string | null>(null);
    if (!files.length) return null;
    const label: Record<EvidenceFile['kind'], string> = { screenshot: 'Screenshot', video: 'Video', trace: 'Trace', console: 'Console log', har: 'Network (HAR)' };
    return (
        <Space direction="vertical" size={2} style={{ display: 'flex', padding: '6px 12px' }}>
            {files.map((f) => <Space key={f.file} size={8} wrap style={{ alignItems: 'center' }}>
                <Tag>{label[f.kind]}</Tag>
                <Typography.Link className="mono" style={{ fontSize: 12 }} href={evidenceUrl(runId, reportKey, f, base)} target="_blank" rel="noreferrer">{f.name}</Typography.Link>
                {f.kind === 'trace' && <TraceButtons runId={runId} reportKey={reportKey} f={f} hasPlaywright={hasPlaywright} base={base} />}
                {f.kind !== 'trace' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{size(f.size)}</Typography.Text>}
                {f.kind === 'video' && <Button size="small" icon={<PlayCircleOutlined />} onClick={() => setPlaying(playing === f.file ? null : f.file)}>{playing === f.file ? 'Hide' : 'Play'}</Button>}
                {f.kind === 'screenshot' && <Image src={evidenceUrl(runId, reportKey, f, base)} height={28} alt={f.name} style={{ border: '1px solid var(--panel-border)', borderRadius: 2 }} />}
                {playing === f.file && <video src={evidenceUrl(runId, reportKey, f, base)} controls autoPlay preload="metadata" style={{ display: 'block', maxWidth: 640, borderRadius: 4 }} />}
            </Space>)}
        </Space>
    );
}
