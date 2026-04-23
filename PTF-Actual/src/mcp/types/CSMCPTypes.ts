/**
 * PTF-ADO MCP Server Types
 * Model Context Protocol type definitions
 * Zero-dependency implementation using only Node.js built-ins
 *
 * @module CSMCPTypes
 */

// ============================================================================
// JSON-RPC 2.0 Types
// ============================================================================

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number;
    result?: unknown;
    error?: JsonRpcError;
}

export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

export interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
}

// Standard JSON-RPC error codes
export const JSON_RPC_ERRORS = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
} as const;

// ============================================================================
// MCP Protocol Types
// ============================================================================

export interface MCPServerInfo {
    name: string;
    version: string;
    protocolVersion: string;
}

export interface MCPClientInfo {
    name: string;
    version: string;
}

export interface MCPCapabilities {
    tools?: boolean | MCPToolsCapability;
    resources?: boolean | MCPResourcesCapability;
    prompts?: boolean | MCPPromptsCapability;
    logging?: boolean;
    sampling?: boolean;
    elicitation?: boolean;
    roots?: boolean;
}

export interface MCPToolsCapability {
    listChanged?: boolean;
}

export interface MCPResourcesCapability {
    subscribe?: boolean;
    listChanged?: boolean;
}

export interface MCPPromptsCapability {
    listChanged?: boolean;
}

// ============================================================================
// MCP Tool Types
// ============================================================================

export interface MCPTool {
    name: string;
    description: string;
    inputSchema: MCPToolInputSchema;
    outputSchema?: MCPToolOutputSchema;
    annotations?: MCPToolAnnotations;
}

export interface MCPToolInputSchema {
    type: 'object';
    properties?: Record<string, MCPSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
}

export interface MCPToolOutputSchema {
    type: string;
    properties?: Record<string, MCPSchemaProperty>;
    items?: MCPSchemaProperty;
}

export interface MCPSchemaProperty {
    type: string;
    description?: string;
    enum?: string[];
    default?: unknown;
    format?: string;
    items?: MCPSchemaProperty;
    properties?: Record<string, MCPSchemaProperty>;
    required?: string[];
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
}

export interface MCPToolAnnotations {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

export interface MCPToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface MCPToolResult {
    content: MCPContent[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
}

// ============================================================================
// MCP Content Types
// ============================================================================

export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent | MCPAudioContent;

export interface MCPTextContent {
    type: 'text';
    text: string;
    annotations?: MCPContentAnnotations;
}

export interface MCPImageContent {
    type: 'image';
    data: string; // base64 encoded
    mimeType: string;
    annotations?: MCPContentAnnotations;
}

export interface MCPResourceContent {
    type: 'resource';
    resource: MCPResourceReference;
    annotations?: MCPContentAnnotations;
}

export interface MCPAudioContent {
    type: 'audio';
    data: string; // base64 encoded
    mimeType: string;
    annotations?: MCPContentAnnotations;
}

export interface MCPContentAnnotations {
    audience?: ('user' | 'assistant')[];
    priority?: number;
}

export interface MCPResourceReference {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
}

// ============================================================================
// MCP Resource Types
// ============================================================================

export interface MCPResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    annotations?: MCPResourceAnnotations;
}

export interface MCPResourceAnnotations {
    audience?: ('user' | 'assistant')[];
    priority?: number;
}

export interface MCPResourceTemplate {
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
    annotations?: MCPResourceAnnotations;
}

export interface MCPResourceContents {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
}

// ============================================================================
// MCP Prompt Types
// ============================================================================

export interface MCPPrompt {
    name: string;
    description?: string;
    arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
    name: string;
    description?: string;
    required?: boolean;
}

export interface MCPPromptMessage {
    role: 'user' | 'assistant';
    content: MCPContent;
}

export interface MCPGetPromptResult {
    description?: string;
    messages: MCPPromptMessage[];
}

// ============================================================================
// MCP Sampling Types (Server requesting AI completions)
// ============================================================================

export interface MCPSamplingRequest {
    messages: MCPSamplingMessage[];
    modelPreferences?: MCPModelPreferences;
    systemPrompt?: string;
    includeContext?: 'none' | 'thisServer' | 'allServers';
    temperature?: number;
    maxTokens: number;
    stopSequences?: string[];
    metadata?: Record<string, unknown>;
}

export interface MCPSamplingMessage {
    role: 'user' | 'assistant';
    content: MCPContent;
}

export interface MCPModelPreferences {
    hints?: MCPModelHint[];
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
}

export interface MCPModelHint {
    name?: string;
}

export interface MCPSamplingResult {
    role: 'assistant';
    content: MCPTextContent;
    model: string;
    stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens';
}

// ============================================================================
// MCP Elicitation Types (Requesting user input)
// ============================================================================

export interface MCPElicitationRequest {
    message: string;
    requestedSchema: MCPElicitationSchema;
}

export interface MCPElicitationSchema {
    type: 'object';
    properties: Record<string, MCPSchemaProperty>;
    required?: string[];
}

export interface MCPElicitationResult {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
}

// ============================================================================
// MCP Logging Types
// ============================================================================

export type MCPLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

export interface MCPLogMessage {
    level: MCPLogLevel;
    logger?: string;
    data?: unknown;
}

// ============================================================================
// MCP Notification Types
// ============================================================================

export interface MCPNotification {
    method: string;
    params?: Record<string, unknown>;
}

// Standard MCP notification methods
export const MCP_NOTIFICATIONS = {
    // Server notifications
    TOOLS_LIST_CHANGED: 'notifications/tools/list_changed',
    RESOURCES_LIST_CHANGED: 'notifications/resources/list_changed',
    RESOURCES_UPDATED: 'notifications/resources/updated',
    PROMPTS_LIST_CHANGED: 'notifications/prompts/list_changed',
    PROGRESS: 'notifications/progress',
    LOG_MESSAGE: 'notifications/message',

    // Client notifications
    INITIALIZED: 'notifications/initialized',
    CANCELLED: 'notifications/cancelled',
    ROOTS_LIST_CHANGED: 'notifications/roots/list_changed',
} as const;

// ============================================================================
// MCP Method Types
// ============================================================================

export const MCP_METHODS = {
    // Lifecycle
    INITIALIZE: 'initialize',
    PING: 'ping',

    // Tools
    TOOLS_LIST: 'tools/list',
    TOOLS_CALL: 'tools/call',

    // Resources
    RESOURCES_LIST: 'resources/list',
    RESOURCES_TEMPLATES_LIST: 'resources/templates/list',
    RESOURCES_READ: 'resources/read',
    RESOURCES_SUBSCRIBE: 'resources/subscribe',
    RESOURCES_UNSUBSCRIBE: 'resources/unsubscribe',

    // Prompts
    PROMPTS_LIST: 'prompts/list',
    PROMPTS_GET: 'prompts/get',

    // Sampling
    SAMPLING_CREATE_MESSAGE: 'sampling/createMessage',

    // Elicitation
    ELICITATION_CREATE: 'elicitation/create',

    // Logging
    LOGGING_SET_LEVEL: 'logging/setLevel',

    // Completion
    COMPLETION_COMPLETE: 'completion/complete',
} as const;

// ============================================================================
// Tool Handler Types
// ============================================================================

export type MCPToolHandler = (
    params: Record<string, unknown>,
    context: MCPToolContext
) => Promise<MCPToolResult>;

export interface MCPToolContext {
    server: MCPServerContext;
    sampling?: MCPSamplingClient;
    elicitation?: MCPElicitationClient;
    notify: (notification: MCPNotification) => void;
    log: (level: MCPLogLevel, message: string, data?: unknown) => void;
}

export interface MCPServerContext {
    workingDirectory: string;
    browser?: BrowserContext;
    database?: DatabaseContext;
    scenarioContext?: Map<string, unknown>;
    // Additional context for tools
    networkInterceptor?: unknown; // CSNetworkInterceptor instance
    apiClient?: unknown; // CSAPIClient instance
    browserManager?: unknown; // CSBrowserManager instance
    // Allow additional properties for tool-specific state
    [key: string]: unknown;
}

export interface BrowserContext {
    page: unknown; // Playwright Page
    browser?: unknown; // Playwright Browser
    context?: unknown; // Playwright BrowserContext
    manager?: unknown; // CSBrowserManager instance
}

export interface DatabaseContext {
    connection: unknown;
    type: 'oracle' | 'postgres' | 'mysql' | 'mssql';
}

export interface MCPSamplingClient {
    createMessage(request: MCPSamplingRequest): Promise<MCPSamplingResult>;
}

export interface MCPElicitationClient {
    create(request: MCPElicitationRequest): Promise<MCPElicitationResult>;
}

// ============================================================================
// Resource Handler Types
// ============================================================================

export type MCPResourceHandler = (
    uri: string,
    context: MCPToolContext
) => Promise<MCPResourceContents>;

// ============================================================================
// Prompt Handler Types
// ============================================================================

export type MCPPromptHandler = (
    args: Record<string, string>,
    context: MCPToolContext
) => Promise<MCPGetPromptResult>;

// ============================================================================
// Tool Category Types
// ============================================================================

export type ToolCategory =
    | 'browser'
    | 'bdd'
    | 'database'
    | 'api'
    | 'network'
    | 'analytics'
    | 'security'
    | 'cicd'
    | 'environment'
    | 'generation'
    | 'multiagent'
    | 'exploration'
    | 'testing';

export interface MCPToolDefinition {
    tool: MCPTool;
    handler: MCPToolHandler;
    category: ToolCategory;
}

export interface MCPResourceDefinition {
    resource: MCPResource | MCPResourceTemplate;
    handler: MCPResourceHandler;
}

export interface MCPPromptDefinition {
    prompt: MCPPrompt;
    handler: MCPPromptHandler;
}

// ============================================================================
// Azure DevOps Types
// ============================================================================

export interface AzureDevOpsConfig {
    organization: string;
    project: string;
    personalAccessToken: string;
    baseUrl?: string; // defaults to https://dev.azure.com
}

export interface AzureDevOpsPipeline {
    id: number;
    name: string;
    folder?: string;
    revision?: number;
}

export interface AzureDevOpsBuild {
    id: number;
    buildNumber: string;
    status: 'none' | 'inProgress' | 'completed' | 'cancelling' | 'postponed' | 'notStarted' | 'all';
    result?: 'none' | 'succeeded' | 'partiallySucceeded' | 'failed' | 'canceled';
    queueTime?: string;
    startTime?: string;
    finishTime?: string;
    url?: string;
    sourceBranch?: string;
    sourceVersion?: string;
}

export interface AzureDevOpsTestRun {
    id: number;
    name: string;
    state: 'Unspecified' | 'NotStarted' | 'InProgress' | 'Completed' | 'Waiting' | 'Aborted' | 'NeedsInvestigation';
    totalTests: number;
    passedTests: number;
    failedTests: number;
    incompleteTests?: number;
    notApplicableTests?: number;
    startedDate?: string;
    completedDate?: string;
}

export interface AzureDevOpsTestResult {
    id: number;
    testCaseTitle: string;
    outcome: 'None' | 'Passed' | 'Failed' | 'Inconclusive' | 'Timeout' | 'Aborted' | 'Blocked' | 'NotExecuted' | 'Warning' | 'Error' | 'NotApplicable' | 'Paused' | 'InProgress';
    errorMessage?: string;
    stackTrace?: string;
    durationInMs?: number;
}

export interface AzureDevOpsWorkItem {
    id: number;
    type: string;
    title: string;
    state: string;
    assignedTo?: string;
    description?: string;
    url?: string;
}

export interface AzureDevOpsPullRequest {
    pullRequestId: number;
    title: string;
    status: 'notSet' | 'active' | 'abandoned' | 'completed' | 'all';
    createdBy: string;
    sourceRefName: string;
    targetRefName: string;
    url?: string;
}

// ============================================================================
// Multi-Agent Types
// ============================================================================

export interface MCPAgent {
    id: string;
    name: string;
    status: 'idle' | 'running' | 'paused' | 'stopped' | 'error';
    browserType?: 'chromium' | 'firefox' | 'webkit';
    viewport?: { width: number; height: number };
    currentTask?: string;
}

export interface MCPAgentMessage {
    fromAgent: string;
    toAgent: string;
    type: 'sync' | 'data' | 'command' | 'result';
    payload: unknown;
    timestamp: number;
}

export interface MCPAgentSyncBarrier {
    id: string;
    agents: string[];
    waitingAgents: string[];
    completed: boolean;
}

// ============================================================================
// Analytics Types
// ============================================================================

export interface TestExecutionMetrics {
    totalTests: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    duration: number;
    averageDuration: number;
    passRate: number;
}

export interface TestFlakinessScore {
    testName: string;
    flakinessScore: number; // 0-100
    totalRuns: number;
    inconsistentRuns: number;
    lastFailure?: string;
    suggestedAction?: string;
}

export interface TestTrend {
    date: string;
    passed: number;
    failed: number;
    passRate: number;
    averageDuration: number;
}

// ============================================================================
// Security Testing Types
// ============================================================================

export interface SecurityVulnerability {
    type: 'xss' | 'sql_injection' | 'csrf' | 'auth_bypass' | 'sensitive_data' | 'other';
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    location: string;
    description: string;
    evidence?: string;
    recommendation?: string;
}

export interface AccessibilityViolation {
    id: string;
    impact: 'critical' | 'serious' | 'moderate' | 'minor';
    description: string;
    help: string;
    helpUrl: string;
    nodes: AccessibilityNode[];
}

export interface AccessibilityNode {
    html: string;
    target: string[];
    failureSummary?: string;
}

// All types are exported via their interface/type declarations above
