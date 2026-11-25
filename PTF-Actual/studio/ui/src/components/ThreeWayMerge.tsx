/**
 * Three-pane merge tool in the style of TortoiseGitMerge:
 *   Theirs (incoming) | Mine (current)      ← what each side has
 *   Merged (result)                          ← what will be saved
 * The panes scroll together; conflicting blocks are highlighted with the exact changed characters.
 * Per block: use theirs / use mine / both in either order / edit. Keyboard as in TortoiseGitMerge:
 *   F8 / Shift+F8 next / previous conflict, Ctrl+F9 use theirs, Ctrl+F10 use mine,
 *   Ctrl+Shift+F9 theirs before mine, Ctrl+Shift+F10 mine before theirs.
 */
import React from 'react';
import { Button, Divider, Input, Modal, Popover, Space, Tag, Tooltip, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CheckOutlined, EditOutlined } from '@ant-design/icons';
import { alignPanes, blockResult, Choice, PaneRow, Parsed, Segment } from '../../../src/git/conflicts';

const ROW_H = 20;

/** Highlight the part of `a` that differs from `b` (common prefix/suffix removed). */
function diffSpan(a: string, b: string | null | undefined): React.ReactNode {
    if (b === null || b === undefined || a === b) return a || ' ';
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return <>{a.slice(0, p)}<mark className="intraline">{a.slice(p, a.length - s) || ' '}</mark>{a.slice(a.length - s)}</>;
}

interface PaneProps {
    title: React.ReactNode;
    rows: PaneRow[];
    other?: PaneRow[];
    tone: 'theirs' | 'mine' | 'merged';
    current: number;
    choices: Array<Choice | undefined>;
    onPick: (block: number) => void;
    onDouble?: (block: number) => void;
    scrollRef: React.RefObject<HTMLDivElement>;
    onScroll: (el: HTMLDivElement) => void;
}

function Pane({ title, rows, other, tone, current, choices, onPick, onDouble, scrollRef, onScroll }: PaneProps) {
    return (
        <div className="merge-pane">
            <div className="merge-pane-title">{title}</div>
            <div className="merge-pane-body" ref={scrollRef} onScroll={(e) => onScroll(e.currentTarget)}>
                <div style={{ minWidth: 'max-content' }}>
                    {rows.map((r, i) => {
                        const inBlock = r.block !== undefined;
                        const resolved = inBlock && choices[r.block!] !== undefined;
                        const cls = ['merge-row',
                            inBlock ? (tone === 'merged' ? (resolved ? 'm-resolved' : 'm-conflict') : (resolved ? 'm-done' : `m-${tone}`)) : '',
                            inBlock && r.block === current ? 'm-current' : '',
                            r.filler ? 'm-filler' : ''].join(' ');
                        return (
                            <div key={i} className={cls} style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}
                                onClick={inBlock ? () => onPick(r.block!) : undefined}
                                onDoubleClick={inBlock && onDouble ? () => onDouble(r.block!) : undefined}
                                title={inBlock && onDouble ? 'Double-click to use this block' : undefined}>
                                <span className="merge-ln">{r.line ?? ''}</span>
                                <span className="merge-txt">
                                    {r.unresolved && !r.filler ? <span className="m-placeholder">◆ choose Theirs or Mine for this block (or edit it)</span>
                                        : r.text === null ? '' : inBlock && tone !== 'merged' ? diffSpan(r.text, other?.[i]?.text) : (r.text || ' ')}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

export interface ThreeWayMergeProps {
    parsed: Parsed;
    choices: Array<Choice | undefined>;
    setChoice: (k: number, c: Choice) => void;
    mineLabel: string;
    theirsLabel: string;
}

export function ThreeWayMerge({ parsed, choices, setChoice, mineLabel, theirsLabel }: ThreeWayMergeProps) {
    const panes = React.useMemo(() => alignPanes(parsed, choices), [parsed, choices]);
    const blocks = React.useMemo(() => parsed.segments.filter((s): s is Extract<Segment, { kind: 'conflict' }> => s.kind === 'conflict'), [parsed]);
    const [current, setCurrentState] = React.useState(0);
    // Refs hold the latest values so keyboard shortcuts never act on a stale conflict.
    const currentRef = React.useRef(0);
    const choicesRef = React.useRef(choices);
    choicesRef.current = choices;
    const setCurrent = React.useCallback((k: number) => { currentRef.current = k; setCurrentState(k); }, []);
    const [editing, setEditing] = React.useState<{ k: number; text: string } | null>(null);
    const refs = [React.useRef<HTMLDivElement>(null), React.useRef<HTMLDivElement>(null), React.useRef<HTMLDivElement>(null)];
    const syncing = React.useRef(false);

    const onScroll = (src: HTMLDivElement) => {
        if (syncing.current) return;
        syncing.current = true;
        for (const r of refs) if (r.current && r.current !== src) r.current.scrollTop = src.scrollTop;
        requestAnimationFrame(() => { syncing.current = false; });
    };

    const goTo = React.useCallback((k: number) => {
        const n = Math.max(0, Math.min(blocks.length - 1, k));
        setCurrent(n);
        const row = panes.mine.findIndex((r) => r.block === n);
        if (row >= 0) for (const r of refs) if (r.current) r.current.scrollTop = Math.max(0, row * ROW_H - 3 * ROW_H);
    }, [blocks.length, panes.mine, setCurrent]); // eslint-disable-line react-hooks/exhaustive-deps

    const nextOpen = (from: number, dir: 1 | -1) => {
        for (let i = 1; i <= blocks.length; i++) {
            const k = (from + dir * i + blocks.length) % blocks.length;
            if (choicesRef.current[k] === undefined) return k;
        }
        return Math.max(0, Math.min(blocks.length - 1, from + dir));
    };

    const apply = (c: Choice) => {
        const cur = currentRef.current;
        setChoice(cur, c);
        // TortoiseGitMerge habit: after deciding, move to the next unresolved conflict.
        const rest = Array.from({ length: blocks.length }, (_, i) => (i === cur ? c : choicesRef.current[i]));
        choicesRef.current = rest;
        const next = rest.findIndex((x, i) => x === undefined && i > cur);
        const any = rest.findIndex((x) => x === undefined);
        if (next >= 0) goTo(next); else if (any >= 0) goTo(any);
    };

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (editing) return;
            if (e.key === 'F8') { e.preventDefault(); goTo(nextOpen(currentRef.current, e.shiftKey ? -1 : 1)); }
            else if (e.ctrlKey && e.key === 'F9') { e.preventDefault(); apply(e.shiftKey ? 'theirs-first' : 'theirs'); }
            else if (e.ctrlKey && e.key === 'F10') { e.preventDefault(); apply(e.shiftKey ? 'both' : 'ours'); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const left = blocks.length - choices.filter((c) => c !== undefined).length;
    const b = blocks[current];
    return (
        <div className="merge-tool">
            <div className="merge-toolbar">
                <Space wrap size={6}>
                    <Tooltip title="Previous conflict (Shift+F8)"><Button aria-label="Previous conflict (Shift+F8)" size="small" icon={<ArrowUpOutlined />} onClick={() => goTo(nextOpen(currentRef.current, -1))} /></Tooltip>
                    <Tooltip title="Next conflict (F8)"><Button aria-label="Next conflict (F8)" size="small" icon={<ArrowDownOutlined />} onClick={() => goTo(nextOpen(currentRef.current, 1))} /></Tooltip>
                    <Typography.Text strong>Conflict {current + 1} of {blocks.length}</Typography.Text>
                    <Divider type="vertical" />
                    <Tooltip title="Ctrl+F9"><Button size="small" onClick={() => apply('theirs')}>Use theirs</Button></Tooltip>
                    <Tooltip title="Ctrl+F10"><Button size="small" onClick={() => apply('ours')}>Use mine</Button></Tooltip>
                    <Tooltip title="Ctrl+Shift+F9"><Button size="small" onClick={() => apply('theirs-first')}>Theirs before mine</Button></Tooltip>
                    <Tooltip title="Ctrl+Shift+F10"><Button size="small" onClick={() => apply('both')}>Mine before theirs</Button></Tooltip>
                    {b?.base && <Popover title="Common version (what both sides started from)" content={<pre className="mono" style={{ maxHeight: 320, maxWidth: 640, overflow: 'auto', margin: 0 }}>{b.base.length ? b.base.join('\n') : '(empty: both sides added lines here)'}</pre>}>
                        <Button size="small">Base</Button>
                    </Popover>}
                    <Button size="small" icon={<EditOutlined />} onClick={() => setEditing({ k: current, text: (blockResult(b, choices[current]) ?? [...b.ours, ...b.theirs]).join('\n') })}>Edit block</Button>
                </Space>
                <span style={{ flex: 1 }} />
                {left === 0 ? <Tag color="green" icon={<CheckOutlined />}>All conflicts decided</Tag> : <Tag color="volcano">{left} conflict{left === 1 ? '' : 's'} left</Tag>}
            </div>
            <div className="merge-top">
                <Pane title={<><Tag color="green">Theirs</Tag>incoming — {theirsLabel}</>} rows={panes.theirs} other={panes.mine} tone="theirs" current={current} choices={choices}
                    onPick={setCurrent} onDouble={(k) => { setCurrent(k); setChoice(k, 'theirs'); }} scrollRef={refs[0]} onScroll={onScroll} />
                <Pane title={<><Tag color="blue">Mine</Tag>current — {mineLabel}</>} rows={panes.mine} other={panes.theirs} tone="mine" current={current} choices={choices}
                    onPick={setCurrent} onDouble={(k) => { setCurrent(k); setChoice(k, 'ours'); }} scrollRef={refs[1]} onScroll={onScroll} />
            </div>
            <div className="merge-bottom">
                <Pane title={<><Tag color="purple">Merged</Tag>result that will be saved — click a block, double-click above to take a side</>} rows={panes.merged} tone="merged" current={current} choices={choices}
                    onPick={(k) => { setCurrent(k); }} onDouble={(k) => setEditing({ k, text: (blockResult(blocks[k], choices[k]) ?? [...blocks[k].ours, ...blocks[k].theirs]).join('\n') })}
                    scrollRef={refs[2]} onScroll={onScroll} />
            </div>
            <Modal open={!!editing} title={`Edit conflict ${editing ? editing.k + 1 : ''}`} okText="Use this text" width={720} onCancel={() => setEditing(null)}
                onOk={() => { if (editing) { setChoice(editing.k, { custom: editing.text }); setEditing(null); } }}>
                <Typography.Paragraph type="secondary">Write exactly what this part of the file should contain.</Typography.Paragraph>
                <Input.TextArea className="mono" autoSize={{ minRows: 4, maxRows: 20 }} value={editing?.text} onChange={(e) => editing && setEditing({ ...editing, text: e.target.value })} />
            </Modal>
        </div>
    );
}
