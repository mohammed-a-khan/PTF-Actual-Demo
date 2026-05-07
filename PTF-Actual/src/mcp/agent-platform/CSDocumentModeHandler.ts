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
import { MCPToolContext } from '../types/CSMCPTypes';
import { CSCopilotDelegate, DelegateInputFile } from './CSCopilotDelegate';
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
}

export interface DocumentModeHandlerResult {
    generationResult: GenerationResult | null;
    sourceFile?: string;
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
    delegateNotes?: string[];
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
                    "CSDocumentModeHandler: missing 'path' in classified input",
            };
        }
        const absSource = path.isAbsolute(sourceFile)
            ? sourceFile
            : path.resolve(process.cwd(), sourceFile);
        if (!fs.existsSync(absSource)) {
            return {
                generationResult: null,
                blockedReason: `CSDocumentModeHandler: file not found at ${absSource}`,
            };
        }

        const ext = path.extname(absSource).toLowerCase();
        if (CSDocumentModeHandler.BINARY_HINT_EXTENSIONS.has(ext)) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason: `CSDocumentModeHandler: ${ext} files are not yet supported in-server. Convert to .md / .txt and re-invoke, or paste the content via natural_language_chat.`,
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

        // -- Read the document ---------------------------------------------
        const main = CSCopilotDelegate.readInput(absSource, 'requirements document');
        if (!main) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason: 'CSDocumentModeHandler: failed to read document',
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
            const sourceFiles: DelegateInputFile[] = [main];
            const grounding = JSON.stringify(
                { sourceFile: absSource, sectionFocus, headings },
                null,
                2,
            );

            const delegateResult = await CSCopilotDelegate.delegate(
                {
                    task: 'document_to_tests',
                    projectName,
                    featureName,
                    sourceFiles,
                    grounding,
                    telemetry: options.telemetry,
                },
                context,
            );
            if (delegateResult.blockedReason) {
                return {
                    generationResult: null,
                    sourceFile: absSource,
                    blockedReason: delegateResult.blockedReason,
                    blockedDetails: { notes: delegateResult.notes },
                    delegateNotes: delegateResult.notes,
                };
            }
            outputFiles = delegateResult.files;
            delegateNotes = delegateResult.notes;
            cacheKeyForStore = cacheLookup.cacheKey || undefined;
        }

        // -- Write + assemble result ---------------------------------------
        const filesCreated = CSCopilotDelegate.writeFiles(outputFiles, outputRoot);
        if (filesCreated.length === 0) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason: 'CSDocumentModeHandler: nothing was written to disk',
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
}
