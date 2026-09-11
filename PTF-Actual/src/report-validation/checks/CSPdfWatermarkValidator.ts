/**
 * PDF watermark validator (§15).
 *
 * Consumer declares one or more expected watermark strings and whether each
 * should appear on EVERY page (`presentOnAllPages`), on ANY page
 * (`presentOnAnyPage`), or NEVER (`absentFromAllPages`). Common patterns:
 *
 *   - Draft builds must include "DRAFT" on every page
 *   - Production builds must NOT include "DRAFT" on any page
 *   - "CONFIDENTIAL" watermark required on every page of the report
 *
 * @module report-validation/checks/CSPdfWatermarkValidator
 */

import type { AnalyzedReport } from '../CSReportPdfTypes';

export interface WatermarkRule {
    text: string;
    mode: 'presentOnAllPages' | 'presentOnAnyPage' | 'absentFromAllPages';
    /** Case-sensitive match. Default: false (case-insensitive). */
    caseSensitive?: boolean;
}

export interface WatermarkFinding {
    kind: 'WATERMARK_MISSING' | 'WATERMARK_UNEXPECTED';
    message: string;
    text: string;
    mode: WatermarkRule['mode'];
    /** For `presentOnAllPages` — list of pages where the watermark was missing. */
    missingOnPages?: number[];
    /** For `absentFromAllPages` — list of pages where the watermark was found. */
    foundOnPages?: number[];
}

export function validateWatermarks(analyzed: AnalyzedReport, rules: WatermarkRule[]): WatermarkFinding[] {
    const findings: WatermarkFinding[] = [];
    for (const rule of rules) {
        const needle = rule.caseSensitive ? rule.text : rule.text.toLowerCase();
        const foundOnPages: number[] = [];
        const missingOnPages: number[] = [];
        for (const page of analyzed.pages) {
            const pageText = collectPageText(page, rule.caseSensitive);
            if (pageText.includes(needle)) foundOnPages.push(page.pageNumber);
            else missingOnPages.push(page.pageNumber);
        }
        if (rule.mode === 'presentOnAllPages' && missingOnPages.length > 0) {
            findings.push({
                kind: 'WATERMARK_MISSING',
                message: `Watermark "${rule.text}" missing on ${missingOnPages.length} page(s): ${missingOnPages.join(', ')}`,
                text: rule.text,
                mode: rule.mode,
                missingOnPages,
            });
        } else if (rule.mode === 'presentOnAnyPage' && foundOnPages.length === 0) {
            findings.push({
                kind: 'WATERMARK_MISSING',
                message: `Watermark "${rule.text}" not found on any page`,
                text: rule.text,
                mode: rule.mode,
                missingOnPages: analyzed.pages.map((p) => p.pageNumber),
            });
        } else if (rule.mode === 'absentFromAllPages' && foundOnPages.length > 0) {
            findings.push({
                kind: 'WATERMARK_UNEXPECTED',
                message: `Watermark "${rule.text}" MUST be absent but appeared on ${foundOnPages.length} page(s): ${foundOnPages.join(', ')}`,
                text: rule.text,
                mode: rule.mode,
                foundOnPages,
            });
        }
    }
    return findings;
}

function collectPageText(
    page: AnalyzedReport['pages'][number],
    caseSensitive?: boolean,
): string {
    const parts: string[] = [];
    parts.push(...page.header);
    parts.push(...page.footer);
    for (const s of page.sections) {
        if (s.title) parts.push(s.title);
        parts.push(...s.freeText);
        parts.push(...(s.preambleText ?? []));
        for (const r of s.tableRows) {
            for (const cell of r.cells) {
                if (cell !== null) parts.push(cell);
            }
        }
    }
    parts.push(...(page.residualText ?? []));
    const combined = parts.join(' ');
    return caseSensitive ? combined : combined.toLowerCase();
}
