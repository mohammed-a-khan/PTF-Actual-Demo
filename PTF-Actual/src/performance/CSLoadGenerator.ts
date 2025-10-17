import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSAPIClient } from '../api/CSAPIClient';
import {
    PerformanceScenarioConfig,
    PerformanceMetrics,
    VirtualUser,
    LoadConfiguration,
    LoadPattern,
    LoadStep,
    RequestTemplate,
    SystemMetrics,
    VirtualUserResult
} from './types/CSPerformanceTypes';

/**
 * CS Load Generator
 * Manages virtual users, load patterns, and request execution for performance testing
 */
export class CSLoadGenerator {
    private static instance: CSLoadGenerator;
    private config: CSConfigurationManager;
    private apiClient: CSAPIClient;
    private activeTests: Map<string, LoadTestExecution>;
    private virtualUsers: Map<string, VirtualUser[]>;
    private systemMonitor: any; // Will be initialized when needed

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.apiClient = new CSAPIClient();
        this.activeTests = new Map();
        this.virtualUsers = new Map();
    }

    public static getInstance(): CSLoadGenerator {
        if (!CSLoadGenerator.instance) {
            CSLoadGenerator.instance = new CSLoadGenerator();
        }
        return CSLoadGenerator.instance;
    }

    /**
     * Execute load test according to scenario configuration
     */
    public async executeLoad(testId: string, scenarioConfig: PerformanceScenarioConfig): Promise<void> {
        CSReporter.info(`Starting load execution for test: ${testId}`);

        const execution: LoadTestExecution = {
            testId,
            scenarioConfig,
            startTime: Date.now(),
            status: 'initializing',
            virtualUsers: [],
            metrics: {
                requestsSent: 0,
                requestsCompleted: 0,
                requestsFailed: 0,
                totalResponseTime: 0,
                minResponseTime: Number.MAX_VALUE,
                maxResponseTime: 0,
                responseTimes: [],
                errors: new Map(),
                bytesTransferred: 0
            }
        };

        this.activeTests.set(testId, execution);

        try {
            execution.status = 'running';

            // Initialize system monitoring if enabled
            if (this.config.getBoolean('PERFORMANCE_SYSTEM_MONITORING', false)) {
                await this.startSystemMonitoring(testId);
            }

            // Execute load pattern
            await this.executeLoadPattern(testId, scenarioConfig.loadConfig);

            execution.status = 'completed';
            CSReporter.info(`Load execution completed for test: ${testId}`);
        } catch (error) {
            execution.status = 'failed';
            CSReporter.error(`Load execution failed for test ${testId}: ${(error as Error).message}`);
            throw error;
        } finally {
            await this.stopSystemMonitoring(testId);
        }
    }

    /**
     * Stop load test execution
     */
    public async stopTest(testId: string): Promise<void> {
        const execution = this.activeTests.get(testId);
        if (!execution) {
            CSReporter.warn(`Test ${testId} not found for stopping`);
            return;
        }

        CSReporter.info(`Stopping load test: ${testId}`);
        execution.status = 'stopping';

        // Stop all virtual users for this test
        const virtualUsers = this.virtualUsers.get(testId) || [];
        for (const user of virtualUsers) {
            if (user.status === 'active') {
                user.status = 'stopping';
            }
        }

        // Wait for virtual users to complete their current requests
        await this.waitForVirtualUsersToStop(testId);

        execution.status = 'stopped';
        await this.stopSystemMonitoring(testId);
    }

    /**
     * Get current metrics for a test
     */
    public async getMetrics(testId: string): Promise<PerformanceMetrics | null> {
        const execution = this.activeTests.get(testId);
        if (!execution) {
            return null;
        }

        const virtualUsers = this.virtualUsers.get(testId) || [];
        const currentTime = Date.now();

        // Calculate current metrics
        const activeUsers = virtualUsers.filter(u => u.status === 'active').length;
        const completedUsers = virtualUsers.filter(u => u.status === 'completed').length;
        const failedUsers = virtualUsers.filter(u => u.status === 'failed').length;

        const metrics = execution.metrics;
        const elapsedTime = (currentTime - execution.startTime) / 1000;

        const performanceMetrics: PerformanceMetrics = {
            timestamp: currentTime,
            virtualUsers: {
                active: activeUsers,
                total: virtualUsers.length,
                completed: completedUsers,
                failed: failedUsers
            },
            requests: {
                sent: metrics.requestsSent,
                completed: metrics.requestsCompleted,
                failed: metrics.requestsFailed,
                pending: metrics.requestsSent - metrics.requestsCompleted - metrics.requestsFailed
            },
            timing: {
                averageResponseTime: metrics.requestsCompleted > 0 ? metrics.totalResponseTime / metrics.requestsCompleted : 0,
                minResponseTime: metrics.minResponseTime === Number.MAX_VALUE ? 0 : metrics.minResponseTime,
                maxResponseTime: metrics.maxResponseTime,
                percentile50: this.calculatePercentile(metrics.responseTimes, 50),
                percentile95: this.calculatePercentile(metrics.responseTimes, 95),
                percentile99: this.calculatePercentile(metrics.responseTimes, 99)
            },
            throughput: {
                requestsPerSecond: elapsedTime > 0 ? metrics.requestsCompleted / elapsedTime : 0,
                bytesPerSecond: elapsedTime > 0 ? metrics.bytesTransferred / elapsedTime : 0,
                averageThroughput: elapsedTime > 0 ? metrics.requestsCompleted / elapsedTime : 0
            },
            errors: {
                count: metrics.requestsFailed,
                rate: metrics.requestsSent > 0 ? (metrics.requestsFailed / metrics.requestsSent) * 100 : 0,
                types: Object.fromEntries(metrics.errors)
            },
            system: await this.getSystemMetrics(testId)
        };

        return performanceMetrics;
    }

    private async executeLoadPattern(testId: string, loadConfig: LoadConfiguration): Promise<void> {
        switch (loadConfig.pattern) {
            case 'constant':
                await this.executeConstantLoad(testId, loadConfig);
                break;
            case 'ramp-up':
                await this.executeRampUpLoad(testId, loadConfig);
                break;
            case 'ramp-down':
                await this.executeRampDownLoad(testId, loadConfig);
                break;
            case 'step':
                await this.executeStepLoad(testId, loadConfig);
                break;
            case 'spike':
                await this.executeSpikeLoad(testId, loadConfig);
                break;
            case 'custom':
                await this.executeCustomLoad(testId, loadConfig);
                break;
            default:
                throw new Error(`Unsupported load pattern: ${loadConfig.pattern}`);
        }
    }

    private async executeConstantLoad(testId: string, loadConfig: LoadConfiguration): Promise<void> {
        const virtualUsers: VirtualUser[] = [];

        // Create virtual users
        for (let i = 0; i < loadConfig.virtualUsers; i++) {
            const user = await this.createVirtualUser(testId, i);
            virtualUsers.push(user);
        }

        this.virtualUsers.set(testId, virtualUsers);

        // Start all virtual users
        const startPromises = virtualUsers.map(user => this.runVirtualUser(testId, user, loadConfig));

        // Wait for test duration or until stopped
        await Promise.race([
            Promise.all(startPromises),
            this.sleep(loadConfig.duration * 1000)
        ]);
    }

    private async executeRampUpLoad(testId: string, loadConfig: LoadConfiguration): Promise<void> {
        const rampUpTime = loadConfig.rampUpTime || loadConfig.duration / 2;
        const userIncrement = Math.ceil(loadConfig.virtualUsers / 10);
        const stepDuration = (rampUpTime * 1000) / 10; // Add users in 10 steps

        const virtualUsers: VirtualUser[] = [];
        this.virtualUsers.set(testId, virtualUsers);

        // Gradually add virtual users
        for (let step = 0; step < 10; step++) {
            const usersToAdd = Math.min(userIncrement, loadConfig.virtualUsers - virtualUsers.length);

            for (let i = 0; i < usersToAdd; i++) {
                const user = await this.createVirtualUser(testId, virtualUsers.length);
                virtualUsers.push(user);

                // Start the virtual user without waiting
                this.runVirtualUser(testId, user, loadConfig);
            }

            CSReporter.debug(`Ramp-up step ${step + 1}: Added ${usersToAdd} users (Total: ${virtualUsers.length})`);

            if (virtualUsers.length < loadConfig.virtualUsers) {
                await this.sleep(stepDuration);
            }
        }

        // Run for remaining duration
        const remainingDuration = loadConfig.duration * 1000 - rampUpTime * 1000;
        if (remainingDuration > 0) {
            await this.sleep(remainingDuration);
        }
    }

    private async executeRampDownLoad(testId: string, loadConfig: LoadConfiguration): Promise<void> {
        // Start with all users, then gradually remove them
        await this.executeRampUpLoad(testId, { ...loadConfig, duration: loadConfig.duration / 2 });

        const rampDownTime = loadConfig.rampDownTime || loadConfig.duration / 2;
        const virtualUsers = this.virtualUsers.get(testId) || [];
        const userDecrement = Math.ceil(virtualUsers.length / 10);
        const stepDuration = (rampDownTime * 1000) / 10;

        // Gradually stop virtual users
        for (let step = 0; step < 10; step++) {
            const usersToStop = Math.min(userDecrement, virtualUsers.filter(u => u.status === 'active').length);

            let stopped = 0;
            for (const user of virtualUsers) {
                if (user.status === 'active' && stopped < usersToStop) {
                    user.status = 'stopping';
                    stopped++;
                }
            }

            CSReporter.debug(`Ramp-down step ${step + 1}: Stopping ${stopped} users`);

            if (virtualUsers.filter(u => u.status === 'active').length > 0) {
                await this.sleep(stepDuration);
            }
        }
    }

    private async executeStepLoad(testId: string, loadConfig: LoadConfiguration): Promise<void> {
        // Implement step load pattern
        const steps = 5;
        const usersPerStep = Math.ceil(loadConfig.virtualUsers / steps);
        const stepDuration = (loadConfig.duration * 1000) / steps;

        const virtualUsers: VirtualUser[] = [];
        this.virtualUsers.set(testId, virtualUsers);

        for (let step = 0; step < steps; step++) {
            const targetUsers = Math.min((step + 1) * usersPerStep, loadConfig.virtualUsers);

            // Add users to reach target
            while (virtualUsers.length < targetUsers) {
                const user = await this.createVirtualUser(testId, virtualUsers.length);
                virtualUsers.push(user);
                this.runVirtualUser(testId, user, loadConfig);
            }

            CSReporter.debug(`Step ${step + 1}: Running with ${virtualUsers.length} users`);
            await this.sleep(stepDuration);
        }
    }

    private async executeSpikeLoad(testId: string, loadConfig: LoadConfiguration): Promise<void> {
        // Start with baseline load
        const baselineUsers = Math.ceil(loadConfig.virtualUsers * 0.1);
        const spikeUsers = loadConfig.virtualUsers;
        const spikeDuration = Math.min(loadConfig.duration * 0.3, 30); // Max 30 seconds spike

        // Baseline phase
        await this.executeConstantLoad(testId,
            {
                ...loadConfig,
                virtualUsers: baselineUsers,
                duration: (loadConfig.duration - spikeDuration) / 2
            });

        // Spike phase
        const virtualUsers = this.virtualUsers.get(testId) || [];
        const additionalUsers = spikeUsers - baselineUsers;

        for (let i = 0; i < additionalUsers; i++) {
            const user = await this.createVirtualUser(testId, virtualUsers.length);
            virtualUsers.push(user);
            this.runVirtualUser(testId, user, loadConfig);
        }

        CSReporter.info(`Spike: Added ${additionalUsers} users for ${spikeDuration}s`);
        await this.sleep(spikeDuration * 1000);

        // Return to baseline
        for (let i = 0; i < additionalUsers; i++) {
            const activeUser = virtualUsers.find(u => u.status === 'active');
            if (activeUser) {
                activeUser.status = 'stopping';
            }
        }

        // Finish with baseline
        await this.sleep(((loadConfig.duration - spikeDuration) / 2) * 1000);
    }

    private async executeCustomLoad(testId: string, loadConfig: LoadConfiguration): Promise<void> {
        if (!loadConfig.customPattern) {
            throw new Error('Custom load pattern requires customPattern configuration');
        }

        const virtualUsers: VirtualUser[] = [];
        this.virtualUsers.set(testId, virtualUsers);

        for (const step of loadConfig.customPattern) {
            // Adjust virtual users to match step requirements
            const currentActiveUsers = virtualUsers.filter(u => u.status === 'active').length;
            const targetUsers = step.virtualUsers;

            if (targetUsers > currentActiveUsers) {
                // Add users
                const usersToAdd = targetUsers - currentActiveUsers;
                for (let i = 0; i < usersToAdd; i++) {
                    const user = await this.createVirtualUser(testId, virtualUsers.length);
                    virtualUsers.push(user);
                    this.runVirtualUser(testId, user, loadConfig);
                }
            } else if (targetUsers < currentActiveUsers) {
                // Stop users
                const usersToStop = currentActiveUsers - targetUsers;
                let stopped = 0;
                for (const user of virtualUsers) {
                    if (user.status === 'active' && stopped < usersToStop) {
                        user.status = 'stopping';
                        stopped++;
                    }
                }
            }

            CSReporter.debug(`Custom load step: ${step.description || 'Step'} - ${targetUsers} users for ${step.duration}s`);
            await this.sleep(step.duration * 1000);
        }
    }

    private async createVirtualUser(testId: string, userId: number): Promise<VirtualUser> {
        return {
            id: `${testId}_user_${userId}`,
            startTime: Date.now(),
            requestCount: 0,
            errorCount: 0,
            averageResponseTime: 0,
            status: 'active'
        };
    }

    private async runVirtualUser(testId: string, user: VirtualUser, loadConfig: LoadConfiguration): Promise<void> {
        const execution = this.activeTests.get(testId);
        if (!execution) return;

        const endTime = Date.now() + (loadConfig.duration * 1000);
        const thinkTime = loadConfig.thinkTime || 1000;
        let totalResponseTime = 0;

        try {
            while (user.status === 'active' && Date.now() < endTime) {
                if (execution.status === 'stopping' || execution.status === 'stopped') {
                    break;
                }

                try {
                    // Execute request
                    const requestStartTime = Date.now();
                    execution.metrics.requestsSent++;

                    await this.executeRequest(testId, execution.scenarioConfig.requestTemplate);

                    const responseTime = Date.now() - requestStartTime;
                    totalResponseTime += responseTime;
                    user.requestCount++;

                    // Update metrics
                    execution.metrics.requestsCompleted++;
                    execution.metrics.totalResponseTime += responseTime;
                    execution.metrics.minResponseTime = Math.min(execution.metrics.minResponseTime, responseTime);
                    execution.metrics.maxResponseTime = Math.max(execution.metrics.maxResponseTime, responseTime);
                    execution.metrics.responseTimes.push(responseTime);
                } catch (error) {
                    user.errorCount++;
                    execution.metrics.requestsFailed++;

                    const errorType = (error as Error).message || 'Unknown Error';
                    const currentCount = execution.metrics.errors.get(errorType) || 0;
                    execution.metrics.errors.set(errorType, currentCount + 1);
                }

                // Think time between requests
                if (thinkTime > 0 && user.status === 'active') {
                    await this.sleep(thinkTime);
                }
            }
        } finally {
            user.endTime = Date.now();
            user.averageResponseTime = user.requestCount > 0 ? totalResponseTime / user.requestCount : 0;
            user.status = user.status === 'stopping' ? 'completed' : 'completed';
        }
    }

    private async executeRequest(testId: string, requestTemplate?: RequestTemplate): Promise<any> {
        if (!requestTemplate) {
            // Default request for basic load testing
            return await this.sleep(100 + Math.random() * 200); // Simulate 100-300ms response
        }

        // Use API client to execute actual HTTP request
        const response = await this.apiClient.request({
            method: requestTemplate.method,
            url: requestTemplate.url,
            headers: requestTemplate.headers,
            body: requestTemplate.body,
            timeout: requestTemplate.timeout || 30000
        });

        return response;
    }

    private calculatePercentile(values: number[], percentile: number): number {
        if (values.length === 0) return 0;

        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.ceil((percentile / 100) * sorted.length) - 1;
        return sorted[Math.max(0, index)] || 0;
    }

    private async startSystemMonitoring(testId: string): Promise<void> {
        // Initialize system monitoring if needed
        // This would integrate with existing CSPerformanceMonitor
    }

    private async stopSystemMonitoring(testId: string): Promise<void> {
        // Stop system monitoring
    }

    private async getSystemMetrics(testId: string): Promise<SystemMetrics | undefined> {
        // Return system metrics if monitoring is enabled
        return undefined;
    }

    private async waitForVirtualUsersToStop(testId: string): Promise<void> {
        const maxWaitTime = 10000; // 10 seconds
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const virtualUsers = this.virtualUsers.get(testId) || [];
            const activeUsers = virtualUsers.filter(u => u.status === 'active' || u.status === 'stopping');

            if (activeUsers.length === 0) {
                break;
            }

            await this.sleep(100);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get virtual user results for a test
     */
    public getVirtualUserResults(testId: string): VirtualUserResult[] {
        const virtualUsers = this.virtualUsers.get(testId) || [];

        return virtualUsers.map(user => ({
            id: user.id,
            startTime: user.startTime,
            endTime: user.endTime || Date.now(),
            requestCount: user.requestCount,
            successCount: user.requestCount - user.errorCount,
            errorCount: user.errorCount,
            averageResponseTime: user.averageResponseTime,
            totalDataTransferred: 0, // TODO: Implement if needed
            errors: [] // TODO: Collect specific errors if needed
        }));
    }
}

interface LoadTestExecution {
    testId: string;
    scenarioConfig: PerformanceScenarioConfig;
    startTime: number;
    status: 'initializing' | 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';
    virtualUsers: VirtualUser[];
    metrics: {
        requestsSent: number;
        requestsCompleted: number;
        requestsFailed: number;
        totalResponseTime: number;
        minResponseTime: number;
        maxResponseTime: number;
        responseTimes: number[];
        errors: Map<string, number>;
        bytesTransferred: number;
    };
}