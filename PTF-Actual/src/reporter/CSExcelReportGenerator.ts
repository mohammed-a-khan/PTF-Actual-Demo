import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from './CSReporter';

// Lazy load exceljs to avoid requiring it at startup (optional dependency)
let ExcelJS: any = null;
function getExcelJS(): any {
    if (!ExcelJS) {
        try {
            ExcelJS = require('exceljs');
        } catch (error) {
            throw new Error('ExcelJS not installed. Run: npm install exceljs');
        }
    }
    return ExcelJS;
}

// Import shared types
interface TestStep {
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    duration?: number;
    error?: string;
    logs?: string[];
    screenshot?: string;
}

interface TestScenario {
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    feature?: string;
    tags?: string[];
    steps: TestStep[];
    duration?: number;
    startTime?: Date;
    endTime?: Date;
}

interface TestSuite {
    name: string;
    scenarios: TestScenario[];
    startTime: Date;
    endTime: Date;
    duration?: number;
    totalScenarios?: number;
    passedScenarios?: number;
    failedScenarios?: number;
    skippedScenarios?: number;
}

interface ExecutionHistory {
    date: string;
    timestamp?: string;
    totalScenarios: number;
    passedScenarios: number;
    failedScenarios: number;
    skippedScenarios: number;
    duration: number;
    passRate: number;
}

export class CSExcelReportGenerator {
    private static brandColor = '93186C';
    private static successColor = '10B981';
    private static failureColor = 'EF4444';
    private static warningColor = 'F59E0B';
    private static infoColor = '3B82F6';

    public static async generateReport(suite: TestSuite, outputDir: string): Promise<void> {
        try {
            CSReporter.info('📊 Generating Excel report...');

            // Calculate statistics
            const stats = this.calculateStatistics(suite);

            // Load execution history
            const history = this.loadExecutionHistory(outputDir);

            // Create workbook
            const workbook = new (getExcelJS().Workbook)();
            workbook.creator = 'CS Test Automation Framework';
            workbook.created = new Date();
            workbook.modified = new Date();
            workbook.lastPrinted = new Date();

            // Add worksheets
            await this.addDashboardSheet(workbook, suite, stats, history);
            await this.addScenariosSheet(workbook, suite, stats);
            await this.addStepsSheet(workbook, suite, outputDir);
            await this.addFailureAnalysisSheet(workbook, suite, stats);
            await this.addPerformanceSheet(workbook, suite, stats);
            await this.addHistorySheet(workbook, history);
            await this.addSummaryChartsSheet(workbook, stats, history);

            // Save workbook
            const reportPath = path.join(outputDir, 'test-report.xlsx');
            await workbook.xlsx.writeFile(reportPath);

            CSReporter.info(`✅ Excel report generated: ${reportPath}`);
        } catch (error) {
            CSReporter.error(`Failed to generate Excel report: ${error}`);
            throw error;
        }
    }

    private static async addDashboardSheet(
        workbook: any,
        suite: TestSuite,
        stats: any,
        history: ExecutionHistory[]
    ): Promise<void> {
        const sheet = workbook.addWorksheet('📊 Dashboard', {
            properties: { tabColor: { argb: this.brandColor } },
            views: [{ showGridLines: false }]
        });

        // Set column widths
        sheet.columns = [
            { width: 3 },
            { width: 25 },
            { width: 20 },
            { width: 20 },
            { width: 20 },
            { width: 20 },
            { width: 3 }
        ];

        let currentRow = 2;

        // Header
        sheet.mergeCells(`B${currentRow}:F${currentRow}`);
        const titleCell = sheet.getCell(`B${currentRow}`);
        titleCell.value = '🎯 CS PLAYWRIGHT TEST AUTOMATION REPORT';
        titleCell.font = { size: 24, bold: true, color: { argb: this.brandColor } };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
        currentRow += 2;

        // Execution Info
        sheet.mergeCells(`B${currentRow}:F${currentRow}`);
        const infoCell = sheet.getCell(`B${currentRow}`);
        infoCell.value = `Executed: ${new Date().toLocaleString()}`;
        infoCell.font = { size: 12, italic: true };
        infoCell.alignment = { horizontal: 'center' };
        currentRow += 3;

        // KPI Cards Row 1
        this.addKPICard(sheet, `B${currentRow}:C${currentRow + 3}`, 'Total Scenarios', stats.totalScenarios, this.brandColor, '📋');
        this.addKPICard(sheet, `D${currentRow}:E${currentRow + 3}`, 'Pass Rate', stats.passRate, this.successColor, '✅');
        this.addKPICard(sheet, `F${currentRow}:F${currentRow + 3}`, 'Duration', this.formatDuration(suite.duration || 0), this.infoColor, '⏱️');
        currentRow += 5;

        // KPI Cards Row 2
        this.addKPICard(sheet, `B${currentRow}:C${currentRow + 3}`, 'Passed', stats.passedScenarios, this.successColor, '✓');
        this.addKPICard(sheet, `D${currentRow}:E${currentRow + 3}`, 'Failed', stats.failedScenarios, this.failureColor, '✗');
        this.addKPICard(sheet, `F${currentRow}:F${currentRow + 3}`, 'Skipped', stats.skippedScenarios, this.warningColor, '⊘');
        currentRow += 5;

        // Test Steps Summary
        sheet.mergeCells(`B${currentRow}:F${currentRow}`);
        const stepsHeaderCell = sheet.getCell(`B${currentRow}`);
        stepsHeaderCell.value = 'STEP STATISTICS';
        stepsHeaderCell.font = { size: 14, bold: true, color: { argb: 'FFFFFF' } };
        stepsHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.brandColor } };
        stepsHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
        currentRow += 1;

        const stepData = [
            ['Total Steps', stats.totalSteps],
            ['Passed Steps', stats.passedSteps],
            ['Failed Steps', stats.failedSteps],
            ['Skipped Steps', stats.skippedSteps],
            ['Step Pass Rate', stats.stepPassRate]
        ];

        stepData.forEach(([label, value]) => {
            sheet.mergeCells(`B${currentRow}:D${currentRow}`);
            sheet.mergeCells(`E${currentRow}:F${currentRow}`);
            const labelCell = sheet.getCell(`B${currentRow}`);
            const valueCell = sheet.getCell(`E${currentRow}`);

            labelCell.value = label;
            labelCell.font = { bold: true };
            labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F3F4F6' } };
            labelCell.alignment = { horizontal: 'left', vertical: 'middle' };
            labelCell.border = this.getBorder();

            valueCell.value = value;
            valueCell.alignment = { horizontal: 'right', vertical: 'middle' };
            valueCell.border = this.getBorder();

            currentRow += 1;
        });

        currentRow += 2;

        // Features Summary
        if (stats.featureStats && stats.featureStats.size > 0) {
            sheet.mergeCells(`B${currentRow}:F${currentRow}`);
            const featuresHeaderCell = sheet.getCell(`B${currentRow}`);
            featuresHeaderCell.value = 'FEATURES BREAKDOWN';
            featuresHeaderCell.font = { size: 14, bold: true, color: { argb: 'FFFFFF' } };
            featuresHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.brandColor } };
            featuresHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
            currentRow += 1;

            // Headers
            const featureHeaders = ['Feature', 'Total', 'Passed', 'Failed', 'Skipped'];
            featureHeaders.forEach((header, index) => {
                const colLetter = String.fromCharCode(66 + index); // B, C, D, E, F
                const cell = sheet.getCell(`${colLetter}${currentRow}`);
                cell.value = header;
                cell.font = { bold: true, color: { argb: 'FFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '6B7280' } };
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
                cell.border = this.getBorder();
            });
            currentRow += 1;

            // Feature data
            const featureEntries = Array.from(stats.featureStats.entries()) as Array<[string, any]>;
            featureEntries.forEach(([feature, featureData]) => {
                sheet.getCell(`B${currentRow}`).value = feature || 'Unknown';
                sheet.getCell(`C${currentRow}`).value = featureData.total;
                sheet.getCell(`D${currentRow}`).value = featureData.passed;
                sheet.getCell(`E${currentRow}`).value = featureData.failed;
                sheet.getCell(`F${currentRow}`).value = featureData.skipped;

                for (let col = 2; col <= 6; col++) {
                    const cell = sheet.getCell(currentRow, col);
                    cell.border = this.getBorder();
                    // Feature name (column B) left-aligned, others center-aligned
                    cell.alignment = {
                        horizontal: col === 2 ? 'left' : 'center',
                        vertical: 'middle'
                    };
                }
                currentRow += 1;
            });
        }

        // Add visual charts using data bars and formatted tables
        currentRow += 2;

        // TEST STATUS DISTRIBUTION CHART (using data bars)
        sheet.mergeCells(`B${currentRow}:F${currentRow}`);
        const pieChartHeader = sheet.getCell(`B${currentRow}`);
        pieChartHeader.value = '📊 TEST STATUS DISTRIBUTION';
        pieChartHeader.font = { size: 12, bold: true, color: { argb: 'FFFFFF' } };
        pieChartHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.brandColor } };
        pieChartHeader.alignment = { horizontal: 'center', vertical: 'middle' };
        pieChartHeader.border = this.getBorder();
        currentRow += 1;

        // Chart data with visual bars
        const chartData = [
            { status: '✅ Passed', count: stats.passedScenarios, color: this.successColor, percentage: stats.totalScenarios > 0 ? Math.round((stats.passedScenarios / stats.totalScenarios) * 100) : 0 },
            { status: '❌ Failed', count: stats.failedScenarios, color: this.failureColor, percentage: stats.totalScenarios > 0 ? Math.round((stats.failedScenarios / stats.totalScenarios) * 100) : 0 },
            { status: '⊘ Skipped', count: stats.skippedScenarios, color: this.warningColor, percentage: stats.totalScenarios > 0 ? Math.round((stats.skippedScenarios / stats.totalScenarios) * 100) : 0 }
        ];

        chartData.forEach((data) => {
            // Status label
            const labelCell = sheet.getCell(`B${currentRow}`);
            labelCell.value = data.status;
            labelCell.font = { bold: true, size: 11 };
            labelCell.alignment = { horizontal: 'left', vertical: 'middle' };
            labelCell.border = this.getBorder();

            // Count
            const countCell = sheet.getCell(`C${currentRow}`);
            countCell.value = data.count;
            countCell.font = { bold: true, size: 11 };
            countCell.alignment = { horizontal: 'center', vertical: 'middle' };
            countCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: data.color } };
            countCell.font = { bold: true, color: { argb: 'FFFFFF' } };
            countCell.border = this.getBorder();

            // Visual bar (using cells as bar chart)
            const barCell = sheet.getCell(`D${currentRow}`);
            sheet.mergeCells(`D${currentRow}:E${currentRow}`);
            const barWidth = Math.max(1, data.percentage);
            const barRepeat = '█'.repeat(Math.round(barWidth / 5));  // Scale down for display
            barCell.value = `${barRepeat} ${data.percentage}%`;
            barCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: data.color + '40' } };  // Lighter shade
            barCell.font = { bold: true, size: 10, color: { argb: data.color } };
            barCell.alignment = { horizontal: 'left', vertical: 'middle' };
            barCell.border = this.getBorder();

            // Percentage
            const pctCell = sheet.getCell(`F${currentRow}`);
            pctCell.value = `${data.percentage}%`;
            pctCell.font = { bold: true, size: 11 };
            pctCell.alignment = { horizontal: 'center', vertical: 'middle' };
            pctCell.border = this.getBorder();

            currentRow += 1;
        });

        currentRow += 2;

        // FEATURES PERFORMANCE CHART (using data bars)
        if (stats.featureStats && stats.featureStats.size > 0) {
            sheet.mergeCells(`B${currentRow}:F${currentRow}`);
            const barChartHeader = sheet.getCell(`B${currentRow}`);
            barChartHeader.value = '📈 FEATURES PERFORMANCE';
            barChartHeader.font = { size: 12, bold: true, color: { argb: 'FFFFFF' } };
            barChartHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.brandColor } };
            barChartHeader.alignment = { horizontal: 'center', vertical: 'middle' };
            barChartHeader.border = this.getBorder();
            currentRow += 1;

            // Header row
            ['Feature', 'Total', 'Passed', 'Failed', 'Visual'].forEach((header, idx) => {
                const colLetter = String.fromCharCode(66 + idx);  // B, C, D, E, F
                const headerCell = sheet.getCell(`${colLetter}${currentRow}`);
                headerCell.value = header;
                headerCell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
                headerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '6B7280' } };
                headerCell.alignment = { horizontal: 'center', vertical: 'middle' };
                headerCell.border = this.getBorder();
            });
            currentRow += 1;

            const featureEntries = Array.from(stats.featureStats.entries()) as Array<[string, any]>;
            featureEntries.slice(0, 8).forEach(([feature, data]) => {
                // Feature name
                const featureCell = sheet.getCell(`B${currentRow}`);
                featureCell.value = feature || 'Unknown';
                featureCell.font = { size: 10 };
                featureCell.alignment = { horizontal: 'left', vertical: 'middle' };
                featureCell.border = this.getBorder();

                // Total
                const totalCell = sheet.getCell(`C${currentRow}`);
                totalCell.value = data.total || 0;
                totalCell.alignment = { horizontal: 'center', vertical: 'middle' };
                totalCell.border = this.getBorder();

                // Passed
                const passedCell = sheet.getCell(`D${currentRow}`);
                passedCell.value = data.passed || 0;
                passedCell.alignment = { horizontal: 'center', vertical: 'middle' };
                passedCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.successColor + '20' } };
                passedCell.border = this.getBorder();

                // Failed
                const failedCell = sheet.getCell(`E${currentRow}`);
                failedCell.value = data.failed || 0;
                failedCell.alignment = { horizontal: 'center', vertical: 'middle' };
                if (data.failed > 0) {
                    failedCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.failureColor + '20' } };
                }
                failedCell.border = this.getBorder();

                // Visual representation
                const visualCell = sheet.getCell(`F${currentRow}`);
                const passRate = data.total > 0 ? Math.round((data.passed / data.total) * 100) : 0;
                const barChar = passRate >= 80 ? '█' : passRate >= 50 ? '▓' : passRate >= 20 ? '▒' : '░';
                const barRepeat = barChar.repeat(Math.round(passRate / 10));
                visualCell.value = `${barRepeat} ${passRate}%`;
                visualCell.font = { size: 9, color: { argb: passRate >= 80 ? this.successColor : passRate >= 50 ? this.warningColor : this.failureColor } };
                visualCell.alignment = { horizontal: 'left', vertical: 'middle' };
                visualCell.border = this.getBorder();

                currentRow += 1;
            });
        }
    }

    private static async addScenariosSheet(
        workbook: any,
        suite: TestSuite,
        stats: any
    ): Promise<void> {
        const sheet = workbook.addWorksheet('🎬 Test Scenarios', {
            properties: { tabColor: { argb: this.infoColor } }
        });

        // Headers
        sheet.columns = [
            { header: '#', key: 'index', width: 8 },
            { header: 'Scenario Name', key: 'name', width: 50 },
            { header: 'Feature', key: 'feature', width: 30 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'Duration (s)', key: 'duration', width: 15 },
            { header: 'Steps', key: 'steps', width: 10 },
            { header: 'Tags', key: 'tags', width: 30 },
            { header: 'Start Time', key: 'startTime', width: 20 }
        ];

        // Style headers
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.brandColor } };
        sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.getRow(1).height = 25;

        // Add data
        suite.scenarios.forEach((scenario, index) => {
            const row = sheet.addRow({
                index: index + 1,
                name: scenario.name,
                feature: scenario.feature || 'N/A',
                status: scenario.status.toUpperCase(),
                duration: scenario.duration ? (scenario.duration / 1000).toFixed(2) : '0.00',
                steps: scenario.steps.length,
                tags: scenario.tags ? scenario.tags.join(', ') : '',
                startTime: scenario.startTime ? new Date(scenario.startTime).toLocaleString() : 'N/A'
            });

            // Status color coding
            const statusCell = row.getCell(4);
            if (scenario.status === 'passed') {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.successColor } };
                statusCell.font = { color: { argb: 'FFFFFF' }, bold: true };
            } else if (scenario.status === 'failed') {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.failureColor } };
                statusCell.font = { color: { argb: 'FFFFFF' }, bold: true };
            } else {
                statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.warningColor } };
                statusCell.font = { color: { argb: 'FFFFFF' }, bold: true };
            }
            statusCell.alignment = { horizontal: 'center', vertical: 'middle' };

            // Apply borders
            row.eachCell((cell: any) => {
                cell.border = this.getBorder();
            });
        });

        // Auto-filter
        sheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: suite.scenarios.length + 1, column: 8 }
        };

        // Freeze first row
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    private static async addStepsSheet(
        workbook: any,
        suite: TestSuite,
        outputDir: string
    ): Promise<void> {
        const sheet = workbook.addWorksheet('📝 Test Steps', {
            properties: { tabColor: { argb: this.infoColor } }
        });

        // Headers
        sheet.columns = [
            { header: 'Scenario', key: 'scenario', width: 40 },
            { header: 'Step #', key: 'stepNum', width: 10 },
            { header: 'Step Name', key: 'stepName', width: 60 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'Duration (s)', key: 'duration', width: 15 },
            { header: 'Error', key: 'error', width: 50 },
            { header: 'Screenshot', key: 'screenshot', width: 15 }
        ];

        // Style headers
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.brandColor } };
        sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.getRow(1).height = 25;

        // Add data
        suite.scenarios.forEach((scenario) => {
            scenario.steps.forEach((step, stepIndex) => {
                const row = sheet.addRow({
                    scenario: scenario.name,
                    stepNum: stepIndex + 1,
                    stepName: step.name,
                    status: step.status.toUpperCase(),
                    duration: step.duration ? (step.duration / 1000).toFixed(2) : '0.00',
                    error: step.error || '',
                    screenshot: ''  // Will add hyperlink below
                });

                // Status color coding
                const statusCell = row.getCell(4);
                if (step.status === 'passed') {
                    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.successColor } };
                    statusCell.font = { color: { argb: 'FFFFFF' }, bold: true };
                } else if (step.status === 'failed') {
                    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.failureColor } };
                    statusCell.font = { color: { argb: 'FFFFFF' }, bold: true };
                } else {
                    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.warningColor } };
                    statusCell.font = { color: { argb: 'FFFFFF' }, bold: true };
                }
                statusCell.alignment = { horizontal: 'center', vertical: 'middle' };

                // Error cell color
                if (step.error) {
                    const errorCell = row.getCell(6);
                    errorCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
                    errorCell.font = { color: { argb: this.failureColor } };
                }

                // Add screenshot link for failed steps only
                if (step.status === 'failed' && step.screenshot) {
                    const screenshotCell = row.getCell(7);

                    // Fix screenshot path - ensure it points to screenshots folder correctly
                    let screenshotPath = step.screenshot;

                    // If absolute path, convert to relative path from Excel file location
                    if (path.isAbsolute(screenshotPath)) {
                        // Excel file is in outputDir (e.g., reports/test-results-XXX/)
                        // Screenshots are in outputDir/screenshots/ or ../screenshots/
                        const excelDir = outputDir;

                        // Try to make relative path
                        try {
                            screenshotPath = path.relative(excelDir, screenshotPath);
                        } catch (e) {
                            // If relative path fails, try to construct it manually
                            const filename = path.basename(screenshotPath);

                            // Check if screenshots folder exists in current output directory
                            const screenshotsDir = path.join(excelDir, 'screenshots');
                            const possiblePath = path.join(screenshotsDir, filename);

                            if (fs.existsSync(possiblePath)) {
                                screenshotPath = `screenshots/${filename}`;
                            } else {
                                // Try parent screenshots folder (for parallel execution)
                                const parentScreenshotsDir = path.join(path.dirname(excelDir), 'screenshots');
                                const parentPossiblePath = path.join(parentScreenshotsDir, filename);

                                if (fs.existsSync(parentPossiblePath)) {
                                    screenshotPath = `../screenshots/${filename}`;
                                } else {
                                    // Fallback - just use the filename with screenshots/ prefix
                                    screenshotPath = `screenshots/${filename}`;
                                }
                            }
                        }
                    } else {
                        // Already relative - ensure it points to screenshots folder
                        const filename = path.basename(screenshotPath);

                        // Check if path already includes 'screenshots' or needs it
                        if (!screenshotPath.includes('screenshots')) {
                            screenshotPath = `screenshots/${filename}`;
                        }
                    }

                    screenshotCell.value = {
                        text: 'View',
                        hyperlink: screenshotPath.replace(/\\/g, '/')  // Use forward slashes for Excel hyperlinks
                    };
                    screenshotCell.font = { color: { argb: this.infoColor }, underline: true };
                    screenshotCell.alignment = { horizontal: 'center', vertical: 'middle' };
                }

                // Apply borders
                row.eachCell((cell: any) => {
                    cell.border = this.getBorder();
                });
            });
        });

        // Auto-filter
        const totalRows = suite.scenarios.reduce((sum, s) => sum + s.steps.length, 0);
        sheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: totalRows + 1, column: 7 }
        };

        // Freeze first row
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    private static async addFailureAnalysisSheet(
        workbook: any,
        suite: TestSuite,
        stats: any
    ): Promise<void> {
        const sheet = workbook.addWorksheet('🔍 Failure Analysis', {
            properties: { tabColor: { argb: this.failureColor } }
        });

        // Set column widths
        sheet.columns = [
            { width: 5 },
            { width: 40 },
            { width: 50 },
            { width: 30 },
            { width: 5 }
        ];

        let currentRow = 2;

        // Title
        sheet.mergeCells(`B${currentRow}:D${currentRow}`);
        const titleCell = sheet.getCell(`B${currentRow}`);
        titleCell.value = '🔍 FAILURE ANALYSIS';
        titleCell.font = { size: 18, bold: true, color: { argb: this.failureColor } };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
        currentRow += 3;

        // Failure Summary
        sheet.mergeCells(`B${currentRow}:D${currentRow}`);
        const summaryCell = sheet.getCell(`B${currentRow}`);
        summaryCell.value = `Total Failures: ${stats.failedScenarios}`;
        summaryCell.font = { size: 14, bold: true };
        summaryCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
        summaryCell.alignment = { horizontal: 'center', vertical: 'middle' };
        summaryCell.border = this.getBorder();
        currentRow += 3;

        // Failure reasons
        if (stats.failureReasons && stats.failureReasons.size > 0) {
            sheet.mergeCells(`B${currentRow}:D${currentRow}`);
            const reasonsHeaderCell = sheet.getCell(`B${currentRow}`);
            reasonsHeaderCell.value = 'Failure Categories';
            reasonsHeaderCell.font = { size: 12, bold: true, color: { argb: 'FFFFFF' } };
            reasonsHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.failureColor } };
            reasonsHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
            currentRow += 1;

            const failureEntries = Array.from(stats.failureReasons.entries()) as Array<[string, number]>;
            failureEntries.forEach(([reason, count]) => {
                sheet.getCell(`B${currentRow}`).value = reason;
                sheet.getCell(`C${currentRow}`).value = count;
                sheet.getCell(`D${currentRow}`).value = `${((count / stats.failedScenarios) * 100).toFixed(1)}%`;

                for (let col = 2; col <= 4; col++) {
                    const cell = sheet.getCell(currentRow, col);
                    cell.border = this.getBorder();
                    cell.alignment = { horizontal: col === 2 ? 'left' : 'center', vertical: 'middle' };
                }
                currentRow += 1;
            });
            currentRow += 2;
        }

        // Failed scenarios details
        const failedScenarios = suite.scenarios.filter(s => s.status === 'failed');
        if (failedScenarios.length > 0) {
            sheet.mergeCells(`B${currentRow}:D${currentRow}`);
            const detailsHeaderCell = sheet.getCell(`B${currentRow}`);
            detailsHeaderCell.value = 'Failed Scenarios Details';
            detailsHeaderCell.font = { size: 12, bold: true, color: { argb: 'FFFFFF' } };
            detailsHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.failureColor } };
            detailsHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
            currentRow += 1;

            failedScenarios.forEach((scenario, index) => {
                sheet.mergeCells(`B${currentRow}:D${currentRow}`);
                const scenarioCell = sheet.getCell(`B${currentRow}`);
                scenarioCell.value = `${index + 1}. ${scenario.name}`;
                scenarioCell.font = { bold: true, color: { argb: this.failureColor } };
                scenarioCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
                scenarioCell.border = this.getBorder();
                currentRow += 1;

                const failedSteps = scenario.steps.filter(s => s.status === 'failed');
                failedSteps.forEach(step => {
                    sheet.mergeCells(`B${currentRow}:B${currentRow}`);
                    sheet.mergeCells(`C${currentRow}:D${currentRow}`);

                    sheet.getCell(`B${currentRow}`).value = `   Step: ${step.name}`;
                    sheet.getCell(`C${currentRow}`).value = step.error || 'No error message';

                    for (let col = 2; col <= 4; col++) {
                        const cell = sheet.getCell(currentRow, col);
                        cell.border = this.getBorder();
                        if (col === 3) {
                            cell.font = { color: { argb: this.failureColor }, italic: true };
                        }
                    }
                    currentRow += 1;
                });
                currentRow += 1;
            });
        }
    }

    private static async addPerformanceSheet(
        workbook: any,
        suite: TestSuite,
        stats: any
    ): Promise<void> {
        const sheet = workbook.addWorksheet('⚡ Performance', {
            properties: { tabColor: { argb: this.infoColor } }
        });

        // Set column widths
        sheet.columns = [
            { width: 5 },
            { width: 50 },
            { width: 20 },
            { width: 20 },
            { width: 5 }
        ];

        let currentRow = 2;

        // Title
        sheet.mergeCells(`B${currentRow}:D${currentRow}`);
        const titleCell = sheet.getCell(`B${currentRow}`);
        titleCell.value = '⚡ PERFORMANCE METRICS';
        titleCell.font = { size: 18, bold: true, color: { argb: this.infoColor } };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
        currentRow += 3;

        // Performance summary
        const avgDuration = stats.totalScenarios > 0
            ? (suite.duration || 0) / stats.totalScenarios / 1000
            : 0;

        const perfSummary = [
            ['Total Execution Time', this.formatDuration(suite.duration || 0)],
            ['Average Scenario Duration', `${avgDuration.toFixed(2)}s`],
            ['Scenarios per Minute', stats.totalScenarios > 0 ? ((stats.totalScenarios / ((suite.duration || 1) / 60000)).toFixed(2)) : '0']
        ];

        perfSummary.forEach(([metric, value]) => {
            sheet.mergeCells(`B${currentRow}:C${currentRow}`);
            sheet.getCell(`B${currentRow}`).value = metric;
            sheet.getCell(`B${currentRow}`).font = { bold: true };
            sheet.getCell(`B${currentRow}`).border = this.getBorder();
            sheet.getCell(`B${currentRow}`).alignment = { horizontal: 'left', vertical: 'middle' };

            sheet.getCell(`D${currentRow}`).value = value;
            sheet.getCell(`D${currentRow}`).border = this.getBorder();
            sheet.getCell(`D${currentRow}`).alignment = { horizontal: 'right', vertical: 'middle' };

            currentRow += 1;
        });

        currentRow += 2;

        // Fastest scenarios
        if (stats.performanceMetrics.fastest.length > 0) {
            sheet.mergeCells(`B${currentRow}:D${currentRow}`);
            const fastestHeaderCell = sheet.getCell(`B${currentRow}`);
            fastestHeaderCell.value = '🚀 Fastest Scenarios (Top 10)';
            fastestHeaderCell.font = { size: 12, bold: true, color: { argb: 'FFFFFF' } };
            fastestHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.successColor } };
            fastestHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
            currentRow += 1;

            stats.performanceMetrics.fastest.slice(0, 10).forEach((item: any, index: number) => {
                sheet.mergeCells(`B${currentRow}:C${currentRow}`);
                sheet.getCell(`B${currentRow}`).value = `${index + 1}. ${item.name}`;
                sheet.getCell(`B${currentRow}`).border = this.getBorder();

                sheet.getCell(`D${currentRow}`).value = `${(item.duration / 1000).toFixed(2)}s`;
                sheet.getCell(`D${currentRow}`).border = this.getBorder();
                sheet.getCell(`D${currentRow}`).alignment = { horizontal: 'right', vertical: 'middle' };
                sheet.getCell(`D${currentRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'D1FAE5' } };

                currentRow += 1;
            });
            currentRow += 2;
        }

        // Slowest scenarios
        if (stats.performanceMetrics.slowest.length > 0) {
            sheet.mergeCells(`B${currentRow}:D${currentRow}`);
            const slowestHeaderCell = sheet.getCell(`B${currentRow}`);
            slowestHeaderCell.value = '🐌 Slowest Scenarios (Top 10)';
            slowestHeaderCell.font = { size: 12, bold: true, color: { argb: 'FFFFFF' } };
            slowestHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.warningColor } };
            slowestHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
            currentRow += 1;

            stats.performanceMetrics.slowest.slice(0, 10).forEach((item: any, index: number) => {
                sheet.mergeCells(`B${currentRow}:C${currentRow}`);
                sheet.getCell(`B${currentRow}`).value = `${index + 1}. ${item.name}`;
                sheet.getCell(`B${currentRow}`).border = this.getBorder();

                sheet.getCell(`D${currentRow}`).value = `${(item.duration / 1000).toFixed(2)}s`;
                sheet.getCell(`D${currentRow}`).border = this.getBorder();
                sheet.getCell(`D${currentRow}`).alignment = { horizontal: 'right', vertical: 'middle' };
                sheet.getCell(`D${currentRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF3C7' } };

                currentRow += 1;
            });
        }
    }

    private static async addHistorySheet(
        workbook: any,
        history: ExecutionHistory[]
    ): Promise<void> {
        const sheet = workbook.addWorksheet('📈 History', {
            properties: { tabColor: { argb: this.infoColor } }
        });

        // Headers
        sheet.columns = [
            { header: 'Date', key: 'date', width: 15 },
            { header: 'Time', key: 'time', width: 20 },
            { header: 'Total', key: 'total', width: 12 },
            { header: 'Passed', key: 'passed', width: 12 },
            { header: 'Failed', key: 'failed', width: 12 },
            { header: 'Skipped', key: 'skipped', width: 12 },
            { header: 'Pass Rate %', key: 'passRate', width: 15 },
            { header: 'Duration', key: 'duration', width: 15 }
        ];

        // Style headers
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: this.brandColor } };
        sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.getRow(1).height = 25;

        // Add data (most recent first)
        const sortedHistory = [...history].reverse();
        sortedHistory.forEach((entry) => {
            const row = sheet.addRow({
                date: entry.date,
                time: entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : 'N/A',
                total: entry.totalScenarios,
                passed: entry.passedScenarios,
                failed: entry.failedScenarios,
                skipped: entry.skippedScenarios,
                passRate: entry.passRate.toFixed(1),
                duration: this.formatDuration(entry.duration)
            });

            // Color code pass rate
            const passRateCell = row.getCell(7);
            if (entry.passRate >= 90) {
                passRateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'D1FAE5' } };
            } else if (entry.passRate >= 70) {
                passRateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF3C7' } };
            } else {
                passRateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
            }

            // Apply borders
            row.eachCell((cell: any) => {
                cell.border = this.getBorder();
                cell.alignment = { horizontal: 'center', vertical: 'middle' };
            });
        });

        // Freeze first row
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    private static async addSummaryChartsSheet(
        workbook: any,
        stats: any,
        history: ExecutionHistory[]
    ): Promise<void> {
        const sheet = workbook.addWorksheet('📊 Charts Data', {
            properties: { tabColor: { argb: this.brandColor } }
        });

        let currentRow = 1;

        // Status Distribution
        sheet.getCell(`B${currentRow}`).value = 'Status Distribution';
        sheet.getCell(`B${currentRow}`).font = { bold: true, size: 14 };
        currentRow += 1;

        const statusData = [
            ['Status', 'Count'],
            ['Passed', stats.passedScenarios],
            ['Failed', stats.failedScenarios],
            ['Skipped', stats.skippedScenarios]
        ];

        statusData.forEach(row => {
            sheet.getCell(`B${currentRow}`).value = row[0];
            sheet.getCell(`C${currentRow}`).value = row[1];
            currentRow += 1;
        });

        currentRow += 2;

        // Trend Data (Last 7 days)
        sheet.getCell(`B${currentRow}`).value = 'Execution Trend (Last 7 Days)';
        sheet.getCell(`B${currentRow}`).font = { bold: true, size: 14 };
        currentRow += 1;

        const last7Days = history.slice(-7);
        const trendHeaders = ['Date', 'Pass Rate %', 'Total Tests'];
        trendHeaders.forEach((header, index) => {
            sheet.getCell(currentRow, 2 + index).value = header;
        });
        currentRow += 1;

        last7Days.forEach(entry => {
            sheet.getCell(`B${currentRow}`).value = entry.date;
            sheet.getCell(`C${currentRow}`).value = entry.passRate;
            sheet.getCell(`D${currentRow}`).value = entry.totalScenarios;
            currentRow += 1;
        });
    }

    // Helper methods
    private static addKPICard(
        sheet: any,
        range: string,
        title: string,
        value: any,
        color: string,
        icon: string
    ): void {
        sheet.mergeCells(range);
        const cell = sheet.getCell(range.split(':')[0]);
        cell.value = `${icon} ${title}\n${value}`;
        cell.font = { size: 14, bold: true, color: { argb: 'FFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = {
            top: { style: 'thick', color: { argb: color } },
            left: { style: 'thick', color: { argb: color } },
            bottom: { style: 'thick', color: { argb: color } },
            right: { style: 'thick', color: { argb: color } }
        };
    }

    private static getBorder(): Partial<any> {
        return {
            top: { style: 'thin', color: { argb: 'D1D5DB' } },
            left: { style: 'thin', color: { argb: 'D1D5DB' } },
            bottom: { style: 'thin', color: { argb: 'D1D5DB' } },
            right: { style: 'thin', color: { argb: 'D1D5DB' } }
        };
    }

    private static formatDuration(ms: number): string {
        const seconds = Math.floor((ms / 1000) % 60);
        const minutes = Math.floor((ms / (1000 * 60)) % 60);
        const hours = Math.floor(ms / (1000 * 60 * 60));

        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }

    private static calculateStatistics(suite: TestSuite): any {
        let totalSteps = 0;
        let passedSteps = 0;
        let failedSteps = 0;
        let skippedSteps = 0;

        const featureStats = new Map<string, any>();
        const tagStats = new Map<string, number>();
        const performanceMetrics = {
            fastest: [] as any[],
            slowest: [] as any[]
        };

        const failureReasons = new Map<string, number>();

        suite.scenarios.forEach(scenario => {
            // Track performance
            if (scenario.duration) {
                performanceMetrics.fastest.push({
                    name: scenario.name,
                    duration: scenario.duration
                });
                performanceMetrics.slowest.push({
                    name: scenario.name,
                    duration: scenario.duration
                });
            }

            // Analyze failures
            if (scenario.status === 'failed') {
                scenario.steps.forEach(step => {
                    if (step.error) {
                        const reason = this.categorizeFailure(step.error);
                        failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
                    }
                });
            }

            // Calculate step statistics
            scenario.steps.forEach(step => {
                totalSteps++;
                if (step.status === 'passed') passedSteps++;
                else if (step.status === 'failed') failedSteps++;
                else skippedSteps++;
            });

            // Track features
            const featureName = scenario.feature || 'Unknown';
            if (!featureStats.has(featureName)) {
                featureStats.set(featureName, { total: 0, passed: 0, failed: 0, skipped: 0 });
            }
            const featureData = featureStats.get(featureName);
            featureData.total++;
            if (scenario.status === 'passed') featureData.passed++;
            else if (scenario.status === 'failed') featureData.failed++;
            else featureData.skipped++;

            // Track tags
            if (scenario.tags) {
                scenario.tags.forEach(tag => {
                    tagStats.set(tag, (tagStats.get(tag) || 0) + 1);
                });
            }
        });

        // Sort performance metrics
        performanceMetrics.fastest.sort((a, b) => a.duration - b.duration);
        performanceMetrics.slowest.sort((a, b) => b.duration - a.duration);

        const totalScenarios = suite.scenarios.length;
        const passedScenarios = suite.scenarios.filter(s => s.status === 'passed').length;
        const failedScenarios = suite.scenarios.filter(s => s.status === 'failed').length;
        const skippedScenarios = suite.scenarios.filter(s => s.status === 'skipped').length;

        const passRate = totalScenarios > 0 ? ((passedScenarios / totalScenarios) * 100).toFixed(1) + '%' : '0%';
        const stepPassRate = totalSteps > 0 ? ((passedSteps / totalSteps) * 100).toFixed(1) + '%' : '0%';

        return {
            totalScenarios,
            passedScenarios,
            failedScenarios,
            skippedScenarios,
            passRate,
            totalSteps,
            passedSteps,
            failedSteps,
            skippedSteps,
            stepPassRate,
            featureStats,
            tagStats,
            performanceMetrics,
            failureReasons
        };
    }

    private static categorizeFailure(error: string | Error | any): string {
        // Convert error to string if needed
        const errorStr = typeof error === 'string' ? error :
                         (error?.message || error?.toString?.() || String(error));
        if (errorStr.includes('timeout') || errorStr.includes('Timeout')) {
            return 'Timeout';
        } else if (errorStr.includes('selector') || errorStr.includes('Selector') || errorStr.includes('element not found')) {
            return 'Element Not Found';
        } else if (errorStr.includes('assertion') || errorStr.includes('Expected') || errorStr.includes('expect')) {
            return 'Assertion Failed';
        } else if (errorStr.includes('network') || errorStr.includes('Network') || errorStr.includes('ERR_')) {
            return 'Network Error';
        } else if (errorStr.includes('undefined') || errorStr.includes('null') || errorStr.includes('TypeError')) {
            return 'Type Error';
        } else {
            return 'Other';
        }
    }

    private static loadExecutionHistory(outputDir: string): ExecutionHistory[] {
        // Try multiple locations for the history file
        const locations = [
            path.join(path.dirname(outputDir), 'execution-history.json'),  // Parent of outputDir
            path.join(outputDir, '../execution-history.json'),              // Relative path
            path.join(process.cwd(), 'reports/execution-history.json'),     // Default reports dir
            './reports/execution-history.json'                              // CWD relative
        ];

        for (const historyFile of locations) {
            if (fs.existsSync(historyFile)) {
                try {
                    const data = fs.readFileSync(historyFile, 'utf8');
                    const history = JSON.parse(data);
                    CSReporter.debug(`Loaded execution history from: ${historyFile} (${history.length} entries)`);
                    return history;
                } catch (error) {
                    CSReporter.warn(`Failed to parse execution history from ${historyFile}: ${error}`);
                }
            }
        }

        CSReporter.debug('No execution history file found, returning empty array');
        return [];
    }
}
