/**
 * PDF metadata validator (§5).
 *
 * Reads the PDF's Info dictionary + XMP metadata via pdfjs `getMetadata()`
 * and asserts consumer-declared rules: Title / Author / Subject / Keywords /
 * Producer allow-list / Creator / CreationDate / ModDate freshness /
 * Language tag / Document ID presence / custom properties / metadata↔visible
 * agreement.
 *
 * Rules are declared on the spec under `metadata:`; the loader accepts every
 * field as optional so consumers only declare what they care about.
 *
 * @module report-validation/checks/CSPdfMetadataValidator
 */

import * as fs from 'fs';

export interface MetadataRule {
    /** Assert /Info /Title equals this string. */
    title?: string;
    /** Assert /Info /Title matches this regex. */
    titlePattern?: string;
    /** Assert /Info /Author equals this string. */
    author?: string;
    /** Assert /Info /Subject equals this string. */
    subject?: string;
    /** Assert /Info /Keywords contains every listed keyword. */
    keywordsInclude?: string[];
    /** Assert /Info /Producer is on this allow-list (any match passes). */
    producerAllowList?: string[];
    /** Assert /Info /Creator is on this allow-list. */
    creatorAllowList?: string[];
    /** Assert CreationDate is at most `n` days old. */
    creationMaxAgeDays?: number;
    /** Assert language tag `/Lang` on the root equals this string (e.g. `en-US`). */
    language?: string;
    /** Assert /ID array (document identifier) is present. */
    requireDocumentId?: boolean;
    /** Custom /Info entries. Key = property name, value = expected string. */
    customProperties?: Record<string, string>;
    /**
     * When declared, asserts the /Info /Title also appears somewhere in the
     * PDF's visible text — catches metadata drift where the file title lies.
     */
    titleMustAppearOnPage?: boolean;
}

export interface MetadataFinding {
    kind:
        | 'METADATA_TITLE_DRIFT'
        | 'METADATA_AUTHOR_DRIFT'
        | 'METADATA_SUBJECT_DRIFT'
        | 'METADATA_KEYWORDS_MISSING'
        | 'METADATA_PRODUCER_DISALLOWED'
        | 'METADATA_CREATOR_DISALLOWED'
        | 'METADATA_CREATION_TOO_OLD'
        | 'METADATA_LANGUAGE_DRIFT'
        | 'METADATA_DOC_ID_MISSING'
        | 'METADATA_CUSTOM_PROPERTY_DRIFT'
        | 'METADATA_TITLE_NOT_ON_PAGE';
    message: string;
    expected?: string;
    actual?: string;
}

export interface RawPdfMetadata {
    info: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
    hasDocumentId: boolean;
    visibleTextSample: string;
}

/**
 * Load Info + XMP via pdfjs. Kept as a separate function so tests can inject
 * a canned `RawPdfMetadata` and validate `validateMetadata` in isolation.
 */
export async function readPdfMetadata(pdfPath: string): Promise<RawPdfMetadata> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importDyn: any = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const pdfjs = await importDyn;
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const meta = await doc.getMetadata();
    const info = (meta && meta.info) || {};
    const rawXmp = meta && meta.metadata ? meta.metadata.getAll() : null;
    // /ID array — pdfjs exposes via `_pdfInfo.fingerprints` on the doc.
    const hasDocumentId = !!(doc as { fingerprints?: string[] }).fingerprints?.length;
    // Sample visible text — just enough to check "title appears on page" claims.
    // Cap at 8KB per doc so this stays cheap.
    let visibleTextSample = '';
    const pageCap = Math.min(3, doc.numPages);
    for (let p = 1; p <= pageCap; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        for (const it of content.items) {
            if ('str' in it && typeof it.str === 'string') {
                visibleTextSample += ' ' + it.str;
                if (visibleTextSample.length > 8192) break;
            }
        }
        if (visibleTextSample.length > 8192) break;
    }
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return { info: info as Record<string, unknown>, metadata: rawXmp, hasDocumentId, visibleTextSample };
}

/** Pure — takes pre-read metadata + rule, returns findings. */
export function validateMetadata(meta: RawPdfMetadata, rule: MetadataRule): MetadataFinding[] {
    const findings: MetadataFinding[] = [];
    const info = meta.info;

    const infoStr = (k: string): string => (typeof info[k] === 'string' ? (info[k] as string) : '');

    if (rule.title !== undefined) {
        const actual = infoStr('Title');
        if (actual !== rule.title) {
            findings.push({
                kind: 'METADATA_TITLE_DRIFT',
                message: `PDF Title metadata mismatch`,
                expected: rule.title,
                actual,
            });
        }
    }
    if (rule.titlePattern) {
        const actual = infoStr('Title');
        try {
            if (!new RegExp(rule.titlePattern).test(actual)) {
                findings.push({
                    kind: 'METADATA_TITLE_DRIFT',
                    message: `PDF Title does not match pattern /${rule.titlePattern}/`,
                    expected: rule.titlePattern,
                    actual,
                });
            }
        } catch {
            /* malformed pattern — treated as no-match */
            findings.push({
                kind: 'METADATA_TITLE_DRIFT',
                message: `PDF Title pattern /${rule.titlePattern}/ is not a valid regex`,
                expected: rule.titlePattern,
                actual,
            });
        }
    }
    if (rule.author !== undefined) {
        const actual = infoStr('Author');
        if (actual !== rule.author) {
            findings.push({
                kind: 'METADATA_AUTHOR_DRIFT',
                message: `PDF Author metadata mismatch`,
                expected: rule.author,
                actual,
            });
        }
    }
    if (rule.subject !== undefined) {
        const actual = infoStr('Subject');
        if (actual !== rule.subject) {
            findings.push({
                kind: 'METADATA_SUBJECT_DRIFT',
                message: `PDF Subject metadata mismatch`,
                expected: rule.subject,
                actual,
            });
        }
    }
    if (rule.keywordsInclude && rule.keywordsInclude.length > 0) {
        const actual = infoStr('Keywords').toLowerCase();
        const missing = rule.keywordsInclude.filter((k) => !actual.includes(k.toLowerCase()));
        if (missing.length > 0) {
            findings.push({
                kind: 'METADATA_KEYWORDS_MISSING',
                message: `PDF Keywords missing required entries: ${missing.join(', ')}`,
                expected: rule.keywordsInclude.join(', '),
                actual: infoStr('Keywords'),
            });
        }
    }
    if (rule.producerAllowList && rule.producerAllowList.length > 0) {
        const actual = infoStr('Producer');
        if (!rule.producerAllowList.some((p) => actual.toLowerCase().includes(p.toLowerCase()))) {
            findings.push({
                kind: 'METADATA_PRODUCER_DISALLOWED',
                message: `PDF Producer "${actual}" is not on the allow-list`,
                expected: rule.producerAllowList.join(' | '),
                actual,
            });
        }
    }
    if (rule.creatorAllowList && rule.creatorAllowList.length > 0) {
        const actual = infoStr('Creator');
        if (!rule.creatorAllowList.some((p) => actual.toLowerCase().includes(p.toLowerCase()))) {
            findings.push({
                kind: 'METADATA_CREATOR_DISALLOWED',
                message: `PDF Creator "${actual}" is not on the allow-list`,
                expected: rule.creatorAllowList.join(' | '),
                actual,
            });
        }
    }
    if (rule.creationMaxAgeDays !== undefined && rule.creationMaxAgeDays >= 0) {
        const created = parsePdfDate(infoStr('CreationDate'));
        if (created) {
            const ageDays = (Date.now() - created.getTime()) / 86_400_000;
            if (ageDays > rule.creationMaxAgeDays) {
                findings.push({
                    kind: 'METADATA_CREATION_TOO_OLD',
                    message: `PDF CreationDate ${created.toISOString()} is older than ${rule.creationMaxAgeDays} days`,
                    expected: `≤ ${rule.creationMaxAgeDays} days`,
                    actual: `${Math.floor(ageDays)} days`,
                });
            }
        }
    }
    if (rule.language !== undefined) {
        const actual = infoStr('Lang') || (meta.metadata && typeof meta.metadata['dc:language'] === 'string' ? (meta.metadata['dc:language'] as string) : '');
        if (actual !== rule.language) {
            findings.push({
                kind: 'METADATA_LANGUAGE_DRIFT',
                message: `PDF language tag mismatch`,
                expected: rule.language,
                actual,
            });
        }
    }
    if (rule.requireDocumentId && !meta.hasDocumentId) {
        findings.push({
            kind: 'METADATA_DOC_ID_MISSING',
            message: `PDF /ID array is required but absent`,
        });
    }
    if (rule.customProperties) {
        for (const [key, expected] of Object.entries(rule.customProperties)) {
            const actual = infoStr(key);
            if (actual !== expected) {
                findings.push({
                    kind: 'METADATA_CUSTOM_PROPERTY_DRIFT',
                    message: `PDF custom property "${key}" mismatch`,
                    expected,
                    actual,
                });
            }
        }
    }
    if (rule.titleMustAppearOnPage) {
        const title = infoStr('Title').trim();
        if (title && !meta.visibleTextSample.includes(title)) {
            findings.push({
                kind: 'METADATA_TITLE_NOT_ON_PAGE',
                message: `PDF Title "${title}" is not visible on any of the first 3 pages`,
                expected: title,
                actual: '(not on page)',
            });
        }
    }
    return findings;
}

/**
 * Parse a PDF-format date string `D:YYYYMMDDHHmmSSOHH'mm'` to a JS Date.
 * Returns null on unparseable input.
 */
function parsePdfDate(raw: string): Date | null {
    if (!raw) return null;
    const m = raw.match(/^D?:?(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
    if (!m) return null;
    const [, yy, mo, dd, hh, mi, ss] = m;
    const d = new Date(Date.UTC(+yy, +mo - 1, +dd, +(hh ?? 0), +(mi ?? 0), +(ss ?? 0)));
    return isNaN(d.getTime()) ? null : d;
}
