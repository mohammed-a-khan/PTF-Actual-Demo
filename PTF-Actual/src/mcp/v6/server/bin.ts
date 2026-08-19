#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
try {
    const argv = process.argv.slice(2);
    const sub = argv[0];

    if (sub === 'init-agents') {
        const { parseInitAgentsArgs, runInitAgents } = require('../scaffolder/init-agents');
        try {
            const opts = parseInitAgentsArgs(argv.slice(1));
            const result = runInitAgents(opts);
            const verb = result.dryRun ? 'WOULD WRITE' : 'wrote';
            for (const p of result.copied) process.stdout.write(`  [${verb}] ${p}\n`);
            for (const s of result.skipped) process.stdout.write(`  [skip] ${s.path}  (${s.reason})\n`);
            process.stdout.write(
                `\n${result.dryRun ? '[dry-run] ' : ''}${result.copied.length} written, ${result.skipped.length} skipped → ${result.targetDir}\n`,
            );
            if (!result.dryRun && result.copied.length > 0 && result.loop === 'vscode') {
                process.stdout.write(`\nRestart VS Code (or reload the window). Copilot picks up .vscode/mcp.json and launches cs-qa automatically.\n`);
            }
            process.exit(0);
        } catch (e) {
            const err = e as Error;
            process.stderr.write(`[cs-playwright-mcp init-agents] ${err.message}\n`);
            process.exit(2);
        }
    }

    if (sub === '--help' || sub === '-h') {
        process.stdout.write(`cs-playwright-mcp — Playwright QA MCP server.

Usage:
  cs-playwright-mcp                          Start the stdio MCP server (default).
  cs-playwright-mcp init-agents [options]    Scaffold consumer project (.github + .vscode).
  cs-playwright-mcp --help                   This message.

Run 'cs-playwright-mcp init-agents --help' for scaffolder options.
`);
        process.exit(0);
    }

    // Default: start the MCP server over stdio.
    const mod = require('./index');
    mod.startV6Server().catch((e: Error) => {
        process.stderr.write(`[cs-qa-v6] startV6Server failed: ${e.stack ?? e.message}\n`);
        process.exit(1);
    });
} catch (e) {
    const err = e as Error;
    process.stderr.write(`[cs-qa-v6] bin.js load failed: ${err.stack ?? err.message}\n`);
    process.exit(1);
}
