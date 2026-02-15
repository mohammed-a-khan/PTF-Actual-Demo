/**
 * Context Grammar Rules (Phase 4)
 *
 * Grammar rules for context variable operations, extended data generation,
 * date manipulation, and value concatenation/formatting.
 * Priority range: 700-749
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

export const CONTEXT_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // CONTEXT FIELD ACCESS (Priority 700-709)
    // ========================================================================
    {
        id: 'ctx-get-field',
        pattern: /^get\s+field\s+__QUOTED_(\d+)__\s+from\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-context-field',
        priority: 700,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                contextField: quotedStrings[parseInt(match[1])] || '',
                sourceContextVar: quotedStrings[parseInt(match[2])] || ''
            }
        }),
        examples: [
            "Get field 'status' from context 'recordData'",
            "Get field 'name' from context 'currentItem'"
        ]
    },
    {
        id: 'ctx-get-field-index',
        pattern: /^get\s+field\s+__QUOTED_(\d+)__\s+from\s+row\s+__QUOTED_(\d+)__\s+of\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-context-field',
        priority: 701,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                contextField: quotedStrings[parseInt(match[1])] || '',
                contextRowIndex: parseInt(quotedStrings[parseInt(match[2])] || '0'),
                sourceContextVar: quotedStrings[parseInt(match[3])] || ''
            }
        }),
        examples: [
            "Get field 'name' from row '2' of context 'allRecords'",
            "Get field 'code' from row '0' of context 'dbResults'"
        ]
    },
    {
        id: 'ctx-get-count',
        pattern: /^get\s+count\s+of\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-context-count',
        priority: 702,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: { sourceContextVar: quotedStrings[parseInt(match[1])] || '' }
        }),
        examples: [
            "Get count of context 'searchResults'",
            "Get count of context 'dbRecords'"
        ]
    },
    {
        id: 'ctx-get-keys',
        pattern: /^get\s+keys\s+from\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-context-keys',
        priority: 703,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: { sourceContextVar: quotedStrings[parseInt(match[1])] || '' }
        }),
        examples: [
            "Get keys from context 'recordData'",
            "Get keys from context 'formData'"
        ]
    },

    // ========================================================================
    // CONTEXT COPY / SET / CLEAR (Priority 710-719)
    // ========================================================================
    {
        id: 'ctx-copy-var',
        pattern: /^copy\s+context\s+__QUOTED_(\d+)__\s+to\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'copy-context-var',
        priority: 710,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                sourceContextVar: quotedStrings[parseInt(match[1])] || '',
                targetContextVar: quotedStrings[parseInt(match[2])] || ''
            }
        }),
        examples: [
            "Copy context 'originalRecord' to 'backupRecord'"
        ]
    },
    {
        id: 'ctx-set-same-as',
        pattern: /^set\s+context\s+__QUOTED_(\d+)__\s+same\s+as\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'copy-context-var',
        priority: 711,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                targetContextVar: quotedStrings[parseInt(match[1])] || '',
                sourceContextVar: quotedStrings[parseInt(match[2])] || ''
            }
        }),
        examples: [
            "Set context 'endValue' same as context 'startValue'"
        ]
    },
    {
        id: 'ctx-set-field',
        pattern: /^set\s+field\s+__QUOTED_(\d+)__\s+in\s+context\s+__QUOTED_(\d+)__\s+to\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'set-context-field',
        priority: 712,
        extract: (match, quotedStrings) => ({
            targetText: '',
            value: quotedStrings[parseInt(match[3])] || '',
            params: {
                contextField: quotedStrings[parseInt(match[1])] || '',
                sourceContextVar: quotedStrings[parseInt(match[2])] || ''
            }
        }),
        examples: [
            "Set field 'status' in context 'recordData' to 'INACTIVE'"
        ]
    },
    {
        id: 'ctx-clear-var',
        pattern: /^clear\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'clear-context-var',
        priority: 713,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: { sourceContextVar: quotedStrings[parseInt(match[1])] || '' }
        }),
        examples: [
            "Clear context 'tempData'"
        ]
    },

    // ========================================================================
    // EXTENDED DATA GENERATION (Priority 720-739)
    // ========================================================================
    {
        id: 'ctx-generate-decimal',
        pattern: /^generate\s+random\s+decimal\s+between\s+__QUOTED_(\d+)__\s+and\s+__QUOTED_(\d+)__\s+with\s+__QUOTED_(\d+)__\s+decimal\s+places?$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 720,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                dataType: 'random-decimal',
                rangeMin: parseFloat(quotedStrings[parseInt(match[1])] || '0'),
                rangeMax: parseFloat(quotedStrings[parseInt(match[2])] || '100'),
                decimalPlaces: parseInt(quotedStrings[parseInt(match[3])] || '2')
            }
        }),
        examples: [
            "Generate random decimal between '0.01' and '99.99' with '2' decimal places"
        ]
    },
    {
        id: 'ctx-generate-formatted-number',
        pattern: /^generate\s+random\s+number\s+in\s+format\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 721,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                dataType: 'formatted-number',
                numberFormat: quotedStrings[parseInt(match[1])] || ''
            }
        }),
        examples: [
            "Generate random number in format 'x.0yy'"
        ]
    },
    {
        id: 'ctx-generate-date-past',
        pattern: /^generate\s+date\s+__QUOTED_(\d+)__\s+business\s+days?\s+ago$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 722,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                dataType: 'business-days-ago',
                businessDaysOffset: parseInt(quotedStrings[parseInt(match[1])] || '1')
            }
        }),
        examples: [
            "Generate date '3' business days ago",
            "Generate date '1' business day ago"
        ]
    },
    {
        id: 'ctx-generate-date-future',
        pattern: /^generate\s+date\s+__QUOTED_(\d+)__\s+business\s+days?\s+from\s+now$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 723,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                dataType: 'business-days-from-now',
                businessDaysOffset: parseInt(quotedStrings[parseInt(match[1])] || '1')
            }
        }),
        examples: [
            "Generate date '5' business days from now",
            "Generate date '1' business day from now"
        ]
    },
    {
        id: 'ctx-generate-date-format',
        pattern: /^generate\s+current\s+date\s+in\s+format\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 724,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                dataType: 'formatted-date',
                dateFormat: quotedStrings[parseInt(match[1])] || 'MM/DD/YYYY'
            }
        }),
        examples: [
            "Generate current date in format 'MM/DD/YYYY'",
            "Generate current date in format 'YYYY-MM-DD'"
        ]
    },
    {
        id: 'ctx-concat',
        pattern: /^concatenate\s+context\s+__QUOTED_(\d+)__\s+and\s+context\s+__QUOTED_(\d+)__\s+with\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'set-context-field',
        priority: 730,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                sourceContextVar: quotedStrings[parseInt(match[1])] || '',
                targetContextVar: quotedStrings[parseInt(match[2])] || '',
                separator: quotedStrings[parseInt(match[3])] || '',
                comparisonOp: 'concatenate'
            }
        }),
        examples: [
            "Concatenate context 'firstName' and context 'lastName' with ' '"
        ]
    },
    {
        id: 'ctx-format-date',
        pattern: /^format\s+context\s+__QUOTED_(\d+)__\s+as\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'set-context-field',
        priority: 731,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                sourceContextVar: quotedStrings[parseInt(match[1])] || '',
                dateFormat: quotedStrings[parseInt(match[2])] || 'MM/DD/YYYY',
                comparisonOp: 'format-date'
            }
        }),
        examples: [
            "Format context 'rawDate' as 'MM/DD/YYYY'",
            "Format context 'timestamp' as 'YYYY-MM-DD'"
        ]
    }
];
