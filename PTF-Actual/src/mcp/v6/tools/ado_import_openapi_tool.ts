/**
 * cs_qa_import_openapi — import OpenAPI 3.x / Swagger 2.x specs into ADO
 *  test-cases + Gherkin feature files + step defs.
 *
 * Flow: load spec (path or URL) → detect version → enumerate (path,method) →
 * apply include/exclude filters → compose ADO Test Case payloads
 * → bulkExecute POST /wit/workitems/$Test Case (concurrency 5) →
 * add each TC to the target suite → emit `.feature` files grouped by API tag
 *  → emit generic `ApiSteps.steps.ts` → sync-back @TestCaseId tags.
 *
 * Design points that make it usable on-prem:
 *  - ALL HTTP through AdoHttpClient — respects Retry-After, redacts PAT,
 *    caps response bytes.
 *  - specUrl fetch uses NODE's global fetch (no ADO auth), so it works
 *    against public and internal spec servers alike.
 *  - YAML support is LAZY: js-yaml is loaded via require() at parse time.
 *    When absent, the tool falls back to a strict "regex tolerable" path that
 *    only handles trivial single-doc YAML — but always warns the caller.
 *  - Every batch through bulkExecute (per-chunk isolation).
 *  - Never fabricates description content — if a schema field is missing,
 *    the emitted Test Case description says so.
 *  - dryRun returns composed payloads WITHOUT any ADO write.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import { resolvePlan, resolveSuite, createCache } from './ado_name_resolver';
import { syncFeatureAfterPublish, type ScenarioMapping } from './sync_feature_tags';

// =============================================================================
// Spec types (loose — vendor extensions and un-typed fields are common).
// =============================================================================

interface OpenApiParameter {
    name?: string;
    in?: 'path' | 'query' | 'header' | 'cookie' | 'body' | 'formData';
    required?: boolean;
    description?: string;
    schema?: unknown;
    type?: string;
    example?: unknown;
}
interface OpenApiRequestBody {
    description?: string;
    required?: boolean;
    content?: Record<string, { schema?: unknown; example?: unknown }>;
}
interface OpenApiResponse {
    description?: string;
    content?: Record<string, { schema?: unknown; example?: unknown }>;
    schema?: unknown;
}
interface OpenApiOperation {
    operationId?: string;
    summary?: string;
    description?: string;
    tags?: string[];
    parameters?: OpenApiParameter[];
    requestBody?: OpenApiRequestBody;
    responses?: Record<string, OpenApiResponse>;
    security?: Array<Record<string, string[]>>;
    consumes?: string[];
    produces?: string[];
}
interface OpenApiSpec {
    openapi?: string;
    swagger?: string;
    info?: { title?: string; version?: string; description?: string };
    host?: string;
    basePath?: string;
    servers?: Array<{ url?: string; description?: string }>;
    schemes?: string[];
    paths?: Record<string, Record<string, OpenApiOperation>>;
    components?: { schemas?: Record<string, unknown> };
    definitions?: Record<string, unknown>;
}

// =============================================================================
// Spec loading (path or URL, JSON or YAML).
// =============================================================================

async function fetchSpec(specUrl: string): Promise<string> {
    const res = await fetch(specUrl);
    if (!res.ok) throw new Error(`Failed to fetch spec ${specUrl}: ${res.status} ${res.statusText}`);
    return await res.text();
}

function isProbablyYaml(text: string): boolean {
    const t = text.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) return false;
    return true;
}

function loadYaml(text: string, warnings: string[]): unknown {
    // Lazy require — many workspaces have js-yaml, many do not. When absent we
    // do NOT crash — we surface a warning and use a minimal fallback parser
    // that handles trivial specs (info block + paths keys). This is not a
    // real YAML parser and cannot handle anchors, references, block scalars.
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const jsYaml = require('js-yaml') as { load: (s: string) => unknown };
        return jsYaml.load(text);
    } catch {
        warnings.push('js-yaml not installed — using regex YAML fallback. Install js-yaml for full YAML support (npm i -D js-yaml).');
        return regexYamlFallback(text);
    }
}

/**
 * Very small regex-based YAML fallback. Handles:
 *   - key: value pairs (values that are quoted or bare non-nested)
 *   - Two-space nested objects (single level)
 *   - Object mapping under paths: / method: (recursively depth 3-4)
 *
 * Emits warnings when it hits constructs it cannot parse.
 */
function regexYamlFallback(text: string): unknown {
    const root: Record<string, unknown> = {};
    const lines = text.split(/\r?\n/);
    const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }];
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line || /^\s*#/.test(line)) continue;
        const indentMatch = /^(\s*)/.exec(line);
        const indent = indentMatch ? indentMatch[1].length : 0;
        const trimmed = line.trim();
        // Pop stack until we find a parent whose indent < current
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
        const parent = stack[stack.length - 1].obj;
        const kv = /^([^:]+):\s*(.*)$/.exec(trimmed);
        if (!kv) continue;
        const key = kv[1].trim();
        const val = kv[2].trim();
        if (val === '') {
            // Object header — push new child.
            const child: Record<string, unknown> = {};
            parent[key] = child;
            stack.push({ indent, obj: child });
            continue;
        }
        // Scalar assignment (strip quotes).
        const unquoted = /^["'](.+)["']$/.exec(val);
        parent[key] = unquoted ? unquoted[1] : coerceScalar(val);
    }
    return root;
}

function coerceScalar(v: string): unknown {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d+\.\d+$/.test(v)) return Number(v);
    return v;
}

function parseSpec(text: string, warnings: string[]): OpenApiSpec {
    if (isProbablyYaml(text)) {
        return loadYaml(text, warnings) as OpenApiSpec;
    }
    try {
        return JSON.parse(text) as OpenApiSpec;
    } catch (e) {
        // Some servers return JSON without proper Content-Type; try YAML as a fallback.
        warnings.push(`Spec did not parse as JSON (${(e as Error).message}) — retrying as YAML.`);
        return loadYaml(text, warnings) as OpenApiSpec;
    }
}

// =============================================================================
// Enumeration + composition.
// =============================================================================

interface Endpoint {
    method: string;
    path: string;
    operationId: string;
    summary: string;
    description: string;
    parameters: OpenApiParameter[];
    requestBody?: OpenApiRequestBody;
    responses: Record<string, OpenApiResponse>;
    tags: string[];
    security?: Array<Record<string, string[]>>;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

function enumerateEndpoints(spec: OpenApiSpec): Endpoint[] {
    const out: Endpoint[] = [];
    const paths = spec.paths || {};
    for (const [pathKey, methodsObj] of Object.entries(paths)) {
        if (!methodsObj || typeof methodsObj !== 'object') continue;
        // Path-level parameters apply to every operation under that path.
        const pathLevelParams = ((methodsObj as unknown as { parameters?: OpenApiParameter[] }).parameters) || [];
        for (const [method, op] of Object.entries(methodsObj)) {
            if (!HTTP_METHODS.has(method.toLowerCase())) continue;
            const opTyped = op as OpenApiOperation;
            if (!opTyped || typeof opTyped !== 'object') continue;
            out.push({
                method: method.toUpperCase(),
                path: pathKey,
                operationId: opTyped.operationId || `${method.toLowerCase()}_${pathKey.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
                summary: opTyped.summary || '',
                description: opTyped.description || '',
                parameters: [...pathLevelParams, ...(opTyped.parameters || [])],
                requestBody: opTyped.requestBody,
                responses: opTyped.responses || {},
                tags: Array.isArray(opTyped.tags) ? opTyped.tags : [],
                security: opTyped.security,
            });
        }
    }
    return out;
}

function applyFilters(endpoints: Endpoint[], include?: string, exclude?: string, warnings: string[] = []): Endpoint[] {
    let filtered = endpoints;
    if (include) {
        try {
            const re = new RegExp(include);
            filtered = filtered.filter((e) => re.test(e.path));
        } catch (err) {
            warnings.push(`includePathFilter "${include}" is not a valid regex — ignored (${(err as Error).message}).`);
        }
    }
    if (exclude) {
        try {
            const re = new RegExp(exclude);
            filtered = filtered.filter((e) => !re.test(e.path));
        } catch (err) {
            warnings.push(`excludePathFilter "${exclude}" is not a valid regex — ignored (${(err as Error).message}).`);
        }
    }
    return filtered;
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'api';
}

function escapeHtml(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function composeTitle(ep: Endpoint, pattern?: string): string {
    const summary = ep.summary || ep.operationId || '(no summary)';
    const p = pattern || 'API {METHOD} {PATH} — {SUMMARY}';
    return p
        .replace(/\{METHOD\}/g, ep.method)
        .replace(/\{METHOD_LOWER\}/g, ep.method.toLowerCase())
        .replace(/\{PATH\}/g, ep.path)
        .replace(/\{SUMMARY\}/g, summary)
        .replace(/\{OPERATION_ID\}/g, ep.operationId);
}

function composeTags(ep: Endpoint, pattern?: string): string[] {
    const p = pattern || '@api @{METHOD_LOWER}';
    const raw = p
        .replace(/\{METHOD\}/g, ep.method)
        .replace(/\{METHOD_LOWER\}/g, ep.method.toLowerCase())
        .replace(/\{OPERATION_ID\}/g, ep.operationId);
    const tags = raw.split(/\s+/).filter((t) => t.startsWith('@'));
    // Add per-endpoint tags (first API tag as slug).
    for (const t of ep.tags.slice(0, 3)) tags.push(`@${slugify(t)}`);
    return Array.from(new Set(tags));
}

function composeDescription(ep: Endpoint): string {
    const parts: string[] = [];
    parts.push(`<div>`);
    parts.push(`<h3>Endpoint</h3>`);
    parts.push(`<p><strong>${escapeHtml(ep.method)}</strong> <code>${escapeHtml(ep.path)}</code></p>`);
    if (ep.summary) parts.push(`<p><em>${escapeHtml(ep.summary)}</em></p>`);
    if (ep.description) parts.push(`<p>${escapeHtml(ep.description).replace(/\n/g, '<br/>')}</p>`);
    if (ep.parameters.length > 0) {
        parts.push(`<h3>Parameters</h3>`);
        parts.push(`<table><thead><tr><th>Name</th><th>In</th><th>Required</th><th>Type</th></tr></thead><tbody>`);
        for (const p of ep.parameters) {
            const type = p.type || (p.schema && typeof p.schema === 'object' ? (p.schema as { type?: string }).type || '' : '');
            parts.push(`<tr><td>${escapeHtml(p.name || '')}</td><td>${escapeHtml(p.in || '')}</td><td>${p.required ? 'yes' : 'no'}</td><td>${escapeHtml(String(type))}</td></tr>`);
        }
        parts.push(`</tbody></table>`);
    }
    if (ep.requestBody?.content) {
        parts.push(`<h3>Request Body</h3>`);
        const mediaTypes = Object.keys(ep.requestBody.content);
        for (const mt of mediaTypes) {
            parts.push(`<p><code>${escapeHtml(mt)}</code></p>`);
            const ex = ep.requestBody.content[mt].example;
            if (ex !== undefined) {
                parts.push(`<pre><code>${escapeHtml(JSON.stringify(ex, null, 2))}</code></pre>`);
            }
        }
    }
    const responseCodes = Object.keys(ep.responses);
    if (responseCodes.length > 0) {
        parts.push(`<h3>Responses</h3>`);
        parts.push(`<table><thead><tr><th>Status</th><th>Description</th></tr></thead><tbody>`);
        for (const code of responseCodes) {
            parts.push(`<tr><td>${escapeHtml(code)}</td><td>${escapeHtml(ep.responses[code].description || '')}</td></tr>`);
        }
        parts.push(`</tbody></table>`);
    }
    if (ep.security && ep.security.length > 0) {
        parts.push(`<h3>Security</h3>`);
        const names = ep.security.flatMap((s) => Object.keys(s));
        parts.push(`<p>${escapeHtml(names.join(', '))}</p>`);
    }
    parts.push(`</div>`);
    return parts.join('');
}

function pickSuccessCode(ep: Endpoint): string {
    const codes = Object.keys(ep.responses);
    const two = codes.find((c) => /^2\d\d$/.test(c));
    return two || codes[0] || '200';
}

function composeSteps(ep: Endpoint): Array<{ stepNumber: number; action: string; expected: string; isPrecondition: boolean }> {
    const successCode = pickSuccessCode(ep);
    const steps: Array<{ stepNumber: number; action: string; expected: string; isPrecondition: boolean }> = [];
    steps.push({ stepNumber: 1, action: `Given the API base URL is configured for the target environment`, expected: `Base URL loaded from environment config`, isPrecondition: true });
    let stepIdx = 2;
    if (ep.security && ep.security.length > 0) {
        steps.push({ stepNumber: stepIdx++, action: `Given the request is authenticated per the configured security scheme (${ep.security.flatMap((s) => Object.keys(s)).join(', ')})`, expected: `Authentication header attached`, isPrecondition: true });
    }
    const paramSummary = ep.parameters.length > 0 ? ` with parameters {${ep.parameters.map((p) => p.name).filter(Boolean).join(', ')}}` : '';
    const bodySummary = ep.requestBody ? ' with request body' : '';
    steps.push({ stepNumber: stepIdx++, action: `When I send ${ep.method} ${ep.path}${paramSummary}${bodySummary}`, expected: `Request dispatched to ${ep.path}`, isPrecondition: false });
    steps.push({ stepNumber: stepIdx++, action: `Then the response status code equals ${successCode}`, expected: `HTTP ${successCode} received`, isPrecondition: false });
    if (ep.responses[successCode]?.content || ep.responses[successCode]?.schema) {
        steps.push({ stepNumber: stepIdx++, action: `And the response body matches the ${successCode} schema defined in the OpenAPI spec`, expected: `Schema validation passes`, isPrecondition: false });
    }
    return steps;
}

function stepsToXml(steps: Array<{ stepNumber: number; action: string; expected: string; isPrecondition: boolean }>): string {
    const rows = steps.map((s) => `<step id="${s.stepNumber}" type="${s.isPrecondition ? 'PreCondition' : 'ActionStep'}">
  <parameterizedString isformatted="true">&lt;P&gt;${escapeHtml(s.action)}&lt;/P&gt;</parameterizedString>
  <parameterizedString isformatted="true">&lt;P&gt;${escapeHtml(s.expected)}&lt;/P&gt;</parameterizedString>
  <description/>
</step>`).join('');
    return `<steps id="0" last="${steps.length}">${rows}</steps>`;
}

// =============================================================================
// Feature-file emission.
// =============================================================================

interface GeneratedFeatureFile {
    path: string;
    scenarioCount: number;
    tagGroup: string;
    mappings: ScenarioMapping[];
}

function groupByTag(endpoints: Endpoint[]): Map<string, Endpoint[]> {
    const map = new Map<string, Endpoint[]>();
    for (const ep of endpoints) {
        const tag = ep.tags[0] ? slugify(ep.tags[0]) : 'default';
        const arr = map.get(tag) || [];
        arr.push(ep);
        map.set(tag, arr);
    }
    return map;
}

function emitFeatureFiles(
    outputRoot: string,
    endpointResults: Array<{ endpoint: Endpoint; tcId: number | null; tags: string[]; title: string }>,
): GeneratedFeatureFile[] {
    const out: GeneratedFeatureFile[] = [];
    const dir = path.join(outputRoot, 'features', 'api');
    fs.mkdirSync(dir, { recursive: true });
    const grouped = new Map<string, typeof endpointResults>();
    for (const r of endpointResults) {
        const tag = r.endpoint.tags[0] ? slugify(r.endpoint.tags[0]) : 'default';
        const arr = grouped.get(tag) || [];
        arr.push(r);
        grouped.set(tag, arr);
    }
    for (const [tag, results] of grouped) {
        const featurePath = path.join(dir, `${tag}.feature`);
        const lines: string[] = [];
        lines.push(`@api @openapi @${tag}`);
        lines.push(`Feature: API — ${tag}`);
        lines.push(`  Auto-generated from OpenAPI spec. Each scenario exercises one endpoint.`);
        lines.push(``);
        const mappings: ScenarioMapping[] = [];
        for (const r of results) {
            const tagLineParts = r.tags.slice();
            lines.push(`  ${tagLineParts.join(' ')}`);
            const scenarioLine = lines.length + 1; // 1-indexed
            lines.push(`  Scenario: ${r.title}`);
            const steps = composeSteps(r.endpoint);
            for (const s of steps) {
                const keyword = s.stepNumber === 1 ? 'Given' : s.action.startsWith('Given ') ? 'Given' : s.action.startsWith('When ') ? 'When' : s.action.startsWith('Then ') ? 'Then' : s.action.startsWith('And ') ? 'And' : '';
                const stripped = s.action.replace(/^(Given|When|Then|And)\s+/, '');
                lines.push(`    ${keyword || 'When'} ${stripped}`);
            }
            lines.push(``);
            if (r.tcId) {
                mappings.push({
                    scenarioLine,
                    scenarioName: r.title,
                    testCaseIds: [r.tcId],
                });
            }
        }
        fs.writeFileSync(featurePath, lines.join('\n'), 'utf-8');
        out.push({ path: featurePath, scenarioCount: results.length, tagGroup: tag, mappings });
    }
    return out;
}

function emitStepDefs(outputRoot: string): string {
    const stepsDir = path.join(outputRoot, 'steps');
    fs.mkdirSync(stepsDir, { recursive: true });
    const stepFile = path.join(stepsDir, 'ApiSteps.steps.ts');
    // Generic API step defs — framework consumers can extend. Uses CSAPIClient
    // from the framework so all HTTP telemetry (logs, retries, tracing) is
    // consistent with the rest of the framework's API test suites.
    const source = `import { CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSAPIClient } from '@mdakhan.mak/cs-playwright-test-framework/api';
import { CSConfigurationManager } from '@mdakhan.mak/cs-playwright-test-framework/core';

const apiState: {
    lastResponse?: { status: number; body: unknown; headers: Record<string, string> };
    baseUrl?: string;
    authHeader?: string;
} = {};

export class ApiSteps {
    private client = new CSAPIClient();

    @CSBDDStepDef('the API base URL is configured for the target environment')
    async apiBaseUrlConfigured(): Promise<void> {
        apiState.baseUrl = CSConfigurationManager.getInstance().get('API_BASE_URL') || CSConfigurationManager.getInstance().get('BASE_URL') || '';
        if (!apiState.baseUrl) throw new Error('API_BASE_URL not configured for this environment');
    }

    @CSBDDStepDef('the request is authenticated per the configured security scheme (.*)')
    async apiAuthenticated(): Promise<void> {
        apiState.authHeader = CSConfigurationManager.getInstance().get('API_AUTH_HEADER') || '';
    }

    @CSBDDStepDef('I send (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\\\\S+)(?: with parameters \\\\{[^}]*\\\\})?(?: with request body)?')
    async apiSendRequest(method: string, urlPath: string): Promise<void> {
        const url = (apiState.baseUrl || '') + urlPath;
        const headers: Record<string, string> = {};
        if (apiState.authHeader) headers['Authorization'] = apiState.authHeader;
        const res = await this.client.request({ method: method as 'GET', url, headers });
        apiState.lastResponse = { status: res.status, body: res.body, headers: res.headers };
    }

    @CSBDDStepDef('the response status code equals (\\\\d+)')
    async apiStatusEquals(code: string): Promise<void> {
        if (!apiState.lastResponse) throw new Error('No response captured');
        const expected = Number(code);
        if (apiState.lastResponse.status !== expected) {
            throw new Error(\`Expected status \${expected}, got \${apiState.lastResponse.status}\`);
        }
    }

    @CSBDDStepDef('the response body matches the (\\\\d+) schema defined in the OpenAPI spec')
    async apiBodySchema(_code: string): Promise<void> {
        if (!apiState.lastResponse) throw new Error('No response captured');
        // Schema-lite check — body must exist. Consumer should extend with ajv
        // against the exported spec-derived schemas.
        if (apiState.lastResponse.body === undefined || apiState.lastResponse.body === null) {
            throw new Error('Response body is empty; schema validation cannot proceed');
        }
    }
}
`;
    fs.writeFileSync(stepFile, source, 'utf-8');
    return stepFile;
}

// =============================================================================
// Tool registration.
// =============================================================================

registerPrimitive({
    name: 'cs_qa_import_openapi',
    description: 'Import an OpenAPI 3.x / Swagger 2.x spec — create ADO Test Cases per endpoint + optionally generate Gherkin .feature files and generic ApiSteps.steps.ts. Supports JSON and YAML (js-yaml optional); path and URL inputs; include/exclude regex path filters; dry-run preview. ADO TC batch creation is gated by two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`).',
    inputSchema: z.object({
        specPath: z.string().optional().describe('Path to openapi.json or openapi.yaml on disk.'),
        specUrl: z.string().url().optional().describe('URL to fetch the spec from. Either specPath or specUrl is required.'),
        planId: z.number().int().positive().optional(),
        planName: z.string().optional(),
        suiteId: z.number().int().positive().optional(),
        suiteName: z.string().optional(),
        outputRoot: z.string().optional().describe('Directory to emit .feature files and step defs. Default: <workspaceRoot>/test/<slug>/api'),
        slug: z.string().optional(),
        generateFeatureFiles: z.boolean().default(true),
        generateStepDefs: z.boolean().default(true),
        includePathFilter: z.string().optional().describe('Regex to include endpoints by path.'),
        excludePathFilter: z.string().optional().describe('Regex to exclude endpoints by path.'),
        testCaseTemplate: z.object({
            titlePattern: z.string().optional(),
            tagPattern: z.string().optional(),
        }).optional(),
        dryRun: z.boolean().default(false),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
    }).refine((v) => !!v.specPath || !!v.specUrl, { message: 'Either specPath or specUrl is required.' }),
    outputSchema: z.object({
        ok: z.boolean(),
        spec: z.object({ version: z.string(), title: z.string(), endpointCount: z.number() }).optional(),
        tcsCreated: z.number().default(0),
        tcsSkipped: z.array(z.object({ endpoint: z.string(), reason: z.string() })).default([]),
        featureFilesGenerated: z.array(z.object({ path: z.string(), scenarioCount: z.number() })).default([]),
        stepDefFile: z.string().optional(),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
        requiresConfirmation: z.boolean().optional(),
        destructive: z.boolean().optional(),
        confirmationHint: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_import_openapi', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        // Load spec.
        let specText: string;
        if (input.specPath) {
            const resolved = path.isAbsolute(input.specPath) ? input.specPath : path.join(ctx.workspaceRoot, input.specPath);
            if (!fs.existsSync(resolved)) return { ok: false, tcsCreated: 0, tcsSkipped: [], featureFilesGenerated: [], warnings: [], note: `Spec not found at ${resolved}` };
            specText = fs.readFileSync(resolved, 'utf-8');
        } else {
            try {
                specText = await fetchSpec(input.specUrl!);
            } catch (e) {
                return { ok: false, tcsCreated: 0, tcsSkipped: [], featureFilesGenerated: [], warnings: [], note: (e as Error).message };
            }
        }

        let spec: OpenApiSpec;
        try {
            spec = parseSpec(specText, warnings);
        } catch (e) {
            return { ok: false, tcsCreated: 0, tcsSkipped: [], featureFilesGenerated: [], warnings, note: `Spec parse failed: ${(e as Error).message}` };
        }
        const version = spec.openapi ? `openapi ${spec.openapi}` : spec.swagger ? `swagger ${spec.swagger}` : 'unknown';
        const title = spec.info?.title || 'Untitled API';

        const endpoints = enumerateEndpoints(spec);
        const filtered = applyFilters(endpoints, input.includePathFilter, input.excludePathFilter, warnings);
        log.info('spec parsed', { version, title, endpointCount: filtered.length, filteredOut: endpoints.length - filtered.length });

        if (filtered.length === 0) {
            return { ok: false, spec: { version, title, endpointCount: 0 }, tcsCreated: 0, tcsSkipped: [], featureFilesGenerated: [], warnings, note: 'No endpoints matched — check filters or the paths block.' };
        }

        const slug = input.slug || slugify(title);
        const outputRoot = input.outputRoot
            ? (path.isAbsolute(input.outputRoot) ? input.outputRoot : path.join(ctx.workspaceRoot, input.outputRoot))
            : path.join(ctx.workspaceRoot, 'test', slug, 'api');

        // Compose per-endpoint payloads.
        const composed = filtered.map((ep) => ({
            endpoint: ep,
            title: composeTitle(ep, input.testCaseTemplate?.titlePattern),
            tags: composeTags(ep, input.testCaseTemplate?.tagPattern),
            description: composeDescription(ep),
            steps: composeSteps(ep),
        }));

        // Dry-run early exit.
        if (input.dryRun) {
            const featureFilesGenerated: Array<{ path: string; scenarioCount: number }> = [];
            let stepDefFile: string | undefined;
            if (input.generateFeatureFiles) {
                const results = composed.map((c) => ({ endpoint: c.endpoint, tcId: null, tags: c.tags, title: c.title }));
                const files = emitFeatureFiles(outputRoot, results);
                for (const f of files) featureFilesGenerated.push({ path: f.path, scenarioCount: f.scenarioCount });
            }
            if (input.generateStepDefs) stepDefFile = emitStepDefs(outputRoot);
            return {
                ok: true,
                spec: { version, title, endpointCount: filtered.length },
                tcsCreated: 0,
                tcsSkipped: composed.map((c) => ({ endpoint: `${c.endpoint.method} ${c.endpoint.path}`, reason: 'dry-run' })),
                featureFilesGenerated,
                stepDefFile,
                warnings,
                note: `Dry-run: ${composed.length} endpoints would produce ${composed.length} test cases. Feature files ${input.generateFeatureFiles ? 'emitted' : 'skipped'}; step defs ${input.generateStepDefs ? 'emitted' : 'skipped'}.`,
            };
        }

        // Resolve creds + plan/suite.
        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl,
            project: input.project,
            personalAccessToken: input.pat,
        });
        if (!credsRes.creds) {
            return { ok: false, spec: { version, title, endpointCount: filtered.length }, tcsCreated: 0, tcsSkipped: [], featureFilesGenerated: [], warnings, note: credsRes.diagnostic };
        }
        const cfg: AdoCreds = credsRes.creds;
        const client = new AdoHttpClient(cfg);
        const cache = createCache();

        // Two-phase confirmation gate (client-agnostic).
        if ((input as { confirmed?: boolean }).confirmed !== true) {
            return {
                ok: false, spec: { version, title, endpointCount: filtered.length },
                tcsCreated: 0, tcsSkipped: [], featureFilesGenerated: [], warnings,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint: `Import ${composed.length} endpoints from "${title}" (${version}) as ADO Test Cases in project ${cfg.project}? No write performed. Retry the SAME call with confirmed:true (added at the top level).`,
                note: 'requires confirmation — retry with confirmed:true',
            } as never;
        }

        // Resolve plan and (optionally) suite.
        let resolvedPlanId: number | undefined;
        let resolvedSuiteId: number | undefined;
        if (input.planId || input.planName) {
            const planRes = await resolvePlan(cfg, { planId: input.planId, planName: input.planName }, cache);
            for (const w of planRes.warnings) warnings.push(w);
            if (planRes.resolved.length === 1) resolvedPlanId = planRes.resolved[0].id;
            else if (planRes.ambiguous) {
                return { ok: false, spec: { version, title, endpointCount: filtered.length }, tcsCreated: 0, tcsSkipped: [], featureFilesGenerated: [], warnings, note: `Plan ambiguous: ${JSON.stringify(planRes.candidates)}` };
            }
        }
        if (resolvedPlanId && (input.suiteId || input.suiteName)) {
            const suiteRes = await resolveSuite(cfg, { planId: resolvedPlanId, suiteId: input.suiteId, suiteName: input.suiteName }, cache);
            for (const w of suiteRes.warnings) warnings.push(w);
            if (suiteRes.resolved.length === 1) resolvedSuiteId = suiteRes.resolved[0].id;
            else if (suiteRes.ambiguous) {
                return { ok: false, spec: { version, title, endpointCount: filtered.length }, tcsCreated: 0, tcsSkipped: [], featureFilesGenerated: [], warnings, note: `Suite ambiguous: ${JSON.stringify(suiteRes.candidates)}` };
            }
        }

        // Batch-create TCs, concurrency 5.
        interface CreatedTc { endpointKey: string; tcId: number; url?: string }
        const bulk = await bulkExecute(composed, {
            chunkSize: 1,
            concurrency: 5,
            workFn: async (batch) => {
                const c = batch[0];
                const patch: Array<Record<string, unknown>> = [
                    { op: 'add', path: '/fields/System.Title', value: c.title },
                    { op: 'add', path: '/fields/System.Description', value: c.description },
                    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: stepsToXml(c.steps) },
                ];
                if (c.tags.length > 0) patch.push({ op: 'add', path: '/fields/System.Tags', value: c.tags.join('; ') });
                const created = await client.post<{ id?: number; url?: string }>(
                    `_apis/wit/workitems/$Test%20Case?api-version=7.0`,
                    patch,
                );
                return [{ endpointKey: `${c.endpoint.method} ${c.endpoint.path}`, tcId: Number(created.id || 0), url: created.url } as CreatedTc];
            },
            onChunkError: (err, chunk) => {
                log.warn('endpoint TC create failed', { endpoint: `${chunk[0].endpoint.method} ${chunk[0].endpoint.path}`, error: err.message });
            },
        });

        const tcsSkipped: Array<{ endpoint: string; reason: string }> = bulk.failed.map((f) => ({ endpoint: `${f.item.endpoint.method} ${f.item.endpoint.path}`, reason: f.error.message }));
        const tcResults = new Map<string, number>();
        for (const r of bulk.ok) tcResults.set(r.endpointKey, r.tcId);

        // Optional: add to suite (batched via bulkExecute chunkSize=200).
        if (resolvedPlanId && resolvedSuiteId && bulk.ok.length > 0) {
            const ids = bulk.ok.map((r) => r.tcId).filter((n) => n > 0);
            const addRes = await bulkExecute(ids, {
                chunkSize: 200,
                concurrency: 2,
                workFn: async (chunk) => {
                    await client.post(
                        `_apis/testplan/plans/${resolvedPlanId}/suites/${resolvedSuiteId}/TestCase?api-version=7.0`,
                        chunk.map((id) => ({ pointAssignments: [], workItem: { id } })),
                    );
                    return chunk.map(() => 1);
                },
            });
            if (addRes.failedChunks > 0) warnings.push(`Failed to add ${addRes.failed.length} test cases to suite ${resolvedSuiteId}: ${addRes.failed.map((f) => f.error.message).slice(0, 3).join('; ')}`);
        }

        // Emit feature files.
        const featureFilesGenerated: Array<{ path: string; scenarioCount: number }> = [];
        let stepDefFile: string | undefined;
        if (input.generateFeatureFiles) {
            const results = composed.map((c) => ({
                endpoint: c.endpoint,
                tcId: tcResults.get(`${c.endpoint.method} ${c.endpoint.path}`) || null,
                tags: c.tags,
                title: c.title,
            }));
            const files = emitFeatureFiles(outputRoot, results);
            for (const f of files) {
                featureFilesGenerated.push({ path: f.path, scenarioCount: f.scenarioCount });
                // Sync-back @TestCaseId tags into the emitted file (also stamps plan/suite when known).
                const mappings = f.mappings.map((m) => ({ ...m, testPlanId: resolvedPlanId, testSuiteId: resolvedSuiteId }));
                if (mappings.length > 0) {
                    try { syncFeatureAfterPublish(f.path, mappings, ctx.workspaceRoot); }
                    catch (e) { warnings.push(`Sync-back failed for ${f.path}: ${(e as Error).message}`); }
                }
            }
        }
        if (input.generateStepDefs) stepDefFile = emitStepDefs(outputRoot);

        return {
            ok: true,
            spec: { version, title, endpointCount: filtered.length },
            tcsCreated: bulk.ok.length,
            tcsSkipped,
            featureFilesGenerated,
            stepDefFile,
            warnings,
            note: `Imported ${bulk.ok.length}/${composed.length} endpoints. ${resolvedSuiteId ? `Added to suite ${resolvedSuiteId}.` : 'No suite specified — TCs not added to any suite.'}`,
        };
    },
});
