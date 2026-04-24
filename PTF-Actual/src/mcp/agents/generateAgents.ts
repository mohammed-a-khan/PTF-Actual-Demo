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
import { AGENT_CONTENT, AGENT_NAMES } from './embeddedAgentContent';
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

type LoopType = 'vscode' | 'claude' | 'opencode';

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

function generateVSCodeChatmode(agent: AgentDefinition, serverName: string): string {
    const toolsList = agent.tools.map(t => `- ${serverName}/${t}`).join('\n');

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
    const toolsList = agent.tools.map(t => `  - ${serverName}/${t}`).join('\n');

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
    // Only the CS Playwright MCP server is registered — it exposes the full
    // browser automation surface (including browser_generate_locator) plus the
    // framework-specific tools. External MCPs can be added by the consumer
    // afterwards if they want additional capabilities.
    // The -y flag prevents npx from prompting, which would block stdio.
    if (loop === 'vscode') {
        // VS Code format uses "servers" not "mcpServers"
        return {
            servers: {
                [serverName]: {
                    command: 'npx',
                    args: ['-y', 'cs-playwright-mcp'],
                },
            },
        };
    } else {
        // Claude Code and OpenCode use "mcpServers"
        return {
            mcpServers: {
                [serverName]: {
                    command: 'npx',
                    args: ['-y', 'cs-playwright-mcp'],
                },
            },
        };
    }
}

// ============================================================================
// Seed Test Generator
// ============================================================================

function generateSeedTest(): string {
    return `/**
 * Seed test for CS Playwright Agents
 * This file is used to bootstrap the test environment for agents
 *
 * Customize this file to include:
 * - Common fixtures
 * - Global setup logic
 * - Base URL navigation
 */

import { describe, test, beforeEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

describe('Seed Test', {
    tags: ['@seed'],
}, ({ page, navigate, browserManager }) => {

    beforeEach('Setup', async () => {
        // Add any global setup here
        // e.g., await navigate('/');
    });

    test('seed test passes', async () => {
        // This test bootstraps the agent environment
        // Agents will use this as a template for generated tests
    });
});
`;
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

## Pipeline invocation

- \`@cs-playwright migrate <file>\` or \`@cs-playwright automate <url>\` triggers the full closed-loop pipeline
- Per-file human-gate handoffs are mandatory — never auto-advance without the user pressing "Approve + next"
- Never perform git operations

## Which agent should I use?

| When you want to… | Use |
|---|---|
| Migrate a legacy file, or automate a new app end-to-end, with audit + test-run + heal + 9 commit-ready gates | \`@cs-playwright\` (orchestrated pipeline, halts per file) |
| Plan tests by exploring an app (no migration) | \`@CS Playwright Planner\` (legacy, manual) |
| Generate BDD code from a manual test plan | \`@CS Playwright Generator\` (legacy, manual) |
| Fix one broken test quickly (no pipeline gates) | \`@CS Playwright Healer\` (legacy, manual) |
| General Q&A, browser automation, DB query, API call, CI/CD task | \`@CS Playwright Assistant\` (catch-all) |

Subagents (\`analyzer\`, \`data-ingestor\`, \`db-migrator\`, \`locator-reconciler\`, \`pipeline-generator\`, \`pipeline-healer\`) are invoked only by \`@cs-playwright\` — do not invoke them directly. (commit, push, stage, stash)

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

# Whether the orchestrator may call out to the official Playwright MCP
# for additional browser capabilities. Our own browser tools cover the same
# surface; leave false unless you specifically need a capability our MCP
# does not offer.
playwright_mcp_enabled: false
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

    // Delete only OUR existing agent files before creating new ones
    // Other tools may have their own agent files — leave those untouched
    // Use the canonical AGENT_NAMES from embeddedAgentContent so adding a new
    // agent definition automatically includes it in generation — no second array to update.
    const agents: readonly string[] = AGENT_NAMES;
    const csAgentPrefix = 'CS Playwright '; // Our VS Code .agent.md title prefix

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

    for (const agentName of agents) {
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

    // Generate seed test
    const seedTestPath = path.join(targetDir, 'seed.spec.ts');
    {
        const seedExisted = fs.existsSync(seedTestPath);
        fs.writeFileSync(seedTestPath, generateSeedTest());
        files.push(seedTestPath);
        console.log(`  ${seedExisted ? 'Updated' : 'Created'} seed.spec.ts`);
    }

    // Create specs directory for test plans
    const specsDir = path.join(targetDir, 'specs');
    if (!fs.existsSync(specsDir)) {
        fs.mkdirSync(specsDir, { recursive: true });

        // Create example spec
        const exampleSpecPath = path.join(specsDir, 'example.md');
        const exampleSpec = `# Test Plan: Example Feature

## Overview
This is an example test plan. Replace with your feature details.

## Prerequisites
- Application is running
- Test user exists

## Test Scenarios

### Scenario 1: Example Happy Path
**Priority**: High
**Type**: Smoke

**Given**: User is on the home page
**When**: User performs action
**Then**: Expected result occurs

## Notes
- Generated by CS Playwright Planner agent
`;
        fs.writeFileSync(exampleSpecPath, exampleSpec);
        files.push(exampleSpecPath);
        console.log(`  Created specs/example.md`);
    }

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
  .vscode/mcp.json      MCP server configuration (for VS Code)
  specs/                Test plan directory for Planner agent
  seed.spec.ts          Seed test file for agents

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
