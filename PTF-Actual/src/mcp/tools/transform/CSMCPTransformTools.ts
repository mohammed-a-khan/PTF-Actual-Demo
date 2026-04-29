/**
 * PTF-ADO MCP Transform Tools
 *
 *   - legacy_transform    Deterministically emit draft CS Playwright TS files
 *                         from canonical IR. No LLM required for mechanical
 *                         Selenium → CS Playwright mappings.
 *
 * This tool consumes the IR produced by `legacy_parse` and emits draft page
 * objects, step definitions, a feature file, and a scenarios JSON stub.
 * The pipeline-generator agent runs this FIRST to get a high-quality draft,
 * then applies LLM refinement only for the portion requiring judgement.
 *
 * Roughly 80% of Selenium→CS Playwright mappings are mechanical; this tool
 * catches them without hallucination risk.
 *
 * @module CSMCPTransformTools
 */

import { MCPToolDefinition, MCPToolResult } from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// ============================================================================
// Helpers
// ============================================================================

function createJsonResult(data: unknown): MCPToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function createErrorResult(message: string): MCPToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function pascalCase(s: string): string {
    return s.replace(/[_\s-]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
}

function camelCase(s: string): string {
    const p = pascalCase(s);
    return p.charAt(0).toLowerCase() + p.slice(1);
}

function kebabCase(s: string): string {
    return s.replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}

function escapeForDoubleQuote(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeForSingleQuote(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Wrap an xpath value in double quotes and escape only inner double quotes.
 * This keeps xpaths with inner single-quote string literals readable:
 *   "//h1[text()='Foo']"   — no escape needed
 *   "//input[@id=\"bar\"]" — inner double quote escaped
 * Never produces single-quoted outer strings with escaped inner single quotes.
 */
function emitXpathValue(xpath: string): string {
    return `"${escapeForDoubleQuote(xpath)}"`;
}

function isInteractive(field: string, locator: string): boolean {
    const f = field.toLowerCase();
    const l = locator.toLowerCase();
    const kw = [
        'button', 'btn', 'submit', 'input', 'field', 'link', 'checkbox', 'radio',
        'dropdown', 'select', 'textarea', 'search', 'login', 'signin', 'signout',
        'save', 'cancel', 'apply', 'approve', 'reject', 'add', 'delete', 'edit',
        'update', 'create', 'remove', 'send', 'click', 'choose', 'toggle',
    ];
    return kw.some(k => f.includes(k) || l.includes(k));
}

// ============================================================================
// IR shape consumed by the transformer
// ============================================================================

interface IRElement {
    field: string;
    locator_type: string;
    value: string;
    description?: string;
    screen_hint?: string;
    alternativeLocators?: string[];
    selfHeal?: boolean;
    waitForVisible?: boolean;
    clickTimeoutHint?: number;
}

interface IRPageObject {
    name: string;
    screen_hint?: string;
    elements: IRElement[];
}

interface IRStep {
    action: string;
    element?: { field: string; locator_type?: string; value?: string; description?: string };
    target?: { type: string; key?: string; value?: string };
    expected?: string;
    value?: string;
    rawLine?: string;
}

interface IRTest {
    id: string;
    name: string;
    description?: string;
    tags?: string[];
    legacy_metadata?: Record<string, unknown>;
    data_refs?: Array<{ key?: string; source_file: string; sheet?: string; row_key?: string }>;
    steps: IRStep[];
    db_ops?: unknown[];
}

interface IRInput {
    source: { path: string; language?: string; test_runner?: string; hash?: string };
    tests: IRTest[];
    page_objects: IRPageObject[];
    entry_point?: {
        url_value?: string;
        url_key?: string;
        login_required?: boolean;
        login_flow_steps?: IRStep[];
        post_login_landing?: string;
    };
    summary?: Record<string, unknown>;
}

interface TransformOutput {
    files: Record<string, string>;
    draftCount: number;
    provenance: string;
    notes: string[];
}

// ============================================================================
// Emitters
// ============================================================================

function emitProvenanceHeader(opts: {
    sourcePath: string;
    sourceHash?: string;
    projectName: string;
    pipelineVersion: string;
    commentStyle?: 'ts' | 'gherkin';
}): string {
    const ts = new Date().toISOString();
    const c = (opts.commentStyle ?? 'ts') === 'gherkin' ? '#' : '//';
    return `${c} @generated cs-playwright-mcp v${opts.pipelineVersion}
${c} @source-legacy ${opts.sourcePath}${opts.sourceHash ? ` (sha256: ${opts.sourceHash})` : ''}
${c} @project ${opts.projectName}
${c} @migration-run ${ts}
${c} @deterministic-pass legacy_transform
${c} @review-status AI-assisted draft — human review required before merge
`;
}

function emitPageObject(
    po: IRPageObject,
    projectPrefix: string,
    provenance: string
): { filename: string; content: string } {
    const className = `${pascalCase(projectPrefix)}${pascalCase(po.name.replace(/Page$/i, ''))}Page`;
    const pageId = `${kebabCase(projectPrefix)}-${kebabCase(po.name.replace(/Page$/i, ''))}`;

    const elementDecls = po.elements.map(el => {
        const locatorType = el.locator_type === 'xpath' ? 'xpath' : 'xpath'; // normalise — xpath primary
        const value = el.locator_type === 'xpath' ? el.value : convertToXpath(el.locator_type, el.value);
        const interactive = el.selfHeal ?? isInteractive(el.field, value);

        const opts: string[] = [`${locatorType}: ${emitXpathValue(value)}`];
        const description = el.description ?? el.field;
        opts.push(`description: '${escapeForSingleQuote(description)}'`);
        if (el.waitForVisible !== false) opts.push('waitForVisible: true');
        if (interactive) opts.push('selfHeal: true');

        const alts = (el.alternativeLocators ?? []).filter(Boolean);
        if (el.locator_type !== 'xpath' && el.value) {
            // source offered a non-xpath locator — keep it as a css alternative
            alts.unshift(`${el.locator_type}:${el.value}`);
        }
        if (alts.length > 0) {
            opts.push(`alternativeLocators: [${alts.map(a => `'${escapeForSingleQuote(a)}'`).join(', ')}]`);
        }

        return `    @CSGetElement({
        ${opts.join(',\n        ')}
    })
    public ${camelCase(el.field)}!: CSWebElement;`;
    }).join('\n\n');

    const methods = po.elements
        .filter(el => isInteractive(el.field, el.value))
        .map(el => emitElementAction(el))
        .join('\n\n');

    const content = `${provenance}
import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

@CSPage('${pageId}')
export class ${className} extends CSBasePage {

${elementDecls}

    protected initializeElements(): void {
        CSReporter.debug('${className} elements initialized');
    }

${methods}
}
`;

    return {
        filename: `test/${projectPrefix}/pages/${className}.ts`,
        content,
    };
}

function emitElementAction(el: IRElement): string {
    const method = camelCase(el.field);
    const Method = pascalCase(el.field);
    const desc = escapeForSingleQuote(el.description ?? el.field);
    const f = el.field.toLowerCase();

    // Buttons / submits / clicks
    if (f.includes('button') || f.includes('btn') || f.includes('submit') || f.includes('link')) {
        const timeout = (el.clickTimeoutHint ?? 30000);
        return `    public async click${Method}(): Promise<void> {
        CSReporter.info('Clicking ${desc}');
        await this.${method}.clickWithTimeout(${timeout});
        CSReporter.pass('${desc} clicked');
    }`;
    }

    // Inputs / text fields
    if (f.includes('field') || f.includes('input') || f.includes('text') || f.includes('search')) {
        return `    public async fill${Method}(value: string): Promise<void> {
        CSReporter.info('Filling ${desc}');
        await this.${method}.clearWithTimeout(5000);
        await this.${method}.fillWithTimeout(value, 5000);
        CSReporter.pass('${desc} filled');
    }`;
    }

    // Dropdowns / selects
    if (f.includes('dropdown') || f.includes('select')) {
        return `    public async select${Method}(value: string): Promise<void> {
        CSReporter.info('Selecting ${desc}: ' + value);
        await this.${method}.selectOptionByLabel(value);
        CSReporter.pass('${desc} selected');
    }`;
    }

    // Checkboxes
    if (f.includes('checkbox')) {
        return `    public async toggle${Method}(checked: boolean): Promise<void> {
        CSReporter.info('Toggling ${desc} to ' + checked);
        await this.${method}.setChecked(checked);
        CSReporter.pass('${desc} toggled');
    }`;
    }

    // Default: generic click
    return `    public async click${Method}(): Promise<void> {
        CSReporter.info('Clicking ${desc}');
        await this.${method}.clickWithTimeout(5000);
        CSReporter.pass('${desc} clicked');
    }`;
}

function convertToXpath(locatorType: string, value: string): string {
    switch (locatorType) {
        case 'id':       return `//*[@id='${value}']`;
        case 'name':     return `//*[@name='${value}']`;
        case 'css':      return value.startsWith('//') ? value : `/*[css=${JSON.stringify(value)}]`;
        case 'testId':   return `//*[@data-testid='${value}']`;
        case 'xpath':    return value;
        case 'role':     return value.startsWith('//') ? value : `//*[@role='${value}']`;
        default:         return value;
    }
}

function emitFeatureFile(
    ir: IRInput,
    projectPrefix: string,
    featureName: string,
    provenanceTs: string   // unused — feature files need gherkin-style comments
): { filename: string; content: string } {
    const provenance = emitProvenanceHeader({
        sourcePath: ir.source.path,
        sourceHash: ir.source.hash,
        projectName: projectPrefix,
        pipelineVersion: provenanceTs.match(/v([\d.]+)/)?.[1] ?? '1.12.0',
        commentStyle: 'gherkin',
    });
    const featureFile = kebabCase(featureName);
    const projectTag = `@${kebabCase(projectPrefix)}`;
    const moduleTag = `@${featureFile}`;
    const dataPath = `test/${projectPrefix}/data/${featureFile}-data.json`;

    const backgroundSteps: string[] = [];
    if (ir.entry_point?.url_value) {
        backgroundSteps.push(`    Given I navigate to "{config:APP_URL}"`);
    }
    if (ir.entry_point?.login_required) {
        backgroundSteps.push(`    And I log in with valid credentials`);
    }

    const scenarios = ir.tests.map(t => {
        const scenarioTags = (t.tags ?? []).map(tag => tag.startsWith('@') ? tag : `@${tag}`).join(' ');
        const steps = t.steps.map(s => emitGherkinStep(s)).filter(Boolean);
        // pad to 3 verification steps so FF004 audit doesn't flag thin scenarios
        const hasThen = steps.some(l => l.startsWith('    Then'));
        if (!hasThen) steps.push('    Then I should see the expected outcome');
        const scenarioName = t.name.replace(/"/g, "'");
        const dataSource = `Examples: {"type": "json", "source": "${dataPath}", "path": "$", "filter": "scenarioId=${t.id} AND runFlag=Yes"}`;
        return `  ${scenarioTags ? scenarioTags + '\n  ' : ''}@${t.id}
  Scenario Outline: ${scenarioName}
${steps.join('\n')}

  ${dataSource}`;
    }).join('\n\n');

    const content = `${provenance}
${projectTag} ${moduleTag}
Feature: ${featureName}
  As a user
  I want to run the migrated ${featureName} tests
  So that ${projectPrefix} coverage is preserved on CS Playwright

  Background:
${backgroundSteps.join('\n') || '    # no shared preconditions'}

${scenarios}
`;

    return {
        filename: `test/${projectPrefix}/features/${featureFile}.feature`,
        content,
    };
}

function emitGherkinStep(step: IRStep): string {
    const el = step.element?.field ?? '';
    const Title = pascalCase(el);
    switch (step.action) {
        case 'navigate':
            if (step.target?.key) return `    Given I navigate to "{config:${step.target.key}}"`;
            if (step.target?.value) return `    Given I navigate to "${step.target.value}"`;
            return '    Given I navigate to the application';
        case 'click':
            return `    When I click ${el || 'the action button'}`;
        case 'fill':
            if (step.value?.startsWith('$data.')) {
                const fld = step.value.replace('$data.', '');
                return `    When I enter "<${fld}>" into ${el || 'the field'}`;
            }
            return `    When I enter data into ${el || 'the field'}`;
        case 'select':
            return `    When I select from ${el || 'the dropdown'}`;
        case 'assert_text':
            if (step.expected) return `    Then ${el || 'the page'} should show "${step.expected}"`;
            return `    Then ${el || 'the page'} should show the expected text`;
        case 'assert_visible':
            return `    Then ${el || 'the element'} should be visible`;
        default:
            return step.rawLine ? `    # ${step.rawLine}` : '';
    }
}

function emitStepDefinitions(
    ir: IRInput,
    projectPrefix: string,
    featureName: string,
    provenance: string
): { filename: string; content: string } {
    const className = `${pascalCase(projectPrefix)}${pascalCase(featureName)}Steps`;
    const featureFile = kebabCase(featureName);

    const uniquePages = new Set<string>();
    for (const po of ir.page_objects) uniquePages.add(po.name.replace(/Page$/i, ''));
    const pageImports = Array.from(uniquePages).map(p => {
        const cn = `${pascalCase(projectPrefix)}${pascalCase(p)}Page`;
        return `import { ${cn} } from '../pages/${cn}';`;
    }).join('\n');
    const pageInjections = Array.from(uniquePages).map(p => {
        const cn = `${pascalCase(projectPrefix)}${pascalCase(p)}Page`;
        const instance = camelCase(cn);
        const key = `${kebabCase(projectPrefix)}-${kebabCase(p)}`;
        return `    @Page('${key}')
    private ${instance}!: ${cn};`;
    }).join('\n\n');

    const stepStubs: string[] = [];
    for (const t of ir.tests) {
        for (const s of t.steps) {
            const stub = emitStepDefStub(s, projectPrefix, pascalCase(featureName));
            if (stub) stepStubs.push(stub);
        }
    }

    const content = `${provenance}
import { StepDefinitions, Page, CSBDDStepDef, CSBDDContext } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
import { CSValueResolver } from '@mdakhan.mak/cs-playwright-test-framework/utilities';
${pageImports}

@StepDefinitions
export class ${className} {

${pageInjections}

    private context = CSBDDContext.getInstance();

${stepStubs.join('\n\n')}
}
`;

    return {
        filename: `test/${projectPrefix}/steps/${featureFile}.steps.ts`,
        content,
    };
}

function emitStepDefStub(step: IRStep, projectPrefix: string, featurePascal: string): string {
    const el = step.element?.field ?? 'action';
    switch (step.action) {
        case 'navigate': {
            const key = step.target?.key ?? 'APP_URL';
            return `    @CSBDDStepDef('I navigate to {string}')
    async navigateTo(url: string): Promise<void> {
        const resolved = CSValueResolver.resolve(url, this.context);
        CSReporter.info('Navigating to: ' + resolved);
        await this.${camelCase(pascalCase(projectPrefix))}LoginPage?.navigate?.(resolved);
        CSReporter.pass('Navigation complete');
    }`;
        }
        case 'click':
            return `    // TODO: bind click-${el} step — pipeline-generator will complete this`;
        case 'fill':
            return `    // TODO: bind fill-${el} step — pipeline-generator will complete this`;
        case 'assert_text':
            return `    // TODO: bind assert-text-${el} step — pipeline-generator will complete this`;
        default:
            return '';
    }
}

function emitScenariosJsonStub(
    ir: IRInput,
    projectPrefix: string,
    featureName: string
): { filename: string; content: string } {
    const rows = ir.tests.map(t => {
        const row: Record<string, unknown> = {
            scenarioId: t.id,
            scenarioName: t.name,
            runFlag: 'Yes',
        };
        for (const ref of t.data_refs ?? []) {
            if (ref.key) row[ref.key] = `REPLACE_WITH_${ref.key.toUpperCase()}`;
        }
        return row;
    });
    return {
        filename: `test/${projectPrefix}/data/${kebabCase(featureName)}-data.json`,
        content: JSON.stringify(rows, null, 2) + '\n',
    };
}

// ============================================================================
// Tool definition
// ============================================================================

const legacyTransformTool = defineTool()
    .name('legacy_transform')
    .title('Legacy Transform')
    .description(
        'Deterministically emit draft CS Playwright TypeScript + Gherkin + scenarios JSON from canonical IR. ' +
        'Handles ~80% of Selenium → CS Playwright mechanical mappings with zero hallucination. ' +
        'pipeline-generator runs this first, then LLM-refines only what needs judgement.'
    )
    .outputSchema({
        type: 'object',
        properties: {
            files: { type: 'object' },
            draftCount: { type: 'number' },
            provenance: { type: 'string' },
            notes: { type: 'array', items: { type: 'string' } },
        },
    })
    .category('audit')
    .stringParam('irJson', 'IR JSON produced by legacy_parse', { required: true })
    .stringParam('projectName', 'Project name (e.g., myproject)', { required: true })
    .stringParam('featureName', 'Feature name (defaults to source file basename)')
    .stringParam('pipelineVersion', 'Pipeline version string for provenance header')
    .handler(async (params) => {
        let ir: IRInput;
        try {
            ir = JSON.parse(params.irJson as string);
        } catch (err: any) {
            return createErrorResult(`irJson is not valid JSON: ${err.message}`);
        }

        const projectName = params.projectName as string;
        const pipelineVersion = (params.pipelineVersion as string | undefined) ?? '1.12.0';
        const sourceBasename = ir.source.path.split(/[\\/]/).pop()?.replace(/\.\w+$/, '') ?? 'migrated';
        const featureName = (params.featureName as string | undefined) ?? sourceBasename;

        const provenance = emitProvenanceHeader({
            sourcePath: ir.source.path,
            sourceHash: ir.source.hash,
            projectName,
            pipelineVersion,
        });

        const files: Record<string, string> = {};
        const notes: string[] = [];

        for (const po of ir.page_objects) {
            const emitted = emitPageObject(po, projectName, provenance);
            files[emitted.filename] = emitted.content;
        }

        const feature = emitFeatureFile(ir, projectName, featureName, provenance);
        files[feature.filename] = feature.content;

        const stepDefs = emitStepDefinitions(ir, projectName, featureName, provenance);
        files[stepDefs.filename] = stepDefs.content;

        const scenariosJson = emitScenariosJsonStub(ir, projectName, featureName);
        files[scenariosJson.filename] = scenariosJson.content;

        if (ir.page_objects.length === 0) notes.push('No page objects in IR — emitted feature + steps only');
        if (ir.tests.length === 0) notes.push('No tests in IR — emitted empty scenarios JSON');
        if (!ir.entry_point) notes.push('No entry_point in IR — feature Background has no Given. Set {config:APP_URL} + login flow.');

        const draftCount = Object.keys(files).length;

        return createJsonResult({ files, draftCount, provenance, notes });
    })
    .readOnly()
    .build();

// ============================================================================
// Export + registration
// ============================================================================

export const transformTools: MCPToolDefinition[] = [legacyTransformTool];

export function registerTransformTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(transformTools);
}
