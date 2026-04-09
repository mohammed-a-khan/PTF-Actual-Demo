#!/usr/bin/env node
/**
 * CS Playwright CLI - Token-efficient interface for AI agents
 *
 * A CLI alternative to MCP that writes results to disk for agents to read.
 * This approach is more token-efficient because agents only read the data
 * they need from output files, rather than receiving full tool responses inline.
 *
 * Usage:
 *   npx cs-playwright-cli snapshot
 *   npx cs-playwright-cli screenshot
 *   npx cs-playwright-cli list-features "test/**\/*.feature"
 *   npx cs-playwright-cli validate-steps test/features/login.feature
 *   npx cs-playwright-cli run-test test/features/login.feature --tag @smoke
 *   npx cs-playwright-cli suggest-locator "#submit-btn"
 *   npx cs-playwright-cli generate-page https://example.com/login
 *   npx cs-playwright-cli query mydb "SELECT * FROM users LIMIT 10"
 *   npx cs-playwright-cli page-info
 *   npx cs-playwright-cli console-logs
 *   npx cs-playwright-cli page-errors
 *   npx cs-playwright-cli network-log
 */

import { CSPlaywrightCLI } from './CSPlaywrightCLI';

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Parse --output-dir option
    let outputDir: string | undefined;
    const outputDirIndex = args.indexOf('--output-dir');
    if (outputDirIndex !== -1 && args[outputDirIndex + 1]) {
        outputDir = args[outputDirIndex + 1];
        // Remove --output-dir and its value from args
        args.splice(outputDirIndex, 2);
    }

    const command = args[0];
    const commandArgs = args.slice(1);

    if (!command || command === '--help' || command === '-h') {
        printHelp();
        process.exit(0);
    }

    if (command === '--version' || command === '-v') {
        printVersion();
        process.exit(0);
    }

    if (command === '--list' || command === '-l') {
        const cli = new CSPlaywrightCLI(outputDir);
        printCommandList(cli);
        process.exit(0);
    }

    const cli = new CSPlaywrightCLI(outputDir);
    const result = await cli.execute(command, commandArgs);

    if (result.success) {
        console.log(`[OK] ${result.message}`);
        if (result.outputFile) {
            console.log(`   Output: ${result.outputFile}`);
        }
    } else {
        console.error(`[FAIL] ${result.message}`);
        process.exit(1);
    }
}

function printVersion(): void {
    try {
        const pkg = require('../../package.json');
        console.log(`cs-playwright-cli v${pkg.version || '0.0.0'}`);
    } catch {
        console.log('cs-playwright-cli v0.0.0');
    }
}

function printCommandList(cli: CSPlaywrightCLI): void {
    const commands = cli.getAvailableCommands();
    console.log('\nAvailable commands:\n');
    for (const cmd of commands) {
        console.log(`  ${cmd.command.padEnd(20)} ${cmd.description}`);
        console.log(`  ${''.padEnd(20)} Usage: ${cmd.usage}`);
        console.log(`  ${''.padEnd(20)} Output: ${cmd.outputFile}`);
        console.log('');
    }
}

function printHelp(): void {
    console.log(`
CS Playwright CLI - Token-efficient AI Agent Interface
=======================================================

An alternative to MCP tools that writes results to disk for agents to read.
Each command writes its output to the .cs-cli/ directory by default.

Browser Commands:
  snapshot              Capture accessibility snapshot    -> .cs-cli/snapshot.yaml
  screenshot            Capture page screenshot           -> .cs-cli/screenshot.png
  page-info             Get page URL, title, viewport     -> .cs-cli/page-info.json
  console-logs          Get console messages              -> .cs-cli/console.json
  page-errors           Get page errors                   -> .cs-cli/errors.json
  network-log           Get network requests              -> .cs-cli/network.json

Test Commands:
  list-features [glob]  List feature files                -> .cs-cli/features.json
  list-steps            List step definitions             -> .cs-cli/steps.json
  validate-steps <file> Validate feature steps            -> .cs-cli/validation.json
  run-test <feature>    Run test                          -> .cs-cli/results.json

Codegen Commands:
  suggest-locator <sel> Suggest better locator            -> .cs-cli/locator.json
  generate-page [url]   Generate page object              -> .cs-cli/generated-page.ts

Data Commands:
  query <alias> <sql>   Execute DB query                  -> .cs-cli/query-results.json

Options:
  --help, -h            Show this help
  --version, -v         Show version
  --list, -l            List all commands with details
  --output-dir <dir>    Output directory (default: .cs-cli)

Examples:
  npx cs-playwright-cli snapshot
  npx cs-playwright-cli list-features "test/**/*.feature"
  npx cs-playwright-cli validate-steps test/features/login.feature
  npx cs-playwright-cli run-test test/features/login.feature --tag @smoke
  npx cs-playwright-cli suggest-locator "[data-testid=submit]"
  npx cs-playwright-cli query mydb "SELECT TOP 10 * FROM Users"
  npx cs-playwright-cli --output-dir ./my-output snapshot
`);
}

main().catch(err => {
    console.error('CLI Error:', err.message);
    process.exit(1);
});
