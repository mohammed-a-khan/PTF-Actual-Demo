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
import { CSCopilotDelegate, DelegateInputFile } from './CSCopilotDelegate';
import { CSMigrationCache } from './CSMigrationCache';
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
    outputRoot?: string;
    telemetry?: CSCostTelemetry;
    /** Cap on sibling page-object files included in the prompt. */
    maxSiblingFiles?: number;
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
    private static readonly DEFAULT_MAX_SIBLINGS = 10;
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
                    "CSLegacyModeHandler: missing 'path' in classified input — expected the legacy file's filesystem path",
            };
        }
        const absSource = path.isAbsolute(sourceFile)
            ? sourceFile
            : path.resolve(process.cwd(), sourceFile);
        if (!fs.existsSync(absSource)) {
            return {
                generationResult: null,
                blockedReason: `CSLegacyModeHandler: source file not found at ${absSource}`,
            };
        }

        const projectName = options.projectName || ef.projectName || 'common';
        const featureName =
            options.featureName ||
            ef.featureName ||
            CSLegacyModeHandler.deriveFeatureName(absSource);
        const outputRoot = options.outputRoot || CSLegacyModeHandler.DEFAULT_OUTPUT_ROOT;

        // -- Step 1: cheap structural grounding via legacy_parse ------------
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
                blockedReason: 'legacy_parse failed',
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
            // Cache miss — build the input bundle and call Copilot.
            const sourceFiles: DelegateInputFile[] = [];
            const main = CSCopilotDelegate.readInput(absSource, 'test class (legacy)');
            if (!main) {
                return {
                    generationResult: null,
                    sourceFile: absSource,
                    irHash,
                    blockedReason: 'CSLegacyModeHandler: failed to read main source file',
                };
            }
            sourceFiles.push(main);

            const siblings = CSLegacyModeHandler.collectSiblingPageObjects(
                absSource,
                main.content,
                options.maxSiblingFiles ?? CSLegacyModeHandler.DEFAULT_MAX_SIBLINGS,
            );
            sourceFiles.push(...siblings);

            // Pre-migrate external test data (XLS / CSV / etc. referenced
            // by @QAFDataProvider / @DataProvider). The parsed rows ride
            // along in `grounding` so the LLM emits the new <feature>-data.json
            // with REAL values instead of inventing placeholders.
            const migratedData = await CSTestDataMigrator.migrate(
                absSource,
                main.content,
                context,
            );

            const groundingPayload = {
                ir: CSLegacyModeHandler.parseIrSafe(irJson),
                migratedTestData: {
                    references: migratedData.references.map((r) => ({
                        rawPath: r.rawPath,
                        resolvedPath: r.resolvedPath,
                        sheetName: r.sheetName ?? null,
                        rowKey: r.rowKey ?? null,
                        source: r.source,
                    })),
                    rowCount: migratedData.rows.length,
                    rows: migratedData.rows.slice(0, 50),
                    notes: migratedData.notes,
                },
            };

            const delegateResult = await CSCopilotDelegate.delegate(
                {
                    task: 'legacy_migration',
                    projectName,
                    featureName,
                    sourceFiles,
                    grounding: JSON.stringify(groundingPayload, null, 2),
                    telemetry: options.telemetry,
                },
                context,
            );
            if (delegateResult.blockedReason) {
                return {
                    generationResult: null,
                    sourceFile: absSource,
                    irHash,
                    blockedReason: delegateResult.blockedReason,
                    blockedDetails: { notes: delegateResult.notes },
                    delegateNotes: delegateResult.notes,
                };
            }
            outputFiles = delegateResult.files;
            delegateNotes = delegateResult.notes;
            // Stamp the cache key on the result so the master tool can
            // call CSMigrationCache.store after the heal loop confirms green.
            cacheKeyForStore = cacheLookup.cacheKey || undefined;
        }

        // -- Step 3: write the file map -------------------------------------
        const filesCreated = CSCopilotDelegate.writeFiles(outputFiles, outputRoot);
        if (filesCreated.length === 0) {
            return {
                generationResult: null,
                sourceFile: absSource,
                irHash,
                blockedReason: 'CSLegacyModeHandler: nothing was written to disk',
                delegateNotes,
            };
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

    /**
     * Pull `import com.<...>.page.<X>` lines out of the main file, locate
     * those `<X>.java` files in nearby `page/` directories, read them. The
     * delegate needs the page-object source to translate `@FindBy` decorations
     * into `@CSGetElement` decorations.
     */
    private static collectSiblingPageObjects(
        absSource: string,
        mainContent: string,
        max: number,
    ): DelegateInputFile[] {
        const importRe = /import\s+([\w.]*\.page\.\w+);/g;
        const classNames = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(mainContent)) !== null) {
            const fq = m[1];
            const cls = fq.split('.').pop();
            if (cls) classNames.add(cls);
        }
        if (classNames.size === 0) return [];

        const candidateDirs = CSLegacyModeHandler.candidatePageDirs(absSource);
        const found: DelegateInputFile[] = [];
        for (const cls of classNames) {
            if (found.length >= max) break;
            for (const dir of candidateDirs) {
                const candidate = path.join(dir, `${cls}.java`);
                if (fs.existsSync(candidate)) {
                    const fileObj = CSCopilotDelegate.readInput(
                        candidate,
                        'page object (legacy)',
                    );
                    if (fileObj) {
                        found.push(fileObj);
                    }
                    break;
                }
            }
        }
        return found;
    }

    /**
     * Walk up from the test source file looking for sibling `page/` dirs.
     * Handles the common Maven layout where tests live under `testsuites/`
     * and page objects under `page/` at the same package depth.
     */
    private static candidatePageDirs(absSource: string): string[] {
        const dirs: string[] = [];
        let cur = path.dirname(absSource);
        for (let i = 0; i < 6; i++) {
            const candidate = path.join(cur, 'page');
            if (fs.existsSync(candidate)) dirs.push(candidate);
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
        return dirs;
    }

    private static deriveFeatureName(absSource: string): string {
        const base = path.basename(absSource);
        const dot = base.lastIndexOf('.');
        return dot > 0 ? base.slice(0, dot) : base;
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
