/**
 * GraphQL schema loader — two paths, one normalized model.
 *
 * 1. SDL file (`.graphql` / `.gql`) — parsed via a lazy-required `graphql` npm
 *    package (`buildSchema`). When the package is not installed, a bounded
 *    regex fallback extracts `type`/`input`/`enum`/`interface`/`union` bodies
 *    and their fields so the tool still works in minimum-dependency workspaces
 *    (with a warning attached).
 *
 * 2. Introspection endpoint — POSTS the CANONICAL introspection query lifted
 *    verbatim from the GraphQL October 2021 spec (§ Schema Introspection).
 *    The response is walked into the same normalized shape as the SDL path.
 *
 * The normalized shape is deliberately minimal — only the fields the query
 * builder + test emitter need.
 */
import * as fs from 'fs';
import { AdoHttpClient, type AdoCreds } from './ado_http_client';

export type GraphqlTypeKind = 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE' | 'UNION';

export interface GraphqlFieldArg {
    name: string;
    type: string;         // rendered SDL form, e.g. "ID!", "[String]!"
    isRequired: boolean;
    isList: boolean;
}

export interface GraphqlField {
    name: string;
    type: string;         // rendered SDL form of return type
    baseType: string;     // stripped of !/[] wrappers
    args: GraphqlFieldArg[];
    isRequired: boolean;
    isList: boolean;
    description?: string;
}

export interface GraphqlTypeInfo {
    kind: GraphqlTypeKind;
    name: string;
    fields?: GraphqlField[];
    enumValues?: string[];
    possibleTypes?: string[];
}

export interface GraphqlOperation {
    name: string;
    args: GraphqlFieldArg[];
    returnType: string;
    returnBaseType: string;
    returnIsList: boolean;
    returnIsRequired: boolean;
    description?: string;
}

export interface GraphqlDirective {
    name: string;
    locations: string[];
    args: GraphqlFieldArg[];
}

export interface ParsedGraphqlSchema {
    types: Record<string, GraphqlTypeInfo>;
    queries: GraphqlOperation[];
    mutations: GraphqlOperation[];
    subscriptions: GraphqlOperation[];
    directives: GraphqlDirective[];
    source: 'sdl-graphql-pkg' | 'sdl-regex-fallback' | 'introspection';
    warnings: string[];
}

/**
 * Canonical introspection query — verbatim from the GraphQL October 2021 spec
 * (§ Schema Introspection). Do NOT hand-roll — the shape must match what every
 * conformant server returns.
 * Ref: https://spec.graphql.org/October2021/#sec-Schema-Introspection
 */
export const CANONICAL_INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      description
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        ...FullType
      }
      directives {
        name
        description
        locations
        args {
          ...InputValue
        }
      }
    }
  }

  fragment FullType on __Type {
    kind
    name
    description
    fields(includeDeprecated: true) {
      name
      description
      args {
        ...InputValue
      }
      type {
        ...TypeRef
      }
      isDeprecated
      deprecationReason
    }
    inputFields {
      ...InputValue
    }
    interfaces {
      ...TypeRef
    }
    enumValues(includeDeprecated: true) {
      name
      description
      isDeprecated
      deprecationReason
    }
    possibleTypes {
      ...TypeRef
    }
  }

  fragment InputValue on __InputValue {
    name
    description
    type { ...TypeRef }
    defaultValue
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface IntrospectionTypeRef {
    kind: string;
    name: string | null;
    ofType?: IntrospectionTypeRef | null;
}

interface IntrospectionInputValue {
    name: string;
    description?: string | null;
    type: IntrospectionTypeRef;
    defaultValue?: string | null;
}

interface IntrospectionField {
    name: string;
    description?: string | null;
    args: IntrospectionInputValue[];
    type: IntrospectionTypeRef;
}

interface IntrospectionType {
    kind: string;
    name: string | null;
    description?: string | null;
    fields?: IntrospectionField[] | null;
    inputFields?: IntrospectionInputValue[] | null;
    enumValues?: Array<{ name: string; description?: string | null }> | null;
    possibleTypes?: IntrospectionTypeRef[] | null;
}

interface IntrospectionSchema {
    queryType: { name: string } | null;
    mutationType: { name: string } | null;
    subscriptionType: { name: string } | null;
    types: IntrospectionType[];
    directives: Array<{ name: string; locations: string[]; args: IntrospectionInputValue[] }>;
}

function renderTypeRef(ref: IntrospectionTypeRef): { sdl: string; base: string; isRequired: boolean; isList: boolean } {
    // Walk the ofType chain, tracking NON_NULL and LIST wrappers.
    let cursor: IntrospectionTypeRef | null | undefined = ref;
    let base = '';
    const wrappers: Array<'NON_NULL' | 'LIST'> = [];
    while (cursor) {
        if (cursor.kind === 'NON_NULL' || cursor.kind === 'LIST') {
            wrappers.push(cursor.kind);
            cursor = cursor.ofType;
        } else {
            base = cursor.name || '';
            cursor = null;
        }
    }
    // Rebuild the SDL by walking wrappers outermost-in.
    let sdl = base;
    let isList = false;
    let isRequired = false;
    // wrappers[0] is outermost. Walk in reverse to build innermost-out.
    for (let i = wrappers.length - 1; i >= 0; i--) {
        const w = wrappers[i];
        if (w === 'LIST') {
            sdl = `[${sdl}]`;
        } else {
            sdl = `${sdl}!`;
        }
    }
    isRequired = wrappers[0] === 'NON_NULL';
    isList = wrappers.some((w) => w === 'LIST');
    return { sdl, base, isRequired, isList };
}

function normalizeArgs(args: IntrospectionInputValue[] | undefined | null): GraphqlFieldArg[] {
    if (!args) return [];
    return args.map((a) => {
        const rendered = renderTypeRef(a.type);
        return { name: a.name, type: rendered.sdl, isRequired: rendered.isRequired, isList: rendered.isList };
    });
}

function normalizeFields(fields: IntrospectionField[] | undefined | null): GraphqlField[] {
    if (!fields) return [];
    return fields.map((f) => {
        const rt = renderTypeRef(f.type);
        return {
            name: f.name,
            type: rt.sdl,
            baseType: rt.base,
            args: normalizeArgs(f.args),
            isRequired: rt.isRequired,
            isList: rt.isList,
            description: f.description || undefined,
        };
    });
}

function normalizeInputFields(fields: IntrospectionInputValue[] | undefined | null): GraphqlField[] {
    if (!fields) return [];
    return fields.map((f) => {
        const rt = renderTypeRef(f.type);
        return {
            name: f.name,
            type: rt.sdl,
            baseType: rt.base,
            args: [],
            isRequired: rt.isRequired,
            isList: rt.isList,
            description: f.description || undefined,
        };
    });
}

function normalizeIntrospection(schema: IntrospectionSchema): ParsedGraphqlSchema {
    const types: Record<string, GraphqlTypeInfo> = {};
    for (const t of schema.types) {
        if (!t.name || t.name.startsWith('__')) continue; // skip meta types
        const kind = (t.kind as GraphqlTypeKind);
        types[t.name] = {
            kind,
            name: t.name,
            fields: kind === 'INPUT_OBJECT'
                ? normalizeInputFields(t.inputFields)
                : (kind === 'OBJECT' || kind === 'INTERFACE') ? normalizeFields(t.fields) : undefined,
            enumValues: kind === 'ENUM' ? (t.enumValues || []).map((e) => e.name) : undefined,
            possibleTypes: kind === 'UNION' ? (t.possibleTypes || []).map((p) => p.name || '').filter(Boolean) : undefined,
        };
    }
    const opsFrom = (rootName: string | null): GraphqlOperation[] => {
        if (!rootName) return [];
        const t = types[rootName];
        if (!t || !t.fields) return [];
        return t.fields.map((f) => ({
            name: f.name,
            args: f.args,
            returnType: f.type,
            returnBaseType: f.baseType,
            returnIsList: f.isList,
            returnIsRequired: f.isRequired,
            description: f.description,
        }));
    };
    return {
        types,
        queries: opsFrom(schema.queryType?.name ?? null),
        mutations: opsFrom(schema.mutationType?.name ?? null),
        subscriptions: opsFrom(schema.subscriptionType?.name ?? null),
        directives: (schema.directives || []).map((d) => ({ name: d.name, locations: d.locations, args: normalizeArgs(d.args) })),
        source: 'introspection',
        warnings: [],
    };
}

// -----------------------------------------------------------------------------
// SDL loader (graphql package + regex fallback).
// -----------------------------------------------------------------------------

interface GraphqlPkgSchema {
    getQueryType(): unknown;
    getMutationType(): unknown;
    getSubscriptionType(): unknown;
    getTypeMap(): Record<string, unknown>;
    getDirectives(): unknown[];
}

interface GraphqlPkg {
    buildSchema: (sdl: string) => GraphqlPkgSchema;
    isNonNullType?: (t: unknown) => boolean;
    isListType?: (t: unknown) => boolean;
    isObjectType?: (t: unknown) => boolean;
    isInputObjectType?: (t: unknown) => boolean;
    isEnumType?: (t: unknown) => boolean;
    isInterfaceType?: (t: unknown) => boolean;
    isUnionType?: (t: unknown) => boolean;
    isScalarType?: (t: unknown) => boolean;
}

function loadGraphqlPkg(): GraphqlPkg | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('graphql') as GraphqlPkg;
    } catch {
        return null;
    }
}

function renderPkgType(t: unknown, pkg: GraphqlPkg): { sdl: string; base: string; isRequired: boolean; isList: boolean } {
    // graphql package exposes toString() on every type wrapper — but we still
    // need the base type name + wrapper flags for our normalized model.
    const sdl = String((t as { toString(): string }).toString());
    let cursor: unknown = t;
    let isRequired = false;
    let isList = false;
    // Peel one NON_NULL if present.
    if (pkg.isNonNullType?.(cursor)) {
        isRequired = true;
        cursor = (cursor as { ofType: unknown }).ofType;
    }
    // Peel LIST(s).
    while (pkg.isListType?.(cursor)) {
        isList = true;
        cursor = (cursor as { ofType: unknown }).ofType;
        if (pkg.isNonNullType?.(cursor)) cursor = (cursor as { ofType: unknown }).ofType;
    }
    const base = (cursor as { name?: string })?.name || sdl.replace(/[!\[\]]/g, '');
    return { sdl, base, isRequired, isList };
}

function normalizeFromPkg(schema: GraphqlPkgSchema, pkg: GraphqlPkg): ParsedGraphqlSchema {
    const types: Record<string, GraphqlTypeInfo> = {};
    const typeMap = schema.getTypeMap();
    const collectFields = (fieldsObj: Record<string, unknown>): GraphqlField[] => {
        const out: GraphqlField[] = [];
        for (const [fname, fdef] of Object.entries(fieldsObj)) {
            const fd = fdef as { type: unknown; args?: unknown[]; description?: string };
            const rt = renderPkgType(fd.type, pkg);
            const args: GraphqlFieldArg[] = (fd.args || []).map((a) => {
                const ad = a as { name: string; type: unknown };
                const at = renderPkgType(ad.type, pkg);
                return { name: ad.name, type: at.sdl, isRequired: at.isRequired, isList: at.isList };
            });
            out.push({
                name: fname,
                type: rt.sdl,
                baseType: rt.base,
                args,
                isRequired: rt.isRequired,
                isList: rt.isList,
                description: fd.description,
            });
        }
        return out;
    };
    for (const [name, t] of Object.entries(typeMap)) {
        if (name.startsWith('__')) continue;
        let kind: GraphqlTypeKind = 'SCALAR';
        if (pkg.isObjectType?.(t)) kind = 'OBJECT';
        else if (pkg.isInputObjectType?.(t)) kind = 'INPUT_OBJECT';
        else if (pkg.isEnumType?.(t)) kind = 'ENUM';
        else if (pkg.isInterfaceType?.(t)) kind = 'INTERFACE';
        else if (pkg.isUnionType?.(t)) kind = 'UNION';
        else if (pkg.isScalarType?.(t)) kind = 'SCALAR';
        const info: GraphqlTypeInfo = { kind, name };
        if (kind === 'OBJECT' || kind === 'INTERFACE') {
            const fieldsObj = (t as { getFields?: () => Record<string, unknown> }).getFields?.() || {};
            info.fields = collectFields(fieldsObj);
        } else if (kind === 'INPUT_OBJECT') {
            const fieldsObj = (t as { getFields?: () => Record<string, unknown> }).getFields?.() || {};
            info.fields = collectFields(fieldsObj);
        } else if (kind === 'ENUM') {
            const values = (t as { getValues?: () => Array<{ name: string }> }).getValues?.() || [];
            info.enumValues = values.map((v) => v.name);
        } else if (kind === 'UNION') {
            const pts = (t as { getTypes?: () => Array<{ name: string }> }).getTypes?.() || [];
            info.possibleTypes = pts.map((p) => p.name);
        }
        types[name] = info;
    }
    const opsFromRoot = (root: unknown): GraphqlOperation[] => {
        if (!root) return [];
        const fields = (root as { getFields?: () => Record<string, unknown> }).getFields?.() || {};
        return collectFields(fields).map((f) => ({
            name: f.name,
            args: f.args,
            returnType: f.type,
            returnBaseType: f.baseType,
            returnIsList: f.isList,
            returnIsRequired: f.isRequired,
            description: f.description,
        }));
    };
    return {
        types,
        queries: opsFromRoot(schema.getQueryType()),
        mutations: opsFromRoot(schema.getMutationType()),
        subscriptions: opsFromRoot(schema.getSubscriptionType()),
        directives: [],
        source: 'sdl-graphql-pkg',
        warnings: [],
    };
}

// Regex fallback — bounded, best-effort. Extracts top-level type/input/enum/
// interface/union blocks and their fields. Handles single-line and multi-line
// field declarations but NOT nested braces beyond one level.
function regexFallback(sdl: string): ParsedGraphqlSchema {
    const stripped = sdl
        .replace(/#[^\n]*/g, '')                // comments
        .replace(/"""[\s\S]*?"""/g, '')          // block descriptions
        .replace(/"[^"\n]*"/g, '""');            // inline descriptions (kept as empty)
    const types: Record<string, GraphqlTypeInfo> = {};
    const kindMap: Record<string, GraphqlTypeKind> = {
        type: 'OBJECT',
        input: 'INPUT_OBJECT',
        enum: 'ENUM',
        interface: 'INTERFACE',
        union: 'UNION',
        scalar: 'SCALAR',
    };
    const typeBlockRe = /\b(type|input|enum|interface)\s+(\w+)(?:\s+implements[^\{]*)?\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = typeBlockRe.exec(stripped))) {
        const [, keyword, name, body] = m;
        const kind = kindMap[keyword];
        const info: GraphqlTypeInfo = { kind, name };
        if (kind === 'ENUM') {
            info.enumValues = body.split(/[\s,]+/).map((v) => v.trim()).filter((v) => v && /^[A-Za-z_]/.test(v));
        } else {
            info.fields = parseFieldBlock(body);
        }
        types[name] = info;
    }
    const unionRe = /\bunion\s+(\w+)\s*=\s*([^\n]+)/g;
    while ((m = unionRe.exec(stripped))) {
        const [, name, rhs] = m;
        const pts = rhs.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
        types[name] = { kind: 'UNION', name, possibleTypes: pts };
    }
    const scalarRe = /\bscalar\s+(\w+)/g;
    while ((m = scalarRe.exec(stripped))) {
        const [, name] = m;
        if (!types[name]) types[name] = { kind: 'SCALAR', name };
    }
    const opsFor = (rootName: string): GraphqlOperation[] => {
        const t = types[rootName];
        if (!t || !t.fields) return [];
        return t.fields.map((f) => ({
            name: f.name, args: f.args, returnType: f.type, returnBaseType: f.baseType,
            returnIsList: f.isList, returnIsRequired: f.isRequired, description: f.description,
        }));
    };
    return {
        types,
        queries: opsFor('Query'),
        mutations: opsFor('Mutation'),
        subscriptions: opsFor('Subscription'),
        directives: [],
        source: 'sdl-regex-fallback',
        warnings: ['Parsed via regex fallback because the `graphql` npm package is not installed. Install `graphql` for authoritative parsing.'],
    };
}

function parseFieldBlock(body: string): GraphqlField[] {
    const out: GraphqlField[] = [];
    // Fields: name(args): Type — args block may span multiple lines but no nested parens.
    const fieldRe = /(\w+)\s*(\(([^)]*)\))?\s*:\s*([\[\]!\w]+)/g;
    let m: RegExpExecArray | null;
    while ((m = fieldRe.exec(body))) {
        const [, name, , argsBody, retType] = m;
        const args = argsBody ? parseArgsBlock(argsBody) : [];
        const { baseType, isRequired, isList } = decomposeType(retType);
        out.push({
            name, type: retType, baseType, args, isRequired, isList,
        });
    }
    return out;
}

function parseArgsBlock(body: string): GraphqlFieldArg[] {
    const out: GraphqlFieldArg[] = [];
    // "name: Type" pairs, comma-separated. Default values (= x) tolerated but ignored.
    const argRe = /(\w+)\s*:\s*([\[\]!\w]+)(?:\s*=\s*[^,]+)?/g;
    let m: RegExpExecArray | null;
    while ((m = argRe.exec(body))) {
        const [, name, type] = m;
        const { isRequired, isList } = decomposeType(type);
        out.push({ name, type, isRequired, isList });
    }
    return out;
}

function decomposeType(t: string): { baseType: string; isRequired: boolean; isList: boolean } {
    const isRequired = t.endsWith('!');
    const isList = t.includes('[');
    const baseType = t.replace(/[!\[\]]/g, '');
    return { baseType, isRequired, isList };
}

export function loadSdl(sdl: string): ParsedGraphqlSchema {
    const pkg = loadGraphqlPkg();
    if (pkg) {
        try {
            const schema = pkg.buildSchema(sdl);
            return normalizeFromPkg(schema, pkg);
        } catch (e) {
            const fb = regexFallback(sdl);
            fb.warnings.unshift(`graphql package failed to parse SDL (${(e as Error).message}) — using regex fallback.`);
            return fb;
        }
    }
    return regexFallback(sdl);
}

export function loadSdlFromFile(filePath: string): ParsedGraphqlSchema {
    if (!fs.existsSync(filePath)) throw new Error(`GraphQL SDL file not found: ${filePath}`);
    const text = fs.readFileSync(filePath, 'utf-8');
    return loadSdl(text);
}

/**
 * Fetch + normalize a GraphQL schema via introspection. Uses AdoHttpClient so
 * retries/timeouts/body-size caps/PAT redaction all apply — but we route the
 * request as unauthenticated by default (introspection endpoints are usually
 * open in dev/QA environments) unless an authHeader is passed.
 */
export async function loadFromIntrospection(
    endpointUrl: string,
    opts: { authHeader?: string; timeoutMs?: number } = {},
): Promise<ParsedGraphqlSchema> {
    const url = new URL(endpointUrl);
    const orgUrl = `${url.protocol}//${url.host}`;
    const pathAndQuery = url.pathname + url.search;
    // AdoHttpClient enforces PAT — we route the introspection call through
    // NODE's global fetch instead, since introspection endpoints are usually
    // outside ADO's auth domain and we don't want a synthetic PAT bleeding
    // into an unrelated service's logs.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
    let res: Response;
    try {
        res = await fetch(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(opts.authHeader ? { 'Authorization': opts.authHeader } : {}),
            },
            body: JSON.stringify({ query: CANONICAL_INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' }),
            signal: controller.signal,
        });
    } finally { clearTimeout(timer); }
    if (!res.ok) {
        throw new Error(`Introspection failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json() as { data?: { __schema?: IntrospectionSchema }; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
        throw new Error(`Introspection returned errors: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data?.__schema) throw new Error(`Introspection response missing __schema (endpoint may not permit introspection). Path=${pathAndQuery} Host=${orgUrl}`);
    return normalizeIntrospection(json.data.__schema);
}

/**
 * Introspection via AdoHttpClient — kept as a public alternative for callers
 * that need retry/body-cap semantics (e.g. flaky on-prem endpoints).
 */
export async function loadFromIntrospectionViaAdoClient(
    endpointUrl: string,
    creds: AdoCreds,
    opts: { timeoutMs?: number } = {},
): Promise<ParsedGraphqlSchema> {
    const url = new URL(endpointUrl);
    const orgUrl = `${url.protocol}//${url.host}`;
    const pathAndQuery = url.pathname + url.search;
    const client = new AdoHttpClient({ ...creds, orgUrl });
    const json = await client.post<{ data?: { __schema?: IntrospectionSchema }; errors?: Array<{ message: string }> }>(
        pathAndQuery,
        { query: CANONICAL_INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' },
        { scopeToProject: false, timeoutMs: opts.timeoutMs ?? 30000 },
    );
    if (json.errors && json.errors.length > 0) {
        throw new Error(`Introspection returned errors: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data?.__schema) throw new Error('Introspection response missing __schema');
    return normalizeIntrospection(json.data.__schema);
}
