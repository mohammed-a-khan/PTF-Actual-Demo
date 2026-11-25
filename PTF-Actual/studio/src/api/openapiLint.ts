/**
 * OpenAPI design checks, shown in the editor as you type and run in a pipeline (`cs-test-studio lint`): the document
 * validated against the OpenAPI 2.0 / 3.0 / 3.1 specification (swagger-parser), and the team's rules (governance):
 * operation ids, summaries, tags, success responses, path parameters, path style, HTTPS servers, security, examples,
 * response schemas, unused components. Each rule can be turned off or made an error in .cs-api-lint.json:
 *   { "rules": { "operation-tags": "off", "path-kebab-case": "error" } }
 * Problems carry the line and column of the place they are about (YAML or JSON).
 */
import * as fs from 'fs';
import * as path from 'path';
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';

export type Severity = 'error' | 'warning' | 'info' | 'off';
export interface LintProblem { line: number; column: number; endLine: number; endColumn: number; message: string; severity: Exclude<Severity, 'off'>; source: 'OpenAPI'; rule: string }

export const RULES: Record<string, { severity: Exclude<Severity, 'off'>; about: string }> = {
    'spec': { severity: 'error', about: 'The document follows the OpenAPI specification' },
    'operation-operationId': { severity: 'warning', about: 'Every operation has an operationId (code generators, mocks and tests name it)' },
    'operation-operationId-unique': { severity: 'error', about: 'operationIds are unique' },
    'operation-summary': { severity: 'warning', about: 'Every operation has a summary' },
    'operation-tags': { severity: 'info', about: 'Every operation has a tag (groups in documentation and collections)' },
    'operation-success-response': { severity: 'error', about: 'Every operation has a 2xx or 3xx response' },
    'path-params-defined': { severity: 'error', about: 'Every {parameter} in a path is declared as a path parameter (and the other way round)' },
    'path-kebab-case': { severity: 'warning', about: 'Paths are lower case, words joined with -' },
    'path-no-trailing-slash': { severity: 'warning', about: 'Paths do not end with /' },
    'servers-https': { severity: 'warning', about: 'Servers use https' },
    'security-defined': { severity: 'warning', about: 'The API says how it is secured (security)' },
    'request-body-example': { severity: 'info', about: 'Request bodies have an example (tests and mocks use it)' },
    'response-schema': { severity: 'warning', about: 'JSON success responses have a schema' },
    'no-unused-components': { severity: 'info', about: 'Every schema under components is used' },
    'info-contact': { severity: 'info', about: 'info has a contact (who owns the API)' },
};

export function lintConfig(repoRoot: string): Record<string, Severity> {
    try { const j = JSON.parse(fs.readFileSync(path.join(repoRoot, '.cs-api-lint.json'), 'utf8')); return (j?.rules ?? {}) as Record<string, Severity>; } catch { return {}; }
}

/** An OpenAPI / Swagger document (YAML or JSON), by its first keys. */
export const isOpenApiText = (text: string) => /(^|[{,])\s*["']?(openapi|swagger)["']?\s*:/m.test(text.slice(0, 4000));

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const unescape = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');

export async function lintOpenApi(text: string, rules: Record<string, Severity> = {}): Promise<LintProblem[]> {
    const lc = new LineCounter();
    const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: false });
    const out: LintProblem[] = [];
    const sev = (rule: string): Severity => rules[rule] ?? RULES[rule]?.severity ?? 'warning';
    const posOf = (offset: [number, number] | undefined) => {
        if (!offset) return { line: 1, column: 1, endLine: 1, endColumn: 2 };
        const a = lc.linePos(offset[0]), b = lc.linePos(Math.max(offset[0] + 1, offset[1]));
        return { line: a.line, column: a.col, endLine: b.line, endColumn: b.col };
    };
    // The node at a JSON path (a key's position when asked: "the place it is about").
    const at = (p: Array<string | number>, key = false): [number, number] | undefined => {
        let n: Node | null | undefined = doc.contents as Node;
        let keyRange: [number, number] | undefined;
        for (const seg of p) {
            if (isMap(n)) { const pair = n.items.find((it) => isScalar(it.key) && String(it.key.value) === String(seg)); if (!pair) return keyRange ?? (n.range ? [n.range[0], n.range[1]] : undefined); keyRange = isScalar(pair.key) && pair.key.range ? [pair.key.range[0], pair.key.range[1]] : undefined; n = pair.value as Node; }
            else if (isSeq(n)) { n = n.items[Number(seg)] as Node; keyRange = undefined; }
            else break;
        }
        if (key && keyRange) return keyRange;
        return n && n.range ? [n.range[0], Math.min(n.range[1], n.range[0] + 200)] : keyRange;
    };
    const add = (rule: string, p: Array<string | number>, message: string, key = true) => {
        const s = sev(rule);
        if (s === 'off') return;
        out.push({ ...posOf(at(p, key)), message, severity: s, source: 'OpenAPI', rule });
    };
    for (const e of doc.errors) out.push({ ...posOf(e.pos), message: `YAML: ${e.message.split('\n')[0]}`, severity: 'error', source: 'OpenAPI', rule: 'spec' });
    if (doc.errors.length) return out;
    const api = doc.toJS({ maxAliasCount: 100 }) as Record<string, any>;
    if (!api || typeof api !== 'object') return out;
    // The specification.
    if (sev('spec') !== 'off') {
        try {
            const SwaggerParser = (await import('@apidevtools/swagger-parser')).default;
            await SwaggerParser.validate(JSON.parse(JSON.stringify(api)), { resolve: { external: false } } as never);
        } catch (e) {
            const details = (e as { details?: Array<{ instancePath?: string; message?: string; params?: Record<string, unknown> }> }).details;
            const seen = new Set<string>();
            if (details?.length) for (const d of details) {
                const p = (d.instancePath ?? '').split('/').filter(Boolean).map(unescape);
                const extra = d.params?.additionalProperty ? ` (${String(d.params.additionalProperty)})` : d.params?.missingProperty ? '' : '';
                const msg = `${d.message ?? 'invalid'}${extra}`;
                // The "must match one schema" noise of alternatives ($ref or object) is left out when a clearer message exists.
                if (/must match exactly one schema|must have required property '\$ref'/.test(msg) && details.length > 1) continue;
                const k = `${p.join('/')}|${msg}`;
                if (seen.has(k)) continue;
                seen.add(k);
                add('spec', d.params?.additionalProperty ? [...p, String(d.params.additionalProperty)] : p, `Not valid OpenAPI: ${p.length ? `${p.join(' › ')} ` : ''}${msg}`);
            } else add('spec', [], `Not valid OpenAPI: ${(e as Error).message.split('\n')[0]}`);
        }
    }
    const v3 = typeof api.openapi === 'string';
    // Operations.
    const ids = new Map<string, Array<Array<string | number>>>();
    const paths = (api.paths ?? {}) as Record<string, any>;
    for (const [p, item] of Object.entries(paths)) {
        if (!item || typeof item !== 'object') continue;
        if (p.length > 1 && p.endsWith('/')) add('path-no-trailing-slash', ['paths', p], `${p} ends with /.`);
        const segs = p.split('/').filter((s) => s && !/^\{.*\}$/.test(s));
        if (segs.some((s) => !/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)?$/.test(s))) add('path-kebab-case', ['paths', p], `${p}: use lower case with words joined by - (e.g. /order-lines).`);
        const inPath = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
        const shared = (item.parameters ?? []) as any[];
        for (const m of METHODS) {
            const op = item[m];
            if (!op || typeof op !== 'object') continue;
            const here: Array<string | number> = ['paths', p, m];
            const where = `${m.toUpperCase()} ${p}`;
            if (!op.operationId) add('operation-operationId', here, `${where} has no operationId.`);
            else ids.set(op.operationId, [...(ids.get(op.operationId) ?? []), [...here, 'operationId']]);
            if (!op.summary) add('operation-summary', here, `${where} has no summary.`);
            if (!op.tags?.length) add('operation-tags', here, `${where} has no tag.`);
            const codes = Object.keys(op.responses ?? {});
            if (!codes.some((c) => /^[23]/.test(c) || /^[23]XX$/i.test(c))) add('operation-success-response', [...here, 'responses'], `${where} has no success (2xx or 3xx) response.`);
            const resolveParam = (x: any) => (x?.$ref ? x.$ref.replace(/^#\//, '').split('/').reduce((o: any, k: string) => o?.[unescape(k)], api) : x);
            const declared = [...shared, ...(op.parameters ?? [])].map(resolveParam).filter((x) => x?.in === 'path').map((x) => x.name);
            for (const name of inPath) if (!declared.includes(name)) add('path-params-defined', here, `${where}: {${name}} is in the path but not declared as a path parameter.`);
            for (const name of declared) if (!inPath.includes(name)) add('path-params-defined', here, `${where}: the path parameter "${name}" is not in the path.`);
            // Request body example (3.x).
            if (v3 && op.requestBody) {
                const rb = op.requestBody.$ref ? resolveParam(op.requestBody) : op.requestBody;
                const media = Object.values((rb?.content ?? {}) as Record<string, any>);
                if (media.length && !media.some((mt) => mt.example !== undefined || mt.examples || mt.schema?.example !== undefined)) add('request-body-example', [...here, 'requestBody'], `${where}: the request body has no example.`);
            }
            // JSON success responses have a schema.
            for (const c of codes.filter((x) => /^2/.test(x) && x !== '204')) {
                const r = resolveParam(op.responses[c]);
                if (v3) { const json = Object.entries((r?.content ?? {}) as Record<string, any>).find(([ct]) => /json/.test(ct)); if (json && !json[1].schema) add('response-schema', [...here, 'responses', c], `${where} ${c}: the JSON response has no schema.`); }
                else if (r && !r.schema && (op.produces ?? api.produces ?? ['application/json']).some((x: string) => /json/.test(x))) add('response-schema', [...here, 'responses', c], `${where} ${c}: the response has no schema.`);
            }
        }
    }
    for (const [id, places] of ids) if (places.length > 1) for (const pl of places) add('operation-operationId-unique', pl, `The operationId "${id}" is used ${places.length} times.`, false);
    // Servers, security, contact.
    const servers: string[] = v3 ? (api.servers ?? []).map((s: any) => String(s.url ?? '')) : api.host ? (api.schemes ?? ['http']).map((s: string) => `${s}://${api.host}`) : [];
    servers.forEach((u, i) => { if (/^http:\/\//i.test(u) && !/localhost|127\.0\.0\.1/.test(u)) add('servers-https', v3 ? ['servers', i, 'url'] : ['schemes'], `The server ${u} is not https.`, false); });
    const anySecurity = Array.isArray(api.security) || Object.values(paths).some((it: any) => METHODS.some((m) => Array.isArray(it?.[m]?.security)));
    if (!anySecurity) add('security-defined', [], 'The API does not say how it is secured (security): add the scheme your service uses, or security: [] for an open API.');
    if (!api.info?.contact) add('info-contact', ['info'], 'info has no contact (who to ask about this API).');
    // Unused component schemas.
    if (sev('no-unused-components') !== 'off') {
        const defs = v3 ? Object.keys(api.components?.schemas ?? {}) : Object.keys(api.definitions ?? {});
        const all = JSON.stringify({ ...api, components: { ...(api.components ?? {}), schemas: undefined }, definitions: undefined });
        const allSchemas = JSON.stringify(v3 ? api.components?.schemas ?? {} : api.definitions ?? {});
        for (const d of defs) {
            const ref = v3 ? `#/components/schemas/${d}` : `#/definitions/${d}`;
            if (!all.includes(`"${ref}"`) && !allSchemas.includes(`"${ref}"`)) add('no-unused-components', v3 ? ['components', 'schemas', d] : ['definitions', d], `The schema ${d} is not used.`);
        }
    }
    return out.sort((a, b) => a.line - b.line || a.column - b.column);
}
