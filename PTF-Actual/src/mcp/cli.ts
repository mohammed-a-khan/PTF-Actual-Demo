#!/usr/bin/env node
/**
 * CS Playwright MCP Server CLI
 * Command-line interface for starting the MCP server
 *
 * Usage:
 *   npx cs-playwright-mcp                         # Start with all tools
 *   npx cs-playwright-mcp --tools browser,bdd     # Start with specific tools
 *   npx cs-playwright-mcp init-agents --loop=vscode  # Initialize agents
 *   npx cs-playwright-mcp --help                  # Show help
 *
 * @module CSMCPCLI
 */

import {
    createAgenticMCPServer,
    createFullMCPServer,
    createMCPServerWithTools,
    CSMCPServerConfig,
    ToolCategory,
} from './index';
import { generateAgents } from './agents/generateAgents';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const VALID_TOOLS: ToolCategory[] = [
    'browser', 'bdd', 'database', 'cicd', 'network',
    'analytics', 'security', 'multiagent', 'environment', 'generation', 'exploration', 'testing'
];

interface CLIOptions {
    /** agentic = 5 meta-tools + lazy packs (default); classic = eager registration */
    profile: 'agentic' | 'classic';
    tools: ToolCategory[] | 'all';
    logLevel: 'debug' | 'info' | 'warning' | 'error';
    version: boolean;
    help: boolean;
}

function parseArgs(args: string[]): CLIOptions {
    const options: CLIOptions = {
        profile: 'agentic',
        tools: 'all',
        logLevel: 'info',
        version: false,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--profile=')) {
            const p = arg.split('=')[1];
            if (p === 'agentic' || p === 'classic') options.profile = p;
            continue;
        }

        switch (arg) {
            case '--help':
            case '-h':
                options.help = true;
                break;

            case '--version':
            case '-v':
                options.version = true;
                break;

            case '--profile':
            case '-p': {
                const p = args[++i];
                if (p === 'agentic' || p === 'classic') options.profile = p;
                break;
            }

            case '--tools':
            case '-t':
                // Selecting explicit tool categories implies the classic profile.
                options.profile = 'classic';
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
  cs-playwright-mcp [options]              # Start MCP server (agentic profile)
  cs-playwright-mcp init-agents [options]  # Initialize the cs-ai-auto-assist agent

Commands:
  init-agents     Materialize the single cs-ai-auto-assist agent, skills,
                  copilot-instructions.md and mcp.json into a consumer repo.
                  Use --loop=vscode|jetbrains|claude|opencode to pick the IDE.
                  Example: cs-playwright-mcp init-agents --loop=vscode

Options:
  -h, --help              Show this help message
  -v, --version           Show version number
  -p, --profile <name>    Server profile (default: agentic)
                            agentic  5 meta-tools (cs_ai_auto_assist, csaa_advance,
                                     csaa_submit, csaa_status, csaa_toolpack);
                                     240+ tools load on demand via capability
                                     packs — smallest possible tool context,
                                     lowest AI-credit consumption
                            classic  previous eager registration of every tool
  -t, --tools <list>      (classic) Tool categories to enable (comma-separated)
                          Options: browser, bdd, database, cicd, network,
                                   analytics, security, multiagent,
                                   environment, generation, testing, all
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
  testing      - Test execution tools (run, list, debug, heal)
                 5 tools for Playwright agents (Planner, Generator, Healer)

Protocol:
  This server implements the Model Context Protocol (MCP) specification.
  Communication is via JSON-RPC 2.0 over stdio.

Configuration:
  VS Code/GitHub Copilot: Add to .vscode/mcp.json:
  {
    "servers": {
      "cs-playwright-mcp": {
        "command": "npx",
        "args": ["-y", "cs-playwright-mcp"]
      }
    }
  }
`;

const VERSION = '1.0.0';

// ============================================================================
// Init Agents Command
// ============================================================================

function handleInitAgents(args: string[]): void {
    let loop: 'vscode' | 'jetbrains' | 'claude' | 'opencode' = 'vscode';
    let force = false;
    let targetDir = process.cwd();
    const validLoops = ['vscode', 'jetbrains', 'claude', 'opencode'];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--loop' || arg === '-l') {
            const loopArg = args[++i];
            if (validLoops.includes(loopArg)) {
                loop = loopArg as typeof loop;
            }
        } else if (arg.startsWith('--loop=')) {
            const loopArg = arg.split('=')[1];
            if (validLoops.includes(loopArg)) {
                loop = loopArg as typeof loop;
            }
        } else if (arg === '--force' || arg === '-f') {
            force = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
CS Playwright Agent Generator
==============================

Initialize AI agent definitions for your test project.

Usage:
  cs-playwright-mcp init-agents [options]

Options:
  --loop, -l <type>   IDE/client type: vscode, jetbrains, claude, opencode
                      (default: vscode)
  --force, -f         Overwrite existing files
  --help, -h          Show this help message

Examples:
  cs-playwright-mcp init-agents --loop=vscode
  cs-playwright-mcp init-agents --loop=jetbrains
  cs-playwright-mcp init-agents --loop=claude --force

Generated Files:
  .github/agents/       The single "CS AI Auto-Assist" agent definition
  .github/skills/       Pattern skills consumed on demand
  .github/copilot-instructions.md    Workspace-level Copilot rules
  .vscode/mcp.json      MCP server configuration (vscode loop)
  ./mcp.json            MCP server configuration (jetbrains/claude/opencode)

The agent:
  CS AI Auto-Assist — one agent for the complete test SDLC. Users pick a
  mode from a menu (plan, analyze, design, author, migrate, review,
  pr_review, run, heal, triage, regression, performance, audit) and provide
  inputs; the server-side engine orchestrates everything else with live
  guardrails and AI-credit budgets.
`);
            process.exit(0);
        } else if (!arg.startsWith('-')) {
            targetDir = arg;
        }
    }

    console.log(`
CS Playwright Agent Generator
==============================
Loop type: ${loop}
Target: ${targetDir}
`);

    const { files, errors } = generateAgents(targetDir, loop, { force });

    if (errors.length > 0) {
        console.error('\nErrors:');
        for (const error of errors) {
            console.error(`  - ${error}`);
        }
    }

    const ideName =
        loop === 'vscode' ? 'VS Code'
        : loop === 'jetbrains' ? 'your JetBrains IDE'
        : loop === 'claude' ? 'Claude Code'
        : 'OpenCode';
    console.log(`
Done! Generated ${files.length} files.

Next steps:
1. Open ${ideName} and reload so Copilot picks up .github/agents/
2. Select the "CS AI Auto-Assist" agent in Copilot Chat
3. Just say hi — it shows the SDLC menu and takes it from there.
   No prompt writing needed: pick a mode, fill in the inputs, watch STATUS.md.
`);
    process.exit(errors.length > 0 ? 1 : 0);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Check for init-agents command
    if (args[0] === 'init-agents') {
        handleInitAgents(args.slice(1));
        return;
    }

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

    // Initialize the framework's configuration hierarchy so any tool that
    // needs config values (e.g. ADO_PAT / ADO_ORGANIZATION / ADO_PROJECT) can
    // read them via `CSConfigurationManager.getInstance().get(key)`.
    // The 8-level loader honours `process.env.PROJECT` / `process.env.ENVIRONMENT`
    // when present and decrypts any `ENCRYPTED:` values automatically.
    try {
        await CSConfigurationManager.getInstance().initialize({});
        console.error('CSConfigurationManager initialized');
    } catch (err) {
        console.error(
            'CSConfigurationManager initialization failed (non-fatal — tool params still work):',
            err instanceof Error ? err.message : String(err),
        );
    }

    // Configure server
    const config: CSMCPServerConfig = {
        name: 'cs-playwright-mcp',
        version: VERSION,
        logLevel: options.logLevel,
        workingDirectory: process.cwd(),
    };

    // Create server with the selected profile.
    //   agentic (default): 5 meta-tools; capability packs load on demand and
    //                      the host is notified via tools/list_changed.
    //   classic:           previous behavior — eager registration.
    let server;
    if (options.profile === 'agentic') {
        server = createAgenticMCPServer(config);
    } else if (options.tools === 'all') {
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
main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
