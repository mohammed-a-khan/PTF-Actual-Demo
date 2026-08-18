/**
 * cs_qa_gen_graphql_test — generate real Playwright-BDD GraphQL test suites
 * (feature files + step defs + framework-consistent GraphQL client) from a
 * GraphQL SDL file or introspection endpoint.
 *
 * Every emitted artifact is executable — no `// TODO`, no placeholder returns.
 * Negative-case queries actually violate the loaded schema (missing required
 * arg / wrong scalar type / unknown selection). Auth cases suppress or
 * mangle the Authorization header at runtime.
 *
 * Optional side-effect: create one ADO Test Case per operation, tagged
 * `@graphql @auto-generated @<operationKind>`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import {
    loadSdlFromFile,
    loadFromIntrospection,
    type ParsedGraphqlSchema,
    type GraphqlOperation,
} from './_helpers/graphql_schema_loader';
import {
    buildCasesForOperation,
    filterOperations,
    type BuiltCase,
} from './_helpers/graphql_query_builder';

const OperationsSchema = z.object({
    queries: z.array(z.string()).optional(),
    mutations: z.array(z.string()).optional(),
    subscriptions: z.array(z.string()).optional(),
}).optional();

const InputSchema = z.object({
    schemaPath: z.string().optional().describe('Local .graphql / .gql SDL file (path).'),
    schemaUrl: z.string().url().optional().describe('Introspection endpoint URL. Mutually exclusive with schemaPath.'),
    endpointUrl: z.string().url().optional().describe('GraphQL server URL used at test runtime.'),
    operations: OperationsSchema,
    generateNegativeCases: z.boolean().default(true),
    generateAuthCases: z.boolean().default(true),
    createAdoTc: z.boolean().default(false),
    planId: z.number().int().positive().optional(),
    planName: z.string().optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().optional(),
    outputRoot: z.string().default('test/api/graphql'),
    authTokenEnvVar: z.string().default('GRAPHQL_AUTH_TOKEN'),
    dryRun: z.boolean().default(false),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
}).refine((v) => !!v.schemaPath || !!v.schemaUrl, {
    message: 'Either schemaPath or schemaUrl is required.',
});

const OutputSchema = z.object({
    ok: z.boolean(),
    source: z.string(),
    typesCount: z.number().default(0),
    queryCount: z.number().default(0),
    mutationCount: z.number().default(0),
    subscriptionCount: z.number().default(0),
    generated: z.array(z.object({
        operationKind: z.string(),
        operationName: z.string(),
        featureFile: z.string(),
        stepDefFile: z.string(),
        caseCount: z.number(),
        tcId: z.number().optional(),
    })).default([]),
    helperFile: z.string().optional(),
    envTemplateFile: z.string().optional(),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
    requiresConfirmation: z.boolean().optional(),
    destructive: z.boolean().optional(),
    confirmationHint: z.string().optional(),
});

function toPascal(s: string): string {
    return s
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join('');
}

function jsStringLiteral(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n');
}

function graphqlTemplateLiteral(query: string): string {
    // Multi-line safe: use template literals in generated TS.
    return '`' + query.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}

// -----------------------------------------------------------------------------
// GraphQL runtime helper (framework-consistent). Written once per output root,
// preserved if the user has customized it.
// -----------------------------------------------------------------------------

const HELPER_SOURCE = `/**
 * GraphQL client for auto-generated GraphQL test suites.
 *
 * Framework-consistent — logs via CSReporter, honors AbortController timeouts,
 * merges default + per-request headers, redacts Authorization before logging,
 * and captures partial responses (GraphQL errors live in the body even on 200).
 */
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

export interface GraphqlResponse<T = unknown> {
    status: number;
    data?: T | null;
    errors?: Array<{ message: string; path?: (string | number)[]; extensions?: Record<string, unknown> }>;
    took?: number;
}

function extractOperationName(query: string): string {
    const m = /^\\s*(query|mutation|subscription)\\s+(\\w+)/.exec(query);
    return m ? m[2] : 'anonymous';
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
        if (/^authorization$/i.test(k)) out[k] = '***REDACTED***';
        else out[k] = v;
    }
    return out;
}

export class GraphqlClient {
    constructor(
        private endpointUrl: string,
        private defaultHeaders: Record<string, string> = {},
        private timeoutMs: number = 30000,
    ) {}

    async execute<T = unknown>(
        query: string,
        variables: Record<string, unknown> = {},
        extraHeaders: Record<string, string> = {},
    ): Promise<GraphqlResponse<T>> {
        const opName = extractOperationName(query);
        const started = Date.now();
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...this.defaultHeaders,
            ...extraHeaders,
        };
        const payload = JSON.stringify({ query, variables, operationName: opName });
        CSReporter.info(\`GraphQL -> \${opName} vars=\${JSON.stringify(Object.keys(variables))} headers=\${JSON.stringify(redactHeaders(headers))}\`);

        const url = new URL(this.endpointUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const responseBody: { status: number; text: string } = await new Promise((resolve, reject) => {
                const requester = url.protocol === 'https:' ? https : http;
                const req = requester.request({
                    method: 'POST',
                    hostname: url.hostname,
                    port: url.port || (url.protocol === 'https:' ? 443 : 80),
                    path: url.pathname + url.search,
                    headers: { ...headers, 'Content-Length': Buffer.byteLength(payload).toString() },
                    signal: controller.signal,
                }, (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf-8') }));
                    res.on('error', reject);
                });
                req.on('error', reject);
                req.write(payload);
                req.end();
            });
            const took = Date.now() - started;
            let parsed: { data?: T; errors?: GraphqlResponse['errors'] } = {};
            if (responseBody.text) {
                try { parsed = JSON.parse(responseBody.text); }
                catch { parsed = { errors: [{ message: 'Non-JSON response body' }] }; }
            }
            const errorCount = parsed.errors?.length ?? 0;
            CSReporter.info(\`GraphQL <- \${opName} status=\${responseBody.status} errors=\${errorCount} took=\${took}ms\`);
            return {
                status: responseBody.status,
                data: parsed.data ?? null,
                errors: parsed.errors,
                took,
            };
        } catch (err) {
            const took = Date.now() - started;
            const msg = (err as Error).message || String(err);
            CSReporter.warn(\`GraphQL !! \${opName} failed=\${msg} took=\${took}ms\`);
            return {
                status: 0,
                data: null,
                errors: [{ message: msg }],
                took,
            };
        } finally {
            clearTimeout(timer);
        }
    }
}
`;

function writeHelperIfMissing(outputRoot: string, warnings: string[]): { helperFile: string; wrote: boolean } {
    const helperFile = path.join(outputRoot, '_graphql-helper.ts');
    if (fs.existsSync(helperFile)) {
        warnings.push(`GraphQL helper already exists at ${helperFile} — preserved.`);
        return { helperFile, wrote: false };
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(helperFile, HELPER_SOURCE, 'utf-8');
    return { helperFile, wrote: true };
}

function writeEnvTemplate(outputRoot: string, envVar: string, warnings: string[]): string {
    const envTemplateFile = path.join(outputRoot, '.env.template');
    const line = `${envVar}=ENCRYPTED:\n`;
    let content = line;
    if (fs.existsSync(envTemplateFile)) {
        const existing = fs.readFileSync(envTemplateFile, 'utf-8');
        if (new RegExp(`^${envVar}=`, 'm').test(existing)) {
            warnings.push(`Env template already contains ${envVar} — preserved.`);
            return envTemplateFile;
        }
        content = existing.endsWith('\n') ? existing + line : existing + '\n' + line;
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(envTemplateFile, content, 'utf-8');
    return envTemplateFile;
}

// -----------------------------------------------------------------------------
// Feature + step-def emission per operation.
// -----------------------------------------------------------------------------

function composeFeature(opKind: string, op: GraphqlOperation, cases: BuiltCase[]): string {
    const OperationName = toPascal(op.name);
    const happy = cases.find((c) => c.kind === 'happy');
    const expectedField = happy?.assertField || '__typename';
    const lines: string[] = [];
    lines.push(`@graphql @${opKind}:${op.name} @auto-generated`);
    lines.push(`Feature: ${OperationName} - GraphQL ${opKind}`);
    lines.push('');
    for (const c of cases) {
        switch (c.kind) {
            case 'happy':
                lines.push(`  Scenario: happy path ${op.name}`);
                lines.push(`    Given a valid ${opKind} for ${op.name}`);
                lines.push(`    When it is executed against the GraphQL endpoint`);
                lines.push(`    Then the response has no errors`);
                lines.push(`    And the data contains ${expectedField}`);
                break;
            case 'missing-required-arg':
                lines.push(`  Scenario: missing required arg ${c.omittedArg}`);
                lines.push(`    Given a ${opKind} for ${op.name} with ${c.omittedArg} omitted`);
                lines.push(`    When it is executed against the GraphQL endpoint`);
                lines.push(`    Then an error is returned`);
                lines.push(`    And the error code is BAD_USER_INPUT or the message contains "required"`);
                break;
            case 'invalid-type':
                lines.push(`  Scenario: invalid type for arg ${c.coercedArg}`);
                lines.push(`    Given a ${opKind} for ${op.name} with ${c.coercedArg} set to the wrong type`);
                lines.push(`    When it is executed against the GraphQL endpoint`);
                lines.push(`    Then an error is returned`);
                lines.push(`    And the error message contains "wrong type" or "got invalid value"`);
                break;
            case 'extra-field':
                lines.push(`  Scenario: unknown field on return type`);
                lines.push(`    Given a ${opKind} for ${op.name} selecting a field that does not exist`);
                lines.push(`    When it is executed against the GraphQL endpoint`);
                lines.push(`    Then an error is returned`);
                lines.push(`    And the error message contains "Cannot query field"`);
                break;
            case 'unauthenticated':
                lines.push(`  Scenario: unauthenticated ${op.name}`);
                lines.push(`    Given no authorization token`);
                lines.push(`    When the ${opKind} ${op.name} is executed`);
                lines.push(`    Then an error is returned`);
                lines.push(`    And the HTTP status is 401 OR the error extensions.code is UNAUTHENTICATED`);
                break;
            case 'forbidden':
                lines.push(`  Scenario: forbidden ${op.name}`);
                lines.push(`    Given an invalid authorization token`);
                lines.push(`    When the ${opKind} ${op.name} is executed`);
                lines.push(`    Then an error is returned`);
                lines.push(`    And the HTTP status is 403 OR the error extensions.code is FORBIDDEN`);
                break;
        }
        lines.push('');
    }
    return lines.join('\n');
}

function composeStepDef(
    opKind: string,
    op: GraphqlOperation,
    cases: BuiltCase[],
    envVar: string,
    endpointUrl: string | undefined,
): string {
    const OperationName = toPascal(op.name);
    const className = `${OperationName}Steps`;
    const caseMapEntries = cases.map((c) => {
        const key = c.label;
        const authHeaderExpr = c.authHeaderOverride
            ? `'${jsStringLiteral(c.authHeaderOverride)}'`
            : (c.includeAuthHeader ? `process.env.${envVar} ? \`Bearer \${process.env.${envVar}}\` : ''` : `''`);
        return `        '${jsStringLiteral(key)}': {
            query: ${graphqlTemplateLiteral(c.query)},
            variables: ${JSON.stringify(c.variables)},
            includeAuth: ${c.includeAuthHeader ? 'true' : 'false'},
            authHeader: ${authHeaderExpr},
            expectError: ${c.expectError ? 'true' : 'false'},
        }`;
    }).join(',\n');

    const endpointExpr = endpointUrl
        ? `process.env.GRAPHQL_ENDPOINT_URL || '${jsStringLiteral(endpointUrl)}'`
        : `process.env.GRAPHQL_ENDPOINT_URL || ''`;

    return `/**
 * Auto-generated step definitions for GraphQL ${opKind} "${op.name}".
 *
 * Re-run cs_qa_gen_graphql_test to regenerate — do not edit by hand.
 */
import { CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { GraphqlClient, GraphqlResponse } from '../../_graphql-helper';

const state: {
    caseLabel?: string;
    response?: GraphqlResponse<Record<string, unknown>>;
} = {};

const cases: Record<string, { query: string; variables: Record<string, unknown>; includeAuth: boolean; authHeader: string; expectError: boolean }> = {
${caseMapEntries}
};

function buildClient(headerOverride?: string): GraphqlClient {
    const endpoint = ${endpointExpr};
    if (!endpoint) throw new Error('GRAPHQL_ENDPOINT_URL is not set and no endpoint was baked in at generation time');
    const defaults: Record<string, string> = {};
    if (headerOverride) defaults['Authorization'] = headerOverride;
    return new GraphqlClient(endpoint, defaults);
}

export class ${className} {
    @CSBDDStepDef('a valid ${opKind} for ${op.name}')
    async ${op.name}_selectHappy(): Promise<void> {
        state.caseLabel = 'happy path ${op.name}';
    }

    @CSBDDStepDef('a ${opKind} for ${op.name} with (\\\\w+) omitted')
    async ${op.name}_selectMissingArg(argName: string): Promise<void> {
        state.caseLabel = \`missing required arg \${argName}\`;
    }

    @CSBDDStepDef('a ${opKind} for ${op.name} with (\\\\w+) set to the wrong type')
    async ${op.name}_selectInvalidType(argName: string): Promise<void> {
        state.caseLabel = \`invalid type for arg \${argName}\`;
    }

    @CSBDDStepDef('a ${opKind} for ${op.name} selecting a field that does not exist')
    async ${op.name}_selectExtraField(): Promise<void> {
        state.caseLabel = 'unknown field on return type';
    }

    @CSBDDStepDef('no authorization token')
    async ${op.name}_noAuth(): Promise<void> {
        state.caseLabel = 'unauthenticated ${op.name}';
    }

    @CSBDDStepDef('an invalid authorization token')
    async ${op.name}_invalidAuth(): Promise<void> {
        state.caseLabel = 'forbidden ${op.name}';
    }

    @CSBDDStepDef('it is executed against the GraphQL endpoint')
    async ${op.name}_execute(): Promise<void> {
        await ${op.name}_dispatch();
    }

    @CSBDDStepDef('the ${opKind} ${op.name} is executed')
    async ${op.name}_executeNamed(): Promise<void> {
        await ${op.name}_dispatch();
    }

    @CSBDDStepDef('the response has no errors')
    async ${op.name}_noErrors(): Promise<void> {
        if (!state.response) throw new Error('No response captured');
        if (state.response.errors && state.response.errors.length > 0) {
            throw new Error(\`Expected no errors but got: \${state.response.errors.map((e) => e.message).join('; ')}\`);
        }
    }

    @CSBDDStepDef('an error is returned')
    async ${op.name}_hasError(): Promise<void> {
        if (!state.response) throw new Error('No response captured');
        const hadErrors = (state.response.errors && state.response.errors.length > 0) || state.response.status >= 400;
        if (!hadErrors) throw new Error(\`Expected an error but got status \${state.response.status} with no GraphQL errors\`);
    }

    @CSBDDStepDef('the data contains (\\\\w+)')
    async ${op.name}_dataContains(fieldName: string): Promise<void> {
        if (!state.response) throw new Error('No response captured');
        const data = state.response.data as Record<string, unknown> | null;
        if (!data) throw new Error('Response data is null');
        const opResult = data['${op.name}'] as unknown;
        if (opResult === undefined || opResult === null) {
            throw new Error(\`Response data.${op.name} is missing\`);
        }
        if (fieldName === '__typename') return;
        if (typeof opResult === 'object' && opResult !== null && !(fieldName in (opResult as Record<string, unknown>))) {
            if (!Array.isArray(opResult)) {
                throw new Error(\`Field "\${fieldName}" not present in data.${op.name}\`);
            }
        }
    }

    @CSBDDStepDef('the error code is BAD_USER_INPUT or the message contains "required"')
    async ${op.name}_errIsRequired(): Promise<void> {
        assertErrorMatches(/required/i, 'BAD_USER_INPUT');
    }

    @CSBDDStepDef('the error message contains "wrong type" or "got invalid value"')
    async ${op.name}_errWrongType(): Promise<void> {
        assertErrorMatches(/(wrong type|got invalid value|expected type)/i);
    }

    @CSBDDStepDef('the error message contains "Cannot query field"')
    async ${op.name}_errCannotQueryField(): Promise<void> {
        assertErrorMatches(/Cannot query field/i);
    }

    @CSBDDStepDef('the HTTP status is 401 OR the error extensions.code is UNAUTHENTICATED')
    async ${op.name}_errUnauth(): Promise<void> {
        assertStatusOrExtension(401, 'UNAUTHENTICATED');
    }

    @CSBDDStepDef('the HTTP status is 403 OR the error extensions.code is FORBIDDEN')
    async ${op.name}_errForbidden(): Promise<void> {
        assertStatusOrExtension(403, 'FORBIDDEN');
    }
}

async function ${op.name}_dispatch(): Promise<void> {
    const label = state.caseLabel;
    if (!label) throw new Error('No case selected — a Given step must run first');
    const c = cases[label];
    if (!c) throw new Error(\`Unknown case label: \${label}\`);
    const client = buildClient(c.includeAuth ? c.authHeader : undefined);
    state.response = await client.execute(c.query, c.variables) as GraphqlResponse<Record<string, unknown>>;
}

function assertErrorMatches(pattern: RegExp, extensionCode?: string): void {
    if (!state.response) throw new Error('No response captured');
    const errs = state.response.errors || [];
    for (const e of errs) {
        if (pattern.test(e.message)) return;
        if (extensionCode && e.extensions && (e.extensions as Record<string, unknown>).code === extensionCode) return;
    }
    throw new Error(\`No error matched \${pattern}\${extensionCode ? \` or extensions.code=\${extensionCode}\` : ''}. Errors: \${JSON.stringify(errs)}\`);
}

function assertStatusOrExtension(status: number, extensionCode: string): void {
    if (!state.response) throw new Error('No response captured');
    if (state.response.status === status) return;
    for (const e of state.response.errors || []) {
        if (e.extensions && (e.extensions as Record<string, unknown>).code === extensionCode) return;
    }
    throw new Error(\`Expected HTTP \${status} or extensions.code=\${extensionCode}; got status \${state.response.status} with errors: \${JSON.stringify(state.response.errors)}\`);
}
`;
}

function composeAdoTcDescription(opKind: string, op: GraphqlOperation, endpointUrl: string | undefined, featureFile: string): string {
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const argRows = op.args.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.type)}</td><td>${a.isRequired ? 'yes' : 'no'}</td></tr>`).join('');
    return `<div>
<h3>GraphQL ${esc(opKind)}: ${esc(op.name)}</h3>
${endpointUrl ? `<p>Endpoint: <code>${esc(endpointUrl)}</code></p>` : ''}
<p>Return type: <code>${esc(op.returnType)}</code></p>
<h3>Arguments</h3>
${argRows ? `<table><thead><tr><th>Name</th><th>Type</th><th>Required</th></tr></thead><tbody>${argRows}</tbody></table>` : '<p>(none)</p>'}
<p>Feature file: <code>${esc(featureFile)}</code></p>
</div>`;
}

function composeAdoStepsXml(cases: BuiltCase[]): string {
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const rows: string[] = [];
    let i = 1;
    rows.push(`<step id="${i++}" type="PreCondition"><parameterizedString isformatted="true">&lt;P&gt;${esc('GraphQL endpoint reachable; GRAPHQL_AUTH_TOKEN configured (ENCRYPTED:)')}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${esc('Environment ready')}&lt;/P&gt;</parameterizedString><description/></step>`);
    for (const c of cases) {
        const outcome = c.expectError ? 'Error returned per expected shape' : 'No errors; data payload matches selection';
        rows.push(`<step id="${i++}" type="ActionStep"><parameterizedString isformatted="true">&lt;P&gt;${esc(`Execute: ${c.label}`)}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${esc(outcome)}&lt;/P&gt;</parameterizedString><description/></step>`);
    }
    return `<steps id="0" last="${i - 1}">${rows.join('')}</steps>`;
}

// -----------------------------------------------------------------------------
// Registration.
// -----------------------------------------------------------------------------

registerPrimitive({
    name: 'cs_qa_gen_graphql_test',
    description: 'Generate a real Playwright-BDD GraphQL test suite (feature files + step defs + framework GraphQL client) from a GraphQL SDL file or introspection endpoint. Emits happy-path + missing-required + wrong-type + extra-field + unauthenticated + forbidden scenarios per operation. Optionally creates one ADO Test Case per operation. ADO TC creation is gated by two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`).',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gen_graphql_test', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        // 1. Load + normalize schema.
        let schema: ParsedGraphqlSchema;
        try {
            if (input.schemaPath) {
                const resolved = path.isAbsolute(input.schemaPath) ? input.schemaPath : path.join(ctx.workspaceRoot, input.schemaPath);
                schema = loadSdlFromFile(resolved);
            } else {
                schema = await loadFromIntrospection(input.schemaUrl!);
            }
        } catch (e) {
            return { ok: false, source: 'error', typesCount: 0, queryCount: 0, mutationCount: 0, subscriptionCount: 0, generated: [], warnings: [], note: `Schema load failed: ${(e as Error).message}` };
        }
        for (const w of schema.warnings) warnings.push(w);

        const filtered = filterOperations(schema, input.operations);
        const totalOps = filtered.queries.length + filtered.mutations.length + filtered.subscriptions.length;
        if (totalOps === 0) {
            return { ok: false, source: schema.source, typesCount: Object.keys(schema.types).length, queryCount: schema.queries.length, mutationCount: schema.mutations.length, subscriptionCount: schema.subscriptions.length, generated: [], warnings, note: 'No operations matched the filter (or the schema exposes no root ops).' };
        }

        // 2. Resolve output root, always workspace-relative unless absolute.
        const outputRoot = path.isAbsolute(input.outputRoot)
            ? input.outputRoot
            : path.join(ctx.workspaceRoot, input.outputRoot);

        // 3. Dry-run early exit.
        const perOp: Array<{
            operationKind: 'query' | 'mutation' | 'subscription';
            op: GraphqlOperation;
            cases: BuiltCase[];
            featureFile: string;
            stepDefFile: string;
        }> = [];
        for (const kind of ['query', 'mutation', 'subscription'] as const) {
            const ops = kind === 'query' ? filtered.queries : kind === 'mutation' ? filtered.mutations : filtered.subscriptions;
            for (const op of ops) {
                const cases = buildCasesForOperation(schema, kind, op, {
                    generateNegativeCases: input.generateNegativeCases,
                    generateAuthCases: input.generateAuthCases,
                });
                const featureFile = path.join(outputRoot, kind, `${toPascal(op.name)}.feature`);
                const stepDefFile = path.join(outputRoot, kind, 'steps', `${toPascal(op.name)}Steps.ts`);
                perOp.push({ operationKind: kind, op, cases, featureFile, stepDefFile });
            }
        }

        if (input.dryRun) {
            return {
                ok: true,
                source: schema.source,
                typesCount: Object.keys(schema.types).length,
                queryCount: schema.queries.length,
                mutationCount: schema.mutations.length,
                subscriptionCount: schema.subscriptions.length,
                generated: perOp.map((p) => ({
                    operationKind: p.operationKind,
                    operationName: p.op.name,
                    featureFile: p.featureFile,
                    stepDefFile: p.stepDefFile,
                    caseCount: p.cases.length,
                })),
                warnings,
                note: `Dry-run: would generate ${perOp.length} operation suites (${perOp.reduce((n, p) => n + p.cases.length, 0)} scenarios total).`,
            };
        }

        // 4. Write helper + env template.
        const { helperFile } = writeHelperIfMissing(outputRoot, warnings);
        const envTemplateFile = writeEnvTemplate(outputRoot, input.authTokenEnvVar, warnings);

        // 5. Write feature + step-def files.
        for (const p of perOp) {
            fs.mkdirSync(path.dirname(p.featureFile), { recursive: true });
            fs.mkdirSync(path.dirname(p.stepDefFile), { recursive: true });
            fs.writeFileSync(p.featureFile, composeFeature(p.operationKind, p.op, p.cases), 'utf-8');
            fs.writeFileSync(p.stepDefFile, composeStepDef(p.operationKind, p.op, p.cases, input.authTokenEnvVar, input.endpointUrl), 'utf-8');
        }
        log.info('graphql suite emitted', { operations: perOp.length, outputRoot, source: schema.source });

        const generated = perOp.map((p) => ({
            operationKind: p.operationKind,
            operationName: p.op.name,
            featureFile: p.featureFile,
            stepDefFile: p.stepDefFile,
            caseCount: p.cases.length,
            tcId: undefined as number | undefined,
        }));

        // 6. Optional ADO TC creation.
        if (input.createAdoTc) {
            const credsRes = getResolvedCreds(ctx.workspaceRoot, {
                orgUrl: input.orgUrl,
                project: input.project,
                personalAccessToken: input.pat,
            });
            if (!credsRes.creds) {
                warnings.push(credsRes.diagnostic);
            } else {
                const cfg: AdoCreds = credsRes.creds;
                if ((input as { confirmed?: boolean }).confirmed !== true) {
                    return {
                        ok: true,
                        source: schema.source,
                        typesCount: Object.keys(schema.types).length,
                        queryCount: schema.queries.length,
                        mutationCount: schema.mutations.length,
                        subscriptionCount: schema.subscriptions.length,
                        generated,
                        helperFile,
                        envTemplateFile,
                        warnings,
                        requiresConfirmation: true,
                        destructive: true,
                        confirmationHint: `Create ${perOp.length} ADO Test Case(s) — one per GraphQL operation — in project ${cfg.project}? No write performed. Retry the SAME call with confirmed:true (added at the top level).`,
                        note: 'requires confirmation — retry with confirmed:true',
                    } as never;
                }
                {
                    const client = new AdoHttpClient(cfg);
                    interface CreatedTc { idx: number; tcId: number }
                    const bulk = await bulkExecute(perOp.map((p, i) => ({ p, i })), {
                        chunkSize: 1,
                        concurrency: 5,
                        workFn: async (batch) => {
                            const { p, i } = batch[0];
                            const patch: Array<Record<string, unknown>> = [
                                { op: 'add', path: '/fields/System.Title', value: `GraphQL ${p.operationKind}: ${p.op.name}` },
                                { op: 'add', path: '/fields/System.Description', value: composeAdoTcDescription(p.operationKind, p.op, input.endpointUrl, p.featureFile) },
                                { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: composeAdoStepsXml(p.cases) },
                                { op: 'add', path: '/fields/System.Tags', value: `graphql; auto-generated; ${p.operationKind}` },
                            ];
                            const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Test%20Case?api-version=7.0`, patch);
                            return [{ idx: i, tcId: Number(created.id || 0) } as CreatedTc];
                        },
                        onChunkError: (err, batch) => {
                            log.warn('ADO TC create failed', { operation: batch[0].p.op.name, error: err.message });
                        },
                    });
                    for (const r of bulk.ok) {
                        if (r.tcId > 0) generated[r.idx].tcId = r.tcId;
                    }
                    for (const f of bulk.failed) {
                        warnings.push(`ADO TC failed for ${f.item.p.op.name}: ${f.error.message}`);
                    }
                }
            }
        }

        return {
            ok: true,
            source: schema.source,
            typesCount: Object.keys(schema.types).length,
            queryCount: schema.queries.length,
            mutationCount: schema.mutations.length,
            subscriptionCount: schema.subscriptions.length,
            generated,
            helperFile,
            envTemplateFile,
            warnings,
            note: `Generated ${perOp.length} operation suite(s) at ${outputRoot} (source=${schema.source}). ${generated.filter((g) => g.tcId).length}/${perOp.length} ADO TCs created.`,
        };
    },
});
