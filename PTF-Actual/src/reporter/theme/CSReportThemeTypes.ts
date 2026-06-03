/**
 * Report theme — token shapes + factory defaults.
 *
 * Phase 1 keeps the token *names* identical to the existing
 * CSS custom-property names baked into `CSHtmlReportGeneration.ts`
 * (`--brand-color`, `--success-color`, …). This means every CSS
 * rule already in the report file keeps working without per-rule
 * edits — only the `:root` declaration itself is regenerated from
 * this token set. Section-level palettes (flaky health bands,
 * failure-cluster severity) keep their own colour systems for now;
 * they'll fold into this module in a later phase.
 *
 * Defaults align with the perf-app's `computershare-theme.css`
 * primary family (`#4d004d`) so reports look like they belong to
 * the same product surface. No company name is encoded here —
 * just the values — so the framework stays generic and consumers
 * are free to override via `CSReportTheme.override()`.
 *
 * @module reporter/theme
 */

/**
 * A health-band pill colour pair — used by the flaky-test section
 * to colour Solid / Stable / Shaky / Flaky / Broken / Toxic / New
 * badges in the per-test table.
 */
export interface HealthBandColors {
    /** Pill background. */
    bg: string;
    /** Pill foreground text. */
    fg: string;
}

/**
 * Health-band token set. Names match the flaky-test detector's
 * tier vocabulary; new bands added here must also be exposed via
 * `generateRootCSS()` so the report stylesheet picks them up.
 */
export interface HealthBandTokens {
    solid: HealthBandColors;
    stable: HealthBandColors;
    shaky: HealthBandColors;
    flaky: HealthBandColors;
    broken: HealthBandColors;
    toxic: HealthBandColors;
    /** First-run / "no history yet" indicator. */
    new: HealthBandColors;
}

/**
 * Failure-category accent colours. Used by the failure-cluster
 * section and the flaky table's "likely cause" column.
 */
export interface FailureCategoryTokens {
    none: string;
    timeout: string;
    elementNotFound: string;
    assertionFailed: string;
    networkNavigation: string;
    pageLifecycle: string;
    other: string;
    unknown: string;
}

export interface ReportThemeTokens {
    /** Primary brand colour. Used for headers, accents, focus rings. */
    brandColor: string;
    /** Lighter brand tint — hover states, secondary accents. */
    brandColorLight: string;
    /** Darker brand tint — gradient ends, pressed states. */
    brandColorDark: string;

    /** Success / pass status colour. */
    successColor: string;
    /** Failure / error colour. */
    dangerColor: string;
    /** Caution / pending colour. */
    warningColor: string;
    /** Information / neutral-active colour. */
    infoColor: string;

    /** Page background. */
    background: string;
    /** Card / surface fill. */
    surface: string;
    /** Surface hover state. */
    surfaceHover: string;
    /** Body text colour. */
    textPrimary: string;
    /** Secondary / muted text colour. */
    textSecondary: string;
    /** Border colour for surfaces and tables. */
    border: string;

    /** rgba string for default box-shadows. */
    shadow: string;
    /** rgba string for elevated / hover box-shadows. */
    shadowLg: string;

    /** Per-band colours for the flaky-test health pills. */
    healthBands: HealthBandTokens;
    /** Per-category accent colours for failure clusters. */
    failureCategories: FailureCategoryTokens;
}

/**
 * Factory defaults. Brand family mirrors the perf-app primary
 * (`#4d004d`); shadows are tinted with the brand for visual
 * cohesion across surfaces. Status colours follow the WCAG-safe
 * palette already in use across the framework.
 */
export const CS_DEFAULT_REPORT_THEME: ReportThemeTokens = {
    brandColor: '#4d004d',
    brandColorLight: '#7a2d7a',
    brandColorDark: '#330033',

    successColor: '#059669',
    dangerColor: '#dc2626',
    warningColor: '#d97706',
    infoColor: '#0ea5e9',

    background: '#ffffff',
    surface: '#f9fafb',
    surfaceHover: '#f3f4f6',
    textPrimary: '#111827',
    textSecondary: '#6b7280',
    border: '#e5e7eb',

    shadow: 'rgba(77, 0, 77, 0.08)',
    shadowLg: 'rgba(77, 0, 77, 0.16)',

    healthBands: {
        // Green pair — passing tests with no recent flake history.
        solid:  { bg: '#dcfce7', fg: '#166534' },
        stable: { bg: '#dcfce7', fg: '#166534' },
        // Yellow pair — occasional intermittent failures.
        shaky:  { bg: '#fef9c3', fg: '#854d0e' },
        // Orange pair — meaningfully flaky, owner attention warranted.
        flaky:  { bg: '#ffedd5', fg: '#9a3412' },
        // Red pair — broken more often than not.
        broken: { bg: '#fee2e2', fg: '#991b1b' },
        // Dark red pair — quarantine candidates.
        toxic:  { bg: '#fecaca', fg: '#7f1d1d' },
        // Blue pair — first-run / no history yet.
        new:    { bg: '#dbeafe', fg: '#1e40af' },
    },

    failureCategories: {
        none:              '#22c55e',
        timeout:           '#f59e0b',
        elementNotFound:   '#f97316',
        assertionFailed:   '#ef4444',
        networkNavigation: '#8b5cf6',
        pageLifecycle:     '#6366f1',
        other:             '#ec4899',
        unknown:           '#64748b',
    },
};
