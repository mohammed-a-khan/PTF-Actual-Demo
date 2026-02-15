/**
 * CS Codegen Orchestrator - The Brain that Coordinates Everything
 *
 * This orchestrator:
 * 1. Spawns Playwright codegen process
 * 2. Watches for generated files
 * 3. Orchestrates all intelligence layers
 * 4. Generates optimal CS Framework code
 * 5. Provides real-time feedback
 */

import { spawn, ChildProcess } from 'child_process';
import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ora, { Ora } from 'ora';
import chalk from 'chalk';
import { AdvancedASTParser } from '../parser/ASTParser';
import { SymbolicExecutionEngine } from '../analyzer/SymbolicExecutionEngine';
import { DirectCodeGenerator } from '../generator/DirectCodeGenerator';
import { GeneratedCSCode } from '../types';

export interface OrchestratorOptions {
    url?: string;
    outputDir?: string;
    watchDir?: string;
    verbose?: boolean;
}

export class CodegenOrchestrator {
    private parser: AdvancedASTParser;
    private symbolicEngine: SymbolicExecutionEngine;
    private codeGenerator: DirectCodeGenerator;
    private watcher?: chokidar.FSWatcher;
    private playwrightProcess?: ChildProcess;
    private spinner?: Ora;
    private options: OrchestratorOptions;

    constructor(options: OrchestratorOptions = {}) {
        // Use framework's .temp directory instead of system temp
        const defaultWatchDir = path.resolve(process.cwd(), '.temp', 'codegen');

        // Set defaults first, then apply user options
        this.options = {
            outputDir: './codegen',
            watchDir: defaultWatchDir,
            verbose: false,
            ...options  // User options override defaults
        };

        // Initialize code generation system
        this.parser = new AdvancedASTParser();
        this.symbolicEngine = new SymbolicExecutionEngine();
        this.codeGenerator = new DirectCodeGenerator();
    }

    /**
     * Start the intelligent codegen system
     */
    public async start(): Promise<void> {
        console.log(chalk.cyan.bold('\n🚀 CS Framework Test Codegen'));
        console.log(chalk.gray('━'.repeat(50)));
        console.log(chalk.white('Intelligent test conversion starting...\n'));

        // Ensure watch directory exists
        this.ensureWatchDirectory();

        // Display instructions
        this.displayInstructions();

        // Start file watcher first
        await this.startFileWatcher();

        // Spawn Playwright codegen
        await this.spawnPlaywrightCodegen();

        // Keep process alive
        this.keepAlive();
    }

    /**
     * Display user instructions
     */
    private displayInstructions(): void {
        console.log(chalk.yellow('📝 Instructions:'));
        console.log(chalk.white('   1. Record your test actions in the browser'));
        console.log(chalk.white('   2. Press Ctrl+C when done (closes everything automatically)'));
        console.log(chalk.white('   3. Your CS Framework code will be generated\n'));
    }

    /**
     * Ensure watch directory exists
     */
    private ensureWatchDirectory(): void {
        const watchDir = this.options.watchDir!;
        if (!fs.existsSync(watchDir)) {
            fs.mkdirSync(watchDir, { recursive: true });
            if (this.options.verbose) {
                console.log(chalk.gray(`📁 Created watch directory: ${watchDir}`));
            }
        }
    }

    /**
     * Start file system watcher
     */
    private async startFileWatcher(): Promise<void> {
        const watchDir = this.options.watchDir!;

        console.log(chalk.blue('👀 Watching for test recordings...'));
        console.log(chalk.gray(`   Output: ${watchDir}\n`));

        this.watcher = chokidar.watch(`${watchDir}/*.spec.ts`, {
            persistent: true,
            ignoreInitial: false, // CHANGED: Watch existing files too
            awaitWriteFinish: {
                stabilityThreshold: 2000, // CHANGED: Wait 2 seconds after last change for better stability
                pollInterval: 100
            },
            usePolling: true, // ADDED: Use polling for better reliability on Windows/WSL
            interval: 300 // ADDED: Poll every 300ms
        });

        let isFirstEvent = true; // Track if this is the initial file creation

        this.watcher.on('add', async (filePath: string) => {
            if (this.options.verbose) {
                console.log(chalk.gray(`   📄 File added: ${path.basename(filePath)}`));
            }
            // Skip the initial empty file creation by Playwright
            if (isFirstEvent) {
                isFirstEvent = false;
                if (this.options.verbose) {
                    console.log(chalk.gray(`   ⏭️  Skipping initial file, waiting for your recording...`));
                }
                return;
            }
            await this.handleNewFile(filePath);
        });

        this.watcher.on('change', async (filePath: string) => {
            if (this.options.verbose) {
                console.log(chalk.gray(`   📝 File changed: ${path.basename(filePath)}`));
            }
            await this.handleNewFile(filePath);
        });

        this.watcher.on('error', (error: unknown) => {
            console.error(chalk.red('❌ Watcher error:'), error);
        });

        if (this.options.verbose) {
            this.watcher.on('ready', () => {
                console.log(chalk.gray('   ✓ File watcher ready'));
            });
        }
    }

    /**
     * Handle new or changed file
     */
    private async handleNewFile(filePath: string): Promise<void> {
        try {
            console.log(chalk.yellow('\n⚡ New test detected!'));
            console.log(chalk.gray(`   File: ${path.basename(filePath)}\n`));

            // Read source code
            const sourceCode = fs.readFileSync(filePath, 'utf-8');

            if (!sourceCode || sourceCode.trim().length === 0) {
                if (this.options.verbose) {
                    console.log(chalk.gray('   ⏳ File is empty, waiting for content...'));
                }
                return;
            }

            // Start transformation
            await this.transformToCSFramework(sourceCode, filePath);

        } catch (error) {
            console.error(chalk.red('❌ Error processing file:'), error);
        }
    }

    /**
     * Transform Playwright code to CS Framework code using ALL intelligence
     */
    private async transformToCSFramework(sourceCode: string, originalFilePath: string): Promise<void> {
        try {
            // Parse and extract actions from recorded test
            this.spinner = ora(chalk.cyan('🔍 Analyzing recorded test...')).start();
            const analysis = this.parser.parse(sourceCode);
            this.spinner.succeed(chalk.green(`✅ Found ${analysis.actions.length} test actions`));

            if (this.options.verbose) {
                console.log(chalk.gray(`   Actions: ${analysis.actions.map(a => a.type).join(', ')}`));
            }

            // Generate CS Framework code using DIRECT conversion
            // Simple, accurate conversion: Action → Element + Method + Gherkin
            this.spinner = ora(chalk.cyan('🔨 Converting actions to CS Framework code...')).start();
            const generatedCode = await this.codeGenerator.generate(analysis.actions);
            this.spinner.succeed(chalk.green('✅ Code generation complete!'));

            // Write generated files
            this.spinner = ora(chalk.cyan('📝 Writing CS Framework files...')).start();
            await this.writeGeneratedCode(generatedCode);
            this.spinner.succeed(chalk.green('✅ All files written successfully!'));

            // Summary
            this.printIntelligentSummary(generatedCode);

        } catch (error) {
            if (this.spinner) {
                this.spinner.fail(chalk.red('❌ Transformation failed'));
            }
            console.error(chalk.red('Error details:'), error);
            if (error instanceof Error) {
                console.error(chalk.gray(error.stack));
            }
        }
    }

    /**
     * Extract feature name from intent (ignore file path)
     */
    private extractFeatureName(filePath: string, intentType: string): string {
        // Always use intent-based naming for clarity
        const nameMap: Record<string, string> = {
            'authentication': 'User Authentication',
            'crud': 'Data Management',
            'form-interaction': 'Form Submission',
            'navigation': 'Application Navigation',
            'verification': 'Data Verification'
        };

        return nameMap[intentType] || 'Test Feature';
    }

    /**
     * Write generated code to file system
     * Structure: codegen/test/{pages,steps,features,data} and codegen/config
     */
    private async writeGeneratedCode(code: GeneratedCSCode): Promise<void> {
        const outputDir = this.options.outputDir!;

        // Ensure directories exist with new structure
        // Test artifacts go under test/ subdirectory
        const testDir = path.join(outputDir, 'test');
        const featureDir = path.join(testDir, 'features');
        const pageDir = path.join(testDir, 'pages');
        const stepDir = path.join(testDir, 'steps');
        const dataDir = path.join(testDir, 'data');

        // Config stays at top level
        const configDir = path.join(outputDir, 'config');
        const commonConfigDir = path.join(configDir, 'common');
        const envConfigDir = path.join(configDir, 'environments');

        // Always create feature, page, step, data, and config directories
        [featureDir, pageDir, stepDir, dataDir, configDir, commonConfigDir, envConfigDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        // Data directory replaces components
        const componentDir = dataDir;

        // Write Feature files (may have multiple)
        const features = code.features || [code.feature];
        for (const feature of features) {
            const featurePath = path.join(featureDir, feature.fileName);
            fs.writeFileSync(featurePath, feature.content, 'utf-8');
            console.log(chalk.gray(`   ✓ ${feature.fileName}`));
        }

        // Write Page Objects
        for (const pageObject of code.pageObjects) {
            const pagePath = path.join(pageDir, pageObject.fileName);
            fs.writeFileSync(pagePath, pageObject.content, 'utf-8');
            console.log(chalk.gray(`   ✓ ${pageObject.fileName}`));
        }

        // Write Step Definitions
        for (const stepDef of code.stepDefinitions) {
            const stepPath = path.join(stepDir, stepDef.fileName);
            fs.writeFileSync(stepPath, stepDef.content, 'utf-8');
            console.log(chalk.gray(`   ✓ ${stepDef.fileName}`));
        }

        // Write Components (NavigationComponent, etc.)
        if (code.components && code.components.length > 0) {
            for (const component of code.components) {
                const componentPath = path.join(componentDir, component.fileName);
                fs.writeFileSync(componentPath, component.content, 'utf-8');
                console.log(chalk.gray(`   ✓ ${component.fileName}`));
            }
        }

        // Generate and write config files
        await this.writeConfigFiles(configDir, commonConfigDir, envConfigDir);
    }

    /**
     * Write configuration files for the generated project
     */
    private async writeConfigFiles(configDir: string, commonConfigDir: string, envConfigDir: string): Promise<void> {
        // Extract project info from URL
        const urlInfo = this.extractUrlInfo(this.options.url);

        // Write global.env
        const globalEnvPath = path.join(configDir, 'global.env');
        fs.writeFileSync(globalEnvPath, this.generateGlobalEnv(urlInfo), 'utf-8');
        console.log(chalk.gray(`   ✓ config/global.env`));

        // Write common/common.env
        const commonEnvPath = path.join(commonConfigDir, 'common.env');
        fs.writeFileSync(commonEnvPath, this.generateCommonEnv(urlInfo), 'utf-8');
        console.log(chalk.gray(`   ✓ config/common/common.env`));

        // Write environment files
        const environments = ['dev', 'qa', 'uat'];
        for (const env of environments) {
            const envPath = path.join(envConfigDir, `${env}.env`);
            fs.writeFileSync(envPath, this.generateEnvironmentEnv(urlInfo, env), 'utf-8');
            console.log(chalk.gray(`   ✓ config/environments/${env}.env`));
        }
    }

    /**
     * Extract project information from URL
     */
    private extractUrlInfo(url?: string): { baseUrl: string; projectName: string; domain: string; protocol: string } {
        if (!url) {
            return {
                baseUrl: 'https://example.com',
                projectName: 'myproject',
                domain: 'example.com',
                protocol: 'https'
            };
        }

        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname;
            const protocol = urlObj.protocol.replace(':', '');

            // Extract project name from hostname
            // e.g., "app.myproject.com" -> "myproject"
            // e.g., "myproject-dev.company.com" -> "myproject"
            // e.g., "demo.example.com" -> "example"
            let projectName = 'myproject';

            // Try different extraction patterns
            const hostParts = hostname.split('.');

            if (hostParts.length >= 2) {
                // Get the main domain part (not TLD)
                const mainPart = hostParts[hostParts.length - 2];

                // Extract meaningful name from subdomain or main domain
                if (hostParts[0] !== 'www' && hostParts[0] !== 'app' && hostParts[0] !== 'demo') {
                    // Use first subdomain if meaningful, strip common env suffixes
                    projectName = hostParts[0].replace(/[-_]?(demo|test|dev|qa|staging|prod|live)[-_]?/gi, '') || mainPart;
                } else {
                    // Use main domain part, strip common suffixes
                    projectName = mainPart.replace(/[-_]?(demo|test|dev|qa|staging|prod|live)[-_]?/gi, '') || mainPart;
                }
            }

            // Clean up project name - keep only alphanumeric
            projectName = projectName.toLowerCase().replace(/[^a-z0-9]/g, '');

            // Build base URL (origin without path)
            const baseUrl = urlObj.origin;

            return {
                baseUrl,
                projectName: projectName || 'myproject',
                domain: hostname,
                protocol
            };
        } catch {
            return {
                baseUrl: url,
                projectName: 'myproject',
                domain: 'localhost',
                protocol: 'https'
            };
        }
    }

    /**
     * Generate global.env content with framework defaults
     */
    private generateGlobalEnv(urlInfo: { baseUrl: string; projectName: string; domain: string; protocol: string }): string {
        const timestamp = new Date().toISOString().split('T')[0];

        return `# ============================================================================
#                CS TEST AUTOMATION FRAMEWORK - GLOBAL CONFIGURATION
#                      Generated by CS Codegen on ${timestamp}
# ============================================================================
# This file contains all configuration properties used throughout the framework.
# Properties support environment variable overrides and interpolation.
# ============================================================================

# ====================================================================================
# CORE FRAMEWORK CONFIGURATION
# ====================================================================================

# Project and environment settings
PROJECT=${urlInfo.projectName}
ENVIRONMENT=dev
BASE_URL=${urlInfo.baseUrl}

# ====================================================================================
# BROWSER CONFIGURATION
# ====================================================================================

# Browser type: chrome | firefox | webkit | edge
BROWSER=chrome

# Run browser in headless mode
HEADLESS=false

# Browser viewport settings
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080

# Browser launch settings
BROWSER_LAUNCH_TIMEOUT=30000
BROWSER_SLOWMO=0

# Browser security settings
BROWSER_IGNORE_HTTPS_ERRORS=true

# Browser locale and timezone
BROWSER_LOCALE=en-US
BROWSER_TIMEZONE=America/New_York

# ====================================================================================
# TIMEOUTS
# ====================================================================================

# Default timeout for all operations in milliseconds
TIMEOUT=30000

# Specific timeout configurations
BROWSER_ACTION_TIMEOUT=10000
BROWSER_NAVIGATION_TIMEOUT=30000
BROWSER_AUTO_WAIT_TIMEOUT=5000
ELEMENT_TIMEOUT=10000

# ====================================================================================
# BROWSER INSTANCE MANAGEMENT
# ====================================================================================

# Browser reuse configuration
BROWSER_REUSE_ENABLED=true
BROWSER_REUSE_CLEAR_STATE=true

# Browser health settings
BROWSER_AUTO_RESTART_ON_CRASH=true
BROWSER_MAX_RESTART_ATTEMPTS=3

# ====================================================================================
# MEDIA CAPTURE CONFIGURATION
# ====================================================================================

# Video recording: off | on | retain-on-failure | on-first-retry
BROWSER_VIDEO=retain-on-failure
VIDEO_DIR=./videos

# Screenshot configuration
SCREENSHOT_CAPTURE_MODE=on-failure
SCREENSHOT_ON_FAILURE=true

# Browser trace recording
TRACE_CAPTURE_MODE=on-failure

# Framework log level: DEBUG | INFO | WARN | ERROR
LOG_LEVEL=INFO

# ====================================================================================
# PARALLEL EXECUTION
# ====================================================================================

# Enable parallel execution
PARALLEL=false
MAX_PARALLEL_WORKERS=4
PARALLEL_WORKERS=3

# ====================================================================================
# TEST EXECUTION CONFIGURATION
# ====================================================================================

# Feature file paths
FEATURES=codegen/test/features/*.feature
FEATURE_PATH=codegen/test/features

# Test retry configuration
RETRY_COUNT=2

# Step definition paths
STEP_DEFINITIONS_PATH=codegen/test/steps

# ====================================================================================
# ELEMENT INTERACTION
# ====================================================================================

# Number of retries for element operations
ELEMENT_RETRY_COUNT=3
ELEMENT_CLEAR_BEFORE_TYPE=true

# Wait for spinners to disappear before actions
WAIT_FOR_SPINNERS=true

# ====================================================================================
# SELF-HEALING & AI
# ====================================================================================

# Enable self-healing for broken locators
SELF_HEALING_ENABLED=true

# Enable AI-powered features
AI_ENABLED=false
AI_CONFIDENCE_THRESHOLD=0.7

# ====================================================================================
# REPORTING CONFIGURATION
# ====================================================================================

# Report output directory
REPORTS_BASE_DIR=./reports
REPORTS_CREATE_TIMESTAMP_FOLDER=true

# Report types to generate
REPORT_TYPES=html

# Generate Excel and PDF reports
GENERATE_EXCEL_REPORT=true
GENERATE_PDF_REPORT=true

# ====================================================================================
# INTELLIGENT STEP EXECUTION
# ====================================================================================

# Enable intelligent step execution (AI-powered)
INTELLIGENT_STEP_EXECUTION_ENABLED=false
`;
    }

    /**
     * Generate common/common.env content with project-specific settings
     */
    private generateCommonEnv(urlInfo: { baseUrl: string; projectName: string; domain: string; protocol: string }): string {
        const projectNameUpper = urlInfo.projectName.toUpperCase();
        const timestamp = new Date().toISOString().split('T')[0];

        return `# ============================================================================
#              ${projectNameUpper} PROJECT - COMMON CONFIGURATION
#                      Generated by CS Codegen on ${timestamp}
# ============================================================================
# This file contains project-specific settings shared across all environments.
# ============================================================================

# ====================================================================================
# PROJECT IDENTIFICATION
# ====================================================================================

PROJECT_NAME=${projectNameUpper}
PROJECT_TYPE=web
PROJECT_VERSION=1.0.0

# ====================================================================================
# PROJECT URLs (with interpolation support)
# ====================================================================================

# Base URL supports {ENVIRONMENT} placeholder for environment-specific URLs
# Examples:
#   https://${urlInfo.projectName}.{ENVIRONMENT}.company.com
#   https://{ENVIRONMENT}-${urlInfo.projectName}.company.com
BASE_URL=${urlInfo.baseUrl}
API_BASE_URL=${urlInfo.protocol}://api.${urlInfo.domain}

# ====================================================================================
# PROJECT FEATURES
# ====================================================================================

# Default feature file path pattern
DEFAULT_FEATURES=codegen/test/features/**/*.feature

# Default tags to run (exclude work-in-progress)
DEFAULT_TAGS=@${urlInfo.projectName} and not @wip

# ====================================================================================
# STEP DEFINITIONS
# ====================================================================================

# Step definition paths (semicolon separated)
STEP_DEFINITIONS_PATH=codegen/test/steps

# Enable common steps from framework
COMMON_STEPS_ENABLED=true

# ====================================================================================
# PROJECT TIMEOUTS
# ====================================================================================

# Project-specific timeouts (override global defaults if needed)
DEFAULT_TIMEOUT=30000
PAGE_LOAD_TIMEOUT=60000

# ====================================================================================
# PROJECT CREDENTIALS (use encrypted values in production)
# ====================================================================================

# Default test user credentials
# Use ENCRYPTED: prefix for encrypted passwords
DEFAULT_USERNAME=
DEFAULT_PASSWORD=

# Admin credentials (if applicable)
ADMIN_USERNAME=
ADMIN_PASSWORD=

# ====================================================================================
# PROJECT BROWSER SETTINGS
# ====================================================================================

# Project-specific viewport (override if different from global)
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080

# ====================================================================================
# PROJECT FEATURE FLAGS
# ====================================================================================

# Feature flags for conditional test execution
# Format: flagName:value;flagName2:value2
FEATURE_FLAGS=
`;
    }

    /**
     * Generate environment-specific .env file
     */
    private generateEnvironmentEnv(
        urlInfo: { baseUrl: string; projectName: string; domain: string; protocol: string },
        environment: string
    ): string {
        const envUpper = environment.toUpperCase();
        const envLower = environment.toLowerCase();
        const projectNameUpper = urlInfo.projectName.toUpperCase();
        const timestamp = new Date().toISOString().split('T')[0];

        // Environment-specific settings
        const envSettings: Record<string, { headless: string; debug: string; logLevel: string; slowmo: string }> = {
            dev: { headless: 'false', debug: 'true', logLevel: 'DEBUG', slowmo: '0' },
            qa: { headless: 'true', debug: 'false', logLevel: 'INFO', slowmo: '0' },
            uat: { headless: 'true', debug: 'false', logLevel: 'INFO', slowmo: '0' }
        };

        const settings = envSettings[envLower] || envSettings.dev;

        // Generate environment-specific URL
        let envUrl = urlInfo.baseUrl;
        // Try to create environment-specific URL pattern
        // e.g., https://app-dev.example.com or https://dev.app.example.com
        try {
            const urlObj = new URL(urlInfo.baseUrl);
            if (!urlObj.hostname.includes(envLower)) {
                // Add environment prefix to hostname
                const hostParts = urlObj.hostname.split('.');
                if (hostParts[0] === 'www') {
                    hostParts[0] = envLower;
                } else {
                    hostParts.unshift(envLower);
                }
                urlObj.hostname = hostParts.join('.');
                envUrl = urlObj.origin;
            }
        } catch {
            // Keep original URL if parsing fails
            envUrl = urlInfo.baseUrl;
        }

        return `# ============================================================================
#              ${projectNameUpper} - ${envUpper} ENVIRONMENT CONFIGURATION
#                      Generated by CS Codegen on ${timestamp}
# ============================================================================
# Environment-specific settings for ${envUpper} environment.
# These override common and global settings.
# ============================================================================

# ====================================================================================
# ENVIRONMENT IDENTIFICATION
# ====================================================================================

ENVIRONMENT_NAME=${this.toTitleCase(environment)}
ENVIRONMENT_TYPE=${envLower}

# ====================================================================================
# ENVIRONMENT URLs
# ====================================================================================

# ${envUpper} environment URLs
BASE_URL=${envUrl}
API_BASE_URL=${urlInfo.protocol}://api-${envLower}.${urlInfo.domain}

# ====================================================================================
# ENVIRONMENT BROWSER SETTINGS
# ====================================================================================

# Browser configuration for ${envUpper}
HEADLESS=${settings.headless}
DEBUG_MODE=${settings.debug}
LOG_LEVEL=${settings.logLevel}
BROWSER_SLOWMO=${settings.slowmo}

# ====================================================================================
# ENVIRONMENT FEATURE FLAGS
# ====================================================================================

# ${envUpper}-specific feature flags
FEATURE_FLAGS=

# ====================================================================================
# ENVIRONMENT TEST DATA
# ====================================================================================

# Test data configuration for ${envUpper}
TEST_USER_PREFIX=${envLower}_test_
TEST_DATA_CLEANUP=${envLower === 'dev' ? 'true' : 'false'}

# ====================================================================================
# ENVIRONMENT TIMEOUTS
# ====================================================================================

# ${envUpper}-specific timeouts${envLower === 'dev' ? ' (more lenient for debugging)' : ''}
DEFAULT_TIMEOUT=${envLower === 'dev' ? '60000' : '30000'}
BROWSER_ACTION_TIMEOUT=${envLower === 'dev' ? '15000' : '10000'}
`;
    }

    /**
     * Print code generation summary
     */
    private printIntelligentSummary(code: GeneratedCSCode): void {
        console.log(chalk.cyan('\n📊 Code Generation Summary'));
        console.log(chalk.gray('━'.repeat(60)));

        const features = code.features || [code.feature];
        const totalActions = features[0]?.scenarios?.[0]?.steps?.length || 0;
        console.log(chalk.white(`  Feature Files:      ${features.length}`));
        console.log(chalk.white(`  Page Objects:       ${code.pageObjects.length}`));
        console.log(chalk.white(`  Step Definitions:   ${code.stepDefinitions.length}`));
        console.log(chalk.white(`  Config Files:       5 (global + common + 3 environments)`));
        console.log(chalk.white(`  Total Actions:      ${totalActions}`));

        console.log(chalk.gray('\n━'.repeat(60)));
        console.log(chalk.green('✅ Your test is ready to run!'));
        console.log(chalk.white(`\n📁 Output directory: ${this.options.outputDir}`));
        console.log(chalk.gray('   ├── test/'));
        console.log(chalk.gray('   │   ├── features/       (Gherkin scenarios)'));
        console.log(chalk.gray('   │   ├── pages/          (Page Objects)'));
        console.log(chalk.gray('   │   ├── steps/          (Step Definitions)'));
        console.log(chalk.gray('   │   └── data/           (Test data JSON)'));
        console.log(chalk.gray('   └── config/'));
        console.log(chalk.gray('       ├── global.env      (Framework defaults)'));
        console.log(chalk.gray('       ├── common/         (Project settings)'));
        console.log(chalk.gray('       └── environments/   (dev, qa, uat)\n'));
    }

    /**
     * Spawn Playwright codegen process
     */
    private async spawnPlaywrightCodegen(): Promise<void> {
        console.log(chalk.blue('🎬 Launching Playwright Codegen...'));

        const outputFile = path.join(this.options.watchDir!, 'test.spec.ts');

        // Build the command string directly for shell execution.
        // We must quote paths that may contain spaces (e.g., "My Project").
        // With shell: true, Node joins args with spaces — unquoted paths break.
        const quotedOutput = `"${outputFile}"`;
        const urlArg = this.options.url ? ` ${this.options.url}` : '';
        const fullCommand = `npx playwright codegen --output ${quotedOutput}${urlArg}`;

        console.log(chalk.gray(`   Command: ${fullCommand}\n`));

        // shell: true is required on Windows to execute npx (.cmd batch file)
        this.playwrightProcess = spawn(fullCommand, [], {
            stdio: 'inherit',
            shell: true
        });

        this.playwrightProcess.on('error', (error) => {
            console.error(chalk.red('❌ Failed to start Playwright codegen:'), error);
            process.exit(1);
        });

        this.attachExitHandler();
    }

    /**
     * Attach exit handler to the Playwright process
     */
    private attachExitHandler(): void {
        if (!this.playwrightProcess) return;

        this.playwrightProcess.on('exit', async (code) => {
            if (this.options.verbose) {
                console.log(chalk.gray(`\n   Playwright exited with code: ${code}`));
            }

            // Don't process if we're already cleaning up
            if (code === 0 || code === null) {
                console.log(chalk.cyan('\n🔄 Browser closed, converting your test to CS Framework...\n'));

                // Give it a moment to ensure file is saved
                await new Promise(resolve => setTimeout(resolve, 500));
                await this.processFinalTest();

                this.cleanup();
                process.exit(0);
            }
        });
    }

    /**
     * Keep process alive
     */
    private keepAlive(): void {
        // Handle graceful shutdown with Ctrl+C
        process.on('SIGINT', async () => {
            console.log(chalk.yellow('\n\n👋 Ctrl+C pressed, closing codegen...'));

            if (this.options.verbose) {
                console.log(chalk.gray('   Stopping Playwright process...'));
            }

            // Kill Playwright first
            if (this.playwrightProcess && !this.playwrightProcess.killed) {
                this.playwrightProcess.kill('SIGTERM');
            }

            // Wait a moment for file to be fully written
            await new Promise(resolve => setTimeout(resolve, 500));

            console.log(chalk.cyan('\n🔄 Converting your test to CS Framework...\n'));

            // Process the test file if it exists
            await this.processFinalTest();

            this.cleanup();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            await this.processFinalTest();
            this.cleanup();
            process.exit(0);
        });
    }

    /**
     * Process the final test file on shutdown
     */
    private async processFinalTest(): Promise<void> {
        try {
            const testFile = path.join(this.options.watchDir!, 'test.spec.ts');

            if (fs.existsSync(testFile)) {
                const sourceCode = fs.readFileSync(testFile, 'utf-8');

                if (sourceCode && sourceCode.trim().length > 0) {
                    console.log(chalk.cyan('\n🔄 Converting your test to CS Framework...\n'));
                    await this.transformToCSFramework(sourceCode, testFile);
                }
            }
        } catch (error) {
            console.error(chalk.red('Error processing final test:'), error);
        }
    }

    /**
     * Cleanup resources
     */
    private cleanup(): void {
        if (this.watcher) {
            this.watcher.close();
        }

        if (this.playwrightProcess && !this.playwrightProcess.killed) {
            this.playwrightProcess.kill();
        }

        if (this.spinner) {
            this.spinner.stop();
        }
    }

    /**
     * Utility: Convert to Title Case
     */
    private toTitleCase(str: string): string {
        return str
            .replace(/[-_]/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    }
}
