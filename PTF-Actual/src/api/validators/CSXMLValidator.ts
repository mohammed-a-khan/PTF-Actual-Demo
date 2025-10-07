import { CSResponse, CSValidationResult, CSValidationError } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSXMLValidationConfig {
    xpath?: string;
    value?: string;
    exists?: boolean;
    notExists?: boolean;
    contains?: string | string[];
    pattern?: string | RegExp;
    attributes?: Record<string, any>;
    namespace?: Record<string, string>;
    schema?: string; // XSD schema
    dtd?: string; // DTD validation
    wellFormed?: boolean;
    count?: { min?: number; max?: number; exact?: number };
    custom?: (xmlDoc: any) => boolean | string;
    multiple?: CSXMLValidationConfig[];
}

export class CSXMLValidator {
    private namespaces: Map<string, string> = new Map();
    private schemaCache: Map<string, string> = new Map();

    public validate(response: CSResponse, config: CSXMLValidationConfig): CSValidationResult {
        const errors: CSValidationError[] = [];
        const warnings: string[] = [];
        const startTime = Date.now();

        CSReporter.debug(`Validating XML response`);

        const xmlString = this.getXmlString(response);

        // Check if response is valid XML
        if (!this.isValidXml(xmlString)) {
            errors.push({
                path: 'body',
                expected: 'valid XML',
                actual: 'invalid XML',
                message: 'Response body is not valid XML',
                type: 'xml'
            });
            return {
                valid: false,
                errors,
                duration: Date.now() - startTime
            };
        }

        // Parse XML
        const xmlDoc = this.parseXml(xmlString);

        if (!xmlDoc) {
            errors.push({
                path: 'body',
                expected: 'parseable XML',
                actual: 'parse error',
                message: 'Failed to parse XML document',
                type: 'xml'
            });
            return {
                valid: false,
                errors,
                duration: Date.now() - startTime
            };
        }

        // Well-formed validation
        if (config.wellFormed === true) {
            const wellFormedResult = this.validateWellFormed(xmlString);
            if (!wellFormedResult.valid) {
                errors.push(...wellFormedResult.errors);
            }
        }

        // Multiple XPath validations
        if (config.multiple) {
            for (const xpathConfig of config.multiple) {
                this.validateSingleXPath(xmlDoc, xmlString, xpathConfig, errors, warnings);
            }
        } else if (config.xpath) {
            // Single XPath validation
            this.validateSingleXPath(xmlDoc, xmlString, config, errors, warnings);
        }

        // Schema validation
        if (config.schema) {
            const schemaResult = this.validateAgainstSchema(xmlString, config.schema);
            if (!schemaResult.valid) {
                errors.push(...schemaResult.errors);
            }
        }

        // DTD validation
        if (config.dtd) {
            const dtdResult = this.validateAgainstDtd(xmlString, config.dtd);
            if (!dtdResult.valid) {
                errors.push(...dtdResult.errors);
            }
        }

        // Custom validation
        if (config.custom) {
            const result = config.custom(xmlDoc);
            if (result !== true) {
                errors.push({
                    path: 'xml',
                    expected: 'custom validation to pass',
                    actual: 'failed',
                    message: typeof result === 'string' ? result : 'Custom XML validation failed',
                    type: 'xml'
                });
            }
        }

        const duration = Date.now() - startTime;

        return {
            valid: errors.length === 0,
            errors,
            warnings: warnings.length > 0 ? warnings : undefined,
            duration,
            metadata: {
                isXml: true,
                documentElement: xmlDoc ? this.getDocumentElement(xmlDoc) : undefined,
                namespaces: this.extractNamespaces(xmlString)
            }
        };
    }

    private validateSingleXPath(
        xmlDoc: any,
        xmlString: string,
        config: CSXMLValidationConfig,
        errors: CSValidationError[],
        warnings: string[]
    ): void {
        if (!config.xpath) return;

        // Register namespaces if provided
        if (config.namespace) {
            Object.entries(config.namespace).forEach(([prefix, uri]) => {
                this.namespaces.set(prefix, uri);
            });
        }

        // Execute XPath
        const nodes = this.evaluateXPath(xmlDoc, config.xpath);

        // Exists validation
        if (config.exists === true) {
            if (nodes.length === 0) {
                errors.push({
                    path: config.xpath,
                    expected: 'node to exist',
                    actual: 'not found',
                    message: `Expected node at XPath '${config.xpath}' to exist`,
                    type: 'xml'
                });
                return;
            }
        }

        // Not exists validation
        if (config.notExists === true) {
            if (nodes.length > 0) {
                errors.push({
                    path: config.xpath,
                    expected: 'node not to exist',
                    actual: `found ${nodes.length} node(s)`,
                    message: `Expected node at XPath '${config.xpath}' not to exist`,
                    type: 'xml'
                });
                return;
            }
        }

        // If no nodes found and we're not checking for non-existence, skip other validations
        if (nodes.length === 0 && config.notExists !== true) {
            if (config.value !== undefined || config.contains || config.attributes) {
                errors.push({
                    path: config.xpath,
                    expected: 'node to exist',
                    actual: 'not found',
                    message: `Cannot validate non-existent node at XPath '${config.xpath}'`,
                    type: 'xml'
                });
            }
            return;
        }

        // Value validation
        if (config.value !== undefined && nodes.length > 0) {
            const nodeValue = this.getNodeValue(nodes[0]);
            if (nodeValue !== config.value) {
                errors.push({
                    path: config.xpath,
                    expected: config.value,
                    actual: nodeValue,
                    message: `Expected node at XPath '${config.xpath}' to have value '${config.value}', but got '${nodeValue}'`,
                    type: 'xml'
                });
            }
        }

        // Contains validation
        if (config.contains && nodes.length > 0) {
            const nodeValue = this.getNodeValue(nodes[0]);
            const searchTerms = Array.isArray(config.contains) ? config.contains : [config.contains];

            for (const term of searchTerms) {
                if (!nodeValue.includes(term)) {
                    errors.push({
                        path: config.xpath,
                        expected: `contain '${term}'`,
                        actual: nodeValue,
                        message: `Expected node at XPath '${config.xpath}' to contain '${term}'`,
                        type: 'xml'
                    });
                }
            }
        }

        // Pattern validation
        if (config.pattern && nodes.length > 0) {
            const nodeValue = this.getNodeValue(nodes[0]);
            const regex = typeof config.pattern === 'string'
                ? new RegExp(config.pattern)
                : config.pattern;

            if (!regex.test(nodeValue)) {
                errors.push({
                    path: config.xpath,
                    expected: `match pattern ${regex}`,
                    actual: nodeValue,
                    message: `Expected node at XPath '${config.xpath}' to match pattern ${regex}`,
                    type: 'xml'
                });
            }
        }

        // Attributes validation
        if (config.attributes && nodes.length > 0) {
            for (const [attrName, expectedValue] of Object.entries(config.attributes)) {
                const actualValue = this.getAttributeValue(nodes[0], attrName);

                if (expectedValue === null) {
                    // Check attribute doesn't exist
                    if (actualValue !== null) {
                        errors.push({
                            path: `${config.xpath}/@${attrName}`,
                            expected: 'attribute not to exist',
                            actual: actualValue,
                            message: `Expected attribute '${attrName}' not to exist at XPath '${config.xpath}'`,
                            type: 'xml'
                        });
                    }
                } else if (actualValue !== expectedValue) {
                    errors.push({
                        path: `${config.xpath}/@${attrName}`,
                        expected: expectedValue,
                        actual: actualValue || 'undefined',
                        message: `Expected attribute '${attrName}' at XPath '${config.xpath}' to be '${expectedValue}', but got '${actualValue || 'undefined'}'`,
                        type: 'xml'
                    });
                }
            }
        }

        // Count validation
        if (config.count) {
            const count = nodes.length;

            if (config.count.exact !== undefined && count !== config.count.exact) {
                errors.push({
                    path: config.xpath,
                    expected: `${config.count.exact} node(s)`,
                    actual: `${count} node(s)`,
                    message: `Expected exactly ${config.count.exact} node(s) at XPath '${config.xpath}', but found ${count}`,
                    type: 'xml'
                });
            }

            if (config.count.min !== undefined && count < config.count.min) {
                errors.push({
                    path: config.xpath,
                    expected: `>= ${config.count.min} node(s)`,
                    actual: `${count} node(s)`,
                    message: `Expected at least ${config.count.min} node(s) at XPath '${config.xpath}', but found ${count}`,
                    type: 'xml'
                });
            }

            if (config.count.max !== undefined && count > config.count.max) {
                errors.push({
                    path: config.xpath,
                    expected: `<= ${config.count.max} node(s)`,
                    actual: `${count} node(s)`,
                    message: `Expected at most ${config.count.max} node(s) at XPath '${config.xpath}', but found ${count}`,
                    type: 'xml'
                });
            }
        }
    }

    private getXmlString(response: CSResponse): string {
        if (typeof response.body === 'string') {
            return response.body;
        }

        if (Buffer.isBuffer(response.body)) {
            return response.body.toString();
        }

        return String(response.body);
    }

    private isValidXml(xmlString: string): boolean {
        // Basic XML validation
        const trimmed = xmlString.trim();

        // Check for XML declaration or root element
        if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<')) {
            return false;
        }

        // Check for balanced tags
        const tagStack: string[] = [];
        const tagPattern = /<\/?([a-zA-Z][\w:.-]*)[^>]*>/g;
        let match;

        while ((match = tagPattern.exec(xmlString)) !== null) {
            const fullTag = match[0];
            const tagName = match[1];

            if (fullTag.startsWith('</')) {
                // Closing tag
                const lastTag = tagStack.pop();
                if (lastTag !== tagName) {
                    return false;
                }
            } else if (!fullTag.endsWith('/>')) {
                // Opening tag (not self-closing)
                tagStack.push(tagName);
            }
        }

        return tagStack.length === 0;
    }

    private parseXml(xmlString: string): any {
        // Simple XML parser for validation purposes
        // In production, you might want to use a proper XML parser library
        const doc = {
            documentElement: null,
            nodes: new Map(),
            attributes: new Map()
        };

        try {
            // Remove XML declaration
            const content = xmlString.replace(/<\?xml[^>]*\?>/i, '').trim();

            // Parse root element
            const rootMatch = content.match(/^<([^>\s]+)([^>]*)>([\s\S]*)<\/\1>$/);
            if (rootMatch) {
                const [, tagName, attrs, innerContent] = rootMatch;
                doc.documentElement = {
                    tagName,
                    attributes: this.parseAttributes(attrs),
                    textContent: this.extractTextContent(innerContent),
                    innerHTML: innerContent,
                    childNodes: this.parseChildNodes(innerContent)
                } as any;
            }

            return doc;
        } catch (error) {
            CSReporter.debug(`XML parsing error: ${(error as Error).message}`);
            return null;
        }
    }

    private parseAttributes(attrString: string): Record<string, string> {
        const attrs: Record<string, string> = {};
        const attrPattern = /(\w+)=["']([^"']*)["']/g;
        let match;

        while ((match = attrPattern.exec(attrString)) !== null) {
            attrs[match[1]] = match[2];
        }

        return attrs;
    }

    private extractTextContent(xml: string): string {
        // Remove all tags and return text content
        return xml.replace(/<[^>]*>/g, '').trim();
    }

    private parseChildNodes(xml: string): any[] {
        const nodes: any[] = [];
        const nodePattern = /<([^>\s]+)([^>]*)>([\s\S]*?)<\/\1>|<([^>\s]+)([^>]*)\/>/g;
        let match;

        while ((match = nodePattern.exec(xml)) !== null) {
            if (match[1]) {
                // Regular node
                nodes.push({
                    tagName: match[1],
                    attributes: this.parseAttributes(match[2]),
                    textContent: this.extractTextContent(match[3]),
                    innerHTML: match[3],
                    childNodes: this.parseChildNodes(match[3])
                });
            } else if (match[4]) {
                // Self-closing node
                nodes.push({
                    tagName: match[4],
                    attributes: this.parseAttributes(match[5]),
                    textContent: '',
                    innerHTML: '',
                    childNodes: []
                });
            }
        }

        return nodes;
    }

    private evaluateXPath(xmlDoc: any, xpath: string): any[] {
        const results: any[] = [];

        // Simple XPath evaluation (supports basic paths)
        // In production, you'd use a proper XPath library
        const pathParts = xpath.split('/').filter(p => p);
        let current = [xmlDoc.documentElement];

        for (const part of pathParts) {
            const next: any[] = [];

            for (const node of current) {
                if (!node) continue;

                if (part === '*') {
                    // Wildcard - select all children
                    next.push(...(node.childNodes || []));
                } else if (part.startsWith('@')) {
                    // Attribute selector
                    const attrName = part.substring(1);
                    if (node.attributes && node.attributes[attrName]) {
                        next.push({
                            nodeType: 'attribute',
                            name: attrName,
                            value: node.attributes[attrName]
                        });
                    }
                } else if (part.includes('[')) {
                    // Predicate
                    const [tagName, predicate] = part.split('[');
                    const predicateContent = predicate.replace(']', '');

                    if (node.childNodes) {
                        for (const child of node.childNodes) {
                            if (child.tagName === tagName) {
                                // Simple predicate evaluation
                                if (/^\d+$/.test(predicateContent)) {
                                    // Index predicate
                                    const index = parseInt(predicateContent) - 1;
                                    const matching = node.childNodes.filter((n: any) => n.tagName === tagName);
                                    if (matching[index]) {
                                        next.push(matching[index]);
                                    }
                                } else if (predicateContent.startsWith('@')) {
                                    // Attribute predicate
                                    const [attrName, attrValue] = predicateContent.substring(1).split('=');
                                    if (child.attributes && child.attributes[attrName] === attrValue?.replace(/['"]/g, '')) {
                                        next.push(child);
                                    }
                                } else {
                                    next.push(child);
                                }
                            }
                        }
                    }
                } else if (part === '.') {
                    // Current node
                    next.push(node);
                } else if (part === '..') {
                    // Parent node (not implemented in simple parser)
                    // Parent node selection not supported in simple XPath parser
                    CSReporter.warn('Parent node selection (..) not supported in simple XPath parser');
                } else {
                    // Element name
                    if (node.childNodes) {
                        for (const child of node.childNodes) {
                            if (child.tagName === part) {
                                next.push(child);
                            }
                        }
                    }
                }
            }

            current = next;
        }

        return current;
    }

    private getNodeValue(node: any): string {
        if (node.nodeType === 'attribute') {
            return node.value;
        }
        return node.textContent || '';
    }

    private getAttributeValue(node: any, attrName: string): string | null {
        if (node.attributes && node.attributes[attrName] !== undefined) {
            return node.attributes[attrName];
        }
        return null;
    }

    private getDocumentElement(xmlDoc: any): string | undefined {
        return xmlDoc.documentElement?.tagName;
    }

    private extractNamespaces(xmlString: string): Record<string, string> {
        const namespaces: Record<string, string> = {};
        const nsPattern = /xmlns:?(\w*)=["']([^"']+)["']/g;
        let match;

        while ((match = nsPattern.exec(xmlString)) !== null) {
            const prefix = match[1] || 'default';
            namespaces[prefix] = match[2];
        }

        return namespaces;
    }

    private validateWellFormed(xmlString: string): { valid: boolean; errors: CSValidationError[] } {
        const errors: CSValidationError[] = [];

        // Check for proper XML declaration
        if (xmlString.trim().startsWith('<?xml')) {
            const declMatch = xmlString.match(/<\?xml[^>]*\?>/);
            if (declMatch) {
                const decl = declMatch[0];
                if (!decl.includes('version=')) {
                    errors.push({
                        path: 'xml-declaration',
                        expected: 'version attribute',
                        actual: 'missing',
                        message: 'XML declaration must include version attribute',
                        type: 'xml'
                    });
                }
            }
        }

        // Check for single root element
        const rootElements = xmlString.match(/<[^?\/][^>]*>/g);
        if (rootElements) {
            const topLevelElements = rootElements.filter(tag => {
                const tagName = tag.match(/<([^\s>]+)/)?.[1];
                return tagName && !xmlString.includes(`</${tagName}>`);
            });

            if (topLevelElements.length > 1) {
                errors.push({
                    path: 'root',
                    expected: 'single root element',
                    actual: `${topLevelElements.length} root elements`,
                    message: 'XML document must have a single root element',
                    type: 'xml'
                });
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    private validateAgainstSchema(xmlString: string, schema: string): { valid: boolean; errors: CSValidationError[] } {
        // Basic schema validation
        // In production, you'd use a proper XSD validator
        const errors: CSValidationError[] = [];

        CSReporter.debug('XSD schema validation would be performed here');

        // For now, just check if schema is provided
        if (!schema) {
            errors.push({
                path: 'schema',
                expected: 'valid XSD schema',
                actual: 'empty schema',
                message: 'No XSD schema provided for validation',
                type: 'xml'
            });
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    private validateAgainstDtd(xmlString: string, dtd: string): { valid: boolean; errors: CSValidationError[] } {
        // Basic DTD validation
        // In production, you'd use a proper DTD validator
        const errors: CSValidationError[] = [];

        CSReporter.debug('DTD validation would be performed here');

        // For now, just check if DTD is provided
        if (!dtd) {
            errors.push({
                path: 'dtd',
                expected: 'valid DTD',
                actual: 'empty DTD',
                message: 'No DTD provided for validation',
                type: 'xml'
            });
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    public expectXPath(xpath: string, value?: string): CSXMLValidationConfig {
        return value === undefined ? { xpath, exists: true } : { xpath, value };
    }

    public expectXPathNotExists(xpath: string): CSXMLValidationConfig {
        return { xpath, notExists: true };
    }

    public expectAttribute(xpath: string, attributes: Record<string, any>): CSXMLValidationConfig {
        return { xpath, attributes };
    }

    public expectNodeCount(xpath: string, count: { min?: number; max?: number; exact?: number }): CSXMLValidationConfig {
        return { xpath, count };
    }

    public expectWellFormed(): CSXMLValidationConfig {
        return { wellFormed: true };
    }

    public expectSchema(schema: string): CSXMLValidationConfig {
        return { schema };
    }

    public cacheSchema(id: string, schema: string): void {
        this.schemaCache.set(id, schema);
    }

    public getCachedSchema(id: string): string | undefined {
        return this.schemaCache.get(id);
    }

    public registerNamespace(prefix: string, uri: string): void {
        this.namespaces.set(prefix, uri);
    }

    public clearNamespaces(): void {
        this.namespaces.clear();
    }
}

export const xmlValidator = new CSXMLValidator();