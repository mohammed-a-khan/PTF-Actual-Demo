import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import archiver from 'archiver';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from './CSReporter';

export type CaptureMode = 'always' | 'on-failure' | 'on-success' | 'never';

export interface TestResultsConfig {
    baseDir: string;
    createTimestampFolder: boolean;
    zipResults: boolean;
    keepUnzipped: boolean;
    captureSettings: {
        video: CaptureMode;
        screenshot: CaptureMode;
        trace: CaptureMode;
        har: CaptureMode;
        consoleLog: boolean;
    };
}

export class CSTestResultsManager {
    private static instance: CSTestResultsManager;
    private config: CSConfigurationManager;
    private currentTestRunDir: string = '';
    private finalizedZipPath: string | null = null;
    private timestamp: string = '';
    private consoleLogs: any[] = [];
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }
    
    public static getInstance(): CSTestResultsManager {
        if (!CSTestResultsManager.instance) {
            CSTestResultsManager.instance = new CSTestResultsManager();
        }
        return CSTestResultsManager.instance;
    }
    
    /**
     * Initialize test results directory for current test run
     */
    public initializeTestRun(project?: string): string {
        // Check if we're a worker and should use parent's test results directory
        const existingTestResultsDir = this.config.get('TEST_RESULTS_DIR') || process.env.TEST_RESULTS_DIR;
        if (existingTestResultsDir && process.env.IS_WORKER === 'true') {
            this.currentTestRunDir = existingTestResultsDir;
            CSReporter.debug(`[Worker ${process.env.WORKER_ID}] Using parent test results directory: ${this.currentTestRunDir}`);
            return this.currentTestRunDir;
        }

        const baseDir = this.config.get('REPORTS_BASE_DIR', './reports');
        const createTimestampFolder = this.config.getBoolean('REPORTS_CREATE_TIMESTAMP_FOLDER', true);

        // Ensure base directory exists
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        // Create timestamp folder
        if (createTimestampFolder) {
            this.timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
            this.currentTestRunDir = path.join(baseDir, `test-results-${this.timestamp}`);
        } else {
            this.currentTestRunDir = baseDir;
        }

        // Create directory structure
        this.createDirectoryStructure();

        // Store the directory in config so it can be accessed by other components
        CSConfigurationManager.getInstance().set('TEST_RESULTS_DIR', this.currentTestRunDir);

        CSReporter.info(`Test results directory initialized: ${this.currentTestRunDir}`);
        return this.currentTestRunDir;
    }
    
    /**
     * Create standard directory structure for test results
     */
    private createDirectoryStructure(): void {
        const directories = [
            this.currentTestRunDir,
            path.join(this.currentTestRunDir, 'videos'),
            path.join(this.currentTestRunDir, 'screenshots'),
            path.join(this.currentTestRunDir, 'traces'),
            path.join(this.currentTestRunDir, 'har'),
            path.join(this.currentTestRunDir, 'console-logs'),
            path.join(this.currentTestRunDir, 'reports')
        ];
        
        directories.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }
    
    /**
     * Get directory paths for different artifact types
     */
    public getDirectories() {
        // Use currentTestRunDir if available, otherwise get from config (for worker processes)
        let baseDir = this.currentTestRunDir;
        if (!baseDir) {
            baseDir = this.config.get('TEST_RESULTS_DIR', '');
            if (!baseDir) {
                // Fallback: create a default directory if none exists
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
                baseDir = path.join(process.cwd(), 'reports', `test-results-${timestamp}`);
                CSReporter.debug(`Test results directory not set, using fallback: ${baseDir}`);
            }
        }

        return {
            base: baseDir,
            videos: path.join(baseDir, 'videos'),
            screenshots: path.join(baseDir, 'screenshots'),
            traces: path.join(baseDir, 'traces'),
            har: path.join(baseDir, 'har'),
            consoleLogs: path.join(baseDir, 'console-logs'),
            reports: path.join(baseDir, 'reports')
        };
    }
    
    /**
     * Get artifact paths with proper naming
     */
    public getArtifactPath(type: 'video' | 'screenshot' | 'trace' | 'har', scenarioName: string, status?: 'pass' | 'fail'): string {
        const dirs = this.getDirectories();
        const sanitizedName = scenarioName.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const statusPrefix = status ? `${status}-` : '';
        
        switch (type) {
            case 'video':
                return path.join(dirs.videos, `${statusPrefix}${sanitizedName}-${timestamp}.webm`);
            case 'screenshot':
                return path.join(dirs.screenshots, `${statusPrefix}${sanitizedName}-${timestamp}.png`);
            case 'trace':
                return path.join(dirs.traces, `${statusPrefix}${sanitizedName}-${timestamp}.zip`);
            case 'har':
                return path.join(dirs.har, `${statusPrefix}${sanitizedName}-${timestamp}.har`);
            default:
                return path.join(this.currentTestRunDir, `${statusPrefix}${sanitizedName}-${timestamp}`);
        }
    }
    
    /**
     * Determine if artifact should be captured based on mode and test status
     */
    public shouldCaptureArtifact(artifactType: 'video' | 'screenshot' | 'trace' | 'har', testPassed: boolean): boolean {
        const modeConfig = {
            video: this.config.get('BROWSER_VIDEO', 'on-failure'),
            screenshot: this.config.get('SCREENSHOT_CAPTURE_MODE', 'on-failure'),
            trace: this.config.get('TRACE_CAPTURE_MODE', 'on-failure'),
            har: this.config.get('HAR_CAPTURE_MODE', 'never')
        };
        
        const mode = modeConfig[artifactType] as CaptureMode;
        
        switch (mode) {
            case 'always':
                return true;
            case 'on-failure':
                return !testPassed;
            case 'on-success':
                return testPassed;
            case 'never':
                return false;
            default:
                return !testPassed; // Default to on-failure
        }
    }
    
    /**
     * Add console log entry
     */
    public addConsoleLog(type: string, message: string, timestamp?: Date): void {
        if (this.config.getBoolean('CONSOLE_LOG_CAPTURE', true)) {
            this.consoleLogs.push({
                timestamp: timestamp || new Date(),
                type,
                message
            });
        }
    }
    
    /**
     * Save console logs to file
     */
    public saveConsoleLogs(scenarioName?: string): void {
        if (this.consoleLogs.length === 0) return;
        
        const dirs = this.getDirectories();
        const filename = scenarioName 
            ? `${scenarioName.replace(/[^a-zA-Z0-9]/g, '-')}-console.log`
            : 'console.log';
        const filepath = path.join(dirs.consoleLogs, filename);
        
        const content = this.consoleLogs
            .map(log => `[${log.timestamp.toISOString()}] [${log.type.toUpperCase()}] ${log.message}`)
            .join('\n');
        
        fs.writeFileSync(filepath, content);
        CSReporter.debug(`Console logs saved: ${filepath}`);
        
        // Clear logs after saving
        this.consoleLogs = [];
    }
    
    
    /**
     * Finalize test run and optionally zip results
     */
    /**
     * Create a zip archive of the test results
     * @returns Path to the created zip file
     */
    public async createTestResultsZip(): Promise<string> {
        // If already zipped, return the existing path
        if (this.finalizedZipPath) {
            CSReporter.debug(`Zip already exists: ${this.finalizedZipPath}`);
            return this.finalizedZipPath;
        }

        const zipPath = `${this.currentTestRunDir}.zip`;

        // Check if zip already exists
        if (fs.existsSync(zipPath)) {
            CSReporter.info(`Zip file already exists: ${zipPath}`);
            this.finalizedZipPath = zipPath;
            return zipPath;
        }

        // Check if directory has any meaningful content before zipping
        const hasContent = this.directoryHasContent(this.currentTestRunDir);
        if (!hasContent) {
            CSReporter.warn(`[ResultsManager] Test results directory is empty - skipping zip creation`);
            return ''; // Return empty string to signal no zip
        }

        CSReporter.info(`Creating zip archive: ${zipPath}`);
        await this.zipDirectory(this.currentTestRunDir, zipPath);

        // Verify zip has meaningful size (>1KB, empty zips are ~22 bytes)
        if (fs.existsSync(zipPath)) {
            const stats = fs.statSync(zipPath);
            if (stats.size < 1024) {
                CSReporter.warn(`[ResultsManager] Zip file is too small (${stats.size} bytes) - likely empty, skipping`);
                fs.unlinkSync(zipPath); // Delete empty zip
                return ''; // Return empty string to signal no meaningful content
            }
        }

        this.finalizedZipPath = zipPath;
        CSReporter.info(`✅ Test results zipped successfully: ${zipPath}`);

        return zipPath;
    }

    /**
     * Finalize test run - handles zipping based on configuration
     */
    public async finalizeTestRun(): Promise<string> {
        const zipResults = this.config.getBoolean('REPORTS_ZIP_RESULTS', false);
        const keepUnzipped = this.config.getBoolean('REPORTS_KEEP_UNZIPPED', true);

        CSReporter.debug(`Finalize test run - zipResults: ${zipResults}`);

        if (!zipResults) {
            CSReporter.info(`Test results available at: ${this.currentTestRunDir}`);
            return this.currentTestRunDir;
        }

        // Create zip file
        const zipPath = await this.createTestResultsZip();

        // Remove unzipped folder if configured
        if (!keepUnzipped) {
            this.removeDirectory(this.currentTestRunDir);
            CSReporter.info(`Original test results folder removed (keepUnzipped=false)`);
        } else {
            CSReporter.info(`Original results folder kept: ${this.currentTestRunDir}`);
        }

        return zipPath;
    }
    
    /**
     * Zip a directory (cross-platform using archiver library)
     */
    private zipDirectory(sourceDir: string, outPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                // Create write stream for output file
                const output = fs.createWriteStream(outPath);
                const archive = archiver('zip', {
                    zlib: { level: 9 } // Maximum compression
                });

                // Listen for errors
                output.on('error', (err: any) => {
                    CSReporter.error(`Output stream error: ${err}`);
                    reject(err);
                });

                archive.on('error', (err: any) => {
                    CSReporter.error(`Archive error: ${err}`);
                    reject(err);
                });

                // Listen for completion
                output.on('close', () => {
                    const stats = fs.statSync(outPath);
                    CSReporter.debug(`Zip created: ${stats.size} bytes (${archive.pointer()} total bytes)`);
                    resolve();
                });

                // Pipe archive data to the file
                archive.pipe(output);

                // Add directory contents to archive
                const sourceName = path.basename(sourceDir);
                archive.directory(sourceDir, sourceName);

                // Finalize the archive
                archive.finalize();
            } catch (error) {
                CSReporter.error(`Failed to create zip: ${error}`);
                reject(error);
            }
        });
    }
    
    /**
     * Remove directory recursively
     */
    private removeDirectory(dir: string): void {
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).forEach(file => {
                const curPath = path.join(dir, file);
                if (fs.lstatSync(curPath).isDirectory()) {
                    this.removeDirectory(curPath);
                } else {
                    fs.unlinkSync(curPath);
                }
            });
            fs.rmdirSync(dir);
        }
    }
    
    /**
     * Check if directory has meaningful content (files other than just empty subdirectories)
     */
    private directoryHasContent(dir: string): boolean {
        if (!fs.existsSync(dir)) {
            return false;
        }

        try {
            const files = fs.readdirSync(dir);

            for (const file of files) {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);

                if (stat.isFile() && stat.size > 0) {
                    // Found a non-empty file
                    return true;
                } else if (stat.isDirectory()) {
                    // Recursively check subdirectories
                    if (this.directoryHasContent(filePath)) {
                        return true;
                    }
                }
            }

            return false; // No meaningful content found
        } catch (error) {
            CSReporter.debug(`Error checking directory content: ${error}`);
            return false;
        }
    }

    /**
     * Get current test run directory
     */
    public getCurrentTestRunDir(): string {
        return this.currentTestRunDir;
    }

    public getFinalizedPath(): string | null {
        return this.finalizedZipPath || this.currentTestRunDir;
    }

    /**
     * Get the zip path if it exists, otherwise null
     */
    public getZipPath(): string | null {
        return this.finalizedZipPath;
    }

    /**
     * Check if test results have been zipped
     */
    public isZipped(): boolean {
        return this.finalizedZipPath !== null;
    }
    
    /**
     * Get timestamp of current test run
     */
    public getTimestamp(): string {
        return this.timestamp;
    }
}