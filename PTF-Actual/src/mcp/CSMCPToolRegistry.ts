/**
 * PTF-ADO MCP Tool Registry
 * Manages registration and execution of MCP tools
 *
 * @module CSMCPToolRegistry
 */

import {
    MCPTool,
    MCPToolHandler,
    MCPToolResult,
    MCPToolContext,
    MCPToolDefinition,
    MCPTextContent,
    ToolCategory,
    MCPSchemaProperty,
    MCPToolInputSchema,
} from './types/CSMCPTypes';

// ============================================================================
// Tool Registry Class
// ============================================================================

export class CSMCPToolRegistry {
    private tools: Map<string, MCPToolDefinition> = new Map();
    private toolsByCategory: Map<ToolCategory, string[]> = new Map();

    constructor() {
        // Initialize category maps
        const categories: ToolCategory[] = [
            'browser', 'bdd', 'database', 'api', 'network',
            'analytics', 'security', 'cicd', 'environment',
            'generation', 'multiagent', 'exploration', 'testing'
        ];
        for (const category of categories) {
            this.toolsByCategory.set(category, []);
        }
    }

    // ========================================================================
    // Tool Registration
    // ========================================================================

    /**
     * Register a single tool
     */
    public registerTool(definition: MCPToolDefinition): void {
        const { tool, handler, category } = definition;

        if (this.tools.has(tool.name)) {
            throw new Error(`Tool already registered: ${tool.name}`);
        }

        this.tools.set(tool.name, definition);
        this.toolsByCategory.get(category)?.push(tool.name);
    }

    /**
     * Register multiple tools at once
     */
    public registerTools(definitions: MCPToolDefinition[]): void {
        for (const definition of definitions) {
            this.registerTool(definition);
        }
    }

    /**
     * Unregister a tool
     */
    public unregisterTool(name: string): boolean {
        const definition = this.tools.get(name);
        if (!definition) {
            return false;
        }

        this.tools.delete(name);

        // Remove from category list
        const categoryTools = this.toolsByCategory.get(definition.category);
        if (categoryTools) {
            const index = categoryTools.indexOf(name);
            if (index !== -1) {
                categoryTools.splice(index, 1);
            }
        }

        return true;
    }

    // ========================================================================
    // Tool Queries
    // ========================================================================

    /**
     * Get all registered tools
     */
    public getAllTools(): MCPTool[] {
        return Array.from(this.tools.values()).map(d => d.tool);
    }

    /**
     * Get tools by category
     */
    public getToolsByCategory(category: ToolCategory): MCPTool[] {
        const toolNames = this.toolsByCategory.get(category) || [];
        return toolNames
            .map(name => this.tools.get(name)?.tool)
            .filter((tool): tool is MCPTool => tool !== undefined);
    }

    /**
     * Get a specific tool definition
     */
    public getTool(name: string): MCPToolDefinition | undefined {
        return this.tools.get(name);
    }

    /**
     * Check if a tool exists
     */
    public hasTool(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * Get tool count
     */
    public getToolCount(): number {
        return this.tools.size;
    }

    /**
     * Get tool counts by category
     */
    public getToolCountsByCategory(): Record<ToolCategory, number> {
        const counts: Partial<Record<ToolCategory, number>> = {};
        for (const [category, tools] of this.toolsByCategory) {
            counts[category] = tools.length;
        }
        return counts as Record<ToolCategory, number>;
    }

    // ========================================================================
    // Tool Execution
    // ========================================================================

    /**
     * Execute a tool by name
     */
    public async executeTool(
        name: string,
        params: Record<string, unknown>,
        context: MCPToolContext
    ): Promise<MCPToolResult> {
        const definition = this.tools.get(name);

        if (!definition) {
            return this.createErrorResult(`Tool not found: ${name}`);
        }

        try {
            // Validate parameters against schema
            const validationError = this.validateParams(params, definition.tool.inputSchema);
            if (validationError) {
                return this.createErrorResult(`Invalid parameters: ${validationError}`);
            }

            // Execute the handler
            const result = await definition.handler(params, context);
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;

            context.log('error', `Tool execution failed: ${name}`, { error: errorMessage, stack: errorStack });

            return this.createErrorResult(errorMessage);
        }
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Create a success result with text content
     */
    public static createTextResult(text: string): MCPToolResult {
        return {
            content: [{
                type: 'text',
                text,
            } as MCPTextContent],
        };
    }

    /**
     * Create a success result with JSON content
     */
    public static createJsonResult(data: unknown): MCPToolResult {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify(data, null, 2),
            } as MCPTextContent],
            structuredContent: data as Record<string, unknown>,
        };
    }

    /**
     * Create an error result
     */
    public createErrorResult(message: string): MCPToolResult {
        return {
            content: [{
                type: 'text',
                text: `Error: ${message}`,
            } as MCPTextContent],
            isError: true,
        };
    }

    /**
     * Validate parameters against schema
     */
    private validateParams(params: Record<string, unknown>, schema: MCPToolInputSchema): string | null {
        // Check required fields
        if (schema.required) {
            for (const field of schema.required) {
                if (params[field] === undefined) {
                    return `Missing required parameter: ${field}`;
                }
            }
        }

        // Check property types
        if (schema.properties) {
            for (const [key, value] of Object.entries(params)) {
                const propSchema = schema.properties[key];

                if (!propSchema) {
                    if (schema.additionalProperties === false) {
                        return `Unknown parameter: ${key}`;
                    }
                    continue;
                }

                const typeError = this.validateType(value, propSchema, key);
                if (typeError) {
                    return typeError;
                }
            }
        }

        return null;
    }

    /**
     * Validate a value against a schema property
     */
    private validateType(value: unknown, schema: MCPSchemaProperty, path: string): string | null {
        // Handle null/undefined
        if (value === null || value === undefined) {
            return null; // Allow null/undefined for optional fields
        }

        // Check type
        switch (schema.type) {
            case 'string':
                if (typeof value !== 'string') {
                    return `${path} must be a string`;
                }
                if (schema.enum && !schema.enum.includes(value)) {
                    return `${path} must be one of: ${schema.enum.join(', ')}`;
                }
                if (schema.minLength !== undefined && value.length < schema.minLength) {
                    return `${path} must be at least ${schema.minLength} characters`;
                }
                if (schema.maxLength !== undefined && value.length > schema.maxLength) {
                    return `${path} must be at most ${schema.maxLength} characters`;
                }
                if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
                    return `${path} must match pattern: ${schema.pattern}`;
                }
                break;

            case 'number':
            case 'integer':
                if (typeof value !== 'number') {
                    return `${path} must be a number`;
                }
                if (schema.type === 'integer' && !Number.isInteger(value)) {
                    return `${path} must be an integer`;
                }
                if (schema.minimum !== undefined && value < schema.minimum) {
                    return `${path} must be at least ${schema.minimum}`;
                }
                if (schema.maximum !== undefined && value > schema.maximum) {
                    return `${path} must be at most ${schema.maximum}`;
                }
                break;

            case 'boolean':
                if (typeof value !== 'boolean') {
                    return `${path} must be a boolean`;
                }
                break;

            case 'array':
                if (!Array.isArray(value)) {
                    return `${path} must be an array`;
                }
                if (schema.items) {
                    for (let i = 0; i < value.length; i++) {
                        const itemError = this.validateType(value[i], schema.items, `${path}[${i}]`);
                        if (itemError) {
                            return itemError;
                        }
                    }
                }
                break;

            case 'object':
                if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                    return `${path} must be an object`;
                }
                if (schema.properties) {
                    for (const [key, propValue] of Object.entries(value)) {
                        const propSchema = schema.properties[key];
                        if (propSchema) {
                            const propError = this.validateType(propValue, propSchema, `${path}.${key}`);
                            if (propError) {
                                return propError;
                            }
                        }
                    }
                }
                if (schema.required) {
                    for (const reqKey of schema.required) {
                        if ((value as Record<string, unknown>)[reqKey] === undefined) {
                            return `${path}.${reqKey} is required`;
                        }
                    }
                }
                break;
        }

        return null;
    }
}

// ============================================================================
// Tool Builder Helper
// ============================================================================

export class MCPToolBuilder {
    private tool: Partial<MCPTool> = {};
    private handlerFn: MCPToolHandler | null = null;
    private toolCategory: ToolCategory = 'browser';

    /**
     * Set tool name
     */
    public name(name: string): MCPToolBuilder {
        this.tool.name = name;
        return this;
    }

    /**
     * Set tool description
     */
    public description(description: string): MCPToolBuilder {
        this.tool.description = description;
        return this;
    }

    /**
     * Set tool category
     */
    public category(category: ToolCategory): MCPToolBuilder {
        this.toolCategory = category;
        return this;
    }

    /**
     * Set input schema
     */
    public input(schema: MCPToolInputSchema): MCPToolBuilder {
        this.tool.inputSchema = schema;
        return this;
    }

    /**
     * Add a string parameter
     */
    public stringParam(name: string, description: string, options?: {
        required?: boolean;
        enum?: string[];
        default?: string;
        pattern?: string;
    }): MCPToolBuilder {
        this.ensureInputSchema();
        this.tool.inputSchema!.properties![name] = {
            type: 'string',
            description,
            enum: options?.enum,
            default: options?.default,
            pattern: options?.pattern,
        };
        if (options?.required) {
            this.tool.inputSchema!.required = this.tool.inputSchema!.required || [];
            this.tool.inputSchema!.required.push(name);
        }
        return this;
    }

    /**
     * Add a number parameter
     */
    public numberParam(name: string, description: string, options?: {
        required?: boolean;
        minimum?: number;
        maximum?: number;
        default?: number;
        integer?: boolean;
    }): MCPToolBuilder {
        this.ensureInputSchema();
        this.tool.inputSchema!.properties![name] = {
            type: options?.integer ? 'integer' : 'number',
            description,
            minimum: options?.minimum,
            maximum: options?.maximum,
            default: options?.default,
        };
        if (options?.required) {
            this.tool.inputSchema!.required = this.tool.inputSchema!.required || [];
            this.tool.inputSchema!.required.push(name);
        }
        return this;
    }

    /**
     * Add a boolean parameter
     */
    public booleanParam(name: string, description: string, options?: {
        required?: boolean;
        default?: boolean;
    }): MCPToolBuilder {
        this.ensureInputSchema();
        this.tool.inputSchema!.properties![name] = {
            type: 'boolean',
            description,
            default: options?.default,
        };
        if (options?.required) {
            this.tool.inputSchema!.required = this.tool.inputSchema!.required || [];
            this.tool.inputSchema!.required.push(name);
        }
        return this;
    }

    /**
     * Add an array parameter
     */
    public arrayParam(name: string, description: string, itemType: string, options?: {
        required?: boolean;
    }): MCPToolBuilder {
        this.ensureInputSchema();
        this.tool.inputSchema!.properties![name] = {
            type: 'array',
            description,
            items: { type: itemType },
        };
        if (options?.required) {
            this.tool.inputSchema!.required = this.tool.inputSchema!.required || [];
            this.tool.inputSchema!.required.push(name);
        }
        return this;
    }

    /**
     * Add an object parameter
     */
    public objectParam(name: string, description: string, properties?: Record<string, MCPSchemaProperty>, options?: {
        required?: boolean;
        requiredProps?: string[];
    }): MCPToolBuilder {
        this.ensureInputSchema();
        this.tool.inputSchema!.properties![name] = {
            type: 'object',
            description,
            properties,
            required: options?.requiredProps,
        };
        if (options?.required) {
            this.tool.inputSchema!.required = this.tool.inputSchema!.required || [];
            this.tool.inputSchema!.required.push(name);
        }
        return this;
    }

    /**
     * Mark tool as read-only (no side effects)
     */
    public readOnly(): MCPToolBuilder {
        this.tool.annotations = this.tool.annotations || {};
        this.tool.annotations.readOnlyHint = true;
        return this;
    }

    /**
     * Mark tool as destructive (may have irreversible effects)
     */
    public destructive(): MCPToolBuilder {
        this.tool.annotations = this.tool.annotations || {};
        this.tool.annotations.destructiveHint = true;
        return this;
    }

    /**
     * Mark tool as idempotent (same result if called multiple times)
     */
    public idempotent(): MCPToolBuilder {
        this.tool.annotations = this.tool.annotations || {};
        this.tool.annotations.idempotentHint = true;
        return this;
    }

    /**
     * Set the handler function
     */
    public handler(fn: MCPToolHandler): MCPToolBuilder {
        this.handlerFn = fn;
        return this;
    }

    /**
     * Build the tool definition
     */
    public build(): MCPToolDefinition {
        if (!this.tool.name) {
            throw new Error('Tool name is required');
        }
        if (!this.tool.description) {
            throw new Error('Tool description is required');
        }
        if (!this.handlerFn) {
            throw new Error('Tool handler is required');
        }

        this.ensureInputSchema();

        return {
            tool: this.tool as MCPTool,
            handler: this.handlerFn,
            category: this.toolCategory,
        };
    }

    private ensureInputSchema(): void {
        if (!this.tool.inputSchema) {
            this.tool.inputSchema = {
                type: 'object',
                properties: {},
            };
        }
        if (!this.tool.inputSchema.properties) {
            this.tool.inputSchema.properties = {};
        }
    }
}

/**
 * Create a new tool builder
 */
export function defineTool(): MCPToolBuilder {
    return new MCPToolBuilder();
}

// ============================================================================
// Export singleton instance
// ============================================================================

export const toolRegistry = new CSMCPToolRegistry();
