/**
 * Code: the in-house editor with file tree, tabs, quick open, search, problems and language
 * features (TypeScript language service; Gherkin step matching using the framework's own rules).
 */
import React from 'react';
import { Split } from '../components/Split';
import { currentRoute, navigate, useRoute } from '../route';
import { Alert, App, Badge, Button, Checkbox, Empty, Input, List, Modal, Radio, Space, Tabs, Tag, Tooltip, Tree, Typography } from 'antd';
import { BlameView } from '../components/BlameView';
import type { DataNode } from 'antd/es/tree';
import { BugOutlined, CloseOutlined, LockOutlined, FileAddOutlined, UserOutlined, FileOutlined, FolderAddOutlined, FolderOutlined, LoadingOutlined, ReloadOutlined, SaveOutlined, SearchOutlined, UndoOutlined } from '@ant-design/icons';
import { api, Breakpoint, closeFilesOnUnload, Diag, SearchHit, StepPlan, StepRename, TextSearchResult } from '../api';
import { countText, groupByFile, NEW_SEARCH, previewLine, queryOf, SearchState, withOpenTabs } from '../codeSearch';
import { EXCLUDED_DIRS, replaceIn } from '../../../src/workspace/textSearch';
import { useUnsaved } from '../unsaved';
import { errText, loadRunTarget, saveRunTarget, showRun, unsavedFiles, useStudio } from '../state';
import { handlesSaveFiles, SAVE_FILES_EVENT, SaveFilesRequest } from '../runSignals';
import { CodeEditor, CodeEditorHandle } from '../editor/CodeEditor';
import { copilotProvider, CopilotStatusItem } from '../editor/copilot';
import { DebugPanel, ExecLocation } from '../components/DebugPanel';
import { useKept } from '../kept';
import { codeTarget } from '../codeRoute';
import { splitTab, TAB_MARK, withTab } from '../apiperf-ui';
import { langOf } from '../editor/highlight';
import { newPathProblem } from '../../../src/workspace/newName';
import { useContextMenu } from '../components/ContextMenu';
import { areaOf, duplicateName, featuresIn, fullPath, gitStateOf, MenuEntry, scenarioAt, scenarioRef, tabMenu, TabClose, tabsToClose, treeMenu } from '../contextMenus';
import { confirmDiscard, copyText, openChanges, showHistory } from '../gitActions';

/** `content` / `savedContent` always use "\n"; `eol` is the file's own line ending, restored on save. */
interface OpenFile { path: string; content: string; savedContent: string; hash: string | null; binary: boolean; eol: '\n' | '\r\n'; readOnly?: boolean }
/** A library file (a framework class's .d.ts): shown read-only, from go to definition or usages. */
const isLibrary = (path: string) => path.split('/').includes('node_modules');

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
    /** The page's items in the editor's right-click menu. */
    editorMenu: (path: string, at: { line: number; offset: number; text: string }) => { actions?: MenuEntry[]; file?: MenuEntry[] };
}
const NO_DIAGS: Diag[] = [];
/** The bottom panel's tabs (also the address's last segment, ~<tab>). */
const BOTTOM_TABS = ['problems', 'search', 'usages', 'debug'] as const;
type BottomTab = typeof BOTTOM_TABS[number];

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
    const lang = langOf(path);
    // Copilot's ghost text for code files (asks only once Copilot is set up and signed in).
    const inline = React.useMemo(() => copilotProvider(path), [path]);
    const statusItems = React.useMemo(() => <CopilotStatusItem />, []);
    return (
        <CodeEditor ref={register} active={active} value={tab.content} lang={lang} eol={tab.eol} readOnly={tab.readOnly}
            onChange={(text) => h.current.setContent(path, text)} onSave={() => h.current.save(path)}
            diagnostics={diagnostics} reveal={reveal} gutterActions={gutterActions}
            breakpoints={breakpoints} execLine={execLine} onToggleBreakpoint={canBreak(path) ? (line) => h.current.toggleBreakpoint(path, line) : undefined}
            completions={async (text, off, signal) => (await api.completions(path, text, off, signal)).items}
            completionDetails={lang === 'ts' ? async (text, off, it, signal) => { const d = await api.completionDetails(path, text, off, it.name, it.source, it.data, signal); return d.stale ? null : d; } : undefined}
            signatureHelp={lang === 'ts' ? async (text, off, trigger, signal) => (await api.signatureHelp(path, text, off, trigger, signal)).help : undefined}
            inline={inline} statusItems={statusItems}
            hover={async (text, off) => { const r = await api.hover(path, text, off); return r.text ? r : null; }}
            definition={(text, off) => h.current.goTo(path, text, off)}
            format={(text) => h.current.format(path, text)}
            usages={(text, off) => h.current.usages(path, text, off)}
            rename={(text, off) => h.current.rename(path, text, off)}
            contextMenu={(at) => h.current.editorMenu(path, at)} />
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
                return { key: v, isLeaf: true, title: <span data-tree-key={v} className={m ? `tree-${m}` : ''}>{name}{m && <span className="tree-mark">{m}</span>}</span> };
            }
            return { key: `dir:${key}`, title: <span data-tree-key={`dir:${key}`}>{name}</span>, children: toNodes(v as Record<string, unknown>, key) };
        });
    return toNodes(root, '');
}

/** The Search tab: search (and replace) in the project, a folder, or the open file. */
function SearchPanel({ search, setSearch, found, searching, replacing, activeFile, folderOfActive, onSearch, onClear, onOpen, onReplaceOne, onReplaceAll }: {
    search: SearchState; setSearch: (s: SearchState) => void;
    found: { r: TextSearchResult; for: SearchState; file: string | null } | null; searching: boolean; replacing: boolean;
    activeFile: string | null; folderOfActive: string;
    onSearch: (s: SearchState) => void; onClear: () => void; onOpen: (h: SearchHit) => void;
    onReplaceOne: (h: SearchHit) => void; onReplaceAll: (onlyFile?: string) => void;
}) {
    /** Change options; with results shown, search again with them. */
    const change = (patch: Partial<SearchState>, again = true) => {
        const next = { ...search, ...patch };
        setSearch(next);
        if (again && found && next.q) onSearch(next);
    };
    const esc = (e: React.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClear(); } };
    const r = found?.r;
    const stale = !!found && found.for.q !== search.q;
    const shown: SearchState = found ? { ...found.for, replace: search.replace, showReplace: search.showReplace } : search;
    const canReplace = search.showReplace && !!r && r.total > 0 && !stale && !replacing;
    const groups = r ? groupByFile(r.hits) : [];
    const countOf = new Map((r?.files ?? []).map((f) => [f.path, f.count]));
    const scopeText = search.scope === 'file' ? (activeFile ? activeFile.split('/').pop() : 'no file open') : search.scope === 'folder' ? (search.folder || folderOfActive || 'the project') + '/' : 'the whole project';
    return (
        <div onKeyDown={esc} className="cs-search">
            <Space direction="vertical" style={{ width: '100%' }} size={4}>
                <Space wrap size={6}>
                    <Tooltip title={search.showReplace ? 'Hide replace' : 'Replace (Ctrl+Shift+H)'}>
                        <Button size="small" type={search.showReplace ? 'primary' : 'default'} aria-label="Toggle replace" aria-pressed={search.showReplace} onClick={() => setSearch({ ...search, showReplace: !search.showReplace })}>⇄</Button>
                    </Tooltip>
                    <Input id="cs-global-search" size="small" placeholder="Search (Ctrl+Shift+F) — Esc clears" style={{ width: 300 }} value={search.q} aria-label="Search text"
                        onChange={(e) => setSearch({ ...search, q: e.target.value })} onPressEnter={() => onSearch(search)} />
                    <Tooltip title="Match case"><Button size="small" aria-pressed={search.case} type={search.case ? 'primary' : 'default'} onClick={() => change({ case: !search.case })}>Aa</Button></Tooltip>
                    <Tooltip title="Whole word"><Button size="small" aria-pressed={search.word} type={search.word ? 'primary' : 'default'} onClick={() => change({ word: !search.word })}>Word</Button></Tooltip>
                    <Tooltip title="Regular expression (JavaScript)"><Button size="small" aria-pressed={search.regex} type={search.regex ? 'primary' : 'default'} onClick={() => change({ regex: !search.regex })}>.*</Button></Tooltip>
                    <Button size="small" type="primary" loading={searching} onClick={() => onSearch(search)}>Search</Button>
                    <Tooltip title="Clear the search and its results (Esc)"><Button size="small" type="text" aria-label="Clear search" icon={<CloseOutlined />} disabled={!search.q && !found} onClick={onClear} /></Tooltip>
                    {r && !searching && <Typography.Text type="secondary" role="status">{r.total ? countText(r.total, r.files.length) : 'No matches'}{r.limited ? ` (first ${r.hits.length} shown)` : ''} in {found?.for.scope === 'file' ? found.file : found?.for.scope === 'folder' ? `${found.for.folder}/` : 'the project'}{stale ? ' — press Enter to search for the new text' : ''}</Typography.Text>}
                </Space>
                {search.showReplace && (
                    <Space wrap size={6}>
                        <span style={{ display: 'inline-block', width: 30 }} />
                        <Input id="cs-global-replace" size="small" placeholder={search.regex ? 'Replace with ($1, $2… for groups)' : 'Replace with'} style={{ width: 300 }} value={search.replace} aria-label="Replace with"
                            onChange={(e) => setSearch({ ...search, replace: e.target.value })} onPressEnter={() => canReplace && onReplaceAll()} />
                        <Button size="small" danger disabled={!canReplace} loading={replacing} onClick={() => onReplaceAll()}>
                            Replace all{r && r.total > 0 && !stale ? ` (${countText(r.total, r.files.length)})` : ''}
                        </Button>
                        {!found && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Search first: the results show what each replacement makes.</Typography.Text>}
                    </Space>
                )}
                <Space wrap size={8}>
                    <Radio.Group size="small" value={search.scope} optionType="button" aria-label="Search in"
                        onChange={(e) => change({ scope: e.target.value, ...(e.target.value === 'folder' && !search.folder ? { folder: folderOfActive } : {}) })}
                        options={[{ value: 'project', label: 'Whole project' }, { value: 'folder', label: 'Folder' }, { value: 'file', label: 'This file', disabled: !activeFile }]} />
                    {search.scope === 'folder' && <Input size="small" className="mono" aria-label="Folder" placeholder="test/orders" style={{ width: 200 }} value={search.folder}
                        onChange={(e) => setSearch({ ...search, folder: e.target.value.replace(/\\/g, '/') })} onPressEnter={() => onSearch(search)} />}
                    {search.scope !== 'file' && <Input size="small" placeholder="Only in (e.g. *.feature, *.ts)" style={{ width: 190 }} value={search.glob} aria-label="Only in files"
                        onChange={(e) => setSearch({ ...search, glob: e.target.value })} onPressEnter={() => onSearch(search)} />}
                    {search.scope !== 'file' && <Tooltip title={`Also search files Git ignores and the folders left out by default: ${EXCLUDED_DIRS.filter((d) => d !== '.git').join(', ')}`}>
                        <Checkbox checked={search.ignored} onChange={(e) => change({ ignored: e.target.checked })}>Include ignored files</Checkbox>
                    </Tooltip>}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Searching {scopeText}</Typography.Text>
                </Space>
                {r?.truncated && <Alert type="warning" showIcon message="Too many files to read them all: choose a folder to search everywhere in it." />}
                {groups.map((g) => (
                    <div key={g.path} className="cs-result-group">
                        <div className="cs-result-file" title={g.path}>
                            <FileOutlined style={{ marginRight: 6 }} /><span className="mono">{g.path}</span>
                            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{countOf.get(g.path) ?? g.items.length}</Typography.Text>
                            {canReplace && <Button size="small" type="link" style={{ marginLeft: 8, padding: 0, height: 'auto' }} onClick={(e) => { e.stopPropagation(); onReplaceAll(g.path); }}>Replace in file</Button>}
                        </div>
                        {g.items.map((h, i) => {
                            const p = previewLine(h, shown);
                            return (
                                <div key={i} className="file-row cs-result-row" onClick={() => onOpen(h)}>
                                    <Typography.Text className="mono" type="secondary" style={{ flex: 'none', minWidth: 44, textAlign: 'right' }}>{h.line}</Typography.Text>
                                    <span className="name mono">{p.before.trimStart()}<mark className={p.replaced !== undefined ? 'cs-match cs-match-old' : 'cs-match'}>{p.match}</mark>{p.replaced !== undefined && <mark className="cs-match-new">{p.replaced}</mark>}{p.after}</span>
                                    {canReplace && <Button size="small" type="link" style={{ flex: 'none', padding: '0 4px', height: 'auto' }} onClick={(e) => { e.stopPropagation(); onReplaceOne(h); }}>Replace</Button>}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </Space>
        </div>
    );
}

export function Code() {
    const { message, modal } = App.useApp();
    const { status, refresh, repoRoot } = useStudio();
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
    useUnsaved('code', tabs.some((t) => t.content !== t.savedContent), 'files in the editor', { keeps: (to) => to[0] === 'code' });
    const [active, setActive] = React.useState<string | null>(null);
    const [diags, setDiags] = React.useState<Record<string, Diag[]>>({});
    const [reveal, setReveal] = React.useState<{ path: string; line: number; column?: number; nonce: number; soft?: boolean } | null>(null);
    // The bottom panel's tab: in the address too, as its last segment (#/code/<file>/<line>/~search), so a link opens
    // that tab and Back returns to the tab before (no question about the unsaved edits: they stay in the editor).
    const route = useRoute();
    const onCode = route[0] === 'code';
    const { rest: codeRest, tab: routeTabRaw } = splitTab(onCode ? route.slice(1) : []);
    const routeTab = routeTabRaw && (BOTTOM_TABS as readonly string[]).includes(routeTabRaw) ? routeTabRaw as BottomTab : null;
    const [bottomKept, setBottomKept] = useKept<BottomTab>('code.bottom', 'problems');
    const bottom: BottomTab = routeTab ?? ((BOTTOM_TABS as readonly string[]).includes(bottomKept) ? bottomKept : 'problems');
    const bottomRef = React.useRef(bottom);
    bottomRef.current = bottom;
    /** Show a tab of the bottom panel; `push`: a new step in the history (a click on the tab), else the address is changed in place. */
    const setBottom = React.useCallback((t: BottomTab, push = false) => {
        setBottomKept(t);
        bottomRef.current = t;
        const r = currentRoute();
        if (r[0] === 'code') navigate(withTab(r, t), !push);
    }, [setBottomKept]);
    // A link or Back to a tab: it becomes the remembered one.
    React.useEffect(() => { if (routeTab && routeTab !== bottomKept) setBottomKept(routeTab); }, [routeTab]); // eslint-disable-line react-hooks/exhaustive-deps
    // An address without a tab (or with one the panel does not have): the tab shown is written into it, in place.
    React.useEffect(() => { if (onCode && !routeTab) navigate(withTab(currentRoute(), bottomRef.current), true); }, [onCode, routeTab, codeRest.join('\0')]); // eslint-disable-line react-hooks/exhaustive-deps
    /** A Code address for a file (and line), with the bottom panel's tab shown now. */
    const codeAddr = (path?: string | null, line?: number): Array<string | number | undefined> => ['code', path ?? undefined, line, TAB_MARK + bottomRef.current];
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
    const [search, setSearch] = React.useState<SearchState>(NEW_SEARCH);
    const searchRef = React.useRef(search);
    searchRef.current = search;
    /** The last search's results (with open tabs' unsaved text searched here), and the search they are for. */
    const [found, setFound] = React.useState<{ r: TextSearchResult; for: SearchState; file: string | null } | null>(null);
    const [searching, setSearching] = React.useState(false);
    const [replacing, setReplacing] = React.useState(false);
    const [quick, setQuick] = React.useState<{ open: boolean; q: string; index: number }>({ open: false, q: '', index: 0 });
    const [dialog, setDialog] = React.useState<{ kind: 'file' | 'folder' | 'rename'; path: string; base?: string; error?: string } | null>(null);
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
    const treeMenuRef = React.useRef<(key: string | null, x: number, y: number) => void>(null!);
    const treeKeyRef = React.useRef<(e: React.KeyboardEvent) => void>(null!);
    const tabMenuRef = React.useRef<(path: string, x: number, y: number) => void>(null!);
    // The tree node the keyboard is on (or last clicked): F2, Delete and the menu key act on it.
    const treeNode = React.useRef<string | null>(null);
    /** The tree's own focus target (rc-tree keeps the keyboard on a hidden input). */
    const focusTree = () => (treeBox.current?.querySelector('.ant-tree input') as HTMLElement | null)?.focus({ preventScroll: true });
    const treeRef = React.useRef<{ scrollTo: (o: { key: React.Key; align?: 'top' | 'bottom' | 'auto' }) => void } | null>(null);
    // A node shown by "Reveal in file tree" (selected until another one is clicked).
    const [revealed, setRevealed] = React.useState<string | null>(null);
    const ctx = useContextMenu();
    /** Closing a tab with unsaved edits asks first; `rest`: more tabs to close after this one (Close others, Close all, …). */
    const [closing, setClosing] = React.useState<{ path: string; saving: boolean; rest: string[] } | null>(null);
    /** TypeScript language features warm up on the first request (can take seconds on big projects). */
    const [tsState, setTsState] = React.useState<'idle' | 'starting' | 'ready'>('idle');
    const quickInput = React.useRef<import('antd').InputRef>(null);

    // A reload or a closed browser tab: the editor texts sent to TypeScript are dropped (else they would outlive the page).
    React.useEffect(() => {
        const bye = () => closeFilesOnUnload(tabsRef.current.filter((t) => !t.readOnly && !t.binary && langOf(t.path) === 'ts').map((t) => t.path));
        window.addEventListener('pagehide', bye);
        return () => window.removeEventListener('pagehide', bye);
    }, []);
    const loadFiles = React.useCallback(() => { api.files().then(setFiles).catch((e) => message.error(errText(e))); }, [message]);
    React.useEffect(loadFiles, [loadFiles, status?.head]);
    // Let TypeScript load the project in the background (it runs in its own thread on the server),
    // so the first completion or hover is quick.
    React.useEffect(() => { void api.warmUpLanguage().catch(() => undefined); }, []);
    // And the project of the TypeScript file being edited (its own tsconfig.json may be another one).
    React.useEffect(() => { if (active && langOf(active) === 'ts') void api.warmUpLanguage(active).catch(() => undefined); }, [active]);
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
                const lib = isLibrary(path);
                const f = lib ? await api.readLibraryFile(path) : await api.readFile(path);
                const d = fromDisk(f.content);
                setTabs((ts) => ts.some((t) => t.path === path) ? ts : [...ts, { path, content: d.content, savedContent: d.content, hash: f.hash, binary: f.binary, eol: d.eol, ...(lib || f.readOnly ? { readOnly: true } : {}) }]);
            } catch (e) {
                message.error(`${path}: ${errText(e)}`);
                // An address to a file that is not there (an old link): the address shows the open file, not the missing one.
                if (currentRoute()[0] === 'code' && currentRoute()[1] === path) navigate(codeAddr(active), true);
                return;
            }
        }
        setActive(path);
        // reveal the folder in the tree
        const dirs = path.split('/').slice(0, -1).map((_, i, a) => `dir:${a.slice(0, i + 1).join('/')}`);
        setExpanded((ex) => [...new Set([...ex, ...dirs])]);
        if (line) setReveal({ path, line, column, nonce: Date.now(), ...(soft ? { soft } : {}) });
    }, [tabs, message]);

    // The open file (and line) is part of the address (#/code/<file>/<line>), so the browser's Back
    // returns to where you were before a jump (Ctrl+click on a step, a search hit, a problem).
    const routeKey = onCode ? codeRest.join('\0') : null;
    const lastRoute = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (routeKey === null || routeKey === lastRoute.current) return;
        lastRoute.current = routeKey;
        // A typed address with plain slashes (#/code/test/a/b.feature/12) is rewritten in place to its usual form.
        const t = codeTarget(codeRest);
        if (t.typed) {
            lastRoute.current = [t.path, t.line ? String(t.line) : ''].filter(Boolean).join('\0');
            navigate(codeAddr(t.path, t.line), true);
        }
        if (t.path) void open(t.path, t.line);
    }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps
    /** Go to a file (and line), as a new step in the browser history. */
    const goFile = React.useCallback((path: string, line?: number, column?: number, fromLine?: number) => {
        // Remember the line we are leaving, so Back lands on it.
        const curPath = activeRef.current;
        if (curPath && currentRoute()[0] === 'code') {
            const l = fromLine ?? editors.current.get(curPath)?.caretLine();
            if (l) { const k = [curPath, String(l)].join('\0'); lastRoute.current = k; navigate(codeAddr(curPath, l), true); }
        }
        const key = [path, line ? String(line) : ''].filter(Boolean).join('\0');
        lastRoute.current = key;
        navigate(codeAddr(path, line));
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
        navigate(codeAddr(active), true);
    }, [active]);

    // Diagnostics for the active file, shortly after the user stops typing.
    React.useEffect(() => {
        if (!cur || cur.binary || cur.readOnly) return;
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
                if (t.binary || t.readOnly || t.content !== t.savedContent) continue;
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
    /** Back to the saved version: the changes made since the last save are thrown away (asked first). */
    const discardTab = (path: string) => {
        const t = tabsNow.current.find((x) => x.path === path);
        if (!t || t.content === t.savedContent) return;
        modal.confirm({
            title: `Discard your changes to ${path.split('/').pop()}?`,
            content: 'The file goes back to how it was last saved. This cannot be undone.',
            okText: 'Discard changes', okButtonProps: { danger: true },
            onOk: () => { setTabs((ts) => ts.map((x) => (x.path === path ? { ...x, content: x.savedContent } : x))); message.info('Changes discarded'); },
        });
    };
    const save = async (path: string, force = false): Promise<boolean> => {
        const t = tabsRef.current.find((x) => x.path === path); if (!t) return false;
        if (t.readOnly) { message.info(`${path.split('/').pop()} is a library file: it is shown read-only.`); return false; }
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
            // Esc, the close button and "Keep editing" all keep the edits in this tab (nothing is saved or loaded).
            return new Promise<boolean>((resolve) => {
                let done = false, picked = false;
                const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
                const ask = (title: string, content: React.ReactNode, buttons: (close: () => void) => React.ReactNode) => {
                    const m = modal.confirm({
                        title, content, closable: true, maskClosable: false, keyboard: true,
                        // Closed without a choice (Esc, ×): keep editing.
                        afterClose: () => { if (!picked) finish(false); },
                        onCancel: () => { if (!picked) finish(false); },
                        footer: () => <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }} wrap>{buttons(() => { picked = true; m.destroy(); })}</Space>,
                    });
                };
                const name = path.split('/').pop();
                if (!disk) {
                    ask(`${name} was deleted after you opened it`,
                        <>It was deleted in another Studio tab, by another program, or by a pull or branch switch. Your edits are still here.<br /><br /><b>Save mine</b> recreates the file with your version. <b>Close the file</b> drops your edits.</>,
                        (close) => <>
                            <Button onClick={() => { close(); finish(false); }}>Keep editing</Button>
                            <Button danger onClick={() => { close(); forceClose(path); finish(false); }}>Close the file</Button>
                            <Button type="primary" onClick={async () => { close(); finish(await save(path, true)); }}>Save mine</Button>
                        </>);
                    return;
                }
                ask(`${name} changed after you opened it`,
                    <>It was saved in another Studio tab, by another program, or by a pull. Your edits are still here.<br /><br /><b>Reload</b> shows the saved version (your edits here are dropped). <b>Overwrite</b> saves yours over it (the other change is lost).</>,
                    (close) => <>
                        <Button onClick={() => { close(); finish(false); }}>Keep editing</Button>
                        <Button danger onClick={async () => { close(); finish(await save(path, true)); }}>Overwrite</Button>
                        <Button type="primary" onClick={() => {
                            close();
                            const d = fromDisk(disk.content);
                            setTabs((ts) => ts.map((x) => x.path === path ? { ...x, content: d.content, savedContent: d.content, hash: disk.hash, eol: d.eol } : x));
                            finish(false);
                        }}>Reload</Button>
                    </>);
            });
        }
    };

    /** Close a tab without asking. */
    // "Save and run" on Run tests: the files it names are saved here first (true once all are written).
    const saveRef = React.useRef(save);
    saveRef.current = save;
    React.useEffect(() => {
        const h = (e: Event) => {
            const d = (e as CustomEvent<SaveFilesRequest>).detail;
            if (!d) return;
            void (async () => {
                for (const p of d.paths) { const t = tabsRef.current.find((x) => x.path === p); if (t && t.content !== t.savedContent && !(await saveRef.current(p))) { d.done(false); return; } }
                d.done(true);
            })();
        };
        window.addEventListener(SAVE_FILES_EVENT, h);
        const off = handlesSaveFiles();
        return () => { off(); window.removeEventListener(SAVE_FILES_EVENT, h); };
    }, []);
    /** Close tabs without asking. */
    const forceClose = (...paths: string[]) => {
        const gone = new Set(paths);
        const rest = tabsRef.current.filter((x) => !gone.has(x.path));
        tabsRef.current = rest;
        setTabs((ts) => ts.filter((x) => !gone.has(x.path)));
        setActive((a) => (a && gone.has(a) ? rest[rest.length - 1]?.path ?? null : a));
        for (const p of paths) { void api.closeFile(p).catch(() => undefined); void api.copilotClose(p).catch(() => undefined); }
    };

    const isDirty = (path: string) => { const t = tabsRef.current.find((x) => x.path === path); return !!t && t.content !== t.savedContent; };
    /** Close tabs: the saved ones at once, then each one with unsaved edits asks (Save / Don't save / Cancel stops). */
    const close = (...paths: string[]) => {
        const dirtyOnes = paths.filter(isDirty);
        const clean = paths.filter((p) => !isDirty(p) && tabsRef.current.some((t) => t.path === p));
        if (clean.length) forceClose(...clean);
        if (dirtyOnes.length) setClosing({ path: dirtyOnes[0], saving: false, rest: dirtyOnes.slice(1) });
    };
    /** The next tab waiting to be closed, if any. */
    const closeNext = (rest: string[]) => { const next = rest.filter(isDirty); setClosing(next.length ? { path: next[0], saving: false, rest: next.slice(1) } : null); };
    const closeWithSave = async () => {
        if (!closing) return;
        const { path, rest } = closing;
        setClosing({ path, saving: true, rest });
        const ok = await save(path);
        if (!ok) { setClosing(null); return; }
        forceClose(path);
        closeNext(rest);
    };

    const goTo = async (path: string, text: string, offset: number) => {
        try {
            const r = await api.definition(path, text, offset);
            const loc = r.locations[0];
            if (!loc) { message.info('No definition found here.'); return; }
            if (loc.path.startsWith('..')) { message.info(`Defined outside this project: ${loc.path}`); return; }
            if (isLibrary(loc.path)) message.info({ key: 'cs-library', content: `${loc.path.split('/').pop()} is a library file: opened read-only.`, duration: 2.5 });
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
    const [usages, setUsages] = React.useState<{ title: string; kind: 'step' | 'symbol'; items: Array<{ path: string; line: number; column: number; text: string; definition?: boolean; write?: boolean }> } | null>(null);
    const [usagesBusy, setUsagesBusy] = React.useState(false);
    /**
     * Shift+F12 / Find usages: a step (on a feature step, or on a step definition's decorator or method line) shows
     * the feature steps that run it; anything else in TypeScript / JavaScript shows every reference to the symbol at
     * the caret across the project (page element properties, methods, classes, functions, variables).
     */
    const findUsages = async (path: string, text: string, offset: number) => {
        const isCode = langOf(path) === 'ts';
        const word = (/[\w$]+$/.exec(text.slice(0, offset))?.[0] ?? '') + (/^[\w$]*/.exec(text.slice(offset))?.[0] ?? '');
        setUsagesBusy(true);
        try {
            const r = await api.stepUsages(path, text, offset);
            setUsages({ title: `"${r.step.pattern}"`, kind: 'step', items: r.usages.map((u) => ({ path: u.path, line: u.line, column: u.column, text: `${u.keyword} ${u.text}` })) });
        } catch (e) {
            // Not a step: the language service's references (TypeScript).
            if (!isCode) { message.info(errText(e)); return; }
            if (!word) { message.info('Put the caret on a name (a method, property, class, function or variable) to find its usages.'); return; }
            try {
                setTsState((s) => (s === 'idle' ? 'starting' : s));
                const r = await api.references(path, text, offset);
                setTsState('ready');
                if (!r.locations.length) { message.info(`No usages of "${word}" found (TypeScript knows no symbol here).`); return; }
                setUsages({ title: word, kind: 'symbol', items: r.locations.filter((l) => !l.path.startsWith('..')).map((l) => ({ path: l.path, line: l.line, column: l.column, text: l.text ?? '', definition: l.definition, write: l.write })) });
            } catch (e2) { message.info(errText(e2)); return; }
        } finally { setUsagesBusy(false); }
        setBottom('usages');
    };
    const [blame, setBlame] = React.useState<{ file: string; line?: number } | null>(null);
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

    /** The file "This file" searches: the open tab (not a library file). */
    const searchFile = () => { const a = activeRef.current; return a && !isLibrary(a) ? a : null; };
    const searchSeq = React.useRef(0);
    const runSearch = async (o: SearchState = searchRef.current) => {
        // An empty query or one that fails clears the results (old results under a new query mislead).
        if (!o.q) { setFound(null); return; }
        setBottom('search');
        const file = o.scope === 'file' ? searchFile() : null;
        if (o.scope === 'file' && !file) { setFound(null); message.info('Open a file to search in it.'); return; }
        const seq = ++searchSeq.current;
        setSearching(true);
        try {
            const r = await api.textSearch(o.q, { regex: o.regex, case: o.case, word: o.word, glob: o.scope === 'file' ? undefined : o.glob || undefined,
                folder: o.scope === 'folder' ? o.folder || undefined : undefined, file: file ?? undefined, ignored: o.ignored });
            if (seq !== searchSeq.current) return;
            const open = tabsRef.current.filter((t) => !t.binary && !t.readOnly).map((t) => ({ path: t.path, content: t.content, dirty: t.content !== t.savedContent }));
            setFound({ r: withOpenTabs(r, o, open, file), for: o, file });
        } catch (e) { if (seq === searchSeq.current) { setFound(null); message.error(errText(e)); } }
        finally { if (seq === searchSeq.current) setSearching(false); }
    };
    /** × / Esc: the query and its results go (the options stay). */
    const clearSearch = () => { searchSeq.current++; setSearching(false); setFound(null); setSearch((x) => ({ ...x, q: '', replace: '' })); window.setTimeout(() => document.getElementById('cs-global-search')?.focus(), 0); };

    /**
     * Replace in files, through the editor's own save: a file open with unsaved edits is changed in its tab only
     * (one undoable edit, left unsaved); the file shown is changed in its editor (undoable) and saved; other files are
     * read, changed and saved with "changed on disk" protection (open ones show the new text). `only`: one match.
     */
    const replaceInFiles = async (o: SearchState, targets: Array<{ path: string; only?: { line: number; column: number } }>) => {
        const q = queryOf(o);
        let matches = 0, files = 0;
        const unsavedOpen: string[] = [], failed: string[] = [];
        setReplacing(true);
        // The file shown last: its change is the one Ctrl+Z there undoes first (the browser keeps one undo list for the page).
        const shownNow = activeRef.current;
        const ordered = [...targets.filter((t) => t.path !== shownNow), ...targets.filter((t) => t.path === shownNow)];
        try {
            for (const t of ordered) {
                const tab = tabsRef.current.find((x) => x.path === t.path);
                try {
                    if (tab) {
                        if (tab.readOnly || tab.binary) continue;
                        const r = replaceIn(tab.content, q, o.replace, t.only);
                        if (!r.count) continue;
                        const wasDirty = tab.content !== tab.savedContent;
                        // In the editor as one undoable edit: the file shown, and files with unsaved edits (they stay unsaved).
                        // Other open files are saved like files that are not open.
                        const ed = editors.current.get(t.path);
                        if (ed && (wasDirty || t.path === shownNow)) ed.applyEdit(r.text); else setContent(t.path, r.text);
                        matches += r.count; files++;
                        if (wasDirty) { unsavedOpen.push(t.path); continue; }
                        const saved = await api.saveFile(t.path, toDisk({ content: r.text, eol: tab.eol }), tab.hash);
                        setTabs((ts) => ts.map((x) => (x.path === t.path ? { ...x, content: r.text, savedContent: r.text, hash: saved.hash } : x)));
                    } else {
                        const f = await api.readFile(t.path);
                        if (f.binary) continue;
                        const d = fromDisk(f.content);
                        const r = replaceIn(d.content, q, o.replace, t.only);
                        if (!r.count) continue;
                        await api.saveFile(t.path, toDisk({ content: r.text, eol: d.eol }), f.hash);
                        matches += r.count; files++;
                    }
                } catch (e) { failed.push(`${t.path}: ${errText(e)}`); }
            }
        } finally { setReplacing(false); }
        // The tabs' new text is in place before the search runs again (it searches open tabs' unsaved text).
        await new Promise((r) => window.setTimeout(r, 0));
        if (matches) {
            message.success(`Replaced ${countText(matches, files)}${unsavedOpen.length ? `. ${unsavedOpen.length === 1 ? unsavedOpen[0].split('/').pop() + ' had' : `${unsavedOpen.length} open files had`} unsaved changes: changed in the editor, not saved yet` : ''}.`, unsavedOpen.length ? 6 : 3);
        } else if (!failed.length) message.info('Nothing to replace: the text changed since the search.');
        if (failed.length) modal.error({ title: `Not replaced in ${failed.length} file${failed.length === 1 ? '' : 's'}`, content: <div style={{ whiteSpace: 'pre-wrap' }}>{failed.join('\n')}</div> });
        loadFiles(); void refresh();
        void runSearch(o);
    };
    /** Replace all: asks first, with how many replacements in how many files. */
    const confirmReplaceAll = (onlyFile?: string) => {
        if (!found) return;
        const o = found.for.q === search.q ? { ...found.for, replace: search.replace, showReplace: true } : null;
        if (!o) { message.info('Search again first: the results are for another query.'); return; }
        const list = onlyFile ? found.r.files.filter((f) => f.path === onlyFile) : found.r.files;
        const n = list.reduce((a, f) => a + f.count, 0);
        if (!n) return;
        const unsaved = list.filter((f) => isDirty(f.path)).map((f) => f.path);
        modal.confirm({
            title: `Replace ${countText(n, list.length)}?`,
            okText: 'Replace all', width: 520,
            content: <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <span><span className="mono">{o.q}</span> → <span className="mono">{o.replace === '' ? '(nothing)' : o.replace}</span>{o.regex && <Typography.Text type="secondary"> (regular expression: $1, $2… are its groups)</Typography.Text>}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Files are saved at once; the file shown in the editor changes there too (Ctrl+Z undoes it){unsaved.length ? `. ${unsaved.length === 1 ? 'One open file has' : `${unsaved.length} open files have`} unsaved changes: changed in the editor only, not saved` : ''}.</Typography.Text>
                {found.r.truncated && <Alert type="warning" showIcon message="The search did not read every file (too many): narrow it to a folder to replace everywhere." />}
            </Space>,
            onOk: () => replaceInFiles(o, list.map((f) => ({ path: f.path }))),
        });
    };

    // Global shortcuts: Ctrl+P quick open, Ctrl+Shift+F search.
    React.useEffect(() => {
        const h = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : (/^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase() ?? '');
            if (mod && !e.shiftKey && letter === 'p') { e.preventDefault(); setQuick({ open: true, q: '', index: 0 }); }
            if (mod && e.shiftKey && (letter === 'f' || letter === 'h')) {
                e.preventDefault(); setBottom('search');
                if (letter === 'h') setSearch((x) => ({ ...x, showReplace: true }));
                setTimeout(() => document.getElementById(letter === 'h' && searchRef.current.q ? 'cs-global-replace' : 'cs-global-search')?.focus(), 0);
            }
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, []);

    const quickList = React.useMemo(() => {
        const q = quick.q.toLowerCase();
        const score = (p: string) => { const n = p.toLowerCase(), b = n.split('/').pop()!; if (!q) return 1; if (b.startsWith(q)) return 4; if (b.includes(q)) return 3; let i = 0; for (const c of n) if (c === q[i]) i++; return i === q.length ? 1 : 0; };
        return files.map((p) => [p, score(p)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 50).map(([p]) => p);
    }, [files, quick.q]);

    /** Delete a file or folder (asks first; a recovery copy is kept). */
    const confirmDelete = (path: string) => modal.confirm({
        title: `Delete ${path}?`, okText: 'Delete', okButtonProps: { danger: true },
        content: (() => {
            // Unsaved edits are not in the recovery copy (it holds the file as saved): said before deleting.
            const unsaved = tabsNow.current.filter((t) => (t.path === path || t.path.startsWith(path + '/')) && t.content !== t.savedContent).map((t) => t.path);
            return <>{unsaved.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`Unsaved changes in ${unsaved.length === 1 ? unsaved[0] : `${unsaved.length} open files`} are lost: the recovery copy has the saved version only.`} />}A copy of the saved file{path.includes('.') ? '' : 's'} is kept in .git/cs-studio/recovery/ in case you need it back.</>;
        })(),
        onOk: async () => { try { await api.deletePath(path); setTabs((ts) => ts.filter((t) => !(t.path === path || t.path.startsWith(path + '/')))); loadFiles(); void refresh(); } catch (e) { message.error(errText(e)); } },
    });

    /** Show a file in the tree: its folders opened, scrolled to and selected. */
    const revealInTree = (path: string) => {
        if (filter && !path.toLowerCase().includes(filter.toLowerCase())) { setFilterText(''); setFilter(''); }
        const dirs = path.split('/').slice(0, -1).map((_, i, a) => `dir:${a.slice(0, i + 1).join('/')}`);
        setExpanded((ex) => [...new Set([...ex, ...dirs])]);
        setRevealed(path);
        treeNode.current = path;
        window.setTimeout(() => treeRef.current?.scrollTo({ key: path, align: 'auto' }), 60);
    };

    /** Search in a folder only (the search's scope: "Folder"); the project's top folder is the whole project. */
    const findInFolder = (dir: string) => {
        const next: SearchState = { ...searchRef.current, scope: dir ? 'folder' : 'project', folder: dir };
        setSearch(next);
        setBottom('search', true);
        if (next.q.trim()) void runSearch(next);
        window.setTimeout(() => { const el = document.getElementById('cs-global-search') as HTMLInputElement | null; el?.focus(); el?.select(); }, 0);
    };

    const duplicate = async (path: string) => {
        const to = duplicateName(path, files);
        try { await api.copyPath(path, to); loadFiles(); void refresh(); await open(to); message.success(`Duplicated as ${to.split('/').pop()}`, 1.5); }
        catch (e) { message.error(errText(e)); }
    };

    /** The file tree's right-click menu: for a file or folder (`dir:` keys), or for empty space (null). */
    const showTreeMenu = (key: string | null, x: number, y: number) => {
        const isDir = !!key?.startsWith('dir:');
        const path = key === null ? null : isDir ? key.slice(4) : key;
        const dir = path === null ? '' : isDir ? path : path.split('/').slice(0, -1).join('/');
        const changed = status?.files ?? [];
        const fstat = path && !isDir ? changed.find((f) => f.path === path) : undefined;
        const inside = path && isDir ? changed.filter((f) => f.path.startsWith(path + '/')).map((f) => f.path) : [];
        if (key !== null) treeNode.current = key;
        ctx.show({
            x, y, label: path ? `Actions for ${path}` : 'File tree actions',
            entries: treeMenu({ path, isDir, featuresInside: isDir && path !== null ? featuresIn(files, path).length : undefined, git: path ? gitStateOf(changed, path, isDir) : null }),
            onDismiss: focusTree,
            onPick: (k) => {
                const at = dir ? `${dir}/` : '';
                const targets = isDir ? inside : path ? [path] : [];
                switch (k) {
                    case 'open': if (path) goFileRef.current(path); break;
                    case 'run': if (path) void runFrom(path); break;
                    case 'debug': if (path) void runFrom(path, undefined, true); break;
                    case 'runFolder': if (path !== null) void runFrom(featuresIn(files, path)); break;
                    case 'newFile': setDialog({ kind: 'file', path: at }); break;
                    case 'newFolder': setDialog({ kind: 'folder', path: at }); break;
                    case 'rename': if (path) setDialog({ kind: 'rename', path, base: path }); break;
                    case 'duplicate': if (path) void duplicate(path); break;
                    case 'delete': if (path) confirmDelete(path); break;
                    case 'copyName': if (path) copyText({ message }, path.split('/').pop()!, 'Name'); break;
                    case 'copyPath': if (path) copyText({ message }, path, 'Path'); break;
                    case 'copyFullPath': if (path) copyText({ message }, fullPath(repoRoot, path), 'Full path'); break;
                    case 'findInFolder': findInFolder(dir); break;
                    case 'openChanges': if (fstat) openChanges(fstat.path, areaOf(fstat)); break;
                    case 'stage': void api.stage(targets.filter((p) => { const f = changed.find((c) => c.path === p); return f && (f.untracked || f.unstaged !== '.') && !f.conflicted; })).then(() => refresh(), (e) => message.error(errText(e))); break;
                    case 'unstage': void api.unstage(targets.filter((p) => { const f = changed.find((c) => c.path === p); return f && !f.untracked && f.staged !== '.'; })).then(() => refresh(), (e) => message.error(errText(e))); break;
                    case 'discard': confirmDiscard({ modal, message }, targets.filter((p) => { const f = changed.find((c) => c.path === p); return f && (f.untracked || f.unstaged !== '.') && !f.conflicted; }), async () => { loadFiles(); await refresh(); }); break;
                    case 'history': if (path) showHistory(path); break;
                    case 'collapse': setExpanded([]); break;
                    case 'refresh': loadFiles(); break;
                }
            },
        });
    };
    /** Keys on the focused tree: F2 rename, Delete, and the menu key / Shift+F10 for the menu. */
    const onTreeKey = (e: React.KeyboardEvent) => {
        const key = treeNode.current ?? active;
        if (!key) return;
        const path = key.startsWith('dir:') ? key.slice(4) : key;
        if (e.key === 'F2') { e.preventDefault(); setDialog({ kind: 'rename', path, base: path }); return; }
        if (e.key === 'Delete') { e.preventDefault(); confirmDelete(path); return; }
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            const el = document.querySelector(`[data-tree-key="${CSS.escape(key)}"]`);
            const r = (el ?? treeBox.current)?.getBoundingClientRect();
            showTreeMenu(key, (r?.left ?? 0) + 12, (r?.bottom ?? 0));
        }
    };

    /** An editor tab's right-click menu. */
    const showTabMenu = (path: string, x: number, y: number) => {
        const paths = tabsRef.current.map((t) => t.path);
        const dirtyCount = paths.filter(isDirty).length;
        ctx.show({
            x, y, label: `Actions for the tab ${path.split('/').pop()}`,
            entries: tabMenu({ count: paths.length, index: paths.indexOf(path), dirtyCount, cleanCount: paths.length - dirtyCount, dirty: isDirty(path) }),
            onDismiss: () => editors.current.get(activeRef.current ?? '')?.focus(),
            onPick: (k) => {
                if (k === 'copyPath') { copyText({ message }, path, 'Path'); return; }
                if (k === 'reveal') { revealInTree(path); return; }
                if (k === 'save') { void save(path); return; }
                if (k === 'discard') { discardTab(path); return; }
                close(...tabsToClose(k as TabClose, tabsRef.current.map((t) => t.path), path, isDirty));
            },
        });
    };

    /** The Code page's items in the editor's right-click menu. */
    const editorMenu = (path: string, at: { line: number; offset: number; text: string }): { actions?: MenuEntry[]; file?: MenuEntry[] } => {
        const feature = path.endsWith('.feature');
        const sc = feature ? scenarioAt(at.text, at.line) : null;
        const untracked = marks.get(path) === 'U' || !files.includes(path);
        return {
            actions: feature ? [
                { key: 'runScenario', label: 'Run this scenario', disabled: !sc, onClick: () => sc && void runFrom(path, sc) },
                { key: 'debugScenario', label: 'Debug this scenario', disabled: !sc, onClick: () => sc && void runFrom(path, sc, true) },
                { key: 'runFeature', label: 'Run this feature', onClick: () => void runFrom(path) },
            ] : [],
            file: [
                { key: 'copyPath', label: 'Copy path', onClick: () => copyText({ message }, path, 'Path') },
                { key: 'copyPathLine', label: 'Copy path:line', onClick: () => copyText({ message }, `${path}:${at.line}`, 'Path and line') },
                { key: 'lineHistory', label: 'Show line history', disabled: untracked, onClick: () => setBlame({ file: path, line: at.line }) },
                { key: 'reveal', label: 'Reveal in file tree', onClick: () => revealInTree(path) },
            ],
        };
    };

    // A name Windows cannot hold (teammates' checkouts would break): said under the field, Create waits.
    const dialogProblem = dialog && dialog.path.trim() && !dialog.path.endsWith('/') ? newPathProblem(dialog.path.trim()) : null;
    const submitDialog = async () => {
        if (!dialog || dialogProblem || !dialog.path.trim() || dialog.path.endsWith('/')) return;
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
        } catch (e) {
            // Said in the dialog, next to the name (a toast would cover the tree's toolbar and cut a long name at its start).
            setDialog((d) => (d ? { ...d, error: errText(e) } : d));
        }
    };

    // ▶ Run buttons for feature files: whole feature, or one scenario (in that feature).
    const { env: disc } = useStudio();
    const starting = React.useRef(false);
    /** Run (or debug, with the breakpoints) feature files, or one scenario of a feature file. */
    const runFrom = async (target: string | string[], scenario?: { name: string; outline: boolean; alsoMatches?: string[] }, debug?: boolean) => {
        const paths = Array.isArray(target) ? target : [target];
        const path = paths[0];
        if (!path) return;
        // A double click starts one run (the second would only say that a run is already in progress).
        if (starting.current) return;
        starting.current = true;
        try {
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
        const inProjects = new Set(paths.map((p) => /^test\/([^/]+)\//.exec(p)?.[1]).filter((p): p is string => !!p && projects.includes(p)));
        if (inProjects.size > 1) { message.warning(`These features belong to ${inProjects.size} projects (${[...inProjects].join(', ')}). Run a folder inside one project.`); return; }
        const fromPath = /^test\/([^/]+)\//.exec(path)?.[1];
        const saved = loadRunTarget();
        const project = fromPath && projects.includes(fromPath) ? fromPath : saved?.project ?? projects[0];
        if (!project) { message.warning('No framework project found under config/.'); return; }
        const envs = disc?.environments[project] ?? [];
        const env = saved?.project === project && saved.env ? saved.env : saved?.env && envs.includes(saved.env) ? saved.env : envs[0] ?? 'dev';
        const dirtyOnes = paths.filter((p) => { const t = tabsRef.current.find((x) => x.path === p); return t && t.content !== t.savedContent; });
        // The framework runs the file on disk: ask before saving unsaved edits (never save silently).
        if (dirtyOnes.length) {
            const choice = await new Promise<'save' | 'disk' | 'cancel'>((resolve) => {
                const inst = modal.confirm({
                    title: dirtyOnes.length === 1 ? `${dirtyOnes[0].split('/').pop()} has unsaved changes` : `${dirtyOnes.length} files have unsaved changes`,
                    content: <>The test runs the file as saved on disk.
                        <div style={{ marginTop: 12 }}><Button size="small" onClick={() => { resolve('disk'); inst.destroy(); }}>Run the saved version (keep my edits unsaved)</Button></div></>,
                    okText: 'Save and run', cancelText: 'Cancel',
                    onOk: () => resolve('save'), onCancel: () => resolve('cancel'),
                });
            });
            if (choice === 'cancel') return;
            if (choice === 'save') for (const p of dirtyOnes) if (!(await save(p))) return;
        }
        try {
            const run = await api.startRun({
                project, env, features: paths, browser: saved?.browser, headless: saved?.headless, workers: 1,
                ...(scenario ? (scenario.outline ? { scenario: scenario.name } : { scenarios: [scenario.name] }) : {}),
                // Debugging: the breakpoints, and a pause when a step fails (the browser shown)
                ...(debug ? { debug: { pauseOnFailure: true } } : {}),
            });
            saveRunTarget({ ...(saved ?? {}), project, env });
            if (debug) setBottom('debug'); else showRun(run.id);
        } catch (e) { message.error(errText(e)); }
        } finally { starting.current = false; }
    };
    const gutterActions = React.useMemo(() => {
        if (!cur || !cur.path.endsWith('.feature')) return undefined;
        const acts: Array<{ line: number; title: string; onClick: () => void }> = [];
        const lines = cur.content.split(/\r?\n/);
        lines.forEach((l, i) => {
            if (/^\s*Feature:/.test(l)) acts.push({ line: i + 1, title: 'Run this feature', onClick: () => void runFrom(cur.path) });
            const sc = scenarioRef(lines, i);
            if (sc) acts.push({ line: i + 1, title: `Run "${sc.name}"`, onClick: () => void runFrom(cur.path, sc) });
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
        editorMenu,
    };
    openRef.current = open;
    treeMenuRef.current = showTreeMenu;
    treeKeyRef.current = onTreeKey;
    tabMenuRef.current = showTabMenu;

    // The file tree does not depend on the text being typed: keep it out of the per-keystroke render.
    const treePanel = React.useMemo(() => (
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
                <div style={{ padding: 6, display: 'flex', gap: 4, borderBottom: '1px solid var(--panel-border)' }}>
                    <Input size="small" allowClear placeholder="Filter files" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
                    <Tooltip title="New file"><Button aria-label="New file" size="small" type="text" icon={<FileAddOutlined />} onClick={() => setDialog({ kind: 'file', path: '' })} /></Tooltip>
                    <Tooltip title="New folder"><Button aria-label="New folder" size="small" type="text" icon={<FolderAddOutlined />} onClick={() => setDialog({ kind: 'folder', path: '' })} /></Tooltip>
                    <Tooltip title="Refresh"><Button aria-label="Refresh" size="small" type="text" icon={<ReloadOutlined />} onClick={loadFiles} /></Tooltip>
                </div>
                <div ref={treeBox} className="code-tree" style={{ flex: 1, overflow: 'hidden', padding: '4px 0', minHeight: 0 }}
                    onContextMenu={(e) => {
                        // Empty space (a node has its own menu: onRightClick below).
                        e.preventDefault();
                        if (!(e.target as HTMLElement).closest('.ant-tree-treenode')) treeMenuRef.current(null, e.clientX, e.clientY);
                    }}>
                    {files.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description="No files" />
                        : filterText.trim() && !tree.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} description={`No file matches "${filterText.trim()}"`} /> : (
                        <Tree.DirectoryTree ref={treeRef as never} treeData={tree} height={treeHeight} virtual selectedKeys={revealed ? [revealed] : active ? [active] : []} expandedKeys={filterOpen ?? expanded}
                            onExpand={(k) => setExpanded(k)} expandAction="click" aria-label="Files"
                            onSelect={(keys) => { const k = String(keys[0] ?? ''); setRevealed(null); if (k && !k.startsWith('dir:')) goFileRef.current(k); }}
                            onClick={(_, n) => { treeNode.current = String(n.key); if (!n.isLeaf) focusTree(); }}
                            onActiveChange={(k) => { if (k !== null && k !== undefined) treeNode.current = String(k); }}
                            onRightClick={({ event, node }) => { event.preventDefault(); treeMenuRef.current(String(node.key), event.clientX, event.clientY); }}
                            onKeyDown={(e) => treeKeyRef.current(e)}
                            icon={(p: { isLeaf?: boolean }) => p.isLeaf ? <FileOutlined /> : <FolderOutlined />} />
                    )}
                </div>
            </div>
    ), [filterText, files.length, tree, active, expanded, loadFiles, filterOpen, treeHeight, revealed]);
    // The open file is shown in the tree when it changes (another tab, a jump to a definition, a search result),
    // never again on its own: scrolling the tree, or anything else re-drawing the screen, leaves the tree where it is.
    // (The tree's "active" row is not handed back to it: the tree scrolls to that row whenever it differs from its
    // own, e.g. after the tree lost focus, which pulled the tree back to the open file on every update.)
    const filesRef = React.useRef(files);
    filesRef.current = files;
    React.useEffect(() => {
        if (!active || !filesRef.current.includes(active)) return;
        const t = window.setTimeout(() => treeRef.current?.scrollTo({ key: active, align: 'auto' }), 60);
        return () => window.clearTimeout(t);
    }, [active]);

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
                            <div onContextMenu={(e) => {
                                const tab = (e.target as HTMLElement).closest('[data-node-key]');
                                if (!tab) return;
                                e.preventDefault();
                                tabMenuRef.current(tab.getAttribute('data-node-key')!, e.clientX, e.clientY);
                            }} onKeyDown={(e) => {
                                // The menu key / Shift+F10 on a focused tab: its menu.
                                if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
                                const tab = (e.target as HTMLElement).closest('[data-node-key]');
                                if (!tab) return;
                                e.preventDefault();
                                const r = tab.getBoundingClientRect();
                                tabMenuRef.current(tab.getAttribute('data-node-key')!, r.left + 8, r.bottom);
                            }}>
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
                                        <Tooltip title="Who last changed each line (git blame)"><Button size="small" type="text" icon={<UserOutlined />} aria-label="Who changed this file" onClick={() => setBlame({ file: cur.path })} /></Tooltip>
                                        {dirty(cur) && <Tooltip title="Throw away the changes made here since the last save"><Button size="small" icon={<UndoOutlined />} onClick={() => discardTab(cur.path)}>Discard</Button></Tooltip>}
                                        <Tooltip title="Save (Ctrl+S)"><Button size="small" icon={<SaveOutlined />} disabled={!dirty(cur)} onClick={() => void save(cur.path)}>Save</Button></Tooltip>
                                    </Space>
                                ) : null}
                                items={tabs.map((t) => {
                                    const name = t.path.split('/').pop()!;
                                    // Same file name open twice: show the folder too.
                                    const twin = tabs.some((o) => o !== t && o.path.split('/').pop() === name);
                                    const dir = t.path.split('/').slice(-2, -1)[0];
                                    return { key: t.path, label: <Tooltip title={t.readOnly ? `${t.path} (library file, read-only)` : t.path}><span>{t.readOnly && <LockOutlined aria-label="read-only" style={{ marginRight: 4, fontSize: 11 }} />}{name}{twin && dir && <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>{t.path.split('/').slice(-3, -1).join('/')}</Typography.Text>}{dirty(t) && <Badge status="processing" style={{ marginLeft: 6 }} />}</span></Tooltip>, closable: true };
                                })} />
                            </div>
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
                    <Tabs size="small" activeKey={bottom} onChange={(k) => setBottom(k as BottomTab, true)} style={{ paddingInline: 8, marginBottom: 0 }}
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
                            !usages ? <Typography.Text type="secondary">{usagesBusy ? <><LoadingOutlined style={{ marginRight: 6 }} />Finding usages…</> : <>Put the caret on a name and press <Typography.Text keyboard>Shift</Typography.Text>+<Typography.Text keyboard>F12</Typography.Text> (or right-click, Find usages): for a step (in a feature or a step file) the feature steps that use it; for anything in TypeScript (a page element such as <span className="mono">usernameField</span>, a method, class, function or variable) every place in the project that uses it.</>}</Typography.Text> : (
                                <Space direction="vertical" style={{ width: '100%' }} size={2} className="cs-usages">
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{usagesBusy && <LoadingOutlined style={{ marginRight: 6 }} />}{usages.items.length} usage{usages.items.length === 1 ? '' : 's'} of <span className="mono">{usages.title}</span> in {new Set(usages.items.map((u) => u.path)).size} file{new Set(usages.items.map((u) => u.path)).size === 1 ? '' : 's'}{usages.kind === 'step' ? ' (feature steps that run it)' : ''}</Typography.Text>
                                    {groupByFile(usages.items).map((g) => (
                                        <div key={g.path} className="cs-result-group">
                                            <div className="cs-result-file" title={g.path}><FileOutlined style={{ marginRight: 6 }} /><span className="mono">{g.path}</span><Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{g.items.length}</Typography.Text>{isLibrary(g.path) && <Tag style={{ marginLeft: 8 }}>library</Tag>}</div>
                                            {g.items.map((u, i) => (
                                                <div key={i} className="file-row cs-result-row" onClick={() => goFile(u.path, u.line, u.column)}>
                                                    <Typography.Text className="mono" type="secondary" style={{ flex: 'none', minWidth: 44, textAlign: 'right' }}>{u.line}</Typography.Text>
                                                    <span className="name mono">{u.text.trim()}</span>
                                                    {u.definition && <Tag color="blue" style={{ marginLeft: 6 }}>definition</Tag>}
                                                    {u.write && !u.definition && <Tag style={{ marginLeft: 6 }}>written</Tag>}
                                                </div>))}
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
                            <SearchPanel search={search} setSearch={setSearch} found={found} searching={searching} replacing={replacing}
                                activeFile={cur && !cur.readOnly ? cur.path : null} folderOfActive={cur ? cur.path.split('/').slice(0, -1).join('/') : ''}
                                onSearch={(o) => void runSearch(o)} onClear={clearSearch} onOpen={(h) => goFile(h.path, h.line, h.column)}
                                onReplaceOne={(h) => found && void replaceInFiles({ ...found.for, replace: search.replace, showReplace: true }, [{ path: h.path, only: { line: h.line, column: h.column } }])}
                                onReplaceAll={confirmReplaceAll} />
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
            {blame && <BlameView file={blame.file} line={blame.line} onClose={() => setBlame(null)} />}
            {ctx.element}
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
                    <Button key="discard" danger disabled={closing?.saving} onClick={() => { const { path: p, rest } = closing!; forceClose(p); closeNext(rest); }}>Don't save</Button>,
                    <Button key="save" type="primary" loading={closing?.saving} onClick={() => void closeWithSave()}>Save</Button>,
                ]}>
                <Typography.Paragraph>Your changes are lost if you don't save them.</Typography.Paragraph>
                {closing && closing.rest.length > 0 && <Typography.Paragraph type="secondary">{closing.rest.length} more file{closing.rest.length === 1 ? '' : 's'} with unsaved changes after this one. Cancel keeps {closing.rest.length === 1 ? 'it' : 'them'} open.</Typography.Paragraph>}
            </Modal>
            <Modal open={!!dialog} title={dialog?.kind === 'file' ? 'New file' : dialog?.kind === 'folder' ? 'New folder' : 'Rename'} okText={dialog?.kind === 'rename' ? 'Rename' : 'Create'}
                onCancel={() => setDialog(null)} onOk={submitDialog} okButtonProps={{ disabled: !dialog?.path.trim() || dialog.path.endsWith('/') || !!dialogProblem }}
                afterOpenChange={(o) => { if (o) { const el = document.getElementById('cs-code-path-input') as HTMLInputElement | null; el?.focus(); const v = el?.value ?? ''; el?.setSelectionRange(v.length, v.length); } }}>
                <Input id="cs-code-path-input" autoFocus className="mono" value={dialog?.path} onChange={(e) => dialog && setDialog({ ...dialog, path: e.target.value, error: undefined })} onPressEnter={submitDialog}
                    status={dialogProblem || dialog?.error ? 'error' : undefined} aria-invalid={!!(dialogProblem || dialog?.error)} aria-describedby="cs-code-path-problem"
                    placeholder={dialog?.kind === 'file' ? 'test/orders/features/search.feature' : 'test/orders/pages'} />
                {(dialogProblem || dialog?.error) && <Typography.Text id="cs-code-path-problem" type="danger" role="alert" style={{ display: 'block', marginTop: 6, overflowWrap: 'anywhere' }}>{dialogProblem ?? dialog?.error}</Typography.Text>}
                <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>Path inside the project. Folders in the path are created as needed.</Typography.Paragraph>
            </Modal>
        </>
    );
}
