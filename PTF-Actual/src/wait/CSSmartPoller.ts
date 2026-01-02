/**
 * CS Smart Poller
 * Unified polling utility with configurable strategies
 * Replaces multiple custom polling implementations
 * Thread-safe for parallel execution
 */

type Page = any;

export type BackoffStrategy = 'none' | 'linear' | 'exponential' | 'fibonacci';

export interface SmartPollOptions {
    condition: () => Promise<boolean>;  // Condition to check
    timeout: number;                     // Maximum time to wait
    interval: number;                    // Base interval between checks
    backoff: BackoffStrategy;            // Backoff strategy
    maxInterval: number;                 // Maximum interval when using backoff
    message: string;                     // Description for logging
    throwOnTimeout: boolean;             // Throw error on timeout
    onProgress?: (attempt: number, elapsed: number) => void;  // Progress callback
}

export interface PollResult {
    success: boolean;
    attempts: number;
    elapsed: number;
    timedOut: boolean;
}

const DEFAULT_OPTIONS: Omit<SmartPollOptions, 'condition'> = {
    timeout: 10000,
    interval: 200,
    backoff: 'none',
    maxInterval: 5000,
    message: 'Waiting for condition',
    throwOnTimeout: false
};

export class CSSmartPoller {
    private page: Page | null;

    constructor(page?: Page) {
        this.page = page || null;
    }

    /**
     * Calculate next interval based on backoff strategy
     */
    private calculateInterval(
        attempt: number,
        baseInterval: number,
        maxInterval: number,
        strategy: BackoffStrategy
    ): number {
        let interval: number;

        switch (strategy) {
            case 'exponential':
                interval = baseInterval * Math.pow(2, attempt - 1);
                break;

            case 'linear':
                interval = baseInterval * attempt;
                break;

            case 'fibonacci':
                interval = baseInterval * this.fibonacci(attempt);
                break;

            case 'none':
            default:
                interval = baseInterval;
                break;
        }

        return Math.min(interval, maxInterval);
    }

    private fibonacci(n: number): number {
        if (n <= 1) return 1;
        if (n === 2) return 1;

        let prev = 1, curr = 1;
        for (let i = 3; i <= n; i++) {
            const next = prev + curr;
            prev = curr;
            curr = next;
        }
        return curr;
    }

    /**
     * Wait with short delay - uses page if available, otherwise setTimeout
     */
    private async wait(ms: number): Promise<void> {
        if (this.page) {
            try {
                await this.page.waitForTimeout(ms);
            } catch {
                // Fallback to native timeout if page context lost
                await new Promise(resolve => setTimeout(resolve, ms));
            }
        } else {
            await new Promise(resolve => setTimeout(resolve, ms));
        }
    }

    /**
     * Main polling method
     */
    public async poll(options: Partial<SmartPollOptions> & { condition: () => Promise<boolean> }): Promise<PollResult> {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const startTime = Date.now();
        let attempt = 0;

        while (true) {
            attempt++;
            const elapsed = Date.now() - startTime;

            // Check timeout
            if (elapsed >= opts.timeout) {
                const result: PollResult = {
                    success: false,
                    attempts: attempt,
                    elapsed,
                    timedOut: true
                };

                if (opts.throwOnTimeout) {
                    throw new Error(`${opts.message}: Timed out after ${elapsed}ms (${attempt} attempts)`);
                }

                return result;
            }

            // Check condition
            try {
                const conditionMet = await opts.condition();

                if (conditionMet) {
                    return {
                        success: true,
                        attempts: attempt,
                        elapsed: Date.now() - startTime,
                        timedOut: false
                    };
                }
            } catch (error) {
                // Condition threw error - continue polling unless it's a critical error
                if (error instanceof Error &&
                    (error.message.includes('Target closed') ||
                        error.message.includes('context was destroyed'))) {
                    throw error; // Re-throw critical errors
                }
            }

            // Report progress
            if (opts.onProgress) {
                opts.onProgress(attempt, Date.now() - startTime);
            }

            // Wait before next check
            const interval = this.calculateInterval(
                attempt,
                opts.interval,
                opts.maxInterval,
                opts.backoff
            );

            // Don't wait longer than remaining timeout
            const remainingTime = opts.timeout - (Date.now() - startTime);
            const waitTime = Math.min(interval, remainingTime);

            if (waitTime > 0) {
                await this.wait(waitTime);
            }
        }
    }

    /**
     * Poll until element is visible
     */
    public async pollForVisible(
        page: Page,
        selector: string,
        timeout: number = 10000
    ): Promise<PollResult> {
        return this.poll({
            condition: async () => {
                try {
                    const element = page.locator(selector);
                    return await element.isVisible();
                } catch {
                    return false;
                }
            },
            timeout,
            message: `Waiting for ${selector} to be visible`
        });
    }

    /**
     * Poll until element is hidden
     */
    public async pollForHidden(
        page: Page,
        selector: string,
        timeout: number = 10000
    ): Promise<PollResult> {
        return this.poll({
            condition: async () => {
                try {
                    const element = page.locator(selector);
                    return !(await element.isVisible());
                } catch {
                    return true; // Element not found = hidden
                }
            },
            timeout,
            message: `Waiting for ${selector} to be hidden`
        });
    }

    /**
     * Poll until element contains text
     */
    public async pollForText(
        page: Page,
        selector: string,
        expectedText: string,
        timeout: number = 10000
    ): Promise<PollResult> {
        return this.poll({
            condition: async () => {
                try {
                    const element = page.locator(selector);
                    const text = await element.textContent();
                    return text?.includes(expectedText) || false;
                } catch {
                    return false;
                }
            },
            timeout,
            message: `Waiting for ${selector} to contain "${expectedText}"`
        });
    }

    /**
     * Poll until element has attribute value
     */
    public async pollForAttribute(
        page: Page,
        selector: string,
        attribute: string,
        expectedValue: string,
        timeout: number = 10000
    ): Promise<PollResult> {
        return this.poll({
            condition: async () => {
                try {
                    const element = page.locator(selector);
                    const value = await element.getAttribute(attribute);
                    return value === expectedValue;
                } catch {
                    return false;
                }
            },
            timeout,
            message: `Waiting for ${selector}[${attribute}] to equal "${expectedValue}"`
        });
    }

    /**
     * Poll until count of elements matches
     */
    public async pollForCount(
        page: Page,
        selector: string,
        expectedCount: number,
        timeout: number = 10000
    ): Promise<PollResult> {
        return this.poll({
            condition: async () => {
                try {
                    const elements = page.locator(selector);
                    const count = await elements.count();
                    return count === expectedCount;
                } catch {
                    return false;
                }
            },
            timeout,
            message: `Waiting for ${selector} count to be ${expectedCount}`
        });
    }

    /**
     * Poll with custom condition and automatic retry on stale element
     */
    public async pollWithStaleRetry<T>(
        condition: () => Promise<T>,
        validate: (result: T) => boolean,
        timeout: number = 10000,
        interval: number = 200
    ): Promise<{ success: boolean; result: T | null }> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const result = await condition();
                if (validate(result)) {
                    return { success: true, result };
                }
            } catch (error) {
                // Handle stale element - just retry
                if (error instanceof Error &&
                    !error.message.includes('Target closed') &&
                    !error.message.includes('context was destroyed')) {
                    // Retryable error - continue
                }
            }

            await this.wait(interval);
        }

        return { success: false, result: null };
    }
}

export default CSSmartPoller;
