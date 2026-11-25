/**
 * A whole-number field of the Agents screens (a trigger's daily limit, a mission's budget): anything that is not a
 * digit is refused as it is typed, with a short message under the field, instead of being dropped silently on save.
 * A number outside min…max is shown in error and brought into range when the field is left.
 */
import React from 'react';
import { Input, Typography } from 'antd';

export function WholeNumber({ value, onChange, min, max, fallback, label, suffix, size, style }: {
    value: number | undefined; onChange: (v: number) => void; min: number; max: number; fallback: number;
    /** The accessible name (also used in the message). */
    label: string; suffix?: string; size?: 'small' | 'middle'; style?: React.CSSProperties;
}) {
    const [text, setText] = React.useState(value === undefined ? '' : String(value));
    const [note, setNote] = React.useState<string | null>(null);
    // A value changed from outside (a reload, a template) is shown.
    React.useEffect(() => { setText((t) => (Number(t) === value ? t : value === undefined ? '' : String(value))); }, [value]);
    const range = `a whole number from ${min} to ${max}`;
    const n = text === '' ? null : Number(text);
    const out = n !== null && (n < min || n > max);
    const msg = note ?? (out ? `${label}: ${range}.` : null);
    return (
        <div style={style}>
            <Input size={size} inputMode="numeric" value={text} aria-label={label} aria-invalid={!!msg} status={msg ? 'error' : undefined} addonAfter={suffix}
                onChange={(e) => {
                    const t = e.target.value.trim();
                    if (!/^\d*$/.test(t)) { setNote(`${label}: numbers only (${range}).`); return; }
                    setNote(null);
                    setText(t);
                    if (t !== '') { const x = Number(t); if (x >= min && x <= max) onChange(x); }
                }}
                onBlur={() => {
                    setNote(null);
                    const x = text === '' ? fallback : Math.min(max, Math.max(min, Number(text)));
                    setText(String(x));
                    onChange(x);
                }} />
            {msg && <Typography.Text type="danger" role="alert" style={{ fontSize: 12, display: 'block' }}>{msg}</Typography.Text>}
        </div>
    );
}
