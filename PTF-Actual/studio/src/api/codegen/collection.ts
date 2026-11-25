/**
 * A collection's own project code: its database checks ("each order should match the database")
 * and its prepared test data ("user prepares the Fetch orders request data"), as methods of a class
 * (test/<project>/helpers/<Name>ApiChecks.ts) and the steps that call them
 * (test/<project>/steps/<name>-api.steps.ts). Each method holds its settings, written out, and calls the
 * shared helper (ApiResponseChecks), like the project code teams write by hand.
 */
import { allRequests, ApiCollection, ApiPrepare, ApiRequest, DbItemsRule, slug } from '../model';
import { HELPER_CLASS, HELPER_FILE } from './helper';

export interface CollectionCode {
    /** Class name and file names (relative to the project's helpers / steps folders). */
    className: string;
    helperFile: string;
    stepsFile: string;
    helperText: string;
    stepsText: string;
    /** The step text a feature uses, per rule (dbItems check) and per request (prepare). */
    dbStep: Map<DbItemsRule, string>;
    prepareStep: Map<ApiRequest, string>;
}

const words = (s: string) => s.normalize('NFKD').replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
export const pascal = (s: string) => words(s).map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Api';
const camel = (s: string) => { const p = pascal(s); return p[0].toLowerCase() + p.slice(1); };
/** Words for a step (no quotes or characters with a meaning in step patterns). */
const stepWords = (s: string) => s.replace(/[{}()/\\"'|^$*+?[\]]/g, ' ').replace(/\s+/g, ' ').trim();

/** A TypeScript literal (single quotes, as the framework's code is written). */
export function literal(v: unknown, indent = ''): string {
    const next = indent + '    ';
    if (v === undefined || v === null) return 'undefined';
    if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
        if (v.every((x) => typeof x !== 'object' || x === null) || v.every((x) => Array.isArray(x) && x.every((y) => typeof y !== 'object'))) return `[${v.map((x) => literal(x, indent)).join(', ')}]`;
        return `[\n${v.map((x) => `${next}${literal(x, next)},`).join('\n')}\n${indent}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && x !== '' && !(Array.isArray(x) && !x.length));
    const prim = (x: unknown) => typeof x !== 'object' || x === null;
    const flat = entries.every(([, x]) => prim(x) || (Array.isArray(x) && x.every(prim)));
    if (flat) return `{ ${entries.map(([k, x]) => `${k}: ${literal(x, next)}`).join(', ')} }`;
    return `{\n${entries.map(([k, x]) => `${next}${k}: ${literal(x, next)},`).join('\n')}\n${indent}}`;
}

/** A rule as the helper takes it. */
function ruleSpec(r: DbItemsRule): Record<string, unknown> {
    return {
        items: r.items.trim(),
        connection: r.connection.trim(),
        query: r.query.trim(),
        params: r.params.map((p) => p.trim()).filter(Boolean),
        rows: r.rows?.trim() || undefined,
        matchBy: r.matchBy?.field?.trim() && r.matchBy.column?.trim() ? { field: r.matchBy.field.trim(), column: r.matchBy.column.trim(), compare: r.fields.find((f) => f.field === r.matchBy!.field)?.compare ?? 'auto' } : undefined,
        count: r.count || undefined,
        fields: r.fields.filter((f) => f.field.trim() && f.column.trim()).map((f) => ({ field: f.field.trim(), column: f.column.trim(), compare: f.compare, tolerance: f.compare === 'number' && f.tolerance !== undefined ? f.tolerance : undefined })),
        whenNoRows: r.whenNoRows?.filter((x) => x.field.trim()).map((x) => [x.field.trim(), x.value]),
    };
}

function prepareSpec(p: ApiPrepare): Record<string, unknown> {
    return {
        name: p.name.trim(),
        whenEmpty: p.whenEmpty,
        format: p.whenEmpty === 'today' || p.whenEmpty === 'previousBusinessDay' || p.whenEmpty === 'query' ? p.format || undefined : undefined,
        value: p.whenEmpty === 'text' ? p.value ?? '' : undefined,
        connection: p.whenEmpty === 'query' ? p.connection : undefined,
        query: p.whenEmpty === 'query' ? p.query : undefined,
        params: p.whenEmpty === 'query' ? p.params?.filter((x) => x.trim()) : undefined,
        column: p.whenEmpty === 'query' ? p.column || undefined : undefined,
        list: p.whenEmpty === 'query' && p.list ? true : undefined,
    };
}

/** The collection's code, or null when it has no database checks and no prepared data. */
export function collectionCode(c: ApiCollection, pkg: string): CollectionCode | null {
    const reqs = allRequests(c.items).map((x) => x.request).filter((r) => !r.ws);
    const rules = reqs.flatMap((r) => r.checks.filter((ch) => ch.kind === 'dbItems' && ch.db).map((ch) => ({ request: r, rule: ch.db! })));
    const prepared = reqs.filter((r) => (r.prepare ?? []).some((p) => p.name.trim()));
    if (!rules.length && !prepared.length) return null;
    const name = pascal(c.name);
    const className = `${name}ApiChecks`;
    const dbStep = new Map<DbItemsRule, string>();
    const prepareStep = new Map<ApiRequest, string>();
    const methods: string[] = [];
    const steps: string[] = [];
    const usedMethods = new Set<string>();
    const usedSteps = new Set<string>();
    const unique = (base: string, used: Set<string>, sep: string) => { let x = base, n = 2; while (used.has(x)) x = `${base}${sep}${n++}`; used.add(x); return x; };

    for (const r of prepared) {
        const method = unique(`prepare${pascal(r.name)}`, usedMethods, '');
        const text = unique(`user prepares the ${stepWords(r.name)} request data`, usedSteps, ' ');
        prepareStep.set(r, text);
        methods.push(`    /** Test data for "${r.name.replace(/\*\//g, '* /')}": the row's values, or defaults when it leaves them empty. */
    async ${method}(): Promise<void> {
        await this.checks.prepare(${literal((r.prepare ?? []).filter((p) => p.name.trim()).map(prepareSpec), '        ')});
    }
`);
        steps.push(`    @CSBDDStepDef('${text}')
    async ${method}(): Promise<void> {
        await this.api.${method}();
    }
`);
    }
    for (const { request, rule } of rules) {
        const title = stepWords(rule.title || 'item') || 'item';
        const method = unique(`each${pascal(title)}`, usedMethods, '');
        const text = unique(`each ${title} should match the database`, usedSteps, ' ');
        dbStep.set(rule, text);
        methods.push(`    /** Each ${title} (${rule.items}) of "${request.name.replace(/\*\//g, '* /')}" against ${rule.query} on ${rule.connection}. */
    async ${method}(): Promise<void> {
        await this.checks.checkItemsAgainstQuery(${literal(ruleSpec(rule), '        ')});
    }
`);
        steps.push(`    @CSBDDStepDef('${text}')
    async ${method}(): Promise<void> {
        await this.api.${method}();
    }
`);
    }

    const helperText = `/**
 * Checks and test data of the "${c.name.replace(/\*\//g, '* /')}" API (written by CS Test Studio from the API
 * collection; the project's own code to read and change). The settings of each check are written out
 * below; the work is done by ${HELPER_CLASS}.
 */
import { ${HELPER_CLASS} } from './${HELPER_FILE.replace(/\.ts$/, '')}';

export class ${className} {
    private static instance: ${className};
    private checks = ${HELPER_CLASS}.getInstance();

    public static getInstance(): ${className} {
        if (!${className}.instance) ${className}.instance = new ${className}();
        return ${className}.instance;
    }

${methods.join('\n')}}
`;
    const stepsText = `/**
 * Steps of the "${c.name.replace(/\*\//g, '* /')}" API (written by CS Test Studio): database checks and prepared test
 * data, done by ${className} (helpers/${className}.ts).
 */
import { CSBDDStepDef, StepDefinitions } from '${pkg}/bdd';
import { ${className} } from '../helpers/${className}';

@StepDefinitions
export class ${name}ApiSteps {
    private api = ${className}.getInstance();

${steps.join('\n')}}
`;
    return { className, helperFile: `${className}.ts`, stepsFile: `${slug(c.name)}-api.steps.ts`, helperText, stepsText, dbStep, prepareStep };
}

export { camel };
