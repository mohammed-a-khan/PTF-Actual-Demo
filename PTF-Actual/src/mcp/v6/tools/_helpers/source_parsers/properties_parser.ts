/**
 * .properties / message-bundle parser.
 *
 * Understands the Java properties format (java.util.Properties compatible):
 *   - key=value or key:value  or key<whitespace>value
 *   - `#` and `!` line comments
 *   - `\` line continuation
 *   - `\n`, `\t`, `\r`, `\uXXXX` escapes
 *   - Locale is derived from filename: `messages_en_US.properties` → en_US;
 *     `messages.properties` → default.
 *
 * Also understands a minimal subset of `.yml` message bundles used by Spring
 * Boot: a flat map of `key: value` OR nested keys collapsed with dots.
 * The parser is regex-driven — we deliberately do NOT depend on js-yaml because
 * consumer projects on-prem may not have it installed.
 */

export interface ParsedMessages {
    /** Locale code — 'default' when the file has no locale suffix. */
    locale: string;
    /** Fully-qualified key → value. */
    entries: Record<string, string>;
    /** How many keys were parsed. */
    keyCount: number;
    /** Parse warnings (malformed lines that were skipped). */
    warnings: string[];
}

export function localeFromFilename(filename: string): string {
    // messages_en_US.properties → en_US
    // messages_en.properties    → en
    // messages.properties       → default
    // ValidationMessages.properties → default
    // app_i18n_fr_FR.yml → fr_FR
    const base = filename.replace(/\.(properties|yml|yaml)$/i, '');
    const match = base.match(/_([a-z]{2}(?:_[A-Z]{2})?)$/);
    if (match) return match[1];
    return 'default';
}

/**
 * Parse a Java .properties file honoring the Java Properties format's escapes
 * and line continuations.
 */
export function parseProperties(content: string, filename: string = 'messages.properties'): ParsedMessages {
    const entries: Record<string, string> = {};
    const warnings: string[] = [];
    const locale = localeFromFilename(filename);

    const lines = content.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        let line = lines[i];
        i++;
        // Skip leading whitespace, then check for comment.
        const trimmed = line.replace(/^[ \t\f]+/, '');
        if (trimmed.length === 0) continue;
        if (trimmed.startsWith('#') || trimmed.startsWith('!')) continue;

        // Line continuation: trailing `\` (not `\\`)
        let physical = line;
        while (endsWithOddBackslash(physical) && i < lines.length) {
            physical = physical.slice(0, -1) + lines[i].replace(/^[ \t\f]+/, '');
            i++;
        }

        // Split into key/value using first unescaped =, :, or whitespace run.
        const { key, value } = splitKV(physical);
        if (key === null) {
            warnings.push(`malformed line skipped: ${line.slice(0, 80)}`);
            continue;
        }
        entries[unescape(key)] = unescape(value);
    }

    return { locale, entries, keyCount: Object.keys(entries).length, warnings };
}

function endsWithOddBackslash(s: string): boolean {
    let count = 0;
    for (let j = s.length - 1; j >= 0 && s[j] === '\\'; j--) count++;
    return count % 2 === 1;
}

function splitKV(line: string): { key: string | null; value: string } {
    // strip leading whitespace
    let start = 0;
    while (start < line.length && /[ \t\f]/.test(line[start])) start++;
    if (start >= line.length) return { key: null, value: '' };

    let sep = -1;
    let sepChar: string | null = null;
    for (let j = start; j < line.length; j++) {
        const ch = line[j];
        if (ch === '\\') { j++; continue; }
        if (ch === '=' || ch === ':') { sep = j; sepChar = ch; break; }
        if (/[ \t\f]/.test(ch)) {
            // whitespace separator (only if followed by non-separator)
            let k = j + 1;
            while (k < line.length && /[ \t\f]/.test(line[k])) k++;
            if (k < line.length && (line[k] === '=' || line[k] === ':')) {
                sep = k;
                sepChar = line[k];
            } else {
                sep = j;
                sepChar = ' ';
            }
            break;
        }
    }
    if (sep === -1) {
        // whole line is the key with an empty value
        return { key: line.slice(start).trim(), value: '' };
    }
    const key = line.slice(start, sep).trim();
    // Skip separator + any following whitespace.
    let vStart = sep + 1;
    if (sepChar === '=' || sepChar === ':') {
        // Allow one trailing whitespace char run after `=`/`:`.
        while (vStart < line.length && /[ \t\f]/.test(line[vStart])) vStart++;
    }
    const value = line.slice(vStart);
    return { key, value };
}

function unescape(raw: string): string {
    let out = '';
    for (let j = 0; j < raw.length; j++) {
        const ch = raw[j];
        if (ch !== '\\') { out += ch; continue; }
        const next = raw[j + 1];
        if (next === undefined) break;
        switch (next) {
            case 'n': out += '\n'; j++; break;
            case 't': out += '\t'; j++; break;
            case 'r': out += '\r'; j++; break;
            case 'f': out += '\f'; j++; break;
            case '\\': out += '\\'; j++; break;
            case '=': out += '='; j++; break;
            case ':': out += ':'; j++; break;
            case ' ': out += ' '; j++; break;
            case 'u': {
                const hex = raw.slice(j + 2, j + 6);
                if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                    out += String.fromCharCode(parseInt(hex, 16));
                    j += 5;
                } else {
                    out += next;
                    j++;
                }
                break;
            }
            default:
                out += next;
                j++;
        }
    }
    return out;
}

/**
 * Parse a minimal YAML message bundle — flat or one-level nested keys only.
 * Nested keys are flattened with `.`:
 *
 *   validation:
 *     required: "This field is required"
 *
 * → { "validation.required": "This field is required" }
 */
export function parseYamlMessages(content: string, filename: string = 'messages.yml'): ParsedMessages {
    const entries: Record<string, string> = {};
    const warnings: string[] = [];
    const locale = localeFromFilename(filename);

    const lines = content.split(/\r?\n/);
    const stack: Array<{ indent: number; key: string }> = [];

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (raw.trim().length === 0) continue;
        if (raw.trim().startsWith('#')) continue;

        const indentMatch = raw.match(/^(\s*)(.*)$/);
        if (!indentMatch) continue;
        const indent = indentMatch[1].length;
        const rest = indentMatch[2];

        // Pop stack entries with equal or greater indent.
        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();

        const kvMatch = rest.match(/^([^:]+):\s*(.*)$/);
        if (!kvMatch) {
            warnings.push(`malformed yaml line skipped: ${raw.slice(0, 80)}`);
            continue;
        }
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();
        if (value === '' || value === '|' || value === '>') {
            // Object header or block-scalar header — treat as branch node.
            stack.push({ indent, key });
        } else {
            const fullKey = stack.map((s) => s.key).concat(key).join('.');
            entries[fullKey] = stripYamlQuotes(value);
        }
    }

    return { locale, entries, keyCount: Object.keys(entries).length, warnings };
}

function stripYamlQuotes(v: string): string {
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    return v;
}
