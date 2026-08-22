/**
 * CS Report Validation — Report Spec + Loader
 *
 * One JSON spec per report per project, stored under `config/report-specs/`.
 * Onboarding a new report to validation = writing a spec (no code change);
 * the reconciler + normalizer + section validator all consume the spec.
 *
 * The spec defines:
 *   - business identity: `reportType`, `project`, key columns
 *   - acquisition rules: default export format, "PDF-only" enforcement
 *   - column mapping: canonical → { crystal name, ssrs name, db name }
 *   - comparison rules: per-field tolerances, date formats, ignored fields,
 *     known-diff allowlist
 *   - structural expectations: required sections + expected order
 *   - DB oracle: connection alias + dialect-aware query
 *
 * The loader validates the shape at read time so a broken spec is caught
 * up-front (not at test-execution time when the failure is expensive to
 * diagnose).
 *
 * @module report-validation/CSReportSpec
 */

/** Tolerance rule for one canonical field. See `CSReportReconciler` for evaluation semantics. */
export type ToleranceSpec =
    | {
          type: 'number';
          /** Absolute-difference tolerance. `|a - b| <= epsilon` passes. Default 0 = strict. */
          epsilon?: number;
          /** Relative tolerance. `|a - b| / max(|a|, |b|) <= relative` passes. Useful for large numbers where absolute isn't enough. */
          relative?: number;
      }
    | {
          type: 'string';
          /** Levenshtein similarity threshold in [0, 1]. `similarity(a, b) >= fuzzy` passes. Default undefined = strict equality after normalization. */
          fuzzy?: number;
      };

/**
 * Per-source column names for one canonical field. A string is the single name that source
 * prints; an array lists accepted spellings, any of which resolves to the canonical field.
 */
export interface SpecFieldNames {
    [source: string]: string | string[] | undefined;
}

/**
 * One figure in a section's summary block — the label-and-value lines printed above the
 * detail grid. They sit outside every column band, so the row-level walk cannot reach them.
 * Declaring them here is what puts them under comparison; anything not declared is not
 * checked.
 */
export interface SummaryFieldSpec {
    /** Canonical id for the figure. Tolerances are looked up under this name in `spec.tolerances`. */
    id: string;
    /**
     * The label printed to the left of the value. Matched case-insensitively with runs of
     * whitespace collapsed, so spacing differences between engines don't matter.
     */
    label: string;
    /**
     * Which value on the label's line to take, 1-based. Default 1.
     *
     * A summary line often carries more than one — an amount and the ratio it feeds.
     * Formula markers such as `(A)` or `(B)/(A)` are not values and are never counted.
     */
    valueIndex?: number;
    /**
     * Regex alternatives to `label`, tried when the literal label does not match.
     *
     * A label can reach the text layer incomplete — clipped at the page edge, or split so that
     * only its tail survives as one run (`Total Number of Obligors:` arriving as
     * `ber of Obligors:`). Rather than weaken label matching for every report, the reports that
     * need it say so: `["ber of Obligors:?$"]`.
     */
    labelMatchers?: string[];
}

/** A section that MUST be present in the report (used by `CSReportSectionValidator`). */
export interface RequiredSectionSpec {
    /** Canonical id — what the section is called in `CanonicalReport.sections[].id`. */
    id: string;
    /** Display title — used in HTML diff reports and by the section validator when reporting misses. */
    title: string;
    /** 1-indexed expected position among detected sections. Enforced when `enforceSectionOrder` is true on the spec. */
    order: number;
    /**
     * Regex patterns (as strings, compiled at load time) that match the raw section title
     * on ANY source (Crystal, SSRS, or DB-derived section names). Case-insensitive by
     * default. Used by `CSReportSectionMapper` to resolve a raw title into this canonical
     * id — e.g. Crystal's `Position Detail` and SSRS's `Position Detail 1D` both
     * match to canonical `positionDetail`. When omitted, the mapper falls back to
     * case-insensitive substring match on `title`.
     */
    matchers?: string[];
    /**
     * Figures in the section's calculation block to compare. Omit when the section is a
     * plain grid. See `SummaryFieldSpec`.
     */
    summaryFields?: SummaryFieldSpec[];
    /**
     * Charts that must appear in this section, given as regex patterns matched against the
     * section's rendered text and any detected chart captions.
     *
     * A chart's title is drawn as ordinary text, so this asserts the titled block is present.
     * It is deliberately a text check: chart-region detection identifies where the plotted
     * area is, but a caption is not a reliable identity, and a missing chart shows up first as
     * a missing title.
     */
    requiredCharts?: string[];
}

/** One entry in the intentional-difference allowlist. Findings that match it downgrade to `KNOWN_DIFFERENCE`. */
export interface KnownDifferenceSpec {
    /** Which section this applies to. `'*'` for cross-section. */
    section: string;
    /**
     * Optional key filter: only matches records whose key entries all equal these. Omit to apply
     * to every record in the section. Example: `{ accountNo: '12345' }` limits the allowance to
     * one specific row.
     */
    key?: Record<string, string>;
    /** Optional field filter: only matches this canonical field. Omit to apply at row level. */
    field?: string;
    /** Human-readable reason — surfaces in the diff report so future readers know why this was excused. */
    reason: string;
}

/** How to query the DB oracle for this report. Supports single portable SQL or a dialect map. */
export type SpecDatabaseQuery =
    | string
    | {
          sqlserver?: string;
          oracle?: string;
      };

/**
 * Stored-procedure form of the DB oracle. Preferred over `query` when the reporting data is
 * only reachable through a procedure — it uses real driver-level parameter binding rather
 * than the textual `@name` substitution the `query` path performs, and it can consume a
 * procedure that emits SEVERAL result sets.
 */
export interface SpecProcedure {
    /** Procedure name, schema-qualified (e.g. `dbo.usp_ExampleReport`). */
    name: string;
    /**
     * Ordered parameter names, bound POSITIONALLY in this order. Each name is resolved
     * against the bound params — `entity` (always supplied from the active entity) plus
     * anything set via the `the report parameter "<name>" is "<value>"` step. A name with
     * no value is an error, not a silent NULL.
     */
    params?: string[];
    /**
     * Section id for each result set the procedure returns, in order. Declare this when the
     * procedure emits one SELECT per report section. An empty string discards that result
     * set — use it for a leading count/status set you don't want compared.
     *
     * Omit entirely for a single-result-set procedure; the rows then follow the normal flat
     * path (`sectionColumn` if set, otherwise the spec's first required section).
     */
    resultSets?: string[];
}

/** The DB oracle block on a spec. Resolved to a `CSDataProvider` `loadData({type:'database',...})` call at run time. */
export interface SpecDatabase {
    /** Named connection from the framework's DB config (e.g. `REPORTS_DB`, `GATEWAY_ORACLE`). */
    connectionAlias: string;
    /**
     * SQL query. When a dialect map is used, the reconciler picks the branch matching the
     * active DB `config.type`. Mutually exclusive with `procedure` — supply exactly one.
     */
    query?: SpecDatabaseQuery;
    /** Stored-procedure call. Mutually exclusive with `query` — supply exactly one. */
    procedure?: SpecProcedure;
}

/** Full report spec — the authoritative onboarding artefact for a report. */
export interface ReportSpec {
    /** Business report type, e.g. `BalanceSheet`, `CustomerStatement`. Matches `CanonicalReport.reportType`. */
    reportType: string;
    /** Product/project this spec belongs to, e.g. `Reporting`, `Statements`. */
    project: string;
    /** Default export format when the acquisition step is called without an override. */
    exportFormat: 'excel' | 'csv' | 'xml' | 'pdf';
    /** When true, the acquisition step IGNORES any step-level format override and always takes the PDF path. Enforces the "don't force export on PDF-only reports" rule. */
    pdfOnly: boolean;
    /**
     * Ordered list of canonical column names whose combined values uniquely identify a row.
     * These become `CanonicalRecord.key`. The reconciler matches by this key across sides,
     * not by row position, so reordered rows still pass.
     */
    keyColumns: string[];
    /**
     * Canonical field name → per-source column-name mapping. Each entry says "this canonical
     * field is called X in Crystal, Y in SSRS, Z in the DB". Missing per-source entries mean
     * the field doesn't appear in that source (which is fine — that side just skips it).
     *
     * A per-source entry may be a LIST of names instead of one, and any of them resolves to
     * the canonical field. Use it when one business concept is printed under different
     * headings in different sections of the same report. The alternative, a separate
     * canonical field per spelling, splits one concept in two and makes every cross-section
     * total and tolerance rule say it twice.
     */
    fieldMap: Record<string, SpecFieldNames>;
    /** Per-canonical-field tolerance rules. Fields not listed here compare strictly (after normalization). */
    tolerances: Record<string, ToleranceSpec>;
    /**
     * Date-format hints to try, in order, when normalizing a date-shaped string. Supported tokens:
     * `yyyy`, `MM` (numeric), `MMM` (Jan), `MMMM` (January), `dd`, `HH`, `mm`, `ss`. First format
     * that fully parses wins; failures continue to the next.
     */
    dateFormats: string[];
    /** Canonical field names to skip during comparison — timestamps, page numbers, "printed on", etc. */
    ignoreFields: string[];
    /** Sections the report MUST contain. Used by `CSReportSectionValidator`. */
    requiredSections: RequiredSectionSpec[];
    /** Intentional-difference allowlist. Matching findings become `KNOWN_DIFFERENCE` (recorded, not failing). */
    knownDifferences: KnownDifferenceSpec[];
    /** DB oracle configuration. Optional — Phase-1 parity checks (Crystal vs SSRS) don't need it. */
    database?: SpecDatabase;
    /** When true, `CSReportSectionValidator` fails if required sections appear out of the declared order. Default false. */
    enforceSectionOrder?: boolean;
    /** When true, an OCR pass runs on pages where pdfjs finds zero text items (image-only). Default false. */
    ocrFallback?: boolean;
    /** When true, after data reconciliation passes, a pixel-diff runs. Only for same-generator regression (e.g. SSRS-vs-SSRS across releases), NOT for Crystal-vs-SSRS parity. */
    visualDiff?: boolean;
    /**
     * When true, `meta.checksums` disagreements between sides (beyond `checksumTolerance`)
     * FAIL the reconciliation with `CHECKSUM_DRIFT` findings. Signals extraction
     * incompleteness so a silently-truncated PDF (missing final page, dropped rows) can't
     * ship as "MISSING keys look like data bugs". Default false — checksum findings are
     * still recorded so humans see them, but they don't gate pass/fail unless this is on.
     */
    enforceChecksums?: boolean;
    /**
     * Tolerance for the FOOTING check — a section's printed total against the sum of the
     * rows extracted from that section.
     *
     * Needs its own tolerance, separate from `checksumTolerance` and from per-field epsilon,
     * because the drift here is not measurement error: reports routinely foot from unrounded
     * values while printing each row rounded to 2dp, so the gap grows with ROW COUNT — up to
     * half a cent per row. A flat absolute tolerance either fails every long section or is so
     * loose it stops catching a dropped page.
     *
     * Hence the object form: `absolute + perRow × rowCount`. A number is shorthand for
     * `{ absolute: n, perRow: 0 }`. Default `{ absolute: 0.01, perRow: 0 }` — strict, so a
     * spec opts INTO the rounding allowance deliberately.
     *
     * Example: `{ absolute: 0.01, perRow: 0.005 }` allows 53c across 104 rows, while a
     * dropped 32-row page (millions) still fails loudly.
     */
    footingTolerance?: number | { absolute?: number; perRow?: number };
    /**
     * Canonical fields (or full `<sectionId>.<field>` keys) exempt from the footing check.
     *
     * Reports do not only print SUMS in the totals band. A weighted average price, a count, a
     * max maturity — all render in the same place and land in `meta.checksums` the same way.
     * Asserting those as sums fails a perfectly correct report, so they are listed here.
     */
    footingIgnoreFields?: string[];
    /**
     * Absolute tolerance for the per-key checksum comparison. Default 0.01 (one cent, since
     * checksums are typically monetary totals or row counts). Compare passes when
     * `|a[k] - b[k]| ≤ checksumTolerance`.
     */
    checksumTolerance?: number;
    /**
     * When true, `COVERAGE_GAP` findings are recorded but do NOT fail the reconciliation.
     * Default false — a run that compared nothing must not report a pass.
     *
     * Turn this on only when a partial comparison is the intent: mid-migration, where the
     * SSRS side legitimately carries a subset of the Crystal sections and you want the
     * migrated ones checked without the absent ones failing the build. Prefer trimming
     * `requiredSections` to what actually exists — that keeps the gate honest for the
     * sections you DO claim to cover.
     */
    allowCoverageGaps?: boolean;

    /**
     * Cap on rows recorded in the comparison ledger the diff report renders. Defaults to
     * 2000. Rows past the cap are counted and reported as omitted, never dropped silently.
     */
    ledgerMaxRows?: number;
    /**
     * Canonical fields exempt from the "declared but never mapped" coverage check. Use for a
     * column that is genuinely optional in a source — present on some report instances, absent
     * on others — so its absence doesn't read as an extraction failure. Distinct from
     * `ignoreFields`, which excludes a field from COMPARISON entirely; these fields are still
     * compared whenever they are found.
     */
    optionalFields?: string[];
}

/**
 * Loader for report specs. Reads JSON from a directory, validates shape at load time,
 * caches by reportType so repeat lookups are O(1).
 *
 * Kept as a small class rather than free functions so consumers can swap in a mock during
 * tests without touching the filesystem.
 */
export class CSReportSpecLoader {
    private cache = new Map<string, ReportSpec>();
    private loaded = false;

    /**
     * @param specsDir Absolute or workspace-relative path to the directory containing
     *                 `*.json` spec files. One spec per file; filename ignored — the
     *                 loader indexes by `spec.reportType`.
     */
    constructor(private readonly specsDir: string) {}

    /**
     * Load and validate every `*.json` file in `specsDir`. Idempotent — subsequent calls
     * are no-ops. Throws on the FIRST invalid spec found, with a message pointing at the
     * offending file. Fail-fast is deliberate: a broken spec should never silently ship.
     */
    async loadAll(): Promise<void> {
        if (this.loaded) return;
        // Local requires so this module compiles cleanly in browser-side builds
        // (dashboard bundle etc.) — the loader is only ever called server-side.
        const fs: typeof import('fs') = require('fs');
        const path: typeof import('path') = require('path');
        if (!fs.existsSync(this.specsDir)) {
            throw new Error(`CSReportSpecLoader: specsDir does not exist: ${this.specsDir}`);
        }
        const files = fs
            .readdirSync(this.specsDir)
            .filter((f: string) => f.toLowerCase().endsWith('.json'))
            .map((f: string) => path.join(this.specsDir, f));
        for (const file of files) {
            const raw = fs.readFileSync(file, 'utf-8');
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch (err) {
                throw new Error(`CSReportSpecLoader: ${file}: JSON parse error — ${(err as Error).message}`);
            }
            const errors = validateReportSpecShape(parsed);
            if (errors.length > 0) {
                throw new Error(
                    `CSReportSpecLoader: ${file}: invalid spec —\n  ${errors.join('\n  ')}`,
                );
            }
            const spec = parsed as ReportSpec;
            if (this.cache.has(spec.reportType)) {
                throw new Error(
                    `CSReportSpecLoader: duplicate reportType "${spec.reportType}" in ${file}`,
                );
            }
            this.cache.set(spec.reportType, spec);
        }
        this.loaded = true;
    }

    /** Look up a loaded spec by report type. Throws if `loadAll` wasn't called or the type is unknown. */
    get(reportType: string): ReportSpec {
        if (!this.loaded) {
            throw new Error('CSReportSpecLoader: call loadAll() before get()');
        }
        const spec = this.cache.get(reportType);
        if (!spec) {
            throw new Error(
                `CSReportSpecLoader: unknown reportType "${reportType}" — loaded types: ${Array.from(this.cache.keys()).join(', ') || '(none)'}`,
            );
        }
        return spec;
    }

    /** True when a spec for `reportType` is loaded. Useful for feature-gating. */
    has(reportType: string): boolean {
        return this.cache.has(reportType);
    }

    /** All loaded report types. Deterministic order (load order). */
    list(): string[] {
        return Array.from(this.cache.keys());
    }

    /** In-memory injection for tests — bypasses filesystem I/O. */
    register(spec: ReportSpec): void {
        this.cache.set(spec.reportType, spec);
        this.loaded = true;
    }
}

/**
 * Structural validation for a raw `unknown` value against `ReportSpec`. Returns a list of
 * human-readable error messages (empty = valid). Deliberately hand-rolled rather than ajv-
 * based: the checks are cheap, fit in one function, and don't pull an extra runtime dep.
 * ajv is used elsewhere (agent platform); we can swap in later if the spec grows.
 */
export function validateReportSpecShape(obj: unknown): string[] {
    const errors: string[] = [];
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return ['spec must be a JSON object'];
    }
    const s = obj as Record<string, unknown>;

    const requireString = (field: string) => {
        if (typeof s[field] !== 'string' || (s[field] as string).length === 0) {
            errors.push(`${field}: required non-empty string`);
        }
    };
    requireString('reportType');
    requireString('project');

    if (!['excel', 'csv', 'xml', 'pdf'].includes(s.exportFormat as string)) {
        errors.push(`exportFormat: must be one of excel|csv|xml|pdf`);
    }
    if (typeof s.pdfOnly !== 'boolean') {
        errors.push('pdfOnly: required boolean');
    }
    if (!Array.isArray(s.keyColumns) || s.keyColumns.length === 0) {
        errors.push('keyColumns: required non-empty string array');
    } else if ((s.keyColumns as unknown[]).some((k) => typeof k !== 'string' || k.length === 0)) {
        errors.push('keyColumns: entries must be non-empty strings');
    }

    if (typeof s.fieldMap !== 'object' || s.fieldMap === null || Array.isArray(s.fieldMap)) {
        errors.push('fieldMap: required object of {canonical → {crystal?, ssrs?, db?}}');
    } else {
        // Every keyColumn must appear in fieldMap so its per-source names are known.
        if (Array.isArray(s.keyColumns)) {
            for (const k of s.keyColumns as string[]) {
                if (!(k in (s.fieldMap as Record<string, unknown>))) {
                    errors.push(`fieldMap: missing entry for keyColumn "${k}"`);
                }
            }
        }
        // Per-source names: a string, or a non-empty list of strings. An empty list would
        // read as "declared" everywhere downstream while matching no column at all.
        for (const [canonical, entry] of Object.entries(s.fieldMap as Record<string, unknown>)) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                errors.push(`fieldMap.${canonical}: must be an object of {<source>: name | [names]}`);
                continue;
            }
            for (const [source, names] of Object.entries(entry as Record<string, unknown>)) {
                if (names === undefined) continue;
                if (typeof names === 'string') {
                    if (names.length === 0) errors.push(`fieldMap.${canonical}.${source}: must not be empty`);
                    continue;
                }
                if (!Array.isArray(names) || names.length === 0) {
                    errors.push(`fieldMap.${canonical}.${source}: must be a string or a non-empty array of strings`);
                    continue;
                }
                if (names.some((n) => typeof n !== 'string' || n.length === 0)) {
                    errors.push(`fieldMap.${canonical}.${source}: array entries must be non-empty strings`);
                }
            }
        }
    }

    if (Array.isArray(s.requiredSections)) {
        for (const raw of s.requiredSections as Array<Record<string, unknown>>) {
            const summaryFields = raw?.summaryFields;
            if (summaryFields === undefined) continue;
            const where = `requiredSections["${String(raw?.id ?? '?')}"].summaryFields`;
            if (!Array.isArray(summaryFields)) {
                errors.push(`${where}: must be an array of {id, label, valueIndex?}`);
                continue;
            }
            for (const field of summaryFields as Array<Record<string, unknown>>) {
                if (typeof field?.id !== 'string' || field.id.length === 0) {
                    errors.push(`${where}: every entry needs a non-empty "id"`);
                }
                if (typeof field?.label !== 'string' || field.label.length === 0) {
                    errors.push(`${where}: every entry needs a non-empty "label"`);
                }
                if (field?.valueIndex !== undefined &&
                    (typeof field.valueIndex !== 'number' || !Number.isInteger(field.valueIndex) || field.valueIndex < 1)) {
                    errors.push(`${where}: "valueIndex" must be an integer >= 1`);
                }
            }
        }
    }

    if (typeof s.tolerances !== 'object' || s.tolerances === null || Array.isArray(s.tolerances)) {
        errors.push('tolerances: required object (may be empty)');
    }

    if (!Array.isArray(s.dateFormats)) {
        errors.push('dateFormats: required string array (may be empty)');
    }
    if (!Array.isArray(s.ignoreFields)) {
        errors.push('ignoreFields: required string array (may be empty)');
    }
    if (!Array.isArray(s.requiredSections)) {
        errors.push('requiredSections: required array (may be empty)');
    }
    if (!Array.isArray(s.knownDifferences)) {
        errors.push('knownDifferences: required array (may be empty)');
    }

    if (s.database !== undefined) {
        const db = s.database as Record<string, unknown>;
        if (typeof db !== 'object' || db === null) {
            errors.push('database: when present, must be an object');
        } else {
            if (typeof db.connectionAlias !== 'string' || (db.connectionAlias as string).length === 0) {
                errors.push('database.connectionAlias: required non-empty string');
            }
            const hasQuery = db.query !== undefined;
            const hasProcedure = db.procedure !== undefined;
            if (hasQuery && hasProcedure) {
                errors.push('database: supply either "query" or "procedure", not both');
            }
            if (!hasQuery && !hasProcedure) {
                errors.push('database: requires either "query" (string or {sqlserver?, oracle?}) or "procedure"');
            }
            if (hasProcedure) {
                const proc = db.procedure as Record<string, unknown>;
                if (typeof proc !== 'object' || proc === null) {
                    errors.push('database.procedure: when present, must be an object');
                } else {
                    if (typeof proc.name !== 'string' || (proc.name as string).length === 0) {
                        errors.push('database.procedure.name: required non-empty string');
                    }
                    if (proc.params !== undefined) {
                        if (!Array.isArray(proc.params) || proc.params.some((x) => typeof x !== 'string' || x.length === 0)) {
                            errors.push('database.procedure.params: when present, must be an array of non-empty strings');
                        }
                    }
                    if (proc.resultSets !== undefined) {
                        if (!Array.isArray(proc.resultSets) || proc.resultSets.some((x) => typeof x !== 'string')) {
                            errors.push('database.procedure.resultSets: when present, must be an array of strings ("" discards a result set)');
                        } else if ((proc.resultSets as string[]).every((x) => x === '')) {
                            errors.push('database.procedure.resultSets: at least one entry must name a section — all-empty discards every result set');
                        }
                    }
                }
            }
            if (!hasQuery) {
                // Nothing further to validate on the query branch.
            } else if (typeof db.query === 'object' && db.query !== null) {
                const q = db.query as Record<string, unknown>;
                if (
                    (q.sqlserver === undefined && q.oracle === undefined) ||
                    (q.sqlserver !== undefined && typeof q.sqlserver !== 'string') ||
                    (q.oracle !== undefined && typeof q.oracle !== 'string')
                ) {
                    errors.push('database.query: when object, must contain sqlserver and/or oracle strings');
                }
            } else if (typeof db.query !== 'string') {
                errors.push('database.query: must be a string or {sqlserver?, oracle?} object');
            }
        }
    }
    return errors;
}
