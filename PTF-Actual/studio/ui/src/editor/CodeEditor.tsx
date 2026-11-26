/**
 * CS Code Editor — an in-house code editor (no Monaco/CodeMirror).
 *
 * A transparent <textarea> sits exactly on top of a highlighted rendering of the same text, so the
 * browser provides typing, selection, IME, accessibility, clipboard and native undo/redo; this
 * component adds what a code editor needs:
 *   highlighting · line numbers · problem underlines · completion (Ctrl+Space, ".": a method inserts its call, with
 *   placeholders for its parameters to Tab through) · parameter hints · Copilot inline suggestions (ghost text) · hover info ·
 *   go to definition (F12 / Ctrl+click) · usages (Shift+F12) · rename a step (F2) · find & replace (Ctrl+F / Ctrl+H) · go to line (Ctrl+G) ·
 *   format (Shift+Alt+F) · toggle comment (Ctrl+/) · indent/outdent (Tab / Shift+Tab) ·
 *   auto-indent · bracket and quote pairing · only visible lines are drawn (large files stay fast).
 * Every edit goes through the browser's insertText command, so Ctrl+Z / Ctrl+Y undo everything.
 * The editor works on "\n" line endings only: the caller normalizes CRLF files on load and restores
 * the file's line ending on save (pass it as `eol` for the status bar).
 */
import React from 'react';
import { Button, Checkbox, Input, Space, Tooltip } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined } from '@ant-design/icons';
import { commentPrefix, Highlighter, Lang } from './highlight';
import { completionText, editBetween, ghostOf, inlineFits, InlineSuggestion, needsDetails, nextWordLength, parseSnippet, snippetAfterEdit, SnippetMode } from './assist';
import { editorMenu, MenuEntry } from '../contextMenus';
import { useContextMenu } from '../components/ContextMenu';

export interface EditorDiagnostic { line: number; column: number; endLine: number; endColumn: number; message: string; severity: 'error' | 'warning' | 'info' | string; source?: string }
export interface CompletionItem { name: string; kind: string; sortText?: string; insertText?: string; detail?: string; isSnippet?: boolean; replace?: { start: number; length: number }; hasAction?: boolean; source?: string; data?: unknown; kindModifiers?: string }
export interface CompletionDetails { detail?: string; doc?: string; snippet?: string; edits?: Array<{ start: number; length: number; newText: string }> }
export interface SignatureHelp { signatures: Array<{ label: string; params: Array<[number, number]>; doc: string; paramDocs: string[] }>; active: number; param: number; start: number }
/** Where ghost text comes from (Copilot): asked after a pause in typing; told what was shown and taken. */
export interface InlineProvider {
    suggest: (text: string, offset: number, o: { invoked: boolean; signal: AbortSignal; tabSize: number; insertSpaces: boolean }) => Promise<InlineSuggestion[]>;
    shown: (id: string) => void;
    /** acceptedLength: part of it (from the suggestion's start to the end of what was taken). */
    accepted: (id: string, acceptedLength?: number) => void;
}

export interface CodeEditorProps {
    value: string;
    lang: Lang;
    onChange: (text: string) => void;
    onSave?: () => void;
    diagnostics?: EditorDiagnostic[];
    completions?: (text: string, offset: number, signal?: AbortSignal) => Promise<CompletionItem[]>;
    /** The signature and documentation of one completion, its call snippet and edits that go with it (asked for the highlighted one). */
    completionDetails?: (text: string, offset: number, item: CompletionItem, signal?: AbortSignal) => Promise<CompletionDetails | null>;
    /** Parameter hints while typing a call's arguments (after "(" and ","). */
    signatureHelp?: (text: string, offset: number, trigger?: string, signal?: AbortSignal) => Promise<SignatureHelp | null>;
    /** Copilot inline suggestions (ghost text). */
    inline?: InlineProvider | null;
    /** Extra items at the end of the status bar (e.g. Copilot's status). */
    statusItems?: React.ReactNode;
    hover?: (text: string, offset: number) => Promise<{ text?: string; doc?: string } | null>;
    definition?: (text: string, offset: number) => void;
    /** Format request; apply the result with the handle's applyEdit so it can be undone. */
    format?: (text: string) => void;
    /** Shift+F12: where the thing at the caret is used. */
    usages?: (text: string, offset: number) => void;
    /** F2: rename the thing at the caret. */
    rename?: (text: string, offset: number) => void;
    /** soft: scroll the line into view only when it is out of it, the caret left where it is (the debugger's line). */
    reveal?: { line: number; column?: number; nonce: number; soft?: boolean } | null;
    readOnly?: boolean;
    /** Clickable markers in the line-number gutter, e.g. ▶ Run scenario. */
    gutterActions?: Array<{ line: number; title: string; onClick: () => void }>;
    /** Breakpoint lines (1-based): a red dot on the line number; clicking a line number toggles one. */
    breakpoints?: number[];
    onToggleBreakpoint?: (line: number) => void;
    /** The line a debug run is paused on (1-based): highlighted. */
    execLine?: number | null;
    /** The file's real line ending (the editor itself always works with "\n"). */
    eol?: '\n' | '\r\n';
    /** False while the editor is kept mounted behind another tab (keeps undo history, scroll and caret). */
    active?: boolean;
    /**
     * The page's own items for the right-click menu: `actions` (run, debug, …) after the language items,
     * `file` (copy path, history, …) at the end. The editor's own items (clipboard, find, format, …) are always there.
     */
    contextMenu?: (at: { line: number; offset: number; text: string }) => { actions?: MenuEntry[]; file?: MenuEntry[] };
}

export interface CodeEditorHandle {
    /** Replace the whole text as one undoable edit (only the changed middle part is touched). */
    applyEdit: (text: string) => void;
    /** Line of the caret (1-based), for "go back" after a jump. */
    caretLine: () => number;
    /** The selected text ('' when nothing is selected). */
    selection: () => string;
    focus: () => void;
}

const LH = 20;
const PAD_T = 8;
const PAD_L = 12;
const TAB = 4;
/** A line nothing runs on (empty, a comment, a closing brace): no breakpoint there. */
export const blankOrComment = (l: string) => /^\s*($|\/\/|#|\*|\/\*|[})\]];?\s*$)/.test(l);
/** The file's own indentation: 2 or 4 spaces (the most common step between indented lines), or 0 for tabs. */
export function indentOf(lines: string[]): number {
    const counts = new Map<number, number>();
    let prev = 0, tabs = 0, spaced = 0;
    for (const l of lines.slice(0, 2000)) {
        if (!l.trim()) continue;
        if (l[0] === '\t') { tabs++; continue; }
        if (l[0] === ' ') spaced++;
        const n = /^ */.exec(l)![0].length;
        const d = Math.abs(n - prev);
        if (d === 2 || d === 4) counts.set(d, (counts.get(d) ?? 0) + 1);
        prev = n;
    }
    // A file indented with tabs is indented with tabs (0 means "a tab").
    if (tabs > spaced) return 0;
    const two = counts.get(2) ?? 0, four = counts.get(4) ?? 0;
    return two > four ? 2 : 4;
}

function lineStarts(text: string): number[] {
    const s = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) s.push(i + 1);
    return s;
}
function posOf(starts: number[], offset: number): { line: number; col: number } {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= offset) lo = m; else hi = m - 1; }
    return { line: lo, col: offset - starts[lo] };
}
/** Visual column (tabs expanded) of character index `ch` in a line. */
function visCol(line: string, ch: number): number {
    let v = 0;
    for (let i = 0; i < ch && i < line.length; i++) v = line[i] === '\t' ? v + TAB - (v % TAB) : v + 1;
    return v + Math.max(0, ch - line.length);
}
/** Index of the character under visual column `vis` (tabs expanded). */
function charAtVis(line: string, vis: number): number {
    let v = 0;
    for (let i = 0; i < line.length; i++) {
        const w = line[i] === '\t' ? TAB - (v % TAB) : 1;
        if (v + w > vis) return i;
        v += w;
    }
    return line.length;
}

/** Lines made only of these characters render one monospace cell per UTF-16 unit. */
const SIMPLE = /^[\t\x20-\x7e\xa0-\u02ff]*$/;
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
/** Grapheme clusters (an emoji, a letter plus its combining marks, …) with their UTF-16 start index. */
function clustersOf(line: string): Array<{ segment: string; index: number }> {
    if (segmenter) return Array.from(segmenter.segment(line), (x) => ({ segment: x.segment, index: x.index }));
    const out: Array<{ segment: string; index: number }> = [];
    for (let i = 0; i < line.length;) {
        const cp = line.codePointAt(i)!;
        const len = cp > 0xffff ? 2 : 1;
        if (out.length && /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u200d]/.test(line[i])) out[out.length - 1].segment += line[i];
        else out.push({ segment: line.slice(i, i + len), index: i });
        i += len;
    }
    return out;
}

/** A line's tokens cut at a character column: [before, after]. */
function splitTokens<T extends { s: string }>(toks: T[], col: number): [T[], T[]] {
    const before: T[] = [], after: T[] = [];
    let n = 0;
    for (const t of toks) {
        const end = n + t.s.length;
        if (end <= col) before.push(t);
        else if (n >= col) after.push(t);
        else { before.push({ ...t, s: t.s.slice(0, col - n) }); after.push({ ...t, s: t.s.slice(col - n) }); }
        n = end;
    }
    return [before, after];
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };

export const CodeEditor = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
    const { value, lang, onChange, diagnostics = [], readOnly, active = true } = props;
    const ta = React.useRef<HTMLTextAreaElement>(null);
    const mainRef = React.useRef<HTMLDivElement>(null);
    const compRef = React.useRef<HTMLDivElement>(null);
    const tipRef = React.useRef<HTMLDivElement>(null);
    const sigRef = React.useRef<HTMLDivElement>(null);
    const ctxRef = React.useRef<CanvasRenderingContext2D | null>(null);
    const widths = React.useRef(new Map<string, number>());
    const savedScroll = React.useRef({ top: 0, left: 0 });
    const highlighter = React.useRef(new Highlighter());
    const [scroll, setScroll] = React.useState({ top: 0, left: 0, height: 600 });
    const [cw, setCw] = React.useState(7.8);
    const [caret, setCaret] = React.useState(0);
    const [comp, setComp] = React.useState<{ items: CompletionItem[]; index: number; from: number; line: number; col: number; reqOff: number; details: Map<string, CompletionDetails | null> } | null>(null);
    const compAbort = React.useRef<AbortController | null>(null);
    const compOpen = React.useRef(false);
    compOpen.current = !!comp;
    const [, bumpDetails] = React.useReducer((x: number) => x + 1, 0);
    // Snippet mode (placeholders to Tab through), parameter hints, Copilot's ghost text.
    const [snip, setSnipState] = React.useState<SnippetMode | null>(null);
    const snipRef = React.useRef<SnippetMode | null>(null);
    const setSnip = (m: SnippetMode | null) => { snipRef.current = m; setSnipState(m); };
    const [sig, setSig] = React.useState<SignatureHelp | null>(null);
    const sigAbort = React.useRef<AbortController | null>(null);
    const sigTimer = React.useRef<number>();
    const [ghost, setGhostState] = React.useState<{ items: InlineSuggestion[]; index: number; invoked: boolean } | null>(null);
    const ghostRef = React.useRef<typeof ghost>(null);
    const setGhost = (g: typeof ghost) => { ghostRef.current = g; setGhostState(g); };
    const ghostTimer = React.useRef<number>();
    const ghostAbort = React.useRef<AbortController | null>(null);
    const ghostShown = React.useRef(new Set<string>());
    /** The text and caret after the last edit (a caret move without an edit dismisses the ghost text). */
    const lastText = React.useRef(value);
    const lastEditCaret = React.useRef(-1);
    const [tip, setTip] = React.useState<{ x: number; y: number; text: string; doc?: string } | null>(null);
    const [find, setFind] = React.useState<{ open: boolean; replace: boolean; q: string; r: string; cs: boolean; re: boolean; word: boolean; idx: number }>({ open: false, replace: false, q: '', r: '', cs: false, re: false, word: false, idx: 0 });
    // Opening Find (Ctrl+F/H) moves the focus into its box in the same render, so keys typed right
    // after the shortcut go into the box, never into the code (a timer left a window for that).
    const findOpenNonce = React.useRef(0);
    React.useLayoutEffect(() => { if (find.open) { findInput.current?.focus(); findInput.current?.select(); } }, [find.open, findOpenNonce.current]); // eslint-disable-line react-hooks/exhaustive-deps
    const [gotoOpen, setGotoOpen] = React.useState(false);
    const hoverTimer = React.useRef<number>();
    const findInput = React.useRef<HTMLInputElement | null>(null);
    const menu = useContextMenu();
    // A short notice in the status bar (e.g. "Use Ctrl+V to paste" when the browser does not let the menu read the clipboard).
    const [note, setNote] = React.useState<string | null>(null);
    const noteTimer = React.useRef<number>();
    const say = (text: string) => { setNote(text); window.clearTimeout(noteTimer.current); noteTimer.current = window.setTimeout(() => setNote(null), 5000); };
    React.useEffect(() => () => window.clearTimeout(noteTimer.current), []);

    const lines = React.useMemo(() => value.split('\n'), [value]);
    // A text change that did not come from typing here (another tab saved it, a reload): the next edit compares with it.
    React.useEffect(() => { if (!ta.current || ta.current.value === value) lastText.current = value; }, [value]);
    // The indentation step of this file (2 or 4 spaces), for Tab, Enter and the status bar.
    const fileIndent = React.useMemo(() => indentOf(lines), [lines]);
    const useTabs = fileIndent === 0;
    const step = useTabs ? 4 : fileIndent;
    const unit = useTabs ? '\t' : ' '.repeat(step);
    const starts = React.useMemo(() => { const s = new Array<number>(lines.length); let o = 0; for (let i = 0; i < lines.length; i++) { s[i] = o; o += lines[i].length + 1; } return s; }, [lines]);
    const tokens = React.useMemo(() => highlighter.current.update(lines, lang), [lines, lang]);
    const caretPos = posOf(starts, Math.min(caret, value.length));

    // ---- horizontal geometry: pixel x of a character index, and the index at a pixel x.
    // Plain lines use cell math; lines with wide (CJK, emoji) or combining characters are measured
    // with the same font the textarea uses, cluster by cluster, so overlays line up with the text.
    const clusterW = (seg: string) => {
        let w = widths.current.get(seg);
        if (w === undefined) { w = ctxRef.current ? ctxRef.current.measureText(seg).width : cw * seg.length; widths.current.set(seg, w); }
        return w;
    };
    const tabStop = (x: number) => { const tw = TAB * cw; let n = (Math.floor(x / tw + 1e-6) + 1) * tw; if (n - x < cw / 2) n += tw; return n; };
    const xAt = (line: string, ch: number): number => {
        if (SIMPLE.test(line)) return visCol(line, ch) * cw;
        let x = 0;
        for (const { segment, index } of clustersOf(line)) {
            if (index >= ch) return x;
            x = segment === '\t' ? tabStop(x) : x + clusterW(segment);
        }
        return x + Math.max(0, ch - line.length) * cw;
    };
    const chAtX = (line: string, x: number): number => {
        if (SIMPLE.test(line)) return charAtVis(line, x / cw);
        let cx = 0;
        for (const { segment, index } of clustersOf(line)) {
            const nx = segment === '\t' ? tabStop(cx) : cx + clusterW(segment);
            if (nx > x) return index;
            cx = nx;
        }
        return line.length;
    };

    // Measure the monospace character width once fonts are ready.
    React.useEffect(() => {
        const measure = () => {
            const el = ta.current; if (!el) return;
            const c = document.createElement('canvas').getContext('2d')!;
            // Not the `font` shorthand: it is empty when font-variant-ligatures is set (canvas would fall back to 10px sans-serif).
            const cs = getComputedStyle(el);
            c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            ctxRef.current = c;
            widths.current.clear();
            setCw(c.measureText('M'.repeat(100)).width / 100);
        };
        measure();
        void document.fonts?.ready.then(measure);
    }, []);

    React.useEffect(() => {
        const el = ta.current; if (!el) return;
        const ro = new ResizeObserver(() => { if (el.clientHeight) setScroll((s) => ({ ...s, height: el.clientHeight })); });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Coming back to this tab: restore where the user was (scroll and caret are kept per editor).
    React.useLayoutEffect(() => {
        const el = ta.current; if (!el || !active) return;
        el.scrollTop = savedScroll.current.top; el.scrollLeft = savedScroll.current.left;
        setScroll({ top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight || 600 });
        setCaret(el.selectionStart);
        if (!readOnly) el.focus({ preventScroll: true });
    }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

    // Reveal a position (go to definition, problem click, search result).
    React.useEffect(() => {
        if (!props.reveal || !ta.current) return;
        const l = Math.max(0, Math.min(starts.length - 1, props.reveal.line - 1));
        const off = Math.min(value.length, starts[l] + Math.max(0, (props.reveal.column ?? 1) - 1));
        const el = ta.current;
        if (props.reveal.soft) {
            const top = l * LH, margin = 3 * LH;
            if (top < el.scrollTop + margin || top + LH > el.scrollTop + el.clientHeight - margin) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
            return;
        }
        el.focus();
        el.setSelectionRange(off, off);
        el.scrollTop = Math.max(0, l * LH - el.clientHeight / 2);
        setCaret(off);
    }, [props.reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

    // ---------------------------------------------------------------- editing primitives
    /** Replace [start, end) with `text` through the browser so the change is undoable. */
    const insert = (text: string, start: number, end: number, caretAt?: number) => {
        const el = ta.current; if (!el || readOnly) return;
        el.focus();
        el.setSelectionRange(start, end);
        const ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text);
        if (!ok) { el.setRangeText(text, start, end, 'end'); onChange(el.value); }
        if (caretAt !== undefined) el.setSelectionRange(caretAt, caretAt);
        setCaret(el.selectionStart);
    };

    /** Turn the whole text into `next` with one undoable edit that touches only the changed middle. */
    const replaceText = (next: string) => {
        const el = ta.current; if (!el || readOnly) return;
        const curText = el.value;
        if (next === curText) return;
        const max = Math.min(curText.length, next.length);
        let a = 0;
        while (a < max && curText.charCodeAt(a) === next.charCodeAt(a)) a++;
        if (a > 0 && a < max && /[\ud800-\udbff]/.test(curText[a - 1])) a--;
        let b = 0;
        while (b < max - a && curText.charCodeAt(curText.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
        if (b > 0 && /[\udc00-\udfff]/.test(curText[curText.length - b])) b--;
        const top = el.scrollTop, left = el.scrollLeft, c0 = el.selectionStart;
        const mid = next.slice(a, next.length - b);
        const c = c0 <= a ? c0 : c0 >= curText.length - b ? c0 + next.length - curText.length : Math.min(c0, a + mid.length);
        insert(mid, a, curText.length - b, c);
        el.scrollTop = top; el.scrollLeft = left;
    };

    React.useImperativeHandle(ref, () => ({ applyEdit: replaceText, caretLine: () => (ta.current ? posOf(starts, ta.current.selectionStart).line + 1 : 1), selection: () => (ta.current ? ta.current.value.slice(ta.current.selectionStart, ta.current.selectionEnd) : ''), focus: () => ta.current?.focus() }));

    const selectedLines = () => {
        const el = ta.current!;
        const a = posOf(starts, el.selectionStart).line;
        let b = posOf(starts, el.selectionEnd).line;
        if (b > a && el.selectionEnd === starts[b]) b--;
        return { a, b, from: starts[a], to: b + 1 < starts.length ? starts[b + 1] - 1 : value.length };
    };

    const indent = (out: boolean) => {
        const el = ta.current!;
        const multi = el.selectionStart !== el.selectionEnd && posOf(starts, el.selectionStart).line !== posOf(starts, el.selectionEnd).line;
        if (!out && !multi) { insert(useTabs ? '\t' : ' '.repeat(step - (caretPos.col % step) || step), el.selectionStart, el.selectionEnd); return; }
        const { a, b, from, to } = selectedLines();
        const block = lines.slice(a, b + 1).map((l) => (out ? l.replace(new RegExp(`^( {1,${step}}|\\t)`), '') : (l.length ? unit + l : l)));
        const text = block.join('\n');
        insert(text, from, to);
        el.setSelectionRange(from, from + text.length);
    };

    const toggleComment = () => {
        const prefix = commentPrefix(lang); if (!prefix) return;
        const el = ta.current!;
        const { a, b, from, to } = selectedLines();
        const block = lines.slice(a, b + 1);
        const p = prefix.trim();
        const allCommented = block.filter((l) => l.trim()).every((l) => l.trimStart().startsWith(p));
        const minIndent = Math.min(...block.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 1000);
        const next = block.map((l) => {
            if (!l.trim()) return l;
            if (allCommented) return l.replace(new RegExp(`^(\\s*)${p.replace(/[/#]/g, '\\$&')} ?`), '$1');
            return l.slice(0, minIndent) + prefix + l.slice(minIndent);
        });
        const text = next.join('\n');
        insert(text, from, to);
        el.setSelectionRange(from, from + text.length);
    };

    const newline = () => {
        const el = ta.current!;
        const line = lines[caretPos.line] ?? '';
        const before = line.slice(0, caretPos.col);
        let ind = /^\s*/.exec(line)![0];
        if (/[{([]\s*$/.test(before) || (lang === 'feature' && /^\s*(Feature|Background|Scenario.*|Rule|Example|Examples):/.test(before)) || (lang === 'yaml' && /:\s*$/.test(before))) ind += unit;
        const after = line.slice(caretPos.col);
        if (/^\s*[})\]]/.test(after) && /[{([]\s*$/.test(before)) {
            const base = /^\s*/.exec(line)![0];
            insert('\n' + ind + '\n' + base, el.selectionStart, el.selectionEnd, el.selectionStart + 1 + ind.length);
        } else insert('\n' + ind, el.selectionStart, el.selectionEnd);
    };

    // ---------------------------------------------------------------- completion
    const wordStartIn = (text: string, offset: number) => {
        if (lang === 'feature') {
            const ls = text.lastIndexOf('\n', offset - 1) + 1;
            const m = /^(\s*(?:Given|When|Then|And|But|\*)\s+)/.exec(text.slice(ls, offset));
            return m ? ls + m[1].length : offset;
        }
        let i = offset;
        while (i > 0 && /[\w$]/.test(text[i - 1])) i--;
        return i;
    };

    /** Ask for completions at the caret: at once (no wait), an older request still on its way is dropped. */
    const openCompletion = async () => {
        if (!props.completions || !ta.current) return;
        compAbort.current?.abort();
        const ac = new AbortController();
        compAbort.current = ac;
        dismissGhost();
        const el = ta.current;
        const off = el.selectionStart, text = el.value;
        const items = await props.completions(text, off, ac.signal).catch(() => [] as CompletionItem[]);
        const now = ta.current;
        if (ac.signal.aborted || !now) return;
        // Still where it was asked (the person may have typed on: the list filters by what they typed).
        if (now.value.slice(0, off) !== text.slice(0, off) || now.selectionStart < off) return;
        if (!items.length) { setComp(null); return; }
        const p = posOf(lineStarts(text), off);
        setComp({ items, index: 0, from: wordStartIn(text, off), line: p.line, col: p.col, reqOff: off, details: new Map() });
    };

    const filtered = React.useMemo(() => {
        if (!comp) return [];
        const typed = value.slice(comp.from, caret).toLowerCase();
        const words = typed.split(/\s+/).filter(Boolean);
        const list = comp.items.filter((it) => {
            const n = it.name.toLowerCase();
            return lang === 'feature' ? words.every((w) => n.includes(w.replace(/"[^"]*"?/g, ''))) : n.startsWith(typed) || (typed.length > 1 && n.includes(typed));
        });
        // Names that start with what was typed first; then the language service's order.
        return list.sort((a, b) => (typed && lang !== 'feature' ? Number(!a.name.toLowerCase().startsWith(typed)) - Number(!b.name.toLowerCase().startsWith(typed)) : 0) || (a.sortText ?? '').localeCompare(b.sortText ?? '') || a.name.localeCompare(b.name)).slice(0, 200);
    }, [comp, value, caret, lang]);
    const selItem = comp && filtered.length ? filtered[Math.min(comp.index, filtered.length - 1)] : null;
    const detailKey = (it: CompletionItem) => `${it.name}\0${it.source ?? ''}`;

    // The highlighted completion's signature and documentation (asked for that one only, shortly after it is highlighted).
    React.useEffect(() => {
        if (!comp || !selItem || !props.completionDetails || lang !== 'ts' || selItem.insertText !== undefined && !selItem.hasAction) return;
        const k = detailKey(selItem);
        if (comp.details.has(k)) return;
        const ac = new AbortController();
        const t = window.setTimeout(() => {
            const el = ta.current; if (!el) return;
            props.completionDetails!(el.value, comp.reqOff, selItem, ac.signal).then((d) => { if (!ac.signal.aborted) { comp.details.set(k, d); bumpDetails(); } }, () => undefined);
        }, 50);
        return () => { window.clearTimeout(t); ac.abort(); };
    }, [comp, selItem?.name, selItem?.source]); // eslint-disable-line react-hooks/exhaustive-deps

    /** Select a snippet's tab stop (the last one, $0, ends snippet mode). */
    const gotoStop = (m: SnippetMode, i: number) => {
        const el = ta.current; if (!el) return;
        const st = m.stops[i]; if (!st) { setSnip(null); return; }
        el.setSelectionRange(st.start, st.end);
        setCaret(st.start);
        setSnip(st.index === 0 || i >= m.stops.length - 1 ? null : { ...m, cur: i });
    };

    const accept = async (it: CompletionItem) => {
        if (!comp || !ta.current) return;
        const el = ta.current;
        const c = comp;
        setComp(null);
        if (lang === 'feature') {
            const text = it.insertText ?? it.name;
            const end = starts[c.line + 1] !== undefined ? starts[c.line + 1] - 1 : value.length;
            const q = text.indexOf('""');
            insert(text, c.from, end, q >= 0 ? c.from + q + 1 : undefined);
            return;
        }
        let details = c.details.get(detailKey(it));
        // A method's call snippet comes from its signature: asked for now if it was not yet (it takes a few ms).
        if (details === undefined && props.completionDetails && (needsDetails(it) || it.hasAction)) {
            const textAt = el.value;
            details = await Promise.race([props.completionDetails(textAt, c.reqOff, it).catch(() => null), new Promise<undefined>((r) => setTimeout(() => r(undefined), 600))]);
            if (!ta.current || ta.current.value !== textAt) return;
        }
        const caretNow = el.selectionStart;
        const from = it.replace ? it.replace.start : c.from;
        const end = it.replace ? Math.max(caretNow, it.replace.start + it.replace.length + Math.max(0, caretNow - c.reqOff)) : caretNow;
        const text = el.value;
        const ls = text.lastIndexOf('\n', from - 1) + 1;
        const plan = completionText(it, details, { nextChar: text[end] ?? '', lineBefore: text.slice(ls, from) });
        const parsed = plan.snippet ? parseSnippet(plan.text) : { text: plan.text, stops: [{ index: 0, start: plan.text.length, end: plan.text.length }] };
        const edits = it.hasAction ? (details?.edits ?? []).filter((e) => e.start + e.length <= from || e.start >= end) : [];
        let base = from;
        if (edits.length) {
            // The import (or other edit) and the completion as one change: one Ctrl+Z undoes both.
            const all = [...edits.map((e) => ({ start: e.start, end: e.start + e.length, text: e.newText })), { start: from, end, text: parsed.text }].sort((x, y) => y.start - x.start);
            let next = text;
            for (const e of all) next = next.slice(0, e.start) + e.text + next.slice(e.end);
            base = from + edits.filter((e) => e.start < from).reduce((n, e) => n + e.newText.length - e.length, 0);
            replaceText(next);
        } else insert(parsed.text, from, end);
        const stops = parsed.stops.map((x) => ({ ...x, start: x.start + base, end: x.end + base }));
        const m: SnippetMode = { stops, cur: 0, start: base, end: base + parsed.text.length };
        if (stops.length > 1) gotoStop(m, 0);
        else { el.setSelectionRange(stops[0].start, stops[0].end); setCaret(stops[0].start); setSnip(null); }
        // A call was inserted: its parameter hints.
        if (plan.snippet && it.insertText === undefined && parsed.text.includes('(')) requestSig('(');
    };

    // ---------------------------------------------------------------- parameter hints
    const requestSig = (trigger?: string) => {
        if (!props.signatureHelp || lang !== 'ts') return;
        window.clearTimeout(sigTimer.current);
        sigAbort.current?.abort();
        const ac = new AbortController();
        sigAbort.current = ac;
        // After the editor applied the change (the caret is where the hint is for).
        window.setTimeout(() => {
            const el = ta.current; if (!el || ac.signal.aborted) return;
            const text = el.value, off = el.selectionStart;
            props.signatureHelp!(text, off, trigger, ac.signal).then((h) => {
                if (ac.signal.aborted || !ta.current || ta.current.value !== text) return;
                setSig(h && h.signatures.length ? h : null);
            }, () => undefined);
        }, 0);
    };
    // While the hint shows, it follows the caret (the active parameter); before its "(" it closes.
    React.useEffect(() => {
        if (!sig) return;
        if (caret < sig.start) { setSig(null); return; }
        window.clearTimeout(sigTimer.current);
        sigTimer.current = window.setTimeout(() => requestSig(), 120);
        return () => window.clearTimeout(sigTimer.current);
    }, [caret, value]); // eslint-disable-line react-hooks/exhaustive-deps

    // ---------------------------------------------------------------- Copilot inline suggestions (ghost text)
    const dismissGhost = () => { window.clearTimeout(ghostTimer.current); ghostAbort.current?.abort(); if (ghostRef.current) setGhost(null); };
    const requestInline = async (invoked: boolean) => {
        const el = ta.current, provider = props.inline;
        if (!el || !provider || readOnly) return;
        // Never while the completion list is open (it wins Tab) or while Tabbing through a snippet.
        if (compOpen.current || snipRef.current || el.selectionStart !== el.selectionEnd) return;
        const off = el.selectionStart, text = el.value;
        const le = text.indexOf('\n', off);
        if (!invoked && !inlineFits(text.slice(off, le < 0 ? text.length : le))) return;
        ghostAbort.current?.abort();
        const ac = new AbortController();
        ghostAbort.current = ac;
        const items = await provider.suggest(text, off, { invoked, signal: ac.signal, tabSize: step, insertSpaces: !useTabs }).catch(() => [] as InlineSuggestion[]);
        const now = ta.current;
        if (ac.signal.aborted || !now || now.value !== text || now.selectionStart !== off || now.selectionEnd !== off || compOpen.current || snipRef.current) return;
        const fit = items.filter((x) => ghostOf(x, text, off));
        if (!fit.length) { if (!invoked) setGhost(null); return; }
        const cur = ghostRef.current?.items[ghostRef.current.index];
        const idx = invoked && cur ? Math.max(0, fit.findIndex((x) => x.text !== cur.text)) : 0;
        lastEditCaret.current = off;
        setGhost({ items: fit, index: idx, invoked });
    };
    const scheduleInline = () => {
        window.clearTimeout(ghostTimer.current);
        ghostAbort.current?.abort();
        if (!props.inline || readOnly) return;
        ghostTimer.current = window.setTimeout(() => { void requestInline(false); }, 350);
    };
    React.useEffect(() => () => { window.clearTimeout(ghostTimer.current); ghostAbort.current?.abort(); compAbort.current?.abort(); sigAbort.current?.abort(); }, []);
    // No provider any more (Copilot turned off, signed out): no ghost text.
    React.useEffect(() => { if (!props.inline) dismissGhost(); }, [props.inline]); // eslint-disable-line react-hooks/exhaustive-deps
    const ghostItem = ghost ? ghost.items[ghost.index] : null;
    const ghostView = ghostItem && !(comp && filtered.length) && !snip && caret === lastEditCaret.current && ta.current?.selectionStart === ta.current?.selectionEnd ? ghostOf(ghostItem, value, caret) : null;
    // A caret move (click, arrows) without an edit, or text that no longer fits: the ghost text goes.
    React.useEffect(() => { if (ghost && !ghostView) setGhost(null); }); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => {
        if (ghostView && ghostItem && props.inline && !ghostShown.current.has(ghostItem.id)) { ghostShown.current.add(ghostItem.id); props.inline.shown(ghostItem.id); }
    }, [ghostItem?.id, !!ghostView]); // eslint-disable-line react-hooks/exhaustive-deps
    const acceptGhost = (word: boolean) => {
        const el = ta.current;
        if (!el || !ghostItem || !ghostView || !props.inline) return false;
        const at = el.selectionStart;
        if (!word) {
            insert(ghostItem.text, ghostItem.start, ghostView.replaceEnd, ghostItem.start + ghostItem.text.length);
            props.inline.accepted(ghostItem.id);
            setGhost(null);
            return true;
        }
        const n = nextWordLength(ghostView.ghost);
        const piece = ghostView.ghost.slice(0, n);
        if (n >= ghostView.ghost.length) {
            insert(ghostItem.text, ghostItem.start, ghostView.replaceEnd, ghostItem.start + ghostItem.text.length);
            props.inline.accepted(ghostItem.id);
            setGhost(null);
            return true;
        }
        insert(piece, at, at);
        lastEditCaret.current = at + n;
        props.inline.accepted(ghostItem.id, at + n - ghostItem.start);
        return true;
    };
    const cycleGhost = (dir: 1 | -1) => {
        const g = ghostRef.current;
        if (g && g.items.length > 1) { setGhost({ ...g, index: (g.index + dir + g.items.length) % g.items.length }); return; }
        void requestInline(true);
    };

    /** Every edit (typed, pasted, inserted by the editor): snippet stops follow it; "." asks for completions, "(" and "," for parameter hints; a pause asks Copilot. */
    const onEdit = (el: HTMLTextAreaElement, ev: Event) => {
        const prev = lastText.current, next = el.value;
        lastText.current = next;
        const d = editBetween(prev, next);
        if (d && snipRef.current) setSnip(snippetAfterEdit(snipRef.current, d.at, d.removed, d.inserted));
        lastEditCaret.current = el.selectionStart;
        const data = (ev as InputEvent).data ?? null;
        const typed = (ev as InputEvent).inputType === 'insertText';
        if (lang === 'ts' && typed && data === '.' && !readOnly) void openCompletion();
        if (lang === 'ts' && typed && (data === '(' || data === '()' || data === ',')) requestSig(data[0]);
        // Typing what the ghost text shows keeps it; anything else asks again after a pause.
        const g = ghostRef.current;
        if (g && ghostOf(g.items[g.index], next, el.selectionStart)) return;
        if (g) setGhost(null);
        if (typed || (ev as InputEvent).inputType === 'insertLineBreak' || (ev as InputEvent).inputType?.startsWith('delete')) scheduleInline();
        else { window.clearTimeout(ghostTimer.current); ghostAbort.current?.abort(); }
    };

    // ---------------------------------------------------------------- find
    /** The search as a regex ('m' so ^ and $ work per line), or null while the pattern is invalid. */
    const findRe = (sticky = false): RegExp | null => {
        if (!find.q) return null;
        try {
            const src = find.re ? find.q : find.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(find.word ? `\\b(?:${src})\\b` : src, (sticky ? 'my' : 'gm') + (find.cs ? '' : 'i'));
        } catch { return null; }
    };
    const findAll = (text: string): Array<[number, number]> => {
        const re = findRe(); if (!re) return [];
        const out: Array<[number, number]> = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) && out.length < 10000) { if (m[0].length === 0) { re.lastIndex++; continue; } out.push([m.index, m.index + m[0].length]); }
        return out;
    };
    const matches = React.useMemo(() => (find.open && find.q ? findAll(value) : []), [find.open, find.q, find.cs, find.re, find.word, value]); // eslint-disable-line react-hooks/exhaustive-deps

    const selectMatch = (list: Array<[number, number]>, i: number) => {
        const el = ta.current; if (!el || !list.length) return;
        const [s, e] = list[i];
        el.focus(); el.setSelectionRange(s, e);
        const l = posOf(lineStarts(el.value), s).line;
        if (l * LH < el.scrollTop || l * LH > el.scrollTop + el.clientHeight - 3 * LH) el.scrollTop = Math.max(0, l * LH - el.clientHeight / 3);
        setCaret(s); setFind((f) => ({ ...f, idx: i }));
        setTimeout(() => findInput.current?.focus(), 0);
    };
    const goMatch = (dir: 1 | -1) => {
        if (!matches.length || !ta.current) return;
        const el = ta.current, a = el.selectionStart, empty = a === el.selectionEnd;
        let i: number;
        if (dir === 1) {
            // From a bare caret, a match starting right at the caret is the next one.
            i = matches.findIndex(([s]) => (empty ? s >= a : s > a));
            if (i < 0) i = 0;
        } else {
            i = -1;
            for (let k = matches.length - 1; k >= 0; k--) if (matches[k][0] < a) { i = k; break; }
            if (i < 0) i = matches.length - 1;
        }
        selectMatch(matches, i);
    };

    /** The replacement for the match at [s, e), with $1 / $& / $<name> expanded in regex mode. */
    const replacementAt = (text: string, s: number, e: number) => {
        if (!find.re) return find.r;
        const re = findRe(true); if (!re) return find.r;
        re.lastIndex = s;
        const out = text.replace(re, find.r);
        return out.slice(s, out.length - (text.length - e));
    };
    const replaceOne = () => {
        const el = ta.current; if (!el) return;
        const cur = matches.find(([s, e]) => s === el.selectionStart && e === el.selectionEnd);
        if (!cur) { goMatch(1); return; }
        const rep = replacementAt(el.value, cur[0], cur[1]);
        insert(rep, cur[0], cur[1]);
        // The next match comes from the text as it is now, after this replacement.
        const list = findAll(el.value);
        if (!list.length) return;
        const i = list.findIndex(([s]) => s >= cur[0] + rep.length);
        selectMatch(list, i < 0 ? 0 : i);
    };
    const replaceAll = () => {
        const re = findRe(); if (!re || !matches.length) return;
        const r = find.r;
        replaceText(find.re ? value.replace(re, r) : value.replace(re, () => r));
    };

    const openFind = (replace: boolean) => {
        const el = ta.current; if (!el) return;
        const sel = el.value.slice(el.selectionStart, el.selectionEnd);
        findOpenNonce.current++;
        setFind((f) => ({ ...f, open: true, replace: replace || f.replace, q: sel && !sel.includes('\n') ? sel : f.q }));
    };

    // ---------------------------------------------------------------- right-click menu
    /** The text offset under a point (clamped to the text: a click past a line's end is its end). */
    const offsetAtPoint = (clientX: number, clientY: number) => {
        const el = ta.current!, r = el.getBoundingClientRect();
        const y = clientY - r.top + el.scrollTop - PAD_T, x = clientX - r.left + el.scrollLeft - PAD_L;
        const l = Math.max(0, Math.min(lines.length - 1, Math.floor(y / LH)));
        return starts[l] + Math.min(lines[l].length, Math.max(0, chAtX(lines[l], Math.max(0, x))));
    };
    // The native menu event that follows a keyboard opening (some systems send one): ignored.
    const keyMenuAt = React.useRef(0);
    const showMenu = (x: number, y: number) => {
        const el = ta.current; if (!el) return;
        window.clearTimeout(hoverTimer.current);
        setComp(null); setTip(null);
        const offset = el.selectionStart;
        const line = posOf(starts, offset).line;
        const hasSel = el.selectionStart !== el.selectionEnd;
        const page = props.contextMenu?.({ line: line + 1, offset, text: el.value }) ?? {};
        const bp = props.onToggleBreakpoint ? { allowed: !blankOrComment(lines[line] ?? ''), has: (props.breakpoints ?? []).includes(line + 1) } : undefined;
        menu.show({
            x, y, label: 'Editor actions',
            entries: editorMenu({
                readOnly: !!readOnly, hasSelection: hasSel, canDefinition: !!props.definition, canUsages: !!props.usages,
                canRename: !!props.rename, canComment: !!commentPrefix(lang), canFormat: !!props.format, breakpoint: bp,
            }, page),
            onDismiss: () => el.focus(),
            onPick: (key) => menuCommand(key, line),
        });
    };
    const openMenuAtCaret = () => {
        const el = ta.current; if (!el) return;
        keyMenuAt.current = Date.now();
        const r = el.getBoundingClientRect();
        const p = posOf(starts, el.selectionStart);
        const x = r.left + PAD_L + xAt(lines[p.line] ?? '', p.col) - el.scrollLeft;
        const y = r.top + PAD_T + (p.line + 1) * LH - el.scrollTop;
        showMenu(Math.max(r.left, Math.min(x, r.right - 8)), Math.max(r.top, Math.min(y, r.bottom - 8)));
    };
    const onContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>) => {
        e.preventDefault();
        const el = e.currentTarget;
        if (e.button !== 2 && Date.now() - keyMenuAt.current < 600) return; // a mouse right-click is button 2
        // As in other editors: a right-click inside the selection keeps it; elsewhere the caret moves there.
        const off = offsetAtPoint(e.clientX, e.clientY);
        const inSel = el.selectionStart !== el.selectionEnd && off >= el.selectionStart && off <= el.selectionEnd;
        if (!inSel) { el.focus(); el.setSelectionRange(off, off); setCaret(off); }
        showMenu(e.clientX, e.clientY);
    };
    const menuCommand = (key: string, line: number) => {
        const el = ta.current; if (!el) return;
        const s0 = el.selectionStart, e0 = el.selectionEnd, sel = el.value.slice(s0, e0);
        const clip = navigator.clipboard;
        switch (key) {
            case 'definition': props.definition?.(el.value, s0); break;
            case 'usages': props.usages?.(el.value, s0); break;
            case 'rename': if (!readOnly) props.rename?.(el.value, s0); break;
            case 'breakpoint': props.onToggleBreakpoint?.(line + 1); el.focus(); break;
            case 'copy':
            case 'cut': {
                const done = () => { if (key === 'cut') insert('', s0, e0); else el.focus(); };
                const viaBrowser = () => { el.focus(); el.setSelectionRange(s0, e0); if (!document.execCommand(key)) say(`Use Ctrl+${key === 'cut' ? 'X' : 'C'} to ${key}`); };
                if (!clip?.writeText) { viaBrowser(); break; }
                clip.writeText(sel).then(done, viaBrowser);
                break;
            }
            case 'paste':
                if (readOnly) break;
                if (!clip?.readText) { el.focus(); say('Use Ctrl+V to paste'); break; }
                clip.readText().then((t) => insert(t.replace(/\r\n?/g, '\n'), s0, e0), () => { el.focus(); say('Use Ctrl+V to paste'); });
                break;
            case 'selectAll': el.focus(); el.select(); setCaret(el.selectionStart); break;
            case 'comment': if (!readOnly) { el.focus(); toggleComment(); } break;
            case 'format': if (!readOnly) props.format?.(el.value); break;
            case 'find': openFind(false); break;
            case 'replace': if (!readOnly) openFind(true); break;
            case 'gotoLine': setGotoOpen(true); break;
        }
    };

    // ---------------------------------------------------------------- keyboard
    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Never act while an input method (Chinese, Japanese, …) is composing text.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        const el = e.currentTarget;
        const mod = e.ctrlKey || e.metaKey;
        // The letter of the key: e.key on Latin layouts; the physical key when e.key is something
        // else (Option+F on macOS gives "ƒ"/"Ï", a Cyrillic layout gives "а", …).
        const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : (/^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase() ?? '');
        setTip(null);
        // Ghost text: Tab takes it, Ctrl+→ its next word (the completion list, when open, wins Tab).
        if (ghostView && !readOnly) {
            if (e.key === 'Tab' && !e.shiftKey && !mod && !e.altKey) { e.preventDefault(); acceptGhost(false); return; }
            if (e.key === 'ArrowRight' && mod && !e.shiftKey && !e.altKey) { e.preventDefault(); acceptGhost(true); return; }
        }
        // Alt+] / Alt+[: the next / previous suggestion (asks Copilot when none is shown).
        if (props.inline && e.altKey && !mod && !e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft' || e.key === ']' || e.key === '[') && !readOnly) {
            e.preventDefault(); cycleGhost(e.code === 'BracketLeft' || e.key === '[' ? -1 : 1); return;
        }
        if (comp && filtered.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setComp({ ...comp, index: (comp.index + 1) % filtered.length }); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setComp({ ...comp, index: (comp.index - 1 + filtered.length) % filtered.length }); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); void accept(filtered[Math.min(comp.index, filtered.length - 1)]); return; }
        }
        // A snippet's placeholders: Tab / Shift+Tab move between them.
        if (snipRef.current && !(comp && filtered.length) && e.key === 'Tab' && !mod && !e.altKey) {
            e.preventDefault();
            const m = snipRef.current;
            gotoStop(m, e.shiftKey ? Math.max(0, m.cur - 1) : m.cur + 1);
            return;
        }
        // Esc closes one thing at a time: the list, the ghost text, the parameter hint, snippet mode, then the rest.
        if (e.key === 'Escape') {
            if (comp) { setComp(null); compAbort.current?.abort(); if (filtered.length) return; }
            if (ghostView) { dismissGhost(); return; }
            if (sig) { setSig(null); sigAbort.current?.abort(); return; }
            if (snipRef.current) { setSnip(null); return; }
            setTip(null); if (find.open) setFind({ ...find, open: false }); setGotoOpen(false); return;
        }
        if (mod && e.shiftKey && (e.key === ' ' || e.code === 'Space')) { e.preventDefault(); requestSig(); return; }
        if (mod && !e.altKey && letter === 's') { e.preventDefault(); props.onSave?.(); return; }
        if (mod && (e.key === ' ' || e.code === 'Space')) { e.preventDefault(); void openCompletion(); return; }
        if (mod && !e.altKey && !e.shiftKey && (letter === 'f' || letter === 'h')) {
            e.preventDefault();
            openFind(letter === 'h');
            return; // focus moves to the find box when it renders (below), before the next key arrives
        }
        if (mod && !e.altKey && letter === 'g') { e.preventDefault(); setGotoOpen(true); return; }
        // The menu key and Shift+F10: the right-click menu at the caret.
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !mod && !e.altKey)) { e.preventDefault(); openMenuAtCaret(); return; }
        if (e.key === 'F3') { e.preventDefault(); goMatch(e.shiftKey ? -1 : 1); return; }
        if (e.key === 'F12' && e.shiftKey) { e.preventDefault(); props.usages?.(el.value, el.selectionStart); return; }
        if (e.key === 'F12') { e.preventDefault(); props.definition?.(el.value, el.selectionStart); return; }
        if (e.key === 'F2' && !readOnly) { e.preventDefault(); props.rename?.(el.value, el.selectionStart); return; }
        if (e.shiftKey && e.altKey && !mod && (e.code === 'KeyF' || letter === 'f')) { e.preventDefault(); if (!readOnly) props.format?.(el.value); return; }
        if (readOnly) return;
        if (mod && (e.key === '/' || e.code === 'Slash')) { e.preventDefault(); toggleComment(); return; }
        if (e.key === 'Tab') { e.preventDefault(); indent(e.shiftKey); return; }
        if (e.key === 'Enter' && !mod) { e.preventDefault(); newline(); return; }
        if (e.key === 'Backspace' && el.selectionStart === el.selectionEnd) {
            const p = el.selectionStart, prev = el.value[p - 1], next = el.value[p];
            if (prev && PAIRS[prev] === next) { e.preventDefault(); insert('', p - 1, p + 1); return; }
        }
        if (!mod && !e.altKey && e.key.length === 1) {
            const p = el.selectionStart, next = el.value[p];
            // Type over an auto-inserted closer.
            if ((e.key === ')' || e.key === ']' || e.key === '}' || e.key === '"' || e.key === "'" || e.key === '`') && next === e.key && el.selectionStart === el.selectionEnd) {
                e.preventDefault(); el.setSelectionRange(p + 1, p + 1); setCaret(p + 1);
                // Typing past the call's ")" ends snippet mode.
                if (snipRef.current && p + 1 >= snipRef.current.end) setSnip(null);
                return;
            }
            const close = PAIRS[e.key];
            if (close && el.selectionStart === el.selectionEnd) {
                const quote = e.key === close;
                const prev = el.value[p - 1] ?? '';
                if (!quote || ((!next || /[\s)\]},;:]/.test(next)) && !/[\w\\]/.test(prev))) {
                    e.preventDefault(); insert(e.key + close, p, p, p + 1); return;
                }
            }
            // A snippet's placeholder is a hint: a bracket or quote typed over it replaces it (a pair, caret inside).
            const stop = snipRef.current?.stops[snipRef.current.cur];
            if (close && stop && el.selectionStart === stop.start && el.selectionEnd === stop.end && stop.end > stop.start) {
                e.preventDefault(); insert(e.key + close, stop.start, stop.end, stop.start + 1); return;
            }
            if (close && el.selectionStart !== el.selectionEnd) {
                e.preventDefault();
                const sel = el.value.slice(el.selectionStart, el.selectionEnd);
                insert(e.key + sel + close, el.selectionStart, el.selectionEnd);
                return;
            }
        }
    };

    const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        setCaret(e.currentTarget.selectionStart);
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (lang === 'feature' && e.key === ' ' && /^\s*(Given|When|Then|And|But|\*) $/.test((lines[posOf(starts, e.currentTarget.selectionStart).line] ?? '').slice(0, posOf(starts, e.currentTarget.selectionStart).col))) void openCompletion();
        else if (comp && (e.key === 'Backspace' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.currentTarget.selectionStart < comp.from) setComp(null);
    };

    // ---------------------------------------------------------------- mouse: hover and Ctrl+click
    const offsetAtMouse = (e: React.MouseEvent<HTMLTextAreaElement>) => {
        const el = e.currentTarget, r = el.getBoundingClientRect();
        const y = e.clientY - r.top + el.scrollTop - PAD_T, x = e.clientX - r.left + el.scrollLeft - PAD_L;
        const l = Math.floor(y / LH);
        if (l < 0 || l >= lines.length) return -1;
        const ch = chAtX(lines[l], x);
        if (ch >= lines[l].length && x > xAt(lines[l], lines[l].length) + cw) return -1;
        return starts[l] + ch;
    };
    const onMouseMove = (e: React.MouseEvent<HTMLTextAreaElement>) => {
        window.clearTimeout(hoverTimer.current);
        if (menu.open || (!props.hover && !diagnostics.length)) return;
        const off = offsetAtMouse(e);
        const x = e.clientX, y = e.clientY;
        if (off < 0) { setTip(null); return; }
        hoverTimer.current = window.setTimeout(async () => {
            const p = posOf(starts, off);
            const diag = diagnostics.find((d) => d.line - 1 <= p.line && p.line <= d.endLine - 1 && (d.line - 1 < p.line || p.col >= d.column - 1) && (d.endLine - 1 > p.line || p.col <= d.endColumn - 1));
            const info = props.hover ? await props.hover(value, off).catch(() => null) : null;
            const text = [diag ? `${diag.source ? diag.source + ': ' : ''}${diag.message}` : '', info?.text ?? ''].filter(Boolean).join('\n\n');
            if (text) setTip({ x, y, text, doc: info?.doc });
        }, 450);
    };
    const onMouseDown = (e: React.MouseEvent<HTMLTextAreaElement>) => {
        if ((e.ctrlKey || e.metaKey) && props.definition) {
            const off = offsetAtMouse(e);
            if (off >= 0) { e.preventDefault(); props.definition(value, off); }
        }
    };

    // ---------------------------------------------------------------- render
    const first = Math.max(0, Math.floor(scroll.top / LH) - 5);
    const last = Math.min(lines.length, Math.ceil((scroll.top + scroll.height) / LH) + 5);
    const gutterW = Math.max(3, String(lines.length).length) * cw + 28 + (props.gutterActions?.length ? 16 : 0);
    const bpSet = new Set(props.breakpoints ?? []);
    const diagByLine = new Map<number, string>();
    for (const d of diagnostics) {
        const cur = diagByLine.get(d.line);
        const rank = (s: string) => (s === 'error' ? 3 : s === 'warning' ? 2 : 1);
        if (!cur || rank(d.severity) > rank(cur)) diagByLine.set(d.line, d.severity);
    }
    const visibleMatches = matches.filter(([s]) => s >= starts[first] && (last >= starts.length || s < starts[last]));

    // Completion list: below the line, or above it when there is no room below; kept inside the editor.
    React.useLayoutEffect(() => {
        const box = compRef.current, main = mainRef.current;
        if (!box || !main || !comp) return;
        box.style.maxHeight = '';
        const lineTop = PAD_T + comp.line * LH - scroll.top;
        const H = main.clientHeight, W = main.clientWidth, h = box.offsetHeight, w = box.offsetWidth;
        const below = lineTop + LH + 2, roomBelow = H - below, roomAbove = lineTop - 2;
        let top: number;
        if (h <= roomBelow) top = below;
        else if (h <= roomAbove) top = roomAbove - h;
        else if (roomAbove > roomBelow) { box.style.maxHeight = `${Math.max(LH * 3, roomAbove)}px`; top = Math.max(0, roomAbove - box.offsetHeight); }
        else { box.style.maxHeight = `${Math.max(LH * 3, roomBelow)}px`; top = below; }
        const x = PAD_L + xAt(lines[comp.line] ?? '', posOf(starts, comp.from).col) - scroll.left;
        box.style.top = `${top}px`;
        box.style.left = `${Math.max(0, Math.min(x, W - w - 4))}px`;
    });
    // Parameter hint: above the caret's line (below it on the first lines), at its "(".
    React.useLayoutEffect(() => {
        const box = sigRef.current, main = mainRef.current;
        if (!box || !main || !sig) return;
        const lineTop = PAD_T + caretPos.line * LH - scroll.top;
        const h = box.offsetHeight, w = box.offsetWidth, W = main.clientWidth;
        const top = lineTop - h - 2 >= 0 ? lineTop - h - 2 : lineTop + LH + 2 + (comp ? 0 : 0);
        const p = posOf(starts, Math.min(sig.start, value.length));
        const x = PAD_L + xAt(lines[p.line] ?? '', p.col) - scroll.left - 8;
        box.style.top = `${top}px`;
        box.style.left = `${Math.max(0, Math.min(x, W - w - 4))}px`;
    });
    // Hover tooltip: next to the mouse, flipped and clamped so it stays on screen.
    React.useLayoutEffect(() => {
        const box = tipRef.current; if (!box || !tip) return;
        const w = box.offsetWidth, h = box.offsetHeight, VW = window.innerWidth, VH = window.innerHeight;
        let y = tip.y + 16;
        if (y + h > VH - 4) y = tip.y - 8 - h;
        box.style.top = `${Math.max(4, Math.min(y, VH - h - 4))}px`;
        box.style.left = `${Math.max(4, Math.min(tip.x + 8, VW - w - 4))}px`;
    });

    return (
        <div className="ed" style={active ? undefined : { display: 'none' }} onMouseLeave={() => { window.clearTimeout(hoverTimer.current); setTip(null); }}>
            <div className="ed-gutter" style={{ width: gutterW }}>
                <div style={{ transform: `translateY(${-scroll.top}px)`, position: 'relative', height: lines.length * LH + 2 * PAD_T }}>
                    {(props.gutterActions ?? []).filter((a) => a.line - 1 >= first && a.line - 1 < last).map((a) => (
                        <Tooltip key={'g' + a.line} title={a.title} placement="right">
                            <button type="button" className="ed-gutter-act" aria-label={a.title} style={{ top: PAD_T + (a.line - 1) * LH }} onClick={a.onClick}>▶</button>
                        </Tooltip>
                    ))}
                    {Array.from({ length: last - first }, (_, k) => first + k).map((l) => (
                        <div key={l} className={`ed-ln${l === caretPos.line ? ' cur' : ''}${props.onToggleBreakpoint ? ' bp-able' : ''}${l + 1 === props.execLine ? ' exec' : ''}`} style={{ top: PAD_T + l * LH, height: LH, lineHeight: `${LH}px` }}
                            onClick={props.onToggleBreakpoint && (bpSet.has(l + 1) || !blankOrComment(lines[l] ?? '')) ? () => props.onToggleBreakpoint!(l + 1) : undefined}
                            title={props.onToggleBreakpoint ? (bpSet.has(l + 1) ? 'Remove the breakpoint' : blankOrComment(lines[l] ?? '') ? 'No breakpoint on an empty line or a comment' : 'Add a breakpoint') : undefined}>
                            {bpSet.has(l + 1) && <span className="ed-bp" aria-label="Breakpoint" />}
                            {diagByLine.has(l + 1) && <span className={`ed-dot ${diagByLine.get(l + 1)}`} />}
                            {l + 1}
                        </div>
                    ))}
                </div>
            </div>
            <div className="ed-main" ref={mainRef}>
                <div className="ed-overlay" aria-hidden style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}>
                    <div className="ed-curline" style={{ top: PAD_T + caretPos.line * LH, height: LH }} />
                    {props.execLine ? <div className="ed-execline" style={{ top: PAD_T + (props.execLine - 1) * LH, height: LH }} /> : null}
                    {visibleMatches.map(([s, e], i) => {
                        const p = posOf(starts, s);
                        const l = lines[p.line];
                        const ep = Math.min(l.length, e - starts[p.line]);
                        const x0 = xAt(l, p.col);
                        return <div key={'m' + i} className={`ed-match${ta.current && s === ta.current.selectionStart ? ' cur' : ''}`} style={{ top: PAD_T + p.line * LH, left: PAD_L + x0, width: Math.max(cw, xAt(l, ep) - x0), height: LH }} />;
                    })}
                    {snip && snip.stops.filter((x) => x.index !== 0).map((x, i) => {
                        const p = posOf(starts, x.start);
                        const l = lines[p.line] ?? '';
                        const x0 = xAt(l, p.col), x1 = xAt(l, Math.min(l.length, p.col + (x.end - x.start)));
                        return <div key={'sn' + i} className={`ed-snip${snip.stops[snip.cur] === x ? ' cur' : ''}`} style={{ top: PAD_T + p.line * LH, left: PAD_L + x0 - 1, width: Math.max(2, x1 - x0 + 2), height: LH }} />;
                    })}
                    {Array.from({ length: last - first }, (_, k) => first + k).map((l) => {
                        const toks = tokens[l] ?? [];
                        const style = { top: PAD_T + l * LH, left: PAD_L, height: LH, lineHeight: `${LH}px` };
                        if (!ghostView || l !== caretPos.line) return <div key={l} className="ed-line" style={style}>{toks.map((t, i) => <span key={i} className={`tk-${t.t}`}>{t.s}</span>)}</div>;
                        // The caret's line with Copilot's suggestion after the caret (the rest of the line after it).
                        const [before, after] = splitTokens(toks, caretPos.col);
                        const gl = ghostView.ghost.split('\n');
                        const rest = after.map((t, i) => <span key={'a' + i} className={`tk-${t.t}`}>{t.s}</span>);
                        return (
                            <React.Fragment key={l}>
                                <div className="ed-line" style={style}>
                                    {before.map((t, i) => <span key={i} className={`tk-${t.t}`}>{t.s}</span>)}
                                    <span className="ed-ghost" data-testid="ghost-text">{gl[0]}</span>
                                    {gl.length === 1 && rest}
                                </div>
                                {gl.length > 1 && (
                                    <div className="ed-ghost-block" style={{ top: PAD_T + (l + 1) * LH, height: (gl.length - 1) * LH }}>
                                        {gl.slice(1).map((g, i) => (
                                            <div key={i} className="ed-line" style={{ top: i * LH, left: PAD_L, height: LH, lineHeight: `${LH}px` }}>
                                                <span className="ed-ghost">{g}</span>{i === gl.length - 2 && rest}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </React.Fragment>
                        );
                    })}
                    {diagnostics.filter((d) => d.line - 1 < last && d.endLine - 1 >= first).flatMap((d, i) => {
                        const segs = [];
                        for (let l = Math.max(d.line - 1, first); l <= Math.min(d.endLine - 1, last - 1); l++) {
                            const text = lines[l] ?? '';
                            const s = l === d.line - 1 ? d.column - 1 : (text.length - text.trimStart().length);
                            const e = l === d.endLine - 1 ? Math.max(d.endColumn - 1, s + 1) : text.length;
                            const x0 = xAt(text, s);
                            segs.push(<div key={`${i}-${l}`} className={`ed-squiggle ${d.severity}`} style={{ top: PAD_T + l * LH + LH - 4, left: PAD_L + x0, width: Math.max(cw, xAt(text, e) - x0) }} />);
                        }
                        return segs;
                    })}
                </div>
                <textarea ref={ta} className="ed-ta" value={value} wrap="off" spellCheck={false} autoCapitalize="off" autoComplete="off" autoCorrect="off" readOnly={readOnly}
                    aria-label="Code editor" aria-multiline="true"
                    onChange={(e) => { onEdit(e.target, e.nativeEvent); onChange(e.target.value); setCaret(e.target.selectionStart); }}
                    onScroll={(e) => { const el = e.currentTarget; if (!el.clientHeight) return; savedScroll.current = { top: el.scrollTop, left: el.scrollLeft }; setScroll({ top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight }); setComp(null); setTip(null); }}
                    onKeyDown={onKeyDown} onKeyUp={onKeyUp} onClick={(e) => { setCaret(e.currentTarget.selectionStart); setComp(null); }}
                    onSelect={(e) => {
                        const el = e.currentTarget, m = snipRef.current;
                        setCaret(el.selectionStart);
                        // The caret left the inserted call: snippet mode ends.
                        if (m && (el.selectionStart < m.start || el.selectionEnd > m.end)) setSnip(null);
                    }}
                    onMouseMove={onMouseMove} onMouseDown={onMouseDown} onContextMenu={onContextMenu} />
                {menu.element}
                {comp && filtered.length > 0 && (
                    <div className="ed-complete" role="listbox" ref={compRef}>
                        {filtered.map((it, i) => (
                            <div key={it.name + i} role="option" aria-selected={i === comp.index} className={`ed-ci${i === comp.index ? ' sel' : ''}`}
                                onMouseDown={(e) => { e.preventDefault(); accept(it); }} ref={i === comp.index ? (n) => n?.scrollIntoView({ block: 'nearest' }) : undefined}>
                                <span className="ed-ck">{it.kind.split(' ')[0].slice(0, 4)}</span>
                                <span className="ed-cn">{it.name}</span>
                                {it.detail && <span className="ed-cd">{it.detail}</span>}
                            </div>
                        ))}
                        {(() => {
                            const d = selItem ? comp.details.get(detailKey(selItem)) : null;
                            return d && (d.detail || d.doc) ? (
                                <div className="ed-cdetail" aria-live="polite">
                                    {d.detail && <div className="ed-cdetail-sig">{d.detail}</div>}
                                    {d.doc && <div className="ed-cdetail-doc">{d.doc}</div>}
                                </div>
                            ) : null;
                        })()}
                    </div>
                )}
                {sig && (() => {
                    const sg = sig.signatures[Math.min(sig.active, sig.signatures.length - 1)];
                    const pi = sg.params.length ? Math.min(sig.param, sg.params.length - 1) : -1;
                    const [ps, pe] = pi >= 0 ? sg.params[pi] : [0, 0];
                    return (
                        <div className="ed-sig" role="tooltip" ref={sigRef} data-testid="signature-help">
                            {sig.signatures.length > 1 && <span className="ed-sig-n">{Math.min(sig.active, sig.signatures.length - 1) + 1}/{sig.signatures.length}</span>}
                            <span className="ed-sig-label">{sg.label.slice(0, ps)}<b>{sg.label.slice(ps, pe)}</b>{sg.label.slice(pe)}</span>
                            {pi >= 0 && sg.paramDocs[pi] && <div className="ed-sig-doc">{sg.paramDocs[pi]}</div>}
                        </div>
                    );
                })()}
                {find.open && (
                    <div className="ed-find">
                        <Space direction="vertical" size={4}>
                            <Space size={4}>
                                <Input ref={(r) => { findInput.current = r?.input ?? null; }} size="small" placeholder="Find" value={find.q} style={{ width: 220 }}
                                    onChange={(e) => setFind({ ...find, q: e.target.value })}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goMatch(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { e.preventDefault(); setFind({ ...find, open: false }); ta.current?.focus(); } }} />
                                <span className="ed-count">{matches.length ? `${Math.min(find.idx + 1, matches.length)} of ${matches.length}` : 'No results'}</span>
                                <Tooltip title="Previous (Shift+Enter)"><Button aria-label="Previous (Shift+Enter)" size="small" type="text" icon={<ArrowUpOutlined />} onClick={() => goMatch(-1)} /></Tooltip>
                                <Tooltip title="Next (Enter)"><Button aria-label="Next (Enter)" size="small" type="text" icon={<ArrowDownOutlined />} onClick={() => goMatch(1)} /></Tooltip>
                                <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => { setFind({ ...find, open: false }); ta.current?.focus(); }} />
                            </Space>
                            {find.replace && (
                                <Space size={4}>
                                    <Input size="small" placeholder="Replace" value={find.r} style={{ width: 220 }} onChange={(e) => setFind({ ...find, r: e.target.value })} />
                                    <Button size="small" onClick={replaceOne} disabled={readOnly}>Replace</Button>
                                    <Button size="small" onClick={replaceAll} disabled={readOnly || !matches.length}>All</Button>
                                </Space>
                            )}
                            <Space size={8}>
                                <Checkbox checked={find.cs} onChange={(e) => setFind({ ...find, cs: e.target.checked })}>Match case</Checkbox>
                                <Checkbox checked={find.word} onChange={(e) => setFind({ ...find, word: e.target.checked })}>Whole word</Checkbox>
                                <Checkbox checked={find.re} onChange={(e) => setFind({ ...find, re: e.target.checked })}>Regex</Checkbox>
                                {!find.replace && <Button size="small" type="link" onClick={() => setFind({ ...find, replace: true })}>Replace…</Button>}
                            </Space>
                        </Space>
                    </div>
                )}
                {gotoOpen && (
                    <div className="ed-find">
                        <Input autoFocus size="small" placeholder={`Go to line (1–${lines.length})`} style={{ width: 220 }}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') { e.preventDefault(); setGotoOpen(false); ta.current?.focus(); }
                                if (e.key === 'Enter') {
                                    // Consume the key: focus moves to the editor now, and the browser would
                                    // otherwise deliver this Enter there as a newline.
                                    e.preventDefault();
                                    const [l, c] = (e.currentTarget.value).split(':').map((x) => parseInt(x, 10));
                                    if (l > 0) {
                                        const li = Math.min(lines.length, l) - 1;
                                        const off = starts[li] + Math.max(0, Math.min((c || 1) - 1, lines[li].length));
                                        const el = ta.current!; el.focus(); el.setSelectionRange(off, off); el.scrollTop = Math.max(0, li * LH - el.clientHeight / 2); setCaret(off);
                                    }
                                    setGotoOpen(false);
                                }
                            }} />
                    </div>
                )}
                {tip && (
                    <div className="ed-tip" ref={tipRef}>
                        <pre>{tip.text}</pre>
                        {tip.doc && <div className="ed-tip-doc">{tip.doc}</div>}
                    </div>
                )}
            </div>
            <div className="ed-status">
                Ln {caretPos.line + 1}, Col {caretPos.col + 1} · {lang === 'ts' ? 'TypeScript/JavaScript' : lang === 'feature' ? 'Gherkin' : lang.toUpperCase()} · {props.eol === '\r\n' ? 'CRLF' : 'LF'} · {useTabs ? 'Tabs' : `Spaces: ${step}`}
                {note && <span className="ed-note" role="status">{note}</span>}
                {props.statusItems && <span className="ed-status-right">{props.statusItems}</span>}
            </div>
        </div>
    );
});
