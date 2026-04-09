/**
 * CS Playwright CLI - Library Export
 *
 * Provides programmatic access to the CLI interface.
 * Use this to invoke CLI commands from code rather than the command line.
 *
 * @example
 * import { CSPlaywrightCLI } from '@mdakhan.mak/cs-playwright-test-framework/cli';
 *
 * const cli = new CSPlaywrightCLI();
 * const result = await cli.execute('list-features', ['test/**\/*.feature']);
 * console.log(result.outputFile); // Path to .cs-cli/features.json
 */

export { CSPlaywrightCLI } from '../cli/CSPlaywrightCLI';
export type { CLIResult } from '../cli/CSPlaywrightCLI';
