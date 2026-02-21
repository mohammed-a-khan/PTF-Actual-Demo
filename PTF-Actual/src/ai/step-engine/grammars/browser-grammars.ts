/**
 * Browser Grammar Rules (Phase 2, 8, 9)
 *
 * Grammar rules for browser/tab management, frame switching, and cookie/storage operations.
 * Priority range: 350-530
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

/** Helper to resolve a quoted placeholder back to its value */
function resolveQuoted(text: string, quotedStrings: string[]): string {
    return text.replace(/__QUOTED_(\d+)__/g, (_, idx) => quotedStrings[parseInt(idx)] || '');
}

export const BROWSER_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // TAB MANAGEMENT (Priority 350-369)
    // ========================================================================
    {
        id: 'browser-switch-tab-index',
        pattern: /^switch\s+to\s+tab\s+(\d+)$/i,
        category: 'action',
        intent: 'switch-tab',
        priority: 350,
        extract: (match) => ({
            targetText: '',
            params: { tabIndex: parseInt(match[1]) }
        }),
        examples: ['Switch to tab 2', 'Switch to tab 1']
    },
    {
        id: 'browser-switch-tab-latest',
        pattern: /^switch\s+to\s+(?:the\s+)?(?:latest|last|newest|new)\s+tab$/i,
        category: 'action',
        intent: 'switch-tab',
        priority: 351,
        extract: () => ({
            targetText: '',
            params: { tabIndex: -1 }
        }),
        examples: ['Switch to the latest tab', 'Switch to the last tab', 'Switch to the new tab']
    },
    {
        id: 'browser-switch-tab-main',
        pattern: /^switch\s+to\s+(?:the\s+)?(?:main|first|original|primary)\s+tab$/i,
        category: 'action',
        intent: 'switch-tab',
        priority: 352,
        extract: () => ({
            targetText: '',
            params: { tabIndex: 0 }
        }),
        examples: ['Switch to the main tab', 'Switch to the first tab', 'Switch to the original tab']
    },
    {
        id: 'browser-open-new-tab',
        pattern: /^open\s+(?:a\s+)?new\s+tab(?:\s+(?:with|to)\s+__QUOTED_(\d+)__)?$/i,
        category: 'action',
        intent: 'open-new-tab',
        priority: 353,
        extract: (match, quotedStrings) => {
            const url = match[1] ? quotedStrings[parseInt(match[1])] : undefined;
            return {
                targetText: '',
                params: url ? { url } : {}
            };
        },
        examples: [
            'Open a new tab',
            "Open a new tab with 'https://example.com'",
            "Open new tab to '/settings'"
        ]
    },
    {
        id: 'browser-close-current-tab',
        pattern: /^close\s+(?:the\s+)?(?:current\s+)?tab$/i,
        category: 'action',
        intent: 'close-tab',
        priority: 354,
        extract: () => ({
            targetText: ''
        }),
        examples: ['Close the current tab', 'Close tab']
    },
    {
        id: 'browser-close-tab-index',
        pattern: /^close\s+tab\s+(\d+)$/i,
        category: 'action',
        intent: 'close-tab',
        priority: 355,
        extract: (match) => ({
            targetText: '',
            params: { tabIndex: parseInt(match[1]) }
        }),
        examples: ['Close tab 2', 'Close tab 3']
    },

    // ========================================================================
    // BROWSER SWITCHING (Priority 370-379)
    // ========================================================================
    {
        id: 'browser-switch-browser',
        pattern: /^switch\s+to\s+(?:the\s+)?(chrome|chromium|firefox|webkit|safari|edge)\s*(?:browser)?$/i,
        category: 'action',
        intent: 'switch-browser',
        priority: 370,
        extract: (match) => ({
            targetText: '',
            params: { browserType: match[1].toLowerCase() }
        }),
        examples: [
            'Switch to Firefox browser',
            'Switch to Chrome browser',
            'Switch to the Safari browser'
        ]
    },

    // ========================================================================
    // SESSION MANAGEMENT (Priority 380-389)
    // ========================================================================
    {
        id: 'browser-clear-session',
        pattern: /^clear\s+(?:browser\s+)?(?:session|context)\s+(?:for\s+)?(?:re-?authentication)?$/i,
        category: 'action',
        intent: 'clear-session',
        priority: 380,
        extract: () => ({
            targetText: ''
        }),
        examples: [
            'Clear browser session for re-authentication',
            'Clear browser context for reauthentication',
            'Clear session'
        ]
    },
    {
        id: 'browser-clear-session-navigate',
        pattern: /^clear\s+(?:browser\s+)?(?:session|context)\s+and\s+navigate\s+to\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'clear-session',
        priority: 381,
        extract: (match, quotedStrings) => {
            const loginUrl = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { loginUrl }
            };
        },
        examples: [
            "Clear session and navigate to '/login'",
            "Clear browser context and navigate to 'https://app.example.com/login'"
        ]
    },

    // ========================================================================
    // FRAME/IFRAME SWITCHING (Priority 390-399) — Phase 8
    // ========================================================================
    {
        id: 'browser-switch-frame-selector',
        pattern: /^switch\s+to\s+(?:the\s+)?(?:frame|iframe)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'switch-frame',
        priority: 390,
        extract: (match, quotedStrings) => {
            const selector = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { frameSelector: selector }
            };
        },
        examples: [
            "Switch to frame '#payment-iframe'",
            "Switch to iframe 'content-frame'"
        ]
    },
    {
        id: 'browser-switch-frame-named',
        pattern: /^switch\s+to\s+(?:the\s+)?(?:frame|iframe)\s+named\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'switch-frame',
        priority: 391,
        extract: (match, quotedStrings) => {
            const name = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { frameSelector: name }
            };
        },
        examples: [
            "Switch to frame named 'content'",
            "Switch to iframe named 'editor'"
        ]
    },
    {
        id: 'browser-switch-frame-index',
        pattern: /^switch\s+to\s+(?:the\s+)?(?:frame|iframe)\s+(\d+)$/i,
        category: 'action',
        intent: 'switch-frame',
        priority: 392,
        extract: (match) => ({
            targetText: '',
            params: { frameSelector: match[1] }
        }),
        examples: ['Switch to frame 1', 'Switch to iframe 0']
    },
    {
        id: 'browser-switch-main-frame',
        pattern: /^switch\s+to\s+(?:the\s+)?(?:main|parent|top|default)\s+(?:frame|content|page)$/i,
        category: 'action',
        intent: 'switch-main-frame',
        priority: 393,
        extract: () => ({
            targetText: ''
        }),
        examples: [
            'Switch to main frame',
            'Switch to the parent frame',
            'Switch to the default content'
        ]
    },

    // ========================================================================
    // BROWSER DIALOG HANDLING (Priority 400-409) — JSP/Legacy App Support
    // Handles alert(), confirm(), prompt() dialogs common in JSP applications
    // ========================================================================
    {
        id: 'browser-accept-dialog',
        pattern: /^(?:accept|ok|close|dismiss)\s+(?:the\s+)?(?:alert|dialog)$/i,
        category: 'action',
        intent: 'accept-dialog',
        priority: 400,
        extract: () => ({
            targetText: '',
            params: { dialogAction: 'accept' }
        }),
        examples: [
            'Accept the alert',
            'OK the alert',
            'Close the dialog',
            'Accept the dialog'
        ]
    },
    {
        id: 'browser-dismiss-dialog',
        pattern: /^(?:dismiss|cancel|reject)\s+(?:the\s+)?(?:alert|confirm|dialog|popup)$/i,
        category: 'action',
        intent: 'dismiss-dialog',
        priority: 401,
        extract: () => ({
            targetText: '',
            params: { dialogAction: 'dismiss' }
        }),
        examples: [
            'Dismiss the alert',
            'Cancel the confirm',
            'Reject the dialog',
            'Dismiss the popup'
        ]
    },
    {
        id: 'browser-accept-confirm',
        pattern: /^(?:accept|confirm|ok)\s+(?:the\s+)?confirm(?:ation)?(?:\s+dialog)?$/i,
        category: 'action',
        intent: 'accept-dialog',
        priority: 402,
        extract: () => ({
            targetText: '',
            params: { dialogAction: 'accept' }
        }),
        examples: [
            'Accept the confirm dialog',
            'Confirm the confirmation',
            'OK the confirm'
        ]
    },
    {
        id: 'browser-enter-prompt',
        pattern: /^(?:enter|type|input)\s+__QUOTED_(\d+)__\s+(?:in|into)\s+(?:the\s+)?prompt(?:\s+(?:dialog|and\s+accept))?$/i,
        category: 'action',
        intent: 'accept-dialog',
        priority: 403,
        extract: (match, quotedStrings) => {
            const promptText = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                value: promptText,
                params: { dialogAction: 'accept', promptText }
            };
        },
        examples: [
            "Enter 'John' in the prompt",
            "Type 'test' into the prompt and accept",
            "Input 'hello' in the prompt dialog"
        ]
    },
    {
        id: 'browser-handle-next-dialog-accept',
        pattern: /^(?:handle|prepare\s+for|expect)\s+(?:the\s+)?(?:next\s+)?(?:alert|dialog|confirm|prompt)\s+(?:by\s+)?accept(?:ing)?$/i,
        category: 'action',
        intent: 'handle-next-dialog',
        priority: 404,
        extract: () => ({
            targetText: '',
            params: { dialogAction: 'accept' }
        }),
        examples: [
            'Handle the next alert by accepting',
            'Expect the next dialog accept',
            'Prepare for the next confirm by accepting'
        ]
    },
    {
        id: 'browser-handle-next-dialog-dismiss',
        pattern: /^(?:handle|prepare\s+for|expect)\s+(?:the\s+)?(?:next\s+)?(?:alert|dialog|confirm|prompt)\s+(?:by\s+)?dismiss(?:ing)?$/i,
        category: 'action',
        intent: 'handle-next-dialog',
        priority: 405,
        extract: () => ({
            targetText: '',
            params: { dialogAction: 'dismiss' }
        }),
        examples: [
            'Handle the next alert by dismissing',
            'Expect the next confirm by dismissing',
            'Prepare for the next dialog by dismissing'
        ]
    },
    {
        id: 'browser-verify-dialog-text',
        pattern: /^(?:verify|assert|check)\s+(?:the\s+)?(?:alert|dialog|confirm|prompt)\s+(?:text\s+)?(?:is|equals?|contains?|says?|shows?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-dialog-text',
        priority: 406,
        extract: (match, quotedStrings) => {
            const expectedText = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                expectedValue: expectedText,
                params: { dialogAction: 'verify' }
            };
        },
        examples: [
            "Verify the alert text is 'Are you sure?'",
            "Check the confirm says 'Delete this record?'",
            "Assert the dialog contains 'Success'"
        ]
    },

    // ========================================================================
    // COOKIE OPERATIONS (Priority 500-509) — Phase 9
    // ========================================================================
    {
        id: 'browser-clear-cookies',
        pattern: /^clear\s+(?:all\s+)?cookies$/i,
        category: 'action',
        intent: 'clear-cookies',
        priority: 500,
        extract: () => ({
            targetText: ''
        }),
        examples: ['Clear all cookies', 'Clear cookies']
    },
    {
        id: 'browser-get-cookie',
        pattern: /^(?:get|read)\s+(?:the\s+)?cookie\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-cookie',
        priority: 501,
        extract: (match, quotedStrings) => {
            const cookieName = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { cookieName }
            };
        },
        examples: [
            "Get the cookie 'session_token'",
            "Read the cookie 'auth_token'"
        ]
    },

    // ========================================================================
    // STORAGE OPERATIONS (Priority 510-529) — Phase 9
    // ========================================================================
    {
        id: 'browser-clear-local-storage',
        pattern: /^clear\s+local\s+storage$/i,
        category: 'action',
        intent: 'clear-storage',
        priority: 510,
        extract: () => ({
            targetText: '',
            params: { storageType: 'local' as const }
        }),
        examples: ['Clear local storage']
    },
    {
        id: 'browser-clear-session-storage',
        pattern: /^clear\s+session\s+storage$/i,
        category: 'action',
        intent: 'clear-storage',
        priority: 511,
        extract: () => ({
            targetText: '',
            params: { storageType: 'session' as const }
        }),
        examples: ['Clear session storage']
    },
    {
        id: 'browser-clear-all-storage',
        pattern: /^clear\s+(?:all\s+)?storage$/i,
        category: 'action',
        intent: 'clear-storage',
        priority: 512,
        extract: () => ({
            targetText: ''
        }),
        examples: ['Clear all storage', 'Clear storage']
    },
    {
        id: 'browser-set-local-storage',
        pattern: /^set\s+local\s+storage\s+__QUOTED_(\d+)__\s+to\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'set-storage-item',
        priority: 513,
        extract: (match, quotedStrings) => {
            const key = quotedStrings[parseInt(match[1])] || '';
            const value = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                value,
                params: { storageType: 'local' as const, storageKey: key }
            };
        },
        examples: ["Set local storage 'theme' to 'dark'"]
    },
    {
        id: 'browser-set-session-storage',
        pattern: /^set\s+session\s+storage\s+__QUOTED_(\d+)__\s+to\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'set-storage-item',
        priority: 514,
        extract: (match, quotedStrings) => {
            const key = quotedStrings[parseInt(match[1])] || '';
            const value = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                value,
                params: { storageType: 'session' as const, storageKey: key }
            };
        },
        examples: ["Set session storage 'token' to 'abc123'"]
    },
    {
        id: 'browser-get-local-storage',
        pattern: /^(?:get|read)\s+local\s+storage\s+(?:item\s+)?__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-storage-item',
        priority: 515,
        extract: (match, quotedStrings) => {
            const key = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { storageType: 'local' as const, storageKey: key }
            };
        },
        examples: ["Get local storage item 'theme'", "Read local storage 'userId'"]
    },
    {
        id: 'browser-get-session-storage',
        pattern: /^(?:get|read)\s+session\s+storage\s+(?:item\s+)?__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-storage-item',
        priority: 516,
        extract: (match, quotedStrings) => {
            const key = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { storageType: 'session' as const, storageKey: key }
            };
        },
        examples: ["Get session storage item 'token'", "Read session storage 'auth'"]
    }
];
