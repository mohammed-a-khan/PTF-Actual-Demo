/**
 * CSLocatorScorer - pure stability scoring.
 *
 * Score model (0..100, higher = more stable):
 *
 *   testId / id                              100   — first-class app hooks
 *   name (form field), data-* attribute       95
 *   role + accessible name                    90
 *   role / label                              85
 *   placeholder / alt / title / aria-*        80
 *   text (short, exact)                       70
 *   text (long / partial)                     60
 *   className (single class)                  50
 *   css   (no problematic patterns)           45
 *   xpath (attribute-based, no positional)    40
 *   css / xpath with `:nth-child` / position  20
 *   absolute xpath (`/html/body/...`)         10
 *
 * Stacked penalties (apply on top of the base):
 *
 *   -20  generated-looking class name (`_a1b2c3`, `__hash__`)
 *   -15  positional pseudo-class / index predicate
 *   -15  absolute xpath
 *   -10  deep descendant chain (>3 combinators)
 *   -10  selector length > 120 chars
 *   -10  inline style= attribute selector
 *   - 5  tag-only selector with no specificity (e.g. `button`)
 *
 * Bands:
 *   90-100  stable
 *   70-89   acceptable
 *   40-69   fragile
 *    0-39   anti-pattern
 *
 * Pure, no I/O. The orchestrator handles severity / threshold.
 *
 * @module locator-lint
 */

import { LocatorStrategy, LocatorFinding } from './CSLocatorTypes';

export interface ScoreResult {
    score: number;
    tier: LocatorFinding['tier'];
    reasons: string[];
    suggestions: string[];
}

const BASE_SCORE: Record<LocatorStrategy, number> = {
    testId: 100,
    id: 100,
    name: 95,
    role: 85,
    label: 85,
    placeholder: 80,
    title: 80,
    alt: 80,
    text: 70,
    className: 50,
    css: 45,
    xpath: 40,
    raw: 30, // unknown until inspected; penalised further below
};

const GENERATED_CLASS = /(^|[\s.#\[="'>])(_[a-z0-9]{5,}|[a-zA-Z0-9]+__[A-Za-z0-9_]{4,}|[A-Za-z]+-[a-f0-9]{6,})/;
const POSITIONAL_PSEUDO = /:nth-(child|of-type)\(|:first-of-type\b|:last-of-type\b|\[position\(\)|\[\s*\d+\s*\]/;
const ABSOLUTE_XPATH = /^\s*\/(?!\/)/;
const INLINE_STYLE = /\[style[*^$~|]?=/;
const TAG_ONLY = /^[a-z][a-z0-9-]*$/i;

export function scoreLocator(strategy: LocatorStrategy, value: string): ScoreResult {
    const reasons: string[] = [];
    const suggestions: string[] = [];

    // Detect a raw page.locator() that uses an xpath-like string; reclassify
    // so the scoring is honest about what we're looking at.
    let effective: LocatorStrategy = strategy;
    if (strategy === 'raw') {
        if (value.startsWith('//') || value.startsWith('(/') || /^xpath[:=]/i.test(value)) {
            effective = 'xpath';
        } else if (/^text[:=]/i.test(value) || value.startsWith('text/')) {
            effective = 'text';
        } else if (/^role[:=]/i.test(value)) {
            effective = 'role';
        } else if (/^data-testid[:=]/i.test(value) || value.startsWith('[data-testid')) {
            effective = 'testId';
        } else if (value.startsWith('#') && !/\s/.test(value)) {
            effective = 'id';
        } else {
            effective = 'css';
        }
        reasons.push(
            `raw page.locator() — framework policy prefers @CSGetElement / CSWebElement; ` +
            `treated as ${effective} for scoring`,
        );
    }

    let score = BASE_SCORE[effective];
    reasons.push(`base ${score} for strategy "${effective}"`);

    // Text-specific nuances
    if (effective === 'text') {
        if (value.length > 40) { score -= 10; reasons.push('long text (>40 chars) is fragile across copy edits'); }
        if (/^\*=|^\^=|\*$|^\^|.*\.\.\.$/.test(value) || /^.{1,3}$/.test(value)) {
            score -= 10; reasons.push('partial / very short text — likely matches multiple nodes');
        }
        suggestions.push('Prefer a stable testId or role+accessible name over text');
    }

    // Generated / CSS-modules-style class names
    if (GENERATED_CLASS.test(value)) {
        score -= 20;
        reasons.push('class name looks generated (CSS-modules / hash suffix) — changes every build');
        suggestions.push('Ask the dev team to add a `data-testid` on this element');
    }

    // Positional pseudo / index predicate
    if (POSITIONAL_PSEUDO.test(value)) {
        score -= 15;
        reasons.push('positional selector (:nth-child / [N]) — breaks when sibling order changes');
        suggestions.push('Anchor on an attribute or accessible role instead of position');
    }

    // Absolute xpath
    if (effective === 'xpath' && ABSOLUTE_XPATH.test(value)) {
        score -= 15;
        reasons.push('absolute xpath — breaks on any DOM reshuffle');
        suggestions.push('Switch to an attribute-relative xpath (`//tag[@attr="..."]`) or testId');
    }

    // Deep descendant chains
    if (effective === 'css' || effective === 'xpath') {
        const combinators = effective === 'css'
            ? (value.match(/>|\s+/g) || []).length
            : (value.match(/\/{1,2}/g) || []).length;
        if (combinators > 3) {
            score -= 10;
            reasons.push(`deep ${effective} chain (${combinators} hops) — coupled to layout`);
            suggestions.push('Collapse the chain; locate the leaf directly via testId/role');
        }
    }

    // Length
    if (value.length > 120) {
        score -= 10;
        reasons.push(`selector is very long (${value.length} chars) — usually means too much DOM is encoded`);
    }

    // Inline style
    if (INLINE_STYLE.test(value)) {
        score -= 10;
        reasons.push('selector uses inline `style=` — visual changes will flip the match');
    }

    // Bare tag-only selector
    if (effective === 'css' && TAG_ONLY.test(value)) {
        score -= 5;
        reasons.push('tag-only selector — almost certainly matches more than one element');
        suggestions.push('Add an attribute (testId / aria-label / role) to disambiguate');
    }

    // Recommend tier-1 hooks whenever we land below "stable"
    if (score < 90 && effective !== 'testId' && effective !== 'id') {
        if (!suggestions.some(s => s.includes('testId'))) {
            suggestions.push('A `data-testid` (preferred) or stable `id` would score 100 and survive refactors');
        }
    }

    score = Math.max(0, Math.min(100, score));
    return { score, tier: bandFor(score), reasons, suggestions };
}

function bandFor(score: number): LocatorFinding['tier'] {
    if (score >= 90) return 'stable';
    if (score >= 70) return 'acceptable';
    if (score >= 40) return 'fragile';
    return 'anti-pattern';
}
