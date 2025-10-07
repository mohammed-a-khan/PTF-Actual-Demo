import { CSResponse, CSValidationResult } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSCustomValidationConfig {
    validator: (response: CSResponse) => boolean | Promise<boolean>;
    message?: string;
    extractValue?: (response: CSResponse) => any;
}

export class CSCustomValidator {
    public async validate(response: CSResponse, config: CSCustomValidationConfig): Promise<CSValidationResult> {
        try {
            const result = await config.validator(response);

            const validationResult: CSValidationResult = {
                valid: result
            };

            if (config.message && !result) {
                validationResult.message = config.message;
            }

            if (config.extractValue && result) {
                validationResult.extractedValue = config.extractValue(response);
            }

            return validationResult;

        } catch (error) {
            CSReporter.error(`Custom validation failed: ${(error as Error).message}`);
            return {
                valid: false,
                message: config.message || `Custom validation error: ${(error as Error).message}`
            };
        }
    }

    public createValidator(
        validatorFn: (response: CSResponse) => boolean | Promise<boolean>,
        message?: string
    ): CSCustomValidationConfig {
        return {
            validator: validatorFn,
            message
        };
    }

    public createComplexValidator(config: {
        statusCode?: number;
        headerExists?: string;
        bodyContains?: string;
        jsonPath?: string;
        customCheck?: (response: CSResponse) => boolean;
        message?: string;
    }): CSCustomValidationConfig {
        return {
            validator: async (response: CSResponse) => {
                if (config.statusCode && response.status !== config.statusCode) {
                    return false;
                }

                if (config.headerExists && !response.headers[config.headerExists]) {
                    return false;
                }

                if (config.bodyContains) {
                    const bodyText = typeof response.body === 'string'
                        ? response.body
                        : JSON.stringify(response.body);
                    if (!bodyText.includes(config.bodyContains)) {
                        return false;
                    }
                }

                if (config.jsonPath) {
                    const value = this.extractJsonPath(response.body, config.jsonPath);
                    if (value === undefined || value === null) {
                        return false;
                    }
                }

                if (config.customCheck && !config.customCheck(response)) {
                    return false;
                }

                return true;
            },
            message: config.message
        };
    }

    private extractJsonPath(data: any, path: string): any {
        if (!path.startsWith('$.')) {
            return undefined;
        }

        const parts = path.substring(2).split('.');
        let current = data;

        for (const part of parts) {
            if (current === null || current === undefined) {
                return undefined;
            }

            // Handle array indices
            const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
            if (arrayMatch) {
                current = current[arrayMatch[1]];
                if (Array.isArray(current)) {
                    current = current[parseInt(arrayMatch[2])];
                }
            } else {
                current = current[part];
            }
        }

        return current;
    }
}