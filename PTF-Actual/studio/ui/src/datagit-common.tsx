/**
 * Shared bits of the data / source-control / Azure DevOps / settings screens:
 *  - useStoredTab: the inner tab a screen shows, remembered on this computer;
 *  - AdoNotSetUp: one short, calm "not set up" state for the Azure DevOps screens.
 */
import React from 'react';
import { App, Button, Result, Space, Typography } from 'antd';
import { CloudServerOutlined, LockOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { navigate, useRoute } from './route';
import { errText } from './state';
import { isStale } from './datagit-api';
import './styles-datagit.css';

const STORED_TAB_EVENT = 'cs-stored-tab';

/** The selected inner tab of a screen, kept in localStorage (private mode: just not remembered). */
export function useStoredTab<T extends string>(key: string, tabs: readonly T[], fallback: T): [T, (t: T) => void] {
    const [tab, setRaw] = React.useState<T>(() => {
        try { const v = localStorage.getItem(`cs-studio-tab:${key}`) as T | null; return v && tabs.includes(v) ? v : fallback; } catch { return fallback; }
    });
    const set = React.useCallback((t: T) => { setRaw(t); try { localStorage.setItem(`cs-studio-tab:${key}`, t); } catch { /* private mode */ } }, [key]);
    // Another part of the Studio chose the tab (a deep link such as #/git/tags).
    React.useEffect(() => {
        const h = (e: Event) => { const d = (e as CustomEvent<{ key: string; tab: string }>).detail; if (d?.key === key && tabs.includes(d.tab as T)) setRaw(d.tab as T); };
        window.addEventListener(STORED_TAB_EVENT, h);
        return () => window.removeEventListener(STORED_TAB_EVENT, h);
    }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
    return [tab, set];
}

/** Choose the inner tab a screen shows (now, if it is open, and when it opens). */
export function setStoredTab(key: string, tab: string): void {
    try { localStorage.setItem(`cs-studio-tab:${key}`, tab); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent(STORED_TAB_EVENT, { detail: { key, tab } }));
}

/**
 * The screen's subtitle (in the page head) is cut with "…" on a narrow window: its full text as a tooltip while
 * this screen is shown.
 */
export function usePageHeadTooltip(): void {
    React.useEffect(() => {
        const el = document.querySelector<HTMLElement>('.page-head > span:last-child');
        if (!el) return;
        el.title = el.textContent ?? '';
        return () => el.removeAttribute('title');
    }, []);
}

/** "1 day ago", "3 days ago": the right word for one. */
export function plural(n: number, one: string, many = one + 's'): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** The zero of each decimal digit set people type (Arabic-Indic, Persian, Devanagari, Bengali, Thai, full-width …). */
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0xff10];
/** Digits of any of those sets as 0-9 ("١٢٣٤" → "1234"); other characters stay as they are. */
export function asciiDigits(s: string): string {
    return s.replace(/\p{Nd}/gu, (d) => {
        const cp = d.codePointAt(0)!;
        const z = DIGIT_ZEROS.find((x) => cp >= x && cp <= x + 9);
        return z === undefined ? d : String(cp - z);
    });
}

/** The number of characters a person sees (an emoji or 订 is one), not UTF-16 units. */
export function charCount(s: string): number {
    return Array.from(s).length;
}

/** An error that means "Azure DevOps is not set up here" (no address, project or token), not a failure. */
export function isAdoNotSetUp(error: string | null | undefined): boolean {
    if (!error) return false;
    return /personal access token as the secret|No ADO personal access token|ADO_ORGANIZATION(_URL)? is not set|ADO_PROJECT is not set|No framework project found|organization URL looks wrong|Azure DevOps is not set up/i.test(error);
}

/** The secret the error asks for (ADO_PAT unless it names another). */
function secretOf(error: string): string {
    return /\bsecret ([A-Z][A-Z0-9_]{1,63})\b/.exec(error)?.[1] ?? 'ADO_PAT';
}

/** "Azure DevOps is not set up": what the screen would show, one line why, and the ways out. */
export function AdoNotSetUp({ what, error, onRetry, compact }: { what: string; error: string; onRetry?: () => void; compact?: boolean }) {
    const needsToken = /access token|ADO_PAT|secret/i.test(error);
    return (
        <div className={`dg-ado-empty${compact ? ' compact' : ''}`} data-testid="ado-not-set-up">
            <Result icon={<CloudServerOutlined />} title="Azure DevOps is not set up"
                subTitle={<Space direction="vertical" size={2}>
                    <span>{what} come from Azure DevOps.</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{error.replace(/\s*\((Secrets|Settings) → [^)]*\)/g, '')}</Typography.Text>
                </Space>}
                extra={<Space wrap style={{ justifyContent: 'center' }}>
                    {needsToken && <Button type="primary" icon={<LockOutlined />} onClick={() => navigate(['secrets', 'add', secretOf(error)])}>Add {secretOf(error)}</Button>}
                    <Button icon={<SettingOutlined />} onClick={() => navigate(['settings', 'ado'])}>Azure DevOps settings</Button>
                    {onRetry && <Button icon={<ReloadOutlined />} onClick={onRetry}>Try again</Button>}
                </Space>} />
        </div>
    );
}

/**
 * A save refused because another tab (or someone else) changed the same thing since this screen read it: said, with a
 * Reload action (the screen reads it again; what was typed here is dropped only then). Other errors: the usual toast.
 */
export function saveErrorToast(message: ReturnType<typeof App.useApp>['message'], e: unknown, reload: () => void): void {
    if (!isStale(e)) { message.error(errText(e)); return; }
    const key = 'cs-stale-save';
    message.warning({
        key, duration: 0,
        content: <span>{errText(e)}{' '}
            <Button size="small" type="primary" onClick={() => { message.destroy(key); reload(); }}>Reload</Button>{' '}
            <Button size="small" type="text" aria-label="Close" onClick={() => message.destroy(key)}>Close</Button></span>,
    });
}

/**
 * The inner tab of a screen, in the address (#/<page>/<tab>) so Back and Forward move between tabs and a link opens
 * one: the address wins; no tab in it, the one used last (remembered); a wrong one is replaced with a valid address.
 * `aliases`: other spellings people type (#/notify/log → recent). Only while the screen is shown (`page` is route[0]).
 */
export function resolveRouteTab<T extends string>(segment: string | undefined, tabs: readonly T[], stored: T, aliases: Record<string, T> = {}): { tab: T; fix: boolean } {
    if (segment === undefined || segment === '') return { tab: stored, fix: true };
    if ((tabs as readonly string[]).includes(segment)) return { tab: segment as T, fix: false };
    const a = aliases[segment.toLowerCase()];
    if (a) return { tab: a, fix: true };
    return { tab: tabs[0], fix: true };
}
export function useRouteTab<T extends string>(page: string, key: string, tabs: readonly T[], fallback: T, aliases: Record<string, T> = {}): [T, (t: T) => void] {
    const route = useRoute();
    const [stored, store] = useStoredTab<T>(key, tabs, fallback);
    const here = route[0] === page;
    const r = resolveRouteTab(route[1], tabs, stored, aliases);
    // A wrong or missing tab: the address is corrected (replaced, so Back does not stop on it).
    React.useEffect(() => { if (here && r.fix) navigate([page, r.tab, ...route.slice(2)], true); }, [here, r.fix, r.tab, route.join('/')]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (here && r.tab !== stored) store(r.tab); }, [here, r.tab]); // eslint-disable-line react-hooks/exhaustive-deps
    const set = React.useCallback((t: T) => { store(t); navigate([page, t]); }, [page, store]);
    return [here ? r.tab : stored, set];
}
