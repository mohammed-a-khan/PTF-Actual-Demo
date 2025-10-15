/**
 * CS Playwright Test Framework - Reporter Entry Point
 *
 * Only exports reporter-specific modules
 *
 * @example
 * import { CSReporter, CSHTMLReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
 */

// Reporter Core
export { CSReporter } from '../reporter/CSReporter';
export { CSHTMLReporter } from '../reporter/CSHTMLReporter';
export { CSEnterpriseReporter } from '../reporter/CSEnterpriseReporter';
export { CSTestResultsManager } from '../reporter/CSTestResultsManager';

// Report Aggregators
export { CSReportAggregator } from '../reporter/CSReportAggregator';
export { CSAIReportAggregator } from '../reporter/CSAIReportAggregator';

// Report Generators
export { CSHtmlReportGenerator } from '../reporter/CSHtmlReportGeneration';
export { CSPdfReportGenerator } from '../reporter/CSPdfReportGenerator';
export { CSExcelReportGenerator } from '../reporter/CSExcelReportGenerator';

// Report Utilities
export { CSChart } from '../reporter/CSCustomChartsEmbedded';
export type { ChartConfig, ChartData, ChartDataset, ChartOptions } from '../reporter/CSCustomChartsEmbedded';


