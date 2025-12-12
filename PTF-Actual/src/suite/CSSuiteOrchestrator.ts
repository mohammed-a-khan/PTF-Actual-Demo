/**
 * CS Suite Orchestrator - Main engine for multi-project test execution
 * @module suite/CSSuiteOrchestrator
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    SuiteConfig,
    SuiteResult,
    ProjectResult,
    SuiteCLIOptions,
    SuiteProgressCallback,
    SuiteEvent,
    EnvironmentInfo
} from './types/CSSuiteTypes';
import { CSSuiteConfigLoader } from './CSSuiteConfigLoader';
import { CSSuiteExecutor, ProjectExecutionOptions } from './CSSuiteExecutor';

/**
 * Suite orchestration options
 */
export interface SuiteOrchestrationOptions {
    /** Custom config file path */
    configPath?: string;

    /** CLI options */
    cliOptions?: Partial<SuiteCLIOptions>;

    /** Progress callback */
    onProgress?: SuiteProgressCallback;
}

/**
 * Main orchestrator for multi-project test execution
 */
export class CSSuiteOrchestrator {
    private static instance: CSSuiteOrchestrator;
    private configLoader: CSSuiteConfigLoader;
    private executor: CSSuiteExecutor;
    private config: SuiteConfig | null = null;
    private suiteReportPath: string = '';
    private timestamp: string = '';

    private constructor() {
        this.configLoader = CSSuiteConfigLoader.getInstance();
        this.executor = CSSuiteExecutor.getInstance();
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): CSSuiteOrchestrator {
        if (!CSSuiteOrchestrator.instance) {
            CSSuiteOrchestrator.instance = new CSSuiteOrchestrator();
        }
        return CSSuiteOrchestrator.instance;
    }

    /**
     * Run the test suite
     */
    public async run(options: SuiteOrchestrationOptions = {}): Promise<SuiteResult> {
        const startTime = new Date();
        this.timestamp = this.generateTimestamp();

        try {
            // Load configuration FIRST to determine execution mode
            console.log('\nLoading suite configuration...');
            this.config = await this.configLoader.load(options.configPath, options.cliOptions);

            // Get enabled projects
            const enabledProjects = this.config.projects.filter(p => p.enabled);

            // Validate - must have at least one project
            if (enabledProjects.length === 0) {
                throw new Error('No enabled projects found in suite configuration');
            }

            // SMART MODE DETECTION
            if (enabledProjects.length === 1) {
                // Single project - execute in NORMAL mode (no suite overhead)
                console.log('\n');
                console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
                console.log('║                   SINGLE PROJECT DETECTED - NORMAL MODE                      ║');
                console.log('║                         MohammedAKhan Framework                              ║');
                console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
                console.log('');
                console.log(`Suite resolved to single project - executing in NORMAL mode`);
                console.log('(No suite overhead, standard report structure)');
                console.log('');

                return await this.executeSingleProjectNormalMode(enabledProjects[0], options, startTime);
            }

            // Multiple projects - execute in SUITE mode
            console.log('\n');
            console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
            console.log('║                     CS MULTI-PROJECT TEST SUITE                              ║');
            console.log('║                         MohammedAKhan Framework                              ║');
            console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
            console.log('');
            console.log(`Suite has ${enabledProjects.length} projects - executing in SUITE mode`);
            console.log('');

            // Set suite mode flag - this prevents individual project reports from auto-opening
            process.env.CS_SUITE_MODE = 'true';

            // Emit suite start event
            this.emitEvent(options.onProgress, {
                type: 'suite:start',
                timestamp: startTime.toISOString(),
                data: { timestamp: this.timestamp }
            });

            console.log(`  Suite: ${this.config.name}`);
            console.log(`  Projects: ${enabledProjects.length}`);
            console.log(`  Mode: ${this.config.execution.mode}`);
            console.log(`  Stop on Failure: ${this.config.execution.stopOnFailure}`);
            console.log('');

            // Create suite report directory
            this.suiteReportPath = this.createSuiteReportDirectory();
            console.log(`Suite Report Directory: ${this.suiteReportPath}`);
            console.log('');

            // Save suite metadata
            this.saveSuiteMetadata();

            // Execute projects sequentially
            const projectResults = await this.executeProjects(options.onProgress);

            // Calculate suite results
            const endTime = new Date();
            const totalDuration = endTime.getTime() - startTime.getTime();

            const suiteResult = this.buildSuiteResult(
                projectResults,
                startTime.toISOString(),
                endTime.toISOString(),
                totalDuration
            );

            // Generate consolidated report
            if (this.config.reporting.consolidated) {
                await this.generateConsolidatedReport(suiteResult, options.onProgress);
            }

            // Log final summary
            this.logSuiteSummary(suiteResult);

            // Emit suite complete event
            this.emitEvent(options.onProgress, {
                type: 'suite:complete',
                timestamp: endTime.toISOString(),
                data: { result: suiteResult }
            });

            return suiteResult;

        } catch (error: any) {
            console.error(`\nSuite execution failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Execute a single project in NORMAL mode (no suite overhead)
     * This is called when the suite resolves to only 1 enabled project
     */
    private async executeSingleProjectNormalMode(
        project: import('./types/CSSuiteTypes').SuiteProjectConfig,
        options: SuiteOrchestrationOptions,
        startTime: Date
    ): Promise<SuiteResult> {
        // Do NOT set CS_SUITE_MODE - this ensures normal execution behavior
        // Reports will auto-open if configured, no suite directory structure

        console.log(`  Project: ${project.name} (${project.type.toUpperCase()})`);
        console.log(`  Features: ${Array.isArray(project.features) ? project.features.join(', ') : project.features}`);
        if (project.tags) {
            console.log(`  Tags: ${project.tags}`);
        }
        console.log('');

        // Emit suite start event (still needed for consistency)
        this.emitEvent(options.onProgress, {
            type: 'suite:start',
            timestamp: startTime.toISOString(),
            data: { timestamp: this.timestamp, mode: 'normal' }
        });

        // Create standard report directory (not suite directory)
        const baseReportPath = process.env.REPORT_PATH || 'reports';
        this.suiteReportPath = path.join(process.cwd(), baseReportPath, `test-results-${this.timestamp}`);
        fs.mkdirSync(this.suiteReportPath, { recursive: true });

        console.log(`Report Directory: ${this.suiteReportPath}`);
        console.log('');

        // Execute the single project with isMultiProjectMode = false
        const executionOptions: ProjectExecutionOptions = {
            suiteReportPath: this.suiteReportPath,
            defaults: this.config!.defaults,
            onProgress: options.onProgress,
            isMultiProjectMode: false  // IMPORTANT: false for normal mode
        };

        // Use direct path (not nested in project subfolder) for single project
        const result = await this.executor.executeProject(project, {
            ...executionOptions,
            suiteReportPath: path.dirname(this.suiteReportPath)  // Parent dir so project creates test-results-xxx
        });

        const endTime = new Date();
        const totalDuration = endTime.getTime() - startTime.getTime();

        // Build suite result (with single project)
        const suiteResult: SuiteResult = {
            suiteName: this.config!.name,
            timestamp: this.timestamp,
            status: result.status === 'passed' ? 'passed' : 'failed',
            totalDuration,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            projects: [result],
            totalProjects: 1,
            passedProjects: result.status === 'passed' ? 1 : 0,
            failedProjects: result.status === 'failed' ? 1 : 0,
            skippedProjects: result.status === 'skipped' ? 1 : 0,
            totalScenarios: result.totalScenarios,
            passedScenarios: result.passedScenarios,
            failedScenarios: result.failedScenarios,
            skippedScenarios: result.skippedScenarios,
            successRate: result.totalScenarios > 0
                ? Math.round((result.passedScenarios / result.totalScenarios) * 10000) / 100
                : 0,
            reportPath: result.reportPath,
            consolidatedReportPath: result.htmlReportPath,
            environment: this.getEnvironmentInfo()
        };

        // NOTE: Do NOT open report here - the individual project execution already handles
        // auto-open since CS_SUITE_MODE is not set. Opening here would cause duplicate opens.

        // Log summary
        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
        console.log('║                         EXECUTION SUMMARY (NORMAL MODE)                      ║');
        console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
        const statusIcon = result.status === 'passed' ? '✓' : '✗';
        console.log(`║  ${statusIcon} ${project.name.padEnd(40)} ${result.status.toUpperCase().padEnd(20)}      ║`);
        console.log(`║    Scenarios: ${result.passedScenarios} passed, ${result.failedScenarios} failed, ${result.skippedScenarios} skipped`.padEnd(76) + '  ║');
        console.log(`║    Duration: ${this.formatDuration(totalDuration)}`.padEnd(78) + '║');
        console.log(`║    Report: ${result.htmlReportPath || result.reportPath}`.slice(0, 78).padEnd(78) + '║');
        console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
        console.log('');

        // Emit suite complete event
        this.emitEvent(options.onProgress, {
            type: 'suite:complete',
            timestamp: endTime.toISOString(),
            data: { result: suiteResult, mode: 'normal' }
        });

        return suiteResult;
    }

    /**
     * Execute all projects sequentially
     */
    private async executeProjects(onProgress?: SuiteProgressCallback): Promise<ProjectResult[]> {
        if (!this.config) {
            throw new Error('Suite configuration not loaded');
        }

        const results: ProjectResult[] = [];
        const enabledProjects = this.config.projects.filter(p => p.enabled);

        console.log(`\nExecuting ${enabledProjects.length} project(s)...\n`);

        for (let i = 0; i < enabledProjects.length; i++) {
            const project = enabledProjects[i];

            console.log(`[${i + 1}/${enabledProjects.length}] ${project.name}`);

            const executionOptions: ProjectExecutionOptions = {
                suiteReportPath: this.suiteReportPath,
                defaults: this.config.defaults,
                onProgress,
                isMultiProjectMode: true
            };

            const result = await this.executor.executeProject(project, executionOptions);
            results.push(result);

            // Check stop on failure
            if (this.config.execution.stopOnFailure && result.status === 'failed') {
                console.log('\nStopping suite execution due to project failure (stopOnFailure=true)');
                break;
            }

            // Add delay between projects
            if (i < enabledProjects.length - 1 && this.config.execution.delayBetweenProjects > 0) {
                console.log(`\nWaiting ${this.config.execution.delayBetweenProjects}ms before next project...`);
                await this.delay(this.config.execution.delayBetweenProjects);
            }
        }

        return results;
    }

    /**
     * Build suite result from project results
     */
    private buildSuiteResult(
        projectResults: ProjectResult[],
        startTime: string,
        endTime: string,
        totalDuration: number
    ): SuiteResult {
        // Calculate totals
        let totalScenarios = 0;
        let passedScenarios = 0;
        let failedScenarios = 0;
        let skippedScenarios = 0;

        for (const project of projectResults) {
            totalScenarios += project.totalScenarios;
            passedScenarios += project.passedScenarios;
            failedScenarios += project.failedScenarios;
            skippedScenarios += project.skippedScenarios;
        }

        const passedProjects = projectResults.filter(p => p.status === 'passed').length;
        const failedProjects = projectResults.filter(p => p.status === 'failed').length;
        const skippedProjects = projectResults.filter(p => p.status === 'skipped').length;

        // Determine overall status (excluding skipped projects from calculation)
        const executedProjects = passedProjects + failedProjects;
        let status: 'passed' | 'failed' | 'partial' = 'passed';
        if (executedProjects === 0) {
            // All projects were skipped
            status = 'failed';
        } else if (failedProjects === executedProjects) {
            // All executed projects failed
            status = 'failed';
        } else if (failedProjects > 0) {
            // Some executed projects failed, some passed
            status = 'partial';
        }
        // else: all executed projects passed → status remains 'passed'

        const successRate = totalScenarios > 0
            ? Math.round((passedScenarios / totalScenarios) * 10000) / 100
            : 0;

        return {
            suiteName: this.config!.name,
            timestamp: this.timestamp,
            status,
            totalDuration,
            startTime,
            endTime,
            projects: projectResults,
            totalProjects: projectResults.length,
            passedProjects,
            failedProjects,
            skippedProjects,
            totalScenarios,
            passedScenarios,
            failedScenarios,
            skippedScenarios,
            successRate,
            reportPath: this.suiteReportPath,
            environment: this.getEnvironmentInfo()
        };
    }

    /**
     * Generate consolidated report
     */
    private async generateConsolidatedReport(
        suiteResult: SuiteResult,
        onProgress?: SuiteProgressCallback
    ): Promise<void> {
        this.emitEvent(onProgress, {
            type: 'report:generating',
            timestamp: new Date().toISOString(),
            data: { reportPath: this.suiteReportPath }
        });

        console.log('\n');
        console.log('Generating consolidated report...');

        try {
            // Lazy load the report generator
            const { CSConsolidatedReportGenerator } = await import('./CSConsolidatedReportGenerator');

            const reportPath = await CSConsolidatedReportGenerator.generateReport(
                suiteResult,
                this.suiteReportPath
            );

            suiteResult.consolidatedReportPath = reportPath;

            console.log(`Consolidated report: ${reportPath}`);

            // Auto-open report if configured
            if (this.config?.reporting.autoOpen) {
                this.openReport(reportPath);
            }

            this.emitEvent(onProgress, {
                type: 'report:complete',
                timestamp: new Date().toISOString(),
                data: { reportPath }
            });

        } catch (error: any) {
            console.error(`Failed to generate consolidated report: ${error.message}`);
        }
    }

    /**
     * Create suite report directory
     */
    private createSuiteReportDirectory(): string {
        const baseReportPath = process.env.REPORT_PATH || 'reports';
        const suitePath = path.join(process.cwd(), baseReportPath, `test-results-${this.timestamp}`);

        fs.mkdirSync(suitePath, { recursive: true });

        return suitePath;
    }

    /**
     * Save suite metadata
     */
    private saveSuiteMetadata(): void {
        const metadata = {
            suiteName: this.config!.name,
            timestamp: this.timestamp,
            startTime: new Date().toISOString(),
            configPath: this.configLoader.getConfigPath(),
            projects: this.config!.projects.map(p => ({
                name: p.name,
                project: p.project,
                type: p.type,
                enabled: p.enabled
            })),
            execution: this.config!.execution,
            defaults: this.config!.defaults,
            environment: this.getEnvironmentInfo()
        };

        const metadataPath = path.join(this.suiteReportPath, 'suite-metadata.json');
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    }

    /**
     * Get environment information
     */
    private getEnvironmentInfo(): EnvironmentInfo {
        let frameworkVersion = '1.0.0';
        let playwrightVersion = 'unknown';

        try {
            const packageJson = require('../../package.json');
            frameworkVersion = packageJson.version;
            playwrightVersion = packageJson.dependencies['@playwright/test'] || 'unknown';
        } catch {
            // Ignore
        }

        return {
            nodeVersion: process.version,
            os: os.platform(),
            osVersion: os.release(),
            frameworkVersion,
            playwrightVersion,
            hostname: os.hostname(),
            username: os.userInfo().username
        };
    }

    /**
     * Log suite summary
     */
    private logSuiteSummary(result: SuiteResult): void {
        console.log('\n');
        console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
        console.log('║                          SUITE EXECUTION SUMMARY                             ║');
        console.log('╠══════════════════════════════════════════════════════════════════════════════╣');

        // Status banner
        const statusBanner = result.status === 'passed'
            ? '                              ✓ ALL PASSED                                      '
            : result.status === 'partial'
            ? '                            ⚠ PARTIAL SUCCESS                                  '
            : '                              ✗ FAILED                                         ';
        console.log(`║${statusBanner}║`);

        console.log('╠══════════════════════════════════════════════════════════════════════════════╣');

        // Projects summary
        console.log('║  PROJECTS                                                                    ║');
        console.log(`║    Total: ${result.totalProjects.toString().padEnd(5)} Passed: ${result.passedProjects.toString().padEnd(5)} Failed: ${result.failedProjects.toString().padEnd(5)} Skipped: ${result.skippedProjects.toString().padEnd(5)}      ║`);

        console.log('║                                                                              ║');

        // Scenarios summary
        console.log('║  SCENARIOS                                                                   ║');
        console.log(`║    Total: ${result.totalScenarios.toString().padEnd(5)} Passed: ${result.passedScenarios.toString().padEnd(5)} Failed: ${result.failedScenarios.toString().padEnd(5)} Skipped: ${result.skippedScenarios.toString().padEnd(5)}      ║`);

        console.log('║                                                                              ║');

        // Success rate and duration
        console.log(`║  Success Rate: ${result.successRate.toFixed(2)}%                                                       ║`.slice(0, 81) + '║');
        console.log(`║  Duration: ${this.formatDuration(result.totalDuration)}                                                           ║`.slice(0, 81) + '║');

        console.log('╠══════════════════════════════════════════════════════════════════════════════╣');

        // Project details
        console.log('║  PROJECT RESULTS                                                             ║');
        for (const project of result.projects) {
            const icon = project.status === 'passed' ? '✓' : project.status === 'failed' ? '✗' : '○';
            const line = `║    ${icon} ${project.name.padEnd(20)} ${project.status.toUpperCase().padEnd(10)} ${project.passedScenarios}/${project.totalScenarios} scenarios    ${this.formatDuration(project.duration).padEnd(10)}║`;
            console.log(line.slice(0, 81) + '║');
        }

        console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
        console.log(`║  Report: ${result.reportPath.slice(0, 66).padEnd(68)}║`);
        console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
        console.log('');
    }

    /**
     * Open report in browser (works on Windows, macOS, Linux)
     */
    private openReport(reportPath: string): void {
        try {
            const { spawn } = require('child_process');

            // Normalize path for the platform
            const normalizedPath = path.resolve(reportPath);

            console.log(`Opening report: ${normalizedPath}`);

            if (process.platform === 'win32') {
                // Windows: use 'start' command via cmd.exe
                // The empty string '' is required as the window title
                spawn('cmd.exe', ['/c', 'start', '""', normalizedPath], {
                    detached: true,
                    stdio: 'ignore',
                    shell: true
                }).unref();
            } else if (process.platform === 'darwin') {
                // macOS: use 'open' command
                spawn('open', [normalizedPath], {
                    detached: true,
                    stdio: 'ignore'
                }).unref();
            } else {
                // Linux: use 'xdg-open' command
                spawn('xdg-open', [normalizedPath], {
                    detached: true,
                    stdio: 'ignore'
                }).unref();
            }
        } catch (error: any) {
            console.log(`Note: Could not auto-open report. Open manually: ${reportPath}`);
            console.log(`Error: ${error.message}`);
        }
    }

    /**
     * Generate timestamp string
     */
    private generateTimestamp(): string {
        const now = new Date();
        return now.toISOString()
            .replace(/T/, '_')
            .replace(/:/g, '-')
            .replace(/\..+/, '');
    }

    /**
     * Format duration
     */
    private formatDuration(ms: number): string {
        if (ms < 1000) {
            return `${ms}ms`;
        } else if (ms < 60000) {
            return `${(ms / 1000).toFixed(1)}s`;
        } else {
            const minutes = Math.floor(ms / 60000);
            const seconds = Math.floor((ms % 60000) / 1000);
            return `${minutes}m ${seconds}s`;
        }
    }

    /**
     * Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Emit progress event
     */
    private emitEvent(callback: SuiteProgressCallback | undefined, event: SuiteEvent): void {
        if (callback) {
            try {
                callback(event);
            } catch {
                // Ignore callback errors
            }
        }
    }

    /**
     * Get current configuration
     */
    public getConfig(): SuiteConfig | null {
        return this.config;
    }

    /**
     * Get suite report path
     */
    public getSuiteReportPath(): string {
        return this.suiteReportPath;
    }
}

export default CSSuiteOrchestrator;
