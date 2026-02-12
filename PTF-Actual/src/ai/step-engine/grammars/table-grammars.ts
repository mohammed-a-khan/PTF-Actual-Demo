/**
 * Table Grammar Rules (Phase 6)
 *
 * Grammar rules for table data operations: capture table data, get cell/column values,
 * count rows, verify table cell values.
 * Priority range: 400-449
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
    if (/\btable\b/.test(lower)) return 'table';
    if (/\bgrid\b/.test(lower)) return 'grid';
    return undefined;
}

/** Strip trailing element type words */
function stripElementType(text: string): string {
    return text.replace(/\s+(table|grid|list|element)$/i, '').trim();
}

export const TABLE_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // TABLE DATA CAPTURE (Priority 400-409)
    // ========================================================================
    {
        id: 'table-get-all-data',
        pattern: /^(?:get|capture|extract|read)\s+(?:all\s+)?(?:the\s+)?(?:data|content|rows)\s+from\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-table-data',
        priority: 400,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table'
            };
        },
        examples: [
            'Get all data from the results table',
            'Capture the data from the users table',
            'Extract all rows from the table'
        ]
    },
    {
        id: 'table-capture-data',
        pattern: /^capture\s+(?:the\s+)?table\s+(?:data|content)$/i,
        category: 'query',
        intent: 'get-table-data',
        priority: 401,
        extract: () => ({
            targetText: '',
            elementType: 'table'
        }),
        examples: ['Capture the table data', 'Capture table content']
    },

    // ========================================================================
    // TABLE CELL ACCESS (Priority 410-419)
    // ========================================================================
    {
        id: 'table-get-cell-by-index',
        pattern: /^(?:get|read)\s+(?:the\s+)?value\s+from\s+row\s+(\d+)\s+column\s+(\d+)\s+(?:of|in|from)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-table-cell',
        priority: 410,
        extract: (match, quotedStrings) => {
            const rowIndex = parseInt(match[1]);
            const columnRef = match[2];
            const raw = resolveQuoted(match[3], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                params: { rowIndex, columnRef }
            };
        },
        examples: [
            'Get the value from row 2 column 3 of the table',
            'Read the value from row 1 column 1 of the results table'
        ]
    },
    {
        id: 'table-get-cell-by-header',
        pattern: /^(?:get|read)\s+(?:the\s+)?value\s+from\s+row\s+(\d+)\s+column\s+__QUOTED_(\d+)__\s+(?:of|in|from)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-table-cell',
        priority: 411,
        extract: (match, quotedStrings) => {
            const rowIndex = parseInt(match[1]);
            const columnRef = quotedStrings[parseInt(match[2])] || '';
            const raw = resolveQuoted(match[3], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                params: { rowIndex, columnRef }
            };
        },
        examples: [
            "Get the value from row 2 column 'Price' of the table",
            "Read the value from row 1 column 'Status' of the results table"
        ]
    },

    // ========================================================================
    // TABLE COLUMN ACCESS (Priority 420-424)
    // ========================================================================
    {
        id: 'table-get-column-by-header',
        pattern: /^(?:get|read|extract)\s+(?:all\s+)?(?:the\s+)?values?\s+from\s+column\s+__QUOTED_(\d+)__\s+(?:of|in|from)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-table-column',
        priority: 420,
        extract: (match, quotedStrings) => {
            const columnRef = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                params: { columnRef }
            };
        },
        examples: [
            "Get all values from column 'Name' in the table",
            "Extract values from column 'Status' of the users table"
        ]
    },
    {
        id: 'table-get-column-by-index',
        pattern: /^(?:get|read|extract)\s+(?:all\s+)?(?:the\s+)?values?\s+from\s+column\s+(\d+)\s+(?:of|in|from)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-table-column',
        priority: 421,
        extract: (match, quotedStrings) => {
            const columnRef = match[1];
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                params: { columnRef }
            };
        },
        examples: [
            'Get all values from column 3 in the table',
            'Read values from column 1 of the results table'
        ]
    },

    // ========================================================================
    // TABLE ROW COUNT (Priority 425-429)
    // ========================================================================
    {
        id: 'table-get-row-count',
        pattern: /^(?:get|count|read)\s+(?:the\s+)?(?:number\s+of\s+)?rows\s+(?:in|of|from)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-table-row-count',
        priority: 425,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table'
            };
        },
        examples: [
            'Get the number of rows in the table',
            'Count rows in the results table',
            'Get rows of the users table'
        ]
    },

    // ========================================================================
    // TABLE CELL VERIFICATION (Priority 430-439)
    // ========================================================================
    {
        id: 'table-verify-cell-by-header',
        pattern: /^(?:verify|assert|check)\s+(?:that\s+)?row\s+(\d+)\s+column\s+__QUOTED_(\d+)__\s+(?:of|in|from)\s+(?:the\s+)?(.+?)\s+(?:is|equals?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-table-cell',
        priority: 430,
        extract: (match, quotedStrings) => {
            const rowIndex = parseInt(match[1]);
            const columnRef = quotedStrings[parseInt(match[2])] || '';
            const raw = resolveQuoted(match[3], quotedStrings).trim();
            const expectedValue = quotedStrings[parseInt(match[4])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                expectedValue,
                params: { rowIndex, columnRef }
            };
        },
        examples: [
            "Verify row 2 column 'Status' of the table is 'Active'",
            "Assert row 1 column 'Name' in the results table equals 'John'"
        ]
    },
    {
        id: 'table-verify-cell-by-index',
        pattern: /^(?:verify|assert|check)\s+(?:that\s+)?row\s+(\d+)\s+column\s+(\d+)\s+(?:of|in|from)\s+(?:the\s+)?(.+?)\s+(?:is|equals?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-table-cell',
        priority: 431,
        extract: (match, quotedStrings) => {
            const rowIndex = parseInt(match[1]);
            const columnRef = match[2];
            const raw = resolveQuoted(match[3], quotedStrings).trim();
            const expectedValue = quotedStrings[parseInt(match[4])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                expectedValue,
                params: { rowIndex, columnRef }
            };
        },
        examples: [
            "Verify row 1 column 2 of the table is 'Active'",
            "Check row 3 column 1 in the results table equals 'USD'"
        ]
    }
];
