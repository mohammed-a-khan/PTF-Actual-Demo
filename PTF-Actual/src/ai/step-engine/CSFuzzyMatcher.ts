/**
 * CSFuzzyMatcher - Enhanced Fuzzy String Matching
 *
 * Augments existing Jaro-Winkler with:
 *   - Bigram/trigram overlap scoring (N-gram)
 *   - Levenshtein distance for short strings
 *   - Token-level matching (word reordering tolerance)
 *   - Composite scoring: 0.5 * jaroWinkler + 0.3 * ngramOverlap + 0.2 * tokenMatch
 *
 * Zero external dependencies — pure algorithmic implementation.
 *
 * @module ai/step-engine
 */

/** Result of a fuzzy match comparison */
export interface FuzzyMatchResult {
    /** Composite score (0-1) */
    score: number;
    /** Individual component scores */
    breakdown: {
        jaroWinkler: number;
        ngramOverlap: number;
        tokenMatch: number;
        levenshtein: number;
    };
    /** Whether the match is considered strong */
    isStrongMatch: boolean;
}

export class CSFuzzyMatcher {
    private static instance: CSFuzzyMatcher;

    private constructor() {}

    public static getInstance(): CSFuzzyMatcher {
        if (!CSFuzzyMatcher.instance) {
            CSFuzzyMatcher.instance = new CSFuzzyMatcher();
        }
        return CSFuzzyMatcher.instance;
    }

    /**
     * Compute composite fuzzy match score between two strings.
     * Combines multiple algorithms for robust matching.
     *
     * @param s1 - First string (typically the search text)
     * @param s2 - Second string (typically the element text)
     * @param threshold - Minimum score to consider a strong match (default: 0.7)
     * @returns FuzzyMatchResult with composite and component scores
     */
    public compare(s1: string, s2: string, threshold: number = 0.7): FuzzyMatchResult {
        if (!s1 || !s2) {
            return { score: 0, breakdown: { jaroWinkler: 0, ngramOverlap: 0, tokenMatch: 0, levenshtein: 0 }, isStrongMatch: false };
        }

        const a = s1.toLowerCase().trim();
        const b = s2.toLowerCase().trim();

        // Exact match shortcut
        if (a === b) {
            return { score: 1.0, breakdown: { jaroWinkler: 1, ngramOverlap: 1, tokenMatch: 1, levenshtein: 1 }, isStrongMatch: true };
        }

        const jw = this.jaroWinkler(a, b);
        const ngram = this.ngramOverlap(a, b, 2); // bigrams
        const token = this.tokenMatch(a, b);
        const lev = this.normalizedLevenshtein(a, b);

        // Composite score with weights
        // Jaro-Winkler is best for similar strings with common prefix
        // N-gram overlap handles substring matches well
        // Token match handles word reordering
        const composite = 0.5 * jw + 0.3 * ngram + 0.2 * token;

        // For short strings (< 5 chars), Levenshtein is more reliable
        const finalScore = (a.length < 5 || b.length < 5)
            ? Math.max(composite, lev)
            : composite;

        return {
            score: finalScore,
            breakdown: { jaroWinkler: jw, ngramOverlap: ngram, tokenMatch: token, levenshtein: lev },
            isStrongMatch: finalScore >= threshold
        };
    }

    /**
     * Find the best match for a search string from a list of candidates.
     *
     * @param search - String to search for
     * @param candidates - List of candidate strings
     * @param threshold - Minimum score to accept (default: 0.6)
     * @returns Best matching candidate with score, or null
     */
    public findBestMatch(
        search: string,
        candidates: string[],
        threshold: number = 0.6
    ): { candidate: string; index: number; result: FuzzyMatchResult } | null {
        let best: { candidate: string; index: number; result: FuzzyMatchResult } | null = null;

        for (let i = 0; i < candidates.length; i++) {
            const result = this.compare(search, candidates[i]);
            if (result.score >= threshold) {
                if (!best || result.score > best.result.score) {
                    best = { candidate: candidates[i], index: i, result };
                }
            }
        }

        return best;
    }

    /**
     * Check if a string contains another string with fuzzy tolerance.
     * Handles cases like "Submit" matching "Submit Application".
     */
    public fuzzyContains(haystack: string, needle: string, threshold: number = 0.8): boolean {
        const h = haystack.toLowerCase().trim();
        const n = needle.toLowerCase().trim();

        // Direct containment
        if (h.includes(n) || n.includes(h)) return true;

        // Token-level containment: all words in needle appear in haystack
        const needleWords = n.split(/\s+/);
        const haystackWords = h.split(/\s+/);
        const allWordsFound = needleWords.every(nw =>
            haystackWords.some(hw => this.jaroWinkler(nw, hw) >= threshold)
        );

        return allWordsFound;
    }

    // ========================================================================
    // Core Algorithms
    // ========================================================================

    /**
     * Jaro-Winkler similarity (0-1).
     * Best for strings with common prefixes and similar character patterns.
     */
    public jaroWinkler(s1: string, s2: string): number {
        if (s1 === s2) return 1.0;
        if (s1.length === 0 || s2.length === 0) return 0.0;

        const matchRange = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
        const s1Matches = new Array(s1.length).fill(false);
        const s2Matches = new Array(s2.length).fill(false);

        let matches = 0;
        let transpositions = 0;

        // Find matches
        for (let i = 0; i < s1.length; i++) {
            const start = Math.max(0, i - matchRange);
            const end = Math.min(i + matchRange + 1, s2.length);
            for (let j = start; j < end; j++) {
                if (s2Matches[j] || s1[i] !== s2[j]) continue;
                s1Matches[i] = true;
                s2Matches[j] = true;
                matches++;
                break;
            }
        }

        if (matches === 0) return 0.0;

        // Count transpositions
        let k = 0;
        for (let i = 0; i < s1.length; i++) {
            if (!s1Matches[i]) continue;
            while (!s2Matches[k]) k++;
            if (s1[i] !== s2[k]) transpositions++;
            k++;
        }

        const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

        // Winkler boost for common prefix (max 4 chars)
        let prefix = 0;
        for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
            if (s1[i] === s2[i]) prefix++;
            else break;
        }

        return jaro + prefix * 0.1 * (1 - jaro);
    }

    /**
     * N-gram overlap coefficient (0-1).
     * Measures the proportion of shared n-grams between two strings.
     */
    public ngramOverlap(s1: string, s2: string, n: number = 2): number {
        if (s1.length < n || s2.length < n) {
            // Fall back to character overlap for very short strings
            return this.characterOverlap(s1, s2);
        }

        const ngrams1 = this.generateNgrams(s1, n);
        const ngrams2 = this.generateNgrams(s2, n);

        if (ngrams1.size === 0 || ngrams2.size === 0) return 0;

        let sharedCount = 0;
        for (const gram of ngrams1) {
            if (ngrams2.has(gram)) sharedCount++;
        }

        // Overlap coefficient: |intersection| / min(|A|, |B|)
        return sharedCount / Math.min(ngrams1.size, ngrams2.size);
    }

    /**
     * Token-level match score (0-1).
     * Handles word reordering: "Submit Application" matches "Application Submit".
     */
    public tokenMatch(s1: string, s2: string): number {
        const tokens1 = s1.split(/\s+/).filter(t => t.length > 0);
        const tokens2 = s2.split(/\s+/).filter(t => t.length > 0);

        if (tokens1.length === 0 || tokens2.length === 0) return 0;

        // For each token in s1, find the best matching token in s2
        let totalScore = 0;
        const usedIndices = new Set<number>();

        for (const t1 of tokens1) {
            let bestScore = 0;
            let bestIdx = -1;

            for (let j = 0; j < tokens2.length; j++) {
                if (usedIndices.has(j)) continue;
                const score = this.jaroWinkler(t1, tokens2[j]);
                if (score > bestScore) {
                    bestScore = score;
                    bestIdx = j;
                }
            }

            if (bestIdx >= 0 && bestScore > 0.7) {
                totalScore += bestScore;
                usedIndices.add(bestIdx);
            }
        }

        return totalScore / Math.max(tokens1.length, tokens2.length);
    }

    /**
     * Normalized Levenshtein distance (0-1, where 1 = identical).
     * Good for short strings and single-character differences.
     */
    public normalizedLevenshtein(s1: string, s2: string): number {
        if (s1 === s2) return 1.0;
        if (s1.length === 0 || s2.length === 0) return 0.0;

        const maxLen = Math.max(s1.length, s2.length);
        const distance = this.levenshteinDistance(s1, s2);
        return 1 - distance / maxLen;
    }

    /**
     * Raw Levenshtein edit distance.
     */
    private levenshteinDistance(s1: string, s2: string): number {
        const m = s1.length;
        const n = s2.length;

        // Use single-row optimization for memory efficiency
        let prev = Array.from({ length: n + 1 }, (_, i) => i);
        let curr = new Array(n + 1);

        for (let i = 1; i <= m; i++) {
            curr[0] = i;
            for (let j = 1; j <= n; j++) {
                const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
                curr[j] = Math.min(
                    prev[j] + 1,     // deletion
                    curr[j - 1] + 1, // insertion
                    prev[j - 1] + cost // substitution
                );
            }
            [prev, curr] = [curr, prev];
        }

        return prev[n];
    }

    /**
     * Generate n-grams from a string.
     */
    private generateNgrams(str: string, n: number): Set<string> {
        const ngrams = new Set<string>();
        for (let i = 0; i <= str.length - n; i++) {
            ngrams.add(str.substring(i, i + n));
        }
        return ngrams;
    }

    /**
     * Character overlap for very short strings.
     */
    private characterOverlap(s1: string, s2: string): number {
        if (s1.length === 0 || s2.length === 0) return 0;
        const chars1 = new Set(s1.split(''));
        const chars2 = new Set(s2.split(''));
        let shared = 0;
        for (const c of chars1) {
            if (chars2.has(c)) shared++;
        }
        return shared / Math.max(chars1.size, chars2.size);
    }
}
