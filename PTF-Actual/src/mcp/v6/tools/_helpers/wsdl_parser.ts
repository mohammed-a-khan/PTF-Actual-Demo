/**
 * wsdl_parser — WSDL 1.1 and 2.0 (best-effort) parser used by
 * cs_qa_gen_soap_test.
 *
 * Contract:
 *  - Accept a WSDL as a string plus a base URL/path from which relative
 *    <xsd:import> and <wsdl:import> can be resolved recursively.
 *  - Emit a `ParsedWsdl` model: services → ports → binding + operations,
 *    plus a flat map of XSD types (complex-type field lists + faults).
 *  - Loading strategy is DI'd (`resolveImport`) so tests can supply fixtures
 *    inline without touching the file system or network.
 *  - Guard against import cycles + malicious deep chains (visited set +
 *    depth 8 cap).
 *  - Use `xml2js` via `require()` when available (better fidelity for
 *    attributes and namespaces). If absent, degrade to a regex-tolerant
 *    fallback that still surfaces operations, services, ports, and top-level
 *    XSD element/complexType shapes.
 *
 * NO STUBS — the fallback is a real regex parser, not a placeholder.
 */

// =============================================================================
// Public model.
// =============================================================================

export type SoapStyle = 'document' | 'rpc';
export type SoapUse = 'literal' | 'encoded';
export type SoapVersion = '1.1' | '1.2';

export interface ParsedField {
    name: string;
    type: string;             // XSD-qualified type (e.g. "xsd:string" or "tns:Foo")
    minOccurs: number;
    maxOccurs: number | 'unbounded';
    nillable: boolean;
}

export interface ParsedType {
    /** Element name (may equal complexType name when the wrapper element carries the type inline). */
    name: string;
    kind: 'complex' | 'simple';
    fields: ParsedField[];
    /** For simple types, the XSD base (e.g. "xsd:string"). */
    base?: string;
    /** True if this element is the root wrapper for an operation input/output. */
    isWrapper?: boolean;
}

export interface ParsedFault {
    name: string;
    messageQName: string;
}

export interface ParsedOperation {
    name: string;
    /** SOAPAction header value from binding — empty string is valid. */
    soapAction: string;
    style: SoapStyle;
    use: SoapUse;
    /** Namespace of the wrapper element in the body. */
    namespace: string;
    /** Local name of the input wrapper element (usually operation name for doc/lit). */
    inputElement: string;
    /** Local name of the output wrapper element. */
    outputElement: string;
    inputTypeQName: string;
    outputTypeQName: string;
    faults: ParsedFault[];
}

export interface ParsedPort {
    name: string;
    binding: string;
    address: string;
    soapVersion: SoapVersion;
    operations: ParsedOperation[];
}

export interface ParsedService {
    name: string;
    ports: ParsedPort[];
}

export interface ParsedWsdl {
    targetNamespace: string;
    services: ParsedService[];
    /** QName-keyed map: `{ns}localName` → ParsedType. */
    types: Record<string, ParsedType>;
    /** Files that were fetched during parsing (top-level + imports). */
    imports: string[];
    /** Warnings surfaced by parser (e.g. fallback used, unresolvable import). */
    warnings: string[];
}

// =============================================================================
// Import resolver contract.
// =============================================================================

export interface ResolveImport {
    (locationOrHref: string, fromBase: string): Promise<{ text: string; resolvedBase: string } | null>;
}

// =============================================================================
// Parse entry point.
// =============================================================================

interface ParseOptions {
    text: string;
    baseHref: string;
    resolveImport?: ResolveImport;
    maxDepth?: number;
}

export async function parseWsdl(opts: ParseOptions): Promise<ParsedWsdl> {
    const warnings: string[] = [];
    const imports: string[] = [];
    const visited = new Set<string>();
    const maxDepth = Math.max(1, opts.maxDepth ?? 8);

    // Aggregate all XML text (main + recursively imported) so type resolution
    // works across import boundaries. Small SOAP-in-industry WSDLs are typically
    // <2MB after full expansion.
    const collected: Array<{ text: string; base: string }> = [];
    await collectRecursive({
        text: opts.text,
        base: opts.baseHref,
        depth: 0,
        maxDepth,
        visited,
        collected,
        imports,
        warnings,
        resolve: opts.resolveImport,
    });

    let xmlLib: XmlLib | null = tryLoadXml2js();
    if (!xmlLib) warnings.push('xml2js not installed — using regex WSDL parser. Install xml2js for higher-fidelity parsing (npm i -D xml2js @types/xml2js).');

    // Parse each collected chunk into a normalized DOM tree. If xml2js failed,
    // extract structure from regex.
    const docs: NormalizedDoc[] = [];
    for (const c of collected) {
        docs.push(xmlLib ? normalizeXml2js(await xmlLib.parseStringPromise(c.text), c.base) : normalizeRegex(c.text, c.base));
    }

    // Merge: types (XSD schemas) + messages + portTypes + bindings + services.
    const merged = mergeDocs(docs);

    // Compose the public model.
    const model: ParsedWsdl = {
        targetNamespace: merged.targetNamespace,
        services: [],
        types: {},
        imports,
        warnings,
    };

    // Types.
    for (const [qname, t] of Object.entries(merged.types)) model.types[qname] = t;

    // Walk services → ports → binding → portType → operation.
    for (const svc of merged.services) {
        const svcOut: ParsedService = { name: svc.name, ports: [] };
        for (const port of svc.ports) {
            const bindingQName = stripNsPrefix(port.binding);
            const binding = merged.bindings[bindingQName];
            if (!binding) {
                warnings.push(`Service "${svc.name}" port "${port.name}" references binding "${port.binding}" which was not found.`);
                continue;
            }
            const ptQName = stripNsPrefix(binding.type);
            const portType = merged.portTypes[ptQName];
            if (!portType) {
                warnings.push(`Binding "${bindingQName}" references portType "${binding.type}" which was not found.`);
                continue;
            }
            const ops: ParsedOperation[] = [];
            for (const bindOp of binding.operations) {
                const ptOp = portType.operations.find((o) => o.name === bindOp.name);
                if (!ptOp) {
                    warnings.push(`Binding operation "${bindOp.name}" not found in portType "${ptQName}".`);
                    continue;
                }
                const inputMsgLocal = stripNsPrefix(ptOp.inputMessage);
                const outputMsgLocal = stripNsPrefix(ptOp.outputMessage);
                const inputMsg = merged.messages[inputMsgLocal];
                const outputMsg = merged.messages[outputMsgLocal];
                const inputElement = inputMsg?.parts?.[0]?.element
                    ? stripNsPrefix(inputMsg.parts[0].element)
                    : ptOp.name;
                const outputElement = outputMsg?.parts?.[0]?.element
                    ? stripNsPrefix(outputMsg.parts[0].element)
                    : `${ptOp.name}Response`;
                const inputTypeQName = qualify(inputElement, merged.targetNamespace);
                const outputTypeQName = qualify(outputElement, merged.targetNamespace);
                const faults: ParsedFault[] = (ptOp.faults || []).map((f) => ({
                    name: f.name,
                    messageQName: f.message,
                }));
                ops.push({
                    name: bindOp.name,
                    soapAction: bindOp.soapAction || '',
                    style: bindOp.style || binding.style || 'document',
                    use: bindOp.use || 'literal',
                    namespace: merged.targetNamespace,
                    inputElement,
                    outputElement,
                    inputTypeQName,
                    outputTypeQName,
                    faults,
                });
            }
            svcOut.ports.push({
                name: port.name,
                binding: bindingQName,
                address: port.address,
                soapVersion: binding.soapVersion,
                operations: ops,
            });
        }
        model.services.push(svcOut);
    }

    return model;
}

// =============================================================================
// Recursive import collector.
// =============================================================================

async function collectRecursive(args: {
    text: string;
    base: string;
    depth: number;
    maxDepth: number;
    visited: Set<string>;
    collected: Array<{ text: string; base: string }>;
    imports: string[];
    warnings: string[];
    resolve?: ResolveImport;
}): Promise<void> {
    const key = `${args.base}#${args.depth}`;
    if (args.visited.has(args.base)) return;
    args.visited.add(args.base);
    args.imports.push(args.base);
    args.collected.push({ text: args.text, base: args.base });

    if (args.depth >= args.maxDepth) {
        args.warnings.push(`WSDL import depth cap (${args.maxDepth}) reached at ${args.base} — deeper imports skipped.`);
        return;
    }

    // Enumerate <xsd:import ... schemaLocation=".."/> and <wsdl:import ... location=".."/>
    // regardless of namespace prefix. This is a shallow textual scan — deliberately
    // cheap; the merge step handles the real work.
    const importRe = /<(?:[A-Za-z_][\w.-]*:)?import\b[^>]*?(?:schemaLocation|location)\s*=\s*["']([^"']+)["'][^>]*\/?>/g;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(args.text)) !== null) {
        const href = m[1];
        if (seen.has(href)) continue;
        seen.add(href);
        if (!args.resolve) {
            args.warnings.push(`Import "${href}" declared but no resolveImport supplied — skipped.`);
            continue;
        }
        try {
            const fetched = await args.resolve(href, args.base);
            if (!fetched) {
                args.warnings.push(`Import "${href}" could not be fetched (resolver returned null).`);
                continue;
            }
            await collectRecursive({
                text: fetched.text,
                base: fetched.resolvedBase,
                depth: args.depth + 1,
                maxDepth: args.maxDepth,
                visited: args.visited,
                collected: args.collected,
                imports: args.imports,
                warnings: args.warnings,
                resolve: args.resolve,
            });
        } catch (err) {
            args.warnings.push(`Import "${href}" fetch failed: ${(err as Error).message}`);
        }
    }
    // Silence unused var lint.
    void key;
}

// =============================================================================
// Normalized intermediate representation.
// =============================================================================

interface NormOperationBinding {
    name: string;
    soapAction?: string;
    style?: SoapStyle;
    use?: SoapUse;
}
interface NormBinding {
    name: string;
    type: string;              // portType QName
    style?: SoapStyle;
    soapVersion: SoapVersion;
    operations: NormOperationBinding[];
}
interface NormPortTypeOperation {
    name: string;
    inputMessage: string;
    outputMessage: string;
    faults: Array<{ name: string; message: string }>;
}
interface NormPortType {
    name: string;
    operations: NormPortTypeOperation[];
}
interface NormPart { name: string; element?: string; type?: string }
interface NormMessage { name: string; parts: NormPart[] }
interface NormPort {
    name: string;
    binding: string;
    address: string;
}
interface NormService {
    name: string;
    ports: NormPort[];
}
interface NormalizedDoc {
    targetNamespace: string;
    types: Record<string, ParsedType>;
    messages: Record<string, NormMessage>;
    portTypes: Record<string, NormPortType>;
    bindings: Record<string, NormBinding>;
    services: NormService[];
    base: string;
}

// Merge multiple docs (main + imports) into one. Later docs cannot override
// earlier keys — first-wins gives deterministic top-level primacy.
function mergeDocs(docs: NormalizedDoc[]): {
    targetNamespace: string;
    types: Record<string, ParsedType>;
    messages: Record<string, NormMessage>;
    portTypes: Record<string, NormPortType>;
    bindings: Record<string, NormBinding>;
    services: NormService[];
} {
    const out = {
        targetNamespace: docs[0]?.targetNamespace || '',
        types: {} as Record<string, ParsedType>,
        messages: {} as Record<string, NormMessage>,
        portTypes: {} as Record<string, NormPortType>,
        bindings: {} as Record<string, NormBinding>,
        services: [] as NormService[],
    };
    for (const d of docs) {
        for (const [k, v] of Object.entries(d.types)) if (!(k in out.types)) out.types[k] = v;
        for (const [k, v] of Object.entries(d.messages)) if (!(k in out.messages)) out.messages[k] = v;
        for (const [k, v] of Object.entries(d.portTypes)) if (!(k in out.portTypes)) out.portTypes[k] = v;
        for (const [k, v] of Object.entries(d.bindings)) if (!(k in out.bindings)) out.bindings[k] = v;
        for (const s of d.services) out.services.push(s);
    }
    return out;
}

// =============================================================================
// xml2js path.
// =============================================================================

interface XmlLib {
    parseStringPromise(s: string): Promise<Record<string, unknown>>;
}

function tryLoadXml2js(): XmlLib | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const x = require('xml2js') as { Parser: new (opts: Record<string, unknown>) => { parseStringPromise(s: string): Promise<Record<string, unknown>> } };
        const parser = new x.Parser({
            explicitArray: false,
            explicitCharkey: false,
            xmlns: false,
            preserveChildrenOrder: true,
            ignoreAttrs: false,
            attrkey: '$',
            charkey: '_',
        });
        return { parseStringPromise: (s: string) => parser.parseStringPromise(s) };
    } catch {
        return null;
    }
}

// The xml2js output collapses namespace prefixes into raw string keys like
// "wsdl:definitions". We normalize by stripping prefixes when walking.
function walkKey(obj: Record<string, unknown>, localName: string): unknown {
    for (const k of Object.keys(obj)) {
        if (stripNsPrefix(k) === localName) return obj[k];
    }
    return undefined;
}

function asArray<T>(v: T | T[] | undefined): T[] {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
}

function attr(obj: unknown, name: string): string | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const a = (obj as Record<string, unknown>).$;
    if (!a || typeof a !== 'object') return undefined;
    const v = (a as Record<string, unknown>)[name];
    return v === undefined ? undefined : String(v);
}

function normalizeXml2js(parsed: Record<string, unknown>, base: string): NormalizedDoc {
    // Top-level should be `definitions` (WSDL 1.1) or `description` (WSDL 2.0).
    const defsRaw = walkKey(parsed, 'definitions') ?? walkKey(parsed, 'description');
    if (!defsRaw || typeof defsRaw !== 'object') {
        return { targetNamespace: '', types: {}, messages: {}, portTypes: {}, bindings: {}, services: [], base };
    }
    const defs = defsRaw as Record<string, unknown>;
    const targetNamespace = attr(defs, 'targetNamespace') || '';

    // Types → xsd:schema[]
    const typesNode = walkKey(defs, 'types');
    const schemas: unknown[] = [];
    if (typesNode && typeof typesNode === 'object') {
        for (const v of asArray(walkKey(typesNode as Record<string, unknown>, 'schema') as unknown)) {
            schemas.push(v);
        }
    }
    // WSDL 2.0 also inlines schema at top-level.
    for (const v of asArray(walkKey(defs, 'schema') as unknown)) schemas.push(v);

    const types = extractXsdTypes(schemas, targetNamespace);

    // Messages.
    const messages: Record<string, NormMessage> = {};
    for (const m of asArray(walkKey(defs, 'message') as unknown)) {
        const mObj = m as Record<string, unknown>;
        const name = attr(mObj, 'name');
        if (!name) continue;
        const parts = asArray(walkKey(mObj, 'part') as unknown).map((p) => {
            const pObj = p as Record<string, unknown>;
            return { name: attr(pObj, 'name') || '', element: attr(pObj, 'element'), type: attr(pObj, 'type') };
        });
        messages[name] = { name, parts };
    }

    // PortTypes (WSDL 1.1) / interfaces (WSDL 2.0).
    const portTypes: Record<string, NormPortType> = {};
    for (const pt of asArray(walkKey(defs, 'portType') as unknown)) {
        pushPortType(pt, portTypes);
    }
    for (const pt of asArray(walkKey(defs, 'interface') as unknown)) {
        pushPortType(pt, portTypes);
    }

    // Bindings.
    const bindings: Record<string, NormBinding> = {};
    for (const b of asArray(walkKey(defs, 'binding') as unknown)) {
        const bObj = b as Record<string, unknown>;
        const name = attr(bObj, 'name');
        if (!name) continue;
        const type = attr(bObj, 'type') || '';
        // Detect SOAP version by presence of soap:binding vs soap12:binding child.
        let soapVersion: SoapVersion = '1.1';
        let style: SoapStyle = 'document';
        for (const k of Object.keys(bObj)) {
            const local = stripNsPrefix(k);
            if (local === 'binding') {
                const bindingChild = bObj[k];
                // Discriminate via the raw key prefix (soap12:binding) OR its namespace attribute.
                const rawPrefix = k.split(':')[0];
                if (rawPrefix.toLowerCase().includes('12') || rawPrefix.toLowerCase() === 'soap12') soapVersion = '1.2';
                const s = attr(bindingChild, 'style');
                if (s === 'document' || s === 'rpc') style = s;
                const transport = attr(bindingChild, 'transport') || '';
                if (transport.includes('2003/05') || transport.includes('soap12')) soapVersion = '1.2';
            }
        }
        const operations: NormOperationBinding[] = [];
        for (const op of asArray(walkKey(bObj, 'operation') as unknown)) {
            const opObj = op as Record<string, unknown>;
            const opName = attr(opObj, 'name');
            if (!opName) continue;
            // soap:operation child carries soapAction.
            let soapAction: string | undefined;
            let opStyle: SoapStyle | undefined;
            for (const kk of Object.keys(opObj)) {
                if (stripNsPrefix(kk) === 'operation') {
                    const child = opObj[kk];
                    const sa = attr(child, 'soapAction');
                    if (sa !== undefined) soapAction = sa;
                    const s = attr(child, 'style');
                    if (s === 'document' || s === 'rpc') opStyle = s;
                }
            }
            // Look at input/body for `use`.
            let use: SoapUse = 'literal';
            const inputNode = walkKey(opObj, 'input');
            if (inputNode && typeof inputNode === 'object') {
                for (const kk of Object.keys(inputNode as Record<string, unknown>)) {
                    if (stripNsPrefix(kk) === 'body') {
                        const bodyChild = (inputNode as Record<string, unknown>)[kk];
                        const u = attr(bodyChild, 'use');
                        if (u === 'literal' || u === 'encoded') use = u;
                    }
                }
            }
            operations.push({ name: opName, soapAction, style: opStyle, use });
        }
        bindings[name] = { name, type, style, soapVersion, operations };
    }

    // Services / ports.
    const services: NormService[] = [];
    for (const s of asArray(walkKey(defs, 'service') as unknown)) {
        const sObj = s as Record<string, unknown>;
        const name = attr(sObj, 'name');
        if (!name) continue;
        const ports: NormPort[] = [];
        for (const p of asArray(walkKey(sObj, 'port') as unknown).concat(asArray(walkKey(sObj, 'endpoint') as unknown))) {
            const pObj = p as Record<string, unknown>;
            const pName = attr(pObj, 'name');
            if (!pName) continue;
            const binding = attr(pObj, 'binding') || '';
            let address = '';
            for (const kk of Object.keys(pObj)) {
                if (stripNsPrefix(kk) === 'address') {
                    const child = pObj[kk];
                    const loc = attr(child, 'location');
                    if (loc) address = loc;
                }
            }
            ports.push({ name: pName, binding, address });
        }
        services.push({ name, ports });
    }

    return { targetNamespace, types, messages, portTypes, bindings, services, base };

    function pushPortType(pt: unknown, out: Record<string, NormPortType>): void {
        const ptObj = pt as Record<string, unknown>;
        const name = attr(ptObj, 'name');
        if (!name) return;
        const operations: NormPortTypeOperation[] = [];
        for (const op of asArray(walkKey(ptObj, 'operation') as unknown)) {
            const opObj = op as Record<string, unknown>;
            const opName = attr(opObj, 'name');
            if (!opName) continue;
            const input = walkKey(opObj, 'input');
            const output = walkKey(opObj, 'output');
            const inputMsg = attr(input, 'message') || attr(input, 'element') || '';
            const outputMsg = attr(output, 'message') || attr(output, 'element') || '';
            const faults: Array<{ name: string; message: string }> = [];
            for (const f of asArray(walkKey(opObj, 'fault') as unknown)) {
                const fObj = f as Record<string, unknown>;
                const fName = attr(fObj, 'name');
                const fMsg = attr(fObj, 'message') || attr(fObj, 'element');
                if (fName && fMsg) faults.push({ name: fName, message: fMsg });
            }
            operations.push({ name: opName, inputMessage: inputMsg, outputMessage: outputMsg, faults });
        }
        out[name] = { name, operations };
    }
}

function extractXsdTypes(schemas: unknown[], targetNamespace: string): Record<string, ParsedType> {
    const out: Record<string, ParsedType> = {};
    for (const s of schemas) {
        if (!s || typeof s !== 'object') continue;
        const sObj = s as Record<string, unknown>;
        const schemaTns = attr(sObj, 'targetNamespace') || targetNamespace;
        // Top-level xsd:element decls (typical for doc/lit).
        for (const el of asArray(walkKey(sObj, 'element') as unknown)) {
            const elObj = el as Record<string, unknown>;
            const name = attr(elObj, 'name');
            if (!name) continue;
            const inlineComplex = walkKey(elObj, 'complexType');
            if (inlineComplex) {
                out[qualify(name, schemaTns)] = {
                    name,
                    kind: 'complex',
                    fields: extractFields(inlineComplex),
                    isWrapper: true,
                };
            } else {
                const type = attr(elObj, 'type');
                if (type) {
                    out[qualify(name, schemaTns)] = {
                        name,
                        kind: 'simple',
                        fields: [],
                        base: type,
                        isWrapper: true,
                    };
                }
            }
        }
        // Named xsd:complexType.
        for (const ct of asArray(walkKey(sObj, 'complexType') as unknown)) {
            const ctObj = ct as Record<string, unknown>;
            const name = attr(ctObj, 'name');
            if (!name) continue;
            out[qualify(name, schemaTns)] = {
                name,
                kind: 'complex',
                fields: extractFields(ct),
            };
        }
        // Named xsd:simpleType.
        for (const st of asArray(walkKey(sObj, 'simpleType') as unknown)) {
            const stObj = st as Record<string, unknown>;
            const name = attr(stObj, 'name');
            if (!name) continue;
            const restriction = walkKey(stObj, 'restriction');
            const base = restriction ? attr(restriction, 'base') : undefined;
            out[qualify(name, schemaTns)] = {
                name,
                kind: 'simple',
                fields: [],
                base,
            };
        }
    }
    return out;
}

function extractFields(complexType: unknown): ParsedField[] {
    const fields: ParsedField[] = [];
    if (!complexType || typeof complexType !== 'object') return fields;
    // Recurse into sequence / all / choice.
    const containers = ['sequence', 'all', 'choice'];
    const stack: unknown[] = [complexType];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        const curObj = cur as Record<string, unknown>;
        for (const container of containers) {
            const c = walkKey(curObj, container);
            if (c && typeof c === 'object') stack.push(c);
        }
        for (const el of asArray(walkKey(curObj, 'element') as unknown)) {
            const elObj = el as Record<string, unknown>;
            const name = attr(elObj, 'name');
            if (!name) continue;
            const type = attr(elObj, 'type') || 'xsd:string';
            const minOccurs = Number(attr(elObj, 'minOccurs') ?? '1');
            const maxRaw = attr(elObj, 'maxOccurs') ?? '1';
            const maxOccurs = maxRaw === 'unbounded' ? 'unbounded' : Number(maxRaw);
            const nillable = (attr(elObj, 'nillable') || 'false').toLowerCase() === 'true';
            fields.push({ name, type, minOccurs: Number.isFinite(minOccurs) ? minOccurs : 1, maxOccurs, nillable });
        }
    }
    return fields;
}

// =============================================================================
// Regex fallback.
// =============================================================================

function normalizeRegex(text: string, base: string): NormalizedDoc {
    const targetNamespace = /targetNamespace\s*=\s*["']([^"']+)["']/.exec(text)?.[1] || '';
    const types: Record<string, ParsedType> = {};

    // Element declarations (top-level, doc/lit style):
    //   <xsd:element name="X"> <xsd:complexType>... </xsd:complexType> </xsd:element>
    const elemRe = /<(?:[A-Za-z_][\w.-]*:)?element\b([^>]*)\/?>(?:([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?element>)?/g;
    let m: RegExpExecArray | null;
    while ((m = elemRe.exec(text)) !== null) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const nameM = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs);
        const typeM = /\btype\s*=\s*["']([^"']+)["']/.exec(attrs);
        if (!nameM) continue;
        const name = nameM[1];
        // If it appears inside <complexType><sequence>, skip — those are captured below.
        // Heuristic: track offset — top-level XSD element decls are outside <sequence>.
        // We approximate by requiring no `<sequence` in immediate parent — done by counting.
        const before = text.slice(Math.max(0, m.index - 200), m.index);
        if (/<(?:[A-Za-z_][\w.-]*:)?(?:sequence|all|choice)\b/.test(before) && !/(<\/(?:[A-Za-z_][\w.-]*:)?(?:sequence|all|choice)>)/.test(before)) continue;
        // Inline complexType?
        const innerCt = /<(?:[A-Za-z_][\w.-]*:)?complexType\b[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?complexType>/.exec(body);
        if (innerCt) {
            types[qualify(name, targetNamespace)] = {
                name,
                kind: 'complex',
                fields: extractFieldsFromXml(innerCt[0]),
                isWrapper: true,
            };
            continue;
        }
        if (typeM) {
            types[qualify(name, targetNamespace)] = {
                name,
                kind: 'simple',
                fields: [],
                base: typeM[1],
                isWrapper: true,
            };
        }
    }
    // Named complexTypes.
    const ctRe = /<(?:[A-Za-z_][\w.-]*:)?complexType\b([^>]*?)\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?complexType>/g;
    while ((m = ctRe.exec(text)) !== null) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const nameM = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs);
        if (!nameM) continue;
        const name = nameM[1];
        types[qualify(name, targetNamespace)] = {
            name,
            kind: 'complex',
            fields: extractFieldsFromXml(body),
        };
    }
    // Named simpleTypes.
    const stRe = /<(?:[A-Za-z_][\w.-]*:)?simpleType\b([^>]*?)\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?simpleType>/g;
    while ((m = stRe.exec(text)) !== null) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const nameM = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs);
        if (!nameM) continue;
        const baseM = /<(?:[A-Za-z_][\w.-]*:)?restriction\b[^>]*?\bbase\s*=\s*["']([^"']+)["']/.exec(body);
        types[qualify(nameM[1], targetNamespace)] = {
            name: nameM[1],
            kind: 'simple',
            fields: [],
            base: baseM?.[1],
        };
    }

    // Messages.
    const messages: Record<string, NormMessage> = {};
    const msgRe = /<(?:[A-Za-z_][\w.-]*:)?message\b([^>]*?)\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?message>/g;
    while ((m = msgRe.exec(text)) !== null) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const nameM = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs);
        if (!nameM) continue;
        const partRe = /<(?:[A-Za-z_][\w.-]*:)?part\b([^>]*)\/?>/g;
        const parts: NormPart[] = [];
        let pm: RegExpExecArray | null;
        while ((pm = partRe.exec(body)) !== null) {
            const a = pm[1];
            const pName = /\bname\s*=\s*["']([^"']+)["']/.exec(a)?.[1] || '';
            const pElem = /\belement\s*=\s*["']([^"']+)["']/.exec(a)?.[1];
            const pType = /\btype\s*=\s*["']([^"']+)["']/.exec(a)?.[1];
            parts.push({ name: pName, element: pElem, type: pType });
        }
        messages[nameM[1]] = { name: nameM[1], parts };
    }

    // PortTypes.
    const portTypes: Record<string, NormPortType> = {};
    const ptRe = /<(?:[A-Za-z_][\w.-]*:)?portType\b([^>]*?)\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?portType>/g;
    while ((m = ptRe.exec(text)) !== null) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const nameM = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs);
        if (!nameM) continue;
        const operations: NormPortTypeOperation[] = [];
        const opRe = /<(?:[A-Za-z_][\w.-]*:)?operation\b([^>]*?)\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?operation>/g;
        let om: RegExpExecArray | null;
        while ((om = opRe.exec(body)) !== null) {
            const oa = om[1] || '';
            const ob = om[2] || '';
            const opName = /\bname\s*=\s*["']([^"']+)["']/.exec(oa)?.[1] || '';
            const inputM = /<(?:[A-Za-z_][\w.-]*:)?input\b([^>]*)/.exec(ob);
            const outputM = /<(?:[A-Za-z_][\w.-]*:)?output\b([^>]*)/.exec(ob);
            const inputMsg = inputM ? (/\bmessage\s*=\s*["']([^"']+)["']/.exec(inputM[1])?.[1] || '') : '';
            const outputMsg = outputM ? (/\bmessage\s*=\s*["']([^"']+)["']/.exec(outputM[1])?.[1] || '') : '';
            const faults: Array<{ name: string; message: string }> = [];
            const faultRe = /<(?:[A-Za-z_][\w.-]*:)?fault\b([^>]*)\/?>/g;
            let fm: RegExpExecArray | null;
            while ((fm = faultRe.exec(ob)) !== null) {
                const fa = fm[1] || '';
                const fName = /\bname\s*=\s*["']([^"']+)["']/.exec(fa)?.[1];
                const fMsg = /\bmessage\s*=\s*["']([^"']+)["']/.exec(fa)?.[1];
                if (fName && fMsg) faults.push({ name: fName, message: fMsg });
            }
            operations.push({ name: opName, inputMessage: inputMsg, outputMessage: outputMsg, faults });
        }
        portTypes[nameM[1]] = { name: nameM[1], operations };
    }

    // Bindings.
    const bindings: Record<string, NormBinding> = {};
    const bRe = /<(?:[A-Za-z_][\w.-]*:)?binding\b([^>]*?)\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?binding>/g;
    while ((m = bRe.exec(text)) !== null) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const nameM = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs);
        const typeM = /\btype\s*=\s*["']([^"']+)["']/.exec(attrs);
        if (!nameM || !typeM) continue;
        // Detect version.
        let soapVersion: SoapVersion = '1.1';
        const soapBindingM = /<((?:[A-Za-z_][\w.-]*:)?)binding\b[^>]*?(?:transport|style)\s*=\s*["']([^"']+)["']/i.exec(body);
        if (soapBindingM) {
            const prefix = soapBindingM[1] || '';
            const val = soapBindingM[2] || '';
            if (prefix.toLowerCase().includes('12') || val.includes('2003/05')) soapVersion = '1.2';
        }
        let style: SoapStyle = 'document';
        const styleM = /<(?:[A-Za-z_][\w.-]*:)?binding\b[^>]*?\bstyle\s*=\s*["'](document|rpc)["']/i.exec(body);
        if (styleM) style = styleM[1] as SoapStyle;
        // Operations.
        const operations: NormOperationBinding[] = [];
        const opRe = /<(?:[A-Za-z_][\w.-]*:)?operation\b([^>]*?)\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?operation>/g;
        let om: RegExpExecArray | null;
        while ((om = opRe.exec(body)) !== null) {
            const oa = om[1] || '';
            const ob = om[2] || '';
            const opName = /\bname\s*=\s*["']([^"']+)["']/.exec(oa)?.[1];
            if (!opName) continue;
            const saM = /<(?:[A-Za-z_][\w.-]*:)?operation\b[^>]*?\bsoapAction\s*=\s*["']([^"']*)["']/i.exec(ob);
            const opStyleM = /<(?:[A-Za-z_][\w.-]*:)?operation\b[^>]*?\bstyle\s*=\s*["'](document|rpc)["']/i.exec(ob);
            const useM = /<(?:[A-Za-z_][\w.-]*:)?body\b[^>]*?\buse\s*=\s*["'](literal|encoded)["']/i.exec(ob);
            operations.push({
                name: opName,
                soapAction: saM?.[1] ?? '',
                style: opStyleM?.[1] as SoapStyle | undefined,
                use: useM?.[1] as SoapUse | undefined,
            });
        }
        bindings[nameM[1]] = {
            name: nameM[1],
            type: typeM[1],
            style,
            soapVersion,
            operations,
        };
    }

    // Services.
    const services: NormService[] = [];
    const svcRe = /<(?:[A-Za-z_][\w.-]*:)?service\b([^>]*?)\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?service>/g;
    while ((m = svcRe.exec(text)) !== null) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const nameM = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs);
        if (!nameM) continue;
        const ports: NormPort[] = [];
        const portRe = /<(?:[A-Za-z_][\w.-]*:)?(?:port|endpoint)\b([^>]*?)\s*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?(?:port|endpoint)>/g;
        let pm: RegExpExecArray | null;
        while ((pm = portRe.exec(body)) !== null) {
            const pa = pm[1] || '';
            const pb = pm[2] || '';
            const pNameM = /\bname\s*=\s*["']([^"']+)["']/.exec(pa);
            const bindM = /\bbinding\s*=\s*["']([^"']+)["']/.exec(pa);
            if (!pNameM) continue;
            const addressM = /<(?:[A-Za-z_][\w.-]*:)?address\b[^>]*?\blocation\s*=\s*["']([^"']+)["']/.exec(pb);
            ports.push({ name: pNameM[1], binding: bindM?.[1] || '', address: addressM?.[1] || '' });
        }
        services.push({ name: nameM[1], ports });
    }

    return { targetNamespace, types, messages, portTypes, bindings, services, base };
}

function extractFieldsFromXml(xml: string): ParsedField[] {
    const fields: ParsedField[] = [];
    // Only match direct element decls within sequence/all/choice (any depth OK
    // because named types are already extracted separately — this just walks
    // the local body).
    const elemRe = /<(?:[A-Za-z_][\w.-]*:)?element\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = elemRe.exec(xml)) !== null) {
        const a = m[1];
        // Skip element decls that are simply refs.
        const nameM = /\bname\s*=\s*["']([^"']+)["']/.exec(a);
        if (!nameM) continue;
        const type = /\btype\s*=\s*["']([^"']+)["']/.exec(a)?.[1] || 'xsd:string';
        const minM = /\bminOccurs\s*=\s*["'](\d+)["']/.exec(a);
        const maxM = /\bmaxOccurs\s*=\s*["'](unbounded|\d+)["']/.exec(a);
        const nilM = /\bnillable\s*=\s*["']([^"']+)["']/.exec(a);
        fields.push({
            name: nameM[1],
            type,
            minOccurs: minM ? Number(minM[1]) : 1,
            maxOccurs: maxM ? (maxM[1] === 'unbounded' ? 'unbounded' : Number(maxM[1])) : 1,
            nillable: nilM ? nilM[1].toLowerCase() === 'true' : false,
        });
    }
    return fields;
}

// =============================================================================
// Utilities.
// =============================================================================

export function stripNsPrefix(qname: string): string {
    const i = qname.indexOf(':');
    return i < 0 ? qname : qname.slice(i + 1);
}

export function qualify(localName: string, tns: string): string {
    return `{${tns}}${localName}`;
}

/**
 * Resolve an XSD-qualified type reference against a `ParsedWsdl` type table.
 * Handles both bare `Foo`, `tns:Foo`, and `{ns}Foo` shapes. Returns undefined
 * if the type isn't in the table (e.g. an XSD primitive like `xsd:string`).
 */
export function lookupType(types: Record<string, ParsedType>, qname: string, tns: string): ParsedType | undefined {
    if (qname.startsWith('{')) return types[qname];
    const local = stripNsPrefix(qname);
    return types[qualify(local, tns)] ?? types[local];
}
