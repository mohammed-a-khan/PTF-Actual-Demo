import { CSRequestTemplate, CSTemplateCollection } from './CSRequestTemplateEngine';
import { CSReporter } from '../../reporter/CSReporter';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface CSTemplateCacheEntry {
    template: CSRequestTemplate | CSTemplateCollection;
    type: 'template' | 'collection';
    timestamp: number;
    checksum: string;
    hits: number;
    lastAccess: number;
    metadata?: any;
}

export interface CSTemplateCacheOptions {
    maxSize?: number;
    ttl?: number;
    persistCache?: boolean;
    cacheDir?: string;
    evictionPolicy?: 'LRU' | 'LFU' | 'FIFO' | 'TTL';
    checkIntegrity?: boolean;
    compression?: boolean;
}

export class CSTemplateCache {
    private cache: Map<string, CSTemplateCacheEntry>;
    private options: CSTemplateCacheOptions;
    private accessOrder: string[];
    private cacheStats: {
        hits: number;
        misses: number;
        evictions: number;
        additions: number;
        updates: number;
    };

    constructor(options?: CSTemplateCacheOptions) {
        this.cache = new Map();
        this.accessOrder = [];
        this.options = {
            maxSize: 1000,
            ttl: 3600000, // 1 hour
            persistCache: false,
            cacheDir: './.template-cache',
            evictionPolicy: 'LRU',
            checkIntegrity: true,
            compression: false,
            ...options
        };
        this.cacheStats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            additions: 0,
            updates: 0
        };

        if (this.options.persistCache) {
            this.loadPersistedCache();
        }
    }

    public set(
        key: string,
        template: CSRequestTemplate | CSTemplateCollection,
        type: 'template' | 'collection',
        metadata?: any
    ): void {
        // Check if cache is full
        if (this.cache.size >= this.options.maxSize!) {
            this.evict();
        }

        const existing = this.cache.has(key);
        const checksum = this.generateChecksum(template);

        const entry: CSTemplateCacheEntry = {
            template,
            type,
            timestamp: Date.now(),
            checksum,
            hits: 0,
            lastAccess: Date.now(),
            metadata
        };

        this.cache.set(key, entry);
        this.updateAccessOrder(key);

        if (existing) {
            this.cacheStats.updates++;
        } else {
            this.cacheStats.additions++;
        }

        CSReporter.debug(`Template cached: ${key}`);

        if (this.options.persistCache) {
            this.persistEntry(key, entry);
        }
    }

    public get(key: string): (CSRequestTemplate | CSTemplateCollection) | undefined {
        const entry = this.cache.get(key);

        if (!entry) {
            this.cacheStats.misses++;
            return undefined;
        }

        // Check TTL
        if (this.isExpired(entry)) {
            this.cache.delete(key);
            this.removeFromAccessOrder(key);
            this.cacheStats.misses++;
            CSReporter.debug(`Template cache expired: ${key}`);
            return undefined;
        }

        // Update stats
        entry.hits++;
        entry.lastAccess = Date.now();
        this.cacheStats.hits++;
        this.updateAccessOrder(key);

        return entry.template;
    }

    public has(key: string): boolean {
        const entry = this.cache.get(key);
        if (!entry) return false;

        if (this.isExpired(entry)) {
            this.cache.delete(key);
            this.removeFromAccessOrder(key);
            return false;
        }

        return true;
    }

    public delete(key: string): boolean {
        const deleted = this.cache.delete(key);
        if (deleted) {
            this.removeFromAccessOrder(key);
            if (this.options.persistCache) {
                this.deletePersistedEntry(key);
            }
        }
        return deleted;
    }

    public clear(): void {
        this.cache.clear();
        this.accessOrder = [];
        this.cacheStats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            additions: 0,
            updates: 0
        };

        if (this.options.persistCache) {
            this.clearPersistedCache();
        }

        CSReporter.info('Template cache cleared');
    }

    public getAll(): Map<string, CSTemplateCacheEntry> {
        const validEntries = new Map<string, CSTemplateCacheEntry>();

        for (const [key, entry] of this.cache.entries()) {
            if (!this.isExpired(entry)) {
                validEntries.set(key, entry);
            }
        }

        return validEntries;
    }

    public getAllTemplates(): CSRequestTemplate[] {
        const templates: CSRequestTemplate[] = [];

        for (const entry of this.cache.values()) {
            if (entry.type === 'template' && !this.isExpired(entry)) {
                templates.push(entry.template as CSRequestTemplate);
            }
        }

        return templates;
    }

    public getAllCollections(): CSTemplateCollection[] {
        const collections: CSTemplateCollection[] = [];

        for (const entry of this.cache.values()) {
            if (entry.type === 'collection' && !this.isExpired(entry)) {
                collections.push(entry.template as CSTemplateCollection);
            }
        }

        return collections;
    }

    public findByPattern(pattern: string | RegExp): Map<string, CSTemplateCacheEntry> {
        const matches = new Map<string, CSTemplateCacheEntry>();
        const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

        for (const [key, entry] of this.cache.entries()) {
            if (regex.test(key) && !this.isExpired(entry)) {
                matches.set(key, entry);
            }
        }

        return matches;
    }

    public findByMetadata(predicate: (metadata: any) => boolean): Map<string, CSTemplateCacheEntry> {
        const matches = new Map<string, CSTemplateCacheEntry>();

        for (const [key, entry] of this.cache.entries()) {
            if (entry.metadata && predicate(entry.metadata) && !this.isExpired(entry)) {
                matches.set(key, entry);
            }
        }

        return matches;
    }

    private evict(): void {
        let keyToEvict: string | undefined;

        switch (this.options.evictionPolicy) {
            case 'LRU':
                keyToEvict = this.getLRUKey();
                break;

            case 'LFU':
                keyToEvict = this.getLFUKey();
                break;

            case 'FIFO':
                keyToEvict = this.getFIFOKey();
                break;

            case 'TTL':
                keyToEvict = this.getOldestKey();
                break;

            default:
                keyToEvict = this.accessOrder[0];
        }

        if (keyToEvict) {
            this.cache.delete(keyToEvict);
            this.removeFromAccessOrder(keyToEvict);
            this.cacheStats.evictions++;
            CSReporter.debug(`Template evicted from cache: ${keyToEvict}`);
        }
    }

    private getLRUKey(): string | undefined {
        return this.accessOrder[0];
    }

    private getLFUKey(): string | undefined {
        let minHits = Infinity;
        let lfuKey: string | undefined;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.hits < minHits) {
                minHits = entry.hits;
                lfuKey = key;
            }
        }

        return lfuKey;
    }

    private getFIFOKey(): string | undefined {
        let oldestTimestamp = Infinity;
        let fifoKey: string | undefined;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.timestamp < oldestTimestamp) {
                oldestTimestamp = entry.timestamp;
                fifoKey = key;
            }
        }

        return fifoKey;
    }

    private getOldestKey(): string | undefined {
        let oldestAccess = Infinity;
        let oldestKey: string | undefined;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.lastAccess < oldestAccess) {
                oldestAccess = entry.lastAccess;
                oldestKey = key;
            }
        }

        return oldestKey;
    }

    private updateAccessOrder(key: string): void {
        this.removeFromAccessOrder(key);
        this.accessOrder.push(key);
    }

    private removeFromAccessOrder(key: string): void {
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
            this.accessOrder.splice(index, 1);
        }
    }

    private isExpired(entry: CSTemplateCacheEntry): boolean {
        if (!this.options.ttl) return false;
        return Date.now() - entry.timestamp > this.options.ttl;
    }

    private generateChecksum(template: any): string {
        const content = JSON.stringify(template);
        return crypto.createHash('md5').update(content).digest('hex');
    }

    public verifyIntegrity(key: string): boolean {
        if (!this.options.checkIntegrity) return true;

        const entry = this.cache.get(key);
        if (!entry) return false;

        const currentChecksum = this.generateChecksum(entry.template);
        return currentChecksum === entry.checksum;
    }

    private async persistEntry(key: string, entry: CSTemplateCacheEntry): Promise<void> {
        if (!this.options.persistCache) return;

        try {
            const cacheDir = this.options.cacheDir!;
            await fs.promises.mkdir(cacheDir, { recursive: true });

            const fileName = this.sanitizeFileName(key);
            const filePath = path.join(cacheDir, `${fileName}.cache`);

            const data = this.options.compression
                ? await this.compress(JSON.stringify(entry))
                : JSON.stringify(entry);

            await fs.promises.writeFile(filePath, data);
        } catch (error) {
            CSReporter.warn(`Failed to persist cache entry: ${(error as Error).message}`);
        }
    }

    private async deletePersistedEntry(key: string): Promise<void> {
        if (!this.options.persistCache) return;

        try {
            const fileName = this.sanitizeFileName(key);
            const filePath = path.join(this.options.cacheDir!, `${fileName}.cache`);
            await fs.promises.unlink(filePath);
        } catch (error) {
            // File might not exist
        }
    }

    private async loadPersistedCache(): Promise<void> {
        if (!this.options.persistCache) return;

        try {
            const cacheDir = this.options.cacheDir!;
            const files = await fs.promises.readdir(cacheDir);

            for (const file of files) {
                if (!file.endsWith('.cache')) continue;

                try {
                    const filePath = path.join(cacheDir, file);
                    const data = await fs.promises.readFile(filePath, 'utf-8');

                    const entry: CSTemplateCacheEntry = this.options.compression
                        ? JSON.parse(await this.decompress(data))
                        : JSON.parse(data);

                    if (!this.isExpired(entry)) {
                        const key = file.replace('.cache', '');
                        this.cache.set(this.desanitizeFileName(key), entry);
                    } else {
                        // Delete expired entry
                        await fs.promises.unlink(filePath);
                    }
                } catch (error) {
                    CSReporter.warn(`Failed to load cached entry: ${file}`);
                }
            }

            CSReporter.info(`Loaded ${this.cache.size} templates from cache`);
        } catch (error) {
            CSReporter.warn(`Failed to load persisted cache: ${(error as Error).message}`);
        }
    }

    private async clearPersistedCache(): Promise<void> {
        if (!this.options.persistCache) return;

        try {
            const cacheDir = this.options.cacheDir!;
            const files = await fs.promises.readdir(cacheDir);

            for (const file of files) {
                if (file.endsWith('.cache')) {
                    await fs.promises.unlink(path.join(cacheDir, file));
                }
            }
        } catch (error) {
            CSReporter.warn(`Failed to clear persisted cache: ${(error as Error).message}`);
        }
    }

    private sanitizeFileName(key: string): string {
        return key.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    }

    private desanitizeFileName(fileName: string): string {
        // This is a simple implementation - in production you might want to store a mapping
        return fileName;
    }

    private async compress(data: string): Promise<string> {
        // Simple compression using zlib
        const zlib = require('zlib');
        return new Promise((resolve, reject) => {
            zlib.gzip(data, (error: any, result: Buffer) => {
                if (error) reject(error);
                else resolve(result.toString('base64'));
            });
        });
    }

    private async decompress(data: string): Promise<string> {
        const zlib = require('zlib');
        return new Promise((resolve, reject) => {
            const buffer = Buffer.from(data, 'base64');
            zlib.gunzip(buffer, (error: any, result: Buffer) => {
                if (error) reject(error);
                else resolve(result.toString('utf-8'));
            });
        });
    }

    public getStats(): any {
        return {
            size: this.cache.size,
            maxSize: this.options.maxSize,
            ...this.cacheStats,
            hitRate: this.cacheStats.hits / (this.cacheStats.hits + this.cacheStats.misses) || 0,
            evictionPolicy: this.options.evictionPolicy,
            ttl: this.options.ttl,
            persistCache: this.options.persistCache
        };
    }

    public optimize(): void {
        // Remove expired entries
        const expiredKeys: string[] = [];

        for (const [key, entry] of this.cache.entries()) {
            if (this.isExpired(entry)) {
                expiredKeys.push(key);
            }
        }

        for (const key of expiredKeys) {
            this.delete(key);
        }

        // Reorganize access order based on policy
        if (this.options.evictionPolicy === 'LFU') {
            this.accessOrder.sort((a, b) => {
                const entryA = this.cache.get(a);
                const entryB = this.cache.get(b);
                return (entryA?.hits || 0) - (entryB?.hits || 0);
            });
        }

        CSReporter.info(`Cache optimized: removed ${expiredKeys.length} expired entries`);
    }

    public export(): any {
        const entries: any[] = [];

        for (const [key, entry] of this.cache.entries()) {
            if (!this.isExpired(entry)) {
                entries.push({
                    key,
                    type: entry.type,
                    timestamp: entry.timestamp,
                    hits: entry.hits,
                    metadata: entry.metadata
                });
            }
        }

        return {
            entries,
            stats: this.getStats(),
            options: this.options
        };
    }

    public import(data: any): void {
        if (data.entries) {
            for (const entry of data.entries) {
                // Note: We don't import the actual templates, just the metadata
                CSReporter.debug(`Would import cache entry: ${entry.key}`);
            }
        }

        if (data.stats) {
            this.cacheStats = { ...this.cacheStats, ...data.stats };
        }

        CSReporter.info('Cache metadata imported');
    }
}

export const templateCache = new CSTemplateCache();