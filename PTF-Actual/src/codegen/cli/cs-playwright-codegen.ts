#!/usr/bin/env node

/**
 * CS Playwright Codegen - Single Command Entry Point
 *
 * Usage:
 *   npx cs-playwright-codegen [url] [options]
 *
 * This command provides an intelligent Playwright codegen experience
 * that automatically transforms recorded tests to CS Framework format
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { CodegenOrchestrator } from './CodegenOrchestrator';

const program = new Command();

program
    .name('cs-playwright-codegen')
    .description('Intelligent Playwright codegen with automatic CS Framework transformation')
    .version('1.0.0')
    .argument('[url]', 'URL to start recording from (optional)')
    .option('-o, --output-dir <dir>', 'Output directory for generated tests', './codegen')
    .option('-w, --watch-dir <dir>', 'Directory to watch for codegen output')
    .option('-v, --verbose', 'Enable verbose logging', false)
    .action(async (url: string | undefined, options: any) => {
        try {
            // Display banner
            displayBanner();

            // Create orchestrator - only pass defined values
            const orchestratorOptions: any = { url };

            if (options.outputDir) orchestratorOptions.outputDir = options.outputDir;
            if (options.watchDir) orchestratorOptions.watchDir = options.watchDir;
            if (options.verbose) orchestratorOptions.verbose = options.verbose;

            const orchestrator = new CodegenOrchestrator(orchestratorOptions);

            // Start the intelligent system
            await orchestrator.start();

        } catch (error) {
            console.error(chalk.red('\n❌ Fatal error:'), error);
            process.exit(1);
        }
    });

/**
 * Display welcome banner
 */
function displayBanner(): void {
    console.clear();
    console.log(chalk.cyan.bold(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   CS Framework - Intelligent Test Codegen                 ║
║   Automatically converts Playwright to CS Framework       ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `));
    console.log(chalk.white('Record your test - we\'ll handle the rest.\n'));
}

// Parse command line arguments
program.parse();
