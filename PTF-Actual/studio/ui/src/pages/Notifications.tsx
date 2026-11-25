/** Run notifications: Teams, Slack or any webhook when a test run ends, and (per channel) what waits in the Inbox. */
import React from 'react';
import { Alert, App, Button, Card, Col, Empty, Form, Input, Row, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import { api, NotifyChannelDef, NotifyDef } from '../api';
import { errText, useStudio } from '../state';
import { markUnsaved } from '../unsaved';
import { navigate } from '../route';
import { saveErrorToast, usePageHeadTooltip, useRouteTab } from '../datagit-common';
import { datagitApi, Versioned } from '../datagit-api';

const KIND_HELP: Record<NotifyChannelDef['kind'], string> = {
    teams: 'In the Teams channel: ••• → Workflows → "Post to a channel when a webhook request is received". Paste the address it gives.',
    slack: 'A Slack app with an incoming webhook for the channel (https://hooks.slack.com/services/…).',
    webhook: 'Any address that accepts a POST with the run as JSON ({ event: "run.finished", run }).',
};
/** Unsaved changes, kept while the person visits another screen (and asked about when the tab closes). */
let draft: { chans: NotifyChannelDef[]; hooks: Record<string, string>; version?: string } | null = null;
/** Why the server would refuse this webhook address (the same rules), or null. */
export function webhookProblem(kind: NotifyChannelDef['kind'], raw: string): string | null {
    const h = raw.trim();
    if (!h) return null;
    let u: URL;
    try { u = new URL(h); } catch { return 'Not a web address: paste the whole address, starting with https://'; }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return 'The address must start with https:// (http:// only for this computer: localhost or 127.0.0.1).';
    if (kind === 'slack' && !local && u.hostname !== 'hooks.slack.com') return 'A Slack incoming webhook starts with https://hooks.slack.com/.';
    if (kind === 'teams' && !local && !/(\.logic\.azure\.com|\.powerplatform\.com|\.webhook\.office\.com|\.azure-api\.net|\.powerautomate\.com)$/i.test(u.hostname)) return 'A Teams webhook is the address of a Teams "Workflows" webhook (…logic.azure.com or …powerplatform.com).';
    return null;
}

const NOTIFY_TABS = ['channels', 'recent'] as const;
type NotifyTab = typeof NOTIFY_TABS[number];

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

export function Notifications() {
    const { message } = App.useApp();
    const { env } = useStudio();
    const [d, setD] = React.useState<Versioned<NotifyDef> | null>(null);
    const [chans, setChans] = React.useState<NotifyChannelDef[]>([]);
    const [hooks, setHooks] = React.useState<Record<string, string>>({});
    const [err, setErr] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    usePageHeadTooltip();
    // The tab is in the address (#/notify/recent), so Back and Forward move between tabs and a link opens one.
    const [tab, setTab] = useRouteTab<NotifyTab>('notify', 'notifications', NOTIFY_TABS, 'channels', { log: 'recent', messages: 'recent', deliveries: 'recent', channel: 'channels' });
    const load = React.useCallback((keepDraft = false) => {
        api.notifications().then((r) => {
            // A draft keeps the version it was made from: saving it over channels changed since is refused (409), not merged away.
            if (keepDraft && draft) { setD({ ...r, version: draft.version ?? (r as Versioned<NotifyDef>).version }); setChans(draft.chans); setHooks(draft.hooks); } else { draft = null; setD(r); setChans(r.channels); setHooks({}); }
        }).catch((e) => setErr(errText(e)));
    }, []);
    React.useEffect(() => load(true), [load]);
    const up = (i: number, p: Partial<NotifyChannelDef>) => setChans(chans.map((c, j) => (j === i ? { ...c, ...p } : c)));
    const dirty = !!d && (JSON.stringify(chans) !== JSON.stringify(d.channels) || Object.values(hooks).some(Boolean));
    // The draft outlives this screen; reloading from any screen asks while it exists.
    React.useEffect(() => { if (d) { draft = dirty ? { chans, hooks, version: d.version } : null; markUnsaved('notifications-draft', dirty ? 'notification channels' : null); } }, [d, dirty, chans, hooks]);
    const save = async () => {
        setBusy('save');
        // The version this tab read: a save over channels changed since (another tab) is refused, never silently merged away.
        try { const r = await datagitApi.saveNotifications(chans.map(({ hasWebhook: _h, ...c }) => c), hooks, d?.version); setD(r); setChans(r.channels); setHooks({}); message.success('Saved'); }
        catch (e) { saveErrorToast(message, e, () => load(false)); } finally { setBusy(null); }
    };
    const test = async (id: string) => {
        setBusy(id);
        try { const r = await api.testNotification(id); if (r.ok) message.success(`Sent (${r.detail})`); else message.error(`Not delivered: ${r.detail}`); load(); } catch (e) { message.error(errText(e)); } finally { setBusy(null); }
    };
    const nameProblem = (c: NotifyChannelDef): string | null => {
        const n = c.name.trim();
        if (!n) return 'Give the channel a name.';
        if (chans.some((o) => o !== c && o.name.trim().toLowerCase() === n.toLowerCase())) return `Two channels are named "${n}".`;
        return null;
    };
    const hookMissing = (c: NotifyChannelDef) => !c.hasWebhook && !(hooks[c.id] ?? '').trim();
    const problems = chans.map((c) => nameProblem(c) ?? webhookProblem(c.kind, hooks[c.id] ?? '') ?? (hookMissing(c) ? `"${c.name.trim()}" needs its webhook address.` : null)).filter((x): x is string => !!x);
    const projectNames = env?.projects ?? [];
    const envNames = [...new Set(Object.values(env?.environments ?? {}).flat())];
    if (err) return <Alert type="error" showIcon message={err} />;
    if (!d) return null;
    const channels = <div className="dg-settings-col" style={{ maxWidth: 1000 }}>
        {!d.canSave && <Alert type="warning" showIcon message={<span>Set up your secrets first: webhook addresses are kept there, encrypted. <Typography.Link onClick={() => navigate(['secrets'])}>Open Secrets</Typography.Link></span>} />}
        {chans.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No channels yet. Add one to get a message when a run ends." />}
        {chans.map((c, i) => (
            <Card key={c.id} size="small" title={<Space><Switch size="small" aria-label="Channel on" checked={c.enabled} onChange={(v) => up(i, { enabled: v })} /><Input size="small" style={{ width: 240 }} maxLength={60} aria-label="Channel name" value={c.name} placeholder="Name, e.g. QA team channel" status={nameProblem(c) ? 'error' : undefined} onChange={(e) => up(i, { name: e.target.value })} />{nameProblem(c) && <Typography.Text type="danger" style={{ fontSize: 12, fontWeight: 400 }}>{nameProblem(c)}</Typography.Text>}</Space>}
                extra={<Space>
                    <Tooltip title={dirty ? 'Save first' : !c.hasWebhook ? 'Save a webhook address first' : undefined}><Button size="small" icon={<SendOutlined />} disabled={!c.hasWebhook || dirty} loading={busy === c.id} onClick={() => { if (!busy) void test(c.id); }}>Send a test</Button></Tooltip>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setChans(chans.filter((_, j) => j !== i))} aria-label="Remove" title="Remove the channel (until you save)" />
                </Space>}>
                <Form layout="vertical" size="small" className="dg-compact-form">
                    <Row gutter={12}>
                        <Col xs={24} sm={12} lg={6}><Form.Item label="Service">
                            <Select aria-label="Service" value={c.kind} onChange={(v) => up(i, { kind: v })} options={[{ value: 'teams', label: 'Microsoft Teams' }, { value: 'slack', label: 'Slack' }, { value: 'webhook', label: 'Webhook (JSON)' }]} /></Form.Item></Col>
                        <Col xs={24} sm={12} lg={6}><Form.Item label="When">
                            <Select aria-label="When" value={c.when} onChange={(v) => up(i, { when: v })} options={[{ value: 'failures', label: 'A run fails' }, { value: 'changes', label: 'A result changes (breaks or is fixed)' }, { value: 'always', label: 'Every run' }]} /></Form.Item></Col>
                        <Col xs={24} sm={12} lg={6}><Form.Item label="Projects">
                            <Select aria-label="Projects" mode="tags" maxTagCount="responsive" placeholder="All" value={c.projects ?? []} onChange={(v) => up(i, { projects: v })} options={projectNames.map((p) => ({ value: p }))} /></Form.Item></Col>
                        <Col xs={24} sm={12} lg={6}><Form.Item label="Environments">
                            <Select aria-label="Environments" mode="tags" maxTagCount="responsive" placeholder="All" value={c.envs ?? []} onChange={(v) => up(i, { envs: v })} options={envNames.map((p) => ({ value: p }))} /></Form.Item></Col>
                    </Row>
                    <Row gutter={12} align="bottom">
                        <Col xs={24} lg={18}><Form.Item label={<span>Webhook address {c.hasWebhook && <Tag color="green" bordered={false}>saved</Tag>}</span>} tooltip={KIND_HELP[c.kind]} style={{ marginBottom: 0 }}
                            validateStatus={webhookProblem(c.kind, hooks[c.id] ?? '') ? 'error' : undefined} help={webhookProblem(c.kind, hooks[c.id] ?? '') ?? (hookMissing(c) && c.name.trim() ? 'Paste the webhook address to save this channel.' : undefined)}>
                            <Input.Password aria-label="Webhook address" autoComplete="new-password" placeholder={c.hasWebhook ? 'Leave empty to keep the saved address' : 'https://…'} value={hooks[c.id] ?? ''} onChange={(e) => setHooks({ ...hooks, [c.id]: e.target.value })}
                                /></Form.Item></Col>
                        <Col xs={24} lg={6}><Form.Item label="Also" tooltip="What waits for someone in the Inbox: agents' questions, plans, approvals." style={{ marginBottom: 0 }}>
                            <Space size={6}><Switch size="small" aria-label="Also send what waits in the Inbox" checked={!!c.inbox} onChange={(v) => up(i, { inbox: v || undefined })} /><span style={{ fontSize: 13 }}>Inbox items</span></Space></Form.Item></Col>
                    </Row>
                </Form>
            </Card>
        ))}
    </div>;
    return (
        <div>
            <div className="dg-toolbar">
                <Button icon={<PlusOutlined />} onClick={(e) => { if (e.detail > 1) return; /* one channel per double-click */ setTab('channels'); setChans([...chans, { id: newId(), name: '', kind: 'teams', when: 'failures', enabled: true }]); }}>Add a channel</Button>
                <Tooltip title={problems[0]}><Button type="primary" disabled={!dirty || !d.canSave || problems.length > 0} loading={busy === 'save'} onClick={() => { if (busy !== 'save') void save(); }}>Save</Button></Tooltip>
                {dirty && <Button onClick={() => load(false)}>Discard</Button>}
                {dirty && <Typography.Text type="warning" style={{ fontSize: 12 }}>Not saved yet</Typography.Text>}
            </div>
            <Tabs size="small" className="dg-tabs" activeKey={tab} onChange={(k) => setTab(k as NotifyTab)} items={[
                { key: 'channels', label: `Channels (${chans.length})`, children: channels },
                {
                    key: 'recent', label: `Recent messages (${d.deliveries.length})`, children: d.deliveries.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No messages sent yet." /> : (
                        <Table size="small" pagination={false} rowKey={(r) => r.at + r.channel} dataSource={d.deliveries} style={{ maxWidth: 1000 }} columns={[
                            { title: 'When', dataIndex: 'at', render: (v: string) => new Date(v).toLocaleString(), width: 190 },
                            { title: 'Channel', dataIndex: 'channel' },
                            { title: 'Run', dataIndex: 'run', render: (v: string) => (v === 'test' ? 'test message' : v) },
                            { title: 'Result', render: (_: unknown, r) => <Tag color={r.ok ? 'green' : 'red'}>{r.ok ? 'delivered' : 'failed'}</Tag> },
                            { title: 'Detail', dataIndex: 'detail', ellipsis: true },
                        ]} />),
                },
            ]} />
        </div>
    );
}
