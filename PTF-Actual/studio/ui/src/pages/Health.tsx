/** Health check: what a test run needs on this computer and in this repository, with a fix where the Studio has one. */
import React from 'react';
import { Alert, App, Button, Card, Col, Empty, Form, Row, Select, Space, Spin, Tabs, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled, InfoCircleFilled, ReloadOutlined } from '@ant-design/icons';
import { api, DoctorDef } from '../api';
import { errText } from '../state';
import { useKept } from '../kept';
import { navigate, useRoute } from '../route';
import '../styles-tests.css';

const ICON = { ok: <CheckCircleFilled style={{ color: '#2e7d32' }} />, warning: <ExclamationCircleFilled style={{ color: '#d48806' }} />, error: <CloseCircleFilled style={{ color: '#c62828' }} />, info: <InfoCircleFilled style={{ color: '#1677ff' }} /> };
type Check = DoctorDef['checks'][number];
const TAB_KEY = 'cs-studio-health-tab';

/** A long detail made of several findings ("A · B · C"): the first one, then the rest as a list on demand. */
function Detail({ text }: { text: string }) {
    const [all, setAll] = React.useState(false);
    const parts = text.split(/ · (?=[A-Z_][A-Z0-9_]*:)/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) return <div className="tests-check-detail">{text}</div>;
    return (
        <div className="tests-check-detail">
            <ul>{(all ? parts : parts.slice(0, 1)).map((p, i) => <li key={i}>{p}</li>)}</ul>
            <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `${parts.length - 1} more`}</Button>
        </div>
    );
}

function CheckRow({ c, fixing, onFix }: { c: Check; fixing: string | null; onFix: (action: string) => void }) {
    return (
        <div className="tests-check">
            <span className="tests-check-icon">{ICON[c.level]}</span>
            <div className="tests-check-body">
                <div className="tests-check-title">{c.title}</div>
                <Detail text={c.detail} />
            </div>
            {c.fix && <Button size="small" loading={fixing === c.fix.action} disabled={!!fixing && fixing !== c.fix.action} onClick={() => onFix(c.fix!.action)}>{c.fix.label}</Button>}
        </div>
    );
}

export function Health() {
    const { message } = App.useApp();
    const [d, setD] = React.useState<DoctorDef | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [fixing, setFixing] = React.useState<string | null>(null);
    const [target, setTarget] = useKept<{ project?: string; env?: string }>('health.target', {});
    // The tab is in the address (#/health/<tab>), so a link opens it; without one, the tab used last.
    const route = useRoute();
    const [savedTab, setTabRaw] = React.useState<string>(() => { try { return localStorage.getItem(TAB_KEY) ?? 'problems'; } catch { return 'problems'; } });
    const tab = route[0] === 'health' && route[1] ? route[1] : savedTab;
    const setTab = (k: string) => { setTabRaw(k); try { localStorage.setItem(TAB_KEY, k); } catch { /* private mode */ } navigate(['health', k], true); };
    const load = React.useCallback((t: { project?: string; env?: string }) => {
        setLoading(true); setErr(null);
        api.doctor(t).then((r) => { setD(r); setTarget({ project: r.project, env: r.env }); }).catch((e) => setErr(errText(e))).finally(() => setLoading(false));
    }, []);
    React.useEffect(() => { load({}); }, [load]);
    const fix = async (action: string) => {
        if (fixing) return;
        setFixing(action);
        try { const r = await api.doctorFix(action); message.success(r.done); load(target); } catch (e) { message.error(errText(e)); } finally { setFixing(null); }
    };
    const checks = d?.checks ?? [];
    const groups = [...new Set(checks.map((c) => c.group))];
    const bad = checks.filter((c) => c.level === 'error').length, warn = checks.filter((c) => c.level === 'warning').length;
    const problems = checks.filter((c) => c.level === 'error' || c.level === 'warning');
    const count = (list: Check[]) => {
        const e = list.filter((c) => c.level === 'error').length, w = list.filter((c) => c.level === 'warning').length;
        return e ? <span className="q-count" style={{ color: '#c62828' }}>{e}</span> : w ? <span className="q-count" style={{ color: '#d48806' }}>{w}</span> : <CheckCircleFilled style={{ color: '#2e7d32', marginInlineStart: 6 }} />;
    };
    // Tabs: what needs attention first, then one per group (this computer, the repository, the project/environment).
    const groupKey = (g: string) => (/^[a-z0-9_.-]+ \/ [a-z0-9_.-]+$/i.test(g) ? 'project' : `g:${g}`);
    const items = [
        { key: 'problems', label: <span>Needs attention{problems.length ? <span className="q-count" style={{ color: bad ? '#c62828' : '#d48806' }}>{problems.length}</span> : null}</span>,
            children: problems.length
                ? problems.map((c) => <div key={c.id}><Typography.Text type="secondary" style={{ fontSize: 11 }}>{c.group}</Typography.Text><CheckRow c={c} fixing={fixing} onFix={(a) => void fix(a)} /></div>)
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Everything a run needs is ready." /> },
        ...groups.map((g) => {
            const list = checks.filter((c) => c.group === g);
            return { key: groupKey(g), label: <span title={`${list.filter((c) => c.level === 'error' || c.level === 'warning').length} of ${list.length} check${list.length === 1 ? '' : 's'} need attention`}>{g}{count(list)}</span>, children: list.map((c) => <CheckRow key={c.id} c={c} fixing={fixing} onFix={(a) => void fix(a)} />) };
        }),
    ];
    const active = items.some((i) => i.key === tab) ? tab : 'problems';
    return (
        <div style={{ maxWidth: 1040 }}>
            <Card size="small" style={{ marginBottom: 12 }}>
                <Form layout="vertical" size="small">
                    <Row gutter={12} align="bottom">
                        <Col xs={12} md={7}><Form.Item label="Project" style={{ marginBottom: 0 }} htmlFor="cs-health-project">
                            <Select id="cs-health-project" value={target.project} placeholder="Project" disabled={loading && !d} onChange={(p) => load({ project: p })} options={(d?.projects ?? []).map((p) => ({ value: p, label: p }))} aria-label="Project" /></Form.Item></Col>
                        <Col xs={12} md={5}><Form.Item label="Environment" style={{ marginBottom: 0 }} htmlFor="cs-health-env">
                            <Select id="cs-health-env" value={target.env} placeholder="Environment" onChange={(e) => load({ ...target, env: e })} options={((target.project && d?.environments[target.project]) || []).map((e) => ({ value: e, label: e }))} aria-label="Environment" /></Form.Item></Col>
                        <Col xs={24} md={12}>
                            <Space style={{ marginTop: 8 }} wrap>
                                <Button icon={<ReloadOutlined />} loading={loading} onClick={() => load(target)}>Check again</Button>
                                {d && <Typography.Text type={bad ? 'danger' : warn ? 'warning' : 'success'}>{bad ? `${bad} problem${bad === 1 ? '' : 's'}` : ''}{bad && warn ? ', ' : ''}{warn ? `${warn} thing${warn === 1 ? '' : 's'} to look at` : ''}{!bad && !warn ? 'Everything is ready' : ''}</Typography.Text>}
                            </Space>
                        </Col>
                    </Row>
                </Form>
            </Card>
            {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}
            {!d ? (loading ? <Spin /> : <Empty />) : (
                <Card size="small" styles={{ body: { paddingTop: 0 } }}>
                    <Tabs size="small" activeKey={active} onChange={setTab} items={items} />
                </Card>
            )}
        </div>
    );
}
