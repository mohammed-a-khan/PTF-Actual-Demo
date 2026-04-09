import { Page, Locator } from '@playwright/test';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import {
    SmartVisualResult,
    SmartVisualOptions,
    PerceptualHashOptions,
    StructuralComparisonOptions,
    LayoutChange,
    LayoutElementInfo,
    StructuralBaseline,
    PerceptualBaseline
} from './CSVisualAITypes';

/**
 * CSVisualAITesting - Enhanced Visual Comparison with AI Strategies
 *
 * Enhancement #11: Goes beyond pixel-level diff to provide perceptual hash
 * comparison, structural (layout-aware) comparison, and combined smart verdicts.
 *
 * This class complements the existing CSVisualTesting (pixel comparison) by adding:
 * - Perceptual hash comparison (catches human-visible changes, ignores sub-pixel diffs)
 * - Structural comparison (DOM/aria tree + bounding box layout analysis)
 * - Smart combined verdict (pixel + perceptual + structural)
 * - Region-based comparison
 *
 * Singleton pattern consistent with the framework.
 */
export class CSVisualAITesting {
    private static instance: CSVisualAITesting;
    private config: CSConfigurationManager;
    private enabled: boolean;
    private baseDir!: string;
    private baselineDir!: string;
    private actualDir!: string;
    private diffDir!: string;
    private perceptualThreshold: number;
    private layoutTolerance: number;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.enabled = this.config.getBoolean('VISUAL_AI_ENABLED', true);
        this.perceptualThreshold = this.config.getNumber('VISUAL_AI_PERCEPTUAL_THRESHOLD', 5);
        this.layoutTolerance = this.config.getNumber('VISUAL_AI_LAYOUT_TOLERANCE', 10);
        this.initializeDirectories();
    }

    public static getInstance(): CSVisualAITesting {
        if (!CSVisualAITesting.instance) {
            CSVisualAITesting.instance = new CSVisualAITesting();
        }
        return CSVisualAITesting.instance;
    }

    private initializeDirectories(): void {
        const configDir = this.config.get('VISUAL_AI_DIR', 'test/visual-ai');
        this.baseDir = path.join(process.cwd(), configDir);
        this.baselineDir = path.join(this.baseDir, 'baseline');
        this.actualDir = path.join(this.baseDir, 'actual');
        this.diffDir = path.join(this.baseDir, 'diff');

        [this.baselineDir, this.actualDir, this.diffDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    // =========================================================================
    // 1. PERCEPTUAL HASH COMPARISON
    // =========================================================================

    /**
     * Compares a page screenshot against baseline using perceptual hashing.
     * Perceptual hashing downscales the image to a small grid, converts to
     * grayscale, and generates a binary hash based on average pixel values.
     * This ignores sub-pixel rendering differences while catching visually
     * meaningful changes.
     *
     * @param page - Playwright Page instance
     * @param snapshotName - Name for the snapshot baseline
     * @param options - Perceptual hash options (hashSize, threshold)
     * @returns Object with passed status, hammingDistance, and maxDistance
     */
    public async comparePerceptual(
        page: Page,
        snapshotName: string,
        options?: PerceptualHashOptions & { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }
    ): Promise<{ passed: boolean; hammingDistance: number; maxDistance: number; message: string }> {
        if (!this.enabled) {
            return { passed: true, hammingDistance: 0, maxDistance: 0, message: 'Visual AI testing is disabled' };
        }

        CSReporter.startStep(`Perceptual hash comparison: ${snapshotName}`);

        try {
            const hashSize = options?.hashSize || 8;
            const threshold = options?.threshold ?? this.perceptualThreshold;
            const maxDistance = hashSize * hashSize;

            // Take screenshot and compute perceptual hash
            const screenshotBuffer = await page.screenshot({
                fullPage: options?.fullPage !== false,
                type: 'png',
                ...(options?.clip ? { clip: options.clip, fullPage: false } : {})
            });

            const currentHash = await this.computePerceptualHash(page, hashSize, options?.clip);

            // Save actual hash
            const actualHashPath = path.join(this.actualDir, `${snapshotName}.phash`);
            const actualData: PerceptualBaseline = {
                hash: currentHash,
                hashSize,
                timestamp: new Date().toISOString()
            };
            fs.writeFileSync(actualHashPath, JSON.stringify(actualData, null, 2));

            // Check baseline
            const baselineHashPath = path.join(this.baselineDir, `${snapshotName}.phash`);
            if (!fs.existsSync(baselineHashPath)) {
                // Create baseline
                fs.writeFileSync(baselineHashPath, JSON.stringify(actualData, null, 2));
                CSReporter.warn(`Perceptual baseline created for: ${snapshotName}`);
                CSReporter.endStep('pass');
                return { passed: true, hammingDistance: 0, maxDistance, message: 'Baseline created' };
            }

            // Load baseline and compare
            const baselineData: PerceptualBaseline = JSON.parse(fs.readFileSync(baselineHashPath, 'utf-8'));
            const hammingDistance = this.hammingDistance(baselineData.hash, currentHash);
            const passed = hammingDistance <= threshold;

            const message = passed
                ? `Perceptual match passed (distance: ${hammingDistance}/${maxDistance}, threshold: ${threshold})`
                : `Perceptual match failed (distance: ${hammingDistance}/${maxDistance}, threshold: ${threshold})`;

            if (passed) {
                CSReporter.pass(message);
                CSReporter.endStep('pass');
            } else {
                CSReporter.fail(message);
                CSReporter.endStep('fail');
            }

            return { passed, hammingDistance, maxDistance, message };
        } catch (error: any) {
            CSReporter.fail(`Perceptual comparison error: ${error.message}`);
            CSReporter.endStep('fail');
            throw error;
        }
    }

    /**
     * Compute a perceptual hash of the current page by downscaling to an NxN
     * grayscale grid and hashing based on average pixel brightness.
     *
     * Uses page.evaluate() to render the screenshot into a canvas element in
     * the browser, downsample, and extract grayscale pixel values. This avoids
     * any external image processing dependency.
     */
    private async computePerceptualHash(
        page: Page,
        hashSize: number,
        clip?: { x: number; y: number; width: number; height: number }
    ): Promise<string> {
        // Take screenshot as base64, then process in browser via canvas
        const screenshotBuffer = await page.screenshot({
            fullPage: !clip,
            type: 'png',
            ...(clip ? { clip, fullPage: false } : {})
        });
        const base64 = screenshotBuffer.toString('base64');

        const grayscalePixels: number[] = await page.evaluate(
            async ({ imgBase64, size }) => {
                return new Promise<number[]>((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = size;
                        canvas.height = size;
                        const ctx = canvas.getContext('2d');
                        if (!ctx) {
                            reject(new Error('Failed to get canvas 2d context'));
                            return;
                        }
                        // Draw the screenshot downscaled to hashSize x hashSize
                        ctx.drawImage(img, 0, 0, size, size);
                        const imageData = ctx.getImageData(0, 0, size, size);
                        const pixels: number[] = [];
                        for (let i = 0; i < imageData.data.length; i += 4) {
                            const r = imageData.data[i];
                            const g = imageData.data[i + 1];
                            const b = imageData.data[i + 2];
                            // Standard luminance formula
                            pixels.push(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
                        }
                        resolve(pixels);
                    };
                    img.onerror = () => reject(new Error('Failed to load screenshot image'));
                    img.src = `data:image/png;base64,${imgBase64}`;
                });
            },
            { imgBase64: base64, size: hashSize }
        );

        // Compute average
        const avg = grayscalePixels.reduce((sum, v) => sum + v, 0) / grayscalePixels.length;

        // Generate binary hash: 1 if above average, 0 if below
        const hashBits = grayscalePixels.map(p => (p >= avg ? '1' : '0'));
        return hashBits.join('');
    }

    /**
     * Calculate Hamming distance between two binary hash strings.
     */
    private hammingDistance(hash1: string, hash2: string): number {
        const len = Math.max(hash1.length, hash2.length);
        let distance = 0;
        for (let i = 0; i < len; i++) {
            if ((hash1[i] || '0') !== (hash2[i] || '0')) {
                distance++;
            }
        }
        return distance;
    }

    // =========================================================================
    // 2. STRUCTURAL COMPARISON (LAYOUT-AWARE)
    // =========================================================================

    /**
     * Compares DOM structure and layout positions against a baseline.
     * Uses aria snapshots for semantic comparison and bounding boxes for
     * layout change detection.
     *
     * @param page - Playwright Page instance
     * @param snapshotName - Name for the snapshot baseline
     * @param options - Structural comparison options
     * @returns Object with passed status, ariaChanges, and layoutChanges
     */
    public async compareStructural(
        page: Page,
        snapshotName: string,
        options?: StructuralComparisonOptions & { fullPage?: boolean }
    ): Promise<{ passed: boolean; ariaChanges: string[]; layoutChanges: LayoutChange[]; message: string }> {
        if (!this.enabled) {
            return { passed: true, ariaChanges: [], layoutChanges: [], message: 'Visual AI testing is disabled' };
        }

        CSReporter.startStep(`Structural comparison: ${snapshotName}`);

        try {
            const tolerance = options?.layoutTolerance ?? this.layoutTolerance;
            const ignoreRoles = options?.ignoreRoles || [];

            // Capture current aria snapshot
            const currentAriaSnapshot = await page.locator('body').ariaSnapshot();

            // Capture current layout (bounding boxes of interactive elements)
            const currentLayout = await this.captureLayoutElements(page, ignoreRoles);

            // Save actual structural data
            const actualStructPath = path.join(this.actualDir, `${snapshotName}.structural.json`);
            const actualData: StructuralBaseline = {
                ariaSnapshot: currentAriaSnapshot,
                layoutElements: currentLayout,
                timestamp: new Date().toISOString()
            };
            fs.writeFileSync(actualStructPath, JSON.stringify(actualData, null, 2));

            // Save aria snapshot as YAML-like file for readability
            const actualAriaPath = path.join(this.actualDir, `${snapshotName}.aria.yaml`);
            fs.writeFileSync(actualAriaPath, currentAriaSnapshot);

            // Check baseline
            const baselineStructPath = path.join(this.baselineDir, `${snapshotName}.structural.json`);
            const baselineAriaPath = path.join(this.baselineDir, `${snapshotName}.aria.yaml`);

            if (!fs.existsSync(baselineStructPath)) {
                // Create baseline
                fs.writeFileSync(baselineStructPath, JSON.stringify(actualData, null, 2));
                fs.writeFileSync(baselineAriaPath, currentAriaSnapshot);
                CSReporter.warn(`Structural baseline created for: ${snapshotName}`);
                CSReporter.endStep('pass');
                return { passed: true, ariaChanges: [], layoutChanges: [], message: 'Baseline created' };
            }

            // Load baseline
            const baselineData: StructuralBaseline = JSON.parse(fs.readFileSync(baselineStructPath, 'utf-8'));

            // Compare aria snapshots (line-by-line diff)
            const ariaChanges = this.compareAriaSnapshots(baselineData.ariaSnapshot, currentAriaSnapshot);

            // Compare layout positions
            const layoutChanges = options?.ignorePositionChanges
                ? []
                : this.compareLayouts(baselineData.layoutElements, currentLayout, tolerance);

            const passed = ariaChanges.length === 0 && layoutChanges.length === 0;

            const changeSummary: string[] = [];
            if (ariaChanges.length > 0) {
                changeSummary.push(`${ariaChanges.length} aria change(s)`);
            }
            if (layoutChanges.length > 0) {
                changeSummary.push(`${layoutChanges.length} layout change(s)`);
            }

            const message = passed
                ? `Structural comparison passed for: ${snapshotName}`
                : `Structural comparison failed for: ${snapshotName} — ${changeSummary.join(', ')}`;

            // Save diff report
            if (!passed) {
                const diffReport = {
                    snapshotName,
                    ariaChanges,
                    layoutChanges,
                    timestamp: new Date().toISOString()
                };
                const diffPath = path.join(this.diffDir, `${snapshotName}.structural-diff.json`);
                fs.writeFileSync(diffPath, JSON.stringify(diffReport, null, 2));
            }

            if (passed) {
                CSReporter.pass(message);
                CSReporter.endStep('pass');
            } else {
                CSReporter.fail(message);
                // Log individual changes
                for (const change of ariaChanges) {
                    CSReporter.info(`  Aria: ${change}`);
                }
                for (const change of layoutChanges) {
                    const desc = this.describeLayoutChange(change);
                    CSReporter.info(`  Layout: ${desc}`);
                }
                CSReporter.endStep('fail');
            }

            return { passed, ariaChanges, layoutChanges, message };
        } catch (error: any) {
            CSReporter.fail(`Structural comparison error: ${error.message}`);
            CSReporter.endStep('fail');
            throw error;
        }
    }

    /**
     * Capture bounding boxes and identifiers for interactive elements on the page.
     */
    private async captureLayoutElements(page: Page, ignoreRoles: string[]): Promise<LayoutElementInfo[]> {
        const elements: LayoutElementInfo[] = await page.evaluate((rolesToIgnore) => {
            const interactiveSelectors = [
                'button', 'a', 'input', 'select', 'textarea',
                '[role="button"]', '[role="link"]', '[role="tab"]',
                '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]',
                '[role="switch"]', '[role="slider"]', '[role="textbox"]',
                '[role="combobox"]', '[role="listbox"]', '[role="dialog"]',
                '[role="navigation"]', '[role="main"]', '[role="banner"]',
                '[role="contentinfo"]', 'h1', 'h2', 'h3', 'nav', 'header', 'footer'
            ];

            const results: Array<{
                selector: string;
                role: string;
                name: string;
                boundingBox: { x: number; y: number; width: number; height: number };
            }> = [];
            const seen = new Set<Element>();

            for (const sel of interactiveSelectors) {
                const els = document.querySelectorAll(sel);
                els.forEach(el => {
                    if (seen.has(el)) return;
                    seen.add(el);

                    const role = el.getAttribute('role') || el.tagName.toLowerCase();
                    if (rolesToIgnore.includes(role)) return;

                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 && rect.height === 0) return;

                    const name =
                        el.getAttribute('aria-label') ||
                        el.getAttribute('title') ||
                        (el as HTMLElement).innerText?.substring(0, 50)?.trim() ||
                        el.getAttribute('name') ||
                        '';

                    results.push({
                        selector: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`,
                        role,
                        name,
                        boundingBox: {
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        }
                    });
                });
            }

            return results;
        }, ignoreRoles);

        return elements;
    }

    /**
     * Compare two aria snapshot strings line by line.
     * Returns a list of human-readable change descriptions.
     */
    private compareAriaSnapshots(baseline: string, current: string): string[] {
        const baselineLines = baseline.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const currentLines = current.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const changes: string[] = [];

        const baselineSet = new Set(baselineLines);
        const currentSet = new Set(currentLines);

        // Lines removed from baseline
        for (const line of baselineLines) {
            if (!currentSet.has(line)) {
                changes.push(`Removed: "${line}"`);
            }
        }

        // Lines added in current
        for (const line of currentLines) {
            if (!baselineSet.has(line)) {
                changes.push(`Added: "${line}"`);
            }
        }

        return changes;
    }

    /**
     * Compare layout element positions between baseline and current captures.
     * Detects moved, resized, added, and removed elements.
     */
    private compareLayouts(
        baseline: LayoutElementInfo[],
        current: LayoutElementInfo[],
        tolerance: number
    ): LayoutChange[] {
        const changes: LayoutChange[] = [];

        // Build maps keyed by role+name for matching
        const baseMap = new Map<string, LayoutElementInfo>();
        for (const el of baseline) {
            const key = `${el.role}::${el.name}`;
            if (!baseMap.has(key)) {
                baseMap.set(key, el);
            }
        }

        const currMap = new Map<string, LayoutElementInfo>();
        for (const el of current) {
            const key = `${el.role}::${el.name}`;
            if (!currMap.has(key)) {
                currMap.set(key, el);
            }
        }

        // Check for moved/resized elements
        for (const [key, baseEl] of baseMap) {
            const currEl = currMap.get(key);
            if (!currEl) {
                changes.push({
                    element: `${baseEl.role} '${baseEl.name}'`,
                    type: 'removed',
                    before: baseEl.boundingBox
                });
                continue;
            }

            const bb = baseEl.boundingBox;
            const cb = currEl.boundingBox;

            const positionMoved =
                Math.abs(bb.x - cb.x) > tolerance ||
                Math.abs(bb.y - cb.y) > tolerance;

            const sizeChanged =
                Math.abs(bb.width - cb.width) > tolerance ||
                Math.abs(bb.height - cb.height) > tolerance;

            if (positionMoved && sizeChanged) {
                changes.push({
                    element: `${baseEl.role} '${baseEl.name}'`,
                    type: 'moved',
                    before: bb,
                    after: cb
                });
                changes.push({
                    element: `${baseEl.role} '${baseEl.name}'`,
                    type: 'resized',
                    before: bb,
                    after: cb
                });
            } else if (positionMoved) {
                changes.push({
                    element: `${baseEl.role} '${baseEl.name}'`,
                    type: 'moved',
                    before: bb,
                    after: cb
                });
            } else if (sizeChanged) {
                changes.push({
                    element: `${baseEl.role} '${baseEl.name}'`,
                    type: 'resized',
                    before: bb,
                    after: cb
                });
            }
        }

        // Check for added elements
        for (const [key, currEl] of currMap) {
            if (!baseMap.has(key)) {
                changes.push({
                    element: `${currEl.role} '${currEl.name}'`,
                    type: 'added',
                    after: currEl.boundingBox
                });
            }
        }

        return changes;
    }

    /**
     * Generate a human-readable description for a layout change.
     */
    private describeLayoutChange(change: LayoutChange): string {
        switch (change.type) {
            case 'moved':
                return `${change.element} moved from (${change.before!.x},${change.before!.y}) to (${change.after!.x},${change.after!.y})`;
            case 'resized':
                return `${change.element} resized from ${change.before!.width}x${change.before!.height} to ${change.after!.width}x${change.after!.height}`;
            case 'added':
                return `${change.element} added at (${change.after!.x},${change.after!.y})`;
            case 'removed':
                return `${change.element} removed (was at ${change.before!.x},${change.before!.y})`;
            default:
                return `${change.element}: ${change.type}`;
        }
    }

    // =========================================================================
    // 3. COMBINED SMART COMPARISON
    // =========================================================================

    /**
     * Runs all three comparison strategies (pixel hash, perceptual hash,
     * structural) and returns a combined verdict.
     *
     * Verdict logic:
     * - Pixel passes => 'identical'
     * - Pixel fails, perceptual passes => 'cosmetic_only' (sub-pixel rendering)
     * - Perceptual fails, structural passes => 'visual_change' (style change, structure intact)
     * - Structural fails => 'structural_change' (DOM/layout changed)
     */
    public async compareSmartVisual(
        page: Page,
        snapshotName: string,
        options?: SmartVisualOptions
    ): Promise<SmartVisualResult> {
        if (!this.enabled) {
            return {
                passed: true,
                verdict: 'identical',
                pixelResult: { passed: true, diffPercentage: 0 },
                perceptualResult: { passed: true, hammingDistance: 0, maxDistance: 64 },
                structuralResult: { passed: true, ariaChanges: [], layoutChanges: [] },
                message: 'Visual AI testing is disabled',
                recommendations: []
            };
        }

        CSReporter.startStep(`Smart visual comparison: ${snapshotName}`);

        try {
            // Update baselines if requested
            if (options?.updateBaseline) {
                await this.updateSmartBaseline(page, snapshotName, options);
                CSReporter.endStep('pass');
                return {
                    passed: true,
                    verdict: 'identical',
                    pixelResult: { passed: true, diffPercentage: 0 },
                    perceptualResult: { passed: true, hammingDistance: 0, maxDistance: 64 },
                    structuralResult: { passed: true, ariaChanges: [], layoutChanges: [] },
                    message: 'Baselines updated',
                    recommendations: []
                };
            }

            // Run pixel comparison (simple hash-based check like existing CSVisualTesting)
            const pixelResult = await this.comparePixelHash(page, snapshotName, options);

            // Run perceptual hash comparison
            const perceptualResult = await this.comparePerceptual(page, snapshotName, {
                hashSize: options?.perceptual?.hashSize,
                threshold: options?.perceptual?.threshold,
                fullPage: options?.fullPage
            });

            // Run structural comparison
            const structuralResult = await this.compareStructural(page, snapshotName, {
                ignorePositionChanges: options?.structural?.ignorePositionChanges,
                layoutTolerance: options?.structural?.layoutTolerance,
                ignoreRoles: options?.structural?.ignoreRoles,
                fullPage: options?.fullPage
            });

            // Determine verdict
            let verdict: SmartVisualResult['verdict'];
            let passed: boolean;
            let message: string;
            const recommendations: string[] = [];

            if (pixelResult.passed) {
                verdict = 'identical';
                passed = true;
                message = `Page '${snapshotName}' is visually identical to baseline`;
            } else if (perceptualResult.passed) {
                verdict = 'cosmetic_only';
                passed = true;
                message = `Page '${snapshotName}' has cosmetic-only differences (anti-aliasing, font rendering). Pixel diff: ${pixelResult.diffPercentage.toFixed(2)}%`;
                recommendations.push('Cosmetic differences detected — likely sub-pixel rendering. Consider updating pixel baseline if this is expected.');
            } else if (structuralResult.passed) {
                verdict = 'visual_change';
                passed = false;
                message = `Page '${snapshotName}' has visual changes but DOM structure is intact. Perceptual distance: ${perceptualResult.hammingDistance}/${perceptualResult.maxDistance}`;
                recommendations.push('Visual styling has changed but page structure is the same. This may be a CSS/theme change.');
                recommendations.push('Run with updateBaseline: true if the visual change is intentional.');
            } else {
                verdict = 'structural_change';
                passed = false;
                message = `Page '${snapshotName}' has structural changes. ${structuralResult.ariaChanges.length} aria change(s), ${structuralResult.layoutChanges.length} layout change(s)`;
                recommendations.push('Page structure has changed — elements may have been added, removed, or repositioned.');
                if (structuralResult.ariaChanges.length > 0) {
                    recommendations.push(`Aria changes: ${structuralResult.ariaChanges.slice(0, 3).join('; ')}`);
                }
                if (structuralResult.layoutChanges.length > 0) {
                    const descs = structuralResult.layoutChanges.slice(0, 3).map(c => this.describeLayoutChange(c));
                    recommendations.push(`Layout changes: ${descs.join('; ')}`);
                }
            }

            const result: SmartVisualResult = {
                passed,
                verdict,
                pixelResult: { passed: pixelResult.passed, diffPercentage: pixelResult.diffPercentage },
                perceptualResult: {
                    passed: perceptualResult.passed,
                    hammingDistance: perceptualResult.hammingDistance,
                    maxDistance: perceptualResult.maxDistance
                },
                structuralResult: {
                    passed: structuralResult.passed,
                    ariaChanges: structuralResult.ariaChanges,
                    layoutChanges: structuralResult.layoutChanges
                },
                message,
                recommendations
            };

            // Save combined result
            const resultPath = path.join(this.diffDir, `${snapshotName}.smart-result.json`);
            fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

            if (passed) {
                CSReporter.pass(message);
                CSReporter.endStep('pass');
            } else {
                CSReporter.fail(message);
                for (const rec of recommendations) {
                    CSReporter.info(`  Recommendation: ${rec}`);
                }
                CSReporter.endStep('fail');
            }

            return result;
        } catch (error: any) {
            CSReporter.fail(`Smart visual comparison error: ${error.message}`);
            CSReporter.endStep('fail');
            throw error;
        }
    }

    /**
     * Simple pixel-level hash comparison using SHA-256 of the screenshot buffer.
     * This provides a quick identical/not-identical check without full pixel diff.
     */
    private async comparePixelHash(
        page: Page,
        snapshotName: string,
        options?: SmartVisualOptions
    ): Promise<{ passed: boolean; diffPercentage: number }> {
        const screenshotBuffer = await page.screenshot({
            fullPage: options?.fullPage !== false,
            type: 'png'
        });

        const currentHash = crypto.createHash('sha256').update(screenshotBuffer).digest('hex');

        // Save actual screenshot
        const actualPath = path.join(this.actualDir, `${snapshotName}.png`);
        fs.writeFileSync(actualPath, screenshotBuffer);

        // Check baseline
        const baselineHashPath = path.join(this.baselineDir, `${snapshotName}.pixel-hash`);
        const baselinePngPath = path.join(this.baselineDir, `${snapshotName}.png`);

        if (!fs.existsSync(baselineHashPath)) {
            // Create baseline
            fs.writeFileSync(baselineHashPath, currentHash);
            fs.writeFileSync(baselinePngPath, screenshotBuffer);
            return { passed: true, diffPercentage: 0 };
        }

        const baselineHash = fs.readFileSync(baselineHashPath, 'utf-8').trim();
        const passed = currentHash === baselineHash;

        // If not identical, estimate diff percentage using byte-level comparison
        let diffPercentage = 0;
        if (!passed && fs.existsSync(baselinePngPath)) {
            const baselineBuffer = fs.readFileSync(baselinePngPath);
            const minLen = Math.min(baselineBuffer.length, screenshotBuffer.length);
            let diffBytes = Math.abs(baselineBuffer.length - screenshotBuffer.length);
            for (let i = 0; i < minLen; i++) {
                if (baselineBuffer[i] !== screenshotBuffer[i]) {
                    diffBytes++;
                }
            }
            const maxLen = Math.max(baselineBuffer.length, screenshotBuffer.length);
            diffPercentage = maxLen > 0 ? (diffBytes / maxLen) * 100 : 0;
        }

        return { passed, diffPercentage };
    }

    // =========================================================================
    // 4. REGION-BASED COMPARISON
    // =========================================================================

    /**
     * Compare only a specific region of the page identified by a CSS selector.
     * Gets the element's bounding box and clips the comparison to that region.
     *
     * @param page - Playwright Page instance
     * @param snapshotName - Name for the snapshot baseline
     * @param regionSelector - CSS selector for the region to compare
     * @param options - Smart visual options
     */
    public async compareRegion(
        page: Page,
        snapshotName: string,
        regionSelector: string,
        options?: SmartVisualOptions
    ): Promise<SmartVisualResult> {
        CSReporter.startStep(`Region comparison: ${snapshotName} (${regionSelector})`);

        try {
            const element = page.locator(regionSelector);
            await element.waitFor({ state: 'visible', timeout: options?.timeout || 10000 });

            const boundingBox = await element.boundingBox();
            if (!boundingBox) {
                throw new Error(`Element '${regionSelector}' has no bounding box (not visible or zero size)`);
            }

            // Use the region name to avoid conflicts with full-page baselines
            const regionName = `${snapshotName}_region_${regionSelector.replace(/[^a-zA-Z0-9]/g, '_')}`;

            // Run perceptual comparison with clip
            const perceptualResult = await this.comparePerceptual(page, regionName, {
                hashSize: options?.perceptual?.hashSize,
                threshold: options?.perceptual?.threshold,
                clip: {
                    x: boundingBox.x,
                    y: boundingBox.y,
                    width: boundingBox.width,
                    height: boundingBox.height
                }
            });

            // Run structural comparison for the region (uses full page aria but limited scope)
            const structuralResult = await this.compareStructural(page, regionName, {
                ignorePositionChanges: options?.structural?.ignorePositionChanges,
                layoutTolerance: options?.structural?.layoutTolerance,
                ignoreRoles: options?.structural?.ignoreRoles
            });

            // Run pixel hash for the region
            const regionScreenshot = await page.screenshot({
                type: 'png',
                clip: {
                    x: boundingBox.x,
                    y: boundingBox.y,
                    width: boundingBox.width,
                    height: boundingBox.height
                }
            });
            const regionHash = crypto.createHash('sha256').update(regionScreenshot).digest('hex');

            const baselineHashPath = path.join(this.baselineDir, `${regionName}.pixel-hash`);
            let pixelPassed = true;
            let diffPercentage = 0;

            if (!fs.existsSync(baselineHashPath)) {
                fs.writeFileSync(baselineHashPath, regionHash);
                fs.writeFileSync(path.join(this.baselineDir, `${regionName}.png`), regionScreenshot);
            } else {
                const baselineHash = fs.readFileSync(baselineHashPath, 'utf-8').trim();
                pixelPassed = regionHash === baselineHash;
                if (!pixelPassed) {
                    diffPercentage = 1.0; // Simplified — not identical
                }
            }

            // Determine verdict using same logic as compareSmartVisual
            let verdict: SmartVisualResult['verdict'];
            let passed: boolean;
            let message: string;
            const recommendations: string[] = [];

            if (pixelPassed) {
                verdict = 'identical';
                passed = true;
                message = `Region '${regionSelector}' in '${snapshotName}' is identical`;
            } else if (perceptualResult.passed) {
                verdict = 'cosmetic_only';
                passed = true;
                message = `Region '${regionSelector}' has cosmetic-only changes`;
            } else if (structuralResult.passed) {
                verdict = 'visual_change';
                passed = false;
                message = `Region '${regionSelector}' has visual changes, structure intact`;
                recommendations.push('Visual changes detected in the specified region.');
            } else {
                verdict = 'structural_change';
                passed = false;
                message = `Region '${regionSelector}' has structural changes`;
                recommendations.push('Structural changes detected in the specified region.');
            }

            const result: SmartVisualResult = {
                passed,
                verdict,
                pixelResult: { passed: pixelPassed, diffPercentage },
                perceptualResult: {
                    passed: perceptualResult.passed,
                    hammingDistance: perceptualResult.hammingDistance,
                    maxDistance: perceptualResult.maxDistance
                },
                structuralResult: {
                    passed: structuralResult.passed,
                    ariaChanges: structuralResult.ariaChanges,
                    layoutChanges: structuralResult.layoutChanges
                },
                message,
                recommendations
            };

            if (passed) {
                CSReporter.pass(message);
                CSReporter.endStep('pass');
            } else {
                CSReporter.fail(message);
                CSReporter.endStep('fail');
            }

            return result;
        } catch (error: any) {
            CSReporter.fail(`Region comparison error: ${error.message}`);
            CSReporter.endStep('fail');
            throw error;
        }
    }

    // =========================================================================
    // 5. BASELINE MANAGEMENT
    // =========================================================================

    /**
     * Update all baseline types (pixel hash, perceptual hash, structural)
     * for a given snapshot name.
     */
    public async updateSmartBaseline(
        page: Page,
        snapshotName: string,
        options?: SmartVisualOptions
    ): Promise<void> {
        CSReporter.startStep(`Updating smart baselines: ${snapshotName}`);

        try {
            const hashSize = options?.perceptual?.hashSize || 8;
            const ignoreRoles = options?.structural?.ignoreRoles || [];

            // 1. Pixel hash baseline
            const screenshotBuffer = await page.screenshot({
                fullPage: options?.fullPage !== false,
                type: 'png'
            });
            const pixelHash = crypto.createHash('sha256').update(screenshotBuffer).digest('hex');
            fs.writeFileSync(path.join(this.baselineDir, `${snapshotName}.pixel-hash`), pixelHash);
            fs.writeFileSync(path.join(this.baselineDir, `${snapshotName}.png`), screenshotBuffer);

            // 2. Perceptual hash baseline
            const perceptualHash = await this.computePerceptualHash(page, hashSize);
            const perceptualData: PerceptualBaseline = {
                hash: perceptualHash,
                hashSize,
                timestamp: new Date().toISOString()
            };
            fs.writeFileSync(
                path.join(this.baselineDir, `${snapshotName}.phash`),
                JSON.stringify(perceptualData, null, 2)
            );

            // 3. Structural baseline (aria snapshot + layout)
            const ariaSnapshot = await page.locator('body').ariaSnapshot();
            const layoutElements = await this.captureLayoutElements(page, ignoreRoles);
            const structuralData: StructuralBaseline = {
                ariaSnapshot,
                layoutElements,
                timestamp: new Date().toISOString()
            };
            fs.writeFileSync(
                path.join(this.baselineDir, `${snapshotName}.structural.json`),
                JSON.stringify(structuralData, null, 2)
            );
            fs.writeFileSync(
                path.join(this.baselineDir, `${snapshotName}.aria.yaml`),
                ariaSnapshot
            );

            CSReporter.pass(`Smart baselines updated for: ${snapshotName}`);
            CSReporter.endStep('pass');
        } catch (error: any) {
            CSReporter.fail(`Failed to update smart baselines: ${error.message}`);
            CSReporter.endStep('fail');
            throw error;
        }
    }

    // =========================================================================
    // UTILITY
    // =========================================================================

    /**
     * Check whether a smart visual change is cosmetic only (no structural changes).
     * Useful for assertions like "any visual changes should be cosmetic only".
     */
    public async assertCosmeticOnly(
        page: Page,
        snapshotName: string,
        options?: SmartVisualOptions
    ): Promise<SmartVisualResult> {
        const result = await this.compareSmartVisual(page, snapshotName, options);

        if (result.verdict === 'structural_change') {
            throw new Error(
                `Expected cosmetic-only changes for '${snapshotName}', but structural changes were detected: ${result.message}`
            );
        }

        return result;
    }

    /**
     * Reset the singleton instance (useful for testing).
     */
    public static resetInstance(): void {
        CSVisualAITesting.instance = undefined as any;
    }
}
