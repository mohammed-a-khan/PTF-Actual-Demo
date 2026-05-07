/**
 * Agentic Test Platform — App URL (live exploration) Mode Handler
 *
 * Drives the `app_url` mode: a running web application URL becomes a full
 * test suite by walking the framework's existing `explore_application`
 * tool. The crawler discovers states, captures interactive elements,
 * intercepts API calls, then synthesises feature files + page objects +
 * step definitions + spec files.
 *
 * The platform's job here is purely orchestration:
 *   1. Resolve URL + entry-flow from clarification answers
 *   2. Resolve optional credentials from CSConfigurationManager (the
 *      framework's `APP_USERNAME` / `APP_PASSWORD` config keys, with
 *      automatic decryption of any `ENCRYPTED:` payloads) when entry-flow
 *      is `basic-login`
 *   3. Invoke `explore_application` with sensible bounds (default 15-min
 *      crawl cap, default 50 states) — the heal loop downstream verifies
 *      every generated test still runs against the live app
 *   4. Surface the discovered state count + generated file paths back to
 *      the master tool
 *
 * Privacy-by-design: `APP_PASSWORD` is read from the framework's encrypted
 * config and is never sent through MCP sampling — the deterministic
 * `explore_application` crawler uses it directly to drive the login form
 * locally.
 *
 * @module agent-platform/CSAppUrlModeHandler
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { explorationTools } from '../tools/exploration/CSMCPExplorationTools';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSCostTelemetry } from './CSCostTelemetry';
import { GenerationResult } from './CSGenerationOrchestrator';
import { ParsedTestCase } from './CSAdoTestCaseParser';
import { GherkinTranslation } from './CSStepToGherkinTranslator';
import { ClassifiedInput } from './types';

// ============================================================================
// Public Types
// ============================================================================

export interface AppUrlModeHandlerOptions {
    projectName?: string;
    featureName?: string;
    outputRoot?: string;
    telemetry?: CSCostTelemetry;
    /** Cap on crawl wall-clock in minutes. Default 15. */
    maxDurationMinutes?: number;
    /** Cap on distinct states to discover. Default 50. */
    maxStates?: number;
    /** Crawl strategy. Default 'priority'. */
    strategy?: 'bfs' | 'dfs' | 'priority' | 'random';
}

export interface AppUrlModeHandlerResult {
    generationResult: GenerationResult | null;
    url?: string;
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
    statesDiscovered?: number;
    apisDiscovered?: number;
}

// ============================================================================
// Internal — explore_application response shape
// ============================================================================

interface ExploreApplicationResponse {
    sessionId: string;
    status: string;
    url: string;
    coverage?: { statesDiscovered?: number; elementsDiscovered?: number };
    summary?: {
        statesDiscovered?: number;
        transitionsFound?: number;
        apisDiscovered?: number;
        errorsEncountered?: number;
    };
    generatedFiles?: {
        features?: string[];
        pageObjects?: string[];
        stepDefinitions?: string[];
        specFiles?: string[];
    };
    duration?: number;
    states?: Array<{
        id: string;
        url: string;
        pageType: string;
        title: string;
        elementsCount: number;
        formsCount: number;
    }>;
}

// ============================================================================
// CSAppUrlModeHandler
// ============================================================================

export class CSAppUrlModeHandler {
    private static readonly DEFAULT_OUTPUT_ROOT = path.join('generated', 'app-url');
    private static readonly DEFAULT_MAX_DURATION_MIN = 15;
    private static readonly DEFAULT_MAX_STATES = 50;
    private static readonly DEFAULT_STRATEGY: AppUrlModeHandlerOptions['strategy'] =
        'priority';

    public static async handle(
        classified: ClassifiedInput,
        options: AppUrlModeHandlerOptions,
        context: MCPToolContext,
    ): Promise<AppUrlModeHandlerResult> {
        const ef = classified.extractedFields;

        const url = ef.url || ef.appUrl || '';
        if (!url || !/^https?:\/\//i.test(url)) {
            return {
                generationResult: null,
                blockedReason: `CSAppUrlModeHandler: invalid or missing URL (got '${url}')`,
            };
        }

        const entryFlow = (ef.entryFlow || 'no-auth').toLowerCase();
        const validFlows = new Set([
            'no-auth',
            'basic-login',
            'sso-redirect',
            'multi-step-login',
        ]);
        if (!validFlows.has(entryFlow)) {
            return {
                generationResult: null,
                url,
                blockedReason: `CSAppUrlModeHandler: unknown entryFlow '${entryFlow}'. Expected one of: ${Array.from(validFlows).join(', ')}`,
            };
        }

        // SSO and multi-step flows can't be driven generically. Phase 3.1
        // accepts a pre-recorded storageState JSON (Playwright pattern: user
        // logs in once interactively + saves storage, the crawler injects it
        // before navigation). The path comes from extractedFields.storageState
        // or APP_STORAGE_STATE config key.
        let storageStatePath: string | undefined;
        if (entryFlow === 'sso-redirect' || entryFlow === 'multi-step-login') {
            storageStatePath =
                ef.storageState ||
                CSAppUrlModeHandler.readConfig('APP_STORAGE_STATE') ||
                undefined;
            if (!storageStatePath) {
                return {
                    generationResult: null,
                    url,
                    blockedReason: `CSAppUrlModeHandler: entryFlow '${entryFlow}' requires a pre-recorded Playwright storage-state JSON. Set APP_STORAGE_STATE in .env (or pass storageState in answers) pointing at the file.`,
                };
            }
            if (!fs.existsSync(storageStatePath)) {
                return {
                    generationResult: null,
                    url,
                    blockedReason: `CSAppUrlModeHandler: storageState file not found at ${storageStatePath}. Record one via 'npx playwright codegen --save-storage=<path>' first.`,
                };
            }
        }

        const projectName =
            options.projectName ||
            ef.projectName ||
            CSAppUrlModeHandler.deriveProjectName(url);
        const featureName =
            options.featureName ||
            ef.featureName ||
            CSAppUrlModeHandler.deriveFeatureName(url);
        const outputRoot = options.outputRoot || CSAppUrlModeHandler.DEFAULT_OUTPUT_ROOT;

        // Resolve optional credentials when basic-login is requested.
        // Priority: classified.extractedFields.{username,password} → config
        // (APP_USERNAME / APP_PASSWORD with auto-decryption) → undefined.
        let username: string | undefined;
        let password: string | undefined;
        let loginUrl: string | undefined;
        if (entryFlow === 'basic-login') {
            username =
                ef.username ||
                CSAppUrlModeHandler.readConfig('APP_USERNAME') ||
                undefined;
            password =
                ef.password ||
                CSAppUrlModeHandler.readConfig('APP_PASSWORD') ||
                undefined;
            loginUrl = ef.loginUrl || undefined;
            if (!username || !password) {
                return {
                    generationResult: null,
                    url,
                    blockedReason:
                        'CSAppUrlModeHandler: entryFlow=basic-login requires APP_USERNAME + APP_PASSWORD in your .env (encrypted with ENCRYPTED: prefix recommended) or username/password in the classified extractedFields.',
                };
            }
        }

        // Budget guard: if telemetry is at its cap before we even start, bail.
        if (options.telemetry) {
            const budget = options.telemetry.checkBudget();
            if (!budget.withinBudget) {
                return {
                    generationResult: null,
                    url,
                    blockedReason: `CSAppUrlModeHandler: budget exhausted before exploration: ${budget.reason ?? 'limit reached'}`,
                };
            }
        }

        // -- Invoke explore_application --------------------------------------
        const exploreParams: Record<string, unknown> = {
            url,
            maxDuration:
                options.maxDurationMinutes ??
                CSAppUrlModeHandler.DEFAULT_MAX_DURATION_MIN,
            maxStates:
                options.maxStates ?? CSAppUrlModeHandler.DEFAULT_MAX_STATES,
            strategy: options.strategy ?? CSAppUrlModeHandler.DEFAULT_STRATEGY,
            generateTests: true,
            captureAPIs: true,
        };
        if (username) exploreParams.username = username;
        if (password) exploreParams.password = password;
        if (loginUrl) exploreParams.loginUrl = loginUrl;
        if (storageStatePath) exploreParams.storageStatePath = storageStatePath;

        let result: MCPToolResult;
        try {
            result = await CSAppUrlModeHandler.invokeTool(
                'explore_application',
                exploreParams,
                context,
            );
        } catch (err) {
            return {
                generationResult: null,
                url,
                blockedReason: `CSAppUrlModeHandler: explore_application threw: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        if (result.isError) {
            return {
                generationResult: null,
                url,
                blockedReason: 'explore_application failed',
                blockedDetails: { detail: CSAppUrlModeHandler.firstText(result) },
            };
        }

        const parsed = CSAppUrlModeHandler.parseResponse(result);
        if (!parsed) {
            return {
                generationResult: null,
                url,
                blockedReason:
                    'CSAppUrlModeHandler: explore_application returned an unparseable payload',
            };
        }

        // Aggregate every generated file path into a single list for the
        // master tool's heal loop and (optional) ADO create-back.
        const filesCreated: string[] = [
            ...(parsed.generatedFiles?.features ?? []),
            ...(parsed.generatedFiles?.pageObjects ?? []),
            ...(parsed.generatedFiles?.stepDefinitions ?? []),
            ...(parsed.generatedFiles?.specFiles ?? []),
        ];

        if (filesCreated.length === 0) {
            return {
                generationResult: null,
                url,
                blockedReason:
                    'CSAppUrlModeHandler: exploration completed but produced no test files',
                blockedDetails: { summary: parsed.summary },
                statesDiscovered: parsed.summary?.statesDiscovered,
                apisDiscovered: parsed.summary?.apisDiscovered,
            };
        }

        const featureFiles = parsed.generatedFiles?.features ?? [];
        const parsedTestCases: ParsedTestCase[] = (parsed.states ?? []).map(
            (s, i) => ({
                testCaseId: i + 1,
                title: s.title || s.pageType || `State ${i + 1}`,
                state: 'Active',
                tags: [],
                steps: [],
                rawWorkItem: { id: i + 1, fields: {} },
            }),
        );
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
                    ? CSAppUrlModeHandler.safeRead(featureFiles[0])
                    : '',
                scenarios: parsedTestCases.map((tc) => ({
                    id: `TS_${tc.testCaseId}`,
                    title: tc.title,
                    tcId: tc.testCaseId,
                    tags: [],
                })),
                // Live-app exploration discovered real elements, but the
                // generated tests still need human review for business
                // intent (the crawler can't infer "this is checkout").
                needsSourceValidation: true,
            },
            fixtures: {
                content: new Map(),
                filePaths: filesCreated.filter((p) => p.endsWith('.json')),
            },
            filesCreated,
            needsSourceValidation: true,
            warnings: [],
        };

        // Don't override outputRoot — explore_application writes to its own
        // `generated-tests/` sub-directory. We pass-through what it produced.
        // outputRoot is honoured by the other modes; for this one the crawler
        // owns the layout. Surface that fact in the warnings.
        if (options.outputRoot && !filesCreated.some((p) => p.startsWith(outputRoot))) {
            generationResult.warnings.push(
                `Exploration wrote to its own output dir, not '${options.outputRoot}'. Move files manually if needed.`,
            );
        }

        return {
            generationResult,
            url,
            statesDiscovered: parsed.summary?.statesDiscovered,
            apisDiscovered: parsed.summary?.apisDiscovered,
        };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private static deriveProjectName(url: string): string {
        try {
            const host = new URL(url).hostname;
            return host.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
        } catch {
            return 'common';
        }
    }

    private static deriveFeatureName(url: string): string {
        try {
            const u = new URL(url);
            const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
            return last
                ? last.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
                : 'app_explored';
        } catch {
            return 'app_explored';
        }
    }

    private static readConfig(key: string): string {
        try {
            return CSConfigurationManager.getInstance().get(key, '');
        } catch {
            return '';
        }
    }

    private static parseResponse(
        result: MCPToolResult,
    ): ExploreApplicationResponse | null {
        const sc = result.structuredContent as Record<string, unknown> | undefined;
        if (sc && typeof sc === 'object' && Object.keys(sc).length > 0) {
            return sc as unknown as ExploreApplicationResponse;
        }
        const text = CSAppUrlModeHandler.firstText(result);
        if (!text) return null;
        try {
            return JSON.parse(text) as ExploreApplicationResponse;
        } catch {
            return null;
        }
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
        toolName: string,
        params: Record<string, unknown>,
        context: MCPToolContext,
    ): Promise<MCPToolResult> {
        const def = (explorationTools as MCPToolDefinition[]).find(
            (d) => d.tool.name === toolName,
        );
        if (!def) {
            throw new Error(
                `CSAppUrlModeHandler: required tool not registered: ${toolName}`,
            );
        }
        return def.handler(params, context);
    }
}
