#!/usr/bin/env node
/**
 * CS Playwright MCP Server CLI
 * Command-line interface for starting the MCP server
 *
 * Usage:
 *   npx cs-playwright-mcp                    # Start with all tools
 *   npx cs-playwright-mcp --tools browser,bdd  # Start with specific tools
 *   npx cs-playwright-mcp --help             # Show help
 *
 * @module CSMCPCLI
 */

import { createFullMCPServer, createMCPServerWithTools, CSMCPServerConfig, ToolCategory } from './index';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const VALID_TOOLS: ToolCategory[] = [
    'browser', 'bdd', 'database', 'cicd', 'network',
    'analytics', 'security', 'multiagent', 'environment', 'generation', 'exploration'
];

interface CLIOptions {
    tools: ToolCategory[] | 'all';
    logLevel: 'debug' | 'info' | 'warning' | 'error';
    version: boolean;
    help: boolean;
}

function parseArgs(args: string[]): CLIOptions {
    const options: CLIOptions = {
        tools: 'all',
        logLevel: 'info',
        version: false,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--help':
            case '-h':
                options.help = true;
                break;

            case '--version':
            case '-v':
                options.version = true;
                break;

            case '--tools':
            case '-t':
                const toolsArg = args[++i];
                if (toolsArg === 'all') {
                    options.tools = 'all';
                } else {
                    const requestedTools = toolsArg.split(',').map(t => t.trim().toLowerCase());
                    const filtered = requestedTools.filter(t =>
                        VALID_TOOLS.includes(t as ToolCategory)
                    ) as ToolCategory[];
                    options.tools = filtered.length > 0 ? filtered : 'all';
                }
                break;

            case '--log-level':
            case '-l':
                const level = args[++i];
                if (['debug', 'info', 'warning', 'error'].includes(level)) {
                    options.logLevel = level as CLIOptions['logLevel'];
                }
                break;
        }
    }

    return options;
}

// ============================================================================
// Help Text
// ============================================================================

const HELP_TEXT = `
CS Playwright MCP Server
========================

A Model Context Protocol (MCP) server for test automation.
Enables AI assistants like GitHub Copilot to interact with
browser automation, BDD tests, databases, Azure DevOps, and more.

Zero-dependency implementation using only Node.js built-ins.
140+ tools across 10 categories for comprehensive test automation.

Usage:
  cs-playwright-mcp [options]

Options:
  -h, --help              Show this help message
  -v, --version           Show version number
  -t, --tools <list>      Tool categories to enable (comma-separated)
                          Options: browser, bdd, database, cicd, network,
                                   analytics, security, multiagent,
                                   environment, generation, all
                          Default: all
  -l, --log-level <level> Logging level: debug, info, warning, error
                          Default: info

Examples:
  # Start with all tools
  cs-playwright-mcp

  # Start with only browser and BDD tools
  cs-playwright-mcp --tools browser,bdd

  # Start with debug logging
  cs-playwright-mcp --log-level debug

  # Start with security and analytics
  cs-playwright-mcp --tools security,analytics,browser

Tool Categories:
  browser      - Browser automation tools (navigate, click, fill, etc.)
                 32 tools for web interaction via Playwright
  bdd          - BDD/Cucumber test tools (run features, find steps, etc.)
                 14 tools for test execution
  database     - Database tools (query, verify, snapshot, etc.)
                 23 tools for data management (Oracle, PostgreSQL, MySQL, SQL Server)
  cicd         - Azure DevOps tools (pipelines, builds, PRs, work items, etc.)
                 22 tools for CI/CD integration
  network      - Network/API tools (intercept, mock, REST, GraphQL, SOAP)
                 15 tools for API testing
  analytics    - Test analytics tools (flakiness, trends, reports)
                 10 tools for test intelligence
  security     - Security testing tools (XSS, SQL injection, CSRF, etc.)
                 9 tools for vulnerability scanning
  multiagent   - Multi-agent orchestration (spawn, coordinate, workflow)
                 14 tools for distributed testing
  environment  - Environment tools (feature flags, time travel, mock servers)
                 19 tools for test environment control
  generation   - Code generation tools (page objects, tests, selectors)
                 10 tools for automation

Protocol:
  This server implements the Model Context Protocol (MCP) specification.
  Communication is via JSON-RPC 2.0 over stdio.

Configuration:
  VS Code/GitHub Copilot: Add to .vscode/mcp.json:
  {
    "servers": {
      "cs-playwright": {
        "command": "npx",
        "args": ["cs-playwright-mcp"]
      }
    }
  }
`;

const VERSION = '1.0.0';

// ============================================================================
// Main Entry Point
// ============================================================================

function main(): void {
    const args = process.argv.slice(2);
    const options = parseArgs(args);

    // Handle help
    if (options.help) {
        console.log(HELP_TEXT);
        process.exit(0);
    }

    // Handle version
    if (options.version) {
        console.log(`cs-playwright-mcp v${VERSION}`);
        process.exit(0);
    }

    // Configure server
    const config: CSMCPServerConfig = {
        name: 'cs-playwright-mcp',
        version: VERSION,
        logLevel: options.logLevel,
        workingDirectory: process.cwd(),
    };

    // Create server with appropriate tools
    let server;
    if (options.tools === 'all') {
        server = createFullMCPServer(config);
    } else {
        server = createMCPServerWithTools(options.tools, config);
    }

    // Get tool count for logging
    const toolCount = server.getToolRegistry().getToolCount();
    const countsByCategory = server.getToolRegistry().getToolCountsByCategory();

    // Log startup info to stderr (stdout is for JSON-RPC)
    console.error(`CS Playwright MCP Server v${VERSION}`);
    console.error(`Tools loaded: ${toolCount}`);
    console.error(`Categories: ${JSON.stringify(countsByCategory)}`);
    console.error(`Log level: ${options.logLevel}`);
    console.error(`Working directory: ${config.workingDirectory}`);
    console.error('');
    console.error('Server ready. Waiting for connections...');

    // Start server
    server.start();

    // Handle process termination
    const cleanup = (): void => {
        console.error('\nShutting down...');
        server.stop();
        process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

// Run if this is the main module
main();
