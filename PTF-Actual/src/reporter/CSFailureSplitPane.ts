/**
 * Failure-detail split-pane — Phase 3b (v1.41.1).
 *
 * Today's failed-step UX makes the tester click between two separate
 * tabs to see what broke: one for the error message + stack trace,
 * another for the screenshot. They can't see both at once. This module
 * adds a single "🔍 Failure" view that puts error/stack on the left
 * and the screenshot on the right, side-by-side, no scroll required
 * for typical content.
 *
 * Three exports:
 *
 *   - `extractFailureContext(step)` — pure helper that splits a raw
 *     `step.error` payload into a clean error message + stack trace
 *     and resolves the best screenshot src. Mirrors the parsing
 *     already done by `generateStepErrorDetails`; centralising it
 *     means the existing tab and the new split-pane stay in sync.
 *
 *   - `renderFailureSplitPane(step, screenshotSrc)` — emits the
 *     split-pane HTML for the step. Returns `''` for non-failed
 *     steps or steps with no error data at all.
 *
 *   - `generateFailureSplitPaneCSS()` — the CSS bundle. Uses CSS
 *     Grid + the built-in browser `resize: horizontal` corner on the
 *     left pane so users can drag the divider without any JS. Below
 *     900 px viewport the layout collapses to a single stacked
 *     column for tablets and phones.
 *
 * Every colour resolves to a theme token (`--danger-color`,
 * `--surface`, `--health-broken-fg`, …) so consumer overrides flow
 * through here as well.
 *
 * @module reporter
 */

import { htmlEscape } from './utils/HtmlSanitizer';

// Local attribute-escape — the exported `attrEscape` alias in
// `./utils/HtmlSanitizer` is `HtmlSanitizer.escapeAttribute` destructured
// off the class, which loses its `this` binding at call time. Doing the
// escape inline keeps this module self-contained.
function attrEsc(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface FailureContext {
    /** The clean human-readable error message (no stack frames). */
    mainError: string;
    /** Stack-trace lines, joined with `\n`. Empty when none parsed. */
    stackTrace: string;
    /** Whether the step actually has any error payload at all. */
    hasError: boolean;
}

// ============================================================================
// extractFailureContext — pure parser
// ============================================================================

/**
 * Split a raw step.error payload into mainError + stackTrace.
 * Mirrors the parser logic in `generateStepErrorDetails` so the
 * new split-pane stays consistent with the existing Error Details
 * tab if the user toggles between them.
 */
export function extractFailureContext(step: any): FailureContext {
    if (!step || !step.error) {
        return { mainError: '', stackTrace: '', hasError: false };
    }
    const err = step.error;
    let errorMsg = typeof err === 'string'
        ? err
        : (err?.message || err?.toString?.() || String(err));
    // ANSI colour codes pollute terminal-piped errors.
    errorMsg = errorMsg.replace(/\x1b\[[0-9;]*m/g, '');

    // Some payloads ship a separate `.stack` field — use it directly.
    if (err && typeof err === 'object' && typeof err.stack === 'string' && err.stack) {
        return { mainError: errorMsg.trim(), stackTrace: err.stack.trim(), hasError: true };
    }

    // Otherwise split by "    at " / "      at " (V8 stack-frame indent).
    const errorLines = errorMsg.split('\n');
    let mainError = '';
    let stackTrace = '';
    let isStackTrace = false;
    for (const line of errorLines) {
        if (line.includes('    at ') || line.includes('      at ') || isStackTrace) {
            isStackTrace = true;
            stackTrace += line + '\n';
        } else if (line.trim()) {
            mainError += line + '\n';
        }
    }
    return { mainError: mainError.trim(), stackTrace: stackTrace.trim(), hasError: true };
}

// ============================================================================
// renderFailureSplitPane
// ============================================================================

/**
 * Render the split-pane HTML for a failed step.
 *
 * Layout: left pane (error + stack), right pane (screenshot). The
 * left pane has `resize: horizontal` so users can drag its right
 * edge to widen/narrow it; the right pane fills the remainder.
 * Both panes scroll independently so neither truncates the other.
 *
 * When the step has no screenshot, the right pane shows a friendly
 * empty-state. When the step has no error payload at all, this
 * returns `''` and the caller should not emit the tab.
 */
export function renderFailureSplitPane(step: any, screenshotSrc: string | null): string {
    if (!step || step.status !== 'failed') return '';
    const ctx = extractFailureContext(step);
    // Split-pane is for *diagnosing* failures — needs an error payload.
    // Screenshots without an error are still reachable via the existing
    // Screenshots tab; rendering this view for screenshot-only failures
    // would be empty UX noise.
    if (!ctx.hasError) return '';

    const errorBlock = ctx.mainError
        ? `<div class="fsp-section">
            <div class="fsp-section-head">
                <span class="fsp-icon" aria-hidden="true">❌</span>
                <span>Error message</span>
            </div>
            <pre class="fsp-error-pre">${htmlEscape(ctx.mainError)}</pre>
        </div>`
        : '';

    const stackBlock = ctx.stackTrace
        ? `<div class="fsp-section">
            <div class="fsp-section-head">
                <span class="fsp-icon" aria-hidden="true">📋</span>
                <span>Stack trace</span>
            </div>
            <pre class="fsp-stack-pre">${htmlEscape(ctx.stackTrace)}</pre>
        </div>`
        : '';

    const leftEmpty = !errorBlock && !stackBlock
        ? `<div class="fsp-empty">No error message captured.</div>`
        : '';

    const rightContent = screenshotSrc
        ? `<button type="button" class="fsp-screenshot-btn"
                    onclick="showScreenshotModal('${attrEsc(screenshotSrc)}')"
                    aria-label="Open screenshot in full-size viewer">
                <img class="fsp-screenshot" src="${attrEsc(screenshotSrc)}" alt="Screenshot at failure" loading="lazy" />
                <span class="fsp-screenshot-hint">Click to zoom</span>
            </button>`
        : `<div class="fsp-empty">No screenshot captured for this failure.</div>`;

    return `
    <div class="fsp-grid" role="group" aria-label="Failure detail split-pane">
        <div class="fsp-pane fsp-left">
            ${errorBlock}
            ${stackBlock}
            ${leftEmpty}
        </div>
        <div class="fsp-pane fsp-right">
            <div class="fsp-section">
                <div class="fsp-section-head">
                    <span class="fsp-icon" aria-hidden="true">📸</span>
                    <span>Screenshot</span>
                </div>
                ${rightContent}
            </div>
        </div>
    </div>`;
}

// ============================================================================
// generateFailureSplitPaneCSS
// ============================================================================

export function generateFailureSplitPaneCSS(): string {
    return `
    /* v1.41.1 — Phase 3b failure-detail split-pane */

    .fsp-grid {
        display: flex;
        gap: 12px;
        align-items: stretch;
        min-height: 280px;
    }
    .fsp-pane {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 12px;
        overflow: auto;
        max-height: 560px;
    }
    .fsp-left {
        flex: 0 0 50%;
        min-width: 280px;
        max-width: 80%;
        /* The built-in browser drag handle. Works in Chrome, Firefox,
           Safari, Edge — zero JS required. */
        resize: horizontal;
    }
    .fsp-right {
        flex: 1 1 auto;
        min-width: 240px;
        display: flex;
        flex-direction: column;
    }
    /* Below the tablet breakpoint, stack vertically so phones can read
       both panes without resorting to horizontal scroll. */
    @media (max-width: 900px) {
        .fsp-grid { flex-direction: column; }
        .fsp-left, .fsp-right {
            flex: 0 0 auto;
            max-width: 100%;
            resize: none;
        }
    }

    .fsp-section { margin-bottom: 12px; }
    .fsp-section:last-child { margin-bottom: 0; }
    .fsp-section-head {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--text-primary);
        margin-bottom: 6px;
    }
    .fsp-icon { font-size: 1rem; }

    .fsp-error-pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.82rem;
        color: var(--health-broken-fg);
        background: var(--health-broken-bg);
        border: 1px solid var(--border);
        border-left: 4px solid var(--danger-color);
        border-radius: 4px;
        padding: 10px 12px;
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
    }
    .fsp-stack-pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.76rem;
        color: var(--text-secondary);
        background: var(--surface-hover);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 10px 12px;
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 320px;
        overflow-y: auto;
    }

    .fsp-screenshot-btn {
        display: block;
        background: transparent;
        border: 1px dashed var(--border);
        padding: 6px;
        border-radius: 6px;
        cursor: zoom-in;
        max-width: 100%;
        text-align: center;
    }
    .fsp-screenshot-btn:hover { border-color: var(--brand-color-light); }
    .fsp-screenshot {
        display: block;
        max-width: 100%;
        max-height: 460px;
        margin: 0 auto;
        border-radius: 4px;
        background: var(--surface-hover);
    }
    .fsp-screenshot-hint {
        display: block;
        font-size: 0.74rem;
        color: var(--text-secondary);
        margin-top: 6px;
    }

    .fsp-empty {
        font-size: 0.86rem;
        color: var(--text-secondary);
        font-style: italic;
        padding: 16px 12px;
        text-align: center;
        background: var(--surface-hover);
        border: 1px dashed var(--border);
        border-radius: 6px;
    }`;
}
