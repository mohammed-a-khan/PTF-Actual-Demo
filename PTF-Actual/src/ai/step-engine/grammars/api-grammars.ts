/**
 * API Grammar Rules (Phase 11)
 *
 * Grammar rules for comprehensive API testing: authentication, request execution,
 * response extraction, response validation, chaining/workflow, and SOAP/XML.
 * Priority range: 850-948
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 * All intents map to Phase 11 StepIntent types defined in CSAIStepTypes.
 */

import { GrammarRule } from '../CSAIStepTypes';

export const API_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // SECTION A: API AUTHENTICATION & CONTEXT (Priority 850-864)
    // ========================================================================
    {
        id: 'api-set-base-url',
        pattern: /^set\s+api\s+base\s+url\s+(?:to\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-context',
        priority: 850,
        extract: (match, quotedStrings) => {
            const url = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { url }
            };
        },
        examples: [
            "Set API base URL to 'https://api.example.com'",
            "Set API base URL 'https://staging.api.example.com/v2'"
        ]
    },
    {
        id: 'api-set-header',
        pattern: /^set\s+api\s+header\s+__QUOTED_(\d+)__\s+(?:to|=)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-header',
        priority: 851,
        extract: (match, quotedStrings) => {
            const attribute = quotedStrings[parseInt(match[1])] || '';
            const value = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                value,
                params: { attribute }
            };
        },
        examples: [
            "Set API header 'Content-Type' to 'application/json'",
            "Set API header 'Accept' = 'text/xml'"
        ]
    },
    {
        id: 'api-set-headers-from-context',
        pattern: /^set\s+api\s+headers\s+from\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-header',
        priority: 852,
        extract: (match, quotedStrings) => {
            const apiContext = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { apiContext }
            };
        },
        examples: [
            "Set API headers from context 'defaultHeaders'",
            "Set API headers from context 'serviceHeaders'"
        ]
    },
    {
        id: 'api-auth-basic',
        pattern: /^set\s+api\s+(?:auth|authentication)\s+basic\s+__QUOTED_(\d+)__\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-auth',
        priority: 853,
        extract: (match, quotedStrings) => {
            const username = quotedStrings[parseInt(match[1])] || '';
            const password = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { apiAuthType: 'basic', apiAuthParams: JSON.stringify({ username, password }) }
            };
        },
        examples: [
            "Set API auth basic 'admin' 'secret123'",
            "Set API authentication basic 'testuser' 'testpass'"
        ]
    },
    {
        id: 'api-auth-bearer',
        pattern: /^set\s+api\s+(?:auth|authentication)\s+bearer\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-auth',
        priority: 854,
        extract: (match, quotedStrings) => {
            const token = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { apiAuthType: 'bearer', apiAuthParams: JSON.stringify({ token }) }
            };
        },
        examples: [
            "Set API auth bearer 'eyJhbGciOiJIUzI1NiIsInR5...'",
            "Set API authentication bearer 'my-jwt-token'"
        ]
    },
    {
        id: 'api-auth-bearer-from-context',
        pattern: /^set\s+api\s+(?:auth|authentication)\s+bearer\s+from\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-auth',
        priority: 855,
        extract: (match, quotedStrings) => {
            const apiContext = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { apiAuthType: 'bearer', apiContext }
            };
        },
        examples: [
            "Set API auth bearer from context 'authToken'",
            "Set API authentication bearer from context 'loginResponse.token'"
        ]
    },
    {
        id: 'api-auth-apikey',
        pattern: /^set\s+api\s+(?:auth|authentication)\s+api[-\s]?key\s+__QUOTED_(\d+)__\s+(?:in\s+)?(header|query)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-auth',
        priority: 856,
        extract: (match, quotedStrings) => {
            const key = quotedStrings[parseInt(match[1])] || '';
            const location = match[2].toLowerCase();
            const paramName = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                params: { apiAuthType: 'apikey', apiAuthParams: JSON.stringify({ key, location, paramName }) }
            };
        },
        examples: [
            "Set API auth apikey 'abc123def456' in header 'X-API-Key'",
            "Set API authentication api-key 'mykey' in query 'api_key'"
        ]
    },
    {
        id: 'api-auth-oauth2-client',
        pattern: /^set\s+api\s+(?:auth|authentication)\s+oauth2\s+client\s+credentials\s+__QUOTED_(\d+)__\s+__QUOTED_(\d+)__\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-auth',
        priority: 857,
        extract: (match, quotedStrings) => {
            const clientId = quotedStrings[parseInt(match[1])] || '';
            const clientSecret = quotedStrings[parseInt(match[2])] || '';
            const tokenUrl = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                params: { apiAuthType: 'oauth2-client', apiAuthParams: JSON.stringify({ clientId, clientSecret, tokenUrl }) }
            };
        },
        examples: [
            "Set API auth oauth2 client credentials 'my-client-id' 'my-client-secret' 'https://auth.example.com/token'"
        ]
    },
    {
        id: 'api-auth-oauth2-password',
        pattern: /^set\s+api\s+(?:auth|authentication)\s+oauth2\s+password\s+__QUOTED_(\d+)__\s+__QUOTED_(\d+)__\s+__QUOTED_(\d+)__\s+__QUOTED_(\d+)__\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-auth',
        priority: 858,
        extract: (match, quotedStrings) => {
            const username = quotedStrings[parseInt(match[1])] || '';
            const password = quotedStrings[parseInt(match[2])] || '';
            const clientId = quotedStrings[parseInt(match[3])] || '';
            const clientSecret = quotedStrings[parseInt(match[4])] || '';
            const tokenUrl = quotedStrings[parseInt(match[5])] || '';
            return {
                targetText: '',
                params: { apiAuthType: 'oauth2-password', apiAuthParams: JSON.stringify({ username, password, clientId, clientSecret, tokenUrl }) }
            };
        },
        examples: [
            "Set API auth oauth2 password 'admin' 'pass123' 'client-id' 'client-secret' 'https://auth.example.com/token'"
        ]
    },
    {
        id: 'api-auth-certificate',
        pattern: /^set\s+api\s+(?:auth|authentication)\s+certificate\s+__QUOTED_(\d+)__\s+key\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-auth',
        priority: 859,
        extract: (match, quotedStrings) => {
            const certPath = quotedStrings[parseInt(match[1])] || '';
            const keyPath = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { apiAuthType: 'certificate', apiAuthParams: JSON.stringify({ certPath, keyPath }) }
            };
        },
        examples: [
            "Set API auth certificate 'certs/client.pem' key 'certs/client-key.pem'",
            "Set API authentication certificate 'ssl/cert.crt' key 'ssl/cert.key'"
        ]
    },
    {
        id: 'api-auth-pfx',
        pattern: /^set\s+api\s+(?:auth|authentication)\s+pfx\s+__QUOTED_(\d+)__\s+passphrase\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-auth',
        priority: 860,
        extract: (match, quotedStrings) => {
            const pfxPath = quotedStrings[parseInt(match[1])] || '';
            const passphrase = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { apiAuthType: 'pfx', apiAuthParams: JSON.stringify({ pfxPath, passphrase }) }
            };
        },
        examples: [
            "Set API auth pfx 'certs/client.pfx' passphrase 'mypassphrase'",
            "Set API authentication pfx 'ssl/bundle.p12' passphrase 'secret'"
        ]
    },
    {
        id: 'api-auth-ntlm',
        pattern: /^set\s+api\s+(?:auth|authentication)\s+ntlm\s+__QUOTED_(\d+)__\s+__QUOTED_(\d+)__(?:\s+domain\s+__QUOTED_(\d+)__)?$/i,
        category: 'action',
        intent: 'api-set-auth',
        priority: 861,
        extract: (match, quotedStrings) => {
            const username = quotedStrings[parseInt(match[1])] || '';
            const password = quotedStrings[parseInt(match[2])] || '';
            const domain = match[3] ? quotedStrings[parseInt(match[3])] || '' : undefined;
            return {
                targetText: '',
                params: { apiAuthType: 'ntlm', apiAuthParams: JSON.stringify({ username, password, ...(domain ? { domain } : {}) }) }
            };
        },
        examples: [
            "Set API auth ntlm 'user' 'password' domain 'CORP'",
            "Set API authentication ntlm 'admin' 'secret123'"
        ]
    },
    {
        id: 'api-set-context',
        pattern: /^set\s+api\s+context\s+__QUOTED_(\d+)__\s+(?:to|=)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-context',
        priority: 862,
        extract: (match, quotedStrings) => {
            const apiContext = quotedStrings[parseInt(match[1])] || '';
            const value = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                value,
                params: { apiContext }
            };
        },
        examples: [
            "Set API context 'environment' to 'staging'",
            "Set API context 'baseConfig' = '{\"timeout\":30000}'"
        ]
    },
    {
        id: 'api-clear-context',
        pattern: /^clear\s+api\s+context(?:\s+__QUOTED_(\d+)__)?$/i,
        category: 'action',
        intent: 'api-clear-context',
        priority: 863,
        extract: (match, quotedStrings) => {
            const apiContext = match[1] ? quotedStrings[parseInt(match[1])] || '' : undefined;
            return {
                targetText: '',
                params: { ...(apiContext ? { apiContext } : {}) }
            };
        },
        examples: [
            "Clear API context",
            "Clear API context 'sessionHeaders'"
        ]
    },
    {
        id: 'api-set-timeout',
        pattern: /^set\s+api\s+timeout\s+(?:to\s+)?(\d+)\s*(?:ms|milliseconds?)?$/i,
        category: 'action',
        intent: 'api-set-context',
        priority: 864,
        extract: (match) => {
            const timeout = parseInt(match[1]);
            return {
                targetText: '',
                params: { timeout }
            };
        },
        examples: [
            "Set API timeout to 30000",
            "Set API timeout 5000 ms",
            "Set API timeout to 60000 milliseconds"
        ]
    },

    {
        id: 'api-set-content-type',
        pattern: /^set\s+api\s+content[\s-]?type\s+(?:to\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-header',
        priority: 865,
        extract: (match, quotedStrings) => {
            const value = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                value,
                params: { attribute: 'Content-Type' }
            };
        },
        examples: [
            "Set API content type to 'application/xml'",
            "Set API content-type 'multipart/form-data'"
        ]
    },
    {
        id: 'api-set-accept',
        pattern: /^set\s+api\s+accept\s+(?:header\s+)?(?:to\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-set-header',
        priority: 866,
        extract: (match, quotedStrings) => {
            const value = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                value,
                params: { attribute: 'Accept' }
            };
        },
        examples: [
            "Set API accept to 'application/json'",
            "Set API accept header 'text/html'"
        ]
    },

    // ========================================================================
    // SECTION B: REQUEST EXECUTION (Priority 870-884)
    // ========================================================================
    {
        id: 'api-request-get',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?GET\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 870,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'GET', apiUrl }
            };
        },
        examples: [
            "Send a GET request to '/api/users'",
            "Make GET '/api/items/1'",
            "Execute API GET request to '/api/status'"
        ]
    },
    {
        id: 'api-request-post-body',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?POST\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+body\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 871,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const requestBody = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'POST', apiUrl, requestBody }
            };
        },
        examples: [
            "Send POST request to '/api/users' with body '{\"name\":\"John\"}'",
            "Make a POST '/api/items' with body '{\"title\":\"New Item\"}'"
        ]
    },
    {
        id: 'api-request-post-file',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?POST\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+(?:body\s+)?file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call-file',
        priority: 872,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const apiPayloadFile = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'POST', apiUrl, apiPayloadFile }
            };
        },
        examples: [
            "Send POST request to '/api/users' with file 'payloads/create-user.json'",
            "Make a POST '/api/items' with body file 'data/item-body.json'"
        ]
    },
    {
        id: 'api-request-put-body',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?PUT\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+body\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 873,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const requestBody = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'PUT', apiUrl, requestBody }
            };
        },
        examples: [
            "Send PUT request to '/api/users/1' with body '{\"name\":\"Updated\"}'",
            "Make a PUT '/api/items/42' with body '{\"status\":\"active\"}'"
        ]
    },
    {
        id: 'api-request-put-file',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?PUT\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+(?:body\s+)?file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call-file',
        priority: 874,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const apiPayloadFile = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'PUT', apiUrl, apiPayloadFile }
            };
        },
        examples: [
            "Send PUT request to '/api/users/1' with file 'payloads/update-user.json'",
            "Make a PUT '/api/items/42' with body file 'data/update-item.json'"
        ]
    },
    {
        id: 'api-request-patch',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?PATCH\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+body\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 875,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const requestBody = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'PATCH', apiUrl, requestBody }
            };
        },
        examples: [
            "Send PATCH request to '/api/users/1' with body '{\"email\":\"new@example.com\"}'",
            "Make a PATCH '/api/items/42' with body '{\"quantity\":10}'"
        ]
    },
    {
        id: 'api-request-delete',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?DELETE\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 876,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'DELETE', apiUrl }
            };
        },
        examples: [
            "Send DELETE request to '/api/users/1'",
            "Make a DELETE '/api/items/42'",
            "Execute API DELETE request to '/api/sessions/5'"
        ]
    },
    {
        id: 'api-request-head',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?HEAD\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 877,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'HEAD', apiUrl }
            };
        },
        examples: [
            "Send HEAD request to '/api/health'",
            "Make a HEAD '/api/status'"
        ]
    },
    {
        id: 'api-upload-file',
        pattern: /^upload\s+file\s+__QUOTED_(\d+)__\s+(?:to\s+)?(?:api\s+)?__QUOTED_(\d+)__(?:\s+as\s+__QUOTED_(\d+)__)?$/i,
        category: 'action',
        intent: 'api-upload',
        priority: 878,
        extract: (match, quotedStrings) => {
            const filePath = quotedStrings[parseInt(match[1])] || '';
            const apiUrl = quotedStrings[parseInt(match[2])] || '';
            const attribute = match[3] ? quotedStrings[parseInt(match[3])] || '' : undefined;
            return {
                targetText: '',
                params: { filePath, apiUrl, httpMethod: 'POST', ...(attribute ? { attribute } : {}) }
            };
        },
        examples: [
            "Upload file 'data/report.pdf' to '/api/uploads'",
            "Upload file 'images/logo.png' to API '/api/files' as 'attachment'"
        ]
    },
    {
        id: 'api-download-file',
        pattern: /^download\s+(?:file\s+)?from\s+(?:api\s+)?__QUOTED_(\d+)__(?:\s+(?:to|as)\s+__QUOTED_(\d+)__)?$/i,
        category: 'action',
        intent: 'api-download',
        priority: 879,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const apiResponseSavePath = match[2] ? quotedStrings[parseInt(match[2])] || '' : undefined;
            return {
                targetText: '',
                params: { apiUrl, httpMethod: 'GET', ...(apiResponseSavePath ? { apiResponseSavePath } : {}) }
            };
        },
        examples: [
            "Download file from API '/api/reports/123/export'",
            "Download from '/api/files/456' to 'downloads/report.pdf'"
        ]
    },
    {
        id: 'api-request-post-form',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?POST\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+form\s+(?:data\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 880,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const apiFormData = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'POST', apiUrl, apiFormData }
            };
        },
        examples: [
            "Send POST request to '/api/login' with form data 'username=admin&password=secret'",
            "Make a POST '/api/form-submit' with form 'field1=value1&field2=value2'"
        ]
    },
    {
        id: 'api-request-post-context-body',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?POST\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+body\s+from\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 881,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const apiContext = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'POST', apiUrl, apiContext }
            };
        },
        examples: [
            "Send POST request to '/api/submit' with body from context 'requestPayload'",
            "Make a POST '/api/orders' with body from context 'orderData'"
        ]
    },
    {
        id: 'api-request-get-with-query',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?GET\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+(?:query\s+)?params?\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 882,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const apiQueryParams = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'GET', apiUrl, apiQueryParams }
            };
        },
        examples: [
            "Send GET request to '/api/search' with query params 'q=test&page=1'",
            "Make GET '/api/users' with params 'status=active&limit=10'"
        ]
    },
    {
        id: 'api-poll-until',
        pattern: /^poll\s+(?:api\s+)?__QUOTED_(\d+)__\s+until\s+__QUOTED_(\d+)__\s+(?:is|equals?)\s+__QUOTED_(\d+)__(?:\s+every\s+(\d+)\s*(?:ms|milliseconds?)?)?(?:\s+(?:max|timeout)\s+(\d+)\s*(?:ms|milliseconds?)?)?$/i,
        category: 'action',
        intent: 'api-poll',
        priority: 883,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const apiPollField = quotedStrings[parseInt(match[2])] || '';
            const apiPollExpected = quotedStrings[parseInt(match[3])] || '';
            const apiPollInterval = match[4] ? parseInt(match[4]) : undefined;
            const apiPollMaxTime = match[5] ? parseInt(match[5]) : undefined;
            return {
                targetText: '',
                params: {
                    apiUrl,
                    httpMethod: 'GET',
                    apiPollField,
                    apiPollExpected,
                    ...(apiPollInterval ? { apiPollInterval } : {}),
                    ...(apiPollMaxTime ? { apiPollMaxTime } : {})
                }
            };
        },
        examples: [
            "Poll API '/api/jobs/123' until '$.status' equals 'completed' every 2000 ms max 60000 ms",
            "Poll '/api/tasks/5' until '$.state' is 'done' every 5000 timeout 120000"
        ]
    },
    {
        id: 'api-request-method-body',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__(?:\s+with\s+body\s+__QUOTED_(\d+)__)?$/i,
        category: 'action',
        intent: 'api-call',
        priority: 884,
        extract: (match, quotedStrings) => {
            const httpMethod = match[1].toUpperCase();
            const apiUrl = quotedStrings[parseInt(match[2])] || '';
            const requestBody = match[3] ? quotedStrings[parseInt(match[3])] || '' : undefined;
            return {
                targetText: '',
                params: { httpMethod, apiUrl, ...(requestBody ? { requestBody } : {}) }
            };
        },
        examples: [
            "Send a DELETE request to '/api/users/1' with body '{\"reason\":\"cleanup\"}'",
            "Execute PATCH request to '/api/config' with body '{\"debug\":true}'"
        ]
    },

    {
        id: 'api-request-patch-file',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?PATCH\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+(?:body\s+)?file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call-file',
        priority: 885,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const apiPayloadFile = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'PATCH', apiUrl, apiPayloadFile }
            };
        },
        examples: [
            "Send PATCH request to '/api/users/1' with file 'payloads/patch-user.json'",
            "Make a PATCH '/api/items/42' with body file 'data/patch-item.json'"
        ]
    },
    {
        id: 'api-request-delete-body',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?DELETE\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+body\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call',
        priority: 886,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const requestBody = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'DELETE', apiUrl, requestBody }
            };
        },
        examples: [
            "Send DELETE request to '/api/users/1' with body '{\"reason\":\"cleanup\"}'",
            "Make a DELETE '/api/batch' with body '{\"ids\":[1,2,3]}'"
        ]
    },
    {
        id: 'api-request-method-file',
        pattern: /^(?:send|make|execute)\s+(?:a\s+)?(?:api\s+)?(POST|PUT|PATCH|DELETE)\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+(?:body\s+)?file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-call-file',
        priority: 887,
        extract: (match, quotedStrings) => {
            const httpMethod = match[1].toUpperCase();
            const apiUrl = quotedStrings[parseInt(match[2])] || '';
            const apiPayloadFile = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                params: { httpMethod, apiUrl, apiPayloadFile }
            };
        },
        examples: [
            "Send DELETE request to '/api/cleanup' with file 'payloads/cleanup-body.json'",
            "Execute POST request to '/api/batch' with body file 'data/batch-request.json'"
        ]
    },

    // ========================================================================
    // SECTION C: RESPONSE EXTRACTION (Priority 890-904)
    // ========================================================================
    {
        id: 'api-get-status',
        pattern: /^get\s+(?:the\s+)?(?:api\s+)?response\s+status(?:\s+code)?$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 890,
        extract: () => ({
            targetText: '',
            params: { jsonPath: '$.statusCode' }
        }),
        examples: [
            "Get the API response status code",
            "Get response status"
        ]
    },
    {
        id: 'api-get-body',
        pattern: /^get\s+(?:the\s+)?(?:api\s+)?response\s+body$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 891,
        extract: () => ({
            targetText: '',
            params: { jsonPath: '$.body' }
        }),
        examples: [
            "Get the API response body",
            "Get response body"
        ]
    },
    {
        id: 'api-get-headers',
        pattern: /^get\s+(?:the\s+)?(?:api\s+)?response\s+headers$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 892,
        extract: () => ({
            targetText: '',
            params: { jsonPath: '$.headers' }
        }),
        examples: [
            "Get the API response headers",
            "Get response headers"
        ]
    },
    {
        id: 'api-get-header',
        pattern: /^get\s+(?:the\s+)?(?:api\s+)?response\s+header\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 893,
        extract: (match, quotedStrings) => {
            const attribute = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { jsonPath: `$.headers.${attribute}`, attribute }
            };
        },
        examples: [
            "Get the API response header 'Content-Type'",
            "Get response header 'X-Request-Id'"
        ]
    },
    {
        id: 'api-extract-jsonpath',
        pattern: /^(?:get|extract|read)\s+(?:the\s+)?(?:value\s+)?(?:at\s+)?(?:jsonpath\s+)?__QUOTED_(\d+)__\s+from\s+(?:the\s+)?(?:api\s+)?response$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 894,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { jsonPath }
            };
        },
        examples: [
            "Get value at JSONPath '$.data.id' from the API response",
            "Extract '$.items[0].name' from response",
            "Read the value '$.total' from API response"
        ]
    },
    {
        id: 'api-extract-all-jsonpath',
        pattern: /^(?:get|extract)\s+all\s+(?:values?\s+)?(?:at\s+)?(?:jsonpath\s+)?__QUOTED_(\d+)__\s+from\s+(?:the\s+)?(?:api\s+)?response$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 895,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { jsonPath, comparisonOp: 'all' }
            };
        },
        examples: [
            "Get all values at JSONPath '$.items[*].name' from the API response",
            "Extract all '$.users[*].email' from response"
        ]
    },
    {
        id: 'api-get-response-time',
        pattern: /^get\s+(?:the\s+)?(?:api\s+)?response\s+time$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 896,
        extract: () => ({
            targetText: '',
            params: { jsonPath: '$.responseTime' }
        }),
        examples: [
            "Get the API response time",
            "Get response time"
        ]
    },
    {
        id: 'api-get-cookies',
        pattern: /^get\s+(?:the\s+)?(?:api\s+)?response\s+cookies$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 897,
        extract: () => ({
            targetText: '',
            params: { jsonPath: '$.cookies' }
        }),
        examples: [
            "Get the API response cookies",
            "Get response cookies"
        ]
    },
    {
        id: 'api-save-response',
        pattern: /^save\s+(?:the\s+)?(?:api\s+)?response\s+(?:to|as)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-save-response',
        priority: 898,
        extract: (match, quotedStrings) => {
            const apiResponseSavePath = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { apiResponseSavePath }
            };
        },
        examples: [
            "Save the API response to 'responses/user-data.json'",
            "Save response as 'output/result.json'"
        ]
    },
    {
        id: 'api-save-request',
        pattern: /^save\s+(?:the\s+)?(?:api\s+)?(?:last\s+)?request\s+(?:to|as)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-save-request',
        priority: 899,
        extract: (match, quotedStrings) => {
            const apiResponseSavePath = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { apiResponseSavePath }
            };
        },
        examples: [
            "Save the API request to 'requests/last-request.json'",
            "Save the last request as 'debug/request.json'"
        ]
    },
    {
        id: 'api-print-response-body',
        pattern: /^print\s+(?:the\s+)?(?:api\s+)?response\s+body$/i,
        category: 'action',
        intent: 'api-print',
        priority: 900,
        extract: () => ({
            targetText: '',
            params: { apiPrintTarget: 'body' }
        }),
        examples: [
            "Print the API response body",
            "Print response body"
        ]
    },
    {
        id: 'api-print-response-headers',
        pattern: /^print\s+(?:the\s+)?(?:api\s+)?response\s+headers$/i,
        category: 'action',
        intent: 'api-print',
        priority: 901,
        extract: () => ({
            targetText: '',
            params: { apiPrintTarget: 'response-headers' }
        }),
        examples: [
            "Print the API response headers",
            "Print response headers"
        ]
    },
    {
        id: 'api-print-last-request',
        pattern: /^print\s+(?:the\s+)?(?:api\s+)?(?:last\s+)?request$/i,
        category: 'action',
        intent: 'api-print',
        priority: 902,
        extract: () => ({
            targetText: '',
            params: { apiPrintTarget: 'request' }
        }),
        examples: [
            "Print the API last request",
            "Print the request",
            "Print last request"
        ]
    },
    {
        id: 'api-print-request-headers',
        pattern: /^print\s+(?:the\s+)?(?:api\s+)?request\s+headers$/i,
        category: 'action',
        intent: 'api-print',
        priority: 903,
        extract: () => ({
            targetText: '',
            params: { apiPrintTarget: 'request-headers' }
        }),
        examples: [
            "Print the API request headers",
            "Print request headers"
        ]
    },
    {
        id: 'api-extract-from-stored',
        pattern: /^(?:get|extract|read)\s+(?:the\s+)?(?:value\s+)?__QUOTED_(\d+)__\s+from\s+(?:the\s+)?stored\s+response\s+__QUOTED_(\d+)__$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 904,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const apiResponseSavePath = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { jsonPath, apiResponseSavePath }
            };
        },
        examples: [
            "Get value '$.data.id' from stored response 'userResponse'",
            "Extract '$.token' from the stored response 'loginResult'"
        ]
    },

    // ========================================================================
    // SECTION D: RESPONSE VALIDATION (Priority 910-929)
    // ========================================================================
    {
        id: 'api-verify-status',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+status\s+(?:code\s+)?(?:is|equals?)\s+(\d+)$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 910,
        extract: (match) => ({
            targetText: '',
            expectedValue: match[1],
            params: { httpMethod: 'STATUS' }
        }),
        examples: [
            "Verify the API response status is 200",
            "Verify that response status code equals 201",
            "Verify response status is 404"
        ]
    },
    {
        id: 'api-verify-status-range',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+status\s+(?:code\s+)?is\s+(?:in\s+)?(?:the\s+)?(\d)xx$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 911,
        extract: (match) => ({
            targetText: '',
            expectedValue: match[1] + 'xx',
            params: { httpMethod: 'STATUS_RANGE' }
        }),
        examples: [
            "Verify the API response status is 2xx",
            "Verify response status code is in the 4xx"
        ]
    },
    {
        id: 'api-verify-header-exists',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:has|contains?)\s+header\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 912,
        extract: (match, quotedStrings) => {
            const attribute = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { attribute, comparisonOp: 'exists' }
            };
        },
        examples: [
            "Verify the API response has header 'Content-Type'",
            "Verify that response contains header 'X-Request-Id'"
        ]
    },
    {
        id: 'api-verify-header-value',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+header\s+__QUOTED_(\d+)__\s+(?:is|equals?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 913,
        extract: (match, quotedStrings) => {
            const attribute = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { attribute, comparisonOp: 'equals' }
            };
        },
        examples: [
            "Verify the API response header 'Content-Type' is 'application/json'",
            "Verify that response header 'Cache-Control' equals 'no-cache'"
        ]
    },
    {
        id: 'api-verify-body-contains',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:body\s+)?contains?\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 914,
        extract: (match, quotedStrings) => {
            const expectedValue = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { comparisonOp: 'contains' }
            };
        },
        examples: [
            "Verify the API response body contains 'success'",
            "Verify that response contains 'created'"
        ]
    },
    {
        id: 'api-verify-body-not-contains',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:body\s+)?does\s+not\s+contain\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 915,
        extract: (match, quotedStrings) => {
            const expectedValue = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { comparisonOp: 'not-contains' },
                modifiers: { negated: true }
            };
        },
        examples: [
            "Verify the API response body does not contain 'error'",
            "Verify that response does not contain 'unauthorized'"
        ]
    },
    {
        id: 'api-verify-jsonpath-equals',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+(?:is|equals?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 916,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { jsonPath, comparisonOp: 'equals' }
            };
        },
        examples: [
            "Verify the API response '$.data.name' equals 'John'",
            "Verify that response JSONPath '$.status' is 'active'"
        ]
    },
    {
        id: 'api-verify-jsonpath-contains',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+contains?\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 917,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { jsonPath, comparisonOp: 'contains' }
            };
        },
        examples: [
            "Verify the API response '$.data.description' contains 'important'",
            "Verify response JSONPath '$.message' contains 'success'"
        ]
    },
    {
        id: 'api-verify-jsonpath-exists',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+exists$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 918,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { jsonPath, comparisonOp: 'exists' }
            };
        },
        examples: [
            "Verify the API response '$.data.id' exists",
            "Verify that response JSONPath '$.token' exists"
        ]
    },
    {
        id: 'api-verify-jsonpath-not-exists',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+does\s+not\s+exist$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 919,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { jsonPath, comparisonOp: 'not-exists' },
                modifiers: { negated: true }
            };
        },
        examples: [
            "Verify the API response '$.data.password' does not exist",
            "Verify that response JSONPath '$.secret' does not exist"
        ]
    },
    {
        id: 'api-verify-jsonpath-count',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+count\s+(?:is|equals?)\s+(\d+)$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 920,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = match[2];
            return {
                targetText: '',
                expectedValue,
                params: { jsonPath, comparisonOp: 'count' }
            };
        },
        examples: [
            "Verify the API response '$.data.items' count is 5",
            "Verify response JSONPath '$.users' count equals 3"
        ]
    },
    {
        id: 'api-verify-jsonpath-gt',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+is\s+greater\s+than\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 921,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { jsonPath, comparisonOp: 'greater-than' }
            };
        },
        examples: [
            "Verify the API response '$.data.total' is greater than '0'",
            "Verify response JSONPath '$.count' is greater than '10'"
        ]
    },
    {
        id: 'api-verify-jsonpath-type',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+(?:is\s+(?:of\s+)?type|has\s+type)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 922,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { jsonPath, comparisonOp: 'type' }
            };
        },
        examples: [
            "Verify the API response '$.data.id' is of type 'number'",
            "Verify response JSONPath '$.items' has type 'array'",
            "Verify that response '$.name' is type 'string'"
        ]
    },
    {
        id: 'api-verify-jsonpath-matches',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+matches?\s+(?:pattern\s+)?__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 923,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const regexPattern = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { jsonPath, regexPattern, comparisonOp: 'matches' }
            };
        },
        examples: [
            "Verify the API response '$.data.email' matches pattern '^[\\w.]+@[\\w]+\\.[a-z]+$'",
            "Verify response JSONPath '$.id' matches '^[0-9a-f-]+$'"
        ]
    },
    {
        id: 'api-verify-schema',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+matches?\s+schema\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-schema',
        priority: 924,
        extract: (match, quotedStrings) => {
            const apiSchemaFile = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { apiSchemaFile }
            };
        },
        examples: [
            "Verify the API response matches schema 'schemas/user-response.json'",
            "Verify that response matches schema 'schemas/item-list.json'"
        ]
    },
    {
        id: 'api-verify-response-time',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+time\s+is\s+(?:less\s+than|under|below)\s+(\d+)\s*(?:ms|milliseconds?)?$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 925,
        extract: (match) => ({
            targetText: '',
            expectedValue: match[1],
            params: { comparisonOp: 'response-time-lt' }
        }),
        examples: [
            "Verify the API response time is less than 2000 ms",
            "Verify that response time is under 500",
            "Verify response time is below 1000 milliseconds"
        ]
    },
    {
        id: 'api-verify-matches-db',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+matches?\s+database\s+__QUOTED_(\d+)__\s+query\s+__QUOTED_(\d+)__\s+field\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-data-match',
        priority: 926,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const dbAlias = quotedStrings[parseInt(match[2])] || '';
            const dbQuery = quotedStrings[parseInt(match[3])] || '';
            const dbField = quotedStrings[parseInt(match[4])] || '';
            return {
                targetText: '',
                params: { jsonPath, dbAlias, dbQuery, dbField, comparisonOp: 'equals' }
            };
        },
        examples: [
            "Verify the API response '$.data.name' matches database 'PRIMARY_DB' query 'GET_USER' field 'name'"
        ]
    },
    {
        id: 'api-verify-matches-context',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+matches?\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-data-match',
        priority: 927,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const sourceContextVar = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { jsonPath, sourceContextVar, comparisonOp: 'equals' }
            };
        },
        examples: [
            "Verify the API response '$.data.id' matches context 'expectedId'",
            "Verify that response '$.total' matches context 'calculatedTotal'"
        ]
    },
    {
        id: 'api-verify-body-empty',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+body\s+is\s+empty$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 928,
        extract: () => ({
            targetText: '',
            params: { comparisonOp: 'empty' }
        }),
        examples: [
            "Verify the API response body is empty",
            "Verify that response body is empty"
        ]
    },
    {
        id: 'api-verify-redirect',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:is\s+a\s+)?redirect(?:s?\s+to\s+__QUOTED_(\d+)__)?$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 929,
        extract: (match, quotedStrings) => {
            const expectedValue = match[1] ? quotedStrings[parseInt(match[1])] || '' : undefined;
            return {
                targetText: '',
                ...(expectedValue ? { expectedValue } : {}),
                params: { comparisonOp: 'redirect' }
            };
        },
        examples: [
            "Verify the API response is a redirect",
            "Verify that response redirects to 'https://example.com/login'"
        ]
    },

    {
        id: 'api-verify-body-not-empty',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+body\s+is\s+not\s+empty$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 930,
        extract: () => ({
            targetText: '',
            params: { comparisonOp: 'not-empty' },
            modifiers: { negated: true }
        }),
        examples: [
            "Verify the API response body is not empty",
            "Verify that response body is not empty"
        ]
    },
    {
        id: 'api-verify-jsonpath-lt',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__\s+is\s+less\s+than\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 931,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { jsonPath, comparisonOp: 'less-than' }
            };
        },
        examples: [
            "Verify the API response '$.data.count' is less than '100'",
            "Verify response JSONPath '$.retries' is less than '5'"
        ]
    },
    {
        id: 'api-verify-content-type',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?response\s+content[\s-]?type\s+(?:is|equals?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 932,
        extract: (match, quotedStrings) => {
            const expectedValue = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { attribute: 'Content-Type', comparisonOp: 'equals' }
            };
        },
        examples: [
            "Verify the API response content-type is 'application/json'",
            "Verify that response content type equals 'text/xml'"
        ]
    },

    // ========================================================================
    // SECTION E: API CHAINING & WORKFLOW (Priority 935-940)
    // ========================================================================
    {
        id: 'api-extract-and-set-bearer',
        pattern: /^extract\s+(?:and\s+)?set\s+bearer\s+(?:token\s+)?from\s+(?:response\s+)?(?:jsonpath\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-chain',
        priority: 935,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { jsonPath, apiAuthType: 'bearer' }
            };
        },
        examples: [
            "Extract and set bearer token from response JSONPath '$.data.token'",
            "Extract set bearer from '$.access_token'"
        ]
    },
    {
        id: 'api-store-cookies',
        pattern: /^store\s+(?:api\s+)?response\s+cookies\s+(?:to|as|in)\s+context\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-chain',
        priority: 936,
        extract: (match, quotedStrings) => {
            const apiContext = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { apiContext, jsonPath: '$.cookies' }
            };
        },
        examples: [
            "Store API response cookies to context 'sessionCookies'",
            "Store response cookies as context 'authCookies'"
        ]
    },
    {
        id: 'api-login-flow',
        pattern: /^(?:execute|run)\s+api\s+login\s+(?:flow\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+with\s+body\s+__QUOTED_(\d+)__\s+(?:and\s+)?(?:extract|save)\s+(?:token\s+from\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-chain',
        priority: 937,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const requestBody = quotedStrings[parseInt(match[2])] || '';
            const jsonPath = quotedStrings[parseInt(match[3])] || '';
            return {
                targetText: '',
                params: { httpMethod: 'POST', apiUrl, requestBody, jsonPath, apiAuthType: 'bearer' }
            };
        },
        examples: [
            "Execute API login flow to '/api/auth/login' with body '{\"user\":\"admin\",\"pass\":\"secret\"}' and extract token from '$.token'",
            "Run API login '/api/login' with body '{\"email\":\"test@example.com\"}' extract '$.data.jwt'"
        ]
    },
    {
        id: 'api-set-body-from-response',
        pattern: /^set\s+(?:next\s+)?(?:api\s+)?request\s+body\s+from\s+(?:previous\s+)?response\s+(?:jsonpath\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-chain',
        priority: 938,
        extract: (match, quotedStrings) => {
            const jsonPath = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { jsonPath }
            };
        },
        examples: [
            "Set next API request body from previous response JSONPath '$.data'",
            "Set request body from response '$.payload'"
        ]
    },
    {
        id: 'api-execute-chain-file',
        pattern: /^(?:execute|run)\s+api\s+chain\s+(?:from\s+)?(?:file\s+)?__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-execute-chain',
        priority: 939,
        extract: (match, quotedStrings) => {
            const apiChainFile = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { apiChainFile }
            };
        },
        examples: [
            "Execute API chain from file 'chains/user-create-flow.json'",
            "Run API chain 'chains/order-workflow.yaml'"
        ]
    },
    {
        id: 'api-retry-until',
        pattern: /^retry\s+(?:api\s+)?(GET|POST|PUT|PATCH|DELETE)\s+__QUOTED_(\d+)__\s+until\s+__QUOTED_(\d+)__\s+(?:is|equals?)\s+__QUOTED_(\d+)__(?:\s+every\s+(\d+)\s*(?:ms|milliseconds?)?)?(?:\s+(?:max|timeout)\s+(\d+)\s*(?:ms|milliseconds?)?)?$/i,
        category: 'action',
        intent: 'api-poll',
        priority: 940,
        extract: (match, quotedStrings) => {
            const httpMethod = match[1].toUpperCase();
            const apiUrl = quotedStrings[parseInt(match[2])] || '';
            const apiPollField = quotedStrings[parseInt(match[3])] || '';
            const apiPollExpected = quotedStrings[parseInt(match[4])] || '';
            const apiPollInterval = match[5] ? parseInt(match[5]) : undefined;
            const apiPollMaxTime = match[6] ? parseInt(match[6]) : undefined;
            return {
                targetText: '',
                params: {
                    httpMethod,
                    apiUrl,
                    apiPollField,
                    apiPollExpected,
                    ...(apiPollInterval ? { apiPollInterval } : {}),
                    ...(apiPollMaxTime ? { apiPollMaxTime } : {})
                }
            };
        },
        examples: [
            "Retry API GET '/api/jobs/123' until '$.status' equals 'completed' every 3000 ms max 90000 ms",
            "Retry POST '/api/process' until '$.state' is 'done' every 5000 timeout 60000"
        ]
    },

    // ========================================================================
    // SECTION F: SOAP/XML (Priority 945-948)
    // ========================================================================
    {
        id: 'api-soap-call',
        pattern: /^(?:send|make|execute|call)\s+(?:a\s+)?soap\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+operation\s+__QUOTED_(\d+)__(?:\s+with\s+(?:params?\s+)?__QUOTED_(\d+)__)?$/i,
        category: 'action',
        intent: 'api-soap',
        priority: 945,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const soapOperation = quotedStrings[parseInt(match[2])] || '';
            const soapParams = match[3] ? quotedStrings[parseInt(match[3])] || '' : undefined;
            return {
                targetText: '',
                params: { apiUrl, soapOperation, ...(soapParams ? { soapParams } : {}) }
            };
        },
        examples: [
            "Send SOAP request to 'https://ws.example.com/service' operation 'GetUser' with params '{\"id\":1}'",
            "Call SOAP 'https://api.example.com/ws' operation 'ListItems'",
            "Execute a SOAP request to 'https://ws.example.com/orders' operation 'CreateOrder' with '{\"item\":\"A1\"}'"
        ]
    },
    {
        id: 'api-soap-from-file',
        pattern: /^(?:send|make|execute|call)\s+(?:a\s+)?soap\s+(?:request\s+)?(?:to\s+)?__QUOTED_(\d+)__\s+(?:from|with)\s+file\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'api-soap',
        priority: 946,
        extract: (match, quotedStrings) => {
            const apiUrl = quotedStrings[parseInt(match[1])] || '';
            const apiPayloadFile = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                params: { apiUrl, apiPayloadFile }
            };
        },
        examples: [
            "Send SOAP request to 'https://ws.example.com/service' from file 'soap/get-user-request.xml'",
            "Call SOAP 'https://api.example.com/ws' with file 'soap/create-order.xml'"
        ]
    },
    {
        id: 'api-verify-xpath',
        pattern: /^verify\s+(?:that\s+)?(?:the\s+)?(?:api\s+)?(?:soap\s+)?response\s+xpath\s+__QUOTED_(\d+)__\s+(?:is|equals?)\s+__QUOTED_(\d+)__$/i,
        category: 'assertion',
        intent: 'verify-api-response',
        priority: 947,
        extract: (match, quotedStrings) => {
            const xpathExpression = quotedStrings[parseInt(match[1])] || '';
            const expectedValue = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: '',
                expectedValue,
                params: { xpathExpression, comparisonOp: 'equals' }
            };
        },
        examples: [
            "Verify the SOAP response XPath '//user/name' equals 'John'",
            "Verify that API response XPath '//status' is 'success'"
        ]
    },
    {
        id: 'api-extract-xpath',
        pattern: /^(?:get|extract|read)\s+(?:the\s+)?(?:value\s+)?(?:at\s+)?xpath\s+__QUOTED_(\d+)__\s+from\s+(?:the\s+)?(?:api\s+)?(?:soap\s+)?response$/i,
        category: 'query',
        intent: 'get-api-response',
        priority: 948,
        extract: (match, quotedStrings) => {
            const xpathExpression = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { xpathExpression }
            };
        },
        examples: [
            "Get value at XPath '//user/email' from the SOAP response",
            "Extract XPath '//order/total' from the API response"
        ]
    }
];
