/**
 * CSSmartRetryTypes - Type definitions for the Smart Retry bandit module.
 *
 * The Smart Retry engine learns which retry tactic recovers tests with
 * a given failure signature, using a UCB1 multi-armed bandit. Across
 * runs it persists per-(signature, tactic) attempt and success counts
 * so that recurring failure patterns get the tactic with the highest
 * historical recovery rate.
 *
 * @module retry
 */

/**
 * Named retry tactics. The engine picks one of these per failure
 * signature instead of always running the same fixed retry approach.
 *
 *   - `immediate`     — retry straight away, same context, no setup
 *   - `reload`        — page.reload() then retry
 *   - `fresh-context` — clear cookies/permissions/storage then retry
 *                       (this was the runner's only retry path before
 *                       SMART_RETRY_ENABLED — kept as one of the tactics
 *                       so the bandit can learn it's the right one when
 *                       it actually is)
 *   - `backoff`       — short delay (so the SUT has time to settle)
 *                       then retry
 */
export type RetryTactic = 'immediate' | 'reload' | 'fresh-context' | 'backoff';

export const ALL_RETRY_TACTICS: RetryTactic[] = [
    'immediate',
    'reload',
    'fresh-context',
    'backoff',
];

/** Bandit record per (signature, tactic) pair. */
export interface RetryRecord {
    attempts: number;
    successes: number;
    lastUsed: string; // ISO timestamp
}

/** Per-signature breakdown of recovery rates by tactic. */
export type RetryRecordByTactic = Partial<Record<RetryTactic, RetryRecord>>;

/** Outcome of a chooseTactic() decision, useful for logging. */
export interface RetryDecision {
    tactic: RetryTactic;
    reason: 'exploration' | 'ucb1' | 'fallback';
    /** UCB1 score of the chosen tactic, 0 when the tactic is being explored for the first time. */
    score: number;
    /** Total prior attempts for this signature across all tactics. */
    totalAttempts: number;
}

/** Persistent shape of the retry-history data store. */
export interface RetryDataStore {
    version: number;
    lastUpdated: string;
    /**
     * Map of failure-signature → per-tactic record. Signatures are
     * short hashes built from the top stack frames and the normalised
     * error message (see CSSmartRetryEngine.buildSignature).
     */
    signatures: Record<string, RetryRecordByTactic>;
}
