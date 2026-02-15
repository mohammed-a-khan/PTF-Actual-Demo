/**
 * Comparison Grammar Rules (Phase 5)
 *
 * Grammar rules for data comparison operations: tolerance-based value checks,
 * context field verification, context-to-context matching, count comparisons,
 * array data matching with key fields and mapping files, and accumulated
 * field comparison with order-independent support.
 *
 * Priority range: 650-699
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

export const COMPARISON_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // TOLERANCE-BASED VALUE COMPARISON (Priority 650-654)
    // ========================================================================
    {
        id: 'cmp-tolerance',
        pattern: /^verify\s+__QUOTED_(\d+)__\s+equals?\s+__QUOTED_(\d+)__\s+within\s+tolerance\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-tolerance',
        priority: 650,
        extract: (match, quotedStrings) => {
            const actual = quotedStrings[parseInt(match[1])] || '';
            const expected = quotedStrings[parseInt(match[2])] || '';
            const tolerance = parseFloat(quotedStrings[parseInt(match[3])] || '0');
            return {
                targetText: '',
                expectedValue: expected,
                value: actual,
                params: { tolerance }
            };
        },
        examples: [
            "Verify '100.005' equals '100.00' within tolerance '0.01'",
            "Verify '3.14159' equals '3.14' within tolerance '0.01'",
            "Verify '999.99' equals '1000' within tolerance '0.5'"
        ]
    },
    {
        id: 'cmp-context-field-is',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+field\s+__QUOTED_(\d+)__\s+is\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-context-field',
        priority: 651,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const contextField = quotedStrings[parseInt(match[2])] || '';
            const expectedValue = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { sourceContextVar, contextField }
            };
        },
        examples: [
            "Verify context 'recordData' field 'status' is 'ACTIVE'",
            "Verify context 'userData' field 'role' is 'admin'",
            "Verify context 'orderDetails' field 'currency' is 'USD'"
        ]
    },
    {
        id: 'cmp-context-field-contains',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+field\s+__QUOTED_(\d+)__\s+contains?\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-context-field',
        priority: 652,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const contextField = quotedStrings[parseInt(match[2])] || '';
            const expectedValue = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { sourceContextVar, contextField, comparisonOp: 'contains' }
            };
        },
        examples: [
            "Verify context 'recordData' field 'description' contains 'approved'",
            "Verify context 'searchResult' field 'name' contains 'test'",
            "Verify context 'logEntry' field 'message' contains 'success'"
        ]
    },
    {
        id: 'cmp-context-field-tolerance',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+field\s+__QUOTED_(\d+)__\s+equals?\s+__QUOTED_(\d+)__\s+within\s+tolerance\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-context-field',
        priority: 653,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const contextField = quotedStrings[parseInt(match[2])] || '';
            const expectedValue = quotedStrings[parseInt(match[3])] || '';
            const tolerance = parseFloat(quotedStrings[parseInt(match[4])] || '0');
            return {
                targetText: '',
                expectedValue,
                params: { sourceContextVar, contextField, tolerance }
            };
        },
        examples: [
            "Verify context 'financialData' field 'balance' equals '1000.50' within tolerance '0.01'",
            "Verify context 'metrics' field 'rate' equals '3.14' within tolerance '0.001'",
            "Verify context 'summary' field 'total' equals '500' within tolerance '0.5'"
        ]
    },
    {
        id: 'cmp-context-field-not',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+field\s+__QUOTED_(\d+)__\s+is\s+not\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-context-field',
        priority: 654,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const contextField = quotedStrings[parseInt(match[2])] || '';
            const expectedValue = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { sourceContextVar, contextField, comparisonOp: 'not-equals' }
            };
        },
        examples: [
            "Verify context 'recordData' field 'status' is not 'DELETED'",
            "Verify context 'userData' field 'role' is not 'guest'",
            "Verify context 'orderDetails' field 'state' is not 'cancelled'"
        ]
    },

    // ========================================================================
    // CONTEXT-TO-CONTEXT MATCHING (Priority 660-662)
    // ========================================================================
    {
        id: 'cmp-context-match',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+matches?\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-context-match',
        priority: 660,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const targetContextVar = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { sourceContextVar, targetContextVar }
            };
        },
        examples: [
            "Verify context 'beforeData' matches context 'afterData'",
            "Verify context 'expectedRecord' matches context 'actualRecord'",
            "Verify context 'sourceRow' matches context 'targetRow'"
        ]
    },
    {
        id: 'cmp-context-match-except',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+matches?\s+context\s+__QUOTED_(\d+)__\s+except\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-context-match',
        priority: 661,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const targetContextVar = quotedStrings[parseInt(match[2])] || '';
            const exceptFields = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                params: { sourceContextVar, targetContextVar, exceptFields }
            };
        },
        examples: [
            "Verify context 'beforeData' matches context 'afterData' except 'timestamp, modifiedBy'",
            "Verify context 'original' matches context 'updated' except 'id, createdDate'",
            "Verify context 'expected' matches context 'actual' except 'version'"
        ]
    },
    {
        id: 'cmp-context-match-tolerance',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+matches?\s+context\s+__QUOTED_(\d+)__\s+with\s+tolerance\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-context-match',
        priority: 662,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const targetContextVar = quotedStrings[parseInt(match[2])] || '';
            const tolerance = parseFloat(quotedStrings[parseInt(match[3])] || '0');
            return {
                targetText: '',
                params: { sourceContextVar, targetContextVar, tolerance }
            };
        },
        examples: [
            "Verify context 'calculatedTotals' matches context 'expectedTotals' with tolerance '0.01'",
            "Verify context 'dbValues' matches context 'uiValues' with tolerance '0.001'",
            "Verify context 'beforeAmounts' matches context 'afterAmounts' with tolerance '0.5'"
        ]
    },

    // ========================================================================
    // COUNT COMPARISONS (Priority 670-673)
    // ========================================================================
    {
        id: 'cmp-count-match',
        pattern: /^verify\s+count\s+of\s+context\s+__QUOTED_(\d+)__\s+equals?\s+count\s+of\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-count-match',
        priority: 670,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const targetContextVar = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { sourceContextVar, targetContextVar }
            };
        },
        examples: [
            "Verify count of context 'dbRecords' equals count of context 'uiRows'",
            "Verify count of context 'sourceList' equals count of context 'targetList'",
            "Verify count of context 'beforeItems' equals count of context 'afterItems'"
        ]
    },
    {
        id: 'cmp-count-is',
        pattern: /^verify\s+count\s+of\s+context\s+__QUOTED_(\d+)__\s+is\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-count-match',
        priority: 671,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { sourceContextVar }
            };
        },
        examples: [
            "Verify count of context 'searchResults' is '10'",
            "Verify count of context 'activeRecords' is '5'",
            "Verify count of context 'filteredItems' is '0'"
        ]
    },
    {
        id: 'cmp-count-gt',
        pattern: /^verify\s+count\s+of\s+context\s+__QUOTED_(\d+)__\s+is\s+greater\s+than\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-count-match',
        priority: 672,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { sourceContextVar, comparisonOp: 'greater-than' }
            };
        },
        examples: [
            "Verify count of context 'searchResults' is greater than '0'",
            "Verify count of context 'activeRecords' is greater than '5'",
            "Verify count of context 'logEntries' is greater than '100'"
        ]
    },
    {
        id: 'cmp-count-lt',
        pattern: /^verify\s+count\s+of\s+context\s+__QUOTED_(\d+)__\s+is\s+less\s+than\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-count-match',
        priority: 673,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { sourceContextVar, comparisonOp: 'less-than' }
            };
        },
        examples: [
            "Verify count of context 'errorList' is less than '10'",
            "Verify count of context 'pendingItems' is less than '100'",
            "Verify count of context 'warningMessages' is less than '5'"
        ]
    },

    // ========================================================================
    // DATA MATCHING (Priority 680-682)
    // ========================================================================
    {
        id: 'cmp-data-match',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+data\s+matches?\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-data-match',
        priority: 680,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const targetContextVar = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { sourceContextVar, targetContextVar }
            };
        },
        examples: [
            "Verify context 'dbResults' data matches context 'uiTableData'",
            "Verify context 'exportedData' data matches context 'originalData'",
            "Verify context 'csvRows' data matches context 'expectedRows'"
        ]
    },
    {
        id: 'cmp-data-match-keys',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+data\s+matches?\s+context\s+__QUOTED_(\d+)__\s+using\s+keys?\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-data-match',
        priority: 681,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const targetContextVar = quotedStrings[parseInt(match[2])] || '';
            const keyFields = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                params: { sourceContextVar, targetContextVar, keyFields }
            };
        },
        examples: [
            "Verify context 'dbResults' data matches context 'uiData' using keys 'id, code'",
            "Verify context 'sourceRecords' data matches context 'targetRecords' using key 'recordId'",
            "Verify context 'exportedRows' data matches context 'expectedRows' using keys 'name'"
        ]
    },
    {
        id: 'cmp-data-match-mapping',
        pattern: /^verify\s+context\s+__QUOTED_(\d+)__\s+matches?\s+context\s+__QUOTED_(\d+)__\s+using\s+mapping\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-data-match',
        priority: 682,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const targetContextVar = quotedStrings[parseInt(match[2])] || '';
            const mappingFile = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                params: { sourceContextVar, targetContextVar, mappingFile }
            };
        },
        examples: [
            "Verify context 'dbData' matches context 'uiData' using mapping file 'mappings/field-map.yml'",
            "Verify context 'sourceRecords' matches context 'targetRecords' using mapping file 'config/comparison.json'",
            "Verify context 'exportData' matches context 'importData' using mapping file 'mappings/columns.xlsx'"
        ]
    },

    // ========================================================================
    // ACCUMULATED / ORDER-INDEPENDENT (Priority 690-691)
    // ========================================================================
    {
        id: 'cmp-accumulated',
        pattern: /^verify\s+all\s+fields\s+match\s+between\s+context\s+__QUOTED_(\d+)__\s+and\s+__QUOTED_(\d+)__\s+with\s+tolerance\s+__QUOTED_(\d+)__\s+and\s+order-independent\s+fields\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-accumulated',
        priority: 690,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            const targetContextVar = quotedStrings[parseInt(match[2])] || '';
            const tolerance = parseFloat(quotedStrings[parseInt(match[3])] || '0');
            const orderIndependentFields = quotedStrings[parseInt(match[4])] || '';
            return {
                targetText: '',
                params: { sourceContextVar, targetContextVar, tolerance, orderIndependentFields }
            };
        },
        examples: [
            "Verify all fields match between context 'expected' and 'actual' with tolerance '0.01' and order-independent fields 'tags, categories'",
            "Verify all fields match between context 'dbRecord' and 'uiRecord' with tolerance '0.001' and order-independent fields 'items'",
            "Verify all fields match between context 'source' and 'target' with tolerance '0.5' and order-independent fields 'codes, labels'"
        ]
    },
    {
        id: 'cmp-order-independent',
        pattern: /^verify\s+__QUOTED_(\d+)__\s+matches?\s+__QUOTED_(\d+)__\s+order\s+independent$/i,
        category: 'assertion',
        intent: 'verify-tolerance',
        priority: 691,
        extract: (match, quotedStrings) => {
            const actual = quotedStrings[parseInt(match[1])] || '';
            const expected = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                value: actual,
                expectedValue: expected,
                params: { comparisonOp: 'order-independent' }
            };
        },
        examples: [
            "Verify 'B, A, C' matches 'A, B, C' order independent",
            "Verify 'red, blue, green' matches 'green, red, blue' order independent",
            "Verify 'item3, item1, item2' matches 'item1, item2, item3' order independent"
        ]
    }
];
