/**
 * CS Playwright MCP Analytics Tools
 * Test analytics, flakiness detection, and trend analysis
 * Real implementation reading from actual test results
 *
 * @module CSMCPAnalyticsTools
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// Lazy load framework components
let CSConfigurationManager: any = null;
let CSReporter: any = null;
let CSTestResultsManager: any = null;

function ensureFrameworkLoaded(): void {
    if (!CSConfigurationManager) {
        CSConfigurationManager = require('../../../core/CSConfigurationManager').CSConfigurationManager;
    }
    if (!CSReporter) {
        CSReporter = require('../../../reporter/CSReporter').CSReporter;
    }
    if (!CSTestResultsManager) {
        CSTestResultsManager = require('../../../reporter/CSTestResultsManager').CSTestResultsManager;
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

function createTextResult(text: string): MCPToolResult {
    return {
        content: [{ type: 'text', text } as MCPTextContent],
    };
}

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

interface TestResult {
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    feature: string;
    tags: string[];
    duration: number;
    steps: Array<{
        name: string;
        status: string;
        duration: number;
        error?: string;
    }>;
    error?: string;
    runDate: Date;
    runId: string;
}

interface ReportData {
    suite?: {
        name: string;
        scenarios: any[];
        duration: number;
        startTime: string;
        endTime: string;
    };
    scenarios?: any[];
    stats?: {
        totalScenarios: number;
        passed: number;
        failed: number;
        skipped: number;
    };
    executionTime?: string;
    duration?: number;
}

/**
 * Get the reports base directory
 */
function getReportsDir(): string {
    ensureFrameworkLoaded();
    const config = CSConfigurationManager.getInstance();
    return config.get('REPORTS_BASE_DIR', './reports');
}

/**
 * Get all test result directories sorted by date
 */
function getTestResultDirs(daysBack: number = 30): string[] {
    const reportsDir = getReportsDir();

    if (!fs.existsSync(reportsDir)) {
        return [];
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);

    const dirs = fs.readdirSync(reportsDir)
        .filter(name => name.startsWith('test-results-'))
        .map(name => {
            const fullPath = path.join(reportsDir, name);
            const stat = fs.statSync(fullPath);
            return { name, path: fullPath, mtime: stat.mtime };
        })
        .filter(dir => dir.mtime >= cutoffDate)
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return dirs.map(d => d.path);
}

/**
 * Load report data from a test results directory
 */
function loadReportData(testResultDir: string): ReportData | null {
    const reportPath = path.join(testResultDir, 'reports', 'report-data.json');

    if (!fs.existsSync(reportPath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(reportPath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        return null;
    }
}

/**
 * Extract test results from report data
 */
function extractTestResults(reportData: ReportData, runId: string): TestResult[] {
    const results: TestResult[] = [];

    // Handle both suite format and direct scenarios format
    const scenarios = reportData.suite?.scenarios || reportData.scenarios || [];
    const executionTime = reportData.suite?.startTime || reportData.executionTime || new Date().toISOString();

    for (const scenario of scenarios) {
        results.push({
            name: scenario.name || 'Unknown',
            status: scenario.status === 'broken' ? 'failed' : scenario.status,
            feature: scenario.feature || 'Unknown',
            tags: scenario.tags || [],
            duration: scenario.duration || 0,
            steps: (scenario.steps || []).map((step: any) => ({
                name: step.name,
                status: step.status,
                duration: step.duration || 0,
                error: step.error,
            })),
            error: scenario.error,
            runDate: new Date(executionTime),
            runId,
        });
    }

    return results;
}

/**
 * Load all test results from the specified number of days
 */
function loadAllTestResults(daysBack: number = 30): TestResult[] {
    const allResults: TestResult[] = [];
    const dirs = getTestResultDirs(daysBack);

    for (const dir of dirs) {
        const runId = path.basename(dir);
        const reportData = loadReportData(dir);

        if (reportData) {
            const results = extractTestResults(reportData, runId);
            allResults.push(...results);
        }
    }

    return allResults;
}

/**
 * Calculate flakiness score for a test
 * Flakiness = percentage of runs where status differs from the mode (most common outcome)
 */
function calculateFlakiness(testRuns: TestResult[]): {
    flakinessScore: number;
    totalRuns: number;
    passed: number;
    failed: number;
    skipped: number;
    inconsistentRuns: number;
} {
    const passed = testRuns.filter(r => r.status === 'passed').length;
    const failed = testRuns.filter(r => r.status === 'failed').length;
    const skipped = testRuns.filter(r => r.status === 'skipped').length;
    const total = testRuns.length;

    // Mode is the most common outcome
    const mode = passed >= failed && passed >= skipped ? 'passed' :
                 failed >= skipped ? 'failed' : 'skipped';

    // Inconsistent runs are those that differ from the mode
    const inconsistentRuns = testRuns.filter(r => r.status !== mode).length;

    // Flakiness score is percentage of inconsistent runs
    const flakinessScore = total > 0 ? Math.round((inconsistentRuns / total) * 100) : 0;

    return {
        flakinessScore,
        totalRuns: total,
        passed,
        failed,
        skipped,
        inconsistentRuns,
    };
}

// ============================================================================
// Flakiness Analysis Tools
// ============================================================================

const analyzeFlakinessTool = defineTool()
    .name('analytics_flakiness')
    .description('Analyze test flakiness based on historical results from actual test runs')
    .category('analytics')
    .stringParam('testName', 'Specific test name to analyze (optional)')
    .numberParam('days', 'Number of days to analyze', { default: 30 })
    .numberParam('minRuns', 'Minimum runs required for analysis', { default: 3 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Analyzing test flakiness from real test results');
        CSReporter.info('[MCP] Analyzing test flakiness');

        const days = (params.days as number) || 30;
        const minRuns = (params.minRuns as number) || 3;
        const testNameFilter = params.testName as string | undefined;

        // Load all test results
        const allResults = loadAllTestResults(days);

        if (allResults.length === 0) {
            return createJsonResult({
                period: `${days} days`,
                message: 'No test results found in the specified period',
                tests: [],
                summary: {
                    totalTests: 0,
                    flakyTests: 0,
                    stableTests: 0,
                    averageFlakinessScore: 0,
                },
            });
        }

        // Group results by test name
        const testsByName = new Map<string, TestResult[]>();
        for (const result of allResults) {
            if (testNameFilter && !result.name.toLowerCase().includes(testNameFilter.toLowerCase())) {
                continue;
            }
            const existing = testsByName.get(result.name) || [];
            existing.push(result);
            testsByName.set(result.name, existing);
        }

        // Calculate flakiness for each test
        const flakinessResults: any[] = [];

        for (const [name, runs] of testsByName.entries()) {
            if (runs.length < minRuns) {
                continue;
            }

            const flakiness = calculateFlakiness(runs);
            const lastFailure = runs
                .filter(r => r.status === 'failed')
                .sort((a, b) => b.runDate.getTime() - a.runDate.getTime())[0];

            let suggestedAction = 'No action needed';
            if (flakiness.flakinessScore > 30) {
                // Check for common error patterns
                const errors = runs
                    .filter(r => r.error)
                    .map(r => r.error!.toLowerCase());

                if (errors.some(e => e.includes('timeout') || e.includes('timed out'))) {
                    suggestedAction = 'Increase timeouts or add explicit waits';
                } else if (errors.some(e => e.includes('element') && (e.includes('not found') || e.includes('not visible')))) {
                    suggestedAction = 'Add wait for element or check selector stability';
                } else if (errors.some(e => e.includes('network') || e.includes('connection'))) {
                    suggestedAction = 'Add network stability checks or retries';
                } else {
                    suggestedAction = 'Review test for race conditions or timing issues';
                }
            } else if (flakiness.flakinessScore > 10) {
                suggestedAction = 'Monitor closely - potential flakiness';
            }

            flakinessResults.push({
                name,
                flakinessScore: flakiness.flakinessScore,
                totalRuns: flakiness.totalRuns,
                passed: flakiness.passed,
                failed: flakiness.failed,
                skipped: flakiness.skipped,
                inconsistentRuns: flakiness.inconsistentRuns,
                lastFailure: lastFailure ? lastFailure.runDate.toISOString() : null,
                lastFailureError: lastFailure?.error || null,
                suggestedAction,
            });
        }

        // Sort by flakiness score descending
        flakinessResults.sort((a, b) => b.flakinessScore - a.flakinessScore);

        // Calculate summary
        const flakyTests = flakinessResults.filter(t => t.flakinessScore > 10).length;
        const stableTests = flakinessResults.filter(t => t.flakinessScore <= 10).length;
        const totalFlakinessScore = flakinessResults.reduce((sum, t) => sum + t.flakinessScore, 0);
        const averageFlakinessScore = flakinessResults.length > 0
            ? Math.round(totalFlakinessScore / flakinessResults.length)
            : 0;

        CSReporter.pass(`[MCP] Analyzed ${flakinessResults.length} tests, ${flakyTests} flaky`);

        return createJsonResult({
            period: `${days} days`,
            totalTestRuns: allResults.length,
            tests: flakinessResults,
            summary: {
                totalTests: flakinessResults.length,
                flakyTests,
                stableTests,
                averageFlakinessScore,
            },
        });
    })
    .readOnly()
    .build();

const getFlakyTestsTool = defineTool()
    .name('analytics_get_flaky_tests')
    .description('Get list of flaky tests sorted by flakiness score')
    .category('analytics')
    .numberParam('threshold', 'Minimum flakiness score to include', { default: 10 })
    .numberParam('limit', 'Maximum number of tests to return', { default: 20 })
    .numberParam('days', 'Number of days to analyze', { default: 30 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Getting flaky tests');

        const threshold = (params.threshold as number) || 10;
        const limit = (params.limit as number) || 20;
        const days = (params.days as number) || 30;

        const allResults = loadAllTestResults(days);

        // Group by test name
        const testsByName = new Map<string, TestResult[]>();
        for (const result of allResults) {
            const existing = testsByName.get(result.name) || [];
            existing.push(result);
            testsByName.set(result.name, existing);
        }

        // Calculate flakiness and filter
        const flakyTests: any[] = [];
        for (const [name, runs] of testsByName.entries()) {
            if (runs.length < 3) continue;

            const flakiness = calculateFlakiness(runs);
            if (flakiness.flakinessScore >= threshold) {
                flakyTests.push({
                    name,
                    flakinessScore: flakiness.flakinessScore,
                    totalRuns: flakiness.totalRuns,
                    passRate: Math.round((flakiness.passed / flakiness.totalRuns) * 100),
                    recentFailures: runs
                        .filter(r => r.status === 'failed')
                        .slice(0, 3)
                        .map(r => ({
                            date: r.runDate.toISOString(),
                            error: r.error?.substring(0, 100),
                        })),
                });
            }
        }

        // Sort and limit
        flakyTests.sort((a, b) => b.flakinessScore - a.flakinessScore);
        const limitedTests = flakyTests.slice(0, limit);

        return createJsonResult({
            threshold,
            period: `${days} days`,
            flakyTests: limitedTests,
            count: limitedTests.length,
            totalFlakyTests: flakyTests.length,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Execution Trend Tools
// ============================================================================

const analyzeExecutionTrendsTool = defineTool()
    .name('analytics_execution_trends')
    .description('Analyze test execution trends over time from real test runs')
    .category('analytics')
    .numberParam('days', 'Number of days to analyze', { default: 30 })
    .stringParam('granularity', 'Time granularity', {
        enum: ['daily', 'weekly', 'monthly'],
        default: 'daily',
    })
    .stringParam('tag', 'Filter by test tag')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Analyzing execution trends');
        CSReporter.info('[MCP] Analyzing execution trends');

        const days = (params.days as number) || 30;
        const granularity = (params.granularity as string) || 'daily';
        const tagFilter = params.tag as string | undefined;

        const allResults = loadAllTestResults(days);

        // Filter by tag if specified
        const filteredResults = tagFilter
            ? allResults.filter(r => r.tags.some(t => t.toLowerCase().includes(tagFilter.toLowerCase())))
            : allResults;

        if (filteredResults.length === 0) {
            return createJsonResult({
                period: `${days} days`,
                granularity,
                message: 'No test results found',
                trends: [],
                summary: {
                    averagePassRate: 0,
                    passRateTrend: 'unknown',
                    averageDuration: 0,
                    durationTrend: 'unknown',
                },
            });
        }

        // Group by date according to granularity
        const groupedByPeriod = new Map<string, TestResult[]>();

        for (const result of filteredResults) {
            let periodKey: string;
            const date = result.runDate;

            if (granularity === 'weekly') {
                // Get week start (Sunday)
                const weekStart = new Date(date);
                weekStart.setDate(weekStart.getDate() - weekStart.getDay());
                periodKey = weekStart.toISOString().split('T')[0];
            } else if (granularity === 'monthly') {
                periodKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            } else {
                periodKey = date.toISOString().split('T')[0];
            }

            const existing = groupedByPeriod.get(periodKey) || [];
            existing.push(result);
            groupedByPeriod.set(periodKey, existing);
        }

        // Calculate trends for each period
        const trends: any[] = [];
        const sortedPeriods = Array.from(groupedByPeriod.keys()).sort();

        for (const period of sortedPeriods) {
            const results = groupedByPeriod.get(period)!;
            const passed = results.filter(r => r.status === 'passed').length;
            const failed = results.filter(r => r.status === 'failed').length;
            const skipped = results.filter(r => r.status === 'skipped').length;
            const total = results.length;
            const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

            trends.push({
                date: period,
                totalTests: total,
                passed,
                failed,
                skipped,
                passRate: Math.round((passed / total) * 100),
                averageDuration: Math.round(totalDuration / total),
            });
        }

        // Calculate summary
        const passRates = trends.map(t => t.passRate);
        const durations = trends.map(t => t.averageDuration);

        const avgPassRate = Math.round(passRates.reduce((a, b) => a + b, 0) / passRates.length);
        const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

        // Determine trends (comparing first half to second half)
        const midpoint = Math.floor(passRates.length / 2);
        const firstHalfPassRate = passRates.slice(0, midpoint).reduce((a, b) => a + b, 0) / midpoint || 0;
        const secondHalfPassRate = passRates.slice(midpoint).reduce((a, b) => a + b, 0) / (passRates.length - midpoint) || 0;
        const passRateTrend = secondHalfPassRate > firstHalfPassRate + 2 ? 'improving' :
                             secondHalfPassRate < firstHalfPassRate - 2 ? 'declining' : 'stable';

        const firstHalfDuration = durations.slice(0, midpoint).reduce((a, b) => a + b, 0) / midpoint || 0;
        const secondHalfDuration = durations.slice(midpoint).reduce((a, b) => a + b, 0) / (durations.length - midpoint) || 0;
        const durationTrend = secondHalfDuration < firstHalfDuration * 0.95 ? 'improving' :
                             secondHalfDuration > firstHalfDuration * 1.05 ? 'slowing' : 'stable';

        CSReporter.pass(`[MCP] Analyzed ${filteredResults.length} tests across ${trends.length} periods`);

        return createJsonResult({
            period: `${days} days`,
            granularity,
            tag: tagFilter || 'all',
            totalTestRuns: filteredResults.length,
            trends,
            summary: {
                averagePassRate: avgPassRate,
                passRateTrend,
                averageDuration: avgDuration,
                durationTrend,
            },
        });
    })
    .readOnly()
    .build();

const getDurationAnalysisTool = defineTool()
    .name('analytics_duration_analysis')
    .description('Analyze test execution duration patterns from real test runs')
    .category('analytics')
    .stringParam('testName', 'Specific test to analyze')
    .numberParam('days', 'Number of days to analyze', { default: 14 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Analyzing test durations');

        const days = (params.days as number) || 14;
        const testNameFilter = params.testName as string | undefined;

        const allResults = loadAllTestResults(days);

        // Filter by test name if specified
        const filteredResults = testNameFilter
            ? allResults.filter(r => r.name.toLowerCase().includes(testNameFilter.toLowerCase()))
            : allResults;

        if (filteredResults.length === 0) {
            return createJsonResult({
                period: `${days} days`,
                testName: testNameFilter || 'all',
                message: 'No test results found',
                analysis: null,
            });
        }

        // Extract durations
        const durations = filteredResults.map(r => r.duration).filter(d => d > 0).sort((a, b) => a - b);

        if (durations.length === 0) {
            return createJsonResult({
                period: `${days} days`,
                message: 'No duration data available',
                analysis: null,
            });
        }

        // Calculate statistics
        const sum = durations.reduce((a, b) => a + b, 0);
        const average = Math.round(sum / durations.length);
        const median = durations[Math.floor(durations.length / 2)];
        const p90Index = Math.floor(durations.length * 0.9);
        const p95Index = Math.floor(durations.length * 0.95);
        const p90 = durations[p90Index] || durations[durations.length - 1];
        const p95 = durations[p95Index] || durations[durations.length - 1];
        const min = durations[0];
        const max = durations[durations.length - 1];

        // Calculate standard deviation
        const squaredDiffs = durations.map(d => Math.pow(d - average, 2));
        const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
        const stdDev = Math.round(Math.sqrt(avgSquaredDiff));

        // Find slowest tests
        const testDurations = new Map<string, number[]>();
        for (const result of filteredResults) {
            const existing = testDurations.get(result.name) || [];
            existing.push(result.duration);
            testDurations.set(result.name, existing);
        }

        const slowestTests = Array.from(testDurations.entries())
            .map(([name, durs]) => ({
                name,
                averageDuration: Math.round(durs.reduce((a, b) => a + b, 0) / durs.length),
                maxDuration: Math.max(...durs),
                runs: durs.length,
            }))
            .sort((a, b) => b.averageDuration - a.averageDuration)
            .slice(0, 10);

        // Determine trend
        const recentDurations = filteredResults
            .sort((a, b) => b.runDate.getTime() - a.runDate.getTime())
            .slice(0, Math.ceil(filteredResults.length / 3))
            .map(r => r.duration);
        const recentAvg = recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length;

        const durationTrend = recentAvg < average * 0.9 ? 'improving' :
                             recentAvg > average * 1.1 ? 'slowing' : 'stable';

        return createJsonResult({
            period: `${days} days`,
            testName: testNameFilter || 'all',
            totalRuns: filteredResults.length,
            analysis: {
                average,
                median,
                p90,
                p95,
                min,
                max,
                stdDev,
            },
            slowestTests,
            durationTrend,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Failure Analysis Tools
// ============================================================================

const analyzeFailurePatternsTool = defineTool()
    .name('analytics_failure_patterns')
    .description('Analyze common failure patterns and root causes from real test results')
    .category('analytics')
    .numberParam('days', 'Number of days to analyze', { default: 7 })
    .numberParam('minOccurrences', 'Minimum occurrences to include', { default: 2 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Analyzing failure patterns');
        CSReporter.info('[MCP] Analyzing failure patterns');

        const days = (params.days as number) || 7;
        const minOccurrences = (params.minOccurrences as number) || 2;

        const allResults = loadAllTestResults(days);
        const failedTests = allResults.filter(r => r.status === 'failed');

        if (failedTests.length === 0) {
            return createJsonResult({
                period: `${days} days`,
                message: 'No failures found in the specified period',
                patterns: [],
                summary: {
                    totalFailures: 0,
                    uniquePatterns: 0,
                },
            });
        }

        // Extract and categorize errors
        const errorPatterns = new Map<string, { count: number; tests: Set<string>; examples: string[] }>();

        const patternCategories = [
            { pattern: 'timeout', keywords: ['timeout', 'timed out', 'exceeded timeout'] },
            { pattern: 'element_not_found', keywords: ['element not found', 'no element', 'locator resolved to'] },
            { pattern: 'element_not_visible', keywords: ['not visible', 'hidden', 'obscured'] },
            { pattern: 'network_error', keywords: ['network', 'connection', 'ECONNREFUSED', 'fetch failed'] },
            { pattern: 'assertion_failed', keywords: ['expect', 'assertion', 'to equal', 'to contain', 'to be'] },
            { pattern: 'navigation_failed', keywords: ['navigation', 'goto', 'net::ERR'] },
            { pattern: 'authentication', keywords: ['auth', 'login', 'credentials', '401', '403'] },
            { pattern: 'database', keywords: ['database', 'sql', 'query', 'connection pool'] },
        ];

        for (const test of failedTests) {
            // Get error message from test or from failed steps
            let errorMessage = test.error || '';
            const failedStep = test.steps.find(s => s.status === 'failed');
            if (failedStep?.error) {
                errorMessage = errorMessage || failedStep.error;
            }

            if (!errorMessage) continue;

            const errorLower = errorMessage.toLowerCase();

            // Categorize the error
            let categorized = false;
            for (const category of patternCategories) {
                if (category.keywords.some(kw => errorLower.includes(kw))) {
                    const existing = errorPatterns.get(category.pattern) || { count: 0, tests: new Set(), examples: [] };
                    existing.count++;
                    existing.tests.add(test.name);
                    if (existing.examples.length < 3) {
                        existing.examples.push(errorMessage.substring(0, 200));
                    }
                    errorPatterns.set(category.pattern, existing);
                    categorized = true;
                    break;
                }
            }

            // If not categorized, add to 'other'
            if (!categorized) {
                const existing = errorPatterns.get('other') || { count: 0, tests: new Set(), examples: [] };
                existing.count++;
                existing.tests.add(test.name);
                if (existing.examples.length < 3) {
                    existing.examples.push(errorMessage.substring(0, 200));
                }
                errorPatterns.set('other', existing);
            }
        }

        // Build patterns list
        const patterns: any[] = [];
        const suggestedFixes: Record<string, string> = {
            timeout: 'Increase timeouts or add explicit waits for elements',
            element_not_found: 'Verify selector stability or add wait for element',
            element_not_visible: 'Add explicit wait for visibility or scroll element into view',
            network_error: 'Add retry logic or check network stability',
            assertion_failed: 'Review expected values or add more specific assertions',
            navigation_failed: 'Check URL validity and add navigation retries',
            authentication: 'Verify credentials and session handling',
            database: 'Check database connectivity and query syntax',
            other: 'Review error details and add specific handling',
        };

        for (const [pattern, data] of errorPatterns.entries()) {
            if (data.count >= minOccurrences) {
                patterns.push({
                    pattern: pattern.replace(/_/g, ' '),
                    count: data.count,
                    affectedTests: Array.from(data.tests).slice(0, 10),
                    exampleErrors: data.examples,
                    suggestedFix: suggestedFixes[pattern] || 'Review error details',
                });
            }
        }

        patterns.sort((a, b) => b.count - a.count);

        CSReporter.pass(`[MCP] Found ${patterns.length} failure patterns from ${failedTests.length} failures`);

        return createJsonResult({
            period: `${days} days`,
            patterns,
            summary: {
                totalFailures: failedTests.length,
                uniquePatterns: patterns.length,
                mostCommonPattern: patterns[0]?.pattern || 'none',
            },
        });
    })
    .readOnly()
    .build();

const getRecentFailuresTool = defineTool()
    .name('analytics_recent_failures')
    .description('Get recent test failures with details')
    .category('analytics')
    .numberParam('limit', 'Maximum number of failures to return', { default: 20 })
    .stringParam('feature', 'Filter by feature name')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const limit = (params.limit as number) || 20;
        const featureFilter = params.feature as string | undefined;

        const allResults = loadAllTestResults(7); // Last 7 days
        let failures = allResults.filter(r => r.status === 'failed');

        if (featureFilter) {
            failures = failures.filter(r =>
                r.feature.toLowerCase().includes(featureFilter.toLowerCase())
            );
        }

        // Sort by date descending
        failures.sort((a, b) => b.runDate.getTime() - a.runDate.getTime());

        const recentFailures = failures.slice(0, limit).map(f => ({
            name: f.name,
            feature: f.feature,
            date: f.runDate.toISOString(),
            duration: f.duration,
            error: f.error?.substring(0, 300),
            failedStep: f.steps.find(s => s.status === 'failed')?.name,
            tags: f.tags,
        }));

        return createJsonResult({
            failures: recentFailures,
            totalFailures: failures.length,
            showing: recentFailures.length,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Report Generation Tools
// ============================================================================

const generateExecutiveReportTool = defineTool()
    .name('analytics_executive_report')
    .description('Generate executive summary report from real test data')
    .category('analytics')
    .stringParam('period', 'Report period', {
        enum: ['daily', 'weekly', 'monthly', 'quarterly'],
        default: 'weekly',
    })
    .stringParam('format', 'Output format', {
        enum: ['json', 'markdown', 'html'],
        default: 'markdown',
    })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', `Generating ${params.period} executive report`);
        CSReporter.info(`[MCP] Generating ${params.period} executive report`);

        const periodDays: Record<string, number> = {
            daily: 1,
            weekly: 7,
            monthly: 30,
            quarterly: 90,
        };

        const days = periodDays[params.period as string] || 7;
        const allResults = loadAllTestResults(days);
        const previousResults = loadAllTestResults(days * 2).filter(r =>
            r.runDate.getTime() < Date.now() - days * 24 * 60 * 60 * 1000
        );

        // Current period stats
        const currentPassed = allResults.filter(r => r.status === 'passed').length;
        const currentFailed = allResults.filter(r => r.status === 'failed').length;
        const currentTotal = allResults.length;
        const currentPassRate = currentTotal > 0 ? Math.round((currentPassed / currentTotal) * 100 * 10) / 10 : 0;
        const currentAvgDuration = currentTotal > 0
            ? Math.round(allResults.reduce((sum, r) => sum + r.duration, 0) / currentTotal)
            : 0;

        // Previous period stats for comparison
        const previousPassed = previousResults.filter(r => r.status === 'passed').length;
        const previousTotal = previousResults.length;
        const previousPassRate = previousTotal > 0 ? Math.round((previousPassed / previousTotal) * 100 * 10) / 10 : 0;
        const previousAvgDuration = previousTotal > 0
            ? Math.round(previousResults.reduce((sum, r) => sum + r.duration, 0) / previousTotal)
            : 0;

        // Calculate changes
        const passRateChange = Math.round((currentPassRate - previousPassRate) * 10) / 10;
        const durationChange = previousAvgDuration > 0
            ? Math.round(((currentAvgDuration - previousAvgDuration) / previousAvgDuration) * 100)
            : 0;

        // Count flaky tests
        const testsByName = new Map<string, TestResult[]>();
        for (const r of allResults) {
            const existing = testsByName.get(r.name) || [];
            existing.push(r);
            testsByName.set(r.name, existing);
        }
        const flakyCount = Array.from(testsByName.values())
            .filter(runs => {
                if (runs.length < 3) return false;
                const flakiness = calculateFlakiness(runs);
                return flakiness.flakinessScore > 10;
            }).length;

        // New failures (tests that passed before but fail now)
        const currentFailedNames = new Set(allResults.filter(r => r.status === 'failed').map(r => r.name));
        const previousPassedNames = new Set(previousResults.filter(r => r.status === 'passed').map(r => r.name));
        const newFailures = Array.from(currentFailedNames).filter(name => previousPassedNames.has(name));

        const formatDuration = (ms: number) => {
            if (ms < 1000) return `${ms}ms`;
            if (ms < 60000) return `${Math.round(ms / 1000)}s`;
            return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
        };

        const report = {
            period: params.period,
            generatedAt: new Date().toISOString(),
            summary: {
                totalTests: currentTotal,
                passRate: currentPassRate,
                passRateChange,
                averageDuration: formatDuration(currentAvgDuration),
                durationChange,
                flakyTests: flakyCount,
                newFailures: newFailures.length,
            },
            highlights: [
                currentTotal > 0 ? `${currentTotal} test executions analyzed` : 'No test executions in this period',
                passRateChange > 0 ? `Pass rate improved by ${passRateChange}%` :
                    passRateChange < 0 ? `Pass rate decreased by ${Math.abs(passRateChange)}%` :
                    'Pass rate stable',
                durationChange < -5 ? `Test duration improved by ${Math.abs(durationChange)}%` :
                    durationChange > 5 ? `Test duration increased by ${durationChange}%` :
                    'Test duration stable',
                newFailures.length > 0 ? `${newFailures.length} new test failures detected` : 'No new failures',
            ].filter(h => h),
            recommendations: [
                ...(newFailures.length > 0 ? [`Investigate ${newFailures.length} new failures: ${newFailures.slice(0, 3).join(', ')}`] : []),
                ...(flakyCount > 5 ? [`Review ${flakyCount} flaky tests for stability improvements`] : []),
                ...(durationChange > 10 ? ['Investigate test performance degradation'] : []),
                ...(currentPassRate < 90 ? ['Focus on improving test reliability'] : []),
            ],
            newFailuresList: newFailures.slice(0, 10),
        };

        if (params.format === 'markdown') {
            const markdown = `# Test Execution Report (${params.period})

## Summary
- **Total Tests:** ${report.summary.totalTests}
- **Pass Rate:** ${report.summary.passRate}% (${report.summary.passRateChange > 0 ? '+' : ''}${report.summary.passRateChange}%)
- **Average Duration:** ${report.summary.averageDuration} (${report.summary.durationChange > 0 ? '+' : ''}${report.summary.durationChange}%)
- **Flaky Tests:** ${report.summary.flakyTests}
- **New Failures:** ${report.summary.newFailures}

## Highlights
${report.highlights.map(h => `- ${h}`).join('\n')}

## Recommendations
${report.recommendations.length > 0 ? report.recommendations.map(r => `- ${r}`).join('\n') : '- No immediate actions required'}

${report.newFailuresList.length > 0 ? `## New Failures\n${report.newFailuresList.map(f => `- ${f}`).join('\n')}` : ''}

*Generated: ${report.generatedAt}*
`;
            CSReporter.pass('[MCP] Executive report generated');
            return createTextResult(markdown);
        }

        CSReporter.pass('[MCP] Executive report generated');
        return createJsonResult(report);
    })
    .readOnly()
    .build();

const getTestSummaryTool = defineTool()
    .name('analytics_test_summary')
    .description('Get a quick summary of recent test results')
    .category('analytics')
    .numberParam('days', 'Number of days to summarize', { default: 7 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const days = (params.days as number) || 7;
        const allResults = loadAllTestResults(days);

        const passed = allResults.filter(r => r.status === 'passed').length;
        const failed = allResults.filter(r => r.status === 'failed').length;
        const skipped = allResults.filter(r => r.status === 'skipped').length;
        const total = allResults.length;

        const uniqueTests = new Set(allResults.map(r => r.name)).size;
        const uniqueFeatures = new Set(allResults.map(r => r.feature)).size;

        const avgDuration = total > 0
            ? Math.round(allResults.reduce((sum, r) => sum + r.duration, 0) / total)
            : 0;

        // Get test run counts
        const runDirs = getTestResultDirs(days);

        return createJsonResult({
            period: `${days} days`,
            testRuns: runDirs.length,
            totalExecutions: total,
            uniqueTests,
            uniqueFeatures,
            passed,
            failed,
            skipped,
            passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
            averageDuration: avgDuration,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Export all analytics tools
// ============================================================================

export const analyticsTools: MCPToolDefinition[] = [
    // Flakiness
    analyzeFlakinessTool,
    getFlakyTestsTool,

    // Trends
    analyzeExecutionTrendsTool,
    getDurationAnalysisTool,

    // Failure Analysis
    analyzeFailurePatternsTool,
    getRecentFailuresTool,

    // Reports
    generateExecutiveReportTool,
    getTestSummaryTool,
];

/**
 * Register all analytics tools with the registry
 */
export function registerAnalyticsTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(analyticsTools);
}
