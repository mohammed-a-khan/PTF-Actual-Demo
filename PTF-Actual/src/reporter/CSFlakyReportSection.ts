/**
 * CSFlakyReportSection - Intelligent Test Health & Stability for HTML reports.
 *
 * Shows flakiness data ONLY for tests in the current run, using historical
 * data from `.flaky-test-data/` to compute scores across multiple runs.
 *
 * Intelligence features:
 * - Failure categorization from actual error messages
 * - Confidence score based on number of historical runs
 * - Duration analysis (tests that are slower when failing)
 * - Trend detection (improving/degrading/steady)
 * - Smart fix suggestions based on failure patterns
 * - Visual run history (last 10 pass/fail dots)
 */

import { htmlEscape } from './utils/HtmlSanitizer';

// ============================================================================
// Health Levels
// ============================================================================

interface HealthConfig {
    icon: string;
    label: string;
    color: string;
    bgColor: string;
    cssClass: string;
}

const HEALTH_LEVELS: Array<{ maxScore: number; config: HealthConfig }> = [
    { maxScore: 0,   config: { icon: '✅', label: 'Solid',   color: '#166534', bgColor: '#dcfce7', cssClass: 'health-solid' } },
    { maxScore: 10,  config: { icon: '✅', label: 'Stable',  color: '#166534', bgColor: '#dcfce7', cssClass: 'health-stable' } },
    { maxScore: 25,  config: { icon: '🟡', label: 'Shaky',   color: '#854d0e', bgColor: '#fef9c3', cssClass: 'health-shaky' } },
    { maxScore: 40,  config: { icon: '🟠', label: 'Flaky',   color: '#9a3412', bgColor: '#ffedd5', cssClass: 'health-flaky' } },
    { maxScore: 60,  config: { icon: '🔴', label: 'Broken',  color: '#991b1b', bgColor: '#fee2e2', cssClass: 'health-broken' } },
    { maxScore: 100, config: { icon: '⛔', label: 'Toxic',   color: '#7f1d1d', bgColor: '#fecaca', cssClass: 'health-toxic' } },
];

function getHealthConfig(score: number): HealthConfig {
    for (const level of HEALTH_LEVELS) {
        if (score <= level.maxScore) return level.config;
    }
    return HEALTH_LEVELS[HEALTH_LEVELS.length - 1].config;
}

// ============================================================================
// Failure Categorization
// ============================================================================

interface FailureCategory {
    category: string;
    icon: string;
    color: string;
    fixSuggestion: string;
}

function categorizeErrors(errors: string[]): FailureCategory {
    if (errors.length === 0) return { category: 'None', icon: '✅', color: '#22c55e', fixSuggestion: '' };

    const combined = errors.join(' ').toLowerCase();

    if (/timeout|timed out|waitfor.*exceeded/i.test(combined)) {
        return {
            category: 'Timeout',
            icon: '⏱️',
            color: '#f59e0b',
            fixSuggestion: 'Add explicit waits (waitForSelector, waitForLoadState) before the failing action. Consider increasing step timeout.',
        };
    }
    if (/not found|no element|no such element|could not find|locator resolved to 0/i.test(combined)) {
        return {
            category: 'Element Not Found',
            icon: '🔍',
            color: '#f97316',
            fixSuggestion: 'Element locator may be fragile. Use data-testid or getByRole instead of CSS selectors. Enable selfHeal: true on @CSGetElement.',
        };
    }
    if (/expected.*but.*got|assertion|expect.*to|tocontain|tohave|tobe/i.test(combined)) {
        return {
            category: 'Assertion Failed',
            icon: '❌',
            color: '#ef4444',
            fixSuggestion: 'Assertion depends on dynamic data. Use data-driven approach or add tolerance for variable values.',
        };
    }
    if (/navigation|net::err|econnrefused|econnreset|connection|fetch failed/i.test(combined)) {
        return {
            category: 'Network/Navigation',
            icon: '🌐',
            color: '#8b5cf6',
            fixSuggestion: 'Network instability. Add retry logic for navigation. Verify server is available before test.',
        };
    }
    if (/detached|frame|execution context|target closed|session closed/i.test(combined)) {
        return {
            category: 'Page Lifecycle',
            icon: '🔄',
            color: '#6366f1',
            fixSuggestion: 'Page navigated or closed during action. Add waitForLoadState("networkidle") after navigations.',
        };
    }
    if (/intercepted|other element|obscured|click.*intercepted/i.test(combined)) {
        return {
            category: 'Click Intercepted',
            icon: '🖱️',
            color: '#ec4899',
            fixSuggestion: 'Element is behind an overlay, popup, or spinner. Dismiss modal/wait for spinner before clicking.',
        };
    }
    return {
        category: 'Other',
        icon: '❓',
        color: '#64748b',
        fixSuggestion: 'Review the error messages manually to identify the root cause.',
    };
}

// ============================================================================
// Analysis Helpers
// ============================================================================

function getTrend(results: any[]): { arrow: string; label: string; color: string } {
    if (!results || results.length < 3) return { arrow: '—', label: 'Need more data', color: '#94a3b8' };

    const recent = results.slice(-3);
    const previous = results.slice(-6, -3);
    if (previous.length < 2) return { arrow: '—', label: 'Building history', color: '#94a3b8' };

    const recentPassRate = recent.filter((r: any) => r.status === 'passed').length / recent.length;
    const prevPassRate = previous.filter((r: any) => r.status === 'passed').length / previous.length;
    const diff = recentPassRate - prevPassRate;

    if (diff > 0.1) return { arrow: '↗', label: 'Improving', color: '#22c55e' };
    if (diff < -0.1) return { arrow: '↘', label: 'Degrading', color: '#ef4444' };
    return { arrow: '→', label: 'Steady', color: '#64748b' };
}

function getConfidence(totalRuns: number): { level: string; color: string; percent: number } {
    if (totalRuns <= 1) return { level: 'None', color: '#94a3b8', percent: 0 };
    if (totalRuns <= 3) return { level: 'Low', color: '#f59e0b', percent: 25 };
    if (totalRuns <= 7) return { level: 'Medium', color: '#3b82f6', percent: 60 };
    if (totalRuns <= 15) return { level: 'High', color: '#22c55e', percent: 85 };
    return { level: 'Very High', color: '#166534', percent: 100 };
}

function getDurationInsight(results: any[]): string | null {
    if (results.length < 3) return null;
    const passed = results.filter((r: any) => r.status === 'passed' && r.duration > 0);
    const failed = results.filter((r: any) => r.status === 'failed' && r.duration > 0);
    if (passed.length === 0 || failed.length === 0) return null;

    const avgPass = passed.reduce((s: number, r: any) => s + r.duration, 0) / passed.length;
    const avgFail = failed.reduce((s: number, r: any) => s + r.duration, 0) / failed.length;

    if (avgFail > avgPass * 1.5) {
        return `⚡ ${Math.round(avgFail / 1000)}s avg when failing vs ${Math.round(avgPass / 1000)}s when passing — likely hitting timeouts`;
    }
    if (avgPass > avgFail * 1.5) {
        return `⚡ Passes are slower (${Math.round(avgPass / 1000)}s) than failures (${Math.round(avgFail / 1000)}s) — may fail fast on missing elements`;
    }
    return null;
}

function getLastFailureSnippet(results: any[]): string | null {
    const lastFail = [...results].reverse().find((r: any) => r.status === 'failed' && r.error);
    if (!lastFail) return null;
    // Truncate and clean error message
    let msg = (lastFail.error || '').replace(/\x1b\[\d+m/g, '').trim();
    if (msg.length > 150) msg = msg.substring(0, 147) + '...';
    return msg;
}

// ============================================================================
// Public API
// ============================================================================

export function collectFlakyData(currentTestNames?: string[]): any {
    try {
        const { CSFlakyTestDetector } = require('../flaky/CSFlakyTestDetector');
        const detector = CSFlakyTestDetector.getInstance();
        const report = detector.generateFlakinessReport();

        if (!report) return null;
        if (!currentTestNames || currentTestNames.length === 0) return null;

        const currentSet = new Set(currentTestNames);
        const enrichedTests: any[] = [];

        for (const testName of currentTestNames) {
            const existing = report.tests.find((t: any) =>
                t.testName === testName || t.testId === testName
            );

            if (existing) {
                const history = detector.getTestHistory(existing.testId);
                const errors = history.filter((r: any) => r.error).map((r: any) => r.error);
                const failureCategory = categorizeErrors(errors);
                const trend = getTrend(history);
                const confidence = getConfidence(existing.totalRuns);
                const durationInsight = getDurationInsight(history);
                const lastError = getLastFailureSnippet(history);

                enrichedTests.push({
                    ...existing,
                    trend,
                    confidence,
                    health: getHealthConfig(existing.score),
                    failureCategory,
                    durationInsight,
                    lastError,
                    runHistory: history.slice(-10).map((r: any) => r.status === 'passed' ? '✓' : '✗'),
                });
            } else {
                enrichedTests.push({
                    testId: testName,
                    testName: testName,
                    score: -1,
                    totalRuns: 1,
                    passRate: -1,
                    pattern: 'new',
                    patternDescription: 'First run — no history yet',
                    recommendation: 'new',
                    trend: { arrow: '🆕', label: 'First run', color: '#3b82f6' },
                    confidence: { level: 'None', color: '#94a3b8', percent: 0 },
                    health: { icon: '🆕', label: 'New', color: '#1e40af', bgColor: '#dbeafe', cssClass: 'health-new' },
                    failureCategory: { category: 'None', icon: '✅', color: '#22c55e', fixSuggestion: '' },
                    durationInsight: null,
                    lastError: null,
                    runHistory: [],
                });
            }
        }

        enrichedTests.sort((a, b) => {
            if (a.score === -1 && b.score === -1) return 0;
            if (a.score === -1) return 1;
            if (b.score === -1) return -1;
            return b.score - a.score;
        });

        const withHistory = enrichedTests.filter(t => t.score >= 0);
        const threshold = 10;
        const quarantineThreshold = 40;

        return {
            totalTests: enrichedTests.length,
            testsWithHistory: withHistory.length,
            newTests: enrichedTests.filter(t => t.score === -1).length,
            flakyTests: withHistory.filter(t => t.score > threshold).length,
            quarantinedTests: withHistory.filter(t => t.score > quarantineThreshold).length,
            stableTests: withHistory.filter(t => t.score <= threshold).length,
            averageFlakinessScore: withHistory.length > 0
                ? Math.round(withHistory.reduce((s: number, t: any) => s + t.score, 0) / withHistory.length * 100) / 100
                : 0,
            tests: enrichedTests,
            // Aggregate failure categories
            failureSummary: (() => {
                const cats: Record<string, number> = {};
                for (const t of withHistory) {
                    if (t.failureCategory.category !== 'None') {
                        cats[t.failureCategory.category] = (cats[t.failureCategory.category] || 0) + 1;
                    }
                }
                return cats;
            })(),
        };
    } catch (e) {
        return null;
    }
}

export function generateFlakyCSS(): string {
    return `
        .stability-section { padding: 24px; }
        .stability-section h3 { font-size: 1.25rem; font-weight: 600; margin-bottom: 8px; color: #1e293b; }
        .stability-subtitle { font-size: 0.85rem; color: #64748b; margin-bottom: 20px; }

        .score-legend {
            display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px;
            padding: 12px 16px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;
        }
        .legend-item { display: flex; align-items: center; gap: 4px; font-size: 0.78rem; color: #475569; }
        .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }

        .stability-summary { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
        .metric-card-flaky {
            flex: 1; min-width: 90px; background: #f8fafc; border: 1px solid #e2e8f0;
            border-radius: 10px; padding: 14px; text-align: center;
        }
        .metric-card-flaky .metric-value { font-size: 1.6rem; font-weight: 700; color: #22c55e; }
        .metric-card-flaky.warning .metric-value { color: #f59e0b; }
        .metric-card-flaky.danger .metric-value { color: #ef4444; }
        .metric-card-flaky.info .metric-value { color: #3b82f6; }
        .metric-card-flaky .metric-label { font-size: 0.78rem; color: #64748b; margin-top: 2px; }

        /* Failure category pills */
        .failure-cats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
        .failure-cat-pill {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 4px 12px; border-radius: 16px; font-size: 0.78rem; font-weight: 500;
            background: #f1f5f9; border: 1px solid #e2e8f0;
        }

        .flaky-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
        .flaky-table th {
            background: #f1f5f9; padding: 10px 10px; text-align: left;
            font-weight: 600; color: #334155; border-bottom: 2px solid #e2e8f0; font-size: 0.78rem;
        }
        .flaky-table td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; color: #475569; vertical-align: top; }
        .flaky-table tr:hover { background: #f8fafc; }

        .health-badge {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 3px 10px; border-radius: 12px; font-weight: 600; font-size: 0.75rem; white-space: nowrap;
        }

        .score-bar-container { display: flex; align-items: center; gap: 6px; }
        .score-bar { width: 50px; height: 5px; background: #e2e8f0; border-radius: 3px; overflow: hidden; }
        .score-bar-fill { height: 100%; border-radius: 3px; }
        .score-value { font-weight: 700; font-size: 0.78rem; min-width: 20px; }

        .run-history { display: flex; gap: 1px; }
        .run-dot {
            width: 12px; height: 12px; border-radius: 2px; display: flex;
            align-items: center; justify-content: center; font-size: 8px;
        }
        .run-dot.pass { background: #dcfce7; color: #166534; }
        .run-dot.fail { background: #fee2e2; color: #991b1b; }

        .trend-badge { font-size: 0.75rem; display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; }
        .confidence-bar { display: flex; align-items: center; gap: 4px; }
        .confidence-track { width: 40px; height: 4px; background: #e2e8f0; border-radius: 2px; overflow: hidden; }
        .confidence-fill { height: 100%; border-radius: 2px; }
        .confidence-label { font-size: 0.7rem; }

        /* Expandable details */
        .test-details { margin-top: 4px; }
        .detail-row { font-size: 0.75rem; color: #64748b; margin-top: 2px; line-height: 1.4; }
        .detail-row .detail-icon { margin-right: 4px; }
        .error-snippet {
            font-family: monospace; font-size: 0.7rem; color: #991b1b;
            background: #fef2f2; padding: 4px 8px; border-radius: 4px; margin-top: 4px;
            white-space: pre-wrap; word-break: break-all; max-height: 60px; overflow: hidden;
        }
        .fix-suggestion {
            font-size: 0.72rem; color: #1e40af; background: #eff6ff;
            padding: 4px 8px; border-radius: 4px; margin-top: 4px; border-left: 3px solid #3b82f6;
        }

        .health-new-row { opacity: 0.65; }
    `;
}

export function generateFlakyNavItem(): string {
    return `
                <div class="nav-item" data-view="stability">
                    🛡️ Test Health
                </div>`;
}

export function generateFlakySection(flakyData: any): string {
    if (!flakyData) {
        // Always render the container so the nav switch doesn't error
        return `<div id="stability-view" class="view"><div class="stability-section"><h3>🛡️ Test Stability Analysis</h3><p style="color:#94a3b8;text-align:center;padding:40px">Run this test suite multiple times to build stability data.<br>Flakiness scores are computed by comparing results across runs.</p></div></div>`;
    }
    const tests: any[] = flakyData.tests ?? [];
    if (tests.length === 0) {
        return `<div id="stability-view" class="view"><div class="stability-section"><h3>🛡️ Test Stability Analysis</h3><p style="color:#94a3b8;text-align:center;padding:40px">No test data available for stability analysis.</p></div></div>`;
    }

    // Summary cards
    const summaryHTML = `
        <div class="stability-summary">
            <div class="metric-card-flaky">
                <div class="metric-value">${flakyData.stableTests}</div>
                <div class="metric-label">✅ Stable</div>
            </div>
            <div class="metric-card-flaky warning">
                <div class="metric-value">${flakyData.flakyTests}</div>
                <div class="metric-label">🟡 Flaky</div>
            </div>
            <div class="metric-card-flaky danger">
                <div class="metric-value">${flakyData.quarantinedTests}</div>
                <div class="metric-label">🔴 Needs Fix</div>
            </div>
            <div class="metric-card-flaky info">
                <div class="metric-value">${flakyData.newTests}</div>
                <div class="metric-label">🆕 First Run</div>
            </div>
        </div>`;

    // Failure category breakdown
    const failureSummary: Record<string, number> = flakyData.failureSummary || {};
    const catEntries = Object.entries(failureSummary);
    let failureCatsHTML = '';
    if (catEntries.length > 0) {
        const pills = catEntries.map(([cat, count]) => {
            const catInfo = categorizeErrors([cat.toLowerCase()]);
            return `<span class="failure-cat-pill">${catInfo.icon} ${htmlEscape(cat)}: <strong>${count}</strong></span>`;
        }).join('');
        failureCatsHTML = `
            <div style="margin-bottom:16px">
                <div style="font-size:0.8rem;font-weight:600;color:#475569;margin-bottom:6px">Common Failure Types in This Suite</div>
                <div class="failure-cats">${pills}</div>
            </div>`;
    }

    // Score legend
    const legendHTML = `
        <div class="score-legend">
            <span style="font-weight:600;color:#334155;margin-right:6px;">Score:</span>
            <span class="legend-item"><span class="legend-dot" style="background:#22c55e"></span> 0-10 Stable</span>
            <span class="legend-item"><span class="legend-dot" style="background:#eab308"></span> 11-25 Shaky</span>
            <span class="legend-item"><span class="legend-dot" style="background:#f97316"></span> 26-40 Flaky</span>
            <span class="legend-item"><span class="legend-dot" style="background:#ef4444"></span> 41-60 Broken</span>
            <span class="legend-item"><span class="legend-dot" style="background:#7f1d1d"></span> 61+ Toxic</span>
            <span style="margin-left:12px;font-weight:600;color:#334155;">Confidence:</span>
            <span class="legend-item">Low (2-3 runs)</span>
            <span class="legend-item">Med (4-7)</span>
            <span class="legend-item">High (8-15)</span>
            <span class="legend-item">V.High (16+)</span>
        </div>`;

    // Table rows
    let tableRows = '';
    for (const t of tests) {
        const isNew = t.score === -1;
        const health = t.health || getHealthConfig(isNew ? 0 : t.score);
        const trend = t.trend || { arrow: '—', label: '', color: '#94a3b8' };
        const confidence = t.confidence || { level: 'None', color: '#94a3b8', percent: 0 };
        const barScore = isNew ? 0 : Math.min(t.score, 100);
        const barColor = isNew ? '#93c5fd' : health.color;
        const scoreDisplay = isNew ? '—' : t.score;
        const passRateDisplay = isNew ? '—' : `${(t.passRate ?? 0).toFixed(0)}%`;

        // Run history dots
        const dots = (t.runHistory || []).map((r: string) =>
            `<span class="run-dot ${r === '✓' ? 'pass' : 'fail'}">${r}</span>`
        ).join('');

        // Build detail rows
        let detailsHTML = '';
        if (!isNew) {
            const parts: string[] = [];

            // Failure category
            if (t.failureCategory && t.failureCategory.category !== 'None') {
                parts.push(`<div class="detail-row"><span class="detail-icon">${t.failureCategory.icon}</span><strong>Failure type:</strong> ${htmlEscape(t.failureCategory.category)}</div>`);
            }

            // Duration insight
            if (t.durationInsight) {
                parts.push(`<div class="detail-row">${htmlEscape(t.durationInsight)}</div>`);
            }

            // Last error
            if (t.lastError) {
                parts.push(`<div class="error-snippet">${htmlEscape(t.lastError)}</div>`);
            }

            // Fix suggestion (only for score > 10)
            if (t.score > 10 && t.failureCategory && t.failureCategory.fixSuggestion) {
                parts.push(`<div class="fix-suggestion">💡 ${htmlEscape(t.failureCategory.fixSuggestion)}</div>`);
            }

            if (parts.length > 0) {
                detailsHTML = `<div class="test-details">${parts.join('')}</div>`;
            }
        }

        tableRows += `
            <tr class="${isNew ? 'health-new-row' : ''}">
                <td>
                    <div>${htmlEscape(t.testName || '')}</div>
                    ${detailsHTML}
                </td>
                <td>
                    <span class="health-badge" style="background:${health.bgColor};color:${health.color}">
                        ${health.icon} ${health.label}
                    </span>
                </td>
                <td>
                    <div class="score-bar-container">
                        <span class="score-value" style="color:${barColor}">${scoreDisplay}</span>
                        <div class="score-bar"><div class="score-bar-fill" style="width:${barScore}%;background:${barColor}"></div></div>
                    </div>
                </td>
                <td>${passRateDisplay}${!isNew && t.totalRuns ? ` <span style="font-size:0.68rem;color:#94a3b8">(${t.totalRuns})</span>` : ''}</td>
                <td><div class="run-history">${dots || '<span style="color:#94a3b8;font-size:0.7rem">—</span>'}</div></td>
                <td><span class="trend-badge" style="color:${trend.color}">${trend.arrow} ${trend.label}</span></td>
                <td>
                    <div class="confidence-bar">
                        <div class="confidence-track"><div class="confidence-fill" style="width:${confidence.percent}%;background:${confidence.color}"></div></div>
                        <span class="confidence-label" style="color:${confidence.color}">${confidence.level}</span>
                    </div>
                </td>
            </tr>`;
    }

    return `
            <div id="stability-view" class="view">
                <div class="stability-section">
                    <h3>🛡️ Test Stability Analysis</h3>
                    <div class="stability-subtitle">
                        Showing <strong>${flakyData.totalTests}</strong> test(s) from this run
                        ${flakyData.testsWithHistory > 0 ? ` · <strong>${flakyData.testsWithHistory}</strong> with cross-run history` : ''}
                        ${flakyData.newTests > 0 ? ` · <strong>${flakyData.newTests}</strong> first-time` : ''}
                        ${flakyData.averageFlakinessScore > 0 ? ` · Avg score: <strong>${flakyData.averageFlakinessScore}</strong>` : ''}
                    </div>

                    ${summaryHTML}
                    ${failureCatsHTML}
                    ${legendHTML}

                    <table class="flaky-table">
                        <thead>
                            <tr>
                                <th style="min-width:200px">Test</th>
                                <th>Health</th>
                                <th>Score</th>
                                <th>Pass Rate</th>
                                <th>History</th>
                                <th>Trend</th>
                                <th>Confidence</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${tableRows}
                        </tbody>
                    </table>
                </div>
            </div>`;
}
