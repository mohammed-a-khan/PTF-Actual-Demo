/**
 * CSSmartRetryEngine - Smart Retry bandit
 *
 * When a test fails and a retry is warranted, this engine picks the
 * retry tactic (immediate / reload / fresh-context / backoff) most
 * likely to recover the test, based on per-failure-signature history.
 *
 * The decision is made with a UCB1 multi-armed bandit: each tactic
 * gets an exploration bonus until it has been tried, then the highest
 * upper-confidence-bound score wins. The engine learns continuously
 * — each retry's outcome updates the per-(signature, tactic) record.
 *
 * Singleton, debounced JSON store at `.cs-smart-retry-data/retry-history.json`.
 * Mirrors the persistence pattern of CSFlakyTestDetector.
 *
 * Gated by the `SMART_RETRY_ENABLED` config flag (default false) so
 * suites that don't opt in see no behaviour change.
 *
 * @module retry
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import {
    RetryTactic,
    RetryRecord,
    RetryDataStore,
    RetryDecision,
    ALL_RETRY_TACTICS,
} from './CSSmartRetryTypes';

export class CSSmartRetryEngine {
    private static instance: CSSmartRetryEngine;

    private config: CSConfigurationManager;
    private dataStore: RetryDataStore | null = null;
    private dataFilePath: string = '';
    private dirty: boolean = false;
    private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private saving: boolean = false;

    private readonly DATA_STORE_VERSION = 1;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSSmartRetryEngine {
        if (!CSSmartRetryEngine.instance) {
            CSSmartRetryEngine.instance = new CSSmartRetryEngine();
        }
        return CSSmartRetryEngine.instance;
    }

    // ==========================================================================
    // Configuration
    // ==========================================================================

    /** Whether the smart-retry bandit is enabled for this run. */
    public isEnabled(): boolean {
        return this.config.getBoolean('SMART_RETRY_ENABLED', false);
    }

    private getDataDir(): string {
        return this.config.get('SMART_RETRY_DATA_DIR', '.cs-smart-retry-data');
    }

    /** Backoff duration in milliseconds for the `backoff` tactic. */
    private getBackoffMs(): number {
        return this.config.getNumber('SMART_RETRY_BACKOFF_MS', 2000);
    }

    // ==========================================================================
    // Persistence (mirrors CSFlakyTestDetector)
    // ==========================================================================

    private ensureDataStore(): RetryDataStore {
        if (this.dataStore) return this.dataStore;

        const dataDir = path.resolve(process.cwd(), this.getDataDir());
        this.dataFilePath = path.join(dataDir, 'retry-history.json');

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        if (fs.existsSync(this.dataFilePath)) {
            try {
                const raw = fs.readFileSync(this.dataFilePath, 'utf-8');
                this.dataStore = JSON.parse(raw) as RetryDataStore;
                CSReporter.debug(`[SmartRetry] Loaded retry history (${Object.keys(this.dataStore.signatures).length} signatures)`);
            } catch (err) {
                CSReporter.warn(`[SmartRetry] Failed to read retry history, starting fresh: ${(err as Error).message}`);
                this.dataStore = this.createEmptyStore();
            }
        } else {
            this.dataStore = this.createEmptyStore();
        }

        return this.dataStore;
    }

    private createEmptyStore(): RetryDataStore {
        return {
            version: this.DATA_STORE_VERSION,
            lastUpdated: new Date().toISOString(),
            signatures: {},
        };
    }

    private debounceSave(): void {
        if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = setTimeout(() => this.saveToDisk(), 500);
    }

    private saveToDisk(): void {
        if (!this.dirty || this.saving || !this.dataStore) return;
        this.saving = true;
        try {
            const dataDir = path.dirname(this.dataFilePath);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            this.dataStore.lastUpdated = new Date().toISOString();
            fs.writeFileSync(this.dataFilePath, JSON.stringify(this.dataStore, null, 2), 'utf-8');
            this.dirty = false;
            CSReporter.debug('[SmartRetry] Retry history saved');
        } catch (err) {
            CSReporter.warn(`[SmartRetry] Failed to save retry history: ${(err as Error).message}`);
        } finally {
            this.saving = false;
        }
    }

    /** Force an immediate synchronous save (call at process exit). */
    public flush(): void {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
        this.saveToDisk();
    }

    // ==========================================================================
    // Failure signature
    // ==========================================================================

    /**
     * Build a short stable hash that groups "the same kind of failure"
     * together across runs. Inputs:
     *
     *   - the top 3 stack frames after the error message, with file
     *     paths and line numbers normalised so cosmetic moves of the
     *     line number don't change the signature
     *   - the error message, lowercased and stripped of dynamic tokens
     *     (UUIDs, URLs, raw numbers) so a "user-1234 not found" and a
     *     "user-9876 not found" hash to the same signature
     *
     * Output is a 16-hex-char SHA-1 slice — short enough to log, long
     * enough to avoid collisions across thousands of distinct failures.
     */
    public buildSignature(error: Error | { message?: string; stack?: string }): string {
        const stack = error.stack || '';
        const lines = stack.split('\n');
        // Drop the first line (the message itself) and take the next 3 frames.
        const frames = lines
            .slice(1, 4)
            .map(l => l
                .trim()
                .replace(/\([^)]*\)/g, '')           // strip "(at file:line:col)"
                .replace(/:\d+:\d+/g, ':L:C')         // strip line:col positions
                .replace(/[A-Z]:\\[^\s)]+|\/[^\s)]+/g, '<path>') // strip paths
            )
            .filter(l => l.length > 0)
            .join('\n');

        const msg = (error.message || '')
            .toLowerCase()
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
            .replace(/https?:\/\/\S+/g, '<url>')
            .replace(/\b\d+\b/g, '<n>')
            .trim()
            .slice(0, 200);

        const composite = `${msg}\n${frames}`;
        return crypto.createHash('sha1').update(composite).digest('hex').slice(0, 16);
    }

    // ==========================================================================
    // Bandit — UCB1
    // ==========================================================================

    /**
     * Choose the retry tactic most likely to recover this failure.
     *
     * Algorithm: untried tactics are always tried first (exploration);
     * once every tactic has at least one attempt, pick the one with the
     * highest UCB1 score:
     *
     *   ucb1(t) = mean(t) + sqrt(2 * ln(totalAttempts) / attempts(t))
     *
     * UCB1 self-balances exploration and exploitation — no need to
     * tune an ε parameter. Tactics with few attempts get a high
     * exploration bonus; tactics with many attempts converge to their
     * empirical success rate.
     */
    public chooseTactic(signature: string): RetryDecision {
        const store = this.ensureDataStore();
        const sigData = store.signatures[signature] || {};

        // Force exploration: any tactic with zero attempts is tried first.
        const untried = ALL_RETRY_TACTICS.filter(t => !sigData[t] || sigData[t]!.attempts === 0);
        if (untried.length > 0) {
            return {
                tactic: untried[0],
                reason: 'exploration',
                score: 0,
                totalAttempts: 0,
            };
        }

        // All tactics have been tried at least once — pick highest UCB1.
        const totalAttempts = ALL_RETRY_TACTICS.reduce(
            (sum, t) => sum + (sigData[t]?.attempts || 0),
            0,
        );

        let bestTactic: RetryTactic = ALL_RETRY_TACTICS[0];
        let bestScore = -Infinity;

        for (const t of ALL_RETRY_TACTICS) {
            const rec = sigData[t]!;
            const mean = rec.successes / rec.attempts;
            const explore = Math.sqrt((2 * Math.log(totalAttempts)) / rec.attempts);
            const ucb = mean + explore;
            if (ucb > bestScore) {
                bestScore = ucb;
                bestTactic = t;
            }
        }

        return {
            tactic: bestTactic,
            reason: 'ucb1',
            score: Math.round(bestScore * 1000) / 1000,
            totalAttempts,
        };
    }

    /**
     * Record the outcome of a retry attempt. Should be called after
     * the retry chain has fully resolved (passed or failed final).
     */
    public recordOutcome(signature: string, tactic: RetryTactic, recovered: boolean): void {
        const store = this.ensureDataStore();
        if (!store.signatures[signature]) {
            store.signatures[signature] = {};
        }
        const sig = store.signatures[signature];
        if (!sig[tactic]) {
            sig[tactic] = { attempts: 0, successes: 0, lastUsed: new Date().toISOString() };
        }
        const rec = sig[tactic]!;
        rec.attempts += 1;
        if (recovered) rec.successes += 1;
        rec.lastUsed = new Date().toISOString();
        this.dirty = true;
        this.debounceSave();
    }

    // ==========================================================================
    // Tactic execution
    // ==========================================================================

    /**
     * Run the chosen tactic's setup before the retry happens. The
     * caller still drives the recursive scenario execution — this
     * method only performs whatever pre-retry state preparation the
     * tactic requires.
     *
     * `browserManager` is the live CSBrowserManager (passed as `any`
     * to avoid pulling in a heavy import here and to dodge the
     * Playwright-types coupling).
     */
    public async executeTactic(tactic: RetryTactic, browserManager: any): Promise<void> {
        switch (tactic) {
            case 'immediate':
                CSReporter.debug('[SmartRetry] Tactic=immediate — no pre-retry setup');
                return;

            case 'backoff': {
                const ms = this.getBackoffMs();
                CSReporter.debug(`[SmartRetry] Tactic=backoff — sleeping ${ms}ms before retry`);
                await new Promise(resolve => setTimeout(resolve, ms));
                return;
            }

            case 'reload': {
                try {
                    const page = browserManager?.getPage?.();
                    if (page && typeof page.isClosed === 'function' && !page.isClosed()) {
                        CSReporter.debug('[SmartRetry] Tactic=reload — reloading current page');
                        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                    }
                } catch (e) {
                    CSReporter.debug(`[SmartRetry] Tactic=reload failed: ${(e as Error).message}`);
                }
                return;
            }

            case 'fresh-context': {
                try {
                    const context = await browserManager?.getContext?.();
                    if (context) {
                        CSReporter.debug('[SmartRetry] Tactic=fresh-context — clearing cookies / storage');
                        await context.clearCookies?.().catch(() => {});
                        await context.clearPermissions?.().catch(() => {});
                        const pages = typeof context.pages === 'function' ? context.pages() : [];
                        for (const p of pages) {
                            await p.evaluate(() => {
                                try { localStorage.clear(); } catch (e) { /* */ }
                                try { sessionStorage.clear(); } catch (e) { /* */ }
                            }).catch(() => {});
                        }
                    }
                } catch (e) {
                    CSReporter.debug(`[SmartRetry] Tactic=fresh-context failed: ${(e as Error).message}`);
                }
                return;
            }

            default: {
                // Exhaustiveness — if a new tactic is added to the union but not handled.
                const _exhaustive: never = tactic;
                return _exhaustive;
            }
        }
    }

    // ==========================================================================
    // Inspection / reporting
    // ==========================================================================

    /** Return a snapshot of the current bandit state, useful for reports. */
    public snapshot(): RetryDataStore {
        const store = this.ensureDataStore();
        return JSON.parse(JSON.stringify(store)) as RetryDataStore;
    }
}
