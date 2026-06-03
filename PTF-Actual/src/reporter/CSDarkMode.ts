/**
 * Dark mode + theme toggle — Phase 4a (v1.42.0).
 *
 * Four exports:
 *
 *   - `CS_DEFAULT_DARK_OVERRIDES` — the subset of `ReportThemeTokens`
 *     that needs to flip in dark mode. Brand colours, status colours,
 *     and failure-category accents stay vivid (they're already
 *     designed against light-or-dark backgrounds). Surface, text,
 *     border, shadow, and health-band bg/fg pairs all darken.
 *
 *   - `generateDarkModeCSS(darkTokens)` — emits two CSS blocks:
 *       1. `@media (prefers-color-scheme: dark) :root { … }` —
 *          system-driven dark mode for users who haven't picked
 *       2. `[data-theme="dark"] { … }` — explicit override that
 *          beats both system preference and the default :root
 *     Plus a `[data-theme="light"]` block that lets users force light
 *     even when the system says dark. The toggle JS controls the
 *     `data-theme` attribute on `<html>`.
 *
 *   - `renderThemeToggleButton()` — the toggle's HTML (a single
 *     button with sun/moon glyphs swapped by CSS, sitting in the
 *     header).
 *
 *   - `generateThemeToggleJS()` — vanilla-JS that cycles
 *     light → dark → system on click, persists the choice in
 *     `localStorage`, and re-applies it on page load.
 *
 * Consumer overrides via `CSReportTheme.override(...)` flow through
 * here too: dark mode just re-paints the surface/text/border tokens,
 * leaving any brand-colour override the consumer set untouched.
 *
 * @module reporter
 */

import { ReportThemeTokens } from './theme/CSReportThemeTypes';

// ============================================================================
// Dark-mode token overrides
// ============================================================================

/**
 * Subset of `ReportThemeTokens` that changes in dark mode. Everything
 * not listed here keeps its light-mode value — brand colours, status
 * colours (already WCAG-safe against both backgrounds), and failure-
 * category accents.
 */
export interface DarkThemeOverrides {
    background: string;
    surface: string;
    surfaceHover: string;
    textPrimary: string;
    textSecondary: string;
    border: string;
    shadow: string;
    shadowLg: string;
    healthBands: ReportThemeTokens['healthBands'];
}

export const CS_DEFAULT_DARK_OVERRIDES: DarkThemeOverrides = {
    background: '#0f0f12',
    surface: '#1a1a1f',
    surfaceHover: '#26262d',
    textPrimary: '#f3f4f6',
    textSecondary: '#9ca3af',
    border: '#374151',
    shadow: 'rgba(0, 0, 0, 0.35)',
    shadowLg: 'rgba(0, 0, 0, 0.6)',
    // Health-band pairs need dark equivalents: the pastel light-mode
    // backgrounds (#dcfce7, #fef9c3, …) become unreadable on a dark
    // surface, so we pair muted dark bg with a brighter fg.
    healthBands: {
        solid:  { bg: '#0d3320', fg: '#86efac' },
        stable: { bg: '#0d3320', fg: '#86efac' },
        shaky:  { bg: '#3d2c0a', fg: '#fde68a' },
        flaky:  { bg: '#3d220a', fg: '#fdba74' },
        broken: { bg: '#3d0d0d', fg: '#fca5a5' },
        toxic:  { bg: '#4d1414', fg: '#fecaca' },
        new:    { bg: '#0a1a35', fg: '#93c5fd' },
    },
};

// ============================================================================
// generateDarkModeCSS
// ============================================================================

/**
 * Emit the dark-mode CSS bundle. Three blocks:
 *
 *   - `@media (prefers-color-scheme: dark) :root` — auto from system
 *   - `[data-theme="dark"]` — manual override (beats system)
 *   - `[data-theme="light"]` — explicit light-when-system-is-dark
 *
 * Plus the toggle-button styles and the icon-swap rules.
 */
export function generateDarkModeCSS(dark: DarkThemeOverrides = CS_DEFAULT_DARK_OVERRIDES): string {
    const tokens = `
        --background: ${dark.background};
        --surface: ${dark.surface};
        --surface-hover: ${dark.surfaceHover};
        --text-primary: ${dark.textPrimary};
        --text-secondary: ${dark.textSecondary};
        --border: ${dark.border};
        --shadow: ${dark.shadow};
        --shadow-lg: ${dark.shadowLg};
        --health-solid-bg: ${dark.healthBands.solid.bg};
        --health-solid-fg: ${dark.healthBands.solid.fg};
        --health-stable-bg: ${dark.healthBands.stable.bg};
        --health-stable-fg: ${dark.healthBands.stable.fg};
        --health-shaky-bg: ${dark.healthBands.shaky.bg};
        --health-shaky-fg: ${dark.healthBands.shaky.fg};
        --health-flaky-bg: ${dark.healthBands.flaky.bg};
        --health-flaky-fg: ${dark.healthBands.flaky.fg};
        --health-broken-bg: ${dark.healthBands.broken.bg};
        --health-broken-fg: ${dark.healthBands.broken.fg};
        --health-toxic-bg: ${dark.healthBands.toxic.bg};
        --health-toxic-fg: ${dark.healthBands.toxic.fg};
        --health-new-bg: ${dark.healthBands.new.bg};
        --health-new-fg: ${dark.healthBands.new.fg};`;

    return `
    /* v1.42.0 — Phase 4a dark mode */

    /* Auto: follow system preference when user hasn't toggled. */
    @media (prefers-color-scheme: dark) {
        :root {${tokens}
        }
    }

    /* Explicit dark — manual toggle overrides system. */
    [data-theme="dark"] {${tokens}
    }

    /* Explicit light — manual toggle even if system is dark. */
    [data-theme="light"] {
        /* Reverts to the defaults already in :root. Listed empty so
           the rule's specificity matches [data-theme="dark"] and
           wins the cascade when the user picks "light". */
    }

    /* Theme-toggle button — pinned in the header. Sun glyph in
       light mode, moon glyph in dark, "Auto" in system mode. */
    .theme-toggle {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.3);
        color: inherit;
        cursor: pointer;
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 0.95rem;
        line-height: 1.2;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: background-color 150ms ease, border-color 150ms ease;
    }
    .theme-toggle:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.5);
    }
    .theme-toggle .theme-toggle-mode {
        font-size: 0.74rem;
        opacity: 0.85;
        font-weight: 600;
    }

    /* Image placeholders during lazy-load — avoid layout shift. */
    img[loading="lazy"] {
        background: var(--surface-hover);
    }`;
}

// ============================================================================
// renderThemeToggleButton
// ============================================================================

/**
 * Render the toggle button. Initial UI shows "🌓 Auto" until JS
 * boots and replaces it with the persisted choice.
 */
export function renderThemeToggleButton(): string {
    return `<button type="button" id="theme-toggle" class="theme-toggle"
                    aria-label="Toggle colour theme (currently auto)"
                    title="Toggle theme: click to cycle Light → Dark → Auto">
        <span class="theme-toggle-icon" aria-hidden="true">🌓</span>
        <span class="theme-toggle-mode">Auto</span>
    </button>`;
}

// ============================================================================
// generateThemeToggleJS
// ============================================================================

/**
 * Runtime JS that:
 *   - Reads `localStorage.csReportTheme` on load (`light` | `dark` | `auto`)
 *   - Sets `data-theme` on `<html>` accordingly (or removes it for `auto`)
 *   - Updates the button's icon + label to match
 *   - Cycles light → dark → auto on click
 *   - All keyed off the `#theme-toggle` element so it no-ops when the
 *     header doesn't include the button (e.g. legacy templates)
 */
export function generateThemeToggleJS(): string {
    return `
        // ── v1.42.0 — Theme toggle ──────────────────────────────────
        (function() {
            var STORAGE_KEY = 'csReportTheme';
            var MODES = ['light', 'dark', 'auto'];
            var ICONS = { light: '☀️', dark: '🌙', auto: '🌓' };
            var LABELS = { light: 'Light', dark: 'Dark', auto: 'Auto' };

            function readMode() {
                try {
                    var v = localStorage.getItem(STORAGE_KEY);
                    return MODES.indexOf(v) >= 0 ? v : 'auto';
                } catch (e) { return 'auto'; }
            }
            function writeMode(m) {
                try { localStorage.setItem(STORAGE_KEY, m); } catch (e) { /* */ }
            }
            function apply(mode) {
                var root = document.documentElement;
                if (mode === 'auto') {
                    root.removeAttribute('data-theme');
                } else {
                    root.setAttribute('data-theme', mode);
                }
                var btn = document.getElementById('theme-toggle');
                if (btn) {
                    var icon = btn.querySelector('.theme-toggle-icon');
                    var label = btn.querySelector('.theme-toggle-mode');
                    if (icon) icon.textContent = ICONS[mode] || '🌓';
                    if (label) label.textContent = LABELS[mode] || 'Auto';
                    btn.setAttribute('aria-label',
                        'Toggle colour theme (currently ' + (LABELS[mode] || 'Auto') + ')');
                }
            }
            function cycle(current) {
                var i = MODES.indexOf(current);
                return MODES[(i + 1) % MODES.length];
            }

            // Apply persisted choice as early as possible.
            apply(readMode());

            // Wire the button after DOM is ready.
            function bind() {
                var btn = document.getElementById('theme-toggle');
                if (!btn) return;
                btn.addEventListener('click', function() {
                    var next = cycle(readMode());
                    writeMode(next);
                    apply(next);
                });
            }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', bind);
            } else {
                bind();
            }
        })();
        // ─────────────────────────────────────────────────────────────`;
}
