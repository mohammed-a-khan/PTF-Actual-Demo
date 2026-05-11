/**
 * Agentic Test Platform — Semantic Reuse Matcher (Rebuild M7)
 *
 * Beyond exact-name match: ranks existing CS Playwright page-objects /
 * step-defs by *similarity* against a legacy candidate. Uses a cheap
 * fingerprint + Levenshtein-based distance, no embeddings, no LLM.
 *
 * Sufficient for "this legacy `<X>Page.java` looks like our existing
 * `<X>Page.ts` — reuse it" decisions. The translator (M8) consumes the
 * top-ranked match per legacy item; user confirmation is auto-applied
 * unless similarity is below threshold (default 0.6) in which case a
 * `create` decision wins.
 *
 * @module agent-platform/CSSemanticReuse
 */

import { CSRepoInventory, PageInventoryEntry, StepInventoryEntry } from './CSRepoInventory';

/**
 * Minimal shape required to compare a legacy/candidate page against
 * existing pages. Was previously imported from the deleted
 * CSLegacyAnalyzer; now declared locally so callers can construct
 * it from any analysis source (LLM-produced or otherwise).
 */
export interface PageObjectInfo {
    className: string;
    sourcePath?: string;
    elements: Array<{ name?: string; locator?: string }>;
    publicMethods: string[];
}

// ============================================================================
// Public Types
// ============================================================================

export interface ReuseCandidate {
    targetPath: string;
    targetId?: string;
    score: number;
    reason: string;
}

export interface PageReuseDecision {
    legacyClassName: string;
    decision: 'create' | 'reuse_existing' | 'merge';
    candidates: ReuseCandidate[];
    chosen?: ReuseCandidate;
}

export interface StepReuseDecision {
    suggestedPattern: string;
    decision: 'create' | 'reuse_existing';
    candidates: ReuseCandidate[];
    chosen?: ReuseCandidate;
}

// ============================================================================
// CSSemanticReuse
// ============================================================================

export class CSSemanticReuse {
    private static readonly REUSE_THRESHOLD = 0.6;
    private static readonly MERGE_THRESHOLD = 0.85;

    /**
     * Score every existing page in the inventory against `legacyPage`.
     * Returns the rank-ordered list + a decision: `reuse_existing` if the
     * top score >= REUSE_THRESHOLD; `merge` if >= MERGE_THRESHOLD; else
     * `create`.
     */
    public static decidePage(
        legacyPage: PageObjectInfo,
        existing: PageInventoryEntry[],
    ): PageReuseDecision {
        const candidates: ReuseCandidate[] = existing.map((e) => {
            const score = CSSemanticReuse.scorePage(legacyPage, e);
            const reason = CSSemanticReuse.explainPageScore(legacyPage, e, score);
            return {
                targetPath: e.relativePath,
                targetId: e.pageId ?? undefined,
                score,
                reason,
            };
        }).sort((a, b) => b.score - a.score);

        const top = candidates[0];
        let decision: PageReuseDecision['decision'] = 'create';
        if (top && top.score >= CSSemanticReuse.MERGE_THRESHOLD) decision = 'merge';
        else if (top && top.score >= CSSemanticReuse.REUSE_THRESHOLD) decision = 'reuse_existing';

        return {
            legacyClassName: legacyPage.className,
            decision,
            candidates,
            chosen: decision !== 'create' ? top : undefined,
        };
    }

    /**
     * Score every existing step-definition pattern against a legacy
     * candidate (e.g. a method name + arg count). Returns top-N by score.
     */
    public static decideStep(
        legacyMethodName: string,
        legacyArgCount: number,
        existing: StepInventoryEntry[],
    ): StepReuseDecision {
        const all: ReuseCandidate[] = [];
        for (const file of existing) {
            for (const sd of file.steps) {
                const score = CSSemanticReuse.scoreStep(legacyMethodName, legacyArgCount, sd.pattern);
                all.push({
                    targetPath: file.relativePath,
                    targetId: sd.pattern,
                    score,
                    reason: `pattern \`${sd.pattern}\` ↔ method \`${legacyMethodName}\``,
                });
            }
        }
        all.sort((a, b) => b.score - a.score);
        const top = all[0];
        const decision: StepReuseDecision['decision'] =
            top && top.score >= CSSemanticReuse.REUSE_THRESHOLD
                ? 'reuse_existing'
                : 'create';
        return {
            suggestedPattern: CSSemanticReuse.deriveStepPattern(legacyMethodName, legacyArgCount),
            decision,
            candidates: all.slice(0, 5),
            chosen: decision === 'reuse_existing' ? top : undefined,
        };
    }

    // ------------------------------------------------------------------
    // Scoring internals
    // ------------------------------------------------------------------

    private static scorePage(legacy: PageObjectInfo, target: PageInventoryEntry): number {
        // Class-name similarity (50%)
        const nameScore = CSSemanticReuse.normalisedSimilarity(
            CSSemanticReuse.normaliseName(legacy.className),
            CSSemanticReuse.normaliseName(target.className),
        );
        // Element-name overlap (50%)
        const legacyElems = new Set(
            legacy.elements.map((e) => CSSemanticReuse.normaliseName(e.name ?? '')),
        );
        const targetElems = new Set(
            target.elements.map((e) => CSSemanticReuse.normaliseName(e.name)),
        );
        const overlap = CSSemanticReuse.jaccard(legacyElems, targetElems);
        return 0.5 * nameScore + 0.5 * overlap;
    }

    private static explainPageScore(
        legacy: PageObjectInfo,
        target: PageInventoryEntry,
        score: number,
    ): string {
        const lcommon = CSSemanticReuse.commonTokens(legacy.className, target.className);
        const overlap = CSSemanticReuse.jaccard(
            new Set(legacy.elements.map((e) => CSSemanticReuse.normaliseName(e.name ?? ''))),
            new Set(target.elements.map((e) => CSSemanticReuse.normaliseName(e.name))),
        );
        return `name(${legacy.className} ↔ ${target.className})=${(0.5 + 0.5 * lcommon).toFixed(2)}; element-overlap=${overlap.toFixed(2)}; score=${score.toFixed(2)}`;
    }

    private static scoreStep(
        legacyMethod: string,
        legacyArgCount: number,
        pattern: string,
    ): number {
        // Strip {string}/{int}/{float} placeholders to count arg slots.
        const slots = (pattern.match(/\{(?:string|int|float|word)\}/g) ?? []).length;
        const slotScore = legacyArgCount === slots ? 1 : Math.max(0, 1 - Math.abs(legacyArgCount - slots) * 0.3);
        const wordsLegacy = CSSemanticReuse.tokenWords(legacyMethod);
        const wordsPattern = CSSemanticReuse.tokenWords(pattern);
        const overlap = CSSemanticReuse.jaccard(new Set(wordsLegacy), new Set(wordsPattern));
        return 0.4 * slotScore + 0.6 * overlap;
    }

    private static deriveStepPattern(method: string, argCount: number): string {
        const human = method
            .replace(/_/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .trim();
        const slots = Array.from({ length: argCount }, () => '{string}').join(' ');
        return `${human}${slots ? ' ' + slots : ''}`;
    }

    private static normaliseName(s: string): string {
        return s.replace(/Page$|Steps$|Helper$/i, '').toLowerCase();
    }

    private static tokenWords(s: string): string[] {
        return s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 2);
    }

    private static jaccard<T>(a: Set<T>, b: Set<T>): number {
        if (a.size === 0 && b.size === 0) return 0;
        const inter = new Set<T>();
        for (const x of a) if (b.has(x)) inter.add(x);
        const union = new Set<T>([...a, ...b]);
        return inter.size / union.size;
    }

    private static normalisedSimilarity(a: string, b: string): number {
        if (!a && !b) return 1;
        if (!a || !b) return 0;
        const dist = CSSemanticReuse.levenshtein(a, b);
        const max = Math.max(a.length, b.length);
        return max === 0 ? 1 : 1 - dist / max;
    }

    private static commonTokens(a: string, b: string): number {
        const at = CSSemanticReuse.tokenWords(a);
        const bt = CSSemanticReuse.tokenWords(b);
        if (at.length === 0 || bt.length === 0) return 0;
        const inter = at.filter((t) => bt.includes(t)).length;
        return inter / Math.max(at.length, bt.length);
    }

    private static levenshtein(a: string, b: string): number {
        const m = a.length;
        const n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const dp = new Array(n + 1).fill(0).map(() => new Array<number>(n + 1).fill(0));
        // Use 1D DP for memory.
        let prev = new Array<number>(n + 1).fill(0);
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
            const cur = new Array<number>(n + 1).fill(0);
            cur[0] = i;
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                cur[j] = Math.min(
                    cur[j - 1] + 1,
                    prev[j] + 1,
                    prev[j - 1] + cost,
                );
            }
            prev = cur;
        }
        void dp;
        return prev[n];
    }
}
