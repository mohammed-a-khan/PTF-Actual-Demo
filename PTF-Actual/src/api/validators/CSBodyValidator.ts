import { CSResponse, CSValidationResult, CSValidationError } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSBodyValidationConfig {
    equals?: any;
    contains?: string | string[];
    notContains?: string | string[];
    pattern?: string | RegExp;
    length?: { min?: number; max?: number; exact?: number };
    isEmpty?: boolean;
    isNotEmpty?: boolean;
    isJson?: boolean;
    isXml?: boolean;
    isHtml?: boolean;
    contentType?: string | RegExp;
    encoding?: string;
    size?: { min?: number; max?: number; exact?: number };
    custom?: (body: any) => boolean | string;
    transform?: (body: any) => any;
}

export class CSBodyValidator {
    public validate(response: CSResponse, config: CSBodyValidationConfig): CSValidationResult {
        const errors: CSValidationError[] = [];
        const warnings: string[] = [];
        const startTime = Date.now();

        CSReporter.debug(`Validating response body`);

        let body = response.body;

        // Apply transformation if provided
        if (config.transform) {
            try {
                body = config.transform(body);
            } catch (error) {
                errors.push({
                    path: 'body',
                    expected: 'transformation to succeed',
                    actual: 'transformation failed',
                    message: `Body transformation failed: ${(error as Error).message}`,
                    type: 'body'
                });
                return {
                    valid: false,
                    errors,
                    duration: Date.now() - startTime
                };
            }
        }

        const bodyString = this.getBodyAsString(body);
        const bodySize = Buffer.byteLength(bodyString);

        // Equals validation
        if (config.equals !== undefined) {
            const expectedString = this.getBodyAsString(config.equals);
            if (bodyString !== expectedString) {
                // Try JSON comparison if both are JSON-like
                let jsonMatch = false;
                try {
                    const actualJson = JSON.parse(bodyString);
                    const expectedJson = JSON.parse(expectedString);
                    jsonMatch = JSON.stringify(actualJson) === JSON.stringify(expectedJson);
                } catch {
                    // Not JSON, use string comparison
                }

                if (!jsonMatch) {
                    errors.push({
                        path: 'body',
                        expected: config.equals,
                        actual: body,
                        message: 'Body does not match expected value',
                        type: 'body'
                    });
                }
            }
        }

        // Contains validation
        if (config.contains) {
            const searchTerms = Array.isArray(config.contains) ? config.contains : [config.contains];
            for (const term of searchTerms) {
                if (!bodyString.includes(term)) {
                    errors.push({
                        path: 'body',
                        expected: `contain '${term}'`,
                        actual: 'not found',
                        message: `Expected body to contain '${term}'`,
                        type: 'body'
                    });
                }
            }
        }

        // Not contains validation
        if (config.notContains) {
            const searchTerms = Array.isArray(config.notContains) ? config.notContains : [config.notContains];
            for (const term of searchTerms) {
                if (bodyString.includes(term)) {
                    errors.push({
                        path: 'body',
                        expected: `not contain '${term}'`,
                        actual: 'found',
                        message: `Expected body not to contain '${term}'`,
                        type: 'body'
                    });
                }
            }
        }

        // Pattern validation
        if (config.pattern) {
            const regex = typeof config.pattern === 'string'
                ? new RegExp(config.pattern)
                : config.pattern;

            if (!regex.test(bodyString)) {
                errors.push({
                    path: 'body',
                    expected: `match pattern ${regex}`,
                    actual: 'no match',
                    message: `Expected body to match pattern ${regex}`,
                    type: 'body'
                });
            }
        }

        // Length validation
        if (config.length) {
            const length = bodyString.length;

            if (config.length.exact !== undefined && length !== config.length.exact) {
                errors.push({
                    path: 'body.length',
                    expected: config.length.exact,
                    actual: length,
                    message: `Expected body length to be ${config.length.exact}, but got ${length}`,
                    type: 'body'
                });
            }

            if (config.length.min !== undefined && length < config.length.min) {
                errors.push({
                    path: 'body.length',
                    expected: `>= ${config.length.min}`,
                    actual: length,
                    message: `Expected body length to be at least ${config.length.min}, but got ${length}`,
                    type: 'body'
                });
            }

            if (config.length.max !== undefined && length > config.length.max) {
                errors.push({
                    path: 'body.length',
                    expected: `<= ${config.length.max}`,
                    actual: length,
                    message: `Expected body length to be at most ${config.length.max}, but got ${length}`,
                    type: 'body'
                });
            }
        }

        // Size validation (in bytes)
        if (config.size) {
            if (config.size.exact !== undefined && bodySize !== config.size.exact) {
                errors.push({
                    path: 'body.size',
                    expected: `${config.size.exact} bytes`,
                    actual: `${bodySize} bytes`,
                    message: `Expected body size to be ${config.size.exact} bytes, but got ${bodySize} bytes`,
                    type: 'body'
                });
            }

            if (config.size.min !== undefined && bodySize < config.size.min) {
                errors.push({
                    path: 'body.size',
                    expected: `>= ${config.size.min} bytes`,
                    actual: `${bodySize} bytes`,
                    message: `Expected body size to be at least ${config.size.min} bytes, but got ${bodySize} bytes`,
                    type: 'body'
                });
            }

            if (config.size.max !== undefined && bodySize > config.size.max) {
                errors.push({
                    path: 'body.size',
                    expected: `<= ${config.size.max} bytes`,
                    actual: `${bodySize} bytes`,
                    message: `Expected body size to be at most ${config.size.max} bytes, but got ${bodySize} bytes`,
                    type: 'body'
                });
            }
        }

        // Empty validation
        if (config.isEmpty === true && bodyString.trim() !== '') {
            errors.push({
                path: 'body',
                expected: 'empty',
                actual: 'not empty',
                message: 'Expected body to be empty',
                type: 'body'
            });
        }

        // Not empty validation
        if (config.isNotEmpty === true && bodyString.trim() === '') {
            errors.push({
                path: 'body',
                expected: 'not empty',
                actual: 'empty',
                message: 'Expected body not to be empty',
                type: 'body'
            });
        }

        // JSON validation
        if (config.isJson === true) {
            try {
                JSON.parse(bodyString);
            } catch {
                errors.push({
                    path: 'body',
                    expected: 'valid JSON',
                    actual: 'invalid JSON',
                    message: 'Expected body to be valid JSON',
                    type: 'body'
                });
            }
        }

        // XML validation
        if (config.isXml === true) {
            if (!this.isValidXml(bodyString)) {
                errors.push({
                    path: 'body',
                    expected: 'valid XML',
                    actual: 'invalid XML',
                    message: 'Expected body to be valid XML',
                    type: 'body'
                });
            }
        }

        // HTML validation
        if (config.isHtml === true) {
            if (!this.isValidHtml(bodyString)) {
                errors.push({
                    path: 'body',
                    expected: 'valid HTML',
                    actual: 'invalid HTML',
                    message: 'Expected body to be valid HTML',
                    type: 'body'
                });
            }
        }

        // Content type validation
        if (config.contentType) {
            const contentType = response.headers['content-type'] as string;
            const matches = config.contentType instanceof RegExp
                ? config.contentType.test(contentType)
                : contentType?.includes(config.contentType);

            if (!matches) {
                errors.push({
                    path: 'body',
                    expected: `content-type ${config.contentType}`,
                    actual: contentType || 'no content-type',
                    message: `Expected content-type to match ${config.contentType}`,
                    type: 'body'
                });
            }
        }

        // Custom validation
        if (config.custom) {
            const result = config.custom(body);
            if (result !== true) {
                errors.push({
                    path: 'body',
                    expected: 'custom validation to pass',
                    actual: 'failed',
                    message: typeof result === 'string' ? result : 'Custom body validation failed',
                    type: 'body'
                });
            }
        }

        // Add warnings for large bodies
        if (bodySize > 1024 * 1024) { // 1MB
            warnings.push(`Large response body: ${(bodySize / (1024 * 1024)).toFixed(2)} MB`);
        }

        const duration = Date.now() - startTime;

        return {
            valid: errors.length === 0,
            errors,
            warnings: warnings.length > 0 ? warnings : undefined,
            duration,
            metadata: {
                bodySize,
                bodyLength: bodyString.length,
                contentType: response.headers['content-type'] as string,
                isJson: this.isJson(bodyString),
                isXml: this.isValidXml(bodyString),
                isHtml: this.isValidHtml(bodyString)
            }
        };
    }

    private getBodyAsString(body: any): string {
        if (typeof body === 'string') {
            return body;
        }

        if (Buffer.isBuffer(body)) {
            return body.toString();
        }

        if (typeof body === 'object') {
            try {
                return JSON.stringify(body);
            } catch {
                return String(body);
            }
        }

        return String(body);
    }

    private isJson(str: string): boolean {
        try {
            JSON.parse(str);
            return true;
        } catch {
            return false;
        }
    }

    private isValidXml(str: string): boolean {
        // Basic XML validation - check for well-formed structure
        const xmlPattern = /^<\?xml[^>]*\?>|^<[^>]+>/;
        const hasXmlDeclaration = str.trim().startsWith('<?xml');
        const hasRootElement = xmlPattern.test(str.trim());

        // Check for balanced tags
        const openTags = str.match(/<[^\/][^>]*>/g) || [];
        const closeTags = str.match(/<\/[^>]+>/g) || [];

        return (hasXmlDeclaration || hasRootElement) && openTags.length >= closeTags.length;
    }

    private isValidHtml(str: string): boolean {
        // Basic HTML validation
        const htmlPattern = /<!DOCTYPE html>|<html[^>]*>|<head[^>]*>|<body[^>]*>/i;
        return htmlPattern.test(str);
    }

    public expectEquals(value: any): CSBodyValidationConfig {
        return { equals: value };
    }

    public expectContains(value: string | string[]): CSBodyValidationConfig {
        return { contains: value };
    }

    public expectNotContains(value: string | string[]): CSBodyValidationConfig {
        return { notContains: value };
    }

    public expectPattern(pattern: string | RegExp): CSBodyValidationConfig {
        return { pattern };
    }

    public expectEmpty(): CSBodyValidationConfig {
        return { isEmpty: true };
    }

    public expectNotEmpty(): CSBodyValidationConfig {
        return { isNotEmpty: true };
    }

    public expectJson(): CSBodyValidationConfig {
        return { isJson: true };
    }

    public expectXml(): CSBodyValidationConfig {
        return { isXml: true };
    }

    public expectHtml(): CSBodyValidationConfig {
        return { isHtml: true };
    }

    public expectLength(config: { min?: number; max?: number; exact?: number }): CSBodyValidationConfig {
        return { length: config };
    }

    public expectSize(config: { min?: number; max?: number; exact?: number }): CSBodyValidationConfig {
        return { size: config };
    }
}

export const bodyValidator = new CSBodyValidator();