/**
 * CS Playwright Test Framework - Spec Format Data Iterator
 * Handles data-driven test iteration from multiple data sources
 */

import { SpecDataSource, SpecDataRow, SpecIterationInfo, SpecDataSourceInfo } from './CSSpecTypes';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

// Lazy load CSDataProvider to avoid circular dependencies
let CSDataProvider: any = null;

/**
 * Manages data iteration for data-driven spec tests
 */
export class CSSpecDataIterator {
    private static instance: CSSpecDataIterator;
    private config: CSConfigurationManager;
    private dataCache: Map<string, SpecDataRow[]> = new Map();

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSSpecDataIterator {
        if (!CSSpecDataIterator.instance) {
            CSSpecDataIterator.instance = new CSSpecDataIterator();
        }
        return CSSpecDataIterator.instance;
    }

    /**
     * Load data from data source configuration
     */
    public async loadData(dataSource: SpecDataSource): Promise<SpecDataRow[]> {
        // Handle inline data directly
        if (dataSource.type === 'inline' && dataSource.data) {
            CSReporter.info(`[DataIterator] Using inline data: ${dataSource.data.length} rows`);
            return dataSource.data;
        }

        // Generate cache key
        const cacheKey = this.generateCacheKey(dataSource);

        // Check cache
        if (this.dataCache.has(cacheKey)) {
            CSReporter.debug(`[DataIterator] Using cached data for: ${dataSource.source}`);
            return this.dataCache.get(cacheKey)!;
        }

        // Lazy load CSDataProvider
        if (!CSDataProvider) {
            CSDataProvider = require('../data/CSDataProvider').CSDataProvider;
        }

        const dataProvider = CSDataProvider.getInstance();

        try {
            // Convert SpecDataSource to DataProviderOptions
            const options = this.convertToDataProviderOptions(dataSource);

            CSReporter.info(`[DataIterator] Loading data from: ${dataSource.source}`);

            const data = await dataProvider.loadData(options);

            if (!data || data.length === 0) {
                CSReporter.warn(`[DataIterator] No data loaded from: ${dataSource.source}`);
                return [];
            }

            CSReporter.info(`[DataIterator] Loaded ${data.length} rows from: ${dataSource.source}`);

            // Cache the data
            this.dataCache.set(cacheKey, data);

            return data;
        } catch (error: any) {
            CSReporter.error(`[DataIterator] Failed to load data from ${dataSource.source}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Create iteration info object
     */
    public createIterationInfo(
        data: SpecDataRow,
        currentIndex: number,
        totalRows: number,
        dataSource?: SpecDataSource
    ): SpecIterationInfo {
        const iterationInfo: SpecIterationInfo = {
            current: currentIndex + 1, // 1-based index for reporting
            total: totalRows,
            data,
            index: currentIndex,        // Zero-based index
            isFirst: currentIndex === 0,
            isLast: currentIndex === totalRows - 1
        };

        // Add data source info for reporting if available
        if (dataSource) {
            iterationInfo.source = this.createSourceInfo(dataSource);
        }

        return iterationInfo;
    }

    /**
     * Create data source info for reporting
     */
    private createSourceInfo(dataSource: SpecDataSource): SpecDataSourceInfo {
        const sourceInfo: SpecDataSourceInfo = {
            type: dataSource.type || this.inferTypeFromSource(dataSource.source || '')
        };

        if (dataSource.source) {
            // Interpolate environment placeholders for display in report
            sourceInfo.file = this.interpolateEnvironmentPlaceholders(dataSource.source);
        }
        if (dataSource.sheet) {
            sourceInfo.sheet = dataSource.sheet;
        }
        if (dataSource.filter) {
            sourceInfo.filter = dataSource.filter;
        }
        if (dataSource.query) {
            sourceInfo.query = dataSource.query;
        }
        if (dataSource.connection) {
            sourceInfo.connection = dataSource.connection;
        }
        if (dataSource.delimiter) {
            sourceInfo.delimiter = dataSource.delimiter;
        }

        return sourceInfo;
    }

    /**
     * Interpolate environment placeholders in a string
     * Supports {env}, {environment}, {ENV} etc.
     */
    private interpolateEnvironmentPlaceholders(source: string): string {
        const env = this.config.get('ENVIRONMENT') || this.config.get('ENV') || 'dev';
        return source.replace(/\{env\}|\{ENV\}|\{environment\}|\{ENVIRONMENT\}/gi, env);
    }

    /**
     * Interpolate test name with data values
     * Supports: {data.property}, {property}, {iteration.current}, {iteration.total}
     * Example: "Login as {username}" → "Login as john_doe"
     * Example: "Navigate to {moduleName}" → "Navigate to Dashboard"
     */
    public interpolateTestName(
        testName: string,
        data: SpecDataRow,
        iteration: SpecIterationInfo
    ): string {
        let interpolated = testName;

        // Replace {data.property} patterns (explicit data prefix)
        interpolated = interpolated.replace(/\{data\.(\w+)\}/g, (match, property) => {
            return data[property] !== undefined ? String(data[property]) : match;
        });

        // Replace {property} patterns (direct property reference without data. prefix)
        // This allows {moduleName} to be replaced with data.moduleName
        interpolated = interpolated.replace(/\{(\w+)\}/g, (match, property) => {
            // Skip iteration placeholders - they're handled separately
            if (property === 'iteration') return match;
            return data[property] !== undefined ? String(data[property]) : match;
        });

        // Replace {iteration.current} and {iteration.total}
        interpolated = interpolated.replace(/\{iteration\.current\}/g, String(iteration.current));
        interpolated = interpolated.replace(/\{iteration\.total\}/g, String(iteration.total));

        // If test name doesn't include data reference, append iteration number
        if (testName === interpolated && iteration.total > 1) {
            interpolated = `${testName} [Iteration ${iteration.current}/${iteration.total}]`;
        }

        return interpolated;
    }

    /**
     * Merge data sources from describe and test levels
     * Test-level dataSource takes priority
     */
    public mergeDataSources(
        describeDataSource?: SpecDataSource,
        testDataSource?: SpecDataSource
    ): SpecDataSource | undefined {
        // Test-level takes priority
        if (testDataSource) {
            return testDataSource;
        }
        return describeDataSource;
    }

    /**
     * Clear data cache
     */
    public clearCache(): void {
        this.dataCache.clear();
        CSReporter.debug('[DataIterator] Cache cleared');
    }

    /**
     * Generate cache key from data source configuration
     */
    private generateCacheKey(dataSource: SpecDataSource): string {
        const keyParts = [
            dataSource.source,
            dataSource.type || 'auto',
            dataSource.sheet || '',
            dataSource.filter || '',
            dataSource.query || '',
            dataSource.connection || '',
            dataSource.path || '',
            dataSource.xpath || '',
            dataSource.delimiter || ''
        ];
        return keyParts.join('|');
    }

    /**
     * Convert SpecDataSource to CSDataProvider options
     */
    private convertToDataProviderOptions(dataSource: SpecDataSource): any {
        const options: any = {
            source: dataSource.source ? this.resolveSourcePath(dataSource.source) : ''
        };

        // Infer type from source if not provided
        if (dataSource.type) {
            options.type = dataSource.type;
        } else if (dataSource.source) {
            options.type = this.inferTypeFromSource(dataSource.source);
        }

        // Add optional properties
        if (dataSource.sheet) options.sheet = dataSource.sheet;
        if (dataSource.delimiter) options.delimiter = dataSource.delimiter;
        if (dataSource.path) options.path = dataSource.path;
        if (dataSource.xpath) options.xpath = dataSource.xpath;
        if (dataSource.filter) options.filter = dataSource.filter;
        if (dataSource.query) options.query = dataSource.query;
        if (dataSource.connection) {
            options.dbname = dataSource.connection;
            options.connection = dataSource.connection;
        }

        return options;
    }

    /**
     * Resolve source path relative to project data directory
     */
    private resolveSourcePath(source: string): string {
        // If source is absolute or starts with special prefix, return as-is
        if (source.startsWith('/') ||
            source.startsWith('db:') ||
            source.startsWith('api:') ||
            source.startsWith('database') ||
            source.includes('://')) {
            return source;
        }

        // Try to resolve relative to project data directory
        const project = this.config.get('PROJECT');
        if (project) {
            const projectDataPath = `test/${project}/data/${source}`;
            const fs = require('fs');
            const path = require('path');
            const fullPath = path.resolve(process.cwd(), projectDataPath);

            if (fs.existsSync(fullPath)) {
                return projectDataPath;
            }
        }

        // Return as-is if not found in project directory
        return source;
    }

    /**
     * Infer data type from source file extension
     */
    private inferTypeFromSource(source: string): string {
        const lowerSource = source.toLowerCase();

        if (lowerSource.endsWith('.xlsx') || lowerSource.endsWith('.xls')) {
            return 'excel';
        }
        if (lowerSource.endsWith('.csv')) {
            return 'csv';
        }
        if (lowerSource.endsWith('.json')) {
            return 'json';
        }
        if (lowerSource.endsWith('.xml')) {
            return 'xml';
        }
        if (lowerSource.startsWith('db:') || lowerSource.startsWith('database')) {
            return 'database';
        }
        if (lowerSource.startsWith('api:') || lowerSource.includes('://')) {
            return 'api';
        }

        // Default to excel for unknown
        return 'excel';
    }

    /**
     * Validate data source configuration
     */
    public validateDataSource(dataSource: SpecDataSource): string[] {
        const errors: string[] = [];

        if (!dataSource.source) {
            errors.push('Data source "source" is required');
        }

        if (dataSource.type === 'database' && !dataSource.query && !dataSource.connection) {
            errors.push('Database source requires either "query" or "connection"');
        }

        if (dataSource.type === 'excel' && dataSource.sheet === undefined) {
            // Not an error, but log warning
            CSReporter.debug('[DataIterator] Excel source without sheet specified - will use first sheet');
        }

        return errors;
    }
}
