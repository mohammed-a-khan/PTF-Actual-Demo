/**
 * Agentic Test Platform — Feature File Composer
 *
 * Composes the `.feature` file from a list of parsed test cases plus their
 * Gherkin translations. Each test case becomes one Scenario Outline with a
 * `@TC_<id>` tag and (when scaffolded) a `@needs-source-validation` tag.
 *
 * The Examples block points to a JSON fixture under
 * `data/{env}/<module>/<feature>_scenarios.json` so the framework's
 * data-source loader can pick the right env file at runtime.
 *
 * Privacy-by-design: all examples and tags use generic placeholders.
 *
 * @module agent-platform/CSFeatureFileComposer
 */

import * as path from 'path';
import { MCPToolContext } from '../types/CSMCPTypes';
import { ParsedTestCase } from './CSAdoTestCaseParser';
import { GherkinTranslation } from './CSStepToGherkinTranslator';

// ============================================================================
// Public Types
// ============================================================================

/**
 * The composed `.feature` artefact, ready to write to disk.
 */
export interface FeatureFileArtifact {
    filePath: string;
    content: string;
    scenarios: { id: string; title: string; tcId?: number; tags: string[] }[];
    needsSourceValidation: boolean;
}

// ============================================================================
// CSFeatureFileComposer
// ============================================================================

/**
 * Static composer. Single public entry point: `compose`.
 */
export class CSFeatureFileComposer {
    /**
     * Compose a feature file for the supplied test cases / translations.
     *
     * @param moduleName  Module name (lowercased to a tag).
     * @param featureName Feature name (lowercased to a tag).
     * @param testCases   Parsed test cases (1:1 with translations).
     * @param translations Gherkin translations (1:1 with testCases).
     * @param context     MCP tool context (used only for logging).
     */
    public static async compose(
        moduleName: string,
        featureName: string,
        testCases: ParsedTestCase[],
        translations: GherkinTranslation[],
        context: MCPToolContext,
    ): Promise<FeatureFileArtifact> {
        if (testCases.length !== translations.length) {
            throw new Error(
                `CSFeatureFileComposer: testCases.length (${testCases.length}) ` +
                    `must equal translations.length (${translations.length})`,
            );
        }

        const moduleSlug = CSFeatureFileComposer.slugify(moduleName);
        const featureSlug = CSFeatureFileComposer.slugify(featureName);
        const featureTitle = CSFeatureFileComposer.pascal(featureName);
        const moduleTitle = CSFeatureFileComposer.pascal(moduleName);

        const dataSource = `test/<project>/data/{env}/${moduleSlug}/${featureSlug}_scenarios.json`;

        // Compute which scenarios need source-validation. A scenario is
        // flagged when its translation contains a placeholder with no
        // matching example value or when any test case lacks steps.
        const scenarioFlags = testCases.map((tc, i) => {
            const tr = translations[i];
            if (!tr) return false;
            const hasSteps =
                tr.given.length + tr.when.length + tr.then.length > 0;
            return !hasSteps || tc.steps.length === 0;
        });
        const anyNeeds = scenarioFlags.some((b) => b);

        const featureTags = [
            `@${moduleSlug}`,
            `@${featureSlug}`,
        ];

        const lines: string[] = [];
        lines.push(featureTags.join(' '));
        lines.push(`Feature: ${moduleTitle} - ${featureTitle}`);
        const description =
            testCases[0]?.title?.trim() ||
            'Auto-generated feature backed by ADO test cases.';
        lines.push(`  ${description}`);
        lines.push('');

        const scenarios: FeatureFileArtifact['scenarios'] = [];

        for (let i = 0; i < testCases.length; i++) {
            const tc = testCases[i];
            const tr = translations[i];
            const tcTag = `@TC_${tc.testCaseId}`;
            const priorityTag = tc.priority
                ? `@priority-${tc.priority}`
                : '';
            const validationTag = scenarioFlags[i]
                ? '@needs-source-validation'
                : '';

            const tags = [
                tcTag,
                priorityTag,
                validationTag,
                ...tc.tags.map((t) => `@${CSFeatureFileComposer.slugify(t)}`),
            ].filter((t) => t.length > 0);

            const scenarioId = `TS_${tc.testCaseId}`;
            const scenarioTitle = tc.title || `Scenario ${tc.testCaseId}`;

            lines.push(`  ${tags.join(' ')}`);
            lines.push(`  Scenario Outline: ${scenarioId} - ${scenarioTitle}`);

            CSFeatureFileComposer.appendBucket(lines, 'Given', tr.given);
            CSFeatureFileComposer.appendBucket(lines, 'When', tr.when);
            CSFeatureFileComposer.appendBucket(lines, 'Then', tr.then);

            const placeholders = [
                'scenarioId',
                'scenarioName',
                'userName',
                'runFlag',
                ...tr.examplePlaceholders,
            ];
            const examplesJson =
                `{"type":"json", ` +
                `"source":"${dataSource}", ` +
                `"filter":"runFlag=Yes AND scenarioId=${scenarioId}"}`;
            lines.push(`    Examples: ${examplesJson}`);
            lines.push(`      | ${placeholders.join(' | ')} |`);
            lines.push('');

            scenarios.push({
                id: scenarioId,
                title: scenarioTitle,
                tcId: tc.testCaseId,
                tags,
            });
        }

        const filePath = path.posix.join(
            'features',
            moduleSlug,
            `${featureSlug}.feature`,
        );

        context.log('debug', 'CSFeatureFileComposer: composed', {
            scenarioCount: scenarios.length,
            anyNeeds,
        });

        return {
            filePath,
            content: lines.join('\n'),
            scenarios,
            needsSourceValidation: anyNeeds,
        };
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    /**
     * Append a list of step phrases into the feature output. The first
     * step in the bucket gets the bucket keyword (Given/When/Then); the
     * rest become "And ...".
     */
    private static appendBucket(
        lines: string[],
        keyword: 'Given' | 'When' | 'Then',
        steps: string[],
    ): void {
        if (steps.length === 0) return;
        lines.push(`    ${keyword} ${steps[0]}`);
        for (let i = 1; i < steps.length; i++) {
            lines.push(`    And ${steps[i]}`);
        }
    }

    private static pascal(s: string): string {
        return s
            .replace(/[^A-Za-z0-9]+/g, ' ')
            .trim()
            .split(/\s+/)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('');
    }

    private static slugify(s: string): string {
        return s
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase();
    }
}
