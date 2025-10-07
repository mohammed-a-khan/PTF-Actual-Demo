import { CSResponse, CSValidationResult, CSValidationError } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSSchemaValidationConfig {
    schema: any; // JSON Schema object
    version?: 'draft-04' | 'draft-06' | 'draft-07' | '2019-09' | '2020-12';
    strict?: boolean;
    coerceTypes?: boolean;
    additionalProperties?: boolean;
    removeAdditional?: boolean;
    useDefaults?: boolean;
    validateFormats?: boolean;
    custom?: (data: any, schema: any) => boolean | string;
    type?: string;
    metadata?: Record<string, any>;
}

export class CSSchemaValidator {
    private schemaCache: Map<string, any> = new Map();

    public validate(response: CSResponse, config: CSSchemaValidationConfig): CSValidationResult {
        const errors: CSValidationError[] = [];
        const warnings: string[] = [];
        const startTime = Date.now();

        CSReporter.debug(`Validating response against schema`);

        const data = response.body;

        if (!config.schema) {
            errors.push({
                path: 'schema',
                expected: 'schema definition',
                actual: 'undefined',
                message: 'No schema provided for validation',
                type: 'schema'
            });
            return {
                valid: false,
                errors,
                duration: Date.now() - startTime
            };
        }

        // Validate using simple schema validation
        const validationResult = this.validateAgainstSchema(data, config.schema, '', errors, warnings, config);

        // Custom validation
        if (config.custom && validationResult) {
            const result = config.custom(data, config.schema);
            if (result !== true) {
                errors.push({
                    path: 'schema',
                    expected: 'custom validation to pass',
                    actual: 'failed',
                    message: typeof result === 'string' ? result : 'Custom schema validation failed',
                    type: 'schema'
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
                schemaVersion: config.version || 'draft-07',
                dataType: Array.isArray(data) ? 'array' : typeof data
            }
        };
    }

    private validateAgainstSchema(
        data: any,
        schema: any,
        path: string,
        errors: CSValidationError[],
        warnings: string[],
        config: CSSchemaValidationConfig
    ): boolean {
        // Type validation
        if (schema.type) {
            if (!this.validateType(data, schema.type)) {
                errors.push({
                    path: path || 'root',
                    expected: schema.type,
                    actual: Array.isArray(data) ? 'array' : typeof data,
                    message: `Expected type '${schema.type}' at ${path || 'root'}`,
                    type: 'schema'
                });
                return false;
            }
        }

        // Required properties
        if (schema.required && typeof data === 'object' && !Array.isArray(data)) {
            for (const prop of schema.required) {
                if (!(prop in data)) {
                    errors.push({
                        path: path ? `${path}.${prop}` : prop,
                        expected: 'property to exist',
                        actual: 'undefined',
                        message: `Required property '${prop}' is missing`,
                        type: 'schema'
                    });
                }
            }
        }

        // Properties validation
        if (schema.properties && typeof data === 'object' && !Array.isArray(data)) {
            for (const [prop, propSchema] of Object.entries(schema.properties)) {
                if (prop in data) {
                    const propPath = path ? `${path}.${prop}` : prop;
                    this.validateAgainstSchema(data[prop], propSchema, propPath, errors, warnings, config);
                }
            }

            // Additional properties
            if (config.strict || schema.additionalProperties === false) {
                const definedProps = Object.keys(schema.properties || {});
                const dataProps = Object.keys(data);
                for (const prop of dataProps) {
                    if (!definedProps.includes(prop)) {
                        if (config.removeAdditional) {
                            delete data[prop];
                            warnings.push(`Removed additional property '${prop}'`);
                        } else if (schema.additionalProperties === false) {
                            errors.push({
                                path: path ? `${path}.${prop}` : prop,
                                expected: 'no additional properties',
                                actual: prop,
                                message: `Additional property '${prop}' is not allowed`,
                                type: 'schema'
                            });
                        } else {
                            warnings.push(`Additional property '${prop}' found`);
                        }
                    }
                }
            }
        }

        // Array items validation
        if (schema.items && Array.isArray(data)) {
            if (Array.isArray(schema.items)) {
                // Tuple validation
                for (let i = 0; i < schema.items.length; i++) {
                    if (i < data.length) {
                        const itemPath = `${path}[${i}]`;
                        this.validateAgainstSchema(data[i], schema.items[i], itemPath, errors, warnings, config);
                    }
                }
            } else {
                // Array validation
                for (let i = 0; i < data.length; i++) {
                    const itemPath = `${path}[${i}]`;
                    this.validateAgainstSchema(data[i], schema.items, itemPath, errors, warnings, config);
                }
            }
        }

        // String validations
        if (typeof data === 'string') {
            this.validateString(data, schema, path, errors, warnings, config);
        }

        // Number validations
        if (typeof data === 'number') {
            this.validateNumber(data, schema, path, errors, warnings);
        }

        // Array validations
        if (Array.isArray(data)) {
            this.validateArray(data, schema, path, errors, warnings);
        }

        // Object validations
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            this.validateObject(data, schema, path, errors, warnings);
        }

        // Enum validation
        if (schema.enum) {
            if (!schema.enum.includes(data)) {
                errors.push({
                    path: path || 'root',
                    expected: `one of [${schema.enum.join(', ')}]`,
                    actual: data,
                    message: `Value must be one of: ${schema.enum.join(', ')}`,
                    type: 'schema'
                });
            }
        }

        // Const validation
        if (schema.const !== undefined) {
            if (data !== schema.const) {
                errors.push({
                    path: path || 'root',
                    expected: schema.const,
                    actual: data,
                    message: `Value must be exactly: ${schema.const}`,
                    type: 'schema'
                });
            }
        }

        // AllOf validation
        if (schema.allOf) {
            for (const subSchema of schema.allOf) {
                this.validateAgainstSchema(data, subSchema, path, errors, warnings, config);
            }
        }

        // AnyOf validation
        if (schema.anyOf) {
            const tempErrors: CSValidationError[] = [];
            let valid = false;

            for (const subSchema of schema.anyOf) {
                const subErrors: CSValidationError[] = [];
                this.validateAgainstSchema(data, subSchema, path, subErrors, [], config);
                if (subErrors.length === 0) {
                    valid = true;
                    break;
                }
                tempErrors.push(...subErrors);
            }

            if (!valid) {
                errors.push({
                    path: path || 'root',
                    expected: 'match at least one schema',
                    actual: 'no match',
                    message: 'Value does not match any of the allowed schemas',
                    type: 'schema'
                });
            }
        }

        // OneOf validation
        if (schema.oneOf) {
            let matchCount = 0;

            for (const subSchema of schema.oneOf) {
                const subErrors: CSValidationError[] = [];
                this.validateAgainstSchema(data, subSchema, path, subErrors, [], config);
                if (subErrors.length === 0) {
                    matchCount++;
                }
            }

            if (matchCount !== 1) {
                errors.push({
                    path: path || 'root',
                    expected: 'match exactly one schema',
                    actual: `${matchCount} matches`,
                    message: `Value must match exactly one schema, but matched ${matchCount}`,
                    type: 'schema'
                });
            }
        }

        // Not validation
        if (schema.not) {
            const subErrors: CSValidationError[] = [];
            this.validateAgainstSchema(data, schema.not, path, subErrors, [], config);
            if (subErrors.length === 0) {
                errors.push({
                    path: path || 'root',
                    expected: 'not match schema',
                    actual: 'matches',
                    message: 'Value must not match the specified schema',
                    type: 'schema'
                });
            }
        }

        return errors.length === 0;
    }

    private validateType(data: any, type: string | string[]): boolean {
        const types = Array.isArray(type) ? type : [type];

        for (const t of types) {
            switch (t) {
                case 'null':
                    if (data === null) return true;
                    break;
                case 'boolean':
                    if (typeof data === 'boolean') return true;
                    break;
                case 'number':
                case 'integer':
                    if (typeof data === 'number' && !isNaN(data)) {
                        if (t === 'integer' && !Number.isInteger(data)) continue;
                        return true;
                    }
                    break;
                case 'string':
                    if (typeof data === 'string') return true;
                    break;
                case 'array':
                    if (Array.isArray(data)) return true;
                    break;
                case 'object':
                    if (typeof data === 'object' && data !== null && !Array.isArray(data)) return true;
                    break;
            }
        }

        return false;
    }

    private validateString(
        data: string,
        schema: any,
        path: string,
        errors: CSValidationError[],
        warnings: string[],
        config: CSSchemaValidationConfig
    ): void {
        // MinLength
        if (schema.minLength !== undefined && data.length < schema.minLength) {
            errors.push({
                path: path || 'root',
                expected: `length >= ${schema.minLength}`,
                actual: `length = ${data.length}`,
                message: `String length must be at least ${schema.minLength}`,
                type: 'schema'
            });
        }

        // MaxLength
        if (schema.maxLength !== undefined && data.length > schema.maxLength) {
            errors.push({
                path: path || 'root',
                expected: `length <= ${schema.maxLength}`,
                actual: `length = ${data.length}`,
                message: `String length must be at most ${schema.maxLength}`,
                type: 'schema'
            });
        }

        // Pattern
        if (schema.pattern) {
            const regex = new RegExp(schema.pattern);
            if (!regex.test(data)) {
                errors.push({
                    path: path || 'root',
                    expected: `match pattern ${schema.pattern}`,
                    actual: data,
                    message: `String must match pattern: ${schema.pattern}`,
                    type: 'schema'
                });
            }
        }

        // Format
        if (schema.format && config.validateFormats !== false) {
            if (!this.validateFormat(data, schema.format)) {
                warnings.push(`String at ${path || 'root'} may not be valid ${schema.format} format`);
            }
        }
    }

    private validateNumber(
        data: number,
        schema: any,
        path: string,
        errors: CSValidationError[],
        warnings: string[]
    ): void {
        // Minimum
        if (schema.minimum !== undefined) {
            if (data < schema.minimum) {
                errors.push({
                    path: path || 'root',
                    expected: `>= ${schema.minimum}`,
                    actual: data,
                    message: `Number must be at least ${schema.minimum}`,
                    type: 'schema'
                });
            }
        }

        // Maximum
        if (schema.maximum !== undefined) {
            if (data > schema.maximum) {
                errors.push({
                    path: path || 'root',
                    expected: `<= ${schema.maximum}`,
                    actual: data,
                    message: `Number must be at most ${schema.maximum}`,
                    type: 'schema'
                });
            }
        }

        // ExclusiveMinimum
        if (schema.exclusiveMinimum !== undefined) {
            if (data <= schema.exclusiveMinimum) {
                errors.push({
                    path: path || 'root',
                    expected: `> ${schema.exclusiveMinimum}`,
                    actual: data,
                    message: `Number must be greater than ${schema.exclusiveMinimum}`,
                    type: 'schema'
                });
            }
        }

        // ExclusiveMaximum
        if (schema.exclusiveMaximum !== undefined) {
            if (data >= schema.exclusiveMaximum) {
                errors.push({
                    path: path || 'root',
                    expected: `< ${schema.exclusiveMaximum}`,
                    actual: data,
                    message: `Number must be less than ${schema.exclusiveMaximum}`,
                    type: 'schema'
                });
            }
        }

        // MultipleOf
        if (schema.multipleOf) {
            if (data % schema.multipleOf !== 0) {
                errors.push({
                    path: path || 'root',
                    expected: `multiple of ${schema.multipleOf}`,
                    actual: data,
                    message: `Number must be a multiple of ${schema.multipleOf}`,
                    type: 'schema'
                });
            }
        }
    }

    private validateArray(
        data: any[],
        schema: any,
        path: string,
        errors: CSValidationError[],
        warnings: string[]
    ): void {
        // MinItems
        if (schema.minItems !== undefined && data.length < schema.minItems) {
            errors.push({
                path: path || 'root',
                expected: `length >= ${schema.minItems}`,
                actual: `length = ${data.length}`,
                message: `Array must have at least ${schema.minItems} items`,
                type: 'schema'
            });
        }

        // MaxItems
        if (schema.maxItems !== undefined && data.length > schema.maxItems) {
            errors.push({
                path: path || 'root',
                expected: `length <= ${schema.maxItems}`,
                actual: `length = ${data.length}`,
                message: `Array must have at most ${schema.maxItems} items`,
                type: 'schema'
            });
        }

        // UniqueItems
        if (schema.uniqueItems) {
            const seen = new Set();
            const duplicates = new Set();

            for (const item of data) {
                const key = JSON.stringify(item);
                if (seen.has(key)) {
                    duplicates.add(key);
                }
                seen.add(key);
            }

            if (duplicates.size > 0) {
                errors.push({
                    path: path || 'root',
                    expected: 'unique items',
                    actual: 'duplicate items found',
                    message: 'Array must contain unique items',
                    type: 'schema'
                });
            }
        }

        // Contains
        if (schema.contains) {
            let hasMatch = false;
            for (const item of data) {
                const subErrors: CSValidationError[] = [];
                this.validateAgainstSchema(item, schema.contains, '', subErrors, [], {
                    ...schema,
                    strict: false
                });
                if (subErrors.length === 0) {
                    hasMatch = true;
                    break;
                }
            }

            if (!hasMatch) {
                errors.push({
                    path: path || 'root',
                    expected: 'at least one matching item',
                    actual: 'no matching items',
                    message: 'Array must contain at least one item matching the schema',
                    type: 'schema'
                });
            }
        }
    }

    private validateObject(
        data: any,
        schema: any,
        path: string,
        errors: CSValidationError[],
        warnings: string[]
    ): void {
        const keys = Object.keys(data);

        // MinProperties
        if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
            errors.push({
                path: path || 'root',
                expected: `>= ${schema.minProperties} properties`,
                actual: `${keys.length} properties`,
                message: `Object must have at least ${schema.minProperties} properties`,
                type: 'schema'
            });
        }

        // MaxProperties
        if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
            errors.push({
                path: path || 'root',
                expected: `<= ${schema.maxProperties} properties`,
                actual: `${keys.length} properties`,
                message: `Object must have at most ${schema.maxProperties} properties`,
                type: 'schema'
            });
        }

        // Dependencies
        if (schema.dependencies) {
            for (const [prop, deps] of Object.entries(schema.dependencies)) {
                if (prop in data) {
                    if (Array.isArray(deps)) {
                        for (const dep of deps) {
                            if (!(dep in data)) {
                                errors.push({
                                    path: path ? `${path}.${dep}` : dep,
                                    expected: 'property to exist',
                                    actual: 'undefined',
                                    message: `Property '${dep}' is required when '${prop}' is present`,
                                    type: 'schema'
                                });
                            }
                        }
                    }
                }
            }
        }

        // PatternProperties
        if (schema.patternProperties) {
            for (const [pattern, propSchema] of Object.entries(schema.patternProperties)) {
                const regex = new RegExp(pattern);
                for (const key of keys) {
                    if (regex.test(key)) {
                        const propPath = path ? `${path}.${key}` : key;
                        this.validateAgainstSchema(data[key], propSchema, propPath, errors, warnings, {
                            strict: false
                        } as CSSchemaValidationConfig);
                    }
                }
            }
        }
    }

    private validateFormat(data: string, format: string): boolean {
        const formats: Record<string, RegExp> = {
            'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/,
            'date': /^\d{4}-\d{2}-\d{2}$/,
            'time': /^\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/,
            'email': /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            'hostname': /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
            'ipv4': /^(\d{1,3}\.){3}\d{1,3}$/,
            'ipv6': /^([0-9a-fA-F]{0,4}:){7}[0-9a-fA-F]{0,4}$/,
            'uri': /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]*$/,
            'uuid': /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        };

        const regex = formats[format];
        return regex ? regex.test(data) : true;
    }

    public cacheSchema(id: string, schema: any): void {
        this.schemaCache.set(id, schema);
    }

    public getCachedSchema(id: string): any | undefined {
        return this.schemaCache.get(id);
    }

    public clearCache(): void {
        this.schemaCache.clear();
    }
}

export const schemaValidator = new CSSchemaValidator();