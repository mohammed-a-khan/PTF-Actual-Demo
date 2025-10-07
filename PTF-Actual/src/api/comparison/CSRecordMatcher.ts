// src/api/comparison/CSRecordMatcher.ts

import { CSReporter } from '../../reporter/CSReporter';

/**
 * Record matching configuration
 */
export interface RecordMatchConfig {
    /** Key fields for exact matching */
    keyFields?: string[];
    /** Use fuzzy matching if exact match fails */
    useFuzzyMatching?: boolean;
    /** Minimum score threshold for fuzzy matching (0-100) */
    minMatchScore?: number;
    /** Treat null and empty string as equal */
    treatNullAsEmpty?: boolean;
    /** Case-sensitive matching */
    caseSensitive?: boolean;
    /** Trim whitespace before comparison */
    trimValues?: boolean;
}

/**
 * Match result for a single record
 */
export interface MatchResult {
    /** Index of the matched record in the target list (-1 if no match) */
    matchedIndex: number;
    /** Match score (0-100, where 100 is perfect match) */
    matchScore: number;
    /** Whether the match was based on key fields */
    keyFieldMatch: boolean;
    /** Fields that matched */
    matchedFields: string[];
    /** Fields that didn't match */
    mismatchedFields: string[];
    /** The matched record (if any) */
    matchedRecord?: Record<string, any>;
}

/**
 * Complete matching result for a dataset
 */
export interface DatasetMatchResult {
    /** Total number of records in source */
    sourceCount: number;
    /** Total number of records in target */
    targetCount: number;
    /** Number of successfully matched records */
    matchedCount: number;
    /** Number of unmatched source records */
    unmatchedSourceCount: number;
    /** Number of unmatched target records */
    unmatchedTargetCount: number;
    /** Individual match results */
    matches: MatchResult[];
    /** Indices of unmatched target records */
    unmatchedTargetIndices: number[];
    /** Overall match percentage */
    matchPercentage: number;
}

/**
 * Record Matcher for intelligent matching of database records with API responses.
 *
 * Supports:
 * - Exact matching by key fields
 * - Fuzzy/score-based matching when keys don't match
 * - Flexible value comparison (null/empty, case-insensitive, trimming)
 * - Detailed match reporting
 */
export class CSRecordMatcher {
    private config: RecordMatchConfig;

    constructor(config: RecordMatchConfig = {}) {
        this.config = {
            useFuzzyMatching: true,
            minMatchScore: 50,
            treatNullAsEmpty: true,
            caseSensitive: false,
            trimValues: true,
            ...config
        };
    }

    /**
     * Match a dataset of source records against target records
     *
     * @param sourceRecords - Records to match (e.g., from database)
     * @param targetRecords - Records to match against (e.g., from API response)
     * @param keyFields - Optional key fields for matching
     * @returns Complete matching result
     */
    public matchDatasets(
        sourceRecords: Record<string, any>[],
        targetRecords: Record<string, any>[],
        keyFields?: string[]
    ): DatasetMatchResult {
        const matches: MatchResult[] = [];
        const remainingTargetIndices = new Set<number>(
            targetRecords.map((_, index) => index)
        );

        // Use provided key fields or config key fields
        const matchKeyFields = keyFields || this.config.keyFields;

        CSReporter.debug(
            `Matching ${sourceRecords.length} source records against ${targetRecords.length} target records`
        );

        // Match each source record
        for (let i = 0; i < sourceRecords.length; i++) {
            const sourceRecord = sourceRecords[i];
            const matchResult = this.matchRecord(
                sourceRecord,
                targetRecords,
                Array.from(remainingTargetIndices),
                matchKeyFields
            );

            matches.push(matchResult);

            // Remove matched record from remaining targets
            if (matchResult.matchedIndex >= 0) {
                remainingTargetIndices.delete(matchResult.matchedIndex);
            }
        }

        // Calculate statistics
        const matchedCount = matches.filter(m => m.matchedIndex >= 0).length;
        const unmatchedSourceCount = sourceRecords.length - matchedCount;
        const unmatchedTargetCount = remainingTargetIndices.size;
        const matchPercentage = sourceRecords.length > 0
            ? (matchedCount / sourceRecords.length) * 100
            : 0;

        const result: DatasetMatchResult = {
            sourceCount: sourceRecords.length,
            targetCount: targetRecords.length,
            matchedCount,
            unmatchedSourceCount,
            unmatchedTargetCount,
            matches,
            unmatchedTargetIndices: Array.from(remainingTargetIndices),
            matchPercentage
        };

        CSReporter.info(
            `Match complete: ${matchedCount}/${sourceRecords.length} matched (${matchPercentage.toFixed(1)}%)`
        );

        return result;
    }

    /**
     * Match a single record against a list of candidate records
     *
     * @param sourceRecord - Record to match
     * @param candidates - List of candidate records
     * @param candidateIndices - Indices of candidates to consider
     * @param keyFields - Optional key fields for matching
     * @returns Match result
     */
    public matchRecord(
        sourceRecord: Record<string, any>,
        candidates: Record<string, any>[],
        candidateIndices: number[],
        keyFields?: string[]
    ): MatchResult {
        if (candidateIndices.length === 0) {
            return this.createNoMatchResult();
        }

        // Use provided key fields or config key fields
        const matchKeyFields = keyFields || this.config.keyFields;

        // Try exact match by key fields first
        if (matchKeyFields && matchKeyFields.length > 0) {
            const exactMatchIndex = this.findExactMatchByKeys(
                sourceRecord,
                candidates,
                candidateIndices,
                matchKeyFields
            );

            if (exactMatchIndex >= 0) {
                return this.createMatchResult(
                    sourceRecord,
                    candidates[exactMatchIndex],
                    exactMatchIndex,
                    true
                );
            }
        }

        // If exact match failed, try fuzzy matching
        if (this.config.useFuzzyMatching) {
            return this.findBestFuzzyMatch(sourceRecord, candidates, candidateIndices);
        }

        return this.createNoMatchResult();
    }

    /**
     * Find exact match using key fields
     */
    private findExactMatchByKeys(
        sourceRecord: Record<string, any>,
        candidates: Record<string, any>[],
        candidateIndices: number[],
        keyFields: string[]
    ): number {
        for (const index of candidateIndices) {
            const candidate = candidates[index];
            let allKeysMatch = true;

            for (const keyField of keyFields) {
                // Check if both records have the key field
                if (!(keyField in sourceRecord) || !(keyField in candidate)) {
                    allKeysMatch = false;
                    break;
                }

                // Compare values
                const sourceValue = sourceRecord[keyField];
                const candidateValue = candidate[keyField];

                if (!this.areValuesEqual(sourceValue, candidateValue)) {
                    allKeysMatch = false;
                    break;
                }
            }

            if (allKeysMatch) {
                return index;
            }
        }

        return -1;
    }

    /**
     * Find best match using fuzzy scoring
     */
    private findBestFuzzyMatch(
        sourceRecord: Record<string, any>,
        candidates: Record<string, any>[],
        candidateIndices: number[]
    ): MatchResult {
        let bestMatchIndex = -1;
        let highestScore = 0;
        let bestMatchedFields: string[] = [];
        let bestMismatchedFields: string[] = [];

        for (const index of candidateIndices) {
            const candidate = candidates[index];
            const { score, matchedFields, mismatchedFields } = this.calculateMatchScore(
                sourceRecord,
                candidate
            );

            if (score > highestScore) {
                highestScore = score;
                bestMatchIndex = index;
                bestMatchedFields = matchedFields;
                bestMismatchedFields = mismatchedFields;
            }
        }

        // Check if score meets minimum threshold
        if (highestScore >= (this.config.minMatchScore || 50)) {
            return {
                matchedIndex: bestMatchIndex,
                matchScore: highestScore,
                keyFieldMatch: false,
                matchedFields: bestMatchedFields,
                mismatchedFields: bestMismatchedFields,
                matchedRecord: candidates[bestMatchIndex]
            };
        }

        return this.createNoMatchResult();
    }

    /**
     * Calculate match score between two records
     *
     * @returns Object with score (0-100), matched fields, and mismatched fields
     */
    private calculateMatchScore(
        record1: Record<string, any>,
        record2: Record<string, any>
    ): { score: number; matchedFields: string[]; mismatchedFields: string[] } {
        const matchedFields: string[] = [];
        const mismatchedFields: string[] = [];
        let totalWeight = 0;
        let matchedWeight = 0;

        // Get all fields from both records
        const allFields = new Set([...Object.keys(record1), ...Object.keys(record2)]);

        for (const field of allFields) {
            const weight = 10; // Each field has equal weight
            totalWeight += weight;

            const value1 = record1[field];
            const value2 = record2[field];

            // Both records have this field
            if (field in record1 && field in record2) {
                if (this.areValuesEqual(value1, value2)) {
                    matchedFields.push(field);
                    matchedWeight += weight;
                } else {
                    mismatchedFields.push(field);
                    // Partial credit for having the field
                    matchedWeight += weight * 0.2;
                }
            } else {
                // Field exists in only one record
                mismatchedFields.push(field);
            }
        }

        const score = totalWeight > 0 ? (matchedWeight / totalWeight) * 100 : 0;

        return { score, matchedFields, mismatchedFields };
    }

    /**
     * Compare two values for equality based on configuration
     */
    private areValuesEqual(value1: any, value2: any): boolean {
        // Handle null/undefined/empty
        if (this.config.treatNullAsEmpty) {
            const isEmpty1 = this.isNullOrEmpty(value1);
            const isEmpty2 = this.isNullOrEmpty(value2);
            if (isEmpty1 && isEmpty2) {
                return true;
            }
        }

        // Handle null/undefined
        if (value1 === null && value2 === null) return true;
        if (value1 === undefined && value2 === undefined) return true;
        if (value1 === null || value2 === null) return false;
        if (value1 === undefined || value2 === undefined) return false;

        // Convert to strings for comparison
        let str1 = String(value1);
        let str2 = String(value2);

        // Trim if configured
        if (this.config.trimValues) {
            str1 = str1.trim();
            str2 = str2.trim();
        }

        // Case sensitivity
        if (!this.config.caseSensitive) {
            str1 = str1.toLowerCase();
            str2 = str2.toLowerCase();
        }

        return str1 === str2;
    }

    /**
     * Check if a value is null, undefined, or empty string
     */
    private isNullOrEmpty(value: any): boolean {
        if (value === null || value === undefined) {
            return true;
        }
        if (typeof value === 'string') {
            return this.config.trimValues ? value.trim() === '' : value === '';
        }
        return false;
    }

    /**
     * Create a match result object
     */
    private createMatchResult(
        sourceRecord: Record<string, any>,
        matchedRecord: Record<string, any>,
        matchedIndex: number,
        keyFieldMatch: boolean
    ): MatchResult {
        const { matchedFields, mismatchedFields } = this.compareRecords(
            sourceRecord,
            matchedRecord
        );

        return {
            matchedIndex,
            matchScore: 100, // Exact match by keys
            keyFieldMatch,
            matchedFields,
            mismatchedFields,
            matchedRecord
        };
    }

    /**
     * Create a "no match" result
     */
    private createNoMatchResult(): MatchResult {
        return {
            matchedIndex: -1,
            matchScore: 0,
            keyFieldMatch: false,
            matchedFields: [],
            mismatchedFields: []
        };
    }

    /**
     * Compare two records and return matched/mismatched fields
     */
    private compareRecords(
        record1: Record<string, any>,
        record2: Record<string, any>
    ): { matchedFields: string[]; mismatchedFields: string[] } {
        const matchedFields: string[] = [];
        const mismatchedFields: string[] = [];

        const allFields = new Set([...Object.keys(record1), ...Object.keys(record2)]);

        for (const field of allFields) {
            if (field in record1 && field in record2) {
                if (this.areValuesEqual(record1[field], record2[field])) {
                    matchedFields.push(field);
                } else {
                    mismatchedFields.push(field);
                }
            } else {
                mismatchedFields.push(field);
            }
        }

        return { matchedFields, mismatchedFields };
    }

    /**
     * Update matching configuration
     */
    public setConfig(config: Partial<RecordMatchConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current configuration
     */
    public getConfig(): RecordMatchConfig {
        return { ...this.config };
    }
}
