/**
 * cs_qa_create_security_bug — file a security bug in ADO with CVSS-scored
 * severity mapping, OWASP/CWE cross-refs, and attachment upload.
 *
 * CVSS → ADO severity (deterministic — encoded in requirements):
 *   9.0 - 10.0  → 1 - Critical
 *   7.0 -  8.9  → 2 - High
 *   4.0 -  6.9  → 3 - Medium
 *   0.1 -  3.9  → 4 - Low
 *   0           → 4 - Low (informational)
 *
 * The bug body is a structured HTML block with sections that survive ADO's
 * HTML sanitizer. Attachments are uploaded via POST /_apis/wit/attachments
 * then linked to the bug through the same PATCH.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

function cvssToSeverity(cvss: number): '1 - Critical' | '2 - High' | '3 - Medium' | '4 - Low' {
    if (cvss >= 9.0) return '1 - Critical';
    if (cvss >= 7.0) return '2 - High';
    if (cvss >= 4.0) return '3 - Medium';
    return '4 - Low';
}

function severityToPriority(sev: '1 - Critical' | '2 - High' | '3 - Medium' | '4 - Low'): number {
    if (sev === '1 - Critical') return 1;
    if (sev === '2 - High') return 2;
    if (sev === '3 - Medium') return 3;
    return 4;
}

function escapeHtml(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
}

function composeDescription(args: {
    description: string;
    cvssScore: number;
    cvssVector?: string;
    owaspCategory?: string;
    cweId?: number;
    affectedEndpoints?: string[];
    reproSteps: string;
    expectedBehavior: string;
    actualBehavior: string;
}): string {
    const sev = cvssToSeverity(args.cvssScore);
    const endpoints = args.affectedEndpoints && args.affectedEndpoints.length > 0
        ? `<ul>${args.affectedEndpoints.map((e) => `<li><code>${escapeHtml(e)}</code></li>`).join('')}</ul>`
        : '<p><em>(none listed)</em></p>';
    return `<div>
<h3>Overview</h3>
<p>${escapeHtml(args.description).replace(/\n/g, '<br/>')}</p>

<h3>CVSS</h3>
<p><strong>Score:</strong> ${args.cvssScore.toFixed(1)} → <strong>${sev}</strong></p>
${args.cvssVector ? `<p><strong>Vector:</strong> <code>${escapeHtml(args.cvssVector)}</code></p>` : ''}

<h3>OWASP / CWE</h3>
<p>${args.owaspCategory ? `<strong>OWASP:</strong> ${escapeHtml(args.owaspCategory)}` : '<em>OWASP not classified</em>'}${args.cweId ? ` &middot; <strong>CWE-${args.cweId}</strong>` : ''}</p>

<h3>Affected Endpoints</h3>
${endpoints}

<h3>Reproduction Steps</h3>
<pre>${escapeHtml(args.reproSteps)}</pre>

<h3>Expected Behavior</h3>
<p>${escapeHtml(args.expectedBehavior).replace(/\n/g, '<br/>')}</p>

<h3>Actual Behavior</h3>
<p>${escapeHtml(args.actualBehavior).replace(/\n/g, '<br/>')}</p>

<h3>Remediation Recommendations</h3>
<ul>
    <li>Apply the mitigation described by the relevant OWASP / CWE reference.</li>
    <li>Add a regression test covering the vulnerable input and verify with cs_qa_ado_read verb=work-item after fix.</li>
    <li>If credentials or session state may have been exposed, rotate secrets and force session invalidation.</li>
</ul>
</div>`;
}

registerPrimitive({
    name: 'cs_qa_create_security_bug',
    description: 'Create a security bug in Azure DevOps with CVSS-scored severity (9-10=Critical, 7-8.9=High, 4-6.9=Medium, <4=Low), OWASP/CWE tags, reproduction sections, and attachment upload (screenshots, HAR, PoCs). Bug creation is gated by two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`).',
    inputSchema: z.object({
        title: z.string().min(5),
        description: z.string().min(10),
        cvssScore: z.number().min(0).max(10),
        cvssVector: z.string().optional(),
        owaspCategory: z.string().optional(),
        cweId: z.number().int().positive().optional(),
        affectedEndpoints: z.array(z.string()).optional(),
        reproSteps: z.string().min(10),
        expectedBehavior: z.string().min(1),
        actualBehavior: z.string().min(1),
        linkToStoryId: z.number().int().positive().optional(),
        linkToTestCaseId: z.number().int().positive().optional(),
        attachments: z.array(z.string()).default([]),
        assignedTo: z.string().optional(),
        dryRun: z.boolean().default(false),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        bugId: z.number().optional(),
        url: z.string().optional(),
        severity: z.string().optional(),
        attachmentIds: z.array(z.string()).default([]),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
        requiresConfirmation: z.boolean().optional(),
        destructive: z.boolean().optional(),
        confirmationHint: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_create_security_bug', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const severity = cvssToSeverity(input.cvssScore);
        const priority = severityToPriority(severity);
        const html = composeDescription(input);

        // Tag composition — deterministic and matches spec.
        const tags: string[] = ['security', `@cvss-${input.cvssScore.toFixed(1).replace('.', '_')}`];
        if (input.owaspCategory) tags.push(`@owasp-${slugify(input.owaspCategory)}`);
        if (input.cweId) tags.push(`@cwe-${input.cweId}`);

        if (input.dryRun) {
            const attCount = (input.attachments || []).length;
            return {
                ok: true, severity, attachmentIds: [], warnings,
                note: `Dry-run: would create bug titled "${input.title}" (Sev ${severity}, Pri ${priority}) with tags [${tags.join(', ')}]${attCount > 0 ? ` and upload ${attCount} attachments` : ''}.`,
            };
        }

        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
        });
        if (!credsRes.creds) return { ok: false, attachmentIds: [], warnings, note: credsRes.diagnostic };
        const cfg: AdoCreds = credsRes.creds;
        const client = new AdoHttpClient(cfg);

        if ((input as { confirmed?: boolean }).confirmed !== true) {
            return {
                ok: false, severity, attachmentIds: [], warnings,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint: `Create security bug (Sev ${severity}, CVSS ${input.cvssScore}) in project ${cfg.project}: "${input.title}"? No write performed. Retry the SAME call with confirmed:true (added at the top level).`,
                note: 'requires confirmation — retry with confirmed:true',
            } as never;
        }

        // Upload attachments first (each returns { id, url }); then reference in the bug patch.
        const attachmentIds: string[] = [];
        const attachmentRelations: Array<Record<string, unknown>> = [];
        for (const attPath of (input.attachments || [])) {
            const resolved = path.isAbsolute(attPath) ? attPath : path.join(ctx.workspaceRoot, attPath);
            if (!fs.existsSync(resolved)) {
                warnings.push(`Attachment not found: ${attPath}`);
                continue;
            }
            try {
                const buf = fs.readFileSync(resolved);
                const filename = path.basename(resolved);
                const created = await client.post<{ id?: string; url?: string }>(
                    `_apis/wit/attachments?fileName=${encodeURIComponent(filename)}&api-version=7.0`,
                    buf.toString('binary'),
                    { headers: { 'Content-Type': 'application/octet-stream' } },
                );
                if (created.id && created.url) {
                    attachmentIds.push(created.id);
                    attachmentRelations.push({
                        op: 'add',
                        path: '/relations/-',
                        value: {
                            rel: 'AttachedFile',
                            url: created.url,
                            attributes: { name: filename, comment: 'security-bug attachment' },
                        },
                    });
                }
            } catch (e) {
                warnings.push(`Attachment upload failed for ${attPath}: ${(e as Error).message}`);
            }
        }

        // Compose the PATCH.
        const patch: Array<Record<string, unknown>> = [
            { op: 'add', path: '/fields/System.Title', value: input.title },
            { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: html },
            { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: severity },
            { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: priority },
            { op: 'add', path: '/fields/System.Tags', value: tags.join('; ') },
            { op: 'add', path: '/fields/Microsoft.VSTS.CMMI.ExpectedResult', value: input.expectedBehavior },
            { op: 'add', path: '/fields/Microsoft.VSTS.CMMI.ActualResult', value: input.actualBehavior },
        ];
        if (input.assignedTo) patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: input.assignedTo });
        if (input.linkToStoryId) {
            patch.push({
                op: 'add',
                path: '/relations/-',
                value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${input.linkToStoryId}` },
            });
        }
        if (input.linkToTestCaseId) {
            patch.push({
                op: 'add',
                path: '/relations/-',
                value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${input.linkToTestCaseId}` },
            });
        }
        for (const rel of attachmentRelations) patch.push(rel);

        try {
            const created = await client.post<{ id?: number; url?: string }>(`_apis/wit/workitems/$Bug?api-version=7.0`, patch);
            log.info('security bug created', { bugId: created.id, severity, cvss: input.cvssScore });
            return {
                ok: true,
                bugId: Number(created.id || 0),
                url: created.url,
                severity,
                attachmentIds,
                warnings,
                note: `Security bug ${created.id} created (Sev ${severity}, CVSS ${input.cvssScore})${attachmentIds.length > 0 ? ` with ${attachmentIds.length} attachment(s)` : ''}.`,
            };
        } catch (e) {
            return { ok: false, severity, attachmentIds, warnings, note: `Bug creation failed: ${(e as Error).message}` };
        }
    },
});

// Exposed for unit tests.
export const _cvssToSeverity = cvssToSeverity;
