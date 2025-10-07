import * as WebSocket from 'ws';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';

export interface DashboardUpdate {
    type: 'test-update' | 'suite-update' | 'log' | 'screenshot' | 'error';
    timestamp: number;
    data: any;
}

export interface TestStatus {
    testId: string;
    name: string;
    status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
    progress: number;
    duration?: number;
    currentStep?: string;
    error?: string;
    screenshot?: string;
}

export class CSLiveDashboard {
    private static instance: CSLiveDashboard;
    private config: CSConfigurationManager;
    private wsServer: WebSocket.Server | null = null;
    private httpServer: http.Server | null = null;
    private clients: Set<WebSocket.WebSocket> = new Set();
    private testStatuses: Map<string, TestStatus> = new Map();
    private logs: string[] = [];
    private startTime: number = Date.now();
    private port: number;
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.port = this.config.getNumber('DASHBOARD_WS_PORT', 8080);
    }
    
    public static getInstance(): CSLiveDashboard {
        if (!CSLiveDashboard.instance) {
            CSLiveDashboard.instance = new CSLiveDashboard();
        }
        return CSLiveDashboard.instance;
    }
    
    public async start(): Promise<void> {
        if (!this.config.getBoolean('DASHBOARD_ENABLED', false)) {
            CSReporter.debug('Live dashboard is disabled');
            return;
        }
        
        try {
            // Create HTTP server for dashboard UI
            this.httpServer = http.createServer((req, res) => {
                this.handleHttpRequest(req, res);
            });
            
            // Create WebSocket server
            this.wsServer = new WebSocket.Server({ 
                server: this.httpServer 
            });
            
            this.wsServer.on('connection', (socket) => {
                this.handleNewConnection(socket);
            });
            
            // Start listening
            await new Promise<void>((resolve, reject) => {
                this.httpServer!.listen(this.port, () => {
                    CSReporter.info(`Live dashboard started at http://localhost:${this.port}`);
                    resolve();
                }).on('error', reject);
            });
            
            // Auto-open dashboard if configured
            if (this.config.getBoolean('DASHBOARD_AUTO_OPEN', false)) {
                this.openDashboard();
            }
            
        } catch (error: any) {
            CSReporter.error(`Failed to start dashboard: ${error.message}`);
        }
    }
    
    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.url === '/' || req.url === '/dashboard') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(this.getDashboardHTML());
        } else if (req.url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this.getStatus()));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }
    
    private handleNewConnection(socket: WebSocket.WebSocket): void {
        this.clients.add(socket);
        CSReporter.debug('Dashboard client connected');
        
        // Send initial state
        this.sendInitialState(socket);
        
        // Handle messages from client
        socket.on('message', (message) => {
            this.handleClientMessage(socket, message.toString());
        });
        
        // Handle disconnection
        socket.on('close', () => {
            this.clients.delete(socket);
            CSReporter.debug('Dashboard client disconnected');
        });
        
        // Handle errors
        socket.on('error', (error) => {
            CSReporter.warn(`Dashboard WebSocket error: ${error.message}`);
        });
    }
    
    private sendInitialState(socket: WebSocket.WebSocket): void {
        const state = {
            type: 'initial-state',
            timestamp: Date.now(),
            data: {
                startTime: this.startTime,
                tests: Array.from(this.testStatuses.values()),
                logs: this.logs.slice(-100), // Last 100 logs
                summary: this.getSummary()
            }
        };
        
        this.sendToClient(socket, state);
    }
    
    private handleClientMessage(socket: WebSocket.WebSocket, message: string): void {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'get-logs':
                    this.sendToClient(socket, {
                        type: 'logs',
                        timestamp: Date.now(),
                        data: this.logs
                    });
                    break;
                    
                case 'get-test-details':
                    const test = this.testStatuses.get(data.testId);
                    if (test) {
                        this.sendToClient(socket, {
                            type: 'test-details',
                            timestamp: Date.now(),
                            data: test
                        });
                    }
                    break;
                    
                case 'pause-execution':
                    // Handle pause request
                    CSReporter.info('Execution paused from dashboard');
                    break;
                    
                case 'resume-execution':
                    // Handle resume request
                    CSReporter.info('Execution resumed from dashboard');
                    break;
            }
        } catch (error: any) {
            CSReporter.warn(`Invalid dashboard message: ${error.message}`);
        }
    }
    
    public broadcastUpdate(update: DashboardUpdate): void {
        if (!this.wsServer) return;
        
        const message = JSON.stringify(update);
        
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
    
    private sendToClient(socket: WebSocket.WebSocket, data: any): void {
        if (socket.readyState === WebSocket.WebSocket.OPEN) {
            socket.send(JSON.stringify(data));
        }
    }
    
    public updateTestStatus(status: TestStatus): void {
        this.testStatuses.set(status.testId, status);
        
        this.broadcastUpdate({
            type: 'test-update',
            timestamp: Date.now(),
            data: status
        });
    }
    
    public addLog(level: string, message: string): void {
        const logEntry = `[${new Date().toISOString()}] [${level}] ${message}`;
        this.logs.push(logEntry);
        
        // Keep only last 1000 logs
        if (this.logs.length > 1000) {
            this.logs.shift();
        }
        
        this.broadcastUpdate({
            type: 'log',
            timestamp: Date.now(),
            data: { level, message: logEntry }
        });
    }
    
    public broadcastError(error: string, testId?: string): void {
        this.broadcastUpdate({
            type: 'error',
            timestamp: Date.now(),
            data: { error, testId }
        });
    }
    
    public broadcastScreenshot(testId: string, screenshot: string): void {
        this.broadcastUpdate({
            type: 'screenshot',
            timestamp: Date.now(),
            data: { testId, screenshot }
        });
    }
    
    private getSummary(): any {
        const tests = Array.from(this.testStatuses.values());
        
        return {
            total: tests.length,
            passed: tests.filter(t => t.status === 'passed').length,
            failed: tests.filter(t => t.status === 'failed').length,
            running: tests.filter(t => t.status === 'running').length,
            pending: tests.filter(t => t.status === 'pending').length,
            skipped: tests.filter(t => t.status === 'skipped').length,
            duration: Date.now() - this.startTime
        };
    }
    
    private getStatus(): any {
        return {
            summary: this.getSummary(),
            tests: Array.from(this.testStatuses.values()),
            uptime: Date.now() - this.startTime,
            clients: this.clients.size
        };
    }
    
    private getDashboardHTML(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS Test Automation - Live Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header {
            background: white;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .header h1 { color: #333; margin-bottom: 10px; }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: white;
            border-radius: 8px;
            padding: 15px;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: transform 0.2s;
        }
        .stat-card:hover { transform: translateY(-2px); }
        .stat-card .value { font-size: 2em; font-weight: bold; }
        .stat-card .label { color: #666; margin-top: 5px; }
        .stat-card.passed { border-left: 4px solid #10b981; }
        .stat-card.failed { border-left: 4px solid #ef4444; }
        .stat-card.running { border-left: 4px solid #3b82f6; }
        .stat-card.pending { border-left: 4px solid #6b7280; }
        .tests-grid {
            display: grid;
            gap: 10px;
            margin-bottom: 20px;
        }
        .test-card {
            background: white;
            border-radius: 8px;
            padding: 15px;
            display: flex;
            align-items: center;
            gap: 15px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: all 0.3s;
        }
        .test-card.passed { border-left: 4px solid #10b981; }
        .test-card.failed { border-left: 4px solid #ef4444; }
        .test-card.running { 
            border-left: 4px solid #3b82f6;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.8; }
        }
        .test-icon {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            color: white;
        }
        .test-icon.passed { background: #10b981; }
        .test-icon.failed { background: #ef4444; }
        .test-icon.running { background: #3b82f6; }
        .test-icon.pending { background: #6b7280; }
        .test-info { flex: 1; }
        .test-name { font-weight: 600; color: #333; }
        .test-step { color: #666; font-size: 0.9em; margin-top: 5px; }
        .progress-bar {
            height: 4px;
            background: #e5e7eb;
            border-radius: 2px;
            margin-top: 8px;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            background: #3b82f6;
            transition: width 0.3s;
        }
        .logs {
            background: #1f2937;
            color: #f3f4f6;
            border-radius: 8px;
            padding: 15px;
            height: 300px;
            overflow-y: auto;
            font-family: 'Courier New', monospace;
            font-size: 0.9em;
        }
        .log-entry { margin-bottom: 5px; }
        .log-entry.error { color: #ef4444; }
        .log-entry.warn { color: #f59e0b; }
        .log-entry.info { color: #3b82f6; }
        .log-entry.pass { color: #10b981; }
        .connection-status {
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 10px 20px;
            border-radius: 20px;
            background: white;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .connection-status.connected { border: 2px solid #10b981; }
        .connection-status.disconnected { border: 2px solid #ef4444; }
        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            animation: blink 2s infinite;
        }
        .status-dot.connected { background: #10b981; }
        .status-dot.disconnected { background: #ef4444; }
        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 CS Test Automation - Live Dashboard</h1>
            <p id="project-info">Project: <span id="project-name">-</span> | Environment: <span id="environment">-</span></p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="value" id="total-count">0</div>
                <div class="label">Total Tests</div>
            </div>
            <div class="stat-card passed">
                <div class="value" id="passed-count">0</div>
                <div class="label">Passed</div>
            </div>
            <div class="stat-card failed">
                <div class="value" id="failed-count">0</div>
                <div class="label">Failed</div>
            </div>
            <div class="stat-card running">
                <div class="value" id="running-count">0</div>
                <div class="label">Running</div>
            </div>
            <div class="stat-card pending">
                <div class="value" id="pending-count">0</div>
                <div class="label">Pending</div>
            </div>
        </div>
        
        <div class="tests-grid" id="tests-grid">
            <!-- Test cards will be dynamically added here -->
        </div>
        
        <div class="logs" id="logs">
            <div>Waiting for test execution...</div>
        </div>
    </div>
    
    <div class="connection-status disconnected" id="connection-status">
        <div class="status-dot disconnected" id="status-dot"></div>
        <span id="status-text">Disconnected</span>
    </div>
    
    <script>
        const ws = new WebSocket('ws://localhost:${this.port}');
        const testsGrid = document.getElementById('tests-grid');
        const logs = document.getElementById('logs');
        const connectionStatus = document.getElementById('connection-status');
        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');
        
        const testCards = new Map();
        
        ws.onopen = () => {
            console.log('Connected to dashboard');
            connectionStatus.className = 'connection-status connected';
            statusDot.className = 'status-dot connected';
            statusText.textContent = 'Connected';
        };
        
        ws.onclose = () => {
            console.log('Disconnected from dashboard');
            connectionStatus.className = 'connection-status disconnected';
            statusDot.className = 'status-dot disconnected';
            statusText.textContent = 'Disconnected';
        };
        
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            handleMessage(message);
        };
        
        function handleMessage(message) {
            switch (message.type) {
                case 'initial-state':
                    initializeDashboard(message.data);
                    break;
                case 'test-update':
                    updateTest(message.data);
                    break;
                case 'log':
                    addLog(message.data);
                    break;
                case 'suite-update':
                    updateSummary(message.data);
                    break;
            }
        }
        
        function initializeDashboard(data) {
            updateSummary(data.summary);
            data.tests.forEach(test => updateTest(test));
            data.logs.forEach(log => addLog({ message: log }));
        }
        
        function updateSummary(summary) {
            document.getElementById('total-count').textContent = summary.total || 0;
            document.getElementById('passed-count').textContent = summary.passed || 0;
            document.getElementById('failed-count').textContent = summary.failed || 0;
            document.getElementById('running-count').textContent = summary.running || 0;
            document.getElementById('pending-count').textContent = summary.pending || 0;
        }
        
        function updateTest(test) {
            let card = testCards.get(test.testId);
            
            if (!card) {
                card = createTestCard(test);
                testCards.set(test.testId, card);
                testsGrid.appendChild(card);
            }
            
            // Update card content
            card.className = 'test-card ' + test.status;
            card.querySelector('.test-icon').className = 'test-icon ' + test.status;
            card.querySelector('.test-icon').textContent = getStatusIcon(test.status);
            card.querySelector('.test-name').textContent = test.name;
            
            if (test.currentStep) {
                card.querySelector('.test-step').textContent = test.currentStep;
            }
            
            if (test.progress !== undefined) {
                card.querySelector('.progress-fill').style.width = test.progress + '%';
            }
        }
        
        function createTestCard(test) {
            const card = document.createElement('div');
            card.className = 'test-card ' + test.status;
            card.innerHTML = \`
                <div class="test-icon \${test.status}">\${getStatusIcon(test.status)}</div>
                <div class="test-info">
                    <div class="test-name">\${test.name}</div>
                    <div class="test-step">\${test.currentStep || ''}</div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: \${test.progress || 0}%"></div>
                    </div>
                </div>
            \`;
            return card;
        }
        
        function getStatusIcon(status) {
            switch (status) {
                case 'passed': return '✓';
                case 'failed': return '✗';
                case 'running': return '⚡';
                case 'skipped': return '○';
                default: return '⏸';
            }
        }
        
        function addLog(logData) {
            const entry = document.createElement('div');
            entry.className = 'log-entry ' + (logData.level || 'info').toLowerCase();
            entry.textContent = logData.message;
            logs.appendChild(entry);
            logs.scrollTop = logs.scrollHeight;
            
            // Keep only last 100 logs
            while (logs.children.length > 100) {
                logs.removeChild(logs.firstChild);
            }
        }
    </script>
</body>
</html>`;
    }
    
    private openDashboard(): void {
        const { exec } = require('child_process');
        const url = `http://localhost:${this.port}`;
        
        const platform = process.platform;
        if (platform === 'darwin') {
            exec(`open ${url}`);
        } else if (platform === 'win32') {
            exec(`start ${url}`);
        } else {
            exec(`xdg-open ${url}`);
        }
    }
    
    public async stop(): Promise<void> {
        if (this.wsServer) {
            this.clients.forEach(client => client.close());
            this.wsServer.close();
            this.wsServer = null;
        }
        
        if (this.httpServer) {
            await new Promise<void>((resolve) => {
                this.httpServer!.close(() => resolve());
            });
            this.httpServer = null;
        }
        
        CSReporter.info('Live dashboard stopped');
    }
    
    public isRunning(): boolean {
        return this.wsServer !== null && this.httpServer !== null;
    }
}