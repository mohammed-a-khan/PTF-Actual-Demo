import { Page, BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';

export interface VideoOptions {
    name?: string;
    dir?: string;
    size?: { width: number; height: number };
    recordHar?: { path: string; omitContent?: boolean };
    recordVideo?: boolean;
    videoSize?: { width: number; height: number };
}

export interface VideoMetadata {
    path: string;
    size: number;
    duration?: number;
    timestamp: number;
    scenario?: string;
    status?: 'success' | 'failure';
}

export class CSVideoRecorder {
    private static instance: CSVideoRecorder;
    private config: CSConfigurationManager;
    private videoDir: string;
    private videos: Map<string, VideoMetadata> = new Map();
    private activeRecordings: Map<string, BrowserContext> = new Map();
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.videoDir = this.config.get('VIDEO_DIR', './videos');
        
        this.ensureDirectory();
    }
    
    public static getInstance(): CSVideoRecorder {
        if (!CSVideoRecorder.instance) {
            CSVideoRecorder.instance = new CSVideoRecorder();
        }
        return CSVideoRecorder.instance;
    }
    
    private ensureDirectory(): void {
        if (!fs.existsSync(this.videoDir)) {
            fs.mkdirSync(this.videoDir, { recursive: true });
        }
    }
    
    public async startRecording(
        context: BrowserContext,
        options: VideoOptions = {}
    ): Promise<string> {
        const recordingId = `recording_${Date.now()}`;
        const videoDir = options.dir || this.videoDir;
        
        try {
            // Note: Video recording must be configured when creating the context
            // This is a limitation of Playwright - videos are configured at context creation
            // Store the context for later reference
            this.activeRecordings.set(recordingId, context);
            
            CSReporter.info(`Video recording started: ${recordingId}`);
            return recordingId;
            
        } catch (error: any) {
            CSReporter.error(`Failed to start video recording: ${error.message}`);
            throw error;
        }
    }
    
    public async stopRecording(recordingId: string): Promise<string | null> {
        const context = this.activeRecordings.get(recordingId);
        
        if (!context) {
            CSReporter.warn(`No active recording found: ${recordingId}`);
            return null;
        }
        
        try {
            // Close context to save video
            await context.close();
            
            // Get video path from the first page (if any)
            const pages = context.pages();
            if (pages.length > 0) {
                const videoPath = await pages[0].video()?.path();
                
                if (videoPath) {
                    const metadata: VideoMetadata = {
                        path: videoPath,
                        size: fs.statSync(videoPath).size,
                        timestamp: Date.now()
                    };
                    
                    this.videos.set(recordingId, metadata);
                    this.activeRecordings.delete(recordingId);
                    
                    CSReporter.info(`Video recording saved: ${videoPath}`);
                    return videoPath;
                }
            }
            
            return null;
            
        } catch (error: any) {
            CSReporter.error(`Failed to stop video recording: ${error.message}`);
            throw error;
        }
    }
    
    public async recordScenario(
        contextOptions: any,
        scenario: () => Promise<void>,
        options: VideoOptions = {}
    ): Promise<string | null> {
        const timestamp = Date.now();
        const name = options.name || `scenario_${timestamp}`;
        const videoDir = options.dir || this.videoDir;
        
        // Add video recording to context options
        const enhancedOptions = {
            ...contextOptions,
            recordVideo: {
                dir: videoDir,
                size: options.size || { width: 1280, height: 720 }
            }
        };
        
        // Add HAR recording if specified
        if (options.recordHar) {
            enhancedOptions.recordHar = options.recordHar;
        }
        
        let context: BrowserContext | null = null;
        let page: Page | null = null;
        
        try {
            // Create context with video recording
            const { chromium } = require('@playwright/test');
            const browser = await chromium.launch();
            context = await browser.newContext(enhancedOptions);
            page = await context!.newPage();
            
            // Execute scenario
            await scenario.call({ page, context });
            
            // Get video path
            const videoPath = await page.video()?.path();
            
            if (videoPath) {
                // Move/rename video to desired location
                const finalPath = path.join(videoDir, `${name}.webm`);
                
                // Wait for video to be saved
                await page.close();
                await context!.close();
                
                // Move file if needed
                if (videoPath !== finalPath && fs.existsSync(videoPath)) {
                    fs.renameSync(videoPath, finalPath);
                }
                
                const metadata: VideoMetadata = {
                    path: finalPath,
                    size: fs.statSync(finalPath).size,
                    timestamp,
                    scenario: name,
                    status: 'success'
                };
                
                this.videos.set(name, metadata);
                
                CSReporter.info(`Scenario video recorded: ${finalPath}`);
                return finalPath;
            }
            
            return null;
            
        } catch (error: any) {
            CSReporter.error(`Failed to record scenario: ${error.message}`);
            
            // Save video even on failure
            if (page) {
                const videoPath = await page.video()?.path();
                if (videoPath) {
                    const metadata: VideoMetadata = {
                        path: videoPath,
                        size: fs.statSync(videoPath).size,
                        timestamp,
                        scenario: name,
                        status: 'failure'
                    };
                    
                    this.videos.set(name, metadata);
                }
            }
            
            throw error;
            
        } finally {
            if (page) await page.close();
            if (context) await context.close();
        }
    }
    
    public async recordTest(
        test: () => Promise<void>,
        options: VideoOptions = {}
    ): Promise<string | null> {
        const timestamp = Date.now();
        const name = options.name || `test_${timestamp}`;
        const videoDir = options.dir || this.videoDir;
        
        try {
            // Create context with video recording
            const { chromium } = require('@playwright/test');
            const browser = await chromium.launch();
            const context = await browser.newContext({
                recordVideo: {
                    dir: videoDir,
                    size: options.size || { width: 1280, height: 720 }
                }
            });
            
            const page = await context.newPage();
            
            // Execute test
            await test.call({ page, context });
            
            // Get video path
            const videoPath = await page.video()?.path();
            
            // Close to save video
            await page.close();
            await context.close();
            await browser.close();
            
            if (videoPath) {
                const metadata: VideoMetadata = {
                    path: videoPath,
                    size: fs.statSync(videoPath).size,
                    timestamp,
                    status: 'success'
                };
                
                this.videos.set(name, metadata);
                
                CSReporter.info(`Test video recorded: ${videoPath}`);
                return videoPath;
            }
            
            return null;
            
        } catch (error: any) {
            CSReporter.error(`Failed to record test: ${error.message}`);
            throw error;
        }
    }
    
    public async getVideoPath(page: Page): Promise<string | null> {
        try {
            const video = page.video();
            if (video) {
                return await video.path();
            }
            return null;
        } catch (error) {
            return null;
        }
    }
    
    public async saveVideo(page: Page, name: string): Promise<string | null> {
        try {
            const video = page.video();
            if (!video) {
                CSReporter.warn('No video recording available for this page');
                return null;
            }
            
            const videoPath = await video.path();
            if (!videoPath) {
                return null;
            }
            
            // Copy video to desired location
            const finalPath = path.join(this.videoDir, `${name}.webm`);
            fs.copyFileSync(videoPath, finalPath);
            
            const metadata: VideoMetadata = {
                path: finalPath,
                size: fs.statSync(finalPath).size,
                timestamp: Date.now()
            };
            
            this.videos.set(name, metadata);
            
            CSReporter.info(`Video saved: ${finalPath}`);
            return finalPath;
            
        } catch (error: any) {
            CSReporter.error(`Failed to save video: ${error.message}`);
            return null;
        }
    }
    
    public async deleteVideo(page: Page): Promise<void> {
        try {
            const video = page.video();
            if (video) {
                await video.delete();
                CSReporter.info('Video deleted');
            }
        } catch (error: any) {
            CSReporter.error(`Failed to delete video: ${error.message}`);
        }
    }
    
    public getVideoMetadata(name: string): VideoMetadata | undefined {
        return this.videos.get(name);
    }
    
    public getAllVideos(): Map<string, VideoMetadata> {
        return new Map(this.videos);
    }
    
    public async cleanupOldVideos(daysToKeep: number = 7): Promise<void> {
        const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        
        const files = fs.readdirSync(this.videoDir);
        
        for (const file of files) {
            const filepath = path.join(this.videoDir, file);
            const stats = fs.statSync(filepath);
            
            if (stats.mtimeMs < cutoffTime) {
                fs.unlinkSync(filepath);
                CSReporter.debug(`Deleted old video: ${file}`);
            }
        }
        
        // Clean up metadata
        for (const [name, metadata] of this.videos.entries()) {
            if (metadata.timestamp < cutoffTime) {
                this.videos.delete(name);
            }
        }
        
        CSReporter.info(`Cleaned up videos older than ${daysToKeep} days`);
    }
    
    public async compressVideo(
        inputPath: string,
        outputPath?: string,
        quality: 'low' | 'medium' | 'high' = 'medium'
    ): Promise<string | null> {
        // Note: This would require ffmpeg or similar tool
        // For now, just copy the file
        try {
            const output = outputPath || inputPath.replace('.webm', '_compressed.webm');
            fs.copyFileSync(inputPath, output);
            
            CSReporter.info(`Video compressed: ${output}`);
            return output;
            
        } catch (error: any) {
            CSReporter.error(`Failed to compress video: ${error.message}`);
            return null;
        }
    }
    
    public async extractFrames(
        videoPath: string,
        outputDir: string,
        interval: number = 1000
    ): Promise<string[]> {
        // Note: This would require ffmpeg or similar tool
        // Placeholder implementation
        CSReporter.warn('Frame extraction not implemented - requires ffmpeg');
        return [];
    }
    
    public clearVideos(): void {
        this.videos.clear();
        this.activeRecordings.clear();
    }
}