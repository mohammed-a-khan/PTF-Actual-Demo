/**
 * Which commit broke a test: choose the failing scenario and a commit where it still passed; the Studio runs the
 * scenario on commits in between (in a separate copy: your files stay as they are) until it finds the first one where
 * it fails. Shown on the Runs page while it searches and with its answer.
 */
import React from 'react';
import { Alert, App, Button, Card, Form, Modal, Select, Space, Steps, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, MinusCircleOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { api, BisectInfo } from '../api';
import { errText } from '../state';
import { navigate } from '../route';

const short = (c: string) => c.slice(0, 8);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function BisectStart({ failed, project, env, browser, onClose, onStarted }: {
    failed: Array<{ name: string; file?: string }>; project: string; env: string; browser?: string;
    onClose: () => void; onStarted: (b: BisectInfo) => void;
}) {
    const { message } = App.useApp();
    const usable = failed.filter((f) => f.file);
    const [scenario, setScenario] = React.useState(usable[0]?.name ?? '');
    const [sug, setSug] = React.useState<Awaited<ReturnType<typeof api.bisectSuggest>> | null>(null);
    const [good, setGood] = React.useState<string | undefined>();
    const [range, setRange] = React.useState<{ commits: number; estimate: number } | null>(null);
    const [rangeError, setRangeError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        if (!scenario) return;
        setSug(null); setGood(undefined);
        void api.bisectSuggest(scenario).then((s) => { setSug(s); setGood(s.good); }).catch((e) => message.error(errText(e)));
    }, [scenario]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => {
        setRange(null); setRangeError('');
        if (good) void api.bisectRange(good).then(setRange).catch((e) => setRangeError(errText(e)));
    }, [good]);
    const start = async () => {
        const f = usable.find((x) => x.name === scenario);
        if (!f?.file || !good) return;
        setBusy(true);
        try { const r = await api.bisectStart({ feature: f.file, scenario, good, project, env, browser }); onStarted(r.bisect); }
        catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    const options = (sug?.commits ?? []).slice(1).map((c) => ({
        value: c.commit,
        label: <span>{c.commit === sug?.good && <Tag color="success" style={{ marginInlineEnd: 6 }}>last passed here</Tag>}<Typography.Text code>{short(c.commit)}</Typography.Text> {c.subject} <Typography.Text type="secondary">· {c.author} · {when(c.date)}</Typography.Text></span>,
        search: `${c.commit} ${c.subject} ${c.author}`,
    }));
    return (
        <Modal open width={720} title="Which commit broke it?" okText="Start the search" okButtonProps={{ icon: <SearchOutlined />, disabled: !good || !range || !scenario }} confirmLoading={busy} onOk={start} onCancel={onClose}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
                The scenario is run on commits between one where it passed and this one, halving the range each time, until the first commit where it fails is found. It runs in a separate copy of the repository: your branch and files stay as they are.
            </Typography.Paragraph>
            {!usable.length && <Alert type="warning" showIcon message="The run's report does not say which feature file the failed scenarios are in, so they cannot be searched." />}
            <Form layout="vertical">
                <Form.Item label="Failing scenario" htmlFor="cs-bisect-scenario">
                    <Select id="cs-bisect-scenario" value={scenario || undefined} onChange={setScenario} options={usable.map((f) => ({ value: f.name, label: <span>{f.name} <Typography.Text type="secondary">· {f.file}</Typography.Text></span> }))} />
                </Form.Item>
                <Form.Item label="A commit where it passed" htmlFor="cs-bisect-good"
                    extra={sug && !sug.good ? 'No earlier run of this scenario passed on a commit of this branch: pick one where you know it worked.' : sug?.goodRun ? `From the run of ${when(sug.goodRun.at)}.` : undefined}>
                    <Select id="cs-bisect-good" showSearch loading={!sug} value={good} onChange={setGood} placeholder="Choose a commit" options={options}
                        filterOption={(input, o) => String((o as { search?: string }).search ?? '').toLowerCase().includes(input.toLowerCase())} />
                </Form.Item>
            </Form>
            {sug?.warning && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={sug.warning} />}
            {rangeError && <Alert type="error" showIcon message={rangeError} />}
            {range && <Alert type="info" showIcon message={<span><b>{range.commits}</b> commit{range.commits === 1 ? '' : 's'} to search: about <b>{range.estimate}</b> runs of the scenario (the first two check that it passes at the good commit and fails at this one).</span>} />}
        </Modal>
    );
}

const ICON = { pass: <CheckCircleOutlined style={{ color: 'var(--ant-color-success, #52c41a)' }} />, fail: <CloseCircleOutlined style={{ color: 'var(--ant-color-error, #ff4d4f)' }} />, skip: <MinusCircleOutlined style={{ color: '#999' }} /> };
const WORD = { pass: 'passed', fail: 'failed', skip: 'could not run' };

/** The search: its steps as they run, and its answer. */
export function BisectPanel({ value, onChange, onOpenRun }: { value: BisectInfo; onChange: (b: BisectInfo | null) => void; onOpenRun: (id: string) => void }) {
    const { message } = App.useApp();
    React.useEffect(() => {
        if (value.state !== 'running') return;
        const t = setInterval(() => { void api.bisect().then((r) => r.bisect && onChange(r.bisect)).catch(() => undefined); }, 2000);
        return () => clearInterval(t);
    }, [value.state]); // eslint-disable-line react-hooks/exhaustive-deps
    const done = value.steps.length;
    const commitLink = (c: string) => <Typography.Link code onClick={() => navigate(['git', 'history', c])}>{short(c)}</Typography.Link>;
    return (
        <Card size="small" title={<Space><SearchOutlined /><span>Which commit broke <Typography.Text strong>“{value.scenario}”</Typography.Text></span></Space>}
            extra={value.state === 'running'
                ? <Button size="small" danger icon={<StopOutlined />} onClick={() => void api.bisectStop().then((r) => r.bisect && onChange(r.bisect)).catch((e) => message.error(errText(e)))}>Stop</Button>
                : <Button size="small" onClick={() => onChange(null)}>Close</Button>}>
            {value.state === 'found' && value.result && (
                <Alert type="error" showIcon style={{ marginBottom: 10 }}
                    message={<span>It broke in {commitLink(value.result.commit)} <b>{value.result.subject}</b></span>}
                    description={<>
                        <div>{value.result.author} · {when(value.result.date)} · the scenario passes at the commit before it and fails from this one on.</div>
                        {value.result.files.length > 0 && <div style={{ marginTop: 4 }}>Changed: {value.result.files.slice(0, 12).map((f) => <Tag key={f} style={{ marginBlock: 2 }}>{f}</Tag>)}{value.result.files.length > 12 && <Typography.Text type="secondary">and {value.result.files.length - 12} more</Typography.Text>}</div>}
                    </>}
                    action={<Button size="small" type="primary" onClick={() => navigate(['git', 'history', value.result!.commit])}>Open the commit</Button>} />
            )}
            {value.state === 'inconclusive' && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message={value.message}
                description={value.candidates && <ul style={{ margin: 0, paddingInlineStart: 18 }}>{value.candidates.map((c) => <li key={c.commit}>{commitLink(c.commit)} {c.subject}</li>)}</ul>} />}
            {(value.state === 'error' || value.state === 'stopped') && <Alert type={value.state === 'error' ? 'error' : 'info'} showIcon style={{ marginBottom: 10 }} message={value.state === 'stopped' ? 'Stopped.' : value.message} />}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {value.commits} commit{value.commits === 1 ? '' : 's'} between {commitLink(value.good)} and {commitLink(value.bad)} · {done} of about {value.estimate} runs{value.state === 'running' ? '' : ' done'}
            </Typography.Text>
            <Steps direction="vertical" size="small" style={{ marginTop: 8 }} current={done}
                items={[
                    ...value.steps.map((st) => ({
                        status: (st.outcome === 'fail' ? 'error' : 'finish') as 'error' | 'finish',
                        icon: ICON[st.outcome],
                        title: <span>{commitLink(st.commit)} {st.subject} {st.end && <Tag style={{ marginInlineStart: 6 }}>{st.end === 'good' ? 'should pass' : 'should fail'}</Tag>}</span>,
                        description: <span>{WORD[st.outcome]}{st.note ? <Tooltip title={st.note}><Typography.Text type="secondary"> · {st.note.length > 90 ? `${st.note.slice(0, 90)}…` : st.note}</Typography.Text></Tooltip> : null}
                            {st.run && <Typography.Link style={{ marginInlineStart: 8 }} onClick={() => onOpenRun(st.run!)}>run</Typography.Link>}</span>,
                    })),
                    ...(value.current ? [{ status: 'process' as const, icon: <LoadingOutlined />, title: <span>{commitLink(value.current.commit)} {value.current.subject}</span>, description: 'running the scenario…' }] : []),
                ]} />
        </Card>
    );
}
