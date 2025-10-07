import { CSResponse, CSValidationConfig, CSValidationResult, CSValidationError } from './types/CSApiTypes';
import { CSReporter } from '../reporter/CSReporter';
import { CSStatusCodeValidator } from './validators/CSStatusCodeValidator';
import { CSHeaderValidator } from './validators/CSHeaderValidator';
import { CSBodyValidator } from './validators/CSBodyValidator';
import { CSSchemaValidator } from './validators/CSSchemaValidator';
import { CSJSONPathValidator } from './validators/CSJSONPathValidator';
import { CSXMLValidator } from './validators/CSXMLValidator';

export class CSAPIValidator {
    private validationResults: Map<string, CSValidationResult[]>;
    private statusValidator: CSStatusCodeValidator;
    private headerValidator: CSHeaderValidator;
    private bodyValidator: CSBodyValidator;
    private schemaValidator: CSSchemaValidator;
    private jsonPathValidator: CSJSONPathValidator;
    private xmlValidator: CSXMLValidator;

    constructor() {
        this.validationResults = new Map();
        this.statusValidator = new CSStatusCodeValidator();
        this.headerValidator = new CSHeaderValidator();
        this.bodyValidator = new CSBodyValidator();
        this.schemaValidator = new CSSchemaValidator();
        this.jsonPathValidator = new CSJSONPathValidator();
        this.xmlValidator = new CSXMLValidator();
    }

    public async validate(response: CSResponse, validations: CSValidationConfig[]): Promise<CSValidationResult> {
        const errors: CSValidationError[] = [];
        const warnings: string[] = [];
        const startTime = Date.now();

        CSReporter.debug(`Validating response with ${validations.length} validation rules`);

        for (const validation of validations) {
            try {
                const result = await this.executeValidation(response, validation);

                if (!result.valid && result.errors) {
                    errors.push(...result.errors);
                }

                if (result.warnings) {
                    warnings.push(...result.warnings);
                }
            } catch (error) {
                errors.push({
                    path: validation.type,
                    expected: 'validation to succeed',
                    actual: 'validation error',
                    message: `Validation failed: ${(error as Error).message}`,
                    type: validation.type
                });
            }
        }

        const duration = Date.now() - startTime;
        const result: CSValidationResult = {
            valid: errors.length === 0,
            errors,
            warnings: warnings.length > 0 ? warnings : [],
            duration
        };

        // Store result
        const responseId = `${response.request.method}_${response.request.url}`;
        if (!this.validationResults.has(responseId)) {
            this.validationResults.set(responseId, []);
        }
        this.validationResults.get(responseId)!.push(result);

        if (!result.valid) {
            CSReporter.fail(`Response validation failed with ${errors.length} errors`);
            errors.forEach(error => {
                CSReporter.error(`  ${error.path}: ${error.message}`);
            });
        } else {
            CSReporter.pass(`Response validation successful`);
        }

        return result;
    }

    private async executeValidation(response: CSResponse, validation: CSValidationConfig): Promise<CSValidationResult> {
        switch (validation.type) {
            case 'status':
                return this.statusValidator.validate(response, validation.config);

            case 'header':
                return this.headerValidator.validate(response, validation.config);

            case 'body':
                return this.bodyValidator.validate(response, validation.config);

            case 'schema':
                return await this.schemaValidator.validate(response, validation.config);

            case 'jsonpath':
                return await this.jsonPathValidator.validate(response, validation.config);

            case 'xpath':
            case 'xml':
                return await this.xmlValidator.validate(response, validation.config);

            case 'regex':
                return this.validateRegex(response, validation.config);

            case 'custom':
                return this.validateCustom(response, validation.config);

            default:
                throw new Error(`Unknown validation type: ${validation.type}`);
        }
    }

    private validateRegex(response: CSResponse, config: any): CSValidationResult {
        const bodyString = this.getBodyAsString(response);
        const regex = new RegExp(config.pattern, config.flags);
        const matches = bodyString.match(regex);

        let valid = true;
        const errors: CSValidationError[] = [];

        if (config.matches !== undefined) {
            const hasMatches = matches !== null && matches.length > 0;
            valid = hasMatches === config.matches;

            if (!valid) {
                errors.push({
                    path: 'body',
                    expected: config.matches ? 'pattern to match' : 'pattern not to match',
                    actual: hasMatches ? 'matched' : 'no match',
                    message: `Expected pattern ${config.matches ? 'to match' : 'not to match'}: ${config.pattern}`,
                    type: 'body'
                });
            }
        }

        if (config.count !== undefined) {
            const count = matches ? matches.length : 0;
            valid = count === config.count;

            if (!valid) {
                errors.push({
                    path: 'body',
                    expected: config.count,
                    actual: count,
                    message: `Expected ${config.count} matches, found ${count}`,
                    type: 'body'
                });
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    private async validateCustom(response: CSResponse, config: any): Promise<CSValidationResult> {
        if (typeof config === 'function') {
            try {
                const result = await config(response);

                if (typeof result === 'boolean') {
                    return {
                        valid: result,
                        errors: result ? [] : [{
                            path: 'custom',
                            expected: 'validation to pass',
                            actual: 'validation failed',
                            message: 'Custom validation failed',
                            type: 'custom'
                        }]
                    };
                }

                return result;
            } catch (error) {
                return {
                    valid: false,
                    errors: [{
                        path: 'custom',
                        expected: 'validation to succeed',
                        actual: 'validation error',
                        message: `Custom validation error: ${(error as Error).message}`,
                        type: 'custom'
                    }]
                };
            }
        }

        throw new Error('Custom validation config must be a function');
    }

    private getBodyAsString(response: CSResponse): string {
        if (typeof response.body === 'string') {
            return response.body;
        }

        if (Buffer.isBuffer(response.body)) {
            return response.body.toString();
        }

        if (typeof response.body === 'object') {
            return JSON.stringify(response.body);
        }

        return String(response.body);
    }

    public getValidationHistory(responseId?: string): CSValidationResult[] {
        if (responseId) {
            return this.validationResults.get(responseId) || [];
        }

        const allResults: CSValidationResult[] = [];
        this.validationResults.forEach(results => {
            allResults.push(...results);
        });

        return allResults;
    }

    public clearValidationHistory(): void {
        this.validationResults.clear();
    }

    public getStats(): any {
        let totalValidations = 0;
        let totalPassed = 0;
        let totalFailed = 0;
        let totalErrors = 0;
        let totalWarnings = 0;

        this.validationResults.forEach(results => {
            results.forEach(result => {
                totalValidations++;
                if (result.valid) {
                    totalPassed++;
                } else {
                    totalFailed++;
                }
                totalErrors += result.errors?.length || 0;
                totalWarnings += result.warnings?.length || 0;
            });
        });

        return {
            totalValidations,
            totalPassed,
            totalFailed,
            totalErrors,
            totalWarnings,
            passRate: totalValidations > 0 ? (totalPassed / totalValidations) * 100 : 0
        };
    }
}

// Export singleton instance
export const apiValidator = new CSAPIValidator();