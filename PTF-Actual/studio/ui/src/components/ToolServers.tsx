/**
 * Tool servers: outside MCP servers the Studio's agents can use (Playwright, a database, Azure DevOps, GitHub…).
 *
 *  - Add one from the ready list, paste the configuration its documentation gives (keys become Studio secrets), or
 *    fill in your own. Edit, turn off (kept, not given to agents) or remove it.
 *  - Check starts it and lists its tools. Every check is kept and compared with the last review: tools added,
 *    removed or whose parameters changed show until reviewed. Sessions that see a different tool count check again.
 *  - Tools: all of them (new ones included), or only those turned on (new ones stay off until turned on).
 *  - Team servers live in the repository (.cs-studio/mcp-servers.json, changed through pull requests); personal ones
 *    only for this person. Secrets are referenced by name ({secret:NAME}), never written in the files.
 */
import React from 'react';
import { Alert, App, Button, Checkbox, Col, Dropdown, Empty, Form, Input, Modal, Popconfirm, Radio, Row, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, DeleteOutlined, DownOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SyncOutlined, WarningFilled } from '@ant-design/icons';
import { api, ToolServerDef, ToolServerImport, ToolServerRow, ToolServersView } from '../api';
import { errText } from '../state';
import { agentsApi, ToolServerRowView } from '../agents-api';
import { askChangedElsewhere, isChangedElsewhere } from './ChangedElsewhere';
import { ago } from '../format';
import { useUnsaved } from '../unsaved';

/** The longest server name (the server says the same). */
const NAME_MAX = 40;
/** Why a server name is not right (the server checks the same), or null. */
export function serverNameProblem(n: string): string | null {
    const t = n.trim();
    if (!t) return 'Name: give the server a name.';
    if (t.length > NAME_MAX) return `Name: at most ${NAME_MAX} characters (it has ${t.length}).`;
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(t)) return 'Name: lower-case letters, digits and -, starting with a letter (2–40).';
    return null;
}

type Scope = 'team' | 'personal';
const CUSTOM = 'custom';

/** "KEY=value" lines → a record (blank lines skipped). */
function pairs(text: string, what: string): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const i = line.search(/[=:]/);
        if (i < 1) throw new Error(`${what}: write each as NAME=value.`);
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return Object.keys(out).length ? out : undefined;
}
const unpairs = (o?: Record<string, string>, sep = '=') => Object.entries(o ?? {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
const summary = (s: ToolServerDef) => (s.kind === 'http' ? s.url ?? '' : [s.command, ...(s.args ?? [])].filter(Boolean).join(' '));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

interface Custom { kind: 'stdio' | 'http'; command: string; args: string; url: string; env: string; headers: string; changes: boolean; description: string }
const customOf = (s?: ToolServerDef): Custom => ({
    kind: s?.kind ?? 'stdio', command: s?.command ?? '', args: (s?.args ?? []).join('\n'), url: s?.url ?? '',
    env: unpairs(s?.env), headers: unpairs(s?.headers, ': '), changes: s?.changes !== false, description: s?.description ?? '',
});

/** Add from the ready list or your own; or edit a server (its settings as fields). */
function ServerForm({ view, editing, onClose, onSaved, onReload }: { view: ToolServersView; editing?: ToolServerRowView; onClose: () => void; onSaved: (v: ToolServersView) => void; onReload: (name: string, scope: Scope) => void }) {
    const { message, modal } = App.useApp();
    const [from, setFrom] = React.useState<string>(editing ? CUSTOM : view.catalog[0]?.id ?? CUSTOM);
    const [name, setName] = React.useState(editing?.name ?? view.catalog[0]?.id ?? '');
    const [scope, setScope] = React.useState<Scope>(editing?.scope ?? 'personal');
    const [values, setValues] = React.useState<Record<string, string>>({});
    const [custom, setCustom] = React.useState<Custom>(customOf(editing?.server));
    const [saving, setSaving] = React.useState(false);
    // What the server refused, shown in the dialog (one message, replaced by the next: not a pile of toasts).
    const [saveErr, setSaveErr] = React.useState<string | null>(null);
    const entry = editing ? undefined : view.catalog.find((c) => c.id === from);
    const pick = (id: string) => { setFrom(id); setValues({}); if (!name || view.catalog.some((c) => c.id === name)) setName(id === CUSTOM ? '' : id); };
    // Unsaved: what the dialog started with differs from what it shows now.
    const start = React.useRef(JSON.stringify({ from, name, scope, values, custom }));
    const dirty = JSON.stringify({ from, name, scope, values, custom }) !== start.current;
    const nameProblem = serverNameProblem(name);
    const busy = React.useRef(false);
    const save = async (force = false): Promise<boolean> => {
        if (busy.current && !force) return false;
        if (nameProblem) { setSaveErr(nameProblem); return false; }
        busy.current = true;
        setSaving(true);
        try {
            let server: ToolServerDef | undefined;
            if (!entry) {
                server = {
                    kind: custom.kind, changes: custom.changes, description: custom.description || undefined,
                    // Kept as they are: the tools chosen, on/off, the ready entry it came from.
                    tools: editing?.server.tools, enabled: editing?.server.enabled, from: editing?.server.from,
                    ...(custom.kind === 'stdio'
                        ? { command: custom.command.trim(), args: custom.args.split('\n').map((a) => a.trim()).filter(Boolean), env: pairs(custom.env, 'Environment') }
                        : { url: custom.url.trim(), headers: pairs(custom.headers, 'Headers') }),
                };
            }
            // An edit sends the version of the server it started from: one changed meanwhile (another tab) is not replaced silently.
            onSaved(await agentsApi.saveToolServer(entry ? { scope, name: name.trim(), from: entry.id, values } : { scope, name: name.trim(), server, ...(editing ? { editing: editing.name } : {}) }, editing?.version, force));
            message.success(`${editing ? 'Saved' : 'Added'} ${name.trim()}`);
            setSaveErr(null);
            onClose();
            return true;
        } catch (e) {
            if (editing && isChangedElsewhere(e)) {
                busy.current = false;
                return new Promise<boolean>((resolve) => askChangedElsewhere(modal, e, `The tool server ${editing.name}`, { reload: () => { resolve(false); onReload(editing.name, editing.scope); }, overwrite: () => save(true).then(resolve), keepEditing: () => resolve(false) }));
            }
            setSaveErr(errText(e));
            return false;
        } finally { busy.current = false; setSaving(false); }
    };
    // Another screen (the menu, Back, an address typed) asks first; so do Esc and Cancel here.
    useUnsaved('tool-server-form', dirty, editing ? `the tool server ${editing.name}` : 'the new tool server', { lostOnLeave: true, save: () => save(), discard: onClose });
    const cancel = () => {
        if (!dirty) { onClose(); return; }
        modal.confirm({ title: 'Leave without saving?', content: `Your changes to ${editing ? editing.name : 'the new tool server'} are lost.`, okText: 'Discard', okButtonProps: { danger: true }, cancelText: 'Keep editing', onOk: onClose });
    };
    return (
        <Modal open title={editing ? `Edit ${editing.name}` : 'Add a tool server'} onCancel={cancel} maskClosable={!dirty} onOk={() => void save()} okText={editing ? 'Save' : 'Add'} confirmLoading={saving} okButtonProps={{ disabled: !!nameProblem }} width={620} destroyOnClose>
            <Form layout="vertical" size="small">
                {!editing && <Form.Item label="Server">
                    <Select value={from} onChange={pick} aria-label="Server"
                        options={[...view.catalog.map((c) => ({ value: c.id, label: c.title })), { value: CUSTOM, label: 'Other MCP server…' }]} />
                    {entry && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{entry.description}</Typography.Text>}
                </Form.Item>}
                <Row gutter={12}>
                    <Col span={12}><Form.Item label="Name" required tooltip="Lower-case letters, digits and -. Shown to the agent before its tools." validateStatus={nameProblem && name !== '' ? 'error' : undefined} help={nameProblem && name !== '' ? nameProblem : undefined}>
                        <Input value={name} count={{ show: true, max: NAME_MAX }} onChange={(e) => { setName(e.target.value); setSaveErr(null); }} onPressEnter={() => { if (!saving) void save(); }} placeholder="my-server" aria-label="Name" />
                    </Form.Item></Col>
                    {!editing && <Col span={12}><Form.Item label="For">
                        <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)} optionType="button" buttonStyle="solid"
                            options={[{ value: 'personal', label: 'Only me' }, { value: 'team', label: 'The team' }]} />
                    </Form.Item></Col>}
                </Row>
                {entry?.fields.map((f) => (
                    <Form.Item key={f.key} label={f.label} required={!f.optional} help={f.help}>
                        {f.kind === 'connection'
                            ? <Select value={values[f.key] || undefined} onChange={(v) => setValues({ ...values, [f.key]: v })} aria-label={f.label}
                                options={view.connections} placeholder={view.connections.length ? 'Choose' : 'No PostgreSQL connection in the projects'} />
                            : f.choices ? <Select allowClear value={values[f.key] || undefined} onChange={(v) => setValues({ ...values, [f.key]: v ?? '' })} aria-label={f.label}
                                placeholder={f.placeholder} options={f.choices.map((c) => ({ value: c, label: c }))} />
                            : <Input value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} aria-label={f.label} className={f.kind === 'secret' ? 'mono' : undefined} />}
                    </Form.Item>))}
                {!entry && <>
                    <Form.Item label="Connects by">
                        <Radio.Group value={custom.kind} onChange={(e) => setCustom({ ...custom, kind: e.target.value })}
                            options={[{ value: 'stdio', label: 'A program on this computer' }, { value: 'http', label: 'An address (HTTP)' }]} />
                    </Form.Item>
                    {custom.kind === 'stdio' ? <>
                        <Form.Item label="Program" required help="Started directly, without a shell, in the repository folder.">
                            <Input className="mono" value={custom.command} onChange={(e) => setCustom({ ...custom, command: e.target.value })} placeholder="npx" aria-label="Program" />
                        </Form.Item>
                        <Form.Item label="Arguments" help="One per line.">
                            <Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 6 }} value={custom.args} onChange={(e) => setCustom({ ...custom, args: e.target.value })} placeholder={'-y\n@scope/some-mcp-server@1.2.3'} aria-label="Arguments" />
                        </Form.Item>
                        <Form.Item label="Environment" help="NAME=value per line. For keys: NAME={secret:SECRET_NAME}.">
                            <Input.TextArea className="mono" autoSize={{ minRows: 1, maxRows: 6 }} value={custom.env} onChange={(e) => setCustom({ ...custom, env: e.target.value })} aria-label="Environment" />
                        </Form.Item>
                    </> : <>
                        <Form.Item label="Address" required help="https, or http on this computer.">
                            <Input className="mono" value={custom.url} onChange={(e) => setCustom({ ...custom, url: e.target.value })} placeholder="https://example.com/mcp" aria-label="Address" />
                        </Form.Item>
                        <Form.Item label="Headers" help="Name: value per line. For keys: Authorization: Bearer {secret:SECRET_NAME}.">
                            <Input.TextArea className="mono" autoSize={{ minRows: 1, maxRows: 6 }} value={custom.headers} onChange={(e) => setCustom({ ...custom, headers: e.target.value })} aria-label="Headers" />
                        </Form.Item>
                    </>}
                    <Form.Item label="Description">
                        <Input value={custom.description} onChange={(e) => setCustom({ ...custom, description: e.target.value })} aria-label="Description" />
                    </Form.Item>
                    <Form.Item>
                        <Space><Switch size="small" checked={custom.changes} onChange={(v) => setCustom({ ...custom, changes: v })} aria-label="Can make changes" />
                            <span>Can make changes: every call asks first</span></Space>
                    </Form.Item>
                </>}
                {saveErr && <Alert type="error" showIcon role="alert" style={{ marginBottom: 8 }} message={saveErr} closable onClose={() => setSaveErr(null)} />}
                {scope === 'team' && <Alert type="info" showIcon message={<span>Saved in <span className="mono">{view.teamFile}</span>: commit it so the team gets it. Secrets stay with each person.</span>} />}
            </Form>
        </Modal>
    );
}

/** Paste the configuration from a server's documentation (mcpServers / servers / one entry). */
function PasteConfig({ onClose, onSaved }: { onClose: () => void; onSaved: (v: ToolServersView) => void }) {
    const { message } = App.useApp();
    const [scope, setScope] = React.useState<Scope>('personal');
    const [text, setText] = React.useState('');
    const [preview, setPreview] = React.useState<ToolServerImport | null>(null);
    const [replace, setReplace] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const read = async () => {
        setBusy(true); setError(null);
        try { setPreview(await api.importToolServers(scope, text)); } catch (e) { setPreview(null); setError(errText(e)); } finally { setBusy(false); }
    };
    const add = async () => {
        setBusy(true); setError(null);
        try {
            const r = await api.importToolServers(scope, text, true, replace);
            onSaved(r as ToolServersView);
            message.success(`Added ${(r.added ?? []).join(', ')}`);
            onClose();
        } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    };
    const blocked = !preview || preview.servers.some((s) => s.problem) || (!replace && preview.servers.some((s) => s.exists));
    return (
        <Modal open title="Paste a server's configuration" onCancel={onClose} width={680} destroyOnClose
            footer={<Space><Button onClick={onClose}>Cancel</Button><Button onClick={() => void read()} loading={busy && !preview} disabled={!text.trim()}>Read</Button>
                <Button type="primary" onClick={() => void add()} loading={busy && !!preview} disabled={blocked}>Add</Button></Space>}>
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    The JSON a server's documentation gives for MCP clients ("mcpServers", "servers", or one server). Keys in it are saved as Studio secrets, not in the file.
                </Typography.Text>
                <Radio.Group value={scope} onChange={(e) => { setScope(e.target.value); setPreview(null); }} optionType="button" buttonStyle="solid" size="small"
                    options={[{ value: 'personal', label: 'Only me' }, { value: 'team', label: 'The team' }]} />
                <Input.TextArea className="mono" autoSize={{ minRows: 6, maxRows: 14 }} value={text} aria-label="Configuration" placeholder={'{\n  "mcpServers": {\n    "orders": { "command": "npx", "args": ["-y", "@example/orders-mcp"], "env": { "ORDERS_API_KEY": "…" } }\n  }\n}'}
                    onChange={(e) => { setText(e.target.value); setPreview(null); }} />
                {error && <Alert type="error" showIcon message={error} />}
                {preview?.servers.map((s) => (
                    <div key={s.name} className="item-row" style={{ display: 'block' }}>
                        <Space size={6}><span style={{ fontWeight: 500 }}>{s.name}</span>{s.exists && <Tag color="orange" bordered={false}>exists</Tag>}</Space>
                        <div><Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{summary(s.server)}</Typography.Text></div>
                        {s.problem && <Typography.Text type="danger" style={{ fontSize: 12 }}>{s.problem}</Typography.Text>}
                        {s.secrets.map((k) => (
                            <div key={k.secret + k.where} style={{ fontSize: 12 }}>
                                <Tag bordered={false} className="mono">{k.secret}</Tag>
                                {k.fromPaste ? `the ${k.where} value, saved as a Studio secret` : k.saved ? `${k.where}: the Studio secret is there` : <Typography.Text type="warning" style={{ fontSize: 12 }}>{k.where}: add this Studio secret (Secrets) before using it</Typography.Text>}
                            </div>))}
                    </div>))}
                {preview?.servers.some((s) => s.exists) && <Checkbox checked={replace} onChange={(e) => setReplace(e.target.checked)}>Replace the servers that exist</Checkbox>}
                {scope === 'team' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Team servers go in the repository file; each person adds the secrets for themselves.</Typography.Text>}
            </Space>
        </Modal>
    );
}

/** The server's tools: all (new ones included), or only those turned on. Changes since the last review are marked. */
function ToolList({ x, onSaved }: { x: ToolServerRow; onSaved: (v: ToolServersView) => void }) {
    const { message } = App.useApp();
    const known = x.state.known ?? [];
    const chosen = x.server.tools;
    const isNew = new Set(x.state.diff?.added ?? []);
    const changed = new Set(x.state.diff?.changed ?? []);
    const set = (tools: string[] | null) => api.changeToolServer(x.name, { scope: x.scope, tools }).then(onSaved).catch((e) => message.error(errText(e)));
    const on = (n: string) => !chosen || chosen.includes(n);
    return (
        <div style={{ marginTop: 6 }}>
            <Space size={8} style={{ marginBottom: 6 }}>
                <Switch size="small" checked={!chosen} aria-label="All tools" onChange={(v) => void set(v ? null : known.map((t) => t.name))} />
                <Typography.Text style={{ fontSize: 12 }}>{chosen ? `${plural(chosen.filter((n) => known.some((t) => t.name === n)).length, 'tool')} of ${known.length} on; new tools stay off until turned on` : 'All tools, new ones included'}</Typography.Text>
            </Space>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {known.map((t) => (
                    <Tooltip key={t.name} title={t.description || undefined}>
                        <Tag bordered={false} className="mono" color={!on(t.name) ? undefined : isNew.has(t.name) ? 'green' : changed.has(t.name) ? 'gold' : 'blue'}
                            style={{ cursor: 'pointer', opacity: on(t.name) ? 1 : 0.55, textDecoration: on(t.name) ? undefined : 'line-through' }}
                            onClick={() => void set(on(t.name) ? (chosen ?? known.map((k) => k.name)).filter((n) => n !== t.name) : [...(chosen ?? []), t.name])}>
                            {t.name}{isNew.has(t.name) ? ' · new' : changed.has(t.name) ? ' · changed' : ''}
                        </Tag>
                    </Tooltip>))}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>Click a tool to turn it on or off.</Typography.Text>
        </div>
    );
}

export function ToolServers() {
    const { message } = App.useApp();
    const [view, setView] = React.useState<ToolServersView | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [form, setForm] = React.useState<{ editing?: ToolServerRow } | null>(null);
    const [pasting, setPasting] = React.useState(false);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState<Record<string, boolean>>({});
    // Removing a server added by paste: its secrets go too unless unticked.
    const [keepSecrets, setKeepSecrets] = React.useState<Record<string, boolean>>({});
    const remove = async (x: ToolServerRow) => {
        const pasted = (x.server as { pastedSecrets?: string[] }).pastedSecrets ?? [];
        const withSecrets = pasted.length > 0 && !keepSecrets[`${x.scope}:${x.name}`];
        try {
            const r = await agentsApi.removeToolServer(x.name, x.scope, withSecrets);
            setView(r);
            const kept = pasted.filter((n) => !r.removedSecrets.includes(n));
            message.success(`Removed ${x.name}${r.removedSecrets.length ? `, and its secret${r.removedSecrets.length === 1 ? '' : 's'} ${r.removedSecrets.join(', ')}` : ''}${kept.length ? ` (kept the secret${kept.length === 1 ? '' : 's'} ${kept.join(', ')}${withSecrets ? ': another server uses it' : ''}; Settings › Secrets)` : ''}`);
        } catch (e) { message.error(errText(e)); }
    };
    const load = React.useCallback(() => { api.toolServers().then((v) => { setView(v); setError(null); }).catch((e) => setError(errText(e))); }, []);
    React.useEffect(load, [load]);
    // A check started by a session (its tool count changed) finishes in the background: follow it.
    React.useEffect(() => { if (!view?.servers.some((s) => s.checking)) return; const t = setTimeout(load, 3000); return () => clearTimeout(t); }, [view, load]);
    const check = async (n: string) => {
        setBusy(n);
        try {
            const r = await api.testToolServer(n);
            if (!r.ok) message.error(`${n}: ${r.error ?? 'failed'}`);
            else if (r.diff) message.warning(`${n}: the tool list changed since the last review`);
            else message.success(`${n}: ${plural(r.tools.length, 'tool')}`);
        } catch (e) { message.error(errText(e)); } finally { setBusy(null); load(); }
    };
    const checkAll = async () => { setBusy('*'); try { setView(await api.checkToolServers()); } catch (e) { message.error(errText(e)); } finally { setBusy(null); } };
    if (error) return <Alert type="error" showIcon message={error} />;
    if (!view) return null;
    const key = (x: ToolServerRow) => `${x.scope}:${x.name}`;
    return (
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                    MCP servers the Studio's agents can use. The Studio starts them for its agents; their calls show in the conversation, and those that can make changes always ask first.
                </Typography.Text>
                {view.servers.length > 0 && <Button size="small" icon={<ReloadOutlined />} loading={busy === '*'} onClick={() => void checkAll()}>Check all</Button>}
                <Dropdown menu={{ items: [{ key: 'list', label: 'From the list or your own…' }, { key: 'paste', label: 'Paste a configuration…' }], onClick: (i) => (i.key === 'paste' ? setPasting(true) : setForm({})) }}>
                    <Button size="small" icon={<PlusOutlined />}>Add <DownOutlined /></Button>
                </Dropdown>
            </div>
            {view.policy === false && <Alert type="warning" showIcon message="This repository's agent policy turns tool servers off." />}
            {!view.servers.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="None yet" /> : view.servers.map((x) => {
                const st = x.state;
                const off = x.server.enabled === false;
                const d = st.diff;
                const sessionFailed = st.session && (st.session.status === 'failed' || st.session.status === 'needs-auth');
                return (
                    <div key={key(x)} className="item-row" style={{ display: 'block', opacity: off ? 0.7 : 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <Tooltip title={off ? 'Off: not given to agents' : 'On'}>
                                <Switch size="small" checked={!off} aria-label={`${x.name} on`} onChange={(v) => void api.changeToolServer(x.name, { scope: x.scope, enabled: v }).then(setView).catch((e) => message.error(errText(e)))} />
                            </Tooltip>
                            <span style={{ fontWeight: 500 }}>{x.name}</span>
                            <Tag bordered={false}>{x.scope === 'team' ? 'Team' : 'Only me'}</Tag>
                            {x.server.changes !== false ? <Tag bordered={false} color="orange">asks first</Tag> : <Tag bordered={false}>read-only</Tag>}
                            {!x.allowed && <Tooltip title="Not in the repository's agent policy (toolServers)"><Tag color="red" bordered={false}>not allowed</Tag></Tooltip>}
                            {x.checking ? <Typography.Text type="secondary" style={{ fontSize: 12 }}><SyncOutlined spin /> checking</Typography.Text>
                                : st.ok === true ? <Typography.Text type="success" style={{ fontSize: 12 }}><CheckCircleFilled /> {plural(st.known?.length ?? 0, 'tool')}{x.server.tools ? ` (${x.server.tools.filter((n) => st.known?.some((t) => t.name === n)).length} on)` : ''} · {ago(st.checkedAt!)}</Typography.Text>
                                : st.ok === false ? <Tooltip title={st.error}><Typography.Text type="danger" style={{ fontSize: 12 }}><CloseCircleFilled /> check failed · {ago(st.checkedAt!)}</Typography.Text><Typography.Text type="danger" ellipsis style={{ fontSize: 12, display: 'block', maxWidth: 360 }}>{st.error}</Typography.Text></Tooltip>
                                : <Typography.Text type="secondary" style={{ fontSize: 12 }}>not checked yet</Typography.Text>}
                            {sessionFailed && <Tooltip title={st.session!.error}><Tag color="red" bordered={false}><WarningFilled /> {st.session!.status === 'needs-auth' ? 'needs a sign-in' : 'failed in a session'} · {ago(st.session!.at)}</Tag></Tooltip>}
                            <span style={{ flex: 1 }} />
                            <Button size="small" icon={<ReloadOutlined />} loading={busy === x.name} disabled={!!x.missing.length} onClick={() => void check(x.name)}>Check</Button>
                            <Button size="small" type="text" icon={<EditOutlined />} aria-label={`Edit ${x.name}`} onClick={() => setForm({ editing: x })} />
                            <Popconfirm title={`Remove ${x.name}?`} okText="Remove" okButtonProps={{ danger: true }} onConfirm={() => void remove(x)} description={<Space direction="vertical" size={4}>
                                {x.scope === 'team' && <span>From {view.teamFile}</span>}
                                {!!(x.server as { pastedSecrets?: string[] }).pastedSecrets?.length && <Checkbox checked={!keepSecrets[key(x)]} onChange={(e) => setKeepSecrets({ ...keepSecrets, [key(x)]: !e.target.checked })}>
                                    Also remove its secret{(x.server as { pastedSecrets?: string[] }).pastedSecrets!.length === 1 ? '' : 's'} {(x.server as { pastedSecrets?: string[] }).pastedSecrets!.join(', ')} (saved from the pasted configuration)</Checkbox>}
                            </Space>}>
                                <Button size="small" type="text" icon={<DeleteOutlined />} aria-label={`Remove ${x.name}`} />
                            </Popconfirm>
                        </div>
                        <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }} ellipsis>{summary(x.server)}</Typography.Text>
                        {!!x.missing.length && <div><Typography.Text type="warning" style={{ fontSize: 12 }}>Missing: {x.missing.join(', ')}</Typography.Text></div>}
                        {d && <Alert type="warning" showIcon style={{ marginTop: 6 }}
                            message={<span>The tool list changed since the last review{d.fromServer && d.toServer && d.fromServer !== d.toServer ? ` (${d.fromServer} → ${d.toServer})` : ''}</span>}
                            description={<Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                                {!!d.added.length && <span>New: {d.added.map((n) => <Tag key={n} bordered={false} color="green" className="mono">{n}</Tag>)}{x.server.tools ? ' off until turned on below' : ''}</span>}
                                {!!d.removed.length && <span>Gone: {d.removed.map((n) => <Tag key={n} bordered={false} className="mono">{n}</Tag>)}</span>}
                                {!!d.changed.length && <span>Changed (parameters or description): {d.changed.map((n) => <Tag key={n} bordered={false} color="gold" className="mono">{n}</Tag>)}</span>}
                            </Space>}
                            action={<Button size="small" onClick={() => void api.reviewedToolServer(x.name, x.scope).then(setView).catch((e) => message.error(errText(e)))}>Mark reviewed</Button>} />}
                        {!!st.known?.length && <div style={{ marginTop: 4 }}>
                            <Typography.Link style={{ fontSize: 12 }} onClick={() => setOpen({ ...open, [key(x)]: !open[key(x)] })}>{open[key(x)] ? 'Hide tools' : 'Tools'}</Typography.Link>
                            {open[key(x)] && <ToolList x={x} onSaved={setView} />}
                        </div>}
                    </div>);
            })}
            {form && <ServerForm key={form.editing ? `${form.editing.scope}:${form.editing.name}:${(form.editing as ToolServerRowView).version ?? ''}` : 'new'} view={view} editing={form.editing} onClose={() => setForm(null)} onSaved={setView}
                onReload={(name, scope) => { api.toolServers().then((v) => { setView(v); const x = v.servers.find((y) => y.name === name && y.scope === scope); setForm(x ? { editing: x } : null); if (!x) message.warning(`${name} was removed meanwhile.`); }).catch((e) => message.error(errText(e))); }} />}
            {pasting && <PasteConfig onClose={() => setPasting(false)} onSaved={setView} />}
        </Space>
    );
}
