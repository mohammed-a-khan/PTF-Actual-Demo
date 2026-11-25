/** Database results as text: one cell (copy, tooltips) and CSV for spreadsheets. */
import type { DbCell, DbColumn } from './api';

/** A cell as text (copy / CSV). */
export function cellString(c: DbCell): string {
    if (c === null) return '';
    if (typeof c !== 'object') return String(c);
    if (c.$t === 'bin') return `0x${c.v}${c.n > 64 ? '…' : ''}`;
    return c.v;
}
/**
 * CSV for spreadsheets. Text starting with = + - @ (or a tab / carriage return) is prefixed with ' so a
 * spreadsheet shows it instead of running it as a formula (CSV injection, OWASP); numbers stay numbers.
 */
export function csvText(cols: DbColumn[], rows: DbCell[][]): string {
    const safe = (s: string, c: DbCell) => (typeof c === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s) ? `'${s}` : s);
    const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return [cols.map((c) => q(safe(c.name, c.name))).join(','), ...rows.map((r) => r.map((c) => q(safe(cellString(c), c))).join(','))].join('\r\n');
}
