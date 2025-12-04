/**
 * CS Consolidated Report Generator - Enterprise-grade suite-level HTML reports
 * @module suite/CSConsolidatedReportGenerator
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    SuiteResult,
    ConsolidatedReportData,
    ProjectReportData,
    ScenarioReportData
} from './types/CSSuiteTypes';

export class CSConsolidatedReportGenerator {
    private static brandColor = '#93186C';
    private static brandColorLight = '#b83395';
    private static brandColorDark = '#6b1150';

    public static async generateReport(suiteResult: SuiteResult, outputDir: string): Promise<string> {
        const reportData = this.prepareReportData(suiteResult);
        const html = this.generateHTML(reportData);
        const htmlPath = path.join(outputDir, 'index.html');
        const jsonPath = path.join(outputDir, 'consolidated-data.json');
        fs.writeFileSync(htmlPath, html, 'utf8');
        fs.writeFileSync(jsonPath, JSON.stringify(reportData, null, 2), 'utf8');
        return htmlPath;
    }

    private static prepareReportData(suiteResult: SuiteResult): ConsolidatedReportData {
        const projects: ProjectReportData[] = suiteResult.projects.map(project => ({
            name: project.name,
            type: project.type,
            status: project.status,
            duration: project.duration / 1000,
            durationFormatted: this.formatDuration(project.duration),
            scenarioCount: project.totalScenarios,
            passed: project.passedScenarios,
            failed: project.failedScenarios,
            skipped: project.skippedScenarios,
            successRate: project.totalScenarios > 0
                ? ((project.passedScenarios / project.totalScenarios) * 100).toFixed(1) : '0',
            reportPath: `${project.project}/reports/index.html`,
            scenarios: project.scenarios.map(s => ({
                name: s.name, feature: s.feature, status: s.status,
                duration: s.duration / 1000, durationFormatted: this.formatDuration(s.duration),
                tags: s.tags, error: s.error,
                screenshots: s.screenshots.map(ss => `${project.project}/${ss}`),
                videos: s.videos.map(v => `${project.project}/${v}`)
            }))
        }));

        return {
            generatedAt: new Date().toISOString(),
            suiteName: suiteResult.suiteName,
            status: suiteResult.status,
            totalDuration: suiteResult.totalDuration,
            totalDurationFormatted: this.formatDuration(suiteResult.totalDuration),
            totalProjects: suiteResult.totalProjects,
            passedProjects: suiteResult.passedProjects,
            failedProjects: suiteResult.failedProjects,
            totalScenarios: suiteResult.totalScenarios,
            passedScenarios: suiteResult.passedScenarios,
            failedScenarios: suiteResult.failedScenarios,
            skippedScenarios: suiteResult.skippedScenarios || 0,
            successRate: suiteResult.successRate.toFixed(2),
            projects,
            environment: suiteResult.environment
        };
    }

    private static formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        const min = Math.floor(ms / 60000);
        const sec = Math.floor((ms % 60000) / 1000);
        return `${min}m ${sec}s`;
    }

    private static escapeHtml(str: string): string {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    private static generateHTML(data: ConsolidatedReportData): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(data.suiteName)} - Multi-Project Test Suite Report</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"></script>
    <style>${this.generateCSS()}</style>
</head>
<body>
    <div id="app">
        ${this.generateHeader(data)}
        ${this.generateNavigation(data)}
        <main class="main-content">
            <div id="dashboard-view" class="view active">${this.generateDashboardView(data)}</div>
            <div id="projects-view" class="view">${this.generateProjectsView(data)}</div>
            <div id="scenarios-view" class="view">${this.generateScenariosView(data)}</div>
            <div id="timeline-view" class="view">${this.generateTimelineView(data)}</div>
            <div id="comparison-view" class="view">${this.generateComparisonView(data)}</div>
            <div id="environment-view" class="view">${this.generateEnvironmentView(data)}</div>
        </main>
        ${this.generateFooter()}
    </div>
    <script>${this.generateJavaScript(data)}</script>
</body>
</html>`;
    }

    private static generateCSS(): string {
        return `
:root {
    --brand-color: ${this.brandColor};
    --brand-color-light: ${this.brandColorLight};
    --brand-color-dark: ${this.brandColorDark};
    --success-color: #10b981;
    --danger-color: #ef4444;
    --warning-color: #f59e0b;
    --info-color: #3b82f6;
    --purple-color: #8b5cf6;
    --cyan-color: #06b6d4;
    --pink-color: #ec4899;
    --teal-color: #14b8a6;
    --surface: #f9fafb;
    --surface-hover: #f3f4f6;
    --text-primary: #111827;
    --text-secondary: #6b7280;
    --border: #e5e7eb;
    --shadow: rgba(0, 0, 0, 0.1);
    --shadow-lg: rgba(0, 0, 0, 0.15);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #f5f7fa 0%, #e4e8f0 100%); color: var(--text-primary); line-height: 1.6; min-height: 100vh; font-size: 14px; }
#app { min-height: 100vh; display: flex; flex-direction: column; }
.header { background: linear-gradient(135deg, var(--brand-color) 0%, var(--brand-color-dark) 100%); color: white; box-shadow: 0 4px 20px var(--shadow-lg); }
.header-main { padding: 1.5rem 2rem; display: flex; justify-content: space-between; align-items: center; max-width: 1600px; margin: 0 auto; }
.header-left { display: flex; align-items: center; gap: 1.5rem; }
.logo-section { display: flex; align-items: center; gap: 1rem; }
.logo-icon { width: 50px; height: 50px; background: rgba(255,255,255,0.2); border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
.logo-text h1 { font-size: 1.5rem; font-weight: 700; margin: 0; }
.logo-text .subtitle { font-size: 0.8rem; opacity: 0.85; }
.suite-info { padding-left: 1.5rem; border-left: 2px solid rgba(255,255,255,0.3); }
.suite-name { font-size: 1.25rem; font-weight: 600; }
.suite-meta { font-size: 0.85rem; opacity: 0.9; }
.header-right { display: flex; align-items: center; gap: 2rem; }
.header-stats { display: flex; gap: 1.5rem; }
.header-stat { text-align: center; padding: 0.5rem 1rem; background: rgba(255,255,255,0.1); border-radius: 8px; }
.header-stat-value { font-size: 1.5rem; font-weight: 700; }
.header-stat-label { font-size: 0.7rem; text-transform: uppercase; opacity: 0.85; }
.status-badge-large { padding: 0.75rem 1.5rem; border-radius: 12px; font-weight: 700; font-size: 1rem; text-transform: uppercase; letter-spacing: 1px; }
.status-badge-large.passed { background: var(--success-color); }
.status-badge-large.failed { background: var(--danger-color); }
.status-badge-large.partial { background: var(--warning-color); color: #000; }
.nav { background: white; box-shadow: 0 2px 10px var(--shadow); position: sticky; top: 0; z-index: 100; }
.nav-container { max-width: 1600px; margin: 0 auto; display: flex; overflow-x: auto; }
.nav-item { padding: 1rem 1.5rem; cursor: pointer; border-bottom: 3px solid transparent; font-weight: 500; white-space: nowrap; transition: all 0.3s ease; display: flex; align-items: center; gap: 0.5rem; color: var(--text-secondary); }
.nav-item:hover { background: var(--surface-hover); color: var(--brand-color); }
.nav-item.active { border-bottom-color: var(--brand-color); color: var(--brand-color); background: var(--surface); }
.nav-icon { font-size: 1.1rem; }
.nav-badge { background: var(--brand-color); color: white; padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.75rem; font-weight: 600; }
.main-content { flex: 1; max-width: 1600px; margin: 0 auto; padding: 2rem; width: 100%; }
.view { display: none; animation: fadeIn 0.3s ease; }
.view.active { display: block; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.25rem; margin-bottom: 1.25rem; width: 100%; }
@media (max-width: 1200px) { .stats-row { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 600px) { .stats-row { grid-template-columns: 1fr; } }
.stat-card { background: white; border-radius: 16px; padding: 1.5rem; box-shadow: 0 4px 15px var(--shadow); transition: all 0.3s ease; border-left: 4px solid var(--border); position: relative; overflow: hidden; }
.stat-card:hover { transform: translateY(-4px); box-shadow: 0 12px 30px var(--shadow-lg); }
.stat-card.projects { border-left-color: var(--info-color); }
.stat-card.scenarios { border-left-color: var(--purple-color); }
.stat-card.passed { border-left-color: var(--success-color); }
.stat-card.failed { border-left-color: var(--danger-color); }
.stat-card.skipped { border-left-color: var(--warning-color); }
.stat-card.rate { border-left-color: var(--teal-color); }
.stat-card.duration { border-left-color: var(--cyan-color); }
.stat-card.avg { border-left-color: var(--pink-color); }
.stat-icon { font-size: 1.75rem; margin-bottom: 0.5rem; }
.stat-value { font-size: 2rem; font-weight: 700; line-height: 1.1; }
.stat-card.projects .stat-value { color: var(--info-color); }
.stat-card.scenarios .stat-value { color: var(--purple-color); }
.stat-card.passed .stat-value { color: var(--success-color); }
.stat-card.failed .stat-value { color: var(--danger-color); }
.stat-card.skipped .stat-value { color: var(--warning-color); }
.stat-card.rate .stat-value { color: var(--teal-color); }
.stat-card.duration .stat-value { color: var(--cyan-color); }
.stat-card.avg .stat-value { color: var(--pink-color); }
.stat-label { font-size: 0.85rem; color: var(--text-secondary); font-weight: 500; margin-top: 0.5rem; }
.stat-subtext { font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.25rem; }
.charts-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.5rem; margin-bottom: 2rem; }
.chart-card { background: white; border-radius: 16px; padding: 1.5rem; box-shadow: 0 4px 15px var(--shadow); }
.chart-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-primary); display: flex; align-items: center; gap: 0.5rem; }
.chart-title-icon { font-size: 1.25rem; }
.chart-canvas { height: 300px !important; }
@media (max-width: 1200px) { .charts-grid { grid-template-columns: 1fr; } }
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
.section-title { font-size: 1.5rem; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 0.75rem; }
.section-title-icon { font-size: 1.75rem; }
.project-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(450px, 1fr)); gap: 1.5rem; }
@media (max-width: 1000px) { .project-grid { grid-template-columns: 1fr; } }
.project-card { background: white; border-radius: 16px; box-shadow: 0 4px 15px var(--shadow); overflow: hidden; transition: all 0.3s ease; }
.project-card:hover { transform: translateY(-4px); box-shadow: 0 12px 30px var(--shadow-lg); }
.project-card-header { background: linear-gradient(135deg, var(--brand-color) 0%, var(--brand-color-dark) 100%); color: white; padding: 1.25rem 1.5rem; display: flex; justify-content: space-between; align-items: center; }
.project-card-header.passed { background: linear-gradient(135deg, var(--success-color) 0%, #059669 100%); }
.project-card-header.failed { background: linear-gradient(135deg, var(--danger-color) 0%, #dc2626 100%); }
.project-card-header.partial { background: linear-gradient(135deg, var(--warning-color) 0%, #d97706 100%); }
.project-name { font-size: 1.25rem; font-weight: 600; display: flex; align-items: center; gap: 0.75rem; }
.project-type-badge { padding: 0.25rem 0.75rem; background: rgba(255,255,255,0.2); border-radius: 20px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
.project-status-icon { font-size: 1.5rem; }
.project-card-body { padding: 1.5rem; }
.project-stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 1rem; }
.project-stat-item { background: var(--surface); border-radius: 10px; padding: 1rem; display: flex; align-items: center; gap: 1rem; }
.project-stat-icon { font-size: 1.5rem; }
.project-stat-info { flex: 1; }
.project-stat-value { font-size: 1.5rem; font-weight: 700; line-height: 1; }
.project-stat-label { font-size: 0.75rem; color: var(--text-secondary); font-weight: 600; text-transform: uppercase; }
.project-stat-item.passed .project-stat-value { color: var(--success-color); }
.project-stat-item.failed .project-stat-value { color: var(--danger-color); }
.project-stat-item.skipped .project-stat-value { color: var(--warning-color); }
.project-stat-item.total .project-stat-value { color: var(--info-color); }
.project-progress { height: 8px; background: var(--surface); border-radius: 4px; overflow: hidden; margin-bottom: 1rem; }
.project-progress-bar { height: 100%; border-radius: 4px; transition: width 0.5s ease; }
.project-progress-bar.high { background: var(--success-color); }
.project-progress-bar.medium { background: var(--warning-color); }
.project-progress-bar.low { background: var(--danger-color); }
.project-card-footer { display: flex; justify-content: space-between; align-items: center; padding-top: 1rem; border-top: 1px solid var(--border); }
.project-meta { font-size: 0.85rem; color: var(--text-secondary); }
.btn { padding: 0.5rem 1rem; border-radius: 8px; font-weight: 600; font-size: 0.85rem; cursor: pointer; transition: all 0.2s ease; text-decoration: none; display: inline-flex; align-items: center; gap: 0.5rem; }
.btn-primary { background: var(--brand-color); color: white; border: none; }
.btn-primary:hover { background: var(--brand-color-dark); transform: translateY(-2px); }
.scenarios-card { background: white; border-radius: 16px; box-shadow: 0 4px 15px var(--shadow); overflow: hidden; }
.scenarios-card-header { background: var(--surface); padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border); }
.scenarios-filters { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin-bottom: 1rem; }
.filter-group { display: flex; gap: 0.5rem; align-items: center; }
.filter-label { font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); }
.filter-select { padding: 0.5rem 1rem; border: 1px solid var(--border); border-radius: 8px; font-size: 0.85rem; background: white; cursor: pointer; min-width: 150px; }
.filter-btn { padding: 0.5rem 1rem; border: 1px solid var(--border); background: white; border-radius: 8px; font-size: 0.85rem; cursor: pointer; transition: all 0.2s ease; }
.filter-btn:hover, .filter-btn.active { background: var(--brand-color); color: white; border-color: var(--brand-color); }
.scenarios-table-wrapper { overflow-x: auto; }
.scenarios-table { width: 100%; border-collapse: collapse; min-width: 900px; }
.scenarios-table th { background: var(--surface); padding: 1rem 1.25rem; text-align: left; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; color: var(--text-secondary); border-bottom: 2px solid var(--border); }
.scenarios-table td { padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
.scenarios-table tr:hover { background: var(--surface-hover); }
.scenario-name { font-weight: 500; color: var(--text-primary); }
.status-badge { display: inline-block; padding: 0.35rem 0.75rem; border-radius: 20px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
.status-badge.passed { background: #dcfce7; color: #166534; }
.status-badge.failed { background: #fecaca; color: #991b1b; }
.status-badge.skipped { background: #fef3c7; color: #92400e; }
.tag { display: inline-block; padding: 0.2rem 0.5rem; background: var(--surface); color: var(--text-secondary); border-radius: 4px; font-size: 0.75rem; margin: 0.1rem; }
.error-row td { padding: 0.5rem 1.25rem; background: #fef2f2; color: #991b1b; font-size: 0.85rem; }
.timeline-card { background: white; border-radius: 16px; box-shadow: 0 4px 15px var(--shadow); overflow: hidden; margin-bottom: 1.5rem; }
.timeline-card-header { background: var(--surface); padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
.timeline-card-title { font-weight: 600; font-size: 1.1rem; display: flex; align-items: center; gap: 0.75rem; }
.timeline-card-body { padding: 1.5rem; }
.timeline-info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.5rem; margin-bottom: 1.5rem; }
@media (max-width: 900px) { .timeline-info-grid { grid-template-columns: repeat(2, 1fr); } }
.timeline-info-item { text-align: center; padding: 1rem; background: var(--surface); border-radius: 10px; }
.timeline-info-label { font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase; font-weight: 600; margin-bottom: 0.25rem; }
.timeline-info-value { font-size: 1.1rem; font-weight: 600; color: var(--text-primary); }
.timeline-bar-container { margin-top: 1rem; }
.timeline-bar-label { font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.5rem; }
.timeline-bar { height: 28px; background: var(--surface); border-radius: 14px; overflow: hidden; display: flex; }
.timeline-bar-segment { height: 100%; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 600; color: white; min-width: 40px; }
.timeline-bar-passed { background: var(--success-color); }
.timeline-bar-failed { background: var(--danger-color); }
.timeline-bar-skipped { background: var(--warning-color); }
.timeline-legend { display: flex; gap: 1.5rem; margin-top: 1rem; flex-wrap: wrap; }
.timeline-legend-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
.timeline-legend-color { width: 12px; height: 12px; border-radius: 3px; }
.execution-order { background: var(--brand-color); color: white; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.9rem; }
.comparison-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.25rem; margin-bottom: 1.5rem; }
@media (max-width: 1000px) { .comparison-summary { grid-template-columns: repeat(2, 1fr); } }
.comparison-summary-item { background: white; border-radius: 12px; padding: 1.25rem; box-shadow: 0 4px 15px var(--shadow); display: flex; align-items: center; gap: 1rem; }
.comparison-summary-icon { font-size: 2rem; }
.comparison-summary-info { flex: 1; }
.comparison-summary-label { font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase; font-weight: 600; }
.comparison-summary-value { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); }
.comparison-table-card { background: white; border-radius: 16px; box-shadow: 0 4px 15px var(--shadow); overflow: hidden; margin-bottom: 1.5rem; }
.comparison-table-header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); background: var(--surface); }
.comparison-table { min-width: 1000px; }
.comparison-table tfoot td { border-top: 2px solid var(--border); }
.rate-bar { position: relative; height: 24px; background: var(--surface); border-radius: 12px; overflow: hidden; min-width: 80px; }
.rate-bar-fill { height: 100%; border-radius: 12px; transition: width 0.5s ease; }
.rate-bar-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 0.75rem; font-weight: 700; color: var(--text-primary); }
.btn-sm { padding: 0.35rem 0.75rem; font-size: 0.75rem; }
.env-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.5rem; }
@media (max-width: 900px) { .env-grid { grid-template-columns: 1fr; } }
.env-card { background: white; border-radius: 16px; box-shadow: 0 4px 15px var(--shadow); overflow: hidden; }
.env-card-header { background: var(--surface); padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 0.75rem; }
.env-card-title { font-weight: 600; font-size: 1.1rem; }
.env-card-icon { font-size: 1.25rem; }
.env-card-body { padding: 1rem 1.5rem; }
.env-item { display: flex; justify-content: space-between; padding: 0.75rem 0; border-bottom: 1px solid var(--border); }
.env-item:last-child { border-bottom: none; }
.env-label { font-weight: 500; color: var(--text-secondary); }
.env-value { font-weight: 600; color: var(--text-primary); text-align: right; max-width: 60%; word-break: break-word; }
.footer { background: var(--text-primary); color: white; padding: 1.5rem 2rem; text-align: center; }
.footer-brand { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.5rem; }
.footer-text { font-size: 0.85rem; opacity: 0.8; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--surface); }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-secondary); }
        `;
    }

    private static generateHeader(data: ConsolidatedReportData): string {
        return `
        <header class="header">
            <div class="header-main">
                <div class="header-left">
                    <div class="logo-section">
                        <div class="logo-icon">&#128202;</div>
                        <div class="logo-text">
                            <h1>CS Test Suite</h1>
                            <div class="subtitle">MohammedAKhan Framework</div>
                        </div>
                    </div>
                    <div class="suite-info">
                        <div class="suite-name">${this.escapeHtml(data.suiteName)}</div>
                        <div class="suite-meta">Generated: ${new Date(data.generatedAt).toLocaleString()}</div>
                    </div>
                </div>
                <div class="header-right">
                    <div class="header-stats">
                        <div class="header-stat">
                            <div class="header-stat-value">${data.totalProjects}</div>
                            <div class="header-stat-label">Projects</div>
                        </div>
                        <div class="header-stat">
                            <div class="header-stat-value">${data.totalScenarios}</div>
                            <div class="header-stat-label">Scenarios</div>
                        </div>
                        <div class="header-stat">
                            <div class="header-stat-value">${data.successRate}%</div>
                            <div class="header-stat-label">Pass Rate</div>
                        </div>
                    </div>
                    <div class="status-badge-large ${data.status}">
                        ${data.status === 'passed' ? '&#10003; ALL PASSED' : data.status === 'partial' ? '&#9888; PARTIAL' : '&#10007; FAILED'}
                    </div>
                </div>
            </div>
        </header>`;
    }

    private static generateNavigation(data: ConsolidatedReportData): string {
        return `
        <nav class="nav">
            <div class="nav-container">
                <div class="nav-item active" data-view="dashboard-view">
                    <span class="nav-icon">&#128200;</span>Dashboard
                </div>
                <div class="nav-item" data-view="projects-view">
                    <span class="nav-icon">&#128193;</span>Projects<span class="nav-badge">${data.totalProjects}</span>
                </div>
                <div class="nav-item" data-view="scenarios-view">
                    <span class="nav-icon">&#128203;</span>Scenarios<span class="nav-badge">${data.totalScenarios}</span>
                </div>
                <div class="nav-item" data-view="timeline-view">
                    <span class="nav-icon">&#128337;</span>Timeline
                </div>
                <div class="nav-item" data-view="comparison-view">
                    <span class="nav-icon">&#128202;</span>Comparison
                </div>
                <div class="nav-item" data-view="environment-view">
                    <span class="nav-icon">&#128421;</span>Environment
                </div>
            </div>
        </nav>`;
    }

    private static generateDashboardView(data: ConsolidatedReportData): string {
        const avgDuration = data.totalProjects > 0 ? data.totalDuration / data.totalProjects : 0;
        return `
        <!-- Row 1: Projects, Scenarios, Duration, Avg Duration -->
        <div class="stats-row">
            <div class="stat-card projects">
                <div class="stat-icon">&#128193;</div>
                <div class="stat-value">${data.totalProjects}</div>
                <div class="stat-label">Total Projects</div>
                <div class="stat-subtext">${data.passedProjects} passed, ${data.failedProjects} failed</div>
            </div>
            <div class="stat-card scenarios">
                <div class="stat-icon">&#128203;</div>
                <div class="stat-value">${data.totalScenarios}</div>
                <div class="stat-label">Total Scenarios</div>
                <div class="stat-subtext">Across all projects</div>
            </div>
            <div class="stat-card duration">
                <div class="stat-icon">&#9201;</div>
                <div class="stat-value">${data.totalDurationFormatted}</div>
                <div class="stat-label">Total Duration</div>
                <div class="stat-subtext">End-to-end execution</div>
            </div>
            <div class="stat-card avg">
                <div class="stat-icon">&#128338;</div>
                <div class="stat-value">${this.formatDuration(avgDuration)}</div>
                <div class="stat-label">Avg Project Time</div>
                <div class="stat-subtext">Per project average</div>
            </div>
        </div>
        <!-- Row 2: Passed, Failed, Skipped, Success Rate -->
        <div class="stats-row">
            <div class="stat-card passed">
                <div class="stat-icon">&#10003;</div>
                <div class="stat-value">${data.passedScenarios}</div>
                <div class="stat-label">Passed Scenarios</div>
                <div class="stat-subtext">${((data.passedScenarios / Math.max(data.totalScenarios, 1)) * 100).toFixed(1)}% of total</div>
            </div>
            <div class="stat-card failed">
                <div class="stat-icon">&#10007;</div>
                <div class="stat-value">${data.failedScenarios}</div>
                <div class="stat-label">Failed Scenarios</div>
                <div class="stat-subtext">Needs attention</div>
            </div>
            <div class="stat-card skipped">
                <div class="stat-icon">&#9711;</div>
                <div class="stat-value">${data.skippedScenarios || 0}</div>
                <div class="stat-label">Skipped Scenarios</div>
                <div class="stat-subtext">Not executed</div>
            </div>
            <div class="stat-card rate">
                <div class="stat-icon">&#127919;</div>
                <div class="stat-value">${data.successRate}%</div>
                <div class="stat-label">Success Rate</div>
                <div class="stat-subtext">Overall pass rate</div>
            </div>
        </div>
        <!-- Charts -->
        <div class="charts-grid">
            <div class="chart-card">
                <div class="chart-title"><span class="chart-title-icon">&#128200;</span> Results by Project</div>
                <canvas id="projectResultsChart" class="chart-canvas"></canvas>
            </div>
            <div class="chart-card">
                <div class="chart-title"><span class="chart-title-icon">&#128308;</span> Overall Distribution</div>
                <canvas id="distributionChart" class="chart-canvas"></canvas>
            </div>
            <div class="chart-card">
                <div class="chart-title"><span class="chart-title-icon">&#9201;</span> Execution Duration (seconds)</div>
                <canvas id="durationChart" class="chart-canvas"></canvas>
            </div>
            <div class="chart-card">
                <div class="chart-title"><span class="chart-title-icon">&#128202;</span> Success Rate by Project (%)</div>
                <canvas id="successRateChart" class="chart-canvas"></canvas>
            </div>
        </div>`;
    }

    private static generateProjectCard(project: ProjectReportData): string {
        const successRate = parseFloat(project.successRate);
        const progressClass = successRate >= 80 ? 'high' : successRate >= 50 ? 'medium' : 'low';
        return `
        <div class="project-card">
            <div class="project-card-header ${project.status}">
                <div class="project-name">
                    ${this.escapeHtml(project.name)}
                    <span class="project-type-badge">${project.type}</span>
                </div>
                <div class="project-status-icon">${project.status === 'passed' ? '&#10003;' : project.status === 'failed' ? '&#10007;' : '&#9888;'}</div>
            </div>
            <div class="project-card-body">
                <div class="project-stats-grid">
                    <div class="project-stat-item total">
                        <div class="project-stat-icon">&#128203;</div>
                        <div class="project-stat-info">
                            <div class="project-stat-value">${project.scenarioCount}</div>
                            <div class="project-stat-label">Total Scenarios</div>
                        </div>
                    </div>
                    <div class="project-stat-item passed">
                        <div class="project-stat-icon">&#10003;</div>
                        <div class="project-stat-info">
                            <div class="project-stat-value">${project.passed}</div>
                            <div class="project-stat-label">Passed</div>
                        </div>
                    </div>
                    <div class="project-stat-item failed">
                        <div class="project-stat-icon">&#10007;</div>
                        <div class="project-stat-info">
                            <div class="project-stat-value">${project.failed}</div>
                            <div class="project-stat-label">Failed</div>
                        </div>
                    </div>
                    <div class="project-stat-item skipped">
                        <div class="project-stat-icon">&#9711;</div>
                        <div class="project-stat-info">
                            <div class="project-stat-value">${project.skipped}</div>
                            <div class="project-stat-label">Skipped</div>
                        </div>
                    </div>
                </div>
                <div class="project-progress">
                    <div class="project-progress-bar ${progressClass}" style="width: ${project.successRate}%"></div>
                </div>
                <div class="project-card-footer">
                    <div class="project-meta">
                        <span>&#9201; ${project.durationFormatted}</span> &bull;
                        <span>&#127919; ${project.successRate}% success rate</span>
                    </div>
                    <a href="${this.escapeHtml(project.reportPath)}" class="btn btn-primary" target="_blank">
                        &#128196; View Full Report
                    </a>
                </div>
            </div>
        </div>`;
    }

    private static generateProjectsView(data: ConsolidatedReportData): string {
        return `
        <div class="section-header">
            <div class="section-title"><span class="section-title-icon">&#128193;</span> All Projects</div>
        </div>
        <div class="project-grid">
            ${data.projects.map(p => this.generateProjectCard(p)).join('')}
        </div>`;
    }

    private static generateScenariosView(data: ConsolidatedReportData): string {
        const allScenarios = data.projects.flatMap(p =>
            p.scenarios.map(s => ({ ...s, projectName: p.name, projectType: p.type }))
        );
        const uniqueFeatures = [...new Set(allScenarios.map(s => s.feature))];
        const uniqueProjects = [...new Set(allScenarios.map(s => s.projectName))];

        return `
        <div class="scenarios-card">
            <div class="scenarios-card-header">
                <div class="section-title"><span class="section-title-icon">&#128203;</span> All Scenarios</div>
                <div class="scenarios-filters">
                    <div class="filter-group">
                        <span class="filter-label">Status:</span>
                        <button class="filter-btn active" data-filter="all">All (${allScenarios.length})</button>
                        <button class="filter-btn" data-filter="passed">Passed (${allScenarios.filter(s => s.status === 'passed').length})</button>
                        <button class="filter-btn" data-filter="failed">Failed (${allScenarios.filter(s => s.status === 'failed').length})</button>
                        <button class="filter-btn" data-filter="skipped">Skipped (${allScenarios.filter(s => s.status === 'skipped').length})</button>
                    </div>
                    <div class="filter-group">
                        <span class="filter-label">Project:</span>
                        <select class="filter-select" id="project-filter">
                            <option value="">All Projects</option>
                            ${uniqueProjects.map(p => `<option value="${this.escapeHtml(p)}">${this.escapeHtml(p)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="filter-group">
                        <span class="filter-label">Feature:</span>
                        <select class="filter-select" id="feature-filter">
                            <option value="">All Features</option>
                            ${uniqueFeatures.map(f => `<option value="${this.escapeHtml(f)}">${this.escapeHtml(f)}</option>`).join('')}
                        </select>
                    </div>
                </div>
            </div>
            <div class="scenarios-table-wrapper">
                <table class="scenarios-table">
                    <thead>
                        <tr>
                            <th>Scenario</th>
                            <th>Project</th>
                            <th>Feature</th>
                            <th>Status</th>
                            <th>Duration</th>
                            <th>Tags</th>
                        </tr>
                    </thead>
                    <tbody id="scenarios-tbody">
                        ${allScenarios.map(s => `
                            <tr class="scenario-row" data-status="${s.status}" data-project="${this.escapeHtml(s.projectName)}" data-feature="${this.escapeHtml(s.feature)}">
                                <td><div class="scenario-name">${this.escapeHtml(s.name)}</div></td>
                                <td><span class="project-type-badge">${s.projectType}</span> ${this.escapeHtml(s.projectName)}</td>
                                <td>${this.escapeHtml(s.feature)}</td>
                                <td><span class="status-badge ${s.status}">${s.status}</span></td>
                                <td>${s.durationFormatted}</td>
                                <td>${(s.tags || []).slice(0, 3).map(t => `<span class="tag">${this.escapeHtml(t)}</span>`).join('')}</td>
                            </tr>
                            ${s.error ? `<tr class="error-row" data-status="${s.status}" data-project="${this.escapeHtml(s.projectName)}" data-feature="${this.escapeHtml(s.feature)}"><td colspan="6">&#9888; ${this.escapeHtml(s.error.substring(0, 200))}</td></tr>` : ''}
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
    }

    private static generateTimelineView(data: ConsolidatedReportData): string {
        let cumulativeTime = 0;
        return `
        <div class="section-header">
            <div class="section-title"><span class="section-title-icon">&#128337;</span> Execution Timeline</div>
        </div>
        ${data.projects.map((p, i) => {
            const startTime = cumulativeTime;
            cumulativeTime += p.duration * 1000;
            const total = p.scenarioCount || 1;
            const passedPct = (p.passed / total) * 100;
            const failedPct = (p.failed / total) * 100;
            const skippedPct = (p.skipped / total) * 100;
            return `
            <div class="timeline-card">
                <div class="timeline-card-header">
                    <div class="timeline-card-title">
                        <span class="execution-order">${i + 1}</span>
                        ${this.escapeHtml(p.name)}
                        <span class="project-type-badge">${p.type}</span>
                    </div>
                    <span class="status-badge ${p.status}">${p.status}</span>
                </div>
                <div class="timeline-card-body">
                    <div class="timeline-info-grid">
                        <div class="timeline-info-item">
                            <div class="timeline-info-label">Execution Order</div>
                            <div class="timeline-info-value">#${i + 1} of ${data.totalProjects}</div>
                        </div>
                        <div class="timeline-info-item">
                            <div class="timeline-info-label">Start Offset</div>
                            <div class="timeline-info-value">${this.formatDuration(startTime)}</div>
                        </div>
                        <div class="timeline-info-item">
                            <div class="timeline-info-label">Duration</div>
                            <div class="timeline-info-value">${p.durationFormatted}</div>
                        </div>
                        <div class="timeline-info-item">
                            <div class="timeline-info-label">Success Rate</div>
                            <div class="timeline-info-value">${p.successRate}%</div>
                        </div>
                    </div>
                    <div class="timeline-bar-container">
                        <div class="timeline-bar-label">Scenario Results Distribution</div>
                        <div class="timeline-bar">
                            ${p.passed > 0 ? `<div class="timeline-bar-segment timeline-bar-passed" style="width: ${passedPct}%">${p.passed}</div>` : ''}
                            ${p.failed > 0 ? `<div class="timeline-bar-segment timeline-bar-failed" style="width: ${failedPct}%">${p.failed}</div>` : ''}
                            ${p.skipped > 0 ? `<div class="timeline-bar-segment timeline-bar-skipped" style="width: ${skippedPct}%">${p.skipped}</div>` : ''}
                        </div>
                        <div class="timeline-legend">
                            <div class="timeline-legend-item"><div class="timeline-legend-color" style="background: var(--success-color)"></div> ${p.passed} Passed</div>
                            <div class="timeline-legend-item"><div class="timeline-legend-color" style="background: var(--danger-color)"></div> ${p.failed} Failed</div>
                            <div class="timeline-legend-item"><div class="timeline-legend-color" style="background: var(--warning-color)"></div> ${p.skipped} Skipped</div>
                        </div>
                    </div>
                </div>
            </div>`;
        }).join('')}`;
    }

    private static generateComparisonView(data: ConsolidatedReportData): string {
        // Find best/worst performers
        const sortedByRate = [...data.projects].sort((a, b) => parseFloat(b.successRate) - parseFloat(a.successRate));
        const sortedByDuration = [...data.projects].sort((a, b) => a.duration - b.duration);
        const totalScenarios = data.projects.reduce((sum, p) => sum + p.scenarioCount, 0);
        const totalDuration = data.projects.reduce((sum, p) => sum + p.duration, 0);
        const avgSuccessRate = data.projects.length > 0
            ? (data.projects.reduce((sum, p) => sum + parseFloat(p.successRate), 0) / data.projects.length).toFixed(1) : '0';

        return `
        <div class="section-header">
            <div class="section-title"><span class="section-title-icon">&#128202;</span> Project Comparison</div>
        </div>

        <!-- Summary Stats -->
        <div class="comparison-summary">
            <div class="comparison-summary-item">
                <div class="comparison-summary-icon">&#127942;</div>
                <div class="comparison-summary-info">
                    <div class="comparison-summary-label">Best Performer</div>
                    <div class="comparison-summary-value">${sortedByRate[0]?.name || 'N/A'} (${sortedByRate[0]?.successRate || 0}%)</div>
                </div>
            </div>
            <div class="comparison-summary-item">
                <div class="comparison-summary-icon">&#9201;</div>
                <div class="comparison-summary-info">
                    <div class="comparison-summary-label">Fastest Project</div>
                    <div class="comparison-summary-value">${sortedByDuration[0]?.name || 'N/A'} (${sortedByDuration[0]?.durationFormatted || '0s'})</div>
                </div>
            </div>
            <div class="comparison-summary-item">
                <div class="comparison-summary-icon">&#128200;</div>
                <div class="comparison-summary-info">
                    <div class="comparison-summary-label">Avg Success Rate</div>
                    <div class="comparison-summary-value">${avgSuccessRate}%</div>
                </div>
            </div>
            <div class="comparison-summary-item">
                <div class="comparison-summary-icon">&#128203;</div>
                <div class="comparison-summary-info">
                    <div class="comparison-summary-label">Total Scenarios</div>
                    <div class="comparison-summary-value">${totalScenarios}</div>
                </div>
            </div>
        </div>

        <!-- Comparison Table -->
        <div class="comparison-table-card">
            <div class="comparison-table-header">
                <div class="chart-title"><span class="chart-title-icon">&#128203;</span> Side-by-Side Comparison</div>
            </div>
            <div class="scenarios-table-wrapper">
                <table class="scenarios-table comparison-table">
                    <thead>
                        <tr>
                            <th>Project</th>
                            <th>Type</th>
                            <th>Status</th>
                            <th>Total</th>
                            <th>Passed</th>
                            <th>Failed</th>
                            <th>Skipped</th>
                            <th>Success Rate</th>
                            <th>Duration</th>
                            <th>Report</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.projects.map(p => `
                        <tr>
                            <td><strong>${this.escapeHtml(p.name)}</strong></td>
                            <td><span class="project-type-badge">${p.type}</span></td>
                            <td><span class="status-badge ${p.status}">${p.status}</span></td>
                            <td style="text-align: center; font-weight: 600; color: var(--info-color)">${p.scenarioCount}</td>
                            <td style="text-align: center; font-weight: 600; color: var(--success-color)">${p.passed}</td>
                            <td style="text-align: center; font-weight: 600; color: var(--danger-color)">${p.failed}</td>
                            <td style="text-align: center; font-weight: 600; color: var(--warning-color)">${p.skipped}</td>
                            <td style="text-align: center">
                                <div class="rate-bar">
                                    <div class="rate-bar-fill" style="width: ${p.successRate}%; background: ${parseFloat(p.successRate) >= 80 ? 'var(--success-color)' : parseFloat(p.successRate) >= 50 ? 'var(--warning-color)' : 'var(--danger-color)'}"></div>
                                    <span class="rate-bar-text">${p.successRate}%</span>
                                </div>
                            </td>
                            <td style="text-align: center">${p.durationFormatted}</td>
                            <td><a href="${this.escapeHtml(p.reportPath)}" class="btn btn-primary btn-sm" target="_blank">&#128196; View</a></td>
                        </tr>`).join('')}
                    </tbody>
                    <tfoot>
                        <tr style="background: var(--surface); font-weight: 600;">
                            <td colspan="3">Total / Average</td>
                            <td style="text-align: center; color: var(--info-color)">${totalScenarios}</td>
                            <td style="text-align: center; color: var(--success-color)">${data.passedScenarios}</td>
                            <td style="text-align: center; color: var(--danger-color)">${data.failedScenarios}</td>
                            <td style="text-align: center; color: var(--warning-color)">${data.skippedScenarios}</td>
                            <td style="text-align: center">${avgSuccessRate}%</td>
                            <td style="text-align: center">${this.formatDuration(totalDuration * 1000)}</td>
                            <td></td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>

        <!-- Comparison Charts -->
        <div class="charts-grid">
            <div class="chart-card">
                <div class="chart-title"><span class="chart-title-icon">&#128202;</span> Scenario Count Comparison</div>
                <canvas id="comparisonScenarioChart" class="chart-canvas"></canvas>
            </div>
            <div class="chart-card">
                <div class="chart-title"><span class="chart-title-icon">&#127919;</span> Success Rate Comparison</div>
                <canvas id="comparisonRateChart" class="chart-canvas"></canvas>
            </div>
        </div>`;
    }

    private static generateEnvironmentView(data: ConsolidatedReportData): string {
        const env = data.environment;
        return `
        <div class="env-grid">
            <div class="env-card">
                <div class="env-card-header">
                    <span class="env-card-icon">&#128421;</span>
                    <span class="env-card-title">System Information</span>
                </div>
                <div class="env-card-body">
                    <div class="env-item"><span class="env-label">Operating System</span><span class="env-value">${this.escapeHtml(env.os)} ${this.escapeHtml(env.osVersion)}</span></div>
                    <div class="env-item"><span class="env-label">Hostname</span><span class="env-value">${this.escapeHtml(env.hostname)}</span></div>
                    <div class="env-item"><span class="env-label">Username</span><span class="env-value">${this.escapeHtml(env.username)}</span></div>
                </div>
            </div>
            <div class="env-card">
                <div class="env-card-header">
                    <span class="env-card-icon">&#9881;</span>
                    <span class="env-card-title">Runtime Environment</span>
                </div>
                <div class="env-card-body">
                    <div class="env-item"><span class="env-label">Node.js Version</span><span class="env-value">${this.escapeHtml(env.nodeVersion)}</span></div>
                    <div class="env-item"><span class="env-label">Framework Version</span><span class="env-value">${this.escapeHtml(env.frameworkVersion)}</span></div>
                    <div class="env-item"><span class="env-label">Playwright Version</span><span class="env-value">${this.escapeHtml(env.playwrightVersion)}</span></div>
                </div>
            </div>
            <div class="env-card">
                <div class="env-card-header">
                    <span class="env-card-icon">&#128203;</span>
                    <span class="env-card-title">Suite Information</span>
                </div>
                <div class="env-card-body">
                    <div class="env-item"><span class="env-label">Suite Name</span><span class="env-value">${this.escapeHtml(data.suiteName)}</span></div>
                    <div class="env-item"><span class="env-label">Total Projects</span><span class="env-value">${data.totalProjects}</span></div>
                    <div class="env-item"><span class="env-label">Total Scenarios</span><span class="env-value">${data.totalScenarios}</span></div>
                    <div class="env-item"><span class="env-label">Generated At</span><span class="env-value">${new Date(data.generatedAt).toLocaleString()}</span></div>
                </div>
            </div>
            <div class="env-card">
                <div class="env-card-header">
                    <span class="env-card-icon">&#128202;</span>
                    <span class="env-card-title">Execution Summary</span>
                </div>
                <div class="env-card-body">
                    <div class="env-item"><span class="env-label">Total Duration</span><span class="env-value">${data.totalDurationFormatted}</span></div>
                    <div class="env-item"><span class="env-label">Success Rate</span><span class="env-value">${data.successRate}%</span></div>
                    <div class="env-item"><span class="env-label">Passed Projects</span><span class="env-value">${data.passedProjects} / ${data.totalProjects}</span></div>
                    <div class="env-item"><span class="env-label">Passed Scenarios</span><span class="env-value">${data.passedScenarios} / ${data.totalScenarios}</span></div>
                </div>
            </div>
        </div>`;
    }

    private static generateFooter(): string {
        return `
        <footer class="footer">
            <div class="footer-brand">CS Playwright Test Framework</div>
            <div class="footer-text">MohammedAKhan Framework &copy; ${new Date().getFullYear()} | Multi-Project Test Suite Report</div>
        </footer>`;
    }

    private static generateJavaScript(data: ConsolidatedReportData): string {
        return `
        Chart.register(ChartDataLabels);
        const reportData = ${JSON.stringify(data)};

        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                item.classList.add('active');
                document.getElementById(item.dataset.view).classList.add('active');
            });
        });

        // Scenario Filters
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                filterScenarios();
            });
        });

        document.getElementById('project-filter')?.addEventListener('change', filterScenarios);
        document.getElementById('feature-filter')?.addEventListener('change', filterScenarios);

        function filterScenarios() {
            const statusFilter = document.querySelector('.filter-btn.active')?.dataset.filter || 'all';
            const projectFilter = document.getElementById('project-filter')?.value || '';
            const featureFilter = document.getElementById('feature-filter')?.value || '';

            document.querySelectorAll('.scenario-row, .error-row').forEach(row => {
                const status = row.dataset.status;
                const project = row.dataset.project;
                const feature = row.dataset.feature;

                let show = true;
                if (statusFilter !== 'all' && status !== statusFilter) show = false;
                if (projectFilter && project !== projectFilter) show = false;
                if (featureFilter && feature !== featureFilter) show = false;

                row.style.display = show ? '' : 'none';
            });
        }

        // Charts with data labels
        const projectNames = reportData.projects.map(p => p.name);
        const passedData = reportData.projects.map(p => p.passed);
        const failedData = reportData.projects.map(p => p.failed);
        const skippedData = reportData.projects.map(p => p.skipped);
        const durationData = reportData.projects.map(p => p.duration);
        const successRateData = reportData.projects.map(p => parseFloat(p.successRate));

        // Results by Project Chart
        new Chart(document.getElementById('projectResultsChart'), {
            type: 'bar',
            data: {
                labels: projectNames,
                datasets: [
                    { label: 'Passed', data: passedData, backgroundColor: '#10b981', borderRadius: 4 },
                    { label: 'Failed', data: failedData, backgroundColor: '#ef4444', borderRadius: 4 },
                    { label: 'Skipped', data: skippedData, backgroundColor: '#f59e0b', borderRadius: 4 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' },
                    datalabels: {
                        display: function(context) { return context.dataset.data[context.dataIndex] > 0; },
                        color: 'white',
                        font: { weight: 'bold', size: 11 },
                        anchor: 'center'
                    }
                },
                scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }
            }
        });

        // Distribution Chart
        new Chart(document.getElementById('distributionChart'), {
            type: 'doughnut',
            data: {
                labels: ['Passed', 'Failed', 'Skipped'],
                datasets: [{
                    data: [reportData.passedScenarios, reportData.failedScenarios, reportData.skippedScenarios || 0],
                    backgroundColor: ['#10b981', '#ef4444', '#f59e0b'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '60%',
                plugins: {
                    legend: { position: 'bottom' },
                    datalabels: {
                        display: function(context) { return context.dataset.data[context.dataIndex] > 0; },
                        color: 'white',
                        font: { weight: 'bold', size: 14 },
                        formatter: function(value, context) {
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const pct = ((value / total) * 100).toFixed(0);
                            return value + ' (' + pct + '%)';
                        }
                    }
                }
            }
        });

        // Duration Chart
        new Chart(document.getElementById('durationChart'), {
            type: 'bar',
            data: {
                labels: projectNames,
                datasets: [{
                    label: 'Duration (seconds)',
                    data: durationData,
                    backgroundColor: '#93186C',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    datalabels: {
                        display: true,
                        color: 'white',
                        font: { weight: 'bold', size: 11 },
                        anchor: 'center',
                        formatter: function(value) { return value.toFixed(1) + 's'; }
                    }
                },
                scales: { x: { beginAtZero: true } }
            }
        });

        // Success Rate Chart
        new Chart(document.getElementById('successRateChart'), {
            type: 'bar',
            data: {
                labels: projectNames,
                datasets: [{
                    label: 'Success Rate (%)',
                    data: successRateData,
                    backgroundColor: successRateData.map(r => r >= 80 ? '#10b981' : r >= 50 ? '#f59e0b' : '#ef4444'),
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    datalabels: {
                        display: true,
                        color: 'white',
                        font: { weight: 'bold', size: 11 },
                        anchor: 'center',
                        formatter: function(value) { return value.toFixed(1) + '%'; }
                    }
                },
                scales: { y: { beginAtZero: true, max: 100 } }
            }
        });

        // Comparison Charts (in Comparison tab)
        if (document.getElementById('comparisonScenarioChart')) {
            new Chart(document.getElementById('comparisonScenarioChart'), {
                type: 'bar',
                data: {
                    labels: projectNames,
                    datasets: [
                        { label: 'Passed', data: passedData, backgroundColor: '#10b981', borderRadius: 4 },
                        { label: 'Failed', data: failedData, backgroundColor: '#ef4444', borderRadius: 4 },
                        { label: 'Skipped', data: skippedData, backgroundColor: '#f59e0b', borderRadius: 4 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom' },
                        datalabels: {
                            display: function(context) { return context.dataset.data[context.dataIndex] > 0; },
                            color: 'white',
                            font: { weight: 'bold', size: 11 }
                        }
                    },
                    scales: { y: { beginAtZero: true } }
                }
            });
        }

        if (document.getElementById('comparisonRateChart')) {
            new Chart(document.getElementById('comparisonRateChart'), {
                type: 'bar',
                data: {
                    labels: projectNames,
                    datasets: [{
                        label: 'Success Rate (%)',
                        data: successRateData,
                        backgroundColor: successRateData.map(r => r >= 80 ? '#10b981' : r >= 50 ? '#f59e0b' : '#ef4444'),
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        datalabels: {
                            display: true,
                            color: 'white',
                            font: { weight: 'bold', size: 12 },
                            anchor: 'center',
                            formatter: function(value) { return value.toFixed(1) + '%'; }
                        }
                    },
                    scales: { y: { beginAtZero: true, max: 100 } }
                }
            });
        }
        `;
    }
}

export default CSConsolidatedReportGenerator;
