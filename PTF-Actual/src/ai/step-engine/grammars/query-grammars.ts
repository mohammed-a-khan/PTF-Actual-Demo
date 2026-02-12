/**
 * Query Grammar Rules
 *
 * ~10 grammar rules for query intents: get text, get value, get count, check exists, etc.
 * Query results are returned by the csAI() function for use in subsequent steps.
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
        [/\b(?:dropdown|drop-down|select|combobox)\b/, 'dropdown'],
        [/\b(?:tab)\b/, 'tab'],
        [/\b(?:heading|header)\b/, 'heading'],
        [/\b(?:table)\b/, 'table'],
        [/\b(?:row)\b/, 'row'],
        [/\b(?:cell)\b/, 'cell'],
        [/\b(?:image|icon|img)\b/, 'image']
    ];
    for (const [regex, type] of typeMap) {
        if (regex.test(lower)) return type;
    }
    return undefined;
}

/** Strip trailing element type words */
function stripElementType(text: string): string {
    return text.replace(/\s+(button|btn|link|field|input|textbox|checkbox|dropdown|tab|heading|header|icon|image|table|row|cell|element|text|label|section|area|column)$/i, '').trim();
}

export const QUERY_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // GET TEXT / VALUE (Priority 200-209)
    // ========================================================================
    {
        id: 'query-get-text-from',
        pattern: /^(?:get|read|extract|fetch|retrieve|capture|grab)\s+(?:the\s+)?(?:text|content|label)\s+(?:from|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-text',
        priority: 200,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'Get the text from the heading',
            'Read the content of the error message',
            'Extract the label from the first row'
        ]
    },
    {
        id: 'query-get-text-of',
        pattern: /^(?:get|read|extract|fetch|retrieve|capture|grab)\s+(?:the\s+)?(.+?)(?:'s)?\s+text$/i,
        category: 'query',
        intent: 'get-text',
        priority: 201,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            "Get the heading's text",
            'Get the error message text',
            "Read the button's text"
        ]
    },
    {
        id: 'query-get-value-from',
        pattern: /^(?:get|read|extract|fetch|retrieve|capture|grab)\s+(?:the\s+)?(?:value)\s+(?:from|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-value',
        priority: 202,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'input'
            };
        },
        examples: [
            'Get the value from the Email field',
            'Read the value of the search input'
        ]
    },

    // ========================================================================
    // GET ATTRIBUTE (Priority 210-219)
    // ========================================================================
    {
        id: 'query-get-attribute',
        pattern: /^(?:get|read|extract|fetch|retrieve)\s+(?:the\s+)?(?:attribute\s+)?__QUOTED_(\d+)__\s+(?:attribute\s+)?(?:from|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-attribute',
        priority: 210,
        extract: (match, quotedStrings) => {
            const attribute = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                params: { attribute }
            };
        },
        examples: [
            "Get the 'href' attribute from the link",
            "Read 'data-id' from the row"
        ]
    },
    {
        id: 'query-get-attribute-of',
        pattern: /^(?:get|read|extract|fetch|retrieve)\s+(?:the\s+)?(.+?)\s+attribute\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-attribute',
        priority: 211,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const attribute = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                params: { attribute }
            };
        },
        examples: ["Get the link attribute 'href'"]
    },

    // ========================================================================
    // GET COUNT / LIST (Priority 220-229)
    // ========================================================================
    {
        id: 'query-get-count',
        pattern: /^(?:get|count|read)\s+(?:the\s+)?(?:number\s+of|count\s+of|total\s+)\s*(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-count',
        priority: 220,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'Get the number of rows',
            'Count the total items',
            'Get the count of buttons'
        ]
    },
    {
        id: 'query-how-many',
        pattern: /^how\s+many\s+(.+?)\s+(?:are\s+there|exist|are\s+(?:visible|displayed|shown|present))(?:\?)?$/i,
        category: 'query',
        intent: 'get-count',
        priority: 221,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'How many rows are there?',
            'How many buttons are visible?'
        ]
    },
    {
        id: 'query-get-list',
        pattern: /^(?:get|read|extract|list)\s+(?:all\s+)?(?:the\s+)?(?:text|values?|items?|options?)\s+(?:from|of|in)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-list',
        priority: 222,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'Get all the options from the dropdown',
            'List all items in the table',
            'Get all values from the list'
        ]
    },

    // ========================================================================
    // CHECK EXISTS (Priority 230-239)
    // ========================================================================
    {
        id: 'query-check-exists',
        pattern: /^(?:check|does|is)\s+(?:if\s+)?(?:there\s+(?:is|are)\s+)?(?:the\s+)?(.+?)(?:\s+(?:exist|exists|present|there))?(?:\?)?$/i,
        category: 'query',
        intent: 'check-exists',
        priority: 230,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'Check if there are error messages',
            'Is there a loading spinner?',
            'Does the Submit button exist?'
        ]
    },

    // ========================================================================
    // GET URL / TITLE (Priority 240-249)
    // ========================================================================
    {
        id: 'query-get-url',
        pattern: /^(?:get|read|extract)\s+(?:the\s+)?(?:current\s+)?(?:url|URL|page\s+url)$/i,
        category: 'query',
        intent: 'get-url',
        priority: 240,
        extract: () => ({
            targetText: ''
        }),
        examples: ['Get the current URL', 'Get the page url', 'Read the URL']
    },
    {
        id: 'query-get-title',
        pattern: /^(?:get|read|extract)\s+(?:the\s+)?(?:page\s+)?title$/i,
        category: 'query',
        intent: 'get-title',
        priority: 241,
        extract: () => ({
            targetText: ''
        }),
        examples: ['Get the page title', 'Read the title']
    },

    // ========================================================================
    // URL PARAMETER QUERIES (Priority 242-243) — Phase 5
    // ========================================================================
    {
        id: 'query-get-url-param',
        pattern: /^(?:get|read|extract)\s+(?:the\s+)?url\s+parameter\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-url-param',
        priority: 242,
        extract: (match, quotedStrings) => {
            const urlParam = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { urlParam }
            };
        },
        examples: [
            "Get the URL parameter 'id'",
            "Read the URL parameter 'token'"
        ]
    },
    {
        id: 'query-get-url-param-alt',
        pattern: /^(?:get|read|extract)\s+(?:the\s+)?(?:value\s+of\s+)?(?:url|URL)\s+(?:param|parameter|query\s+param)\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-url-param',
        priority: 243,
        extract: (match, quotedStrings) => {
            const urlParam = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { urlParam }
            };
        },
        examples: [
            "Get the value of URL param 'session'",
            "Extract URL query param 'page'"
        ]
    }
];
