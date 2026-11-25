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

/** A group's tab in the address: "This computer" → this-computer, "cart / qa" → cart-qa. */
export function groupSlug(g: string): string {
    return g.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
}
const isProjectGroup = (g: string) => /^[a-z0-9_.-]+ \/ [a-z0-9_.-]+$/i.test(g);
/** The tab a key in the address means: a friendly name, or an old key ("g:<group>", "project"). */
export function tabFor(key: string, groups: string[]): string {
    if (key === 'problems') return key;
    if (key === 'project') { const g = groups.find(isProjectGroup); return g ? groupSlug(g) : 'problems'; }
    const name = key.startsWith('g:') ? key.slice(2) : null;
    const g = groups.find((x) => (name !== null ? x === name : groupSlug(x) === groupSlug(key)));
    return g ? groupSlug(g) : 'problems';
}
const RANK = { error: 0, warning: 1, info: 2, ok: 3 } as const;
/** "Needs attention": one heading per group, the groups with an error first, errors before warnings in each. */
export function problemGroups<T extends { group: string; level: keyof typeof RANK }>(problems: T[]): Array<{ group: string; list: T[] }> {
    const out: Array<{ group: string; list: T[] }> = [];
    for (const c of problems) { const g = out.find((x) => x.group === c.group); if (g) g.list.push(c); else out.push({ group: c.group, list: [c] }); }
    for (const g of out) g.list.sort((a, b) => RANK[a.level] - RANK[b.level]);
    const worst = (g: { list: T[] }) => Math.min(...g.list.map((c) => RANK[c.level]));
    return out.sort((a, b) => worst(a) - worst(b));
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
    // The project/environment chosen last is kept across a reload.
    React.useEffect(() => { load(target); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
    const fix = async (action: string) => {
        if (fixing) return;
        setFixing(action);
        try { const r = await api.doctorFix(action); message.success(r.done); load(target); } catch (e) { message.error(errText(e)); } finally { setFixing(null); }
    };
    const checks = d?.checks ?? [];
    const groups = [...new Set(checks.map((c) => c.group))];
    const bad = checks.filter((c) => c.level === 'error').length, warn = checks.filter((c) => c.level === 'warning').length;
    const problems = checks.filter((c) => c.level === 'error' || c.level === 'warning');
    // A tab's badge counts what needs attention (errors and warnings), as "Needs attention" does: red when one is an error.
    const count = (list: Check[]) => {
        const e = list.filter((c) => c.level === 'error').length, w = list.filter((c) => c.level === 'warning').length;
        return e + w ? <span className="q-count" style={{ color: e ? '#c62828' : '#d48806' }}>{e + w}</span> : <CheckCircleFilled style={{ color: '#2e7d32', marginInlineStart: 6 }} />;
    };
    // Tabs: what needs attention first, then one per group (this computer, the repository, the project/environment).
    const items = [
        { key: 'problems', label: <span>Needs attention{problems.length ? <span className="q-count" style={{ color: bad ? '#c62828' : '#d48806' }}>{problems.length}</span> : null}</span>,
            children: problems.length
                ? problemGroups(problems).map(({ group, list }) => <div key={group} className="tests-check-group">
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>{group}</Typography.Text>
                    {list.map((c) => <CheckRow key={c.id} c={c} fixing={fixing} onFix={(a) => void fix(a)} />)}</div>)
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Everything a run needs is ready." /> },
        ...groups.map((g) => {
            const list = checks.filter((c) => c.group === g);
            return { key: groupSlug(g), label: <span title={`${list.filter((c) => c.level === 'error' || c.level === 'warning').length} of ${list.length} check${list.length === 1 ? '' : 's'} need attention`}>{g}{count(list)}</span>, children: list.map((c) => <CheckRow key={c.id} c={c} fixing={fixing} onFix={(a) => void fix(a)} />) };
        }),
    ];
    // Old links (#/health/g%3ARepository, #/health/project) still open their tab; the address then shows the friendly name.
    const wanted = d ? tabFor(tab, groups) : tab;
    const active = items.some((i) => i.key === wanted) ? wanted : 'problems';
    // A link to a tab that is not there (or an old key) is replaced by the tab shown.
    React.useEffect(() => {
        if (d && route[0] === 'health' && route[1] && route[1] !== active) navigate(['health', active], true);
    }, [d, route[0], route[1], active]); // eslint-disable-line react-hooks/exhaustive-deps
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
