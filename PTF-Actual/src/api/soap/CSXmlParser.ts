import * as xml2js from 'xml2js';
import { CSReporter } from '../../reporter/CSReporter';

/**
 * XML Parser and Validator Utility
 * Provides comprehensive XML parsing, validation, and XPath query capabilities
 */

export interface XmlParseOptions {
    explicitArray?: boolean;
    ignoreAttrs?: boolean;
    mergeAttrs?: boolean;
    explicitRoot?: boolean;
    normalize?: boolean;
    normalizeTags?: boolean;
    trim?: boolean;
    preserveChildrenOrder?: boolean;
    emptyTag?: any;
}

export interface XmlBuildOptions {
    rootName?: string;
    renderOpts?: {
        pretty?: boolean;
        indent?: string;
        newline?: string;
    };
    xmldec?: {
        version?: string;
        encoding?: string;
        standalone?: boolean;
    };
    headless?: boolean;
    allowSurrogateChars?: boolean;
    cdata?: boolean;
}

export interface XPathQueryResult {
    found: boolean;
    value?: any;
    path: string;
    type?: string;
}

export interface XmlValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export class CSXmlParser {
    private parser: xml2js.Parser;
    private builder: xml2js.Builder;
    private parseOptions: XmlParseOptions;
    private buildOptions: XmlBuildOptions;

    constructor(parseOptions?: XmlParseOptions, buildOptions?: XmlBuildOptions) {
        this.parseOptions = {
            explicitArray: false,
            ignoreAttrs: false,
            mergeAttrs: false,
            explicitRoot: true,
            normalize: false,
            normalizeTags: false,
            trim: true,
            preserveChildrenOrder: false,
            emptyTag: null,
            ...parseOptions
        };

        this.buildOptions = {
            rootName: 'root',
            renderOpts: {
                pretty: true,
                indent: '  ',
                newline: '\n'
            },
            xmldec: {
                version: '1.0',
                encoding: 'UTF-8',
                standalone: true
            },
            headless: false,
            allowSurrogateChars: false,
            cdata: false,
            ...buildOptions
        };

        this.parser = new xml2js.Parser(this.parseOptions);
        // Type assertion needed due to xml2js type definitions
        this.builder = new xml2js.Builder(this.buildOptions as any);
    }

    /**
     * Parse XML string to JavaScript object
     */
    public async parseXml(xmlString: string): Promise<any> {
        try {
            const result = await this.parser.parseStringPromise(xmlString);
            CSReporter.debug('XML parsed successfully');
            return result;
        } catch (error) {
            const message = `Failed to parse XML: ${(error as Error).message}`;
            CSReporter.error(message);
            throw new Error(message);
        }
    }

    /**
     * Build XML string from JavaScript object
     */
    public buildXml(obj: any): string {
        try {
            const xml = this.builder.buildObject(obj);
            CSReporter.debug('XML built successfully');
            return xml;
        } catch (error) {
            const message = `Failed to build XML: ${(error as Error).message}`;
            CSReporter.error(message);
            throw new Error(message);
        }
    }

    /**
     * Convert XML string to JSON
     */
    public async xmlToJson(xmlString: string): Promise<string> {
        const obj = await this.parseXml(xmlString);
        return JSON.stringify(obj, null, 2);
    }

    /**
     * Convert JSON string to XML
     */
    public jsonToXml(jsonString: string): string {
        const obj = JSON.parse(jsonString);
        return this.buildXml(obj);
    }

    /**
     * Validate XML well-formedness
     */
    public async validateXml(xmlString: string): Promise<XmlValidationResult> {
        const errors: string[] = [];
        const warnings: string[] = [];

        try {
            // Basic well-formedness check
            await this.parseXml(xmlString);

            // Additional validation checks
            if (!xmlString.trim().startsWith('<')) {
                errors.push('XML must start with an opening tag');
            }

            if (!xmlString.includes('<?xml')) {
                warnings.push('XML declaration is missing');
            }

            // Check for unmatched tags
            const openTags = xmlString.match(/<([a-zA-Z0-9_:-]+)[^>]*>/g) || [];
            const closeTags = xmlString.match(/<\/([a-zA-Z0-9_:-]+)>/g) || [];

            if (openTags.length !== closeTags.length) {
                errors.push('Mismatched opening and closing tags');
            }

            return {
                valid: errors.length === 0,
                errors,
                warnings
            };
        } catch (error) {
            errors.push((error as Error).message);
            return {
                valid: false,
                errors,
                warnings
            };
        }
    }

    /**
     * Query XML using simple XPath-like syntax
     * Supports: element, element.child, element.child[0], element[@attr]
     */
    public async queryXPath(xmlString: string, xpath: string): Promise<XPathQueryResult> {
        try {
            const obj = await this.parseXml(xmlString);
            const result = this.traversePath(obj, xpath);

            return {
                found: result !== undefined,
                value: result,
                path: xpath,
                type: typeof result
            };
        } catch (error) {
            return {
                found: false,
                path: xpath
            };
        }
    }

    /**
     * Traverse object using path notation
     */
    private traversePath(obj: any, path: string): any {
        const segments = path.split(/[\.\[]/);
        let current = obj;

        for (let segment of segments) {
            segment = segment.replace(/\]/g, '').trim();

            if (!segment) continue;

            // Handle array index
            if (/^\d+$/.test(segment)) {
                const index = parseInt(segment, 10);
                if (Array.isArray(current)) {
                    current = current[index];
                } else {
                    return undefined;
                }
            }
            // Handle attribute query [@attr]
            else if (segment.startsWith('@')) {
                const attrName = segment.substring(1);
                if (current && current.$ && current.$[attrName]) {
                    current = current.$[attrName];
                } else {
                    return undefined;
                }
            }
            // Handle element
            else {
                if (current && current[segment] !== undefined) {
                    current = current[segment];
                } else {
                    return undefined;
                }
            }
        }

        return current;
    }

    /**
     * Get all element names from XML
     */
    public async getElementNames(xmlString: string): Promise<string[]> {
        const obj = await this.parseXml(xmlString);
        return this.extractElementNames(obj);
    }

    private extractElementNames(obj: any, names: Set<string> = new Set()): string[] {
        if (typeof obj === 'object' && obj !== null) {
            Object.keys(obj).forEach(key => {
                if (key !== '$' && key !== '_') {
                    names.add(key);
                    if (obj[key]) {
                        this.extractElementNames(obj[key], names);
                    }
                }
            });
        } else if (Array.isArray(obj)) {
            obj.forEach(item => this.extractElementNames(item, names));
        }
        return Array.from(names);
    }

    /**
     * Get XML element by tag name
     */
    public async getElementByTagName(xmlString: string, tagName: string): Promise<any> {
        const obj = await this.parseXml(xmlString);
        return this.findElement(obj, tagName);
    }

    private findElement(obj: any, tagName: string): any {
        if (typeof obj === 'object' && obj !== null) {
            if (obj[tagName]) {
                return obj[tagName];
            }
            for (const key in obj) {
                if (key !== '$' && key !== '_') {
                    const result = this.findElement(obj[key], tagName);
                    if (result) return result;
                }
            }
        } else if (Array.isArray(obj)) {
            for (const item of obj) {
                const result = this.findElement(item, tagName);
                if (result) return result;
            }
        }
        return null;
    }

    /**
     * Get all elements by tag name
     */
    public async getElementsByTagName(xmlString: string, tagName: string): Promise<any[]> {
        const obj = await this.parseXml(xmlString);
        const results: any[] = [];
        this.findAllElements(obj, tagName, results);
        return results;
    }

    private findAllElements(obj: any, tagName: string, results: any[]): void {
        if (typeof obj === 'object' && obj !== null) {
            if (obj[tagName]) {
                if (Array.isArray(obj[tagName])) {
                    results.push(...obj[tagName]);
                } else {
                    results.push(obj[tagName]);
                }
            }
            for (const key in obj) {
                if (key !== '$' && key !== '_') {
                    this.findAllElements(obj[key], tagName, results);
                }
            }
        } else if (Array.isArray(obj)) {
            obj.forEach(item => this.findAllElements(item, tagName, results));
        }
    }

    /**
     * Get element attributes
     */
    public async getElementAttributes(xmlString: string, tagName: string): Promise<Record<string, string> | null> {
        const element = await this.getElementByTagName(xmlString, tagName);
        if (element && element.$) {
            return element.$;
        }
        return null;
    }

    /**
     * Get element text content
     */
    public async getElementText(xmlString: string, tagName: string): Promise<string | null> {
        const element = await this.getElementByTagName(xmlString, tagName);
        if (element) {
            if (typeof element === 'string') {
                return element;
            }
            if (element._) {
                return element._;
            }
            if (typeof element === 'object' && !element.$) {
                return JSON.stringify(element);
            }
        }
        return null;
    }

    /**
     * Remove XML namespaces for easier processing
     */
    public removeNamespaces(xmlString: string): string {
        // Remove namespace declarations
        let cleaned = xmlString.replace(/xmlns[^=]*="[^"]*"/g, '');

        // Remove namespace prefixes from tags
        cleaned = cleaned.replace(/<\/?([a-zA-Z0-9_-]+:)/g, (match, prefix) => {
            return match.replace(prefix, '');
        });

        return cleaned;
    }

    /**
     * Pretty print XML
     */
    public async prettyPrint(xmlString: string): Promise<string> {
        const obj = await this.parseXml(xmlString);
        return this.buildXml(obj);
    }

    /**
     * Minify XML (remove whitespace)
     */
    public minify(xmlString: string): string {
        return xmlString
            .replace(/>\s+</g, '><')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Compare two XML documents
     */
    public async compareXml(xml1: string, xml2: string, ignoreOrder: boolean = false): Promise<{
        equal: boolean;
        differences: string[];
    }> {
        try {
            const obj1 = await this.parseXml(xml1);
            const obj2 = await this.parseXml(xml2);

            const differences: string[] = [];
            this.compareObjects(obj1, obj2, '', differences, ignoreOrder);

            return {
                equal: differences.length === 0,
                differences
            };
        } catch (error) {
            return {
                equal: false,
                differences: [`Parse error: ${(error as Error).message}`]
            };
        }
    }

    private compareObjects(
        obj1: any,
        obj2: any,
        path: string,
        differences: string[],
        ignoreOrder: boolean
    ): void {
        if (typeof obj1 !== typeof obj2) {
            differences.push(`${path}: Type mismatch (${typeof obj1} vs ${typeof obj2})`);
            return;
        }

        if (Array.isArray(obj1) && Array.isArray(obj2)) {
            if (!ignoreOrder && obj1.length !== obj2.length) {
                differences.push(`${path}: Array length mismatch (${obj1.length} vs ${obj2.length})`);
            }
            const length = Math.min(obj1.length, obj2.length);
            for (let i = 0; i < length; i++) {
                this.compareObjects(obj1[i], obj2[i], `${path}[${i}]`, differences, ignoreOrder);
            }
        } else if (typeof obj1 === 'object' && obj1 !== null) {
            const keys1 = Object.keys(obj1);
            const keys2 = Object.keys(obj2);

            const allKeys = new Set([...keys1, ...keys2]);
            for (const key of allKeys) {
                if (!(key in obj1)) {
                    differences.push(`${path}.${key}: Missing in first XML`);
                } else if (!(key in obj2)) {
                    differences.push(`${path}.${key}: Missing in second XML`);
                } else {
                    this.compareObjects(
                        obj1[key],
                        obj2[key],
                        path ? `${path}.${key}` : key,
                        differences,
                        ignoreOrder
                    );
                }
            }
        } else if (obj1 !== obj2) {
            differences.push(`${path}: Value mismatch (${obj1} vs ${obj2})`);
        }
    }

    /**
     * Extract SOAP body from SOAP envelope
     */
    public async extractSoapBody(soapEnvelope: string): Promise<any> {
        const obj = await this.parseXml(soapEnvelope);

        // Try different SOAP namespace variations
        const possiblePaths = [
            'soap:Envelope.soap:Body',
            'soapenv:Envelope.soapenv:Body',
            'Envelope.Body',
            's:Envelope.s:Body',
            'env:Envelope.env:Body'
        ];

        for (const path of possiblePaths) {
            const result = this.traversePath(obj, path);
            if (result) return result;
        }

        throw new Error('Could not find SOAP Body in envelope');
    }

    /**
     * Extract SOAP header from SOAP envelope
     */
    public async extractSoapHeader(soapEnvelope: string): Promise<any> {
        const obj = await this.parseXml(soapEnvelope);

        const possiblePaths = [
            'soap:Envelope.soap:Header',
            'soapenv:Envelope.soapenv:Header',
            'Envelope.Header',
            's:Envelope.s:Header',
            'env:Envelope.env:Header'
        ];

        for (const path of possiblePaths) {
            const result = this.traversePath(obj, path);
            if (result) return result;
        }

        return null; // Header is optional
    }

    /**
     * Extract SOAP fault
     */
    public async extractSoapFault(soapEnvelope: string): Promise<any> {
        const body = await this.extractSoapBody(soapEnvelope);

        if (body && body['soap:Fault']) return body['soap:Fault'];
        if (body && body['soapenv:Fault']) return body['soapenv:Fault'];
        if (body && body.Fault) return body.Fault;

        return null;
    }

    /**
     * Check if SOAP response contains fault
     */
    public async isSoapFault(soapEnvelope: string): Promise<boolean> {
        const fault = await this.extractSoapFault(soapEnvelope);
        return fault !== null;
    }
}
