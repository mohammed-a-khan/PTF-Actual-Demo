/**
 * Agentic Test Platform — Natural-Language Chat Mode Handler
 *
 * Drives the `natural_language_chat` mode: the user describes a feature in
 * free-form text ("test the password reset flow", "create login tests
 * for valid + invalid credentials") with no source code to ground against.
 * The platform passes the description + clarification answers (appUrl,
 * expectedOutcome, roles) to Copilot, which drafts the .feature file,
 * page object(s), step definitions, and fixture JSON.
 *
 * This is the highest-risk mode — there is no source of truth to verify
 * against. The delegate is instructed to surface every assumption via
 * `notes`, and the heal loop closes the inevitable locator / element-name
 * gaps on the first run by inspecting compile / runtime errors.
 *
 * Privacy-by-design: the user's prompt runs through `CSPiiSanitizer.redact`
 * inside the delegate before going over the wire.
 *
 * @module agent-platform/CSChatModeHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext } from '../types/CSMCPTypes';
import { CSCopilotDelegate, DelegateInputFile } from './CSCopilotDelegate';
import { CSCostTelemetry } from './CSCostTelemetry';
import { GenerationResult } from './CSGenerationOrchestrator';
import { ParsedTestCase } from './CSAdoTestCaseParser';
import { GherkinTranslation } from './CSStepToGherkinTranslator';
import { ClassifiedInput } from './types';

// ============================================================================
// Public Types
// ============================================================================

export interface ChatModeHandlerOptions {
    projectName?: string;
    featureName?: string;
    outputRoot?: string;
    telemetry?: CSCostTelemetry;
}

export interface ChatModeHandlerResult {
    generationResult: GenerationResult | null;
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
    delegateNotes?: string[];
}

// ============================================================================
// CSChatModeHandler
// ============================================================================

export class CSChatModeHandler {
    private static readonly DEFAULT_OUTPUT_ROOT = path.join('generated', 'chat');

    public static async handle(
        classified: ClassifiedInput,
        options: ChatModeHandlerOptions,
        context: MCPToolContext,
    ): Promise<ChatModeHandlerResult> {
        const ef = classified.extractedFields;

        // The router stashes the trimmed prompt under `text`; clarification
        // answers add `feature`, `roles`, `appUrl`, `expectedOutcome`, etc.
        const intent =
            ef.feature ||
            ef.text ||
            classified.rawInput ||
            '';
        if (!intent || intent.trim().length === 0) {
            return {
                generationResult: null,
                blockedReason:
                    'CSChatModeHandler: empty user prompt — re-invoke with a feature description',
            };
        }

        const projectName = options.projectName || ef.projectName || 'common';
        const featureName =
            options.featureName ||
            ef.featureName ||
            CSChatModeHandler.deriveFeatureName(intent);
        const outputRoot = options.outputRoot || CSChatModeHandler.DEFAULT_OUTPUT_ROOT;

        // Pack the user's intent as a synthetic input file so the delegate
        // bundling / sanitizer treats it uniformly with other modes.
        const sourceFiles: DelegateInputFile[] = [
            {
                path: '<user-intent>',
                role: 'user description',
                content: intent,
            },
        ];

        const grounding = JSON.stringify(
            {
                source: 'natural_language_chat',
                appUrl: ef.appUrl ?? null,
                expectedOutcome: ef.expectedOutcome ?? null,
                roles: ef.roles ?? null,
                credentialsSource: ef.credentialsSource ?? null,
            },
            null,
            2,
        );

        const delegateResult = await CSCopilotDelegate.delegate(
            {
                task: 'natural_language_chat',
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
                blockedReason: delegateResult.blockedReason,
                blockedDetails: { notes: delegateResult.notes },
                delegateNotes: delegateResult.notes,
            };
        }

        const filesCreated = CSCopilotDelegate.writeFiles(
            delegateResult.files,
            outputRoot,
        );
        if (filesCreated.length === 0) {
            return {
                generationResult: null,
                blockedReason: 'CSChatModeHandler: nothing was written to disk',
                delegateNotes: delegateResult.notes,
            };
        }

        const featureFiles = filesCreated.filter((p) => p.endsWith('.feature'));
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
                    ? CSChatModeHandler.safeRead(featureFiles[0])
                    : '',
                scenarios: parsedTestCases.map((tc) => ({
                    id: `TS_${tc.testCaseId}`,
                    title: tc.title,
                    tcId: tc.testCaseId,
                    tags: [],
                })),
                needsSourceValidation: true,
            },
            fixtures: {
                content: new Map(),
                filePaths: filesCreated.filter((p) => p.endsWith('.json')),
            },
            filesCreated,
            // Always flag chat-mode results for source validation: the LLM
            // had nothing to ground against, and the user must verify the
            // assumptions surfaced in delegateNotes before merge.
            needsSourceValidation: true,
            warnings: delegateResult.notes,
        };

        return {
            generationResult,
            delegateNotes: delegateResult.notes,
        };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Derive a feature slug from the user's prompt. Picks the first 3-5
     * words that look like nouns, falls back to 'chat_feature'.
     */
    private static deriveFeatureName(intent: string): string {
        const tokens = intent.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
        const stopWords = new Set([
            'a', 'an', 'the', 'i', 'we', 'you', 'create', 'make', 'build',
            'test', 'tests', 'for', 'with', 'and', 'or', 'to', 'of', 'on',
        ]);
        const meaningful = tokens
            .filter((t) => !stopWords.has(t.toLowerCase()))
            .slice(0, 4);
        if (meaningful.length === 0) return 'chat_feature';
        return meaningful.join('_').toLowerCase();
    }

    private static safeRead(filePath: string): string {
        try {
            return fs.readFileSync(filePath, 'utf-8');
        } catch {
            return '';
        }
    }
}
