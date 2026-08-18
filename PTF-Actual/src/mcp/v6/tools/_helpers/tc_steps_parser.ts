/**
 * tc_steps_parser — reverse of publish_feature_to_ado's `buildStepsXml`.
 *
 * Reads the Microsoft.VSTS.TCM.Steps XML field on an ADO Test Case and
 * emits [{action, expected}] rows. Handles:
 *  - `<step type="ActionStep">` with two `<parameterizedString>` children
 *    (action, expected)
 *  - HTML-escaped, XML-escaped, and doubly-escaped payloads (publish_tool
 *    escapes both HTML AND XML — we must un-escape both)
 *  - Empty expected results (returned as '')
 *  - Missing / malformed XML → returns [] (never throws)
 */

export interface ActionStep {
    /** 1-based order in the test case. */
    order: number;
    /** Plain-text action (Gherkin `When`/`And` form typically). */
    action: string;
    /** Plain-text expected result (may be empty). */
    expected: string;
}

function decodeXmlEntities(s: string): string {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function decodeTwice(s: string): string {
    return decodeXmlEntities(decodeXmlEntities(s));
}

function stripHtml(s: string): string {
    // Replace common block tags with a space before stripping so words don't fuse.
    const withSpaces = s
        .replace(/<\s*(br|BR)\s*\/?>/g, ' ')
        .replace(/<\s*\/\s*(p|div|li|tr|td|h[1-6])\s*>/gi, ' ')
        .replace(/<\s*(p|div|li|tr|td|h[1-6])[^>]*>/gi, ' ');
    return withSpaces.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function parseTestCaseStepsXml(xml: string | undefined | null): ActionStep[] {
    if (!xml || typeof xml !== 'string' || !xml.trim()) return [];
    const out: ActionStep[] = [];
    // Match every <step>…</step> block, capturing the type + the two parameterizedString bodies.
    // Publish tool renders self-closing <description/> after the two strings; ADO web edits
    // may re-render <description>...</description> — regex handles both.
    const stepRe = /<step\b[^>]*>([\s\S]*?)<\/step>/gi;
    let m: RegExpExecArray | null;
    let order = 1;
    while ((m = stepRe.exec(xml)) !== null) {
        const body = m[1];
        // parameterizedString bodies — capture the FIRST two, order matters (action, expected).
        const paramRe = /<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/gi;
        const params: string[] = [];
        let pm: RegExpExecArray | null;
        while ((pm = paramRe.exec(body)) !== null) {
            params.push(pm[1]);
            if (params.length === 2) break;
        }
        const rawAction = params[0] ?? '';
        const rawExpected = params[1] ?? '';
        // Publish tool double-escapes; ADO's own editor may single-escape.
        // Applying decode twice is safe on single-escaped input (second pass finds
        // no entities and is a no-op).
        const action = stripHtml(decodeTwice(rawAction));
        const expected = stripHtml(decodeTwice(rawExpected));
        if (!action && !expected) continue; // fully empty row → skip
        out.push({ order, action, expected });
        order++;
    }
    return out;
}
