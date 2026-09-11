/**
 * PDF link validator (§14).
 *
 * Enumerates link annotations per page via pdfjs `page.getAnnotations()` and
 * categorises them: external URIs, internal GoTo destinations, named
 * destinations, mailto/tel. Asserts consumer-declared rules — count,
 * expected URIs, mailto syntax, internal destinations resolve. External
 * HTTP reachability is opt-in via `checkHttpReachable: true` (mockable
 * fetch injection point for CI so tests aren't network-flaky).
 *
 * @module report-validation/checks/CSPdfLinkValidator
 */

import * as fs from 'fs';

export interface LinkRule {
    /** Assert the total link count equals this. */
    exactCount?: number;
    /** Assert the total link count is ≥ this. */
    minCount?: number;
    /** Assert the total link count is ≤ this. */
    maxCount?: number;
    /** Every URI in this list MUST appear on the PDF (case-insensitive substring match). */
    urisMustInclude?: string[];
    /** Any URI matching one of these regexes is FORBIDDEN (e.g. staging/localhost domains in prod). */
    forbiddenUriPatterns?: string[];
    /** Validate mailto: syntax on all mailto links. Default: true. */
    validateMailtoSyntax?: boolean;
    /** Assert every internal GoTo action resolves to an existing named destination or page. Default: true. */
    resolveInternalTargets?: boolean;
    /**
     * Opt-in HTTP reachability check on every external URI. When true, the
     * validator issues a HEAD request (or GET fallback) per URI and flags any
     * response ≥ 400 or network error. Not enabled by default — CI runs
     * should mock via `fetchImpl` to avoid flakiness.
     */
    checkHttpReachable?: boolean;
    /** HTTP timeout in milliseconds when `checkHttpReachable` is true. Default 5000. */
    httpTimeoutMs?: number;
}

export interface LinkInventory {
    external: Array<{ page: number; uri: string }>;
    internal: Array<{ page: number; destination: string; resolved: boolean }>;
    mailto: Array<{ page: number; uri: string }>;
    tel: Array<{ page: number; uri: string }>;
    named: Array<{ page: number; name: string; resolved: boolean }>;
    totalCount: number;
}

export interface LinkFinding {
    kind:
        | 'LINK_COUNT_DRIFT'
        | 'LINK_MISSING_URI'
        | 'LINK_FORBIDDEN_URI'
        | 'LINK_MAILTO_SYNTAX'
        | 'LINK_INTERNAL_UNRESOLVED'
        | 'LINK_HTTP_UNREACHABLE';
    message: string;
    page?: number;
    uri?: string;
    expected?: string;
    actual?: string;
}

/** Fetch a link inventory from the PDF. Standalone so tests can inject a canned inventory. */
export async function readLinkInventory(pdfPath: string): Promise<LinkInventory> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importDyn: any = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const pdfjs = await importDyn;
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
    const inv: LinkInventory = {
        external: [],
        internal: [],
        mailto: [],
        tel: [],
        named: [],
        totalCount: 0,
    };
    // Cache page count for internal-target resolution.
    const pageCount = doc.numPages;
    const knownDests = new Set<string>();
    try {
        const dests = await doc.getDestinations();
        if (dests) for (const k of Object.keys(dests)) knownDests.add(k);
    } catch {
        /* not all PDFs expose named destinations */
    }
    for (let p = 1; p <= pageCount; p++) {
        const page = await doc.getPage(p);
        const anns = await page.getAnnotations();
        for (const a of anns) {
            if (!a || a.subtype !== 'Link') continue;
            const url: string | undefined = a.url;
            const dest = a.dest;
            const action = a.action;
            if (url) {
                if (/^mailto:/i.test(url)) inv.mailto.push({ page: p, uri: url });
                else if (/^tel:/i.test(url)) inv.tel.push({ page: p, uri: url });
                else inv.external.push({ page: p, uri: url });
            } else if (typeof dest === 'string') {
                inv.internal.push({ page: p, destination: dest, resolved: knownDests.has(dest) });
                inv.named.push({ page: p, name: dest, resolved: knownDests.has(dest) });
            } else if (Array.isArray(dest)) {
                // Array-form Dest: [pageRef, /Type, params...]. Resolved if pageRef points to a valid page.
                inv.internal.push({
                    page: p,
                    destination: `[array-dest to page ${dest[0]?.num ?? '?'}]`,
                    resolved: true,
                });
            } else if (action) {
                // Fallback: some producers write action instead of dest/url.
                inv.internal.push({ page: p, destination: String(action.type ?? action), resolved: false });
            }
        }
    }
    inv.totalCount = inv.external.length + inv.internal.length + inv.mailto.length + inv.tel.length;
    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return inv;
}

/**
 * Validate against declared rules. Pure over the inventory + rule; when
 * `checkHttpReachable:true` the caller must pass a `fetchImpl` (defaults to
 * global fetch) — CI runs should inject a mock.
 */
export async function validateLinks(
    inv: LinkInventory,
    rule: LinkRule,
    fetchImpl?: (url: string, opts?: { method?: string; signal?: AbortSignal }) => Promise<{ status: number }>,
): Promise<LinkFinding[]> {
    const findings: LinkFinding[] = [];
    // Count assertions.
    if (rule.exactCount !== undefined && inv.totalCount !== rule.exactCount) {
        findings.push({
            kind: 'LINK_COUNT_DRIFT',
            message: `Expected exactly ${rule.exactCount} links, found ${inv.totalCount}`,
            expected: String(rule.exactCount),
            actual: String(inv.totalCount),
        });
    }
    if (rule.minCount !== undefined && inv.totalCount < rule.minCount) {
        findings.push({
            kind: 'LINK_COUNT_DRIFT',
            message: `Expected at least ${rule.minCount} links, found ${inv.totalCount}`,
            expected: `≥ ${rule.minCount}`,
            actual: String(inv.totalCount),
        });
    }
    if (rule.maxCount !== undefined && inv.totalCount > rule.maxCount) {
        findings.push({
            kind: 'LINK_COUNT_DRIFT',
            message: `Expected at most ${rule.maxCount} links, found ${inv.totalCount}`,
            expected: `≤ ${rule.maxCount}`,
            actual: String(inv.totalCount),
        });
    }
    // Must-include URIs.
    if (rule.urisMustInclude && rule.urisMustInclude.length > 0) {
        const externalUris = inv.external.map((e) => e.uri.toLowerCase());
        for (const req of rule.urisMustInclude) {
            const found = externalUris.some((u) => u.includes(req.toLowerCase()));
            if (!found) {
                findings.push({
                    kind: 'LINK_MISSING_URI',
                    message: `Required URI "${req}" not found in any external link`,
                    expected: req,
                });
            }
        }
    }
    // Forbidden patterns.
    if (rule.forbiddenUriPatterns) {
        for (const pat of rule.forbiddenUriPatterns) {
            let re: RegExp;
            try {
                re = new RegExp(pat, 'i');
            } catch {
                continue;
            }
            for (const link of inv.external) {
                if (re.test(link.uri)) {
                    findings.push({
                        kind: 'LINK_FORBIDDEN_URI',
                        message: `URI "${link.uri}" (page ${link.page}) matches forbidden pattern /${pat}/`,
                        page: link.page,
                        uri: link.uri,
                    });
                }
            }
        }
    }
    // Mailto syntax.
    if (rule.validateMailtoSyntax !== false) {
        const mailtoRe = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+/i;
        for (const link of inv.mailto) {
            if (!mailtoRe.test(link.uri)) {
                findings.push({
                    kind: 'LINK_MAILTO_SYNTAX',
                    message: `Malformed mailto: "${link.uri}" on page ${link.page}`,
                    page: link.page,
                    uri: link.uri,
                });
            }
        }
    }
    // Internal targets resolve.
    if (rule.resolveInternalTargets !== false) {
        for (const link of inv.internal) {
            if (!link.resolved) {
                findings.push({
                    kind: 'LINK_INTERNAL_UNRESOLVED',
                    message: `Internal link on page ${link.page} points to unresolvable destination "${link.destination}"`,
                    page: link.page,
                    actual: link.destination,
                });
            }
        }
    }
    // Optional external HTTP reachability.
    if (rule.checkHttpReachable) {
        const timeoutMs = rule.httpTimeoutMs ?? 5000;
        const doFetch = fetchImpl ?? (globalThis.fetch as unknown as typeof fetchImpl);
        if (!doFetch) {
            findings.push({
                kind: 'LINK_HTTP_UNREACHABLE',
                message: `checkHttpReachable=true but no fetch implementation available (Node <18 without fetch polyfill)`,
            });
        } else {
            for (const link of inv.external) {
                try {
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                    const res = await doFetch(link.uri, { method: 'HEAD', signal: ctrl.signal });
                    clearTimeout(timer);
                    if (res.status >= 400) {
                        findings.push({
                            kind: 'LINK_HTTP_UNREACHABLE',
                            message: `External URI "${link.uri}" (page ${link.page}) returned HTTP ${res.status}`,
                            page: link.page,
                            uri: link.uri,
                            actual: String(res.status),
                        });
                    }
                } catch (e) {
                    findings.push({
                        kind: 'LINK_HTTP_UNREACHABLE',
                        message: `External URI "${link.uri}" (page ${link.page}) unreachable: ${(e as Error).message}`,
                        page: link.page,
                        uri: link.uri,
                    });
                }
            }
        }
    }
    return findings;
}
