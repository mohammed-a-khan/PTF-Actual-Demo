/**
 * cs_qa_service_hook_subscribe — Manage ADO Service Hooks subscriptions.
 *
 * Verbs:
 *   create — POST /_apis/hooks/subscriptions?api-version=7.1
 *   list   — GET
 *   delete — DELETE /_apis/hooks/subscriptions/{id}?api-version=7.1
 *
 * Supported publishers/events:
 *   workitem.created / workitem.updated       (publisherId=tfs)
 *   build.complete                            (publisherId=tfs)
 *   git.pullrequest.created                   (publisherId=tfs)
 *   git.push                                  (publisherId=tfs)
 *
 * Filters: passed as `publisherInputs` (project id auto-injected from creds).
 * The consumer is `webHooks` with `webHookNotification` shape:
 *   consumerInputs.url = targetUrl
 *
 * Real HTTP via AdoHttpClient. Never hardcoded org.
 */

import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

const SUPPORTED_EVENTS = [
    'workitem.created',
    'workitem.updated',
    'build.complete',
    'git.pullrequest.created',
    'git.push',
] as const;

type Event = typeof SUPPORTED_EVENTS[number];

interface Subscription {
    id: string;
    publisherId: string;
    eventType: string;
    consumerId: string;
    consumerActionId: string;
    consumerInputs?: Record<string, string>;
    publisherInputs?: Record<string, string>;
    status?: string;
}

function eventToPublisherInputs(eventType: Event, projectId: string, filters: Record<string, string> | undefined): Record<string, string> {
    const inputs: Record<string, string> = { projectId };
    // Event-specific defaults + user-supplied overrides.
    if (eventType.startsWith('git.') && filters) {
        // ADO's git.* publishers accept `repository` and `branch` publisher inputs;
        // wire the caller-supplied filter values through when present so the
        // subscription is scoped rather than firing for every repo in the project.
        if (filters.repository) inputs.repository = String(filters.repository);
        if (filters.branch) inputs.branch = String(filters.branch);
    }
    if (filters) {
        for (const [k, v] of Object.entries(filters)) inputs[k] = String(v);
    }
    return inputs;
}

async function resolveProjectId(client: AdoHttpClient, projectName: string): Promise<string> {
    try {
        const p = await client.get<{ id?: string }>(`_apis/projects/${encodeURIComponent(projectName)}?api-version=7.1`, { scopeToProject: false });
        return String(p?.id || projectName);
    } catch {
        return projectName;
    }
}

registerPrimitive({
    name: 'cs_qa_service_hook_subscribe',
    description: 'Create, list, or delete Azure DevOps Service Hook subscriptions that push events to a webhook receiver. Supported publishers: workitem.created, workitem.updated, build.complete, git.pullrequest.created, git.push. On create, the tool auto-resolves the project id and injects it as publisherInputs.projectId; user-supplied filters (repository, branch, buildDefinitionId, tags, etc.) are merged on top. Example: cs_qa_service_hook_subscribe verb:"create" eventType:"build.complete" targetUrl:"https://ci.example.com/hook" filters:{"definitionName":"nightly"}.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('create'),
            eventType: z.enum(SUPPORTED_EVENTS),
            targetUrl: z.string().url(),
            filters: z.record(z.string(), z.string()).optional(),
            basicAuthUsername: z.string().optional(),
            basicAuthPassword: z.string().optional(),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
            pat: z.string().min(1).optional(),
        }),
        z.object({
            verb: z.literal('list'),
            eventType: z.enum(SUPPORTED_EVENTS).optional(),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
            pat: z.string().min(1).optional(),
        }),
        z.object({
            verb: z.literal('delete'),
            subscriptionId: z.string().min(1),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
            pat: z.string().min(1).optional(),
        }),
    ]),
    outputSchema: z.object({
        ok: z.boolean(),
        verb: z.string(),
        subscriptionId: z.string().optional(),
        publisher: z.string().optional(),
        event: z.string().optional(),
        targetUrl: z.string().optional(),
        status: z.string().optional(),
        subscriptions: z.array(z.object({
            id: z.string(),
            publisherId: z.string(),
            eventType: z.string(),
            targetUrl: z.string().optional(),
            status: z.string().optional(),
        })).optional(),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_service_hook_subscribe', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
        });
        if (!credsRes.creds) {
            return {
                ok: false, verb: input.verb, warnings: [credsRes.diagnostic],
                note: 'ADO not configured — cannot manage service hooks.',
            };
        }
        const cfg: AdoCreds = credsRes.creds;
        const client = new AdoHttpClient(cfg);

        if (input.verb === 'list') {
            const body = await client.get<{ value?: Subscription[] }>(`_apis/hooks/subscriptions?api-version=7.1`, { scopeToProject: false });
            const rows = (body?.value || []).filter((s) => !input.eventType || s.eventType === input.eventType);
            log.info('subs listed', { count: rows.length });
            return {
                ok: true, verb: 'list',
                subscriptions: rows.map((s) => ({
                    id: s.id,
                    publisherId: s.publisherId,
                    eventType: s.eventType,
                    targetUrl: s.consumerInputs?.url,
                    status: s.status,
                })),
                warnings,
                note: `${rows.length} subscription(s)${input.eventType ? ` matching ${input.eventType}` : ''}.`,
            };
        }

        if (input.verb === 'delete') {
            try {
                await client.delete(`_apis/hooks/subscriptions/${encodeURIComponent(input.subscriptionId)}?api-version=7.1`, { scopeToProject: false });
                log.info('sub deleted', { id: input.subscriptionId });
                return { ok: true, verb: 'delete', subscriptionId: input.subscriptionId, warnings, note: `Subscription ${input.subscriptionId} deleted.` };
            } catch (e) {
                warnings.push(`delete failed: ${(e as Error).message}`);
                return { ok: false, verb: 'delete', subscriptionId: input.subscriptionId, warnings, note: 'Delete failed — see warnings.' };
            }
        }

        // verb === 'create'
        const projectId = await resolveProjectId(client, cfg.project);
        const publisherInputs = eventToPublisherInputs(input.eventType, projectId, input.filters);
        const consumerInputs: Record<string, string> = { url: input.targetUrl };
        if (input.basicAuthUsername) consumerInputs.basicAuthUsername = input.basicAuthUsername;
        if (input.basicAuthPassword) consumerInputs.basicAuthPassword = input.basicAuthPassword;
        const body = {
            publisherId: 'tfs',
            eventType: input.eventType,
            consumerId: 'webHooks',
            consumerActionId: 'httpRequest',
            publisherInputs,
            consumerInputs,
            resourceVersion: '1.0',
        };
        try {
            const created = await client.post<Subscription>(`_apis/hooks/subscriptions?api-version=7.1`, body, { scopeToProject: false });
            log.info('sub created', { id: created?.id, event: input.eventType });
            return {
                ok: true, verb: 'create',
                subscriptionId: String(created?.id || ''),
                publisher: created?.publisherId,
                event: created?.eventType || input.eventType,
                targetUrl: created?.consumerInputs?.url || input.targetUrl,
                status: created?.status,
                warnings,
                note: `Subscription created: ${input.eventType} → ${input.targetUrl}`,
            };
        } catch (e) {
            warnings.push(`create failed: ${(e as Error).message}`);
            return {
                ok: false, verb: 'create',
                event: input.eventType, targetUrl: input.targetUrl,
                warnings,
                note: 'Subscription creation failed — see warnings.',
            };
        }
    },
});
