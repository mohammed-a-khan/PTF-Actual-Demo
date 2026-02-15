/**
 * Database Grammar Rules (Phase 2)
 *
 * Grammar rules for database query, verify, count, and resolve operations.
 * Priority range: 550-599
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 * All database operations use named query keys resolved via CSDBUtils,
 * or direct SQL file paths. Consumer projects define their queries in config.
 */

import { GrammarRule } from '../CSAIStepTypes';

export const DATABASE_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // DATABASE QUERY (Priority 550-559)
    // ========================================================================
    {
        id: 'db-query-named',
        pattern: /^query\s+database\s+__QUOTED_(\d+)__\s+with\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'db-query',
        priority: 550,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { dbAlias, dbQuery }
            };
        },
        examples: [
            "Query database 'PRIMARY_DB' with 'FETCH_ACTIVE_RECORDS'",
            "Query database 'STAGING_DB' with 'GET_ALL_ITEMS'"
        ]
    },
    {
        id: 'db-query-named-params',
        pattern: /^query\s+database\s+__QUOTED_(\d+)__\s+with\s+__QUOTED_(\d+)__\s+params\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'db-query',
        priority: 551,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            const dbParams = quotedStrings[parseInt(match[3])] || '[]';
            return {
                targetText: '',
                params: { dbAlias, dbQuery, dbParams }
            };
        },
        examples: [
            "Query database 'PRIMARY_DB' with 'GET_BY_CODE' params '[\"A100\"]'",
            "Query database 'STAGING_DB' with 'GET_BY_ID' params '[42]'"
        ]
    },
    {
        id: 'db-query-file',
        pattern: /^query\s+database\s+__QUOTED_(\d+)__\s+from\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'db-query-file',
        priority: 552,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbFile = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { dbAlias, dbFile }
            };
        },
        examples: [
            "Query database 'PRIMARY_DB' from file 'queries/fetch-items.sql'"
        ]
    },
    {
        id: 'db-query-file-params',
        pattern: /^query\s+database\s+__QUOTED_(\d+)__\s+from\s+file\s+__QUOTED_(\d+)__\s+params\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'db-query-file',
        priority: 553,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbFile = quotedStrings[parseInt(match[2])] || '';
            const dbParams = quotedStrings[parseInt(match[3])] || '[]';
            return {
                targetText: '',
                params: { dbAlias, dbFile, dbParams }
            };
        },
        examples: [
            "Query database 'PRIMARY_DB' from file 'queries/get-by-id.sql' params '[42]'"
        ]
    },

    // ========================================================================
    // DATABASE GET (Priority 560-569) — Single value, row, rows, count
    // ========================================================================
    {
        id: 'db-get-value',
        pattern: /^get\s+database\s+value\s+from\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-db-value',
        priority: 560,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { dbAlias, dbQuery }
            };
        },
        examples: [
            "Get database value from 'PRIMARY_DB' query 'GET_CURRENT_COUNT'"
        ]
    },
    {
        id: 'db-get-value-params',
        pattern: /^get\s+database\s+value\s+from\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__\s+params\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-db-value',
        priority: 561,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            const dbParams = quotedStrings[parseInt(match[3])] || '[]';
            return {
                targetText: '',
                params: { dbAlias, dbQuery, dbParams }
            };
        },
        examples: [
            "Get database value from 'PRIMARY_DB' query 'GET_STATUS' params '[\"A100\"]'"
        ]
    },
    {
        id: 'db-get-row',
        pattern: /^get\s+database\s+row\s+from\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'query',
        intent: 'get-db-row',
        priority: 562,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            const dbParams = match[3] ? quotedStrings[parseInt(match[3])] || '[]' : undefined;
            return {
                targetText: '',
                params: { dbAlias, dbQuery, ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Get database row from 'PRIMARY_DB' query 'GET_ITEM_DETAILS' params '[\"42\"]'",
            "Get database row from 'PRIMARY_DB' query 'GET_FIRST_ACTIVE'"
        ]
    },
    {
        id: 'db-get-rows',
        pattern: /^get\s+database\s+rows\s+from\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'query',
        intent: 'get-db-rows',
        priority: 563,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            const dbParams = match[3] ? quotedStrings[parseInt(match[3])] || '[]' : undefined;
            return {
                targetText: '',
                params: { dbAlias, dbQuery, ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Get database rows from 'PRIMARY_DB' query 'FETCH_ALL_ACTIVE'",
            "Get database rows from 'PRIMARY_DB' query 'GET_BY_STATUS' params '[\"ACTIVE\"]'"
        ]
    },
    {
        id: 'db-get-count',
        pattern: /^get\s+database\s+count\s+from\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'query',
        intent: 'get-db-count',
        priority: 564,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            const dbParams = match[3] ? quotedStrings[parseInt(match[3])] || '[]' : undefined;
            return {
                targetText: '',
                params: { dbAlias, dbQuery, ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Get database count from 'PRIMARY_DB' query 'COUNT_ACTIVE_ITEMS'",
            "Get database count from 'PRIMARY_DB' query 'COUNT_BY_STATUS' params '[\"ACTIVE\"]'"
        ]
    },

    // ========================================================================
    // DATABASE VERIFY (Priority 570-579)
    // ========================================================================
    {
        id: 'db-verify-exists',
        pattern: /^verify\s+(?:that\s+)?database\s+record\s+exists\s+in\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'assertion',
        intent: 'verify-db-exists',
        priority: 570,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            const dbParams = match[3] ? quotedStrings[parseInt(match[3])] || '[]' : undefined;
            return {
                targetText: '',
                params: { dbAlias, dbQuery, ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Verify database record exists in 'PRIMARY_DB' query 'CHECK_EXISTS' params '[\"A100\"]'",
            "Verify that database record exists in 'PRIMARY_DB' query 'CHECK_ITEM'"
        ]
    },
    {
        id: 'db-verify-not-exists',
        pattern: /^verify\s+(?:that\s+)?database\s+record\s+does\s+not\s+exist\s+in\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'assertion',
        intent: 'verify-db-not-exists',
        priority: 571,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            const dbParams = match[3] ? quotedStrings[parseInt(match[3])] || '[]' : undefined;
            return {
                targetText: '',
                params: { dbAlias, dbQuery, ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Verify database record does not exist in 'PRIMARY_DB' query 'CHECK_EXISTS' params '[\"DELETED_01\"]'"
        ]
    },
    {
        id: 'db-verify-field',
        pattern: /^verify\s+(?:that\s+)?database\s+field\s+__QUOTED_(\d+)__\s+(?:is|equals?)\s+__QUOTED_(\d+)__\s+in\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'assertion',
        intent: 'verify-db-field',
        priority: 572,
        extract: (match, quotedStrings) => {
            const dbField = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            const dbAlias = quotedStrings[parseInt(match[3])] || '';
            const dbQuery = quotedStrings[parseInt(match[4])] || '';
            const dbParams = match[5] ? quotedStrings[parseInt(match[5])] || '[]' : undefined;
            return {
                targetText: '',
                expectedValue,
                params: { dbAlias, dbQuery, dbField, comparisonOp: 'equals', ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Verify database field 'status' is 'ACTIVE' in 'PRIMARY_DB' query 'GET_RECORD' params '[\"42\"]'",
            "Verify database field 'name' equals 'Test Item' in 'PRIMARY_DB' query 'GET_ITEM'"
        ]
    },
    {
        id: 'db-verify-field-tolerance',
        pattern: /^verify\s+(?:that\s+)?database\s+field\s+__QUOTED_(\d+)__\s+equals?\s+__QUOTED_(\d+)__\s+within\s+tolerance\s+__QUOTED_(\d+)__\s+in\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'assertion',
        intent: 'verify-db-field',
        priority: 573,
        extract: (match, quotedStrings) => {
            const dbField = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            const tolerance = parseFloat(quotedStrings[parseInt(match[3])] || '0');
            const dbAlias = quotedStrings[parseInt(match[4])] || '';
            const dbQuery = quotedStrings[parseInt(match[5])] || '';
            const dbParams = match[6] ? quotedStrings[parseInt(match[6])] || '[]' : undefined;
            return {
                targetText: '',
                expectedValue,
                params: { dbAlias, dbQuery, dbField, tolerance, comparisonOp: 'equals', ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Verify database field 'amount' equals '100.50' within tolerance '0.01' in 'PRIMARY_DB' query 'GET_TOTAL'"
        ]
    },
    {
        id: 'db-verify-field-contains',
        pattern: /^verify\s+(?:that\s+)?database\s+field\s+__QUOTED_(\d+)__\s+contains?\s+__QUOTED_(\d+)__\s+in\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'assertion',
        intent: 'verify-db-field',
        priority: 574,
        extract: (match, quotedStrings) => {
            const dbField = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            const dbAlias = quotedStrings[parseInt(match[3])] || '';
            const dbQuery = quotedStrings[parseInt(match[4])] || '';
            const dbParams = match[5] ? quotedStrings[parseInt(match[5])] || '[]' : undefined;
            return {
                targetText: '',
                expectedValue,
                params: { dbAlias, dbQuery, dbField, comparisonOp: 'contains', ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Verify database field 'description' contains 'approved' in 'PRIMARY_DB' query 'GET_DETAILS'"
        ]
    },
    {
        id: 'db-verify-count-equals',
        pattern: /^verify\s+(?:that\s+)?database\s+count\s+(?:is|equals?)\s+__QUOTED_(\d+)__\s+in\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'assertion',
        intent: 'verify-db-count',
        priority: 575,
        extract: (match, quotedStrings) => {
            const expectedValue = quotedStrings[parseInt(match[1])] || '';
            const dbAlias = quotedStrings[parseInt(match[2])] || '';
            const dbQuery = quotedStrings[parseInt(match[3])] || '';
            const dbParams = match[4] ? quotedStrings[parseInt(match[4])] || '[]' : undefined;
            return {
                targetText: '',
                expectedValue,
                params: { dbAlias, dbQuery, comparisonOp: 'equals', ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Verify database count is '5' in 'PRIMARY_DB' query 'COUNT_ITEMS' params '[\"ACTIVE\"]'",
            "Verify database count equals '10' in 'PRIMARY_DB' query 'COUNT_ALL'"
        ]
    },
    {
        id: 'db-verify-count-gt',
        pattern: /^verify\s+(?:that\s+)?database\s+count\s+is\s+greater\s+than\s+__QUOTED_(\d+)__\s+in\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'assertion',
        intent: 'verify-db-count',
        priority: 576,
        extract: (match, quotedStrings) => {
            const expectedValue = quotedStrings[parseInt(match[1])] || '';
            const dbAlias = quotedStrings[parseInt(match[2])] || '';
            const dbQuery = quotedStrings[parseInt(match[3])] || '';
            const dbParams = match[4] ? quotedStrings[parseInt(match[4])] || '[]' : undefined;
            return {
                targetText: '',
                expectedValue,
                params: { dbAlias, dbQuery, comparisonOp: 'greater-than', ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Verify database count is greater than '0' in 'PRIMARY_DB' query 'COUNT_ITEMS'"
        ]
    },

    // ========================================================================
    // DATABASE UPDATE (Priority 580-584)
    // ========================================================================
    {
        id: 'db-update',
        pattern: /^execute\s+database\s+update\s+in\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__(?:\s+params\s+__QUOTED_(\d+)__)?$/i,
        category: 'action',
        intent: 'db-update',
        priority: 580,
        extract: (match, quotedStrings) => {
            const dbAlias = quotedStrings[parseInt(match[1])] || '';
            const dbQuery = quotedStrings[parseInt(match[2])] || '';
            const dbParams = match[3] ? quotedStrings[parseInt(match[3])] || '[]' : undefined;
            return {
                targetText: '',
                params: { dbAlias, dbQuery, ...(dbParams ? { dbParams } : {}) }
            };
        },
        examples: [
            "Execute database update in 'PRIMARY_DB' query 'MARK_INACTIVE' params '[\"A100\"]'",
            "Execute database update in 'PRIMARY_DB' query 'CLEANUP_TEST_DATA'"
        ]
    },

    // ========================================================================
    // DATABASE RESOLVE OR USE (Priority 590-594)
    // ========================================================================
    {
        id: 'db-resolve-or-use',
        pattern: /^resolve\s+__QUOTED_(\d+)__\s+from\s+database\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__\s+if\s+not\s+provided\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'db-resolve-or-use',
        priority: 590,
        extract: (match, quotedStrings) => {
            const variableName = quotedStrings[parseInt(match[1])] || '';
            const dbAlias = quotedStrings[parseInt(match[2])] || '';
            const dbQuery = quotedStrings[parseInt(match[3])] || '';
            const value = quotedStrings[parseInt(match[4])] || '';
            return {
                targetText: '',
                value,
                params: { variableName, dbAlias, dbQuery }
            };
        },
        examples: [
            "Resolve 'itemCode' from database 'PRIMARY_DB' query 'GET_RANDOM_ACTIVE' if not provided '{scenario:inputCode}'"
        ]
    },
    {
        id: 'db-resolve-field-or-use',
        pattern: /^resolve\s+__QUOTED_(\d+)__\s+field\s+__QUOTED_(\d+)__\s+from\s+database\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__\s+if\s+not\s+provided\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'db-resolve-or-use',
        priority: 591,
        extract: (match, quotedStrings) => {
            const variableName = quotedStrings[parseInt(match[1])] || '';
            const dbField = quotedStrings[parseInt(match[2])] || '';
            const dbAlias = quotedStrings[parseInt(match[3])] || '';
            const dbQuery = quotedStrings[parseInt(match[4])] || '';
            const value = quotedStrings[parseInt(match[5])] || '';
            return {
                targetText: '',
                value,
                params: { variableName, dbField, dbAlias, dbQuery }
            };
        },
        examples: [
            "Resolve 'itemName' field 'name' from database 'PRIMARY_DB' query 'GET_DETAILS' if not provided '{scenario:inputName}'"
        ]
    }
];
