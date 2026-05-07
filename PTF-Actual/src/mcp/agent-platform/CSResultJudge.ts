/**
 * Agentic Test Platform — Result Judge
 *
 * Classifies test runs into PASS_REAL / PASS_WEAK / FAIL. Combines a
 * deterministic structural pass over the feature/step text with an
 * optional LLM sampling fallback for ambiguous cases.
 *
 * The deterministic pass is intentionally conservative: it errs toward
 * PASS_WEAK whenever it cannot confidently say a meaningful assertion
 * exists. The LLM fallback (Phase 2: full integration with project-aware
 * grading) lifts ambiguous PASS_WEAK verdicts to PASS_REAL only when it
 * can articulate which assertion is meaningful and why.
 *
 * @module agent-platform/CSResultJudge
 */

import {
    MCPToolContext,
    MCPSamplingMessage,
    MCPSamplingResult,
} from '../types/CSMCPTypes';
import { JudgeVerdict } from './types';

// ============================================================================
// Pattern Catalog (deterministic)
// ============================================================================

/**
 * Patterns that strongly suggest a meaningful assertion.
 *
 * Includes:
 *   - "should match" / "should equal" with a specific literal
 *   - "expected" / "expects" with a value
 *   - explicit count / status / contains assertions
 */
const STRONG_ASSERTION_PATTERNS: RegExp[] = [
    /\bshould\s+(?:equal|match|contain|have)\s+/i,
    /\bexpect(?:ed|s)?\s+/i,
    /\bassert(?:_|\s)(?:equal|equals|matches|contains|true|false)\b/i,
    /\bstatus\s+(?:code\s+)?(?:is|equals?)\s+\d+/i,
    /\bcount\s+(?:is|equals?)\s+\d+/i,
    /\bdisplays?\s+(?:the\s+)?text\b/i,
];

/**
 * Patterns indicating a non-meaningful (weak) assertion. If only these
 * patterns match, verdict is PASS_WEAK.
 */
const WEAK_ASSERTION_PATTERNS: RegExp[] = [
    /\bshould\s+exist\b/i,
    /\bis\s+visible\b/i,
    /\bnot\s+null\b/i,
    /\btruth(?:y|y)?\b/i,
    /\bis\s+defined\b/i,
    /\bpage\s+loads?\b/i,
];

/**
 * Step keywords that denote assertion-like steps. Used to count how many
 * verification steps a feature has.
 */
const ASSERTION_KEYWORDS: RegExp[] = [
    /^\s*(?:Then|And|But)\s+/im,
];

// ============================================================================
// CSResultJudge
// ============================================================================

/**
 * Static judge. The single public entry point is `judge`, which returns
 * a serializable JudgeVerdict.
 */
export class CSResultJudge {
    /**
     * Judge a test run.
     *
     * @param featureFile     The feature file's path or content (used for
     *                        structural inspection)
     * @param stepDefs        Optional step-definition source code; helps
     *                        disambiguate weak vs real when feature text
     *                        alone is inconclusive
     * @param executionLog    Stdout/stderr captured from the test runner
     * @param context         Tool context (used for optional sampling)
     */
    public static async judge(
        featureFile: string,
        stepDefs: string,
        executionLog: string,
        context: MCPToolContext,
    ): Promise<JudgeVerdict> {
        // -- Step 1: deterministic checks ------------------------------------
        const det = CSResultJudge.deterministicCheck(
            featureFile,
            stepDefs,
            executionLog,
        );
        if (det.confident) {
            return det.verdict;
        }

        // -- Step 2: optional LLM fallback -----------------------------------
        if (context.sampling) {
            try {
                const sampled = await CSResultJudge.sampleVerdict(
                    featureFile,
                    stepDefs,
                    executionLog,
                    context,
                );
                if (sampled) return sampled;
            } catch (err) {
                context.log(
                    'warning',
                    'CSResultJudge: sampling failed, returning deterministic verdict',
                    { error: err instanceof Error ? err.message : String(err) },
                );
            }
        }

        return det.verdict;
    }

    // ========================================================================
    // Deterministic Pass
    // ========================================================================

    /**
     * Compute a verdict from structural cues alone. Returns
     * `confident=true` only when the verdict is unambiguous (FAIL when the
     * log shows test failures, PASS_REAL when at least one strong
     * assertion pattern is present, PASS_WEAK when only weak patterns are).
     */
    private static deterministicCheck(
        featureFile: string,
        stepDefs: string,
        executionLog: string,
    ): { verdict: JudgeVerdict; confident: boolean } {
        const corpus = `${featureFile}\n${stepDefs}`.trim();
        const log = (executionLog ?? '').toLowerCase();

        // Failure detection in the log.
        const failed =
            /\bfailed\b/.test(log) ||
            /\bfailure\b/.test(log) ||
            /\berror\b/.test(log);
        const passed = /\bpassed\b/.test(log) || /\bok\b/.test(log);

        if (failed && !passed) {
            return {
                confident: true,
                verdict: {
                    verdict: 'FAIL',
                    meaningful: false,
                    confidence: 0.95,
                    weakAssertions: [],
                    missingAssertions: [],
                    redundantAssertions: [],
                    reasoning: 'Execution log shows failures',
                },
            };
        }

        // Count strong / weak assertion patterns.
        const strong = CSResultJudge.countMatches(corpus, STRONG_ASSERTION_PATTERNS);
        const weak = CSResultJudge.countMatches(corpus, WEAK_ASSERTION_PATTERNS);
        const assertionLines = CSResultJudge.countMatches(corpus, ASSERTION_KEYWORDS);

        const weakList = CSResultJudge.collectMatches(corpus, WEAK_ASSERTION_PATTERNS, 5);

        if (assertionLines === 0) {
            return {
                confident: true,
                verdict: {
                    verdict: 'PASS_WEAK',
                    meaningful: false,
                    confidence: 0.85,
                    weakAssertions: [],
                    missingAssertions: ['no assertion steps detected'],
                    redundantAssertions: [],
                    reasoning:
                        'No Then/And/But assertion steps were found in the feature',
                },
            };
        }

        if (strong > 0 && strong >= weak) {
            return {
                confident: true,
                verdict: {
                    verdict: 'PASS_REAL',
                    meaningful: true,
                    confidence: Math.min(0.95, 0.6 + 0.1 * strong),
                    weakAssertions: weakList,
                    missingAssertions: [],
                    redundantAssertions: [],
                    reasoning: `Found ${strong} meaningful and ${weak} weak assertions`,
                },
            };
        }

        if (strong === 0 && weak > 0) {
            return {
                confident: true,
                verdict: {
                    verdict: 'PASS_WEAK',
                    meaningful: false,
                    confidence: 0.8,
                    weakAssertions: weakList,
                    missingAssertions: [
                        'no meaningful equality / status / count assertions found',
                    ],
                    redundantAssertions: [],
                    reasoning:
                        'Only weak existence/visibility/truthy assertions present',
                },
            };
        }

        // Ambiguous — defer to sampling.
        return {
            confident: false,
            verdict: {
                verdict: 'PASS_WEAK',
                meaningful: false,
                confidence: 0.5,
                weakAssertions: weakList,
                missingAssertions: [],
                redundantAssertions: [],
                reasoning:
                    'Deterministic check ambiguous — defaulted to PASS_WEAK',
            },
        };
    }

    // ========================================================================
    // Sampling Fallback
    // ========================================================================

    /**
     * Ask the client's LLM (via MCP sampling) to grade the run. The model
     * is instructed to return strict JSON matching the JudgeVerdict shape.
     * Returns null when parsing fails so the caller falls back to the
     * deterministic verdict.
     */
    private static async sampleVerdict(
        featureFile: string,
        stepDefs: string,
        executionLog: string,
        context: MCPToolContext,
    ): Promise<JudgeVerdict | null> {
        if (!context.sampling) return null;

        const prompt = [
            'You are a test-result judge. Grade the run as one of:',
            '  PASS_REAL — assertions check expected behavior meaningfully',
            '  PASS_WEAK — tests pass but assertions are non-meaningful',
            '  FAIL     — tests do not pass',
            '',
            'Return strict JSON matching:',
            '{ "verdict": "PASS_REAL"|"PASS_WEAK"|"FAIL",',
            '  "meaningful": boolean, "confidence": number,',
            '  "weakAssertions": string[], "missingAssertions": string[],',
            '  "redundantAssertions": string[], "reasoning": string }',
            '',
            'FEATURE/SOURCE:',
            featureFile.slice(0, 4 * 1024),
            '',
            'STEP DEFINITIONS:',
            stepDefs.slice(0, 4 * 1024),
            '',
            'EXECUTION LOG:',
            executionLog.slice(0, 4 * 1024),
        ].join('\n');

        const messages: MCPSamplingMessage[] = [
            {
                role: 'user',
                content: { type: 'text', text: prompt },
            },
        ];

        const result: MCPSamplingResult = await context.sampling.createMessage({
            messages,
            maxTokens: 1024,
            temperature: 0.0,
            modelPreferences: {
                speedPriority: 0.7,
                intelligencePriority: 0.6,
                costPriority: 0.7,
            },
        });

        const text = result.content?.text ?? '';
        return CSResultJudge.parseVerdictJson(text);
    }

    /**
     * Parse the model's response. Tolerates surrounding text by extracting
     * the first balanced JSON object.
     */
    private static parseVerdictJson(text: string): JudgeVerdict | null {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        const slice = text.slice(start, end + 1);
        try {
            const parsed = JSON.parse(slice);
            if (
                parsed &&
                typeof parsed === 'object' &&
                (parsed.verdict === 'PASS_REAL' ||
                    parsed.verdict === 'PASS_WEAK' ||
                    parsed.verdict === 'FAIL')
            ) {
                return {
                    verdict: parsed.verdict,
                    meaningful: parsed.meaningful === true,
                    confidence:
                        typeof parsed.confidence === 'number'
                            ? Math.max(0, Math.min(1, parsed.confidence))
                            : 0.6,
                    weakAssertions: Array.isArray(parsed.weakAssertions)
                        ? parsed.weakAssertions.map(String)
                        : [],
                    missingAssertions: Array.isArray(parsed.missingAssertions)
                        ? parsed.missingAssertions.map(String)
                        : [],
                    redundantAssertions: Array.isArray(parsed.redundantAssertions)
                        ? parsed.redundantAssertions.map(String)
                        : [],
                    reasoning:
                        typeof parsed.reasoning === 'string'
                            ? parsed.reasoning
                            : '',
                };
            }
        } catch {
            return null;
        }
        return null;
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Count the number of pattern matches across the corpus. Each pattern
     * is tested with the global flag added on so it produces all matches.
     */
    private static countMatches(corpus: string, patterns: RegExp[]): number {
        let total = 0;
        for (const p of patterns) {
            const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');
            const matches = corpus.match(re);
            if (matches) total += matches.length;
        }
        return total;
    }

    /**
     * Collect up to `limit` example strings matching any of the patterns.
     */
    private static collectMatches(
        corpus: string,
        patterns: RegExp[],
        limit: number,
    ): string[] {
        const out: string[] = [];
        for (const p of patterns) {
            const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');
            let m: RegExpExecArray | null;
            while ((m = re.exec(corpus)) !== null && out.length < limit) {
                out.push(m[0]);
            }
            if (out.length >= limit) break;
        }
        return out;
    }
}
