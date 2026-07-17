/**
 * Reusable component primitives — v1.43.0 Phase A.
 *
 * Eight render helpers that Phase B+ surfaces will opt into so the
 * report feels designed-by-one-hand rather than bolted-together.
 *
 * Phase A only DEFINES these; no existing code uses them yet. The
 * primitives ship in dist/ so when Phase B refactors the dashboard
 * (and Phase C the Tests view, Phase D polish), they can just
 * import + render without further plumbing.
 *
 *   - card()           — bordered + softly-shadowed surface
 *   - sectionHeader()  — title + optional eyebrow + helper text + hint
 *   - badge()          — small pill (status / count / label)
 *   - kbd()            — keyboard-key chip ("⌘K", "/", "Esc")
 *   - divider()        — horizontal rule
 *   - microHint()      — small `?` icon with hover tooltip
 *   - emptyState()     — icon + headline + helper + (optional) CTA
 *   - skeleton()       — shimmer placeholder
 *
 * Every helper is pure HTML/CSS, theme-token only, zero new deps.
 *
 * Token contract (every primitive references these — Phase A
 * shipped them in CSReportDesign):
 *   --cs-bg / --cs-bg-card / --cs-bg-subtle (fall back to existing
 *     --background / --surface / --surface-hover)
 *   --cs-fg / --cs-fg-muted (fall back to --text-primary /
 *     --text-secondary)
 *   --cs-border (falls back to --border)
 *   --cs-brand-soft / --cs-success-soft / etc.
 *   --cs-shadow-{xs,sm,md,lg,xl,ring}
 *   --cs-radius-{xs,sm,md,lg,xl,full}
 *   --cs-space-{0..16}
 *   --cs-font-{sans,mono}
 *   --cs-text-{xs..4xl} / --cs-lh-* / --cs-weight-*
 *   --cs-ease / --cs-dur-{fast,base,slow}
 *
 * @module reporter
 */

import { htmlEscape } from './utils/HtmlSanitizer';

// ============================================================================
// Markup helpers
// ============================================================================

export interface CardOptions {
    id?: string;
    className?: string;
    tag?: string;
    ariaLabel?: string;
    padding?: 'none' | 'sm' | 'md' | 'lg';
    elevation?: 'flat' | 'sm' | 'md' | 'lg';
}

/**
 * Render a card wrapper. Returns `{open, close}` so callers can stream
 * arbitrary child markup between.
 */
export function card(opts: CardOptions = {}): { open: string; close: string } {
    const tag = opts.tag || 'section';
    const classes = ['cs-card'];
    if (opts.padding) classes.push(`cs-card--p-${opts.padding}`);
    if (opts.elevation) classes.push(`cs-card--elev-${opts.elevation}`);
    if (opts.className) classes.push(opts.className);
    const attrs = [
        `class="${classes.join(' ')}"`,
        opts.id ? `id="${attrEsc(opts.id)}"` : '',
        opts.ariaLabel ? `aria-label="${attrEsc(opts.ariaLabel)}"` : '',
    ].filter(Boolean).join(' ');
    return { open: `<${tag} ${attrs}>`, close: `</${tag}>` };
}

export interface SectionHeaderOptions {
    title: string;
    eyebrow?: string;
    helper?: string;
    trailing?: string;
    hint?: string;
}

/** Standardised section header: eyebrow + title + helper + trailing. */
export function sectionHeader(opts: SectionHeaderOptions): string {
    const eyebrow = opts.eyebrow ? `<div class="cs-sh-eyebrow">${htmlEscape(opts.eyebrow)}</div>` : '';
    const helper = opts.helper ? `<p class="cs-sh-helper">${htmlEscape(opts.helper)}</p>` : '';
    const trailing = opts.trailing ? `<div class="cs-sh-trailing">${opts.trailing}</div>` : '';
    const hint = opts.hint ? microHint(opts.hint) : '';
    return `
        <header class="cs-sh">
            <div class="cs-sh-main">
                ${eyebrow}
                <h3 class="cs-sh-title">${htmlEscape(opts.title)}${hint}</h3>
                ${helper}
            </div>
            ${trailing}
        </header>`;
}

export interface BadgeOptions {
    label: string;
    tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
    variant?: 'solid' | 'subtle' | 'outline';
    icon?: string;
    ariaLabel?: string;
}

/** Small pill badge — status indicator, count, label. */
export function badge(opts: BadgeOptions): string {
    const tone = opts.tone || 'neutral';
    const variant = opts.variant || 'subtle';
    const aria = opts.ariaLabel ? `aria-label="${attrEsc(opts.ariaLabel)}"` : '';
    const icon = opts.icon ? `<span class="cs-badge-icon" aria-hidden="true">${htmlEscape(opts.icon)}</span>` : '';
    return `<span class="cs-badge cs-badge--${tone} cs-badge--${variant}" ${aria}>${icon}<span class="cs-badge-text">${htmlEscape(opts.label)}</span></span>`;
}

/** Keyboard-key chip — `⌘K`, `/`, `Esc`. */
export function kbd(key: string): string {
    return `<kbd class="cs-kbd">${htmlEscape(key)}</kbd>`;
}

/** Horizontal rule (optionally with centred label). */
export function divider(label?: string): string {
    if (label) {
        return `<div class="cs-divider cs-divider--labeled" role="separator"><span class="cs-divider-label">${htmlEscape(label)}</span></div>`;
    }
    return `<hr class="cs-divider" role="separator">`;
}

/**
 * Micro-hint icon — small `?` glyph with native `title` tooltip
 * + `aria-label` for screen readers. Zero JS dependency.
 */
export function microHint(text: string): string {
    return `<span class="cs-hint" tabindex="0" role="img" aria-label="${attrEsc(text)}" title="${attrEsc(text)}">?</span>`;
}

export interface EmptyStateOptions {
    icon?: string;
    title: string;
    helper?: string;
    action?: string;
    variant?: 'inline' | 'panel';
}

/** Empty state — icon + headline + helper + optional CTA. */
export function emptyState(opts: EmptyStateOptions): string {
    const variant = opts.variant || 'panel';
    const icon = opts.icon ? `<div class="cs-empty-icon" aria-hidden="true">${htmlEscape(opts.icon)}</div>` : '';
    const helper = opts.helper ? `<p class="cs-empty-helper">${htmlEscape(opts.helper)}</p>` : '';
    const action = opts.action ? `<div class="cs-empty-action">${opts.action}</div>` : '';
    return `
        <div class="cs-empty cs-empty--${variant}" role="status">
            ${icon}
            <div class="cs-empty-title">${htmlEscape(opts.title)}</div>
            ${helper}
            ${action}
        </div>`;
}

/** Skeleton shimmer placeholder. */
export function skeleton(opts: { width?: string; height?: string; rounded?: 'sm' | 'md' | 'lg' | 'full' } = {}): string {
    const w = opts.width || '100%';
    const h = opts.height || '14px';
    const r = opts.rounded || 'sm';
    return `<span class="cs-skel cs-skel--r-${r}" style="width:${w};height:${h}" aria-hidden="true"></span>`;
}

// ============================================================================
// CSS bundle for all primitives
// ============================================================================

/**
 * Emit primitives CSS. Theme-token only. Wired into the report's
 * CSS bundle by `generateEnhancedCSS()` in Phase A so it's ready
 * for Phase B+ refactored surfaces.
 */
export function generatePrimitivesCSS(): string {
    return `
    /* ── Card ──────────────────────────────────────────────────── */
    .cs-card {
        background: var(--surface, var(--cs-bg-card, #ffffff));
        border: 1px solid var(--border, var(--cs-border));
        border-radius: var(--cs-radius-lg);
        box-shadow: var(--cs-shadow-xs);
        margin-bottom: var(--cs-space-4);
    }
    .cs-card--p-none { padding: 0; }
    .cs-card--p-sm   { padding: var(--cs-space-3); }
    .cs-card--p-md   { padding: var(--cs-space-4) var(--cs-space-5); }
    .cs-card--p-lg   { padding: var(--cs-space-6); }
    .cs-card--elev-flat { box-shadow: none; }
    .cs-card--elev-sm   { box-shadow: var(--cs-shadow-xs); }
    .cs-card--elev-md   { box-shadow: var(--cs-shadow-sm); }
    .cs-card--elev-lg   { box-shadow: var(--cs-shadow-md); }

    /* ── Section header ────────────────────────────────────────── */
    .cs-sh {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--cs-space-4);
        margin-bottom: var(--cs-space-3);
    }
    .cs-sh-main { flex: 1 1 auto; min-width: 0; }
    .cs-sh-eyebrow {
        font-size: var(--cs-text-xs);
        font-weight: var(--cs-weight-medium);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: var(--cs-space-1);
    }
    .cs-sh-title {
        font-size: var(--cs-text-lg);
        font-weight: var(--cs-weight-semibold);
        line-height: var(--cs-lh-snug);
        margin: 0;
        color: var(--text-primary);
        display: flex;
        align-items: center;
        gap: var(--cs-space-2);
    }
    .cs-sh-helper {
        font-size: var(--cs-text-sm);
        color: var(--text-secondary);
        line-height: var(--cs-lh-normal);
        margin: var(--cs-space-1) 0 0;
        max-width: 65ch;
    }
    .cs-sh-trailing { flex: 0 0 auto; display: flex; align-items: center; gap: var(--cs-space-2); }

    /* ── Badge ─────────────────────────────────────────────────── */
    .cs-badge {
        display: inline-flex;
        align-items: center;
        gap: var(--cs-space-1);
        padding: 2px var(--cs-space-2);
        border-radius: var(--cs-radius-full);
        font-size: var(--cs-text-xs);
        font-weight: var(--cs-weight-medium);
        line-height: 1.4;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
    }
    .cs-badge-icon { font-size: 0.9em; line-height: 1; }
    .cs-badge-text { line-height: 1.4; }
    /* Subtle (default) */
    .cs-badge--subtle.cs-badge--neutral { background: var(--surface-hover, var(--cs-zinc-100)); color: var(--text-primary); }
    .cs-badge--subtle.cs-badge--brand   { background: var(--cs-brand-soft); color: var(--brand-text, var(--brand-color)); }
    .cs-badge--subtle.cs-badge--success { background: var(--cs-success-soft); color: var(--success-color); }
    .cs-badge--subtle.cs-badge--warning { background: var(--cs-warning-soft); color: var(--warning-color); }
    .cs-badge--subtle.cs-badge--danger  { background: var(--cs-danger-soft);  color: var(--danger-color);  }
    .cs-badge--subtle.cs-badge--info    { background: var(--cs-info-soft);    color: var(--info-color);    }
    /* Solid */
    .cs-badge--solid { color: #ffffff; }
    .cs-badge--solid.cs-badge--neutral { background: var(--cs-zinc-700); }
    .cs-badge--solid.cs-badge--brand   { background: var(--brand-color); }
    .cs-badge--solid.cs-badge--success { background: var(--success-color); }
    .cs-badge--solid.cs-badge--warning { background: var(--warning-color); }
    .cs-badge--solid.cs-badge--danger  { background: var(--danger-color); }
    .cs-badge--solid.cs-badge--info    { background: var(--info-color); }
    /* Outline */
    .cs-badge--outline { background: transparent; border: 1px solid currentColor; }
    .cs-badge--outline.cs-badge--neutral { color: var(--text-secondary); }
    .cs-badge--outline.cs-badge--brand   { color: var(--brand-text, var(--brand-color)); }
    .cs-badge--outline.cs-badge--success { color: var(--success-color); }
    .cs-badge--outline.cs-badge--warning { color: var(--warning-color); }
    .cs-badge--outline.cs-badge--danger  { color: var(--danger-color); }

    /* ── Keyboard chip ─────────────────────────────────────────── */
    .cs-kbd {
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        border-radius: var(--cs-radius-xs);
        font-family: var(--cs-font-mono);
        font-size: 0.75em;
        line-height: 1.4;
        background: var(--surface-hover, var(--cs-zinc-100));
        color: var(--text-secondary);
        border: 1px solid var(--border);
        border-bottom-width: 2px;
        margin: 0 1px;
    }

    /* ── Divider ───────────────────────────────────────────────── */
    .cs-divider {
        border: none;
        border-top: 1px solid var(--border);
        margin: var(--cs-space-4) 0;
        height: 0;
    }
    .cs-divider--labeled {
        display: flex;
        align-items: center;
        text-align: center;
        gap: var(--cs-space-3);
        color: var(--text-secondary);
        font-size: var(--cs-text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: var(--cs-space-4) 0;
    }
    .cs-divider--labeled::before,
    .cs-divider--labeled::after {
        content: '';
        flex: 1 1 auto;
        border-top: 1px solid var(--border);
    }

    /* ── Micro hint (info-tooltip icon) ────────────────────────── */
    .cs-hint {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        border-radius: var(--cs-radius-full);
        background: var(--surface-hover, var(--cs-zinc-100));
        color: var(--text-secondary);
        font-size: 10px;
        font-weight: var(--cs-weight-bold);
        cursor: help;
        margin-left: var(--cs-space-1);
        vertical-align: middle;
        transition: background var(--cs-dur-fast) var(--cs-ease),
                    color var(--cs-dur-fast) var(--cs-ease);
    }
    .cs-hint:hover, .cs-hint:focus-visible {
        background: var(--surface-hover, var(--cs-zinc-200));
        color: var(--text-primary);
    }

    /* ── Empty state ───────────────────────────────────────────── */
    .cs-empty {
        text-align: center;
        color: var(--text-secondary);
    }
    .cs-empty--panel {
        padding: var(--cs-space-10) var(--cs-space-6);
        background: var(--surface-hover, var(--cs-zinc-50));
        border: 1px dashed var(--border);
        border-radius: var(--cs-radius-lg);
    }
    .cs-empty--inline { padding: var(--cs-space-6) var(--cs-space-4); }
    .cs-empty-icon { font-size: 32px; margin-bottom: var(--cs-space-3); opacity: 0.6; }
    .cs-empty-title {
        font-size: var(--cs-text-base);
        font-weight: var(--cs-weight-semibold);
        color: var(--text-primary);
        margin-bottom: var(--cs-space-1);
    }
    .cs-empty-helper {
        font-size: var(--cs-text-sm);
        line-height: var(--cs-lh-normal);
        max-width: 50ch;
        margin: 0 auto var(--cs-space-4);
    }
    .cs-empty-action { margin-top: var(--cs-space-4); }

    /* ── Skeleton (shimmer) ────────────────────────────────────── */
    .cs-skel {
        display: inline-block;
        background: linear-gradient(
            90deg,
            var(--surface-hover, var(--cs-zinc-100)) 0%,
            var(--cs-zinc-200) 50%,
            var(--surface-hover, var(--cs-zinc-100)) 100%
        );
        background-size: 200% 100%;
        animation: cs-skel-shimmer 1.4s var(--cs-ease) infinite;
    }
    .cs-skel--r-sm   { border-radius: var(--cs-radius-sm); }
    .cs-skel--r-md   { border-radius: var(--cs-radius-md); }
    .cs-skel--r-lg   { border-radius: var(--cs-radius-lg); }
    .cs-skel--r-full { border-radius: var(--cs-radius-full); }
    @keyframes cs-skel-shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
        .cs-skel { animation: none; }
    }
    `;
}

function attrEsc(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
