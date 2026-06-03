/**
 * CSImpactCollector - Records which files each scenario exercises.
 *
 * V1 strategy: per-scenario diff of `require.cache` keys. Before a
 * scenario runs, snapshot the keys; after it finishes, the new keys
 * are files that scenario caused to load. Repo-relative POSIX paths
 * are persisted to `.cs-ai/impact/impact-data.json` and merged across
 * runs.
 *
 * Limitation by design: Node loads each file once per process. If
 * scenario A runs before B and both use `LoginPage.ts`, only A's
 * record will list it on the first run. Across multiple runs the
 * union accumulates and the data self-corrects (the file shows up in
 * whichever scenario loaded it cold each time). The analyzer's
 * default-to-run policy for tests with no recorded data protects
 * correctness in the meantime.
 *
 * Singleton, debounced JSON store. Same persistence pattern as
 * CSFlakyTestDetector / CSSmartRetryEngine / CSVisualBaselineStore.
 *
 * @module impact
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { ImpactDataStore, TestImpactRecord } from './CSImpactTypes';

export class CSImpactCollector {
    private static instance: CSImpactCollector;
    private config: CSConfigurationManager;
    private dataStore: ImpactDataStore | null = null;
    private dataFilePath: string = '';
    private dirty: boolean = false;
    private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private saving: boolean = false;
    private readonly DATA_STORE_VERSION = 1;

    /** Per-scenario in-flight state. Keyed by testId. */
    private inFlight = new Map<string, Set<string>>();
    /** Cached process working directory; computed once. */
    private repoRoot: string = '';

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.repoRoot = process.cwd();
    }

    public static getInstance(): CSImpactCollector {
        if (!CSImpactCollector.instance) {
            CSImpactCollector.instance = new CSImpactCollector();
        }
        return CSImpactCollector.instance;
    }

    // ==========================================================================
    // Config
    // ==========================================================================

    /** Master switch for collecting impact data during this run. */
    public isCollectionEnabled(): boolean {
        return this.config.getBoolean('IMPACT_COLLECT', false);
    }

    private getDataDir(): string {
        return this.config.get('IMPACT_DATA_DIR', '.cs-ai/impact');
    }

    // ==========================================================================
    // Persistence
    // ==========================================================================

    private ensureDataStore(): ImpactDataStore {
        if (this.dataStore) return this.dataStore;
        const dataDir = path.resolve(this.repoRoot, this.getDataDir());
        this.dataFilePath = path.join(dataDir, 'impact-data.json');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        if (fs.existsSync(this.dataFilePath)) {
            try {
                this.dataStore = JSON.parse(fs.readFileSync(this.dataFilePath, 'utf-8')) as ImpactDataStore;
                CSReporter.debug(
                    `[ImpactCollector] Loaded impact data: ${Object.keys(this.dataStore.tests).length} test records`,
                );
            } catch (e) {
                CSReporter.warn(`[ImpactCollector] Failed to read impact data, starting fresh: ${(e as Error).message}`);
                this.dataStore = this.createEmpty();
            }
        } else {
            this.dataStore = this.createEmpty();
        }
        return this.dataStore;
    }

    private createEmpty(): ImpactDataStore {
        return { version: this.DATA_STORE_VERSION, lastUpdated: new Date().toISOString(), tests: {} };
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
            CSReporter.debug('[ImpactCollector] Impact data saved');
        } catch (e) {
            CSReporter.warn(`[ImpactCollector] Failed to save impact data: ${(e as Error).message}`);
        } finally {
            this.saving = false;
        }
    }

    public flush(): void {
        if (this.saveDebounceTimer) { clearTimeout(this.saveDebounceTimer); this.saveDebounceTimer = null; }
        this.saveToDisk();
    }

    // ==========================================================================
    // Scenario lifecycle hooks
    // ==========================================================================

    /**
     * Snapshot the current require.cache keys before a scenario runs.
     * Called by the BDD runner just before scenario execution.
     */
    public startScenario(testId: string): void {
        if (!this.isCollectionEnabled()) return;
        this.inFlight.set(testId, new Set<string>(Object.keys(require.cache)));
    }

    /**
     * Finalise a scenario's file set: the new entries in require.cache
     * (relative to the pre-scenario snapshot) are merged into the
     * test's cumulative record.
     */
    public stopScenario(testId: string, testName: string, featureFile: string): void {
        if (!this.isCollectionEnabled()) return;
        const before = this.inFlight.get(testId);
        if (!before) return;
        this.inFlight.delete(testId);

        const after = new Set<string>(Object.keys(require.cache));
        const newPaths: string[] = [];
        for (const k of after) {
            if (!before.has(k)) newPaths.push(k);
        }

        const relPaths = newPaths
            .map(p => this.toRepoRelative(p))
            .filter((p): p is string => p !== null);

        if (relPaths.length === 0) {
            // No new files loaded for this scenario — still bump the run count so
            // we know we've recorded data for it.
            this.bumpRunCount(testId, testName, featureFile);
            return;
        }

        const store = this.ensureDataStore();
        const existing = store.tests[testId];
        if (!existing) {
            store.tests[testId] = {
                testId, testName, featureFile,
                files: dedupeSorted(relPaths),
                runCount: 1,
                lastUpdated: new Date().toISOString(),
            };
        } else {
            const merged = new Set<string>([...existing.files, ...relPaths]);
            existing.files = dedupeSorted([...merged]);
            existing.runCount += 1;
            existing.testName = testName;     // keep display name fresh in case of renames
            existing.featureFile = featureFile;
            existing.lastUpdated = new Date().toISOString();
        }
        this.dirty = true;
        this.debounceSave();
    }

    private bumpRunCount(testId: string, testName: string, featureFile: string): void {
        const store = this.ensureDataStore();
        if (!store.tests[testId]) {
            store.tests[testId] = {
                testId, testName, featureFile, files: [],
                runCount: 1, lastUpdated: new Date().toISOString(),
            };
            this.dirty = true;
        } else {
            store.tests[testId].runCount += 1;
            store.tests[testId].lastUpdated = new Date().toISOString();
            this.dirty = true;
        }
        this.debounceSave();
    }

    /**
     * Normalise an absolute path coming from require.cache into a
     * repo-relative POSIX path. Returns null when the path is outside
     * the repo (e.g. node_modules) or is something we don't care about
     * (built-ins, bundler-injected modules).
     */
    private toRepoRelative(abs: string): string | null {
        if (!abs || typeof abs !== 'string') return null;
        // Skip node modules and built-ins by name pattern. These move
        // around between machines and aren't part of the source under
        // change-based selection anyway.
        if (abs.includes(`${path.sep}node_modules${path.sep}`)) return null;
        if (!path.isAbsolute(abs)) return null;
        try {
            const rel = path.relative(this.repoRoot, abs);
            if (rel.startsWith('..')) return null; // outside the repo
            return rel.split(path.sep).join('/');
        } catch {
            return null;
        }
    }

    /** Inspection helper. */
    public snapshot(): ImpactDataStore {
        return JSON.parse(JSON.stringify(this.ensureDataStore())) as ImpactDataStore;
    }
}

function dedupeSorted(arr: string[]): string[] {
    return Array.from(new Set(arr)).sort();
}
