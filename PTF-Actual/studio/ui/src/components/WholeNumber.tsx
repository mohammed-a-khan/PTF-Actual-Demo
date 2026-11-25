/**
 * A whole-number field of the Agents screens (a trigger's daily limit, a mission's budget). What is typed stays as
 * typed: a decimal (1.5), a negative number (-1), letters or a number outside min…max is shown in error with a short
 * message under the field, and the value used stays the last good one. Nothing is dropped, rounded or clamped.
 * Only an empty field gets the fallback when it is left. `onValidity` tells the screen, so it can refuse to save.
 */
import React from 'react';
import { Input, Typography } from 'antd';

/** The fields of a form that are in error (by their label): `ok(label)` is each field's onValidity. */
export function useValidity(): { bad: string[]; ok: (label: string) => (ok: boolean) => void } {
    const [bad, setBad] = React.useState<string[]>([]);
    const ok = React.useCallback((label: string) => (good: boolean) => setBad((b) => (good ? (b.includes(label) ? b.filter((x) => x !== label) : b) : b.includes(label) ? b : [...b, label])), []);
    return { bad, ok };
}

/** Why a typed value is not right ("" is fine: the fallback), or null. */
export function wholeNumberProblem(text: string, label: string, min: number, max: number): string | null {
    const t = text.trim();
    if (t === '') return null;
    const range = `a whole number from ${min} to ${max}`;
    if (!/^\d+$/.test(t)) return `${label}: ${/^-/.test(t) ? 'no negative numbers' : /^-?\d*[.,]\d*$/.test(t) ? 'no decimals' : 'numbers only'} (${range}).`;
    const n = Number(t);
    return n < min || n > max ? `${label}: ${range} (not ${n}).` : null;
}

export function WholeNumber({ value, onChange, min, max, fallback, label, suffix, size, style, onValidity }: {
    value: number | undefined; onChange: (v: number) => void; min: number; max: number; fallback: number;
    /** The accessible name (also used in the message). */
    label: string; suffix?: string; size?: 'small' | 'middle'; style?: React.CSSProperties;
    /** Whether what is typed is a value that can be used (false while the message shows). */
    onValidity?: (ok: boolean) => void;
}) {
    const [text, setText] = React.useState(value === undefined ? '' : String(value));
    // A value changed from outside (a reload, a template) is shown; what is typed in error stays until put right.
    React.useEffect(() => {
        setText((t) => {
            const x = t.trim();
            if (/^\d+$/.test(x) && Number(x) === value) return t;
            if (x !== '' && !/^\d+$/.test(x)) return t;
            return value === undefined ? '' : String(value);
        });
    }, [value]);
    const msg = wholeNumberProblem(text, label, min, max);
    const report = React.useRef(onValidity);
    report.current = onValidity;
    React.useEffect(() => { report.current?.(!msg); }, [!msg]); // eslint-disable-line react-hooks/exhaustive-deps
    // A field taken away (a trigger removed) no longer holds anything back.
    React.useEffect(() => () => report.current?.(true), []);
    return (
        <div style={style}>
            <Input size={size} inputMode="numeric" value={text} aria-label={label} aria-invalid={!!msg} status={msg ? 'error' : undefined} addonAfter={suffix}
                onChange={(e) => {
                    const t = e.target.value;
                    setText(t);
                    const x = t.trim();
                    if (/^\d+$/.test(x) && Number(x) >= min && Number(x) <= max) onChange(Number(x));
                }}
                onBlur={() => { if (text.trim() === '') { setText(String(fallback)); onChange(fallback); } }} />
            {msg && <Typography.Text type="danger" role="alert" style={{ fontSize: 12, display: 'block' }}>{msg}</Typography.Text>}
        </div>
    );
}
