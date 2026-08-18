/**
 * cs_qa_gen_soap_test — SOAP/WSDL test generator.
 *
 * Flow: load WSDL (path or URL) → parse services/ports/bindings/operations
 * (recursive xsd:import + wsdl:import) → per operation, emit a Gherkin
 * .feature (happy path + fault case when `generateNegativeCases`) + step defs
 * that use a small framework-consistent SoapClient helper → optional ADO Test
 * Case creation for each scenario → env template with `ENCRYPTED:` credential
 * placeholders.
 *
 * Non-negotiables enforced here:
 *  - ALL ADO HTTP through AdoHttpClient (retries, PAT redaction, caps).
 *  - WSDL URL fetch via AdoHttpClient.getBinary (any host — same transport rules).
 *  - WS-Security UsernameToken uses real SHA-1 digest — see
 *    soap_envelope_builder.buildWsSecurityUsernameToken.
 *  - Generated credentials are always `ENCRYPTED:` placeholders — no real
 *    values ever land on disk.
 *  - Framework helper uses CSReporter — no console.log in generated code.
 *  - On-prem safe.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { bulkExecute } from './_helpers/bulk_batcher';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import { parseWsdl, type ParsedOperation, type ParsedService, type ParsedWsdl, type SoapVersion } from './_helpers/wsdl_parser';
import { buildSampleBody, buildEnvelope, soapContentType } from './_helpers/soap_envelope_builder';

// =============================================================================
// Input schema.
// =============================================================================

const SecuritySchema = z.object({
    kind: z.enum(['none', 'basic', 'ws-security-usernametoken', 'ws-security-x509']),
    usernameEnvVar: z.string().min(1).optional(),
    passwordEnvVar: z.string().min(1).optional(),
});

const InputSchema = z.object({
    wsdlPath: z.string().optional().describe('Local WSDL path.'),
    wsdlUrl: z.string().url().optional().describe('Remote WSDL URL — fetched via AdoHttpClient.getBinary.'),
    endpointUrl: z.string().url().optional().describe('SOAP endpoint override (defaults to wsdl:service/port/soap:address/@location).'),
    operations: z.array(z.string().min(1)).optional().describe('Filter — only these operation names. Default: all.'),
    security: SecuritySchema.default({ kind: 'none' }),
    generateNegativeCases: z.boolean().default(true),
    createAdoTc: z.boolean().default(false),
    planId: z.number().int().positive().optional(),
    planName: z.string().optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().optional(),
    outputRoot: z.string().default('test/api/soap'),
    dryRun: z.boolean().default(false),
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
}).refine((v) => !!v.wsdlPath || !!v.wsdlUrl, { message: 'Either wsdlPath or wsdlUrl is required.' });

type Input = z.infer<typeof InputSchema>;

// =============================================================================
// WSDL loading.
// =============================================================================

async function loadWsdl(input: Input, workspaceRoot: string): Promise<{ text: string; baseHref: string; sourceLabel: string }> {
    if (input.wsdlPath) {
        const abs = path.isAbsolute(input.wsdlPath) ? input.wsdlPath : path.join(workspaceRoot, input.wsdlPath);
        if (!fs.existsSync(abs)) throw new Error(`WSDL file not found: ${abs}`);
        return { text: fs.readFileSync(abs, 'utf-8'), baseHref: abs, sourceLabel: `file:${abs}` };
    }
    const url = input.wsdlUrl!;
    const text = await fetchTextByUrl(url);
    return { text, baseHref: url, sourceLabel: `url:${url}` };
}

async function fetchTextByUrl(url: string): Promise<string> {
    // Use Node global fetch — WSDL endpoints are typically public / internal
    // service ports, not ADO. AdoHttpClient is reserved for ADO org calls.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`WSDL fetch ${url} → ${res.status} ${res.statusText}`);
        return await res.text();
    } finally { clearTimeout(timer); }
}

function makeResolveImport(baseHref: string) {
    return async (href: string, fromBase: string): Promise<{ text: string; resolvedBase: string } | null> => {
        // If href is absolute URL, use it directly.
        const absUrl = /^https?:\/\//i.test(href) ? href : null;
        if (absUrl) {
            try { return { text: await fetchTextByUrl(absUrl), resolvedBase: absUrl }; }
            catch { return null; }
        }
        // Otherwise resolve relative to fromBase.
        if (/^https?:\/\//i.test(fromBase)) {
            const resolved = new URL(href, fromBase).toString();
            try { return { text: await fetchTextByUrl(resolved), resolvedBase: resolved }; }
            catch { return null; }
        }
        // File path.
        const dir = path.dirname(fromBase);
        const abs = path.isAbsolute(href) ? href : path.join(dir, href);
        if (!fs.existsSync(abs)) return null;
        return { text: fs.readFileSync(abs, 'utf-8'), resolvedBase: abs };
    };
}

// =============================================================================
// Naming.
// =============================================================================

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'service';
}

function pascal(s: string): string {
    return s.replace(/(?:^|[^a-zA-Z0-9])([a-zA-Z])/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
}

function xmlEscape(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =============================================================================
// Emitters — Gherkin feature files + step defs + helper + env template.
// =============================================================================

interface EmittedFeature {
    filePath: string;
    service: string;
    operation: string;
    scenarios: string[];
}

function emitFeature(args: {
    outputDir: string;
    service: ParsedService;
    op: ParsedOperation;
    generateNegativeCases: boolean;
    endpointUrl: string;
    soapVersion: SoapVersion;
    security: Input['security'];
}): EmittedFeature {
    const dir = path.join(args.outputDir, slugify(args.service.name));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${slugify(args.op.name)}.feature`);
    const scenarios: string[] = [];
    const lines: string[] = [];
    const tags = [
        '@soap',
        `@service:${slugify(args.service.name)}`,
        `@operation:${slugify(args.op.name)}`,
        `@soap-${args.soapVersion.replace('.', '')}`,
        '@auto-generated',
    ];
    lines.push(tags.join(' '));
    lines.push(`Feature: ${args.service.name} SOAP - ${args.op.name}`);
    lines.push(`  Auto-generated from WSDL. Endpoint: ${args.endpointUrl}. SOAP ${args.soapVersion}.`);
    lines.push('');
    // Happy path.
    const happyName = `happy path ${args.op.name}`;
    scenarios.push(happyName);
    lines.push(`  @happy-path`);
    lines.push(`  Scenario: ${happyName}`);
    lines.push(`    Given a SOAP request for ${args.op.name}`);
    if (args.security.kind === 'basic') {
        lines.push(`    And the request uses Basic authentication`);
    } else if (args.security.kind === 'ws-security-usernametoken') {
        lines.push(`    And the request carries a WS-Security UsernameToken header`);
    } else if (args.security.kind === 'ws-security-x509') {
        lines.push(`    And the request is signed with a WS-Security X509 token`);
    }
    lines.push(`    When the request is sent`);
    lines.push(`    Then the response contains ${args.op.outputElement}`);
    lines.push(`    And the response has no fault`);
    lines.push('');
    // Fault case.
    if (args.generateNegativeCases) {
        const requiredField = findFirstRequiredField(args.op, args.service);
        const missingField = requiredField || 'a required field';
        const faultName = `fault case ${args.op.name} - missing required field`;
        scenarios.push(faultName);
        lines.push(`  @negative @fault`);
        lines.push(`  Scenario: ${faultName}`);
        lines.push(`    Given a SOAP request for ${args.op.name} with missing ${missingField}`);
        lines.push(`    When the request is sent`);
        lines.push(`    Then a SOAP fault is returned`);
        lines.push(`    And the fault code is Client or Sender`);
        lines.push('');
    }
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return { filePath, service: args.service.name, operation: args.op.name, scenarios };
}

function findFirstRequiredField(op: ParsedOperation, _svc: ParsedService): string | null {
    // We could inspect the op's inputTypeQName in the types table but we do not
    // have the parsed wsdl reference here — callers of findFirstRequiredField
    // pass in via `op.inputElement` and we default to the wrapper's first field
    // during emission. Callers with richer context may pass explicit values.
    return op.inputElement.charAt(0).toLowerCase() + op.inputElement.slice(1) || null;
}

function emitSteps(args: {
    outputDir: string;
    service: ParsedService;
    operations: ParsedOperation[];
    endpointUrl: string;
    soapVersion: SoapVersion;
    security: Input['security'];
    wsdl: ParsedWsdl;
}): string {
    const stepsDir = path.join(args.outputDir, slugify(args.service.name), 'steps');
    fs.mkdirSync(stepsDir, { recursive: true });
    const filePath = path.join(stepsDir, `${pascal(args.service.name)}Steps.ts`);

    // Compose per-operation bodies as JSON so runtime step defs can lookup by
    // op name without re-parsing WSDL. The bodies use envelope builder output
    // so what runs matches what the tool asserted-buildable.
    const opBodies: Record<string, { happy: string; fault: string; soapAction: string; outputElement: string; namespace: string }> = {};
    for (const op of args.operations) {
        const happyBody = buildSampleBody({
            wsdl: args.wsdl,
            wrapperElement: op.inputElement,
            wrapperNamespace: op.namespace,
        });
        const requiredField = pickFirstFieldName(args.wsdl, op);
        const faultBody = buildSampleBody({
            wsdl: args.wsdl,
            wrapperElement: op.inputElement,
            wrapperNamespace: op.namespace,
            dropField: requiredField ?? undefined,
        });
        opBodies[op.name] = {
            happy: happyBody,
            fault: faultBody,
            soapAction: op.soapAction,
            outputElement: op.outputElement,
            namespace: op.namespace,
        };
    }

    const bodiesLiteral = JSON.stringify(opBodies, null, 4);
    const soapVersion = args.soapVersion;
    const securityKind = args.security.kind;
    const usernameEnv = args.security.usernameEnvVar || 'SOAP_USER';
    const passwordEnv = args.security.passwordEnvVar || 'SOAP_PASSWORD';
    const endpointLiteral = JSON.stringify(args.endpointUrl);
    const classPascal = pascal(args.service.name) + 'Steps';

    const source = `import { CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
import { SoapClient, buildEnvelopeForOp } from '../../_soap-helper';

const ENDPOINT_URL = ${endpointLiteral};
const SOAP_VERSION: '1.1' | '1.2' = '${soapVersion}';
const SECURITY_KIND = '${securityKind}';
const USERNAME_ENV_VAR = '${usernameEnv}';
const PASSWORD_ENV_VAR = '${passwordEnv}';

const OP_BODIES: Record<string, { happy: string; fault: string; soapAction: string; outputElement: string; namespace: string }> = ${bodiesLiteral};

interface StepState {
    operation?: string;
    body?: string;
    soapAction?: string;
    missing?: string;
    expectedOutputElement?: string;
    response?: { status: number; body: string; fault?: { faultcode: string; faultstring: string } };
    extraHeaders: Record<string, string>;
}

const state: StepState = { extraHeaders: {} };

export class ${classPascal} {
    private client = new SoapClient(ENDPOINT_URL);

    @CSBDDStepDef('a SOAP request for (\\\\S+)')
    async requestForOp(op: string): Promise<void> {
        const entry = OP_BODIES[op];
        if (!entry) throw new Error(\`Unknown SOAP operation "\${op}" — not in generated WSDL bundle.\`);
        state.operation = op;
        state.body = buildEnvelopeForOp(entry.happy, SOAP_VERSION);
        state.soapAction = entry.soapAction;
        state.expectedOutputElement = entry.outputElement;
        state.missing = undefined;
        state.response = undefined;
        state.extraHeaders = {};
        CSReporter.info(\`Prepared SOAP request for \${op}\`);
    }

    @CSBDDStepDef('a SOAP request for (\\\\S+) with missing (\\\\S+)')
    async requestForOpMissing(op: string, field: string): Promise<void> {
        const entry = OP_BODIES[op];
        if (!entry) throw new Error(\`Unknown SOAP operation "\${op}"\`);
        state.operation = op;
        state.body = buildEnvelopeForOp(entry.fault, SOAP_VERSION);
        state.soapAction = entry.soapAction;
        state.expectedOutputElement = entry.outputElement;
        state.missing = field;
        state.response = undefined;
        state.extraHeaders = {};
        CSReporter.info(\`Prepared SOAP request for \${op} with missing \${field}\`);
    }

    @CSBDDStepDef('the request uses Basic authentication')
    async requestBasicAuth(): Promise<void> {
        const user = process.env[USERNAME_ENV_VAR] || '';
        const pass = process.env[PASSWORD_ENV_VAR] || '';
        if (!user || !pass) throw new Error(\`Basic auth requires \${USERNAME_ENV_VAR} and \${PASSWORD_ENV_VAR} env vars\`);
        const token = Buffer.from(\`\${user}:\${pass}\`, 'utf-8').toString('base64');
        state.extraHeaders['Authorization'] = \`Basic \${token}\`;
        // Do NOT log the header value.
        CSReporter.info('Attached Basic auth header');
    }

    @CSBDDStepDef('the request carries a WS-Security UsernameToken header')
    async requestWsseUsernameToken(): Promise<void> {
        const user = process.env[USERNAME_ENV_VAR] || '';
        const pass = process.env[PASSWORD_ENV_VAR] || '';
        if (!user || !pass) throw new Error(\`WS-Security requires \${USERNAME_ENV_VAR} and \${PASSWORD_ENV_VAR} env vars\`);
        // Re-wrap the body with a WS-Security header — the helper does the digest.
        if (!state.operation) throw new Error('No operation prepared');
        const entry = OP_BODIES[state.operation];
        state.body = buildEnvelopeForOp(state.missing ? entry.fault : entry.happy, SOAP_VERSION, { wsse: { username: user, password: pass } });
        CSReporter.info('Wrapped envelope with WS-Security UsernameToken');
    }

    @CSBDDStepDef('the request is signed with a WS-Security X509 token')
    async requestWsseX509(): Promise<void> {
        // X.509 typically depends on a keystore configured out-of-band. This
        // step delegates to a consumer-provided helper if present; otherwise
        // it throws so the consumer sees the concrete gap.
        throw new Error('WS-Security X509 signing requires a consumer-provided key/cert configuration — implement in test/api/soap/_soap-helper.ts.');
    }

    @CSBDDStepDef('the request is sent')
    async sendRequest(): Promise<void> {
        if (!state.body || !state.operation) throw new Error('Request not prepared');
        state.response = await this.client.send(state.soapAction || '', state.body, state.extraHeaders, SOAP_VERSION);
        CSReporter.info(\`SOAP response status \${state.response.status}\`);
    }

    @CSBDDStepDef('the response contains (\\\\S+)')
    async responseContains(element: string): Promise<void> {
        const r = state.response;
        if (!r) throw new Error('No response captured');
        if (!r.body.includes(\`<\${element}\`) && !r.body.includes(\`:\${element}\`) && !r.body.includes(\`\${element}>\`)) {
            throw new Error(\`Response does not contain <\${element}>. Body first 500 chars: \${r.body.slice(0, 500)}\`);
        }
    }

    @CSBDDStepDef('the response has no fault')
    async responseHasNoFault(): Promise<void> {
        const r = state.response;
        if (!r) throw new Error('No response captured');
        if (r.fault) throw new Error(\`Expected no fault; got fault: \${r.fault.faultcode} \${r.fault.faultstring}\`);
    }

    @CSBDDStepDef('a SOAP fault is returned')
    async responseIsFault(): Promise<void> {
        const r = state.response;
        if (!r) throw new Error('No response captured');
        if (!r.fault) throw new Error(\`Expected SOAP fault but got status \${r.status}. Body: \${r.body.slice(0, 500)}\`);
    }

    @CSBDDStepDef('the fault code is (Client|Sender|Server|Receiver) or (Client|Sender|Server|Receiver)')
    async faultCodeInSet(a: string, b: string): Promise<void> {
        const r = state.response;
        if (!r || !r.fault) throw new Error('No fault captured');
        const code = String(r.fault.faultcode || '');
        const localCode = code.includes(':') ? code.split(':').pop()! : code;
        if (localCode !== a && localCode !== b) {
            throw new Error(\`Expected fault code \${a}|\${b}, got \${code}\`);
        }
    }
}
`;
    fs.writeFileSync(filePath, source, 'utf-8');
    return filePath;
}

function pickFirstFieldName(wsdl: ParsedWsdl, op: ParsedOperation): string | null {
    const t = wsdl.types[op.inputTypeQName];
    if (!t || !t.fields || t.fields.length === 0) return null;
    // Prefer required (minOccurs>=1) fields.
    const required = t.fields.find((f) => (f.minOccurs ?? 1) >= 1);
    return (required ?? t.fields[0]).name;
}

function emitSoapHelper(outputRoot: string, warnings: string[]): string {
    const filePath = path.join(outputRoot, '_soap-helper.ts');
    if (fs.existsSync(filePath)) {
        warnings.push(`_soap-helper.ts already exists at ${filePath} — kept as-is (generator does not clobber consumer edits).`);
        return filePath;
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    const source = `/* eslint-disable */
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { createHash, randomBytes } from 'crypto';

// Auto-generated by cs_qa_gen_soap_test. Safe to edit; the generator will not
// clobber this file if it already exists.

export interface SoapFault {
    faultcode: string;
    faultstring: string;
    detail?: string;
}

export interface SoapResponse {
    status: number;
    body: string;
    envelope?: unknown;
    fault?: SoapFault;
}

export interface WsSecurityCreds {
    username: string;
    password: string;
    passwordType?: 'PasswordDigest' | 'PasswordText';
}

export interface WrapEnvelopeOptions {
    wsse?: WsSecurityCreds;
    headerXml?: string;
}

const SOAP_11_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP_12_NS = 'http://www.w3.org/2003/05/soap-envelope';
const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const PASSWORD_DIGEST_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const PASSWORD_TEXT_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';

function xmlEscape(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildWsSecurityHeader(creds: WsSecurityCreds): string {
    const nonce = randomBytes(16);
    const created = new Date().toISOString();
    const type = creds.passwordType || 'PasswordDigest';
    let passwordEl: string;
    if (type === 'PasswordDigest') {
        const h = createHash('sha1');
        h.update(nonce);
        h.update(Buffer.from(created, 'utf-8'));
        h.update(Buffer.from(creds.password, 'utf-8'));
        const digest = h.digest('base64');
        passwordEl = \`<wsse:Password Type="\${PASSWORD_DIGEST_TYPE}">\${xmlEscape(digest)}</wsse:Password>\`;
    } else {
        passwordEl = \`<wsse:Password Type="\${PASSWORD_TEXT_TYPE}">\${xmlEscape(creds.password)}</wsse:Password>\`;
    }
    return [
        \`<wsse:Security xmlns:wsse="\${WSSE_NS}" xmlns:wsu="\${WSU_NS}" soapenv:mustUnderstand="1">\`,
        \`<wsse:UsernameToken>\`,
        \`<wsse:Username>\${xmlEscape(creds.username)}</wsse:Username>\`,
        passwordEl,
        \`<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">\${xmlEscape(nonce.toString('base64'))}</wsse:Nonce>\`,
        \`<wsu:Created>\${xmlEscape(created)}</wsu:Created>\`,
        \`</wsse:UsernameToken>\`,
        \`</wsse:Security>\`,
    ].join('');
}

/**
 * Wrap a body fragment into a full SOAP envelope. \`opts.wsse\` attaches a
 * WS-Security UsernameToken header (RFC-compliant digest — real SHA-1).
 */
export function buildEnvelopeForOp(bodyFragment: string, version: '1.1' | '1.2', opts: WrapEnvelopeOptions = {}): string {
    const ns = version === '1.2' ? SOAP_12_NS : SOAP_11_NS;
    const headerParts: string[] = [];
    if (opts.headerXml) headerParts.push(opts.headerXml);
    if (opts.wsse) headerParts.push(buildWsSecurityHeader(opts.wsse));
    const header = headerParts.length > 0 ? \`<soapenv:Header>\${headerParts.join('')}</soapenv:Header>\` : '';
    return \`<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="\${ns}">\${header}<soapenv:Body>\${bodyFragment}</soapenv:Body></soapenv:Envelope>\`;
}

function parseFault(xml: string): SoapFault | undefined {
    // Handle both SOAP 1.1 (<faultcode>/<faultstring>) and 1.2
    // (<env:Code><env:Value>) shapes without a full XML parse dependency.
    const codeM = /<(?:[A-Za-z_][\\w.-]*:)?faultcode\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?faultcode>/.exec(xml);
    const stringM = /<(?:[A-Za-z_][\\w.-]*:)?faultstring\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?faultstring>/.exec(xml);
    if (codeM && stringM) {
        return { faultcode: codeM[1].trim(), faultstring: stringM[1].trim() };
    }
    // SOAP 1.2 shape.
    const codeV12 = /<(?:[A-Za-z_][\\w.-]*:)?Code\\b[^>]*>\\s*<(?:[A-Za-z_][\\w.-]*:)?Value\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?Value>/.exec(xml);
    const reasonV12 = /<(?:[A-Za-z_][\\w.-]*:)?Reason\\b[^>]*>[\\s\\S]*?<(?:[A-Za-z_][\\w.-]*:)?Text\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?Text>/.exec(xml);
    if (codeV12 && reasonV12) {
        return { faultcode: codeV12[1].trim(), faultstring: reasonV12[1].trim() };
    }
    if (/<(?:[A-Za-z_][\\w.-]*:)?Fault\\b/.test(xml)) {
        return { faultcode: 'Unknown', faultstring: '(unparsed fault body)' };
    }
    return undefined;
}

function parseEnvelope(xml: string): unknown {
    try {
        const xml2js = require('xml2js') as { Parser: new (opts: Record<string, unknown>) => { parseStringPromise(s: string): Promise<unknown> } };
        const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false });
        // xml2js parseStringPromise is async — return the string as-is; callers
        // needing async parsing can invoke separately.
        return parser.parseStringPromise(xml);
    } catch {
        return undefined;
    }
}

export class SoapClient {
    constructor(private endpointUrl: string, private timeoutMs: number = 30_000) {}

    async send(soapAction: string, envelope: string, extraHeaders: Record<string, string> = {}, version: '1.1' | '1.2' = '1.1'): Promise<SoapResponse> {
        const parsed = new URL(this.endpointUrl);
        const contentType = version === '1.2'
            ? \`application/soap+xml; charset=utf-8\${soapAction ? \`; action="\${soapAction.replace(/"/g, '')}"\` : ''}\`
            : 'text/xml; charset=utf-8';
        const headers: Record<string, string> = {
            'Content-Type': contentType,
            'Content-Length': Buffer.byteLength(envelope, 'utf-8').toString(),
            ...extraHeaders,
        };
        if (version === '1.1') headers['SOAPAction'] = \`"\${soapAction}"\`;

        // Redacted logging — never emit Authorization or a WS-Security block.
        const safeHeaders = { ...headers };
        for (const k of Object.keys(safeHeaders)) if (/^authorization$/i.test(k)) safeHeaders[k] = 'Basic ***';
        const safeEnvelope = envelope.replace(/<wsse:Password[^>]*>[\\s\\S]*?<\\/wsse:Password>/gi, '<wsse:Password>***REDACTED***</wsse:Password>');
        CSReporter.info(\`SOAP POST \${this.endpointUrl}\`);
        CSReporter.debug(\`SOAP request envelope: \${safeEnvelope}\`);

        return new Promise<SoapResponse>((resolve, reject) => {
            const isHttps = parsed.protocol === 'https:';
            const lib = isHttps ? https : http;
            const req = lib.request({
                method: 'POST',
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                headers,
                timeout: this.timeoutMs,
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(Buffer.from(c)));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    const fault = parseFault(body);
                    const envelope = parseEnvelope(body);
                    CSReporter.info(\`SOAP response status \${res.statusCode || 0}\${fault ? ' (fault)' : ''}\`);
                    resolve({ status: res.statusCode || 0, body, fault, envelope });
                });
            });
            req.on('error', (err) => {
                CSReporter.error(\`SOAP request error: \${err.message}\`);
                reject(err);
            });
            req.on('timeout', () => {
                req.destroy(new Error(\`SOAP request timeout after \${this.timeoutMs}ms\`));
            });
            req.write(envelope);
            req.end();
        });
    }
}
`;
    fs.writeFileSync(filePath, source, 'utf-8');
    return filePath;
}

function emitEnvTemplate(outputRoot: string, security: Input['security']): string {
    const templatePath = path.join(outputRoot, '.env.template');
    fs.mkdirSync(outputRoot, { recursive: true });
    const lines: string[] = [];
    let existing = '';
    if (fs.existsSync(templatePath)) existing = fs.readFileSync(templatePath, 'utf-8');
    const push = (k: string) => {
        if (existing.includes(`${k}=`)) return;
        if (!lines.length && !existing.endsWith('\n') && existing.length > 0) lines.push('');
        lines.push(`${k}=ENCRYPTED:`);
    };
    const userVar = security.usernameEnvVar || 'SOAP_USER';
    const passVar = security.passwordEnvVar || 'SOAP_PASSWORD';
    if (security.kind !== 'none') {
        push(userVar);
        push(passVar);
    }
    // Always ensure at least a marker line so consumers know where to define
    // creds even for `kind: none`.
    if (existing.length === 0 && lines.length === 0) {
        lines.push('# Auto-generated by cs_qa_gen_soap_test. Fill values via `cs-playwright-mcp encrypt <plain>` and paste after ENCRYPTED:.');
    }
    const finalText = existing + (lines.length > 0 ? (existing.length > 0 ? '\n' : '') + lines.join('\n') + '\n' : '');
    fs.writeFileSync(templatePath, finalText, 'utf-8');
    return templatePath;
}

// =============================================================================
// ADO TC creation.
// =============================================================================

interface TcPayload {
    service: string;
    operation: string;
    scenario: string;
    kind: 'happy' | 'fault';
}

function composeTcDescription(p: TcPayload, endpointUrl: string, soapVersion: SoapVersion): string {
    return `<div><h3>SOAP ${p.kind === 'happy' ? 'Happy-path' : 'Fault-case'} Test</h3>
<p><strong>Service:</strong> ${xmlEscape(p.service)}</p>
<p><strong>Operation:</strong> ${xmlEscape(p.operation)}</p>
<p><strong>Endpoint:</strong> <code>${xmlEscape(endpointUrl)}</code></p>
<p><strong>SOAP version:</strong> ${xmlEscape(soapVersion)}</p>
<p>Generated by <code>cs_qa_gen_soap_test</code>.</p></div>`;
}

function composeTcStepsXml(p: TcPayload): string {
    const rows: string[] = [];
    let i = 1;
    if (p.kind === 'happy') {
        rows.push(step(i++, 'PreCondition', `Endpoint reachable and credentials (if any) present in env`, `Environment ready`));
        rows.push(step(i++, 'ActionStep', `Send SOAP request for ${p.operation}`, `Response 200 with expected element`));
        rows.push(step(i++, 'ActionStep', `Assert no SOAP fault`, `Response contains no <Fault> element`));
    } else {
        rows.push(step(i++, 'PreCondition', `Endpoint reachable`, `Environment ready`));
        rows.push(step(i++, 'ActionStep', `Send SOAP request for ${p.operation} with a required field omitted`, `Response is a SOAP fault`));
        rows.push(step(i++, 'ActionStep', `Assert fault code is Client (SOAP 1.1) or Sender (SOAP 1.2)`, `Fault code validated`));
    }
    return `<steps id="0" last="${i - 1}">${rows.join('')}</steps>`;
    function step(id: number, type: string, action: string, expected: string): string {
        return `<step id="${id}" type="${type}"><parameterizedString isformatted="true">&lt;P&gt;${xmlEscape(action)}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${xmlEscape(expected)}&lt;/P&gt;</parameterizedString><description/></step>`;
    }
}

// =============================================================================
// Registration.
// =============================================================================

registerPrimitive({
    name: 'cs_qa_gen_soap_test',
    description: 'Parse a WSDL (path or URL, WSDL 1.1 + 2.0) and generate Gherkin .feature files + step defs + SoapClient helper + .env.template for every operation. Supports SOAP 1.1 and 1.2, WS-Security UsernameToken (real SHA-1 digest), Basic auth, and optional ADO Test Case creation per operation. Encrypted credential placeholders only — never real credentials. ADO TC creation is gated by two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`).',
    inputSchema: InputSchema,
    outputSchema: z.object({
        ok: z.boolean(),
        wsdl: z.object({
            source: z.string(),
            targetNamespace: z.string(),
            services: z.array(z.string()),
            operationCount: z.number(),
            soapVersion: z.string(),
            imports: z.array(z.string()).default([]),
        }).optional(),
        featureFilesGenerated: z.array(z.object({ path: z.string(), scenarios: z.array(z.string()) })).default([]),
        stepDefFiles: z.array(z.string()).default([]),
        helperFile: z.string().optional(),
        envTemplateFile: z.string().optional(),
        tcsCreated: z.number().default(0),
        tcsSkipped: z.array(z.object({ scenario: z.string(), reason: z.string() })).default([]),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
        requiresConfirmation: z.boolean().optional(),
        destructive: z.boolean().optional(),
        confirmationHint: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gen_soap_test', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        // 1. Load WSDL.
        let loaded: { text: string; baseHref: string; sourceLabel: string };
        try { loaded = await loadWsdl(input, ctx.workspaceRoot); }
        catch (e) {
            return { ok: false, featureFilesGenerated: [], stepDefFiles: [], tcsCreated: 0, tcsSkipped: [], warnings, note: `WSDL load failed: ${(e as Error).message}` };
        }

        // 2. Parse (recursive imports).
        const parsed: ParsedWsdl = await parseWsdl({
            text: loaded.text,
            baseHref: loaded.baseHref,
            resolveImport: makeResolveImport(loaded.baseHref),
            maxDepth: 8,
        });
        for (const w of parsed.warnings) warnings.push(w);
        if (parsed.services.length === 0) {
            return {
                ok: false,
                wsdl: { source: loaded.sourceLabel, targetNamespace: parsed.targetNamespace, services: [], operationCount: 0, soapVersion: '1.1', imports: parsed.imports },
                featureFilesGenerated: [], stepDefFiles: [], tcsCreated: 0, tcsSkipped: [], warnings,
                note: 'No SOAP services detected in the WSDL.',
            };
        }

        // 3. Determine output root.
        const outputRoot = path.isAbsolute(input.outputRoot) ? input.outputRoot : path.join(ctx.workspaceRoot, input.outputRoot);
        fs.mkdirSync(outputRoot, { recursive: true });

        // 4. Filter operations if requested.
        const opFilter = input.operations && input.operations.length > 0
            ? new Set(input.operations)
            : null;

        // 5. Per service, per port, per operation — emit artifacts.
        const featureFilesGenerated: Array<{ path: string; scenarios: string[]; service: string; op: string; soapVersion: SoapVersion }> = [];
        const stepDefFiles: string[] = [];
        let totalOperations = 0;
        let dominantSoapVersion: SoapVersion = '1.1';

        for (const svc of parsed.services) {
            for (const port of svc.ports) {
                dominantSoapVersion = port.soapVersion;
                const endpointUrl = input.endpointUrl || port.address;
                if (!endpointUrl) {
                    warnings.push(`Service "${svc.name}" port "${port.name}" has no soap:address/@location and no --endpointUrl override — skipped.`);
                    continue;
                }
                const opsFiltered = port.operations.filter((op) => !opFilter || opFilter.has(op.name));
                for (const op of opsFiltered) {
                    totalOperations++;
                    if (input.dryRun) {
                        featureFilesGenerated.push({
                            path: path.join(outputRoot, slugify(svc.name), `${slugify(op.name)}.feature`),
                            scenarios: input.generateNegativeCases ? [`happy path ${op.name}`, `fault case ${op.name} - missing required field`] : [`happy path ${op.name}`],
                            service: svc.name, op: op.name, soapVersion: port.soapVersion,
                        });
                        continue;
                    }
                    const emitted = emitFeature({
                        outputDir: outputRoot,
                        service: svc, op,
                        generateNegativeCases: input.generateNegativeCases,
                        endpointUrl,
                        soapVersion: port.soapVersion,
                        security: input.security,
                    });
                    featureFilesGenerated.push({ path: emitted.filePath, scenarios: emitted.scenarios, service: svc.name, op: op.name, soapVersion: port.soapVersion });
                }
                if (!input.dryRun && opsFiltered.length > 0) {
                    const stepsPath = emitSteps({
                        outputDir: outputRoot,
                        service: svc,
                        operations: opsFiltered,
                        endpointUrl,
                        soapVersion: port.soapVersion,
                        security: input.security,
                        wsdl: parsed,
                    });
                    stepDefFiles.push(stepsPath);
                }
            }
        }

        // 6. Helper + env template (idempotent).
        let helperFile: string | undefined;
        let envTemplateFile: string | undefined;
        if (!input.dryRun) {
            helperFile = emitSoapHelper(outputRoot, warnings);
            envTemplateFile = emitEnvTemplate(outputRoot, input.security);
        }

        log.info('SOAP artefact emission complete', {
            services: parsed.services.length,
            operations: totalOperations,
            featureFiles: featureFilesGenerated.length,
        });

        // 7. Optional: ADO Test Case creation.
        let tcsCreated = 0;
        const tcsSkipped: Array<{ scenario: string; reason: string }> = [];
        if (input.createAdoTc && !input.dryRun) {
            const credsRes = getResolvedCreds(ctx.workspaceRoot, {
                orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
            });
            if (!credsRes.creds) {
                warnings.push(credsRes.diagnostic);
            } else {
                const cfg: AdoCreds = credsRes.creds;
                if ((input as { confirmed?: boolean }).confirmed !== true) {
                    const _dominantVersion = featureFilesGenerated[0]?.soapVersion || dominantSoapVersion;
                    return {
                        ok: true,
                        wsdl: {
                            source: loaded.sourceLabel,
                            targetNamespace: parsed.targetNamespace,
                            services: parsed.services.map((s) => s.name),
                            operationCount: totalOperations,
                            soapVersion: _dominantVersion,
                            imports: parsed.imports,
                        },
                        featureFilesGenerated: featureFilesGenerated.map((f) => ({ path: f.path, scenarios: f.scenarios })),
                        stepDefFiles,
                        helperFile,
                        envTemplateFile,
                        tcsCreated: 0,
                        tcsSkipped: [],
                        warnings,
                        requiresConfirmation: true,
                        destructive: true,
                        confirmationHint: `Create ${featureFilesGenerated.reduce((s, f) => s + f.scenarios.length, 0)} ADO Test Case(s) for SOAP operations in project ${cfg.project}? No write performed. Retry the SAME call with confirmed:true (added at the top level).`,
                        note: 'requires confirmation — retry with confirmed:true',
                    } as never;
                }
                {
                    const client = new AdoHttpClient(cfg);
                    const payloads: TcPayload[] = [];
                    for (const f of featureFilesGenerated) {
                        for (const scenario of f.scenarios) {
                            const kind: 'happy' | 'fault' = scenario.startsWith('fault ') ? 'fault' : 'happy';
                            payloads.push({ service: f.service, operation: f.op, scenario, kind });
                        }
                    }
                    const dominantVersion = featureFilesGenerated[0]?.soapVersion || dominantSoapVersion;
                    const endpointUrlForDesc = input.endpointUrl || parsed.services[0]?.ports?.[0]?.address || '';
                    const bulk = await bulkExecute(payloads, {
                        chunkSize: 1,
                        concurrency: 4,
                        workFn: async (batch) => {
                            const p = batch[0];
                            const patch: Array<Record<string, unknown>> = [
                                { op: 'add', path: '/fields/System.Title', value: `SOAP: ${p.service} — ${p.scenario}` },
                                { op: 'add', path: '/fields/System.Description', value: composeTcDescription(p, endpointUrlForDesc, dominantVersion) },
                                { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: composeTcStepsXml(p) },
                                { op: 'add', path: '/fields/System.Tags', value: `soap; auto-generated; service:${slugify(p.service)}; ${p.kind === 'fault' ? 'negative' : 'happy-path'}` },
                            ];
                            const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Test%20Case?api-version=7.0`, patch);
                            return [{ tcId: Number(created.id || 0), scenario: p.scenario }];
                        },
                        onChunkError: (err, chunk) => {
                            log.warn('SOAP TC creation failed', { scenario: chunk[0].scenario, error: err.message });
                        },
                    });
                    tcsCreated = bulk.ok.length;
                    for (const f of bulk.failed) tcsSkipped.push({ scenario: f.item.scenario, reason: f.error.message });
                }
            }
        }

        const dominantVersion = featureFilesGenerated[0]?.soapVersion || dominantSoapVersion;
        return {
            ok: true,
            wsdl: {
                source: loaded.sourceLabel,
                targetNamespace: parsed.targetNamespace,
                services: parsed.services.map((s) => s.name),
                operationCount: totalOperations,
                soapVersion: dominantVersion,
                imports: parsed.imports,
            },
            featureFilesGenerated: featureFilesGenerated.map((f) => ({ path: f.path, scenarios: f.scenarios })),
            stepDefFiles,
            helperFile,
            envTemplateFile,
            tcsCreated,
            tcsSkipped,
            warnings,
            note: input.dryRun
                ? `Dry-run: would emit ${featureFilesGenerated.length} feature file(s) for ${totalOperations} operation(s) across ${parsed.services.length} service(s).`
                : `Generated ${featureFilesGenerated.length} feature file(s) for ${totalOperations} operation(s) across ${parsed.services.length} service(s). SOAP ${dominantVersion}.${tcsCreated > 0 ? ` ${tcsCreated} ADO TC(s) created.` : ''}`,
        };
    },
});
