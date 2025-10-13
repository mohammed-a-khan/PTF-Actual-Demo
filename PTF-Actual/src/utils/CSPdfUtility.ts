// src/utils/CSPdfUtility.ts

import { Browser, Page, chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Comprehensive PDF Utility Class
 * Leverages Playwright's PDF generation capabilities and provides extensive PDF operations
 */
export class CSPdfUtility {

    // ===============================
    // PDF GENERATION (PLAYWRIGHT)
    // ===============================

    /**
     * Generate PDF from HTML content using Playwright
     */
    static async generateFromHTML(htmlContent: string, outputPath: string, options?: {
        format?: 'A4' | 'Letter' | 'Legal' | 'Tabloid' | 'Ledger' | 'A3' | 'A5';
        width?: string | number;
        height?: string | number;
        landscape?: boolean;
        margin?: { top?: string; right?: string; bottom?: string; left?: string };
        printBackground?: boolean;
        scale?: number;
        displayHeaderFooter?: boolean;
        headerTemplate?: string;
        footerTemplate?: string;
        tagged?: boolean;
    }): Promise<void> {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        try {
            await page.setContent(htmlContent);
            await page.pdf({
                path: outputPath,
                format: options?.format || 'A4',
                width: options?.width,
                height: options?.height,
                landscape: options?.landscape || false,
                margin: options?.margin,
                printBackground: options?.printBackground !== false,
                scale: options?.scale || 1,
                displayHeaderFooter: options?.displayHeaderFooter || false,
                headerTemplate: options?.headerTemplate,
                footerTemplate: options?.footerTemplate,
                tagged: options?.tagged || false
            });
        } finally {
            await browser.close();
        }
    }

    /**
     * Generate PDF from URL using Playwright
     */
    static async generateFromURL(url: string, outputPath: string, options?: {
        format?: 'A4' | 'Letter' | 'Legal' | 'Tabloid' | 'Ledger' | 'A3' | 'A5';
        width?: string | number;
        height?: string | number;
        landscape?: boolean;
        margin?: { top?: string; right?: string; bottom?: string; left?: string };
        printBackground?: boolean;
        scale?: number;
        displayHeaderFooter?: boolean;
        headerTemplate?: string;
        footerTemplate?: string;
        waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
        timeout?: number;
        tagged?: boolean;
    }): Promise<void> {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        try {
            await page.goto(url, {
                waitUntil: options?.waitUntil || 'networkidle',
                timeout: options?.timeout || 30000
            });

            await page.pdf({
                path: outputPath,
                format: options?.format || 'A4',
                width: options?.width,
                height: options?.height,
                landscape: options?.landscape || false,
                margin: options?.margin,
                printBackground: options?.printBackground !== false,
                scale: options?.scale || 1,
                displayHeaderFooter: options?.displayHeaderFooter || false,
                headerTemplate: options?.headerTemplate,
                footerTemplate: options?.footerTemplate,
                tagged: options?.tagged || false
            });
        } finally {
            await browser.close();
        }
    }

    /**
     * Generate PDF from HTML file
     */
    static async generateFromHTMLFile(htmlFilePath: string, outputPath: string, options?: {
        format?: 'A4' | 'Letter' | 'Legal' | 'Tabloid' | 'Ledger' | 'A3' | 'A5';
        width?: string | number;
        height?: string | number;
        landscape?: boolean;
        margin?: { top?: string; right?: string; bottom?: string; left?: string };
        printBackground?: boolean;
        scale?: number;
        displayHeaderFooter?: boolean;
        headerTemplate?: string;
        footerTemplate?: string;
        tagged?: boolean;
    }): Promise<void> {
        if (!fs.existsSync(htmlFilePath)) {
            throw new Error(`HTML file not found: ${htmlFilePath}`);
        }

        const htmlContent = fs.readFileSync(htmlFilePath, 'utf8');
        await this.generateFromHTML(htmlContent, outputPath, options);
    }

    /**
     * Generate PDF with custom page using existing browser context
     */
    static async generateFromPage(page: Page, outputPath: string, options?: {
        format?: 'A4' | 'Letter' | 'Legal' | 'Tabloid' | 'Ledger' | 'A3' | 'A5';
        width?: string | number;
        height?: string | number;
        landscape?: boolean;
        margin?: { top?: string; right?: string; bottom?: string; left?: string };
        printBackground?: boolean;
        scale?: number;
        displayHeaderFooter?: boolean;
        headerTemplate?: string;
        footerTemplate?: string;
        tagged?: boolean;
    }): Promise<Buffer> {
        return await page.pdf({
            path: outputPath,
            format: options?.format || 'A4',
            width: options?.width,
            height: options?.height,
            landscape: options?.landscape || false,
            margin: options?.margin,
            printBackground: options?.printBackground !== false,
            scale: options?.scale || 1,
            displayHeaderFooter: options?.displayHeaderFooter || false,
            headerTemplate: options?.headerTemplate,
            footerTemplate: options?.footerTemplate,
            tagged: options?.tagged || false
        });
    }

    /**
     * Generate PDF with header and footer
     */
    static async generateWithHeaderFooter(htmlContent: string, outputPath: string, options: {
        headerText?: string;
        footerText?: string;
        format?: 'A4' | 'Letter';
        landscape?: boolean;
        margin?: { top?: string; right?: string; bottom?: string; left?: string };
    }): Promise<void> {
        const defaultHeader = `
            <div style="font-size: 10px; text-align: center; width: 100%; margin: 0 auto;">
                ${options.headerText || ''}
            </div>
        `;

        const defaultFooter = `
            <div style="font-size: 10px; text-align: center; width: 100%; margin: 0 auto;">
                <span>${options.footerText || ''}</span>
                <span style="margin-left: 20px;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
            </div>
        `;

        await this.generateFromHTML(htmlContent, outputPath, {
            format: options.format || 'A4',
            landscape: options.landscape || false,
            margin: options.margin || { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
            displayHeaderFooter: true,
            headerTemplate: defaultHeader,
            footerTemplate: defaultFooter,
            printBackground: true
        });
    }

    /**
     * Generate accessible/tagged PDF
     */
    static async generateAccessiblePDF(htmlContent: string, outputPath: string, options?: {
        format?: 'A4' | 'Letter';
        landscape?: boolean;
    }): Promise<void> {
        await this.generateFromHTML(htmlContent, outputPath, {
            format: options?.format || 'A4',
            landscape: options?.landscape || false,
            tagged: true,
            printBackground: true
        });
    }

    // ===============================
    // PDF READING AND EXTRACTION
    // ===============================

    /**
     * Extract text from PDF using Playwright
     */
    static async extractText(pdfPath: string): Promise<string> {
        if (!fs.existsSync(pdfPath)) {
            throw new Error(`PDF file not found: ${pdfPath}`);
        }

        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        try {
            // Load PDF in browser (requires PDF viewer or conversion)
            // Note: Direct PDF text extraction requires additional libraries
            // This is a basic implementation - for production, use pdf-parse or similar
            const pdfBuffer = fs.readFileSync(pdfPath);
            const base64 = pdfBuffer.toString('base64');
            const dataUrl = `data:application/pdf;base64,${base64}`;

            await page.goto(dataUrl);
            await page.waitForTimeout(1000);

            // Extract visible text (limited capability)
            const text = await page.textContent('body');
            return text || '';
        } finally {
            await browser.close();
        }
    }

    /**
     * Read PDF as Buffer
     */
    static readAsBuffer(pdfPath: string): Buffer {
        if (!fs.existsSync(pdfPath)) {
            throw new Error(`PDF file not found: ${pdfPath}`);
        }
        return fs.readFileSync(pdfPath);
    }

    /**
     * Read PDF as Base64 string
     */
    static readAsBase64(pdfPath: string): string {
        const buffer = this.readAsBuffer(pdfPath);
        return buffer.toString('base64');
    }

    // ===============================
    // PDF COMPARISON
    // ===============================

    /**
     * Compare two PDF files (byte-level comparison)
     */
    static comparePDFsBytes(file1: string, file2: string): {
        areEqual: boolean;
        size1: number;
        size2: number;
        sizeDifference: number;
    } {
        const buffer1 = this.readAsBuffer(file1);
        const buffer2 = this.readAsBuffer(file2);

        return {
            areEqual: buffer1.equals(buffer2),
            size1: buffer1.length,
            size2: buffer2.length,
            sizeDifference: Math.abs(buffer1.length - buffer2.length)
        };
    }

    /**
     * Compare two PDF files (text-based comparison)
     */
    static async comparePDFsText(file1: string, file2: string): Promise<{
        areEqual: boolean;
        text1: string;
        text2: string;
        similarity: number;
    }> {
        const text1 = await this.extractText(file1);
        const text2 = await this.extractText(file2);

        const areEqual = text1 === text2;
        const similarity = this.calculateTextSimilarity(text1, text2);

        return {
            areEqual,
            text1,
            text2,
            similarity
        };
    }

    /**
     * Visual comparison of PDFs using screenshots
     */
    static async comparePDFsVisually(file1: string, file2: string, outputDir?: string): Promise<{
        areEqual: boolean;
        differences: Array<{ page: number; isDifferent: boolean }>;
    }> {
        const browser = await chromium.launch({ headless: true });

        try {
            const page1 = await browser.newPage();
            const page2 = await browser.newPage();

            const pdf1Buffer = this.readAsBuffer(file1);
            const pdf2Buffer = this.readAsBuffer(file2);

            const dataUrl1 = `data:application/pdf;base64,${pdf1Buffer.toString('base64')}`;
            const dataUrl2 = `data:application/pdf;base64,${pdf2Buffer.toString('base64')}`;

            await page1.goto(dataUrl1);
            await page2.goto(dataUrl2);

            const screenshot1 = await page1.screenshot();
            const screenshot2 = await page2.screenshot();

            await page1.close();
            await page2.close();

            const areEqual = screenshot1.equals(screenshot2);

            if (outputDir && !areEqual) {
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                }
                fs.writeFileSync(path.join(outputDir, 'pdf1_screenshot.png'), screenshot1);
                fs.writeFileSync(path.join(outputDir, 'pdf2_screenshot.png'), screenshot2);
            }

            return {
                areEqual,
                differences: [{ page: 1, isDifferent: !areEqual }]
            };
        } finally {
            await browser.close();
        }
    }

    // ===============================
    // PDF METADATA AND INFO
    // ===============================

    /**
     * Get PDF file metadata
     */
    static getFileMetadata(pdfPath: string): {
        exists: boolean;
        size: number;
        sizeInKB: number;
        sizeInMB: number;
        extension: string;
        filename: string;
        created: Date;
        modified: Date;
    } {
        if (!fs.existsSync(pdfPath)) {
            throw new Error(`PDF file not found: ${pdfPath}`);
        }

        const stats = fs.statSync(pdfPath);

        return {
            exists: true,
            size: stats.size,
            sizeInKB: stats.size / 1024,
            sizeInMB: stats.size / (1024 * 1024),
            extension: path.extname(pdfPath),
            filename: path.basename(pdfPath),
            created: stats.birthtime,
            modified: stats.mtime
        };
    }

    /**
     * Check if file is PDF
     */
    static isPDF(filePath: string): boolean {
        if (!fs.existsSync(filePath)) {
            return false;
        }

        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.pdf') {
            return false;
        }

        // Check PDF magic number
        try {
            const buffer = fs.readFileSync(filePath);
            const header = buffer.toString('utf8', 0, 5);
            return header === '%PDF-';
        } catch {
            return false;
        }
    }

    /**
     * Get PDF version
     */
    static getPDFVersion(pdfPath: string): string | null {
        if (!this.isPDF(pdfPath)) {
            return null;
        }

        try {
            const buffer = fs.readFileSync(pdfPath);
            const header = buffer.toString('utf8', 0, 8);
            const match = header.match(/%PDF-(\d\.\d)/);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    // ===============================
    // PDF UTILITIES
    // ===============================

    /**
     * Clone PDF file
     */
    static cloneFile(sourcePath: string, targetPath: string): void {
        if (!this.isPDF(sourcePath)) {
            throw new Error(`Source file is not a valid PDF: ${sourcePath}`);
        }

        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.copyFileSync(sourcePath, targetPath);
    }

    /**
     * Convert HTML string to PDF Buffer (without saving to disk)
     */
    static async htmlToPDFBuffer(htmlContent: string, options?: {
        format?: 'A4' | 'Letter';
        landscape?: boolean;
        printBackground?: boolean;
    }): Promise<Buffer> {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        try {
            await page.setContent(htmlContent);
            const buffer = await page.pdf({
                format: options?.format || 'A4',
                landscape: options?.landscape || false,
                printBackground: options?.printBackground !== false
            });

            return buffer;
        } finally {
            await browser.close();
        }
    }

    /**
     * Generate PDF from Markdown content
     */
    static async generateFromMarkdown(markdownContent: string, outputPath: string, options?: {
        format?: 'A4' | 'Letter';
        landscape?: boolean;
        cssStyles?: string;
    }): Promise<void> {
        // Basic markdown to HTML conversion (for production, use marked or similar library)
        const htmlContent = this.markdownToHTML(markdownContent, options?.cssStyles);
        await this.generateFromHTML(htmlContent, outputPath, {
            format: options?.format || 'A4',
            landscape: options?.landscape || false,
            printBackground: true
        });
    }

    /**
     * Generate PDF with custom CSS styling
     */
    static async generateWithCustomCSS(htmlContent: string, cssStyles: string, outputPath: string, options?: {
        format?: 'A4' | 'Letter';
        landscape?: boolean;
    }): Promise<void> {
        const styledHTML = `
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="UTF-8">
                    <style>${cssStyles}</style>
                </head>
                <body>
                    ${htmlContent}
                </body>
            </html>
        `;

        await this.generateFromHTML(styledHTML, outputPath, {
            format: options?.format || 'A4',
            landscape: options?.landscape || false,
            printBackground: true
        });
    }

    /**
     * Generate multi-page PDF from array of HTML contents
     */
    static async generateMultiPage(htmlPages: string[], outputPath: string, options?: {
        format?: 'A4' | 'Letter';
        landscape?: boolean;
    }): Promise<void> {
        const combinedHTML = `
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="UTF-8">
                    <style>
                        .page-break { page-break-after: always; }
                    </style>
                </head>
                <body>
                    ${htmlPages.map((html, index) =>
            `<div class="${index < htmlPages.length - 1 ? 'page-break' : ''}">${html}</div>`
        ).join('')}
                </body>
            </html>
        `;

        await this.generateFromHTML(combinedHTML, outputPath, {
            format: options?.format || 'A4',
            landscape: options?.landscape || false,
            printBackground: true
        });
    }

    /**
     * Wait for selector before generating PDF
     */
    static async generateFromURLWithWait(url: string, outputPath: string, waitSelector: string, options?: {
        format?: 'A4' | 'Letter';
        timeout?: number;
    }): Promise<void> {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        try {
            await page.goto(url, { waitUntil: 'networkidle' });
            await page.waitForSelector(waitSelector, { timeout: options?.timeout || 30000 });

            await page.pdf({
                path: outputPath,
                format: options?.format || 'A4',
                printBackground: true
            });
        } finally {
            await browser.close();
        }
    }

    /**
     * Generate PDF with custom viewport size
     */
    static async generateWithViewport(htmlContent: string, outputPath: string, width: number, height: number): Promise<void> {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        try {
            await page.setViewportSize({ width, height });
            await page.setContent(htmlContent);

            await page.pdf({
                path: outputPath,
                width: `${width}px`,
                height: `${height}px`,
                printBackground: true
            });
        } finally {
            await browser.close();
        }
    }

    // ===============================
    // PRIVATE HELPER METHODS
    // ===============================

    private static calculateTextSimilarity(text1: string, text2: string): number {
        if (text1 === text2) return 100;
        if (!text1 || !text2) return 0;

        const longer = text1.length > text2.length ? text1 : text2;
        const shorter = text1.length > text2.length ? text2 : text1;

        if (longer.length === 0) return 100;

        const editDistance = this.levenshteinDistance(longer, shorter);
        return ((longer.length - editDistance) / longer.length) * 100;
    }

    private static levenshteinDistance(str1: string, str2: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[str2.length][str1.length];
    }

    private static markdownToHTML(markdown: string, cssStyles?: string): string {
        // Basic markdown to HTML conversion (replace with 'marked' library for production)
        let html = markdown
            .replace(/^### (.*$)/gim, '<h3>$1</h3>')
            .replace(/^## (.*$)/gim, '<h2>$1</h2>')
            .replace(/^# (.*$)/gim, '<h1>$1</h1>')
            .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
            .replace(/\*(.*)\*/gim, '<em>$1</em>')
            .replace(/\n/gim, '<br>');

        return `
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="UTF-8">
                    <style>
                        body { font-family: Arial, sans-serif; padding: 20px; }
                        ${cssStyles || ''}
                    </style>
                </head>
                <body>
                    ${html}
                </body>
            </html>
        `;
    }
}
