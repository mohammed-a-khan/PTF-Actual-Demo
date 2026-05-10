/**
 * Agentic Test Platform — BDD Translator (Rebuild M8)
 *
 * Consumes an `AnalysisReport` (from CSLegacyAnalyzer) and produces a
 * `ContentMap` of files ready to write — Gherkin feature, page object
 * TS, step-def TS, scenarios JSON. The translation is **LLM-grounded
 * deterministic-skeleton**: structural pieces (file headers, imports,
 * @CSPage / @CSGetElement / @CSBDDStepDef boilerplate, scenario tags
 * + Examples block, JSON shape) are emitted deterministically; the
 * scenario *bodies* (Gherkin Given/When/Then), step-def implementations,
 * and any unrecognised page-object methods are filled in by an LLM
 * resolver caller via the gate engine — passed in as `llmTranslate`
 * functions on the input.
 *
 * When the LLM is unavailable (no host sampling, e.g. running in a CLI
 * smoke), the translator falls back to a structurally-valid skeleton
 * with `// TODO:` markers + an analyzer-cite comment so the
 * verification step (M10) can flag low-confidence translations.
 *
 * @module agent-platform/CSBddTranslator
 */

import {
    AnalysisReport,
    PageObjectInfo,
    PageElement,
    TestAnalysis,
    LoginContract,
} from './CSLegacyAnalyzer';

// ============================================================================
// Public Types
// ============================================================================

export interface ContentMap {
    /** Map of relative output path → file content. */
    files: Record<string, string>;
    /** Per-file confidence 0..1 (1 = LLM-translated; 0 = pure skeleton with TODOs). */
    confidence: Record<string, number>;
    /** Notes the verifier should inspect. */
    notes: string[];
}

export interface TranslateOptions {
    project: string;
    module?: string;
    /**
     * Optional LLM translator. When provided, called per-scenario to
     * convert the legacy method body into Gherkin; per-method to emit
     * step-def implementations; per-page-method when the page-object
     * source is missing. When absent, the translator emits skeletons
     * with `// TODO:` markers.
     */
    llmTranslate?: LlmTranslator;
    /** Framework npm package name for imports. Default `@mdakhan.mak/cs-playwright-test-framework`. */
    frameworkPkg?: string;
}

export interface LlmTranslator {
    /** Translate one legacy test body → Gherkin lines (Given/When/Then). */
    translateScenario: (input: {
        test: TestAnalysis;
        loginContract: LoginContract;
    }) => Promise<string[]>;
    /** Translate one legacy helper method body → step-def TS body. */
    translateStepDef: (input: {
        gherkinPattern: string;
        callTreeLabel: string;
        legacyBody: string;
    }) => Promise<string>;
    /** When a page-object source is missing, generate the page TS body from element list. */
    translateMissingPage?: (input: {
        className: string;
        elements: PageElement[];
    }) => Promise<string>;
}

// ============================================================================
// CSBddTranslator
// ============================================================================

export class CSBddTranslator {
    public static async translate(
        report: AnalysisReport,
        options: TranslateOptions,
    ): Promise<ContentMap> {
        const pkg = options.frameworkPkg ?? '@mdakhan.mak/cs-playwright-test-framework';
        const map: ContentMap = { files: {}, confidence: {}, notes: [] };

        const featureRel = report.outputPlan.files.find((f) => f.kind === 'feature')?.relativePath
            ?? `test/${options.project}/features/${options.module ? options.module + '/' : ''}${report.outputPlan.feature}.feature`;
        const dataRel = report.outputPlan.files.find((f) => f.kind === 'data')?.relativePath
            ?? `test/${options.project}/data/${options.module ? options.module + '/' : ''}${report.outputPlan.feature}_scenarios.json`;
        const stepsRel = report.outputPlan.files.find((f) => f.kind === 'steps')?.relativePath
            ?? `test/${options.project}/steps/${options.module ? options.module + '/' : ''}${report.outputPlan.feature}.steps.ts`;

        // -- 1. Feature file --------------------------------------------------
        const feature = await CSBddTranslator.emitFeature(report, dataRel, options);
        map.files[featureRel] = feature.content;
        map.confidence[featureRel] = feature.confidence;

        // -- 2. Data scenarios JSON ------------------------------------------
        const data = CSBddTranslator.emitDataJson(report);
        map.files[dataRel] = data;
        map.confidence[dataRel] = 1.0; // deterministic

        // -- 3. Step definitions ---------------------------------------------
        const steps = await CSBddTranslator.emitStepDefs(report, options, pkg);
        map.files[stepsRel] = steps.content;
        map.confidence[stepsRel] = steps.confidence;
        for (const note of steps.notes) map.notes.push(note);

        // -- 4. Page objects --------------------------------------------------
        for (const po of report.pageObjects) {
            const planEntry = report.outputPlan.files.find(
                (f) => f.kind === 'page' && f.relativePath.endsWith(`${po.className}.ts`),
            );
            if (planEntry?.reuseDecision === 'reuse_existing') {
                map.notes.push(`Reusing existing page \`${po.className}.ts\` (no overwrite).`);
                continue;
            }
            const rel = planEntry?.relativePath
                ?? `test/${options.project}/pages/${options.module ? options.module + '/' : ''}${po.className}.ts`;
            const page = await CSBddTranslator.emitPageObject(po, options, pkg);
            map.files[rel] = page.content;
            map.confidence[rel] = page.confidence;
        }

        return map;
    }

    // ------------------------------------------------------------------
    // Feature emitter
    // ------------------------------------------------------------------

    private static async emitFeature(
        report: AnalysisReport,
        dataRel: string,
        options: TranslateOptions,
    ): Promise<{ content: string; confidence: number }> {
        const className = report.source.className;
        const projectTag = `@${options.project}`;
        const moduleTag = options.module ? ` @${options.module}` : '';
        const featureName = report.outputPlan.feature;

        let confidenceSum = 0;
        let confidenceCount = 0;

        const scenarioBlocks: string[] = [];
        for (const t of report.tests) {
            const scenarioId = t.suggestedScenarioId;
            const tagLine = [...t.suggestedTags, `@${scenarioId}`].join(' ').trim();
            const dataFilter = `scenarioId=${scenarioId} AND runFlag=Yes`;
            const examples = `Examples: {"type": "json", "source": "${dataRel}", "path": "$", "filter": "${dataFilter}"}`;

            // Gherkin step body — LLM if available, else skeleton with login + traced calls.
            let stepLines: string[];
            let scConfidence = 0.5;
            if (options.llmTranslate) {
                try {
                    stepLines = await options.llmTranslate.translateScenario({
                        test: t,
                        loginContract: report.loginContract,
                    });
                    scConfidence = 1.0;
                } catch {
                    stepLines = CSBddTranslator.scenarioSkeleton(t, report.loginContract);
                    scConfidence = 0.3;
                }
            } else {
                stepLines = CSBddTranslator.scenarioSkeleton(t, report.loginContract);
                scConfidence = 0.4;
            }
            confidenceSum += scConfidence;
            confidenceCount++;

            scenarioBlocks.push(
                `  ${tagLine}\n  Scenario Outline: ${t.suggestedScenarioTitle}\n${stepLines.map((l) => '    ' + l).join('\n')}\n\n  ${examples}`,
            );
        }

        const content = [
            `# Generated by CS-AI-Auto-Assist (legacy migration)`,
            `# Source: ${report.source.relativePath}`,
            ``,
            `${projectTag}${moduleTag}`,
            `Feature: ${className}`,
            `  As a user`,
            `  I want to run the migrated ${className} tests`,
            `  So that ${options.project} coverage is preserved on CS Playwright`,
            ``,
            `  Background:`,
            `    # Login is performed inside each scenario as the first When step`,
            ``,
            scenarioBlocks.join('\n\n'),
            '',
        ].join('\n');

        return {
            content,
            confidence: confidenceCount === 0 ? 0 : confidenceSum / confidenceCount,
        };
    }

    private static scenarioSkeleton(
        t: TestAnalysis,
        login: LoginContract,
    ): string[] {
        const out: string[] = [];
        // Login step always first (per project convention).
        if (login.detected && login.perRowUser) {
            out.push('When I login as "<userName>"');
        } else if (login.detected) {
            out.push('When I login with the configured credentials');
        } else {
            out.push('Given I am logged in as "<userName>"');
        }
        // Walk top-level call-tree children for human-readable step lines.
        for (const child of t.callTree.children) {
            if (child.kind === 'navigate') {
                out.push(`When I navigate to "${child.args?.[0] ?? '<URL>'}"`);
            } else if (child.kind === 'click') {
                out.push(`When I click ${CSBddTranslator.humanize(child.label)}`);
            } else if (child.kind === 'fill') {
                out.push(`When I enter "${child.args?.[0] ?? '<value>'}" into ${CSBddTranslator.humanize(child.label)}`);
            } else if (child.kind === 'assertion') {
                out.push(`Then I should see the expected outcome ${CSBddTranslator.humanize(child.label)}`);
            } else if (child.kind === 'helper' || child.kind === 'page') {
                out.push(`When I ${CSBddTranslator.humanize(child.methodName)}`);
            } else if (child.kind === 'select') {
                out.push(`When I select an option from ${CSBddTranslator.humanize(child.methodName)}`);
            } else if (child.kind === 'wait') {
                out.push(`When I wait for ${CSBddTranslator.humanize(child.methodName)}`);
            }
        }
        if (out.length === 1) {
            // Only login — append a placeholder.
            out.push(`# TODO: scenario body — analyzer found no leaf calls in ${t.methodName}`);
        }
        // Always end with at least one Then if we don't have one.
        if (!out.some((l) => l.startsWith('Then'))) {
            out.push('Then the operation should complete without errors');
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Step definitions
    // ------------------------------------------------------------------

    private static async emitStepDefs(
        report: AnalysisReport,
        options: TranslateOptions,
        pkg: string,
    ): Promise<{ content: string; confidence: number; notes: string[] }> {
        const className = `${CSBddTranslator.pascalCase(options.project)}${CSBddTranslator.pascalCase(report.outputPlan.feature)}Steps`;
        const notes: string[] = [];
        const pages = report.pageObjects.map((p) => p.className);
        const pageImports = pages
            .map(
                (p) => `import { ${p} } from '${CSBddTranslator.relativePagePath(report, p, options.module)}';`,
            )
            .join('\n');
        const pageInjections = pages
            .map(
                (p) => `    @Page('${CSBddTranslator.kebabCase(p.replace(/Page$/, ''))}')
    private ${CSBddTranslator.camelCase(p)}!: ${p};`,
            )
            .join('\n\n');

        const stepBlocks: string[] = [];
        let totalConfidence = 0;
        let stepCount = 0;
        const seenPatterns = new Set<string>();

        // One step-def method per top-level helper / page call across all tests
        // (deduplicated by suggested pattern). The Gherkin emitter chose its
        // step text already; we mirror those into @CSBDDStepDef patterns.
        for (const t of report.tests) {
            for (const child of t.callTree.children) {
                const pattern = CSBddTranslator.deriveStepPattern(child.kind, child.label, child.methodName, child.args ?? []);
                if (!pattern || seenPatterns.has(pattern)) continue;
                seenPatterns.add(pattern);
                stepCount++;

                let body: string;
                let conf: number;
                if (options.llmTranslate) {
                    try {
                        body = await options.llmTranslate.translateStepDef({
                            gherkinPattern: pattern,
                            callTreeLabel: child.label,
                            legacyBody: child.rawLine,
                        });
                        conf = 1.0;
                    } catch {
                        body = CSBddTranslator.stepDefSkeleton(child.label, child.methodName);
                        conf = 0.3;
                        notes.push(`step \`${pattern}\` — LLM call failed; used skeleton`);
                    }
                } else {
                    body = CSBddTranslator.stepDefSkeleton(child.label, child.methodName);
                    conf = 0.4;
                }
                totalConfidence += conf;

                const params = (pattern.match(/\{string\}/g) ?? []).map((_, i) => `arg${i + 1}: string`).join(', ');
                stepBlocks.push(
                    `    @CSBDDStepDef('${pattern.replace(/'/g, "\\'")}')\n    async ${CSBddTranslator.camelCase(CSBddTranslator.slug(pattern))}(${params}): Promise<void> {\n${body}\n    }`,
                );
            }
        }

        const content = [
            `// Generated by CS-AI-Auto-Assist (legacy migration)`,
            `// Source: ${report.source.relativePath}`,
            ``,
            `import { CSBDDStepDef, Page, StepDefinitions } from '${pkg}/bdd';`,
            `import { CSReporter } from '${pkg}/reporter';`,
            `import { CSValueResolver } from '${pkg}/utilities';`,
            pageImports,
            ``,
            `@StepDefinitions`,
            `export class ${className} {`,
            ``,
            pageInjections || '    // no page-object injections inferred',
            ``,
            stepBlocks.join('\n\n'),
            `}`,
            '',
        ].filter((l) => l !== undefined).join('\n');

        return {
            content,
            confidence: stepCount === 0 ? 0.5 : totalConfidence / stepCount,
            notes,
        };
    }

    private static stepDefSkeleton(label: string, methodName: string): string {
        return [
            `        CSReporter.info('${label.replace(/'/g, "\\'")}');`,
            `        // TODO: implement — legacy method ${methodName}`,
            `        throw new Error('Step not yet implemented');`,
        ].join('\n');
    }

    private static deriveStepPattern(
        kind: string,
        label: string,
        methodName: string,
        args: string[],
    ): string | null {
        if (kind === 'navigate') return `I navigate to {string}`;
        if (kind === 'click') return `I click ${CSBddTranslator.humanize(label)}`;
        if (kind === 'fill') return `I enter {string} into ${CSBddTranslator.humanize(label)}`;
        if (kind === 'select') return `I select an option from ${CSBddTranslator.humanize(methodName)}`;
        if (kind === 'wait') return `I wait for ${CSBddTranslator.humanize(methodName)}`;
        if (kind === 'assertion') return null;
        if (kind === 'helper' || kind === 'page') return `I ${CSBddTranslator.humanize(methodName)}`;
        return null;
    }

    // ------------------------------------------------------------------
    // Page object emitter
    // ------------------------------------------------------------------

    private static async emitPageObject(
        po: PageObjectInfo,
        options: TranslateOptions,
        pkg: string,
    ): Promise<{ content: string; confidence: number }> {
        if (!po.sourcePath && options.llmTranslate?.translateMissingPage) {
            try {
                const body = await options.llmTranslate.translateMissingPage({
                    className: po.className,
                    elements: po.elements,
                });
                return { content: body, confidence: 1.0 };
            } catch {
                // Fall through to skeleton.
            }
        }

        const fields = po.elements.map((el) => {
            const xpath = el.locatorType === 'xpath' ? el.locatorValue : `//*[@${el.locatorType === 'unknown' ? 'id' : el.locatorType}="${el.locatorValue}"]`;
            const alts = el.locatorType !== 'xpath' && el.locatorType !== 'unknown'
                ? `, alternativeLocators: ['${el.locatorType}:${el.locatorValue}']`
                : '';
            return `    @CSGetElement({ xpath: '${xpath.replace(/'/g, "\\'")}', description: '${el.fieldName} (${el.locatorType})'${alts} })\n    public ${el.fieldName}!: CSWebElement;`;
        }).join('\n\n');

        const methods = (po.publicMethods ?? []).map((m) => {
            return `    public async ${m}(): Promise<void> {\n        // TODO: implement — public method from legacy ${po.className}\n        throw new Error('Method not yet migrated');\n    }`;
        }).join('\n\n');

        const pageId = CSBddTranslator.kebabCase(po.className.replace(/Page$/, ''));
        const content = [
            `// Generated by CS-AI-Auto-Assist (legacy migration)`,
            ``,
            `import { CSBasePage, CSPage, CSGetElement } from '${pkg}/core';`,
            `import { CSWebElement } from '${pkg}/element';`,
            `import { CSReporter } from '${pkg}/reporter';`,
            ``,
            `@CSPage('${pageId}')`,
            `export class ${po.className} extends CSBasePage {`,
            ``,
            fields || '    // no @FindBy elements found in legacy source',
            ``,
            `    protected initializeElements(): void {`,
            `        CSReporter.debug('${po.className} elements initialized');`,
            `    }`,
            ``,
            methods,
            `}`,
            ``,
            `export default ${po.className};`,
            '',
        ].filter((l) => l !== undefined).join('\n');

        return { content, confidence: 0.6 };
    }

    // ------------------------------------------------------------------
    // Data JSON emitter
    // ------------------------------------------------------------------

    private static emitDataJson(report: AnalysisReport): string {
        const rows: Array<Record<string, string>> = [];
        for (const t of report.tests) {
            const row: Record<string, string> = {
                scenarioId: t.suggestedScenarioId,
                scenarioName: t.suggestedScenarioTitle,
                runFlag: 'Yes',
            };
            // If the test has data refs, attach the first sample row's keys
            // so downstream Gherkin <placeholders> resolve.
            const dr = report.dataReferences.find((d) => t.dataRefs.includes(d.resolvedPath ?? ''));
            if (dr && dr.sample && dr.sample.kind === 'rows' && dr.sample.rows[0]) {
                for (const [k, v] of Object.entries(dr.sample.rows[0])) {
                    if (k.toLowerCase() === 'runflag') continue;
                    if (!(k in row)) row[k] = v;
                }
            }
            rows.push(row);
        }
        return JSON.stringify(rows, null, 2) + '\n';
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private static relativePagePath(report: AnalysisReport, pageClass: string, module?: string): string {
        const planEntry = report.outputPlan.files.find(
            (f) => f.kind === 'page' && f.relativePath.endsWith(`${pageClass}.ts`),
        );
        if (planEntry) {
            // Strip the `test/<project>/steps/<module>/...` prefix to get a `../../pages/<module>/<class>` form.
            const stepsRel = report.outputPlan.files.find((f) => f.kind === 'steps')?.relativePath ?? '';
            const stepsParts = stepsRel.split('/');
            const stepsDir = stepsParts.slice(0, -1).join('/');
            const pageParts = planEntry.relativePath.split('/');
            const pageDir = pageParts.slice(0, -1).join('/');
            const pageBasename = pageParts[pageParts.length - 1].replace(/\.ts$/, '');
            // Compute relative path from steps dir to pages dir.
            const stepsTokens = stepsDir.split('/');
            const pageTokens = pageDir.split('/');
            let i = 0;
            while (i < stepsTokens.length && i < pageTokens.length && stepsTokens[i] === pageTokens[i]) i++;
            const ups = stepsTokens.length - i;
            const downs = pageTokens.slice(i).join('/');
            const rel = `${'../'.repeat(ups)}${downs ? downs + '/' : ''}${pageBasename}`;
            return rel;
        }
        return `../pages/${module ? module + '/' : ''}${pageClass}`;
    }

    private static humanize(s: string): string {
        return s
            .replace(/[()"]/g, '')
            .replace(/\./g, ' ')
            .replace(/_/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    private static pascalCase(s: string): string {
        return s
            .replace(/[^a-zA-Z0-9]+/g, ' ')
            .split(' ')
            .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
            .join('');
    }

    private static camelCase(s: string): string {
        const p = CSBddTranslator.pascalCase(s);
        return p.charAt(0).toLowerCase() + p.slice(1);
    }

    private static kebabCase(s: string): string {
        return s
            .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .toLowerCase()
            .replace(/^-+|-+$/g, '');
    }

    private static slug(s: string): string {
        return s.replace(/\{string\}/g, 'arg').replace(/[^a-zA-Z0-9]+/g, ' ').trim();
    }
}
