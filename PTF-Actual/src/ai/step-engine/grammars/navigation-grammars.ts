/**
 * Navigation Grammar Rules
 *
 * ~5 grammar rules for navigation intents: go to URL, navigate, open page, etc.
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

/** Helper to resolve a quoted placeholder back to its value */
function resolveQuoted(text: string, quotedStrings: string[]): string {
    return text.replace(/__QUOTED_(\d+)__/g, (_, idx) => quotedStrings[parseInt(idx)] || '');
}

export const NAVIGATION_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // URL NAVIGATION (Priority 300-309)
    // ========================================================================
    {
        id: 'nav-goto-url-quoted',
        pattern: /^(?:navigate|go|open|visit|browse)\s+(?:to\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'navigate',
        priority: 300,
        extract: (match, quotedStrings) => {
            const url = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { url }
            };
        },
        examples: [
            "Navigate to 'https://example.com'",
            "Go to '/dashboard'",
            "Open 'https://app.example.com/login'"
        ]
    },
    {
        id: 'nav-goto-url-unquoted',
        pattern: /^(?:navigate|go|open|visit|browse)\s+to\s+(https?:\/\/\S+)$/i,
        category: 'action',
        intent: 'navigate',
        priority: 301,
        extract: (match) => {
            return {
                targetText: '',
                params: { url: match[1].trim() }
            };
        },
        examples: [
            'Navigate to https://example.com',
            'Go to https://app.example.com/login'
        ]
    },
    {
        id: 'nav-goto-path',
        pattern: /^(?:navigate|go|open|visit|browse)\s+to\s+(\/\S+)$/i,
        category: 'action',
        intent: 'navigate',
        priority: 302,
        extract: (match) => {
            return {
                targetText: '',
                params: { url: match[1].trim() }
            };
        },
        examples: [
            'Navigate to /dashboard',
            'Go to /settings/profile'
        ]
    },

    // ========================================================================
    // PAGE NAVIGATION (Priority 310-319)
    // ========================================================================
    {
        id: 'nav-go-back',
        pattern: /^(?:go|navigate)\s+back$/i,
        category: 'action',
        intent: 'navigate',
        priority: 310,
        extract: () => ({
            targetText: '',
            params: { url: 'back' }
        }),
        examples: ['Go back', 'Navigate back']
    },
    {
        id: 'nav-go-forward',
        pattern: /^(?:go|navigate)\s+forward$/i,
        category: 'action',
        intent: 'navigate',
        priority: 311,
        extract: () => ({
            targetText: '',
            params: { url: 'forward' }
        }),
        examples: ['Go forward', 'Navigate forward']
    },
    {
        id: 'nav-reload',
        pattern: /^(?:reload|refresh)\s*(?:the\s+)?(?:page)?$/i,
        category: 'action',
        intent: 'navigate',
        priority: 312,
        extract: () => ({
            targetText: '',
            params: { url: 'reload' }
        }),
        examples: ['Reload the page', 'Refresh', 'Reload']
    }
];
