/**
 * CS Playwright Test Framework - Authentication Entry Point
 *
 * Only exports authentication modules
 *
 * @example
 * import { CSAuthenticationManager, CSTokenManager } from '@mdakhan.mak/cs-playwright-test-framework/auth';
 */

// Auth Core
export { CSTokenManager } from '../auth/CSTokenManager';
export { CSMicrosoftSSOHandler } from '../auth/CSMicrosoftSSOHandler';
export type { SSOLoginOptions } from '../auth/CSMicrosoftSSOHandler';
