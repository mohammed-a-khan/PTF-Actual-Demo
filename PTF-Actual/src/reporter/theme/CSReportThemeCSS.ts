/**
 * Token → CSS string generator.
 *
 * Emits the `:root` custom-property block that drives every styled
 * surface in the HTML report. Pure: no I/O, no globals — takes a
 * `ReportThemeTokens` and returns a string, which makes it trivially
 * testable and lets callers compose multiple themes (e.g., scoped
 * `.theme-dark` blocks in a future dark-mode phase).
 *
 * The variable names match the *existing* CSS in
 * `CSHtmlReportGeneration.ts` so the dozens of `var(--brand-color)`
 * rules already in the file keep working without per-rule edits.
 *
 * @module reporter/theme
 */

import { ReportThemeTokens } from './CSReportThemeTypes';

/**
 * Render a `:root { … }` declaration from a theme token set.
 *
 * @param tokens  the token values to emit
 * @param scope   optional selector to scope the variables under;
 *                defaults to `:root`. Pass `.theme-dark` etc. to
 *                stack multiple themes inside one stylesheet.
 */
export function generateRootCSS(
    tokens: ReportThemeTokens,
    scope: string = ':root',
): string {
    const h = tokens.healthBands;
    const c = tokens.failureCategories;
    return `${scope} {
    --brand-color: ${tokens.brandColor};
    --brand-color-light: ${tokens.brandColorLight};
    --brand-color-dark: ${tokens.brandColorDark};
    --success-color: ${tokens.successColor};
    --danger-color: ${tokens.dangerColor};
    --warning-color: ${tokens.warningColor};
    --info-color: ${tokens.infoColor};
    --background: ${tokens.background};
    --surface: ${tokens.surface};
    --surface-hover: ${tokens.surfaceHover};
    --text-primary: ${tokens.textPrimary};
    --text-secondary: ${tokens.textSecondary};
    --border: ${tokens.border};
    --shadow: ${tokens.shadow};
    --shadow-lg: ${tokens.shadowLg};

    /* Health-band pills — used by the flaky-test table */
    --health-solid-bg: ${h.solid.bg};
    --health-solid-fg: ${h.solid.fg};
    --health-stable-bg: ${h.stable.bg};
    --health-stable-fg: ${h.stable.fg};
    --health-shaky-bg: ${h.shaky.bg};
    --health-shaky-fg: ${h.shaky.fg};
    --health-flaky-bg: ${h.flaky.bg};
    --health-flaky-fg: ${h.flaky.fg};
    --health-broken-bg: ${h.broken.bg};
    --health-broken-fg: ${h.broken.fg};
    --health-toxic-bg: ${h.toxic.bg};
    --health-toxic-fg: ${h.toxic.fg};
    --health-new-bg: ${h.new.bg};
    --health-new-fg: ${h.new.fg};

    /* Failure-category accents — used by the cluster section */
    --category-none: ${c.none};
    --category-timeout: ${c.timeout};
    --category-element-not-found: ${c.elementNotFound};
    --category-assertion-failed: ${c.assertionFailed};
    --category-network-navigation: ${c.networkNavigation};
    --category-page-lifecycle: ${c.pageLifecycle};
    --category-other: ${c.other};
    --category-unknown: ${c.unknown};
}`;
}
