/**
 * Gherkin support for CS Playwright Test Framework projects:
 *  - index every @CSBDDStepDef('…') in the project AND in the installed framework package
 *    (its built-in steps), from TypeScript or compiled JavaScript;
 *  - match feature-file steps exactly like the framework does (CSBDDDecorators.patternToRegex:
 *    escape the text, {string} = "…" or '…', {int} = \d+, {float} = [\d.]+, {word} = \w+,
 *    whole-step match, first definition wins);
 *  - report undefined / ambiguous steps, go to definition, and suggest steps while typing.
 */
import { gherkinFor, gherkinProblems } from './gherkin';
import * as fs from 'fs';
import * as path from 'path';

export interface StepDef {
    pattern: string; file: string; line: number; builtIn: boolean; regex: RegExp;
    /** In a step file the framework does not load (folder not in STEP_DEFINITIONS_PATH). */
    notLoaded?: boolean;
    /** Pattern with several parameters in a row ({word}{word}…): only tried on short steps (slow regex). */
    risky?: boolean;
}

/** Longest step text a definition is tried against (steps are one line; protects the editor). */
const MAX_STEP_TEXT = 2000;
const RISKY_MAX_TEXT = 200;
const isRisky = (pattern: string) => /(?:\{(?:word|int|float|string)\}\s*){3,}/.test(pattern) || /\{(?:word|float)\}\{(?:word|float)\}/.test(pattern);

/** Does a definition match this step text (with the same guard everywhere)? */
export function matches(d: StepDef, text: string): boolean {
    if (text.length > (d.risky ? RISKY_MAX_TEXT : MAX_STEP_TEXT)) return false;
    return d.regex.test(text);
}

/** Same conversion as the framework (CSBDDDecorators.ts patternToRegex). */
export function patternToRegex(pattern: string): RegExp {
    let p = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    p = p.replace(/\\\{string\\\}/g, '(?:"([^"]*)"|\'([^\']*)\')');
    p = p.replace(/\\\{int\\\}/g, '(\\d+)');
    p = p.replace(/\\\{float\\\}/g, '([\\d\\.]+)');
    p = p.replace(/\\\{word\\\}/g, '(\\w+)');
    return new RegExp(`^${p}$`);
}

/**
 * A step definition: @CSBDDStepDef('…'), or the Cucumber-style decorators the framework exports
 * from /bdd (CSCucumberDecorators: Given, When, Then, And, But, Step, defineStep), which register
 * through CSBDDStepDef exactly the same way.
 */
const DEF_RE = /(?:CSBDDStepDef\)?|@(?:Given|When|Then|And|But|Step|defineStep))\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const HAS_DEFS = /CSBDDStepDef|@(?:Given|When|Then|And|But|Step|defineStep)\s*\(/;

function unescapeLiteral(s: string): string {
    return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, e: string) => {
        if (e[0] === 'u') return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
        if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
        return ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[e] ?? e;
    });
}

/**
 * Blank out line and block comments (keeping line breaks and string contents), so commented-out
 * step definitions are not indexed. Strings, template literals and regex literals are skipped.
 */
export function stripComments(src: string): string {
    const out = src.split('');
    let i = 0;
    let prevSignificant = '';
    const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
        if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; else if (c !== '`' && src[j] === '\n') break; j++; }
            i = j + 1; prevSignificant = c; continue;
        }
        if (c === '/' && (prevSignificant === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSignificant))) {
            // regex literal
            let j = i + 1, inClass = false;
            while (j < src.length && src[j] !== '\n') {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
                else if (src[j] === '/' && !inClass) break;
                j++;
            }
            i = j + 1; prevSignificant = 'r'; continue;
        }
        if (!/\s/.test(c)) prevSignificant = c;
        i++;
    }
    return out.join('');
}

export function extractStepDefs(text: string, file: string, builtIn: boolean): StepDef[] {
    const out: StepDef[] = [];
    text = stripComments(text);
    DEF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DEF_RE.exec(text)) !== null) {
        if (m[1] === '`' && m[2].includes('${')) continue; // computed pattern: cannot know statically
        const pattern = unescapeLiteral(m[2]);
        const line = text.slice(0, m.index).split('\n').length;
        out.push({ pattern, file, line, builtIn, regex: patternToRegex(pattern), ...(isRisky(pattern) ? { risky: true } : {}) });
    }
    return out;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'reports', 'test-results', 'playwright-report', 'coverage', '.cs-studio']);

/** The project a feature belongs to, from its folder (test/<project>/…), when that project exists. */
export function projectOfFeature(file: string, projects: string[]): string | undefined {
    const m = /^test\/([^/]+)\//.exec(file.replace(/\\/g, '/'));
    return m && projects.includes(m[1]) ? m[1] : undefined;
}

/** Framework default (CSBDDRunner / config/global.env). */
export const DEFAULT_STEP_PATHS = 'test/common/steps;test/{project}/steps;test/{project}/step-definitions;src/steps';

/** Same rule as the framework (CSBDDEngine.isStepFile). */
export function isStepFile(name: string): boolean {
    return /(\.steps\.(ts|js)|\.step\.(ts|js)|Steps\.(ts|js))$/.test(name) && !name.endsWith('.d.ts') && !name.includes('.spec.') && !name.includes('.test.');
}

function walk(dir: string, accept: (name: string) => boolean, out: string[], depth = 0): void {
    if (depth > 20) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const a = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(a, accept, out, depth + 1); }
        else if (e.isFile() && accept(e.name)) out.push(a);
    }
}

/** Whether `p` is `root` or inside it (path rules of the platform). */
export function isInside(root: string, p: string, api: typeof path = path): boolean {
    const rel = api.relative(api.resolve(root), api.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

/**
 * Folders the framework loads project steps from: each STEP_DEFINITIONS_PATH value (one per
 * project), `{project}` replaced. With no value known, the default with `{project}` = every
 * folder that exists in its place. Paths into node_modules are the framework's built-in steps,
 * which are indexed separately.
 */
export function stepFolders(root: string, configured: Array<{ project?: string; value: string }>, pathApi: typeof path = path): string[] {
    root = pathApi.resolve(root);
    const entries = configured.length ? configured : [{ value: DEFAULT_STEP_PATHS }];
    const dirs = new Set<string>();
    for (const { project, value } of entries) {
        for (let p of value.split(';').map((x) => x.trim()).filter(Boolean)) {
            if (/node_modules/.test(p)) continue;
            if (p.includes('{project}')) {
                if (project) p = p.replace('{project}', project);
                else {
                    const [before, after] = p.split('{project}', 2);
                    let names: string[] = [];
                    try { names = fs.readdirSync(pathApi.resolve(root, before || '.'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { /* none */ }
                    for (const n of names) dirs.add(pathApi.resolve(root, before + n + after));
                    continue;
                }
            }
            dirs.add(pathApi.resolve(root, p));
        }
    }
    // Only folders inside the repository. Compared as paths, not text: on Windows Git reports the
    // root with forward slashes (E:/project) while resolved folders use backslashes, and the drive
    // letter's case can differ.
    return [...dirs].filter((d) => isInside(root, d, pathApi));
}

/**
 * Step groups the installed framework loads for every project: the loadStepGroup('x') calls its
 * CSStepLoader.loadRequiredSteps makes before it checks STEP_DEFINITIONS_PATH.
 */
export function alwaysLoadedGroups(pkg: string): string[] {
    const fallback = ['ai', 'auth', 'report-validation'];
    for (const f of [path.join(pkg, 'dist', 'core', 'CSStepLoader.js'), path.join(pkg, 'src', 'core', 'CSStepLoader.ts')]) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        const start = text.indexOf('loadRequiredSteps(');
        const end = text.indexOf('shouldLoadFrameworkSteps', start);
        if (start < 0 || end < 0) return fallback;
        const groups = [...text.slice(start, end).matchAll(/loadStepGroup\(\s*['"]([\w-]+)['"]/g)].map((m) => m[1]);
        return groups.length ? [...new Set(groups)] : fallback;
    }
    return fallback;
}

/** Installed framework package folders (any scope; name ends with cs-playwright-test-framework). */
export function frameworkPackages(root: string): string[] {
    const nm = path.join(root, 'node_modules');
    const found: string[] = [];
    let scopes: string[] = [];
    try { scopes = fs.readdirSync(nm); } catch { return found; }
    for (const s of scopes) {
        const cands = s.startsWith('@') ? (() => { try { return fs.readdirSync(path.join(nm, s)).map((n) => path.join(nm, s, n)); } catch { return []; } })() : [path.join(nm, s)];
        for (const c of cands) if (/cs-playwright-test-framework$/.test(c) && fs.existsSync(path.join(c, 'package.json'))) found.push(c);
    }
    return found;
}

export class StepIndex {
    private cache = new Map<string, { mtime: number; defs: StepDef[] }>();
    /**
     * @param stepPaths STEP_DEFINITIONS_PATH value(s) per project, read from the project's
     *        configuration; empty → the framework default.
     */
    constructor(private readonly root: string, private readonly stepPaths: () => Array<{ project?: string; value: string }> = () => [],
        /** STEP_DEFINITIONS_PATH a project without its own configuration gets (a new project: the global default). */
        private readonly defaultFor?: (project: string) => string | undefined) {}

    /**
     * The configuration of one project when given (and known): a feature of project A is run
     * with A's STEP_DEFINITIONS_PATH, so B's step files must not count for it.
     */
    private configFor(project?: string): Array<{ project?: string; value: string }> {
        const conf = this.stepPaths();
        const mine = project ? conf.filter((c) => c.project === project) : [];
        if (mine.length) return mine;
        // A project the repository does not have yet: what the framework will load for it, not every
        // other project's steps.
        if (project && this.defaultFor) return [{ project, value: this.defaultFor(project) ?? DEFAULT_STEP_PATHS }];
        return conf;
    }

    /** Folders the framework loads project steps from (absolute; may not exist yet). */
    folders(project?: string): string[] { return stepFolders(this.root, this.configFor(project)); }

    /** Project step files the framework loads (absolute). */
    loadedFiles(project?: string): string[] { return this.projectFiles(project); }

    private projectFiles(project?: string): string[] {
        const files: string[] = [];
        for (const dir of stepFolders(this.root, this.configFor(project))) {
            let st: fs.Stats; try { st = fs.statSync(dir); } catch { continue; }
            if (st.isFile()) { if (/\.(ts|js)$/.test(dir)) files.push(dir); continue; }
            walk(dir, isStepFile, files);
        }
        // Same file compiled next to its source: keep the .ts (the one people edit).
        const set = new Set(files);
        return [...set].filter((f) => !(f.endsWith('.js') && set.has(f.slice(0, -3) + '.ts'))).sort();
    }

    /** Step files elsewhere in the repository (to explain "undefined" steps defined there). */
    private otherFiles(loaded: Set<string>): string[] {
        const all: string[] = [];
        walk(this.root, isStepFile, all);
        const set = new Set(all);
        return all.filter((f) => !loaded.has(f) && !(f.endsWith('.js') && (set.has(f.slice(0, -3) + '.ts') || loaded.has(f.slice(0, -3) + '.ts')))
            && !f.split(path.sep).some((seg) => seg === 'dist' || seg === 'build' || seg === 'out')).sort();
    }

    /**
     * All step definitions: project first (in file order), then the framework's built-in steps,
     * then (marked notLoaded) definitions in step files the framework would not load.
     */
    all(project?: string): StepDef[] {
        const files: Array<{ abs: string; builtIn: boolean; notLoaded?: boolean }> = [];
        const proj = this.projectFiles(project);
        proj.forEach((abs) => files.push({ abs, builtIn: false }));
        // The framework's own steps load by group (CSStepLoader.loadStepGroup: the step files directly
        // in dist/steps/<group>): some groups always (1.54: ai, auth, report-validation, read from the
        // installed loader); "common", "api", "database" and "soap" only when STEP_DEFINITIONS_PATH
        // names the framework package under node_modules. Other folders are not loaded.
        const conf = this.configFor(project);
        const withFramework = conf.some((c) => /node_modules/.test(c.value) && /cs-playwright-test-framework/.test(c.value));
        for (const pkg of frameworkPackages(this.root)) {
            const fw: string[] = [];
            const stepsDir = [path.join(pkg, 'dist', 'steps'), path.join(pkg, 'src', 'steps')].find((d) => fs.existsSync(d));
            const groups = [...(withFramework ? ['common', 'api', 'database', 'soap'] : []), ...alwaysLoadedGroups(pkg)];
            if (stepsDir) {
                for (const g of groups) {
                    let es: fs.Dirent[] = [];
                    try { es = fs.readdirSync(path.join(stepsDir, g), { withFileTypes: true }); } catch { continue; }
                    for (const e of es) if (e.isFile() && isStepFile(e.name)) fw.push(path.join(stepsDir, g, e.name));
                }
            } else walkAll(path.join(pkg, 'dist'), fw); // unknown layout: everything, as before
            fw.sort().forEach((abs) => files.push({ abs, builtIn: true }));
        }
        this.otherFiles(new Set(proj)).forEach((abs) => files.push({ abs, builtIn: false, notLoaded: true }));
        const out: StepDef[] = [];
        const seen = new Set<string>();
        for (const f of files) {
            let st: fs.Stats;
            try { st = fs.statSync(f.abs); } catch { continue; }
            if (st.size > 2 * 1024 * 1024) continue;
            let c = this.cache.get(f.abs);
            if (!c || c.mtime !== st.mtimeMs) {
                const text = fs.readFileSync(f.abs, 'utf8');
                c = { mtime: st.mtimeMs, defs: HAS_DEFS.test(text) ? extractStepDefs(text, path.relative(this.root, f.abs).split(path.sep).join('/'), f.builtIn) : [] };
                this.cache.set(f.abs, c);
            }
            for (const d0 of c.defs) {
                const d = f.notLoaded ? { ...d0, notLoaded: true } : d0;
                const key = `${d.builtIn}|${d.pattern}`;
                if (d.builtIn && seen.has(key)) continue;
                seen.add(key);
                out.push(d);
            }
        }
        return out;
    }
}

function walkAll(dir: string, out: string[], depth = 0): void {
    if (depth > 20) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const a = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walkAll(a, out, depth + 1); }
        else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(a);
    }
}

export interface FeatureStep {
    line: number; keyword: string; text: string; column: number;
    /** Text with <placeholders> replaced from the first Examples row. */
    resolvedText: string;
    /** Every Examples row's version of the step (Scenario Outline), else just the text. */
    variants: string[];
}

const STEP_KW = /^(\s*)(Given|When|Then|And|But|\*)\s+(.*?)\s*$/;

/** Cells of a table row; `\|` is a literal pipe, `\\` a backslash, `\n` a newline (Gherkin). */
export function tableCells(row: string): string[] {
    const t = row.trim();
    const cells: string[] = [];
    let cur = '';
    for (let i = 1; i < t.length; i++) {
        const c = t[i];
        if (c === '\\' && i + 1 < t.length) { const n = t[++i]; cur += n === 'n' ? '\n' : n; continue; }
        if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) cells.push(cur.trim());
    return cells;
}

/**
 * Steps of a feature file. In a Scenario Outline every row of every Examples table is a variant
 * (that is what the framework runs).
 */
export function featureSteps(text: string): FeatureStep[] {
    const lines = text.split(/\r?\n/);
    const steps: FeatureStep[] = [];
    let docDelim: string | null = null;
    let outline: FeatureStep[] = [];
    let inOutline = false;
    let inSteps = false; // descriptions under Feature:/Rule: are not steps
    const outlineRows: Array<Record<string, string>> = [];
    let header: string[] | null = null; // inside an Examples table: [] until the header row is read
    const finishOutline = () => {
        if (inOutline) for (const s of outline) {
            const vs = outlineRows.map((row) => s.text.replace(/<([^>]+)>/g, (m, k: string) => (k in row ? row[k] : m)));
            if (vs.length) { s.variants = vs; s.resolvedText = vs[0]; }
        }
        outline = []; outlineRows.length = 0; inOutline = false; header = null;
    };
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const t = l.trim();
        if (docDelim) { if (t.startsWith(docDelim)) docDelim = null; continue; }
        const dm = /^("{3}|`{3})/.exec(t);
        if (dm) { docDelim = dm[1]; continue; }
        if (!t || t.startsWith('#') || t.startsWith('@')) continue;
        if (t.startsWith('|')) {
            if (header) {
                const cells = tableCells(t);
                if (header.length === 0) header = cells;
                else { const row: Record<string, string> = {}; header.forEach((h, k) => { row[h] = cells[k] ?? ''; }); outlineRows.push(row); }
            }
            continue;
        }
        header = null;
        if (/^(Scenario Outline|Scenario Template):/.test(t)) { finishOutline(); inOutline = true; inSteps = true; continue; }
        if (/^(Scenario|Example|Background):/.test(t)) { finishOutline(); inSteps = true; continue; }
        if (/^(Feature|Rule):/.test(t)) { finishOutline(); inSteps = false; continue; }
        if (/^(Examples|Scenarios):/.test(t)) { header = []; continue; }
        if (!inSteps) continue;
        const m = STEP_KW.exec(l);
        if (!m) continue;
        const column = l.indexOf(m[3], m[1].length + m[2].length) + 1;
        const s: FeatureStep = { line: i + 1, keyword: m[2], text: m[3], column, resolvedText: m[3], variants: [m[3]] };
        steps.push(s);
        if (inOutline) outline.push(s);
    }
    finishOutline();
    return steps;
}

export interface StepProblem { line: number; column: number; endColumn: number; severity: 'error' | 'warning' | 'info'; message: string; fix?: 'create-step' }

export function checkFeature(text: string, allDefs: StepDef[], root?: string): StepProblem[] {
    // Structure first: a feature the framework cannot parse is left out of the run.
    const out: StepProblem[] = root ? gherkinProblems(text, gherkinFor(root)) : [];
    const defs = allDefs.filter((d) => !d.notLoaded);
    const unloaded = allDefs.filter((d) => d.notLoaded);
    for (const s of featureSteps(text)) {
        const end = s.column + s.text.length;
        const variants = s.variants.filter((v) => !/<[^>]+>/.test(v)); // outline without examples yet
        if (!variants.length) continue;
        let reported = false;
        for (const v of variants) {
            if (v.length > MAX_STEP_TEXT) {
                out.push({ line: s.line, column: s.column, endColumn: end, severity: 'warning', message: `This step is too long to check (${v.length} characters).` });
                reported = true; break;
            }
            if (!defs.some((d) => matches(d, v))) {
                const row = v !== s.text ? ` (with the Examples row giving "${v}")` : '';
                const elsewhere = unloaded.find((d) => matches(d, v));
                out.push({ line: s.line, column: s.column, endColumn: end, severity: 'error', fix: 'create-step', message: elsewhere
                    ? `"${s.text}"${row} is defined in ${elsewhere.file}:${elsewhere.line}, but the framework does not load step files from that folder. Add the folder to STEP_DEFINITIONS_PATH in your project's configuration, or move the file.`
                    : `No step definition matches "${s.text}"${row}.${closestHint(v, defs)} Add one with @CSBDDStepDef, or check the wording.` });
                reported = true; break;
            }
        }
        if (reported) continue;
        const hits = defs.filter((d) => matches(d, variants[0]));
        if (hits.length > 1) {
            const first = hits[0];
            const same = hits.every((h) => h.pattern === first.pattern);
            out.push({ line: s.line, column: s.column, endColumn: end, severity: 'info',
                message: same
                    ? `This step is defined ${hits.length} times with the same wording (${hits.map((h) => `${h.file}:${h.line}`).join(', ')}); the framework uses the first.`
                    : `${hits.length} step definitions match; the framework uses the first one (${first.file}:${first.line}).` });
        }
    }
    return out;
}

const words = (t: string) => new Set(t.toLowerCase().replace(/"[^"]*"|'[^']*'|\{[a-z]+\}|<[^>]+>|[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1));

/** " Closest existing step: …" when a defined step is worded much like this one (else ""). */
export function closestHint(text: string, defs: StepDef[]): string {
    const a = words(text);
    if (a.size < 2) return '';
    let best: StepDef | null = null, score = 0;
    for (const d of defs) {
        const b = words(d.pattern);
        if (!b.size) continue;
        let both = 0; for (const w of a) if (b.has(w)) both++;
        const sc = both / (a.size + b.size - both);
        if (sc > score) { score = sc; best = d; }
    }
    return best && score >= 0.5 ? ` Closest existing step: "${best.pattern}" (${best.file}:${best.line}).` : '';
}

export function definitionFor(text: string, line: number, defs: StepDef[]): StepDef | null {
    const s = featureSteps(text).find((x) => x.line === line);
    if (!s) return null;
    return defs.find((d) => !d.notLoaded && matches(d, s.resolvedText)) ?? defs.find((d) => matches(d, s.resolvedText)) ?? null;
}

/** Turn a pattern into something to insert: {string} → "", {int} → 0 … */
export function stepSnippet(pattern: string): string {
    return pattern.replace(/\{string\}/g, '""').replace(/\{int\}/g, '1').replace(/\{float\}/g, '1.0').replace(/\{word\}/g, 'word');
}
