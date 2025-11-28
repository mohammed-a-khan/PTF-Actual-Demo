/**
 * CS Playwright Test Framework - Database Utilities Entry Point (Lightweight)
 *
 * PERFORMANCE OPTIMIZED: Only exports CSDBUtils without loading all adapters
 * Use this entry point when you only need CSDBUtils for database queries
 *
 * @example
 * import { CSDBUtils } from '@mdakhan.mak/cs-playwright-test-framework/database-utils';
 */

// Only export the lightweight utility class
// This avoids loading all database adapters at import time
export { CSDBUtils } from '../database/utils/CSDBUtils';
