/**
 * A GraphQL request: query and variables, the server's schema (read by introspection with the request's own
 * URL, headers and sign-in), the query checked against it as you type, and an explorer whose fields give a
 * starting operation.
 */
import React from 'react';
import { Alert, App, Button, Col, Empty, Input, Row, Space, Tag, Tooltip, Tree, Typography } from 'antd';
import { api, ApiRequestDef, GqlError, GqlOutline } from '../api';
import { errText } from '../state';
import { AuthContext } from './AuthEditor';

type Gql = NonNullable<ApiRequestDef['body']['graphql']>;

export function GraphqlEditor({ req, onChange }: { req: ApiRequestDef; onChange: (g: Gql) => void }) {
    const { message } = App.useApp();
    const ctx = React.useContext(AuthContext);
    const g: Gql = req.body.graphql ?? { query: '' };
    const [schema, setSchema] = React.useState<{ url: string; outline: GqlOutline } | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [errors, setErrors] = React.useState<GqlError[]>([]);
    const [find, setFind] = React.useState('');
    const varsBad = !!g.variables?.trim() && !/\{\{/.test(g.variables) && (() => { try { JSON.parse(g.variables!); return false; } catch { return true; } })();

    const read = async () => {
        if (!ctx) return;
        setLoading(true);
        try { setSchema(await api.apiGraphqlSchema({ project: ctx.project, env: ctx.env, collection: ctx.collection, request: req })); }
        catch (e) { message.error(errText(e)); }
        finally { setLoading(false); }
    };
    // The query checked against the schema, a moment after typing stops.
    React.useEffect(() => {
        if (!schema || schema.url !== req.url) { setErrors([]); return; }
        const t = setTimeout(() => { void api.apiGraphqlCheck(schema.url, g.query).then((r) => setErrors(r.errors)).catch(() => setErrors([])); }, 400);
        return () => clearTimeout(t);
    }, [schema, g.query, req.url]);

    const start = async (root: 'query' | 'mutation' | 'subscription', field: string) => {
        if (!schema) return;
        try {
            const op = await api.apiGraphqlOperation(schema.url, root, field);
            if (g.query.trim() && !window.confirm('Replace the query with a starting operation for this field?')) return;
            onChange({ query: op.query, variables: op.variables, operationName: op.operationName });
        } catch (e) { message.error(errText(e)); }
    };

    const o = schema?.outline;
    const byName = new Map((o?.types ?? []).map((t) => [t.name, t]));
    const f = find.trim().toLowerCase();
    const roots = o ? (['query', 'mutation', 'subscription'] as const).filter((r) => o[r]).map((r) => {
        const t = byName.get(o[r]!);
        const fields = (t?.fields ?? []).filter((x) => !f || x.name.toLowerCase().includes(f) || (x.description ?? '').toLowerCase().includes(f));
        return {
            key: r, title: <Typography.Text strong>{r[0].toUpperCase() + r.slice(1)} <Typography.Text type="secondary">({fields.length})</Typography.Text></Typography.Text>,
            children: fields.map((x) => ({
                key: `${r}.${x.name}`, isLeaf: true,
                title: <Tooltip placement="right" title={<div>{x.description && <div>{x.description}</div>}{x.args.map((a) => <div key={a.name} className="mono">{a.name}: {a.type}{a.defaultValue ? ` = ${a.defaultValue}` : ''}</div>)}{x.deprecated && <div>Deprecated: {x.deprecated}</div>}<div style={{ marginTop: 4, opacity: 0.8 }}>Click: a starting {r} for this field</div></div>}>
                    <span className="mono" style={{ fontSize: 12, textDecoration: x.deprecated ? 'line-through' : undefined }} onClick={() => void start(r, x.name)}>{x.name}{x.args.length ? '(…)' : ''}: <Typography.Text type="secondary">{x.type}</Typography.Text></span>
                </Tooltip>,
            })),
        };
    }) : [];
    const types = o ? o.types.filter((t) => t.kind !== 'scalar' && ![o.query, o.mutation, o.subscription].includes(t.name) && (!f || t.name.toLowerCase().includes(f))) : [];

    return (
        <Row gutter={10} wrap={false}>
            <Col flex="auto" style={{ minWidth: 0 }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text strong style={{ fontSize: 12 }}>Query</Typography.Text>
                    <Input.TextArea className="mono" autoSize={{ minRows: 8, maxRows: 24 }} value={g.query} onChange={(e) => onChange({ ...g, query: e.target.value })} spellCheck={false} aria-label="GraphQL query"
                        placeholder={'query Orders($first: Int) {\n  orders(first: $first) {\n    id\n    total\n  }\n}'} status={errors.length ? 'error' : undefined} />
                    {errors.length > 0 && <Alert type="error" showIcon message={`${errors.length} problem${errors.length === 1 ? '' : 's'} with the schema`} description={<ul style={{ margin: 0, paddingInlineStart: 16 }}>{errors.slice(0, 8).map((e, i) => <li key={i}>{e.line ? <Typography.Text type="secondary">Line {e.line}:{e.column} </Typography.Text> : null}{e.message}</li>)}</ul>} />}
                    {schema && schema.url === req.url && !errors.length && g.query.trim() && <Typography.Text type="success" style={{ fontSize: 12 }}>The query matches the schema.</Typography.Text>}
                    <Space><Typography.Text strong style={{ fontSize: 12 }}>Variables</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>JSON; {'{{name}}'} values are filled in</Typography.Text></Space>
                    <Input.TextArea className="mono" autoSize={{ minRows: 3, maxRows: 12 }} value={g.variables ?? ''} onChange={(e) => onChange({ ...g, variables: e.target.value })} spellCheck={false} aria-label="GraphQL variables" placeholder={'{ "first": 10 }'} status={varsBad ? 'error' : undefined} />
                    {varsBad && <Typography.Text type="danger" style={{ fontSize: 12 }}>Not valid JSON: the request is not sent until the variables are fixed.</Typography.Text>}
                    <Input size="small" style={{ maxWidth: 280 }} value={g.operationName ?? ''} onChange={(e) => onChange({ ...g, operationName: e.target.value || undefined })} placeholder="Operation name (when the query has several)" aria-label="Operation name" />
                </Space>
            </Col>
            <Col flex="300px" style={{ borderInlineStart: '1px solid var(--panel-border)', paddingInlineStart: 10 }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                    <Space wrap>
                        <Button size="small" loading={loading} onClick={() => void read()}>{schema ? 'Read the schema again' : 'Read the schema'}</Button>
                        {schema && schema.url !== req.url && <Tag color="warning">for another URL</Tag>}
                    </Space>
                    {!o ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Typography.Text type="secondary" style={{ fontSize: 12 }}>The schema is read from the server (introspection) with this request's URL, headers and sign-in.</Typography.Text>} />
                        : <>
                            <Input.Search size="small" allowClear placeholder="Find a field or type" value={find} onChange={(e) => setFind(e.target.value)} />
                            <div style={{ maxHeight: 420, overflow: 'auto' }}>
                                <Tree blockNode selectable={false} defaultExpandedKeys={['query']} treeData={[...roots,
                                    { key: 'types', title: <Typography.Text strong>Types <Typography.Text type="secondary">({types.length})</Typography.Text></Typography.Text>,
                                        children: types.map((t) => ({ key: `t.${t.name}`, title: <span className="mono" style={{ fontSize: 12 }}>{t.name} <Tag bordered={false} style={{ fontSize: 10 }}>{t.kind}</Tag></span>,
                                            children: t.kind === 'enum' ? (t.values ?? []).map((v) => ({ key: `t.${t.name}.${v}`, isLeaf: true, title: <span className="mono" style={{ fontSize: 12 }}>{v}</span> }))
                                                : t.kind === 'union' ? (t.possible ?? []).map((v) => ({ key: `t.${t.name}.${v}`, isLeaf: true, title: <span className="mono" style={{ fontSize: 12 }}>{v}</span> }))
                                                    : t.fields.map((x) => ({ key: `t.${t.name}.${x.name}`, isLeaf: true, title: <Tooltip placement="right" title={x.description}><span className="mono" style={{ fontSize: 12 }}>{x.name}: <Typography.Text type="secondary">{x.type}</Typography.Text></span></Tooltip> })) })) }]} />
                            </div>
                        </>}
                </Space>
            </Col>
        </Row>
    );
}
