/**
 * Agentic Test Platform — Trust Score
 *
 * Per-test confidence scoring. The score is a weighted sum of seven
 * binary/numeric inputs, clamped into [0, 1]. The interpretation table
 * maps numeric ranges to recommended human review levels.
 *
 * The weights are chosen so that a fully-grounded test that executes
 * cleanly, judges PASS_REAL, has alternative locators, meaningful
 * assertions, and survives the commit-ready check tops out at 0.95
 * before any heal-cycle penalty.
 *
 * @module agent-platform/CSTrustScore
 */

import { TrustScoreInputs } from './types';

// ============================================================================
// Weights
// ============================================================================

/**
 * Static weight table. All weights sum to 0.95; the additional 0.05 is
 * reserved for future signals (e.g. coverage, anti-flake history) so the
 * top of the existing range remains stable when new signals are added.
 */
const WEIGHTS = {
    sourceGrounded: 0.25,
    executed: 0.2,
    judgePassReal: 0.2,
    judgePassWeak: 0.05,
    hasAlternativeLocators: 0.1,
    hasMeaningfulAssertions: 0.1,
    commitReadyCheckPassed: 0.1,
};

const HEAL_CYCLE_PENALTY = 0.02;
const MAX_HEAL_PENALTY = 0.1;

// ============================================================================
// CSTrustScore
// ============================================================================

/**
 * Static utility class. Two public methods:
 *   compute(inputs)  → number in [0, 1]
 *   interpretScore(score) → { level, recommendation }
 */
export class CSTrustScore {
    /**
     * Compute the trust score from the given inputs. The result is
     * clamped into [0, 1].
     */
    public static compute(inputs: TrustScoreInputs): number {
        let score = 0;

        if (inputs.sourceGrounded) score += WEIGHTS.sourceGrounded;
        if (inputs.executed) score += WEIGHTS.executed;

        if (inputs.judgeVerdict === 'PASS_REAL') {
            score += WEIGHTS.judgePassReal;
        } else if (inputs.judgeVerdict === 'PASS_WEAK') {
            score += WEIGHTS.judgePassWeak;
        }

        if (inputs.hasAlternativeLocators) score += WEIGHTS.hasAlternativeLocators;
        if (inputs.hasMeaningfulAssertions) score += WEIGHTS.hasMeaningfulAssertions;
        if (inputs.commitReadyCheckPassed) score += WEIGHTS.commitReadyCheckPassed;

        const healCycles = Math.max(0, inputs.healCyclesUsed | 0);
        const penalty = Math.min(MAX_HEAL_PENALTY, healCycles * HEAL_CYCLE_PENALTY);
        score -= penalty;

        return Math.max(0, Math.min(1, score));
    }

    /**
     * Map a numeric score to a human-readable confidence band and
     * recommended action.
     *
     *   ≥ 0.85           — high confidence, light review acceptable
     *   0.70 – 0.84      — reviewable, normal PR review
     *   0.50 – 0.69      — review carefully, look at assertions and locators
     *   < 0.50           — low confidence, strong human review needed
     */
    public static interpretScore(score: number): {
        level: string;
        recommendation: string;
    } {
        if (score >= 0.85) {
            return {
                level: 'high confidence',
                recommendation:
                    'Light review acceptable. Spot-check assertions and ' +
                    'locator alternatives.',
            };
        }
        if (score >= 0.7) {
            return {
                level: 'reviewable',
                recommendation:
                    'Normal PR review. Verify assertions cover the stated ' +
                    'expected outcome.',
            };
        }
        if (score >= 0.5) {
            return {
                level: 'review carefully',
                recommendation:
                    'Review carefully. Assertions or locator quality may be ' +
                    'weak; consider strengthening before merge.',
            };
        }
        return {
            level: 'low confidence — strong human review needed',
            recommendation:
                'Do not merge without rewriting the assertion strategy and ' +
                're-running the execution gate.',
        };
    }
}
