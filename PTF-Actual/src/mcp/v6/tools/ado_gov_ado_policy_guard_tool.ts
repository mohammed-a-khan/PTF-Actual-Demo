/**
 * cs_qa_gov_ado_policy_guard — Called BEFORE any ADO write (create-tc,
 * update-wi, publish-run, close-bug, …). Loads `.cs-qa/gov/ado-policies.json`
 * and checks the proposed mutation against every policy. Returns per-policy
 * verdict + a top-level block/proceed.
 *
 * Policies (see _helpers/governance_config.ts → AdoPolicyConfig):
 *   requiredTagsPerArea         — every WI under areaPath X must carry these tags
 *   minSeverityForBlocker       — blocker bugs must be at least this severity
 *   forbiddenStateTransitions   — reject certain from→to state moves
 *   requiredLinkedStoryForTc    — every Test Case must link to a User Story
 *   minReproStepsForBug         — ReproSteps text must be at least N chars
 *   maxTitleLength              — reject titles over N chars
 *   forbiddenTags               — reject WIs that carry these tags
 *   requireAssignedToForTypes   — WI types that MUST have AssignedTo before create
 *
 * The tool NEVER writes back — it inspects the caller's proposed operation
 * and returns the verdict for the wrapping skill to respect.
 */

import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { loadAdoPolicies, ensureAdoPoliciesFile } from './_helpers/governance_config';

const ProposalSchema = z.object({
    operation: z.enum(['create-test-case', 'update-test-case', 'create-bug', 'update-bug', 'close-bug', 'triage-bug', 'add-test-case-to-suite', 'publish-run', 'update-work-item', 'create-work-item']),
    workItemType: z.string().min(1).optional().describe('e.g. "Test Case", "Bug", "User Story". Inferred when omitted.'),
    title: z.string().optional(),
    areaPath: z.string().optional(),
    iterationPath: z.string().optional(),
    tags: z.array(z.string()).optional().describe('Tags being set on this work item.'),
    severity: z.enum(['1 - Critical', '2 - High', '3 - Medium', '4 - Low']).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    reproSteps: z.string().optional(),
    linkedStoryId: z.number().int().positive().optional(),
    assignedTo: z.string().optional(),
    stateTransition: z.object({ from: z.string(), to: z.string() }).optional(),
    isBlocker: z.boolean().optional().describe('Set by the caller when the bug/issue is a delivery blocker.'),
});

const InputSchema = z.object({
    proposal: ProposalSchema,
    policiesFile: z.string().min(1).optional().describe('Override path to the policies JSON (defaults to <workspaceRoot>/.cs-qa/gov/ado-policies.json).'),
    createDefaultsIfMissing: z.boolean().default(true).describe('When true and the policies file is missing, write a default template and treat as empty policy.'),
});

const VerdictSchema = z.object({
    policy: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
    hint: z.string().optional(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verdict: z.enum(['proceed', 'block']),
    proposal: ProposalSchema,
    policyResults: z.array(VerdictSchema),
    policiesLoaded: z.record(z.string(), z.any()),
    policiesPath: z.string(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

function inferWorkItemType(op: string, provided: string | undefined): string {
    if (provided) return provided;
    if (op === 'create-test-case' || op === 'update-test-case' || op === 'add-test-case-to-suite') return 'Test Case';
    if (op === 'create-bug' || op === 'update-bug' || op === 'close-bug' || op === 'triage-bug') return 'Bug';
    return 'Work Item';
}

const SEVERITY_RANK: Record<string, number> = {
    '1 - Critical': 1, '2 - High': 2, '3 - Medium': 3, '4 - Low': 4,
};

registerPrimitive({
    name: 'cs_qa_gov_ado_policy_guard',
    description: 'Governance hook — called BEFORE any ADO write. Loads .cs-qa/gov/ado-policies.json and evaluates the proposal against every policy (requiredTagsPerArea, minSeverityForBlocker, forbiddenStateTransitions, requiredLinkedStoryForTc, minReproStepsForBug, maxTitleLength, forbiddenTags, requireAssignedToForTypes). Returns per-policy verdict + block/proceed. Read-only. Input: {proposal:{operation, title?, areaPath?, tags?, severity?, reproSteps?, linkedStoryId?, assignedTo?, stateTransition?, isBlocker?}, createDefaultsIfMissing?}. Example: before cs_qa_ado_write verb=create-bug, call this with the proposed fields; if verdict=block, do NOT proceed with the write.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gov_ado_policy_guard', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const results: Array<z.infer<typeof VerdictSchema>> = [];

        if (input.createDefaultsIfMissing) {
            const created = ensureAdoPoliciesFile(ctx.workspaceRoot);
            log.info('policies file ensured', { path: created });
        }
        const { policies, warning: polWarn, path: polPath } = loadAdoPolicies(ctx.workspaceRoot);
        if (polWarn) warnings.push(polWarn);
        const proposal = input.proposal;
        const wiType = inferWorkItemType(proposal.operation, proposal.workItemType);

        // Policy: maxTitleLength
        if (policies.maxTitleLength && proposal.title) {
            const ok = proposal.title.length <= policies.maxTitleLength;
            results.push({
                policy: 'maxTitleLength',
                passed: ok,
                detail: ok ? undefined : `Title length ${proposal.title.length} exceeds cap ${policies.maxTitleLength}`,
                hint: ok ? undefined : `Shorten the title to at most ${policies.maxTitleLength} characters.`,
            });
        }

        // Policy: requiredTagsPerArea
        if (policies.requiredTagsPerArea && policies.requiredTagsPerArea.length > 0 && proposal.areaPath) {
            for (const rule of policies.requiredTagsPerArea) {
                if (!proposal.areaPath.toLowerCase().includes(rule.areaPathContains.toLowerCase())) continue;
                const tags = proposal.tags ?? [];
                const missing = rule.requiredTags.filter((t) => !tags.some((existing) => existing.toLowerCase() === t.toLowerCase()));
                results.push({
                    policy: `requiredTagsPerArea:${rule.areaPathContains}`,
                    passed: missing.length === 0,
                    detail: missing.length === 0 ? undefined : `Missing required tags for areaPath "${rule.areaPathContains}": ${missing.join(', ')}`,
                    hint: missing.length === 0 ? undefined : `Add tags: ${missing.join('; ')} before creating this work item.`,
                });
            }
        }

        // Policy: minSeverityForBlocker
        if (policies.minSeverityForBlocker && proposal.isBlocker && proposal.severity) {
            const required = SEVERITY_RANK[policies.minSeverityForBlocker] ?? 1;
            const actual = SEVERITY_RANK[proposal.severity] ?? 4;
            const ok = actual <= required; // lower rank number = higher severity
            results.push({
                policy: 'minSeverityForBlocker',
                passed: ok,
                detail: ok ? undefined : `Blocker requires ${policies.minSeverityForBlocker} or higher; got ${proposal.severity}`,
                hint: ok ? undefined : `Raise severity to at least ${policies.minSeverityForBlocker}, or unset isBlocker.`,
            });
        }

        // Policy: forbiddenStateTransitions
        if (policies.forbiddenStateTransitions && proposal.stateTransition) {
            const hit = policies.forbiddenStateTransitions.find((r) =>
                r.from.toLowerCase() === proposal.stateTransition!.from.toLowerCase() &&
                r.to.toLowerCase() === proposal.stateTransition!.to.toLowerCase(),
            );
            results.push({
                policy: 'forbiddenStateTransitions',
                passed: !hit,
                detail: hit ? `Transition ${proposal.stateTransition.from} → ${proposal.stateTransition.to} is forbidden${hit.reason ? `: ${hit.reason}` : ''}` : undefined,
                hint: hit ? `Route this transition through the correct workflow (e.g. re-open via a new bug, not a direct Closed→Active flip).` : undefined,
            });
        }

        // Policy: requiredLinkedStoryForTc
        if (policies.requiredLinkedStoryForTc && wiType === 'Test Case' && (proposal.operation === 'create-test-case')) {
            const ok = !!proposal.linkedStoryId;
            results.push({
                policy: 'requiredLinkedStoryForTc',
                passed: ok,
                detail: ok ? undefined : 'Test Case creation without a linked User Story',
                hint: ok ? undefined : 'Set linkedStoryId to the parent User Story ID before creating the Test Case.',
            });
        }

        // Policy: minReproStepsForBug
        if (policies.minReproStepsForBug && wiType === 'Bug' && proposal.operation === 'create-bug') {
            const len = (proposal.reproSteps ?? '').trim().length;
            const ok = len >= policies.minReproStepsForBug;
            results.push({
                policy: 'minReproStepsForBug',
                passed: ok,
                detail: ok ? undefined : `Repro steps are ${len} chars; minimum is ${policies.minReproStepsForBug}`,
                hint: ok ? undefined : `Expand the repro steps to at least ${policies.minReproStepsForBug} characters. Include: preconditions, exact steps, observed vs expected.`,
            });
        }

        // Policy: forbiddenTags
        if (policies.forbiddenTags && policies.forbiddenTags.length > 0 && proposal.tags && proposal.tags.length > 0) {
            const lower = proposal.tags.map((t) => t.toLowerCase());
            const hits = policies.forbiddenTags.filter((f) => lower.includes(f.toLowerCase()));
            results.push({
                policy: 'forbiddenTags',
                passed: hits.length === 0,
                detail: hits.length === 0 ? undefined : `Tags include forbidden entries: ${hits.join(', ')}`,
                hint: hits.length === 0 ? undefined : `Remove tags: ${hits.join('; ')} before creating the work item.`,
            });
        }

        // Policy: requireAssignedToForTypes
        if (policies.requireAssignedToForTypes && policies.requireAssignedToForTypes.length > 0) {
            const lowerTypes = policies.requireAssignedToForTypes.map((t) => t.toLowerCase());
            if (lowerTypes.includes(wiType.toLowerCase()) && !proposal.assignedTo) {
                results.push({
                    policy: 'requireAssignedToForTypes',
                    passed: false,
                    detail: `Work item type "${wiType}" requires assignedTo before create`,
                    hint: `Set assignedTo to the responsible owner (email or display name).`,
                });
            }
        }

        const passed = results.every((r) => r.passed);
        const verdict: 'proceed' | 'block' = passed ? 'proceed' : 'block';
        log.info('ado policy guard complete', { verdict, checked: results.length });
        return {
            ok: passed,
            verdict,
            proposal,
            policyResults: results,
            policiesLoaded: policies as Record<string, unknown>,
            policiesPath: polPath,
            warnings,
            note: verdict === 'proceed'
                ? `${results.length} policy check(s) — all passed. Safe to proceed with ${proposal.operation}.`
                : `${results.filter((r) => !r.passed).length}/${results.length} policy check(s) failed — do NOT proceed with ${proposal.operation}. Fix the failures listed and retry.`,
        };
    },
});
