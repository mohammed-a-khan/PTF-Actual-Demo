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
export { testingTools, registerTestingTools } from './tools/testing/CSMCPTestingTools';
export { auditTools, registerAuditTools } from './tools/audit/CSMCPAuditTools';
export { pipelineTools, registerPipelineTools } from './tools/pipeline/CSMCPPipelineTools';
export { driftTools, registerDriftTools } from './tools/drift/CSMCPDriftTools';
export { equivalenceTools, registerEquivalenceTools } from './tools/equivalence/CSMCPEquivalenceTools';
export { intelligenceTools, registerIntelligenceTools } from './tools/intelligence/CSMCPIntelligenceTools';
export { healLoopTools, registerHealLoopTools } from './tools/heal-loop/CSMCPHealLoopTools';

// Export agent platform (master tool: cs_ai_auto_assist).
// Rebuild M1: monolithic generation removed; primitives land in M2-M10.
export { csAiAutoAssistTools } from './agent-platform';

// Export the v3 agentic platform (single-agent SDLC orchestration,
// lazy tool packs, live guardrails). See MCP_AGENTIC_REDESIGN.md.
export {
    agenticMetaTools,
    registerAgenticTools,
    CSSDLCCatalog,
    CSToolPacks,
    CSSessionStore,
    CSGuardrailEngine,
    CSPlaybookEngine,
    CSPlaybooks,
} from './agentic';

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
import { registerTestingTools } from './tools/testing/CSMCPTestingTools';
import { registerAuditTools } from './tools/audit/CSMCPAuditTools';
import { registerPipelineTools } from './tools/pipeline/CSMCPPipelineTools';
import { registerDriftTools } from './tools/drift/CSMCPDriftTools';
import { registerEquivalenceTools } from './tools/equivalence/CSMCPEquivalenceTools';
import { registerIntelligenceTools } from './tools/intelligence/CSMCPIntelligenceTools';
import { registerHealLoopTools } from './tools/heal-loop/CSMCPHealLoopTools';
import { csAiAutoAssistTools, csaaPrimitiveTools } from './agent-platform';
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
    | 'codegen'
    | 'testing'
    | 'audit';

/**
 * Create the v3 agentic MCP server — the DEFAULT profile.
 *
 * Registers the five cs_ai_auto_assist meta-tools plus the interactive-core
 * capability packs (browser walkthrough, the csaa_* authoring pipeline,
 * execution/heal, quality gates, read-only DB) EAGERLY, so their tools are in
 * the host's very first `tools/list`. This is required for snapshot-at-start
 * hosts (VS Code Copilot in "auto" mode) that capture the tool list when a
 * turn begins and ignore tools added later via `notifications/tools/list_changed`
 * — without it a browser/author handoff blocks with "the browser tools are not
 * available in this session".
 *
 * The heavy/specialised packs (ado, api, insights, security, generation, full
 * browser) stay lazy — they are large and mode-specific, and eager-loading
 * them would blow the host's ~128-tool cap. Tune the startup surface with
 * `config.eagerPacks` or the CSAA_EAGER_PACKS env var when a host/mode mix
 * needs a different profile.
 */
export function createAgenticMCPServer(config?: CSMCPServerConfig): CSMCPServer {
    const server = new CSMCPServer(config);
    const registry = server.getToolRegistry();

    const { registerAgenticTools, DEFAULT_EAGER_PACKS } =
        require('./agentic') as typeof import('./agentic');

    // Precedence: explicit config → CSAA_EAGER_PACKS env → interactive-core default.
    const envPacks = (process.env.CSAA_EAGER_PACKS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const eagerPacks =
        config?.eagerPacks !== undefined
            ? config.eagerPacks
            : envPacks.length > 0
              ? envPacks
              : DEFAULT_EAGER_PACKS;

    registerAgenticTools(registry, () => server.notifyToolsChanged(), eagerPacks);

    registerResources(server);
    registerPrompts(server);

    return server;
}

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
    registerTestingTools(registry);
    registerAuditTools(registry);
    registerPipelineTools(registry);
    registerDriftTools(registry);
    registerEquivalenceTools(registry);
    registerIntelligenceTools(registry);
    registerHealLoopTools(registry);
    registry.registerTools(csAiAutoAssistTools);
    registry.registerTools(csaaPrimitiveTools);

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

    const registrationMap: Partial<Record<ToolCategory, () => void>> = {
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
        testing: () => registerTestingTools(registry),
        audit: () => {
            registerAuditTools(registry);
            registerPipelineTools(registry);
        },
    };

    for (const category of toolCategories) {
        if (registrationMap[category]) {
            registrationMap[category]();
        }
    }

    // ALWAYS register the agent-platform entry point + its primitives — even
    // when callers select a narrow subset. The master tool's whole purpose is
    // to compose downstream csaa_* primitives; if it's present but the
    // primitives are not, the orchestrator advertises tools the host can't
    // find. Keep them paired.
    registry.registerTools(csAiAutoAssistTools);
    registry.registerTools(csaaPrimitiveTools);

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
        require('./tools/testing/CSMCPTestingTools').testingTools,
        require('./tools/audit/CSMCPAuditTools').auditTools,
        require('./tools/pipeline/CSMCPPipelineTools').pipelineTools,
        require('./tools/drift/CSMCPDriftTools').driftTools,
        require('./tools/equivalence/CSMCPEquivalenceTools').equivalenceTools,
    ];
    return allTools.reduce((sum, tools) => sum + tools.length, 0);
}
