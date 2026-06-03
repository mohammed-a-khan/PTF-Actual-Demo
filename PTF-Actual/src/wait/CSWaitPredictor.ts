/**
 * CSWaitPredictor — learn per-signature wait budgets from history.
 *
 * The framework today picks timeouts the way humans pick them: by
 * thumb-rule. 5 s for "normal", 30 s for "navigation-triggering", 60 s
 * for "JSP heavy lifting". That's fine until a JSP click that always
 * completes in 12 s gets a 60 s budget, dragging out failure detection
 * by 48 s every time it does flake; or until a "normal" click against
 * a slow page object actually needs 8 s and starts flaking under 5.
 *
 * The predictor sidesteps both problems by watching what actions
 * actually take. For every observed (signature, durationMs) pair it
 * maintains a Welford-style online mean + variance, plus a running max
 * and a pass/fail tally. From that it produces a recommendation:
 *
 *     mean + 1.645 · stddev  → one-tailed 95% upper bound
 *     · 1.2                  → safety margin against tail latency
 *     max with 1.1 · maxSample  while samples < 30 (long-tail floor)
 *
 * Rounded up to the next 100 ms so test logs stay readable.
 *
 * The store lives at `.cs-ai/waits/wait-data.json` and uses the same
 * singleton + debounced-save pattern as CSFlakyTestDetector /
 * CSImpactCollector / CSVisualBaselineStore. Bounded state — one float
 * tuple per signature, regardless of how many observations went into
 * it.
 *
 * Recommendations require at least `WAIT_PREDICTOR_MIN_SAMPLES`
 * (default 5) observations. Below that the caller's default is
 * returned untouched — we don't synthesise budgets from noise.
 *
 * Singleton.
 *
 * @module wait
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { WaitDataStore, WaitPrediction, WaitSignatureStats } from './CSWaitTypes';

/** Z-score for one-tailed 95% from the normal distribution. */
const Z_95 = 1.645;
/** Multiplier applied on top of the upper bound for tail safety. */
const SAFETY_MULTIPLIER = 1.2;
/** Floor multiplier against the observed max while the sample is small. */
const MAX_FLOOR_MULTIPLIER = 1.1;
/** Recommendations are rounded up to this resolution (ms). */
const ROUND_UP_TO_MS = 100;

export class CSWaitPredictor {
    private static instance: CSWaitPredictor;
    private config: CSConfigurationManager;
    private dataStore: WaitDataStore | null = null;
    private dataFilePath: string = '';
    private dirty: boolean = false;
    private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private saving: boolean = false;
    private readonly DATA_STORE_VERSION = 1;
    private repoRoot: string = '';

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.repoRoot = process.cwd();
    }

    public static getInstance(): CSWaitPredictor {
        if (!CSWaitPredictor.instance) {
            CSWaitPredictor.instance = new CSWaitPredictor();
        }
        return CSWaitPredictor.instance;
    }

    // ========================================================================
    // Config
    // ========================================================================

    /** Master switch for observation + recommendation. */
    public isEnabled(): boolean {
        return this.config.getBoolean('WAIT_PREDICTOR_ENABLED', false);
    }

    /** Minimum samples before a recommendation will be returned. */
    public getMinSamples(): number {
        return this.config.getNumber('WAIT_PREDICTOR_MIN_SAMPLES', 5);
    }

    private getDataDir(): string {
        return this.config.get('WAIT_PREDICTOR_DATA_DIR', '.cs-ai/waits');
    }

    // ========================================================================
    // Public API — observe + predict
    // ========================================================================

    /**
     * Record one (signature, durationMs, succeeded) observation. Cheap;
     * O(1) and no I/O. The save is debounced.
     *
     * Even when the framework switch is off we still allow direct callers
     * (smoke harness, tests) to drive the store. The runner-level call
     * sites are gated by `isEnabled()` themselves.
     */
    public observe(signature: string, durationMs: number, succeeded: boolean = true): void {
        if (!signature || !Number.isFinite(durationMs) || durationMs < 0) return;

        const store = this.ensureDataStore();
        const prev = store.signatures[signature];
        const stats: WaitSignatureStats = prev ? { ...prev } : {
            signature,
            count: 0,
            mean: 0,
            m2: 0,
            max: 0,
            passes: 0,
            failures: 0,
            lastUpdated: new Date().toISOString(),
        };

        // Welford's online algorithm. One pass, no sample retention.
        stats.count += 1;
        const delta = durationMs - stats.mean;
        stats.mean += delta / stats.count;
        const delta2 = durationMs - stats.mean;
        stats.m2 += delta * delta2;
        if (durationMs > stats.max) stats.max = durationMs;
        if (succeeded) stats.passes += 1; else stats.failures += 1;
        stats.lastUpdated = new Date().toISOString();

        store.signatures[signature] = stats;
        this.dirty = true;
        this.debounceSave();
    }

    /**
     * Compute the current prediction for a signature, or null when we
     * don't have enough data. Callers that want a usable number even
     * under low data should use `getRecommendation`.
     */
    public predict(signature: string): WaitPrediction | null {
        const store = this.ensureDataStore();
        const stats = store.signatures[signature];
        if (!stats || stats.count < this.getMinSamples()) return null;
        return this.buildPrediction(stats);
    }

    /**
     * Return a usable timeout budget for the signature: the prediction
     * when we have enough data, the caller's default otherwise. This is
     * the method most integration sites should call.
     */
    public getRecommendation(signature: string, defaultMs: number): number {
        if (!this.isEnabled()) return defaultMs;
        const p = this.predict(signature);
        return p ? p.recommendedMs : defaultMs;
    }

    /** Read-only inspection. */
    public snapshot(): WaitDataStore {
        return JSON.parse(JSON.stringify(this.ensureDataStore())) as WaitDataStore;
    }

    /** Used by tests to start from a clean slate. */
    public resetForTests(): void {
        this.dataStore = null;
        this.dirty = false;
        if (this.saveDebounceTimer) { clearTimeout(this.saveDebounceTimer); this.saveDebounceTimer = null; }
    }

    // ========================================================================
    // Signature helpers
    // ========================================================================

    /**
     * Canonical signature for a Gherkin step — strips quoted arguments and
     * angle-bracket parameters so data-row variations aggregate. Producers
     * are free to call `observe` with whatever signature they like; this
     * is provided as the convention for step-level observation.
     */
    public canonicaliseStep(keyword: string, stepText: string): string {
        const cleaned = stepText
            .replace(/"[^"]*"/g, '"<arg>"')
            .replace(/<[^>]+>/g, '<arg>')
            .replace(/\b\d+(\.\d+)?\b/g, '<n>')
            .trim();
        return `step:${keyword.trim()} ${cleaned}`;
    }

    // ========================================================================
    // Persistence
    // ========================================================================

    private ensureDataStore(): WaitDataStore {
        if (this.dataStore) return this.dataStore;
        const dataDir = path.resolve(this.repoRoot, this.getDataDir());
        this.dataFilePath = path.join(dataDir, 'wait-data.json');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        if (fs.existsSync(this.dataFilePath)) {
            try {
                this.dataStore = JSON.parse(fs.readFileSync(this.dataFilePath, 'utf-8')) as WaitDataStore;
                CSReporter.debug(
                    `[WaitPredictor] Loaded wait data: ${Object.keys(this.dataStore.signatures).length} signature(s)`,
                );
            } catch (e) {
                CSReporter.warn(`[WaitPredictor] Failed to read wait data, starting fresh: ${(e as Error).message}`);
                this.dataStore = this.createEmpty();
            }
        } else {
            this.dataStore = this.createEmpty();
        }
        return this.dataStore;
    }

    private createEmpty(): WaitDataStore {
        return { version: this.DATA_STORE_VERSION, lastUpdated: new Date().toISOString(), signatures: {} };
    }

    private debounceSave(): void {
        if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = setTimeout(() => this.saveToDisk(), 500);
    }

    private saveToDisk(): void {
        if (!this.dirty || this.saving || !this.dataStore) return;
        this.saving = true;
        try {
            const dir = path.dirname(this.dataFilePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            this.dataStore.lastUpdated = new Date().toISOString();
            fs.writeFileSync(this.dataFilePath, JSON.stringify(this.dataStore, null, 2), 'utf-8');
            this.dirty = false;
            CSReporter.debug('[WaitPredictor] Wait data saved');
        } catch (e) {
            CSReporter.warn(`[WaitPredictor] Failed to save wait data: ${(e as Error).message}`);
        } finally {
            this.saving = false;
        }
    }

    public flush(): void {
        if (this.saveDebounceTimer) { clearTimeout(this.saveDebounceTimer); this.saveDebounceTimer = null; }
        this.saveToDisk();
    }

    // ========================================================================
    // Math
    // ========================================================================

    private buildPrediction(stats: WaitSignatureStats): WaitPrediction {
        const variance = stats.count > 1 ? stats.m2 / (stats.count - 1) : 0;
        const stddev = Math.sqrt(Math.max(0, variance));
        const upper = stats.mean + Z_95 * stddev;
        const safe = upper * SAFETY_MULTIPLIER;
        const floor = stats.count < 30 ? stats.max * MAX_FLOOR_MULTIPLIER : 0;
        const raw = Math.max(safe, floor);
        const rounded = Math.ceil(raw / ROUND_UP_TO_MS) * ROUND_UP_TO_MS;

        const confidence: WaitPrediction['confidence'] =
            stats.count >= 30 ? 'high' :
            stats.count >= 5  ? 'medium' :
                                'low';

        return {
            signature: stats.signature,
            recommendedMs: rounded,
            meanMs: Math.round(stats.mean),
            stddevMs: Math.round(stddev),
            maxMs: stats.max,
            sampleCount: stats.count,
            confidence,
            failureRate: stats.count > 0 ? stats.failures / stats.count : 0,
        };
    }
}
