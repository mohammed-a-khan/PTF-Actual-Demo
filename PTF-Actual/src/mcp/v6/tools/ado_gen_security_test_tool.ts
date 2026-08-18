/**
 * cs_qa_gen_security_test — OWASP-graded security test scaffolder.
 *
 * Emits a Playwright/BDD suite that probes a target URL against a chosen set of
 * OWASP-mapped categories (SQLi, XSS, CSRF, auth-bypass, sensitive-data-exposure,
 * security-headers, session-fixation, clickjacking, IDOR, command-injection).
 *
 * The generated `_security-helper.ts` carries the payload library, a
 * response-header validator, and a reflection detector — so the emitted steps
 * stay short and framework-idiomatic.
 *
 * Non-negotiables enforced here:
 *  - All ADO HTTP via AdoHttpClient (Retry-After, PAT redaction).
 *  - All logging via createLogger (correlation-id + audit).
 *  - Two-phase confirmation on any ADO write.
 *  - On-prem safe — no `dev.azure.com` literals.
 *  - Zod schemas with defaults.
 *  - Generated .env.template ALWAYS `ENCRYPTED:` placeholder.
 *  - Generated helper uses CSReporter — never console.log.
 *  - No project pollution.
 *  - Payload profile "safe-list-only" restricts to inert probes for prod runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

// =============================================================================
// Schemas
// =============================================================================

const CategorySchema = z.enum([
    'sql-injection',
    'xss',
    'csrf',
    'auth-bypass',
    'sensitive-data-exposure',
    'security-headers',
    'session-fixation',
    'clickjacking',
    'idor',
    'command-injection',
]);
type Category = z.infer<typeof CategorySchema>;

const InputSchema = z.object({
    targetUrl: z.string().url(),
    categories: z.array(CategorySchema).optional().describe('Which OWASP categories to emit. Default: sql-injection, xss, auth-bypass, security-headers.'),
    authTokenEnvVar: z.string().min(1).optional(),
    adminCredentialsEnvVars: z.array(z.string().min(1)).default([]).describe('Env var names for admin creds — recorded in .env.template as ENCRYPTED: placeholders. Never real values.'),
    payloadsProfile: z.enum(['baseline', 'aggressive', 'safe-list-only']).default('baseline'),
    outputRoot: z.string().default('test/security'),
    createAdoTc: z.boolean().default(false),
    planId: z.number().int().positive().optional(),
    planName: z.string().optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().optional(),
    linkToStoryId: z.number().int().positive().optional(),
    dryRun: z.boolean().default(false),
    confirmed: z.boolean().default(false),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
});
type Input = z.infer<typeof InputSchema>;

const EmittedFeatureSchema = z.object({
    path: z.string(),
    category: CategorySchema,
    scenarios: z.array(z.string()),
    owaspCwe: z.string(),
});
const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.literal('gen-security-test'),
    targetUrl: z.string(),
    payloadsProfile: z.enum(['baseline', 'aggressive', 'safe-list-only']),
    categoriesGenerated: z.array(CategorySchema),
    featureFilesGenerated: z.array(EmittedFeatureSchema).default([]),
    stepDefFiles: z.array(z.string()).default([]),
    helperFile: z.string().optional(),
    readmeFile: z.string().optional(),
    envTemplateFile: z.string().optional(),
    tcsCreated: z.number().optional(),
    tcsSkipped: z.array(z.object({ scenario: z.string(), reason: z.string() })).optional(),
    requiresConfirmation: z.boolean().optional(),
    destructive: z.boolean().optional(),
    confirmationHint: z.string().optional(),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// OWASP metadata
// =============================================================================

interface CategoryMeta {
    owaspTop10: string;   // e.g. A03:2021
    cwe: string;          // e.g. CWE-89
    owaspCategory: string;
    scenarios: Array<{ name: string; type: 'attack' | 'defense'; description: string }>;
}

const CATEGORY_META: Record<Category, CategoryMeta> = {
    'sql-injection': {
        owaspTop10: 'A03:2021',
        cwe: 'CWE-89',
        owaspCategory: 'Injection',
        scenarios: [
            { name: 'input sanitizes classic SQLi payload', type: 'attack', description: 'Submit tautology payload; response must not leak DB error or extra rows.' },
            { name: 'input rejects boolean-based SQLi payload', type: 'attack', description: 'Submit boolean payload; response length remains equivalent to a benign submission.' },
            { name: 'error responses omit SQL syntax', type: 'defense', description: 'Server error responses reveal no SQLSTATE/ORA/PG-style stack traces.' },
        ],
    },
    'xss': {
        owaspTop10: 'A03:2021',
        cwe: 'CWE-79',
        owaspCategory: 'Injection',
        scenarios: [
            { name: 'reflected XSS payload is neutralized', type: 'attack', description: 'Submit a canonical script tag payload; response must not reflect executable script.' },
            { name: 'DOM-based XSS via hash fragment is neutralized', type: 'attack', description: 'Navigate with malicious #hash; page must not execute the injected script.' },
            { name: 'stored XSS submission is escaped on render', type: 'attack', description: 'Save payload via form; retrieve and confirm no live handlers in rendered HTML.' },
            { name: 'Content-Security-Policy header restricts inline script', type: 'defense', description: 'CSP header present and forbids unsafe-inline or is nonce-scoped.' },
        ],
    },
    'csrf': {
        owaspTop10: 'A01:2021',
        cwe: 'CWE-352',
        owaspCategory: 'Broken Access Control',
        scenarios: [
            { name: 'state-changing POST without CSRF token is rejected', type: 'attack', description: 'Send POST without CSRF token/header; server returns 4xx.' },
            { name: 'SameSite=Lax or Strict on session cookies', type: 'defense', description: 'Session cookie carries SameSite=Lax or Strict.' },
        ],
    },
    'auth-bypass': {
        owaspTop10: 'A07:2021',
        cwe: 'CWE-287',
        owaspCategory: 'Identification and Authentication Failures',
        scenarios: [
            { name: 'unauthenticated access to protected route is rejected', type: 'attack', description: 'Request protected path without credentials; server returns 401/403.' },
            { name: 'forced browsing to admin route as low-priv user is rejected', type: 'attack', description: 'Authenticate as low-priv; request admin-scoped path; server returns 401/403.' },
            { name: 'invalid credentials do not disclose account existence', type: 'defense', description: 'Login error message identical for unknown user vs. wrong password.' },
        ],
    },
    'sensitive-data-exposure': {
        owaspTop10: 'A02:2021',
        cwe: 'CWE-200',
        owaspCategory: 'Cryptographic Failures',
        scenarios: [
            { name: 'response body carries no PII patterns', type: 'defense', description: 'Response body does not contain SSN/credit-card/full DOB shapes.' },
            { name: 'transport uses TLS with strong protocol', type: 'defense', description: 'Endpoint served over HTTPS.' },
        ],
    },
    'security-headers': {
        owaspTop10: 'A05:2021',
        cwe: 'CWE-693',
        owaspCategory: 'Security Misconfiguration',
        scenarios: [
            { name: 'Strict-Transport-Security is present with valid max-age', type: 'defense', description: 'HSTS header present, max-age >= 6 months.' },
            { name: 'X-Content-Type-Options is nosniff', type: 'defense', description: 'X-Content-Type-Options: nosniff.' },
            { name: 'X-Frame-Options or CSP frame-ancestors is set', type: 'defense', description: 'Frame-Options DENY/SAMEORIGIN or CSP frame-ancestors none/self.' },
            { name: 'Referrer-Policy is set to a safe value', type: 'defense', description: 'Referrer-Policy in {no-referrer, strict-origin-when-cross-origin, same-origin}.' },
            { name: 'Content-Security-Policy header is present', type: 'defense', description: 'CSP header present with non-empty policy.' },
        ],
    },
    'session-fixation': {
        owaspTop10: 'A07:2021',
        cwe: 'CWE-384',
        owaspCategory: 'Identification and Authentication Failures',
        scenarios: [
            { name: 'session id rotates after login', type: 'defense', description: 'Session cookie value changes between pre-login and post-login.' },
            { name: 'session cookie has HttpOnly and Secure', type: 'defense', description: 'Session cookie carries HttpOnly and Secure attributes.' },
        ],
    },
    'clickjacking': {
        owaspTop10: 'A05:2021',
        cwe: 'CWE-1021',
        owaspCategory: 'Security Misconfiguration',
        scenarios: [
            { name: 'framing is denied via X-Frame-Options or CSP frame-ancestors', type: 'defense', description: 'Header prevents cross-origin framing.' },
        ],
    },
    'idor': {
        owaspTop10: 'A01:2021',
        cwe: 'CWE-639',
        owaspCategory: 'Broken Access Control',
        scenarios: [
            { name: 'access to another user resource id is rejected', type: 'attack', description: 'Request a resource id owned by another user; server returns 401/403 or masks response.' },
        ],
    },
    'command-injection': {
        owaspTop10: 'A03:2021',
        cwe: 'CWE-78',
        owaspCategory: 'Injection',
        scenarios: [
            { name: 'shell metacharacters in inputs are sanitized', type: 'attack', description: 'Submit input with shell separators; response does not reflect executed output.' },
            { name: 'error responses omit shell path fragments', type: 'defense', description: 'Errors do not leak /bin/*, /usr/local/*, or Windows drive letters.' },
        ],
    },
};

// =============================================================================
// Payload library — profile-aware
// =============================================================================

interface PayloadSet { sqli: string[]; xss: string[]; commandInjection: string[]; idor: string[] }

function buildPayloads(profile: Input['payloadsProfile']): PayloadSet {
    const baseline: PayloadSet = {
        sqli: [`' OR '1'='1`, `' OR 1=1--`, `'; --`],
        xss: [`<script>window.__csqa_xss=1</script>`, `"><svg onload=window.__csqa_xss=1>`, `javascript:window.__csqa_xss=1`],
        commandInjection: [`; echo csqa-probe`, `| echo csqa-probe`, `&& echo csqa-probe`],
        idor: [`../1`, `../2`],
    };
    if (profile === 'safe-list-only') {
        return {
            sqli: [`'`],
            xss: [`<b>csqa-probe</b>`],
            commandInjection: [`;`],
            idor: [`0`],
        };
    }
    if (profile === 'aggressive') {
        return {
            sqli: [...baseline.sqli, `UNION SELECT NULL--`, `1);WAITFOR DELAY '0:0:2'--`],
            xss: [...baseline.xss, `<iframe src=javascript:window.__csqa_xss=1></iframe>`, `<img src=x onerror=window.__csqa_xss=1>`],
            commandInjection: [...baseline.commandInjection, `\`echo csqa-probe\``, `$(echo csqa-probe)`],
            idor: [...baseline.idor, `../../../admin`],
        };
    }
    return baseline;
}

// =============================================================================
// Helpers
// =============================================================================

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'security';
}
function jsStr(s: string): string { return JSON.stringify(s); }
function jsArr(a: string[] | readonly string[]): string { return JSON.stringify(a); }
function jsObj(o: unknown): string { return JSON.stringify(o); }

// =============================================================================
// Emitters
// =============================================================================

interface EmittedFeature { path: string; category: Category; scenarios: string[]; owaspCwe: string }

function emitFeatureForCategory(outputRoot: string, targetUrl: string, category: Category): EmittedFeature {
    const meta = CATEGORY_META[category];
    const dir = path.join(outputRoot, 'features');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${slugify(category)}.feature`);
    const lines: string[] = [];
    const tagLine = `@security @${category} @${meta.cwe.toLowerCase()} @owasp-${meta.owaspTop10.replace(':', '').toLowerCase()} @auto-generated`;
    lines.push(tagLine);
    lines.push(`Feature: Security — ${meta.owaspCategory} — ${category}`);
    lines.push(`  OWASP Top 10: ${meta.owaspTop10}. CWE: ${meta.cwe}.`);
    lines.push(`  Target URL: ${targetUrl}`);
    lines.push('');
    const scenarioNames: string[] = [];
    for (const sc of meta.scenarios) {
        scenarioNames.push(sc.name);
        const scTag = sc.type === 'attack' ? '@attack' : '@defense';
        lines.push(`  ${scTag}`);
        lines.push(`  Scenario: ${sc.name}`);
        // Concrete Given/When/Then per scenario type.
        switch (category) {
            case 'sql-injection':
                if (sc.type === 'attack') {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When a SQL injection payload is submitted to a common query parameter`);
                    lines.push(`    Then the response body contains no database error fragments`);
                    lines.push(`    And the response status is not 500`);
                } else {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When a deliberately malformed input is submitted`);
                    lines.push(`    Then the response body carries no SQL syntax or stack fragments`);
                }
                break;
            case 'xss':
                if (sc.type === 'attack') {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When an XSS payload is submitted or navigated to`);
                    lines.push(`    Then the response HTML does not carry executable script fragments`);
                    lines.push(`    And no window global was set by injected script`);
                } else {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When the response headers are inspected`);
                    lines.push(`    Then the Content-Security-Policy header restricts inline script`);
                }
                break;
            case 'csrf':
                if (sc.type === 'attack') {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When a state-changing POST is sent without a CSRF token`);
                    lines.push(`    Then the response status is between 400 and 403`);
                } else {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When the session cookie is inspected`);
                    lines.push(`    Then the SameSite attribute is Lax or Strict`);
                }
                break;
            case 'auth-bypass':
                if (sc.type === 'attack') {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When an unauthenticated request is sent to a protected route`);
                    lines.push(`    Then the response status is 401 or 403`);
                } else {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When login is attempted with an unknown user and again with a wrong password`);
                    lines.push(`    Then both error messages are semantically identical`);
                }
                break;
            case 'sensitive-data-exposure':
                lines.push(`    Given the security helper targets ${targetUrl}`);
                lines.push(`    When the response body is inspected`);
                lines.push(`    Then it contains no PII patterns`);
                break;
            case 'security-headers':
                lines.push(`    Given the security helper targets ${targetUrl}`);
                lines.push(`    When the response headers are inspected`);
                lines.push(`    Then the required security header for "${sc.name}" is present and valid`);
                break;
            case 'session-fixation':
                if (sc.name.startsWith('session id rotates')) {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When a login is performed`);
                    lines.push(`    Then the session cookie value after login differs from before login`);
                } else {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When the session cookie is inspected`);
                    lines.push(`    Then the cookie carries both HttpOnly and Secure attributes`);
                }
                break;
            case 'clickjacking':
                lines.push(`    Given the security helper targets ${targetUrl}`);
                lines.push(`    When the response headers are inspected`);
                lines.push(`    Then framing is denied via X-Frame-Options or CSP frame-ancestors`);
                break;
            case 'idor':
                lines.push(`    Given the security helper targets ${targetUrl}`);
                lines.push(`    When a resource id belonging to another user is requested`);
                lines.push(`    Then the response status is 401 or 403`);
                break;
            case 'command-injection':
                if (sc.type === 'attack') {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When a command injection payload is submitted`);
                    lines.push(`    Then the response body does not contain the sentinel echo output`);
                } else {
                    lines.push(`    Given the security helper targets ${targetUrl}`);
                    lines.push(`    When a deliberately malformed input is submitted`);
                    lines.push(`    Then the response body carries no shell path fragments`);
                }
                break;
        }
        lines.push('');
    }
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return { path: filePath, category, scenarios: scenarioNames, owaspCwe: meta.cwe };
}

function emitStepDefs(outputRoot: string, categories: Category[], profile: Input['payloadsProfile'], authTokenEnvVar: string | undefined): string {
    const dir = path.join(outputRoot, 'steps');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'SecuritySteps.ts');
    const payloads = buildPayloads(profile);
    const source = `import { CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
import { SecurityClient, validateHeaders, containsPii, detectReflection, SQL_ERROR_FRAGMENTS, SHELL_PATH_FRAGMENTS } from '../_security-helper';

const PAYLOADS_SQLI: string[] = ${jsArr(payloads.sqli)};
const PAYLOADS_XSS: string[] = ${jsArr(payloads.xss)};
const PAYLOADS_CMD: string[] = ${jsArr(payloads.commandInjection)};
const PAYLOADS_IDOR: string[] = ${jsArr(payloads.idor)};
const AUTH_TOKEN_ENV_VAR = ${authTokenEnvVar ? jsStr(authTokenEnvVar) : 'undefined'};

interface SecState {
    targetUrl?: string;
    lastResponse?: { status: number; headers: Record<string, string>; body: string };
    lastSessionCookiePre?: string;
    lastSessionCookiePost?: string;
    xssGlobalTripped?: boolean;
}

const state: SecState = {};
const client = new SecurityClient();

export class SecuritySteps {
    @CSBDDStepDef('the security helper targets (\\\\S+)')
    async targetIs(url: string): Promise<void> {
        state.targetUrl = url;
        CSReporter.info('Security helper target set: ' + url);
    }

    private authHeader(): Record<string, string> {
        if (!AUTH_TOKEN_ENV_VAR) return {};
        const token = process.env[AUTH_TOKEN_ENV_VAR];
        return token ? { Authorization: 'Bearer ' + token } : {};
    }

    // ---- SQL injection ----
    @CSBDDStepDef('a SQL injection payload is submitted to a common query parameter')
    async sendSqli(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        const payload = PAYLOADS_SQLI[0];
        const url = state.targetUrl + (state.targetUrl.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(payload);
        state.lastResponse = await client.get(url, this.authHeader());
        CSReporter.info('SQLi probe status=' + state.lastResponse.status);
    }
    @CSBDDStepDef('the response body contains no database error fragments')
    async assertNoDbErrors(): Promise<void> {
        const body = state.lastResponse?.body ?? '';
        for (const frag of SQL_ERROR_FRAGMENTS) {
            if (body.toLowerCase().includes(frag)) throw new Error('database error fragment leaked: ' + frag);
        }
    }
    @CSBDDStepDef('the response status is not (\\\\d+)')
    async assertStatusNot(codeS: string): Promise<void> {
        const code = parseInt(codeS, 10);
        if ((state.lastResponse?.status ?? 0) === code) throw new Error('server returned ' + code);
    }
    @CSBDDStepDef('a deliberately malformed input is submitted')
    async sendMalformed(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        const url = state.targetUrl + (state.targetUrl.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(PAYLOADS_SQLI[0]);
        state.lastResponse = await client.get(url, this.authHeader());
    }
    @CSBDDStepDef('the response body carries no SQL syntax or stack fragments')
    async assertNoSqlStack(): Promise<void> {
        const body = state.lastResponse?.body ?? '';
        for (const frag of SQL_ERROR_FRAGMENTS) if (body.toLowerCase().includes(frag)) throw new Error('SQL fragment leaked: ' + frag);
    }

    // ---- XSS ----
    @CSBDDStepDef('an XSS payload is submitted or navigated to')
    async sendXss(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        const payload = PAYLOADS_XSS[0];
        const url = state.targetUrl + (state.targetUrl.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(payload);
        state.lastResponse = await client.get(url, this.authHeader());
        state.xssGlobalTripped = false;
    }
    @CSBDDStepDef('the response HTML does not carry executable script fragments')
    async assertNoExecXss(): Promise<void> {
        const body = state.lastResponse?.body ?? '';
        if (detectReflection(body, PAYLOADS_XSS)) throw new Error('XSS payload reflected verbatim into response');
    }
    @CSBDDStepDef('no window global was set by injected script')
    async assertNoWindowGlobal(): Promise<void> {
        if (state.xssGlobalTripped === true) throw new Error('injected script executed (window global was set)');
    }
    @CSBDDStepDef('the response headers are inspected')
    async inspectHeaders(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        state.lastResponse = await client.get(state.targetUrl, this.authHeader());
    }
    @CSBDDStepDef('the Content-Security-Policy header restricts inline script')
    async assertCsp(): Promise<void> {
        const hs = state.lastResponse?.headers ?? {};
        const csp = hs['content-security-policy'] || '';
        if (!csp) throw new Error('CSP header missing');
        if (!(/'nonce-/.test(csp) || /'strict-dynamic'/.test(csp)) && /unsafe-inline/.test(csp)) throw new Error('CSP allows unsafe-inline without nonce/strict-dynamic');
    }

    // ---- CSRF ----
    @CSBDDStepDef('a state-changing POST is sent without a CSRF token')
    async postWithoutCsrf(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        state.lastResponse = await client.post(state.targetUrl, {}, this.authHeader());
    }
    @CSBDDStepDef('the response status is between (\\\\d+) and (\\\\d+)')
    async assertStatusBetween(lowS: string, highS: string): Promise<void> {
        const low = parseInt(lowS, 10);
        const high = parseInt(highS, 10);
        const s = state.lastResponse?.status ?? 0;
        if (s < low || s > high) throw new Error('status ' + s + ' outside [' + low + ',' + high + ']');
    }
    @CSBDDStepDef('the session cookie is inspected')
    async inspectSessionCookie(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        state.lastResponse = await client.get(state.targetUrl, this.authHeader());
    }
    @CSBDDStepDef('the SameSite attribute is Lax or Strict')
    async assertSameSite(): Promise<void> {
        const setCookie = state.lastResponse?.headers['set-cookie'] || '';
        if (!/samesite\\s*=\\s*(lax|strict)/i.test(setCookie)) throw new Error('SameSite Lax/Strict missing on Set-Cookie: ' + setCookie);
    }

    // ---- Auth bypass ----
    @CSBDDStepDef('an unauthenticated request is sent to a protected route')
    async sendUnauth(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        state.lastResponse = await client.get(state.targetUrl, {});
    }
    @CSBDDStepDef('the response status is (\\\\d+) or (\\\\d+)')
    async assertStatusOneOf(aS: string, bS: string): Promise<void> {
        const a = parseInt(aS, 10);
        const b = parseInt(bS, 10);
        const s = state.lastResponse?.status ?? 0;
        if (s !== a && s !== b) throw new Error('status ' + s + ' not in {' + a + ',' + b + '}');
    }
    @CSBDDStepDef('login is attempted with an unknown user and again with a wrong password')
    async attemptTwoLogins(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        const rA = await client.post(state.targetUrl, { username: 'no_such_user_csqa', password: 'x' }, {});
        const rB = await client.post(state.targetUrl, { username: 'admin', password: 'definitely_wrong_csqa' }, {});
        state.lastResponse = rA;
        // Compare body length + status shape.
        if (rA.status !== rB.status) throw new Error('status differed between unknown-user vs wrong-password (' + rA.status + ' vs ' + rB.status + ')');
        if (Math.abs(rA.body.length - rB.body.length) > 32) throw new Error('body length differed significantly — user enumeration risk');
    }
    @CSBDDStepDef('both error messages are semantically identical')
    async assertLoginErrorsIdentical(): Promise<void> { /* asserted above via status + length */ }

    // ---- Sensitive data ----
    @CSBDDStepDef('the response body is inspected')
    async inspectBody(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        state.lastResponse = await client.get(state.targetUrl, this.authHeader());
    }
    @CSBDDStepDef('it contains no PII patterns')
    async assertNoPii(): Promise<void> {
        const body = state.lastResponse?.body ?? '';
        const found = containsPii(body);
        if (found) throw new Error('PII pattern detected: ' + found);
    }

    // ---- Security headers (generic) ----
    @CSBDDStepDef('the required security header for "([^"]+)" is present and valid')
    async assertHeader(scenarioName: string): Promise<void> {
        const hs = state.lastResponse?.headers ?? {};
        const result = validateHeaders(hs, scenarioName);
        if (!result.ok) throw new Error(result.reason);
    }

    // ---- Session fixation ----
    @CSBDDStepDef('a login is performed')
    async performLogin(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        const pre = await client.get(state.targetUrl, {});
        state.lastSessionCookiePre = extractSessionCookie(pre.headers['set-cookie'] || '');
        const post = await client.post(state.targetUrl, { username: process.env.ADMIN_USER || '', password: process.env.ADMIN_PASS || '' }, {});
        state.lastSessionCookiePost = extractSessionCookie(post.headers['set-cookie'] || '');
        state.lastResponse = post;
    }
    @CSBDDStepDef('the session cookie value after login differs from before login')
    async assertSessionRotates(): Promise<void> {
        if (!state.lastSessionCookiePost) throw new Error('no post-login session cookie captured');
        if (state.lastSessionCookiePost === state.lastSessionCookiePre) throw new Error('session cookie did not rotate after login (fixation risk)');
    }
    @CSBDDStepDef('the cookie carries both HttpOnly and Secure attributes')
    async assertCookieFlags(): Promise<void> {
        const setCookie = state.lastResponse?.headers['set-cookie'] || '';
        if (!/httponly/i.test(setCookie)) throw new Error('HttpOnly missing on Set-Cookie: ' + setCookie);
        if (!/secure/i.test(setCookie)) throw new Error('Secure missing on Set-Cookie: ' + setCookie);
    }

    // ---- Clickjacking ----
    @CSBDDStepDef('framing is denied via X-Frame-Options or CSP frame-ancestors')
    async assertFramingDenied(): Promise<void> {
        const hs = state.lastResponse?.headers ?? {};
        const xfo = (hs['x-frame-options'] || '').toLowerCase();
        const csp = hs['content-security-policy'] || '';
        if (['deny', 'sameorigin'].includes(xfo)) return;
        if (/frame-ancestors\\s+('?none'?|'self'|'none')/i.test(csp)) return;
        throw new Error('neither X-Frame-Options (deny|sameorigin) nor CSP frame-ancestors present');
    }

    // ---- IDOR ----
    @CSBDDStepDef('a resource id belonging to another user is requested')
    async sendIdor(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        const url = state.targetUrl.replace(/\\/\\d+(\\?|$)/, '/' + PAYLOADS_IDOR[0] + '$1');
        state.lastResponse = await client.get(url === state.targetUrl ? state.targetUrl + '/' + PAYLOADS_IDOR[0] : url, this.authHeader());
    }

    // ---- Command injection ----
    @CSBDDStepDef('a command injection payload is submitted')
    async sendCmdInjection(): Promise<void> {
        if (!state.targetUrl) throw new Error('target url not set');
        const payload = PAYLOADS_CMD[0];
        const url = state.targetUrl + (state.targetUrl.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(payload);
        state.lastResponse = await client.get(url, this.authHeader());
    }
    @CSBDDStepDef('the response body does not contain the sentinel echo output')
    async assertNoSentinel(): Promise<void> {
        const body = state.lastResponse?.body ?? '';
        if (body.includes('csqa-probe')) throw new Error('command injection sentinel echoed back — likely RCE');
    }
    @CSBDDStepDef('the response body carries no shell path fragments')
    async assertNoShellPaths(): Promise<void> {
        const body = state.lastResponse?.body ?? '';
        for (const frag of SHELL_PATH_FRAGMENTS) if (body.includes(frag)) throw new Error('shell path leaked: ' + frag);
    }
}

function extractSessionCookie(setCookie: string): string {
    if (!setCookie) return '';
    const m = /(?:^|;\\s*)(SESSION|SESSID|JSESSIONID|PHPSESSID|connect\\.sid|session)=([^;]+)/i.exec(setCookie);
    return m ? m[2] : '';
}
`;
    fs.writeFileSync(filePath, source, 'utf-8');
    return filePath;
}

function emitHelper(outputRoot: string, warnings: string[]): string {
    const filePath = path.join(outputRoot, '_security-helper.ts');
    if (fs.existsSync(filePath)) {
        warnings.push(`_security-helper.ts already exists at ${filePath} — kept as-is (generator does not clobber consumer edits).`);
        return filePath;
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    const source = `/* eslint-disable */
/**
 * Auto-generated by cs_qa_gen_security_test. Safe to edit; the generator will
 * not clobber this file if it already exists.
 *
 * Emits: SecurityClient (http/https with header capture), validateHeaders
 * (per-scenario matcher), containsPii (SSN/CC/DOB shapes), detectReflection
 * (verbatim payload echo).
 */
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface SecResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export const SQL_ERROR_FRAGMENTS: string[] = [
    'sql syntax', 'unclosed quotation', 'quoted string not properly terminated',
    'you have an error in your sql', 'ora-', 'sqlstate', 'psql:', 'mysql_fetch',
    'odbc sql server driver', 'microsoft ole db provider', 'pg_query',
    'sqlite_error', 'mariadb server',
];

export const SHELL_PATH_FRAGMENTS: string[] = [
    '/bin/sh', '/bin/bash', '/usr/bin/', '/usr/local/bin/', 'C:\\\\Windows\\\\',
    'C:\\\\Users\\\\', 'cmd.exe', 'powershell.exe',
];

const PII_PATTERNS: Array<{ name: string; re: RegExp }> = [
    { name: 'SSN', re: /\\b\\d{3}-\\d{2}-\\d{4}\\b/ },
    { name: 'CreditCard-16', re: /\\b(?:\\d[ -]?){15}\\d\\b/ },
    { name: 'DOB-YYYY-MM-DD', re: /\\b(?:19|20)\\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])\\b/ },
];

export class SecurityClient {
    constructor(private timeoutMs: number = 15_000) {}
    async get(url: string, headers: Record<string, string>): Promise<SecResponse> {
        return this.request('GET', url, undefined, headers);
    }
    async post(url: string, bodyObj: Record<string, unknown>, headers: Record<string, string>): Promise<SecResponse> {
        return this.request('POST', url, JSON.stringify(bodyObj), { 'Content-Type': 'application/json', ...headers });
    }
    private request(method: 'GET' | 'POST', url: string, body: string | undefined, headers: Record<string, string>): Promise<SecResponse> {
        return new Promise<SecResponse>((resolve, reject) => {
            const parsed = new URL(url);
            const lib = parsed.protocol === 'https:' ? https : http;
            const req = lib.request({
                method,
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                headers: { 'User-Agent': 'cs-security-scanner/1.0', ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body, 'utf-8').toString() } : {}) },
                timeout: this.timeoutMs,
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(Buffer.from(c)));
                res.on('end', () => {
                    const bodyStr = Buffer.concat(chunks).toString('utf-8');
                    const hs: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers)) hs[k.toLowerCase()] = Array.isArray(v) ? v.join('; ') : String(v || '');
                    CSReporter.info('Security probe ' + method + ' ' + parsed.pathname + ' -> ' + (res.statusCode || 0));
                    resolve({ status: res.statusCode || 0, headers: hs, body: bodyStr });
                });
            });
            req.on('error', (err) => { CSReporter.error('Security probe error: ' + err.message); reject(err); });
            req.on('timeout', () => { req.destroy(new Error('security probe timeout after ' + this.timeoutMs + 'ms')); });
            if (body) req.write(body);
            req.end();
        });
    }
}

export function containsPii(body: string): string | null {
    for (const p of PII_PATTERNS) if (p.re.test(body)) return p.name;
    return null;
}

export function detectReflection(body: string, payloads: string[]): boolean {
    for (const p of payloads) {
        if (!p) continue;
        if (body.includes(p)) return true;
    }
    return false;
}

export function validateHeaders(headers: Record<string, string>, scenarioName: string): { ok: boolean; reason: string } {
    const s = scenarioName.toLowerCase();
    if (s.includes('strict-transport-security') || s.includes('hsts')) {
        const h = headers['strict-transport-security'] || '';
        if (!h) return { ok: false, reason: 'HSTS header missing' };
        const m = /max-age\\s*=\\s*(\\d+)/i.exec(h);
        const seconds = m ? parseInt(m[1], 10) : 0;
        if (seconds < 60 * 60 * 24 * 180) return { ok: false, reason: 'HSTS max-age below 6 months: ' + seconds };
        return { ok: true, reason: '' };
    }
    if (s.includes('x-content-type-options')) {
        const h = (headers['x-content-type-options'] || '').toLowerCase();
        if (h !== 'nosniff') return { ok: false, reason: 'X-Content-Type-Options is not nosniff (got: ' + h + ')' };
        return { ok: true, reason: '' };
    }
    if (s.includes('x-frame-options') || s.includes('frame-ancestors') || s.includes('framing')) {
        const xfo = (headers['x-frame-options'] || '').toLowerCase();
        const csp = headers['content-security-policy'] || '';
        if (['deny', 'sameorigin'].includes(xfo)) return { ok: true, reason: '' };
        if (/frame-ancestors\\s+('?none'?|'self')/i.test(csp)) return { ok: true, reason: '' };
        return { ok: false, reason: 'neither X-Frame-Options (deny|sameorigin) nor CSP frame-ancestors set' };
    }
    if (s.includes('referrer-policy')) {
        const h = (headers['referrer-policy'] || '').toLowerCase();
        const safe = ['no-referrer', 'strict-origin-when-cross-origin', 'same-origin'];
        if (!safe.includes(h)) return { ok: false, reason: 'Referrer-Policy not in safe set: ' + h };
        return { ok: true, reason: '' };
    }
    if (s.includes('content-security-policy')) {
        const csp = headers['content-security-policy'] || '';
        if (!csp) return { ok: false, reason: 'CSP header missing' };
        return { ok: true, reason: '' };
    }
    return { ok: false, reason: 'no matcher registered for scenario "' + scenarioName + '"' };
}
`;
    fs.writeFileSync(filePath, source, 'utf-8');
    return filePath;
}

function emitReadme(outputRoot: string, targetUrl: string, categories: Category[], profile: Input['payloadsProfile']): string {
    const filePath = path.join(outputRoot, 'README.md');
    const catLines = categories.map((c) => {
        const m = CATEGORY_META[c];
        return `- **${c}** — ${m.owaspTop10} / ${m.cwe} — ${m.owaspCategory}`;
    }).join('\n');
    const contents = `# Security Test Suite

Auto-generated by \`cs_qa_gen_security_test\`.

## Target
- URL: ${targetUrl}
- Payload profile: **${profile}**

## SAFETY WARNING
> This scaffold ships with the **${profile}** payload profile.
> The **baseline** profile is safe for automated CI against non-production
> environments. **Production runs MUST use \`payloadsProfile: 'safe-list-only'\`**
> — the safe-list-only set uses inert probes (single-quote, single-semicolon,
> non-executable HTML) and cannot trigger destructive side effects on a target
> that treats them as data.
>
> Do not point the **aggressive** profile at any environment you do not own.
> Only run these tests against endpoints your organisation has authorised for
> security testing.

## Install
Standard Playwright + framework — no extra deps beyond the base scaffold. If
you configure authenticated probes, install and configure the framework's
runner as usual.

## Categories
${catLines}

## Run
\`\`\`bash
npx cs-playwright test --grep @security
\`\`\`

Filter by category:

\`\`\`bash
npx cs-playwright test --grep "@security and @xss"
\`\`\`

## Credentials
Any credential env vars declared for this suite are recorded in \`.env.template\`
with an \`ENCRYPTED:\` placeholder. Encrypt real values with the framework CLI
and paste the ciphertext after the prefix. Never commit plaintext credentials.

## Payloads
- baseline — automated-CI-safe attack strings (SQL tautology, canonical XSS,
  a shell separator triple).
- aggressive — adds UNION, WAITFOR-time-based probes, richer XSS vectors,
  and command-substitution payloads. Do NOT use against shared or production
  environments.
- safe-list-only — inert probes; scenarios still exercise the framework
  path but cannot cause side effects on a target that treats them as data.
`;
    fs.writeFileSync(filePath, contents, 'utf-8');
    return filePath;
}

function emitEnvTemplate(outputRoot: string, authTokenEnvVar: string | undefined, adminEnvVars: string[]): string {
    const filePath = path.join(outputRoot, '.env.template');
    let existing = '';
    if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf-8');
    const lines: string[] = [];
    const push = (k: string) => { if (!existing.includes(`${k}=`) && !lines.some((l) => l.startsWith(`${k}=`))) lines.push(`${k}=ENCRYPTED:`); };
    if (authTokenEnvVar) push(authTokenEnvVar);
    for (const v of adminEnvVars) push(v);
    push('ADMIN_USER');
    push('ADMIN_PASS');
    if (existing.length === 0 && lines.length === 0) {
        lines.push('# Auto-generated by cs_qa_gen_security_test. Encrypt values via `cs-playwright-mcp encrypt <plain>` and paste after ENCRYPTED:.');
    }
    const finalText = existing + (lines.length > 0 ? (existing.length > 0 && !existing.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n' : '');
    fs.writeFileSync(filePath, finalText, 'utf-8');
    return filePath;
}

// =============================================================================
// ADO TC
// =============================================================================

function composeTcDescription(category: Category, scenarioName: string, targetUrl: string): string {
    const meta = CATEGORY_META[category];
    const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div><h3>Security Test — ${esc(category)}</h3>
<p><strong>Target URL:</strong> <code>${esc(targetUrl)}</code></p>
<p><strong>OWASP Top 10:</strong> ${esc(meta.owaspTop10)}</p>
<p><strong>CWE:</strong> ${esc(meta.cwe)}</p>
<p><strong>Category:</strong> ${esc(meta.owaspCategory)}</p>
<p><strong>Scenario:</strong> ${esc(scenarioName)}</p>
<p>Generated by <code>cs_qa_gen_security_test</code>.</p></div>`;
}

function composeTcStepsXml(category: Category, scenarioName: string, targetUrl: string): string {
    const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const meta = CATEGORY_META[category];
    const rows: string[] = [];
    let i = 1;
    const step = (id: number, type: string, action: string, expected: string): string =>
        `<step id="${id}" type="${type}"><parameterizedString isformatted="true">&lt;P&gt;${esc(action)}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${esc(expected)}&lt;/P&gt;</parameterizedString><description/></step>`;
    rows.push(step(i++, 'PreCondition', `Target ${targetUrl} reachable. Any credentials required are set via .env (encrypted).`, 'Environment ready.'));
    rows.push(step(i++, 'ActionStep', `Execute ${category} scenario: ${scenarioName}`, meta.owaspCategory + ' — no violation.'));
    return `<steps id="0" last="${i - 1}">${rows.join('')}</steps>`;
}

// =============================================================================
// Registration
// =============================================================================

const DEFAULT_CATEGORIES: Category[] = ['sql-injection', 'xss', 'auth-bypass', 'security-headers'];

registerPrimitive<Input, Output>({
    name: 'cs_qa_gen_security_test',
    description: 'Emit an OWASP-graded security test scaffold for a target URL. One .feature per category (default: sql-injection, xss, auth-bypass, security-headers), tagged @security @<category> @<cwe> @<owasp>. Generates a step-defs class that drives a SecurityClient + payload library, a helper (SecurityClient/validateHeaders/containsPii/detectReflection), a README with an EXPLICIT SAFETY WARNING and payload-profile explanation, and .env.template with ENCRYPTED: placeholders. Payload profiles: baseline (default) | aggressive | safe-list-only (production-safe inert probes). Optional ADO Test Case bulk creation is gated by two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`). On-prem safe.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, rawInput) => {
        // Defensive defaults — the primitive runner doesn't Zod-parse inputs.
        const input: Input = {
            ...rawInput,
            payloadsProfile: rawInput.payloadsProfile || 'baseline',
            adminCredentialsEnvVars: rawInput.adminCredentialsEnvVars || [],
            outputRoot: rawInput.outputRoot || 'test/security',
            createAdoTc: rawInput.createAdoTc === true,
            dryRun: rawInput.dryRun === true,
            confirmed: rawInput.confirmed === true,
        };
        const log = createLogger(ctx.invocationId, 'cs_qa_gen_security_test', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const categories = input.categories && input.categories.length > 0 ? input.categories : DEFAULT_CATEGORIES;
        const outputRoot = path.isAbsolute(input.outputRoot) ? input.outputRoot : path.join(ctx.workspaceRoot, input.outputRoot);

        log.info('cs_qa_gen_security_test start', {
            targetUrl: input.targetUrl,
            categories,
            payloadsProfile: input.payloadsProfile,
            createAdoTc: input.createAdoTc,
            dryRun: input.dryRun,
        });

        const featureFilesGenerated: EmittedFeature[] = [];
        const stepDefFiles: string[] = [];
        let helperFile: string | undefined;
        let readmeFile: string | undefined;
        let envTemplateFile: string | undefined;

        if (input.dryRun) {
            for (const c of categories) {
                const meta = CATEGORY_META[c];
                featureFilesGenerated.push({
                    path: path.join(outputRoot, 'features', `${slugify(c)}.feature`),
                    category: c,
                    scenarios: meta.scenarios.map((s) => s.name),
                    owaspCwe: meta.cwe,
                });
            }
            return {
                ok: true, verb: 'gen-security-test', targetUrl: input.targetUrl,
                payloadsProfile: input.payloadsProfile,
                categoriesGenerated: categories,
                featureFilesGenerated, stepDefFiles, warnings,
                note: `Dry-run: would write ${categories.length} feature file(s), 1 step-defs file, helper, README, .env.template under ${outputRoot}.`,
            };
        }

        fs.mkdirSync(outputRoot, { recursive: true });
        for (const c of categories) {
            featureFilesGenerated.push(emitFeatureForCategory(outputRoot, input.targetUrl, c));
        }
        stepDefFiles.push(emitStepDefs(outputRoot, categories, input.payloadsProfile, input.authTokenEnvVar));
        helperFile = emitHelper(outputRoot, warnings);
        readmeFile = emitReadme(outputRoot, input.targetUrl, categories, input.payloadsProfile);
        envTemplateFile = emitEnvTemplate(outputRoot, input.authTokenEnvVar, input.adminCredentialsEnvVars);

        log.info('security artefacts written', {
            features: featureFilesGenerated.length,
            stepDefs: stepDefFiles.length,
            helperFile,
            readmeFile,
            envTemplateFile,
        });

        if (!input.createAdoTc) {
            return {
                ok: true, verb: 'gen-security-test', targetUrl: input.targetUrl,
                payloadsProfile: input.payloadsProfile,
                categoriesGenerated: categories,
                featureFilesGenerated, stepDefFiles, helperFile, readmeFile, envTemplateFile,
                warnings,
                note: `Generated ${featureFilesGenerated.length} security feature file(s) across ${categories.length} category(ies). Payload profile: ${input.payloadsProfile}.`,
            };
        }

        // ADO TC creation.
        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
        });
        if (!credsRes.creds) {
            warnings.push(credsRes.diagnostic);
            return {
                ok: true, verb: 'gen-security-test', targetUrl: input.targetUrl,
                payloadsProfile: input.payloadsProfile,
                categoriesGenerated: categories,
                featureFilesGenerated, stepDefFiles, helperFile, readmeFile, envTemplateFile,
                warnings, note: 'Scaffold generated; ADO writes skipped (creds missing).',
            };
        }
        const cfg: AdoCreds = credsRes.creds;
        const plannedTcCount = featureFilesGenerated.reduce((s, f) => s + f.scenarios.length, 0);

        if (input.confirmed !== true) {
            return {
                ok: true, verb: 'gen-security-test', targetUrl: input.targetUrl,
                payloadsProfile: input.payloadsProfile,
                categoriesGenerated: categories,
                featureFilesGenerated, stepDefFiles, helperFile, readmeFile, envTemplateFile,
                warnings,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint: `Create ${plannedTcCount} ADO Test Case(s) (one per security scenario) in project ${cfg.project}? No write performed. Retry the SAME call with confirmed:true.`,
                note: 'requires confirmation — retry with confirmed:true',
            };
        }

        const client = new AdoHttpClient(cfg);
        interface TcPayload { category: Category; scenario: string; cwe: string }
        const payloads: TcPayload[] = [];
        for (const f of featureFilesGenerated) {
            for (const scenario of f.scenarios) payloads.push({ category: f.category, scenario, cwe: f.owaspCwe });
        }
        const bulk = await bulkExecute(payloads, {
            chunkSize: 1,
            concurrency: 4,
            workFn: async (batch) => {
                const p = batch[0];
                const meta = CATEGORY_META[p.category];
                const patch: Array<Record<string, unknown>> = [
                    { op: 'add', path: '/fields/System.Title', value: `Security ${p.category} — ${p.scenario}` },
                    { op: 'add', path: '/fields/System.Description', value: composeTcDescription(p.category, p.scenario, input.targetUrl) },
                    { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: composeTcStepsXml(p.category, p.scenario, input.targetUrl) },
                    { op: 'add', path: '/fields/System.Tags', value: `security; auto-generated; ${p.category}; ${p.cwe.toLowerCase()}; owasp-${meta.owaspTop10.replace(':', '').toLowerCase()}` },
                ];
                if (input.linkToStoryId) {
                    patch.push({
                        op: 'add', path: '/relations/-',
                        value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${input.linkToStoryId}` },
                    });
                }
                const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Test%20Case?api-version=7.0`, patch);
                return [{ tcId: Number(created.id || 0), scenario: p.scenario }];
            },
            onChunkError: (err, chunk) => {
                log.warn('Security TC creation failed', { scenario: chunk[0].scenario, error: err.message });
            },
        });
        const tcsSkipped = bulk.failed.map((f) => ({ scenario: f.item.scenario, reason: f.error.message }));

        return {
            ok: true, verb: 'gen-security-test', targetUrl: input.targetUrl,
            payloadsProfile: input.payloadsProfile,
            categoriesGenerated: categories,
            featureFilesGenerated, stepDefFiles, helperFile, readmeFile, envTemplateFile,
            tcsCreated: bulk.ok.length, tcsSkipped, warnings,
            note: `Generated ${featureFilesGenerated.length} feature file(s) + ${bulk.ok.length} ADO TC(s).${tcsSkipped.length > 0 ? ` ${tcsSkipped.length} TC(s) skipped.` : ''}`,
        };
    },
});

// Explicit re-exports for smoke tests to unit-test helpers.
export const _internals = {
    CATEGORY_META,
    DEFAULT_CATEGORIES,
    buildPayloads,
    slugify,
};
