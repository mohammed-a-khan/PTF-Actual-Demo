/**
 * Fixing many secret-scan findings at once (the commit review): choose them (one by one, a whole file, every
 * one of a kind, or all), then move them all to the secret store, blank their values, leave their files out of
 * the commit, or mark them as not secrets with one reason.
 *
 * Moving to the store first shows every value's secret name and where it is used (the environment its file is
 * for, else every one), already worked out: values that are the same share one secret, the same name for another
 * value gets _2, and a name already in the store with another value must be renamed or replaced on purpose.
 */
import React from 'react';
import { Alert, App, Button, Checkbox, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import { api, Finding } from '../api';
import { errText, useStudio } from '../state';

type PlanRow = { finding: Finding; name: string; env: string; group: string; exists: 'none' | 'same' | 'different'; decrypted: boolean };

/** Rows whose name and environment are also used for another value (they would overwrite each other). */
export function clashes(rows: Array<{ name: string; env: string; group: string }>): Set<number> {
    const by = new Map<string, Set<string>>();
    rows.forEach((r) => { const k = `${r.name}|${r.env}`; by.set(k, (by.get(k) ?? new Set()).add(r.group)); });
    return new Set(rows.map((r, i) => (by.get(`${r.name}|${r.env}`)!.size > 1 ? i : -1)).filter((i) => i >= 0));
}
const NAME_OK = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function BulkStoreModal({ findings, onClose, onDone }: { findings: Finding[]; onClose: () => void; onDone: () => Promise<void> }) {
    const { message } = App.useApp();
    const { env } = useStudio();
    const [rows, setRows] = React.useState<PlanRow[] | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [overwrite, setOverwrite] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        api.storePlan(findings).then((r) => setRows(r.items.map((x, i) => ({ finding: findings[i], name: x.name, env: x.env ?? '', group: x.group, exists: x.exists, decrypted: x.decrypted }))))
            .catch((e) => setErr(errText(e)));
    }, [findings]);
    const envOptions = React.useMemo(() => {
        const all = new Set<string>();
        Object.values(env?.environments ?? {}).forEach((l) => l.forEach((e) => all.add(e)));
        rows?.forEach((r) => r.env && all.add(r.env));
        return [{ value: '', label: 'Every environment' }, ...[...all].sort().map((e) => ({ value: e, label: e }))];
    }, [env, rows]);
    const bad = rows ? clashes(rows) : new Set<number>();
    const badNames = rows?.filter((r) => !NAME_OK.test(r.name)).length ?? 0;
    const differ = rows?.filter((r) => r.exists === 'different').length ?? 0;
    const secrets = rows ? new Set(rows.map((r) => `${r.name}|${r.env}`)).size : 0;
    const set = (i: number, p: Partial<PlanRow>) => setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, ...p, ...(p.name !== undefined || p.env !== undefined ? { exists: 'none' as const } : {}) } : r)));
    const save = async () => {
        if (!rows) return;
        setBusy(true); setErr(null);
        try {
            const r = await api.fixMany({ action: 'move-to-store', items: rows.map((x) => ({ finding: x.finding, name: x.name, env: x.env || undefined })), overwrite });
            message.success(`${r.moved} value(s) moved to ${r.secrets} secret(s); ${r.files?.length ?? 0} file(s) updated and staged`);
            await onDone();
        } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };
    return (
        <Modal open width={1000} title={`Move ${findings.length} value${findings.length === 1 ? '' : 's'} to the secret store`} onCancel={onClose} destroyOnClose
            footer={<Space>
                <Button onClick={onClose}>Cancel</Button>
                <Tooltip title={bad.size ? 'Two different values have the same name and environment: rename one' : badNames ? 'Names: capital letters, digits and _' : differ && !overwrite ? 'Some names are already in the store with another value: rename them, or tick "Replace"' : undefined}>
                    <Button type="primary" icon={<KeyOutlined />} loading={busy} disabled={!rows || bad.size > 0 || badNames > 0 || (differ > 0 && !overwrite)} onClick={() => void save()} data-testid="bulk-store-save">
                        Save {secrets} secret{secrets === 1 ? '' : 's'} &amp; update files</Button>
                </Tooltip>
            </Space>}>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                Each value is encrypted on this computer; its place in the file becomes <Typography.Text code>{'{env:NAME}'}</Typography.Text>, which the framework fills in when tests run.
                Values that are the same share one secret. A file under <Typography.Text code>config/&lt;project&gt;/environments/&lt;env&gt;</Typography.Text> gets a secret for that environment.
                Values encrypted with the framework's built-in key are stored decrypted (it no longer protects them in the repository).
            </Typography.Paragraph>
            {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} />}
            <Table<PlanRow> size="small" rowKey={(r) => `${r.finding.id}${r.finding.fingerprint}`} loading={!rows && !err} dataSource={rows ?? []} pagination={(rows?.length ?? 0) > 50 ? { pageSize: 50 } : false} scroll={{ y: '46vh' }}
                columns={[
                    { title: 'Where', width: 260, render: (_, r) => <Typography.Text className="mono" style={{ fontSize: 12 }}>{r.finding.file}:{r.finding.line}</Typography.Text> },
                    { title: 'Value', width: 190, render: (_, r) => <Space size={4} style={{ whiteSpace: 'nowrap' }}><Typography.Text code style={{ whiteSpace: 'nowrap' }}>{r.finding.preview}</Typography.Text>{r.decrypted && <Tooltip title="Encrypted with the framework's built-in key: stored decrypted"><Tag style={{ marginInlineEnd: 0 }}>decrypted</Tag></Tooltip>}</Space> },
                    { title: 'Secret name', width: 230, render: (_, r) => { const i = rows!.indexOf(r); return <Input size="small" value={r.name} status={bad.has(i) || !NAME_OK.test(r.name) ? 'error' : undefined} aria-label={`Secret name for ${r.finding.file}:${r.finding.line}`} onChange={(e) => set(i, { name: e.target.value.toUpperCase() })} />; } },
                    { title: 'Used in', width: 160, render: (_, r) => { const i = rows!.indexOf(r); return <Select size="small" style={{ width: '100%' }} value={r.env} options={envOptions} onChange={(v) => set(i, { env: v })} />; } },
                    { title: '', width: 150, render: (_, r) => { const i = rows!.indexOf(r); const same = rows!.filter((x) => x.group === r.group && x.name === r.name && x.env === r.env).length;
                        return bad.has(i) ? <Tag color="red">same name, other value</Tag> : r.exists === 'different' ? <Tooltip title="A secret with this name is already in the store with another value"><Tag color="orange">in the store: other value</Tag></Tooltip>
                            : r.exists === 'same' ? <Tag color="green">already stored</Tag> : same > 1 ? <Tooltip title={`${same} places have this value: one secret`}><Tag>shared ×{same}</Tag></Tooltip> : <Tag color="blue">new</Tag>; } },
                ]} />
            {differ > 0 && <Checkbox style={{ marginTop: 8 }} checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} data-testid="bulk-store-overwrite">Replace the {differ} value{differ === 1 ? '' : 's'} already in the store with another value</Checkbox>}
        </Modal>
    );
}

export function BulkNotSecretModal({ findings, onClose, onDone }: { findings: Finding[]; onClose: () => void; onDone: () => Promise<void> }) {
    const { message } = App.useApp();
    const [reason, setReason] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    return (
        <Modal open title={`Mark ${findings.length} finding${findings.length === 1 ? '' : 's'} as not secrets`} onCancel={onClose} destroyOnClose
            footer={<Space><Button onClick={onClose}>Cancel</Button><Button type="primary" loading={busy} disabled={reason.trim().length < 3} data-testid="bulk-allow-save" onClick={async () => {
                setBusy(true); setErr(null);
                try { await api.fixMany({ action: 'not-a-secret', items: findings.map((f) => ({ finding: f })), reason }); message.success(`${findings.length} marked as not secrets for the whole team`); await onDone(); }
                catch (e) { setErr(errText(e)); } finally { setBusy(false); }
            }}>Mark as not secrets</Button></Space>}>
            <Typography.Paragraph type="secondary">The reason is kept with each one in <Typography.Text code>.cs-studio/secret-allowlist.json</Typography.Text> (committed, so the whole team sees it). Only a salted hash of each value is kept, never the value.</Typography.Paragraph>
            <Input.TextArea autoSize={{ minRows: 2 }} maxLength={500} placeholder="Why are these not secrets? (e.g. public demo passwords of the sample site)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
            {err && <Alert type="error" showIcon message={err} style={{ marginTop: 8 }} />}
        </Modal>
    );
}
