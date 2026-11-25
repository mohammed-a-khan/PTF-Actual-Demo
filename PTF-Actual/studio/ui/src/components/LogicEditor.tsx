/**
 * The logic of a load user path: Init (once per user), Actions (each iteration), End (once when the user stops),
 * each a list of steps; steps that hold steps (transaction, loop, if, switch, try, wait until, fork) show them indented.
 */
import React from 'react';
import { Button, Dropdown, Input, InputNumber, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';

export type Step =
    | { kind: 'request'; id: string; think?: { min: number; max: number } }
    | { kind: 'transaction'; name: string; steps: Step[] }
    | { kind: 'loop'; count?: number; while?: string; max?: number; steps: Step[] }
    | { kind: 'if'; condition: string; then: Step[]; else?: Step[] }
    | { kind: 'switch'; value: string; cases: Array<{ equals: string; steps: Step[] }>; default?: Step[] }
    | { kind: 'try'; steps: Step[]; catch: Step[] }
    | { kind: 'waitUntil'; condition: string; steps?: Step[]; everyMs?: number; timeoutMs: number }
    | { kind: 'delay'; ms: number }
    | { kind: 'js'; code: string }
    | { kind: 'fork'; branches: Step[][] }
    | { kind: 'rendezvous'; name: string; users?: number; percent?: number; timeoutMs: number }
    | { kind: 'queuePut'; queue: string; value: string }
    | { kind: 'queueTake'; queue: string; into: string; timeoutMs: number }
    | { kind: 'generate'; into: string; type: 'counter' | 'random' | 'text' | 'date' | 'uuid'; min?: number; max?: number; length?: number; format?: string; start?: number }
    | { kind: 'nextRow' };
export interface Logic { init?: Step[]; actions: Step[]; end?: Step[] }

const NEW: Record<Step['kind'], (firstReq: string) => Step> = {
    request: (id) => ({ kind: 'request', id }), transaction: () => ({ kind: 'transaction', name: 'Transaction', steps: [] }), loop: () => ({ kind: 'loop', count: 3, steps: [] }),
    if: () => ({ kind: 'if', condition: 'last.status === 200', then: [] }), switch: () => ({ kind: 'switch', value: 'vars.type', cases: [{ equals: 'a', steps: [] }] }),
    try: () => ({ kind: 'try', steps: [], catch: [] }), waitUntil: () => ({ kind: 'waitUntil', condition: "vars.state === 'done'", steps: [], everyMs: 1000, timeoutMs: 60_000 }),
    delay: () => ({ kind: 'delay', ms: 1000 }), js: () => ({ kind: 'js', code: "vars.total = String(Number(vars.price) * 2);" }), fork: () => ({ kind: 'fork', branches: [[], []] }),
    rendezvous: () => ({ kind: 'rendezvous', name: 'together', percent: 100, timeoutMs: 30_000 }), queuePut: () => ({ kind: 'queuePut', queue: 'orders', value: '{{orderId}}' }),
    queueTake: () => ({ kind: 'queueTake', queue: 'orders', into: 'orderId', timeoutMs: 30_000 }), generate: () => ({ kind: 'generate', into: 'n', type: 'counter', start: 1 }), nextRow: () => ({ kind: 'nextRow' }),
};
const LABEL: Record<Step['kind'], string> = {
    request: 'Request', transaction: 'Transaction (steps measured together)', loop: 'Loop', if: 'If … else', switch: 'Switch', try: 'Try … catch', waitUntil: 'Wait until (polling)', delay: 'Delay',
    js: 'JavaScript', fork: 'Fork (at the same time)', rendezvous: 'Rendezvous (users wait for each other)', queuePut: 'Put in a shared queue', queueTake: 'Take from a shared queue', generate: 'Generate a value', nextRow: 'Next data row',
};

function StepList({ steps, onChange, reqs, depth }: { steps: Step[]; onChange: (s: Step[]) => void; reqs: Array<{ id: string; name: string }>; depth: number }) {
    const set = (i: number, s: Step) => onChange(steps.map((x, j) => (j === i ? s : x)));
    const move = (i: number, d: number) => { const n = [...steps]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
    const add = (k: Step['kind']) => onChange([...steps, NEW[k](reqs[0]?.id ?? '')]);
    return (
        <div style={{ borderInlineStart: depth ? '2px solid var(--panel-border)' : undefined, paddingInlineStart: depth ? 10 : 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {steps.map((s, i) => (
                <div key={i}>
                    <div className="check-row" style={{ flexWrap: 'wrap' }}>
                        <Tag bordered={false} style={{ minWidth: 92, textAlign: 'center' }}>{s.kind === 'waitUntil' ? 'wait until' : s.kind}</Tag>
                        <StepFields s={s} onChange={(x) => set(i, x)} reqs={reqs} />
                        <span style={{ flex: 1 }} />
                        <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={!i} onClick={() => move(i, -1)} aria-label="Move up" />
                        <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down" />
                        <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label="Remove step" />
                    </div>
                    {'steps' in s && s.kind !== 'waitUntil' && <StepList steps={s.steps} onChange={(x) => set(i, { ...s, steps: x } as Step)} reqs={reqs} depth={depth + 1} />}
                    {s.kind === 'waitUntil' && <><Typography.Text type="secondary" style={{ fontSize: 11, marginInlineStart: 12 }}>repeat (optional):</Typography.Text><StepList steps={s.steps ?? []} onChange={(x) => set(i, { ...s, steps: x })} reqs={reqs} depth={depth + 1} /></>}
                    {s.kind === 'if' && <><StepList steps={s.then} onChange={(x) => set(i, { ...s, then: x })} reqs={reqs} depth={depth + 1} />
                        <Typography.Text type="secondary" style={{ fontSize: 11, marginInlineStart: 12 }}>else:</Typography.Text><StepList steps={s.else ?? []} onChange={(x) => set(i, { ...s, else: x.length ? x : undefined })} reqs={reqs} depth={depth + 1} /></>}
                    {s.kind === 'try' && <><Typography.Text type="secondary" style={{ fontSize: 11, marginInlineStart: 12 }}>catch (lastError holds the failure):</Typography.Text><StepList steps={s.catch} onChange={(x) => set(i, { ...s, catch: x })} reqs={reqs} depth={depth + 1} /></>}
                    {s.kind === 'switch' && <>{s.cases.map((c, j) => <div key={j}><Space style={{ marginInlineStart: 12 }}><Typography.Text type="secondary" style={{ fontSize: 11 }}>when</Typography.Text><Input size="small" style={{ width: 140 }} value={c.equals} onChange={(e) => set(i, { ...s, cases: s.cases.map((y, k) => (k === j ? { ...y, equals: e.target.value } : y)) })} aria-label="Case value" /><Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => set(i, { ...s, cases: s.cases.filter((_, k) => k !== j) })} aria-label="Remove case" /></Space>
                        <StepList steps={c.steps} onChange={(x) => set(i, { ...s, cases: s.cases.map((y, k) => (k === j ? { ...y, steps: x } : y)) })} reqs={reqs} depth={depth + 1} /></div>)}
                        <Button size="small" type="link" onClick={() => set(i, { ...s, cases: [...s.cases, { equals: '', steps: [] }] })}>Add a case</Button>
                        <Typography.Text type="secondary" style={{ fontSize: 11, marginInlineStart: 12 }}>otherwise:</Typography.Text><StepList steps={s.default ?? []} onChange={(x) => set(i, { ...s, default: x.length ? x : undefined })} reqs={reqs} depth={depth + 1} /></>}
                    {s.kind === 'fork' && s.branches.map((b, j) => <div key={j}><Typography.Text type="secondary" style={{ fontSize: 11, marginInlineStart: 12 }}>branch {j + 1}</Typography.Text><StepList steps={b} onChange={(x) => set(i, { ...s, branches: s.branches.map((y, k) => (k === j ? x : y)) })} reqs={reqs} depth={depth + 1} /></div>)}
                </div>
            ))}
            <Dropdown menu={{ items: (Object.keys(LABEL) as Step['kind'][]).map((k) => ({ key: k, label: LABEL[k] })), onClick: ({ key }) => add(key as Step['kind']) }}>
                <Button size="small" type="dashed" icon={<PlusOutlined />} style={{ alignSelf: 'flex-start' }}>Step</Button>
            </Dropdown>
        </div>
    );
}

function StepFields({ s, onChange, reqs }: { s: Step; onChange: (s: Step) => void; reqs: Array<{ id: string; name: string }> }) {
    const mono = { className: 'mono' } as const;
    switch (s.kind) {
        case 'request': return <Space size={4}><Select size="small" showSearch optionFilterProp="label" style={{ width: 240 }} value={s.id} onChange={(id) => onChange({ ...s, id })} options={reqs.map((r) => ({ value: r.id, label: r.name }))} aria-label="Request" />
            <Tooltip title="Think time after it (empty: the scenario's)"><InputNumber size="small" min={0} placeholder="think" value={s.think?.min} onChange={(v) => onChange({ ...s, think: v === null || v === undefined ? undefined : { min: Number(v), max: Math.max(Number(v), s.think?.max ?? Number(v)) } })} style={{ width: 80 }} aria-label="Think from" /></Tooltip>
            {s.think && <InputNumber size="small" min={s.think.min} value={s.think.max} onChange={(v) => onChange({ ...s, think: { min: s.think!.min, max: Number(v ?? s.think!.min) } })} addonAfter="ms" style={{ width: 120 }} aria-label="Think to" />}</Space>;
        case 'transaction': return <Input size="small" style={{ width: 220 }} value={s.name} onChange={(e) => onChange({ ...s, name: e.target.value })} aria-label="Transaction name" />;
        case 'loop': return <Space size={4}><InputNumber size="small" min={1} placeholder="times" value={s.count} onChange={(v) => onChange({ ...s, count: v ? Number(v) : undefined })} style={{ width: 90 }} aria-label="Times" /><Input size="small" {...mono} style={{ width: 240 }} placeholder="or while (condition)" value={s.while ?? ''} onChange={(e) => onChange({ ...s, while: e.target.value || undefined })} aria-label="While" /></Space>;
        case 'if': return <Input size="small" {...mono} style={{ width: 320 }} value={s.condition} onChange={(e) => onChange({ ...s, condition: e.target.value })} aria-label="Condition" />;
        case 'switch': return <Input size="small" {...mono} style={{ width: 240 }} value={s.value} onChange={(e) => onChange({ ...s, value: e.target.value })} aria-label="Value" />;
        case 'waitUntil': return <Space size={4}><Input size="small" {...mono} style={{ width: 260 }} value={s.condition} onChange={(e) => onChange({ ...s, condition: e.target.value })} aria-label="Until" /><InputNumber size="small" min={10} value={s.everyMs} addonBefore="every" addonAfter="ms" onChange={(v) => onChange({ ...s, everyMs: v ?? 1000 })} style={{ width: 170 }} aria-label="Every" /><InputNumber size="small" min={100} value={s.timeoutMs} addonBefore="at most" addonAfter="ms" onChange={(v) => onChange({ ...s, timeoutMs: v ?? 60000 })} style={{ width: 190 }} aria-label="At most" /></Space>;
        case 'delay': return <InputNumber size="small" min={0} value={s.ms} onChange={(v) => onChange({ ...s, ms: v ?? 0 })} addonAfter="ms" style={{ width: 130 }} aria-label="Delay" />;
        case 'js': return <Input.TextArea size="small" {...mono} autoSize={{ minRows: 1, maxRows: 6 }} style={{ width: 420 }} value={s.code} onChange={(e) => onChange({ ...s, code: e.target.value })} aria-label="JavaScript" />;
        case 'fork': return <Button size="small" type="link" onClick={() => onChange({ ...s, branches: [...s.branches, []] })}>Add a branch</Button>;
        case 'rendezvous': return <Space size={4}><Input size="small" style={{ width: 140 }} value={s.name} onChange={(e) => onChange({ ...s, name: e.target.value })} aria-label="Rendezvous name" /><InputNumber size="small" min={1} placeholder="users" value={s.users} onChange={(v) => onChange({ ...s, users: v ? Number(v) : undefined, ...(v ? { percent: undefined } : {}) })} style={{ width: 90 }} aria-label="Users" /><InputNumber size="small" min={1} max={100} placeholder="%" value={s.percent} onChange={(v) => onChange({ ...s, percent: v ? Number(v) : undefined, ...(v ? { users: undefined } : {}) })} addonAfter="%" style={{ width: 100 }} aria-label="Share of users" /><InputNumber size="small" min={100} value={s.timeoutMs} addonBefore="at most" addonAfter="ms" onChange={(v) => onChange({ ...s, timeoutMs: v ?? 30000 })} style={{ width: 190 }} aria-label="Wait at most" /></Space>;
        case 'queuePut': return <Space size={4}><Input size="small" style={{ width: 120 }} value={s.queue} onChange={(e) => onChange({ ...s, queue: e.target.value })} aria-label="Queue" /><Input size="small" {...mono} style={{ width: 200 }} value={s.value} onChange={(e) => onChange({ ...s, value: e.target.value })} aria-label="Value" /></Space>;
        case 'queueTake': return <Space size={4}><Input size="small" style={{ width: 120 }} value={s.queue} onChange={(e) => onChange({ ...s, queue: e.target.value })} aria-label="Queue" /><Input size="small" {...mono} style={{ width: 140 }} addonBefore="into" value={s.into} onChange={(e) => onChange({ ...s, into: e.target.value })} aria-label="Into" /><InputNumber size="small" min={100} value={s.timeoutMs} addonBefore="at most" addonAfter="ms" onChange={(v) => onChange({ ...s, timeoutMs: v ?? 30000 })} style={{ width: 190 }} aria-label="Wait at most" /></Space>;
        case 'generate': return <Space size={4}><Input size="small" {...mono} style={{ width: 120 }} value={s.into} onChange={(e) => onChange({ ...s, into: e.target.value })} aria-label="Name" /><Select size="small" style={{ width: 120 }} value={s.type} onChange={(t) => onChange({ ...s, type: t })} options={['counter', 'random', 'text', 'date', 'uuid'].map((x) => ({ value: x, label: x }))} aria-label="Type" />
            {s.type === 'random' && <><InputNumber size="small" value={s.min} placeholder="min" onChange={(v) => onChange({ ...s, min: v ?? undefined })} style={{ width: 80 }} aria-label="Min" /><InputNumber size="small" value={s.max} placeholder="max" onChange={(v) => onChange({ ...s, max: v ?? undefined })} style={{ width: 80 }} aria-label="Max" /></>}
            {s.type === 'counter' && <InputNumber size="small" value={s.start} placeholder="from" onChange={(v) => onChange({ ...s, start: v ?? undefined })} style={{ width: 90 }} aria-label="Start" />}
            {s.type === 'text' && <InputNumber size="small" min={1} value={s.length} placeholder="length" onChange={(v) => onChange({ ...s, length: v ?? undefined })} style={{ width: 90 }} aria-label="Length" />}
            {s.type === 'date' && <><InputNumber size="small" value={s.min} placeholder="days from today" onChange={(v) => onChange({ ...s, min: v ?? undefined })} style={{ width: 130 }} aria-label="Days from today" /><Input size="small" value={s.format ?? ''} placeholder="YYYY-MM-DD" onChange={(e) => onChange({ ...s, format: e.target.value || undefined })} style={{ width: 130 }} aria-label="Format" /></>}</Space>;
        case 'try': case 'nextRow': return null;
    }
}

export function LogicEditor({ logic, onChange, reqs }: { logic?: Logic; onChange: (l: Logic | undefined) => void; reqs: Array<{ id: string; name: string; recordedThinkMs?: number }> }) {
    const recorded = reqs.some((r) => r.recordedThinkMs !== undefined);
    if (!logic) return (
        <Space direction="vertical">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Without logic, each user runs the chosen requests in order. With logic: a sign-in once per user (Init), transactions, loops, conditions, polling until a job is done, users meeting at a rendezvous, orders handed from one kind of user to another (shared queues), a sign-out when the user stops (End).</Typography.Text>
            <Space wrap>
                <Button size="small" onClick={() => onChange({ actions: reqs.map((r) => ({ kind: 'request', id: r.id })) })}>Add logic (starting from the requests in order)</Button>
                {recorded && <Button size="small" onClick={() => onChange({ actions: reqs.map((r) => ({ kind: 'request', id: r.id, ...(r.recordedThinkMs !== undefined ? { think: { min: Math.round(r.recordedThinkMs * 0.8), max: Math.round(r.recordedThinkMs * 1.2) } } : {}) })) })}>…with the recorded think times (±20%)</Button>}
            </Space>
        </Space>
    );
    const part = (k: 'init' | 'actions' | 'end', label: string, help: string) => (
        <div>
            <Typography.Text strong style={{ fontSize: 12 }}>{label}</Typography.Text> <Typography.Text type="secondary" style={{ fontSize: 12 }}>{help}</Typography.Text>
            <StepList steps={logic[k] ?? []} onChange={(s) => onChange({ ...logic, [k]: k === 'actions' ? s : s.length ? s : undefined })} reqs={reqs} depth={0} />
        </div>
    );
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Conditions and values are JavaScript over <Typography.Text code>vars</Typography.Text> (data row, saved values) and <Typography.Text code>last</Typography.Text> (the last response: status, json, body, headers, ok). In a loop, <Typography.Text code>vars.loopIndex</Typography.Text> counts from 0.</Typography.Text>
            {part('init', 'Init', 'once per user, when it starts (sign in)')}
            {part('actions', 'Actions', 'every iteration')}
            {part('end', 'End', 'once, when the user stops (sign out)')}
            <Button size="small" danger type="link" onClick={() => onChange(undefined)}>Remove the logic (back to the requests in order)</Button>
        </Space>
    );
}
