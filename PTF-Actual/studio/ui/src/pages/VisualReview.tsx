/**
 * Visual review: the framework's visual baselines next to what the last run saw (side by side, a slider, or
 * the changed pixels), with the structure changes, to approve a change as the new baseline; and the
 * accessibility checks: the issues the runs found per page, and the accessibility (aria) snapshots that changed.
 */
import React from 'react';
import { Alert, App, Button, Card, Drawer, Empty, Segmented, Slider, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CheckOutlined, ExportOutlined, LikeOutlined, ReloadOutlined } from '@ant-design/icons';
import { A11yCheck, api, ApiError, AriaSnapshotInfo, VisualSnapshot, VisualStatus } from '../api';
import { errText } from '../state';
import { navigate, useRoute } from '../route';
import '../styles-tests.css';

const STATUS: Record<VisualStatus, { label: string; color: string; about: string }> = {
    changed: { label: 'Changed', color: 'error', about: 'The last run\'s screenshot differs from the baseline and the check failed.' },
    new: { label: 'New baseline', color: 'warning', about: 'There was no baseline: the run\'s screenshot became it without a comparison. Check it shows the page as it should be.' },
    cosmetic: { label: 'Cosmetic change', color: 'processing', about: 'Pixels differ but the check passed (the picture is similar and the structure is the same).' },
    same: { label: 'Same', color: 'success', about: 'The last run matched the baseline.' },
};
const VERDICT: Record<string, string> = {
    structural_change: 'Structure changed', visual_change: 'Looks different', cosmetic_only: 'Cosmetic only', identical: 'Identical',
};
const IMPACT: Record<string, string> = { critical: 'red', serious: 'volcano', moderate: 'gold', minor: 'default' };
const ago = (iso?: string) => {
    if (!iso) return '–';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const pct = (p: number) => (p > 0 && p < 0.01 ? '<0.01' : p.toFixed(2));

/** A review image, fetched with the token. */
function useImage(file: string | null): string | null {
    const [url, setUrl] = React.useState<string | null>(null);
    React.useEffect(() => {
        setUrl(null);
        if (!file) return;
        let live = true, made: string | null = null;
        api.visualImage(file).then((u) => { made = u; if (live) setUrl(u); else URL.revokeObjectURL(u); }).catch(() => undefined);
        return () => { live = false; if (made) URL.revokeObjectURL(made); };
    }, [file]);
    return url;
}

type Rect = { x: number; y: number; width: number; height: number };
type Size = { w: number; h: number };

type Layer = { src: string | null; alt: string; size: Size | null; onSize: (s: Size) => void; style?: React.CSSProperties };

/**
 * One picture, or several laid over each other, each at its own size within the reference size `refSize` (the
 * larger of the pictures, as the diff measures), showing all of it or only `crop`, with the changed area outlined.
 */
function Frame({ layers, area, crop, refSize, handle }: { layers: Layer[]; area?: Rect | null; crop?: Rect | null; refSize: Size | null; handle?: number }) {
    const ready = !!refSize && layers.every((l) => !l.src || l.size);
    const view = ready ? (crop ?? { x: 0, y: 0, width: refSize!.w, height: refSize!.h }) : null;
    // Each picture scaled so the view fills the frame and moved to its corner (margins in % are of the frame's
    // width, for top too).
    const place = (l: Layer): React.CSSProperties => view && l.size
        ? { position: 'absolute', top: 0, left: 0, maxWidth: 'none', width: `${(l.size.w / view.width) * 100}%`, marginLeft: `${(-view.x / view.width) * 100}%`, marginTop: `${(-view.y / view.width) * 100}%` }
        : {};
    const b = view && area ? { left: `${((area.x - view.x) / view.width) * 100}%`, top: `${((area.y - view.y) / view.height) * 100}%`, width: `${(area.width / view.width) * 100}%`, height: `${(area.height / view.height) * 100}%` } : null;
    return (
        <div className="vr-frame" style={view ? { aspectRatio: `${view.width} / ${view.height}` } : undefined}>
            {layers.map((l, i) => l.src
                ? <img key={i} src={l.src} alt={l.alt} style={{ ...place(l), ...l.style }}
                    onLoad={(e) => l.onSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
                : i === 0 ? <div key={i} className="vr-loading">Loading…</div> : null)}
            {b && <div className="vr-area" style={b} />}
            {handle !== undefined && <div className="vr-handle" style={{ left: `${handle}%` }} />}
        </div>
    );
}

/** A picture with the changed area outlined. */
function Shot({ label, layer, area, crop, refSize }: { label: string; layer: Layer; area?: Rect | null; crop?: Rect | null; refSize: Size | null }) {
    return (
        <figure className="vr-shot">
            <figcaption>{label}</figcaption>
            <Frame layers={[layer]} area={area} crop={crop} refSize={refSize} />
        </figure>
    );
}

/** Baseline under the new screenshot, the new one shown up to the slider. */
function Compare({ baseline, actual, crop, refSize }: { baseline: Layer; actual: Layer; crop?: Rect | null; refSize: Size | null }) {
    const [at, setAt] = React.useState(50);
    return (
        <div>
            <Frame layers={[baseline, { ...actual, style: { clipPath: `inset(0 ${100 - at}% 0 0)` } }]} crop={crop} refSize={refSize} handle={at} />
            <Space style={{ width: '100%', marginTop: 6 }} align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Last run</Typography.Text>
                <Slider value={at} onChange={setAt} style={{ width: 280 }} tooltip={{ formatter: null }} aria-label="Compare" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Baseline</Typography.Text>
            </Space>
        </div>
    );
}

function VisualDetail({ v, onDone }: { v: VisualSnapshot; onDone: () => void }) {
    const { message, modal } = App.useApp();
    const baseline = useImage(v.files.baseline), actual = useImage(v.files.actual), diff = useImage(v.files.diff);
    const differs = !!v.files.actual;
    // The check failed or passed with a difference: the last run can become the baseline (also when only the
    // structure changed and the pictures are the same).
    const approvable = v.status === 'changed' || v.status === 'cosmetic';
    const [view, setView] = React.useState<'side' | 'slider' | 'diff'>(v.files.diff ? 'diff' : 'side');
    // Each picture's own size; the reference is the larger of them (the diff's coordinates).
    const [sizes, setSizes] = React.useState<Record<'baseline' | 'actual' | 'diff', Size | null>>({ baseline: null, actual: null, diff: null });
    const layer = (role: 'baseline' | 'actual' | 'diff', src: string | null, alt: string): Layer => ({ src, alt, size: sizes[role], onSize: (z) => setSizes((p) => (p[role]?.w === z.w && p[role]?.h === z.h ? p : { ...p, [role]: z })) });
    const known = (Object.values(sizes).filter(Boolean) as Size[]);
    const size: Size | null = known.length ? { w: Math.max(...known.map((z) => z.w)), h: Math.max(...known.map((z) => z.h)) } : null;
    const area = v.pixels?.area ?? null;
    // Zoomed to the change (with a margin) when it covers only part of the picture.
    const small = !!(area && size && area.width * area.height < 0.5 * size.w * size.h);
    const [zoom, setZoom] = React.useState(true);
    const crop: Rect | null = zoom && small && area && size ? (() => {
        const m = Math.max(24, Math.round(Math.max(area.width, area.height) * 0.15));
        const x = Math.max(0, area.x - m), y = Math.max(0, area.y - m);
        return { x, y, width: Math.min(size.w, area.x + area.width + m) - x, height: Math.min(size.h, area.y + area.height + m) - y };
    })() : null;
    const approve = () => modal.confirm({
        title: `Approve the new look of "${v.name}"?`, okText: 'Approve', icon: <CheckOutlined />,
        content: 'The last run\'s screenshot (and its structure) becomes the baseline: the next runs are compared with it. Commit the baseline files under Source control.',
        onOk: async () => { try { await api.visualApprove(v.dir, v.name, v.actualSha ?? ''); message.success('Approved: it is the baseline now.'); onDone(); } catch (e) { message.error(errText(e)); if (e instanceof ApiError && e.status === 409) onDone(); } },
    });
    const accept = async () => { try { await api.visualAccept(v.dir, v.name, v.baselineSha); message.success('Marked as reviewed.'); onDone(); } catch (e) { message.error(errText(e)); if (e instanceof ApiError && e.status === 409) onDone(); } };
    return (
        <>
            <Space size={6} style={{ marginBottom: 10 }} wrap>
                <Tag bordered={false} color={STATUS[v.status].color}>{STATUS[v.status].label}</Tag>
                <Typography.Text type="secondary">{STATUS[v.status].about}</Typography.Text>
            </Space>
            <div className="h-facts">
                <div><span>Scenario</span><b>{v.scenario ?? '–'}</b></div>
                <div><span>Last compared</span><b>{v.at ? `${new Date(v.at).toLocaleString()} (${ago(v.at)})` : '–'}</b></div>
                {v.verdict && <div><span>Verdict</span><b>{VERDICT[v.verdict] ?? v.verdict}</b></div>}
                {v.pixels && <div><span>Pixels changed</span><b>{pct(v.pixels.percent)}%{v.pixels.changed !== undefined ? ` (${v.pixels.changed.toLocaleString()} px)` : ''}{v.pixels.sizeChanged ? ' · the size changed' : ''}</b></div>}
                <div><span>Files</span><b className="mono">{v.dir}/…/{v.name}.png</b></div>
            </div>
            {v.message && v.status !== 'same' && <Alert type={v.status === 'changed' ? 'error' : 'info'} showIcon style={{ marginBottom: 12 }} message={<div style={{ maxHeight: 96, overflow: 'auto', overflowWrap: 'anywhere' }}>{v.message}</div>} />}

            {(() => {
                const nStruct = v.ariaChanges.length + v.layoutChanges.length;
                const pictures = <>
            {differs ? <>
                <Space style={{ marginBottom: 10 }} wrap>
                    <Segmented size="small" value={view} onChange={(x) => setView(x as typeof view)}
                        options={[...(v.files.diff ? [{ value: 'diff', label: 'Changes' }] : []), { value: 'side', label: 'Side by side' }, { value: 'slider', label: 'Slider' }]} />
                    {small && <Segmented size="small" value={zoom ? 'zoom' : 'all'} onChange={(x) => setZoom(x === 'zoom')} options={[{ value: 'zoom', label: 'Changed area' }, { value: 'all', label: 'Whole page' }]} />}
                </Space>
                {view === 'side' && <div className="vr-pair"><Shot label="Baseline" layer={layer('baseline', baseline, 'Baseline')} area={area} crop={crop} refSize={size} /><Shot label="Last run" layer={layer('actual', actual, 'Last run')} area={area} crop={crop} refSize={size} /></div>}
                {view === 'slider' && <Compare baseline={layer('baseline', baseline, 'Baseline')} actual={layer('actual', actual, 'Last run')} crop={crop} refSize={size} />}
                {view === 'diff' && <Shot label="Changed pixels in red, over the baseline" layer={layer('diff', diff, 'Changed pixels')} area={area} crop={crop} refSize={size} />}
            </> : <Shot label={v.status === 'new' ? 'The new baseline' : v.status === 'changed' ? 'The pictures are the same: only the structure changed' : 'Baseline (the last run matched it)'} layer={layer('baseline', baseline, 'Baseline')} refSize={size} />}

                </>;
                if (!nStruct) return pictures;
                return <Tabs size="small" defaultActiveKey="pictures" items={[
                    { key: 'pictures', label: 'Pictures', children: pictures },
                    { key: 'structure', label: <>Structure changes <span className="q-count">{nStruct}</span></>, children: <div>
                {v.ariaChanges.length > 0 && <pre className="h-diff mono" style={{ marginTop: 0 }}>
                    {v.ariaChanges.map((c, i) => <div key={i} className={c.startsWith('Added') ? 'h-add' : c.startsWith('Removed') ? 'h-del' : ''}>{c.startsWith('Added') ? '+ ' : c.startsWith('Removed') ? '- ' : '~ '}{c.replace(/^(Added|Removed|Changed):\s*/, '').replace(/^"|"$/g, '')}</div>)}
                </pre>}
                {v.layoutChanges.length > 0 && <div className="vr-layout">
                    {v.layoutChanges.map((c, i) => <div key={i}><Tag bordered={false}>{c.type}</Tag><span className="mono">{c.element}</span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.before ? ` from ${c.before.x},${c.before.y} ${c.before.width}×${c.before.height}` : ''}{c.after ? ` to ${c.after.x},${c.after.y} ${c.after.width}×${c.after.height}` : ''}</Typography.Text></div>)}
                </div>}
            </div> },
                ]} />;
            })()}
            <Space style={{ marginTop: 14 }}>
                {approvable && <Button type="primary" icon={<CheckOutlined />} onClick={approve}>Approve as the new baseline</Button>}
                {v.status === 'new' && <Button type="primary" icon={<LikeOutlined />} onClick={() => void accept()}>It looks right</Button>}
            </Space>
        </>
    );
}

function VisualTab() {
    const { message } = App.useApp();
    const [data, setData] = React.useState<{ dirs: string[]; snapshots: VisualSnapshot[] } | null>(null);
    const [filter, setFilter] = React.useState<VisualStatus | 'all' | 'review'>('review');
    const [open, setOpen] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const load = React.useCallback(async () => {
        setLoading(true);
        try { setData(await api.visual()); } catch (e) { message.error(errText(e)); } finally { setLoading(false); }
    }, [message]);
    React.useEffect(() => { void load(); }, [load]);
    if (!data) return <div style={{ padding: 24 }}>{loading ? 'Loading…' : null}</div>;
    const count = (s: VisualStatus) => data.snapshots.filter((v) => v.status === s).length;
    const toReview = (v: VisualSnapshot) => v.status === 'changed' || v.status === 'new' || v.status === 'cosmetic';
    const shown = data.snapshots.filter((v) => filter === 'all' || (filter === 'review' ? toReview(v) : v.status === filter));
    const current = data.snapshots.find((v) => v.key === open);
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className="toolbar">
                <Segmented size="small" value={filter} onChange={(x) => setFilter(x as typeof filter)}
                    options={[{ value: 'review', label: `To review ${data.snapshots.filter(toReview).length}` }, ...(['changed', 'new', 'cosmetic', 'same'] as VisualStatus[]).map((s) => ({ value: s, label: `${STATUS[s].label} ${count(s)}` })), { value: 'all', label: `All ${data.snapshots.length}` }]} />
                <span style={{ flex: 1 }} />
                <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} aria-label="Refresh" />
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
                {!data.snapshots.length
                    ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 60 }} description={<span>No visual checks yet. A step like <span className="mono">Then the page should visually match smart snapshot "home"</span> saves a baseline the first time and compares with it after.</span>} />
                    : <Table<VisualSnapshot> size="small" rowKey="key" dataSource={shown} pagination={false} sticky
                        onRow={(v) => ({ onClick: () => setOpen(v.key), style: { cursor: 'pointer' } })}
                        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter === 'review' ? 'Nothing to review: every visual check matched its baseline.' : 'None.'} /> }}
                        columns={[
                            { title: 'Snapshot', key: 'name', ellipsis: true, render: (_, v) => <div className="q-name"><span className="mono">{v.name.replace(/_region_.*/, '')}{v.region && <Tag bordered={false} style={{ marginInlineStart: 6 }}>region</Tag>}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{v.scenario ?? v.dir}</Typography.Text></div> },
                            { title: 'What changed', key: 'what', width: 260, render: (_, v) => v.status === 'same' || v.status === 'new' ? <Typography.Text type="secondary">–</Typography.Text>
                                : <span>{VERDICT[v.verdict ?? ''] ?? v.verdict ?? 'Differs'}{v.pixels && <Typography.Text type="secondary" style={{ fontSize: 12 }}> · {pct(v.pixels.percent)}% of pixels</Typography.Text>}{v.ariaChanges.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}> · {v.ariaChanges.length} structure</Typography.Text>}</span> },
                            { title: 'Last run', key: 'at', width: 130, render: (_, v) => <Tooltip title={v.at ? new Date(v.at).toLocaleString() : undefined}><span>{ago(v.at)}</span></Tooltip> },
                            { title: 'Status', key: 'status', width: 170, render: (_, v) => <Space size={4}><Tooltip title={STATUS[v.status].about}><Tag bordered={false} color={STATUS[v.status].color}>{STATUS[v.status].label}</Tag></Tooltip>{v.reviewed && v.status === 'same' && <Tooltip title={`${v.reviewed.action === 'approved' ? 'Approved' : 'Reviewed'} ${new Date(v.reviewed.at).toLocaleString()}`}><CheckOutlined style={{ color: 'var(--muted)' }} /></Tooltip>}</Space> },
                        ]} />}
            </div>
            <Drawer open={!!current} onClose={() => setOpen(null)} width={980} destroyOnClose
                title={current && <span style={{ display: 'flex', alignItems: 'center', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}><Typography.Text className="mono" ellipsis={{ tooltip: current.name.replace(/_region_.*/, '') }} style={{ minWidth: 0 }}>{current.name.replace(/_region_.*/, '')}</Typography.Text>{current.region && <Tag bordered={false} style={{ marginInlineStart: 8 }}>region</Tag>}</span>}>
                {current && <VisualDetail v={current} onDone={() => { setOpen(null); void load(); }} />}
            </Drawer>
        </div>
    );
}

function AccessibilityTab() {
    const { message, modal } = App.useApp();
    const [a11yTab, setA11yTabRaw] = React.useState<'issues' | 'snapshots'>(() => { try { return localStorage.getItem('cs-studio-a11y-tab') === 'snapshots' ? 'snapshots' : 'issues'; } catch { return 'issues'; } });
    const setA11yTab = (v: 'issues' | 'snapshots') => { setA11yTabRaw(v); try { localStorage.setItem('cs-studio-a11y-tab', v); } catch { /* ignore */ } };
    const [data, setData] = React.useState<{ checks: A11yCheck[]; dirs: string[]; snapshots: AriaSnapshotInfo[] } | null>(null);
    const [loading, setLoading] = React.useState(false);
    const load = React.useCallback(async () => {
        setLoading(true);
        try { setData(await api.accessibility()); } catch (e) { message.error(errText(e)); } finally { setLoading(false); }
    }, [message]);
    React.useEffect(() => { void load(); }, [load]);
    if (!data) return <div style={{ padding: 24 }}>{loading ? 'Loading…' : null}</div>;
    const approve = (s: AriaSnapshotInfo) => modal.confirm({
        title: `Approve the new accessibility tree of "${s.name}"?`, okText: 'Approve', icon: <CheckOutlined />,
        content: 'The last run\'s accessibility snapshot becomes the baseline. Commit it under Source control.',
        onOk: async () => { try { await api.ariaApprove(s.dir, s.name, s.actualSha ?? ''); message.success('Approved.'); await load(); } catch (e) { message.error(errText(e)); if (e instanceof ApiError && e.status === 409) await load(); } },
    });
    const issues = data.checks.reduce((n, c) => n + c.violations.length, 0);
    const changed = data.snapshots.filter((s) => s.status === 'changed');
    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="toolbar">
                <Segmented size="small" value={a11yTab} onChange={(x) => setA11yTab(x as 'issues' | 'snapshots')}
                    options={[{ value: 'issues', label: `Issues ${issues}` }, { value: 'snapshots', label: `Snapshots ${changed.length ? `${changed.length} changed of ` : ''}${data.snapshots.length}` }]} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{a11yTab === 'issues' ? (data.checks.length ? `on ${data.checks.length} page${data.checks.length === 1 ? '' : 's'}, from each page's latest check` : '') : ''}</Typography.Text>
                <span style={{ flex: 1 }} />
                <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} aria-label="Refresh" />
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px 24px' }}>
            {a11yTab === 'issues' ? <>
            {!data.checks.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>No accessibility checks in the recent runs. Steps like <span className="mono">Then the page should have no accessibility violations with impact "serious"</span> record what they find.</span>} />}
            {data.checks.map((c) => (
                <Card key={`${c.url}|${c.scenario}`} size="small" style={{ marginBottom: 10 }}
                    title={<Space size={6}>{c.violations.length ? <Tag bordered={false} color="error">{c.violations.length} issue{c.violations.length === 1 ? '' : 's'}</Tag> : <Tag bordered={false} color="success">No issues</Tag>}<span className="mono" style={{ fontSize: 12 }}>{c.url}</span></Space>}
                    extra={<Space size={8}><Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.scenario} · {ago(c.at)}</Typography.Text>{!c.run.startsWith('report:') && <a style={{ fontSize: 12 }} onClick={() => navigate(['runs', c.run])}>Run</a>}</Space>}>
                    {c.violations.length === 0 ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.passes !== undefined ? `${c.passes} elements checked.` : ''}</Typography.Text>
                        : <Table size="small" rowKey={(_, i) => String(i)} pagination={false} dataSource={c.violations}
                            columns={[
                                { title: 'Impact', dataIndex: 'impact', width: 100, render: (x: string) => <Tag bordered={false} color={IMPACT[x] ?? 'default'}>{x}</Tag> },
                                { title: 'Issue', key: 'issue', render: (_, v) => <div className="q-name"><span>{v.description}</span>{v.help && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v.help}</Typography.Text>}</div> },
                                { title: 'Element', dataIndex: 'element', width: 240, ellipsis: true, render: (x?: string) => x ? <span className="mono" style={{ fontSize: 12 }}>{x}</span> : '–' },
                                { title: '', key: 'how', width: 110, render: (_, v) => v.helpUrl ? <a href={v.helpUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12 }}>How to fix <ExportOutlined /></a> : null },
                            ]} />}
                </Card>
            ))}

            </> : <>
            {!data.snapshots.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>No accessibility snapshots. <span className="mono">Then the page accessibility tree should match snapshot "home"</span> saves one.</span>} />}
            {data.snapshots.map((s) => (
                <Card key={s.key} size="small" style={{ marginBottom: 10 }}
                    title={<Space size={6}><Tag bordered={false} color={s.status === 'changed' ? 'error' : 'success'}>{s.status === 'changed' ? 'Changed' : 'Same'}</Tag><span className="mono">{s.name}</span></Space>}
                    extra={s.status === 'changed' ? <Space><Typography.Text type="secondary" style={{ fontSize: 12 }}>{ago(s.at)}</Typography.Text><Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => approve(s)}>Approve</Button></Space> : <a style={{ fontSize: 12 }} onClick={() => navigate(['code', s.baseline])}>Open</a>}>
                    {s.diff ? <pre className="h-diff mono" style={{ margin: 0, maxHeight: 320, overflow: 'auto' }}>
                        {s.diff.map((l, i) => <div key={i} className={l.kind === 'add' ? 'h-add' : l.kind === 'del' ? 'h-del' : 'vr-same'}>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}{l.text}</div>)}
                    </pre> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>The last comparison matched. <span className="mono">{s.baseline}</span></Typography.Text>}
                </Card>
            ))}
            </>}
            </div>
        </div>
    );
}

export function VisualReview() {
    const route = useRoute();
    const tab = route[1] === 'accessibility' ? 'accessibility' : 'visual';
    return (
        <div className="panel" style={{ height: 'calc(100vh - var(--chrome))', display: 'flex', flexDirection: 'column' }}>
            <Tabs size="small" className="tests-panel-tabs" activeKey={tab} onChange={(k) => navigate(['visual', ...(k === 'accessibility' ? ['accessibility'] : [])])} style={{ flex: 'none' }} destroyInactiveTabPane
                items={[{ key: 'visual', label: 'Visual' }, { key: 'accessibility', label: 'Accessibility' }]} />
            <div style={{ flex: 1, minHeight: 0 }}>{tab === 'visual' ? <VisualTab /> : <AccessibilityTab />}</div>
        </div>
    );
}
