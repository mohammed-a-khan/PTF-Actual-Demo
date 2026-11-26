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
    private readonly overlays = new Map<string, { text: string; version: number; snap: TS.IScriptSnapshot }>();
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
        this.fileSet = new Set(this.fileNames.map((f) => path.resolve(f)));
        const host: TS.LanguageServiceHost = {
            getScriptFileNames: () => {
                if (!this.names || this.namesFor !== this.overlays.size) { this.names = [...new Set([...this.fileNames, ...this.overlays.keys()])]; this.namesFor = this.overlays.size; }
                return this.names;
            },
            getScriptVersion: (f) => {
                const o = this.overlays.get(path.resolve(f));
                return o ? `o${o.version}` : this.diskVersion(f);
            },
            getScriptSnapshot: (f) => {
                const k = path.resolve(f);
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
            fileExists: (f) => this.overlays.has(path.resolve(f)) || ts.sys.fileExists(f),
            readFile: (f) => this.overlays.get(path.resolve(f))?.text ?? ts.sys.readFile(f),
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
        const k = path.resolve(f);
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
    includes(abs: string): boolean { return this.fileSet.has(path.resolve(abs)); }

    static supports(file: string): boolean { return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(file); }

    /** Use the editor's current (possibly unsaved) text for this file. */
    update(abs: string, text: string | undefined): void {
        const k = path.resolve(abs);
        // Saved or closed: the file on disk counts again (looked at now, not after DISK_CHECK_MS).
        this.stats.delete(k);
        if (text === undefined) { this.overlays.delete(k); return; }
        const o = this.overlays.get(k);
        if (o && o.text === text) return;
        this.overlays.set(k, { text, version: (o?.version ?? 0) + 1, snap: editSnapshot(this.ts, text, o?.snap) });
    }

    private text(abs: string): string { return this.overlays.get(path.resolve(abs))?.text ?? fs.readFileSync(abs, 'utf8'); }

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
            const inCfg = d.start !== undefined && d.file && this.configPath && path.resolve(d.file.fileName) === path.resolve(this.configPath);
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
        const edits = (d.codeActions ?? []).flatMap((a) => a.changes).filter((c) => path.resolve(c.fileName) === path.resolve(abs)).flatMap((c) => c.textChanges);
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
        const q = safe(() => this.service.getQuickInfoAtPosition(abs, offset), undefined);
        if (!q) return null;
        return { text: this.ts.displayPartsToString(q.displayParts), doc: this.ts.displayPartsToString(q.documentation) };
    }

    definition(abs: string, offset: number): TsLocation[] {
        const defs = safe(() => this.service.getDefinitionAtPosition(abs, offset), undefined) ?? [];
        return defs.map((d) => this.location(d.fileName, d.textSpan));
    }

    references(abs: string, offset: number): TsLocation[] {
        const refs = safe(() => this.service.getReferencesAtPosition(abs, offset), undefined) ?? [];
        return refs.slice(0, 500).map((r) => {
            const loc = this.location(r.fileName, r.textSpan);
            try { loc.text = this.text(r.fileName).split(/\r?\n/)[loc.line - 1]?.trim().slice(0, 200); } catch { /* unreadable */ }
            return loc;
        });
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
        return { path: path.relative(this.root, fileName).split(path.sep).join('/'), ...s, endLine: e.line, endColumn: e.column };
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
