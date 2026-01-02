/**
 * CS Playwright Test Framework - Spec Format ADO Resolver
 * Resolves ADO tags with priority hierarchy: Test → Describe → Environment
 */

import { ParsedADOTags, SpecTestOptions, SpecDescribeOptions } from './CSSpecTypes';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';

/**
 * Resolves and merges ADO tags from multiple sources
 */
export class CSSpecADOResolver {
    private static instance: CSSpecADOResolver;
    private config: CSConfigurationManager;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSSpecADOResolver {
        if (!CSSpecADOResolver.instance) {
            CSSpecADOResolver.instance = new CSSpecADOResolver();
        }
        return CSSpecADOResolver.instance;
    }

    /**
     * Normalize tags input to array format
     * Supports both array and space-separated string formats
     */
    private normalizeTags(tags?: string[] | string): string[] {
        if (!tags) {
            return [];
        }
        if (Array.isArray(tags)) {
            // Flatten array - some elements might be space-separated strings like '@tag1 @tag2'
            const result: string[] = [];
            for (const tag of tags) {
                if (tag.includes(' ') || (tag.match(/@/g) || []).length > 1) {
                    // Split by @ and normalize each part
                    const parts = tag.split('@').filter(t => t.trim()).map(t => `@${t.trim()}`);
                    result.push(...parts);
                } else {
                    result.push(tag.startsWith('@') ? tag : `@${tag}`);
                }
            }
            return result;
        }
        // Split string by @ and filter empty, then add @ back
        return tags.split('@').filter(t => t.trim()).map(t => `@${t.trim()}`);
    }

    /**
     * Parse tags into structured ADO tags
     * Supports both array format (preferred) and string format (legacy)
     * @example parseTags(['@smoke', '@TestPlanId:413', '@TestCaseId:415'])
     * @example parseTags('@smoke @TestPlanId:413 @TestCaseId:415')
     */
    public parseTags(tagsInput?: string[] | string): ParsedADOTags {
        const result: ParsedADOTags = {
            customTags: []
        };

        if (!tagsInput) {
            return result;
        }

        // Normalize to array format
        const tags = this.normalizeTags(tagsInput);

        for (const tag of tags) {
            const trimmedTag = tag.trim();
            // Remove leading @ for pattern matching
            const tagWithoutAt = trimmedTag.startsWith('@') ? trimmedTag.slice(1) : trimmedTag;

            // Parse TestPlanId
            const testPlanMatch = tagWithoutAt.match(/^TestPlanId[:\s]*(\d+)/i);
            if (testPlanMatch) {
                result.testPlanId = parseInt(testPlanMatch[1], 10);
                continue;
            }

            // Parse TestSuiteId
            const testSuiteMatch = tagWithoutAt.match(/^TestSuiteId[:\s]*(\d+)/i);
            if (testSuiteMatch) {
                result.testSuiteId = parseInt(testSuiteMatch[1], 10);
                continue;
            }

            // Parse TestCaseId - supports single or multiple: @TestCaseId:415 or @TestCaseId:{415,416,417}
            const testCaseMatch = tagWithoutAt.match(/^TestCaseId[:\s]*\{?([^}]+)\}?/i);
            if (testCaseMatch) {
                const idsString = testCaseMatch[1];
                result.testCaseIds = idsString
                    .split(',')
                    .map(id => parseInt(id.trim(), 10))
                    .filter(id => !isNaN(id));
                continue;
            }

            // Everything else is a custom tag (ensure it has @ prefix)
            const customTag = trimmedTag.startsWith('@') ? trimmedTag : `@${trimmedTag}`;
            result.customTags.push(customTag);
        }

        return result;
    }

    /**
     * Resolve ADO tags with priority hierarchy
     * Priority: Test level → Describe level → Environment level
     */
    public resolveADOTags(
        testOptions?: SpecTestOptions,
        describeOptions?: SpecDescribeOptions,
        parentDescribes?: SpecDescribeOptions[]
    ): ParsedADOTags {
        // Start with environment-level defaults
        const envTags: ParsedADOTags = {
            testPlanId: this.config.getNumber('ADO_TEST_PLAN_ID'),
            testSuiteId: this.config.getNumber('ADO_TEST_SUITE_ID'),
            customTags: []
        };

        // Collect all describe-level tags (from outermost to innermost)
        const describeTags: ParsedADOTags[] = [];
        if (parentDescribes) {
            for (const describe of parentDescribes) {
                if (describe.tags) {
                    describeTags.push(this.parseTags(describe.tags));
                }
            }
        }
        if (describeOptions?.tags) {
            describeTags.push(this.parseTags(describeOptions.tags));
        }

        // Parse test-level tags
        const testTags = testOptions?.tags ? this.parseTags(testOptions.tags) : null;

        // Merge with priority: Test > Describe (innermost first) > Environment
        const resolved: ParsedADOTags = { customTags: [] };

        // TestPlanId priority
        resolved.testPlanId = testTags?.testPlanId
            ?? this.findFirstDefined(describeTags.reverse(), 'testPlanId')
            ?? envTags.testPlanId;

        // TestSuiteId priority
        resolved.testSuiteId = testTags?.testSuiteId
            ?? this.findFirstDefined(describeTags, 'testSuiteId')
            ?? envTags.testSuiteId;

        // TestCaseIds - only from test level (doesn't make sense at describe level)
        resolved.testCaseIds = testTags?.testCaseIds;

        // Custom tags - merge all (deduplicated)
        const allCustomTags = new Set<string>();

        // Add environment tags if any
        const envTagString = this.config.get('ADO_TAGS');
        if (envTagString) {
            const parsed = this.parseTags(envTagString);
            parsed.customTags.forEach(t => allCustomTags.add(t));
        }

        // Add describe-level tags (outermost first)
        for (const dt of describeTags) {
            dt.customTags.forEach(t => allCustomTags.add(t));
        }

        // Add test-level tags
        if (testTags) {
            testTags.customTags.forEach(t => allCustomTags.add(t));
        }

        resolved.customTags = Array.from(allCustomTags);

        return resolved;
    }

    /**
     * Find first defined value in array of parsed tags
     */
    private findFirstDefined(
        tags: ParsedADOTags[],
        property: keyof ParsedADOTags
    ): number | undefined {
        for (const tag of tags) {
            const value = tag[property];
            if (value !== undefined && value !== null) {
                if (typeof value === 'number') {
                    return value;
                }
            }
        }
        return undefined;
    }

    /**
     * Check if a test matches the tag filter
     * Filter format: "@smoke" or "@smoke and @login" or "@smoke or @regression"
     */
    public matchesTagFilter(
        testTags: string[],
        filter?: string
    ): boolean {
        if (!filter) {
            return true;
        }

        const filterLower = filter.toLowerCase();

        // Handle AND expressions
        if (filterLower.includes(' and ')) {
            const parts = filterLower.split(' and ').map(p => p.trim());
            return parts.every(part => this.tagMatchesSingle(testTags, part));
        }

        // Handle OR expressions
        if (filterLower.includes(' or ')) {
            const parts = filterLower.split(' or ').map(p => p.trim());
            return parts.some(part => this.tagMatchesSingle(testTags, part));
        }

        // Handle comma-separated tags (OR logic)
        if (filterLower.includes(',')) {
            const parts = filterLower.split(',').map(p => p.trim());
            return parts.some(part => this.tagMatchesSingle(testTags, part));
        }

        // Single tag match
        return this.tagMatchesSingle(testTags, filterLower);
    }

    /**
     * Check if tags contain a single filter tag
     */
    private tagMatchesSingle(testTags: string[], filterTag: string): boolean {
        const normalizedFilter = filterTag.startsWith('@') ? filterTag : `@${filterTag}`;

        return testTags.some(tag => {
            const normalizedTag = tag.toLowerCase();
            return normalizedTag === normalizedFilter ||
                   normalizedTag.startsWith(normalizedFilter + ':');
        });
    }

    /**
     * Extract all tags as a string array for reporting
     */
    public getAllTags(parsed: ParsedADOTags): string[] {
        const tags: string[] = [];

        if (parsed.testPlanId) {
            tags.push(`@TestPlanId:${parsed.testPlanId}`);
        }
        if (parsed.testSuiteId) {
            tags.push(`@TestSuiteId:${parsed.testSuiteId}`);
        }
        if (parsed.testCaseIds && parsed.testCaseIds.length > 0) {
            if (parsed.testCaseIds.length === 1) {
                tags.push(`@TestCaseId:${parsed.testCaseIds[0]}`);
            } else {
                tags.push(`@TestCaseId:{${parsed.testCaseIds.join(',')}}`);
            }
        }

        tags.push(...parsed.customTags);

        return tags;
    }

    /**
     * Log resolved ADO configuration
     */
    public logResolvedTags(testName: string, resolved: ParsedADOTags): void {
        CSReporter.debug(`[ADO] Test "${testName}" resolved tags:`);
        CSReporter.debug(`  - TestPlanId: ${resolved.testPlanId ?? 'not set'}`);
        CSReporter.debug(`  - TestSuiteId: ${resolved.testSuiteId ?? 'not set'}`);
        CSReporter.debug(`  - TestCaseIds: ${resolved.testCaseIds?.join(', ') ?? 'not set'}`);
        CSReporter.debug(`  - Custom Tags: ${resolved.customTags.join(', ') || 'none'}`);
    }
}
