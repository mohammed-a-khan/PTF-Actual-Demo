/**
 * CS DOM Stability Monitor
 * Uses MutationObserver to detect when DOM stops changing
 * Thread-safe for parallel execution
 */

type Page = any;

export interface DomStabilityOptions {
    stabilityThresholdMs: number;  // Time with no mutations to consider stable
    timeout: number;                // Maximum time to wait
    observeSubtree: boolean;        // Observe child elements
    observeAttributes: boolean;     // Observe attribute changes
    observeCharacterData: boolean;  // Observe text content changes
    ignoreSelectors: string[];      // Selectors to ignore (e.g., clocks, animations)
}

const DEFAULT_OPTIONS: DomStabilityOptions = {
    stabilityThresholdMs: 100,
    timeout: 5000,
    observeSubtree: true,
    observeAttributes: true,
    observeCharacterData: true,
    ignoreSelectors: []
};

export class CSDomStabilityMonitor {
    private page: Page;
    private isMonitoring: boolean = false;

    constructor(page: Page) {
        this.page = page;
    }

    /**
     * Wait for DOM to become stable (no mutations for stabilityThresholdMs)
     * Uses browser's MutationObserver for efficient monitoring
     */
    public async waitForDomStable(options: Partial<DomStabilityOptions> = {}): Promise<boolean> {
        const opts = { ...DEFAULT_OPTIONS, ...options };

        if (this.isMonitoring) {
            return true; // Already monitoring, skip to avoid conflicts
        }

        this.isMonitoring = true;

        try {
            const result = await this.page.evaluate(
                ({ stabilityThresholdMs, timeout, observeSubtree, observeAttributes, observeCharacterData, ignoreSelectors }: DomStabilityOptions) => {
                    return new Promise<boolean>((resolve) => {
                        let lastMutationTime = Date.now();
                        let checkInterval: ReturnType<typeof setInterval>;
                        let timeoutId: ReturnType<typeof setTimeout>;
                        let observer: MutationObserver;

                        const shouldIgnore = (node: Node): boolean => {
                            if (ignoreSelectors.length === 0) return false;
                            if (node.nodeType !== Node.ELEMENT_NODE) return false;

                            const element = node as Element;
                            return ignoreSelectors.some(selector => {
                                try {
                                    return element.matches(selector) || element.closest(selector) !== null;
                                } catch {
                                    return false;
                                }
                            });
                        };

                        const cleanup = () => {
                            if (observer) observer.disconnect();
                            if (checkInterval) clearInterval(checkInterval);
                            if (timeoutId) clearTimeout(timeoutId);
                        };

                        observer = new MutationObserver((mutations) => {
                            // Filter out ignored elements
                            const significantMutations = mutations.filter(m => !shouldIgnore(m.target));
                            if (significantMutations.length > 0) {
                                lastMutationTime = Date.now();
                            }
                        });

                        observer.observe(document.body, {
                            childList: true,
                            subtree: observeSubtree,
                            attributes: observeAttributes,
                            characterData: observeCharacterData
                        });

                        // Check for stability periodically
                        checkInterval = setInterval(() => {
                            const timeSinceLastMutation = Date.now() - lastMutationTime;
                            if (timeSinceLastMutation >= stabilityThresholdMs) {
                                cleanup();
                                resolve(true);
                            }
                        }, 50); // Check every 50ms

                        // Timeout fallback
                        timeoutId = setTimeout(() => {
                            cleanup();
                            resolve(false); // Timed out but don't fail - just proceed
                        }, timeout);
                    });
                },
                opts
            );

            return result;
        } catch (error) {
            // If page context is lost, just return true to proceed
            return true;
        } finally {
            this.isMonitoring = false;
        }
    }

    /**
     * Quick check if DOM is currently stable
     * Returns immediately without waiting
     */
    public async isDomStable(checkDurationMs: number = 50): Promise<boolean> {
        try {
            return await this.page.evaluate((duration: number) => {
                return new Promise<boolean>((resolve) => {
                    let hasMutations = false;

                    const observer = new MutationObserver(() => {
                        hasMutations = true;
                    });

                    observer.observe(document.body, {
                        childList: true,
                        subtree: true,
                        attributes: true
                    });

                    setTimeout(() => {
                        observer.disconnect();
                        resolve(!hasMutations);
                    }, duration);
                });
            }, checkDurationMs);
        } catch {
            return true; // Assume stable if check fails
        }
    }

    /**
     * Wait for a specific element's subtree to become stable
     */
    public async waitForElementStable(
        selector: string,
        options: Partial<DomStabilityOptions> = {}
    ): Promise<boolean> {
        const opts = { ...DEFAULT_OPTIONS, ...options };

        try {
            return await this.page.evaluate(
                ({ selector, stabilityThresholdMs, timeout, observeSubtree, observeAttributes, observeCharacterData }:
                    { selector: string } & DomStabilityOptions) => {
                    return new Promise<boolean>((resolve) => {
                        const element = document.querySelector(selector);
                        if (!element) {
                            resolve(true); // Element not found, proceed
                            return;
                        }

                        let lastMutationTime = Date.now();
                        let checkInterval: ReturnType<typeof setInterval>;
                        let timeoutId: ReturnType<typeof setTimeout>;

                        const observer = new MutationObserver(() => {
                            lastMutationTime = Date.now();
                        });

                        observer.observe(element, {
                            childList: true,
                            subtree: observeSubtree,
                            attributes: observeAttributes,
                            characterData: observeCharacterData
                        });

                        checkInterval = setInterval(() => {
                            if (Date.now() - lastMutationTime >= stabilityThresholdMs) {
                                observer.disconnect();
                                clearInterval(checkInterval);
                                clearTimeout(timeoutId);
                                resolve(true);
                            }
                        }, 50);

                        timeoutId = setTimeout(() => {
                            observer.disconnect();
                            clearInterval(checkInterval);
                            resolve(false);
                        }, timeout);
                    });
                },
                { selector, ...opts }
            );
        } catch {
            return true;
        }
    }
}

export default CSDomStabilityMonitor;
