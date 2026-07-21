#!/usr/bin/env node
/**
 * CS Playwright Agent Generator
 * Generates agent definition files for different IDE platforms
 *
 * Similar to Playwright's `npx playwright init-agents`
 *
 * Usage:
 *   npx cs-playwright-mcp init-agents --loop=vscode
 *   npx cs-playwright-mcp init-agents --loop=claude
 *
 * @module generateAgents
 */

import * as fs from 'fs';
import * as path from 'path';
import { AGENT_CONTENT } from './embeddedAgentContent';
import { SKILL_CONTENT, SKILL_NAMES } from '../skills/embeddedSkillContent';

// ============================================================================
// Types
// ============================================================================

interface AgentDefinition {
    name: string;
    title: string;
    description: string;
    model: string;
    color: string;
    tools: string[];
    instructions: string;
}

type LoopType = 'vscode' | 'jetbrains' | 'claude' | 'opencode';

/**
 * v3 (agentic redesign): the ONLY user-facing agent that is materialized into
 * a consumer repo. All orchestration is server-side (cs_ai_auto_assist +
 * csaa_* meta-tools), so there are no other agents.
 */
const GENERATED_AGENTS: readonly string[] = ['cs-ai-auto-assist'];

/**
 * Names of the retired legacy agents (the pre-redesign multi-agent set). Their
 * .md sources and embedded content are gone, but an upgrade from an older
 * install must still SWEEP any stale `<name>.chatmode.md` these versions
 * materialized into a consumer's repo. This is a names-only list — it carries
 * no content and nothing is generated from it; it only drives deletion.
 */
const RETIRED_AGENTS: readonly string[] = [
    'planner',
    'generator',
    'healer',
    'assistant',
    'cs-playwright',
    'cs-ai-auto-assist-v2',
    'analyzer',
    'data-ingestor',
    'db-migrator',
    'locator-reconciler',
    'pipeline-generator',
    'pipeline-healer',
    'clarification',
    'cs-scope-mapper',
    'cs-bdd-author',
    'cs-artifact-synthesizer',
    'cs-vault-writer',
    'cs-resilience-engineer',
    'cs-trust-arbiter',
    'cs-preflight-auditor',
];

// ============================================================================
// Simple YAML Frontmatter Parser (zero-dependency)
// ============================================================================

function parseSimpleYaml(yamlContent: string): Record<string, any> {
    const result: Record<string, any> = {};
    const lines = yamlContent.split('\n');
    let currentKey = '';
    let inArray = false;
    let arrayValues: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Check for array item
        if (trimmed.startsWith('- ')) {
            if (inArray && currentKey) {
                arrayValues.push(trimmed.slice(2).trim());
            }
            continue;
        }

        // If we were collecting array, save it
        if (inArray && currentKey && arrayValues.length > 0) {
            result[currentKey] = arrayValues;
            arrayValues = [];
            inArray = false;
        }

        // Check for key: value pair
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex > 0) {
            const key = trimmed.slice(0, colonIndex).trim();
            const value = trimmed.slice(colonIndex + 1).trim();

            if (value === '') {
                // Start of array or nested object
                currentKey = key;
                inArray = true;
                arrayValues = [];
            } else {
                result[key] = value;
            }
        }
    }

    // Handle last array if any
    if (inArray && currentKey && arrayValues.length > 0) {
        result[currentKey] = arrayValues;
    }

    return result;
}

// ============================================================================
// Agent Loader
// ============================================================================

function loadAgentDefinition(agentPath: string): AgentDefinition {
    // Read file and normalize line endings (handle Windows CRLF)
    const rawContent = fs.readFileSync(agentPath, 'utf-8');
    return loadAgentDefinitionFromContent(rawContent, agentPath);
}

function loadAgentDefinitionFromContent(rawContent: string, sourceName: string): AgentDefinition {
    // Normalize line endings (handle Windows CRLF)
    const content = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Parse YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) {
        throw new Error(`Invalid agent file format: ${sourceName}`);
    }

    const frontmatter = parseSimpleYaml(frontmatterMatch[1]);
    const instructions = frontmatterMatch[2].trim();

    return {
        name: frontmatter.name || '',
        title: frontmatter.title || '',
        description: frontmatter.description || '',
        model: frontmatter.model || 'sonnet',
        color: frontmatter.color || 'blue',
        tools: frontmatter.tools || [],
        instructions,
    };
}

// ============================================================================
// VS Code Chatmode Generator
// ============================================================================

// Built-in Copilot tool aliases per
// https://code.visualstudio.com/docs/copilot/customization/custom-agents.
// These MUST be written bare in the generated tools list. Anything else is
// treated as an MCP server tool and gets the `<serverName>/` prefix so Copilot
// can resolve it against the right server. Writing a built-in as
// `cs-playwright-mcp/read` would mislabel it as a non-existent MCP tool;
// writing an MCP tool bare as `legacy_parse` leaves Copilot unable to resolve
// which server owns it.
const BUILTIN_TOOL_ALIASES = new Set([
    'execute',
    'read',
    'edit',
    'search',
    'agent',
    'web',
    'todo',
]);

function qualifyToolName(tool: string, serverName: string, wholeServerWildcard = false): string {
    // Already a wildcard or explicitly server-qualified — pass through.
    if (tool.includes('/')) return tool;
    if (BUILTIN_TOOL_ALIASES.has(tool)) return tool;
    // Naming the MCP server itself grants ALL its tools — required for the
    // agentic profile, where capability-pack tools appear dynamically via
    // tools/list_changed and can't be enumerated statically. VS Code renamed
    // the whole-toolset reference: the bare server name is rejected with
    // "Tool or toolset '<server>' has been renamed, use '<server>/*' instead",
    // so the VS Code / JetBrains generator emits the `/*` wildcard form.
    if (tool === serverName) return wholeServerWildcard ? `${serverName}/*` : tool;
    return `${serverName}/${tool}`;
}

function generateVSCodeChatmode(agent: AgentDefinition, serverName: string): string {
    const toolsList = agent.tools
        .map(t => `- ${qualifyToolName(t, serverName, true)}`)
        .join('\n');

    return `---
description: ${agent.description}
tools:
${toolsList}
---

${agent.instructions}
`;
}

// ============================================================================
// Claude Code Generator
// ============================================================================

function generateClaudeChatmode(agent: AgentDefinition, serverName: string): string {
    const toolsList = agent.tools
        .map(t => `  - ${qualifyToolName(t, serverName)}`)
        .join('\n');

    return `---
name: ${agent.name}
description: ${agent.description}
model: ${agent.model}
tools:
${toolsList}
---

${agent.instructions}
`;
}

// ============================================================================
// MCP Config Generator
// ============================================================================

function generateMCPConfig(serverName: string, loop: LoopType): object {
    // cs-playwright-mcp is a `bin` inside @mdakhan.mak/cs-playwright-test-framework,
    // NOT a standalone npm package. `npx -y cs-playwright-mcp` would fail — npx
    // resolves by package name, not by bin name, so it tries to fetch a package
    // called "cs-playwright-mcp" from the registry (doesn't exist) and dies.
    //
    // The canonical form for "run a bin that lives inside a parent package" is:
    //   npx --package=<parent> <bin-name>
    // --yes suppresses the install-confirmation prompt that would block stdio.
    const command = 'npx';
    // const args = [
    //     '--yes',
    //     '--package=@mdakhan.mak/cs-playwright-test-framework',
    //     'cs-playwright-mcp',
    // ];
    const args = [
        '-y',
        'cs-playwright-mcp',
    ];

    if (loop === 'vscode') {
        // VS Code format uses "servers" not "mcpServers"
        return {
            servers: {
                [serverName]: { command, args },
            },
        };
    } else {
        // JetBrains Copilot, Claude Code and OpenCode use "mcpServers"
        return {
            mcpServers: {
                [serverName]: { command, args },
            },
        };
    }
}

// ============================================================================
// Workspace-level Copilot instructions (always-on rules)
// ============================================================================

function generateCopilotInstructions(): string {
    return `# CS Playwright Framework — Copilot Workspace Rules

These rules apply to every Copilot interaction in this repository. Custom agents in
\`.github/agents/\` and pattern skills in \`.github/skills/\` extend these defaults.

## Output is always TypeScript in the CS Playwright framework format

- Page objects: \`@CSPage('<kebab-key>')\` + extends \`CSBasePage\` (or \`CSFramePage\` for iframes) + every element via \`@CSGetElement\`
- Step definitions: \`@StepDefinitions\` class + \`@Page('<kebab-key>')\` injection + \`@CSBDDStepDef('<exact step text>')\`
- Feature files: Gherkin with \`Scenario Outline\` + JSON-sourced \`Examples:\` blocks
- Scenarios JSON: canonical \`[{ scenarioId, scenarioName, ...fields, runFlag }]\` shape
- DB helpers: \`CSDBUtils.executeQuery(alias, queryName, params)\` only — named queries in \`config/<project>/common/<project>-db-queries.env\`

## Always-on conventions

- xpath is the primary locator in every \`@CSGetElement\`; css/role variants go in \`alternativeLocators\`
- Interactive elements have \`selfHeal: true\`
- Action methods use \`*WithTimeout\` variants; navigation-triggering clicks use \`clickWithTimeout(30000)\` or higher
- Logging exclusively through \`CSReporter.info/pass/fail/debug\` — no \`console.log\`
- Assertions never use bare \`expect(...)\` — either framework-provided assertion or \`CSReporter.fail(msg) + throw new Error(msg)\`
- Config via \`CSValueResolver.resolve('{config:KEY}', context)\` — no raw \`process.env\`
- Plain numeric literals — \`5000\` not \`5_000\`
- No references to upstream application source paths / class names in generated files
- SQL is never inline; always a named query in the env file, invoked via \`CSDBUtils\`
- Schema references are verified via \`schema_lookup\` before SQL is written; unverified tables emit \`-- SCHEMA REFERENCE NEEDED\` and escalate

## The one agent: CS AI Auto-Assist

There is exactly ONE agent for everything test-related: **\`@CS AI Auto-Assist\`**.
It covers the complete SDLC through a menu of 13 modes — plan, analyze, design,
author, migrate, review, PR review, run, heal, triage, regression, performance,
audit. Users pick a mode and provide inputs; they never write prompts, and the
server-side engine drives orchestration, guardrails and AI-credit budgets.

- Invoke it for ANY test-automation request. Do not hand-roll test code in
  plain Copilot chat — the agent's audit gates exist for a reason.
- Never perform git operations (commit, push, stage, stash) on the user's behalf.
- Blocked states (\`BLOCKED_NEED_HUMAN\`, budget blocks) are surfaced verbatim
  and wait for the user — never worked around.

## Loading pattern skills

- Skills in \`.github/skills/<name>/SKILL.md\` are loaded on demand by the relevant subagent
- Don't re-invent patterns documented in a skill — cite the skill, apply the pattern, move on
`;
}

// ============================================================================
// Pipeline configuration template
// ============================================================================

function generateAgentPipelineConfig(projectName?: string): string {
    const name = projectName ?? '<project>';
    return `# Per-project pipeline configuration read by the CS Playwright orchestration pipeline.
# Drop this at the workspace root, alongside package.json. Edit the values below
# to match your project. All other behaviour is baked into the framework and
# needs no configuration here.

project_name: ${name}

# Default environment unless --env is passed on the test runner CLI.
environment_default: sit

# The test-runner command invoked by the Healer during the run-fix loop.
# Tokens $PROJECT_NAME and $ENVIRONMENT are substituted at run time.
test_runner_command: "npx cs-framework"
test_runner_args:
  - "--project=$PROJECT_NAME"
  - "--env=$ENVIRONMENT"

# ============================================================================
# Database (ALL FIELDS OPTIONAL — delete this whole block if your project has
# no DB verifications). The pipeline skips DB migration entirely when no SQL
# is found in your legacy source.
# ============================================================================

# Alias used by CSDBUtils.executeQuery(alias, ...) for this project.
db_alias: ${name}

# Named-query env file where migrated SQL is registered.
db_queries_file: config/${name}/common/${name}-db-queries.env

# SQL verification mode — how strict is the fabrication gate:
#   strict       Every table must appear in schema_reference_doc. Missing
#                table blocks the commit. Use when you have a reliable schema
#                doc and want maximum safety.
#   best-effort  Try schema_reference_doc; missing tables get a
#                "SCHEMA REFERENCE NEEDED" marker but the pipeline proceeds
#                and ships for human review. RECOMMENDED DEFAULT.
#   off          Skip schema_lookup entirely. Use when all your SQL comes
#                from legacy production code (verbatim ports; nothing to
#                fabricate) and you don't have a schema doc handy.
sql_verification: best-effort

# Schema reference doc — consumed by schema_lookup when sql_verification is
# 'strict' or 'best-effort'. Any markdown format works — headings like
# "## SCHEMA.TABLE" followed by a markdown table of columns. You can build
# this from Hibernate .hbm.xml, Prisma, TypeORM, migrations, \`DESC <table>\`
# output, or just type it by hand.
schema_reference_doc: docs/${name}-db-schema.md

# Extra SQL sources to scan during migration (beyond inline SQL in .java/.cs).
# The pipeline auto-detects:
#   .properties          Java-style key=sql entries
#   .xml (MyBatis)       <select|insert|update|delete id="..."> bodies
#   .xml (Hibernate)     <sql-query name="..."> bodies
#   .sql                 Raw statements separated by ;
# List paths here to have extract_db_calls pick them up automatically.
# All SQL pulled from these files is treated as legacy — verificationNeeded:false.
sql_sources:
  # - src/main/resources/sql-queries.properties
  # - src/main/resources/mappers/UserMapper.xml
  # - db/migrations/V1__initial.sql

# ============================================================================
# Heal loop + correction memory
# ============================================================================

correction_memory_path: .agent-runs/correction-patterns.md
`;
}

// ============================================================================
// Main Generator Function
// ============================================================================

export function generateAgents(
    targetDir: string,
    loop: LoopType,
    options: {
        serverName?: string;
        force?: boolean;
    } = {}
): { files: string[]; errors: string[] } {
    const serverName = options.serverName || 'cs-playwright-mcp';
    const agentSourceDir = path.join(__dirname);
    const files: string[] = [];
    const errors: string[] = [];

    // Create output directories
    // VS Code now uses .github/agents/ folder with .agent.md extension
    const agentsDir = path.join(targetDir, '.github', 'agents');
    const vscodeDir = path.join(targetDir, '.vscode');

    try {
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.mkdirSync(vscodeDir, { recursive: true });
    } catch (err: any) {
        errors.push(`Failed to create directories: ${err.message}`);
        return { files, errors };
    }

    // Delete only OUR existing agent files before creating new ones.
    // The generated agent PLUS every retired legacy name drives cleanup, so
    // upgrading from an older multi-agent install removes stale v1/v2 agents;
    // only GENERATED_AGENTS is materialized afterwards.
    const agents: readonly string[] = [...GENERATED_AGENTS, ...RETIRED_AGENTS];
    const csAgentPrefix = 'CS '; // Our VS Code .agent.md title prefix ("CS Playwright …", "CS AI …")

    try {
        const existingFiles = fs.readdirSync(agentsDir);
        for (const file of existingFiles) {
            const isOurAgentMd = file.endsWith('.agent.md') && file.startsWith(csAgentPrefix);
            const isOurChatmode = file.endsWith('.chatmode.md') && agents.includes(file.replace('.chatmode.md', ''));
            if (isOurAgentMd || isOurChatmode) {
                const filePath = path.join(agentsDir, file);
                fs.unlinkSync(filePath);
                console.log(`  Deleted existing ${file}`);
            }
        }
    } catch (err: any) {
        // Non-fatal — directory might be empty or not readable
        errors.push(`Warning: Could not clean existing agents: ${err.message}`);
    }

    for (const agentName of GENERATED_AGENTS) {
        try {
            // Try embedded content first (works in published npm package)
            // Fall back to .md file on disk (works in development mode)
            let agent: AgentDefinition;
            const embeddedContent = AGENT_CONTENT[agentName];

            if (embeddedContent && embeddedContent.length > 0) {
                agent = loadAgentDefinitionFromContent(embeddedContent, `embedded:${agentName}`);
            } else {
                const agentPath = path.join(agentSourceDir, `${agentName}.md`);
                if (!fs.existsSync(agentPath)) {
                    errors.push(`Agent definition not found: ${agentName} (neither embedded nor on disk at ${agentPath})`);
                    continue;
                }
                agent = loadAgentDefinition(agentPath);
            }

            // Generate agent file based on loop type
            // VS Code uses .agent.md extension, Claude/OpenCode use .chatmode.md
            let agentContent: string;
            let agentFileName: string;

            switch (loop) {
                case 'vscode':
                case 'jetbrains':
                    // JetBrains Copilot consumes the same .github/agents/*.agent.md
                    // custom-agent format as VS Code.
                    agentContent = generateVSCodeChatmode(agent, serverName);
                    agentFileName = `${agent.title}.agent.md`;
                    break;

                case 'claude':
                    agentContent = generateClaudeChatmode(agent, serverName);
                    agentFileName = `${agentName}.chatmode.md`;
                    break;

                case 'opencode':
                    agentContent = generateClaudeChatmode(agent, serverName);
                    agentFileName = `${agentName}.chatmode.md`;
                    break;

                default:
                    agentContent = generateClaudeChatmode(agent, serverName);
                    agentFileName = `${agentName}.chatmode.md`;
            }

            const agentFilePath = path.join(agentsDir, agentFileName);
            const existed = fs.existsSync(agentFilePath);

            fs.writeFileSync(agentFilePath, agentContent);
            files.push(agentFilePath);
            console.log(`  ${existed ? 'Updated' : 'Created'} ${agentFileName}`);
        } catch (err: any) {
            errors.push(`Failed to generate ${agentName}: ${err.message}`);
        }
    }

    // Generate MCP config
    const mcpConfigPath = loop === 'vscode'
        ? path.join(vscodeDir, 'mcp.json')
        : path.join(targetDir, 'mcp.json');

    {
        const mcpExisted = fs.existsSync(mcpConfigPath);
        const mcpConfig = generateMCPConfig(serverName, loop);
        fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        files.push(mcpConfigPath);
        console.log(`  ${mcpExisted ? 'Updated' : 'Created'} mcp.json`);
        if (loop === 'jetbrains') {
            console.log(
                '  JetBrains note: register the server once in the IDE — ' +
                'GitHub Copilot plugin → Settings → MCP → add the contents of ./mcp.json ' +
                '(or copy it to the Copilot plugin\'s mcp.json location).',
            );
        }
    }

    // Write workspace-level copilot-instructions.md (default: skip if exists)
    try {
        const copilotPath = path.join(targetDir, '.github', 'copilot-instructions.md');
        const ciExists = fs.existsSync(copilotPath);
        if (!ciExists || options.force) {
            fs.mkdirSync(path.dirname(copilotPath), { recursive: true });
            fs.writeFileSync(copilotPath, generateCopilotInstructions());
            files.push(copilotPath);
            console.log(`  ${ciExists ? 'Updated' : 'Created'} .github/copilot-instructions.md`);
        } else {
            console.log(`  Kept existing .github/copilot-instructions.md`);
        }
    } catch (err: any) {
        errors.push(`Failed to write copilot-instructions: ${err.message}`);
    }

    // Write seed .agent-pipeline.yaml at workspace root (default: skip if exists)
    try {
        const pipelineCfgPath = path.join(targetDir, '.agent-pipeline.yaml');
        const pcExists = fs.existsSync(pipelineCfgPath);
        if (!pcExists || options.force) {
            fs.writeFileSync(pipelineCfgPath, generateAgentPipelineConfig());
            files.push(pipelineCfgPath);
            console.log(`  ${pcExists ? 'Updated' : 'Created'} .agent-pipeline.yaml`);
        } else {
            console.log(`  Kept existing .agent-pipeline.yaml`);
        }
    } catch (err: any) {
        errors.push(`Failed to write .agent-pipeline.yaml: ${err.message}`);
    }

    // Materialise embedded skills to .github/skills/<skill>/<file>
    // Default: skip if file exists on disk (do not clobber consumer edits)
    // options.force === true: overwrite everything
    try {
        const skillsRootDir = path.join(targetDir, '.github', 'skills');
        fs.mkdirSync(skillsRootDir, { recursive: true });
        let skillFileCount = 0;
        let skillSkippedCount = 0;
        for (const skillName of SKILL_NAMES) {
            const files = SKILL_CONTENT[skillName] || {};
            const skillDir = path.join(skillsRootDir, skillName);
            fs.mkdirSync(skillDir, { recursive: true });
            for (const [relPath, content] of Object.entries(files)) {
                const targetPath = path.join(skillDir, relPath);
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                const exists = fs.existsSync(targetPath);
                if (exists && !options.force) {
                    skillSkippedCount++;
                    continue;
                }
                fs.writeFileSync(targetPath, content);
                skillFileCount++;
            }
        }
        console.log(`  Skills: ${skillFileCount} file(s) written, ${skillSkippedCount} skipped (already present)`);
    } catch (err: any) {
        errors.push(`Failed to write skills: ${err.message}`);
    }

    // v1.39.7 — seed.spec.ts + specs/example.md scaffolding REMOVED from
    // init-agents. This framework is BDD-centric (features + step-defs),
    // not Playwright-spec-style, so:
    //   - `seed.spec.ts` was a Playwright-spec scaffold that never fit the
    //     project shape, AND was overwritten unconditionally on every init
    //     run (silently clobbering any consumer customisation).
    //   - `specs/example.md` was a stub for the planner agent's output
    //     directory. The planner agent (and any future plan-producing
    //     agent) is responsible for creating its own output folder on
    //     first use — init shouldn't pre-create it as empty scaffolding.
    //
    // If a future workflow truly needs either artifact, the relevant
    // agent (planner / generator) creates them on demand inside the
    // consumer project. They don't belong in init.

    return { files, errors };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function main(): void {
    const args = process.argv.slice(2);

    // Parse arguments
    let loop: LoopType = 'vscode';
    let force = false;
    let targetDir = process.cwd();

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--loop' || arg === '-l') {
            const loopArg = args[++i];
            if (['vscode', 'claude', 'opencode'].includes(loopArg)) {
                loop = loopArg as LoopType;
            } else {
                console.error(`Invalid loop type: ${loopArg}`);
                console.error('Valid options: vscode, claude, opencode');
                process.exit(1);
            }
        } else if (arg.startsWith('--loop=')) {
            const loopArg = arg.split('=')[1];
            if (['vscode', 'claude', 'opencode'].includes(loopArg)) {
                loop = loopArg as LoopType;
            }
        } else if (arg === '--force' || arg === '-f') {
            force = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
CS Playwright Agent Generator
==============================

Initialize AI agent definitions for your test project.

Usage:
  npx cs-playwright-mcp init-agents [options]

Options:
  --loop, -l <type>   IDE/client type: vscode, claude, opencode (default: vscode)
  --force, -f         Overwrite existing files
  --help, -h          Show this help message

Examples:
  npx cs-playwright-mcp init-agents --loop=vscode
  npx cs-playwright-mcp init-agents --loop=claude --force

Generated Files:
  .github/agents/       Agent definition files for your IDE
  .github/skills/       Pattern skills consumed by the agents
  .github/copilot-instructions.md    Workspace-level Copilot rules
  .vscode/mcp.json      MCP server configuration (for VS Code)

Agents:
  - Planner:   Explores apps and generates test plans
  - Generator: Converts plans to Playwright tests
  - Healer:    Debugs and fixes failing tests
  - Assistant:  Interactive test assistant
  - Migration: Migrates legacy Selenium/QAF tests to CS Playwright
`);
            process.exit(0);
        } else if (!arg.startsWith('-')) {
            targetDir = path.resolve(arg);
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

    console.log(`
Done! Generated ${files.length} files.

Next steps:
1. Open your IDE (${loop === 'vscode' ? 'VS Code' : loop === 'claude' ? 'Claude Code' : 'OpenCode'})
2. Start a chat with the Planner agent to create a test plan
3. Use the Generator agent to create tests from the plan
4. Use the Healer agent to fix any failing tests

For more information, see: https://github.com/your-repo/cs-playwright-mcp
`);
}

// Run if executed directly
if (require.main === module) {
    main();
}
