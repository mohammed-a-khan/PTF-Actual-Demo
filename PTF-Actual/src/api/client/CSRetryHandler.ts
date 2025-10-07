import { CSRetryConfig, CSResponse, CSRetryStrategy } from '../types/CSApiTypes';
import { CSReporter } from '../../reporter/CSReporter';

export class CSRetryHandler {
    private defaultConfig: CSRetryConfig;

    constructor() {
        this.defaultConfig = {
            maxRetries: 3,
            retryDelay: 1000,
            retryStrategy: 'exponential',
            backoffMultiplier: 2,
            maxRetryDelay: 30000,
            retryOnTimeout: true,
            retryOnConnectionError: true,
            retryStatusCodes: [408, 429, 500, 502, 503, 504],
            jitter: true
        };
    }

    public async retry<T>(
        fn: () => Promise<T>,
        config?: CSRetryConfig
    ): Promise<T> {
        const retryConfig = { ...this.defaultConfig, ...config };
        let lastError: any;
        let retryCount = 0;

        while (retryCount <= (retryConfig.maxRetries || 0)) {
            try {
                const result = await fn();
                if (retryCount > 0) {
                    CSReporter.debug(`Request succeeded after ${retryCount} retries`);
                }
                return result;
            } catch (error) {
                lastError = error;

                if (!this.shouldRetry(error, retryConfig, retryCount)) {
                    throw error;
                }

                const delay = this.calculateDelay(retryCount, retryConfig);

                if (retryConfig.onRetry) {
                    retryConfig.onRetry(error, retryCount + 1);
                }

                CSReporter.debug(`Retrying request (attempt ${retryCount + 1}/${retryConfig.maxRetries}) - delay: ${delay}ms, error: ${(error as Error).message}`);

                await this.sleep(delay);
                retryCount++;
            }
        }

        throw lastError;
    }

    private shouldRetry(error: any, config: CSRetryConfig, retryCount: number): boolean {
        if (retryCount >= (config.maxRetries || 0)) {
            return false;
        }

        if (config.retryCondition) {
            return config.retryCondition(error, error.response);
        }

        if (this.isTimeoutError(error) && config.retryOnTimeout) {
            return true;
        }

        if (this.isConnectionError(error) && config.retryOnConnectionError) {
            return true;
        }

        if (error.response && config.retryStatusCodes) {
            return config.retryStatusCodes.includes(error.response.status);
        }

        const retryAfterHeader = error.response?.headers?.['retry-after'];
        if (retryAfterHeader) {
            return true;
        }

        return false;
    }

    private calculateDelay(retryCount: number, config: CSRetryConfig): number {
        let delay = config.retryDelay || 1000;

        const retryAfterMs = this.getRetryAfterMs(config);
        if (retryAfterMs) {
            return Math.min(retryAfterMs, config.maxRetryDelay || 30000);
        }

        switch (config.retryStrategy) {
            case 'exponential':
                delay = delay * Math.pow(config.backoffMultiplier || 2, retryCount);
                break;

            case 'linear':
                delay = delay * (retryCount + 1);
                break;

            case 'fibonacci':
                delay = this.fibonacci(retryCount + 1) * delay;
                break;

            case 'constant':
            default:
                break;
        }

        if (config.maxRetryDelay) {
            delay = Math.min(delay, config.maxRetryDelay);
        }

        if (config.jitter) {
            delay = this.addJitter(delay);
        }

        return delay;
    }

    private getRetryAfterMs(config: any): number | null {
        const response = config._lastResponse;
        if (!response?.headers?.['retry-after']) {
            return null;
        }

        const retryAfter = response.headers['retry-after'];

        if (/^\d+$/.test(retryAfter)) {
            return parseInt(retryAfter, 10) * 1000;
        }

        const retryDate = new Date(retryAfter);
        if (!isNaN(retryDate.getTime())) {
            return Math.max(0, retryDate.getTime() - Date.now());
        }

        return null;
    }

    private fibonacci(n: number): number {
        if (n <= 1) return n;
        let a = 0, b = 1;
        for (let i = 2; i <= n; i++) {
            const temp = a + b;
            a = b;
            b = temp;
        }
        return b;
    }

    private addJitter(delay: number): number {
        const jitterRange = delay * 0.2;
        const jitter = Math.random() * jitterRange - jitterRange / 2;
        return Math.max(0, delay + jitter);
    }

    private isTimeoutError(error: any): boolean {
        return error.code === 'ETIMEDOUT' ||
               error.code === 'ESOCKETTIMEDOUT' ||
               error.message?.includes('timeout');
    }

    private isConnectionError(error: any): boolean {
        const connectionErrorCodes = [
            'ECONNRESET',
            'ECONNREFUSED',
            'ECONNABORTED',
            'ENETUNREACH',
            'EHOSTUNREACH',
            'ENOTFOUND',
            'EPIPE',
            'EAI_AGAIN'
        ];

        return connectionErrorCodes.includes(error.code);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public createRetryableRequest<T>(
        fn: () => Promise<T>,
        config?: CSRetryConfig
    ): () => Promise<T> {
        return () => this.retry(fn, config);
    }

    public withExponentialBackoff<T>(
        fn: () => Promise<T>,
        maxRetries: number = 3,
        initialDelay: number = 1000
    ): Promise<T> {
        return this.retry(fn, {
            maxRetries,
            retryDelay: initialDelay,
            retryStrategy: 'exponential',
            backoffMultiplier: 2,
            jitter: true
        });
    }

    public withLinearBackoff<T>(
        fn: () => Promise<T>,
        maxRetries: number = 3,
        delay: number = 1000
    ): Promise<T> {
        return this.retry(fn, {
            maxRetries,
            retryDelay: delay,
            retryStrategy: 'linear',
            jitter: false
        });
    }

    public withConstantDelay<T>(
        fn: () => Promise<T>,
        maxRetries: number = 3,
        delay: number = 1000
    ): Promise<T> {
        return this.retry(fn, {
            maxRetries,
            retryDelay: delay,
            retryStrategy: 'constant',
            jitter: false
        });
    }

    public async executeWithRetry<T>(
        fn: () => Promise<T>,
        options?: {
            maxRetries?: number;
            retryDelay?: number;
            exponentialBackoff?: boolean;
            maxDelay?: number;
            shouldRetry?: (error: any) => boolean;
        }
    ): Promise<T> {
        const config: CSRetryConfig = {
            maxRetries: options?.maxRetries || 3,
            retryDelay: options?.retryDelay || 1000,
            retryStrategy: options?.exponentialBackoff ? 'exponential' : 'constant',
            maxRetryDelay: options?.maxDelay,
            retryCondition: options?.shouldRetry
        };

        return this.retry(fn, config);
    }

    public async retryWithCircuitBreaker<T>(
        fn: () => Promise<T>,
        config?: CSRetryConfig,
        circuitConfig?: {
            failureThreshold: number;
            resetTimeout: number;
        }
    ): Promise<T> {
        const circuit = new CircuitBreaker(
            circuitConfig?.failureThreshold || 5,
            circuitConfig?.resetTimeout || 60000
        );

        if (!circuit.canExecute()) {
            throw new Error('Circuit breaker is open');
        }

        try {
            const result = await this.retry(fn, config);
            circuit.recordSuccess();
            return result;
        } catch (error) {
            circuit.recordFailure();
            throw error;
        }
    }
}

class CircuitBreaker {
    private failures: number = 0;
    private lastFailureTime: number = 0;
    private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

    constructor(
        private failureThreshold: number,
        private resetTimeout: number
    ) {}

    public canExecute(): boolean {
        if (this.state === 'CLOSED') {
            return true;
        }

        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.resetTimeout) {
                this.state = 'HALF_OPEN';
                return true;
            }
            return false;
        }

        return true;
    }

    public recordSuccess(): void {
        this.failures = 0;
        this.state = 'CLOSED';
    }

    public recordFailure(): void {
        this.failures++;
        this.lastFailureTime = Date.now();

        if (this.failures >= this.failureThreshold) {
            this.state = 'OPEN';
        }
    }

    public getState(): string {
        return this.state;
    }

    public reset(): void {
        this.failures = 0;
        this.lastFailureTime = 0;
        this.state = 'CLOSED';
    }
}