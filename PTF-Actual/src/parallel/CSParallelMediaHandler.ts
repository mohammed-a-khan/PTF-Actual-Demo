import { Page, BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
// Parallel resource manager removed - handled differently now
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';

/**
 * Handles media capture (screenshots, videos, traces) for parallel execution
 * Ensures proper isolation and organization per worker
 */
export class CSParallelMediaHandler {
    private static instance: CSParallelMediaHandler;
    private config: CSConfigurationManager;
    private consoleLogs: Map<number, string[]> = new Map();
    private testResultsDir: string;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.testResultsDir = this.config.get('TEST_RESULTS_DIR') || path.join(process.cwd(), 'reports', 'test-results');
    }

    public static getInstance(): CSParallelMediaHandler {
        if (!CSParallelMediaHandler.instance) {
            CSParallelMediaHandler.instance = new CSParallelMediaHandler();
        }
        return CSParallelMediaHandler.instance;
    }

    /**
     * Capture screenshot with worker-aware path
     */
    public async captureScreenshot(
        page: Page,
        name: string,
        options: ScreenshotOptions = {}
    ): Promise<string> {
        try {
            const dirs = this.getWorkerDirectories();
            const timestamp = Date.now();
            const workerId = this.getCurrentWorkerId();

            // Create unique filename
            const filename = this.sanitizeFilename(name);
            const screenshotPath = path.join(
                dirs.screenshots,
                `${filename}_w${workerId}_${timestamp}.png`
            );

            // Ensure directory exists
            const dir = path.dirname(screenshotPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Take screenshot
            await page.screenshot({
                path: screenshotPath,
                fullPage: options.fullPage !== false,
                ...options
            });

            CSReporter.debug(`Screenshot captured: ${screenshotPath} (Worker ${workerId})`);
            return screenshotPath;

        } catch (error: any) {
            CSReporter.warn(`Failed to capture screenshot: ${error.message}`);
            return '';
        }
    }

    /**
     * Capture element screenshot with worker-aware path
     */
    public async captureElementScreenshot(
        element: any,
        name: string,
        options: any = {}
    ): Promise<string> {
        try {
            const dirs = this.getWorkerDirectories();
            const timestamp = Date.now();
            const workerId = this.getCurrentWorkerId();

            const filename = this.sanitizeFilename(name);
            const screenshotPath = path.join(
                dirs.screenshots,
                `element_${filename}_w${workerId}_${timestamp}.png`
            );

            // Ensure directory exists
            const dir = path.dirname(screenshotPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Take element screenshot
            await element.screenshot({
                path: screenshotPath,
                ...options
            });

            CSReporter.debug(`Element screenshot captured: ${screenshotPath} (Worker ${workerId})`);
            return screenshotPath;

        } catch (error: any) {
            CSReporter.warn(`Failed to capture element screenshot: ${error.message}`);
            return '';
        }
    }

    /**
     * Save trace with worker-aware path
     */
    public async saveTrace(context: BrowserContext, name: string): Promise<string> {
        try {
            const dirs = this.getWorkerDirectories();
            const timestamp = Date.now();
            const workerId = this.getCurrentWorkerId();

            const filename = this.sanitizeFilename(name);
            const tracePath = path.join(
                dirs.traces,
                `trace_${filename}_w${workerId}_${timestamp}.zip`
            );

            // Ensure directory exists
            const dir = path.dirname(tracePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Stop and save trace
            await context.tracing.stop({ path: tracePath });

            CSReporter.debug(`Trace saved: ${tracePath} (Worker ${workerId})`);
            return tracePath;

        } catch (error: any) {
            CSReporter.warn(`Failed to save trace: ${error.message}`);
            return '';
        }
    }

    /**
     * Capture console logs for a page (browser console)
     */
    public setupConsoleLogCapture(page: Page): void {
        const workerId = this.getCurrentWorkerId();

        if (!this.consoleLogs.has(workerId)) {
            this.consoleLogs.set(workerId, []);
        }

        const logs = this.consoleLogs.get(workerId)!;

        // Capture browser console messages
        page.on('console', msg => {
            const timestamp = new Date().toISOString();
            const logEntry = `[${timestamp}] [BROWSER-${msg.type().toUpperCase()}] ${msg.text()}`;
            logs.push(logEntry);

            // Also log to debug if enabled
            if (this.config.getBoolean('DEBUG_CONSOLE_LOGS', false)) {
                CSReporter.debug(`[Worker ${workerId}] Browser Console: ${logEntry}`);
            }
        });

        // Capture page errors
        page.on('pageerror', error => {
            const timestamp = new Date().toISOString();
            const errorEntry = `[${timestamp}] [ERROR] ${error.message}\n${error.stack}`;
            logs.push(errorEntry);
            CSReporter.warn(`[Worker ${workerId}] Page error: ${error.message}`);
        });

        // Capture request failures
        page.on('requestfailed', request => {
            const timestamp = new Date().toISOString();
            const failureEntry = `[${timestamp}] [REQUEST_FAILED] ${request.url()} - ${request.failure()?.errorText}`;
            logs.push(failureEntry);
        });

        // Capture responses with errors
        page.on('response', response => {
            if (response.status() >= 400) {
                const timestamp = new Date().toISOString();
                const responseEntry = `[${timestamp}] [RESPONSE_ERROR] ${response.url()} - Status: ${response.status()}`;
                logs.push(responseEntry);
            }
        });
    }

    /**
     * Save console logs to file
     */
    public async saveConsoleLogs(scenarioName: string): Promise<string> {
        try {
            const workerId = this.getCurrentWorkerId();
            const logs = this.consoleLogs.get(workerId);

            if (!logs || logs.length === 0) {
                return '';
            }

            const dirs = this.getWorkerDirectories();
            const timestamp = Date.now();

            const filename = this.sanitizeFilename(scenarioName);
            const logPath = path.join(
                dirs.logs,
                `console_${filename}_w${workerId}_${timestamp}.log`
            );

            // Ensure directory exists
            const dir = path.dirname(logPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Write logs to file
            const content = logs.join('\n');
            fs.writeFileSync(logPath, content, 'utf8');

            // Clear logs for next scenario
            this.consoleLogs.set(workerId, []);

            CSReporter.debug(`Console logs saved: ${logPath} (Worker ${workerId})`);
            return logPath;

        } catch (error: any) {
            CSReporter.warn(`Failed to save console logs: ${error.message}`);
            return '';
        }
    }

    /**
     * Handle video path after recording stops
     */
    public async handleVideoRecording(context: BrowserContext, scenarioName: string): Promise<string> {
        try {
            // Video is automatically saved by Playwright to the configured directory
            // We just need to track and potentially rename it

            const pages = context.pages();
            if (pages.length === 0) {
                return '';
            }

            const video = pages[0].video();
            if (!video) {
                return '';
            }

            // Get the auto-generated video path
            const videoPath = await video.path();
            if (!videoPath) {
                return '';
            }

            // Optionally rename for better identification
            const dirs = this.getWorkerDirectories();
            const workerId = this.getCurrentWorkerId();
            const timestamp = Date.now();
            const filename = this.sanitizeFilename(scenarioName);

            const newVideoPath = path.join(
                dirs.videos,
                `video_${filename}_w${workerId}_${timestamp}.webm`
            );

            // Move/rename the video file
            if (fs.existsSync(videoPath) && videoPath !== newVideoPath) {
                const dir = path.dirname(newVideoPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                fs.renameSync(videoPath, newVideoPath);
                CSReporter.debug(`Video renamed: ${newVideoPath} (Worker ${workerId})`);
                return newVideoPath;
            }

            return videoPath;

        } catch (error: any) {
            CSReporter.warn(`Failed to handle video recording: ${error.message}`);
            return '';
        }
    }

    /**
     * Get HAR file path for a scenario
     */
    public getHarFilePath(scenarioName: string): string {
        const dirs = this.getWorkerDirectories();
        const workerId = this.getCurrentWorkerId();
        const timestamp = Date.now();
        const filename = this.sanitizeFilename(scenarioName);

        return path.join(
            dirs.har,
            `network_${filename}_w${workerId}_${timestamp}.har`
        );
    }

    /**
     * Get download directory for current worker
     */
    public getDownloadDirectory(): string {
        const dirs = this.getWorkerDirectories();
        return dirs.downloads;
    }

    /**
     * Get current worker ID
     */
    private getCurrentWorkerId(): number {
        if (process.env.WORKER_ID) {
            return parseInt(process.env.WORKER_ID);
        }
        return 0;
    }

    /**
     * Sanitize filename for filesystem
     */
    private sanitizeFilename(name: string): string {
        return name
            .replace(/[^a-z0-9]/gi, '_')
            .replace(/__+/g, '_')
            .substring(0, 100); // Limit length
    }

    /**
     * Get worker directories
     */
    private getWorkerDirectories() {
        // Use the main test results directory, not worker-specific subdirectories
        const baseDir = this.testResultsDir;
        return {
            screenshots: path.join(baseDir, 'screenshots'),
            videos: path.join(baseDir, 'videos'),
            traces: path.join(baseDir, 'traces'),
            logs: path.join(baseDir, 'console-logs'),
            har: path.join(baseDir, 'har'),
            downloads: path.join(baseDir, 'downloads')
        };
    }

    /**
     * Clean up logs for a worker
     */
    public cleanupWorkerLogs(workerId: number): void {
        this.consoleLogs.delete(workerId);
    }
}

/**
 * Collect artifact filenames from worker process
 * Since all processes (main and workers) save artifacts directly to the test results directory,
 * this function just extracts the filenames for report generation.
 * No copying is needed as files are already in the correct location.
 */
export async function copyArtifactsFromWorker(
    artifacts: any,
    workerId: number
): Promise<any> {
    const copiedArtifacts: any = {
        screenshots: [],
        videos: [],
        traces: [],
        har: [],
        logs: []
    };

    // Process screenshots - just extract filenames since they're already in the test results folder
    if (artifacts.screenshots && artifacts.screenshots.length > 0) {
        for (const screenshot of artifacts.screenshots) {
            if (typeof screenshot === 'string') {
                // Extract just the filename for reports
                const filename = path.basename(screenshot);
                copiedArtifacts.screenshots.push(filename);
            }
        }
    }

    // Process videos - just extract filenames since they're already in the test results folder
    if (artifacts.videos && artifacts.videos.length > 0) {
        for (const video of artifacts.videos) {
            if (typeof video === 'string') {
                // Extract just the filename for reports
                const filename = path.basename(video);
                copiedArtifacts.videos.push(filename);
            }
        }
    }

    // Process traces - just extract filenames since they're already in the test results folder
    if (artifacts.traces && artifacts.traces.length > 0) {
        for (const trace of artifacts.traces) {
            if (typeof trace === 'string') {
                // Extract just the filename for reports
                const filename = path.basename(trace);
                copiedArtifacts.traces.push(filename);
            }
        }
    }

    // Process HAR files - just extract filenames since they're already in the test results folder
    if (artifacts.har && artifacts.har.length > 0) {
        for (const har of artifacts.har) {
            if (typeof har === 'string') {
                // Extract just the filename for reports
                const filename = path.basename(har);
                copiedArtifacts.har.push(filename);
            }
        }
    }

    // Process logs - just extract filenames since they're already in the test results folder
    if (artifacts.logs && artifacts.logs.length > 0) {
        for (const log of artifacts.logs) {
            if (typeof log === 'string') {
                // Extract just the filename for reports
                const filename = path.basename(log);
                copiedArtifacts.logs.push(filename);
            }
        }
    }

    return copiedArtifacts;
}

interface ScreenshotOptions {
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
    omitBackground?: boolean;
    quality?: number;
    type?: 'png' | 'jpeg';
}