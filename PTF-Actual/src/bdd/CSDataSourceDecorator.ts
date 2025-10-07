import { CSDataProvider, DataProviderOptions, DataRow } from '../data/CSDataProvider';
import { CSReporter } from '../reporter/CSReporter';
import { CSBDDStepDef } from './CSStepRegistry';

export interface DataSourceOptions extends Partial<DataProviderOptions> {
    source: string;
    iterator?: string; // Name of the parameter to receive each row
    failFast?: boolean; // Stop on first failure
    allowFailures?: boolean; // Continue even if some iterations fail
}

/**
 * Decorator for data-driven testing
 * Loads data from various sources and executes the step for each row
 */
export function CSDataSource(options: DataSourceOptions): MethodDecorator {
    return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor | void {
        const originalMethod = descriptor.value;
        const iteratorParam = options.iterator || 'row';

        descriptor.value = async function (...args: any[]) {
            const dataProvider = CSDataProvider.getInstance();

            try {
                // Load data from source
                const data = await dataProvider.loadData(options as DataProviderOptions);

                CSReporter.info(`Executing data-driven test with ${data.length} rows from ${options.source}`);

                const results: any[] = [];
                const errors: any[] = [];

                // Execute test for each data row
                for (let i = 0; i < data.length; i++) {
                    const row = data[i];
                    CSReporter.info(`Executing iteration ${i + 1}/${data.length}`);

                    try {
                        // Inject the data row as a parameter
                        const enhancedArgs = [...args];

                        // If method expects the data row, inject it
                        if (originalMethod.length > args.length) {
                            enhancedArgs.push(row);
                        }

                        // Set context for current iteration
                        (this as any)._currentDataRow = row;
                        (this as any)._currentIteration = i + 1;
                        (this as any)._totalIterations = data.length;

                        const result = await originalMethod.apply(this, enhancedArgs);
                        results.push({
                            iteration: i + 1,
                            data: row,
                            result,
                            status: 'passed'
                        });

                        CSReporter.pass(`Iteration ${i + 1} passed`);
                    } catch (error) {
                        CSReporter.error(`Iteration ${i + 1} failed: ${error}`);
                        errors.push({
                            iteration: i + 1,
                            data: row,
                            error,
                            status: 'failed'
                        });

                        // Continue with next iteration unless fail fast is enabled
                        if (options.failFast) {
                            throw new Error(`Data-driven test failed at iteration ${i + 1}: ${error}`);
                        }
                    }
                }

                // Report summary
                CSReporter.info(`Data-driven test completed: ${results.length} passed, ${errors.length} failed`);

                if (errors.length > 0 && !options.allowFailures) {
                    const errorSummary = errors.map(e =>
                        `Iteration ${e.iteration}: ${e.error}`
                    ).join('\n');
                    throw new Error(`Data-driven test had ${errors.length} failures:\n${errorSummary}`);
                }

                return { results, errors };
            } catch (error: any) {
                CSReporter.error(`Failed to load data from ${options.source}: ${error.message}`);
                throw error;
            }
        };

        return descriptor;
    };
}

/**
 * Decorator to combine with step definition for data-driven steps
 */
export function CSDataDrivenStep(stepPattern: string, dataSourceOptions: DataSourceOptions): MethodDecorator {
    return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor | void {
        // Apply data source decorator first
        CSDataSource(dataSourceOptions)(target, propertyKey, descriptor);

        // Then apply step definition decorator
        CSBDDStepDef(stepPattern)(target, propertyKey, descriptor);

        return descriptor;
    };
}

/**
 * Helper to get current data row in step execution
 */
export function getCurrentDataRow(context: any): DataRow | undefined {
    return context._currentDataRow;
}

/**
 * Helper to get current iteration info
 */
export function getIterationInfo(context: any): { current: number; total: number } | undefined {
    if (context._currentIteration && context._totalIterations) {
        return {
            current: context._currentIteration,
            total: context._totalIterations
        };
    }
    return undefined;
}

// Extended options for advanced scenarios
export interface AdvancedDataSourceOptions extends DataSourceOptions {
    failFast?: boolean;         // Stop on first failure
    allowFailures?: boolean;    // Allow some iterations to fail
    parallel?: boolean;         // Run iterations in parallel
    maxParallel?: number;       // Max parallel executions
    retryCount?: number;        // Retry failed iterations
    beforeEach?: (row: DataRow, index: number) => Promise<void>; // Hook before each iteration
    afterEach?: (row: DataRow, index: number, result: any) => Promise<void>; // Hook after each iteration
}

/**
 * Advanced data-driven decorator with more options
 */
export function CSAdvancedDataSource(options: AdvancedDataSourceOptions): MethodDecorator {
    return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor | void {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            const dataProvider = CSDataProvider.getInstance();

            try {
                // Load data from source
                const data = await dataProvider.loadData(options as DataProviderOptions);

                CSReporter.info(`Executing advanced data-driven test with ${data.length} rows from ${options.source}`);

                if (options.parallel) {
                    // Parallel execution
                    const maxParallel = options.maxParallel || 5;
                    const results = [];

                    for (let i = 0; i < data.length; i += maxParallel) {
                        const batch = data.slice(i, i + maxParallel);
                        const batchPromises = batch.map(async (row, index) => {
                            const actualIndex = i + index;

                            if (options.beforeEach) {
                                await options.beforeEach(row, actualIndex);
                            }

                            try {
                                const result = await executeWithRetry(
                                    originalMethod,
                                    this,
                                    [...args, row],
                                    options.retryCount || 0
                                );

                                if (options.afterEach) {
                                    await options.afterEach(row, actualIndex, result);
                                }

                                return { iteration: actualIndex + 1, data: row, result, status: 'passed' };
                            } catch (error) {
                                return { iteration: actualIndex + 1, data: row, error, status: 'failed' };
                            }
                        });

                        const batchResults = await Promise.all(batchPromises);
                        results.push(...batchResults);
                    }

                    return results;
                } else {
                    // Sequential execution (default)
                    const decoratedDescriptor = CSDataSource(options)(target, propertyKey, descriptor) as PropertyDescriptor;
                    return decoratedDescriptor.value.apply(this, args);
                }
            } catch (error: any) {
                CSReporter.error(`Failed to execute advanced data-driven test: ${error.message}`);
                throw error;
            }
        };

        return descriptor;
    };
}

async function executeWithRetry(method: Function, context: any, args: any[], retryCount: number): Promise<any> {
    let lastError;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
            return await method.apply(context, args);
        } catch (error) {
            lastError = error;
            if (attempt < retryCount) {
                CSReporter.warn(`Attempt ${attempt + 1} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Exponential backoff
            }
        }
    }

    throw lastError;
}