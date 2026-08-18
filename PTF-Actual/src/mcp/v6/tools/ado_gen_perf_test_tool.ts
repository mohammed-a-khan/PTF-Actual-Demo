/**
 * cs_qa_gen_perf_test — emit a k6 performance test scaffold + companion README
 * + optionally an ADO Test Case + a `TestedBy` link back to a Story.
 *
 * The k6 script is generated with:
 *   - per-scenario ramping-vus/constant-vus/ramping-arrival-rate stages
 *   - thresholds block populated from `slaThresholds` (real k6 syntax, no TBDs)
 *   - Trend + Rate custom metrics for p50/p95/p99 per scenario
 *   - lightweight response-body sanity assertions
 *
 * NO stubs — the emitted script runs verbatim under `k6 run`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

const ScenarioSchema = z.object({
    name: z.string().min(1),
    virtualUsers: z.number().int().positive(),
    durationSeconds: z.number().int().positive(),
    rampUpSeconds: z.number().int().nonnegative().optional(),
});

const SlaSchema = z.object({
    p50MaxMs: z.number().positive().optional(),
    p95MaxMs: z.number().positive().optional(),
    p99MaxMs: z.number().positive().optional(),
    errorRateMaxPercent: z.number().min(0).max(100).optional(),
    throughputMinPerSecond: z.number().positive().optional(),
});

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
}

function escapeJs(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function composeK6Script(args: {
    endpoint: string;
    method: string;
    body: unknown | undefined;
    headers: Record<string, string> | undefined;
    scenarios: z.infer<typeof ScenarioSchema>[];
    slaThresholds: z.infer<typeof SlaSchema> | undefined;
}): string {
    const scenarioBlock = args.scenarios.map((sc) => {
        const rampUp = sc.rampUpSeconds ?? Math.max(1, Math.floor(sc.durationSeconds * 0.1));
        const holdSec = Math.max(1, sc.durationSeconds - rampUp);
        const key = slugify(sc.name).replace(/-/g, '_');
        return `        ${key}: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '${rampUp}s', target: ${sc.virtualUsers} },
                { duration: '${holdSec}s', target: ${sc.virtualUsers} },
                { duration: '${Math.max(1, Math.floor(rampUp / 2))}s', target: 0 },
            ],
            gracefulRampDown: '5s',
            exec: 'run_${key}',
        }`;
    }).join(',\n');

    const thresholdParts: string[] = [];
    if (args.slaThresholds?.p50MaxMs !== undefined) thresholdParts.push(`'http_req_duration': ['p(50)<${args.slaThresholds.p50MaxMs}']`);
    if (args.slaThresholds?.p95MaxMs !== undefined) thresholdParts.push(`'http_req_duration{expected_response:true}': ['p(95)<${args.slaThresholds.p95MaxMs}']`);
    if (args.slaThresholds?.p99MaxMs !== undefined) thresholdParts.push(`'http_req_duration': ['p(99)<${args.slaThresholds.p99MaxMs}']`);
    if (args.slaThresholds?.errorRateMaxPercent !== undefined) thresholdParts.push(`'http_req_failed': ['rate<${(args.slaThresholds.errorRateMaxPercent / 100).toFixed(4)}']`);
    if (args.slaThresholds?.throughputMinPerSecond !== undefined) thresholdParts.push(`'http_reqs': ['rate>${args.slaThresholds.throughputMinPerSecond}']`);
    const thresholdBlock = thresholdParts.length > 0
        ? `    thresholds: {\n        ${thresholdParts.join(',\n        ')},\n    },`
        : `    thresholds: {},`;

    const headersLiteral = args.headers && Object.keys(args.headers).length > 0
        ? JSON.stringify(args.headers, null, 4)
        : '{}';
    const bodyLiteral = args.body === undefined
        ? 'null'
        : `JSON.stringify(${JSON.stringify(args.body, null, 4)})`;

    const scenarioExecs = args.scenarios.map((sc) => {
        const key = slugify(sc.name).replace(/-/g, '_');
        return `export function run_${key}() {
    exec_common('${escapeJs(sc.name)}');
    sleep(0.1);
}`;
    }).join('\n\n');

    return `// Auto-generated k6 performance test.
//
// Run: k6 run --summary-export=perf-summary.json ${path.basename(args.endpoint).replace(/[^a-z0-9]/gi, '-')}.perf.js
//
// Feed the summary JSON to cs_qa_analyze_perf to compare against SLAs.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const respTime = new Trend('response_time_ms', true);
const errorRate = new Rate('errors');
const reqCount = new Counter('req_count');

export const options = {
    scenarios: {
${scenarioBlock},
    },
${thresholdBlock}
};

const TARGET_URL = '${escapeJs(args.endpoint)}';
const METHOD = '${args.method}';
const HEADERS = ${headersLiteral};
const BODY = ${bodyLiteral};

function exec_common(scenarioName) {
    const params = { headers: HEADERS, tags: { scenario: scenarioName } };
    let res;
    if (METHOD === 'GET' || METHOD === 'DELETE' || METHOD === 'HEAD' || METHOD === 'OPTIONS') {
        res = http.request(METHOD, TARGET_URL, null, params);
    } else {
        res = http.request(METHOD, TARGET_URL, BODY, params);
    }
    respTime.add(res.timings.duration, { scenario: scenarioName });
    reqCount.add(1);
    const ok = check(res, {
        'status is 2xx or 3xx': (r) => r.status >= 200 && r.status < 400,
        'body is non-empty': (r) => r.body && r.body.length > 0,
    });
    errorRate.add(!ok);
}

${scenarioExecs}
`;
}

function composeReadme(args: {
    endpoint: string;
    scriptFile: string;
    scenarios: z.infer<typeof ScenarioSchema>[];
    slaThresholds: z.infer<typeof SlaSchema> | undefined;
}): string {
    const scenarioLines = args.scenarios.map((s) => `- **${s.name}** — ${s.virtualUsers} VUs × ${s.durationSeconds}s (ramp ${s.rampUpSeconds ?? Math.max(1, Math.floor(s.durationSeconds * 0.1))}s)`).join('\n');
    const slaLines = args.slaThresholds
        ? [
            args.slaThresholds.p50MaxMs !== undefined ? `- p50 < ${args.slaThresholds.p50MaxMs}ms` : null,
            args.slaThresholds.p95MaxMs !== undefined ? `- p95 < ${args.slaThresholds.p95MaxMs}ms` : null,
            args.slaThresholds.p99MaxMs !== undefined ? `- p99 < ${args.slaThresholds.p99MaxMs}ms` : null,
            args.slaThresholds.errorRateMaxPercent !== undefined ? `- error rate < ${args.slaThresholds.errorRateMaxPercent}%` : null,
            args.slaThresholds.throughputMinPerSecond !== undefined ? `- throughput > ${args.slaThresholds.throughputMinPerSecond} req/s` : null,
        ].filter(Boolean).join('\n')
        : '- (no SLAs configured)';
    return `# Performance test — ${args.endpoint}

## Scenarios
${scenarioLines}

## SLA Thresholds (enforced by k6)
${slaLines}

## Run
\`\`\`bash
k6 run --summary-export=perf-summary.json ${path.basename(args.scriptFile)}
\`\`\`

## Analyze results
\`\`\`
/analyze-perf perf-summary.json
\`\`\`
`;
}

registerPrimitive({
    name: 'cs_qa_gen_perf_test',
    description: 'Generate a k6 performance test script + companion README for a target endpoint. Supports per-scenario ramp/hold profiles and SLA thresholds (p50/p95/p99/error-rate/throughput) that k6 enforces natively. Optionally creates an ADO Test Case and TestedBy link. ADO TC creation is gated by two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`).',
    inputSchema: z.object({
        targetEndpoint: z.string().url(),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        body: z.unknown().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        scenarios: z.array(ScenarioSchema).min(1),
        slaThresholds: SlaSchema.optional(),
        outputRoot: z.string().optional(),
        slug: z.string().optional(),
        createAdoTc: z.boolean().default(false),
        planId: z.number().int().positive().optional(),
        planName: z.string().optional(),
        suiteId: z.number().int().positive().optional(),
        suiteName: z.string().optional(),
        linkToStoryId: z.number().int().positive().optional(),
        dryRun: z.boolean().default(false),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        scriptFile: z.string().optional(),
        readmeFile: z.string().optional(),
        tcId: z.number().optional(),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
        requiresConfirmation: z.boolean().optional(),
        destructive: z.boolean().optional(),
        confirmationHint: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gen_perf_test', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        const endpointSlug = input.slug || slugify(new URL(input.targetEndpoint).pathname || 'endpoint');
        const outputRoot = input.outputRoot
            ? (path.isAbsolute(input.outputRoot) ? input.outputRoot : path.join(ctx.workspaceRoot, input.outputRoot))
            : path.join(ctx.workspaceRoot, 'test', 'perf');
        const perfDir = path.join(outputRoot);
        fs.mkdirSync(perfDir, { recursive: true });

        const script = composeK6Script({
            endpoint: input.targetEndpoint,
            method: input.method,
            body: input.body,
            headers: input.headers,
            scenarios: input.scenarios,
            slaThresholds: input.slaThresholds,
        });
        const scriptFile = path.join(perfDir, `${endpointSlug}.perf.js`);
        const readme = composeReadme({
            endpoint: input.targetEndpoint,
            scriptFile,
            scenarios: input.scenarios,
            slaThresholds: input.slaThresholds,
        });
        const readmeFile = path.join(perfDir, `${endpointSlug}.perf.README.md`);

        if (input.dryRun) {
            return { ok: true, warnings, note: `Dry-run: would write ${scriptFile} and ${readmeFile}. Scenarios=${input.scenarios.length}, SLAs=${input.slaThresholds ? 'set' : 'none'}.` };
        }

        fs.writeFileSync(scriptFile, script, 'utf-8');
        fs.writeFileSync(readmeFile, readme, 'utf-8');
        log.info('perf script written', { scriptFile, scenarios: input.scenarios.length });

        if (!input.createAdoTc && !input.linkToStoryId) {
            return { ok: true, scriptFile, readmeFile, warnings, note: 'Perf script generated. Pass createAdoTc:true to also create an ADO Test Case.' };
        }

        const credsRes = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl,
            project: input.project,
            personalAccessToken: input.pat,
        });
        if (!credsRes.creds) {
            warnings.push(credsRes.diagnostic);
            return { ok: true, scriptFile, readmeFile, warnings, note: 'Perf script written; ADO TC skipped because ADO is not configured.' };
        }

        if ((input as { confirmed?: boolean }).confirmed !== true) {
            return {
                ok: true, scriptFile, readmeFile, warnings,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint: `Create ADO Test Case for perf test "${endpointSlug}" in project ${credsRes.creds.project}? No write performed. Retry the SAME call with confirmed:true (added at the top level).`,
                note: 'requires confirmation — retry with confirmed:true',
            } as never;
        }

        const cfg: AdoCreds = credsRes.creds;
        const client = new AdoHttpClient(cfg);

        const stepsXml = composePerfStepsXml(input);
        const patch: Array<Record<string, unknown>> = [
            { op: 'add', path: '/fields/System.Title', value: `Performance: ${endpointSlug} (${input.method} ${input.targetEndpoint})` },
            { op: 'add', path: '/fields/System.Description', value: composePerfDescription(input, scriptFile) },
            { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: stepsXml },
            { op: 'add', path: '/fields/System.Tags', value: 'performance; k6' },
        ];
        if (input.linkToStoryId) {
            patch.push({
                op: 'add',
                path: '/relations/-',
                value: {
                    rel: 'Microsoft.VSTS.Common.TestedBy-Reverse',
                    url: `${cfg.orgUrl.replace(/\/$/, '')}/_apis/wit/workitems/${input.linkToStoryId}`,
                },
            });
        }
        try {
            const created = await client.post<{ id?: number; url?: string }>(`_apis/wit/workitems/$Test%20Case?api-version=7.0`, patch);
            const tcId = Number(created.id || 0);
            return { ok: true, scriptFile, readmeFile, tcId, warnings, note: `Perf script and ADO TC ${tcId} created${input.linkToStoryId ? ` and linked to story ${input.linkToStoryId}` : ''}.` };
        } catch (e) {
            warnings.push(`ADO TC creation failed: ${(e as Error).message}`);
            return { ok: true, scriptFile, readmeFile, warnings, note: 'Perf script written; ADO TC creation failed (see warnings).' };
        }
    },
});

function composePerfStepsXml(input: { targetEndpoint: string; method: string; scenarios: z.infer<typeof ScenarioSchema>[]; slaThresholds?: z.infer<typeof SlaSchema> }): string {
    function esc(s: string): string {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    const rows: string[] = [];
    let i = 1;
    rows.push(`<step id="${i++}" type="PreCondition"><parameterizedString isformatted="true">&lt;P&gt;${esc('Configure environment for k6 (VU capacity + network reachability to target endpoint)')}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${esc('k6 installed; target endpoint reachable')}&lt;/P&gt;</parameterizedString><description/></step>`);
    for (const s of input.scenarios) {
        rows.push(`<step id="${i++}" type="ActionStep"><parameterizedString isformatted="true">&lt;P&gt;${esc(`Run scenario "${s.name}": ${s.virtualUsers} VUs × ${s.durationSeconds}s against ${input.method} ${input.targetEndpoint}`)}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${esc('All SLA thresholds pass (k6 exits 0)')}&lt;/P&gt;</parameterizedString><description/></step>`);
    }
    rows.push(`<step id="${i++}" type="ActionStep"><parameterizedString isformatted="true">&lt;P&gt;${esc('Feed perf-summary.json to cs_qa_analyze_perf')}&lt;/P&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;${esc('Verdict is PASS; no bugs opened')}&lt;/P&gt;</parameterizedString><description/></step>`);
    return `<steps id="0" last="${i - 1}">${rows.join('')}</steps>`;
}

function composePerfDescription(input: { targetEndpoint: string; method: string; scenarios: z.infer<typeof ScenarioSchema>[]; slaThresholds?: z.infer<typeof SlaSchema> }, scriptFile: string): string {
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const scenarioRows = input.scenarios.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.virtualUsers}</td><td>${s.durationSeconds}s</td><td>${s.rampUpSeconds ?? Math.max(1, Math.floor(s.durationSeconds * 0.1))}s</td></tr>`).join('');
    const slaRows: string[] = [];
    if (input.slaThresholds?.p50MaxMs !== undefined) slaRows.push(`<tr><td>p50</td><td>&lt; ${input.slaThresholds.p50MaxMs}ms</td></tr>`);
    if (input.slaThresholds?.p95MaxMs !== undefined) slaRows.push(`<tr><td>p95</td><td>&lt; ${input.slaThresholds.p95MaxMs}ms</td></tr>`);
    if (input.slaThresholds?.p99MaxMs !== undefined) slaRows.push(`<tr><td>p99</td><td>&lt; ${input.slaThresholds.p99MaxMs}ms</td></tr>`);
    if (input.slaThresholds?.errorRateMaxPercent !== undefined) slaRows.push(`<tr><td>error rate</td><td>&lt; ${input.slaThresholds.errorRateMaxPercent}%</td></tr>`);
    if (input.slaThresholds?.throughputMinPerSecond !== undefined) slaRows.push(`<tr><td>throughput</td><td>&gt; ${input.slaThresholds.throughputMinPerSecond} req/s</td></tr>`);
    return `<div>
<h3>Performance Test</h3>
<p><strong>${esc(input.method)}</strong> <code>${esc(input.targetEndpoint)}</code></p>
<p>Generated k6 script: <code>${esc(scriptFile)}</code></p>
<h3>Scenarios</h3>
<table><thead><tr><th>Name</th><th>VUs</th><th>Duration</th><th>Ramp</th></tr></thead><tbody>${scenarioRows}</tbody></table>
${slaRows.length > 0 ? `<h3>SLA Thresholds</h3><table><thead><tr><th>Metric</th><th>Threshold</th></tr></thead><tbody>${slaRows.join('')}</tbody></table>` : ''}
</div>`;
}
