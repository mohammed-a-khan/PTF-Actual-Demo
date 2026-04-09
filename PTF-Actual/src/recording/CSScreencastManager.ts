import { Page, Browser, BrowserContext } from '@playwright/test';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import * as fs from 'fs';
import * as path from 'path';

export interface ScreencastOptions {
    outputDir?: string;
    width?: number;
    height?: number;
    quality?: number;
}

export interface ScreencastAnnotation {
    timestamp: number;
    stepName: string;
    details?: string;
    type: 'step' | 'assertion' | 'navigation' | 'error';
    screenshot?: string;  // base64 thumbnail at this point
}

interface ScreencastSession {
    page: Page;
    startTime: number;
    annotations: ScreencastAnnotation[];
    screencastHandle: any | null;  // Playwright 1.59+ screencast object
    videoPath: string | null;
    usingFallback: boolean;
}

/**
 * CSScreencastManager - Screencast API Integration
 *
 * Provides video recording with action annotations for test sessions.
 * Uses runtime API detection to leverage Playwright 1.59+ screencast API
 * when available, falling back to context-level video recording otherwise.
 */
export class CSScreencastManager {
    private static instance: CSScreencastManager;
    private config: CSConfigurationManager;
    private sessions: Map<Page, ScreencastSession> = new Map();
    private globalAnnotations: ScreencastAnnotation[] = [];

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSScreencastManager {
        if (!CSScreencastManager.instance) {
            CSScreencastManager.instance = new CSScreencastManager();
        }
        return CSScreencastManager.instance;
    }

    /**
     * Check if the Playwright screencast API is available (requires 1.59+)
     * In 1.59, page.screencast is an object with .start() method, not a function
     */
    private hasScreencastAPI(page: Page): boolean {
        const sc = (page as any).screencast;
        return sc && typeof sc === 'object' && typeof sc.start === 'function';
    }

    /**
     * Get the configured output directory for screencasts
     */
    private getOutputDir(options?: ScreencastOptions): string {
        const dir = options?.outputDir
            || this.config.get('SCREENCAST_DIR', 'test-results/screencasts');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    /**
     * Start screencast recording for a page.
     * Uses native screencast API if available, otherwise falls back to
     * context-level video recording.
     */
    public async startScreencast(page: Page, options?: ScreencastOptions): Promise<void> {
        if (!this.config.getBoolean('SCREENCAST_ENABLED', false)) {
            CSReporter.debug('Screencast recording is disabled (SCREENCAST_ENABLED=false)');
            return;
        }

        if (this.sessions.has(page)) {
            CSReporter.warn('Screencast already active for this page, stopping previous session');
            await this.stopScreencast(page);
        }

        const outputDir = this.getOutputDir(options);
        const quality = options?.quality
            || this.config.getNumber('SCREENCAST_QUALITY', 80);

        const session: ScreencastSession = {
            page,
            startTime: Date.now(),
            annotations: [],
            screencastHandle: null,
            videoPath: null,
            usingFallback: false,
        };

        if (this.hasScreencastAPI(page)) {
            // Playwright 1.59+ screencast API: page.screencast.start({ path })
            try {
                const videoFileName = `screencast-${Date.now()}.webm`;
                const videoFilePath = path.join(outputDir, videoFileName);

                await (page as any).screencast.start({ path: videoFilePath });
                session.screencastHandle = (page as any).screencast;
                session.videoPath = videoFilePath;
                CSReporter.info(`Screencast recording started: ${videoFileName}`);
            } catch (error) {
                CSReporter.warn(`Screencast API call failed, falling back to video recording: ${error}`);
                await this.startFallbackRecording(page, session, outputDir);
            }
        } else {
            // Playwright 1.58.x or earlier - use fallback
            CSReporter.info(
                'Screencast API not available (requires Playwright 1.59+), using video recording fallback'
            );
            await this.startFallbackRecording(page, session, outputDir);
        }

        this.sessions.set(page, session);
    }

    /**
     * Fallback recording using context-level video.
     * Context video recording is configured at context creation time,
     * so this captures what's already available.
     */
    private async startFallbackRecording(
        page: Page,
        session: ScreencastSession,
        outputDir: string
    ): Promise<void> {
        session.usingFallback = true;

        try {
            // Check if context already has video recording enabled
            const video = page.video();
            if (video) {
                const videoPath = await video.path();
                session.videoPath = videoPath;
                CSReporter.info(`Fallback: using existing context video recording at ${videoPath}`);
            } else {
                CSReporter.info(
                    'Fallback: no context video recording available. ' +
                    'To enable fallback video, configure RECORD_VIDEO=true in your context options.'
                );
                // Store annotations anyway - they can be exported as metadata
                session.videoPath = null;
            }
        } catch (error) {
            CSReporter.debug(`Fallback video path retrieval failed: ${error}`);
            session.videoPath = null;
        }
    }

    /**
     * Stop screencast recording and return the video path (if available).
     */
    public async stopScreencast(page: Page): Promise<string | null> {
        const session = this.sessions.get(page);
        if (!session) {
            CSReporter.debug('No active screencast session for this page');
            return null;
        }

        let videoPath: string | null = null;

        try {
            if (session.screencastHandle && !session.usingFallback) {
                // Native screencast API stop
                try {
                    await session.screencastHandle.stop();
                    videoPath = session.videoPath;
                    CSReporter.info(`Screencast stopped, video saved to: ${videoPath}`);
                } catch (error) {
                    CSReporter.warn(`Error stopping screencast: ${error}`);
                    videoPath = session.videoPath; // still return path even if stop had issues
                }
            } else if (session.usingFallback) {
                // Fallback - try to get video path from context
                try {
                    const video = page.video();
                    if (video) {
                        videoPath = await video.path();
                        CSReporter.info(`Fallback video available at: ${videoPath}`);
                    }
                } catch (error) {
                    CSReporter.debug(`Fallback video path not available: ${error}`);
                }
                videoPath = videoPath || session.videoPath;
            }
        } finally {
            // Preserve annotations globally before removing session
            this.globalAnnotations.push(...session.annotations);
            this.sessions.delete(page);
        }

        // Generate annotated timeline if annotations exist and enabled
        if (this.config.getBoolean('SCREENCAST_ANNOTATE', true) && session.annotations.length > 0) {
            const outputDir = this.getOutputDir();
            const timelinePath = path.join(
                outputDir,
                `timeline-${session.startTime}.json`
            );
            await this.generateAnnotatedTimeline(timelinePath, session.annotations, session.startTime);
        }

        return videoPath;
    }

    /**
     * Annotate the current frame with step information.
     * If native screencast is available, annotations are attached to frames.
     * Otherwise, annotations are stored in memory for metadata export.
     */
    public async annotateAction(
        page: Page,
        stepName: string,
        details?: string,
        type: ScreencastAnnotation['type'] = 'step'
    ): Promise<void> {
        if (!this.config.getBoolean('SCREENCAST_ANNOTATE', true)) {
            return;
        }

        const annotation: ScreencastAnnotation = {
            timestamp: Date.now(),
            stepName,
            details,
            type,
        };

        // Capture a thumbnail screenshot for this annotation
        try {
            const screenshot = await page.screenshot({
                type: 'jpeg',
                quality: 40,
                timeout: 5000,
            });
            annotation.screenshot = screenshot.toString('base64');
        } catch (error) {
            // Screenshot capture is best-effort
            CSReporter.debug(`Annotation screenshot failed: ${error}`);
        }

        // Store in session if active
        const session = this.sessions.get(page);
        if (session) {
            session.annotations.push(annotation);

            // If native screencast is available, try to annotate the frame
            if (session.screencastHandle && !session.usingFallback) {
                try {
                    if (typeof session.screencastHandle.annotate === 'function') {
                        await session.screencastHandle.annotate(stepName, details);
                    }
                } catch (error) {
                    CSReporter.debug(`Native frame annotation failed: ${error}`);
                }
            }
        } else {
            // No active session, store globally
            this.globalAnnotations.push(annotation);
        }

        CSReporter.debug(`Screencast annotation: [${type}] ${stepName}${details ? ' - ' + details : ''}`);
    }

    /**
     * Get all recorded annotations (from active sessions and completed ones).
     */
    public getAnnotations(): ScreencastAnnotation[] {
        const allAnnotations = [...this.globalAnnotations];

        // Include annotations from active sessions
        const sessionValues = Array.from(this.sessions.values());
        for (const session of sessionValues) {
            allAnnotations.push(...session.annotations);
        }

        // Sort by timestamp
        allAnnotations.sort((a, b) => a.timestamp - b.timestamp);
        return allAnnotations;
    }

    /**
     * Generate a JSON timeline file matching annotations to video timestamps.
     */
    public async generateAnnotatedTimeline(
        outputPath: string,
        annotations?: ScreencastAnnotation[],
        sessionStartTime?: number
    ): Promise<void> {
        const annotationList = annotations || this.getAnnotations();
        const startTime = sessionStartTime || (annotationList.length > 0
            ? annotationList[0].timestamp
            : Date.now());

        const timeline = {
            generatedAt: new Date().toISOString(),
            sessionStartTime: startTime,
            totalDuration: annotationList.length > 0
                ? annotationList[annotationList.length - 1].timestamp - startTime
                : 0,
            annotationCount: annotationList.length,
            annotations: annotationList.map(annotation => ({
                offsetMs: annotation.timestamp - startTime,
                offsetFormatted: this.formatDuration(annotation.timestamp - startTime),
                type: annotation.type,
                stepName: annotation.stepName,
                details: annotation.details || null,
                hasScreenshot: !!annotation.screenshot,
            })),
        };

        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        fs.writeFileSync(outputPath, JSON.stringify(timeline, null, 2), 'utf-8');
        CSReporter.info(`Annotated timeline generated: ${outputPath}`);
    }

    /**
     * Format milliseconds into HH:MM:SS.mmm
     */
    private formatDuration(ms: number): string {
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        const millis = ms % 1000;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
    }

    /**
     * Check if screencast recording is enabled via configuration.
     */
    public isScreencastEnabled(): boolean {
        return this.config.getBoolean('SCREENCAST_ENABLED', false);
    }

    /**
     * Check if a screencast session is active for the given page.
     */
    public isRecording(page: Page): boolean {
        return this.sessions.has(page);
    }

    /**
     * Get the count of active screencast sessions.
     */
    public getActiveSessionCount(): number {
        return this.sessions.size;
    }

    /**
     * Clear all stored annotations (useful between test runs).
     */
    public clearAnnotations(): void {
        this.globalAnnotations = [];
    }

    /**
     * Stop all active screencast sessions.
     */
    public async stopAll(): Promise<void> {
        const pages = Array.from(this.sessions.keys());
        for (const page of pages) {
            try {
                await this.stopScreencast(page);
            } catch (error) {
                CSReporter.debug(`Error stopping screencast session: ${error}`);
            }
        }
    }
}
