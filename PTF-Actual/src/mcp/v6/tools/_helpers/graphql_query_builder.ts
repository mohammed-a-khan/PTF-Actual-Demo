/**
 * GraphQL query/mutation builder — turns a normalized ParsedGraphqlSchema and
 * a chosen operation into a set of `BuiltCase` objects:
 *
 *   happy-path              — a syntactically valid, semantically well-formed
 *                             query/mutation/subscription with all required args
 *                             filled with representative values and the return
 *                             selection expanded (recursively, bounded depth).
 *   missing-required-arg    — same shape as happy-path, but one required
 *                             argument is omitted. GraphQL servers MUST reject.
 *   invalid-type            — a scalar arg is coerced to the wrong type
 *                             (String→Int or Int→String) so validation fails.
 *   extra-field             — the return selection includes a field that does
 *                             not exist on the return type.
 *   unauthenticated         — same as happy-path, but the generated test omits
 *                             the Authorization header (rendered as a hint —
 *                             the actual header suppression happens in the
 *                             test runner).
 *   forbidden               — same as happy-path but the test injects a
 *                             `Bearer invalid` token instead of a real one.
 *
 * Depth cap = 3 so cyclic return types (User → Team → User → ...) terminate.
 */
import type {
    ParsedGraphqlSchema,
    GraphqlField,
    GraphqlFieldArg,
    GraphqlOperation,
    GraphqlTypeInfo,
} from './graphql_schema_loader';

export type CaseKind =
    | 'happy'
    | 'missing-required-arg'
    | 'invalid-type'
    | 'extra-field'
    | 'unauthenticated'
    | 'forbidden';

export interface BuiltCase {
    kind: CaseKind;
    /** Rendered GraphQL document. */
    query: string;
    /** Variables — always JSON-safe. */
    variables: Record<string, unknown>;
    /** Human-readable label for the scenario (e.g. "missing required arg id"). */
    label: string;
    /** For missing-required-arg: the arg name that was omitted. */
    omittedArg?: string;
    /** For invalid-type: the arg name that was coerced. */
    coercedArg?: string;
    /** For extra-field: the name of the fabricated selection. */
    extraFieldName?: string;
    /** For happy-path only: a representative scalar field the test can assert on. */
    assertField?: string;
    /** Whether the test runner should attach an Authorization header. */
    includeAuthHeader: boolean;
    /** If set, override the Authorization value the test runner sends. */
    authHeaderOverride?: string;
    /** Whether we expect an ERROR response (any of: HTTP non-200, errors[] non-empty). */
    expectError: boolean;
    /** Optional hint about what the server should say — used in .feature Then clauses. */
    expectedErrorHint?: string;
}

const SCALAR_BASE = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function isScalarBaseType(base: string, schema: ParsedGraphqlSchema): boolean {
    if (SCALAR_BASE.has(base)) return true;
    const t = schema.types[base];
    return !!t && t.kind === 'SCALAR';
}

function sampleScalarValue(base: string): unknown {
    switch (base) {
        case 'String': return '?';
        case 'ID': return '1';
        case 'Int': return 0;
        case 'Float': return 0;
        case 'Boolean': return true;
        case 'Date':
        case 'DateTime':
        case 'ISODateTime':
        case 'Timestamp':
            return new Date(0).toISOString();
        default:
            return '?';
    }
}

function sampleForArg(arg: GraphqlFieldArg, schema: ParsedGraphqlSchema, depth = 0): unknown {
    const base = arg.type.replace(/[!\[\]]/g, '');
    if (arg.isList) {
        return [sampleScalarForBase(base, schema, depth)];
    }
    return sampleScalarForBase(base, schema, depth);
}

function sampleScalarForBase(base: string, schema: ParsedGraphqlSchema, depth: number): unknown {
    if (isScalarBaseType(base, schema)) return sampleScalarValue(base);
    const t = schema.types[base];
    if (!t) return sampleScalarValue('String');
    if (t.kind === 'ENUM' && t.enumValues && t.enumValues.length > 0) return t.enumValues[0];
    if (t.kind === 'INPUT_OBJECT' && t.fields) {
        if (depth >= 3) return {};
        const obj: Record<string, unknown> = {};
        for (const f of t.fields) {
            if (!f.isRequired) continue;
            obj[f.name] = sampleForArg({ name: f.name, type: f.type, isRequired: f.isRequired, isList: f.isList }, schema, depth + 1);
        }
        return obj;
    }
    return sampleScalarValue('String');
}

/**
 * Return a selection block for `typeName`. For scalar/enum types this is empty
 * (leaf). For OBJECT/INTERFACE/UNION types we recursively pick scalars + one
 * representative sub-object per object field, bounded by `depth`.
 */
function buildSelection(typeName: string, schema: ParsedGraphqlSchema, depth: number, visited: Set<string>): string {
    if (depth <= 0) {
        // Depth exhausted — pick any scalar field to keep the selection non-empty.
        const scalar = findAnyScalarField(typeName, schema);
        return scalar ? `{ ${scalar} }` : '';
    }
    const t = schema.types[typeName];
    if (!t) return '';
    if (t.kind === 'SCALAR' || t.kind === 'ENUM') return '';
    if (t.kind === 'UNION') {
        // Emit __typename plus scalar-only inline fragments for each possible type.
        const inlineParts = (t.possibleTypes || []).slice(0, 3).map((pt) => {
            const sub = buildScalarOnlySelection(pt, schema);
            return sub ? `... on ${pt} ${sub}` : '';
        }).filter(Boolean);
        return `{ __typename ${inlineParts.join(' ')} }`;
    }
    // OBJECT or INTERFACE.
    if (visited.has(typeName)) {
        const scalar = findAnyScalarField(typeName, schema);
        return scalar ? `{ ${scalar} }` : '';
    }
    const nextVisited = new Set(visited);
    nextVisited.add(typeName);
    const fields = t.fields || [];
    if (fields.length === 0) return '';
    const parts: string[] = [];
    let subObjectCount = 0;
    for (const f of fields) {
        if (isScalarBaseType(f.baseType, schema) || schema.types[f.baseType]?.kind === 'ENUM') {
            // Args on scalar fields: skip if any are required (we'd need values).
            if (f.args.some((a) => a.isRequired)) continue;
            parts.push(f.name);
        } else {
            // Object/interface/union field. Include at most 2 sub-objects to
            // keep queries readable.
            if (subObjectCount >= 2) continue;
            if (f.args.some((a) => a.isRequired)) continue;
            const sub = buildSelection(f.baseType, schema, depth - 1, nextVisited);
            if (sub) {
                parts.push(`${f.name} ${sub}`);
                subObjectCount++;
            }
        }
    }
    if (parts.length === 0) {
        parts.push('__typename');
    }
    return `{ ${parts.join(' ')} }`;
}

function buildScalarOnlySelection(typeName: string, schema: ParsedGraphqlSchema): string {
    const t = schema.types[typeName];
    if (!t || !t.fields) return '';
    const scalars = t.fields
        .filter((f) => isScalarBaseType(f.baseType, schema) || schema.types[f.baseType]?.kind === 'ENUM')
        .filter((f) => !f.args.some((a) => a.isRequired))
        .map((f) => f.name);
    if (scalars.length === 0) return '{ __typename }';
    return `{ ${scalars.join(' ')} }`;
}

function findAnyScalarField(typeName: string, schema: ParsedGraphqlSchema): string | null {
    const t = schema.types[typeName];
    if (!t || !t.fields) return null;
    for (const f of t.fields) {
        if (isScalarBaseType(f.baseType, schema) || schema.types[f.baseType]?.kind === 'ENUM') {
            if (!f.args.some((a) => a.isRequired)) return f.name;
        }
    }
    return null;
}

function pickRepresentativeScalarField(returnBaseType: string, schema: ParsedGraphqlSchema): string {
    // For happy-path assertion — first scalar field, else __typename.
    if (isScalarBaseType(returnBaseType, schema)) return returnBaseType.toLowerCase();
    const scalar = findAnyScalarField(returnBaseType, schema);
    return scalar || '__typename';
}

function renderOperation(
    opKind: 'query' | 'mutation' | 'subscription',
    op: GraphqlOperation,
    args: GraphqlFieldArg[],
    selection: string,
    variables: Record<string, unknown>,
    extraFieldName?: string,
): string {
    // Variable declarations for anything we're actually passing.
    const varDecls = args
        .filter((a) => variables[a.name] !== undefined)
        .map((a) => `$${a.name}: ${a.type}`)
        .join(', ');
    const argList = args
        .filter((a) => variables[a.name] !== undefined)
        .map((a) => `${a.name}: $${a.name}`)
        .join(', ');
    const opName = `${opKind}_${op.name}`;
    const header = varDecls ? `${opKind} ${opName}(${varDecls})` : `${opKind} ${opName}`;
    const argsPart = argList ? `(${argList})` : '';
    // If we're injecting an extra bogus field, mutate the selection.
    let finalSelection = selection;
    if (extraFieldName) {
        if (finalSelection && finalSelection.startsWith('{')) {
            finalSelection = finalSelection.replace('{', `{ ${extraFieldName} `);
        } else {
            finalSelection = `{ ${extraFieldName} }`;
        }
    } else if (!finalSelection || finalSelection === '') {
        // Scalar return — no selection block.
        finalSelection = '';
    }
    const body = finalSelection
        ? `  ${op.name}${argsPart} ${finalSelection}`
        : `  ${op.name}${argsPart}`;
    return `${header} {\n${body}\n}`;
}

function coerceWrongType(arg: GraphqlFieldArg): unknown {
    const base = arg.type.replace(/[!\[\]]/g, '');
    switch (base) {
        case 'String':
        case 'ID':
            return 12345; // number where a string is expected
        case 'Int':
        case 'Float':
            return 'not-a-number';
        case 'Boolean':
            return 'not-a-boolean';
        default:
            return { unexpected: 'object' };
    }
}

export function buildCasesForOperation(
    schema: ParsedGraphqlSchema,
    opKind: 'query' | 'mutation' | 'subscription',
    op: GraphqlOperation,
    opts: { generateNegativeCases: boolean; generateAuthCases: boolean },
): BuiltCase[] {
    const out: BuiltCase[] = [];
    const selection = buildSelection(op.returnBaseType, schema, 3, new Set());
    const happyVars: Record<string, unknown> = {};
    for (const a of op.args) {
        happyVars[a.name] = sampleForArg(a, schema);
    }
    const happyQuery = renderOperation(opKind, op, op.args, selection, happyVars);
    const assertField = pickRepresentativeScalarField(op.returnBaseType, schema);
    out.push({
        kind: 'happy',
        query: happyQuery,
        variables: happyVars,
        label: `happy path ${op.name}`,
        assertField,
        includeAuthHeader: true,
        expectError: false,
    });

    if (opts.generateNegativeCases) {
        // missing-required-arg — one case per required arg (bounded to first).
        const requiredArgs = op.args.filter((a) => a.isRequired);
        if (requiredArgs.length > 0) {
            const omit = requiredArgs[0];
            const partialVars: Record<string, unknown> = {};
            for (const a of op.args) {
                if (a.name === omit.name) continue;
                partialVars[a.name] = sampleForArg(a, schema);
            }
            const argsMinusOmit = op.args.filter((a) => a.name !== omit.name);
            const q = renderOperation(opKind, op, argsMinusOmit, selection, partialVars);
            out.push({
                kind: 'missing-required-arg',
                query: q,
                variables: partialVars,
                label: `missing required arg ${omit.name}`,
                omittedArg: omit.name,
                includeAuthHeader: true,
                expectError: true,
                expectedErrorHint: `required argument "${omit.name}" is not provided`,
            });
        }

        // invalid-type — first scalar arg with wrong type.
        const scalarArg = op.args.find((a) => {
            const base = a.type.replace(/[!\[\]]/g, '');
            return SCALAR_BASE.has(base);
        });
        if (scalarArg) {
            const badVars: Record<string, unknown> = {};
            for (const a of op.args) {
                badVars[a.name] = a.name === scalarArg.name ? coerceWrongType(scalarArg) : sampleForArg(a, schema);
            }
            const q = renderOperation(opKind, op, op.args, selection, badVars);
            out.push({
                kind: 'invalid-type',
                query: q,
                variables: badVars,
                label: `invalid type for arg ${scalarArg.name}`,
                coercedArg: scalarArg.name,
                includeAuthHeader: true,
                expectError: true,
                expectedErrorHint: `arg "${scalarArg.name}" received a value of the wrong type`,
            });
        }

        // extra-field — inject a fabricated selection.
        const bogusField = `__bogusField_${op.name}`;
        const returnType = schema.types[op.returnBaseType];
        if (returnType && (returnType.kind === 'OBJECT' || returnType.kind === 'INTERFACE')) {
            const q = renderOperation(opKind, op, op.args, selection, happyVars, bogusField);
            out.push({
                kind: 'extra-field',
                query: q,
                variables: happyVars,
                label: `unknown field on return type`,
                extraFieldName: bogusField,
                includeAuthHeader: true,
                expectError: true,
                expectedErrorHint: `Cannot query field "${bogusField}"`,
            });
        }
    }

    if (opts.generateAuthCases) {
        out.push({
            kind: 'unauthenticated',
            query: happyQuery,
            variables: happyVars,
            label: `unauthenticated ${op.name}`,
            includeAuthHeader: false,
            expectError: true,
            expectedErrorHint: 'UNAUTHENTICATED or HTTP 401',
        });
        out.push({
            kind: 'forbidden',
            query: happyQuery,
            variables: happyVars,
            label: `forbidden ${op.name}`,
            includeAuthHeader: true,
            authHeaderOverride: 'Bearer invalid',
            expectError: true,
            expectedErrorHint: 'FORBIDDEN or HTTP 403',
        });
    }

    return out;
}

// -----------------------------------------------------------------------------
// Filters + kind helpers exposed to the tool.
// -----------------------------------------------------------------------------

export interface OpFilter {
    queries?: string[];
    mutations?: string[];
    subscriptions?: string[];
}

export function filterOperations(schema: ParsedGraphqlSchema, filter?: OpFilter): {
    queries: GraphqlOperation[];
    mutations: GraphqlOperation[];
    subscriptions: GraphqlOperation[];
} {
    const inSet = (arr: string[] | undefined, name: string): boolean => {
        if (!arr || arr.length === 0) return true;
        return arr.map((s) => s.toLowerCase()).includes(name.toLowerCase());
    };
    return {
        queries: schema.queries.filter((o) => inSet(filter?.queries, o.name)),
        mutations: schema.mutations.filter((o) => inSet(filter?.mutations, o.name)),
        subscriptions: schema.subscriptions.filter((o) => inSet(filter?.subscriptions, o.name)),
    };
}

/** Utility for the tool + smoke tests: strip a rendered SDL type of wrappers. */
export function stripTypeWrappers(t: string): string {
    return t.replace(/[!\[\]]/g, '');
}

/** Exposed for smoke tests. */
export function _buildSelectionForTest(returnBaseType: string, schema: ParsedGraphqlSchema, depth = 3): string {
    return buildSelection(returnBaseType, schema, depth, new Set());
}

/**
 * Rebuilds a field-object as-if a GraphqlOperation (for tests). Not used at
 * runtime by the tool itself but handy for asserting the builder handles a
 * given operation shape.
 */
export function _fieldToOp(f: GraphqlField): GraphqlOperation {
    return {
        name: f.name, args: f.args, returnType: f.type, returnBaseType: f.baseType,
        returnIsList: f.isList, returnIsRequired: f.isRequired, description: f.description,
    };
}
