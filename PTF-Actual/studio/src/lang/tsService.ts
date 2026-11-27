/**
 * TypeScript/JavaScript intelligence for the editor, using the TypeScript compiler's own
 * LanguageService: errors as you type, completions, hover info, go to definition, find references
 * and formatting. Prefers the project's own `typescript` (same version its build uses) and its
 * tsconfig.json; unsaved editor buffers are included, so results match what the user sees.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as TS from 'typescript';

type TsModule = typeof TS;

/**
 * Always the Studio's own TypeScript. Loading the repository's node_modules/typescript would run
 * code from the repository inside the Studio process (which can read the secret store) as soon as
 * a file is opened — the same reason VS Code asks before using a "workspace TypeScript version".
 */
function loadTypeScript(_root: string): { ts: TsModule; source: 'project' | 'studio' } {
    return { ts: require('typescript') as TsModule, source: 'studio' };
}

/** A call that gave way (the host's cancellation token): passed on, never taken for an empty answer. */
const isCancel = (e: unknown) => !!e && typeof e === 'object' && (e as { constructor?: { name?: string } }).constructor?.name === 'OperationCanceledException';
function safe<T>(f: () => T, fallback: T): T {
    try { return f(); } catch (e) { if (isCancel(e)) throw e; return fallback; }
}

const isInside = (root: string, p: string) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

type PathImpl = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;
/**
 * The key a file is known by, whatever spelling TypeScript or the editor uses for it: TypeScript
 * writes "C:/repo/a.ts", the Studio "C:\\repo\\a.ts" (one backslash each), and on Windows (and macOS) the
 * drive letter or a folder may differ in case ("c:\\Repo"). One key for all, so the editor's unsaved text is the one
 * TypeScript checks (a miss on Windows means the file on disk, with CRLF line ends, against the editor's
 * offsets, and go to definition lands beside the word).
 */
export function fileKey(p: string, caseSensitive: boolean, impl: PathImpl = path): string {
    const k = impl.resolve(p);
    return caseSensitive ? k : k.toLowerCase();
}
/**
 * A file TypeScript names (forward slashes, any case of the drive letter) as a repository path
 * ("test/pages/Login.ts"), or a path starting with "../" for files outside the repository.
 * `links`: folders inside the repository that are links elsewhere (npm link, pnpm), real path → path in the
 * repository, so a definition in a linked package opens under node_modules/ instead of outside the project.
 */
export function repoPathOf(root: string, fileName: string, caseSensitive: boolean, impl: PathImpl = path, links: Array<[string, string]> = []): string {
    let abs = impl.resolve(fileName);
    const inside = (r: string, p: string) => { const x = impl.relative(r, p); return !!x && !x.startsWith('..') && !impl.isAbsolute(x); };
    const same = (a: string, b: string) => (caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase());
    if (!inside(root, abs)) {
        for (const [real, link] of links) {
            const r = impl.resolve(real);
            if (same(r, abs) || inside(r, abs)) { abs = impl.resolve(link, impl.relative(r, abs)); break; }
        }
    }
    let rel = impl.relative(root, abs);
    // Another drive (Windows): relative() gives the absolute path; still a path outside the project.
    if (impl.isAbsolute(rel)) return '../' + rel.split(impl.sep).join('/').split('\\').join('/');
    // path.relative compares case-insensitively only on Windows; elsewhere (macOS) a case-only difference in the root is fixed here.
    if (!caseSensitive && rel.startsWith('..')) {
        const r = impl.resolve(root);
        if (abs.toLowerCase().startsWith(r.toLowerCase() + impl.sep)) rel = abs.slice(r.length + 1);
    }
    return rel.split(impl.sep).join('/').split('\\').join('/');
}

export interface TsDiagnostic { line: number; column: number; endLine: number; endColumn: number; message: string; severity: 'error' | 'warning' | 'info'; code: number }
export interface TsCompletion {
    name: string; kind: string; sortText: string; insertText?: string;
    /** insertText is a snippet ($1, ${1:name}, $0). */
    isSnippet?: boolean;
    /** What the insertion replaces (offset and length), when it is not just the word before the caret. */
    replace?: { start: number; length: number };
    /** Accepting also changes something else (e.g. adds an import): see completionDetails. */
    hasAction?: boolean;
    /** For completionDetails (auto-import entries). */
    source?: string; data?: unknown;
    kindModifiers?: string;
}
export interface TsCompletionDetails {
    /** The signature or type, e.g. "(method) String.replace(searchValue: string | RegExp, replaceValue: string): string". */
    detail: string;
    doc: string;
    /** For a method or function: the call as a snippet, e.g. "replace(${1:searchValue}, ${2:replaceValue})". */
    snippet?: string;
    /** Other edits in this file that go with the completion (e.g. an import), as offsets. */
    edits?: Array<{ start: number; length: number; newText: string }>;
}
export interface TsSignatureHelp {
    signatures: Array<{ label: string; params: Array<[number, number]>; doc: string; paramDocs: string[] }>;
    active: number;
    param: number;
    /** Where the argument list starts (the "(" + 1): the hint stays while the caret is inside. */
    start: number;
}

const CALLABLE = new Set(['method', 'function', 'local function']);

/**
 * The call snippet for a method or function from its signature's display parts, like VS Code's
 * "complete function calls": the required parameters as placeholders, e.g. "replace(${1:searchValue}, ${2:replaceValue})";
 * none required: the caret between the parentheses ("toUpperCase($0)").
 */
export function callSnippet(name: string, parts: ReadonlyArray<{ text: string; kind: string }>): string {
    const params: string[] = [];
    let depth = 0, inName = false, done = false;
    for (let i = 0; i < parts.length && !done; i++) {
        const p = parts[i];
        switch (p.kind) {
            case 'methodName': case 'functionName': case 'text': case 'propertyName': case 'localName': case 'aliasName':
                if (p.text === name && depth === 0) inName = true;
                break;
            case 'parameterName':
                if (depth === 1 && inName) {
                    const next = parts[i + 1], prev = parts[i - 1];
                    const optional = next?.text === '?' || prev?.text === '...';
                    if (optional) { done = true; break; }
                    if (p.text !== 'this') params.push(p.text);
                }
                break;
            case 'punctuation':
                if (p.text === '(') depth++;
                else if (p.text === ')') { depth--; if (depth <= 0 && inName) done = true; }
                else if (p.text === '=>' || p.text === ':') { /* a type: ignore */ }
                break;
        }
    }
    const esc = (t: string) => t.replace(/[$}\\]/g, '\\$&');
    const snipName = esc(name);
    return params.length ? `${snipName}(${params.map((x, i) => `\${${i + 1}:${esc(x)}}`).join(', ')})$0` : `${snipName}($0)`;
}
export interface TsLocation { path: string; line: number; column: number; endLine: number; endColumn: number; text?: string }

/**
 * The editor's text as a snapshot that tells TypeScript what changed since the previous one (one
 * range: the common start and end are kept), so only that part of the file is parsed again.
 */
let snapIds = 0;
const SNAP_ID = new WeakMap<object, number>();
function editSnapshot(ts: TsModule, text: string, prev: TS.IScriptSnapshot | undefined): TS.IScriptSnapshot {
    const base = ts.ScriptSnapshot.fromString(text);
    // Only the previous text and its id are kept (not the previous snapshot: that would chain them all).
    const prevId = prev ? SNAP_ID.get(prev) : undefined;
    const prevText = prev ? prev.getText(0, prev.getLength()) : undefined;
    const snap: TS.IScriptSnapshot = {
        getText: (s, e) => base.getText(s, e),
        getLength: () => base.getLength(),
        getChangeRange: (old) => {
            if (prevId === undefined || prevText === undefined || SNAP_ID.get(old) !== prevId) return undefined;
            const a = prevText, b = text, max = Math.min(a.length, b.length);
            let i = 0;
            while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
            let j = 0;
            while (j < max - i && a.charCodeAt(a.length - 1 - j) === b.charCodeAt(b.length - 1 - j)) j++;
            return ts.createTextChangeRange(ts.createTextSpan(i, a.length - i - j), b.length - i - j);
        },
    };
    SNAP_ID.set(snap, ++snapIds);
    return snap;
}

export class TsService {
    readonly ts: TsModule;
    readonly tsSource: 'project' | 'studio';
    private readonly service: TS.LanguageService;
    /** The editor's texts, by fileKey (name: the spelling the Studio uses, given to TypeScript). */
    private readonly overlays = new Map<string, { name: string; text: string; version: number; snap: TS.IScriptSnapshot }>();
    private readonly caseSensitive: boolean;
    private readonly key = (f: string) => fileKey(f, this.caseSensitive);
    /** Package folders under node_modules that are links (real path → path in the repository), found on first use. */
    private linkMap: Array<[string, string]> | null = null;
    private resolutionCache: TS.ModuleResolutionCache | null = null;
    private fallbackCache: TS.ModuleResolutionCache | null = null;
    /** Files on disk: their version (mtime), checked at most every DISK_CHECK_MS, and their text per version. */
    private readonly stats = new Map<string, { at: number; version: string }>();
    private readonly snaps = new Map<string, { version: string; snap: TS.IScriptSnapshot }>();
    private names: string[] | null = null;
    private namesFor = -1;
    private cancel: TS.HostCancellationToken = { isCancellationRequested: () => false };
    static DISK_CHECK_MS = 2000;
    private readonly options: TS.CompilerOptions;
    private fileNames: string[];
    private readonly fileSet: Set<string>;
    readonly configPath: string | null;
    /** tsconfig files this project references (`references` in tsconfig.json), inside the repository. */
    readonly projectReferences: string[] = [];
    /** Problems reading tsconfig.json itself. */
    private readonly configErrors: readonly TS.Diagnostic[] = [];

    /**
     * @param configPath the tsconfig.json to use; undefined = the one in `root` (if any); null = none.
     */
    constructor(private readonly root: string, configPath?: string | null) {
        const { ts, source } = loadTypeScript(root);
        this.ts = ts;
        this.tsSource = source;
        this.caseSensitive = ts.sys.useCaseSensitiveFileNames;
        this.configPath = configPath === undefined ? (fs.existsSync(path.join(root, 'tsconfig.json')) ? path.join(root, 'tsconfig.json') : null) : configPath;
        if (this.configPath && isInside(root, this.configPath)) {
            const errors: TS.Diagnostic[] = [];
            const parsed = ts.getParsedCommandLineOfConfigFile(this.configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { errors.push(d); } });
            // allowJs: a .js file opened in the editor is part of the program, so it gets completions
            // and errors like in VS Code (checkJs stays as the project set it).
            this.options = { ...(parsed?.options ?? {}), allowJs: true, noEmit: true };
            this.fileNames = parsed?.fileNames ?? [];
            this.configErrors = [...errors, ...(parsed?.errors ?? [])];
            for (const r of parsed?.projectReferences ?? []) {
                const ref = ts.resolveProjectReferencePath(r);
                if (isInside(root, ref) && fs.existsSync(ref)) this.projectReferences.push(ref);
            }
        } else {
            this.configPath = null;
            // Sensible defaults for a framework project without tsconfig (decorators are used for steps).
            this.options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, allowJs: true, skipLibCheck: true, strict: false };
            this.fileNames = [];
        }
        this.fileSet = new Set(this.fileNames.map((f) => this.key(f)));
        const legacyResolution = (() => {
            // As TypeScript picks it: set, or from "module" (commonjs and older: node10; node16/nodenext: their own).
            const o = this.options;
            const kind = o.moduleResolution ?? (o.module === ts.ModuleKind.Node16 ? ts.ModuleResolutionKind.Node16 : o.module === ts.ModuleKind.NodeNext ? ts.ModuleResolutionKind.NodeNext
                : o.module === ts.ModuleKind.Preserve ? ts.ModuleResolutionKind.Bundler
                : (o.module === undefined || o.module === ts.ModuleKind.CommonJS || o.module === ts.ModuleKind.None) ? ts.ModuleResolutionKind.Node10 : ts.ModuleResolutionKind.Classic);
            return kind === ts.ModuleResolutionKind.Node10 || kind === ts.ModuleResolutionKind.Classic;
        })();
        const moduleHost: TS.ModuleResolutionHost = {
            fileExists: (f) => this.overlays.has(this.key(f)) || ts.sys.fileExists(f),
            readFile: (f) => this.overlays.get(this.key(f))?.text ?? ts.sys.readFile(f),
            directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
            useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames, getCurrentDirectory: () => root,
        };
        const canon = (f: string) => (this.caseSensitive ? f : f.toLowerCase());
        /**
         * Imports resolved as configured; one that is not found with the old "node" resolution (moduleResolution
         * node / node10, or none set with module commonjs) is looked up again honouring the package's "exports",
         * as Node.js does at run time. The framework's entry points ("@mdakhan.mak/cs-playwright-test-framework/bdd")
         * exist only there: without this every framework class is `any` and go to definition finds nothing.
         */
        const resolveOne = (name: string, containingFile: string, redirected: TS.ResolvedProjectReference | undefined, options: TS.CompilerOptions, mode: TS.ResolutionMode): TS.ResolvedModuleWithFailedLookupLocations => {
            this.resolutionCache ??= ts.createModuleResolutionCache(root, canon, this.options);
            const r = ts.resolveModuleName(name, containingFile, options, moduleHost, this.resolutionCache, redirected, mode);
            if (r.resolvedModule || !legacyResolution || name.startsWith('.') || path.isAbsolute(name)) return r;
            const alt: TS.CompilerOptions = { ...options, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 };
            this.fallbackCache ??= ts.createModuleResolutionCache(root, canon, alt);
            const r2 = ts.resolveModuleName(name, containingFile, alt, moduleHost, this.fallbackCache, redirected, ts.ModuleKind.CommonJS);
            return r2.resolvedModule ? r2 : r;
        };
        const host: TS.LanguageServiceHost = {
            getScriptFileNames: () => {
                if (!this.names || this.namesFor !== this.overlays.size) {
                    // Each file once, in the spelling of the project's own list when it has the file.
                    const keys = new Set(this.fileNames.map((f) => this.key(f)));
                    this.names = [...this.fileNames, ...[...this.overlays.entries()].filter(([k]) => !keys.has(k)).map(([, o]) => o.name)];
                    this.namesFor = this.overlays.size;
                }
                return this.names;
            },
            getScriptVersion: (f) => {
                const o = this.overlays.get(this.key(f));
                return o ? `o${o.version}` : this.diskVersion(f);
            },
            resolveModuleNameLiterals: (lits, containingFile, redirected, options, containingSourceFile) =>
                lits.map((lit) => resolveOne(lit.text, containingFile, redirected, options, ts.getModeForUsageLocation(containingSourceFile, lit, options))),
            getScriptSnapshot: (f) => {
                const k = this.key(f);
                const o = this.overlays.get(k);
                if (o) return o.snap;
                // A file on disk is read once per version (not again each time the program is checked).
                const v = this.diskVersion(f);
                const c = this.snaps.get(k);
                if (c && c.version === v) return c.snap;
                const t = ts.sys.readFile(f);
                if (t === undefined) { this.snaps.delete(k); return undefined; }
                const snap = ts.ScriptSnapshot.fromString(t);
                this.snaps.set(k, { version: v, snap });
                return snap;
            },
            getCurrentDirectory: () => root,
            getCompilationSettings: () => this.options,
            getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
            fileExists: (f) => this.overlays.has(this.key(f)) || ts.sys.fileExists(f),
            readFile: (f) => this.overlays.get(this.key(f))?.text ?? ts.sys.readFile(f),
            readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories,
            useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
            // A long check (diagnostics) gives way to the request the person waits for (see tsClient.ts).
            getCancellationToken: () => this.cancel,
        };
        this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    /** The version of a file on disk (its mtime), looked up again only after a while: files rarely change under the editor. */
    private diskVersion(f: string): string {
        const k = this.key(f);
        const now = Date.now();
        const c = this.stats.get(k);
        if (c && now - c.at < TsService.DISK_CHECK_MS) return c.version;
        let version = '0';
        try { version = String(fs.statSync(f).mtimeMs); } catch { /* missing */ }
        this.stats.set(k, { at: now, version });
        return version;
    }

    /** What long calls check to give way (set by the worker). */
    setCancellationToken(t: TS.HostCancellationToken) { this.cancel = t; }

    /** Is this file part of the project as configured (before any file was opened)? */
    includes(abs: string): boolean { return this.fileSet.has(this.key(abs)); }

    static supports(file: string): boolean { return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(file); }

    /** Use the editor's current (possibly unsaved) text for this file. */
    update(abs: string, text: string | undefined): void {
        const k = this.key(abs);
        // Saved or closed: the file on disk counts again (looked at now, not after DISK_CHECK_MS).
        this.stats.delete(k);
        if (text === undefined) {
            // A saved file may be a new one an import was waiting for: imports are looked up again.
            this.overlays.delete(k); this.resolutionCache = null; this.fallbackCache = null; return;
        }
        const o = this.overlays.get(k);
        if (o && o.text === text) return;
        if (!o) { this.resolutionCache = null; this.fallbackCache = null; }
        this.overlays.set(k, { name: o?.name ?? path.resolve(abs), text, version: (o?.version ?? 0) + 1, snap: editSnapshot(this.ts, text, o?.snap) });
    }

    private text(abs: string): string { return this.overlays.get(this.key(abs))?.text ?? fs.readFileSync(abs, 'utf8'); }

    /**
     * The position in the text TypeScript has for a file that matches `offset` in the editor's text: the
     * same unless the program holds another text (the file on disk, with "\r\n" line ends), then by line and column.
     */
    private at(abs: string, offset: number): number {
        const o = this.overlays.get(this.key(abs));
        const sf = this.service.getProgram()?.getSourceFile(abs);
        if (!o || !sf || sf.text === o.text) return offset;
        const before = o.text.slice(0, offset).split('\n');
        const line = before.length - 1, col = before[before.length - 1].replace(/\r$/, '').length;
        try { return sf.getPositionOfLineAndCharacter(line, col); } catch { return offset; }
    }

    /** Package folders in node_modules that are links to somewhere else (npm link / pnpm / a shared folder). */
    private links(): Array<[string, string]> {
        if (this.linkMap) return this.linkMap;
        const out: Array<[string, string]> = [];
        const nm = path.join(this.root, 'node_modules');
        const look = (dir: string, depth: number) => {
            let entries: fs.Dirent[] = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isSymbolicLink()) { try { out.push([fs.realpathSync(p), p]); } catch { /* broken link */ } }
                else if (depth === 0 && e.isDirectory() && e.name.startsWith('@')) look(p, 1);
            }
        };
        try { if (fs.lstatSync(nm).isSymbolicLink()) out.push([fs.realpathSync(nm), nm]); else look(nm, 0); } catch { /* no node_modules */ }
        // The longest real path first (a package inside a linked folder).
        this.linkMap = out.sort((a, b) => b[0].length - a[0].length);
        return this.linkMap;
    }

    private lc(abs: string, pos: number): { line: number; column: number } {
        const sf = this.service.getProgram()?.getSourceFile(abs);
        if (sf) { const p = sf.getLineAndCharacterOfPosition(pos); return { line: p.line + 1, column: p.character + 1 }; }
        const before = this.text(abs).slice(0, pos).split('\n');
        return { line: before.length, column: before[before.length - 1].length + 1 };
    }

    /** Problems with the project setup itself (tsconfig.json errors, invalid options such as TS5011). */
    projectDiagnostics(): TsDiagnostic[] {
        const ts = this.ts;
        let all: TS.Diagnostic[] = [...this.configErrors];
        try { all = [...all, ...this.service.getCompilerOptionsDiagnostics()]; } catch { /* keep config errors */ }
        const cfgText = this.configPath ? (() => { try { return fs.readFileSync(this.configPath!, 'utf8'); } catch { return ''; } })() : '';
        const pos = (n: number) => { const b = cfgText.slice(0, n).split('\n'); return { line: b.length, column: b[b.length - 1].length + 1 }; };
        const seen = new Set<string>();
        return all.flatMap((d) => {
            const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
            const key = `${d.code}|${message}`;
            if (seen.has(key)) return [];
            seen.add(key);
            const inCfg = d.start !== undefined && d.file && this.configPath && this.key(d.file.fileName) === this.key(this.configPath);
            const s = inCfg ? pos(d.start!) : { line: 1, column: 1 };
            const e = inCfg ? pos(d.start! + (d.length ?? 1)) : { line: 1, column: 2 };
            const severity: TsDiagnostic['severity'] = d.category === ts.DiagnosticCategory.Error ? 'error' : d.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info';
            return [{ line: s.line, column: s.column, endLine: e.line, endColumn: e.column, message, severity, code: d.code }];
        });
    }

    /** Build the program now, so the first hover/completion after opening a file is quick. */
    warmUp(): void { this.service.getProgram(); }

    diagnostics(abs: string): TsDiagnostic[] {
        const ts = this.ts;
        // Each kind on its own: a crash in one (TypeScript bug on odd code) must not hide the others.
        // Between the steps, a request the person waits for goes first (the check inside TypeScript is coarse).
        const step = () => { if (this.cancel.isCancellationRequested()) throw new ts.OperationCanceledException(); };
        const syn = safe(() => this.service.getSyntacticDiagnostics(abs), []);
        step();
        const sem = safe(() => this.service.getSemanticDiagnostics(abs), []);
        step();
        const all = [...syn, ...sem, ...safe(() => this.service.getSuggestionDiagnostics(abs), [])];
        return all.filter((d) => d.start !== undefined).slice(0, 500).map((d) => {
            const s = this.lc(abs, d.start!);
            const e = this.lc(abs, d.start! + (d.length ?? 1));
            const severity = d.category === ts.DiagnosticCategory.Error ? 'error' : d.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info';
            return { line: s.line, column: s.column, endLine: e.line, endColumn: e.column, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'), severity, code: d.code };
        });
    }

    private static readonly PREFS: TS.UserPreferences = {
        includeCompletionsWithInsertText: true, includeCompletionsWithSnippetText: true, includeCompletionsForModuleExports: false,
        includeAutomaticOptionalChainCompletions: true, includeCompletionsWithClassMemberSnippets: true,
    };

    completions(abs: string, offset: number): TsCompletion[] {
        const r = safe(() => this.service.getCompletionsAtPosition(abs, offset, { ...TsService.PREFS, triggerKind: 1 }), undefined);
        if (!r) return [];
        // Sorted as they are listed (TypeScript's own order), then capped: a long global list loses its far end, not its best.
        const entries = [...r.entries].sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : a.name.localeCompare(b.name))).slice(0, 1500);
        return entries.map((e) => {
            const span = e.replacementSpan;
            return {
                name: e.name, kind: e.kind, sortText: e.sortText,
                ...(e.insertText !== undefined ? { insertText: e.insertText } : {}),
                ...(e.isSnippet ? { isSnippet: true } : {}),
                ...(span ? { replace: { start: span.start, length: span.length } } : {}),
                ...(e.hasAction ? { hasAction: true } : {}),
                ...(e.source ? { source: e.source } : {}),
                ...(e.data ? { data: e.data } : {}),
                ...(e.kindModifiers ? { kindModifiers: e.kindModifiers } : {}),
            };
        });
    }

    /** The detail of one completion (asked for the highlighted one only: it takes 5-20 ms each). */
    completionDetails(abs: string, offset: number, name: string, source?: string, data?: unknown): TsCompletionDetails | null {
        const d = safe(() => this.service.getCompletionEntryDetails(abs, offset, name, this.formatSettings('\n'), source, TsService.PREFS, data as TS.CompletionEntryData | undefined), undefined);
        if (!d) return null;
        const out: TsCompletionDetails = { detail: this.ts.displayPartsToString(d.displayParts), doc: this.ts.displayPartsToString(d.documentation) };
        if (CALLABLE.has(d.kind)) out.snippet = callSnippet(name, d.displayParts);
        const edits = (d.codeActions ?? []).flatMap((a) => a.changes).filter((c) => this.key(c.fileName) === this.key(abs)).flatMap((c) => c.textChanges);
        if (edits.length) out.edits = edits.map((e) => ({ start: e.span.start, length: e.span.length, newText: e.newText }));
        return out;
    }

    signatureHelp(abs: string, offset: number, trigger?: string): TsSignatureHelp | null {
        const reason: TS.SignatureHelpTriggerReason = trigger === '(' || trigger === ',' || trigger === '<' ? { kind: 'characterTyped', triggerCharacter: trigger } : { kind: 'invoked' };
        const h = safe(() => this.service.getSignatureHelpItems(abs, offset, { triggerReason: reason }), undefined);
        if (!h || !h.items.length) return null;
        const str = (p: TS.SymbolDisplayPart[]) => this.ts.displayPartsToString(p);
        const signatures = h.items.slice(0, 20).map((it) => {
            let label = str(it.prefixDisplayParts);
            const params: Array<[number, number]> = [];
            it.parameters.forEach((p, i) => {
                if (i > 0) label += str(it.separatorDisplayParts);
                const s = label.length;
                label += str(p.displayParts);
                params.push([s, label.length]);
            });
            label += str(it.suffixDisplayParts);
            return { label, params, doc: str(it.documentation), paramDocs: it.parameters.map((p) => str(p.documentation)) };
        });
        return { signatures, active: Math.min(h.selectedItemIndex, signatures.length - 1), param: h.argumentIndex, start: h.applicableSpan.start };
    }

    quickInfo(abs: string, offset: number): { text: string; doc: string } | null {
        const q = safe(() => this.service.getQuickInfoAtPosition(abs, this.at(abs, offset)), undefined);
        if (!q) return null;
        return { text: this.ts.displayPartsToString(q.displayParts), doc: this.ts.displayPartsToString(q.documentation) };
    }

    definition(abs: string, offset: number): TsLocation[] {
        const pos = this.at(abs, offset);
        const defs = safe(() => this.service.getDefinitionAtPosition(abs, pos), undefined) ?? [];
        return defs.map((d) => this.location(d.fileName, d.textSpan));
    }

    /**
     * Every use of the symbol at the offset across the project (TypeScript's find all references): page
     * element properties, methods, classes, functions, variables. `definition`: the declaration itself.
     */
    references(abs: string, offset: number): Array<TsLocation & { definition?: boolean; write?: boolean }> {
        const pos = this.at(abs, offset);
        const groups = safe(() => this.service.findReferences(abs, pos), undefined) ?? [];
        const seen = new Set<string>();
        const out: Array<TsLocation & { definition?: boolean; write?: boolean }> = [];
        const lines = new Map<string, string[]>();
        for (const g of groups) for (const r of g.references) {
            const id = `${this.key(r.fileName)}:${r.textSpan.start}`;
            if (seen.has(id) || out.length >= 1000) continue;
            seen.add(id);
            const loc: TsLocation & { definition?: boolean; write?: boolean } = this.location(r.fileName, r.textSpan);
            // The declaration (TypeScript 5 no longer marks it on the reference itself).
            if (r.isDefinition || (this.key(g.definition.fileName) === this.key(r.fileName) && g.definition.textSpan.start === r.textSpan.start)) loc.definition = true;
            if (r.isWriteAccess) loc.write = true;
            try {
                let ls = lines.get(r.fileName);
                if (!ls) { ls = this.text(r.fileName).split(/\r?\n/); lines.set(r.fileName, ls); }
                loc.text = ls[loc.line - 1]?.trim().slice(0, 200);
            } catch { /* unreadable */ }
            out.push(loc);
        }
        return out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    }

    /** Format the whole file with TypeScript's formatter (4-space indent, like the framework). */
    private formatSettings(eol: string): TS.FormatCodeSettings {
        return { ...this.ts.getDefaultFormatCodeSettings(eol), indentSize: 4, tabSize: 4, convertTabsToSpaces: true, semicolons: this.ts.SemicolonPreference.Ignore };
    }

    format(abs: string): string {
        const text = this.text(abs);
        const settings = this.formatSettings(text.includes('\r\n') ? '\r\n' : '\n');
        const edits = this.service.getFormattingEditsForDocument(abs, settings);
        let out = text;
        for (const e of [...edits].sort((a, b) => b.span.start - a.span.start)) out = out.slice(0, e.span.start) + e.newText + out.slice(e.span.start + e.span.length);
        return out;
    }

    private location(fileName: string, span: TS.TextSpan): TsLocation {
        const s = this.lc(fileName, span.start);
        const e = this.lc(fileName, span.start + span.length);
        return { path: repoPathOf(this.root, fileName, this.caseSensitive, path, this.links()), ...s, endLine: e.line, endColumn: e.column };
    }
}

/**
 * Several TypeScript projects in one repository: each file uses its nearest tsconfig.json (or a
 * project that tsconfig references, if that is where the file belongs), like VS Code.
 */
export class TsProjects {
    private readonly services = new Map<string, TsService>();
    private readonly open = new Map<string, string>();
    private static readonly MAX_PROJECTS = 6;

    constructor(private readonly root: string, private readonly cancel?: TS.HostCancellationToken) {}

    private service(config: string | null): TsService {
        const key = config ?? '';
        let s = this.services.get(key);
        if (s) { this.services.delete(key); this.services.set(key, s); return s; } // most recently used last
        s = new TsService(this.root, config);
        if (this.cancel) s.setCancellationToken(this.cancel);
        for (const [f, t] of this.open) if (this.configFor(f) === config) s.update(f, t);
        this.services.set(key, s);
        while (this.services.size > TsProjects.MAX_PROJECTS) this.services.delete(this.services.keys().next().value as string);
        return s;
    }

    configFor(abs: string): string | null {
        let dir = path.dirname(path.resolve(abs));
        const root = path.resolve(this.root);
        while (dir === root || isInside(root, dir)) {
            const c = path.join(dir, 'tsconfig.json');
            if (fs.existsSync(c)) return c;
            if (dir === root) break;
            dir = path.dirname(dir);
        }
        return null;
    }

    for(abs: string): TsService {
        const s = this.service(this.configFor(abs));
        if (!s.includes(abs)) for (const ref of s.projectReferences) { const r = this.service(ref); if (r.includes(abs)) return r; }
        return s;
    }

    update(abs: string, text: string | undefined): void {
        const k = path.resolve(abs);
        if (text === undefined) { this.open.delete(k); for (const s of this.services.values()) s.update(k, undefined); return; }
        this.open.set(k, text);
        this.for(k).update(k, text);
    }

    /** Problems of the project a tsconfig.json file defines. */
    projectDiagnostics(configAbs: string): TsDiagnostic[] { return this.service(path.resolve(configAbs)).projectDiagnostics(); }

    /** Build the program of the project a file belongs to (default: the repository's root project). */
    warmUp(abs?: string): void { safe(() => this.for(abs ? path.resolve(abs) : path.join(this.root, '__warmup__.ts')).warmUp(), undefined); }

    info(): { version: string; tsconfig: string | null } {
        const s = this.services.values().next().value as TsService | undefined;
        return { version: (require('typescript') as TsModule).version, tsconfig: s?.configPath ?? this.configFor(path.join(this.root, 'x.ts')) };
    }
}
