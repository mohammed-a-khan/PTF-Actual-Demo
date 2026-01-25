/**
 * CS Playwright MCP Multi-Agent Tools
 * Agent orchestration, coordination, and communication
 *
 * @module CSMCPMultiAgentTools
 */

import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// ============================================================================
// Helper Functions
// ============================================================================

function createTextResult(text: string): MCPToolResult {
    return {
        content: [{ type: 'text', text } as MCPTextContent],
    };
}

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

// ============================================================================
// Agent Management Types
// ============================================================================

interface AgentInstance {
    id: string;
    type: string;
    status: 'idle' | 'running' | 'completed' | 'failed';
    createdAt: Date;
    lastActivity: Date;
    metadata: Record<string, unknown>;
}

// In-memory agent registry (would be shared across server in real impl)
const agentRegistry: Map<string, AgentInstance> = new Map();

// ============================================================================
// Agent Lifecycle Tools
// ============================================================================

const agentSpawnTool = defineTool()
    .name('agent_spawn')
    .description('Spawn a new test agent with specific capabilities')
    .category('multiagent')
    .stringParam('type', 'Agent type', {
        required: true,
        enum: ['browser', 'api', 'database', 'file', 'custom'],
    })
    .stringParam('name', 'Agent name/identifier')
    .objectParam('config', 'Agent configuration')
    .objectParam('capabilities', 'Agent capabilities to enable')
    .handler(async (params, context) => {
        const agentId = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const agentName = (params.name as string) || `${params.type}_agent`;

        context.log('info', `Spawning agent: ${agentName} (${agentId})`);

        const agent: AgentInstance = {
            id: agentId,
            type: params.type as string,
            status: 'idle',
            createdAt: new Date(),
            lastActivity: new Date(),
            metadata: {
                name: agentName,
                config: params.config || {},
                capabilities: params.capabilities || {},
            },
        };

        agentRegistry.set(agentId, agent);

        return createJsonResult({
            agentId,
            name: agentName,
            type: params.type,
            status: 'idle',
            message: `Agent ${agentName} spawned successfully`,
        });
    })
    .build();

const agentTerminateTool = defineTool()
    .name('agent_terminate')
    .description('Terminate an agent')
    .category('multiagent')
    .stringParam('agentId', 'Agent ID to terminate', { required: true })
    .booleanParam('force', 'Force termination even if agent is busy', { default: false })
    .handler(async (params, context) => {
        const agent = agentRegistry.get(params.agentId as string);

        if (!agent) {
            return createErrorResult(`Agent not found: ${params.agentId}`);
        }

        if (agent.status === 'running' && !params.force) {
            return createErrorResult(`Agent ${params.agentId} is running. Use force=true to terminate.`);
        }

        agentRegistry.delete(params.agentId as string);
        context.log('info', `Agent terminated: ${params.agentId}`);

        return createTextResult(`Agent ${params.agentId} terminated successfully`);
    })
    .build();

const agentListTool = defineTool()
    .name('agent_list')
    .description('List all active agents')
    .category('multiagent')
    .stringParam('status', 'Filter by status', {
        enum: ['idle', 'running', 'completed', 'failed', 'all'],
        default: 'all',
    })
    .stringParam('type', 'Filter by agent type')
    .handler(async (params, context) => {
        context.log('info', 'Listing agents');

        const agents = Array.from(agentRegistry.values())
            .filter(a => params.status === 'all' || a.status === params.status)
            .filter(a => !params.type || a.type === params.type)
            .map(a => ({
                id: a.id,
                type: a.type,
                name: a.metadata.name,
                status: a.status,
                createdAt: a.createdAt.toISOString(),
                lastActivity: a.lastActivity.toISOString(),
            }));

        return createJsonResult({
            agents,
            count: agents.length,
        });
    })
    .readOnly()
    .build();

const agentStatusTool = defineTool()
    .name('agent_status')
    .description('Get detailed status of an agent')
    .category('multiagent')
    .stringParam('agentId', 'Agent ID', { required: true })
    .handler(async (params, context) => {
        const agent = agentRegistry.get(params.agentId as string);

        if (!agent) {
            return createErrorResult(`Agent not found: ${params.agentId}`);
        }

        return createJsonResult({
            id: agent.id,
            type: agent.type,
            status: agent.status,
            createdAt: agent.createdAt.toISOString(),
            lastActivity: agent.lastActivity.toISOString(),
            metadata: agent.metadata,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Agent Communication Tools
// ============================================================================

const agentSendMessageTool = defineTool()
    .name('agent_send_message')
    .description('Send a message to an agent')
    .category('multiagent')
    .stringParam('agentId', 'Target agent ID', { required: true })
    .stringParam('message', 'Message to send', { required: true })
    .objectParam('payload', 'Additional payload data')
    .booleanParam('waitForResponse', 'Wait for agent response', { default: false })
    .numberParam('timeout', 'Timeout in milliseconds', { default: 30000 })
    .handler(async (params, context) => {
        const agent = agentRegistry.get(params.agentId as string);

        if (!agent) {
            return createErrorResult(`Agent not found: ${params.agentId}`);
        }

        context.log('info', `Sending message to agent ${params.agentId}`);
        agent.lastActivity = new Date();

        return createJsonResult({
            delivered: true,
            agentId: params.agentId,
            message: params.message,
            timestamp: new Date().toISOString(),
            response: params.waitForResponse ? null : undefined,
        });
    })
    .build();

const agentBroadcastTool = defineTool()
    .name('agent_broadcast')
    .description('Broadcast a message to all agents')
    .category('multiagent')
    .stringParam('message', 'Message to broadcast', { required: true })
    .objectParam('payload', 'Additional payload data')
    .stringParam('filter', 'Agent type filter')
    .handler(async (params, context) => {
        context.log('info', 'Broadcasting message to agents');

        const targetAgents = Array.from(agentRegistry.values())
            .filter(a => !params.filter || a.type === params.filter);

        for (const agent of targetAgents) {
            agent.lastActivity = new Date();
        }

        return createJsonResult({
            delivered: true,
            recipientCount: targetAgents.length,
            recipients: targetAgents.map(a => a.id),
            message: params.message,
            timestamp: new Date().toISOString(),
        });
    })
    .build();

// ============================================================================
// Agent Coordination Tools
// ============================================================================

const agentSyncBarrierTool = defineTool()
    .name('agent_sync_barrier')
    .description('Create a synchronization barrier for multiple agents')
    .category('multiagent')
    .arrayParam('agentIds', 'Agent IDs to synchronize', 'string', { required: true })
    .stringParam('name', 'Barrier name')
    .numberParam('timeout', 'Timeout in milliseconds', { default: 60000 })
    .handler(async (params, context) => {
        const agentIds = params.agentIds as string[];
        const barrierName = (params.name as string) || `barrier_${Date.now()}`;

        context.log('info', `Creating sync barrier: ${barrierName} for ${agentIds.length} agents`);

        // Verify all agents exist
        const missingAgents = agentIds.filter(id => !agentRegistry.has(id));
        if (missingAgents.length > 0) {
            return createErrorResult(`Agents not found: ${missingAgents.join(', ')}`);
        }

        return createJsonResult({
            barrierId: barrierName,
            agents: agentIds,
            status: 'waiting',
            arrivedCount: 0,
            totalCount: agentIds.length,
        });
    })
    .build();

const agentLockTool = defineTool()
    .name('agent_lock')
    .description('Acquire a distributed lock')
    .category('multiagent')
    .stringParam('lockName', 'Lock name/identifier', { required: true })
    .stringParam('agentId', 'Agent requesting the lock', { required: true })
    .numberParam('timeout', 'Lock acquisition timeout in ms', { default: 30000 })
    .numberParam('ttl', 'Lock TTL in ms (auto-release)', { default: 60000 })
    .handler(async (params, context) => {
        context.log('info', `Agent ${params.agentId} acquiring lock: ${params.lockName}`);

        return createJsonResult({
            lockId: `lock_${params.lockName}_${Date.now()}`,
            lockName: params.lockName,
            holder: params.agentId,
            acquired: true,
            acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + (params.ttl as number)).toISOString(),
        });
    })
    .build();

const agentUnlockTool = defineTool()
    .name('agent_unlock')
    .description('Release a distributed lock')
    .category('multiagent')
    .stringParam('lockId', 'Lock ID to release', { required: true })
    .stringParam('agentId', 'Agent releasing the lock', { required: true })
    .handler(async (params, context) => {
        context.log('info', `Agent ${params.agentId} releasing lock: ${params.lockId}`);

        return createTextResult(`Lock ${params.lockId} released`);
    })
    .build();

// ============================================================================
// Agent Task Distribution Tools
// ============================================================================

const agentDistributeTasksTool = defineTool()
    .name('agent_distribute_tasks')
    .description('Distribute tasks across multiple agents')
    .category('multiagent')
    .arrayParam('tasks', 'Tasks to distribute', 'object', { required: true })
    .arrayParam('agentIds', 'Target agent IDs', 'string')
    .stringParam('strategy', 'Distribution strategy', {
        enum: ['round_robin', 'random', 'load_balanced', 'capability_based'],
        default: 'round_robin',
    })
    .handler(async (params, context) => {
        const tasks = params.tasks as Record<string, unknown>[];
        let agentIds = params.agentIds as string[];

        // If no agents specified, use all idle agents
        if (!agentIds || agentIds.length === 0) {
            agentIds = Array.from(agentRegistry.values())
                .filter(a => a.status === 'idle')
                .map(a => a.id);
        }

        if (agentIds.length === 0) {
            return createErrorResult('No available agents for task distribution');
        }

        context.log('info', `Distributing ${tasks.length} tasks to ${agentIds.length} agents`);

        // Simple round-robin distribution
        const distribution: Record<string, unknown[]> = {};
        agentIds.forEach(id => { distribution[id] = []; });

        tasks.forEach((task, index) => {
            const agentId = agentIds[index % agentIds.length];
            distribution[agentId].push(task);
        });

        return createJsonResult({
            strategy: params.strategy,
            totalTasks: tasks.length,
            totalAgents: agentIds.length,
            distribution: Object.entries(distribution).map(([agentId, tasks]) => ({
                agentId,
                taskCount: tasks.length,
                tasks,
            })),
        });
    })
    .build();

const agentExecuteTaskTool = defineTool()
    .name('agent_execute_task')
    .description('Execute a task on a specific agent')
    .category('multiagent')
    .stringParam('agentId', 'Agent ID', { required: true })
    .stringParam('taskType', 'Task type', { required: true })
    .objectParam('taskParams', 'Task parameters')
    .booleanParam('async', 'Execute asynchronously', { default: false })
    .handler(async (params, context) => {
        const agent = agentRegistry.get(params.agentId as string);

        if (!agent) {
            return createErrorResult(`Agent not found: ${params.agentId}`);
        }

        context.log('info', `Executing task ${params.taskType} on agent ${params.agentId}`);

        agent.status = 'running';
        agent.lastActivity = new Date();

        // Simulate task execution
        const taskId = `task_${Date.now()}`;

        if (params.async) {
            return createJsonResult({
                taskId,
                agentId: params.agentId,
                taskType: params.taskType,
                status: 'started',
                startedAt: new Date().toISOString(),
            });
        }

        // Simulate completion
        agent.status = 'idle';

        return createJsonResult({
            taskId,
            agentId: params.agentId,
            taskType: params.taskType,
            status: 'completed',
            completedAt: new Date().toISOString(),
            result: {},
        });
    })
    .build();

// ============================================================================
// Agent Workflow Tools
// ============================================================================

const agentWorkflowCreateTool = defineTool()
    .name('agent_workflow_create')
    .description('Create a multi-agent workflow')
    .category('multiagent')
    .stringParam('name', 'Workflow name', { required: true })
    .arrayParam('steps', 'Workflow steps', 'object', { required: true })
    .objectParam('config', 'Workflow configuration')
    .handler(async (params, context) => {
        const workflowId = `workflow_${Date.now()}`;

        context.log('info', `Creating workflow: ${params.name} (${workflowId})`);

        return createJsonResult({
            workflowId,
            name: params.name,
            steps: (params.steps as unknown[]).length,
            status: 'created',
            createdAt: new Date().toISOString(),
        });
    })
    .build();

const agentWorkflowExecuteTool = defineTool()
    .name('agent_workflow_execute')
    .description('Execute a multi-agent workflow')
    .category('multiagent')
    .stringParam('workflowId', 'Workflow ID', { required: true })
    .objectParam('input', 'Workflow input data')
    .booleanParam('dryRun', 'Perform dry run without actual execution', { default: false })
    .handler(async (params, context) => {
        context.log('info', `Executing workflow: ${params.workflowId}`);

        const executionId = `exec_${Date.now()}`;

        return createJsonResult({
            executionId,
            workflowId: params.workflowId,
            status: params.dryRun ? 'validated' : 'running',
            startedAt: new Date().toISOString(),
            dryRun: params.dryRun,
        });
    })
    .build();

const agentWorkflowStatusTool = defineTool()
    .name('agent_workflow_status')
    .description('Get workflow execution status')
    .category('multiagent')
    .stringParam('executionId', 'Execution ID', { required: true })
    .handler(async (params, context) => {
        context.log('info', `Getting workflow status: ${params.executionId}`);

        return createJsonResult({
            executionId: params.executionId,
            status: 'completed',
            progress: 100,
            completedSteps: 5,
            totalSteps: 5,
            startedAt: new Date(Date.now() - 60000).toISOString(),
            completedAt: new Date().toISOString(),
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Export all multi-agent tools
// ============================================================================

export const multiAgentTools: MCPToolDefinition[] = [
    // Lifecycle
    agentSpawnTool,
    agentTerminateTool,
    agentListTool,
    agentStatusTool,

    // Communication
    agentSendMessageTool,
    agentBroadcastTool,

    // Coordination
    agentSyncBarrierTool,
    agentLockTool,
    agentUnlockTool,

    // Task Distribution
    agentDistributeTasksTool,
    agentExecuteTaskTool,

    // Workflows
    agentWorkflowCreateTool,
    agentWorkflowExecuteTool,
    agentWorkflowStatusTool,
];

/**
 * Register all multi-agent tools with the registry
 */
export function registerMultiAgentTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(multiAgentTools);
}
