import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import { CSReporter } from './CSReporter';

/**
 * CS PDF Report Generator
 * Generates professional PDF reports from HTML reports using Playwright
 */
export class CSPdfReportGenerator {

    public static async generateReport(htmlReportPath: string, outputDir: string): Promise<void> {
        try {
            CSReporter.info('📄 Generating PDF report from HTML...');

            // Verify HTML report exists
            if (!fs.existsSync(htmlReportPath)) {
                throw new Error(`HTML report not found: ${htmlReportPath}`);
            }

            // Launch browser
            const browser = await chromium.launch({
                headless: true
            });

            const context = await browser.newContext({
                viewport: { width: 1920, height: 1080 }
            });

            const page = await context.newPage();

            // Load the HTML report
            const htmlContent = fs.readFileSync(htmlReportPath, 'utf8');
            const baseUrl = `file://${path.dirname(htmlReportPath)}/`;

            await page.setContent(htmlContent, {
                waitUntil: 'networkidle',
                timeout: 30000
            });

            // Wait for charts to render
            await page.waitForTimeout(2000);

            // Ensure all charts are visible by switching to dashboard view
            await page.evaluate(() => {
                const dashboardView = document.getElementById('dashboard-view');
                if (dashboardView) {
                    dashboardView.classList.add('active');
                }
            });

            // Wait for chart animations to complete
            await page.waitForTimeout(1500);

            // Generate PDF with professional settings
            const pdfPath = path.join(outputDir, 'test-report.pdf');

            await page.pdf({
                path: pdfPath,
                format: 'A4',
                printBackground: true,
                margin: {
                    top: '20px',
                    right: '20px',
                    bottom: '20px',
                    left: '20px'
                },
                preferCSSPageSize: false,
                displayHeaderFooter: true,
                headerTemplate: `
                    <div style="font-size: 10px; width: 100%; text-align: center; color: #666; padding: 5px;">
                        <span style="font-weight: bold; color: #93186C;">CS Test Automation Report</span>
                    </div>
                `,
                footerTemplate: `
                    <div style="font-size: 9px; width: 100%; text-align: center; color: #666; padding: 5px; border-top: 1px solid #e5e7eb;">
                        <span>Generated on ${new Date().toLocaleString()}</span>
                        <span style="margin-left: 20px;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
                    </div>
                `
            });

            await browser.close();

            CSReporter.info(`✅ PDF report generated: ${pdfPath}`);

        } catch (error) {
            CSReporter.error(`Failed to generate PDF report: ${error}`);
            throw error;
        }
    }

    /**
     * Generate a custom styled PDF report (alternative approach)
     * Creates a PDF-optimized HTML and converts it
     */
    public static async generateCustomPdfReport(
        htmlReportPath: string,
        outputDir: string,
        options?: {
            includeCharts?: boolean;
            includeScreenshots?: boolean;
            orientation?: 'portrait' | 'landscape';
            pageSize?: string;
        }
    ): Promise<void> {
        try {
            CSReporter.info('📄 Generating custom PDF report...');

            const {
                includeCharts = true,
                includeScreenshots = false,
                orientation = 'portrait',
                pageSize = 'A4'
            } = options || {};

            // Verify HTML report exists
            if (!fs.existsSync(htmlReportPath)) {
                throw new Error(`HTML report not found: ${htmlReportPath}`);
            }

            // Launch browser
            const browser = await chromium.launch({
                headless: true
            });

            const context = await browser.newContext({
                viewport: orientation === 'portrait'
                    ? { width: 1240, height: 1754 }  // A4 portrait
                    : { width: 1754, height: 1240 }   // A4 landscape
            });

            const page = await context.newPage();

            // Load the HTML report
            await page.goto(`file://${htmlReportPath}`, {
                waitUntil: 'networkidle',
                timeout: 30000
            });

            // Inject PDF-specific styles
            await page.addStyleTag({
                content: `
                    @media print {
                        body {
                            margin: 0;
                            padding: 20px;
                        }

                        .no-print {
                            display: none !important;
                        }

                        .page-break {
                            page-break-before: always;
                        }

                        .chart-container {
                            page-break-inside: avoid;
                        }

                        table {
                            page-break-inside: avoid;
                        }

                        h1, h2, h3 {
                            page-break-after: avoid;
                        }

                        .kpi-card {
                            page-break-inside: avoid;
                        }

                        /* Hide navigation and interactive elements */
                        nav, .nav-tabs, button, .tab-content:not(.active) {
                            display: none !important;
                        }

                        /* Make dashboard view visible */
                        #dashboard-view {
                            display: block !important;
                        }

                        /* Optimize chart sizes for PDF */
                        canvas {
                            max-width: 100% !important;
                            height: auto !important;
                        }
                    }
                `
            });

            // Hide screenshots if not needed
            if (!includeScreenshots) {
                await page.evaluate(() => {
                    const screenshots = document.querySelectorAll('img[src*="screenshot"]');
                    screenshots.forEach(img => {
                        const parent = img.parentElement;
                        if (parent) parent.style.display = 'none';
                    });
                });
            }

            // Wait for charts to render
            if (includeCharts) {
                await page.waitForTimeout(2000);
            }

            // Generate PDF
            const pdfPath = path.join(outputDir, 'test-report-custom.pdf');

            await page.pdf({
                path: pdfPath,
                format: pageSize as any,
                landscape: orientation === 'landscape',
                printBackground: true,
                margin: {
                    top: '15mm',
                    right: '10mm',
                    bottom: '15mm',
                    left: '10mm'
                },
                displayHeaderFooter: true,
                headerTemplate: `
                    <div style="font-size: 10px; width: 100%; text-align: center; color: #666; margin-top: 5px;">
                        <span style="font-weight: bold; color: #93186C;">CS Test Automation Framework - Execution Report</span>
                    </div>
                `,
                footerTemplate: `
                    <div style="font-size: 9px; width: 100%; display: flex; justify-content: space-between; padding: 0 10mm; color: #666; border-top: 1px solid #e5e7eb;">
                        <span style="margin-left: 10px;">Generated: ${new Date().toLocaleString()}</span>
                        <span style="margin-right: 10px;">Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
                    </div>
                `
            });

            await browser.close();

            CSReporter.info(`✅ Custom PDF report generated: ${pdfPath}`);

        } catch (error) {
            CSReporter.error(`Failed to generate custom PDF report: ${error}`);
            throw error;
        }
    }

    /**
     * Generate multiple PDF views (Dashboard, Tests, Failures, etc.)
     */
    public static async generateMultiViewPdfReport(
        htmlReportPath: string,
        outputDir: string
    ): Promise<void> {
        try {
            CSReporter.info('📄 Generating multi-view PDF report...');

            // Verify HTML report exists
            if (!fs.existsSync(htmlReportPath)) {
                throw new Error(`HTML report not found: ${htmlReportPath}`);
            }

            // Launch browser
            const browser = await chromium.launch({
                headless: true
            });

            const context = await browser.newContext({
                viewport: { width: 1920, height: 1080 }
            });

            const page = await context.newPage();

            // Load the HTML report
            await page.goto(`file://${htmlReportPath}`, {
                waitUntil: 'networkidle',
                timeout: 30000
            });

            // Wait for initial load
            await page.waitForTimeout(1500);

            // Views to capture
            const views = [
                { id: 'dashboard-view', name: 'dashboard' },
                { id: 'tests-view', name: 'tests' },
                { id: 'failure-analysis-view', name: 'failure-analysis' },
                { id: 'timeline-view', name: 'timeline' }
            ];

            for (const view of views) {
                // Switch to view
                await page.evaluate((viewId) => {
                    // Hide all views
                    document.querySelectorAll('.view').forEach(v => {
                        v.classList.remove('active');
                        (v as HTMLElement).style.display = 'none';
                    });

                    // Show target view
                    const targetView = document.getElementById(viewId);
                    if (targetView) {
                        targetView.classList.add('active');
                        targetView.style.display = 'block';
                    }
                }, view.id);

                // Wait for view to render
                await page.waitForTimeout(1000);

                // Generate PDF for this view
                const pdfPath = path.join(outputDir, `test-report-${view.name}.pdf`);

                await page.pdf({
                    path: pdfPath,
                    format: 'A4',
                    printBackground: true,
                    margin: {
                        top: '20px',
                        right: '20px',
                        bottom: '20px',
                        left: '20px'
                    },
                    displayHeaderFooter: true,
                    headerTemplate: `
                        <div style="font-size: 10px; width: 100%; text-align: center; color: #666; padding: 5px;">
                            <span style="font-weight: bold; color: #93186C;">CS Test Report - ${view.name.replace('-', ' ').toUpperCase()}</span>
                        </div>
                    `,
                    footerTemplate: `
                        <div style="font-size: 9px; width: 100%; text-align: center; color: #666; padding: 5px;">
                            <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
                        </div>
                    `
                });

                CSReporter.debug(`Generated PDF view: ${view.name}`);
            }

            await browser.close();

            CSReporter.info(`✅ Multi-view PDF reports generated in: ${outputDir}`);

        } catch (error) {
            CSReporter.error(`Failed to generate multi-view PDF report: ${error}`);
            throw error;
        }
    }
}
