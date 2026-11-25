/**
 * Browser users: each virtual user is a real browser context that replays a recorded path.
 *
 * The action format and the replay logic are taken from the performance-testing-app
 * (PerformanceTestEngine: RecordedAction, executeActionInner, safeClick, resolveSmartSelector,
 * evaluateCondition, per-user login and "already signed in" detection), so its recorded scenarios
 * run here unchanged. Changes made while porting:
 *  - dialog_accept / dialog_dismiss register the handler and return (they waited 5 s for a dialog that
 *    only the next action opens, adding 5 s to every such step);
 *  - one retry instead of self-healing locators (which never ran during load runs);
 *  - think time, pacing, ramp-down and Stop come from the load engine (they were dropped or ignored);
 *  - timings come from the engine's measure() (one place, performance.now()); a click is not followed
 *    by a fixed 3 s probe and a "network idle" wait any more (they made every click measure 3 s+): a
 *    click that navigates waits for the new page's load event, pages count until their load event;
 *  - after a redirect to another host than the one requested (signed in already), the sign-in steps
 *    whose elements are absent are skipped (the original turned skipping off in exactly that case,
 *    against its own comment); steps whose element is there always run.
 * Playwright is loaded from the project (the framework installs it); the Studio has no dependency on it.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Outcome, UserPath, UserSession } from './engine';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any; type Browser = any;

export type ConditionType = 'elementExists' | 'elementNotExists' | 'elementVisible' | 'elementHidden' | 'urlContains' | 'elementHasText';
export interface RecordedActionCondition { type: ConditionType; selector?: string; value?: string; timeout?: number }
export interface RecordedAction {
    type: string;
    selector?: string; value?: string; url?: string; waitTime?: number;
    targetSelector?: string; key?: string; scrollX?: number; scrollY?: number; filePaths?: string[]; frameSelector?: string; script?: string;
    description?: string; condition?: RecordedActionCondition; thenActions?: RecordedAction[]; elseActions?: RecordedAction[];
    assertionType?: string; expectedValue?: string; comparisonType?: string; semanticOverride?: string;
    element?: { text?: string; tagName?: string; className?: string; attributes?: Record<string, string> };
    metadata?: { element?: RecordedAction['element'] };
}

/** A recorded browser path (test/<project>/load/<name>.browser.json). */
export interface BrowserPathDef {
    format: 'cs-studio-browser-path/1';
    name: string;
    /** Opened at the start of every iteration. */
    startUrl: string;
    /** Run once per virtual user, on its first iteration (each user signs in with its own session). */
    signIn: RecordedAction[];
    actions: RecordedAction[];
    browser: 'chromium' | 'firefox' | 'webkit';
}

export function validBrowserPath(x: unknown): BrowserPathDef {
    const p = x as BrowserPathDef;
    const fail = (m: string): never => { throw new Error(`Not a valid browser path: ${m}`); };
    if (!p || p.format !== 'cs-studio-browser-path/1') fail('unknown format');
    if (typeof p.name !== 'string' || !p.name.trim()) fail('name');
    if (typeof p.startUrl !== 'string' || !/^https?:\/\//.test(p.startUrl)) fail('start URL (http:// or https://)');
    if (!Array.isArray(p.actions) || !Array.isArray(p.signIn)) fail('actions');
    if (!['chromium', 'firefox', 'webkit'].includes(p.browser)) fail('browser');
    return p;
}

/**
 * Import scenarios saved by the performance-testing-app (its data/scenarios.json: [[id, scenario], …],
 * or one scenario object): name, url, actions, authActions.
 */
export function importRecordedScenarios(json: unknown): BrowserPathDef[] {
    const one = (s: any): BrowserPathDef | null => {
        if (!s || typeof s !== 'object' || !Array.isArray(s.actions)) return null;
        const url = s.url || s.targetUrl || s.actions.find((a: RecordedAction) => a.type === 'navigate' && a.url)?.url;
        if (!url) return null;
        return { format: 'cs-studio-browser-path/1', name: String(s.name || 'Recorded path'), startUrl: url, signIn: Array.isArray(s.authActions) ? s.authActions : [], actions: s.actions, browser: ['firefox', 'webkit'].includes(s.browser) ? s.browser : 'chromium' };
    };
    const list: any[] = Array.isArray(json) ? json.map((e) => (Array.isArray(e) ? e[1] : e)) : [json];
    const out = list.map(one).filter((x): x is BrowserPathDef => !!x);
    if (!out.length) throw new Error('No recorded scenario found (expected the performance app\'s scenarios.json, or one scenario with "url" and "actions").');
    return out;
}

/** A short, stable name for an action (its transaction in the results). */
export function actionLabel(a: RecordedAction): string {
    if (a.description) return a.description;
    const el = a.semanticOverride || a.element?.text?.trim() || a.metadata?.element?.text?.trim();
    const what = el ? `"${el.slice(0, 40)}"` : a.selector ? a.selector.slice(0, 50) : a.url ?? a.key ?? '';
    const verb: Record<string, string> = { click: 'Click', fill: 'Fill', type: 'Fill', select: 'Select', navigate: 'Open', check: 'Check', uncheck: 'Uncheck', hover: 'Hover', press: 'Press', assertion: 'Check', validation: 'Check', verify: 'Check', wait: 'Wait', conditional: 'If', dialog_accept: 'Accept the next dialog', dialog_dismiss: 'Dismiss the next dialog' };
    return `${verb[a.type] ?? a.type} ${what}`.trim();
}

// ---------------------------------------------------------------- replay (ported)

const isDynamicId = (selector: string) => [/#[a-zA-Z-]*\d{10,}/, /#[a-zA-Z-]*[0-9a-f]{8}-[0-9a-f]{4}/, /#[a-zA-Z-]*\d{6,}-\d{6,}/].some((p) => p.test(selector));

/** A more specific selector for recording artefacts: bare tags, class-only list items, dynamic ids. */
export function smartSelector(a: RecordedAction): string | undefined {
    const sel = a.selector;
    if (!sel) return sel;
    const el = a.element ?? a.metadata?.element;
    const text = el?.text?.trim() ?? '';
    const esc = text.replace(/"/g, '\\"');
    const attrs = el?.attributes ?? {};
    const tag = (el?.tagName ?? '').toLowerCase();
    if (/^(span|div|li|td|th|p|h[1-6]|label)$/i.test(sel.trim()) && text.length > 2) return `${sel}:has-text("${esc}")`;
    if (sel.includes('.') && !sel.startsWith('#') && !sel.includes(':has-text') && !sel.includes('[') && text.length > 2) return `${sel}:has-text("${esc}")`;
    if (isDynamicId(sel)) {
        if (attrs['aria-label']) return `${tag || '*'}[aria-label="${attrs['aria-label']}"]`;
        if (attrs.name) return `${tag || '*'}[name="${attrs.name}"]`;
        if (el?.className && text.length > 2) return `.${el.className.split(' ')[0]}:has-text("${esc}")`;
    }
    return sel;
}

function fallbackSelector(a: RecordedAction): string | null {
    const el = a.element ?? a.metadata?.element;
    if (!el?.text) return null;
    return `${el.tagName?.toLowerCase() || '*'}:has-text("${el.text.replace(/"/g, '\\"')}")`;
}

const MODAL = '#ctsjv-modal-portal, [role="dialog"], [role="alertdialog"], .ctsjv-modal';

/** Click that prefers matches inside a dialog and gets past overlays that intercept the click. */
async function safeClick(page: Page, selector: string, timeout: number): Promise<void> {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    const n = Math.max(count, 1);
    let last: unknown;
    for (let i = 0; i < n; i++) {
        const target = n > 1 ? locator.nth(i) : locator.first();
        if (n > 1 && i < n - 1) {
            const inModal = await target.evaluate((el: any, m: string) => !!el.closest(m), MODAL).catch(() => false);
            const nextInModal = !inModal && await locator.nth(i + 1).evaluate((el: any, m: string) => !!el.closest(m), MODAL).catch(() => false);
            if (nextInModal) continue;
        }
        try { await target.click({ timeout: Math.min(timeout, n > 1 ? 8000 : timeout) }); return; }
        catch (e: any) {
            last = e;
            if (String(e?.message ?? '').includes('intercepts pointer events')) {
                await page.keyboard.press('Escape').catch(() => {});
                try { await target.click({ timeout: 8000 }); return; } catch { /* next */ }
                try { await target.click({ force: true, timeout: 8000 }); return; } catch (f) { last = f; }
            }
        }
    }
    throw last;
}

async function condition(page: Page, c: RecordedActionCondition): Promise<boolean> {
    const timeout = c.timeout ?? 3000;
    try {
        switch (c.type) {
            case 'elementExists': await page.waitForSelector(c.selector, { timeout }); return true;
            case 'elementNotExists': try { await page.waitForSelector(c.selector, { timeout }); return false; } catch { return true; }
            case 'elementVisible': await page.waitForSelector(c.selector, { state: 'visible', timeout }); return true;
            case 'elementHidden': try { await page.waitForSelector(c.selector, { state: 'hidden', timeout }); return true; } catch { return false; }
            case 'urlContains': return page.url().includes(c.value ?? '');
            case 'elementHasText': { const el = await page.$(c.selector); return !!el && ((await el.textContent()) ?? '').includes(c.value ?? ''); }
            default: return false;
        }
    } catch { return false; }
}

/** Replay one action (one retry after 500 ms). */
export async function runAction(page: Page, a: RecordedAction): Promise<void> {
    try { await runOnce(page, a); }
    catch { await new Promise((r) => setTimeout(r, 500)); await runOnce(page, a); }
}

async function runOnce(page: Page, a: RecordedAction): Promise<void> {
    const T = 45_000;
    switch (a.type) {
        case 'click': {
            if (!a.selector) return;
            const before = page.url();
            const sel = smartSelector(a)!;
            try { await safeClick(page, sel, 30_000); }
            catch (e) {
                if (sel !== a.selector) { try { await safeClick(page, a.selector, 15_000); } catch { throw e; } }
                else if (isDynamicId(a.selector) && fallbackSelector(a)) await safeClick(page, fallbackSelector(a)!, 15_000);
                else throw e;
            }
            // click() already waits for a navigation it starts; only then wait for the new page to load.
            // (The original probed 3 s for a URL change and waited for "network idle" after every click,
            // so a fast click measured over 3 s.)
            if (page.url() !== before) await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
            return;
        }
        case 'type': case 'fill': if (a.selector) await page.fill(a.selector, a.value ?? '', { timeout: T }); return;
        case 'select': if (a.selector && a.value) { await page.selectOption(a.selector, a.value, { timeout: T }); await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}); } return;
        case 'navigate': if (a.url) await page.goto(a.url, { waitUntil: 'load', timeout: T }); return;
        case 'wait': await new Promise((r) => setTimeout(r, a.waitTime || 1000)); return;
        case 'conditional': {
            if (!a.condition) return;
            for (const sub of (await condition(page, a.condition)) ? a.thenActions ?? [] : a.elseActions ?? []) await runOnce(page, sub);
            return;
        }
        case 'assertion': case 'validation': case 'verify': {
            const sel = a.selector; if (!sel) return;
            const kind = (a.assertionType || 'text').toLowerCase();
            let expected = a.expectedValue || '';
            const le = expected.toLowerCase().trim();
            if (kind === 'visible' || kind === 'visibility') expected = le === 'element should not be visible' || le === 'hidden' || le === 'false' ? 'false' : 'true';
            if (kind === 'enabled') expected = le === 'disabled' || le === 'false' ? 'false' : 'true';
            const cmp = (a.comparisonType || 'equals').toLowerCase();
            const read = async (): Promise<string> => {
                if (kind === 'visible' || kind === 'visibility') return String(await page.isVisible(sel));
                if (kind === 'enabled') return String(await page.isEnabled(sel).catch(() => false));
                if (kind === 'checked') return String(await page.isChecked(sel).catch(() => false));
                if (kind === 'count') return String(await page.locator(sel).count());
                return (await page.textContent(sel, { timeout: 1000 }).catch(() => '')) || '';
            };
            const ok = (actual: string) => (cmp === 'contains' || cmp === 'includes' ? actual.includes(expected) : cmp === 'startswith' ? actual.startsWith(expected) : cmp === 'endswith' ? actual.endsWith(expected)
                : cmp === 'not_equals' || cmp === 'notequals' ? actual !== expected : actual === expected);
            // The page may still be updating (text after an API call): look again until it matches, up to 5 s.
            const until = Date.now() + 5000;
            let actual = await read();
            while (!ok(actual) && Date.now() < until) { await new Promise((r) => setTimeout(r, 100)); actual = await read(); }
            if (!ok(actual)) throw new Error(`Expected ${sel} ${cmp} "${expected}", got "${actual.slice(0, 120)}"`);
            return;
        }
        case 'check': if (a.selector) await page.check(a.selector, { timeout: T }); return;
        case 'uncheck': if (a.selector) await page.uncheck(a.selector, { timeout: T }); return;
        // The next dialog is answered when it opens (the action that opens it comes next).
        case 'dialog_accept': page.once('dialog', (d: any) => { void d.accept(a.value ?? '').catch(() => {}); }); return;
        case 'dialog_dismiss': page.once('dialog', (d: any) => { void d.dismiss().catch(() => {}); }); return;
        case 'page-context': return;
        case 'hover': if (a.selector) await page.hover(a.selector, { timeout: T }); return;
        case 'double_click': if (a.selector) await page.dblclick(a.selector, { timeout: T }); return;
        case 'right_click': if (a.selector) await page.click(a.selector, { button: 'right', timeout: T }); return;
        case 'drag_drop': if (a.selector && a.targetSelector) await page.dragAndDrop(a.selector, a.targetSelector, { timeout: T }); return;
        case 'press': if (a.key) { if (a.selector) await page.press(a.selector, a.key, { timeout: T }); else await page.keyboard.press(a.key); } return;
        case 'key_chord': if (a.key) await page.keyboard.press(a.key); return;
        case 'scroll':
            if (a.selector) await page.locator(a.selector).scrollIntoViewIfNeeded({ timeout: T });
            await page.evaluate((o: { x: number; y: number }) => (globalThis as any).scrollBy(o.x, o.y), { x: a.scrollX ?? 0, y: a.scrollY ?? 0 });
            return;
        case 'upload': if (a.selector && a.filePaths?.length) await page.setInputFiles(a.selector, a.filePaths, { timeout: T }); return;
        case 'download': {
            const [dl] = await Promise.all([page.waitForEvent('download', { timeout: T }), a.selector ? page.click(a.selector, { timeout: T }) : Promise.resolve()]);
            await dl.delete().catch(() => {});
            return;
        }
        case 'iframe_click': if (a.frameSelector && a.selector) await page.frameLocator(a.frameSelector).locator(a.selector).click({ timeout: T }); return;
        case 'iframe_fill': if (a.frameSelector && a.selector && a.value !== undefined) await page.frameLocator(a.frameSelector).locator(a.selector).fill(a.value, { timeout: T }); return;
        case 'iframe_select': if (a.frameSelector && a.selector && a.value) await page.frameLocator(a.frameSelector).locator(a.selector).selectOption(a.value, { timeout: T }); return;
        case 'new_tab': {
            const [popup] = await Promise.all([page.context().waitForEvent('page', { timeout: T }), a.selector ? page.click(a.selector, { timeout: T }) : Promise.resolve()]);
            await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
            page.__popupPage = popup;
            return;
        }
        case 'switch_tab': { const p = page.__popupPage; if (p && !p.isClosed()) { await p.bringToFront(); if (a.selector) await p.click(a.selector, { timeout: T }); } return; }
        case 'close_tab': { const p = page.__popupPage; if (p && !p.isClosed()) { await p.close(); delete page.__popupPage; } return; }
        case 'evaluate': if (a.script) await page.evaluate(a.script); return;
        default: return;
    }
}

// ---------------------------------------------------------------- the user path

/** Playwright from the project (installed with the framework). */
export function loadPlaywright(projectRoot: string): any {
    for (const m of ['playwright', '@playwright/test', 'playwright-core']) {
        try { return require(require.resolve(m, { paths: [projectRoot] })); } catch { /* next */ }
    }
    throw new Error('Playwright is not installed in this project (npm install installs it with the framework).');
}

/** Core Web Vitals of the page, observed in the page (LCP, FCP, TTFB, CLS, INP); read after each navigation. */
const VITALS_SCRIPT = `(() => {
  const v = window.__csVitals = { cls: 0, inp: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) v.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') v.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) v.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) v.inp = Math.max(v.inp, e.duration); }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch (e) { /* an older browser */ }
  addEventListener('load', () => { const n = performance.getEntriesByType('navigation')[0]; if (n) v.ttfb = n.responseStart; });
})();`;

/** {{column}} of the user's data row in a recorded step (values typed, addresses, conditions). */
function withRow(a: RecordedAction, row: Record<string, string>): RecordedAction {
    if (!Object.keys(row).length) return a;
    const f = (s?: string) => (s === undefined ? s : s.replace(/\{\{\s*([\w .-]+)\s*\}\}/g, (m, k: string) => (k in row ? row[k] : m)));
    return { ...a, value: f(a.value), url: f(a.url), expectedValue: f(a.expectedValue), ...(a.condition ? { condition: { ...a.condition, value: f(a.condition.value) } } : {}),
        ...(a.thenActions ? { thenActions: a.thenActions.map((x) => withRow(x, row)) } : {}), ...(a.elseActions ? { elseActions: a.elseActions.map((x) => withRow(x, row)) } : {}) };
}

/** Browser users: up to 25 users share one browser process (each with its own context). CS_BROWSER_EXECUTABLE points Chromium at an installed browser. */
export function browserUserPath(def: BrowserPathDef, o: { projectRoot: string; headless?: boolean; usersPerBrowser?: number; timeout: number; row?: (index: number) => Record<string, string>; proxy?: string; vitals?: boolean }): UserPath {
    const pw = loadPlaywright(o.projectRoot);
    const per = o.usersPerBrowser ?? 25;
    const browsers: Array<{ browser: Promise<Browser>; users: number }> = [];
    const browserFor = () => {
        let b = browsers.find((x) => x.users < per);
        if (!b) { b = { browser: pw[def.browser].launch({ headless: o.headless !== false, ...(def.browser === 'chromium' && process.env.CS_BROWSER_EXECUTABLE ? { executablePath: process.env.CS_BROWSER_EXECUTABLE } : {}) }), users: 0 }; browsers.push(b); }
        b.users++;
        return b;
    };
    const appHost = (() => { try { return new URL(def.startUrl).hostname; } catch { return ''; } })();
    return {
        async start(index): Promise<UserSession> {
            const slot = browserFor();
            const browser = await slot.browser;
            const context = await browser.newContext({ ignoreHTTPSErrors: false, ...(o.proxy ? { proxy: { server: o.proxy } } : {}) });
            context.setDefaultTimeout(o.timeout);
            if (o.vitals !== false) await context.addInitScript(VITALS_SCRIPT);
            /** The page's Web Vitals, reported as measurements of their own (CLS ×1000, as it has no unit). */
            const vitals = async (report: import('./engine').Report | undefined, where: string) => {
                if (!report || o.vitals === false) return;
                const v = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done((window as unknown as { __csVitals?: Record<string, number> }).__csVitals), 0))))).catch(() => undefined) as Record<string, number> | undefined;
                if (!v) return;
                for (const [k, label] of [['lcp', 'LCP (largest contentful paint)'], ['fcp', 'FCP (first contentful paint)'], ['ttfb', 'TTFB (time to first byte)'], ['inp', 'INP (interaction to next paint)']] as const)
                    if (typeof v[k] === 'number' && v[k] > 0) report(`cwv:${k}:${where}`, `Web vitals › ${label} › ${where}`, v[k]);
                if (typeof v.cls === 'number') report(`cwv:cls:${where}`, `Web vitals › CLS ×1000 › ${where}`, Math.round(v.cls * 1000));
            };
            const page = await context.newPage();
            let signedIn = def.signIn.length === 0;
            // A failed step keeps the page it happened on (for the error details).
            const onPage = (fn: () => Promise<void>) => async (): Promise<Outcome> => {
                try { await fn(); return null; }
                catch (e) { return { error: (e as Error).message.split('\n')[0], sample: { user: index, page: page.url() } }; }
            };
            return {
                async iteration(measure, pause, stopped, report) {
                    const row = o.row?.(index) ?? {};
                    const startUrl = withRow({ type: 'navigate', url: def.startUrl }, row).url!;
                    // Until the page's load event (images, scripts): what a user waits for.
                    const openErr = await measure('_open', `Open ${def.startUrl}`, onPage(async () => { await page.goto(startUrl, { waitUntil: 'load', timeout: o.timeout }); }));
                    if (openErr) { await pause(); return; }
                    await vitals(report, 'start page');
                    // Each user signs in once with its own session (shared sessions are cut off by SSO).
                    if (!signedIn) {
                        const err = await measure('_signin', 'Sign in', onPage(async () => { for (const a of def.signIn) await runAction(page, withRow(a, row)); }));
                        if (err) { await pause(); return; }
                        signedIn = true;
                    }
                    // Already signed in: a "navigate" to the sign-in host lands in the app, so the
                    // sign-in form steps that follow are skipped while their elements are not there.
                    let skipping = false;
                    let lastUrl = page.url();
                    for (let i = 0; i < def.actions.length && !stopped(); i++) {
                        const a = def.actions[i];
                        if (skipping && ['click', 'fill', 'type', 'select'].includes(a.type) && a.selector) {
                            if ((await page.locator(a.selector).count().catch(() => 0)) === 0) continue;
                            skipping = false;
                        }
                        await measure(`a${i}`, `${i + 1}. ${actionLabel(a)}`, onPage(() => runAction(page, withRow(a, row))));
                        if (a.type === 'navigate' || a.type === 'click') {
                            // A click that submits or follows a link navigates a moment later: wait briefly for it (not measured).
                            if (a.type === 'click') { await page.waitForURL((x: URL) => x.href !== lastUrl, { timeout: 500 }).catch(() => {}); await page.waitForLoadState('load').catch(() => {}); }
                            const u = page.url(); if (u !== lastUrl) { lastUrl = u; await vitals(report, `${i + 1}. ${actionLabel(a)}`); } }
                        if (a.type === 'navigate' && a.url) {
                            try {
                                const want = new URL(a.url).hostname, now = new URL(page.url()).hostname;
                                // Redirected away from the requested host (signed in already): skip the absent
                                // sign-in elements; on the app's host itself: stop skipping.
                                if (now !== want) skipping = true;
                                else if (now === appHost) skipping = false;
                            } catch { /* keep */ }
                        }
                        if (!['wait', 'page-context', 'dialog_accept', 'dialog_dismiss'].includes(a.type)) await pause();
                    }
                },
                async close() { await context.close().catch(() => {}); slot.users--; },
            };
        },
        async dispose() { for (const b of browsers) await (await b.browser.catch(() => null))?.close().catch(() => {}); },
    };
}

/** Read a browser path file of the project. */
export function readBrowserPath(root: string, rel: string): BrowserPathDef {
    if (!/^test\/[A-Za-z0-9][\w.-]*\/load\/[\w.-]+\.browser\.json$/.test(rel)) throw new Error('Not a browser path file.');
    return validBrowserPath(JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')));
}
