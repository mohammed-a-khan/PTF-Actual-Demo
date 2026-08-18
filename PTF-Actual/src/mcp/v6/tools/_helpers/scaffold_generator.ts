/**
 * scaffold_generator — turn a parsed ADO Test Case (title, steps, data,
 * optional DOM elements) into the four core artifact strings the consumer
 * framework expects:
 *
 *   1. Page Object (.ts)  — @CSPage + @CSGetElement per identified field
 *   2. Feature file (.feature) — one Scenario per ADO action row + @TestCaseId
 *   3. Steps class (.steps.ts) — @StepDefinitions with a method per unique step
 *   4. Data JSON — one Examples row (matches feature's <placeholders>)
 *
 * Plus environment placeholders (only when the target uat.env is missing
 * BASE_URL / LOGIN_URL — never overwrite existing keys).
 *
 * Framework import paths that consumer projects use:
 *   @mdakhan.mak/cs-playwright-test-framework/core     (CSBasePage, CSPage, CSGetElement)
 *   @mdakhan.mak/cs-playwright-test-framework/element  (CSWebElement)
 *   @mdakhan.mak/cs-playwright-test-framework/reporting (CSReporter)
 *   @mdakhan.mak/cs-playwright-test-framework/bdd      (CSBDDStepDef, Page, StepDefinitions)
 *
 * NOTE: this file MUST NOT hardcode any project-specific slug. The slug is
 * always an input.
 */

import type { ActionStep } from './tc_steps_parser';
import type { ExtractedElement } from './dom_parser';
import { buildDecoratorBlock, toCamelPropertyName } from './dom_parser';

// -----------------------------------------------------------------------
// Naming helpers.
// -----------------------------------------------------------------------

const TITLE_PREFIX_STRIP = /^(verify|test|should|validate|check|assert|ensure|confirm|automate)\s+/i;
const NON_ALPHA_NUM = /[^a-zA-Z0-9\s]/g;

export function derivePascalName(rawTitle: string, suffix: 'Page' | ''): string {
    let t = String(rawTitle || '').trim();
    // Strip common test title prefixes; keep repeating until none match.
    while (TITLE_PREFIX_STRIP.test(t)) t = t.replace(TITLE_PREFIX_STRIP, '');
    // Convert punctuation to spaces
    t = t.replace(NON_ALPHA_NUM, ' ');
    const parts = t.split(/\s+/).filter(Boolean).slice(0, 6);
    if (parts.length === 0) return `Untitled${suffix}`;
    const pascal = parts
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join('');
    // Cap to avoid absurd file names
    const capped = pascal.length > 60 ? pascal.slice(0, 60) : pascal;
    if (suffix && !capped.endsWith(suffix)) return capped + suffix;
    return capped;
}

/** Turn a scenario / step description into a slug for file names. */
export function toSlug(input: string): string {
    return String(input || '')
        .toLowerCase()
        .replace(NON_ALPHA_NUM, ' ')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 80) || 'untitled';
}

/** Turn a step's `action` text into an idempotent method name. Ensures uniqueness across steps by suffixing when collisions occur. */
export function stepToMethodName(action: string, existing: Set<string>): string {
    let base = action.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    if (!base) base = 'step';
    const words = base.split(/\s+/).slice(0, 6);
    let name = words[0].toLowerCase();
    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        name += w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }
    if (/^[0-9]/.test(name)) name = 'step' + name.charAt(0).toUpperCase() + name.slice(1);
    if (name.length > 50) name = name.slice(0, 50);
    let candidate = name;
    let n = 2;
    while (existing.has(candidate)) {
        candidate = name + n;
        n++;
    }
    existing.add(candidate);
    return candidate;
}

// -----------------------------------------------------------------------
// Test-Case + DOM → element list. When DOM elements were extracted we use
// them verbatim (property name derived from description). When not, we
// scan the ADO action text for verbs that imply a UI element ("enter …
// as", "click …", "select …") and synthesise placeholder locators.
// -----------------------------------------------------------------------

export interface SynthesisedElement {
    propertyName: string;
    decoratorBlock: string;
    /** True when the locator came from DOM inspection; false when synthesised from step text. */
    fromLiveDom: boolean;
}

const FIELD_VERB_RE = /\b(?:enter|fill|type|input|set)\s+(?:the\s+)?"?([A-Za-z][A-Za-z0-9 _-]{2,40})"?\s+(?:as|with|to|=)/i;
const CLICK_VERB_RE = /\b(?:click|press|tap|choose|select)\s+(?:the\s+|on\s+the\s+|on\s+)?"?([A-Za-z][A-Za-z0-9 _-]{2,40})"?\b/i;

function synthesiseFromSteps(steps: ActionStep[], selfHeal: boolean): SynthesisedElement[] {
    const seen = new Set<string>();
    const out: SynthesisedElement[] = [];
    for (const s of steps) {
        const field = FIELD_VERB_RE.exec(s.action);
        if (field) {
            const raw = field[1].trim();
            const propName = toCamelPropertyName(raw + ' field', 'input');
            if (seen.has(propName)) continue;
            seen.add(propName);
            const guessedName = toSlug(raw).replace(/-/g, '');
            const block = [
                `    @CSGetElement({`,
                `        xpath: '//input[@name="${guessedName}"] | //input[@id="${guessedName}"] | //input[@placeholder="${raw}"]',`,
                `        description: '${raw} field',`,
                `        waitForVisible: true,`,
                `        selfHeal: ${selfHeal},`,
                `        alternativeLocators: ['css:input[name="${guessedName}"]', 'placeholder:${raw}'],`,
                `    })`,
                `    public ${propName}!: CSWebElement;`,
            ].join('\n');
            out.push({ propertyName: propName, decoratorBlock: block, fromLiveDom: false });
            continue;
        }
        const btn = CLICK_VERB_RE.exec(s.action);
        if (btn) {
            const raw = btn[1].trim();
            const propName = toCamelPropertyName(raw + ' button', 'button');
            if (seen.has(propName)) continue;
            seen.add(propName);
            const block = [
                `    @CSGetElement({`,
                `        xpath: '//button[normalize-space(.)="${raw}"] | //a[normalize-space(.)="${raw}"] | //*[@role="button" and normalize-space(.)="${raw}"]',`,
                `        description: '${raw} action',`,
                `        waitForVisible: true,`,
                `        selfHeal: ${selfHeal},`,
                `        alternativeLocators: ['role=button[name="${raw}"]', 'text:${raw}'],`,
                `    })`,
                `    public ${propName}!: CSWebElement;`,
            ].join('\n');
            out.push({ propertyName: propName, decoratorBlock: block, fromLiveDom: false });
        }
    }
    return out;
}

function elementsFromDom(elements: ExtractedElement[], selfHeal: boolean, maxElements: number): SynthesisedElement[] {
    const seen = new Set<string>();
    const out: SynthesisedElement[] = [];
    for (const el of elements.slice(0, maxElements)) {
        const propName = toCamelPropertyName(el.description || `${el.tag} element`, el.tag);
        if (seen.has(propName)) continue;
        seen.add(propName);
        const block = buildDecoratorBlock(el, propName, { selfHeal });
        out.push({ propertyName: propName, decoratorBlock: block, fromLiveDom: true });
    }
    return out;
}

// -----------------------------------------------------------------------
// Artifact builders.
// -----------------------------------------------------------------------

export interface ScaffoldInput {
    testCaseId?: number;
    testCaseTitle: string;
    slug: string;                    // project slug — matches folder under test/<slug>
    pageName: string;                // e.g. "AddEmployeePage"
    pagePath: string;                // e.g. "test/<slug>/pages/<subdir>/AddEmployeePage.ts"
    featureFolderRel: string;        // e.g. "test/<slug>/features/story-425"
    featureFileName: string;         // e.g. "add-employee.feature"
    stepsClassName: string;          // e.g. "AddEmployeeSteps"
    stepsFileName: string;           // e.g. "AddEmployeeSteps.steps.ts"
    dataFileRel: string;             // e.g. "test/<slug>/data/uat/story-425/scenarios.json"
    baseUrl?: string;
    /** Tags to attach at feature level, e.g. @story-425 */
    featureTags: string[];
    /** Tags to attach at scenario level, includes @TestCaseId:<n> */
    scenarioTags: string[];
    steps: ActionStep[];
    /** Rows for the Examples JSON. When empty the tool creates a single-row {"scenarioId":"ac1"}. */
    dataRows: Array<Record<string, string>>;
    /** Elements to seed the page-object with. Optional — synthesis will run if empty. */
    domElements?: ExtractedElement[];
    /** True when we intend the @CSGetElement selfHeal flag on. Defaults true. */
    selfHeal?: boolean;
    /** Cap on decorated elements in the page object (default 12). */
    maxElements?: number;
}

const CS_FRAMEWORK_CORE = "@mdakhan.mak/cs-playwright-test-framework/core";
const CS_FRAMEWORK_ELEMENT = "@mdakhan.mak/cs-playwright-test-framework/element";
const CS_FRAMEWORK_REPORTING = "@mdakhan.mak/cs-playwright-test-framework/reporting";
const CS_FRAMEWORK_BDD = "@mdakhan.mak/cs-playwright-test-framework/bdd";

export interface ArtifactStrings {
    pageObject: string;
    feature: string;
    steps: string;
    data: string;
    /** Env file additions (KEY=VALUE lines); empty when nothing needs adding. */
    envAdditions: string;
    /** Which env keys were emitted. */
    envKeysAdded: string[];
    /** How the page object was populated ('live-dom' | 'step-verb-synthesis' | 'both'). */
    elementSource: 'live-dom' | 'step-verb-synthesis' | 'both' | 'empty';
    /** Property names of every element added to the page object. */
    elementPropertyNames: string[];
}

export function buildArtifacts(input: ScaffoldInput): ArtifactStrings {
    const selfHeal = input.selfHeal !== false;
    const maxElements = input.maxElements ?? 12;

    const domSynth = input.domElements && input.domElements.length > 0
        ? elementsFromDom(input.domElements, selfHeal, maxElements)
        : [];
    const stepSynth = synthesiseFromSteps(input.steps, selfHeal);

    // Merge: dedupe by propertyName; DOM wins.
    const takenNames = new Set(domSynth.map((d) => d.propertyName));
    const filteredStepSynth = stepSynth.filter((s) => !takenNames.has(s.propertyName));
    const merged: SynthesisedElement[] = [...domSynth, ...filteredStepSynth].slice(0, maxElements);
    const elementSource: ArtifactStrings['elementSource'] =
        domSynth.length > 0 && filteredStepSynth.length > 0 ? 'both' :
        domSynth.length > 0 ? 'live-dom' :
        filteredStepSynth.length > 0 ? 'step-verb-synthesis' : 'empty';

    const pageObject = buildPageObjectSource({
        pageName: input.pageName,
        slug: input.slug,
        testCaseId: input.testCaseId,
        title: input.testCaseTitle,
        elements: merged,
    });

    const feature = buildFeatureSource(input);
    const steps = buildStepsSource(input, merged);
    const data = buildDataSource(input);
    const envKeys: string[] = [];
    const envAdditions = buildEnvAdditions(input, envKeys);

    return {
        pageObject, feature, steps, data,
        envAdditions, envKeysAdded: envKeys,
        elementSource,
        elementPropertyNames: merged.map((m) => m.propertyName),
    };
}

function buildPageObjectSource(args: { pageName: string; slug: string; testCaseId?: number; title: string; elements: SynthesisedElement[] }): string {
    const csPageSlug = args.pageName.replace(/Page$/, '').split(/(?=[A-Z])/).join('-').toLowerCase();
    const decorators = args.elements.length > 0
        ? args.elements.map((e) => e.decoratorBlock).join('\n\n')
        : `    // Locators — none identified. Populate manually or re-run cs_qa_ui_scaffold with generateLive:true after providing a reachable baseUrl.`;
    const lines: string[] = [];
    lines.push(`import { CSBasePage, CSPage, CSGetElement } from '${CS_FRAMEWORK_CORE}';`);
    lines.push(`import { CSWebElement } from '${CS_FRAMEWORK_ELEMENT}';`);
    lines.push(`import { CSReporter } from '${CS_FRAMEWORK_REPORTING}';`);
    lines.push(``);
    lines.push(`@CSPage('${csPageSlug}')`);
    lines.push(`export class ${args.pageName} extends CSBasePage {`);
    lines.push(decorators);
    lines.push(``);
    lines.push(`    protected initializeElements(): void {`);
    lines.push(`        CSReporter.debug('${args.pageName} elements initialized');`);
    lines.push(`    }`);
    lines.push(``);
    lines.push(`    public async navigate(): Promise<void> {`);
    lines.push(`        await super.navigate(this.config.get('BASE_URL'));`);
    lines.push(`    }`);
    lines.push(`}`);
    lines.push(``);
    return lines.join('\n');
}

function tagList(tags: string[]): string {
    return tags.filter(Boolean).join(' ');
}

function buildFeatureSource(input: ScaffoldInput): string {
    const featTags = tagList(input.featureTags);
    const scenTags = tagList(input.scenarioTags);
    const lines: string[] = [];
    if (featTags) lines.push(featTags);
    lines.push(`Feature: ${input.testCaseTitle}`);
    lines.push(``);
    if (scenTags) lines.push(`  ${scenTags}`);
    lines.push(`  Scenario: ${input.testCaseTitle}`);
    if (input.steps.length === 0) {
        lines.push(`    When I open the ${input.pageName}`);
        lines.push(`    Then the ${input.pageName} loads without error`);
    } else {
        // Cucumber semantic: first step Given / When based on verb; subsequent are And.
        for (let i = 0; i < input.steps.length; i++) {
            const s = input.steps[i];
            const keyword = i === 0 ? (/(navigate|open|log ?in|visit|browse|precondition)/i.test(s.action) ? 'Given' : 'When') : 'And';
            lines.push(`    ${keyword} ${s.action}`);
            if (s.expected) {
                lines.push(`    Then ${s.expected}`);
            }
        }
    }
    lines.push(``);
    return lines.join('\n');
}

function buildStepsSource(input: ScaffoldInput, elements: SynthesisedElement[]): string {
    const pageFieldName = input.pageName.charAt(0).toLowerCase() + input.pageName.slice(1);
    const csPageSlug = input.pageName.replace(/Page$/, '').split(/(?=[A-Z])/).join('-').toLowerCase();
    const importPath = './' + input.pageName;
    const relImport = ('../pages/' + basenameWithoutExt(input.pagePath, '.ts')).replace(/\\/g, '/');
    void importPath;

    const stepMethods: string[] = [];
    const usedMethodNames = new Set<string>();
    const usedStepTexts = new Set<string>();

    const emitStep = (stepText: string, isAssertion: boolean): void => {
        const norm = stepText.trim();
        if (!norm) return;
        if (usedStepTexts.has(norm)) return; // dedupe identical steps
        usedStepTexts.add(norm);
        const method = stepToMethodName(norm, usedMethodNames);
        const escaped = norm.replace(/'/g, "\\'");
        if (isAssertion) {
            stepMethods.push(
                `    @CSBDDStepDef('${escaped}')\n` +
                `    public async ${method}(): Promise<void> {\n` +
                `        // Assertion generated from ADO Test Case expected result.\n` +
                `        // TODO: implement an explicit assertion against ${pageFieldName}.\n` +
                `    }`,
            );
        } else {
            const firstMatchedField = elements.find((e) => norm.toLowerCase().includes(e.propertyName.toLowerCase()));
            const bodyAction = firstMatchedField
                ? `        await this.${pageFieldName}.${firstMatchedField.propertyName}.waitForVisible(10000);\n` +
                  `        // TODO: replace with a specific interaction on ${firstMatchedField.propertyName} (click, fill, select, ...)`
                : `        // TODO: implement action for: ${escaped}`;
            stepMethods.push(
                `    @CSBDDStepDef('${escaped}')\n` +
                `    public async ${method}(): Promise<void> {\n` +
                `        await this.${pageFieldName}.navigate();\n` +
                bodyAction + '\n' +
                `    }`,
            );
        }
    };
    if (input.steps.length === 0) {
        emitStep(`I open the ${input.pageName}`, false);
        emitStep(`the ${input.pageName} loads without error`, true);
    } else {
        for (const s of input.steps) {
            emitStep(s.action, false);
            if (s.expected) emitStep(s.expected, true);
        }
    }

    const lines: string[] = [];
    lines.push(`import { CSBDDStepDef, Page, StepDefinitions } from '${CS_FRAMEWORK_BDD}';`);
    lines.push(`import { ${input.pageName} } from '${relImport.startsWith('..') ? relImport : './' + input.pageName}';`);
    lines.push(``);
    lines.push(`@StepDefinitions`);
    lines.push(`export class ${input.stepsClassName} {`);
    lines.push(`    @Page('${csPageSlug}') private ${pageFieldName}!: ${input.pageName};`);
    lines.push(``);
    lines.push(stepMethods.join('\n\n'));
    lines.push(`}`);
    lines.push(``);
    return lines.join('\n');
}

function basenameWithoutExt(p: string, ext: string): string {
    const parts = p.replace(/\\/g, '/').split('/');
    const bn = parts[parts.length - 1];
    return bn.endsWith(ext) ? bn.slice(0, -ext.length) : bn;
}

function buildDataSource(input: ScaffoldInput): string {
    if (input.dataRows.length > 0) return JSON.stringify(input.dataRows, null, 2) + '\n';
    // Emit a single default row keyed by scenarioId.
    const row: Record<string, string> = { scenarioId: 'ac1' };
    // Add any inferred fields from steps (enter X as Y)
    for (const s of input.steps) {
        const m = FIELD_VERB_RE.exec(s.action);
        if (m) {
            const key = toSlug(m[1]).replace(/-/g, '');
            if (!(key in row)) row[key] = '';
        }
    }
    return JSON.stringify([row], null, 2) + '\n';
}

function buildEnvAdditions(input: ScaffoldInput, keysCollected: string[]): string {
    const lines: string[] = [];
    if (input.baseUrl && !isPlaceholder(input.baseUrl)) {
        lines.push(`BASE_URL=${input.baseUrl}`);
        keysCollected.push('BASE_URL');
        // Only emit a LOGIN_URL when the base looks like an auth-gated login page.
        if (/\/(login|auth|sign[-_]?in)/i.test(input.baseUrl)) {
            lines.push(`LOGIN_URL=${input.baseUrl}`);
            keysCollected.push('LOGIN_URL');
        }
    } else {
        lines.push(`# BASE_URL=https://<your-app-host>`);
        lines.push(`# LOGIN_URL=https://<your-app-host>/login`);
    }
    return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function isPlaceholder(u: string): boolean {
    return /<[a-z]|placeholder|example\.(com|org)|your-app/i.test(u);
}
