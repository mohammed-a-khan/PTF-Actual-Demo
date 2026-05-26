/**
 * Agentic Test Platform — Skill Retriever (G1)
 *
 * BM25-filtered retrieval over the embedded `SKILL_INDEX`.
 *
 * The shipped framework currently inlines every skill that *might* be
 * relevant into the translate envelope. With 48 skills averaging ~3 KB
 * each, that approach blows past the per-message envelope cap on
 * Copilot Sonnet (~32 KB). The retriever lets the orchestrator emit
 * skill IDs in envelopes ("see po-frame-element, po-self-healing-element")
 * and the agent pulls the full skill text on demand via `csaa_retrieve_skills`.
 *
 * Substrate is BM25 over pre-tokenised bodies (no embeddings — the VDI
 * has no model server and no external embedding API). Filtering by
 * phase / fileKind / tags runs BEFORE scoring, so the search space for
 * a "translate a page-object that uses iframes" query collapses to
 * ~3 entries before BM25 ever runs.
 *
 * Consumer override: when `<workspaceRoot>/.cs-ai-skills/<name>/SKILL.md`
 * exists, it shadows the shipped skill of the same id. Lets a consumer
 * team add or replace skills without forking the framework.
 *
 * @module agent-platform/CSSkillRetriever
 */

import * as fs from 'fs';
import * as path from 'path';
import { SKILL_CONTENT, SKILL_INDEX, SkillIndexEntry } from '../skills/embeddedSkillContent';

// ============================================================================
// Public Types
// ============================================================================

export interface SkillSearchQuery {
    /** Pipeline phase to filter to. */
    phase?: string;
    /** Target file kind (page | steps | feature | data | …) — narrows translate-phase skills. */
    fileKind?: string;
    /** Tags the skill MUST have (AND semantics). */
    tags?: readonly string[];
    /** Free-text query scored against title + summary + body. */
    text?: string;
    /** Max results. Default 5. */
    k?: number;
}

export interface SkillSearchHit {
    id: string;
    title: string;
    summary: string;
    phase?: string;
    fileKind?: string;
    tags: readonly string[];
    /** BM25 score, or 1.0 when only filters were applied (no text query). */
    score: number;
}

// ============================================================================
// Constants — must mirror scripts/embed-skills.js
// ============================================================================

// Classic English stopwords only. Domain terms like `page`, `step`,
// `file`, `test` are deliberately KEPT — the skill corpus is heavily
// about pages/steps/files/tests, and filtering them out destroyed BM25
// recall for the most common queries.
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'are', 'use', 'used', 'using',
    'when', 'then', 'from', 'into', 'have', 'has', 'will', 'each', 'must',
    'not', 'but', 'all', 'any', 'one', 'two', 'see', 'per', 'via', 'than',
    'also', 'only', 'just', 'such', 'more', 'most', 'less', 'over', 'under',
    'about', 'these', 'those', 'their', 'them', 'they', 'you', 'your',
    'how', 'why', 'what', 'where', 'which', 'who',
    'after', 'before', 'while', 'until', 'because',
]);

// ============================================================================
// CSSkillRetriever
// ============================================================================

export class CSSkillRetriever {
    private static defaultInstance: CSSkillRetriever | undefined;

    private readonly entries: SkillIndexEntry[];
    private readonly docFreq: Map<string, number>;
    private readonly avgDocLength: number;

    private constructor(entries: SkillIndexEntry[]) {
        this.entries = entries;
        this.docFreq = new Map();
        let totalLength = 0;
        for (const e of entries) {
            totalLength += e.bodyLength;
            const seen = new Set<string>();
            for (const t of e.bodyTokens) {
                if (seen.has(t)) continue;
                seen.add(t);
                this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
            }
        }
        this.avgDocLength = entries.length > 0 ? totalLength / entries.length : 0;
    }

    /**
     * The default retriever loads from the shipped `SKILL_INDEX`. Reused
     * across calls — the index is immutable for the process lifetime.
     */
    public static getDefault(): CSSkillRetriever {
        if (!CSSkillRetriever.defaultInstance) {
            CSSkillRetriever.defaultInstance = new CSSkillRetriever(
                Object.values(SKILL_INDEX),
            );
        }
        return CSSkillRetriever.defaultInstance;
    }

    /**
     * Build a retriever that prefers consumer-supplied skills from
     * `<workspaceRoot>/.cs-ai-skills/` when present. Override skills
     * with the same id as a shipped skill REPLACE the shipped entry.
     */
    public static fromWorkspace(workspaceRoot: string): CSSkillRetriever {
        const overrideDir = path.join(workspaceRoot, '.cs-ai-skills');
        if (!fs.existsSync(overrideDir)) {
            return CSSkillRetriever.getDefault();
        }
        const overrides = CSSkillRetriever.loadOverrides(overrideDir);
        if (overrides.size === 0) {
            return CSSkillRetriever.getDefault();
        }
        const shipped = Object.values(SKILL_INDEX);
        const merged = [
            ...shipped.filter((s) => !overrides.has(s.id)),
            ...overrides.values(),
        ];
        return new CSSkillRetriever(merged);
    }

    /**
     * Two-stage retrieval — filter first, then BM25 score the survivors.
     * Returns top-K. Body text is NOT included; the caller fetches it via
     * `getBody(id)` (or the MCP tool returns it inline).
     */
    public search(query: SkillSearchQuery): SkillSearchHit[] {
        const k = query.k ?? 5;

        // Stage 1: structured filter.
        let candidates = this.entries;
        if (query.phase) {
            const wanted = query.phase;
            candidates = candidates.filter((e) => e.phase === wanted);
        }
        if (query.fileKind) {
            const wanted = query.fileKind;
            candidates = candidates.filter((e) => e.fileKind === wanted);
        }
        if (query.tags && query.tags.length > 0) {
            const wantedTags = query.tags;
            candidates = candidates.filter((e) =>
                wantedTags.every((t) => e.tags.includes(t)),
            );
        }

        // Stage 2: score.
        const text = (query.text ?? '').trim();
        let scored: Array<{ entry: SkillIndexEntry; score: number }>;
        if (text.length > 0) {
            const queryTokens = CSSkillRetriever.tokenize(text);
            scored = candidates.map((e) => ({
                entry: e,
                score: this.bm25Score(queryTokens, e),
            }));
            scored = scored.filter((s) => s.score > 0);
        } else {
            // No free-text query — return filter results in id order.
            scored = candidates.map((e) => ({ entry: e, score: 1 }));
        }

        scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

        return scored.slice(0, k).map(({ entry, score }) => ({
            id: entry.id,
            title: entry.title,
            summary: entry.summary,
            phase: entry.phase,
            fileKind: entry.fileKind,
            tags: entry.tags,
            score: Math.round(score * 1000) / 1000,
        }));
    }

    /**
     * Fetch the full `SKILL.md` body for a given skill id. Returns empty
     * string if the id is unknown.
     *
     * Consumer overrides (loaded via `fromWorkspace`) carry their own body
     * on the entry via `__overrideBody`. When present, the override body
     * wins over the shipped `SKILL_CONTENT` entry of the same id.
     */
    public getBody(id: string): string {
        const entry = this.entries.find((e) => e.id === id) as
            | (SkillIndexEntry & { __overrideBody?: string })
            | undefined;
        if (entry?.__overrideBody) return entry.__overrideBody;
        return SKILL_CONTENT[id]?.['SKILL.md'] ?? '';
    }

    /** All skill ids the retriever can serve. Useful for sanity checks + smoke. */
    public listIds(): string[] {
        return this.entries.map((e) => e.id).sort();
    }

    // ------------------------------------------------------------------
    // BM25
    // ------------------------------------------------------------------

    private bm25Score(queryTokens: string[], entry: SkillIndexEntry): number {
        const K1 = 1.2;
        const B = 0.75;
        const docLen = entry.bodyLength || 1;
        const avgLen = this.avgDocLength || 1;
        const totalDocs = this.entries.length;

        // Pre-count term frequencies in the document.
        const tf = new Map<string, number>();
        for (const t of entry.bodyTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

        let score = 0;
        for (const qt of queryTokens) {
            const termFreq = tf.get(qt) ?? 0;
            if (termFreq === 0) continue;
            const df = this.docFreq.get(qt) ?? 0;
            const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
            const numerator = termFreq * (K1 + 1);
            const denominator = termFreq + K1 * (1 - B + B * (docLen / avgLen));
            score += idf * (numerator / denominator);
        }
        return score;
    }

    // ------------------------------------------------------------------
    // Static helpers
    // ------------------------------------------------------------------

    private static tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/`[^`]*`/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    }

    private static loadOverrides(
        dir: string,
    ): Map<string, SkillIndexEntry & { __overrideBody?: string }> {
        const out = new Map<string, SkillIndexEntry & { __overrideBody?: string }>();
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return out;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const mdPath = path.join(dir, e.name, 'SKILL.md');
            if (!fs.existsSync(mdPath)) continue;
            let raw: string;
            try {
                raw = fs.readFileSync(mdPath, 'utf-8');
            } catch {
                continue;
            }
            const indexEntry = CSSkillRetriever.buildOverrideEntry(e.name, raw);
            out.set(e.name, indexEntry);
        }
        return out;
    }

    private static buildOverrideEntry(
        skillName: string,
        skillMdText: string,
    ): SkillIndexEntry & { __overrideBody: string } {
        const { meta, body } = CSSkillRetriever.parseFrontmatter(skillMdText);
        const tokens = CSSkillRetriever.tokenize(
            `${meta.name ?? skillName} ${meta.description ?? ''} ${body}`,
        );
        // Use phase/fileKind/tags explicitly declared in the override's
        // frontmatter only. Naming-derived heuristics are bypassed here so
        // the override is fully self-describing.
        const tags = Array.isArray(meta.tags)
            ? meta.tags
            : typeof meta.tags === 'string'
                ? [meta.tags]
                : [];
        return {
            id: skillName,
            title: (meta.name as string) ?? skillName,
            summary: (meta.description as string) ?? '',
            phase: meta.phase as string | undefined,
            fileKind: (meta.fileKind ?? meta.file_kind) as string | undefined,
            tags,
            bodyTokens: tokens,
            bodyLength: tokens.length,
            __overrideBody: skillMdText,
        };
    }

    private static parseFrontmatter(
        text: string,
    ): { meta: Record<string, string | string[]>; body: string } {
        if (!text.startsWith('---')) return { meta: {}, body: text };
        const closing = text.indexOf('\n---', 3);
        if (closing === -1) return { meta: {}, body: text };
        const block = text.slice(3, closing).trim();
        const body = text.slice(closing + 4).replace(/^\s*\n/, '');
        const meta: Record<string, string | string[]> = {};
        for (const rawLine of block.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
            if (!m) continue;
            const key = m[1];
            const value = m[2].trim();
            const arrMatch = /^\[(.*)\]$/.exec(value);
            if (arrMatch) {
                meta[key] = arrMatch[1]
                    .split(',')
                    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                    .filter((s) => s.length > 0);
            } else {
                meta[key] = value.replace(/^['"]|['"]$/g, '');
            }
        }
        return { meta, body };
    }

    /**
     * Test-only: reset the cached singleton so a smoke test can rebuild
     * the index after touching skill files. Not part of the public API.
     */
    public static __resetForTest(): void {
        CSSkillRetriever.defaultInstance = undefined;
    }
}
