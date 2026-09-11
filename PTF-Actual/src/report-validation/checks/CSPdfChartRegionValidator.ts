/**
 * PDF chart-region validator (Phase 4 / §11 charts).
 *
 * Chart *content* is intentionally out of scope — parsing bar heights,
 * scatter points etc. would require an OCR/vision pipeline we've deferred
 * (see DEFERRED-CAPABILITIES §D-12). What we DO validate is the *presence
 * and shape* of chart regions, which is already detected by
 * `CSChartRegionDetector`:
 *
 *   - Expected number of chart regions (per page and total)
 *   - Every chart region's bounding-box area is above a minimum threshold
 *     (defends against detector false-positives from small vector art)
 *   - No chart region overlaps a text-item bbox (charts must not be printed
 *     over text — a real print-production defect we saw during the pilot)
 *
 * @module report-validation/checks/CSPdfChartRegionValidator
 */

import type { AnalyzedReport, PageContent } from '../CSReportPdfTypes';

export interface ChartRegionRule {
    /** Assert total chart-region count. */
    chartCount?: number;
    /** Assert per-page chart count { 1: 1, 2: 0, … }. */
    chartCountByPage?: Record<number, number>;
    /** Minimum bounding-box area (in pdfjs units²) to accept as a real chart. */
    minChartArea?: number;
    /** Reject a chart whose bbox overlaps ≥ this fraction of any single text-item bbox. */
    maxTextOverlapFraction?: number;
}

export interface ChartRegionFinding {
    kind:
        | 'CHART_COUNT_DRIFT'
        | 'CHART_PAGE_COUNT_DRIFT'
        | 'CHART_AREA_TOO_SMALL'
        | 'CHART_OVERLAPS_TEXT';
    message: string;
    page?: number;
    expected?: string;
    actual?: string;
}

export function validateChartRegions(
    analyzed: AnalyzedReport,
    rule: ChartRegionRule,
    rawPages: PageContent[] = [],
): ChartRegionFinding[] {
    const findings: ChartRegionFinding[] = [];
    // Charts live on individual sections — flatten them per page.
    const allCharts = analyzed.pages.flatMap((p) =>
        p.sections.flatMap((s) => s.charts.map((c) => ({ ...c, page: p.pageNumber }))),
    );

    if (rule.chartCount !== undefined && allCharts.length !== rule.chartCount) {
        findings.push({
            kind: 'CHART_COUNT_DRIFT',
            message: `Expected ${rule.chartCount} chart regions, found ${allCharts.length}`,
            expected: String(rule.chartCount),
            actual: String(allCharts.length),
        });
    }
    if (rule.chartCountByPage) {
        const byPage: Record<number, number> = {};
        for (const c of allCharts) byPage[c.page] = (byPage[c.page] ?? 0) + 1;
        for (const [pStr, expected] of Object.entries(rule.chartCountByPage)) {
            const p = parseInt(pStr, 10);
            const actual = byPage[p] ?? 0;
            if (actual !== expected) {
                findings.push({
                    kind: 'CHART_PAGE_COUNT_DRIFT',
                    message: `Page ${p} expected ${expected} chart(s), found ${actual}`,
                    page: p,
                    expected: String(expected),
                    actual: String(actual),
                });
            }
        }
    }
    if (rule.minChartArea !== undefined) {
        for (const c of allCharts) {
            const area = (Math.max(0, c.box.x2 - c.box.x1) ?? 0) * (Math.max(0, c.box.y2 - c.box.y1) ?? 0);
            if (area < rule.minChartArea) {
                findings.push({
                    kind: 'CHART_AREA_TOO_SMALL',
                    message: `Chart region on page ${c.page} area ${area.toFixed(0)} < min ${rule.minChartArea}`,
                    page: c.page,
                    expected: `≥ ${rule.minChartArea}`,
                    actual: area.toFixed(0),
                });
            }
        }
    }
    if (rule.maxTextOverlapFraction !== undefined) {
        for (const page of analyzed.pages) {
            const rawPage = rawPages.find((rp) => rp.pageNumber === page.pageNumber);
            const chartsOnPage = page.sections.flatMap((s) => s.charts);
            for (const c of chartsOnPage) {
                for (const t of rawPage?.textItems ?? []) {
                    const tw = t.width ?? 0;
                    const th = t.height ?? 0;
                    if (!tw || !th) continue;
                    const overlap = rectOverlapArea(c.box, { x: t.x, y: t.y, width: tw, height: th });
                    const textArea = tw * th;
                    if (textArea > 0 && overlap / textArea >= rule.maxTextOverlapFraction) {
                        findings.push({
                            kind: 'CHART_OVERLAPS_TEXT',
                            message: `Chart region on page ${page.pageNumber} overlaps text "${t.str.slice(0, 30)}" by ${((overlap / textArea) * 100).toFixed(0)}%`,
                            page: page.pageNumber,
                            expected: `< ${(rule.maxTextOverlapFraction * 100).toFixed(0)}%`,
                            actual: `${((overlap / textArea) * 100).toFixed(0)}%`,
                        });
                        break;
                    }
                }
            }
        }
    }
    return findings;
}

function rectOverlapArea(
    a: { x1: number; y1: number; x2: number; y2: number },
    b: { x: number; y: number; width: number; height: number },
): number {
    const bx2 = b.x + b.width;
    const by2 = b.y + b.height;
    const x1 = Math.max(a.x1, b.x);
    const y1 = Math.max(a.y1, b.y);
    const x2 = Math.min(a.x2, bx2);
    const y2 = Math.min(a.y2, by2);
    if (x2 <= x1 || y2 <= y1) return 0;
    return (x2 - x1) * (y2 - y1);
}
