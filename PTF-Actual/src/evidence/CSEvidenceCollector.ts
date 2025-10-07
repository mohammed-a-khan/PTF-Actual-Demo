import * as fs from 'fs';
import * as path from 'path';
import * as JSZip from 'jszip';
// Lazy load Playwright for performance
// import { Page } from '@playwright/test';
type Page = any;
import { CSConfigurationManager } from '../core/CSConfigurationManager';
// Lazy load BrowserManager
// import { CSBrowserManager } from '../browser/CSBrowserManager';
let CSBrowserManager: any = null;
import { CSReporter } from '../reporter/CSReporter';

export interface Evidence {
    id: string;
    testName: string;
    timestamp: string;
    screenshot?: Buffer;
    video?: string;
    har?: any;
    console?: LogEntry[];
    network?: NetworkEntry[];
    stackTrace?: string;
    metadata?: any;
}

export interface LogEntry {
    type: string;
    text: string;
    timestamp: number;
    location?: string;
}

export interface NetworkEntry {
    url: string;
    method: string;
    status: number;
    duration: number;
    size: number;
    timestamp: number;
}

export class CSEvidenceCollector {
    private static instance: CSEvidenceCollector;
    private config: CSConfigurationManager;
    private browserManager: any; // CSBrowserManager - lazy loaded
    private evidence: Map<string, Evidence> = new Map();
    private consoleLog: LogEntry[] = [];
    private networkLog: NetworkEntry[] = [];
    private evidencePath: string;
    private isRecording: boolean = false;
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        // Lazy load CSBrowserManager
        if (!CSBrowserManager) {
            CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
        }
        this.browserManager = CSBrowserManager.getInstance();
        this.evidencePath = path.join(
            process.cwd(),
            this.config.get('EVIDENCE_PATH', './evidence')
        );
        
        // Create evidence directory if it doesn't exist
        if (!fs.existsSync(this.evidencePath)) {
            fs.mkdirSync(this.evidencePath, { recursive: true });
        }
    }
    
    public static getInstance(): CSEvidenceCollector {
        if (!CSEvidenceCollector.instance) {
            CSEvidenceCollector.instance = new CSEvidenceCollector();
        }
        return CSEvidenceCollector.instance;
    }
    
    public async startCollection(testName: string): Promise<void> {
        if (!this.config.getBoolean('EVIDENCE_COLLECTION_ENABLED', true)) {
            return;
        }
        
        this.isRecording = true;
        this.consoleLog = [];
        this.networkLog = [];
        
        const page = this.browserManager.getPage();
        
        // Start collecting console logs
        page.on('console', (msg: any) => {
            this.consoleLog.push({
                type: msg.type(),
                text: msg.text(),
                timestamp: Date.now(),
                location: msg.location()?.url
            });
        });
        
        // Start collecting network logs
        page.on('request', (request: any) => {
            const entry: NetworkEntry = {
                url: request.url(),
                method: request.method(),
                status: 0,
                duration: 0,
                size: 0,
                timestamp: Date.now()
            };
            this.networkLog.push(entry);
        });
        
        page.on('response', (response: any) => {
            const entry = this.networkLog.find(e => e.url === response.url());
            if (entry) {
                entry.status = response.status();
                entry.duration = Date.now() - entry.timestamp;
            }
        });
        
        // Start video recording if configured
        const browserVideo = this.config.get('BROWSER_VIDEO', 'off');
        const videoEnabled = (browserVideo !== 'off');

        if (videoEnabled) {
            // Video recording is handled by browser context configuration
            CSReporter.debug(`Video recording started for: ${testName} (mode: ${browserVideo})`);
        }
        
        CSReporter.debug(`Evidence collection started for: ${testName}`);
    }
    
    public async collectOnFailure(testName: string, error?: Error): Promise<string> {
        if (!this.config.getBoolean('AUTO_SAVE_EVIDENCE', true)) {
            return '';
        }
        
        const evidenceId = `${testName.replace(/\s+/g, '_')}_${Date.now()}`;
        
        try {
            const evidence: Evidence = {
                id: evidenceId,
                testName,
                timestamp: new Date().toISOString(),
                screenshot: await this.captureScreenshot(),
                video: await this.captureVideo(),
                har: await this.captureHAR(),
                console: this.consoleLog,
                network: this.networkLog,
                stackTrace: error?.stack,
                metadata: {
                    browser: this.browserManager.getCurrentBrowserType(),
                    project: this.config.get('PROJECT'),
                    environment: this.config.get('ENVIRONMENT'),
                    url: await this.getCurrentUrl()
                }
            };
            
            this.evidence.set(evidenceId, evidence);
            
            // Auto-save evidence if configured
            if (this.config.getBoolean('AUTO_SAVE_EVIDENCE', true)) {
                await this.saveEvidence(evidenceId);
            }
            
            CSReporter.info(`Evidence collected: ${evidenceId}`);
            return evidenceId;
            
        } catch (error: any) {
            CSReporter.error(`Failed to collect evidence: ${error.message}`);
            return '';
        }
    }
    
    private async captureScreenshot(): Promise<Buffer | undefined> {
        try {
            const page = this.browserManager.getPage();
            const screenshot = await page.screenshot({ 
                fullPage: true,
                type: 'png'
            });
            
            // Apply data masking if configured
            if (this.config.getBoolean('EVIDENCE_MASK_SENSITIVE_DATA', true)) {
                return await this.maskSensitiveData(screenshot);
            }
            
            return screenshot;
        } catch (error: any) {
            CSReporter.warn(`Failed to capture screenshot: ${error.message}`);
            return undefined;
        }
    }
    
    private async captureVideo(): Promise<string | undefined> {
        try {
            const page = this.browserManager.getPage();
            const video = await page.video();
            
            if (video) {
                const videoPath = await video.path();
                
                // Trim video if configured
                if (this.config.getBoolean('VIDEO_TRIM_ON_FAILURE', true)) {
                    return await this.trimVideo(videoPath);
                }
                
                return videoPath;
            }
            
            return undefined;
        } catch (error: any) {
            CSReporter.warn(`Failed to capture video: ${error.message}`);
            return undefined;
        }
    }
    
    private async captureHAR(): Promise<any> {
        try {
            const context = this.browserManager.getContext();
            
            // Check if HAR recording was enabled
            const harCaptureMode = this.config.get('HAR_CAPTURE_MODE', 'never');
            const harRecordingEnabled = harCaptureMode !== 'never';

            if (harRecordingEnabled) {
                // HAR would be available if configured during context creation
                // This is a placeholder as actual HAR needs to be configured at context creation
                return {
                    log: {
                        version: '1.2',
                        creator: {
                            name: 'CS Framework',
                            version: '3.0.0'
                        },
                        entries: this.networkLog.map(entry => ({
                            request: {
                                method: entry.method,
                                url: entry.url
                            },
                            response: {
                                status: entry.status
                            },
                            time: entry.duration
                        }))
                    }
                };
            }
            
            return undefined;
        } catch (error: any) {
            CSReporter.warn(`Failed to capture HAR: ${error.message}`);
            return undefined;
        }
    }
    
    private async getCurrentUrl(): Promise<string> {
        try {
            const page = this.browserManager.getPage();
            return page.url();
        } catch {
            return 'unknown';
        }
    }
    
    private async maskSensitiveData(screenshot: Buffer): Promise<Buffer> {
        // In production, use image processing library like sharp
        // This is a placeholder implementation
        
        try {
            const sharp = require('sharp');
            const page = this.browserManager.getPage();
            
            // Find sensitive elements
            const sensitiveSelectors = [
                'input[type="password"]',
                '[data-sensitive="true"]',
                '.credit-card',
                '.ssn',
                ...this.config.getList('SENSITIVE_DATA_SELECTORS')
            ];
            
            // Get bounding boxes of sensitive elements
            const boxes: any[] = [];
            for (const selector of sensitiveSelectors) {
                try {
                    const elements = await page.$$(selector);
                    for (const element of elements) {
                        const box = await element.boundingBox();
                        if (box) {
                            boxes.push(box);
                        }
                    }
                } catch {
                    // Selector might not exist
                }
            }
            
            // Apply blur to sensitive areas
            if (boxes.length > 0) {
                let image = sharp(screenshot);
                
                // This is simplified - actual implementation would overlay blurred regions
                // For now, just return original
                return screenshot;
            }
            
            return screenshot;
            
        } catch (error: any) {
            CSReporter.warn(`Failed to mask sensitive data: ${error.message}`);
            return screenshot;
        }
    }
    
    private async trimVideo(videoPath: string, durationSeconds: number = 10): Promise<string> {
        // In production, use ffmpeg or similar for video processing
        // This is a placeholder implementation
        
        try {
            const trimmedPath = videoPath.replace('.webm', '_trimmed.webm');
            
            // Would use fluent-ffmpeg in production
            // For now, just return original path
            return videoPath;
            
        } catch (error: any) {
            CSReporter.warn(`Failed to trim video: ${error.message}`);
            return videoPath;
        }
    }
    
    public async saveEvidence(evidenceId: string): Promise<string> {
        const evidence = this.evidence.get(evidenceId);
        if (!evidence) {
            throw new Error(`Evidence not found: ${evidenceId}`);
        }
        
        const evidenceDir = path.join(this.evidencePath, evidenceId);
        
        // Create evidence directory
        if (!fs.existsSync(evidenceDir)) {
            fs.mkdirSync(evidenceDir, { recursive: true });
        }
        
        // Save screenshot
        if (evidence.screenshot) {
            const screenshotPath = path.join(evidenceDir, 'screenshot.png');
            fs.writeFileSync(screenshotPath, evidence.screenshot);
        }
        
        // Copy video if exists
        if (evidence.video && fs.existsSync(evidence.video)) {
            const videoName = path.basename(evidence.video);
            const videoDestPath = path.join(evidenceDir, videoName);
            fs.copyFileSync(evidence.video, videoDestPath);
        }
        
        // Save HAR file
        if (evidence.har) {
            const harPath = path.join(evidenceDir, 'network.har');
            fs.writeFileSync(harPath, JSON.stringify(evidence.har, null, 2));
        }
        
        // Save console logs
        if (evidence.console && evidence.console.length > 0) {
            const consolePath = path.join(evidenceDir, 'console.log');
            const consoleContent = evidence.console
                .map(log => `[${new Date(log.timestamp).toISOString()}] [${log.type}] ${log.text}`)
                .join('\n');
            fs.writeFileSync(consolePath, consoleContent);
        }
        
        // Save network logs
        if (evidence.network && evidence.network.length > 0) {
            const networkPath = path.join(evidenceDir, 'network.json');
            fs.writeFileSync(networkPath, JSON.stringify(evidence.network, null, 2));
        }
        
        // Save stack trace
        if (evidence.stackTrace) {
            const stackPath = path.join(evidenceDir, 'stacktrace.txt');
            fs.writeFileSync(stackPath, evidence.stackTrace);
        }
        
        // Save metadata
        const metadataPath = path.join(evidenceDir, 'metadata.json');
        fs.writeFileSync(metadataPath, JSON.stringify(evidence.metadata, null, 2));
        
        CSReporter.info(`Evidence saved to: ${evidenceDir}`);
        return evidenceDir;
    }
    
    public async packageEvidence(evidenceIds: string[]): Promise<Buffer> {
        const zip = new JSZip.default();
        
        for (const evidenceId of evidenceIds) {
            const evidence = this.evidence.get(evidenceId);
            if (!evidence) continue;
            
            const folder = zip.folder(evidenceId);
            if (!folder) continue;
            
            // Add screenshot
            if (evidence.screenshot) {
                folder.file('screenshot.png', evidence.screenshot);
            }
            
            // Add video
            if (evidence.video && fs.existsSync(evidence.video)) {
                const videoContent = fs.readFileSync(evidence.video);
                folder.file(path.basename(evidence.video), videoContent);
            }
            
            // Add HAR
            if (evidence.har) {
                folder.file('network.har', JSON.stringify(evidence.har, null, 2));
            }
            
            // Add console logs
            if (evidence.console && evidence.console.length > 0) {
                const consoleContent = evidence.console
                    .map(log => `[${new Date(log.timestamp).toISOString()}] [${log.type}] ${log.text}`)
                    .join('\n');
                folder.file('console.log', consoleContent);
            }
            
            // Add network logs
            if (evidence.network && evidence.network.length > 0) {
                folder.file('network.json', JSON.stringify(evidence.network, null, 2));
            }
            
            // Add stack trace
            if (evidence.stackTrace) {
                folder.file('stacktrace.txt', evidence.stackTrace);
            }
            
            // Add metadata
            folder.file('metadata.json', JSON.stringify(evidence.metadata, null, 2));
        }
        
        // Generate ZIP buffer
        const zipBuffer = await zip.generateAsync({ 
            type: 'nodebuffer',
            compression: 'DEFLATE',
            compressionOptions: { level: 9 }
        });
        
        CSReporter.info(`Evidence package created with ${evidenceIds.length} items`);
        return zipBuffer;
    }
    
    public async packageAllEvidence(): Promise<string> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const packageName = `evidence_${this.config.get('PROJECT')}_${timestamp}.zip`;
        const packagePath = path.join(this.evidencePath, packageName);
        
        const evidenceIds = Array.from(this.evidence.keys());
        const zipBuffer = await this.packageEvidence(evidenceIds);
        
        fs.writeFileSync(packagePath, zipBuffer);
        
        CSReporter.info(`All evidence packaged to: ${packagePath}`);
        return packagePath;
    }
    
    public clearEvidence(): void {
        this.evidence.clear();
        this.consoleLog = [];
        this.networkLog = [];
        CSReporter.debug('Evidence collector cleared');
    }
    
    public getEvidence(evidenceId: string): Evidence | undefined {
        return this.evidence.get(evidenceId);
    }
    
    public getAllEvidence(): Map<string, Evidence> {
        return new Map(this.evidence);
    }
    
    public stopCollection(): void {
        this.isRecording = false;
        CSReporter.debug('Evidence collection stopped');
    }
}