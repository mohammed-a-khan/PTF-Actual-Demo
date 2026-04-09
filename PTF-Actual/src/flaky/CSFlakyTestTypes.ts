/**
 * CSFlakyTestTypes - Type definitions for the Smart Flaky Test Detection module.
 *
 * Defines interfaces for test result recording, flakiness analysis,
 * reporting, and persistent data storage.
 *
 * @module flaky
 */

export interface FlakyTestResult {
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    error?: string;
    timestamp: string;  // ISO string
    environment?: string;
    worker?: number;
}

export interface FlakyTestRecord {
    name: string;
    featureFile: string;
    results: FlakyTestResult[];
    flakinessScore: number;
    lastUpdated: string;
    totalRuns: number;
    passCount: number;
    failCount: number;
    skipCount: number;
}

export interface FlakinessAnalysis {
    testId: string;
    testName: string;
    score: number;
    totalRuns: number;
    passRate: number;
    pattern: 'stable' | 'intermittent' | 'trending_failure' | 'timing_dependent' | 'data_dependent' | 'unknown';
    patternDescription: string;
    rootCauseHints: string[];
    recommendation: 'stable' | 'monitor' | 'retry' | 'quarantine' | 'investigate';
    suggestedRetryCount: number;
    lastFailure?: string;
    lastSuccess?: string;
    averageDuration: number;
    durationVariance: number;
}

export interface FlakinessReport {
    generatedAt: string;
    totalTests: number;
    flakyTests: number;
    quarantinedTests: number;
    stableTests: number;
    averageFlakinessScore: number;
    tests: FlakinessAnalysis[];
}

export interface FlakyDataStore {
    version: number;
    lastUpdated: string;
    tests: Record<string, FlakyTestRecord>;
}
