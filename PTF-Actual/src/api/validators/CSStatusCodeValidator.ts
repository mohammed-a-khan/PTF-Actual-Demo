import { CSResponse, CSValidationResult, CSValidationError } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSStatusValidationConfig {
    expected?: number | number[];
    range?: { min: number; max: number };
    pattern?: string | RegExp;
    not?: number | number[];
    category?: 'informational' | 'success' | 'redirect' | 'client_error' | 'server_error';
    custom?: (status: number) => boolean | string;
}

export class CSStatusCodeValidator {
    private readonly statusCategories = {
        informational: { min: 100, max: 199 },
        success: { min: 200, max: 299 },
        redirect: { min: 300, max: 399 },
        client_error: { min: 400, max: 499 },
        server_error: { min: 500, max: 599 }
    };

    private readonly commonStatusCodes: Map<number, string> = new Map([
        [100, 'Continue'],
        [101, 'Switching Protocols'],
        [102, 'Processing'],
        [103, 'Early Hints'],
        [200, 'OK'],
        [201, 'Created'],
        [202, 'Accepted'],
        [203, 'Non-Authoritative Information'],
        [204, 'No Content'],
        [205, 'Reset Content'],
        [206, 'Partial Content'],
        [207, 'Multi-Status'],
        [208, 'Already Reported'],
        [226, 'IM Used'],
        [300, 'Multiple Choices'],
        [301, 'Moved Permanently'],
        [302, 'Found'],
        [303, 'See Other'],
        [304, 'Not Modified'],
        [305, 'Use Proxy'],
        [307, 'Temporary Redirect'],
        [308, 'Permanent Redirect'],
        [400, 'Bad Request'],
        [401, 'Unauthorized'],
        [402, 'Payment Required'],
        [403, 'Forbidden'],
        [404, 'Not Found'],
        [405, 'Method Not Allowed'],
        [406, 'Not Acceptable'],
        [407, 'Proxy Authentication Required'],
        [408, 'Request Timeout'],
        [409, 'Conflict'],
        [410, 'Gone'],
        [411, 'Length Required'],
        [412, 'Precondition Failed'],
        [413, 'Payload Too Large'],
        [414, 'URI Too Long'],
        [415, 'Unsupported Media Type'],
        [416, 'Range Not Satisfiable'],
        [417, 'Expectation Failed'],
        [418, 'I\'m a teapot'],
        [421, 'Misdirected Request'],
        [422, 'Unprocessable Entity'],
        [423, 'Locked'],
        [424, 'Failed Dependency'],
        [425, 'Too Early'],
        [426, 'Upgrade Required'],
        [428, 'Precondition Required'],
        [429, 'Too Many Requests'],
        [431, 'Request Header Fields Too Large'],
        [451, 'Unavailable For Legal Reasons'],
        [500, 'Internal Server Error'],
        [501, 'Not Implemented'],
        [502, 'Bad Gateway'],
        [503, 'Service Unavailable'],
        [504, 'Gateway Timeout'],
        [505, 'HTTP Version Not Supported'],
        [506, 'Variant Also Negotiates'],
        [507, 'Insufficient Storage'],
        [508, 'Loop Detected'],
        [510, 'Not Extended'],
        [511, 'Network Authentication Required']
    ]);

    public validate(response: CSResponse, config: CSStatusValidationConfig): CSValidationResult {
        const errors: CSValidationError[] = [];
        const warnings: string[] = [];
        const startTime = Date.now();

        CSReporter.debug(`Validating status code: ${response.status}`);

        // Expected exact status
        if (config.expected !== undefined) {
            const expectedArray = Array.isArray(config.expected) ? config.expected : [config.expected];
            if (!expectedArray.includes(response.status)) {
                errors.push(this.createError(
                    response.status,
                    expectedArray.length === 1
                        ? `${expectedArray[0]}`
                        : `one of [${expectedArray.join(', ')}]`,
                    'expected'
                ));
            }
        }

        // Range validation
        if (config.range) {
            if (response.status < config.range.min || response.status > config.range.max) {
                errors.push(this.createError(
                    response.status,
                    `between ${config.range.min} and ${config.range.max}`,
                    'range'
                ));
            }
        }

        // Pattern validation
        if (config.pattern) {
            const regex = typeof config.pattern === 'string'
                ? new RegExp(config.pattern)
                : config.pattern;

            if (!regex.test(String(response.status))) {
                errors.push(this.createError(
                    response.status,
                    `matching pattern ${regex}`,
                    'pattern'
                ));
            }
        }

        // Not validation
        if (config.not) {
            const notArray = Array.isArray(config.not) ? config.not : [config.not];
            if (notArray.includes(response.status)) {
                errors.push(this.createError(
                    response.status,
                    `not ${notArray.length === 1 ? notArray[0] : `one of [${notArray.join(', ')}]`}`,
                    'not'
                ));
            }
        }

        // Category validation
        if (config.category) {
            const category = this.statusCategories[config.category];
            if (response.status < category.min || response.status > category.max) {
                errors.push(this.createError(
                    response.status,
                    `in ${config.category} category (${category.min}-${category.max})`,
                    'category'
                ));
            }
        }

        // Custom validation
        if (config.custom) {
            const result = config.custom(response.status);
            if (result !== true) {
                errors.push({
                    path: 'status',
                    expected: 'custom validation to pass',
                    actual: response.status,
                    message: typeof result === 'string' ? result : 'Custom status validation failed',
                    type: 'status'
                });
            }
        }

        // Add warnings for unusual status codes
        if (!this.commonStatusCodes.has(response.status)) {
            warnings.push(`Unusual status code: ${response.status}`);
        }

        // Add status description if available
        const statusDescription = this.getStatusDescription(response.status);
        if (statusDescription) {
            CSReporter.debug(`Status ${response.status}: ${statusDescription}`);
        }

        const duration = Date.now() - startTime;

        return {
            valid: errors.length === 0,
            errors,
            warnings: warnings.length > 0 ? warnings : undefined,
            duration,
            metadata: {
                statusCode: response.status,
                statusText: response.statusText || statusDescription,
                category: this.getStatusCategory(response.status)
            }
        };
    }

    public validateMultiple(response: CSResponse, configs: CSStatusValidationConfig[]): CSValidationResult {
        const allErrors: CSValidationError[] = [];
        const allWarnings: string[] = [];
        const startTime = Date.now();

        for (const config of configs) {
            const result = this.validate(response, config);
            if (result.errors) {
                allErrors.push(...result.errors);
            }
            if (result.warnings) {
                allWarnings.push(...result.warnings);
            }
        }

        return {
            valid: allErrors.length === 0,
            errors: allErrors,
            warnings: allWarnings.length > 0 ? allWarnings : undefined,
            duration: Date.now() - startTime
        };
    }

    private createError(actual: number, expected: string, validationType: string): CSValidationError {
        const statusText = this.getStatusDescription(actual);
        return {
            path: 'status',
            expected,
            actual: actual,
            message: `Expected status ${expected}, but got ${actual}${statusText ? ` (${statusText})` : ''}`,
            type: 'status',
            metadata: {
                validationType,
                category: this.getStatusCategory(actual)
            }
        };
    }

    private getStatusDescription(status: number): string | undefined {
        return this.commonStatusCodes.get(status);
    }

    private getStatusCategory(status: number): string {
        for (const [category, range] of Object.entries(this.statusCategories)) {
            if (status >= range.min && status <= range.max) {
                return category;
            }
        }
        return 'unknown';
    }

    public isSuccess(status: number): boolean {
        return status >= 200 && status < 300;
    }

    public isRedirect(status: number): boolean {
        return status >= 300 && status < 400;
    }

    public isClientError(status: number): boolean {
        return status >= 400 && status < 500;
    }

    public isServerError(status: number): boolean {
        return status >= 500 && status < 600;
    }

    public isError(status: number): boolean {
        return status >= 400;
    }

    public expectStatus(status: number): CSStatusValidationConfig {
        return { expected: status };
    }

    public expectSuccess(): CSStatusValidationConfig {
        return { category: 'success' };
    }

    public expectRedirect(): CSStatusValidationConfig {
        return { category: 'redirect' };
    }

    public expectClientError(): CSStatusValidationConfig {
        return { category: 'client_error' };
    }

    public expectServerError(): CSStatusValidationConfig {
        return { category: 'server_error' };
    }

    public expectRange(min: number, max: number): CSStatusValidationConfig {
        return { range: { min, max } };
    }

    public expectNot(status: number | number[]): CSStatusValidationConfig {
        return { not: status };
    }

    public expectPattern(pattern: string | RegExp): CSStatusValidationConfig {
        return { pattern };
    }
}

export const statusCodeValidator = new CSStatusCodeValidator();