/**
 * Small helpers shared by the API and Performance screens: an inner tab remembered per screen (localStorage,
 * private mode tolerated), and a section title with its help in a tooltip instead of a paragraph.
 */
import React from 'react';
import { Tooltip, Typography } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import './styles-apiperf.css';

const KEY = 'cs-apiperf-tab:';

/** The selected inner tab of a screen, remembered on this computer; an unknown key falls back to the first one. */
export function useRememberedTab(id: string, def: string): [string, (k: string) => void] {
    const [k, setK] = React.useState<string>(() => { try { return localStorage.getItem(KEY + id) ?? def; } catch { return def; } });
    const set = React.useCallback((v: string) => { setK(v); try { localStorage.setItem(KEY + id, v); } catch { /* private mode */ } }, [id]);
    return [k, set];
}
/** The remembered tab when it is one of the tabs shown now, else the first. */
export const shownTab = (k: string, keys: Array<string | undefined | false>): string => {
    const ok = keys.filter((x): x is string => !!x);
    return ok.includes(k) ? k : ok[0] ?? k;
};

/** A small section title with its explanation behind a "?" (no paragraphs above forms). */
export function SectionTitle({ children, help, extra }: { children: React.ReactNode; help?: React.ReactNode; extra?: React.ReactNode }) {
    return (
        <div className="ap-section-title">
            <Typography.Text strong>{children}</Typography.Text>
            {help && <Tooltip title={help}><QuestionCircleOutlined className="ap-help" aria-label="Help" /></Tooltip>}
            {extra && <span className="ap-section-extra">{extra}</span>}
        </div>
    );
}

/**
 * Escape closes an open dialog also when the focus has left it (a click on its backdrop-free area, Tab past its last
 * field): antd only sees Escape pressed inside the dialog. Escape inside a dialog is left to the dialog.
 */
export function useEscapeCloses(open: boolean, close: () => void) {
    const ref = React.useRef(close);
    ref.current = close;
    React.useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            const a = document.activeElement;
            if (a && a !== document.body && a.closest('.ant-modal-wrap, .ant-modal-root, .ant-drawer, .ant-select-dropdown, .ant-dropdown, .ant-picker-dropdown')) return;
            ref.current();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);
}

/** A name typed in a create dialog: the reason it cannot be used (empty, only spaces), or null. */
export const nameProblem = (name: string, what: string): string | null => (name.trim() ? null : `Give the ${what} a name.`);

/** An http(s) address with a host ("http://" alone is not one): the reason it cannot be used, or null. */
export function httpUrlProblem(u: string): string | null {
    const t = u.trim();
    if (!t) return 'Type the address of the service, e.g. https://api.example.com/v2.';
    if (!/^https?:\/\//i.test(t)) return 'The address starts with http:// or https://.';
    try { const x = new URL(t); if (!x.hostname) throw new Error(); } catch { return 'The address needs a host after http:// or https://, e.g. https://api.example.com.'; }
    return null;
}

/** #/api/<collection file>[/<request id>]: the file is the segments up to the one ending in .json. */
export function apiRoute(route: string[]): { file: string | null; request: string | null } {
    if (route[0] !== 'api' || route.length < 2) return { file: null, request: null };
    const parts = route.slice(1);
    const j = parts.findIndex((s) => s.endsWith('.json'));
    if (j < 0) return { file: parts.join('/'), request: null };
    return { file: parts.slice(0, j + 1).join('/'), request: parts[j + 1] ?? null };
}
