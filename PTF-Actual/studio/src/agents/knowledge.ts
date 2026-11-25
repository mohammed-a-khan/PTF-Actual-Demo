/**
 * Knowledge: what agents look up before they act, with the source of every answer.
 *
 *  - Sources (the team's, .cs-studio/knowledge.json, committed): this repository (features, steps, pages, data,
 *    configuration, documents), other folders on this computer (the application's code, a documentation folder),
 *    the Azure DevOps wiki, work items (a query), what earlier runs, triage and missions learned, and web pages.
 *  - The index is built on this computer, with no service and no model (it works on a closed network): documents are
 *    cut into passages by their shape (Markdown by headings, features by scenarios, code by blocks of lines, one
 *    passage per work item), and searched with BM25 over words split the way code names them (loginPage → login,
 *    page). Secret values are masked before anything is stored.
 *  - Agents search with knowledge_search and read with knowledge_read; every result names its source and place, so
 *    an agent's answer can cite it ([K:id]) and a person can check it.
 *  - The index updates incrementally: an unchanged document is not cut again.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ToolDef } from './tools';
import { checkVersion, fileVersion } from './version';

export type SourceKind = 'repo' | 'folder' | 'ado-wiki' | 'ado-workitems' | 'history' | 'url';
export interface KnowledgeSource {
    id: string; name: string; kind: SourceKind; enabled?: boolean;
    /** folder: an absolute folder, or relative to the repository. */
    path?: string;
    /** repo / folder: only these sub-folders (relative); none: everything readable. */
    include?: string[];
    /** ado-workitems: a WIQL query (default: stories, bugs and test cases changed in the last 180 days). */
    query?: string;
    /** ado-wiki: the wiki's name (default: the project wiki). */
    wiki?: string;
    /** url: web pages. */
    urls?: string[];
    /** Azure DevOps sources: which framework project's settings to use (default: the first). */
    project?: string;
}
export interface KnowledgeDoc { path: string; title: string; text: string; type: DocType; url?: string }
export type DocType = 'markdown' | 'feature' | 'code' | 'data' | 'text' | 'workitem' | 'wiki' | 'learned' | 'web';
export interface Chunk { id: string; source: string; path: string; title: string; type: DocType; lines?: [number, number]; url?: string; text: string }
export interface Hit { id: string; source: string; sourceName: string; path: string; title: string; type: DocType; lines?: [number, number]; url?: string; score: number; snippet: string }

export const KNOWLEDGE_FILE = '.cs-studio/knowledge.json';
export const DEFAULT_SOURCES: KnowledgeSource[] = [
    { id: 'repo', name: 'This repository', kind: 'repo', enabled: true },
    { id: 'history', name: 'What earlier runs and missions learned', kind: 'history', enabled: true },
];

/** What only the server can fetch: Azure DevOps, the learned history, web pages. */
export interface KnowledgeFetchers {
    workItems?: (s: KnowledgeSource) => Promise<KnowledgeDoc[]>;
    wiki?: (s: KnowledgeSource) => Promise<KnowledgeDoc[]>;
    history?: () => KnowledgeDoc[];
    web?: (url: string) => Promise<{ title: string; text: string }>;
    mask?: (t: string) => string;
}

// ------------------------------------------------------------------------------------------------ words

const STOP = new Set('a an and are as at be but by for from has have in is it its of on or that the this to was were will with not no yes if then else when than into out up do does did can could should would i you we they he she them our your their there here what which who how why also just only very via per'.split(' '));
/** Words of a text, split as code names them (loginPage, LOGIN_PAGE, login-page → login, page) plus the whole name. */
/** Scripts written without spaces between words: each character, and each pair of characters, is a term. */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
export function words(text: string): string[] {
    const out: string[] = [];
    // Other languages (Arabic, Hebrew, Cyrillic, Greek, Devanagari, accented Latin…): their words as written, lower case.
    for (const raw of text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
        if (/^[A-Za-z0-9]+$/.test(raw)) continue;
        if (NO_SPACES.test(raw)) {
            const chars = [...raw];
            for (let i = 0; i < chars.length; i++) { out.push(chars[i].toLowerCase()); if (i + 1 < chars.length) out.push((chars[i] + chars[i + 1]).toLowerCase()); }
        } else if (/[^\x00-\x7f]/.test(raw)) out.push(raw.normalize('NFC').toLowerCase());
    }
    // Emoji: each is a term.
    for (const e of text.match(/\p{Extended_Pictographic}/gu) ?? []) out.push(e);
    for (const raw of text.match(/[A-Za-z0-9_]+/g) ?? []) {
        const whole = raw.toLowerCase();
        const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[_\s]+/).map((p) => p.toLowerCase()).filter(Boolean);
        for (const p of parts) if (p.length > 1 && !STOP.has(p)) out.push(stem(p));
        if (parts.length > 1 && whole.length > 2) out.push(whole.replace(/_/g, ''));
    }
    return out;
}
/** A light stemmer: plurals and common endings, so "orders" finds "order" and "failing" finds "fail". */
function stem(w: string): string {
    if (w.length <= 4 || /^\d+$/.test(w)) return w;
    return w.replace(/(ies)$/, 'y').replace(/(ing|ed)$/, '').replace(/(es|s)$/, '') || w;
}

// ------------------------------------------------------------------------------------------------ passages

const MAX = 1400;
function byLines(doc: KnowledgeDoc, per: number, overlap: number): Array<{ text: string; lines: [number, number] }> {
    const lines = doc.text.split('\n');
    const out: Array<{ text: string; lines: [number, number] }> = [];
    for (let i = 0; i < lines.length; i += per - overlap) {
        const part = lines.slice(i, i + per).join('\n').trim();
        if (part) out.push({ text: part.slice(0, MAX * 2), lines: [i + 1, Math.min(lines.length, i + per)] });
        if (i + per >= lines.length) break;
    }
    return out;
}
/** Passages of a document by its shape. */
export function passages(doc: KnowledgeDoc): Array<{ text: string; lines?: [number, number]; title?: string }> {
    if (doc.type === 'workitem' || doc.type === 'learned') return [{ text: doc.text.slice(0, MAX * 3) }];
    if (doc.type === 'markdown' || doc.type === 'wiki' || doc.type === 'web') {
        const lines = doc.text.split('\n');
        const out: Array<{ text: string; lines: [number, number]; title?: string }> = [];
        let start = 0, heading = '';
        const flush = (end: number) => {
            const text = lines.slice(start, end).join('\n').trim();
            if (!text) return;
            for (let k = 0; k < text.length; k += MAX) out.push({ text: text.slice(k, k + MAX), lines: [start + 1, end], ...(heading ? { title: heading } : {}) });
        };
        lines.forEach((l, i) => { const h = /^#{1,4}\s+(.+)/.exec(l); if (h && i > start) { flush(i); start = i; heading = h[1].trim(); } else if (h) heading = h[1].trim(); });
        flush(lines.length);
        return out;
    }
    if (doc.type === 'feature') {
        const lines = doc.text.split('\n');
        const head: string[] = [];
        const out: Array<{ text: string; lines: [number, number]; title?: string }> = [];
        let start = -1, name = '', seenFeature = false;
        const flush = (end: number) => { if (start >= 0) out.push({ text: `${head.join('\n')}\n${lines.slice(start, end).join('\n')}`.trim().slice(0, MAX * 2), lines: [start + 1, end], title: name }); };
        lines.forEach((l, i) => {
            const m = /^\s*(Scenario(?: Outline)?|Background|Rule):\s*(.*)/.exec(l);
            if (m) { flush(i); start = i; name = m[2] || m[1]; while (start > 0 && /^\s*@/.test(lines[start - 1])) start--; }
            // The feature's line and its own tags (the ones before it) go with every scenario; a scenario's tags are its own.
            else if (start < 0 && (/^\s*Feature:/.test(l) || (!seenFeature && /^\s*@/.test(l)))) { head.push(l.trim()); if (/^\s*Feature:/.test(l)) seenFeature = true; }
        });
        flush(lines.length);
        return out.length ? out : byLines(doc, 60, 8);
    }
    return byLines(doc, doc.type === 'data' ? 80 : 60, 8);
}

// ------------------------------------------------------------------------------------------------ files

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'reports', 'test-results', 'coverage', '.flaky-test-data', '.next', '.cache', 'bin', 'obj', 'target', 'vendor', '__pycache__']);
const TYPES: Array<[RegExp, DocType]> = [
    [/\.(md|markdown|mdx|adoc|rst)$/i, 'markdown'], [/\.feature$/i, 'feature'],
    [/\.(ts|tsx|js|jsx|mjs|cjs|java|cs|py|go|rb|kt|swift|php|scala|sql|ps1|sh|groovy|vue|svelte)$/i, 'code'],
    [/\.(json|ya?ml|env|properties|xml|csv|toml|ini|graphql|proto|html?)$/i, 'data'], [/\.(txt|log)$/i, 'text'],
];
export function docType(file: string): DocType | null { return TYPES.find(([re]) => re.test(file))?.[1] ?? null; }

/** Readable documents under a folder (only the included sub-folders), relative paths. */
export function readFolder(root: string, include: string[] | undefined, max = 20000): KnowledgeDoc[] {
    const out: KnowledgeDoc[] = [];
    const starts = include?.length ? include.map((p) => path.resolve(root, p)).filter((p) => (p + path.sep).startsWith(path.resolve(root) + path.sep) || p === path.resolve(root)) : [root];
    const walk = (dir: string, depth: number) => {
        if (depth > 14 || out.length >= max) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (out.length >= max) return;
            if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.cs-studio')) continue;
            const abs = path.join(dir, e.name);
            // Agents' evaluation cases are their answer key: never something an agent can look up.
            if (e.isDirectory() && e.name === 'evals' && path.basename(dir) === '.cs-studio') continue;
            if (e.isDirectory()) { walk(abs, depth + 1); continue; }
            const type = docType(e.name);
            if (!type || /\.min\.(js|css)$|lock(\.json)?$|\.map$/.test(e.name)) continue;
            let st: fs.Stats;
            try { st = fs.statSync(abs); } catch { continue; }
            if (st.size > 1_000_000 || st.size === 0) continue;
            let text = '';
            try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
            if (text.includes('\u0000')) continue;
            if (/\.html?$/i.test(e.name)) text = htmlText(text);
            const rel = path.relative(root, abs).split(path.sep).join('/');
            out.push({ path: rel, title: rel, text, type: /\.html?$/i.test(e.name) ? 'web' : type });
        }
    };
    for (const s of starts) { try { if (fs.statSync(s).isDirectory()) walk(s, 0); } catch { /* gone */ } }
    return out;
}

export function htmlText(html: string): string {
    return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<(h[1-4])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, h, t) => `\n${'#'.repeat(Number(h[1]))} ${t.replace(/<[^>]+>/g, '').trim()}\n`)
        .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------------------------------------------ the index

interface SourceIndex { source: string; builtAt: string; docs: Record<string, string>; chunks: Chunk[]; errors?: string[] }
interface Posting { tf: Map<string, number>; len: number }

export class KnowledgeBase {
    private loaded = new Map<string, SourceIndex>();
    private postings = new Map<string, Posting>();
    private df = new Map<string, number>();
    private avg = 1;
    private dirty = true;
    building: { source: string; done: number; total: number } | null = null;

    constructor(private readonly repoRoot: string, private readonly dir: string, private readonly f: KnowledgeFetchers = {}) {}

    /** The team's sources (the file), or the defaults. */
    /**
     * The team's sources (the file), or the defaults. An entry that is not right is left out by itself (the others
     * still work) and named in `invalid`; a file that cannot be read at all is `unreadable` (the defaults are used).
     */
    sources(): { sources: KnowledgeSource[]; problems: string[]; invalid: InvalidSource[]; unreadable?: boolean } {
        const file = path.join(this.repoRoot, KNOWLEDGE_FILE);
        if (!fs.existsSync(file)) return { sources: DEFAULT_SOURCES, problems: [], invalid: [] };
        let raw: unknown;
        try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
            return { sources: DEFAULT_SOURCES, problems: [`${KNOWLEDGE_FILE} cannot be read (${(e as Error).message}): the default sources are used, and nothing is saved until the file is fixed.`], invalid: [], unreadable: true };
        }
        const list = raw && typeof raw === 'object' ? (raw as { sources?: unknown }).sources ?? [] : raw;
        if (!Array.isArray(list)) return { sources: DEFAULT_SOURCES, problems: [`${KNOWLEDGE_FILE}: "sources" is not a list: the default sources are used, and nothing is saved until the file is fixed.`], invalid: [], unreadable: true };
        const r = readSources(list);
        const problems = r.invalid.length ? [`${KNOWLEDGE_FILE}: ${r.invalid.length === 1 ? '1 source is' : `${r.invalid.length} sources are`} left out until fixed (the others work): ${r.invalid.map((x) => `"${x.name}" — ${x.problem}`).join(' ')} Changes to the sources are saved once it is fixed or removed.`] : [];
        return { sources: r.sources, problems, invalid: r.invalid };
    }
    /** Remove an entry that is not right (by its place in the file); the other entries stay exactly as written. */
    removeInvalid(index: number): void {
        const cur = this.sources();
        if (cur.unreadable) throw new Error(cur.problems[0]);
        if (!cur.invalid.some((x) => x.index === index)) throw new Error('That entry is not among the ones left out (the file changed meanwhile?): reload.');
        const file = path.join(this.repoRoot, KNOWLEDGE_FILE);
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { sources: unknown[] };
        raw.sources = raw.sources.filter((_, i) => i !== index);
        fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
        this.dirty = true;
    }
    /** The version of the sources file the screen reads (sent back when it saves). */
    version(): string { return fileVersion(path.join(this.repoRoot, KNOWLEDGE_FILE)); }
    /** A folder source whose folder is not there (relative paths are from the repository), or null. */
    folderProblem(x: KnowledgeSource): string | null {
        if (x.kind !== 'folder' || !x.path) return null;
        const abs = path.resolve(this.repoRoot, x.path);
        let ok = false;
        try { ok = fs.statSync(abs).isDirectory(); } catch { /* missing */ }
        return ok ? null : `The folder ${x.path} does not exist${path.isAbsolute(x.path) ? '' : ` (from the repository: ${abs})`}.`;
    }
    /**
     * Save the whole list. `version`: the version of the file the screen read; when it changed since, the save is
     * refused (ChangedElsewhere). A folder that is not there is refused only for a source added or changed now: a
     * source whose folder went missing stays as it is (flagged on its row) and does not block the other changes.
     */
    saveSources(list: unknown, version?: string): KnowledgeSource[] {
        // The whole list is written: while the file has entries the Studio cannot read, saving would drop them.
        checkVersion(this.version(), version, KNOWLEDGE_FILE);
        const cur = this.sources();
        if (cur.unreadable) throw new Error(cur.problems[0]);
        if (cur.invalid.length) throw new Error(`Not saved: ${KNOWLEDGE_FILE} has ${cur.invalid.length === 1 ? 'an entry' : `${cur.invalid.length} entries`} the Studio leaves out (${cur.invalid.map((x) => `"${x.name}"`).join(', ')}); saving now would delete ${cur.invalid.length === 1 ? 'it' : 'them'}. Fix the file, or remove ${cur.invalid.length === 1 ? 'that entry' : 'those entries'} first.`);
        const s = validateSources(list);
        // A folder must be there (relative paths are from the repository).
        for (const x of s) {
            const before = cur.sources.find((y) => y.id === x.id);
            if (before && before.kind === x.kind && before.path === x.path) continue;
            const p = this.folderProblem(x);
            if (p) throw new Error(`Source "${x.name}": ${p.charAt(0).toLowerCase()}${p.slice(1)}`);
        }
        const file = path.join(this.repoRoot, KNOWLEDGE_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify({ sources: s }, null, 2)}\n`);
        // Sources removed: their index goes too.
        for (const f of this.indexFiles()) if (!s.some((x) => `${x.id}.json` === path.basename(f))) { try { fs.rmSync(f); } catch { /* gone */ } this.loaded.delete(path.basename(f, '.json')); this.dirty = true; }
        return s;
    }

    private indexFiles(): string[] { try { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => path.join(this.dir, f)); } catch { return []; } }
    private load(id: string): SourceIndex | null {
        if (this.loaded.has(id)) return this.loaded.get(id)!;
        try { const v = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as SourceIndex; this.loaded.set(id, v); this.dirty = true; return v; } catch { return null; }
    }

    /** Per source: documents, passages, when it was built, problems. */
    status() {
        return this.sources().sources.map((s) => {
            const i = this.load(s.id);
            const missing = this.folderProblem(s);
            return { ...s, enabled: s.enabled !== false, docs: i ? Object.keys(i.docs).length : 0, chunks: i?.chunks.length ?? 0, builtAt: i?.builtAt ?? null, errors: i?.errors ?? [], ...(missing ? { warning: missing } : {}) };
        });
    }

    /** Build (or update) the index of one source, or of all enabled ones. */
    async build(only?: string): Promise<Array<{ source: string; docs: number; chunks: number; changed: number; errors: string[] }>> {
        const out = [];
        const all = this.sources().sources.filter((s) => s.enabled !== false && (!only || s.id === only));
        if (only && !all.length) throw new Error(`No enabled knowledge source "${only}".`);
        for (const s of all) {
            this.building = { source: s.name, done: 0, total: 0 };
            const errors: string[] = [];
            let docs: KnowledgeDoc[] = [];
            try { docs = await this.fetchSource(s); } catch (e) { errors.push((e as Error).message.split('\n')[0]); }
            const prev = this.load(s.id);
            const mask = this.f.mask ?? ((t: string) => t);
            const sigs: Record<string, string> = {};
            const chunks: Chunk[] = [];
            let changed = 0, n = 0;
            this.building.total = docs.length;
            for (const d of docs) {
                const sig = createHash('sha1').update(d.text).update(d.title).digest('hex').slice(0, 16);
                sigs[d.path] = sig;
                const reuse = prev && prev.docs[d.path] === sig ? prev.chunks.filter((c) => c.path === d.path) : null;
                if (reuse?.length) { for (const c of reuse) chunks.push({ ...c, id: `${s.id}:${n++}` }); }
                else {
                    changed++;
                    for (const p of passages(d)) chunks.push({ id: `${s.id}:${n++}`, source: s.id, path: d.path, title: p.title ? `${d.title} › ${p.title}` : d.title, type: d.type, ...(p.lines ? { lines: p.lines } : {}), ...(d.url ? { url: d.url } : {}), text: mask(p.text) });
                }
                this.building.done++;
            }
            const idx: SourceIndex = { source: s.id, builtAt: new Date().toISOString(), docs: sigs, chunks, ...(errors.length ? { errors } : {}) };
            fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(path.join(this.dir, `${s.id}.json`), JSON.stringify(idx));
            this.loaded.set(s.id, idx);
            this.dirty = true;
            out.push({ source: s.id, docs: docs.length, chunks: chunks.length, changed, errors });
        }
        this.building = null;
        return out;
    }

    private async fetchSource(s: KnowledgeSource): Promise<KnowledgeDoc[]> {
        switch (s.kind) {
            case 'repo': return readFolder(this.repoRoot, s.include);
            case 'folder': {
                if (!s.path) throw new Error('No folder given.');
                const root = path.resolve(this.repoRoot, s.path);
                if (!fs.existsSync(root)) throw new Error(`Folder not found: ${s.path}`);
                return readFolder(root, s.include);
            }
            case 'history': return this.f.history?.() ?? [];
            case 'ado-workitems': if (!this.f.workItems) throw new Error('Azure DevOps is not set up.'); return this.f.workItems(s);
            case 'ado-wiki': if (!this.f.wiki) throw new Error('Azure DevOps is not set up.'); return this.f.wiki(s);
            case 'url': {
                if (!this.f.web) throw new Error('Web pages cannot be read here.');
                const docs: KnowledgeDoc[] = [];
                for (const u of (s.urls ?? []).slice(0, 50)) {
                    try { const p = await this.f.web(u); docs.push({ path: u, title: p.title || u, text: p.text, type: 'web', url: u }); }
                    catch (e) { throw new Error(`${u}: ${(e as Error).message}`); }
                }
                return docs;
            }
            default: throw new Error(`Unknown source kind ${(s as KnowledgeSource).kind}.`);
        }
    }

    private reindex() {
        if (!this.dirty) return;
        for (const s of this.sources().sources) this.load(s.id);
        this.postings.clear(); this.df.clear();
        let total = 0, n = 0;
        const on = new Set(this.sources().sources.filter((s) => s.enabled !== false).map((s) => s.id));
        for (const [id, idx] of this.loaded) {
            if (!on.has(id)) continue;
            for (const c of idx.chunks) {
                const w = [...words(c.text), ...words(c.title), ...words(c.title), ...words(c.path)];
                const tf = new Map<string, number>();
                for (const x of w) tf.set(x, (tf.get(x) ?? 0) + 1);
                for (const k of tf.keys()) this.df.set(k, (this.df.get(k) ?? 0) + 1);
                this.postings.set(c.id, { tf, len: w.length });
                total += w.length; n++;
            }
        }
        this.avg = n ? total / n : 1;
        this.dirty = false;
    }

    private chunk(id: string): Chunk | undefined {
        const src = id.split(':')[0];
        return this.load(src)?.chunks.find((c) => c.id === id);
    }

    /** The best passages for a question (BM25), with their sources; optionally only some sources or types. */
    search(query: string, o: { k?: number; sources?: string[]; types?: DocType[] } = {}): Hit[] {
        this.reindex();
        const q = [...new Set(words(query))];
        if (!q.length) return [];
        const N = this.postings.size || 1;
        const names = new Map(this.sources().sources.map((s) => [s.id, s.name]));
        const scored: Array<{ id: string; score: number }> = [];
        for (const [id, p] of this.postings) {
            if (o.sources?.length && !o.sources.includes(id.split(':')[0])) continue;
            let score = 0, matched = 0;
            for (const t of q) {
                const f = p.tf.get(t);
                if (!f) continue;
                matched++;
                const df = this.df.get(t) ?? 0;
                const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
                score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (p.len / this.avg))));
            }
            // Passages matching more of the question's words first.
            if (score > 0) scored.push({ id, score: score * (0.5 + matched / q.length) });
        }
        scored.sort((a, b) => b.score - a.score);
        const out: Hit[] = [];
        const perDoc = new Map<string, number>();
        const seenText = new Set<string>();
        for (const s of scored) {
            if (out.length >= Math.min(o.k ?? 8, 30)) break;
            const c = this.chunk(s.id);
            if (!c || (o.types?.length && !o.types.includes(c.type))) continue;
            // The same text from several places (identical mission reports, copied documents): shown once.
            const same = c.text.replace(/\s+/g, ' ').replace(/\b[0-9a-z]{8,}\b/gi, '#').slice(0, 400);
            if (seenText.has(same)) continue;
            seenText.add(same);
            // At most two passages of one document: the results cover more places.
            const key = `${c.source}|${c.path}`;
            if ((perDoc.get(key) ?? 0) >= 2) continue;
            perDoc.set(key, (perDoc.get(key) ?? 0) + 1);
            out.push({ id: c.id, source: c.source, sourceName: names.get(c.source) ?? c.source, path: c.path, title: c.title, type: c.type, ...(c.lines ? { lines: c.lines } : {}), ...(c.url ? { url: c.url } : {}), score: Math.round(s.score * 100) / 100, snippet: snippet(c.text, q) });
        }
        return out;
    }

    /** A passage in full, with the ones around it in the same document. */
    read(id: string, around = 1): { id: string; path: string; title: string; source: string; url?: string; lines?: [number, number]; text: string } | null {
        const src = id.split(':')[0];
        const idx = this.load(src);
        const i = idx?.chunks.findIndex((c) => c.id === id) ?? -1;
        if (!idx || i < 0) return null;
        const c = idx.chunks[i];
        const same = idx.chunks.filter((x) => x.path === c.path);
        const at = same.indexOf(c);
        const part = same.slice(Math.max(0, at - around), at + around + 1);
        return { id, path: c.path, title: c.title, source: c.source, ...(c.url ? { url: c.url } : {}), ...(c.lines ? { lines: [part[0].lines?.[0] ?? c.lines[0], part[part.length - 1].lines?.[1] ?? c.lines[1]] as [number, number] } : {}), text: part.map((x) => x.text).join('\n…\n').slice(0, 12000) };
    }

    /** The agents' tools: search and read, limited to some sources (an agent's knowledge). */
    tools(onlySources?: string[]): ToolDef[] {
        const obj = (p: Record<string, unknown>, r: string[]) => ({ type: 'object', properties: p, required: r });
        const allowed = (ids?: string[]) => (onlySources?.length ? (ids?.length ? ids.filter((x) => onlySources.includes(x)) : onlySources) : ids);
        return [
            {
                name: 'knowledge_search', skipPermission: true,
                description: `Search the team's knowledge before you assume anything: ${this.sources().sources.filter((s) => s.enabled !== false && (!onlySources?.length || onlySources.includes(s.id))).map((s) => `${s.name} (${s.id})`).join(', ')}. Returns passages with their source, file and lines. Cite what you use as [K:<id>].`,
                parameters: obj({ query: { type: 'string', description: 'What you are looking for, in words (e.g. "how do we sign in to the shop as a buyer")' }, sources: { type: 'array', items: { type: 'string' } }, types: { type: 'array', items: { type: 'string', enum: ['markdown', 'feature', 'code', 'data', 'text', 'workitem', 'wiki', 'learned', 'web'] } }, k: { type: 'integer' } }, ['query']),
                handler: async (a: { query: string; sources?: string[]; types?: DocType[]; k?: number }) => {
                    const hits = this.search(String(a.query ?? ''), { k: a.k, sources: allowed(a.sources), types: a.types });
                    return hits.length ? hits : 'Nothing found: try other words, or another source.';
                },
            },
            {
                name: 'knowledge_read', skipPermission: true,
                description: 'Read a passage found with knowledge_search in full, with the passages around it.',
                parameters: obj({ id: { type: 'string' } }, ['id']),
                handler: async ({ id }: { id: string }) => {
                    if (onlySources?.length && !onlySources.includes(String(id).split(':')[0])) return 'That source is not available to this agent.';
                    return this.read(String(id)) ?? 'No such passage (search again: the index may have been rebuilt).';
                },
            },
        ];
    }
}

function snippet(text: string, q: string[]): string {
    const lines = text.split('\n');
    let best = 0, bestScore = -1;
    lines.forEach((l, i) => { const w = new Set(words(l)); const s = q.filter((t) => w.has(t)).length; if (s > bestScore) { bestScore = s; best = i; } });
    return lines.slice(Math.max(0, best - 1), best + 3).join('\n').slice(0, 400);
}

/** An entry of the file that is not right: its place in the file, what it is called, why. */
export interface InvalidSource { index: number; id: string; name: string; problem: string }
/** The entries that are right (in order) and the ones that are not (each checked against those before it). */
export function readSources(list: unknown[]): { sources: KnowledgeSource[]; invalid: InvalidSource[] } {
    const ok: unknown[] = [];
    const invalid: InvalidSource[] = [];
    list.forEach((x, index) => {
        try { validateSources([...ok, x]); ok.push(x); } catch (e) {
            const o = (x && typeof x === 'object' ? x : {}) as { id?: unknown; name?: unknown };
            invalid.push({ index, id: String(o.id ?? ''), name: String(o.name || o.id || `entry ${index + 1}`).slice(0, 80), problem: (e as Error).message });
        }
    });
    return { sources: validateSources(ok), invalid };
}

export function validateSources(list: unknown): KnowledgeSource[] {
    if (!Array.isArray(list)) throw new Error('sources must be a list.');
    if (list.length > 30) throw new Error('At most 30 knowledge sources.');
    const kinds: SourceKind[] = ['repo', 'folder', 'ado-wiki', 'ado-workitems', 'history', 'url'];
    const ids = new Set<string>();
    const seenKinds = new Map<string, string>();
    return list.map((x) => {
        const s = (x ?? {}) as KnowledgeSource;
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(s.id))) throw new Error(`Source id "${s.id ?? ''}": lower-case letters, digits and -.`);
        if (ids.has(s.id)) throw new Error(`Two sources have the id "${s.id}".`);
        ids.add(s.id);
        if (!kinds.includes(s.kind)) throw new Error(`Source "${s.id}": kind is one of ${kinds.join(', ')}.`);
        if (s.kind === 'folder' && !s.path?.trim()) throw new Error(`Source "${s.id}": the folder.`);
        if (s.kind === 'url') {
            if (!s.urls?.length) throw new Error(`Source "${s.id}": at least one web address.`);
            for (const u of s.urls) if (!/^https?:\/\/\S+$/.test(u)) throw new Error(`Source "${s.id}": not a web address: ${u}`);
        }
        // The same thing twice gives every result twice.
        const same = seenKinds.get(s.kind === 'folder' ? `folder:${String(s.path ?? '').trim()}` : s.kind === 'url' ? `url:${[...(s.urls ?? [])].sort().join(' ')}` : s.kind === 'ado-wiki' ? `wiki:${s.project ?? ''}:${s.wiki ?? ''}` : s.kind === 'ado-workitems' ? `wi:${s.project ?? ''}:${s.query ?? ''}` : s.kind);
        if (same) throw new Error(`"${s.name || s.id}" is the same as "${same}": each source once.`);
        seenKinds.set(s.kind === 'folder' ? `folder:${String(s.path ?? '').trim()}` : s.kind === 'url' ? `url:${[...(s.urls ?? [])].sort().join(' ')}` : s.kind === 'ado-wiki' ? `wiki:${s.project ?? ''}:${s.wiki ?? ''}` : s.kind === 'ado-workitems' ? `wi:${s.project ?? ''}:${s.query ?? ''}` : s.kind, s.name || s.id);
        if (s.include && (!Array.isArray(s.include) || s.include.some((p) => typeof p !== 'string' || p.includes('..')))) throw new Error(`Source "${s.id}": include is a list of sub-folders.`);
        return { id: s.id, name: String(s.name || s.id).slice(0, 80), kind: s.kind, enabled: s.enabled !== false,
            ...(s.path ? { path: String(s.path) } : {}), ...(s.include?.length ? { include: s.include.map(String) } : {}), ...(s.query ? { query: String(s.query).slice(0, 4000) } : {}),
            ...(s.wiki ? { wiki: String(s.wiki).slice(0, 200) } : {}), ...(s.urls?.length ? { urls: s.urls.slice(0, 50).map(String) } : {}), ...(s.project ? { project: String(s.project) } : {}) };
    });
}
