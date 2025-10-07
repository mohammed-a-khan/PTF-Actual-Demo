import { CSResponse, CSValidationResult } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export interface CSResponseTimeValidationConfig {
    maxTime?: number;
    minTime?: number;
    expectedTime?: number;
    tolerance?: number;
}

export class CSResponseTimeValidator {
    public async validate(response: CSResponse, config: CSResponseTimeValidationConfig): Promise<CSValidationResult> {
        try {
            const responseTime = response.duration || 0;

            if (config.maxTime !== undefined && responseTime > config.maxTime) {
                return {
                    valid: false,
                    message: `Response time ${responseTime}ms exceeds maximum ${config.maxTime}ms`
                };
            }

            if (config.minTime !== undefined && responseTime < config.minTime) {
                return {
                    valid: false,
                    message: `Response time ${responseTime}ms is below minimum ${config.minTime}ms`
                };
            }

            if (config.expectedTime !== undefined) {
                const tolerance = config.tolerance || 0;
                const lowerBound = config.expectedTime - tolerance;
                const upperBound = config.expectedTime + tolerance;

                if (responseTime < lowerBound || responseTime > upperBound) {
                    return {
                        valid: false,
                        message: `Response time ${responseTime}ms is not within expected range ${lowerBound}-${upperBound}ms`
                    };
                }
            }

            return {
                valid: true,
                extractedValue: responseTime
            };

        } catch (error) {
            CSReporter.error(`Response time validation failed: ${(error as Error).message}`);
            return {
                valid: false,
                message: `Response time validation error: ${(error as Error).message}`
            };
        }
    }

    public validatePerformance(response: CSResponse, thresholds: {
        fast?: number;
        slow?: number;
        timeout?: number;
    }): {
        category: 'fast' | 'normal' | 'slow' | 'timeout';
        time: number;
        withinThreshold: boolean;
    } {
        const responseTime = response.duration || 0;

        if (thresholds.timeout && responseTime >= thresholds.timeout) {
            return { category: 'timeout', time: responseTime, withinThreshold: false };
        }

        if (thresholds.slow && responseTime >= thresholds.slow) {
            return { category: 'slow', time: responseTime, withinThreshold: false };
        }

        if (thresholds.fast && responseTime <= thresholds.fast) {
            return { category: 'fast', time: responseTime, withinThreshold: true };
        }

        return { category: 'normal', time: responseTime, withinThreshold: true };
    }

    public async validateBatch(responses: CSResponse[], config: CSResponseTimeValidationConfig): Promise<{
        allValid: boolean;
        results: Array<{ response: CSResponse; result: CSValidationResult }>;
        stats: {
            average: number;
            min: number;
            max: number;
            total: number;
        };
    }> {
        const results: Array<{ response: CSResponse; result: CSValidationResult }> = [];
        const times: number[] = [];

        for (const response of responses) {
            const result = await this.validate(response, config);
            results.push({ response, result });
            times.push(response.duration || 0);
        }

        const stats = {
            average: times.reduce((a, b) => a + b, 0) / times.length,
            min: Math.min(...times),
            max: Math.max(...times),
            total: times.reduce((a, b) => a + b, 0)
        };

        const allValid = results.every(r => r.result.valid);

        return { allValid, results, stats };
    }
}