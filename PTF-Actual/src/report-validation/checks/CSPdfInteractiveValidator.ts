/**
 * PDF interactive-elements validator (§13).
 *
 * Enumerates AcroForm widgets + JavaScript actions via pdfjs. Asserts:
 *   - Form widget count + types (Text / Btn / Ch / Sig / …)
 *   - Named-field values (default values, calculated values)
 *   - Tab order (/Tabs /S declared on each page)
 *   - JavaScript action allow/deny list (regex over /JS entries)
 *
 * @module report-validation/checks/CSPdfInteractiveValidator
 */

import * as fs from 'fs';

export interface InteractiveRule {
    /** Assert total AcroForm widget count. */
    fieldCount?: number;
    /** Assert count per FieldType (Tx=text, Btn=button/checkbox/radio, Ch=choice, Sig=signature). */
    fieldCountByType?: Record<string, number>;
    /** Every named field must exist and equal this default value (case-sensitive). */
    fieldDefaults?: Record<string, string>;
    /** Every listed field must exist (name-only assertion, ignores value). */
    fieldsMustExist?: string[];
    /** Every listed page must have a declared tab-order structure (/Tabs). */
    requireTabOrderOnPages?: number[];
    /** Regex allow-list — if set, any /JS entry NOT matching one of these is FORBIDDEN. */
    javascriptAllowPatterns?: string[];
    /** Regex deny-list — any /JS entry matching one of these is FORBIDDEN. */
    javascriptDenyPatterns?: string[];
}

export interface InteractiveFinding {
    kind:
        | 'FIELD_COUNT_DRIFT'
        | 'FIELD_TYPE_COUNT_DRIFT'
        | 'FIELD_DEFAULT_DRIFT'
        | 'FIELD_MISSING'
        | 'TAB_ORDER_MISSING'
        | 'JAVASCRIPT_FORBIDDEN';
    message: string;
    fieldName?: string;
    page?: number;
    expected?: string;
    actual?: string;
}

export interface InteractiveInventory {
    fields: Array<{
        name: string;
        type: string;
        defaultValue?: string;
        value?: string;
        page?: number;
    }>;
    tabOrderByPage: Record<number, string | undefined>;
    javascriptActions: string[];
}

export async function readInteractiveInventory(pdfPath: string): Promise<InteractiveInventory> {
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importDyn: any = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')();
    const pdfjs = await importDyn;
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;

    const fields: InteractiveInventory['fields'] = [];
    const tabOrderByPage: Record<number, string | undefined> = {};
    // pdfjs surfaces AcroForm fields inside per-page annotations with subtype 'Widget'.
    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const anns = await page.getAnnotations();
        for (const a of anns) {
            if (a?.subtype !== 'Widget') continue;
            fields.push({
                name: String(a.fieldName ?? '(unnamed)'),
                type: String(a.fieldType ?? 'Unknown'),
                defaultValue: typeof a.defaultFieldValue === 'string' ? a.defaultFieldValue : undefined,
                value: typeof a.fieldValue === 'string' ? a.fieldValue : undefined,
                page: p,
            });
        }
        // Tab-order structure. pdfjs exposes it on the page's raw dict as `_pageInfo.tabs`
        // in some builds; when unavailable, treat as undeclared.
        const raw = (page as unknown as { _pageDict?: { get?: (k: string) => unknown } })._pageDict;
        tabOrderByPage[p] = raw && typeof raw.get === 'function' ? String(raw.get('Tabs') ?? '') || undefined : undefined;
    }

    // Document-level JavaScript actions — pdfjs `getJSActions()` returns keyed map.
    let javascriptActions: string[] = [];
    try {
        const docJs = await doc.getJSActions();
        if (docJs) {
            for (const list of Object.values(docJs)) {
                if (Array.isArray(list)) for (const s of list) if (typeof s === 'string') javascriptActions.push(s);
            }
        }
    } catch {
        /* not all PDFs have JS actions */
    }

    try {
        await doc.destroy();
    } catch {
        /* best-effort */
    }
    return { fields, tabOrderByPage, javascriptActions };
}

export function validateInteractive(inv: InteractiveInventory, rule: InteractiveRule): InteractiveFinding[] {
    const findings: InteractiveFinding[] = [];

    if (rule.fieldCount !== undefined && inv.fields.length !== rule.fieldCount) {
        findings.push({
            kind: 'FIELD_COUNT_DRIFT',
            message: `Expected ${rule.fieldCount} form fields, found ${inv.fields.length}`,
            expected: String(rule.fieldCount),
            actual: String(inv.fields.length),
        });
    }
    if (rule.fieldCountByType) {
        const byType: Record<string, number> = {};
        for (const f of inv.fields) byType[f.type] = (byType[f.type] ?? 0) + 1;
        for (const [t, expected] of Object.entries(rule.fieldCountByType)) {
            const actual = byType[t] ?? 0;
            if (actual !== expected) {
                findings.push({
                    kind: 'FIELD_TYPE_COUNT_DRIFT',
                    message: `Expected ${expected} field(s) of type "${t}", found ${actual}`,
                    expected: String(expected),
                    actual: String(actual),
                });
            }
        }
    }
    if (rule.fieldDefaults) {
        for (const [name, expected] of Object.entries(rule.fieldDefaults)) {
            const f = inv.fields.find((f) => f.name === name);
            if (!f) {
                findings.push({
                    kind: 'FIELD_MISSING',
                    message: `Expected field "${name}" but not found`,
                    fieldName: name,
                    expected: name,
                });
                continue;
            }
            const actual = f.defaultValue ?? f.value ?? '';
            if (actual !== expected) {
                findings.push({
                    kind: 'FIELD_DEFAULT_DRIFT',
                    message: `Field "${name}" default value mismatch`,
                    fieldName: name,
                    expected,
                    actual,
                });
            }
        }
    }
    if (rule.fieldsMustExist) {
        const names = new Set(inv.fields.map((f) => f.name));
        for (const req of rule.fieldsMustExist) {
            if (!names.has(req)) {
                findings.push({
                    kind: 'FIELD_MISSING',
                    message: `Expected field "${req}" but not found`,
                    fieldName: req,
                    expected: req,
                });
            }
        }
    }
    if (rule.requireTabOrderOnPages) {
        for (const p of rule.requireTabOrderOnPages) {
            if (!inv.tabOrderByPage[p]) {
                findings.push({
                    kind: 'TAB_ORDER_MISSING',
                    message: `Page ${p} does not declare a /Tabs tab-order structure`,
                    page: p,
                });
            }
        }
    }
    if (rule.javascriptAllowPatterns || rule.javascriptDenyPatterns) {
        const allow = (rule.javascriptAllowPatterns ?? []).map(safeRegex).filter((r): r is RegExp => r !== null);
        const deny = (rule.javascriptDenyPatterns ?? []).map(safeRegex).filter((r): r is RegExp => r !== null);
        for (const js of inv.javascriptActions) {
            for (const r of deny) {
                if (r.test(js)) {
                    findings.push({
                        kind: 'JAVASCRIPT_FORBIDDEN',
                        message: `JavaScript action matches deny pattern /${r.source}/: ${js.slice(0, 60)}${js.length > 60 ? '…' : ''}`,
                        actual: js.slice(0, 200),
                    });
                    break;
                }
            }
            if (allow.length > 0) {
                const ok = allow.some((r) => r.test(js));
                if (!ok) {
                    findings.push({
                        kind: 'JAVASCRIPT_FORBIDDEN',
                        message: `JavaScript action not on allow-list: ${js.slice(0, 60)}${js.length > 60 ? '…' : ''}`,
                        actual: js.slice(0, 200),
                    });
                }
            }
        }
    }
    return findings;
}

function safeRegex(p: string): RegExp | null {
    try {
        return new RegExp(p, 'i');
    } catch {
        return null;
    }
}
