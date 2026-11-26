/**
 * The Studio's own right-click menus (editor text, file tree, editor tabs, Source control changes):
 * which items each shows, in which order, and when one is disabled. Plain functions (no React), so the
 * rules are tested on their own; the components only say what each key does.
 */

export interface MenuAction {
    key: string;
    label: string;
    /** Shown on the right, e.g. "F12". */
    shortcut?: string;
    disabled?: boolean;
    danger?: boolean;
    /** Done when picked; without it the menu's owner handles the key. */
    onClick?: () => void;
}
export type MenuEntry = MenuAction | 'divider';

/** Dividers only between groups: none at the start or end, never two in a row. */
export function tidy(entries: Array<MenuEntry | null | undefined | false>): MenuEntry[] {
    const out: MenuEntry[] = [];
    for (const e of entries) {
        if (!e) continue;
        if (e === 'divider' && (!out.length || out[out.length - 1] === 'divider')) continue;
        out.push(e);
    }
    while (out[out.length - 1] === 'divider') out.pop();
    return out;
}

// ------------------------------------------------------------------ editor text
export interface EditorMenuState {
    readOnly: boolean;
    hasSelection: boolean;
    canDefinition: boolean;
    canUsages: boolean;
    canRename: boolean;
    canComment: boolean;
    canFormat: boolean;
    /** Breakpoints can be set in this file (undefined: the item is not shown). */
    breakpoint?: { allowed: boolean; has: boolean };
}

/** The editor's own items, with the page's items (run/debug, file) put in their places. */
export function editorMenu(s: EditorMenuState, page: { actions?: MenuEntry[]; file?: MenuEntry[] } = {}): MenuEntry[] {
    const ro = s.readOnly;
    return tidy([
        { key: 'definition', label: 'Go to definition', shortcut: 'F12', disabled: !s.canDefinition },
        { key: 'usages', label: 'Find usages', shortcut: 'Shift+F12', disabled: !s.canUsages },
        { key: 'rename', label: 'Rename step', shortcut: 'F2', disabled: ro || !s.canRename },
        'divider',
        ...(page.actions ?? []),
        s.breakpoint && { key: 'breakpoint', label: s.breakpoint.has ? 'Remove breakpoint on this line' : 'Toggle breakpoint on this line', disabled: !s.breakpoint.allowed && !s.breakpoint.has },
        'divider',
        { key: 'cut', label: 'Cut', shortcut: 'Ctrl+X', disabled: ro || !s.hasSelection },
        { key: 'copy', label: 'Copy', shortcut: 'Ctrl+C', disabled: !s.hasSelection },
        { key: 'paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: ro },
        { key: 'selectAll', label: 'Select all', shortcut: 'Ctrl+A' },
        'divider',
        { key: 'comment', label: 'Toggle comment', shortcut: 'Ctrl+/', disabled: ro || !s.canComment },
        { key: 'format', label: 'Format document', shortcut: 'Shift+Alt+F', disabled: ro || !s.canFormat },
        { key: 'find', label: 'Find', shortcut: 'Ctrl+F' },
        { key: 'replace', label: 'Replace', shortcut: 'Ctrl+H', disabled: ro },
        { key: 'gotoLine', label: 'Go to line', shortcut: 'Ctrl+G' },
        'divider',
        ...(page.file ?? []),
    ]);
}

const SCENARIO = /^\s*(Scenario Outline|Scenario Template|Scenario|Example):\s*(.+?)\s*$/;

export interface ScenarioRef { name: string; outline: boolean; line: number; alsoMatches: string[] }

/**
 * The scenario a line of a feature file belongs to (its own heading, or the nearest one above), with the
 * other scenarios the framework's name matching would run too. Null outside a scenario, or when the
 * name holds a comma (the framework would split it into two names).
 */
export function scenarioAt(text: string, line: number): ScenarioRef | null {
    const lines = text.split(/\r?\n/);
    for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
        if (/^\s*(Feature|Background|Rule):/.test(lines[i])) return null;
        const m = SCENARIO.exec(lines[i]);
        if (m) return scenarioRef(lines, i);
    }
    return null;
}

/** The scenario whose heading is on line index `i` (0-based). */
export function scenarioRef(lines: string[], i: number): ScenarioRef | null {
    const m = SCENARIO.exec(lines[i] ?? '');
    if (!m || m[2].includes(',')) return null;
    const outline = m[1] !== 'Scenario' && m[1] !== 'Example';
    const names = lines.map((l) => SCENARIO.exec(l)?.[2]).filter((n): n is string => !!n);
    // --scenario: name contains it; --scenarios: either name contains the other (CSBDDRunner).
    const me = m[2].toLowerCase();
    const alsoMatches = names.filter((n) => n !== m[2] && (n.toLowerCase().includes(me) || (!outline && me.includes(n.toLowerCase()))));
    return { name: m[2], outline, line: i + 1, alsoMatches };
}

// ------------------------------------------------------------------ file tree
export interface GitState { staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean; deleted: boolean }

export interface TreeMenuState {
    /** A file or folder (repository-relative); null: empty space in the tree. */
    path: string | null;
    isDir: boolean;
    /** Feature files in this folder (any depth), for folders. */
    featuresInside?: number;
    /** Git state of the file, or of the changed files inside a folder (combined); null: no change. */
    git?: GitState | null;
}

export function treeMenu(s: TreeMenuState): MenuEntry[] {
    if (s.path === null) {
        return [
            { key: 'newFile', label: 'New file…' }, { key: 'newFolder', label: 'New folder…' }, 'divider',
            { key: 'collapse', label: 'Collapse all' }, { key: 'refresh', label: 'Refresh' },
        ];
    }
    const g = s.git;
    const feature = !s.isDir && s.path.endsWith('.feature');
    return tidy([
        !s.isDir && { key: 'open', label: 'Open' },
        'divider',
        feature && { key: 'run', label: 'Run this feature' },
        feature && { key: 'debug', label: 'Debug this feature' },
        s.isDir && (s.featuresInside ?? 0) > 0 && { key: 'runFolder', label: `Run all features in this folder (${s.featuresInside})` },
        'divider',
        { key: 'newFile', label: 'New file…' },
        { key: 'newFolder', label: 'New folder…' },
        { key: 'rename', label: 'Rename…', shortcut: 'F2' },
        !s.isDir && { key: 'duplicate', label: 'Duplicate' },
        { key: 'delete', label: 'Delete…', shortcut: 'Delete', danger: true },
        'divider',
        { key: 'copyName', label: 'Copy name' },
        { key: 'copyPath', label: 'Copy relative path' },
        { key: 'copyFullPath', label: 'Copy full path' },
        'divider',
        { key: 'findInFolder', label: 'Find in folder' },
        'divider',
        g && !s.isDir && { key: 'openChanges', label: g.conflicted ? 'Resolve conflict' : 'Open changes' },
        g && (g.unstaged || g.untracked) && !g.conflicted && { key: 'stage', label: 'Stage' },
        g && g.staged && !g.conflicted && { key: 'unstage', label: 'Unstage' },
        g && (g.unstaged || g.untracked) && !g.conflicted && { key: 'discard', label: 'Discard changes…', danger: true },
        // History: also for files with no change (anything Git knows about); not for a new file.
        !(g?.untracked && !s.isDir) && { key: 'history', label: s.isDir ? 'Show folder history' : 'Show file history' },
        'divider',
        s.isDir && { key: 'collapse', label: 'Collapse all' },
    ]);
}

/** "name copy.ext", then "name copy 2.ext", … — a name not in `taken`. */
export function duplicateName(path: string, taken: Iterable<string>): string {
    const have = new Set(taken);
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash + 1);
    const base = path.slice(slash + 1);
    // The extension starts at the last dot that is not the first character (".env" has none).
    const dot = base.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
    for (let n = 1; ; n++) {
        const cand = `${dir}${stem} copy${n === 1 ? '' : ' ' + n}${ext}`;
        if (!have.has(cand)) return cand;
    }
}

/** Feature files at any depth in a folder ('' is the whole repository). */
export function featuresIn(files: string[], dir: string): string[] {
    const pre = dir ? dir.replace(/\/+$/, '') + '/' : '';
    return files.filter((f) => f.startsWith(pre) && f.endsWith('.feature'));
}

/** Combined Git state of the changed files at or inside `path`, or null when nothing there changed. */
export function gitStateOf(files: Array<{ path: string; staged: string; unstaged: string; untracked: boolean; conflicted: boolean }>, path: string, isDir: boolean): GitState | null {
    const mine = files.filter((f) => (isDir ? f.path.startsWith(path.replace(/\/+$/, '') + '/') : f.path === path));
    if (!mine.length) return null;
    return {
        staged: mine.some((f) => !f.untracked && f.staged !== '.' && f.staged !== '?'),
        unstaged: mine.some((f) => !f.untracked && f.unstaged !== '.'),
        untracked: mine.some((f) => f.untracked),
        conflicted: mine.some((f) => f.conflicted),
        deleted: mine.every((f) => f.unstaged === 'D' || (f.staged === 'D' && f.unstaged === '.')),
    };
}

/** The search's "Only in" filter for a folder (a git pathspec: everything below it). */
export function folderGlob(dir: string): string {
    const d = dir.replace(/\/+$/, '');
    return d ? `${d}/` : '';
}

/** The area a changed file shows in on Source control's Changes list (unstaged changes first, as the list shows them). */
export function areaOf(f: { staged: string; unstaged: string; untracked: boolean; conflicted: boolean }): 'staged' | 'changes' | 'conflict' {
    if (f.conflicted) return 'conflict';
    if (f.untracked || f.unstaged !== '.') return 'changes';
    return 'staged';
}

/** The full path on disk, in the repository's own separator style. */
export function fullPath(repoRoot: string, rel: string): string {
    if (!repoRoot) return rel;
    const win = repoRoot.includes('\\') && !repoRoot.includes('/');
    const root = repoRoot.replace(/[\\/]+$/, '');
    return win ? `${root}\\${rel.replace(/\//g, '\\')}` : `${root}/${rel}`;
}

// ------------------------------------------------------------------ editor tabs
export type TabClose = 'close' | 'others' | 'right' | 'saved' | 'all';

export function tabMenu(s: { count: number; index: number; dirtyCount: number; cleanCount: number }): MenuEntry[] {
    return [
        { key: 'close', label: 'Close' },
        { key: 'others', label: 'Close others', disabled: s.count < 2 },
        { key: 'right', label: 'Close to the right', disabled: s.index >= s.count - 1 },
        { key: 'saved', label: 'Close saved', disabled: s.cleanCount === 0 },
        { key: 'all', label: 'Close all' },
        'divider',
        { key: 'copyPath', label: 'Copy path' },
        { key: 'reveal', label: 'Reveal in file tree' },
    ];
}

/** The open tabs a close command closes, in tab order. */
export function tabsToClose(kind: TabClose, paths: string[], target: string, dirty: (p: string) => boolean): string[] {
    const i = paths.indexOf(target);
    switch (kind) {
        case 'close': return i < 0 ? [] : [target];
        case 'others': return paths.filter((p) => p !== target);
        case 'right': return i < 0 ? [] : paths.slice(i + 1);
        case 'saved': return paths.filter((p) => !dirty(p));
        case 'all': return [...paths];
    }
}

// ------------------------------------------------------------------ Source control changes
export function changesMenu(s: { area: 'staged' | 'changes' | 'conflict'; onDisk: boolean; untracked: boolean }): MenuEntry[] {
    return tidy([
        { key: 'open', label: 'Open file', disabled: !s.onDisk },
        { key: 'openChanges', label: s.area === 'conflict' ? 'Resolve conflict' : 'Open changes' },
        'divider',
        s.area === 'staged' ? { key: 'unstage', label: 'Unstage' } : { key: 'stage', label: 'Stage', disabled: s.area === 'conflict' },
        { key: 'discard', label: 'Discard changes…', danger: true, disabled: s.area !== 'changes' },
        'divider',
        { key: 'copyPath', label: 'Copy path' },
        { key: 'history', label: 'Show history', disabled: s.untracked },
    ]);
}
