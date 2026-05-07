/**
 * Agentic Test Platform — Step Definition Composer
 *
 * Generates step-definition class source matching the Gherkin scenarios.
 * Page-object methods produced by `CSPageObjectComposer` become the
 * implementation body of the step definitions.
 *
 * The composer attempts to discover existing step definitions via the
 * `bdd_list_step_definitions` MCP tool so it can avoid emitting redundant
 * phrases. When the tool is unavailable or fails, it falls back to
 * generating fresh definitions for every translated step.
 *
 * Privacy-by-design: no domain or organization references; placeholders
 * such as `<MODULE>`, `<USER>`, `<TC_ID>` are used in any user-facing text.
 *
 * @module agent-platform/CSStepDefComposer
 */

import * as path from 'path';
import { MCPToolContext, MCPToolDefinition } from '../types/CSMCPTypes';
import { bddTools } from '../tools/bdd/CSMCPBDDTools';
import { GherkinTranslation } from './CSStepToGherkinTranslator';
import { PageObjectArtifact } from './CSPageObjectComposer';

// ============================================================================
// Public Types
// ============================================================================

/**
 * One generated step-definition artefact.
 */
export interface StepDefArtifact {
    filePath: string;
    content: string;
    stepDefinitions: {
        phrase: string;
        method: string;
        pageObjectMethod: string;
    }[];
}

// ============================================================================
// Internal: existing-step lookup
// ============================================================================

interface ExistingStep {
    pattern: string;
}

// ============================================================================
// CSStepDefComposer
// ============================================================================

/**
 * Static composer. Single public entry point: `compose`.
 */
export class CSStepDefComposer {
    /**
     * Generate the step-definition source for one Gherkin translation.
     *
     * @param moduleName  Module name (used in the generated class name).
     * @param featureName Feature name (used in the generated class name).
     * @param translation Gherkin translation produced upstream.
     * @param pageObjects Page objects whose methods we delegate to.
     * @param context     MCP tool context (used for logging + step lookup).
     */
    public static async compose(
        moduleName: string,
        featureName: string,
        translation: GherkinTranslation,
        pageObjects: PageObjectArtifact[],
        context: MCPToolContext,
    ): Promise<StepDefArtifact> {
        const className = `${CSStepDefComposer.pascal(moduleName)}${CSStepDefComposer.pascal(featureName)}Steps`;
        const moduleSlug = CSStepDefComposer.slugify(moduleName);

        // Best-effort lookup of existing step phrases so we don't emit
        // duplicates. Failures are non-fatal.
        let existing: ExistingStep[] = [];
        try {
            existing = await CSStepDefComposer.fetchExistingSteps(context);
        } catch (err) {
            context.log(
                'debug',
                'CSStepDefComposer: existing-step lookup failed; proceeding anyway',
                { error: err instanceof Error ? err.message : String(err) },
            );
        }

        const allSteps = [
            ...translation.given.map((s) => ({ s, kind: 'Given' as const })),
            ...translation.when.map((s) => ({ s, kind: 'When' as const })),
            ...translation.then.map((s) => ({ s, kind: 'Then' as const })),
        ];

        const stepDefinitions: StepDefArtifact['stepDefinitions'] = [];
        const seen = new Set<string>();

        for (const { s, kind } of allSteps) {
            const phrase = CSStepDefComposer.toPhrase(s);
            if (CSStepDefComposer.matchesExisting(phrase, existing)) {
                continue;
            }
            if (seen.has(phrase)) continue;
            seen.add(phrase);

            const pageMethod = CSStepDefComposer.findPageObjectMethod(
                s,
                pageObjects,
            );
            const methodName = CSStepDefComposer.methodName(kind, phrase);

            stepDefinitions.push({
                phrase,
                method: methodName,
                pageObjectMethod: pageMethod
                    ? `${pageMethod.className}.${pageMethod.methodName}`
                    : '',
            });
        }

        // -- Render the file --------------------------------------------------
        const pageImports = pageObjects.map(
            (p) =>
                `import { ${p.className} } from '../../pages/${moduleSlug}/${p.className}';`,
        );

        const pageInstances = pageObjects
            .map(
                (p) =>
                    `@Page('${moduleSlug}-${CSStepDefComposer.slugify(p.className.replace(/Page$/, ''))}') private ${CSStepDefComposer.camel(p.className)}!: ${p.className};`,
            )
            .join('\n    ');

        const stepBlocks = stepDefinitions
            .map((d) => {
                const callParams = CSStepDefComposer.callParams(d.phrase);
                const pageMethod = CSStepDefComposer.findPageObjectMethodByPhrase(
                    d.phrase,
                    pageObjects,
                );
                const body = pageMethod
                    ? `await this.${CSStepDefComposer.camel(pageMethod.className)}.${pageMethod.methodName}(${callParams.bodyArgs});`
                    : `// @needs-source-validation: no matching page-object method generated\n        // TODO: implement step body for: ${d.phrase}`;
                return (
                    `    @CSBDDStepDef('${CSStepDefComposer.escTs(d.phrase)}')\n` +
                    `    public async ${d.method}(${callParams.signature}): Promise<void> {\n` +
                    `        ${body}\n` +
                    `    }`
                );
            })
            .join('\n\n');

        const content =
            `import { StepDefinitions, CSBDDStepDef, Page } from '@mdakhan.mak/cs-playwright-test-framework/bdd';\n` +
            `${pageImports.join('\n')}\n\n` +
            `@StepDefinitions\n` +
            `export class ${className} {\n` +
            `    ${pageInstances}\n\n` +
            `${stepBlocks}\n` +
            `}\n`;

        const filePath = path.posix.join(
            'steps',
            moduleSlug,
            `${className}.ts`,
        );

        context.log('debug', 'CSStepDefComposer: composed', {
            className,
            stepCount: stepDefinitions.length,
        });

        return {
            filePath,
            content,
            stepDefinitions,
        };
    }

    // ========================================================================
    // Existing-step discovery
    // ========================================================================

    /**
     * Invoke `bdd_list_step_definitions` to fetch the project's current
     * step library. Returns an empty list if the tool is not available.
     */
    private static async fetchExistingSteps(
        context: MCPToolContext,
    ): Promise<ExistingStep[]> {
        const def = (bddTools as MCPToolDefinition[]).find(
            (d) => d.tool.name === 'bdd_list_step_definitions',
        );
        if (!def) return [];
        const result = await def.handler({}, context);
        if (result.isError) return [];
        const sc = result.structuredContent as
            | { steps?: { pattern?: string }[]; stepDefinitions?: { pattern?: string }[] }
            | undefined;
        const list = sc?.steps ?? sc?.stepDefinitions ?? [];
        return list
            .map((s) => ({ pattern: String(s.pattern ?? '') }))
            .filter((s) => s.pattern.length > 0);
    }

    /**
     * Returns true iff `phrase` is structurally covered by an existing step
     * pattern. Uses a loose normalised-text match — we only avoid exact
     * duplicates, not ambiguous overlaps.
     */
    private static matchesExisting(
        phrase: string,
        existing: ExistingStep[],
    ): boolean {
        const norm = CSStepDefComposer.normalize(phrase);
        for (const e of existing) {
            if (CSStepDefComposer.normalize(e.pattern) === norm) return true;
        }
        return false;
    }

    private static normalize(s: string): string {
        return s
            .toLowerCase()
            .replace(/<[^>]+>/g, '<param>')
            .replace(/\{[^}]+\}/g, '<param>')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ========================================================================
    // Phrase / method-name helpers
    // ========================================================================

    /**
     * Convert a Gherkin step body (with `<placeholder>` tokens) into the
     * pattern form used by `@CSBDDStepDef`. Each `<x>` becomes `{string}`.
     */
    private static toPhrase(step: string): string {
        return step.replace(/<[^>]+>/g, '{string}');
    }

    /**
     * Compute the parameter signature and body-args for a step pattern.
     * Each `{string}` becomes `arg0: string, arg1: string, ...`.
     */
    private static callParams(phrase: string): {
        signature: string;
        bodyArgs: string;
    } {
        const matches = phrase.match(/\{string\}/g) ?? [];
        const names = matches.map((_, i) => `arg${i}`);
        const signature = names.map((n) => `${n}: string`).join(', ');
        const bodyArgs = names.join(', ');
        return { signature, bodyArgs };
    }

    /**
     * Pick a stable, unique method name for a step phrase.
     */
    private static methodName(kind: 'Given' | 'When' | 'Then', phrase: string): string {
        const base = CSStepDefComposer.camel(phrase.replace(/\{string\}/g, 'param'));
        return `${kind.toLowerCase()}${CSStepDefComposer.pascal(base)}`;
    }

    /**
     * Find the page-object method most likely to implement a Gherkin step.
     * Returns `{ className, methodName }` or null.
     */
    private static findPageObjectMethod(
        step: string,
        pageObjects: PageObjectArtifact[],
    ):
        | { className: string; methodName: string }
        | null {
        for (const p of pageObjects) {
            for (const m of p.methods) {
                if (
                    step
                        .toLowerCase()
                        .includes(m.name.replace(/([A-Z])/g, ' $1').toLowerCase().trim())
                ) {
                    return { className: p.className, methodName: m.name };
                }
            }
        }
        return null;
    }

    private static findPageObjectMethodByPhrase(
        phrase: string,
        pageObjects: PageObjectArtifact[],
    ):
        | { className: string; methodName: string }
        | null {
        return CSStepDefComposer.findPageObjectMethod(
            phrase.replace(/\{string\}/g, ''),
            pageObjects,
        );
    }

    // ========================================================================
    // Naming helpers
    // ========================================================================

    private static pascal(s: string): string {
        return s
            .replace(/[^A-Za-z0-9]+/g, ' ')
            .trim()
            .split(/\s+/)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('');
    }

    private static camel(s: string): string {
        const p = CSStepDefComposer.pascal(s);
        return p.charAt(0).toLowerCase() + p.slice(1);
    }

    private static slugify(s: string): string {
        return s
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase();
    }

    private static escTs(s: string): string {
        return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }
}
