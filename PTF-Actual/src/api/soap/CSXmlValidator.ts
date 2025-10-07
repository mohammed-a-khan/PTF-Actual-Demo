import { CSXmlParser, XmlValidationResult } from './CSXmlParser';
import { CSReporter } from '../../reporter/CSReporter';

/**
 * XML Validator and Comparison Engine
 * Provides comprehensive XML validation, schema validation, and comparison capabilities
 */

export interface XmlComparisonOptions {
    ignoreOrder?: boolean;
    ignoreWhitespace?: boolean;
    ignoreComments?: boolean;
    ignoreAttributes?: boolean;
    ignoreNamespaces?: boolean;
    caseSensitive?: boolean;
    ignoreElements?: string[];
    compareOnly?: string[]; // Only compare these elements
}

export interface XmlComparisonResult {
    equal: boolean;
    differences: XmlDifference[];
    summary: {
        totalDifferences: number;
        missingElements: number;
        extraElements: number;
        valueMismatches: number;
        attributeMismatches: number;
    };
}

export interface XmlDifference {
    type: 'missing' | 'extra' | 'value_mismatch' | 'attribute_mismatch' | 'type_mismatch';
    path: string;
    expected?: any;
    actual?: any;
    message: string;
}

export interface XmlSchemaValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    elementCount: number;
    attributeCount: number;
}

export interface XmlPathAssertion {
    path: string;
    expectedValue?: any;
    exists?: boolean;
    contains?: string;
    matches?: RegExp;
    type?: string;
}

export class CSXmlValidator {
    private xmlParser: CSXmlParser;
    private comparisonOptions: XmlComparisonOptions;

    constructor(options?: XmlComparisonOptions) {
        this.xmlParser = new CSXmlParser();
        this.comparisonOptions = {
            ignoreOrder: false,
            ignoreWhitespace: true,
            ignoreComments: true,
            ignoreAttributes: false,
            ignoreNamespaces: false,
            caseSensitive: true,
            ignoreElements: [],
            ...options
        };
    }

    /**
     * Validate XML structure
     */
    public async validateXml(xmlString: string): Promise<XmlValidationResult> {
        return await this.xmlParser.validateXml(xmlString);
    }

    /**
     * Compare two XML documents with advanced options
     */
    public async compareXml(
        actualXml: string,
        expectedXml: string,
        options?: XmlComparisonOptions
    ): Promise<XmlComparisonResult> {
        const compOptions = { ...this.comparisonOptions, ...options };
        const differences: XmlDifference[] = [];

        try {
            // Preprocess XMLs based on options
            let processedActual = actualXml;
            let processedExpected = expectedXml;

            if (compOptions.ignoreWhitespace) {
                processedActual = this.normalizeWhitespace(processedActual);
                processedExpected = this.normalizeWhitespace(processedExpected);
            }

            if (compOptions.ignoreComments) {
                processedActual = this.removeComments(processedActual);
                processedExpected = this.removeComments(processedExpected);
            }

            if (compOptions.ignoreNamespaces) {
                processedActual = this.xmlParser.removeNamespaces(processedActual);
                processedExpected = this.xmlParser.removeNamespaces(processedExpected);
            }

            // Parse XMLs
            const actualObj = await this.xmlParser.parseXml(processedActual);
            const expectedObj = await this.xmlParser.parseXml(processedExpected);

            // Compare objects
            this.compareObjects(
                actualObj,
                expectedObj,
                '',
                differences,
                compOptions
            );

            // Generate summary
            const summary = this.generateComparisonSummary(differences);

            CSReporter.debug(`XML Comparison: ${differences.length} differences found`);

            return {
                equal: differences.length === 0,
                differences,
                summary
            };
        } catch (error) {
            differences.push({
                type: 'value_mismatch',
                path: 'root',
                message: `Parse error: ${(error as Error).message}`
            });

            return {
                equal: false,
                differences,
                summary: this.generateComparisonSummary(differences)
            };
        }
    }

    /**
     * Compare JavaScript objects (recursive)
     */
    private compareObjects(
        actual: any,
        expected: any,
        path: string,
        differences: XmlDifference[],
        options: XmlComparisonOptions
    ): void {
        // Type check
        if (typeof actual !== typeof expected) {
            differences.push({
                type: 'type_mismatch',
                path,
                expected: typeof expected,
                actual: typeof actual,
                message: `Type mismatch at ${path}: expected ${typeof expected}, got ${typeof actual}`
            });
            return;
        }

        // Handle arrays
        if (Array.isArray(actual) && Array.isArray(expected)) {
            this.compareArrays(actual, expected, path, differences, options);
            return;
        }

        // Handle objects
        if (typeof actual === 'object' && actual !== null && expected !== null) {
            const actualKeys = Object.keys(actual).filter(k => !this.shouldIgnoreKey(k, options));
            const expectedKeys = Object.keys(expected).filter(k => !this.shouldIgnoreKey(k, options));

            // Check for missing keys
            for (const key of expectedKeys) {
                if (!actualKeys.includes(key)) {
                    differences.push({
                        type: 'missing',
                        path: `${path}.${key}`,
                        expected: expected[key],
                        message: `Missing element at ${path}.${key}`
                    });
                }
            }

            // Check for extra keys
            for (const key of actualKeys) {
                if (!expectedKeys.includes(key)) {
                    differences.push({
                        type: 'extra',
                        path: `${path}.${key}`,
                        actual: actual[key],
                        message: `Extra element at ${path}.${key}`
                    });
                }
            }

            // Compare common keys
            const commonKeys = actualKeys.filter(k => expectedKeys.includes(k));
            for (const key of commonKeys) {
                const newPath = path ? `${path}.${key}` : key;
                this.compareObjects(actual[key], expected[key], newPath, differences, options);
            }

            return;
        }

        // Handle primitive values
        if (actual !== expected) {
            const actualStr = options.caseSensitive ? String(actual) : String(actual).toLowerCase();
            const expectedStr = options.caseSensitive ? String(expected) : String(expected).toLowerCase();

            if (actualStr !== expectedStr) {
                differences.push({
                    type: 'value_mismatch',
                    path,
                    expected,
                    actual,
                    message: `Value mismatch at ${path}: expected "${expected}", got "${actual}"`
                });
            }
        }
    }

    /**
     * Compare arrays
     */
    private compareArrays(
        actual: any[],
        expected: any[],
        path: string,
        differences: XmlDifference[],
        options: XmlComparisonOptions
    ): void {
        if (!options.ignoreOrder && actual.length !== expected.length) {
            differences.push({
                type: 'value_mismatch',
                path,
                expected: expected.length,
                actual: actual.length,
                message: `Array length mismatch at ${path}: expected ${expected.length}, got ${actual.length}`
            });
        }

        const length = Math.min(actual.length, expected.length);
        for (let i = 0; i < length; i++) {
            this.compareObjects(actual[i], expected[i], `${path}[${i}]`, differences, options);
        }
    }

    /**
     * Check if key should be ignored
     */
    private shouldIgnoreKey(key: string, options: XmlComparisonOptions): boolean {
        // Ignore XML attributes if specified
        if (options.ignoreAttributes && key === '$') {
            return true;
        }

        // Ignore specified elements
        if (options.ignoreElements && options.ignoreElements.includes(key)) {
            return true;
        }

        // If compareOnly is specified, ignore all other keys
        if (options.compareOnly && !options.compareOnly.includes(key)) {
            return true;
        }

        return false;
    }

    /**
     * Generate comparison summary
     */
    private generateComparisonSummary(differences: XmlDifference[]): XmlComparisonResult['summary'] {
        return {
            totalDifferences: differences.length,
            missingElements: differences.filter(d => d.type === 'missing').length,
            extraElements: differences.filter(d => d.type === 'extra').length,
            valueMismatches: differences.filter(d => d.type === 'value_mismatch').length,
            attributeMismatches: differences.filter(d => d.type === 'attribute_mismatch').length
        };
    }

    /**
     * Assert XML path exists and optionally matches criteria
     */
    public async assertXPath(xmlString: string, assertion: XmlPathAssertion): Promise<boolean> {
        const queryResult = await this.xmlParser.queryXPath(xmlString, assertion.path);

        // Check existence
        if (assertion.exists !== undefined) {
            if (assertion.exists && !queryResult.found) {
                throw new Error(`XPath assertion failed: Element not found at ${assertion.path}`);
            }
            if (!assertion.exists && queryResult.found) {
                throw new Error(`XPath assertion failed: Element found at ${assertion.path} but should not exist`);
            }
            return true;
        }

        if (!queryResult.found) {
            throw new Error(`XPath assertion failed: Element not found at ${assertion.path}`);
        }

        // Check expected value
        if (assertion.expectedValue !== undefined) {
            if (queryResult.value !== assertion.expectedValue) {
                throw new Error(
                    `XPath assertion failed: Expected "${assertion.expectedValue}" at ${assertion.path}, got "${queryResult.value}"`
                );
            }
        }

        // Check contains
        if (assertion.contains !== undefined) {
            const valueStr = String(queryResult.value);
            if (!valueStr.includes(assertion.contains)) {
                throw new Error(
                    `XPath assertion failed: Value at ${assertion.path} does not contain "${assertion.contains}"`
                );
            }
        }

        // Check regex match
        if (assertion.matches !== undefined) {
            const valueStr = String(queryResult.value);
            if (!assertion.matches.test(valueStr)) {
                throw new Error(
                    `XPath assertion failed: Value at ${assertion.path} does not match pattern ${assertion.matches}`
                );
            }
        }

        // Check type
        if (assertion.type !== undefined) {
            if (queryResult.type !== assertion.type) {
                throw new Error(
                    `XPath assertion failed: Expected type "${assertion.type}" at ${assertion.path}, got "${queryResult.type}"`
                );
            }
        }

        CSReporter.pass(`XPath assertion passed: ${assertion.path}`);
        return true;
    }

    /**
     * Validate XML against multiple XPath assertions
     */
    public async assertMultipleXPaths(
        xmlString: string,
        assertions: XmlPathAssertion[]
    ): Promise<{ passed: number; failed: number; failures: string[] }> {
        let passed = 0;
        let failed = 0;
        const failures: string[] = [];

        for (const assertion of assertions) {
            try {
                await this.assertXPath(xmlString, assertion);
                passed++;
            } catch (error) {
                failed++;
                failures.push((error as Error).message);
            }
        }

        return { passed, failed, failures };
    }

    /**
     * Validate XML schema structure (basic validation)
     */
    public async validateSchema(xmlString: string): Promise<XmlSchemaValidationResult> {
        const errors: string[] = [];
        const warnings: string[] = [];

        try {
            const obj = await this.xmlParser.parseXml(xmlString);

            // Count elements and attributes
            let elementCount = 0;
            let attributeCount = 0;
            this.countElementsRecursive(obj, (hasAttributes) => {
                elementCount++;
                if (hasAttributes) attributeCount++;
            });

            // Basic structural validation
            if (elementCount === 0) {
                warnings.push('XML document appears to be empty');
            }

            return {
                valid: errors.length === 0,
                errors,
                warnings,
                elementCount,
                attributeCount
            };
        } catch (error) {
            errors.push((error as Error).message);
            return {
                valid: false,
                errors,
                warnings,
                elementCount: 0,
                attributeCount: 0
            };
        }
    }

    /**
     * Count elements recursively (internal)
     */
    private countElementsRecursive(obj: any, callback: (hasAttributes: boolean) => void): void {
        if (typeof obj === 'object' && obj !== null) {
            if (Array.isArray(obj)) {
                obj.forEach(item => this.countElementsRecursive(item, callback));
            } else {
                const hasAttributes = obj.$ !== undefined;
                callback(hasAttributes);

                Object.keys(obj).forEach(key => {
                    if (key !== '$' && key !== '_') {
                        this.countElementsRecursive(obj[key], callback);
                    }
                });
            }
        }
    }

    /**
     * Normalize whitespace in XML
     */
    private normalizeWhitespace(xml: string): string {
        return xml
            .replace(/>\s+</g, '><')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Remove XML comments
     */
    private removeComments(xml: string): string {
        return xml.replace(/<!--[\s\S]*?-->/g, '');
    }

    /**
     * Validate XML element exists
     */
    public async elementExists(xmlString: string, elementName: string): Promise<boolean> {
        const element = await this.xmlParser.getElementByTagName(xmlString, elementName);
        return element !== null;
    }

    /**
     * Validate XML element has expected value
     */
    public async elementHasValue(
        xmlString: string,
        elementName: string,
        expectedValue: any
    ): Promise<boolean> {
        const elementText = await this.xmlParser.getElementText(xmlString, elementName);
        return elementText === String(expectedValue);
    }

    /**
     * Validate XML element has attribute
     */
    public async elementHasAttribute(
        xmlString: string,
        elementName: string,
        attributeName: string,
        expectedValue?: any
    ): Promise<boolean> {
        const attributes = await this.xmlParser.getElementAttributes(xmlString, elementName);

        if (!attributes || !attributes[attributeName]) {
            return false;
        }

        if (expectedValue !== undefined) {
            return attributes[attributeName] === String(expectedValue);
        }

        return true;
    }

    /**
     * Count occurrences of element
     */
    public async countElements(xmlString: string, elementName: string): Promise<number> {
        const elements = await this.xmlParser.getElementsByTagName(xmlString, elementName);
        return elements.length;
    }

    /**
     * Validate element count
     */
    public async validateElementCount(
        xmlString: string,
        elementName: string,
        expectedCount: number
    ): Promise<boolean> {
        const count = await this.countElements(xmlString, elementName);
        if (count !== expectedCount) {
            throw new Error(
                `Element count validation failed: Expected ${expectedCount} occurrences of "${elementName}", found ${count}`
            );
        }
        return true;
    }

    /**
     * Validate XML contains text
     */
    public containsText(xmlString: string, text: string, caseSensitive: boolean = true): boolean {
        if (caseSensitive) {
            return xmlString.includes(text);
        }
        return xmlString.toLowerCase().includes(text.toLowerCase());
    }

    /**
     * Validate XML matches pattern
     */
    public matchesPattern(xmlString: string, pattern: RegExp): boolean {
        return pattern.test(xmlString);
    }

    /**
     * Generate validation report
     */
    public async generateValidationReport(xmlString: string): Promise<{
        wellFormed: boolean;
        elementCount: number;
        uniqueElements: string[];
        hasNamespaces: boolean;
        hasCDATA: boolean;
        size: number;
    }> {
        const validationResult = await this.validateXml(xmlString);
        const elementNames = await this.xmlParser.getElementNames(xmlString);

        return {
            wellFormed: validationResult.valid,
            elementCount: elementNames.length,
            uniqueElements: elementNames,
            hasNamespaces: xmlString.includes('xmlns'),
            hasCDATA: xmlString.includes('<![CDATA['),
            size: xmlString.length
        };
    }

    /**
     * Set comparison options
     */
    public setComparisonOptions(options: XmlComparisonOptions): void {
        this.comparisonOptions = { ...this.comparisonOptions, ...options };
    }

    /**
     * Get current comparison options
     */
    public getComparisonOptions(): XmlComparisonOptions {
        return { ...this.comparisonOptions };
    }
}
