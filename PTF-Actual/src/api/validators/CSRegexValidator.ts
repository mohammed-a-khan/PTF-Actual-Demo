import { CSResponse, CSValidationResult } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSRegexValidationConfig {
    pattern: string;
    flags?: string;
    field?: string;
    extractMatch?: boolean;
}

export class CSRegexValidator {
    public async validate(response: CSResponse, config: CSRegexValidationConfig): Promise<CSValidationResult> {
        try {
            const regex = new RegExp(config.pattern, config.flags || 'gim');
            let textToTest: string;

            if (config.field) {
                // Test specific field
                const fieldValue = this.getFieldValue(response, config.field);
                textToTest = String(fieldValue);
            } else {
                // Test response body
                textToTest = typeof response.body === 'string'
                    ? response.body
                    : JSON.stringify(response.body);
            }

            const match = regex.test(textToTest);

            if (config.extractMatch && match) {
                const matches = textToTest.match(regex);
                return {
                    valid: match,
                    extractedValue: matches
                };
            }

            return {
                valid: match
            };

        } catch (error) {
            CSReporter.error(`Regex validation failed: ${(error as Error).message}`);
            return {
                valid: false,
                message: `Regex validation error: ${(error as Error).message}`
            };
        }
    }

    private getFieldValue(response: CSResponse, field: string): any {
        if (field === 'status') return response.status;
        if (field === 'statusText') return response.statusText;
        if (field.startsWith('headers.')) {
            const headerName = field.substring(8);
            return response.headers[headerName];
        }

        // Navigate to field in response body
        const parts = field.split('.');
        let value = response.body;

        for (const part of parts) {
            if (value && typeof value === 'object') {
                value = value[part];
            } else {
                return undefined;
            }
        }

        return value;
    }
}