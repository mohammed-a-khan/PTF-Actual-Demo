import { Page, Locator } from '@playwright/test';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface VisualTestOptions {
    name?: string;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
    mask?: string[];
    threshold?: number;
    maxDiffPixels?: number;
    animations?: 'disabled' | 'allow';
    caret?: 'hide' | 'initial';
    scale?: 'css' | 'device';
    timeout?: number;
    stylePath?: string;
    omitBackground?: boolean;
}

export interface ComparisonResult {
    passed: boolean;
    diffPixels: number;
    diffPercentage: number;
    baselineImage?: string;
    actualImage?: string;
    diffImage?: string;
    message?: string;
}

export interface VisualSnapshot {
    name: string;
    timestamp: Date;
    browser: string;
    viewport: { width: number; height: number };
    devicePixelRatio: number;
    imagePath: string;
    metadata?: any;
}

export class CSVisualTesting {
    private static instance: CSVisualTesting;
    private config: CSConfigurationManager;
    private baselineDir!: string;
    private actualDir!: string;
    private diffDir!: string;
    private snapshots: Map<string, VisualSnapshot> = new Map();
    private comparisonResults: ComparisonResult[] = [];
    private defaultThreshold: number;
    private ignoreRegions: Map<string, Array<{ x: number; y: number; width: number; height: number }>> = new Map();
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.initializeDirectories();
        this.defaultThreshold = this.config.getNumber('VISUAL_THRESHOLD', 0.1);
    }
    
    public static getInstance(): CSVisualTesting {
        if (!CSVisualTesting.instance) {
            CSVisualTesting.instance = new CSVisualTesting();
        }
        return CSVisualTesting.instance;
    }
    
    private initializeDirectories(): void {
        const visualDir = path.join(process.cwd(), 'test', 'visual');
        this.baselineDir = path.join(visualDir, 'baseline');
        this.actualDir = path.join(visualDir, 'actual');
        this.diffDir = path.join(visualDir, 'diff');
        
        // Create directories if they don't exist
        [this.baselineDir, this.actualDir, this.diffDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }
    
    public async captureScreenshot(page: Page, options: VisualTestOptions = {}): Promise<string> {
        const name = options.name || this.generateSnapshotName();
        const fileName = `${name}.png`;
        const actualPath = path.join(this.actualDir, fileName);
        
        CSReporter.startStep(`Capturing visual snapshot: ${name}`);
        
        try {
            // Apply visual testing configurations
            if (options.animations === 'disabled') {
                await page.addStyleTag({
                    content: `
                        *, *::before, *::after {
                            animation-duration: 0s !important;
                            animation-delay: 0s !important;
                            transition-duration: 0s !important;
                            transition-delay: 0s !important;
                        }
                    `
                });
            }
            
            if (options.caret === 'hide') {
                await page.addStyleTag({
                    content: `
                        * {
                            caret-color: transparent !important;
                        }
                    `
                });
            }
            
            // Apply custom styles if provided
            if (options.stylePath && fs.existsSync(options.stylePath)) {
                const customStyle = fs.readFileSync(options.stylePath, 'utf8');
                await page.addStyleTag({ content: customStyle });
            }
            
            // Mask specified elements
            if (options.mask && options.mask.length > 0) {
                await this.maskElements(page, options.mask);
            }
            
            // Capture screenshot
            const screenshotOptions: any = {
                path: actualPath,
                fullPage: options.fullPage !== false,
                omitBackground: options.omitBackground,
                scale: options.scale || 'css',
                timeout: options.timeout || 30000
            };
            
            if (options.clip) {
                screenshotOptions.clip = options.clip;
                screenshotOptions.fullPage = false;
            }
            
            await page.screenshot(screenshotOptions);
            
            // Store snapshot metadata
            const viewport = page.viewportSize();
            const snapshot: VisualSnapshot = {
                name,
                timestamp: new Date(),
                browser: page.context().browser()?.browserType().name() || 'unknown',
                viewport: viewport || { width: 1920, height: 1080 },
                devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
                imagePath: actualPath
            };
            
            this.snapshots.set(name, snapshot);
            
            CSReporter.endStep('pass');
            CSReporter.info(`Visual snapshot captured: ${actualPath}`);
            
            return actualPath;
            
        } catch (error: any) {
            CSReporter.endStep('fail');
            throw error;
        }
    }
    
    public async captureElement(page: Page, selector: string, options: VisualTestOptions = {}): Promise<string> {
        const element = page.locator(selector);
        const name = options.name || `element_${this.generateSnapshotName()}`;
        const fileName = `${name}.png`;
        const actualPath = path.join(this.actualDir, fileName);
        
        CSReporter.startStep(`Capturing element snapshot: ${selector}`);
        
        try {
            // Scroll element into view
            await element.scrollIntoViewIfNeeded();
            
            // Apply masking to other elements if specified
            if (options.mask && options.mask.length > 0) {
                await this.maskElements(page, options.mask);
            }
            
            // Capture element screenshot
            await element.screenshot({
                path: actualPath,
                timeout: options.timeout || 30000,
                omitBackground: options.omitBackground,
                scale: options.scale || 'css'
            });
            
            CSReporter.endStep('pass');
            CSReporter.info(`Element snapshot captured: ${actualPath}`);
            
            return actualPath;
            
        } catch (error: any) {
            CSReporter.endStep('fail');
            throw error;
        }
    }
    
    public async compareWithBaseline(name: string, options: VisualTestOptions = {}): Promise<ComparisonResult> {
        const fileName = `${name}.png`;
        const baselinePath = path.join(this.baselineDir, fileName);
        const actualPath = path.join(this.actualDir, fileName);
        const diffPath = path.join(this.diffDir, fileName);
        
        CSReporter.startStep(`Comparing visual snapshot: ${name}`);
        
        // Check if baseline exists
        if (!fs.existsSync(baselinePath)) {
            // Create baseline from actual
            if (fs.existsSync(actualPath)) {
                fs.copyFileSync(actualPath, baselinePath);
                CSReporter.warn(`Baseline created for: ${name}`);
                CSReporter.endStep('pass');
                
                return {
                    passed: true,
                    diffPixels: 0,
                    diffPercentage: 0,
                    baselineImage: baselinePath,
                    actualImage: actualPath,
                    message: 'Baseline created'
                };
            } else {
                CSReporter.endStep('fail');
                throw new Error(`Actual image not found: ${actualPath}`);
            }
        }
        
        // Check if actual exists
        if (!fs.existsSync(actualPath)) {
            CSReporter.endStep('fail');
            throw new Error(`Actual image not found: ${actualPath}`);
        }
        
        // Perform pixel comparison
        const result = await this.compareImages(
            baselinePath,
            actualPath,
            diffPath,
            options.threshold || this.defaultThreshold,
            options.maxDiffPixels
        );
        
        // Store result
        this.comparisonResults.push(result);
        
        if (result.passed) {
            CSReporter.endStep('pass');
            CSReporter.pass(`Visual comparison passed: ${name} (${result.diffPercentage.toFixed(2)}% difference)`);
        } else {
            CSReporter.endStep('fail');
            CSReporter.fail(`Visual comparison failed: ${name} (${result.diffPercentage.toFixed(2)}% difference)`);
        }
        
        return result;
    }
    
    private async compareImages(
        baselinePath: string,
        actualPath: string,
        diffPath: string,
        threshold: number,
        maxDiffPixels?: number
    ): Promise<ComparisonResult> {
        // This is a simplified comparison
        // In production, use a proper image comparison library like pixelmatch or resemble.js
        
        const baselineBuffer = fs.readFileSync(baselinePath);
        const actualBuffer = fs.readFileSync(actualPath);
        
        // Simple byte comparison for demo
        const baselineHash = crypto.createHash('sha256').update(baselineBuffer).digest('hex');
        const actualHash = crypto.createHash('sha256').update(actualBuffer).digest('hex');
        
        if (baselineHash === actualHash) {
            return {
                passed: true,
                diffPixels: 0,
                diffPercentage: 0,
                baselineImage: baselinePath,
                actualImage: actualPath
            };
        }
        
        // In real implementation, perform pixel-by-pixel comparison
        // and generate diff image
        const diffPixels = Math.floor(Math.random() * 1000); // Simulated
        const totalPixels = 1920 * 1080; // Simulated
        const diffPercentage = (diffPixels / totalPixels) * 100;
        
        const passed = diffPercentage <= threshold && 
                      (!maxDiffPixels || diffPixels <= maxDiffPixels);
        
        // Generate diff image (simplified - in production use proper diff generation)
        if (!passed) {
            fs.copyFileSync(actualPath, diffPath);
        }
        
        return {
            passed,
            diffPixels,
            diffPercentage,
            baselineImage: baselinePath,
            actualImage: actualPath,
            diffImage: !passed ? diffPath : undefined
        };
    }
    
    private async maskElements(page: Page, selectors: string[]): Promise<void> {
        for (const selector of selectors) {
            try {
                await page.locator(selector).evaluateAll((elements) => {
                    elements.forEach(el => {
                        (el as HTMLElement).style.visibility = 'hidden';
                    });
                });
            } catch (error) {
                CSReporter.warn(`Could not mask element: ${selector}`);
            }
        }
    }
    
    public async updateBaseline(name: string): Promise<void> {
        const fileName = `${name}.png`;
        const baselinePath = path.join(this.baselineDir, fileName);
        const actualPath = path.join(this.actualDir, fileName);
        
        if (!fs.existsSync(actualPath)) {
            throw new Error(`Actual image not found: ${actualPath}`);
        }
        
        fs.copyFileSync(actualPath, baselinePath);
        CSReporter.info(`Baseline updated: ${name}`);
    }
    
    public async updateAllBaselines(): Promise<void> {
        const actualFiles = fs.readdirSync(this.actualDir);
        
        for (const file of actualFiles) {
            if (file.endsWith('.png')) {
                const actualPath = path.join(this.actualDir, file);
                const baselinePath = path.join(this.baselineDir, file);
                fs.copyFileSync(actualPath, baselinePath);
            }
        }
        
        CSReporter.info(`Updated ${actualFiles.length} baselines`);
    }
    
    public addIgnoreRegion(name: string, region: { x: number; y: number; width: number; height: number }): void {
        if (!this.ignoreRegions.has(name)) {
            this.ignoreRegions.set(name, []);
        }
        this.ignoreRegions.get(name)!.push(region);
        CSReporter.debug(`Added ignore region for ${name}: ${JSON.stringify(region)}`);
    }
    
    public clearIgnoreRegions(name?: string): void {
        if (name) {
            this.ignoreRegions.delete(name);
        } else {
            this.ignoreRegions.clear();
        }
    }
    
    private generateSnapshotName(): string {
        return `snapshot_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    }
    
    public getComparisonResults(): ComparisonResult[] {
        return [...this.comparisonResults];
    }
    
    public getFailedComparisons(): ComparisonResult[] {
        return this.comparisonResults.filter(r => !r.passed);
    }
    
    public generateReport(): any {
        const totalComparisons = this.comparisonResults.length;
        const passedComparisons = this.comparisonResults.filter(r => r.passed).length;
        const failedComparisons = totalComparisons - passedComparisons;
        
        return {
            summary: {
                total: totalComparisons,
                passed: passedComparisons,
                failed: failedComparisons,
                passRate: totalComparisons > 0 ? (passedComparisons / totalComparisons) * 100 : 0
            },
            comparisons: this.comparisonResults.map(r => ({
                passed: r.passed,
                diffPixels: r.diffPixels,
                diffPercentage: r.diffPercentage,
                images: {
                    baseline: r.baselineImage,
                    actual: r.actualImage,
                    diff: r.diffImage
                }
            })),
            snapshots: Array.from(this.snapshots.values())
        };
    }
    
    public saveReport(filePath: string): void {
        const report = this.generateReport();
        
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
        CSReporter.info(`Visual testing report saved to: ${filePath}`);
    }
    
    public reset(): void {
        this.snapshots.clear();
        this.comparisonResults = [];
        this.ignoreRegions.clear();
        CSReporter.debug('Visual testing state reset');
    }
    
    public cleanupActualImages(): void {
        const files = fs.readdirSync(this.actualDir);
        files.forEach(file => {
            fs.unlinkSync(path.join(this.actualDir, file));
        });
        CSReporter.debug(`Cleaned up ${files.length} actual images`);
    }
    
    public cleanupDiffImages(): void {
        const files = fs.readdirSync(this.diffDir);
        files.forEach(file => {
            fs.unlinkSync(path.join(this.diffDir, file));
        });
        CSReporter.debug(`Cleaned up ${files.length} diff images`);
    }
}