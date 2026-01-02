/**
 * TestDataExtractor - Intelligent Test Data Extraction
 *
 * Extracts test data from recorded actions, detects data types,
 * masks sensitive data, and generates data files.
 */

import { Action } from '../types';

export interface ExtractedTestData {
    data: Record<string, TestDataValue>;
    dataFile: string;
    sensitiveFields: string[];
    suggestedVariations: DataVariation[];
    environmentVariables: EnvironmentVariable[];
}

export interface TestDataValue {
    value: string | number | boolean;
    originalValue: string | number | boolean; // Original value for feature file replacement
    type: DataType;
    field: string;
    source: 'fill' | 'select' | 'url' | 'assertion' | 'click' | 'text';
    isSensitive: boolean;
    suggestedParamName: string;
}

export interface DataVariation {
    field: string;
    variationType: 'valid' | 'invalid' | 'boundary' | 'empty' | 'special';
    value: string;
    description: string;
}

export interface EnvironmentVariable {
    name: string;
    value: string;
    type: 'url' | 'credential' | 'config';
    description: string;
}

export type DataType =
    | 'email'
    | 'password'
    | 'phone'
    | 'url'
    | 'date'
    | 'number'
    | 'currency'
    | 'username'
    | 'name'
    | 'address'
    | 'text'
    | 'boolean'
    | 'id'
    | 'token';

export class TestDataExtractor {
    // Patterns for detecting data types
    private static readonly DATA_PATTERNS: Array<{ type: DataType; pattern: RegExp; fieldHints: string[] }> = [
        { type: 'email', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, fieldHints: ['email', 'mail', 'e-mail'] },
        { type: 'password', pattern: /.*/, fieldHints: ['password', 'passwd', 'pwd', 'secret', 'pass'] },
        { type: 'phone', pattern: /^[\d\s\-+()]{7,20}$/, fieldHints: ['phone', 'mobile', 'tel', 'cell'] },
        { type: 'url', pattern: /^https?:\/\//, fieldHints: ['url', 'link', 'website', 'site'] },
        { type: 'date', pattern: /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/, fieldHints: ['date', 'dob', 'birth', 'expir'] },
        { type: 'number', pattern: /^-?\d+(\.\d+)?$/, fieldHints: ['amount', 'quantity', 'count', 'number', 'num'] },
        { type: 'currency', pattern: /^[$€£¥]?\d+([,.]\d{2})?$/, fieldHints: ['price', 'cost', 'amount', 'total', 'balance'] },
        { type: 'username', pattern: /^[\w.-]+$/, fieldHints: ['username', 'user', 'login', 'userid', 'user_id'] },
        { type: 'name', pattern: /^[a-zA-Z\s'-]+$/, fieldHints: ['name', 'firstname', 'lastname', 'fullname'] },
        { type: 'id', pattern: /^[a-zA-Z0-9_-]+$/, fieldHints: ['id', 'identifier', 'code', 'key'] },
        { type: 'token', pattern: /^[a-zA-Z0-9_-]{20,}$/, fieldHints: ['token', 'api_key', 'apikey', 'auth'] },
    ];

    // Sensitive field patterns
    private static readonly SENSITIVE_PATTERNS = [
        /password/i,
        /passwd/i,
        /secret/i,
        /token/i,
        /api[_-]?key/i,
        /auth/i,
        /credential/i,
        /private/i,
        /ssn/i,
        /social/i,
        /credit/i,
        /card/i,
        /cvv/i,
        /pin/i,
    ];

    /**
     * Extract test data from actions
     */
    public static extract(actions: Action[]): ExtractedTestData {
        const data: Record<string, TestDataValue> = {};
        const sensitiveFields: string[] = [];
        const environmentVariables: EnvironmentVariable[] = [];

        let dataIndex = 0;

        for (const action of actions) {
            // Extract from fill/type actions
            if ((action.method === 'fill' || action.method === 'type') && action.args?.length > 0) {
                const value = action.args[0] as string;
                const fieldName = this.extractFieldName(action);
                const dataKey = this.generateDataKey(fieldName, dataIndex++);

                const dataType = this.detectDataType(value, fieldName);
                const isSensitive = this.isSensitiveField(fieldName);

                data[dataKey] = {
                    value: isSensitive ? this.maskValue(value) : value,
                    originalValue: value, // Keep original for feature file replacement
                    type: dataType,
                    field: fieldName,
                    source: 'fill',
                    isSensitive,
                    suggestedParamName: this.toParamName(fieldName),
                };

                if (isSensitive) {
                    sensitiveFields.push(fieldName);
                }
            }

            // Extract from selectOption actions
            if (action.method === 'selectOption' && action.args?.length > 0) {
                const value = action.args[0] as string;
                const fieldName = this.extractFieldName(action);
                const dataKey = this.generateDataKey(fieldName, dataIndex++);

                data[dataKey] = {
                    value,
                    originalValue: value, // Keep original for feature file replacement
                    type: 'text',
                    field: fieldName,
                    source: 'select',
                    isSensitive: false,
                    suggestedParamName: this.toParamName(fieldName),
                };
            }

            // Extract text from getByText click actions (e.g., clicking "Disabled", "Enabled")
            if (action.method === 'click' && action.target?.type === 'getByText') {
                const value = action.target.selector;
                if (value && typeof value === 'string' && value.length > 0) {
                    const dataKey = this.generateDataKey(value, dataIndex++);

                    data[dataKey] = {
                        value,
                        originalValue: value,
                        type: 'text',
                        field: value,
                        source: 'click',
                        isSensitive: false,
                        suggestedParamName: this.toParamName(value),
                    };
                }
            }

            // Extract text from getByRole with name (e.g., row names, button names for parameterization)
            if (action.method === 'click' && action.target?.type === 'getByRole' && action.target?.options?.name) {
                const value = action.target.options.name;
                const role = action.target.selector;
                // Only parameterize data-like values (not generic UI elements like "Login", "Search")
                if (this.isDataValue(value, role)) {
                    const dataKey = this.generateDataKey(value, dataIndex++);

                    data[dataKey] = {
                        value,
                        originalValue: value,
                        type: 'text',
                        field: `${role}_${value}`.replace(/\s+/g, '_'),
                        source: 'click',
                        isSensitive: false,
                        suggestedParamName: this.toParamName(value),
                    };
                }
            }

            // Extract assertion text values (toContainText, toHaveText)
            if (action.type === 'assertion' && action.args?.length > 0) {
                const value = action.args[0] as string;
                if (value && typeof value === 'string' && value.length > 0) {
                    const fieldName = this.extractAssertionFieldName(action);
                    const dataKey = this.generateDataKey(`expected_${fieldName}`, dataIndex++);

                    data[dataKey] = {
                        value,
                        originalValue: value,
                        type: 'text',
                        field: fieldName,
                        source: 'assertion',
                        isSensitive: false,
                        suggestedParamName: `expected${this.toPascalCase(fieldName)}`,
                    };
                }
            }

            // Extract URLs from navigation
            if (action.method === 'goto' && action.args?.length > 0) {
                const url = action.args[0] as string;
                environmentVariables.push({
                    name: 'BASE_URL',
                    value: this.extractBaseUrl(url),
                    type: 'url',
                    description: 'Application base URL',
                });
            }
        }

        // Generate suggested variations
        const suggestedVariations = this.generateVariations(data);

        // Generate data file content
        const dataFile = this.generateDataFile(data);

        return {
            data,
            dataFile,
            sensitiveFields,
            suggestedVariations,
            environmentVariables,
        };
    }

    /**
     * Extract field name from action
     */
    private static extractFieldName(action: Action): string {
        if (action.target?.options?.name) {
            return action.target.options.name;
        }
        if (action.target?.type === 'getByPlaceholder') {
            return action.target.selector;
        }
        if (action.target?.type === 'getByLabel') {
            return action.target.selector;
        }
        return 'field';
    }

    /**
     * Extract field name from assertion action
     */
    private static extractAssertionFieldName(action: Action): string {
        // Try to get from target
        if (action.target?.options?.name) {
            return action.target.options.name;
        }
        if (action.target?.selector) {
            // Clean up selector to make a field name
            return action.target.selector
                .replace(/[^a-zA-Z0-9]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_|_$/g, '')
                .toLowerCase() || 'text';
        }
        return 'text';
    }

    /**
     * Check if a value is data-like (should be parameterized) vs UI element
     * UI elements like "Login", "Search", "Submit" should not be parameterized
     * Data values like "manda akhil user 2023-16-01", "Disabled", "Enabled" should be
     */
    private static isDataValue(value: string, role: string): boolean {
        // Common UI action buttons/links that should NOT be parameterized
        const uiElements = [
            'login', 'logout', 'submit', 'cancel', 'save', 'delete', 'edit',
            'add', 'remove', 'search', 'filter', 'reset', 'clear', 'close',
            'ok', 'yes', 'no', 'confirm', 'apply', 'next', 'previous', 'back',
            'home', 'admin', 'dashboard', 'settings', 'profile', 'menu',
            'time', 'leave', 'pim', 'recruitment', 'performance', 'directory',
            'maintenance', 'claim', 'buzz'
        ];

        const lowerValue = value.toLowerCase();

        // If it's a common UI element, don't parameterize
        if (uiElements.includes(lowerValue)) {
            return false;
        }

        // If it's a row with specific data (dates, names, IDs), parameterize it
        if (role === 'row') {
            return true;
        }

        // If it looks like status/state values, parameterize them
        const statusValues = ['enabled', 'disabled', 'active', 'inactive', 'pending', 'approved', 'rejected'];
        if (statusValues.includes(lowerValue)) {
            return true;
        }

        // If it contains numbers or special patterns (likely data), parameterize
        if (value.match(/\d{2,}/) || value.includes('-') || value.includes('/')) {
            return true;
        }

        return false;
    }

    /**
     * Convert to PascalCase
     */
    private static toPascalCase(str: string): string {
        return str
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .trim()
            .split(/\s+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }

    /**
     * Generate unique data key
     */
    private static generateDataKey(fieldName: string, index: number): string {
        const clean = fieldName
            .replace(/[^a-zA-Z0-9]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '')
            .toLowerCase();

        return clean || `field_${index}`;
    }

    /**
     * Detect data type from value and field name
     */
    private static detectDataType(value: string, fieldName: string): DataType {
        const lowerFieldName = fieldName.toLowerCase();

        // Check field hints first
        for (const { type, fieldHints } of this.DATA_PATTERNS) {
            if (fieldHints.some(hint => lowerFieldName.includes(hint))) {
                return type;
            }
        }

        // Check value patterns
        for (const { type, pattern } of this.DATA_PATTERNS) {
            if (pattern.test(value)) {
                return type;
            }
        }

        return 'text';
    }

    /**
     * Check if field is sensitive
     */
    private static isSensitiveField(fieldName: string): boolean {
        return this.SENSITIVE_PATTERNS.some(pattern => pattern.test(fieldName));
    }

    /**
     * Mask sensitive value
     */
    private static maskValue(value: string): string {
        if (value.length <= 4) {
            return '****';
        }
        return value.substring(0, 2) + '*'.repeat(value.length - 4) + value.substring(value.length - 2);
    }

    /**
     * Convert field name to parameter name
     */
    private static toParamName(fieldName: string): string {
        return fieldName
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .trim()
            .split(/\s+/)
            .map((word, index) => {
                if (index === 0) return word.toLowerCase();
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join('');
    }

    /**
     * Extract base URL from full URL
     */
    private static extractBaseUrl(url: string): string {
        try {
            const urlObj = new URL(url);
            return `${urlObj.protocol}//${urlObj.host}`;
        } catch {
            return url;
        }
    }

    /**
     * Generate data variations for testing
     */
    private static generateVariations(data: Record<string, TestDataValue>): DataVariation[] {
        const variations: DataVariation[] = [];

        for (const [key, testData] of Object.entries(data)) {
            switch (testData.type) {
                case 'email':
                    variations.push(
                        { field: key, variationType: 'invalid', value: 'invalid-email', description: 'Invalid email format' },
                        { field: key, variationType: 'empty', value: '', description: 'Empty email' },
                        { field: key, variationType: 'special', value: 'test+special@example.com', description: 'Email with special chars' }
                    );
                    break;

                case 'password':
                    variations.push(
                        { field: key, variationType: 'invalid', value: '123', description: 'Too short password' },
                        { field: key, variationType: 'empty', value: '', description: 'Empty password' },
                        { field: key, variationType: 'boundary', value: 'a'.repeat(100), description: 'Very long password' }
                    );
                    break;

                case 'phone':
                    variations.push(
                        { field: key, variationType: 'invalid', value: 'abc', description: 'Non-numeric phone' },
                        { field: key, variationType: 'boundary', value: '1', description: 'Too short phone' },
                        { field: key, variationType: 'special', value: '+1 (555) 123-4567', description: 'Phone with formatting' }
                    );
                    break;

                case 'number':
                    variations.push(
                        { field: key, variationType: 'invalid', value: 'abc', description: 'Non-numeric value' },
                        { field: key, variationType: 'boundary', value: '0', description: 'Zero value' },
                        { field: key, variationType: 'boundary', value: '-1', description: 'Negative value' },
                        { field: key, variationType: 'boundary', value: '999999999', description: 'Large value' }
                    );
                    break;

                case 'text':
                    variations.push(
                        { field: key, variationType: 'empty', value: '', description: 'Empty text' },
                        { field: key, variationType: 'special', value: '<script>alert(1)</script>', description: 'XSS attempt' },
                        { field: key, variationType: 'special', value: "'; DROP TABLE users; --", description: 'SQL injection attempt' },
                        { field: key, variationType: 'boundary', value: 'a'.repeat(500), description: 'Very long text' }
                    );
                    break;
            }
        }

        return variations;
    }

    /**
     * Generate JSON data file content in array format for Scenario Outline
     * Format: Array of test case objects with testCaseId, runFlag, scenarioName, and data fields
     */
    private static generateDataFile(data: Record<string, TestDataValue>): string {
        // Create array format for JSON Examples (data-driven pattern)
        const testCases: any[] = [];

        // Generate primary test case with extracted data
        const primaryTestCase: Record<string, any> = {
            testCaseId: 'TC01_Recorded_Flow',
            scenarioName: 'Execute recorded test flow - Primary data',
            runFlag: 'Yes',
        };

        // Add all extracted data fields to the test case
        for (const [key, testData] of Object.entries(data)) {
            primaryTestCase[key] = testData.isSensitive
                ? `\${${key.toUpperCase()}}`
                : testData.value;
        }

        testCases.push(primaryTestCase);

        // Generate a variation test case (for negative testing)
        const variationTestCase: Record<string, any> = {
            testCaseId: 'TC02_Recorded_Flow_Variation',
            scenarioName: 'Execute recorded test flow - Variation data',
            runFlag: 'No', // Disabled by default, user can enable
        };

        // Add variation data
        for (const [key, testData] of Object.entries(data)) {
            if (testData.isSensitive) {
                variationTestCase[key] = `\${${key.toUpperCase()}_ALT}`;
            } else if (testData.type === 'email') {
                variationTestCase[key] = 'test.variation@example.com';
            } else if (testData.type === 'username') {
                variationTestCase[key] = 'testuser_variation';
            } else {
                variationTestCase[key] = `${testData.value}_variation`;
            }
        }

        testCases.push(variationTestCase);

        return JSON.stringify(testCases, null, 2);
    }

    /**
     * Generate parameterized step with data references
     */
    public static generateParameterizedStep(
        stepPattern: string,
        dataReferences: Record<string, string>
    ): string {
        let parameterizedStep = stepPattern;

        for (const [placeholder, dataKey] of Object.entries(dataReferences)) {
            parameterizedStep = parameterizedStep.replace(
                `"${placeholder}"`,
                `"<${dataKey}>"`
            );
        }

        return parameterizedStep;
    }
}

export default TestDataExtractor;
