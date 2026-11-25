/**
 * A whole-number field that never changes what the person typed (the run options: workers, retries, window size).
 * The same rule as WholeNumber (whole numbers in min…max, a short message under the field otherwise), but nothing
 * is rounded, clamped or dropped: 2.5, -1 or 99999 stay in the field, in error, with the reason, and the value used
 * stays the last good one.
 * `onValidity` tells the screen, so it can refuse to go on (Run, Save) until the value is put right.
 */
import React from 'react';
import { Input, Typography } from 'antd';
import { wholeNumberProblem } from './WholeNumber';

export function StrictWholeNumber({ value, onChange, onClear, min, max, label, placeholder, id, style, onValidity }: {
    value: number | undefined; onChange: (v: number) => void;
    /** Empty is allowed (the field is optional): called when it is emptied. Without it, empty is an error. */
    onClear?: () => void;
    min: number; max: number;
    /** The accessible name (also used in the message). */
    label: string; placeholder?: string; id?: string; style?: React.CSSProperties;
    onValidity?: (ok: boolean) => void;
}) {
    const [text, setText] = React.useState(value === undefined ? '' : String(value));
    // A value changed from outside (a saved run filled in, a reload) is shown.
    React.useEffect(() => { setText((t) => (t !== '' && Number(t) === value ? t : value === undefined ? (onClear ? '' : t) : String(value))); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
    // The same rule (and words) as every other whole-number field: see WholeNumber.wholeNumberProblem.
    const msg = text.trim() === '' ? (onClear ? null : `${label}: give a whole number from ${min} to ${max}.`) : wholeNumberProblem(text, label, min, max);
    const bad = !!msg;
    React.useEffect(() => { onValidity?.(!bad); }, [bad]); // eslint-disable-line react-hooks/exhaustive-deps
    return (
        <div style={style}>
            <Input id={id} inputMode="numeric" value={text} aria-label={label} aria-invalid={!!msg} status={msg ? 'error' : undefined} placeholder={placeholder}
                onChange={(e) => {
                    const v = e.target.value;
                    setText(v);
                    const x = v.trim();
                    if (x === '') { onClear?.(); return; }
                    if (/^\d+$/.test(x) && Number(x) >= min && Number(x) <= max) onChange(Number(x));
                }} />
            {msg && <Typography.Text type="danger" role="alert" style={{ fontSize: 12, display: 'block' }}>{msg}</Typography.Text>}
        </div>
    );
}
