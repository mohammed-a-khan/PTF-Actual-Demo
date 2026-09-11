/**
 * CLI adapter for `cs-playwright-mcp report-spec init` — parses argv, invokes
 * the generator, writes the output file, prints a summary + notes.
 *
 * Kept separate from the generator itself so the pure function stays testable
 * without touching stdio.
 *
 * @module report-validation/CSReportSimpleSpecGeneratorCli
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateSimpleReportSpec } from './CSReportSimpleSpecGenerator';

export interface ReportSpecInitOptions {
    pdfPath: string;
    outPath: string;
    specName?: string;
    force: boolean;
    dryRun: boolean;
    includeTemplateMarkers: boolean;
    includeLabeledFields: boolean;
    includeTables: boolean;
    maxTemplateMarkers?: number;
    minRowsForTable?: number;
}

export interface ReportSpecInitResult {
    written: boolean;
    outPath: string;
    fieldsEmitted: number;
    tablesEmitted: number;
    presenceMarkersEmitted: number;
    dryRun: boolean;
    notes: string[];
    skippedReason?: string;
}

/**
 * Parse argv (already sliced past the "report-spec init" verb) into
 * ReportSpecInitOptions. Throws on bad input.
 */
export function parseReportSpecInitArgs(argv: string[]): ReportSpecInitOptions {
    const opts: ReportSpecInitOptions = {
        pdfPath: '',
        outPath: '',
        force: false,
        dryRun: false,
        includeTemplateMarkers: true,
        includeLabeledFields: true,
        includeTables: true,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--force') opts.force = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--no-template-markers') opts.includeTemplateMarkers = false;
        else if (a === '--no-labeled-fields') opts.includeLabeledFields = false;
        else if (a === '--no-tables') opts.includeTables = false;
        else if (a.startsWith('--pdf=')) opts.pdfPath = path.resolve(a.slice('--pdf='.length));
        else if (a === '--pdf') opts.pdfPath = path.resolve(argv[++i] || '');
        else if (a.startsWith('--out=')) opts.outPath = path.resolve(a.slice('--out='.length));
        else if (a === '--out') opts.outPath = path.resolve(argv[++i] || '');
        else if (a.startsWith('--name=')) opts.specName = a.slice('--name='.length);
        else if (a === '--name') opts.specName = argv[++i];
        else if (a.startsWith('--max-template-markers=')) opts.maxTemplateMarkers = parseInt(a.slice('--max-template-markers='.length), 10);
        else if (a.startsWith('--min-rows-for-table=')) opts.minRowsForTable = parseInt(a.slice('--min-rows-for-table='.length), 10);
        else if (a === '--help' || a === '-h') {
            printHelpAndExit();
        } else {
            throw new Error(`unrecognized report-spec init arg: ${a}`);
        }
    }
    if (!opts.pdfPath) throw new Error('--pdf=<path> is required');
    if (!fs.existsSync(opts.pdfPath)) throw new Error(`--pdf path not found: ${opts.pdfPath}`);
    if (!opts.outPath) throw new Error('--out=<path> is required');
    return opts;
}

/**
 * Run the generator and (unless --dry-run) write to disk. Never overwrites
 * an existing file without --force.
 */
export async function runReportSpecInit(opts: ReportSpecInitOptions): Promise<ReportSpecInitResult> {
    if (!opts.dryRun && fs.existsSync(opts.outPath) && !opts.force) {
        return {
            written: false,
            outPath: opts.outPath,
            fieldsEmitted: 0,
            tablesEmitted: 0,
            presenceMarkersEmitted: 0,
            dryRun: false,
            notes: [],
            skippedReason: `${opts.outPath} exists — pass --force to overwrite`,
        };
    }
    const result = await generateSimpleReportSpec({
        pdfPath: opts.pdfPath,
        specName: opts.specName,
        includeTemplateMarkers: opts.includeTemplateMarkers,
        includeLabeledFields: opts.includeLabeledFields,
        includeTables: opts.includeTables,
        maxTemplateMarkers: opts.maxTemplateMarkers,
        minRowsForTable: opts.minRowsForTable,
    });
    if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
        fs.writeFileSync(opts.outPath, result.json, 'utf-8');
    }
    return {
        written: !opts.dryRun,
        outPath: opts.outPath,
        fieldsEmitted: result.summary.fieldsEmitted,
        tablesEmitted: result.summary.tablesEmitted,
        presenceMarkersEmitted: result.summary.presenceMarkersEmitted,
        dryRun: opts.dryRun,
        notes: result.notes,
    };
}

function printHelpAndExit(): never {
    process.stdout.write(`
cs-playwright-mcp report-spec init — generate a starter SimpleReportSpec from a sample PDF.

Usage:
  npx cs-playwright-mcp report-spec init --pdf=<path> --out=<path> [options]

Required:
  --pdf=<path>                Sample PDF to analyze.
  --out=<path>                Destination JSON file (created; parent dirs auto-created).

Options:
  --name=<slug>               Spec name written into JSON. Default: kebab-case of PDF filename.
  --force                     Overwrite if <out> already exists.
  --dry-run                   Print what would be generated; do NOT write the file.
  --no-template-markers       Skip presenceOfText emission for fixed template text.
  --no-labeled-fields         Skip labeled scalar-field emission.
  --no-tables                 Skip table extraction.
  --max-template-markers=<n>  Cap on presenceOfText markers (default 30).
  --min-rows-for-table=<n>    Minimum rows for a section to become a table (default 2).
  --help, -h                  This message.

Output:
  A valid SimpleReportSpec JSON at <out>. Every extractable label/table/marker in the
  sample PDF becomes a starter spec entry. Consumer REVIEWS and trims — no blank-page
  authoring. The generated spec loads directly via loadSimpleReportSpec().

Example:
  npx cs-playwright-mcp report-spec init \\
    --pdf=samples/invoice.pdf \\
    --out=config/report-specs/pegas/invoice-standard.json
`);
    process.exit(0);
}
