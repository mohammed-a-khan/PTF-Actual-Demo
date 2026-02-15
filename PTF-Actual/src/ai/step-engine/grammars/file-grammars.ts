/**
 * File Grammar Rules (Phase 3)
 *
 * Grammar rules for file parsing operations: CSV, XLSX, JSON, YAML parsing,
 * file verification, row count retrieval, header extraction, and data matching.
 * Priority range: 600-649
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

export const FILE_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // CSV PARSING (Priority 600-601)
    // ========================================================================
    {
        id: 'file-parse-csv',
        pattern: /^parse\s+(?:the\s+)?downloaded\s+csv\s+file$/i,
        category: 'action',
        intent: 'parse-csv',
        priority: 600,
        extract: () => ({
            targetText: ''
        }),
        examples: [
            'Parse downloaded CSV file',
            'Parse the downloaded CSV file'
        ]
    },
    {
        id: 'file-parse-csv-named',
        pattern: /^parse\s+(?:the\s+)?csv\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'parse-csv',
        priority: 601,
        extract: (match, quotedStrings) => {
            const fileName = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { fileName }
            };
        },
        examples: [
            "Parse CSV file 'report.csv'",
            "Parse the CSV file 'export-data.csv'"
        ]
    },

    // ========================================================================
    // XLSX PARSING (Priority 602-603)
    // ========================================================================
    {
        id: 'file-parse-xlsx',
        pattern: /^parse\s+(?:the\s+)?downloaded\s+xlsx\s+file$/i,
        category: 'action',
        intent: 'parse-xlsx',
        priority: 602,
        extract: () => ({
            targetText: ''
        }),
        examples: [
            'Parse downloaded XLSX file',
            'Parse the downloaded XLSX file'
        ]
    },
    {
        id: 'file-parse-xlsx-sheet',
        pattern: /^parse\s+(?:the\s+)?xlsx\s+file\s+sheet\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'parse-xlsx',
        priority: 603,
        extract: (match, quotedStrings) => {
            const mappingSheet = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { mappingSheet }
            };
        },
        examples: [
            "Parse XLSX file sheet 'Summary'",
            "Parse the XLSX file sheet 'Sheet1'"
        ]
    },

    // ========================================================================
    // FILE NAME VERIFICATION (Priority 610-612)
    // ========================================================================
    {
        id: 'file-verify-name-pattern',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?downloaded\s+file\s+name\s+matches\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-file-name-pattern',
        priority: 610,
        extract: (match, quotedStrings) => {
            const regexPattern = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { regexPattern }
            };
        },
        examples: [
            "Verify downloaded file name matches 'report_\\d{4}\\.csv'",
            "Verify the downloaded file name matches 'export-.*\\.xlsx'"
        ]
    },
    {
        id: 'file-verify-row-count',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?file\s+row\s+count\s+is\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-file-row-count',
        priority: 611,
        extract: (match, quotedStrings) => {
            const expectedValue = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                expectedValue
            };
        },
        examples: [
            "Verify file row count is '100'",
            "Verify the file row count is '50'"
        ]
    },
    {
        id: 'file-verify-row-count-context',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?file\s+row\s+count\s+equals\s+count\s+of\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-file-row-count',
        priority: 612,
        extract: (match, quotedStrings) => {
            const sourceContextVar = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { sourceContextVar }
            };
        },
        examples: [
            "Verify file row count equals count of context 'tableData'",
            "Verify the file row count equals count of context 'searchResults'"
        ]
    },

    // ========================================================================
    // FILE DATA RETRIEVAL (Priority 620-621)
    // ========================================================================
    {
        id: 'file-get-row-count',
        pattern: /^get\s+(?:the\s+)?row\s+count\s+from\s+(?:the\s+)?downloaded\s+file$/i,
        category: 'query',
        intent: 'get-file-row-count',
        priority: 620,
        extract: () => ({
            targetText: ''
        }),
        examples: [
            'Get row count from downloaded file',
            'Get the row count from the downloaded file'
        ]
    },
    {
        id: 'file-get-headers',
        pattern: /^get\s+(?:the\s+)?headers\s+from\s+(?:the\s+)?downloaded\s+file$/i,
        category: 'query',
        intent: 'get-file-headers',
        priority: 621,
        extract: () => ({
            targetText: ''
        }),
        examples: [
            'Get headers from downloaded file',
            'Get the headers from the downloaded file'
        ]
    },

    // ========================================================================
    // JSON / YAML PARSING (Priority 630-631)
    // ========================================================================
    {
        id: 'file-parse-json',
        pattern: /^parse\s+(?:the\s+)?json\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'parse-file',
        priority: 630,
        extract: (match, quotedStrings) => {
            const fileName = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { fileName, dataType: 'json' }
            };
        },
        examples: [
            "Parse JSON file 'config.json'",
            "Parse the JSON file 'test-data.json'"
        ]
    },
    {
        id: 'file-parse-yaml',
        pattern: /^parse\s+(?:the\s+)?yaml\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'parse-file',
        priority: 631,
        extract: (match, quotedStrings) => {
            const fileName = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { fileName, dataType: 'yaml' }
            };
        },
        examples: [
            "Parse YAML file 'settings.yaml'",
            "Parse the YAML file 'environment.yml'"
        ]
    },

    // ========================================================================
    // DATA MATCH VERIFICATION (Priority 640)
    // ========================================================================
    {
        id: 'file-verify-data-matches',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?file\s+data\s+in\s+context\s+__QUOTED_(\d+)__\s+matches\s+context\s+__QUOTED_(\d+)__\s+using\s+mapping\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-data-match',
        priority: 640,
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
            "Verify file data in context 'fileData' matches context 'tableData' using mapping file 'field-mapping.json'",
            "Verify the file data in context 'csvRows' matches context 'gridRows' using mapping file 'column-map.json'"
        ]
    }
];
