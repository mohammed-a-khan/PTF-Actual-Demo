/**
 * Mobile responsive — Phase 4b (v1.42.1).
 *
 * Today the report has a single breakpoint at 768 px. Below that the
 * dashboard collapses charts to one column, hides the header info,
 * and centres the logo. But the horizontal nav strip still tries to
 * fit ~7 items in a 360 px viewport, the hero/cluster cards stack
 * awkwardly, and the scenario row's right-side detail (duration +
 * toggle icon) wraps below the title.
 *
 * v1.42.1 fixes the phone / small-tablet experience with:
 *
 *   - **Two more breakpoints** at 600 px (small tablet / phablet) and
 *     480 px (phone). Each tightens header padding, hero/cluster card
 *     min-widths, and step-detail layouts.
 *
 *   - **Hamburger nav** that takes over below 600 px. The horizontal
 *     `.nav-container` items collapse into a vertical drawer that
 *     opens / closes from a `☰` button pinned in the header. Auto-
 *     closes when the user picks a view. Esc closes it.
 *
 *   - **Card-friendly tweaks** for the scenario rows: name + status
 *     badge wrap onto their own line; duration + toggle icon ride
 *     underneath; touch targets get bigger (44 px tall) per the
 *     usual mobile-first rule.
 *
 * Three exports plus a small CSS bundle. Theme tokens only — every
 * colour resolves to a `var(--…)` so dark mode + consumer brand
 * overrides flow through unchanged.
 *
 * @module reporter
 */

// ============================================================================
// Hamburger button HTML
// ============================================================================

/**
 * Render the hamburger toggle. Hidden on desktop via CSS; visible at
 * ≤ 600 px. Stays in the DOM at all widths so the JS binding doesn't
 * have to be conditional.
 */
export function renderHamburgerButton(): string {
    return `<button type="button" id="mobile-nav-toggle" class="mobile-nav-toggle"
                    aria-label="Toggle navigation menu"
                    aria-expanded="false" aria-controls="nav-container">
        <span aria-hidden="true">☰</span>
    </button>`;
}

// ============================================================================
// Mobile CSS bundle
// ============================================================================

/**
 * Emit the mobile-specific CSS bundle. Builds on top of the existing
 * `max-width: 768px` block already in `generateEnhancedCSS()`; each
 * new breakpoint here adds *only* the deltas the smaller viewport
 * needs, leaving larger-viewport behaviour untouched.
 */
export function generateMobileCSS(): string {
    return `
    /* v1.42.1 — Phase 4b mobile responsive */

    /* Hamburger button — desktop-hidden, mobile-visible. Lives in
       the header but rendered always; the CSS controls when it
       shows up. */
    .mobile-nav-toggle {
        display: none;
        background: transparent;
        color: inherit;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 6px;
        font-size: 1.4rem;
        line-height: 1;
        padding: 6px 12px;
        cursor: pointer;
        margin-left: 8px;
    }
    .mobile-nav-toggle:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.6);
    }

    /* ── 600 px breakpoint: small tablets / phablets ───────────── */
    @media (max-width: 600px) {
        /* Show the hamburger; collapse the inline nav. */
        .mobile-nav-toggle { display: inline-flex; align-items: center; }

        .nav { padding: 0; }
        .nav-container {
            flex-direction: column;
            display: none;
            background: var(--surface);
            border-top: 1px solid var(--border);
            border-bottom: 1px solid var(--border);
            padding: 4px 0;
        }
        .nav-container.mobile-open { display: flex; }
        .nav-item {
            padding: 14px 18px;
            border-bottom: 1px solid var(--border);
            min-height: 44px;
            display: flex;
            align-items: center;
        }
        .nav-item:last-child { border-bottom: none; }
        .nav-item.active {
            background: var(--surface-hover);
            border-left: 3px solid var(--brand-color);
            padding-left: 15px;
        }

        /* Hero strip + cluster preview: drop min card width so phones
           don't get a single 1-col cramped card. */
        .dash-hero { grid-template-columns: 1fr 1fr; gap: 8px; }
        .dash-hero-card { padding: 10px 12px; }
        .dash-hero-value { font-size: 1.4rem; }

        .dash-cp-grid { grid-template-columns: 1fr; gap: 8px; }
        .dash-cp-card { padding: 10px 12px; }

        /* Scenario header — let the name + badges wrap, and let the
           duration + chevron ride below on a second row. Bigger touch
           target. */
        .scenario-header {
            flex-direction: column;
            align-items: flex-start !important;
            gap: 4px;
            padding: 12px 14px;
            min-height: 44px;
        }
        .scenario-header > div {
            width: 100%;
        }
        .scenario-header > div:last-child {
            justify-content: space-between;
            font-size: 0.86rem;
        }

        /* Status table sub-cards / metric cards: full-width single col. */
        .metric-card-flaky { min-width: 100%; }

        /* Failure-cluster section: more breathing room. */
        .fc-summary { grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
        .fc-summary-num { font-size: 1.2rem; }

        /* Footer line for "DBSCAN parameters" gets too cramped — wrap. */
        .fc-empty, .fc-outlier { font-size: 0.85rem; }
    }

    /* ── 480 px breakpoint: phones ─────────────────────────────── */
    @media (max-width: 480px) {
        .main-content { padding: 0.75rem; }
        .header { height: auto; padding: 8px 12px; }
        .header h1 { font-size: 1.05rem; }
        .header-logo img,
        .header-logo div { width: 140px !important; height: 46px !important; }

        /* Hero: single column on the smallest screens. */
        .dash-hero { grid-template-columns: 1fr; }
        .dash-hero-value { font-size: 1.3rem; }

        /* Stats grid (Total/Passed/Failed/Skipped/PassRate): two
           columns max so each cell stays readable. */
        .stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
        .stat-card { padding: 0.75rem !important; }
        .stat-value { font-size: 1.5rem !important; }

        /* Step tab labels are visual text inside flex containers — let
           the user scroll if needed but cap font so the row fits. */
        .step-tab { font-size: 0.78rem !important; padding: 6px 10px !important; }
        .step-tabs { overflow-x: auto; }

        /* Quarantine banner list wraps tighter. */
        .dash-qb-list { margin-left: 18px; }

        /* Score legend pills wrap and reduce gap to fit two-per-row. */
        .score-legend { gap: 4px; padding: 8px 10px; }
        .legend-item { font-size: 0.72rem !important; }

        /* Failure-cluster summary: stack the three cards vertically
           rather than 3-up. */
        .fc-summary { grid-template-columns: 1fr; }

        /* Modal: take more of the viewport on phones. */
        .modal-content { max-width: 95% !important; max-height: 90vh !important; padding: 12px !important; }

        /* Theme toggle wraps to next line in header-info; reduce its
           padding so it fits beside the date strings. */
        .theme-toggle { padding: 3px 8px; font-size: 0.78rem; }
        .theme-toggle .theme-toggle-mode { font-size: 0.68rem; }
    }

    /* ── 360 px and below: smallest phones, no horizontal scroll ── */
    @media (max-width: 360px) {
        .dash-hero-card { padding: 8px 10px; }
        .dash-hero-value { font-size: 1.15rem; }
        .stat-value { font-size: 1.25rem !important; }
        .header-logo img,
        .header-logo div { width: 120px !important; height: 40px !important; }
    }`;
}

// ============================================================================
// Hamburger JS — toggle + auto-close + Esc
// ============================================================================

/**
 * Runtime JS that wires the hamburger toggle:
 *   - Click `#mobile-nav-toggle` → flips `.mobile-open` on `.nav-container`
 *     + `aria-expanded` on the button itself
 *   - Click any `.nav-item` (mobile drawer is open) → auto-close
 *   - Esc → close if open
 *   - Window resize > 600 px → close (drawer becomes irrelevant)
 *
 * No-op when the toggle button isn't present (e.g. older templates).
 */
export function generateHamburgerJS(): string {
    return `
        // ── v1.42.1 — Mobile hamburger nav ──────────────────────────
        (function() {
            var btn = document.getElementById('mobile-nav-toggle');
            if (!btn) return;
            var nav = document.querySelector('.nav-container');
            if (!nav) return;

            function setOpen(open) {
                if (open) nav.classList.add('mobile-open');
                else nav.classList.remove('mobile-open');
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
            function isOpen() {
                return nav.classList.contains('mobile-open');
            }

            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                setOpen(!isOpen());
            });

            // Auto-close when a nav item is picked.
            nav.querySelectorAll('.nav-item').forEach(function(item) {
                item.addEventListener('click', function() {
                    if (isOpen()) setOpen(false);
                });
            });

            // Esc closes (in addition to the v1.41.0 modal a11y handler,
            // which only fires when a modal is open).
            document.addEventListener('keydown', function(e) {
                if ((e.key === 'Escape' || e.keyCode === 27) && isOpen()) {
                    setOpen(false);
                }
            });

            // If the viewport grows past the mobile breakpoint while
            // the drawer is open, close it — the inline nav resumes.
            var mq;
            try { mq = window.matchMedia('(max-width: 600px)'); } catch (e) { mq = null; }
            if (mq) {
                var onChange = function() {
                    if (!mq.matches && isOpen()) setOpen(false);
                };
                if (typeof mq.addEventListener === 'function') {
                    mq.addEventListener('change', onChange);
                } else if (typeof mq.addListener === 'function') {
                    // Legacy Safari
                    mq.addListener(onChange);
                }
            }
        })();
        // ─────────────────────────────────────────────────────────────`;
}
