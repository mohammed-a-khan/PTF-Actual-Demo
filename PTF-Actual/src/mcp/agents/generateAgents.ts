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
    if (loop === 'vscode') {
        // VS Code format uses "servers" not "mcpServers"
        return {
            servers: {
                [serverName]: {
                    type: 'stdio',
                    command: 'npx',
                    args: ['cs-playwright-mcp'],
                },
            },
        };
    } else {
        // Claude Code and OpenCode use "mcpServers"
        return {
            mcpServers: {
                [serverName]: {
                    command: 'npx',
                    args: ['cs-playwright-mcp'],
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
    const agents = ['planner', 'generator', 'healer', 'assistant'];
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
