/**
 * Recording inside the Studio: the application runs in a Playwright browser (the project's own) whose
 * screen the Studio shows live; every click and key reaches the page through the Studio, so each step
 * is written BEFORE the page reacts (a click that navigates away cannot lose its step):
 *  - click: the element under the pointer (inside frames too) → its locator, checked with Playwright
 *    (it must find exactly that element) → the step → the click;
 *  - typing goes to the focused field; one "fill" step is written when the field is left (another
 *    click, Tab, Enter) with the field's final value;
 *  - lists (select) show their options in the Studio (a background browser draws no dropdowns): the
 *    choice is the step; check boxes and radio buttons become check / uncheck;
 *  - checks: the element (or the page) and the expected text / value, proposed from the page and
 *    confirmed by the tester.
 * Steps are written as Playwright lines (the format the Recorder's conversion reads) to the recording's
 * script file, so the review, test data, pages, steps and saving are the same as for every recording.
 */
import * as fs from 'fs';
import { StudioBrowser } from '../agents/browser';
import { inpageWith } from './inpage';
import { Action, convertScript, Target } from './convert';
import { WINDOW_BINDING, WINDOW_JS, WindowMessage } from './window';
import { FwLocator, locatorSupport, LocatorSupport, roleName } from '../framework/locators';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PW = any;
/* Functions passed to evaluate() run in the browser: they reach its globals through globalThis (the server has no DOM types). */
/* eslint-disable @typescript-eslint/no-explicit-any */

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
const lit = (v: unknown): string => typeof v === 'string' ? q(v) : typeof v === 'boolean' || typeof v === 'number' ? String(v)
    : v && typeof v === 'object' ? `{ ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }` : 'undefined';

export interface ElementInfo {
    tag: string; type: string; role: string; name: string; editable: boolean; text: string; value: string;
    check: boolean; checked: boolean; select: boolean; multiple: boolean; file: boolean; password: boolean; disabled: boolean;
    options?: Array<{ value: string; label: string; selected: boolean }>;
    attributes?: Array<{ name: string; value: string }>;
    cell?: { rowKey: string; col: number; header: string; text: string; table?: string };
}
interface Found { frame: PW; target: PW; code: string; info: ElementInfo; box: { x: number; y: number; width: number; height: number } | null; base: string }
export type CheckKind = 'visible' | 'text' | 'contains' | 'value' | 'checked' | 'url' | 'title' | 'hidden' | 'enabled' | 'disabled' | 'attribute' | 'count' | 'cell' | 'compare' | 'column' | 'wait';
export interface Step { index: number; line: string }
/** A check suggested from what an action changed on the page; accepted with confirm (kind, code, expected). */
export interface Suggestion { kind: CheckKind; code: string; expected: string; label: string; why: string }
interface SnapItem { i: number; how: 'appeared' | 'changed' | 'gone'; text: string; was: string; announces: boolean; heading: boolean; tag: string }

/** A text that is a number (1,250.00 · -3 · $45 · 12 %), else null. */
function numberText(t: string): number | null {
    const m = /^\s*([-+]?)\s*[$€£₹]?\s*([\d,]*\.?\d+)\s*[%$€£₹A-Za-z]{0,4}\s*$/.exec(t);
    return m ? Number(`${m[1]}${m[2].replace(/,/g, '')}`) : null;
}

export class StudioRecorder {
    readonly browser: StudioBrowser;
    private lines: string[] = [];
    paused = false;
    private editing: { found: Found; start: string } | null = null;
    private pendingSelect: Found | null = null;
    /** Recording in a real window: the check being picked, the element picked, what the Studio is to show. */
    private pickMode: string | null = null;
    private picked: { x: number; y: number; seq: number } | null = null;
    private windowUi: { seq: number; select?: unknown; file?: unknown; dialog?: unknown; note?: string } | null = null;
    private windowSeq = 0;
    /** Framework locators by element code (see frameworkLocators). */
    private fwOf = new Map<string, FwLocator[]>();
    private support: LocatorSupport | null = null;
    /** A dialog of the page (alert, confirm, prompt) waiting for the tester's answer; the line of the click that opened it. */
    private pendingDialog: { dialog: PW; type: string; message: string; defaultValue: string; at: number } | null = null;
    /** A file field (or a button that opened a file chooser) waiting for files. */
    private pendingFile: { found: Found; chooser: PW | null } | null = null;
    private watched = new WeakSet<object>();
    private queue: Promise<unknown> = Promise.resolve();
    /** Locators the recorder proposed for checks (only these can be confirmed). */
    private proposed = new Set<string>(['page']);
    private found = new Map<string, Found>();
    /** Path of the page the last step was on: a step on another path starts a new page object. */
    private lastPath = '';
    notes: string[] = [];
    /** Recording from a step of an earlier recording: where the next step goes (null: at the end). */
    private insertAt: number | null = null;
    /** Replaying an earlier recording up to a step (before recording from there). */
    replayState: { done: number; total: number; after: number; error?: string; finished: boolean } | null = null;
    /** Suggest checks from what each click or Enter changed on the page (on by default). */
    suggest = true;
    private suggestions: { seq: number; after: string; items: Suggestion[] } | null = null;
    private suggestSeq = 0;
    private snapAt: { path: string; title: string; seq: number } | null = null;
    /** Each input (click, key, typing, list, navigation…) counts: a suggestion worked out for an earlier one is dropped. */
    private inputSeq = 0;
    /** An input starts: the suggestions shown are for the action before it. */
    private nextInput() { this.inputSeq++; this.suggestions = null; }

    constructor(private readonly o: { repoRoot: string; file: string; testIdAttribute: string; /** Where uploaded files are kept until the test is saved. */ uploadDir?: string; proxy?: { server: string; bypass?: string }; ignoreHttpsErrors?: boolean; viewport?: { width: number; height: number };
        /** Record in a visible browser window on this computer (the person uses the window; see window.ts). */
        window?: boolean;
        /** The project's locator policy (see locatorPolicy): ids and classes never used to find an element. */
        policy?: { ignoreId?: string; ignoreClass?: string }; onClosed: () => void }) {
        this.browser = new StudioBrowser({
            repoRoot: o.repoRoot, viewport: o.viewport ?? { width: 1280, height: 800 }, ignoreHttpsErrors: o.ignoreHttpsErrors, proxy: o.proxy,
            initScript: inpageWith(o.policy), testIdAttribute: o.testIdAttribute,
            ...(o.window ? { headless: false, extraInitScript: WINDOW_JS, binding: { name: WINDOW_BINDING, fn: (source: { page: PW; frame: PW }, m: unknown) => this.fromWindow(source, m as WindowMessage) } } : {}),
            // A new tab or window: the steps after it act in it (the test switches to it too).
            onNewPage: (url) => { if (!this.paused) this.add(`await cs.switchTab('new'); // ${url.replace(/\n/g, ' ').slice(0, 200)}`); this.notes.push(`A new tab or window opened (${url}): the next steps act in it.`); },
            onTabShown: (index) => { if (!this.paused) this.add(`await cs.switchTab(${index});`); },
        });
    }

    /** One thing at a time, in order (input arrives faster than the page answers). */
    private serial<T>(f: () => Promise<T>): Promise<T> { const p = this.queue.then(f, f); this.queue = p.catch(() => undefined); return p; }

    private write() {
        // The framework locators of the elements the steps use (// cs-locator {code, fw}), best first.
        const marks = [...this.fwOf].filter(([code, fw]) => fw.length && this.lines.some((l) => l.includes(code))).map(([code, fw]) => `// cs-locator ${JSON.stringify({ code, fw })}`);
        const body = [...this.lines, ...marks];
        fs.writeFileSync(this.o.file, `import { test, expect } from '@playwright/test';\n\ntest('test', async ({ page }) => {\n${body.map((l) => `  ${l}`).join('\n')}${body.length ? '\n' : ''}});\n`);
    }
    private add(line: string) {
        const goto = /^await page\.goto\('((?:[^'\\]|\\.)*)'\);$/.exec(line);
        if (goto) { try { this.lastPath = new URL(goto[1]).pathname; } catch { /* as is */ } }
        else if (!line.startsWith('//')) {
            // The application moved to another page (a link, a form, a single-page app route): mark it, so
            // the steps from here on belong to that page's object.
            const url = this.browser.pageNow()?.url() ?? '';
            let p = '';
            try { p = new URL(url).pathname; } catch { /* about:blank */ }
            if (p && p !== this.lastPath) {
                if (this.lines.length) { if (this.insertAt === null) this.lines.push(`// cs-page ${url}`); else this.lines.splice(this.insertAt++, 0, `// cs-page ${url}`); }
                this.lastPath = p;
            }
        }
        if (this.insertAt === null) this.lines.push(line);
        else this.lines.splice(this.insertAt++, 0, line);
        this.write();
    }

    steps(): Step[] { return this.lines.map((line, index) => ({ index, line })); }

    /** Recording in a real window (see window.ts). */
    get inWindow() { return !!this.o.window; }

    /** What the Studio shows for a real window: the element picked for a check, a list / file / dialog to answer. */
    windowState() { return { picked: this.picked, ui: this.windowUi }; }

    /** A check chosen in the Studio's toolbar: the window's next click picks its element (outlined under the pointer). */
    async setPick(mode: string | null) {
        this.pickMode = mode;
        await Promise.all(this.browser.allFrames().map((f: PW) => f.evaluate((on: boolean) => {
            (globalThis as any).__csPick = on;
            if (!on) (globalThis as any).dispatchEvent(new Event('__csPickOff'));
        }, !!mode).catch(() => undefined)));
    }

    /** A message of the window's page: its point in page coordinates, the tab it is in shown, the action done. */
    private async fromWindow(source: { page: PW; frame: PW }, m: WindowMessage) {
        if (!m || typeof m !== 'object') return;
        if (m.type === 'typing') return this.typingStarted(typeof m.value === 'string' ? m.value : '');
        // A frame's point in the page: the frame element's place (its border and padding) added.
        let dx = 0, dy = 0;
        for (let f = source.frame; f && f.parentFrame(); f = f.parentFrame()) {
            const fe = await f.frameElement().catch(() => null);
            if (!fe) break;
            const off = await fe.evaluate((e: { getBoundingClientRect(): { left: number; top: number } }) => { const b = e.getBoundingClientRect(), st = (globalThis as any).getComputedStyle(e); return { x: b.left + parseFloat(st.borderLeftWidth) + parseFloat(st.paddingLeft), y: b.top + parseFloat(st.borderTopWidth) + parseFloat(st.paddingTop) }; }).catch(() => ({ x: 0, y: 0 }));
            dx += off.x; dy += off.y;
        }
        const x = Number(m.x) + dx, y = Number(m.y) + dy;
        // The person acted in another tab or window: the steps from here on act in it.
        if (source.page !== this.browser.pageNow()) { const i = this.browser.tabIndex(source.page); if (i >= 0) await this.switchTab(i); }
        const show = (r: { select?: unknown; file?: unknown; dialog?: unknown; note?: string }) => {
            if (r.select || r.file || r.dialog || r.note) this.windowUi = { seq: ++this.windowSeq, ...(r.select ? { select: r.select } : {}), ...(r.file ? { file: r.file } : {}), ...(r.dialog ? { dialog: r.dialog } : {}), ...(r.note ? { note: r.note } : {}) };
        };
        switch (m.type) {
            case 'pick': this.picked = { x, y, seq: ++this.windowSeq }; await this.setPick(null); return;
            case 'click': show(await this.click(x, y)); return;
            case 'dblclick': await this.dblclick(x, y); return;
            case 'rightclick': await this.rightClick(x, y); return;
            case 'drag': await this.drag(x, y, Number(m.x2) + dx, Number(m.y2) + dy); return;
            case 'key': if (typeof m.key === 'string' && m.key.length <= 40) await this.key(m.key); return;
        }
    }

    /** Typing in the window starts (the browser types): the field and its text before it, for the "fill" step. */
    private typingStarted(value: string): Promise<void> {
        return this.serial(async () => {
            this.nextInput();
            if (this.paused) return;
            if (this.editing) {
                // Still the same field (the page may move the focus without a click or Tab).
                const same = await this.editing.found.target.evaluate((e: unknown) => { let a = (e as any).ownerDocument.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a === e; }).catch(() => false);
                if (same) return;
                await this.flush();
            }
            const f = await this.focused();
            if (f) this.editing = { found: f, start: value };
        });
    }

    async start(url: string) {
        await this.serial(async () => {
            const page = await this.browser.ensure();
            page.on?.('close', () => undefined);
            this.add(`await page.goto(${q(url)});`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        });
        this.watchClosed();
    }

    /** The browser closed (Stop, or it crashed): the recording ends. */
    private watchClosed() {
        const watch = setInterval(() => { if (!this.browser.running) { clearInterval(watch); this.o.onClosed(); } }, 1000);
        watch.unref?.();
    }

    /** Where new steps go: after step (line index) n of the recording, or null at the end (for the Studio to show). */
    insertPoint() { return this.insertAt; }

    /**
     * Record from a step of an earlier recording: its steps are kept; the steps up to that one (an action index, as
     * the review numbers them) are done again in the browser, from the recording's own actions (no code is run);
     * then new steps go after that one, before the steps after it. A step that cannot be done again stops the replay:
     * the recording is paused there, so the person can get the application to that point and resume.
     */
    async resume(script: string, upTo: number) {
        const ts = require('typescript') as typeof import('typescript');
        const conv = convertScript(ts, script, { testIdAttribute: this.o.testIdAttribute });
        const fileLines = script.replace(/\r\n/g, '\n').split('\n');
        const start = fileLines.findIndex((l) => /^test\(/.test(l));
        let end = fileLines.length - 1;
        while (end > start && fileLines[end].trim() !== '});') end--;
        if (start < 0 || end <= start) throw new Error('This recording has no steps to record from.');
        const body = fileLines.slice(start + 1, end).map((l) => l.replace(/^ {2}/, ''));
        // The framework locators confirmed while recording (written again with the steps that use them).
        const kept: string[] = [];
        const bodyIndex: number[] = [];
        body.forEach((l, i) => {
            const m = /^\/\/ cs-locator (\{.*\})\s*$/.exec(l);
            if (m) { try { const j = JSON.parse(m[1]) as { code: string; fw: never[] }; if (typeof j.code === 'string' && Array.isArray(j.fw)) this.fwOf.set(j.code, j.fw); } catch { /* skip */ } bodyIndex.push(-1); return; }
            bodyIndex.push(kept.length); kept.push(l);
        });
        const actions = conv.actions;
        if (!actions.length) throw new Error('This recording has no steps to record from.');
        const last = Math.min(Math.max(0, Math.floor(upTo)), actions.length - 1);
        const lineIdx = (a: Action) => bodyIndex[a.line - 1 - (start + 1)] ?? -1;
        const at = lineIdx(actions[last]);
        this.lines = kept;
        this.insertAt = last === actions.length - 1 || at < 0 ? null : at + 1;
        for (const l of kept.slice(0, this.insertAt ?? kept.length)) {
            const g = /^await page\.goto\('((?:[^'\\]|\\.)*)'\);$/.exec(l) ?? /^\/\/ cs-page (\S+)/.exec(l);
            if (g) { try { this.lastPath = new URL(g[1]).pathname; } catch { /* as is */ } }
        }
        this.write();
        await this.browser.ensure();
        this.watchClosed();
        this.replayState = { done: 0, total: last + 1, after: last, finished: false };
        // Nothing is recorded while the steps are done again (a new tab, a dialog).
        this.paused = true;
        void this.serial(() => this.replay(actions.slice(0, last + 1)));
    }

    private async replay(actions: Action[]) {
        const st = this.replayState!;
        const locOf = (t: Target): PW => { let r: PW = this.page(); for (const f of t.frames) r = r.frameLocator(f); return r.locator(t.selector); };
        const T = { timeout: 15000 };
        let dialog: Action | null = null;
        for (let i = 0; i < actions.length; i++) {
            const a = actions[i];
            const page = this.page();
            if (dialog) { const d = dialog; dialog = null; page.once('dialog', (x: PW) => { void (d.attribute === 'accept' ? x.accept(d.values?.[0]) : x.dismiss()).catch(() => undefined); }); }
            try {
                const el = a.target ? locOf(a.target) : null;
                switch (a.kind) {
                    case 'goto': await page.goto(a.value!, { waitUntil: 'domcontentloaded', timeout: 60000 }); break;
                    case 'click': await el.click(T); break;
                    case 'dblclick': await el.dblclick(T); break;
                    case 'rightclick': await el.click({ ...T, button: 'right' }); break;
                    case 'hover': await el.hover(T); break;
                    case 'fill': await el.fill(a.value ?? '', T); break;
                    case 'press': await el.press(a.value!, T); break;
                    case 'pressKey': await page.keyboard.press(a.value!); break;
                    case 'check': await el.check(T); break;
                    case 'uncheck': await el.uncheck(T); break;
                    case 'select': await el.selectOption(a.values ?? [], T); break;
                    case 'upload': {
                        const path = require('path') as typeof import('path');
                        if (!this.o.uploadDir) throw new Error('its files are not kept');
                        await el.setInputFiles((a.values ?? []).map((n) => path.join(this.o.uploadDir!, path.basename(n))), T);
                        break;
                    }
                    case 'drag':
                        if (a.target2) await el.dragTo(locOf(a.target2), T);
                        else if (a.at) { const b = await el.boundingBox(); if (b) await el.dragTo(el, { ...T, targetPosition: { x: a.at.x * b.width, y: a.at.y * b.height } }); }
                        break;
                    case 'dialog': dialog = a; break;
                    case 'switchTab': {
                        if (a.value === 'new') { for (let k = 0; k < 40 && this.browser.tabs().length < 2; k++) await new Promise((r) => setTimeout(r, 100)); await this.browser.showTab(this.browser.tabs().length - 1); }
                        else if (/^\d+$/.test(a.value ?? '')) await this.browser.showTab(Number(a.value));
                        break;
                    }
                    case 'closeTab': await page.close(); break;
                    default:
                        // A check: its element is waited for (the page as the recording saw it), not checked.
                        if (el && a.kind !== 'expectCount' && a.kind !== 'expectColumn') await el.first().waitFor({ state: a.kind === 'expectHidden' ? 'hidden' : 'visible', timeout: 10000 }).catch(() => undefined);
                }
                await this.page().waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
                st.done = i + 1;
            } catch (e) {
                st.error = `Step ${i + 1} could not be done again (${(e as Error).message.split('\n')[0].slice(0, 200)}). The recording is paused: get the application to where step ${st.after + 1} left it, then resume.`;
                this.notes.push(st.error);
                st.finished = true;
                return;
            }
        }
        st.finished = true;
        this.paused = false;
    }

    private page(): PW { const p = this.browser.pageNow(); if (!p) throw new Error('The recording browser is closed.'); return p; }

    /** The element at a point of the shown page (into frames), with a locator Playwright confirms. */
    private async at(x: number, y: number, o: { raw?: boolean; forText?: boolean; /** Only pointing (hover): no framework locators. */ light?: boolean } = {}): Promise<Found | null> {
        let frame = this.page().mainFrame();
        let fx = x, fy = y;
        const prefix: string[] = [];
        for (let depth = 0; depth < 6; depth++) {
            // The element under the point, into open shadow roots (web components).
            const h = await frame.evaluateHandle(([px, py]: number[]) => {
                let e = (globalThis as any).document.elementFromPoint(px, py);
                for (let i = 0; i < 10 && e?.shadowRoot; i++) { const inner = e.shadowRoot.elementFromPoint(px, py); if (!inner || inner === e) break; e = inner; }
                return e;
            }, [fx, fy]);
            const el = h.asElement();
            if (!el) return null;
            const tag: string = await el.evaluate((e: { tagName: string }) => e.tagName);
            if (tag === 'IFRAME' || tag === 'FRAME') {
                const child = await el.contentFrame();
                if (!child) return null;
                const off = await el.evaluate((e: { getBoundingClientRect(): { left: number; top: number } }) => { const b = e.getBoundingClientRect(), st = (globalThis as any).getComputedStyle(e); return { x: b.left + parseFloat(st.borderLeftWidth) + parseFloat(st.paddingLeft), y: b.top + parseFloat(st.borderTopWidth) + parseFloat(st.paddingTop) }; });
                const cands: string[] = await el.evaluate((e: unknown) => (globalThis as any).__csRec.frameCandidates(e));
                let chosen = cands[cands.length - 1];
                for (const c of cands) { if (await this.same(frame.locator(c), el)) { chosen = c; break; } }
                prefix.push(`.locator(${q(chosen)}).contentFrame()`);
                frame = child; fx -= off.x; fy -= off.y;
                continue;
            }
            const target = o.raw ? el : (await el.evaluateHandle((e: unknown) => (globalThis as any).__csRec.target(e))).asElement() ?? el;
            return this.describe(frame, target, `page${prefix.join('')}`, o.forText, !o.light);
        }
        return null;
    }

    private async same(loc: PW, handle: PW): Promise<boolean> {
        try { return (await loc.count()) === 1 && await loc.evaluate((e: unknown, t: unknown) => e === t, handle); } catch { return false; }
    }

    /** A locator chain applied to a frame (Playwright objects), and as code. */
    private chain(frame: PW, c: Array<{ m: string; a: unknown[] }>): PW { let l: PW = frame; for (const x of c) l = l[x.m](...x.a); return l; }
    private chainCode(base: string, c: Array<{ m: string; a: unknown[] }>) { return `${base}${c.map((x) => `.${x.m}(${x.a.map(lit).join(', ')})`).join('')}`; }

    /**
     * The element's locator: the first candidate Playwright confirms finds exactly it (on the page as it
     * is now). For a text check, locators made of the element's own text come last (the text is what is
     * checked, and it often holds changing numbers).
     */
    private async describe(frame: PW, target: PW, base: string, forText = false, fw = true): Promise<Found> {
        const info: ElementInfo = await target.evaluate((e: unknown) => (globalThis as any).__csRec.info(e));
        let cands: Array<{ c: Array<{ m: string; a: unknown[] }>; u: boolean }> = await target.evaluate((e: unknown, attr: string) => (globalThis as any).__csRec.candidates(e, attr), this.o.testIdAttribute);
        if (forText) {
            const textual = (x: { c: Array<{ m: string; a: unknown[] }> }) => x.c.some((y) => y.m === 'getByText') || (x.c[0].m === 'getByRole' && /\d/.test(JSON.stringify(x.c[0].a[1] ?? '')));
            const path = (x: { c: Array<{ m: string; a: unknown[] }> }) => x.c.length === 1 && x.c[0].m === 'locator' && / > /.test(String(x.c[0].a[0]));
            cands = [...cands.filter((x) => !textual(x) && !path(x)), ...cands.filter(textual), ...cands.filter(path)];
        }
        let pick: Array<{ m: string; a: unknown[] }> | null = null;
        for (const c of cands) {
            let ok = false;
            try { ok = await this.same(this.chain(frame, c.c), target); } catch { ok = false; }
            if (ok) { pick = c.c; break; }
        }
        pick ??= (cands.find((c) => c.u) ?? cands[cands.length - 1]).c;
        const code = this.chainCode(base, pick);
        let box = null;
        try { box = await target.boundingBox(); } catch { /* detached */ }
        if (fw && !this.fwOf.has(code)) this.fwOf.set(code, await this.frameworkLocators(frame, target, info, base !== 'page', forText).catch(() => []));
        return { frame, target, code, info, box, base };
    }

    /**
     * The element's locators as the project's framework finds them (CSWebElement), each one confirmed on the page
     * now to find exactly this element, the way the framework builds it (inside a frame page, its frame forms);
     * best first by the framework's locator linter.
     */
    private async frameworkLocators(frame: PW, target: PW, info: ElementInfo, inFrame: boolean, /** Its text is what a check reads. */ forText = false): Promise<FwLocator[]> {
        const sup = this.support ??= locatorSupport(this.o.repoRoot);
        const a: { tid: string | null; id: string; nm: string | null; ph: string | null } = await target.evaluate((e: any) => ({ tid: e.getAttribute('data-testid'), id: e.id || '', nm: e.getAttribute('name'), ph: e.getAttribute('placeholder') }));
        const plain = (v: string | null): v is string => !!v && v.length <= 100 && !/["\\\n]/.test(v);
        const out: FwLocator[] = [];
        const tryOne = async (key: FwLocator['key'], value: string, loc: () => PW) => {
            let ok = false;
            try { ok = await this.same(loc(), target); } catch { ok = false; }
            if (ok) out.push({ key, value, score: sup.score(key, value) });
        };
        if (plain(a.tid)) await tryOne('testId', a.tid, () => frame.locator(`[data-testid="${a.tid}"]`));
        let ignoreId: RegExp | null = null;
        try { ignoreId = this.o.policy?.ignoreId ? new RegExp(this.o.policy.ignoreId) : null; } catch { ignoreId = null; }
        if (/^[A-Za-z][\w-]*$/.test(a.id) && !/\d{4,}/.test(a.id) && !/^(ember|react|mui|radix|headlessui|ext-gen)/i.test(a.id) && !ignoreId?.test(a.id)) await tryOne('id', a.id, () => frame.locator(`#${a.id}`));
        if (plain(a.nm)) await tryOne('name', a.nm, () => frame.locator(`[name="${a.nm}"]`));
        const r = info.role, n = (info.name ?? '').trim();
        if (sup.roleNames && r && r !== 'presentation' && r !== 'generic' && n && n.length <= 100) {
            const before = out.length;
            await tryOne('role', roleName(r, n, false), () => frame.getByRole(r, { name: n }));
            if (out.length === before) await tryOne('role', roleName(r, n, true), () => frame.getByRole(r, { name: n, exact: true }));
        }
        // Text finds an element only while the text stays: a label (the name of a button, link, heading…), not
        // content that changes (a counter, a status, a value: what checks read). Otherwise only when nothing else
        // finds the element.
        const txt = (info.text ?? '').trim();
        const label = !!r && r !== 'generic' && txt === n;
        if (txt && txt.length <= 40 && !/["'\n\/]/.test(txt) && (label || (!forText && !out.length))) await tryOne('text', txt, () => (inFrame ? frame.locator(`text=${txt}`) : frame.getByText(txt)));
        if (plain(a.ph)) await tryOne('placeholder', a.ph, () => (inFrame ? frame.locator(`[placeholder="${a.ph}"]`) : frame.getByPlaceholder(a.ph)));
        return out.sort((x, y) => y.score - x.score);
    }

    /** The checks suggested for the last action (null: none, or the next action started). */
    suggested() { return this.suggestions; }

    /** The page before an action: what it shows (in the page), its address and title. */
    private async snapBefore(): Promise<number> {
        this.nextInput();
        const seq = this.inputSeq;
        this.snapAt = null;
        if (!this.suggest || this.paused) return seq;
        try {
            const page = this.page();
            await page.mainFrame().evaluate(() => (globalThis as any).__csRec?.snapBefore());
            let p = page.url(); try { p = new URL(p).pathname; } catch { /* as is */ }
            this.snapAt = { path: p, title: await page.title(), seq };
        } catch { this.snapAt = null; }
        return seq;
    }

    /**
     * After the action, once the page settles: the checks a tester would add for what changed. The address when it
     * changed; a message that appeared (alert, status, toast); a heading or text that appeared or changed (a counter);
     * a message that went away. At most four, each with a locator Playwright confirms finds exactly its element.
     */
    private async suggestAfter(step: string, seq: number) {
        const at = this.snapAt;
        // Another input came after the action (it waited in the queue): the page's changes are no longer the action's.
        if (!at || at.seq !== seq || this.inputSeq !== seq || !this.suggest || this.paused) return;
        this.snapAt = null;
        const page = this.page();
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 500));
        const frame = page.mainFrame();
        let diff: { fresh: boolean; items: SnapItem[] };
        try { diff = await frame.evaluate(() => (globalThis as any).__csRec?.snapDiff() ?? { fresh: true, items: [] }); } catch { return; }
        const out: Suggestion[] = [];
        let path = page.url(); try { path = new URL(path).pathname; } catch { /* as is */ }
        if (path !== at.path) out.push({ kind: 'url', code: 'page', expected: path, label: 'Page address (path)', why: `The address changed (was ${at.path})` });
        const title = await page.title().catch(() => at.title);
        if (title && title !== at.title) out.push({ kind: 'title', code: 'page', expected: title, label: 'Page title', why: 'The title changed' });
        const short = (t: string) => t.length <= 120;
        // Texts that change on their own (clocks, timers) are not worth a check.
        const clock = (t: string) => /^\s*\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\s*$/i.test(t);
        const rank = (x: SnapItem) => (x.announces ? 4 : 0) + (x.heading ? 2 : 0) + (x.how === 'appeared' ? 1 : 0);
        const shownItems = diff.items.filter((x) => x.how !== 'gone' && x.i >= 0 && short(x.text) && !clock(x.text)).sort((a, b) => rank(b) - rank(a));
        const picked: SnapItem[] = [];
        for (const x of shownItems) {
            if (picked.length >= 3) break;
            // One check per message: a part of a text already checked is not checked again.
            if (picked.some((y) => y.text.includes(x.text) || x.text.includes(y.text))) continue;
            // A plain text that appeared on a new page is the page itself: its heading says enough.
            if (diff.fresh && !x.heading && !x.announces) continue;
            if (diff.fresh && x.heading && picked.some((y) => y.heading)) continue;
            picked.push(x);
        }
        for (const x of picked) {
            try {
                const h = await frame.evaluateHandle((i: number) => (globalThis as any).__csRec.snapEl(i), x.i);
                const el = h.asElement();
                if (!el) continue;
                const f = await this.describe(frame, el, 'page', true);
                this.found.set(f.code, f);
                this.proposed.add(f.code);
                const what = x.announces ? 'A message' : x.heading ? 'A heading' : 'A text';
                const kind: CheckKind = x.how === 'changed' || x.heading ? 'text' : 'contains';
                out.push({ kind, code: f.code, expected: x.text, label: f.info.role && f.info.name && f.info.name !== x.text ? `${f.info.role} ${f.info.name}`.slice(0, 80) : '',
                    why: x.how === 'changed' ? `${what} changed (was "${x.was.slice(0, 60)}")` : `${what} appeared` });
            } catch { /* gone again */ }
        }
        const gone = diff.items.find((x) => x.how === 'gone' && x.text.length <= 80 && !/["\n]/.test(x.text));
        if (gone && out.length < 4) out.push({ kind: 'hidden', code: 'page', expected: gone.text, label: 'Text that should not be shown', why: 'A message went away' });
        // Only when no input came while they were worked out (the next input clears them).
        if (out.length && this.inputSeq === seq) this.suggestions = { seq: ++this.suggestSeq, after: step, items: out.slice(0, 4) };
    }

    /** A suggested check accepted or dismissed: it is no longer shown. */
    dropSuggestion(kind: string, code: string, expected?: string) {
        const s = this.suggestions;
        if (!s) return;
        s.items = s.items.filter((x) => !(x.kind === kind && x.code === code && (expected === undefined || x.expected === expected)));
        if (!s.items.length) this.suggestions = null;
    }

    /** A focused field's text is a "fill" step when it changed. */
    private async flush() {
        const e = this.editing;
        this.editing = null;
        if (!e) return;
        let v: string | null = null;
        try { v = await e.found.target.evaluate((x: { isContentEditable: boolean; innerText: string; value: string }) => (x.isContentEditable ? x.innerText : x.value)); } catch { v = null; }
        if (v !== null && v !== e.start) this.add(`await ${e.found.code}.fill(${q(v)});`);
    }

    /** The field that has the focus (into frames), when it takes text. */
    private async focused(): Promise<Found | null> {
        let frame = this.page().mainFrame();
        const prefix: string[] = [];
        for (let depth = 0; depth < 6; depth++) {
            const h = await frame.evaluateHandle(() => (globalThis as any).document.activeElement);
            const el = h.asElement();
            if (!el) return null;
            const tag: string = await el.evaluate((e: { tagName: string }) => e.tagName);
            if (tag === 'IFRAME' || tag === 'FRAME') {
                const child = await el.contentFrame();
                if (!child) return null;
                const cands: string[] = await el.evaluate((e: unknown) => (globalThis as any).__csRec.frameCandidates(e));
                let chosen = cands[cands.length - 1];
                for (const c of cands) { if (await this.same(frame.locator(c), el)) { chosen = c; break; } }
                prefix.push(`.locator(${q(chosen)}).contentFrame()`);
                frame = child;
                continue;
            }
            const f = await this.describe(frame, el, `page${prefix.join('')}`);
            return f.info.editable ? f : null;
        }
        return null;
    }

    /** A click at a point of the picture. Lists answer with their options instead (the Studio shows them). */
    click(x: number, y: number): Promise<{ step?: string; select?: { options: NonNullable<ElementInfo['options']>; multiple: boolean; label: string }; note?: string; file?: { label: string; multiple: boolean }; dialog?: { type: string; message: string; defaultValue: string } | null }> {
        return this.serial(async () => {
            const page = this.page();
            this.browser.lastActor = 'person';
            this.nextInput();
            if (this.paused) { await page.mouse.click(x, y); return {}; }
            const f = await this.at(x, y);
            if (this.editing && (!f || f.target !== this.editing.found.target)) await this.flush();
            if (!f) { await page.mouse.click(x, y); return {}; }
            if (f.info.select) { this.pendingSelect = f; return { select: { options: f.info.options ?? [], multiple: f.info.multiple, label: f.info.name || 'list' } }; }
            this.watch(page);
            if (f.info.file) {
                this.pendingFile = { found: f, chooser: null };
                return { file: { label: f.info.name || 'file', multiple: !!f.info.attributes?.some((a) => a.name === 'multiple') } };
            }
            if (f.info.editable) {
                if (!this.editing) this.editing = { found: f, start: f.info.value };
                await page.mouse.click(x, y);
                return {};
            }
            if (f.info.check) {
                await page.mouse.click(x, y);
                let now = f.info.checked;
                try { now = await f.target.evaluate((e: { checked: boolean }) => e.checked); } catch { /* gone */ }
                const line = `await ${f.code}.${now || f.info.type === 'radio' ? 'check' : 'uncheck'}();`;
                this.add(line);
                return { step: line };
            }
            const seq = await this.snapBefore();
            const line = `await ${f.code}.click();`;
            this.add(line);
            // A button that opens a file chooser (a styled "Browse" / "Upload"): the step is the upload itself.
            let chooser: PW = null;
            const onChooser = (c: PW) => { chooser = c; };
            page.on('filechooser', onChooser);
            // A dialog opened by the click blocks it until answered: answered from the Studio.
            const clicked = page.mouse.click(x, y).catch(() => undefined);
            for (let i = 0; i < 400 && !this.pendingDialog; i++) { if (await Promise.race([clicked.then(() => true), new Promise((r) => setTimeout(() => r(false), 25))])) break; }
            if (this.pendingDialog) { page.off('filechooser', onChooser); return { step: line, dialog: this.dialogInfo() }; }
            for (let i = 0; i < 6 && !chooser; i++) await new Promise((r) => setTimeout(r, 50));
            page.off('filechooser', onChooser);
            if (chooser) {
                if (this.lines[this.lines.length - 1] === line) { this.lines.pop(); this.write(); }
                // The chooser's element lives in Playwright's own world: the page's world has the recorder's helpers.
                const fr = await chooser.element().ownerFrame();
                const el = await fr.evaluateHandle((e: unknown) => e, chooser.element());
                const found = await this.describe(fr, el, await this.prefixFor(fr));
                this.pendingFile = { found, chooser };
                return { file: { label: found.info.name || f.info.name || 'file', multiple: !!chooser.isMultiple() } };
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
            // The checks for what the click changed, worked out after it (the next input waits for them).
            void this.serial(() => this.suggestAfter(line, seq));
            return { step: line };
        });
    }

    /** Double-click (e.g. a cell that becomes editable). */
    dblclick(x: number, y: number): Promise<{ step?: string }> { return this.mouseAction(x, y, 'dblclick'); }
    /** Right-click (a context menu). */
    rightClick(x: number, y: number): Promise<{ step?: string }> { return this.mouseAction(x, y, 'right'); }
    /** Point at an element (a menu that opens on hover). */
    hoverOn(x: number, y: number): Promise<{ step?: string }> { return this.mouseAction(x, y, 'hover'); }

    private mouseAction(x: number, y: number, how: 'dblclick' | 'right' | 'hover'): Promise<{ step?: string }> {
        return this.serial(async () => {
            const page = this.page();
            const f = this.paused ? null : await this.at(x, y);
            this.nextInput();
            if (this.editing && (!f || f.target !== this.editing.found.target)) await this.flush();
            let step: string | undefined;
            if (f) {
                step = `await ${f.code}.${how === 'dblclick' ? 'dblclick()' : how === 'right' ? "click({ button: 'right' })" : 'hover()'};`;
                this.add(step);
            }
            if (how === 'dblclick') await page.mouse.dblclick(x, y);
            else if (how === 'right') await page.mouse.click(x, y, { button: 'right' });
            else await page.mouse.move(x, y, { steps: 4 });
            return step ? { step } : {};
        });
    }

    /**
     * Drag from one point to another: onto another element (drag and drop: dragTo), or within the same one
     * (a slider: to a position in it, kept as a share of its width/height).
     */
    drag(x1: number, y1: number, x2: number, y2: number): Promise<{ step?: string }> {
        return this.serial(async () => {
            const page = this.page();
            const from = this.paused ? null : await this.at(x1, y1);
            let step: string | undefined;
            if (from) {
                await this.flush();
                const to = await this.at(x2, y2);
                const same = !to || to.code === from.code || (await to.target.evaluate((t: any, s: any) => t === s || t.contains(s) || s.contains(t), from.target).catch(() => false));
                if (same && from.box) {
                    const px = Math.round(Math.max(0, Math.min(from.box.width, x2 - from.box.x))), py = Math.round(Math.max(0, Math.min(from.box.height, y2 - from.box.y)));
                    step = `await ${from.code}.dragTo(${from.code}, { targetPosition: { x: ${px}, y: ${py} } }); // of ${Math.round(from.box.width)}x${Math.round(from.box.height)}`;
                } else if (to) step = `await ${from.code}.dragTo(${to.code});`;
                if (step) this.add(step);
            }
            await page.mouse.move(x1, y1);
            await page.mouse.down();
            await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 5 });
            await page.mouse.move(x2, y2, { steps: 5 });
            await page.mouse.up();
            return step ? { step } : {};
        });
    }

    /** Close the tab shown (the test closes it too; the steps after act in the tab shown next). */
    closeTab(): Promise<{ step: string }> {
        return this.serial(async () => {
            await this.flush();
            if (this.browser.tabs().length < 2) throw new Error('This is the only tab.');
            const step = 'await cs.closeTab();';
            if (!this.paused) this.add(step);
            await this.page().close();
            return { step };
        });
    }

    /** The dialog waiting for an answer (for the Studio to show). */
    dialogInfo(): { type: string; message: string; defaultValue: string } | null {
        const d = this.pendingDialog;
        return d ? { type: d.type, message: d.message, defaultValue: d.defaultValue } : null;
    }

    /** Answer the page's dialog: the answer is written before the action that opened it (the test answers it the same way). */
    answerDialog(action: 'accept' | 'dismiss', text?: string): Promise<{ step: string }> {
        const d = this.pendingDialog;
        if (!d) return Promise.reject(new Error('No dialog is waiting.'));
        this.pendingDialog = null;
        const prompt = action === 'accept' && d.type === 'prompt' ? text ?? d.defaultValue : undefined;
        const step = `await cs.dialog(${q(action)}, ${q(d.message.slice(0, 500))}${prompt !== undefined ? `, ${q(prompt)}` : ''});`;
        this.lines.splice(d.at, 0, step);
        if (this.insertAt !== null && d.at < this.insertAt) this.insertAt++;
        this.write();
        return (action === 'accept' ? d.dialog.accept(prompt) : d.dialog.dismiss()).catch(() => undefined).then(() => ({ step }));
    }

    /** Show another tab: the test switches to it too. */
    switchTab(index: number): Promise<{ step: string }> {
        return this.serial(async () => {
            await this.flush();
            await this.browser.showTab(index);
            const step = `await cs.switchTab(${index});`;
            if (!this.paused) this.add(step);
            return { step };
        });
    }

    /** The locator prefix of a frame (page, or the iframes to enter, outermost first). */
    private async prefixFor(frame: PW): Promise<string> {
        const parts: string[] = [];
        for (let f = frame; f && f.parentFrame(); f = f.parentFrame()) {
            const h = await f.frameElement();
            const parent = f.parentFrame();
            const cands: string[] = await h.evaluate((e: unknown) => (globalThis as any).__csRec.frameCandidates(e));
            let chosen = cands[cands.length - 1];
            for (const c of cands) { if (await this.same(parent.locator(c), h)) { chosen = c; break; } }
            parts.unshift(`.locator(${q(chosen)}).contentFrame()`);
        }
        return `page${parts.join('')}`;
    }

    /** Downloads become checks (the framework saves downloaded files; numbers in names may change). */
    private watch(page: PW) {
        if (this.watched.has(page)) return;
        this.watched.add(page);
        // A dialog (alert / confirm / prompt) blocks the page: the Studio asks the tester how to answer it.
        page.on('dialog', (d: PW) => {
            if (this.paused) { void d.dismiss().catch(() => undefined); return; }
            let at = (this.insertAt ?? this.lines.length) - 1;
            while (at >= 0 && !/\.(click|dblclick|press|check|uncheck)\(/.test(this.lines[at])) at--;
            this.pendingDialog = { dialog: d, type: d.type(), message: d.message(), defaultValue: d.defaultValue?.() ?? '', at: Math.max(0, at) };
        });
        page.on('download', (d: PW) => {
            if (this.paused) return;
            const name: string = d.suggestedFilename();
            const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
            const pattern = /\d{2,}/.test(name) ? `/^${esc.replace(/\d{2,}/g, '\\d+')}$/` : q(name);
            this.add(`await expect(page).toHaveDownloaded(${pattern});`);
            this.notes.push(`Downloaded ${name}: the check waits for a file named like it.`);
        });
    }

    /** Files for the file field that was clicked: set on the page, kept with the recording, written as the step. */
    upload(files: Array<{ name: string; data: Buffer }>): Promise<{ step: string }> {
        return this.serial(async () => {
            const p = this.pendingFile;
            this.pendingFile = null;
            if (!p) throw new Error('No file field is waiting for files.');
            if (!this.o.uploadDir) throw new Error('Uploads are not available for this recording.');
            const path = require('path') as typeof import('path');
            fs.mkdirSync(this.o.uploadDir, { recursive: true });
            const names: string[] = [];
            const paths: string[] = [];
            for (const f of files) {
                const n = path.basename(f.name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
                const abs = path.join(this.o.uploadDir, n);
                fs.writeFileSync(abs, f.data);
                names.push(n); paths.push(abs);
            }
            if (p.chooser) await p.chooser.setFiles(paths); else await p.found.target.setInputFiles(paths);
            const step = `await ${p.found.code}.setInputFiles(${names.length === 1 ? q(names[0]) : `[${names.map(q).join(', ')}]`});`;
            if (!this.paused) this.add(step);
            return { step };
        });
    }

    /** The option(s) chosen for the list that was clicked. */
    choose(values: string[]): Promise<{ step: string }> {
        return this.serial(async () => {
            this.nextInput();
            const f = this.pendingSelect;
            this.pendingSelect = null;
            if (!f) throw new Error('No list is waiting for a choice.');
            await f.target.selectOption(values);
            const line = `await ${f.code}.selectOption(${values.length === 1 ? q(values[0]) : `[${values.map(q).join(', ')}]`});`;
            if (!this.paused) this.add(line);
            return { step: line };
        });
    }

    /**
     * A value from test data, into the field that has the focus (or the list that was clicked): the step
     * is marked with where the value comes from (a `// cs-data` line), so the test takes it from there.
     */
    inject(value: string, binding: { name: string; column: string; mode: 'run' | 'copy' | 'file'; source: Record<string, unknown> }): Promise<{ step: string }> {
        return this.serial(async () => {
            const mark = `// cs-data ${JSON.stringify(binding)}`;
            if (this.pendingSelect) {
                const f = this.pendingSelect;
                this.pendingSelect = null;
                const chosen: string[] = await f.target.selectOption([value]).catch(() => f.target.selectOption({ label: value }));
                if (!chosen.length) throw new Error(`The list "${f.info.name || 'list'}" has no option ${value}.`);
                const line = `await ${f.code}.selectOption(${q(chosen[0])});`;
                if (!this.paused) { this.add(mark); this.add(line); }
                return { step: line };
            }
            const f = this.editing?.found ?? await this.focused();
            if (!f) throw new Error('Click the field to fill first, then the value.');
            this.editing = null;
            await f.target.fill(value);
            const line = `await ${f.code}.fill(${q(value)});`;
            if (!this.paused) { this.add(mark); this.add(line); }
            return { step: line };
        });
    }

    /**
     * A check of the application's data (a database row, an API answer) at this point of the test: the source
     * is read again in the run and its column compared (the source: the `// cs-data` mark before the line).
     */
    dataCheck(binding: { name: string; column: string; mode: 'run' | 'copy' | 'file'; source: Record<string, unknown> }, expected: string): Promise<{ step: string }> {
        return this.serial(async () => {
            await this.flush();
            const step = `await cs.dataCheck(${q(binding.name)}, ${q(binding.column)}, ${q(expected)});`;
            if (!this.paused) { this.add(`// cs-data ${JSON.stringify(binding)}`); this.add(step); }
            return { step };
        });
    }

    /** The values remembered so far (name → the value seen). */
    rememberedNow(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const l of this.lines) { const m = /^const (\w+) = .*\/\/ = (".*")$/.exec(l); if (m) { try { out[m[1]] = String(JSON.parse(m[2])); } catch { /* none */ } } }
        return out;
    }

    type(text: string): Promise<void> {
        return this.serial(async () => {
            this.nextInput();
            const page = this.page();
            if (!this.paused && !this.editing) { const f = await this.focused(); if (f) this.editing = { found: f, start: f.info.value }; }
            await page.keyboard.type(text);
        });
    }

    key(k: string): Promise<{ step?: string }> {
        return this.serial(async () => {
            const page = this.page();
            if (this.paused) { await page.keyboard.press(k); return {}; }
            if (!this.editing && /^(Enter|Escape)$/.test(k)) { const f = await this.focused(); if (f) this.editing = { found: f, start: f.info.value }; }
            if (!this.editing && !/^(Tab|Shift\+Tab)$/.test(k)) { const f = await this.focused(); if (f) this.editing = { found: f, start: f.info.value }; }
            const field = this.editing?.found;
            // Keys that act (not text): written before the page reacts. In a field: Enter, Escape, arrows (an
            // autocomplete), shortcuts; elsewhere: any key or shortcut (Escape closing a dialog, F2, Control+S).
            const acts = /^(Enter|Escape|ArrowUp|ArrowDown|PageUp|PageDown)$/.test(k) || /^((Control|Alt|Meta)\+)+(?!(a|c|v|x|z|y)$)/i.test(k) || /^F\d{1,2}$/.test(k);
            if (field ? acts || /^(Tab|Shift\+Tab)$/.test(k) : true) await this.flush();
            let step: string | undefined;
            if (field && acts) { step = `await ${field.code}.press(${q(k)});`; this.add(step); }
            else if (!field && !/^(Shift|Control|Alt|Meta)$/.test(k)) { step = `await page.keyboard.press(${q(k)});`; this.add(step); }
            const enter = !!step && k === 'Enter';
            const seq = enter ? await this.snapBefore() : (this.nextInput(), this.inputSeq);
            await page.keyboard.press(k);
            if (enter) { const s = step!; void this.serial(() => this.suggestAfter(s, seq)); }
            if (/Tab$/.test(k)) { const f = await this.focused(); if (f) this.editing = { found: f, start: f.info.value }; }
            if (k === 'Enter') await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
            return step ? { step } : {};
        });
    }

    scroll(dy: number) { return this.serial(async () => { await this.page().mouse.wheel(0, dy); }); }

    /** What is under the pointer (for the highlight and the label shown while choosing an element). */
    hover(x: number, y: number) {
        return this.serial(async () => {
            const f = await this.at(x, y, { light: true }).catch(() => null);
            return f ? { box: f.box, code: f.code, label: [f.info.role || f.info.tag, f.info.name].filter(Boolean).join(' ') } : null;
        });
    }

    /** A check proposed from the page: the element (or the page) and what it shows now. */
    propose(kind: CheckKind, x?: number, y?: number) {
        return this.serial(async () => {
            const page = this.page();
            // The path only: the host differs between environments (BASE_URL), the query between runs.
            if (kind === 'url') { let p = page.url(); try { p = new URL(p).pathname; } catch { /* as is */ } return { kind, code: 'page', expected: p, label: 'Page address (path)' }; }
            if (kind === 'title') return { kind, code: 'page', expected: await page.title(), label: 'Page title' };
            // Text that must not be shown (an error message after a valid entry): there is no element to point at.
            if (kind === 'hidden') return { kind, code: 'page', expected: '', label: 'Text that should not be shown' };
            // The element itself (the badge, not the link around it); for a text check, a locator not made of that text.
            const f = await this.at(x ?? 0, y ?? 0, { raw: true, forText: kind === 'text' || kind === 'contains' || kind === 'value' });
            if (!f) throw new Error('Nothing there: point at an element.');
            this.found.set(f.code, f);
            const label = [f.info.role || f.info.tag, f.info.name].filter(Boolean).join(' ');
            if (kind === 'count') {
                // The rows / items like the one pointed at: one CSS path for all of them, counted on the page.
                const css: string | null = await f.target.evaluate((e: unknown) => (globalThis as any).__csRec.similar(e));
                if (!css) throw new Error('Point at a row or an item of a list.');
                const loc = f.frame.locator(css);
                const n = await loc.count();
                if (!n || !(await loc.evaluateAll((els: unknown[], t: unknown) => els.some((x: any) => x === t || x.contains(t)), f.target))) throw new Error('The items could not be told apart: point at a row or an item of a list.');
                const code = `${f.base}.locator(${q(css)})`;
                this.proposed.add(code);
                return { kind, code, expected: String(n), label: `${n} items like the one pointed at`, box: f.box };
            }
            if (kind === 'cell') {
                const c = f.info.cell;
                if (!c || !c.rowKey || c.col < 0) throw new Error('Point at a cell of a table.');
                let code = f.code;
                // The row by a text of it (the page's own table first when the same rows are elsewhere too).
                const tries = [false, true].flatMap((inTable) => [false, true].map((exact) => ({ inTable, exact }))).filter((x) => !x.inTable || c.table);
                for (const { inTable, exact } of tries) {
                    const chain = [...(inTable ? [{ m: 'locator', a: [c.table] }] : []), { m: 'getByRole', a: exact ? ['row', { name: c.rowKey, exact: true }] : ['row', { name: c.rowKey }] }, { m: 'locator', a: [':scope > *'] }, { m: 'nth', a: [c.col] }];
                    let ok = false;
                    try { ok = await this.same(this.chain(f.frame, chain), await f.target.evaluateHandle((e: any) => e.closest('td,th,[role=cell],[role=gridcell]') || e)); } catch { ok = false; }
                    if (ok) { code = this.chainCode(f.base, chain); break; }
                }
                this.found.set(code, f);
                this.proposed.add(code);
                return { kind, code, expected: c.text, label: `Cell "${c.header || `column ${c.col + 1}`}" of the row "${c.rowKey}"`, box: f.box };
            }
            if (kind === 'attribute') {
                const attributes = f.info.attributes ?? [];
                if (!attributes.length) throw new Error('This element has no attributes to check.');
                this.proposed.add(f.code);
                return { kind, code: f.code, expected: attributes[0].value, attribute: attributes[0].name, attributes, label, box: f.box };
            }
            if (kind === 'column') {
                // Every row of the column of the cell pointed at (its header names it).
                const c = f.info.cell;
                if (!c || c.col < 0) throw new Error('Point at a cell of a table.');
                const rowsCss: string | null = await f.target.evaluate((e: unknown) => (globalThis as any).__csRec.similar(e));
                if (!rowsCss) throw new Error('Point at a cell of a table.');
                const css = `${rowsCss} > td:nth-child(${c.col + 1})`;
                const loc = f.frame.locator(css);
                const values: string[] = (await loc.allTextContents()).map((x: string) => x.trim());
                if (!values.length) throw new Error('The rows of this table could not be told apart.');
                const code = `${f.base}.locator(${q(css)})`;
                this.proposed.add(code);
                // Numbers as numbers (1,250.00 · -3 · 45%), other texts in natural order (SO-9 before SO-10).
                const cmp = (a: string, b: string) => { const na = numberText(a), nb = numberText(b); return na !== null && nb !== null ? na - nb : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); };
                const sorted = values.length > 1 && values.every((v, i) => i === 0 || cmp(values[i - 1], v) <= 0) ? 'asc' : values.length > 1 && values.every((v, i) => i === 0 || cmp(values[i - 1], v) >= 0) ? 'desc' : '';
                const same = values.every((v) => v === values[0]);
                return { kind, code, expected: values[0], label: `Column "${c.header || `column ${c.col + 1}`}": ${values.length} rows`, box: f.box, values: values.slice(0, 50), column: c.header || `column ${c.col + 1}`, op: same ? 'equals' : sorted || 'contains' };
            }
            if (kind === 'wait') {
                this.proposed.add(f.code);
                return { kind, code: f.code, expected: f.info.text.slice(0, 200), label, box: f.box, op: 'contains' };
            }
            if (kind === 'compare') {
                // A number the element shows ("3", "1,250.00 USD"), compared in the check.
                const n = (f.info.text || f.info.value || '').replace(/[^\d.-]/g, '');
                if (!/\d/.test(n)) throw new Error('This element shows no number.');
                this.proposed.add(f.code);
                return { kind, code: f.code, expected: String(Number(n)), label, box: f.box, remembered: this.lines.map((l) => /^const (\w+) = /.exec(l)?.[1]).filter((x): x is string => !!x) };
            }
            if (kind === 'enabled' || kind === 'disabled') {
                const disabled: boolean = await f.target.isDisabled().catch(() => false);
                this.proposed.add(f.code);
                return { kind, code: f.code, expected: disabled ? 'disabled' : 'enabled', label, box: f.box };
            }
            const expected = kind === 'value' ? f.info.value : kind === 'text' || kind === 'contains' ? f.info.text : kind === 'checked' ? String(f.info.checked) : '';
            this.proposed.add(f.code);
            return { kind, code: f.code, expected, label: [f.info.role || f.info.tag, f.info.name].filter(Boolean).join(' '), box: f.box, password: f.info.password };
        });
    }

    /** The confirmed check, as the step Playwright would write. */
    confirm(kind: CheckKind, code: string, expected = '', extra: { attribute?: string; op?: string; name?: string; plus?: number; column?: string; reload?: boolean; seconds?: number } = {}): Promise<{ step: string }> {
        if (!this.proposed.has(code)) return Promise.reject(new Error('Choose the element again: this locator was not proposed by the recorder.'));
        const asked = code;
        return this.serial(async () => {
            // A text check whose element was found by structure only: the checked text names it better, when
            // Playwright confirms it finds exactly that element ("Records Found" instead of a CSS path).
            const f = this.found.get(code);
            if (f && (kind === 'contains' || kind === 'text') && expected.trim() && expected.length <= 80 && (/\.locator\('[^']* > /.test(code) || /\.getByText\(/.test(code)) && !code.endsWith(`.getByText(${q(expected.trim())})`)) {
                const alt = [{ m: 'getByText', a: [expected.trim()] }];
                try { if (await this.same(this.chain(f.frame, alt), f.target)) code = this.chainCode(f.base, alt); } catch { /* keep */ }
            }
            const r = await this.confirmNow(kind, code, expected, extra);
            // Added: no longer suggested (only when it was added).
            this.dropSuggestion(kind, asked, expected);
            return r;
        });
    }

    private async confirmNow(kind: CheckKind, code: string, expected: string, extra: { attribute?: string; op?: string; name?: string; plus?: number; column?: string; reload?: boolean; seconds?: number } = {}): Promise<{ step: string }> {
        if (kind === 'column' || kind === 'wait') {
            const op = extra.op ?? (kind === 'column' ? 'equals' : 'contains');
            if (kind === 'column' && !['equals', 'contains', 'asc', 'desc'].includes(op)) throw new Error('Choose the column check.');
            if (kind === 'wait' && !['contains', 'visible', 'hidden'].includes(op)) throw new Error('Choose what to wait for.');
            const withText = op === 'equals' || op === 'contains';
            if (withText && !expected.trim()) throw new Error('Type the text.');
            const seconds = Math.round(Math.min(3600, Math.max(1, Number(extra.seconds ?? 60) || 60)));
            const opts = kind === 'column' ? (extra.column ? `, { column: ${q(extra.column.slice(0, 60))} }` : '') : `, { reload: ${extra.reload === true}, seconds: ${seconds} }`;
            const step = `await cs.${kind === 'column' ? 'column' : 'waitFor'}(${code}, ${q(op)}${withText ? `, ${q(expected.trim())}` : ''}${opts});`;
            await this.flush();
            this.add(step);
            return { step };
        }
        if (kind === 'compare') {
            // expect(Number(<the element's number>)).toBeGreaterThan(5 | Number(remembered) + 1)
            const M: Record<string, string> = { eq: 'toBe', ne: 'not.toBe', gt: 'toBeGreaterThan', ge: 'toBeGreaterThanOrEqual', lt: 'toBeLessThan', le: 'toBeLessThanOrEqual' };
            const m = M[extra.op ?? 'eq'];
            if (!m) throw new Error('Choose how to compare.');
            let rhs: string;
            if (extra.name) {
                if (!this.lines.some((l) => l.startsWith(`const ${extra.name} = `))) throw new Error(`Nothing is remembered as "${extra.name}".`);
                const plus = Number(extra.plus ?? 0);
                if (!Number.isFinite(plus)) throw new Error('The amount to add is a number.');
                rhs = plus ? `Number(${extra.name}) ${plus < 0 ? '-' : '+'} ${Math.abs(plus)}` : `Number(${extra.name})`;
            } else {
                if (!/^-?\d+(\.\d+)?$/.test(expected.trim())) throw new Error('Compare with a number.');
                rhs = String(Number(expected));
            }
            const step = `await expect(Number((await ${code}.textContent())?.replace(/[^\\d.-]/g, ''))).${m}(${rhs});`;
            await this.flush();
            this.add(step);
            return { step };
        }
        if (kind === 'hidden' && !expected.trim()) throw new Error('Type the text that should not be shown.');
        if (kind === 'count' && !/^\d+$/.test(expected.trim())) throw new Error('The number of items is a whole number.');
        if (kind === 'attribute' && !/^[A-Za-z_:][\w:.-]*$/.test(extra.attribute ?? '')) throw new Error('Choose the attribute to check.');
        const step = {
            hidden: `await expect(page.getByText(${q(expected.trim())})).toBeHidden();`,
            enabled: `await expect(${code}).toBeEnabled();`,
            disabled: `await expect(${code}).toBeDisabled();`,
            attribute: `await expect(${code}).toHaveAttribute(${q(extra.attribute ?? '')}, ${q(expected)});`,
            count: `await expect(${code}).toHaveCount(${Number(expected.trim())});`,
            cell: `await expect(${code}).toHaveText(${q(expected)});`,
            visible: `await expect(${code}).toBeVisible();`,
            text: `await expect(${code}).toHaveText(${q(expected)});`,
            contains: `await expect(${code}).toContainText(${q(expected)});`,
            value: `await expect(${code}).toHaveValue(${q(expected)});`,
            checked: `await expect(${code}).toBeChecked();`,
            url: `await expect(page).toHaveURL(/${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/')}/);`,
            title: `await expect(page).toHaveTitle(${q(expected)});`,
        }[kind];
        if (!step) throw new Error('Unknown check.');
        await this.flush();
        this.add(step);
        return { step };
    }

    /**
     * Remember a value of the page for later steps (an order number): the element proposed for a text check,
     * under a name; the value seen now is noted on the line, so later steps with it use the remembered one.
     */
    remember(code: string, name: string, pattern?: string): Promise<{ step: string; value: string }> {
        if (!this.proposed.has(code)) return Promise.reject(new Error('Choose the element again: this locator was not proposed by the recorder.'));
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(name) || ['page', 'expect', 'test', 'await', 'const', 'let', 'var'].includes(name)) return Promise.reject(new Error('A name: letters, digits and _ (e.g. orderNumber).'));
        if (this.lines.some((l) => l.startsWith(`const ${name} = `))) return Promise.reject(new Error(`"${name}" is remembered already: choose another name.`));
        let re: RegExp | undefined;
        if (pattern) { try { re = new RegExp(pattern); } catch { return Promise.reject(new Error(`Not a pattern: ${pattern}`)); } }
        return this.serial(async () => {
            const f = this.found.get(code);
            const field = !!f?.info.editable;
            const whole = (f ? await f.target.evaluate((e: any) => (e.isContentEditable ? e.innerText : 'value' in e && /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) ? e.value : e.textContent) ?? '').catch(() => '') : '').trim();
            // Only the part that matches the pattern (e.g. SO-\d+ of "Order SO-1005 created").
            const part = re ? re.exec(whole)?.[0] : whole;
            if (part === undefined) throw new Error(`Nothing like ${pattern} in "${whole.slice(0, 80)}".`);
            const value = part;
            await this.flush();
            const read = `${code}.${field || /^(INPUT|TEXTAREA|SELECT)$/i.test(f?.info.tag ?? '') ? 'inputValue' : 'textContent'}()`;
            const step = `const ${name} = ${re ? `(await ${read})?.match(/${re.source}/)?.[0]` : `await ${read}`}; // = ${JSON.stringify(value).replace(/\u2028|\u2029/g, ' ')}`;
            this.add(step);
            return { step, value };
        });
    }

    /** Remove a step (the page is not changed back). */
    remove(index: number) {
        if (index < 0 || index >= this.lines.length) return;
        // A step's test data mark goes with it (else it would mark the next step).
        const withMark = index > 0 && this.lines[index - 1].startsWith('// cs-data ') ? 1 : 0;
        this.lines.splice(index - withMark, 1 + withMark);
        if (this.insertAt !== null && index < this.insertAt) this.insertAt = Math.max(0, this.insertAt - 1 - withMark);
        // A mark with no step after it.
        if (this.lines[this.lines.length - 1]?.startsWith('// cs-data ')) this.lines.pop();
        this.write();
    }

    async navigate(url: string) {
        return this.serial(async () => {
            let u: URL;
            try { u = new URL(url); } catch { throw new Error(`Not an address: ${url}`); }
            if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses can be opened.');
            await this.flush();
            this.nextInput();
            // Recorded only once the page opened (an address that does not answer is not a step).
            const before = this.page().url();
            try { await this.page().goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 }); }
            catch (e) {
                // Back to the page the steps are on (not the browser's error page, which later clicks would not match).
                if (before && before !== 'about:blank') await this.page().goto(before, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
                throw new Error(`${u.toString()} did not open: ${String((e as Error).message).split('\n')[0].replace(/^page\.goto: /, '')}. Nothing was recorded.`); }
            if (!this.paused) this.add(`await page.goto(${q(u.toString())});`);
        });
    }
    back() { return this.serial(async () => { await this.flush(); await this.browser.back(); }); }
    reload() { return this.serial(async () => { await this.browser.reload(); }); }

    async close() {
        try { await this.serial(() => this.flush()); } catch { /* closed */ }
        await this.browser.close();
    }
}
