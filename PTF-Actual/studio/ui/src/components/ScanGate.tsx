/**
 * Shown when the secret scan stops a commit or push. Explains each finding in plain language, offers
 * one-click fixes (commit only — they edit the staged files), and lets the user commit/push anyway
 * with a recorded reason when the team policy allows it.
 */
import React from 'react';
import { Alert, App, Button, Card, Checkbox, Collapse, Divider, Form, Input, Modal, Result, Select, Space, Tag, Typography, Tooltip } from 'antd';
import { CheckCircleTwoTone, KeyOutlined, LockOutlined, WarningTwoTone } from '@ant-design/icons';
import { api, Finding, GateResult } from '../api';
import { errText, useStudio } from '../state';
import { BulkNotSecretModal, BulkStoreModal } from './BulkSecretFixes';

type Blocked = Extract<GateResult, { status: 'blocked' }>;

export interface ScanGateProps {
    mode: 'commit' | 'push';
    blocked: Blocked;
    message?: string; // commit message
    amend?: boolean;
    /** Add a Signed-off-by line (the commit form's choice, kept when the commit goes through this dialog). */
    signoff?: boolean;
    /** What "commit/push now" does (default: commit or push). Used to finish a cherry-pick/revert. */
    proceed?: (override?: { reason: string; digest: string }) => Promise<GateResult>;
    onClose: () => void;
    onDone: (sha?: string) => void;
}

function FindingCard({ f, mode, onFixed, selected, onSelect }: { f: Finding; mode: 'commit' | 'push'; onFixed: () => Promise<void>; selected?: boolean; onSelect?: (on: boolean) => void }) {
    const { message } = App.useApp();
    const { env } = useStudio();
    const [busy, setBusy] = React.useState<string | null>(null);
    const [form, setForm] = React.useState<'store' | 'allow' | null>(null);
    const [name, setName] = React.useState(f.suggestedName ?? 'SECRET_VALUE');
    const [envName, setEnvName] = React.useState<string>('');
    const [reason, setReason] = React.useState('');
    const envOptions = React.useMemo(() => {
        const all = new Set<string>();
        Object.values(env?.environments ?? {}).forEach((l) => l.forEach((e) => all.add(e)));
        return [{ value: '', label: 'Every environment' }, ...[...all].sort().map((e) => ({ value: e, label: e }))];
    }, [env]);
    const fileLevel = f.line === 0;

    const run = async (key: string, body: Record<string, unknown>, done: string) => {
        setBusy(key);
        try { await api.fix(body); message.success(done); setForm(null); await onFixed(); }
        catch (e) { message.error(errText(e)); }
        finally { setBusy(null); }
    };

    return (
        <Card size="small" style={{ marginBottom: 10 }}
            title={<Space>{onSelect && <Checkbox checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${f.file}:${f.line}`} />}<WarningTwoTone twoToneColor={f.confidence === 'high' ? '#cf1322' : '#d48806'} />{f.type}
                <Tag color={f.confidence === 'high' ? 'red' : 'gold'}>{f.confidence === 'high' ? 'Very likely' : 'Possibly'} a secret</Tag></Space>}
            extra={<Typography.Text className="mono">{fileLevel ? f.file : `${f.file}:${f.line}`}</Typography.Text>}>
            <Typography.Paragraph style={{ marginBottom: 8 }}>{f.reason}</Typography.Paragraph>
            {!fileLevel && <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>Value: <Typography.Text code>{f.preview}</Typography.Text></Typography.Paragraph>}
            {mode === 'commit' ? (
                <>
                    <Space wrap>
                        {!fileLevel && <Button type="primary" icon={<LockOutlined />} onClick={() => setForm(form === 'store' ? null : 'store')}>Move to secret store</Button>}
                        {!fileLevel && <Button loading={busy === 'remove'} onClick={() => run('remove', { action: 'remove', finding: f }, 'Value removed and file re-staged')}>Remove value</Button>}
                        <Button loading={busy === 'unstage'} onClick={() => run('unstage', { action: 'unstage', file: f.file }, `${f.file} left out of this commit`)}>Leave file out of commit</Button>
                        {fileLevel && <Button loading={busy === 'ignore'} onClick={() => run('ignore', { action: 'ignore-file', file: f.file }, `${f.file} added to .gitignore`)}>Never commit this file (.gitignore)</Button>}
                        {!fileLevel && <Button type="text" onClick={() => setForm(form === 'allow' ? null : 'allow')}>Not a secret…</Button>}
                    </Space>
                    {form === 'store' && (
                        <Form layout="vertical" style={{ marginTop: 12 }} onFinish={() => run('store', { action: 'move-to-store', finding: f, name, env: envName || undefined }, `Saved as ${name}; the file now refers to it`)}>
                            <Space align="end" wrap>
                                <Form.Item label="Secret name" style={{ marginBottom: 0 }} help="Capital letters, digits and _">
                                    <Input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} style={{ width: 240 }} />
                                </Form.Item>
                                <Form.Item label="Used in" style={{ marginBottom: 0 }}>
                                    <Select value={envName} onChange={setEnvName} options={envOptions} style={{ width: 180 }} />
                                </Form.Item>
                                <Button type="primary" htmlType="submit" loading={busy === 'store'} icon={<KeyOutlined />}>Save secret &amp; update file</Button>
                            </Space>
                            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                                The value is encrypted on this computer. The file gets <Typography.Text code>{`{env:${name}}`}</Typography.Text>, which the framework fills in when tests run.
                            </Typography.Paragraph>
                        </Form>
                    )}
                    {form === 'allow' && (
                        <Space.Compact style={{ marginTop: 12, width: '100%' }}>
                            <Input placeholder="Why is this not a secret? (e.g. public demo password)" value={reason} onChange={(e) => setReason(e.target.value)} />
                            <Button loading={busy === 'allow'} disabled={reason.trim().length < 3} onClick={() => run('allow', { action: 'not-a-secret', finding: f, reason }, 'Marked as not a secret for the whole team')}>Confirm</Button>
                        </Space.Compact>
                    )}
                </>
            ) : null}
        </Card>
    );
}

export function ScanGate({ mode, blocked, message: commitMessage, amend, signoff, proceed: proceedFn, onClose, onDone }: ScanGateProps) {
    const { message, modal } = App.useApp();
    const { refresh, status } = useStudio();
    // The branch the commit was meant for (as when the review opened): a commit that would land elsewhere is refused.
    const branchAtOpen = React.useRef(status?.branch ?? null);
    const [state, setState] = React.useState<Blocked>(blocked);
    const [reason, setReason] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => setState(blocked), [blocked]);
    // Findings chosen for a fix done to all of them at once (commit only).
    const keyOf = (f: Finding) => `${f.id}|${f.fingerprint}|${f.file}|${f.line}`;
    const [picked, setPicked] = React.useState<Set<string>>(new Set());
    const [kind, setKind] = React.useState<string>('');
    const [bulk, setBulk] = React.useState<'store' | 'allow' | null>(null);
    const [bulkBusy, setBulkBusy] = React.useState(false);

    const rescan = async () => {
        const r = await api.scanStaged();
        setState((s) => ({ ...s, findings: r.findings, digest: r.digest }));
        // What was chosen and is still there stays chosen.
        setPicked((p) => new Set(r.findings.map(keyOf).filter((k) => p.has(k))));
        await refresh();
    };

    const proceed = async (withOverride: boolean) => {
        setBusy(true); setError(null);
        try {
            const ov = withOverride ? { reason, digest: state.digest } : undefined;
            const res = proceedFn ? await proceedFn(ov) : mode === 'commit' ? await api.commit(commitMessage ?? '', ov, { amend, allowRewritePushed: amend, signoff, expectBranch: branchAtOpen.current }) : await api.push(ov);
            if (res.status === 'ok') {
                if (mode === 'push') message.success('Pushed');
                onDone(res.status === 'ok' ? res.sha : undefined);
            } else if (res.status === 'blocked') {
                setState(res);
                setError('The changes were modified since you reviewed them. Review the findings again.');
            } else setError(res.message);
        } catch (e) { setError(errText(e)); }
        finally { setBusy(false); }
    };

    const clear = state.findings.length === 0;
    const kinds = [...state.findings.reduce((m, f) => m.set(f.type, (m.get(f.type) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
    const shown = kind ? state.findings.filter((f) => f.type === kind) : state.findings;
    const byFile = [...shown.reduce((m, f) => m.set(f.file, [...(m.get(f.file) ?? []), f]), new Map<string, Finding[]>())];
    const chosen = state.findings.filter((f) => picked.has(keyOf(f)));
    const lineFindings = chosen.filter((f) => f.line > 0);
    const toggle = (list: Finding[], on: boolean) => setPicked((p) => { const n = new Set(p); for (const f of list) { if (on) n.add(keyOf(f)); else n.delete(keyOf(f)); } return n; });
    const allOn = (list: Finding[]) => list.length > 0 && list.every((f) => picked.has(keyOf(f)));
    const someOn = (list: Finding[]) => list.some((f) => picked.has(keyOf(f)));
    const bulkSimple = (action: 'remove' | 'unstage') => {
        const list = action === 'remove' ? lineFindings : chosen;
        const files = [...new Set(list.map((f) => f.file))];
        modal.confirm({
            title: action === 'remove' ? `Blank ${list.length} value${list.length === 1 ? '' : 's'}?` : `Leave ${files.length} file${files.length === 1 ? '' : 's'} out of this commit?`,
            content: action === 'remove' ? `The values are removed from ${files.length} file${files.length === 1 ? '' : 's'} (and staged). Tests that need them will fail until they are set another way.` : <ul style={{ margin: 0 }}>{files.slice(0, 12).map((x) => <li key={x}><Typography.Text code>{x}</Typography.Text></li>)}{files.length > 12 && <li>and {files.length - 12} more</li>}</ul>,
            okText: action === 'remove' ? 'Blank them' : 'Leave them out',
            onOk: async () => {
                setBulkBusy(true);
                try { await api.fixMany({ action, items: list.map((f) => ({ finding: f })) }); message.success(action === 'remove' ? `${list.length} value(s) blanked` : `${files.length} file(s) left out of this commit`); await rescan(); }
                catch (e) { message.error(errText(e)); } finally { setBulkBusy(false); }
            },
        });
    };
    const verb = mode === 'commit' ? 'Commit' : 'Push';
    return (
        <Modal open width={760} onCancel={onClose} footer={null} destroyOnClose
            title={clear ? `Ready to ${verb.toLowerCase()}` : `${verb} stopped: possible secrets found`}>
            {clear ? (
                <Result icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} title="All clear"
                    subTitle="No secrets left in what you are about to commit."
                    extra={<Button type="primary" loading={busy} onClick={() => proceed(false)}>{verb} now</Button>} />
            ) : (
                <>
                    <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                        message={`${state.findings.length} possible secret${state.findings.length === 1 ? '' : 's'} ${mode === 'commit' ? 'in your staged changes' : 'in commits you are about to push'}`}
                        description={mode === 'commit'
                            ? 'Once committed and pushed, a secret stays in the repository history. Fix them below, one by one or several at once (tick them: a whole file, every one of a kind, or all) — the fixes update your staged files.'
                            : 'These are in commits already made on this computer (possibly outside the Studio). Fix them in a new commit, or push anyway with a reason.'} />
                    {mode === 'commit' && state.findings.length > 1 && <div className="scan-bulk">
                        <Space wrap size={8}>
                            <Checkbox checked={allOn(shown)} indeterminate={!allOn(shown) && someOn(shown)} onChange={(e) => toggle(shown, e.target.checked)} data-testid="scan-select-all">
                                Select all{kind ? ' of this kind' : ''} ({shown.length})</Checkbox>
                            {kinds.length > 1 && <Select size="small" style={{ minWidth: 240 }} value={kind} onChange={setKind} aria-label="Kind of finding"
                                options={[{ value: '', label: `Every kind (${state.findings.length})` }, ...kinds.map(([k, n]) => ({ value: k, label: `${k} (${n})` }))]} />}
                        </Space>
                        {chosen.length > 0 && <Space wrap size={6} style={{ marginTop: 8 }} data-testid="scan-bulk-bar">
                            <Typography.Text strong>{chosen.length} selected:</Typography.Text>
                            <Button size="small" type="primary" icon={<LockOutlined />} disabled={!lineFindings.length || bulkBusy} onClick={() => setBulk('store')}>Move to secret store{lineFindings.length < chosen.length ? ` (${lineFindings.length})` : ''}</Button>
                            <Button size="small" disabled={!lineFindings.length || bulkBusy} onClick={() => bulkSimple('remove')}>Remove values</Button>
                            <Button size="small" disabled={bulkBusy} onClick={() => bulkSimple('unstage')}>Leave {new Set(chosen.map((f) => f.file)).size} file(s) out of commit</Button>
                            <Button size="small" disabled={!lineFindings.length || bulkBusy} onClick={() => setBulk('allow')}>Not secrets…</Button>
                            <Button size="small" type="link" onClick={() => setPicked(new Set())}>Clear</Button>
                        </Space>}
                    </div>}
                    <div style={{ maxHeight: '48vh', overflow: 'auto', paddingRight: 4 }}>
                        {mode === 'commit' && state.findings.length > 1 ? byFile.map(([file, list]) => (
                            <div key={file} className="scan-file">
                                <div className="scan-file-head">
                                    <Checkbox checked={allOn(list)} indeterminate={!allOn(list) && someOn(list)} onChange={(e) => toggle(list, e.target.checked)} aria-label={`Select every finding in ${file}`} />
                                    <Typography.Text className="mono" style={{ fontSize: 12 }}>{file}</Typography.Text>
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{list.length} finding{list.length === 1 ? '' : 's'}</Typography.Text>
                                </div>
                                {list.map((f) => <FindingCard key={f.id + f.fingerprint} f={f} mode={mode} onFixed={rescan} selected={picked.has(keyOf(f))} onSelect={(on) => toggle([f], on)} />)}
                            </div>
                        )) : state.findings.map((f) => <FindingCard key={f.id + f.fingerprint} f={f} mode={mode} onFixed={rescan} />)}
                    </div>
                    {bulk === 'store' && <BulkStoreModal findings={lineFindings} onClose={() => setBulk(null)} onDone={async () => { setBulk(null); await rescan(); }} />}
                    {bulk === 'allow' && <BulkNotSecretModal findings={lineFindings} onClose={() => setBulk(null)} onDone={async () => { setBulk(null); await rescan(); }} />}
                    <Divider style={{ margin: '12px 0' }} />
                    {state.overrideAllowed ? (
                        <Collapse ghost items={[{
                            key: 'o', label: <Typography.Text type="secondary">{verb} anyway…</Typography.Text>,
                            children: (
                                <Space direction="vertical" style={{ width: '100%' }}>
                                    <Typography.Text type="secondary">Your reason is saved in the commit history (<Typography.Text code>Secret-Scan-Override</Typography.Text>) so reviewers can see it.</Typography.Text>
                                    <Input maxLength={300} showCount placeholder="e.g. Value is a fake used by the local mock server" value={reason} onChange={(e) => setReason(e.target.value.replace(/[\r\n]+/g, ' '))} />
                                    {reason.trim().length > 0 && reason.trim().length < 8 && <Typography.Text type="warning" style={{ fontSize: 12 }}>A few more words, please (at least 8 characters).</Typography.Text>}
                                    <Tooltip title={reason.trim().length < 8 ? 'Write why (at least 8 characters) first' : undefined}><Button danger loading={busy} disabled={reason.trim().length < 8} onClick={() => proceed(true)}>{verb} anyway</Button></Tooltip>
                                </Space>
                            ),
                        }]} />
                    ) : (
                        <Alert type="info" showIcon message={state.overrideRefusal ?? 'Your team policy requires fixing these first.'} />
                    )}
                </>
            )}
            {error && <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} />}
        </Modal>
    );
}
