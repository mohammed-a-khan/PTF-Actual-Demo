/**
 * The response of a request: status, time and size; the body (pretty / raw / preview of HTML, images and PDF, a
 * search that highlights and counts, saved to a file), headers, cookies, checks, the scripts' console, where the
 * time went (DNS, connect, TLS, sending, waiting, download), the connection (address, TLS version, cipher, the
 * server's certificates) and the request as sent.
 */
import React from 'react';
import { Alert, Button, Descriptions, Empty, Input, Segmented, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, DeleteOutlined, DownloadOutlined, LockOutlined } from '@ant-design/icons';
import type { ApiSendResult, ApiTimings } from '../api';
import { shownTab, useRememberedTab } from '../apiperf-ui';

const PHASES: Array<{ k: keyof ApiTimings; label: string; color: string; tip: string }> = [
    { k: 'blocked', label: 'Waiting for a connection', color: '#bfbfbf', tip: 'Queued until a connection was free (or the proxy answered).' },
    { k: 'dns', label: 'DNS lookup', color: '#13a8a8', tip: 'Finding the server\'s address.' },
    { k: 'connect', label: 'Connecting', color: '#fa8c16', tip: 'The TCP connection.' },
    { k: 'tls', label: 'TLS handshake', color: '#722ed1', tip: 'Agreeing on encryption and checking the certificate.' },
    { k: 'send', label: 'Sending', color: '#2f54eb', tip: 'Sending the request (headers and body).' },
    { k: 'wait', label: 'Waiting (server)', color: '#52c41a', tip: 'Time to first byte: the server working on the request.' },
    { k: 'download', label: 'Downloading', color: '#1677ff', tip: 'Receiving the response body.' },
];

const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const extOf = (ct: string) => (/json/.test(ct) ? 'json' : /xml/.test(ct) ? 'xml' : /html/.test(ct) ? 'html' : /pdf/.test(ct) ? 'pdf' : /png/.test(ct) ? 'png' : /jpe?g/.test(ct) ? 'jpg' : /gif/.test(ct) ? 'gif' : /svg/.test(ct) ? 'svg' : /webp/.test(ct) ? 'webp' : /csv/.test(ct) ? 'csv' : /zip/.test(ct) ? 'zip' : /^text\//.test(ct) ? 'txt' : 'bin');

/** The text with each match marked; the count. */
function Highlighted({ text, find }: { text: string; find: string }) {
    const parts = React.useMemo(() => {
        if (!find) return null;
        const out: React.ReactNode[] = [];
        const lower = text.toLowerCase(), f = find.toLowerCase();
        let i = 0, n = 0;
        for (let j = lower.indexOf(f); j >= 0 && n < 5000; j = lower.indexOf(f, j + f.length)) {
            out.push(text.slice(i, j), <mark key={n} className="find-hit" data-hit={n}>{text.slice(j, j + f.length)}</mark>);
            i = j + f.length; n++;
        }
        out.push(text.slice(i));
        return out;
    }, [text, find]);
    return <>{parts ?? text}</>;
}

function Timing({ t, total }: { t: ApiTimings; total: number }) {
    const sum = PHASES.reduce((n, p) => n + (t[p.k] ?? 0), 0) || 1;
    let at = 0;
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <Tooltip title="A kept-alive connection has no DNS, connect or TLS time."><Typography.Text type="secondary" style={{ fontSize: 12 }}>All exchanges of the request added up (redirects, sign-in handshakes).</Typography.Text></Tooltip>
            <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr 80px', gap: '6px 10px', alignItems: 'center', maxWidth: 760 }}>
                {PHASES.map((p) => {
                    const v = t[p.k] ?? 0, left = (at / sum) * 100, w = Math.max((v / sum) * 100, v > 0 ? 0.6 : 0);
                    at += v;
                    return (
                        <React.Fragment key={p.k}>
                            <Tooltip title={p.tip}><Typography.Text style={{ fontSize: 12 }}>{p.label}</Typography.Text></Tooltip>
                            <div style={{ position: 'relative', height: 12, background: 'var(--panel-border)', borderRadius: 3 }} aria-label={`${p.label} ${v} ms`}>
                                <div style={{ position: 'absolute', left: `${left}%`, width: `${w}%`, top: 0, bottom: 0, background: p.color, borderRadius: 3 }} />
                            </div>
                            <Typography.Text className="mono" style={{ fontSize: 12, textAlign: 'right' }}>{v.toFixed(v < 10 ? 1 : 0)} ms</Typography.Text>
                        </React.Fragment>
                    );
                })}
                <Typography.Text strong style={{ fontSize: 12 }}>Total</Typography.Text><span /><Typography.Text strong className="mono" style={{ fontSize: 12, textAlign: 'right' }}>{total} ms</Typography.Text>
            </div>
        </Space>
    );
}

export function ResponseView({ result, sending, onRemoveCookie, onSaveExample }: { result: ApiSendResult | null; sending: boolean; onRemoveCookie?: (name?: string, domain?: string) => void; onSaveExample?: () => void }) {
    const [view, setView] = React.useState<'pretty' | 'raw' | 'preview'>('pretty');
    const [find, setFind] = React.useState('');
    const bodyRef = React.useRef<HTMLPreElement>(null);
    const [hit, setHit] = React.useState(0);
    const [tab, setTab] = useRememberedTab('api-response', 'body');
    const r = result?.response;
    const ct = (r?.headers['content-type'] ?? '').toLowerCase();
    const binary = !!r?.bodyBase64;
    const previewable = !!r && (/html/.test(ct) || /^image\//.test(ct) || /pdf/.test(ct));
    const pretty = React.useMemo(() => {
        if (!r || binary) return '';
        try { return JSON.stringify(JSON.parse(r.body), null, 2); } catch { /* not JSON */ }
        if (/xml/.test(ct) || /^\s*</.test(r.body) && !/html/.test(ct)) {
            // XML: one element per line, indented.
            let depth = 0;
            return r.body.replace(/>\s*</g, '>\n<').split('\n').map((l) => {
                const t = l.trim();
                if (/^<\//.test(t)) depth = Math.max(0, depth - 1);
                const out = '  '.repeat(depth) + t;
                if (/^<[^!?/][^>]*[^/]>$/.test(t) && !/<\/[^>]+>$/.test(t)) depth++;
                return out;
            }).join('\n');
        }
        return r.body;
    }, [r, binary, ct]);
    const dataUrl = React.useMemo(() => (r && binary ? `data:${ct.split(';')[0] || 'application/octet-stream'};base64,${r.bodyBase64}` : r && /html|svg/.test(ct) ? `data:${ct.split(';')[0]};charset=utf-8,${encodeURIComponent(r.body)}` : ''), [r, binary, ct]);
    const hits = React.useMemo(() => { if (!find || !r || binary) return 0; const t = (view === 'pretty' ? pretty : r.body).toLowerCase(), f = find.toLowerCase(); let n = 0; for (let j = t.indexOf(f); j >= 0 && n < 5000; j = t.indexOf(f, j + f.length)) n++; return n; }, [find, r, binary, view, pretty]);
    React.useEffect(() => { setHit(0); }, [find, view]);
    React.useEffect(() => { bodyRef.current?.querySelector(`mark[data-hit="${hit}"]`)?.scrollIntoView({ block: 'center' }); }, [hit, hits]);
    React.useEffect(() => { if (view === 'preview' && !previewable) setView('pretty'); }, [view, previewable]);
    if (sending) return <div style={{ padding: 24 }}><Spin /> Sending…</div>;
    if (!result) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Press Send to see the response" />;
    const passed = result.checks?.filter((c) => c.pass).length ?? 0, total = result.checks?.length ?? 0;
    const save = () => {
        if (!r) return;
        const blob = binary ? new Blob([Uint8Array.from(atob(r.bodyBase64!), (c) => c.charCodeAt(0))], { type: ct || 'application/octet-stream' }) : new Blob([r.body], { type: ct || 'text/plain' });
        const name = (/filename="?([^";]+)"?/i.exec(r.headers['content-disposition'] ?? '')?.[1]) || `response.${extOf(ct)}`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <div className="toolbar" style={{ gap: 12 }}>
                {r ? <>
                    <Tag color={r.status < 300 ? 'success' : r.status < 400 ? 'processing' : 'error'} style={{ marginInlineEnd: 0 }}>{r.status} {r.statusText}</Tag>
                    <Typography.Text type="secondary">{r.timeMs} ms</Typography.Text>
                    <Typography.Text type="secondary">{size(r.size)}{r.truncated ? ' (cut)' : ''}</Typography.Text>
                    {r.tls && <Tooltip title={`${r.tls.protocol} · ${r.tls.cipher}${r.tls.authorized ? '' : ` · not trusted: ${r.tls.authorizationError ?? ''}`}`}><LockOutlined style={{ color: r.tls.authorized ? '#389e0d' : '#d48806' }} /></Tooltip>}
                    {total > 0 && <Tag color={passed === total ? 'success' : 'error'} style={{ marginInlineEnd: 0 }}>{passed}/{total} checks passed</Tag>}
                    {r.redirects.length > 0 && <Tooltip title={r.redirects.join('\n')}><Typography.Text type="secondary">{r.redirects.length} redirect{r.redirects.length === 1 ? '' : 's'}</Typography.Text></Tooltip>}
                    <span style={{ flex: 1 }} />
                    {onSaveExample && !binary && <Tooltip title="Keep this response with the request: documentation and mocks use it"><Button size="small" onClick={onSaveExample}>Save as example</Button></Tooltip>}
                </> : <Typography.Text type="danger">{result.error && !/^(Not filled in|The GraphQL variables|The pre-request script)/.test(result.error) && !result.prepared?.missing?.length ? 'No answer' : 'Not sent'}</Typography.Text>}
            </div>
            {result.error && <Alert type="error" showIcon style={{ margin: 8 }} message={result.error} />}
            {result.notes?.map((n, i) => <Alert key={i} type="warning" showIcon closable style={{ margin: '4px 8px' }} message={n} />)}
            <Tabs size="small" style={{ flex: 1, minHeight: 0, paddingInline: 12 }} className="fill-tabs ap-tabs" activeKey={shownTab(tab, [!!r && 'body', !!r && 'headers', !!result.cookies?.length && 'cookies', !!result.checks?.length && 'checks', !!result.logs?.length && 'console', !!result.visualizer && 'visualize', !!r?.timings && 'timing', !!r && !!(r.remote || r.tls) && 'conn', 'sent'])} onChange={setTab} items={[
                ...(r ? [{ key: 'body', label: 'Body', children: <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <Space wrap style={{ marginBottom: 6 }}>
                        <Segmented size="small" value={view} onChange={(v) => setView(v as 'pretty')} options={[...(binary ? [] : [{ value: 'pretty', label: 'Pretty' }, { value: 'raw', label: 'Raw' }]), ...(previewable ? [{ value: 'preview', label: 'Preview' }] : [])]} />
                        {!binary && view !== 'preview' && <Input size="small" allowClear style={{ width: 220 }} placeholder="Find in the body" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find in the body"
                            onPressEnter={(e) => hits && setHit((h) => (e.shiftKey ? (h - 1 + hits) % hits : (h + 1) % hits))}
                            suffix={find ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>{hits ? `${hit + 1}/${hits}` : '0'}</Typography.Text> : null} />}
                        <Tooltip title="Save the body to a file"><Button size="small" icon={<DownloadOutlined />} onClick={save}>Save</Button></Tooltip>
                    </Space>
                    {view === 'preview' && previewable
                        ? (/^image\//.test(ct) && !/svg/.test(ct) ? <div style={{ flex: 1, overflow: 'auto', background: 'repeating-conic-gradient(#8881 0% 25%, transparent 0% 50%) 50% / 16px 16px' }}><img src={dataUrl} alt="Response body" style={{ maxWidth: '100%' }} /></div>
                            : <iframe title="Response preview" src={dataUrl} sandbox="" style={{ flex: 1, minHeight: 300, border: '1px solid var(--panel-border)', background: '#fff' }} />)
                        : binary ? <Alert type="info" showIcon message={`A ${ct || 'binary'} body (${size(r.size)}): not text.`} description={previewable ? 'See it under Preview, or save it to a file.' : 'Save it to a file to open it.'} />
                            : <pre ref={bodyRef} className="code-box" style={{ flex: 1, maxHeight: 'none', margin: 0 }}><Highlighted text={view === 'pretty' ? pretty : r.body} find={find} /></pre>}
                </div> },
                { key: 'headers', label: `Headers (${Object.keys(r.headers).length})`, children: <Table size="small" pagination={false} rowKey="k" dataSource={Object.entries(r.headers).map(([k, v]) => ({ k, v }))} columns={[{ title: 'Header', dataIndex: 'k', width: 240 }, { title: 'Value', dataIndex: 'v', render: (v: string) => <span className="mono">{v}</span> }]} /> }] : []),
                ...(result.cookies?.length ? [{ key: 'cookies', label: `Cookies (${result.cookies.length})`, children: <Space direction="vertical" style={{ width: '100%' }} size={6}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Kept for this collection and sent with the next requests (as a test's API client does). {onRemoveCookie && <Typography.Link onClick={() => onRemoveCookie()}>Clear all</Typography.Link>}</Typography.Text>
                    <Table size="small" pagination={false} rowKey={(c) => `${c.domain}|${c.path}|${c.name}`} dataSource={result.cookies} columns={[
                        { title: 'Name', dataIndex: 'name', render: (v: string) => <span className="mono">{v}</span> },
                        { title: 'Value', dataIndex: 'value', ellipsis: true, render: (v: string) => <span className="mono">{v}</span> },
                        { title: 'Domain', dataIndex: 'domain' }, { title: 'Path', dataIndex: 'path' },
                        { title: 'Expires', dataIndex: 'expires', render: (v: string | null) => v ? new Date(v).toLocaleString() : 'session' },
                        { title: '', key: 'f', render: (_: unknown, c) => <Space size={4}>{c.secure && <Tag bordered={false}>Secure</Tag>}{c.httpOnly && <Tag bordered={false}>HttpOnly</Tag>}</Space> },
                        ...(onRemoveCookie ? [{ title: '', key: 'x', width: 40, render: (_: unknown, c: { name: string; domain: string }) => <Button size="small" type="text" icon={<DeleteOutlined />} aria-label={`Remove cookie ${c.name}`} onClick={() => onRemoveCookie(c.name, c.domain)} /> }] : []),
                    ]} />
                </Space> }] : []),
                ...(result.checks?.length ? [{ key: 'checks', label: `Checks (${passed}/${total})`, children: <Space direction="vertical">{result.checks.map((c, i) => <span key={i}>{c.pass ? <CheckCircleFilled style={{ color: '#389e0d' }} /> : <CloseCircleFilled style={{ color: '#cf1322' }} />} {c.message}{!c.pass && c.actual !== undefined && !c.message.includes(String(c.actual)) ? <Typography.Text type="secondary"> (got {c.actual})</Typography.Text> : null}</span>)}</Space> }] : []),
                ...(result.logs?.length ? [{ key: 'console', label: `Console (${result.logs.length})`, children: <pre className="code-box" style={{ maxHeight: 'none' }}>{result.logs.map((l) => `${l.level === 'log' ? '' : `[${l.level}] `}${l.text}`).join('\n')}</pre> }] : []),
                ...(result.visualizer ? [{ key: 'visualize', label: 'Visualize', children: <iframe title="Visualizer" srcDoc={result.visualizer} sandbox="allow-scripts" style={{ width: '100%', height: '100%', minHeight: 360, border: '1px solid var(--panel-border)', background: '#fff' }} /> }] : []),
                ...(r?.timings ? [{ key: 'timing', label: 'Timing', children: <Timing t={r.timings} total={r.timeMs} /> }] : []),
                ...(r && (r.remote || r.tls) ? [{ key: 'conn', label: 'Connection', children: <Space direction="vertical" style={{ width: '100%' }}>
                    <Descriptions size="small" column={1} bordered items={[
                        ...(r.remote ? [{ key: 'a', label: 'Server address', children: <span className="mono">{r.remote}</span> }] : []),
                        ...(r.tls ? [
                            { key: 'p', label: 'TLS', children: `${r.tls.protocol} · ${r.tls.cipher}` },
                            { key: 't', label: 'Trusted', children: r.tls.authorized ? <Tag color="success">Yes</Tag> : <Space><Tag color="warning">No</Tag><Typography.Text type="secondary">{r.tls.authorizationError}</Typography.Text></Space> },
                        ] : []),
                    ]} />
                    {r.tls?.chain.length ? <Table size="small" pagination={false} rowKey="fingerprint256" dataSource={r.tls.chain} columns={[
                        { title: 'Certificate', dataIndex: 'subject', render: (v: string, c) => <Space direction="vertical" size={0}><Typography.Text className="mono" style={{ fontSize: 12 }}>{v}</Typography.Text>{c.altNames && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{c.altNames}</Typography.Text>}</Space> },
                        { title: 'Issued by', dataIndex: 'issuer', render: (v: string) => <Typography.Text className="mono" style={{ fontSize: 12 }}>{v}</Typography.Text> },
                        { title: 'Valid', width: 230, render: (_: unknown, c) => { const left = Math.round((new Date(c.validTo).getTime() - Date.now()) / 86_400_000); return <Space direction="vertical" size={0}><span style={{ fontSize: 12 }}>{new Date(c.validFrom).toLocaleDateString()} – {new Date(c.validTo).toLocaleDateString()}</span><Typography.Text type={left < 0 ? 'danger' : left < 30 ? 'warning' : 'secondary'} style={{ fontSize: 11 }}>{left < 0 ? 'expired' : `${left} days left`}</Typography.Text></Space>; } },
                    ]} /> : null}
                </Space> }] : []),
                { key: 'sent', label: r ? 'Request sent' : 'Request', children: <pre className="code-box" style={{ maxHeight: 'none' }}>{`${result.prepared.method} ${result.prepared.url}\n${Object.entries(result.prepared.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}${result.prepared.body !== undefined ? `\n\n${result.prepared.body}` : ''}`}</pre> },
            ]} />
        </div>
    );
}
