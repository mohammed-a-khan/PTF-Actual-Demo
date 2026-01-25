#!/usr/bin/env node
/**
 * CS Playwright MCP Server Verification Script
 * Verifies the MCP server implementation is working correctly
 *
 * Usage: npx ts-node src/mcp/verify.ts
 */

import { createFullMCPServer, createMCPServerWithTools, ToolCategory, MCPToolContext } from './index';

// ============================================================================
// Simple Test Framework (no dependencies)
// ============================================================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
    try {
        const result = fn();
        if (result instanceof Promise) {
            result.then(() => {
                console.log(`  ✓ ${name}`);
                passed++;
            }).catch((err) => {
                console.log(`  ✗ ${name}: ${err.message}`);
                failed++;
            });
        } else {
            console.log(`  ✓ ${name}`);
            passed++;
        }
    } catch (err) {
        console.log(`  ✗ ${name}: ${(err as Error).message}`);
        failed++;
    }
}

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
    if (actual !== expected) {
        throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
}

function assertGreaterThan(actual: number, expected: number, message?: string): void {
    if (actual <= expected) {
        throw new Error(message || `Expected ${actual} > ${expected}`);
    }
}

// ============================================================================
// Verification Tests
// ============================================================================

async function runVerification(): Promise<void> {
    console.log('\n========================================');
    console.log('CS Playwright MCP Server Verification');
    console.log('========================================\n');

    // Test 1: Create full server
    console.log('1. Server Creation');
    console.log('-------------------');

    test('Create full MCP server', () => {
        const server = createFullMCPServer();
        assert(server !== null, 'Server should be created');
        server.stop();
    });

    test('Create server with custom config', () => {
        const server = createFullMCPServer({
            name: 'test-server',
            version: '1.0.0',
        });
        assert(server !== null, 'Server should accept config');
        server.stop();
    });

    // Test 2: Tool Registration
    console.log('\n2. Tool Registration');
    console.log('--------------------');

    const server = createFullMCPServer();
    const registry = server.getToolRegistry();
    const toolCount = registry.getToolCount();
    const categories = registry.getToolCountsByCategory();

    test(`Total tools registered (${toolCount})`, () => {
        assertGreaterThan(toolCount, 140, `Expected 140+ tools, got ${toolCount}`);
    });

    // Test each category
    const expectedCategories: Record<string, number> = {
        'browser': 30,
        'bdd': 10,
        'database': 20,
        'cicd': 20,
        'network': 7,
        'api': 6,
        'analytics': 8,
        'security': 8,
        'multiagent': 10,
        'environment': 15,
        'generation': 8,
    };

    console.log('\n3. Tool Categories');
    console.log('------------------');

    for (const [category, minCount] of Object.entries(expectedCategories)) {
        const actualCount = (categories as Record<string, number>)[category] || 0;
        test(`${category}: ${actualCount} tools (min: ${minCount})`, () => {
            assertGreaterThan(actualCount, minCount - 1, `${category} should have at least ${minCount} tools`);
        });
    }

    // Test 3: Specific Tools Exist
    console.log('\n4. Key Tools Verification');
    console.log('-------------------------');

    const keyTools = [
        // Browser
        'browser_launch', 'browser_navigate', 'browser_click', 'browser_fill', 'browser_snapshot',
        // BDD
        'bdd_list_features', 'bdd_run_feature', 'bdd_execute_step',
        // Database
        'db_connect', 'db_query', 'db_create_snapshot',
        // CI/CD
        'ado_pipelines_list', 'ado_builds_queue', 'ado_work_items_create',
        // Network
        'network_intercept', 'api_request', 'api_graphql',
        // Analytics
        'analytics_flakiness', 'analytics_execution_trends',
        // Security
        'security_xss_scan', 'security_sql_injection_test', 'security_header_check',
        // Multi-Agent
        'agent_spawn', 'agent_sync_barrier', 'agent_workflow_create',
        // Environment
        'env_set', 'feature_flag_set', 'mock_server_start',
        // Generation
        'generate_page_object', 'generate_test', 'generate_selector',
    ];

    for (const toolName of keyTools) {
        test(`Tool exists: ${toolName}`, () => {
            assert(registry.hasTool(toolName), `Tool ${toolName} should exist`);
        });
    }

    // Test 4: Selective Tool Loading
    console.log('\n5. Selective Tool Loading');
    console.log('-------------------------');

    test('Create server with only browser tools', () => {
        const browserServer = createMCPServerWithTools(['browser']);
        const counts = browserServer.getToolRegistry().getToolCountsByCategory();
        assertGreaterThan(counts['browser'] || 0, 0, 'Should have browser tools');
        assertEqual(counts['database'] || 0, 0, 'Should not have database tools');
        browserServer.stop();
    });

    test('Create server with multiple categories', () => {
        const multiServer = createMCPServerWithTools(['browser', 'security', 'analytics']);
        const counts = multiServer.getToolRegistry().getToolCountsByCategory();
        assertGreaterThan(counts['browser'] || 0, 0, 'Should have browser tools');
        assertGreaterThan(counts['security'] || 0, 0, 'Should have security tools');
        assertGreaterThan(counts['analytics'] || 0, 0, 'Should have analytics tools');
        assertEqual(counts['database'] || 0, 0, 'Should not have database tools');
        multiServer.stop();
    });

    // Test 5: Tool Execution
    console.log('\n6. Tool Execution');
    console.log('-----------------');

    // Create a mock context for tool execution
    const mockContext: MCPToolContext = {
        server: {
            workingDirectory: process.cwd(),
        },
        notify: () => {},
        log: () => {},
    };

    test('Execute analytics_flakiness tool', async () => {
        const result = await registry.executeTool('analytics_flakiness', { days: 7 }, mockContext);
        assert(!result.isError, 'Should not return error');
    });

    test('Execute env_get tool', async () => {
        const result = await registry.executeTool('env_get', { name: 'PATH' }, mockContext);
        assert(!result.isError, 'Should not return error');
    });

    test('Execute feature_flag_list tool', async () => {
        const result = await registry.executeTool('feature_flag_list', {}, mockContext);
        assert(!result.isError, 'Should not return error');
    });

    // Cleanup
    server.stop();

    // Wait for async tests
    await new Promise(resolve => setTimeout(resolve, 100));

    // Summary
    console.log('\n========================================');
    console.log('Verification Summary');
    console.log('========================================');
    console.log(`Total Tools: ${toolCount}`);
    console.log(`Categories: ${Object.keys(categories).length}`);
    console.log(`\nTests: ${passed} passed, ${failed} failed`);
    console.log('========================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

// Run verification
runVerification().catch(err => {
    console.error('Verification failed:', err);
    process.exit(1);
});
