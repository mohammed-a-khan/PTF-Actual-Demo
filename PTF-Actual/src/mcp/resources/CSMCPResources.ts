/**
 * CS Playwright MCP Resources
 * Dynamic and static resources exposed by the MCP server
 *
 * @module CSMCPResources
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    MCPResource,
    MCPResourceTemplate,
    MCPResourceContents,
    MCPResourceDefinition,
    MCPToolContext,
} from '../types/CSMCPTypes';
import { CSMCPServer } from '../CSMCPServer';

// ============================================================================
// Resource Definitions
// ============================================================================

/**
 * Test Results Resource
 * URI: cs-playwright://tests/results/{executionId}
 */
const testResultsTemplate: MCPResourceTemplate = {
    uriTemplate: 'cs-playwright://tests/results/{executionId}',
    name: 'Test Results',
    description: 'Get test execution results by execution ID',
    mimeType: 'application/json',
};

async function handleTestResults(uri: string, context: MCPToolContext): Promise<MCPResourceContents> {
    // Extract execution ID from URI
    const match = uri.match(/cs-playwright:\/\/tests\/results\/(.+)/);
    const executionId = match?.[1] || 'latest';

    // In actual implementation, read from results file/database
    const results = {
        executionId,
        status: 'completed',
        summary: {
            total: 10,
            passed: 8,
            failed: 1,
            skipped: 1,
        },
        timestamp: new Date().toISOString(),
    };

    return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(results, null, 2),
    };
}

/**
 * Page Objects Resource
 * URI: cs-playwright://pages/{pageName}
 */
const pageObjectTemplate: MCPResourceTemplate = {
    uriTemplate: 'cs-playwright://pages/{pageName}',
    name: 'Page Object Definition',
    description: 'Get page object class definition',
    mimeType: 'text/typescript',
};

async function handlePageObject(uri: string, context: MCPToolContext): Promise<MCPResourceContents> {
    const match = uri.match(/cs-playwright:\/\/pages\/(.+)/);
    const pageName = match?.[1] || '';

    // Search for page object file
    const pagesDir = path.join(context.server.workingDirectory, 'test', 'pages');
    const possiblePaths = [
        path.join(pagesDir, `${pageName}.page.ts`),
        path.join(pagesDir, `${pageName}Page.ts`),
        path.join(pagesDir, pageName, 'index.ts'),
    ];

    for (const pagePath of possiblePaths) {
        if (fs.existsSync(pagePath)) {
            const content = fs.readFileSync(pagePath, 'utf-8');
            return {
                uri,
                mimeType: 'text/typescript',
                text: content,
            };
        }
    }

    return {
        uri,
        mimeType: 'text/plain',
        text: `Page object not found: ${pageName}`,
    };
}

/**
 * Environment Configuration Resource
 * URI: cs-playwright://config/environments
 */
const environmentConfigResource: MCPResource = {
    uri: 'cs-playwright://config/environments',
    name: 'Environment Configuration',
    description: 'Available test environment configurations',
    mimeType: 'application/json',
};

async function handleEnvironmentConfig(uri: string, context: MCPToolContext): Promise<MCPResourceContents> {
    // Read environment configs
    const configDir = path.join(context.server.workingDirectory, 'config');
    const environments: Record<string, unknown> = {};

    if (fs.existsSync(configDir)) {
        const files = fs.readdirSync(configDir);
        for (const file of files) {
            if (file.endsWith('.json') || file.endsWith('.env')) {
                const envName = file.replace(/\.(json|env)$/, '');
                const filePath = path.join(configDir, file);
                try {
                    if (file.endsWith('.json')) {
                        environments[envName] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                    } else {
                        environments[envName] = { type: 'env', path: filePath };
                    }
                } catch {
                    environments[envName] = { error: 'Failed to parse' };
                }
            }
        }
    }

    return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(environments, null, 2),
    };
}

/**
 * Feature Files Resource
 * URI: cs-playwright://features
 */
const featureFilesResource: MCPResource = {
    uri: 'cs-playwright://features',
    name: 'Feature Files',
    description: 'List of all BDD feature files in the project',
    mimeType: 'application/json',
};

async function handleFeatureFiles(uri: string, context: MCPToolContext): Promise<MCPResourceContents> {
    const features: Array<{ path: string; name: string; tags: string[] }> = [];

    const findFeatures = (dir: string): void => {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                findFeatures(fullPath);
            } else if (entry.name.endsWith('.feature')) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');

                let featureName = '';
                const tags: string[] = [];

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('@')) {
                        tags.push(...trimmed.split(/\s+/).filter(t => t.startsWith('@')));
                    } else if (trimmed.startsWith('Feature:')) {
                        featureName = trimmed.replace('Feature:', '').trim();
                        break;
                    }
                }

                features.push({
                    path: path.relative(context.server.workingDirectory, fullPath),
                    name: featureName || entry.name,
                    tags,
                });
            }
        }
    };

    findFeatures(path.join(context.server.workingDirectory, 'test'));

    return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ features, count: features.length }, null, 2),
    };
}

/**
 * Step Definitions Resource
 * URI: cs-playwright://steps
 */
const stepDefinitionsResource: MCPResource = {
    uri: 'cs-playwright://steps',
    name: 'Step Definitions',
    description: 'List of all BDD step definitions in the project',
    mimeType: 'application/json',
};

async function handleStepDefinitions(uri: string, context: MCPToolContext): Promise<MCPResourceContents> {
    const steps: Array<{ file: string; pattern: string; line: number }> = [];

    const findSteps = (dir: string): void => {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                findSteps(fullPath);
            } else if (entry.name.endsWith('.steps.ts') || entry.name.endsWith('.step.ts')) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');

                lines.forEach((line, index) => {
                    const match = line.match(/@CSBDDStepDef\s*\(\s*['"`](.+?)['"`]\s*\)/);
                    if (match) {
                        steps.push({
                            file: path.relative(context.server.workingDirectory, fullPath),
                            pattern: match[1],
                            line: index + 1,
                        });
                    }
                });
            }
        }
    };

    findSteps(path.join(context.server.workingDirectory, 'test'));

    return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ steps, count: steps.length }, null, 2),
    };
}

/**
 * Browser State Resource
 * URI: cs-playwright://browser/state
 */
const browserStateResource: MCPResource = {
    uri: 'cs-playwright://browser/state',
    name: 'Browser State',
    description: 'Current browser state (URL, title, cookies)',
    mimeType: 'application/json',
};

async function handleBrowserState(uri: string, context: MCPToolContext): Promise<MCPResourceContents> {
    if (!context.server.browser?.page) {
        return {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ connected: false, message: 'No browser session active' }),
        };
    }

    const page = context.server.browser.page as {
        url: () => string;
        title: () => Promise<string>;
        context: () => { cookies: () => Promise<unknown[]> };
    };

    try {
        const url = page.url();
        const title = await page.title();
        const cookies = await page.context().cookies();

        return {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
                connected: true,
                url,
                title,
                cookieCount: cookies.length,
            }, null, 2),
        };
    } catch (error) {
        return {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
                connected: false,
                error: (error as Error).message,
            }),
        };
    }
}

/**
 * Scenario Context Resource
 * URI: cs-playwright://context/variables
 */
const scenarioContextResource: MCPResource = {
    uri: 'cs-playwright://context/variables',
    name: 'Scenario Context Variables',
    description: 'Current scenario context variables',
    mimeType: 'application/json',
};

async function handleScenarioContext(uri: string, context: MCPToolContext): Promise<MCPResourceContents> {
    const variables: Record<string, unknown> = {};

    if (context.server.scenarioContext) {
        context.server.scenarioContext.forEach((value, key) => {
            variables[key] = value;
        });
    }

    return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
            variables,
            count: Object.keys(variables).length,
        }, null, 2),
    };
}

// ============================================================================
// Resource Registration
// ============================================================================

/**
 * All resource definitions
 */
export const resourceDefinitions: MCPResourceDefinition[] = [
    // Static resources
    {
        resource: environmentConfigResource,
        handler: handleEnvironmentConfig,
    },
    {
        resource: featureFilesResource,
        handler: handleFeatureFiles,
    },
    {
        resource: stepDefinitionsResource,
        handler: handleStepDefinitions,
    },
    {
        resource: browserStateResource,
        handler: handleBrowserState,
    },
    {
        resource: scenarioContextResource,
        handler: handleScenarioContext,
    },
];

/**
 * All resource template definitions
 */
export const resourceTemplateDefinitions: MCPResourceDefinition[] = [
    {
        resource: testResultsTemplate,
        handler: handleTestResults,
    },
    {
        resource: pageObjectTemplate,
        handler: handlePageObject,
    },
];

/**
 * Register all resources with the MCP server
 */
export function registerResources(server: CSMCPServer): void {
    for (const def of resourceDefinitions) {
        server.registerResource(def);
    }
    for (const def of resourceTemplateDefinitions) {
        server.registerResourceTemplate(def);
    }
}
