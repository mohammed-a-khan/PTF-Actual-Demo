/**
 * Healed locators: elements the framework found with another locator than the page object's (an alternative,
 * or the self-healing engine), from the runs' reports. Review one, update the page object with the locator
 * that worked (shown as a change first), run it to confirm, or dismiss it.
 */
import React from 'react';
import { Alert, App, Button, Card, Drawer, Empty, Radio, Segmented, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CheckOutlined, CodeOutlined, EyeInvisibleOutlined, PlayCircleOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import { api, HealGroup, HealPreview, HealStatus } from '../api';
import { errText, loadRunTarget, useStudio } from '../state';
import { navigate, useRoute } from '../route';
import { useKept } from '../kept';
import '../styles-tests.css';

const STATUS: Record<HealStatus, { label: string; color: string; about: string }> = {
    review: { label: 'Needs review', color: 'warning', about: 'The page object\'s locator did not find the element; another one did.' },
    applied: { label: 'Updated, not run yet', color: 'processing', about: 'The page object has the new locator. Run a scenario that uses it to confirm.' },
    confirmed: { label: 'Confirmed', color: 'success', about: 'A run after the change found the element without healing.' },
    dismissed: { label: 'Dismissed', color: 'default', about: 'Left as it is. Shown again if it heals to another locator.' },
};
const HOW: Record<string, string> = {
    alternative: 'Alternative locator', 'accessibility-tree': 'Accessibility tree', fingerprint: 'Fingerprint', 'fuzzy-text': 'Text search', visual: 'Visual match',
};
const ago = (iso?: string) => {
    if (!iso) return '–';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const writtenName = (n: string) => n.replace(/_Iteration-\d+$/, '');

/** The decorator before and after, as removed and added lines. */
function Change({ before, after }: { before: string; after: string }) {
    return (
        <pre className="h-diff mono">
            {before.split('\n').map((l, i) => <div key={`b${i}`} className="h-del">- {l}</div>)}
            {after.split('\n').map((l, i) => <div key={`a${i}`} className="h-add">+ {l}</div>)}
        </pre>
    );
}

export function Healing() {
    const { message, modal } = App.useApp();
    const { env: disc } = useStudio();
    const route = useRoute();
    const here = route[0] === 'healing';
    const [project, setProject] = useKept<string | undefined>('healing.project', undefined);
    const [data, setData] = React.useState<{ groups: HealGroup[]; project: string | null; projects: string[] } | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [status, setStatus] = useKept<HealStatus | 'all'>('healing.status', 'review');
    const [open, setOpen] = useKept<string | null>('healing.open', null);
    const [drawerTab, setDrawerTab] = useKept('healing.drawer-tab', 'change');
    // The screen has no sub-pages: a wrong address (#/healing/bogus) is replaced by #/healing.
    React.useEffect(() => { if (here && route.length > 1) navigate(['healing'], true); }, [here, route.length]); // eslint-disable-line react-hooks/exhaustive-deps
    const [choice, setChoice] = React.useState<string | null>(null);
    const [preview, setPreview] = React.useState<HealPreview | { error: string } | null>(null);
    const [busy, setBusy] = React.useState(false);
    const first = React.useRef(false);

    const load = React.useCallback(async () => {
        setLoading(true);
        try {
            const d = await api.healing(project);
            setData(d);
            // Nothing to review: open on everything rather than an empty list.
            if (!first.current) { first.current = true; if (d.groups.length && !d.groups.some((g) => g.status === 'review')) setStatus('all'); }
        } catch (e) { message.error(errText(e)); } finally { setLoading(false); }
    }, [project, message]);
    React.useEffect(() => { if (here) void load(); }, [here, load]);

    const current = data?.groups.find((g) => g.key === open);
    // The change for the chosen locator (the suggestion unless another is picked).
    React.useEffect(() => {
        setPreview(null);
        if (!current) return;
        const healed = choice ?? current.healed;
        if (!current.pageClass || !current.property) { setPreview({ error: 'This run did not record which page object the element is in (an older framework version). Update the page object by hand.' }); return; }
        let live = true;
        api.healPreview(current.key, healed).then((p) => live && setPreview(p)).catch((e) => live && setPreview({ error: errText(e) }));
        return () => { live = false; };
    }, [current?.key, current?.lastSeen, choice]); // eslint-disable-line react-hooks/exhaustive-deps

    const runToConfirm = (g: HealGroup) => {
        const p = g.scenarios.find((s) => s.project)?.project ?? data?.project ?? undefined;
        if (!p) { message.warning('The project is not known: run the scenarios from Run tests.'); return; }
        const names = [...new Set(g.scenarios.map((s) => writtenName(s.name)))];
        const start = async (env: string) => { try { const run = await api.startRun({ project: p, env, scenarios: names }); navigate(['runs', run.id]); } catch (e) { message.error(errText(e)); } };
        const envs = [...new Set(g.scenarios.map((s) => s.env).filter((e): e is string => !!e))];
        if (envs.length === 1) { void start(envs[0]); return; }
        const choices = disc?.environments[p] ?? [];
        const saved = loadRunTarget();
        let env = (saved?.project === p && saved.env && choices.includes(saved.env) ? saved.env : choices[0]) ?? 'dev';
        modal.confirm({
            title: `Run ${names.length === 1 ? `"${names[0]}"` : `${names.length} scenarios`}`, okText: 'Run', icon: <PlayCircleOutlined />,
            content: <Space direction="vertical"><Typography.Text type="secondary">Project {p}. Environment:</Typography.Text>
                <Select defaultValue={env} style={{ width: 200 }} onChange={(v) => { env = v; }} options={(choices.length ? choices : [env]).map((e) => ({ value: e, label: e }))} aria-label="Environment" /></Space>,
            onOk: () => start(env),
        });
    };
    const apply = async () => {
        if (!current || !preview || 'error' in preview) return;
        setBusy(true);
        try {
            const r = await api.healApply(current.key, choice ?? current.healed, preview.baseHash);
            message.success(`Updated ${r.file}. Run a scenario that uses it to confirm, then commit under Source control.`);
            await load();
        } catch (e) {
            // The file changed since the preview: show the change against the file as it is now (then apply again).
            if (/changed since the preview/i.test(errText(e))) {
                message.warning('The page object changed since this preview: the change is shown again against the file as it is now. Check it, then update.');
                try { setPreview(await api.healPreview(current.key, choice ?? current.healed)); } catch (x) { setPreview({ error: errText(x) }); }
            } else message.error(errText(e));
        } finally { setBusy(false); }
    };
    const dismiss = async (g: HealGroup, undo = false) => {
        try { await api.healDismiss(g.key, choice ?? g.healed, undo); await load(); if (!undo) setOpen(null); } catch (e) { message.error(errText(e)); }
    };

    // Below about 1280 px the table is wider than the screen: say so (the fixed first and last columns show its edges).
    const narrow = window.innerWidth < 1280;
    if (!data) return <div className="panel" style={{ padding: 24 }}>{loading ? 'Loading…' : null}</div>;
    const counts = (s: HealStatus) => data.groups.filter((g) => g.status === s).length;
    const shown = data.groups.filter((g) => status === 'all' || g.status === status);

    return (
        <div className="panel" style={{ height: 'calc(100vh - var(--chrome))', display: 'flex', flexDirection: 'column' }}>
            <div className="toolbar">
                {data.projects.length > 1 && <Select size="small" value={data.project ?? 'all'} onChange={setProject} style={{ width: 170 }} aria-label="Project"
                    options={[...data.projects.map((p) => ({ value: p, label: `Project ${p}` })), { value: 'all', label: 'All projects' }]} />}
                <Segmented size="small" value={status} onChange={(v) => setStatus(v as HealStatus | 'all')}
                    options={[...(['review', 'applied', 'confirmed', 'dismissed'] as HealStatus[]).map((s) => ({ value: s, label: `${STATUS[s].label} ${counts(s)}` })), { value: 'all', label: `All ${data.groups.length}` }]} />
                <span style={{ flex: 1 }} />
                <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} aria-label="Refresh" />
            </div>
            {narrow && data.groups.length > 0 && <Typography.Text type="secondary" className="h-scroll-hint">The table scrolls sideways: How, Seen and the status are on the right.</Typography.Text>}
            <div style={{ flex: 1, overflow: 'auto' }}>
                {!data.groups.length
                    ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 60 }} description="No healed locators in the recent runs: every page object locator found its element." />
                    : <Table<HealGroup> size="small" rowKey="key" dataSource={shown} pagination={false} sticky tableLayout="fixed" scroll={{ x: 1040 }} className="h-table"
                        onRow={(g) => ({ onClick: () => { setChoice(null); setOpen(g.key); }, style: { cursor: 'pointer' } })}
                        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`Nothing ${STATUS[status as HealStatus]?.label.toLowerCase() ?? ''}.`} /> }}
                        columns={[
                            { title: 'Element', key: 'el', ellipsis: true, width: 200, fixed: 'left', render: (_, g) => <div className="q-name" title={`${g.element}${g.pageClass && g.property ? ` (${g.pageClass}.${g.property})` : ''}`}><span>{g.element}</span><Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{g.pageClass && g.property ? `${g.pageClass}.${g.property}` : 'page object not recorded'}</Typography.Text></div> },
                            { title: 'Page object locator', dataIndex: 'original', ellipsis: { showTitle: false }, width: 210, render: (v: string) => <Tooltip title={<span className="mono">{v}</span>}><span className="mono h-broken">{v}</span></Tooltip> },
                            { title: 'Found with', key: 'healed', ellipsis: { showTitle: false }, width: 210, render: (_, g) => <span title={g.healed}><span className="mono h-found">{g.healed}</span>{g.variants.length > 1 && <Typography.Text type="secondary" style={{ fontSize: 12 }}> +{g.variants.length - 1} other</Typography.Text>}</span> },
                            { title: 'How', key: 'how', width: 180, ellipsis: true, render: (_, g) => <Space size={4}><Tag bordered={false}>{HOW[g.strategy] ?? g.strategy}</Tag><Typography.Text type="secondary" style={{ fontSize: 12 }}>{g.confidence}%</Typography.Text></Space> },
                            { title: 'Seen', key: 'seen', width: 110, render: (_, g) => <Tooltip title={`First ${new Date(g.firstSeen).toLocaleString()}, last ${new Date(g.lastSeen).toLocaleString()}`}><span>{g.count}× in {g.runs} run{g.runs === 1 ? '' : 's'}<br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{ago(g.lastSeen)}</Typography.Text></span></Tooltip> },
                            { title: 'Status', dataIndex: 'status', width: 130, fixed: 'right', render: (s: HealStatus) => <Tooltip title={STATUS[s].about}><Tag bordered={false} color={STATUS[s].color}>{STATUS[s].label}</Tag></Tooltip> },
                        ]} />}
            </div>

            <Drawer open={!!current} onClose={() => setOpen(null)} width={720} title={<Typography.Text ellipsis={{ tooltip: current?.element }}>{current?.element}</Typography.Text>} destroyOnClose
                extra={current && <Space>
                    {preview && !('error' in preview) && <Button size="small" icon={<CodeOutlined />} onClick={() => navigate(['code', preview.file, preview.line])}>Open</Button>}
                    {current.status === 'dismissed'
                        ? <Button size="small" icon={<UndoOutlined />} onClick={() => void dismiss(current, true)}>Back to review</Button>
                        : current.status === 'review' && <Button size="small" icon={<EyeInvisibleOutlined />} onClick={() => void dismiss(current)}>Dismiss</Button>}
                    {current.status === 'applied' && <Button size="small" icon={<PlayCircleOutlined />} onClick={() => runToConfirm(current)}>Run to confirm</Button>}
                </Space>}>
                {current && <>
                    <Space size={6} style={{ marginBottom: 12 }} wrap>
                        <Tag bordered={false} color={STATUS[current.status].color}>{STATUS[current.status].label}</Tag>
                        <Typography.Text type="secondary">{STATUS[current.status].about}</Typography.Text>
                    </Space>
                    <div className="h-facts">
                        <div><span>Page object</span><b className="mono">{current.pageClass && current.property ? `${current.pageClass}.${current.property}` : '–'}</b></div>
                        <div><span>Its locator</span><b className="mono h-broken">{current.original}</b></div>
                        <div><span>Found by</span><b>{HOW[current.strategy] ?? current.strategy} · {current.confidence}% confidence</b></div>
                        <div><span>Seen</span><b>{current.count}× in {current.runs} run{current.runs === 1 ? '' : 's'}, last {ago(current.lastSeen)}</b></div>
                    </div>
                    {current.strategy !== 'alternative' && current.status === 'review' && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Found by the self-healing engine: check it is the right element before updating the page object (open the run's evidence, or run it once with the new locator)." />}

                    <Tabs size="small" activeKey={drawerTab} onChange={setDrawerTab} items={[
                        { key: 'change', label: 'Change', children: <>
                    {current.variants.length > 1 && <Card size="small" title="Locators it was found with" style={{ marginBottom: 12 }}>
                        <Radio.Group value={choice ?? current.healed} onChange={(e) => setChoice(e.target.value)}>
                            <Space direction="vertical">{current.variants.map((v) => <Radio key={v.healed} value={v.healed}><span className="mono">{v.healed}</span> <Typography.Text type="secondary">({v.count}×)</Typography.Text></Radio>)}</Space>
                        </Radio.Group>
                    </Card>}

                    {current.status !== 'confirmed' && <Card size="small" title="Change to the page object" style={{ marginBottom: 12 }}
                        extra={preview && !('error' in preview) && current.status !== 'applied' && <Button type="primary" size="small" icon={<CheckOutlined />} loading={busy} onClick={() => void apply()}>Update page object</Button>}>
                        {!preview ? <Typography.Text type="secondary">Working out the change…</Typography.Text>
                            : 'error' in preview ? <Alert type="warning" showIcon message={preview.error} />
                                : current.status === 'applied' ? <Typography.Text>The page object has this locator. Run a scenario that uses it to confirm.</Typography.Text>
                                    : <>
                                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{preview.file}:{preview.line}. The locator becomes <span className="mono">{preview.option.key}: {preview.option.value}</span>; other options stay.</Typography.Text>
                                        <Change before={preview.before} after={preview.after} />
                                    </>}
                    </Card>}

                            {current.status === 'confirmed' && current.variants.length <= 1 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing to change: the page object has the locator that worked." />}
                        </> },
                        { key: 'where', label: <>Where it healed <span className="q-count">{current.events.length}</span></>, children: <>
                    {current.scenarios.map((s) => <Tag key={`${s.feature}|${s.name}`} style={{ marginBottom: 4 }}>{s.name}</Tag>)}
                    <div style={{ marginTop: 8 }}>
                        {[...current.events].reverse().slice(0, 20).map((e, i) => (
                            <div key={i} className="q-result">
                                <i className={`q-dot ${e.strategy === 'alternative' ? 'pass' : 'retried'}`} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div className="q-result-head"><span>{new Date(e.at).toLocaleString()}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.scenario}</Typography.Text>
                                        {!e.run.startsWith('report:') && <a style={{ fontSize: 12 }} onClick={() => navigate(['runs', e.run])}>Run</a>}</div>
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.step} · found with <span className="mono">{e.healed}</span></Typography.Text>
                                </div>
                            </div>
                        ))}
                    </div>
                        </> },
                    ]} />
                </>}
            </Drawer>
        </div>
    );
}
