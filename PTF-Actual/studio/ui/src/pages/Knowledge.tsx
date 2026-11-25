/**
 * Knowledge: what the agents look up — the team's sources (this repository, other folders, the Azure DevOps wiki and
 * work items, what earlier runs and missions learned, web pages), indexed on this computer. Try a search the way an
 * agent does; every result shows where it comes from.
 */
import React from 'react';
import { Alert, App, Button, Card, Empty, Form, Input, List, Modal, Popconfirm, Progress, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { DatabaseOutlined, DeleteOutlined, EditOutlined, PlusOutlined, WarningFilled, QuestionCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { api, KnowledgeHitDef, KnowledgeKind, KnowledgeSourceDef, KnowledgeStatusDef } from '../api';
import { errText, openInEditor } from '../state';
import { useRememberedTab } from '../agents-tabs';
import { useKept } from '../kept';
import { agentsApi, InvalidKnowledgeSource, KnowledgeStatusView } from '../agents-api';
import { askChangedElsewhere, isChangedElsewhere } from '../components/ChangedElsewhere';

const KINDS: Record<KnowledgeKind, { label: string; about: string }> = {
    repo: { label: 'This repository', about: 'Features, steps, page objects, data, configuration and documents of this repository.' },
    folder: { label: 'A folder', about: 'Another folder on this computer: the application\'s code, a documentation folder.' },
    'ado-workitems': { label: 'Azure DevOps work items', about: 'Stories, bugs and test cases (a WIQL query; default: the last 180 days).' },
    'ado-wiki': { label: 'Azure DevOps wiki', about: 'The pages of the project wiki (or a named wiki).' },
    history: { label: 'Learned from runs', about: 'Failures of earlier runs, triage verdicts and notes, and what missions found and fixed.' },
    url: { label: 'Web pages', about: 'Documentation pages on the web or the intranet.' },
};
/** "1 document", "3 documents". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ago = (iso: string | null) => (!iso ? 'never' : new Date(iso).toLocaleString());

export function Knowledge() {
    const { message, modal } = App.useApp();
    const [d, setD] = React.useState<(Omit<Awaited<ReturnType<typeof api.knowledge>>, 'sources'> & { sources: KnowledgeStatusView[]; invalid?: InvalidKnowledgeSource[]; unreadable?: boolean; version?: string }) | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    // A source being added (no id yet) or changed (its id: e.g. a folder that is not there any more).
    const [adding, setAdding] = React.useState<(KnowledgeSourceDef & { includeText?: string; urlsText?: string }) | null>(null);
    // The search and its results stay when the person comes back (Back to Knowledge, the browser's Back, the menu).
    const [q, setQ] = useKept('knowledge-search-q', '');
    const [hits, setHits] = useKept<KnowledgeHitDef[] | null>('knowledge-search-hits', null);
    const [searchErr, setSearchErr] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState<Awaited<ReturnType<typeof api.readKnowledge>> | null>(null);
    const [tab, setTab] = useRememberedTab('knowledge', 'sources', ['sources', 'search'], 'knowledge');
    const load = React.useCallback(() => { api.knowledge().then((r) => { setD(r); setErr(null); }).catch((e) => setErr(errText(e))); }, []);
    React.useEffect(load, [load]);
    React.useEffect(() => { if (!d?.building) return; const t = setInterval(load, 1000); return () => clearInterval(t); }, [d, load]);
    const plain = (s: KnowledgeStatusDef): KnowledgeSourceDef => ({ id: s.id, name: s.name, kind: s.kind, enabled: s.enabled, ...(s.path ? { path: s.path } : {}), ...(s.include?.length ? { include: s.include } : {}), ...(s.query ? { query: s.query } : {}), ...(s.wiki ? { wiki: s.wiki } : {}), ...(s.urls?.length ? { urls: s.urls } : {}), ...(s.project ? { project: s.project } : {}) });
    // The whole list is saved with the version of the file this screen read: changed meanwhile (another tab, a pull) → asked.
    // onError: the problem shown where the person is (the source's dialog) instead of a toast.
    const save = async (list: KnowledgeSourceDef[], ok: string, force = false, onError?: (text: string) => void): Promise<boolean> => {
        try { await agentsApi.saveKnowledgeSources(list, d?.version, force); message.success(ok); load(); return true; }
        catch (e) {
            if (isChangedElsewhere(e)) {
                return new Promise<boolean>((resolve) => askChangedElsewhere(modal, e, 'The knowledge sources', { reload: () => { load(); resolve(false); }, overwrite: async () => resolve(await save(list, ok, true, onError)) }));
            }
            if (onError) onError(errText(e)); else message.error(errText(e));
            return false;
        }
    };
    // While the file has entries the Studio leaves out, no change can be saved (it would delete them): said up front.
    const blocked = d?.invalid?.length ? `Fix or remove the left-out ${d.invalid.length === 1 ? 'entry' : 'entries'} in ${d.file} first (${d.invalid.map((x) => `"${x.name}"`).join(', ')}): until then no change to the sources can be saved, so nothing in the file is lost.` : null;
    const building = React.useRef(false);
    const build = async (source?: string) => { if (building.current) return; building.current = true; setTimeout(() => { building.current = false; }, 1500); try { await api.buildKnowledge(source); message.info('Building the index…'); setTimeout(load, 300); } catch (e) { message.error(errText(e)); } };
    const MAX_Q = 500;
    const search = async () => {
        // Nothing to look for (empty, or only spaces): earlier results would look like this search's, so they go.
        if (!q.trim()) { setHits(null); setSearchErr(q.length ? 'Only spaces: type what to look for.' : 'Type what to look for.'); return; }
        // Results of an earlier search would look like this one's: cleared when this one cannot run.
        if (q.length > MAX_Q) { setHits(null); setSearchErr(`The search is too long: at most ${MAX_Q} characters (it has ${q.length}).`); return; }
        try { setHits((await api.searchKnowledge(q)).hits); setSearchErr(null); } catch (e) { setHits(null); setSearchErr(errText(e)); }
    };
    const removeInvalid = async (x: InvalidKnowledgeSource) => { try { await agentsApi.removeInvalidKnowledgeSource(x.index); message.success(`Removed "${x.name}" from ${d?.file ?? 'the file'}`); load(); } catch (e) { message.error(errText(e)); } };
    if (err) return <Alert type="error" showIcon message={err} />;
    if (!d) return null;
    const total = d.sources.reduce((a, s) => a + s.chunks, 0);
    return (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
            {d.problems.length > 0 && <Alert type="warning" showIcon message={d.invalid?.length ? `${d.file}: ${d.invalid.length === 1 ? '1 source is' : `${d.invalid.length} sources are`} left out until fixed (the others below work). Changes to the sources are not saved until then, so nothing in the file is lost.` : d.problems.join(' ')}
                description={d.invalid?.length ? <List size="small" dataSource={d.invalid} renderItem={(x) => (
                    <List.Item actions={[<Popconfirm key="r" title={`Remove "${x.name}" from ${d.file}?`} description="Only this entry; the others stay as written." okText="Remove" okButtonProps={{ danger: true }} onConfirm={() => removeInvalid(x)}><Button size="small" danger>Remove from the file</Button></Popconfirm>]}>
                        <Space direction="vertical" size={0}><Typography.Text strong>{x.name}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{x.problem}</Typography.Text></Space>
                    </List.Item>)} /> : undefined} />}
            <Tabs size="small" activeKey={tab} onChange={setTab} items={[{ key: 'sources', icon: <DatabaseOutlined />, label: <span>Sources <Tag bordered={false} style={{ marginInlineEnd: 0 }}>{d.sources.length}</Tag></span>, children: (
            <Card size="small" title={<Space>Sources<Tooltip title={`The sources are the team's (${d.file}: commit it to share them). The index is built on this computer, with no outside service; secret values are masked. Agents search it with knowledge_search and cite what they use.`}><QuestionCircleOutlined style={{ color: 'var(--ant-color-text-tertiary, #999)', fontWeight: 400 }} /></Tooltip></Space>} extra={<Space>
                {d.building && <Space size={6}><Typography.Text type="secondary">Indexing {d.building.source}</Typography.Text><Progress size="small" style={{ width: 120 }} percent={d.building.total ? Math.round((d.building.done / d.building.total) * 100) : 0} /></Space>}
                <Button size="small" icon={<ReloadOutlined />} disabled={!!d.building} onClick={() => build()}>Rebuild all</Button>
                <Tooltip title={blocked ?? undefined}><Button size="small" type="primary" icon={<PlusOutlined />} disabled={!!blocked} onClick={() => setAdding({ id: '', name: '', kind: 'folder', enabled: true })}>Add a source</Button></Tooltip>
            </Space>}>
                <Table<KnowledgeStatusView> size="small" rowKey="id" pagination={false} dataSource={d.sources} columns={[
                    { title: 'Source', render: (_: unknown, s) => <Space direction="vertical" size={0} style={{ minWidth: 0 }}><Typography.Text strong>{s.name}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>{KINDS[s.kind].label}{s.path ? ` · ${s.path}` : ''}{s.include?.length ? ` · ${s.include.join(', ')}` : ''}{s.urls?.length ? ` · ${s.urls.length} page(s)` : ''}</Typography.Text>
                        {/* Only this source is affected: the others work and can be changed; fix its folder or remove it. */}
                        {s.warning && <Typography.Text type="warning" role="alert" style={{ fontSize: 12 }}><WarningFilled /> {s.warning} It cannot be indexed until its folder is fixed (or remove it).</Typography.Text>}</Space> },
                    { title: 'Indexed', width: 220, render: (_: unknown, s) => s.warning && !s.builtAt ? <Tag color="warning">folder missing</Tag> : s.builtAt ? <Space direction="vertical" size={0}><span>{count(s.docs, 'document')} · {count(s.chunks, 'passage')}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{ago(s.builtAt)}</Typography.Text></Space> : <Typography.Text type="secondary">not yet</Typography.Text> },
                    { title: '', width: 70, render: (_: unknown, s) => s.errors.length ? <Tooltip title={s.errors.join(' ')}><Tag color="error">problem</Tag></Tooltip> : null },
                    { title: 'On', width: 60, render: (_: unknown, s) => <Switch size="small" checked={s.enabled !== false} onChange={(v) => save(d.sources.map((x) => (x.id === s.id ? { ...plain(x), enabled: v } : plain(x))), v ? 'Source on' : 'Source off')} /> },
                    { title: '', width: 190, render: (_: unknown, s) => <Space>
                        <Tooltip title={s.warning ? 'Fix its folder first' : undefined}><Button size="small" disabled={!!d.building || s.enabled === false || !!s.warning} onClick={() => build(s.id)}>Update</Button></Tooltip>
                        {s.kind === 'folder' && <Tooltip title={blocked ?? 'Change the source (its folder)'}><Button size="small" type="text" icon={<EditOutlined />} aria-label={`Change ${s.name}`} disabled={!!blocked} onClick={() => setAdding({ ...plain(s), includeText: s.include?.join(', ') })} /></Tooltip>}
                        <Popconfirm title={`Remove ${s.name}?`} description="Its index is deleted; agents no longer find it." okText="Remove" okButtonProps={{ danger: true }} onConfirm={() => save(d.sources.filter((x) => x.id !== s.id).map(plain), 'Removed')}>
                            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="Remove" />
                        </Popconfirm></Space> },
                ]} />
            </Card>) }, { key: 'search', icon: <SearchOutlined />, label: <span>Try a search</span>, children: (
            <Card size="small" title="Search the way an agent does" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{count(total, 'passage')}</Typography.Text>}>
                <Input.Search placeholder="Ask the way an agent would, e.g. how do we sign in as a buyer" enterButton={<><SearchOutlined /> Search</>} value={q} onChange={(e) => { setQ(e.target.value); if (searchErr) setSearchErr(null); }} onSearch={search} status={q.length > MAX_Q ? 'error' : undefined} />
                {(searchErr || q.length > MAX_Q) && <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>{searchErr ?? `At most ${MAX_Q} characters (${q.length} now).`}</Typography.Text>}
                {hits && (hits.length === 0 ? <Empty style={{ marginTop: 16 }} description="Nothing found" /> : (
                    <List style={{ marginTop: 10 }} dataSource={hits} renderItem={(h) => (
                        <List.Item actions={[<Button key="r" size="small" type="link" onClick={() => api.readKnowledge(h.id).then(setOpen).catch((e) => message.error(errText(e)))}>Read</Button>,
                            h.url ? <a key="o" href={h.url} target="_blank" rel="noreferrer">Open</a> : (h.source === 'repo' ? <Button key="e" size="small" type="link" onClick={() => openInEditor(h.path, h.lines?.[0])}>Open in editor</Button> : null)].filter(Boolean)}>
                            <List.Item.Meta title={<Space size={6} wrap><Typography.Text strong>{h.title}</Typography.Text><Tag>{h.sourceName}</Tag><Tag color="blue">{h.type}</Tag>{h.lines && <Typography.Text type="secondary" style={{ fontSize: 12 }}>lines {h.lines[0]}–{h.lines[1]}</Typography.Text>}<Typography.Text type="secondary" style={{ fontSize: 11 }}>[K:{h.id}]</Typography.Text></Space>}
                                description={<pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{h.snippet}</pre>} />
                        </List.Item>
                    )} />
                ))}
            </Card>) }]} />
            {adding && (adding.id
                ? <AddSource s={adding} editing blocked={blocked} existing={d.sources.map((x) => x.id).filter((x) => x !== adding.id)} onClose={() => setAdding(null)} onSave={async (s, onError) => { if (await save(d.sources.map((x) => (x.id === adding.id ? { ...s, id: adding.id, enabled: x.enabled } : plain(x))), `Saved ${s.name}: building its index`, false, onError)) { setAdding(null); if (d.sources.find((x) => x.id === adding.id)?.enabled !== false) void build(adding.id); } }} />
                : <AddSource s={adding} blocked={blocked} existing={d.sources.map((x) => x.id)} onClose={() => setAdding(null)} onSave={async (s, onError) => { if (await save([...d.sources.map(plain), s], `Added ${s.name}: building its index`, false, onError)) { setAdding(null); void build(s.id); } }} />)}
            <Modal open={!!open} width={860} title={open?.title} footer={null} onCancel={() => setOpen(null)}>
                {open && <><Typography.Text type="secondary">{open.path}{open.lines ? `, lines ${open.lines[0]}–${open.lines[1]}` : ''}</Typography.Text>
                    <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 520, overflow: 'auto', fontSize: 12, background: 'rgba(127,127,127,.08)', padding: 10, borderRadius: 6 }}>{open.text}</pre></>}
            </Modal>
        </Space>
    );
}

function AddSource({ s, existing, editing, blocked, onClose, onSave }: { s: KnowledgeSourceDef & { includeText?: string; urlsText?: string }; existing: string[]; editing?: boolean; blocked?: string | null; onClose: () => void; onSave: (s: KnowledgeSourceDef, onError: (text: string) => void) => void | Promise<void> }) {
    const [busy, setBusy] = React.useState(false);
    const [v0, setV0] = React.useState<KnowledgeSourceDef & { urlsText?: string; includeText?: string }>(s);
    // What the server said about the last try, next to the field it is about (cleared as the person changes things).
    const [saveErr, setSaveErr] = React.useState<string | null>(null);
    const v = v0;
    const setV = (x: typeof v0) => { setV0(x); setSaveErr(null); };
    const folderErr = saveErr && /folder|not found|no such|not a directory/i.test(saveErr) && v.kind === 'folder' ? saveErr.replace(/^Source "[^"]*": (.)/, (_m, c: string) => c.toUpperCase()) : null;
    const otherErr = saveErr && !folderErr ? saveErr : null;
    // The id from the name (or the kind's label when the name is left empty); a name with no Latin letters or digits gets a short stable code.
    const base = (v.id || v.name.trim() || KINDS[v.kind].label);
    const latin = base.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    let h = 0x811c9dc5;
    for (const ch of base) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    const id = latin.length >= 2 ? latin : `source-${h.toString(36)}`;
    const clash = existing.includes(id);
    // Sub-folders inside the folder only (the server says the same).
    const outside = (v.includeText ?? '').split(/[,\n]/).map((x) => x.trim()).filter((x) => x.includes('..'));
    const includeProblem = (v.kind === 'repo' || v.kind === 'folder') && outside.length ? `Only sub-folders inside it, without "..": ${outside.map((x) => `"${x}"`).join(', ')}.` : null;
    const go = async () => { if (busy || blocked || !id || clash || includeProblem || (v.kind === 'folder' && !v.path?.trim()) || (v.kind === 'url' && !v.urlsText?.trim())) return; setBusy(true); try { await onSave({ id, name: v.name.trim() || KINDS[v.kind].label, kind: v.kind, enabled: true,
        ...(v.kind === 'folder' && v.path ? { path: v.path.trim() } : {}),
        ...((v.kind === 'repo' || v.kind === 'folder') && v.includeText?.trim() ? { include: v.includeText.split(/[,\n]/).map((x) => x.trim()).filter(Boolean) } : {}),
        ...(v.kind === 'ado-workitems' && v.query?.trim() ? { query: v.query.trim() } : {}),
        ...(v.kind === 'ado-wiki' && v.wiki?.trim() ? { wiki: v.wiki.trim() } : {}),
        ...(v.kind === 'url' ? { urls: (v.urlsText ?? '').split(/\s+/).filter(Boolean) } : {}) }, setSaveErr); } finally { setBusy(false); } };
    return (
        <Modal open title={editing ? `Change ${s.name}` : 'Add a knowledge source'} onCancel={onClose} onOk={() => void go()} confirmLoading={busy} okText={editing ? 'Save and index' : 'Add and index'} okButtonProps={{ disabled: !!blocked || !id || clash || !!includeProblem || (v.kind === 'folder' && !v.path?.trim()) || (v.kind === 'url' && !v.urlsText?.trim()) }} width={620}>
            {blocked && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Cannot be saved yet" description={blocked} />}
            {otherErr && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={otherErr} />}
            <Form layout="vertical" size="small">
                <Form.Item label="Kind"><Select value={v.kind} disabled={editing} aria-label="Kind" onChange={(k) => setV({ ...v, kind: k })} options={(Object.keys(KINDS) as KnowledgeKind[]).map((k) => ({ value: k, label: KINDS[k].label }))} /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{KINDS[v.kind].about}</Typography.Text></Form.Item>
                <Form.Item label="Name" help={clash ? 'A source with this name exists.' : undefined} validateStatus={clash ? 'error' : undefined}><Input value={v.name} maxLength={80} aria-label="Name" placeholder={KINDS[v.kind].label} onPressEnter={() => void go()} onChange={(e) => setV({ ...v, name: e.target.value })} /></Form.Item>
                {v.kind === 'folder' && <Form.Item label="Folder" tooltip="An absolute folder, or one relative to this repository" validateStatus={folderErr ? 'error' : undefined} help={folderErr ?? undefined}><Input value={v.path} aria-label="Folder" placeholder="C:\work\shop-app  or  ../shop-app" onChange={(e) => setV({ ...v, path: e.target.value })} /></Form.Item>}
                {(v.kind === 'repo' || v.kind === 'folder') && <Form.Item label="Only these sub-folders (optional)" validateStatus={includeProblem ? 'error' : undefined} help={includeProblem ?? undefined}><Input value={v.includeText} aria-label="Only these sub-folders" placeholder="docs, src/orders" onChange={(e) => setV({ ...v, includeText: e.target.value })} /></Form.Item>}
                {v.kind === 'ado-workitems' && <Form.Item label="WIQL query (optional)"><Input.TextArea rows={3} value={v.query} aria-label="WIQL query" placeholder="SELECT [System.Id] FROM WorkItems WHERE [System.AreaPath] UNDER 'Shop\\Checkout'" onChange={(e) => setV({ ...v, query: e.target.value })} /></Form.Item>}
                {v.kind === 'ado-wiki' && <Form.Item label="Wiki name (optional)"><Input value={v.wiki} aria-label="Wiki name" placeholder="the project wiki" onChange={(e) => setV({ ...v, wiki: e.target.value })} /></Form.Item>}
                {v.kind === 'url' && <Form.Item label="Web addresses (one per line)"><Input.TextArea rows={4} value={v.urlsText} aria-label="Web addresses" placeholder="https://wiki.example.com/shop/testing" onChange={(e) => setV({ ...v, urlsText: e.target.value })} /></Form.Item>}
            </Form>
        </Modal>
    );
}
