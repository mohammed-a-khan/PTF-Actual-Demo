/**
 * In-session LRU + TTL cache for read-heavy ADO metadata.
 *
 * Iteration lookups, area-path enumeration, team settings, config resolution —
 * these hit the same URLs over and over inside a single MCP invocation. Cache
 * them for a few minutes and every downstream tool speeds up without any of
 * them needing to know the cache exists.
 *
 * Bounded on BOTH size (evict LRU when at cap) and TTL (drop stale entries on
 * read). Zero external deps.
 */

export interface LruStats {
    size: number;
    maxSize: number;
    hits: number;
    misses: number;
    evictionsBySize: number;
    evictionsByTtl: number;
}

interface Entry<V> {
    value: V;
    expiresAt: number;
}

export class LruCache<K, V> {
    private readonly maxSize: number;
    private readonly ttlMs: number;
    /** Map preserves insertion order in JS — we re-insert on get to bump to MRU. */
    private readonly store = new Map<K, Entry<V>>();
    private hits = 0;
    private misses = 0;
    private evictionsBySize = 0;
    private evictionsByTtl = 0;

    constructor(opts: { maxSize?: number; ttlMs?: number } = {}) {
        this.maxSize = Math.max(1, opts.maxSize ?? 100);
        this.ttlMs = Math.max(0, opts.ttlMs ?? 5 * 60 * 1000);
    }

    public get(key: K): V | undefined {
        const entry = this.store.get(key);
        if (!entry) {
            this.misses++;
            return undefined;
        }
        if (this.ttlMs > 0 && entry.expiresAt <= Date.now()) {
            this.store.delete(key);
            this.evictionsByTtl++;
            this.misses++;
            return undefined;
        }
        // Bump to MRU by re-inserting.
        this.store.delete(key);
        this.store.set(key, entry);
        this.hits++;
        return entry.value;
    }

    public set(key: K, value: V): void {
        const expiresAt = this.ttlMs > 0 ? Date.now() + this.ttlMs : Number.POSITIVE_INFINITY;
        // Overwrite existing key first so it bumps to MRU.
        if (this.store.has(key)) this.store.delete(key);
        this.store.set(key, { value, expiresAt });
        // Evict oldest until at cap.
        while (this.store.size > this.maxSize) {
            const oldest = this.store.keys().next().value;
            if (oldest === undefined) break;
            this.store.delete(oldest as K);
            this.evictionsBySize++;
        }
    }

    public has(key: K): boolean {
        const entry = this.store.get(key);
        if (!entry) return false;
        if (this.ttlMs > 0 && entry.expiresAt <= Date.now()) {
            this.store.delete(key);
            this.evictionsByTtl++;
            return false;
        }
        return true;
    }

    public delete(key: K): boolean {
        return this.store.delete(key);
    }

    public clear(): void {
        this.store.clear();
        // Stats are lifetime — clear() does NOT reset them.
    }

    public stats(): LruStats {
        return {
            size: this.store.size,
            maxSize: this.maxSize,
            hits: this.hits,
            misses: this.misses,
            evictionsBySize: this.evictionsBySize,
            evictionsByTtl: this.evictionsByTtl,
        };
    }
}
