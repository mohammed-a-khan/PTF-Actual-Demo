import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { getOrStart, stop, has } from '../browser/session';

const ActionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('goto'), url: z.string().url(), waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('domcontentloaded') }),
    z.object({ action: z.literal('click'), selector: z.string().min(1), timeoutMs: z.number().int().positive().max(60_000).default(15_000) }),
    z.object({ action: z.literal('fill'), selector: z.string().min(1), value: z.string(), timeoutMs: z.number().int().positive().max(60_000).default(15_000) }),
    z.object({ action: z.literal('select'), selector: z.string().min(1), value: z.string(), timeoutMs: z.number().int().positive().max(60_000).default(15_000) }),
    z.object({ action: z.literal('waitFor'), selector: z.string().min(1), timeoutMs: z.number().int().positive().max(60_000).default(15_000) }),
    z.object({ action: z.literal('press'), selector: z.string().min(1), key: z.string().min(1) }),
    z.object({ action: z.literal('scroll'), selector: z.string().optional(), y: z.number().default(0) }),
]);

registerPrimitive({
    name: 'cs_qa_browse',
    description: 'Drive a headed browser session that persists across calls in the same run. Verbs: session=start|stop|status; navigate=goto; interact=click|fill|select|waitFor|press|scroll; observe=snapshot (returns AX tree + visible selectors + screenshot path). Session is hot: cookies, storage, state carry across calls until stop.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({ verb: z.literal('start'), sessionId: z.string().min(3), headless: z.boolean().default(false) }),
        z.object({ verb: z.literal('stop'), sessionId: z.string().min(3) }),
        z.object({ verb: z.literal('status'), sessionId: z.string().min(3) }),
        z.object({ verb: z.literal('actions'), sessionId: z.string().min(3), actions: z.array(ActionSchema).min(1).max(50) }),
        z.object({ verb: z.literal('snapshot'), sessionId: z.string().min(3), maxSelectors: z.number().int().positive().max(200).default(80), screenshotName: z.string().optional() }),
    ]),
    outputSchema: z.discriminatedUnion('verb', [
        z.object({ verb: z.literal('start'), sessionId: z.string(), headless: z.boolean() }),
        z.object({ verb: z.literal('stop'), sessionId: z.string(), stopped: z.boolean() }),
        z.object({ verb: z.literal('status'), sessionId: z.string(), active: z.boolean() }),
        z.object({ verb: z.literal('actions'), sessionId: z.string(), currentUrl: z.string(), reports: z.array(z.object({ index: z.number(), action: z.string(), ok: z.boolean(), error: z.string().optional() })) }),
        z.object({
            verb: z.literal('snapshot'),
            sessionId: z.string(),
            currentUrl: z.string(),
            pageTitle: z.string(),
            selectorCount: z.number(),
            selectors: z.array(z.object({
                role: z.string(),
                name: z.string(),
                xpath: z.string(),
                interactable: z.boolean(),
            })),
            screenshotPath: z.string(),
            truncated: z.boolean(),
        }),
    ]),
    run: async (ctx, input) => {
        if (input.verb === 'start') {
            await getOrStart(input.sessionId, input.headless);
            return { verb: 'start' as const, sessionId: input.sessionId, headless: input.headless };
        }
        if (input.verb === 'stop') {
            const stopped = await stop(input.sessionId);
            return { verb: 'stop' as const, sessionId: input.sessionId, stopped };
        }
        if (input.verb === 'status') {
            return { verb: 'status' as const, sessionId: input.sessionId, active: has(input.sessionId) };
        }
        const session = await getOrStart(input.sessionId, false);
        // Playwright accepts 'xpath=' but treats 'xpath:' as CSS. Normalize both
        // 'xpath://…' and bare '//…' to Playwright's 'xpath=…' form.
        const normalizeSelector = (raw: string): string => {
            if (raw.startsWith('xpath://')) return 'xpath=' + raw.slice('xpath:'.length);
            if (raw.startsWith('xpath:')) return 'xpath=' + raw.slice('xpath:'.length);
            if (raw.startsWith('xpath=')) return raw;
            if (raw.startsWith('//') || raw.startsWith('(//')) return 'xpath=' + raw;
            return raw;
        };
        if (input.verb === 'actions') {
            const reports: Array<{ index: number; action: string; ok: boolean; error?: string }> = [];
            for (let i = 0; i < input.actions.length; i++) {
                const a = input.actions[i];
                try {
                    if (a.action === 'goto') {
                        await session.page.goto(a.url, { waitUntil: a.waitUntil });
                    } else if (a.action === 'click') {
                        await session.page.locator(normalizeSelector(a.selector)).click({ timeout: a.timeoutMs });
                    } else if (a.action === 'fill') {
                        await session.page.locator(normalizeSelector(a.selector)).fill(a.value, { timeout: a.timeoutMs });
                    } else if (a.action === 'select') {
                        await session.page.locator(normalizeSelector(a.selector)).selectOption(a.value, { timeout: a.timeoutMs });
                    } else if (a.action === 'waitFor') {
                        await session.page.locator(normalizeSelector(a.selector)).waitFor({ timeout: a.timeoutMs, state: 'visible' });
                    } else if (a.action === 'press') {
                        await session.page.locator(normalizeSelector(a.selector)).press(a.key);
                    } else if (a.action === 'scroll') {
                        if (a.selector) await session.page.locator(normalizeSelector(a.selector)).scrollIntoViewIfNeeded();
                        else await session.page.evaluate((y) => window.scrollTo(0, y), a.y);
                    }
                    reports.push({ index: i, action: a.action, ok: true });
                } catch (e) {
                    reports.push({ index: i, action: a.action, ok: false, error: e instanceof Error ? e.message : String(e) });
                    break;
                }
            }
            return { verb: 'actions' as const, sessionId: input.sessionId, currentUrl: session.page.url(), reports };
        }
        // snapshot
        const sessRoot = process.env.CS_QA_V6_HOME
            ? path.join(process.env.CS_QA_V6_HOME, 'snapshots')
            : path.join(os.homedir(), '.cs-qa', 'v6', 'snapshots');
        fs.mkdirSync(sessRoot, { recursive: true });
        const name = input.screenshotName ?? `snap-${Date.now()}.png`;
        const screenshotPath = path.join(sessRoot, name);
        await session.page.screenshot({ path: screenshotPath, fullPage: false });
        const selectors = await session.page.evaluate((maxCount) => {
            function toXPath(el: Element): string {
                if (el.id) return `//*[@id=${JSON.stringify(el.id)}]`;
                const tag = el.tagName.toLowerCase();
                const parent = el.parentElement;
                if (!parent) return `/${tag}`;
                const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
                const idx = same.indexOf(el) + 1;
                return `${toXPath(parent)}/${tag}[${idx}]`;
            }
            function accessibleName(el: Element): string {
                return (
                    el.getAttribute('aria-label') ||
                    el.getAttribute('name') ||
                    el.getAttribute('placeholder') ||
                    (el.textContent ?? '').trim().slice(0, 60)
                );
            }
            const out: Array<{ role: string; name: string; xpath: string; interactable: boolean }> = [];
            const candidates = document.querySelectorAll('a,button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,label');
            for (const el of Array.from(candidates)) {
                if (out.length >= maxCount) break;
                const rect = (el as HTMLElement).getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                const style = window.getComputedStyle(el as HTMLElement);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                const role = (el.getAttribute('role') || el.tagName || 'unknown').toLowerCase();
                const name = accessibleName(el);
                if (!name && role !== 'input' && role !== 'select' && role !== 'textarea') continue;
                const tag = el.tagName.toLowerCase();
                const interactable = ['a', 'button', 'input', 'select', 'textarea'].includes(tag) || role === 'button' || role === 'link' || role === 'checkbox' || role === 'combobox';
                out.push({ role, name, xpath: toXPath(el), interactable });
            }
            return out;
        }, input.maxSelectors);
        return {
            verb: 'snapshot' as const,
            sessionId: input.sessionId,
            currentUrl: session.page.url(),
            pageTitle: await session.page.title(),
            selectorCount: selectors.length,
            selectors,
            screenshotPath,
            truncated: selectors.length >= input.maxSelectors,
        };
    },
});
