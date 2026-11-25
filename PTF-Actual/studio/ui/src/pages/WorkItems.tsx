/**
 * Azure DevOps work items (read-only), filtered like a board (see WorkItems). For an item: its
 * details, a test case's steps, linked items, and whether a scenario in this repository automates
 * it (@TestCaseId). Create a branch for the item, or copy a test case as a scenario.
 */
import React from 'react';
import { Alert, App, Badge, Button, Checkbox, Empty, Input, Modal, Segmented, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography, Form } from 'antd';
import { SearchOutlined, FilterOutlined, BranchesOutlined, CheckCircleFilled, CloseOutlined, CopyOutlined, ExportOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, BoardsMeta, ItemFilter, ItemQueryResult, Sprint, TeamMeta, WorkItemDetail, WorkItemSummary } from '../api';
import { firstName } from '../format';
import { cameFrom, navigate, useRoute } from '../route';
import { ErrorAlert } from '../components/ErrorAlert';
import { AdoNotSetUp, isAdoNotSetUp } from '../datagit-common';
import { Split } from '../components/Split';
import { errText, openInEditor, useStudio } from '../state';

const TYPE_COLORS: Record<string, string> = { 'User Story': 'blue', Bug: 'red', Task: 'gold', 'Test Case': 'purple', 'Test Suite': 'geekblue', 'Test Plan': 'cyan', Epic: 'orange', Feature: 'volcano', Issue: 'magenta' };
const typeTag = (t: string) => <Tag color={TYPE_COLORS[t] ?? 'default'} style={{ marginInlineEnd: 0 }}>{t}</Tag>;

function Automation({ item }: { item: WorkItemSummary }) {
    if (item.type !== 'Test Case') return null;
    const inRepo = item.automatedIn ?? [];
    const ado = item.automationStatus ? ` Azure DevOps says: ${item.automationStatus}.` : '';
    // One label: automated in this repository, said to be automated elsewhere, or manual.
    if (inRepo.length) return <Tooltip title={<>{inRepo.map((x) => <div key={`${x.file}:${x.line}`}>{x.file}:{x.line} — {x.name}</div>)}{ado}</>}><Tag bordered={false} color="success" icon={<CheckCircleFilled />}>Automated here</Tag></Tooltip>;
    if (/^automated$/i.test(item.automationStatus ?? '')) return <Tooltip title={`No scenario in this repository has @TestCaseId:${item.id}.${ado}`}><Tag bordered={false} color="warning">Not in this repo</Tag></Tooltip>;
    return <Tooltip title={`No scenario in this repository has @TestCaseId:${item.id}.${ado}`}><Typography.Text type="secondary" style={{ fontSize: 12 }}>Manual</Typography.Text></Tooltip>;
}

function Text({ text, empty }: { text?: string; empty: string }) {
    return text ? <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{text}</div> : <Typography.Text type="secondary">{empty}</Typography.Text>;
}


/** Change a work item's state, assignee, iteration, area, priority, tags (and add a comment), safely: never over someone's newer change. */
function EditItem({ d, onSaved }: { d: WorkItemDetail; onSaved: () => void }) {
    const { message } = App.useApp();
    const [open, setOpen] = React.useState(false);
    const [opts, setOpts] = React.useState<Awaited<ReturnType<typeof api.workItemEditOptions>> | null>(null);
    const [v, setV] = React.useState({ state: d.state, assignedTo: d.assignedToEmail ?? '', iteration: d.iteration ?? '', area: d.area ?? '', priority: d.priority, tags: d.tags, comment: '' });
    const [busy, setBusy] = React.useState(false);
    const start = () => {
        setV({ state: d.state, assignedTo: d.assignedToEmail ?? '', iteration: d.iteration ?? '', area: d.area ?? '', priority: d.priority, tags: d.tags, comment: '' });
        setOpen(true);
        if (!opts) api.workItemEditOptions(d.id, d.type).then(setOpts, (e) => message.error(errText(e)));
    };
    const save = async () => {
        const changes: Parameters<typeof api.workItemUpdate>[1] = {};
        if (v.state !== d.state) changes.state = v.state;
        if (v.assignedTo !== (d.assignedToEmail ?? '')) changes.assignedTo = v.assignedTo;
        if (v.iteration !== (d.iteration ?? '')) changes.iteration = v.iteration;
        if (v.area !== (d.area ?? '')) changes.area = v.area;
        if (v.priority !== d.priority && v.priority !== undefined) changes.priority = v.priority;
        if (JSON.stringify(v.tags) !== JSON.stringify(d.tags)) changes.tags = v.tags;
        if (v.comment.trim()) changes.comment = v.comment.trim();
        if (!Object.keys(changes).length) { setOpen(false); return; }
        setBusy(true);
        try { await api.workItemUpdate(d.id, changes, d.rev); message.success(`#${d.id} updated`); setOpen(false); onSaved(); }
        catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    return (
        <>
            <Button onClick={start}>Edit</Button>
            <Modal open={open} title={`Edit #${d.id} · ${d.title}`} okText="Save" onOk={() => void save()} okButtonProps={{ loading: busy }} onCancel={() => setOpen(false)} width={620}>
                {!opts ? <Spin /> : <Form layout="vertical" size="small">
                    <Space wrap>
                        <Form.Item label="State"><Select style={{ width: 160 }} value={v.state} onChange={(x) => setV({ ...v, state: x })} options={opts.states.map((s) => ({ value: s.name, label: s.name }))} /></Form.Item>
                        <Form.Item label="Assigned to"><Select style={{ width: 240 }} showSearch allowClear value={v.assignedTo || undefined} onChange={(x) => setV({ ...v, assignedTo: x ?? '' })} placeholder="Nobody" optionFilterProp="label"
                            options={[...(v.assignedTo && !opts.people.some((p) => p.email === v.assignedTo) ? [{ value: v.assignedTo, label: d.assignedTo ?? v.assignedTo }] : []), ...opts.people.map((p) => ({ value: p.email, label: `${p.name} (${p.email})` }))]} /></Form.Item>
                        <Form.Item label="Priority"><Select style={{ width: 90 }} value={v.priority} onChange={(x) => setV({ ...v, priority: x })} options={[1, 2, 3, 4].map((p) => ({ value: p, label: String(p) }))} /></Form.Item>
                    </Space>
                    <Form.Item label="Iteration"><Select showSearch value={v.iteration} onChange={(x) => setV({ ...v, iteration: x })} options={opts.iterations.map((p) => ({ value: p, label: p }))} /></Form.Item>
                    <Form.Item label="Area"><Select showSearch value={v.area} onChange={(x) => setV({ ...v, area: x })} options={opts.areas.map((p) => ({ value: p, label: p }))} /></Form.Item>
                    <Form.Item label="Tags"><Select mode="tags" value={v.tags} onChange={(x: string[]) => setV({ ...v, tags: x })} tokenSeparators={[';', ',']} /></Form.Item>
                    <Form.Item label="Comment (optional)"><Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} value={v.comment} onChange={(e) => setV({ ...v, comment: e.target.value })} /></Form.Item>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>If someone changes #{d.id} before you save, the save is refused instead of overwriting their change.</Typography.Text>
                </Form>}
            </Modal>
        </>
    );
}

function Detail({ id, onOpen, onClose }: { id: number; onOpen: (id: number) => void; onClose?: () => void }) {
    const { message } = App.useApp();
    const { refresh } = useStudio();
    const [d, setD] = React.useState<WorkItemDetail | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [branch, setBranch] = React.useState<{ name: string } | null>(null);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        let cancelled = false;
        setD(null); setErr(null);
        api.workItem(id).then((x) => { if (!cancelled) setD(x); }).catch((e) => { if (!cancelled) setErr(errText(e)); });
        return () => { cancelled = true; };
    }, [id]);
    if (err) return <Alert type="error" showIcon message={`Could not load #${id}`} description={err} />;
    if (!d) return <Spin style={{ margin: 40 }} />;

    const isTest = d.type === 'Test Case';
    const tabs = [
        { key: 'details', label: 'Details', children: <Space direction="vertical" size={14} style={{ display: 'flex' }}>
            <div><Typography.Text strong>Description</Typography.Text><Text text={d.description} empty="No description." /></div>
            {(d.acceptanceCriteria || d.type === 'User Story') && <div><Typography.Text strong>Acceptance criteria</Typography.Text><Text text={d.acceptanceCriteria} empty="No acceptance criteria." /></div>}
            {d.reproSteps && <div><Typography.Text strong>Repro steps</Typography.Text><Text text={d.reproSteps} empty="" /></div>}
        </Space> },
        ...(isTest ? [{ key: 'steps', label: <span>Test steps <Tag style={{ marginInlineEnd: 0 }}>{d.steps?.length ?? 0}</Tag></span>, children: d.steps?.length
            ? <Space direction="vertical" style={{ width: '100%' }}>
                <Table size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={d.steps}
                    columns={[{ title: '#', width: 40, render: (_v, _r, i) => i + 1 }, { title: 'Action', dataIndex: 'action', render: (t: string) => <span className="mono" style={{ whiteSpace: 'pre-wrap' }}>{t}</span> }, { title: 'Expected result', dataIndex: 'expected', render: (t: string) => <span style={{ whiteSpace: 'pre-wrap' }}>{t}</span> },
                        { title: 'Shared steps', width: 170, render: (_v, s) => (s.shared ? <Tag color="purple">#{s.shared.id}{s.shared.title ? ` ${s.shared.title}` : ''}</Tag> : null) }]} />
                {d.parameters?.names.length ? <div>
                    <Typography.Text strong>Parameters</Typography.Text>{d.parameters.sharedSet && <Typography.Text type="secondary"> · from the shared parameter set #{d.parameters.sharedSet.id}{d.parameters.sharedSet.title ? ` ${d.parameters.sharedSet.title}` : ''}</Typography.Text>}
                    <Table size="small" pagination={false} rowKey={(_, i) => String(i)} dataSource={d.parameters.rows} columns={d.parameters.names.map((n) => ({ title: `@${n}`, dataIndex: n }))} />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>The drafted scenario is a Scenario Outline with these rows as Examples; publishing it back keeps them in step.</Typography.Text>
                </div> : null}
            </Space>
            : <Typography.Text type="secondary">This test case has no steps in Azure DevOps.</Typography.Text> }] : []),
        ...(isTest ? [{ key: 'automation', label: 'Automation', children: <Space direction="vertical" size={10} style={{ display: 'flex' }}>
            <Typography.Text>Azure DevOps says: <b>{d.automationStatus ?? 'not set'}</b>{d.automatedTestName ? <> — automated test name <Typography.Text code>{d.automatedTestName}</Typography.Text></> : null}</Typography.Text>
            {(d.automatedIn ?? []).length > 0 ? <div>
                <Typography.Text>Scenarios in this repository tagged <Typography.Text code>@TestCaseId:{d.id}</Typography.Text>:</Typography.Text>
                {(d.automatedIn ?? []).map((s) => <div key={`${s.file}:${s.line}`}><Typography.Link onClick={() => openInEditor(s.file, s.line)} className="mono">{s.file}:{s.line}</Typography.Link> — {s.name}</div>)}
            </div> : <Alert type="info" showIcon message="No scenario in this repository is tagged with this test case yet."
                description="Copy it as a scenario below and paste it into a feature file. The @TestCaseId tag lets the framework report results back to this test case." />}
            {d.scenario && <div>
                <Space style={{ marginBottom: 4 }}>
                    <Typography.Text strong>As a scenario</Typography.Text>
                    <Button size="small" icon={<CopyOutlined />} onClick={async () => { try { await navigator.clipboard.writeText(d.scenario!); message.success('Scenario copied'); } catch { message.error('Could not copy; select the text instead.'); } }}>Copy</Button>
                </Space>
                <pre className="mono" style={{ margin: 0, padding: 10, background: 'rgba(127,127,127,0.08)', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap' }}>{d.scenario}</pre>
            </div>}
        </Space> }] : []),
        { key: 'links', label: <span>Links <Tag style={{ marginInlineEnd: 0 }}>{d.related.length}</Tag></span>, children: d.related.length
            ? <Space direction="vertical" size={4} style={{ display: 'flex' }}>{d.related.map((r, i) => <Space key={i} size={8}>
                <Typography.Text type="secondary" style={{ minWidth: 110, display: 'inline-block' }}>{r.kind}</Typography.Text>
                {r.item ? <>{typeTag(r.item.type)}<Typography.Link onClick={() => onOpen(r.item!.id)}>#{r.item.id} {r.item.title}</Typography.Link><Tag>{r.item.state}</Tag></> : <Typography.Text type="secondary">#{r.id} (not readable)</Typography.Text>}
            </Space>)}</Space>
            : <Typography.Text type="secondary">No linked work items.</Typography.Text> },
    ];
    return (
        <div>
            <Space direction="vertical" size={4} style={{ display: 'flex', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Space size={8} wrap style={{ flex: 1 }}>{typeTag(d.type)}<Typography.Text type="secondary">#{d.id}</Typography.Text><Tag>{d.state}</Tag>{d.priority !== undefined && <Tag>P{d.priority}</Tag>}<Automation item={d} /></Space>
                    {onClose && <Tooltip title="Close (back to the full list)"><Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} aria-label="Close details" /></Tooltip>}
                </div>
                <Typography.Title level={5} style={{ margin: 0 }}>{d.title}</Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{d.assignedTo ?? 'Unassigned'}{d.area ? ` · ${d.area}` : ''}{d.iteration ? ` · ${d.iteration}` : ''}</Typography.Text>
                {d.tags.length > 0 && <Space size={4} wrap>{d.tags.map((t) => <Tag key={t} bordered={false}>{t}</Tag>)}</Space>}
                <Space style={{ marginTop: 4 }}>
                    <Button icon={<BranchesOutlined />} onClick={() => setBranch({ name: d.branchName })}>Create branch</Button>
                    <EditItem d={d} onSaved={() => api.workItem(id).then(setD).catch((e) => setErr(errText(e)))} />
                    <Button icon={<ExportOutlined />} href={d.url} target="_blank" rel="noreferrer">Open in Azure DevOps</Button>
                </Space>
            </Space>
            <Tabs size="small" items={tabs} />
            <Modal open={!!branch} title={`Create a branch for #${d.id}`} okText="Create and switch" confirmLoading={busy} onCancel={() => setBranch(null)}
                okButtonProps={{ disabled: !branch?.name.trim() }}
                onOk={async () => {
                    setBusy(true);
                    try { await api.createBranch(branch!.name.trim()); message.success(`Created and switched to ${branch!.name.trim()}`); setBranch(null); await refresh(); }
                    catch (e) { message.error(errText(e)); }
                    finally { setBusy(false); }
                }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary">Starts from the branch you are on. Mention <Typography.Text code>#{d.id}</Typography.Text> in your commit messages to link them to this work item.</Typography.Text>
                    <Input aria-label="Branch name" value={branch?.name ?? ''} onChange={(e) => setBranch({ name: e.target.value.replace(/^\s+/, '').replace(/\s+/g, '-') })} className="mono" />
                </Space>
            </Modal>
        </div>
    );
}

const PAGE = 100;
const DEFAULT_FILTER: ItemFilter = { assigned: 'me', open: true, order: 'changed' };
const fmtDay = (d?: string) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const sprintLabel = (s: Sprint) => `${s.name}${s.start && s.finish ? ` · ${fmtDay(s.start)} – ${fmtDay(s.finish)}` : ''}`;
const lastSeg = (p?: string) => (p ?? '').split('\\').pop() ?? '';
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

/**
 * Work items of any Azure DevOps project, filtered like a board: team, sprint, area, type, state,
 * assigned to, tags, text, recently changed. Azure DevOps runs the query; only the page on screen
 * is downloaded. The filter is remembered per project.
 */
export function WorkItems() {
    const { env: disc } = useStudio();
    // The open item is part of the address (#/work/<id>): Back returns to the previous one.
    const route = useRoute();
    const sel = route[0] === 'work' && /^\d+$/.test(route[1] ?? '') ? Number(route[1]) : null;
    const setSel = (id: number | null) => navigate(['work', id ?? undefined]);
    // Opened for one item from another screen (a test case in Test plans, a pull request's item…): the list shows
    // that item only, so it is not lost among the rest; "Show all work items" goes back to the usual list.
    const [focus, setFocus] = React.useState<number | null>(() => (cameFrom() && sel ? sel : null));
    React.useEffect(() => { if (cameFrom() && sel) setFocus(sel); }, [route.join('/')]); // eslint-disable-line react-hooks/exhaustive-deps

    const [projects, setProjects] = React.useState<{ projects: string[]; configured: string } | null>(null);
    const [adoProject, setAdoProjectRaw] = React.useState<string | undefined>(() => load<string | undefined>('cs-studio-wi-project', undefined));
    const [meta, setMeta] = React.useState<BoardsMeta | null>(null);
    const [teamMeta, setTeamMeta] = React.useState<TeamMeta | null>(null);
    const [areas, setAreas] = React.useState<string[] | null>(null);
    const [f, setFRaw] = React.useState<ItemFilter>(DEFAULT_FILTER);
    const [text, setText] = React.useState('');
    const [page, setPage] = React.useState(1);
    const [res, setRes] = React.useState<ItemQueryResult | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [metaRev, setMetaRev] = React.useState(0);
    const [showMore, setShowMoreRaw] = React.useState(() => load<boolean>('cs-studio-wi-more-filters', false));
    const setShowMore = (v: boolean) => { setShowMoreRaw(v); save('cs-studio-wi-more-filters', v); };
    const project = adoProject ?? meta?.adoProject;

    const setF = (next: ItemFilter) => { setFocus(null); setFRaw(next); setPage(1); if (project) save(`cs-studio-wi-filter:${project}`, next); };
    const setAdoProject = (p: string | undefined) => { setAdoProjectRaw(p); save('cs-studio-wi-project', p); setMeta(null); setTeamMeta(null); setAreas(null); setRes(null); };

    // Project: teams and types; then the filter saved for that project.
    React.useEffect(() => {
        let gone = false;
        setErr(null);
        api.boardsMeta(adoProject).then((m) => {
            if (gone) return;
            setMeta(m);
            const saved = load<ItemFilter | null>(`cs-studio-wi-filter:${m.adoProject}`, null);
            setFRaw(saved && (!saved.team || m.teams.includes(saved.team)) ? saved : DEFAULT_FILTER);
            setText(saved?.text ?? '');
        }).catch((e) => { if (!gone) { setErr(errText(e)); setLoading(false); } });
        return () => { gone = true; };
    }, [adoProject, metaRev]);
    React.useEffect(() => {
        if (!f.team || !meta) { setTeamMeta(null); return; }
        let gone = false;
        api.boardsTeam(f.team, adoProject).then((t) => { if (!gone) setTeamMeta(t); }).catch((e) => { if (!gone) setErr(errText(e)); });
        return () => { gone = true; };
    }, [f.team, meta, adoProject]);
    const run = React.useCallback(async () => {
        if (!meta) return;
        // "Current sprint" needs the team's sprints first.
        if (f.sprint === 'current' && f.team && !teamMeta) return;
        setLoading(true); setErr(null);
        try { setRes(await api.queryWorkItems(focus ? { text: String(focus), open: false, assigned: 'any' } : f, { skip: (page - 1) * PAGE, take: PAGE }, adoProject)); }
        catch (e) { setErr(errText(e)); setRes(null); }
        finally { setLoading(false); }
    }, [f, page, meta, teamMeta, adoProject, focus]);
    React.useEffect(() => { void run(); }, [run]);

    if (disc && disc.projects.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 80 }} description="No framework project found under config/. The Azure DevOps settings (ADO_ORGANIZATION, ADO_PROJECT) are read from there." />;

    const types = meta?.types ?? [];
    const chosenTypes = f.types?.length ? types.filter((t) => f.types!.includes(t.name)) : types;
    const stateNames = [...new Set(chosenTypes.flatMap((t) => t.states.map((x) => x.name)))];
    const sprints = teamMeta?.sprints ?? [];
    const quick = (name: string, next: ItemFilter) => <Button size="small" type={JSON.stringify({ ...next, text: undefined }) === JSON.stringify({ ...f, text: undefined }) ? 'primary' : 'default'} ghost={JSON.stringify({ ...next, text: undefined }) === JSON.stringify({ ...f, text: undefined })} onClick={() => { setText(''); setF(next); }}>{name}</Button>;
    const myTeam = f.team ?? meta?.defaultTeam ?? meta?.teams[0];
    // Filters behind "More filters": how many are set, so a hidden filter is never a surprise.
    const moreCount = [f.areas?.length, f.types?.length, f.states?.length, f.tags?.length, f.changedDays, f.open === false, (f.order ?? 'changed') !== 'changed'].filter(Boolean).length;
    const focusBanner = focus ? <Alert type="info" showIcon banner message={<span>Showing work item <b>{focus}</b> only, as opened from another screen.</span>}
        action={<Button size="small" onClick={() => setFocus(null)}>Show all work items</Button>} /> : null;

    // Azure DevOps not set up here: one short state with the way to set it up, not an error under empty filters.
    if (isAdoNotSetUp(err) && !res?.items.length) return <div>{focusBanner}<AdoNotSetUp what="Work items" error={err!} onRetry={() => { setErr(null); if (meta) void run(); else setMetaRev((x) => x + 1); }} /></div>;

    return (
        <WithDetail open={sel !== null} detail={sel ? <Detail key={sel} id={sel} onOpen={setSel} onClose={() => setSel(null)} /> : null}>
            <div className="panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
                <div className="toolbar" style={{ display: 'block' }}>
                    <div className="filter-row">
                        <Select showSearch size="small" style={{ width: 170 }} value={project} placeholder="Project" aria-label="Azure DevOps project"
                            onDropdownVisibleChange={(o) => { if (o && !projects) api.adoProjects().then(setProjects).catch((e) => setErr(errText(e))); }}
                            onChange={(v) => setAdoProject(v === projects?.configured ? undefined : v)}
                            options={(projects?.projects ?? (project ? [project] : [])).map((p) => ({ value: p, label: p === (projects?.configured ?? meta?.adoProject) && !adoProject ? `${p} (from config)` : p }))} />
                        <Select showSearch allowClear size="small" style={{ width: 170 }} placeholder="All teams" aria-label="Team" value={f.team}
                            onChange={(v) => setF({ ...f, team: v, sprint: v ? f.sprint : undefined, areas: undefined })}
                            options={(meta?.teams ?? []).map((t) => ({ value: t, label: t }))} />
                        <Tooltip title={!f.team ? 'Choose a team to pick one of its sprints' : undefined}>
                            <Select size="small" style={{ width: 230 }} aria-label="Sprint" disabled={!f.team} value={f.sprint ?? 'any'} onChange={(v) => setF({ ...f, sprint: v === 'any' ? undefined : v })}
                                options={[
                                    { value: 'any', label: 'Any sprint' },
                                    ...(teamMeta?.current ? [{ value: 'current', label: `Current: ${sprintLabel(teamMeta.current)}` }] : []),
                                    ...(sprints.some((s) => s.timeFrame === 'future') ? [{ label: 'Upcoming', options: sprints.filter((s) => s.timeFrame === 'future').map((s) => ({ value: s.path, label: sprintLabel(s) })) }] : []),
                                    ...(sprints.some((s) => s.timeFrame === 'past') ? [{ label: 'Past', options: sprints.filter((s) => s.timeFrame === 'past').map((s) => ({ value: s.path, label: sprintLabel(s) })) }] : []),
                                    ...(sprints.some((s) => !s.timeFrame) ? [{ label: 'No dates', options: sprints.filter((s) => !s.timeFrame).map((s) => ({ value: s.path, label: s.name })) }] : []),
                                ]} />
                        </Tooltip>
                        <Select size="small" style={{ width: 130 }} aria-label="Assigned to" value={f.assigned ?? 'any'} onChange={(v) => setF({ ...f, assigned: v })}
                            options={[{ value: 'any', label: 'Anyone' }, { value: 'me', label: 'Assigned to me' }, { value: 'unassigned', label: 'Unassigned' }]} />
                        <Input.Search size="small" allowClear style={{ width: 220 }} placeholder="ID or words in the title" aria-label="Search" enterButton={<Button size="small" aria-label="Search work items" icon={<SearchOutlined />} />} value={text}
                            onChange={(e) => { setText(e.target.value); if (!e.target.value) setF({ ...f, text: undefined }); }} onSearch={(v) => setF({ ...f, text: v.trim() || undefined })} />
                        <Badge count={moreCount} size="small" color="#93186C" offset={[-4, 2]}>
                            <Button size="small" icon={<FilterOutlined />} aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>{showMore ? 'Fewer filters' : 'More filters'}</Button>
                        </Badge>
                    </div>
                    {showMore && <div className="filter-row">
                        <Select mode="multiple" allowClear showSearch size="small" style={{ minWidth: 180, maxWidth: 320 }} maxTagCount="responsive" aria-label="Area"
                            placeholder={f.team ? `${f.team}'s areas` : 'All areas'} value={f.areas ?? []}
                            onDropdownVisibleChange={(o) => { if (o && !areas) api.boardsAreas(adoProject).then((r) => setAreas(r.areas)).catch((e) => setErr(errText(e))); }}
                            onChange={(v: string[]) => setF({ ...f, areas: v.length ? v : undefined })}
                            notFoundContent={areas ? undefined : <Spin size="small" />}
                            options={(areas ?? []).map((a) => ({ value: a, label: a }))} />
                        <Select mode="multiple" allowClear size="small" style={{ minWidth: 150, maxWidth: 300 }} maxTagCount="responsive" placeholder="All types" aria-label="Type" value={f.types ?? []}
                            onChange={(v: string[]) => setF({ ...f, types: v.length ? v : undefined, states: undefined })} options={types.map((t) => ({ value: t.name, label: t.name }))} />
                        <Select mode="multiple" allowClear size="small" style={{ minWidth: 140, maxWidth: 280 }} maxTagCount="responsive" aria-label="State"
                            placeholder={f.open === false ? 'Any state' : 'Open (not done)'} value={f.states ?? []}
                            onChange={(v: string[]) => setF({ ...f, states: v.length ? v : undefined })} options={stateNames.map((x) => ({ value: x, label: x }))} />
                        <Select mode="tags" allowClear size="small" style={{ minWidth: 120, maxWidth: 240 }} maxTagCount="responsive" placeholder="Tags" aria-label="Tags" value={f.tags ?? []} open={false} suffixIcon={null}
                            onChange={(v: string[]) => setF({ ...f, tags: v.length ? v : undefined })} />
                        <Select size="small" style={{ width: 130 }} aria-label="Changed" value={f.changedDays ?? 0} onChange={(v) => setF({ ...f, changedDays: v || undefined })}
                            options={[{ value: 0, label: 'Any time' }, { value: 1, label: 'Changed today' }, { value: 7, label: 'Last 7 days' }, { value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' }]} />
                        <Select size="small" style={{ width: 140 }} aria-label="Sort" value={f.order ?? 'changed'} onChange={(v) => setF({ ...f, order: v })}
                            options={[{ value: 'changed', label: 'Recently changed' }, { value: 'priority', label: 'Priority' }, { value: 'id', label: 'Newest' }]} />
                        <Checkbox checked={f.open === false} disabled={!!f.states?.length} onChange={(e) => setF({ ...f, open: !e.target.checked })}>Include done</Checkbox>
                    </div>}
                    <div className="filter-row" style={{ marginTop: 6 }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Quick:</Typography.Text>
                        {quick('My open items', DEFAULT_FILTER)}
                        {myTeam && quick('Current sprint', { team: myTeam, sprint: 'current', open: true, order: 'priority', assigned: 'any' })}
                        {quick('Test cases', { types: ['Test Case'], open: true, order: 'changed', assigned: 'any', ...(f.team ? { team: f.team } : {}) })}
                        {quick('Bugs', { types: ['Bug'], open: true, order: 'priority', assigned: 'any', ...(f.team ? { team: f.team } : {}) })}
                        <div style={{ flex: 1 }} />
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {loading ? 'Loading…' : res ? `${res.total}${res.capped ? '+' : ''} item${res.total === 1 ? '' : 's'}${res.sprint ? ` · ${sprintLabel(res.sprint)}` : ''}` : ''}
                        </Typography.Text>
                        <Tooltip title="Refresh"><Button aria-label="Refresh" size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void run()} /></Tooltip>
                    </div>
                </div>
                {focusBanner}
                {err && <ErrorAlert style={{ margin: 10 }} title="Azure DevOps" error={err} />}
                {res?.capped && <Alert type="info" showIcon banner message={`More than ${res.total} items match. Narrow the filter (team, sprint, area or type) to see them all.`} />}
                <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                    <Table<WorkItemSummary> size="small" rowKey="id" loading={loading} dataSource={res?.items ?? []} sticky
                        pagination={(res?.total ?? 0) > PAGE ? { current: page, pageSize: PAGE, total: res?.total ?? 0, showSizeChanger: false, size: 'small', onChange: setPage, style: { marginRight: 12 } } : false}
                        locale={{ emptyText: loading ? ' ' : err ? 'Nothing to show until Azure DevOps answers (see above).' : res?.doneMatches ? <span>No open items match. {res.doneMatches} done item{res.doneMatches === 1 ? '' : 's'} match{res.doneMatches === 1 ? 'es' : ''}. <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setF({ ...f, open: false })}>Show {res.doneMatches === 1 ? 'it' : 'them'}</Button></span> : 'No work items match this filter.' }}
                        onRow={(r) => ({ onClick: () => setSel(r.id), style: { cursor: 'pointer', background: r.id === sel ? 'var(--row-sel)' : undefined } })}
                        columns={[
                            { title: 'ID', dataIndex: 'id', width: 72 },
                            { title: 'Type', dataIndex: 'type', width: 104, render: typeTag },
                            { title: 'Title', dataIndex: 'title', ellipsis: true },
                            { title: 'State', dataIndex: 'state', width: 88, render: (st: string, r) => { const c = types.find((t) => t.name === r.type)?.states.find((x) => x.name === st)?.color; return <span className="state-dot" style={{ ['--dot' as string]: c ? `#${c}` : 'var(--muted)' }}>{st}</span>; } },
                            { title: 'Assigned', dataIndex: 'assignedTo', width: 100, ellipsis: true, render: (n?: string) => n ? <Tooltip title={n}>{firstName(n)}</Tooltip> : <Typography.Text type="secondary">—</Typography.Text> },
                            { title: 'Sprint', dataIndex: 'iteration', width: 90, ellipsis: true, render: (i?: string) => i && i.includes('\\') ? <Tooltip title={i}>{lastSeg(i)}</Tooltip> : <Tooltip title="Not in a sprint"><Typography.Text type="secondary">—</Typography.Text></Tooltip> },
                            { title: 'Automation', width: 128, render: (_v, r) => <Automation item={r} /> },
                        ]} />
                </div>
            </div>
        </WithDetail>
    );
}

/** The list alone, or the list and an item's details side by side (resizable). */
function WithDetail({ open, detail, children }: { open: boolean; detail: React.ReactNode; children: React.ReactNode }) {
    const h = { height: 'calc(100vh - var(--chrome) - 8px)' };
    if (!open) return <div style={{ ...h, display: 'flex', minHeight: 0 }}>{children}</div>;
    return (
        <Split id="wi-detail" sizeOf="second" initial={520} min={360} max={1000} style={h}>
            {children}
            <div className="panel" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 14, height: '100%' }}>{detail}</div>
        </Split>
    );
}
