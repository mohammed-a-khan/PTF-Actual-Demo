/**
 * CSFailureClusterTypes - Type definitions for the Failure Clustering module.
 *
 * At end of a run, failed scenarios are grouped into clusters that
 * likely share a single root cause, using density-based clustering
 * (DBSCAN) over a composite similarity vector of normalised error
 * message tokens and stack-trace top frames.
 *
 * @module clustering
 */

/** A single failed scenario, captured at the point of failure. */
export interface FailureSample {
    testId: string;           // unique key — scenario name (+ iteration suffix)
    testName: string;         // display name
    featureFile: string;
    errorMessage: string;
    stackTrace?: string;
    /** ISO timestamp of when the failure was recorded. */
    timestamp: string;
}

/** One root-cause-like grouping of failures. */
export interface FailureCluster {
    /** 1-based cluster id, ordered by size (largest first). */
    id: number;
    size: number;
    /**
     * Representative error message for the cluster — the message of
     * the median-similarity member (after token normalisation), kept
     * raw for human readability.
     */
    sharedErrorMessage: string;
    /** Top normalised stack frames present in ≥ half the cluster's members. */
    sharedStackFrames: string[];
    members: Array<{ testId: string; testName: string; featureFile: string; errorMessage: string }>;
}

/** End-of-run clustering output. Written to disk + consumed by the HTML report. */
export interface FailureClusterReport {
    generatedAt: string;
    totalFailures: number;
    clusterCount: number;
    /** Failures that don't fit any cluster — likely unique root causes. */
    outlierCount: number;
    /** Clusters sorted by size, largest first. */
    clusters: FailureCluster[];
    /** Outliers — one failure each, kept so the report shows them too. */
    outliers: Array<{ testId: string; testName: string; featureFile: string; errorMessage: string }>;
    /** Tunables actually used during this clustering pass. */
    parameters: {
        eps: number;
        minPts: number;
        messageWeight: number;
        stackWeight: number;
    };
}
