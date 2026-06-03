/**
 * CSImpactTypes - Type definitions for Test Impact Analysis.
 *
 * Per-scenario record of which files are touched during execution.
 * On a PR build, the framework intersects the git diff with these
 * per-scenario file sets to decide which tests must actually run.
 *
 * @module impact
 */

/** Per-test impact record persisted to disk. */
export interface TestImpactRecord {
    testId: string;            // scenario name (the same key used by CSFlakyTestDetector)
    testName: string;
    featureFile: string;
    /**
     * Repo-relative POSIX paths of files this test loaded via require()
     * during one or more historical runs. Cumulative — the set grows
     * over time so cold-cache misses (a file already loaded by an
     * earlier scenario in the same process) eventually self-correct.
     */
    files: string[];
    /** Total scenario runs that have contributed to this set. */
    runCount: number;
    lastUpdated: string;       // ISO timestamp
}

/** The complete on-disk impact store. */
export interface ImpactDataStore {
    version: number;
    lastUpdated: string;
    /** Keyed by `testId`. */
    tests: Record<string, TestImpactRecord>;
}

/** Output of impact-only filtering — what to run, what to skip, and why. */
export interface ImpactFilterResult {
    /** Git base ref used (e.g. `origin/main`). */
    baseRef: string;
    /** Repo-relative POSIX paths the diff returned. */
    changedFiles: string[];
    /** testIds the analyzer decided to keep (changed-file overlap or no data). */
    affectedTestIds: Set<string>;
    /** testIds the analyzer skipped (have recorded data but no overlap). */
    skippedTestIds: Set<string>;
    /** Test ids that have no recorded impact data — kept by default for safety. */
    unknownTestIds: Set<string>;
    /** Plain-English summary suitable for the runner log. */
    summary: string;
}
