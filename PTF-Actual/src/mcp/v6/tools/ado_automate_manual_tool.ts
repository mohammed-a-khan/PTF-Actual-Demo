/**
 * cs_qa_automate_manual — end-to-end automation of ONE manual ADO Test
 * Case.
 *
 * Steps
 *  1. GET the test case (with $expand=all).
 *  2. If Microsoft.VSTS.TCM.AutomationStatus === 'Automated', return
 *     early with `alreadyAutomated:true` and echo the existing AutomatedTest*
 *     field values so the caller can decide.
 *  3. Delegate to runUiScaffold(...) which generates the full artifact set
 *     (page object / feature / steps / data / env).
 *  4. PATCH the TC's Automation fields:
 *       Microsoft.VSTS.TCM.AutomationStatus     = 'Automated'
 *       Microsoft.VSTS.TCM.AutomatedTestName    = <slug>.<PageName>#<scenarioName>
 *       Microsoft.VSTS.TCM.AutomatedTestStorage = <feature file basename>
 *       Microsoft.VSTS.TCM.AutomatedTestType    = 'Playwright'
 *       Microsoft.VSTS.TCM.AutomatedTestId      = '@TC:<tcId>' (mirrors
 *                                                  publish_feature composer's
 *                                                  automationId convention)
 *  5. dryRun cascades through — the PATCH is skipped and the fields we
 *     WOULD write are surfaced in `plannedPatch`.
 */

import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { getResolvedCreds } from './ado_config_tool';
import { runUiScaffold } from './ado_ui_scaffold_tool';

const InputSchema = z.object({
    testCaseId: z.number().int().positive(),
    outputRoot: z.string().optional(),
    slug: z.string().optional(),
    baseUrl: z.string().url().optional(),
    generateLive: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
});

const PlannedPatchSchema = z.object({
    automationStatus: z.string(),
    automatedTestName: z.string(),
    automatedTestStorage: z.string(),
    automatedTestType: z.string(),
    automatedTestId: z.string(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    testCaseId: z.number(),
    testCaseTitle: z.string().optional(),
    alreadyAutomated: z.boolean(),
    existingAutomationName: z.string().optional(),
    existingAutomationStorage: z.string().optional(),
    generatedFiles: z.array(z.object({
        path: z.string(),
        kind: z.enum(['page-object', 'feature', 'steps', 'data', 'env']),
        size: z.number(),
        previewContent: z.string().optional(),
        unchanged: z.boolean().optional(),
        conflict: z.boolean().optional(),
    })),
    plannedPatch: PlannedPatchSchema.optional(),
    markedAutomated: z.boolean(),
    adoTcUpdated: z.boolean(),
    dryRun: z.boolean(),
    warnings: z.array(z.string()),
    driftWarnings: z.array(z.string()),
    unresolvedRequirements: z.array(z.string()),
    suggestedManualReview: z.array(z.string()),
    note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface WorkItem { id?: number; fields?: Record<string, unknown> }

export async function runAutomateManual(ctx: { workspaceRoot: string; invocationId: string }, input: Input): Promise<Output> {
    const logger = createLogger(ctx.invocationId, 'cs_qa_automate_manual', { workspaceRoot: ctx.workspaceRoot });

    const resolved = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
    if (!resolved.creds) {
        return {
            ok: false, testCaseId: input.testCaseId, alreadyAutomated: false,
            generatedFiles: [], markedAutomated: false, adoTcUpdated: false, dryRun: input.dryRun,
            warnings: [], driftWarnings: [], unresolvedRequirements: [], suggestedManualReview: [],
            note: `ADO not configured — ${resolved.diagnostic}`,
        };
    }
    const cfg: AdoCreds = resolved.creds;
    const client = new AdoHttpClient(cfg);

    let tc: WorkItem;
    try {
        tc = await client.get<WorkItem>(`_apis/wit/workitems/${input.testCaseId}?$expand=all&api-version=7.0`);
    } catch (e) {
        return {
            ok: false, testCaseId: input.testCaseId, alreadyAutomated: false,
            generatedFiles: [], markedAutomated: false, adoTcUpdated: false, dryRun: input.dryRun,
            warnings: [], driftWarnings: [], unresolvedRequirements: [], suggestedManualReview: [],
            note: `Failed to fetch test case #${input.testCaseId}: ${(e as Error).message}`,
        };
    }
    if (!tc.id) {
        return {
            ok: false, testCaseId: input.testCaseId, alreadyAutomated: false,
            generatedFiles: [], markedAutomated: false, adoTcUpdated: false, dryRun: input.dryRun,
            warnings: [], driftWarnings: [], unresolvedRequirements: [], suggestedManualReview: [],
            note: `Test case #${input.testCaseId} not found.`,
        };
    }
    const title = String(tc.fields?.['System.Title'] || `Test Case ${input.testCaseId}`);
    const currentStatus = String(tc.fields?.['Microsoft.VSTS.TCM.AutomationStatus'] || 'Not Automated');
    const existingName = String(tc.fields?.['Microsoft.VSTS.TCM.AutomatedTestName'] || '');
    const existingStorage = String(tc.fields?.['Microsoft.VSTS.TCM.AutomatedTestStorage'] || '');

    if (currentStatus === 'Automated' && existingName) {
        logger.info('automate-manual-skip-already-automated', { testCaseId: input.testCaseId, existingName });
        return {
            ok: true, testCaseId: input.testCaseId, testCaseTitle: title,
            alreadyAutomated: true, existingAutomationName: existingName, existingAutomationStorage: existingStorage,
            generatedFiles: [], markedAutomated: false, adoTcUpdated: false, dryRun: input.dryRun,
            warnings: [], driftWarnings: [], unresolvedRequirements: [], suggestedManualReview: [],
            note: `Test case #${input.testCaseId} is already Automated (${existingName}). No files generated, no ADO write.`,
        };
    }

    // Delegate scaffolding.
    const scaffold = await runUiScaffold(ctx, {
        testCaseId: input.testCaseId,
        outputRoot: input.outputRoot,
        slug: input.slug,
        baseUrl: input.baseUrl,
        generateLive: input.generateLive,
        dryRun: input.dryRun,
        orgUrl: input.orgUrl,
        project: input.project,
        pat: input.pat,
        syncBackTags: true,
        maxElements: 12,
    });
    if (!scaffold.ok) {
        return {
            ok: false, testCaseId: input.testCaseId, testCaseTitle: title,
            alreadyAutomated: false, generatedFiles: scaffold.generatedFiles,
            markedAutomated: false, adoTcUpdated: false, dryRun: input.dryRun,
            warnings: scaffold.warnings, driftWarnings: scaffold.driftWarnings,
            unresolvedRequirements: scaffold.unresolvedRequirements, suggestedManualReview: scaffold.suggestedManualReview,
            note: `Scaffold failed — ${scaffold.note || 'unknown error'}`,
        };
    }

    // Build the PATCH.
    const featureFile = scaffold.generatedFiles.find((f) => f.kind === 'feature');
    const pageBasename = path.basename(scaffold.pageObjectPath, '.ts');
    const featureBasename = featureFile ? path.basename(featureFile.path) : `${scaffold.slug}.feature`;
    const automatedTestName = `${scaffold.slug}.${pageBasename}#${title.slice(0, 200)}`;
    const patchPayload = {
        automationStatus: 'Automated',
        automatedTestName,
        automatedTestStorage: featureBasename,
        automatedTestType: 'Playwright',
        automatedTestId: `@TC:${input.testCaseId}`,
    };

    if (input.dryRun) {
        logger.info('automate-manual-dry-run', { testCaseId: input.testCaseId, plannedPatch: patchPayload });
        return {
            ok: true, testCaseId: input.testCaseId, testCaseTitle: title,
            alreadyAutomated: false, generatedFiles: scaffold.generatedFiles,
            plannedPatch: patchPayload,
            markedAutomated: false, adoTcUpdated: false, dryRun: true,
            warnings: scaffold.warnings, driftWarnings: scaffold.driftWarnings,
            unresolvedRequirements: scaffold.unresolvedRequirements, suggestedManualReview: scaffold.suggestedManualReview,
            note: `[dry-run] would generate ${scaffold.generatedFiles.length} file(s) and PATCH test case #${input.testCaseId} → Automated.`,
        };
    }

    // Fire the PATCH.
    const ops = [
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomationStatus', value: 'Automated' },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomatedTestName', value: patchPayload.automatedTestName },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomatedTestStorage', value: patchPayload.automatedTestStorage },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomatedTestType', value: patchPayload.automatedTestType },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomatedTestId', value: patchPayload.automatedTestId },
    ];
    try {
        await client.patch(`_apis/wit/workitems/${input.testCaseId}?api-version=7.0`, ops);
    } catch (e) {
        return {
            ok: false, testCaseId: input.testCaseId, testCaseTitle: title,
            alreadyAutomated: false, generatedFiles: scaffold.generatedFiles,
            plannedPatch: patchPayload,
            markedAutomated: false, adoTcUpdated: false, dryRun: false,
            warnings: scaffold.warnings.concat([`PATCH failed: ${(e as Error).message}`]),
            driftWarnings: scaffold.driftWarnings,
            unresolvedRequirements: scaffold.unresolvedRequirements, suggestedManualReview: scaffold.suggestedManualReview,
            note: `Files generated but ADO PATCH failed: ${(e as Error).message}`,
        };
    }

    logger.info('automate-manual-done', { testCaseId: input.testCaseId, patched: true });
    return {
        ok: true, testCaseId: input.testCaseId, testCaseTitle: title,
        alreadyAutomated: false, generatedFiles: scaffold.generatedFiles,
        plannedPatch: patchPayload,
        markedAutomated: true, adoTcUpdated: true, dryRun: false,
        warnings: scaffold.warnings, driftWarnings: scaffold.driftWarnings,
        unresolvedRequirements: scaffold.unresolvedRequirements, suggestedManualReview: scaffold.suggestedManualReview,
        note: `Generated ${scaffold.generatedFiles.length} artifact(s) and marked test case #${input.testCaseId} as Automated in ADO.`,
    };
}

registerPrimitive<Input, Output>({
    name: 'cs_qa_automate_manual',
    description: 'End-to-end automation of ONE manual ADO Test Case. Fetches the TC, generates the full artifact set via cs_qa_ui_scaffold, then PATCHes AutomationStatus/AutomatedTestName/AutomatedTestStorage/AutomatedTestType/AutomatedTestId on the work item. Skips (returns alreadyAutomated:true) when the TC is already marked Automated. Idempotent-friendly: the scaffold never overwrites an existing file of a different content, and the ADO PATCH is safe to re-issue.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => runAutomateManual(ctx, input),
});
