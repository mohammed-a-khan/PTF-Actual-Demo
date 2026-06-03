/**
 * Dashboard hero — Phase 2 of the HTML-report modernization plan.
 *
 * Three small pure functions that the dashboard view calls *first*,
 * before any totals or charts. Goal: make "what broke" the thing the
 * reader sees in the first five seconds, instead of buried two clicks
 * deep on the Tests view.
 *
 * - `generateAttentionHero` — single row of stat cards keyed on the
 *   things a tester actually wants to know after a run: how long it
 *   took, how many failed, how many are flaky, how many were
 *   quarantined. Sits above the existing totals strip.
 *
 * - `generateQuarantineBanner` — amber banner naming the tests the
 *   runner skipped this run due to `FLAKY_QUARANTINE_THRESHOLD`.
 *   Rendered only when something was actually quarantined.
 *
 * - `generateClusterPreview` — compact "top causes" block showing the
 *   three largest failure clusters (already computed by
 *   `CSFailureClusterer`) with member counts and the first matching
 *   scenarios. Links to the full Failure Clusters view.
 *
 * - `generateDashboardHeroCSS` — the CSS bundle for all three. The
 *   CSS uses only the theme tokens shipped in v1.40.0 / v1.40.1, so
 *   consumer brand overrides flow through.
 *
 * Every renderer returns `''` when its data is empty, so the
 * dashboard layout doesn't get padded with stale "Nothing to see
 * here" cards on clean runs.
 *
 * @module reporter
 */

import { htmlEscape } from './utils/HtmlSanitizer';

// ============================================================================
// Hero — "needs attention" stats row
// ============================================================================

export interface HeroInput {
    /** Total elapsed wall-clock for the run, in ms. */
    durationMs: number;
    /** Number of failed scenarios. */
    failed: number;
    /** Number of flaky scenarios — enriched data from `collectFlakyData`. */
    flakyReportData?: any;
    /** Failure-cluster report from `collectFailureClusters`. */
    failureClusterData?: any;
}

/**
 * Render the hero strip. Always shows runtime + failed count; flaky
 * + quarantined + cluster counts only when their underlying data
 * exists. When the run is clean (no failures, no flakies, no
 * quarantines, no clusters), the hero collapses to runtime + a green
 * "All clear" pill.
 */
export function generateAttentionHero(input: HeroInput): string {
    const failed = input.failed;
    const { flakyCount, quarantineCount } = countFlakyStates(input.flakyReportData);
    const clusterCount = input.failureClusterData?.clusterCount || 0;
    const needsAttention = failed + flakyCount + quarantineCount;

    const cards: string[] = [];

    cards.push(card({
        label: 'Run time',
        value: formatDuration(input.durationMs),
        tone: 'neutral',
        icon: '⏱️',
    }));

    if (needsAttention === 0) {
        cards.push(card({
            label: 'Needs attention',
            value: '0',
            tone: 'success',
            icon: '✅',
            sub: 'All clear',
        }));
    } else {
        cards.push(card({
            label: 'Needs attention',
            value: String(needsAttention),
            tone: 'danger',
            icon: '⚠️',
            sub: failed + ' failed' + (flakyCount ? ', ' + flakyCount + ' flaky' : '') +
                 (quarantineCount ? ', ' + quarantineCount + ' quarantined' : ''),
        }));
    }

    if (failed > 0) {
        cards.push(card({
            label: 'Failed',
            value: String(failed),
            tone: 'danger',
            icon: '✕',
            sub: clusterCount > 0
                ? clusterCount + ' likely root cause' + (clusterCount === 1 ? '' : 's')
                : undefined,
        }));
    }

    if (flakyCount > 0) {
        cards.push(card({
            label: 'Flaky',
            value: String(flakyCount),
            tone: 'warning',
            icon: '🌀',
            sub: 'Inconsistent across recent runs',
        }));
    }

    if (quarantineCount > 0) {
        cards.push(card({
            label: 'Quarantined',
            value: String(quarantineCount),
            tone: 'severe',
            icon: '⛔',
            sub: 'Auto-skipped this run',
        }));
    }

    return `<div class="dash-hero" data-attention-count="${needsAttention}">${cards.join('')}</div>`;
}

// ============================================================================
// Quarantine banner
// ============================================================================

/**
 * One-row amber banner naming the tests the runner skipped this run
 * because their flakiness score crossed `FLAKY_QUARANTINE_THRESHOLD`.
 * Returns `''` when nothing is quarantined.
 */
export function generateQuarantineBanner(flakyReportData: any): string {
    if (!Array.isArray(flakyReportData)) return '';
    const quarantined = flakyReportData.filter((t: any) =>
        t && t.recommendation === 'quarantine');
    if (quarantined.length === 0) return '';

    const first = quarantined.slice(0, 5)
        .map((t: any) => `<li>${htmlEscape(t.testName || t.testId || '<unknown>')}</li>`)
        .join('');
    const overflow = quarantined.length > 5
        ? `<li class="dash-qb-more">…and ${quarantined.length - 5} more</li>`
        : '';

    return `
    <div class="dash-quarantine-banner" role="status" aria-live="polite">
        <div class="dash-qb-head">
            <span class="dash-qb-icon">⛔</span>
            <strong>${quarantined.length} test${quarantined.length === 1 ? '' : 's'} quarantined this run</strong>
            <span class="dash-qb-hint">— historical flakiness exceeded the configured threshold; these were auto-skipped.</span>
        </div>
        <ul class="dash-qb-list">${first}${overflow}</ul>
    </div>`;
}

// ============================================================================
// Cluster preview — "top causes" block
// ============================================================================

/**
 * Compact preview of the largest failure clusters. Shows up to three
 * clusters; each card lists the shared error message (truncated), the
 * member count, and the first two matching scenarios. Empty string
 * when clustering produced nothing.
 */
export function generateClusterPreview(failureClusterData: any): string {
    if (!failureClusterData) return '';
    const clusters = Array.isArray(failureClusterData.clusters) ? failureClusterData.clusters : [];
    if (clusters.length === 0) return '';

    const top = clusters.slice(0, 3);
    const overflow = clusters.length - top.length;

    const cards = top.map((c: any) => {
        const msg = truncate(String(c.sharedErrorMessage || ''), 160);
        const members = Array.isArray(c.members) ? c.members.slice(0, 2) : [];
        const memberList = members.map((m: any) =>
            `<li><span class="dash-cp-test">${htmlEscape(m.testName || m.testId || '<unknown>')}</span>` +
            (m.featureFile ? ` <span class="dash-cp-file">${htmlEscape(m.featureFile)}</span>` : '') +
            `</li>`).join('');
        const extra = (c.size - members.length) > 0
            ? `<li class="dash-cp-more">…and ${c.size - members.length} more in this cluster</li>`
            : '';
        return `
        <div class="dash-cp-card">
            <div class="dash-cp-head">
                <span class="dash-cp-pill">${c.size} failure${c.size === 1 ? '' : 's'}</span>
                <span class="dash-cp-title">Cluster #${c.id}</span>
            </div>
            <div class="dash-cp-msg">${htmlEscape(msg)}</div>
            <ul class="dash-cp-members">${memberList}${extra}</ul>
        </div>`;
    }).join('');

    const footer = overflow > 0
        ? `<div class="dash-cp-footer"><a href="#failure-clusters" class="dash-cp-link">View all ${clusters.length} clusters →</a></div>`
        : `<div class="dash-cp-footer"><a href="#failure-clusters" class="dash-cp-link">Full cluster breakdown →</a></div>`;

    return `
    <section class="dash-cluster-preview">
        <h3 class="dash-cp-section-title">🧩 Top likely causes</h3>
        <div class="dash-cp-grid">${cards}</div>
        ${footer}
    </section>`;
}

// ============================================================================
// Per-row health badge (v1.40.3)
// ============================================================================

/**
 * Find the enriched flaky-detector record for a given scenario name.
 * Returns `null` when there is no flaky data, when no entry matches,
 * or when the matching entry's score is `-1` (a brand-new test the
 * detector hasn't seen before — we deliberately *don't* badge those
 * to avoid polluting every test row in a first-run repo).
 *
 * The match is on `testName` first, falling back to `testId`, which
 * mirrors `collectFlakyData`'s own lookup.
 */
export function lookupScenarioHealth(scenarioName: string, flakyReportData: any): any {
    if (!scenarioName || !Array.isArray(flakyReportData)) return null;
    const found = flakyReportData.find((t: any) =>
        t && (t.testName === scenarioName || t.testId === scenarioName));
    if (!found) return null;
    if (typeof found.score === 'number' && found.score < 0) return null;
    return found;
}

/**
 * Render an inline health pill for a scenario row. Returns `''` when
 * the scenario has no usable flaky data (new tests, no detector, etc.)
 * so the row stays clean. The pill itself uses the same `--health-*`
 * theme tokens as the flaky-section badges so consumer overrides flow
 * through here too.
 *
 * The `title` attribute exposes the underlying score + recommendation
 * for hover tooltips and screen-reader announcement.
 */
export function renderScenarioHealthBadge(scenarioName: string, flakyReportData: any): string {
    const found = lookupScenarioHealth(scenarioName, flakyReportData);
    if (!found || !found.health) return '';
    const h = found.health;
    const cssClass = String(h.cssClass || 'health-unknown');
    const label = String(h.label || 'Unknown');
    const icon = String(h.icon || '');
    const score = typeof found.score === 'number' ? found.score : null;
    const reco = found.recommendation && found.recommendation !== 'none'
        ? ` · ${found.recommendation}` : '';
    const titleText = score !== null
        ? `Health: ${label} (score ${score}${reco})`
        : `Health: ${label}${reco}`;
    return `<span class="row-health-pill ${cssClass}" `
         + `style="background:${h.bgColor};color:${h.color}" `
         + `title="${attrEsc(titleText)}" `
         + `aria-label="${attrEsc(titleText)}">`
         + `${icon} ${htmlEscape(label)}</span>`;
}

function attrEsc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================
// CSS bundle
// ============================================================================

export function generateDashboardHeroCSS(): string {
    return `
    /* v1.40.2 — Phase 2 failure-first dashboard */

    .dash-hero {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 12px;
        margin-bottom: 18px;
    }
    .dash-hero-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px 16px;
        position: relative;
        overflow: hidden;
    }
    .dash-hero-card::before {
        content: '';
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 4px;
        background: var(--brand-color-light);
    }
    .dash-hero-card.tone-success::before { background: var(--success-color); }
    .dash-hero-card.tone-warning::before { background: var(--warning-color); }
    .dash-hero-card.tone-danger::before  { background: var(--danger-color); }
    .dash-hero-card.tone-severe::before  { background: var(--health-toxic-fg); }
    .dash-hero-card.tone-neutral::before { background: var(--brand-color-light); }

    .dash-hero-row { display: flex; align-items: baseline; gap: 8px; }
    .dash-hero-icon { font-size: 1.1rem; }
    .dash-hero-label { font-size: 0.78rem; color: var(--text-secondary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; }
    .dash-hero-value { font-size: 1.7rem; font-weight: 700; color: var(--text-primary); line-height: 1.1; margin-top: 2px; }
    .dash-hero-sub   { font-size: 0.74rem; color: var(--text-secondary); margin-top: 4px; }

    .dash-hero-card.tone-success .dash-hero-value { color: var(--success-color); }
    .dash-hero-card.tone-warning .dash-hero-value { color: var(--warning-color); }
    .dash-hero-card.tone-danger  .dash-hero-value { color: var(--danger-color); }
    .dash-hero-card.tone-severe  .dash-hero-value { color: var(--health-toxic-fg); }

    .dash-quarantine-banner {
        background: var(--health-shaky-bg);
        border: 1px solid var(--warning-color);
        border-left: 4px solid var(--warning-color);
        border-radius: 8px;
        padding: 12px 16px;
        margin-bottom: 16px;
        color: var(--text-primary);
    }
    .dash-qb-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
    .dash-qb-icon { font-size: 1.1rem; }
    .dash-qb-hint { color: var(--text-secondary); font-size: 0.88rem; }
    .dash-qb-list {
        margin: 8px 0 0 32px; padding: 0; font-size: 0.88rem; color: var(--text-secondary);
    }
    .dash-qb-list li { padding: 2px 0; }
    .dash-qb-more { font-style: italic; color: var(--text-secondary); }

    .dash-cluster-preview { margin: 18px 0 22px; }
    .dash-cp-section-title {
        font-size: 1rem; font-weight: 700; color: var(--text-primary);
        margin: 0 0 10px; display: flex; align-items: center; gap: 8px;
    }
    .dash-cp-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 12px;
    }
    .dash-cp-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-left: 4px solid var(--danger-color);
        border-radius: 10px;
        padding: 12px 14px;
    }
    .dash-cp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .dash-cp-pill {
        background: var(--danger-color); color: #fff;
        font-size: 0.72rem; font-weight: 700;
        padding: 2px 8px; border-radius: 999px;
    }
    .dash-cp-title { font-weight: 700; color: var(--text-primary); }
    .dash-cp-msg {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.78rem; color: var(--text-secondary);
        background: var(--surface-hover);
        padding: 6px 8px; border-radius: 6px;
        white-space: pre-wrap; word-break: break-word;
        margin-bottom: 8px;
    }
    .dash-cp-members { list-style: none; padding: 0; margin: 0; font-size: 0.82rem; }
    .dash-cp-members li { padding: 2px 0; }
    .dash-cp-test { font-weight: 600; color: var(--text-primary); }
    .dash-cp-file { color: var(--text-secondary); font-size: 0.74rem; margin-left: 4px; }
    .dash-cp-more { color: var(--text-secondary); font-style: italic; }
    .dash-cp-footer { margin-top: 10px; text-align: right; }
    .dash-cp-link { color: var(--brand-color); font-weight: 600; text-decoration: none; font-size: 0.86rem; }
    .dash-cp-link:hover { text-decoration: underline; }

    /* v1.40.3 — per-row health pill in the Tests view */
    .row-health-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 600;
        margin-left: 6px;
        vertical-align: middle;
        line-height: 1.6;
        white-space: nowrap;
    }
    .row-health-pill.health-solid,
    .row-health-pill.health-stable {
        background: var(--health-solid-bg) !important;
        color: var(--health-solid-fg) !important;
    }
    .row-health-pill.health-shaky {
        background: var(--health-shaky-bg) !important;
        color: var(--health-shaky-fg) !important;
    }
    .row-health-pill.health-flaky {
        background: var(--health-flaky-bg) !important;
        color: var(--health-flaky-fg) !important;
    }
    .row-health-pill.health-broken {
        background: var(--health-broken-bg) !important;
        color: var(--health-broken-fg) !important;
    }
    .row-health-pill.health-toxic {
        background: var(--health-toxic-bg) !important;
        color: var(--health-toxic-fg) !important;
    }
    .row-health-pill.health-new {
        background: var(--health-new-bg) !important;
        color: var(--health-new-fg) !important;
    }`;
}

// ============================================================================
// Helpers
// ============================================================================

function card(opts: { label: string; value: string; tone: 'success'|'warning'|'danger'|'severe'|'neutral'; icon: string; sub?: string }): string {
    return `
    <div class="dash-hero-card tone-${opts.tone}">
        <div class="dash-hero-row">
            <span class="dash-hero-icon">${opts.icon}</span>
            <span class="dash-hero-label">${htmlEscape(opts.label)}</span>
        </div>
        <div class="dash-hero-value">${htmlEscape(opts.value)}</div>
        ${opts.sub ? `<div class="dash-hero-sub">${htmlEscape(opts.sub)}</div>` : ''}
    </div>`;
}

/** Count flaky + quarantined tests from the enriched flaky report. */
function countFlakyStates(flakyReportData: any): { flakyCount: number; quarantineCount: number } {
    if (!Array.isArray(flakyReportData)) return { flakyCount: 0, quarantineCount: 0 };
    let flakyCount = 0;
    let quarantineCount = 0;
    for (const t of flakyReportData) {
        if (!t || typeof t.score !== 'number') continue;
        // -1 == new (no history); 0..10 = stable. 11+ is meaningfully flaky.
        if (t.score >= 11) flakyCount++;
        if (t.recommendation === 'quarantine') quarantineCount++;
    }
    return { flakyCount, quarantineCount };
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const totalSeconds = Math.floor(ms / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    if (mins === 0) return `${secs}s`;
    if (mins < 60) return `${mins}m ${secs.toString().padStart(2, '0')}s`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours}h ${remMins.toString().padStart(2, '0')}m`;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}
