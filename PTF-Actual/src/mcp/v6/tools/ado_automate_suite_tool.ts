/**
 * cs_qa_automate_suite — bulk automation of manual test cases in a plan/suite.
 *
 * Steps
 *  1. Resolve plan (id OR name) via ado_name_resolver.
 *  2. Resolve suite (id OR name) — scoped to the plan.
 *  3. Enumerate test-case IDs in the suite via the /TestCase endpoint.
 *  4. Filter by AutomationStatus in [NotAutomated, Planned] (or take all
 *     when includeAlreadyAutomated:true).
 *  5. Run cs_qa_automate_manual for each in parallel windows (bulkExecute
 *     with concurrency=parallelism, default 3).
 *
 * Idempotent — a TC that's already Automated is skipped and reported so
 * repeated invocations converge to a stable state.
 */

import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { bulkExecute } from './_helpers/bulk_batcher';
import { getResolvedCreds } from './ado_config_tool';
import { resolvePlan, resolveSuite, createCache, type ResolverCache } from './ado_name_resolver';
import { runAutomateManual } from './ado_automate_manual_tool';

const InputSchema = z.object({
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().min(1).optional(),
    includeAlreadyAutomated: z.boolean().default(false),
    parallelism: z.number().int().positive().max(10).default(3),
    outputRoot: z.string().optional(),
    slug: z.string().optional(),
    baseUrl: z.string().url().optional(),
    generateLive: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
    /** Cap on how many TCs to process this invocation. */
    maxTestCases: z.number().int().positive().default(200),
}).refine((v) => (v.planId ?? v.planName) !== undefined, { message: 'planId or planName required' })
  .refine((v) => (v.suiteId ?? v.suiteName) !== undefined, { message: 'suiteId or suiteName required' });

const PerTcSchema = z.object({
    tcId: z.number(),
    ok: z.boolean(),
    title: z.string().optional(),
    alreadyAutomated: z.boolean().optional(),
    filesGenerated: z.number(),
    markedAutomated: z.boolean(),
    error: z.string().optional(),
    warnings: z.array(z.string()).optional(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    planId: z.number().optional(),
    suiteId: z.number().optional(),
    tcsEnumerated: z.number(),
    tcsAutomated: z.number(),
    tcsAlreadyAutomated: z.number(),
    tcsFailed: z.number(),
    tcsSkipped: z.array(z.object({ id: z.number(), reason: z.string() })),
    generatedFilesTotal: z.number(),
    perTc: z.array(PerTcSchema),
    dryRun: z.boolean(),
    ambiguous: z.boolean().optional(),
    ambiguousCandidates: z.array(z.object({ id: z.number(), name: z.string(), note: z.string().optional() })).optional(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface TcCandidate { id: number; automationStatus: string; title: string }

async function enumerateSuiteTcs(client: AdoHttpClient, planId: number, suiteId: number, cap: number): Promise<{ tcs: TcCandidate[]; enumWarnings: string[] }> {
    const enumWarnings: string[] = [];
    const listRes = await client.get<{ value?: Array<{ workItem?: { id?: number; name?: string } }> }>(
        `_apis/testplan/plans/${planId}/suites/${suiteId}/TestCase?api-version=7.0`,
    );
    const rawIds = (listRes?.value || []).map((v) => Number(v.workItem?.id || 0)).filter((n) => n > 0);
    if (rawIds.length === 0) return { tcs: [], enumWarnings };
    const capped = rawIds.slice(0, cap);
    if (capped.length < rawIds.length) enumWarnings.push(`Suite has ${rawIds.length} TCs; capped to first ${capped.length} (raise maxTestCases to process more).`);

    // Batch-fetch automation fields, chunk of 200.
    const chunks: number[][] = [];
    for (let i = 0; i < capped.length; i += 200) chunks.push(capped.slice(i, i + 200));
    const tcs: TcCandidate[] = [];
    for (const ch of chunks) {
        const csv = ch.join(',');
        const r = await client.get<{ value?: Array<{ id?: number; fields?: Record<string, unknown> }> }>(
            `_apis/wit/workitems?ids=${csv}&fields=System.Id,System.Title,Microsoft.VSTS.TCM.AutomationStatus&api-version=7.0`,
        );
        for (const w of (r?.value || [])) {
            const id = Number(w.id || 0);
            if (id <= 0) continue;
            const status = String(w.fields?.['Microsoft.VSTS.TCM.AutomationStatus'] || 'Not Automated');
            const title = String(w.fields?.['System.Title'] || `Test Case ${id}`);
            tcs.push({ id, automationStatus: status, title });
        }
    }
    return { tcs, enumWarnings };
}

registerPrimitive<Input, Output>({
    name: 'cs_qa_automate_suite',
    description: 'Bulk automation of manual test cases in an ADO test suite. Resolves plan and suite (id or name via ado_name_resolver), enumerates TC IDs in the suite, batch-fetches automation status, filters to NotAutomated + Planned (or all with includeAlreadyAutomated:true), then runs cs_qa_automate_manual per TC in parallel windows (parallelism default 3). Ambiguous name → returns candidates without any writes.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_automate_suite', { workspaceRoot: ctx.workspaceRoot });

        const resolved = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
        if (!resolved.creds) {
            return {
                ok: false, tcsEnumerated: 0, tcsAutomated: 0, tcsAlreadyAutomated: 0, tcsFailed: 0,
                tcsSkipped: [], generatedFilesTotal: 0, perTc: [], dryRun: input.dryRun,
                warnings: [], note: `ADO not configured — ${resolved.diagnostic}`,
            };
        }
        const cfg: AdoCreds = resolved.creds;
        const client = new AdoHttpClient(cfg);

        // Resolve plan.
        const cache: ResolverCache = createCache();
        const p = await resolvePlan(cfg, { planId: input.planId, planName: input.planName }, cache);
        const warnings: string[] = [...p.warnings];
        if (p.ambiguous) {
            return {
                ok: false, tcsEnumerated: 0, tcsAutomated: 0, tcsAlreadyAutomated: 0, tcsFailed: 0,
                tcsSkipped: [], generatedFilesTotal: 0, perTc: [], dryRun: input.dryRun,
                ambiguous: true, ambiguousCandidates: p.candidates,
                warnings,
                note: `Ambiguous planName "${input.planName}" — ${p.candidates?.length ?? 0} candidates. No writes performed.`,
            };
        }
        if (p.resolved.length === 0) {
            return {
                ok: false, tcsEnumerated: 0, tcsAutomated: 0, tcsAlreadyAutomated: 0, tcsFailed: 0,
                tcsSkipped: [], generatedFilesTotal: 0, perTc: [], dryRun: input.dryRun,
                warnings,
                note: `Plan not found (${input.planId ?? input.planName}).`,
            };
        }
        const planId = p.resolved[0].id;

        // Resolve suite.
        const s = await resolveSuite(cfg, { planId, suiteId: input.suiteId, suiteName: input.suiteName }, cache);
        warnings.push(...s.warnings);
        if (s.ambiguous) {
            return {
                ok: false, planId, tcsEnumerated: 0, tcsAutomated: 0, tcsAlreadyAutomated: 0, tcsFailed: 0,
                tcsSkipped: [], generatedFilesTotal: 0, perTc: [], dryRun: input.dryRun,
                ambiguous: true, ambiguousCandidates: s.candidates,
                warnings,
                note: `Ambiguous suiteName "${input.suiteName}" in plan ${planId}. No writes performed.`,
            };
        }
        if (s.resolved.length === 0) {
            return {
                ok: false, planId, tcsEnumerated: 0, tcsAutomated: 0, tcsAlreadyAutomated: 0, tcsFailed: 0,
                tcsSkipped: [], generatedFilesTotal: 0, perTc: [], dryRun: input.dryRun,
                warnings,
                note: `Suite not found in plan ${planId} (${input.suiteId ?? input.suiteName}).`,
            };
        }
        const suiteId = s.resolved[0].id;

        // Enumerate + filter.
        const { tcs, enumWarnings } = await enumerateSuiteTcs(client, planId, suiteId, input.maxTestCases);
        warnings.push(...enumWarnings);
        const skipped: Array<{ id: number; reason: string }> = [];
        const targets = tcs.filter((t) => {
            if (input.includeAlreadyAutomated) return true;
            if (t.automationStatus === 'Not Automated' || t.automationStatus === 'Planned') return true;
            skipped.push({ id: t.id, reason: `AutomationStatus=${t.automationStatus}` });
            return false;
        });

        logger.info('automate-suite-enumerated', { planId, suiteId, total: tcs.length, targets: targets.length, skipped: skipped.length });

        if (targets.length === 0) {
            return {
                ok: true, planId, suiteId,
                tcsEnumerated: tcs.length, tcsAutomated: 0, tcsAlreadyAutomated: 0, tcsFailed: 0,
                tcsSkipped: skipped,
                generatedFilesTotal: 0, perTc: [], dryRun: input.dryRun, warnings,
                note: `Enumerated ${tcs.length} TC(s); none eligible for automation this run.`,
            };
        }

        // Run per-TC via bulkExecute (chunkSize = 1 for per-TC isolation, concurrency = parallelism).
        const bulk = await bulkExecute<TcCandidate, { tcId: number; ok: boolean; title?: string; alreadyAutomated?: boolean; filesGenerated: number; markedAutomated: boolean; error?: string; warnings?: string[] }>(
            targets,
            {
                chunkSize: 1,
                concurrency: Math.max(1, Math.min(10, input.parallelism)),
                onChunkError: (err, chunk, idx) => {
                    logger.warn('automate-suite-chunk-error', { chunkIndex: idx, tcId: chunk[0]?.id, error: err.message });
                },
                workFn: async (chunk) => {
                    const t = chunk[0];
                    try {
                        const res = await runAutomateManual(ctx, {
                            testCaseId: t.id,
                            outputRoot: input.outputRoot,
                            slug: input.slug,
                            baseUrl: input.baseUrl,
                            generateLive: input.generateLive,
                            dryRun: input.dryRun,
                            orgUrl: input.orgUrl,
                            project: input.project,
                            pat: input.pat,
                        });
                        return [{
                            tcId: t.id, ok: res.ok, title: res.testCaseTitle,
                            alreadyAutomated: res.alreadyAutomated,
                            filesGenerated: res.generatedFiles.length,
                            markedAutomated: res.markedAutomated,
                            warnings: res.warnings.concat(res.driftWarnings),
                            error: res.ok ? undefined : (res.note || 'unknown'),
                        }];
                    } catch (e) {
                        return [{
                            tcId: t.id, ok: false, filesGenerated: 0, markedAutomated: false,
                            error: (e as Error).message,
                        }];
                    }
                },
            },
        );

        const perTc = bulk.ok.concat(bulk.failed.map((f) => ({
            tcId: (f.item as TcCandidate).id, ok: false, filesGenerated: 0, markedAutomated: false, error: f.error.message,
        })));
        const totalFiles = perTc.reduce((n, r) => n + r.filesGenerated, 0);
        const successCount = perTc.filter((r) => r.ok && !r.alreadyAutomated).length;
        const alreadyCount = perTc.filter((r) => r.ok && r.alreadyAutomated).length;
        const failedCount = perTc.filter((r) => !r.ok).length;

        logger.info('automate-suite-done', { successCount, alreadyCount, failedCount, totalFiles });

        return {
            ok: failedCount === 0,
            planId, suiteId,
            tcsEnumerated: tcs.length,
            tcsAutomated: successCount,
            tcsAlreadyAutomated: alreadyCount,
            tcsFailed: failedCount,
            tcsSkipped: skipped,
            generatedFilesTotal: totalFiles,
            perTc,
            dryRun: input.dryRun,
            warnings,
            note: `Processed ${perTc.length} TC(s): automated ${successCount}, already ${alreadyCount}, failed ${failedCount}. Skipped ${skipped.length} due to AutomationStatus filter. Generated ${totalFiles} file(s) total.`,
        };
    },
});
