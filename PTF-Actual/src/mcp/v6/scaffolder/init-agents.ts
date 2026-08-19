/**
 * `cs-playwright-mcp init-agents` — scaffolds the .github/ + .vscode/ layout
 * into a consumer repo. After running this and restarting VS Code, Copilot
 * launches the v6 MCP server automatically.
 *
 * Reads from EMBEDDED_TEMPLATES (auto-generated at framework build time by
 * scripts/embed-scaffolder-templates.js) — not from node_modules source files.
 *
 * Usage:
 *   npx cs-playwright-mcp init-agents
 *   npx cs-playwright-mcp init-agents --loop=vscode        (default)
 *   npx cs-playwright-mcp init-agents --loop=intellij
 *   npx cs-playwright-mcp init-agents --force
 *   npx cs-playwright-mcp init-agents --dry-run
 *   npx cs-playwright-mcp init-agents --target-dir=/path/to/consumer/repo
 */

import * as fs from 'fs';
import * as path from 'path';
import { EMBEDDED_TEMPLATES } from './embedded-templates';

export interface InitAgentsOptions {
    targetDir: string;
    loop: 'vscode' | 'intellij';
    force: boolean;
    dryRun: boolean;
}

export interface InitAgentsResult {
    copied: string[];
    skipped: Array<{ path: string; reason: string }>;
    dryRun: boolean;
    loop: string;
    targetDir: string;
}

function buildConsumerMcpJson(): string {
    const config = {
        servers: {
            playwright: {
                type: 'stdio',
                command: 'npx',
                args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated', '--caps', 'testing'],
                env: {
                    NODE_EXTRA_CA_CERTS: '${env:NODE_EXTRA_CA_CERTS}',
                },
            },
            'cs-qa': {
                type: 'stdio',
                command: 'npx',
                args: ['cs-playwright-mcp'],
                env: {
                    CS_QA_WORKSPACE_ROOT: '${workspaceFolder}',
                },
            },
        },
    };
    return JSON.stringify(config, null, 2) + '\n';
}

function resolveDestKey(embeddedKey: string, loop: 'vscode' | 'intellij'): string | null {
    if (loop === 'vscode') return embeddedKey;
    if (embeddedKey === '.vscode/settings.json') return null;
    if (embeddedKey.startsWith('.vscode/')) return '.idea/' + embeddedKey.slice('.vscode/'.length);
    return embeddedKey;
}

export function runInitAgents(opts: InitAgentsOptions): InitAgentsResult {
    const result: InitAgentsResult = {
        copied: [],
        skipped: [],
        dryRun: opts.dryRun,
        loop: opts.loop,
        targetDir: opts.targetDir,
    };

    for (const embeddedKey of Object.keys(EMBEDDED_TEMPLATES)) {
        const dstRel = resolveDestKey(embeddedKey, opts.loop);
        if (dstRel === null) {
            result.skipped.push({ path: embeddedKey, reason: 'no equivalent for --loop=intellij' });
            continue;
        }
        const dstAbs = path.join(opts.targetDir, dstRel);
        if (fs.existsSync(dstAbs) && !opts.force) {
            result.skipped.push({ path: dstRel, reason: 'exists (use --force to overwrite)' });
            continue;
        }
        if (opts.dryRun) {
            result.copied.push(dstRel);
            continue;
        }
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        fs.writeFileSync(dstAbs, EMBEDDED_TEMPLATES[embeddedKey]);
        result.copied.push(dstRel);
    }

    const mcpRel = opts.loop === 'intellij' ? '.idea/mcp.json' : '.vscode/mcp.json';
    const mcpAbs = path.join(opts.targetDir, mcpRel);
    if (fs.existsSync(mcpAbs) && !opts.force) {
        result.skipped.push({ path: mcpRel, reason: 'exists (use --force to overwrite)' });
    } else if (opts.dryRun) {
        result.copied.push(mcpRel);
    } else {
        fs.mkdirSync(path.dirname(mcpAbs), { recursive: true });
        fs.writeFileSync(mcpAbs, buildConsumerMcpJson());
        result.copied.push(mcpRel);
    }

    return result;
}

export function parseInitAgentsArgs(argv: string[]): InitAgentsOptions {
    const opts: InitAgentsOptions = {
        targetDir: process.cwd(),
        loop: 'vscode',
        force: false,
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--force') opts.force = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a.startsWith('--loop=')) {
            const v = a.slice('--loop='.length);
            if (v !== 'vscode' && v !== 'intellij') throw new Error(`--loop must be 'vscode' or 'intellij', got '${v}'`);
            opts.loop = v;
        } else if (a.startsWith('--target-dir=')) {
            opts.targetDir = path.resolve(a.slice('--target-dir='.length));
        } else if (a === '--target-dir') {
            opts.targetDir = path.resolve(argv[++i] || '');
        } else if (a === '--help' || a === '-h') {
            printHelpAndExit();
        } else {
            throw new Error(`unrecognized init-agents arg: ${a}`);
        }
    }
    return opts;
}

function printHelpAndExit(): never {
    process.stdout.write(`
cs-playwright-mcp init-agents — scaffold .github/ + .vscode/ into a consumer repo.

Usage:
  npx cs-playwright-mcp init-agents [options]

Options:
  --loop=vscode|intellij   Editor loop. Default: vscode.
  --target-dir=<path>      Target root. Default: cwd.
  --force                  Overwrite existing files (defaults to skip).
  --dry-run                Report what WOULD be written, don't write anything.
  --help, -h               This message.

Writes (from embedded templates baked at framework build time):
  .github/copilot-instructions.md
  .github/instructions/*.instructions.md
  .github/prompts/*.prompt.md
  .vscode/settings.json         (vscode loop only)
  .vscode/mcp.json              (synthesized — npx cs-playwright-mcp)
  .idea/mcp.json                (--loop=intellij variant)
  AGENTS.md

Skip behaviour:
  Existing files are skipped by default. Use --force to overwrite.

After scaffolding: restart VS Code (or reload the window). Copilot picks up
.vscode/mcp.json and launches the cs-qa MCP server automatically.
`);
    process.exit(0);
}
