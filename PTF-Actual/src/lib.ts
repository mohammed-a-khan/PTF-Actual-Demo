/**
 * CS Playwright Test Framework - Library Entry Point
 *
 * Main export file for using the framework as a library/dependency
 * Import this in your test projects:
 *
 * @example
 * import { CSBasePage, CSReporter, CSBDDRunner } from 'cs-playwright-test-framework';
 */

// Core Framework
export { CSConfigurationManager } from './core/CSConfigurationManager';
export { CSBasePage } from './core/CSBasePage';
export { CSPageFactory, CSPage, CSGetElement, CSGetElements, CSElement, CSElements } from './core/CSPageFactory';

// BDD & Testing
export { CSBDDRunner } from './bdd/CSBDDRunner';
export { CSBDDEngine } from './bdd/CSBDDEngine';
export { CSStepRegistry, CSBDDStepDef } from './bdd/CSStepRegistry';
export { simpleStepRegistry } from './bdd/CSSimpleStepRegistry';
export { CSScenarioContext } from './bdd/CSScenarioContext';
export { CSFeatureContext } from './bdd/CSFeatureContext';
export { CSBDDContext } from './bdd/CSBDDContext';
export { CSDataSource } from './bdd/CSDataSourceDecorator';
export { CSStepValidator } from './bdd/CSStepValidator';
export * from './bdd/CSBDDDecorators';

// Cucumber-Compatible Decorators (for IDE plugin support: autocomplete, Ctrl+Click navigation)
// These decorators work with both CS Framework execution AND Cucumber IDE plugins
// Users can use either @CSBDDStepDef or @Given/@When/@Then/@And/@But/@Step
export { Given, When, Then, And, But, Step, defineStep } from './bdd/CSCucumberDecorators';

// Elements & Browser
export { CSWebElement } from './element/CSWebElement';
export { CSElementResolver } from './element/CSElementResolver';
export { CSBrowserPool } from './browser/CSBrowserPool';
export { CSBrowserManager } from './browser/CSBrowserManager';

// API Testing
export { CSAPIRunner } from './api/CSAPIRunner';
export { CSAPIValidator } from './api/CSAPIValidator';
export { CSAPIExecutor } from './api/CSAPIExecutor';
export { CSAPIClient } from './api/CSAPIClient';
export * from './api/types/CSApiTypes';

// API Client & Utilities
export { CSHttpClient } from './api/client/CSHttpClient';
export { CSRequestBuilder } from './api/client/CSRequestBuilder';
export { CSResponseParser } from './api/client/CSResponseParser';
export { CSConnectionPool } from './api/client/CSConnectionPool';
export { CSRetryHandler } from './api/client/CSRetryHandler';
export { CSProxyManager } from './api/client/CSProxyManager';
export { CSAuthenticationHandler } from './api/client/CSAuthenticationHandler';

// API Context Management
export { CSApiContext } from './api/context/CSApiContext';
export { CSApiContextManager } from './api/context/CSApiContextManager';
export { CSApiChainContext, CSApiChainManager, chainManager } from './api/context/CSApiChainContext';

// API Authentication
export { CSOAuth2Handler } from './api/auth/CSOAuth2Handler';
export { CSAWSSignatureHandler } from './api/auth/CSAWSSignatureHandler';
export { CSCertificateManager } from './api/auth/CSCertificateManager';

// API Templates & Placeholders
export { CSPlaceholderResolver } from './api/templates/CSPlaceholderResolver';
export { CSRequestTemplateEngine } from './api/templates/CSRequestTemplateEngine';
export { CSTemplateCache } from './api/templates/CSTemplateCache';

// API Validators
export { CSStatusCodeValidator } from './api/validators/CSStatusCodeValidator';
export { CSHeaderValidator } from './api/validators/CSHeaderValidator';
export { CSBodyValidator } from './api/validators/CSBodyValidator';
export { CSSchemaValidator } from './api/validators/CSSchemaValidator';
export { CSRegexValidator } from './api/validators/CSRegexValidator';
export { CSCustomValidator } from './api/validators/CSCustomValidator';
export { CSResponseTimeValidator } from './api/validators/CSResponseTimeValidator';
export { CSJSONPathValidator } from './api/validators/CSJSONPathValidator';
export { CSXMLValidator } from './api/validators/CSXMLValidator';

// SOAP Testing
export { CSSoapClient } from './api/soap/CSSoapClient';
export { CSSoapSecurityHandler } from './api/soap/CSSoapSecurityHandler';
export { CSXmlValidator } from './api/soap/CSXmlValidator';
export { CSXmlParser } from './api/soap/CSXmlParser';
export { CSSoapEnvelopeBuilder } from './api/soap/CSSoapEnvelopeBuilder';

// API Comparison & Matching
export { CSRecordMatcher } from './api/comparison/CSRecordMatcher';
export { CSFieldMapper } from './api/comparison/CSFieldMapper';

// Database Testing
export { CSDatabaseManager } from './database/CSDatabaseManager';
export { CSDatabase } from './database/client/CSDatabase';
export { CSQueryResultCache } from './database/context/CSQueryResultCache';
export { CSDatabaseRunner } from './database/CSDatabaseRunner';

// Data Management
export { CSDataProvider } from './data/CSDataProvider';
export { CSDataGenerator } from './data/CSDataGenerator';

// Reporting
export { CSReporter } from './reporter/CSReporter';
export { CSHTMLReporter } from './reporter/CSHTMLReporter';
export { CSEnterpriseReporter } from './reporter/CSEnterpriseReporter';
export { CSTestResultsManager } from './reporter/CSTestResultsManager';

// Assertions
export { CSAssert } from './assertions/CSAssert';
export { CSExpect } from './assertions/CSExpect';

// Utilities
export { CSValueResolver } from './utils/CSValueResolver';
export { CSEncryptionUtil } from './utils/CSEncryptionUtil';

// Azure DevOps Integration
export { CSADOClient } from './ado/CSADOClient';
export { CSADOIntegration } from './ado/CSADOIntegration';
export { CSADOConfiguration } from './ado/CSADOConfiguration';
export { CSADOTagExtractor } from './ado/CSADOTagExtractor';

// AI & Self-Healing
export { CSAIEngine } from './ai/CSAIEngine';
export { CSSelfHealingEngine } from './self-healing/CSSelfHealingEngine';

// Authentication & Security
export { CSTokenManager } from './auth/CSTokenManager';

// Performance & Monitoring
export { CSPerformanceMonitor } from './monitoring/CSPerformanceMonitor';

// Diagnostics & Debugging (Playwright 1.56+)
export { CSPageDiagnostics } from './diagnostics/CSPageDiagnostics';
export type { PageDiagnosticData, DiagnosticConsoleLog, DiagnosticError, DiagnosticRequest, DiagnosticOptions } from './diagnostics/CSPageDiagnostics';

// Media & Evidence
export { CSVideoRecorder } from './media/CSVideoRecorder';
export { CSScreenshotManager } from './media/CSScreenshotManager';
export { CSEvidenceCollector } from './evidence/CSEvidenceCollector';

// Visual Testing
export { CSVisualTesting } from './visual/CSVisualTesting';

// Network
export { CSNetworkInterceptor } from './network/CSNetworkInterceptor';

// Mobile Testing
export { CSMobileTesting } from './mobile/CSMobileTesting';

// Navigation
export { CSCrossDomainNavigationHandler } from './navigation/CSCrossDomainNavigationHandler';

// Parallel Execution
export { CSParallelMediaHandler } from './parallel/CSParallelMediaHandler';
export { CSTerminalLogCapture } from './parallel/CSTerminalLogCapture';

// Pipeline Orchestration
export { CSPipelineOrchestrator } from './pipeline/CSPipelineOrchestrator';

// Dashboard
export { CSLiveDashboard } from './dashboard/CSLiveDashboard';

// Step Definitions (for extending)
export * from './steps/api';
export * from './steps/common/CSCommonSteps';
export * from './steps/database';
export * from './steps/soap';
