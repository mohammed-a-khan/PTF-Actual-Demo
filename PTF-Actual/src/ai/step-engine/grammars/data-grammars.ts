/**
 * Data Grammar Rules (Phase 7, 10, 11, 12)
 *
 * Grammar rules for data generation, context operations, screenshot capture,
 * file download verification, inline API calls, and JavaScript execution.
 * Priority range: 450-499
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

/** Helper to resolve a quoted placeholder back to its value */
function resolveQuoted(text: string, quotedStrings: string[]): string {
    return text.replace(/__QUOTED_(\d+)__/g, (_, idx) => quotedStrings[parseInt(idx)] || '');
}

export const DATA_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // DATA GENERATION (Priority 450-459) — Phase 7
    // ========================================================================
    {
        id: 'data-generate-uuid',
        pattern: /^generate\s+(?:a\s+)?(?:uuid|UUID|GUID|guid|unique\s+id)$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 450,
        extract: () => ({
            targetText: '',
            params: { dataType: 'uuid' }
        }),
        examples: ['Generate a UUID', 'Generate a unique id', 'Generate a GUID']
    },
    {
        id: 'data-generate-timestamp',
        pattern: /^generate\s+(?:a\s+)?(?:timestamp|date|datetime|current\s+date(?:time)?)$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 451,
        extract: () => ({
            targetText: '',
            params: { dataType: 'timestamp' }
        }),
        examples: ['Generate a timestamp', 'Generate a date', 'Generate a current datetime']
    },
    {
        id: 'data-generate-random-string',
        pattern: /^generate\s+(?:a\s+)?random\s+string(?:\s+of\s+length\s+(\d+))?$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 452,
        extract: (match) => ({
            targetText: '',
            params: { dataType: 'random-string', length: match[1] ? parseInt(match[1]) : 10 }
        }),
        examples: [
            'Generate a random string of length 10',
            'Generate a random string',
            'Generate a random string of length 20'
        ]
    },
    {
        id: 'data-generate-random-number',
        pattern: /^generate\s+(?:a\s+)?random\s+number(?:\s+between\s+(\d+)\s+and\s+(\d+))?$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 453,
        extract: (match) => ({
            targetText: '',
            params: {
                dataType: 'random-number',
                rangeMin: match[1] ? parseInt(match[1]) : 1,
                rangeMax: match[2] ? parseInt(match[2]) : 1000
            }
        }),
        examples: [
            'Generate a random number between 1 and 100',
            'Generate a random number',
            'Generate a random number between 100 and 999'
        ]
    },
    {
        id: 'data-generate-random-email',
        pattern: /^generate\s+(?:a\s+)?random\s+email(?:\s+address)?$/i,
        category: 'query',
        intent: 'generate-data',
        priority: 454,
        extract: () => ({
            targetText: '',
            params: { dataType: 'random-email' }
        }),
        examples: ['Generate a random email', 'Generate a random email address']
    },

    // ========================================================================
    // CONTEXT OPERATIONS (Priority 460-469) — Phase 7
    // ========================================================================
    {
        id: 'data-set-variable',
        pattern: /^set\s+(?:the\s+)?variable\s+__QUOTED_(\d+)__\s+to\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'set-variable',
        priority: 460,
        extract: (match, quotedStrings) => {
            const variableName = quotedStrings[parseInt(match[1])] || '';
            const value = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                value,
                params: { variableName }
            };
        },
        examples: [
            "Set variable 'userName' to 'admin'",
            "Set the variable 'testId' to '12345'"
        ]
    },

    // ========================================================================
    // SCREENSHOT (Priority 470-474) — Phase 7
    // ========================================================================
    {
        id: 'data-take-screenshot',
        pattern: /^take\s+(?:a\s+)?screenshot(?:\s+(?:as|named?)\s+__QUOTED_(\d+)__)?$/i,
        category: 'action',
        intent: 'take-screenshot',
        priority: 470,
        extract: (match, quotedStrings) => {
            const name = match[1] ? quotedStrings[parseInt(match[1])] : undefined;
            return {
                targetText: '',
                params: name ? { screenshotName: name } : {}
            };
        },
        examples: [
            'Take a screenshot',
            "Take a screenshot as 'login-page'",
            "Take screenshot named 'error-state'"
        ]
    },

    // ========================================================================
    // FILE DOWNLOAD VERIFICATION (Priority 480-489) — Phase 10
    // ========================================================================
    {
        id: 'data-verify-download',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:file\s+)?__QUOTED_(\d+)__\s+was\s+downloaded$/i,
        category: 'assertion',
        intent: 'verify-download',
        priority: 480,
        extract: (match, quotedStrings) => {
            const fileName = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { fileName }
            };
        },
        examples: [
            "Verify file 'report.csv' was downloaded",
            "Verify 'data.xlsx' was downloaded"
        ]
    },
    {
        id: 'data-verify-a-download',
        pattern: /^verify\s+(?:that\s+)?a\s+file\s+was\s+downloaded$/i,
        category: 'assertion',
        intent: 'verify-download',
        priority: 481,
        extract: () => ({
            targetText: ''
        }),
        examples: ['Verify a file was downloaded', 'Verify that a file was downloaded']
    },
    {
        id: 'data-get-download-path',
        pattern: /^(?:get|read)\s+(?:the\s+)?(?:path|location)\s+of\s+(?:the\s+)?(?:downloaded|last\s+downloaded)\s+file$/i,
        category: 'query',
        intent: 'get-download-path',
        priority: 482,
        extract: () => ({
            targetText: ''
        }),
        examples: [
            'Get the path of the downloaded file',
            'Get the location of the last downloaded file'
        ]
    },
    {
        id: 'data-verify-download-content',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?downloaded\s+file\s+contains?\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-download-content',
        priority: 483,
        extract: (match, quotedStrings) => {
            const content = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { fileContent: content }
            };
        },
        examples: [
            "Verify the downloaded file contains 'Total Revenue'",
            "Verify downloaded file contains 'header'"
        ]
    },
    {
        id: 'data-verify-download-named-content',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:downloaded\s+)?file\s+__QUOTED_(\d+)__\s+contains?\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-download-content',
        priority: 484,
        extract: (match, quotedStrings) => {
            const fileName = quotedStrings[parseInt(match[1])] || '';
            const content = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { fileName, fileContent: content }
            };
        },
        examples: ["Verify downloaded file 'data.csv' contains 'header'"]
    },

    // ========================================================================
    // INLINE API CALLS (Priority 490-494) — Phase 11
    // ========================================================================
    {
        id: 'data-api-call-get',
        pattern: /^call\s+api\s+(?:GET)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 490,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'GET', apiUrl }
            };
        },
        examples: ["Call API GET 'https://api.example.com/users/1'"]
    },
    {
        id: 'data-api-call-with-body',
        pattern: /^call\s+api\s+(POST|PUT|PATCH|DELETE)\s+__QUOTED_(\d+)__\s+with\s+body\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 491,
        extract: (match, quotedStrings) => {
            const httpMethod = match[1].toUpperCase();
            const apiUrl = quotedStrings[parseInt(match[2])] || '';
            const requestBody = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                params: { httpMethod, apiUrl, requestBody }
            };
        },
        examples: [
            "Call API POST '/api/login' with body '{\"user\":\"admin\"}'",
            "Call API PUT '/api/users/1' with body '{\"name\":\"Updated\"}'"
        ]
    },
    {
        id: 'data-verify-api-response-status',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?api\s+response\s+status\s+(?:is|equals?)\s+(\d+)$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 492,
        extract: (match) => ({
            targetText: '',
            expectedValue: match[1],
            params: { httpMethod: 'STATUS' }
        }),
        examples: [
            'Verify API response status is 200',
            'Verify the API response status equals 404'
        ]
    },
    {
        id: 'data-verify-api-response-contains',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?api\s+response\s+(?:contains?|includes?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 493,
        extract: (match, quotedStrings) => {
            const content = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                expectedValue: content
            };
        },
        examples: ["Verify API response contains 'success'"]
    },
    {
        id: 'data-get-api-response-body',
        pattern: /^(?:get|read)\s+(?:the\s+)?api\s+response\s+(?:body|content)$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 494,
        extract: () => ({
            targetText: ''
        }),
        examples: ['Get API response body', 'Read the API response content']
    },
    {
        id: 'data-get-api-response-jsonpath',
        pattern: /^(?:get|read|extract)\s+(?:the\s+)?(?:value\s+)?__QUOTED_(\d+)__\s+from\s+(?:the\s+)?api\s+response$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 495,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { jsonPath }
            };
        },
        examples: [
            "Get value '$.data.name' from API response",
            "Extract '$.id' from the API response"
        ]
    },

    // ========================================================================
    // JAVASCRIPT EXECUTION (Priority 496-499) — Phase 12
    // ========================================================================
    {
        id: 'data-execute-js',
        pattern: /^(?:execute|run)\s+(?:the\s+)?(?:javascript|js|script)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'execute-js',
        priority: 496,
        extract: (match, quotedStrings) => {
            const script = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { script }
            };
        },
        examples: [
            "Execute JavaScript 'document.title = \"New Title\"'",
            "Run script 'window.scrollTo(0, document.body.scrollHeight)'"
        ]
    },
    {
        id: 'data-evaluate-js',
        pattern: /^(?:evaluate|get)\s+(?:the\s+)?(?:javascript|js)\s+(?:value\s+)?__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'evaluate-js',
        priority: 497,
        extract: (match, quotedStrings) => {
            const script = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { script }
            };
        },
        examples: [
            "Evaluate JavaScript 'document.querySelectorAll(\"tr\").length'",
            "Get JavaScript value 'window.innerWidth'"
        ]
    }
];
