// src/database/context/CSQueryResultCache.ts

import { ResultSet } from '../types/database.types';
import { CSReporter } from '../../reporter/CSReporter';

/**
 * Cached query result with metadata
 */
export interface CachedQueryResult {
    /** Unique identifier for the cached result */
    id: string;
    /** The actual query results */
    results: any[];
    /** Original SQL query that generated these results */
    query?: string;
    /** Parameters used in the query */
    parameters?: any[];
    /** Database connection name/alias used */
    connectionName?: string;
    /** Timestamp when the result was cached */
    timestamp: Date;
    /** Row count for quick access */
    rowCount: number;
    /** Column names in the result set */
    columns: string[];
    /** Metadata about the result set */
    metadata?: Record<string, any>;
}

/**
 * Query Result Cache for storing and retrieving database query results
 * for validation against API responses.
 *
 * This singleton class manages a cache of database query results that can be
 * referenced by name in test scenarios for API-Database validation.
 */
export class CSQueryResultCache {
    private static instance: CSQueryResultCache;
    private cache: Map<string, CachedQueryResult>;
    private maxCacheSize: number;
    private defaultTTL: number; // Time to live in milliseconds

    private constructor() {
        this.cache = new Map();
        this.maxCacheSize = 100; // Maximum number of cached results
        this.defaultTTL = 300000; // 5 minutes default TTL
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): CSQueryResultCache {
        if (!CSQueryResultCache.instance) {
            CSQueryResultCache.instance = new CSQueryResultCache();
        }
        return CSQueryResultCache.instance;
    }

    /**
     * Store query results in cache
     *
     * @param name - Unique identifier for the result set
     * @param results - Query results to cache
     * @param metadata - Optional metadata (query, parameters, connection)
     */
    public store(
        name: string,
        results: any[],
        metadata?: {
            query?: string;
            parameters?: any[];
            connectionName?: string;
            columns?: string[];
            additionalMetadata?: Record<string, any>;
        }
    ): void {
        // Check cache size limit
        if (this.cache.size >= this.maxCacheSize && !this.cache.has(name)) {
            // Remove oldest entry
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
                CSReporter.debug(`Cache size limit reached. Removed oldest entry: ${oldestKey}`);
            }
        }

        // Extract column names if not provided
        let columns: string[] = metadata?.columns || [];
        if (columns.length === 0 && results.length > 0) {
            columns = Object.keys(results[0]);
        }

        const cachedResult: CachedQueryResult = {
            id: name,
            results: JSON.parse(JSON.stringify(results)), // Deep copy to avoid mutations
            query: metadata?.query,
            parameters: metadata?.parameters,
            connectionName: metadata?.connectionName,
            timestamp: new Date(),
            rowCount: results.length,
            columns,
            metadata: metadata?.additionalMetadata
        };

        this.cache.set(name, cachedResult);
        CSReporter.info(`Query result cached: '${name}' (${results.length} rows, ${columns.length} columns)`);
    }

    /**
     * Retrieve query results from cache
     *
     * @param name - Identifier of the cached result
     * @returns Cached query results or null if not found
     */
    public get(name: string): CachedQueryResult | null {
        const cached = this.cache.get(name);

        if (!cached) {
            CSReporter.warn(`Query result not found in cache: '${name}'`);
            return null;
        }

        // Check if result has expired (optional TTL check)
        const age = Date.now() - cached.timestamp.getTime();
        if (age > this.defaultTTL) {
            CSReporter.warn(`Cached result '${name}' has expired (age: ${age}ms, TTL: ${this.defaultTTL}ms)`);
            this.cache.delete(name);
            return null;
        }

        CSReporter.debug(`Retrieved cached query result: '${name}' (${cached.rowCount} rows)`);
        return cached;
    }

    /**
     * Get results as array of records
     *
     * @param name - Identifier of the cached result
     * @returns Array of result records or empty array if not found
     */
    public getResults(name: string): any[] {
        const cached = this.get(name);
        return cached ? cached.results : [];
    }

    /**
     * Get specific row from cached results
     *
     * @param name - Identifier of the cached result
     * @param rowIndex - Zero-based row index
     * @returns Single row record or null if not found
     */
    public getRow(name: string, rowIndex: number): any | null {
        const cached = this.get(name);
        if (!cached || rowIndex < 0 || rowIndex >= cached.results.length) {
            return null;
        }
        return cached.results[rowIndex];
    }

    /**
     * Get specific field value from a cached result
     *
     * @param name - Identifier of the cached result
     * @param rowIndex - Zero-based row index
     * @param fieldName - Column/field name
     * @returns Field value or null if not found
     */
    public getFieldValue(name: string, rowIndex: number, fieldName: string): any | null {
        const row = this.getRow(name, rowIndex);
        if (!row || !(fieldName in row)) {
            return null;
        }
        return row[fieldName];
    }

    /**
     * Get column names from cached result
     *
     * @param name - Identifier of the cached result
     * @returns Array of column names or empty array if not found
     */
    public getColumns(name: string): string[] {
        const cached = this.get(name);
        return cached ? cached.columns : [];
    }

    /**
     * Get row count from cached result
     *
     * @param name - Identifier of the cached result
     * @returns Number of rows or 0 if not found
     */
    public getRowCount(name: string): number {
        const cached = this.get(name);
        return cached ? cached.rowCount : 0;
    }

    /**
     * Check if a result exists in cache
     *
     * @param name - Identifier to check
     * @returns True if result exists in cache
     */
    public has(name: string): boolean {
        return this.cache.has(name);
    }

    /**
     * Remove a result from cache
     *
     * @param name - Identifier of the result to remove
     * @returns True if result was removed
     */
    public remove(name: string): boolean {
        const removed = this.cache.delete(name);
        if (removed) {
            CSReporter.debug(`Removed cached query result: '${name}'`);
        }
        return removed;
    }

    /**
     * Clear all cached results
     */
    public clear(): void {
        const size = this.cache.size;
        this.cache.clear();
        CSReporter.info(`Cleared query result cache (removed ${size} entries)`);
    }

    /**
     * Get all cached result names
     *
     * @returns Array of cached result identifiers
     */
    public list(): string[] {
        return Array.from(this.cache.keys());
    }

    /**
     * Get cache statistics
     *
     * @returns Cache statistics object
     */
    public getStats(): {
        size: number;
        maxSize: number;
        ttl: number;
        entries: Array<{ name: string; rowCount: number; age: number }>;
    } {
        const entries = Array.from(this.cache.entries()).map(([name, cached]) => ({
            name,
            rowCount: cached.rowCount,
            age: Date.now() - cached.timestamp.getTime()
        }));

        return {
            size: this.cache.size,
            maxSize: this.maxCacheSize,
            ttl: this.defaultTTL,
            entries
        };
    }

    /**
     * Set maximum cache size
     *
     * @param maxSize - Maximum number of cached results
     */
    public setMaxCacheSize(maxSize: number): void {
        if (maxSize < 1) {
            throw new Error('Max cache size must be at least 1');
        }
        this.maxCacheSize = maxSize;
        CSReporter.debug(`Query result cache max size set to: ${maxSize}`);
    }

    /**
     * Set default time-to-live for cached results
     *
     * @param ttl - TTL in milliseconds
     */
    public setTTL(ttl: number): void {
        if (ttl < 0) {
            throw new Error('TTL must be non-negative');
        }
        this.defaultTTL = ttl;
        CSReporter.debug(`Query result cache TTL set to: ${ttl}ms`);
    }

    /**
     * Convert ResultSet to cacheable format
     *
     * @param resultSet - Database result set
     * @param name - Name to cache under
     * @param metadata - Optional metadata
     */
    public storeResultSet(
        name: string,
        resultSet: ResultSet,
        metadata?: {
            query?: string;
            parameters?: any[];
            connectionName?: string;
        }
    ): void {
        const results = resultSet.rows.map(row => ({ ...row }));
        const columns = resultSet.fields.map(field => field.name);

        this.store(name, results, {
            ...metadata,
            columns,
            additionalMetadata: {
                affectedRows: resultSet.affectedRows,
                fieldCount: resultSet.fields.length
            }
        });
    }

    /**
     * Store first row of results as key-value pairs in variables
     * Useful for using DB results as test data
     *
     * @param name - Identifier of the cached result
     * @returns Object with field names as keys and values from first row
     */
    public getFirstRowAsVariables(name: string): Record<string, any> {
        const row = this.getRow(name, 0);
        if (!row) {
            return {};
        }
        return { ...row };
    }

    /**
     * Clean up expired entries based on TTL
     *
     * @returns Number of expired entries removed
     */
    public cleanupExpired(): number {
        let removed = 0;
        const now = Date.now();

        for (const [name, cached] of this.cache.entries()) {
            const age = now - cached.timestamp.getTime();
            if (age > this.defaultTTL) {
                this.cache.delete(name);
                removed++;
            }
        }

        if (removed > 0) {
            CSReporter.debug(`Cleaned up ${removed} expired query result(s)`);
        }

        return removed;
    }
}
