import * as fs from 'fs';
import * as path from 'path';

/**
 * CS Playwright CLI - Token-efficient interface for AI agents
 *
 * Provides framework capabilities as shell commands that write results to disk.
 * This is more token-efficient than MCP because agents read only the data they need
 * from the output directory rather than receiving full tool responses inline.
 *
 * Each command writes its output to `.cs-cli/` so agents can selectively read results.
 */

export interface CLIResult {
    success: boolean;
    outputFile: string;
    message: string;
}

export class CSPlaywrightCLI {
    private outputDir: string;
    private browserManager: any = null;
    private configManager: any = null;
    private reporter: any = null;

    constructor(outputDir?: string) {
        this.outputDir = outputDir || path.join(process.cwd(), '.cs-cli');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Lazily load CSBrowserManager to avoid import errors when browser is not available
     */
    private async getBrowserManager(): Promise<any> {
        if (!this.browserManager) {
            try {
                const { CSBrowserManager } = require('../browser/CSBrowserManager');
                this.browserManager = CSBrowserManager.getInstance();
            } catch (err: any) {
                throw new Error(`Browser manager not available: ${err.message}`);
            }
        }
        return this.browserManager;
    }

    /**
     * Lazily load CSConfigurationManager
     */
    private getConfigManager(): any {
        if (!this.configManager) {
            try {
                const { CSConfigurationManager } = require('../core/CSConfigurationManager');
                this.configManager = CSConfigurationManager.getInstance();
            } catch (err: any) {
                throw new Error(`Configuration manager not available: ${err.message}`);
            }
        }
        return this.configManager;
    }

    /**
     * Lazily load CSReporter
     */
    private getReporter(): any {
        if (!this.reporter) {
            try {
                const { CSReporter } = require('../reporter/CSReporter');
                this.reporter = CSReporter;
            } catch (err: any) {
                // Reporter is optional; fall back to console
                this.reporter = {
                    info: (msg: string) => console.log(`[INFO] ${msg}`),
                    warn: (msg: string) => console.warn(`[WARN] ${msg}`),
                    error: (msg: string) => console.error(`[ERROR] ${msg}`),
                    debug: (msg: string) => console.log(`[DEBUG] ${msg}`)
                };
            }
        }
        return this.reporter;
    }

    /**
     * Execute a CLI command and write results to disk
     */
    async execute(command: string, args: string[] = []): Promise<CLIResult> {
        const reporter = this.getReporter();
        reporter.info(`CLI executing: ${command} ${args.join(' ')}`);

        try {
            switch (command) {
                // Browser commands
                case 'snapshot':
                    return await this.handleSnapshot(args);
                case 'screenshot':
                    return await this.handleScreenshot(args);
                case 'page-info':
                    return await this.handlePageInfo(args);
                case 'console-logs':
                    return await this.handleConsoleLogs(args);
                case 'page-errors':
                    return await this.handlePageErrors(args);
                case 'network-log':
                    return await this.handleNetworkLog(args);

                // Test commands
                case 'list-features':
                    return await this.handleListFeatures(args);
                case 'list-steps':
                    return await this.handleListSteps(args);
                case 'validate-steps':
                    return await this.handleValidateSteps(args);
                case 'run-test':
                    return await this.handleRunTest(args);

                // Codegen commands
                case 'suggest-locator':
                    return await this.handleSuggestLocator(args);
                case 'generate-page':
                    return await this.handleGeneratePage(args);

                // Data commands
                case 'query':
                    return await this.handleQuery(args);

                default:
                    return { success: false, outputFile: '', message: `Unknown command: ${command}` };
            }
        } catch (err: any) {
            const errorResult = {
                error: err.message,
                stack: err.stack,
                command,
                args,
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('error.json', errorResult);
            return { success: false, outputFile, message: `Command failed: ${err.message}` };
        }
    }

    /**
     * Write output data to a file in the output directory
     */
    private writeOutput(filename: string, data: any): string {
        const filePath = path.join(this.outputDir, filename);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        fs.writeFileSync(filePath, content, 'utf-8');
        return filePath;
    }

    /**
     * Write binary output to a file in the output directory
     */
    private writeBinaryOutput(filename: string, data: Buffer): string {
        const filePath = path.join(this.outputDir, filename);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, data);
        return filePath;
    }

    // ========================================================================
    // Browser Commands
    // ========================================================================

    private async handleSnapshot(_args: string[]): Promise<CLIResult> {
        const bm = await this.getBrowserManager();
        let page: any;
        try {
            page = bm.getPage();
        } catch {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        if (!page) {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        try {
            const snapshot = await page.accessibility.snapshot();
            const yamlContent = this.accessibilityTreeToYaml(snapshot);
            const outputFile = this.writeOutput('snapshot.yaml', yamlContent);
            return { success: true, outputFile, message: 'Accessibility snapshot captured' };
        } catch (err: any) {
            // Fallback: try to get page content as text
            try {
                const title = await page.title();
                const url = page.url();
                const content = `# Accessibility Snapshot\n# URL: ${url}\n# Title: ${title}\n# Note: Full accessibility tree not available\n`;
                const outputFile = this.writeOutput('snapshot.yaml', content);
                return { success: true, outputFile, message: 'Basic page snapshot captured (full accessibility tree not available)' };
            } catch (fallbackErr: any) {
                return { success: false, outputFile: '', message: `Snapshot failed: ${err.message}` };
            }
        }
    }

    private async handleScreenshot(_args: string[]): Promise<CLIResult> {
        const bm = await this.getBrowserManager();
        let page: any;
        try {
            page = bm.getPage();
        } catch {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        if (!page) {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        try {
            const buffer = await page.screenshot({ fullPage: false });
            const outputFile = this.writeBinaryOutput('screenshot.png', buffer);
            return { success: true, outputFile, message: 'Screenshot captured' };
        } catch (err: any) {
            return { success: false, outputFile: '', message: `Screenshot failed: ${err.message}` };
        }
    }

    private async handlePageInfo(_args: string[]): Promise<CLIResult> {
        const bm = await this.getBrowserManager();
        let page: any;
        try {
            page = bm.getPage();
        } catch {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        if (!page) {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        try {
            const title = await page.title();
            const url = page.url();
            let viewport = null;
            try {
                viewport = page.viewportSize();
            } catch {
                // viewport size may not be available
            }

            const info = {
                url,
                title,
                viewport: viewport || { width: 'unknown', height: 'unknown' },
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('page-info.json', info);
            return { success: true, outputFile, message: 'Page info captured' };
        } catch (err: any) {
            return { success: false, outputFile: '', message: `Page info failed: ${err.message}` };
        }
    }

    private async handleConsoleLogs(_args: string[]): Promise<CLIResult> {
        const bm = await this.getBrowserManager();
        let page: any;
        try {
            page = bm.getPage();
        } catch {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        if (!page) {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        try {
            // Collect console messages by evaluating current page state
            // Note: live console listener messages are only available if captured during session
            const logs = await page.evaluate(() => {
                // Try to retrieve any logged messages from performance entries
                const entries = performance.getEntriesByType('resource').slice(-50).map((e: any) => ({
                    name: e.name,
                    type: e.initiatorType,
                    duration: e.duration
                }));
                return entries;
            });

            const result = {
                messages: logs || [],
                note: 'Console messages are captured from the current page context. For full console monitoring, use browser_console_messages MCP tool.',
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('console.json', result);
            return { success: true, outputFile, message: 'Console logs captured' };
        } catch (err: any) {
            const result = {
                messages: [],
                error: err.message,
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('console.json', result);
            return { success: true, outputFile, message: 'Console logs captured (with limitations)' };
        }
    }

    private async handlePageErrors(_args: string[]): Promise<CLIResult> {
        const bm = await this.getBrowserManager();
        let page: any;
        try {
            page = bm.getPage();
        } catch {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        if (!page) {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        try {
            // Check for JavaScript errors on the page
            const errors = await page.evaluate(() => {
                const errorList: any[] = [];
                // Check for any global error indicators
                if ((window as any).__cs_page_errors) {
                    return (window as any).__cs_page_errors;
                }
                return errorList;
            });

            const result = {
                errors: errors || [],
                note: 'Page errors captured from current context. For continuous error monitoring, use browser tools with error listeners.',
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('errors.json', result);
            return { success: true, outputFile, message: 'Page errors captured' };
        } catch (err: any) {
            const result = {
                errors: [],
                error: err.message,
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('errors.json', result);
            return { success: true, outputFile, message: 'Page errors captured (with limitations)' };
        }
    }

    private async handleNetworkLog(_args: string[]): Promise<CLIResult> {
        const bm = await this.getBrowserManager();
        let page: any;
        try {
            page = bm.getPage();
        } catch {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        if (!page) {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        try {
            // Get network activity from performance API
            const networkEntries = await page.evaluate(() => {
                const entries = performance.getEntriesByType('resource').map((e: any) => ({
                    url: e.name,
                    type: e.initiatorType,
                    startTime: e.startTime,
                    duration: e.duration,
                    transferSize: e.transferSize || 0,
                    encodedBodySize: e.encodedBodySize || 0,
                    decodedBodySize: e.decodedBodySize || 0
                }));
                return entries;
            });

            const result = {
                requests: networkEntries || [],
                count: (networkEntries || []).length,
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('network.json', result);
            return { success: true, outputFile, message: `Network log captured (${result.count} requests)` };
        } catch (err: any) {
            const result = {
                requests: [],
                count: 0,
                error: err.message,
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('network.json', result);
            return { success: true, outputFile, message: 'Network log captured (with limitations)' };
        }
    }

    // ========================================================================
    // Test Commands
    // ========================================================================

    private async handleListFeatures(args: string[]): Promise<CLIResult> {
        const globPattern = args[0] || '**/*.feature';
        const searchDirs = ['test', 'tests', 'features', 'src'];

        try {
            let glob: any;
            try {
                glob = require('glob');
            } catch {
                // Fallback: manual directory traversal
                const features = this.findFilesRecursive(process.cwd(), '.feature');
                const result = {
                    pattern: globPattern,
                    features: features.map(f => ({
                        path: f,
                        relativePath: path.relative(process.cwd(), f),
                        name: path.basename(f, '.feature')
                    })),
                    count: features.length,
                    timestamp: new Date().toISOString()
                };
                const outputFile = this.writeOutput('features.json', result);
                return { success: true, outputFile, message: `Found ${result.count} feature files` };
            }

            const allFeatures: string[] = [];
            for (const dir of searchDirs) {
                const searchPath = path.join(process.cwd(), dir);
                if (fs.existsSync(searchPath)) {
                    const matches = glob.sync(globPattern, { cwd: searchPath, absolute: true });
                    allFeatures.push(...matches);
                }
            }

            // Also search from cwd with the glob pattern directly
            const cwdMatches = glob.sync(globPattern, { cwd: process.cwd(), absolute: true });
            for (const match of cwdMatches) {
                if (!allFeatures.includes(match)) {
                    allFeatures.push(match);
                }
            }

            const result = {
                pattern: globPattern,
                features: allFeatures.map(f => ({
                    path: f,
                    relativePath: path.relative(process.cwd(), f),
                    name: path.basename(f, '.feature')
                })),
                count: allFeatures.length,
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('features.json', result);
            return { success: true, outputFile, message: `Found ${result.count} feature files` };
        } catch (err: any) {
            return { success: false, outputFile: '', message: `List features failed: ${err.message}` };
        }
    }

    private async handleListSteps(_args: string[]): Promise<CLIResult> {
        try {
            // Search for step definition files
            const stepFiles = this.findFilesRecursive(process.cwd(), '.steps.ts');
            const stepDefinitions: any[] = [];

            for (const file of stepFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const stepPatterns = this.extractStepPatterns(content);
                    stepDefinitions.push({
                        file: path.relative(process.cwd(), file),
                        steps: stepPatterns
                    });
                } catch {
                    // Skip files that can't be read
                }
            }

            const result = {
                stepFiles: stepDefinitions,
                totalFiles: stepFiles.length,
                totalSteps: stepDefinitions.reduce((sum, f) => sum + f.steps.length, 0),
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('steps.json', result);
            return { success: true, outputFile, message: `Found ${result.totalSteps} step definitions in ${result.totalFiles} files` };
        } catch (err: any) {
            return { success: false, outputFile: '', message: `List steps failed: ${err.message}` };
        }
    }

    private async handleValidateSteps(args: string[]): Promise<CLIResult> {
        const featureFile = args[0];
        if (!featureFile) {
            return { success: false, outputFile: '', message: 'Usage: validate-steps <feature-file>' };
        }

        const featurePath = path.isAbsolute(featureFile) ? featureFile : path.join(process.cwd(), featureFile);
        if (!fs.existsSync(featurePath)) {
            return { success: false, outputFile: '', message: `Feature file not found: ${featurePath}` };
        }

        try {
            const featureContent = fs.readFileSync(featurePath, 'utf-8');
            const featureSteps = this.extractFeatureSteps(featureContent);

            // Get all registered step patterns
            const stepFiles = this.findFilesRecursive(process.cwd(), '.steps.ts');
            const allPatterns: string[] = [];
            for (const file of stepFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const patterns = this.extractStepPatterns(content);
                    allPatterns.push(...patterns.map((p: any) => p.pattern));
                } catch {
                    // Skip unreadable files
                }
            }

            // Also check built-in steps from the framework
            const builtInStepFiles = this.findFilesRecursive(
                path.join(__dirname, '..', 'steps'),
                '.ts'
            );
            for (const file of builtInStepFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const patterns = this.extractStepPatterns(content);
                    allPatterns.push(...patterns.map((p: any) => p.pattern));
                } catch {
                    // Skip unreadable files
                }
            }

            const validation = featureSteps.map(step => ({
                step: step.text,
                keyword: step.keyword,
                line: step.line,
                matched: allPatterns.some(p => this.stepMatchesPattern(step.text, p)),
                matchedPattern: allPatterns.find(p => this.stepMatchesPattern(step.text, p)) || null
            }));

            const result = {
                featureFile: path.relative(process.cwd(), featurePath),
                totalSteps: validation.length,
                matched: validation.filter(v => v.matched).length,
                unmatched: validation.filter(v => !v.matched).length,
                steps: validation,
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('validation.json', result);
            return {
                success: true,
                outputFile,
                message: `Validated ${result.totalSteps} steps: ${result.matched} matched, ${result.unmatched} unmatched`
            };
        } catch (err: any) {
            return { success: false, outputFile: '', message: `Validate steps failed: ${err.message}` };
        }
    }

    private async handleRunTest(args: string[]): Promise<CLIResult> {
        const featureFile = args[0];
        if (!featureFile) {
            return { success: false, outputFile: '', message: 'Usage: run-test <feature-file> [--tag <tag>]' };
        }

        // Parse optional --tag argument
        let tag: string | undefined;
        const tagIndex = args.indexOf('--tag');
        if (tagIndex !== -1 && args[tagIndex + 1]) {
            tag = args[tagIndex + 1];
        }

        try {
            const { execSync } = require('child_process');
            const featurePath = path.isAbsolute(featureFile)
                ? featureFile
                : path.join(process.cwd(), featureFile);

            // Build the test command
            let cmd = `npx playwright test "${featurePath}"`;
            if (tag) {
                cmd += ` --grep "${tag}"`;
            }
            cmd += ' --reporter=json';

            let testOutput: string;
            let exitCode = 0;
            try {
                testOutput = execSync(cmd, {
                    cwd: process.cwd(),
                    encoding: 'utf-8',
                    timeout: 300000, // 5 minute timeout
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (execErr: any) {
                testOutput = execErr.stdout || execErr.stderr || execErr.message;
                exitCode = execErr.status || 1;
            }

            let parsedResults: any;
            try {
                parsedResults = JSON.parse(testOutput);
            } catch {
                parsedResults = {
                    raw: testOutput,
                    exitCode
                };
            }

            const result = {
                feature: path.relative(process.cwd(), featurePath),
                tag: tag || null,
                exitCode,
                passed: exitCode === 0,
                results: parsedResults,
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('results.json', result);
            return {
                success: true,
                outputFile,
                message: exitCode === 0 ? 'Test passed' : 'Test failed (see results.json for details)'
            };
        } catch (err: any) {
            return { success: false, outputFile: '', message: `Run test failed: ${err.message}` };
        }
    }

    // ========================================================================
    // Codegen Commands
    // ========================================================================

    private async handleSuggestLocator(args: string[]): Promise<CLIResult> {
        const selector = args[0];
        if (!selector) {
            return { success: false, outputFile: '', message: 'Usage: suggest-locator <current-selector>' };
        }

        const bm = await this.getBrowserManager();
        let page: any;
        try {
            page = bm.getPage();
        } catch {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        if (!page) {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        try {
            // Try to find the element with the current selector and suggest alternatives
            const suggestions: any[] = [];

            // Try to locate the element
            const element = page.locator(selector);
            const count = await element.count();

            if (count === 0) {
                const result = {
                    originalSelector: selector,
                    found: false,
                    suggestions: [],
                    message: 'Element not found with the given selector. Try using browser snapshot to find the element.',
                    timestamp: new Date().toISOString()
                };
                const outputFile = this.writeOutput('locator.json', result);
                return { success: true, outputFile, message: 'Element not found — see locator.json for details' };
            }

            // Get element attributes to suggest better locators
            const elementInfo = await element.first().evaluate((el: Element) => {
                return {
                    tagName: el.tagName.toLowerCase(),
                    id: el.id || null,
                    name: el.getAttribute('name') || null,
                    type: el.getAttribute('type') || null,
                    role: el.getAttribute('role') || el.tagName.toLowerCase(),
                    ariaLabel: el.getAttribute('aria-label') || null,
                    testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null,
                    placeholder: el.getAttribute('placeholder') || null,
                    text: el.textContent?.trim().substring(0, 100) || null,
                    className: el.className || null
                };
            });

            // Build locator suggestions ordered by stability
            if (elementInfo.testId) {
                suggestions.push({
                    strategy: 'getByTestId',
                    locator: `getByTestId('${elementInfo.testId}')`,
                    confidence: 'high',
                    reason: 'Test IDs are the most stable locator strategy'
                });
            }

            if (elementInfo.role && elementInfo.ariaLabel) {
                suggestions.push({
                    strategy: 'getByRole',
                    locator: `getByRole('${elementInfo.role}', { name: '${elementInfo.ariaLabel}' })`,
                    confidence: 'high',
                    reason: 'Role + name is semantic and accessible'
                });
            }

            if (elementInfo.ariaLabel) {
                suggestions.push({
                    strategy: 'getByLabel',
                    locator: `getByLabel('${elementInfo.ariaLabel}')`,
                    confidence: 'medium-high',
                    reason: 'Accessible label is user-facing and stable'
                });
            }

            if (elementInfo.placeholder) {
                suggestions.push({
                    strategy: 'getByPlaceholder',
                    locator: `getByPlaceholder('${elementInfo.placeholder}')`,
                    confidence: 'medium',
                    reason: 'Placeholder text is user-visible'
                });
            }

            if (elementInfo.text && elementInfo.text.length < 50) {
                suggestions.push({
                    strategy: 'getByText',
                    locator: `getByText('${elementInfo.text}')`,
                    confidence: 'medium',
                    reason: 'Text content may change but is user-facing'
                });
            }

            if (elementInfo.id) {
                suggestions.push({
                    strategy: 'css',
                    locator: `#${elementInfo.id}`,
                    confidence: 'medium',
                    reason: 'ID selectors are unique but may be auto-generated'
                });
            }

            if (elementInfo.name) {
                suggestions.push({
                    strategy: 'css',
                    locator: `[name="${elementInfo.name}"]`,
                    confidence: 'medium',
                    reason: 'Name attribute is functional and often stable'
                });
            }

            const result = {
                originalSelector: selector,
                found: true,
                elementCount: count,
                elementInfo,
                suggestions,
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('locator.json', result);
            return { success: true, outputFile, message: `Found ${suggestions.length} locator suggestions` };
        } catch (err: any) {
            return { success: false, outputFile: '', message: `Suggest locator failed: ${err.message}` };
        }
    }

    private async handleGeneratePage(args: string[]): Promise<CLIResult> {
        const url = args[0];

        const bm = await this.getBrowserManager();
        let page: any;
        try {
            page = bm.getPage();
        } catch {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        if (!page) {
            return { success: false, outputFile: '', message: 'No active browser page. Launch a browser first.' };
        }

        try {
            // Navigate to URL if provided
            if (url) {
                await page.goto(url, { waitUntil: 'domcontentloaded' });
            }

            const currentUrl = page.url();
            const title = await page.title();

            // Discover all interactive elements
            const elements = await page.evaluate(() => {
                const interactiveSelectors = 'input, button, select, textarea, a[href], [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"]';
                const found = document.querySelectorAll(interactiveSelectors);
                return Array.from(found).map((el: Element, index: number) => {
                    const tag = el.tagName.toLowerCase();
                    const type = el.getAttribute('type') || '';
                    const id = el.id || '';
                    const name = el.getAttribute('name') || '';
                    const role = el.getAttribute('role') || '';
                    const ariaLabel = el.getAttribute('aria-label') || '';
                    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '';
                    const placeholder = el.getAttribute('placeholder') || '';
                    const text = el.textContent?.trim().substring(0, 50) || '';

                    // Generate a sensible variable name
                    let varName = testId || id || name || ariaLabel || '';
                    varName = varName.replace(/[^a-zA-Z0-9]/g, '');
                    if (!varName) {
                        varName = `${tag}${type ? type.charAt(0).toUpperCase() + type.slice(1) : ''}${index}`;
                    }

                    // Pick best locator
                    let locator = '';
                    let locatorType = '';
                    if (testId) {
                        locator = `[data-testid="${testId}"]`;
                        locatorType = 'css';
                    } else if (id) {
                        locator = `#${id}`;
                        locatorType = 'css';
                    } else if (name) {
                        locator = `[name="${name}"]`;
                        locatorType = 'css';
                    } else if (ariaLabel) {
                        locator = `//*[@aria-label="${ariaLabel}"]`;
                        locatorType = 'xpath';
                    } else {
                        locator = `${tag}:nth-of-type(${index + 1})`;
                        locatorType = 'css';
                    }

                    return {
                        varName,
                        tagName: tag,
                        type,
                        id,
                        name,
                        role,
                        ariaLabel,
                        testId,
                        placeholder,
                        text,
                        locator,
                        locatorType
                    };
                });
            });

            // Generate page class name from URL
            const urlPath = new URL(currentUrl).pathname;
            const pageName = this.urlToClassName(urlPath);

            // Generate TypeScript page object
            const pageCode = this.generatePageObjectCode(pageName, currentUrl, elements);
            const outputFile = this.writeOutput('generated-page.ts', pageCode);

            return { success: true, outputFile, message: `Generated page object: ${pageName} with ${elements.length} elements` };
        } catch (err: any) {
            return { success: false, outputFile: '', message: `Generate page failed: ${err.message}` };
        }
    }

    // ========================================================================
    // Data Commands
    // ========================================================================

    private async handleQuery(args: string[]): Promise<CLIResult> {
        const alias = args[0];
        const sql = args.slice(1).join(' ');

        if (!alias || !sql) {
            return { success: false, outputFile: '', message: 'Usage: query <alias> <sql>' };
        }

        try {
            let CSDBUtils: any;
            try {
                const dbUtilsModule = require('../database-utils/CSDBUtils');
                CSDBUtils = dbUtilsModule.CSDBUtils;
            } catch {
                return { success: false, outputFile: '', message: 'Database utilities not available. Ensure CSDBUtils is configured.' };
            }

            const queryResult = await CSDBUtils.executeQuery(alias, sql);
            const result = {
                alias,
                sql,
                rows: queryResult.rows || queryResult,
                rowCount: Array.isArray(queryResult.rows) ? queryResult.rows.length : (Array.isArray(queryResult) ? queryResult.length : 0),
                timestamp: new Date().toISOString()
            };
            const outputFile = this.writeOutput('query-results.json', result);
            return { success: true, outputFile, message: `Query returned ${result.rowCount} rows` };
        } catch (err: any) {
            return { success: false, outputFile: '', message: `Query failed: ${err.message}` };
        }
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Recursively find files with a given extension
     */
    private findFilesRecursive(dir: string, extension: string, maxDepth: number = 10): string[] {
        const results: string[] = [];
        if (maxDepth <= 0) return results;

        try {
            if (!fs.existsSync(dir)) return results;
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                // Skip node_modules, dist, .git, etc.
                if (entry.isDirectory()) {
                    if (['node_modules', 'dist', '.git', '.cs-cli', 'coverage'].includes(entry.name)) {
                        continue;
                    }
                    results.push(...this.findFilesRecursive(fullPath, extension, maxDepth - 1));
                } else if (entry.name.endsWith(extension)) {
                    results.push(fullPath);
                }
            }
        } catch {
            // Skip directories we can't read
        }

        return results;
    }

    /**
     * Extract step patterns from a TypeScript step definition file
     */
    private extractStepPatterns(content: string): Array<{ keyword: string; pattern: string }> {
        const patterns: Array<{ keyword: string; pattern: string }> = [];
        // Match @Given, @When, @Then decorators or Given(), When(), Then() calls
        const decoratorRegex = /@(Given|When|Then|And|But)\s*\(\s*['"`](.+?)['"`]/g;
        const functionRegex = /\b(Given|When|Then|And|But)\s*\(\s*['"`](.+?)['"`]/g;

        let match: RegExpExecArray | null;
        while ((match = decoratorRegex.exec(content)) !== null) {
            patterns.push({ keyword: match[1], pattern: match[2] });
        }
        while ((match = functionRegex.exec(content)) !== null) {
            // Avoid duplicates from decorator matches
            const existing = patterns.find(p => p.pattern === match![2]);
            if (!existing) {
                patterns.push({ keyword: match[1], pattern: match[2] });
            }
        }

        return patterns;
    }

    /**
     * Extract steps from a Gherkin feature file
     */
    private extractFeatureSteps(content: string): Array<{ keyword: string; text: string; line: number }> {
        const steps: Array<{ keyword: string; text: string; line: number }> = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const stepMatch = line.match(/^(Given|When|Then|And|But)\s+(.+)$/);
            if (stepMatch) {
                steps.push({
                    keyword: stepMatch[1],
                    text: stepMatch[2],
                    line: i + 1
                });
            }
        }

        return steps;
    }

    /**
     * Check if a step text matches a step pattern (basic pattern matching)
     */
    private stepMatchesPattern(stepText: string, pattern: string): boolean {
        // Convert cucumber expression to regex
        let regexStr = pattern
            .replace(/\{string\}/g, '"[^"]*"')
            .replace(/\{int\}/g, '\\d+')
            .replace(/\{float\}/g, '[\\d.]+')
            .replace(/\{word\}/g, '\\S+')
            .replace(/\{.*?\}/g, '.*?');

        try {
            const regex = new RegExp(`^${regexStr}$`, 'i');
            return regex.test(stepText);
        } catch {
            return pattern === stepText;
        }
    }

    /**
     * Convert an accessibility tree node to YAML format
     */
    private accessibilityTreeToYaml(node: any, indent: number = 0): string {
        if (!node) return '# Empty accessibility tree\n';

        const prefix = '  '.repeat(indent);
        let yaml = '';

        if (node.role) {
            yaml += `${prefix}- role: ${node.role}\n`;
            if (node.name) yaml += `${prefix}  name: "${node.name}"\n`;
            if (node.value) yaml += `${prefix}  value: "${node.value}"\n`;
            if (node.description) yaml += `${prefix}  description: "${node.description}"\n`;
            if (node.focused) yaml += `${prefix}  focused: true\n`;
            if (node.checked !== undefined) yaml += `${prefix}  checked: ${node.checked}\n`;
            if (node.disabled) yaml += `${prefix}  disabled: true\n`;
        }

        if (node.children && node.children.length > 0) {
            yaml += `${prefix}  children:\n`;
            for (const child of node.children) {
                yaml += this.accessibilityTreeToYaml(child, indent + 2);
            }
        }

        return yaml;
    }

    /**
     * Convert a URL path to a PascalCase class name
     */
    private urlToClassName(urlPath: string): string {
        const clean = urlPath
            .replace(/^\//, '')
            .replace(/\/$/, '')
            .replace(/\.[^.]+$/, ''); // Remove file extension

        if (!clean) return 'HomePage';

        const parts = clean.split(/[/\-_]+/);
        const pascalCase = parts
            .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
            .join('');

        return `${pascalCase}Page`;
    }

    /**
     * Generate a TypeScript page object class from discovered elements
     */
    private generatePageObjectCode(
        className: string,
        pageUrl: string,
        elements: any[]
    ): string {
        const usedNames = new Set<string>();
        const elementDeclarations: string[] = [];

        for (const el of elements) {
            // Ensure unique variable names
            let varName = el.varName || 'element';
            if (usedNames.has(varName)) {
                let counter = 2;
                while (usedNames.has(`${varName}${counter}`)) counter++;
                varName = `${varName}${counter}`;
            }
            usedNames.add(varName);

            const locatorKey = el.locatorType === 'xpath' ? 'xpath' : 'css';
            const description = el.ariaLabel || el.placeholder || el.text || el.name || varName;

            elementDeclarations.push(`    @CSGetElement({
        ${locatorKey}: '${el.locator.replace(/'/g, "\\'")}',
        description: '${description.replace(/'/g, "\\'")}',
        waitForVisible: true,
        selfHeal: true
    })
    private ${varName}!: CSWebElement;`);
        }

        return `/**
 * Auto-generated page object for: ${pageUrl}
 * Generated by CS Playwright CLI
 * Date: ${new Date().toISOString()}
 *
 * IMPORTANT: Review and adjust locators before using in tests.
 * Prefer getByRole/getByTestId locators for stability.
 */

import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';

@CSPage('${className.replace('Page', '').toLowerCase()}')
export class ${className} extends CSBasePage {

${elementDeclarations.join('\n\n')}

    protected initializeElements(): void {
        // Elements are initialized via @CSGetElement decorators
    }
}
`;
    }

    /**
     * Get the list of available commands and their descriptions
     */
    getAvailableCommands(): Array<{ command: string; description: string; usage: string; outputFile: string }> {
        return [
            { command: 'snapshot', description: 'Capture accessibility snapshot of current page', usage: 'snapshot', outputFile: 'snapshot.yaml' },
            { command: 'screenshot', description: 'Capture page screenshot', usage: 'screenshot', outputFile: 'screenshot.png' },
            { command: 'page-info', description: 'Get current page URL, title, viewport', usage: 'page-info', outputFile: 'page-info.json' },
            { command: 'console-logs', description: 'Get recent console messages', usage: 'console-logs', outputFile: 'console.json' },
            { command: 'page-errors', description: 'Get page errors', usage: 'page-errors', outputFile: 'errors.json' },
            { command: 'network-log', description: 'Get recent network requests', usage: 'network-log', outputFile: 'network.json' },
            { command: 'list-features', description: 'List feature files matching pattern', usage: 'list-features [glob]', outputFile: 'features.json' },
            { command: 'list-steps', description: 'List all registered step definitions', usage: 'list-steps', outputFile: 'steps.json' },
            { command: 'validate-steps', description: 'Validate steps in a feature file exist', usage: 'validate-steps <feature-file>', outputFile: 'validation.json' },
            { command: 'run-test', description: 'Run a test and capture results', usage: 'run-test <feature> [--tag <tag>]', outputFile: 'results.json' },
            { command: 'suggest-locator', description: 'Suggest better locator for element', usage: 'suggest-locator <selector>', outputFile: 'locator.json' },
            { command: 'generate-page', description: 'Generate page object from current page', usage: 'generate-page [url]', outputFile: 'generated-page.ts' },
            { command: 'query', description: 'Execute database query', usage: 'query <alias> <sql>', outputFile: 'query-results.json' }
        ];
    }
}
