/**
 * CS Report Validation — Layer 5b: Canonical extraction dump.
 *
 * The diff reporter answers "what disagreed?". This answers the question that
 * comes immediately before it and has no other answer today: "what did you
 * actually pull out of the PDF?"
 *
 * A clean run produces zero findings, so the diff report — which renders
 * findings — shows a green banner and a record count and nothing else. The
 * coverage gate (`CSReportCoverageValidator`) is what makes that count
 * trustworthy, but a reviewer still cannot SEE the extracted data, and
 * `CSCanonicalCache` holds canonicals in memory only. This module writes them
 * to disk beside the diff report.
 *
 * TWO FORMATS, DELIBERATELY
 * -------------------------
 *   .json — full fidelity. Every `CanonicalValue` keeps its `kind`, its
 *           normalized `value` AND its `raw` source text, plus `meta.coverage`
 *           and `meta.checksums`. This is the engineer's artefact and the one
 *           to attach to a defect.
 *   .csv  — one row per record, opens in Excel. Cells carry the RAW source
 *           text, matching what the diff report displays and what the reader
 *           saw on the page. The normalized value lives in the JSON; showing
 *           it here would mean a business reviewer comparing against the PDF
 *           has to mentally un-normalize every cell.
 *
 * CSV INJECTION
 * -------------
 * Report data is untrusted text. Cells opening with `=`, `+`, `@`, tab or CR
 * are prefixed with an apostrophe so a spreadsheet treats them as text.
 * Leading `-` is deliberately NOT guarded: accounting negatives are pervasive
 * in financial reports and quoting every one of them would corrupt the
 * artefact to defend against a formula that begins with a minus sign.
 *
 * NEVER LOAD-BEARING
 * ------------------
 * Same contract as the diff reporter: this is auxiliary evidence. Callers wrap
 * it so a dump failure can never mask, or manufacture, a reconciliation result.
 *
 * @module report-validation/CSReportCanonicalDumper
 */

import * as fs from 'fs';
import * as path from 'path';

import type { CanonicalReport, CanonicalValue } from './CSReportModel';
import { resolveReportValidationOutputDir } from './CSReportDiffReporter';

/** Result of writing one dump file. */
export interface CanonicalDumpWriteResult {
    filePath: string;
    fileName: string;
    byteCount: number;
    format: 'json' | 'csv';
}

/** Options for a dump. */
export interface CanonicalDumpOptions {
    /** ISO-8601 stamp embedded in the JSON and used for the filename. Defaults to now. */
    generatedAt?: string;
    /** Override the output directory. Defaults to the run's `reports/report-validation/`. */
    outputDir?: string;
    /** Which formats to emit. Defaults to both. */
    formats?: Array<'json' | 'csv'>;
}

/**
 * Env switch. Dumping is ON by default — the artefact is small relative to the PDFs that
 * produced it and its absence is exactly the gap this module exists to close. Set
 * `REPORT_CANONICAL_DUMP` to `false`, `0`, `no` or `off` to suppress it on large suites.
 */
export function canonicalDumpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env['REPORT_CANONICAL_DUMP'] ?? '').trim().toLowerCase();
    if (raw === '') return true;
    return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

export class CSReportCanonicalDumper {
    /**
     * Full-fidelity JSON. Deterministic for a fixed `generatedAt` — same canonical in
     * produces identical bytes out, so two runs are diffable against each other.
     */
    static renderJson(canonical: CanonicalReport, opts: CanonicalDumpOptions = {}): string {
        const fields = fieldOrder(canonical);
        const keys = keyOrder(canonical);
        return JSON.stringify(
            {
                generatedAt: opts.generatedAt ?? new Date().toISOString(),
                reportType: canonical.reportType,
                entity: canonical.entity,
                source: canonical.source,
                format: canonical.format,
                params: canonical.params ?? {},
                keyColumns: keys,
                fieldColumns: fields,
                meta: {
                    rowCount: canonical.meta?.rowCount ?? canonical.records.length,
                    ...(canonical.meta?.checksums ? { checksums: canonical.meta.checksums } : {}),
                    ...(canonical.meta?.coverage ? { coverage: canonical.meta.coverage } : {}),
                },
                totals: canonical.totals ?? {},
                sections: canonical.sections ?? [],
                records: canonical.records.map((r, i) => ({
                    row: i + 1,
                    section: r.sectionId,
                    key: r.key ?? {},
                    fields: r.fields ?? {},
                })),
            },
            null,
            2,
        );
    }

    /**
     * Flat CSV, one row per canonical record. Columns are
     * `row, section, key:<k>…, <field>…` — key columns first so the business key the
     * reconciler matched on is visible before the data it carried.
     */
    static renderCsv(canonical: CanonicalReport): string {
        const keys = keyOrder(canonical);
        const fields = fieldOrder(canonical);

        const header = ['row', 'section', ...keys.map((k) => `key:${k}`), ...fields];
        const lines: string[] = [header.map(csvCell).join(',')];

        for (let i = 0; i < canonical.records.length; i++) {
            const r = canonical.records[i];
            const row: string[] = [
                String(i + 1),
                r.sectionId ?? '',
                ...keys.map((k) => (r.key ?? {})[k] ?? ''),
                ...fields.map((f) => rawOf((r.fields ?? {})[f])),
            ];
            lines.push(row.map(csvCell).join(','));
        }

        // Trailing newline — POSIX text convention, and Excel is happier with it.
        return lines.join('\r\n') + '\r\n';
    }

    /** Render one format and write it to an explicit path, creating parent directories. */
    static writeToFile(
        canonical: CanonicalReport,
        outputPath: string,
        format: 'json' | 'csv',
        opts: CanonicalDumpOptions = {},
    ): CanonicalDumpWriteResult {
        const body =
            format === 'json'
                ? CSReportCanonicalDumper.renderJson(canonical, opts)
                : CSReportCanonicalDumper.renderCsv(canonical);
        const abs = path.resolve(outputPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body, 'utf-8');
        return {
            filePath: abs,
            fileName: path.basename(abs),
            byteCount: Buffer.byteLength(body, 'utf-8'),
            format,
        };
    }

    /**
     * Write every requested format into the run's `reports/report-validation/` directory,
     * alongside the diff report so one folder holds the whole evidence set.
     *
     * Filenames are `canonical-<source>-<entity>-<timestamp>.<ext>`.
     */
    static writeToRunReports(
        canonical: CanonicalReport,
        opts: CanonicalDumpOptions = {},
    ): CanonicalDumpWriteResult[] {
        const dir = opts.outputDir ?? resolveReportValidationOutputDir();
        const generatedAt = opts.generatedAt ?? new Date().toISOString();
        const stamp = timestampSlug(generatedAt);
        const base = `canonical-${slug(canonical.source)}-${slug(canonical.entity)}-${stamp}`;
        const formats = opts.formats ?? ['json', 'csv'];

        return formats.map((f) =>
            CSReportCanonicalDumper.writeToFile(canonical, path.join(dir, `${base}.${f}`), f, {
                ...opts,
                generatedAt,
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Field column order. Taken from encounter order across records rather than sorted
 * alphabetically — a report's own column order is information, and preserving it keeps the
 * CSV readable next to the source PDF. Deterministic for a given canonical either way.
 */
function fieldOrder(canonical: CanonicalReport): string[] {
    const seen: string[] = [];
    const inSeen = new Set<string>();
    for (const r of canonical.records) {
        for (const name of Object.keys(r.fields ?? {})) {
            if (!inSeen.has(name)) {
                inSeen.add(name);
                seen.push(name);
            }
        }
    }
    return seen;
}

/** Key column order, by the same encounter rule. */
function keyOrder(canonical: CanonicalReport): string[] {
    const seen: string[] = [];
    const inSeen = new Set<string>();
    for (const r of canonical.records) {
        for (const name of Object.keys(r.key ?? {})) {
            if (!inSeen.has(name)) {
                inSeen.add(name);
                seen.push(name);
            }
        }
    }
    return seen;
}

/** The raw source text of a canonical value — what the report actually printed. */
function rawOf(v: CanonicalValue | undefined): string {
    if (v === undefined) return '';
    return v.raw ?? '';
}

/** Cells that a spreadsheet would evaluate as a formula. Leading `-` is intentionally absent. */
const CSV_INJECTION_PREFIX = /^[=+@\t\r]/;

function csvCell(value: string): string {
    let s = value ?? '';
    if (CSV_INJECTION_PREFIX.test(s)) s = `'${s}`;
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function slug(s: string): string {
    return (s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function timestampSlug(iso: string): string {
    return iso.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}
