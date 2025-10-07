/**
 * Captures terminal console output for parallel test execution
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

export class CSTerminalLogCapture {
    private static instance: CSTerminalLogCapture;
    private logs: string[] = [];
    private originalConsoleLog: typeof console.log;
    private originalConsoleError: typeof console.error;
    private originalConsoleWarn: typeof console.warn;
    private originalConsoleInfo: typeof console.info;
    private originalConsoleDebug: typeof console.debug;
    private originalStdoutWrite: typeof process.stdout.write;
    private originalStderrWrite: typeof process.stderr.write;
    private isCapturing: boolean = false;

    private constructor() {
        // Store original methods
        this.originalConsoleLog = console.log;
        this.originalConsoleError = console.error;
        this.originalConsoleWarn = console.warn;
        this.originalConsoleInfo = console.info;
        this.originalConsoleDebug = console.debug;
        this.originalStdoutWrite = process.stdout.write.bind(process.stdout);
        this.originalStderrWrite = process.stderr.write.bind(process.stderr);
    }

    public static getInstance(): CSTerminalLogCapture {
        if (!CSTerminalLogCapture.instance) {
            CSTerminalLogCapture.instance = new CSTerminalLogCapture();
        }
        return CSTerminalLogCapture.instance;
    }

    /**
     * Start capturing terminal output
     */
    public startCapture(): void {
        if (this.isCapturing) return;
        this.isCapturing = true;
        this.logs = [];

        const self = this;

        // Intercept console methods
        console.log = function(...args: any[]) {
            const message = args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            ).join(' ');
            self.logs.push(`[${new Date().toISOString()}] [LOG] ${message}`);
            self.originalConsoleLog.apply(console, args);
        };

        console.error = function(...args: any[]) {
            const message = args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            ).join(' ');
            self.logs.push(`[${new Date().toISOString()}] [ERROR] ${message}`);
            self.originalConsoleError.apply(console, args);
        };

        console.warn = function(...args: any[]) {
            const message = args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            ).join(' ');
            self.logs.push(`[${new Date().toISOString()}] [WARN] ${message}`);
            self.originalConsoleWarn.apply(console, args);
        };

        console.info = function(...args: any[]) {
            const message = args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            ).join(' ');
            self.logs.push(`[${new Date().toISOString()}] [INFO] ${message}`);
            self.originalConsoleInfo.apply(console, args);
        };

        console.debug = function(...args: any[]) {
            const message = args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            ).join(' ');
            self.logs.push(`[${new Date().toISOString()}] [DEBUG] ${message}`);
            self.originalConsoleDebug.apply(console, args);
        };

        // Intercept stdout and stderr
        process.stdout.write = function(chunk: any, ...args: any[]): boolean {
            const text = chunk?.toString ? chunk.toString() : String(chunk);
            // Clean up ANSI color codes
            const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '');
            if (cleanText.trim()) {
                self.logs.push(cleanText);
            }
            return self.originalStdoutWrite.call(process.stdout, chunk, ...args);
        };

        process.stderr.write = function(chunk: any, ...args: any[]): boolean {
            const text = chunk?.toString ? chunk.toString() : String(chunk);
            // Clean up ANSI color codes
            const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '');
            if (cleanText.trim()) {
                self.logs.push(`[STDERR] ${cleanText}`);
            }
            return self.originalStderrWrite.call(process.stderr, chunk, ...args);
        };
    }

    /**
     * Stop capturing and restore original methods
     */
    public stopCapture(): void {
        if (!this.isCapturing) return;
        this.isCapturing = false;

        // Restore original methods
        console.log = this.originalConsoleLog;
        console.error = this.originalConsoleError;
        console.warn = this.originalConsoleWarn;
        console.info = this.originalConsoleInfo;
        console.debug = this.originalConsoleDebug;
        process.stdout.write = this.originalStdoutWrite;
        process.stderr.write = this.originalStderrWrite;
    }

    /**
     * Save captured logs to file
     */
    public saveLogs(filePath?: string): string {
        const config = CSConfigurationManager.getInstance();
        const testResultsDir = config.get('TEST_RESULTS_DIR', './reports/test-results');

        if (!filePath) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            filePath = path.join(testResultsDir, 'console-logs', `terminal-output-${timestamp}.log`);
        }

        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write logs to file
        const content = this.logs.join('\n');
        fs.writeFileSync(filePath, content, 'utf8');

        return filePath;
    }

    /**
     * Get current logs
     */
    public getLogs(): string[] {
        return [...this.logs];
    }

    /**
     * Clear logs
     */
    public clearLogs(): void {
        this.logs = [];
    }

    /**
     * Add a log entry manually
     */
    public addLog(message: string): void {
        this.logs.push(message);
    }
}