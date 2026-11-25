/**
 * CSImpactGraph - Which files a change reaches, read from the code (no run needed).
 *
 * A file is reached by a change when it is the changed file, or uses a reached file:
 *  - imports it (`import … from './x'`, `export … from`, `require('./x')`, `import('./x')`), relative paths
 *    and the `paths` / `baseUrl` of tsconfig.json;
 *  - names what it defines where pages are found by name, not imported: `@CSPage('login-page')` is used by
 *    `@Page('login-page')`, `@CSInject`, `getPage('login-page')` (the quoted name), and an exported class
 *    used by its name.
 * Test impact analysis then runs the scenarios whose step files are reached.
 *
 * Plain Node (fs, path): CS Test Studio keeps a copy of this file for pull requests.
 *
 * @module impact
 */
import * as fs from 'fs';
import * as path from 'path';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'reports', 'test-results', 'playwright-report', '.cs-ai', '.cs-studio']);

/** Repository files (relative, with /) of code, outside dependencies and outputs. */
export function codeFiles(root: string, max = 20000): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (out.length >= max) return;
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name); }
            else if (e.isFile() && CODE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel ? `${rel}/${e.name}` : e.name);
        }
    };
    walk(root, '');
    return out;
}

/** The modules a file names: imports, re-exports, require() and import(). */
export function importsOf(text: string): string[] {
    const out = new Set<string>();
    const re = /(?:^|[^\w.$])(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[^\w.$])import\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
    for (const m of text.matchAll(re)) { const s = m[1] ?? m[2] ?? m[3] ?? m[4]; if (s) out.add(s); }
    return [...out];
}

/** What a file defines that others can use by name: page names of @CSPage('…') and exported classes. */
export function namesOf(text: string): { pages: string[]; classes: string[] } {
    const pages = [...text.matchAll(/@CSPage\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const classes = [...text.matchAll(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).filter((n) => n.length >= 6);
    return { pages: [...new Set(pages)], classes: [...new Set(classes)] };
}

interface Aliases { base?: string; paths: Array<{ prefix: string; suffix: string; wildcard: boolean; targets: string[] }> }

/** tsconfig.json's baseUrl and paths (relative to the repository; comments and trailing commas allowed). */
export function tsAliases(root: string): Aliases {
    try {
        const raw = fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\/|(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
        const co = (JSON.parse(raw).compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
        const base = co.baseUrl ? path.posix.normalize(co.baseUrl.replace(/\\/g, '/')).replace(/^\.\/?/, '') : undefined;
        const paths = Object.entries(co.paths ?? {}).map(([k, v]) => {
            const i = k.indexOf('*');
            return { prefix: i < 0 ? k : k.slice(0, i), suffix: i < 0 ? '' : k.slice(i + 1), wildcard: i >= 0, targets: (v ?? []).map((t) => path.posix.join(base ?? '', t.replace(/\\/g, '/'))) };
        });
        return { base, paths };
    } catch { return { paths: [] }; }
}

/** The repository file an import names (null: a package, or not found). */
export function resolveImport(from: string, spec: string, has: (rel: string) => boolean, aliases: Aliases = { paths: [] }): string | null {
    const tryFile = (p: string): string | null => {
        const n = path.posix.normalize(p);
        if (n.startsWith('..')) return null;
        const stem = n.replace(/\.(js|jsx|mjs|cjs)$/i, '');
        for (const c of [n, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${n}.ts`, `${n}.tsx`, `${n}.js`, `${n}.mjs`, `${n}.cjs`, `${n}/index.ts`, `${n}/index.tsx`, `${n}/index.js`]) if (has(c)) return c;
        return null;
    };
    if (spec.startsWith('.')) return tryFile(path.posix.join(path.posix.dirname(from), spec));
    for (const a of aliases.paths) {
        if (a.wildcard ? spec.startsWith(a.prefix) && spec.endsWith(a.suffix) : spec === a.prefix) {
            const star = a.wildcard ? spec.slice(a.prefix.length, spec.length - a.suffix.length) : '';
            for (const t of a.targets) { const r = tryFile(t.replace('*', star)); if (r) return r; }
        }
    }
    if (aliases.base !== undefined) return tryFile(path.posix.join(aliases.base, spec));
    return null;
}

export interface Reach {
    /** Reached files (the changed ones included) and how: "imports X", "uses the page 'x' of X". */
    files: Map<string, string>;
}

/**
 * The files the changed files reach (see the module comment), with why.
 * `read` gives a file's text (null: not there); `files` is the code to look through.
 */
/** Who imports each file (read once, then used for every change). */
export interface ImportGraph { files: string[]; users: Map<string, string[]>; text: (rel: string) => string }

export function importGraph(files: string[], read: (rel: string) => string | null, aliases: Aliases = { paths: [] }): ImportGraph {
    const has = new Set(files);
    const texts = new Map<string, string>();
    const text = (f: string) => { if (!texts.has(f)) texts.set(f, read(f) ?? ''); return texts.get(f)!; };
    const users = new Map<string, string[]>();
    for (const f of files) {
        for (const spec of importsOf(text(f))) {
            const to = resolveImport(f, spec, (p) => has.has(p), aliases);
            if (to && to !== f) { const u = users.get(to) ?? []; u.push(f); users.set(to, u); }
        }
    }
    return { files, users, text };
}

export function reachedBy(changed: string[], files: string[], read: (rel: string) => string | null, aliases: Aliases = { paths: [] }, graph?: ImportGraph): Reach {
    const { users, text } = graph ?? importGraph(files, read, aliases);
    const files_ = new Map<string, string>();
    const queue: string[] = [];
    for (const c of changed) { files_.set(c, 'changed'); queue.push(c); }
    while (queue.length) {
        const f = queue.shift()!;
        const next: Array<[string, string]> = (users.get(f) ?? []).map((u) => [u, `imports ${f}`]);
        // By name: pages found by name, classes used without an import of the file.
        const t = CODE.test(f) ? text(f) : '';
        const { pages, classes } = t ? namesOf(t) : { pages: [], classes: [] };
        if (pages.length || classes.length) {
            const pageRe = pages.length ? new RegExp(`['"](${pages.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})['"]`) : null;
            const classRe = classes.length ? new RegExp(`\\b(${classes.join('|')})\\b`) : null;
            for (const g of files) {
                if (g === f || files_.has(g)) continue;
                const gt = text(g);
                const p = pageRe ? pageRe.exec(gt) : null;
                if (p && !/@CSPage\s*\(/.test(gt.slice(Math.max(0, p.index - 20), p.index))) { next.push([g, `uses the page '${p[1]}' of ${f}`]); continue; }
                const c = classRe ? classRe.exec(gt) : null;
                if (c) next.push([g, `uses ${c[1]} of ${f}`]);
            }
        }
        for (const [g, why] of next) if (!files_.has(g)) { files_.set(g, why); queue.push(g); }
    }
    return { files: files_ };
}

/** The chain from a reached file back to the change: "steps/a.ts uses the page 'login' of pages/Login.ts, which imports utils/x.ts". */
export function chainOf(reach: Reach, file: string, max = 6): string {
    const parts: string[] = [];
    let f: string | undefined = file;
    for (let i = 0; f && i < max; i++) {
        const why = reach.files.get(f);
        if (!why || why === 'changed') break;
        parts.push(why);
        f = /(?:imports|of) (\S+)$/.exec(why)?.[1];
    }
    return parts.join(', which ');
}
