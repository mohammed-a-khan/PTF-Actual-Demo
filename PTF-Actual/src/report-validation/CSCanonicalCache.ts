/**
 * CS Report Validation — Canonical cache.
 *
 * Report ingestion is expensive: a 100-page PDF runs through pdfjs parsing +
 * per-page layout analysis + column KDE + section detection + row stitching —
 * seconds of CPU per file. When the same file is re-ingested across
 * scenarios (e.g. Crystal reference read twice: once for parity, once for
 * DB check) that whole pipeline runs again.
 *
 * `CSCanonicalCache` is a small in-memory cache keyed by
 * `(filePath, mtime, size, source, spec-fingerprint)`. Hits return the
 * cached `CanonicalReport` verbatim; misses run the pipeline and populate.
 *
 * KEY DESIGN
 * ----------
 *   - `mtimeMs + size` is the classic content-invariant signal — cheap
 *     (single fs.stat call), avoids re-hashing 100MB files.
 *   - `spec fingerprint` is a stable JSON serialization hashed via FNV-1a
 *     32; any change to fieldMap, tolerances, requiredSections etc.
 *     invalidates the cache automatically. Cheap, deterministic, no
 *     false collisions at typical spec sizes.
 *   - `source` is part of the key because the same file could feasibly be
 *     ingested with `source: 'crystal'` and `source: 'ssrs'` — different
 *     canonicals (different fieldMap branches on the spec).
 *
 * EVICTION
 * --------
 * Simple LRU with a configurable capacity (default 32). Chosen because
 * report canonicals are large (hundreds of KB each for realistic runs) and
 * 32 caches an entire test run's worth of files while keeping RAM predictable.
 *
 * @module report-validation/CSCanonicalCache
 */

import * as fs from 'fs';

import type { CanonicalReport, ReportSource } from './CSReportModel';
import type { ReportSpec } from './CSReportSpec';

/** Composite cache key. Callers can build it themselves or use `keyFor(...)`. */
export type CanonicalCacheKey = string;

/** Options for constructing a cache. */
export interface CanonicalCacheOptions {
    /** Maximum entries retained. Older-touched entries evict first. Default 32. */
    maxEntries?: number;
}

/**
 * Small LRU cache. Not thread-safe (Node is single-threaded); each worker process
 * gets its own instance via the service singleton path.
 */
export class CSCanonicalCache {
    private readonly maxEntries: number;
    private readonly map = new Map<CanonicalCacheKey, CanonicalReport>();

    constructor(opts: CanonicalCacheOptions = {}) {
        this.maxEntries = Math.max(1, opts.maxEntries ?? 32);
    }

    /** Number of entries currently stored. */
    get size(): number {
        return this.map.size;
    }

    /** Fetch — returns undefined on miss. Touches the entry to be the most-recently-used. */
    get(key: CanonicalCacheKey): CanonicalReport | undefined {
        const value = this.map.get(key);
        if (value === undefined) return undefined;
        // Move to tail (most recently used).
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    /** Store — evicts the oldest entry when at capacity. */
    set(key: CanonicalCacheKey, value: CanonicalReport): void {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.map.delete(oldest);
        }
    }

    /** True when a key is present. Does NOT touch LRU order. */
    has(key: CanonicalCacheKey): boolean {
        return this.map.has(key);
    }

    /** Wipe the cache. Useful between test suites. */
    clear(): void {
        this.map.clear();
    }

    /**
     * Build the canonical cache key for a file+spec+source triple. `filePath` is stat'd
     * to pick up mtime + size. Throws when the file doesn't exist — caller passes an
     * absolute path known to exist (the service checks before calling).
     */
    static keyFor(filePath: string, source: ReportSource, spec: ReportSpec): CanonicalCacheKey {
        const stat = fs.statSync(filePath);
        return `${filePath}|${stat.mtimeMs}|${stat.size}|${source}|${specFingerprint(spec)}`;
    }
}

/**
 * Stable hash of a spec so any semantically-meaningful change invalidates cached canonicals.
 * We include the fields the ingestion pipeline reads: reportType, keyColumns, fieldMap,
 * dateFormats, ignoreFields, requiredSections, ocrFallback. `tolerances`, `knownDifferences`,
 * `enforceChecksums`, `checksumTolerance` are RECONCILER inputs — they don't change what a
 * canonical looks like, so we deliberately exclude them (spec-tuning during test authorship
 * doesn't need to re-parse the underlying PDF).
 */
export function specFingerprint(spec: ReportSpec): string {
    const shape = {
        reportType: spec.reportType,
        project: spec.project,
        keyColumns: spec.keyColumns,
        fieldMap: sortedObject(spec.fieldMap),
        dateFormats: spec.dateFormats,
        ignoreFields: [...spec.ignoreFields].sort(),
        requiredSections: spec.requiredSections.map((r) => ({
            id: r.id, title: r.title, order: r.order, matchers: r.matchers ?? [],
        })),
        ocrFallback: !!spec.ocrFallback,
    };
    return fnv1a32(JSON.stringify(shape));
}

function sortedObject<T>(obj: Record<string, T>): Record<string, T> {
    const out: Record<string, T> = {};
    for (const k of Object.keys(obj).sort()) out[k] = obj[k];
    return out;
}

function fnv1a32(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
