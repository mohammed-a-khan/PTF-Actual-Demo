/**
 * Report a11y / comprehension polish — Phase 3a (v1.41.0)
 *
 * Five small pure exports that the report builder calls into:
 *
 *   - `renderStatusBadge(status)` — replaces the bare-text status
 *     badge with one that *also* carries a Unicode glyph
 *     (`✓ passed`, `✕ failed`, …). Status now reads correctly when
 *     the report is printed in greyscale or viewed by colour-blind
 *     users.
 *
 *   - `statusIcon(status)` — exposed separately for any call site
 *     that wants just the glyph (e.g., the failure-cluster pills).
 *
 *   - `generateA11yCSS()` — single CSS block injected into the
 *     report's stylesheet. Honours `prefers-reduced-motion`
 *     (WCAG 2.3.3), provides a `.sr-only` visually-hidden utility
 *     class, and emits a focus-visible ring that picks up the
 *     theme's brand colour.
 *
 *   - `generateModalA11yJS()` — small vanilla-JS bundle injected
 *     into the report's runtime. Adds `Esc`-to-close on modals,
 *     focus-trap behaviour while a modal is open, and restores
 *     focus to the trigger element when the modal closes.
 *
 *   - `modalA11yAttrs(modalId, labelId)` — returns the
 *     `role="dialog" aria-modal="true" aria-labelledby="…"`
 *     attribute string for each modal opener.
 *
 * No new dependencies. Same theme tokens, same zero-CDN contract.
 *
 * @module reporter
 */

import { htmlEscape } from './utils/HtmlSanitizer';

// ============================================================================
// Status badge with Unicode icon
// ============================================================================

const STATUS_ICONS: Record<string, string> = {
    passed:  '✓',
    failed:  '✕',
    skipped: '⏵',
    pending: '↻',
    broken:  '⚠',
};

/**
 * Resolve the icon for a status string. Unknown statuses get the
 * "•" bullet so the badge layout stays consistent.
 */
export function statusIcon(status: string): string {
    const key = (status || '').toLowerCase();
    return STATUS_ICONS[key] || '•';
}

/**
 * Render a status badge that carries both the colour *and* a Unicode
 * glyph. Status colours stay theme-driven via the existing
 * `.status-badge.<status>` rules; the glyph rides along so the badge
 * still conveys meaning in greyscale and to colour-blind viewers.
 *
 * `extraClasses` lets callers stack additional class names
 * (e.g. the inline-step variant uses smaller padding).
 */
export function renderStatusBadge(status: string, extraClasses: string = ''): string {
    const safeStatus = (status || '').toLowerCase();
    const icon = statusIcon(safeStatus);
    const cls = `status-badge ${htmlEscape(safeStatus)}${extraClasses ? ' ' + extraClasses : ''}`;
    return `<span class="${cls}"><span class="status-icon" aria-hidden="true">${icon}</span> ${htmlEscape(safeStatus)}</span>`;
}

// ============================================================================
// CSS — reduced motion + sr-only + focus styles + status-icon spacing
// ============================================================================

export function generateA11yCSS(): string {
    return `
    /* v1.41.0 — Phase 3a accessibility polish */

    /* WCAG 2.3.3: respect user's system-level reduced-motion preference.
       The framework's own chart animations honour this via the engine,
       but every CSS transition/animation falls through to ~0 too. */
    @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
            scroll-behavior: auto !important;
        }
    }

    /* Visually-hidden utility — content for screen readers only,
       removed from visual flow but still focusable. */
    .sr-only {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        padding: 0 !important;
        margin: -1px !important;
        overflow: hidden !important;
        clip: rect(0, 0, 0, 0) !important;
        white-space: nowrap !important;
        border: 0 !important;
    }

    /* Focus ring — picks up the brand colour so keyboard nav is
       visible against any theme override. */
    :focus-visible {
        outline: 2px solid var(--brand-color);
        outline-offset: 2px;
        border-radius: 2px;
    }
    /* Suppress default outline only when :focus-visible is supported,
       otherwise legacy browsers keep the default focus ring. */
    @supports selector(:focus-visible) {
        :focus:not(:focus-visible) { outline: none; }
    }

    /* Status-badge icon — small glyph sitting flush against the
       status text. aria-hidden on the glyph itself; the badge as a
       whole still announces "passed" / "failed" / etc. */
    .status-badge .status-icon {
        display: inline-block;
        margin-right: 4px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
    }

    /* Compact status-badge variant — used in nested step-detail rows
       where vertical real estate is tight. Replaces the inline styles
       that used to ride on these badges. */
    .status-badge.status-badge--compact {
        font-size: 0.7em;
        padding: 3px 8px;
        border-radius: 3px;
    }`;
}

// ============================================================================
// Modal a11y attributes + Esc/focus-trap JS
// ============================================================================

/**
 * Returns the `role="dialog" aria-modal="true" aria-labelledby="…"`
 * attribute string for a modal opener. Caller is responsible for
 * placing an element with id=`labelId` inside the modal that names it.
 */
export function modalA11yAttrs(modalId: string, labelId: string): string {
    return `role="dialog" aria-modal="true" aria-labelledby="${htmlEscape(labelId)}" aria-hidden="true" data-modal-id="${htmlEscape(modalId)}"`;
}

/**
 * Runtime JS bundle (string) that wires modal a11y. Injected once
 * into the report's main `<script>` block. Three behaviours:
 *
 *   1. Esc key while any `.modal[style*="display: block"]` is open
 *      closes it (the topmost one, if multiple are stacked).
 *   2. Tab and Shift+Tab inside an open modal cycle within the
 *      modal's focusable descendants — focus can't escape.
 *   3. When a modal opens (display flips to 'block'), the first
 *      focusable element is given focus, and the trigger element
 *      is remembered so focus can be restored when the modal closes.
 *
 * All pure DOM — no library, no framework.
 */
export function generateModalA11yJS(): string {
    return `
        // ── v1.41.0 — Modal accessibility ────────────────────────────
        (function() {
            const FOCUSABLE_SELECTOR =
                'a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])';
            let lastFocusedTrigger = null;

            function getFocusable(modal) {
                return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR))
                    .filter(function(el) { return !el.hasAttribute('disabled'); });
            }

            function visibleModal() {
                // Top-most visible modal — used by Esc + focus trap.
                const candidates = document.querySelectorAll('.modal');
                let last = null;
                candidates.forEach(function(m) {
                    if (m.style.display === 'block') last = m;
                });
                return last;
            }

            function closeModal(modal) {
                if (!modal) return;
                modal.style.display = 'none';
                modal.setAttribute('aria-hidden', 'true');
                if (lastFocusedTrigger && typeof lastFocusedTrigger.focus === 'function') {
                    try { lastFocusedTrigger.focus(); } catch (e) { /* */ }
                }
                lastFocusedTrigger = null;
            }

            // Esc to close
            document.addEventListener('keydown', function(e) {
                if (e.key !== 'Escape' && e.keyCode !== 27) return;
                const m = visibleModal();
                if (m) {
                    e.preventDefault();
                    closeModal(m);
                }
            });

            // Focus trap on Tab
            document.addEventListener('keydown', function(e) {
                if (e.key !== 'Tab' && e.keyCode !== 9) return;
                const m = visibleModal();
                if (!m) return;
                const focusables = getFocusable(m);
                if (focusables.length === 0) return;
                const first = focusables[0];
                const last  = focusables[focusables.length - 1];
                const active = document.activeElement;
                if (e.shiftKey) {
                    if (active === first || !m.contains(active)) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (active === last || !m.contains(active)) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            });

            // When any modal becomes visible: remember the trigger,
            // flip aria-hidden, focus the first focusable element.
            const modalObserver = new MutationObserver(function(records) {
                records.forEach(function(rec) {
                    if (rec.attributeName !== 'style') return;
                    const m = rec.target;
                    if (!m.classList || !m.classList.contains('modal')) return;
                    if (m.style.display === 'block') {
                        // Remember whatever was focused at the moment of opening
                        // — *unless* it's inside the modal itself.
                        const active = document.activeElement;
                        if (active && !m.contains(active) && active !== document.body) {
                            lastFocusedTrigger = active;
                        }
                        m.setAttribute('aria-hidden', 'false');
                        const focusables = getFocusable(m);
                        if (focusables.length > 0) {
                            try { focusables[0].focus(); } catch (e) { /* */ }
                        }
                    } else if (m.style.display === 'none' || m.style.display === '') {
                        m.setAttribute('aria-hidden', 'true');
                    }
                });
            });
            document.querySelectorAll('.modal').forEach(function(m) {
                modalObserver.observe(m, { attributes: true, attributeFilter: ['style'] });
            });
        })();
        // ─────────────────────────────────────────────────────────────`;
}
