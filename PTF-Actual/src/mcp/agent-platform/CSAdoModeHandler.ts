/**
 * Agentic Test Platform — ADO Mode Handler
 *
 * Resolves an `ado_test_case_id` / `ado_test_suite_id` / `ado_test_plan_id`
 * intent into a concrete set of ParsedTestCases, then drives the generation
 * orchestrator end-to-end. The flow is doc-grounded against the Azure
 * DevOps REST API 7.1 spec and avoids WIQL — it navigates from
 * plans → suites → suite test cases → batch fetch by IDs.
 *
 * Privacy-by-design: contains no domain, organization, or project-specific
 * identifiers. The ADO common params (org / project / PAT) are received via
 * argument and never logged in cleartext.
 *
 * @module agent-platform/CSAdoModeHandler
 */

import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { azureDevOpsTools } from '../tools/cicd/CSMCPAzureDevOpsTools';
import { CSAdoTestCaseParser, ParsedTestCase } from './CSAdoTestCaseParser';
import {
    CSGenerationOrchestrator,
    GenerationResult,
} from './CSGenerationOrchestrator';
import { CSCostTelemetry } from './CSCostTelemetry';
import { ClassifiedInput } from './types';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';

// ============================================================================
// Public Types
// ============================================================================

/**
 * ADO common params (organization / project / PAT) required by every ADO
 * tool invocation. The PAT is never logged.
 */
export interface AdoCommonParams {
    organization: string;
    project: string;
    pat: string;
}

/**
 * Optional knobs passed by the master tool. All have safe defaults so the
 * handler works on a vanilla `cs_ai_auto_assist` invocation.
 */
export interface AdoModeHandlerOptions {
    moduleName?: string;
    featureName?: string;
    appSourcePath?: string;
    outputRoot?: string;
    envs?: string[];
    telemetry?: CSCostTelemetry;
    /**
     * Cap on test cases to fetch per run. Protects against
     * accidentally pulling thousands of cases from a top-level plan.
     */
    maxTestCases?: number;
}

/**
 * Aggregate handler result. `generationResult` is null when the cascade
 * fails before reaching the orchestrator (missing creds, no IDs resolved,
 * etc.).
 */
export interface AdoModeHandlerResult {
    generationResult: GenerationResult | null;
    testCaseIds: number[];
    /**
     * Reason the handler short-circuited. When `generationResult` is
     * non-null this is undefined.
     */
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
}

// ============================================================================
// CSAdoModeHandler
// ============================================================================

/**
 * Static handler. Single public entry point: `handle`.
 */
export class CSAdoModeHandler {
    /** Default fixture envs when the master tool does not override. */
    private static readonly DEFAULT_ENVS = ['dev', 'sit', 'uat'];
    /** Default output root relative to the consumer repo CWD. */
    private static readonly DEFAULT_OUTPUT_ROOT = 'generated';
    /** Hard cap on per-run test case count. */
    private static readonly DEFAULT_MAX_TEST_CASES = 200;
    /** ADO `ado_work_items_get_batch` page size (REST API limit is 200). */
    private static readonly BATCH_PAGE_SIZE = 200;

    /**
     * Drive the full ADO mode pipeline:
     *   1. Resolve the input mode → list of test case IDs (REST cascade).
     *   2. Batch-fetch each work item with $expand=fields.
     *   3. Parse each via CSAdoTestCaseParser.
     *   4. Run CSGenerationOrchestrator.
     */
    public static async handle(
        classified: ClassifiedInput,
        adoCommon: AdoCommonParams,
        options: AdoModeHandlerOptions,
        context: MCPToolContext,
    ): Promise<AdoModeHandlerResult> {
        // Resolve creds: param > CSConfigurationManager (ADO_*) > empty.
        // The configuration manager auto-decrypts `ENCRYPTED:` values, so
        // the PAT we end up with is always plaintext.
        adoCommon = {
            organization:
                adoCommon.organization ||
                CSAdoModeHandler.readConfig('ADO_ORGANIZATION'),
            project:
                adoCommon.project ||
                CSAdoModeHandler.readConfig('ADO_PROJECT'),
            pat: adoCommon.pat || CSAdoModeHandler.readConfig('ADO_PAT'),
        };
        if (
            !adoCommon.organization ||
            !adoCommon.project ||
            !adoCommon.pat
        ) {
            const missing: string[] = [];
            if (!adoCommon.organization) missing.push('organization (ADO_ORGANIZATION)');
            if (!adoCommon.project) missing.push('project (ADO_PROJECT)');
            if (!adoCommon.pat) missing.push('pat (ADO_PAT)');
            return {
                generationResult: null,
                testCaseIds: [],
                blockedReason: `CSAdoModeHandler: ADO credentials incomplete — missing ${missing.join(', ')}. Set in your .env or pass via tool params.`,
            };
        }

        const ef = classified.extractedFields;
        const maxCases =
            options.maxTestCases ?? CSAdoModeHandler.DEFAULT_MAX_TEST_CASES;

        // -- Step 1: resolve test case IDs ----------------------------------
        let testCaseIds: number[] = [];
        try {
            if (classified.mode === 'ado_test_case_id') {
                const id = Number(ef.id);
                if (!Number.isFinite(id) || id <= 0) {
                    return {
                        generationResult: null,
                        testCaseIds: [],
                        blockedReason: `Invalid test case id: ${ef.id}`,
                    };
                }
                testCaseIds = [id];
            } else if (classified.mode === 'ado_test_suite_id') {
                const planId = Number(ef.planId);
                const suiteId = Number(ef.id);
                if (!Number.isFinite(planId) || !Number.isFinite(suiteId)) {
                    return {
                        generationResult: null,
                        testCaseIds: [],
                        blockedReason: `Invalid plan/suite ids: planId=${ef.planId}, suiteId=${ef.id}`,
                    };
                }
                testCaseIds = await CSAdoModeHandler.idsForSuite(
                    adoCommon,
                    planId,
                    suiteId,
                    context,
                );
            } else if (classified.mode === 'ado_test_plan_id') {
                const planId = Number(ef.id);
                if (!Number.isFinite(planId) || planId <= 0) {
                    return {
                        generationResult: null,
                        testCaseIds: [],
                        blockedReason: `Invalid plan id: ${ef.id}`,
                    };
                }
                testCaseIds = await CSAdoModeHandler.idsForPlan(
                    adoCommon,
                    planId,
                    ef.suiteFilter,
                    context,
                );
            } else {
                return {
                    generationResult: null,
                    testCaseIds: [],
                    blockedReason: `CSAdoModeHandler: unsupported mode '${classified.mode}'`,
                };
            }
        } catch (err) {
            return {
                generationResult: null,
                testCaseIds: [],
                blockedReason: 'CSAdoModeHandler: ID resolution failed',
                blockedDetails: {
                    error: err instanceof Error ? err.message : String(err),
                },
            };
        }

        if (testCaseIds.length === 0) {
            return {
                generationResult: null,
                testCaseIds: [],
                blockedReason:
                    'CSAdoModeHandler: no test cases resolved from input — verify the plan/suite has test cases attached',
            };
        }

        if (testCaseIds.length > maxCases) {
            context.log(
                'warning',
                `CSAdoModeHandler: capping fetch at ${maxCases} of ${testCaseIds.length} resolved cases`,
            );
            testCaseIds = testCaseIds.slice(0, maxCases);
        }

        // -- Step 2: batch fetch with $expand=fields ------------------------
        let workItems: Array<Record<string, unknown>>;
        try {
            workItems = await CSAdoModeHandler.batchFetch(
                adoCommon,
                testCaseIds,
                context,
            );
        } catch (err) {
            return {
                generationResult: null,
                testCaseIds,
                blockedReason: 'CSAdoModeHandler: batch fetch failed',
                blockedDetails: {
                    error: err instanceof Error ? err.message : String(err),
                },
            };
        }

        // -- Step 3: parse -------------------------------------------------
        const parsedTestCases: ParsedTestCase[] = workItems
            .map((wi) => {
                try {
                    return CSAdoTestCaseParser.parse(wi);
                } catch (err) {
                    context.log(
                        'warning',
                        'CSAdoModeHandler: parse failed for one work item',
                        {
                            error:
                                err instanceof Error ? err.message : String(err),
                        },
                    );
                    return null;
                }
            })
            .filter((tc): tc is ParsedTestCase => tc !== null);

        if (parsedTestCases.length === 0) {
            return {
                generationResult: null,
                testCaseIds,
                blockedReason:
                    'CSAdoModeHandler: every fetched work item failed to parse — check that the IDs are Test Case work items, not Bugs/Tasks',
            };
        }

        // -- Step 4: derive module / feature names if not supplied ----------
        const { moduleName, featureName } = CSAdoModeHandler.deriveNames(
            classified,
            options,
            parsedTestCases,
        );

        const envs = options.envs && options.envs.length > 0
            ? options.envs
            : CSAdoModeHandler.DEFAULT_ENVS;
        const outputRoot = options.outputRoot ?? CSAdoModeHandler.DEFAULT_OUTPUT_ROOT;

        // -- Step 5: generation -------------------------------------------
        const generationResult = await CSGenerationOrchestrator.orchestrate(
            {
                mode: classified.mode as
                    | 'ado_test_case_id'
                    | 'ado_test_suite_id'
                    | 'ado_test_plan_id',
                testCases: parsedTestCases,
                moduleName,
                featureName,
                appSourcePath: options.appSourcePath,
                envs,
                outputRoot,
                telemetry: options.telemetry,
            },
            context,
        );

        return {
            generationResult,
            testCaseIds: parsedTestCases.map((tc) => tc.testCaseId),
        };
    }

    // ========================================================================
    // ID resolution
    // ========================================================================

    /**
     * Resolve all test case IDs in a single suite. Calls
     * `ado_test_suite_test_cases_list` and pulls the work item id from each
     * returned record (shape: `{ workItem: { id } }`).
     */
    private static async idsForSuite(
        adoCommon: AdoCommonParams,
        planId: number,
        suiteId: number,
        context: MCPToolContext,
    ): Promise<number[]> {
        const result = await CSAdoModeHandler.invokeAdo(
            'ado_test_suite_test_cases_list',
            { ...adoCommon, planId, suiteId },
            context,
        );
        if (result.isError) {
            throw new Error(
                `ado_test_suite_test_cases_list failed for suite ${suiteId}`,
            );
        }
        const sc = result.structuredContent as Record<string, unknown> | undefined;
        const cases = (sc?.testCases as Array<Record<string, unknown>>) ?? [];
        const ids: number[] = [];
        for (const c of cases) {
            const wi = c?.workItem as Record<string, unknown> | undefined;
            const id = typeof wi?.id === 'number' ? wi.id : Number(wi?.id);
            if (Number.isFinite(id) && id > 0) ids.push(id);
        }
        return ids;
    }

    /**
     * Resolve all test case IDs in a plan. Walks every suite (filtered by
     * `suiteFilter` if provided) and aggregates IDs. Static-suite-only is
     * good enough for Phase 2A — query / requirement suites surface the
     * same TestCase shape via the same endpoint.
     */
    private static async idsForPlan(
        adoCommon: AdoCommonParams,
        planId: number,
        suiteFilter: string | undefined,
        context: MCPToolContext,
    ): Promise<number[]> {
        const suitesResult = await CSAdoModeHandler.invokeAdo(
            'ado_test_suites_list',
            { ...adoCommon, planId },
            context,
        );
        if (suitesResult.isError) {
            throw new Error(`ado_test_suites_list failed for plan ${planId}`);
        }
        const sc = suitesResult.structuredContent as
            | Record<string, unknown>
            | undefined;
        const suites = (sc?.suites as Array<Record<string, unknown>>) ?? [];

        const matching = suiteFilter
            ? suites.filter((s) =>
                  String(s?.name ?? '')
                      .toLowerCase()
                      .startsWith(String(suiteFilter).toLowerCase()),
              )
            : suites;

        const allIds = new Set<number>();
        for (const s of matching) {
            const sid = typeof s?.id === 'number' ? s.id : Number(s?.id);
            if (!Number.isFinite(sid) || sid <= 0) continue;
            try {
                const ids = await CSAdoModeHandler.idsForSuite(
                    adoCommon,
                    planId,
                    sid,
                    context,
                );
                for (const id of ids) allIds.add(id);
            } catch (err) {
                context.log(
                    'warning',
                    `CSAdoModeHandler: skipping suite ${sid} after error`,
                    {
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }
        }
        return Array.from(allIds);
    }

    // ========================================================================
    // Batch fetch
    // ========================================================================

    /**
     * Fetch every work item for the supplied IDs in chunks of 200 (the
     * Azure DevOps batch endpoint cap). Uses errorPolicy=omit so a single
     * deleted ID does not abort the run.
     */
    private static async batchFetch(
        adoCommon: AdoCommonParams,
        ids: number[],
        context: MCPToolContext,
    ): Promise<Array<Record<string, unknown>>> {
        const out: Array<Record<string, unknown>> = [];
        for (let i = 0; i < ids.length; i += CSAdoModeHandler.BATCH_PAGE_SIZE) {
            const chunk = ids.slice(i, i + CSAdoModeHandler.BATCH_PAGE_SIZE);
            const result = await CSAdoModeHandler.invokeAdo(
                'ado_work_items_get_batch',
                {
                    ...adoCommon,
                    ids: chunk,
                    expand: 'fields',
                    errorPolicy: 'omit',
                },
                context,
            );
            if (result.isError) {
                throw new Error(
                    `ado_work_items_get_batch failed for chunk starting at index ${i}`,
                );
            }
            const sc = result.structuredContent as
                | Record<string, unknown>
                | undefined;
            const items =
                (sc?.workItems as Array<Record<string, unknown>>) ?? [];
            out.push(...items);
        }
        return out;
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Pick a module / feature name. Priority: explicit options → router-
     * extracted fields → first parsed test case title heuristic → safe
     * defaults.
     */
    private static deriveNames(
        classified: ClassifiedInput,
        options: AdoModeHandlerOptions,
        parsedTestCases: ParsedTestCase[],
    ): { moduleName: string; featureName: string } {
        const ef = classified.extractedFields;
        const moduleName =
            options.moduleName ||
            ef.moduleName ||
            CSAdoModeHandler.firstWord(parsedTestCases[0]?.title) ||
            'GeneratedModule';
        const featureName =
            options.featureName ||
            ef.featureName ||
            CSAdoModeHandler.firstNoun(parsedTestCases[0]?.title) ||
            'GeneratedFeature';
        return { moduleName, featureName };
    }

    /**
     * Take the first whitespace-separated word from a string, sanitised to
     * letters/digits only. Returns empty string when the input has no
     * usable token.
     */
    private static firstWord(s?: string): string {
        if (!s) return '';
        const m = s.match(/[A-Za-z][A-Za-z0-9]*/);
        return m ? m[0] : '';
    }

    /**
     * Take the second word (often the noun phrase head after a verb like
     * "Verify"/"Create"/"Update"). Falls back to first word.
     */
    private static firstNoun(s?: string): string {
        if (!s) return '';
        const tokens = s.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
        return tokens[1] ?? tokens[0] ?? '';
    }

    /**
     * Read a key from CSConfigurationManager. Returns empty string when the
     * manager is uninitialized or the key is unset; the manager decrypts
     * `ENCRYPTED:` payloads transparently.
     */
    private static readConfig(key: string): string {
        try {
            return CSConfigurationManager.getInstance().get(key, '');
        } catch {
            return '';
        }
    }

    /**
     * Look up an ADO tool by name and invoke it. Throws if the tool is not
     * registered — that is a build-time mismatch, not a user error.
     */
    private static async invokeAdo(
        toolName: string,
        params: Record<string, unknown>,
        context: MCPToolContext,
    ): Promise<MCPToolResult> {
        const def = (azureDevOpsTools as MCPToolDefinition[]).find(
            (d) => d.tool.name === toolName,
        );
        if (!def) {
            throw new Error(
                `CSAdoModeHandler: required ADO tool not registered: ${toolName}`,
            );
        }
        return def.handler(params, context);
    }
}
