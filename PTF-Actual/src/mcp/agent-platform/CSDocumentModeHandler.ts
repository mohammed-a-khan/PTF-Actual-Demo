/**
 * Agentic Test Platform — Document Mode Handler
 *
 * Drives the `document_path` mode: a requirements / specification document
 * (Markdown, plain text) becomes one test scenario per enumerated rule. The
 * platform's role is orchestration only — Copilot reads the document and
 * produces the test files; we provide the framework conventions, write the
 * output, and gate it through the heal loop downstream.
 *
 * Supported formats out of the box: `.md`, `.markdown`, `.txt`, `.adoc`,
 * `.rst`. Binary formats (`.pdf`, `.docx`) are blocked with a clear reason
 * — the user converts to text or pre-extracts via tooling outside the MCP
 * server. (Adding pdf-parse / mammoth later is a small follow-up that does
 * not change the architecture.)
 *
 * Privacy-by-design: document content runs through PII redaction inside
 * the delegate before going over the wire.
 *
 * @module agent-platform/CSDocumentModeHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { transformTools } from '../tools/transform/CSMCPTransformTools';
import { CSCopilotDelegate } from './CSCopilotDelegate';
import { CSDocToIrConverter } from './CSDocToIrConverter';
import { CSLiveAppContext, LiveAppContext } from './CSLiveAppContext';
import { CSMigrationCache } from './CSMigrationCache';
import { CSCostTelemetry } from './CSCostTelemetry';
import { GenerationResult } from './CSGenerationOrchestrator';
import { ParsedTestCase } from './CSAdoTestCaseParser';
import { GherkinTranslation } from './CSStepToGherkinTranslator';
import { ClassifiedInput } from './types';

// ============================================================================
// Public Types
// ============================================================================

export interface DocumentModeHandlerOptions {
    projectName?: string;
    featureName?: string;
    outputRoot?: string;
    telemetry?: CSCostTelemetry;
    /** Optional section filter from the clarification agent. */
    sectionFocus?: string;
    /**
     * When true (default), elicit URL + creds + nav steps before generation
     * so the produced tests can be heal-loop validated against a live app.
     * Set false only for offline planning runs that explicitly want a
     * scaffold-only output.
     */
    requireLiveApp?: boolean;
}

export interface DocumentModeHandlerResult {
    generationResult: GenerationResult | null;
    sourceFile?: string;
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
    delegateNotes?: string[];
    /** Resolved live-app anchor when requireLiveApp produced one. */
    liveAppContext?: LiveAppContext;
}

// ============================================================================
// CSDocumentModeHandler
// ============================================================================

export class CSDocumentModeHandler {
    private static readonly DEFAULT_OUTPUT_ROOT = path.join('generated', 'document');
    private static readonly PIPELINE_VERSION = '1.21.0';
    private static readonly TEXT_EXTENSIONS = new Set([
        '.md',
        '.markdown',
        '.txt',
        '.adoc',
        '.rst',
    ]);
    private static readonly BINARY_HINT_EXTENSIONS = new Set(['.pdf', '.docx', '.doc']);

    public static async handle(
        classified: ClassifiedInput,
        options: DocumentModeHandlerOptions,
        context: MCPToolContext,
    ): Promise<DocumentModeHandlerResult> {
        const ef = classified.extractedFields;
        const sourceFile = ef.path;
        if (!sourceFile) {
            return {
                generationResult: null,
                blockedReason:
                    "supply the requirements document path. Re-invoke with `path: <absolute or workspace-relative path to .md/.txt>` in the input string.",
            };
        }
        const absSource = path.isAbsolute(sourceFile)
            ? sourceFile
            : path.resolve(process.cwd(), sourceFile);
        if (!fs.existsSync(absSource)) {
            return {
                generationResult: null,
                blockedReason: `correct the document path and re-invoke. The supplied path resolved to ${absSource} which does not exist on disk.`,
            };
        }

        const ext = path.extname(absSource).toLowerCase();
        if (CSDocumentModeHandler.BINARY_HINT_EXTENSIONS.has(ext)) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason: `convert the ${ext} file to .md or .txt and re-invoke — binary formats need pre-extraction. Tools: pandoc (for .docx), pdftotext (for .pdf). Or paste the rules verbatim via natural_language_chat mode.`,
            };
        }
        if (!CSDocumentModeHandler.TEXT_EXTENSIONS.has(ext) && ext !== '') {
            // Unknown extension — try anyway but warn via the delegate notes.
            // Intentional: caller may have a custom doc format we can still read.
        }

        const projectName = options.projectName || ef.projectName || 'common';
        const featureName =
            options.featureName ||
            ef.featureName ||
            CSDocumentModeHandler.deriveFeatureName(absSource);
        const outputRoot =
            options.outputRoot || CSDocumentModeHandler.DEFAULT_OUTPUT_ROOT;
        const sectionFocus = options.sectionFocus || ef.sectionFocus || 'all';

        // -- Live-app context: elicit URL/creds/nav when missing -----------
        // Pure-text doc input cannot anchor real DOM. Resolve URL + login
        // info from input → config → elicitation. Decline/unsupported is a
        // hard block — without an anchor the heal loop cannot run, so the
        // tool does not pretend to produce executable code.
        let liveAppContext: LiveAppContext | undefined;
        if (options.requireLiveApp !== false) {
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

        // -- Read the document ---------------------------------------------
        const main = CSCopilotDelegate.readInput(absSource, 'requirements document');
        if (!main) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason: 'the document became unreadable mid-run (permissions or removal). Verify the file is accessible, then re-invoke with the same input.',
            };
        }
        const headings = CSDocumentModeHandler.extractHeadings(main.content, sectionFocus);

        // -- Cache lookup ---------------------------------------------------
        // The cache key includes `sectionFocus` so different filtered runs
        // get distinct cache entries.
        const cacheLookup = await CSMigrationCache.lookup(
            {
                sourceFile: absSource,
                projectName,
                pipelineVersion: CSDocumentModeHandler.PIPELINE_VERSION,
                extras: `sectionFocus=${sectionFocus}`,
            },
            context,
        );

        let outputFiles: Record<string, string>;
        let delegateNotes: string[] = [];
        let cacheHitInfo: { cachedAt: string } | undefined;
        let cacheKeyForStore: string | undefined;

        if (cacheLookup.hit && cacheLookup.files) {
            context.log('info', `CSDocumentModeHandler: cache hit (cachedAt=${cacheLookup.cachedAt}) — skipping Copilot delegate`);
            outputFiles = cacheLookup.files;
            cacheHitInfo = cacheLookup.cachedAt
                ? { cachedAt: cacheLookup.cachedAt }
                : undefined;
        } else {
            // Deterministic doc → IR → legacy_transform path. Same
            // architecture as legacy mode (Phase 2.1): no sampling, no
            // host-LLM round-trip. The converter heuristically extracts
            // scenarios from headings + shall/must/should sentences;
            // legacy_transform deterministically emits the file map
            // (feature, steps, scenarios JSON, page-object stubs).
            //
            // The output drafts contain `// TODO` markers for any LLM-
            // judgement step the user wants to refine — those fail the
            // pre-gate audit and surface to the host LLM (Copilot) for
            // surgical fixes via apply_patch.
            const conversion = CSDocToIrConverter.convert(absSource, {
                sectionFocus,
            });
            delegateNotes = [
                `Converted document to IR: ${conversion.scenarioCount} scenario(s), ${conversion.stepCount} step(s)`,
                ...conversion.notes,
            ];

            const transformRaw = await CSDocumentModeHandler.invokeTool(
                transformTools,
                'legacy_transform',
                {
                    irJson: JSON.stringify(conversion.ir),
                    projectName,
                    featureName,
                    pipelineVersion: CSDocumentModeHandler.PIPELINE_VERSION,
                },
                context,
            );
            if (transformRaw.isError) {
                return {
                    generationResult: null,
                    sourceFile: absSource,
                    blockedReason:
                        'the deterministic transformer could not produce a draft from the synthesized IR. Inspect `blockedDetails.detail`, then re-invoke after correcting the source document structure.',
                    blockedDetails: {
                        detail: CSDocumentModeHandler.firstText(transformRaw),
                    },
                    delegateNotes,
                };
            }
            let transformResult: { files: Record<string, string>; notes?: string[] };
            try {
                transformResult = JSON.parse(
                    CSDocumentModeHandler.firstText(transformRaw),
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

        // -- Write + assemble result ---------------------------------------
        const filesCreated = CSCopilotDelegate.writeFiles(outputFiles, outputRoot);
        if (filesCreated.length === 0) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason: 'the deterministic transformer returned an empty file map. This usually means the IR had zero tests — verify the doc has at least one `##` heading or one shall/must/should sentence.',
                delegateNotes,
            };
        }

        const featureFiles = filesCreated.filter((p) => p.endsWith('.feature'));
        const parsedTestCases: ParsedTestCase[] = headings.map((h, i) => ({
            testCaseId: i + 1,
            title: h,
            state: 'Active',
            tags: [],
            steps: [],
            rawWorkItem: { id: i + 1, fields: {} },
        }));
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
                    ? CSDocumentModeHandler.safeRead(featureFiles[0])
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

    /**
     * Pull section headings out of Markdown / RST / AsciiDoc content. When a
     * section filter is provided ("all", "intro", a heading prefix, etc.),
     * filter to matching sections only. Used as grounding for the delegate.
     */
    private static extractHeadings(content: string, focus: string): string[] {
        const out: string[] = [];
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            // Markdown ATX
            const md = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
            if (md) {
                out.push(md[1].trim());
                continue;
            }
            // AsciiDoc ATX-style (== Title)
            const adoc = line.match(/^=+\s+(.+)$/);
            if (adoc) {
                out.push(adoc[1].trim());
                continue;
            }
        }
        if (focus && focus !== 'all') {
            const needle = focus.toLowerCase();
            return out.filter((h) => h.toLowerCase().includes(needle));
        }
        return out;
    }

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
                `CSDocumentModeHandler: required tool not registered: ${toolName}`,
            );
        }
        return def.handler(params, context);
    }
}
