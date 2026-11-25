/**
 * A message exchange (WebSocket, Socket.IO, MQTT, Kafka, gRPC): the connection's options for the protocol, then the
 * steps — send a message (to a topic / event, with a key), expect one (containing a text, from a topic), save a
 * value of it.
 */
import React from 'react';
import { App, Button, Checkbox, Input, InputNumber, Select, Space, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { api, ApiMsgOptions, ApiMsgProtocol, ApiRequestDef, ApiWsStep, GrpcServiceInfo } from '../api';
import { errText } from '../state';
import { AuthContext } from './AuthEditor';

type Ws = NonNullable<ApiRequestDef['ws']>;

export const PROTOCOLS: Array<{ value: ApiMsgProtocol; short: string; label: string; color: string; url: string }> = [
    { value: 'websocket', short: 'WS', label: 'WebSocket', color: '#1b7c83', url: '/socket  or  wss://api.example.com/socket' },
    { value: 'socketio', short: 'IO', label: 'Socket.IO', color: '#5b5bd6', url: 'https://chat.example.com' },
    { value: 'mqtt', short: 'MQTT', label: 'MQTT', color: '#7a5af8', url: 'mqtt://broker.example.com:1883' },
    { value: 'kafka', short: 'KAFKA', label: 'Kafka', color: '#3d3d3d', url: 'kafka://broker1:9092,broker2:9092' },
    { value: 'grpc', short: 'gRPC', label: 'gRPC', color: '#2f80ed', url: 'grpc://orders.example.com:50051' },
    { value: 'amqp', short: 'AMQP', label: 'AMQP (Service Bus, JMS brokers)', color: '#c2410c', url: 'sb://shop.servicebus.windows.net  or  amqp://broker.example.com:5672' },
    { value: 'mcp', short: 'MCP', label: 'MCP server', color: '#0f766e', url: 'https://tools.example.com/mcp' },
    { value: 'sql', short: 'SQL', label: 'SQL (database)', color: '#9a6700', url: 'db://ORDERS  (a DB_ORDERS_* connection)' },
];
export const protocolOf = (ws?: Ws) => PROTOCOLS.find((p) => p.value === (ws?.protocol ?? 'websocket'))!;

function GrpcOptions({ req, o, set }: { req: ApiRequestDef; o: ApiMsgOptions; set: (p: Partial<ApiMsgOptions>) => void }) {
    const { message } = App.useApp();
    const ctx = React.useContext(AuthContext);
    const [services, setServices] = React.useState<GrpcServiceInfo[] | null>(null);
    const [loading, setLoading] = React.useState(false);
    const load = async (sampleTo?: (s: string) => void) => {
        if (!ctx) return;
        setLoading(true);
        try {
            const r = await api.apiGrpcDescribe({ project: ctx.project, env: ctx.env, collection: ctx.collection, request: req });
            setServices(r.services);
            if (sampleTo && r.sample) sampleTo(r.sample);
        } catch (e) { message.error(errText(e)); }
        finally { setLoading(false); }
    };
    const svc = services?.find((s) => s.service === o.service);
    const m = svc?.methods.find((x) => x.name === o.method);
    const kind = m ? (m.requestStream ? (m.responseStream ? 'bidirectional streaming' : 'client streaming') : (m.responseStream ? 'server streaming' : 'unary')) : null;
    return (
        <Space wrap>
            <Checkbox checked={!!o.reflection} onChange={(e) => set({ reflection: e.target.checked || undefined, ...(e.target.checked ? { protoFile: undefined } : {}) })}>Server reflection</Checkbox>
            {!o.reflection && <Input size="small" className="mono" style={{ width: 260 }} value={o.protoFile ?? ''} onChange={(e) => set({ protoFile: e.target.value || undefined })} placeholder="test/<project>/protos/orders.proto" aria-label=".proto file" />}
            <Button size="small" loading={loading} onClick={() => void load()}>Read the services</Button>
            <Select size="small" showSearch style={{ width: 220 }} value={o.service} placeholder="Service (package.Service)" onChange={(service) => set({ service, method: undefined })} aria-label="Service"
                options={(services ?? (o.service ? [{ service: o.service, methods: [] }] : [])).map((s) => ({ value: s.service, label: s.service }))} />
            <Select size="small" showSearch style={{ width: 180 }} value={o.method} placeholder="Method" onChange={(method) => set({ method })} aria-label="Method"
                options={(svc?.methods ?? (o.method ? [{ name: o.method }] : [])).map((x) => ({ value: x.name, label: x.name }))} />
            {kind && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{kind}: {m!.request} → {m!.response}</Typography.Text>}
            {o.service && o.method && <Button size="small" type="link" onClick={() => void load((s) => window.dispatchEvent(new CustomEvent('cs-grpc-sample', { detail: s })))}>Sample message</Button>}
        </Space>
    );
}

export function MessagingEditor({ req, ws, onChange, results }: { req: ApiRequestDef; ws: Ws; onChange: (ws: Ws) => void; results?: Array<{ pass: boolean; message: string }> }) {
    const p = ws.protocol ?? 'websocket';
    const o = ws.options ?? {};
    const steps = ws.steps;
    const setSteps = (s: ApiWsStep[]) => onChange({ ...ws, steps: s });
    const setOpt = (x: Partial<ApiMsgOptions>) => onChange({ ...ws, options: Object.fromEntries(Object.entries({ ...o, ...x }).filter(([, v]) => v !== undefined && v !== '')) as ApiMsgOptions });
    const set = (i: number, x: Partial<ApiWsStep>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...x } : s)));
    // "Sample message": into the first empty send step (or a new one).
    React.useEffect(() => {
        const f = (e: Event) => { const t = (e as CustomEvent<string>).detail; const i = steps.findIndex((s) => s.kind === 'send' && !s.text.trim()); setSteps(i >= 0 ? steps.map((s, j) => (j === i ? { ...s, text: t } : s)) : [{ kind: 'send', text: t }, ...steps]); };
        window.addEventListener('cs-grpc-sample', f);
        return () => window.removeEventListener('cs-grpc-sample', f);
    });
    const topics = p === 'socketio' || p === 'mqtt' || p === 'kafka' || p === 'amqp' || p === 'mcp';
    const topicWord = p === 'socketio' ? 'event' : p === 'amqp' ? 'queue / topic' : p === 'mcp' ? 'method' : 'topic';
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            {p === 'socketio' && <Space wrap><Typography.Text style={{ fontSize: 12 }}>Path</Typography.Text><Input size="small" className="mono" style={{ width: 180 }} value={o.path ?? ''} placeholder="/socket.io" onChange={(e) => setOpt({ path: e.target.value })} aria-label="Socket.IO path" /></Space>}
            {(p === 'mqtt' || p === 'kafka' || p === 'amqp') && <Space wrap>
                <Typography.Text style={{ fontSize: 12 }}>Receive from</Typography.Text>
                <Select size="small" mode="tags" style={{ minWidth: 260 }} value={o.subscribe ?? []} onChange={(v: string[]) => setOpt({ subscribe: v.length ? v : undefined })} placeholder={p === 'mqtt' ? 'shop/#, devices/+/state' : p === 'amqp' ? 'orders, events/Subscriptions/audit' : 'orders, payments'} aria-label="Topics to receive from" open={false} tokenSeparators={[',', ' ']} />
                {p === 'mqtt' && <><Select size="small" style={{ width: 90 }} value={o.qos ?? 0} onChange={(qos) => setOpt({ qos: qos || undefined })} options={[0, 1, 2].map((q) => ({ value: q, label: `QoS ${q}` }))} aria-label="QoS" />
                    <Input size="small" style={{ width: 160 }} value={o.clientId ?? ''} placeholder="client id (optional)" onChange={(e) => setOpt({ clientId: e.target.value })} aria-label="Client id" /></>}
                {p === 'kafka' && <><Input size="small" style={{ width: 180 }} value={o.groupId ?? ''} placeholder="consumer group (new one)" onChange={(e) => setOpt({ groupId: e.target.value })} aria-label="Consumer group" />
                    <Tooltip title="With Basic sign-in on the request: the SASL mechanism"><Select size="small" style={{ width: 150 }} value={o.sasl ?? 'plain'} onChange={(sasl) => setOpt({ sasl: sasl === 'plain' ? undefined : sasl })} options={['plain', 'scram-sha-256', 'scram-sha-512'].map((x) => ({ value: x, label: `SASL ${x}` }))} aria-label="SASL" /></Tooltip>
                    <Checkbox checked={!!o.fromBeginning} onChange={(e) => setOpt({ fromBeginning: e.target.checked || undefined })}>Messages already in the topics too</Checkbox></>}
            </Space>}
            {p === 'grpc' && <GrpcOptions req={req} o={o} set={setOpt} />}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {p === 'grpc' ? 'Each send is a request message (JSON); each response message can be expected. The request\'s headers go as metadata.' : p === 'amqp' ? 'Sign in with Basic (Service Bus: the shared access key name and key). Each send goes to its queue or topic; the key is the message\'s subject.' : p === 'mcp' ? 'Initialized on connect. Each send is a JSON-RPC call: {"method": "tools/list"} or {"tool": "name", "arguments": {…}}; its answer arrives with the method as topic.' : p === 'sql' ? 'Each send is a SQL statement on the connection; its result arrives as {"rows": […], "rowCount": n, "affected": n}. Production-like environments only read.' : 'After connecting, the steps run in order.'} "Expect" waits for a message containing the text (any message when empty){topics ? ` from the ${topicWord} (any when empty${p === 'mqtt' ? '; + and # match levels' : ''})` : ''}; a value of a JSON message can be saved for the next steps and requests ({'{{name}}'}).
            </Typography.Text>
            {steps.map((s, i) => {
                const r = results?.[i];
                return (
                    <div key={i} className="check-row">
                        <span className="item-id" style={{ width: 18 }}>{i + 1}.</span>
                        <Select size="small" value={s.kind} style={{ width: 100 }} onChange={(k) => set(i, k === 'send' ? { kind: k, timeoutMs: undefined, save: undefined } : { kind: k, key: undefined })} options={[{ value: 'send', label: 'Send' }, { value: 'expect', label: 'Expect' }]} aria-label="Step kind" />
                        {topics && <Input size="small" className="mono" style={{ width: 150 }} value={s.topic ?? ''} onChange={(e) => set(i, { topic: e.target.value || undefined })} placeholder={s.kind === 'send' ? topicWord : `from ${topicWord}`} aria-label={topicWord} />}
                        {(p === 'kafka' || p === 'amqp') && s.kind === 'send' && <Input size="small" className="mono" style={{ width: 100 }} value={s.key ?? ''} onChange={(e) => set(i, { key: e.target.value || undefined })} placeholder="key" aria-label="Message key" />}
                        <Input size="small" className="mono" style={{ flex: 1, minWidth: 200 }} value={s.text} onChange={(e) => set(i, { text: e.target.value })} placeholder={s.kind === 'send' ? (p === 'grpc' ? '{"id":"{{orderId}}"}' : p === 'mcp' ? '{"tool":"search","arguments":{"q":"{{term}}"}}' : p === 'sql' ? "SELECT status FROM orders WHERE id = '{{orderId}}'" : '{"type":"subscribe","id":"{{id}}"}') : 'text the message contains (empty: any message)'} aria-label={s.kind === 'send' ? 'Message to send' : 'Expected text'} />
                        {s.kind === 'expect' && <>
                            <InputNumber size="small" min={100} max={600000} value={s.timeoutMs} placeholder="timeout" onChange={(v) => set(i, { timeoutMs: v ?? undefined })} addonAfter="ms" style={{ width: 130 }} aria-label="Timeout" />
                            <Input size="small" className="mono" style={{ width: 130 }} value={s.save?.path ?? ''} placeholder="save $.path" onChange={(e) => set(i, { save: e.target.value || s.save?.variable ? { path: e.target.value, variable: s.save?.variable ?? '' } : undefined })} aria-label="Save from JSON path" />
                            <Input size="small" className="mono" style={{ width: 110 }} value={s.save?.variable ?? ''} placeholder="as name" onChange={(e) => set(i, { save: e.target.value || s.save?.path ? { path: s.save?.path ?? '', variable: e.target.value.replace(/[^\w.-]/g, '') } : undefined })} aria-label="Save as" />
                        </>}
                        {r && (r.pass ? <Tooltip title={r.message}><CheckCircleFilled style={{ color: '#389e0d' }} /></Tooltip> : <Tooltip title={r.message}><CloseCircleFilled style={{ color: '#cf1322' }} /></Tooltip>)}
                        <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove step" />
                    </div>
                );
            })}
            <Space>
                <Button size="small" icon={<PlusOutlined />} onClick={() => setSteps([...steps, { kind: 'send', text: '' }])}>Send a message</Button>
                <Button size="small" icon={<PlusOutlined />} onClick={() => setSteps([...steps, { kind: 'expect', text: '' }])}>Expect a message</Button>
            </Space>
        </Space>
    );
}
