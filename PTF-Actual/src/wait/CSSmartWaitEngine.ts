/**
 * CS Smart Wait Engine
 * Core orchestrator for the smart wait system
 * Coordinates all wait components for seamless auto-waiting
 * Thread-safe for parallel execution - each page gets its own engine
 */

type Page = any;
type Locator = any;

import { CSSmartWaitConfig, SmartWaitOptions, SmartWaitLevel } from './CSSmartWaitConfig';
import { CSDomStabilityMonitor } from './CSDomStabilityMonitor';
import { CSNetworkIdleTracker } from './CSNetworkIdleTracker';
import { CSSpinnerDetector } from './CSSpinnerDetector';
import { CSAnimationDetector } from './CSAnimationDetector';
import { CSSmartPoller } from './CSSmartPoller';

export interface BeforeActionContext {
    locator?: Locator;
    selector?: string;
    actionType: 'click' | 'fill' | 'type' | 'select' | 'hover' | 'tap' | 'other';
    timeout?: number;
}

export interface AfterActionContext {
    actionType: string;
    actionDuration: number;
    triggeredNavigation?: boolean;
}

export interface WaitResult {
    success: boolean;
    waitedMs: number;
    skipped: boolean;
    reason?: string;
}

export class CSSmartWaitEngine {
    private static instances: Map<string, CSSmartWaitEngine> = new Map();

    private page: Page;
    private instanceId: string;
    private config: CSSmartWaitConfig;
    private domMonitor: CSDomStabilityMonitor;
    private networkTracker: CSNetworkIdleTracker;
    private spinnerDetector: CSSpinnerDetector;
    private animationDetector: CSAnimationDetector;
    private poller: CSSmartPoller;

    private isBeforeActionRunning: boolean = false;
    private isAfterActionRunning: boolean = false;

    private constructor(page: Page, instanceId: string) {
        this.page = page;
        this.instanceId = instanceId;
        this.config = CSSmartWaitConfig.getInstance(instanceId);

        // Initialize components
        this.domMonitor = new CSDomStabilityMonitor(page);
        this.networkTracker = new CSNetworkIdleTracker(page);
        this.spinnerDetector = new CSSpinnerDetector(page);
        this.animationDetector = new CSAnimationDetector(page);
        this.poller = new CSSmartPoller(page);

        // Configure spinner detector with custom selectors
        if (this.config.spinnerSelectors.length > 0) {
            this.spinnerDetector.setSelectors(this.config.spinnerSelectors);
        }
    }

    /**
     * Get or create engine instance for a page
     * Thread-safe - each page/worker gets its own instance
     */
    public static getInstance(page: Page, instanceId?: string): CSSmartWaitEngine {
        const id = instanceId || `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        if (!CSSmartWaitEngine.instances.has(id)) {
            CSSmartWaitEngine.instances.set(id, new CSSmartWaitEngine(page, id));
        }

        return CSSmartWaitEngine.instances.get(id)!;
    }

    /**
     * Create a new engine for a page (always creates new, doesn't reuse)
     */
    public static create(page: Page): CSSmartWaitEngine {
        const id = `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const engine = new CSSmartWaitEngine(page, id);
        CSSmartWaitEngine.instances.set(id, engine);
        return engine;
    }

    /**
     * Dispose engine instance
     */
    public dispose(): void {
        this.networkTracker.dispose();
        CSSmartWaitEngine.instances.delete(this.instanceId);
    }

    /**
     * Dispose all instances (call on test cleanup)
     */
    public static disposeAll(): void {
        for (const [id, engine] of CSSmartWaitEngine.instances) {
            engine.networkTracker.dispose();
        }
        CSSmartWaitEngine.instances.clear();
    }

    // ============================================
    // CONFIGURATION
    // ============================================

    public isEnabled(): boolean {
        return this.config.isEnabled();
    }

    public getLevel(): SmartWaitLevel {
        return this.config.getLevel();
    }

    public setLevel(level: SmartWaitLevel): void {
        this.config.setLevel(level);
    }

    public getConfig(): CSSmartWaitConfig {
        return this.config;
    }

    // ============================================
    // BEFORE ACTION WAITS
    // ============================================

    /**
     * Execute all before-action waits
     * Called automatically before click, fill, type, etc.
     */
    public async beforeAction(
        context: BeforeActionContext,
        overrides?: Partial<SmartWaitOptions>
    ): Promise<WaitResult> {
        const startTime = Date.now();

        // Skip if disabled or already running (prevent recursion)
        if (!this.isEnabled() || this.isBeforeActionRunning) {
            return { success: true, waitedMs: 0, skipped: true, reason: 'disabled or already running' };
        }

        this.isBeforeActionRunning = true;
        const opts = overrides ? this.config.override(overrides) : this.config.getOptions();

        try {
            // Run waits in parallel where possible for performance
            const waitPromises: Promise<boolean>[] = [];

            // 1. Wait for spinners (high priority)
            if (opts.waitForSpinners) {
                waitPromises.push(this.spinnerDetector.waitForSpinnersToDisappear({
                    timeout: opts.defaultTimeout
                }));
            }

            // 2. Wait for element to be visible (if locator provided)
            if (opts.waitForVisible && context.locator) {
                waitPromises.push(this.waitForLocatorVisible(context.locator, opts.defaultTimeout));
            }

            // Wait for these first (they're quick checks)
            await Promise.all(waitPromises);

            // 3. Wait for element to be stable (not animating)
            if (opts.waitForStable && context.selector) {
                await this.animationDetector.waitForElementStable(context.selector, opts.animationTimeout);
            }

            // 4. Wait for animations to complete
            if (opts.waitForAnimations) {
                await this.animationDetector.waitForAnimationsComplete({
                    timeout: opts.animationTimeout
                });
            }

            // 5. Wait for network idle (if enabled - usually opt-in)
            if (opts.waitForNetworkIdle) {
                await this.networkTracker.waitForNetworkIdle({
                    timeout: opts.defaultTimeout,
                    idleTimeMs: opts.networkIdleMs,
                    excludePatterns: opts.networkExcludePatterns
                });
            }

            // 6. Check element is not obscured (if enabled)
            if (opts.waitForNotObscured && context.selector) {
                await this.waitForNotObscured(context.selector, opts.defaultTimeout);
            }

            return {
                success: true,
                waitedMs: Date.now() - startTime,
                skipped: false
            };
        } catch (error) {
            // Don't fail the action on wait errors - just proceed
            return {
                success: false,
                waitedMs: Date.now() - startTime,
                skipped: false,
                reason: error instanceof Error ? error.message : 'Unknown error'
            };
        } finally {
            this.isBeforeActionRunning = false;
        }
    }

    // ============================================
    // AFTER ACTION WAITS
    // ============================================

    /**
     * Execute all after-action waits
     * Called automatically after click, fill, type, etc.
     */
    public async afterAction(
        context: AfterActionContext,
        overrides?: Partial<SmartWaitOptions>
    ): Promise<WaitResult> {
        const startTime = Date.now();

        // Skip if disabled or already running
        if (!this.isEnabled() || this.isAfterActionRunning) {
            return { success: true, waitedMs: 0, skipped: true, reason: 'disabled or already running' };
        }

        this.isAfterActionRunning = true;
        const opts = overrides ? this.config.override(overrides) : this.config.getOptions();

        try {
            // 1. Wait for DOM to stabilize
            if (opts.waitForDomStable) {
                await this.domMonitor.waitForDomStable({
                    stabilityThresholdMs: opts.domStabilityMs,
                    timeout: opts.defaultTimeout
                });
            }

            // 2. Wait for spinners after action
            if (opts.waitForSpinnersAfter) {
                await this.spinnerDetector.waitForSpinnersToDisappear({
                    timeout: opts.defaultTimeout
                });
            }

            // 3. Wait for network idle after action (if enabled)
            if (opts.waitForNetworkIdleAfter) {
                await this.networkTracker.waitForNetworkIdle({
                    timeout: opts.defaultTimeout,
                    idleTimeMs: opts.networkIdleMs,
                    excludePatterns: opts.networkExcludePatterns
                });
            }

            return {
                success: true,
                waitedMs: Date.now() - startTime,
                skipped: false
            };
        } catch (error) {
            return {
                success: false,
                waitedMs: Date.now() - startTime,
                skipped: false,
                reason: error instanceof Error ? error.message : 'Unknown error'
            };
        } finally {
            this.isAfterActionRunning = false;
        }
    }

    // ============================================
    // HELPER METHODS
    // ============================================

    private async waitForLocatorVisible(locator: Locator, timeout: number): Promise<boolean> {
        try {
            await locator.waitFor({ state: 'visible', timeout });
            return true;
        } catch {
            return false;
        }
    }

    private async waitForNotObscured(selector: string, timeout: number): Promise<boolean> {
        try {
            return await this.page.evaluate(
                ({ sel, timeoutMs }: { sel: string; timeoutMs: number }) => {
                    return new Promise<boolean>((resolve) => {
                        const startTime = Date.now();

                        const check = () => {
                            const element = document.querySelector(sel);
                            if (!element) {
                                resolve(true);
                                return;
                            }

                            const rect = element.getBoundingClientRect();
                            const centerX = rect.left + rect.width / 2;
                            const centerY = rect.top + rect.height / 2;

                            const topElement = document.elementFromPoint(centerX, centerY);

                            if (topElement === element || element.contains(topElement)) {
                                resolve(true);
                                return;
                            }

                            if (Date.now() - startTime > timeoutMs) {
                                resolve(false);
                                return;
                            }

                            setTimeout(check, 50);
                        };

                        check();
                    });
                },
                { sel: selector, timeoutMs: timeout }
            );
        } catch {
            return true;
        }
    }

    // ============================================
    // PUBLIC UTILITIES
    // ============================================

    /**
     * Wait for spinners to disappear
     */
    public async waitForSpinners(timeout?: number): Promise<boolean> {
        return this.spinnerDetector.waitForSpinnersToDisappear({
            timeout: timeout || this.config.defaultTimeout
        });
    }

    /**
     * Wait for DOM stability
     */
    public async waitForDomStable(stabilityMs?: number, timeout?: number): Promise<boolean> {
        return this.domMonitor.waitForDomStable({
            stabilityThresholdMs: stabilityMs || this.config.domStabilityMs,
            timeout: timeout || this.config.defaultTimeout
        });
    }

    /**
     * Wait for network idle
     */
    public async waitForNetworkIdle(timeout?: number): Promise<boolean> {
        return this.networkTracker.waitForNetworkIdle({
            timeout: timeout || this.config.defaultTimeout,
            idleTimeMs: this.config.networkIdleMs,
            excludePatterns: this.config.networkExcludePatterns
        });
    }

    /**
     * Wait for animations to complete
     */
    public async waitForAnimations(timeout?: number): Promise<boolean> {
        return this.animationDetector.waitForAnimationsComplete({
            timeout: timeout || this.config.animationTimeout
        });
    }

    /**
     * Wait for element to be stable
     */
    public async waitForElementStable(selector: string, timeout?: number): Promise<boolean> {
        return this.animationDetector.waitForElementStable(
            selector,
            timeout || this.config.animationTimeout
        );
    }

    /**
     * Get the poller for custom polling operations
     */
    public getPoller(): CSSmartPoller {
        return this.poller;
    }

    /**
     * Get network tracker for manual control
     */
    public getNetworkTracker(): CSNetworkIdleTracker {
        return this.networkTracker;
    }

    /**
     * Get spinner detector for manual control
     */
    public getSpinnerDetector(): CSSpinnerDetector {
        return this.spinnerDetector;
    }

    /**
     * Start network tracking (for pages with heavy AJAX)
     */
    public startNetworkTracking(): void {
        this.networkTracker.startTracking(this.config.networkExcludePatterns);
    }

    /**
     * Stop network tracking
     */
    public stopNetworkTracking(): void {
        this.networkTracker.stopTracking();
    }
}

export default CSSmartWaitEngine;
