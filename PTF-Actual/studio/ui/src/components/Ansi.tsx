/**
 * Render terminal colour codes (ANSI SGR) as styled text. The framework's logger colours its
 * output even when NO_COLOR is set, so the Studio shows those colours instead of raw escape codes.
 */
import React from 'react';

const BASE = ['#6e7781', '#cf222e', '#1a7f37', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#8c959f'];
const BRIGHT = ['#8c959f', '#fa4549', '#2da44e', '#bf8700', '#218bff', '#a475f9', '#3192aa', '#afb8c1'];

interface Style { color?: string; bold?: boolean; dim?: boolean }

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

export function parseAnsi(text: string): Array<{ s: string; st: Style }> {
    const out: Array<{ s: string; st: Style }> = [];
    let st: Style = {};
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (m.index > last) out.push({ s: text.slice(last, m.index), st: { ...st } });
        for (const c of (m[1] || '0').split(';').map(Number)) {
            if (c === 0) st = {};
            else if (c === 1) st.bold = true;
            else if (c === 2) st.dim = true;
            else if (c === 22) { st.bold = false; st.dim = false; }
            else if (c >= 30 && c <= 37) st.color = BASE[c - 30];
            else if (c >= 90 && c <= 97) st.color = BRIGHT[c - 90];
            else if (c === 39) st.color = undefined;
        }
        last = re.lastIndex;
    }
    if (last < text.length) out.push({ s: text.slice(last), st: { ...st } });
    return out.map((p) => ({ ...p, s: p.s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') }));
}

export function Ansi({ text }: { text: string }) {
    if (!text.includes('\x1b')) return <>{text || ' '}</>;
    return <>{parseAnsi(text).map((p, i) => <span key={i} style={{ color: p.st.color, fontWeight: p.st.bold ? 600 : undefined, opacity: p.st.dim ? 0.7 : undefined }}>{p.s}</span>)}</>;
}
