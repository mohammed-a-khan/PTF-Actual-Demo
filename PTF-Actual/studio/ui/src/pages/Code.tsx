/**
 * Code: the in-house editor with file tree, tabs, quick open, search, problems and language
 * features (TypeScript language service; Gherkin step matching using the framework's own rules).
 */
import React from 'react';
import { Split } from '../components/Split';
import { currentRoute, navigate, useRoute } from '../route';
import { Alert, App, Badge, Button, Dropdown, Empty, Input, List, Modal, Radio, Space, Tabs, Tag, Tooltip, Tree, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { BlameView } from '../components/BlameView';
import type { DataNode } from 'antd/es/tree';
import { BugOutlined, FileAddOutlined, UserOutlined, FileOutlined, FolderAddOutlined, FolderOutlined, LoadingOutlined, ReloadOutlined, SaveOutlined, SearchOutlined } from '@ant-design/icons';
import { api, Breakpoint, Diag, SearchHit, StepPlan, StepRename } from '../api';
import { useUnsaved } from '../unsaved';
import { errText, loadRunTarget, saveRunTarget, showRun, unsavedFiles, useStudio } from '../state';
import { CodeEditor, CodeEditorHandle } from '../editor/CodeEditor';
import { DebugPanel, ExecLocation } from '../components/DebugPanel';
import { langOf } from '../editor/highlight';

/** `content` / `savedContent` always use "\n"; `eol` is the file's own line ending, restored on save. */
interface OpenFile { path: string; content: string; savedContent: string; hash: string | null; binary: boolean; eol: '\n' | '\r\n' }

/** A file as read from disk, ready for the editor (which works with "\n" only). */
function fromDisk(content: string | undefined): { content: string; eol: '\n' | '\r\n' } {
    const raw = content ?? '';
    const crlf = (raw.match(/\r\n/g) ?? []).length;
    const lf = (raw.match(/\n/g) ?? []).length - crlf;
    // The browser's textarea turns every \r\n and lone \r into \n, so the editor text must too.
    return { content: raw.replace(/\r\n?/g, '\n'), eol: crlf > 0 && crlf >= lf ? '\r\n' : '\n' };
}
const toDisk = (t: Pick<OpenFile, 'content' | 'eol'>) => (t.eol === '\r\n' ? t.content.replace(/\n/g, '\r\n') : t.content);

interface TabHandlers {
    setContent: (path: string, text: string) => void;
    save: (path: string) => void;
    goTo: (path: string, text: string, offset: number) => void;
    format: (path: string, text: string) => void;
    usages: (path: string, text: string, offset: number) => void;
    rename: (path: string, text: string, offset: number) => void;
    editors: Map<string, CodeEditorHandle>;
    toggleBreakpoint: (path: string, line: number) => void;
}
const NO_DIAGS: Diag[] = [];

/** Files breakpoints can be set in: feature files (before a step) and the project's TypeScript / JavaScript. */
const canBreak = (path: string) => /\.(feature|ts|js|mjs|cjs)$/.test(path) && !path.endsWith('.d.ts') && !path.split('/').includes('node_modules');

/**
 * The editor of one open tab. Memoized with stable handlers, so typing in one tab re-renders only
 * that tab's editor (all tabs stay mounted to keep their undo history, scroll and caret).
 */
const TabEditor = React.memo(function TabEditor({ tab, active, diagnostics, reveal, gutterActions, h, breakpoints, execLine }: {
    tab: OpenFile; active: boolean; diagnostics: Diag[]; reveal: { line: number; column?: number; nonce: number; soft?: boolean } | null;
    gutterActions?: Array<{ line: number; title: string; onClick: () => void }>; h: React.MutableRefObject<TabHandlers>;
    breakpoints?: number[]; execLine?: number | null;
}) {
    const path = tab.path;
    const register = React.useCallback((e: CodeEditorHandle | null) => { if (e) h.current.editors.set(path, e); else h.current.editors.delete(path); }, [path, h]);
    return (
        <CodeEditor ref={register} active={active} value={tab.content} lang={langOf(path)} eol={tab.eol}
            onChange={(text) => h.current.setContent(path, text)} onSave={() => h.current.save(path)}
            diagnostics={diagnostics} reveal={reveal} gutterActions={gutterActions}
            breakpoints={breakpoints} execLine={execLine} onToggleBreakpoint={canBreak(path) ? (line) => h.current.toggleBreakpoint(path, line) : undefined}
            completions={async (text, off) => (await api.completions(path, text, off)).items}
            hover={async (text, off) => { const r = await api.hover(path, text, off); return r.text ? r : null; }}
            definition={(text, off) => h.current.goTo(path, text, off)}
            format={(text) => h.current.format(path, text)}
            usages={(text, off) => h.current.usages(path, text, off)}
            rename={(text, off) => h.current.rename(path, text, off)} />
    );
});

function buildTree(files: string[], filter: string, marks: Map<string, string>): DataNode[] {
    const root: Record<string, unknown> = {};
    const f = filter.toLowerCase();
    for (const p of files) {
        if (f && !p.toLowerCase().includes(f)) continue;
        let node = root;
        const parts = p.split('/');
        parts.forEach((part, i) => {
            const key = parts.slice(0, i + 1).join('/');
            if (i === parts.length - 1) node[part] = key;
            else { node[part] = (node[part] as Record<string, unknown>) ?? {}; node = node[part] as Record<string, unknown>; }
        });
    }
    const toNodes = (obj: Record<string, unknown>, prefix: string): DataNode[] => Object.keys(obj)
        .sort((a, b) => { const da = typeof obj[a] !== 'string', db = typeof obj[b] !== 'string'; return da === db ? a.localeCompare(b) : da ? -1 : 1; })
        .map((name) => {
            const v = obj[name];
            const key = prefix ? `${prefix}/${name}` : name;
            if (typeof v === 'string') {
                const m = marks.get(v);
                return { key: v, isLeaf: true, title: <span className={m ? `tree-${m}` : ''}>{name}{m && <span className="tree-mark">{m}</span>}</span> };
            }
            return { key: `dir:${key}`, title: name, children: toNodes(v as Record<string, unknown>, key) };
        });
    return toNodes(root, '');
}

export function Code() {
    const { message, modal } = App.useApp();
    const { status, refresh } = useStudio();
    const [files, setFiles] = React.useState<string[]>([]);
    // What is typed, and the filter applied a moment later (large repositories: not on every key).
    const [filterText, setFilterText] = React.useState('');
    const [filter, setFilter] = React.useState('');
    React.useEffect(() => { const t = setTimeout(() => setFilter(filterText.trim()), filterText ? 180 : 0); return () => clearTimeout(t); }, [filterText]);
    // The tree is virtual (only the rows on screen exist), so it needs the height it can use.
    const treeBox = React.useRef<HTMLDivElement>(null);
    const [treeHeight, setTreeHeight] = React.useState(400);
    React.useEffect(() => {
        const el = treeBox.current; if (!el) return;
        const ro = new ResizeObserver(() => setTreeHeight(Math.max(100, el.clientHeight - 8)));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const [expanded, setExpanded] = React.useState<React.Key[]>(() => { try { return JSON.parse(localStorage.getItem('cs-studio-tree') ?? '[]'); } catch { return []; } });
    const [tabs, setTabs] = React.useState<OpenFile[]>([]);
    // The open tabs as they are now (menus built earlier read this, not the tabs of their render).
    const tabsNow = React.useRef<OpenFile[]>([]);
    tabsNow.current = tabs;
    useUnsaved('code', tabs.some((t) => t.content !== t.savedContent), 'files in the editor');
    const [active, setActive] = React.useState<string | null>(null);
    const [diags, setDiags] = React.useState<Record<string, Diag[]>>({});
    const [reveal, setReveal] = React.useState<{ path: string; line: number; column?: number; nonce: number; soft?: boolean } | null>(null);
    const [bottom, setBottom] = React.useState<'problems' | 'search' | 'usages' | 'debug'>('problems');
    // Breakpoints (saved per repository; a debug run going on gets changes at once) and where a debug run is paused.
    const [breakpoints, setBreakpoints] = React.useState<Breakpoint[]>([]);
    const [exec, setExec] = React.useState<ExecLocation | null>(null);
    React.useEffect(() => { api.breakpoints().then((r) => setBreakpoints(r.breakpoints)).catch(() => undefined); }, []);
    const saveBreakpoints = React.useCallback((next: Breakpoint[]) => {
        setBreakpoints(next);
        api.setBreakpoints(next).catch((e) => message.error(errText(e)));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const toggleBreakpoint = React.useCallback((file: string, line: number) => {
        setBreakpoints((cur) => {
            const has = cur.some((b) => b.file === file && b.line === line);
            const next = has ? cur.filter((b) => !(b.file === file && b.line === line)) : [...cur, { file, line }].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
            api.setBreakpoints(next).catch((e) => message.error(errText(e)));
            return next;
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const [search, setSearch] = React.useState({ q: '', regex: false, case: false, word: false, glob: '' });
    const [hits, setHits] = React.useState<SearchHit[] | null>(null);
    const [quick, setQuick] = React.useState<{ open: boolean; q: string; index: number }>({ open: false, q: '', index: 0 });
    const [dialog, setDialog] = React.useState<{ kind: 'file' | 'folder' | 'rename'; path: string; base?: string } | null>(null);
    const diagTimer = React.useRef<number>();
    const tabsRef = React.useRef(tabs);
    // Other screens (Run tests) warn about unsaved edits: the framework runs the files on disk.
    React.useEffect(() => { unsavedFiles.clear(); for (const t of tabs) if (t.content !== t.savedContent) unsavedFiles.add(t.path); }, [tabs]);
    const activeRef = React.useRef(active);
    activeRef.current = active;
    tabsRef.current = tabs;
    const editors = React.useRef(new Map<string, CodeEditorHandle>());
    const handlers = React.useRef<TabHandlers>(null!);
    const openRef = React.useRef<(path: string, line?: number, column?: number, soft?: boolean) => Promise<void>>(null!);
    const treeMenuRef = React.useRef<(key: string) => MenuProps>(null!);
    const [closing, setClosing] = React.useState<{ path: string; saving: boolean } | null>(null);
    /** TypeScript language features warm up on the first request (can take seconds on big projects). */
    const [tsState, setTsState] = React.useState<'idle' | 'starting' | 'ready'>('idle');
    const quickInput = React.useRef<import('antd').InputRef>(null);

    const loadFiles = React.useCallback(() => { api.files().then(setFiles).catch((e) => message.error(errText(e))); }, [message]);
    React.useEffect(loadFiles, [loadFiles, status?.head]);
    // Let TypeScript load the project in the background (it runs in its own thread on the server),
    // so the first completion or hover is quick.
    React.useEffect(() => { void api.warmUpLanguage().catch(() => undefined); }, []);
    React.useEffect(() => { try { localStorage.setItem('cs-studio-tree', JSON.stringify(expanded.slice(-200))); } catch { /* ignore */ } }, [expanded]);

    const marks = React.useMemo(() => {
        const m = new Map<string, string>();
        for (const f of status?.files ?? []) m.set(f.path, f.conflicted ? '!' : f.untracked ? 'U' : (f.staged !== '.' ? f.staged : f.unstaged));
        return m;
    }, [status]);
    const tree = React.useMemo(() => buildTree(files, filter, marks), [files, filter, marks]);
    // While filtering, every folder holding a match is open (otherwise the matches stay hidden).
    // (With very many matches only the first levels open; type more to narrow it down.)
    const filterOpen = React.useMemo(() => {
        if (!filter) return null;
        const keys: React.Key[] = [];
        let leaves = 0;
        const count = (ns: DataNode[]) => { for (const n of ns) { if (n.children) count(n.children); else leaves++; } };
        count(tree);
        const maxDepth = leaves > 2000 ? 1 : leaves > 500 ? 2 : Infinity;
        const walk = (ns: DataNode[], depth: number) => { for (const n of ns) if (n.children && depth < maxDepth) { keys.push(n.key); walk(n.children, depth + 1); } };
        walk(tree, 0);
        return keys;
    }, [tree, filter]);
    const cur = tabs.find((t) => t.path === active) ?? null;

    /** soft: show the line without moving the caret, scrolling only when it is out of view (the debugger's line). */
    const open = React.useCallback(async (path: string, line?: number, column?: number, soft?: boolean) => {
        const existing = tabs.find((t) => t.path === path);
        if (!existing) {
            try {
                const f = await api.readFile(path);
                const d = fromDisk(f.content);
                setTabs((ts) => ts.some((t) => t.path === path) ? ts : [...ts, { path, content: d.content, savedContent: d.content, hash: f.hash, binary: f.binary, eol: d.eol }]);
            } catch (e) { message.error(errText(e)); return; }
        }
        setActive(path);
        // reveal the folder in the tree
        const dirs = path.split('/').slice(0, -1).map((_, i, a) => `dir:${a.slice(0, i + 1).join('/')}`);
        setExpanded((ex) => [...new Set([...ex, ...dirs])]);
        if (line) setReveal({ path, line, column, nonce: Date.now(), ...(soft ? { soft } : {}) });
    }, [tabs, message]);

    // The open file (and line) is part of the address (#/code/<file>/<line>), so the browser's Back
    // returns to where you were before a jump (Ctrl+click on a step, a search hit, a problem).
    const route = useRoute();
    const routeKey = route[0] === 'code' ? route.slice(1).join('\0') : null;
    const lastRoute = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (routeKey === null || routeKey === lastRoute.current) return;
        lastRoute.current = routeKey;
        const [p, l] = route.slice(1);
        if (p) void open(p, l && /^\d+$/.test(l) ? Number(l) : undefined);
    }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps
    /** Go to a file (and line), as a new step in the browser history. */
    const goFile = React.useCallback((path: string, line?: number, column?: number, fromLine?: number) => {
        // Remember the line we are leaving, so Back lands on it.
        const curPath = activeRef.current;
        if (curPath && currentRoute()[0] === 'code') {
            const l = fromLine ?? editors.current.get(curPath)?.caretLine();
            if (l) { const k = [curPath, String(l)].join('\0'); lastRoute.current = k; navigate(['code', curPath, l], true); }
        }
        const key = [path, line ? String(line) : ''].filter(Boolean).join('\0');
        lastRoute.current = key;
        navigate(['code', path, line]);
        void open(path, line, column);
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    // Open requests from other screens.
    React.useEffect(() => {
        const h = (e: Event) => { const d = (e as CustomEvent).detail as { path: string; line?: number; column?: number }; goFile(d.path, d.line, d.column); };
        window.addEventListener('cs-open-file', h);
        return () => window.removeEventListener('cs-open-file', h);
    }, [goFile]);
    const goFileRef = React.useRef(goFile);
    goFileRef.current = goFile;
    // Closing a tab shows another file: keep the address in step (without a new history entry).
    React.useEffect(() => {
        const r = currentRoute();
        if (r[0] !== 'code' || !active || r[1] === active) return;
        lastRoute.current = active;
        navigate(['code', active], true);
    }, [active]);

    // Diagnostics for the active file, shortly after the user stops typing.
    React.useEffect(() => {
        if (!cur || cur.binary) return;
        window.clearTimeout(diagTimer.current);
        const path = cur.path, content = cur.content, isTs = langOf(path) === 'ts';
        diagTimer.current = window.setTimeout(() => {
            if (isTs) setTsState((s) => (s === 'idle' ? 'starting' : s));
            api.diagnostics(path, content).then((r) => setDiags((d) => ({ ...d, [path]: r.diagnostics }))).catch(() => undefined)
                .finally(() => { if (isTs) setTsState('ready'); });
        }, 500);
    }, [cur?.path, cur?.content]); // eslint-disable-line react-hooks/exhaustive-deps

    // Files changed outside the Studio: reload open tabs that have no unsaved edits.
    React.useEffect(() => {
        const onFocus = async (tree: boolean | Event = true) => {
            if (tree !== false) loadFiles();
            for (const t of tabs) {
                if (t.binary || t.content !== t.savedContent) continue;
                try {
                    const f = await api.readFile(t.path);
                    if (f.hash !== t.hash) { const d = fromDisk(f.content); setTabs((ts) => ts.map((x) => x.path === t.path && x.content === x.savedContent ? { ...x, content: d.content, savedContent: d.content, hash: f.hash, eol: d.eol } : x)); }
                } catch { /* deleted: keep the tab, saving will recreate */ }
            }
        };
        window.addEventListener('focus', onFocus);
        // Also changes the Studio makes itself (quarantine, heal, agents) and edits made while this tab has focus:
        // checked every few seconds while the page is visible, and when the Code screen is shown again.
        const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void onFocus(false); }, 5000);
        const onShown = () => { if (document.visibilityState === 'visible') void onFocus(false); };
        document.addEventListener('visibilitychange', onShown);
        window.addEventListener('hashchange', onShown);
        return () => { window.removeEventListener('focus', onFocus); window.clearInterval(timer); document.removeEventListener('visibilitychange', onShown); window.removeEventListener('hashchange', onShown); };
    }, [tabs, loadFiles]);

    const setContent = (path: string, content: string) => setTabs((ts) => ts.map((t) => t.path === path ? { ...t, content } : t));

    /**
     * Save a tab. Resolves to true only once the file is really written; false when the save failed
     * or the user chose not to overwrite a newer version (callers must not close / run then).
     */
    const save = async (path: string, force = false): Promise<boolean> => {
        const t = tabsRef.current.find((x) => x.path === path); if (!t) return false;
        try {
            let expected = t.hash;
            if (force) expected = (await api.readFile(path).catch(() => null))?.hash ?? null;
            const r = await api.saveFile(path, toDisk(t), expected);
            setTabs((ts) => ts.map((x) => x.path === path ? { ...x, savedContent: t.content, hash: r.hash } : x));
            message.success(`Saved ${path.split('/').pop()}`, 1.2);
            loadFiles(); void refresh();
            return true;
        } catch (e) {
            if (!/(changed|deleted) outside the editor/.test(errText(e))) { message.error(errText(e)); return false; }
            const disk = await api.readFile(path).catch(() => null);
            return new Promise<boolean>((resolve) => {
                if (!disk) {
                    modal.confirm({
                        title: `${path} was deleted outside the Studio`, content: 'Another program (or a pull, or a branch switch) deleted this file after you opened it.',
                        okText: 'Save my version (recreate)', cancelText: 'Close the file',
                        onOk: async () => resolve(await save(path, true)),
                        onCancel: () => { forceClose(path); resolve(false); },
                    });
                    return;
                }
                modal.confirm({
                    title: `${path} was changed outside the Studio`, content: 'Another program (or a pull) changed this file after you opened it.',
                    okText: 'Keep my version', cancelText: 'Load the other version',
                    onOk: async () => resolve(await save(path, true)),
                    onCancel: () => {
                        const d = fromDisk(disk.content);
                        setTabs((ts) => ts.map((x) => x.path === path ? { ...x, content: d.content, savedContent: d.content, hash: disk.hash, eol: d.eol } : x));
                        resolve(false);
                    },
                });
            });
        }
    };

    /** Close a tab without asking. */
    const forceClose = (path: string) => {
        const rest = tabsRef.current.filter((x) => x.path !== path);
        setTabs((ts) => ts.filter((x) => x.path !== path));
        setActive((a) => (a === path ? rest[rest.length - 1]?.path ?? null : a));
        void api.closeFile(path).catch(() => undefined);
    };

    const close = (path: string) => {
        const t = tabsRef.current.find((x) => x.path === path);
        if (t && t.content !== t.savedContent) setClosing({ path, saving: false });
        else forceClose(path);
    };
    const closeWithSave = async () => {
        if (!closing) return;
        const path = closing.path;
        setClosing({ path, saving: true });
        const ok = await save(path);
        setClosing(null);
        if (ok) forceClose(path);
    };

    const goTo = async (path: string, text: string, offset: number) => {
        try {
            const r = await api.definition(path, text, offset);
            const loc = r.locations[0];
            if (!loc) { message.info('No definition found here.'); return; }
            if (loc.path.startsWith('..')) { message.info(`Defined outside this project: ${loc.path}`); return; }
            // Back returns to the line that was clicked (Ctrl+click does not move the caret).
            goFile(loc.path, loc.line, loc.column, text.slice(0, offset).split('\n').length);
        } catch (e) { message.error(errText(e)); }
    };

    // ---- "Create step definition" for an undefined step
    const [stepFix, setStepFix] = React.useState<{ feature: string; line: number; plan: StepPlan; target: string; busy?: boolean } | null>(null);
    const startCreateStep = async (feature: string, line: number) => {
        const t = tabsRef.current.find((x) => x.path === feature); if (!t) return;
        try {
            const plan = await api.planStep(feature, t.content, line);
            setStepFix({ feature, line, plan, target: (plan.targets.find((x) => x.recommended) ?? plan.targets[0]).file });
        } catch (e) { message.error(errText(e)); }
    };
    const confirmCreateStep = async () => {
        if (!stepFix) return;
        const feat = tabsRef.current.find((x) => x.path === stepFix.feature); if (!feat) return;
        setStepFix({ ...stepFix, busy: true });
        try {
            const openTab = tabsRef.current.find((x) => x.path === stepFix.target);
            const r = await api.createStep(stepFix.feature, feat.content, stepFix.line, stepFix.target, openTab ? openTab.content : undefined);
            if (openTab) {
                // Into the open editor (one undoable edit, unsaved edits kept); the user saves as usual.
                editors.current.get(stepFix.target)?.applyEdit(fromDisk(r.content).content);
                await open(stepFix.target, r.line);
                message.success(`Added "${r.pattern}" to ${stepFix.target}. Save the file to use it.`);
            } else {
                await api.saveFile(stepFix.target, r.content, r.baseHash);
                loadFiles(); void refresh();
                await open(stepFix.target, r.line);
                message.success(`${r.created ? 'Created' : 'Added to'} ${stepFix.target}: ${r.methodName}()`);
            }
            setStepFix(null);
            // Re-check the feature: the step is defined now.
            api.diagnostics(feat.path, feat.content).then((d) => setDiags((x) => ({ ...x, [feat.path]: d.diagnostics }))).catch(() => undefined);
        } catch (e) { message.error(errText(e)); setStepFix((s) => (s ? { ...s, busy: false } : s)); }
    };

    /** Format through the editor so the change is one undoable edit; skipped if the text changed meanwhile. */
    const formatTab = async (path: string, text: string) => {
        try {
            const r = await api.format(path, text);
            const next = fromDisk(r.content).content;
            const t = tabsRef.current.find((x) => x.path === path);
            if (!t || t.content !== text || next === text) return;
            editors.current.get(path)?.applyEdit(next);
        } catch (e) { message.error(errText(e)); }
    };

    // ---- Usages (Shift+F12) and step rename (F2)
    const [usages, setUsages] = React.useState<{ title: string; items: Array<{ path: string; line: number; column: number; text: string }> } | null>(null);
    const findUsages = async (path: string, text: string, offset: number) => {
        try {
            const r = await api.stepUsages(path, text, offset);
            setUsages({ title: `"${r.step.pattern}"`, items: r.usages.map((u) => ({ path: u.path, line: u.line, column: u.column, text: `${u.keyword} ${u.text}` })) });
        } catch (e) {
            // Not a step: the language service's references (TypeScript).
            if (path.endsWith('.feature')) { message.info(errText(e)); return; }
            try {
                const r = await api.references(path, text, offset);
                const word = /[\w$]+$/.exec(text.slice(0, offset))?.[0] ?? '';
                const rest = /^[\w$]*/.exec(text.slice(offset))?.[0] ?? '';
                setUsages({ title: word + rest || 'references', items: r.locations.filter((l) => !l.path.startsWith('..')).map((l) => ({ path: l.path, line: l.line, column: l.column, text: l.text ?? '' })) });
            } catch (e2) { message.info(errText(e2)); return; }
        }
        setBottom('usages');
    };
    const [blame, setBlame] = React.useState<string | null>(null);
    const [renaming, setRenaming] = React.useState<{ path: string; text: string; offset: number; from: string; to: string; preview?: StepRename; busy?: boolean; error?: string } | null>(null);
    const startRename = async (path: string, text: string, offset: number) => {
        const t = tabsRef.current.find((x) => x.path === path);
        if (t && t.content !== t.savedContent) { message.info('Save the file first: the rename works on saved files.'); return; }
        try {
            const r = await api.stepUsages(path, text, offset);
            if (r.step.builtIn) { message.info(`"${r.step.pattern}" is one of the framework's own steps: it cannot be renamed.`); return; }
            setRenaming({ path, text, offset, from: r.step.pattern, to: r.step.pattern });
        } catch (e) { message.info(errText(e)); }
    };
    const previewRename = async () => {
        if (!renaming) return;
        setRenaming({ ...renaming, busy: true, error: undefined });
        try { const p = await api.stepRename(renaming.path, renaming.text, renaming.offset, renaming.to, false); setRenaming((r) => (r ? { ...r, preview: p, busy: false } : r)); }
        catch (e) { setRenaming((r) => (r ? { ...r, preview: undefined, busy: false, error: errText(e) } : r)); }
    };
    const applyRename = async () => {
        if (!renaming?.preview) return;
        setRenaming({ ...renaming, busy: true });
        try {
            const r = await api.stepRename(renaming.path, renaming.text, renaming.offset, renaming.to, true);
            // The changed files that are open (and have no edits): read again.
            for (const f of r.files) {
                const t = tabsRef.current.find((x) => x.path === f);
                if (!t || t.content !== t.savedContent) continue;
                const disk = await api.readFile(f); const d = fromDisk(disk.content);
                setTabs((ts) => ts.map((x) => x.path === f ? { ...x, content: d.content, savedContent: d.content, hash: disk.hash, eol: d.eol } : x));
            }
            message.success(`Renamed in ${r.files.length} file${r.files.length === 1 ? '' : 's'} (${r.changes.length} line${r.changes.length === 1 ? '' : 's'})`);
            setRenaming(null);
            loadFiles(); void refresh();
        } catch (e) { setRenaming((x) => (x ? { ...x, busy: false, error: errText(e) } : x)); }
    };

    const runSearch = async () => {
        // An empty query or one that fails clears the results (old results under a new query mislead).
        if (!search.q.trim()) { setHits(null); return; }
        setBottom('search');
        try { setHits(await api.search(search.q, search)); } catch (e) { setHits(null); message.error(errText(e)); }
    };

    // Global shortcuts: Ctrl+P quick open, Ctrl+Shift+F search.
    React.useEffect(() => {
        const h = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : (/^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase() ?? '');
            if (mod && !e.shiftKey && letter === 'p') { e.preventDefault(); setQuick({ open: true, q: '', index: 0 }); }
            if (mod && e.shiftKey && letter === 'f') { e.preventDefault(); setBottom('search'); setTimeout(() => document.getElementById('cs-global-search')?.focus(), 0); }
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, []);

    const quickList = React.useMemo(() => {
        const q = quick.q.toLowerCase();
        const score = (p: string) => { const n = p.toLowerCase(), b = n.split('/').pop()!; if (!q) return 1; if (b.startsWith(q)) return 4; if (b.includes(q)) return 3; let i = 0; for (const c of n) if (c === q[i]) i++; return i === q.length ? 1 : 0; };
        return files.map((p) => [p, score(p)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 50).map(([p]) => p);
    }, [files, quick.q]);

    const treeMenu = (key: string): MenuProps => {
        const isDir = key.startsWith('dir:');
        const path = isDir ? key.slice(4) : key;
        const dir = isDir ? path : path.split('/').slice(0, -1).join('/');
        return {
            items: [
                { key: 'nf', label: 'New file…' }, { key: 'nd', label: 'New folder…' }, { type: 'divider' as const },
                { key: 'rn', label: 'Rename…' }, { key: 'cp', label: 'Copy path' }, { type: 'divider' as const },
                { key: 'rm', label: 'Delete…', danger: true },
            ],
            onClick: ({ key: k }: { key: string }) => {
                if (k === 'nf') setDialog({ kind: 'file', path: dir ? `${dir}/` : '' });
                if (k === 'nd') setDialog({ kind: 'folder', path: dir ? `${dir}/` : '' });
                if (k === 'rn') setDialog({ kind: 'rename', path, base: path });
                if (k === 'cp') { void navigator.clipboard?.writeText(path); message.success('Path copied'); }
                if (k === 'rm') modal.confirm({
                    title: `Delete ${path}?`, okText: 'Delete', okButtonProps: { danger: true },
                    content: (() => {
                        // Unsaved edits are not in the recovery copy (it holds the file as saved): said before deleting.
                        const unsaved = tabsNow.current.filter((t) => (t.path === path || t.path.startsWith(path + '/')) && t.content !== t.savedContent).map((t) => t.path);
                        return <>{unsaved.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`Unsaved changes in ${unsaved.length === 1 ? unsaved[0] : `${unsaved.length} open files`} are lost: the recovery copy has the saved version only.`} />}A copy of the saved file{path.includes('.') ? '' : 's'} is kept in .git/cs-studio/recovery/ in case you need it back.</>;
                    })(),
                    onOk: async () => { try { await api.deletePath(path); setTabs((ts) => ts.filter((t) => !(t.path === path || t.path.startsWith(path + '/')))); loadFiles(); void refresh(); } catch (e) { message.error(errText(e)); } },
                });
            },
        };
    };

    const submitDialog = async () => {
        if (!dialog) return;
        const p = dialog.path.trim().replace(/^\/+/, '');
        try {
            if (dialog.kind === 'file') { await api.saveFile(p, '', null); loadFiles(); await open(p); }
            if (dialog.kind === 'folder') { await api.newFolder(p); message.success('Folder created. It appears in the tree once it has a file.'); }
            if (dialog.kind === 'rename' && dialog.base) {
                await api.renamePath(dialog.base, p);
                setTabs((ts) => ts.map((t) => t.path === dialog.base ? { ...t, path: p } : t.path.startsWith(dialog.base + '/') ? { ...t, path: p + t.path.slice(dialog.base!.length) } : t));
                if (active === dialog.base) setActive(p);
                loadFiles(); void refresh();
            }
            setDialog(null);
        } catch (e) { message.error(errText(e)); }
    };

    // ▶ Run buttons for feature files: whole feature, or one scenario (in that feature).
    const { env: disc } = useStudio();
    const runFrom = async (path: string, scenario?: { name: string; outline: boolean; alsoMatches?: string[] }, debug?: boolean) => {
        // The framework selects scenarios by name with "contains" matching (case-insensitive), so other
        // scenarios in this file with overlapping names would run too. Say so first.
        if (scenario?.alsoMatches?.length) {
            const go = await new Promise<boolean>((resolve) => modal.confirm({
                title: `This also runs ${scenario.alsoMatches!.length} other scenario${scenario.alsoMatches!.length === 1 ? '' : 's'}`,
                content: <>The framework picks scenarios by matching part of the name, so these run as well: <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>{scenario.alsoMatches!.map((n) => <li key={n}>{n}</li>)}</ul>Give the scenario a more distinctive name, or run it by tag, to run it alone.</>,
                okText: 'Run them', onOk: () => resolve(true), onCancel: () => resolve(false),
            }));
            if (!go) return;
        }
        const projects = disc?.projects ?? [];
        const fromPath = /^test\/([^/]+)\//.exec(path)?.[1];
        const saved = loadRunTarget();
        const project = fromPath && projects.includes(fromPath) ? fromPath : saved?.project ?? projects[0];
        if (!project) { message.warning('No framework project found under config/.'); return; }
        const envs = disc?.environments[project] ?? [];
        const env = saved?.project === project && saved.env ? saved.env : saved?.env && envs.includes(saved.env) ? saved.env : envs[0] ?? 'dev';
        const t = tabsRef.current.find((x) => x.path === path);
        // The framework runs the file on disk: ask before saving unsaved edits (never save silently).
        if (t && t.content !== t.savedContent) {
            const choice = await new Promise<'save' | 'disk' | 'cancel'>((resolve) => {
                const inst = modal.confirm({
                    title: `${path.split('/').pop()} has unsaved changes`,
                    content: <>The test runs the file as saved on disk.
                        <div style={{ marginTop: 12 }}><Button size="small" onClick={() => { resolve('disk'); inst.destroy(); }}>Run the saved version (keep my edits unsaved)</Button></div></>,
                    okText: 'Save and run', cancelText: 'Cancel',
                    onOk: () => resolve('save'), onCancel: () => resolve('cancel'),
                });
            });
            if (choice === 'cancel') return;
            if (choice === 'save' && !(await save(path))) return;
        }
        try {
            const run = await api.startRun({
                project, env, features: [path], browser: saved?.browser, headless: saved?.headless, workers: 1,
                ...(scenario ? (scenario.outline ? { scenario: scenario.name } : { scenarios: [scenario.name] }) : {}),
                // Debugging: the breakpoints, and a pause when a step fails (the browser shown)
                ...(debug ? { debug: { pauseOnFailure: true } } : {}),
            });
            saveRunTarget({ ...(saved ?? {}), project, env });
            if (debug) setBottom('debug'); else showRun(run.id);
        } catch (e) { message.error(errText(e)); }
    };
    const gutterActions = React.useMemo(() => {
        if (!cur || !cur.path.endsWith('.feature')) return undefined;
        const acts: Array<{ line: number; title: string; onClick: () => void }> = [];
        const names = cur.content.split(/\r?\n/).map((l) => /^\s*(?:Scenario Outline|Scenario Template|Scenario|Example):\s*(.+?)\s*$/.exec(l)?.[1]).filter((n): n is string => !!n);
        cur.content.split(/\r?\n/).forEach((l, i) => {
            if (/^\s*Feature:/.test(l)) acts.push({ line: i + 1, title: 'Run this feature', onClick: () => void runFrom(cur.path) });
            const m = /^\s*(Scenario Outline|Scenario Template|Scenario|Example):\s*(.+?)\s*$/.exec(l);
            if (m && !m[2].includes(',')) acts.push({ line: i + 1, title: `Run "${m[2]}"`, onClick: () => {
                const outline = m[1] !== 'Scenario' && m[1] !== 'Example';
                // --scenario: name contains it; --scenarios: either name contains the other (CSBDDRunner).
                const me = m[2].toLowerCase();
                const alsoMatches = names.filter((n) => n !== m[2] && (n.toLowerCase().includes(me) || (!outline && me.includes(n.toLowerCase()))));
                void runFrom(cur.path, { name: m[2], outline, alsoMatches });
            } });
        });
        return acts;
    }, [cur?.path, cur?.content, disc]); // eslint-disable-line react-hooks/exhaustive-deps

    const debugCurrent = () => { if (cur?.path.endsWith('.feature')) void runFrom(cur.path, undefined, true); };
    const onExecLocation = React.useCallback((loc: ExecLocation | null) => {
        setExec(loc);
        if (loc) { setBottom('debug'); void openRef.current?.(loc.file, loc.line, undefined, true); }
    }, []);

    handlers.current = {
        setContent, editors: editors.current, toggleBreakpoint,
        save: (path) => void save(path),
        goTo: (path, text, off) => void goTo(path, text, off),
        format: (path, text) => void formatTab(path, text),
        usages: (path, text, off) => void findUsages(path, text, off),
        rename: (path, text, off) => void startRename(path, text, off),
    };
    openRef.current = open;
    treeMenuRef.current = treeMenu;

    // The file tree does not depend on the text being typed: keep it out of the per-keystroke render.
    const treePanel = React.useMemo(() => (
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
                <div style={{ padding: 6, display: 'flex', gap: 4, borderBottom: '1px solid var(--panel-border)' }}>
                    <Input size="small" allowClear placeholder="Filter files" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
                    <Tooltip title="New file"><Button aria-label="New file" size="small" type="text" icon={<FileAddOutlined />} onClick={() => setDialog({ kind: 'file', path: '' })} /></Tooltip>
                    <Tooltip title="New folder"><Button aria-label="New folder" size="small" type="text" icon={<FolderAddOutlined />} onClick={() => setDialog({ kind: 'folder', path: '' })} /></Tooltip>
                    <Tooltip title="Refresh"><Button aria-label="Refresh" size="small" type="text" icon={<ReloadOutlined />} onClick={loadFiles} /></Tooltip>
                </div>
                <div ref={treeBox} style={{ flex: 1, overflow: 'hidden', padding: '4px 0', minHeight: 0 }}>
                    {files.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description="No files" />
                        : filterText.trim() && !tree.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description={`No file matches "${filterText.trim()}"`} /> : (
                        <Tree.DirectoryTree treeData={tree} height={treeHeight} virtual selectedKeys={active ? [active] : []} expandedKeys={filterOpen ?? expanded}
                            onExpand={(k) => setExpanded(k)} expandAction="click"
                            onSelect={(keys) => { const k = String(keys[0] ?? ''); if (k && !k.startsWith('dir:')) goFileRef.current(k); }}
                            titleRender={(n) => (
                                <Dropdown trigger={['contextMenu']} menu={treeMenuRef.current(String(n.key))}>
                                    <span>{n.title as React.ReactNode}</span>
                                </Dropdown>
                            )}
                            icon={(p: { isLeaf?: boolean }) => p.isLeaf ? <FileOutlined /> : <FolderOutlined />} />
                    )}
                </div>
            </div>
    ), [filterText, files.length, tree, active, expanded, loadFiles, filterOpen, treeHeight]);

    const curDiags = cur ? diags[cur.path] ?? NO_DIAGS : NO_DIAGS;
    const bpLines = (path: string) => breakpoints.filter((b) => b.file === path).map((b) => b.line);
    const counts = { error: curDiags.filter((d) => d.severity === 'error').length, warning: curDiags.filter((d) => d.severity === 'warning').length };
    const dirty = (t: OpenFile) => t.content !== t.savedContent;

    return (
        <>
        <Split id="code-tree" initial={280} min={160} max={700} style={{ height: '100%' }}>
            {treePanel}

            <Split id="code-bottom" direction="column" sizeOf="second" initial={210} min={90} max={900}>
                <div className="panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {tabs.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: 'auto' }} description={<>Open a file from the tree, or press <Typography.Text keyboard>Ctrl</Typography.Text>+<Typography.Text keyboard>P</Typography.Text></>} />
                    ) : (
                        <>
                            <Tabs type="editable-card" hideAdd size="small" activeKey={active ?? undefined} onChange={(k) => goFileRef.current(k)} style={{ marginBottom: 0 }}
                                onEdit={(k, action) => { if (action === 'remove') close(String(k)); }}
                                tabBarExtraContent={cur && !cur.binary ? (
                                    <Space style={{ paddingRight: 8 }}>
                                        {tsState === 'starting' && langOf(cur.path) === 'ts' && (
                                            <Tooltip title="The first check of a TypeScript file loads the project; problems, completion and hover appear when it is ready.">
                                                <Typography.Text type="secondary" style={{ fontSize: 12 }}><LoadingOutlined style={{ marginRight: 6 }} />TypeScript is starting…</Typography.Text>
                                            </Tooltip>
                                        )}
                                        {counts.error > 0 && <Tag color="red">{counts.error} error{counts.error === 1 ? '' : 's'}</Tag>}
                                        {counts.warning > 0 && <Tag color="gold">{counts.warning} warning{counts.warning === 1 ? '' : 's'}</Tag>}
                                        <Tooltip title="Who last changed each line (git blame)"><Button size="small" type="text" icon={<UserOutlined />} aria-label="Who changed this file" onClick={() => setBlame(cur.path)} /></Tooltip>
                                        <Tooltip title="Save (Ctrl+S)"><Button size="small" icon={<SaveOutlined />} disabled={!dirty(cur)} onClick={() => void save(cur.path)}>Save</Button></Tooltip>
                                    </Space>
                                ) : null}
                                items={tabs.map((t) => {
                                    const name = t.path.split('/').pop()!;
                                    // Same file name open twice: show the folder too.
                                    const twin = tabs.some((o) => o !== t && o.path.split('/').pop() === name);
                                    const dir = t.path.split('/').slice(-2, -1)[0];
                                    return { key: t.path, label: <Tooltip title={t.path}><span>{name}{twin && dir && <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>{t.path.split('/').slice(-3, -1).join('/')}</Typography.Text>}{dirty(t) && <Badge status="processing" style={{ marginLeft: 6 }} />}</span></Tooltip>, closable: true };
                                })} />
                            <div style={{ flex: 1, minHeight: 0 }}>
                                {cur?.binary && <Alert style={{ margin: 16 }} type="info" showIcon message="This is a binary file and cannot be edited as text." />}
                                {/* One editor per open tab, kept mounted: undo history, scroll and caret survive tab switches. */}
                                {tabs.filter((t) => !t.binary).map((t) => (
                                    <TabEditor key={t.path} tab={t} active={t.path === active} h={handlers} diagnostics={diags[t.path] ?? NO_DIAGS}
                                        reveal={reveal?.path === t.path ? reveal : null} gutterActions={t.path === active ? gutterActions : undefined}
                                        breakpoints={bpLines(t.path)} execLine={exec?.file === t.path ? exec.line : null} />
                                ))}
                            </div>
                        </>
                    )}
                </div>
                <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <Tabs size="small" activeKey={bottom} onChange={(k) => setBottom(k as 'problems' | 'search' | 'usages' | 'debug')} style={{ paddingInline: 8, marginBottom: 0 }}
                        items={[
                            { key: 'problems', label: <span>Problems {curDiags.length > 0 && <Badge count={curDiags.length} size="small" color={counts.error ? '#cf1322' : '#d48806'} />}</span> },
                            { key: 'search', label: <span><SearchOutlined /> Search</span> },
                            { key: 'usages', label: <span>Usages {usages && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{usages.items.length}</Typography.Text>}</span> },
                            { key: 'debug', label: <span><BugOutlined /> Debug {exec && <Badge status="warning" />}{breakpoints.length > 0 && !exec && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{breakpoints.length}</Typography.Text>}</span> },
                        ]} />
                    {/* Kept mounted: it follows the debug run (and tells the editor where it is paused) on every tab. */}
                    <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px', display: bottom === 'debug' ? 'block' : 'none' }}>
                        <DebugPanel breakpoints={breakpoints} onLocation={onExecLocation} onStart={debugCurrent} canStart={!!cur?.path.endsWith('.feature')}
                            onRemoveBreakpoint={(b) => saveBreakpoints(breakpoints.filter((x) => !(x.file === b.file && x.line === b.line)))} onClearBreakpoints={() => saveBreakpoints([])} />
                    </div>
                    <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px', display: bottom === 'debug' ? 'none' : 'block' }}>
                        {bottom === 'usages' ? (
                            !usages ? <Typography.Text type="secondary">Shift+F12 on a step (in a feature or a step file) shows where it is used.</Typography.Text> : (
                                <Space direction="vertical" style={{ width: '100%' }} size={2}>
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{usages.items.length} usage{usages.items.length === 1 ? '' : 's'} of <span className="mono">{usages.title}</span> in {new Set(usages.items.map((u) => u.path)).size} file{new Set(usages.items.map((u) => u.path)).size === 1 ? '' : 's'}</Typography.Text>
                                    {usages.items.map((u, i) => (
                                        <div key={i} className="file-row" onClick={() => open(u.path, u.line, u.column)}>
                                            <Typography.Text className="mono" type="secondary" style={{ flex: 'none' }}>{u.path}:{u.line}</Typography.Text>
                                            <span className="name mono">{u.text.trim()}</span>
                                        </div>))}
                                </Space>)
                        ) : bottom === 'problems' ? (
                            curDiags.length === 0 ? <Typography.Text type="secondary">{cur ? 'No problems in this file.' : 'Open a file to see its problems.'}</Typography.Text> : (
                                <List size="small" dataSource={curDiags} renderItem={(d) => (
                                    <List.Item style={{ cursor: 'pointer', padding: '2px 4px' }} onClick={() => cur && setReveal({ path: cur.path, line: d.line, column: d.column, nonce: Date.now() })}>
                                        <Space size={6} align="start">
                                            <Tag color={d.severity === 'error' ? 'red' : d.severity === 'warning' ? 'gold' : 'blue'} style={{ marginInlineEnd: 0 }}>{d.source}</Tag>
                                            <Typography.Text>{d.message}</Typography.Text>
                                            <Typography.Text type="secondary" className="mono" style={{ whiteSpace: 'nowrap', flex: 'none' }}>[{d.line}:{d.column}]</Typography.Text>
                                            {d.fix === 'create-step' && cur && <Button size="small" type="link" style={{ padding: 0, height: 'auto' }}
                                                onClick={(e) => { e.stopPropagation(); void startCreateStep(cur.path, d.line); }}>Create step definition</Button>}
                                        </Space>
                                    </List.Item>
                                )} />
                            )
                        ) : (
                            <Space direction="vertical" style={{ width: '100%' }} size={4}>
                                <Space wrap size={6}>
                                    <Input id="cs-global-search" size="small" placeholder="Search in all files (Ctrl+Shift+F)" style={{ width: 300 }} value={search.q} onChange={(e) => setSearch({ ...search, q: e.target.value })} onPressEnter={runSearch} />
                                    <Input size="small" placeholder="Only in (e.g. *.feature)" style={{ width: 170 }} value={search.glob} onChange={(e) => setSearch({ ...search, glob: e.target.value })} onPressEnter={runSearch} />
                                    <Button size="small" type={search.case ? 'primary' : 'default'} onClick={() => setSearch({ ...search, case: !search.case })}>Aa</Button>
                                    <Button size="small" type={search.word ? 'primary' : 'default'} onClick={() => setSearch({ ...search, word: !search.word })}>Word</Button>
                                    <Button size="small" type={search.regex ? 'primary' : 'default'} onClick={() => setSearch({ ...search, regex: !search.regex })}>.*</Button>
                                    <Button size="small" type="primary" onClick={runSearch}>Search</Button>
                                    {hits && (() => { const n = new Set(hits.map((h) => h.path)).size; return <Typography.Text type="secondary">{hits.length ? `${hits.length} result${hits.length === 1 ? '' : 's'} in ${n} file${n === 1 ? '' : 's'}` : 'No matches'}</Typography.Text>; })()}
                                </Space>
                                {hits?.map((h, i) => (
                                    <div key={i} className="file-row" onClick={() => open(h.path, h.line, h.column)}>
                                        <Typography.Text className="mono" type="secondary" style={{ flex: 'none' }}>{h.path}:{h.line}</Typography.Text>
                                        <span className="name mono">{h.text.trim()}</span>
                                    </div>
                                ))}
                            </Space>
                        )}
                    </div>
                </div>
            </Split>
        </Split>

            <Modal open={quick.open} footer={null} closable={false} onCancel={() => setQuick({ ...quick, open: false })} width={640} styles={{ body: { padding: 0 } }} destroyOnClose
                afterOpenChange={(o) => { if (o) quickInput.current?.focus(); }}>
                <Input ref={quickInput} autoFocus size="large" placeholder="Type a file name" value={quick.q} variant="borderless"
                    onChange={(e) => setQuick({ ...quick, q: e.target.value, index: 0 })}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') { e.preventDefault(); setQuick({ ...quick, index: Math.min(quickList.length - 1, quick.index + 1) }); }
                        if (e.key === 'ArrowUp') { e.preventDefault(); setQuick({ ...quick, index: Math.max(0, quick.index - 1) }); }
                        if (e.key === 'Enter' && quickList[quick.index]) { void open(quickList[quick.index]); setQuick({ ...quick, open: false }); }
                    }} />
                <div style={{ maxHeight: 360, overflow: 'auto', borderTop: '1px solid var(--panel-border)' }}>
                    {quick.q.trim() && !quickList.length && <Typography.Text type="secondary" style={{ display: 'block', padding: '10px 14px' }}>No file matches "{quick.q.trim()}"</Typography.Text>}
                    {quickList.map((p, i) => (
                        <div key={p} className={`file-row${i === quick.index ? ' selected' : ''}`} onClick={() => { void open(p); setQuick({ ...quick, open: false }); }}>
                            <span className="name">{p.split('/').pop()}<span className="dir">{p.split('/').slice(0, -1).join('/')}</span></span>
                        </div>
                    ))}
                </div>
            </Modal>
            <Modal open={!!stepFix} title="Create step definition" okText="Create" width={720} destroyOnClose
                confirmLoading={stepFix?.busy} onCancel={() => setStepFix(null)} onOk={() => void confirmCreateStep()}>
                {stepFix && <Space direction="vertical" style={{ width: '100%' }} size={10}>
                    <Typography.Text>For the step <Typography.Text code>{stepFix.plan.step}</Typography.Text></Typography.Text>
                    <pre className="mono" style={{ margin: 0, padding: 10, background: 'var(--code-bg, rgba(127,127,127,0.08))', borderRadius: 6, overflow: 'auto', fontSize: 12 }}>{stepFix.plan.preview}</pre>
                    {stepFix.plan.params.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Parameters: {stepFix.plan.params.map((p) => `${p.name} (${p.type})`).join(', ')}. Numbers arrive as numbers, quoted text as text, a table as a DataTable.
                    </Typography.Text>}
                    <div>
                        <Typography.Text strong>Add it to</Typography.Text>
                        <Radio.Group value={stepFix.target} onChange={(e) => setStepFix({ ...stepFix, target: e.target.value })} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, maxHeight: 220, overflow: 'auto' }}>
                            {stepFix.plan.targets.map((t) => <Radio key={t.file} value={t.file}>
                                <span className="mono">{t.file}</span> {t.exists ? null : <Tag color="green">new file</Tag>}{t.recommended && <Tag color="purple">suggested</Tag>}
                                {tabs.some((x) => x.path === t.file && x.content !== x.savedContent) && <Tag color="gold">open, unsaved</Tag>}
                            </Radio>)}
                        </Radio.Group>
                    </div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Only step files the framework loads are listed (the folders in STEP_DEFINITIONS_PATH). The new method throws "not implemented" until you fill it in, so the scenario cannot pass by accident.</Typography.Text>
                </Space>}
            </Modal>
            {blame && <BlameView file={blame} onClose={() => setBlame(null)} />}
            <Modal open={!!renaming} title="Rename step" width={760} destroyOnClose onCancel={() => setRenaming(null)}
                footer={<Space>
                    <Button onClick={() => setRenaming(null)}>Cancel</Button>
                    <Button onClick={() => void previewRename()} loading={renaming?.busy && !renaming.preview} disabled={!renaming || renaming.to.trim() === renaming.from}>Preview</Button>
                    <Button type="primary" onClick={() => void applyRename()} loading={renaming?.busy && !!renaming.preview} disabled={!renaming?.preview || renaming.preview.pattern !== renaming.to.trim()}>Rename</Button>
                </Space>}>
                {renaming && <Space direction="vertical" style={{ width: '100%' }} size={10}>
                    <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>Now</Typography.Text><div className="mono">{renaming.from}</div></div>
                    <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>New wording (keep the same values in the same order)</Typography.Text>
                        <Input className="mono" autoFocus value={renaming.to} aria-label="New wording" onChange={(e) => setRenaming({ ...renaming, to: e.target.value, preview: undefined, error: undefined })} onPressEnter={() => void previewRename()} />
                    </div>
                    {renaming.error && <Alert type="error" showIcon message={renaming.error} />}
                    {renaming.preview && <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{renaming.preview.changes.length} line{renaming.preview.changes.length === 1 ? '' : 's'} in {renaming.preview.files.length} file{renaming.preview.files.length === 1 ? '' : 's'}</Typography.Text>
                        <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 4 }}>
                            {renaming.preview.changes.map((c, i) => (
                                <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid var(--border, rgba(127,127,127,.15))' }}>
                                    <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{c.path}:{c.line}</Typography.Text>
                                    <div className="mono diff-del" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>- {c.before.trim()}</div>
                                    <div className="mono diff-add" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>+ {c.after.trim()}</div>
                                </div>))}
                        </div>
                        {renaming.preview.skipped.length > 0 && <Alert type="warning" showIcon style={{ marginTop: 8 }} message={`${renaming.preview.skipped.length} step${renaming.preview.skipped.length === 1 ? '' : 's'} not written in a way the rename can change: change ${renaming.preview.skipped.length === 1 ? 'it' : 'them'} by hand`}
                            description={renaming.preview.skipped.map((u) => `${u.path}:${u.line}  ${u.text}`).join('\n')} />}
                    </div>}
                </Space>}
            </Modal>
            <Modal open={!!closing} title={`Save changes to ${closing?.path.split('/').pop() ?? ''}?`} width={440}
                onCancel={() => { if (!closing?.saving) setClosing(null); }} maskClosable={false}
                footer={[
                    <Button key="cancel" disabled={closing?.saving} onClick={() => setClosing(null)}>Cancel</Button>,
                    <Button key="discard" danger disabled={closing?.saving} onClick={() => { const p = closing!.path; setClosing(null); forceClose(p); }}>Don't save</Button>,
                    <Button key="save" type="primary" loading={closing?.saving} onClick={() => void closeWithSave()}>Save</Button>,
                ]}>
                <Typography.Paragraph>Your changes are lost if you don't save them.</Typography.Paragraph>
            </Modal>
            <Modal open={!!dialog} title={dialog?.kind === 'file' ? 'New file' : dialog?.kind === 'folder' ? 'New folder' : 'Rename'} okText={dialog?.kind === 'rename' ? 'Rename' : 'Create'}
                onCancel={() => setDialog(null)} onOk={submitDialog} okButtonProps={{ disabled: !dialog?.path.trim() || dialog.path.endsWith('/') }}
                afterOpenChange={(o) => { if (o) { const el = document.getElementById('cs-code-path-input') as HTMLInputElement | null; el?.focus(); const v = el?.value ?? ''; el?.setSelectionRange(v.length, v.length); } }}>
                <Input id="cs-code-path-input" autoFocus className="mono" value={dialog?.path} onChange={(e) => dialog && setDialog({ ...dialog, path: e.target.value })} onPressEnter={submitDialog}
                    placeholder={dialog?.kind === 'file' ? 'test/orders/features/search.feature' : 'test/orders/pages'} />
                <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>Path inside the project. Folders in the path are created as needed.</Typography.Paragraph>
            </Modal>
        </>
    );
}
