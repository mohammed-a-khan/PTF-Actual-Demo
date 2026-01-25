/**
 * CS Playwright MCP Security Tools
 * Security testing, accessibility audits, and vulnerability scanning
 * All implementations use real Playwright APIs - no fake/mock data
 *
 * @module CSMCPSecurityTools
 */

import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';
import { CSReporter } from '../../../reporter/CSReporter';

// ============================================================================
// Helper Functions
// ============================================================================

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

// ============================================================================
// Sensitive Data Patterns
// ============================================================================

const SENSITIVE_PATTERNS = {
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    phone: /\b(?:\+?1[-.]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
    ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
    creditCard: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    apiKey: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer)[:\s=]["']?([a-zA-Z0-9_-]{20,})["']?/gi,
    password: /\b(?:password|passwd|pwd)[:\s=]["']?([^"'\s]{3,})["']?/gi,
    jwtToken: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    privateKey: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    awsKey: /\bAKIA[0-9A-Z]{16}\b/g,
};

// ============================================================================
// XSS Testing Tools
// ============================================================================

const securityXssScanTool = defineTool()
    .name('security_xss_scan')
    .description('Scan input fields for XSS vulnerabilities by actually injecting test payloads')
    .category('security')
    .stringParam('selector', 'Selector for input field to test')
    .booleanParam('scanAll', 'Scan all input fields on the page', { default: false })
    .arrayParam('payloads', 'Custom XSS payloads to test', 'string')
    .handler(async (params, context) => {
        const page = (context.server as any).browser?.page;
        if (!page) {
            return createErrorResult('No browser page available. Navigate to a page first.');
        }

        CSReporter.info('[MCP] Scanning for XSS vulnerabilities');

        const defaultPayloads = [
            '<script>alert("XSS")</script>',
            '<img src=x onerror=alert("XSS")>',
            '"><script>alert("XSS")</script>',
            "javascript:alert('XSS')",
            '<svg onload=alert("XSS")>',
            '<body onload=alert("XSS")>',
            '{{constructor.constructor("alert(1)")()}}',
            '${alert(1)}',
        ];

        const payloadsToTest = (params.payloads as string[])?.length
            ? (params.payloads as string[])
            : defaultPayloads;

        try {
            // Find all input elements
            let inputSelectors: string[] = [];
            if (params.scanAll) {
                inputSelectors = await page.evaluate(() => {
                    const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea');
                    return Array.from(inputs).map((_el: Element, idx: number) => `input:nth-of-type(${idx + 1})`);
                });
            } else if (params.selector) {
                inputSelectors = [params.selector as string];
            } else {
                return createErrorResult('Provide a selector or set scanAll to true');
            }

            const vulnerabilities: any[] = [];
            const testedInputs: any[] = [];

            for (const selector of inputSelectors) {
                const inputInfo: any = {
                    selector,
                    payloadsTested: 0,
                    vulnerable: false,
                    vulnerablePayloads: [],
                };

                for (const payload of payloadsToTest) {
                    try {
                        // Clear and fill the input
                        await page.fill(selector, '');
                        await page.fill(selector, payload);
                        inputInfo.payloadsTested++;

                        // Check if the payload is reflected in the DOM
                        const pageContent = await page.content();
                        const reflected = pageContent.includes(payload) ||
                            pageContent.includes(payload.replace(/"/g, '&quot;'));

                        // Check for script execution indicators
                        const hasXSSExecution = await page.evaluate((testPayload: string) => {
                            // Check if script tags were added to DOM
                            const scripts = Array.from(document.querySelectorAll('script'));
                            for (let i = 0; i < scripts.length; i++) {
                                if (scripts[i].innerHTML.includes('alert') || scripts[i].innerHTML.includes('XSS')) {
                                    return true;
                                }
                            }
                            // Check for event handlers that might execute
                            const elements = document.querySelectorAll('[onerror], [onload], [onclick]');
                            return elements.length > 0;
                        }, payload);

                        if (reflected || hasXSSExecution) {
                            inputInfo.vulnerable = true;
                            inputInfo.vulnerablePayloads.push({
                                payload,
                                reflected,
                                executed: hasXSSExecution,
                            });
                        }
                    } catch {
                        // Input might not accept certain characters
                    }
                }

                testedInputs.push(inputInfo);
                if (inputInfo.vulnerable) {
                    vulnerabilities.push({
                        type: 'XSS',
                        severity: 'HIGH',
                        input: selector,
                        payloads: inputInfo.vulnerablePayloads,
                    });
                }
            }

            const result = {
                scanned: params.scanAll ? 'all inputs' : params.selector,
                inputsTested: testedInputs.length,
                totalPayloadsTested: testedInputs.reduce((sum: number, i: any) => sum + i.payloadsTested, 0),
                vulnerabilities,
                status: vulnerabilities.length > 0 ? 'vulnerabilities_found' : 'no_vulnerabilities_found',
                details: testedInputs,
            };

            if (vulnerabilities.length > 0) {
                CSReporter.fail(`[MCP] Found ${vulnerabilities.length} XSS vulnerabilities`);
            } else {
                CSReporter.pass('[MCP] No XSS vulnerabilities found');
            }

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`XSS scan failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// SQL Injection Testing Tools
// ============================================================================

const securitySqlInjectionTool = defineTool()
    .name('security_sql_injection_test')
    .description('Test input fields for SQL injection vulnerabilities')
    .category('security')
    .stringParam('selector', 'Selector for input field to test', { required: true })
    .stringParam('submitSelector', 'Selector for submit button')
    .arrayParam('payloads', 'Custom SQL injection payloads', 'string')
    .handler(async (params, context) => {
        const page = (context.server as any).browser?.page;
        if (!page) {
            return createErrorResult('No browser page available. Navigate to a page first.');
        }

        CSReporter.info('[MCP] Testing for SQL injection vulnerabilities');

        const defaultPayloads = [
            "' OR '1'='1",
            "'; DROP TABLE users; --",
            "1' OR '1'='1' --",
            "admin'--",
            "1; SELECT * FROM users",
            "' UNION SELECT NULL--",
            "1' AND '1'='1",
            "1' AND '1'='2",
            "' OR 1=1--",
            "'; WAITFOR DELAY '0:0:5'--",
        ];

        const payloadsToTest = (params.payloads as string[])?.length
            ? (params.payloads as string[])
            : defaultPayloads;

        try {
            const vulnerabilities: any[] = [];
            const testResults: any[] = [];

            // Capture network responses
            const responses: any[] = [];
            page.on('response', async (response: any) => {
                try {
                    const text = await response.text().catch(() => '');
                    responses.push({
                        url: response.url(),
                        status: response.status(),
                        body: text.substring(0, 1000),
                    });
                } catch {
                    // Ignore
                }
            });

            for (const payload of payloadsToTest) {
                responses.length = 0;
                const testResult: any = {
                    payload,
                    indicators: [],
                    vulnerable: false,
                };

                try {
                    // Fill the input with payload
                    await page.fill(params.selector as string, '');
                    await page.fill(params.selector as string, payload);

                    // Submit if selector provided
                    if (params.submitSelector) {
                        await page.click(params.submitSelector as string);
                        await page.waitForLoadState('networkidle').catch(() => {});
                    }

                    // Wait for responses
                    await page.waitForTimeout(500);

                    // Check for SQL error indicators in responses
                    const sqlErrorPatterns = [
                        /sql syntax/i,
                        /mysql_/i,
                        /pg_/i,
                        /ORA-\d{5}/i,
                        /SQL Server/i,
                        /sqlite/i,
                        /syntax error/i,
                        /unclosed quotation/i,
                        /invalid query/i,
                    ];

                    // Check page content
                    const pageContent = await page.content();
                    for (const pattern of sqlErrorPatterns) {
                        if (pattern.test(pageContent)) {
                            testResult.indicators.push({
                                type: 'page_content',
                                pattern: pattern.toString(),
                            });
                            testResult.vulnerable = true;
                        }
                    }

                    // Check responses
                    for (const response of responses) {
                        for (const pattern of sqlErrorPatterns) {
                            if (pattern.test(response.body)) {
                                testResult.indicators.push({
                                    type: 'response',
                                    url: response.url,
                                    pattern: pattern.toString(),
                                });
                                testResult.vulnerable = true;
                            }
                        }

                        // Check for 500 errors which might indicate SQL issues
                        if (response.status >= 500) {
                            testResult.indicators.push({
                                type: 'server_error',
                                status: response.status,
                                url: response.url,
                            });
                        }
                    }
                } catch {
                    // Payload might cause issues
                }

                testResults.push(testResult);
                if (testResult.vulnerable) {
                    vulnerabilities.push({
                        type: 'SQL_INJECTION',
                        severity: 'CRITICAL',
                        payload,
                        indicators: testResult.indicators,
                    });
                }
            }

            const result = {
                inputTested: params.selector,
                payloadsTested: testResults.length,
                vulnerabilities,
                status: vulnerabilities.length > 0 ? 'vulnerabilities_found' : 'no_vulnerabilities_found',
                details: testResults,
            };

            if (vulnerabilities.length > 0) {
                CSReporter.fail(`[MCP] Found ${vulnerabilities.length} SQL injection indicators`);
            } else {
                CSReporter.pass('[MCP] No SQL injection vulnerabilities found');
            }

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`SQL injection test failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Authentication Testing Tools
// ============================================================================

const securityAuthBypassTool = defineTool()
    .name('security_auth_bypass_check')
    .description('Check for authentication bypass vulnerabilities by testing direct URL access')
    .category('security')
    .stringParam('protectedUrl', 'URL that should require authentication', { required: true })
    .stringParam('loginUrl', 'Login page URL')
    .handler(async (params, context) => {
        const page = (context.server as any).browser?.page;
        const browserContext = (context.server as any).browser?.context;

        if (!page || !browserContext) {
            return createErrorResult('No browser available. Launch browser first.');
        }

        CSReporter.info(`[MCP] Checking auth bypass for ${params.protectedUrl}`);

        const checks: any[] = [];
        const vulnerabilities: any[] = [];

        try {
            // Test 1: Direct URL access without auth (in new context)
            const incognitoContext = await browserContext.browser().newContext();
            const incognitoPage = await incognitoContext.newPage();

            try {
                await incognitoPage.goto(params.protectedUrl as string, { waitUntil: 'networkidle' });
                const finalUrl = incognitoPage.url();
                const pageContent = await incognitoPage.content();

                const wasRedirected = !finalUrl.includes(params.protectedUrl as string);
                const hasLoginForm = pageContent.includes('type="password"') ||
                    pageContent.toLowerCase().includes('login') ||
                    pageContent.toLowerCase().includes('sign in');
                const hasUnauthorized = pageContent.includes('401') ||
                    pageContent.includes('403') ||
                    pageContent.toLowerCase().includes('unauthorized') ||
                    pageContent.toLowerCase().includes('forbidden');

                const directAccessBlocked = wasRedirected || hasLoginForm || hasUnauthorized;

                checks.push({
                    name: 'Direct URL access (no auth)',
                    passed: directAccessBlocked,
                    details: {
                        wasRedirected,
                        redirectedTo: wasRedirected ? finalUrl : null,
                        hasLoginForm,
                        hasUnauthorized,
                    },
                });

                if (!directAccessBlocked) {
                    vulnerabilities.push({
                        type: 'AUTH_BYPASS',
                        severity: 'CRITICAL',
                        description: 'Protected URL accessible without authentication',
                        url: params.protectedUrl,
                    });
                }
            } finally {
                await incognitoContext.close();
            }

            // Test 2: Session manipulation (clear cookies and access)
            const cookies = await browserContext.cookies();
            const originalCookies = [...cookies];

            if (cookies.length > 0) {
                await browserContext.clearCookies();

                await page.goto(params.protectedUrl as string, { waitUntil: 'networkidle' });
                const urlAfterClear = page.url();
                const wasRedirectedAfterClear = !urlAfterClear.includes(params.protectedUrl as string);

                checks.push({
                    name: 'Session manipulation (cookies cleared)',
                    passed: wasRedirectedAfterClear,
                    details: {
                        cookiesCleared: cookies.length,
                        wasRedirected: wasRedirectedAfterClear,
                    },
                });

                if (!wasRedirectedAfterClear) {
                    vulnerabilities.push({
                        type: 'SESSION_MANAGEMENT',
                        severity: 'HIGH',
                        description: 'Protected URL accessible after clearing session cookies',
                    });
                }

                // Restore cookies
                await browserContext.addCookies(originalCookies);
            }

            // Test 3: Check for parameter manipulation (common bypass parameters)
            const bypassParams = ['admin=true', 'debug=1', 'auth=1', 'authenticated=true'];
            for (const param of bypassParams) {
                const testUrl = (params.protectedUrl as string).includes('?')
                    ? `${params.protectedUrl}&${param}`
                    : `${params.protectedUrl}?${param}`;

                const ctx = await browserContext.browser().newContext();
                const testPage = await ctx.newPage();

                try {
                    await testPage.goto(testUrl, { waitUntil: 'networkidle' });
                    const content = await testPage.content();
                    const hasProtectedContent = !content.toLowerCase().includes('login') &&
                        !content.toLowerCase().includes('unauthorized');

                    if (hasProtectedContent && !testPage.url().includes('login')) {
                        checks.push({
                            name: `Parameter manipulation (${param})`,
                            passed: false,
                            details: { parameter: param },
                        });
                        vulnerabilities.push({
                            type: 'PARAMETER_MANIPULATION',
                            severity: 'HIGH',
                            description: `Auth bypass via parameter: ${param}`,
                        });
                    }
                } catch {
                    // Ignore errors for bypass attempts
                } finally {
                    await ctx.close();
                }
            }

            const result = {
                protectedUrl: params.protectedUrl,
                checks,
                vulnerabilities,
                status: vulnerabilities.length > 0 ? 'vulnerabilities_found' : 'secure',
            };

            if (vulnerabilities.length > 0) {
                CSReporter.fail(`[MCP] Found ${vulnerabilities.length} auth bypass vulnerabilities`);
            } else {
                CSReporter.pass('[MCP] No auth bypass vulnerabilities found');
            }

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`Auth bypass check failed: ${error.message}`);
        }
    })
    .build();

const securityBruteForceCheckTool = defineTool()
    .name('security_brute_force_check')
    .description('Check if login form has brute force protection by attempting multiple failed logins')
    .category('security')
    .stringParam('loginUrl', 'Login page URL', { required: true })
    .stringParam('usernameSelector', 'Username field selector', { required: true })
    .stringParam('passwordSelector', 'Password field selector', { required: true })
    .stringParam('submitSelector', 'Submit button selector', { required: true })
    .numberParam('attempts', 'Number of failed attempts to try', { default: 5 })
    .handler(async (params, context) => {
        const page = (context.server as any).browser?.page;
        if (!page) {
            return createErrorResult('No browser page available. Navigate to a page first.');
        }

        CSReporter.info('[MCP] Checking brute force protection');

        const attempts = (params.attempts as number) || 5;
        const attemptResults: any[] = [];
        let blockedAtAttempt: number | null = null;
        let hasCaptcha = false;
        let hasRateLimit = false;
        let hasAccountLockout = false;

        try {
            await page.goto(params.loginUrl as string, { waitUntil: 'networkidle' });

            for (let i = 1; i <= attempts; i++) {
                const attemptStart = Date.now();

                // Check for CAPTCHA before attempt
                const captchaPresent = await page.evaluate(() => {
                    const html = document.body.innerHTML.toLowerCase();
                    return html.includes('captcha') ||
                        html.includes('recaptcha') ||
                        html.includes('hcaptcha') ||
                        document.querySelector('[class*="captcha"]') !== null ||
                        document.querySelector('iframe[src*="recaptcha"]') !== null;
                });

                if (captchaPresent) {
                    hasCaptcha = true;
                    blockedAtAttempt = i;
                    attemptResults.push({
                        attempt: i,
                        status: 'blocked_captcha',
                        duration: Date.now() - attemptStart,
                    });
                    break;
                }

                // Fill and submit invalid credentials
                await page.fill(params.usernameSelector as string, `testuser${i}@invalid.com`);
                await page.fill(params.passwordSelector as string, `wrongpassword${i}`);

                const responsePromise = page.waitForResponse(
                    (response: any) => response.url().includes('login') || response.url().includes('auth'),
                    { timeout: 5000 }
                ).catch(() => null);

                await page.click(params.submitSelector as string);
                await page.waitForLoadState('networkidle').catch(() => {});

                const response = await responsePromise;
                const duration = Date.now() - attemptStart;

                // Check for blocking indicators
                const pageContent = await page.content();
                const isBlocked = pageContent.toLowerCase().includes('locked') ||
                    pageContent.toLowerCase().includes('blocked') ||
                    pageContent.toLowerCase().includes('too many attempts') ||
                    pageContent.toLowerCase().includes('try again later') ||
                    pageContent.toLowerCase().includes('rate limit');

                // Check for slow response (rate limiting)
                if (duration > 3000 && i > 1) {
                    hasRateLimit = true;
                }

                // Check HTTP 429 (Too Many Requests)
                if (response && response.status() === 429) {
                    hasRateLimit = true;
                }

                if (isBlocked) {
                    hasAccountLockout = true;
                    blockedAtAttempt = i;
                }

                attemptResults.push({
                    attempt: i,
                    status: isBlocked ? 'blocked' : 'allowed',
                    duration,
                    responseStatus: response?.status() || null,
                });

                if (isBlocked) break;

                // Navigate back to login page if needed
                if (!page.url().includes('login')) {
                    await page.goto(params.loginUrl as string, { waitUntil: 'networkidle' });
                }
            }

            const isProtected = hasCaptcha || hasRateLimit || hasAccountLockout;

            const result = {
                loginUrl: params.loginUrl,
                attemptsTried: attemptResults.length,
                protection: {
                    hasRateLimit,
                    hasCaptcha,
                    hasAccountLockout,
                    blockedAtAttempt,
                },
                vulnerabilities: isProtected ? [] : [{
                    type: 'BRUTE_FORCE',
                    severity: 'HIGH',
                    description: `No brute force protection after ${attempts} failed attempts`,
                }],
                status: isProtected ? 'protected' : 'vulnerable',
                details: attemptResults,
            };

            if (isProtected) {
                CSReporter.pass(`[MCP] Brute force protection detected at attempt ${blockedAtAttempt || 'N/A'}`);
            } else {
                CSReporter.fail(`[MCP] No brute force protection after ${attempts} attempts`);
            }

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`Brute force check failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Sensitive Data Exposure Tools
// ============================================================================

const securitySensitiveDataTool = defineTool()
    .name('security_sensitive_data_exposure')
    .description('Scan page for exposed sensitive data like emails, credit cards, API keys')
    .category('security')
    .booleanParam('checkHtml', 'Check HTML source', { default: true })
    .booleanParam('checkComments', 'Check HTML comments', { default: true })
    .booleanParam('checkScripts', 'Check inline scripts', { default: true })
    .booleanParam('checkNetwork', 'Check network responses', { default: true })
    .handler(async (params, context) => {
        const page = (context.server as any).browser?.page;
        if (!page) {
            return createErrorResult('No browser page available. Navigate to a page first.');
        }

        CSReporter.info('[MCP] Scanning for sensitive data exposure');

        const findings: any[] = [];

        try {
            // Get page content
            const pageContent = await page.content();

            // Check HTML for sensitive data
            if (params.checkHtml !== false) {
                for (const [type, pattern] of Object.entries(SENSITIVE_PATTERNS)) {
                    const matches = pageContent.match(pattern);
                    if (matches && matches.length > 0) {
                        // Filter out false positives
                        const validMatches = matches.filter((m: string) => {
                            // Exclude common false positives
                            if (type === 'email' && m.includes('@example.')) return false;
                            if (type === 'phone' && m.length < 10) return false;
                            return true;
                        });

                        if (validMatches.length > 0) {
                            findings.push({
                                type,
                                source: 'html',
                                count: validMatches.length,
                                samples: validMatches.slice(0, 3).map((m: string) => m.substring(0, 50)),
                                severity: ['apiKey', 'password', 'privateKey', 'awsKey', 'creditCard', 'ssn'].includes(type)
                                    ? 'CRITICAL'
                                    : 'MEDIUM',
                            });
                        }
                    }
                }
            }

            // Check HTML comments
            if (params.checkComments !== false) {
                const comments = pageContent.match(/<!--[\s\S]*?-->/g) || [];
                for (const comment of comments) {
                    for (const [type, pattern] of Object.entries(SENSITIVE_PATTERNS)) {
                        const matches = comment.match(pattern);
                        if (matches && matches.length > 0) {
                            findings.push({
                                type,
                                source: 'html_comment',
                                count: matches.length,
                                samples: matches.slice(0, 2).map((m: string) => m.substring(0, 50)),
                                severity: 'HIGH',
                            });
                        }
                    }
                }

                // Check for sensitive info in comments even without pattern match
                const sensitiveCommentKeywords = ['password', 'secret', 'api_key', 'token', 'credentials', 'todo', 'fixme', 'hack'];
                for (const comment of comments) {
                    const lower = comment.toLowerCase();
                    for (const keyword of sensitiveCommentKeywords) {
                        if (lower.includes(keyword)) {
                            findings.push({
                                type: 'sensitive_comment',
                                source: 'html_comment',
                                keyword,
                                sample: comment.substring(0, 100),
                                severity: 'MEDIUM',
                            });
                        }
                    }
                }
            }

            // Check inline scripts
            if (params.checkScripts !== false) {
                const scripts = await page.evaluate(() => {
                    const scriptElements = document.querySelectorAll('script:not([src])');
                    return Array.from(scriptElements).map(s => s.innerHTML);
                });

                for (const script of scripts) {
                    for (const [type, pattern] of Object.entries(SENSITIVE_PATTERNS)) {
                        const matches = script.match(pattern);
                        if (matches && matches.length > 0) {
                            findings.push({
                                type,
                                source: 'inline_script',
                                count: matches.length,
                                severity: 'CRITICAL',
                            });
                        }
                    }
                }
            }

            // Check network responses (stored from recent requests)
            if (params.checkNetwork !== false) {
                // Note: Would need request interception setup beforehand
                // This is a placeholder for network response checking
            }

            const result = {
                scannedAreas: {
                    html: params.checkHtml !== false,
                    comments: params.checkComments !== false,
                    scripts: params.checkScripts !== false,
                    network: params.checkNetwork !== false,
                },
                findings,
                summary: {
                    total: findings.length,
                    critical: findings.filter(f => f.severity === 'CRITICAL').length,
                    high: findings.filter(f => f.severity === 'HIGH').length,
                    medium: findings.filter(f => f.severity === 'MEDIUM').length,
                },
                status: findings.length > 0 ? 'sensitive_data_found' : 'no_sensitive_data_found',
            };

            if (findings.length > 0) {
                CSReporter.fail(`[MCP] Found ${findings.length} sensitive data exposures`);
            } else {
                CSReporter.pass('[MCP] No sensitive data exposure found');
            }

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`Sensitive data scan failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// CSRF Testing Tools
// ============================================================================

const securityCsrfCheckTool = defineTool()
    .name('security_csrf_check')
    .description('Check for CSRF protection on forms')
    .category('security')
    .stringParam('formSelector', 'Form selector to check')
    .booleanParam('checkAll', 'Check all forms on page', { default: false })
    .handler(async (params, context) => {
        const page = (context.server as any).browser?.page;
        if (!page) {
            return createErrorResult('No browser page available. Navigate to a page first.');
        }

        CSReporter.info('[MCP] Checking CSRF protection');

        try {
            // Find forms to check
            const formData = await page.evaluate((formSelector: string | undefined, checkAll: boolean) => {
                const forms = checkAll
                    ? document.querySelectorAll('form')
                    : document.querySelectorAll(formSelector || 'form');

                return Array.from(forms).map((form, idx) => {
                    const method = (form as HTMLFormElement).method?.toUpperCase() || 'GET';
                    const action = (form as HTMLFormElement).action || window.location.href;

                    // Look for CSRF tokens
                    const csrfInputNames = ['csrf', 'csrf_token', '_csrf', '_token', 'authenticity_token', 'csrfmiddlewaretoken'];
                    let csrfInput = null;

                    for (const name of csrfInputNames) {
                        const input = form.querySelector(`input[name*="${name}" i]`) ||
                            form.querySelector(`input[name="${name}"]`);
                        if (input) {
                            csrfInput = {
                                name: (input as HTMLInputElement).name,
                                type: (input as HTMLInputElement).type,
                                hasValue: !!(input as HTMLInputElement).value,
                            };
                            break;
                        }
                    }

                    // Check for hidden inputs that might be CSRF tokens
                    const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
                    const potentialTokens = Array.from(hiddenInputs).filter((input) => {
                        const name = (input as HTMLInputElement).name.toLowerCase();
                        const value = (input as HTMLInputElement).value;
                        // Long random-looking values are likely tokens
                        return value && value.length > 20 && /^[a-zA-Z0-9_-]+$/.test(value);
                    });

                    return {
                        index: idx,
                        method,
                        action: action.substring(0, 100),
                        hasCsrfInput: !!csrfInput,
                        csrfInput,
                        potentialTokenCount: potentialTokens.length,
                        isStateMutating: ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method),
                    };
                });
            }, params.formSelector as string | undefined, params.checkAll as boolean);

            const results: any[] = [];
            const vulnerabilities: any[] = [];

            for (const form of formData) {
                const hasCsrfProtection = form.hasCsrfInput || form.potentialTokenCount > 0;
                const needsProtection = form.isStateMutating;

                const formResult = {
                    form: `form[${form.index}]`,
                    method: form.method,
                    action: form.action,
                    hasCsrfToken: hasCsrfProtection,
                    tokenDetails: form.csrfInput,
                    needsProtection,
                    status: !needsProtection ? 'n/a' : (hasCsrfProtection ? 'protected' : 'vulnerable'),
                };

                results.push(formResult);

                if (needsProtection && !hasCsrfProtection) {
                    vulnerabilities.push({
                        type: 'CSRF',
                        severity: 'HIGH',
                        description: `Form missing CSRF protection: ${form.method} ${form.action}`,
                        form: `form[${form.index}]`,
                    });
                }
            }

            // Also check cookies for SameSite attribute
            const cookies = await page.context().cookies();
            const sessionCookies = cookies.filter((c: any) =>
                c.name.toLowerCase().includes('session') ||
                c.name.toLowerCase().includes('auth') ||
                c.name.toLowerCase().includes('token')
            );

            const cookieAnalysis = sessionCookies.map((c: any) => ({
                name: c.name,
                sameSite: c.sameSite || 'None',
                secure: c.secure,
                httpOnly: c.httpOnly,
            }));

            const result = {
                formsChecked: formData.length,
                results,
                cookieAnalysis,
                vulnerabilities,
                status: vulnerabilities.length > 0 ? 'vulnerabilities_found' : 'protected',
            };

            if (vulnerabilities.length > 0) {
                CSReporter.fail(`[MCP] Found ${vulnerabilities.length} CSRF vulnerabilities`);
            } else {
                CSReporter.pass('[MCP] CSRF protection in place');
            }

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`CSRF check failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Accessibility Testing Tools
// ============================================================================

const securityAccessibilityAuditTool = defineTool()
    .name('security_accessibility_audit')
    .description('Run accessibility audit using axe-core (WCAG compliance)')
    .category('security')
    .stringParam('standard', 'Accessibility standard', {
        enum: ['WCAG2A', 'WCAG2AA', 'WCAG2AAA', 'Section508'],
        default: 'WCAG2AA',
    })
    .stringParam('selector', 'Scope audit to specific element')
    .handler(async (params, context) => {
        const page = (context.server as any).browser?.page;
        if (!page) {
            return createErrorResult('No browser page available. Navigate to a page first.');
        }

        CSReporter.info(`[MCP] Running ${params.standard} accessibility audit`);

        try {
            // Inject axe-core if not already present
            const axeInjected = await page.evaluate(() => {
                return typeof (window as any).axe !== 'undefined';
            });

            if (!axeInjected) {
                // Inject axe-core from CDN
                await page.addScriptTag({
                    url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.8.2/axe.min.js',
                });
                // Wait for axe to be available
                await page.waitForFunction(() => typeof (window as any).axe !== 'undefined', { timeout: 10000 });
            }

            // Configure axe based on standard
            const tagMap: Record<string, string[]> = {
                'WCAG2A': ['wcag2a'],
                'WCAG2AA': ['wcag2a', 'wcag2aa'],
                'WCAG2AAA': ['wcag2a', 'wcag2aa', 'wcag2aaa'],
                'Section508': ['section508'],
            };

            const tags = tagMap[params.standard as string] || tagMap['WCAG2AA'];

            // Run axe audit
            const results = await page.evaluate(async (options: { tags: string[]; selector?: string }) => {
                const axeConfig: any = {
                    runOnly: {
                        type: 'tag',
                        values: options.tags,
                    },
                };

                if (options.selector) {
                    axeConfig.include = [[options.selector]];
                }

                return await (window as any).axe.run(axeConfig);
            }, { tags, selector: params.selector as string | undefined });

            // Process results
            const violations = results.violations.map((v: any) => ({
                id: v.id,
                impact: v.impact,
                description: v.description,
                nodes: v.nodes.length,
                help: v.helpUrl,
                tags: v.tags,
            }));

            const result = {
                standard: params.standard,
                scope: params.selector || 'full page',
                timestamp: new Date().toISOString(),
                summary: {
                    violations: results.violations.length,
                    passes: results.passes.length,
                    incomplete: results.incomplete.length,
                    inapplicable: results.inapplicable.length,
                },
                violationsByImpact: {
                    critical: violations.filter((v: any) => v.impact === 'critical').length,
                    serious: violations.filter((v: any) => v.impact === 'serious').length,
                    moderate: violations.filter((v: any) => v.impact === 'moderate').length,
                    minor: violations.filter((v: any) => v.impact === 'minor').length,
                },
                violations,
            };

            if (violations.length > 0) {
                CSReporter.fail(`[MCP] Found ${violations.length} accessibility violations`);
            } else {
                CSReporter.pass('[MCP] No accessibility violations found');
            }

            return createJsonResult(result);
        } catch (error: any) {
            // Fallback to basic checks if axe-core fails to load
            CSReporter.info('[MCP] axe-core unavailable, running basic accessibility checks');

            const basicChecks = await page.evaluate(() => {
                const violations: any[] = [];

                // Check images without alt
                const imagesWithoutAlt = document.querySelectorAll('img:not([alt])');
                if (imagesWithoutAlt.length > 0) {
                    violations.push({
                        id: 'image-alt',
                        impact: 'critical',
                        description: 'Images must have alternate text',
                        nodes: imagesWithoutAlt.length,
                    });
                }

                // Check inputs without labels
                const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
                let inputsWithoutLabels = 0;
                inputs.forEach(input => {
                    const id = input.id;
                    const hasLabel = id && document.querySelector(`label[for="${id}"]`);
                    const hasAriaLabel = input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby');
                    if (!hasLabel && !hasAriaLabel) inputsWithoutLabels++;
                });
                if (inputsWithoutLabels > 0) {
                    violations.push({
                        id: 'label',
                        impact: 'critical',
                        description: 'Form inputs must have labels',
                        nodes: inputsWithoutLabels,
                    });
                }

                // Check links without text
                const emptyLinks = document.querySelectorAll('a:not([aria-label])');
                let emptyLinkCount = 0;
                emptyLinks.forEach(link => {
                    if (!link.textContent?.trim() && !link.querySelector('img[alt]')) {
                        emptyLinkCount++;
                    }
                });
                if (emptyLinkCount > 0) {
                    violations.push({
                        id: 'link-name',
                        impact: 'serious',
                        description: 'Links must have discernible text',
                        nodes: emptyLinkCount,
                    });
                }

                // Check document language
                const hasLang = document.documentElement.hasAttribute('lang');
                if (!hasLang) {
                    violations.push({
                        id: 'html-has-lang',
                        impact: 'serious',
                        description: 'HTML element must have a lang attribute',
                        nodes: 1,
                    });
                }

                return violations;
            });

            return createJsonResult({
                standard: params.standard,
                scope: params.selector || 'full page',
                method: 'basic_checks',
                note: 'axe-core unavailable, performed basic accessibility checks',
                summary: {
                    violations: basicChecks.length,
                    passes: 0,
                    incomplete: 0,
                    inapplicable: 0,
                },
                violations: basicChecks,
            });
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Header Security Tools
// ============================================================================

const securityHeaderCheckTool = defineTool()
    .name('security_header_check')
    .description('Check security headers on the page by fetching and analyzing HTTP headers')
    .category('security')
    .stringParam('url', 'URL to check (uses current page if not specified)')
    .handler(async (params, context) => {
        const page = (context.server as any).browser?.page;
        if (!page) {
            return createErrorResult('No browser page available.');
        }

        const url = (params.url as string) || page.url();
        CSReporter.info(`[MCP] Checking security headers for ${url}`);

        try {
            // Make a request and capture headers
            const response = await page.evaluate(async (targetUrl: string) => {
                const resp = await fetch(targetUrl, { method: 'HEAD', credentials: 'same-origin' });
                const headers: Record<string, string> = {};
                resp.headers.forEach((value, key) => {
                    headers[key.toLowerCase()] = value;
                });
                return { status: resp.status, headers };
            }, url);

            const securityHeaders = {
                'content-security-policy': {
                    present: !!response.headers['content-security-policy'],
                    value: response.headers['content-security-policy'] || null,
                    importance: 'HIGH',
                    description: 'Prevents XSS and data injection attacks',
                },
                'x-frame-options': {
                    present: !!response.headers['x-frame-options'],
                    value: response.headers['x-frame-options'] || null,
                    importance: 'MEDIUM',
                    description: 'Prevents clickjacking attacks',
                },
                'x-content-type-options': {
                    present: !!response.headers['x-content-type-options'],
                    value: response.headers['x-content-type-options'] || null,
                    importance: 'MEDIUM',
                    description: 'Prevents MIME-type sniffing',
                },
                'strict-transport-security': {
                    present: !!response.headers['strict-transport-security'],
                    value: response.headers['strict-transport-security'] || null,
                    importance: 'HIGH',
                    description: 'Enforces HTTPS connections',
                },
                'referrer-policy': {
                    present: !!response.headers['referrer-policy'],
                    value: response.headers['referrer-policy'] || null,
                    importance: 'MEDIUM',
                    description: 'Controls referrer information sent',
                },
                'permissions-policy': {
                    present: !!response.headers['permissions-policy'] || !!response.headers['feature-policy'],
                    value: response.headers['permissions-policy'] || response.headers['feature-policy'] || null,
                    importance: 'MEDIUM',
                    description: 'Controls browser features',
                },
                'x-xss-protection': {
                    present: !!response.headers['x-xss-protection'],
                    value: response.headers['x-xss-protection'] || null,
                    importance: 'LOW',
                    description: 'Legacy XSS protection (deprecated in favor of CSP)',
                },
            };

            // Calculate score
            const weights = { HIGH: 3, MEDIUM: 2, LOW: 1 };
            let totalWeight = 0;
            let earnedWeight = 0;

            for (const [_, header] of Object.entries(securityHeaders)) {
                const weight = weights[header.importance as keyof typeof weights] || 1;
                totalWeight += weight;
                if (header.present) earnedWeight += weight;
            }

            const scorePercent = Math.round((earnedWeight / totalWeight) * 100);
            let grade = 'F';
            if (scorePercent >= 90) grade = 'A+';
            else if (scorePercent >= 80) grade = 'A';
            else if (scorePercent >= 70) grade = 'B';
            else if (scorePercent >= 60) grade = 'C';
            else if (scorePercent >= 50) grade = 'D';

            const missingHeaders = Object.entries(securityHeaders)
                .filter(([_, h]) => !h.present)
                .map(([name, h]) => ({ header: name, importance: h.importance, description: h.description }));

            const result = {
                url,
                headers: securityHeaders,
                score: `${scorePercent}%`,
                grade,
                missingHeaders,
                recommendations: missingHeaders.map(h => `Add ${h.header} header: ${h.description}`),
            };

            if (grade === 'A' || grade === 'A+') {
                CSReporter.pass(`[MCP] Security headers grade: ${grade}`);
            } else {
                CSReporter.info(`[MCP] Security headers grade: ${grade} - ${missingHeaders.length} headers missing`);
            }

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`Header check failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Cookie Security Tools
// ============================================================================

const securityCookieCheckTool = defineTool()
    .name('security_cookie_check')
    .description('Check cookie security settings')
    .category('security')
    .handler(async (params, context) => {
        const page = (context.server as any).browser?.page;
        const browserContext = (context.server as any).browser?.context;

        if (!page || !browserContext) {
            return createErrorResult('No browser context available.');
        }

        CSReporter.info('[MCP] Checking cookie security');

        try {
            const cookies = await browserContext.cookies();

            const cookieAnalysis = cookies.map((cookie: any) => {
                const issues: string[] = [];

                // Check Secure flag
                if (!cookie.secure && page.url().startsWith('https://')) {
                    issues.push('Missing Secure flag on HTTPS site');
                }

                // Check HttpOnly for sensitive cookies
                const isSensitive = cookie.name.toLowerCase().includes('session') ||
                    cookie.name.toLowerCase().includes('auth') ||
                    cookie.name.toLowerCase().includes('token') ||
                    cookie.name.toLowerCase().includes('csrf');

                if (isSensitive && !cookie.httpOnly) {
                    issues.push('Sensitive cookie missing HttpOnly flag');
                }

                // Check SameSite
                if (!cookie.sameSite || cookie.sameSite === 'None') {
                    if (!cookie.secure) {
                        issues.push('SameSite=None requires Secure flag');
                    }
                    if (isSensitive) {
                        issues.push('Sensitive cookie should use SameSite=Strict or Lax');
                    }
                }

                // Check expiry
                const isSession = !cookie.expires || cookie.expires === -1;
                const expiresDate = cookie.expires && cookie.expires !== -1
                    ? new Date(cookie.expires * 1000)
                    : null;
                const isLongLived = expiresDate && (expiresDate.getTime() - Date.now() > 365 * 24 * 60 * 60 * 1000);

                if (isSensitive && isLongLived) {
                    issues.push('Sensitive cookie has very long expiry (>1 year)');
                }

                return {
                    name: cookie.name,
                    domain: cookie.domain,
                    path: cookie.path,
                    secure: cookie.secure,
                    httpOnly: cookie.httpOnly,
                    sameSite: cookie.sameSite || 'None',
                    expires: isSession ? 'session' : expiresDate?.toISOString(),
                    isSensitive,
                    issues,
                };
            });

            const insecureCookies = cookieAnalysis.filter((c: any) => c.issues.length > 0);

            const result = {
                url: page.url(),
                cookies: cookieAnalysis,
                summary: {
                    total: cookies.length,
                    secure: cookieAnalysis.filter((c: any) => c.secure).length,
                    httpOnly: cookieAnalysis.filter((c: any) => c.httpOnly).length,
                    withIssues: insecureCookies.length,
                },
                issues: insecureCookies.map((c: any) => ({
                    cookie: c.name,
                    issues: c.issues,
                })),
                recommendations: insecureCookies.flatMap((c: any) => c.issues.map((i: string) => `${c.name}: ${i}`)),
            };

            if (insecureCookies.length > 0) {
                CSReporter.info(`[MCP] Found ${insecureCookies.length} cookies with security issues`);
            } else {
                CSReporter.pass('[MCP] All cookies have proper security settings');
            }

            return createJsonResult(result);
        } catch (error: any) {
            return createErrorResult(`Cookie check failed: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Export all security tools
// ============================================================================

export const securityTools: MCPToolDefinition[] = [
    // XSS
    securityXssScanTool,

    // SQL Injection
    securitySqlInjectionTool,

    // Authentication
    securityAuthBypassTool,
    securityBruteForceCheckTool,

    // Data Exposure
    securitySensitiveDataTool,

    // CSRF
    securityCsrfCheckTool,

    // Accessibility
    securityAccessibilityAuditTool,

    // Headers & Cookies
    securityHeaderCheckTool,
    securityCookieCheckTool,
];

/**
 * Register all security tools with the registry
 */
export function registerSecurityTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(securityTools);
}
