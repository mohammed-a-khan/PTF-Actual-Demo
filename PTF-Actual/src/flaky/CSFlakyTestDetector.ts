/**
 * CSFlakyTestDetector - Smart Flaky Test Detection
 *
 * Tracks test execution results across runs and computes flakiness scores
 * to identify intermittent, timing-dependent, and data-dependent failures.
 * Provides pattern analysis, root cause hints, quarantine recommendations,
 * and a debounced persistent JSON data store.
 *
 * Singleton pattern. Config via CSConfigurationManager.
 *
 * @module flaky
 */

import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import * as fs from 'fs';
import * as path from 'path';
import {
    FlakyTestResult,
    FlakyTestRecord,
    FlakinessAnalysis,
    FlakinessReport,
    FlakyDataStore,
} from './CSFlakyTestTypes';

export class CSFlakyTestDetector {
    private static instance: CSFlakyTestDetector;

    private config: CSConfigurationManager;
    private dataStore: FlakyDataStore | null = null;
    private dataFilePath: string = '';
    private dirty: boolean = false;
    private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private saving: boolean = false;

    // ---------- Config defaults ----------
    private readonly DATA_STORE_VERSION = 1;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSFlakyTestDetector {
        if (!CSFlakyTestDetector.instance) {
            CSFlakyTestDetector.instance = new CSFlakyTestDetector();
        }
        return CSFlakyTestDetector.instance;
    }

    // ==========================================================================
    // Configuration helpers
    // ==========================================================================

    private isEnabled(): boolean {
        return this.config.getBoolean('FLAKY_DETECTION_ENABLED', true);
    }

    private getThreshold(): number {
        return this.config.getNumber('FLAKY_THRESHOLD', 10);
    }

    private getQuarantineThreshold(): number {
        return this.config.getNumber('FLAKY_QUARANTINE_THRESHOLD', 40);
    }

    private getMaxHistory(): number {
        return this.config.getNumber('FLAKY_MAX_HISTORY', 50);
    }

    private getAutoRetry(): number {
        return this.config.getNumber('FLAKY_AUTO_RETRY', 0);
    }

    private getDataDir(): string {
        return this.config.get('FLAKY_DATA_DIR', '.flaky-test-data');
    }

    // ==========================================================================
    // Lazy initialisation of data store
    // ==========================================================================

    private ensureDataStore(): FlakyDataStore {
        if (this.dataStore) {
            return this.dataStore;
        }

        const dataDir = path.resolve(process.cwd(), this.getDataDir());
        this.dataFilePath = path.join(dataDir, 'flaky-results.json');

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        if (fs.existsSync(this.dataFilePath)) {
            try {
                const raw = fs.readFileSync(this.dataFilePath, 'utf-8');
                this.dataStore = JSON.parse(raw) as FlakyDataStore;
                CSReporter.debug(`[FlakyDetector] Loaded data store with ${Object.keys(this.dataStore.tests).length} tests`);
            } catch (err) {
                CSReporter.warn(`[FlakyDetector] Failed to read data store, creating new one: ${(err as Error).message}`);
                this.dataStore = this.createEmptyStore();
            }
        } else {
            this.dataStore = this.createEmptyStore();
        }

        return this.dataStore;
    }

    private createEmptyStore(): FlakyDataStore {
        return {
            version: this.DATA_STORE_VERSION,
            lastUpdated: new Date().toISOString(),
            tests: {},
        };
    }

    // ==========================================================================
    // Debounced save (same pattern as CSElementCache)
    // ==========================================================================

    private debounceSave(): void {
        if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = setTimeout(() => {
            this.saveToDisk();
        }, 500);
    }

    private saveToDisk(): void {
        if (!this.dirty || this.saving || !this.dataStore) return;
        this.saving = true;
        try {
            const dataDir = path.dirname(this.dataFilePath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            this.dataStore.lastUpdated = new Date().toISOString();
            fs.writeFileSync(this.dataFilePath, JSON.stringify(this.dataStore, null, 2), 'utf-8');
            this.dirty = false;
            CSReporter.debug('[FlakyDetector] Data store saved to disk');
        } catch (err) {
            CSReporter.warn(`[FlakyDetector] Failed to save data store: ${(err as Error).message}`);
        } finally {
            this.saving = false;
        }
    }

    /** Force an immediate synchronous save (useful at process exit). */
    public flush(): void {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
        this.saveToDisk();
    }

    // ==========================================================================
    // Public API
    // ==========================================================================

    /**
     * Record the result of a single test execution.
     */
    public recordTestResult(
        testId: string,
        testName: string,
        featureFile: string,
        status: 'passed' | 'failed' | 'skipped',
        duration: number,
        error?: string,
    ): void {
        if (!this.isEnabled()) return;

        const store = this.ensureDataStore();
        const maxHistory = this.getMaxHistory();

        const result: FlakyTestResult = {
            status,
            duration,
            error,
            timestamp: new Date().toISOString(),
        };

        if (!store.tests[testId]) {
            store.tests[testId] = {
                name: testName,
                featureFile,
                results: [],
                flakinessScore: 0,
                lastUpdated: result.timestamp,
                totalRuns: 0,
                passCount: 0,
                failCount: 0,
                skipCount: 0,
            };
        }

        const record = store.tests[testId];
        record.name = testName;
        record.featureFile = featureFile;
        record.results.push(result);

        // Trim to max history
        if (record.results.length > maxHistory) {
            record.results = record.results.slice(record.results.length - maxHistory);
        }

        // Update counters based on retained results
        record.totalRuns = record.results.length;
        record.passCount = record.results.filter(r => r.status === 'passed').length;
        record.failCount = record.results.filter(r => r.status === 'failed').length;
        record.skipCount = record.results.filter(r => r.status === 'skipped').length;
        record.flakinessScore = this.computeScore(record);
        record.lastUpdated = result.timestamp;

        this.dirty = true;
        this.debounceSave();
    }

    /**
     * Return the flakiness score (0-100) for a given test.
     * 0 = perfectly stable, 100 = completely random.
     */
    public getFlakinessScore(testId: string): number {
        const store = this.ensureDataStore();
        const record = store.tests[testId];
        if (!record) return 0;
        return record.flakinessScore;
    }

    /**
     * Return all tests whose flakiness score exceeds the given threshold.
     */
    public getFlakyTests(threshold?: number): Array<{ testId: string; record: FlakyTestRecord }> {
        const t = threshold ?? this.getThreshold();
        const store = this.ensureDataStore();
        const results: Array<{ testId: string; record: FlakyTestRecord }> = [];

        for (const [testId, record] of Object.entries(store.tests)) {
            if (record.flakinessScore > t) {
                results.push({ testId, record });
            }
        }

        return results.sort((a, b) => b.record.flakinessScore - a.record.flakinessScore);
    }

    /**
     * Return the last N results for a test.
     */
    public getTestHistory(testId: string): FlakyTestResult[] {
        const store = this.ensureDataStore();
        const record = store.tests[testId];
        return record ? [...record.results] : [];
    }

    /**
     * Deep flakiness analysis with pattern detection and root cause hints.
     *
     * Note: the score is recomputed on-the-fly here (rather than read
     * from `record.flakinessScore`) so historical data automatically
     * picks up any score-formula changes without needing a manual
     * cleanup of the .flaky-test-data/ store.
     */
    public analyzeFlakiness(testId: string): FlakinessAnalysis | null {
        const store = this.ensureDataStore();
        const record = store.tests[testId];
        if (!record || record.totalRuns === 0) return null;

        const score = this.computeScore(record);
        // Keep the stored score in sync so subsequent reads via
        // getFlakinessScore() return the latest value too.
        record.flakinessScore = score;
        const passRate = record.totalRuns > 0 ? (record.passCount / record.totalRuns) * 100 : 0;

        // Duration statistics
        const durations = record.results.map(r => r.duration);
        const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
        const variance = durations.length > 1
            ? Math.sqrt(durations.reduce((sum, d) => sum + Math.pow(d - avgDuration, 2), 0) / durations.length)
            : 0;

        // Last success / failure
        const lastSuccess = this.findLastByStatus(record.results, 'passed');
        const lastFailure = this.findLastByStatus(record.results, 'failed');

        // Pattern detection
        const { pattern, patternDescription } = this.detectPattern(record, avgDuration, variance);

        // Root cause hints
        const rootCauseHints = this.detectRootCauseHints(record, variance, avgDuration);

        // Recommendation
        const recommendation = this.determineRecommendation(score);

        // Suggested retry count
        const suggestedRetryCount = this.suggestRetryCount(score);

        return {
            testId,
            testName: record.name,
            score,
            totalRuns: record.totalRuns,
            passRate: Math.round(passRate * 100) / 100,
            pattern,
            patternDescription,
            rootCauseHints,
            recommendation,
            suggestedRetryCount,
            lastFailure: lastFailure?.timestamp,
            lastSuccess: lastSuccess?.timestamp,
            averageDuration: Math.round(avgDuration),
            durationVariance: Math.round(variance),
        };
    }

    /**
     * Return tests that should be quarantined (score above quarantine threshold).
     */
    public getQuarantinedTests(): Array<{ testId: string; record: FlakyTestRecord }> {
        return this.getFlakyTests(this.getQuarantineThreshold());
    }

    /**
     * Check if a specific test is quarantined.
     */
    public isQuarantined(testId: string): boolean {
        const score = this.getFlakinessScore(testId);
        return score > this.getQuarantineThreshold();
    }

    /**
     * Generate a full flakiness report.
     */
    public generateFlakinessReport(): FlakinessReport {
        const store = this.ensureDataStore();
        const testIds = Object.keys(store.tests);
        const analyses: FlakinessAnalysis[] = [];

        for (const testId of testIds) {
            const analysis = this.analyzeFlakiness(testId);
            if (analysis) {
                analyses.push(analysis);
            }
        }

        analyses.sort((a, b) => b.score - a.score);

        const threshold = this.getThreshold();
        const quarantineThreshold = this.getQuarantineThreshold();
        const flakyCount = analyses.filter(a => a.score > threshold).length;
        const quarantinedCount = analyses.filter(a => a.score > quarantineThreshold).length;
        const stableCount = analyses.filter(a => a.score <= threshold).length;
        const avgScore = analyses.length > 0
            ? analyses.reduce((sum, a) => sum + a.score, 0) / analyses.length
            : 0;

        const report: FlakinessReport = {
            generatedAt: new Date().toISOString(),
            totalTests: analyses.length,
            flakyTests: flakyCount,
            quarantinedTests: quarantinedCount,
            stableTests: stableCount,
            averageFlakinessScore: Math.round(avgScore * 100) / 100,
            tests: analyses,
        };

        CSReporter.info(`[FlakyDetector] Report: ${report.totalTests} total, ${report.flakyTests} flaky, ${report.quarantinedTests} quarantined`);

        return report;
    }

    /**
     * Remove records older than the specified number of days (default 30).
     */
    public cleanup(olderThanDays: number = 30): void {
        const store = this.ensureDataStore();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - olderThanDays);
        const cutoffISO = cutoff.toISOString();

        let removedTests = 0;
        let trimmedResults = 0;

        for (const [testId, record] of Object.entries(store.tests)) {
            const before = record.results.length;
            record.results = record.results.filter(r => r.timestamp >= cutoffISO);
            trimmedResults += before - record.results.length;

            if (record.results.length === 0) {
                delete store.tests[testId];
                removedTests++;
            } else {
                // Recompute counters after trimming
                record.totalRuns = record.results.length;
                record.passCount = record.results.filter(r => r.status === 'passed').length;
                record.failCount = record.results.filter(r => r.status === 'failed').length;
                record.skipCount = record.results.filter(r => r.status === 'skipped').length;
                record.flakinessScore = this.computeScore(record);
            }
        }

        if (removedTests > 0 || trimmedResults > 0) {
            this.dirty = true;
            this.debounceSave();
            CSReporter.info(`[FlakyDetector] Cleanup: removed ${removedTests} tests, trimmed ${trimmedResults} results`);
        }
    }

    // ==========================================================================
    // Score computation
    // ==========================================================================

    /**
     * Compute health score: failRate × 100
     * 0 = perfectly healthy (every run passed)
     * 100 = toxic (every run failed)
     *
     * Earlier versions of this method computed "minority count" as a
     * proxy for inconsistency, which incorrectly labelled tests that
     * had failed every run as "Solid" (because all-fails has zero
     * variance from the majority). The new formula collapses health
     * onto a single intuitive axis: how often does this test actually
     * fail? Trend / pattern detection still surface alternation and
     * regression direction separately on the report.
     *
     * Score ranges (matching HEALTH_LEVELS in CSFlakyReportSection):
     *      0       Solid    (perfect record)
     *      1-10    Stable   (occasional one-off failure)
     *      11-25   Shaky    (intermittent failures)
     *      26-40   Flaky    (often fails, ~1/3 of runs)
     *      41-60   Broken   (fails more than it passes)
     *      61-100  Toxic    (almost always fails — likely real regression)
     */
    private computeScore(record: FlakyTestRecord): number {
        const results = record.results.filter(r => r.status !== 'skipped');
        if (results.length < 2) return 0;

        const failCount = results.filter(r => r.status === 'failed').length;
        return Math.round((failCount / results.length) * 100);
    }

    // ==========================================================================
    // Pattern detection helpers
    // ==========================================================================

    private detectPattern(
        record: FlakyTestRecord,
        avgDuration: number,
        variance: number,
    ): { pattern: FlakinessAnalysis['pattern']; patternDescription: string } {
        const results = record.results;
        if (results.length < 2) {
            return { pattern: 'stable', patternDescription: 'Not enough data for pattern detection' };
        }

        // Check trending_failure: last 5 all failed but earlier ones had passes
        const recent = results.slice(-5);
        const earlier = results.slice(0, -5);
        if (
            recent.length >= 5 &&
            recent.every(r => r.status === 'failed') &&
            earlier.some(r => r.status === 'passed')
        ) {
            return {
                pattern: 'trending_failure',
                patternDescription: 'Last 5 results are all failures but earlier runs passed. Likely a new regression.',
            };
        }

        // Check timing_dependent via duration variance
        if (avgDuration > 0 && variance > avgDuration * 0.5) {
            return {
                pattern: 'timing_dependent',
                patternDescription: `High duration variance (${Math.round(variance)}ms vs avg ${Math.round(avgDuration)}ms). Likely timing-sensitive.`,
            };
        }

        // Check timing_dependent via error messages
        const errors = results.filter(r => r.error).map(r => r.error!);
        if (errors.some(e => /timeout/i.test(e))) {
            return {
                pattern: 'timing_dependent',
                patternDescription: 'Test failures include timeout errors. Likely a timing issue.',
            };
        }

        // Check data_dependent via error messages
        if (errors.some(e => /not found|no element/i.test(e))) {
            return {
                pattern: 'data_dependent',
                patternDescription: 'Test failures include "not found" errors. May be data or UI race condition.',
            };
        }

        // Check intermittent: alternating pass/fail pattern
        const nonSkipped = results.filter(r => r.status !== 'skipped');
        if (nonSkipped.length >= 4) {
            let alternations = 0;
            for (let i = 1; i < nonSkipped.length; i++) {
                if (nonSkipped[i].status !== nonSkipped[i - 1].status) {
                    alternations++;
                }
            }
            const alternationRate = alternations / (nonSkipped.length - 1);
            if (alternationRate > 0.5) {
                return {
                    pattern: 'intermittent',
                    patternDescription: `Results alternate between pass and fail frequently (${Math.round(alternationRate * 100)}% transitions). Classic flaky test.`,
                };
            }
        }

        // If score is low, stable
        if (record.flakinessScore <= this.getThreshold()) {
            return { pattern: 'stable', patternDescription: 'Test results are consistent.' };
        }

        return { pattern: 'unknown', patternDescription: 'Flaky but no clear pattern detected.' };
    }

    private detectRootCauseHints(
        record: FlakyTestRecord,
        variance: number,
        avgDuration: number,
    ): string[] {
        const hints: string[] = [];
        const errors = record.results.filter(r => r.error).map(r => r.error!);

        if (errors.some(e => /timeout/i.test(e))) {
            hints.push('Timing issue: failures involve timeouts. Consider increasing wait times or adding explicit waits.');
        }

        if (errors.some(e => /not found|no element/i.test(e))) {
            hints.push('UI race condition: element not found errors suggest the page was not fully loaded.');
        }

        if (avgDuration > 0 && variance > avgDuration * 0.5) {
            hints.push('High duration variance indicates environment or network instability.');
        }

        if (errors.some(e => /data|expected.*but.*got|assertion/i.test(e))) {
            hints.push('Data dependent: assertion errors suggest test depends on mutable data.');
        }

        if (hints.length === 0 && record.flakinessScore > this.getThreshold()) {
            hints.push('No specific root cause detected. Manual investigation recommended.');
        }

        return hints;
    }

    private determineRecommendation(score: number): FlakinessAnalysis['recommendation'] {
        if (score <= 5) return 'stable';
        if (score <= this.getThreshold()) return 'monitor';
        if (score <= this.getQuarantineThreshold()) return 'retry';
        if (score <= 70) return 'quarantine';
        return 'investigate';
    }

    private suggestRetryCount(score: number): number {
        const configuredRetry = this.getAutoRetry();
        if (configuredRetry > 0) return configuredRetry;
        if (score <= 5) return 0;
        if (score <= 20) return 1;
        if (score <= 40) return 2;
        return 3;
    }

    private findLastByStatus(results: FlakyTestResult[], status: string): FlakyTestResult | undefined {
        for (let i = results.length - 1; i >= 0; i--) {
            if (results[i].status === status) return results[i];
        }
        return undefined;
    }
}
