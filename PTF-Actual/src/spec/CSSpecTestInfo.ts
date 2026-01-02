/**
 * CS Playwright Test Framework - Spec Test Info Implementation
 * Provides test.info() API for accessing test metadata during execution
 */

import * as path from 'path';
import * as fs from 'fs';
import {
    SpecTestInfo,
    SpecAttachment,
    SpecTestStatus,
    SpecRuntimeTestState
} from './CSSpecTypes';
import { CSReporter } from '../reporter/CSReporter';

/**
 * Creates a SpecTestInfo implementation for a test
 */
export function createTestInfo(options: {
    title: string;
    titlePath: string[];
    file: string;
    line?: number;
    column?: number;
    retry: number;
    parallelIndex: number;
    project: string;
    timeout: number;
    outputDir: string;
    snapshotDir: string;
    runtimeState: SpecRuntimeTestState;
}): SpecTestInfo {
    const {
        title,
        titlePath,
        file,
        line,
        column,
        retry,
        parallelIndex,
        project,
        timeout: initialTimeout,
        outputDir,
        snapshotDir,
        runtimeState
    } = options;

    // Internal state
    let currentTimeout = initialTimeout;
    let currentStatus: SpecTestStatus = 'passed';
    let currentError: Error | undefined;
    const startTime = Date.now();

    const testInfo: SpecTestInfo = {
        // Read-only properties
        title,
        titlePath,
        file,
        line,
        column,
        retry,
        parallelIndex,
        project,
        outputDir,
        snapshotDir,

        // Dynamic properties (getters)
        get timeout() {
            return runtimeState.customTimeout ?? currentTimeout;
        },

        get annotations() {
            return runtimeState.annotations;
        },

        get attachments() {
            return runtimeState.attachments;
        },

        get status() {
            return currentStatus;
        },

        get error() {
            return currentError;
        },

        get duration() {
            return Date.now() - startTime;
        },

        // Methods
        async attach(name: string, options: { path?: string; body?: string | Buffer; contentType?: string }): Promise<void> {
            const attachment: SpecAttachment = {
                name,
                path: options.path,
                body: options.body,
                contentType: options.contentType || 'application/octet-stream'
            };

            // If body is provided but no contentType, try to infer it
            if (options.body && !options.contentType) {
                if (typeof options.body === 'string') {
                    // Check if it looks like JSON
                    try {
                        JSON.parse(options.body);
                        attachment.contentType = 'application/json';
                    } catch {
                        attachment.contentType = 'text/plain';
                    }
                }
            }

            // If path is provided, read the file
            if (options.path && !options.body) {
                try {
                    const fullPath = path.isAbsolute(options.path)
                        ? options.path
                        : path.join(outputDir, options.path);

                    if (fs.existsSync(fullPath)) {
                        attachment.body = fs.readFileSync(fullPath);
                        attachment.path = fullPath;

                        // Infer content type from extension if not provided
                        if (!options.contentType) {
                            const ext = path.extname(fullPath).toLowerCase();
                            const mimeTypes: Record<string, string> = {
                                '.png': 'image/png',
                                '.jpg': 'image/jpeg',
                                '.jpeg': 'image/jpeg',
                                '.gif': 'image/gif',
                                '.svg': 'image/svg+xml',
                                '.pdf': 'application/pdf',
                                '.json': 'application/json',
                                '.xml': 'application/xml',
                                '.html': 'text/html',
                                '.txt': 'text/plain',
                                '.csv': 'text/csv',
                                '.zip': 'application/zip',
                                '.webm': 'video/webm',
                                '.mp4': 'video/mp4'
                            };
                            attachment.contentType = mimeTypes[ext] || 'application/octet-stream';
                        }
                    }
                } catch (error: any) {
                    CSReporter.warn(`[TestInfo] Failed to read attachment file: ${error.message}`);
                }
            }

            runtimeState.attachments.push(attachment);
            CSReporter.debug(`[TestInfo] Attached: ${name}`);
        },

        skip(condition?: boolean, reason?: string): void {
            // Called with no args: skip unconditionally
            if (arguments.length === 0) {
                runtimeState.shouldSkip = true;
                runtimeState.skipReason = 'Skipped via test.info().skip()';
                return;
            }

            // Called with boolean condition
            if (condition === true || condition === undefined) {
                runtimeState.shouldSkip = true;
                runtimeState.skipReason = reason;
            }
        },

        fixme(condition?: boolean, reason?: string): void {
            if (arguments.length === 0 || condition === true || condition === undefined) {
                runtimeState.isFixme = true;
                runtimeState.fixmeReason = reason || 'Marked as fixme';
            }
        },

        fail(condition?: boolean, reason?: string): void {
            if (arguments.length === 0 || condition === true || condition === undefined) {
                runtimeState.expectedToFail = true;
                runtimeState.expectedFailReason = reason || 'Expected to fail';
            }
        },

        slow(condition?: boolean, reason?: string): void {
            if (arguments.length === 0 || condition === true || condition === undefined) {
                runtimeState.isSlow = true;
                runtimeState.slowReason = reason || 'Marked as slow';
            }
        },

        setTimeout(timeout: number): void {
            runtimeState.customTimeout = timeout;
            CSReporter.debug(`[TestInfo] Timeout set to ${timeout}ms`);
        }
    };

    // Add internal methods for runner to update status
    (testInfo as any)._setStatus = (status: SpecTestStatus) => {
        currentStatus = status;
    };

    (testInfo as any)._setError = (error: Error) => {
        currentError = error;
    };

    return testInfo;
}

/**
 * Create an initial runtime state object
 */
export function createRuntimeState(): SpecRuntimeTestState {
    return {
        shouldSkip: false,
        skipReason: undefined,
        isFixme: false,
        fixmeReason: undefined,
        expectedToFail: false,
        expectedFailReason: undefined,
        isSlow: false,
        slowReason: undefined,
        customTimeout: undefined,
        attachments: [],
        annotations: []
    };
}
