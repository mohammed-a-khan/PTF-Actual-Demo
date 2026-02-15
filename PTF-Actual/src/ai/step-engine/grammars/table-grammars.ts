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
    },

    // ========================================================================
    // TABLE ROW EXPAND/COLLAPSE (Priority 440-442)
    // ========================================================================
    {
        id: 'tbl-expand-row',
        pattern: /^expand\s+row\s+__QUOTED_(\d+)__\s+(?:in|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'expand-row',
        priority: 440,
        extract: (match, quotedStrings) => {
            const rowIndex = parseInt(quotedStrings[parseInt(match[1])] || '1');
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                params: { rowIndex, expandAction: 'expand' }
            };
        },
        examples: [
            "Expand row '1' in the table",
            "Expand row '3' of the results table"
        ]
    },
    {
        id: 'tbl-expand-row-by-text',
        pattern: /^expand\s+(?:the\s+)?row\s+containing\s+__QUOTED_(\d+)__\s+(?:in|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'expand-row',
        priority: 441,
        extract: (match, quotedStrings) => {
            const searchText = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                value: searchText,
                params: { expandAction: 'expand' }
            };
        },
        examples: [
            "Expand the row containing 'A100' in the table",
            "Expand the row containing 'Pending' in the results table"
        ]
    },
    {
        id: 'tbl-collapse-row',
        pattern: /^collapse\s+row\s+__QUOTED_(\d+)__\s+(?:in|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'collapse-row',
        priority: 442,
        extract: (match, quotedStrings) => {
            const rowIndex = parseInt(quotedStrings[parseInt(match[1])] || '1');
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                params: { rowIndex, expandAction: 'collapse' }
            };
        },
        examples: [
            "Collapse row '1' in the table",
            "Collapse row '2' of the results table"
        ]
    },

    // ========================================================================
    // TABLE CELL-TYPE INTERACTIONS (Priority 443-446)
    // ========================================================================
    {
        id: 'tbl-click-cell-link',
        pattern: /^click\s+(?:the\s+)?link\s+in\s+row\s+__QUOTED_(\d+)__\s+column\s+__QUOTED_(\d+)__\s+(?:of|in)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'click',
        priority: 443,
        extract: (match, quotedStrings) => {
            const rowIndex = parseInt(quotedStrings[parseInt(match[1])] || '1');
            const columnRef = quotedStrings[parseInt(match[2])] || '';
            const raw = resolveQuoted(match[3], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                params: { rowIndex, columnRef, cellElementType: 'link' }
            };
        },
        examples: [
            "Click the link in row '1' column 'Name' of the table",
            "Click the link in row '2' column 'Details' in the results table"
        ]
    },
    {
        id: 'tbl-check-cell-checkbox',
        pattern: /^check\s+(?:the\s+)?checkbox\s+in\s+row\s+__QUOTED_(\d+)__\s+column\s+__QUOTED_(\d+)__\s+(?:of|in)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'check',
        priority: 444,
        extract: (match, quotedStrings) => {
            const rowIndex = parseInt(quotedStrings[parseInt(match[1])] || '1');
            const columnRef = quotedStrings[parseInt(match[2])] || '';
            const raw = resolveQuoted(match[3], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                params: { rowIndex, columnRef, cellElementType: 'checkbox' }
            };
        },
        examples: [
            "Check the checkbox in row '2' column 'Select' of the table",
            "Check the checkbox in row '1' column 'Active' in the results table"
        ]
    },
    {
        id: 'tbl-select-cell-dropdown',
        pattern: /^select\s+__QUOTED_(\d+)__\s+from\s+(?:the\s+)?dropdown\s+in\s+row\s+__QUOTED_(\d+)__\s+column\s+__QUOTED_(\d+)__\s+(?:of|in)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'select',
        priority: 445,
        extract: (match, quotedStrings) => {
            const value = quotedStrings[parseInt(match[1])] || '';
            const rowIndex = parseInt(quotedStrings[parseInt(match[2])] || '1');
            const columnRef = quotedStrings[parseInt(match[3])] || '';
            const raw = resolveQuoted(match[4], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                value,
                params: { rowIndex, columnRef, cellElementType: 'dropdown' }
            };
        },
        examples: [
            "Select 'Approved' from the dropdown in row '1' column 'Status' of the table"
        ]
    },
    {
        id: 'tbl-get-cell-checkbox-state',
        pattern: /^get\s+(?:the\s+)?checkbox\s+state\s+from\s+row\s+__QUOTED_(\d+)__\s+column\s+__QUOTED_(\d+)__\s+(?:of|in)\s+(?:the\s+)?(.+?)$/i,
        category: 'query',
        intent: 'get-table-cell',
        priority: 446,
        extract: (match, quotedStrings) => {
            const rowIndex = parseInt(quotedStrings[parseInt(match[1])] || '1');
            const columnRef = quotedStrings[parseInt(match[2])] || '';
            const raw = resolveQuoted(match[3], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'table',
                params: { rowIndex, columnRef, cellElementType: 'checkbox' }
            };
        },
        examples: [
            "Get the checkbox state from row '1' column 'Active' of the table"
        ]
    },

    // ========================================================================
    // TABLE SORT & COLUMN VERIFICATION (Priority 447-452)
    // ========================================================================
    {
        id: 'tbl-verify-sort-asc',
        pattern: /^verify\s+(?:that\s+)?column\s+__QUOTED_(\d+)__\s+is\s+sorted\s+ascending$/i,
        category: 'assertion',
        intent: 'verify-column-sorted',
        priority: 447,
        extract: (match, quotedStrings) => ({
            targetText: '',
            elementType: 'table',
            params: {
                columnRef: quotedStrings[parseInt(match[1])] || '',
                sortDirection: 'ascending',
                sortDataType: 'string'
            }
        }),
        examples: [
            "Verify column 'Name' is sorted ascending",
            "Verify that column 'Date' is sorted ascending"
        ]
    },
    {
        id: 'tbl-verify-sort-desc',
        pattern: /^verify\s+(?:that\s+)?column\s+__QUOTED_(\d+)__\s+is\s+sorted\s+descending$/i,
        category: 'assertion',
        intent: 'verify-column-sorted',
        priority: 448,
        extract: (match, quotedStrings) => ({
            targetText: '',
            elementType: 'table',
            params: {
                columnRef: quotedStrings[parseInt(match[1])] || '',
                sortDirection: 'descending',
                sortDataType: 'string'
            }
        }),
        examples: [
            "Verify column 'Amount' is sorted descending",
            "Verify that column 'Price' is sorted descending"
        ]
    },
    {
        id: 'tbl-verify-sort-date-asc',
        pattern: /^verify\s+(?:that\s+)?column\s+__QUOTED_(\d+)__\s+is\s+sorted\s+ascending\s+as\s+dates?$/i,
        category: 'assertion',
        intent: 'verify-column-sorted',
        priority: 449,
        extract: (match, quotedStrings) => ({
            targetText: '',
            elementType: 'table',
            params: {
                columnRef: quotedStrings[parseInt(match[1])] || '',
                sortDirection: 'ascending',
                sortDataType: 'date'
            }
        }),
        examples: [
            "Verify column 'Created' is sorted ascending as dates",
            "Verify that column 'Modified' is sorted ascending as date"
        ]
    },
    {
        id: 'tbl-sort-by-click',
        pattern: /^click\s+column\s+header\s+__QUOTED_(\d+)__\s+to\s+sort$/i,
        category: 'action',
        intent: 'sort-column',
        priority: 450,
        extract: (match, quotedStrings) => ({
            targetText: quotedStrings[parseInt(match[1])] || '',
            elementType: 'columnheader'
        }),
        examples: [
            "Click column header 'Name' to sort",
            "Click column header 'Date' to sort"
        ]
    },
    {
        id: 'tbl-verify-col-exists',
        pattern: /^verify\s+(?:that\s+)?column\s+__QUOTED_(\d+)__\s+exists?\s+in\s+(?:the\s+)?table$/i,
        category: 'assertion',
        intent: 'verify-column-exists',
        priority: 451,
        extract: (match, quotedStrings) => ({
            targetText: '',
            elementType: 'table',
            params: { columnRef: quotedStrings[parseInt(match[1])] || '' }
        }),
        examples: [
            "Verify column 'Status' exists in table",
            "Verify that column 'Name' exists in the table"
        ]
    },
    {
        id: 'tbl-verify-col-not-exists',
        pattern: /^verify\s+(?:that\s+)?column\s+__QUOTED_(\d+)__\s+does\s+not\s+exist\s+in\s+(?:the\s+)?table$/i,
        category: 'assertion',
        intent: 'verify-column-exists',
        priority: 452,
        extract: (match, quotedStrings) => ({
            targetText: '',
            elementType: 'table',
            params: {
                columnRef: quotedStrings[parseInt(match[1])] || '',
                comparisonOp: 'not-exists'
            }
        }),
        examples: [
            "Verify column 'Internal ID' does not exist in table",
            "Verify that column 'Hidden' does not exist in the table"
        ]
    }
];
