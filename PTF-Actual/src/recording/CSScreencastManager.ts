import { Page } from '@playwright/test';
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

/**
 * All user-configurable screencast overlay features.
 * Each can be independently toggled via environment config.
 */
export interface ScreencastFeatureFlags {
    /** Master switch — must be true for any screencast to work */
    enabled: boolean;
    /** Show Playwright action annotations (click, fill, hover, navigate) on recording */
    annotateActions: boolean;
    /** Show step chapter/badge overlay at each step start */
    showStepOverlay: boolean;
    /** Show PASS/FAIL flash badge after each step */
    showPassFailOverlay: boolean;
    /** Show persistent scenario name in top-left corner throughout recording */
    showScenarioName: boolean;
    /** Show elapsed time overlay */
    showTimestamp: boolean;
    /** Use centered showChapter() modal instead of corner badge for steps */
    useChapterMode: boolean;
    /** Show final scenario result (PASSED/FAILED) banner at recording end */
    showFinalResult: boolean;
    /** Action annotation position */
    actionPosition: string;
    /** Action annotation font size */
    actionFontSize: number;
    /** Action annotation duration (ms) */
    actionDuration: number;
    /** Step overlay duration (ms) */
    stepDuration: number;
    /** Pass/fail flash duration (ms) */
    passFailDuration: number;
    /** Video resolution width */
    videoWidth: number;
    /** Video resolution height */
    videoHeight: number;
    /** Video quality (0-100, 0 = default) */
    videoQuality: number;
}

interface ScreencastSession {
    page: Page;
    scenarioName: string;
    videoPath: string;
    startTime: number;
    features: ScreencastFeatureFlags;
    totalSteps: number;
    currentStep: number;
    lastStepOverlayDisposable?: any;
    lastPassFailOverlayDisposable?: any;
    scenarioNameOverlayDisposable?: any;
    timestampInterval?: ReturnType<typeof setInterval>;
    timestampOverlayDisposable?: any;
}

/**
 * CSScreencastManager — Playwright 1.59+ screencast with full user-configurable features
 *
 * Provides per-scenario video recording with overlays burned into the video frames.
 * Users control which features are active via environment config flags.
 *
 * ## Default Behavior (when SCREENCAST_ENABLED=true)
 * - Action annotations (top-right): shows each Playwright action (click, fill, etc.)
 * - Step badge (top-left): shows "Step N/M — Given/When/Then <text>"
 * - Pass/Fail flash (top-right): green PASS or red FAIL after each step
 * - Scenario name (top-left persistent): shows scenario name throughout recording
 *
 * ## User-Configurable Features (opt-in/opt-out)
 *
 * | Config Key                          | Type    | Default      | Description                                    |
 * |-------------------------------------|---------|--------------|------------------------------------------------|
 * | SCREENCAST_ENABLED                  | boolean | false        | Master switch — enables screencast recording    |
 * | SCREENCAST_ANNOTATE_ACTIONS         | boolean | true         | Show Playwright action annotations              |
 * | SCREENCAST_SHOW_STEP_OVERLAY        | boolean | true         | Show step chapter/badge at each step            |
 * | SCREENCAST_SHOW_PASS_FAIL           | boolean | true         | Flash PASS/FAIL after each step                 |
 * | SCREENCAST_SHOW_SCENARIO_NAME       | boolean | true         | Persistent scenario name overlay                |
 * | SCREENCAST_SHOW_TIMESTAMP           | boolean | false        | Show elapsed time in recording                  |
 * | SCREENCAST_USE_CHAPTER_MODE         | boolean | false        | Use centered modal instead of corner badge      |
 * | SCREENCAST_SHOW_FINAL_RESULT        | boolean | true         | Show final PASSED/FAILED banner at end          |
 * | SCREENCAST_ACTION_POSITION          | string  | 'top-right'  | Position of action annotations                  |
 * | SCREENCAST_ACTION_FONT_SIZE         | number  | 16           | Font size for action annotations                |
 * | SCREENCAST_ACTION_DURATION          | number  | 700          | Duration action text stays visible (ms)         |
 * | SCREENCAST_STEP_DURATION            | number  | 1500         | Duration step badge stays visible (ms)          |
 * | SCREENCAST_PASS_FAIL_DURATION       | number  | 800          | Duration pass/fail flash stays visible (ms)     |
 * | SCREENCAST_WIDTH                    | number  | 1280         | Video resolution width                          |
 * | SCREENCAST_HEIGHT                   | number  | 720          | Video resolution height                         |
 * | SCREENCAST_QUALITY                  | number  | 0            | Video quality 0-100 (0=default)                 |
 * | SCREENCAST_DIR                      | string  | 'test-results/videos' | Output directory for .webm files         |
 */
export class CSScreencastManager {
    private static instance: CSScreencastManager;
    private config: CSConfigurationManager;
    private sessions: Map<Page, ScreencastSession> = new Map();

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSScreencastManager {
        if (!CSScreencastManager.instance) {
            CSScreencastManager.instance = new CSScreencastManager();
        }
        return CSScreencastManager.instance;
    }

    public isEnabled(): boolean {
        return this.config.getBoolean('SCREENCAST_ENABLED', false);
    }

    /**
     * Read all feature flags from configuration.
     * Users can toggle each feature independently.
     */
    public getFeatureFlags(): ScreencastFeatureFlags {
        return {
            enabled: this.config.getBoolean('SCREENCAST_ENABLED', false),
            annotateActions: this.config.getBoolean('SCREENCAST_ANNOTATE_ACTIONS', true),
            showStepOverlay: this.config.getBoolean('SCREENCAST_SHOW_STEP_OVERLAY', true),
            showPassFailOverlay: this.config.getBoolean('SCREENCAST_SHOW_PASS_FAIL', true),
            showScenarioName: this.config.getBoolean('SCREENCAST_SHOW_SCENARIO_NAME', true),
            showTimestamp: this.config.getBoolean('SCREENCAST_SHOW_TIMESTAMP', false),
            useChapterMode: this.config.getBoolean('SCREENCAST_USE_CHAPTER_MODE', false),
            showFinalResult: this.config.getBoolean('SCREENCAST_SHOW_FINAL_RESULT', true),
            actionPosition: this.config.get('SCREENCAST_ACTION_POSITION', 'top-right'),
            actionFontSize: this.config.getNumber('SCREENCAST_ACTION_FONT_SIZE', 16),
            actionDuration: this.config.getNumber('SCREENCAST_ACTION_DURATION', 700),
            stepDuration: this.config.getNumber('SCREENCAST_STEP_DURATION', 1500),
            passFailDuration: this.config.getNumber('SCREENCAST_PASS_FAIL_DURATION', 800),
            videoWidth: this.config.getNumber('SCREENCAST_WIDTH', 1280),
            videoHeight: this.config.getNumber('SCREENCAST_HEIGHT', 720),
            videoQuality: this.config.getNumber('SCREENCAST_QUALITY', 0),
        };
    }

    private disposeQuiet(d: any): void {
        if (!d) return;
        try {
            if (typeof d === 'function') {
                d();
            } else if (typeof d.dispose === 'function') {
                d.dispose();
            } else if (typeof d[Symbol.dispose] === 'function') {
                d[Symbol.dispose]();
            }
        } catch {
            // best-effort
        }
    }

    private sanitizeName(name: string): string {
        return (name || 'scenario').replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
    }

    private getOutputDir(options?: ScreencastOptions): string {
        const dir = options?.outputDir
            || this.config.get('SCREENCAST_DIR', 'test-results/videos');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    private hasScreencastAPI(page: Page): boolean {
        const sc = (page as any).screencast;
        return sc && typeof sc === 'object' && typeof sc.start === 'function';
    }

    // ============ Overlay HTML Builders ============

    private buildScenarioNameHTML(scenarioName: string): string {
        return `
            <div style="
                position: fixed; top: 10px; left: 10px;
                max-width: 50vw;
                padding: 6px 12px;
                background: rgba(30, 41, 59, 0.88); color: #f1f5f9;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 12px; font-weight: 600;
                border-radius: 4px;
                border-left: 3px solid #3b82f6;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                z-index: 2147483647;
                pointer-events: none;
                user-select: none;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            ">
                <span style="color: #60a5fa; margin-right: 4px;">▶</span> ${scenarioName}
            </div>`;
    }

    private buildStepBadgeHTML(title: string, description: string): string {
        const maxLen = 80;
        const truncated = description.length > maxLen
            ? description.substring(0, maxLen - 1) + '…'
            : description;

        return `
            <div style="
                position: fixed; top: ${this.config.getBoolean('SCREENCAST_SHOW_SCENARIO_NAME', true) ? '44' : '16'}px; left: 16px;
                max-width: 60vw;
                padding: 8px 14px;
                background: rgba(15, 23, 42, 0.92); color: #e2e8f0;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 14px; font-weight: 500;
                border-radius: 6px;
                border-left: 4px solid #38bdf8;
                box-shadow: 0 4px 12px rgba(0,0,0,0.35);
                z-index: 2147483646;
                pointer-events: none;
                user-select: none;
            ">
                <div style="font-size: 11px; color: #94a3b8; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 2px;">${title}</div>
                <div>${truncated}</div>
            </div>`;
    }

    private buildPassFailHTML(status: 'passed' | 'failed'): string {
        const isPass = status === 'passed';
        const bg = isPass ? '#16a34a' : '#dc2626';
        const icon = isPass ? '✓' : '✗';
        const label = isPass ? 'PASS' : 'FAIL';

        return `
            <div style="
                position: fixed; top: 16px; right: 16px;
                padding: 8px 16px;
                background: ${bg}; color: white;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 18px; font-weight: 700;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.25);
                z-index: 2147483647;
                pointer-events: none;
                user-select: none;
            ">${icon} ${label}</div>`;
    }

    private buildFinalResultHTML(status: 'passed' | 'failed', scenarioName: string, elapsed: number): string {
        const isPass = status === 'passed';
        const bg = isPass ? 'rgba(22, 163, 74, 0.95)' : 'rgba(220, 38, 38, 0.95)';
        const icon = isPass ? '✓ PASSED' : '✗ FAILED';
        const elapsedSec = (elapsed / 1000).toFixed(1);

        return `
            <div style="
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                padding: 24px 48px;
                background: ${bg}; color: white;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 28px; font-weight: 800;
                border-radius: 16px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                text-align: center;
                z-index: 2147483647;
                pointer-events: none;
                user-select: none;
            ">
                <div>${icon}</div>
                <div style="font-size: 14px; font-weight: 400; margin-top: 8px; opacity: 0.9;">${scenarioName}</div>
                <div style="font-size: 12px; font-weight: 400; margin-top: 4px; opacity: 0.7;">Duration: ${elapsedSec}s</div>
            </div>`;
    }

    private buildTimestampHTML(elapsed: number): string {
        const secs = Math.floor(elapsed / 1000);
        const mins = Math.floor(secs / 60);
        const remaining = secs % 60;
        const formatted = `${String(mins).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;

        return `
            <div style="
                position: fixed; bottom: 10px; right: 10px;
                padding: 4px 10px;
                background: rgba(0, 0, 0, 0.6); color: #e2e8f0;
                font-family: 'Courier New', monospace;
                font-size: 12px; font-weight: 600;
                border-radius: 4px;
                z-index: 2147483645;
                pointer-events: none;
                user-select: none;
            ">⏱ ${formatted}</div>`;
    }

    // ============ Main Lifecycle Methods ============

    /**
     * Start a per-scenario screencast with user-configured features.
     * Called by CSBDDRunner at scenario start.
     */
    public async startScreencast(
        page: Page,
        scenarioName: string,
        options?: ScreencastOptions
    ): Promise<void> {
        if (!this.isEnabled()) return;
        if (!this.hasScreencastAPI(page)) {
            CSReporter.debug('Screencast: page.screencast API not available (requires Playwright 1.59+) — skipping');
            return;
        }
        if (this.sessions.has(page)) {
            await this.stopScreencast(page);
        }

        const features = this.getFeatureFlags();
        const outputDir = this.getOutputDir(options);
        const safeName = this.sanitizeName(scenarioName);
        const videoPath = path.join(outputDir, `${safeName}.webm`);

        // Build start options — Playwright screencast.start() only accepts:
        //   path, size, quality, onFrame
        // Action annotations must be enabled SEPARATELY via showActions()
        const startOptions: any = { path: videoPath };

        // Video resolution (user choice: SCREENCAST_WIDTH / SCREENCAST_HEIGHT)
        const width = options?.width || features.videoWidth;
        const height = options?.height || features.videoHeight;
        if (width > 0 && height > 0) {
            startOptions.size = { width, height };
        }

        // Video quality (user choice: SCREENCAST_QUALITY)
        const quality = options?.quality || features.videoQuality;
        if (quality > 0) {
            startOptions.quality = quality;
        }

        try {
            // 1. Start recording
            await (page as any).screencast.start(startOptions);

            const session: ScreencastSession = {
                page,
                scenarioName,
                videoPath,
                startTime: Date.now(),
                features,
                totalSteps: 0,
                currentStep: 0,
            };
            this.sessions.set(page, session);

            // 2. Enable action annotations SEPARATELY (user choice: SCREENCAST_ANNOTATE_ACTIONS)
            //    showActions() must be called AFTER start() — it's a separate API call
            if (features.annotateActions) {
                try {
                    console.log('[SCREENCAST] Calling showActions()...');
                    const actionsDisposable = await (page as any).screencast.showActions({
                        position: features.actionPosition,
                        fontSize: features.actionFontSize,
                        duration: features.actionDuration,
                    });
                    (session as any).actionsDisposable = actionsDisposable;
                    console.log('[SCREENCAST] showActions() SUCCESS');
                } catch (e: any) {
                    console.error(`[SCREENCAST] showActions() FAILED: ${e.message || e}`);
                }
            } else {
                console.log('[SCREENCAST] annotateActions=false, skipping showActions()');
            }

            // 3. Persistent scenario name overlay (user choice: SCREENCAST_SHOW_SCENARIO_NAME)
            if (features.showScenarioName) {
                try {
                    console.log('[SCREENCAST] Calling showOverlay() for scenario name...');
                    const html = this.buildScenarioNameHTML(scenarioName);
                    const disposable = await (page as any).screencast.showOverlay(html);
                    session.scenarioNameOverlayDisposable = disposable;
                    console.log('[SCREENCAST] Scenario name overlay SUCCESS');
                } catch (e: any) {
                    console.error(`[SCREENCAST] Scenario name overlay FAILED: ${e.message || e}`);
                }
            } else {
                console.log('[SCREENCAST] showScenarioName=false, skipping');
            }

            // 4. Elapsed timestamp overlay (user choice: SCREENCAST_SHOW_TIMESTAMP)
            if (features.showTimestamp) {
                console.log('[SCREENCAST] Starting timestamp overlay...');
                this.startTimestampOverlay(page, session);
            } else {
                console.log('[SCREENCAST] showTimestamp=false, skipping');
            }

            console.log(`[SCREENCAST] Feature flags: ${JSON.stringify(features, null, 2)}`);

            CSReporter.info(
                `Screencast started: "${scenarioName}" → ${path.basename(videoPath)} ` +
                `[actions=${features.annotateActions}, steps=${features.showStepOverlay}, ` +
                `passFail=${features.showPassFailOverlay}, scenarioName=${features.showScenarioName}, ` +
                `timestamp=${features.showTimestamp}, chapters=${features.useChapterMode}]`
            );
        } catch (error: any) {
            CSReporter.warn(`Screencast start failed for "${scenarioName}": ${error.message || error}`);
        }
    }

    /**
     * Start a periodic timestamp overlay that updates every second.
     */
    private startTimestampOverlay(page: Page, session: ScreencastSession): void {
        session.timestampInterval = setInterval(async () => {
            if (!this.sessions.has(page)) {
                if (session.timestampInterval) clearInterval(session.timestampInterval);
                return;
            }
            const elapsed = Date.now() - session.startTime;
            const html = this.buildTimestampHTML(elapsed);

            this.disposeQuiet(session.timestampOverlayDisposable);
            try {
                session.timestampOverlayDisposable = await (page as any).screencast.showOverlay(html);
            } catch {
                // Page may have closed
                if (session.timestampInterval) clearInterval(session.timestampInterval);
            }
        }, 1000);
    }

    /**
     * Set the total steps count for the current scenario.
     * Called by CSBDDRunner after parsing background + scenario steps.
     */
    public setTotalSteps(page: Page, totalSteps: number): void {
        const session = this.sessions.get(page);
        if (session) {
            session.totalSteps = totalSteps;
        }
    }

    /**
     * Notify step start. Renders overlay based on user's choice:
     * - Badge mode (default): corner badge with step info
     * - Chapter mode (SCREENCAST_USE_CHAPTER_MODE=true): centered modal
     *
     * Fire-and-forget — zero blocking latency.
     */
    public notifyStepStart(
        page: Page,
        stepNumber: number,
        totalSteps: number,
        keyword: string,
        text: string
    ): void {
        const session = this.sessions.get(page);
        if (!session) return;
        if (!session.features.showStepOverlay) return;

        session.currentStep = stepNumber;
        if (totalSteps > 0) session.totalSteps = totalSteps;

        const title = session.totalSteps > 0
            ? `Step ${stepNumber}/${session.totalSteps}`
            : `Step ${stepNumber}`;
        const description = `${keyword.trim()} ${text}`.trim();

        // User choice: chapter mode (centered) vs badge mode (corner)
        if (session.features.useChapterMode) {
            // Chapter mode: centered modal with blur backdrop
            try {
                (page as any).screencast.showChapter(title, {
                    description,
                    duration: session.features.stepDuration,
                }).catch((e: any) => {
                    CSReporter.debug(`Screencast chapter failed: ${e.message || e}`);
                });
            } catch (e: any) {
                CSReporter.debug(`Screencast chapter sync failed: ${e.message || e}`);
            }
        } else {
            // Badge mode: corner badge (default)
            const html = this.buildStepBadgeHTML(title, description);

            this.disposeQuiet(session.lastStepOverlayDisposable);
            session.lastStepOverlayDisposable = undefined;

            try {
                (page as any).screencast.showOverlay(html, { duration: session.features.stepDuration })
                    .then((disposable: any) => {
                        if (this.sessions.get(page) === session && !session.lastStepOverlayDisposable) {
                            session.lastStepOverlayDisposable = disposable;
                        } else {
                            this.disposeQuiet(disposable);
                        }
                    })
                    .catch((e: any) => {
                        CSReporter.debug(`Screencast step overlay failed: ${e.message || e}`);
                    });
            } catch (e: any) {
                CSReporter.debug(`Screencast step overlay sync failed: ${e.message || e}`);
            }
        }
    }

    /**
     * Notify step end. Flashes PASS/FAIL badge if enabled.
     * Fire-and-forget.
     */
    public notifyStepEnd(
        page: Page,
        status: 'passed' | 'failed' | 'skipped'
    ): void {
        const session = this.sessions.get(page);
        if (!session) return;
        if (!session.features.showPassFailOverlay) return;
        if (status === 'skipped') return;

        const html = this.buildPassFailHTML(status);

        this.disposeQuiet(session.lastPassFailOverlayDisposable);
        session.lastPassFailOverlayDisposable = undefined;

        try {
            (page as any).screencast.showOverlay(html, { duration: session.features.passFailDuration })
                .then((disposable: any) => {
                    if (this.sessions.get(page) === session && !session.lastPassFailOverlayDisposable) {
                        session.lastPassFailOverlayDisposable = disposable;
                    } else {
                        this.disposeQuiet(disposable);
                    }
                })
                .catch((e: any) => {
                    CSReporter.debug(`Screencast pass/fail overlay failed: ${e.message || e}`);
                });
        } catch (e: any) {
            CSReporter.debug(`Screencast pass/fail overlay sync failed: ${e.message || e}`);
        }
    }

    /**
     * Show final scenario result overlay (centered PASSED/FAILED banner).
     * Called by CSBDDRunner at scenario completion.
     */
    public async showFinalResult(
        page: Page,
        status: 'passed' | 'failed'
    ): Promise<void> {
        const session = this.sessions.get(page);
        if (!session) {
            console.log('[SCREENCAST] showFinalResult: no session found');
            return;
        }
        if (!session.features.showFinalResult) {
            console.log('[SCREENCAST] showFinalResult: feature disabled');
            return;
        }

        const elapsed = Date.now() - session.startTime;
        const html = this.buildFinalResultHTML(status, session.scenarioName, elapsed);

        const finalDuration = this.config.getNumber('SCREENCAST_FINAL_RESULT_DURATION', 2500);
        try {
            console.log(`[SCREENCAST] Showing final result: ${status} for "${session.scenarioName}" (${finalDuration}ms)`);
            await (page as any).screencast.showOverlay(html, { duration: finalDuration });
            await new Promise(resolve => setTimeout(resolve, finalDuration));
            console.log('[SCREENCAST] Final result overlay SUCCESS');
        } catch (e: any) {
            console.error(`[SCREENCAST] Final result overlay FAILED: ${e.message || e}`);
        }
    }

    /**
     * Stop the per-scenario screencast. Cleans up all overlays and
     * finalises the .webm file. Returns the video path.
     */
    public async stopScreencast(page: Page): Promise<string | null> {
        const session = this.sessions.get(page);
        if (!session) return null;

        // Stop timestamp interval
        if (session.timestampInterval) {
            clearInterval(session.timestampInterval);
            session.timestampInterval = undefined;
        }

        // Dispose all lingering overlays and action annotations
        this.disposeQuiet((session as any).actionsDisposable);
        this.disposeQuiet(session.lastStepOverlayDisposable);
        this.disposeQuiet(session.lastPassFailOverlayDisposable);
        this.disposeQuiet(session.scenarioNameOverlayDisposable);
        this.disposeQuiet(session.timestampOverlayDisposable);

        try {
            await (page as any).screencast.stop();
            const elapsed = Date.now() - session.startTime;
            CSReporter.info(
                `Screencast stopped: "${session.scenarioName}" (${elapsed}ms) → ${path.basename(session.videoPath)}`
            );
            return session.videoPath;
        } catch (error: any) {
            CSReporter.warn(`Screencast stop failed for "${session.scenarioName}": ${error.message || error}`);
            return session.videoPath;
        } finally {
            this.sessions.delete(page);
        }
    }

    public getVideoPath(page: Page): string | null {
        const session = this.sessions.get(page);
        return session ? session.videoPath : null;
    }

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

    public getActiveSessionCount(): number {
        return this.sessions.size;
    }
}
