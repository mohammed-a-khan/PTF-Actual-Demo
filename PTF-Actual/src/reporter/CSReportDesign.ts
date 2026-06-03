/**
 * Design system foundation — v1.43.0 Phase A.
 *
 * Adds the missing layer of design tokens that the v1.40.0 theme
 * system left out: zinc neutral scale, layered shadow recipe,
 * spacing scale, radius scale, and named accent tokens for the
 * stat-card variants and the failure-cluster section.
 *
 * Phase A is foundation-only — these tokens are emitted onto
 * `:root` but no existing module is rewritten to use them yet.
 * Phase B and later phases refactor surfaces to opt into them
 * one at a time.
 *
 * Aesthetic anchor: shadcn/ui (dominant 2026 dev-tool look).
 * Sources / research:
 *   - https://ui.shadcn.com (canonical 6-variant button + zinc neutrals)
 *   - https://vercel.com/geist (pure-grey ramp, single accent)
 *   - https://styles.refero.design (Linear's exact tokens)
 *   - https://www.layoutscene.com/card-ui-design-patterns-guide-2026
 *   - https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl
 *
 * Backward-compatible:
 *   - Every v1.40+ token (`--brand-color`, `--success-color`,
 *     `--surface`, `--text-primary`, `--border`, etc.) is left
 *     primary — these new tokens live alongside, not on top.
 *   - The `--font-sans` / `--font-mono` / `--elev-1/2/3` /
 *     `--radius-{sm,md,lg,pill}` / `--ease-emphasized` / `--dur-*`
 *     tokens get aliased here too so the previous v1.43 alpha
 *     (now reverted) modules can be re-introduced cleanly in
 *     later phases without breaking.
 *
 * @module reporter
 */

// ============================================================================
// Design tokens CSS bundle
// ============================================================================

export function generateDesignTokensCSS(): string {
    return `
    /* ─────────────────────────────────────────────────────────────
       v1.43.0 — design system foundation (Phase A)
       Zinc neutrals + layered shadows + spacing + radii + accent
       extensions. Phase A is foundation-only; surfaces refactor
       later.
       ───────────────────────────────────────────────────────────── */

    :root {
        /* ── ZINC NEUTRAL SCALE ────────────────────────────────────
           50 → 950 ramp used wherever a non-semantic neutral is
           needed (page bg, card surface, border, muted text). The
           v1.40 --surface / --text-primary / --border tokens stay
           primary; these are the underlying canvas. */
        --cs-zinc-50:  #fafafa;
        --cs-zinc-100: #f4f4f5;
        --cs-zinc-200: #e4e4e7;
        --cs-zinc-300: #d4d4d8;
        --cs-zinc-400: #a1a1aa;
        --cs-zinc-500: #71717a;
        --cs-zinc-600: #52525b;
        --cs-zinc-700: #3f3f46;
        --cs-zinc-800: #27272a;
        --cs-zinc-900: #18181b;
        --cs-zinc-950: #09090b;

        /* ── ACCENT EXTENSIONS ─────────────────────────────────────
           Soft / strong derivatives of the v1.40 brand colour.
           Used for soft-tint button backgrounds, hover states,
           focus rings. */
        --cs-brand-soft: color-mix(in oklab, var(--brand-color) 10%, transparent);
        --cs-brand-strong: color-mix(in oklab, var(--brand-color) 80%, black);

        --cs-success-soft: color-mix(in oklab, var(--success-color) 12%, transparent);
        --cs-warning-soft: color-mix(in oklab, var(--warning-color) 12%, transparent);
        --cs-danger-soft:  color-mix(in oklab, var(--danger-color)  12%, transparent);
        --cs-info-soft:    color-mix(in oklab, var(--info-color)    12%, transparent);

        /* Fallback for browsers without color-mix (Safari < 16.4) —
           hand-tuned rgba approximations. */

        /* ── STAT-CARD VARIANT ACCENTS ─────────────────────────────
           Today the stat-card.features/.scenarios/.steps/.time/
           .stability classes hardcode purple/cyan/pink/teal/green.
           Extracted so consumers can override and dark mode flows
           through. Phase A: tokens defined. Phase D: stat-card CSS
           refactored to use them. */
        --cs-stat-features:    #8b5cf6;  /* violet 500 */
        --cs-stat-scenarios:   #06b6d4;  /* cyan 500 */
        --cs-stat-steps:       #ec4899;  /* pink 500 */
        --cs-stat-time:        #14b8a6;  /* teal 500 */
        --cs-stat-stability:   #22c55e;  /* green 500 */

        /* ── FAILURE-CLUSTER PALETTE ──────────────────────────────
           Extracted from the hardcoded slate/orange in
           CSFailureClusterSection.ts. These were the worst
           dark-mode offenders (no override at all). */
        --cs-fc-summary-bg:    var(--surface);
        --cs-fc-summary-bd:    var(--border);
        --cs-fc-cluster-bg:    color-mix(in oklab, var(--warning-color) 8%, var(--surface));
        --cs-fc-cluster-bd:    color-mix(in oklab, var(--warning-color) 30%, var(--border));
        --cs-fc-size-bg:       var(--warning-color);
        --cs-fc-size-fg:       #ffffff;
        --cs-fc-member-bd:     var(--border);
        --cs-fc-frames-bg:     var(--surface-hover);
        --cs-fc-test-name:     var(--text-primary);
        --cs-fc-file-path:     var(--text-secondary);
        --cs-fc-error-msg:     var(--text-secondary);

        /* ── LAYERED SHADOW RECIPE ────────────────────────────────
           Josh Comeau-style ambient + key + contact stack. Used for
           the new card primitives. Aliased as --elev-{1,2,3} so
           older module references resolve. */
        --cs-shadow-xs:
            0 1px 1px rgba(15, 23, 42, 0.04),
            0 0 0 1px rgba(15, 23, 42, 0.03);
        --cs-shadow-sm:
            0 1px 2px rgba(15, 23, 42, 0.04),
            0 1px 3px rgba(15, 23, 42, 0.05),
            0 0 0 1px rgba(15, 23, 42, 0.03);
        --cs-shadow-md:
            0 2px 4px rgba(15, 23, 42, 0.05),
            0 4px 8px rgba(15, 23, 42, 0.06),
            0 0 0 1px rgba(15, 23, 42, 0.04);
        --cs-shadow-lg:
            0 4px 8px rgba(15, 23, 42, 0.06),
            0 12px 24px rgba(15, 23, 42, 0.08),
            0 0 0 1px rgba(15, 23, 42, 0.05);
        --cs-shadow-xl:
            0 8px 16px rgba(15, 23, 42, 0.08),
            0 20px 40px rgba(15, 23, 42, 0.10),
            0 0 0 1px rgba(15, 23, 42, 0.05);

        /* 2px focus ring with 2px offset — :focus-visible only.
           Replaces border-change focus tricks. */
        --cs-shadow-ring:
            0 0 0 2px var(--background, #ffffff),
            0 0 0 4px color-mix(in oklab, var(--brand-color) 35%, transparent);

        /* Aliases so the previously-reverted v1.43 modules can be
           reintroduced without rewriting their var() lookups. */
        --elev-1: var(--cs-shadow-xs);
        --elev-2: var(--cs-shadow-sm);
        --elev-3: var(--cs-shadow-lg);

        /* ── SPACING (4px / 8px grid) ─────────────────────────────
           Used by new primitives + later refactored surfaces. */
        --cs-space-0:   0;
        --cs-space-1:   4px;
        --cs-space-1\\.5: 6px;
        --cs-space-2:   8px;
        --cs-space-3:   12px;
        --cs-space-4:   16px;
        --cs-space-5:   20px;
        --cs-space-6:   24px;
        --cs-space-8:   32px;
        --cs-space-10:  40px;
        --cs-space-12:  48px;
        --cs-space-16:  64px;

        /* ── RADIUS SCALE ─────────────────────────────────────────
           Phase B+ standardises every card / chip / button on these.
           shadcn defaults: 4/6/8/12/16/full. */
        --cs-radius-xs:   4px;
        --cs-radius-sm:   6px;
        --cs-radius-md:   8px;
        --cs-radius-lg:   12px;
        --cs-radius-xl:   16px;
        --cs-radius-2xl:  20px;
        --cs-radius-full: 9999px;
        /* Aliases for previously-reverted v1.43 module code. */
        --radius-sm: var(--cs-radius-sm);
        --radius-md: var(--cs-radius-md);
        --radius-lg: var(--cs-radius-lg);
        --radius-pill: var(--cs-radius-full);

        /* ── TYPOGRAPHY ───────────────────────────────────────────
           System cascade (zero web-font embed — stays self-contained). */
        --cs-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable",
                        "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, Arial,
                        "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
        --cs-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo,
                        Consolas, "Liberation Mono", "Cascadia Code",
                        "Roboto Mono", monospace;
        /* Aliases */
        --font-sans: var(--cs-font-sans);
        --font-mono: var(--cs-font-mono);

        /* Type scale — small-ish overall (dev-tool, not consumer site). */
        --cs-text-xs:   11px;
        --cs-text-sm:   12.5px;
        --cs-text-base: 14px;
        --cs-text-lg:   16px;
        --cs-text-xl:   18px;
        --cs-text-2xl:  22px;
        --cs-text-3xl:  28px;
        --cs-text-4xl:  36px;

        --cs-lh-tight:  1.2;
        --cs-lh-snug:   1.35;
        --cs-lh-normal: 1.5;

        --cs-weight-normal:   400;
        --cs-weight-medium:   500;
        --cs-weight-semibold: 600;
        --cs-weight-bold:     700;

        /* ── MOTION ───────────────────────────────────────────────
           One ease curve, three durations. Aliased for back-compat. */
        --cs-ease:     cubic-bezier(0.2, 0, 0, 1);
        --cs-ease-out: cubic-bezier(0, 0, 0.2, 1);
        --cs-dur-fast: 150ms;
        --cs-dur-base: 220ms;
        --cs-dur-slow: 320ms;
        /* Aliases */
        --ease-emphasized: var(--cs-ease);
        --dur-fast: var(--cs-dur-fast);
        --dur-med: var(--cs-dur-base);

        /* ── Z-INDEX SCALE ────────────────────────────────────────
           Used by new modal/popover/tooltip primitives. */
        --cs-z-base:     1;
        --cs-z-dropdown: 50;
        --cs-z-sticky:   100;
        --cs-z-overlay:  500;
        --cs-z-modal:    1000;
        --cs-z-toast:    2000;
        --cs-z-tooltip:  3000;
    }

    /* ── DARK MODE OVERRIDES (additive — only the new tokens) ──
       The v1.40 dark-mode override of --background/--surface/
       --text-primary/--border still primary; these add overrides
       for the new shadow recipe and stat-card variant accents so
       they don't punch through on dark surfaces. */
    [data-theme="dark"] {
        --cs-shadow-xs:
            0 1px 1px rgba(0, 0, 0, 0.30),
            0 0 0 1px rgba(255, 255, 255, 0.04);
        --cs-shadow-sm:
            0 1px 2px rgba(0, 0, 0, 0.30),
            0 2px 4px rgba(0, 0, 0, 0.20),
            0 0 0 1px rgba(255, 255, 255, 0.05);
        --cs-shadow-md:
            0 2px 4px rgba(0, 0, 0, 0.35),
            0 4px 8px rgba(0, 0, 0, 0.25),
            0 0 0 1px rgba(255, 255, 255, 0.06);
        --cs-shadow-lg:
            0 4px 8px rgba(0, 0, 0, 0.40),
            0 12px 24px rgba(0, 0, 0, 0.30),
            0 0 0 1px rgba(255, 255, 255, 0.07);
        --cs-shadow-xl:
            0 8px 16px rgba(0, 0, 0, 0.45),
            0 20px 40px rgba(0, 0, 0, 0.35),
            0 0 0 1px rgba(255, 255, 255, 0.08);

        /* Stat-card variants — slightly softer in dark mode so they
           don't punch through the dim surface. */
        --cs-stat-features:    #a78bfa;
        --cs-stat-scenarios:   #22d3ee;
        --cs-stat-steps:       #f472b6;
        --cs-stat-time:        #2dd4bf;
        --cs-stat-stability:   #4ade80;

        /* Failure-cluster — re-derive from dark surface so the
           warm tint stays visible without overpowering. */
        --cs-fc-cluster-bg:    color-mix(in oklab, var(--warning-color) 14%, var(--surface));
    }

    /* Same-spirit fallback when color-mix isn't supported. The dark
       overrides above use color-mix; the @supports block keeps a
       reasonable rgba for old browsers. */
    @supports not (background: color-mix(in oklab, red 50%, blue)) {
        :root {
            --cs-brand-soft: rgba(77, 0, 77, 0.10);
            --cs-success-soft: rgba(22, 163, 74, 0.10);
            --cs-warning-soft: rgba(217, 119, 6, 0.10);
            --cs-danger-soft:  rgba(220, 38, 38, 0.10);
            --cs-info-soft:    rgba(37, 99, 235, 0.10);
            --cs-fc-cluster-bg: rgba(217, 119, 6, 0.06);
        }
    }
    `;
}
