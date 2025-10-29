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
import { IntelligentCodeGenerator } from '../generator/IntelligentCodeGenerator';
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
    private codeGenerator: IntelligentCodeGenerator;
    private watcher?: chokidar.FSWatcher;
    private playwrightProcess?: ChildProcess;
    private spinner?: Ora;
    private options: OrchestratorOptions;
    private isShuttingDown: boolean = false;

    constructor(options: OrchestratorOptions = {}) {
        // Use framework's .temp directory instead of system temp
        const defaultWatchDir = path.resolve(process.cwd(), '.temp', 'codegen');

        // Set defaults first, then apply user options
        this.options = {
            outputDir: './test',
            watchDir: defaultWatchDir,
            verbose: false,
            ...options  // User options override defaults
        };

        // Initialize intelligence layers
        this.parser = new AdvancedASTParser();
        this.symbolicEngine = new SymbolicExecutionEngine();
        this.codeGenerator = new IntelligentCodeGenerator();
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
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 1000, // Wait 1 second after last change
                pollInterval: 100
            }
        });

        this.watcher.on('add', async (filePath: string) => {
            await this.handleNewFile(filePath);
        });

        this.watcher.on('change', async (filePath: string) => {
            await this.handleNewFile(filePath);
        });

        this.watcher.on('error', (error: unknown) => {
            console.error(chalk.red('❌ Watcher error:'), error);
        });
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
            // Parse and analyze the recorded test
            this.spinner = ora(chalk.cyan('Analyzing recorded test...')).start();
            const analysis = this.parser.parse(sourceCode);
            this.spinner.succeed(chalk.green(`Found ${analysis.actions.length} test actions`));

            if (this.options.verbose) {
                console.log(chalk.gray(`   Actions: ${analysis.actions.map(a => a.type).join(', ')}`));
            }

            // Understand test intent
            this.spinner = ora(chalk.cyan('Understanding test purpose...')).start();
            const intentAnalysis = await this.symbolicEngine.executeSymbolically(analysis);
            this.spinner.succeed(chalk.green(`Detected: ${intentAnalysis.primary.type} test (${Math.round(intentAnalysis.confidence * 100)}% confidence)`));

            if (this.options.verbose) {
                console.log(chalk.gray(`   Test Type: ${intentAnalysis.testType}`));
                console.log(chalk.gray(`   Business Goal: ${intentAnalysis.primary.description}`));
            }

            // Generate CS Framework code
            this.spinner = ora(chalk.cyan('Generating CS Framework code...')).start();
            const featureName = this.extractFeatureName(originalFilePath, intentAnalysis.primary.type);
            const generatedCode = await this.codeGenerator.generate(analysis, intentAnalysis, featureName);
            this.spinner.succeed(chalk.green('CS Framework code generated'));

            // Write generated files
            this.spinner = ora(chalk.cyan('Writing CS Framework files...')).start();
            await this.writeGeneratedCode(generatedCode);
            this.spinner.succeed(chalk.green('✅ Transformation complete!'));

            // Summary
            this.printSummary(generatedCode, intentAnalysis);

        } catch (error) {
            if (this.spinner) {
                this.spinner.fail(chalk.red('❌ Transformation failed'));
            }
            console.error(chalk.red('Error details:'), error);
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
     */
    private async writeGeneratedCode(code: GeneratedCSCode): Promise<void> {
        const outputDir = this.options.outputDir!;

        // Ensure directories exist
        const featureDir = path.join(outputDir, 'features');
        const pageDir = path.join(outputDir, 'pages');
        const stepDir = path.join(outputDir, 'steps');

        [featureDir, pageDir, stepDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        // Write Feature file
        const featurePath = path.join(featureDir, code.feature.fileName);
        fs.writeFileSync(featurePath, code.feature.content, 'utf-8');

        // Write Page Objects
        for (const pageObject of code.pageObjects) {
            const pagePath = path.join(pageDir, pageObject.fileName);
            fs.writeFileSync(pagePath, pageObject.content, 'utf-8');
        }

        // Write Step Definitions
        for (const stepDef of code.stepDefinitions) {
            const stepPath = path.join(stepDir, stepDef.fileName);
            fs.writeFileSync(stepPath, stepDef.content, 'utf-8');
        }
    }

    /**
     * Print transformation summary
     */
    private printSummary(code: GeneratedCSCode, intentAnalysis: any): void {
        console.log(chalk.cyan('\n📊 Transformation Summary'));
        console.log(chalk.gray('━'.repeat(50)));
        console.log(chalk.white(`  Feature:          ${code.feature.fileName}`));
        console.log(chalk.white(`  Page Objects:     ${code.pageObjects.length} generated`));
        console.log(chalk.white(`  Step Definitions: ${code.stepDefinitions.length} generated`));
        console.log(chalk.white(`  Confidence:       ${Math.round(intentAnalysis.confidence * 100)}%`));
        console.log(chalk.white(`  Intelligence:     ${code.pageObjects.reduce((sum, po) => sum + po.elements.length, 0)} smart elements`));
        console.log(chalk.gray('━'.repeat(50)));
        console.log(chalk.green('✅ Your test is ready to run!\n'));
    }

    /**
     * Spawn Playwright codegen process
     */
    private async spawnPlaywrightCodegen(): Promise<void> {
        console.log(chalk.blue('🎬 Launching Playwright Codegen...'));

        const outputFile = path.join(this.options.watchDir!, 'test.spec.ts');

        const args = [
            'codegen',
            '--target', 'playwright-test',
            '-o', outputFile
        ];

        if (this.options.url) {
            args.push(this.options.url);
        }

        console.log(chalk.gray(`   Command: npx playwright ${args.join(' ')}\n`));

        this.playwrightProcess = spawn('npx', ['playwright', ...args], {
            stdio: 'inherit',
            shell: true
        });

        this.playwrightProcess.on('error', (error) => {
            console.error(chalk.red('❌ Failed to start Playwright codegen:'), error);
            process.exit(1);
        });

        this.playwrightProcess.on('exit', async (code) => {
            // If we're already shutting down from SIGINT, don't interfere
            if (this.isShuttingDown) {
                return;
            }

            // Playwright exited on its own (user closed window or error)
            if (code !== 0 && code !== null) {
                console.log(chalk.yellow('\n⚠️  Playwright codegen exited'));
            }

            // Process final test before exiting
            await this.processFinalTest();
            this.cleanup();
            process.exit(0);  // Always exit with 0 after successful cleanup
        });
    }

    /**
     * Keep process alive
     */
    private keepAlive(): void {
        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            // Prevent duplicate processing if already shutting down
            if (this.isShuttingDown) {
                return;
            }
            this.isShuttingDown = true;

            console.log(chalk.yellow('\n\n👋 Closing codegen and processing your test...'));

            // Kill playwright process first to prevent its exit handler from running
            if (this.playwrightProcess && !this.playwrightProcess.killed) {
                this.playwrightProcess.kill('SIGKILL');
            }

            // Process the test file if it exists
            await this.processFinalTest();

            this.cleanup();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            if (this.isShuttingDown) {
                return;
            }
            this.isShuttingDown = true;

            if (this.playwrightProcess && !this.playwrightProcess.killed) {
                this.playwrightProcess.kill('SIGKILL');
            }

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

                    // Transformation complete - notify user
                    console.log(chalk.green.bold('\n✨ All done! Your CS Framework code is ready.\n'));
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
        try {
            if (this.watcher) {
                this.watcher.close();
            }

            if (this.playwrightProcess && !this.playwrightProcess.killed) {
                this.playwrightProcess.kill('SIGTERM');
            }

            if (this.spinner) {
                this.spinner.stop();
            }

            // Force cleanup of any lingering event listeners
            process.removeAllListeners('SIGINT');
            process.removeAllListeners('SIGTERM');
        } catch (error) {
            // Ignore cleanup errors
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
