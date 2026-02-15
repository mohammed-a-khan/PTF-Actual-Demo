/**
 * Form/Frame/Popup Data Capture Grammar Rules (Phase 9)
 *
 * Grammar rules for capturing data from form fields, modal dialogs,
 * and verifying modal state. Uses accessibility tree for field detection.
 * Priority range: 500-529
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

export const FORM_CAPTURE_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // FORM DATA CAPTURE (Priority 500-502)
    // ========================================================================
    {
        id: 'form-capture-all',
        pattern: /^capture\s+(?:all\s+)?(?:the\s+)?form\s+field\s+values?$/i,
        category: 'query',
        intent: 'capture-form-data',
        priority: 500,
        extract: () => ({
            targetText: ''
        }),
        examples: [
            'Capture all form field values',
            'Capture the form field values'
        ]
    },
    {
        id: 'form-capture-named',
        pattern: /^capture\s+(?:all\s+)?(?:the\s+)?form\s+field\s+values?\s+from\s+(?:the\s+)?__QUOTED_(\d+)__\s+(?:section|form|area|panel)$/i,
        category: 'query',
        intent: 'capture-form-data',
        priority: 501,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                captureScope: quotedStrings[parseInt(match[1])] || ''
            }
        }),
        examples: [
            "Capture form field values from the 'Edit Details' section",
            "Capture all form field values from the 'Personal Info' form"
        ]
    },
    {
        id: 'form-capture-fields',
        pattern: /^capture\s+fields?\s+__QUOTED_(\d+)__\s+from\s+(?:the\s+)?(?:form|page|section)$/i,
        category: 'query',
        intent: 'capture-form-data',
        priority: 502,
        extract: (match, quotedStrings) => ({
            targetText: '',
            params: {
                captureFields: quotedStrings[parseInt(match[1])] || ''
            }
        }),
        examples: [
            "Capture fields 'Name, Status, Amount, Date' from the form",
            "Capture fields 'Username, Email' from the page"
        ]
    },

    // ========================================================================
    // MODAL/POPUP VERIFICATION (Priority 510-513)
    // ========================================================================
    {
        id: 'modal-verify-open',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?modal\s+is\s+(?:displayed|visible|open|shown)$/i,
        category: 'assertion',
        intent: 'verify-visible',
        priority: 510,
        extract: () => ({
            targetText: '',
            elementType: 'dialog'
        }),
        examples: [
            'Verify the modal is displayed',
            'Verify that the modal is visible'
        ]
    },
    {
        id: 'modal-verify-named-open',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?__QUOTED_(\d+)__\s+modal\s+is\s+(?:displayed|visible|open|shown)$/i,
        category: 'assertion',
        intent: 'verify-visible',
        priority: 511,
        extract: (match, quotedStrings) => ({
            targetText: quotedStrings[parseInt(match[1])] || '',
            elementType: 'dialog'
        }),
        examples: [
            "Verify the 'Edit Details' modal is displayed",
            "Verify that the 'Confirmation' modal is visible"
        ]
    },
    {
        id: 'modal-verify-error',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?modal\s+contains?\s+(?:error\s+)?message\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-contains',
        priority: 512,
        extract: (match, quotedStrings) => ({
            targetText: '',
            elementType: 'dialog',
            expectedValue: quotedStrings[parseInt(match[1])] || ''
        }),
        examples: [
            "Verify modal contains error message 'Field is required'",
            "Verify the modal contains message 'Successfully saved'"
        ]
    },
    {
        id: 'modal-capture-data',
        pattern: /^capture\s+(?:all\s+)?(?:the\s+)?field\s+values?\s+from\s+(?:the\s+)?modal$/i,
        category: 'query',
        intent: 'capture-form-data',
        priority: 513,
        extract: () => ({
            targetText: '',
            params: {
                captureScope: 'modal'
            }
        }),
        examples: [
            'Capture all field values from the modal',
            'Capture the field values from the modal'
        ]
    }
];
