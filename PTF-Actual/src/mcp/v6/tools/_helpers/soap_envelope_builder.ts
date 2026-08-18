/**
 * soap_envelope_builder — canonical SOAP 1.1 and 1.2 envelope construction
 * used by cs_qa_gen_soap_test.
 *
 * Deliberate contract:
 *   - `buildEnvelope` returns a WHOLE, valid SOAP request XML string.
 *   - `buildSampleBody` generates an XML body for an operation input based on
 *     the parsed WSDL types (uses "?" for strings, 0 for numbers, false for
 *     booleans, ISO date for dateTime, one child element per array wrapper).
 *   - `buildWsSecurityUsernameToken` implements the RFC-compliant
 *     PasswordDigest algorithm: `Base64( SHA-1( Nonce + Created + Password ) )`.
 *     Real crypto — not a stub.
 *   - `buildBasicAuthHeader` returns an `Authorization: Basic <b64(user:pw)>`
 *     value. Callers pass it as an HTTP header; it is NEVER logged.
 *
 * NO STUBS. Every function returns real, spec-compliant output.
 */

import { createHash, randomBytes } from 'crypto';
import type { ParsedField, ParsedType, ParsedWsdl, SoapVersion } from './wsdl_parser';
import { lookupType, stripNsPrefix } from './wsdl_parser';

export const SOAP_11_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
export const SOAP_12_NS = 'http://www.w3.org/2003/05/soap-envelope';
export const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
export const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
export const PASSWORD_DIGEST_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
export const PASSWORD_TEXT_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';

// =============================================================================
// XSD primitive → sample value mapping.
// =============================================================================

function sampleForPrimitive(xsdType: string): string {
    const local = stripNsPrefix(xsdType).toLowerCase();
    switch (local) {
        case 'string': case 'normalizedstring': case 'token': case 'anyuri':
            return '?';
        case 'boolean':
            return 'false';
        case 'int': case 'integer': case 'long': case 'short': case 'byte':
        case 'unsignedint': case 'unsignedlong': case 'unsignedshort': case 'unsignedbyte':
        case 'positiveinteger': case 'nonnegativeinteger':
            return '0';
        case 'decimal': case 'float': case 'double':
            return '0.0';
        case 'datetime':
            return '1970-01-01T00:00:00Z';
        case 'date':
            return '1970-01-01';
        case 'time':
            return '00:00:00Z';
        case 'base64binary': case 'hexbinary':
            return '';
        default:
            // Fallback for unknown primitives — treat as string.
            return '?';
    }
}

function isXsdPrimitive(qname: string): boolean {
    const idx = qname.indexOf(':');
    if (idx < 0) {
        // Bare name — the caller has already looked it up in the types table.
        // If they routed here, treat as primitive with string fallback.
        return true;
    }
    const prefix = qname.slice(0, idx).toLowerCase();
    return prefix === 'xsd' || prefix === 'xs';
}

// =============================================================================
// Body construction.
// =============================================================================

export interface BuildBodyOptions {
    wsdl: ParsedWsdl;
    /** Local name of the wrapper element to build (usually operation name for doc/lit). */
    wrapperElement: string;
    /** Namespace URI of the wrapper element. */
    wrapperNamespace: string;
    /** When set, drop this required field from the wrapper — used for fault-case scenarios. */
    dropField?: string;
    /** Extra param overrides — { fieldName: value }. Values are XML-escaped. */
    overrides?: Record<string, string>;
    /** Prefix to use for the wrapper's namespace. */
    tnsPrefix?: string;
}

export function buildSampleBody(opts: BuildBodyOptions): string {
    const prefix = opts.tnsPrefix ?? 'tns';
    const wrapperType = lookupType(opts.wsdl.types, opts.wrapperElement, opts.wrapperNamespace);
    const openTag = `<${prefix}:${opts.wrapperElement}${opts.wrapperNamespace ? ` xmlns:${prefix}="${xmlEscapeAttr(opts.wrapperNamespace)}"` : ''}>`;
    const closeTag = `</${prefix}:${opts.wrapperElement}>`;
    const inner = renderTypeChildren({
        type: wrapperType,
        wsdl: opts.wsdl,
        dropField: opts.dropField,
        overrides: opts.overrides,
        depth: 0,
    });
    return `${openTag}${inner}${closeTag}`;
}

interface RenderCtx {
    type: ParsedType | undefined;
    wsdl: ParsedWsdl;
    dropField?: string;
    overrides?: Record<string, string>;
    depth: number;
}

const MAX_TYPE_RECURSION_DEPTH = 6;

function renderTypeChildren(ctx: RenderCtx): string {
    if (!ctx.type || ctx.depth >= MAX_TYPE_RECURSION_DEPTH) return '';
    // Simple-type wrapper — emit a single scalar value.
    if (ctx.type.kind === 'simple' && ctx.type.base) {
        return xmlEscape(sampleForPrimitive(ctx.type.base));
    }
    const parts: string[] = [];
    for (const field of ctx.type.fields) {
        if (ctx.dropField && field.name === ctx.dropField) continue;
        parts.push(renderField(field, ctx));
    }
    return parts.join('');
}

function renderField(field: ParsedField, ctx: RenderCtx): string {
    const override = ctx.overrides?.[field.name];
    if (override !== undefined) {
        return `<${field.name}>${xmlEscape(override)}</${field.name}>`;
    }
    // Skip strictly-optional fields on the happy path only if they'd introduce
    // recursion cycles. In practice we render minOccurs>=1 always, optional
    // fields once for observability of the shape.
    const count = field.maxOccurs === 'unbounded' ? 1 : Math.max(1, field.minOccurs || 1);
    const fieldType = field.type;
    let value = '';
    let isComplex = false;
    let childInner = '';
    if (isXsdPrimitive(fieldType)) {
        value = sampleForPrimitive(fieldType);
    } else {
        // Look up in the types table.
        const t = lookupType(ctx.wsdl.types, fieldType, ctx.wsdl.targetNamespace);
        if (!t) {
            // Unknown type — emit as string.
            value = '?';
        } else if (t.kind === 'simple' && t.base) {
            value = sampleForPrimitive(t.base);
        } else {
            isComplex = true;
            childInner = renderTypeChildren({
                type: t,
                wsdl: ctx.wsdl,
                overrides: undefined,
                depth: ctx.depth + 1,
            });
        }
    }
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        if (isComplex) {
            out.push(`<${field.name}>${childInner}</${field.name}>`);
        } else {
            out.push(`<${field.name}>${xmlEscape(value)}</${field.name}>`);
        }
    }
    return out.join('');
}

// =============================================================================
// Envelope construction.
// =============================================================================

export interface WsSecurityUsernameTokenParams {
    username: string;
    password: string;
    /** 'PasswordDigest' (default) or 'PasswordText'. Digest is stronger. */
    passwordType?: 'PasswordDigest' | 'PasswordText';
    /** Optional injected nonce (raw bytes) — for deterministic tests. */
    nonceBytes?: Buffer;
    /** Optional injected timestamp (ISO 8601) — for deterministic tests. */
    createdIso?: string;
}

export interface BuildEnvelopeOptions {
    version: SoapVersion;
    body: string;
    /** Header XML fragment (already serialized). Optional. */
    headerXml?: string;
    /** Convenience: attach a WS-Security UsernameToken header. */
    wsSecurityUsernameToken?: WsSecurityUsernameTokenParams;
}

export function buildEnvelope(opts: BuildEnvelopeOptions): string {
    const ns = opts.version === '1.2' ? SOAP_12_NS : SOAP_11_NS;
    const headerParts: string[] = [];
    if (opts.headerXml) headerParts.push(opts.headerXml);
    if (opts.wsSecurityUsernameToken) headerParts.push(buildWsSecurityUsernameToken(opts.wsSecurityUsernameToken));
    const headerBlock = headerParts.length > 0
        ? `<soapenv:Header>${headerParts.join('')}</soapenv:Header>`
        : '';
    return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${ns}">${headerBlock}<soapenv:Body>${opts.body}</soapenv:Body></soapenv:Envelope>`;
}

// =============================================================================
// WS-Security UsernameToken (RFC-compliant digest).
// =============================================================================

export function buildWsSecurityUsernameToken(params: WsSecurityUsernameTokenParams): string {
    const nonceBytes = params.nonceBytes ?? randomBytes(16);
    const nonceB64 = nonceBytes.toString('base64');
    const created = params.createdIso ?? new Date().toISOString();
    const passwordType = params.passwordType ?? 'PasswordDigest';

    let passwordElement: string;
    if (passwordType === 'PasswordDigest') {
        // WS-Security spec: Password_Digest = Base64( SHA-1( nonce_raw + created + password ) )
        const hash = createHash('sha1');
        hash.update(nonceBytes);
        hash.update(Buffer.from(created, 'utf-8'));
        hash.update(Buffer.from(params.password, 'utf-8'));
        const digest = hash.digest('base64');
        passwordElement = `<wsse:Password Type="${PASSWORD_DIGEST_TYPE}">${xmlEscape(digest)}</wsse:Password>`;
    } else {
        passwordElement = `<wsse:Password Type="${PASSWORD_TEXT_TYPE}">${xmlEscape(params.password)}</wsse:Password>`;
    }

    return [
        `<wsse:Security xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}" soapenv:mustUnderstand="1">`,
        `<wsse:UsernameToken>`,
        `<wsse:Username>${xmlEscape(params.username)}</wsse:Username>`,
        passwordElement,
        `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${xmlEscape(nonceB64)}</wsse:Nonce>`,
        `<wsu:Created>${xmlEscape(created)}</wsu:Created>`,
        `</wsse:UsernameToken>`,
        `</wsse:Security>`,
    ].join('');
}

// =============================================================================
// Basic auth header (returned as VALUE only — caller sets the header).
// =============================================================================

export function buildBasicAuthHeader(username: string, password: string): string {
    const token = Buffer.from(`${username}:${password}`, 'utf-8').toString('base64');
    return `Basic ${token}`;
}

// =============================================================================
// Content-type header.
// =============================================================================

export function soapContentType(version: SoapVersion, soapAction?: string): { name: string; value: string } {
    if (version === '1.2') {
        // SOAP 1.2 folds action into the content-type parameter.
        const actionPart = soapAction !== undefined ? `; action="${soapAction.replace(/"/g, '')}"` : '';
        return { name: 'Content-Type', value: `application/soap+xml; charset=utf-8${actionPart}` };
    }
    return { name: 'Content-Type', value: 'text/xml; charset=utf-8' };
}

// =============================================================================
// XML escaping.
// =============================================================================

export function xmlEscape(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function xmlEscapeAttr(s: string): string {
    return xmlEscape(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
