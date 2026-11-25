import React from 'react';
import { App, Button, Card, Empty, Input, Space, Spin, Tabs, Tag, Timeline, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api, ActivityEntry } from '../api';
import { errText, openInEditor } from '../state';
import { navigate, useRoute } from '../route';
import '../styles-tests.css';

const COLORS: Record<string, string> = { 'git.commit': 'green', 'git.push': 'blue', 'secret-scan.blocked': 'red', 'secret-scan.fix': 'purple', 'secret.set': 'purple', 'secret.delete': 'gray', 'env.set': 'cyan', 'env.secret': 'purple', 'env.create': 'cyan', 'env.remove': 'gray' };

/** Kinds of activity, by the start of the action name; one tab each (the rest under Other). */
const KINDS: Array<{ key: string; label: string; match: RegExp }> = [
    { key: 'tests', label: 'Tests', match: /^(test|run|runs|recorder|quality|healing|visual|aria|triage)\b/ },
    { key: 'git', label: 'Source control', match: /^(git|branch|stash|merge|pr)\b/ },
    { key: 'files', label: 'Files', match: /^file\b/ },
    { key: 'secrets', label: 'Secrets & environments', match: /^(secret|secret-scan|env)\b/ },
];
const kindOf = (a: string) => KINDS.find((k) => k.match.test(a))?.key ?? 'other';
const TAB_KEY = 'cs-studio-activity-tab';
const day = (ts: string) => { const d = new Date(ts); const t = new Date(); const y = new Date(Date.now() - 86400000); return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); };

/** Where an entry leads: its test run, its commit, or its file. */
function openOf(e: ActivityEntry): { label: string; go: () => void } | null {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.action === 'test.run' && typeof d.id === 'string') return { label: 'Open the run', go: () => navigate(['runs', d.id as string]) };
    if (e.action === 'git.commit' && typeof d.sha === 'string') return { label: 'Open the commit', go: () => navigate(['git', 'history', d.sha as string]) };
    if (typeof d.file === 'string' && !/^\.|\.git\//.test(d.file)) return { label: 'Open the file', go: () => openInEditor(d.file as string) };
    return null;
}

export function Activity() {
    const { message } = App.useApp();
    const [rows, setRows] = React.useState<ActivityEntry[] | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [find, setFind] = React.useState('');
    // The tab is in the address (#/activity/<tab>), so a link opens it; without one, the tab used last.
    const route = useRoute();
    const [savedTab, setTabRaw] = React.useState<string>(() => { try { return localStorage.getItem(TAB_KEY) ?? 'all'; } catch { return 'all'; } });
    const tab = route[0] === 'activity' && route[1] ? route[1] : savedTab;
    const setTab = (k: string) => { setTabRaw(k); try { localStorage.setItem(TAB_KEY, k); } catch { /* private mode */ } navigate(['activity', k], true); };
    const load = React.useCallback(() => {
        setLoading(true);
        api.activity(300).then(setRows).catch((e) => message.error(errText(e))).finally(() => setLoading(false));
    }, [message]);
    React.useEffect(load, [load]);
    // An unknown tab in the address (#/activity/bogus) is rewritten in place to the tab shown (All).
    React.useEffect(() => {
        if (!rows || route[0] !== 'activity' || route.length < 2) return;
        const want = route[1] === 'all' || rows.some((r) => kindOf(r.action) === route[1]) ? route[1] : 'all';
        if (route.length > 2 || want !== route[1]) navigate(['activity', want], true);
    }, [rows, route]);
    if (!rows) return <Spin style={{ marginTop: 40 }} />;
    if (rows.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing yet. Commits, pushes, test runs, secret and environment changes appear here." style={{ marginTop: 80 }} />;

    const q = find.trim().toLowerCase();
    // Counts follow Find, so each tab says how many it would show.
    const matching = rows.filter((r) => !q || `${r.summary} ${r.action}`.toLowerCase().includes(q));
    const counts = new Map<string, number>();
    for (const r of rows) if (!counts.has(kindOf(r.action))) counts.set(kindOf(r.action), 0);
    for (const r of matching) counts.set(kindOf(r.action), (counts.get(kindOf(r.action)) ?? 0) + 1);
    const tabs = [{ key: 'all', label: 'All' }, ...KINDS.filter((k) => counts.has(k.key)), ...(counts.has('other') ? [{ key: 'other', label: 'Other' }] : [])];
    const active = tabs.some((t) => t.key === tab) ? tab : 'all';
    const shown = rows.filter((r) => (active === 'all' || kindOf(r.action) === active) && (!q || `${r.summary} ${r.action}`.toLowerCase().includes(q)));
    // Grouped by day, newest first (as the server lists them).
    const days: Array<{ day: string; list: ActivityEntry[] }> = [];
    for (const r of shown) { const d = day(r.ts); if (days[days.length - 1]?.day !== d) days.push({ day: d, list: [] }); days[days.length - 1].list.push(r); }

    return (
        <Card size="small" style={{ maxWidth: 1100 }} styles={{ body: { paddingTop: 0 } }}>
            <Tabs size="small" activeKey={active} onChange={setTab}
                tabBarExtraContent={<Space size={6}>
                    <Input size="small" allowClear placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 200 }} aria-label="Find in the activity" />
                    <Tooltip title="Refresh"><Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load} aria-label="Refresh" /></Tooltip>
                </Space>}
                items={tabs.map((t) => ({ key: t.key, label: <span>{t.label}<span className="q-count">{t.key === 'all' ? matching.length : counts.get(t.key) ?? 0}</span></span> }))} />
            {!shown.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q ? 'Nothing matches.' : 'Nothing of this kind yet.'} /> : days.map((g) => (
                <div key={g.day}>
                    <div className="tests-day">{g.day}</div>
                    <Timeline items={g.list.map((e) => ({
                        color: COLORS[e.action] ?? 'gray',
                        children: (
                            <div>
                                <Typography.Text strong className="tests-act-summary">{e.summary}</Typography.Text>
                                {typeof e.data?.overrideReason === 'string' && <div><Tag color="orange">Override</Tag><Typography.Text type="secondary">{String(e.data.overrideReason)}</Typography.Text></div>}
                                <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(e.ts).toLocaleTimeString()} · {e.action}</Typography.Text>{openOf(e) && <Button type="link" size="small" style={{ padding: '0 0 0 8px', height: 'auto', fontSize: 12 }} onClick={openOf(e)!.go}>{openOf(e)!.label}</Button>}</div>
                            </div>
                        ),
                    }))} />
                </div>
            ))}
        </Card>
    );
}
