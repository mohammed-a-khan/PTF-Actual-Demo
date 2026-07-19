/**
 * PTF-ADO MCP Server
 * Main server class that orchestrates the MCP protocol
 * Implements the Model Context Protocol specification
 *
 * @module CSMCPServer
 */

import {
    JsonRpcRequest,
    MCPServerInfo,
    MCPClientInfo,
    MCPCapabilities,
    MCPTool,
    MCPToolCall,
    MCPToolResult,
    MCPToolContext,
    MCPResource,
    MCPResourceTemplate,
    MCPResourceContents,
    MCPResourceDefinition,
    MCPPrompt,
    MCPPromptDefinition,
    MCPGetPromptResult,
    MCPSamplingRequest,
    MCPSamplingResult,
    MCPElicitationRequest,
    MCPElicitationResult,
    MCPLogLevel,
    MCPNotification,
    MCP_METHODS,
    MCP_NOTIFICATIONS,
    MCPServerContext,
    MCPSamplingClient,
    MCPElicitationClient,
    JSON_RPC_ERRORS,
} from './types/CSMCPTypes';
import { CSMCPProtocol } from './CSMCPProtocol';
import { CSMCPToolRegistry } from './CSMCPToolRegistry';

// ============================================================================
// Server Configuration
// ============================================================================

export interface CSMCPServerConfig {
    name?: string;
    version?: string;
    workingDirectory?: string;
    capabilities?: Partial<MCPCapabilities>;
    logLevel?: MCPLogLevel;
}

const DEFAULT_CONFIG: Required<CSMCPServerConfig> = {
    name: 'cs-playwright-mcp',
    version: '1.0.0',
    workingDirectory: process.cwd(),
    capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        // Spec shape: an empty object, not a boolean.
        logging: {},
        // NOTE: sampling and elicitation are CLIENT capabilities — the server
        // USES them when the connected host declares them at initialize, but
        // must not advertise them as its own (fixed per MCP spec audit).
    },
    logLevel: 'info',
};

// ============================================================================
// MCP Server Class
// ============================================================================

export class CSMCPServer {
    private protocol: CSMCPProtocol;
    private toolRegistry: CSMCPToolRegistry;
    private config: Required<CSMCPServerConfig>;

    private clientInfo: MCPClientInfo | null = null;
    private clientCapabilities: Record<string, unknown> = {};
    private initialized: boolean = false;

    private resources: Map<string, MCPResourceDefinition> = new Map();
    private resourceTemplates: Map<string, MCPResourceDefinition> = new Map();
    private resourceSubscriptions: Map<string, Set<string>> = new Map();

    private prompts: Map<string, MCPPromptDefinition> = new Map();

    private serverContext: MCPServerContext;

    constructor(config?: CSMCPServerConfig) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.protocol = new CSMCPProtocol();
        this.toolRegistry = new CSMCPToolRegistry();

        this.serverContext = {
            workingDirectory: this.config.workingDirectory,
        };

        // Set up message handler
        this.protocol.setMessageHandler(this.handleMessage.bind(this));

        // Set log level
        this.protocol.setLogLevel(this.config.logLevel);
    }

    // ========================================================================
    // Server Lifecycle
    // ========================================================================

    /**
     * Start the MCP server
     */
    public start(): void {
        this.protocol.start();
        this.log('info', `${this.config.name} v${this.config.version} started`);
    }

    /**
     * Stop the MCP server
     */
    public stop(): void {
        this.protocol.stop();
        this.log('info', `${this.config.name} stopped`);
    }

    /**
     * Check if server is running
     */
    public isRunning(): boolean {
        return this.protocol.isActive();
    }

    // ========================================================================
    // Tool Management
    // ========================================================================

    /**
     * Get the tool registry
     */
    public getToolRegistry(): CSMCPToolRegistry {
        return this.toolRegistry;
    }

    /**
     * Notify clients that the tool list has changed
     */
    public notifyToolsChanged(): void {
        this.protocol.notify({
            method: MCP_NOTIFICATIONS.TOOLS_LIST_CHANGED,
        });
    }

    // ========================================================================
    // Resource Management
    // ========================================================================

    /**
     * Register a resource
     */
    public registerResource(definition: MCPResourceDefinition): void {
        const resource = definition.resource as MCPResource;
        this.resources.set(resource.uri, definition);
    }

    /**
     * Register a resource template
     */
    public registerResourceTemplate(definition: MCPResourceDefinition): void {
        const template = definition.resource as MCPResourceTemplate;
        this.resourceTemplates.set(template.uriTemplate, definition);
    }

    /**
     * Notify clients that a resource has been updated
     */
    public notifyResourceUpdated(uri: string): void {
        this.protocol.notify({
            method: MCP_NOTIFICATIONS.RESOURCES_UPDATED,
            params: { uri },
        });
    }

    /**
     * Notify clients that the resource list has changed
     */
    public notifyResourcesChanged(): void {
        this.protocol.notify({
            method: MCP_NOTIFICATIONS.RESOURCES_LIST_CHANGED,
        });
    }

    // ========================================================================
    // Prompt Management
    // ========================================================================

    /**
     * Register a prompt
     */
    public registerPrompt(definition: MCPPromptDefinition): void {
        this.prompts.set(definition.prompt.name, definition);
    }

    /**
     * Notify clients that the prompt list has changed
     */
    public notifyPromptsChanged(): void {
        this.protocol.notify({
            method: MCP_NOTIFICATIONS.PROMPTS_LIST_CHANGED,
        });
    }

    // ========================================================================
    // Context Management
    // ========================================================================

    /**
     * Set browser context
     */
    public setBrowserContext(browser: unknown, context: unknown, page: unknown): void {
        this.serverContext.browser = { browser, context, page };
    }

    /**
     * Clear browser context
     */
    public clearBrowserContext(): void {
        this.serverContext.browser = undefined;
    }

    /**
     * Set database context
     */
    public setDatabaseContext(connection: unknown, type: 'oracle' | 'postgres' | 'mysql' | 'mssql'): void {
        this.serverContext.database = { connection, type };
    }

    /**
     * Clear database context
     */
    public clearDatabaseContext(): void {
        this.serverContext.database = undefined;
    }

    /**
     * Set scenario context
     */
    public setScenarioContext(context: Map<string, unknown>): void {
        this.serverContext.scenarioContext = context;
    }

    // ========================================================================
    // Sampling & Elicitation (Client Requests)
    // ========================================================================

    /**
     * Request a completion from the client's LLM
     */
    public async requestSampling(request: MCPSamplingRequest): Promise<MCPSamplingResult> {
        const result = await this.protocol.sendRequest(MCP_METHODS.SAMPLING_CREATE_MESSAGE, request as unknown as Record<string, unknown>);
        return result as MCPSamplingResult;
    }

    /**
     * Request input from the user via the client
     */
    public async requestElicitation(request: MCPElicitationRequest): Promise<MCPElicitationResult> {
        const result = await this.protocol.sendRequest(MCP_METHODS.ELICITATION_CREATE, request as unknown as Record<string, unknown>);
        return result as MCPElicitationResult;
    }

    // ========================================================================
    // Logging
    // ========================================================================

    /**
     * Log a message
     */
    public log(level: MCPLogLevel, message: string, data?: unknown): void {
        this.protocol.log(level, message, data);
    }

    // ========================================================================
    // Message Handler
    // ========================================================================

    private async handleMessage(request: JsonRpcRequest, abortSignal?: AbortSignal): Promise<unknown> {
        const method = request.method;
        const params = request.params || {};

        switch (method) {
            // Lifecycle
            case MCP_METHODS.INITIALIZE:
                return this.handleInitialize(params);
            case MCP_METHODS.PING:
                return this.handlePing();

            // Tools
            case MCP_METHODS.TOOLS_LIST:
                return this.handleToolsList(params);
            case MCP_METHODS.TOOLS_CALL:
                return this.handleToolsCall(params, abortSignal);

            // Resources
            case MCP_METHODS.RESOURCES_LIST:
                return this.handleResourcesList(params);
            case MCP_METHODS.RESOURCES_TEMPLATES_LIST:
                return this.handleResourcesTemplatesList(params);
            case MCP_METHODS.RESOURCES_READ:
                return this.handleResourcesRead(params);
            case MCP_METHODS.RESOURCES_SUBSCRIBE:
                return this.handleResourcesSubscribe(params);
            case MCP_METHODS.RESOURCES_UNSUBSCRIBE:
                return this.handleResourcesUnsubscribe(params);

            // Prompts
            case MCP_METHODS.PROMPTS_LIST:
                return this.handlePromptsList(params);
            case MCP_METHODS.PROMPTS_GET:
                return this.handlePromptsGet(params);

            // Logging
            case MCP_METHODS.LOGGING_SET_LEVEL:
                return this.handleLoggingSetLevel(params);

            default: {
                // -32601 method-not-found (not -32603 internal-error) so hosts
                // can cheaply feature-detect optional methods.
                const err = new Error(`Method not found: ${method}`);
                (err as Error & { code: number }).code = JSON_RPC_ERRORS.METHOD_NOT_FOUND;
                throw err;
            }
        }
    }

    // ========================================================================
    // Method Handlers
    // ========================================================================

    private async handleInitialize(params: Record<string, unknown>): Promise<{
        protocolVersion: string;
        capabilities: MCPCapabilities;
        serverInfo: MCPServerInfo;
    }> {
        // Store client info + declared capabilities (drives whether tools are
        // offered sampling/elicitation contexts — see createToolContext).
        this.clientInfo = params.clientInfo as MCPClientInfo;
        this.clientCapabilities =
            (params.capabilities as Record<string, unknown> | undefined) ?? {};

        this.log('info', `Client connected: ${this.clientInfo?.name || 'unknown'}`);

        this.initialized = true;

        return {
            protocolVersion: '2025-06-18',
            capabilities: this.config.capabilities as MCPCapabilities,
            serverInfo: {
                name: this.config.name,
                version: this.config.version,
                protocolVersion: '2025-06-18',
            },
        };
    }

    private async handlePing(): Promise<Record<string, never>> {
        return {};
    }

    private async handleToolsList(_params: Record<string, unknown>): Promise<{
        tools: MCPTool[];
        nextCursor?: string;
    }> {
        // Server-side pagination is deliberately NOT engaged: the default
        // agentic profile exposes 5 meta-tools (packs add a few dozen at
        // most), and returning the full list avoids breaking hosts with
        // incomplete cursor support. (The previous cursor branch here was
        // dead code — the server never issued a nextCursor, so no client
        // could ever send a cursor.)
        return { tools: this.toolRegistry.getAllTools() };
    }

    private async handleToolsCall(params: Record<string, unknown>, abortSignal?: AbortSignal): Promise<MCPToolResult> {
        const toolCall = params as unknown as MCPToolCall;

        // Unknown tool is a protocol-level error (-32602), not a tool-result
        // error — matters after a pack release, when a host with a stale tool
        // list calls a just-unregistered tool.
        if (!this.toolRegistry.hasTool(toolCall.name)) {
            const err = new Error(`Unknown tool: ${toolCall.name}`);
            (err as Error & { code: number }).code = JSON_RPC_ERRORS.INVALID_PARAMS;
            throw err;
        }

        // Progress support: when the client attached a progressToken, hand the
        // tool a reporter bound to it (spec: notifications/progress).
        const progressToken = (params._meta as { progressToken?: string | number } | undefined)?.progressToken;

        const context = this.createToolContext(progressToken, abortSignal);

        return this.toolRegistry.executeTool(toolCall.name, toolCall.arguments, context);
    }

    private async handleResourcesList(params: Record<string, unknown>): Promise<{
        resources: MCPResource[];
        nextCursor?: string;
    }> {
        const resources = Array.from(this.resources.values()).map(d => d.resource as MCPResource);
        return { resources };
    }

    private async handleResourcesTemplatesList(params: Record<string, unknown>): Promise<{
        resourceTemplates: MCPResourceTemplate[];
    }> {
        const resourceTemplates = Array.from(this.resourceTemplates.values()).map(d => d.resource as MCPResourceTemplate);
        return { resourceTemplates };
    }

    private async handleResourcesRead(params: Record<string, unknown>): Promise<{
        contents: MCPResourceContents[];
    }> {
        const uri = params.uri as string;

        // Try direct resource match
        const resourceDef = this.resources.get(uri);
        if (resourceDef) {
            const context = this.createToolContext();
            const contents = await resourceDef.handler(uri, context);
            return { contents: [contents] };
        }

        // Try template match
        for (const [template, def] of this.resourceTemplates) {
            const regex = this.templateToRegex(template);
            if (regex.test(uri)) {
                const context = this.createToolContext();
                const contents = await def.handler(uri, context);
                return { contents: [contents] };
            }
        }

        throw new Error(`Resource not found: ${uri}`);
    }

    private async handleResourcesSubscribe(params: Record<string, unknown>): Promise<Record<string, never>> {
        const uri = params.uri as string;

        if (!this.resourceSubscriptions.has(uri)) {
            this.resourceSubscriptions.set(uri, new Set());
        }

        // In a full implementation, we'd track individual client subscriptions
        this.resourceSubscriptions.get(uri)!.add('client');

        return {};
    }

    private async handleResourcesUnsubscribe(params: Record<string, unknown>): Promise<Record<string, never>> {
        const uri = params.uri as string;

        const subs = this.resourceSubscriptions.get(uri);
        if (subs) {
            subs.delete('client');
            if (subs.size === 0) {
                this.resourceSubscriptions.delete(uri);
            }
        }

        return {};
    }

    private async handlePromptsList(params: Record<string, unknown>): Promise<{
        prompts: MCPPrompt[];
        nextCursor?: string;
    }> {
        const prompts = Array.from(this.prompts.values()).map(d => d.prompt);
        return { prompts };
    }

    private async handlePromptsGet(params: Record<string, unknown>): Promise<MCPGetPromptResult> {
        const name = params.name as string;
        const args = (params.arguments || {}) as Record<string, string>;

        const promptDef = this.prompts.get(name);
        if (!promptDef) {
            throw new Error(`Prompt not found: ${name}`);
        }

        const context = this.createToolContext();
        return promptDef.handler(args, context);
    }

    private async handleLoggingSetLevel(params: Record<string, unknown>): Promise<Record<string, never>> {
        const level = params.level as MCPLogLevel;
        this.protocol.setLogLevel(level);
        this.config.logLevel = level;
        return {};
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    private createToolContext(progressToken?: string | number, abortSignal?: AbortSignal): MCPToolContext {
        // Sampling and elicitation are CLIENT capabilities (server → client
        // requests). Only hand tools those clients when the connected host
        // declared support during initialize — otherwise a tool would fire a
        // request the host can never answer and stall until timeout. Tools
        // detect absence (context.elicitation === undefined) and use their
        // text-fallback paths instead.
        const samplingClient: MCPSamplingClient | undefined =
            this.clientCapabilities.sampling !== undefined
                ? { createMessage: (request: MCPSamplingRequest) => this.requestSampling(request) }
                : undefined;

        const elicitationClient: MCPElicitationClient | undefined =
            this.clientCapabilities.elicitation !== undefined
                ? { create: (request: MCPElicitationRequest) => this.requestElicitation(request) }
                : undefined;

        return {
            server: this.serverContext,
            sampling: samplingClient,
            elicitation: elicitationClient,
            notify: (notification: MCPNotification) => this.protocol.notify(notification),
            log: (level: MCPLogLevel, message: string, data?: unknown) => this.log(level, message, data),
            ...(progressToken !== undefined
                ? {
                      reportProgress: (progress: number, total?: number, message?: string) =>
                          this.protocol.sendProgress(progressToken, progress, total, message),
                  }
                : {}),
            ...(abortSignal ? { abortSignal } : {}),
        };
    }

    private templateToRegex(template: string): RegExp {
        // Convert URI template to regex
        // {param} -> ([^/]+)
        const pattern = template.replace(/\{[^}]+\}/g, '([^/]+)');
        return new RegExp(`^${pattern}$`);
    }
}

// ============================================================================
// Factory function
// ============================================================================

/**
 * Create a new MCP server instance
 */
export function createMCPServer(config?: CSMCPServerConfig): CSMCPServer {
    return new CSMCPServer(config);
}
