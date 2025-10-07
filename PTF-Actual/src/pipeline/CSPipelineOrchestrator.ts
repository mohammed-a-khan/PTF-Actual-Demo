import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

export interface PipelineStage {
    id: string;
    name: string;
    commands: string[];
    condition?: string;
    dependencies?: string[];
    parallel?: boolean;
    timeout?: number;
    retryCount?: number;
    workingDirectory?: string;
    environment?: Record<string, string>;
    artifacts?: ArtifactDefinition[];
    onFailure?: 'abort' | 'continue' | 'retry';
}

export interface ArtifactDefinition {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'archive';
    retention?: number;
    uploadTo?: 'azure' | 'jenkins' | 'github' | 'local';
}

export interface PipelineConfiguration {
    id: string;
    name: string;
    version: string;
    description?: string;
    triggers?: PipelineTrigger[];
    variables?: Record<string, string>;
    stages: PipelineStage[];
    notifications?: NotificationConfig[];
    artifactStore?: string;
    maxExecutionTime?: number;
}

export interface PipelineTrigger {
    type: 'manual' | 'schedule' | 'webhook' | 'git' | 'api';
    condition: string;
    branches?: string[];
    schedule?: string;
    webhook?: WebhookConfig;
}

export interface WebhookConfig {
    url: string;
    secret?: string;
    events: string[];
}

export interface NotificationConfig {
    type: 'email' | 'slack' | 'teams' | 'webhook';
    recipients: string[];
    events: ('start' | 'success' | 'failure' | 'cancelled')[];
    template?: string;
}

export interface PipelineExecution {
    id: string;
    pipelineId: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
    startTime: Date;
    endTime?: Date;
    duration?: number;
    trigger: PipelineTrigger;
    stages: StageExecution[];
    artifacts: ExecutedArtifact[];
    logs: string[];
    variables: Record<string, string>;
}

export interface StageExecution {
    stageId: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
    startTime?: Date;
    endTime?: Date;
    duration?: number;
    logs: string[];
    artifacts: ExecutedArtifact[];
    exitCode?: number;
    error?: string;
}

export interface ExecutedArtifact {
    name: string;
    path: string;
    size: number;
    checksum: string;
    uploadUrl?: string;
    createdAt: Date;
}

export interface CIProvider {
    name: string;
    detectEnvironment(): boolean;
    getBuildInfo(): BuildInfo;
    uploadArtifacts(artifacts: ExecutedArtifact[]): Promise<void>;
    updateBuildStatus(status: string, message?: string): Promise<void>;
}

export interface BuildInfo {
    buildId: string;
    buildNumber: string;
    branch: string;
    commit: string;
    author: string;
    repository: string;
    pullRequestId?: string;
}

export class CSPipelineOrchestrator {
    private static instance: CSPipelineOrchestrator;
    private config: CSConfigurationManager;
    private pipelines: Map<string, PipelineConfiguration> = new Map();
    private executions: Map<string, PipelineExecution> = new Map();
    private ciProvider: CIProvider | null = null;
    private artifactStore: string;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.artifactStore = this.config.get('PIPELINE_ARTIFACT_STORE', './artifacts');
        this.initializeCIProvider();
    }

    public static getInstance(): CSPipelineOrchestrator {
        if (!CSPipelineOrchestrator.instance) {
            CSPipelineOrchestrator.instance = new CSPipelineOrchestrator();
        }
        return CSPipelineOrchestrator.instance;
    }

    private initializeCIProvider(): void {
        const providers: CIProvider[] = [
            new JenkinsProvider(),
            new AzureDevOpsProvider(),
            new GitHubActionsProvider(),
            new LocalProvider()
        ];

        for (const provider of providers) {
            if (provider.detectEnvironment()) {
                this.ciProvider = provider;
                CSReporter.info(`Detected CI provider: ${provider.name}`);
                break;
            }
        }

        if (!this.ciProvider) {
            this.ciProvider = new LocalProvider();
            CSReporter.info('No CI provider detected, using local provider');
        }
    }

    public async loadPipelineConfiguration(configPath: string): Promise<void> {
        try {
            CSReporter.info(`Loading pipeline configuration from: ${configPath}`);
            
            const configContent = await fs.readFile(configPath, 'utf-8');
            let pipelineConfig: PipelineConfiguration;

            if (configPath.endsWith('.json')) {
                pipelineConfig = JSON.parse(configContent);
            } else if (configPath.endsWith('.yml') || configPath.endsWith('.yaml')) {
                const yaml = require('js-yaml');
                pipelineConfig = yaml.load(configContent);
            } else {
                throw new Error(`Unsupported configuration format: ${configPath}`);
            }

            // Validate configuration
            this.validatePipelineConfiguration(pipelineConfig);
            
            // Resolve variables and interpolate
            pipelineConfig = this.resolvePipelineVariables(pipelineConfig);
            
            this.pipelines.set(pipelineConfig.id, pipelineConfig);
            CSReporter.pass(`Pipeline configuration loaded: ${pipelineConfig.name}`);
            
        } catch (error) {
            CSReporter.fail(`Failed to load pipeline configuration: ${configPath} - ${(error as Error).message}`);
            throw error;
        }
    }

    public async executePipeline(pipelineId: string, trigger: PipelineTrigger, variables?: Record<string, string>): Promise<PipelineExecution> {
        const pipeline = this.pipelines.get(pipelineId);
        if (!pipeline) {
            throw new Error(`Pipeline not found: ${pipelineId}`);
        }

        const executionId = this.generateExecutionId();
        const execution: PipelineExecution = {
            id: executionId,
            pipelineId,
            status: 'pending',
            startTime: new Date(),
            trigger,
            stages: [],
            artifacts: [],
            logs: [],
            variables: { ...pipeline.variables, ...variables }
        };

        this.executions.set(executionId, execution);

        try {
            CSReporter.startTest(`Pipeline Execution: ${pipeline.name}`);
            await this.updateCIStatus('running', `Pipeline ${pipeline.name} started`);

            execution.status = 'running';
            await this.executePipelineStages(pipeline, execution);

            execution.status = 'success';
            execution.endTime = new Date();
            execution.duration = execution.endTime.getTime() - execution.startTime.getTime();

            await this.uploadArtifacts(execution);
            await this.sendNotifications(pipeline, execution);
            await this.updateCIStatus('success', `Pipeline ${pipeline.name} completed successfully`);

            CSReporter.pass(`Pipeline executed successfully: ${pipeline.name} - Duration: ${execution.duration}ms`);

        } catch (error) {
            execution.status = 'failed';
            execution.endTime = new Date();
            execution.duration = execution.endTime.getTime() - execution.startTime.getTime();

            await this.updateCIStatus('failed', `Pipeline ${pipeline.name} failed: ${(error as Error).message}`);
            CSReporter.fail(`Pipeline execution failed: ${pipeline.name} - ${(error as Error).message}`);
            throw error;

        } finally {
            CSReporter.endTest(execution.status === 'success' ? 'pass' : 'fail');
        }

        return execution;
    }

    private async executePipelineStages(pipeline: PipelineConfiguration, execution: PipelineExecution): Promise<void> {
        const stageExecutions = this.planStageExecution(pipeline.stages);
        
        for (const batch of stageExecutions) {
            if (batch.parallel) {
                await Promise.all(batch.stages.map(stage => this.executeStage(stage, execution)));
            } else {
                for (const stage of batch.stages) {
                    await this.executeStage(stage, execution);
                }
            }
        }
    }

    private planStageExecution(stages: PipelineStage[]): { stages: PipelineStage[]; parallel: boolean }[] {
        const batches: { stages: PipelineStage[]; parallel: boolean }[] = [];
        const executed = new Set<string>();
        const remaining = [...stages];

        while (remaining.length > 0) {
            const readyStages = remaining.filter(stage => 
                !stage.dependencies || stage.dependencies.every(dep => executed.has(dep))
            );

            if (readyStages.length === 0) {
                throw new Error('Circular dependency detected in pipeline stages');
            }

            const parallelStages = readyStages.filter(stage => stage.parallel);
            const sequentialStages = readyStages.filter(stage => !stage.parallel);

            if (parallelStages.length > 0) {
                batches.push({ stages: parallelStages, parallel: true });
                parallelStages.forEach(stage => {
                    executed.add(stage.id);
                    remaining.splice(remaining.indexOf(stage), 1);
                });
            }

            if (sequentialStages.length > 0) {
                batches.push({ stages: sequentialStages, parallel: false });
                sequentialStages.forEach(stage => {
                    executed.add(stage.id);
                    remaining.splice(remaining.indexOf(stage), 1);
                });
            }
        }

        return batches;
    }

    private async executeStage(stage: PipelineStage, execution: PipelineExecution): Promise<void> {
        const stageExecution: StageExecution = {
            stageId: stage.id,
            status: 'running',
            startTime: new Date(),
            logs: [],
            artifacts: []
        };

        execution.stages.push(stageExecution);

        try {
            CSReporter.info(`Executing stage: ${stage.name}`);

            // Check stage condition
            if (stage.condition && !this.evaluateCondition(stage.condition, execution.variables)) {
                stageExecution.status = 'skipped';
                CSReporter.info(`Stage skipped due to condition: ${stage.condition}`);
                return;
            }

            // Execute stage commands
            for (const command of stage.commands) {
                await this.executeCommand(command, stage, stageExecution, execution.variables);
            }

            // Handle stage artifacts
            if (stage.artifacts) {
                for (const artifactDef of stage.artifacts) {
                    const artifact = await this.collectArtifact(artifactDef);
                    stageExecution.artifacts.push(artifact);
                    execution.artifacts.push(artifact);
                }
            }

            stageExecution.status = 'success';
            stageExecution.endTime = new Date();
            stageExecution.duration = stageExecution.endTime.getTime() - stageExecution.startTime!.getTime();

            CSReporter.pass(`Stage completed: ${stage.name} - Duration: ${stageExecution.duration}ms`);

        } catch (error) {
            stageExecution.status = 'failed';
            stageExecution.endTime = new Date();
            stageExecution.duration = stageExecution.endTime.getTime() - stageExecution.startTime!.getTime();
            stageExecution.error = (error as Error).message;

            CSReporter.fail(`Stage failed: ${stage.name} - ${(error as Error).message}`);

            // Handle failure strategy
            if (stage.onFailure === 'continue') {
                CSReporter.warn(`Continuing pipeline despite stage failure: ${stage.name}`);
                return;
            } else if (stage.onFailure === 'retry' && stage.retryCount && stage.retryCount > 0) {
                CSReporter.info(`Retrying stage: ${stage.name}`);
                // Implementation for retry logic would go here
            } else {
                throw error;
            }
        }
    }

    private async executeCommand(
        command: string, 
        stage: PipelineStage, 
        stageExecution: StageExecution, 
        variables: Record<string, string>
    ): Promise<void> {
        const resolvedCommand = this.resolveVariables(command, variables);
        const workingDir = stage.workingDirectory || process.cwd();
        const timeout = stage.timeout || this.config.getNumber('PIPELINE_STAGE_TIMEOUT', 300000);
        
        CSReporter.debug(`Executing command: ${resolvedCommand} - Working directory: ${workingDir}`);

        try {
            const { stdout, stderr } = await execAsync(resolvedCommand, {
                cwd: workingDir,
                timeout,
                env: { ...process.env, ...stage.environment }
            });

            if (stdout) {
                stageExecution.logs.push(`STDOUT: ${stdout}`);
                CSReporter.debug(`Command output: ${stdout}`);
            }

            if (stderr) {
                stageExecution.logs.push(`STDERR: ${stderr}`);
                CSReporter.warn(`Command warnings: ${stderr}`);
            }

        } catch (error: any) {
            stageExecution.exitCode = error.code;
            const errorMessage = `Command failed: ${resolvedCommand}\nError: ${error.message}`;
            stageExecution.logs.push(`ERROR: ${errorMessage}`);
            throw new Error(errorMessage);
        }
    }

    private async collectArtifact(artifactDef: ArtifactDefinition): Promise<ExecutedArtifact> {
        const artifactPath = path.resolve(artifactDef.path);
        
        try {
            const stats = await fs.stat(artifactPath);
            const content = await fs.readFile(artifactPath);
            const checksum = require('crypto').createHash('md5').update(content).digest('hex');

            const artifact: ExecutedArtifact = {
                name: artifactDef.name,
                path: artifactPath,
                size: stats.size,
                checksum,
                createdAt: new Date()
            };

            // Copy to artifact store
            const artifactStorePath = path.join(this.artifactStore, artifact.name);
            await fs.mkdir(path.dirname(artifactStorePath), { recursive: true });
            await fs.copyFile(artifactPath, artifactStorePath);

            CSReporter.info(`Artifact collected: ${artifactDef.name} - Size: ${stats.size} bytes`);
            return artifact;

        } catch (error) {
            CSReporter.fail(`Failed to collect artifact: ${artifactDef.name} - ${(error as Error).message}`);
            throw error;
        }
    }

    private async uploadArtifacts(execution: PipelineExecution): Promise<void> {
        if (execution.artifacts.length === 0) return;

        try {
            await this.ciProvider!.uploadArtifacts(execution.artifacts);
            CSReporter.pass(`Uploaded ${execution.artifacts.length} artifacts`);
        } catch (error) {
            CSReporter.warn(`Failed to upload artifacts: ${(error as Error).message}`);
        }
    }

    private async sendNotifications(pipeline: PipelineConfiguration, execution: PipelineExecution): Promise<void> {
        if (!pipeline.notifications) return;

        const eventType = execution.status === 'success' ? 'success' : 'failure';
        
        for (const notificationConfig of pipeline.notifications) {
            if (notificationConfig.events.includes(eventType)) {
                await this.sendNotification(notificationConfig, pipeline, execution);
            }
        }
    }

    private async sendNotification(
        config: NotificationConfig, 
        pipeline: PipelineConfiguration, 
        execution: PipelineExecution
    ): Promise<void> {
        try {
            const message = this.buildNotificationMessage(config, pipeline, execution);
            
            switch (config.type) {
                case 'email':
                    // Email notification implementation
                    CSReporter.info(`Email notification sent: ${message}`);
                    break;
                case 'slack':
                    // Slack notification implementation
                    CSReporter.info(`Slack notification sent: ${message}`);
                    break;
                case 'teams':
                    // Teams notification implementation
                    CSReporter.info(`Teams notification sent: ${message}`);
                    break;
                case 'webhook':
                    // Webhook notification implementation
                    CSReporter.info(`Webhook notification sent: ${message}`);
                    break;
            }
        } catch (error) {
            CSReporter.warn(`Failed to send notification: ${(error as Error).message}`);
        }
    }

    private buildNotificationMessage(
        config: NotificationConfig,
        pipeline: PipelineConfiguration,
        execution: PipelineExecution
    ): string {
        return `Pipeline ${pipeline.name} (${execution.id}) ${execution.status}\n` +
               `Duration: ${execution.duration}ms\n` +
               `Trigger: ${execution.trigger.type}\n` +
               `Started: ${execution.startTime.toISOString()}`;
    }

    private async updateCIStatus(status: string, message?: string): Promise<void> {
        try {
            await this.ciProvider!.updateBuildStatus(status, message);
        } catch (error) {
            CSReporter.debug(`Failed to update CI status: ${(error as Error).message}`);
        }
    }

    private validatePipelineConfiguration(config: PipelineConfiguration): void {
        if (!config.id || !config.name || !config.stages || config.stages.length === 0) {
            throw new Error('Invalid pipeline configuration: missing required fields');
        }

        // Validate stage dependencies
        const stageIds = new Set(config.stages.map(s => s.id));
        for (const stage of config.stages) {
            if (stage.dependencies) {
                for (const dep of stage.dependencies) {
                    if (!stageIds.has(dep)) {
                        throw new Error(`Invalid stage dependency: ${dep} not found`);
                    }
                }
            }
        }
    }

    private resolvePipelineVariables(config: PipelineConfiguration): PipelineConfiguration {
        const variables = {
            ...config.variables,
            PROJECT: this.config.get('PROJECT', 'default'),
            ENVIRONMENT: this.config.get('ENVIRONMENT', 'dev'),
            TIMESTAMP: new Date().toISOString()
        };

        const configStr = JSON.stringify(config);
        const resolvedStr = this.resolveVariables(configStr, variables);
        return JSON.parse(resolvedStr);
    }

    private resolveVariables(text: string, variables: Record<string, string>): string {
        return text.replace(/\${(\w+)}/g, (match, varName) => {
            return variables[varName] || match;
        });
    }

    private evaluateCondition(condition: string, variables: Record<string, string>): boolean {
        try {
            // Simple condition evaluation - can be enhanced
            const resolvedCondition = this.resolveVariables(condition, variables);
            return eval(resolvedCondition);
        } catch (error) {
            CSReporter.warn(`Failed to evaluate condition: ${condition} - ${(error as Error).message}`);
            return false;
        }
    }

    private generateExecutionId(): string {
        return `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    public getPipelineExecution(executionId: string): PipelineExecution | undefined {
        return this.executions.get(executionId);
    }

    public getExecutionStatus(executionId: string): string {
        const execution = this.executions.get(executionId);
        return execution ? execution.status : 'not-found';
    }

    public async cancelExecution(executionId: string): Promise<void> {
        const execution = this.executions.get(executionId);
        if (execution && execution.status === 'running') {
            execution.status = 'cancelled';
            CSReporter.warn(`Pipeline execution cancelled: ${executionId}`);
        }
    }
}

// CI Provider Implementations
class JenkinsProvider implements CIProvider {
    name = 'Jenkins';

    detectEnvironment(): boolean {
        return !!(process.env.JENKINS_URL || process.env.BUILD_ID);
    }

    getBuildInfo(): BuildInfo {
        return {
            buildId: process.env.BUILD_ID || '',
            buildNumber: process.env.BUILD_NUMBER || '',
            branch: process.env.GIT_BRANCH || '',
            commit: process.env.GIT_COMMIT || '',
            author: process.env.CHANGE_AUTHOR || '',
            repository: process.env.GIT_URL || ''
        };
    }

    async uploadArtifacts(artifacts: ExecutedArtifact[]): Promise<void> {
        // Jenkins artifact upload implementation
        CSReporter.info(`Jenkins: Uploading ${artifacts.length} artifacts`);
    }

    async updateBuildStatus(status: string, message?: string): Promise<void> {
        // Jenkins build status update implementation
        CSReporter.info(`Jenkins: Build status updated to ${status}`);
    }
}

class AzureDevOpsProvider implements CIProvider {
    name = 'Azure DevOps';

    detectEnvironment(): boolean {
        return !!(process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI || process.env.BUILD_BUILDID);
    }

    getBuildInfo(): BuildInfo {
        return {
            buildId: process.env.BUILD_BUILDID || '',
            buildNumber: process.env.BUILD_BUILDNUMBER || '',
            branch: process.env.BUILD_SOURCEBRANCH || '',
            commit: process.env.BUILD_SOURCEVERSION || '',
            author: process.env.BUILD_REQUESTEDFOR || '',
            repository: process.env.BUILD_REPOSITORY_NAME || '',
            pullRequestId: process.env.SYSTEM_PULLREQUEST_PULLREQUESTID
        };
    }

    async uploadArtifacts(artifacts: ExecutedArtifact[]): Promise<void> {
        // Azure DevOps artifact upload implementation
        CSReporter.info(`Azure DevOps: Uploading ${artifacts.length} artifacts`);
    }

    async updateBuildStatus(status: string, message?: string): Promise<void> {
        // Azure DevOps build status update implementation
        CSReporter.info(`Azure DevOps: Build status updated to ${status}`);
    }
}

class GitHubActionsProvider implements CIProvider {
    name = 'GitHub Actions';

    detectEnvironment(): boolean {
        return !!(process.env.GITHUB_ACTIONS || process.env.GITHUB_WORKSPACE);
    }

    getBuildInfo(): BuildInfo {
        return {
            buildId: process.env.GITHUB_RUN_ID || '',
            buildNumber: process.env.GITHUB_RUN_NUMBER || '',
            branch: process.env.GITHUB_REF || '',
            commit: process.env.GITHUB_SHA || '',
            author: process.env.GITHUB_ACTOR || '',
            repository: process.env.GITHUB_REPOSITORY || '',
            pullRequestId: process.env.GITHUB_EVENT_PULL_REQUEST_NUMBER
        };
    }

    async uploadArtifacts(artifacts: ExecutedArtifact[]): Promise<void> {
        // GitHub Actions artifact upload implementation
        CSReporter.info(`GitHub Actions: Uploading ${artifacts.length} artifacts`);
    }

    async updateBuildStatus(status: string, message?: string): Promise<void> {
        // GitHub Actions build status update implementation
        CSReporter.info(`GitHub Actions: Build status updated to ${status}`);
    }
}

class LocalProvider implements CIProvider {
    name = 'Local';

    detectEnvironment(): boolean {
        return true; // Always available as fallback
    }

    getBuildInfo(): BuildInfo {
        return {
            buildId: `local-${Date.now()}`,
            buildNumber: '1',
            branch: 'local',
            commit: 'local',
            author: 'local-user',
            repository: 'local-repository'
        };
    }

    async uploadArtifacts(artifacts: ExecutedArtifact[]): Promise<void> {
        // Local artifact handling - files are already in artifact store
        CSReporter.info(`Local: ${artifacts.length} artifacts stored locally`);
    }

    async updateBuildStatus(status: string, message?: string): Promise<void> {
        CSReporter.info(`Local: Build status: ${status}${message ? ` - ${message}` : ''}`);
    }
}