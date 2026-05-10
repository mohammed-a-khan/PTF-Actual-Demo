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
 * **Rebuild note (post-deletion of `CSGenerationOrchestrator` /
 * `CSStepToGherkinTranslator`):** the input is now `PipelineOutput`
 * (lightweight types from `./types`). Gherkin Given/When/Then are parsed
 * directly from the feature-file content per scenario — no `GherkinTranslation`
 * intermediate is required. This decouples create-back from the old
 * generation pipeline so the new translator can produce the same
 * `PipelineOutput` shape and create-back works unchanged.
 *
 * @module agent-platform/CSAdoCreateBackFlow
 */

import * as fs from 'fs';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { azureDevOpsTools } from '../tools/cicd/CSMCPAzureDevOpsTools';
import { CSConstitutionalSafety } from './CSConstitutionalSafety';
import { CSPiiSanitizer } from './CSPiiSanitizer';
import { CSAdoTestCaseParser } from './CSAdoTestCaseParser';
import {
    GeneratedFeatureSummary,
    GeneratedScenarioSummary,
    PipelineOutput,
} from './types';

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
     * Walk the pipeline output, create one ADO test case per scenario
     * that lacks a `@TC_<id>` tag, attach it to the target suite, and
     * update the feature file in place.
     *
     * @param pipelineOutput   Output of the new pipeline (featureFiles + filesCreated).
     * @param targetPlanId     Plan to attach the new cases to.
     * @param targetSuiteId    Suite to attach the new cases to.
     * @param adoCommon        Org / project / PAT.
     * @param context          MCP tool context (used for logging + tool calls).
     */
    public static async maybeCreateBack(
        pipelineOutput: PipelineOutput,
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

        if (!pipelineOutput.featureFiles || pipelineOutput.featureFiles.length === 0) {
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

        for (const featureFile of pipelineOutput.featureFiles) {
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

                // Parse Given/When/Then directly from the feature content.
                const stepsXml = CSAdoCreateBackFlow.buildStepsXmlForScenario(
                    scenario,
                    featureFile,
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

            // -- Update this feature file with new @TC_ tags ----------------
            const newLinksForThisFile = result.linkedScenarios.filter((l) =>
                featureFile.scenarios.some((s) => s.id === l.scenarioId),
            );
            if (newLinksForThisFile.length > 0) {
                const updated = CSAdoCreateBackFlow.injectTcTags(
                    featureFile.content,
                    newLinksForThisFile,
                );
                if (updated !== featureFile.content) {
                    try {
                        fs.writeFileSync(featureFile.filePath, updated, 'utf-8');
                        result.updatedFiles.push(featureFile.filePath);
                        featureFile.content = updated;
                        for (const link of newLinksForThisFile) {
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
                                filePath: featureFile.filePath,
                                error:
                                    err instanceof Error ? err.message : String(err),
                            },
                        );
                    }
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
     * Parses Given/When/Then lines directly from the feature-file content
     * inside the scenario block. No `GherkinTranslation` intermediate is
     * required — we read what's actually in the file.
     *
     * Returns null when the scenario block can't be located or has zero
     * step lines (in which case ADO falls back to an empty test case).
     */
    private static buildStepsXmlForScenario(
        scenario: GeneratedScenarioSummary,
        featureFile: GeneratedFeatureSummary,
    ): string | null {
        const block = CSAdoCreateBackFlow.extractScenarioBlock(
            featureFile.content,
            scenario,
        );
        if (!block) return null;

        const steps: Array<{ action: string; expected: string }> = [];
        for (const rawLine of block.split(/\r?\n/)) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            const m = trimmed.match(/^(Given|When|Then|And|But)\b\s+(.+)$/i);
            if (!m) continue;
            const keyword = m[1];
            const body = m[2].trim();
            const action = `${keyword.charAt(0).toUpperCase() + keyword.slice(1).toLowerCase()} ${body}`;
            // Only `Then` lines populate the expected-result column; for
            // others ADO renders the action only.
            const expected = /^then\b/i.test(keyword) ? body : '';
            steps.push({ action, expected });
        }
        if (steps.length === 0) return null;
        return CSAdoTestCaseParser.serializeStepsXml(steps);
    }

    /**
     * Slice the lines of a single scenario out of the feature content,
     * starting at the `Scenario:` / `Scenario Outline:` line and stopping
     * at the next `Scenario:` / `Scenario Outline:` line, the next
     * `Examples:` line, or end-of-file.
     *
     * Tolerates indentation, optional leading tags, and both compact and
     * outline scenario keywords.
     */
    private static extractScenarioBlock(
        content: string,
        scenario: GeneratedScenarioSummary,
    ): string | null {
        const lines = content.split(/\r?\n/);
        // Find the scenario line. Match by id (most reliable when scenarios
        // include `@<id>` tag) or by title text after the keyword.
        const idTag = `@${scenario.id}`;
        const titleEsc = CSAdoCreateBackFlow.escapeRegex(scenario.title);
        const titleRe = new RegExp(
            `^[\\t ]*Scenario(?: Outline)?:\\s*(?:${CSAdoCreateBackFlow.escapeRegex(scenario.id)}\\b|${titleEsc}\\b)`,
            'i',
        );

        let startIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (titleRe.test(lines[i])) {
                startIdx = i;
                break;
            }
            // Tag-line match: `@<id>` immediately precedes the scenario.
            if (lines[i].includes(idTag)) {
                for (let j = i + 1; j < lines.length && j < i + 8; j++) {
                    if (/^[\t ]*Scenario(?: Outline)?:/i.test(lines[j])) {
                        startIdx = j;
                        break;
                    }
                }
                if (startIdx >= 0) break;
            }
        }
        if (startIdx < 0) return null;

        const stopRe = /^[\t ]*(?:Scenario(?: Outline)?:|Examples:)/i;
        let endIdx = lines.length;
        for (let i = startIdx + 1; i < lines.length; i++) {
            if (stopRe.test(lines[i])) {
                endIdx = i;
                break;
            }
        }
        return lines.slice(startIdx + 1, endIdx).join('\n');
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
     * Insert a `@TC_<id>` tag in front of the matching scenario line.
     * Idempotent — refuses to add a duplicate tag.
     */
    private static injectTcTags(
        featureContent: string,
        links: { scenarioId: string; tcId: number }[],
    ): string {
        let out = featureContent;
        for (const link of links) {
            const tag = `@TC_${link.tcId}`;
            if (out.includes(tag)) continue;
            const idEsc = CSAdoCreateBackFlow.escapeRegex(link.scenarioId);
            const re = new RegExp(
                `(^[\\t ]*Scenario(?: Outline)?:\\s*${idEsc}\\b)`,
                'gm',
            );
            out = out.replace(re, `${tag}\n$1`);
        }
        return out;
    }

    private static escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
