/**
 * CS Report Validation — single-report assertion steps.
 *
 * The parity steps in `CSReportValidationSteps` answer "do these two reports agree?". These
 * answer the other question: "does THIS report say what it is supposed to say?" — a spot
 * check against a value you already know, from wherever you know it.
 *
 * WHERE THE EXPECTED VALUE COMES FROM
 * -----------------------------------
 * Nowhere in this file, and that is deliberate. Every step argument and every data-table cell
 * is already passed through `CSValueResolver` before a step definition sees it, so the whole
 * "expected value from elsewhere" axis is inherited rather than re-implemented:
 *
 *   "400,000.30"                        a literal
 *   "<marketValue>"                     a Scenario Outline column
 *   "{{expectedMv}}"                    test data / a stored context variable
 *   "{context:dbResult.SOME_COLUMN}"    a stored DB result set — first row; column-name
 *                                       matching is normalized, so SOME_COLUMN, someColumn
 *                                       and "Some Column" all resolve
 *   "{config:EXPECTED_MV}"              configuration
 *   "{env:EXPECTED_MV}"                 environment
 *   "$expectedMv"                       alternative variable syntax
 *
 * Encrypted values are decrypted on the way through and registered for masking in reports.
 * So validating against the database is: run the existing
 * `user executes query "…" and stores result as "q"` step, then reference `{context:q.COL}`.
 *
 * HOW VALUES ARE COMPARED
 * -----------------------
 * Through the same `compareValues` the reconciler uses, with the same `spec.tolerances`. The
 * expected string is normalized with the spec's `dateFormats` first, so `"400,000.30"`
 * matches the number `408406.3`, `"01/10/2025"` matches a date however the report printed it,
 * and `"(1,234.50)"` matches `-1234.5`. A difference that is only formatting, or that falls
 * inside the field's tolerance, PASSES — asserting on presentation is what
 * `CSReportDiffReporter` is for, not what a spot check should fail on.
 *
 * ROW ADDRESSING
 * --------------
 * By business key, never by position. Row order legitimately differs between report engines —
 * the migrated report in this framework's own POC prints its rows alphabetically where the
 * legacy one does not — so a positional assertion would encode a difference that is not a
 * defect. The key is `spec.keyColumns` in order, `|`-separated. Supplying fewer parts than
 * the spec declares is allowed and matches on the prefix; if that turns out to be ambiguous
 * the step fails and lists the candidates rather than silently taking the first.
 *
 * LIMITATION: a key VALUE containing `|` cannot be written in the `keyed "…"` form — it would
 * be read as two key parts. The step says so explicitly ("has 2 part(s) but the spec declares
 * 1 key column") rather than mis-matching. Use the row-table form, whose cells are separate,
 * for keys that can contain the separator.
 *
 * @module steps/report-validation/CSReportAssertionSteps
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSBDDContext } from '../../bdd/CSBDDContext';
import { CSReporter } from '../../reporter/CSReporter';
import { compareValues } from '../../report-validation/CSReportReconciler';
import { normalizeValue } from '../../report-validation/CSReportNormalizer';
import type { CanonicalRecord, CanonicalReport, CanonicalValue, ReportSource } from '../../report-validation/CSReportModel';
import type { ReportSpec } from '../../report-validation/CSReportSpec';

const CTX_SPEC = 'reportvalidation.spec';
const CTX_BY_SOURCE: Record<ReportSource, string> = {
    crystal: 'reportvalidation.crystal',
    ssrs: 'reportvalidation.ssrs',
    db: 'reportvalidation.db',
};

/** Separator between key parts in the `keyed "…"` argument. */
const KEY_SEP = '|';

/**
 * Classifications that mean "the value is right".
 *
 * `FORMAT_ONLY` is a presentation difference over an identical normalized value, and
 * `WITHIN_TOLERANCE` is a numeric difference the spec explicitly declared acceptable. Failing
 * a spot check on either would make the step disagree with the reconciler about what counts
 * as a difference, which is worse than useless — it would be two definitions of correct.
 */
const PASSING = new Set(['MATCH', 'FORMAT_ONLY', 'WITHIN_TOLERANCE']);

export class CSReportAssertionSteps {
    private ctx = CSBDDContext.getInstance();

    // ---- single field ------------------------------------------------------

    @CSBDDStepDef('the {word} report row keyed {string} should have {string} as {string}')
    async rowFieldShouldBe(source: string, key: string, field: string, expected: string): Promise<void> {
        this.assertField(parseSource(source), key, undefined, field, expected, true);
    }

    @CSBDDStepDef('the {word} report row keyed {string} in section {string} should have {string} as {string}')
    async rowFieldInSectionShouldBe(source: string, key: string, section: string, field: string, expected: string): Promise<void> {
        this.assertField(parseSource(source), key, section, field, expected, true);
    }

    @CSBDDStepDef('the {word} report row keyed {string} should not have {string} as {string}')
    async rowFieldShouldNotBe(source: string, key: string, field: string, expected: string): Promise<void> {
        this.assertField(parseSource(source), key, undefined, field, expected, false);
    }

    // ---- several fields of one row ----------------------------------------

    @CSBDDStepDef('the {word} report row keyed {string} should have:')
    async rowFieldsShouldBe(source: string, key: string, table: DataTableLike): Promise<void> {
        this.assertFieldTable(parseSource(source), key, undefined, table);
    }

    @CSBDDStepDef('the {word} report row keyed {string} in section {string} should have:')
    async rowFieldsInSectionShouldBe(source: string, key: string, section: string, table: DataTableLike): Promise<void> {
        this.assertFieldTable(parseSource(source), key, section, table);
    }

    // ---- several rows ------------------------------------------------------

    @CSBDDStepDef('the {word} report section {string} should contain rows:')
    async sectionShouldContainRows(source: string, section: string, table: DataTableLike): Promise<void> {
        // Signature note: the section argument comes second here, so the {word} source is
        // still first and every step in this file reads "the <source> report …".
        this.assertRowTable(parseSource(source), section, table);
    }

    @CSBDDStepDef('the {word} report should contain rows:')
    async reportShouldContainRows(source: string, table: DataTableLike): Promise<void> {
        this.assertRowTable(parseSource(source), undefined, table);
    }

    // ---- internals ---------------------------------------------------------

    private assertField(
        source: ReportSource,
        key: string,
        section: string | undefined,
        field: string,
        expected: string,
        shouldMatch: boolean,
    ): void {
        const spec = requireSpec(this.ctx);
        const canonical = requireCanonical(this.ctx, source);
        const record = findRecord(canonical, spec, key, section);
        const outcome = compareField(record, spec, field, expected);

        if (outcome.passed === shouldMatch) {
            CSReporter.pass(
                `${source} ${describeKey(record)} ${field} ${shouldMatch ? '=' : '≠'} ${JSON.stringify(expected)}` +
                (outcome.classification !== 'MATCH' ? ` (${outcome.classification})` : ''),
            );
            return;
        }
        throw new Error(
            shouldMatch
                ? `Report assertion failed on ${source}: ${describeKey(record)} field "${field}" — ` +
                  `expected ${JSON.stringify(expected)}, got ${JSON.stringify(rawOf(record.fields[field]))} ` +
                  `[${outcome.classification}${outcome.reason ? `: ${outcome.reason}` : ''}]`
                : `Report assertion failed on ${source}: ${describeKey(record)} field "${field}" — ` +
                  `expected NOT to be ${JSON.stringify(expected)}, but it is`,
        );
    }

    private assertFieldTable(source: ReportSource, key: string, section: string | undefined, table: DataTableLike): void {
        const spec = requireSpec(this.ctx);
        const canonical = requireCanonical(this.ctx, source);
        const record = findRecord(canonical, spec, key, section);

        // Two accepted shapes: a `field | value` table (with or without a header row), and a
        // one-row-per-field table. Both are what people actually write.
        const rows = stripFieldValueHeader(table.raw());
        const failures: string[] = [];
        for (const [field, expected] of rows) {
            const outcome = compareField(record, spec, field, expected);
            if (!outcome.passed) {
                failures.push(
                    `  ${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(rawOf(record.fields[field]))}` +
                    ` [${outcome.classification}]`,
                );
            }
        }
        if (failures.length > 0) {
            throw new Error(
                `Report assertion failed on ${source}: ${describeKey(record)} — ` +
                `${failures.length} of ${rows.length} field(s) differ:\n${failures.join('\n')}`,
            );
        }
        CSReporter.pass(`${source} ${describeKey(record)} matched all ${rows.length} expected field(s)`);
    }

    private assertRowTable(source: ReportSource, section: string | undefined, table: DataTableLike): void {
        const spec = requireSpec(this.ctx);
        const canonical = requireCanonical(this.ctx, source);
        const raw = table.raw();
        if (raw.length < 2) {
            throw new Error('CSReportAssertionSteps: the row table needs a header row of canonical field names plus at least one data row');
        }

        const headers = raw[0].map((h) => String(h).trim());
        const keyColumns = (spec.keyColumns ?? []).filter((k) => headers.includes(k));
        if (keyColumns.length === 0) {
            throw new Error(
                `CSReportAssertionSteps: the row table must include at least one key column so rows can be located — ` +
                `spec.keyColumns are [${(spec.keyColumns ?? []).join(', ')}], table has [${headers.join(', ')}]`,
            );
        }

        const failures: string[] = [];
        for (let r = 1; r < raw.length; r++) {
            const cells = raw[r];
            const expectedByField = new Map<string, string>();
            headers.forEach((h, i) => expectedByField.set(h, cells[i] === undefined ? '' : String(cells[i])));
            const keyText = keyColumns.map((k) => expectedByField.get(k) ?? '').join(KEY_SEP);

            let record: CanonicalRecord;
            try {
                record = findRecord(canonical, spec, keyText, section, keyColumns);
            } catch (err) {
                failures.push(`  row ${r}: ${(err as Error).message}`);
                continue;
            }
            for (const [field, expected] of expectedByField) {
                if (keyColumns.includes(field)) continue; // already matched on it
                const outcome = compareField(record, spec, field, expected);
                if (!outcome.passed) {
                    failures.push(
                        `  row ${r} (${keyText}) ${field}: expected ${JSON.stringify(expected)}, ` +
                        `got ${JSON.stringify(rawOf(record.fields[field]))} [${outcome.classification}]`,
                    );
                }
            }
        }
        if (failures.length > 0) {
            throw new Error(
                `Report assertion failed on ${source}${section ? ` section "${section}"` : ''}: ` +
                `${failures.length} problem(s) across ${raw.length - 1} expected row(s):\n${failures.join('\n')}`,
            );
        }
        CSReporter.pass(
            `${source}${section ? ` section "${section}"` : ''}: all ${raw.length - 1} expected row(s) matched ` +
            `on [${keyColumns.join(', ')}]`,
        );
    }
}

/** Minimal shape of the framework's DataTable — kept structural so the steps don't import the runner. */
interface DataTableLike {
    raw(): any[][];
}

function requireSpec(ctx: CSBDDContext): ReportSpec {
    const spec = ctx.get<ReportSpec>(CTX_SPEC);
    if (!spec) throw new Error('CSReportAssertionSteps: no active report spec — call `Given the report spec "…"` first');
    return spec;
}

function requireCanonical(ctx: CSBDDContext, source: ReportSource): CanonicalReport {
    const canonical = ctx.get<CanonicalReport>(CTX_BY_SOURCE[source]);
    if (!canonical) {
        throw new Error(
            `CSReportAssertionSteps: no ${source} report ingested yet — run ` +
            `\`When I ingest the ${source} report from "…"\` (or the acquire step) first`,
        );
    }
    return canonical;
}

function parseSource(word: string): ReportSource {
    const norm = word.toLowerCase().trim();
    if (norm === 'crystal') return 'crystal';
    if (norm === 'ssrs') return 'ssrs';
    if (norm === 'db' || norm === 'database') return 'db';
    throw new Error(`CSReportAssertionSteps: unknown report source "${word}" — expected one of crystal|ssrs|db`);
}

/**
 * Locate one record by business key.
 *
 * `keyText` is the spec's `keyColumns` in order, `|`-separated. Fewer parts than the spec
 * declares matches on the prefix, which is what makes `keyed "REF256002"` work on a spec keyed
 * by identifier AND amount — right up until the report carries the same identifier twice at
 * different amounts, which real portfolios do. That case fails and prints the candidates,
 * because picking the first would make the assertion depend on extraction order.
 */
function findRecord(
    canonical: CanonicalReport,
    spec: ReportSpec,
    keyText: string,
    section: string | undefined,
    keyColumnsOverride?: string[],
): CanonicalRecord {
    const keyColumns = keyColumnsOverride ?? spec.keyColumns ?? [];
    if (keyColumns.length === 0) {
        throw new Error('CSReportAssertionSteps: the spec declares no keyColumns, so rows cannot be addressed by key');
    }
    const parts = keyText.split(KEY_SEP).map((p) => p.trim());
    if (parts.length > keyColumns.length) {
        throw new Error(
            `CSReportAssertionSteps: key "${keyText}" has ${parts.length} part(s) but the spec declares ` +
            `${keyColumns.length} key column(s) [${keyColumns.join(', ')}]`,
        );
    }

    const matches = canonical.records.filter((record) => {
        if (section && record.sectionId !== section) return false;
        return parts.every((part, i) => keyMatches(record.key?.[keyColumns[i]], part, spec));
    });

    if (matches.length === 1) return matches[0];

    if (matches.length === 0) {
        const scope = section ? ` in section "${section}"` : '';
        const near = canonical.records
            .filter((r) => (!section || r.sectionId === section) && keyMatches(r.key?.[keyColumns[0]], parts[0], spec))
            .slice(0, 5)
            .map((r) => keyColumns.map((k) => r.key?.[k] ?? '').join(KEY_SEP));
        throw new Error(
            `no row keyed "${keyText}"${scope} in the ${canonical.source} report ` +
            `(${canonical.records.length} row(s) extracted)` +
            (near.length > 0 ? `. Rows sharing the first key part: ${near.join(' , ')}` : ''),
        );
    }

    const candidates = matches.slice(0, 5).map((r) => `${r.sectionId}:${keyColumns.map((k) => r.key?.[k] ?? '').join(KEY_SEP)}`);
    throw new Error(
        `key "${keyText}" is ambiguous in the ${canonical.source} report — it matches ${matches.length} rows. ` +
        `Add the remaining key part(s) or an "in section" clause. Candidates: ${candidates.join(' , ')}` +
        (matches.length > 5 ? ` (+${matches.length - 5} more)` : ''),
    );
}

/**
 * Compare one key part against a record's stored key.
 *
 * Keys are stored already-normalized (unformatted, not as printed), while a feature
 * file naturally writes the number as the report printed it. Normalizing the supplied part
 * the same way lets either spelling address the same row.
 */
function keyMatches(stored: string | undefined, supplied: string, spec: ReportSpec): boolean {
    if (stored === undefined) return false;
    if (stored === supplied) return true;
    const a = normalizeValue(stored, { dateFormats: spec.dateFormats });
    const b = normalizeValue(supplied, { dateFormats: spec.dateFormats });
    if (a.kind === 'number' && b.kind === 'number') return a.value === b.value;
    if (a.kind === 'date' && b.kind === 'date') return a.value === b.value;
    return String((a as any).value ?? a.raw).toLowerCase() === String((b as any).value ?? b.raw).toLowerCase();
}

interface FieldOutcome {
    passed: boolean;
    classification: string;
    reason?: string;
}

function compareField(record: CanonicalRecord, spec: ReportSpec, field: string, expected: string): FieldOutcome {
    if (!(field in (spec.fieldMap ?? {}))) {
        throw new Error(
            `CSReportAssertionSteps: "${field}" is not a canonical field in spec "${spec.reportType}". ` +
            `Declared fields: [${Object.keys(spec.fieldMap ?? {}).join(', ')}]`,
        );
    }
    const actual = record.fields[field];
    const expectedValue = normalizeValue(expected, { dateFormats: spec.dateFormats });
    const result = compareValues(actual ?? { kind: 'null', raw: '' }, expectedValue, spec.tolerances?.[field]);
    return {
        passed: PASSING.has(result.classification),
        classification: result.classification,
        reason: result.reason,
    };
}

/**
 * Accept a `field | value` table with or without a header row.
 *
 * Writers add a `| field | value |` header about half the time; silently treating it as an
 * assertion on a field literally named "field" would produce a baffling error message.
 */
function stripFieldValueHeader(raw: any[][]): Array<[string, string]> {
    const rows = raw
        .filter((r) => r.length >= 2)
        .map((r) => [String(r[0]).trim(), r[1] === undefined ? '' : String(r[1])] as [string, string]);
    if (rows.length > 0) {
        const [first, second] = rows[0];
        if (first.toLowerCase() === 'field' && ['value', 'expected'].includes(second.toLowerCase().trim())) {
            return rows.slice(1);
        }
    }
    return rows;
}

function describeKey(record: CanonicalRecord): string {
    const parts = Object.entries(record.key ?? {}).map(([k, v]) => `${k}=${v}`);
    return `[${record.sectionId}${parts.length ? ' ' + parts.join(' ') : ''}]`;
}

function rawOf(value: CanonicalValue | undefined): string {
    if (!value) return '(field not present on this row)';
    return value.raw;
}
