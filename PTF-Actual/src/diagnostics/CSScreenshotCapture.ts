/**
 * CSScreenshotCapture - robust screenshot capture for failure paths.
 *
 * Solves three problems that affect default page.screenshot() calls:
 * 1. Pages mid-navigation (e.g. waiting for a 502 Bad Gateway error page) cause
 *    page.screenshot() to hang on Playwright's default 30s timeout
 * 2. No fallback strategy: first error throws to caller
 * 3. Silent failure mode: callers logged at debug level so users couldn't tell
 *    why a screenshot was missing
 *
 * Design:
 * - Best-effort window.stop() before capture (aborts in-flight loads)
 * - 3 escalating strategies with explicit short timeouts
 * - Returns a discriminated result object - caller decides logging level
 *
 * Parallel-safe: pure static, no instance state, no module-level state.
 */

import { CSReporter } from '../reporter/CSReporter';

type Page = any;

export interface CaptureSafeOptions {
    /** Full page screenshot (default false) */
    fullPage?: boolean;
    /** Per-attempt timeout in ms (default 5000) - only applies to first strategy */
    maxAttemptMs?: number;
    /** Run window.stop() before capture (default true) */
    stopNavigation?: boolean;
    /** Output mode: 'file' writes to path, 'buffer' returns Buffer (default 'file') */
    mode?: 'file' | 'buffer';
    /** Optional animations override (default 'disabled') */
    animations?: 'disabled' | 'allow';
}

export type CaptureSafeResult =
    | { ok: true; mode: 'file'; path: string }
    | { ok: true; mode: 'buffer'; buffer: Buffer }
    | { ok: false; reason: string; lastError?: any };

export class CSScreenshotCapture {
    /**
     * Capture a screenshot with multi-strategy fallback. Will not hang on a
     * page mid-navigation. Will not throw - returns a result object instead.
     *
     * @param page - Playwright Page (caller is responsible for resolving the active page)
     * @param path - File path when mode='file' (ignored when mode='buffer')
     * @param options - Capture options
     */
    public static async captureSafe(
        page: Page,
        path: string | undefined,
        options: CaptureSafeOptions = {}
    ): Promise<CaptureSafeResult> {
        // 1. Validate page state
        if (!page) {
            return { ok: false, reason: 'page-undefined' };
        }
        try {
            if (page.isClosed && page.isClosed()) {
                return { ok: false, reason: 'page-closed' };
            }
        } catch {
            return { ok: false, reason: 'page-state-unreadable' };
        }

        // 2. Best-effort: stop any in-flight navigation. NEVER allow this to throw.
        if (options.stopNavigation !== false) {
            try {
                await page.evaluate(() => { try { window.stop(); } catch { /* swallow */ } });
            } catch { /* page may be navigating, evaluate may reject - fine */ }
        }

        // 3. Escalating strategies
        const animations = options.animations ?? 'disabled';
        const maxAttemptMs = options.maxAttemptMs ?? 5000;
        const fullPage = options.fullPage ?? false;
        const mode = options.mode ?? 'file';

        const strategies: Array<{ fullPage: boolean; timeout: number; clip?: any; label: string }> = [
            { fullPage, timeout: maxAttemptMs, label: 'primary' },
            { fullPage: false, timeout: 2000, label: 'viewport-2s' },
            { fullPage: false, timeout: 1000, clip: { x: 0, y: 0, width: 1280, height: 720 }, label: 'clipped-1s' }
        ];

        let lastError: any;
        for (const strat of strategies) {
            try {
                const shotOpts: any = {
                    fullPage: strat.fullPage,
                    timeout: strat.timeout,
                    animations,
                };
                if (strat.clip) shotOpts.clip = strat.clip;

                if (mode === 'buffer') {
                    const buffer = await page.screenshot(shotOpts);
                    return { ok: true, mode: 'buffer', buffer };
                } else {
                    if (!path) {
                        return { ok: false, reason: 'path-required-for-file-mode' };
                    }
                    await page.screenshot({ ...shotOpts, path });
                    return { ok: true, mode: 'file', path };
                }
            } catch (e: any) {
                lastError = e;
                CSReporter.debug(
                    `[CSScreenshotCapture] strategy "${strat.label}" failed: ${e?.message ?? e}`
                );
            }
        }

        return {
            ok: false,
            reason: `all 3 strategies failed: ${lastError?.message ?? lastError}`,
            lastError,
        };
    }
}
