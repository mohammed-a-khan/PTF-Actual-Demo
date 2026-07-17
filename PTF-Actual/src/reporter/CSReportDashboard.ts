/**
 * Dashboard renderer — v1.43.2 (tinted-panel KPI grid).
 *
 * v1.43.0 collapsed v1.42.3's three duplicate sections (hero strip +
 * cluster preview + .stats-grid) into one shadcn-style KPI strip.
 * v1.43.1 stripped the "?" hint icons that read as broken chrome.
 * v1.43.2 (this file) replaces the all-neutral KPI strip with TINTED
 * panels: each card has a status-tinted background, a meaningful
 * icon, a large number, and a trend delta vs the previous run.
 *
 * Why
 *   The neutral 6-card strip read as "spreadsheet, not dashboard" —
 *   no visual hierarchy, no signal at a glance, no sense that this
 *   is a failing run. Tinted panels give every card a clear visual
 *   identity:
 *
 *     - Total   : neutral zinc tint   + chart icon  + delta
 *     - Passed  : success-soft tint   + check icon  + delta (↑ good)
 *     - Failed  : danger-soft tint    + x icon      + delta (↑ bad)
 *     - Skipped : neutral zinc tint   + ban icon    + delta
 *     - Rate    : tone-by-threshold   + % icon      + delta
 *     - Time    : neutral zinc tint   + clock icon  + delta
 *
 *   Trend deltas come from the prior history entry — the dashboard
 *   already receives the full ExecutionHistory[] array.
 *
 * Zero-dep
 *   - Icons are inline SVG with currentColor (no font-awesome, no CDN)
 *   - Backgrounds use --cs-*-soft tokens already in CSReportDesign
 *   - color-mix has the @supports fallback
 *
 * @module reporter
 */

import { htmlEscape } from './utils/HtmlSanitizer';

// ============================================================================
// Input
// ============================================================================

export interface DashboardStats {
    totalScenarios: number;
    passedScenarios: number;
    failedScenarios: number;
    skippedScenarios: number;
    passRate: string;          // "0.00" string format from calculateStatistics
    totalDuration: number;     // ms
}

export interface DashboardInput {
    stats: DashboardStats;
    flakyReportData?: any;
    failureClusterData?: any;
    /** Full history array — current run is the LAST entry; we compare it to the entry before. */
    history?: any[];
}

// ============================================================================
// Renderer
// ============================================================================

export function renderDashboard(input: DashboardInput): string {
    const s = input.stats;
    const passRate = parseFloat(s.passRate) || 0;
    const duration = formatDuration(s.totalDuration);
    const prev = previousRun(input.history);

    const stateLine = renderStateLine(s, passRate);

    const cards = [
        renderCard({
            label: 'Total tests',
            value: String(s.totalScenarios),
            tone: 'neutral',
            icon: ICON_CHART,
            hint: 'Total number of scenarios that ran (or were attempted) in this report.',
            delta: prev ? deltaCount(s.totalScenarios, prev.totalScenarios) : null,
            deltaSemantic: 'info',
        }),
        renderCard({
            label: 'Passed',
            value: String(s.passedScenarios),
            tone: 'success',
            icon: ICON_CHECK,
            hint: 'Scenarios that completed without any failed step.',
            delta: prev ? deltaCount(s.passedScenarios, prev.passedScenarios) : null,
            deltaSemantic: 'up-good',
        }),
        renderCard({
            label: 'Failed',
            value: String(s.failedScenarios),
            tone: s.failedScenarios > 0 ? 'danger' : 'neutral',
            icon: ICON_X,
            hint: 'Scenarios where at least one step failed.',
            delta: prev ? deltaCount(s.failedScenarios, prev.failedScenarios) : null,
            deltaSemantic: 'up-bad',
        }),
        renderCard({
            label: 'Skipped',
            value: String(s.skippedScenarios),
            tone: 'neutral',
            icon: ICON_BAN,
            hint: 'Scenarios that did not run — tag filter, @skip annotation, or auto-quarantine.',
            delta: prev ? deltaCount(s.skippedScenarios, prev.skippedScenarios) : null,
            deltaSemantic: 'info',
        }),
        renderCard({
            label: 'Pass rate',
            value: `${passRate}%`,
            tone: passRate >= 95 ? 'success' : passRate >= 75 ? 'warning' : 'danger',
            icon: ICON_PERCENT,
            hint: 'Percent of scenarios that passed. Track this over time to spot drift.',
            delta: prev ? deltaPercent(passRate, prev.passRate ?? 0) : null,
            deltaSemantic: 'up-good',
        }),
        renderCard({
            label: 'Duration',
            value: duration,
            tone: 'neutral',
            icon: ICON_CLOCK,
            hint: 'Total wall-clock time the run took, end to end.',
            delta: prev ? deltaDuration(s.totalDuration, prev.duration ?? 0) : null,
            deltaSemantic: 'up-bad',
        }),
    ];

    const clusterPanel = renderClusterPanel(input.failureClusterData);
    const quarantineBanner = renderQuarantineBanner(input.flakyReportData);

    return `
    <section class="cs-dashboard" aria-label="Test execution summary">
        ${stateLine}
        <div class="cs-dashboard-strip">
            ${cards.join('')}
        </div>
        ${quarantineBanner}
        ${clusterPanel}
    </section>`;
}

// ============================================================================
// State line
// ============================================================================

function renderStateLine(s: DashboardStats, passRate: number): string {
    const failed = s.failedScenarios;
    const skipped = s.skippedScenarios;
    const total = s.totalScenarios;

    let sentence: string;
    let tone: 'success' | 'warning' | 'danger' | 'neutral';

    if (total === 0) {
        sentence = 'No scenarios were executed in this run.';
        tone = 'neutral';
    } else if (failed === 0 && skipped === 0) {
        sentence = `All ${total} scenarios passed.`;
        tone = 'success';
    } else if (failed === 0 && skipped > 0) {
        sentence = `All ${total - skipped} executed scenarios passed; ${skipped} skipped.`;
        tone = 'success';
    } else if (failed === 1) {
        sentence = `1 scenario failed of ${total}${skipped > 0 ? ` (${skipped} skipped)` : ''}.`;
        tone = passRate >= 75 ? 'warning' : 'danger';
    } else {
        sentence = `${failed} scenarios failed of ${total}${skipped > 0 ? ` (${skipped} skipped)` : ''}.`;
        tone = passRate >= 75 ? 'warning' : 'danger';
    }

    const icon = tone === 'success' ? '✓'
               : tone === 'warning' ? '⚠'
               : tone === 'danger'  ? '✕' : '·';

    return `
        <div class="cs-dashboard-state cs-dashboard-state--${tone}">
            <span class="cs-dashboard-state-icon" aria-hidden="true">${icon}</span>
            <span class="cs-dashboard-state-text">${htmlEscape(sentence)}</span>
        </div>`;
}

// ============================================================================
// KPI card
// ============================================================================

interface KpiCardInput {
    label: string;
    value: string;
    tone: 'neutral' | 'success' | 'warning' | 'danger';
    icon: string;       // raw SVG markup
    hint: string;
    delta: DeltaInfo | null;
    /**
     * Tells the renderer how to colour the trend arrow:
     *   up-good : larger value is good  (Passed, Pass rate)
     *   up-bad  : larger value is bad   (Failed, Duration)
     *   info    : neutral, never tinted (Total, Skipped)
     */
    deltaSemantic: 'up-good' | 'up-bad' | 'info';
}

interface DeltaInfo {
    arrow: '↑' | '↓' | '·';
    text: string;       // e.g. "+1", "-2", "+18%", "+12s"
    direction: 'up' | 'down' | 'flat';
}

function renderCard(input: KpiCardInput): string {
    const delta = input.delta
        ? renderDelta(input.delta, input.deltaSemantic)
        : '';
    return `
        <div class="cs-kpi cs-card" data-tone="${input.tone}" title="${attrEsc(input.hint)}">
            <div class="cs-kpi-head">
                <span class="cs-kpi-icon" aria-hidden="true">${input.icon}</span>
                <span class="cs-kpi-label">${htmlEscape(input.label)}</span>
            </div>
            <div class="cs-kpi-value">${htmlEscape(input.value)}</div>
            ${delta}
        </div>`;
}

function renderDelta(d: DeltaInfo, semantic: 'up-good' | 'up-bad' | 'info'): string {
    let cls = 'cs-kpi-delta';
    if (d.direction === 'flat') {
        cls += ' cs-kpi-delta--flat';
    } else if (semantic === 'info') {
        cls += ' cs-kpi-delta--info';
    } else if (semantic === 'up-good') {
        cls += d.direction === 'up' ? ' cs-kpi-delta--good' : ' cs-kpi-delta--bad';
    } else { // up-bad
        cls += d.direction === 'up' ? ' cs-kpi-delta--bad' : ' cs-kpi-delta--good';
    }
    return `<div class="${cls}">
        <span class="cs-kpi-delta-arrow" aria-hidden="true">${d.arrow}</span>
        <span class="cs-kpi-delta-text">${htmlEscape(d.text)}</span>
        <span class="cs-kpi-delta-vs">vs last run</span>
    </div>`;
}

// ============================================================================
// Trend math
// ============================================================================

function previousRun(history: any[] | undefined): any | null {
    if (!Array.isArray(history) || history.length < 2) return null;
    // Current run is the LAST entry (just pushed by loadAndUpdateHistory).
    // The prior run is the one before.
    return history[history.length - 2];
}

function deltaCount(curr: number, prev: number): DeltaInfo {
    const diff = curr - prev;
    if (diff === 0) return { arrow: '·', text: 'same', direction: 'flat' };
    return {
        arrow: diff > 0 ? '↑' : '↓',
        text: (diff > 0 ? '+' : '') + String(diff),
        direction: diff > 0 ? 'up' : 'down',
    };
}

function deltaPercent(curr: number, prev: number): DeltaInfo {
    const diff = curr - prev;
    if (Math.abs(diff) < 0.05) return { arrow: '·', text: 'same', direction: 'flat' };
    const rounded = Math.round(diff * 10) / 10;
    return {
        arrow: diff > 0 ? '↑' : '↓',
        text: (diff > 0 ? '+' : '') + rounded + '%',
        direction: diff > 0 ? 'up' : 'down',
    };
}

function deltaDuration(currMs: number, prevMs: number): DeltaInfo {
    const diff = currMs - prevMs;
    if (Math.abs(diff) < 1000) return { arrow: '·', text: 'same', direction: 'flat' };
    const absSec = Math.round(Math.abs(diff) / 1000);
    const formatted = absSec < 60
        ? `${absSec}s`
        : `${Math.floor(absSec / 60)}m ${(absSec % 60).toString().padStart(2, '0')}s`;
    return {
        arrow: diff > 0 ? '↑' : '↓',
        text: (diff > 0 ? '+' : '−') + formatted,
        direction: diff > 0 ? 'up' : 'down',
    };
}

// ============================================================================
// Icons — inline SVG, theme-coloured via currentColor
// ============================================================================

const ICON_CHART = svg(`<path d="M3 3v18h18" /><path d="M7 14v4M12 9v9M17 4v14"/>`);
const ICON_CHECK = svg(`<path d="M5 12l5 5L20 7"/>`);
const ICON_X     = svg(`<path d="M6 6l12 12M18 6L6 18"/>`);
const ICON_BAN   = svg(`<circle cx="12" cy="12" r="9"/><path d="M5.5 5.5l13 13"/>`);
const ICON_PERCENT = svg(`<path d="M19 5L5 19"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>`);
const ICON_CLOCK = svg(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>`);

function svg(body: string): string {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// ============================================================================
// Failure cluster panel
// ============================================================================

function renderClusterPanel(failureClusterData: any): string {
    if (!failureClusterData) return '';
    const clusters = Array.isArray(failureClusterData.clusters) ? failureClusterData.clusters : [];
    if (clusters.length === 0) return '';

    const rows = clusters.slice(0, 3).map((c: any) => {
        const msg = truncate(String(c.sharedErrorMessage || c.sharedError || 'Unknown error'), 100);
        const size = c.size || 0;
        return `
            <li class="cs-cluster-row">
                <span class="cs-cluster-msg" title="${attrEsc(String(c.sharedErrorMessage || c.sharedError || ''))}">${htmlEscape(msg)}</span>
                <span class="cs-cluster-count" aria-label="${size} matching tests">${size}</span>
            </li>`;
    }).join('');

    const more = clusters.length > 3
        ? `<a class="cs-cluster-more" href="#failure-clusters">View all ${clusters.length} clusters →</a>`
        : '';

    return `
        <div class="cs-cluster-panel cs-card">
            <h3 class="cs-cluster-title" title="Distinct error patterns. Fixing the largest cluster usually unblocks the most tests at once.">
                Top failure clusters
            </h3>
            <ul class="cs-cluster-list">${rows}</ul>
            ${more}
        </div>`;
}

// ============================================================================
// Quarantine banner
// ============================================================================

function renderQuarantineBanner(flakyReportData: any): string {
    if (!Array.isArray(flakyReportData)) return '';
    const quarantined = flakyReportData.filter((t: any) =>
        t && t.recommendation === 'quarantine');
    if (quarantined.length === 0) return '';

    const names = quarantined.slice(0, 3)
        .map((t: any) => `<li>${htmlEscape(t.testName || t.testId || 'unknown')}</li>`)
        .join('');
    const more = quarantined.length > 3
        ? `<li class="cs-quarantine-more">…and ${quarantined.length - 3} more</li>`
        : '';

    return `
        <div class="cs-quarantine cs-card" role="status" data-tone="warning">
            <div class="cs-quarantine-head">
                <span class="cs-quarantine-icon" aria-hidden="true">⛔</span>
                <strong>${quarantined.length} test${quarantined.length === 1 ? '' : 's'} auto-skipped this run</strong>
                <span class="cs-quarantine-hint">— historical flakiness above the configured threshold</span>
            </div>
            <ul class="cs-quarantine-list">${names}${more}</ul>
        </div>`;
}

// ============================================================================
// CSS bundle
// ============================================================================

export function generateDashboardCSS(): string {
    return `
    /* v1.43.2 — tinted-panel KPI grid */

    .cs-dashboard {
        margin-bottom: var(--cs-space-6);
    }

    /* ── State line ────────────────────────────────────────────── */
    .cs-dashboard-state {
        display: inline-flex;
        align-items: center;
        gap: var(--cs-space-2);
        padding: var(--cs-space-2) var(--cs-space-4);
        background: var(--cs-bg-subtle, var(--surface-hover, var(--cs-zinc-100)));
        border: 1px solid var(--border);
        border-radius: var(--cs-radius-full);
        font-size: var(--cs-text-sm);
        font-weight: var(--cs-weight-medium);
        color: var(--text-secondary);
        margin-bottom: var(--cs-space-4);
    }
    .cs-dashboard-state-icon {
        display: inline-flex; width: 18px; height: 18px;
        align-items: center; justify-content: center;
        border-radius: var(--cs-radius-full);
        font-size: var(--cs-text-xs);
        font-weight: var(--cs-weight-bold);
    }
    .cs-dashboard-state--success { color: var(--success-color); }
    .cs-dashboard-state--success .cs-dashboard-state-icon { background: var(--cs-success-soft); color: var(--success-color); }
    .cs-dashboard-state--warning { color: var(--warning-color); }
    .cs-dashboard-state--warning .cs-dashboard-state-icon { background: var(--cs-warning-soft); color: var(--warning-color); }
    .cs-dashboard-state--danger  { color: var(--danger-color); }
    .cs-dashboard-state--danger  .cs-dashboard-state-icon { background: var(--cs-danger-soft); color: var(--danger-color); }
    .cs-dashboard-state--neutral .cs-dashboard-state-icon { background: var(--cs-zinc-200); color: var(--cs-zinc-600); }

    /* ── KPI strip — tinted panels ─────────────────────────────── */
    .cs-dashboard-strip {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--cs-space-3);
        margin-bottom: var(--cs-space-4);
    }
    .cs-kpi {
        position: relative;
        padding: var(--cs-space-4) var(--cs-space-5);
        padding-left: calc(var(--cs-space-5) - 3px); /* compensate for 4px left bar */
        margin-bottom: 0;
        border-left-width: 4px;
        border-left-style: solid;
        transition: transform var(--cs-dur-fast) var(--cs-ease),
                    box-shadow var(--cs-dur-fast) var(--cs-ease);
        display: flex;
        flex-direction: column;
        gap: var(--cs-space-2);
    }
    .cs-kpi:hover {
        transform: translateY(-1px);
        box-shadow: var(--cs-shadow-md);
    }

    /* Tinted backgrounds + matching left-edge accent bar per tone */
    .cs-kpi[data-tone="neutral"] {
        background: var(--cs-zinc-50);
        border-left-color: var(--cs-zinc-400);
    }
    .cs-kpi[data-tone="success"] {
        background: var(--cs-success-soft);
        border-color: color-mix(in oklab, var(--success-color) 25%, var(--border));
        border-left-color: var(--success-color);
    }
    .cs-kpi[data-tone="warning"] {
        background: var(--cs-warning-soft);
        border-color: color-mix(in oklab, var(--warning-color) 25%, var(--border));
        border-left-color: var(--warning-color);
    }
    .cs-kpi[data-tone="danger"] {
        background: var(--cs-danger-soft);
        border-color: color-mix(in oklab, var(--danger-color) 25%, var(--border));
        border-left-color: var(--danger-color);
    }
    @supports not (background: color-mix(in oklab, red 50%, blue)) {
        .cs-kpi[data-tone="success"] { border-color: rgba(16, 185, 129, 0.30); border-left-color: var(--success-color); }
        .cs-kpi[data-tone="warning"] { border-color: rgba(217, 119, 6, 0.30); border-left-color: var(--warning-color); }
        .cs-kpi[data-tone="danger"]  { border-color: rgba(220, 38, 38, 0.30); border-left-color: var(--danger-color); }
    }

    /* Head row: icon + label */
    .cs-kpi-head {
        display: flex;
        align-items: center;
        gap: var(--cs-space-2);
    }
    .cs-kpi-icon {
        display: inline-flex;
        width: 28px; height: 28px;
        align-items: center; justify-content: center;
        border-radius: var(--cs-radius-md);
        background: rgba(255, 255, 255, 0.55);
        color: var(--text-secondary);
    }
    .cs-kpi-icon svg { width: 16px; height: 16px; }
    .cs-kpi[data-tone="success"] .cs-kpi-icon { color: var(--success-color); }
    .cs-kpi[data-tone="warning"] .cs-kpi-icon { color: var(--warning-color); }
    .cs-kpi[data-tone="danger"]  .cs-kpi-icon { color: var(--danger-color); }

    .cs-kpi-label {
        font-size: var(--cs-text-xs);
        font-weight: var(--cs-weight-semibold);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
    }
    .cs-kpi[data-tone="success"] .cs-kpi-label { color: color-mix(in oklab, var(--success-color) 75%, var(--text-primary)); }
    .cs-kpi[data-tone="warning"] .cs-kpi-label { color: color-mix(in oklab, var(--warning-color) 75%, var(--text-primary)); }
    .cs-kpi[data-tone="danger"]  .cs-kpi-label { color: color-mix(in oklab, var(--danger-color) 75%, var(--text-primary)); }

    .cs-kpi-value {
        font-size: var(--cs-text-3xl);
        font-weight: var(--cs-weight-bold);
        line-height: var(--cs-lh-tight);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
    }
    .cs-kpi[data-tone="success"] .cs-kpi-value { color: var(--success-color); }
    .cs-kpi[data-tone="warning"] .cs-kpi-value { color: var(--warning-color); }
    .cs-kpi[data-tone="danger"]  .cs-kpi-value { color: var(--danger-color); }

    /* Trend delta line */
    .cs-kpi-delta {
        display: flex;
        align-items: baseline;
        gap: 4px;
        font-size: var(--cs-text-xs);
        font-weight: var(--cs-weight-medium);
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
    }
    .cs-kpi-delta-arrow {
        font-weight: var(--cs-weight-bold);
        font-size: var(--cs-text-sm);
    }
    .cs-kpi-delta-vs {
        opacity: 0.7;
        font-weight: var(--cs-weight-normal);
        margin-left: 2px;
    }
    .cs-kpi-delta--good { color: var(--success-color); }
    .cs-kpi-delta--bad  { color: var(--danger-color); }
    .cs-kpi-delta--info { color: var(--text-secondary); }
    .cs-kpi-delta--flat { color: var(--text-secondary); opacity: 0.75; }

    /* ── Quarantine banner ─────────────────────────────────────── */
    .cs-quarantine {
        padding: var(--cs-space-3) var(--cs-space-4);
        background: var(--cs-warning-soft);
        border-color: color-mix(in oklab, var(--warning-color) 30%, var(--border));
    }
    @supports not (background: color-mix(in oklab, red 50%, blue)) {
        .cs-quarantine { border-color: rgba(217, 119, 6, 0.30); }
    }
    .cs-quarantine-head {
        display: flex; align-items: center; gap: var(--cs-space-2);
        margin-bottom: var(--cs-space-2);
        font-size: var(--cs-text-sm); color: var(--text-primary);
    }
    .cs-quarantine-icon { font-size: var(--cs-text-base); }
    .cs-quarantine-hint { color: var(--text-secondary); font-weight: var(--cs-weight-normal); }
    .cs-quarantine-list {
        list-style: none; margin: 0; padding: 0 0 0 var(--cs-space-6);
        font-size: var(--cs-text-sm); color: var(--text-secondary);
    }
    .cs-quarantine-list li { padding: 2px 0; }
    .cs-quarantine-more { font-style: italic; opacity: 0.8; }

    /* ── Failure cluster panel ─────────────────────────────────── */
    .cs-cluster-panel { padding: var(--cs-space-4) var(--cs-space-5); }
    .cs-cluster-title {
        margin: 0 0 var(--cs-space-3);
        font-size: var(--cs-text-base);
        font-weight: var(--cs-weight-semibold);
        color: var(--text-primary);
        display: flex; align-items: center; gap: var(--cs-space-2);
    }
    .cs-cluster-list {
        list-style: none; margin: 0 0 var(--cs-space-2); padding: 0;
        display: flex; flex-direction: column;
        gap: var(--cs-space-1\\.5);
    }
    .cs-cluster-row {
        display: grid; grid-template-columns: 1fr auto;
        align-items: center; gap: var(--cs-space-3);
        padding: var(--cs-space-2) 0;
        border-bottom: 1px solid var(--cs-border-subtle, var(--border));
        font-size: var(--cs-text-sm);
    }
    .cs-cluster-row:last-child { border-bottom: none; }
    .cs-cluster-msg {
        color: var(--text-primary);
        font-family: var(--cs-font-mono);
        font-size: var(--cs-text-xs);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cs-cluster-count {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 24px; padding: 2px var(--cs-space-2);
        border-radius: var(--cs-radius-full);
        background: var(--cs-danger-soft); color: var(--danger-color);
        font-size: var(--cs-text-xs);
        font-weight: var(--cs-weight-semibold);
        font-variant-numeric: tabular-nums;
    }
    .cs-cluster-more {
        display: inline-block;
        margin-top: var(--cs-space-2);
        font-size: var(--cs-text-sm);
        color: var(--brand-text, var(--brand-color));
        text-decoration: none;
    }
    .cs-cluster-more:hover { text-decoration: underline; }

    /* ── Tests-tab toolbar — chip filters + search (v1.43.3) ───── */
    .cs-tests-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--cs-space-3);
        padding: var(--cs-space-3) var(--cs-space-4);
        margin: var(--cs-space-4) 0;
        background: var(--cs-bg-subtle, var(--surface-hover, var(--cs-zinc-50)));
        border: 1px solid var(--border);
        border-radius: var(--cs-radius-lg);
    }
    .cs-tests-filter-group {
        display: inline-flex;
        gap: var(--cs-space-1);
        background: var(--surface, white);
        border: 1px solid var(--border);
        border-radius: var(--cs-radius-full);
        padding: 3px;
    }
    .cs-tests-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--cs-space-1);
        padding: 6px var(--cs-space-3);
        font-family: inherit;
        font-size: var(--cs-text-sm);
        font-weight: var(--cs-weight-medium);
        color: var(--text-secondary);
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--cs-radius-full);
        cursor: pointer;
        transition: background var(--cs-dur-fast) var(--cs-ease),
                    color var(--cs-dur-fast) var(--cs-ease);
    }
    .cs-tests-chip:hover {
        background: var(--surface-hover, var(--cs-zinc-100));
        color: var(--text-primary);
    }
    .cs-tests-chip:focus-visible {
        outline: 2px solid var(--brand-color);
        outline-offset: 2px;
    }
    .cs-tests-chip--active {
        background: var(--text-primary);
        color: var(--surface, white);
    }
    .cs-tests-chip--active:hover {
        background: var(--text-primary);
        color: var(--surface, white);
    }
    .cs-tests-chip-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: var(--cs-radius-full);
        flex-shrink: 0;
    }
    .cs-tests-chip-dot[data-status="passed"]  { background: var(--success-color); }
    .cs-tests-chip-dot[data-status="failed"]  { background: var(--danger-color); }
    .cs-tests-chip-dot[data-status="skipped"] { background: var(--cs-zinc-400); }
    .cs-tests-chip-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        height: 20px;
        padding: 0 6px;
        background: var(--cs-zinc-200);
        color: var(--text-secondary);
        font-size: var(--cs-text-xs);
        font-weight: var(--cs-weight-semibold);
        border-radius: var(--cs-radius-full);
        font-variant-numeric: tabular-nums;
    }
    .cs-tests-chip--active .cs-tests-chip-count {
        background: rgba(255, 255, 255, 0.15);
        color: var(--surface, white);
    }
    .cs-tests-search-wrap {
        position: relative;
        flex: 1;
        min-width: 240px;
        display: flex;
        align-items: center;
        gap: var(--cs-space-2);
    }
    .cs-tests-search-icon {
        position: absolute;
        left: var(--cs-space-3);
        top: 50%;
        transform: translateY(-50%);
        width: 16px;
        height: 16px;
        color: var(--text-secondary);
        pointer-events: none;
        display: inline-flex;
    }
    .cs-tests-search-icon svg { width: 16px; height: 16px; }
    .cs-tests-search {
        flex: 1;
        height: 36px;
        padding: 0 var(--cs-space-3) 0 calc(var(--cs-space-3) + 20px);
        font-family: inherit;
        font-size: var(--cs-text-sm);
        color: var(--text-primary);
        background: var(--surface, white);
        border: 1px solid var(--border);
        border-radius: var(--cs-radius-md);
        transition: border-color var(--cs-dur-fast) var(--cs-ease),
                    box-shadow var(--cs-dur-fast) var(--cs-ease);
    }
    .cs-tests-search::placeholder { color: var(--text-secondary); opacity: 0.7; }
    .cs-tests-search:focus {
        outline: none;
        border-color: var(--brand-color);
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--brand-color) 20%, transparent);
    }
    @supports not (box-shadow: 0 0 0 3px color-mix(in oklab, red 20%, transparent)) {
        .cs-tests-search:focus { box-shadow: 0 0 0 3px rgba(77, 0, 77, 0.20); }
    }
    .cs-tests-empty {
        margin-left: var(--cs-space-3);
        font-size: var(--cs-text-sm);
        color: var(--text-secondary);
        font-style: italic;
    }

    @media (max-width: 700px) {
        .cs-tests-toolbar { flex-direction: column; align-items: stretch; }
        .cs-tests-filter-group { width: 100%; justify-content: space-between; }
        .cs-tests-search-wrap { width: 100%; min-width: 0; }
    }

    /* ── Per-step Files tab (v1.43.4) ──────────────────────────── */
    .cs-step-tab-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 6px;
        margin-left: 4px;
        background: var(--cs-zinc-200);
        color: var(--text-secondary);
        font-size: 0.7rem;
        font-weight: var(--cs-weight-semibold);
        border-radius: var(--cs-radius-full);
        font-variant-numeric: tabular-nums;
    }
    .cs-step-files {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .cs-step-file {
        display: flex;
        align-items: center;
        gap: var(--cs-space-2);
        padding: 8px 12px;
        background: var(--surface, white);
        border: 1px solid var(--border);
        border-left-width: 4px;
        border-radius: var(--cs-radius-md);
        font-size: var(--cs-text-sm);
        transition: border-color var(--cs-dur-fast) var(--cs-ease),
                    box-shadow var(--cs-dur-fast) var(--cs-ease);
    }
    .cs-step-file[data-kind="download"] { border-left-color: var(--success-color); }
    .cs-step-file[data-kind="upload"]   { border-left-color: var(--brand-color, #4d004d); }
    .cs-step-file:hover {
        box-shadow: var(--cs-shadow-sm);
    }
    .cs-step-file-icon { font-size: 1.05em; }
    .cs-step-file-kind {
        font-size: 0.7rem;
        font-weight: var(--cs-weight-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 2px 8px;
        border-radius: var(--cs-radius-full);
        background: var(--cs-zinc-100);
        color: var(--text-secondary);
    }
    .cs-step-file[data-kind="download"] .cs-step-file-kind { background: var(--cs-success-soft); color: var(--success-color); }
    .cs-step-file[data-kind="upload"]   .cs-step-file-kind { background: var(--cs-brand-soft, color-mix(in oklab, var(--brand-color, #4d004d) 12%, transparent)); color: var(--brand-color, #4d004d); }
    .cs-step-file-link {
        color: var(--text-primary);
        text-decoration: none;
        font-weight: var(--cs-weight-medium);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .cs-step-file-link:hover { color: var(--brand-color, #4d004d); text-decoration: underline; }
    .cs-step-file-size, .cs-step-file-time {
        color: var(--text-secondary);
        font-size: var(--cs-text-xs);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }

    /* Dark-mode tint adjustment — soft tokens already re-bind in CSReportDesign,
       but the white icon backdrop needs to flip. */
    [data-theme="dark"] .cs-kpi-icon { background: rgba(255, 255, 255, 0.06); }
    [data-theme="dark"] .cs-kpi[data-tone="neutral"] { background: rgba(255, 255, 255, 0.025); }

    /* ── Responsive collapses ──────────────────────────────────── */
    @media (max-width: 1100px) {
        .cs-dashboard-strip { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 700px) {
        .cs-dashboard-strip { grid-template-columns: repeat(2, 1fr); }
        .cs-kpi-value { font-size: var(--cs-text-2xl); }
    }
    @media (max-width: 480px) {
        .cs-dashboard-strip { grid-template-columns: 1fr; }
    }`;
}

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return `${min}m ${sec.toString().padStart(2, '0')}s`;
    const hr = Math.floor(min / 60);
    const m = min % 60;
    return `${hr}h ${m.toString().padStart(2, '0')}m`;
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function attrEsc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
