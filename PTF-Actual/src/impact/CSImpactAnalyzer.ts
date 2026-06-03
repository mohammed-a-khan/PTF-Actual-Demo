/**
 * CSImpactAnalyzer - Decide which tests must run for a given code change
 *
 * Reads the impact data persisted by `CSImpactCollector`, runs
 * `git diff --name-only <base>...HEAD` to get the changed files, then
 * intersects: any test whose recorded file set overlaps the changed
 * files is kept; tests with recorded data and no overlap are skipped;
 * tests with NO recorded data are kept by default (the safer choice
 * — better to run something we don't have data for than to silently
 * skip it).
 *
 * Pure read-only. The collector writes; the analyzer reads.
 *
 * Singleton.
 *
 * @module impact
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { ImpactDataStore, ImpactFilterResult } from './CSImpactTypes';

export class CSImpactAnalyzer {
    private static instance: CSImpactAnalyzer;
    private config: CSConfigurationManager;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSImpactAnalyzer {
        if (!CSImpactAnalyzer.instance) {
            CSImpactAnalyzer.instance = new CSImpactAnalyzer();
        }
        return CSImpactAnalyzer.instance;
    }

    // ==========================================================================
    // Config
    // ==========================================================================

    /** Only-run-impacted-tests mode for the current run. */
    public isOnlyModeEnabled(): boolean {
        return this.config.getBoolean('IMPACT_ONLY_MODE', false);
    }

    /** Git ref used as the base for the diff (e.g. `origin/main`). */
    public getBaseRef(): string {
        return this.config.get('IMPACT_BASE_REF', 'origin/main');
    }

    private getDataDir(): string {
        return this.config.get('IMPACT_DATA_DIR', '.cs-ai/impact');
    }

    // ==========================================================================
    // Public API
    // ==========================================================================

    /**
     * Compute the set of test ids to run given the configured base ref.
     * Returns null when impact-only mode is disabled OR when something
     * goes wrong (no impact data, git diff failed, etc.) so the caller
     * knows to fall through to the full run.
     */
    public computeFilter(allTestIds: string[]): ImpactFilterResult | null {
        if (!this.isOnlyModeEnabled()) return null;

        const baseRef = this.getBaseRef();
        const changedFiles = this.getChangedFiles(baseRef);
        if (changedFiles === null) {
            CSReporter.warn(
                `[ImpactAnalyzer] Could not compute git diff against ${baseRef}. ` +
                `Falling back to running every test.`,
            );
            return null;
        }

        const store = this.loadStore();
        if (!store) {
            CSReporter.warn(
                '[ImpactAnalyzer] No impact data on disk. Run with IMPACT_COLLECT=true first ' +
                'so the framework can record which files each test touches. ' +
                'Falling back to running every test.',
            );
            return null;
        }

        const changedSet = new Set(changedFiles);
        const affected = new Set<string>();
        const skipped = new Set<string>();
        const unknown = new Set<string>();

        for (const testId of allTestIds) {
            const rec = store.tests[testId];
            if (!rec || rec.files.length === 0) {
                // No data — default to running. Safer than skipping silently.
                unknown.add(testId);
                affected.add(testId);
                continue;
            }
            const hit = rec.files.some(f => changedSet.has(f));
            if (hit) {
                affected.add(testId);
            } else {
                skipped.add(testId);
            }
        }

        const known = allTestIds.length - unknown.size;
        const knownPct = allTestIds.length > 0
            ? Math.round((known / allTestIds.length) * 100)
            : 0;
        const summary =
            `Impact analysis (${baseRef}): ${changedFiles.length} changed file(s); ` +
            `${affected.size} test(s) to run, ${skipped.size} skipped, ` +
            `${unknown.size} unknown (no data — running anyway). ` +
            `Coverage: ${known}/${allTestIds.length} tests (${knownPct}%) have recorded impact data.`;

        return { baseRef, changedFiles, affectedTestIds: affected, skippedTestIds: skipped, unknownTestIds: unknown, summary };
    }

    // ==========================================================================
    // Internals
    // ==========================================================================

    /**
     * Returns the list of changed files (repo-relative POSIX paths) or
     * null if git is unavailable / the ref is unknown / we're not in a
     * git repo. Output is normalised to POSIX forward slashes.
     */
    public getChangedFiles(baseRef: string): string[] | null {
        try {
            // `git diff --name-only A...HEAD` lists files changed in the
            // current branch relative to the common ancestor with A.
            // This matches what a typical PR diff shows in CI.
            const output = execSync(
                `git diff --name-only ${baseRef}...HEAD`,
                { encoding: 'utf-8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] },
            );
            return output
                .split(/\r?\n/)
                .map(s => s.trim())
                .filter(s => s.length > 0)
                .map(s => s.split(path.sep).join('/'));
        } catch (e) {
            return null;
        }
    }

    private loadStore(): ImpactDataStore | null {
        const dir = path.resolve(process.cwd(), this.getDataDir());
        const file = path.join(dir, 'impact-data.json');
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8')) as ImpactDataStore;
        } catch (e) {
            CSReporter.warn(`[ImpactAnalyzer] Failed to read impact store: ${(e as Error).message}`);
            return null;
        }
    }
}
