#!/usr/bin/env node
/**
 * Standalone CLI wrapper for `cs_ai_auto_assist` (Phase 9-lite).
 *
 * Lets users / CI pipelines invoke the master tool without a host MCP
 * client. Two trade-offs vs. the IDE flow:
 *   1. No `context.sampling` is available, so LLM-bound modes
 *      (legacy/document/source/chat) return a structured blocked
 *      reason instead of generating. The CLI is intended primarily
 *      for the deterministic modes (ADO read, app_url, dry-run any).
 *   2. Result is JSON to stdout; status code reflects state.
 *
 * Usage:
 *   cs-ai-auto-assist --input "TC#3430" [--mode <mode>] [--dry-run]
 *                     [--answers '{"adoOrganization":"...", ...}']
 *                     [--budget '{"maxTokens":1000000}']
 *                     [--publish-results true|false]
 *                     [--no-trace]
 *
 * Exit codes:
 *   0  — READY
 *   2  — BLOCKED_NEED_INPUT (clarification or sanitiser)
 *   3  — BLOCKED_NEED_HUMAN (heal loop / dispatch failed)
 *   4  — BLOCKED_BUDGET
 *   1  — fatal error (bad args, unhandled exception)
 *
 * @module agent-platform/cli
 */

import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { csAiAutoAssistTools as agentPlatformTools } from './index';
import {
    MCPToolContext,
    MCPToolDefinition,
} from '../types/CSMCPTypes';

interface CliArgs {
    input?: string;
    mode?: string;
    dryRun?: boolean;
    answers?: Record<string, string>;
    budget?: Record<string, number>;
    publishResults?: boolean;
    traceEnabled?: boolean;
    help?: boolean;
}

const HELP = `cs-ai-auto-assist — standalone CLI for the agent-platform master tool

Usage:
  cs-ai-auto-assist --input "<value>" [options]

Required:
  --input "<value>"       The user input to classify (TC#<n>, file path,
                          URL, or free-form text).

Options:
  --mode <name>           Force a specific mode (skip the router).
  --dry-run               Run preview only — no LLM, no heal loop, no I/O.
                          Useful for cost estimation.
  --answers '<json>'      Pre-populated clarification answers as JSON.
  --budget '<json>'       Token / wall-clock / dollar budget overrides.
  --publish-results       Override ADO_INTEGRATION_ENABLED for this run.
  --no-publish-results    Force-disable publishing for this run.
  --no-trace              Disable .agent-runs/runs/<runId>.jsonl writes.
  --help, -h              Show this help.

Note: LLM-bound modes (legacy/document/source/chat) require an MCP host
that exposes \`context.sampling\` — the CLI prints a structured blocked
reason for those. Run inside VS Code / Claude Code for full coverage.
`;

function parseArgs(argv: string[]): CliArgs {
    const out: CliArgs = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--help':
            case '-h':
                out.help = true;
                break;
            case '--input':
                out.input = argv[++i];
                break;
            case '--mode':
                out.mode = argv[++i];
                break;
            case '--dry-run':
                out.dryRun = true;
                break;
            case '--answers':
                try {
                    out.answers = JSON.parse(argv[++i]);
                } catch (err) {
                    fatal(`--answers must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
                }
                break;
            case '--budget':
                try {
                    out.budget = JSON.parse(argv[++i]);
                } catch (err) {
                    fatal(`--budget must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
                }
                break;
            case '--publish-results':
                out.publishResults = true;
                break;
            case '--no-publish-results':
                out.publishResults = false;
                break;
            case '--no-trace':
                out.traceEnabled = false;
                break;
            default:
                if (a.startsWith('--')) {
                    fatal(`Unknown option: ${a}. Run with --help.`);
                }
        }
    }
    return out;
}

function fatal(msg: string): never {
    process.stderr.write(`cs-ai-auto-assist: ${msg}\n`);
    process.exit(1);
}

function buildStubContext(): MCPToolContext {
    return {
        server: { workingDirectory: process.cwd() },
        notify: () => undefined,
        log: (level: string, message: string, data?: unknown) => {
            // CLI logs to stderr so stdout stays JSON-clean.
            const suffix = data ? ' ' + JSON.stringify(data) : '';
            process.stderr.write(`[${level}] ${message}${suffix}\n`);
        },
        // sampling is intentionally unset — CLI mode runs the deterministic
        // path through the master tool. LLM-bound modes self-report the
        // blocked reason in the structured result.
    };
}

function exitCodeFor(state: string): number {
    switch (state) {
        case 'READY': return 0;
        case 'BLOCKED_NEED_INPUT': return 2;
        case 'BLOCKED_BUDGET': return 4;
        case 'BLOCKED_NEED_HUMAN': return 3;
        default: return 3;
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.input) {
        process.stdout.write(HELP);
        process.exit(args.help ? 0 : 1);
    }

    // Initialise the framework's configuration hierarchy so the master
    // tool can resolve ADO_PAT etc. from .env.
    try {
        await CSConfigurationManager.getInstance().initialize({});
    } catch (err) {
        process.stderr.write(
            `cs-ai-auto-assist: CSConfigurationManager init failed (continuing without): ${err instanceof Error ? err.message : String(err)}\n`,
        );
    }

    const masterTool = (agentPlatformTools as MCPToolDefinition[]).find(
        (d) => d.tool.name === 'cs_ai_auto_assist',
    );
    if (!masterTool) {
        fatal('cs_ai_auto_assist tool not found in agentPlatformTools');
    }

    const params: Record<string, unknown> = { input: args.input };
    if (args.mode) params.mode = args.mode;
    if (args.dryRun) params.dryRun = true;
    if (args.answers) params.answers = args.answers;
    if (args.budget) params.budget = args.budget;
    if (typeof args.publishResults === 'boolean') {
        params.publishResults = args.publishResults;
    }
    if (args.traceEnabled === false) {
        params.traceEnabled = false;
    }

    const context = buildStubContext();
    const result = await masterTool.handler(params, context);

    // Pull the structured result for stdout.
    const sc = result.structuredContent as Record<string, unknown> | undefined;
    const payload =
        sc && Object.keys(sc).length > 0
            ? sc
            : (() => {
                  for (const c of result.content) {
                      if (c.type === 'text') {
                          try {
                              return JSON.parse(c.text);
                          } catch {
                              return { raw: c.text };
                          }
                      }
                  }
                  return {};
              })();

    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    const state = String(payload.state ?? 'BLOCKED_NEED_HUMAN');
    process.exit(exitCodeFor(state));
}

main().catch((err) => {
    process.stderr.write(
        `cs-ai-auto-assist: fatal — ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
});
