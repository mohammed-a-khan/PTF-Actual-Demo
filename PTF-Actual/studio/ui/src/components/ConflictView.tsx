/**
 * Resolve a conflicted file block by block. Only the parts git could not merge are shown, with a
 * little surrounding context; everything else was merged automatically and is kept as is.
 */
import React from 'react';
import { Alert, App, Button, Card, Col, Input, Radio, Row, Segmented, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import { api } from '../api';
import { errText, useStudio } from '../state';
import { Choice, parseConflicts, resolveConflicts, Segment } from '../../../src/git/conflicts';
import { ThreeWayMerge } from './ThreeWayMerge';
import { MergeToolButton } from './MergeToolButton';

const CONTEXT = 3;

function Lines({ lines, start, tone }: { lines: string[]; start?: number; tone?: 'ours' | 'theirs' | 'ctx' }) {
    const bg = tone === 'ours' ? 'var(--hunk-bg)' : tone === 'theirs' ? 'var(--add-bg)' : undefined;
    return (
        <pre className="code-box" style={{ background: bg, margin: 0, maxHeight: 260, opacity: tone === 'ctx' ? .6 : 1, border: tone === 'ctx' ? 'none' : undefined, padding: tone === 'ctx' ? '2px 8px' : 8 }}>
            {lines.length === 0 ? <Typography.Text type="secondary" italic>(nothing — the lines were removed on this side)</Typography.Text>
                : lines.map((l, i) => <div key={i}>{start !== undefined ? <span style={{ color: 'var(--gutter)', display: 'inline-block', width: 42, userSelect: 'none' }}>{start + i}</span> : null}{l || ' '}</div>)}
        </pre>
    );
}

export function ConflictView({ file, onResolved }: { file: string; onResolved: () => void }) {
    const { message } = App.useApp();
    const { status, refresh } = useStudio();
    const [v, setV] = React.useState<{ ours: string | null; theirs: string | null; working: string | null } | null>(null);
    const [choices, setChoices] = React.useState<Array<Choice | undefined>>([]);
    const [busy, setBusy] = React.useState(false);
    const [view, setView] = React.useState<'three' | 'steps'>(() => { try { return (localStorage.getItem('cs-studio-merge-view') as 'three' | 'steps') || 'three'; } catch { return 'three'; } });
    const changeView = (v: 'three' | 'steps') => { setView(v); try { localStorage.setItem('cs-studio-merge-view', v); } catch { /* ignore */ } };

    React.useEffect(() => {
        setV(null); setChoices([]);
        api.conflict(file).then(setV).catch((e) => message.error(errText(e)));
    }, [file, message]);

    const parsed = React.useMemo(() => (v?.working ? parseConflicts(v.working) : null), [v]);

    const save = async (choice: 'ours' | 'theirs' | { content: string }, label: string) => {
        setBusy(true);
        try { const r = await api.resolve(file, choice); message.success(r.resolved?.message ?? label); await refresh(); onResolved(); }
        catch (e) { message.error(errText(e)); }
        finally { setBusy(false); }
    };

    if (!v) return <Spin style={{ margin: 48 }} />;
    // During a rebase Git swaps the sides: "ours" is the branch being rebased onto, "theirs" is
    // the user's own commit being replayed. Name them for what they are.
    const swapped = !!status?.sidesSwapped;
    const current = swapped ? `${status?.rebaseOnto ?? 'the branch you rebase onto'} (rebasing onto)` : status?.branch ?? 'your branch';
    const incomingOverride = swapped ? `your commit${status?.rebaseBranch ? ` from ${status.rebaseBranch}` : ''}` : null;
    const blocks = parsed?.segments.filter((s): s is Extract<Segment, { kind: 'conflict' }> => s.kind === 'conflict') ?? [];
    const decided = choices.filter((c) => c !== undefined).length;

    // Whole-file decision only (one side deleted the file, or no markers to work with).
    if (!parsed || parsed.conflicts === 0) {
        return (
            <div style={{ padding: 12 }}>
                <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`Conflict in ${file}`}
                    description={v.ours === null ? `This file was deleted on ${swapped ? 'the branch you rebase onto' : 'your branch'} but changed in ${swapped ? 'your commit' : 'the incoming one'}.` : v.theirs === null ? `This file was changed on ${swapped ? 'the branch you rebase onto' : 'your branch'} but deleted in ${swapped ? 'your commit' : 'the incoming one'}.` : 'Choose which version of the whole file to keep.'} />
                <Space>
                    <Button loading={busy} onClick={() => save('ours', v.ours === null ? 'File stays deleted' : 'Kept your version')}>{v.ours === null ? 'Keep it deleted' : 'Keep current'}</Button>
                    <Button loading={busy} onClick={() => save('theirs', 'Took the incoming version')}>{v.theirs === null ? 'Delete it' : 'Take incoming'}</Button>
                </Space>
            </div>
        );
    }

    const setChoice = (n: number, val: Choice) => setChoices((a) => { const b = [...a]; b[n] = val; return b; });
    const header = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--panel-border)', flexWrap: 'wrap' }}>
            <Segmented size="small" value={view} onChange={(v) => changeView(v as 'three' | 'steps')}
                options={[{ value: 'three', label: 'Theirs | Mine | Merged' }, { value: 'steps', label: 'Step by step' }]} />
            <Typography.Text type="secondary" style={{ flex: '1 1 280px' }}>
                {parsed.conflicts} place{parsed.conflicts === 1 ? '' : 's'} changed on both sides; the rest of the file was combined automatically.
            </Typography.Text>
            {blocks.some((b) => b.base === null) && <Tooltip title="Show what both sides started from (the common version) in each conflict. Choices made here so far are cleared.">
                <Button size="small" onClick={async () => { try { await api.conflictWithBase(file); setChoices([]); setV(await api.conflict(file)); } catch (e) { message.error(errText(e)); } }}>Show the common version</Button>
            </Tooltip>}
            <MergeToolButton file={file} onResolved={async () => { await refresh(); onResolved(); }} onClosed={() => { setChoices([]); void api.conflict(file).then(setV).catch(() => undefined); }} />
            <Button type="primary" loading={busy} disabled={decided < parsed.conflicts}
                onClick={() => save({ content: resolveConflicts(parsed, choices as Choice[]) }, `Resolved ${file}`)}>
                Mark as resolved ({decided}/{parsed.conflicts})
            </Button>
        </div>
    );
    if (view === 'three') {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                {header}
                <div style={{ flex: 1, minHeight: 0 }}>
                    <ThreeWayMerge parsed={parsed} choices={choices} setChoice={setChoice} mineLabel={current} theirsLabel={incomingOverride ?? (blocks[0]?.theirsLabel || 'incoming')} />
                </div>
            </div>
        );
    }

    const segs = parsed.segments;
    let k = -1;
    return (
        <div>
        {header}
        <div style={{ padding: 12 }}>
            <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                message={`${parsed.conflicts} place${parsed.conflicts === 1 ? '' : 's'} in ${file} changed on both sides`}
                description={<>Everything else in the file was combined automatically. For each place below, choose what to keep. <b>Current</b> is {current}; <b>Incoming</b> is {incomingOverride ?? (blocks[0]?.theirsLabel || 'the branch being merged')}.</>} />
            {segs.map((s, idx) => {
                if (s.kind !== 'conflict') return null;
                k++;
                const n = k;
                const before = segs[idx - 1]?.kind === 'text' ? (segs[idx - 1] as { lines: string[] }).lines.slice(-CONTEXT) : [];
                const after = segs[idx + 1]?.kind === 'text' ? (segs[idx + 1] as { lines: string[] }).lines.slice(0, CONTEXT) : [];
                const c = choices[n];
                const mode = c === undefined ? undefined : typeof c === 'string' ? c : 'custom';
                const set = (val: Choice) => setChoices((a) => { const b = [...a]; b[n] = val; return b; });
                return (
                    <Card key={idx} size="small" style={{ marginBottom: 12 }}
                        title={<Space>{c !== undefined ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : null}Change {n + 1} of {parsed.conflicts}<Typography.Text type="secondary" className="mono">near line {s.startLine}</Typography.Text></Space>}
                        extra={
                            <Radio.Group size="small" value={mode} onChange={(e) => {
                                const m = e.target.value as string;
                                set(m === 'custom' ? { custom: [...s.ours, ...s.theirs].join('\n') } : (m as Choice));
                            }}>
                                <Radio.Button value="ours">Keep current</Radio.Button>
                                <Radio.Button value="theirs">Take incoming</Radio.Button>
                                <Radio.Button value="both">Keep both</Radio.Button>
                                <Radio.Button value="custom">Edit</Radio.Button>
                            </Radio.Group>}>
                        {before.length > 0 && <Lines lines={before} tone="ctx" />}
                        <Row gutter={8} style={{ margin: '4px 0' }}>
                            <Col span={12}><Tag color="blue">Current — {current}</Tag><Lines lines={s.ours} tone="ours" /></Col>
                            <Col span={12}><Tag color="green">Incoming — {incomingOverride ?? s.theirsLabel}</Tag><Lines lines={s.theirs} tone="theirs" /></Col>
                        </Row>
                        {after.length > 0 && <Lines lines={after} tone="ctx" />}
                        {c !== undefined && typeof c !== 'string' && (
                            <Input.TextArea className="mono" style={{ marginTop: 8 }} autoSize={{ minRows: 2, maxRows: 14 }} value={c.custom} onChange={(e) => set({ custom: e.target.value })} />
                        )}
                    </Card>
                );
            })}
            <Space>
                <Button type="primary" loading={busy} disabled={decided < parsed.conflicts}
                    onClick={() => save({ content: resolveConflicts(parsed, choices as Choice[]) }, `Resolved ${file}`)}>
                    Save resolution ({decided}/{parsed.conflicts} decided)
                </Button>
                <Typography.Text type="secondary">or for the whole file:</Typography.Text>
                <Button size="small" loading={busy} onClick={() => save('ours', 'Kept the current version')}>Keep current</Button>
                <Button size="small" loading={busy} onClick={() => save('theirs', 'Took the incoming version')}>Take incoming</Button>
            </Space>
        </div>
        </div>
    );
}
