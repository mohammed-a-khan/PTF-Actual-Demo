/**
 * CS Playwright Test Framework - Utils Entry Point
 *
 * PERFORMANCE OPTIMIZED: Only exports lightweight utility modules.
 * Heavy utilities (Excel, PDF) are NOT exported here to avoid 17+ second startup delays.
 *
 * For heavy utilities, import them directly when needed:
 *   const { CSExcelUtility } = require('@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSExcelUtility');
 *   const { CSPdfUtility } = require('@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSPdfUtility');
 *
 * @example
 * import { CSValueResolver, CSEncryptionUtil } from '@mdakhan.mak/cs-playwright-test-framework/utilities';
 */

// Utils Core (lightweight - only these are loaded)
export { CSValueResolver } from '../utils/CSValueResolver';
export { CSEncryptionUtil } from '../utils/CSEncryptionUtil';
export { CSSecretMasker, getSecretMasker, maskSecret, maskSecretsInText, registerDecryptedSecret } from '../utils/CSSecretMasker';
export { CSStringUtility } from '../utils/CSStringUtility';
export { CSDateTimeUtility } from '../utils/CSDateTimeUtility';
export { CSJsonUtility } from '../utils/CSJsonUtility';
export { CSTextUtility } from '../utils/CSTextUtility';
export { CSDatabaseComparisonUtility } from '../utils/CSDatabaseComparisonUtility';
export { CSCsvUtility } from '../utils/CSCsvUtility';

// HEAVY MODULES NOT EXPORTED TO AVOID STARTUP DELAY
// CSComparisonUtility uses CSExcelUtility and CSPdfUtility internally
// CSExcelUtility imports ExcelJS (causes slow startup)
// CSPdfUtility imports PDFKit (17+ seconds)
// These are available via direct import from dist/utils/ folder when needed:
//   const { CSComparisonUtility } = require('@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSComparisonUtility');
//   const { CSExcelUtility } = require('@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSExcelUtility');
//   const { CSPdfUtility } = require('@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSPdfUtility');
