import type { AnalyzedSection, TableRow } from './CSReportPdfTypes';
import { CSReporter } from '../reporter/CSReporter';

export interface SectionValidatorOptions {
    debug?: boolean;
}

export function validateAndRepairSections(
    sections: AnalyzedSection[],
    opts: SectionValidatorOptions = {},
): AnalyzedSection[] {
    if (!Array.isArray(sections) || sections.length === 0) return sections;
    const debug = opts.debug === true || process.env.CS_LAYOUT_DEBUG === '1';
    const repaired: AnalyzedSection[] = [];
    const byTitle = groupSectionsByTitle(sections);

    for (const sec of sections) {
        const nonEmptyKey = normaliseTitleKey(sec.title);
        const family = byTitle.get(nonEmptyKey) ?? [sec];
        if (isColumnCountOutlier(sec, family)) {
            if (debug) CSReporter.warn(`[SectionValidator] "${sec.title}" fragment ${sec.columns.length}-col discarded as outlier vs family mode ${modeColCount(family)}`);
            continue;
        }
        repaired.push(sec);
    }

    for (const sec of repaired) {
        splitGluedRows(sec, debug);
        dropStitchDensityAnomalies(sec, debug);
    }
    return repaired;
}

function groupSectionsByTitle(sections: AnalyzedSection[]): Map<string, AnalyzedSection[]> {
    const m = new Map<string, AnalyzedSection[]>();
    for (const sec of sections) {
        const k = normaliseTitleKey(sec.title);
        const arr = m.get(k) ?? [];
        arr.push(sec);
        m.set(k, arr);
    }
    return m;
}

function normaliseTitleKey(t: string): string {
    return (t ?? '').toLowerCase().trim();
}

function modeColCount(family: AnalyzedSection[]): number {
    if (family.length === 0) return 0;
    const counts = new Map<number, number>();
    for (const s of family) {
        const n = (s.columns ?? []).length;
        counts.set(n, (counts.get(n) ?? 0) + (s.tableRows?.length ?? 1));
    }
    let bestN = 0;
    let bestVotes = -1;
    for (const [n, v] of counts.entries()) {
        if (v > bestVotes) { bestVotes = v; bestN = n; }
    }
    return bestN;
}

function isColumnCountOutlier(sec: AnalyzedSection, family: AnalyzedSection[]): boolean {
    if (family.length < 2) return false;
    const mode = modeColCount(family);
    if (mode <= 0) return false;
    const my = (sec.columns ?? []).length;
    if (my <= 0) return false;
    if (my > mode * 2 && (sec.tableRows?.length ?? 0) < 3) return true;
    return false;
}

function splitGluedRows(sec: AnalyzedSection, debug: boolean): void {
    const rows = sec.tableRows ?? [];
    if (rows.length < 3) return;
    const cols = sec.columns ?? [];
    if (cols.length === 0) return;

    const descIdx = pickDescriptionColumnIndex(cols, rows);
    if (descIdx < 0) return;

    const lengths: number[] = [];
    for (const r of rows) {
        const v = r.cells?.[descIdx];
        if (v && v.trim().length > 0) lengths.push(v.trim().length);
    }
    if (lengths.length < 3) return;
    const median = medianOf(lengths);
    if (median <= 0) return;
    const threshold = median * 2;

    const out: TableRow[] = [];
    let idx = 0;
    for (const r of rows) {
        const v = r.cells?.[descIdx];
        const raw = v ? v.trim() : '';
        if (raw.length > threshold) {
            const split = trySplitByProperNounBoundary(raw);
            if (split) {
                const [firstDesc, secondDesc] = split;
                const filledCount = countFilledCells(r);
                const half = Math.max(1, Math.floor((r.cells?.length ?? 0) / 2));
                if (filledCount <= half + 1) {
                    if (debug) CSReporter.warn(`[SectionValidator] "${sec.title}" row split — "${firstDesc.slice(0, 30)}..." + "${secondDesc.slice(0, 30)}..."`);
                    const firstCells = [...(r.cells ?? [])];
                    firstCells[descIdx] = firstDesc;
                    const secondCells = new Array(firstCells.length).fill(null);
                    secondCells[descIdx] = secondDesc;
                    out.push({ ...r, cells: firstCells, rowIndex: idx++ });
                    out.push({ ...r, cells: secondCells, rowIndex: idx++ });
                    continue;
                }
            }
        }
        out.push({ ...r, rowIndex: idx++ });
    }
    if (out.length !== rows.length) sec.tableRows = out;
}

function pickDescriptionColumnIndex(cols: import('./CSReportPdfTypes').ColumnBand[], rows: TableRow[]): number {
    let bestIdx = -1;
    let bestAvg = -1;
    for (let c = 0; c < cols.length; c++) {
        let total = 0;
        let count = 0;
        let numeric = 0;
        for (const r of rows) {
            const v = r.cells?.[c];
            if (!v) continue;
            const s = v.trim();
            if (s.length === 0) continue;
            total += s.length;
            count++;
            if (/^[\d.,%$/()-]+$/.test(s)) numeric++;
        }
        if (count === 0) continue;
        if (numeric / count > 0.5) continue;
        const avg = total / count;
        if (avg > bestAvg) { bestAvg = avg; bestIdx = c; }
    }
    return bestIdx;
}

function trySplitByProperNounBoundary(desc: string): [string, string] | null {
    const words = desc.split(/\s+/).filter(Boolean);
    if (words.length < 4) return null;
    const uppercaseRuns: Array<{ start: number; end: number }> = [];
    let runStart = -1;
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const isUpperish = /^[A-Z][A-Z0-9&/.'-]{1,}$/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w);
        if (isUpperish) {
            if (runStart < 0) runStart = i;
        } else {
            if (runStart >= 0) uppercaseRuns.push({ start: runStart, end: i - 1 });
            runStart = -1;
        }
    }
    if (runStart >= 0) uppercaseRuns.push({ start: runStart, end: words.length - 1 });
    if (uppercaseRuns.length < 2) return null;

    const secondRunStart = uppercaseRuns[1].start;
    if (secondRunStart < 2) return null;
    const first = words.slice(0, secondRunStart).join(' ').trim();
    const second = words.slice(secondRunStart).join(' ').trim();
    if (first.length === 0 || second.length === 0) return null;
    if (first.length > desc.length * 0.9 || second.length > desc.length * 0.9) return null;
    return [first, second];
}

function countFilledCells(r: TableRow): number {
    let n = 0;
    for (const c of r.cells ?? []) if (c && c.trim().length > 0) n++;
    return n;
}

function medianOf(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function dropStitchDensityAnomalies(sec: AnalyzedSection, debug: boolean): void {
    const rows = sec.tableRows ?? [];
    if (rows.length < 3) return;
    const cols = sec.columns ?? [];
    const expected = cols.length;
    if (expected === 0) return;

    const densities = rows.map((r) => countFilledCells(r) / expected);
    const toDrop = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
        if (densities[i] < 0.15) {
            const prev = i > 0 ? densities[i - 1] : 0;
            const next = i < rows.length - 1 ? densities[i + 1] : 0;
            if (prev >= 0.6 && next >= 0.6) {
                toDrop.add(i);
            }
        }
    }
    if (toDrop.size === 0) return;
    if (debug) CSReporter.warn(`[SectionValidator] "${sec.title}" dropped ${toDrop.size} stitch-density anomaly row(s)`);
    const out: TableRow[] = [];
    let idx = 0;
    for (let i = 0; i < rows.length; i++) {
        if (toDrop.has(i)) continue;
        out.push({ ...rows[i], rowIndex: idx++ });
    }
    sec.tableRows = out;
}
