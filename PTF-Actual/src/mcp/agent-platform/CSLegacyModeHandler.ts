/**
 * Agentic Test Platform — Legacy Test Migration Mode Handler
 *
 * Drives the `legacy_test_code` mode. The platform's role here is purely
 * orchestration + safety harness: we delegate the semantic translation
 * (Selenium / QAF / TestNG → CS Playwright TS) to the host LLM via
 * `CSCopilotDelegate`. We do NOT re-implement source-code understanding.
 *
 * Pipeline:
 *   1. legacy_parse        Cheap structural facts (test method names,
 *                          imported page-object class names, source hash).
 *                          The LLM uses these as grounding so generated
 *                          names match the legacy code 1:1.
 *   2. Read sibling files  Page-object Java files referenced by imports
 *                          ride along in the prompt — the LLM needs them
 *                          for `@FindBy` element extraction.
 *   3. CSCopilotDelegate   Single LLM call producing the full TS file map.
 *   4. write to disk       Output lands under `outputRoot`.
 *   5. (downstream)        The master tool runs CSHealLoop on the output.
 *
 * Privacy-by-design: source content runs through `CSPiiSanitizer.redact`
 * inside the delegate before going over the wire. No consumer-specific
 * patterns live in this file.
 *
 * @module agent-platform/CSLegacyModeHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { parseTools } from '../tools/parsers/CSMCPParseTools';
import { pipelineTools } from '../tools/pipeline/CSMCPPipelineTools';
import { generationTools } from '../tools/generation/CSMCPGenerationTools';
import { transformTools } from '../tools/transform/CSMCPTransformTools';
import { CSCopilotDelegate } from './CSCopilotDelegate';
import { CSMigrationCache } from './CSMigrationCache';
import { CSRepoInventory } from './CSRepoInventory';
import { CSTestDataMigrator, MigratedTestData } from './CSTestDataMigrator';
import { CSCostTelemetry } from './CSCostTelemetry';
import { GenerationResult } from './CSGenerationOrchestrator';
import { ParsedTestCase } from './CSAdoTestCaseParser';
import { GherkinTranslation } from './CSStepToGherkinTranslator';
import { ClassifiedInput } from './types';

// ============================================================================
// Public Types
// ============================================================================

export interface LegacyModeHandlerOptions {
    projectName?: string;
    featureName?: string;
    /**
     * Optional module name. When provided, output files are grouped under
     * a module subdirectory at every artefact root. Without it, files
     * land flat under each artefact root.
     *
     *   With moduleName='administration':
     *     test/<project>/features/administration/<feature>.feature
     *     test/<project>/pages/administration/<Page>.ts
     *     test/<project>/steps/administration/<feature>.steps.ts
     *     test/<project>/data/administration/<feature>-data.json
     *
     *   Without moduleName:
     *     test/<project>/features/<feature>.feature
     *     test/<project>/pages/<Page>.ts
     *     test/<project>/steps/<feature>.steps.ts
     *     test/<project>/data/<feature>-data.json
     */
    moduleName?: string;
    /**
     * Workspace root where output files land. Defaults to `process.cwd()`.
     * The handler writes:
     *   <workspaceRoot>/config/<project>/{global.env, common/common.env, environments/<env>.env}
     *   <workspaceRoot>/test/<project>/{features, pages, steps, data}
     * Use this instead of the legacy `outputRoot`.
     */
    workspaceRoot?: string;
    /** Where to look for legacy source dependencies. Defaults to dir containing input file. */
    projectRoot?: string;
    /** Comma list of envs for the config scaffold. Default: dev,sit,uat. */
    environments?: string[];
    /** Skip the discover_dependencies pre-flight when true (dangerous). */
    skipDependencyCheck?: boolean;
    /** Skip the generate_config_scaffold step when true. */
    skipConfigScaffold?: boolean;
    /** Legacy alias for workspaceRoot — kept for backward compatibility. */
    outputRoot?: string;
    /**
     * Allow the handler to overwrite files that already exist in the
     * repo. Default `false` — the handler runs CSRepoInventory first
     * and skips any generated file whose path is already present.
     * The skip list comes back in `delegateNotes` so the user knows
     * what was preserved. Set to `true` only when you explicitly want
     * to regenerate from scratch.
     */
    overwriteExisting?: boolean;
    telemetry?: CSCostTelemetry;
}

export interface LegacyModeHandlerResult {
    generationResult: GenerationResult | null;
    sourceFile?: string;
    irHash?: string;
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
    /** Notes the LLM surfaced (assumptions, partial migrations). */
    delegateNotes?: string[];
}

// ============================================================================
// Internal IR shape (subset of legacy_parse output we consume)
// ============================================================================

interface LegacyIR {
    source: { path: string; language: string; test_runner: string; hash: string };
    tests: Array<{ id: string; name: string; tags?: string[] }>;
    page_objects: unknown[];
    summary: { test_count: number; parse_confidence: string };
}

// ============================================================================
// CSLegacyModeHandler
// ============================================================================

export class CSLegacyModeHandler {
    private static readonly DEFAULT_OUTPUT_ROOT = path.join('generated', 'legacy');
    /** Stamped in cache-key material; bump when prompts / conventions change. */
    private static readonly PIPELINE_VERSION = '1.21.0';

    public static async handle(
        classified: ClassifiedInput,
        options: LegacyModeHandlerOptions,
        context: MCPToolContext,
    ): Promise<LegacyModeHandlerResult> {
        const ef = classified.extractedFields;
        const sourceFile = ef.path;
        if (!sourceFile) {
            return {
                generationResult: null,
                blockedReason:
                    "supply the legacy source file path. Re-invoke `cs_ai_auto_assist` with `path: <absolute or workspace-relative path to the .java/.kt file>` in the input string.",
            };
        }
        const absSource = path.isAbsolute(sourceFile)
            ? sourceFile
            : path.resolve(process.cwd(), sourceFile);
        if (!fs.existsSync(absSource)) {
            return {
                generationResult: null,
                blockedReason: `correct the source file path and re-invoke. The supplied path resolved to ${absSource} which does not exist on disk.`,
            };
        }

        const projectName = options.projectName || ef.projectName || 'common';
        const featureName =
            options.featureName ||
            ef.featureName ||
            CSLegacyModeHandler.deriveFeatureName(absSource);
        // moduleName: opt-in. When set, the LLM emits paths grouped under
        // test/<project>/<artefact>/<moduleName>/... so a 50-file migration
        // produces module-organised directories instead of one flat tree.
        const moduleName = (options.moduleName || ef.moduleName || '').trim() || undefined;
        // workspaceRoot replaces the old outputRoot semantics. Files now land
        // at <workspaceRoot>/config/<project>/ and <workspaceRoot>/test/<project>/
        // — the framework's standard layout.
        const workspaceRoot = path.resolve(
            options.workspaceRoot || options.outputRoot || process.cwd(),
        );
        const projectRoot = path.resolve(
            options.projectRoot || CSLegacyModeHandler.deriveProjectRoot(absSource),
        );
        const environments = options.environments && options.environments.length > 0
            ? options.environments
            : ['dev', 'sit', 'uat'];

        // -- Step 1: discover_dependencies pre-flight ----------------------
        // If the source has unresolved imports (helpers, base test cases,
        // data-bean classes, etc.) we surface a structured warning listing
        // each missing symbol. Originally this BLOCKED migration — but in
        // practice users running migrations from a host that doesn't have
        // the full legacy repo cloned at the right path get a "100 deps
        // missing" block they can't easily resolve, and the platform falls
        // back to inline freelancing. Now: only block when projectRoot was
        // explicitly supplied AND the user opted in via skipDependencyCheck=false.
        // Default behaviour is to migrate with whatever's available and surface
        // the missing deps as a non-fatal warning the user can act on later.
        const projectRootExplicit = !!(options.projectRoot || ef.projectRoot);
        const skipDeps =
            options.skipDependencyCheck === true ||
            !projectRootExplicit;
        if (!skipDeps) {
            const depsRaw = await CSLegacyModeHandler.invokeTool(
                pipelineTools,
                'discover_dependencies',
                { file: absSource, projectRoot },
                context,
            );
            if (!depsRaw.isError) {
                const deps = CSLegacyModeHandler.parseTextJson(depsRaw) as
                    | { complete: boolean; missing: number; references: Array<Record<string, unknown>> }
                    | null;
                if (deps && deps.complete === false && deps.missing > 0) {
                    const missingRefs = deps.references.filter(
                        (r) => (r as { found?: boolean }).found !== true,
                    );
                    return {
                        generationResult: null,
                        sourceFile: absSource,
                        blockedReason: `${deps.missing} dependency reference(s) in ${path.basename(absSource)} need resolution before migration can run. Pick an option from \`blockedDetails.options\` and re-invoke with that resolution applied.`,
                        blockedDetails: {
                            projectRoot,
                            missingCount: deps.missing,
                            missing: missingRefs,
                            options: [
                                'paste — add the missing files into projectRoot, then re-invoke',
                                'skip — re-invoke with skipDependencyCheck=true (Copilot will guess; expect lower trust score)',
                                'abort — fix the underlying file, then retry',
                                'change projectRoot — re-invoke with projectRoot pointing at the right tree',
                            ],
                        },
                    };
                }
            }
        }

        // -- Step 1.5: legacy_parse → IR -----------------------------------
        const irRaw = await CSLegacyModeHandler.invokeTool(
            parseTools,
            'legacy_parse',
            { file: absSource },
            context,
        );
        if (irRaw.isError) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason: 'the legacy parser could not extract structure from the source file. Inspect the detail in `blockedDetails.detail`, fix the parse error in the source, then re-invoke.',
                blockedDetails: { detail: CSLegacyModeHandler.firstText(irRaw) },
            };
        }
        const irJson = CSLegacyModeHandler.firstText(irRaw);
        const ir = CSLegacyModeHandler.parseIr(irJson);
        const irHash = ir?.source?.hash;

        // -- Step 2: cache lookup -------------------------------------------
        // Probe the framework's migration cache. On hit we replay the stored
        // file map verbatim and skip the Copilot call. The downstream heal
        // loop still verifies the cached output compiles and runs in the
        // current environment.
        const cacheLookup = await CSMigrationCache.lookup(
            {
                sourceFile: absSource,
                projectName,
                pipelineVersion: CSLegacyModeHandler.PIPELINE_VERSION,
                extras: moduleName ? `moduleName=${moduleName}` : undefined,
            },
            context,
        );

        let outputFiles: Record<string, string>;
        let delegateNotes: string[] = [];
        let cacheHitInfo: { cachedAt: string } | undefined;
        let cacheKeyForStore: string | undefined;

        if (cacheLookup.hit && cacheLookup.files) {
            context.log('info', `CSLegacyModeHandler: cache hit (cachedAt=${cacheLookup.cachedAt}) — skipping Copilot delegate`);
            outputFiles = cacheLookup.files;
            cacheHitInfo = cacheLookup.cachedAt
                ? { cachedAt: cacheLookup.cachedAt }
                : undefined;
        } else {
            // Cache miss — run the deterministic transformer.
            //
            // Sampling-based delegate (CSCopilotDelegate) is dead in
            // Copilot deployments — the host LLM does not implement
            // `sampling/createMessage`, so every delegate call returned
            // an empty file map and the handler short-circuited to a
            // BLOCKED state. The replacement is `legacy_transform`,
            // which deterministically emits ~80% of the file set from
            // the IR (page objects, feature, steps, scenarios JSON
            // stub) using ts-morph templates — no LLM call required.
            //
            // The remaining ~20% (custom waits, complex assertions,
            // ambiguous element bindings) ships as inline `// TODO`
            // markers and `REPLACE_WITH_*` placeholders. The 9-gate
            // commit-ready audit fails on those, which surfaces them
            // to the user for resolution. A future LLM-augmented pass
            // (Phase 6+) can fill them in automatically.
            const transformRaw = await CSLegacyModeHandler.invokeTool(
                transformTools,
                'legacy_transform',
                {
                    irJson,
                    projectName,
                    featureName,
                    pipelineVersion: CSLegacyModeHandler.PIPELINE_VERSION,
                },
                context,
            );
            if (transformRaw.isError) {
                return {
                    generationResult: null,
                    sourceFile: absSource,
                    irHash,
                    blockedReason:
                        'the deterministic transformer could not produce a draft from the IR. Inspect `blockedDetails.detail`, then re-invoke after correcting the upstream IR or source.',
                    blockedDetails: {
                        detail: CSLegacyModeHandler.firstText(transformRaw),
                    },
                };
            }
            let transformResult: {
                files: Record<string, string>;
                notes?: string[];
            };
            try {
                transformResult = JSON.parse(
                    CSLegacyModeHandler.firstText(transformRaw),
                );
            } catch (err) {
                return {
                    generationResult: null,
                    sourceFile: absSource,
                    irHash,
                    blockedReason:
                        'the transformer returned non-JSON output. Re-invoke once — transient parser errors usually clear.',
                    blockedDetails: {
                        error: err instanceof Error ? err.message : String(err),
                    },
                };
            }
            outputFiles = transformResult.files;
            delegateNotes = transformResult.notes ?? [];

            // Overlay real test-data rows from XLS / CSV onto the
            // scenarios JSON stub the transformer emitted. Without
            // this, the data file ships with REPLACE_WITH_* placeholders
            // and DF002 audit fails. Reading the source again is cheap;
            // file existence already validated above.
            const mainContent = fs.readFileSync(absSource, 'utf-8');
            const migratedData = await CSTestDataMigrator.migrate(
                absSource,
                mainContent,
                context,
            );
            if (migratedData.rows.length > 0) {
                const dataKey = Object.keys(outputFiles).find((k) =>
                    k.endsWith('-data.json'),
                );
                if (dataKey) {
                    outputFiles[dataKey] = CSLegacyModeHandler.overlayDataRows(
                        outputFiles[dataKey],
                        migratedData.rows,
                    );
                    delegateNotes.push(
                        `Overlaid ${migratedData.rows.length} real test-data row(s) onto scenarios JSON stub`,
                    );
                }
            }

            // Stamp the cache key on the result so the master tool can
            // call CSMigrationCache.store after the heal loop confirms green.
            cacheKeyForStore = cacheLookup.cacheKey || undefined;
        }

        // -- Step 2.5: generate config scaffold ----------------------------
        // Creates <workspaceRoot>/config/<project>/{global.env,
        // common/common.env, environments/<env>.env}. Idempotent (safe to
        // re-run). Skipped on cache hit since the user has already accepted
        // the previous run's config.
        let configFiles: string[] = [];
        if (!options.skipConfigScaffold && !cacheHitInfo) {
            configFiles = await CSLegacyModeHandler.generateConfigScaffold(
                projectName,
                environments,
                workspaceRoot,
                context,
            );
        }

        // -- Step 2.7: gap-fill — skip files that already exist -----------
        // Run a repo inventory and drop any generated file whose target
        // path is already on disk. This protects user customisations
        // and prior-run output from silent overwrite. The delegateNotes
        // array carries one entry per skipped file so the user can see
        // exactly what was preserved.
        //
        // Bypass this guard with `overwriteExisting: true` when you
        // explicitly want fresh output (e.g. after a framework version
        // bump where every page object should be regenerated).
        if (!options.overwriteExisting) {
            const inventory = CSRepoInventory.inventory(projectName, {
                module: moduleName,
                workspaceRoot,
            });
            const existingPaths = new Set<string>([
                ...inventory.pages.map((p) => p.relativePath),
                ...inventory.steps.map((s) => s.relativePath),
                ...inventory.features.map((f) => f.relativePath),
                ...inventory.dataFiles.map((d) => d.relativePath),
                ...inventory.configFiles.map((c) => c.relativePath),
            ]);
            const filteredFiles: Record<string, string> = {};
            const skipped: string[] = [];
            for (const [relPath, content] of Object.entries(outputFiles)) {
                const norm = relPath.replace(/\\/g, '/');
                if (existingPaths.has(norm)) {
                    skipped.push(norm);
                } else {
                    filteredFiles[relPath] = content;
                }
            }
            if (skipped.length > 0) {
                delegateNotes.push(
                    `Preserved ${skipped.length} existing file(s) (gap-fill mode — pass overwriteExisting=true to regenerate): ${skipped.join(', ')}`,
                );
            }
            outputFiles = filteredFiles;
            // NOTE: an empty filteredFiles is a legitimate outcome — every
            // generated artefact already exists. Surface as a non-failure
            // result; the master tool will still run the audit + heal
            // loop against the existing files.
        }

        // -- Step 3: write the file map -------------------------------------
        // Files map keys are workspace-relative paths from the LLM (e.g.
        // "test/<project>/features/<feature>.feature"). Resolving against
        // workspaceRoot puts them at the framework's canonical layout.
        const filesCreated = CSCopilotDelegate.writeFiles(outputFiles, workspaceRoot);
        // Empty-write is fine when gap-fill skipped everything — only
        // block if generation produced nothing AND nothing existed.
        if (filesCreated.length === 0 && Object.keys(outputFiles).length === 0 && !options.overwriteExisting) {
            // Gap-fill said: every artefact already exists. Emit a
            // synthetic "files preserved" note and let the audit + heal
            // loop run against the on-disk files via the empty-output
            // path (no new generation result needed).
            delegateNotes.push('All generated artefacts already exist; ran in pure gap-fill / verify mode.');
        } else if (filesCreated.length === 0) {
            return {
                generationResult: null,
                sourceFile: absSource,
                irHash,
                blockedReason: 'the upstream code-generation step returned an empty file map. Inspect `delegateNotes` for what the LLM emitted, then re-invoke (transient generation failures usually clear on retry).',
                delegateNotes,
            };
        }
        // Surface scaffold files alongside generated test files so the user
        // sees the full output set in the result.
        if (configFiles.length > 0) {
            filesCreated.push(...configFiles);
        }

        // -- Step 5: build the GenerationResult shape downstream consumers
        //    expect (master tool's heal loop, optional create-back). The
        //    test-case stubs come from the IR so the heal-loop / create-back
        //    can address scenarios by their original IDs.
        const featureFiles = filesCreated.filter((p) => p.endsWith('.feature'));
        const parsedTestCases = CSLegacyModeHandler.synthesizeParsedCases(ir);
        const translations: GherkinTranslation[] = parsedTestCases.map(() => ({
            background: [],
            given: [],
            when: [],
            then: [],
            examples: {},
            examplePlaceholders: [],
        }));

        const generationResult: GenerationResult = {
            testCases: parsedTestCases,
            translations,
            pageObjects: [],
            stepDefs: [],
            featureFile: {
                filePath: featureFiles[0] ?? '',
                content: featureFiles[0]
                    ? CSLegacyModeHandler.safeRead(featureFiles[0])
                    : '',
                scenarios: parsedTestCases.map((tc) => ({
                    id: `TS_${tc.testCaseId}`,
                    title: tc.title,
                    tcId: tc.testCaseId,
                    tags: [],
                })),
                needsSourceValidation: false,
            },
            fixtures: {
                content: new Map(),
                filePaths: filesCreated.filter((p) => p.endsWith('.json')),
            },
            filesCreated,
            needsSourceValidation: false,
            warnings: delegateNotes,
            cacheKey: cacheKeyForStore,
            cacheableFiles: cacheKeyForStore ? outputFiles : undefined,
            cacheHit: cacheHitInfo,
        };

        return {
            generationResult,
            sourceFile: absSource,
            irHash,
            delegateNotes,
        };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    // collectSiblingPageObjects + candidatePageDirs were used by the
    // sampling-based delegate path to bundle sibling .java page-object
    // files into the LLM input. The deterministic legacy_transform path
    // works directly from the IR — no sibling source bundling needed —
    // so both helpers are removed in Phase 2.

    private static deriveFeatureName(absSource: string): string {
        const base = path.basename(absSource);
        const dot = base.lastIndexOf('.');
        return dot > 0 ? base.slice(0, dot) : base;
    }

    /**
     * Walk up from the source file until we find a likely project root —
     * the first ancestor containing both a Java source root marker (a `src/`
     * sibling, or a `pom.xml` / `build.gradle`) and at least one sibling
     * directory among `page/`, `common/`, `bean/`, `util/`. Falls back to
     * the source's parent dir.
     */
    private static deriveProjectRoot(absSource: string): string {
        let cur = path.dirname(absSource);
        for (let i = 0; i < 8; i++) {
            try {
                const entries = fs.readdirSync(cur);
                const hasMarker =
                    entries.includes('pom.xml') ||
                    entries.includes('build.gradle') ||
                    entries.includes('src');
                if (hasMarker) return cur;
            } catch {
                // ignore
            }
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
        return path.dirname(absSource);
    }

    /**
     * Best-effort JSON parse of a tool's first text-content block.
     * Used when the tool surfaces its payload via `content[0].text` rather
     * than `structuredContent`.
     */
    private static parseTextJson(
        result: MCPToolResult,
    ): Record<string, unknown> | null {
        const sc = result.structuredContent as Record<string, unknown> | undefined;
        if (sc && Object.keys(sc).length > 0) return sc;
        const text = CSLegacyModeHandler.firstText(result);
        if (!text) return null;
        try {
            const parsed = JSON.parse(text);
            return typeof parsed === 'object' && parsed !== null
                ? (parsed as Record<string, unknown>)
                : null;
        } catch {
            return null;
        }
    }

    /**
     * Drive `generate_config_scaffold` so the workspace ends up with the
     * standard `config/<project>/{global.env, common/common.env,
     * environments/<env>.env}` layout. Best-effort — non-fatal failures
     * are logged but don't block the migration.
     */
    private static async generateConfigScaffold(
        projectName: string,
        environments: string[],
        workspaceRoot: string,
        context: MCPToolContext,
    ): Promise<string[]> {
        const generated: string[] = [];
        const originalCwd = process.cwd();
        try {
            // generate_config_scaffold uses process.cwd() for its base path,
            // so we briefly chdir to honour an explicit workspaceRoot.
            if (path.resolve(workspaceRoot) !== originalCwd) {
                try {
                    process.chdir(workspaceRoot);
                } catch {
                    // If chdir fails, the scaffold lands at the original cwd.
                }
            }
            const result = await CSLegacyModeHandler.invokeTool(
                generationTools,
                'generate_config_scaffold',
                {
                    project: projectName,
                    environments,
                    adoIntegration: true,
                },
                context,
            );
            if (!result.isError) {
                const sc = CSLegacyModeHandler.parseTextJson(result);
                const fl = sc?.filesGenerated;
                if (Array.isArray(fl)) {
                    for (const f of fl) {
                        if (typeof f === 'string') generated.push(f);
                    }
                }
            }
        } catch (err) {
            context.log('warning', 'CSLegacyModeHandler: config scaffold failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            try {
                process.chdir(originalCwd);
            } catch {
                // best-effort
            }
        }
        return generated;
    }

    private static parseIr(irJson: string): LegacyIR | null {
        try {
            return JSON.parse(irJson) as LegacyIR;
        } catch {
            return null;
        }
    }

    /**
     * Parse the IR back into an object for use inside a structured
     * grounding payload. Returns the raw string when JSON.parse fails.
     */
    private static parseIrSafe(irJson: string): unknown {
        try {
            return JSON.parse(irJson);
        } catch {
            return irJson;
        }
    }

    private static synthesizeParsedCases(ir: LegacyIR | null): ParsedTestCase[] {
        if (!ir) return [];
        return ir.tests.map((t, i) => ({
            testCaseId: i + 1,
            title: t.name,
            state: 'Active',
            tags: t.tags ?? [],
            steps: [],
            rawWorkItem: { id: i + 1, fields: {} },
        }));
    }

    private static safeRead(filePath: string): string {
        try {
            return fs.readFileSync(filePath, 'utf-8');
        } catch {
            return '';
        }
    }

    private static firstText(result: MCPToolResult): string {
        for (const c of result.content) {
            if (c.type === 'text') return c.text;
        }
        return '';
    }

    /**
     * Merge migrated test-data rows (from XLS/CSV via CSTestDataMigrator)
     * onto the scenarios JSON stub the transformer emits. The stub has
     * one row per IR test with `scenarioId`, `scenarioName`, `runFlag` and
     * `REPLACE_WITH_<KEY>` placeholders. Real rows from the data file
     * carry the actual values keyed by `scenarioId`. Returns the merged
     * JSON as a formatted string ready to write to disk.
     *
     * Rows from the migrated data file win on field collisions. Stub rows
     * without a matching migrated row are kept as-is (placeholders remain
     * for the audit to flag).
     */
    private static overlayDataRows(
        stubJson: string,
        migratedRows: Array<Record<string, unknown>>,
    ): string {
        let stubRows: Array<Record<string, unknown>>;
        try {
            stubRows = JSON.parse(stubJson);
            if (!Array.isArray(stubRows)) return stubJson;
        } catch {
            return stubJson;
        }
        const byId = new Map<string, Record<string, unknown>>();
        for (const r of migratedRows) {
            const id = (r as Record<string, unknown>).scenarioId;
            if (typeof id === 'string') byId.set(id, r);
        }
        const merged = stubRows.map((stub) => {
            const id =
                typeof stub.scenarioId === 'string' ? stub.scenarioId : '';
            const real = byId.get(id);
            if (!real) return stub;
            return { ...stub, ...real };
        });
        return JSON.stringify(merged, null, 2) + '\n';
    }

    private static async invokeTool(
        defs: MCPToolDefinition[],
        toolName: string,
        params: Record<string, unknown>,
        context: MCPToolContext,
    ): Promise<MCPToolResult> {
        const def = defs.find((d) => d.tool.name === toolName);
        if (!def) {
            throw new Error(
                `CSLegacyModeHandler: required tool not registered: ${toolName}`,
            );
        }
        return def.handler(params, context);
    }
}
