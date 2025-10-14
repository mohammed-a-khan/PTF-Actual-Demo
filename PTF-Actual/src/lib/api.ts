/**
 * CS Playwright Test Framework - API Testing Entry Point
 *
 * Lightweight entry point for API testing
 *
 * @example
 * import { CSAPIClient, CSAPIExecutor } from '@mdakhan.mak/cs-playwright-test-framework/api';
 */

// Core (minimal)
export { CSConfigurationManager } from '../core/CSConfigurationManager';
export { CSReporter } from '../reporter/CSReporter';

// API Testing Core
export { CSAPIRunner } from '../api/CSAPIRunner';
export { CSAPIValidator } from '../api/CSAPIValidator';
export { CSAPIExecutor } from '../api/CSAPIExecutor';
export { CSAPIClient } from '../api/CSAPIClient';
export * from '../api/types/CSApiTypes';

// API Client & Utilities
export { CSHttpClient } from '../api/client/CSHttpClient';
export { CSRequestBuilder } from '../api/client/CSRequestBuilder';
export { CSResponseParser } from '../api/client/CSResponseParser';
export { CSConnectionPool } from '../api/client/CSConnectionPool';
export { CSRetryHandler } from '../api/client/CSRetryHandler';
export { CSProxyManager } from '../api/client/CSProxyManager';
export { CSAuthenticationHandler } from '../api/client/CSAuthenticationHandler';

// API Context Management
export { CSApiContext } from '../api/context/CSApiContext';
export { CSApiContextManager } from '../api/context/CSApiContextManager';
export { CSApiChainContext, CSApiChainManager, chainManager } from '../api/context/CSApiChainContext';

// API Authentication
export { CSOAuth2Handler } from '../api/auth/CSOAuth2Handler';
export { CSAWSSignatureHandler } from '../api/auth/CSAWSSignatureHandler';
export { CSCertificateManager } from '../api/auth/CSCertificateManager';

// API Templates & Placeholders
export { CSPlaceholderResolver } from '../api/templates/CSPlaceholderResolver';
export { CSRequestTemplateEngine } from '../api/templates/CSRequestTemplateEngine';
export { CSTemplateCache } from '../api/templates/CSTemplateCache';

// API Validators
export { CSStatusCodeValidator } from '../api/validators/CSStatusCodeValidator';
export { CSHeaderValidator } from '../api/validators/CSHeaderValidator';
export { CSBodyValidator } from '../api/validators/CSBodyValidator';
export { CSSchemaValidator } from '../api/validators/CSSchemaValidator';
export { CSRegexValidator } from '../api/validators/CSRegexValidator';
export { CSCustomValidator } from '../api/validators/CSCustomValidator';
export { CSResponseTimeValidator } from '../api/validators/CSResponseTimeValidator';
export { CSJSONPathValidator } from '../api/validators/CSJSONPathValidator';
export { CSXMLValidator } from '../api/validators/CSXMLValidator';

// SOAP Testing
export { CSSoapClient } from '../api/soap/CSSoapClient';
export { CSSoapSecurityHandler } from '../api/soap/CSSoapSecurityHandler';
export { CSXmlValidator } from '../api/soap/CSXmlValidator';
export { CSXmlParser } from '../api/soap/CSXmlParser';
export { CSSoapEnvelopeBuilder } from '../api/soap/CSSoapEnvelopeBuilder';

// API Comparison & Matching
export { CSRecordMatcher } from '../api/comparison/CSRecordMatcher';
export { CSFieldMapper } from '../api/comparison/CSFieldMapper';

// Assertions
export { CSAssert } from '../assertions/CSAssert';
export { CSExpect } from '../assertions/CSExpect';

// Utilities
export { CSValueResolver } from '../utils/CSValueResolver';
export { CSEncryptionUtil } from '../utils/CSEncryptionUtil';

// Data Management
export { CSDataProvider } from '../data/CSDataProvider';
export { CSDataGenerator } from '../data/CSDataGenerator';
