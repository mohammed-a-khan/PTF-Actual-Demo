/**
 * JSON Schema validation with Ajv (the same engine and options as the framework's schema steps, so a schema check
 * gives the same verdict in the Studio and in a test run): draft-07 by default, 2019-09 / 2020-12 when the
 * schema's $schema says so; every keyword ($ref, oneOf/anyOf/allOf, if/then/else, formats such as date-time,
 * email, uuid, uri…); all errors reported.
 */
import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

type AnyAjv = Ajv | Ajv2019 | Ajv2020;
const engines = new Map<string, AnyAjv>();
function engine(schema: unknown): AnyAjv {
    const id = schema && typeof schema === 'object' ? String((schema as { $schema?: unknown }).$schema ?? '') : '';
    const kind = /2020-12/.test(id) ? '2020' : /2019-09/.test(id) ? '2019' : '7';
    let a = engines.get(kind);
    if (!a) {
        const opts = { allErrors: true, strict: false, validateFormats: true } as const;
        a = kind === '2020' ? new Ajv2020(opts) : kind === '2019' ? new Ajv2019(opts) : new Ajv(opts);
        addFormats(a as Ajv);
        engines.set(kind, a);
    }
    return a;
}

/** The differences between the data and the schema ("$.path: message"); empty when it matches. */
const compiled = new Map<string, ReturnType<AnyAjv['compile']>>();
export function schemaErrors(data: unknown, schema: unknown): string[] {
    // Compiled once per schema text (a load test checks every response).
    const key = JSON.stringify(schema);
    let validate = compiled.get(key);
    if (!validate) {
        try { validate = engine(schema).compile(schema as object); } catch (e) { return [`The schema is not valid: ${(e as Error).message}`]; }
        if (compiled.size > 500) compiled.clear();
        compiled.set(key, validate);
    }
    if (validate(data)) return [];
    return (validate.errors ?? []).map((e) => {
        const at = '$' + e.instancePath.replace(/\/(\d+)(?=\/|$)/g, '[$1]').replace(/\//g, '.');
        const extra = e.keyword === 'additionalProperties' ? ` (${(e.params as { additionalProperty?: string }).additionalProperty})`
            : e.keyword === 'enum' ? ` (${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})` : '';
        return `${at}: ${e.message ?? e.keyword}${extra}`;
    });
}
