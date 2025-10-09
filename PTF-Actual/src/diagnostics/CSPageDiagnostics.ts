/**
 * CS Page Diagnostics - Playwright 1.56+ Enhanced Debugging
 *
 * Collects diagnostic data using Playwright's new debugging APIs:
 * - page.consoleMessages() - Recent console logs
 * - page.pageErrors() - Uncaught JavaScript errors
 * - page.requests() - Recent network requests
 *
 * @since Playwright 1.56.0
 * @version 3.1.0
 */

import { Page, ConsoleMessage, Request } from '@playwright/test';
import { CSReporter } from '../reporter/CSReporter';

/**
 * Console log entry for reporting
 */
export interface DiagnosticConsoleLog {
    type: string;  // 'log', 'error', 'warning', 'info', 'debug'
    text: string;
    location?: {
        url: string;
        line: number;
        column: number;
    };
    timestamp: string;
}

/**
 * Page error entry for reporting
 */
export interface DiagnosticError {
    name: string;
    message: string;
    stack?: string;
    timestamp: string;
}

/**
 * Network request entry for reporting
 */
export interface DiagnosticRequest {
    method: string;
    url: string;
    status?: number;
    statusText?: string;
    resourceType: string;
    duration?: number;
    size?: number;
    headers?: Record<string, string>;
}

/**
 * Complete diagnostic data collected from a page
 */
export interface PageDiagnosticData {
    consoleLogs: DiagnosticConsoleLog[];
    pageErrors: DiagnosticError[];
    networkRequests: DiagnosticRequest[];
    collectionTimestamp: string;
    stats: {
        totalLogs: number;
        errorLogs: number;
        warningLogs: number;
        totalErrors: number;
        totalRequests: number;
        failedRequests: number;
    };
}

/**
 * Diagnostic collection options
 */
export interface DiagnosticOptions {
    /** Maximum number of console logs to collect (default: 50) */
    maxLogs?: number;
    /** Maximum number of errors to collect (default: 10) */
    maxErrors?: number;
    /** Maximum number of network requests to collect (default: 20) */
    maxRequests?: number;
    /** Include request headers (default: false, can be verbose) */
    includeRequestHeaders?: boolean;
    /** Filter console logs by type (default: all types) */
    logTypes?: string[];
    /** Filter requests by resource type (default: all types) */
    resourceTypes?: string[];
}

/**
 * CS Page Diagnostics Collector
 *
 * Safely collects diagnostic data from Playwright pages using Playwright 1.56+ APIs.
 * Handles errors gracefully and provides fallback for older Playwright versions.
 */
export class CSPageDiagnostics {
    private static readonly DEFAULT_OPTIONS: Required<DiagnosticOptions> = {
        maxLogs: 50,
        maxErrors: 10,
        maxRequests: 20,
        includeRequestHeaders: false,
        logTypes: ['log', 'error', 'warning', 'info', 'debug'],
        resourceTypes: ['xhr', 'fetch', 'document', 'script', 'stylesheet']
    };

    /**
     * Check if Playwright 1.56+ diagnostic APIs are available
     */
    public static isAvailable(page: Page): boolean {
        return typeof (page as any).consoleMessages === 'function' &&
               typeof (page as any).pageErrors === 'function' &&
               typeof (page as any).requests === 'function';
    }

    /**
     * Collect complete diagnostic data from a page
     *
     * @param page - Playwright Page instance
     * @param options - Collection options
     * @returns Diagnostic data or null if collection fails
     */
    public static async collect(
        page: Page,
        options: DiagnosticOptions = {}
    ): Promise<PageDiagnosticData | null> {
        // Validate page is available
        if (!page || page.isClosed()) {
            CSReporter.debug('Cannot collect diagnostics: Page is closed');
            return null;
        }

        // Check API availability
        if (!this.isAvailable(page)) {
            CSReporter.debug('Playwright 1.56+ diagnostic APIs not available');
            return null;
        }

        const opts = { ...this.DEFAULT_OPTIONS, ...options };
        const timestamp = new Date().toISOString();

        try {
            // Collect all diagnostic data in parallel
            const [consoleLogs, pageErrors, requests] = await Promise.all([
                this.collectConsoleLogs(page, opts),
                this.collectPageErrors(page, opts),
                this.collectNetworkRequests(page, opts)
            ]);

            // Calculate statistics
            const stats = {
                totalLogs: consoleLogs.length,
                errorLogs: consoleLogs.filter(log => log.type === 'error').length,
                warningLogs: consoleLogs.filter(log => log.type === 'warning').length,
                totalErrors: pageErrors.length,
                totalRequests: requests.length,
                failedRequests: requests.filter(req => req.status && req.status >= 400).length
            };

            CSReporter.debug(`Diagnostics collected: ${stats.totalLogs} logs, ${stats.totalErrors} errors, ${stats.totalRequests} requests`);

            return {
                consoleLogs,
                pageErrors,
                networkRequests: requests,
                collectionTimestamp: timestamp,
                stats
            };
        } catch (error: any) {
            CSReporter.warn(`Failed to collect page diagnostics: ${error.message}`);
            return null;
        }
    }

    /**
     * Collect console logs from page
     */
    private static async collectConsoleLogs(
        page: Page,
        options: Required<DiagnosticOptions>
    ): Promise<DiagnosticConsoleLog[]> {
        try {
            // IMPORTANT: Access messages immediately before they're garbage collected
            const messages: ConsoleMessage[] = await (page as any).consoleMessages();

            const logs: DiagnosticConsoleLog[] = [];
            const timestamp = new Date().toISOString();

            for (const msg of messages.slice(-options.maxLogs)) {
                const msgType = msg.type();

                // Filter by type if specified
                if (options.logTypes.length > 0 && !options.logTypes.includes(msgType)) {
                    continue;
                }

                const log: DiagnosticConsoleLog = {
                    type: msgType,
                    text: msg.text(),
                    timestamp
                };

                // Add location if available
                try {
                    const location = msg.location();
                    if (location && location.url) {
                        log.location = {
                            url: location.url,
                            line: location.lineNumber || 0,
                            column: location.columnNumber || 0
                        };
                    }
                } catch (e) {
                    // Location not available, skip
                }

                logs.push(log);
            }

            return logs;
        } catch (error: any) {
            CSReporter.warn(`Failed to collect console logs: ${error.message}`);
            return [];
        }
    }

    /**
     * Collect page errors
     */
    private static async collectPageErrors(
        page: Page,
        options: Required<DiagnosticOptions>
    ): Promise<DiagnosticError[]> {
        try {
            // IMPORTANT: Access errors immediately before they're garbage collected
            const errors: Error[] = await (page as any).pageErrors();

            const diagnosticErrors: DiagnosticError[] = [];
            const timestamp = new Date().toISOString();

            for (const error of errors.slice(-options.maxErrors)) {
                diagnosticErrors.push({
                    name: error.name || 'Error',
                    message: error.message || String(error),
                    stack: error.stack,
                    timestamp
                });
            }

            return diagnosticErrors;
        } catch (error: any) {
            CSReporter.warn(`Failed to collect page errors: ${error.message}`);
            return [];
        }
    }

    /**
     * Collect network requests
     */
    private static async collectNetworkRequests(
        page: Page,
        options: Required<DiagnosticOptions>
    ): Promise<DiagnosticRequest[]> {
        try {
            // IMPORTANT: Access requests immediately before they're garbage collected
            const requests: Request[] = await (page as any).requests();

            const diagnosticRequests: DiagnosticRequest[] = [];

            for (const req of requests.slice(-options.maxRequests)) {
                try {
                    const resourceType = req.resourceType();

                    // Filter by resource type if specified
                    if (options.resourceTypes.length > 0 &&
                        !options.resourceTypes.includes(resourceType)) {
                        continue;
                    }

                    const diagnosticReq: DiagnosticRequest = {
                        method: req.method(),
                        url: req.url(),
                        resourceType
                    };

                    // Get response information if available
                    try {
                        const response = await req.response();
                        if (response) {
                            diagnosticReq.status = response.status();
                            diagnosticReq.statusText = response.statusText();
                        }
                    } catch (e) {
                        // Response not available
                    }

                    // Get timing information if available
                    try {
                        const timing = req.timing();
                        if (timing && timing.responseEnd && timing.requestStart) {
                            diagnosticReq.duration = timing.responseEnd - timing.requestStart;
                        }
                    } catch (e) {
                        // Timing not available
                    }

                    // Get size information if available
                    try {
                        const sizes = await req.sizes();
                        if (sizes && sizes.responseBodySize) {
                            diagnosticReq.size = sizes.responseBodySize;
                        }
                    } catch (e) {
                        // Size not available
                    }

                    // Include headers if requested
                    if (options.includeRequestHeaders) {
                        try {
                            diagnosticReq.headers = await req.allHeaders();
                        } catch (e) {
                            // Headers not available
                        }
                    }

                    diagnosticRequests.push(diagnosticReq);
                } catch (error) {
                    // Skip requests that can't be processed (may be collected)
                    continue;
                }
            }

            return diagnosticRequests;
        } catch (error: any) {
            CSReporter.warn(`Failed to collect network requests: ${error.message}`);
            return [];
        }
    }

    /**
     * Collect diagnostics on step failure
     * Optimized for failure scenarios - focuses on errors and failed requests
     */
    public static async collectOnFailure(page: Page): Promise<PageDiagnosticData | null> {
        return this.collect(page, {
            maxLogs: 30,  // Fewer logs, focus on errors
            maxErrors: 10,  // All recent errors
            maxRequests: 15,  // Recent requests only
            includeRequestHeaders: false,  // Keep data size manageable
            logTypes: ['error', 'warning'],  // Only errors and warnings
            resourceTypes: ['xhr', 'fetch', 'document']  // API calls and page loads
        });
    }

    /**
     * Collect comprehensive diagnostics for detailed analysis
     */
    public static async collectComprehensive(page: Page): Promise<PageDiagnosticData | null> {
        return this.collect(page, {
            maxLogs: 100,
            maxErrors: 20,
            maxRequests: 50,
            includeRequestHeaders: true,
            logTypes: [],  // All types
            resourceTypes: []  // All types
        });
    }

    /**
     * Format diagnostic data for console output (debugging)
     */
    public static formatForConsole(data: PageDiagnosticData): string {
        const lines: string[] = [
            '=== PAGE DIAGNOSTICS ===',
            `Collected at: ${data.collectionTimestamp}`,
            '',
            `📊 Statistics:`,
            `  Console Logs: ${data.stats.totalLogs} (${data.stats.errorLogs} errors, ${data.stats.warningLogs} warnings)`,
            `  Page Errors: ${data.stats.totalErrors}`,
            `  Network Requests: ${data.stats.totalRequests} (${data.stats.failedRequests} failed)`,
            ''
        ];

        if (data.pageErrors.length > 0) {
            lines.push('❌ Page Errors:');
            data.pageErrors.forEach((err, i) => {
                lines.push(`  ${i + 1}. ${err.name}: ${err.message}`);
            });
            lines.push('');
        }

        if (data.stats.errorLogs > 0) {
            lines.push('🔴 Console Errors:');
            data.consoleLogs.filter(log => log.type === 'error').forEach((log, i) => {
                lines.push(`  ${i + 1}. ${log.text}`);
            });
            lines.push('');
        }

        if (data.stats.failedRequests > 0) {
            lines.push('🌐 Failed Requests:');
            data.networkRequests.filter(req => req.status && req.status >= 400).forEach((req, i) => {
                lines.push(`  ${i + 1}. [${req.status}] ${req.method} ${req.url}`);
            });
            lines.push('');
        }

        lines.push('========================');
        return lines.join('\n');
    }
}
