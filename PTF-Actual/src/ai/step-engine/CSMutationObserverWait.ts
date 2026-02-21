/**
 * CSMutationObserverWait - DOM Stability Detection via MutationObserver
 *
 * Injects MutationObserver via page.evaluate() to detect true DOM stability.
 * Monitors: DOM mutation count, animation frames, element geometry.
 * Replaces timeout-based waits with real stability detection.
 *
 * Zero external dependencies — pure Playwright page.evaluate() JavaScript injection.
 *
 * @module ai/step-engine
 */

import { Page, Frame } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';

/** Options for waiting for DOM stability */
export interface DOMStabilityOptions {
    /** Maximum time to wait for stability in ms (default: 5000) */
    timeout?: number;
    /** Duration of stability required before resolving in ms (default: 300) */
    stableDuration?: number;
    /** Whether to also wait for network idle (default: false) */
    waitForNetworkIdle?: boolean;
    /** Whether to check animation frames (default: true) */
    checkAnimations?: boolean;
}

/** Result of a stability wait */
export interface StabilityResult {
    /** Whether the DOM stabilized within timeout */
    stable: boolean;
    /** Time taken to stabilize in ms */
    duration: number;
    /** Total mutations observed */
    mutationCount: number;
    /** Whether timeout was hit */
    timedOut: boolean;
}

export class CSMutationObserverWait {
    private static instance: CSMutationObserverWait;

    private constructor() {}

    public static getInstance(): CSMutationObserverWait {
        if (!CSMutationObserverWait.instance) {
            CSMutationObserverWait.instance = new CSMutationObserverWait();
        }
        return CSMutationObserverWait.instance;
    }

    /**
     * Wait for the DOM to stabilize using MutationObserver.
     * Resolves when no mutations have occurred for `stableDuration` ms,
     * or rejects after `timeout` ms.
     *
     * @param page - Playwright Page or Frame
     * @param options - Stability detection options
     * @returns StabilityResult with details about the wait
     */
    public async waitForDOMStability(
        page: Page | Frame,
        options: DOMStabilityOptions = {}
    ): Promise<StabilityResult> {
        const {
            timeout = 5000,
            stableDuration = 300,
            checkAnimations = true
        } = options;

        const startTime = Date.now();

        try {
            const result = await page.evaluate(
                ({ timeout, stableDuration, checkAnimations }) => {
                    return new Promise<{ stable: boolean; mutationCount: number; timedOut: boolean }>((resolve) => {
                        let mutationCount = 0;
                        let lastMutationTime = Date.now();
                        let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
                        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
                        let rafId: number | null = null;
                        let lastFrameRect: string | null = null;

                        const cleanup = () => {
                            observer.disconnect();
                            if (stabilityTimer) clearTimeout(stabilityTimer);
                            if (timeoutTimer) clearTimeout(timeoutTimer);
                            if (rafId) cancelAnimationFrame(rafId);
                        };

                        const checkStability = () => {
                            if (stabilityTimer) clearTimeout(stabilityTimer);
                            stabilityTimer = setTimeout(() => {
                                cleanup();
                                resolve({ stable: true, mutationCount, timedOut: false });
                            }, stableDuration);
                        };

                        // MutationObserver for DOM changes
                        const observer = new MutationObserver((mutations) => {
                            // Filter out mutations that are just our own observation
                            const significantMutations = mutations.filter(m => {
                                // Ignore attribute changes on the html/body that are from scripts
                                if (m.type === 'attributes' && m.target === document.documentElement) return false;
                                return true;
                            });

                            if (significantMutations.length > 0) {
                                mutationCount += significantMutations.length;
                                lastMutationTime = Date.now();
                                checkStability();
                            }
                        });

                        observer.observe(document.body || document.documentElement, {
                            childList: true,
                            subtree: true,
                            attributes: true,
                            characterData: true
                        });

                        // Animation frame monitoring (detect visual changes)
                        if (checkAnimations) {
                            const checkFrame = () => {
                                // Check if any element geometry is changing by sampling body dimensions
                                const rect = document.body?.getBoundingClientRect();
                                const currentRect = rect ? `${rect.width},${rect.height},${rect.top},${rect.left}` : '';
                                if (lastFrameRect !== null && lastFrameRect !== currentRect) {
                                    lastMutationTime = Date.now();
                                    checkStability();
                                }
                                lastFrameRect = currentRect;
                                rafId = requestAnimationFrame(checkFrame);
                            };
                            rafId = requestAnimationFrame(checkFrame);
                        }

                        // Timeout guard
                        timeoutTimer = setTimeout(() => {
                            cleanup();
                            resolve({ stable: false, mutationCount, timedOut: true });
                        }, timeout);

                        // Start the stability check
                        checkStability();
                    });
                },
                { timeout, stableDuration, checkAnimations }
            );

            const duration = Date.now() - startTime;

            if (result.stable) {
                CSReporter.debug(`CSMutationObserverWait: DOM stabilized in ${duration}ms (${result.mutationCount} mutations observed)`);
            } else {
                CSReporter.debug(`CSMutationObserverWait: DOM did not stabilize within ${timeout}ms (${result.mutationCount} mutations observed)`);
            }

            // Optionally wait for network idle too
            if (options.waitForNetworkIdle) {
                try {
                    const pageObj = 'waitForLoadState' in page ? page : null;
                    if (pageObj) {
                        await (pageObj as Page).waitForLoadState('networkidle', { timeout: 2000 });
                    }
                } catch {
                    // Non-critical — network idle timeout is acceptable
                }
            }

            return {
                stable: result.stable,
                duration,
                mutationCount: result.mutationCount,
                timedOut: result.timedOut
            };
        } catch (error: any) {
            const duration = Date.now() - startTime;
            CSReporter.debug(`CSMutationObserverWait: Stability check failed (${duration}ms): ${error.message}`);
            return {
                stable: false,
                duration,
                mutationCount: 0,
                timedOut: true
            };
        }
    }

    /**
     * Wait for a specific element to become visually stable.
     * Monitors the element's bounding rect until it stops changing.
     *
     * @param page - Playwright Page or Frame
     * @param selector - CSS selector of the element to watch
     * @param options - Stability options
     * @returns Whether the element stabilized
     */
    public async waitForElementStability(
        page: Page | Frame,
        selector: string,
        options: DOMStabilityOptions = {}
    ): Promise<boolean> {
        const { timeout = 3000, stableDuration = 200 } = options;

        try {
            const stable = await page.evaluate(
                ({ selector, timeout, stableDuration }) => {
                    return new Promise<boolean>((resolve) => {
                        const el = document.querySelector(selector);
                        if (!el) {
                            resolve(true); // Element not found — no instability to wait for
                            return;
                        }

                        let lastRect = '';
                        let stableTimer: ReturnType<typeof setTimeout> | null = null;
                        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

                        const check = () => {
                            const rect = el.getBoundingClientRect();
                            const currentRect = `${rect.x},${rect.y},${rect.width},${rect.height}`;

                            if (currentRect !== lastRect) {
                                lastRect = currentRect;
                                if (stableTimer) clearTimeout(stableTimer);
                                stableTimer = setTimeout(() => {
                                    if (timeoutTimer) clearTimeout(timeoutTimer);
                                    resolve(true);
                                }, stableDuration);
                            }

                            requestAnimationFrame(check);
                        };

                        timeoutTimer = setTimeout(() => {
                            resolve(false);
                        }, timeout);

                        requestAnimationFrame(check);
                    });
                },
                { selector, timeout, stableDuration }
            );

            return stable;
        } catch {
            return true; // On error, don't block execution
        }
    }

    /**
     * Wait for any active spinners/loading indicators to disappear.
     * Searches for common spinner patterns in the DOM.
     *
     * @param page - Playwright Page or Frame
     * @param timeout - Max wait time in ms
     * @returns Whether spinners cleared
     */
    public async waitForSpinnersCleared(
        page: Page | Frame,
        timeout: number = 5000
    ): Promise<boolean> {
        try {
            const cleared = await page.evaluate((timeout) => {
                return new Promise<boolean>((resolve) => {
                    const spinnerSelectors = [
                        '.spinner', '.loading', '.loader', '.progress',
                        '[class*="spinner"]', '[class*="loading"]', '[class*="loader"]',
                        '[role="progressbar"]', '[aria-busy="true"]',
                        '.MuiCircularProgress-root', '.ant-spin',
                        '.el-loading-mask', '.v-progress-circular',
                        // Dynamics 365 / Power Apps specific
                        '.ms-Spinner', '.donut-spinner', '[class*="ProgressIndicator"]'
                    ];

                    const check = () => {
                        const spinners = spinnerSelectors.some(sel => {
                            try {
                                const els = document.querySelectorAll(sel);
                                return Array.from(els).some(el => {
                                    const style = window.getComputedStyle(el);
                                    return style.display !== 'none' &&
                                           style.visibility !== 'hidden' &&
                                           style.opacity !== '0';
                                });
                            } catch {
                                return false;
                            }
                        });
                        return !spinners;
                    };

                    if (check()) {
                        resolve(true);
                        return;
                    }

                    const startTime = Date.now();
                    const interval = setInterval(() => {
                        if (check() || Date.now() - startTime > timeout) {
                            clearInterval(interval);
                            resolve(check());
                        }
                    }, 100);
                });
            }, timeout);

            if (!cleared) {
                CSReporter.debug('CSMutationObserverWait: Spinners still present after timeout');
            }
            return cleared;
        } catch {
            return true; // On error, don't block
        }
    }
}
