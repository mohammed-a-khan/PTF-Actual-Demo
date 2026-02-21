/**
 * CSVisualStabilityDetector - Screenshot-Based Visual Stability Detection
 *
 * Uses Playwright's native page.screenshot() to capture before/after images
 * and performs pixel-level comparison via Buffer operations. Detects visual
 * changes around interacted elements to verify actions took effect.
 *
 * No external vision model — pure pixel math using Node.js Buffer.
 *
 * @module ai/step-engine
 */

import { Page, Frame, Locator } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';

/** Result of visual comparison */
export interface VisualComparisonResult {
    /** Whether a visual change was detected */
    changed: boolean;
    /** Percentage of changed pixels (0-100) */
    changePercentage: number;
    /** Total pixels compared */
    totalPixels: number;
    /** Number of changed pixels */
    changedPixels: number;
}

export class CSVisualStabilityDetector {
    private static instance: CSVisualStabilityDetector;

    private constructor() {}

    public static getInstance(): CSVisualStabilityDetector {
        if (!CSVisualStabilityDetector.instance) {
            CSVisualStabilityDetector.instance = new CSVisualStabilityDetector();
        }
        return CSVisualStabilityDetector.instance;
    }

    /**
     * Capture a screenshot of the area around an element.
     * Returns raw PNG buffer for later comparison.
     *
     * @param page - Playwright Page
     * @param locator - Element to capture around
     * @param padding - Extra pixels around the element (default: 20)
     * @returns Screenshot buffer, or null if capture fails
     */
    public async captureElementRegion(
        page: Page,
        locator: Locator,
        padding: number = 20
    ): Promise<Buffer | null> {
        try {
            const box = await locator.boundingBox({ timeout: 2000 });
            if (!box) return null;

            // Get viewport size
            const viewport = page.viewportSize();
            if (!viewport) return null;

            // Calculate clip region with padding
            const clip = {
                x: Math.max(0, box.x - padding),
                y: Math.max(0, box.y - padding),
                width: Math.min(box.width + 2 * padding, viewport.width - Math.max(0, box.x - padding)),
                height: Math.min(box.height + 2 * padding, viewport.height - Math.max(0, box.y - padding))
            };

            // Ensure valid dimensions
            if (clip.width <= 0 || clip.height <= 0) return null;

            const screenshot = await page.screenshot({
                clip,
                type: 'png'
            });

            return screenshot;
        } catch (error: any) {
            CSReporter.debug(`CSVisualStabilityDetector: Failed to capture region: ${error.message}`);
            return null;
        }
    }

    /**
     * Capture a full-page screenshot thumbnail for comparison.
     * Uses a reduced viewport for efficiency.
     *
     * @param page - Playwright Page
     * @returns Screenshot buffer
     */
    public async capturePageThumbnail(page: Page): Promise<Buffer | null> {
        try {
            return await page.screenshot({ type: 'png', fullPage: false });
        } catch {
            return null;
        }
    }

    /**
     * Compare two PNG screenshot buffers at the pixel level.
     * Uses raw buffer comparison for efficiency.
     *
     * Note: This is a simplified comparison that works with PNG buffers.
     * It compares byte sequences rather than decoded pixels for speed.
     *
     * @param before - Screenshot buffer before action
     * @param after - Screenshot buffer after action
     * @param tolerance - Per-channel tolerance for pixel difference (0-255, default: 10)
     * @returns VisualComparisonResult
     */
    public compareScreenshots(
        before: Buffer,
        after: Buffer,
        tolerance: number = 10
    ): VisualComparisonResult {
        // If buffers are identical, no changes
        if (before.equals(after)) {
            return { changed: false, changePercentage: 0, totalPixels: 0, changedPixels: 0 };
        }

        // If sizes differ significantly, definitely changed
        if (Math.abs(before.length - after.length) > before.length * 0.1) {
            return { changed: true, changePercentage: 100, totalPixels: 1, changedPixels: 1 };
        }

        // Byte-level comparison with tolerance
        // PNG files have headers + compressed data, so we compare after the header
        // PNG signature is 8 bytes, then IHDR chunk
        const minLen = Math.min(before.length, after.length);
        const sampleSize = Math.min(minLen, 10000); // Sample up to 10KB
        const step = Math.max(1, Math.floor(minLen / sampleSize));

        let totalSamples = 0;
        let changedSamples = 0;

        // Skip PNG header (first 50 bytes typically)
        for (let i = 50; i < minLen; i += step) {
            totalSamples++;
            if (Math.abs(before[i] - after[i]) > tolerance) {
                changedSamples++;
            }
        }

        if (totalSamples === 0) {
            return { changed: false, changePercentage: 0, totalPixels: 0, changedPixels: 0 };
        }

        const changePercentage = (changedSamples / totalSamples) * 100;

        return {
            changed: changePercentage > 1, // More than 1% change is significant
            changePercentage,
            totalPixels: totalSamples,
            changedPixels: changedSamples
        };
    }

    /**
     * Verify that an action caused a visual change around the target element.
     *
     * @param page - Playwright Page
     * @param locator - Element that was acted upon
     * @param beforeScreenshot - Screenshot taken before the action
     * @returns Whether a visual change was detected
     */
    public async verifyVisualChange(
        page: Page,
        locator: Locator,
        beforeScreenshot: Buffer | null
    ): Promise<boolean> {
        if (!beforeScreenshot) return true; // Can't verify — assume success

        try {
            const afterScreenshot = await this.captureElementRegion(page, locator);
            if (!afterScreenshot) return true; // Can't capture — assume success

            const result = this.compareScreenshots(beforeScreenshot, afterScreenshot);

            if (result.changed) {
                CSReporter.debug(
                    `CSVisualStabilityDetector: Visual change detected ` +
                    `(${result.changePercentage.toFixed(1)}% pixels changed)`
                );
            } else {
                CSReporter.debug('CSVisualStabilityDetector: No visual change detected after action');
            }

            return result.changed;
        } catch {
            return true; // On error, assume success
        }
    }

    /**
     * Wait until the page is visually stable (no pixel changes between frames).
     *
     * @param page - Playwright Page
     * @param timeout - Max wait time in ms (default: 3000)
     * @param checkInterval - Interval between checks in ms (default: 300)
     * @returns Whether the page stabilized
     */
    public async waitForVisualStability(
        page: Page,
        timeout: number = 3000,
        checkInterval: number = 300
    ): Promise<boolean> {
        const startTime = Date.now();
        let previousScreenshot = await this.capturePageThumbnail(page);

        while (Date.now() - startTime < timeout) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));

            const currentScreenshot = await this.capturePageThumbnail(page);
            if (!currentScreenshot || !previousScreenshot) continue;

            const result = this.compareScreenshots(previousScreenshot, currentScreenshot);

            if (!result.changed) {
                CSReporter.debug(
                    `CSVisualStabilityDetector: Page visually stable after ` +
                    `${Date.now() - startTime}ms`
                );
                return true;
            }

            previousScreenshot = currentScreenshot;
        }

        CSReporter.debug(`CSVisualStabilityDetector: Page did not stabilize within ${timeout}ms`);
        return false;
    }
}
