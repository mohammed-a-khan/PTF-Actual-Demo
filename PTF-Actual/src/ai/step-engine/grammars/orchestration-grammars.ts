/**
 * Orchestration Grammar Rules (Phase 7)
 *
 * Grammar rules for invoking consumer-registered helpers from AI steps.
 * Priority range: 800-849
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

export const ORCHESTRATION_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // HELPER INVOCATION (Priority 800-809)
    // ========================================================================
    {
        id: 'orch-call-helper',
        pattern: /^call\s+helper\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'call-helper',
        priority: 800,
        extract: (match, quotedStrings) => {
            const helperRef = quotedStrings[parseInt(match[1])] || '';
            const dotIdx = helperRef.lastIndexOf('.');
            return {
                targetText: '',
                params: {
                    helperClass: dotIdx > -1 ? helperRef.substring(0, dotIdx) : helperRef,
                    helperMethod: dotIdx > -1 ? helperRef.substring(dotIdx + 1) : ''
                }
            };
        },
        examples: [
            "Call helper 'CredentialManager.getCurrent'",
            "Call helper 'DataHelper.cleanup'"
        ]
    },
    {
        id: 'orch-call-helper-args',
        pattern: /^call\s+helper\s+__QUOTED_(\d+)__\s+with\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'call-helper',
        priority: 801,
        extract: (match, quotedStrings) => {
            const helperRef = quotedStrings[parseInt(match[1])] || '';
            const helperArgs = quotedStrings[parseInt(match[2])] || '[]';
            const dotIdx = helperRef.lastIndexOf('.');
            return {
                targetText: '',
                params: {
                    helperClass: dotIdx > -1 ? helperRef.substring(0, dotIdx) : helperRef,
                    helperMethod: dotIdx > -1 ? helperRef.substring(dotIdx + 1) : '',
                    helperArgs
                }
            };
        },
        examples: [
            "Call helper 'DataHelper.getById' with '[\"42\"]'",
            "Call helper 'Utility.transform' with '[\"input\", \"output\"]'"
        ]
    },
    {
        id: 'orch-call-helper-context',
        pattern: /^call\s+helper\s+__QUOTED_(\d+)__\s+with\s+context\s+args\s+__QUOTED_(\d+)__\s+and\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'call-helper',
        priority: 802,
        extract: (match, quotedStrings) => {
            const helperRef = quotedStrings[parseInt(match[1])] || '';
            const arg1 = quotedStrings[parseInt(match[2])] || '';
            const arg2 = quotedStrings[parseInt(match[3])] || '';
            const dotIdx = helperRef.lastIndexOf('.');
            return {
                targetText: '',
                params: {
                    helperClass: dotIdx > -1 ? helperRef.substring(0, dotIdx) : helperRef,
                    helperMethod: dotIdx > -1 ? helperRef.substring(dotIdx + 1) : '',
                    sourceContextVar: arg1,
                    targetContextVar: arg2
                }
            };
        },
        examples: [
            "Call helper 'CompareHelper.validate' with context args 'fileData' and 'dbData'"
        ]
    }
];
