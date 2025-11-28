/**
 * CS Playwright Test Framework - Reporter Entry Point
 *
 * PERFORMANCE OPTIMIZED: Only exports lightweight reporter modules.
 * Heavy report generators (Excel, PDF, Aggregators) are NOT exported here
 * to avoid 35+ second startup delays.
 *
 * For heavy report generators, import them directly when needed:
 *   const { CSExcelReportGenerator } = require('@mdakhan.mak/cs-playwright-test-framework/dist/reporter/CSExcelReportGenerator');
 *
 * @example
 * import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
 */

// Reporter Core (lightweight - only these are loaded)
export { CSReporter } from '../reporter/CSReporter';
export { CSHTMLReporter } from '../reporter/CSHTMLReporter';
export { CSEnterpriseReporter } from '../reporter/CSEnterpriseReporter';
export { CSTestResultsManager } from '../reporter/CSTestResultsManager';

// Report Utilities (lightweight)
export { CSChart } from '../reporter/CSCustomChartsEmbedded';
export type { ChartConfig, ChartData, ChartDataset, ChartOptions } from '../reporter/CSCustomChartsEmbedded';

// Lightweight aggregator (no heavy dependencies)
export { CSAIReportAggregator } from '../reporter/CSAIReportAggregator';

// HEAVY MODULES NOT EXPORTED TO AVOID STARTUP DELAY
// CSReportAggregator imports Excel/PDF generators (35+ seconds)
// CSPdfReportGenerator imports PDFKit (15+ seconds)
// CSExcelReportGenerator imports ExcelJS (22+ seconds)
// CSHtmlReportGenerator imports Excel/PDF (35+ seconds)
// These are available via direct import from dist/ folder when needed


