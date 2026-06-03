/**
 * Phase 3c — keyboard navigation + chart fallback tables (v1.41.2).
 *
 * Two complementary additions on the comprehension-polish arc:
 *
 *   - **Keyboard nav** (`generateKeyboardNavJS()`) — wires `/` to
 *     focus the search box (anywhere in the report, like GitHub /
 *     Slack), `Esc` to clear and blur it, and arrow-key navigation
 *     plus Enter/Space activation on focusable scenario rows. None
 *     of this fights existing handlers; each shortcut checks for
 *     an editable element before claiming the keystroke.
 *
 *   - **Chart fallback table** (`renderChartFallbackTable`) — emits
 *     an `.sr-only` HTML `<table>` next to each canvas chart so
 *     screen-reader users, greyscale printouts, and clipboard
 *     copy-paste all get the same data the sighted user sees. Pure
 *     function — takes a caption + headers + rows and returns the
 *     table HTML, no rendering side effects.
 *
 * A small CSS bundle (`generateKbdNavCSS()`) tightens the focus
 * ring on rows that get the new `tabindex` so keyboard users see
 * exactly which row is active, and adds a tiny "shortcut hint"
 * tooltip that fades in when the search box is focused.
 *
 * @module reporter
 */

import { htmlEscape } from './utils/HtmlSanitizer';

// ============================================================================
// renderChartFallbackTable — accessible alternative to canvas charts
// ============================================================================

export interface ChartFallbackInput {
    /** Caption announced as the table's name; one short sentence. */
    caption: string;
    /** Column headers — first cell becomes the row-name header, rest are value columns. */
    headers: string[];
    /** Each row is `[rowLabel, ...values]`. Numbers are coerced to strings. */
    rows: Array<Array<string | number>>;
}

/**
 * Render a visually-hidden `<table>` carrying the same data the
 * canvas chart shows. Wrapped in `.sr-only` (defined by the
 * v1.41.0 a11y CSS) so it never affects layout but stays
 * announceable by screen readers.
 */
export function renderChartFallbackTable(input: ChartFallbackInput): string {
    if (!input || !Array.isArray(input.rows) || input.rows.length === 0) return '';
    const headers = Array.isArray(input.headers) && input.headers.length > 0
        ? input.headers
        : ['Item', 'Value'];

    const headHtml = '<tr>'
        + headers.map(h => `<th scope="col">${htmlEscape(String(h))}</th>`).join('')
        + '</tr>';

    const bodyHtml = input.rows.map(r => {
        if (!Array.isArray(r) || r.length === 0) return '';
        const [first, ...rest] = r;
        const cells = [`<th scope="row">${htmlEscape(String(first))}</th>`]
            .concat(rest.map(v => `<td>${htmlEscape(String(v))}</td>`))
            .join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    return `<table class="sr-only chart-fallback-table">
        <caption>${htmlEscape(input.caption || 'Chart data')}</caption>
        <thead>${headHtml}</thead>
        <tbody>${bodyHtml}</tbody>
    </table>`;
}

// ============================================================================
// generateKbdNavCSS
// ============================================================================

export function generateKbdNavCSS(): string {
    return `
    /* v1.41.2 — Phase 3c keyboard-nav polish */

    /* Focusable scenario rows — tightened focus ring beyond the
       global :focus-visible so they're clearly highlighted while
       arrow-key navigation moves between them. */
    .scenario-header:focus-visible {
        outline: 2px solid var(--brand-color);
        outline-offset: -2px;
        background: var(--surface-hover);
        border-radius: 4px;
    }

    /* Tiny inline hint that fades in when the search box gains
       focus. The label/title attributes still carry the same text
       for tooltips and screen readers. */
    .test-search-shortcut-hint {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 0.72rem;
        color: var(--text-secondary);
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 3px;
        padding: 1px 5px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        pointer-events: none;
        opacity: 0.6;
    }`;
}

// ============================================================================
// generateKeyboardNavJS
// ============================================================================

/**
 * Runtime JS bundle (string) wiring report-wide keyboard shortcuts.
 * Injected once into the report's main `<script>` block alongside
 * the modal a11y bundle from `CSReportA11y.ts`.
 *
 * Shortcuts:
 *   - `/`             focus #test-search (if not already in an editable)
 *   - `Esc` (in search) blur + clear the search box
 *   - `↑/↓`           move focus between visible `.scenario-header[tabindex]`
 *   - `Enter`/`Space` on a focused row → toggle expand
 *   - aria-expanded on each row is kept in sync with the open/close
 *     state so screen readers announce it correctly
 *
 * All shortcuts no-op when an editable element (input, textarea,
 * contentEditable) already owns the focus — never steal a user's
 * typing.
 */
export function generateKeyboardNavJS(): string {
    return `
        // ── v1.41.2 — Keyboard navigation ───────────────────────────
        (function() {
            function inEditable() {
                const el = document.activeElement;
                if (!el) return false;
                const tag = (el.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
                if (el.isContentEditable) return true;
                return false;
            }
            function visibleRows() {
                return Array.from(document.querySelectorAll('.scenario-header[tabindex]'))
                    .filter(function(el) {
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    });
            }
            function syncExpanded(header) {
                const steps = header.nextElementSibling;
                if (!steps) return;
                header.setAttribute('aria-expanded',
                    steps.classList.contains('expanded') ? 'true' : 'false');
            }
            // Initial aria-expanded pass — scenario rows start collapsed.
            document.querySelectorAll('.scenario-header[tabindex]').forEach(function(h) {
                if (!h.hasAttribute('aria-expanded')) h.setAttribute('aria-expanded', 'false');
            });

            document.addEventListener('keydown', function(e) {
                // '/' focuses the search box
                if (e.key === '/' && !inEditable()) {
                    const search = document.getElementById('test-search');
                    if (search) {
                        e.preventDefault();
                        search.focus();
                        try { search.select(); } catch (err) { /* */ }
                    }
                    return;
                }
                // Esc in search → blur + clear
                if ((e.key === 'Escape' || e.keyCode === 27) &&
                    document.activeElement &&
                    document.activeElement.id === 'test-search') {
                    e.preventDefault();
                    document.activeElement.value = '';
                    document.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
                    document.activeElement.blur();
                    return;
                }
                // Arrow keys: move between rows when focus is on a row
                // (or no focus / on body — first arrow grabs first row).
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                if (inEditable()) return;
                const rows = visibleRows();
                if (rows.length === 0) return;
                const current = document.activeElement &&
                    document.activeElement.classList &&
                    document.activeElement.classList.contains('scenario-header')
                    ? document.activeElement : null;
                let nextIdx;
                if (!current) {
                    nextIdx = 0;
                } else {
                    const i = rows.indexOf(current);
                    if (i === -1) nextIdx = 0;
                    else if (e.key === 'ArrowDown') nextIdx = Math.min(rows.length - 1, i + 1);
                    else nextIdx = Math.max(0, i - 1);
                }
                e.preventDefault();
                try { rows[nextIdx].focus(); } catch (err) { /* */ }
                try { rows[nextIdx].scrollIntoView({ block: 'nearest' }); } catch (err) { /* */ }
            });

            // Enter / Space toggles the focused row. We hook into the
            // existing toggleScenario(this) handler so the visual state
            // (icon flip + .expanded class) stays consistent.
            document.addEventListener('keydown', function(e) {
                if (e.key !== 'Enter' && e.key !== ' ' && e.keyCode !== 13 && e.keyCode !== 32) return;
                const el = document.activeElement;
                if (!el || !el.classList || !el.classList.contains('scenario-header')) return;
                e.preventDefault();
                if (typeof toggleScenario === 'function') {
                    try { toggleScenario(el); } catch (err) { /* */ }
                }
                syncExpanded(el);
            });

            // Keep aria-expanded in sync after any click-toggle too.
            document.addEventListener('click', function(e) {
                let el = e.target;
                while (el && el !== document.body) {
                    if (el.classList && el.classList.contains('scenario-header')) {
                        // Defer one tick so toggleScenario has flipped .expanded.
                        setTimeout(function() { syncExpanded(el); }, 0);
                        return;
                    }
                    el = el.parentElement;
                }
            });
        })();
        // ─────────────────────────────────────────────────────────────`;
}
