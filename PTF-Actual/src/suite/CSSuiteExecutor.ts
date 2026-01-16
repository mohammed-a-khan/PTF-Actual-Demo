/**
 * CS Suite Executor - Executes individual projects within a suite
 * @module suite/CSSuiteExecutor
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import {
    SuiteProjectConfig,
    ProjectResult,
    ScenarioResult,
    ProjectStatus,
    SuiteDefaults,
    SuiteEvent,
    SuiteProgressCallback
} from './types/CSSuiteTypes';

/**
 * Project execution options
 */
export interface ProjectExecutionOptions {
    /** Suite report base path */
    suiteReportPath: string;

    /** Suite defaults */
    defaults: SuiteDefaults;

    /** Progress callback */
    onProgress?: SuiteProgressCallback;

    /** Whether this is multi-project mode */
    isMultiProjectMode: boolean;
}

/**
 * Executes individual projects within a test suite
 */
export class CSSuiteExecutor {
    private static instance: CSSuiteExecutor;

    private constructor() {}

    /**
     * Get singleton instance
     */
    public static getInstance(): CSSuiteExecutor {
        if (!CSSuiteExecutor.instance) {
            CSSuiteExecutor.instance = new CSSuiteExecutor();
        }
        return CSSuiteExecutor.instance;
    }

    /**
     * Execute a single project
     */
    public async executeProject(
        project: SuiteProjectConfig,
        options: ProjectExecutionOptions
    ): Promise<ProjectResult> {
        const startTime = new Date();
        const startTimestamp = startTime.toISOString();

        // Emit project start event
        this.emitEvent(options.onProgress, {
            type: 'project:start',
            timestamp: startTimestamp,
            data: { projectName: project.name, projectType: project.type }
        });

        console.log(`\n${'='.repeat(80)}`);
        console.log(`  Starting Project: ${project.name} (${project.type.toUpperCase()})`);
        console.log(`${'='.repeat(80)}`);

        // Determine project report path
        // In multi-project mode: create subfolder per project using display NAME (not project id)
        // This allows same project to run with different configs (e.g., different browsers)
        // e.g., reports/suite-xxx/Akhan-Chrome/, reports/suite-xxx/Akhan-Firefox/
        // In single project (normal) mode: use standard path (e.g., reports/test-results-xxx/)
        const sanitizedName = project.name.replace(/[<>:"/\\|?*]/g, '-');  // Remove invalid path chars
        const projectReportPath = options.isMultiProjectMode
            ? path.join(options.suiteReportPath, sanitizedName)
            : options.suiteReportPath;

        // Build command arguments
        const args = this.buildCommandArgs(project, options, projectReportPath);

        console.log(`  Command: npx cs-playwright-test ${args.join(' ')}`);
        console.log(`  Report Path: ${projectReportPath}`);
        console.log(`${'─'.repeat(80)}`);

        let exitCode = 0;
        let error: string | undefined;

        try {
            // Execute the project
            exitCode = await this.runProcess(args, project, options);
        } catch (err: any) {
            exitCode = 1;
            error = err.message;
            console.error(`  Error executing ${project.name}: ${err.message}`);
        }

        const endTime = new Date();
        const duration = endTime.getTime() - startTime.getTime();

        // Parse project results from report-data.json
        const scenarioResults = this.parseProjectResults(projectReportPath);

        // Calculate statistics
        const passedScenarios = scenarioResults.filter(s => s.status === 'passed').length;
        const failedScenarios = scenarioResults.filter(s => s.status === 'failed').length;
        const skippedScenarios = scenarioResults.filter(s => s.status === 'skipped').length;

        // Determine project status
        let status: ProjectStatus = 'passed';
        if (exitCode !== 0 || failedScenarios > 0) {
            status = 'failed';
        } else if (error) {
            status = 'error';
        } else if (scenarioResults.length === 0) {
            status = 'skipped';
        }

        const result: ProjectResult = {
            name: project.name,
            project: project.project,
            type: project.type,
            status,
            duration,
            startTime: startTimestamp,
            endTime: endTime.toISOString(),
            features: project.specs
                ? (Array.isArray(project.specs) ? project.specs : [project.specs])
                : (Array.isArray(project.features) ? project.features : (project.features ? [project.features] : [])),
            scenarios: scenarioResults,
            totalScenarios: scenarioResults.length,
            passedScenarios,
            failedScenarios,
            skippedScenarios,
            reportPath: projectReportPath,
            htmlReportPath: path.join(projectReportPath, 'reports', 'index.html'),
            jsonReportPath: path.join(projectReportPath, 'reports', 'report-data.json'),
            exitCode,
            error,
            environment: project.environment || options.defaults.environment
        };

        // Log result summary
        const statusIcon = status === 'passed' ? '✓' : status === 'failed' ? '✗' : '○';
        console.log(`\n  ${statusIcon} ${project.name}: ${status.toUpperCase()}`);
        console.log(`    Scenarios: ${passedScenarios} passed, ${failedScenarios} failed, ${skippedScenarios} skipped`);
        console.log(`    Duration: ${this.formatDuration(duration)}`);

        // Emit project complete event
        this.emitEvent(options.onProgress, {
            type: 'project:complete',
            timestamp: new Date().toISOString(),
            data: { projectName: project.name, status, duration, passedScenarios, failedScenarios }
        });

        return result;
    }

    /**
     * Build command line arguments for project execution
     */
    private buildCommandArgs(
        project: SuiteProjectConfig,
        options: ProjectExecutionOptions,
        projectReportPath: string
    ): string[] {
        const args: string[] = [];

        // Project name
        args.push(`--project=${project.project}`);

        // Features OR Specs (auto-detect format from which property is set)
        if (project.specs) {
            // Spec format (describe/it)
            const specs = Array.isArray(project.specs) ? project.specs.join(',') : project.specs;
            args.push(`--specs=${specs}`);

            // Spec-specific options
            if (project.grep) {
                args.push(`--grep=${project.grep}`);
            }
            if (project.test) {
                args.push(`--test=${project.test}`);
            }
        } else if (project.features) {
            // BDD format (Given/When/Then)
            const features = Array.isArray(project.features) ? project.features.join(',') : project.features;
            args.push(`--features=${features}`);
        } else {
            // Default to features if nothing specified (backward compatibility)
            console.warn(`  Warning: Project ${project.name} has neither specs nor features defined`);
        }

        // Environment
        const env = project.environment || options.defaults.environment;
        args.push(`--environment=${env}`);

        // Tags (if specified)
        if (project.tags) {
            args.push(`--tags=${project.tags}`);
        }

        // Headless mode
        const headless = project.headless !== undefined ? project.headless : options.defaults.headless;
        args.push(`--headless=${headless}`);

        // Parallel workers (scenarios within this project)
        const parallel = project.parallel !== undefined ? project.parallel : options.defaults.parallel;
        if (parallel && parallel > 1) {
            args.push(`--parallel=${parallel}`);
            args.push(`--workers=${parallel}`);
        }

        // Retry count
        const retry = project.retry !== undefined ? project.retry : options.defaults.retry;
        if (retry && retry > 0) {
            args.push(`--retry=${retry}`);
        }

        // Browser (for UI tests)
        if (project.type === 'ui' || project.type === 'hybrid') {
            const browser = project.browser || options.defaults.browser || 'chromium';
            args.push(`--browser=${browser}`);
        }

        // Artifact settings (video, trace, screenshot, har)
        const artifacts = project.artifacts || options.defaults.artifacts;
        if (artifacts) {
            if (artifacts.video) {
                args.push(`--video=${artifacts.video}`);
            }
            if (artifacts.trace) {
                args.push(`--trace=${artifacts.trace}`);
            }
            if (artifacts.screenshot) {
                args.push(`--screenshot=${artifacts.screenshot}`);
            }
            if (artifacts.har) {
                args.push(`--har=${artifacts.har}`);
            }
        }

        // Log level
        const logLevel = project.logLevel || options.defaults.logLevel;
        if (logLevel) {
            args.push(`--log-level=${logLevel}`);
        }

        // Modules (database, api, etc.)
        if (project.modules) {
            const modules = Array.isArray(project.modules) ? project.modules.join(',') : project.modules;
            args.push(`--modules=${modules}`);
        }

        // Set report path for this project
        // The framework will generate reports in this project-specific folder
        args.push(`--report-path=${projectReportPath}`);

        // Enable multi-project mode flag
        if (options.isMultiProjectMode) {
            args.push('--multi-project=true');
        }

        return args;
    }

    /**
     * Run the project as a child process
     */
    private runProcess(
        args: string[],
        project: SuiteProjectConfig,
        options: ProjectExecutionOptions
    ): Promise<number> {
        return new Promise((resolve, reject) => {
            // Set environment variables for the project
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                PROJECT: project.project,
                ENVIRONMENT: project.environment || options.defaults.environment,
                SUITE_REPORT_PATH: options.suiteReportPath
            };

            // Only set MULTI_PROJECT_MODE when actually in multi-project mode
            if (options.isMultiProjectMode) {
                env.MULTI_PROJECT_MODE = 'true';
            }

            // Use npx to run the framework
            const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
            const child = spawn(command, ['cs-playwright-test', ...args], {
                env,
                cwd: process.cwd(),
                stdio: ['inherit', 'pipe', 'pipe'],
                shell: process.platform === 'win32'
            });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data) => {
                const text = data.toString();
                stdout += text;
                process.stdout.write(text);
            });

            child.stderr?.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                process.stderr.write(text);
            });

            child.on('error', (error) => {
                reject(new Error(`Failed to start project ${project.name}: ${error.message}`));
            });

            child.on('close', (code) => {
                resolve(code || 0);
            });

            // Handle timeout
            const timeout = project.timeout || options.defaults.timeout;
            if (timeout > 0) {
                setTimeout(() => {
                    if (!child.killed) {
                        child.kill('SIGTERM');
                        reject(new Error(`Project ${project.name} timed out after ${timeout}ms`));
                    }
                }, timeout);
            }
        });
    }

    /**
     * Parse project results from report-data.json
     */
    private parseProjectResults(projectReportPath: string): ScenarioResult[] {
        const reportDataPath = path.join(projectReportPath, 'reports', 'report-data.json');

        if (!fs.existsSync(reportDataPath)) {
            console.warn(`  Warning: report-data.json not found at ${reportDataPath}`);
            return [];
        }

        try {
            const reportData = JSON.parse(fs.readFileSync(reportDataPath, 'utf8'));

            // Extract scenarios from report data
            const scenarios: ScenarioResult[] = [];

            if (reportData.suite?.scenarios) {
                for (const scenario of reportData.suite.scenarios) {
                    // Extract error from scenario.error OR from first failed step
                    let scenarioError = scenario.error;
                    if (!scenarioError && scenario.steps && Array.isArray(scenario.steps)) {
                        const failedStep = scenario.steps.find((s: any) => s.status === 'failed' && s.error);
                        if (failedStep) {
                            scenarioError = failedStep.error;
                        }
                    }
                    // Normalize error to string (spec errors are objects {message, stack})
                    if (scenarioError && typeof scenarioError === 'object') {
                        scenarioError = scenarioError.message || JSON.stringify(scenarioError);
                    }
                    scenarios.push({
                        name: scenario.name || 'Unknown Scenario',
                        feature: scenario.feature || 'Unknown Feature',
                        status: scenario.status || 'skipped',
                        duration: scenario.duration || 0,
                        tags: scenario.tags || [],
                        error: scenarioError,
                        screenshots: scenario.screenshots || [],
                        videos: scenario.videos || [],
                        trace: scenario.trace,
                        steps: scenario.steps
                    });
                }
            }

            return scenarios;
        } catch (error: any) {
            console.warn(`  Warning: Failed to parse report-data.json: ${error.message}`);
            return [];
        }
    }

    /**
     * Format duration in human-readable format
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
     * Emit progress event
     */
    private emitEvent(callback: SuiteProgressCallback | undefined, event: SuiteEvent): void {
        if (callback) {
            try {
                callback(event);
            } catch (error) {
                // Ignore callback errors
            }
        }
    }
}

export default CSSuiteExecutor;
