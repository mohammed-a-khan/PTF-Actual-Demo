/**
 * Tiny zero-dependency JSON-schema validator covering the subset we use:
 * type, required, properties, items, enum, minLength, minItems, pattern,
 * additionalProperties, oneOf, anyOf.
 *
 * Returns a flat list of error messages (empty list = valid). We do NOT
 * pull in `ajv` because the framework is zero-dep by policy and the
 * delegation schemas are simple by design.
 *
 * @module agent-platform/CSSchemaValidator
 */

import type { JsonSchema } from './CSDelegationSchemas';

export interface ValidationError {
    path: string;
    message: string;
}

export class CSSchemaValidator {
    static validate(data: unknown, schema: JsonSchema): ValidationError[] {
        const errors: ValidationError[] = [];
        CSSchemaValidator.walk(data, schema, '$', errors);
        return errors;
    }

    private static walk(
        data: unknown,
        schema: JsonSchema,
        path: string,
        errors: ValidationError[],
    ): void {
        // Type check
        if (schema.type !== undefined) {
            const types = Array.isArray(schema.type) ? schema.type : [schema.type];
            if (!CSSchemaValidator.matchesAnyType(data, types)) {
                errors.push({
                    path,
                    message: `expected type ${types.join('|')} but got ${CSSchemaValidator.typeOf(data)}`,
                });
                return; // can't keep walking a type mismatch
            }
        }

        // Enum check
        if (schema.enum !== undefined) {
            if (!schema.enum.includes(data as never)) {
                errors.push({
                    path,
                    message: `value ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`,
                });
            }
        }

        // String constraints
        if (typeof data === 'string') {
            if (schema.minLength !== undefined && data.length < schema.minLength) {
                errors.push({
                    path,
                    message: `string length ${data.length} below minLength ${schema.minLength}`,
                });
            }
            if (schema.pattern !== undefined) {
                const re = new RegExp(schema.pattern);
                if (!re.test(data)) {
                    errors.push({
                        path,
                        message: `string does not match pattern ${schema.pattern}`,
                    });
                }
            }
        }

        // Array constraints
        if (Array.isArray(data)) {
            if (schema.minItems !== undefined && data.length < schema.minItems) {
                errors.push({
                    path,
                    message: `array length ${data.length} below minItems ${schema.minItems}`,
                });
            }
            if (schema.items !== undefined) {
                const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
                if (itemSchema) {
                    data.forEach((item, i) =>
                        CSSchemaValidator.walk(item, itemSchema, `${path}[${i}]`, errors),
                    );
                }
            }
        }

        // Object constraints
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            const obj = data as Record<string, unknown>;
            // Required
            if (schema.required) {
                for (const req of schema.required) {
                    if (!(req in obj)) {
                        errors.push({
                            path: `${path}.${req}`,
                            message: `required property missing`,
                        });
                    }
                }
            }
            // Properties
            if (schema.properties) {
                for (const [key, propSchema] of Object.entries(schema.properties)) {
                    if (key in obj) {
                        CSSchemaValidator.walk(obj[key], propSchema, `${path}.${key}`, errors);
                    }
                }
            }
            // additionalProperties: false means any extra key is an error
            if (schema.additionalProperties === false && schema.properties) {
                const known = new Set(Object.keys(schema.properties));
                for (const key of Object.keys(obj)) {
                    if (!known.has(key)) {
                        errors.push({
                            path: `${path}.${key}`,
                            message: `additional property not allowed`,
                        });
                    }
                }
            }
        }

        // oneOf / anyOf — at least one must validate
        if (schema.oneOf) {
            const results = schema.oneOf.map((s) => CSSchemaValidator.validate(data, s));
            const valid = results.filter((r) => r.length === 0);
            if (valid.length !== 1) {
                errors.push({
                    path,
                    message: `oneOf: expected exactly 1 schema to match, got ${valid.length}`,
                });
            }
        }
        if (schema.anyOf) {
            const results = schema.anyOf.map((s) => CSSchemaValidator.validate(data, s));
            if (!results.some((r) => r.length === 0)) {
                errors.push({
                    path,
                    message: `anyOf: no schema matched`,
                });
            }
        }
    }

    private static matchesAnyType(data: unknown, types: string[]): boolean {
        return types.some((t) => CSSchemaValidator.matchesType(data, t));
    }

    private static matchesType(data: unknown, t: string): boolean {
        switch (t) {
            case 'string':
                return typeof data === 'string';
            case 'number':
                return typeof data === 'number' && !Number.isNaN(data);
            case 'integer':
                return typeof data === 'number' && Number.isInteger(data);
            case 'boolean':
                return typeof data === 'boolean';
            case 'array':
                return Array.isArray(data);
            case 'object':
                return typeof data === 'object' && data !== null && !Array.isArray(data);
            case 'null':
                return data === null;
            default:
                return true;
        }
    }

    private static typeOf(data: unknown): string {
        if (data === null) return 'null';
        if (Array.isArray(data)) return 'array';
        if (Number.isNaN(data as number)) return 'NaN';
        return typeof data;
    }
}
