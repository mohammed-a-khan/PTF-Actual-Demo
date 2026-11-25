/**
 * Team trends on the Quality page: every test result the team published to Azure DevOps (pipelines, other people's
 * runs), read from Azure DevOps Analytics: daily pass rate, the tests that always fail, the flaky ones, and a
 * comparison with the period before, with one sentence a manager can read.
 */
import React from 'react';
import { Alert, Button, Card, Empty, Segmented, Select, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { CodeOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, TeamTrends as Trends, TeamTrendTest } from '../api';
import { errText } from '../state';
import { navigate } from '../route';
import { AdoNotSetUp, isAdoNotSetUp } from '../datagit-common';
import { LineChart } from './LineChart';

const pct = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${Math.round(n * 1000) / 10}%`);
const KIND = { failing: { color: 'error', label: 'Always fails', tip: 'Failed every time it ran in this period: most likely a real problem, or a test that no longer matches the application.' },
    flaky: { color: 'warning', label: 'Flaky', tip: 'Passed and failed in this period (or Azure DevOps marked it flaky): the result depends on luck, timing or data, so failures are hard to trust.' },
    stable: { color: 'success', label: 'Stable', tip: 'Passed every time it ran.' } } as const;
const STATUS = { green: 'success', amber: 'warning', red: 'error', none: 'info' } as const;

export function TeamTrends({ project, localScenario }: { project?: string; localScenario: (name: string) => { file: string; line?: number } | undefined }) {
    const [days, setDays] = React.useState(30);
    const [pipeline, setPipeline] = React.useState<string | undefined>();
    const [branch, setBranch] = React.useState<string | undefined>();
    const [workflow, setWorkflow] = React.useState<'all' | 'Build' | 'Release'>('all');
    const [kind, setKind] = React.useState<'all' | TeamTrendTest['kind']>('all');
    const [data, setData] = React.useState<Trends | null>(null);
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const load = React.useCallback(async () => {
        setLoading(true); setError('');
        try { setData(await api.teamTrends({ days, pipeline, branch, ...(workflow !== 'all' ? { workflow } : {}), ...(project ? { project } : {}) })); }
        catch (e) { setError(errText(e)); setData(null); } finally { setLoading(false); }
    }, [days, pipeline, branch, workflow, project]);
    React.useEffect(() => { void load(); }, [load]);
    const tests = (data?.tests ?? []).filter((t) => kind === 'all' || t.kind === kind);
    const count = (k: TeamTrendTest['kind']) => data?.tests.filter((t) => t.kind === k).length ?? 0;
    const delta = data && data.totals.passRate !== null && data.previous.passRate !== null ? data.totals.passRate - data.previous.passRate : null;
    return (
        <div style={{ padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Space wrap>
                <Segmented size="small" value={days} onChange={(v) => setDays(Number(v))} options={[{ value: 7, label: '7 days' }, { value: 14, label: '14 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }]} />
                <Select size="small" allowClear placeholder="All pipelines" style={{ width: 200 }} value={pipeline} onChange={setPipeline} options={(data?.options.pipelines ?? []).map((p) => ({ value: p, label: p }))} aria-label="Pipeline" />
                <Select size="small" allowClear placeholder="All branches" style={{ width: 180 }} value={branch} onChange={setBranch} options={(data?.options.branches ?? []).map((b) => ({ value: b, label: b }))} aria-label="Branch" />
                <Segmented size="small" value={workflow} onChange={(v) => setWorkflow(v as typeof workflow)} options={[{ value: 'all', label: 'All' }, { value: 'Build', label: 'Builds' }, { value: 'Release', label: 'Releases' }]} />
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} aria-label="Refresh team trends" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>From Azure DevOps Analytics: every result published by pipelines and other people.</Typography.Text>
            </Space>
            {error && (isAdoNotSetUp(error)
                ? <AdoNotSetUp what="Team results" error={error} onRetry={() => void load()} compact />
                : <Alert type="error" showIcon message="Could not read Azure DevOps Analytics" description={error} />)}
            {loading && !data && <Spin style={{ margin: 24 }} />}
            {data && <>
                <Alert type={STATUS[data.status]} showIcon message={<b>{data.status === 'green' ? 'Healthy' : data.status === 'amber' ? 'Needs attention' : data.status === 'red' ? 'Not healthy' : 'No results'}</b>} description={data.summary} />
                <div className="q-tiles">
                    <Tooltip title="Passed out of the results that passed or failed (not counting tests that did not run)."><div className="q-tile"><b>{pct(data.totals.passRate)}</b><span>Pass rate{delta !== null && Math.abs(delta) >= 0.01 && <Typography.Text type={delta > 0 ? 'success' : 'danger'} style={{ marginInlineStart: 6 }}>{delta > 0 ? '▲' : '▼'} {pct(Math.abs(delta))}</Typography.Text>}</span></div></Tooltip>
                    <div className="q-tile"><b>{data.totals.total}</b><span>Results</span></div>
                    <button className="q-tile q-failing" onClick={() => setKind('failing')}><b>{count('failing')}</b><span>Always fail</span></button>
                    <button className="q-tile q-flaky" onClick={() => setKind('flaky')}><b>{count('flaky')}</b><span>Flaky</span></button>
                    <Tooltip title="Results recorded as not run (skipped, blocked, not applicable)."><div className="q-tile"><b>{data.totals.notExecuted}</b><span>Not run</span></div></Tooltip>
                </div>
                <Card size="small" title={`Pass rate per day · ${data.from} to ${data.to}`}>
                    {data.totals.total ? <LineChart height={160} x={data.days.map((_, i) => i)} xMax={Math.max(1, data.days.length - 1)} xFormat={(v) => { const d = data.days[Math.round(v)]; return d && Math.abs(v - Math.round(v)) < 0.01 ? d.date.slice(5) : ''; }}
                        series={[{ name: 'Pass rate', color: '#1a7f37', values: data.days.map((d) => (d.passRate === null ? NaN : Math.round(d.passRate * 1000) / 10)), unit: '%', area: true },
                            { name: 'Failed', color: '#cf222e', values: data.days.map((d) => (d.total ? d.failed : NaN)), right: true }]} />
                        : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing published in this period" />}
                </Card>
                <Card size="small" title={<Space>Tests <Segmented size="small" value={kind} onChange={(v) => setKind(v as typeof kind)} options={[{ value: 'all', label: `All ${data.tests.length}` }, { value: 'failing', label: `Always fail ${count('failing')}` }, { value: 'flaky', label: `Flaky ${count('flaky')}` }, { value: 'stable', label: `Stable ${count('stable')}` }]} /></Space>} styles={{ body: { padding: 0 } }}>
                    <Table size="small" rowKey={(t) => `${t.container}\u0000${t.name}`} dataSource={tests} pagination={{ pageSize: 25, hideOnSinglePage: true }}
                        columns={[
                            { title: '', key: 'k', width: 120, render: (_, t) => <Tooltip title={KIND[t.kind].tip}><Tag color={KIND[t.kind].color}>{KIND[t.kind].label}</Tag></Tooltip> },
                            { title: 'Test', key: 'n', ellipsis: true, render: (_, t) => <div className="q-name"><span>{t.name}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{t.container}</Typography.Text></div> },
                            { title: 'Ran', dataIndex: 'total', width: 70, align: 'right' },
                            { title: 'Failed', dataIndex: 'failed', width: 70, align: 'right', render: (v: number) => v ? <Typography.Text type="danger">{v}</Typography.Text> : 0 },
                            { title: 'Fail rate', key: 'fr', width: 90, align: 'right', render: (_, t) => pct(t.failRate) },
                            { title: 'Last failed', key: 'lf', width: 110, render: (_, t) => t.lastFailed ?? '–' },
                            { title: 'Average', key: 'avg', width: 90, align: 'right', render: (_, t) => `${t.avgSec}s` },
                            { title: '', key: 'o', width: 80, render: (_, t) => { const l = localScenario(t.name); return l ? <Tooltip title="Open the scenario in this repository"><Button size="small" icon={<CodeOutlined />} onClick={() => navigate(['code', l.file, l.line ?? 1])} /></Tooltip> : null; } },
                        ]} />
                </Card>
            </>}
            {!data && !loading && !error && <Empty description="No data" />}
            {loading && data && <Spin size="small" />}
        </div>
    );
}
