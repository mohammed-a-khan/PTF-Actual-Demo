/**
 * Agentic Test Platform — Legacy Data Reader (Rebuild M5)
 *
 * Reads test-data files referenced by legacy tests into typed `Row[]`:
 *   - `.xls` / `.xlsx` via the framework's bundled `xlsx` peer dep
 *   - `.csv` / `.tsv` via `csv-parse/sync`
 *   - `.json` via JSON.parse
 *   - `.properties` via line-by-line key=value
 *   - `.xml` via lightweight DOM walk for QAF/TestNG dataprovider patterns
 *
 * The reader is **detection-tolerant**: a missing optional peer dep
 * (`xlsx`) returns `{kind: 'unsupported', reason: ...}` rather than
 * throwing. Generated `<feature>-data.json` artefacts always come back
 * with `kind: 'rows'`.
 *
 * @module agent-platform/CSLegacyDataReader
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Public Types
// ============================================================================

export type LegacyDataResult =
    | {
          kind: 'rows';
          format: 'xlsx' | 'csv' | 'tsv' | 'json' | 'properties' | 'xml';
          path: string;
          sheet?: string;
          columns: string[];
          rows: Array<Record<string, string>>;
          rowCount: number;
          truncated: boolean;
      }
    | {
          kind: 'unsupported';
          format: string;
          path: string;
          reason: string;
      };

// ============================================================================
// CSLegacyDataReader
// ============================================================================

export class CSLegacyDataReader {
    /** Cap row count returned to keep analysis report compact. */
    private static readonly DEFAULT_ROW_CAP = 100;

    /**
     * Read a data file into typed rows. `sheet` only applies to .xlsx;
     * defaults to the first sheet. `key` only applies when the file has
     * scenario keys (XLS sheet col `scenarioId` / `key`).
     */
    public static read(
        filePath: string,
        opts?: { sheet?: string; rowCap?: number },
    ): LegacyDataResult {
        if (!fs.existsSync(filePath)) {
            return {
                kind: 'unsupported',
                format: path.extname(filePath).slice(1) || 'unknown',
                path: filePath,
                reason: 'file does not exist on disk',
            };
        }
        const ext = path.extname(filePath).toLowerCase();
        const cap = opts?.rowCap ?? CSLegacyDataReader.DEFAULT_ROW_CAP;
        switch (ext) {
            case '.xls':
            case '.xlsx':
                return CSLegacyDataReader.readXlsx(filePath, opts?.sheet, cap);
            case '.csv':
                return CSLegacyDataReader.readDelimited(filePath, ',', 'csv', cap);
            case '.tsv':
                return CSLegacyDataReader.readDelimited(filePath, '\t', 'tsv', cap);
            case '.json':
                return CSLegacyDataReader.readJson(filePath, cap);
            case '.properties':
                return CSLegacyDataReader.readProperties(filePath);
            case '.xml':
                return CSLegacyDataReader.readXmlData(filePath, cap);
            default:
                return {
                    kind: 'unsupported',
                    format: ext.slice(1) || 'unknown',
                    path: filePath,
                    reason: `extension ${ext} is not a recognised data format`,
                };
        }
    }

    // ------------------------------------------------------------------
    // Format readers
    // ------------------------------------------------------------------

    private static readXlsx(
        filePath: string,
        sheet: string | undefined,
        rowCap: number,
    ): LegacyDataResult {
        let xlsx: typeof import('xlsx') | undefined;
        try {
            // Optional peer dep — graceful degradation when missing.
            const moduleName = 'xlsx';
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            xlsx = require(moduleName) as typeof import('xlsx');
        } catch {
            return {
                kind: 'unsupported',
                format: 'xlsx',
                path: filePath,
                reason: 'xlsx peer dependency not installed; run `npm install xlsx`',
            };
        }
        try {
            const wb = xlsx.readFile(filePath);
            const sheetName = sheet ?? wb.SheetNames[0];
            if (!wb.SheetNames.includes(sheetName)) {
                return {
                    kind: 'unsupported',
                    format: 'xlsx',
                    path: filePath,
                    reason: `sheet '${sheetName}' not found; available: ${wb.SheetNames.join(', ')}`,
                };
            }
            const ws = wb.Sheets[sheetName];
            const json = xlsx.utils.sheet_to_json<Record<string, unknown>>(ws, {
                defval: '',
                raw: false,
            });
            const truncated = json.length > rowCap;
            const slice = json.slice(0, rowCap);
            const columns = slice[0] ? Object.keys(slice[0]) : [];
            const rows = slice.map((r) => {
                const out: Record<string, string> = {};
                for (const c of columns) {
                    const v = r[c];
                    out[c] = v == null ? '' : String(v);
                }
                return out;
            });
            return {
                kind: 'rows',
                format: 'xlsx',
                path: filePath,
                sheet: sheetName,
                columns,
                rows,
                rowCount: json.length,
                truncated,
            };
        } catch (err) {
            return {
                kind: 'unsupported',
                format: 'xlsx',
                path: filePath,
                reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    private static readDelimited(
        filePath: string,
        delim: string,
        format: 'csv' | 'tsv',
        rowCap: number,
    ): LegacyDataResult {
        try {
            const content = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, '');
            const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
            if (lines.length === 0) {
                return {
                    kind: 'rows', format, path: filePath,
                    columns: [], rows: [], rowCount: 0, truncated: false,
                };
            }
            const columns = CSLegacyDataReader.parseDelimitedLine(lines[0], delim);
            const truncated = lines.length - 1 > rowCap;
            const rows: Array<Record<string, string>> = [];
            for (let i = 1; i < Math.min(lines.length, rowCap + 1); i++) {
                const cells = CSLegacyDataReader.parseDelimitedLine(lines[i], delim);
                const row: Record<string, string> = {};
                columns.forEach((c, idx) => { row[c] = cells[idx] ?? ''; });
                rows.push(row);
            }
            return {
                kind: 'rows', format, path: filePath,
                columns, rows, rowCount: lines.length - 1, truncated,
            };
        } catch (err) {
            return {
                kind: 'unsupported', format, path: filePath,
                reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    private static parseDelimitedLine(line: string, delim: string): string[] {
        // Minimal RFC-4180-aware parse: handle quoted fields with embedded commas.
        const out: string[] = [];
        let cur = '';
        let inQ = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQ) {
                if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
                else if (ch === '"') { inQ = false; }
                else { cur += ch; }
            } else {
                if (ch === '"') inQ = true;
                else if (ch === delim) { out.push(cur); cur = ''; }
                else { cur += ch; }
            }
        }
        out.push(cur);
        return out.map((c) => c.trim());
    }

    private static readJson(filePath: string, rowCap: number): LegacyDataResult {
        try {
            const text = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                const truncated = parsed.length > rowCap;
                const slice = parsed.slice(0, rowCap);
                const columns = Array.from(
                    new Set(slice.flatMap((r: Record<string, unknown>) => Object.keys(r ?? {}))),
                );
                const rows = slice.map((r: Record<string, unknown>) => {
                    const out: Record<string, string> = {};
                    for (const c of columns) {
                        const v = (r as Record<string, unknown>)[c];
                        out[c] = v == null ? '' : String(v);
                    }
                    return out;
                });
                return {
                    kind: 'rows', format: 'json', path: filePath,
                    columns, rows, rowCount: parsed.length, truncated,
                };
            }
            // Single object → single row
            const obj = parsed as Record<string, unknown>;
            const columns = Object.keys(obj);
            const row: Record<string, string> = {};
            for (const c of columns) {
                const v = obj[c];
                row[c] = v == null ? '' : String(v);
            }
            return {
                kind: 'rows', format: 'json', path: filePath,
                columns, rows: [row], rowCount: 1, truncated: false,
            };
        } catch (err) {
            return {
                kind: 'unsupported', format: 'json', path: filePath,
                reason: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    private static readProperties(filePath: string): LegacyDataResult {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const row: Record<string, string> = {};
            for (const rawLine of content.split(/\r?\n/)) {
                const line = rawLine.replace(/^\s+/, '');
                if (!line || line.startsWith('#') || line.startsWith('!')) continue;
                const eq = line.indexOf('=');
                const co = line.indexOf(':');
                let split = -1;
                if (eq >= 0 && co >= 0) split = Math.min(eq, co);
                else split = Math.max(eq, co);
                if (split < 0) continue;
                const k = line.slice(0, split).trim();
                const v = line.slice(split + 1).trim();
                if (k) row[k] = v;
            }
            const columns = Object.keys(row);
            return {
                kind: 'rows', format: 'properties', path: filePath,
                columns, rows: [row], rowCount: 1, truncated: false,
            };
        } catch (err) {
            return {
                kind: 'unsupported', format: 'properties', path: filePath,
                reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    private static readXmlData(filePath: string, rowCap: number): LegacyDataResult {
        try {
            const text = fs.readFileSync(filePath, 'utf-8');
            // QAF data provider rows look like: <row><col1>v1</col1><col2>v2</col2></row>
            const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
            const rows: Array<Record<string, string>> = [];
            const colSet = new Set<string>();
            let m: RegExpExecArray | null;
            let total = 0;
            while ((m = rowRe.exec(text)) !== null) {
                total++;
                if (rows.length >= rowCap) continue;
                const inner = m[1];
                const cells: Record<string, string> = {};
                const cellRe = /<(\w+)\b[^>]*>([\s\S]*?)<\/\1>/g;
                let cm: RegExpExecArray | null;
                while ((cm = cellRe.exec(inner)) !== null) {
                    const k = cm[1];
                    const v = cm[2].replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').trim();
                    cells[k] = v;
                    colSet.add(k);
                }
                rows.push(cells);
            }
            const columns = Array.from(colSet);
            return {
                kind: 'rows', format: 'xml', path: filePath,
                columns, rows, rowCount: total, truncated: total > rows.length,
            };
        } catch (err) {
            return {
                kind: 'unsupported', format: 'xml', path: filePath,
                reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
}
