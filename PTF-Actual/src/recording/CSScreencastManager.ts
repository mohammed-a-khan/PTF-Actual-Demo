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

interface ScreencastSession {
    page: Page;
    scenarioName: string;
    videoPath: string;
    startTime: number;
    actionsDisposable?: any;       // returned by page.screencast.start() with annotate
    totalSteps?: number;
    // Disposables returned by page.screencast.showOverlay() — kept so we
    // can dispose the PREVIOUS step badge / pass-fail badge when the next
    // one is about to render. Without this, two consecutive overlays
    // overlap each other on the recording until the first one's
    // duration expires.
    lastStepOverlayDisposable?: any;
    lastPassFailOverlayDisposable?: any;
}

/**
 * CSScreencastManager — real Playwright 1.59+ screencast integration
 *
 * Uses the native `page.screencast` API (introduced in Playwright 1.59) to
 * record per-scenario videos with **step + action overlays burned directly
 * into the video frames** by Playwright itself. Replaces the old approach
 * of writing `.vtt` sidecar text files alongside the single context-level
 * recording (which never actually rendered captions on screen).
 *
 * Per scenario, the lifecycle is:
 *
 *   1. CSBDDRunner.executeScenario() calls startScreencast(page, scenarioName)
 *      which calls page.screencast.start({
 *          path: '<scenario>.webm',
 *          annotate: { position: 'top-right', fontSize: 16 }
 *      }).
 *      Playwright then auto-overlays every Playwright action (click, fill,
 *      navigate, hover, etc) on the recording as text in the top-right
 *      corner. Zero extra work from us.
 *
 *   2. CSBDDRunner.executeStep() calls notifyStepStart(page, ...) at the
 *      start of each step which calls page.screencast.showChapter(
 *          'Step N/M',
 *          { description: '<keyword> <text>', duration: 1500 }
 *      ).
 *      Playwright renders a centered overlay with the step text + chapter
 *      number for 1.5 seconds. The chapter is part of the video — no
 *      sidecar file needed.
 *
 *   3. CSBDDRunner.executeStep() calls notifyStepEnd(page, status) on
 *      step pass/fail which calls page.screencast.showOverlay(...) with a
 *      green PASS or red FAIL HTML banner for 800ms.
 *
 *   4. CSBDDRunner.executeScenario() calls stopScreencast(page) at scenario
 *      end which calls page.screencast.stop() — Playwright finalises the
 *      .webm file with all overlays already rendered into the frames.
 *
 * Result: one .webm per scenario, stored at
 *      <test-results>/videos/<scenarioName>.webm
 * with action + step + pass/fail overlays burned in. The HTML report's
 * annotated player just embeds a regular <video> element pointing at it.
 *
 * Configuration flags:
 *   SCREENCAST_ENABLED              (default false) — opt in to the feature
 *   SCREENCAST_ANNOTATE_ACTIONS     (default true)  — annotate clicks/fills
 *   SCREENCAST_CHAPTER_PER_STEP     (default true)  — show step chapters
 *   SCREENCAST_PASS_FAIL_OVERLAY    (default true)  — flash PASS/FAIL banner
 *   SCREENCAST_DIR                  (default '<results>/videos')
 *   SCREENCAST_QUALITY              (default 80)
 *   SCREENCAST_ACTION_FONT_SIZE     (default 16)
 *   SCREENCAST_ACTION_POSITION      (default 'top-right')
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
     * Dispose any of the three Disposable shapes Playwright might return
     * from showOverlay():
     *   - a function (call it)
     *   - an object with `.dispose()` (call .dispose())
     *   - an object with `[Symbol.dispose]()` (TS 5.2+ "using" pattern)
     * Silent on failures — the goal is best-effort cleanup of a previous
     * overlay before showing a new one.
     */
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

    /**
     * Sanitise a scenario name into a safe filename component.
     * Mirrors the existing convention used in CSStepTimeline:
     *      [^a-zA-Z0-9] → '-', max 50 chars.
     */
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

    /**
     * Best-effort feature detection: returns true when the installed
     * Playwright build exposes the page.screencast object with start().
     * Playwright 1.59+ has it, older builds don't.
     */
    private hasScreencastAPI(page: Page): boolean {
        const sc = (page as any).screencast;
        return sc && typeof sc === 'object' && typeof sc.start === 'function';
    }

    /**
     * Start a per-scenario screencast. Called by CSBDDRunner at scenario
     * start. No-op if SCREENCAST_ENABLED=false or the installed Playwright
     * is too old.
     */
    public async startScreencast(
        page: Page,
        scenarioName: string,
        options?: ScreencastOptions
    ): Promise<void> {
        if (!this.isEnabled()) {
            return;
        }
        if (!this.hasScreencastAPI(page)) {
            CSReporter.debug(
                'Screencast: page.screencast API not available (requires Playwright 1.59+) — skipping'
            );
            return;
        }
        if (this.sessions.has(page)) {
            // Defensive: a previous scenario didn't stop cleanly
            await this.stopScreencast(page);
        }

        const outputDir = this.getOutputDir(options);
        const safeName = this.sanitizeName(scenarioName);
        const videoPath = path.join(outputDir, `${safeName}.webm`);

        // Build the start() options.
        // - path: per-scenario .webm output
        // - annotate: when enabled, Playwright auto-overlays every action
        //   (click/fill/hover/navigate/etc) on the recording itself
        const startOptions: any = { path: videoPath };
        if (this.config.getBoolean('SCREENCAST_ANNOTATE_ACTIONS', true)) {
            startOptions.annotate = {
                position: this.config.get('SCREENCAST_ACTION_POSITION', 'top-right'),
                fontSize: this.config.getNumber('SCREENCAST_ACTION_FONT_SIZE', 16),
                duration: this.config.getNumber('SCREENCAST_ACTION_DURATION', 700),
            };
        }
        if (options?.width && options?.height) {
            startOptions.size = { width: options.width, height: options.height };
        }
        const quality = options?.quality || this.config.getNumber('SCREENCAST_QUALITY', 0);
        if (quality > 0) {
            startOptions.quality = quality;
        }

        try {
            await (page as any).screencast.start(startOptions);
            const session: ScreencastSession = {
                page,
                scenarioName,
                videoPath,
                startTime: Date.now(),
            };
            this.sessions.set(page, session);
            CSReporter.info(
                `Screencast started for scenario "${scenarioName}" → ${path.basename(videoPath)}`
            );
        } catch (error: any) {
            CSReporter.warn(
                `Screencast start failed for "${scenarioName}": ${error.message || error}`
            );
        }
    }

    /**
     * Notify the screencast that a step is starting. Renders a small
     * "Step N/M — <keyword> <text>" badge in the top-LEFT corner of the
     * recording for ~1.5s. Uses showOverlay (not showChapter) so the
     * overlay is a non-blocking corner badge instead of a centered
     * blurred-backdrop modal — critical because `showChapter` would
     * intercept clicks and slow down the test.
     *
     * Fire-and-forget — does NOT await the overlay promise so it adds
     * zero blocking latency to step execution. Errors are swallowed
     * silently via .catch().
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
        if (!this.config.getBoolean('SCREENCAST_CHAPTER_PER_STEP', true)) return;

        const title = totalSteps > 0
            ? `Step ${stepNumber}/${totalSteps}`
            : `Step ${stepNumber}`;
        const description = `${keyword.trim()} ${text}`.trim();
        const duration = this.config.getNumber('SCREENCAST_CHAPTER_DURATION', 1500);

        // Truncate long step text so the badge stays compact in the
        // recording — full step text already lives in the report's step
        // table, the video is just for visual context.
        const maxLen = 80;
        const truncated = description.length > maxLen
            ? description.substring(0, maxLen - 1) + '…'
            : description;

        const html = `
            <div style="
                position: fixed; top: 16px; left: 16px;
                max-width: 60vw;
                padding: 8px 14px;
                background: rgba(15, 23, 42, 0.92); color: #e2e8f0;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                font-size: 14px; font-weight: 500;
                border-radius: 6px;
                border-left: 4px solid #38bdf8;
                box-shadow: 0 4px 12px rgba(0,0,0,0.35);
                z-index: 2147483647;
                pointer-events: none;
                user-select: none;
            ">
                <div style="font-size: 11px; color: #94a3b8; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 2px;">${title}</div>
                <div>${truncated}</div>
            </div>`;

        // Dispose the PREVIOUS step badge synchronously so it doesn't
        // overlap with the new one. This is fast (just calls .dispose()
        // on the cached Disposable) and guarantees badges replace each
        // other instead of stacking up.
        this.disposeQuiet(session.lastStepOverlayDisposable);
        session.lastStepOverlayDisposable = undefined;

        // Fire-and-forget — don't await. Capture the resulting Disposable
        // on the session when it eventually resolves so the NEXT step can
        // dispose it.
        try {
            (page as any).screencast.showOverlay(html, { duration })
                .then((disposable: any) => {
                    // Only store if the session is still alive AND no
                    // newer overlay has already been shown (which would
                    // have set a different disposable).
                    if (this.sessions.get(page) === session
                        && !session.lastStepOverlayDisposable) {
                        session.lastStepOverlayDisposable = disposable;
                    } else {
                        // A newer overlay or a session swap happened —
                        // dispose this stale one so it doesn't linger.
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

    /**
     * Notify the screencast that a step finished. Flashes a small
     * green PASS / red FAIL badge in the top-RIGHT corner of the
     * recording for ~800ms.
     *
     * Fire-and-forget — does NOT await the overlay promise so it adds
     * zero blocking latency to step execution.
     */
    public notifyStepEnd(
        page: Page,
        status: 'passed' | 'failed' | 'skipped'
    ): void {
        const session = this.sessions.get(page);
        if (!session) return;
        if (!this.config.getBoolean('SCREENCAST_PASS_FAIL_OVERLAY', true)) return;
        if (status === 'skipped') return;

        const duration = this.config.getNumber('SCREENCAST_OVERLAY_DURATION', 800);
        const isPass = status === 'passed';
        const bg = isPass ? '#16a34a' : '#dc2626';
        const icon = isPass ? '✓' : '✗';
        const label = isPass ? 'PASS' : 'FAIL';
        const html = `
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

        // Dispose the PREVIOUS pass/fail badge synchronously
        this.disposeQuiet(session.lastPassFailOverlayDisposable);
        session.lastPassFailOverlayDisposable = undefined;

        // Fire-and-forget, capture new Disposable for the next step
        try {
            (page as any).screencast.showOverlay(html, { duration })
                .then((disposable: any) => {
                    if (this.sessions.get(page) === session
                        && !session.lastPassFailOverlayDisposable) {
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
     * Stop the per-scenario screencast and finalise the .webm file.
     * Returns the path to the saved video, or null if no session was
     * active for this page.
     */
    public async stopScreencast(page: Page): Promise<string | null> {
        const session = this.sessions.get(page);
        if (!session) return null;

        // Dispose any lingering badges so the final frames of the .webm
        // don't have a stale step or pass/fail overlay still on screen.
        this.disposeQuiet(session.lastStepOverlayDisposable);
        this.disposeQuiet(session.lastPassFailOverlayDisposable);
        session.lastStepOverlayDisposable = undefined;
        session.lastPassFailOverlayDisposable = undefined;

        try {
            await (page as any).screencast.stop();
            const elapsed = Date.now() - session.startTime;
            CSReporter.info(
                `Screencast stopped: "${session.scenarioName}" (${elapsed}ms) → ${path.basename(session.videoPath)}`
            );
            return session.videoPath;
        } catch (error: any) {
            CSReporter.warn(
                `Screencast stop failed for "${session.scenarioName}": ${error.message || error}`
            );
            return session.videoPath; // Return path even if stop had issues — Playwright may still flush
        } finally {
            this.sessions.delete(page);
        }
    }

    /**
     * Get the saved video path for a scenario (after stopScreencast).
     * Used by the runner to attach the video to the scenario's artifact list.
     */
    public getVideoPath(page: Page): string | null {
        const session = this.sessions.get(page);
        return session ? session.videoPath : null;
    }

    /**
     * Stop all active screencast sessions. Called on test-suite shutdown
     * to make sure no .webm file is left half-written.
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

    /**
     * Number of currently-active screencast sessions.
     */
    public getActiveSessionCount(): number {
        return this.sessions.size;
    }
}
