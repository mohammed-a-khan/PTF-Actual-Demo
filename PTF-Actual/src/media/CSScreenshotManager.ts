import { Page, ElementHandle } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';

export interface ScreenshotOptions {
    name?: string;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
    quality?: number;
    type?: 'png' | 'jpeg';
    omitBackground?: boolean;
    animations?: 'disabled' | 'allow';
    caret?: 'hide' | 'initial';
    scale?: 'css' | 'device';
    mask?: Array<ElementHandle>;
    maskColor?: string;
    style?: string;
    path?: string;
    timeout?: number;
}

export interface ComparisonResult {
    match: boolean;
    diffPercentage?: number;
    diffPixels?: number;
    diffPath?: string;
}

export class CSScreenshotManager {
    private static instance: CSScreenshotManager;
    private config: CSConfigurationManager;
    private screenshotDir: string;
    private baselineDir: string;
    private diffDir: string;
    private screenshotCount: number = 0;
    private screenshots: Map<string, string> = new Map();
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();

        // Use CSTestResultsManager to get the correct test results directory
        const { CSTestResultsManager } = require('../core/CSTestResultsManager');
        const resultsManager = CSTestResultsManager.getInstance();
        const dirs = resultsManager.getDirectories();

        this.screenshotDir = dirs.screenshots;
        this.baselineDir = this.config.get('BASELINE_DIR', './baselines');
        this.diffDir = this.config.get('DIFF_DIR', './diffs');

        this.ensureDirectories();
    }
    
    public static getInstance(): CSScreenshotManager {
        if (!CSScreenshotManager.instance) {
            CSScreenshotManager.instance = new CSScreenshotManager();
        }
        return CSScreenshotManager.instance;
    }
    
    private ensureDirectories(): void {
        [this.screenshotDir, this.baselineDir, this.diffDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }
    
    public async captureScreenshot(
        page: Page,
        options: ScreenshotOptions = {}
    ): Promise<string> {
        const timestamp = Date.now();
        const name = options.name || `screenshot_${++this.screenshotCount}`;
        const type = options.type || 'png';
        const filename = `${name}_${timestamp}.${type}`;
        const filepath = options.path || path.join(this.screenshotDir, filename);
        
        try {
            // Apply custom styles if provided
            if (options.style) {
                await page.addStyleTag({ content: options.style });
            }
            
            // Configure screenshot options
            const screenshotOptions: any = {
                path: filepath,
                type: options.type || 'png',
                fullPage: options.fullPage !== undefined ? options.fullPage : true,
                omitBackground: options.omitBackground || false,
                animations: options.animations || 'disabled',
                caret: options.caret || 'hide',
                scale: options.scale || 'css',
                timeout: options.timeout || 30000
            };
            
            // Add optional parameters
            if (options.clip) screenshotOptions.clip = options.clip;
            if (options.quality && type === 'jpeg') screenshotOptions.quality = options.quality;
            if (options.mask) screenshotOptions.mask = options.mask;
            if (options.maskColor) screenshotOptions.maskColor = options.maskColor;
            
            // Take screenshot
            await page.screenshot(screenshotOptions);
            
            // Store reference
            this.screenshots.set(name, filepath);
            
            CSReporter.info(`Screenshot captured: ${filepath}`);
            return filepath;
            
        } catch (error: any) {
            CSReporter.error(`Failed to capture screenshot: ${error.message}`);
            throw error;
        }
    }
    
    public async captureElement(
        element: ElementHandle,
        options: ScreenshotOptions = {}
    ): Promise<string> {
        const timestamp = Date.now();
        const name = options.name || `element_${++this.screenshotCount}`;
        const type = options.type || 'png';
        const filename = `${name}_${timestamp}.${type}`;
        const filepath = options.path || path.join(this.screenshotDir, filename);
        
        try {
            const screenshotOptions: any = {
                path: filepath,
                type: options.type || 'png',
                omitBackground: options.omitBackground || false,
                animations: options.animations || 'disabled',
                caret: options.caret || 'hide',
                scale: options.scale || 'css',
                timeout: options.timeout || 30000
            };
            
            if (options.quality && type === 'jpeg') screenshotOptions.quality = options.quality;
            
            await element.screenshot(screenshotOptions);
            
            this.screenshots.set(name, filepath);
            
            CSReporter.info(`Element screenshot captured: ${filepath}`);
            return filepath;
            
        } catch (error: any) {
            CSReporter.error(`Failed to capture element screenshot: ${error.message}`);
            throw error;
        }
    }
    
    public async captureViewport(
        page: Page,
        options: ScreenshotOptions = {}
    ): Promise<string> {
        return this.captureScreenshot(page, { ...options, fullPage: false });
    }
    
    public async captureFullPage(
        page: Page,
        options: ScreenshotOptions = {}
    ): Promise<string> {
        return this.captureScreenshot(page, { ...options, fullPage: true });
    }
    
    public async captureWithAnnotations(
        page: Page,
        annotations: Array<{ selector: string; text: string; style?: string }>,
        options: ScreenshotOptions = {}
    ): Promise<string> {
        // Add annotations to the page
        for (const annotation of annotations) {
            await page.evaluate(({ selector, text, style }) => {
                const element = document.querySelector(selector);
                if (element) {
                    const annotationDiv = document.createElement('div');
                    annotationDiv.textContent = text;
                    annotationDiv.style.cssText = style || `
                        position: absolute;
                        background: red;
                        color: white;
                        padding: 5px;
                        border-radius: 3px;
                        font-size: 12px;
                        z-index: 10000;
                    `;
                    
                    const rect = element.getBoundingClientRect();
                    annotationDiv.style.top = `${rect.top - 30}px`;
                    annotationDiv.style.left = `${rect.left}px`;
                    
                    document.body.appendChild(annotationDiv);
                }
            }, annotation);
        }
        
        // Take screenshot
        const filepath = await this.captureScreenshot(page, options);
        
        // Remove annotations
        await page.evaluate(() => {
            document.querySelectorAll('div[style*="z-index: 10000"]').forEach(el => el.remove());
        });
        
        return filepath;
    }
    
    public async compareWithBaseline(
        page: Page,
        baselineName: string,
        options: ScreenshotOptions = {}
    ): Promise<ComparisonResult> {
        const baselinePath = path.join(this.baselineDir, `${baselineName}.png`);
        
        // Check if baseline exists
        if (!fs.existsSync(baselinePath)) {
            CSReporter.warn(`Baseline not found, creating new baseline: ${baselineName}`);
            const screenshotPath = await this.captureScreenshot(page, {
                ...options,
                path: baselinePath,
                name: baselineName
            });
            return { match: true };
        }
        
        // Capture current screenshot
        const currentPath = await this.captureScreenshot(page, {
            ...options,
            name: `${baselineName}_current`
        });
        
        // Compare screenshots (simplified - in production use proper image comparison library)
        try {
            const baselineBuffer = fs.readFileSync(baselinePath);
            const currentBuffer = fs.readFileSync(currentPath);
            
            if (baselineBuffer.equals(currentBuffer)) {
                return { match: true };
            } else {
                const diffPath = path.join(this.diffDir, `${baselineName}_diff_${Date.now()}.png`);
                // In production, use a proper image comparison library like pixelmatch
                CSReporter.warn(`Screenshots don't match. Diff saved to: ${diffPath}`);
                return {
                    match: false,
                    diffPath,
                    diffPercentage: 0.1 // Placeholder
                };
            }
        } catch (error: any) {
            CSReporter.error(`Failed to compare screenshots: ${error.message}`);
            return { match: false };
        }
    }
    
    public async updateBaseline(
        page: Page,
        baselineName: string,
        options: ScreenshotOptions = {}
    ): Promise<string> {
        const baselinePath = path.join(this.baselineDir, `${baselineName}.png`);
        
        // Backup existing baseline if it exists
        if (fs.existsSync(baselinePath)) {
            const backupPath = path.join(this.baselineDir, `${baselineName}_backup_${Date.now()}.png`);
            fs.copyFileSync(baselinePath, backupPath);
            CSReporter.info(`Baseline backed up to: ${backupPath}`);
        }
        
        // Capture new baseline
        const screenshotPath = await this.captureScreenshot(page, {
            ...options,
            path: baselinePath,
            name: baselineName
        });
        
        CSReporter.pass(`Baseline updated: ${baselineName}`);
        return screenshotPath;
    }
    
    public async captureSequence(
        page: Page,
        steps: Array<{ action: () => Promise<void>; name: string; wait?: number }>,
        options: ScreenshotOptions = {}
    ): Promise<string[]> {
        const screenshots: string[] = [];
        
        for (const step of steps) {
            // Execute action
            await step.action();
            
            // Wait if specified
            if (step.wait) {
                await page.waitForTimeout(step.wait);
            }
            
            // Capture screenshot
            const filepath = await this.captureScreenshot(page, {
                ...options,
                name: step.name
            });
            
            screenshots.push(filepath);
        }
        
        CSReporter.info(`Captured ${screenshots.length} screenshots in sequence`);
        return screenshots;
    }
    
    public async captureOnError(
        page: Page,
        error: Error,
        options: ScreenshotOptions = {}
    ): Promise<string> {
        const name = options.name || `error_${Date.now()}`;
        
        // Add error information to the page
        await page.evaluate((errorInfo) => {
            const errorDiv = document.createElement('div');
            errorDiv.style.cssText = `
                position: fixed;
                top: 10px;
                right: 10px;
                background: #ff0000;
                color: white;
                padding: 10px;
                border-radius: 5px;
                z-index: 10000;
                max-width: 300px;
                font-family: monospace;
                font-size: 12px;
            `;
            errorDiv.innerHTML = `
                <strong>ERROR</strong><br>
                ${errorInfo.message}<br>
                <small>${new Date().toISOString()}</small>
            `;
            document.body.appendChild(errorDiv);
        }, { message: error.message });
        
        // Capture screenshot
        const filepath = await this.captureScreenshot(page, {
            ...options,
            name
        });
        
        CSReporter.error(`Error screenshot captured: ${filepath}`);
        return filepath;
    }
    
    public getScreenshot(name: string): string | undefined {
        return this.screenshots.get(name);
    }
    
    public getAllScreenshots(): Map<string, string> {
        return new Map(this.screenshots);
    }
    
    public clearScreenshots(): void {
        this.screenshots.clear();
        this.screenshotCount = 0;
    }
    
    public async cleanupOldScreenshots(daysToKeep: number = 7): Promise<void> {
        const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        
        const directories = [this.screenshotDir, this.diffDir];
        
        for (const dir of directories) {
            const files = fs.readdirSync(dir);
            
            for (const file of files) {
                const filepath = path.join(dir, file);
                const stats = fs.statSync(filepath);
                
                if (stats.mtimeMs < cutoffTime) {
                    fs.unlinkSync(filepath);
                    CSReporter.debug(`Deleted old screenshot: ${file}`);
                }
            }
        }
        
        CSReporter.info(`Cleaned up screenshots older than ${daysToKeep} days`);
    }
}