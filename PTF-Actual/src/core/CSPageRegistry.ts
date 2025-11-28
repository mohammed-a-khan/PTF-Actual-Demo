/**
 * CS Page Registry - Lazy Page Loading for Performance
 *
 * Provides lazy loading of page classes to avoid importing all pages at startup.
 * Pages are registered by path and only loaded when first accessed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from './CSConfigurationManager';

interface PageRegistration {
    name: string;           // Page name from @CSPage decorator
    className: string;      // Class name
    filePath: string;       // Path to the page file
    loaded: boolean;        // Whether the class has been loaded
    pageClass?: any;        // The actual class (set when loaded)
}

export class CSPageRegistry {
    private static instance: CSPageRegistry;
    private pages: Map<string, PageRegistration> = new Map();
    private config: CSConfigurationManager;
    private scanned: boolean = false;
    private pageDirectories: string[] = [];

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSPageRegistry {
        if (!CSPageRegistry.instance) {
            CSPageRegistry.instance = new CSPageRegistry();
        }
        return CSPageRegistry.instance;
    }

    /**
     * Set page directories to scan for lazy loading
     */
    public setPageDirectories(directories: string[]): void {
        this.pageDirectories = directories;
        this.scanned = false; // Reset scan status
    }

    /**
     * Scan page directories and register pages without loading them
     * Only extracts @CSPage decorator names from files
     */
    public async scanPages(): Promise<void> {
        if (this.scanned) return;

        const startTime = Date.now();
        const project = this.config.get('PROJECT', 'common');

        // Default page directories
        const defaultDirs = [
            `test/${project}/pages`,
            `test/common/pages`,
            `src/pages`
        ];

        const dirsToScan = this.pageDirectories.length > 0
            ? this.pageDirectories
            : defaultDirs;

        for (const dir of dirsToScan) {
            const fullPath = path.resolve(process.cwd(), dir);
            if (fs.existsSync(fullPath)) {
                await this.scanDirectory(fullPath);
            }
        }

        this.scanned = true;
        const duration = Date.now() - startTime;
        CSReporter.debug(`[PageRegistry] Scanned ${this.pages.size} pages in ${duration}ms`);
    }

    /**
     * Scan a directory for page files
     */
    private async scanDirectory(dirPath: string): Promise<void> {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                await this.scanDirectory(fullPath);
            } else if (entry.name.endsWith('Page.ts') || entry.name.endsWith('Page.js')) {
                await this.scanPageFile(fullPath);
            }
        }
    }

    /**
     * Scan a page file and extract @CSPage decorator name without loading it
     */
    private async scanPageFile(filePath: string): Promise<void> {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');

            // Extract @CSPage('name') using regex - fast, no module loading
            const csPageMatch = content.match(/@CSPage\s*\(\s*['"]([^'"]+)['"]\s*\)/);

            if (csPageMatch) {
                const pageName = csPageMatch[1];
                const className = path.basename(filePath).replace(/\.(ts|js)$/, '');

                // Check for compiled JS version
                let fileToUse = filePath;
                if (filePath.endsWith('.ts')) {
                    const jsPath = filePath.replace('/src/', '/dist/').replace('.ts', '.js');
                    const jsPathAlt = path.join(process.cwd(), 'dist', path.relative(process.cwd(), filePath).replace('.ts', '.js'));

                    if (fs.existsSync(jsPath)) {
                        fileToUse = jsPath;
                    } else if (fs.existsSync(jsPathAlt)) {
                        fileToUse = jsPathAlt;
                    }
                }

                this.pages.set(pageName, {
                    name: pageName,
                    className,
                    filePath: fileToUse,
                    loaded: false
                });
            }
        } catch (error) {
            // Ignore errors - page file might have syntax issues
        }
    }

    /**
     * Get a page class by name - loads it if not already loaded
     */
    public async getPageClass(pageName: string): Promise<any> {
        // Ensure pages are scanned
        if (!this.scanned) {
            await this.scanPages();
        }

        const registration = this.pages.get(pageName);
        if (!registration) {
            CSReporter.warn(`[PageRegistry] Page not found: ${pageName}`);
            return null;
        }

        // Load the page if not already loaded
        if (!registration.loaded) {
            try {
                const startTime = Date.now();
                const module = require(registration.filePath);

                // Find the exported class
                registration.pageClass = module[registration.className] || module.default;
                registration.loaded = true;

                const duration = Date.now() - startTime;
                CSReporter.debug(`[PageRegistry] Loaded page: ${pageName} in ${duration}ms`);
            } catch (error: any) {
                CSReporter.error(`[PageRegistry] Failed to load page ${pageName}: ${error.message}`);
                return null;
            }
        }

        return registration.pageClass;
    }

    /**
     * Check if a page is registered
     */
    public hasPage(pageName: string): boolean {
        return this.pages.has(pageName);
    }

    /**
     * Get all registered page names (without loading them)
     */
    public getPageNames(): string[] {
        return Array.from(this.pages.keys());
    }

    /**
     * Register a page class directly (for backwards compatibility)
     * Called by @CSPage decorator when page is imported
     */
    public registerPageClass(pageName: string, pageClass: any): void {
        const existing = this.pages.get(pageName);
        if (existing) {
            existing.pageClass = pageClass;
            existing.loaded = true;
        } else {
            this.pages.set(pageName, {
                name: pageName,
                className: pageClass.name,
                filePath: '',
                loaded: true,
                pageClass
            });
        }
    }

    /**
     * Clear all registrations (for testing)
     */
    public clear(): void {
        this.pages.clear();
        this.scanned = false;
    }
}
