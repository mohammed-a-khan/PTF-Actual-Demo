/**
 * Agentic Test Platform — ADO Test Case Parser
 *
 * Parses Azure DevOps test case work-item payloads into a structured
 * `ParsedTestCase`. ADO stores test case steps in a
 * `Microsoft.VSTS.TCM.Steps` field as XML/HTML; the parser is intentionally
 * defensive — many real-world test cases have empty steps, malformed XML,
 * or `SharedStepReference` entries (which link to another work item). When
 * parsing fails we return a `ParsedTestCase` with `steps=[]` and emit a
 * warning rather than throwing.
 *
 * Privacy-by-design: this file contains no domain, organization, or
 * project-specific identifiers. All examples use generic placeholders.
 *
 * @module agent-platform/CSAdoTestCaseParser
 */

// ============================================================================
// Public Types
// ============================================================================

/**
 * One parsed step row from an ADO test case. Indexed from 1 to match how
 * ADO surfaces steps in the UI — note that ADO's underlying Steps XML uses
 * step `id` attributes starting at 2 (1 is reserved), so the displayed step
 * number diverges from the raw id. Both are preserved here.
 */
export interface ParsedTestStep {
    /** 1-based displayed step number (1, 2, 3, …). */
    index: number;
    /** Original ADO step `id` attribute. Preserve for round-trip writes. */
    rawStepId: number;
    /** Human-readable action (e.g. "Click the Login button"). */
    action: string;
    /** Human-readable expected result. May be empty. */
    expected: string;
    /** ADO step type. Common values: ActionStep, ValidateStep, SharedStepReference. */
    rawType: string;
    /** Populated when rawType === 'SharedStepReference'. */
    sharedStepId?: number;
}

/**
 * A fully parsed ADO test case. The `rawWorkItem` field preserves the
 * original payload so downstream code can inspect any field the parser
 * does not surface explicitly.
 */
export interface ParsedTestCase {
    testCaseId: number;
    title: string;
    state: string;
    priority?: number;
    areaPath?: string;
    iterationPath?: string;
    tags: string[];
    preconditions?: string;
    steps: ParsedTestStep[];
    rawWorkItem: Record<string, unknown>;
}

// ============================================================================
// CSAdoTestCaseParser
// ============================================================================

/**
 * Static parser. The single public entry point is `parse`, which takes the
 * full work-item payload (as returned by `ado_work_items_get`) and returns
 * a `ParsedTestCase`. The parser logs warnings via console.warn for
 * non-fatal issues; callers may pipe these through their own logger by
 * intercepting console output.
 */
export class CSAdoTestCaseParser {
    /**
     * Parse a single ADO work-item payload. The expected shape is the
     * standard REST API response: `{ id: number, fields: { ... }, ... }`.
     * Some callers pass just the `fields` object — both forms are accepted.
     */
    public static parse(workItemFields: Record<string, unknown>): ParsedTestCase {
        const wi = workItemFields ?? {};
        const fields = (wi.fields && typeof wi.fields === 'object'
            ? (wi.fields as Record<string, unknown>)
            : wi) as Record<string, unknown>;

        const testCaseId = CSAdoTestCaseParser.readNumber(wi.id) ?? 0;
        const title = CSAdoTestCaseParser.readString(fields['System.Title']);
        const state = CSAdoTestCaseParser.readString(fields['System.State']);
        const priority = CSAdoTestCaseParser.readNumber(
            fields['Microsoft.VSTS.Common.Priority'],
        );
        const areaPath = CSAdoTestCaseParser.readString(
            fields['System.AreaPath'],
        );
        const iterationPath = CSAdoTestCaseParser.readString(
            fields['System.IterationPath'],
        );
        const tagsRaw = CSAdoTestCaseParser.readString(fields['System.Tags']);
        const tags = tagsRaw
            .split(';')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);

        const preconditionsRaw = CSAdoTestCaseParser.readString(
            fields['Microsoft.VSTS.TCM.LocalDataSource'],
        );
        const preconditions = CSAdoTestCaseParser.stripHtml(preconditionsRaw);

        const stepsXml = CSAdoTestCaseParser.readString(
            fields['Microsoft.VSTS.TCM.Steps'],
        );

        let steps: ParsedTestStep[] = [];
        if (stepsXml.trim().length > 0) {
            try {
                steps = CSAdoTestCaseParser.extractStepsFromXml(stepsXml);
            } catch (err) {
                CSAdoTestCaseParser.warn(
                    `parse: failed to extract steps for testCaseId=${testCaseId}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                steps = [];
            }
        }

        return {
            testCaseId,
            title,
            state,
            priority: priority === null ? undefined : priority,
            areaPath: areaPath || undefined,
            iterationPath: iterationPath || undefined,
            tags,
            preconditions: preconditions || undefined,
            steps,
            rawWorkItem: wi,
        };
    }

    /**
     * Extract steps from the `Microsoft.VSTS.TCM.Steps` XML payload. The
     * format is a `<steps>` root with `<step>` children; each step has up
     * to two `<parameterizedString>` elements (action, expected).
     *
     * The parser uses a small regex-based scanner instead of a full XML
     * library to keep the dependency footprint zero. ADO's payload is
     * regular enough for this to work reliably; pathological inputs
     * (deeply nested unbalanced tags, e.g.) fall back to empty steps.
     */
    public static extractStepsFromXml(xml: string): ParsedTestStep[] {
        type Intermediate = Omit<ParsedTestStep, 'index'> & { sortKey: number };
        const intermediate: Intermediate[] = [];
        const stepRe =
            /<step\b([^>]*)>([\s\S]*?)<\/step>/gi;
        let match: RegExpExecArray | null;
        let fallbackId = 2;

        while ((match = stepRe.exec(xml)) !== null) {
            const attrBlob = match[1] ?? '';
            const inner = match[2] ?? '';
            const idAttr = CSAdoTestCaseParser.readAttr(attrBlob, 'id');
            const typeAttr = CSAdoTestCaseParser.readAttr(attrBlob, 'type');

            const idNum = idAttr ? Number(idAttr) : NaN;
            const rawStepId = Number.isFinite(idNum) && idNum > 0
                ? idNum
                : fallbackId;
            fallbackId = Math.max(fallbackId, rawStepId) + 1;

            const rawType = typeAttr || 'ActionStep';

            // Shared step references carry a ref attribute, not parameterizedStrings.
            if (rawType === 'SharedStepReference') {
                const refAttr =
                    CSAdoTestCaseParser.readAttr(attrBlob, 'ref') ||
                    CSAdoTestCaseParser.readAttr(attrBlob, 'sharedstepid');
                const sharedStepId = refAttr ? Number(refAttr) : undefined;
                intermediate.push({
                    sortKey: rawStepId,
                    rawStepId,
                    action: '<shared step reference>',
                    expected: '',
                    rawType,
                    sharedStepId:
                        sharedStepId !== undefined &&
                        Number.isFinite(sharedStepId)
                            ? sharedStepId
                            : undefined,
                });
                continue;
            }

            // Action / validate / generic step — read parameterizedStrings.
            const paramRe =
                /<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/gi;
            const params: string[] = [];
            let pm: RegExpExecArray | null;
            while ((pm = paramRe.exec(inner)) !== null) {
                params.push(CSAdoTestCaseParser.stripHtml(pm[1] ?? ''));
            }

            const action = (params[0] ?? '').trim();
            const expected = (params[1] ?? '').trim();
            intermediate.push({
                sortKey: rawStepId,
                rawStepId,
                action,
                expected,
                rawType,
            });
        }

        // Sort by raw id (preserves ADO authoring order) and assign 1-based
        // displayed indices. Step #1 is intentionally not used by ADO — the
        // first authored step has rawStepId=2 in the underlying XML — so we
        // re-number here to give callers stable 1, 2, 3, … indices.
        intermediate.sort((a, b) => a.sortKey - b.sortKey);
        return intermediate.map(({ sortKey: _sortKey, ...rest }, i) => ({
            index: i + 1,
            ...rest,
        }));
    }

    /**
     * Serialize a list of steps back to the `Microsoft.VSTS.TCM.Steps` XML
     * payload understood by Azure DevOps. Used by the Mode B create-back
     * flow when CS-AI-Auto-Assist authors a new ADO test case from a
     * generated Gherkin scenario.
     *
     * Step IDs start at 2 (ADO reserves id=1) and `<steps last=...>` points
     * at the final step's id. Action/expected text is HTML-encoded and
     * wrapped in `<P>` to match the format the ADO web UI emits.
     */
    public static serializeStepsXml(
        steps: Array<{ action: string; expected?: string }>,
    ): string {
        if (!steps || steps.length === 0) {
            return '<steps id="0" last="1" />';
        }
        const parts: string[] = [];
        const firstId = 2;
        const lastId = firstId + steps.length - 1;
        parts.push(`<steps id="0" last="${lastId}">`);
        steps.forEach((s, i) => {
            const stepId = firstId + i;
            const actionHtml = CSAdoTestCaseParser.toParameterizedHtml(s.action);
            const expectedHtml = CSAdoTestCaseParser.toParameterizedHtml(
                s.expected ?? '',
            );
            parts.push(
                `<step id="${stepId}" type="ActionStep">` +
                    `<parameterizedString isformatted="true">${actionHtml}</parameterizedString>` +
                    `<parameterizedString isformatted="true">${expectedHtml}</parameterizedString>` +
                    `<description/>` +
                    `</step>`,
            );
        });
        parts.push('</steps>');
        return parts.join('');
    }

    /**
     * HTML-encode a plain string and wrap in `<P>` for the
     * `<parameterizedString isformatted="true">` payload. ADO's web UI
     * emits `<P>` (uppercase) wrappers so we match that for fidelity.
     */
    private static toParameterizedHtml(text: string): string {
        const safe = (text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        return `&lt;P&gt;${safe}&lt;/P&gt;`;
    }

    /**
     * Strip HTML tags and decode common HTML entities. ADO wraps action /
     * expected text in `<P>`, `<DIV>`, `<BR>`, etc. We collapse all of that
     * into plain text suitable for Gherkin step phrasing.
     */
    public static stripHtml(html: string): string {
        if (!html) return '';

        // ADO's parameterizedString payloads are HTML wrapped in `&lt;P&gt;`
        // entities, so we must decode entities FIRST — otherwise the tag
        // strip step below sees `&lt;P&gt;` (no actual `<` char) and leaves
        // it intact, decoding into literal `<P>` tags in the output.
        let s = html
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&apos;/gi, "'")
            // Decode `&amp;` last so we don't double-decode entities like
            // `&amp;lt;` into `<`.
            .replace(/&amp;/gi, '&');

        // Remove script/style blocks entirely.
        s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

        // Convert common block-level closers to whitespace so words don't
        // glue together when tags are stripped.
        s = s.replace(/<\/(p|div|br|li|tr|h[1-6])\s*>/gi, ' ');
        s = s.replace(/<br\s*\/?>(?!\s*<\/)/gi, ' ');

        // Strip all remaining tags.
        s = s.replace(/<[^>]+>/g, '');

        // Collapse whitespace runs.
        s = s.replace(/\s+/g, ' ').trim();
        return s;
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    /**
     * Read a quoted attribute value from a `<step ...>` opening-tag blob.
     * Tolerates both single and double quotes; returns null when absent.
     */
    private static readAttr(blob: string, name: string): string | null {
        const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
        const m = blob.match(re);
        if (!m) return null;
        return m[2] ?? m[3] ?? null;
    }

    /**
     * Coerce a field value to string; nulls and undefineds become empty.
     */
    private static readString(v: unknown): string {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return '';
    }

    /**
     * Coerce a field value to a finite number, or null when not coercible.
     */
    private static readNumber(v: unknown): number | null {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') {
            const n = Number(v);
            if (Number.isFinite(n)) return n;
        }
        return null;
    }

    /**
     * Emit a non-fatal parser warning. Routed through console.warn so it
     * surfaces in the MCP server's stderr without coupling the parser to
     * the MCPToolContext logger.
     */
    private static warn(message: string): void {
        // eslint-disable-next-line no-console
        console.warn(`CSAdoTestCaseParser: ${message}`);
    }
}
