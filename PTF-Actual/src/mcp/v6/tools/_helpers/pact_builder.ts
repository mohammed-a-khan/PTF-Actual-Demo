/**
 * Pact consumer contract test emitter.
 *
 * Emits a `<consumer>-<provider>.pact.spec.ts` that uses `@pact-foundation/pact`
 * (referenced by name in generated code; NOT installed by the generator — the
 * README emits the install hint). Also emits a shared `_pact-helper.ts` for
 * setup/teardown niceties and a README with broker publish instructions.
 *
 * Framework-consistent: helper uses CSReporter for logging.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface PactInteraction {
    description: string;
    providerState?: string;
    request: {
        method: string;
        path: string;
        headers?: Record<string, string>;
        body?: unknown;
        query?: Record<string, string>;
    };
    response: {
        status: number;
        headers?: Record<string, string>;
        body?: unknown;
    };
}

export interface EmitPactArgs {
    outputRoot: string;
    consumerName: string;
    providerName: string;
    pactVersion: number;
    interactions: PactInteraction[];
    pactBrokerUrl?: string;
    pactBrokerAuthTokenEnvVar?: string;
    warnings: string[];
}

export interface EmittedPactBundle {
    specFile: string;
    helperFile: string;
    readmeFile: string;
    envTemplateFile: string;
    scenarioNames: string[];
}

// ---------------------------------------------------------------------------
// Naming.
// ---------------------------------------------------------------------------

function pascal(s: string): string {
    return s
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join('') || 'Pact';
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pact';
}

function tsLit(s: string): string {
    return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n') + "'";
}

function jsonLit(v: unknown, indent = 12): string {
    if (v === undefined || v === null) return 'undefined';
    try { return JSON.stringify(v, null, 4).replace(/\n/g, '\n' + ' '.repeat(indent)); }
    catch { return 'undefined'; }
}

// ---------------------------------------------------------------------------
// Spec file emitter.
// ---------------------------------------------------------------------------

export function emitPactSpec(args: EmitPactArgs): EmittedPactBundle {
    fs.mkdirSync(args.outputRoot, { recursive: true });
    const specFile = path.join(args.outputRoot, `${slugify(args.consumerName)}-${slugify(args.providerName)}.pact.spec.ts`);
    const helperFile = emitPactHelper(args.outputRoot, args.warnings);
    const readmeFile = emitPactReadme(args.outputRoot, args);
    const envTemplateFile = emitPactEnvTemplate(args.outputRoot, args.pactBrokerAuthTokenEnvVar);

    const consumer = tsLit(args.consumerName);
    const provider = tsLit(args.providerName);
    const pactSpecVersion = args.pactVersion || 4;
    const testClass = `${pascal(args.consumerName)}${pascal(args.providerName)}PactSpec`;
    const scenarioNames: string[] = [];

    const interactionsBlock: string[] = [];
    for (const inx of args.interactions) {
        const desc = inx.description;
        scenarioNames.push(desc);
        const method = inx.request.method.toUpperCase();
        const state = inx.providerState ? `\n            .given(${tsLit(inx.providerState)})` : '';
        const headers = inx.request.headers ? `\n                headers: ${jsonLit(inx.request.headers, 16)},` : '';
        const query = inx.request.query ? `\n                query: ${jsonLit(inx.request.query, 16)},` : '';
        const reqBody = inx.request.body !== undefined ? `\n                body: ${jsonLit(inx.request.body, 16)},` : '';
        const resHeaders = inx.response.headers ? `\n                headers: ${jsonLit(inx.response.headers, 16)},` : '';
        const resBody = inx.response.body !== undefined ? `\n                body: ${jsonLit(inx.response.body, 16)},` : '';

        interactionsBlock.push(`
    it(${tsLit(desc)}, async () => {
        await provider${state}
            .uponReceiving(${tsLit(desc)})
            .withRequest({
                method: '${method}',
                path: ${tsLit(inx.request.path)},${headers}${query}${reqBody}
            })
            .willRespondWith({
                status: ${inx.response.status},${resHeaders}${resBody}
            });

        await provider.executeTest(async (mockServer) => {
            const url = mockServer.url;
            const response = await sendPactRequest(url, {
                method: '${method}',
                path: ${tsLit(inx.request.path)},
                headers: ${jsonLit(inx.request.headers || {}, 16)},
                body: ${jsonLit(inx.request.body ?? null, 16)},
            });
            expect(response.status).toBe(${inx.response.status});
        });
    });`);
    }

    // Referenced by name only — never installed by the generator. Consumers run
    // the install hint from the emitted README.
    const src = `/* eslint-disable */
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import * as path from 'path';
import { sendPactRequest } from './_pact-helper';

// Auto-generated Pact consumer test bundle. Do NOT hand-edit — regenerate via
// cs_qa_gen_protocol_test (verb: 'pact'). If you customize scenarios, move
// them into a sibling *.custom.spec.ts file that imports the same helper.

const provider = new PactV3({
    consumer: ${consumer},
    provider: ${provider},
    dir: path.resolve(__dirname, 'pacts'),
    logLevel: 'warn',
    spec: ${pactSpecVersion},
});

export class ${testClass} {
    static provider = provider;
}

describe(${tsLit(`Pact contract ${args.consumerName} → ${args.providerName}`)}, () => {
${interactionsBlock.join('\n')}
});

// Ensure MatchersV3 is referenced so tree-shaking / lint keeps the import.
export const _matchers = MatchersV3;
`;

    fs.writeFileSync(specFile, src, 'utf-8');
    return { specFile, helperFile, readmeFile, envTemplateFile, scenarioNames };
}

// ---------------------------------------------------------------------------
// Helper.
// ---------------------------------------------------------------------------

function emitPactHelper(outputRoot: string, warnings: string[]): string {
    const filePath = path.join(outputRoot, '_pact-helper.ts');
    if (fs.existsSync(filePath)) {
        warnings.push(`_pact-helper.ts already exists at ${filePath} — kept as-is (generator does not clobber consumer edits).`);
        return filePath;
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    const src = `/* eslint-disable */
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

// Auto-generated Pact helper. Safe to edit; the generator will not clobber
// this file once it exists.

export interface PactRequestArgs {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
}

export interface PactHttpResponse {
    status: number;
    body: string;
    headers: Record<string, string>;
}

function joinUrl(baseUrl: string, subPath: string): string {
    const trimmedBase = baseUrl.replace(/\\/+$/, '');
    const trimmedPath = subPath.startsWith('/') ? subPath : '/' + subPath;
    return trimmedBase + trimmedPath;
}

export async function sendPactRequest(mockServerUrl: string, args: PactRequestArgs): Promise<PactHttpResponse> {
    const target = joinUrl(mockServerUrl, args.path);
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

    CSReporter.info(\`Pact request \${args.method} \${target}\`);

    return new Promise<PactHttpResponse>((resolve, reject) => {
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const req = lib.request({
            method: args.method,
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers,
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
                CSReporter.info(\`Pact response status \${res.statusCode || 0}\`);
                resolve({ status: res.statusCode || 0, body, headers: responseHeaders });
            });
        });
        req.on('error', (err) => {
            CSReporter.error(\`Pact request error: \${err.message}\`);
            reject(err);
        });
        if (bodyText.length > 0) req.write(bodyText);
        req.end();
    });
}
`;
    fs.writeFileSync(filePath, src, 'utf-8');
    return filePath;
}

// ---------------------------------------------------------------------------
// README + env template.
// ---------------------------------------------------------------------------

function emitPactReadme(outputRoot: string, args: EmitPactArgs): string {
    const filePath = path.join(outputRoot, `${slugify(args.consumerName)}-${slugify(args.providerName)}.README.md`);
    fs.mkdirSync(outputRoot, { recursive: true });
    const brokerUrl = args.pactBrokerUrl || '<broker url>';
    const brokerEnvVar = args.pactBrokerAuthTokenEnvVar || 'PACT_BROKER_TOKEN';
    const lines: string[] = [];
    lines.push(`# Pact consumer contract: ${args.consumerName} → ${args.providerName}`);
    lines.push('');
    lines.push('## Install (once per workspace)');
    lines.push('');
    lines.push('```bash');
    lines.push('npm i --save-dev @pact-foundation/pact');
    lines.push('```');
    lines.push('');
    lines.push('## Run the consumer suite');
    lines.push('');
    lines.push('```bash');
    lines.push('npx jest ' + `${slugify(args.consumerName)}-${slugify(args.providerName)}.pact.spec.ts`);
    lines.push('```');
    lines.push('');
    lines.push('The suite writes a JSON pact under `./pacts/`.');
    lines.push('');
    lines.push('## Publish to Pact Broker');
    lines.push('');
    lines.push('```bash');
    lines.push('npx pact-broker publish ./pacts \\');
    lines.push(`  --consumer-app-version="\${GIT_SHA}" \\`);
    lines.push(`  --broker-base-url="${brokerUrl}" \\`);
    lines.push(`  --broker-token="\${${brokerEnvVar}}"`);
    lines.push('```');
    lines.push('');
    lines.push('The token env var is populated from `.env.template` — never commit real credentials.');
    lines.push('');
    lines.push(`## Interactions covered (${args.interactions.length})`);
    lines.push('');
    for (const inx of args.interactions) {
        lines.push(`- ${inx.request.method.toUpperCase()} ${inx.request.path} → ${inx.response.status} — ${inx.description}`);
    }
    lines.push('');
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
}

function emitPactEnvTemplate(outputRoot: string, pactBrokerAuthTokenEnvVar?: string): string {
    const templatePath = path.join(outputRoot, '.env.template');
    fs.mkdirSync(outputRoot, { recursive: true });
    let existing = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf-8') : '';
    const key = pactBrokerAuthTokenEnvVar || 'PACT_BROKER_TOKEN';
    const newLines: string[] = [];
    if (!existing.includes(`${key}=`)) newLines.push(`${key}=ENCRYPTED:`);
    if (existing.length === 0) {
        existing = '# Auto-generated by cs_qa_gen_protocol_test. Fill values via `cs-playwright-mcp encrypt <plain>` and paste after ENCRYPTED:.\n';
    }
    const finalText = existing + (newLines.length > 0 ? (existing.endsWith('\n') ? '' : '\n') + newLines.join('\n') + '\n' : '');
    fs.writeFileSync(templatePath, finalText, 'utf-8');
    return templatePath;
}
