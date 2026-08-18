/**
 * REST spec/feature emitter — reusable synthesis of Playwright-BDD-style
 * Gherkin features + step defs and framework-consistent `_rest-helper.ts`
 * for REST endpoints described either inline or discovered via OpenAPI.
 *
 * All generated helpers use CSReporter for logging — never console.log.
 * All generated auth uses `process.env.<TOKEN_ENV_VAR>` — never hard-coded.
 * Idempotent: pre-existing helper files are preserved (warning surfaced).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface RestEndpoint {
    method: string;                 // GET/POST/PUT/PATCH/DELETE
    path: string;                   // /api/v1/users/{id}
    requestBody?: unknown;
    expectedStatus?: number;        // default 200
    description?: string;
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
}

export interface EmitRestArgs {
    outputRoot: string;
    endpoints: RestEndpoint[];
    baseUrlEnvVar?: string;         // default REST_BASE_URL
    authTokenEnvVar: string;
    warnings: string[];
}

export interface EmittedRestFile {
    filePath: string;
    endpoint: RestEndpoint;
    scenarioName: string;
}

// ---------------------------------------------------------------------------
// Naming / escaping helpers.
// ---------------------------------------------------------------------------

export function slugifyPath(method: string, urlPath: string): string {
    const cleaned = urlPath
        .replace(/[{}]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return `${method.toLowerCase()}-${cleaned || 'root'}`;
}

export function pascal(s: string): string {
    return s
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join('') || 'RestOp';
}

function tsStringLiteral(s: string): string {
    return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
}

function jsonLiteralOrEmpty(v: unknown): string {
    if (v === undefined || v === null) return 'undefined';
    try { return JSON.stringify(v, null, 4); } catch { return 'undefined'; }
}

// ---------------------------------------------------------------------------
// Feature file emission — one scenario per endpoint, tagged @rest.
// ---------------------------------------------------------------------------

export function emitFeatureFile(args: {
    outputRoot: string;
    endpoint: RestEndpoint;
    authTokenEnvVar: string;
}): EmittedRestFile {
    const dir = path.join(args.outputRoot, 'features');
    fs.mkdirSync(dir, { recursive: true });
    const stub = slugifyPath(args.endpoint.method, args.endpoint.path);
    const filePath = path.join(dir, `${stub}.feature`);
    const status = args.endpoint.expectedStatus ?? (args.endpoint.method.toUpperCase() === 'POST' ? 201 : 200);
    const scenarioName = `${args.endpoint.method.toUpperCase()} ${args.endpoint.path} returns ${status}`;
    const tags = [
        '@rest',
        `@method:${args.endpoint.method.toLowerCase()}`,
        '@auto-generated',
    ];
    const lines: string[] = [];
    lines.push(tags.join(' '));
    lines.push(`Feature: REST ${args.endpoint.method.toUpperCase()} ${args.endpoint.path}`);
    if (args.endpoint.description) lines.push(`  ${args.endpoint.description}`);
    lines.push('');
    lines.push('  @happy-path');
    lines.push(`  Scenario: ${scenarioName}`);
    lines.push(`    Given a REST request "${args.endpoint.method.toUpperCase()} ${args.endpoint.path}"`);
    lines.push(`    And the request is authenticated with token from env "${args.authTokenEnvVar}"`);
    if (args.endpoint.requestBody !== undefined && args.endpoint.requestBody !== null) {
        lines.push(`    And the request body matches the generated fixture`);
    }
    lines.push(`    When the REST request is sent`);
    lines.push(`    Then the response status is ${status}`);
    lines.push(`    And the response body is well-formed JSON`);
    lines.push('');
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return { filePath, endpoint: args.endpoint, scenarioName };
}

// ---------------------------------------------------------------------------
// Step-def emission — one shared step-def file for the endpoint bundle.
// Includes per-endpoint fixture map so runtime is deterministic.
// ---------------------------------------------------------------------------

export function emitStepDefs(args: {
    outputRoot: string;
    endpoints: RestEndpoint[];
    authTokenEnvVar: string;
    baseUrlEnvVar: string;
}): string {
    const stepsDir = path.join(args.outputRoot, 'steps');
    fs.mkdirSync(stepsDir, { recursive: true });
    const filePath = path.join(stepsDir, 'RestSteps.ts');
    const fixtures: Record<string, { method: string; path: string; body: unknown; expectedStatus: number; headers: Record<string, string> }> = {};
    for (const ep of args.endpoints) {
        const key = `${ep.method.toUpperCase()} ${ep.path}`;
        fixtures[key] = {
            method: ep.method.toUpperCase(),
            path: ep.path,
            body: ep.requestBody ?? null,
            expectedStatus: ep.expectedStatus ?? (ep.method.toUpperCase() === 'POST' ? 201 : 200),
            headers: ep.headers ?? {},
        };
    }
    const fixturesLiteral = JSON.stringify(fixtures, null, 4);
    const baseVar = tsStringLiteral(args.baseUrlEnvVar);
    const authVar = tsStringLiteral(args.authTokenEnvVar);

    const src = `import { CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
import { RestClient } from '../_rest-helper';

const BASE_URL_ENV_VAR = ${baseVar};
const AUTH_TOKEN_ENV_VAR = ${authVar};

const FIXTURES: Record<string, { method: string; path: string; body: unknown; expectedStatus: number; headers: Record<string, string> }> = ${fixturesLiteral};

interface StepState {
    key?: string;
    method?: string;
    path?: string;
    body?: unknown;
    expectedStatus?: number;
    headers: Record<string, string>;
    response?: { status: number; body: string; json?: unknown };
}

const state: StepState = { headers: {} };

export class RestSteps {
    private client = new RestClient();

    @CSBDDStepDef('a REST request "([A-Z]+) (.+)"')
    async request(method: string, urlPath: string): Promise<void> {
        const key = \`\${method} \${urlPath}\`;
        const fx = FIXTURES[key];
        if (!fx) throw new Error(\`Unknown REST endpoint fixture "\${key}" — regenerate with cs_qa_gen_protocol_test (verb:'rest')\`);
        state.key = key;
        state.method = fx.method;
        state.path = fx.path;
        state.body = fx.body;
        state.expectedStatus = fx.expectedStatus;
        state.headers = { ...fx.headers };
        state.response = undefined;
        CSReporter.info(\`Prepared REST request \${key}\`);
    }

    @CSBDDStepDef('the request is authenticated with token from env "([^"]+)"')
    async attachAuth(envVar: string): Promise<void> {
        const token = process.env[envVar] || process.env[AUTH_TOKEN_ENV_VAR] || '';
        if (!token) {
            CSReporter.warn(\`No token in env var \${envVar} — proceeding unauthenticated\`);
            return;
        }
        state.headers['Authorization'] = \`Bearer \${token}\`;
        CSReporter.info('Attached Bearer token from env');
    }

    @CSBDDStepDef('the request body matches the generated fixture')
    async bodyFromFixture(): Promise<void> {
        // The fixture is already loaded in state.body during the request step —
        // this step is a Gherkin readability affordance.
        if (state.body === undefined || state.body === null) {
            throw new Error('No body fixture for this endpoint');
        }
        CSReporter.info('Request body loaded from fixture');
    }

    @CSBDDStepDef('the REST request is sent')
    async sendRequest(): Promise<void> {
        if (!state.method || !state.path) throw new Error('Request not prepared');
        const baseUrl = process.env[BASE_URL_ENV_VAR] || '';
        if (!baseUrl) throw new Error(\`No REST base URL — set env var \${BASE_URL_ENV_VAR}\`);
        state.response = await this.client.send({
            baseUrl,
            method: state.method,
            path: state.path,
            body: state.body,
            headers: state.headers,
        });
        CSReporter.info(\`REST response status \${state.response.status}\`);
    }

    @CSBDDStepDef('the response status is (\\\\d+)')
    async responseStatusIs(code: string): Promise<void> {
        if (!state.response) throw new Error('No response captured');
        if (state.response.status !== Number(code)) {
            throw new Error(\`Expected status \${code}, got \${state.response.status}. Body first 500 chars: \${state.response.body.slice(0, 500)}\`);
        }
    }

    @CSBDDStepDef('the response body is well-formed JSON')
    async responseIsJson(): Promise<void> {
        if (!state.response) throw new Error('No response captured');
        if (state.response.body.trim().length === 0) return; // 204 style
        try { state.response.json = JSON.parse(state.response.body); }
        catch (e) { throw new Error(\`Response is not valid JSON: \${(e as Error).message}\`); }
    }
}
`;
    fs.writeFileSync(filePath, src, 'utf-8');
    return filePath;
}

// ---------------------------------------------------------------------------
// Framework-consistent runtime helper — Node http/https, CSReporter logging.
// ---------------------------------------------------------------------------

export function emitRestHelper(outputRoot: string, warnings: string[]): string {
    const filePath = path.join(outputRoot, '_rest-helper.ts');
    if (fs.existsSync(filePath)) {
        warnings.push(`_rest-helper.ts already exists at ${filePath} — kept as-is (generator does not clobber consumer edits).`);
        return filePath;
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    const src = `/* eslint-disable */
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

// Auto-generated by cs_qa_gen_protocol_test. Safe to edit; the generator will
// not clobber this file if it already exists.

export interface RestSendArgs {
    baseUrl: string;
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
}

export interface RestResponse {
    status: number;
    body: string;
    json?: unknown;
    headers: Record<string, string>;
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
        if (/^authorization$/i.test(k)) out[k] = '***REDACTED***';
        else out[k] = v;
    }
    return out;
}

function joinUrl(baseUrl: string, subPath: string): string {
    if (/^https?:\\/\\//i.test(subPath)) return subPath;
    const trimmedBase = baseUrl.replace(/\\/+$/, '');
    const trimmedPath = subPath.startsWith('/') ? subPath : '/' + subPath;
    return trimmedBase + trimmedPath;
}

export class RestClient {
    async send(args: RestSendArgs): Promise<RestResponse> {
        const target = joinUrl(args.baseUrl, args.path);
        const parsed = new URL(target);
        const bodyText = args.body === undefined || args.body === null
            ? ''
            : (typeof args.body === 'string' ? args.body : JSON.stringify(args.body));
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...(args.headers || {}),
        };
        if (bodyText.length > 0) headers['Content-Length'] = Buffer.byteLength(bodyText, 'utf-8').toString();

        const safe = redactHeaders(headers);
        CSReporter.info(\`REST \${args.method} \${target}\`);
        CSReporter.debug(\`REST request headers: \${JSON.stringify(safe)}\`);
        const timeoutMs = args.timeoutMs || 30_000;

        return new Promise<RestResponse>((resolve, reject) => {
            const isHttps = parsed.protocol === 'https:';
            const lib = isHttps ? https : http;
            const req = lib.request({
                method: args.method,
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                headers,
                timeout: timeoutMs,
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(Buffer.from(c)));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    const responseHeaders: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers)) {
                        if (Array.isArray(v)) responseHeaders[k] = v.join(', ');
                        else if (v !== undefined) responseHeaders[k] = String(v);
                    }
                    let json: unknown;
                    try { if (body.trim().length > 0) json = JSON.parse(body); } catch { /* not JSON */ }
                    CSReporter.info(\`REST response status \${res.statusCode || 0}\`);
                    resolve({ status: res.statusCode || 0, body, json, headers: responseHeaders });
                });
            });
            req.on('error', (err) => {
                CSReporter.error(\`REST request error: \${err.message}\`);
                reject(err);
            });
            req.on('timeout', () => {
                req.destroy(new Error(\`REST request timeout after \${timeoutMs}ms\`));
            });
            if (bodyText.length > 0) req.write(bodyText);
            req.end();
        });
    }
}
`;
    fs.writeFileSync(filePath, src, 'utf-8');
    return filePath;
}

// ---------------------------------------------------------------------------
// .env.template merging (idempotent).
// ---------------------------------------------------------------------------

export function emitEnvTemplate(outputRoot: string, keys: string[]): string {
    const templatePath = path.join(outputRoot, '.env.template');
    fs.mkdirSync(outputRoot, { recursive: true });
    let existing = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf-8') : '';
    const newLines: string[] = [];
    for (const k of keys) {
        if (existing.includes(`${k}=`)) continue;
        newLines.push(`${k}=ENCRYPTED:`);
    }
    if (existing.length === 0) {
        existing = '# Auto-generated by cs_qa_gen_protocol_test. Fill values via `cs-playwright-mcp encrypt <plain>` and paste after ENCRYPTED:.\n';
    }
    const finalText = existing + (newLines.length > 0 ? (existing.endsWith('\n') ? '' : '\n') + newLines.join('\n') + '\n' : '');
    fs.writeFileSync(templatePath, finalText, 'utf-8');
    return templatePath;
}
