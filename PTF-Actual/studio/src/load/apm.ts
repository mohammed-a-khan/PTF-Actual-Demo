/**
 * Tagging load-test requests for APM tools, so the requests of a run can be found (and told apart from real users):
 *  - W3C Trace Context: a traceparent header per request (a new trace id, sampled), which OpenTelemetry, Azure
 *    Application Insights, Datadog, New Relic, Dynatrace and AppDynamics agents continue; the trace id is kept with
 *    the error samples, so a failed request can be looked up in the APM tool.
 *  - Dynatrace's load-test header (x-dynatrace-test: VU, script, transaction, test name), which Dynatrace turns into
 *    request attributes.
 *  - A header of your own (e.g. X-Load-Test: {scenario}/{transaction}) for any other tool or the logs.
 */
import * as crypto from 'crypto';

export interface ApmTagging {
    traceparent?: boolean;
    dynatrace?: boolean;
    /** A header of your own: name and value ({scenario}, {transaction}, {user}, {run} are filled in). */
    header?: { name: string; value: string };
}

export function validApm(a: ApmTagging): string | null {
    if (a.header) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(a.header.name ?? '')) return 'the APM header name (letters, digits, -)';
        if (typeof a.header.value !== 'string' || a.header.value.length > 300 || /[\r\n]/.test(a.header.value)) return 'the APM header value (one line)';
    }
    return null;
}

/** The headers of one request; `trace` is the trace id (for samples). */
export function apmHeaders(a: ApmTagging | undefined, ctx: { scenario: string; transaction: string; user: number; run: string }): { headers: Record<string, string>; trace?: string } {
    if (!a) return { headers: {} };
    const headers: Record<string, string> = {};
    let trace: string | undefined;
    if (a.traceparent) {
        trace = crypto.randomBytes(16).toString('hex');
        headers.traceparent = `00-${trace}-${crypto.randomBytes(8).toString('hex')}-01`;
        headers.tracestate = `cstest=${ctx.run.replace(/[^\w-]/g, '').slice(0, 64) || 'run'}`;
    }
    // Dynatrace: VU, SI (source), TSN (step), LSN (script), LTN (test run). Values without ; or =.
    const clean = (s: string) => s.replace(/[;=\r\n]/g, ' ').trim().slice(0, 120);
    if (a.dynatrace) headers['x-dynatrace-test'] = `VU=${ctx.user + 1};SI=CS Test Studio;TSN=${clean(ctx.transaction)};LSN=${clean(ctx.scenario)};LTN=${clean(ctx.run)}`;
    if (a.header) headers[a.header.name] = a.header.value.replace(/\{(scenario|transaction|user|run)\}/g, (_m, k: string) => (k === 'user' ? String(ctx.user + 1) : String((ctx as Record<string, unknown>)[k])));
    return { headers, ...(trace ? { trace } : {}) };
}
