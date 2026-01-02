/**
 * CS Smart Wait Configuration
 * Centralized configuration for smart wait system
 * Thread-safe for parallel execution
 */

import { CSConfigurationManager } from '../core/CSConfigurationManager';

export enum SmartWaitLevel {
    OFF = 'off',           // No smart waits (fastest, manual control)
    MINIMAL = 'minimal',   // Only stale recovery + spinner detection
    STANDARD = 'standard', // Default - balanced performance
    STRICT = 'strict'      // All features - most reliable
}

export interface SmartWaitOptions {
    // Before action waits
    waitForVisible: boolean;
    waitForStable: boolean;
    waitForNotObscured: boolean;
    waitForSpinners: boolean;
    waitForNetworkIdle: boolean;
    waitForAnimations: boolean;

    // After action waits
    waitForDomStable: boolean;
    waitForSpinnersAfter: boolean;
    waitForNetworkIdleAfter: boolean;

    // Timeouts
    defaultTimeout: number;
    domStabilityMs: number;
    networkIdleMs: number;
    animationTimeout: number;

    // Spinner configuration
    spinnerSelectors: string[];

    // Network configuration
    networkExcludePatterns: string[];

    // Stale element recovery
    staleElementRetry: boolean;
    staleElementMaxRetries: number;
}

export class CSSmartWaitConfig {
    private static instances: Map<string, CSSmartWaitConfig> = new Map();
    private options: SmartWaitOptions;
    private level: SmartWaitLevel;
    private instanceId: string;

    private constructor(instanceId: string = 'default') {
        this.instanceId = instanceId;
        this.level = this.getConfiguredLevel();
        this.options = this.buildOptionsFromLevel(this.level);
    }

    /**
     * Get instance - thread-safe for parallel execution
     * Each worker/thread can have its own instance
     */
    public static getInstance(instanceId: string = 'default'): CSSmartWaitConfig {
        if (!CSSmartWaitConfig.instances.has(instanceId)) {
            CSSmartWaitConfig.instances.set(instanceId, new CSSmartWaitConfig(instanceId));
        }
        return CSSmartWaitConfig.instances.get(instanceId)!;
    }

    /**
     * Reset instance (useful for testing)
     */
    public static resetInstance(instanceId: string = 'default'): void {
        CSSmartWaitConfig.instances.delete(instanceId);
    }

    /**
     * Reset all instances
     */
    public static resetAllInstances(): void {
        CSSmartWaitConfig.instances.clear();
    }

    private getConfiguredLevel(): SmartWaitLevel {
        const config = CSConfigurationManager.getInstance();
        // Default to 'minimal' for faster test execution
        const levelStr = config.get('SMART_WAIT_LEVEL', 'minimal').toLowerCase();

        switch (levelStr) {
            case 'off': return SmartWaitLevel.OFF;
            case 'minimal': return SmartWaitLevel.MINIMAL;
            case 'strict': return SmartWaitLevel.STRICT;
            default: return SmartWaitLevel.STANDARD;
        }
    }

    private buildOptionsFromLevel(level: SmartWaitLevel): SmartWaitOptions {
        const config = CSConfigurationManager.getInstance();

        // Base configuration from environment
        const defaultTimeout = parseInt(config.get('SMART_WAIT_DEFAULT_TIMEOUT', '10000'), 10);
        const domStabilityMs = parseInt(config.get('SMART_WAIT_DOM_STABILITY_MS', '100'), 10);
        const networkIdleMs = parseInt(config.get('SMART_WAIT_NETWORK_IDLE_MS', '500'), 10);
        const animationTimeout = parseInt(config.get('SMART_WAIT_ANIMATION_TIMEOUT', '5000'), 10);

        // Spinner selectors from config or defaults
        const spinnerSelectorsStr = config.get('SMART_WAIT_SPINNER_SELECTORS',
            config.get('SPINNER_SELECTORS', '.spinner,.loading,.loader,.ctsjv-loading,[aria-busy="true"]'));
        const spinnerSelectors = spinnerSelectorsStr.split(/[,;]/).map((s: string) => s.trim()).filter((s: string) => s);

        // Network exclude patterns
        const networkExcludeStr = config.get('SMART_WAIT_NETWORK_IGNORE', 'analytics,tracking,heartbeat,favicon');
        const networkExcludePatterns = networkExcludeStr.split(/[,;]/).map((s: string) => s.trim()).filter((s: string) => s);

        // Build options based on level
        switch (level) {
            case SmartWaitLevel.OFF:
                return {
                    waitForVisible: false,
                    waitForStable: false,
                    waitForNotObscured: false,
                    waitForSpinners: false,
                    waitForNetworkIdle: false,
                    waitForAnimations: false,
                    waitForDomStable: false,
                    waitForSpinnersAfter: false,
                    waitForNetworkIdleAfter: false,
                    defaultTimeout,
                    domStabilityMs,
                    networkIdleMs,
                    animationTimeout,
                    spinnerSelectors,
                    networkExcludePatterns,
                    staleElementRetry: false,
                    staleElementMaxRetries: 0
                };

            case SmartWaitLevel.MINIMAL:
                return {
                    waitForVisible: true,
                    waitForStable: false,
                    waitForNotObscured: false,
                    waitForSpinners: true,
                    waitForNetworkIdle: false,
                    waitForAnimations: false,
                    waitForDomStable: false,
                    waitForSpinnersAfter: true,
                    waitForNetworkIdleAfter: false,
                    defaultTimeout,
                    domStabilityMs,
                    networkIdleMs,
                    animationTimeout,
                    spinnerSelectors,
                    networkExcludePatterns,
                    staleElementRetry: true,
                    staleElementMaxRetries: 2
                };

            case SmartWaitLevel.STRICT:
                return {
                    waitForVisible: true,
                    waitForStable: true,
                    waitForNotObscured: true,
                    waitForSpinners: true,
                    waitForNetworkIdle: true,
                    waitForAnimations: true,
                    waitForDomStable: true,
                    waitForSpinnersAfter: true,
                    waitForNetworkIdleAfter: true,
                    defaultTimeout,
                    domStabilityMs,
                    networkIdleMs,
                    animationTimeout,
                    spinnerSelectors,
                    networkExcludePatterns,
                    staleElementRetry: true,
                    staleElementMaxRetries: 3
                };

            case SmartWaitLevel.STANDARD:
            default:
                return {
                    waitForVisible: true,
                    waitForStable: true,
                    waitForNotObscured: false,
                    waitForSpinners: true,
                    waitForNetworkIdle: false,
                    waitForAnimations: true,
                    waitForDomStable: true,
                    waitForSpinnersAfter: true,
                    waitForNetworkIdleAfter: false,
                    defaultTimeout,
                    domStabilityMs,
                    networkIdleMs,
                    animationTimeout,
                    spinnerSelectors,
                    networkExcludePatterns,
                    staleElementRetry: true,
                    staleElementMaxRetries: 3
                };
        }
    }

    // Getters
    public getLevel(): SmartWaitLevel { return this.level; }
    public getOptions(): SmartWaitOptions { return { ...this.options }; }
    public isEnabled(): boolean { return this.level !== SmartWaitLevel.OFF; }

    // Individual option getters for convenience
    public get waitForVisible(): boolean { return this.options.waitForVisible; }
    public get waitForStable(): boolean { return this.options.waitForStable; }
    public get waitForNotObscured(): boolean { return this.options.waitForNotObscured; }
    public get waitForSpinners(): boolean { return this.options.waitForSpinners; }
    public get waitForNetworkIdle(): boolean { return this.options.waitForNetworkIdle; }
    public get waitForAnimations(): boolean { return this.options.waitForAnimations; }
    public get waitForDomStable(): boolean { return this.options.waitForDomStable; }
    public get waitForSpinnersAfter(): boolean { return this.options.waitForSpinnersAfter; }
    public get waitForNetworkIdleAfter(): boolean { return this.options.waitForNetworkIdleAfter; }
    public get defaultTimeout(): number { return this.options.defaultTimeout; }
    public get domStabilityMs(): number { return this.options.domStabilityMs; }
    public get networkIdleMs(): number { return this.options.networkIdleMs; }
    public get animationTimeout(): number { return this.options.animationTimeout; }
    public get spinnerSelectors(): string[] { return [...this.options.spinnerSelectors]; }
    public get networkExcludePatterns(): string[] { return [...this.options.networkExcludePatterns]; }
    public get staleElementRetry(): boolean { return this.options.staleElementRetry; }
    public get staleElementMaxRetries(): number { return this.options.staleElementMaxRetries; }

    /**
     * Override options at runtime (per-page or per-action basis)
     */
    public override(overrides: Partial<SmartWaitOptions>): SmartWaitOptions {
        return { ...this.options, ...overrides };
    }

    /**
     * Set level at runtime
     */
    public setLevel(level: SmartWaitLevel): void {
        this.level = level;
        this.options = this.buildOptionsFromLevel(level);
    }
}

export default CSSmartWaitConfig;
