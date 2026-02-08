/**
 * Assertion Grammar Rules
 *
 * ~15 grammar rules for assertion intents: verify visible, text, enabled, count, etc.
 * Handles both positive and negated assertions.
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

/** Helper to resolve a quoted placeholder back to its value */
function resolveQuoted(text: string, quotedStrings: string[]): string {
    return text.replace(/__QUOTED_(\d+)__/g, (_, idx) => quotedStrings[parseInt(idx)] || '');
}

/** Helper to extract element type from target text */
function inferElementType(text: string): string | undefined {
    const lower = text.toLowerCase().trim();
    const typeMap: [RegExp, string][] = [
        [/\b(?:button|btn)\b/, 'button'],
        [/\b(?:link|hyperlink)\b/, 'link'],
        [/\b(?:input|field|textbox|text\s+box)\b/, 'input'],
        [/\b(?:checkbox|check\s+box)\b/, 'checkbox'],
        [/\b(?:radio)\b/, 'radio'],
        [/\b(?:dropdown|drop-down|select|combobox)\b/, 'dropdown'],
        [/\b(?:tab)\b/, 'tab'],
        [/\b(?:menu\s*item)\b/, 'menuitem'],
        [/\b(?:heading|header)\b/, 'heading'],
        [/\b(?:dialog|modal|popup)\b/, 'dialog'],
        [/\b(?:image|icon|img)\b/, 'image'],
        [/\b(?:switch|toggle)\b/, 'switch']
    ];
    for (const [regex, type] of typeMap) {
        if (regex.test(lower)) return type;
    }
    return undefined;
}

/** Strip trailing element type words */
function stripElementType(text: string): string {
    return text.replace(/\s+(button|btn|link|field|input|textbox|checkbox|radio|dropdown|tab|menu\s*item|heading|header|icon|image|switch|toggle|element|text|message|label|section|area)$/i, '').trim();
}

export const ASSERTION_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // VISIBILITY ASSERTIONS (Priority 100-109)
    // ========================================================================
    {
        id: 'assert-visible',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is\s+)?(?:visible|displayed|shown|present|appearing)$/i,
        category: 'assertion',
        intent: 'verify-visible',
        priority: 100,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'Verify the Dashboard heading is displayed',
            'Assert that the Submit button is visible',
            'Check the error message is shown'
        ]
    },
    {
        id: 'assert-not-visible',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is\s+)?(?:not\s+)?(?:hidden|invisible|not\s+displayed|not\s+visible|not\s+shown|not\s+present)$/i,
        category: 'assertion',
        intent: 'verify-hidden',
        priority: 101,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'Verify the loading spinner is hidden',
            'Assert the error message is not visible',
            'Check that the popup is not displayed'
        ]
    },
    {
        id: 'assert-not-present',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:does\s+not\s+exist|is\s+not\s+present|is\s+gone|has\s+disappeared)$/i,
        category: 'assertion',
        intent: 'verify-not-present',
        priority: 102,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: ['Verify the modal does not exist', 'Check that the alert is gone']
    },

    // ========================================================================
    // TEXT ASSERTIONS (Priority 110-119)
    // ========================================================================
    {
        id: 'assert-text-equals',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:text\s+)?(?:is|equals?|shows?|reads?|says?|has\s+text)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-text',
        priority: 110,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                expectedValue
            };
        },
        examples: [
            "Verify the heading text is 'Welcome'",
            "Assert the title shows 'Dashboard'",
            "Check the label reads 'Email Address'"
        ]
    },
    {
        id: 'assert-contains-text',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:contains?|includes?|has)\s+(?:the\s+)?(?:text\s+)?__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-contains',
        priority: 111,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                expectedValue
            };
        },
        examples: [
            "Verify the message contains 'success'",
            "Assert the paragraph includes 'updated'",
            "Check the notification has 'saved'"
        ]
    },
    {
        id: 'assert-not-contains-text',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:does\s+not\s+contain|doesn't\s+contain|does\s+not\s+include|doesn't\s+include)\s+(?:the\s+)?(?:text\s+)?__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-not-contains',
        priority: 110,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                expectedValue
            };
        },
        examples: [
            "Verify the message does not contain 'error'",
            "Assert the list doesn't include 'deleted item'"
        ]
    },

    // ========================================================================
    // STATE ASSERTIONS (Priority 120-129)
    // ========================================================================
    {
        id: 'assert-enabled',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is\s+)?enabled$/i,
        category: 'assertion',
        intent: 'verify-enabled',
        priority: 120,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: ['Verify the Submit button is enabled', 'Assert that the Save link is enabled']
    },
    {
        id: 'assert-disabled',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is\s+)?(?:disabled|not\s+enabled|greyed\s+out|grayed\s+out)$/i,
        category: 'assertion',
        intent: 'verify-disabled',
        priority: 121,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: ['Verify the Delete button is disabled', 'Assert the input is greyed out']
    },
    {
        id: 'assert-checked',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is\s+)?checked$/i,
        category: 'assertion',
        intent: 'verify-checked',
        priority: 122,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'checkbox'
            };
        },
        examples: ['Verify the Remember Me checkbox is checked', 'Assert Terms is checked']
    },
    {
        id: 'assert-unchecked',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is\s+)?(?:unchecked|not\s+checked)$/i,
        category: 'assertion',
        intent: 'verify-unchecked',
        priority: 123,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'checkbox'
            };
        },
        examples: ['Verify the Newsletter checkbox is unchecked', 'Assert opt-in is not checked']
    },

    // ========================================================================
    // COUNT / VALUE ASSERTIONS (Priority 130-139)
    // ========================================================================
    {
        id: 'assert-count',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:there\s+are|the\s+count\s+of|the\s+number\s+of)\s+(?:the\s+)?(.+?)\s+(?:is|equals?|are)\s+(\d+)$/i,
        category: 'assertion',
        intent: 'verify-count',
        priority: 130,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const count = parseInt(match[2]);
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                params: { count }
            };
        },
        examples: [
            'Verify the number of rows is 5',
            'Assert there are 3 items',
            'Check the count of buttons equals 2'
        ]
    },
    {
        id: 'assert-value',
        // "value" keyword is REQUIRED (not optional) to prevent matching text-equals patterns
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:value\s+(?:is|equals?)|has\s+value)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-value',
        priority: 108,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'input',
                expectedValue
            };
        },
        examples: [
            "Verify the Email field value is 'admin@test.com'",
            "Assert the input has value '100'"
        ]
    },
    {
        id: 'assert-attribute',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:has\s+)?attribute\s+__QUOTED_(\d+)__\s+(?:equal\s+to|equals?|is|with\s+value)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-attribute',
        priority: 109,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const attribute = quotedStrings[parseInt(match[2])] || '';
            const expectedValue = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                expectedValue,
                params: { attribute }
            };
        },
        examples: ["Verify the link has attribute 'href' equal to '/dashboard'"]
    },

    // ========================================================================
    // URL / TITLE ASSERTIONS (Priority 140-149)
    // ========================================================================
    {
        id: 'assert-url',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(?:url|URL|page\s+url|current\s+url)\s+(?:is|equals?|contains?|matches?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-url',
        priority: 106,
        extract: (match, quotedStrings) => {
            const expectedValue = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                expectedValue
            };
        },
        examples: [
            "Verify the URL is '/dashboard'",
            "Assert the page url contains '/login'"
        ]
    },
    {
        id: 'assert-title',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(?:page\s+)?title\s+(?:is|equals?|contains?|matches?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-title',
        priority: 107,
        extract: (match, quotedStrings) => {
            const expectedValue = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                expectedValue
            };
        },
        examples: [
            "Verify the page title is 'Home - My App'",
            "Assert title contains 'Dashboard'"
        ]
    }
];
