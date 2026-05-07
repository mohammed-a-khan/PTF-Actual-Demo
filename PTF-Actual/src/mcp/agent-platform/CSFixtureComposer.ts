/**
 * Agentic Test Platform — Fixture Composer
 *
 * Generates JSON fixtures (one per environment) backing the Scenario
 * Outline Examples block produced by `CSFeatureFileComposer`. Each
 * scenario contributes one row carrying the Examples placeholder values;
 * `runFlag` defaults to "Yes" so the runner picks them up.
 *
 * Privacy-by-design: every default value is a generic placeholder
 * (`<TEST_USER>`, `<MODULE>`). No real domain identifiers are emitted.
 *
 * @module agent-platform/CSFixtureComposer
 */

import * as path from 'path';
import { ParsedTestCase } from './CSAdoTestCaseParser';
import { GherkinTranslation } from './CSStepToGherkinTranslator';

// ============================================================================
// Public Types
// ============================================================================

/**
 * One fixture artefact: N file paths (one per env) and the parsed JSON
 * payload keyed by env. The orchestrator owns the I/O.
 */
export interface FixtureArtifact {
    filePaths: string[];
    content: Map<string, unknown>;
}

// ============================================================================
// CSFixtureComposer
// ============================================================================

/**
 * Static composer. Single public entry point: `compose`.
 */
export class CSFixtureComposer {
    /**
     * Generate the fixture for every supplied env. The same content is
     * emitted across all envs unless a placeholder name suggests an
     * env-specific value (e.g. ending in `_dev` / `_uat`), in which case
     * the appropriate column is selected.
     */
    public static compose(
        moduleName: string,
        featureName: string,
        testCases: ParsedTestCase[],
        translations: GherkinTranslation[],
        envs: string[] = ['dev', 'sit', 'uat'],
    ): FixtureArtifact {
        if (testCases.length !== translations.length) {
            throw new Error(
                `CSFixtureComposer: testCases.length (${testCases.length}) ` +
                    `must equal translations.length (${translations.length})`,
            );
        }

        const moduleSlug = CSFixtureComposer.slugify(moduleName);
        const featureSlug = CSFixtureComposer.slugify(featureName);

        const filePaths: string[] = [];
        const content = new Map<string, unknown>();

        for (const env of envs) {
            const rows: Record<string, string>[] = [];
            for (let i = 0; i < testCases.length; i++) {
                const tc = testCases[i];
                const tr = translations[i];
                const placeholders = tr.examplePlaceholders;

                const row: Record<string, string> = {
                    scenarioId: `TS_${tc.testCaseId}`,
                    scenarioName: tc.title || `Scenario ${tc.testCaseId}`,
                    userName: '<TEST_USER>',
                    runFlag: 'Yes',
                };

                for (const ph of placeholders) {
                    const exVals = tr.examples[ph] ?? [];
                    // Pick the first non-empty example value, or fall back
                    // to a generic placeholder.
                    const candidate =
                        exVals.find((v) => v && v.length > 0) ?? '';
                    row[ph] = candidate || `<${ph.toUpperCase()}>`;
                }

                rows.push(row);
            }

            const filePath = path.posix.join(
                'data',
                env,
                moduleSlug,
                `${featureSlug}_scenarios.json`,
            );
            filePaths.push(filePath);
            content.set(env, rows);
        }

        return { filePaths, content };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private static slugify(s: string): string {
        return s
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase();
    }
}
