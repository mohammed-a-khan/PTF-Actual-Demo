/**
 * Agentic Test Platform — Source-Code Mode Handler
 *
 * Drives the `source_code_path` mode: pointed at an application source file
 * (controller, service, component, etc.), the platform produces tests that
 * exercise its observable behaviour. Like the legacy mode, the platform's
 * job is purely orchestration — Copilot reads the source, infers the test
 * surface, and emits the file map.
 *
 * Auto-discovers sibling files in the same directory (controllers usually
 * live next to their DTOs / interfaces / helpers) up to a small cap so the
 * delegate has enough context to write coherent tests without dumping the
 * whole repo.
 *
 * `targetSurface` from the clarification agent steers Copilot — UI test
 * vs. API test vs. mixed coverage.
 *
 * Privacy-by-design: source content runs through PII redaction inside the
 * delegate before going over the wire.
 *
 * @module agent-platform/CSSourceCodeModeHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { transformTools } from '../tools/transform/CSMCPTransformTools';
import { CSCopilotDelegate } from './CSCopilotDelegate';
import { CSLiveAppContext, LiveAppContext } from './CSLiveAppContext';
import { CSMigrationCache } from './CSMigrationCache';
import { CSCostTelemetry } from './CSCostTelemetry';
import { CSSourceToIrConverter } from './CSSourceToIrConverter';
import { GenerationResult } from './CSGenerationOrchestrator';
import { ParsedTestCase } from './CSAdoTestCaseParser';
import { GherkinTranslation } from './CSStepToGherkinTranslator';
import { ClassifiedInput } from './types';

// ============================================================================
// Public Types
// ============================================================================

export interface SourceCodeModeHandlerOptions {
    projectName?: string;
    featureName?: string;
    outputRoot?: string;
    telemetry?: CSCostTelemetry;
    /** From the clarification agent: 'ui' | 'api' | 'both'. */
    targetSurface?: string;
    /** Cap on sibling files included for context. */
    maxSiblingFiles?: number;
    /**
     * When true (default for UI surfaces), elicit URL + creds + nav steps
     * before generation so the produced tests can be heal-loop validated
     * against a live app. API-only runs may set false because they exercise
     * HTTP endpoints rather than rendered DOM.
     */
    requireLiveApp?: boolean;
}

export interface SourceCodeModeHandlerResult {
    generationResult: GenerationResult | null;
    sourceFile?: string;
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
    delegateNotes?: string[];
    liveAppContext?: LiveAppContext;
}

// ============================================================================
// CSSourceCodeModeHandler
// ============================================================================

export class CSSourceCodeModeHandler {
    private static readonly DEFAULT_OUTPUT_ROOT = path.join('generated', 'source');
    private static readonly DEFAULT_MAX_SIBLINGS = 5;
    private static readonly PIPELINE_VERSION = '1.21.0';
    /** Source extensions we accept inline. Other types still go through but warn. */
    private static readonly KNOWN_SOURCE_EXTENSIONS = new Set([
        '.java',
        '.kt',
        '.cs',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.py',
        '.rb',
        '.go',
        '.rs',
        '.swift',
        '.scala',
        '.php',
    ]);

    public static async handle(
        classified: ClassifiedInput,
        options: SourceCodeModeHandlerOptions,
        context: MCPToolContext,
    ): Promise<SourceCodeModeHandlerResult> {
        const ef = classified.extractedFields;
        const sourceFile = ef.path;
        if (!sourceFile) {
            return {
                generationResult: null,
                blockedReason:
                    "supply the source file path. Re-invoke with `path: <absolute or workspace-relative path to .ts/.java/.py source>` in the input string.",
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
            CSSourceCodeModeHandler.deriveFeatureName(absSource);
        const outputRoot =
            options.outputRoot || CSSourceCodeModeHandler.DEFAULT_OUTPUT_ROOT;
        const targetSurface = options.targetSurface || ef.targetSurface || 'ui';

        // -- Live-app context: elicit URL/creds/nav for UI surfaces --------
        // API-targeted runs hit HTTP endpoints directly; the heal loop runs
        // request-level assertions and doesn't need DOM. UI / mixed surfaces
        // must anchor against a real app or they emit guessed selectors.
        let liveAppContext: LiveAppContext | undefined;
        const liveAppDefaultRequired =
            targetSurface === 'ui' || targetSurface === 'both';
        const requireLiveApp =
            options.requireLiveApp !== undefined
                ? options.requireLiveApp
                : liveAppDefaultRequired;
        if (requireLiveApp) {
            const outcome = await CSLiveAppContext.ensure(classified, context);
            if (outcome.status !== 'ok') {
                return {
                    generationResult: null,
                    sourceFile: absSource,
                    blockedReason: outcome.reason,
                };
            }
            liveAppContext = outcome.context;
            classified = CSLiveAppContext.merge(classified, liveAppContext);
        }

        const main = CSCopilotDelegate.readInput(absSource, 'application source');
        if (!main) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason: 'the source file became unreadable mid-run (permissions or removal). Verify the file is accessible, then re-invoke with the same input.',
            };
        }

        // Cache key includes targetSurface so UI vs API runs don't collide.
        const cacheLookup = await CSMigrationCache.lookup(
            {
                sourceFile: absSource,
                projectName,
                pipelineVersion: CSSourceCodeModeHandler.PIPELINE_VERSION,
                extras: `targetSurface=${targetSurface}`,
            },
            context,
        );

        let outputFiles: Record<string, string>;
        let delegateNotes: string[] = [];
        let cacheHitInfo: { cachedAt: string } | undefined;
        let cacheKeyForStore: string | undefined;

        if (cacheLookup.hit && cacheLookup.files) {
            context.log('info', `CSSourceCodeModeHandler: cache hit (cachedAt=${cacheLookup.cachedAt}) — skipping Copilot delegate`);
            outputFiles = cacheLookup.files;
            cacheHitInfo = cacheLookup.cachedAt
                ? { cachedAt: cacheLookup.cachedAt }
                : undefined;
        } else {
            // Deterministic source → IR → legacy_transform path. Same
            // pattern as document mode (Phase 5b). The converter detects
            // CS Playwright page objects (decorators present) and emits
            // a one-page IR with stub scenarios per public method; falls
            // back to a placeholder IR + a note for unknown source.
            const conversion = CSSourceToIrConverter.convert(absSource, {
                targetSurface: targetSurface as 'ui' | 'api' | 'both',
            });
            delegateNotes = [
                conversion.detectedAsPageObject
                    ? `Source recognised as a page object — extracted ${conversion.publicMethods.length} public method(s) as scenario stubs`
                    : `Source did not match the page-object pattern; emitted a placeholder IR — refine before merging`,
                ...conversion.notes,
            ];

            const transformRaw = await CSSourceCodeModeHandler.invokeTool(
                transformTools,
                'legacy_transform',
                {
                    irJson: JSON.stringify(conversion.ir),
                    projectName,
                    featureName,
                    pipelineVersion: CSSourceCodeModeHandler.PIPELINE_VERSION,
                },
                context,
            );
            if (transformRaw.isError) {
                return {
                    generationResult: null,
                    sourceFile: absSource,
                    blockedReason:
                        'the deterministic transformer could not produce a draft from the synthesized IR. Inspect `blockedDetails.detail`, then re-invoke after correcting the source structure.',
                    blockedDetails: {
                        detail: CSSourceCodeModeHandler.firstText(transformRaw),
                    },
                    delegateNotes,
                };
            }
            let transformResult: { files: Record<string, string>; notes?: string[] };
            try {
                transformResult = JSON.parse(
                    CSSourceCodeModeHandler.firstText(transformRaw),
                );
            } catch (err) {
                return {
                    generationResult: null,
                    sourceFile: absSource,
                    blockedReason:
                        'the transformer returned non-JSON output. Re-invoke once — transient parser errors usually clear.',
                    blockedDetails: {
                        error: err instanceof Error ? err.message : String(err),
                    },
                    delegateNotes,
                };
            }
            outputFiles = transformResult.files;
            if (transformResult.notes) {
                delegateNotes.push(...transformResult.notes);
            }
            cacheKeyForStore = cacheLookup.cacheKey || undefined;
        }

        const filesCreated = CSCopilotDelegate.writeFiles(outputFiles, outputRoot);
        if (filesCreated.length === 0) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason:
                    'the deterministic transformer returned an empty file map. The source had no extractable structure — verify the file is a CS Playwright page object (decorated with @CSPage / @CSGetElement) or use document_path mode with a paired requirements doc.',
                delegateNotes,
            };
        }

        const featureFiles = filesCreated.filter((p) => p.endsWith('.feature'));
        // Without test-case names from the source we can only synthesize a
        // placeholder list. Each scenario in the produced .feature will get
        // its own ID via the Copilot output; for downstream consumers we
        // expose a single anchor case for trust-score calculation.
        const parsedTestCases: ParsedTestCase[] = [
            {
                testCaseId: 1,
                title: featureName,
                state: 'Active',
                tags: [],
                steps: [],
                rawWorkItem: { id: 1, fields: {} },
            },
        ];
        const translations: GherkinTranslation[] = [
            {
                background: [],
                given: [],
                when: [],
                then: [],
                examples: {},
                examplePlaceholders: [],
            },
        ];

        const generationResult: GenerationResult = {
            testCases: parsedTestCases,
            translations,
            pageObjects: [],
            stepDefs: [],
            featureFile: {
                filePath: featureFiles[0] ?? '',
                content: featureFiles[0]
                    ? CSSourceCodeModeHandler.safeRead(featureFiles[0])
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
            delegateNotes,
            liveAppContext,
        };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    // collectSiblings + extractExportedSymbols were used by the
    // sampling-based delegate path to bundle sibling source for the
    // host LLM. The deterministic CSSourceToIrConverter path works
    // from a single file — the converter detects whether it's a CS
    // Playwright page object and extracts elements/methods directly.
    // Both helpers removed in Phase 5c.

    private static deriveFeatureName(absSource: string): string {
        const base = path.basename(absSource);
        const dot = base.lastIndexOf('.');
        return (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9]+/g, '_');
    }

    private static safeRead(filePath: string): string {
        try {
            return fs.readFileSync(filePath, 'utf-8');
        } catch {
            return '';
        }
    }

    private static firstText(result: MCPToolResult): string {
        for (const c of result.content ?? []) {
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
                `Source-mode handler: required tool not registered: ${toolName}`,
            );
        }
        return def.handler(params, context);
    }
}
