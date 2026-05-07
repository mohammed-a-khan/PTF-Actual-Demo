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

export interface SourceCodeModeHandlerOptions {
    projectName?: string;
    featureName?: string;
    outputRoot?: string;
    telemetry?: CSCostTelemetry;
    /** From the clarification agent: 'ui' | 'api' | 'both'. */
    targetSurface?: string;
    /** Cap on sibling files included for context. */
    maxSiblingFiles?: number;
}

export interface SourceCodeModeHandlerResult {
    generationResult: GenerationResult | null;
    sourceFile?: string;
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
    delegateNotes?: string[];
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
                    "CSSourceCodeModeHandler: missing 'path' in classified input",
            };
        }
        const absSource = path.isAbsolute(sourceFile)
            ? sourceFile
            : path.resolve(process.cwd(), sourceFile);
        if (!fs.existsSync(absSource)) {
            return {
                generationResult: null,
                blockedReason: `CSSourceCodeModeHandler: file not found at ${absSource}`,
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

        const main = CSCopilotDelegate.readInput(absSource, 'application source');
        if (!main) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason: 'CSSourceCodeModeHandler: failed to read source file',
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
            const siblings = CSSourceCodeModeHandler.collectSiblings(
                absSource,
                options.maxSiblingFiles ?? CSSourceCodeModeHandler.DEFAULT_MAX_SIBLINGS,
            );

            const sourceFiles: DelegateInputFile[] = [main, ...siblings];

            const grounding = JSON.stringify(
                {
                    sourceFile: absSource,
                    targetSurface,
                    exportedSymbols: CSSourceCodeModeHandler.extractExportedSymbols(
                        main.content,
                        path.extname(absSource).toLowerCase(),
                    ),
                },
                null,
                2,
            );

            const delegateResult = await CSCopilotDelegate.delegate(
                {
                    task: 'source_to_tests',
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

        const filesCreated = CSCopilotDelegate.writeFiles(outputFiles, outputRoot);
        if (filesCreated.length === 0) {
            return {
                generationResult: null,
                sourceFile: absSource,
                blockedReason:
                    'CSSourceCodeModeHandler: nothing was written to disk',
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
        };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Collect up to `max` source files from the same directory as the main
     * file. Skips test files (anything matching `*.test.*` / `*Test.*` /
     * `__tests__/`) so we feed Copilot only production source. Skips files
     * with extensions outside `KNOWN_SOURCE_EXTENSIONS`.
     */
    private static collectSiblings(
        absMain: string,
        max: number,
    ): DelegateInputFile[] {
        const dir = path.dirname(absMain);
        let entries: string[];
        try {
            entries = fs.readdirSync(dir);
        } catch {
            return [];
        }
        const mainBase = path.basename(absMain);
        const result: DelegateInputFile[] = [];
        for (const entry of entries) {
            if (result.length >= max) break;
            if (entry === mainBase) continue;
            if (/(?:\.test\.|\.spec\.|Test\.|Tests\.|__tests__)/.test(entry)) {
                continue;
            }
            const ext = path.extname(entry).toLowerCase();
            if (!CSSourceCodeModeHandler.KNOWN_SOURCE_EXTENSIONS.has(ext)) continue;
            const full = path.join(dir, entry);
            try {
                const stat = fs.statSync(full);
                if (!stat.isFile()) continue;
                const fileObj = CSCopilotDelegate.readInput(
                    full,
                    'sibling source',
                );
                if (fileObj) result.push(fileObj);
            } catch {
                // Ignore unreadable entries; the LLM does not require them.
            }
        }
        return result;
    }

    /**
     * Cheap regex pass for `export class X` / `public class X` / `def X` /
     * `function X(` etc. so the delegate's grounding lists the symbols it
     * should target.
     */
    private static extractExportedSymbols(content: string, ext: string): string[] {
        const out = new Set<string>();
        const patterns: RegExp[] = [];
        if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
            patterns.push(/\bexport\s+(?:class|function|const|interface|type)\s+(\w+)/g);
            patterns.push(/\bclass\s+(\w+)/g);
        } else if (ext === '.java' || ext === '.kt' || ext === '.cs' || ext === '.scala') {
            patterns.push(/\b(?:public|protected)?\s*(?:abstract\s+)?class\s+(\w+)/g);
            patterns.push(/\b(?:public|protected)\s+\w[\w<>?,\s]*\s+(\w+)\s*\(/g);
        } else if (ext === '.py') {
            patterns.push(/^\s*def\s+(\w+)\s*\(/gm);
            patterns.push(/^\s*class\s+(\w+)/gm);
        } else if (ext === '.go') {
            patterns.push(/\bfunc\s+(\w+)\s*\(/g);
            patterns.push(/\btype\s+(\w+)\s+/g);
        } else if (ext === '.rb') {
            patterns.push(/^\s*def\s+(\w+)/gm);
            patterns.push(/^\s*class\s+(\w+)/gm);
        }
        for (const re of patterns) {
            let m: RegExpExecArray | null;
            while ((m = re.exec(content)) !== null) {
                if (m[1]) out.add(m[1]);
            }
        }
        return Array.from(out).slice(0, 50);
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
