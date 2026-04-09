import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import * as http from 'http';

// Lazy load to avoid circular deps
let CSBrowserManager: any = null;

export interface BrowserSessionInfo {
    id: string;
    browserType: string;
    url: string;
    title: string;
    status: 'active' | 'idle' | 'closed';
    startTime: number;
    pageCount: number;
}

export interface TestExecutionInfo {
    currentScenario: string;
    currentStep: string;
    currentFeature: string;
    stepProgress: string;
    scenarioStatus: string;
    stepsExecuted: number;
    stepsPassed: number;
    stepsFailed: number;
    duration: number;
}

/**
 * CSBrowserDashboard - Live Test Execution Dashboard
 *
 * Shows real-time test execution state:
 * - Which scenario & step is currently running
 * - Step progress (5 of 12), pass/fail counts
 * - Current page URL, title, live screenshot
 * - Browser session info
 */
export class CSBrowserDashboard {
    private static instance: CSBrowserDashboard;
    private config: CSConfigurationManager;
    private httpServer: http.Server | null = null;
    private port: number;
    private running: boolean = false;

    // Push-based state — updated by CSBDDRunner via notify* methods
    private _scenario: string = '';
    private _feature: string = '';
    private _step: string = '';
    private _totalSteps: number = 0;
    private _stepsExecuted: number = 0;
    private _stepsPassed: number = 0;
    private _stepsFailed: number = 0;
    private _scenarioStartTime: number = 0;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.port = this.config.getNumber('BROWSER_DASHBOARD_PORT', 8082);
    }

    public static getInstance(): CSBrowserDashboard {
        if (!CSBrowserDashboard.instance) {
            CSBrowserDashboard.instance = new CSBrowserDashboard();
        }
        return CSBrowserDashboard.instance;
    }

    public async startDashboard(port?: number): Promise<void> {
        if (!this.config.getBoolean('BROWSER_DASHBOARD_ENABLED', false)) {
            CSReporter.debug('Browser dashboard is disabled');
            return;
        }
        if (this.running) return;

        const serverPort = port || this.port;
        this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));

        return new Promise<void>((resolve) => {
            this.httpServer!.listen(serverPort, () => {
                this.running = true;
                CSReporter.info(`📊 Browser dashboard: http://localhost:${serverPort}`);
                resolve();
            });
            this.httpServer!.on('error', (error: any) => {
                if (error.code === 'EADDRINUSE') {
                    this.httpServer!.listen(serverPort + 1, () => {
                        this.running = true;
                        CSReporter.info(`📊 Browser dashboard: http://localhost:${serverPort + 1}`);
                        resolve();
                    });
                } else {
                    CSReporter.debug(`Dashboard start failed: ${error.message}`);
                    resolve(); // don't block test execution
                }
            });
        });
    }

    public async stopDashboard(): Promise<void> {
        if (!this.running || !this.httpServer) return;
        return new Promise<void>((resolve) => {
            this.httpServer!.close(() => {
                this.running = false;
                this.httpServer = null;
                resolve();
            });
        });
    }

    public isRunning(): boolean { return this.running; }

    // ========================================================================
    // Data collection — reads from CSReporter, CSScenarioContext, CSBrowserManager
    // ========================================================================

    private getExecutionInfo(): TestExecutionInfo {
        let status = 'idle';
        if (this._scenario) {
            if (this._stepsFailed > 0) status = 'failing';
            else if (this._stepsExecuted > 0) status = 'running';
            else status = 'starting';
        }

        let progress = '';
        if (this._totalSteps > 0) progress = `${this._stepsExecuted} of ${this._totalSteps}`;
        else if (this._stepsExecuted > 0) progress = `${this._stepsExecuted} executed`;

        return {
            currentScenario: this._scenario,
            currentStep: this._step,
            currentFeature: this._feature,
            stepProgress: progress,
            scenarioStatus: status,
            stepsExecuted: this._stepsExecuted,
            stepsPassed: this._stepsPassed,
            stepsFailed: this._stepsFailed,
            duration: this._scenarioStartTime > 0 ? Date.now() - this._scenarioStartTime : 0,
        };
    }

    private async getBrowserInfo(): Promise<BrowserSessionInfo | null> {
        try {
            if (!CSBrowserManager) {
                try { CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager; } catch { return null; }
            }
            const manager = CSBrowserManager.getInstance();
            const browser = manager.getBrowser?.();
            const page = manager.getPage?.();
            if (!browser) return null;

            let url = '';
            let title = '';
            let pageCount = 0;

            if (page && !page.isClosed?.()) {
                try { url = page.url?.() || ''; } catch { /* */ }
                try { title = await page.title?.() || ''; } catch { /* */ }
            }

            try {
                const contexts = browser.contexts?.() || [];
                for (const ctx of contexts) {
                    pageCount += (ctx.pages?.() || []).length;
                }
            } catch { /* */ }

            return {
                id: 'main',
                browserType: manager.currentBrowserType || 'chromium',
                url,
                title,
                status: page && !page.isClosed?.() ? 'active' : 'idle',
                startTime: Date.now(),
                pageCount,
            };
        } catch {
            return null;
        }
    }

    /**
     * Called by CSBDDRunner when a new scenario starts.
     */
    public notifyScenarioStart(scenarioName: string, totalSteps: number, featureName?: string): void {
        this._scenario = scenarioName;
        this._feature = featureName || '';
        this._totalSteps = totalSteps;
        this._stepsExecuted = 0;
        this._stepsPassed = 0;
        this._stepsFailed = 0;
        this._step = '';
        this._scenarioStartTime = Date.now();
    }

    /**
     * Called by CSBDDRunner when a step starts.
     */
    public notifyStepStart(stepText: string): void {
        this._step = stepText;
    }

    /**
     * Called by CSBDDRunner when a step completes.
     */
    public notifyStepEnd(status: 'passed' | 'failed'): void {
        this._stepsExecuted++;
        if (status === 'passed') this._stepsPassed++;
        else this._stepsFailed++;
    }

    /**
     * Called by CSBDDRunner when a scenario ends.
     */
    public notifyScenarioEnd(): void {
        this._step = '';
    }

    // ========================================================================
    // HTTP handlers
    // ========================================================================

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = req.url || '/';
        if (url === '/api/state') this.handleStateAPI(res);
        else if (url.startsWith('/api/screenshot')) this.handleScreenshotAPI(res);
        else if (url === '/' || url === '/index.html') this.serveDashboardHTML(res);
        else { res.writeHead(404); res.end('Not found'); }
    }

    private async handleStateAPI(res: http.ServerResponse): Promise<void> {
        try {
            const execution = this.getExecutionInfo();
            const browser = await this.getBrowserInfo();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ execution, browser, timestamp: Date.now() }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `${e}` }));
        }
    }

    private async handleScreenshotAPI(res: http.ServerResponse): Promise<void> {
        try {
            if (!CSBrowserManager) {
                try { CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager; } catch { /* */ }
            }
            const page = CSBrowserManager?.getInstance()?.getPage?.();
            if (!page || page.isClosed?.()) {
                res.writeHead(404); res.end('No page'); return;
            }
            const buf = await page.screenshot({ type: 'jpeg', quality: 50, timeout: 5000 });
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
            res.end(buf);
        } catch {
            res.writeHead(500); res.end('Screenshot failed');
        }
    }

    private serveDashboardHTML(res: http.ServerResponse): void {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
    }
}

// ============================================================================
// Dashboard HTML — shows live test execution state
// ============================================================================

const DASHBOARD_HTML = `<!DOCTYPE html>
<html>
<head>
    <title>CS Playwright - Live Dashboard</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }

        .header { text-align: center; margin-bottom: 24px; }
        .header h1 { color: #38bdf8; font-size: 22px; }
        .header p { color: #64748b; font-size: 13px; margin-top: 4px; }

        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 1200px; margin: 0 auto; }
        @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

        .card { background: #1e293b; border-radius: 10px; padding: 20px; border: 1px solid #334155; }
        .card h2 { font-size: 14px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px; }

        /* Scenario info */
        .scenario-name { font-size: 18px; font-weight: 600; color: #f1f5f9; margin-bottom: 8px; word-break: break-word; }
        .feature-name { font-size: 12px; color: #64748b; margin-bottom: 12px; }
        .step-current { font-size: 14px; color: #38bdf8; margin-bottom: 12px; font-family: monospace; word-break: break-word; padding: 8px 12px; background: #0f172a; border-radius: 6px; border-left: 3px solid #38bdf8; }

        /* Progress bar */
        .progress-container { margin-bottom: 12px; }
        .progress-bar { height: 8px; background: #334155; border-radius: 4px; overflow: hidden; }
        .progress-fill { height: 100%; border-radius: 4px; transition: width 0.5s ease; }
        .progress-fill.ok { background: linear-gradient(90deg, #22c55e, #4ade80); }
        .progress-fill.err { background: linear-gradient(90deg, #ef4444, #f87171); }
        .progress-label { font-size: 12px; color: #64748b; margin-top: 4px; display: flex; justify-content: space-between; }

        /* Step counters */
        .counters { display: flex; gap: 12px; margin-bottom: 12px; }
        .counter { text-align: center; flex: 1; padding: 10px; background: #0f172a; border-radius: 8px; }
        .counter-value { font-size: 22px; font-weight: 700; }
        .counter-value.pass { color: #22c55e; }
        .counter-value.fail { color: #ef4444; }
        .counter-value.total { color: #38bdf8; }
        .counter-label { font-size: 11px; color: #64748b; margin-top: 2px; }

        /* Browser info */
        .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #1e293b; font-size: 13px; }
        .info-row:last-child { border-bottom: none; }
        .info-label { color: #64748b; }
        .info-value { color: #e2e8f0; text-align: right; max-width: 60%; word-break: break-all; }
        .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
        .status-dot.active { background: #22c55e; }
        .status-dot.idle { background: #f59e0b; }
        .status-dot.closed { background: #ef4444; }

        /* Screenshot */
        .screenshot-frame { margin-top: 12px; text-align: center; }
        .screenshot-img { max-width: 100%; border-radius: 6px; border: 1px solid #334155; }

        /* Timer */
        .timer { font-size: 24px; font-weight: 700; color: #f59e0b; text-align: center; font-family: monospace; }

        /* Idle state */
        .idle-state { text-align: center; color: #475569; padding: 40px 20px; }
        .idle-state .icon { font-size: 48px; margin-bottom: 12px; }
        .idle-state p { font-size: 14px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 CS Playwright Live Dashboard</h1>
        <p>Auto-refreshes every second</p>
    </div>

    <div id="content">
        <div class="idle-state">
            <div class="icon">⏳</div>
            <p>Waiting for test execution to start...</p>
        </div>
    </div>

    <script>
        function fmt(ms) {
            if (!ms || ms <= 0) return '0s';
            var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
            if (h > 0) return h + 'h ' + (m % 60) + 'm ' + (s % 60) + 's';
            if (m > 0) return m + 'm ' + (s % 60) + 's';
            return s + 's';
        }

        function truncUrl(u, max) {
            if (!u) return '—';
            return u.length > max ? u.substring(0, max - 3) + '...' : u;
        }

        async function refresh() {
            try {
                var res = await fetch('/api/state');
                var d = await res.json();
                var ex = d.execution || {};
                var br = d.browser;
                var el = document.getElementById('content');

                if (!ex.currentScenario && !br) {
                    el.innerHTML = '<div class="idle-state"><div class="icon">⏳</div><p>Waiting for test execution to start...</p></div>';
                    return;
                }

                var pct = 0;
                if (ex.stepsExecuted > 0) {
                    var total = parseInt((ex.stepProgress || '').split('of')[1]) || ex.stepsExecuted;
                    pct = Math.min(100, Math.round((ex.stepsExecuted / total) * 100));
                }
                var hasErr = ex.stepsFailed > 0;

                var html = '<div class="grid">';

                // Left column: test execution
                html += '<div class="card">';
                html += '<h2>🧪 Current Test</h2>';
                if (ex.currentScenario) {
                    html += '<div class="scenario-name">' + ex.currentScenario + '</div>';
                    if (ex.currentFeature) html += '<div class="feature-name">📁 ' + ex.currentFeature + '</div>';
                    if (ex.currentStep) html += '<div class="step-current">' + ex.currentStep + '</div>';

                    html += '<div class="progress-container">';
                    html += '<div class="progress-bar"><div class="progress-fill ' + (hasErr ? 'err' : 'ok') + '" style="width:' + pct + '%"></div></div>';
                    html += '<div class="progress-label"><span>' + (ex.stepProgress || '') + '</span><span>' + pct + '%</span></div>';
                    html += '</div>';

                    html += '<div class="counters">';
                    html += '<div class="counter"><div class="counter-value total">' + ex.stepsExecuted + '</div><div class="counter-label">Steps Run</div></div>';
                    html += '<div class="counter"><div class="counter-value pass">' + ex.stepsPassed + '</div><div class="counter-label">Passed</div></div>';
                    html += '<div class="counter"><div class="counter-value fail">' + ex.stepsFailed + '</div><div class="counter-label">Failed</div></div>';
                    html += '</div>';

                    html += '<div class="timer">' + fmt(ex.duration) + '</div>';
                } else {
                    html += '<div class="idle-state"><div class="icon">✅</div><p>Between scenarios...</p></div>';
                }
                html += '</div>';

                // Right column: browser + screenshot
                html += '<div class="card">';
                html += '<h2>🌐 Browser</h2>';
                if (br) {
                    var statusCls = br.status === 'active' ? 'active' : br.status === 'idle' ? 'idle' : 'closed';
                    html += '<div class="info-row"><span class="info-label">Status</span><span class="info-value"><span class="status-dot ' + statusCls + '"></span>' + br.status + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">Browser</span><span class="info-value">' + (br.browserType || 'chromium') + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">URL</span><span class="info-value">' + truncUrl(br.url, 60) + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">Title</span><span class="info-value">' + (br.title || '—') + '</span></div>';
                    html += '<div class="info-row"><span class="info-label">Pages</span><span class="info-value">' + br.pageCount + '</span></div>';

                    html += '<div class="screenshot-frame">';
                    html += '<img class="screenshot-img" src="/api/screenshot?' + Date.now() + '" onerror="this.style.display=\'none\'" alt="Live screenshot">';
                    html += '</div>';
                } else {
                    html += '<div class="idle-state"><p>No browser session</p></div>';
                }
                html += '</div>';

                html += '</div>';
                el.innerHTML = html;
            } catch(e) {
                // silent on network errors during polling
            }
        }

        setInterval(refresh, 1000);
        refresh();
    </script>
</body>
</html>`;
