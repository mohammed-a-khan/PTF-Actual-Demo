/**
 * PDF attachment validator (§9 + §16).
 *
 * Enumerates embedded file streams (/EmbeddedFiles + /AF associations) via
 * pdfjs. Asserts:
 *   - Attachment count + name allow-list
 *   - Mime-type allow-list (via extension → mime map)
 *   - Attachment payload byte-size bounds
 *   - Optional structural sniff for XML attachments (well-formed check)
 *
 * PDF/A-3 requires each embedded file to carry an /AFRelationship key
 * (Source / Data / Alternative / Supplement / Unspecified). We surface the
 * relationship where pdfjs makes it available so a caller can assert it.
 *
 * We deliberately DO NOT include schema-based XSD validation for XML —
 * that would add a runtime dep. Structural well-formedness is checked with
 * a minimal in-process parser (tag balance) that catches typical drift.
 *
 * @module report-validation/checks/CSPdfAttachmentValidator
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AttachmentRule {
    /** Assert total attachment count. */
    attachmentCount?: number;
    /** Every listed filename must exist (case-sensitive). */
    filenamesMustExist?: string[];
    /** Any filename NOT in this list is forbidden (case-sensitive). */
    filenamesAllowed?: string[];
    /** Mime allow-list, e.g. ["application/xml", "text/csv"]. Inferred from filename extension. */
    mimeTypesAllowed?: string[];
    /** Reject attachments smaller than N bytes. */
    minByteSize?: number;
    /** Reject attachments larger than N bytes. */
    maxByteSize?: number;
    /** Every listed filename must parse as well-formed XML (tag-balanced). */
    xmlWellFormed?: string[];
    /** Every listed filename must have this /AFRelationship value. */
    afRelationship?: Record<string, 'Source' | 'Data' | 'Alternative' | 'Supplement' | 'Unspecified'>;
}

export interface AttachmentFinding {
    kind:
        | 'ATTACHMENT_COUNT_DRIFT'
        | 'ATTACHMENT_MISSING'
        | 'ATTACHMENT_FORBIDDEN'
        | 'ATTACHMENT_MIME_FORBIDDEN'
        | 'ATTACHMENT_BYTE_SIZE_DRIFT'
        | 'ATTACHMENT_XML_MALFORMED'
        | 'ATTACHMENT_RELATIONSHIP_DRIFT';
    message: string;
    filename?: string;
    expected?: string;
    actual?: string;
}

export interface AttachmentInfo {
    filename: string;
    byteSize: number;
    content: Uint8Array;
    afRelationship?: string;
    description?: string;
}

export interface AttachmentBundle {
    attachments: AttachmentInfo[];
}

const EXT_TO_MIME: Record<string, string> = {
    xml: 'application/xml',
    xsd: 'application/xml',
    xhtml: 'application/xhtml+xml',
    csv: 'text/csv',
    txt: 'text/plain',
    json: 'application/json',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    zip: 'application/zip',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function inferMime(filename: string): string {
    const ext = path.extname(filename).slice(1).toLowerCase();
    return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

export async function readAttachmentInventory(pdfPath: string): Promise<AttachmentBundle> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importDyn: any = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const pdfjs = await importDyn;
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    const attachments: AttachmentInfo[] = [];
    try {
        const raw = await doc.getAttachments();
        if (raw && typeof raw === 'object') {
            for (const [, entry] of Object.entries(raw)) {
                if (!entry || typeof entry !== 'object') continue;
                const e = entry as {
                    filename?: string;
                    content?: Uint8Array;
                    description?: string;
                    afRelationship?: string;
                };
                if (!e.filename || !e.content) continue;
                attachments.push({
                    filename: e.filename,
                    byteSize: e.content.byteLength,
                    content: e.content,
                    afRelationship: e.afRelationship,
                    description: e.description,
                });
            }
        }
    } catch {
        /* no attachments */
    }
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return { attachments };
}

export function validateAttachments(inv: AttachmentBundle, rule: AttachmentRule): AttachmentFinding[] {
    const findings: AttachmentFinding[] = [];

    if (rule.attachmentCount !== undefined && inv.attachments.length !== rule.attachmentCount) {
        findings.push({
            kind: 'ATTACHMENT_COUNT_DRIFT',
            message: `Expected ${rule.attachmentCount} attachments, found ${inv.attachments.length}`,
            expected: String(rule.attachmentCount),
            actual: String(inv.attachments.length),
        });
    }
    if (rule.filenamesMustExist) {
        const names = new Set(inv.attachments.map((a) => a.filename));
        for (const req of rule.filenamesMustExist) {
            if (!names.has(req)) {
                findings.push({
                    kind: 'ATTACHMENT_MISSING',
                    message: `Expected attachment "${req}" not found`,
                    filename: req,
                    expected: req,
                });
            }
        }
    }
    if (rule.filenamesAllowed) {
        const allowed = new Set(rule.filenamesAllowed);
        for (const a of inv.attachments) {
            if (!allowed.has(a.filename)) {
                findings.push({
                    kind: 'ATTACHMENT_FORBIDDEN',
                    message: `Attachment "${a.filename}" is not on the allowed-filenames list`,
                    filename: a.filename,
                    actual: a.filename,
                });
            }
        }
    }
    if (rule.mimeTypesAllowed) {
        const allowed = new Set(rule.mimeTypesAllowed.map((m) => m.toLowerCase()));
        for (const a of inv.attachments) {
            const mime = inferMime(a.filename);
            if (!allowed.has(mime.toLowerCase())) {
                findings.push({
                    kind: 'ATTACHMENT_MIME_FORBIDDEN',
                    message: `Attachment "${a.filename}" mime-type "${mime}" is not on the allowed list`,
                    filename: a.filename,
                    actual: mime,
                });
            }
        }
    }
    if (rule.minByteSize !== undefined || rule.maxByteSize !== undefined) {
        for (const a of inv.attachments) {
            if (rule.minByteSize !== undefined && a.byteSize < rule.minByteSize) {
                findings.push({
                    kind: 'ATTACHMENT_BYTE_SIZE_DRIFT',
                    message: `Attachment "${a.filename}" is ${a.byteSize} bytes; minimum is ${rule.minByteSize}`,
                    filename: a.filename,
                    expected: `≥ ${rule.minByteSize}`,
                    actual: String(a.byteSize),
                });
            }
            if (rule.maxByteSize !== undefined && a.byteSize > rule.maxByteSize) {
                findings.push({
                    kind: 'ATTACHMENT_BYTE_SIZE_DRIFT',
                    message: `Attachment "${a.filename}" is ${a.byteSize} bytes; maximum is ${rule.maxByteSize}`,
                    filename: a.filename,
                    expected: `≤ ${rule.maxByteSize}`,
                    actual: String(a.byteSize),
                });
            }
        }
    }
    if (rule.xmlWellFormed) {
        for (const filename of rule.xmlWellFormed) {
            const a = inv.attachments.find((x) => x.filename === filename);
            if (!a) continue; // ATTACHMENT_MISSING already covers absence
            const txt = new TextDecoder('utf-8').decode(a.content);
            const err = checkXmlBalanced(txt);
            if (err) {
                findings.push({
                    kind: 'ATTACHMENT_XML_MALFORMED',
                    message: `XML attachment "${filename}" is malformed: ${err}`,
                    filename,
                    actual: err,
                });
            }
        }
    }
    if (rule.afRelationship) {
        for (const [filename, expected] of Object.entries(rule.afRelationship)) {
            const a = inv.attachments.find((x) => x.filename === filename);
            if (!a) continue;
            const actual = a.afRelationship ?? '(missing)';
            if (actual !== expected) {
                findings.push({
                    kind: 'ATTACHMENT_RELATIONSHIP_DRIFT',
                    message: `Attachment "${filename}" AFRelationship mismatch`,
                    filename,
                    expected,
                    actual,
                });
            }
        }
    }
    return findings;
}

/**
 * Minimal tag-balance check for XML — catches unclosed tags, mismatched
 * open/close, missing root. Not a substitute for a schema validator; when
 * a consumer needs XSD they should validate the extracted file with an
 * external tool (e.g. xmllint) outside the framework.
 */
function checkXmlBalanced(text: string): string | null {
    const trimmed = text.replace(/<\?xml[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
    const tagRe = /<\/?([A-Za-z_][A-Za-z0-9_:.\-]*)([^>]*)>/g;
    const stack: string[] = [];
    let m: RegExpExecArray | null;
    let rootSeen = false;
    while ((m = tagRe.exec(trimmed)) !== null) {
        const full = m[0];
        const name = m[1];
        const rest = m[2];
        if (full.startsWith('</')) {
            const open = stack.pop();
            if (open !== name) return `mismatched close tag </${name}>, expected </${open ?? '(none)'}>`;
        } else if (rest.trim().endsWith('/')) {
            rootSeen = true;
        } else {
            stack.push(name);
            rootSeen = true;
        }
    }
    if (stack.length > 0) return `unclosed tag <${stack[stack.length - 1]}>`;
    if (!rootSeen) return 'no root element';
    return null;
}
