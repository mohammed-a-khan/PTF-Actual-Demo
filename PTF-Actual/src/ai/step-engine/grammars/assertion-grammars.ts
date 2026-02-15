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
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is\s+)?(?:visible|displayed|shown|present|appearing|available)(?:\s+(?:on|in|at|within)\s+(?:the\s+)?.+)?$/i,
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
            'Check the error message is shown',
            'Verify Cycle Code header is available',
            'Verify the Report header is displayed on the Summary page'
        ]
    },
    {
        id: 'assert-should-be-available',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+should\s+be\s+(?:visible|displayed|shown|present|available)(?:\s+(?:on|in|at|within)\s+(?:the\s+)?.+)?$/i,
        category: 'assertion',
        intent: 'verify-visible',
        priority: 99,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'Verify Cycle Code header should be available',
            'Check that the Submit button should be visible',
            'Ensure the error message should be displayed',
            'Verify the Report header should be available on the Summary page'
        ]
    },
    {
        id: 'assert-not-visible',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is\s+)?(?:not\s+)?(?:hidden|invisible|not\s+displayed|not\s+visible|not\s+shown|not\s+present)(?:\s+(?:on|in|at|within)\s+(?:the\s+)?.+)?$/i,
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
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:does\s+not\s+exist|is\s+not\s+present|is\s+gone|has\s+disappeared)(?:\s+(?:on|in|at|within)\s+(?:the\s+)?.+)?$/i,
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
    // VALUE-IN-FIELD ASSERTIONS (Priority 98)
    // Handles: Verify 'X' is displayed in the Y field [in the Z section]
    // Must be higher priority than assert-visible to avoid being stolen by it
    // ========================================================================
    {
        id: 'assert-value-displayed-in',
        pattern: /^(?:verify|assert|check|confirm|ensure)\s+(?:that\s+)?__QUOTED_(\d+)__\s+(?:is\s+)?(?:displayed|shown|visible|present|appearing|available)\s+(?:in|on|at|under|within)\s+(?:the\s+)?(.+)$/i,
        category: 'assertion',
        intent: 'verify-text',
        priority: 98,
        extract: (match, quotedStrings) => {
            const expectedValue = quotedStrings[parseInt(match[1])] || '';
            const rawTarget = match[2].trim();
            return {
                targetText: rawTarget,
                elementType: inferElementType(rawTarget),
                expectedValue
            };
        },
        examples: [
            "Verify 'John Smith' is displayed in the Full Name field in the User Details section",
            "Assert 'USD' is shown in the Currency dropdown",
            "Check 'Active' is visible in the Status field on the Details page"
        ]
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
        priority: 112,
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
    },

    // ========================================================================
    // ENHANCED ASSERTIONS (Priority 131-138) — Phase 4
    // ========================================================================
    {
        id: 'assert-css-property',
        pattern: /^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:css|CSS|style)\s+__QUOTED_(\d+)__\s+(?:is|equals?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-css',
        priority: 131,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const cssProperty = quotedStrings[parseInt(match[2])] || '';
            const expectedValue = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                expectedValue,
                params: { cssProperty }
            };
        },
        examples: [
            "Verify the button CSS 'background-color' is 'red'",
            "Assert the heading style 'color' equals 'rgb(0, 0, 0)'"
        ]
    },
    {
        id: 'assert-matches-pattern',
        pattern: /^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:matches?|fits)\s+(?:the\s+)?(?:pattern|regex|format)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-matches',
        priority: 132,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const regexPattern = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                params: { regexPattern }
            };
        },
        examples: [
            "Verify the phone field matches pattern '\\d{3}-\\d{4}'",
            "Check the email field matches regex '^[a-z]+@[a-z]+\\.[a-z]+$'"
        ]
    },
    {
        id: 'assert-selected-option',
        pattern: /^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:selected\s+option|selected\s+value|current\s+selection)\s+(?:is|equals?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-selected-option',
        priority: 133,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'dropdown',
                expectedValue
            };
        },
        examples: [
            "Verify the dropdown selected option is 'USD'",
            "Assert the Currency dropdown selected value is 'EUR'"
        ]
    },
    {
        id: 'assert-dropdown-options',
        pattern: /^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:contains?\s+options?|has\s+options?|options?\s+(?:include|contain))\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-dropdown-options',
        priority: 134,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'dropdown',
                expectedValue
            };
        },
        examples: [
            "Verify the dropdown contains options 'USD, EUR, GBP'",
            "Check the Currency dropdown has options 'USD, EUR'"
        ]
    },
    {
        id: 'assert-text-not-equals',
        pattern: /^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:text\s+)?(?:is\s+not|does\s+not\s+equal)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-text',
        priority: 135,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                expectedValue,
                modifiers: { negated: true }
            };
        },
        examples: [
            "Verify the heading text is not 'Error'",
            "Assert the status does not equal 'Failed'"
        ]
    },

    // ========================================================================
    // URL PARAMETER ASSERTIONS (Priority 104-105) — Phase 5
    // ========================================================================
    {
        id: 'assert-url-param-exists',
        pattern: /^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?url\s+contains?\s+parameter\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-url-param',
        priority: 104,
        extract: (match, quotedStrings) => {
            const urlParam = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { urlParam }
            };
        },
        examples: [
            "Verify the URL contains parameter 'tab'",
            "Check the URL contains parameter 'id'"
        ]
    },
    {
        id: 'assert-url-param-value',
        pattern: /^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?url\s+parameter\s+__QUOTED_(\d+)__\s+(?:is|equals?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-url-param',
        priority: 105,
        extract: (match, quotedStrings) => {
            const urlParam = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { urlParam }
            };
        },
        examples: [
            "Verify the URL parameter 'id' is '12345'",
            "Assert URL parameter 'tab' equals 'details'"
        ]
    },

    // ========================================================================
    // FLEXIBLE "SHOULD BE" ASSERTIONS (Priority 136-138)
    // Catch patterns where user omits the leading verb (e.g., "the header should be visible")
    // ========================================================================
    {
        id: 'assert-should-visible-no-verb',
        pattern: /^(?:the\s+)?(.+?)\s+should\s+(?:be\s+)?(?:visible|displayed|shown|present|available)(?:\s+(?:on|in|at|within)\s+(?:the\s+)?.+)?$/i,
        category: 'assertion',
        intent: 'verify-visible',
        priority: 136,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'The Dashboard header should be visible',
            'Cycle Code header should be available',
            'Submit button should be displayed'
        ]
    },
    {
        id: 'assert-should-hidden-no-verb',
        pattern: /^(?:the\s+)?(.+?)\s+should\s+(?:be\s+)?(?:hidden|not\s+visible|not\s+displayed|not\s+present|gone)(?:\s+(?:on|in|at|within)\s+(?:the\s+)?.+)?$/i,
        category: 'assertion',
        intent: 'verify-hidden',
        priority: 137,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'The loading spinner should be hidden',
            'Error message should not be visible'
        ]
    },
    {
        id: 'assert-should-contain-no-verb',
        pattern: /^(?:the\s+)?(.+?)\s+should\s+(?:contain|include|have\s+text)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-contains',
        priority: 138,
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
            "The heading should contain 'Welcome'",
            "Status message should include 'success'"
        ]
    }
];
