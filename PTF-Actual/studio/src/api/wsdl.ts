/**
 * WSDL 1.1 import: each operation of each SOAP port (SOAP 1.1 and 1.2 bindings) becomes a request of a collection:
 * POST to the port's address, the SOAPAction (1.1 header; 1.2 in the Content-Type), and an envelope whose body is
 * a sample of the operation's input message built from the WSDL's XML Schema (elements, named and anonymous
 * complex types, sequences / all / choice, extensions, enumerations, optional and repeated elements, attributes).
 * Each request checks the HTTP status and that the response is no SOAP Fault. Document/literal and RPC/literal.
 */
import { DOMParser } from '@xmldom/xmldom';
import { ApiCheck, ApiCollection, ApiItem, ApiRequest, newCollection, newRequest } from './model';

const WSDL = 'http://schemas.xmlsoap.org/wsdl/';
const SOAP11 = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const XSD = 'http://www.w3.org/2001/XMLSchema';
const ENV11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const ENV12 = 'http://www.w3.org/2003/05/soap-envelope';

export interface WsdlReport { services: number; operations: number; warnings: string[] }

type El = Element;
const kids = (e: El | Document, ns: string, local?: string): El[] => {
    const out: El[] = [];
    for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as El).namespaceURI === ns && (!local || (n as El).localName === local)) out.push(n as El);
    return out;
};
const kid = (e: El, ns: string, local: string) => kids(e, ns, local)[0];
/** A QName attribute → {ns, local} (the prefix resolved where the attribute is). */
function qname(e: El, attr: string): { ns: string; local: string } | null {
    const v = e.getAttribute(attr);
    if (!v) return null;
    const i = v.indexOf(':');
    const prefix = i < 0 ? null : v.slice(0, i);
    return { ns: e.lookupNamespaceURI(prefix) ?? '', local: i < 0 ? v : v.slice(i + 1) };
}
const key = (ns: string, local: string) => `{${ns}}${local}`;

interface Schema { tns: string; qualified: boolean; attrQualified: boolean }

class Schemas {
    readonly elements = new Map<string, { e: El; s: Schema }>();
    readonly types = new Map<string, { e: El; s: Schema }>();
    constructor(roots: El[]) {
        for (const r of roots) {
            const s: Schema = { tns: r.getAttribute('targetNamespace') || '', qualified: r.getAttribute('elementFormDefault') === 'qualified', attrQualified: r.getAttribute('attributeFormDefault') === 'qualified' };
            for (const e of kids(r, XSD, 'element')) this.elements.set(key(s.tns, e.getAttribute('name') || ''), { e, s });
            for (const t of [...kids(r, XSD, 'complexType'), ...kids(r, XSD, 'simpleType')]) this.types.set(key(s.tns, t.getAttribute('name') || ''), { e: t, s });
        }
    }
}

/** Writes a sample XML instance; prefixes per namespace (ns1, ns2…), declared on the body's top element. */
class Writer {
    private readonly prefixes = new Map<string, string>();
    constructor(private readonly x: Schemas) {}
    prefix(ns: string): string { let p = this.prefixes.get(ns); if (!p) { p = `ns${this.prefixes.size + 1}`; this.prefixes.set(ns, p); } return p; }
    declarations(): string { return [...this.prefixes].map(([ns, p]) => ` xmlns:${p}="${ns}"`).join(''); }

    sampleSimple(t: { ns: string; local: string } | null, name: string, facets?: El): string {
        const en = facets ? kids(facets, XSD, 'enumeration')[0]?.getAttribute('value') : undefined;
        if (en !== undefined && en !== null) return en;
        if (t && t.ns === XSD) {
            const l = t.local;
            if (/^(int|integer|long|short|byte|unsigned\w+|positiveInteger|nonNegativeInteger)$/.test(l)) return '1';
            if (/^(decimal|double|float)$/.test(l)) return '1.5';
            if (l === 'boolean') return 'true';
            if (l === 'date') return '2026-01-31';
            if (l === 'dateTime') return '2026-01-31T10:00:00Z';
            if (l === 'time') return '10:00:00';
            if (l === 'base64Binary') return 'AA==';
            return `{{${name}}}`.replace(/[^\w{}.-]/g, '');
        }
        if (t) {
            const st = this.x.types.get(key(t.ns, t.local));
            if (st && st.e.localName === 'simpleType') {
                const r = kid(st.e, XSD, 'restriction');
                if (r) return this.sampleSimple(qname(r, 'base'), name, r);
            }
        }
        return `{{${name}}}`.replace(/[^\w{}.-]/g, '');
    }

    /** The children (elements) and attributes of a complex type, at an indent. */
    complex(t: El, s: Schema, indent: string, depth: number, attrs: string[]): string {
        if (depth > 6) return '';
        let out = '';
        const walk = (g: El) => {
            for (let n = g.firstChild; n; n = n.nextSibling) {
                if (n.nodeType !== 1 || (n as El).namespaceURI !== XSD) continue;
                const c = n as El;
                if (c.localName === 'sequence' || c.localName === 'all') walk(c);
                else if (c.localName === 'choice') { const first = kids(c, XSD).find((x) => ['element', 'sequence'].includes(x.localName)); if (first) { if (first.localName === 'element') out += this.element(first, s, indent, depth + 1, true); else walk(first); } }
                else if (c.localName === 'element') out += this.element(c, s, indent, depth + 1, false);
                else if (c.localName === 'attribute') { const an = c.getAttribute('name'); if (an && c.getAttribute('use') !== 'prohibited') attrs.push(` ${an}="${this.sampleSimple(qname(c, 'type'), an)}"`); }
                else if (c.localName === 'complexContent' || c.localName === 'simpleContent') {
                    const ext = kid(c, XSD, 'extension') ?? kid(c, XSD, 'restriction');
                    if (ext) {
                        const base = qname(ext, 'base');
                        const bt = base ? this.x.types.get(key(base.ns, base.local)) : undefined;
                        if (bt && bt.e.localName === 'complexType' && c.localName === 'complexContent') out += this.complex(bt.e, bt.s, indent, depth + 1, attrs);
                        walk(ext);
                    }
                }
            }
        };
        walk(t);
        return out;
    }

    element(e: El, s: Schema, indent: string, depth: number, inChoice: boolean, top = false): string {
        const ref = qname(e, 'ref');
        if (ref) { const r = this.x.elements.get(key(ref.ns, ref.local)); if (!r) return ''; return this.element(r.e, r.s, indent, depth, inChoice, true); }
        const name = e.getAttribute('name') || 'value';
        const repeated = (e.getAttribute('maxOccurs') || '1') !== '1' && (e.getAttribute('maxOccurs') || '1') !== '0';
        const optional = e.getAttribute('minOccurs') === '0';
        const qualified = top || (e.getAttribute('form') ? e.getAttribute('form') === 'qualified' : s.qualified);
        const tag = qualified && s.tns ? `${this.prefix(s.tns)}:${name}` : name;
        const note = [optional ? 'optional' : '', repeated ? 'repeats' : '', inChoice ? 'one of a choice' : ''].filter(Boolean);
        const comment = note.length ? `${indent}<!-- ${note.join(', ')} -->\n` : '';
        const tq = qname(e, 'type');
        let inner: string, attrs: string[] = [];
        const anon = kid(e, XSD, 'complexType');
        const anonSimple = kid(e, XSD, 'simpleType');
        if (anon) inner = this.complex(anon, s, `${indent}  `, depth, attrs);
        else if (anonSimple) { const r = kid(anonSimple, XSD, 'restriction'); return `${comment}${indent}<${tag}>${this.sampleSimple(r ? qname(r, 'base') : null, name, r)}</${tag}>\n`; }
        else if (tq && tq.ns !== XSD) {
            const t = this.x.types.get(key(tq.ns, tq.local));
            if (t && t.e.localName === 'complexType') inner = this.complex(t.e, t.s, `${indent}  `, depth, attrs);
            else return `${comment}${indent}<${tag}>${this.sampleSimple(tq, name)}</${tag}>\n`;
        } else return `${comment}${indent}<${tag}>${this.sampleSimple(tq, name)}</${tag}>\n`;
        return inner ? `${comment}${indent}<${tag}${attrs.join('')}>\n${inner}${indent}</${tag}>\n` : `${comment}${indent}<${tag}${attrs.join('')}/>\n`;
    }
}

function envelope(version: '1.1' | '1.2', bodyXml: string, decls: string): string {
    const ns = version === '1.1' ? ENV11 : ENV12;
    return `<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="${ns}"${decls}>\n  <soap:Header/>\n  <soap:Body>\n${bodyXml}  </soap:Body>\n</soap:Envelope>`;
}

export function importWsdl(text: string, o: { name?: string; url?: string } = {}): { collection: ApiCollection; report: WsdlReport } {
    const errors: string[] = [];
    const doc = new DOMParser({ errorHandler: { error: (m: string) => errors.push(m), fatalError: (m: string) => errors.push(m), warning: () => undefined } }).parseFromString(text, 'text/xml');
    const defs = doc.documentElement;
    if (!defs || errors.length && !defs) throw new Error(`Not XML: ${errors[0]}`);
    if (defs.namespaceURI !== WSDL || defs.localName !== 'definitions') {
        if (defs.localName === 'description') throw new Error('This is a WSDL 2.0 description: export the service as WSDL 1.1 (most SOAP stacks offer ?wsdl in 1.1).');
        throw new Error('Not a WSDL 1.1 document (no wsdl:definitions).');
    }
    const report: WsdlReport = { services: 0, operations: 0, warnings: [] };
    const tns = defs.getAttribute('targetNamespace') || '';
    const types = kid(defs, WSDL, 'types');
    if (types && kids(types, XSD, 'schema').some((s) => kids(s, XSD, 'import').some((i) => i.getAttribute('schemaLocation')) || kids(s, XSD, 'include').length))
        report.warnings.push('The schema imports or includes other files: their types are not read, so some samples are left with placeholders.');
    const schemas = new Schemas(types ? kids(types, XSD, 'schema') : []);
    const messages = new Map(kids(defs, WSDL, 'message').map((m) => [key(tns, m.getAttribute('name') || ''), m]));
    const portTypes = new Map(kids(defs, WSDL, 'portType').map((p) => [key(tns, p.getAttribute('name') || ''), p]));
    const bindings = new Map(kids(defs, WSDL, 'binding').map((b) => [key(tns, b.getAttribute('name') || ''), b]));
    const c = newCollection(o.name || defs.getAttribute('name') || kids(defs, WSDL, 'service')[0]?.getAttribute('name') || 'SOAP service');
    c.description = `Imported from WSDL${o.url ? ` ${o.url}` : ''} (${tns}).`;
    const folders: ApiItem[] = [];
    let baseSet = false;
    for (const svc of kids(defs, WSDL, 'service')) {
        report.services++;
        for (const port of kids(svc, WSDL, 'port')) {
            const addr11 = kid(port, SOAP11, 'address'), addr12 = kid(port, SOAP12, 'address');
            if (!addr11 && !addr12) { report.warnings.push(`Port ${port.getAttribute('name')}: not a SOAP port (HTTP or other binding), skipped.`); continue; }
            const version: '1.1' | '1.2' = addr12 ? '1.2' : '1.1';
            const soapNs = version === '1.1' ? SOAP11 : SOAP12;
            const location = (addr11 ?? addr12)!.getAttribute('location') || '';
            const bq = qname(port, 'binding');
            const binding = bq ? bindings.get(key(bq.ns, bq.local)) : undefined;
            if (!binding) { report.warnings.push(`Port ${port.getAttribute('name')}: binding not found.`); continue; }
            const ptq = qname(binding, 'type');
            const portType = ptq ? portTypes.get(key(ptq.ns, ptq.local)) : undefined;
            const style = kid(binding, soapNs, 'binding')?.getAttribute('style') || 'document';
            let base = location, path = '';
            try { const u = new URL(location); base = u.origin; path = u.pathname + u.search; } catch { /* relative */ }
            if (!baseSet) { c.baseUrl = base; baseSet = true; }
            const items: ApiItem[] = [];
            for (const bop of kids(binding, WSDL, 'operation')) {
                const opName = bop.getAttribute('name') || '';
                const soapOp = kid(bop, soapNs, 'operation');
                const action = soapOp?.getAttribute('soapAction') || '';
                const opStyle = soapOp?.getAttribute('style') || style;
                const inBody = kid(bop, WSDL, 'input') ? kid(kid(bop, WSDL, 'input'), soapNs, 'body') : undefined;
                if (inBody?.getAttribute('use') === 'encoded') report.warnings.push(`${opName}: SOAP encoding (rpc/encoded) — the sample is a starting point; check it against the service.`);
                const pop = portType ? kids(portType, WSDL, 'operation').find((x) => x.getAttribute('name') === opName) : undefined;
                const mq = pop ? qname(kid(pop, WSDL, 'input') ?? pop, 'message') : null;
                const msg = mq ? messages.get(key(mq.ns, mq.local)) : undefined;
                const w = new Writer(schemas);
                let body = '';
                const parts = msg ? kids(msg, WSDL, 'part') : [];
                if (opStyle === 'rpc') {
                    const ns = inBody?.getAttribute('namespace') || tns;
                    const p = w.prefix(ns);
                    const inner = parts.map((pt) => {
                        const tq = qname(pt, 'type');
                        const pn = pt.getAttribute('name') || 'part';
                        if (tq && tq.ns !== XSD) { const t = schemas.types.get(key(tq.ns, tq.local)); if (t && t.e.localName === 'complexType') { const attrs: string[] = []; const x = w.complex(t.e, t.s, '        ', 0, attrs); return `        <${pn}${attrs.join('')}>\n${x}        </${pn}>\n`; } }
                        return `        <${pn}>${w.sampleSimple(tq, pn)}</${pn}>\n`;
                    }).join('');
                    body = `    <${p}:${opName}>\n${inner.replace(/^ {4}/gm, '')}    </${p}:${opName}>\n`;
                } else {
                    for (const pt of parts) {
                        const eq = qname(pt, 'element');
                        const el = eq ? schemas.elements.get(key(eq.ns, eq.local)) : undefined;
                        if (el) body += w.element(el.e, el.s, '    ', 0, false, true);
                        else report.warnings.push(`${opName}: the input element ${pt.getAttribute('element') || pt.getAttribute('name')} is not in the WSDL's schema.`);
                    }
                }
                const r: ApiRequest = { ...newRequest(opName), method: 'POST', url: path || '/' };
                r.headers = version === '1.1'
                    ? [{ key: 'Content-Type', value: 'text/xml; charset=utf-8' }, { key: 'SOAPAction', value: `"${action}"` }]
                    : [{ key: 'Content-Type', value: `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}` }];
                r.body = { mode: 'xml', text: envelope(version, body, w.declarations()) };
                const checks: ApiCheck[] = [{ kind: 'status', value: '200' }, { kind: 'bodyNotContains', value: ':Fault>' } as ApiCheck];
                r.checks = checks;
                const doc0 = pop ? kid(pop, WSDL, 'documentation')?.textContent?.trim() : '';
                r.description = `SOAP ${version} ${opStyle} operation ${opName}${action ? ` (action ${action})` : ''}.${doc0 ? `\n${doc0}` : ''}`;
                items.push(r);
                report.operations++;
            }
            if (items.length) folders.push({ kind: 'folder', id: `f-${folders.length + 1}`, name: `${svc.getAttribute('name') || 'Service'} · ${port.getAttribute('name') || ''} (SOAP ${version})`, items } as ApiItem);
        }
    }
    if (!report.operations) throw new Error('No SOAP operations in this WSDL.');
    c.items = folders.length === 1 ? (folders[0] as { items: ApiItem[] }).items : folders;
    return { collection: c, report };
}
