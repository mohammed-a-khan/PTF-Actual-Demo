/**
 * CS Playwright MCP Environment Tools
 * Environment configuration, mock servers, feature flags, and time manipulation
 * Real implementation using CSConfigurationManager
 *
 * @module CSMCPEnvironmentTools
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// Lazy load framework components
let CSConfigurationManager: any = null;
let CSReporter: any = null;
let CSValueResolver: any = null;

function ensureFrameworkLoaded(): void {
    if (!CSConfigurationManager) {
        CSConfigurationManager = require('../../../core/CSConfigurationManager').CSConfigurationManager;
    }
    if (!CSReporter) {
        CSReporter = require('../../../reporter/CSReporter').CSReporter;
    }
    if (!CSValueResolver) {
        try {
            CSValueResolver = require('../../../utils/CSValueResolver').CSValueResolver;
        } catch {
            // Optional module
        }
    }
}

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

/**
 * Get the configuration manager instance
 */
function getConfigManager(): any {
    ensureFrameworkLoaded();
    return CSConfigurationManager.getInstance();
}

// ============================================================================
// Environment Variable Tools
// ============================================================================

const envGetTool = defineTool()
    .name('env_get')
    .description('Get environment variable value from process.env or CSConfigurationManager')
    .category('environment')
    .stringParam('name', 'Variable name', { required: true })
    .stringParam('default', 'Default value if not set')
    .booleanParam('useConfig', 'Also check CSConfigurationManager', { default: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const name = params.name as string;
        const defaultValue = params.default as string | undefined;
        const useConfig = params.useConfig !== false;

        context.log('info', `Getting env var: ${name}`);

        let value: string | undefined;
        let source = 'not_found';

        // First check process.env
        if (process.env[name] !== undefined) {
            value = process.env[name];
            source = 'process.env';
        }

        // Then check CSConfigurationManager if enabled
        if (value === undefined && useConfig) {
            try {
                const config = getConfigManager();
                const configValue = config.get(name);
                if (configValue !== undefined && configValue !== null) {
                    value = String(configValue);
                    source = 'CSConfigurationManager';
                }
            } catch (e) {
                // Config manager not initialized
            }
        }

        // Use default if still undefined
        if (value === undefined && defaultValue !== undefined) {
            value = defaultValue;
            source = 'default';
        }

        return createJsonResult({
            name,
            value: value ?? null,
            exists: value !== undefined,
            source,
        });
    })
    .readOnly()
    .build();

const envSetTool = defineTool()
    .name('env_set')
    .description('Set environment variable in process.env and optionally in CSConfigurationManager')
    .category('environment')
    .stringParam('name', 'Variable name', { required: true })
    .stringParam('value', 'Variable value', { required: true })
    .booleanParam('updateConfig', 'Also update CSConfigurationManager', { default: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const name = params.name as string;
        const value = params.value as string;
        const updateConfig = params.updateConfig !== false;

        const previousValue = process.env[name];
        process.env[name] = value;

        context.log('info', `Setting env var: ${name}`);
        CSReporter.info(`[MCP] Setting environment variable: ${name}`);

        // Also update CSConfigurationManager if requested
        if (updateConfig) {
            try {
                const config = getConfigManager();
                config.set(name, value);
            } catch (e) {
                // Config manager not initialized
            }
        }

        CSReporter.pass(`[MCP] Environment variable set: ${name}`);

        return createJsonResult({
            name,
            value,
            previousValue,
            updatedConfig: updateConfig,
        });
    })
    .build();

const envListTool = defineTool()
    .name('env_list')
    .description('List environment variables from process.env and CSConfigurationManager')
    .category('environment')
    .stringParam('pattern', 'Filter pattern (glob or regex)')
    .booleanParam('includeValues', 'Include values in output', { default: false })
    .stringParam('source', 'Source to list from', {
        enum: ['all', 'process.env', 'config'],
        default: 'all',
    })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Listing environment variables');

        const pattern = params.pattern ? new RegExp((params.pattern as string).replace(/\*/g, '.*')) : null;
        const includeValues = params.includeValues === true;
        const source = (params.source as string) || 'all';

        const results: Array<{ name: string; value?: string; source: string }> = [];

        // Get from process.env
        if (source === 'all' || source === 'process.env') {
            Object.keys(process.env)
                .filter(key => !pattern || pattern.test(key))
                .forEach(key => {
                    results.push({
                        name: key,
                        value: includeValues ? process.env[key] : undefined,
                        source: 'process.env',
                    });
                });
        }

        // Get from CSConfigurationManager
        if (source === 'all' || source === 'config') {
            try {
                const config = getConfigManager();
                const allConfig = config.getAll();
                if (allConfig && typeof allConfig === 'object') {
                    Object.keys(allConfig)
                        .filter(key => !pattern || pattern.test(key))
                        .filter(key => !results.find(r => r.name === key)) // Avoid duplicates
                        .forEach(key => {
                            results.push({
                                name: key,
                                value: includeValues ? String(allConfig[key]) : undefined,
                                source: 'CSConfigurationManager',
                            });
                        });
                }
            } catch (e) {
                // Config manager not available
            }
        }

        // Sort by name
        results.sort((a, b) => a.name.localeCompare(b.name));

        return createJsonResult({
            count: results.length,
            pattern: params.pattern || '*',
            variables: results,
        });
    })
    .readOnly()
    .build();

const envDeleteTool = defineTool()
    .name('env_delete')
    .description('Delete environment variable from process.env')
    .category('environment')
    .stringParam('name', 'Variable name', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const name = params.name as string;
        const existed = process.env[name] !== undefined;
        delete process.env[name];

        context.log('info', `Deleting env var: ${name}`);
        CSReporter.info(`[MCP] Deleting environment variable: ${name}`);

        return createTextResult(
            existed
                ? `Environment variable ${name} deleted`
                : `Environment variable ${name} did not exist`
        );
    })
    .build();

// ============================================================================
// Framework Configuration Tools
// ============================================================================

const configGetTool = defineTool()
    .name('config_get')
    .description('Get framework configuration value from CSConfigurationManager')
    .category('environment')
    .stringParam('key', 'Configuration key', { required: true })
    .stringParam('default', 'Default value if not set')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const key = params.key as string;
        const defaultValue = params.default;

        context.log('info', `Getting config: ${key}`);

        try {
            const config = getConfigManager();
            let value = config.get(key);

            if (value === undefined || value === null) {
                value = defaultValue;
            }

            return createJsonResult({
                key,
                value,
                exists: value !== undefined && value !== null,
            });
        } catch (error: any) {
            return createErrorResult(`Failed to get config: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const configGetBooleanTool = defineTool()
    .name('config_get_boolean')
    .description('Get boolean configuration value from CSConfigurationManager')
    .category('environment')
    .stringParam('key', 'Configuration key', { required: true })
    .booleanParam('default', 'Default value if not set', { default: false })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const key = params.key as string;
        const defaultValue = params.default === true;

        try {
            const config = getConfigManager();
            const value = config.getBoolean(key, defaultValue);

            return createJsonResult({
                key,
                value,
                type: 'boolean',
            });
        } catch (error: any) {
            return createErrorResult(`Failed to get boolean config: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const configGetNumberTool = defineTool()
    .name('config_get_number')
    .description('Get number configuration value from CSConfigurationManager')
    .category('environment')
    .stringParam('key', 'Configuration key', { required: true })
    .numberParam('default', 'Default value if not set', { default: 0 })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const key = params.key as string;
        const defaultValue = (params.default as number) || 0;

        try {
            const config = getConfigManager();
            const value = config.getNumber(key, defaultValue);

            return createJsonResult({
                key,
                value,
                type: 'number',
            });
        } catch (error: any) {
            return createErrorResult(`Failed to get number config: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const configListKeysTool = defineTool()
    .name('config_list_keys')
    .description('List all configuration keys from CSConfigurationManager')
    .category('environment')
    .stringParam('pattern', 'Filter pattern (glob or regex)')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Listing configuration keys');

        try {
            const config = getConfigManager();
            const allConfig = config.getAll() || {};
            const pattern = params.pattern ? new RegExp((params.pattern as string).replace(/\*/g, '.*')) : null;

            const keys = Object.keys(allConfig)
                .filter(key => !pattern || pattern.test(key))
                .sort();

            return createJsonResult({
                count: keys.length,
                pattern: params.pattern || '*',
                keys,
            });
        } catch (error: any) {
            return createErrorResult(`Failed to list config keys: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const configGetProjectTool = defineTool()
    .name('config_get_project')
    .description('Get current project and environment information')
    .category('environment')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        try {
            const config = getConfigManager();

            return createJsonResult({
                project: config.get('PROJECT') || 'unknown',
                environment: config.get('ENVIRONMENT') || 'unknown',
                baseUrl: config.get('BASE_URL'),
                browserType: config.get('BROWSER_TYPE') || 'chrome',
                headless: config.getBoolean('HEADLESS', false),
                logLevel: config.get('LOG_LEVEL') || 'INFO',
                parallelWorkers: config.getNumber('PARALLEL_WORKERS', 3),
            });
        } catch (error: any) {
            return createErrorResult(`Failed to get project info: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Feature Flag Tools
// ============================================================================

// In-memory feature flag store
const featureFlags: Map<string, { enabled: boolean; config: Record<string, unknown> }> = new Map();

const featureFlagSetTool = defineTool()
    .name('feature_flag_set')
    .description('Set a feature flag')
    .category('environment')
    .stringParam('name', 'Flag name', { required: true })
    .booleanParam('enabled', 'Flag enabled state', { required: true })
    .objectParam('config', 'Additional flag configuration')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const name = params.name as string;
        const enabled = params.enabled as boolean;

        context.log('info', `Setting feature flag: ${name} = ${enabled}`);
        CSReporter.info(`[MCP] Setting feature flag: ${name} = ${enabled}`);

        featureFlags.set(name, {
            enabled,
            config: (params.config as Record<string, unknown>) || {},
        });

        CSReporter.pass(`[MCP] Feature flag set: ${name}`);

        return createJsonResult({
            name,
            enabled,
            config: params.config || {},
        });
    })
    .build();

const featureFlagGetTool = defineTool()
    .name('feature_flag_get')
    .description('Get a feature flag value')
    .category('environment')
    .stringParam('name', 'Flag name', { required: true })
    .handler(async (params, context) => {
        const name = params.name as string;
        const flag = featureFlags.get(name);

        if (!flag) {
            return createJsonResult({
                name,
                exists: false,
                enabled: false,
            });
        }

        return createJsonResult({
            name,
            exists: true,
            enabled: flag.enabled,
            config: flag.config,
        });
    })
    .readOnly()
    .build();

const featureFlagListTool = defineTool()
    .name('feature_flag_list')
    .description('List all feature flags')
    .category('environment')
    .handler(async (params, context) => {
        context.log('info', 'Listing feature flags');

        const flags = Array.from(featureFlags.entries()).map(([name, flag]) => ({
            name,
            enabled: flag.enabled,
            config: flag.config,
        }));

        return createJsonResult({
            count: flags.length,
            flags,
        });
    })
    .readOnly()
    .build();

const featureFlagClearTool = defineTool()
    .name('feature_flag_clear')
    .description('Clear all feature flags')
    .category('environment')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const count = featureFlags.size;
        featureFlags.clear();

        context.log('info', `Cleared ${count} feature flags`);
        CSReporter.info(`[MCP] Cleared ${count} feature flags`);

        return createTextResult(`Cleared ${count} feature flags`);
    })
    .build();

// ============================================================================
// Value Resolution Tools
// ============================================================================

const resolveValueTool = defineTool()
    .name('resolve_value')
    .description('Resolve a value with variable interpolation using CSValueResolver')
    .category('environment')
    .stringParam('value', 'Value to resolve (can contain {{var}}, $var, {env:VAR}, {config:KEY})', { required: true })
    .objectParam('context', 'Additional context variables')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const value = params.value as string;
        const additionalContext = params.context as Record<string, unknown> || {};

        context.log('info', `Resolving value: ${value}`);

        try {
            if (CSValueResolver) {
                const resolver = CSValueResolver.getInstance();
                const resolved = resolver.resolve(value, additionalContext);

                return createJsonResult({
                    original: value,
                    resolved,
                    hasInterpolation: value !== resolved,
                });
            } else {
                // Basic interpolation without CSValueResolver
                let resolved = value;

                // Replace {{var}} patterns from context
                resolved = resolved.replace(/\{\{(\w+)\}\}/g, (match, key) => {
                    return additionalContext[key] !== undefined ? String(additionalContext[key]) : match;
                });

                // Replace {env:VAR} patterns
                resolved = resolved.replace(/\{env:(\w+)\}/g, (match, key) => {
                    return process.env[key] || match;
                });

                // Replace {config:KEY} patterns
                resolved = resolved.replace(/\{config:(\w+)\}/g, (match, key) => {
                    try {
                        const config = getConfigManager();
                        return config.get(key) || match;
                    } catch {
                        return match;
                    }
                });

                return createJsonResult({
                    original: value,
                    resolved,
                    hasInterpolation: value !== resolved,
                });
            }
        } catch (error: any) {
            return createErrorResult(`Failed to resolve value: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Time Manipulation Tools
// ============================================================================

let frozenTime: Date | null = null;
const originalDateNow = Date.now;
const originalDateConstructor = Date;

const timeFreezeTool = defineTool()
    .name('time_freeze')
    .description('Freeze time to a specific date/time for testing')
    .category('environment')
    .stringParam('datetime', 'ISO datetime string to freeze to', { required: true })
    .stringParam('timezone', 'Timezone to use', { default: 'UTC' })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const datetime = params.datetime as string;
        frozenTime = new Date(datetime);

        if (isNaN(frozenTime.getTime())) {
            frozenTime = null;
            return createErrorResult(`Invalid datetime: ${datetime}`);
        }

        context.log('info', `Freezing time to: ${frozenTime.toISOString()}`);
        CSReporter.info(`[MCP] Time frozen to: ${frozenTime.toISOString()}`);

        // Mock Date.now()
        (Date as any).now = () => frozenTime!.getTime();

        CSReporter.pass(`[MCP] Time frozen to: ${frozenTime.toISOString()}`);

        return createJsonResult({
            status: 'frozen',
            frozenAt: frozenTime.toISOString(),
            timezone: params.timezone,
            originalTime: new Date(originalDateNow()).toISOString(),
        });
    })
    .build();

const timeAdvanceTool = defineTool()
    .name('time_advance')
    .description('Advance frozen time by a duration')
    .category('environment')
    .numberParam('milliseconds', 'Milliseconds to advance')
    .numberParam('seconds', 'Seconds to advance')
    .numberParam('minutes', 'Minutes to advance')
    .numberParam('hours', 'Hours to advance')
    .numberParam('days', 'Days to advance')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        if (!frozenTime) {
            return createErrorResult('Time is not frozen. Use time_freeze first.');
        }

        const totalMs =
            ((params.milliseconds as number) || 0) +
            ((params.seconds as number) || 0) * 1000 +
            ((params.minutes as number) || 0) * 60000 +
            ((params.hours as number) || 0) * 3600000 +
            ((params.days as number) || 0) * 86400000;

        context.log('info', `Advancing time by ${totalMs}ms`);
        CSReporter.info(`[MCP] Advancing frozen time by ${totalMs}ms`);

        frozenTime = new Date(frozenTime.getTime() + totalMs);
        (Date as any).now = () => frozenTime!.getTime();

        CSReporter.pass(`[MCP] Time advanced to: ${frozenTime.toISOString()}`);

        return createJsonResult({
            advanced: true,
            milliseconds: totalMs,
            newTime: frozenTime.toISOString(),
        });
    })
    .build();

const timeUnfreezeTool = defineTool()
    .name('time_unfreeze')
    .description('Restore normal time behavior')
    .category('environment')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Unfreezing time');
        CSReporter.info('[MCP] Unfreezing time');

        // Restore original Date.now
        (Date as any).now = originalDateNow;
        frozenTime = null;

        CSReporter.pass('[MCP] Time unfrozen');
        return createTextResult('Time unfrozen, normal behavior restored');
    })
    .build();

// ============================================================================
// Mock Server Tools
// ============================================================================

// Active mock servers
const mockServers: Map<string, { server: http.Server; routes: any[]; port: number }> = new Map();

const mockServerStartTool = defineTool()
    .name('mock_server_start')
    .description('Start a mock HTTP server')
    .category('environment')
    .numberParam('port', 'Port to listen on', { required: true })
    .stringParam('name', 'Server name/identifier')
    .arrayParam('routes', 'Route definitions', 'object')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const port = params.port as number;
        const serverId = (params.name as string) || `mock_${port}`;

        if (mockServers.has(serverId)) {
            return createErrorResult(`Mock server ${serverId} already running`);
        }

        context.log('info', `Starting mock server: ${serverId} on port ${port}`);
        CSReporter.info(`[MCP] Starting mock server: ${serverId} on port ${port}`);

        // Create route storage
        const routes = (params.routes as Array<{
            path: string;
            method?: string;
            status?: number;
            body?: unknown;
            headers?: Record<string, string>;
            delay?: number;
        }>) || [];

        const server = http.createServer(async (req, res) => {
            const serverInfo = mockServers.get(serverId);
            const currentRoutes = serverInfo?.routes || routes;

            // Find matching route
            const route = currentRoutes.find(r =>
                (r.path === req.url || req.url?.startsWith(r.path)) &&
                (!r.method || r.method.toUpperCase() === req.method?.toUpperCase())
            );

            // Apply delay if specified
            if (route?.delay) {
                await new Promise(resolve => setTimeout(resolve, route.delay));
            }

            if (route) {
                const headers = {
                    'Content-Type': 'application/json',
                    ...route.headers,
                };
                res.writeHead(route.status || 200, headers);
                res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body || {}));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not Found', path: req.url, method: req.method }));
            }
        });

        return new Promise((resolve) => {
            server.listen(port, () => {
                mockServers.set(serverId, { server, routes, port });
                CSReporter.pass(`[MCP] Mock server started: ${serverId} on port ${port}`);

                resolve(createJsonResult({
                    serverId,
                    port,
                    status: 'running',
                    routes: routes.length,
                    baseUrl: `http://localhost:${port}`,
                }));
            });

            server.on('error', (error) => {
                CSReporter.fail(`[MCP] Mock server failed: ${error.message}`);
                resolve(createErrorResult(`Failed to start server: ${error.message}`));
            });
        });
    })
    .build();

const mockServerStopTool = defineTool()
    .name('mock_server_stop')
    .description('Stop a mock HTTP server')
    .category('environment')
    .stringParam('serverId', 'Server ID to stop', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const serverId = params.serverId as string;
        const serverInfo = mockServers.get(serverId);

        if (!serverInfo) {
            return createErrorResult(`Mock server not found: ${serverId}`);
        }

        context.log('info', `Stopping mock server: ${serverId}`);
        CSReporter.info(`[MCP] Stopping mock server: ${serverId}`);

        return new Promise((resolve) => {
            serverInfo.server.close(() => {
                mockServers.delete(serverId);
                CSReporter.pass(`[MCP] Mock server stopped: ${serverId}`);
                resolve(createTextResult(`Mock server ${serverId} stopped`));
            });
        });
    })
    .build();

const mockServerAddRouteTool = defineTool()
    .name('mock_server_add_route')
    .description('Add a route to a running mock server')
    .category('environment')
    .stringParam('serverId', 'Server ID', { required: true })
    .stringParam('path', 'Route path', { required: true })
    .stringParam('method', 'HTTP method', { default: 'GET' })
    .numberParam('status', 'Response status code', { default: 200 })
    .objectParam('body', 'Response body')
    .objectParam('headers', 'Response headers')
    .numberParam('delay', 'Response delay in milliseconds')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const serverId = params.serverId as string;
        const serverInfo = mockServers.get(serverId);

        if (!serverInfo) {
            return createErrorResult(`Mock server not found: ${serverId}`);
        }

        context.log('info', `Adding route to ${serverId}: ${params.method} ${params.path}`);
        CSReporter.info(`[MCP] Adding route to ${serverId}: ${params.method} ${params.path}`);

        const newRoute = {
            path: params.path as string,
            method: params.method as string,
            status: params.status as number,
            body: params.body,
            headers: params.headers as Record<string, string>,
            delay: params.delay as number,
        };

        serverInfo.routes.push(newRoute);

        CSReporter.pass(`[MCP] Route added to ${serverId}`);

        return createJsonResult({
            serverId,
            route: {
                path: params.path,
                method: params.method,
                status: params.status,
            },
            added: true,
            totalRoutes: serverInfo.routes.length,
        });
    })
    .build();

const mockServerListTool = defineTool()
    .name('mock_server_list')
    .description('List all running mock servers')
    .category('environment')
    .handler(async (params, context) => {
        context.log('info', 'Listing mock servers');

        const servers = Array.from(mockServers.entries()).map(([id, info]) => ({
            serverId: id,
            port: info.port,
            status: 'running',
            routes: info.routes.length,
            baseUrl: `http://localhost:${info.port}`,
        }));

        return createJsonResult({
            count: servers.length,
            servers,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Configuration Profile Tools
// ============================================================================

const configProfiles: Map<string, Record<string, unknown>> = new Map();

const configProfileSaveTool = defineTool()
    .name('config_profile_save')
    .description('Save current environment configuration as a profile')
    .category('environment')
    .stringParam('name', 'Profile name', { required: true })
    .booleanParam('includeEnv', 'Include environment variables', { default: true })
    .booleanParam('includeFlags', 'Include feature flags', { default: true })
    .booleanParam('includeConfig', 'Include framework configuration', { default: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const name = params.name as string;

        context.log('info', `Saving config profile: ${name}`);
        CSReporter.info(`[MCP] Saving config profile: ${name}`);

        const profile: Record<string, unknown> = {
            savedAt: new Date().toISOString(),
        };

        if (params.includeEnv) {
            // Only include CS-related env vars to keep profile manageable
            const csEnvVars: Record<string, string> = {};
            Object.entries(process.env)
                .filter(([key]) => key.startsWith('CS_') || key.includes('URL') ||
                    key.includes('TIMEOUT') || key.includes('BROWSER') ||
                    key.includes('PROJECT') || key.includes('ENV'))
                .forEach(([key, value]) => {
                    if (value) csEnvVars[key] = value;
                });
            profile.envVars = csEnvVars;
        }

        if (params.includeFlags) {
            profile.featureFlags = Object.fromEntries(featureFlags);
        }

        if (params.includeConfig) {
            try {
                const config = getConfigManager();
                profile.frameworkConfig = config.getAll();
            } catch {
                // Config not available
            }
        }

        configProfiles.set(name, profile);

        CSReporter.pass(`[MCP] Config profile saved: ${name}`);

        return createJsonResult({
            profileName: name,
            saved: true,
            includes: {
                envVars: params.includeEnv,
                featureFlags: params.includeFlags,
                frameworkConfig: params.includeConfig,
            },
        });
    })
    .build();

const configProfileLoadTool = defineTool()
    .name('config_profile_load')
    .description('Load a configuration profile')
    .category('environment')
    .stringParam('name', 'Profile name', { required: true })
    .booleanParam('merge', 'Merge with current config instead of replacing', { default: false })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const name = params.name as string;
        const profile = configProfiles.get(name);

        if (!profile) {
            return createErrorResult(`Profile not found: ${name}`);
        }

        context.log('info', `Loading config profile: ${name}`);
        CSReporter.info(`[MCP] Loading config profile: ${name}`);

        // Apply environment variables
        if (profile.envVars) {
            Object.assign(process.env, profile.envVars as Record<string, string>);
        }

        // Apply feature flags
        if (profile.featureFlags) {
            if (params.merge !== true) {
                featureFlags.clear();
            }
            Object.entries(profile.featureFlags as Record<string, { enabled: boolean; config: Record<string, unknown> }>)
                .forEach(([flagName, flag]) => featureFlags.set(flagName, flag));
        }

        CSReporter.pass(`[MCP] Config profile loaded: ${name}`);

        return createJsonResult({
            profileName: name,
            loaded: true,
            merged: params.merge === true,
        });
    })
    .build();

const configProfileListTool = defineTool()
    .name('config_profile_list')
    .description('List all saved configuration profiles')
    .category('environment')
    .handler(async (params, context) => {
        context.log('info', 'Listing config profiles');

        const profiles = Array.from(configProfiles.entries()).map(([name, profile]) => ({
            name,
            savedAt: profile.savedAt,
            hasEnvVars: !!profile.envVars,
            hasFeatureFlags: !!profile.featureFlags,
            hasFrameworkConfig: !!profile.frameworkConfig,
        }));

        return createJsonResult({
            count: profiles.length,
            profiles,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Export all environment tools
// ============================================================================

export const environmentTools: MCPToolDefinition[] = [
    // Environment Variables
    envGetTool,
    envSetTool,
    envListTool,
    envDeleteTool,

    // Framework Configuration
    configGetTool,
    configGetBooleanTool,
    configGetNumberTool,
    configListKeysTool,
    configGetProjectTool,

    // Value Resolution
    resolveValueTool,

    // Feature Flags
    featureFlagSetTool,
    featureFlagGetTool,
    featureFlagListTool,
    featureFlagClearTool,

    // Time Manipulation
    timeFreezeTool,
    timeAdvanceTool,
    timeUnfreezeTool,

    // Mock Server
    mockServerStartTool,
    mockServerStopTool,
    mockServerAddRouteTool,
    mockServerListTool,

    // Config Profiles
    configProfileSaveTool,
    configProfileLoadTool,
    configProfileListTool,
];

/**
 * Register all environment tools with the registry
 */
export function registerEnvironmentTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(environmentTools);
}
