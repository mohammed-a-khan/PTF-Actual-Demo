/**
 * Names for new files and folders (Code: New file, New folder, Rename). A repository is shared: a name Windows
 * cannot hold (`con<>.txt`, `aux.json`, `notes.`) would break every Windows teammate's checkout, so it is refused
 * on every platform, with the reason. Pure (no file system): the editor checks as the name is typed, the server
 * again when it creates the file.
 */

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)\s*(\..*)?$/i;
const BAD_CHARS = /[<>:"|?*\\]/g;

/** Why one part of a path (a file or folder name) cannot be used, or null. */
export function nameProblem(seg: string): string | null {
    if (!seg) return 'A name is empty (two "/" in a row).';
    if (seg === '.' || seg === '..') return `"${seg}" cannot be used as a name.`;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(seg)) return `"${shorten(seg)}" contains a control character, which Windows does not allow in names.`;
    const bad = [...new Set(seg.match(BAD_CHARS) ?? [])];
    if (bad.length) return `"${shorten(seg)}" contains ${bad.map((c) => c === '"' ? "'\"'" : `"${c}"`).join(' ')}: Windows does not allow ${bad.length === 1 ? 'it' : 'them'} in names (< > : " | ? * \\).`;
    if (RESERVED.test(seg)) return `"${shorten(seg)}" is a reserved name on Windows (${seg.split('.')[0].trim().toUpperCase()}, with any extension).`;
    // Most file systems hold at most 255 characters per name (Windows paths are shorter still).
    if (seg.length > 255) return `"${shorten(seg)}" is ${seg.length} characters long: a name can have at most 255.`;
    if (/[. ]$/.test(seg)) return `"${shorten(seg)}" ends with a ${seg.endsWith('.') ? 'dot' : 'space'}, which Windows drops.`;
    return null;
}

/** Why a repository-relative path for something new cannot be used (the first name with a problem), or null. */
export function newPathProblem(rel: string): string | null {
    const parts = rel.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
    for (const p of parts) { const why = nameProblem(p); if (why) return why; }
    return null;
}

/** A long name in a message: its start kept readable, cut at the end. */
export const shorten = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
