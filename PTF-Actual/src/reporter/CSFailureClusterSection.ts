/**
 * CSFailureClusterSection - Failure clusters section for the HTML report.
 *
 * Renders the end-of-run grouping of failures by likely root cause,
 * produced by `CSFailureClusterer.cluster()`. Plugs into the main
 * HTML report the same way `CSFlakyReportSection` does — four
 * exports: `collect*`, `generate*CSS`, `generate*NavItem`,
 * `generate*Section`.
 *
 * The section is only rendered when the clusterer is enabled AND the
 * report has at least one cluster (or outlier). Suites that never
 * fail produce no section.
 *
 * Intelligence on display:
 *   - "12 failures → 3 likely causes" headline
 *   - Per cluster: size, shared error snippet, shared stack frames,
 *     and the full member list with feature-file paths
 *   - Outliers shown separately so unique failures still surface
 */

import { htmlEscape } from './utils/HtmlSanitizer';
import type { FailureClusterReport, FailureCluster } from '../clustering/CSFailureClusterTypes';

// =====================================================================
// Public API
// =====================================================================

/**
 * Compute the cluster report at end of run. Called by the BDD runner
 * before generating the HTML output.
 */
export function collectFailureClusters(): FailureClusterReport | null {
    try {
        const { CSFailureClusterer } = require('../clustering/CSFailureClusterer');
        const c = CSFailureClusterer.getInstance();
        if (!c.isEnabled()) return null;
        return c.cluster();
    } catch (e) {
        return null;
    }
}

export function generateFailureClusterCSS(): string {
    return `
        .fc-summary {
            display: flex; gap: 14px; flex-wrap: wrap;
            margin-bottom: 14px;
        }
        .fc-summary-card {
            background: #f8fafc; border: 1px solid #e2e8f0;
            border-radius: 6px; padding: 10px 14px; min-width: 130px;
        }
        .fc-summary-num {
            font-size: 1.6rem; font-weight: 700; color: #1e293b;
        }
        .fc-summary-label {
            font-size: 0.78rem; color: #64748b; margin-top: 2px;
        }
        .fc-cluster {
            border: 1px solid #e2e8f0; border-radius: 8px;
            margin-bottom: 12px; overflow: hidden;
        }
        .fc-cluster-head {
            display: flex; align-items: center; gap: 10px;
            padding: 10px 14px;
            background: linear-gradient(0deg, #fff7ed, #ffedd5);
            border-bottom: 1px solid #fed7aa;
        }
        .fc-cluster-id {
            font-weight: 700; color: #9a3412;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 0.82rem;
        }
        .fc-cluster-size {
            background: #f97316; color: white;
            border-radius: 999px; padding: 2px 9px;
            font-size: 0.78rem; font-weight: 700;
        }
        .fc-cluster-rep {
            color: #1e293b; font-size: 0.88rem;
            flex: 1; min-width: 0;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .fc-cluster-body { padding: 10px 14px; background: white; }
        .fc-shared-frames {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 0.74rem; color: #475569;
            background: #f8fafc; border: 1px solid #e2e8f0;
            border-radius: 4px; padding: 6px 8px; margin-bottom: 8px;
            white-space: pre-wrap;
        }
        .fc-members {
            margin: 0; padding: 0; list-style: none;
        }
        .fc-member {
            border-top: 1px solid #f1f5f9;
            padding: 5px 0; font-size: 0.84rem;
        }
        .fc-member:first-child { border-top: none; }
        .fc-member-name { color: #0f172a; font-weight: 600; }
        .fc-member-file { color: #64748b; font-size: 0.74rem; margin-left: 6px; }
        .fc-outlier-block {
            margin-top: 14px; padding: 10px 14px;
            background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
        }
        .fc-outlier-head {
            font-size: 0.82rem; color: #475569; font-weight: 600; margin-bottom: 6px;
        }
        .fc-outlier {
            font-size: 0.83rem; padding: 4px 0;
            border-top: 1px solid #f1f5f9;
        }
        .fc-outlier:first-of-type { border-top: none; }
        .fc-empty {
            color: #64748b; font-style: italic; padding: 8px 0;
        }
    `;
}

export function generateFailureClusterNavItem(report?: FailureClusterReport | null): string {
    // Only show the tab when there's something worth clicking on. Otherwise
    // (clustering disabled, or 0 failures) the nav stays clean.
    if (!report || report.totalFailures === 0) return '';
    return `<a class="nav-item" href="#failure-clusters" data-tab="failure-clusters">🧩 Failure Clusters</a>`;
}

export function generateFailureClusterSection(report: FailureClusterReport | null): string {
    if (!report) return '';
    if (report.totalFailures === 0) return '';

    const summary = `
        <div class="fc-summary">
            <div class="fc-summary-card">
                <div class="fc-summary-num">${report.totalFailures}</div>
                <div class="fc-summary-label">Total failures</div>
            </div>
            <div class="fc-summary-card">
                <div class="fc-summary-num">${report.clusterCount}</div>
                <div class="fc-summary-label">Likely cause${report.clusterCount === 1 ? '' : 's'}</div>
            </div>
            <div class="fc-summary-card">
                <div class="fc-summary-num">${report.outlierCount}</div>
                <div class="fc-summary-label">Outlier${report.outlierCount === 1 ? '' : 's'}</div>
            </div>
        </div>
    `;

    const clustersHtml = report.clusters.length === 0
        ? `<div class="fc-empty">No clusters — every failure looks distinct.</div>`
        : report.clusters.map(renderCluster).join('');

    const outliersHtml = report.outliers.length === 0
        ? ''
        : `<div class="fc-outlier-block">
                <div class="fc-outlier-head">🔍 Outliers (unique-looking failures, ${report.outliers.length})</div>
                ${report.outliers.map(o => `
                    <div class="fc-outlier">
                        <span style="font-weight:600;color:#0f172a">${htmlEscape(o.testName)}</span>
                        <span style="color:#64748b;font-size:0.74rem;margin-left:6px">${htmlEscape(o.featureFile)}</span>
                        <div style="color:#475569;font-size:0.78rem;margin-top:2px">${htmlEscape(o.errorMessage.slice(0, 240))}${o.errorMessage.length > 240 ? '…' : ''}</div>
                    </div>
                `).join('')}
            </div>`;

    const params = report.parameters;
    const paramsLine = `<div style="color:#94a3b8;font-size:0.72rem;margin-top:10px">
        DBSCAN parameters used: eps=${params.eps}, minPts=${params.minPts},
        msg weight=${params.messageWeight}, stack weight=${params.stackWeight}.
        Tune via FAILURE_CLUSTERING_EPS / _MIN_PTS / _MSG_WEIGHT / _STACK_WEIGHT.
    </div>`;

    return `
        <section id="failure-clusters" class="tab-section">
            <h2>🧩 Failure Clusters</h2>
            <p style="color:#475569;font-size:0.92rem;margin:4px 0 14px 0;">
                ${report.totalFailures} failure${report.totalFailures === 1 ? '' : 's'} grouped by
                shared error message and stack-trace signature. Each cluster is one likely
                root cause — fix the top of the cluster, fix every member with it.
            </p>
            ${summary}
            ${clustersHtml}
            ${outliersHtml}
            ${paramsLine}
        </section>
    `;
}

// =====================================================================
// Helpers
// =====================================================================

function renderCluster(c: FailureCluster): string {
    const framesBlock = c.sharedStackFrames.length > 0
        ? `<div class="fc-shared-frames">${c.sharedStackFrames.map(f => htmlEscape(f)).join('\n')}</div>`
        : '';
    const members = c.members.map(m => `
        <li class="fc-member">
            <span class="fc-member-name">${htmlEscape(m.testName)}</span>
            <span class="fc-member-file">${htmlEscape(m.featureFile)}</span>
        </li>
    `).join('');
    return `
        <div class="fc-cluster">
            <div class="fc-cluster-head">
                <span class="fc-cluster-id">Cluster #${c.id}</span>
                <span class="fc-cluster-size">${c.size} test${c.size === 1 ? '' : 's'}</span>
                <span class="fc-cluster-rep" title="${htmlEscape(c.sharedErrorMessage)}">${htmlEscape(c.sharedErrorMessage.slice(0, 200))}${c.sharedErrorMessage.length > 200 ? '…' : ''}</span>
            </div>
            <div class="fc-cluster-body">
                ${framesBlock}
                <ul class="fc-members">${members}</ul>
            </div>
        </div>
    `;
}
