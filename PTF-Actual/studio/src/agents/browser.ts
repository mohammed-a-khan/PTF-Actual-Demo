/**
 * The Studio's own browser for agents: a Chromium from the repository's Playwright, shown live in the
 * Studio (screencast frames) and driven by agents through Studio tools. A person can take over in
 * the viewer (click, type, keys). Each agent action is also kept as a Playwright line, so a manual run
 * becomes a recording that the recorder turns into framework code (feature, test data, pages, steps).
 */
import * as fs from 'fs';
import * as path from 'path';

/** How an agent names an element (Playwright's locators). */
export interface ElementSpec {
    role?: string; name?: string; exact?: boolean;
    label?: string; placeholder?: string; text?: string; testId?: string; altText?: string; title?: string;
    css?: string;
    /** Several matches: which one (0 = first, -1 = last). */
    nth?: number;
    /** Inside an iframe (CSS selector of the iframe element), outermost first. */
    frames?: string[];
}

export interface Frame { data: string; seq: number; url: string; title: string; width: number; height: number; at: number }

type PW = any; // the repository's Playwright module (its own version)

const q = (s: string) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** The Playwright module installed in the repository (as the framework uses it). */
export function repoPlaywright(repoRoot: string): PW | null {
    for (let dir = path.resolve(repoRoot); ; dir = path.dirname(dir)) {
        for (const m of ['playwright', 'playwright-core', '@playwright/test']) {
            const p = path.join(dir, 'node_modules', m);
            if (fs.existsSync(path.join(p, 'package.json'))) { try { return require(p); } catch { /* next */ } }
        }
        if (path.dirname(dir) === dir) return null;
    }
}

/** The locator code for a spec (as codegen writes it), checked for what it needs. */
export function locatorCode(s: ElementSpec): string {
    let base = 'page';
    for (const f of s.frames ?? []) base += `.locator(${q(f)}).contentFrame()`;
    const exact = s.exact ? ', exact: true' : '';
    let code: string;
    if (s.role) code = `${base}.getByRole(${q(s.role)}${s.name !== undefined ? `, { name: ${q(s.name)}${exact} }` : ''})`;
    else if (s.testId !== undefined) code = `${base}.getByTestId(${q(s.testId)})`;
    else if (s.label !== undefined) code = `${base}.getByLabel(${q(s.label)}${s.exact ? ', { exact: true }' : ''})`;
    else if (s.placeholder !== undefined) code = `${base}.getByPlaceholder(${q(s.placeholder)}${s.exact ? ', { exact: true }' : ''})`;
    else if (s.altText !== undefined) code = `${base}.getByAltText(${q(s.altText)}${s.exact ? ', { exact: true }' : ''})`;
    else if (s.title !== undefined) code = `${base}.getByTitle(${q(s.title)}${s.exact ? ', { exact: true }' : ''})`;
    else if (s.text !== undefined) code = `${base}.getByText(${q(s.text)}${s.exact ? ', { exact: true }' : ''})`;
    else if (s.css) code = `${base}.locator(${q(s.css)})`;
    else throw new Error('Name the element: role (+ name), label, placeholder, text, testId, altText, title or css.');
    if (s.nth !== undefined) code += s.nth === 0 ? '.first()' : s.nth === -1 ? '.last()' : `.nth(${Math.trunc(s.nth)})`;
    return code;
}

/** A Playwright locator for a spec on a page. */
function locate(page: PW, s: ElementSpec): PW {
    let base: PW = page;
    for (const f of s.frames ?? []) base = base.locator(f).contentFrame();
    let l: PW;
    if (s.role) l = base.getByRole(s.role, s.name !== undefined ? { name: s.name, exact: !!s.exact } : {});
    else if (s.testId !== undefined) l = base.getByTestId(s.testId);
    else if (s.label !== undefined) l = base.getByLabel(s.label, { exact: !!s.exact });
    else if (s.placeholder !== undefined) l = base.getByPlaceholder(s.placeholder, { exact: !!s.exact });
    else if (s.altText !== undefined) l = base.getByAltText(s.altText, { exact: !!s.exact });
    else if (s.title !== undefined) l = base.getByTitle(s.title, { exact: !!s.exact });
    else if (s.text !== undefined) l = base.getByText(s.text, { exact: !!s.exact });
    else if (s.css) l = base.locator(s.css);
    else throw new Error('Name the element: role (+ name), label, placeholder, text, testId, altText, title or css.');
    if (s.nth !== undefined) l = s.nth === 0 ? l.first() : s.nth === -1 ? l.last() : l.nth(s.nth);
    return l;
}

/** Runs in the page (as text: the Studio's server has no DOM types). */
const SCRAPE_JS = `function (w, sel) {
    var root = (sel ? document.querySelector(sel) : document.body) || document.body;
    var txt = function (e) { return e && e.innerText ? e.innerText.replace(/\\s+/g, ' ').trim() : ''; };
    var all = function (s, n) { return Array.prototype.slice.call(root.querySelectorAll(s), 0, n); };
    if (w === 'tables') return all('table', 20).map(function (t) { return { caption: txt(t.querySelector('caption')), rows: Array.prototype.slice.call(t.querySelectorAll('tr'), 0, 200).map(function (r) { return Array.prototype.map.call(r.querySelectorAll('th,td'), txt); }) }; });
    if (w === 'links') return all('a[href]', 300).map(function (a) { return { text: txt(a), href: a.href }; });
    if (w === 'forms') return all('input,select,textarea,button', 300).map(function (el) {
        var label = el.labels && el.labels[0] ? txt(el.labels[0]) : (el.getAttribute('aria-label') || '');
        var o = { tag: el.tagName.toLowerCase(), type: el.type, name: el.name, id: el.id, label: label, placeholder: el.getAttribute('placeholder') || '', value: el.type === 'password' ? '(hidden)' : el.value, testId: el.getAttribute('data-testid') || '' };
        if (el.tagName === 'SELECT') o.options = Array.prototype.map.call(el.options, function (x) { return x.text; });
        return o;
    });
    return txt(root);
}`;

export class StudioBrowser {
    private browser: PW = null;
    private context: PW = null;
    private page: PW = null;
    private cdp: PW = null;
    private starting: Promise<void> | null = null;
    private frame: Frame | null = null;
    private seq = 0;
    private lines: string[] = [];
    /** Who acted last (shown in the viewer). */
    lastActor: 'agent' | 'person' | null = null;

    constructor(private readonly o: {
        repoRoot: string; viewport?: { width: number; height: number }; ignoreHttpsErrors?: boolean; proxy?: { server: string; bypass?: string }; headless?: boolean;
        /** Script run in every page and frame (the recorder's element descriptions). */
        initScript?: string;
        /** Attribute the application uses for test ids. */
        testIdAttribute?: string;
        /** A new tab or window opened (it becomes the shown page). */
        onNewPage?: (url: string) => void;
        /** The shown tab closed and another one is shown (its index). */
        onTabShown?: (index: number) => void;
        /** A function the pages call (page.exposeBinding on the browser context), before the init scripts run. */
        binding?: { name: string; fn: (source: { page: PW; frame: PW }, ...args: unknown[]) => unknown };
        /** A second script run in every page and frame (after initScript). */
        extraInitScript?: string;
    }) {}

    /** The page shown now (null when the browser is not running). */
    pageNow(): PW | null { return this.browser && this.page && !this.page.isClosed() ? this.page : null; }

    get running() { return !!this.browser; }

    /** The open tabs (the shown one marked). */
    tabs(): Array<{ index: number; url: string; current: boolean }> {
        return (this.context?.pages() ?? []).map((p: PW, index: number) => ({ index, url: p.url(), current: p === this.page }));
    }

    /** The index of an open tab (its page), or -1. */
    tabIndex(p: PW): number { return this.context?.pages().indexOf(p) ?? -1; }

    /** Every frame of every open tab (to set something in all of them). */
    allFrames(): PW[] { return (this.context?.pages() ?? []).flatMap((p: PW) => p.frames()); }

    /** Show another open tab. */
    async showTab(index: number): Promise<void> {
        const p = this.context?.pages()[index];
        if (!p) throw new Error(`No tab ${index + 1}.`);
        if (p !== this.page) { await this.show(p); await p.bringToFront().catch(() => undefined); }
    }

    private async start() {
        const pw = repoPlaywright(this.o.repoRoot);
        if (!pw?.chromium) throw new Error('Playwright is not installed in this repository (the framework installs it): run npm install.');
        try {
            // A visible window is a normal browser window (its page fills it, it can be resized); hidden: a fixed size.
            const visible = this.o.headless === false;
            // CS_BROWSER_EXECUTABLE: an installed Chromium (as for the Studio's other browsers), e.g. where downloads are blocked.
            this.browser = await pw.chromium.launch({ headless: !visible, ...(visible ? { args: [`--window-size=${this.o.viewport?.width ?? 1280},${(this.o.viewport?.height ?? 800) + 100}`] } : {}), ...(this.o.proxy ? { proxy: this.o.proxy } : {}), ...(process.env.CS_BROWSER_EXECUTABLE ? { executablePath: process.env.CS_BROWSER_EXECUTABLE } : {}) });
        } catch (e) {
            const m = (e as Error).message;
            throw new Error(/Executable doesn't exist/.test(m) ? 'The browser for this repository\'s Playwright is not installed: run npx playwright install chromium.' : m.split('\n')[0]);
        }
        this.context = await this.browser.newContext({ viewport: this.o.headless === false ? null : this.o.viewport ?? { width: 1280, height: 800 }, ignoreHTTPSErrors: !!this.o.ignoreHttpsErrors });
        if (this.o.binding) await this.context.exposeBinding(this.o.binding.name, this.o.binding.fn);
        if (this.o.initScript) await this.context.addInitScript({ content: this.o.initScript });
        if (this.o.extraInitScript) await this.context.addInitScript({ content: this.o.extraInitScript });
        if (this.o.testIdAttribute && this.o.testIdAttribute !== 'data-testid') { try { pw.selectors.setTestIdAttribute(this.o.testIdAttribute); } catch { /* older Playwright */ } }
        this.browser.on('disconnected', () => { this.browser = null; this.context = null; this.page = null; this.cdp = null; });
        // A new tab or window (popup) becomes the shown page.
        this.context.on('page', (p: PW) => { if (this.page) this.o.onNewPage?.(p.url()); void this.show(p); });
        await this.show(await this.context.newPage());
    }

    /** Show a page: screencast its frames. */
    private async show(p: PW) {
        if (this.cdp) { try { await this.cdp.send('Page.stopScreencast'); await this.cdp.detach(); } catch { /* gone */ } }
        this.page = p;
        p.on('close', () => {
            if (this.page !== p) return;
            const others = this.context?.pages().filter((x: PW) => x !== p) ?? [];
            if (others.length) { const next = others[others.length - 1]; void this.show(next); this.o.onTabShown?.(this.context?.pages().indexOf(next) ?? 0); }
        });
        try {
            this.cdp = await this.context.newCDPSession(p);
            this.cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
                this.frame = { data: f.data, seq: ++this.seq, url: p.url(), title: '', width: f.metadata.deviceWidth, height: f.metadata.deviceHeight, at: Date.now() };
                void this.cdp?.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => { /* gone */ });
            });
            await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 });
        } catch { /* no screencast (closed page) */ }
    }

    async ensure(): Promise<PW> {
        if (!this.browser) {
            this.starting ??= this.start().finally(() => { this.starting = null; });
            await this.starting;
        }
        if (!this.page || this.page.isClosed()) await this.show(await this.context.newPage());
        return this.page;
    }

    /** The latest frame (null before the first). */
    latest(after = 0): Frame | null {
        if (!this.frame || this.frame.seq <= after) return null;
        return { ...this.frame, url: this.page?.url() ?? this.frame.url };
    }

    private record(line: string) { this.lines.push(line); }

    /** The agent's actions as a Playwright test (what the recorder converts). */
    recording(): string {
        return `import { test, expect } from '@playwright/test';\n\ntest('test', async ({ page }) => {\n${this.lines.map((l) => `  ${l}`).join('\n')}\n});\n`;
    }
    recordedLines(): string[] { return [...this.lines]; }
    clearRecording() { this.lines = []; }

    async navigate(url: string): Promise<{ url: string; title: string; status?: number }> {
        let u: URL;
        try { u = new URL(url); } catch { throw new Error(`Not an address: ${url}`); }
        if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses can be opened.');
        const page = await this.ensure();
        this.lastActor = 'agent';
        const res = await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
        this.record(`await page.goto(${q(u.toString())});`);
        return { url: page.url(), title: await page.title(), status: res?.status() };
    }

    /** Do something to an element; recorded as the line codegen would write. */
    async act(kind: 'click' | 'dblclick' | 'hover' | 'check' | 'uncheck' | 'fill' | 'press' | 'select', spec: ElementSpec, value?: string | string[]): Promise<string> {
        const page = await this.ensure();
        this.lastActor = 'agent';
        const code = locatorCode(spec);
        const l = locate(page, spec);
        const t = { timeout: 15000 };
        switch (kind) {
            case 'click': await l.click(t); this.record(`await ${code}.click();`); break;
            case 'dblclick': await l.dblclick(t); this.record(`await ${code}.dblclick();`); break;
            case 'hover': await l.hover(t); this.record(`await ${code}.hover();`); break;
            case 'check': await l.check(t); this.record(`await ${code}.check();`); break;
            case 'uncheck': await l.uncheck(t); this.record(`await ${code}.uncheck();`); break;
            case 'fill': await l.fill(String(value ?? ''), t); this.record(`await ${code}.fill(${q(String(value ?? ''))});`); break;
            case 'press': await l.press(String(value ?? 'Enter'), t); this.record(`await ${code}.press(${q(String(value ?? 'Enter'))});`); break;
            case 'select': {
                const vals = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
                await l.selectOption(vals, t);
                this.record(`await ${code}.selectOption(${vals.length === 1 ? q(vals[0]) : `[${vals.map(q).join(', ')}]`});`);
                break;
            }
        }
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { /* still loading */ });
        return `${kind} done: ${code}`;
    }

    /** A check, waiting up to 10 s (as Playwright's expect); recorded as an expect line. */
    async check(kind: 'visible' | 'hidden' | 'text' | 'contains' | 'value' | 'checked' | 'url' | 'title', spec: ElementSpec | null, expected?: string): Promise<{ pass: boolean; actual: string }> {
        const page = await this.ensure();
        const until = Date.now() + 10000;
        let actual = '';
        for (;;) {
            try {
                if (kind === 'url') actual = page.url();
                else if (kind === 'title') actual = await page.title();
                else {
                    const l = locate(page, spec!);
                    if (kind === 'visible' || kind === 'hidden') actual = String(await l.isVisible());
                    else if (kind === 'value') actual = await l.inputValue({ timeout: 2000 });
                    else if (kind === 'checked') actual = String(await l.isChecked({ timeout: 2000 }));
                    else actual = ((await l.textContent({ timeout: 2000 })) ?? '').trim();
                }
            } catch (e) { actual = `(${(e as Error).message.split('\n')[0]})`; }
            const pass = kind === 'visible' ? actual === 'true' : kind === 'hidden' ? actual === 'false' : kind === 'checked' ? actual === 'true'
                : kind === 'contains' || kind === 'url' ? actual.includes(expected ?? '') : actual.trim() === String(expected ?? '').trim();
            if (pass || Date.now() > until) {
                if (pass) {
                    const e = expected ?? '';
                    const code = spec ? locatorCode(spec) : '';
                    this.record({
                        visible: `await expect(${code}).toBeVisible();`, hidden: `await expect(${code}).toBeHidden();`, text: `await expect(${code}).toHaveText(${q(e)});`,
                        contains: `await expect(${code}).toContainText(${q(e)});`, value: `await expect(${code}).toHaveValue(${q(e)});`, checked: `await expect(${code}).toBeChecked();`,
                        url: `await expect(page).toHaveURL(/${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/')}/);`,
                        title: `await expect(page).toHaveTitle(${q(e)});`,
                    }[kind]);
                }
                return { pass, actual };
            }
            await new Promise((r) => setTimeout(r, 300));
        }
    }

    /** What the page shows, as Playwright's accessibility snapshot (roles and names to act on). */
    async snapshot(maxChars = 20000): Promise<{ url: string; title: string; snapshot: string; truncated: boolean }> {
        const page = await this.ensure();
        let snap = '';
        try { snap = await page.locator('body').ariaSnapshot({ timeout: 10000 }); } catch (e) { snap = `(no snapshot: ${(e as Error).message.split('\n')[0]})`; }
        return { url: page.url(), title: await page.title(), snapshot: snap.slice(0, maxChars), truncated: snap.length > maxChars };
    }

    /** Screen scraping: text, tables, links or form fields of the page or of one element. */
    async scrape(what: 'text' | 'tables' | 'links' | 'forms', css?: string, maxChars = 30000): Promise<unknown> {
        const page = await this.ensure();
        const out: unknown = await page.evaluate(`(${SCRAPE_JS})(${JSON.stringify(what)}, ${JSON.stringify(css ?? null)})`);
        const s = JSON.stringify(out);
        if (s.length <= maxChars) return out;
        return typeof out === 'string' ? `${out.slice(0, maxChars)}… (cut at ${maxChars} characters)` : { truncated: true, preview: s.slice(0, maxChars) };
    }

    async screenshot(): Promise<Buffer> {
        const page = await this.ensure();
        return page.screenshot({ type: 'png', timeout: 15000 });
    }

    /** A person in the viewer: click at a point, type, a key, scroll (not recorded as the agent's). */
    async input(e: { type: 'click'; x: number; y: number } | { type: 'type'; text: string } | { type: 'key'; key: string } | { type: 'scroll'; dy: number }) {
        const page = await this.ensure();
        this.lastActor = 'person';
        if (e.type === 'click') await page.mouse.click(e.x, e.y);
        else if (e.type === 'type') await page.keyboard.type(e.text);
        else if (e.type === 'key') await page.keyboard.press(e.key);
        else await page.mouse.wheel(0, e.dy);
    }

    async back() { const p = await this.ensure(); await p.goBack({ timeout: 15000 }).catch(() => null); }
    async reload() { const p = await this.ensure(); await p.reload({ timeout: 30000 }).catch(() => null); }

    async close() {
        const b = this.browser;
        this.browser = null; this.context = null; this.page = null; this.cdp = null; this.frame = null;
        if (b) await b.close().catch(() => { /* gone */ });
    }
}
