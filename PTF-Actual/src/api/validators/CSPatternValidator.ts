/**
 * Pattern Validator
 * Regex-based validation for API response fields
 * Supports common patterns and custom regex
 *
 */

import { CSReporter } from '../../reporter/CSReporter';

export interface PatternValidationResult {
    isValid: boolean;
    pattern: string;
    value: string;
    error?: string;
    matchedGroups?: string[];
}

export class CSPatternValidator {
    private commonPatterns: Map<string, string> = new Map();

    constructor() {
        this.initializeCommonPatterns();
    }

    private initializeCommonPatterns(): void {
        // Email patterns
        this.commonPatterns.set('email', '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$');
        this.commonPatterns.set('email-simple', '^[^@]+@[^@]+\\.[^@]+$');
        this.commonPatterns.set('email-strict', '^[a-z0-9!#$%&\'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&\'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$');

        // Phone patterns
        this.commonPatterns.set('phone-us', '^\\+?1?[-.]?\\(?([0-9]{3})\\)?[-.]?([0-9]{3})[-.]?([0-9]{4})$');
        this.commonPatterns.set('phone-intl', '^\\+[1-9]\\d{1,14}$');
        this.commonPatterns.set('phone-simple', '^[+]?[(]?[0-9]{1,4}[)]?[-\\s\\.]?[(]?[0-9]{1,4}[)]?[-\\s\\.]?[0-9]{1,9}$');

        // Date patterns
        this.commonPatterns.set('date-iso', '^\\d{4}-\\d{2}-\\d{2}$');
        this.commonPatterns.set('date-us', '^(0?[1-9]|1[0-2])/(0?[1-9]|[12][0-9]|3[01])/\\d{4}$');
        this.commonPatterns.set('date-eu', '^(0?[1-9]|[12][0-9]|3[01])/(0?[1-9]|1[0-2])/\\d{4}$');
        this.commonPatterns.set('datetime-iso', '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}');
        this.commonPatterns.set('datetime-iso-full', '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z?$');

        // Time patterns
        this.commonPatterns.set('time-24h', '^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$');
        this.commonPatterns.set('time-12h', '^(0?[1-9]|1[0-2]):[0-5][0-9](:[0-5][0-9])? (AM|PM)$');

        // Numeric patterns
        this.commonPatterns.set('integer', '^-?\\d+$');
        this.commonPatterns.set('positive-integer', '^[1-9]\\d*$');
        this.commonPatterns.set('decimal', '^-?\\d+\\.\\d+$');
        this.commonPatterns.set('number', '^-?\\d+(\\.\\d+)?$');
        this.commonPatterns.set('positive-number', '^\\d+(\\.\\d+)?$');
        this.commonPatterns.set('percentage', '^(100(\\.0{1,2})?|\\d{1,2}(\\.\\d{1,2})?)%?$');

        // String patterns
        this.commonPatterns.set('alpha', '^[a-zA-Z]+$');
        this.commonPatterns.set('alphanumeric', '^[a-zA-Z0-9]+$');
        this.commonPatterns.set('alphanumeric-dash', '^[a-zA-Z0-9-_]+$');
        this.commonPatterns.set('lowercase', '^[a-z]+$');
        this.commonPatterns.set('uppercase', '^[A-Z]+$');

        // UUID patterns
        this.commonPatterns.set('uuid', '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
        this.commonPatterns.set('uuid-v4', '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

        // URL patterns
        this.commonPatterns.set('url', '^https?://[^\\s/$.?#].[^\\s]*$');
        this.commonPatterns.set('url-strict', '^https?://(?:www\\.)?[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-zA-Z0-9()]{1,6}\\b(?:[-a-zA-Z0-9()@:%_\\+.~#?&\\/=]*)$');
        this.commonPatterns.set('url-http', '^http://[^\\s/$.?#].[^\\s]*$');
        this.commonPatterns.set('url-https', '^https://[^\\s/$.?#].[^\\s]*$');

        // IP address patterns
        this.commonPatterns.set('ipv4', '^((25[0-5]|(2[0-4]|1\\d|[1-9]|)\\d)\\.?\\b){4}$');
        this.commonPatterns.set('ipv6', '^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4})$');

        // Credit card patterns
        this.commonPatterns.set('creditcard-visa', '^4[0-9]{12}(?:[0-9]{3})?$');
        this.commonPatterns.set('creditcard-mastercard', '^5[1-5][0-9]{14}$');
        this.commonPatterns.set('creditcard-amex', '^3[47][0-9]{13}$');
        this.commonPatterns.set('creditcard-discover', '^6(?:011|5[0-9]{2})[0-9]{12}$');
        this.commonPatterns.set('creditcard-any', '^(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})$');

        // Postal code patterns
        this.commonPatterns.set('zipcode-us', '^\\d{5}(-\\d{4})?$');
        this.commonPatterns.set('postal-code-ca', '^[A-Z]\\d[A-Z] ?\\d[A-Z]\\d$');
        this.commonPatterns.set('postal-code-uk', '^[A-Z]{1,2}\\d{1,2} ?\\d[A-Z]{2}$');

        // File patterns
        this.commonPatterns.set('file-image', '\\.(jpg|jpeg|png|gif|bmp|svg|webp)$');
        this.commonPatterns.set('file-document', '\\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt)$');
        this.commonPatterns.set('file-video', '\\.(mp4|avi|mov|wmv|flv|mkv|webm)$');
        this.commonPatterns.set('file-audio', '\\.(mp3|wav|ogg|flac|aac|wma)$');

        // JSON patterns
        this.commonPatterns.set('json-object', '^\\{.*\\}$');
        this.commonPatterns.set('json-array', '^\\[.*\\]$');

        // Boolean patterns
        this.commonPatterns.set('boolean', '^(true|false)$');
        this.commonPatterns.set('boolean-numeric', '^[01]$');

        // Empty/whitespace
        this.commonPatterns.set('empty', '^$');
        this.commonPatterns.set('not-empty', '.+');
        this.commonPatterns.set('whitespace', '^\\s*$');
        this.commonPatterns.set('no-whitespace', '^\\S+$');

        CSReporter.debug(`Initialized ${this.commonPatterns.size} common validation patterns`);
    }

    /**
     * Validate value against pattern
     *
     * @param value - Value to validate
     * @param pattern - Pattern name (from common patterns) or regex string
     * @param flags - Regex flags (i, g, m, etc.)
     * @returns Validation result
     */
    public validate(value: string, pattern: string, flags?: string): PatternValidationResult {
        try {
            // Check if pattern is a named common pattern
            const resolvedPattern = this.commonPatterns.get(pattern) || pattern;

            // Create regex
            const regex = new RegExp(resolvedPattern, flags);

            // Test pattern
            const isValid = regex.test(value);

            // Extract matched groups if available
            const matchedGroups: string[] = [];
            if (isValid) {
                const match = value.match(regex);
                if (match && match.length > 1) {
                    matchedGroups.push(...match.slice(1));
                }
            }

            return {
                isValid,
                pattern: resolvedPattern,
                value,
                matchedGroups: matchedGroups.length > 0 ? matchedGroups : undefined
            };

        } catch (error: any) {
            return {
                isValid: false,
                pattern,
                value,
                error: `Invalid regex pattern: ${error.message}`
            };
        }
    }

    /**
     * Validate that value does NOT match pattern
     */
    public validateNot(value: string, pattern: string, flags?: string): PatternValidationResult {
        const result = this.validate(value, pattern, flags);
        return {
            ...result,
            isValid: !result.isValid
        };
    }

    /**
     * Register custom named pattern
     */
    public registerPattern(name: string, pattern: string): void {
        this.commonPatterns.set(name, pattern);
        CSReporter.debug(`Registered custom pattern: ${name} = ${pattern}`);
    }

    /**
     * Get all registered pattern names
     */
    public getPatternNames(): string[] {
        return Array.from(this.commonPatterns.keys());
    }

    /**
     * Get pattern regex by name
     */
    public getPattern(name: string): string | undefined {
        return this.commonPatterns.get(name);
    }

    /**
     * Check if pattern exists
     */
    public hasPattern(name: string): boolean {
        return this.commonPatterns.has(name);
    }

    /**
     * Remove custom pattern
     */
    public removePattern(name: string): boolean {
        return this.commonPatterns.delete(name);
    }

    /**
     * Validate multiple values against same pattern
     */
    public validateAll(values: string[], pattern: string, flags?: string): PatternValidationResult[] {
        return values.map(value => this.validate(value, pattern, flags));
    }

    /**
     * Extract matched value from pattern with capture groups
     * Returns first captured group or null
     */
    public extract(value: string, pattern: string, flags?: string): string | null {
        const result = this.validate(value, pattern, flags);

        if (result.isValid && result.matchedGroups && result.matchedGroups.length > 0) {
            return result.matchedGroups[0];
        }

        return null;
    }

    /**
     * Extract all matched groups from pattern
     */
    public extractAll(value: string, pattern: string, flags?: string): string[] {
        const result = this.validate(value, pattern, flags);
        return result.matchedGroups || [];
    }

    /**
     * Get pattern suggestions based on value
     * Attempts to guess appropriate pattern for value
     */
    public suggestPatterns(value: string): string[] {
        const suggestions: string[] = [];

        for (const [name, pattern] of this.commonPatterns.entries()) {
            const regex = new RegExp(pattern);
            if (regex.test(value)) {
                suggestions.push(name);
            }
        }

        return suggestions;
    }
}
