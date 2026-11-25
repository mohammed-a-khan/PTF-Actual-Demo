/** A request's saved examples: name, status, the request they answer, the body (documentation and mocks use them). */
import React from 'react';
import { Button, Empty, Input, InputNumber, Modal, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import type { ApiExampleDef } from '../api';

export function ExamplesEditor({ examples, onChange }: { examples: ApiExampleDef[]; onChange: (e: ApiExampleDef[] | undefined) => void }) {
    const [open, setOpen] = React.useState<number | null>(null);
    const set = (i: number, p: Partial<ApiExampleDef>) => onChange(examples.map((e, j) => (j === i ? { ...e, ...p } : e)));
    const e = open === null ? null : examples[open];
    if (!examples.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>No examples yet.<br />Send the request, then "Save as example" on the response.</span>} />;
    return (
        <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>What the API answers to this request. A mock made from the collection answers with them (an example saved for a query or body answers only those requests); the documentation shows them; they go to Postman as saved responses.</Typography.Text>
            <Table size="small" pagination={false} rowKey="id" dataSource={examples} columns={[
                { title: 'Name', render: (_v, x, i) => <Input size="small" variant="borderless" value={x.name} onChange={(ev) => set(i, { name: ev.target.value })} aria-label="Example name" /> },
                { title: 'Status', width: 90, render: (_v, x) => <Tag color={x.status < 300 ? 'success' : x.status < 400 ? 'processing' : 'error'}>{x.status}</Tag> },
                { title: 'For', render: (_v, x) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{x.when?.query ? Object.entries(x.when.query).map(([k, v]) => `${k}=${v}`).join('&') : ''}{x.when?.body ? ' · a body' : ''}{!x.when ? 'any request' : ''}</Typography.Text> },
                { title: '', width: 120, render: (_v, _x, i) => <Space size={4}><Button size="small" onClick={() => setOpen(i)}>Open</Button><Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Remove the example" onClick={() => onChange(examples.length > 1 ? examples.filter((_, j) => j !== i) : undefined)} /></Space> },
            ]} />
            <Modal open={!!e} title={e?.name} onCancel={() => setOpen(null)} footer={null} width={760}>
                {e && open !== null && <Space direction="vertical" style={{ width: '100%' }}>
                    <Space><Typography.Text>Status</Typography.Text><InputNumber size="small" min={100} max={599} value={e.status} onChange={(v) => set(open, { status: Number(v ?? 200) })} aria-label="Status" /></Space>
                    <Typography.Text strong style={{ fontSize: 12 }}>Headers</Typography.Text>
                    <Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 8 }} value={Object.entries(e.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')} aria-label="Headers"
                        onChange={(ev) => set(open, { headers: Object.fromEntries(ev.target.value.split('\n').map((l) => l.split(/:\s?/)).filter((p) => p[0]?.trim()).map(([k, ...v]) => [k.trim(), v.join(': ')])) })} />
                    <Typography.Text strong style={{ fontSize: 12 }}>Body</Typography.Text>
                    <Input.TextArea className="mono" autoSize={{ minRows: 6, maxRows: 22 }} value={e.body ?? ''} onChange={(ev) => set(open, { body: ev.target.value })} aria-label="Body" spellCheck={false} />
                    <Typography.Text strong style={{ fontSize: 12 }}>Answers the requests with the query (empty: any)</Typography.Text>
                    <Input className="mono" size="small" value={e.when?.query ? new URLSearchParams(e.when.query).toString() : ''} placeholder="status=shipped&page=2" aria-label="Query it answers"
                        onChange={(ev) => { const q = Object.fromEntries(new URLSearchParams(ev.target.value)); set(open, { when: Object.keys(q).length || e.when?.body ? { ...(Object.keys(q).length ? { query: q } : {}), ...(e.when?.body ? { body: e.when.body } : {}) } : undefined }); }} />
                </Space>}
            </Modal>
        </Space>
    );
}
