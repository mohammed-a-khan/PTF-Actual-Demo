#!/usr/bin/env node
/**
 * Quick MCP Tools Test Script
 * Tests individual tools without full server setup
 */

import { createFullMCPServer } from './index';
import { MCPToolContext } from './types/CSMCPTypes';

async function testTools() {
    console.log('\n🧪 MCP Tools Test\n');
    console.log('='.repeat(50));

    const server = createFullMCPServer();
    const registry = server.getToolRegistry();

    // Show total tool count
    const allTools = registry.getAllTools();
    console.log(`\n📊 Total registered tools: ${allTools.length}`);

    // Show exploration tools
    const explorationTools = allTools.filter((t: any) => t.name.includes('explor') || t.name.includes('discover') || t.name.includes('analyze_form'));
    console.log(`🔍 Exploration tools: ${explorationTools.length}`);
    explorationTools.forEach((t: any) => console.log(`   - ${t.name}`));

    // Create mock context
    const mockContext: MCPToolContext = {
        server: {
            workingDirectory: process.cwd(),
        },
        notify: () => {},
        log: (level, msg) => console.log(`  [${level}] ${msg}`),
    };

    // Test cases
    const tests = [
        {
            name: 'env_get',
            params: { name: 'PATH' },
            description: 'Get PATH environment variable',
        },
        {
            name: 'env_list',
            params: { pattern: 'CS_*' },
            description: 'List CS_ prefixed env vars',
        },
        {
            name: 'feature_flag_list',
            params: {},
            description: 'List feature flags',
        },
        {
            name: 'analytics_flakiness',
            params: { days: 7 },
            description: 'Get flakiness analysis',
        },
        {
            name: 'bdd_list_features',
            params: { directory: './test' },
            description: 'List BDD features',
        },
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        console.log(`\n📋 Testing: ${test.name}`);
        console.log(`   ${test.description}`);

        try {
            const result = await registry.executeTool(test.name, test.params, mockContext);

            if (result.isError) {
                const content = result.content[0] as any;
                console.log(`   ❌ Error: ${content?.text || 'Unknown error'}`);
                failed++;
            } else {
                console.log(`   ✅ Success`);
                // Show first 200 chars of result
                const content = result.content[0] as any;
                const text = content?.text || '';
                if (text.length > 200) {
                    console.log(`   Result: ${text.substring(0, 200)}...`);
                } else {
                    console.log(`   Result: ${text}`);
                }
                passed++;
            }
        } catch (error) {
            console.log(`   ❌ Exception: ${(error as Error).message}`);
            failed++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50) + '\n');

    server.stop();
    process.exit(failed > 0 ? 1 : 0);
}

testTools().catch(console.error);
