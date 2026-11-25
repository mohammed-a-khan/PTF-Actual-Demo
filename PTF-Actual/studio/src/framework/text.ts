/**
 * Names and literals the framework core writes everywhere (features, steps, pages, data, config):
 * one set of rules, so every module names things the same way.
 */

/** Words of a name or sentence (camelCase and punctuation split). */
export const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
export const pascal = (s: string) => words(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
export const camel = (s: string) => { const p = pascal(s); return p ? p[0].toLowerCase() + p.slice(1) : ''; };
export const kebab = (s: string) => words(s).map((w) => w.toLowerCase()).join('-');
export const snake = (s: string) => words(s).map((w) => w.toUpperCase()).join('_');

/** A TypeScript single-quoted string literal. */
export const tsString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** Step text: Cucumber expressions treat ( ) { } / \ specially; quotes would end a parameter. */
export const stepSafe = (s: string) => s.replace(/[(){}\\/]/g, ' ').replace(/["']/g, '').replace(/\s+/g, ' ').trim();

/**
 * A value as a {string} step argument: "…", or '…' when it holds double quotes (the framework takes
 * both, without escapes). null when it holds both kinds (no step argument can hold it).
 */
export function quote(s: string): string | null {
    if (/[\r\n]/.test(s)) return null;
    if (!s.includes('"')) return `"${s}"`;
    if (!s.includes("'")) return `'${s}'`;
    return null;
}

/** As quote(), but always a value: a text with both quote kinds gets its double quotes replaced. */
export function quoted(s: string): string {
    const v = s.replace(/\r?\n/g, ' ');
    return quote(v) ?? `"${v.replace(/"/g, "'")}"`;
}

/** A file name part: lower case words joined by -. */
export const slug = (s: string, fallback = 'item') => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
