/**
 * Agentic Test Platform — ADO Create-Back Flow
 *
 * After tests pass and the user opts in, this flow creates ADO test cases
 * for any generated scenario that does not already carry a `@TC_<id>` tag,
 * and links the new IDs back into the feature file by prepending a
 * `@TC_<id>` tag to the scenario.
 *
 * The flow runs through `CSConstitutionalSafety.checkAction` for every
 * tool invocation; the master tool is also expected to obtain explicit
 * user opt-in via Elicitation before calling into this module.
 *
 * Privacy-by-design: scenario titles are sanitised through `CSPiiSanitizer`
 * before being submitted to the ADO API.
 *
 * @module agent-platform/CSAdoCreateBackFlow
 */

import * as fs from 'fs';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { azureDevOpsTools } from '../tools/cicd/CSMCPAzureDevOpsTools';
import { CSConstitutionalSafety } from './CSConstitutionalSafety';
import { CSPiiSanitizer } from './CSPiiSanitizer';
import { GenerationResult } from './CSGenerationOrchestrator';
import { CSAdoTestCaseParser } from './CSAdoTestCaseParser';
import { GherkinTranslation } from './CSStepToGherkinTranslator';

// ============================================================================
// Public Types
// ============================================================================

/**
 * One create-back run's outcome.
 */
export interface CreateBackResult {
    createdTestCaseIds: number[];
    linkedScenarios: { scenarioId: string; tcId: number }[];
    updatedFiles: string[];
    skipped: { scenarioId: string; reason: string }[];
}

/**
 * Common ADO call params required by every tool invocation.
 */
export interface AdoCommonParams {
    organization: string;
    project: string;
    pat: string;
}

// ============================================================================
// CSAdoCreateBackFlow
// ============================================================================

/**
 * Static flow. Single public entry point: `maybeCreateBack`.
 */
export class CSAdoCreateBackFlow {
    /**
     * Walk the generation result, create one ADO test case per scenario
     * that lacks a `@TC_<id>` tag, attach it to the target suite, and
     * update the feature file in place.
     *
     * @param generationResult The result of `CSGenerationOrchestrator.orchestrate`.
     * @param targetPlanId     Plan to attach the new cases to.
     * @param targetSuiteId    Suite to attach the new cases to.
     * @param adoCommon        Org / project / PAT.
     * @param context          MCP tool context (used for logging + tool calls).
     */
    public static async maybeCreateBack(
        generationResult: GenerationResult,
        targetPlanId: number,
        targetSuiteId: number,
        adoCommon: AdoCommonParams,
        context: MCPToolContext,
    ): Promise<CreateBackResult> {
        const result: CreateBackResult = {
            createdTestCaseIds: [],
            linkedScenarios: [],
            updatedFiles: [],
            skipped: [],
        };

        if (
            !adoCommon ||
            !adoCommon.organization ||
            !adoCommon.project ||
            !adoCommon.pat
        ) {
            context.log(
                'warning',
                'CSAdoCreateBackFlow: missing ADO common params; skipping',
            );
            return result;
        }

        const featureFile = generationResult.featureFile;
        if (!featureFile || featureFile.scenarios.length === 0) {
            return result;
        }

        const adoCreate = (azureDevOpsTools as MCPToolDefinition[]).find(
            (d) => d.tool.name === 'ado_work_items_create',
        );
        const adoAdd = (azureDevOpsTools as MCPToolDefinition[]).find(
            (d) => d.tool.name === 'ado_test_suite_add_test_cases',
        );
        if (!adoCreate || !adoAdd) {
            context.log(
                'warning',
                'CSAdoCreateBackFlow: required ADO tools not registered',
            );
            return result;
        }

        for (const scenario of featureFile.scenarios) {
            // Skip scenarios already tied to an ADO test case.
            const hasTc = scenario.tags.some((t) => /^@TC_\d+$/.test(t));
            if (hasTc) {
                result.skipped.push({
                    scenarioId: scenario.id,
                    reason: 'already has @TC_ tag',
                });
                continue;
            }

            // Sanitise the title before sending it over the wire.
            const titleSan = CSPiiSanitizer.sanitize(scenario.title, 'redact');
            const safeTitle = titleSan.cleaned || `Scenario ${scenario.id}`;

            // Locate this scenario's translation so we can ship a real
            // Steps XML payload instead of an empty placeholder.
            const stepsXml = CSAdoCreateBackFlow.buildStepsXmlForScenario(
                scenario.id,
                generationResult,
            );

            const fields: Record<string, unknown> = {};
            if (stepsXml) {
                fields['Microsoft.VSTS.TCM.Steps'] = stepsXml;
            }

            const createParams: Record<string, unknown> = {
                organization: adoCommon.organization,
                project: adoCommon.project,
                pat: adoCommon.pat,
                type: 'Test Case',
                title: safeTitle,
                description:
                    'Auto-generated by CS-AI-Auto-Assist. ' +
                    'Replace this description with your own once verified.',
                tags: scenario.tags
                    .filter((t) => !t.startsWith('@TC_'))
                    .map((t) => t.replace(/^@/, '')),
                fields,
            };

            // Constitutional safety check before invoking.
            const violations = CSConstitutionalSafety.checkAction({
                tool: 'ado_work_items_create',
                params: createParams,
            });
            const hardBlocks = violations.filter(
                (v) => v.severity === 'HARD_BLOCK',
            );
            if (hardBlocks.length > 0) {
                context.log(
                    'warning',
                    'CSAdoCreateBackFlow: HARD_BLOCK; skipping',
                    {
                        scenarioId: scenario.id,
                        rules: hardBlocks.map((v) => v.rule),
                    },
                );
                result.skipped.push({
                    scenarioId: scenario.id,
                    reason: `safety: ${hardBlocks.map((v) => v.rule).join(',')}`,
                });
                continue;
            }

            const createRes = await adoCreate.handler(createParams, context);
            if (createRes.isError) {
                result.skipped.push({
                    scenarioId: scenario.id,
                    reason: 'ado_work_items_create failed',
                });
                continue;
            }
            const newId = CSAdoCreateBackFlow.extractCreatedId(createRes);
            if (!newId) {
                result.skipped.push({
                    scenarioId: scenario.id,
                    reason: 'no id returned from create',
                });
                continue;
            }

            // Attach to the target suite (batch tool accepts array).
            const addParams: Record<string, unknown> = {
                organization: adoCommon.organization,
                project: adoCommon.project,
                pat: adoCommon.pat,
                planId: targetPlanId,
                suiteId: targetSuiteId,
                testCaseIds: [newId],
            };
            const addRes = await adoAdd.handler(addParams, context);
            if (addRes.isError) {
                result.skipped.push({
                    scenarioId: scenario.id,
                    reason: 'ado_test_suite_add_test_cases failed',
                });
                // The work item was still created, so we can keep its id.
            }

            result.createdTestCaseIds.push(newId);
            result.linkedScenarios.push({
                scenarioId: scenario.id,
                tcId: newId,
            });
        }

        // -- Update the feature file with new @TC_ tags ----------------------
        if (result.linkedScenarios.length > 0) {
            const updated = CSAdoCreateBackFlow.injectTcTags(
                featureFile.content,
                result.linkedScenarios,
            );
            if (updated !== featureFile.content) {
                try {
                    fs.writeFileSync(
                        CSAdoCreateBackFlow.relativeToFeaturePath(generationResult),
                        updated,
                        'utf-8',
                    );
                    result.updatedFiles.push(
                        CSAdoCreateBackFlow.relativeToFeaturePath(generationResult),
                    );
                    featureFile.content = updated;
                    for (const link of result.linkedScenarios) {
                        const scen = featureFile.scenarios.find(
                            (s) => s.id === link.scenarioId,
                        );
                        if (scen) {
                            scen.tcId = link.tcId;
                            const tag = `@TC_${link.tcId}`;
                            if (!scen.tags.includes(tag)) {
                                scen.tags.unshift(tag);
                            }
                        }
                    }
                } catch (err) {
                    context.log(
                        'warning',
                        'CSAdoCreateBackFlow: failed to update feature file',
                        {
                            error:
                                err instanceof Error ? err.message : String(err),
                        },
                    );
                }
            }
        }

        return result;
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    /**
     * Build a Microsoft.VSTS.TCM.Steps XML payload for a generated scenario.
     *
     * Maps the scenario back to its original `GherkinTranslation` (1:1 with
     * the orchestrator's testCases array) and emits one ADO ActionStep per
     * Given/When/Then line. The Gherkin keyword is preserved in the action
     * text so a manual reader can still see what the step represents.
     *
     * Returns null when the scenario has no translation (Mode B from-scratch
     * cases that bypassed translation, or when a scenario id can't be matched
     * — in which case the create-back falls back to an empty test case).
     */
    private static buildStepsXmlForScenario(
        scenarioId: string,
        generationResult: GenerationResult,
    ): string | null {
        const idx = generationResult.testCases.findIndex(
            (tc) => `TS_${tc.testCaseId}` === scenarioId,
        );
        if (idx < 0) return null;
        const tr: GherkinTranslation | undefined =
            generationResult.translations[idx];
        if (!tr) return null;

        const steps: Array<{ action: string; expected: string }> = [];
        for (const g of tr.given) steps.push({ action: `Given ${g}`, expected: '' });
        for (const w of tr.when) steps.push({ action: `When ${w}`, expected: '' });
        for (const t of tr.then) steps.push({ action: `Then ${t}`, expected: t });
        if (steps.length === 0) return null;
        return CSAdoTestCaseParser.serializeStepsXml(steps);
    }

    /**
     * Pull the new work-item id out of an ado_work_items_create response.
     * The Phase 1 wrapper returns either `{ workItem: { id } }` or the raw
     * payload depending on success path.
     */
    private static extractCreatedId(result: MCPToolResult): number | null {
        const sc = result.structuredContent as
            | Record<string, unknown>
            | undefined;
        if (!sc) return null;
        const wi = sc.workItem as Record<string, unknown> | undefined;
        if (wi && typeof wi.id === 'number' && Number.isFinite(wi.id)) {
            return wi.id;
        }
        if (typeof sc.id === 'number' && Number.isFinite(sc.id)) return sc.id;
        return null;
    }

    /**
     * Insert a `@TC_<id>` tag in front of the matching `Scenario Outline`
     * line. Idempotent — refuses to add a duplicate tag.
     */
    private static injectTcTags(
        featureContent: string,
        links: { scenarioId: string; tcId: number }[],
    ): string {
        let out = featureContent;
        for (const link of links) {
            const tag = `@TC_${link.tcId}`;
            const re = new RegExp(
                `(^[\\t ]*Scenario Outline:\\s*${CSAdoCreateBackFlow.escapeRegex(
                    link.scenarioId,
                )}\\b)`,
                'gm',
            );
            if (out.includes(tag)) continue;
            out = out.replace(re, `${tag}\n$1`);
        }
        return out;
    }

    /**
     * Resolve the absolute path of the feature file inside the
     * generation result. The orchestrator stores files in `filesCreated`
     * with absolute paths; we pick the first `.feature` entry.
     */
    private static relativeToFeaturePath(generationResult: GenerationResult): string {
        const f = generationResult.filesCreated.find((p) =>
            p.endsWith('.feature'),
        );
        if (!f) {
            throw new Error(
                'CSAdoCreateBackFlow: no .feature file in generation result',
            );
        }
        return f;
    }

    private static escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
