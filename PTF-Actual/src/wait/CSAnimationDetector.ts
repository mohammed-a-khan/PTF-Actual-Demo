/**
 * CS Animation Detector
 * Detects CSS animations and transitions, waits for completion
 * Thread-safe for parallel execution
 */

type Page = any;

export interface AnimationDetectorOptions {
    timeout: number;              // Maximum time to wait for animations
    checkInterval: number;        // How often to check (ms)
    includeTransitions: boolean;  // Include CSS transitions
    includeAnimations: boolean;   // Include CSS animations
    ignoreSelectors: string[];    // Elements to ignore
}

const DEFAULT_OPTIONS: AnimationDetectorOptions = {
    timeout: 5000,
    checkInterval: 50,
    includeTransitions: true,
    includeAnimations: true,
    ignoreSelectors: [
        '.clock',
        '.timer',
        '.cursor',
        '[data-animate-always]'
    ]
};

export class CSAnimationDetector {
    private page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    /**
     * Check if an element is currently animating
     */
    public async isElementAnimating(selector: string): Promise<boolean> {
        try {
            return await this.page.evaluate((sel: string) => {
                const element = document.querySelector(sel);
                if (!element) return false;

                const style = window.getComputedStyle(element);

                // Check for running animations
                const animationName = style.animationName;
                const animationPlayState = style.animationPlayState;
                const hasAnimation = animationName !== 'none' && animationPlayState === 'running';

                // Check for active transitions
                const transitionDuration = parseFloat(style.transitionDuration) || 0;
                const hasTransition = transitionDuration > 0;

                return hasAnimation || hasTransition;
            }, selector);
        } catch {
            return false;
        }
    }

    /**
     * Check if any element on the page is animating
     */
    public async hasActiveAnimations(options: Partial<AnimationDetectorOptions> = {}): Promise<boolean> {
        const opts = { ...DEFAULT_OPTIONS, ...options };

        try {
            return await this.page.evaluate(
                ({ includeTransitions, includeAnimations, ignoreSelectors }:
                    Pick<AnimationDetectorOptions, 'includeTransitions' | 'includeAnimations' | 'ignoreSelectors'>) => {

                    const shouldIgnore = (element: Element): boolean => {
                        return ignoreSelectors.some(selector => {
                            try {
                                return element.matches(selector) || element.closest(selector) !== null;
                            } catch {
                                return false;
                            }
                        });
                    };

                    // Get all elements
                    const allElements = Array.from(document.querySelectorAll('*'));

                    for (const element of allElements) {
                        if (shouldIgnore(element)) continue;

                        try {
                            const style = window.getComputedStyle(element);

                            // Check animations
                            if (includeAnimations) {
                                const animationName = style.animationName;
                                const animationPlayState = style.animationPlayState;
                                const animationDuration = parseFloat(style.animationDuration) || 0;

                                if (animationName !== 'none' &&
                                    animationPlayState === 'running' &&
                                    animationDuration > 0) {
                                    return true;
                                }
                            }

                            // Check transitions - this is trickier as we need to detect active transitions
                            if (includeTransitions) {
                                const transitionProperty = style.transitionProperty;
                                const transitionDuration = parseFloat(style.transitionDuration) || 0;

                                // We can't easily detect if a transition is currently in progress
                                // So we check if the element has transition defined and is changing
                                if (transitionProperty !== 'none' && transitionDuration > 0) {
                                    // Check if element is in a transitioning state by looking for common transition classes
                                    const classList = element.className;
                                    if (typeof classList === 'string' &&
                                        (classList.includes('transitioning') ||
                                            classList.includes('animating') ||
                                            classList.includes('fade') ||
                                            classList.includes('slide'))) {
                                        return true;
                                    }
                                }
                            }
                        } catch {
                            // Skip elements that can't be styled
                        }
                    }

                    return false;
                },
                { includeTransitions: opts.includeTransitions, includeAnimations: opts.includeAnimations, ignoreSelectors: opts.ignoreSelectors }
            );
        } catch {
            return false;
        }
    }

    /**
     * Wait for element to stop animating
     */
    public async waitForElementAnimationEnd(
        selector: string,
        timeout: number = 5000
    ): Promise<boolean> {
        const startTime = Date.now();

        // Quick check - if not animating, return immediately
        if (!(await this.isElementAnimating(selector))) {
            return true;
        }

        while (Date.now() - startTime < timeout) {
            await this.page.waitForTimeout(50);

            if (!(await this.isElementAnimating(selector))) {
                // Wait a tiny bit more for stability
                await this.page.waitForTimeout(20);
                return true;
            }
        }

        return false;
    }

    /**
     * Wait for all animations on page to complete
     */
    public async waitForAnimationsComplete(
        options: Partial<AnimationDetectorOptions> = {}
    ): Promise<boolean> {
        const opts = { ...DEFAULT_OPTIONS, ...options };
        const startTime = Date.now();

        // Quick check first
        if (!(await this.hasActiveAnimations(opts))) {
            return true;
        }

        while (Date.now() - startTime < opts.timeout) {
            await this.page.waitForTimeout(opts.checkInterval);

            if (!(await this.hasActiveAnimations(opts))) {
                // Double-check stability
                await this.page.waitForTimeout(30);
                if (!(await this.hasActiveAnimations(opts))) {
                    return true;
                }
            }
        }

        return false; // Timeout but proceed
    }

    /**
     * Wait for element to be stable (not animating and position not changing)
     */
    public async waitForElementStable(
        selector: string,
        timeout: number = 5000
    ): Promise<boolean> {
        const startTime = Date.now();

        try {
            let lastPosition = await this.getElementPosition(selector);
            let stableCount = 0;
            const requiredStableChecks = 3;

            while (Date.now() - startTime < timeout) {
                await this.page.waitForTimeout(50);

                const currentPosition = await this.getElementPosition(selector);

                if (currentPosition && lastPosition &&
                    currentPosition.x === lastPosition.x &&
                    currentPosition.y === lastPosition.y &&
                    currentPosition.width === lastPosition.width &&
                    currentPosition.height === lastPosition.height) {
                    stableCount++;

                    if (stableCount >= requiredStableChecks) {
                        return true;
                    }
                } else {
                    stableCount = 0;
                }

                lastPosition = currentPosition;
            }

            return false;
        } catch {
            return true; // If element not found, proceed
        }
    }

    private async getElementPosition(selector: string): Promise<{
        x: number; y: number; width: number; height: number;
    } | null> {
        try {
            return await this.page.evaluate((sel: string) => {
                const element = document.querySelector(sel);
                if (!element) return null;

                const rect = element.getBoundingClientRect();
                return {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height
                };
            }, selector);
        } catch {
            return null;
        }
    }
}

export default CSAnimationDetector;
