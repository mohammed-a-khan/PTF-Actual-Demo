/**
 * Small helpers shared by the API and Performance screens: an inner tab remembered per screen (localStorage,
 * private mode tolerated), and a section title with its help in a tooltip instead of a paragraph.
 */
import React from 'react';
import { App, Button, Input, Space, Tooltip, Typography } from 'antd';
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

type ModalApi = ReturnType<typeof App.useApp>['modal'];

/** Save inside a dialog: busy while it saves; off (with the reason in a tooltip) while the item cannot be saved. */
function DialogSave({ problem, onSave }: { problem: string | null; onSave: () => Promise<void> }) {
    const [busy, setBusy] = React.useState(false);
    if (problem) return <Tooltip title={`Cannot be saved yet: ${problem}`}><Button type="primary" disabled>Save</Button></Tooltip>;
    return <Button type="primary" loading={busy} onClick={() => { setBusy(true); void onSave().finally(() => setBusy(false)); }}>Save</Button>;
}

/**
 * Unsaved changes on a screen that is about to show something else (another item chosen in its list): the same words
 * as the app's own prompt. Stay (also Escape and the close button), Discard (the edits are dropped), Save (then goes on;
 * off with the reason while the item is not valid).
 */
export function askUnsaved(modal: ModalApi, o: { what: string; problem: string | null; save: () => Promise<boolean>; discard: () => void; then: () => void; stay?: () => void }): void {
    const h: { inst?: { destroy: () => void } } = {};
    h.inst = modal.confirm({
        title: 'Unsaved changes', content: `Not saved: ${o.what}.`, closable: true, onCancel: () => o.stay?.(),
        footer: () => <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <Button onClick={() => { h.inst?.destroy(); o.stay?.(); }}>Stay</Button>
            <Button danger onClick={() => { h.inst?.destroy(); o.discard(); o.then(); }}>Discard</Button>
            <DialogSave problem={o.problem} onSave={async () => { if (await o.save()) { h.inst?.destroy(); o.then(); } }} />
        </Space>,
    });
}

/** A save refused because the file changed since it was read (409 from the server). */
// (Not ApiError itself: api.ts needs a browser, and these helpers are tested without one.)
export const isChangedElsewhere = (e: unknown) => !!e && typeof e === 'object' && (e as { status?: unknown }).status === 409;
/** The item with the version it was read at (the server refuses the save when the file is not that version any more), or forced. */
export function withBase<T extends object>(x: T, base: string | undefined, force = false): T {
    if (!base && !force) return x;
    return { ...x, $studio: { ...(base ? { base } : {}), ...(force ? { force: true } : {}) } } as T;
}
/** The version the server gives with an item it read or saved. */
export const versionOf = (r: unknown): string | undefined => {
    const v = r && typeof r === 'object' ? (r as { version?: unknown }).version : undefined;
    return typeof v === 'string' ? v : undefined;
};
/** "Changed in another tab or by someone else": Reload (that version, these edits dropped), Overwrite (these edits over it), or Keep editing. */
export function askChangedElsewhere(modal: ModalApi, what: string): Promise<'reload' | 'overwrite' | null> {
    return new Promise((resolve) => {
        const h: { inst?: { destroy: () => void } } = {};
        const done = (v: 'reload' | 'overwrite' | null) => { h.inst?.destroy(); resolve(v); };
        h.inst = modal.confirm({
            title: 'Changed in another tab or by someone else', closable: true, onCancel: () => resolve(null),
            content: `${what} was saved somewhere else after you opened it here. Reload shows that version (your changes here are dropped); Overwrite saves your version over it.`,
            footer: () => <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <Button onClick={() => done(null)}>Keep editing</Button>
                <Button onClick={() => done('reload')}>Reload</Button>
                <Button type="primary" danger onClick={() => done('overwrite')}>Overwrite</Button>
            </Space>,
        });
    });
}

/**
 * Why a number typed in a field cannot be used, or null: whole numbers (or up to `decimals` places) in min…max.
 * Never rounded or clamped: 2.5, -1 or 99999 stay as typed, with this reason under the field.
 */
export function numProblem(text: string, o: { label: string; min: number; max: number; decimals?: number; optional?: boolean }): string | null {
    const t = text.trim();
    const dec = o.decimals ?? 0;
    const range = `${dec ? 'a number' : 'a whole number'} from ${o.min} to ${o.max}`;
    if (t === '') return o.optional ? null : `${o.label}: give ${range}.`;
    if (!/^-?(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return `${o.label}: numbers only; give ${range}.`;
    const n = Number(t.replace(',', '.'));
    const places = (t.split(/[.,]/)[1] ?? '').replace(/0+$/, '').length;
    if (n < 0 && o.min >= 0) return `${o.label}: no negative numbers; give ${range}.`;
    if (places > dec) return dec ? `${o.label}: at most ${dec} decimal${dec === 1 ? '' : 's'}; give ${range}.` : `${o.label}: no decimals; give ${range}.`;
    if (n < o.min || n > o.max) return `${o.label}: ${range} (not ${n}).`;
    return null;
}
/** The number a field's text stands for (also one in error: the screen then refuses to save it), or undefined. */
export function numOf(text: string): number | undefined {
    const t = text.trim();
    if (!/^-?(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return undefined;
    const n = Number(t.replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
}

type ReportProblem = (id: string, msg: string | null) => void;
const FieldProblemCtx = React.createContext<ReportProblem | null>(null);
/** Number fields inside report their problems to the screen (useFieldProblems), which keeps Save / Run off meanwhile. */
export const FieldProblems = FieldProblemCtx.Provider;
/** The first problem of the number fields under <FieldProblems value={report}>, or null. */
export function useFieldProblems(): { problem: string | null; report: ReportProblem } {
    const [map, setMap] = React.useState<Record<string, string>>({});
    const report = React.useCallback<ReportProblem>((id, msg) => setMap((m) => {
        if ((m[id] ?? null) === msg) return m;
        const n = { ...m };
        if (msg) n[id] = msg; else delete n[id];
        return n;
    }), []);
    return { problem: Object.values(map)[0] ?? null, report };
}
/** The same for a part of a screen (its own message shown once), still telling the screen around it. */
export function useNestedFieldProblems(): { problem: string | null; report: ReportProblem } {
    const parent = React.useContext(FieldProblemCtx);
    const own = useFieldProblems();
    const ownReport = own.report;
    const report = React.useCallback<ReportProblem>((id, msg) => { ownReport(id, msg); parent?.(id, msg); }, [ownReport, parent]);
    return { problem: own.problem, report };
}

/**
 * A number field of the API and Performance screens (users, seconds, ports, delays, iterations): what is typed stays
 * as typed; a decimal (where whole numbers are meant), a negative number, text or a number out of range is said under
 * the field (never rounded, clamped or replaced silently), and the screen keeps Save / Run off until it is put right.
 */
export function NumField({ value, onChange, min, max, label, decimals, optional, size, addonBefore, addonAfter, placeholder, disabled, width, id }: {
    value: number | undefined | null; onChange: (v: number | undefined) => void; min: number; max: number;
    /** The accessible name (also used in the message). */
    label: string; decimals?: number;
    /** Empty is allowed (onChange(undefined)); otherwise empty is an error. */
    optional?: boolean;
    size?: 'small' | 'middle'; addonBefore?: React.ReactNode; addonAfter?: React.ReactNode; placeholder?: string; disabled?: boolean; width?: number | string; id?: string;
}) {
    const report = React.useContext(FieldProblemCtx);
    const key = React.useId();
    const shown = (v: number | undefined | null) => (v === undefined || v === null ? '' : String(v));
    const [text, setText] = React.useState(shown(value));
    // A value changed from outside (a reload, Discard, a preset) is shown; the same number typed differently ("5.0") stays.
    React.useEffect(() => { setText((t) => (numOf(t) === (value ?? undefined) && t.trim() !== '' ? t : shown(value))); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
    const msg = disabled ? null : numProblem(text, { label, min, max, decimals, optional });
    React.useEffect(() => { report?.(key, msg); }, [msg, report, key]);
    React.useEffect(() => () => report?.(key, null), [report, key]);
    return (
        <div style={{ width: width ?? 130, maxWidth: '100%', display: 'inline-block', verticalAlign: 'top' }}>
            <Input id={id} size={size} inputMode={decimals ? 'decimal' : 'numeric'} value={text} aria-label={label} aria-invalid={!!msg} status={msg ? 'error' : undefined}
                addonBefore={addonBefore} addonAfter={addonAfter} placeholder={placeholder} disabled={disabled}
                onChange={(e) => {
                    const v = e.target.value;
                    setText(v);
                    if (v.trim() === '') { if (optional) onChange(undefined); return; }
                    const n = numOf(v);
                    if (n !== undefined) onChange(n);
                }} />
            {msg && <Typography.Text type="danger" role="alert" style={{ fontSize: 12, display: 'block', whiteSpace: 'normal' }}>{msg}</Typography.Text>}
        </div>
    );
}

/** A request restored from History again and again: its name keeps one "(from …)", not one more per restore. */
export function restoredName(name: string, at: string): string {
    const base = name.replace(/(\s*\(from [^()]*\))+\s*$/, '').trim() || name.trim();
    return `${base} (from ${at})`;
}

/** #/api-runner addresses: the inner tab they show (a run is shown with Past runs, a collection with Run). */
export type RunnerTab = 'run' | 'monitors' | 'runs';
export function runnerRoute(route: string[]): { tab: RunnerTab | null; file: string | null; runId: string | null } {
    if (route[0] !== 'api-runner') return { tab: null, file: null, runId: null };
    if (route[1] === 'run' && route[2]) return { tab: 'runs', file: null, runId: route[2] };
    if (route[1] === 'runs') return { tab: 'runs', file: null, runId: null };
    if (route[1] === 'monitors') return { tab: 'monitors', file: null, runId: null };
    if (route.length > 1) return { tab: 'run', file: route.slice(1).join('/'), runId: null };
    return { tab: null, file: null, runId: null };
}

/** "▲ better": the arrow follows the number (went up / down), the word says whether that is good. */
export function verdictWords(verdict: string, change: string): string {
    if (verdict !== 'better' && verdict !== 'worse') return verdict === 'same' ? '≈ same' : '';
    const m = /([+\-−])?\s*\d*\.?\d*[1-9]/.exec(change);
    const arrow = m ? (m[1] === '-' || m[1] === '−' ? '▼ ' : '▲ ') : '';
    return `${arrow}${verdict}`;
}
