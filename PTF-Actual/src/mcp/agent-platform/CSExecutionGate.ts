/**
 * Agentic Test Platform — Execution Gate
 *
 * Wraps test execution with a mandatory pass-gate. Composes existing MCP
 * tools (`compile_check`, `bdd_run_feature`, `commit_ready_check`) plus
 * the CSResultJudge to produce a single boolean verdict.
 *
 * The gate is the architectural primitive guaranteeing that no test reaches
 * a "shippable" state without being executed and judged. All Phase 1 modes
 * route through this gate; Phase 2 generation logic must do the same.
 *
 * @module agent-platform/CSExecutionGate
 */

import {
    MCPToolContext,
    MCPToolDefinition,
    MCPToolResult,
} from '../types/CSMCPTypes';
import { auditTools } from '../tools/audit/CSMCPAuditTools';
import { bddTools } from '../tools/bdd/CSMCPBDDTools';
import { JudgeVerdict } from './types';
import { CSResultJudge } from './CSResultJudge';

// ============================================================================
// Types
// ============================================================================

/**
 * Per-failure entry returned to the caller so the healer can target
 * specific tests by id.
 */
export interface ExecutionGateFailure {
    failureType: string;
    testId: string;
    details: string;
}

/**
 * Aggregate result of one full pass through the gate.
 * `passed` is true iff every step (compile, run, judge, commit-readiness)
 * completed cleanly.
 */
export interface ExecutionGateResult {
    passed: boolean;
    reason: string;
    testsExecuted: number;
    testsPassed: number;
    testsFailedClassified: ExecutionGateFailure[];
    judgeVerdict?: JudgeVerdict;
}

// ============================================================================
// CSExecutionGate
// ============================================================================

/**
 * Static orchestrator. The single public entry point is `execute`, which
 * runs the four-step gate pipeline:
 *
 *   1. compile_check          — TypeScript must compile cleanly
 *   2. bdd_run_feature (each) — every feature must be executable
 *   3. CSResultJudge.judge    — assertions must be meaningful
 *   4. commit_ready_check     — the 9-gate exit bar
 *
 * Any failure short-circuits subsequent steps and returns passed=false
 * with enough detail for an automated healer or human reviewer.
 */
export class CSExecutionGate {
    /**
     * Run the full gate pipeline against a list of feature files.
     *
     * @param featureFiles  Absolute or workspace-relative paths to .feature files
     * @param context       Tool context (provides logging, sampling, etc.)
     * @returns ExecutionGateResult with `passed` true iff every step passed
     */
    public static async execute(
        featureFiles: string[],
        context: MCPToolContext,
    ): Promise<ExecutionGateResult> {
        context.log('info', 'CSExecutionGate: pipeline start', {
            featureCount: featureFiles.length,
        });

        // -- Step 1: compile_check (fail fast) -------------------------------
        const compileResult = await CSExecutionGate.invokeTool(
            auditTools,
            'compile_check',
            {},
            context,
        );
        const compileClean = CSExecutionGate.readBool(compileResult, 'clean');
        if (!compileClean) {
            return {
                passed: false,
                reason: 'compile_check failed',
                testsExecuted: 0,
                testsPassed: 0,
                testsFailedClassified: [
                    {
                        failureType: 'compile',
                        testId: '<workspace>',
                        details: CSExecutionGate.summarize(compileResult),
                    },
                ],
            };
        }

        // -- Step 2: run each feature ----------------------------------------
        let executed = 0;
        let passed = 0;
        const failures: ExecutionGateFailure[] = [];
        const aggregatedLogs: string[] = [];

        for (const featurePath of featureFiles) {
            const runResult = await CSExecutionGate.invokeTool(
                bddTools,
                'bdd_run_feature',
                { path: featurePath },
                context,
            );
            executed += 1;

            if (runResult.isError) {
                failures.push({
                    failureType: 'execution_error',
                    testId: featurePath,
                    details: CSExecutionGate.summarize(runResult),
                });
                continue;
            }

            const featurePassed = CSExecutionGate.readFeaturePassed(runResult);
            if (featurePassed) {
                passed += 1;
            } else {
                failures.push({
                    failureType: 'assertion_failed',
                    testId: featurePath,
                    details: CSExecutionGate.summarize(runResult),
                });
            }
            aggregatedLogs.push(CSExecutionGate.summarize(runResult));
        }

        if (failures.length > 0) {
            return {
                passed: false,
                reason: `${failures.length} of ${executed} feature(s) failed execution`,
                testsExecuted: executed,
                testsPassed: passed,
                testsFailedClassified: failures,
            };
        }

        // -- Step 3: judge result quality ------------------------------------
        const firstFeature = featureFiles[0] ?? '';
        const judgeVerdict = await CSResultJudge.judge(
            firstFeature,
            '',
            aggregatedLogs.join('\n\n'),
            context,
        );
        if (judgeVerdict.verdict === 'FAIL') {
            return {
                passed: false,
                reason: 'CSResultJudge returned FAIL — assertions not meaningful',
                testsExecuted: executed,
                testsPassed: passed,
                testsFailedClassified: [
                    {
                        failureType: 'judge_fail',
                        testId: firstFeature,
                        details: judgeVerdict.reasoning,
                    },
                ],
                judgeVerdict,
            };
        }

        // -- Step 4: commit_ready_check --------------------------------------
        const commitResult = await CSExecutionGate.invokeTool(
            auditTools,
            'commit_ready_check',
            { files: featureFiles, healerGreen: true },
            context,
        );
        const commitReady = CSExecutionGate.readBool(commitResult, 'ready');
        if (!commitReady) {
            return {
                passed: false,
                reason: 'commit_ready_check failed',
                testsExecuted: executed,
                testsPassed: passed,
                testsFailedClassified: [
                    {
                        failureType: 'commit_gate',
                        testId: '<workspace>',
                        details: CSExecutionGate.summarize(commitResult),
                    },
                ],
                judgeVerdict,
            };
        }

        // -- All gates green -------------------------------------------------
        context.log('info', 'CSExecutionGate: all gates passed');
        return {
            passed: true,
            reason: 'all gates passed',
            testsExecuted: executed,
            testsPassed: passed,
            testsFailedClassified: [],
            judgeVerdict,
        };
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    /**
     * Look up a tool by name in a definition array and invoke its handler.
     * Throws a descriptive error if the tool is not present (which would
     * indicate a registration mismatch rather than a runtime user error).
     */
    private static async invokeTool(
        defs: MCPToolDefinition[],
        toolName: string,
        params: Record<string, unknown>,
        context: MCPToolContext,
    ): Promise<MCPToolResult> {
        const def = defs.find((d) => d.tool.name === toolName);
        if (!def) {
            throw new Error(
                `CSExecutionGate: tool not registered: ${toolName}`,
            );
        }
        return def.handler(params, context);
    }

    /**
     * Read a boolean field from the tool result's structuredContent.
     * Returns false if the field is missing or non-boolean.
     */
    private static readBool(result: MCPToolResult, field: string): boolean {
        if (result.isError) return false;
        const sc = result.structuredContent as
            | Record<string, unknown>
            | undefined;
        if (!sc) return false;
        return sc[field] === true;
    }

    /**
     * Determine whether a feature execution result indicates a pass.
     * BDD runners surface this differently across versions; we accept any
     * of: structuredContent.passed === true, structuredContent.failed === 0,
     * or structuredContent.status === 'passed'.
     */
    private static readFeaturePassed(result: MCPToolResult): boolean {
        if (result.isError) return false;
        const sc = result.structuredContent as
            | Record<string, unknown>
            | undefined;
        if (!sc) {
            // No structured content — fall back to text inspection.
            const text = CSExecutionGate.summarize(result).toLowerCase();
            return /\bpassed\b/.test(text) && !/\bfailed\b/.test(text);
        }
        if (sc.passed === true) return true;
        if (sc.status === 'passed') return true;
        if (
            typeof sc.failed === 'number' &&
            sc.failed === 0 &&
            typeof sc.passed === 'number' &&
            sc.passed > 0
        ) {
            return true;
        }
        return false;
    }

    /**
     * Render a tool result down to a single string suitable for inclusion
     * in failure detail or judge prompts.
     */
    private static summarize(result: MCPToolResult): string {
        const parts: string[] = [];
        for (const c of result.content) {
            if (c.type === 'text') {
                parts.push(c.text);
            }
        }
        return parts.join('\n').slice(0, 8 * 1024);
    }
}
