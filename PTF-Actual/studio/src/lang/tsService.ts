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

function safe<T>(f: () => T, fallback: T): T {
    try { return f(); } catch { return fallback; }
}

const isInside = (root: string, p: string) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

export interface TsDiagnostic { line: number; column: number; endLine: number; endColumn: number; message: string; severity: 'error' | 'warning' | 'info'; code: number }
export interface TsCompletion { name: string; kind: string; sortText: string; insertText?: string }
export interface TsLocation { path: string; line: number; column: number; endLine: number; endColumn: number; text?: string }

export class TsService {
    readonly ts: TsModule;
    readonly tsSource: 'project' | 'studio';
    private readonly service: TS.LanguageService;
    private readonly overlays = new Map<string, { text: string; version: number }>();
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
            getScriptFileNames: () => [...new Set([...this.fileNames, ...this.overlays.keys()])],
            getScriptVersion: (f) => {
                const o = this.overlays.get(path.resolve(f));
                if (o) return `o${o.version}`;
                try { return String(fs.statSync(f).mtimeMs); } catch { return '0'; }
            },
            getScriptSnapshot: (f) => {
                const o = this.overlays.get(path.resolve(f));
                if (o) return ts.ScriptSnapshot.fromString(o.text);
                const t = ts.sys.readFile(f);
                return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
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
        };
        this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    /** Is this file part of the project as configured (before any file was opened)? */
    includes(abs: string): boolean { return this.fileSet.has(path.resolve(abs)); }

    static supports(file: string): boolean { return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(file); }

    /** Use the editor's current (possibly unsaved) text for this file. */
    update(abs: string, text: string | undefined): void {
        const k = path.resolve(abs);
        if (text === undefined) { this.overlays.delete(k); return; }
        const o = this.overlays.get(k);
        if (o && o.text === text) return;
        this.overlays.set(k, { text, version: (o?.version ?? 0) + 1 });
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
        const all = [
            ...safe(() => this.service.getSyntacticDiagnostics(abs), []),
            ...safe(() => this.service.getSemanticDiagnostics(abs), []),
            ...safe(() => this.service.getSuggestionDiagnostics(abs), []),
        ];
        return all.filter((d) => d.start !== undefined).slice(0, 500).map((d) => {
            const s = this.lc(abs, d.start!);
            const e = this.lc(abs, d.start! + (d.length ?? 1));
            const severity = d.category === ts.DiagnosticCategory.Error ? 'error' : d.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info';
            return { line: s.line, column: s.column, endLine: e.line, endColumn: e.column, message: ts.flattenDiagnosticMessageText(d.messageText, '\n'), severity, code: d.code };
        });
    }

    completions(abs: string, offset: number): TsCompletion[] {
        const r = safe(() => this.service.getCompletionsAtPosition(abs, offset, { includeCompletionsWithInsertText: true, includeCompletionsForModuleExports: false }), undefined);
        if (!r) return [];
        return r.entries.slice(0, 400).map((e) => ({ name: e.name, kind: e.kind, sortText: e.sortText, insertText: e.insertText }));
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
    format(abs: string): string {
        const text = this.text(abs);
        const settings: TS.FormatCodeSettings = {
            ...this.ts.getDefaultFormatCodeSettings(text.includes('\r\n') ? '\r\n' : '\n'),
            indentSize: 4, tabSize: 4, convertTabsToSpaces: true, semicolons: this.ts.SemicolonPreference.Ignore,
        };
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

    constructor(private readonly root: string) {}

    private service(config: string | null): TsService {
        const key = config ?? '';
        let s = this.services.get(key);
        if (s) { this.services.delete(key); this.services.set(key, s); return s; } // most recently used last
        s = new TsService(this.root, config);
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

    warmUp(): void { safe(() => this.for(path.join(this.root, '__warmup__.ts')).warmUp(), undefined); }

    info(): { version: string; tsconfig: string | null } {
        const s = this.services.values().next().value as TsService | undefined;
        return { version: (require('typescript') as TsModule).version, tsconfig: s?.configPath ?? this.configFor(path.join(this.root, 'x.ts')) };
    }
}
