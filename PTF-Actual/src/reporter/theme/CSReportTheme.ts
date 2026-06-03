/**
 * Report-theme singleton.
 *
 * The HTML report's `:root` CSS block is generated from this object
 * at report-generation time. Consumers can override any subset of
 * tokens before a run to brand the output without forking source.
 *
 *     import { CSReportTheme } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
 *
 *     CSReportTheme.getInstance().override({
 *         brandColor: '#0033A0',
 *         brandColorLight: '#3366B3',
 *         brandColorDark: '#001E66',
 *     });
 *
 * Defaults intentionally match the perf-app's primary family so
 * reports look like they belong to the same product surface. No
 * customer name is referenced anywhere here; the values are just
 * the values, and any consumer can replace them.
 *
 * @module reporter/theme
 */

import {
    CS_DEFAULT_REPORT_THEME,
    ReportThemeTokens,
} from './CSReportThemeTypes';

export class CSReportTheme {
    private static instance: CSReportTheme;
    private tokens: ReportThemeTokens = { ...CS_DEFAULT_REPORT_THEME };

    private constructor() { /* singleton */ }

    public static getInstance(): CSReportTheme {
        if (!CSReportTheme.instance) {
            CSReportTheme.instance = new CSReportTheme();
        }
        return CSReportTheme.instance;
    }

    /** Returns a defensive copy of the current token set. */
    public get(): ReportThemeTokens {
        return { ...this.tokens };
    }

    /**
     * Merge a partial token set into the live theme. Subsequent
     * report generations pick up the new values.
     *
     * Two-level merge: top-level string properties replace as
     * expected, and the nested `healthBands` / `failureCategories`
     * sub-objects merge one level deep so callers can override a
     * single band (e.g. `{ healthBands: { toxic: { bg: '#x', fg: '#y' } } }`)
     * without having to restate every other band.
     */
    public override(
        partial: Partial<{
            [K in keyof ReportThemeTokens]: ReportThemeTokens[K] extends object
                ? Partial<{ [P in keyof ReportThemeTokens[K]]: Partial<ReportThemeTokens[K][P]> | ReportThemeTokens[K][P] }>
                : ReportThemeTokens[K];
        }>,
    ): void {
        const next: any = { ...this.tokens };
        for (const key of Object.keys(partial) as Array<keyof ReportThemeTokens>) {
            const incoming = (partial as any)[key];
            if (incoming == null) continue;
            const current = (next as any)[key];
            if (typeof incoming === 'object' && !Array.isArray(incoming) &&
                typeof current === 'object' && current !== null) {
                // Two-level deep merge for the nested sub-objects
                const merged: any = { ...current };
                for (const subKey of Object.keys(incoming)) {
                    const subVal = incoming[subKey];
                    const curSub = current[subKey];
                    if (subVal && typeof subVal === 'object' && !Array.isArray(subVal) &&
                        typeof curSub === 'object' && curSub !== null) {
                        merged[subKey] = { ...curSub, ...subVal };
                    } else {
                        merged[subKey] = subVal;
                    }
                }
                next[key] = merged;
            } else {
                next[key] = incoming;
            }
        }
        this.tokens = next;
    }

    /** Reset to factory defaults — handy for tests. */
    public reset(): void {
        this.tokens = { ...CS_DEFAULT_REPORT_THEME };
    }
}
