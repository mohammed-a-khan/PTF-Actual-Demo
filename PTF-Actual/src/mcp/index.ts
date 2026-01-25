/**
 * CS Playwright MCP Server Entry Point
 * Main entry point for the Model Context Protocol server
 *
 * @module CSMCP
 */

// Export types
export * from './types/CSMCPTypes';

// Export core classes
export { CSMCPProtocol, mcpProtocol } from './CSMCPProtocol';
export { CSMCPToolRegistry, MCPToolBuilder, defineTool, toolRegistry } from './CSMCPToolRegistry';
export { CSMCPServer, createMCPServer, CSMCPServerConfig } from './CSMCPServer';

// Export tool registration functions
export { browserTools, registerBrowserTools } from './tools/browser/CSMCPBrowserTools';
export { bddTools, registerBDDTools } from './tools/bdd/CSMCPBDDTools';
export { databaseTools, registerDatabaseTools } from './tools/database/CSMCPDatabaseTools';
export { azureDevOpsTools, registerAzureDevOpsTools } from './tools/cicd/CSMCPAzureDevOpsTools';
export { networkTools, registerNetworkTools } from './tools/network/CSMCPNetworkTools';
export { analyticsTools, registerAnalyticsTools } from './tools/analytics/CSMCPAnalyticsTools';
export { securityTools, registerSecurityTools } from './tools/security/CSMCPSecurityTools';
export { multiAgentTools, registerMultiAgentTools } from './tools/multiagent/CSMCPMultiAgentTools';
export { environmentTools, registerEnvironmentTools } from './tools/environment/CSMCPEnvironmentTools';
export { generationTools, registerGenerationTools } from './tools/generation/CSMCPGenerationTools';
export { explorationTools, registerExplorationTools } from './tools/exploration/CSMCPExplorationTools';
export { codegenTools, registerCodegenTools } from './tools/codegen/CSMCPCodegenTools';

// Export resources and prompts
export { resourceDefinitions, resourceTemplateDefinitions, registerResources } from './resources/CSMCPResources';
export { promptDefinitions, registerPrompts } from './prompts/CSMCPPrompts';

// ============================================================================
// Quick Start Functions
// ============================================================================

import { CSMCPServer, CSMCPServerConfig } from './CSMCPServer';
import { registerBrowserTools } from './tools/browser/CSMCPBrowserTools';
import { registerBDDTools } from './tools/bdd/CSMCPBDDTools';
import { registerDatabaseTools } from './tools/database/CSMCPDatabaseTools';
import { registerAzureDevOpsTools } from './tools/cicd/CSMCPAzureDevOpsTools';
import { registerNetworkTools } from './tools/network/CSMCPNetworkTools';
import { registerAnalyticsTools } from './tools/analytics/CSMCPAnalyticsTools';
import { registerSecurityTools } from './tools/security/CSMCPSecurityTools';
import { registerMultiAgentTools } from './tools/multiagent/CSMCPMultiAgentTools';
import { registerEnvironmentTools } from './tools/environment/CSMCPEnvironmentTools';
import { registerGenerationTools } from './tools/generation/CSMCPGenerationTools';
import { registerExplorationTools } from './tools/exploration/CSMCPExplorationTools';
import { registerCodegenTools } from './tools/codegen/CSMCPCodegenTools';
import { registerResources } from './resources/CSMCPResources';
import { registerPrompts } from './prompts/CSMCPPrompts';

/**
 * Tool categories available for selective registration
 */
export type ToolCategory =
    | 'browser'
    | 'bdd'
    | 'database'
    | 'cicd'
    | 'network'
    | 'analytics'
    | 'security'
    | 'multiagent'
    | 'environment'
    | 'generation'
    | 'exploration'
    | 'codegen';

/**
 * Create and configure a fully-loaded MCP server with all tools
 */
export function createFullMCPServer(config?: CSMCPServerConfig): CSMCPServer {
    const server = new CSMCPServer(config);
    const registry = server.getToolRegistry();

    // Register all tool categories
    registerBrowserTools(registry);
    registerBDDTools(registry);
    registerDatabaseTools(registry);
    registerAzureDevOpsTools(registry);
    registerNetworkTools(registry);
    registerAnalyticsTools(registry);
    registerSecurityTools(registry);
    registerMultiAgentTools(registry);
    registerEnvironmentTools(registry);
    registerGenerationTools(registry);
    registerExplorationTools(registry);
    registerCodegenTools(registry);

    // Register resources and prompts
    registerResources(server);
    registerPrompts(server);

    return server;
}

/**
 * Create a minimal MCP server with only specified tool categories
 */
export function createMCPServerWithTools(
    toolCategories: ToolCategory[],
    config?: CSMCPServerConfig
): CSMCPServer {
    const server = new CSMCPServer(config);
    const registry = server.getToolRegistry();

    const registrationMap: Record<ToolCategory, () => void> = {
        browser: () => registerBrowserTools(registry),
        bdd: () => registerBDDTools(registry),
        database: () => registerDatabaseTools(registry),
        cicd: () => registerAzureDevOpsTools(registry),
        network: () => registerNetworkTools(registry),
        analytics: () => registerAnalyticsTools(registry),
        security: () => registerSecurityTools(registry),
        multiagent: () => registerMultiAgentTools(registry),
        environment: () => registerEnvironmentTools(registry),
        generation: () => registerGenerationTools(registry),
        exploration: () => registerExplorationTools(registry),
        codegen: () => registerCodegenTools(registry),
    };

    for (const category of toolCategories) {
        if (registrationMap[category]) {
            registrationMap[category]();
        }
    }

    return server;
}

/**
 * Get total count of available tools
 */
export function getTotalToolCount(): number {
    const allTools = [
        require('./tools/browser/CSMCPBrowserTools').browserTools,
        require('./tools/bdd/CSMCPBDDTools').bddTools,
        require('./tools/database/CSMCPDatabaseTools').databaseTools,
        require('./tools/cicd/CSMCPAzureDevOpsTools').azureDevOpsTools,
        require('./tools/network/CSMCPNetworkTools').networkTools,
        require('./tools/analytics/CSMCPAnalyticsTools').analyticsTools,
        require('./tools/security/CSMCPSecurityTools').securityTools,
        require('./tools/multiagent/CSMCPMultiAgentTools').multiAgentTools,
        require('./tools/environment/CSMCPEnvironmentTools').environmentTools,
        require('./tools/generation/CSMCPGenerationTools').generationTools,
        require('./tools/exploration/CSMCPExplorationTools').explorationTools,
        require('./tools/codegen/CSMCPCodegenTools').codegenTools,
    ];
    return allTools.reduce((sum, tools) => sum + tools.length, 0);
}
