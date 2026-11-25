/** API → History: every request sent with Send under API → Requests on this computer (secrets masked); Runner runs and monitors are under API → Runner → Past runs. */
import React from 'react';
import { App, Button, Drawer, Empty, Input, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import { api, ApiHistoryEntry, ApiHistoryItem } from '../api';
import { ResponseView } from '../components/ResponseView';
import { errText } from '../state';
import { navigate, useRoute } from '../route';
import { apiRequestRoute } from '../apiperf-ui';

/** Ignore clicks (and double clicks) anywhere for a moment. */
export function swallowClicks(ms: number) {
    const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
    const kinds = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];
    for (const k of kinds) window.addEventListener(k, stop, true);
    setTimeout(() => { for (const k of kinds) window.removeEventListener(k, stop, true); }, ms);
}

export function ApiHistory() {
    const { message } = App.useApp();
    const route = useRoute();
    const here = route[0] === 'api-history';
    const [items, setItems] = React.useState<ApiHistoryItem[] | null>(null);
    const [find, setFind] = React.useState('');
    const [result, setResult] = React.useState<'all' | 'failed' | 'passed'>('all');
    const [detail, setDetail] = React.useState<{ item: ApiHistoryItem; entry: ApiHistoryEntry | null; error?: string } | null>(null);
    // The open entry is in the address (#/api-history/<id>): a link, a reload, Back and "Back to Request history" reopen it.
    const idInRoute = here && route[1] ? route[1] : null;
    const openDetail = (h: ApiHistoryItem) => {
        if (!h.id) { if (h.file) navigate(apiRequestRoute(h.file, h.requestId)); return; }
        navigate(['api-history', h.id]);
    };
    const closeDetail = () => { setDetail(null); if (idInRoute) navigate(['api-history'], true); };
    const shownId = detail?.item.id ?? null;
    React.useEffect(() => {
        if (!here) return;
        if (!idInRoute) { setDetail(null); return; }
        if (idInRoute === shownId || !items) return;
        const h = items.find((x) => x.id === idInRoute);
        if (!h) { message.warning(`No request "${idInRoute}" in the history (it was cleared, or the link is wrong).`); navigate(['api-history'], true); return; }
        setDetail({ item: h, entry: null });
        api.apiHistoryEntry(idInRoute).then((entry) => setDetail((d) => (d?.item.id === idInRoute ? { item: h, entry } : d))).catch((e) => setDetail((d) => (d?.item.id === idInRoute ? { item: h, entry: null, error: errText(e) } : d)));
    }, [here, idInRoute, items]); // eslint-disable-line react-hooks/exhaustive-deps
    // Once per click: the drawer closes as the request opens, so a second click of a double click must not land on what
    // is under the button (the top bar's Copilot); clicks are ignored for a moment.
    const restoring = React.useRef(false);
    const restore = () => {
        if (!detail?.entry || !detail.item.file || restoring.current) return;
        restoring.current = true;
        swallowClicks(600);
        sessionStorage.setItem('cs-api-restore', JSON.stringify({ file: detail.item.file, def: detail.entry.def, at: detail.item.at }));
        navigate(['api', ...detail.item.file.split('/')]);
    };
    const load = React.useCallback(() => api.apiHistory().then((r) => setItems(r.items)).catch((e) => message.error(errText(e))), [message]);
    React.useEffect(() => { if (here) void load(); }, [here, load]);
    const ok = (h: ApiHistoryItem) => !h.error && h.status < 400 && h.passed === h.checks;
    const q = find.trim().toLowerCase();
    const shown = (items ?? []).filter((h) => (result === 'all' || (result === 'passed') === ok(h)) && (!q || `${h.collection} ${h.request} ${h.method} ${h.url} ${h.status}`.toLowerCase().includes(q)));
    return (
        <div className="panel" style={{ height: 'calc(100vh - var(--chrome))', display: 'flex', flexDirection: 'column' }}>
            <div className="toolbar">
                <Input size="small" allowClear style={{ width: 280 }} placeholder="Find (request, URL, status)" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find" />
                <Select size="small" value={result} onChange={setResult} style={{ width: 130 }} options={[{ value: 'all', label: 'All results' }, { value: 'failed', label: 'Failed' }, { value: 'passed', label: 'Passed' }]} aria-label="Result" />
                <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1 }}>{items ? <Tooltip title="Runs of the Runner and of monitors are not listed here: see API → Runner → Past runs.">{`${shown.length} of ${items.length} sent from API → Requests (the last 200 on this computer)`}</Tooltip> : ''}</Typography.Text>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} aria-label="Refresh" />
                <Popconfirm title="Clear the history?" okText="Clear" okButtonProps={{ danger: true }} onConfirm={async () => { try { await api.apiClearHistory(); void load(); } catch (e) { message.error(errText(e)); } }}><Button size="small" icon={<DeleteOutlined />}>Clear</Button></Popconfirm>
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
                {items && !items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 60 }} description={<>Requests you send with Send under API → Requests appear here.<br />Runs of the Runner and of monitors are under API → Runner → Past runs.</>} /> : (
                    <Table<ApiHistoryItem> size="small" rowKey={(h) => `${h.at}-${h.requestId ?? h.url}`} dataSource={shown} loading={items === null} pagination={false} sticky
                        onRow={(h) => ({ onClick: () => openDetail(h), style: { cursor: h.id || h.file ? 'pointer' : undefined } })}
                        columns={[
                            { title: 'When', dataIndex: 'at', width: 170, render: (v: string) => new Date(v).toLocaleString() },
                            { title: 'Request', dataIndex: 'request', ellipsis: true, render: (n: string, h) => <Space size={6}><b style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{h.method}</b>{n}<Typography.Text type="secondary" style={{ fontSize: 12 }}>{h.collection}</Typography.Text></Space> },
                            { title: 'URL', dataIndex: 'url', ellipsis: true, render: (u: string) => <span className="mono">{u}</span> },
                            { title: 'Env', dataIndex: 'env', width: 70 },
                            { title: 'Status', dataIndex: 'status', width: 80, render: (s: number, h: ApiHistoryItem) => (h.error ? <Tooltip title={h.error}><Tag bordered={false} color="error">No answer</Tag></Tooltip> : <Tag bordered={false} color={s < 300 ? 'success' : s < 400 ? 'processing' : 'error'}>{s}</Tag>) },
                            { title: 'Time', dataIndex: 'timeMs', width: 80, align: 'right', render: (v: number) => `${v} ms` },
                            { title: 'Checks', width: 80, render: (_, h) => <span style={{ color: h.passed === h.checks ? undefined : '#cf222e' }}>{h.passed}/{h.checks}</span> },
                        ]} />)}
            </div>
            <Drawer open={!!detail} onClose={closeDetail} width={900} destroyOnClose
                title={detail ? <Space><b style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{detail.item.method}</b>{detail.item.request}<Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(detail.item.at).toLocaleString()} · {detail.item.collection} · {detail.item.env}</Typography.Text></Space> : ''}
                extra={detail?.item.file ? <Space>
                    <Button size="small" onClick={() => navigate(apiRequestRoute(detail.item.file!, detail.item.requestId))}>{detail.item.requestId ? 'Open the request' : 'Open the collection'}</Button>
                    <Button size="small" type="primary" icon={<RollbackOutlined />} disabled={!detail.entry} onClick={restore} title="Adds this request, as it was sent, to its collection (not saved) and sends it again">Restore and send again</Button>
                </Space> : null}
                styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}>
                {detail?.error ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description={detail.error} />
                    : <div style={{ flex: 1, minHeight: 0 }}><ResponseView sending={!detail?.entry} result={detail?.entry ? { prepared: detail.entry.sent, ...(detail.entry.response ? { response: detail.entry.response } : {}), ...(detail.entry.error ? { error: detail.entry.error } : {}), checks: (detail.entry.checks ?? []).map((c) => ({ ...c, check: { kind: 'status' } as never })) } : null} /></div>}
            </Drawer>
        </div>
    );
}
