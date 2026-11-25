/**
 * The framework core's review of a change, the same on every screen that writes framework code
 * (Recorder, API, Database, agents): the files with what changes in each (diff), and the standards
 * check (undefined steps, secrets in files, hard-coded addresses, naming, fragile locators…).
 */
import React from 'react';
import { Alert, Empty, Space, Tag, Typography } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import type { FindingDef, PlanReviewDef } from '../api';
import { DiffView } from './DiffView';

const KIND: Record<string, string> = { feature: 'feature', data: 'test data', page: 'page object', steps: 'steps', config: 'configuration', other: 'file' };
const RULE: Record<string, string> = {
    'undefined-step': 'Undefined step', 'step-not-loaded': 'Step not loaded', 'steps-folder-not-loaded': 'Step folder not loaded', 'duplicate-step': 'Duplicate step',
    'secret-in-file': 'Secret in a file', 'plain-password': 'Readable password', 'hard-coded-url': 'Hard-coded address', naming: 'Naming',
    'invalid-data': 'Invalid test data', 'fragile-locator': 'Fragile locator', 'empty-feature': 'Empty feature',
};

export function findingsSummary(r: PlanReviewDef): string {
    const e = r.findings.filter((f) => f.level === 'error').length, w = r.findings.filter((f) => f.level === 'warning').length;
    return e || w ? [e ? `${e} error${e === 1 ? '' : 's'}` : '', w ? `${w} warning${w === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') : 'meets the framework standards';
}

export function PlanReview({ review, height = 420 }: { review: PlanReviewDef; height?: number }) {
    const changed = review.files.filter((f) => f.change !== 'same');
    const [sel, setSel] = React.useState<string | null>(changed[0]?.path ?? review.files[0]?.path ?? null);
    React.useEffect(() => { if (!review.files.some((f) => f.path === sel)) setSel(changed[0]?.path ?? null); }, [review]); // eslint-disable-line react-hooks/exhaustive-deps
    const file = review.files.find((f) => f.path === sel);
    const byLevel = (l: FindingDef['level']) => review.findings.filter((f) => f.level === l);
    const list = (items: FindingDef[]) => <ul style={{ margin: 0, paddingLeft: 18 }}>{items.map((f, i) => (
        <li key={i}><Typography.Text strong style={{ fontSize: 12 }}>{RULE[f.rule] ?? f.rule}</Typography.Text>{f.file && <> · <Typography.Link className="mono" style={{ fontSize: 12 }} onClick={() => setSel(f.file!)}>{f.file.split('/').pop()}{f.line ? `:${f.line}` : ''}</Typography.Link></>} — <span style={{ fontSize: 12 }}>{f.message}</span></li>))}</ul>;
    return (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {byLevel('error').length > 0 && <Alert type="error" showIcon message={`The framework check found ${byLevel('error').length} problem${byLevel('error').length === 1 ? '' : 's'}`} description={list(byLevel('error'))} />}
            {byLevel('warning').length > 0 && <Alert type="warning" showIcon message={`${byLevel('warning').length} thing${byLevel('warning').length === 1 ? '' : 's'} to look at (framework standards)`} description={list(byLevel('warning'))} />}
            {review.warnings.length > 0 && <Alert type="info" showIcon message="Notes" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{review.warnings.map((w, i) => <li key={i} style={{ fontSize: 12 }}>{w}</li>)}</ul>} />}
            {!review.findings.length && <Typography.Text type="success" style={{ fontSize: 12 }}><CheckCircleOutlined /> Meets the framework standards: every step is defined, no secrets or hard-coded addresses.</Typography.Text>}
            <div style={{ display: 'flex', gap: 8, minHeight: 0 }}>
                <div style={{ width: 260, flexShrink: 0, border: '1px solid var(--panel-border)', borderRadius: 6, overflow: 'auto', maxHeight: height }}>
                    {review.files.map((f) => {
                        const n = review.findings.filter((x) => x.file === f.path);
                        return (
                            <div key={f.path} className={`item-row${f.path === sel ? ' selected' : ''}`} style={{ cursor: 'pointer', display: 'block', padding: '6px 8px' }} onClick={() => setSel(f.path)}>
                                <div className="mono" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path.split('/').pop()}</div>
                                <Space size={4} style={{ marginTop: 2 }}>
                                    <Tag bordered={false} color={f.change === 'new' ? 'green' : f.change === 'update' ? 'gold' : 'default'} style={{ fontSize: 11 }}>{f.change === 'new' ? 'new' : f.change === 'update' ? 'updated' : 'unchanged'}</Tag>
                                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>{KIND[f.kind] ?? f.kind}{f.change !== 'same' ? ` · +${f.added} −${f.removed}` : ''}</Typography.Text>
                                    {n.some((x) => x.level === 'error') ? <Tag color="red" bordered={false} style={{ fontSize: 11 }}>{n.length}</Tag> : n.length ? <Tag color="orange" bordered={false} style={{ fontSize: 11 }}>{n.length}</Tag> : null}
                                </Space>
                            </div>);
                    })}
                </div>
                <div style={{ flex: 1, minWidth: 0, overflow: 'auto', maxHeight: height, border: '1px solid var(--panel-border)', borderRadius: 6 }}>
                    {!file ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing to change" />
                        : file.change === 'same' ? <Typography.Text type="secondary" style={{ padding: 12, display: 'block' }}>No change: the file already has this content.</Typography.Text>
                            : <><Typography.Text type="secondary" className="mono" style={{ fontSize: 11, padding: '4px 8px', display: 'block' }}>{file.path}</Typography.Text><DiffView diff={file.diff} /></>}
                </div>
            </div>
        </Space>
    );
}
