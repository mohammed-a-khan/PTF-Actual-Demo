import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { wiql } from './_helpers/wiql_builder';

function loadAdoConfig(workspaceRoot: string): { orgUrl: string; project: string; pat: string } | null {
    const candidates = [
        path.join(workspaceRoot, 'cs-playwright-mcp.config.json'),
        path.join(workspaceRoot, 'cs-ai-auto-assist.config.json'),
    ];
    for (const c of candidates) {
        if (!fs.existsSync(c)) continue;
        try {
            const j = JSON.parse(fs.readFileSync(c, 'utf-8')) as Record<string, unknown>;
            const ado = (j.ado ?? j.azureDevOps ?? j) as Record<string, unknown>;
            const organization = (ado.organization ?? '') as string;
            const project = (ado.project ?? '') as string;
            const baseUrl = ((ado.baseUrl ?? 'https://dev.azure.com') as string).replace(/\/$/, '');
            const rawToken = ((ado.personalAccessToken ?? ado.pat ?? ado.token ?? '') as string).trim();
            let orgUrl = (ado.orgUrl as string) || '';
            if (!orgUrl && organization) orgUrl = `${baseUrl}/${organization}`;
            if (!orgUrl || !project || !rawToken) continue;
            const pat = decryptIfNeeded(rawToken, workspaceRoot);
            if (!pat) continue;
            return { orgUrl, project, pat };
        } catch { /* ignore */ }
    }
    if (process.env.ADO_ORG_URL && process.env.ADO_PROJECT && process.env.ADO_PAT) {
        return { orgUrl: process.env.ADO_ORG_URL, project: process.env.ADO_PROJECT, pat: process.env.ADO_PAT };
    }
    return null;
}

function decryptIfNeeded(value: string, workspaceRoot: string): string | null {
    if (!value.startsWith('ENCRYPTED:')) return value;
    try {
        const cryptoUtilPath = path.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSEncryptionUtil.js');
        if (!fs.existsSync(cryptoUtilPath)) return null;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CSEncryptionUtil } = require(cryptoUtilPath) as { CSEncryptionUtil: { getInstance(): { decrypt(v: string): string } } };
        return CSEncryptionUtil.getInstance().decrypt(value);
    } catch {
        return null;
    }
}

async function adoPatch(cfg: { orgUrl: string; project: string; pat: string }, urlPath: string, body: unknown, contentType = 'application/json-patch+json'): Promise<unknown> {
    const auth = Buffer.from(`:${cfg.pat}`).toString('base64');
    const url = `${cfg.orgUrl.replace(/\/$/, '')}/${cfg.project}/${urlPath.replace(/^\//, '')}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': contentType, Accept: 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ADO PATCH ${url} → ${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`);
    return await res.json();
}
async function adoPost(cfg: { orgUrl: string; project: string; pat: string }, urlPath: string, body: unknown, contentType = 'application/json-patch+json'): Promise<unknown> {
    const auth = Buffer.from(`:${cfg.pat}`).toString('base64');
    const url = `${cfg.orgUrl.replace(/\/$/, '')}/${cfg.project}/${urlPath.replace(/^\//, '')}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': contentType, Accept: 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ADO POST ${url} → ${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`);
    return await res.json();
}

const TestCaseStepSchema = z.object({
    stepNumber: z.number().int().positive(),
    action: z.string().min(3),
    expected: z.string().min(3),
    isPrecondition: z.boolean().default(false),
});

registerPrimitive({
    name: 'cs_qa_ado_write',
    description: 'Write to Azure DevOps. TWO-PHASE CONFIRMATION (client-agnostic — works without MCP elicitation): first call without `confirmed:true` returns requiresConfirmation:true + a preview. Show the preview to the human. When they explicitly agree, retry the SAME call with `confirmed:true` (added at the top level, alongside `verb`). NOTE: for logging failures from a test report as bugs/defects, prefer `cs_qa_log_failures_as_bugs` — that tool groups failures, attaches screenshots, dedupes, and handles bug-vs-defect switching automatically. Verbs: create-test-case, update-test-case, create-bug, add-test-case-to-suite, pr-comment, create-pr, pr-approve (cast a vote), pr-add-reviewer (email/name/group), pr-complete (squash|merge|rebase|rebaseMerge, deleteSourceBranch, bypassPolicy), pr-set-auto-complete (queue completion for when policies pass), triage-bug (severity/priority/assignedTo/rootCause; triageComment appends to System.History NOT ResolvedReason — that field is state-machine-owned), close-bug (state=Closed with ResolvedReason + optional verification history), query-defects (WIQL for defects filtered by state/severity/assignee/tag/dates — always via wiql() builder, never string concat), find-regression-bugs (convenience: query-defects filtered on regression tag).',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('create-test-case'),
            title: z.string().min(5),
            description: z.string().default(''),
            areaPath: z.string().optional(),
            iterationPath: z.string().optional(),
            steps: z.array(TestCaseStepSchema).min(1),
            linkedStoryId: z.number().int().positive().optional(),
            tags: z.array(z.string()).default([]),
        }),
        z.object({
            verb: z.literal('update-test-case'),
            id: z.number().int().positive(),
            title: z.string().optional(),
            steps: z.array(TestCaseStepSchema).optional(),
            fields: z.record(z.string(), z.unknown()).optional(),
        }),
        z.object({
            verb: z.literal('create-bug'),
            title: z.string().min(5),
            reproSteps: z.string().min(10),
            severity: z.enum(['1 - Critical', '2 - High', '3 - Medium', '4 - Low']).default('3 - Medium'),
            priority: z.number().int().min(1).max(4).default(2),
            expectedResult: z.string().default(''),
            actualResult: z.string().default(''),
            linkedStoryId: z.number().int().positive().optional(),
            linkedTestCaseId: z.number().int().positive().optional(),
            attachmentPaths: z.array(z.string()).default([]),
            tags: z.array(z.string()).default([]),
        }),
        z.object({
            verb: z.literal('add-test-case-to-suite'),
            planId: z.number().int().positive(),
            suiteId: z.number().int().positive(),
            testCaseIds: z.array(z.number().int().positive()).min(1),
        }),
        z.object({
            verb: z.literal('pr-comment'),
            repoId: z.string().min(1),
            prId: z.number().int().positive(),
            comment: z.string().min(3),
            filePath: z.string().optional(),
            line: z.number().int().positive().optional(),
        }),
        z.object({
            verb: z.literal('create-pr'),
            repoId: z.string().min(1),
            sourceBranch: z.string().min(1),
            targetBranch: z.string().default('main'),
            title: z.string().min(5),
            description: z.string().default(''),
        }),
        z.object({
            verb: z.literal('pr-approve'),
            repositoryId: z.string().min(1),
            pullRequestId: z.number().int().positive(),
            reviewerId: z.string().min(1).optional().describe('Reviewer identity id / descriptor. When omitted, discovers current user via /_apis/connectionData.'),
            vote: z.union([z.literal(10), z.literal(5), z.literal(-5), z.literal(-10)]).default(10),
        }),
        z.object({
            verb: z.literal('pr-add-reviewer'),
            repositoryId: z.string().min(1),
            pullRequestId: z.number().int().positive(),
            reviewer: z.string().min(1).describe('Email, display name, or group name. Resolved via POST /_apis/identities/read — first match wins.'),
            isRequired: z.boolean().default(false),
        }),
        z.object({
            verb: z.literal('pr-complete'),
            repositoryId: z.string().min(1),
            pullRequestId: z.number().int().positive(),
            mergeStrategy: z.enum(['noFastForward', 'squash', 'rebase', 'rebaseMerge']).default('squash'),
            deleteSourceBranch: z.boolean().default(true),
            bypassPolicy: z.boolean().default(false),
            commitMessage: z.string().optional(),
        }),
        z.object({
            verb: z.literal('pr-set-auto-complete'),
            repositoryId: z.string().min(1),
            pullRequestId: z.number().int().positive(),
            mergeStrategy: z.enum(['noFastForward', 'squash', 'rebase', 'rebaseMerge']).default('squash'),
            deleteSourceBranch: z.boolean().default(true),
            authorAccountId: z.string().min(1).optional().describe('Identity ID to set as auto-complete author. When omitted, discovers current user via /_apis/connectionData.'),
        }),
        z.object({
            verb: z.literal('triage-bug'),
            bugId: z.number().int().positive(),
            severity: z.enum(['1 - Critical', '2 - High', '3 - Medium', '4 - Low']).optional(),
            priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
            assignedTo: z.string().min(1).optional(),
            rootCause: z.string().min(1).optional().describe('Free-text root cause. Written to Microsoft.VSTS.TCM.SystemInfo — never to ResolvedReason.'),
            regressionFrom: z.number().int().positive().optional().describe('Optional related WI id for the regression source; added as System.LinkTypes.Related.'),
            triageComment: z.string().min(1).optional().describe('Appended to System.History. Never touches ResolvedReason — that field is state-machine-owned and writing to it from a triage verb can wedge the bug into an invalid transition.'),
        }),
        z.object({
            verb: z.literal('close-bug'),
            bugId: z.number().int().positive(),
            resolvedReason: z.string().min(1).describe('Microsoft.VSTS.Common.ResolvedReason — legitimate use here since we are transitioning state.'),
            verificationComment: z.string().min(1).optional().describe('Appended to System.History alongside the state transition.'),
            integrationBuild: z.string().min(1).optional().describe('Microsoft.VSTS.Build.IntegrationBuild.'),
        }),
        z.object({
            verb: z.literal('query-defects'),
            state: z.enum(['Active', 'New', 'Resolved', 'Closed']).optional(),
            severity: z.string().optional(),
            assignedTo: z.string().optional(),
            areaPath: z.string().optional(),
            iterationPath: z.string().optional(),
            tag: z.string().optional().describe('WHERE [System.Tags] CONTAINS <tag> — safely escaped by the WIQL builder.'),
            createdAfter: z.string().optional().describe('ISO datetime; matched via [System.CreatedDate] >= <date>.'),
            limit: z.number().int().positive().max(2000).default(200),
        }),
        z.object({
            verb: z.literal('find-regression-bugs'),
            iterationPath: z.string().optional(),
            areaPath: z.string().optional(),
            regressionTagName: z.string().default('regression'),
            limit: z.number().int().positive().max(2000).default(100),
        }),
        z.object({
            verb: z.literal('create-branch'),
            repositoryId: z.string().min(1).optional().describe('ADO Git repo id. Either repositoryId or repositoryName is required.'),
            repositoryName: z.string().min(1).optional().describe('ADO Git repo name — resolved via repo-list when repositoryId is absent.'),
            newBranch: z.string().min(1).describe('New branch name (without refs/heads/ prefix). E.g. "feature/qa/story-425".'),
            fromRef: z.string().min(1).default('refs/heads/main').describe('Source ref (fully qualified, e.g. refs/heads/main). Its head commit SHA becomes the new branch\'s starting point.'),
        }),
    ]),
    outputSchema: z.object({
        verb: z.string(),
        confirmed: z.boolean(),
        requiresConfirmation: z.boolean().optional(),
        destructive: z.boolean().optional(),
        confirmationHint: z.string().optional(),
        id: z.union([z.number(), z.string()]).optional(),
        url: z.string().optional(),
        data: z.unknown().optional(),
        note: z.string().optional(),
        defects: z.array(z.object({
            id: z.number(),
            title: z.string().optional(),
            state: z.string().optional(),
            severity: z.string().optional(),
            assignedTo: z.string().optional(),
        })).optional(),
        aggregate: z.object({
            countByState: z.record(z.string(), z.number()).optional(),
            countBySeverity: z.record(z.string(), z.number()).optional(),
            countByAssignee: z.record(z.string(), z.number()).optional(),
            total: z.number().optional(),
        }).optional(),
        wiqlUsed: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const cfg = loadAdoConfig(ctx.workspaceRoot);
        if (!cfg) return { verb: input.verb, confirmed: false, note: 'ADO not configured.' };

        // Two-phase destructive-op gate. Client-agnostic: works with any MCP
        // client, including those that don't support elicitation (Copilot
        // Chat). First call without `confirmed:true` returns requiresConfirmation
        // with a preview. Retry with `confirmed:true` to actually mutate.
        const READ_ONLY_VERBS = new Set(['query-defects', 'find-regression-bugs']);
        if (!READ_ONLY_VERBS.has(input.verb)) {
            const isConfirmed = (input as { confirmed?: boolean }).confirmed === true;
            if (!isConfirmed) {
                const previewInput = JSON.stringify(input).slice(0, 400);
                return {
                    verb: input.verb,
                    confirmed: false,
                    requiresConfirmation: true,
                    destructive: true,
                    confirmationHint: `This will WRITE to Azure DevOps (verb=${input.verb}). No write was performed. Preview inputs: ${previewInput}${JSON.stringify(input).length > 400 ? '…' : ''}. Show this to the human. When they explicitly agree, RETRY the SAME call with an additional field: confirmed:true.`,
                    note: 'requires confirmation — retry with confirmed:true',
                } as never;
            }
        }

        try {
            if (input.verb === 'create-test-case') {
                const stepsXml = buildStepsXml(input.steps);
                const patch: Array<Record<string, unknown>> = [
                    { op: 'add', path: '/fields/System.Title', value: input.title },
                    { op: 'add', path: '/fields/System.Description', value: input.description },
                    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: stepsXml },
                ];
                if (input.areaPath) patch.push({ op: 'add', path: '/fields/System.AreaPath', value: input.areaPath });
                if (input.iterationPath) patch.push({ op: 'add', path: '/fields/System.IterationPath', value: input.iterationPath });
                if (input.tags.length > 0) patch.push({ op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') });
                if (input.linkedStoryId) {
                    patch.push({
                        op: 'add', path: '/relations/-',
                        value: {
                            rel: 'Microsoft.VSTS.Common.TestedBy-Reverse',
                            url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${input.linkedStoryId}`,
                        },
                    });
                }
                const data = await adoPost(cfg, `_apis/wit/workitems/$Test Case?api-version=7.0`, patch);
                const r = data as { id?: number; url?: string };
                return { verb: input.verb, confirmed: true, id: r.id, url: r.url, data };
            }
            if (input.verb === 'update-test-case') {
                const patch: Array<Record<string, unknown>> = [];
                if (input.title) patch.push({ op: 'add', path: '/fields/System.Title', value: input.title });
                if (input.steps) patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(input.steps) });
                if (input.fields) {
                    for (const [k, v] of Object.entries(input.fields)) {
                        patch.push({ op: 'add', path: `/fields/${k}`, value: v });
                    }
                }
                const data = await adoPatch(cfg, `_apis/wit/workitems/${input.id}?api-version=7.0`, patch);
                return { verb: input.verb, confirmed: true, id: input.id, data };
            }
            if (input.verb === 'create-bug') {
                const patch: Array<Record<string, unknown>> = [
                    { op: 'add', path: '/fields/System.Title', value: input.title },
                    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: input.reproSteps },
                    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: input.severity },
                    { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: input.priority },
                ];
                if (input.expectedResult) patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.CMMI.ExpectedResult', value: input.expectedResult });
                if (input.actualResult) patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.CMMI.ActualResult', value: input.actualResult });
                if (input.tags.length > 0) patch.push({ op: 'add', path: '/fields/System.Tags', value: input.tags.join('; ') });
                if (input.linkedStoryId) patch.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${input.linkedStoryId}` } });
                if (input.linkedTestCaseId) patch.push({ op: 'add', path: '/relations/-', value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${input.linkedTestCaseId}` } });
                const data = await adoPost(cfg, `_apis/wit/workitems/$Bug?api-version=7.0`, patch);
                const r = data as { id?: number; url?: string };
                return { verb: input.verb, confirmed: true, id: r.id, url: r.url, data, note: input.attachmentPaths.length > 0 ? `Bug created. Attachments (${input.attachmentPaths.length}) need to be attached separately via wit/attachments API.` : undefined };
            }
            if (input.verb === 'add-test-case-to-suite') {
                const url = `_apis/testplan/plans/${input.planId}/suites/${input.suiteId}/TestCase?api-version=7.0`;
                const data = await adoPost(cfg, url, input.testCaseIds.map((id) => ({ pointAssignments: [], workItem: { id } })), 'application/json');
                return { verb: input.verb, confirmed: true, data };
            }
            if (input.verb === 'pr-comment') {
                const body: Record<string, unknown> = {
                    comments: [{ content: input.comment, commentType: 'text' }],
                    status: 'active',
                };
                if (input.filePath && input.line) {
                    body.threadContext = {
                        filePath: input.filePath.startsWith('/') ? input.filePath : `/${input.filePath}`,
                        rightFileStart: { line: input.line, offset: 1 },
                        rightFileEnd: { line: input.line, offset: 1 },
                    };
                }
                const url = `_apis/git/repositories/${input.repoId}/pullrequests/${input.prId}/threads?api-version=7.0`;
                const data = await adoPost(cfg, url, body, 'application/json');
                return { verb: input.verb, confirmed: true, data };
            }
            if (input.verb === 'create-pr') {
                const body = {
                    sourceRefName: `refs/heads/${input.sourceBranch.replace(/^refs\/heads\//, '')}`,
                    targetRefName: `refs/heads/${input.targetBranch.replace(/^refs\/heads\//, '')}`,
                    title: input.title,
                    description: input.description,
                };
                const data = await adoPost(cfg, `_apis/git/repositories/${input.repoId}/pullrequests?api-version=7.0`, body, 'application/json');
                const r = data as { pullRequestId?: number; url?: string };
                return { verb: input.verb, confirmed: true, id: r.pullRequestId, url: r.url, data };
            }
            if (input.verb === 'pr-approve') {
                const client = new AdoHttpClient(cfg as AdoCreds);
                const reviewerId = input.reviewerId ?? await discoverCurrentUserId(client);
                if (!reviewerId) {
                    return { verb: input.verb, confirmed: true, note: 'Could not discover current user identity for reviewer vote — pass reviewerId explicitly.' };
                }
                const vote = input.vote ?? 10;
                const data = await client.put(
                    `_apis/git/repositories/${input.repositoryId}/pullRequests/${input.pullRequestId}/reviewers/${reviewerId}?api-version=7.1`,
                    { vote, isRequired: false },
                );
                return { verb: input.verb, confirmed: true, id: reviewerId, data };
            }
            if (input.verb === 'pr-add-reviewer') {
                const client = new AdoHttpClient(cfg as AdoCreds);
                const identityId = await resolveIdentity(client, input.reviewer);
                if (!identityId) {
                    return { verb: input.verb, confirmed: true, note: `No identity matched "${input.reviewer}". Pass an exact email or ADO identity descriptor.` };
                }
                const isRequired = input.isRequired ?? false;
                const data = await client.put(
                    `_apis/git/repositories/${input.repositoryId}/pullRequests/${input.pullRequestId}/reviewers/${identityId}?api-version=7.1`,
                    { vote: 0, isRequired },
                );
                return { verb: input.verb, confirmed: true, id: identityId, data };
            }
            if (input.verb === 'pr-complete') {
                const client = new AdoHttpClient(cfg as AdoCreds);
                // Fetch the PR first to capture lastMergeSourceCommit.commitId — this
                // is mandatory on PATCH-completion; ADO 400s without it.
                const pr = await client.get<{ lastMergeSourceCommit?: { commitId?: string }; url?: string }>(
                    `_apis/git/repositories/${input.repositoryId}/pullRequests/${input.pullRequestId}?api-version=7.1`,
                );
                const commitId = pr.lastMergeSourceCommit?.commitId;
                if (!commitId) {
                    return { verb: input.verb, confirmed: true, note: 'Could not read lastMergeSourceCommit.commitId from PR — cannot complete.' };
                }
                const body: Record<string, unknown> = {
                    status: 'completed',
                    lastMergeSourceCommit: { commitId },
                    completionOptions: {
                        mergeStrategy: input.mergeStrategy ?? 'squash',
                        deleteSourceBranch: input.deleteSourceBranch ?? true,
                        bypassPolicy: input.bypassPolicy ?? false,
                        ...(input.commitMessage ? { mergeCommitMessage: input.commitMessage } : {}),
                    },
                };
                const data = await client.patch(
                    `_apis/git/repositories/${input.repositoryId}/pullRequests/${input.pullRequestId}?api-version=7.1`,
                    body,
                );
                return { verb: input.verb, confirmed: true, id: input.pullRequestId, data };
            }
            if (input.verb === 'pr-set-auto-complete') {
                const client = new AdoHttpClient(cfg as AdoCreds);
                const authorId = input.authorAccountId ?? await discoverCurrentUserId(client);
                if (!authorId) {
                    return { verb: input.verb, confirmed: true, note: 'Could not discover current user identity for auto-complete — pass authorAccountId explicitly.' };
                }
                const body: Record<string, unknown> = {
                    autoCompleteSetBy: { id: authorId },
                    completionOptions: {
                        mergeStrategy: input.mergeStrategy ?? 'squash',
                        deleteSourceBranch: input.deleteSourceBranch ?? true,
                    },
                };
                const data = await client.patch(
                    `_apis/git/repositories/${input.repositoryId}/pullRequests/${input.pullRequestId}?api-version=7.1`,
                    body,
                );
                return { verb: input.verb, confirmed: true, id: input.pullRequestId, data };
            }
            if (input.verb === 'triage-bug') {
                const client = new AdoHttpClient(cfg as AdoCreds);
                const patch: Array<Record<string, unknown>> = [];
                if (input.severity) patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: input.severity });
                if (input.priority !== undefined) patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: input.priority });
                if (input.assignedTo) patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: input.assignedTo });
                if (input.rootCause) patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.TCM.SystemInfo', value: input.rootCause });
                if (input.triageComment) {
                    // System.History accepts an append-only string per PATCH — ADO
                    // treats this as a new discussion comment. NEVER write to
                    // Microsoft.VSTS.Common.ResolvedReason from a triage verb: that
                    // field is state-machine-owned and clobbering it can wedge the
                    // bug into an invalid transition.
                    patch.push({ op: 'add', path: '/fields/System.History', value: input.triageComment });
                }
                if (input.regressionFrom) {
                    patch.push({
                        op: 'add', path: '/relations/-',
                        value: {
                            rel: 'System.LinkTypes.Related',
                            url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${input.regressionFrom}`,
                            attributes: { comment: 'regression-from' },
                        },
                    });
                }
                if (patch.length === 0) {
                    return { verb: input.verb, confirmed: true, id: input.bugId, note: 'No triage fields supplied — no PATCH sent.' };
                }
                const data = await client.patch(`_apis/wit/workitems/${input.bugId}?api-version=7.0`, patch);
                return { verb: input.verb, confirmed: true, id: input.bugId, data };
            }
            if (input.verb === 'close-bug') {
                const client = new AdoHttpClient(cfg as AdoCreds);
                const patch: Array<Record<string, unknown>> = [
                    { op: 'add', path: '/fields/System.State', value: 'Closed' },
                    { op: 'add', path: '/fields/Microsoft.VSTS.Common.ResolvedReason', value: input.resolvedReason },
                ];
                if (input.verificationComment) patch.push({ op: 'add', path: '/fields/System.History', value: input.verificationComment });
                if (input.integrationBuild) patch.push({ op: 'add', path: '/fields/Microsoft.VSTS.Build.IntegrationBuild', value: input.integrationBuild });
                const data = await client.patch(`_apis/wit/workitems/${input.bugId}?api-version=7.0`, patch);
                return { verb: input.verb, confirmed: true, id: input.bugId, data };
            }
            if (input.verb === 'query-defects') {
                const client = new AdoHttpClient(cfg as AdoCreds);
                const q = wiql()
                    .select(['[System.Id]', '[System.Title]', '[System.State]', '[Microsoft.VSTS.Common.Severity]', '[System.AssignedTo]'])
                    .from('WorkItems');
                const wb = q.where().equals('[System.WorkItemType]', 'Bug');
                if (input.state) wb.and().equals('[System.State]', input.state);
                if (input.severity) wb.and().equals('[Microsoft.VSTS.Common.Severity]', input.severity);
                if (input.assignedTo) wb.and().equals('[System.AssignedTo]', input.assignedTo);
                if (input.areaPath) wb.and().areaPathUnder(input.areaPath);
                if (input.iterationPath) wb.and().iteration(input.iterationPath);
                if (input.tag) wb.and().tag(input.tag);
                if (input.createdAfter) {
                    const dt = new Date(input.createdAfter);
                    if (!Number.isNaN(dt.getTime())) {
                        wb.and().raw(`[System.CreatedDate] >= '${dt.toISOString()}'`);
                    }
                }
                q.orderBy('[System.Id]', 'DESC');
                q.limit(input.limit);
                const wiqlText = q.build();
                const wiqlRes = await client.post<{ workItems?: Array<{ id: number }> }>(
                    `_apis/wit/wiql?$top=${input.limit}&api-version=7.0`,
                    { query: wiqlText },
                );
                const ids = (wiqlRes.workItems || []).map((w) => w.id);
                let defects: Array<{ id: number; title?: string; state?: string; severity?: string; assignedTo?: string }> = [];
                if (ids.length > 0) {
                    // Batch workitem fetch — 200 at a time (ADO cap).
                    for (let i = 0; i < ids.length; i += 200) {
                        const chunk = ids.slice(i, i + 200);
                        const wi = await client.get<{ value?: Array<{ id: number; fields?: Record<string, unknown> }> }>(
                            `_apis/wit/workitems?ids=${chunk.join(',')}&fields=System.Id,System.Title,System.State,Microsoft.VSTS.Common.Severity,System.AssignedTo&api-version=7.0`,
                        );
                        for (const w of (wi.value || [])) {
                            const f = w.fields || {};
                            defects.push({
                                id: w.id,
                                title: (f['System.Title'] as string) || undefined,
                                state: (f['System.State'] as string) || undefined,
                                severity: (f['Microsoft.VSTS.Common.Severity'] as string) || undefined,
                                assignedTo: (f['System.AssignedTo'] as { displayName?: string })?.displayName || undefined,
                            });
                        }
                    }
                }
                const countByState: Record<string, number> = {};
                const countBySeverity: Record<string, number> = {};
                const countByAssignee: Record<string, number> = {};
                for (const d of defects) {
                    if (d.state) countByState[d.state] = (countByState[d.state] || 0) + 1;
                    if (d.severity) countBySeverity[d.severity] = (countBySeverity[d.severity] || 0) + 1;
                    const a = d.assignedTo || '(unassigned)';
                    countByAssignee[a] = (countByAssignee[a] || 0) + 1;
                }
                return {
                    verb: input.verb, confirmed: true,
                    data: { count: defects.length, ids },
                    defects,
                    aggregate: { countByState, countBySeverity, countByAssignee, total: defects.length },
                    wiqlUsed: wiqlText,
                };
            }
            if (input.verb === 'find-regression-bugs') {
                const client = new AdoHttpClient(cfg as AdoCreds);
                const q = wiql()
                    .select(['[System.Id]', '[System.Title]', '[System.State]', '[Microsoft.VSTS.Common.Severity]', '[System.AssignedTo]'])
                    .from('WorkItems');
                const wb = q.where()
                    .equals('[System.WorkItemType]', 'Bug')
                    .and().tag(input.regressionTagName);
                if (input.areaPath) wb.and().areaPathUnder(input.areaPath);
                if (input.iterationPath) wb.and().iteration(input.iterationPath);
                q.orderBy('[System.Id]', 'DESC');
                q.limit(input.limit);
                const wiqlText = q.build();
                const wiqlRes = await client.post<{ workItems?: Array<{ id: number }> }>(
                    `_apis/wit/wiql?$top=${input.limit}&api-version=7.0`,
                    { query: wiqlText },
                );
                const ids = (wiqlRes.workItems || []).map((w) => w.id);
                let defects: Array<{ id: number; title?: string; state?: string; severity?: string; assignedTo?: string }> = [];
                if (ids.length > 0) {
                    for (let i = 0; i < ids.length; i += 200) {
                        const chunk = ids.slice(i, i + 200);
                        const wi = await client.get<{ value?: Array<{ id: number; fields?: Record<string, unknown> }> }>(
                            `_apis/wit/workitems?ids=${chunk.join(',')}&fields=System.Id,System.Title,System.State,Microsoft.VSTS.Common.Severity,System.AssignedTo&api-version=7.0`,
                        );
                        for (const w of (wi.value || [])) {
                            const f = w.fields || {};
                            defects.push({
                                id: w.id,
                                title: (f['System.Title'] as string) || undefined,
                                state: (f['System.State'] as string) || undefined,
                                severity: (f['Microsoft.VSTS.Common.Severity'] as string) || undefined,
                                assignedTo: (f['System.AssignedTo'] as { displayName?: string })?.displayName || undefined,
                            });
                        }
                    }
                }
                return {
                    verb: input.verb, confirmed: true,
                    data: { count: defects.length, ids },
                    defects,
                    wiqlUsed: wiqlText,
                };
            }
            if (input.verb === 'create-branch') {
                const client = new AdoHttpClient(cfg as AdoCreds);
                let repoId = input.repositoryId;
                if (!repoId) {
                    if (!input.repositoryName) {
                        return { verb: input.verb, confirmed: true, note: 'create-branch requires repositoryId or repositoryName.' };
                    }
                    const list = await client.get<{ value?: Array<{ id: string; name: string }> }>(`_apis/git/repositories?api-version=7.1`);
                    const match = (list.value || []).find((r) => r.name.toLowerCase() === input.repositoryName!.toLowerCase());
                    if (!match) return { verb: input.verb, confirmed: true, note: `Repo "${input.repositoryName}" not found.` };
                    repoId = match.id;
                }
                const normalizedFrom = input.fromRef.startsWith('refs/') ? input.fromRef : `refs/heads/${input.fromRef.replace(/^refs\/heads\//, '')}`;
                const normalizedNew = input.newBranch.startsWith('refs/heads/') ? input.newBranch : `refs/heads/${input.newBranch}`;
                // Resolve the source ref's head commit SHA — this becomes newObjectId.
                const refListFilter = normalizedFrom.replace(/^refs\//, '');
                const refs = await client.get<{ value?: Array<{ name: string; objectId: string }> }>(
                    `_apis/git/repositories/${repoId}/refs?filter=${encodeURIComponent(refListFilter)}&api-version=7.1`,
                );
                const sourceRef = (refs.value || []).find((r) => r.name === normalizedFrom);
                if (!sourceRef) {
                    return { verb: input.verb, confirmed: true, note: `Source ref not found: ${normalizedFrom}` };
                }
                const body = [{
                    name: normalizedNew,
                    oldObjectId: '0000000000000000000000000000000000000000',
                    newObjectId: sourceRef.objectId,
                }];
                const data = await client.post<{ value?: Array<{ success?: boolean; name?: string; newObjectId?: string; customMessage?: string }> }>(
                    `_apis/git/repositories/${repoId}/refs?api-version=7.1`,
                    body,
                );
                const first = (data.value || [])[0];
                if (first && first.success === false) {
                    return { verb: input.verb, confirmed: true, id: normalizedNew, data, note: `Branch creation refused: ${first.customMessage || '(no message)'}` };
                }
                return { verb: input.verb, confirmed: true, id: normalizedNew, data, note: `Branch ${normalizedNew} created from ${normalizedFrom} @ ${sourceRef.objectId.slice(0, 8)}.` };
            }
            return { verb: (input as { verb: string }).verb, confirmed: true, note: 'unknown verb' };
        } catch (e) {
            return { verb: (input as { verb: string }).verb, confirmed: true, note: `ADO write failed: ${(e as Error).message}` };
        }
    },
});

function buildStepsXml(steps: Array<{ stepNumber: number; action: string; expected: string; isPrecondition: boolean }>): string {
    const rows = steps.map((s) => `<step id="${s.stepNumber}" type="${s.isPrecondition ? 'PreCondition' : 'ActionStep'}">
  <parameterizedString isformatted="true">&lt;P&gt;${escapeXml(s.action)}&lt;/P&gt;</parameterizedString>
  <parameterizedString isformatted="true">&lt;P&gt;${escapeXml(s.expected)}&lt;/P&gt;</parameterizedString>
  <description/>
</step>`).join('');
    return `<steps id="0" last="${steps.length}">${rows}</steps>`;
}

function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Discover the current user's identity id (subjectDescriptor) via ADO's
 * /_apis/connectionData endpoint. Returns null if the call fails or the shape
 * is unfamiliar — callers must then require the user to pass the id explicitly.
 *
 * connectionData lives above the project scope, so scopeToProject:false.
 */
async function discoverCurrentUserId(client: AdoHttpClient): Promise<string | null> {
    try {
        const data = await client.get<{ authenticatedUser?: { id?: string; descriptor?: string; subjectDescriptor?: string } }>(
            `_apis/connectionData?api-version=7.1`,
            { scopeToProject: false },
        );
        const u = data.authenticatedUser;
        if (!u) return null;
        return (u.id || u.descriptor || u.subjectDescriptor) ?? null;
    } catch {
        return null;
    }
}

/**
 * Resolve an identity by free-form search string (email / display name / group).
 * Tries POST /_apis/identities/read (the batched-lookup endpoint) first; falls
 * back to GET /_apis/identities?searchFilter=General&filterValue=... on 404.
 * First match wins.
 */
async function resolveIdentity(client: AdoHttpClient, searchTerm: string): Promise<string | null> {
    // Preferred: identity picker search — accepts email / name / group.
    try {
        const search = await client.post<{ value?: Array<{ id?: string; descriptor?: string; providerDisplayName?: string; displayName?: string }> }>(
            `_apis/IdentityPicker/Identities?api-version=7.1`,
            {
                query: searchTerm,
                identityTypes: ['user', 'group'],
                operationScopes: ['ims', 'source'],
                properties: ['DisplayName', 'Mail'],
            },
            { scopeToProject: false },
        );
        const first = search.value?.[0];
        if (first && (first.id || first.descriptor)) return (first.id || first.descriptor) as string;
    } catch {
        // Fall through.
    }
    // Fallback: legacy identities endpoint.
    try {
        const q = encodeURIComponent(searchTerm);
        const search = await client.get<{ value?: Array<{ id?: string; descriptor?: string }> }>(
            `_apis/identities?searchFilter=General&filterValue=${q}&api-version=7.1`,
            { scopeToProject: false },
        );
        const first = search.value?.[0];
        if (first && (first.id || first.descriptor)) return (first.id || first.descriptor) as string;
    } catch {
        return null;
    }
    return null;
}
