/**
 * CSVisualBaselineStore — adaptive per-region tolerance learning
 *
 * B2 addition (2026-05-26): fixed thresholds for visual comparison are
 * the source of nearly all false positives in visual regression — a
 * page might routinely vary by SSIM 0.985 due to anti-aliasing,
 * sub-pixel rendering or JIT animation. A static threshold of 0.99 then
 * fails every run.
 *
 * This store tracks a rolling window of "stable" diff scores per
 * (snapshotName, algorithm) pair. The effective threshold becomes
 *
 *   threshold = mean(scores) − k · stddev(scores)   [for SSIM-like]
 *   threshold = mean(scores) + k · stddev(scores)   [for distance-like]
 *
 * so the framework only flags a comparison when its score is clearly
 * outside the natural noise of that region.
 *
 * Singleton, debounced JSON store. Same persistence pattern as
 * CSFlakyTestDetector and CSSmartRetryEngine.
 *
 * Gated by `VISUAL_AI_LEARNED_TOLERANCE_ENABLED` (default false) so
 * suites that don't opt in see the existing fixed-threshold behaviour.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

export type VisualAlgorithm = 'ssim' | 'phash-dct' | 'phash-avg' | 'pixel';

/**
 * Higher / lower direction the metric improves in. SSIM is 'higher'
 * (closer to 1 = better); Hamming distances are 'lower' (closer to 0
 * = better).
 */
export type ScoreDirection = 'higher-is-better' | 'lower-is-better';

interface BaselineRecord {
    algorithm: VisualAlgorithm;
    direction: ScoreDirection;
    samples: number[]; // rolling window of recent stable scores
    lastUpdated: string;
}

interface BaselineDataStore {
    version: number;
    lastUpdated: string;
    /** Keyed by `${snapshotName}__${algorithm}` */
    entries: Record<string, BaselineRecord>;
}

export class CSVisualBaselineStore {
    private static instance: CSVisualBaselineStore;

    private config: CSConfigurationManager;
    private dataStore: BaselineDataStore | null = null;
    private dataFilePath: string = '';
    private dirty: boolean = false;
    private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private saving: boolean = false;
    private readonly DATA_STORE_VERSION = 1;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSVisualBaselineStore {
        if (!CSVisualBaselineStore.instance) {
            CSVisualBaselineStore.instance = new CSVisualBaselineStore();
        }
        return CSVisualBaselineStore.instance;
    }

    // ==========================================================================
    // Config
    // ==========================================================================

    public isEnabled(): boolean {
        return this.config.getBoolean('VISUAL_AI_LEARNED_TOLERANCE_ENABLED', false);
    }

    private getWindowSize(): number {
        return this.config.getNumber('VISUAL_AI_LEARNED_TOLERANCE_WINDOW', 20);
    }

    private getKFactor(): number {
        return this.config.getNumber('VISUAL_AI_LEARNED_TOLERANCE_K', 3);
    }

    private getDataDir(): string {
        return this.config.get('VISUAL_AI_BASELINE_STORE_DIR', '.cs-visual-baseline-store');
    }

    // ==========================================================================
    // Persistence
    // ==========================================================================

    private ensureDataStore(): BaselineDataStore {
        if (this.dataStore) return this.dataStore;
        const dataDir = path.resolve(process.cwd(), this.getDataDir());
        this.dataFilePath = path.join(dataDir, 'baseline-tolerances.json');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        if (fs.existsSync(this.dataFilePath)) {
            try {
                this.dataStore = JSON.parse(fs.readFileSync(this.dataFilePath, 'utf-8')) as BaselineDataStore;
                CSReporter.debug(`[VisualBaselineStore] Loaded ${Object.keys(this.dataStore.entries).length} tolerance records`);
            } catch (err) {
                CSReporter.warn(`[VisualBaselineStore] Failed to read store, starting fresh: ${(err as Error).message}`);
                this.dataStore = this.createEmptyStore();
            }
        } else {
            this.dataStore = this.createEmptyStore();
        }
        return this.dataStore;
    }

    private createEmptyStore(): BaselineDataStore {
        return { version: this.DATA_STORE_VERSION, lastUpdated: new Date().toISOString(), entries: {} };
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
            CSReporter.debug('[VisualBaselineStore] Saved');
        } catch (err) {
            CSReporter.warn(`[VisualBaselineStore] Failed to save: ${(err as Error).message}`);
        } finally {
            this.saving = false;
        }
    }

    public flush(): void {
        if (this.saveDebounceTimer) { clearTimeout(this.saveDebounceTimer); this.saveDebounceTimer = null; }
        this.saveToDisk();
    }

    // ==========================================================================
    // Public API
    // ==========================================================================

    private key(snapshotName: string, algorithm: VisualAlgorithm): string {
        return `${snapshotName}__${algorithm}`;
    }

    /**
     * Record a score from a comparison that the user (or the run as a
     * whole) considered stable / passed. Used to grow the rolling
     * sample.
     */
    public recordStableScore(
        snapshotName: string,
        algorithm: VisualAlgorithm,
        direction: ScoreDirection,
        score: number,
    ): void {
        const store = this.ensureDataStore();
        const k = this.key(snapshotName, algorithm);
        const win = this.getWindowSize();
        if (!store.entries[k]) {
            store.entries[k] = { algorithm, direction, samples: [], lastUpdated: new Date().toISOString() };
        }
        const rec = store.entries[k];
        rec.samples.push(score);
        if (rec.samples.length > win) {
            rec.samples = rec.samples.slice(rec.samples.length - win);
        }
        rec.lastUpdated = new Date().toISOString();
        rec.direction = direction;
        this.dirty = true;
        this.debounceSave();
    }

    /**
     * Compute an adaptive threshold for this (snapshot, algorithm). If
     * we have ≥ 3 stable samples, returns `mean ± k · stddev` per the
     * direction. Otherwise returns null (caller should fall back to
     * the static threshold from config).
     */
    public getAdaptiveThreshold(snapshotName: string, algorithm: VisualAlgorithm): number | null {
        if (!this.isEnabled()) return null;
        const store = this.ensureDataStore();
        const rec = store.entries[this.key(snapshotName, algorithm)];
        if (!rec || rec.samples.length < 3) return null;

        const mean = rec.samples.reduce((s, v) => s + v, 0) / rec.samples.length;
        const variance = rec.samples.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rec.samples.length;
        const stddev = Math.sqrt(variance);
        const k = this.getKFactor();

        return rec.direction === 'higher-is-better'
            ? mean - k * stddev   // SSIM: anything below this is suspicious
            : mean + k * stddev;  // Hamming distance: anything above is suspicious
    }

    /** Inspection helper for reports. */
    public snapshot(): BaselineDataStore {
        return JSON.parse(JSON.stringify(this.ensureDataStore())) as BaselineDataStore;
    }
}
