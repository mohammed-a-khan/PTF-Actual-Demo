/**
 * Virtual scrolling — Phase 4c (v1.42.2).
 *
 * The Tests view dumps every scenario card into the DOM at render
 * time. For typical suites (10–80 scenarios) that's fine. But for
 * 200+ scenario runs — common on full regression nights — the
 * initial paint balloons: the browser lays out hundreds of headers,
 * step tables, screenshots, and per-scenario chevron buttons before
 * the user sees anything. Scroll then sticks because the layer tree
 * is huge.
 *
 * v1.42.2 ships an `IntersectionObserver`-based reveal strategy:
 *
 *   - Below `VSCROLL_THRESHOLD` scenarios → no-op. Existing
 *     behaviour preserved byte-for-byte.
 *
 *   - At or above the threshold → render the first `INITIAL_BATCH`
 *     scenarios immediately; hide the rest with a `vscroll-hidden`
 *     CSS class (uses `!important` so the v1.39.x search code's
 *     inline `style.display = 'block'` doesn't accidentally
 *     un-hide them).
 *
 *   - A 1 px sentinel sits after the last visible scenario. When
 *     it intersects the viewport (with a 400 px `rootMargin` so
 *     reveals happen *before* the user reaches the bottom) the
 *     next `BATCH_SIZE` scenarios un-hide.
 *
 *   - A small status banner near the top of the Tests view shows
 *     "Showing N of M scenarios" so the user understands why fewer
 *     rows are visible than the dashboard totals say.
 *
 *   - Search coordination: the v1.39.x `#test-search` filter sets
 *     inline `display: 'none' | 'block'` per scenario; when the
 *     user types we full-reveal everything and disconnect the
 *     observer (search wants to see all matches). Clearing the
 *     search re-collapses if still above threshold.
 *
 *   - Graceful degradation: if `IntersectionObserver` isn't
 *     available (old Edge / IE), the script no-ops — every
 *     scenario stays in the DOM, paint penalty unchanged from
 *     v1.42.1.
 *
 * Zero new deps. Pure vanilla JS injected as a string into the
 * report's runtime `<script>` block. CSS uses theme tokens only.
 *
 * @module reporter
 */

// ============================================================================
// Thresholds (kept in module scope so both CSS + JS sides agree)
// ============================================================================

/** Below this many scenarios, virtual scroll is a no-op. */
export const VSCROLL_THRESHOLD = 200;
/** First wave rendered immediately on page load. */
export const VSCROLL_INITIAL_BATCH = 100;
/** Each subsequent reveal when the sentinel intersects. */
export const VSCROLL_BATCH_SIZE = 50;
/** rootMargin — start revealing this many pixels before the sentinel hits the viewport. */
export const VSCROLL_PREFETCH_PX = 400;

// ============================================================================
// CSS bundle
// ============================================================================

/**
 * Emit the virtual-scroll CSS. Two utility classes (`.vscroll-hidden`
 * and `.vscroll-sentinel`) plus the status banner. Theme tokens only.
 */
export function generateVirtualScrollCSS(): string {
    return `
    /* v1.42.2 — Phase 4c virtual scroll */

    /* Hidden state. !important is intentional — the v1.39.x search
       handler sets inline display:block on matches, and we don't want
       it to un-hide scenarios that virtual scroll is suppressing for
       paint-cost reasons. */
    .scenario-item.vscroll-hidden {
        display: none !important;
    }

    /* Sentinel — 1 px transparent div the IntersectionObserver
       watches. aria-hidden in markup keeps screen readers from
       announcing it. */
    .vscroll-sentinel {
        height: 1px;
        width: 100%;
        margin: 0;
        padding: 0;
        background: transparent;
        pointer-events: none;
    }

    /* Status banner — "Showing N of M scenarios". Sticky at the top
       of the Tests view so the user always knows where they stand. */
    .vscroll-status {
        position: sticky;
        top: 0;
        z-index: 5;
        margin: 0 0 12px 0;
        padding: 8px 14px;
        background: var(--surface-hover);
        border: 1px solid var(--border);
        border-radius: 6px;
        font-size: 0.85rem;
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }
    .vscroll-status-text { flex: 1 1 auto; }
    .vscroll-status-action {
        background: transparent;
        color: var(--brand-color);
        border: 1px solid var(--brand-color);
        border-radius: 4px;
        padding: 3px 10px;
        font-size: 0.78rem;
        cursor: pointer;
        flex: 0 0 auto;
    }
    .vscroll-status-action:hover {
        background: var(--brand-color);
        color: #fff;
    }
    .vscroll-status[hidden] { display: none !important; }`;
}

// ============================================================================
// Runtime JS
// ============================================================================

/**
 * Emit the runtime JS that wires up virtual scrolling. Reads the
 * thresholds from the module-level constants so CSS + JS + tests
 * all share one source of truth.
 *
 * No-op when:
 *   - `IntersectionObserver` isn't available (graceful fallback)
 *   - `#tests-view` isn't in the DOM
 *   - fewer than `VSCROLL_THRESHOLD` `.scenario-item` rows exist
 */
export function generateVirtualScrollJS(): string {
    return `
        // ── v1.42.2 — Virtual scroll for large suites ────────────────
        (function() {
            var THRESHOLD = ${VSCROLL_THRESHOLD};
            var INITIAL   = ${VSCROLL_INITIAL_BATCH};
            var BATCH     = ${VSCROLL_BATCH_SIZE};
            var PREFETCH  = ${VSCROLL_PREFETCH_PX};

            if (typeof IntersectionObserver === 'undefined') return;

            var view = document.getElementById('tests-view');
            if (!view) return;

            var scenarios = view.querySelectorAll('.scenario-item');
            var total = scenarios.length;
            if (total < THRESHOLD) return;

            var visible = INITIAL;
            var disabledForSearch = false;

            function applyVisibility() {
                for (var i = 0; i < scenarios.length; i++) {
                    if (i < visible) scenarios[i].classList.remove('vscroll-hidden');
                    else scenarios[i].classList.add('vscroll-hidden');
                }
                updateBanner();
            }

            function updateBanner() {
                if (!bannerText) return;
                if (disabledForSearch) {
                    bannerText.textContent = 'Search active — showing all matches';
                    bannerAction.hidden = true;
                    return;
                }
                var shown = Math.min(visible, total);
                bannerText.textContent = 'Showing ' + shown + ' of ' + total +
                    ' scenarios (scroll to load more)';
                bannerAction.hidden = (shown >= total);
            }

            // Banner: sticky "Showing N of M" with a "Show all" escape.
            var banner = document.createElement('div');
            banner.className = 'vscroll-status';
            banner.setAttribute('role', 'status');
            banner.setAttribute('aria-live', 'polite');
            var bannerText = document.createElement('span');
            bannerText.className = 'vscroll-status-text';
            var bannerAction = document.createElement('button');
            bannerAction.type = 'button';
            bannerAction.className = 'vscroll-status-action';
            bannerAction.textContent = 'Show all';
            bannerAction.addEventListener('click', function() {
                visible = total;
                applyVisibility();
                if (io) io.disconnect();
                if (sentinel && sentinel.parentNode) sentinel.parentNode.removeChild(sentinel);
            });
            banner.appendChild(bannerText);
            banner.appendChild(bannerAction);
            view.insertBefore(banner, view.firstChild);

            // Sentinel after the last scenario in the view.
            var sentinel = document.createElement('div');
            sentinel.className = 'vscroll-sentinel';
            sentinel.setAttribute('aria-hidden', 'true');
            var lastFeature = view.querySelectorAll('.feature-item');
            if (lastFeature.length) {
                var tail = lastFeature[lastFeature.length - 1];
                tail.parentNode.insertBefore(sentinel, tail.nextSibling);
            } else {
                view.appendChild(sentinel);
            }

            applyVisibility();

            var io = new IntersectionObserver(function(entries) {
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].isIntersecting && visible < total && !disabledForSearch) {
                        visible = Math.min(visible + BATCH, total);
                        applyVisibility();
                        if (visible >= total) {
                            io.disconnect();
                            if (sentinel.parentNode) sentinel.parentNode.removeChild(sentinel);
                        }
                    }
                }
            }, { rootMargin: PREFETCH + 'px 0px' });

            io.observe(sentinel);

            // Coordinate with the v1.39.x #test-search filter. When
            // the user is searching, we reveal everything (the search
            // handler will hide non-matches via inline display:none).
            // Clearing the box re-collapses if still above threshold.
            var searchBox = document.getElementById('test-search');
            if (searchBox) {
                searchBox.addEventListener('input', function() {
                    var term = (this.value || '').trim();
                    if (term.length > 0 && !disabledForSearch) {
                        disabledForSearch = true;
                        for (var i = 0; i < scenarios.length; i++) {
                            scenarios[i].classList.remove('vscroll-hidden');
                        }
                        updateBanner();
                    } else if (term.length === 0 && disabledForSearch) {
                        disabledForSearch = false;
                        // Clear any inline display:none set by the search
                        // handler so vscroll-hidden takes back over.
                        for (var j = 0; j < scenarios.length; j++) {
                            scenarios[j].style.display = '';
                        }
                        applyVisibility();
                    }
                });
            }
        })();
        // ─────────────────────────────────────────────────────────────`;
}
