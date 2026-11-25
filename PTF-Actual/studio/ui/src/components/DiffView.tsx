/**
 * Diff viewer: unified (one column) or side-by-side (old | new, like TortoiseGitMerge's two-pane
 * view, with the changed characters highlighted). Optional per-hunk action, e.g. "Stage this change".
 */
import React from 'react';
import { Button, Empty, Typography } from 'antd';

interface Row { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; oldNo?: number; newNo?: number; text: string; hunk?: number; /** Position in its hunk (the @@ line is 0), as the server counts lines. */ li?: number }

export function parseDiff(diff: string): Row[] {
    const rows: Row[] = [];
    let o = 0, n = 0, inHunk = false, h = -1, li = 0;
    for (const raw of diff.split('\n')) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.startsWith('diff --git')) { inHunk = false; continue; }
        if (line.startsWith('@@')) {
            const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
            if (m) { o = Number(m[1]); n = Number(m[2]); }
            inHunk = true; h++; li = 0;
            rows.push({ kind: 'hunk', text: line, hunk: h, li: 0 });
            continue;
        }
        if (!inHunk) { if (/^Binary files /.test(line)) rows.push({ kind: 'meta', text: 'Binary file — no text preview.' }); continue; }
        if (line.startsWith('+')) rows.push({ kind: 'add', newNo: n++, text: line.slice(1), hunk: h, li: ++li });
        else if (line.startsWith('-')) rows.push({ kind: 'del', oldNo: o++, text: line.slice(1), hunk: h, li: ++li });
        else if (line.startsWith(' ')) rows.push({ kind: 'ctx', oldNo: o++, newNo: n++, text: line.slice(1), hunk: h, li: ++li });
        else if (line.startsWith('\\')) rows.push({ kind: 'meta', text: line, hunk: h, li: ++li });
    }
    return rows;
}

function intra(a: string, b: string | undefined): React.ReactNode {
    if (b === undefined || a === b) return a || ' ';
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return <>{a.slice(0, p)}<mark className="intraline">{a.slice(p, a.length - s) || ' '}</mark>{a.slice(a.length - s)}</>;
}

type Pair = { kind: 'hunk' | 'meta'; text: string; hunk?: number } | { kind: 'pair'; left?: Row; right?: Row };

function toPairs(rows: Row[]): Pair[] {
    const out: Pair[] = [];
    for (let i = 0; i < rows.length;) {
        const r = rows[i];
        if (r.kind === 'hunk' || r.kind === 'meta') { out.push({ kind: r.kind, text: r.text, hunk: r.hunk }); i++; continue; }
        if (r.kind === 'ctx') { out.push({ kind: 'pair', left: r, right: r }); i++; continue; }
        const dels: Row[] = [], adds: Row[] = [];
        while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++]);
        while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++]);
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ kind: 'pair', left: dels[k], right: adds[k] });
    }
    return out;
}

export interface DiffViewProps {
    diff: string;
    loading?: boolean;
    mode?: 'unified' | 'split';
    hunkAction?: { label: string; onClick: (hunk: number) => void };
    /** Choose single added/removed lines (click them) and act on them, e.g. stage only those lines. */
    lineAction?: { label: (n: number) => string; onClick: (hunk: number, lines: number[]) => void };
}

export function DiffView({ diff, loading, mode = 'unified', hunkAction, lineAction }: DiffViewProps) {
    const rows = React.useMemo(() => parseDiff(diff), [diff]);
    const [picked, setPicked] = React.useState<Set<string>>(new Set());
    React.useEffect(() => setPicked(new Set()), [diff]);
    const toggle = (r: Row) => {
        if (!lineAction || (r.kind !== 'add' && r.kind !== 'del')) return;
        const k = `${r.hunk}:${r.li}`;
        setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
    };
    const pickedIn = (h: number) => [...picked].filter((k) => k.startsWith(`${h}:`)).map((k) => Number(k.split(':')[1])).sort((a, b) => a - b);
    const pairs = React.useMemo(() => (mode === 'split' ? toPairs(rows) : []), [rows, mode]);
    if (!loading && rows.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No changes to show for this file" style={{ marginTop: 48 }} />;
    const hunkRow = (text: string, hunk: number | undefined, span: number, key: number) => (
        <tr key={key} className="hunk">
            <td colSpan={span}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Typography.Text type="secondary" style={{ fontFamily: 'inherit', fontSize: 'inherit', flex: 1 }}>{text}</Typography.Text>
                    {lineAction && hunk !== undefined && pickedIn(hunk).length > 0 && <Button size="small" type="primary" onClick={() => { lineAction.onClick(hunk, pickedIn(hunk)); setPicked(new Set()); }}>{lineAction.label(pickedIn(hunk).length)}</Button>}
                    {hunkAction && hunk !== undefined && <Button size="small" onClick={() => hunkAction.onClick(hunk)}>{hunkAction.label}</Button>}
                </span>
            </td>
        </tr>
    );
    if (mode === 'split') {
        return (
            <div className="diff" role="table" aria-label="File changes, side by side">
                <table className="split">
                    <tbody>
                        {pairs.map((p, i) => p.kind !== 'pair'
                            ? (p.kind === 'hunk' ? hunkRow(p.text, p.hunk, 4, i) : <tr key={i} className="meta"><td colSpan={4}>{p.text}</td></tr>)
                            : (
                                <tr key={i}>
                                    <td className={`ln ${p.left?.kind === 'del' ? 'del' : ''}`}>{p.left?.oldNo ?? ''}</td>
                                    <td className={`code half ${p.left ? (p.left.kind === 'del' ? 'del' : '') : 'empty'}`}>{p.left ? (p.left.kind === 'del' ? intra(p.left.text, p.right?.kind === 'add' ? p.right.text : undefined) : (p.left.text || ' ')) : ''}</td>
                                    <td className={`ln ${p.right?.kind === 'add' ? 'add' : ''}`}>{p.right?.newNo ?? ''}</td>
                                    <td className={`code half ${p.right ? (p.right.kind === 'add' ? 'add' : '') : 'empty'}`}>{p.right ? (p.right.kind === 'add' ? intra(p.right.text, p.left?.kind === 'del' ? p.left.text : undefined) : (p.right.text || ' ')) : ''}</td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>
        );
    }
    return (
        <div className="diff" role="table" aria-label="File changes">
            <table>
                <tbody>
                    {rows.map((r, i) => r.kind === 'hunk' ? hunkRow(r.text, r.hunk, 3, i) : (
                        <tr key={i} className={`${r.kind}${picked.has(`${r.hunk}:${r.li}`) ? ' picked' : ''}${lineAction && (r.kind === 'add' || r.kind === 'del') ? ' pickable' : ''}`}
                            onClick={() => toggle(r)} aria-selected={lineAction && (r.kind === 'add' || r.kind === 'del') ? picked.has(`${r.hunk}:${r.li}`) : undefined}>
                            {r.kind === 'meta' ? <td colSpan={3}><Typography.Text type="secondary" style={{ fontFamily: 'inherit', fontSize: 'inherit' }}>{r.text}</Typography.Text></td> : (
                                <>
                                    <td className="ln">{r.oldNo ?? ''}</td>
                                    <td className="ln">{r.newNo ?? ''}</td>
                                    <td className="code">{(r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  ') + r.text}</td>
                                </>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Toolbar for diff display options (shared by every place that shows a diff). */
export interface DiffPrefs { mode: 'unified' | 'split'; ws: 'none' | 'changes' | 'all'; eol: boolean }
export function useDiffPrefs(): [DiffPrefs, (p: Partial<DiffPrefs>) => void] {
    const [p, setP] = React.useState<DiffPrefs>(() => {
        try { return { mode: 'unified', ws: 'none', eol: false, ...JSON.parse(localStorage.getItem('cs-studio-diff') ?? '{}') }; } catch { return { mode: 'unified', ws: 'none', eol: false }; }
    });
    const update = (x: Partial<DiffPrefs>) => setP((old) => { const n = { ...old, ...x }; try { localStorage.setItem('cs-studio-diff', JSON.stringify(n)); } catch { /* ignore */ } return n; });
    return [p, update];
}
