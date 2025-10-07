export interface WorkerTask {
    id: string;
    type: 'feature' | 'scenario';
    featureFile: string;
    featureName: string;
    scenarioName?: string;
    scenarioIndex?: number;
    tags?: string[];
    priority: PriorityLevel;
    estimatedDuration?: number;
    retryCount?: number;
    dependencies?: string[];
}

export interface WorkerMessage {
    type: 'task' | 'result' | 'error' | 'progress' | 'log' | 'heartbeat' | 'ready';
    workerId: number;
    taskId?: string;
    data?: any;
    error?: string;
    timestamp: number;
}

export interface WorkerResult {
    taskId: string;
    workerId: number;
    status: 'passed' | 'failed' | 'skipped' | 'pending';
    startTime: number;
    endTime: number;
    duration: number;
    error?: string;
    stackTrace?: string;
    retries?: number;
    steps?: StepResult[];
    screenshots?: string[];
    videos?: string[];
    logs?: string[];
}

export interface StepResult {
    keyword: string;
    text: string;
    status: 'passed' | 'failed' | 'skipped' | 'pending';
    duration: number;
    error?: string;
    screenshot?: string;
}

export interface WorkerInfo {
    id: number;
    worker: any;
    status: WorkerStatus;
    currentTask?: WorkerTask;
    tasksCompleted: number;
    tasksFailed: number;
    startTime: number;
    lastHeartbeat: number;
    cpuUsage?: number;
    memoryUsage?: number;
}

export type WorkerStatus = 'idle' | 'busy' | 'error' | 'terminated';

export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';

export interface ExecutionPlan {
    totalTasks: number;
    totalWorkers: number;
    tasks: WorkerTask[];
    estimatedDuration: number;
    parallelGroups?: TaskGroup[];
    executionOrder: string[];
}

export interface TaskGroup {
    id: string;
    priority: PriorityLevel;
    tasks: WorkerTask[];
    canRunInParallel: boolean;
    dependencies?: string[];
}

export interface ExecutionStats {
    totalWorkers: number;
    activeWorkers: number;
    idleWorkers: number;
    completedTasks: number;
    failedTasks: number;
    pendingTasks: number;
    averageTaskDuration: number;
    totalDuration: number;
    workerUtilization: Map<number, number>;
}

export interface ParallelOptions {
    maxWorkers?: number;
    taskTimeout?: number;
    workerTimeout?: number;
    retryOnFailure?: boolean;
    maxRetries?: number;
    failFast?: boolean;
    loadBalancing?: 'roundRobin' | 'leastBusy' | 'random';
    schedulingStrategy?: 'priority' | 'fifo' | 'lifo' | 'optimal';
    resourceLimits?: {
        maxOldGenerationSizeMb?: number;
        maxYoungGenerationSizeMb?: number;
        codeRangeSizeMb?: number;
    };
}

export interface ParallelResult {
    startTime: Date;
    endTime: Date;
    duration: number;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    skippedTasks: number;
    results: Map<string, WorkerResult>;
    stats: ExecutionStats;
    errors: Array<{taskId: string; error: string}>;
}

export interface ParsedFeature {
    name: string;
    description?: string;
    tags: string[];
    scenarios: ParsedScenario[];
}

export interface ParsedScenario {
    name: string;
    description?: string;
    tags: string[];
    steps: Array<{
        keyword: string;
        text: string;
    }>;
}