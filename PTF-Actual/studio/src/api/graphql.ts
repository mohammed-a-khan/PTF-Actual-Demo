/**
 * GraphQL in the API workspace: the server's schema read by introspection, a query checked against it (the
 * errors the server would give, with line and column), an outline of the schema for the explorer, and a starting
 * query for a field (its arguments as variables, its scalar fields selected).
 */
import {
    buildClientSchema, getIntrospectionQuery, getNamedType, GraphQLField, GraphQLSchema, isEnumType, isInputObjectType, isInterfaceType, isListType,
    isNonNullType, isObjectType, isScalarType, isUnionType, parse, validate, GraphQLType, GraphQLNamedType, IntrospectionQuery,
} from 'graphql';

export const INTROSPECTION_QUERY = getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true });

export interface GqlFieldInfo { name: string; type: string; description?: string; deprecated?: string; args: Array<{ name: string; type: string; defaultValue?: string; description?: string }> }
export interface GqlTypeInfo { name: string; kind: 'object' | 'interface' | 'union' | 'enum' | 'input' | 'scalar'; description?: string; fields: GqlFieldInfo[]; values?: string[]; possible?: string[] }
export interface GqlOutline { query?: string; mutation?: string; subscription?: string; types: GqlTypeInfo[] }
export interface GqlError { message: string; line?: number; column?: number }

/** The introspection result of a response body ({"data": {...}} or the data itself). */
export function introspectionOf(body: string): IntrospectionQuery {
    let j: unknown;
    try { j = JSON.parse(body); } catch { throw new Error('The server did not answer with JSON: is this a GraphQL endpoint?'); }
    const o = j as { data?: IntrospectionQuery; errors?: Array<{ message: string }>; __schema?: unknown };
    if (o.data?.__schema) return o.data;
    if (o.__schema) return o as unknown as IntrospectionQuery;
    if (o.errors?.length) throw new Error(`The server refused introspection: ${o.errors.map((e) => e.message).join('; ')}`);
    throw new Error('No schema in the answer (introspection may be turned off on this server).');
}

export function schemaOf(intro: IntrospectionQuery): GraphQLSchema {
    return buildClientSchema(intro, { assumeValid: true });
}

/** The query checked against the schema: syntax errors, unknown fields, wrong arguments, missing selections. */
export function validateQuery(schema: GraphQLSchema, query: string): GqlError[] {
    if (!query.trim()) return [];
    try {
        const doc = parse(query);
        return validate(schema, doc).map((e) => ({ message: e.message, line: e.locations?.[0]?.line, column: e.locations?.[0]?.column }));
    } catch (e) {
        const g = e as { message: string; locations?: Array<{ line: number; column: number }> };
        return [{ message: g.message, line: g.locations?.[0]?.line, column: g.locations?.[0]?.column }];
    }
}

const fieldInfo = (f: GraphQLField<unknown, unknown> | { name: string; type: GraphQLType; description?: string | null; deprecationReason?: string | null; args?: ReadonlyArray<{ name: string; type: GraphQLType; defaultValue?: unknown; description?: string | null }> }): GqlFieldInfo => ({
    name: f.name, type: String(f.type), ...(f.description ? { description: f.description } : {}), ...(f.deprecationReason ? { deprecated: f.deprecationReason } : {}),
    args: (f.args ?? []).map((a) => ({ name: a.name, type: String(a.type), ...(a.defaultValue !== undefined ? { defaultValue: JSON.stringify(a.defaultValue) } : {}), ...(a.description ? { description: a.description } : {}) })),
});

export function outline(schema: GraphQLSchema): GqlOutline {
    const types: GqlTypeInfo[] = [];
    for (const t of Object.values(schema.getTypeMap())) {
        if (t.name.startsWith('__')) continue;
        const d = t.description ? { description: t.description } : {};
        if (isObjectType(t)) types.push({ name: t.name, kind: 'object', ...d, fields: Object.values(t.getFields()).map(fieldInfo) });
        else if (isInterfaceType(t)) types.push({ name: t.name, kind: 'interface', ...d, fields: Object.values(t.getFields()).map(fieldInfo), possible: schema.getPossibleTypes(t).map((x) => x.name) });
        else if (isUnionType(t)) types.push({ name: t.name, kind: 'union', ...d, fields: [], possible: t.getTypes().map((x) => x.name) });
        else if (isEnumType(t)) types.push({ name: t.name, kind: 'enum', ...d, fields: [], values: t.getValues().map((v) => v.name) });
        else if (isInputObjectType(t)) types.push({ name: t.name, kind: 'input', ...d, fields: Object.values(t.getFields()).map((f) => fieldInfo({ ...f, args: [] })) });
        else if (isScalarType(t)) types.push({ name: t.name, kind: 'scalar', ...d, fields: [] });
    }
    types.sort((a, b) => a.name.localeCompare(b.name));
    return { query: schema.getQueryType()?.name, mutation: schema.getMutationType()?.name, subscription: schema.getSubscriptionType()?.name, types };
}

/** A sample value for a variable of this input type. */
function sampleValue(t: GraphQLType, depth = 0): unknown {
    if (isNonNullType(t)) return sampleValue(t.ofType, depth);
    if (isListType(t)) return [sampleValue(t.ofType, depth)];
    if (isEnumType(t)) return t.getValues()[0]?.name ?? null;
    if (isInputObjectType(t)) {
        if (depth > 2) return {};
        return Object.fromEntries(Object.values(t.getFields()).filter((f) => isNonNullType(f.type)).map((f) => [f.name, sampleValue(f.type, depth + 1)]));
    }
    if (isScalarType(t)) return ({ Int: 0, Float: 0, Boolean: false, ID: '1' } as Record<string, unknown>)[t.name] ?? '';
    return null;
}

/** The selection of a type: its scalar fields; object fields one level down (no arguments needed). */
function selection(t: GraphQLNamedType, indent: string, depth: number): string {
    if (!isObjectType(t) && !isInterfaceType(t)) return isUnionType(t) ? ` {\n${indent}  __typename\n${indent}}` : '';
    const lines: string[] = [];
    for (const f of Object.values(t.getFields())) {
        if (f.args.some((a) => isNonNullType(a.type))) continue;
        const n = getNamedType(f.type);
        if (isScalarType(n) || isEnumType(n)) lines.push(`${indent}  ${f.name}`);
        else if (depth < 1) { const sub = selection(n, `${indent}  `, depth + 1); if (sub.includes('\n')) lines.push(`${indent}  ${f.name}${sub}`); }
    }
    if (!lines.length) lines.push(`${indent}  __typename`);
    return ` {\n${lines.join('\n')}\n${indent}}`;
}

/** A starting operation for a root field: its arguments as variables (with sample values), its fields selected. */
export function operationFor(schema: GraphQLSchema, root: 'query' | 'mutation' | 'subscription', fieldName: string): { query: string; variables: string; operationName: string } {
    const type = root === 'query' ? schema.getQueryType() : root === 'mutation' ? schema.getMutationType() : schema.getSubscriptionType();
    const f = type?.getFields()[fieldName];
    if (!f) throw new Error(`No ${root} field "${fieldName}".`);
    const op = fieldName[0].toUpperCase() + fieldName.slice(1);
    const defs = f.args.map((a) => `$${a.name}: ${String(a.type)}`).join(', ');
    const call = f.args.map((a) => `${a.name}: $${a.name}`).join(', ');
    const query = `${root} ${op}${defs ? `(${defs})` : ''} {\n  ${f.name}${call ? `(${call})` : ''}${selection(getNamedType(f.type), '  ', 0)}\n}`;
    const vars = Object.fromEntries(f.args.map((a) => [a.name, a.defaultValue !== undefined ? a.defaultValue : sampleValue(a.type)]));
    return { query, variables: f.args.length ? JSON.stringify(vars, null, 2) : '', operationName: op };
}
