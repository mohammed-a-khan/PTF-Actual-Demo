// src/api/comparison/CSFieldMapper.ts

import { CSReporter } from '../../reporter/CSReporter';

/**
 * Field mapping entry
 */
export interface FieldMapping {
    /** Source field name (e.g., database column name) */
    source: string;
    /** Target field name (e.g., API field name) */
    target: string;
    /** Optional transformation function */
    transform?: (value: any) => any;
}

/**
 * Field mapping configuration
 */
export interface FieldMapConfig {
    /** Array of field mappings */
    mappings: FieldMapping[];
    /** Auto-convert naming conventions */
    autoConvert?: boolean;
    /** Naming convention for source (snake_case, camelCase, PascalCase) */
    sourceConvention?: 'snake_case' | 'camelCase' | 'PascalCase' | 'kebab-case';
    /** Naming convention for target (snake_case, camelCase, PascalCase) */
    targetConvention?: 'snake_case' | 'camelCase' | 'PascalCase' | 'kebab-case';
    /** Case-sensitive field matching */
    caseSensitive?: boolean;
    /** Include unmapped fields in result */
    includeUnmapped?: boolean;
}

/**
 * Field Mapper for converting between database field names and API field names.
 *
 * Supports:
 * - Explicit field mappings (user_id -> userId)
 * - Automatic naming convention conversion (snake_case <-> camelCase)
 * - Custom transformation functions
 * - Bidirectional mapping
 */
export class CSFieldMapper {
    private config: FieldMapConfig;
    private mappingIndex: Map<string, FieldMapping>;
    private reverseMappingIndex: Map<string, FieldMapping>;

    constructor(config: Partial<FieldMapConfig> = {}) {
        this.config = {
            mappings: [],
            autoConvert: true,
            sourceConvention: 'snake_case',
            targetConvention: 'camelCase',
            caseSensitive: false,
            includeUnmapped: true,
            ...config
        };

        this.mappingIndex = new Map();
        this.reverseMappingIndex = new Map();

        this.buildMappingIndex();
    }

    /**
     * Build internal mapping indices for fast lookup
     */
    private buildMappingIndex(): void {
        this.mappingIndex.clear();
        this.reverseMappingIndex.clear();

        for (const mapping of this.config.mappings) {
            const sourceKey = this.config.caseSensitive
                ? mapping.source
                : mapping.source.toLowerCase();
            const targetKey = this.config.caseSensitive
                ? mapping.target
                : mapping.target.toLowerCase();

            this.mappingIndex.set(sourceKey, mapping);
            this.reverseMappingIndex.set(targetKey, mapping);
        }

        CSReporter.debug(`Field mapper initialized with ${this.config.mappings.length} mappings`);
    }

    /**
     * Map a source record to target format
     *
     * @param sourceRecord - Record with source field names
     * @returns Record with target field names
     */
    public mapSourceToTarget(sourceRecord: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = {};

        for (const [sourceField, value] of Object.entries(sourceRecord)) {
            const targetField = this.getTargetFieldName(sourceField);
            const transformedValue = this.transformValue(sourceField, value, 'source');
            result[targetField] = transformedValue;
        }

        return result;
    }

    /**
     * Map a target record to source format
     *
     * @param targetRecord - Record with target field names
     * @returns Record with source field names
     */
    public mapTargetToSource(targetRecord: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = {};

        for (const [targetField, value] of Object.entries(targetRecord)) {
            const sourceField = this.getSourceFieldName(targetField);
            const transformedValue = this.transformValue(targetField, value, 'target');
            result[sourceField] = transformedValue;
        }

        return result;
    }

    /**
     * Map an array of source records to target format
     *
     * @param sourceRecords - Array of records with source field names
     * @returns Array of records with target field names
     */
    public mapSourceArrayToTarget(sourceRecords: Record<string, any>[]): Record<string, any>[] {
        return sourceRecords.map(record => this.mapSourceToTarget(record));
    }

    /**
     * Map an array of target records to source format
     *
     * @param targetRecords - Array of records with target field names
     * @returns Array of records with source field names
     */
    public mapTargetArrayToSource(targetRecords: Record<string, any>[]): Record<string, any>[] {
        return targetRecords.map(record => this.mapTargetToSource(record));
    }

    /**
     * Get target field name for a source field
     *
     * @param sourceField - Source field name
     * @returns Target field name
     */
    public getTargetFieldName(sourceField: string): string {
        const lookupKey = this.config.caseSensitive
            ? sourceField
            : sourceField.toLowerCase();

        // Check explicit mapping first
        const mapping = this.mappingIndex.get(lookupKey);
        if (mapping) {
            return mapping.target;
        }

        // Auto-convert if enabled
        if (this.config.autoConvert) {
            return this.convertNamingConvention(
                sourceField,
                this.config.sourceConvention!,
                this.config.targetConvention!
            );
        }

        // Return as-is if no mapping found and auto-convert disabled
        return sourceField;
    }

    /**
     * Get source field name for a target field
     *
     * @param targetField - Target field name
     * @returns Source field name
     */
    public getSourceFieldName(targetField: string): string {
        const lookupKey = this.config.caseSensitive
            ? targetField
            : targetField.toLowerCase();

        // Check explicit mapping first
        const mapping = this.reverseMappingIndex.get(lookupKey);
        if (mapping) {
            return mapping.source;
        }

        // Auto-convert if enabled
        if (this.config.autoConvert) {
            return this.convertNamingConvention(
                targetField,
                this.config.targetConvention!,
                this.config.sourceConvention!
            );
        }

        // Return as-is if no mapping found and auto-convert disabled
        return targetField;
    }

    /**
     * Convert field name between naming conventions
     */
    private convertNamingConvention(
        fieldName: string,
        from: string,
        to: string
    ): string {
        // First normalize to words array
        let words: string[] = [];

        switch (from) {
            case 'snake_case':
                words = fieldName.split('_').map(w => w.toLowerCase());
                break;
            case 'kebab-case':
                words = fieldName.split('-').map(w => w.toLowerCase());
                break;
            case 'camelCase':
                words = this.splitCamelCase(fieldName);
                break;
            case 'PascalCase':
                words = this.splitCamelCase(fieldName);
                break;
            default:
                words = [fieldName];
        }

        // Convert to target convention
        switch (to) {
            case 'snake_case':
                return words.join('_').toLowerCase();
            case 'kebab-case':
                return words.join('-').toLowerCase();
            case 'camelCase':
                return words
                    .map((w, i) => (i === 0 ? w.toLowerCase() : this.capitalize(w)))
                    .join('');
            case 'PascalCase':
                return words.map(w => this.capitalize(w)).join('');
            default:
                return fieldName;
        }
    }

    /**
     * Split camelCase or PascalCase into words
     */
    private splitCamelCase(str: string): string[] {
        // Split on uppercase letters, keeping them with following lowercase
        return str
            .replace(/([A-Z])/g, ' $1')
            .trim()
            .split(/\s+/)
            .map(w => w.toLowerCase());
    }

    /**
     * Capitalize first letter of a word
     */
    private capitalize(word: string): string {
        if (!word) return word;
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }

    /**
     * Transform a value using the mapping's transform function
     */
    private transformValue(fieldName: string, value: any, direction: 'source' | 'target'): any {
        const lookupKey = this.config.caseSensitive
            ? fieldName
            : fieldName.toLowerCase();

        const index = direction === 'source' ? this.mappingIndex : this.reverseMappingIndex;
        const mapping = index.get(lookupKey);

        if (mapping && mapping.transform) {
            return mapping.transform(value);
        }

        return value;
    }

    /**
     * Add a field mapping
     *
     * @param source - Source field name
     * @param target - Target field name
     * @param transform - Optional transformation function
     */
    public addMapping(
        source: string,
        target: string,
        transform?: (value: any) => any
    ): void {
        const mapping: FieldMapping = { source, target, transform };
        this.config.mappings.push(mapping);

        const sourceKey = this.config.caseSensitive ? source : source.toLowerCase();
        const targetKey = this.config.caseSensitive ? target : target.toLowerCase();

        this.mappingIndex.set(sourceKey, mapping);
        this.reverseMappingIndex.set(targetKey, mapping);

        CSReporter.debug(`Added field mapping: ${source} -> ${target}`);
    }

    /**
     * Add multiple field mappings
     *
     * @param mappings - Array of field mappings
     */
    public addMappings(mappings: FieldMapping[]): void {
        mappings.forEach(m => this.addMapping(m.source, m.target, m.transform));
    }

    /**
     * Remove a field mapping
     *
     * @param source - Source field name
     */
    public removeMapping(source: string): boolean {
        const sourceKey = this.config.caseSensitive ? source : source.toLowerCase();
        const mapping = this.mappingIndex.get(sourceKey);

        if (mapping) {
            this.mappingIndex.delete(sourceKey);
            const targetKey = this.config.caseSensitive
                ? mapping.target
                : mapping.target.toLowerCase();
            this.reverseMappingIndex.delete(targetKey);

            // Remove from config array
            const index = this.config.mappings.findIndex(m => m.source === source);
            if (index >= 0) {
                this.config.mappings.splice(index, 1);
            }

            CSReporter.debug(`Removed field mapping: ${source}`);
            return true;
        }

        return false;
    }

    /**
     * Clear all mappings
     */
    public clearMappings(): void {
        this.config.mappings = [];
        this.mappingIndex.clear();
        this.reverseMappingIndex.clear();
        CSReporter.debug('Cleared all field mappings');
    }

    /**
     * Get all field mappings
     */
    public getMappings(): FieldMapping[] {
        return [...this.config.mappings];
    }

    /**
     * Parse mapping from string format (e.g., "user_id:userId, first_name:firstName")
     *
     * @param mappingString - Comma-separated mapping pairs
     * @returns Array of field mappings
     */
    public static parseMappingString(mappingString: string): FieldMapping[] {
        const mappings: FieldMapping[] = [];

        if (!mappingString || mappingString.trim() === '') {
            return mappings;
        }

        const pairs = mappingString.split(',');

        for (const pair of pairs) {
            const trimmedPair = pair.trim();
            if (trimmedPair === '') continue;

            const [source, target] = trimmedPair.split(':').map(s => s.trim());

            if (source && target) {
                mappings.push({ source, target });
            } else {
                CSReporter.warn(`Invalid mapping format: ${pair}`);
            }
        }

        return mappings;
    }

    /**
     * Create field mapper from mapping string
     *
     * @param mappingString - Comma-separated mapping pairs
     * @param config - Optional configuration
     * @returns Field mapper instance
     */
    public static fromMappingString(
        mappingString: string,
        config: Partial<FieldMapConfig> = {}
    ): CSFieldMapper {
        const mappings = CSFieldMapper.parseMappingString(mappingString);
        return new CSFieldMapper({ ...config, mappings });
    }

    /**
     * Create field mapper from data table
     *
     * @param dataTable - Array of {source, target} objects or arrays
     * @param config - Optional configuration
     * @returns Field mapper instance
     */
    public static fromDataTable(
        dataTable: Array<{ source: string; target: string } | [string, string]>,
        config: Partial<FieldMapConfig> = {}
    ): CSFieldMapper {
        const mappings: FieldMapping[] = dataTable.map(entry => {
            if (Array.isArray(entry)) {
                return { source: entry[0], target: entry[1] };
            } else {
                return { source: entry.source, target: entry.target };
            }
        });

        return new CSFieldMapper({ ...config, mappings });
    }

    /**
     * Update configuration
     */
    public setConfig(config: Partial<FieldMapConfig>): void {
        this.config = { ...this.config, ...config };
        if (config.mappings) {
            this.buildMappingIndex();
        }
    }

    /**
     * Get current configuration
     */
    public getConfig(): FieldMapConfig {
        return { ...this.config };
    }
}
