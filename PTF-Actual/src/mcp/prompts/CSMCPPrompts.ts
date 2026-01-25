/**
 * CS Playwright MCP Prompts
 * Reusable prompt templates for AI interactions
 *
 * @module CSMCPPrompts
 */

import {
    MCPPrompt,
    MCPPromptDefinition,
    MCPGetPromptResult,
    MCPToolContext,
    MCPTextContent,
} from '../types/CSMCPTypes';
import { CSMCPServer } from '../CSMCPServer';

// ============================================================================
// Prompt Definitions
// ============================================================================

/**
 * Analyze Test Failure Prompt
 * Helps analyze why a test failed and suggests fixes
 */
const analyzeFailurePrompt: MCPPrompt = {
    name: 'analyze_failure',
    description: 'Analyze a test failure and suggest fixes',
    arguments: [
        {
            name: 'testName',
            description: 'Name of the failed test',
            required: true,
        },
        {
            name: 'errorMessage',
            description: 'The error message from the failure',
            required: true,
        },
        {
            name: 'stackTrace',
            description: 'The stack trace (optional)',
            required: false,
        },
        {
            name: 'screenshot',
            description: 'Base64 encoded screenshot at failure point (optional)',
            required: false,
        },
    ],
};

async function handleAnalyzeFailure(
    args: Record<string, string>,
    context: MCPToolContext
): Promise<MCPGetPromptResult> {
    const prompt = `You are a test automation expert analyzing a test failure.

## Failed Test
**Name:** ${args.testName}

## Error
\`\`\`
${args.errorMessage}
\`\`\`

${args.stackTrace ? `## Stack Trace\n\`\`\`\n${args.stackTrace}\n\`\`\`\n` : ''}

## Your Task
1. Analyze the error message and stack trace
2. Identify the root cause of the failure
3. Determine if this is:
   - A test code issue (locator, timing, logic)
   - An application bug
   - A flaky test (timing/async issue)
   - An environment issue
4. Suggest specific fixes with code examples
5. If it's a flaky test, suggest how to make it more reliable

Please provide your analysis in a structured format.`;

    return {
        description: 'Analyze a test failure and provide debugging guidance',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: prompt,
                } as MCPTextContent,
            },
        ],
    };
}

/**
 * Generate Test Prompt
 * Generates BDD test scenarios from requirements
 */
const generateTestPrompt: MCPPrompt = {
    name: 'generate_test',
    description: 'Generate BDD test scenarios from requirements',
    arguments: [
        {
            name: 'requirement',
            description: 'The requirement or user story to test',
            required: true,
        },
        {
            name: 'context',
            description: 'Additional context about the application',
            required: false,
        },
        {
            name: 'existingSteps',
            description: 'List of existing step definitions that can be reused',
            required: false,
        },
    ],
};

async function handleGenerateTest(
    args: Record<string, string>,
    context: MCPToolContext
): Promise<MCPGetPromptResult> {
    const prompt = `You are a BDD test automation expert. Generate comprehensive test scenarios.

## Requirement
${args.requirement}

${args.context ? `## Application Context\n${args.context}\n` : ''}

${args.existingSteps ? `## Available Step Definitions\n\`\`\`\n${args.existingSteps}\n\`\`\`\n` : ''}

## Your Task
1. Analyze the requirement and identify test scenarios
2. Write Gherkin feature file(s) with:
   - Feature description
   - Appropriate tags (@smoke, @regression, etc.)
   - Background section if applicable
   - Multiple scenarios covering:
     - Happy path
     - Edge cases
     - Error conditions
     - Boundary values
3. Use Scenario Outline for data-driven tests where appropriate
4. Reuse existing step definitions when possible
5. Follow BDD best practices:
   - Given-When-Then format
   - One assertion per Then step
   - Declarative over imperative style

Provide the complete feature file(s) with explanations.`;

    return {
        description: 'Generate BDD test scenarios from requirements',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: prompt,
                } as MCPTextContent,
            },
        ],
    };
}

/**
 * Optimize Locator Prompt
 * Suggests better locator strategies
 */
const optimizeLocatorPrompt: MCPPrompt = {
    name: 'optimize_locator',
    description: 'Suggest better locator strategies for elements',
    arguments: [
        {
            name: 'currentLocator',
            description: 'The current locator that needs optimization',
            required: true,
        },
        {
            name: 'html',
            description: 'The HTML snippet containing the element',
            required: false,
        },
        {
            name: 'issue',
            description: 'What issue are you experiencing (flaky, slow, etc.)',
            required: false,
        },
    ],
};

async function handleOptimizeLocator(
    args: Record<string, string>,
    context: MCPToolContext
): Promise<MCPGetPromptResult> {
    const prompt = `You are an expert in Playwright locator strategies.

## Current Locator
\`\`\`
${args.currentLocator}
\`\`\`

${args.html ? `## HTML Context\n\`\`\`html\n${args.html}\n\`\`\`\n` : ''}

${args.issue ? `## Issue\n${args.issue}\n` : ''}

## Your Task
Suggest better locator strategies following this priority:
1. **User-facing attributes** (role, text, label, placeholder, alt text)
2. **Test IDs** (data-testid, data-test, data-cy)
3. **Semantic selectors** (getByRole, getByLabel, getByText)
4. **CSS selectors** (as fallback)
5. **XPath** (only when absolutely necessary)

For each suggestion:
- Explain why it's better
- Show the Playwright code
- Rate its reliability (1-5 stars)
- Note any caveats

Provide multiple alternatives ranked by preference.`;

    return {
        description: 'Get suggestions for more reliable element locators',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: prompt,
                } as MCPTextContent,
            },
        ],
    };
}

/**
 * Generate Page Object Prompt
 * Generates page object class from page structure
 */
const generatePageObjectPrompt: MCPPrompt = {
    name: 'generate_page_object',
    description: 'Generate a page object class from page structure',
    arguments: [
        {
            name: 'pageName',
            description: 'Name for the page object',
            required: true,
        },
        {
            name: 'accessibilityTree',
            description: 'Accessibility tree snapshot of the page',
            required: false,
        },
        {
            name: 'url',
            description: 'URL of the page',
            required: false,
        },
        {
            name: 'description',
            description: 'Description of the page functionality',
            required: false,
        },
    ],
};

async function handleGeneratePageObject(
    args: Record<string, string>,
    context: MCPToolContext
): Promise<MCPGetPromptResult> {
    const prompt = `You are a test automation architect. Generate a page object class.

## Page Information
**Name:** ${args.pageName}
${args.url ? `**URL:** ${args.url}` : ''}
${args.description ? `**Description:** ${args.description}` : ''}

${args.accessibilityTree ? `## Accessibility Tree\n\`\`\`json\n${args.accessibilityTree}\n\`\`\`\n` : ''}

## Your Task
Generate a TypeScript page object class following these guidelines:

1. **Class Structure:**
   - Extend CSPageObject from the framework
   - Use CSElementFactory for element creation
   - Group related elements logically

2. **Element Locators:**
   - Prefer user-facing locators (role, text, label)
   - Use data-testid when available
   - Create descriptive element names

3. **Methods:**
   - Create action methods (click, fill, select)
   - Create verification methods (verify*, is*)
   - Create getter methods for text content
   - Handle waiting and assertions

4. **Best Practices:**
   - Single Responsibility Principle
   - Fluent interface for chaining
   - Clear JSDoc comments
   - Error handling

Provide the complete TypeScript class with all imports.`;

    return {
        description: 'Generate a page object class from page structure',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: prompt,
                } as MCPTextContent,
            },
        ],
    };
}

/**
 * Generate Step Definition Prompt
 * Generates step definitions for Gherkin steps
 */
const generateStepDefinitionPrompt: MCPPrompt = {
    name: 'generate_step_definition',
    description: 'Generate step definitions for Gherkin steps',
    arguments: [
        {
            name: 'steps',
            description: 'Gherkin steps that need implementations',
            required: true,
        },
        {
            name: 'pageObjects',
            description: 'Available page objects to use',
            required: false,
        },
    ],
};

async function handleGenerateStepDefinition(
    args: Record<string, string>,
    context: MCPToolContext
): Promise<MCPGetPromptResult> {
    const prompt = `You are a BDD automation expert. Generate step definitions.

## Gherkin Steps
\`\`\`gherkin
${args.steps}
\`\`\`

${args.pageObjects ? `## Available Page Objects\n\`\`\`\n${args.pageObjects}\n\`\`\`\n` : ''}

## Your Task
Generate TypeScript step definitions using the CS Playwright framework:

1. **Decorator Pattern:**
   \`\`\`typescript
   @CSBDDStepDef('step pattern with {string} and {int}')
   async methodName(param1: string, param2: number): Promise<void> {
       // implementation
   }
   \`\`\`

2. **Implementation Guidelines:**
   - Use page objects for element interactions
   - Use CSReporter for logging (info, pass, fail)
   - Handle dynamic data with scenario context
   - Add appropriate waits
   - Include error handling

3. **Parameter Types:**
   - {string} - Quoted string "value"
   - {int} - Integer number
   - {float} - Decimal number
   - {word} - Single word

Provide complete step definition class with imports.`;

    return {
        description: 'Generate step definitions for Gherkin steps',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: prompt,
                } as MCPTextContent,
            },
        ],
    };
}

/**
 * Review Test Code Prompt
 * Reviews test code for best practices
 */
const reviewTestCodePrompt: MCPPrompt = {
    name: 'review_test_code',
    description: 'Review test code for best practices and improvements',
    arguments: [
        {
            name: 'code',
            description: 'The test code to review',
            required: true,
        },
        {
            name: 'type',
            description: 'Type of code: step_definition, page_object, feature',
            required: false,
        },
    ],
};

async function handleReviewTestCode(
    args: Record<string, string>,
    context: MCPToolContext
): Promise<MCPGetPromptResult> {
    const prompt = `You are a senior test automation engineer conducting a code review.

## Code to Review
\`\`\`typescript
${args.code}
\`\`\`

${args.type ? `**Code Type:** ${args.type}` : ''}

## Review Criteria
Evaluate the code against these categories:

1. **Reliability**
   - Proper waits and synchronization
   - Flakiness risks
   - Error handling

2. **Maintainability**
   - Code organization
   - Naming conventions
   - DRY principle
   - Single Responsibility

3. **Readability**
   - Clear intent
   - Comments and documentation
   - Consistent formatting

4. **Performance**
   - Unnecessary waits
   - Efficient locators
   - Resource management

5. **Best Practices**
   - Framework conventions
   - Security considerations
   - Accessibility testing

## Output Format
For each issue found:
- **Severity:** Critical / Major / Minor / Suggestion
- **Location:** Line number or code snippet
- **Issue:** Description of the problem
- **Fix:** Recommended solution with code example

Provide an overall score (A-F) and summary.`;

    return {
        description: 'Review test code for best practices',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: prompt,
                } as MCPTextContent,
            },
        ],
    };
}

/**
 * Debug Flaky Test Prompt
 * Helps debug and fix flaky tests
 */
const debugFlakyTestPrompt: MCPPrompt = {
    name: 'debug_flaky_test',
    description: 'Debug and fix flaky tests',
    arguments: [
        {
            name: 'testCode',
            description: 'The flaky test code',
            required: true,
        },
        {
            name: 'failurePattern',
            description: 'Description of when/how it fails',
            required: false,
        },
        {
            name: 'successRate',
            description: 'Approximate success rate (e.g., "7 out of 10")',
            required: false,
        },
    ],
};

async function handleDebugFlakyTest(
    args: Record<string, string>,
    context: MCPToolContext
): Promise<MCPGetPromptResult> {
    const prompt = `You are a test reliability expert debugging a flaky test.

## Flaky Test Code
\`\`\`typescript
${args.testCode}
\`\`\`

${args.failurePattern ? `## Failure Pattern\n${args.failurePattern}\n` : ''}
${args.successRate ? `## Success Rate\n${args.successRate}\n` : ''}

## Common Causes of Flakiness
1. **Timing Issues**
   - Race conditions
   - Insufficient waits
   - Animation/transition delays

2. **Test Isolation**
   - Shared state
   - Database pollution
   - Cache issues

3. **External Dependencies**
   - Network latency
   - Third-party services
   - Time-dependent logic

4. **Environment**
   - Resource contention
   - Browser differences
   - Configuration drift

## Your Task
1. Analyze the code for flakiness indicators
2. Identify the most likely root cause
3. Provide specific fixes with code examples
4. Suggest additional reliability improvements
5. Recommend monitoring/detection strategies

Format your response with:
- Root Cause Analysis
- Recommended Fixes (with code)
- Prevention Strategies`;

    return {
        description: 'Debug and fix flaky tests',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: prompt,
                } as MCPTextContent,
            },
        ],
    };
}

// ============================================================================
// Prompt Registration
// ============================================================================

/**
 * All prompt definitions
 */
export const promptDefinitions: MCPPromptDefinition[] = [
    {
        prompt: analyzeFailurePrompt,
        handler: handleAnalyzeFailure,
    },
    {
        prompt: generateTestPrompt,
        handler: handleGenerateTest,
    },
    {
        prompt: optimizeLocatorPrompt,
        handler: handleOptimizeLocator,
    },
    {
        prompt: generatePageObjectPrompt,
        handler: handleGeneratePageObject,
    },
    {
        prompt: generateStepDefinitionPrompt,
        handler: handleGenerateStepDefinition,
    },
    {
        prompt: reviewTestCodePrompt,
        handler: handleReviewTestCode,
    },
    {
        prompt: debugFlakyTestPrompt,
        handler: handleDebugFlakyTest,
    },
];

/**
 * Register all prompts with the MCP server
 */
export function registerPrompts(server: CSMCPServer): void {
    for (const def of promptDefinitions) {
        server.registerPrompt(def);
    }
}
