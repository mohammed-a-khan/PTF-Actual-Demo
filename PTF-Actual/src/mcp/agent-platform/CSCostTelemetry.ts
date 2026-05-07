/**
 * Agentic Test Platform — Cost & Telemetry
 *
 * Token + wall-clock + dollar tracking with budget enforcement. The class is
 * stateful (instance-per-run); the master tool creates a fresh instance at
 * the start of each invocation and consults it before every model call.
 *
 * Pricing constants are approximate, per-1M-tokens, USD. They are
 * configurable via the static `setPricing` method so deployments can plug
 * in their own contract rates without code changes.
 *
 * @module agent-platform/CSCostTelemetry
 */

import { CostBudget, CostUsage } from './types';

// ============================================================================
// Defaults
// ============================================================================

/**
 * Default per-run budget. Tuned for a single end-to-end generation pass:
 *   500k tokens — enough for a multi-turn agent loop with healing
 *   30 minutes  — wall-clock cap for one generation
 *   USD 5.00    — soft dollar cap; production deployments should override
 */
export const DEFAULT_BUDGET: CostBudget = {
    maxTokens: 500_000,
    maxWallClockMs: 30 * 60 * 1000,
    maxCostUsd: 5.0,
};

/**
 * Default tier pricing in USD per 1M tokens.
 *   cheap   — small/fast models (input $0.15 / output $0.60)
 *   mid     — production models (input $3.00 / output $15.00)
 *   premium — top-of-line models (input $15.00 / output $75.00)
 *
 * Replace via `CSCostTelemetry.setPricing` if your contract rates differ.
 */
let TIER_PRICING: Record<
    'cheap' | 'mid' | 'premium',
    { inputPer1M: number; outputPer1M: number }
> = {
    cheap: { inputPer1M: 0.15, outputPer1M: 0.6 },
    mid: { inputPer1M: 3.0, outputPer1M: 15.0 },
    premium: { inputPer1M: 15.0, outputPer1M: 75.0 },
};

// ============================================================================
// CSCostTelemetry
// ============================================================================

/**
 * One instance per agent run. Tracks cumulative token counts, wall-clock
 * time, and cost; enforces the configured budget.
 */
export class CSCostTelemetry {
    private readonly runId: string;
    private readonly startedAt: number;
    private readonly budget: CostBudget;
    private usage: CostUsage;
    private toolCallCount = 0;

    /**
     * @param runId   Stable identifier for the current run (used in logs).
     * @param budget  Optional partial overrides; missing fields fall back
     *                to DEFAULT_BUDGET.
     */
    constructor(runId: string, budget?: Partial<CostBudget>) {
        this.runId = runId;
        this.startedAt = Date.now();
        this.budget = { ...DEFAULT_BUDGET, ...(budget ?? {}) };
        this.usage = {
            tokensUsed: 0,
            wallClockMs: 0,
            costUsd: 0,
            byModelTier: {
                cheap: { tokens: 0, costUsd: 0 },
                mid: { tokens: 0, costUsd: 0 },
                premium: { tokens: 0, costUsd: 0 },
            },
        };
    }

    /**
     * Override the global pricing table. Useful for deployments using
     * negotiated contract rates.
     */
    public static setPricing(
        pricing: Record<
            'cheap' | 'mid' | 'premium',
            { inputPer1M: number; outputPer1M: number }
        >,
    ): void {
        TIER_PRICING = pricing;
    }

    /**
     * Read-only access to the current pricing table (for diagnostics).
     */
    public static getPricing(): Record<
        'cheap' | 'mid' | 'premium',
        { inputPer1M: number; outputPer1M: number }
    > {
        return { ...TIER_PRICING };
    }

    /**
     * Record token consumption from a single model call. Updates the
     * cumulative totals and the per-tier breakdown.
     */
    public recordTokens(
        modelTier: 'cheap' | 'mid' | 'premium',
        input: number,
        output: number,
    ): void {
        const cost = this.estimateModelCost(modelTier, input, output);
        const tokens = (input ?? 0) + (output ?? 0);
        this.usage.tokensUsed += tokens;
        this.usage.costUsd += cost;
        this.usage.byModelTier[modelTier].tokens += tokens;
        this.usage.byModelTier[modelTier].costUsd += cost;
    }

    /**
     * Record a tool call's wall-clock duration. Tool calls do not consume
     * tokens directly, but they count against the wall-clock budget.
     */
    public recordToolCall(toolName: string, durationMs: number): void {
        this.toolCallCount += 1;
        // Wall-clock is computed live in checkBudget(); we do not need to
        // accumulate per-call here. Stored for diagnostics only.
        void toolName;
        void durationMs;
    }

    /**
     * Check budget headroom. Returns:
     *   withinBudget=true if all three thresholds are respected
     *   pctUsed = the worst (highest) percentage across the three axes
     *   reason  = present iff withinBudget=false
     *
     * Callers should warn when pctUsed >= 0.8 and abort when >= 1.0.
     */
    public checkBudget(): { withinBudget: boolean; pctUsed: number; reason?: string } {
        const wallClock = Date.now() - this.startedAt;
        this.usage.wallClockMs = wallClock;

        const tokenPct = this.usage.tokensUsed / this.budget.maxTokens;
        const wallPct = wallClock / this.budget.maxWallClockMs;
        const costPct = this.usage.costUsd / this.budget.maxCostUsd;
        const pctUsed = Math.max(tokenPct, wallPct, costPct);

        if (this.usage.tokensUsed >= this.budget.maxTokens) {
            return {
                withinBudget: false,
                pctUsed,
                reason: `Token budget exceeded (${this.usage.tokensUsed}/${this.budget.maxTokens})`,
            };
        }
        if (wallClock >= this.budget.maxWallClockMs) {
            return {
                withinBudget: false,
                pctUsed,
                reason: `Wall-clock budget exceeded (${wallClock}ms/${this.budget.maxWallClockMs}ms)`,
            };
        }
        if (this.usage.costUsd >= this.budget.maxCostUsd) {
            return {
                withinBudget: false,
                pctUsed,
                reason: `Cost budget exceeded ($${this.usage.costUsd.toFixed(4)}/$${this.budget.maxCostUsd})`,
            };
        }

        return { withinBudget: true, pctUsed };
    }

    /**
     * Snapshot of current cumulative usage. Returned by reference for
     * efficiency; callers must not mutate the result.
     */
    public getUsage(): CostUsage {
        // Refresh wall clock so a snapshot is internally consistent.
        this.usage.wallClockMs = Date.now() - this.startedAt;
        return this.usage;
    }

    /**
     * Estimate USD cost for a single model call.
     */
    public estimateModelCost(
        tier: 'cheap' | 'mid' | 'premium',
        inputTokens: number,
        outputTokens: number,
    ): number {
        const pricing = TIER_PRICING[tier];
        const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
        const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
        return inputCost + outputCost;
    }

    /**
     * Diagnostic accessors.
     */
    public getRunId(): string {
        return this.runId;
    }
    public getBudget(): CostBudget {
        return { ...this.budget };
    }
    public getToolCallCount(): number {
        return this.toolCallCount;
    }
}
