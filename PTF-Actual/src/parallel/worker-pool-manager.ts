/**
 * Optimized Worker Pool Manager for Parallel Execution
 * Addresses performance issues in parallel test execution
 */

import { Worker as ThreadWorker } from 'worker_threads';
import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

interface WorkerPoolOptions {
    maxWorkers?: number;
    workerScript?: string;
    reuseWorkers?: boolean;
    warmupWorkers?: boolean;
    useWorkerThreads?: boolean; // Use worker_threads instead of child_process
}

interface PoolWorker {
    id: number;
    process: ChildProcess | ThreadWorker;
    busy: boolean;
    initialized: boolean;
    currentWork?: any;
    startTime?: number;
    completedTasks: number;
}

export class WorkerPoolManager extends EventEmitter {
    private workers: Map<number, PoolWorker> = new Map();
    private workQueue: any[] = [];
    private options: WorkerPoolOptions;
    private nextWorkerId = 1;
    private sharedModuleCache: Map<string, any> = new Map();
    private workerInitPromises: Map<number, Promise<void>> = new Map();

    constructor(options: WorkerPoolOptions = {}) {
        super();
        this.options = {
            maxWorkers: options.maxWorkers || os.cpus().length,
            workerScript: options.workerScript || path.join(__dirname, 'optimized-worker.ts'),
            reuseWorkers: options.reuseWorkers !== false, // Default true
            warmupWorkers: options.warmupWorkers !== false, // Default true
            useWorkerThreads: options.useWorkerThreads || false
        };
    }

    /**
     * Initialize worker pool with parallel worker creation
     */
    async initialize(): Promise<void> {
        console.log(`[WorkerPool] Initializing ${this.options.maxWorkers} workers...`);
        const startTime = Date.now();

        // Create workers in parallel
        const workerPromises: Promise<void>[] = [];
        for (let i = 0; i < this.options.maxWorkers!; i++) {
            workerPromises.push(this.createWorker());
        }

        await Promise.all(workerPromises);

        // Warm up workers if enabled
        if (this.options.warmupWorkers) {
            await this.warmupWorkers();
        }

        console.log(`[WorkerPool] Initialized in ${Date.now() - startTime}ms`);
    }

    /**
     * Create a single worker with optimizations
     */
    private async createWorker(): Promise<void> {
        const workerId = this.nextWorkerId++;

        return new Promise((resolve, reject) => {
            let worker: PoolWorker;

            if (this.options.useWorkerThreads) {
                // Use worker_threads for better performance (shared memory)
                const threadWorker = new ThreadWorker(this.options.workerScript!, {
                    workerData: {
                        workerId,
                        isWorker: true
                    },
                    // Share ArrayBuffers for better performance
                    transferList: []
                });

                worker = {
                    id: workerId,
                    process: threadWorker,
                    busy: false,
                    initialized: false,
                    completedTasks: 0
                };

                threadWorker.on('message', (message) => {
                    this.handleWorkerMessage(worker, message);
                    if (message.type === 'ready') {
                        worker.initialized = true;
                        resolve();
                    }
                });

                threadWorker.on('error', reject);
            } else {
                // Use child_process with optimizations
                const childProcess = fork(this.options.workerScript!, [], {
                    execArgv: [
                        '-r', 'ts-node/register',
                        '--max-old-space-size=2048', // Increase memory limit
                        '--optimize-for-size', // Optimize for memory usage
                    ],
                    env: {
                        ...process.env,
                        WORKER_ID: String(workerId),
                        IS_WORKER: 'true',
                        TS_NODE_TRANSPILE_ONLY: 'true',
                        TS_NODE_COMPILER_OPTIONS: JSON.stringify({
                            module: 'commonjs',
                            target: 'es2017',
                            esModuleInterop: true,
                            skipLibCheck: true,
                            experimentalDecorators: true,
                            emitDecoratorMetadata: true
                        }),
                        // Use swc for faster transpilation if available
                        TS_NODE_COMPILER: 'swc',
                        // Cache compiled modules
                        TS_NODE_FILES: 'false',
                        TS_NODE_CACHE: 'true',
                        TS_NODE_CACHE_DIRECTORY: '.ts-node-cache'
                    },
                    serialization: 'advanced' // Use V8 serialization for better performance
                });

                worker = {
                    id: workerId,
                    process: childProcess,
                    busy: false,
                    initialized: false,
                    completedTasks: 0
                };

                childProcess.on('message', (message: any) => {
                    this.handleWorkerMessage(worker, message);
                    if (message.type === 'ready') {
                        worker.initialized = true;
                        resolve();
                    }
                });

                childProcess.on('error', reject);
                childProcess.on('exit', (code) => {
                    if (code !== 0 && code !== null) {
                        console.warn(`[WorkerPool] Worker ${workerId} exited with code ${code}`);
                        this.handleWorkerExit(worker);
                    }
                });
            }

            this.workers.set(workerId, worker);

            // Set initialization timeout
            setTimeout(() => {
                if (!worker.initialized) {
                    reject(new Error(`Worker ${workerId} initialization timeout`));
                }
            }, 15000); // 15 second timeout
        });
    }

    /**
     * Warm up workers by preloading modules
     */
    private async warmupWorkers(): Promise<void> {
        console.log('[WorkerPool] Warming up workers...');
        const warmupPromises: Promise<void>[] = [];

        for (const worker of this.workers.values()) {
            warmupPromises.push(new Promise((resolve) => {
                const onWarmup = (message: any) => {
                    if (message.type === 'warmup-complete') {
                        if (this.options.useWorkerThreads) {
                            (worker.process as ThreadWorker).off('message', onWarmup);
                        } else {
                            (worker.process as ChildProcess).off('message', onWarmup);
                        }
                        resolve();
                    }
                };

                if (this.options.useWorkerThreads) {
                    (worker.process as ThreadWorker).on('message', onWarmup);
                    (worker.process as ThreadWorker).postMessage({ type: 'warmup' });
                } else {
                    (worker.process as ChildProcess).on('message', onWarmup);
                    (worker.process as ChildProcess).send({ type: 'warmup' });
                }

                // Timeout for warmup
                setTimeout(resolve, 5000);
            }));
        }

        await Promise.all(warmupPromises);
    }

    /**
     * Execute work with load balancing
     */
    async execute(workItem: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const wrappedWork = {
                ...workItem,
                _resolve: resolve,
                _reject: reject,
                _timestamp: Date.now()
            };

            // Try to assign immediately to an idle worker
            const idleWorker = this.findIdleWorker();
            if (idleWorker) {
                this.assignWork(idleWorker, wrappedWork);
            } else {
                // Queue the work
                this.workQueue.push(wrappedWork);
            }
        });
    }

    /**
     * Find the best available worker (load balancing)
     */
    private findIdleWorker(): PoolWorker | null {
        let bestWorker: PoolWorker | null = null;
        let minTasks = Infinity;

        for (const worker of this.workers.values()) {
            if (!worker.busy && worker.initialized) {
                // Prefer workers with fewer completed tasks for better distribution
                if (worker.completedTasks < minTasks) {
                    bestWorker = worker;
                    minTasks = worker.completedTasks;
                }
            }
        }

        return bestWorker;
    }

    /**
     * Assign work to a worker
     */
    private assignWork(worker: PoolWorker, work: any): void {
        worker.busy = true;
        worker.currentWork = work;
        worker.startTime = Date.now();

        const message = {
            type: 'execute',
            workId: `work-${Date.now()}-${worker.id}`,
            ...work
        };

        // Remove internal properties before sending
        delete message._resolve;
        delete message._reject;
        delete message._timestamp;

        if (this.options.useWorkerThreads) {
            (worker.process as ThreadWorker).postMessage(message);
        } else {
            (worker.process as ChildProcess).send(message);
        }

        this.emit('work-assigned', {
            workerId: worker.id,
            workId: message.workId
        });
    }

    /**
     * Handle messages from workers
     */
    private handleWorkerMessage(worker: PoolWorker, message: any): void {
        switch (message.type) {
            case 'result':
                this.handleResult(worker, message);
                break;
            case 'error':
                this.handleError(worker, message);
                break;
            case 'log':
                console.log(`[Worker ${worker.id}] ${message.message}`);
                break;
            case 'metrics':
                this.emit('worker-metrics', {
                    workerId: worker.id,
                    metrics: message.metrics
                });
                break;
        }
    }

    /**
     * Handle successful result from worker
     */
    private handleResult(worker: PoolWorker, message: any): void {
        if (worker.currentWork) {
            const work = worker.currentWork;
            const duration = Date.now() - worker.startTime!;

            // Track performance metrics
            worker.completedTasks++;
            this.emit('work-completed', {
                workerId: worker.id,
                duration,
                result: message.result
            });

            // Resolve the promise
            if (work._resolve) {
                work._resolve(message.result);
            }

            // Clean up
            worker.busy = false;
            worker.currentWork = undefined;

            // Check if we should reuse or recreate the worker
            if (this.options.reuseWorkers) {
                // Assign next work if available
                this.assignNextWork(worker);
            } else {
                // Recreate worker for next task
                this.recycleWorker(worker);
            }
        }
    }

    /**
     * Handle error from worker
     */
    private handleError(worker: PoolWorker, message: any): void {
        console.error(`[WorkerPool] Worker ${worker.id} error:`, message.error);

        if (worker.currentWork && worker.currentWork._reject) {
            worker.currentWork._reject(new Error(message.error));
        }

        // Reset worker
        worker.busy = false;
        worker.currentWork = undefined;

        // Consider recreating the worker if it's having issues
        if (message.fatal) {
            this.recycleWorker(worker);
        } else {
            this.assignNextWork(worker);
        }
    }

    /**
     * Assign next work from queue to worker
     */
    private assignNextWork(worker: PoolWorker): void {
        if (this.workQueue.length > 0) {
            const nextWork = this.workQueue.shift();
            this.assignWork(worker, nextWork);
        }
    }

    /**
     * Handle worker exit
     */
    private handleWorkerExit(worker: PoolWorker): void {
        this.workers.delete(worker.id);

        // Reject any pending work
        if (worker.currentWork && worker.currentWork._reject) {
            worker.currentWork._reject(new Error('Worker exited unexpectedly'));
        }

        // Create replacement worker
        this.createWorker().catch(err => {
            console.error('[WorkerPool] Failed to create replacement worker:', err);
        });
    }

    /**
     * Recycle a worker (terminate and recreate)
     */
    private async recycleWorker(worker: PoolWorker): Promise<void> {
        const workerId = worker.id;

        // Terminate old worker
        if (this.options.useWorkerThreads) {
            await (worker.process as ThreadWorker).terminate();
        } else {
            (worker.process as ChildProcess).kill();
        }

        this.workers.delete(workerId);

        // Create new worker
        await this.createWorker();
    }

    /**
     * Get pool statistics
     */
    getStats(): any {
        const stats = {
            totalWorkers: this.workers.size,
            busyWorkers: 0,
            idleWorkers: 0,
            queueLength: this.workQueue.length,
            completedTasks: 0
        };

        for (const worker of this.workers.values()) {
            if (worker.busy) {
                stats.busyWorkers++;
            } else {
                stats.idleWorkers++;
            }
            stats.completedTasks += worker.completedTasks;
        }

        return stats;
    }

    /**
     * Shutdown the worker pool
     */
    async shutdown(): Promise<void> {
        console.log('[WorkerPool] Shutting down...');

        // Clear work queue
        for (const work of this.workQueue) {
            if (work._reject) {
                work._reject(new Error('Worker pool shutting down'));
            }
        }
        this.workQueue = [];

        // Terminate all workers
        const terminationPromises: Promise<void>[] = [];

        for (const worker of this.workers.values()) {
            terminationPromises.push(new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.options.useWorkerThreads) {
                        (worker.process as ThreadWorker).terminate();
                    } else {
                        (worker.process as ChildProcess).kill();
                    }
                    resolve();
                }, 5000);

                if (this.options.useWorkerThreads) {
                    (worker.process as ThreadWorker).terminate().then(() => {
                        clearTimeout(timeout);
                        resolve();
                    });
                } else {
                    (worker.process as ChildProcess).once('exit', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                    (worker.process as ChildProcess).send({ type: 'terminate' });
                }
            }));
        }

        await Promise.all(terminationPromises);
        this.workers.clear();
        console.log('[WorkerPool] Shutdown complete');
    }
}