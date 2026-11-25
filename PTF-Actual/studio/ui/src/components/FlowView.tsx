/**
 * The flow of a collection: requests as boxes (left to right by what they need), the values one saves and another
 * uses as arrows, script jumps (setNextRequest) dashed, each scenario of the feature in its colour. Clicking a box opens
 * the request.
 */
import React from 'react';
import { Alert, Empty, Space, Spin, Tag, Typography } from 'antd';
import { api, ApiCollectionDef, ApiFlow } from '../api';

const W = 200, H = 54, GX = 90, GY = 28, PAD = 24;
const PALETTE = ['#1677ff', '#52c41a', '#fa8c16', '#722ed1', '#13c2c2', '#eb2f96', '#a0d911', '#2f54eb'];

export function FlowView({ collection, onOpen }: { collection: ApiCollectionDef; onOpen: (id: string) => void }) {
    const [flow, setFlow] = React.useState<ApiFlow | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [hover, setHover] = React.useState<string | null>(null);
    React.useEffect(() => { api.apiFlow(collection).then(setFlow).catch((e) => setErr(String(e?.message ?? e))); }, [collection]);
    if (err) return <Alert type="error" showIcon message={err} />;
    if (!flow) return <Spin />;
    if (!flow.nodes.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No requests yet" />;
    const pos = new Map(flow.nodes.map((n) => [n.id, { x: PAD + n.column * (W + GX), y: PAD + n.row * (H + GY) }]));
    const width = PAD * 2 + (Math.max(...flow.nodes.map((n) => n.column)) + 1) * (W + GX) - GX;
    const height = PAD * 2 + (Math.max(...flow.nodes.map((n) => n.row)) + 1) * (H + GY) - GY;
    const color = (s: number) => PALETTE[s % PALETTE.length];
    const lit = (id: string) => !hover || hover === id || flow.edges.some((e) => (e.from === hover && e.to === id) || (e.to === hover && e.from === id));
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Arrows: a value one request saves and a later one uses ({'{{name}}'}); dashed: a script's jump (setNextRequest); grey: the order within a scenario. Each colour is a scenario of the test the Studio writes.</Typography.Text>
            <Space wrap>{flow.scenarios.map((s) => <Tag key={s.index} color={color(s.index)}>{s.index + 1}. {s.name}</Tag>)}</Space>
            {flow.unresolved.length > 0 && <Alert type="warning" showIcon message={`Values no request saves and no variable gives: ${flow.unresolved.map((u) => `{{${u.name}}} in "${u.request}"`).join(', ')}`} />}
            <div style={{ overflow: 'auto', border: '1px solid var(--panel-border)', borderRadius: 6 }}>
                <svg width={width} height={height} role="img" aria-label="Flow of the collection" style={{ display: 'block' }}>
                    <defs>{['value', 'jump', 'order'].map((k) => <marker key={k} id={`arr-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={k === 'order' ? '#bfbfbf' : k === 'jump' ? '#fa8c16' : '#1677ff'} /></marker>)}</defs>
                    {flow.edges.map((e, i) => {
                        const a = pos.get(e.from)!, b = pos.get(e.to)!;
                        const self = e.from === e.to;
                        const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
                        const d = self ? `M${a.x + W - 30},${a.y} C${a.x + W - 10},${a.y - 30} ${a.x + W + 30},${a.y - 10} ${a.x + W},${a.y + 14}`
                            : x2 > x1 ? `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}` : `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 30} ${b.x + W / 2},${b.y - 30} ${b.x + W / 2},${b.y}`;
                        const dim = hover && e.from !== hover && e.to !== hover;
                        const stroke = e.kind === 'order' ? '#bfbfbf' : e.kind === 'jump' ? '#fa8c16' : '#1677ff';
                        const mx = self ? a.x + W + 8 : (a.x + W + b.x) / 2, my = self ? a.y - 18 : (y1 + y2) / 2 - 4;
                        return <g key={i} opacity={dim ? 0.15 : 1}>
                            <path d={d} fill="none" stroke={stroke} strokeWidth={e.kind === 'value' ? 1.8 : 1.2} strokeDasharray={e.kind === 'jump' ? '5 4' : undefined} markerEnd={`url(#arr-${e.kind})`} />
                            {e.label && <text x={mx} y={my} fontSize={11} textAnchor="middle" fill={stroke} style={{ fontFamily: 'var(--mono)' }}>{e.kind === 'value' ? `{{${e.label}}}` : e.label}</text>}
                        </g>;
                    })}
                    {flow.nodes.map((n) => {
                        const p = pos.get(n.id)!;
                        return <g key={n.id} transform={`translate(${p.x},${p.y})`} style={{ cursor: 'pointer' }} opacity={lit(n.id) ? 1 : 0.3}
                            onClick={() => onOpen(n.id)} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} role="button" aria-label={`Open ${n.name}`}>
                            <rect width={W} height={H} rx={7} fill="var(--panel-bg, #fff)" stroke={color(n.scenario)} strokeWidth={2} />
                            <rect width={6} height={H} rx={3} fill={color(n.scenario)} />
                            <text x={14} y={20} fontSize={11} fontWeight={700} fill="#57606a" style={{ fontFamily: 'var(--mono)' }}>{n.method.toUpperCase()}</text>
                            <text x={14} y={38} fontSize={13} fill="currentColor">{n.name.length > 24 ? `${n.name.slice(0, 23)}…` : n.name}</text>
                            {n.folder && <text x={W - 8} y={18} fontSize={10} textAnchor="end" fill="#8c8c8c">{n.folder.length > 14 ? `${n.folder.slice(0, 13)}…` : n.folder}</text>}
                            <title>{`${n.name}${n.saves.length ? `\nSaves: ${n.saves.join(', ')}` : ''}${n.uses.length ? `\nUses: ${n.uses.join(', ')}` : ''}`}</title>
                        </g>;
                    })}
                </svg>
            </div>
        </Space>
    );
}
