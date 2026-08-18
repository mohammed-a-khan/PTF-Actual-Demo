import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, AdoBinaryResponse } from './_helpers/ado_http_client';

const PAT_PLACEHOLDERS = new Set([
    'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here',
    'ENCRYPTED:paste-encrypted-pat-here',
    'YOUR_PAT_HERE',
    'REPLACE_ME',
]);

function readConfigCandidate(configPath: string, workspaceRoot: string): { orgUrl: string; project: string; pat: string } | { partial: { orgUrl?: string; project?: string; rawToken?: string }; reason: string } | null {
    if (!fs.existsSync(configPath)) return null;
    try {
        const j = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        const ado = (j.ado ?? j.azureDevOps ?? j) as Record<string, unknown>;
        const organization = (ado.organization ?? '') as string;
        const project = (ado.project ?? '') as string;
        const baseUrl = ((ado.baseUrl ?? 'https://dev.azure.com') as string).replace(/\/$/, '');
        const rawToken = ((ado.personalAccessToken ?? ado.pat ?? ado.token ?? '') as string).trim();
        let orgUrl = (ado.orgUrl as string) || '';
        if (!orgUrl && organization) orgUrl = `${baseUrl}/${organization}`;
        if (!orgUrl || !project || !rawToken) {
            return { partial: { orgUrl: orgUrl || undefined, project: project || undefined, rawToken: rawToken || undefined }, reason: 'missing-field' };
        }
        if (PAT_PLACEHOLDERS.has(rawToken)) {
            return { partial: { orgUrl, project, rawToken }, reason: 'placeholder-pat' };
        }
        const pat = decryptIfNeeded(rawToken, workspaceRoot);
        if (!pat) return { partial: { orgUrl, project, rawToken }, reason: 'decrypt-failed' };
        return { orgUrl, project, pat };
    } catch {
        return null;
    }
}

// Home-level fallback: ~/.cs-qa/ado-config.json
// Same shape as cs-playwright-mcp.config.json ado block. Lets the user configure
// ADO ONCE and reuse across every workspace, so the workflow never has to invoke
// cs_qa_ask_user for creds just because a new consumer scaffold was bootstrapped.
// Merges with the workspace config: workspace can supply org/project while home
// supplies the PAT (common when the workspace was scaffolded with placeholder PAT).
function loadHomeAdoConfig(workspaceRoot: string): { orgUrl?: string; project?: string; pat?: string } {
    const homeConfig = path.join(os.homedir(), '.cs-qa', 'ado-config.json');
    if (!fs.existsSync(homeConfig)) return {};
    try {
        const j = JSON.parse(fs.readFileSync(homeConfig, 'utf-8')) as Record<string, unknown>;
        const ado = (j.ado ?? j.azureDevOps ?? j) as Record<string, unknown>;
        const organization = (ado.organization ?? '') as string;
        const project = (ado.project ?? '') as string;
        const baseUrl = ((ado.baseUrl ?? 'https://dev.azure.com') as string).replace(/\/$/, '');
        const rawToken = ((ado.personalAccessToken ?? ado.pat ?? ado.token ?? '') as string).trim();
        let orgUrl = (ado.orgUrl as string) || '';
        if (!orgUrl && organization) orgUrl = `${baseUrl}/${organization}`;
        const pat = rawToken && !PAT_PLACEHOLDERS.has(rawToken) ? decryptIfNeeded(rawToken, workspaceRoot) : null;
        return { orgUrl: orgUrl || undefined, project: project || undefined, pat: pat ?? undefined };
    } catch {
        return {};
    }
}

function loadAdoConfig(workspaceRoot: string): { config: { orgUrl: string; project: string; pat: string } | null; diagnostic: string } {
    const candidates = [
        path.join(workspaceRoot, 'cs-playwright-mcp.config.json'),
        path.join(workspaceRoot, 'cs-ai-auto-assist.config.json'),
    ];
    // 1. Try workspace configs
    let partialFromWorkspace: { orgUrl?: string; project?: string; rawToken?: string } | null = null;
    let workspaceReason = '';
    for (const c of candidates) {
        const result = readConfigCandidate(c, workspaceRoot);
        if (result && 'orgUrl' in result && 'pat' in result) {
            return { config: result, diagnostic: `ADO config loaded from ${path.relative(workspaceRoot, c)}` };
        }
        if (result && 'partial' in result) {
            partialFromWorkspace = result.partial;
            workspaceReason = result.reason;
        }
    }
    // 2. Env vars — check every common ADO PAT env var name from other tooling
    //    (az devops CLI uses AZURE_DEVOPS_EXT_PAT; some scripts use AZURE_DEVOPS_TOKEN;
    //    older setups use ADO_PAT / ADO_PERSONAL_ACCESS_TOKEN / AZURE_DEVOPS_PAT).
    //    org/project can also come from workspace config even when only the PAT is in env.
    const envPat = process.env.ADO_PAT
        || process.env.AZURE_DEVOPS_EXT_PAT
        || process.env.AZURE_DEVOPS_TOKEN
        || process.env.AZURE_DEVOPS_PAT
        || process.env.ADO_PERSONAL_ACCESS_TOKEN
        || '';
    if (envPat && (partialFromWorkspace?.orgUrl || process.env.ADO_ORG_URL) && (partialFromWorkspace?.project || process.env.ADO_PROJECT)) {
        const orgUrl = process.env.ADO_ORG_URL || partialFromWorkspace!.orgUrl!;
        const project = process.env.ADO_PROJECT || partialFromWorkspace!.project!;
        const envVarUsed = process.env.ADO_PAT ? 'ADO_PAT'
            : process.env.AZURE_DEVOPS_EXT_PAT ? 'AZURE_DEVOPS_EXT_PAT'
            : process.env.AZURE_DEVOPS_TOKEN ? 'AZURE_DEVOPS_TOKEN'
            : process.env.AZURE_DEVOPS_PAT ? 'AZURE_DEVOPS_PAT'
            : 'ADO_PERSONAL_ACCESS_TOKEN';
        return {
            config: { orgUrl, project, pat: envPat },
            diagnostic: `ADO config: org/project from ${process.env.ADO_ORG_URL ? 'env' : 'workspace'}, PAT from env var ${envVarUsed}`,
        };
    }
    // 3. Home-level fallback — merge with any partial workspace config
    const home = loadHomeAdoConfig(workspaceRoot);
    const orgUrl = partialFromWorkspace?.orgUrl || home.orgUrl;
    const project = partialFromWorkspace?.project || home.project;
    const pat = home.pat;
    if (orgUrl && project && pat) {
        return {
            config: { orgUrl, project, pat },
            diagnostic: `ADO config merged: org/project from workspace (${partialFromWorkspace?.orgUrl ? 'yes' : 'no'}) + PAT from ~/.cs-qa/ado-config.json`,
        };
    }
    // 4. Failure — build a specific diagnostic
    const homeConfigPath = path.join(os.homedir(), '.cs-qa', 'ado-config.json');
    const homeExists = fs.existsSync(homeConfigPath);
    const parts: string[] = ['ADO not configured. Configure ONE of:'];
    if (partialFromWorkspace && workspaceReason === 'placeholder-pat') {
        parts.push(`(a) Replace placeholder PAT in cs-playwright-mcp.config.json → ado.personalAccessToken with a real ENCRYPTED:... value (run 'npx cs-playwright-mcp encrypt <your-pat>' first).`);
    } else if (partialFromWorkspace && workspaceReason === 'decrypt-failed') {
        parts.push(`(a) Fix cs-playwright-mcp.config.json → ado.personalAccessToken — decrypt failed (was the value ever properly encrypted with this workspace's encryption key?).`);
    } else {
        parts.push(`(a) Add ado.organization + ado.project + ado.personalAccessToken (ENCRYPTED:...) to cs-playwright-mcp.config.json.`);
    }
    parts.push(`(b) Set env vars ADO_ORG_URL, ADO_PROJECT, ADO_PAT.`);
    parts.push(`(c) Create ${homeConfigPath} with {"orgUrl":"...","project":"...","personalAccessToken":"ENCRYPTED:..."} — reused across every workspace, no per-workspace re-config. ${homeExists ? '(File exists but is incomplete or has placeholder PAT.)' : '(File does not exist.)'}`);
    if (partialFromWorkspace?.orgUrl && partialFromWorkspace?.project && !pat) {
        parts.push(`Workspace already has org=${partialFromWorkspace.orgUrl.split('/').pop()} project=${partialFromWorkspace.project} — only the PAT is missing. Option (c) is easiest: write ONLY the PAT to ~/.cs-qa/ado-config.json and it merges with the workspace org/project automatically.`);
    }
    return { config: null, diagnostic: parts.join(' ') };
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

async function adoGet(cfg: { orgUrl: string; project: string; pat: string }, urlPath: string): Promise<unknown> {
    const auth = Buffer.from(`:${cfg.pat}`).toString('base64');
    const url = `${cfg.orgUrl.replace(/\/$/, '')}/${cfg.project}/${urlPath.replace(/^\//, '')}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`ADO GET ${url} → ${res.status} ${res.statusText}`);
    return await res.json();
}

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/xhtml'];
const TEXT_EXTENSIONS = new Set(['.log', '.txt', '.md', '.gherkin', '.feature', '.yaml', '.yml', '.json', '.xml', '.csv', '.tsv', '.env', '.properties', '.conf', '.ini']);
const BINARY_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'font/', 'application/pdf', 'application/zip', 'application/octet-stream', 'application/x-tar', 'application/x-gzip'];

function isTextLike(contentType: string, name: string): boolean {
    const ct = (contentType || '').toLowerCase().split(';')[0].trim();
    if (TEXT_MIME_PREFIXES.some((p) => ct.startsWith(p))) return true;
    // application/octet-stream is ambiguous — decide by extension.
    if (ct.startsWith('application/octet-stream') || !ct) {
        const ext = path.extname(name || '').toLowerCase();
        return TEXT_EXTENSIONS.has(ext);
    }
    return false;
}

function isDefinitelyBinary(contentType: string): boolean {
    const ct = (contentType || '').toLowerCase().split(';')[0].trim();
    // octet-stream deliberately EXCLUDED — decided by extension in isTextLike.
    return BINARY_MIME_PREFIXES.some((p) => ct.startsWith(p) && p !== 'application/octet-stream');
}

interface AttachmentRelation {
    id: string;
    name: string;
    url: string;
    size?: number;
    contentType?: string;
}

function extractAttachmentGuidFromUrl(url: string): string | null {
    // ADO attachment URLs end with /_apis/wit/attachments/<guid>?fileName=...
    const m = /\/attachments\/([0-9a-f-]{36})/i.exec(url);
    return m ? m[1] : null;
}

function extractAttachments(workItem: Record<string, unknown> | null): AttachmentRelation[] {
    if (!workItem) return [];
    const relations = ((workItem.relations as Array<Record<string, unknown>>) || []).filter((r) => r && (r.rel === 'AttachedFile'));
    return relations.map((r) => {
        const url = String(r.url ?? '');
        const attrs = (r.attributes as Record<string, unknown>) || {};
        return {
            id: extractAttachmentGuidFromUrl(url) ?? '',
            name: String(attrs.name ?? ''),
            url,
            size: attrs.resourceSize === undefined ? undefined : Number(attrs.resourceSize),
            contentType: (attrs.resourceContentType as string) || undefined,
        };
    }).filter((a) => a.id !== '');
}

registerPrimitive({
    name: 'cs_qa_ado_read',
    description: 'Read from Azure DevOps (on-prem or cloud). Verbs: work-item (by id), test-plan (by id + optional include suites), test-suite (by planId+suiteId), test-cases (by suiteId), pull-request (by id), pr-changes (files in a PR), repo-list, branch-list, attachment (list or inline-download attachments on a work item — content-type-aware; binary types never inlined; text/markdown/json/xml decoded UTF-8; size cap to prevent OOM). Auth via cs-ai-auto-assist.config.json OR ADO_* env vars.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({ verb: z.literal('work-item'), id: z.number().int().positive(), expand: z.enum(['none', 'relations', 'all']).default('relations') }),
        z.object({ verb: z.literal('test-plan'), planId: z.number().int().positive(), includeSuites: z.boolean().default(true) }),
        z.object({ verb: z.literal('test-suite'), planId: z.number().int().positive(), suiteId: z.number().int().positive() }),
        z.object({ verb: z.literal('test-cases'), planId: z.number().int().positive(), suiteId: z.number().int().positive() }),
        z.object({ verb: z.literal('pull-request'), repoId: z.string().min(1), prId: z.number().int().positive() }),
        z.object({ verb: z.literal('pr-changes'), repoId: z.string().min(1), prId: z.number().int().positive() }),
        z.object({ verb: z.literal('repo-list') }),
        z.object({ verb: z.literal('branch-list'), repoId: z.string().min(1) }),
        z.object({
            verb: z.literal('attachment'),
            workItemId: z.number().int().positive(),
            attachmentId: z.string().min(1).optional().describe('ADO attachment GUID. When omitted (and no name), returns the list of attachments on the work item (metadata only).'),
            name: z.string().min(1).optional().describe('Attachment filename — used when attachmentId is not supplied; matched case-insensitive.'),
            maxInlineBytes: z.number().int().positive().default(200_000).describe('Attachments larger than this are returned as metadata + downloadUrl only, unless forceInline=true.'),
            forceInline: z.boolean().default(false).describe('When true, ignore the maxInlineBytes cap. Only valid for text-like content-types.'),
        }),
        z.object({
            verb: z.literal('repo-fs'),
            action: z.enum(['list', 'read']).describe('list = folder listing (repo-relative path). read = file content (repo-relative path).'),
            repositoryId: z.string().min(1).optional().describe('ADO Git repo id. Either repositoryId or repositoryName is required.'),
            repositoryName: z.string().min(1).optional().describe('ADO Git repo name — resolved via repo-list when repositoryId is absent.'),
            path: z.string().min(1).describe('Repo-relative path. For list, use "/" to enumerate the repo root.'),
            branch: z.string().min(1).default('main').describe('Branch name (without refs/heads/ prefix). Defaults to main.'),
        }),
    ]),
    outputSchema: z.object({
        verb: z.string(),
        data: z.unknown(),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const loaded = loadAdoConfig(ctx.workspaceRoot);
        if (!loaded.config) {
            return { verb: input.verb, data: null, note: loaded.diagnostic };
        }
        const cfg = loaded.config;

        // Attachment verb — content-type-aware inline / metadata / downloadUrl. Uses
        // AdoHttpClient because it handles Retry-After, response caps, and the shared
        // per-attempt timeout that the ad-hoc fetch() path below does not.
        if (input.verb === 'attachment') {
            try {
                const client = new AdoHttpClient(cfg);
                // Step 1 — fetch relations if we don't already have the specific ID.
                let attachments: AttachmentRelation[] = [];
                if (!input.attachmentId) {
                    const wi = await client.get<Record<string, unknown>>(
                        `_apis/wit/workitems/${input.workItemId}?api-version=7.0&$expand=relations`,
                    );
                    attachments = extractAttachments(wi);
                    if (attachments.length === 0) {
                        return { verb: 'attachment', data: { workItemId: input.workItemId, attachments: [] }, note: `Work item ${input.workItemId} has no attachments.` };
                    }
                    // If neither ID nor name: return metadata list only.
                    if (!input.name) {
                        return {
                            verb: 'attachment',
                            data: {
                                workItemId: input.workItemId,
                                attachments: attachments.map((a) => ({ id: a.id, name: a.name, size: a.size, contentType: a.contentType, isInlined: false, downloadUrl: a.url })),
                            },
                            note: `${attachments.length} attachment(s) on work item ${input.workItemId}. Re-invoke with attachmentId (or name) to inline-download one.`,
                        };
                    }
                    const needle = input.name.toLowerCase();
                    const match = attachments.find((a) => a.name.toLowerCase() === needle)
                        ?? attachments.find((a) => a.name.toLowerCase().includes(needle));
                    if (!match) {
                        return {
                            verb: 'attachment',
                            data: { workItemId: input.workItemId, attachments: [] },
                            note: `No attachment named "${input.name}" on work item ${input.workItemId}. Available: ${attachments.map((a) => a.name).join(', ')}`,
                        };
                    }
                    attachments = [match];
                } else {
                    // ID was passed directly — no relations lookup needed.
                    attachments = [{ id: input.attachmentId, name: input.name ?? 'attachment', url: `${cfg.orgUrl.replace(/\/$/, '')}/${cfg.project}/_apis/wit/attachments/${input.attachmentId}`, size: undefined, contentType: undefined }];
                }

                // Step 2 — for each candidate, download binary and shape the response.
                const results = [] as Array<{ id: string; name: string; size?: number; contentType?: string; isInlined: boolean; content?: string; downloadUrl: string; warnings: string[] }>;
                for (const att of attachments) {
                    const warnings: string[] = [];
                    let bin: AdoBinaryResponse;
                    try {
                        bin = await client.getBinary(
                            `_apis/wit/attachments/${att.id}?download=true&api-version=7.0`,
                            { maxResponseBytes: Math.max(input.maxInlineBytes * 4, 5 * 1024 * 1024) },
                        );
                    } catch (e) {
                        results.push({ id: att.id, name: att.name, size: att.size, contentType: att.contentType, isInlined: false, downloadUrl: att.url, warnings: [`download failed: ${(e as Error).message}`] });
                        continue;
                    }
                    const contentType = bin.contentType || att.contentType || 'application/octet-stream';
                    const size = bin.contentLength || bin.body.length;
                    const definitelyBinary = isDefinitelyBinary(contentType);
                    const textLike = !definitelyBinary && isTextLike(contentType, att.name);

                    if (definitelyBinary) {
                        warnings.push('binary content-type — never inlined');
                        results.push({ id: att.id, name: att.name, size, contentType, isInlined: false, downloadUrl: att.url, warnings });
                        continue;
                    }
                    if (!textLike) {
                        warnings.push(`content-type ${contentType} is ambiguous; not inlined. Extension ${path.extname(att.name).toLowerCase() || 'unknown'} not in text list.`);
                        results.push({ id: att.id, name: att.name, size, contentType, isInlined: false, downloadUrl: att.url, warnings });
                        continue;
                    }
                    if (bin.truncated) warnings.push(`response truncated at cap`);
                    const tooBig = size > input.maxInlineBytes;
                    if (tooBig && !input.forceInline) {
                        warnings.push(`${size} bytes exceeds maxInlineBytes ${input.maxInlineBytes}; returning downloadUrl only. Pass forceInline:true or raise maxInlineBytes.`);
                        results.push({ id: att.id, name: att.name, size, contentType, isInlined: false, downloadUrl: att.url, warnings });
                        continue;
                    }
                    // Decode UTF-8 without JSON.parse. Parsing here would re-pretty-print
                    // valid JSON payloads and convert a plain-text file with a leading `{`
                    // into an object dump. Return exactly what the server sent.
                    const content = bin.body.toString('utf-8');
                    results.push({ id: att.id, name: att.name, size, contentType, isInlined: true, content, downloadUrl: att.url, warnings });
                }
                return {
                    verb: 'attachment',
                    data: { workItemId: input.workItemId, attachments: results },
                    note: results.some((r) => r.isInlined) ? `Inlined ${results.filter((r) => r.isInlined).length} of ${results.length} attachment(s).` : `Returned metadata only for ${results.length} attachment(s).`,
                };
            } catch (e) {
                return { verb: 'attachment', data: null, note: (e as Error).message };
            }
        }

        // repo-fs verb — ADO Git items REST (list a folder or read a file). Uses
        // AdoHttpClient because it handles Retry-After + per-attempt timeouts.
        if (input.verb === 'repo-fs') {
            try {
                const client = new AdoHttpClient(cfg);
                let repoId = input.repositoryId;
                if (!repoId) {
                    if (!input.repositoryName) {
                        return { verb: 'repo-fs', data: null, note: 'repo-fs requires repositoryId or repositoryName.' };
                    }
                    const list = await client.get<{ value?: Array<{ id: string; name: string }> }>(`_apis/git/repositories?api-version=7.1`);
                    const match = (list.value || []).find((r) => r.name.toLowerCase() === input.repositoryName!.toLowerCase());
                    if (!match) return { verb: 'repo-fs', data: null, note: `Repo "${input.repositoryName}" not found.` };
                    repoId = match.id;
                }
                if (input.action === 'list') {
                    const scopePath = input.path === '/' ? '/' : (input.path.startsWith('/') ? input.path : '/' + input.path);
                    const q = new URLSearchParams({
                        scopePath,
                        recursionLevel: 'OneLevel',
                        'versionDescriptor.version': input.branch,
                        'api-version': '7.1',
                    });
                    const data = await client.get<{ value?: Array<{ path: string; gitObjectType: string; isFolder?: boolean; size?: number; commitId?: string; url?: string }> }>(
                        `_apis/git/repositories/${repoId}/items?${q.toString()}`,
                    );
                    return {
                        verb: 'repo-fs',
                        data: {
                            action: 'list', repositoryId: repoId, branch: input.branch,
                            path: scopePath,
                            entries: (data.value || []).map((e) => ({ path: e.path, kind: e.isFolder ? 'folder' : 'file', size: e.size, gitObjectType: e.gitObjectType })),
                        },
                        note: `Listed ${(data.value || []).length} entries at ${scopePath} @ ${input.branch}.`,
                    };
                }
                if (input.action === 'read') {
                    const q = new URLSearchParams({
                        path: input.path.startsWith('/') ? input.path : '/' + input.path,
                        'versionDescriptor.version': input.branch,
                        includeContent: 'true',
                        '$format': 'json',
                        'api-version': '7.1',
                    });
                    const data = await client.get<{ path?: string; content?: string; size?: number; commitId?: string; objectId?: string }>(
                        `_apis/git/repositories/${repoId}/items?${q.toString()}`,
                    );
                    return {
                        verb: 'repo-fs',
                        data: {
                            action: 'read', repositoryId: repoId, branch: input.branch,
                            path: data.path,
                            size: data.size,
                            commitId: data.commitId,
                            content: data.content,
                        },
                        note: `Read ${data.path} @ ${input.branch} (${data.size ?? 'unknown'} bytes).`,
                    };
                }
                return { verb: 'repo-fs', data: null, note: `Unknown action: ${(input as { action: string }).action}` };
            } catch (e) {
                return { verb: 'repo-fs', data: null, note: (e as Error).message };
            }
        }

        try {
            let path = '';
            if (input.verb === 'work-item') {
                const expand = input.expand === 'none' ? '' : `&$expand=${input.expand}`;
                path = `_apis/wit/workitems/${input.id}?api-version=7.0${expand}`;
            } else if (input.verb === 'test-plan') {
                path = `_apis/testplan/plans/${input.planId}?api-version=7.0`;
            } else if (input.verb === 'test-suite') {
                path = `_apis/testplan/plans/${input.planId}/suites/${input.suiteId}?api-version=7.0`;
            } else if (input.verb === 'test-cases') {
                path = `_apis/testplan/plans/${input.planId}/suites/${input.suiteId}/testcases?api-version=7.0`;
            } else if (input.verb === 'pull-request') {
                path = `_apis/git/repositories/${input.repoId}/pullrequests/${input.prId}?api-version=7.0`;
            } else if (input.verb === 'pr-changes') {
                path = `_apis/git/repositories/${input.repoId}/pullrequests/${input.prId}/iterations?api-version=7.0&$expand=changes`;
            } else if (input.verb === 'repo-list') {
                path = `_apis/git/repositories?api-version=7.0`;
            } else if (input.verb === 'branch-list') {
                path = `_apis/git/repositories/${input.repoId}/refs?filter=heads&api-version=7.0`;
            }
            const data = await adoGet(cfg, path);
            // For work-item reads, persist an AC checkpoint so verify_generated can
            // hard-error if generated scenarios don't cover every acceptance criterion.
            // Without this, coverage collapse (Copilot silently generating 5 scenarios
            // for a 20-AC story) is invisible to the toolchain.
            let acNote = '';
            if (input.verb === 'work-item' && data && typeof data === 'object') {
                try {
                    const acCount = writeAcsCheckpoint(ctx.workspaceRoot, input.id, data as Record<string, unknown>);
                    if (acCount > 0) acNote = ` Extracted ${acCount} acceptance criteria to .cs-qa/run-state/story-${input.id}-acs.json — verify_generated will now reject unless every AC has a matching scenario tag @ac1..@ac${acCount} (or @ac1-*, @ac2-*, ...).`;
                } catch { /* extraction is best-effort; never break the tool */ }
            }
            return { verb: input.verb, data, note: acNote || undefined };
        } catch (e) {
            return { verb: input.verb, data: null, note: (e as Error).message };
        }
    },
});

// AC extraction + persistence.
//
// ADO work items carry acceptance criteria in Microsoft.VSTS.Common.AcceptanceCriteria
// (HTML) — or in System.Description as fallback. We parse the HTML into a numbered
// list and write a JSON checkpoint under .cs-qa/run-state/. The verifier reads this
// file and hard-errors on any AC that has no matching @ac<n> or @ac<n>-* tagged
// scenario. Returns the AC count so the tool can surface it in its note.
function writeAcsCheckpoint(workspaceRoot: string, storyId: number, workItem: Record<string, unknown>): number {
    const fields = (workItem.fields ?? {}) as Record<string, unknown>;
    const acHtml = (fields['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? fields['Custom.AcceptanceCriteria'] ?? '') as string;
    const descHtml = (fields['System.Description'] ?? '') as string;
    const acs = parseAcceptanceCriteria(acHtml) || parseAcceptanceCriteria(descHtml);
    if (!acs || acs.length === 0) return 0;

    const stateDir = path.join(workspaceRoot, '.cs-qa', 'run-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const checkpoint = {
        storyId,
        source: acHtml ? 'Microsoft.VSTS.Common.AcceptanceCriteria' : 'System.Description',
        extractedAt: new Date().toISOString(),
        acs: acs.map((text, i) => ({ index: i + 1, tag: `ac${i + 1}`, text })),
    };
    fs.writeFileSync(
        path.join(stateDir, `story-${storyId}-acs.json`),
        JSON.stringify(checkpoint, null, 2),
        'utf-8',
    );
    return acs.length;
}

function parseAcceptanceCriteria(html: string): string[] | null {
    if (!html || typeof html !== 'string' || !html.trim()) return null;
    // Normalize block-level tags to newlines, then strip remaining tags + decode entities.
    const withBreaks = html
        .replace(/<\s*(br|BR)\s*\/?>/g, '\n')
        .replace(/<\s*\/\s*(p|P|div|DIV|li|LI|tr|TR)\s*>/g, '\n')
        .replace(/<\s*(p|P|div|DIV|li|LI|tr|TR)[^>]*>/g, '\n');
    const stripped = withBreaks.replace(/<[^>]+>/g, '');
    const decoded = stripped
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&(rsquo|lsquo);/g, '\'')
        .replace(/&(rdquo|ldquo);/g, '"');
    const lines = decoded
        .split(/\n+/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0) return null;

    // Detect numbered/bulleted items. If any line looks numbered ("1.", "AC1:", "- ", "* ", "•"),
    // treat those specifically; strip prefixes.
    const numberedPrefix = /^\s*(?:AC|ac|Ac)?\s*[0-9]+\s*[.):-]\s*(.+)$/;
    const bulletedPrefix = /^\s*[-*•]\s*(.+)$/;
    const items: string[] = [];
    for (const line of lines) {
        const nm = numberedPrefix.exec(line);
        const bm = bulletedPrefix.exec(line);
        if (nm) items.push(nm[1].trim());
        else if (bm) items.push(bm[1].trim());
    }
    // If we found any structured items, use them. Otherwise fall back to treating each
    // non-empty line as an AC — better to overcount and force the user to prune than
    // undercount and let coverage collapse slip through.
    if (items.length >= 2) return items;
    return lines;
}
