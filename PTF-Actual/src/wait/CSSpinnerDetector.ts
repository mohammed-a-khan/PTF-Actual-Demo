/**
 * CS Spinner Detector
 * Detects and waits for loading indicators to disappear
 * Thread-safe for parallel execution
 */

type Page = any;

export interface SpinnerDetectorOptions {
    selectors: string[];          // CSS selectors for spinners/loaders
    timeout: number;              // Maximum time to wait
    checkInterval: number;        // How often to check (ms)
    requireAllHidden: boolean;    // Wait for ALL spinners or just primary ones
}

const DEFAULT_OPTIONS: SpinnerDetectorOptions = {
    selectors: [
        '.spinner',
        '.loading',
        '.loader',
        '.ctsjv-loading',
        '[aria-busy="true"]',
        '[data-loading="true"]',
        '.MuiCircularProgress-root',
        '.ant-spin',
        '.el-loading-mask',
        'mat-spinner',
        '.sk-spinner',
        '.lds-ring',
        '.lds-dual-ring'
    ],
    timeout: 30000,
    checkInterval: 100,
    requireAllHidden: true
};

export class CSSpinnerDetector {
    private page: Page;
    private customSelectors: string[] = [];

    constructor(page: Page) {
        this.page = page;
    }

    /**
     * Add custom spinner selectors for this project
     */
    public addSelectors(selectors: string[]): void {
        this.customSelectors = [...new Set([...this.customSelectors, ...selectors])];
    }

    /**
     * Set custom spinner selectors (replaces defaults)
     */
    public setSelectors(selectors: string[]): void {
        this.customSelectors = selectors;
    }

    /**
     * Get all active selectors
     */
    public getSelectors(): string[] {
        return this.customSelectors.length > 0
            ? this.customSelectors
            : DEFAULT_OPTIONS.selectors;
    }

    /**
     * Check if any spinners are currently visible
     */
    public async hasVisibleSpinners(selectors?: string[]): Promise<boolean> {
        const selectorsToCheck = selectors || this.getSelectors();

        try {
            return await this.page.evaluate((sels: string[]) => {
                for (const selector of sels) {
                    try {
                        const elements = Array.from(document.querySelectorAll(selector));
                        for (const el of elements) {
                            const style = window.getComputedStyle(el);
                            const rect = el.getBoundingClientRect();

                            // Check if element is visible
                            const isVisible =
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                style.opacity !== '0' &&
                                rect.width > 0 &&
                                rect.height > 0;

                            if (isVisible) {
                                return true;
                            }
                        }
                    } catch {
                        // Invalid selector, skip
                    }
                }
                return false;
            }, selectorsToCheck);
        } catch {
            return false; // If evaluation fails, assume no spinners
        }
    }

    /**
     * Get count of visible spinners
     */
    public async getVisibleSpinnerCount(selectors?: string[]): Promise<number> {
        const selectorsToCheck = selectors || this.getSelectors();

        try {
            return await this.page.evaluate((sels: string[]) => {
                let count = 0;
                for (const selector of sels) {
                    try {
                        const elements = Array.from(document.querySelectorAll(selector));
                        for (const el of elements) {
                            const style = window.getComputedStyle(el);
                            const rect = el.getBoundingClientRect();

                            const isVisible =
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                style.opacity !== '0' &&
                                rect.width > 0 &&
                                rect.height > 0;

                            if (isVisible) count++;
                        }
                    } catch {
                        // Invalid selector, skip
                    }
                }
                return count;
            }, selectorsToCheck);
        } catch {
            return 0;
        }
    }

    /**
     * Wait for all spinners to disappear
     */
    public async waitForSpinnersToDisappear(
        options: Partial<SpinnerDetectorOptions> = {}
    ): Promise<boolean> {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const selectors = opts.selectors.length > 0 ? opts.selectors : this.getSelectors();

        const startTime = Date.now();

        // Quick check first - if no spinners, return immediately
        if (!(await this.hasVisibleSpinners(selectors))) {
            return true;
        }

        // Poll until spinners disappear or timeout
        while (Date.now() - startTime < opts.timeout) {
            await this.page.waitForTimeout(opts.checkInterval);

            if (!(await this.hasVisibleSpinners(selectors))) {
                // Double-check after a brief delay to ensure stability
                await this.page.waitForTimeout(50);
                if (!(await this.hasVisibleSpinners(selectors))) {
                    return true;
                }
            }
        }

        return false; // Timeout but don't fail - just proceed
    }

    /**
     * Wait for spinners with early exit on page navigation
     */
    public async waitForSpinnersSafe(
        timeout: number = 30000
    ): Promise<boolean> {
        try {
            return await Promise.race([
                this.waitForSpinnersToDisappear({ timeout }),
                this.page.waitForNavigation({ timeout, waitUntil: 'commit' })
                    .then(() => true)
                    .catch(() => true)
            ]);
        } catch {
            return true; // Proceed even on error
        }
    }

    /**
     * Wait for a specific spinner element to disappear
     */
    public async waitForSpinnerToDisappear(
        selector: string,
        timeout: number = 30000
    ): Promise<boolean> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const isVisible = await this.page.evaluate((sel: string) => {
                    const el = document.querySelector(sel);
                    if (!el) return false;

                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();

                    return (
                        style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        style.opacity !== '0' &&
                        rect.width > 0 &&
                        rect.height > 0
                    );
                }, selector);

                if (!isVisible) {
                    return true;
                }
            } catch {
                return true; // Element not found or error - proceed
            }

            await this.page.waitForTimeout(100);
        }

        return false;
    }
}

export default CSSpinnerDetector;
