/**
 * CS Network Idle Tracker
 * Tracks XHR/Fetch requests to detect network idle state
 * Thread-safe for parallel execution - each page gets its own tracker
 */

type Page = any;

export interface NetworkIdleOptions {
    timeout: number;              // Maximum time to wait for idle
    idleTimeMs: number;           // Time with no requests to consider idle
    maxPendingRequests: number;   // Allow this many pending requests (0 = wait for all)
    excludePatterns: string[];    // URL patterns to ignore
    includePatterns: string[];    // Only track these URL patterns (empty = all)
}

const DEFAULT_OPTIONS: NetworkIdleOptions = {
    timeout: 10000,
    idleTimeMs: 500,
    maxPendingRequests: 0,
    excludePatterns: ['analytics', 'tracking', 'heartbeat', 'favicon', 'hot-update'],
    includePatterns: []
};

interface PendingRequest {
    url: string;
    method: string;
    startTime: number;
}

export class CSNetworkIdleTracker {
    private page: Page;
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private isTracking: boolean = false;
    private requestHandler: ((request: any) => void) | null = null;
    private responseHandler: ((response: any) => void) | null = null;
    private requestFailedHandler: ((request: any) => void) | null = null;
    private excludePatterns: string[] = [];

    constructor(page: Page) {
        this.page = page;
    }

    /**
     * Start tracking network requests
     */
    public startTracking(excludePatterns: string[] = DEFAULT_OPTIONS.excludePatterns): void {
        if (this.isTracking) return;

        this.excludePatterns = excludePatterns;
        this.pendingRequests.clear();
        this.isTracking = true;

        this.requestHandler = (request: any) => {
            const url = request.url();
            if (!this.shouldTrackUrl(url)) return;

            const requestId = `${request.url()}_${Date.now()}_${Math.random()}`;
            this.pendingRequests.set(requestId, {
                url,
                method: request.method(),
                startTime: Date.now()
            });

            // Store requestId on the request for later reference
            (request as any)._trackerId = requestId;
        };

        this.responseHandler = (response: any) => {
            const request = response.request();
            const requestId = (request as any)._trackerId;
            if (requestId) {
                this.pendingRequests.delete(requestId);
            }
        };

        this.requestFailedHandler = (request: any) => {
            const requestId = (request as any)._trackerId;
            if (requestId) {
                this.pendingRequests.delete(requestId);
            }
        };

        this.page.on('request', this.requestHandler);
        this.page.on('response', this.responseHandler);
        this.page.on('requestfailed', this.requestFailedHandler);
    }

    /**
     * Stop tracking network requests
     */
    public stopTracking(): void {
        if (!this.isTracking) return;

        if (this.requestHandler) {
            this.page.off('request', this.requestHandler);
        }
        if (this.responseHandler) {
            this.page.off('response', this.responseHandler);
        }
        if (this.requestFailedHandler) {
            this.page.off('requestfailed', this.requestFailedHandler);
        }

        this.requestHandler = null;
        this.responseHandler = null;
        this.requestFailedHandler = null;
        this.pendingRequests.clear();
        this.isTracking = false;
    }

    private shouldTrackUrl(url: string): boolean {
        const urlLower = url.toLowerCase();
        return !this.excludePatterns.some(pattern =>
            urlLower.includes(pattern.toLowerCase())
        );
    }

    /**
     * Get count of pending requests
     */
    public getPendingCount(): number {
        return this.pendingRequests.size;
    }

    /**
     * Get list of pending requests (for debugging)
     */
    public getPendingRequests(): PendingRequest[] {
        return Array.from(this.pendingRequests.values());
    }

    /**
     * Check if network is currently idle
     */
    public isIdle(maxPending: number = 0): boolean {
        return this.pendingRequests.size <= maxPending;
    }

    /**
     * Wait for network to become idle
     */
    public async waitForNetworkIdle(options: Partial<NetworkIdleOptions> = {}): Promise<boolean> {
        const opts = { ...DEFAULT_OPTIONS, ...options };

        // Start tracking if not already
        const wasTracking = this.isTracking;
        if (!wasTracking) {
            this.startTracking(opts.excludePatterns);
        }

        const startTime = Date.now();
        let lastActivityTime = Date.now();

        try {
            while (Date.now() - startTime < opts.timeout) {
                const pendingCount = this.pendingRequests.size;

                if (pendingCount <= opts.maxPendingRequests) {
                    // Check if we've been idle long enough
                    const idleTime = Date.now() - lastActivityTime;
                    if (idleTime >= opts.idleTimeMs) {
                        return true;
                    }
                } else {
                    // Reset idle timer when there's activity
                    lastActivityTime = Date.now();
                }

                // Wait a bit before checking again
                await this.page.waitForTimeout(50);
            }

            // Timeout reached
            return false;
        } finally {
            // Stop tracking if we started it
            if (!wasTracking) {
                this.stopTracking();
            }
        }
    }

    /**
     * Wait for network idle using Playwright's built-in method
     * This is a fallback that uses networkidle load state
     */
    public async waitForNetworkIdleSimple(timeout: number = 10000): Promise<boolean> {
        try {
            await this.page.waitForLoadState('networkidle', { timeout });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Wait for specific request to complete
     */
    public async waitForRequest(
        urlPattern: string | RegExp,
        timeout: number = 10000
    ): Promise<boolean> {
        try {
            await this.page.waitForResponse(
                (response: any) => {
                    const url = response.url();
                    if (typeof urlPattern === 'string') {
                        return url.includes(urlPattern);
                    }
                    return urlPattern.test(url);
                },
                { timeout }
            );
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Cleanup - call when done with page
     */
    public dispose(): void {
        this.stopTracking();
    }
}

export default CSNetworkIdleTracker;
