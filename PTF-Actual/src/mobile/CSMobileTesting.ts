// Lazy load Playwright for performance
// import { BrowserContext, Page, devices } from '@playwright/test';
type BrowserContext = any;
type Page = any;
let devices: any = null;

import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
// Lazy load BrowserManager
// import { CSBrowserManager } from '../browser/CSBrowserManager';
let CSBrowserManager: any = null;

export interface MobileDevice {
    name: string;
    userAgent: string;
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    isMobile: boolean;
    hasTouch: boolean;
    defaultBrowserType: 'chromium' | 'webkit' | 'firefox';
}

export interface GestureOptions {
    duration?: number;
    steps?: number;
    delay?: number;
}

export interface TouchPoint {
    x: number;
    y: number;
}

export class CSMobileTesting {
    private static instance: CSMobileTesting;
    private config: CSConfigurationManager;
    private browserManager: any; // CSBrowserManager - lazy loaded
    private currentDevice: MobileDevice | null = null;
    private currentContext: any | null = null; // BrowserContext
    private currentPage: any | null = null; // Page
    
    // Custom device configurations
    private customDevices: Map<string, MobileDevice> = new Map();
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.browserManager = CSBrowserManager.getInstance();
        this.registerCustomDevices();
    }
    
    public static getInstance(): CSMobileTesting {
        if (!CSMobileTesting.instance) {
            CSMobileTesting.instance = new CSMobileTesting();
        }
        return CSMobileTesting.instance;
    }
    
    private registerCustomDevices(): void {
        // Add custom device configurations
        this.customDevices.set('Custom Phone', {
            name: 'Custom Phone',
            userAgent: 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
            viewport: { width: 412, height: 915 },
            deviceScaleFactor: 2.625,
            isMobile: true,
            hasTouch: true,
            defaultBrowserType: 'chromium'
        });
        
        this.customDevices.set('Custom Tablet', {
            name: 'Custom Tablet',
            userAgent: 'Mozilla/5.0 (iPad; CPU OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
            viewport: { width: 1024, height: 1366 },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            defaultBrowserType: 'webkit'
        });
    }
    
    public async launchDevice(deviceName: string): Promise<Page> {
        CSReporter.startStep(`Launching mobile device: ${deviceName}`);
        
        try {
            // Check if it's a Playwright built-in device
            let deviceConfig = devices[deviceName];
            
            // If not found, check custom devices
            if (!deviceConfig && this.customDevices.has(deviceName)) {
                deviceConfig = this.customDevices.get(deviceName)!;
            }
            
            if (!deviceConfig) {
                throw new Error(`Unknown device: ${deviceName}`);
            }
            
            // Launch browser with device configuration
            await this.browserManager.launch('chromium');
            const browser = this.browserManager.getBrowser();
            this.currentContext = await browser.newContext({
                ...deviceConfig,
                locale: this.config.get('LOCALE', 'en-US'),
                timezoneId: this.config.get('TIMEZONE', 'America/New_York'),
                permissions: ['geolocation', 'notifications', 'camera', 'microphone'],
                colorScheme: this.config.get('COLOR_SCHEME', 'light') as 'light' | 'dark',
                reducedMotion: this.config.get('REDUCED_MOTION', 'no-preference') as any,
                forcedColors: this.config.get('FORCED_COLORS', 'none') as any
            });
            
            this.currentPage = await this.currentContext!.newPage();
            this.currentDevice = deviceConfig as MobileDevice;
            
            CSReporter.endStep('pass');
            CSReporter.info(`Mobile device launched: ${deviceName}`);
            
            return this.currentPage;
            
        } catch (error: any) {
            CSReporter.endStep('fail');
            throw error;
        }
    }
    
    public async rotateDevice(orientation: 'portrait' | 'landscape'): Promise<void> {
        if (!this.currentPage || !this.currentDevice) {
            throw new Error('No active mobile device');
        }
        
        CSReporter.info(`Rotating device to ${orientation}`);
        
        const viewport = this.currentDevice.viewport;
        const newViewport = orientation === 'landscape' 
            ? { width: Math.max(viewport.width, viewport.height), height: Math.min(viewport.width, viewport.height) }
            : { width: Math.min(viewport.width, viewport.height), height: Math.max(viewport.width, viewport.height) };
        
        await this.currentPage.setViewportSize(newViewport);
        
        // Dispatch orientation change event
        await this.currentPage.evaluate((orient: any) => {
            window.dispatchEvent(new Event('orientationchange'));
            (window as any).orientation = orient === 'landscape' ? 90 : 0;
        }, orientation);
        
        CSReporter.pass(`Device rotated to ${orientation}`);
    }
    
    // Touch gestures
    public async tap(x: number, y: number, options?: GestureOptions): Promise<void> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        CSReporter.debug(`Tapping at (${x}, ${y})`);
        await this.currentPage.tap(`body`, { position: { x, y }, ...options });
    }
    
    public async doubleTap(x: number, y: number, options?: GestureOptions): Promise<void> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        CSReporter.debug(`Double tapping at (${x}, ${y})`);
        
        const delay = options?.delay || 100;
        await this.tap(x, y, options);
        await this.currentPage.waitForTimeout(delay);
        await this.tap(x, y, options);
    }
    
    public async longPress(x: number, y: number, duration: number = 1000): Promise<void> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        CSReporter.debug(`Long pressing at (${x}, ${y}) for ${duration}ms`);
        
        await this.currentPage.mouse.move(x, y);
        await this.currentPage.mouse.down();
        await this.currentPage.waitForTimeout(duration);
        await this.currentPage.mouse.up();
    }
    
    public async swipe(from: TouchPoint, to: TouchPoint, options?: GestureOptions): Promise<void> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        const steps = options?.steps || 10;
        const duration = options?.duration || 500;
        const stepDelay = duration / steps;
        
        CSReporter.debug(`Swiping from (${from.x}, ${from.y}) to (${to.x}, ${to.y})`);
        
        await this.currentPage.mouse.move(from.x, from.y);
        await this.currentPage.mouse.down();
        
        for (let i = 1; i <= steps; i++) {
            const progress = i / steps;
            const x = from.x + (to.x - from.x) * progress;
            const y = from.y + (to.y - from.y) * progress;
            await this.currentPage.mouse.move(x, y);
            await this.currentPage.waitForTimeout(stepDelay);
        }
        
        await this.currentPage.mouse.up();
    }
    
    public async swipeUp(distance: number = 200, options?: GestureOptions): Promise<void> {
        if (!this.currentPage || !this.currentDevice) {
            throw new Error('No active mobile device');
        }
        
        const viewport = this.currentDevice.viewport;
        const centerX = viewport.width / 2;
        const startY = viewport.height * 0.7;
        const endY = startY - distance;
        
        await this.swipe({ x: centerX, y: startY }, { x: centerX, y: endY }, options);
        CSReporter.pass('Swiped up');
    }
    
    public async swipeDown(distance: number = 200, options?: GestureOptions): Promise<void> {
        if (!this.currentPage || !this.currentDevice) {
            throw new Error('No active mobile device');
        }
        
        const viewport = this.currentDevice.viewport;
        const centerX = viewport.width / 2;
        const startY = viewport.height * 0.3;
        const endY = startY + distance;
        
        await this.swipe({ x: centerX, y: startY }, { x: centerX, y: endY }, options);
        CSReporter.pass('Swiped down');
    }
    
    public async swipeLeft(distance: number = 200, options?: GestureOptions): Promise<void> {
        if (!this.currentPage || !this.currentDevice) {
            throw new Error('No active mobile device');
        }
        
        const viewport = this.currentDevice.viewport;
        const centerY = viewport.height / 2;
        const startX = viewport.width * 0.7;
        const endX = startX - distance;
        
        await this.swipe({ x: startX, y: centerY }, { x: endX, y: centerY }, options);
        CSReporter.pass('Swiped left');
    }
    
    public async swipeRight(distance: number = 200, options?: GestureOptions): Promise<void> {
        if (!this.currentPage || !this.currentDevice) {
            throw new Error('No active mobile device');
        }
        
        const viewport = this.currentDevice.viewport;
        const centerY = viewport.height / 2;
        const startX = viewport.width * 0.3;
        const endX = startX + distance;
        
        await this.swipe({ x: startX, y: centerY }, { x: endX, y: centerY }, options);
        CSReporter.pass('Swiped right');
    }
    
    public async pinch(scale: number = 0.5, options?: GestureOptions): Promise<void> {
        if (!this.currentPage || !this.currentDevice) {
            throw new Error('No active mobile device');
        }
        
        const viewport = this.currentDevice.viewport;
        const centerX = viewport.width / 2;
        const centerY = viewport.height / 2;
        const distance = 100;
        
        CSReporter.debug(`Pinching with scale ${scale}`);
        
        // Simulate two-finger pinch
        const finger1Start = { x: centerX - distance, y: centerY };
        const finger2Start = { x: centerX + distance, y: centerY };
        const finger1End = { x: centerX - distance * scale, y: centerY };
        const finger2End = { x: centerX + distance * scale, y: centerY };
        
        // This is a simplified simulation
        await this.currentPage.evaluate(({ scale }: any) => {
            const event = new WheelEvent('wheel', {
                deltaY: scale < 1 ? 100 : -100,
                ctrlKey: true
            });
            document.dispatchEvent(event);
        }, { scale });
        
        CSReporter.pass(`Pinched with scale ${scale}`);
    }
    
    public async zoom(scale: number = 2, options?: GestureOptions): Promise<void> {
        await this.pinch(1 / scale, options);
    }
    
    // Device-specific features
    public async setGeolocation(latitude: number, longitude: number, accuracy: number = 100): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No active mobile context');
        }
        
        await this.currentContext.setGeolocation({ latitude, longitude, accuracy });
        CSReporter.info(`Geolocation set to: ${latitude}, ${longitude}`);
    }
    
    public async clearGeolocation(): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No active mobile context');
        }
        
        await this.currentContext.clearPermissions();
        CSReporter.info('Geolocation cleared');
    }
    
    public async grantPermissions(permissions: string[]): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No active mobile context');
        }
        
        await this.currentContext.grantPermissions(permissions);
        CSReporter.info(`Permissions granted: ${permissions.join(', ')}`);
    }
    
    public async clearPermissions(): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No active mobile context');
        }
        
        await this.currentContext.clearPermissions();
        CSReporter.info('All permissions cleared');
    }
    
    public async setOffline(offline: boolean): Promise<void> {
        if (!this.currentContext) {
            throw new Error('No active mobile context');
        }
        
        await this.currentContext.setOffline(offline);
        CSReporter.info(`Device ${offline ? 'offline' : 'online'}`);
    }
    
    public async emulateNetworkConditions(downloadSpeed: number, uploadSpeed: number, latency: number): Promise<void> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        // This would require CDP (Chrome DevTools Protocol) for full implementation
        CSReporter.info(`Network conditions set: Download: ${downloadSpeed}kbps, Upload: ${uploadSpeed}kbps, Latency: ${latency}ms`);
    }
    
    public async takeScreenshot(name?: string): Promise<string> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        const fileName = name || `mobile_${Date.now()}.png`;
        const path = `./screenshots/${fileName}`;
        
        await this.currentPage.screenshot({ path, fullPage: false });
        CSReporter.info(`Screenshot saved: ${path}`);
        
        return path;
    }
    
    public async scrollToElement(selector: string): Promise<void> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        await this.currentPage.locator(selector).scrollIntoViewIfNeeded();
        CSReporter.debug(`Scrolled to element: ${selector}`);
    }
    
    public async shake(): Promise<void> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        // Simulate device shake
        await this.currentPage.evaluate(() => {
            window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
                acceleration: { x: 10, y: 10, z: 10 },
                accelerationIncludingGravity: { x: 10, y: 10, z: 10 },
                rotationRate: { alpha: 10, beta: 10, gamma: 10 },
                interval: 100
            }));
        });
        
        CSReporter.info('Device shaken');
    }
    
    public async pressHomeButton(): Promise<void> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        // Simulate home button press (app goes to background)
        await this.currentPage.evaluate(() => {
            document.dispatchEvent(new Event('pause'));
            (document as any).hidden = true;
            document.dispatchEvent(new Event('visibilitychange'));
        });
        
        CSReporter.info('Home button pressed');
    }
    
    public async resumeApp(): Promise<void> {
        if (!this.currentPage) {
            throw new Error('No active mobile device');
        }
        
        // Simulate app resume
        await this.currentPage.evaluate(() => {
            document.dispatchEvent(new Event('resume'));
            (document as any).hidden = false;
            document.dispatchEvent(new Event('visibilitychange'));
        });
        
        CSReporter.info('App resumed');
    }
    
    public async installApp(appPath: string): Promise<void> {
        // This would require platform-specific implementation
        CSReporter.info(`App installation simulated: ${appPath}`);
    }
    
    public async uninstallApp(appId: string): Promise<void> {
        // This would require platform-specific implementation
        CSReporter.info(`App uninstall simulated: ${appId}`);
    }
    
    public getCurrentDevice(): MobileDevice | null {
        return this.currentDevice;
    }
    
    public getAvailableDevices(): string[] {
        const playwrightDevices = Object.keys(devices);
        const customDeviceNames = Array.from(this.customDevices.keys());
        return [...playwrightDevices, ...customDeviceNames];
    }
    
    public registerCustomDevice(name: string, config: MobileDevice): void {
        this.customDevices.set(name, config);
        CSReporter.debug(`Registered custom device: ${name}`);
    }
    
    public async close(): Promise<void> {
        if (this.currentPage) {
            await this.currentPage.close();
        }
        if (this.currentContext) {
            await this.currentContext.close();
        }
        
        this.currentPage = null;
        this.currentContext = null;
        this.currentDevice = null;
        
        CSReporter.info('Mobile device closed');
    }
}