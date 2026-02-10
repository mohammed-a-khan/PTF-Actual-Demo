/**
 * CS Playwright Test Framework - Spec Format Page Injector
 * Auto-discovers and injects page objects into spec tests
 */

import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Lazy load CSPageRegistry to avoid circular dependencies
let CSPageRegistry: any = null;
let CSPageFactory: any = null;
let tsNodeRegistered = false;

/**
 * Page registration info
 */
interface PageInfo {
    /** Page name from @CSPage decorator */
    name: string;
    /** Class name */
    className: string;
    /** File path */
    filePath: string;
    /** Page class (loaded on demand) */
    pageClass?: any;
    /** Whether the class has been loaded */
    loaded: boolean;
}

/**
 * Manages page object discovery and injection for spec tests
 */
export class CSSpecPageInjector {
    private static instance: CSSpecPageInjector;
    private config: CSConfigurationManager;
    private pages: Map<string, PageInfo> = new Map();
    private instances: Map<string, any> = new Map();
    private scanned: boolean = false;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSSpecPageInjector {
        if (!CSSpecPageInjector.instance) {
            CSSpecPageInjector.instance = new CSSpecPageInjector();
        }
        return CSSpecPageInjector.instance;
    }

    /**
     * Scan for page objects in project directories
     */
    public async scanPages(): Promise<void> {
        if (this.scanned) {
            return;
        }

        const startTime = Date.now();
        const project = this.config.get('PROJECT', 'common');

        // Default page directories
        const defaultDirs = [
            `test/${project}/pages`,
            `test/common/pages`,
            `src/pages`
        ];

        CSReporter.debug(`[PageInjector] Scanning pages for project: ${project}`);

        for (const dir of defaultDirs) {
            const fullPath = path.resolve(process.cwd(), dir);
            if (fs.existsSync(fullPath)) {
                await this.scanDirectory(fullPath);
            }
        }

        this.scanned = true;
        const duration = Date.now() - startTime;
        CSReporter.info(`[PageInjector] Discovered ${this.pages.size} pages in ${duration}ms`);
    }

    /**
     * Scan directory for page files
     */
    private async scanDirectory(dirPath: string): Promise<void> {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    await this.scanDirectory(fullPath);
                } else if (entry.isFile() && this.isPageFile(entry.name)) {
                    await this.scanPageFile(fullPath);
                }
            }
        } catch (error: any) {
            CSReporter.debug(`[PageInjector] Error scanning directory ${dirPath}: ${error.message}`);
        }
    }

    /**
     * Check if file is a page file
     */
    private isPageFile(fileName: string): boolean {
        return (fileName.endsWith('Page.ts') || fileName.endsWith('Page.js')) &&
               !fileName.endsWith('.d.ts');
    }

    /**
     * Scan page file to extract @CSPage decorator info
     * Uses regex to avoid loading the module
     */
    private async scanPageFile(filePath: string): Promise<void> {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');

            // Extract @CSPage('name') using regex
            const csPageMatch = content.match(/@CSPage\s*\(\s*['"]([^'"]+)['"]\s*\)/);

            if (csPageMatch) {
                const pageName = csPageMatch[1];
                const className = path.basename(filePath).replace(/\.(ts|js)$/, '');

                // Check for compiled JS version
                let fileToUse = filePath;
                if (filePath.endsWith('.ts')) {
                    const jsPath = filePath.replace('/src/', '/dist/').replace('.ts', '.js');
                    const jsPathAlt = path.join(process.cwd(), 'dist',
                        path.relative(process.cwd(), filePath).replace('.ts', '.js'));

                    if (fs.existsSync(jsPath)) {
                        fileToUse = jsPath;
                    } else if (fs.existsSync(jsPathAlt)) {
                        fileToUse = jsPathAlt;
                    }
                }

                // Convert page name to camelCase fixture name
                const fixtureName = this.pageNameToFixtureName(pageName);

                this.pages.set(fixtureName, {
                    name: pageName,
                    className,
                    filePath: fileToUse,
                    loaded: false
                });

                CSReporter.debug(`[PageInjector] Registered page: ${fixtureName} (${pageName}) from ${className}`);
            }
        } catch (error: any) {
            CSReporter.debug(`[PageInjector] Error scanning page file ${filePath}: ${error.message}`);
        }
    }

    /**
     * Convert page name from @CSPage decorator to fixture name
     * Handles various formats and normalizes to proper camelCase with "Page" suffix
     *
     * Examples:
     *   "app-deal-details" → "dealDetailsPage"
     *   "login" → "loginPage"
     *   "loginpage" → "loginPage" (normalizes lowercase 'page')
     *   "login.page" → "loginPage" (handles dots)
     *   "LoginPage" → "loginPage" (ensures camelCase start)
     *   "LOGINPAGE" → "loginPage" (handles all uppercase)
     */
    private pageNameToFixtureName(pageName: string): string {
        // Remove project prefix if present (e.g., "myapp-" → "")
        const project = this.config.get('PROJECT', '');
        let cleanName = pageName;
        if (project && cleanName.startsWith(`${project}-`)) {
            cleanName = cleanName.substring(project.length + 1);
        }

        // Replace dots, underscores with hyphens for uniform processing
        cleanName = cleanName.replace(/[._]/g, '-');

        // Convert kebab-case to camelCase
        let camelCase = cleanName.replace(/-([a-z])/gi, (match, letter) => letter.toUpperCase());

        // Remove any remaining hyphens (edge case)
        camelCase = camelCase.replace(/-/g, '');

        // Normalize "page" suffix variations to proper "Page"
        // Handle: loginpage, loginPage, login-page, login.page, LOGINPAGE, etc.
        const lowerCase = camelCase.toLowerCase();
        if (lowerCase.endsWith('page')) {
            // Remove the existing 'page' suffix (case-insensitive) and add proper 'Page'
            let baseName = camelCase.substring(0, camelCase.length - 4);
            // If base name is all uppercase, convert to lowercase
            if (baseName === baseName.toUpperCase() && baseName.length > 0) {
                baseName = baseName.toLowerCase();
            }
            camelCase = baseName + 'Page';
        } else {
            // If name is all uppercase, convert to lowercase before adding Page
            if (camelCase === camelCase.toUpperCase() && camelCase.length > 0) {
                camelCase = camelCase.toLowerCase();
            }
            camelCase = camelCase + 'Page';
        }

        // Ensure first letter is lowercase (camelCase convention)
        if (camelCase.length > 0) {
            camelCase = camelCase.charAt(0).toLowerCase() + camelCase.slice(1);
        }

        return camelCase;
    }

    /**
     * Get page class by fixture name
     */
    public async getPageClass(fixtureName: string): Promise<any> {
        // Ensure pages are scanned
        if (!this.scanned) {
            await this.scanPages();
        }

        const pageInfo = this.pages.get(fixtureName);
        if (!pageInfo) {
            CSReporter.debug(`[PageInjector] Page not found: ${fixtureName}`);
            return null;
        }

        // Load the page class if not already loaded
        if (!pageInfo.loaded) {
            try {
                // Register ts-node if loading TypeScript files
                if (pageInfo.filePath.endsWith('.ts') && !tsNodeRegistered) {
                    try {
                        require('ts-node/register');
                        tsNodeRegistered = true;
                        CSReporter.debug('[PageInjector] ts-node registered for TypeScript files');
                    } catch (e) {
                        CSReporter.debug('[PageInjector] ts-node not available, assuming TypeScript is pre-compiled');
                    }
                }

                const startTime = Date.now();
                const module = require(pageInfo.filePath);

                // Find the exported class
                pageInfo.pageClass = module[pageInfo.className] || module.default;
                pageInfo.loaded = true;

                const duration = Date.now() - startTime;
                CSReporter.debug(`[PageInjector] Loaded page: ${fixtureName} in ${duration}ms`);
            } catch (error: any) {
                CSReporter.error(`[PageInjector] Failed to load page ${fixtureName}: ${error.message}`);
                return null;
            }
        }

        return pageInfo.pageClass;
    }

    /**
     * Create page instance with Playwright page
     */
    public async createPageInstance(fixtureName: string, playwrightPage: Page): Promise<any> {
        const cacheKey = `${fixtureName}_${playwrightPage?.url?.() || 'nopage'}`;

        // Don't cache instances - create fresh for each test for isolation
        const PageClass = await this.getPageClass(fixtureName);
        if (!PageClass) {
            return null;
        }

        try {
            const instance = new PageClass(playwrightPage);
            CSReporter.debug(`[PageInjector] Created instance of: ${fixtureName}`);
            return instance;
        } catch (error: any) {
            CSReporter.error(`[PageInjector] Failed to create instance of ${fixtureName}: ${error.message}`);
            return null;
        }
    }

    /**
     * Get all available fixture names
     */
    public async getAvailableFixtures(): Promise<string[]> {
        if (!this.scanned) {
            await this.scanPages();
        }
        return Array.from(this.pages.keys());
    }

    /**
     * Create fixtures object with all page instances for a test
     */
    public async createPageFixtures(playwrightPage: Page): Promise<Record<string, any>> {
        if (!this.scanned) {
            await this.scanPages();
        }

        const fixtures: Record<string, any> = {};

        for (const [fixtureName, pageInfo] of this.pages) {
            try {
                const instance = await this.createPageInstance(fixtureName, playwrightPage);
                if (instance) {
                    fixtures[fixtureName] = instance;
                }
            } catch (error: any) {
                CSReporter.debug(`[PageInjector] Failed to create fixture ${fixtureName}: ${error.message}`);
            }
        }

        return fixtures;
    }

    /**
     * Try to get page from existing registries (CSPageRegistry, CSPageFactory)
     * Fallback for pages not discovered during scanning
     */
    public async getPageFromRegistries(pageName: string, playwrightPage: Page): Promise<any> {
        // Try CSPageRegistry first
        if (!CSPageRegistry) {
            try {
                CSPageRegistry = require('../core/CSPageRegistry').CSPageRegistry;
            } catch {
                // Ignore if not available
            }
        }

        if (CSPageRegistry) {
            try {
                const registry = CSPageRegistry.getInstance();
                const pageClass = await registry.getPageClass(pageName);
                if (pageClass) {
                    return new pageClass(playwrightPage);
                }
            } catch {
                // Continue to CSPageFactory
            }
        }

        // Try CSPageFactory
        if (!CSPageFactory) {
            try {
                CSPageFactory = require('../core/CSPageFactory').CSPageFactory;
            } catch {
                // Ignore if not available
            }
        }

        if (CSPageFactory) {
            try {
                const allPages = CSPageFactory.getAllPages();
                for (const [className, cls] of allPages) {
                    const pageUrl = Reflect.getMetadata('page:url', cls);
                    if (pageUrl === pageName) {
                        return new cls(playwrightPage);
                    }
                }
            } catch {
                // Page not found
            }
        }

        return null;
    }

    /**
     * Clear page instances cache
     */
    public clearInstances(): void {
        this.instances.clear();
        CSReporter.debug('[PageInjector] Instance cache cleared');
    }

    /**
     * Reset scanner (useful for testing)
     */
    public reset(): void {
        this.pages.clear();
        this.instances.clear();
        this.scanned = false;
        CSReporter.debug('[PageInjector] Reset complete');
    }

    /**
     * Generate TypeScript declaration file for IntelliSense support
     * Creates a fixtures.d.ts file with module augmentation for SpecFixtures interface
     *
     * @param outputPath - Path where fixtures.d.ts will be written
     * @returns Path to generated file
     */
    public async generateFixturesFile(outputPath?: string): Promise<string> {
        // Ensure pages are scanned
        if (!this.scanned) {
            await this.scanPages();
        }

        const project = this.config.get('PROJECT', 'common');

        // Default output path: test/{project}/fixtures.d.ts (declaration file)
        const defaultPath = path.resolve(process.cwd(), `test/${project}/fixtures.d.ts`);
        const filePath = outputPath || defaultPath;

        // Collect page info for generation
        const pageEntries: Array<{
            fixtureName: string;
            className: string;
            importPath: string;
        }> = [];

        for (const [fixtureName, pageInfo] of this.pages) {
            // Calculate relative import path from fixtures.ts location
            const fixturesDir = path.dirname(filePath);
            let relativePath = path.relative(fixturesDir, pageInfo.filePath);

            // Ensure path uses forward slashes and remove .ts extension
            relativePath = relativePath.replace(/\\/g, '/').replace(/\.(ts|js)$/, '');

            // Ensure it starts with ./ for relative imports
            if (!relativePath.startsWith('.') && !relativePath.startsWith('/')) {
                relativePath = './' + relativePath;
            }

            pageEntries.push({
                fixtureName,
                className: pageInfo.className,
                importPath: relativePath
            });
        }

        // Generate the fixtures file content
        const content = this.generateFixturesContent(pageEntries);

        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Check if file already exists
        const fileExists = fs.existsSync(filePath);
        if (fileExists) {
            // Create backup
            const backupPath = filePath + '.backup';
            fs.copyFileSync(filePath, backupPath);
            console.log(`\n📦 Backup created: ${backupPath}`);
        }

        // Write the file
        fs.writeFileSync(filePath, content, 'utf-8');

        console.log(`\n✅ ${fileExists ? 'Regenerated' : 'Generated'} fixtures declaration: ${filePath}`);
        console.log(`   - Found ${pageEntries.length} page(s)`);
        console.log(`\n📝 Usage: Keep your existing imports from '@mdakhan.mak/cs-playwright-test-framework/spec'`);
        console.log(`   TypeScript will automatically pick up the type augmentations.`);
        console.log(`   IntelliSense will now work for: ${pageEntries.map(p => p.fixtureName).join(', ')}`);

        return filePath;
    }

    /**
     * Generate the content for fixtures.d.ts declaration file
     */
    private generateFixturesContent(pageEntries: Array<{
        fixtureName: string;
        className: string;
        importPath: string;
    }>): string {
        const imports = pageEntries
            .map(p => `import { ${p.className} } from '${p.importPath}';`)
            .join('\n');

        const fixtureTypes = pageEntries
            .map(p => `        ${p.fixtureName}: ${p.className};`)
            .join('\n');

        return `/**
 * CS Playwright Test Framework - Typed Fixtures Declaration
 * Auto-generated by: npx cs-playwright-test generate-fixtures
 *
 * This declaration file provides TypeScript IntelliSense support for page fixtures.
 * Keep importing from '@mdakhan.mak/cs-playwright-test-framework/spec' in your spec files.
 * TypeScript will automatically pick up these type augmentations.
 *
 * DO NOT EDIT MANUALLY - Regenerate when adding new pages:
 *   npx cs-playwright-test generate-fixtures --project=<your-project>
 *
 * Generated: ${new Date().toISOString()}
 */

// Import page classes for type references
${imports}

// Augment SpecFixtures interface with page types
declare module '@mdakhan.mak/cs-playwright-test-framework/spec' {
    interface SpecFixtures {
${fixtureTypes}
    }
}
`;
    }

    /**
     * Get all registered pages info (for debugging/tooling)
     */
    public async getRegisteredPages(): Promise<Map<string, PageInfo>> {
        if (!this.scanned) {
            await this.scanPages();
        }
        return new Map(this.pages);
    }
}
