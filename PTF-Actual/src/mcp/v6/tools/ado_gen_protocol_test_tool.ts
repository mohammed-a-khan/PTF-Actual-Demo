/**
 * cs_qa_gen_protocol_test — one verb-driven primitive that materialises API
 * test suites across five protocols behind a single dispatch surface:
 *
 *   verb: 'rest'      — REST endpoints (inline list, or delegated to
 *                       cs_qa_import_openapi when an OpenAPI spec is supplied)
 *   verb: 'soap'      — delegates to cs_qa_gen_soap_test
 *   verb: 'graphql'   — delegates to cs_qa_gen_graphql_test
 *   verb: 'pact'      — consumer-driven contract tests (Pact JS)
 *   verb: 'websocket' — WebSocket scenarios (Node `ws` package at runtime)
 *
 * Why one tool, five verbs (as opposed to five sibling tools):
 *  - a single Copilot skill can route the intent — the user says "add a
 *    contract test", "add a WebSocket test", "add a REST test for this
 *    endpoint" and the same primitive picks the right emitter.
 *  - the two mature emitters (SOAP + GraphQL) already exist and are exercised
 *    by their own smoke suites; the discriminator delegates rather than
 *    duplicates them.
 *  - the three new emitters (REST, Pact, WebSocket) share the same envelope:
 *    two-phase confirmation for the ADO write side, encrypted env template
 *    placeholders, CSReporter for logging, no console.log, no hard-coded
 *    credentials.
 *
 * ADO Test Case creation for the new verbs is gated by two-phase confirmation
 * (see the `.confirmed` field on the input schema). The delegated verbs
 * (soap + graphql) inherit their own primitives' confirmation gates.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive, getPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import {
    emitFeatureFile as emitRestFeature,
    emitStepDefs as emitRestStepDefs,
    emitRestHelper,
    emitEnvTemplate as emitRestEnvTemplate,
    type RestEndpoint,
    type EmittedRestFile,
} from './_helpers/rest_builder';
import {
    emitPactSpec,
    type PactInteraction,
    type EmittedPactBundle,
} from './_helpers/pact_builder';
import {
    emitWsFeatureFiles,
    emitWsStepDefs,
    emitWsHelper,
    emitWsReadme,
    emitWsEnvTemplate,
    type WsScenario,
} from './_helpers/websocket_builder';

// =============================================================================
// Common cred fields — shared across every verb that may touch ADO.
// =============================================================================

const CredFields = {
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
    createAdoTc: z.boolean().default(false),
    planId: z.number().int().positive().optional(),
    planName: z.string().optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().optional(),
    dryRun: z.boolean().default(false),
    confirmed: z.boolean().default(false).describe('Two-phase gate for ADO Test Case creation. Without it, the verb returns requiresConfirmation:true with a preview.'),
};

// =============================================================================
// Discriminated union — one shape per verb.
// =============================================================================

const RestEndpointSchema = z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
    path: z.string().min(1),
    requestBody: z.unknown().optional(),
    expectedStatus: z.number().int().min(100).max(599).optional(),
    description: z.string().optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
});

const RestVerbSchema = z.object({
    verb: z.literal('rest'),
    openApiSpecPath: z.string().optional().describe('Local OpenAPI/Swagger spec path — delegates to cs_qa_import_openapi.'),
    openApiSpecUrl: z.string().url().optional().describe('Remote OpenAPI spec URL — delegates to cs_qa_import_openapi.'),
    endpointsInline: z.array(RestEndpointSchema).optional().describe('Inline endpoint list — used when neither OpenAPI source is supplied.'),
    outputRoot: z.string().default('test/api/rest'),
    baseUrlEnvVar: z.string().default('REST_BASE_URL'),
    authTokenEnvVar: z.string().default('API_AUTH_TOKEN'),
    ...CredFields,
});

const SoapVerbSchema = z.object({
    verb: z.literal('soap'),
    // Forwarded transparently to cs_qa_gen_soap_test — kept loose so future
    // fields on the delegate don't require re-versioning this schema.
}).passthrough();

const GraphqlVerbSchema = z.object({
    verb: z.literal('graphql'),
    // Forwarded transparently to cs_qa_gen_graphql_test.
}).passthrough();

const PactInteractionSchema = z.object({
    description: z.string().min(1),
    providerState: z.string().optional(),
    request: z.object({
        method: z.string().min(1),
        path: z.string().min(1),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
        query: z.record(z.string(), z.string()).optional(),
    }),
    response: z.object({
        status: z.number().int().min(100).max(599),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
    }),
});

const PactVerbSchema = z.object({
    verb: z.literal('pact'),
    consumerName: z.string().min(1),
    providerName: z.string().min(1),
    pactVersion: z.number().int().min(2).max(4).default(4),
    interactions: z.array(PactInteractionSchema).min(1),
    outputRoot: z.string().default('test/api/pact'),
    pactBrokerUrl: z.string().url().optional(),
    pactBrokerAuthTokenEnvVar: z.string().default('PACT_BROKER_TOKEN'),
    ...CredFields,
});

const WsScenarioSchema = z.object({
    name: z.string().min(1),
    connect: z.object({ headers: z.record(z.string(), z.string()).optional() }).optional(),
    send: z.array(z.object({ message: z.string(), waitFor: z.string().optional() })).default([]),
    expectMessages: z.array(z.object({ matches: z.string(), timeoutMs: z.number().int().positive().optional() })).default([]),
    expectClose: z.object({ code: z.number().int().optional() }).optional(),
});

const WebsocketVerbSchema = z.object({
    verb: z.literal('websocket'),
    wsUrl: z.string().url(),
    authTokenEnvVar: z.string().default('WS_AUTH_TOKEN'),
    scenarios: z.array(WsScenarioSchema).min(1),
    outputRoot: z.string().default('test/api/websocket'),
    ...CredFields,
});

const InputSchema = z.discriminatedUnion('verb', [
    RestVerbSchema,
    SoapVerbSchema,
    GraphqlVerbSchema,
    PactVerbSchema,
    WebsocketVerbSchema,
]);

type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.string(),
    delegatedTo: z.string().optional(),
    delegateResult: z.unknown().optional(),
    generated: z.object({
        featureFiles: z.array(z.object({ path: z.string(), scenarios: z.array(z.string()) })).default([]),
        stepDefFiles: z.array(z.string()).default([]),
        helperFiles: z.array(z.string()).default([]),
        specFiles: z.array(z.string()).default([]),
        readmeFile: z.string().optional(),
        envTemplateFile: z.string().optional(),
    }).default({ featureFiles: [], stepDefFiles: [], helperFiles: [], specFiles: [] }),
    tcsCreated: z.number().default(0),
    tcsSkipped: z.array(z.object({ scenario: z.string(), reason: z.string() })).default([]),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
    requiresConfirmation: z.boolean().optional(),
    destructive: z.boolean().optional(),
    confirmationHint: z.string().optional(),
});

// =============================================================================
// Naming/escaping.
// =============================================================================

function xmlEscape(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'protocol';
}

// =============================================================================
// ADO TC composition (shared across verbs that spawn TCs directly).
// =============================================================================

interface TcPayload {
    verb: string;
    title: string;
    tags: string;
    scenario: string;
    steps: Array<{ action: string; expected: string }>;
    descriptionHtml: string;
}

function composeStepsXml(steps: Array<{ action: string; expected: string }>): string {
    const rows: string[] = [];
    let i = 1;
    for (const s of steps) {
        rows.push(`<step id="${i}" type="ActionStep"><parameterizedString isformatted="true">&lt;P&gt;${xmlEscape(s.action)}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${xmlEscape(s.expected)}&lt;/P&gt;</parameterizedString><description/></step>`);
        i++;
    }
    return `<steps id="0" last="${i - 1}">${rows.join('')}</steps>`;
}

async function createAdoTcs(
    ctx: { workspaceRoot: string; invocationId: string },
    input: { orgUrl?: string; project?: string; pat?: string },
    payloads: TcPayload[],
    log: ReturnType<typeof createLogger>,
): Promise<{ tcsCreated: number; tcsSkipped: Array<{ scenario: string; reason: string }>; diagnostic?: string }> {
    const credsRes = getResolvedCreds(ctx.workspaceRoot, {
        orgUrl: input.orgUrl,
        project: input.project,
        personalAccessToken: input.pat,
    });
    if (!credsRes.creds) {
        return { tcsCreated: 0, tcsSkipped: payloads.map((p) => ({ scenario: p.scenario, reason: credsRes.diagnostic })), diagnostic: credsRes.diagnostic };
    }
    const cfg: AdoCreds = credsRes.creds;
    const client = new AdoHttpClient(cfg);
    const bulk = await bulkExecute(payloads, {
        chunkSize: 1,
        concurrency: 4,
        workFn: async (batch) => {
            const p = batch[0];
            const patch: Array<Record<string, unknown>> = [
                { op: 'add', path: '/fields/System.Title', value: p.title },
                { op: 'add', path: '/fields/System.Description', value: p.descriptionHtml },
                { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: composeStepsXml(p.steps) },
                { op: 'add', path: '/fields/System.Tags', value: p.tags },
            ];
            const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Test%20Case?api-version=7.0`, patch);
            return [{ tcId: Number(created.id || 0), scenario: p.scenario }];
        },
        onChunkError: (err, chunk) => {
            log.warn('Protocol TC creation failed', { scenario: chunk[0].scenario, error: err.message });
        },
    });
    return {
        tcsCreated: bulk.ok.length,
        tcsSkipped: bulk.failed.map((f) => ({ scenario: f.item.scenario, reason: f.error.message })),
    };
}

// =============================================================================
// REST verb.
// =============================================================================

async function runRestVerb(
    ctx: { workspaceRoot: string; invocationId: string },
    input: z.infer<typeof RestVerbSchema>,
    log: ReturnType<typeof createLogger>,
): Promise<z.infer<typeof OutputSchema>> {
    const warnings: string[] = [];

    // If an OpenAPI source is supplied, delegate to cs_qa_import_openapi so we
    // reuse its parse/emission pipeline instead of reinventing it.
    if (input.openApiSpecPath || input.openApiSpecUrl) {
        const delegate = getPrimitive('cs_qa_import_openapi');
        if (!delegate) {
            return {
                ok: false,
                verb: 'rest',
                generated: { featureFiles: [], stepDefFiles: [], helperFiles: [], specFiles: [] },
                tcsCreated: 0, tcsSkipped: [], warnings,
                note: 'OpenAPI mode requires cs_qa_import_openapi to be registered — not found.',
            };
        }
        const delegateInput: Record<string, unknown> = {
            ...(input.openApiSpecPath ? { specPath: input.openApiSpecPath } : {}),
            ...(input.openApiSpecUrl ? { specUrl: input.openApiSpecUrl } : {}),
            planId: input.planId,
            planName: input.planName,
            suiteId: input.suiteId,
            suiteName: input.suiteName,
            outputRoot: input.outputRoot,
            generateFeatureFiles: true,
            generateStepDefs: true,
            dryRun: input.dryRun,
            orgUrl: input.orgUrl,
            project: input.project,
            pat: input.pat,
        };
        const result = await delegate.run(
            ctx as unknown as Parameters<typeof delegate.run>[0],
            delegateInput as unknown as Parameters<typeof delegate.run>[1],
        );
        const r = result as Record<string, unknown>;
        return {
            ok: Boolean(r.ok),
            verb: 'rest',
            delegatedTo: 'cs_qa_import_openapi',
            delegateResult: result,
            generated: {
                featureFiles: (Array.isArray(r.featureFilesGenerated) ? (r.featureFilesGenerated as Array<{ path: string; scenarioCount?: number }>) : []).map((f) => ({ path: f.path, scenarios: Array(f.scenarioCount ?? 1).fill('scenario') })),
                stepDefFiles: r.stepDefFile ? [String(r.stepDefFile)] : [],
                helperFiles: [],
                specFiles: [],
            },
            tcsCreated: Number(r.tcsCreated || 0),
            tcsSkipped: (Array.isArray(r.tcsSkipped) ? (r.tcsSkipped as Array<{ endpoint?: string; reason?: string }>) : []).map((t) => ({ scenario: String(t.endpoint || ''), reason: String(t.reason || '') })),
            warnings: [...warnings, ...(Array.isArray(r.warnings) ? r.warnings.map(String) : [])],
            note: `REST via OpenAPI — ${r.note || 'delegated'}`,
        };
    }

    // Inline endpoints path.
    const endpoints = input.endpointsInline || [];
    if (endpoints.length === 0) {
        return {
            ok: false,
            verb: 'rest',
            generated: { featureFiles: [], stepDefFiles: [], helperFiles: [], specFiles: [] },
            tcsCreated: 0, tcsSkipped: [], warnings,
            note: 'REST verb requires either openApiSpecPath, openApiSpecUrl, or endpointsInline[].',
        };
    }

    // Defaults may not always propagate through the primitive runner — guard.
    const outputRootRel = input.outputRoot || 'test/api/rest';
    const authTokenEnvVar = input.authTokenEnvVar || 'API_AUTH_TOKEN';
    const baseUrlEnvVar = input.baseUrlEnvVar || 'REST_BASE_URL';
    const outputRoot = path.isAbsolute(outputRootRel)
        ? outputRootRel
        : path.join(ctx.workspaceRoot, outputRootRel);

    const emitted: EmittedRestFile[] = [];
    let stepDefFile: string | undefined;
    let helperFile: string | undefined;
    let envTemplateFile: string | undefined;

    if (!input.dryRun) {
        fs.mkdirSync(outputRoot, { recursive: true });
        for (const ep of endpoints) {
            emitted.push(emitRestFeature({
                outputRoot,
                endpoint: ep as RestEndpoint,
                authTokenEnvVar,
            }));
        }
        stepDefFile = emitRestStepDefs({
            outputRoot,
            endpoints: endpoints as RestEndpoint[],
            authTokenEnvVar,
            baseUrlEnvVar,
        });
        helperFile = emitRestHelper(outputRoot, warnings);
        envTemplateFile = emitRestEnvTemplate(outputRoot, [authTokenEnvVar, baseUrlEnvVar]);
    } else {
        for (const ep of endpoints) {
            const stub = `${ep.method.toLowerCase()}-${ep.path.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root'}`;
            emitted.push({
                filePath: path.join(outputRoot, 'features', `${stub}.feature`),
                endpoint: ep as RestEndpoint,
                scenarioName: `${ep.method.toUpperCase()} ${ep.path} returns ${ep.expectedStatus ?? (ep.method.toUpperCase() === 'POST' ? 201 : 200)}`,
            });
        }
    }

    log.info('REST artefact emission complete', {
        endpoints: endpoints.length,
        featureFiles: emitted.length,
        dryRun: input.dryRun,
    });

    // ADO TC creation (two-phase confirmation).
    let tcsCreated = 0;
    let tcsSkipped: Array<{ scenario: string; reason: string }> = [];
    if (input.createAdoTc && !input.dryRun) {
        const payloads: TcPayload[] = emitted.map((e) => ({
            verb: 'rest',
            title: `REST: ${e.scenarioName}`,
            tags: `rest; auto-generated; method:${e.endpoint.method.toLowerCase()}`,
            scenario: e.scenarioName,
            steps: [
                { action: `Set env var ${baseUrlEnvVar} to the target base URL and ${authTokenEnvVar} to a bearer token`, expected: 'Environment ready' },
                { action: `Send ${e.endpoint.method.toUpperCase()} ${e.endpoint.path}`, expected: `HTTP ${e.endpoint.expectedStatus ?? (e.endpoint.method.toUpperCase() === 'POST' ? 201 : 200)} received` },
                { action: 'Assert response body parses as JSON', expected: 'JSON body accepted' },
            ],
            descriptionHtml: `<div><h3>REST test</h3><p><strong>Endpoint:</strong> <code>${xmlEscape(e.endpoint.method.toUpperCase())} ${xmlEscape(e.endpoint.path)}</code></p><p>Generated by <code>cs_qa_gen_protocol_test</code> (verb: rest).</p></div>`,
        }));
        if (!input.confirmed) {
            return {
                ok: true,
                verb: 'rest',
                generated: {
                    featureFiles: emitted.map((e) => ({ path: e.filePath, scenarios: [e.scenarioName] })),
                    stepDefFiles: stepDefFile ? [stepDefFile] : [],
                    helperFiles: helperFile ? [helperFile] : [],
                    specFiles: [],
                    envTemplateFile,
                },
                tcsCreated: 0,
                tcsSkipped: [],
                warnings,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint: `Create ${payloads.length} ADO Test Case(s) in project ${input.project || '<from ado-config>'}? No write performed. Retry the SAME call with confirmed:true.`,
                note: 'requires confirmation — retry with confirmed:true',
            };
        }
        const res = await createAdoTcs(ctx, { orgUrl: input.orgUrl, project: input.project, pat: input.pat }, payloads, log);
        tcsCreated = res.tcsCreated;
        tcsSkipped = res.tcsSkipped;
        if (res.diagnostic) warnings.push(res.diagnostic);
    }

    return {
        ok: true,
        verb: 'rest',
        generated: {
            featureFiles: emitted.map((e) => ({ path: e.filePath, scenarios: [e.scenarioName] })),
            stepDefFiles: stepDefFile ? [stepDefFile] : [],
            helperFiles: helperFile ? [helperFile] : [],
            specFiles: [],
            envTemplateFile,
        },
        tcsCreated,
        tcsSkipped,
        warnings,
        note: input.dryRun
            ? `Dry-run: would emit ${emitted.length} REST feature file(s).`
            : `Generated ${emitted.length} REST feature file(s) + step defs + helper.${tcsCreated > 0 ? ` ${tcsCreated} ADO TC(s) created.` : ''}`,
    };
}

// =============================================================================
// Delegation verbs — SOAP + GraphQL.
// =============================================================================

async function runDelegatedVerb(
    ctx: { workspaceRoot: string; invocationId: string },
    input: Record<string, unknown>,
    delegateName: 'cs_qa_gen_soap_test' | 'cs_qa_gen_graphql_test',
    log: ReturnType<typeof createLogger>,
): Promise<z.infer<typeof OutputSchema>> {
    const delegate = getPrimitive(delegateName);
    const verb = delegateName === 'cs_qa_gen_soap_test' ? 'soap' : 'graphql';
    if (!delegate) {
        return {
            ok: false,
            verb,
            generated: { featureFiles: [], stepDefFiles: [], helperFiles: [], specFiles: [] },
            tcsCreated: 0, tcsSkipped: [], warnings: [],
            note: `Delegate ${delegateName} not registered.`,
        };
    }
    // Strip the discriminator before delegating.
    const forwarded: Record<string, unknown> = { ...input };
    delete forwarded.verb;
    const result = await delegate.run(
        ctx as unknown as Parameters<typeof delegate.run>[0],
        forwarded as unknown as Parameters<typeof delegate.run>[1],
    );
    log.info(`Delegated ${verb} verb`, { delegateName });
    const r = result as Record<string, unknown>;

    // Adapt each delegate's output shape into the unified `generated` view.
    const featureFiles: Array<{ path: string; scenarios: string[] }> = [];
    const stepDefFiles: string[] = [];
    const helperFiles: string[] = [];
    if (delegateName === 'cs_qa_gen_soap_test') {
        const ff = Array.isArray(r.featureFilesGenerated) ? r.featureFilesGenerated as Array<{ path: string; scenarios: string[] }> : [];
        for (const f of ff) featureFiles.push({ path: f.path, scenarios: f.scenarios });
        const sf = Array.isArray(r.stepDefFiles) ? r.stepDefFiles as string[] : [];
        for (const s of sf) stepDefFiles.push(s);
        if (r.helperFile) helperFiles.push(String(r.helperFile));
    } else {
        const gen = Array.isArray(r.generated) ? r.generated as Array<{ featureFile?: string; stepDefFile?: string; operationName?: string }> : [];
        for (const g of gen) {
            if (g.featureFile) featureFiles.push({ path: g.featureFile, scenarios: g.operationName ? [g.operationName] : [] });
            if (g.stepDefFile) stepDefFiles.push(g.stepDefFile);
        }
        if (r.helperFile) helperFiles.push(String(r.helperFile));
    }

    return {
        ok: Boolean(r.ok),
        verb,
        delegatedTo: delegateName,
        delegateResult: result,
        generated: {
            featureFiles,
            stepDefFiles,
            helperFiles,
            specFiles: [],
            envTemplateFile: r.envTemplateFile ? String(r.envTemplateFile) : undefined,
        },
        tcsCreated: Number(r.tcsCreated || 0),
        tcsSkipped: Array.isArray(r.tcsSkipped) ? r.tcsSkipped as Array<{ scenario: string; reason: string }> : [],
        warnings: Array.isArray(r.warnings) ? r.warnings.map(String) : [],
        note: r.note ? String(r.note) : undefined,
        requiresConfirmation: r.requiresConfirmation as boolean | undefined,
        destructive: r.destructive as boolean | undefined,
        confirmationHint: r.confirmationHint ? String(r.confirmationHint) : undefined,
    };
}

// =============================================================================
// Pact verb.
// =============================================================================

async function runPactVerb(
    ctx: { workspaceRoot: string; invocationId: string },
    input: z.infer<typeof PactVerbSchema>,
    log: ReturnType<typeof createLogger>,
): Promise<z.infer<typeof OutputSchema>> {
    const warnings: string[] = [];
    const outputRootRel = input.outputRoot || 'test/api/pact';
    const pactVersion = input.pactVersion || 4;
    const pactBrokerAuthTokenEnvVar = input.pactBrokerAuthTokenEnvVar || 'PACT_BROKER_TOKEN';
    const outputRoot = path.isAbsolute(outputRootRel)
        ? outputRootRel
        : path.join(ctx.workspaceRoot, outputRootRel);

    let emitted: EmittedPactBundle | undefined;
    if (!input.dryRun) {
        fs.mkdirSync(outputRoot, { recursive: true });
        emitted = emitPactSpec({
            outputRoot,
            consumerName: input.consumerName,
            providerName: input.providerName,
            pactVersion,
            interactions: input.interactions as PactInteraction[],
            pactBrokerUrl: input.pactBrokerUrl,
            pactBrokerAuthTokenEnvVar,
            warnings,
        });
    }

    log.info('Pact artefact emission complete', {
        consumer: input.consumerName,
        provider: input.providerName,
        interactions: input.interactions.length,
        dryRun: input.dryRun,
    });

    let tcsCreated = 0;
    let tcsSkipped: Array<{ scenario: string; reason: string }> = [];
    if (input.createAdoTc && !input.dryRun) {
        const payloads: TcPayload[] = input.interactions.map((inx) => ({
            verb: 'pact',
            title: `Pact: ${input.consumerName} → ${input.providerName} — ${inx.description}`,
            tags: `pact; auto-generated; consumer:${slugify(input.consumerName)}; provider:${slugify(input.providerName)}`,
            scenario: inx.description,
            steps: [
                { action: `Install @pact-foundation/pact and start the local mock provider`, expected: 'Mock provider running' },
                { action: `Run the consumer expectation for "${inx.description}"`, expected: `Response ${inx.response.status} matches the recorded interaction` },
                { action: 'Publish the pact JSON to the broker', expected: 'Pact stored in broker' },
            ],
            descriptionHtml: `<div><h3>Consumer contract</h3><p><strong>Consumer:</strong> ${xmlEscape(input.consumerName)}</p><p><strong>Provider:</strong> ${xmlEscape(input.providerName)}</p><p><strong>Interaction:</strong> ${xmlEscape(inx.description)}</p><p>Generated by <code>cs_qa_gen_protocol_test</code> (verb: pact).</p></div>`,
        }));
        if (!input.confirmed) {
            return {
                ok: true,
                verb: 'pact',
                generated: {
                    featureFiles: [],
                    stepDefFiles: [],
                    helperFiles: emitted ? [emitted.helperFile] : [],
                    specFiles: emitted ? [emitted.specFile] : [],
                    readmeFile: emitted?.readmeFile,
                    envTemplateFile: emitted?.envTemplateFile,
                },
                tcsCreated: 0,
                tcsSkipped: [],
                warnings,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint: `Create ${payloads.length} ADO Test Case(s) in project ${input.project || '<from ado-config>'}? No write performed. Retry the SAME call with confirmed:true.`,
                note: 'requires confirmation — retry with confirmed:true',
            };
        }
        const res = await createAdoTcs(ctx, { orgUrl: input.orgUrl, project: input.project, pat: input.pat }, payloads, log);
        tcsCreated = res.tcsCreated;
        tcsSkipped = res.tcsSkipped;
        if (res.diagnostic) warnings.push(res.diagnostic);
    }

    return {
        ok: true,
        verb: 'pact',
        generated: {
            featureFiles: [],
            stepDefFiles: [],
            helperFiles: emitted ? [emitted.helperFile] : [],
            specFiles: emitted ? [emitted.specFile] : [],
            readmeFile: emitted?.readmeFile,
            envTemplateFile: emitted?.envTemplateFile,
        },
        tcsCreated,
        tcsSkipped,
        warnings,
        note: input.dryRun
            ? `Dry-run: would emit Pact bundle for ${input.consumerName} → ${input.providerName} covering ${input.interactions.length} interaction(s).`
            : `Generated Pact bundle ${input.consumerName} → ${input.providerName} with ${input.interactions.length} interaction(s).${tcsCreated > 0 ? ` ${tcsCreated} ADO TC(s) created.` : ''}`,
    };
}

// =============================================================================
// WebSocket verb.
// =============================================================================

async function runWebsocketVerb(
    ctx: { workspaceRoot: string; invocationId: string },
    input: z.infer<typeof WebsocketVerbSchema>,
    log: ReturnType<typeof createLogger>,
): Promise<z.infer<typeof OutputSchema>> {
    const warnings: string[] = [];
    const outputRootRel = input.outputRoot || 'test/api/websocket';
    const authTokenEnvVar = input.authTokenEnvVar || 'WS_AUTH_TOKEN';
    const outputRoot = path.isAbsolute(outputRootRel)
        ? outputRootRel
        : path.join(ctx.workspaceRoot, outputRootRel);

    let features: Array<{ filePath: string; scenarioName: string }> = [];
    let stepDefFile: string | undefined;
    let helperFile: string | undefined;
    let readmeFile: string | undefined;
    let envTemplateFile: string | undefined;

    if (!input.dryRun) {
        fs.mkdirSync(outputRoot, { recursive: true });
        features = emitWsFeatureFiles({
            outputRoot,
            wsUrl: input.wsUrl,
            authTokenEnvVar,
            scenarios: input.scenarios as WsScenario[],
            warnings,
        });
        stepDefFile = emitWsStepDefs({
            outputRoot,
            wsUrl: input.wsUrl,
            authTokenEnvVar,
            scenarios: input.scenarios as WsScenario[],
            warnings,
        });
        helperFile = emitWsHelper(outputRoot, warnings);
        readmeFile = emitWsReadme({
            outputRoot,
            wsUrl: input.wsUrl,
            authTokenEnvVar,
            scenarios: input.scenarios as WsScenario[],
            warnings,
        });
        envTemplateFile = emitWsEnvTemplate(outputRoot, authTokenEnvVar);
    } else {
        for (const s of input.scenarios) {
            features.push({
                filePath: path.join(outputRoot, 'features', `${slugify(s.name)}.feature`),
                scenarioName: s.name,
            });
        }
    }

    log.info('WebSocket artefact emission complete', {
        wsUrl: input.wsUrl,
        scenarios: input.scenarios.length,
        dryRun: input.dryRun,
    });

    let tcsCreated = 0;
    let tcsSkipped: Array<{ scenario: string; reason: string }> = [];
    if (input.createAdoTc && !input.dryRun) {
        const payloads: TcPayload[] = input.scenarios.map((s) => ({
            verb: 'websocket',
            title: `WebSocket: ${s.name}`,
            tags: `websocket; auto-generated`,
            scenario: s.name,
            steps: [
                { action: `Ensure "ws" npm package installed (see README)`, expected: '`ws` resolvable via require' },
                { action: `Open WebSocket to ${input.wsUrl}${authTokenEnvVar ? ` with token from ${authTokenEnvVar}` : ''}`, expected: 'Handshake succeeds' },
                { action: `Play scenario "${s.name}" (${s.send.length} send / ${s.expectMessages.length} expect)`, expected: 'All expected messages received within timeouts' },
            ],
            descriptionHtml: `<div><h3>WebSocket scenario</h3><p><strong>URL:</strong> <code>${xmlEscape(input.wsUrl)}</code></p><p><strong>Scenario:</strong> ${xmlEscape(s.name)}</p><p>Generated by <code>cs_qa_gen_protocol_test</code> (verb: websocket).</p></div>`,
        }));
        if (!input.confirmed) {
            return {
                ok: true,
                verb: 'websocket',
                generated: {
                    featureFiles: features.map((f) => ({ path: f.filePath, scenarios: [f.scenarioName] })),
                    stepDefFiles: stepDefFile ? [stepDefFile] : [],
                    helperFiles: helperFile ? [helperFile] : [],
                    specFiles: [],
                    readmeFile,
                    envTemplateFile,
                },
                tcsCreated: 0,
                tcsSkipped: [],
                warnings,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint: `Create ${payloads.length} ADO Test Case(s) in project ${input.project || '<from ado-config>'}? No write performed. Retry the SAME call with confirmed:true.`,
                note: 'requires confirmation — retry with confirmed:true',
            };
        }
        const res = await createAdoTcs(ctx, { orgUrl: input.orgUrl, project: input.project, pat: input.pat }, payloads, log);
        tcsCreated = res.tcsCreated;
        tcsSkipped = res.tcsSkipped;
        if (res.diagnostic) warnings.push(res.diagnostic);
    }

    return {
        ok: true,
        verb: 'websocket',
        generated: {
            featureFiles: features.map((f) => ({ path: f.filePath, scenarios: [f.scenarioName] })),
            stepDefFiles: stepDefFile ? [stepDefFile] : [],
            helperFiles: helperFile ? [helperFile] : [],
            specFiles: [],
            readmeFile,
            envTemplateFile,
        },
        tcsCreated,
        tcsSkipped,
        warnings,
        note: input.dryRun
            ? `Dry-run: would emit ${features.length} WebSocket feature file(s) for ${input.wsUrl}.`
            : `Generated ${features.length} WebSocket feature file(s) + step defs + helper.${tcsCreated > 0 ? ` ${tcsCreated} ADO TC(s) created.` : ''}`,
    };
}

// =============================================================================
// Registration.
// =============================================================================

registerPrimitive({
    name: 'cs_qa_gen_protocol_test',
    description: 'Verb-driven API test generator covering five protocols behind one tool: `rest` (inline endpoints or delegated OpenAPI import), `soap` (delegates to cs_qa_gen_soap_test), `graphql` (delegates to cs_qa_gen_graphql_test), `pact` (consumer-driven contract tests via @pact-foundation/pact), and `websocket` (Node ws-package scenarios). Every emitted helper logs via CSReporter, every credential is an ENCRYPTED: env-template placeholder, and ADO Test Case creation is gated by two-phase confirmation.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gen_protocol_test', { workspaceRoot: ctx.workspaceRoot });
        const typedInput = input as Input;
        switch (typedInput.verb) {
            case 'rest':
                return runRestVerb(ctx, typedInput, log);
            case 'soap':
                return runDelegatedVerb(ctx, typedInput as unknown as Record<string, unknown>, 'cs_qa_gen_soap_test', log);
            case 'graphql':
                return runDelegatedVerb(ctx, typedInput as unknown as Record<string, unknown>, 'cs_qa_gen_graphql_test', log);
            case 'pact':
                return runPactVerb(ctx, typedInput, log);
            case 'websocket':
                return runWebsocketVerb(ctx, typedInput, log);
            default: {
                // Exhaustiveness — never reached given the discriminator.
                const _never: never = typedInput;
                void _never;
                return {
                    ok: false,
                    verb: 'unknown',
                    generated: { featureFiles: [], stepDefFiles: [], helperFiles: [], specFiles: [] },
                    tcsCreated: 0, tcsSkipped: [], warnings: [],
                    note: 'Unknown verb — expected one of rest/soap/graphql/pact/websocket.',
                };
            }
        }
    },
});
