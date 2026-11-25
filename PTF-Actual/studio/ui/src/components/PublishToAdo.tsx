/**
 * A finished run's results published to Azure DevOps Test Plans: a test run on the test points of the scenarios'
 * @TestCaseId, in the plan and suite each scenario publishes to (or one chosen here). Preview first, then publish.
 */
import React from 'react';
import { Alert, App, Button, Modal, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import { api, PublishPreviewDef, RunInfo, TestPlanDef, TestSuiteDef } from '../api';
import { errText } from '../state';

export function PublishToAdo({ run, open, onClose }: { run: RunInfo; open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [plans, setPlans] = React.useState<TestPlanDef[] | null>(null);
    const [suites, setSuites] = React.useState<TestSuiteDef[]>([]);
    const [plan, setPlan] = React.useState<number | undefined>(undefined);
    const [suite, setSuite] = React.useState<number | undefined>(undefined);
    const [preview, setPreview] = React.useState<PublishPreviewDef | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const scope = { project: run.request.project, env: run.request.env };
    React.useEffect(() => { if (open) api.testPlans(scope).then((r) => setPlans(r.plans)).catch((e) => { setPlans([]); setErr(errText(e)); }); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { setSuite(undefined); setSuites([]); if (plan) api.testSuites(plan, scope).then((r) => setSuites(r.suites)).catch((e) => setErr(errText(e))); }, [plan]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => {
        if (!open) return;
        setPreview(null);
        api.publishRunPreview(run.id, plan && suite ? { plan, suite } : {}).then(setPreview).catch((e) => setErr(errText(e)));
    }, [open, run.id, plan, suite]);
    const publish = async () => {
        setBusy(true); setErr(null);
        try {
            const r = await api.publishRun(run.id, plan && suite ? { plan, suite } : {});
            setPreview(r);
            message.success(`Published ${r.published?.reduce((n, x) => n + x.published, 0) ?? 0} result(s) to Azure DevOps`);
        } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };
    const count = preview?.groups.reduce((n, g) => n + g.results.length, 0) ?? 0;
    return (
        <Modal open={open} onCancel={onClose} width={860} title={<Space><CloudUploadOutlined />Publish these results to Azure DevOps Test Plans</Space>}
            footer={<Space><Button onClick={onClose}>Close</Button>{!preview?.published && <Button type="primary" loading={busy} disabled={!count} onClick={() => void publish()}>Publish {count} result{count === 1 ? '' : 's'}</Button>}</Space>}>
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <Typography.Text type="secondary">Each scenario's result goes to the test points of its <Typography.Text code>@TestCaseId</Typography.Text> in the plan and suite it publishes to (its tags or ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID), as the framework does in the pipeline. Or choose one plan and suite for all:</Typography.Text>
                <Space wrap>
                    <Select style={{ width: 320 }} allowClear loading={plans === null} placeholder="As the scenarios say" value={plan} onChange={setPlan} aria-label="Test plan"
                        options={(plans ?? []).map((p) => ({ value: p.id, label: `${p.id} · ${p.name}` }))} showSearch optionFilterProp="label" />
                    <Select style={{ width: 280 }} allowClear disabled={!plan} placeholder="Suite" value={suite} onChange={setSuite} aria-label="Test suite"
                        options={suites.map((s) => ({ value: s.id, label: `${s.id} · ${s.name}` }))} showSearch optionFilterProp="label" />
                </Space>
                {err && <Alert type="error" showIcon message={err} />}
                {!preview ? <Spin /> : <>
                    {preview.published?.map((p) => <Alert key={p.runId} type="success" showIcon message={<span>Test run {p.runId}: {p.published} result{p.published === 1 ? '' : 's'} in plan {p.plan}, suite {p.suite}. <a href={p.url} target="_blank" rel="noreferrer">Open in Azure DevOps</a></span>}
                        description={p.missing.length ? `Test cases not in that suite (not published): ${p.missing.join(', ')}` : undefined} />)}
                    {preview.groups.map((g) => (
                        <div key={`${g.plan}/${g.suite}`}>
                            <Typography.Text strong>Plan {g.plan}, suite {g.suite}</Typography.Text> <Typography.Text type="secondary">· {g.testCases} test case{g.testCases === 1 ? '' : 's'}</Typography.Text>
                            <Table size="small" rowKey={(_, i) => String(i)} pagination={g.results.length > 10 ? { pageSize: 10 } : false} dataSource={g.results}
                                columns={[{ title: 'Test case', dataIndex: 'testCase', width: 100 }, { title: 'Outcome', dataIndex: 'outcome', width: 110, render: (o: string) => <Tag color={o === 'Passed' ? 'green' : o === 'Failed' ? 'red' : 'default'}>{o}</Tag> }, { title: 'Scenario', dataIndex: 'scenario' }]} />
                        </div>))}
                    {!preview.groups.length && <Alert type="info" showIcon message={preview.noPlan.length ? 'Choose the test plan and suite to publish to.' : 'None of the scenarios that ran has a @TestCaseId tag.'} />}
                    {preview.noPlan.length > 0 && <Alert type="warning" showIcon message={`${preview.noPlan.length} scenario(s) have test cases but no plan and suite: choose them above.`} />}
                    {preview.notLinked.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Not linked to a test case (not published): {preview.notLinked.slice(0, 8).join(' · ')}{preview.notLinked.length > 8 ? ` … ${preview.notLinked.length - 8} more` : ''}</Typography.Text>}
                </>}
            </Space>
        </Modal>
    );
}
