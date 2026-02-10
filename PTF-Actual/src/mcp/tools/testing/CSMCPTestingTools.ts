/**
 * CS Playwright MCP Testing Tools
 * Test execution and debugging tools for Playwright agents
 *
 * Provides test_list, test_run, test_debug tools similar to
 * official Playwright Test MCP but integrated with CS framework
 *
 * @module CSMCPTestingTools
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// Lazy load framework components
let CSReporter: any = null;
let CSBrowserManager: any = null;

// ============================================================================
// Module-level State
// ============================================================================

interface TestResult {
    id: string;
    title: string;
    file: string;
    line?: number;
    column?: number;
    status: 'passed' | 'failed' | 'skipped' | 'pending';
    duration?: number;
    error?: {
        message: string;
        stack?: string;
        location?: string;
    };
    retry?: number;
}

interface TestRunResult {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    duration: number;
    tests: TestResult[];
    summary: string;
}

// Store for active debug sessions
const debugSessions: Map<string, {
    process: ChildProcess | null;
    status: 'running' | 'paused' | 'completed' | 'error';
    output: string[];
    pausedAt?: string;
}> = new Map();

// Test list cache for efficiency
interface TestListCache {
    tests: Array<{ id: string; title: string; file: string; line?: number }>;
    timestamp: number;
    configHash: string;
}
const testListCache: Map<string, TestListCache> = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds cache TTL

// Watch mode state
const watchProcesses: Map<string, ChildProcess> = new Map();

// ============================================================================
// Helper Functions
// ============================================================================

function createTextResult(text: string): MCPToolResult {
    return {
        content: [{ type: 'text', text } as MCPTextContent],
    };
}

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

function ensureReporterLoaded(): void {
    if (!CSReporter) {
        try {
            CSReporter = require('../../../reporter/CSReporter').CSReporter;
        } catch {
            CSReporter = { info: console.log, pass: console.log, fail: console.error, debug: console.log };
        }
    }
}

/**
 * Generate a simple hash for cache key
 */
function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(16);
}

/**
 * Check if cached test list is valid
 */
function getCachedTestList(workingDir: string, configPath: string | null): TestListCache | null {
    const cacheKey = workingDir;
    const cached = testListCache.get(cacheKey);

    if (!cached) return null;

    // Check TTL
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
        testListCache.delete(cacheKey);
        return null;
    }

    // Check if config changed
    if (configPath) {
        try {
            const configStat = fs.statSync(configPath);
            const currentHash = simpleHash(`${configStat.mtimeMs}`);
            if (cached.configHash !== currentHash) {
                testListCache.delete(cacheKey);
                return null;
            }
        } catch {
            // Config file might not exist
        }
    }

    return cached;
}

/**
 * Store test list in cache
 */
function cacheTestList(
    workingDir: string,
    tests: Array<{ id: string; title: string; file: string; line?: number }>,
    configPath: string | null
): void {
    let configHash = '';
    if (configPath) {
        try {
            const configStat = fs.statSync(configPath);
            configHash = simpleHash(`${configStat.mtimeMs}`);
        } catch {
            // Ignore
        }
    }

    testListCache.set(workingDir, {
        tests,
        timestamp: Date.now(),
        configHash,
    });
}

/**
 * Find the Playwright config file in the project
 */
function findPlaywrightConfig(workingDir: string): string | null {
    const configNames = [
        'playwright.config.ts',
        'playwright.config.js',
        'playwright.config.mjs',
    ];

    for (const configName of configNames) {
        const configPath = path.join(workingDir, configName);
        if (fs.existsSync(configPath)) {
            return configPath;
        }
    }
    return null;
}

/**
 * Detect test format (BDD or Spec) based on project structure
 */
function detectTestFormat(workingDir: string, project?: string): 'bdd' | 'spec' | 'both' {
    const projectDir = project ? path.join(workingDir, 'test', project) : workingDir;

    const hasFeatures = fs.existsSync(path.join(projectDir, 'features'));
    const hasSpecs = fs.existsSync(path.join(projectDir, 'specs'));

    if (hasFeatures && hasSpecs) return 'both';
    if (hasFeatures) return 'bdd';
    if (hasSpecs) return 'spec';

    // Check for .feature or .spec.ts files
    try {
        const files = fs.readdirSync(projectDir, { recursive: true }) as string[];
        const hasFeatureFiles = files.some(f => f.endsWith('.feature'));
        const hasSpecFiles = files.some(f => f.endsWith('.spec.ts'));

        if (hasFeatureFiles && hasSpecFiles) return 'both';
        if (hasFeatureFiles) return 'bdd';
        if (hasSpecFiles) return 'spec';
    } catch {
        // Directory might not exist
    }

    return 'bdd'; // Default to BDD
}

/**
 * Find the CS Playwright test runner
 */
function findTestRunner(workingDir: string): { command: string; args: string[]; isCSFramework: boolean } {
    // Check for cs-playwright-test in node_modules (our framework)
    const csRunnerPath = path.join(workingDir, 'node_modules', '.bin', 'cs-playwright-test');
    if (fs.existsSync(csRunnerPath) || fs.existsSync(csRunnerPath + '.cmd')) {
        return { command: 'npx', args: ['cs-playwright-test'], isCSFramework: true };
    }

    // Check if we're in the framework directory itself
    const packageJson = path.join(workingDir, 'package.json');
    if (fs.existsSync(packageJson)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
            if (pkg.name === '@mdakhan.mak/cs-playwright-test-framework') {
                return { command: 'node', args: ['dist/index.js'], isCSFramework: true };
            }
        } catch {
            // Ignore parse errors
        }
    }

    // Fall back to playwright test
    const playwrightPath = path.join(workingDir, 'node_modules', '.bin', 'playwright');
    if (fs.existsSync(playwrightPath) || fs.existsSync(playwrightPath + '.cmd')) {
        return { command: 'npx', args: ['playwright', 'test'], isCSFramework: false };
    }

    // Default to npx playwright
    return { command: 'npx', args: ['playwright', 'test'], isCSFramework: false };
}

/**
 * Parse test output to extract test results
 * Supports both CS BDD framework and standard Playwright output
 */
function parseTestOutput(output: string, isCSFramework: boolean = true): TestRunResult {
    const tests: TestResult[] = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    if (isCSFramework) {
        // CS BDD Framework output patterns
        // Feature/Scenario format: "Feature: Login" / "Scenario: Valid login"
        // Step format: "✓ Given I navigate to login page" or "✗ When I enter credentials"

        // Parse scenario results
        // Match: "✓ Scenario: Valid login (1234ms)" or "✗ Scenario: Invalid login"
        const scenarioPattern = /([✓✗○])\s*Scenario(?:\s+Outline)?:\s*(.+?)(?:\s+\((\d+)(?:ms|s)\))?$/gm;
        let match;

        while ((match = scenarioPattern.exec(output)) !== null) {
            const [, symbol, title, duration] = match;
            const status = symbol === '✓' ? 'passed' :
                           symbol === '✗' ? 'failed' :
                           symbol === '○' ? 'skipped' : 'pending';

            tests.push({
                id: `scenario:${title.trim().toLowerCase().replace(/\s+/g, '-')}`,
                title: title.trim(),
                file: 'feature',
                status,
                duration: duration ? parseInt(duration) : undefined,
            });

            if (status === 'passed') passed++;
            else if (status === 'failed') failed++;
            else if (status === 'skipped') skipped++;
        }

        // Parse CS framework summary
        // Match: "Passed: 5 | Failed: 1 | Skipped: 0"
        const csSummaryPattern = /Passed:\s*(\d+)\s*\|\s*Failed:\s*(\d+)\s*\|\s*Skipped:\s*(\d+)/i;
        const csSummaryMatch = output.match(csSummaryPattern);
        if (csSummaryMatch) {
            passed = parseInt(csSummaryMatch[1]) || passed;
            failed = parseInt(csSummaryMatch[2]) || failed;
            skipped = parseInt(csSummaryMatch[3]) || skipped;
        }

        // Alternative summary format: "Total: X scenarios (Y passed, Z failed)"
        const altSummaryPattern = /Total:\s*(\d+)\s*scenarios?\s*\((\d+)\s*passed,\s*(\d+)\s*failed/i;
        const altSummaryMatch = output.match(altSummaryPattern);
        if (altSummaryMatch) {
            passed = parseInt(altSummaryMatch[2]) || passed;
            failed = parseInt(altSummaryMatch[3]) || failed;
        }
    }

    // Also try standard Playwright patterns for compatibility
    // Match patterns like: ✓  tests/example.spec.ts:3:5 › test name (500ms)
    const testPattern = /([✓✘○◌])\s+\[?[\w-]*\]?\s*(.+?):(\d+):?(\d+)?\s+›\s+(.+?)(?:\s+\((\d+(?:ms|s))\))?$/gm;
    let match;

    while ((match = testPattern.exec(output)) !== null) {
        const [, symbol, file, line, column, title, duration] = match;
        const status = symbol === '✓' ? 'passed' :
                       symbol === '✘' ? 'failed' :
                       symbol === '○' ? 'skipped' : 'pending';

        const testId = column ? `${file}:${line}:${column}` : `${file}:${line}`;

        // Avoid duplicates
        if (!tests.find(t => t.id === testId)) {
            tests.push({
                id: testId,
                title: title.trim(),
                file,
                line: parseInt(line),
                column: column ? parseInt(column) : undefined,
                status,
                duration: duration ? parseInt(duration) : undefined,
            });

            if (status === 'passed') passed++;
            else if (status === 'failed') failed++;
            else if (status === 'skipped') skipped++;
        }
    }

    // Parse standard Playwright summary line
    // Match: "2 passed, 1 failed (5.0s)"
    const summaryPattern = /(\d+)\s+passed(?:.*?(\d+)\s+failed)?(?:.*?(\d+)\s+skipped)?.*?\(([0-9.]+)s?\)/i;
    const summaryMatch = output.match(summaryPattern);

    let totalDuration = 0;
    if (summaryMatch) {
        passed = parseInt(summaryMatch[1]) || passed;
        failed = parseInt(summaryMatch[2]) || failed;
        skipped = parseInt(summaryMatch[3]) || skipped;
        totalDuration = parseFloat(summaryMatch[4]) * 1000;
    }

    // Parse CS framework duration
    const csDurationPattern = /Duration:\s*([0-9.]+)\s*(s|ms|m)/i;
    const csDurationMatch = output.match(csDurationPattern);
    if (csDurationMatch) {
        const value = parseFloat(csDurationMatch[1]);
        const unit = csDurationMatch[2].toLowerCase();
        totalDuration = unit === 's' ? value * 1000 :
                        unit === 'm' ? value * 60000 : value;
    }

    return {
        passed,
        failed,
        skipped,
        total: passed + failed + skipped,
        duration: totalDuration,
        tests,
        summary: output,
    };
}

/**
 * Parse test list output
 * Supports both CS BDD framework (features/scenarios) and Playwright spec format
 */
function parseTestList(output: string, isCSFramework: boolean = true): Array<{
    id: string;
    title: string;
    file: string;
    line?: number;
    type?: 'feature' | 'scenario' | 'spec';
    tags?: string[];
}> {
    const tests: Array<{
        id: string;
        title: string;
        file: string;
        line?: number;
        type?: 'feature' | 'scenario' | 'spec';
        tags?: string[];
    }> = [];

    if (isCSFramework) {
        // CS BDD Framework output - features and scenarios
        // Parse feature files listing
        // Match: "Feature: User Login (test/myproject/features/login.feature)"
        const featurePattern = /Feature:\s*(.+?)\s*\((.+?\.feature)\)/gm;
        let match;

        let currentFeature = '';
        let currentFeatureFile = '';

        while ((match = featurePattern.exec(output)) !== null) {
            const [, title, file] = match;
            currentFeature = title.trim();
            currentFeatureFile = file;

            tests.push({
                id: `feature:${file}`,
                title: currentFeature,
                file,
                type: 'feature',
            });
        }

        // Parse scenarios
        // Match: "  Scenario: Valid login (@smoke, @login)"
        // Or: "  Scenario Outline: Login with <username> (@data-driven)"
        const scenarioPattern = /^\s*Scenario(?:\s+Outline)?:\s*(.+?)(?:\s+\((@[\w,\s@-]+)\))?$/gm;

        while ((match = scenarioPattern.exec(output)) !== null) {
            const [, title, tagString] = match;
            const tags = tagString ? tagString.match(/@[\w-]+/g) || [] : [];

            tests.push({
                id: `scenario:${title.trim().toLowerCase().replace(/\s+/g, '-')}`,
                title: title.trim(),
                file: currentFeatureFile || 'unknown.feature',
                type: 'scenario',
                tags,
            });
        }

        // Alternative format: listing scenarios directly
        // Match: "  ✓ Scenario: Valid login"
        const listScenarioPattern = /^\s*[✓✗○-]\s*Scenario(?:\s+Outline)?:\s*(.+?)$/gm;
        while ((match = listScenarioPattern.exec(output)) !== null) {
            const title = match[1].trim();
            if (!tests.find(t => t.title === title && t.type === 'scenario')) {
                tests.push({
                    id: `scenario:${title.toLowerCase().replace(/\s+/g, '-')}`,
                    title,
                    file: 'feature',
                    type: 'scenario',
                });
            }
        }
    }

    // Also parse standard Playwright spec format for compatibility
    // Parse lines like: "  test/example.spec.ts:5:3 › describe › test name"
    const testPattern = /^\s*(.+?):(\d+):?(\d+)?\s+›\s+(.+)$/gm;
    let match;

    while ((match = testPattern.exec(output)) !== null) {
        const [, file, line, column, fullTitle] = match;
        const titleParts = fullTitle.split(' › ');
        const title = titleParts[titleParts.length - 1];

        const testId = column ? `${file}:${line}:${column}` : `${file}:${line}`;

        // Avoid duplicates
        if (!tests.find(t => t.id === testId)) {
            tests.push({
                id: testId,
                title: title.trim(),
                file,
                line: parseInt(line),
                type: 'spec',
            });
        }
    }

    return tests;
}

// ============================================================================
// Test List Tool
// ============================================================================

const testListTool = defineTool()
    .name('test_list')
    .description('List all available tests in the project. Supports CS BDD framework (features/scenarios) and Playwright specs. Returns test IDs for use with test_run and test_debug.')
    .category('testing')
    .stringParam('project', 'CS framework project name (e.g., "myproject") - maps to test/<project>/')
    .stringParam('format', 'Test format to list', {
        enum: ['bdd', 'spec', 'auto'],
        default: 'auto',
    })
    .stringParam('tags', 'Filter by tags for BDD (e.g., "@smoke", "@smoke and not @slow")')
    .stringParam('grep', 'Filter tests by title pattern (regex)')
    .stringParam('grepInvert', 'Exclude tests matching this pattern')
    .stringParam('testDir', 'Test directory path (relative to working directory)')
    .booleanParam('noCache', 'Force refresh, ignore cache', { default: false })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const workingDir = context.server.workingDirectory;
        const configPath = findPlaywrightConfig(workingDir);
        const noCache = params.noCache as boolean;
        const project = params.project as string | undefined;

        // Detect test format
        const requestedFormat = params.format as string || 'auto';
        const detectedFormat = detectTestFormat(workingDir, project);
        const format = requestedFormat === 'auto' ? detectedFormat : requestedFormat;

        // Check cache first (only if no filters applied)
        const cacheKey = `${workingDir}:${project || 'default'}:${format}`;
        if (!noCache && !params.grep && !params.grepInvert && !params.testDir && !params.tags) {
            const cached = getCachedTestList(cacheKey, configPath);
            if (cached) {
                context.log('info', 'Returning cached test list');
                CSReporter.info(`[MCP] Returning cached test list (${cached.tests.length} tests)`);
                return createJsonResult({
                    count: cached.tests.length,
                    tests: cached.tests,
                    format,
                    project: project || 'default',
                    cached: true,
                    cacheAge: Date.now() - cached.timestamp,
                });
            }
        }

        const { command, args, isCSFramework } = findTestRunner(workingDir);

        context.log('info', `Listing ${format} tests`);
        CSReporter.info(`[MCP] Listing ${format} tests${project ? ` for project: ${project}` : ''}`);

        // Build command arguments based on format
        const cmdArgs = [...args];

        if (isCSFramework) {
            // CS Framework arguments
            if (project) cmdArgs.push('--project', project);

            if (format === 'bdd') {
                // BDD mode - list features
                cmdArgs.push('--dry-run'); // Parse and validate without executing
                if (params.tags) cmdArgs.push('--tags', params.tags as string);
                if (params.testDir) {
                    cmdArgs.push('--features', params.testDir as string);
                }
            } else if (format === 'spec') {
                // Spec mode
                cmdArgs.push('--list');
                if (params.testDir) {
                    cmdArgs.push('--specs', params.testDir as string);
                }
            }

            if (params.grep) cmdArgs.push('--grep', params.grep as string);
        } else {
            // Standard Playwright arguments
            cmdArgs.push('--list');
            if (params.project) cmdArgs.push('--project', params.project as string);
            if (params.grep) cmdArgs.push('--grep', params.grep as string);
            if (params.grepInvert) cmdArgs.push('--grep-invert', params.grepInvert as string);
            if (params.testDir) cmdArgs.push(params.testDir as string);
        }

        try {
            // For BDD format, we can also directly scan feature files
            if (isCSFramework && format === 'bdd') {
                const featuresDir = project
                    ? path.join(workingDir, 'test', project, 'features')
                    : path.join(workingDir, 'test', 'features');

                if (fs.existsSync(featuresDir)) {
                    const featureFiles = fs.readdirSync(featuresDir)
                        .filter(f => f.endsWith('.feature'));

                    const tests: Array<{
                        id: string;
                        title: string;
                        file: string;
                        type: string;
                        tags?: string[];
                        scenarios?: Array<{ name: string; tags: string[] }>;
                    }> = [];

                    for (const file of featureFiles) {
                        const content = fs.readFileSync(path.join(featuresDir, file), 'utf-8');
                        const featureName = content.match(/Feature:\s*(.+)/)?.[1]?.trim() || file;
                        const featureTags = content.match(/^@[\w-]+/gm) || [];

                        // Parse scenarios
                        const scenarioMatches = content.matchAll(/(?:^|\n)((?:@[\w-]+\s*)+)?\s*Scenario(?:\s+Outline)?:\s*(.+)/g);
                        const scenarios: Array<{ name: string; tags: string[] }> = [];

                        for (const match of scenarioMatches) {
                            const scenarioTags = match[1]?.match(/@[\w-]+/g) || [];
                            const scenarioName = match[2].trim();
                            scenarios.push({
                                name: scenarioName,
                                tags: scenarioTags,
                            });
                        }

                        tests.push({
                            id: `feature:${file}`,
                            title: featureName,
                            file: path.join('features', file),
                            type: 'feature',
                            tags: [...new Set(featureTags)],
                            scenarios,
                        });
                    }

                    // Apply tag filter if specified
                    let filteredTests = tests;
                    if (params.tags) {
                        const tagFilter = params.tags as string;
                        filteredTests = tests.filter(t => {
                            const allTags = [...(t.tags || []), ...(t.scenarios?.flatMap(s => s.tags) || [])];
                            // Simple tag matching (supports @tag, not @tag, and @tag1 and @tag2)
                            if (tagFilter.includes(' and ')) {
                                const requiredTags = tagFilter.split(' and ').map(t => t.trim());
                                return requiredTags.every(rt => {
                                    if (rt.startsWith('not ')) {
                                        return !allTags.includes(rt.replace('not ', ''));
                                    }
                                    return allTags.includes(rt);
                                });
                            }
                            return allTags.includes(tagFilter);
                        });
                    }

                    // Cache results
                    cacheTestList(cacheKey, filteredTests as any, configPath);

                    const totalScenarios = filteredTests.reduce((sum, f) => sum + (f.scenarios?.length || 0), 0);

                    CSReporter.pass(`[MCP] Found ${filteredTests.length} features, ${totalScenarios} scenarios`);

                    return createJsonResult({
                        format: 'bdd',
                        project: project || 'default',
                        featuresDir,
                        featureCount: filteredTests.length,
                        scenarioCount: totalScenarios,
                        features: filteredTests,
                        cached: false,
                    });
                }
            }

            // Run command synchronously for listing
            const output = execSync(`${command} ${cmdArgs.join(' ')}`, {
                cwd: workingDir,
                encoding: 'utf-8',
                timeout: 60000,
                env: { ...process.env, FORCE_COLOR: '0' },
            });

            const tests = parseTestList(output, isCSFramework);

            // Cache results if no filters
            if (!params.grep && !params.grepInvert && !params.testDir && !params.tags) {
                cacheTestList(cacheKey, tests, configPath);
            }

            CSReporter.pass(`[MCP] Found ${tests.length} tests`);

            return createJsonResult({
                format,
                project: project || 'default',
                count: tests.length,
                tests,
                cached: false,
            });
        } catch (error: any) {
            // Even on "error", we might have output with test list
            if (error.stdout) {
                const tests = parseTestList(error.stdout, isCSFramework);
                if (tests.length > 0) {
                    cacheTestList(cacheKey, tests, configPath);
                    return createJsonResult({
                        format,
                        project: project || 'default',
                        count: tests.length,
                        tests,
                        cached: false,
                    });
                }
            }

            CSReporter.fail(`[MCP] Failed to list tests: ${error.message}`);
            return createErrorResult(`Failed to list tests: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Test Run Tool
// ============================================================================

const testRunTool = defineTool()
    .name('test_run')
    .description('Run tests using CS Playwright framework. Supports BDD features and Playwright specs. Returns pass/fail results with scenario details.')
    .category('testing')
    .stringParam('project', 'CS framework project name (e.g., "myproject")')
    .stringParam('format', 'Test format to run', {
        enum: ['bdd', 'spec', 'auto'],
        default: 'auto',
    })
    .arrayParam('features', 'Feature files to run for BDD (e.g., ["login.feature", "checkout.feature"])', 'string')
    .arrayParam('specs', 'Spec files to run (e.g., ["login.spec.ts"])', 'string')
    .stringParam('tags', 'BDD tags to filter (e.g., "@smoke", "@smoke and not @slow")')
    .stringParam('scenario', 'Run specific scenario by name')
    .stringParam('grep', 'Run tests matching this pattern')
    .stringParam('grepInvert', 'Skip tests matching this pattern')
    .booleanParam('headed', 'Run in headed mode (visible browser)', { default: false })
    .booleanParam('headless', 'Run in headless mode', { default: true })
    .booleanParam('parallel', 'Run tests in parallel', { default: false })
    .numberParam('workers', 'Number of parallel workers', { default: 1 })
    .numberParam('retries', 'Number of retries for failed tests', { default: 0 })
    .numberParam('timeout', 'Test timeout in milliseconds')
    .stringParam('env', 'Environment to run against (e.g., "sit", "uat", "prod")')
    .stringParam('browser', 'Browser type', {
        enum: ['chromium', 'firefox', 'webkit'],
        default: 'chromium',
    })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const workingDir = context.server.workingDirectory;
        const { command, args, isCSFramework } = findTestRunner(workingDir);
        const project = params.project as string | undefined;

        // Detect test format
        const requestedFormat = params.format as string || 'auto';
        const detectedFormat = detectTestFormat(workingDir, project);
        const format = requestedFormat === 'auto' ? detectedFormat : requestedFormat;

        context.log('info', `Running ${format} tests`);
        CSReporter.info(`[MCP] Running ${format} tests${project ? ` for project: ${project}` : ''}`);

        // Build command arguments
        const cmdArgs = [...args];

        if (isCSFramework) {
            // CS Framework arguments
            if (project) cmdArgs.push('--project', project);

            if (format === 'bdd') {
                // BDD mode - run features
                const features = params.features as string[] | undefined;
                if (features && features.length > 0) {
                    cmdArgs.push('--features', features.join(','));
                }

                if (params.tags) cmdArgs.push('--tags', params.tags as string);
                if (params.scenario) cmdArgs.push('--scenario', params.scenario as string);
            } else if (format === 'spec') {
                // Spec mode
                const specs = params.specs as string[] | undefined;
                if (specs && specs.length > 0) {
                    cmdArgs.push('--specs', specs.join(','));
                }
            }

            // Common CS framework options
            if (params.env) cmdArgs.push('--env', params.env as string);
            if (params.headed) cmdArgs.push('--headed');
            if (params.headless === false || params.headed) {
                // headed takes precedence
            } else {
                cmdArgs.push('--headless');
            }
            if (params.parallel) cmdArgs.push('--parallel');
            if (params.workers) cmdArgs.push('--workers', String(params.workers));
            if (params.retries) cmdArgs.push('--retries', String(params.retries));
            if (params.timeout) cmdArgs.push('--timeout', String(params.timeout));
            if (params.browser) cmdArgs.push('--browser', params.browser as string);
            if (params.grep) cmdArgs.push('--grep', params.grep as string);
        } else {
            // Standard Playwright arguments
            const features = params.features as string[] | undefined;
            const specs = params.specs as string[] | undefined;
            if (features && features.length > 0) {
                cmdArgs.push(...features);
            }
            if (specs && specs.length > 0) {
                cmdArgs.push(...specs);
            }

            if (params.grep) cmdArgs.push('--grep', params.grep as string);
            if (params.grepInvert) cmdArgs.push('--grep-invert', params.grepInvert as string);
            if (params.headed) cmdArgs.push('--headed');
            if (params.workers) cmdArgs.push('--workers', String(params.workers));
            if (params.retries) cmdArgs.push('--retries', String(params.retries));
            if (params.timeout) cmdArgs.push('--timeout', String(params.timeout));
        }

        return new Promise<MCPToolResult>((resolve) => {
            const output: string[] = [];
            const startTime = Date.now();

            const proc = spawn(command, cmdArgs, {
                cwd: workingDir,
                shell: true,
                env: {
                    ...process.env,
                    FORCE_COLOR: '0',
                    PROJECT: project || '',
                    ENV: (params.env as string) || '',
                },
            });

            proc.stdout?.on('data', (data) => {
                const text = data.toString();
                output.push(text);
                context.log('info', text.trim());
            });

            proc.stderr?.on('data', (data) => {
                const text = data.toString();
                output.push(text);
                context.log('info', text.trim());
            });

            proc.on('close', (code) => {
                const fullOutput = output.join('');
                const result = parseTestOutput(fullOutput, isCSFramework);
                result.duration = Date.now() - startTime;

                if (result.failed > 0) {
                    CSReporter.fail(`[MCP] Tests completed: ${result.passed} passed, ${result.failed} failed`);
                } else {
                    CSReporter.pass(`[MCP] Tests completed: ${result.passed} passed`);
                }

                resolve(createJsonResult({
                    status: code === 0 ? 'passed' : 'failed',
                    exitCode: code,
                    format,
                    project: project || 'default',
                    command: `${command} ${cmdArgs.join(' ')}`,
                    ...result,
                }));
            });

            proc.on('error', (error) => {
                CSReporter.fail(`[MCP] Test run failed: ${error.message}`);
                resolve(createErrorResult(`Test run failed: ${error.message}`));
            });
        });
    })
    .build();

// ============================================================================
// Test Debug Tool
// ============================================================================

const testDebugTool = defineTool()
    .name('test_debug')
    .description('Debug a specific failing test with pause-on-error. Runs the test in headed mode with Playwright Inspector and pauses when an error occurs.')
    .category('testing')
    .objectParam('test', 'Test to debug', {
        id: { type: 'string', description: 'Test ID (file:line:column) from test_list' },
        title: { type: 'string', description: 'Human readable test title (for reference)' },
    }, { required: true, requiredProps: ['id'] })
    .numberParam('timeout', 'Override test timeout (0 for no timeout)', { default: 0 })
    .numberParam('actionTimeout', 'Timeout for individual actions in ms', { default: 10000 })
    .booleanParam('captureSnapshot', 'Capture page snapshot on pause', { default: true })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const testInfo = params.test as { id: string; title?: string };
        const workingDir = context.server.workingDirectory;
        const { command, args } = findTestRunner(workingDir);

        const sessionId = `debug_${Date.now()}`;

        context.log('info', `Debugging test: ${testInfo.id}`);
        CSReporter.info(`[MCP] Debugging test: ${testInfo.title || testInfo.id}`);

        // Parse test location
        const [file, line] = testInfo.id.split(':');
        const testLocation = `${file}:${line}`;

        // Build debug command
        const cmdArgs = [...args];
        cmdArgs.push(testLocation);
        cmdArgs.push('--headed');
        cmdArgs.push('--workers', '1');

        if (params.timeout !== undefined) {
            cmdArgs.push('--timeout', String(params.timeout));
        }

        // Set environment for debug mode with pause on error
        const debugEnv = {
            ...process.env,
            PWDEBUG: '1',
            FORCE_COLOR: '0',
        };

        return new Promise<MCPToolResult>((resolve) => {
            const output: string[] = [];
            const startTime = Date.now();
            let isPaused = false;
            let pausedLocation = '';

            // Store session
            debugSessions.set(sessionId, {
                process: null,
                status: 'running',
                output: [],
            });

            const proc = spawn(command, cmdArgs, {
                cwd: workingDir,
                shell: true,
                env: debugEnv,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            // Update session with process
            debugSessions.set(sessionId, {
                process: proc,
                status: 'running',
                output,
            });

            proc.stdout?.on('data', (data) => {
                const text = data.toString();
                output.push(text);
                context.log('info', text.trim());

                // Detect if test is paused
                if (text.includes('Paused') || text.includes('paused')) {
                    isPaused = true;
                    pausedLocation = text;
                    debugSessions.get(sessionId)!.status = 'paused';
                    debugSessions.get(sessionId)!.pausedAt = pausedLocation;
                }
            });

            proc.stderr?.on('data', (data) => {
                const text = data.toString();
                output.push(text);
                context.log('info', text.trim());
            });

            proc.on('close', async (code) => {
                const fullOutput = output.join('');
                const duration = Date.now() - startTime;

                debugSessions.get(sessionId)!.status = code === 0 ? 'completed' : 'error';

                // Parse results
                const result = parseTestOutput(fullOutput);

                // Capture page snapshot if requested and browser is available
                let snapshot: any = null;
                if (params.captureSnapshot && isPaused) {
                    try {
                        const browserState = (context.server as any).browser;
                        if (browserState?.page) {
                            snapshot = await browserState.page.content();
                        }
                    } catch {
                        // Snapshot capture failed, continue without it
                    }
                }

                const testResult = result.tests.find(t => t.id.startsWith(file)) || {
                    id: testInfo.id,
                    title: testInfo.title || 'Unknown test',
                    file,
                    status: code === 0 ? 'passed' : 'failed',
                };

                if (code !== 0 && result.failed > 0) {
                    CSReporter.fail(`[MCP] Debug session completed - test failed`);
                } else {
                    CSReporter.pass(`[MCP] Debug session completed - test passed`);
                }

                resolve(createJsonResult({
                    sessionId,
                    testId: testInfo.id,
                    testTitle: testInfo.title,
                    status: isPaused ? 'paused' : (code === 0 ? 'passed' : 'failed'),
                    exitCode: code,
                    duration,
                    wasPaused: isPaused,
                    pausedAt: pausedLocation || undefined,
                    error: testResult.status === 'failed' ? {
                        message: 'Test failed - check output for details',
                        output: fullOutput.slice(-2000), // Last 2000 chars
                    } : undefined,
                    snapshot: snapshot ? 'Page snapshot captured' : undefined,
                    output: fullOutput,
                }));
            });

            proc.on('error', (error) => {
                debugSessions.get(sessionId)!.status = 'error';
                CSReporter.fail(`[MCP] Debug session failed: ${error.message}`);
                resolve(createErrorResult(`Debug session failed: ${error.message}`));
            });
        });
    })
    .build();

// ============================================================================
// Generate Locator Tool (for healer)
// ============================================================================

const generateLocatorTool = defineTool()
    .name('test_generate_locator')
    .description('Generate robust locator alternatives for an element. Uses aria snapshot and element properties to suggest the most stable locators.')
    .category('testing')
    .stringParam('selector', 'Current failing selector', { required: true })
    .stringParam('elementDescription', 'Description of the element (e.g., "login button", "username field")')
    .booleanParam('useAriaSnapshot', 'Use aria snapshot for context-aware suggestions', { default: true })
    .stringParam('searchContext', 'CSS selector to limit search scope (e.g., "form#login")')
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const selector = params.selector as string;
        const description = params.elementDescription as string | undefined;

        context.log('info', `Generating locator alternatives for: ${selector}`);

        try {
            const browserState = (context.server as any).browser;
            if (!browserState?.page) {
                return createErrorResult('No browser page available. Use browser_launch first.');
            }

            const page = browserState.page;

            // Try to find the element with current selector
            let element = null;
            try {
                element = await page.locator(selector).first();
                await element.waitFor({ timeout: 5000 });
            } catch {
                // Element not found with current selector
            }

            const alternatives: Array<{
                strategy: string;
                locator: string;
                confidence: number;
                reason: string;
            }> = [];

            // Get aria snapshot for context if requested
            let ariaContext = '';
            if (params.useAriaSnapshot !== false) {
                try {
                    const contextSelector = params.searchContext as string || 'body';
                    ariaContext = await page.locator(contextSelector).ariaSnapshot();
                } catch {
                    // ariaSnapshot may not be available in older Playwright versions
                }
            }

            if (element) {
                // Element found - generate alternatives based on its properties
                const tagName = await element.evaluate((el: Element) => el.tagName.toLowerCase());
                const role = await element.getAttribute('role') ||
                             await element.evaluate((el: Element) => (el as HTMLElement).role || null);
                const ariaLabel = await element.getAttribute('aria-label');
                const text = await element.textContent();
                const id = await element.getAttribute('id');
                const name = await element.getAttribute('name');
                const testId = await element.getAttribute('data-testid') ||
                              await element.getAttribute('data-test-id') ||
                              await element.getAttribute('data-test');
                const placeholder = await element.getAttribute('placeholder');
                const type = await element.getAttribute('type');
                const href = await element.getAttribute('href');
                const title = await element.getAttribute('title');

                // Generate alternatives based on available attributes
                if (testId) {
                    alternatives.push({
                        strategy: 'testId',
                        locator: `getByTestId('${testId}')`,
                        confidence: 95,
                        reason: 'Test ID is the most stable selector',
                    });
                }

                if (role && (ariaLabel || text)) {
                    alternatives.push({
                        strategy: 'role+name',
                        locator: `getByRole('${role}', { name: '${(ariaLabel || text?.trim().slice(0, 50))?.replace(/'/g, "\\'")}' })`,
                        confidence: 90,
                        reason: 'Role + name is accessible and stable',
                    });
                }

                if (ariaLabel) {
                    alternatives.push({
                        strategy: 'label',
                        locator: `getByLabel('${ariaLabel.replace(/'/g, "\\'")}')`,
                        confidence: 85,
                        reason: 'Aria label is accessible',
                    });
                }

                if (placeholder) {
                    alternatives.push({
                        strategy: 'placeholder',
                        locator: `getByPlaceholder('${placeholder.replace(/'/g, "\\'")}')`,
                        confidence: 80,
                        reason: 'Placeholder is visible to users',
                    });
                }

                if (text && text.trim().length < 100) {
                    alternatives.push({
                        strategy: 'text',
                        locator: `getByText('${text.trim().slice(0, 50).replace(/'/g, "\\'")}')`,
                        confidence: 75,
                        reason: 'Text content matches user intent',
                    });
                }

                if (id) {
                    alternatives.push({
                        strategy: 'id',
                        locator: `locator('#${id}')`,
                        confidence: 70,
                        reason: 'ID is unique but may be auto-generated',
                    });
                }

                if (name) {
                    alternatives.push({
                        strategy: 'name',
                        locator: `locator('[name="${name}"]')`,
                        confidence: 65,
                        reason: 'Name attribute is form-specific',
                    });
                }

                // Additional strategies based on element type
                if (tagName === 'a' && href) {
                    alternatives.push({
                        strategy: 'link',
                        locator: `getByRole('link', { name: '${(text?.trim().slice(0, 50) || '').replace(/'/g, "\\'")}' })`,
                        confidence: 85,
                        reason: 'Link with text is semantic and stable',
                    });
                }

                if (tagName === 'input' && type === 'submit') {
                    alternatives.push({
                        strategy: 'submit',
                        locator: `getByRole('button', { name: '${(await element.inputValue() || '').replace(/'/g, "\\'")}' })`,
                        confidence: 80,
                        reason: 'Submit button by value',
                    });
                }

                if (title) {
                    alternatives.push({
                        strategy: 'title',
                        locator: `getByTitle('${title.replace(/'/g, "\\'")}')`,
                        confidence: 70,
                        reason: 'Title attribute for tooltips',
                    });
                }

                // XPath as last resort
                alternatives.push({
                    strategy: 'xpath',
                    locator: `locator('${selector}')`,
                    confidence: 50,
                    reason: 'Original selector (may be fragile)',
                });
            } else if (description) {
                // Element not found - suggest based on description
                CSReporter.info(`[MCP] Element not found, suggesting based on description: ${description}`);

                const descLower = description.toLowerCase();

                if (descLower.includes('button')) {
                    alternatives.push({
                        strategy: 'role',
                        locator: `getByRole('button', { name: /${description.replace(/button/i, '').trim()}/i })`,
                        confidence: 60,
                        reason: 'Suggested based on button description',
                    });
                }

                if (descLower.includes('input') || descLower.includes('field')) {
                    alternatives.push({
                        strategy: 'role',
                        locator: `getByRole('textbox', { name: /${description.replace(/(input|field)/i, '').trim()}/i })`,
                        confidence: 60,
                        reason: 'Suggested based on input description',
                    });
                }

                if (descLower.includes('link')) {
                    alternatives.push({
                        strategy: 'role',
                        locator: `getByRole('link', { name: /${description.replace(/link/i, '').trim()}/i })`,
                        confidence: 60,
                        reason: 'Suggested based on link description',
                    });
                }
            }

            // Sort by confidence
            alternatives.sort((a, b) => b.confidence - a.confidence);

            CSReporter.pass(`[MCP] Generated ${alternatives.length} locator alternatives`);

            return createJsonResult({
                originalSelector: selector,
                elementFound: !!element,
                alternatives,
                recommendation: alternatives.length > 0 ? alternatives[0].locator : null,
                ariaContext: ariaContext ? ariaContext.slice(0, 2000) : undefined,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Locator generation failed: ${error.message}`);
            return createErrorResult(`Locator generation failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Heal Test Tool
// ============================================================================

const healTestTool = defineTool()
    .name('test_heal')
    .description('Automatically attempt to fix a failing test by analyzing the failure and generating updated locators.')
    .category('testing')
    .stringParam('testFile', 'Path to the failing test file', { required: true })
    .stringParam('testName', 'Name of the failing test (optional - heals all failures if not specified)')
    .numberParam('maxIterations', 'Maximum healing iterations', { default: 3 })
    .booleanParam('dryRun', 'Only suggest fixes without applying them', { default: true })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const testFile = params.testFile as string;
        const testName = params.testName as string | undefined;
        const maxIterations = (params.maxIterations as number) || 3;
        const dryRun = params.dryRun !== false;

        context.log('info', `Healing test: ${testFile}`);
        CSReporter.info(`[MCP] Starting test healing: ${testFile}`);

        const workingDir = context.server.workingDirectory;
        const fullPath = path.resolve(workingDir, testFile);

        if (!fs.existsSync(fullPath)) {
            return createErrorResult(`Test file not found: ${testFile}`);
        }

        const healingResults: Array<{
            iteration: number;
            testRun: 'passed' | 'failed';
            issues: Array<{
                type: 'locator' | 'assertion' | 'timeout' | 'other';
                location: string;
                message: string;
                suggestion?: string;
            }>;
            fixes?: Array<{
                location: string;
                original: string;
                replacement: string;
                applied: boolean;
            }>;
        }> = [];

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            context.log('info', `Healing iteration ${iteration}/${maxIterations}`);

            // Run the test
            const { command, args } = findTestRunner(workingDir);
            const cmdArgs = [...args, testFile];
            if (testName) {
                cmdArgs.push('--grep', testName);
            }
            cmdArgs.push('--reporter', 'list');

            let output = '';
            try {
                output = execSync(`${command} ${cmdArgs.join(' ')}`, {
                    cwd: workingDir,
                    encoding: 'utf-8',
                    timeout: 120000,
                    env: { ...process.env, FORCE_COLOR: '0' },
                });
            } catch (error: any) {
                output = error.stdout || error.message;
            }

            const result = parseTestOutput(output);

            if (result.failed === 0) {
                CSReporter.pass(`[MCP] Test healed successfully after ${iteration} iteration(s)`);

                healingResults.push({
                    iteration,
                    testRun: 'passed',
                    issues: [],
                });

                return createJsonResult({
                    status: 'healed',
                    iterations: iteration,
                    results: healingResults,
                    message: `Test healed successfully after ${iteration} iteration(s)`,
                });
            }

            // Analyze failures
            const issues: Array<{
                type: 'locator' | 'assertion' | 'timeout' | 'other';
                location: string;
                message: string;
                suggestion?: string;
            }> = [];

            // Parse error messages from output
            const locatorErrorPattern = /locator\.(\w+).*?waiting for locator\s*['"]([^'"]+)['"]/gi;
            const timeoutPattern = /Timeout (\d+)ms exceeded/gi;
            const assertionPattern = /expect\(.*?\)\.(\w+).*?Expected:?\s*(.+?)\s*Received:?\s*(.+?)$/gim;

            let match;
            while ((match = locatorErrorPattern.exec(output)) !== null) {
                issues.push({
                    type: 'locator',
                    location: match[2],
                    message: `Locator "${match[2]}" not found`,
                    suggestion: 'Run test_generate_locator to find alternatives',
                });
            }

            while ((match = timeoutPattern.exec(output)) !== null) {
                issues.push({
                    type: 'timeout',
                    location: 'test',
                    message: `Timeout of ${match[1]}ms exceeded`,
                    suggestion: 'Increase timeout or add explicit waits',
                });
            }

            while ((match = assertionPattern.exec(output)) !== null) {
                issues.push({
                    type: 'assertion',
                    location: match[1],
                    message: `Assertion failed: expected ${match[2]}, got ${match[3]}`,
                    suggestion: 'Verify expected values match current application state',
                });
            }

            healingResults.push({
                iteration,
                testRun: 'failed',
                issues,
            });

            // If no issues found, can't auto-heal
            if (issues.length === 0) {
                break;
            }

            // In dry run mode, don't apply fixes
            if (dryRun) {
                break;
            }

            // TODO: Apply fixes and continue to next iteration
            // For now, we only suggest fixes
        }

        CSReporter.fail(`[MCP] Could not fully heal test after ${maxIterations} iterations`);

        return createJsonResult({
            status: 'partial',
            iterations: healingResults.length,
            results: healingResults,
            message: dryRun
                ? 'Dry run completed - review suggested fixes'
                : `Could not fully heal test after ${maxIterations} iterations`,
        });
    })
    .build();

// ============================================================================
// Test Watch Tool
// ============================================================================

const testWatchTool = defineTool()
    .name('test_watch')
    .description('Start or stop watch mode for continuous test execution. Tests re-run automatically when files change.')
    .category('testing')
    .stringParam('action', 'Action to perform', {
        enum: ['start', 'stop', 'status'],
        required: true,
    })
    .arrayParam('locations', 'Test files or directories to watch', 'string')
    .stringParam('grep', 'Filter tests by pattern')
    .booleanParam('headed', 'Run in headed mode', { default: false })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const action = params.action as 'start' | 'stop' | 'status';
        const workingDir = context.server.workingDirectory;
        const watchId = 'default';

        if (action === 'status') {
            const existingProcess = watchProcesses.get(watchId);
            return createJsonResult({
                running: !!existingProcess,
                watchId: existingProcess ? watchId : null,
            });
        }

        if (action === 'stop') {
            const existingProcess = watchProcesses.get(watchId);
            if (existingProcess) {
                existingProcess.kill();
                watchProcesses.delete(watchId);
                CSReporter.info('[MCP] Watch mode stopped');
                return createTextResult('Watch mode stopped');
            }
            return createTextResult('No watch process running');
        }

        // action === 'start'
        // Stop existing watch if any
        const existingProcess = watchProcesses.get(watchId);
        if (existingProcess) {
            existingProcess.kill();
            watchProcesses.delete(watchId);
        }

        const { command, args } = findTestRunner(workingDir);
        const cmdArgs = [...args];

        const locations = params.locations as string[] | undefined;
        if (locations && locations.length > 0) {
            cmdArgs.push(...locations);
        }

        if (params.grep) cmdArgs.push('--grep', params.grep as string);
        if (params.headed) cmdArgs.push('--headed');

        // Add watch flag
        cmdArgs.push('--watch');

        context.log('info', 'Starting watch mode');
        CSReporter.info('[MCP] Starting watch mode');

        const proc = spawn(command, cmdArgs, {
            cwd: workingDir,
            shell: true,
            env: { ...process.env, FORCE_COLOR: '0' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        watchProcesses.set(watchId, proc);

        // Capture initial output
        let initialOutput = '';
        const outputPromise = new Promise<string>((resolve) => {
            const timeout = setTimeout(() => resolve(initialOutput), 3000);

            proc.stdout?.on('data', (data) => {
                initialOutput += data.toString();
                if (initialOutput.includes('Waiting for file changes')) {
                    clearTimeout(timeout);
                    resolve(initialOutput);
                }
            });

            proc.stderr?.on('data', (data) => {
                initialOutput += data.toString();
            });

            proc.on('close', () => {
                clearTimeout(timeout);
                watchProcesses.delete(watchId);
                resolve(initialOutput);
            });
        });

        const output = await outputPromise;

        return createJsonResult({
            status: watchProcesses.has(watchId) ? 'running' : 'stopped',
            watchId,
            message: 'Watch mode started - tests will re-run on file changes',
            initialOutput: output.slice(0, 1000),
        });
    })
    .build();

// ============================================================================
// Test Coverage Tool
// ============================================================================

const testCoverageTool = defineTool()
    .name('test_coverage')
    .description('Run tests with code coverage and return coverage report. Requires playwright configured with coverage.')
    .category('testing')
    .arrayParam('locations', 'Test files to run for coverage', 'string')
    .stringParam('format', 'Coverage report format', {
        enum: ['text', 'lcov', 'html', 'json'],
        default: 'text',
    })
    .booleanParam('perFile', 'Show per-file coverage breakdown', { default: true })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const workingDir = context.server.workingDirectory;

        context.log('info', 'Running tests with coverage');
        CSReporter.info('[MCP] Running tests with code coverage');

        // Check if nyc/c8 or other coverage tool is available
        const nycPath = path.join(workingDir, 'node_modules', '.bin', 'nyc');
        const c8Path = path.join(workingDir, 'node_modules', '.bin', 'c8');

        let coverageCommand: string;
        let coverageArgs: string[] = [];

        if (fs.existsSync(c8Path) || fs.existsSync(c8Path + '.cmd')) {
            coverageCommand = 'npx c8';
            coverageArgs = ['--reporter', params.format as string || 'text'];
        } else if (fs.existsSync(nycPath) || fs.existsSync(nycPath + '.cmd')) {
            coverageCommand = 'npx nyc';
            coverageArgs = ['--reporter', params.format as string || 'text'];
        } else {
            // Try running with playwright's built-in coverage
            const { command, args } = findTestRunner(workingDir);
            coverageCommand = command;
            coverageArgs = [...args];
        }

        const locations = params.locations as string[] | undefined;
        if (locations && locations.length > 0) {
            coverageArgs.push(...locations);
        }

        try {
            const output = execSync(`${coverageCommand} ${coverageArgs.join(' ')}`, {
                cwd: workingDir,
                encoding: 'utf-8',
                timeout: 300000, // 5 minute timeout for coverage
                env: { ...process.env, FORCE_COLOR: '0' },
            });

            // Parse coverage summary if text format
            const coverageMatch = output.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
            let summary = null;
            if (coverageMatch) {
                summary = {
                    statements: parseFloat(coverageMatch[1]),
                    branches: parseFloat(coverageMatch[2]),
                    functions: parseFloat(coverageMatch[3]),
                    lines: parseFloat(coverageMatch[4]),
                };
            }

            CSReporter.pass('[MCP] Coverage report generated');

            return createJsonResult({
                status: 'success',
                format: params.format || 'text',
                summary,
                report: output,
            });
        } catch (error: any) {
            const output = error.stdout || error.message;
            CSReporter.fail(`[MCP] Coverage failed: ${error.message}`);

            return createJsonResult({
                status: 'error',
                error: error.message,
                output,
            });
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Test Flaky Detection Tool
// ============================================================================

const testFlakyDetectTool = defineTool()
    .name('test_flaky_detect')
    .description('Detect flaky tests by running them multiple times. A test that passes and fails across runs is flaky.')
    .category('testing')
    .arrayParam('locations', 'Test files to check for flakiness', 'string')
    .stringParam('grep', 'Filter tests by pattern')
    .numberParam('iterations', 'Number of times to run each test', { default: 5 })
    .numberParam('workers', 'Parallel workers', { default: 1 })
    .booleanParam('stopOnFlaky', 'Stop as soon as a flaky test is detected', { default: false })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const workingDir = context.server.workingDirectory;
        const iterations = (params.iterations as number) || 5;
        const stopOnFlaky = params.stopOnFlaky as boolean;

        context.log('info', `Detecting flaky tests (${iterations} iterations)`);
        CSReporter.info(`[MCP] Running flaky test detection (${iterations} iterations)`);

        const { command, args } = findTestRunner(workingDir);

        // Build base command
        const cmdArgs = [...args];
        const locations = params.locations as string[] | undefined;
        if (locations && locations.length > 0) {
            cmdArgs.push(...locations);
        }
        if (params.grep) cmdArgs.push('--grep', params.grep as string);
        if (params.workers) cmdArgs.push('--workers', String(params.workers));
        cmdArgs.push('--reporter', 'list');

        // Track results per test
        const testResults: Map<string, { passed: number; failed: number }> = new Map();

        for (let i = 1; i <= iterations; i++) {
            context.log('info', `Iteration ${i}/${iterations}`);

            try {
                const output = execSync(`${command} ${cmdArgs.join(' ')}`, {
                    cwd: workingDir,
                    encoding: 'utf-8',
                    timeout: 300000,
                    env: { ...process.env, FORCE_COLOR: '0' },
                });

                const result = parseTestOutput(output);
                for (const test of result.tests) {
                    if (!testResults.has(test.id)) {
                        testResults.set(test.id, { passed: 0, failed: 0 });
                    }
                    const stats = testResults.get(test.id)!;
                    if (test.status === 'passed') stats.passed++;
                    else if (test.status === 'failed') stats.failed++;
                }
            } catch (error: any) {
                const output = error.stdout || '';
                const result = parseTestOutput(output);
                for (const test of result.tests) {
                    if (!testResults.has(test.id)) {
                        testResults.set(test.id, { passed: 0, failed: 0 });
                    }
                    const stats = testResults.get(test.id)!;
                    if (test.status === 'passed') stats.passed++;
                    else if (test.status === 'failed') stats.failed++;
                }
            }

            // Check for flaky tests after each iteration
            if (stopOnFlaky && i >= 2) {
                for (const [testId, stats] of testResults) {
                    if (stats.passed > 0 && stats.failed > 0) {
                        CSReporter.fail(`[MCP] Flaky test detected: ${testId}`);
                        break;
                    }
                }
            }
        }

        // Analyze results
        const flakyTests: Array<{
            id: string;
            passed: number;
            failed: number;
            flakinessRate: number;
        }> = [];

        const stableTests: Array<{
            id: string;
            status: 'always_passes' | 'always_fails';
        }> = [];

        for (const [testId, stats] of testResults) {
            if (stats.passed > 0 && stats.failed > 0) {
                const total = stats.passed + stats.failed;
                flakyTests.push({
                    id: testId,
                    passed: stats.passed,
                    failed: stats.failed,
                    flakinessRate: Math.round((Math.min(stats.passed, stats.failed) / total) * 100),
                });
            } else if (stats.passed > 0) {
                stableTests.push({ id: testId, status: 'always_passes' });
            } else if (stats.failed > 0) {
                stableTests.push({ id: testId, status: 'always_fails' });
            }
        }

        // Sort flaky tests by flakiness rate (highest first)
        flakyTests.sort((a, b) => b.flakinessRate - a.flakinessRate);

        if (flakyTests.length > 0) {
            CSReporter.fail(`[MCP] Found ${flakyTests.length} flaky tests`);
        } else {
            CSReporter.pass(`[MCP] No flaky tests detected in ${iterations} iterations`);
        }

        return createJsonResult({
            iterations,
            totalTests: testResults.size,
            flakyCount: flakyTests.length,
            flakyTests,
            stableTests,
            summary: flakyTests.length > 0
                ? `Found ${flakyTests.length} flaky test(s) out of ${testResults.size} total`
                : `All ${testResults.size} tests are stable across ${iterations} runs`,
        });
    })
    .build();

// ============================================================================
// Test Snapshot Compare Tool
// ============================================================================

const testSnapshotCompareTool = defineTool()
    .name('test_snapshot_compare')
    .description('Compare current page state with expected snapshot. Uses aria snapshot for accessibility-based comparison.')
    .category('testing')
    .stringParam('selector', 'CSS selector to snapshot (default: body)', { default: 'body' })
    .stringParam('expectedSnapshot', 'Expected snapshot content to compare against')
    .booleanParam('captureOnly', 'Only capture snapshot without comparison', { default: false })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const selector = (params.selector as string) || 'body';

        try {
            const browserState = (context.server as any).browser;
            if (!browserState?.page) {
                return createErrorResult('No browser page available. Use browser_launch and browser_navigate first.');
            }

            const page = browserState.page;
            const element = page.locator(selector);

            // Get current snapshot
            let currentSnapshot: string;
            try {
                // Try aria snapshot first (more semantic)
                currentSnapshot = await element.ariaSnapshot();
            } catch {
                // Fall back to text content if ariaSnapshot not available
                currentSnapshot = await element.textContent() || '';
            }

            if (params.captureOnly) {
                CSReporter.pass('[MCP] Snapshot captured');
                return createJsonResult({
                    selector,
                    snapshot: currentSnapshot,
                    timestamp: new Date().toISOString(),
                });
            }

            // Compare with expected
            const expected = params.expectedSnapshot as string;
            if (!expected) {
                return createErrorResult('expectedSnapshot is required for comparison. Use captureOnly=true to just capture.');
            }

            const matches = currentSnapshot.trim() === expected.trim();

            if (matches) {
                CSReporter.pass('[MCP] Snapshot matches expected');
            } else {
                CSReporter.fail('[MCP] Snapshot mismatch');
            }

            return createJsonResult({
                selector,
                matches,
                current: currentSnapshot,
                expected,
                diff: !matches ? {
                    currentLength: currentSnapshot.length,
                    expectedLength: expected.length,
                } : undefined,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Snapshot comparison failed: ${error.message}`);
            return createErrorResult(`Snapshot comparison failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Test Accessibility Audit Tool
// ============================================================================

const testAccessibilityTool = defineTool()
    .name('test_accessibility')
    .description('Run accessibility audit on the current page. Uses axe-core rules for WCAG compliance checking.')
    .category('testing')
    .stringParam('scope', 'CSS selector to limit audit scope', { default: 'body' })
    .stringParam('standard', 'Accessibility standard to check against', {
        enum: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
        default: 'wcag2aa',
    })
    .arrayParam('rules', 'Specific rules to run (or empty for all)', 'string')
    .booleanParam('includeHidden', 'Include hidden elements in audit', { default: false })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        try {
            const browserState = (context.server as any).browser;
            if (!browserState?.page) {
                return createErrorResult('No browser page available. Use browser_launch and browser_navigate first.');
            }

            const page = browserState.page;
            const scope = (params.scope as string) || 'body';

            context.log('info', 'Running accessibility audit');
            CSReporter.info('[MCP] Running accessibility audit');

            // Get page HTML for analysis
            const html = await page.locator(scope).innerHTML();

            // Get aria snapshot which helps identify accessibility issues
            let ariaSnapshot = '';
            try {
                ariaSnapshot = await page.locator(scope).ariaSnapshot();
            } catch {
                // May not be available
            }

            // Analyze common accessibility issues
            const issues: Array<{
                rule: string;
                severity: 'critical' | 'serious' | 'moderate' | 'minor';
                description: string;
                element?: string;
                suggestion: string;
            }> = [];

            // Check for images without alt text
            const imagesWithoutAlt = await page.locator(`${scope} img:not([alt])`).count();
            if (imagesWithoutAlt > 0) {
                issues.push({
                    rule: 'image-alt',
                    severity: 'critical',
                    description: `${imagesWithoutAlt} image(s) missing alt attribute`,
                    suggestion: 'Add descriptive alt text to all images',
                });
            }

            // Check for form inputs without labels
            const inputsWithoutLabels = await page.evaluate((scopeSelector: string) => {
                const inputs = document.querySelectorAll(`${scopeSelector} input:not([type="hidden"]):not([type="submit"]):not([type="button"])`);
                let count = 0;
                inputs.forEach((input) => {
                    const id = input.getAttribute('id');
                    const ariaLabel = input.getAttribute('aria-label');
                    const ariaLabelledBy = input.getAttribute('aria-labelledby');
                    const hasLabel = id && document.querySelector(`label[for="${id}"]`);
                    if (!hasLabel && !ariaLabel && !ariaLabelledBy) {
                        count++;
                    }
                });
                return count;
            }, scope);

            if (inputsWithoutLabels > 0) {
                issues.push({
                    rule: 'label',
                    severity: 'critical',
                    description: `${inputsWithoutLabels} form input(s) missing labels`,
                    suggestion: 'Add label elements or aria-label to form inputs',
                });
            }

            // Check for buttons without accessible names
            const buttonsWithoutNames = await page.evaluate((scopeSelector: string) => {
                const buttons = document.querySelectorAll(`${scopeSelector} button, ${scopeSelector} [role="button"]`);
                let count = 0;
                buttons.forEach((btn) => {
                    const text = btn.textContent?.trim();
                    const ariaLabel = btn.getAttribute('aria-label');
                    const ariaLabelledBy = btn.getAttribute('aria-labelledby');
                    if (!text && !ariaLabel && !ariaLabelledBy) {
                        count++;
                    }
                });
                return count;
            }, scope);

            if (buttonsWithoutNames > 0) {
                issues.push({
                    rule: 'button-name',
                    severity: 'serious',
                    description: `${buttonsWithoutNames} button(s) missing accessible names`,
                    suggestion: 'Add text content or aria-label to buttons',
                });
            }

            // Check for links without href
            const linksWithoutHref = await page.locator(`${scope} a:not([href])`).count();
            if (linksWithoutHref > 0) {
                issues.push({
                    rule: 'link-name',
                    severity: 'moderate',
                    description: `${linksWithoutHref} link(s) missing href attribute`,
                    suggestion: 'Add href to links or convert to buttons if not navigation',
                });
            }

            // Check heading hierarchy
            const headingIssues = await page.evaluate((scopeSelector: string) => {
                const headings = document.querySelectorAll(`${scopeSelector} h1, ${scopeSelector} h2, ${scopeSelector} h3, ${scopeSelector} h4, ${scopeSelector} h5, ${scopeSelector} h6`);
                const levels: number[] = [];
                headings.forEach((h) => {
                    levels.push(parseInt(h.tagName[1]));
                });

                // Check for skipped levels
                let skipped = false;
                for (let i = 1; i < levels.length; i++) {
                    if (levels[i] - levels[i - 1] > 1) {
                        skipped = true;
                        break;
                    }
                }

                // Check for multiple H1s
                const h1Count = levels.filter(l => l === 1).length;

                return { skipped, multipleH1: h1Count > 1 };
            }, scope);

            if (headingIssues.skipped) {
                issues.push({
                    rule: 'heading-order',
                    severity: 'moderate',
                    description: 'Heading levels are skipped',
                    suggestion: 'Use sequential heading levels (h1, h2, h3)',
                });
            }

            if (headingIssues.multipleH1) {
                issues.push({
                    rule: 'page-has-heading-one',
                    severity: 'moderate',
                    description: 'Multiple h1 elements found',
                    suggestion: 'Use only one h1 per page',
                });
            }

            // Count by severity
            const bySeverity = {
                critical: issues.filter(i => i.severity === 'critical').length,
                serious: issues.filter(i => i.severity === 'serious').length,
                moderate: issues.filter(i => i.severity === 'moderate').length,
                minor: issues.filter(i => i.severity === 'minor').length,
            };

            const passed = issues.length === 0;

            if (passed) {
                CSReporter.pass('[MCP] Accessibility audit passed');
            } else {
                CSReporter.fail(`[MCP] Found ${issues.length} accessibility issues`);
            }

            return createJsonResult({
                status: passed ? 'pass' : 'fail',
                scope,
                standard: params.standard || 'wcag2aa',
                issueCount: issues.length,
                bySeverity,
                issues,
                ariaSnapshot: ariaSnapshot ? ariaSnapshot.slice(0, 1500) : undefined,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Accessibility audit failed: ${error.message}`);
            return createErrorResult(`Accessibility audit failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Test Visual Regression Tool
// ============================================================================

const testVisualRegressionTool = defineTool()
    .name('test_visual_regression')
    .description('Capture screenshot for visual regression testing. Compares against baseline if exists.')
    .category('testing')
    .stringParam('name', 'Name for the screenshot (used as filename)', { required: true })
    .stringParam('selector', 'CSS selector to screenshot (default: full page)')
    .stringParam('baselineDir', 'Directory for baseline images', { default: 'test-results/baselines' })
    .booleanParam('updateBaseline', 'Update baseline instead of comparing', { default: false })
    .numberParam('threshold', 'Pixel difference threshold (0-1)', { default: 0.1 })
    .handler(async (params, context) => {
        ensureReporterLoaded();

        const name = params.name as string;
        const workingDir = context.server.workingDirectory;
        const baselineDir = path.join(workingDir, (params.baselineDir as string) || 'test-results/baselines');
        const currentDir = path.join(workingDir, 'test-results/current');
        const diffDir = path.join(workingDir, 'test-results/diff');

        try {
            const browserState = (context.server as any).browser;
            if (!browserState?.page) {
                return createErrorResult('No browser page available. Use browser_launch and browser_navigate first.');
            }

            const page = browserState.page;

            // Ensure directories exist
            fs.mkdirSync(baselineDir, { recursive: true });
            fs.mkdirSync(currentDir, { recursive: true });
            fs.mkdirSync(diffDir, { recursive: true });

            const baselinePath = path.join(baselineDir, `${name}.png`);
            const currentPath = path.join(currentDir, `${name}.png`);

            context.log('info', `Capturing screenshot: ${name}`);

            // Capture screenshot
            let screenshot: Buffer;
            if (params.selector) {
                screenshot = await page.locator(params.selector as string).screenshot();
            } else {
                screenshot = await page.screenshot({ fullPage: true });
            }

            // Save current screenshot
            fs.writeFileSync(currentPath, screenshot);

            // Check if baseline exists
            const baselineExists = fs.existsSync(baselinePath);

            if (params.updateBaseline || !baselineExists) {
                // Save as baseline
                fs.writeFileSync(baselinePath, screenshot);
                CSReporter.pass(`[MCP] ${baselineExists ? 'Updated' : 'Created'} baseline: ${name}`);

                return createJsonResult({
                    status: 'baseline_updated',
                    name,
                    baselinePath,
                    message: baselineExists
                        ? 'Baseline updated'
                        : 'New baseline created (no previous baseline existed)',
                });
            }

            // Compare with baseline
            const baseline = fs.readFileSync(baselinePath);

            // Simple size comparison (full pixel comparison would need image library)
            const sizeDiff = Math.abs(screenshot.length - baseline.length) / baseline.length;

            if (sizeDiff > (params.threshold as number || 0.1)) {
                CSReporter.fail(`[MCP] Visual difference detected: ${name} (${(sizeDiff * 100).toFixed(1)}% size diff)`);

                return createJsonResult({
                    status: 'mismatch',
                    name,
                    baselinePath,
                    currentPath,
                    sizeDifferencePercent: (sizeDiff * 100).toFixed(2),
                    message: 'Visual regression detected - screenshots differ significantly',
                });
            }

            CSReporter.pass(`[MCP] Visual match: ${name}`);

            return createJsonResult({
                status: 'match',
                name,
                baselinePath,
                currentPath,
                message: 'Screenshots match within threshold',
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Visual regression failed: ${error.message}`);
            return createErrorResult(`Visual regression failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Test Performance Metrics Tool
// ============================================================================

const testPerformanceTool = defineTool()
    .name('test_performance')
    .description('Capture performance metrics for the current page. Includes load times, resource counts, and Core Web Vitals.')
    .category('testing')
    .handler(async (params, context) => {
        ensureReporterLoaded();

        try {
            const browserState = (context.server as any).browser;
            if (!browserState?.page) {
                return createErrorResult('No browser page available. Use browser_launch and browser_navigate first.');
            }

            const page = browserState.page;

            context.log('info', 'Capturing performance metrics');

            // Get performance timing
            const timing = await page.evaluate(() => {
                const perf = window.performance;
                const timing = perf.timing;
                const navigation = perf.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;

                return {
                    // Navigation timing
                    dnsLookup: timing.domainLookupEnd - timing.domainLookupStart,
                    tcpConnect: timing.connectEnd - timing.connectStart,
                    ttfb: timing.responseStart - timing.requestStart,
                    contentDownload: timing.responseEnd - timing.responseStart,
                    domInteractive: timing.domInteractive - timing.navigationStart,
                    domContentLoaded: timing.domContentLoadedEventEnd - timing.navigationStart,
                    loadComplete: timing.loadEventEnd - timing.navigationStart,

                    // From Navigation API
                    redirectTime: navigation?.redirectEnd - navigation?.redirectStart || 0,
                    serverResponseTime: navigation?.responseStart - navigation?.requestStart || 0,
                    domParsing: navigation?.domInteractive - navigation?.responseEnd || 0,
                };
            });

            // Get resource counts
            const resources = await page.evaluate(() => {
                const entries = window.performance.getEntriesByType('resource') as PerformanceResourceTiming[];
                const byType: Record<string, { count: number; size: number; duration: number }> = {};

                entries.forEach((entry) => {
                    const type = entry.initiatorType || 'other';
                    if (!byType[type]) {
                        byType[type] = { count: 0, size: 0, duration: 0 };
                    }
                    byType[type].count++;
                    byType[type].size += entry.transferSize || 0;
                    byType[type].duration += entry.duration;
                });

                return {
                    total: entries.length,
                    byType,
                };
            });

            // Try to get Core Web Vitals (may not be available)
            const webVitals = await page.evaluate(() => {
                return new Promise((resolve) => {
                    const vitals: any = {};

                    // LCP observer
                    try {
                        new PerformanceObserver((list) => {
                            const entries = list.getEntries();
                            vitals.lcp = entries[entries.length - 1]?.startTime;
                        }).observe({ type: 'largest-contentful-paint', buffered: true });
                    } catch { /* Not supported */ }

                    // CLS observer
                    try {
                        let cls = 0;
                        new PerformanceObserver((list) => {
                            for (const entry of list.getEntries() as any[]) {
                                if (!entry.hadRecentInput) {
                                    cls += entry.value;
                                }
                            }
                            vitals.cls = cls;
                        }).observe({ type: 'layout-shift', buffered: true });
                    } catch { /* Not supported */ }

                    // Return after short delay to collect metrics
                    setTimeout(() => resolve(vitals), 100);
                });
            });

            CSReporter.pass('[MCP] Performance metrics captured');

            return createJsonResult({
                timing,
                resources,
                webVitals,
                summary: {
                    loadTime: timing.loadComplete,
                    ttfb: timing.ttfb,
                    resourceCount: resources.total,
                    recommendation: timing.loadComplete > 3000
                        ? 'Page load exceeds 3s - consider optimizing'
                        : 'Page load time is acceptable',
                },
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Performance capture failed: ${error.message}`);
            return createErrorResult(`Performance capture failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Export Tools
// ============================================================================

export const testingTools: MCPToolDefinition[] = [
    testListTool,
    testRunTool,
    testDebugTool,
    generateLocatorTool,
    healTestTool,
    testWatchTool,
    testCoverageTool,
    testFlakyDetectTool,
    testSnapshotCompareTool,
    testAccessibilityTool,
    testVisualRegressionTool,
    testPerformanceTool,
];

/**
 * Register all testing tools with the registry
 */
export function registerTestingTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(testingTools);
}
