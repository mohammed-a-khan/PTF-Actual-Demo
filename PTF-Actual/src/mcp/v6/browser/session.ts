import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

interface Session {
    browser: Browser;
    context: BrowserContext;
    page: Page;
    headless: boolean;
    startedAt: number;
    lastUsed: number;
}

const SESSIONS = new Map<string, Session>();

export async function getOrStart(id: string, headless = false): Promise<Session> {
    let s = SESSIONS.get(id);
    if (s) {
        s.lastUsed = Date.now();
        return s;
    }
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    s = { browser, context, page, headless, startedAt: Date.now(), lastUsed: Date.now() };
    SESSIONS.set(id, s);
    return s;
}

export async function stop(id: string): Promise<boolean> {
    const s = SESSIONS.get(id);
    if (!s) return false;
    try { await s.context.close(); } catch { /* noop */ }
    try { await s.browser.close(); } catch { /* noop */ }
    SESSIONS.delete(id);
    return true;
}

export function has(id: string): boolean {
    return SESSIONS.has(id);
}

export function _clearAll(): void {
    for (const id of Array.from(SESSIONS.keys())) {
        void stop(id);
    }
}
