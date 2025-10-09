/**
 * AI Report Aggregator - Collects and aggregates AI data from test results
 * Generates comprehensive AI statistics for HTML reporting
 */

import { TestResult, StepResult, StepAIData } from './CSReporter';
import { CSReporter } from './CSReporter';

export interface AIReportSummary {
    totalOperations: number;
    healingStats: {
        totalAttempts: number;
        successfulHealings: number;
        failedHealings: number;
        successRate: number;
        averageConfidence: number;
        averageDuration: number;
        totalTimeSaved: number;
        byStrategy: Record<string, {
            attempts: number;
            successes: number;
            failures: number;
            successRate: number;
            averageConfidence: number;
        }>;
    };
    identificationStats: {
        totalIdentifications: number;
        averageConfidence: number;
        averageDuration: number;
        byMethod: Record<string, {
            count: number;
            averageConfidence: number;
        }>;
    };
    predictionStats: {
        totalPredictions: number;
        preventedFailures: number;
        averageFragilityScore: number;
        averageConfidence: number;
    };
    // NEW: Failure analysis stats (v3.3.0+)
    failureAnalysisStats: {
        totalAnalyses: number;
        byFailureType: Record<string, {
            count: number;
            healable: number;
            notHealable: number;
        }>;
        retriesSkipped: number;
        retriesAllowed: number;
        averageConfidence: number;
    };
    // NEW: Advanced context stats (v3.3.0+)
    advancedContextStats: {
        shadowDOMUsed: number;
        frameworksDetected: Record<string, number>;
        componentLibrariesDetected: Record<string, number>;
        tableInteractions: number;
        iframeInteractions: number;
    };
    fragileElements: Array<{
        step: string;
        scenario: string;
        fragilityScore: number;
        healCount: number;
    }>;
    timeline: Array<{
        timestamp: string;
        scenario: string;
        step: string;
        operation: 'healing' | 'identification' | 'prediction' | 'failureAnalysis' | 'retry';
        success: boolean;
        details: string;
    }>;
}

export class CSAIReportAggregator {
    private static instance: CSAIReportAggregator;

    private constructor() {}

    public static getInstance(): CSAIReportAggregator {
        if (!CSAIReportAggregator.instance) {
            CSAIReportAggregator.instance = new CSAIReportAggregator();
        }
        return CSAIReportAggregator.instance;
    }

    /**
     * Aggregate AI data from all test results
     */
    public aggregateAIData(testResults: TestResult[]): AIReportSummary {
        CSReporter.debug('[AIReportAggregator] Aggregating AI data from test results');

        const summary: AIReportSummary = {
            totalOperations: 0,
            healingStats: {
                totalAttempts: 0,
                successfulHealings: 0,
                failedHealings: 0,
                successRate: 0,
                averageConfidence: 0,
                averageDuration: 0,
                totalTimeSaved: 0,
                byStrategy: {}
            },
            identificationStats: {
                totalIdentifications: 0,
                averageConfidence: 0,
                averageDuration: 0,
                byMethod: {}
            },
            predictionStats: {
                totalPredictions: 0,
                preventedFailures: 0,
                averageFragilityScore: 0,
                averageConfidence: 0
            },
            failureAnalysisStats: {
                totalAnalyses: 0,
                byFailureType: {},
                retriesSkipped: 0,
                retriesAllowed: 0,
                averageConfidence: 0
            },
            advancedContextStats: {
                shadowDOMUsed: 0,
                frameworksDetected: {},
                componentLibrariesDetected: {},
                tableInteractions: 0,
                iframeInteractions: 0
            },
            fragileElements: [],
            timeline: []
        };

        let totalHealingConfidence = 0;
        let totalHealingDuration = 0;
        let totalIdentificationConfidence = 0;
        let totalIdentificationDuration = 0;
        let totalPredictionConfidence = 0;
        let totalFragilityScore = 0;

        const fragileElementsMap = new Map<string, {
            step: string;
            scenario: string;
            fragilityScore: number;
            healCount: number;
        }>();

        // Process each test result
        testResults.forEach(test => {
            test.steps.forEach(step => {
                if (!step.aiData) return;

                const aiData = step.aiData;

                // Process healing data
                if (aiData.healing) {
                    summary.totalOperations++;
                    summary.healingStats.totalAttempts++;

                    if (aiData.healing.success) {
                        summary.healingStats.successfulHealings++;
                    } else {
                        summary.healingStats.failedHealings++;
                    }

                    totalHealingConfidence += aiData.healing.confidence;
                    totalHealingDuration += aiData.healing.duration;

                    // Estimate time saved (assume 5 minutes manual debug time per successful healing)
                    if (aiData.healing.success) {
                        summary.healingStats.totalTimeSaved += 300000; // 5 minutes in ms
                    }

                    // Track by strategy
                    const strategy = aiData.healing.strategy;
                    if (!summary.healingStats.byStrategy[strategy]) {
                        summary.healingStats.byStrategy[strategy] = {
                            attempts: 0,
                            successes: 0,
                            failures: 0,
                            successRate: 0,
                            averageConfidence: 0
                        };
                    }

                    summary.healingStats.byStrategy[strategy].attempts++;
                    if (aiData.healing.success) {
                        summary.healingStats.byStrategy[strategy].successes++;
                    } else {
                        summary.healingStats.byStrategy[strategy].failures++;
                    }
                    summary.healingStats.byStrategy[strategy].averageConfidence += aiData.healing.confidence;

                    // Add to timeline
                    summary.timeline.push({
                        timestamp: step.timestamp,
                        scenario: test.name,
                        step: step.name,
                        operation: 'healing',
                        success: aiData.healing.success,
                        details: `${aiData.healing.strategy} (${(aiData.healing.confidence * 100).toFixed(1)}%)`
                    });

                    // Track fragile elements
                    const elementKey = `${test.name}::${step.name}`;
                    if (!fragileElementsMap.has(elementKey)) {
                        fragileElementsMap.set(elementKey, {
                            step: step.name,
                            scenario: test.name,
                            fragilityScore: 0,
                            healCount: 0
                        });
                    }
                    const fragileElement = fragileElementsMap.get(elementKey)!;
                    fragileElement.healCount++;
                }

                // Process identification data
                if (aiData.identification) {
                    summary.totalOperations++;
                    summary.identificationStats.totalIdentifications++;
                    totalIdentificationConfidence += aiData.identification.confidence;
                    totalIdentificationDuration += aiData.identification.duration;

                    // Track by method
                    const method = aiData.identification.method;
                    if (!summary.identificationStats.byMethod[method]) {
                        summary.identificationStats.byMethod[method] = {
                            count: 0,
                            averageConfidence: 0
                        };
                    }

                    summary.identificationStats.byMethod[method].count++;
                    summary.identificationStats.byMethod[method].averageConfidence += aiData.identification.confidence;

                    // Add to timeline
                    summary.timeline.push({
                        timestamp: step.timestamp,
                        scenario: test.name,
                        step: step.name,
                        operation: 'identification',
                        success: true,
                        details: `${aiData.identification.method} (${(aiData.identification.confidence * 100).toFixed(1)}%)`
                    });
                }

                // Process prediction data
                if (aiData.prediction) {
                    summary.totalOperations++;
                    summary.predictionStats.totalPredictions++;
                    totalPredictionConfidence += aiData.prediction.confidence;
                    totalFragilityScore += aiData.prediction.fragilityScore;

                    if (aiData.prediction.prevented) {
                        summary.predictionStats.preventedFailures++;
                    }

                    // Add to timeline
                    summary.timeline.push({
                        timestamp: step.timestamp,
                        scenario: test.name,
                        step: step.name,
                        operation: 'prediction',
                        success: aiData.prediction.prevented,
                        details: `Fragility: ${(aiData.prediction.fragilityScore * 100).toFixed(1)}%`
                    });

                    // Update fragile element score
                    const elementKey = `${test.name}::${step.name}`;
                    if (fragileElementsMap.has(elementKey)) {
                        fragileElementsMap.get(elementKey)!.fragilityScore = Math.max(
                            fragileElementsMap.get(elementKey)!.fragilityScore,
                            aiData.prediction.fragilityScore
                        );
                    }
                }

                // Process failure analysis data (v3.3.0+)
                if (aiData.failureAnalysis) {
                    summary.totalOperations++;
                    summary.failureAnalysisStats.totalAnalyses++;

                    const failureType = aiData.failureAnalysis.failureType;
                    if (!summary.failureAnalysisStats.byFailureType[failureType]) {
                        summary.failureAnalysisStats.byFailureType[failureType] = {
                            count: 0,
                            healable: 0,
                            notHealable: 0
                        };
                    }
                    summary.failureAnalysisStats.byFailureType[failureType].count++;
                    if (aiData.failureAnalysis.healable) {
                        summary.failureAnalysisStats.byFailureType[failureType].healable++;
                    } else {
                        summary.failureAnalysisStats.byFailureType[failureType].notHealable++;
                    }

                    // Add to timeline
                    summary.timeline.push({
                        timestamp: step.timestamp,
                        scenario: test.name,
                        step: step.name,
                        operation: 'failureAnalysis',
                        success: aiData.failureAnalysis.healable,
                        details: `${failureType} (${aiData.failureAnalysis.healable ? 'Healable' : 'Not Healable'})`
                    });
                }

                // Process retry decision data (v3.3.0+)
                if (aiData.retryDecision) {
                    if (aiData.retryDecision.shouldRetry) {
                        summary.failureAnalysisStats.retriesAllowed++;
                    } else {
                        summary.failureAnalysisStats.retriesSkipped++;
                    }

                    // Add to timeline
                    summary.timeline.push({
                        timestamp: step.timestamp,
                        scenario: test.name,
                        step: step.name,
                        operation: 'retry',
                        success: aiData.retryDecision.shouldRetry,
                        details: `${aiData.retryDecision.reason}`
                    });
                }

                // Process advanced context data (v3.3.0+)
                if (aiData.advancedContext) {
                    summary.totalOperations++;  // Count advanced context as an AI operation

                    if (aiData.advancedContext.shadowDOM) {
                        summary.advancedContextStats.shadowDOMUsed++;
                    }
                    if (aiData.advancedContext.framework) {
                        const fw = aiData.advancedContext.framework;
                        summary.advancedContextStats.frameworksDetected[fw] =
                            (summary.advancedContextStats.frameworksDetected[fw] || 0) + 1;
                    }
                    if (aiData.advancedContext.componentLibrary) {
                        const lib = aiData.advancedContext.componentLibrary;
                        summary.advancedContextStats.componentLibrariesDetected[lib] =
                            (summary.advancedContextStats.componentLibrariesDetected[lib] || 0) + 1;
                    }
                    if (aiData.advancedContext.inTable) {
                        summary.advancedContextStats.tableInteractions++;
                    }
                    if (aiData.advancedContext.inIframe) {
                        summary.advancedContextStats.iframeInteractions++;
                    }
                }
            });
        });

        // Calculate averages and rates
        if (summary.healingStats.totalAttempts > 0) {
            summary.healingStats.successRate = summary.healingStats.successfulHealings / summary.healingStats.totalAttempts;
            summary.healingStats.averageConfidence = totalHealingConfidence / summary.healingStats.totalAttempts;
            summary.healingStats.averageDuration = totalHealingDuration / summary.healingStats.totalAttempts;

            // Calculate strategy statistics
            Object.keys(summary.healingStats.byStrategy).forEach(strategy => {
                const stratStats = summary.healingStats.byStrategy[strategy];
                stratStats.successRate = stratStats.attempts > 0 ? stratStats.successes / stratStats.attempts : 0;
                stratStats.averageConfidence = stratStats.attempts > 0 ? stratStats.averageConfidence / stratStats.attempts : 0;
            });
        }

        if (summary.identificationStats.totalIdentifications > 0) {
            summary.identificationStats.averageConfidence = totalIdentificationConfidence / summary.identificationStats.totalIdentifications;
            summary.identificationStats.averageDuration = totalIdentificationDuration / summary.identificationStats.totalIdentifications;

            // Calculate method statistics
            Object.keys(summary.identificationStats.byMethod).forEach(method => {
                const methodStats = summary.identificationStats.byMethod[method];
                methodStats.averageConfidence = methodStats.count > 0 ? methodStats.averageConfidence / methodStats.count : 0;
            });
        }

        if (summary.predictionStats.totalPredictions > 0) {
            summary.predictionStats.averageConfidence = totalPredictionConfidence / summary.predictionStats.totalPredictions;
            summary.predictionStats.averageFragilityScore = totalFragilityScore / summary.predictionStats.totalPredictions;
        }

        // Convert fragile elements map to array and sort by heal count
        summary.fragileElements = Array.from(fragileElementsMap.values())
            .sort((a, b) => b.healCount - a.healCount)
            .slice(0, 20); // Top 20 fragile elements

        // Sort timeline by timestamp (newest first)
        summary.timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        CSReporter.debug(`[AIReportAggregator] Aggregation complete: ${summary.totalOperations} total AI operations`);

        return summary;
    }

    /**
     * Generate AI statistics HTML content
     */
    public generateAIStatsHTML(summary: AIReportSummary): string {
        const timeSavedMinutes = Math.round(summary.healingStats.totalTimeSaved / 60000);
        const timeSavedHours = Math.floor(timeSavedMinutes / 60);
        const timeSavedRemainingMinutes = timeSavedMinutes % 60;
        const timeSavedDisplay = timeSavedHours > 0
            ? `${timeSavedHours}h ${timeSavedRemainingMinutes}m`
            : `${timeSavedMinutes}m`;

        return `
            <div class="ai-stats-container">
                <h2>🤖 AI Operations Summary</h2>

                <div class="ai-stats-grid">
                    <!-- Overall Stats -->
                    <div class="ai-stat-card">
                        <div class="ai-stat-value">${summary.totalOperations}</div>
                        <div class="ai-stat-label">Total AI Operations</div>
                    </div>

                    <!-- Healing Stats -->
                    <div class="ai-stat-card ${summary.healingStats.successRate > 0.7 ? 'success' : 'warning'}">
                        <div class="ai-stat-value">${(summary.healingStats.successRate * 100).toFixed(1)}%</div>
                        <div class="ai-stat-label">Healing Success Rate</div>
                        <div class="ai-stat-detail">${summary.healingStats.successfulHealings}/${summary.healingStats.totalAttempts} successful</div>
                    </div>

                    <div class="ai-stat-card success">
                        <div class="ai-stat-value">${timeSavedDisplay}</div>
                        <div class="ai-stat-label">Time Saved</div>
                        <div class="ai-stat-detail">Estimated debug time saved</div>
                    </div>

                    <div class="ai-stat-card">
                        <div class="ai-stat-value">${(summary.healingStats.averageConfidence * 100).toFixed(1)}%</div>
                        <div class="ai-stat-label">Avg Healing Confidence</div>
                    </div>

                    <!-- Identification Stats -->
                    <div class="ai-stat-card">
                        <div class="ai-stat-value">${summary.identificationStats.totalIdentifications}</div>
                        <div class="ai-stat-label">AI Identifications</div>
                        <div class="ai-stat-detail">${(summary.identificationStats.averageConfidence * 100).toFixed(1)}% avg confidence</div>
                    </div>

                    <!-- Prediction Stats -->
                    <div class="ai-stat-card ${summary.predictionStats.preventedFailures > 0 ? 'success' : ''}">
                        <div class="ai-stat-value">${summary.predictionStats.preventedFailures}</div>
                        <div class="ai-stat-label">Failures Prevented</div>
                        <div class="ai-stat-detail">${summary.predictionStats.totalPredictions} predictions made</div>
                    </div>
                </div>

                ${this.generateStrategyBreakdownHTML(summary.healingStats.byStrategy)}
                ${this.generateFailureAnalysisHTML(summary.failureAnalysisStats)}
                ${this.generateAdvancedContextHTML(summary.advancedContextStats)}
                ${this.generateFragileElementsHTML(summary.fragileElements)}
                ${this.generateTimelineHTML(summary.timeline.slice(0, 10))}
            </div>
        `;
    }

    /**
     * Generate strategy breakdown HTML
     */
    private generateStrategyBreakdownHTML(byStrategy: AIReportSummary['healingStats']['byStrategy']): string {
        if (Object.keys(byStrategy).length === 0) {
            return '';
        }

        const strategies = Object.entries(byStrategy)
            .sort((a, b) => b[1].successRate - a[1].successRate);

        const rows = strategies.map(([strategy, stats]) => `
            <tr>
                <td>${strategy}</td>
                <td>${stats.attempts}</td>
                <td>${stats.successes}</td>
                <td>${(stats.successRate * 100).toFixed(1)}%</td>
                <td>${(stats.averageConfidence * 100).toFixed(1)}%</td>
            </tr>
        `).join('');

        return `
            <div class="ai-section">
                <h3>🎯 Healing Strategy Effectiveness</h3>
                <table class="ai-strategy-table">
                    <thead>
                        <tr>
                            <th>Strategy</th>
                            <th>Attempts</th>
                            <th>Successes</th>
                            <th>Success Rate</th>
                            <th>Avg Confidence</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
        `;
    }

    /**
     * Generate failure analysis HTML (v3.3.0+)
     */
    private generateFailureAnalysisHTML(stats: AIReportSummary['failureAnalysisStats']): string {
        if (stats.totalAnalyses === 0) {
            return '';
        }

        const failures = Object.entries(stats.byFailureType)
            .sort((a, b) => b[1].count - a[1].count);

        const rows = failures.map(([type, data]) => `
            <tr>
                <td>${type}</td>
                <td>${data.count}</td>
                <td style="color: #10b981; font-weight: 600;">${data.healable}</td>
                <td style="color: #ef4444; font-weight: 600;">${data.notHealable}</td>
                <td>${data.count > 0 ? ((data.healable / data.count) * 100).toFixed(1) : 0}%</td>
            </tr>
        `).join('');

        return `
            <div class="ai-section">
                <h3>🔍 Intelligent Retry Analysis</h3>
                <div style="margin-bottom: 15px; padding: 10px; background: #f0fdf4; border-left: 4px solid #10b981; border-radius: 6px;">
                    <div style="font-size: 13px; color: #065f46;">
                        <strong>Smart Retry Decisions:</strong> ${stats.retriesAllowed} retries allowed • ${stats.retriesSkipped} retries skipped (saved time!)
                    </div>
                </div>
                <table class="ai-strategy-table">
                    <thead>
                        <tr>
                            <th>Failure Type</th>
                            <th>Total</th>
                            <th>Healable</th>
                            <th>Not Healable</th>
                            <th>Healability Rate</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
        `;
    }

    /**
     * Generate advanced context HTML (v3.3.0+)
     */
    private generateAdvancedContextHTML(stats: AIReportSummary['advancedContextStats']): string {
        const hasData = stats.shadowDOMUsed > 0 ||
                       Object.keys(stats.frameworksDetected).length > 0 ||
                       Object.keys(stats.componentLibrariesDetected).length > 0 ||
                       stats.tableInteractions > 0 ||
                       stats.iframeInteractions > 0;

        if (!hasData) {
            return '';
        }

        return `
            <div class="ai-section">
                <h3>🚀 Advanced Context Detection</h3>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px;">
                    ${stats.shadowDOMUsed > 0 ? `
                        <div style="padding: 12px; background: #ede9fe; border-radius: 8px; border-left: 4px solid #7c3aed;">
                            <div style="font-size: 24px; font-weight: 700; color: #5b21b6;">${stats.shadowDOMUsed}</div>
                            <div style="font-size: 12px; color: #6d28d9; margin-top: 4px;">Shadow DOM Elements</div>
                        </div>
                    ` : ''}
                    ${stats.tableInteractions > 0 ? `
                        <div style="padding: 12px; background: #fef3c7; border-radius: 8px; border-left: 4px solid #f59e0b;">
                            <div style="font-size: 24px; font-weight: 700; color: #92400e;">${stats.tableInteractions}</div>
                            <div style="font-size: 12px; color: #78350f; margin-top: 4px;">Table Interactions</div>
                        </div>
                    ` : ''}
                    ${stats.iframeInteractions > 0 ? `
                        <div style="padding: 12px; background: #dbeafe; border-radius: 8px; border-left: 4px solid #3b82f6;">
                            <div style="font-size: 24px; font-weight: 700; color: #1e40af;">${stats.iframeInteractions}</div>
                            <div style="font-size: 12px; color: #1e3a8a; margin-top: 4px;">iframe Interactions</div>
                        </div>
                    ` : ''}
                </div>
                ${Object.keys(stats.frameworksDetected).length > 0 ? `
                    <div style="margin-top: 15px;">
                        <strong style="font-size: 13px; color: #374151;">Frameworks Detected:</strong>
                        <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                            ${Object.entries(stats.frameworksDetected).map(([fw, count]) => `
                                <span style="padding: 4px 12px; background: #10b981; color: white; border-radius: 12px; font-size: 12px; font-weight: 600;">
                                    ${fw}: ${count}
                                </span>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
                ${Object.keys(stats.componentLibrariesDetected).length > 0 ? `
                    <div style="margin-top: 15px;">
                        <strong style="font-size: 13px; color: #374151;">Component Libraries:</strong>
                        <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                            ${Object.entries(stats.componentLibrariesDetected).map(([lib, count]) => `
                                <span style="padding: 4px 12px; background: #3b82f6; color: white; border-radius: 12px; font-size: 12px; font-weight: 600;">
                                    ${lib}: ${count}
                                </span>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    /**
     * Generate fragile elements HTML
     */
    private generateFragileElementsHTML(fragileElements: AIReportSummary['fragileElements']): string {
        if (fragileElements.length === 0) {
            return '';
        }

        const rows = fragileElements.map(element => {
            const riskClass = element.fragilityScore > 0.7 ? 'high-risk' :
                             element.fragilityScore > 0.4 ? 'medium-risk' : 'low-risk';

            return `
                <tr class="${riskClass}">
                    <td>${element.scenario}</td>
                    <td>${element.step}</td>
                    <td>${element.healCount}</td>
                    <td>${(element.fragilityScore * 100).toFixed(1)}%</td>
                </tr>
            `;
        }).join('');

        return `
            <div class="ai-section">
                <h3>⚠️ Fragile Elements</h3>
                <table class="ai-fragile-table">
                    <thead>
                        <tr>
                            <th>Scenario</th>
                            <th>Step</th>
                            <th>Heal Count</th>
                            <th>Fragility Score</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            </div>
        `;
    }

    /**
     * Generate timeline HTML
     */
    private generateTimelineHTML(timeline: AIReportSummary['timeline']): string {
        if (timeline.length === 0) {
            return '';
        }

        const items = timeline.map(item => {
            const icon = item.operation === 'healing' ? '🏥' :
                        item.operation === 'identification' ? '🔍' : '🔮';
            const statusClass = item.success ? 'success' : 'failed';

            return `
                <div class="timeline-item ${statusClass}">
                    <div class="timeline-icon">${icon}</div>
                    <div class="timeline-content">
                        <div class="timeline-header">
                            <strong>${item.scenario}</strong> - ${item.step}
                        </div>
                        <div class="timeline-details">
                            ${item.operation}: ${item.details}
                        </div>
                        <div class="timeline-time">${new Date(item.timestamp).toLocaleString()}</div>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div class="ai-section">
                <h3>📊 Recent AI Operations</h3>
                <div class="ai-timeline">
                    ${items}
                </div>
            </div>
        `;
    }

    /**
     * Generate step-level AI data HTML
     */
    public generateStepAIDataHTML(aiData: StepAIData): string {
        let html = '<div class="step-ai-data">';

        if (aiData.healing) {
            const statusIcon = aiData.healing.success ? '✅' : '❌';
            const statusClass = aiData.healing.success ? 'success' : 'failed';

            html += `
                <div class="ai-healing-info ${statusClass}">
                    <div class="ai-info-header">
                        ${statusIcon} <strong>AI Healing</strong>
                    </div>
                    <div class="ai-info-details">
                        <div>Strategy: <strong>${aiData.healing.strategy}</strong></div>
                        <div>Confidence: <strong>${(aiData.healing.confidence * 100).toFixed(1)}%</strong></div>
                        <div>Duration: <strong>${aiData.healing.duration}ms</strong></div>
                        <div>Attempts: <strong>${aiData.healing.attempts}</strong></div>
                        ${aiData.healing.originalLocator ? `<div>Original: <code>${aiData.healing.originalLocator}</code></div>` : ''}
                        ${aiData.healing.healedLocator ? `<div>Healed: <code>${aiData.healing.healedLocator}</code></div>` : ''}
                    </div>
                </div>
            `;
        }

        if (aiData.identification) {
            html += `
                <div class="ai-identification-info">
                    <div class="ai-info-header">
                        🔍 <strong>AI Identification</strong>
                    </div>
                    <div class="ai-info-details">
                        <div>Method: <strong>${aiData.identification.method}</strong></div>
                        <div>Confidence: <strong>${(aiData.identification.confidence * 100).toFixed(1)}%</strong></div>
                        <div>Alternatives: <strong>${aiData.identification.alternatives}</strong></div>
                        <div>Duration: <strong>${aiData.identification.duration}ms</strong></div>
                    </div>
                </div>
            `;
        }

        if (aiData.prediction) {
            const riskClass = aiData.prediction.fragilityScore > 0.7 ? 'high-risk' :
                             aiData.prediction.fragilityScore > 0.4 ? 'medium-risk' : 'low-risk';

            html += `
                <div class="ai-prediction-info ${riskClass}">
                    <div class="ai-info-header">
                        🔮 <strong>AI Prediction</strong>
                    </div>
                    <div class="ai-info-details">
                        <div>Predicted: <strong>${aiData.prediction.predicted ? 'Yes' : 'No'}</strong></div>
                        <div>Prevented: <strong>${aiData.prediction.prevented ? 'Yes' : 'No'}</strong></div>
                        <div>Confidence: <strong>${(aiData.prediction.confidence * 100).toFixed(1)}%</strong></div>
                        <div>Fragility: <strong>${(aiData.prediction.fragilityScore * 100).toFixed(1)}%</strong></div>
                    </div>
                </div>
            `;
        }

        // NEW: Failure Analysis (v3.3.0+)
        if (aiData.failureAnalysis) {
            const statusClass = aiData.failureAnalysis.healable ? 'healable' : 'not-healable';
            const statusIcon = aiData.failureAnalysis.healable ? '✅' : '⚠️';

            html += `
                <div class="ai-failure-analysis-info ${statusClass}">
                    <div class="ai-info-header">
                        ${statusIcon} <strong>Failure Analysis</strong>
                    </div>
                    <div class="ai-info-details">
                        <div>Type: <strong>${aiData.failureAnalysis.failureType}</strong></div>
                        <div>Healable: <strong>${aiData.failureAnalysis.healable ? 'Yes' : 'No'}</strong></div>
                        <div>Confidence: <strong>${(aiData.failureAnalysis.confidence * 100).toFixed(1)}%</strong></div>
                        <div>Root Cause: <em>${aiData.failureAnalysis.rootCause}</em></div>
                        ${aiData.failureAnalysis.suggestedStrategies && aiData.failureAnalysis.suggestedStrategies.length > 0 ? `
                            <div>Strategies: <strong>${aiData.failureAnalysis.suggestedStrategies.join(', ')}</strong></div>
                        ` : ''}
                        ${aiData.failureAnalysis.diagnosticInsights && aiData.failureAnalysis.diagnosticInsights.length > 0 ? `
                            <div style="margin-top: 8px;">
                                <strong>Insights:</strong>
                                <ul style="margin: 4px 0; padding-left: 20px;">
                                    ${aiData.failureAnalysis.diagnosticInsights.map(insight => `<li>${insight}</li>`).join('')}
                                </ul>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }

        // NEW: Advanced Context (v3.3.0+)
        if (aiData.advancedContext) {
            const hasContext = aiData.advancedContext.shadowDOM || aiData.advancedContext.framework ||
                              aiData.advancedContext.componentLibrary || aiData.advancedContext.inTable ||
                              aiData.advancedContext.inIframe || aiData.advancedContext.nearLoadingIndicator;

            if (hasContext) {
                html += `
                    <div class="ai-advanced-context-info">
                        <div class="ai-info-header">
                            🚀 <strong>Advanced Context</strong>
                        </div>
                        <div class="ai-info-details">
                            ${aiData.advancedContext.framework ? `<div>Framework: <strong>${aiData.advancedContext.framework}</strong></div>` : ''}
                            ${aiData.advancedContext.componentLibrary ? `<div>Library: <strong>${aiData.advancedContext.componentLibrary}</strong></div>` : ''}
                            ${aiData.advancedContext.shadowDOM ? `<div>Shadow DOM: <strong>Yes</strong> (Host: ${aiData.advancedContext.shadowRootHost || 'unknown'})</div>` : ''}
                            ${aiData.advancedContext.inTable ? `<div>Table: <strong>Yes</strong>${aiData.advancedContext.tableHeaders ? ` (Headers: ${aiData.advancedContext.tableHeaders.join(', ')})` : ''}</div>` : ''}
                            ${aiData.advancedContext.inIframe ? `<div>iframe: <strong>Yes</strong></div>` : ''}
                            ${aiData.advancedContext.nearLoadingIndicator ? `<div>⚠️ Near Loading Indicator: <strong>Yes</strong></div>` : ''}
                        </div>
                    </div>
                `;
            }
        }

        // NEW: Retry Decision (v3.3.0+)
        if (aiData.retryDecision) {
            const statusIcon = aiData.retryDecision.shouldRetry ? '🔄' : '⏭️';
            const statusClass = aiData.retryDecision.shouldRetry ? 'retry-allowed' : 'retry-skipped';

            html += `
                <div class="ai-retry-decision-info ${statusClass}">
                    <div class="ai-info-header">
                        ${statusIcon} <strong>Retry Decision</strong>
                    </div>
                    <div class="ai-info-details">
                        <div>Should Retry: <strong>${aiData.retryDecision.shouldRetry ? 'Yes' : 'No (Smart Skip!)'}</strong></div>
                        <div>Analysis Used: <strong>${aiData.retryDecision.analysisUsed ? 'Yes' : 'No'}</strong></div>
                        <div>Reason: <em>${aiData.retryDecision.reason}</em></div>
                    </div>
                </div>
            `;
        }

        html += '</div>';
        return html;
    }
}
