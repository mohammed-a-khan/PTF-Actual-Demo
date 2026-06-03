/**
 * CSWaitPredictor - shared types.
 *
 * We track per-signature statistics using Welford's online algorithm
 * (one float of state per moment, not the raw samples), so storage
 * stays bounded even after thousands of runs against the same step.
 * The store is keyed by a stable signature like `step:<text>` or
 * `click:<page>.<element>` — the producer picks the convention.
 *
 * @module wait
 */

export interface WaitSignatureStats {
    /** Stable key, e.g. `step:I login as "<arg>"`. */
    signature: string;
    /** Total observations (passed + failed). */
    count: number;
    /** Welford running mean (milliseconds). */
    mean: number;
    /** Welford running M2 — sum of squared deviations from the mean. */
    m2: number;
    /** Largest observed duration (ms). */
    max: number;
    /** Number of observations that completed successfully. */
    passes: number;
    /** Number of observations that failed (timeout, error, etc.). */
    failures: number;
    /** ISO timestamp of last observation. */
    lastUpdated: string;
}

export interface WaitPrediction {
    signature: string;
    /** Recommended timeout budget (ms), already including safety margin. */
    recommendedMs: number;
    /** Running mean (ms). */
    meanMs: number;
    /** Estimated standard deviation (ms). */
    stddevMs: number;
    /** Largest observed sample (ms). */
    maxMs: number;
    /** Observations used to derive this prediction. */
    sampleCount: number;
    /**
     * Quality tier of the prediction:
     *  - low:    < 5 samples — caller should fall back to default
     *  - medium: 5–29 samples
     *  - high:   30+ samples
     */
    confidence: 'low' | 'medium' | 'high';
    /** Observed empirical failure rate (failures / count). */
    failureRate: number;
}

export interface WaitDataStore {
    version: number;
    lastUpdated: string;
    /** Keyed by signature. */
    signatures: Record<string, WaitSignatureStats>;
}
