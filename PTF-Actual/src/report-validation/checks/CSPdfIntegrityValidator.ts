/**
 * PDF integrity validator (§20).
 *
 * File-level and structural integrity signals that don't need a full
 * canonical comparison to be useful. Covers:
 *
 *   - SHA-256 stability of the file (baseline vs current)
 *   - TOC entry count vs body section count (from AnalyzedReport)
 *   - Embedded-file inventory (attachments) — count + name allow/deny list
 *
 * @module report-validation/checks/CSPdfIntegrityValidator
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import type { AnalyzedReport } from '../CSReportPdfTypes';

export interface IntegrityRule {
    /** Assert the file SHA-256 matches this (typically read from a baseline artifact). */
    expectedSha256?: string;
    /** Assert TOC entry count equals detected section count (± tolerance). Default: false. */
    assertTocSectionCountMatch?: boolean;
    /** Tolerance for TOC entry count vs section count. Default: 0. */
    tocSectionCountTolerance?: number;
    /** Assert the total attachment count. */
    attachmentCount?: number;
    /** Every attachment filename must be on this list (else DISALLOWED). */
    attachmentAllowList?: string[];
    /** Any attachment filename matching one of these regexes is DISALLOWED. */
    attachmentForbiddenPatterns?: string[];
}

export interface IntegrityFinding {
    kind:
        | 'INTEGRITY_SHA256_DRIFT'
        | 'INTEGRITY_TOC_SECTION_COUNT_DRIFT'
        | 'INTEGRITY_ATTACHMENT_COUNT_DRIFT'
        | 'INTEGRITY_ATTACHMENT_DISALLOWED'
        | 'INTEGRITY_ATTACHMENT_FORBIDDEN';
    message: string;
    expected?: string;
    actual?: string;
}

export interface AttachmentInventory {
    files: Array<{ name: string; size: number; sha256: string }>;
}

/** Compute file SHA-256 as a hex string. */
export function computeFileSha256(pdfPath: string): string {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(pdfPath));
    return h.digest('hex');
}

/** Enumerate embedded files via pdfjs `getAttachments()`. */
export async function readAttachments(pdfPath: string): Promise<AttachmentInventory> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importDyn: any = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const pdfjs = await importDyn;
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const files: AttachmentInventory['files'] = [];
    try {
        const attach = await doc.getAttachments();
        if (attach) {
            for (const key of Object.keys(attach)) {
                const entry = attach[key];
                const bytes: Uint8Array = entry.content ?? new Uint8Array();
                const h = crypto.createHash('sha256');
                h.update(bytes);
                files.push({
                    name: entry.filename ?? key,
                    size: bytes.byteLength,
                    sha256: h.digest('hex'),
                });
            }
        }
    } catch {
        /* getAttachments() not supported on all PDFs */
    }
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return { files };
}

export function validateIntegrity(input: {
    pdfPath: string;
    analyzed?: AnalyzedReport;
    attachments?: AttachmentInventory;
    rule: IntegrityRule;
}): IntegrityFinding[] {
    const { pdfPath, analyzed, attachments, rule } = input;
    const findings: IntegrityFinding[] = [];

    if (rule.expectedSha256) {
        const actual = computeFileSha256(pdfPath);
        if (actual.toLowerCase() !== rule.expectedSha256.toLowerCase()) {
            findings.push({
                kind: 'INTEGRITY_SHA256_DRIFT',
                message: `File SHA-256 differs from baseline`,
                expected: rule.expectedSha256,
                actual,
            });
        }
    }

    if (rule.assertTocSectionCountMatch && analyzed) {
        const tocCount = analyzed.toc.length;
        // Real sections = detected sections excluding anonymous fallbacks.
        const sectionCount = analyzed.mergedSections.filter(
            (s) => s.title && s.title !== '(anonymous)',
        ).length;
        const tolerance = rule.tocSectionCountTolerance ?? 0;
        if (Math.abs(tocCount - sectionCount) > tolerance) {
            findings.push({
                kind: 'INTEGRITY_TOC_SECTION_COUNT_DRIFT',
                message: `TOC lists ${tocCount} entries but detected ${sectionCount} body sections (tolerance ${tolerance})`,
                expected: `TOC ≈ sections (±${tolerance})`,
                actual: `TOC=${tocCount} sections=${sectionCount}`,
            });
        }
    }

    if (attachments) {
        if (rule.attachmentCount !== undefined && attachments.files.length !== rule.attachmentCount) {
            findings.push({
                kind: 'INTEGRITY_ATTACHMENT_COUNT_DRIFT',
                message: `Expected ${rule.attachmentCount} attachment(s), found ${attachments.files.length}`,
                expected: String(rule.attachmentCount),
                actual: String(attachments.files.length),
            });
        }
        if (rule.attachmentAllowList) {
            const allow = new Set(rule.attachmentAllowList);
            for (const f of attachments.files) {
                if (!allow.has(f.name)) {
                    findings.push({
                        kind: 'INTEGRITY_ATTACHMENT_DISALLOWED',
                        message: `Attachment "${f.name}" is not on the allow-list`,
                        actual: f.name,
                    });
                }
            }
        }
        if (rule.attachmentForbiddenPatterns) {
            for (const pat of rule.attachmentForbiddenPatterns) {
                let re: RegExp;
                try {
                    re = new RegExp(pat, 'i');
                } catch {
                    continue;
                }
                for (const f of attachments.files) {
                    if (re.test(f.name)) {
                        findings.push({
                            kind: 'INTEGRITY_ATTACHMENT_FORBIDDEN',
                            message: `Attachment "${f.name}" matches forbidden pattern /${pat}/`,
                            actual: f.name,
                        });
                    }
                }
            }
        }
    }

    return findings;
}
