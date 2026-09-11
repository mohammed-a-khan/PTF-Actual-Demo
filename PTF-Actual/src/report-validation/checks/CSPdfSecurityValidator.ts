/**
 * PDF security validator (Phase 5 / §16).
 *
 * Assertions:
 *   - `isEncrypted` — the document is (or is not) encrypted at rest
 *   - Owner-password requirement — printing/copying/annotation permissions
 *     required or forbidden
 *   - Signature dictionary presence — must have (or must NOT have) a
 *     digital signature; assert signer common-name against allow-list.
 *   - Redaction annotation forbidding — pre-flatten redactions leak sensitive
 *     data. Fail if any `/Redact` annotation still lives in the tree.
 *
 * DEFERRED (see D-8, D-9): full LTV signature verification (CRL/OCSP,
 * certificate-chain walk against a trust store). We surface signer CN and
 * signature dict integrity only; consumers who need cryptographic proof
 * should run a separate pipeline (e.g. verapdf / pdfsig outside CI).
 *
 * @module report-validation/checks/CSPdfSecurityValidator
 */

import * as fs from 'fs';

export interface SecurityRule {
    /** Assert encryption presence. */
    mustBeEncrypted?: boolean;
    /** Assert no `/Redact` annotations survived flattening. */
    forbidRedactionAnnotations?: boolean;
    /** Assert at least one digital signature is present. */
    mustHaveSignature?: boolean;
    /** Signer common-name allow-list (any signer must match one of these). */
    allowedSigners?: string[];
    /** Assert the permissions flags allow (or forbid) each named right. */
    permissions?: Partial<{
        printing: boolean;
        modify: boolean;
        copy: boolean;
        annotate: boolean;
    }>;
}

export interface SecurityFinding {
    kind:
        | 'ENCRYPTION_DRIFT'
        | 'REDACTION_LEAK'
        | 'SIGNATURE_MISSING'
        | 'SIGNATURE_SIGNER_FORBIDDEN'
        | 'PERMISSION_DRIFT';
    message: string;
    expected?: string;
    actual?: string;
}

export interface SecurityInventory {
    isEncrypted: boolean;
    permissions: { printing: boolean; modify: boolean; copy: boolean; annotate: boolean };
    signatures: Array<{ signerCommonName?: string; hasByteRange: boolean; hasContents: boolean }>;
    redactionAnnotations: Array<{ page: number }>;
}

export async function readSecurityInventory(pdfPath: string): Promise<SecurityInventory> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importDyn: any = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const pdfjs = await importDyn;
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    // pdfjs `getPermissions()` returns an int-array of allowed OPs (or null if
    // no restrictions). It maps to PDF spec permission bits.
    const perms = await doc.getPermissions().catch(() => null);
    const PdfjsPerms = (pdfjs as unknown as { PermissionFlag?: Record<string, number> }).PermissionFlag ?? {};
    const has = (flag: string): boolean =>
        Array.isArray(perms) ? perms.includes(PdfjsPerms[flag]) : true; // null perms = all allowed
    const permissions = {
        printing: has('PRINT') || has('PRINT_HIGH_QUALITY'),
        modify: has('MODIFY_CONTENTS'),
        copy: has('COPY'),
        annotate: has('MODIFY_ANNOTATIONS'),
    };

    // Detect encryption via presence of a security handler. pdfjs exposes
    // `_pdfInfo.encrypted` on some builds; fall back to non-null `perms` as
    // a strong proxy for "an owner-password is set".
    const info = (doc as unknown as { _pdfInfo?: { encrypted?: boolean } })._pdfInfo;
    const isEncrypted = !!info?.encrypted || (perms !== null && Array.isArray(perms));

    // Signatures — walk per-page widget annotations, subtype Sig.
    const signatures: SecurityInventory['signatures'] = [];
    const redactionAnnotations: SecurityInventory['redactionAnnotations'] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const anns = await page.getAnnotations();
        for (const a of anns) {
            if (a?.subtype === 'Widget' && a.fieldType === 'Sig') {
                signatures.push({
                    signerCommonName:
                        typeof a.signerName === 'string' ? a.signerName : (typeof a.fieldValue === 'string' ? a.fieldValue : undefined),
                    hasByteRange: !!(a.signatureContents ?? a.byteRange),
                    hasContents: !!a.signatureContents,
                });
            }
            if (a?.subtype === 'Redact') redactionAnnotations.push({ page: p });
        }
    }
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return { isEncrypted, permissions, signatures, redactionAnnotations };
}

export function validateSecurity(inv: SecurityInventory, rule: SecurityRule): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    if (rule.mustBeEncrypted !== undefined && inv.isEncrypted !== rule.mustBeEncrypted) {
        findings.push({
            kind: 'ENCRYPTION_DRIFT',
            message: `Expected isEncrypted=${rule.mustBeEncrypted}, found ${inv.isEncrypted}`,
            expected: String(rule.mustBeEncrypted),
            actual: String(inv.isEncrypted),
        });
    }
    if (rule.forbidRedactionAnnotations && inv.redactionAnnotations.length > 0) {
        for (const r of inv.redactionAnnotations) {
            findings.push({
                kind: 'REDACTION_LEAK',
                message: `Redaction annotation still present on page ${r.page} — flatten before releasing`,
                actual: `page ${r.page}`,
            });
        }
    }
    if (rule.mustHaveSignature && inv.signatures.length === 0) {
        findings.push({
            kind: 'SIGNATURE_MISSING',
            message: `Expected at least one digital signature; found none`,
            expected: 'signature present',
            actual: 'no signatures',
        });
    }
    if (rule.allowedSigners && inv.signatures.length > 0) {
        const allowed = new Set(rule.allowedSigners);
        for (const s of inv.signatures) {
            const cn = s.signerCommonName ?? '(unknown)';
            if (!allowed.has(cn)) {
                findings.push({
                    kind: 'SIGNATURE_SIGNER_FORBIDDEN',
                    message: `Signer "${cn}" not on allow-list`,
                    expected: rule.allowedSigners.join(' | '),
                    actual: cn,
                });
            }
        }
    }
    if (rule.permissions) {
        for (const [k, expected] of Object.entries(rule.permissions)) {
            if (expected === undefined) continue;
            const actual = inv.permissions[k as keyof typeof inv.permissions];
            if (actual !== expected) {
                findings.push({
                    kind: 'PERMISSION_DRIFT',
                    message: `Permission ${k} expected ${expected}, found ${actual}`,
                    expected: String(expected),
                    actual: String(actual),
                });
            }
        }
    }
    return findings;
}
