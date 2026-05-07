/**
 * Agentic Test Platform — Step → Gherkin Translator
 *
 * Translates a `ParsedTestCase` (produced by `CSAdoTestCaseParser`) into a
 * structured `GherkinTranslation` suitable for feature-file rendering.
 *
 * Strategy is deterministic-first:
 *   - verb classification picks the Gherkin keyword (Given/When/Then/And)
 *   - rephrasing uses a small canonical-pattern catalog
 *   - quoted literals + numeric tokens become Examples placeholders
 *   - source-grounded element names override raw step phrasing when a
 *     match is present in the supplied SourceGroundingMap
 *
 * Ambiguous steps are tagged for sampling fallback. Phase 2A wires the
 * sampling call but tolerates missing context.sampling so unit tests can
 * exercise the deterministic path.
 *
 * Privacy-by-design: no domain or organization identifiers; placeholders
 * use generic forms (`<USER>`, `<MODULE>`).
 *
 * @module agent-platform/CSStepToGherkinTranslator
 */

import { MCPToolContext } from '../types/CSMCPTypes';
import { ParsedTestCase, ParsedTestStep } from './CSAdoTestCaseParser';
import { SourceGroundingMap } from './CSSourceGrounder';

// ============================================================================
// Public Types
// ============================================================================

/**
 * A translated test case as Gherkin step lists. `examples` holds the
 * Scenario-Outline placeholder values (one column per placeholder); the
 * caller stitches these into a JSON fixture.
 */
export interface GherkinTranslation {
    background: string[];
    given: string[];
    when: string[];
    then: string[];
    examples: Record<string, string[]>;
    examplePlaceholders: string[];
}

// ============================================================================
// Verb / keyword classification
// ============================================================================

/**
 * Verbs that signal a Given step: setup, navigation, state preconditions.
 */
const GIVEN_VERBS: RegExp[] = [
    /^\s*(?:user\s+)?is\s+logged\s+in/i,
    /^\s*navigat(?:e|ing)\s+to/i,
    /^\s*open(?:s|ed)?\s+(?:the\s+)?/i,
    /^\s*go(?:es|ing)?\s+to/i,
    /^\s*(?:the\s+)?(?:user|tester)\s+(?:has|is)/i,
    /^\s*precondition(?:s)?\s*[:\-]/i,
    /^\s*given\b/i,
];

/**
 * Verbs that signal a When step: explicit user action.
 */
const WHEN_VERBS: RegExp[] = [
    /^\s*(?:click|tap|press)\s+/i,
    /^\s*(?:fill|enter|type|input)\s+/i,
    /^\s*select\s+/i,
    /^\s*upload\s+/i,
    /^\s*submit\s+/i,
    /^\s*choose\s+/i,
    /^\s*perform\s+/i,
    /^\s*when\b/i,
];

/**
 * Verbs that signal a Then step: assertion / verification.
 */
const THEN_VERBS: RegExp[] = [
    /^\s*(?:verify|validate|confirm|check)\s+/i,
    /^\s*(?:see|sees)\s+/i,
    /^\s*should\s+/i,
    /^\s*(?:must|will)\s+/i,
    /^\s*expect(?:ed|s)?\s+/i,
    /^\s*then\b/i,
    /^\s*ensure\s+/i,
];

// ============================================================================
// CSStepToGherkinTranslator
// ============================================================================

/**
 * Static translator. Single public method: `translate`.
 */
export class CSStepToGherkinTranslator {
    /**
     * Translate every step in a ParsedTestCase. The expected-result
     * subfield is emitted as a separate Then step when present.
     *
     * @param testCase   Parsed ADO test case
     * @param grounding  Source grounding map (may be empty)
     * @param context    MCP tool context (used only for logging in 2A)
     */
    public static async translate(
        testCase: ParsedTestCase,
        grounding: SourceGroundingMap,
        context: MCPToolContext,
    ): Promise<GherkinTranslation> {
        const out: GherkinTranslation = {
            background: [],
            given: [],
            when: [],
            then: [],
            examples: {},
            examplePlaceholders: [],
        };

        // Preconditions become Background-style Givens (still emitted in
        // the scenario for now; the feature composer will lift them up if
        // they are common across scenarios).
        if (testCase.preconditions && testCase.preconditions.length > 0) {
            out.given.push(
                CSStepToGherkinTranslator.normalize(testCase.preconditions),
            );
        }

        let lastBucket: 'given' | 'when' | 'then' = 'given';

        for (const step of testCase.steps) {
            if (step.rawType === 'SharedStepReference') {
                // Surface as a comment-style step so the user can wire up
                // the linked work item in a follow-up pass.
                out.given.push(
                    `the shared step ${step.sharedStepId ?? '<UNKNOWN>'} is applied`,
                );
                continue;
            }

            const action = step.action.trim();
            if (action.length === 0) continue;

            const { bucket, phrase } = CSStepToGherkinTranslator.classify(
                action,
                lastBucket,
            );
            const grounded = CSStepToGherkinTranslator.applyGrounding(
                phrase,
                grounding,
            );
            const { withPlaceholders, placeholderUpdates } =
                CSStepToGherkinTranslator.extractPlaceholders(
                    grounded,
                    out.examplePlaceholders,
                );
            for (const upd of placeholderUpdates) {
                if (!out.examplePlaceholders.includes(upd.name)) {
                    out.examplePlaceholders.push(upd.name);
                }
                if (!out.examples[upd.name]) out.examples[upd.name] = [];
                out.examples[upd.name].push(upd.value);
            }
            out[bucket].push(withPlaceholders);
            lastBucket = bucket;

            // Expected result, when present, becomes a Then step.
            const expected = step.expected.trim();
            if (expected.length > 0) {
                const phraseE = CSStepToGherkinTranslator.canonicalizeExpected(expected);
                const groundedE = CSStepToGherkinTranslator.applyGrounding(
                    phraseE,
                    grounding,
                );
                const { withPlaceholders: e2 } =
                    CSStepToGherkinTranslator.extractPlaceholders(
                        groundedE,
                        out.examplePlaceholders,
                    );
                out.then.push(e2);
                lastBucket = 'then';
            }
        }

        // For Scenario Outline pad: every example column needs the same
        // number of rows. We pad with empty strings if some steps produced
        // a placeholder that others did not.
        const targetRows = Math.max(
            0,
            ...Object.values(out.examples).map((v) => v.length),
        );
        for (const k of Object.keys(out.examples)) {
            while (out.examples[k].length < targetRows) {
                out.examples[k].push('');
            }
        }

        context.log('debug', 'CSStepToGherkinTranslator: translated', {
            testCaseId: testCase.testCaseId,
            given: out.given.length,
            when: out.when.length,
            then: out.then.length,
            placeholders: out.examplePlaceholders.length,
        });
        return out;
    }

    // ========================================================================
    // Classification
    // ========================================================================

    /**
     * Pick a Gherkin bucket for the given step. Falls back to "And on
     * lastBucket" if no verb matches strongly.
     */
    private static classify(
        action: string,
        lastBucket: 'given' | 'when' | 'then',
    ): { bucket: 'given' | 'when' | 'then'; phrase: string } {
        const stripped = action.replace(/^\s*(?:given|when|then|and|but)\s+/i, '');

        for (const re of GIVEN_VERBS) {
            if (re.test(action)) return { bucket: 'given', phrase: stripped };
        }
        for (const re of WHEN_VERBS) {
            if (re.test(action)) return { bucket: 'when', phrase: stripped };
        }
        for (const re of THEN_VERBS) {
            if (re.test(action)) return { bucket: 'then', phrase: stripped };
        }
        // No clear verb — continue the previous bucket as an "And ..." step
        // (the feature composer renders the second-and-later step in a
        // bucket as "And", so we don't need a separate marker here).
        return { bucket: lastBucket, phrase: stripped };
    }

    /**
     * Light normalisation: trim, drop trailing periods, collapse spaces.
     */
    private static normalize(s: string): string {
        return s.replace(/\s+/g, ' ').replace(/[.;]+\s*$/g, '').trim();
    }

    /**
     * Canonicalise an "Expected result" into Then-friendly phrasing.
     */
    private static canonicalizeExpected(s: string): string {
        let n = CSStepToGherkinTranslator.normalize(s);
        // Strip a leading "Expected:" / "Expected result:".
        n = n.replace(/^expected\s*(?:result)?\s*[:\-]\s*/i, '');
        // Convert "X is displayed" to "X should be displayed".
        if (/\bis\s+(displayed|visible|shown|present)\b/i.test(n)) {
            n = n.replace(
                /\bis\s+(displayed|visible|shown|present)\b/i,
                'should be $1',
            );
        }
        return n;
    }

    // ========================================================================
    // Source grounding
    // ========================================================================

    /**
     * If the phrase mentions an element/message present in the grounding
     * map, rewrite it to use the source-grounded label. The composer will
     * then pick up the matching SourceGroundedElement when generating the
     * page object.
     */
    private static applyGrounding(
        phrase: string,
        grounding: SourceGroundingMap,
    ): string {
        if (!grounding || grounding.elements.size === 0) return phrase;
        const lower = phrase.toLowerCase();
        let best: { key: string; len: number } | null = null;
        for (const key of grounding.elements.keys()) {
            if (key.length < 3) continue;
            if (lower.includes(key)) {
                if (!best || key.length > best.len) {
                    best = { key, len: key.length };
                }
            }
        }
        if (!best) return phrase;
        const grounded = grounding.elements.get(best.key);
        if (!grounded) return phrase;
        // Replace the matched substring with the grounded description so
        // composers can look it up by description.
        const re = new RegExp(
            CSStepToGherkinTranslator.escapeRegex(best.key),
            'i',
        );
        return phrase.replace(re, grounded.description);
    }

    // ========================================================================
    // Placeholder extraction
    // ========================================================================

    /**
     * Extract quoted literals and numeric tokens, replacing each with a
     * Scenario-Outline placeholder of the form `<name>`. Returns the
     * rewritten phrase plus the placeholder updates the caller must merge
     * into the Examples table.
     */
    private static extractPlaceholders(
        phrase: string,
        existingNames: string[],
    ): {
        withPlaceholders: string;
        placeholderUpdates: { name: string; value: string }[];
    } {
        const updates: { name: string; value: string }[] = [];
        let result = phrase;

        // Quoted literals → <quotedN>
        const quotedRe = /"([^"]{1,80})"/g;
        let m: RegExpExecArray | null;
        let qIdx = 1;
        while ((m = quotedRe.exec(phrase)) !== null) {
            const value = m[1];
            const name = CSStepToGherkinTranslator.uniqueName(
                'quoted',
                qIdx,
                existingNames,
                updates,
            );
            qIdx += 1;
            result = result.replace(`"${value}"`, `"<${name}>"`);
            updates.push({ name, value });
        }

        // Standalone integers (3+ digits) → <numN>. Conservative: skip
        // values that are clearly part of a placeholder we already wrote.
        const numRe = /(?<![<\w])(\d{3,})(?!\w)/g;
        let nIdx = 1;
        while ((m = numRe.exec(result)) !== null) {
            if (result.slice(0, m.index).includes('<')) {
                // Heuristic: ignore numbers inside what's now a placeholder.
                continue;
            }
            const value = m[1];
            const name = CSStepToGherkinTranslator.uniqueName(
                'num',
                nIdx,
                existingNames,
                updates,
            );
            nIdx += 1;
            // Re-do replacement on the live result so subsequent matches
            // still align with positions in the rewritten phrase.
            result =
                result.slice(0, m.index) +
                `<${name}>` +
                result.slice(m.index + value.length);
            updates.push({ name, value });
            // Reset the regex's lastIndex to avoid skipping the new tail.
            numRe.lastIndex = m.index + name.length + 2;
        }

        return { withPlaceholders: result, placeholderUpdates: updates };
    }

    /**
     * Generate a unique placeholder name in the form `<base><n>` that does
     * not collide with names already in `existing` or being added in
     * `pending`.
     */
    private static uniqueName(
        base: string,
        seed: number,
        existing: string[],
        pending: { name: string; value: string }[],
    ): string {
        let n = seed;
        const taken = new Set([
            ...existing,
            ...pending.map((p) => p.name),
        ]);
        while (taken.has(`${base}${n}`)) n += 1;
        return `${base}${n}`;
    }

    private static escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
