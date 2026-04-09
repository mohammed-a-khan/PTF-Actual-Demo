import { CSBrowserManager } from './CSBrowserManager';
import { CSReporter } from '../reporter/CSReporter';

// Symbol.asyncDispose may not exist in older Node.js versions (requires Node 18.x+ with flag or 20+)
const asyncDisposeSymbol: symbol = (
    typeof Symbol.asyncDispose !== 'undefined'
        ? Symbol.asyncDispose
        : Symbol.for('Symbol.asyncDispose')
);

/**
 * Internal dispose logic shared by session wrappers.
 */
async function disposeManager(manager: CSBrowserManager): Promise<void> {
    try { await manager.closePage(); } catch { /* swallow */ }
    try { await manager.closeContext(); } catch { /* swallow */ }
    try { await manager.closeBrowser(); } catch { /* swallow */ }
}

/**
 * DisposableBrowserSession - Wraps CSBrowserManager with Symbol.asyncDispose support.
 *
 * Provides automatic cleanup of browser resources using the async disposable protocol.
 * Since the framework targets ES2020, `await using` syntax is not available, but the
 * dispose pattern is still useful for:
 *
 * 1. Future TypeScript upgrade path (ES2022+ supports `await using`)
 * 2. Manual cleanup patterns: `try { ... } finally { await session.dispose(); }`
 * 3. Frameworks and test runners that support the asyncDispose protocol
 *
 * Usage:
 * ```typescript
 * const session = new DisposableBrowserSession(CSBrowserManager.getInstance());
 * try {
 *     const page = session.page;
 *     // ... use page ...
 * } finally {
 *     await session.dispose();
 * }
 * ```
 */
export class DisposableBrowserSession {
    private manager: CSBrowserManager;
    private disposed: boolean = false;

    constructor(manager: CSBrowserManager) {
        this.manager = manager;

        // Register Symbol.asyncDispose method dynamically to avoid
        // TypeScript computed property issues with non-unique symbols
        (this as any)[asyncDisposeSymbol] = async () => {
            await this.dispose();
        };
    }

    /**
     * Get the current page from the browser manager.
     */
    get page(): any {
        return this.manager.getPage();
    }

    /**
     * Get the current browser context from the browser manager.
     */
    get context(): any {
        return this.manager.getContext();
    }

    /**
     * Get the current browser instance from the browser manager.
     */
    get browser(): any {
        return this.manager.getBrowser();
    }

    /**
     * Get the underlying CSBrowserManager instance.
     */
    get browserManager(): CSBrowserManager {
        return this.manager;
    }

    /**
     * Whether this session has already been disposed.
     */
    get isDisposed(): boolean {
        return this.disposed;
    }

    /**
     * Dispose the browser session - closes page, context, and browser in order.
     * Idempotent - safe to call multiple times.
     * Also callable via Symbol.asyncDispose for environments that support it.
     */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;

        CSReporter.debug('Auto-disposing browser session');
        await disposeManager(this.manager);
        CSReporter.debug('Browser session disposed successfully');
    }
}

/**
 * DisposablePageSession - Wraps a page with auto-cleanup.
 * Only closes the page on dispose, leaving context and browser intact.
 */
export class DisposablePageSession {
    private manager: CSBrowserManager;
    private disposed: boolean = false;

    constructor(manager: CSBrowserManager) {
        this.manager = manager;

        // Register Symbol.asyncDispose method dynamically
        (this as any)[asyncDisposeSymbol] = async () => {
            await this.dispose();
        };
    }

    /**
     * Get the current page from the browser manager.
     */
    get page(): any {
        return this.manager.getPage();
    }

    /**
     * Whether this session has already been disposed.
     */
    get isDisposed(): boolean {
        return this.disposed;
    }

    /**
     * Dispose the page session - only closes the page.
     * Idempotent - safe to call multiple times.
     * Also callable via Symbol.asyncDispose for environments that support it.
     */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;

        CSReporter.debug('Auto-disposing page session');
        try { await this.manager.closePage(); } catch { /* swallow */ }
        CSReporter.debug('Page session disposed successfully');
    }
}

/**
 * CSAsyncDisposable - Utility class for creating disposable browser sessions.
 *
 * Provides factory methods and the `withBrowser` convenience pattern for
 * guaranteed browser cleanup.
 */
export class CSAsyncDisposable {
    /**
     * Create a disposable browser session wrapping the singleton CSBrowserManager.
     * The returned session will auto-clean up page, context, and browser on dispose.
     */
    static createDisposableBrowser(): DisposableBrowserSession {
        const manager = CSBrowserManager.getInstance();
        return new DisposableBrowserSession(manager);
    }

    /**
     * Create a disposable page wrapper for an existing browser manager.
     * On dispose, only the page is closed (context and browser remain open).
     */
    static createDisposablePage(browserManager: CSBrowserManager): DisposablePageSession {
        return new DisposablePageSession(browserManager);
    }

    /**
     * Utility that creates a browser, runs the callback, and guarantees cleanup.
     *
     * Usage:
     * ```typescript
     * const result = await CSAsyncDisposable.withBrowser(async (manager) => {
     *     const page = manager.getPage();
     *     await page.goto('https://example.com');
     *     return await page.title();
     * }, { browserType: 'chrome', headless: true });
     * ```
     */
    static async withBrowser<T>(
        callback: (manager: CSBrowserManager) => Promise<T>,
        options?: { browserType?: string; headless?: boolean }
    ): Promise<T> {
        const manager = CSBrowserManager.getInstance();
        try {
            await manager.launch(options?.browserType || 'chrome');
            return await callback(manager);
        } finally {
            await disposeManager(manager);
        }
    }
}
