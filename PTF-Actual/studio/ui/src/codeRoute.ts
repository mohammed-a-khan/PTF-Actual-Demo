/**
 * The file (and line) a Code address names. The Studio writes the path as one encoded segment
 * (#/code/test%2Fa%2Fb.feature/12); a typed address with plain slashes (#/code/test/a/b.feature/12) names the same
 * file: its segments are joined, and a last all-digit segment is the line. `typed` says the address is not in the
 * usual form (the screen rewrites it in place).
 */
export function codeTarget(rest: string[]): { path: string; line?: number; typed: boolean } {
    const isLine = (s: string | undefined) => !!s && /^\d+$/.test(s);
    if (rest.length <= 1 || (rest.length === 2 && isLine(rest[1]))) return { path: rest[0] ?? '', ...(isLine(rest[1]) ? { line: Number(rest[1]) } : {}), typed: false };
    const hasLine = isLine(rest[rest.length - 1]);
    return { path: (hasLine ? rest.slice(0, -1) : rest).join('/'), ...(hasLine ? { line: Number(rest[rest.length - 1]) } : {}), typed: true };
}
