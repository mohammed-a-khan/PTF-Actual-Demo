/**
 * Mapping Grammar Rules (Phase 6)
 *
 * Grammar rules for loading external mapping files, transforming data
 * using mapping configurations, and preparing test data from definition files.
 * Priority range: 750-799
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

export const MAPPING_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // LOAD MAPPING FILE (Priority 750-751)
    // ========================================================================
    {
        id: 'map-load',
        pattern: /^load\s+mapping\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'load-mapping',
        priority: 750,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                mappingFile: quotedStrings[parseInt(match[1])] || ''
            }
        }),
        examples: [
            "Load mapping file 'config/field-mappings.yml'",
            "Load mapping file 'test-data/column-map.json'"
        ]
    },
    {
        id: 'map-load-sheet',
        pattern: /^load\s+mapping\s+file\s+__QUOTED_(\d+)__\s+sheet\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'load-mapping',
        priority: 751,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                mappingFile: quotedStrings[parseInt(match[1])] || '',
                mappingSheet: quotedStrings[parseInt(match[2])] || ''
            }
        }),
        examples: [
            "Load mapping file 'config/mappings.xlsx' sheet 'Fields'",
            "Load mapping file 'data/columns.xlsx' sheet 'Comparison'"
        ]
    },

    // ========================================================================
    // TRANSFORM DATA (Priority 760-761)
    // ========================================================================
    {
        id: 'map-transform',
        pattern: /^transform\s+context\s+__QUOTED_(\d+)__\s+using\s+mapping\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'transform-data',
        priority: 760,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                sourceContextVar: quotedStrings[parseInt(match[1])] || '',
                targetContextVar: quotedStrings[parseInt(match[2])] || ''
            }
        }),
        examples: [
            "Transform context 'dbData' using mapping 'fieldMap'",
            "Transform context 'rawRecords' using mapping 'columnMapping'"
        ]
    },
    {
        id: 'map-transform-file',
        pattern: /^transform\s+context\s+__QUOTED_(\d+)__\s+using\s+mapping\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'transform-data',
        priority: 761,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                sourceContextVar: quotedStrings[parseInt(match[1])] || '',
                mappingFile: quotedStrings[parseInt(match[2])] || ''
            }
        }),
        examples: [
            "Transform context 'dbRecord' using mapping file 'config/db-to-ui.yml'",
            "Transform context 'rawData' using mapping file 'mappings/normalize.json'"
        ]
    },

    // ========================================================================
    // PREPARE TEST DATA (Priority 770-771)
    // ========================================================================
    {
        id: 'map-prepare-data',
        pattern: /^prepare\s+test\s+data\s+using\s+mapping\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'prepare-test-data',
        priority: 770,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                mappingFile: quotedStrings[parseInt(match[1])] || ''
            }
        }),
        examples: [
            "Prepare test data using mapping file 'test-data/create-record.yml'",
            "Prepare test data using mapping file 'data/setup-scenario.json'"
        ]
    },
    {
        id: 'map-prepare-data-context',
        pattern: /^prepare\s+test\s+data\s+using\s+mapping\s+file\s+__QUOTED_(\d+)__\s+with\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'prepare-test-data',
        priority: 771,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                mappingFile: quotedStrings[parseInt(match[1])] || '',
                sourceContextVar: quotedStrings[parseInt(match[2])] || ''
            }
        }),
        examples: [
            "Prepare test data using mapping file 'test-data/edit-record.yml' with context 'existingRecord'",
            "Prepare test data using mapping file 'data/update.yml' with context 'currentData'"
        ]
    }
];
