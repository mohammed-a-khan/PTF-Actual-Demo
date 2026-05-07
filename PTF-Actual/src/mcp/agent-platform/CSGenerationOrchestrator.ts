/**
 * Agentic Test Platform — Generation Orchestrator
 *
 * Composes the Phase 2A pipeline:
 *
 *   1. CSSourceGrounder.ground(...) on the user-provided source path
 *   2. CSStepToGherkinTranslator.translate(...) per parsed test case
 *   3. CSPageObjectComposer.compose(...) per inferred page object
 *   4. CSStepDefComposer.compose(...) per page object
 *   5. CSFeatureFileComposer.compose(...) for the whole feature
 *   6. CSFixtureComposer.compose(...) × N envs
 *   7. Write all artefacts to disk
 *
 * Telemetry: emits `info`-level progress notifications at each step;
 * respects the supplied `CSCostTelemetry` budget (the orchestrator does not
 * itself spend tokens, but downstream sampling calls do).
 *
 * Privacy: the orchestrator never sends file content over LLM sampling
 * without first running it through `CSPiiSanitizer.sanitize`.
 *
 * @module agent-platform/CSGenerationOrchestrator
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext } from '../types/CSMCPTypes';
import { ParsedTestCase } from './CSAdoTestCaseParser';
import {
    CSSourceGrounder,
    SourceGroundingMap,
} from './CSSourceGrounder';
import {
    CSStepToGherkinTranslator,
    GherkinTranslation,
} from './CSStepToGherkinTranslator';
import {
    CSPageObjectComposer,
    PageObjectArtifact,
} from './CSPageObjectComposer';
import {
    CSStepDefComposer,
    StepDefArtifact,
} from './CSStepDefComposer';
import {
    CSFeatureFileComposer,
    FeatureFileArtifact,
} from './CSFeatureFileComposer';
import {
    CSFixtureComposer,
    FixtureArtifact,
} from './CSFixtureComposer';
import { CSCostTelemetry } from './CSCostTelemetry';

// ============================================================================
// Public Types
// ============================================================================

/**
 * Inputs to one orchestration run.
 */
export interface GenerationOrchestratorInput {
    mode: 'ado_test_case_id' | 'ado_test_suite_id' | 'ado_test_plan_id';
    testCases: ParsedTestCase[];
    moduleName: string;
    featureName: string;
    appSourcePath?: string;
    envs: string[];
    outputRoot: string;
    /**
     * Optional telemetry instance threaded through from the master tool.
     * The orchestrator only consults it via `checkBudget()` between steps.
     */
    telemetry?: CSCostTelemetry;
}

/**
 * Aggregate result. `filesCreated` lists every file written to disk
 * (relative to `outputRoot`) so the caller can hand them to the execution
 * gate / commit-ready check. `testCases` and `translations` are exposed in
 * 1:1 order so downstream consumers (e.g. the ADO create-back flow) can
 * reconstruct the per-scenario step list for a Steps XML round-trip.
 */
export interface GenerationResult {
    testCases: ParsedTestCase[];
    translations: GherkinTranslation[];
    pageObjects: PageObjectArtifact[];
    stepDefs: StepDefArtifact[];
    featureFile: FeatureFileArtifact;
    fixtures: FixtureArtifact;
    filesCreated: string[];
    needsSourceValidation: boolean;
    warnings: string[];
    /**
     * When the mode handler ran a fresh delegate call (cache miss), it sets
     * this so the master tool can persist the verified-green output to
     * `.agent-runs/cache/<key>/` after the heal loop confirms green. Unset
     * on cache hit (already in the cache) and for modes that don't cache
     * (chat, ado).
     */
    cacheKey?: string;
    /**
     * Map of relative-path → content the cache should store. Distinct from
     * `filesCreated` (absolute paths under outputRoot) because the cache
     * tool uses workspace-relative keys.
     */
    cacheableFiles?: Record<string, string>;
    /** Filled when the result came from a cache hit (informational). */
    cacheHit?: { cachedAt: string };
}

// ============================================================================
// CSGenerationOrchestrator
// ============================================================================

/**
 * Static orchestrator. Single public entry point: `orchestrate`.
 */
export class CSGenerationOrchestrator {
    /**
     * Run the full generation pipeline against the supplied input.
     */
    public static async orchestrate(
        input: GenerationOrchestratorInput,
        context: MCPToolContext,
    ): Promise<GenerationResult> {
        const warnings: string[] = [];

        if (input.testCases.length === 0) {
            warnings.push(
                'orchestrate: empty testCases list; emitting an empty feature scaffold',
            );
        }

        // -- Step 1: source grounding ---------------------------------------
        CSGenerationOrchestrator.checkpoint(input, 'source-grounding', context);
        const hints = CSGenerationOrchestrator.collectHints(input.testCases);
        const grounding: SourceGroundingMap = await CSSourceGrounder.ground(
            input.appSourcePath ?? '',
            hints,
            context,
        );

        // -- Step 2: per-test-case translation ------------------------------
        CSGenerationOrchestrator.checkpoint(input, 'translate-steps', context);
        const translations: GherkinTranslation[] = [];
        for (const tc of input.testCases) {
            const tr = await CSStepToGherkinTranslator.translate(
                tc,
                grounding,
                context,
            );
            translations.push(tr);
            if (
                input.telemetry &&
                !input.telemetry.checkBudget().withinBudget
            ) {
                warnings.push('orchestrate: budget exhausted during translation');
                break;
            }
        }

        // -- Step 3: page-object composition --------------------------------
        CSGenerationOrchestrator.checkpoint(input, 'compose-pages', context);
        const pageGroups = CSGenerationOrchestrator.groupTranslationsByPage(
            input.testCases,
            translations,
        );
        const pageObjects: PageObjectArtifact[] = [];
        for (const [pageName, group] of pageGroups) {
            const merged = CSGenerationOrchestrator.mergeTranslations(group);
            const po = await CSPageObjectComposer.compose(
                input.moduleName,
                pageName,
                merged,
                grounding,
                context,
            );
            pageObjects.push(po);
        }

        // -- Step 4: step-definition composition ----------------------------
        CSGenerationOrchestrator.checkpoint(input, 'compose-steps', context);
        const mergedAll = CSGenerationOrchestrator.mergeTranslations(translations);
        const stepDefArtifact = await CSStepDefComposer.compose(
            input.moduleName,
            input.featureName,
            mergedAll,
            pageObjects,
            context,
        );
        const stepDefs: StepDefArtifact[] = [stepDefArtifact];

        // -- Step 5: feature file -------------------------------------------
        CSGenerationOrchestrator.checkpoint(input, 'compose-feature', context);
        const featureFile = await CSFeatureFileComposer.compose(
            input.moduleName,
            input.featureName,
            input.testCases,
            translations,
            context,
        );

        // -- Step 6: fixtures -----------------------------------------------
        CSGenerationOrchestrator.checkpoint(input, 'compose-fixtures', context);
        const fixtures = CSFixtureComposer.compose(
            input.moduleName,
            input.featureName,
            input.testCases,
            translations,
            input.envs,
        );

        // -- Step 7: write to disk ------------------------------------------
        CSGenerationOrchestrator.checkpoint(input, 'write', context);
        const filesCreated: string[] = [];
        try {
            for (const po of pageObjects) {
                const full = path.join(input.outputRoot, po.filePath);
                CSGenerationOrchestrator.writeFile(full, po.content);
                filesCreated.push(full);
            }
            for (const sd of stepDefs) {
                const full = path.join(input.outputRoot, sd.filePath);
                CSGenerationOrchestrator.writeFile(full, sd.content);
                filesCreated.push(full);
            }
            const featureFull = path.join(input.outputRoot, featureFile.filePath);
            CSGenerationOrchestrator.writeFile(featureFull, featureFile.content);
            filesCreated.push(featureFull);

            for (let i = 0; i < input.envs.length; i++) {
                const env = input.envs[i];
                const fp = fixtures.filePaths[i];
                if (!fp) continue;
                const full = path.join(input.outputRoot, fp);
                const data = fixtures.content.get(env);
                CSGenerationOrchestrator.writeFile(
                    full,
                    JSON.stringify(data ?? [], null, 2),
                );
                filesCreated.push(full);
            }
        } catch (err) {
            warnings.push(
                `orchestrate: write failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }

        const needsSourceValidation =
            featureFile.needsSourceValidation ||
            pageObjects.some((p) => p.needsSourceValidation);

        context.log('info', 'CSGenerationOrchestrator: complete', {
            filesCreated: filesCreated.length,
            pageObjects: pageObjects.length,
            stepDefs: stepDefs.length,
            scenarios: featureFile.scenarios.length,
            needsSourceValidation,
            warnings: warnings.length,
        });

        return {
            testCases: input.testCases,
            translations,
            pageObjects,
            stepDefs,
            featureFile,
            fixtures,
            filesCreated,
            needsSourceValidation,
            warnings,
        };
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    /**
     * Pull element/message hint candidates from every parsed step. We pass
     * these to the source grounder so it can prioritise files that mention
     * them.
     */
    private static collectHints(testCases: ParsedTestCase[]): string[] {
        const out = new Set<string>();
        for (const tc of testCases) {
            for (const s of tc.steps) {
                for (const m of (s.action ?? '').match(/"([^"]{1,60})"/g) ?? []) {
                    out.add(m.replace(/"/g, ''));
                }
                for (const m of (s.action ?? '').match(/\b[A-Za-z][A-Za-z ]{2,30}\b/g) ?? []) {
                    if (m.length >= 4) out.add(m.trim());
                }
            }
        }
        return Array.from(out);
    }

    /**
     * Group translations by inferred page object name. Phase 2A uses a
     * simple rule: every test case maps to one page named after its
     * module's primary feature. Phase 2B will replace this with semantic
     * clustering.
     */
    private static groupTranslationsByPage(
        testCases: ParsedTestCase[],
        translations: GherkinTranslation[],
    ): Map<string, GherkinTranslation[]> {
        const groups = new Map<string, GherkinTranslation[]>();
        for (let i = 0; i < testCases.length; i++) {
            const tc = testCases[i];
            const tr = translations[i];
            if (!tr) continue;
            const page = CSGenerationOrchestrator.inferPageName(tc);
            const list = groups.get(page) ?? [];
            list.push(tr);
            groups.set(page, list);
        }
        // Guarantee at least one page so the composer does not generate
        // zero artefacts.
        if (groups.size === 0) {
            groups.set('Main', []);
        }
        return groups;
    }

    /**
     * Pick a page name for a test case. Heuristic: extract the first word
     * before "Page" / "screen" in the title; fall back to the first noun.
     */
    private static inferPageName(tc: ParsedTestCase): string {
        const title = tc.title ?? '';
        const m = title.match(/\b([A-Z][A-Za-z0-9]{1,30})\s+(?:Page|Screen|Form|View)\b/);
        if (m) return m[1];
        const first = title.match(/\b([A-Z][A-Za-z0-9]{2,30})\b/);
        if (first) return first[1];
        return 'Main';
    }

    /**
     * Merge a list of translations into a single one for the page-object
     * composer. Concatenates each bucket and de-dupes adjacent duplicates.
     */
    private static mergeTranslations(
        list: GherkinTranslation[],
    ): GherkinTranslation {
        const merged: GherkinTranslation = {
            background: [],
            given: [],
            when: [],
            then: [],
            examples: {},
            examplePlaceholders: [],
        };
        for (const t of list) {
            for (const g of t.given) {
                if (merged.given[merged.given.length - 1] !== g) merged.given.push(g);
            }
            for (const w of t.when) {
                if (merged.when[merged.when.length - 1] !== w) merged.when.push(w);
            }
            for (const th of t.then) {
                if (merged.then[merged.then.length - 1] !== th) merged.then.push(th);
            }
            for (const ph of t.examplePlaceholders) {
                if (!merged.examplePlaceholders.includes(ph)) {
                    merged.examplePlaceholders.push(ph);
                }
            }
            for (const [k, v] of Object.entries(t.examples)) {
                if (!merged.examples[k]) merged.examples[k] = [];
                merged.examples[k].push(...v);
            }
        }
        return merged;
    }

    /**
     * Write a file, creating intermediate directories on the way.
     */
    private static writeFile(filePath: string, content: string): void {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
    }

    /**
     * Emit a checkpoint notification + log line for a pipeline stage.
     */
    private static checkpoint(
        input: GenerationOrchestratorInput,
        stage: string,
        context: MCPToolContext,
    ): void {
        context.log('info', `CSGenerationOrchestrator: ${stage}`, {
            mode: input.mode,
            module: input.moduleName,
            feature: input.featureName,
            envs: input.envs.length,
        });
        try {
            context.notify({
                method: 'notifications/progress',
                params: { stage, mode: input.mode },
            });
        } catch {
            // notify is best-effort.
        }
    }
}
