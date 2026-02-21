/**
 * CSElementCache - Persistent Cross-Run Element Cache
 *
 * Stores successful element matches in a local JSON file for cross-run learning.
 * On subsequent runs, cache lookup is attempted first for instant, high-confidence matches.
 *
 * Features:
 *   - TTL-based invalidation (configurable, default 24h)
 *   - Fingerprint divergence detection
 *   - Success rate tracking per page URL pattern
 *   - Automatic cache eviction for stale entries
 *   - Adaptive confidence threshold per page (Phase 3 integration)
 *
 * Zero external dependencies — local file I/O only.
 *
 * @module ai/step-engine
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../../reporter/CSReporter';
import { ElementFingerprint, StoredFingerprint } from './CSElementFingerprint';

/** Cache entry for a successfully matched element */
export interface CacheEntry {
    /** Lookup key (URL pattern + instruction) */
    key: string;
    /** Stored element fingerprint */
    fingerprint: ElementFingerprint;
    /** Locator strategy that worked */
    locatorStrategy: string;
    /** Locator description (e.g., "getByRole('button', { name: 'Submit' })") */
    locatorDescription: string;
    /** Match confidence when cached */
    confidence: number;
    /** Number of successful uses */
    successCount: number;
    /** Number of failed uses (for eviction decisions) */
    failureCount: number;
    /** Timestamp of creation */
    createdAt: number;
    /** Timestamp of last successful use */
    lastUsed: number;
}

/** Page statistics for adaptive confidence */
export interface PageStats {
    /** URL pattern (path without query/hash) */
    urlPattern: string;
    /** Total element searches on this page */
    totalSearches: number;
    /** Successful matches */
    successfulMatches: number;
    /** Average confidence of successful matches */
    avgConfidence: number;
    /** Recommended confidence threshold override */
    recommendedThreshold: number;
    /** Last updated */
    lastUpdated: number;
}

/** Complete cache structure */
interface CacheStore {
    version: number;
    entries: Record<string, CacheEntry>;
    pageStats: Record<string, PageStats>;
    lastCleanup: number;
}

export class CSElementCache {
    private static instance: CSElementCache;
    private cache: CacheStore;
    private cacheFilePath: string;
    private dirty: boolean = false;
    private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    /** Default cache TTL: 24 hours */
    private readonly DEFAULT_TTL = 24 * 60 * 60 * 1000;
    /** Maximum cache entries */
    private readonly MAX_ENTRIES = 5000;
    /** Cleanup interval: 1 hour */
    private readonly CLEANUP_INTERVAL = 60 * 60 * 1000;

    private constructor(cacheDir?: string) {
        const dir = cacheDir || path.join(process.cwd(), '.ai-step-cache');
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch { /* may already exist */ }
        }
        this.cacheFilePath = path.join(dir, 'element-cache.json');
        this.cache = this.loadCache();
    }

    public static getInstance(cacheDir?: string): CSElementCache {
        if (!CSElementCache.instance) {
            CSElementCache.instance = new CSElementCache(cacheDir);
        }
        return CSElementCache.instance;
    }

    /**
     * Look up a cached element match.
     *
     * @param key - Cache key (URL + instruction)
     * @param ttl - TTL override in ms (default: 24h)
     * @returns CacheEntry if found and valid, null otherwise
     */
    public get(key: string, ttl?: number): CacheEntry | null {
        const entry = this.cache.entries[key];
        if (!entry) return null;

        const maxAge = ttl || this.DEFAULT_TTL;
        const age = Date.now() - entry.lastUsed;

        // Check TTL
        if (age > maxAge) {
            CSReporter.debug(`CSElementCache: Entry expired (age: ${Math.round(age / 1000)}s, TTL: ${Math.round(maxAge / 1000)}s)`);
            delete this.cache.entries[key];
            this.dirty = true;
            return null;
        }

        // Check failure rate — if > 50% failures, evict
        if (entry.failureCount > 0 && entry.failureCount / (entry.successCount + entry.failureCount) > 0.5) {
            CSReporter.debug(`CSElementCache: Entry evicted due to high failure rate (${entry.failureCount}/${entry.successCount + entry.failureCount})`);
            delete this.cache.entries[key];
            this.dirty = true;
            return null;
        }

        return entry;
    }

    /**
     * Store a successful element match in the cache.
     *
     * @param key - Cache key (URL + instruction)
     * @param fingerprint - Element fingerprint
     * @param locatorStrategy - Strategy used (e.g., 'accessibility-tree')
     * @param locatorDescription - Human-readable locator description
     * @param confidence - Match confidence
     */
    public set(
        key: string,
        fingerprint: ElementFingerprint,
        locatorStrategy: string,
        locatorDescription: string,
        confidence: number
    ): void {
        const existing = this.cache.entries[key];

        if (existing) {
            // Update existing entry
            existing.fingerprint = fingerprint;
            existing.locatorStrategy = locatorStrategy;
            existing.locatorDescription = locatorDescription;
            existing.confidence = confidence;
            existing.successCount++;
            existing.lastUsed = Date.now();
        } else {
            // Create new entry
            this.cache.entries[key] = {
                key,
                fingerprint,
                locatorStrategy,
                locatorDescription,
                confidence,
                successCount: 1,
                failureCount: 0,
                createdAt: Date.now(),
                lastUsed: Date.now()
            };
        }

        this.dirty = true;
        this.debounceSave();

        // Periodic cleanup
        if (Date.now() - this.cache.lastCleanup > this.CLEANUP_INTERVAL) {
            this.cleanup();
        }
    }

    /**
     * Record a cache miss (element not found using cached strategy).
     * Used for adaptive eviction.
     */
    public recordFailure(key: string): void {
        const entry = this.cache.entries[key];
        if (entry) {
            entry.failureCount++;
            this.dirty = true;
            this.debounceSave();
        }
    }

    /**
     * Update page statistics for adaptive confidence threshold.
     *
     * @param urlPattern - Normalized URL pattern
     * @param success - Whether the element search succeeded
     * @param confidence - Match confidence (if successful)
     */
    public updatePageStats(urlPattern: string, success: boolean, confidence: number = 0): void {
        const existing = this.cache.pageStats[urlPattern];

        if (existing) {
            existing.totalSearches++;
            if (success) {
                existing.successfulMatches++;
                existing.avgConfidence = (existing.avgConfidence * (existing.successfulMatches - 1) + confidence) / existing.successfulMatches;
            }
            existing.recommendedThreshold = this.calculateRecommendedThreshold(existing);
            existing.lastUpdated = Date.now();
        } else {
            this.cache.pageStats[urlPattern] = {
                urlPattern,
                totalSearches: 1,
                successfulMatches: success ? 1 : 0,
                avgConfidence: success ? confidence : 0,
                recommendedThreshold: 0.6, // Default
                lastUpdated: Date.now()
            };
        }

        this.dirty = true;
    }

    /**
     * Get page statistics for adaptive confidence threshold.
     */
    public getPageStats(urlPattern: string): PageStats | null {
        return this.cache.pageStats[urlPattern] || null;
    }

    /**
     * Get the recommended confidence threshold for a page.
     * Returns null if not enough data to make a recommendation.
     */
    public getRecommendedThreshold(urlPattern: string): number | null {
        const stats = this.cache.pageStats[urlPattern];
        if (!stats || stats.totalSearches < 5) return null; // Need at least 5 data points
        return stats.recommendedThreshold;
    }

    /**
     * Calculate recommended confidence threshold based on page history.
     */
    private calculateRecommendedThreshold(stats: PageStats): number {
        const successRate = stats.totalSearches > 0 ? stats.successfulMatches / stats.totalSearches : 0;

        if (successRate < 0.5) {
            // Low success rate — lower threshold to be more permissive
            return Math.max(0.4, stats.avgConfidence * 0.8);
        } else if (successRate > 0.9 && stats.avgConfidence > 0.7) {
            // High success rate with good confidence — can be stricter
            return Math.min(0.7, stats.avgConfidence * 0.9);
        }

        return 0.6; // Default threshold
    }

    /**
     * Remove expired and low-quality entries.
     */
    public cleanup(): void {
        const now = Date.now();
        let removed = 0;

        for (const [key, entry] of Object.entries(this.cache.entries)) {
            const age = now - entry.lastUsed;
            // Remove entries older than 7 days
            if (age > 7 * 24 * 60 * 60 * 1000) {
                delete this.cache.entries[key];
                removed++;
                continue;
            }
            // Remove entries with very high failure rate
            const total = entry.successCount + entry.failureCount;
            if (total > 3 && entry.failureCount / total > 0.7) {
                delete this.cache.entries[key];
                removed++;
            }
        }

        // If still too many entries, remove oldest
        const entries = Object.entries(this.cache.entries);
        if (entries.length > this.MAX_ENTRIES) {
            entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
            const toRemove = entries.length - this.MAX_ENTRIES;
            for (let i = 0; i < toRemove; i++) {
                delete this.cache.entries[entries[i][0]];
                removed++;
            }
        }

        // Clean old page stats (older than 30 days)
        for (const [key, stats] of Object.entries(this.cache.pageStats)) {
            if (now - stats.lastUpdated > 30 * 24 * 60 * 60 * 1000) {
                delete this.cache.pageStats[key];
            }
        }

        this.cache.lastCleanup = now;
        this.dirty = true;

        if (removed > 0) {
            CSReporter.debug(`CSElementCache: Cleaned up ${removed} stale entries`);
        }

        this.saveCache();
    }

    /**
     * Get cache statistics.
     */
    public getStats(): { entries: number; pagePatterns: number; totalSuccesses: number } {
        const entries = Object.keys(this.cache.entries).length;
        const pagePatterns = Object.keys(this.cache.pageStats).length;
        const totalSuccesses = Object.values(this.cache.entries)
            .reduce((sum, e) => sum + e.successCount, 0);
        return { entries, pagePatterns, totalSuccesses };
    }

    /**
     * Clear the entire cache.
     */
    public clear(): void {
        this.cache = {
            version: 1,
            entries: {},
            pageStats: {},
            lastCleanup: Date.now()
        };
        this.dirty = true;
        this.saveCache();
    }

    /**
     * Load cache from disk.
     */
    private loadCache(): CacheStore {
        try {
            if (fs.existsSync(this.cacheFilePath)) {
                const data = fs.readFileSync(this.cacheFilePath, 'utf-8');
                const parsed = JSON.parse(data);
                if (parsed.version === 1) {
                    CSReporter.debug(`CSElementCache: Loaded ${Object.keys(parsed.entries || {}).length} cached entries`);
                    return parsed;
                }
            }
        } catch (error: any) {
            CSReporter.debug(`CSElementCache: Failed to load cache: ${error.message}`);
        }

        return {
            version: 1,
            entries: {},
            pageStats: {},
            lastCleanup: Date.now()
        };
    }

    /**
     * Save cache to disk.
     */
    private saveCache(): void {
        if (!this.dirty) return;

        try {
            const data = JSON.stringify(this.cache, null, 2);
            fs.writeFileSync(this.cacheFilePath, data, 'utf-8');
            this.dirty = false;
        } catch (error: any) {
            CSReporter.debug(`CSElementCache: Failed to save cache: ${error.message}`);
        }
    }

    /**
     * Debounced save — prevents excessive disk writes during rapid cache updates.
     */
    private debounceSave(): void {
        if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = setTimeout(() => {
            this.saveCache();
        }, 2000);
    }

    /**
     * Force save (call on test teardown).
     */
    public flush(): void {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
            this.saveDebounceTimer = null;
        }
        this.saveCache();
    }
}
