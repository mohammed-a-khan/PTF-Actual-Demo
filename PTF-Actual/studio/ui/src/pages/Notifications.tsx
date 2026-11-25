/** Run notifications: Teams, Slack or any webhook when a test run ends, and (per channel) what waits in the Inbox. */
import React from 'react';
import { Alert, App, Button, Card, Col, Empty, Form, Input, Row, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import { api, NotifyChannelDef, NotifyDef } from '../api';
import { errText, useStudio } from '../state';
import { markUnsaved } from '../unsaved';
import { navigate } from '../route';
import { useStoredTab } from '../datagit-common';

const KIND_HELP: Record<NotifyChannelDef['kind'], string> = {
    teams: 'In the Teams channel: ••• → Workflows → "Post to a channel when a webhook request is received". Paste the address it gives.',
    slack: 'A Slack app with an incoming webhook for the channel (https://hooks.slack.com/services/…).',
    webhook: 'Any address that accepts a POST with the run as JSON ({ event: "run.finished", run }).',
};
/** Unsaved changes, kept while the person visits another screen (and asked about when the tab closes). */
let draft: { chans: NotifyChannelDef[]; hooks: Record<string, string> } | null = null;
const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

export function Notifications() {
    const { message } = App.useApp();
    const { env } = useStudio();
    const [d, setD] = React.useState<NotifyDef | null>(null);
    const [chans, setChans] = React.useState<NotifyChannelDef[]>([]);
    const [hooks, setHooks] = React.useState<Record<string, string>>({});
    const [err, setErr] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [tab, setTab] = useStoredTab<'channels' | 'log'>('notifications', ['channels', 'log'], 'channels');
    const load = React.useCallback((keepDraft = false) => {
        api.notifications().then((r) => {
            setD(r);
            if (keepDraft && draft) { setChans(draft.chans); setHooks(draft.hooks); } else { draft = null; setChans(r.channels); setHooks({}); }
        }).catch((e) => setErr(errText(e)));
    }, []);
    React.useEffect(() => load(true), [load]);
    const up = (i: number, p: Partial<NotifyChannelDef>) => setChans(chans.map((c, j) => (j === i ? { ...c, ...p } : c)));
    const dirty = !!d && (JSON.stringify(chans) !== JSON.stringify(d.channels) || Object.values(hooks).some(Boolean));
    // The draft outlives this screen; reloading from any screen asks while it exists.
    React.useEffect(() => { if (d) { draft = dirty ? { chans, hooks } : null; markUnsaved('notifications-draft', dirty ? 'notification channels' : null); } }, [d, dirty, chans, hooks]);
    const save = async () => {
        setBusy('save');
        try { const r = await api.saveNotifications(chans.map(({ hasWebhook: _h, ...c }) => c), hooks); setD(r); setChans(r.channels); setHooks({}); message.success('Saved'); } catch (e) { message.error(errText(e)); } finally { setBusy(null); }
    };
    const test = async (id: string) => {
        setBusy(id);
        try { const r = await api.testNotification(id); if (r.ok) message.success(`Sent (${r.detail})`); else message.error(`Not delivered: ${r.detail}`); load(); } catch (e) { message.error(errText(e)); } finally { setBusy(null); }
    };
    const projectNames = env?.projects ?? [];
    const envNames = [...new Set(Object.values(env?.environments ?? {}).flat())];
    if (err) return <Alert type="error" showIcon message={err} />;
    if (!d) return null;
    const channels = <div className="dg-settings-col" style={{ maxWidth: 1000 }}>
        {!d.canSave && <Alert type="warning" showIcon message={<span>Set up your secrets first: webhook addresses are kept there, encrypted. <Typography.Link onClick={() => navigate(['secrets'])}>Open Secrets</Typography.Link></span>} />}
        {chans.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No channels yet. Add one to get a message when a run ends." />}
        {chans.map((c, i) => (
            <Card key={c.id} size="small" title={<Space><Switch size="small" aria-label="Channel on" checked={c.enabled} onChange={(v) => up(i, { enabled: v })} /><Input size="small" style={{ width: 240 }} maxLength={80} aria-label="Channel name" value={c.name} placeholder="Name, e.g. QA team channel" onChange={(e) => up(i, { name: e.target.value })} /></Space>}
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
                        <Col xs={24} lg={18}><Form.Item label={<span>Webhook address {c.hasWebhook && <Tag color="green" bordered={false}>saved</Tag>}</span>} tooltip={KIND_HELP[c.kind]} style={{ marginBottom: 0 }}>
                            <Input.Password aria-label="Webhook address" autoComplete="new-password" placeholder={c.hasWebhook ? 'Leave empty to keep the saved address' : 'https://…'} value={hooks[c.id] ?? ''} onChange={(e) => setHooks({ ...hooks, [c.id]: e.target.value })}
                                status={hooks[c.id] && !/^https?:\/\/\S+$/i.test(hooks[c.id].trim()) ? 'error' : undefined} /></Form.Item></Col>
                        <Col xs={24} lg={6}><Form.Item label="Also" tooltip="What waits for someone in the Inbox: agents' questions, plans, approvals." style={{ marginBottom: 0 }}>
                            <Space size={6}><Switch size="small" aria-label="Also send what waits in the Inbox" checked={!!c.inbox} onChange={(v) => up(i, { inbox: v || undefined })} /><span style={{ fontSize: 13 }}>Inbox items</span></Space></Form.Item></Col>
                    </Row>
                </Form>
            </Card>
        ))}
    </div>;
    const badHook = Object.values(hooks).some((h) => h && !/^https?:\/\/\S+$/i.test(h.trim()));
    return (
        <div>
            <div className="dg-toolbar">
                <Button icon={<PlusOutlined />} onClick={() => { setTab('channels'); setChans([...chans, { id: newId(), name: '', kind: 'teams', when: 'failures', enabled: true }]); }}>Add a channel</Button>
                <Tooltip title={badHook ? 'A webhook address starts with https:// (or http://)' : undefined}><Button type="primary" disabled={!dirty || !d.canSave || badHook} loading={busy === 'save'} onClick={() => { if (busy !== 'save') void save(); }}>Save</Button></Tooltip>
                {dirty && <Button onClick={() => load(false)}>Discard</Button>}
                {dirty && <Typography.Text type="warning" style={{ fontSize: 12 }}>Not saved yet</Typography.Text>}
            </div>
            <Tabs size="small" className="dg-tabs" activeKey={tab} onChange={(k) => setTab(k as 'channels' | 'log')} items={[
                { key: 'channels', label: `Channels (${chans.length})`, children: channels },
                {
                    key: 'log', label: `Recent messages (${d.deliveries.length})`, children: d.deliveries.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No messages sent yet." /> : (
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
