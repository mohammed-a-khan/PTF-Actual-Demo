/**
 * Agentic Test Platform — Source Grounder
 *
 * Reads a user-provided application source path and extracts canonical
 * locator candidates, message keys, and schema mappings. The output map
 * is consumed by the page-object composer / Gherkin translator so that
 * generated tests use *real* identifiers instead of inventions.
 *
 * The grounder degrades gracefully: when the source path is empty or
 * inaccessible, it returns an empty `SourceGroundingMap` and downstream
 * composers fall back to scaffold mode (with `@needs-source-validation`
 * tags on the generated artefacts).
 *
 * Privacy-by-design: the grounder never embeds full file contents in its
 * outputs — only the extracted locator/message strings.
 *
 * @module agent-platform/CSSourceGrounder
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext } from '../types/CSMCPTypes';

// ============================================================================
// Public Types
// ============================================================================

/**
 * One locator candidate. The `description` is a human-readable label
 * (e.g. "Login button"), `primaryLocator` is an XPath, and
 * `alternativeLocators` holds CSS fallbacks. `confidence` is 0..1; values
 * below 0.5 signal a fuzzy match the composer should mark as
 * `@needs-source-validation`.
 */
export interface SourceGroundedElement {
    description: string;
    primaryLocator: string;
    alternativeLocators: string[];
    sourceFile: string;
    confidence: number;
}

/**
 * The full grounding map returned by `ground`.
 *
 * - `elements` — keyed by user-friendly description (lowercased)
 * - `messages` — bundle key → message text (e.g. validator messages)
 * - `schemas`  — entity name → schema metadata (table, columns, PK)
 */
export interface SourceGroundingMap {
    elements: Map<string, SourceGroundedElement>;
    messages: Map<string, string>;
    schemas: Map<
        string,
        { table: string; columns: string[]; primaryKey: string }
    >;
}

// ============================================================================
// File-type filters
// ============================================================================

/**
 * Extensions worth scanning for HTML/JSX-shaped locator candidates.
 */
const VIEW_EXTS = new Set([
    '.jsp', '.jspx',
    '.jsx', '.tsx',
    '.html', '.htm',
    '.vue',
    '.razor',
    '.cshtml',
    '.svelte',
]);

/**
 * Extensions for message bundles and validator definitions.
 */
const MESSAGE_EXTS = new Set([
    '.properties',
    '.resx',
    '.json',
]);

/**
 * Extensions for ORM mapping descriptors (Hibernate, Entity Framework).
 */
const SCHEMA_EXTS = new Set([
    '.hbm.xml',
    '.xml',
]);

/**
 * Hard caps to keep the grounder fast on huge code-bases. Files above
 * MAX_FILE_BYTES are sampled (head + grep) rather than fully read.
 */
const MAX_FILES_SCANNED = 2000;
const MAX_FILE_BYTES = 50 * 1024;
const HEAD_SAMPLE_LINES = 500;

// ============================================================================
// CSSourceGrounder
// ============================================================================

/**
 * Static grounder. The single public entry point is `ground`.
 */
export class CSSourceGrounder {
    /**
     * Walk `sourcePath` recursively, extract candidates, and fuzzy-match
     * them against the supplied `hints`.
     *
     * @param sourcePath  Directory containing app source. Empty/undefined
     *                    returns an empty map.
     * @param hints       User-friendly element/message names referenced
     *                    in the test steps.
     * @param context     MCP tool context (used only for logging).
     */
    public static async ground(
        sourcePath: string,
        hints: string[],
        context: MCPToolContext,
    ): Promise<SourceGroundingMap> {
        const map: SourceGroundingMap = {
            elements: new Map(),
            messages: new Map(),
            schemas: new Map(),
        };

        if (!sourcePath || sourcePath.trim().length === 0) {
            context.log('info', 'CSSourceGrounder: empty sourcePath; returning empty map');
            return map;
        }
        if (!CSSourceGrounder.safeIsDir(sourcePath)) {
            context.log(
                'warning',
                'CSSourceGrounder: sourcePath is not a readable directory',
                { sourcePath },
            );
            return map;
        }

        const files = CSSourceGrounder.collectFiles(sourcePath);
        context.log('info', 'CSSourceGrounder: scanning files', {
            sourcePath,
            fileCount: files.length,
        });

        const lowerHints = hints
            .map((h) => h.trim().toLowerCase())
            .filter((h) => h.length > 0);

        for (const f of files) {
            const ext = CSSourceGrounder.composedExt(f);
            try {
                const content = CSSourceGrounder.safeReadCapped(f, lowerHints);
                if (content === null) continue;

                if (VIEW_EXTS.has(ext)) {
                    CSSourceGrounder.extractElements(
                        f,
                        content,
                        lowerHints,
                        map,
                    );
                }
                if (MESSAGE_EXTS.has(ext)) {
                    CSSourceGrounder.extractMessages(content, ext, map);
                }
                if (SCHEMA_EXTS.has(ext) || f.endsWith('.hbm.xml')) {
                    CSSourceGrounder.extractSchemas(content, map);
                }
            } catch (err) {
                context.log('debug', 'CSSourceGrounder: file scan failed', {
                    file: f,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        context.log('info', 'CSSourceGrounder: grounding complete', {
            elements: map.elements.size,
            messages: map.messages.size,
            schemas: map.schemas.size,
        });
        return map;
    }

    // ========================================================================
    // File walking
    // ========================================================================

    /**
     * Recursive directory walk capped at MAX_FILES_SCANNED. Skips common
     * build / dependency directories.
     */
    private static collectFiles(root: string): string[] {
        const skipDirs = new Set([
            'node_modules', 'dist', 'build', 'out', 'target',
            '.git', '.svn', '.idea', '.vscode',
            'coverage', '__pycache__',
        ]);
        const out: string[] = [];
        const stack: string[] = [root];

        while (stack.length > 0 && out.length < MAX_FILES_SCANNED) {
            const cur = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(cur, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const e of entries) {
                if (out.length >= MAX_FILES_SCANNED) break;
                const full = path.join(cur, e.name);
                if (e.isDirectory()) {
                    if (skipDirs.has(e.name)) continue;
                    stack.push(full);
                } else if (e.isFile()) {
                    const ext = CSSourceGrounder.composedExt(full);
                    if (
                        VIEW_EXTS.has(ext) ||
                        MESSAGE_EXTS.has(ext) ||
                        SCHEMA_EXTS.has(ext) ||
                        full.endsWith('.hbm.xml')
                    ) {
                        out.push(full);
                    }
                }
            }
        }
        return out;
    }

    /**
     * Compute the "composed" extension (e.g. `.hbm.xml` instead of `.xml`)
     * so callers can distinguish ORM descriptors from generic XML.
     */
    private static composedExt(file: string): string {
        const lower = file.toLowerCase();
        if (lower.endsWith('.hbm.xml')) return '.hbm.xml';
        return path.extname(lower);
    }

    // ========================================================================
    // Element extraction (HTML / JSP / JSX shape)
    // ========================================================================

    /**
     * Extract candidate locators from a view-template file. We pick up:
     *
     *   id="..."           → //*[@id='...']
     *   data-testid="..."  → //*[@data-testid='...']
     *   name="..."         → //*[@name='...']
     *   aria-label="..."   → //*[@aria-label='...']
     *   <button>label</…   → //button[normalize-space(.)='label']
     *
     * Each candidate is fuzzy-matched against `hints`; matches with score
     * >= 0.5 are added to `map.elements`.
     */
    private static extractElements(
        sourceFile: string,
        content: string,
        hints: string[],
        map: SourceGroundingMap,
    ): void {
        const candidates: { description: string; xpath: string; alt: string[] }[] = [];

        const idRe = /\bid\s*=\s*"([^"<>]+)"/gi;
        let m: RegExpExecArray | null;
        while ((m = idRe.exec(content)) !== null) {
            const v = m[1];
            candidates.push({
                description: v,
                xpath: `//*[@id='${CSSourceGrounder.escXPathLiteral(v)}']`,
                alt: [`css:#${CSSourceGrounder.escCssId(v)}`],
            });
        }

        const testIdRe = /\bdata-testid\s*=\s*"([^"<>]+)"/gi;
        while ((m = testIdRe.exec(content)) !== null) {
            const v = m[1];
            candidates.push({
                description: v,
                xpath: `//*[@data-testid='${CSSourceGrounder.escXPathLiteral(v)}']`,
                alt: [`css:[data-testid='${v}']`],
            });
        }

        const nameRe = /\bname\s*=\s*"([^"<>]+)"/gi;
        while ((m = nameRe.exec(content)) !== null) {
            const v = m[1];
            candidates.push({
                description: v,
                xpath: `//*[@name='${CSSourceGrounder.escXPathLiteral(v)}']`,
                alt: [`css:[name='${v}']`],
            });
        }

        const ariaRe = /\baria-label\s*=\s*"([^"<>]+)"/gi;
        while ((m = ariaRe.exec(content)) !== null) {
            const v = m[1];
            candidates.push({
                description: v,
                xpath: `//*[@aria-label='${CSSourceGrounder.escXPathLiteral(v)}']`,
                alt: [`css:[aria-label='${v}']`],
            });
        }

        const btnRe = /<button\b[^>]*>([^<]{1,80})<\/button>/gi;
        while ((m = btnRe.exec(content)) !== null) {
            const label = m[1].trim();
            if (label.length === 0) continue;
            candidates.push({
                description: label,
                xpath: `//button[normalize-space(.)='${CSSourceGrounder.escXPathLiteral(label)}']`,
                alt: [],
            });
        }

        const lblRe = /<label\b[^>]*>([^<]{1,120})<\/label>/gi;
        while ((m = lblRe.exec(content)) !== null) {
            const label = m[1].trim();
            if (label.length === 0) continue;
            candidates.push({
                description: label,
                xpath: `//label[normalize-space(.)='${CSSourceGrounder.escXPathLiteral(label)}']`,
                alt: [],
            });
        }

        // Score candidates against hints. We add the best-scoring candidate
        // per hint to the output map; raw candidates with no hint match are
        // also kept under their raw description so the composer can find
        // them via direct lookup.
        for (const c of candidates) {
            const key = c.description.toLowerCase();
            if (!map.elements.has(key)) {
                map.elements.set(key, {
                    description: c.description,
                    primaryLocator: c.xpath,
                    alternativeLocators: c.alt,
                    sourceFile,
                    confidence: 0.6,
                });
            }
        }

        for (const h of hints) {
            const best = CSSourceGrounder.bestFuzzyMatch(h, candidates);
            if (best && best.score >= 0.5) {
                map.elements.set(h, {
                    description: best.cand.description,
                    primaryLocator: best.cand.xpath,
                    alternativeLocators: best.cand.alt,
                    sourceFile,
                    confidence: Math.min(0.95, best.score),
                });
            }
        }
    }

    // ========================================================================
    // Message extraction (resource bundles)
    // ========================================================================

    /**
     * Extract `key=value` pairs from a `.properties` / `.resx` / `.json`
     * resource bundle. JSON bundles are flattened with a dotted key.
     */
    private static extractMessages(
        content: string,
        ext: string,
        map: SourceGroundingMap,
    ): void {
        if (ext === '.json') {
            try {
                const parsed = JSON.parse(content);
                CSSourceGrounder.flattenJsonMessages(parsed, '', map);
            } catch {
                // Non-strict JSON — skip silently.
            }
            return;
        }

        if (ext === '.properties') {
            const lines = content.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) {
                    continue;
                }
                const eq = trimmed.indexOf('=');
                if (eq < 0) continue;
                const key = trimmed.slice(0, eq).trim();
                const val = trimmed.slice(eq + 1).trim();
                if (key.length > 0 && val.length > 0) {
                    map.messages.set(key, val);
                }
            }
            return;
        }

        if (ext === '.resx') {
            const dataRe =
                /<data\s+name\s*=\s*"([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>/gi;
            let m: RegExpExecArray | null;
            while ((m = dataRe.exec(content)) !== null) {
                const key = m[1].trim();
                const val = m[2].trim();
                if (key && val) map.messages.set(key, val);
            }
        }
    }

    /**
     * Recursively flatten a parsed JSON message bundle into dotted keys.
     */
    private static flattenJsonMessages(
        node: unknown,
        prefix: string,
        map: SourceGroundingMap,
    ): void {
        if (node === null || node === undefined) return;
        if (typeof node === 'string') {
            if (prefix.length > 0) map.messages.set(prefix, node);
            return;
        }
        if (typeof node === 'object' && !Array.isArray(node)) {
            for (const [k, v] of Object.entries(node)) {
                const nextKey = prefix.length > 0 ? `${prefix}.${k}` : k;
                CSSourceGrounder.flattenJsonMessages(v, nextKey, map);
            }
        }
    }

    // ========================================================================
    // Schema extraction (Hibernate / EF mapping)
    // ========================================================================

    /**
     * Extract `{ table, columns[], primaryKey }` triples from a Hibernate
     * `.hbm.xml` mapping descriptor. Other XML shapes are silently ignored.
     */
    private static extractSchemas(
        content: string,
        map: SourceGroundingMap,
    ): void {
        const classRe =
            /<class\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*\btable\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/class>/gi;
        let m: RegExpExecArray | null;
        while ((m = classRe.exec(content)) !== null) {
            const fqName = m[1];
            const table = m[2];
            const inner = m[3];
            const entity = fqName.split('.').pop() ?? fqName;

            const columns: string[] = [];
            let primaryKey = '';
            const idRe = /<id\b[^>]*\bcolumn\s*=\s*"([^"]+)"/i;
            const idM = idRe.exec(inner);
            if (idM) {
                primaryKey = idM[1];
                columns.push(idM[1]);
            }

            const propRe =
                /<property\b[^>]*\bcolumn\s*=\s*"([^"]+)"/gi;
            let pm: RegExpExecArray | null;
            while ((pm = propRe.exec(inner)) !== null) {
                if (!columns.includes(pm[1])) columns.push(pm[1]);
            }

            map.schemas.set(entity, { table, columns, primaryKey });
        }
    }

    // ========================================================================
    // Fuzzy matching
    // ========================================================================

    /**
     * Pick the best-scoring candidate for a given hint. Score is the
     * Sørensen–Dice coefficient over lowercased character bigrams, plus a
     * small substring bonus.
     */
    private static bestFuzzyMatch(
        hint: string,
        candidates: { description: string; xpath: string; alt: string[] }[],
    ): { cand: { description: string; xpath: string; alt: string[] }; score: number } | null {
        let best: { cand: { description: string; xpath: string; alt: string[] }; score: number } | null = null;
        for (const c of candidates) {
            const score = CSSourceGrounder.scorePair(hint, c.description.toLowerCase());
            if (!best || score > best.score) {
                best = { cand: c, score };
            }
        }
        return best;
    }

    /**
     * Pair similarity score in [0, 1].
     */
    private static scorePair(a: string, b: string): number {
        if (!a || !b) return 0;
        const x = a.toLowerCase().trim();
        const y = b.toLowerCase().trim();
        if (x === y) return 1;
        const dice = CSSourceGrounder.dice(x, y);
        let bonus = 0;
        if (x.includes(y) || y.includes(x)) bonus = 0.15;
        return Math.min(1, dice + bonus);
    }

    /**
     * Sørensen–Dice coefficient over character bigrams.
     */
    private static dice(a: string, b: string): number {
        const aGrams = CSSourceGrounder.bigrams(a);
        const bGrams = CSSourceGrounder.bigrams(b);
        if (aGrams.size === 0 || bGrams.size === 0) return 0;
        let inter = 0;
        for (const g of aGrams) {
            if (bGrams.has(g)) inter += 1;
        }
        return (2 * inter) / (aGrams.size + bGrams.size);
    }

    private static bigrams(s: string): Set<string> {
        const out = new Set<string>();
        for (let i = 0; i + 1 < s.length; i++) {
            out.add(s.slice(i, i + 2));
        }
        return out;
    }

    // ========================================================================
    // I/O helpers
    // ========================================================================

    /**
     * Read a file with a hard byte cap. For files exceeding the cap, we
     * read the head plus any lines that contain a hint keyword.
     */
    private static safeReadCapped(file: string, hints: string[]): string | null {
        try {
            const stat = fs.statSync(file);
            if (stat.size <= MAX_FILE_BYTES) {
                return fs.readFileSync(file, 'utf-8');
            }
            // Sampled read: head plus hint-grep.
            const fd = fs.openSync(file, 'r');
            try {
                const buf = Buffer.alloc(MAX_FILE_BYTES);
                fs.readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
                let head = buf.toString('utf-8');
                const lines = head.split(/\r?\n/).slice(0, HEAD_SAMPLE_LINES);
                head = lines.join('\n');
                if (hints.length === 0) return head;
                // Best-effort grep tail — read a second window scanning for hints.
                const tailBuf = Buffer.alloc(MAX_FILE_BYTES);
                const tailPos = Math.max(0, stat.size - MAX_FILE_BYTES);
                fs.readSync(fd, tailBuf, 0, MAX_FILE_BYTES, tailPos);
                const tail = tailBuf.toString('utf-8');
                const tailLines = tail
                    .split(/\r?\n/)
                    .filter((l) => hints.some((h) => l.toLowerCase().includes(h)));
                return head + '\n' + tailLines.join('\n');
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return null;
        }
    }

    private static safeIsDir(p: string): boolean {
        try {
            return fs.existsSync(p) && fs.statSync(p).isDirectory();
        } catch {
            return false;
        }
    }

    private static escXPathLiteral(s: string): string {
        // XPath literals can't contain a single quote when delimited by
        // single quotes; we escape with the standard concat trick if needed.
        if (!s.includes("'")) return s;
        return s.replace(/'/g, "&apos;");
    }

    private static escCssId(s: string): string {
        // CSS id selectors must escape special characters.
        return s.replace(/([^A-Za-z0-9_-])/g, '\\$1');
    }
}
