/** Small display helpers shared by the screens. */

/** "just now", "5 min ago", "3 h ago", "2 days ago", else the date. */
export function ago(d: string | number | Date): string {
    const t = new Date(d).getTime();
    if (!Number.isFinite(t)) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) { const n = Math.floor(s / 86400); return `${n} day${n === 1 ? '' : 's'} ago`; }
    return new Date(t).toLocaleDateString();
}

/** A Git ref as people say it: refs/heads/main → main, refs/pull/7/merge → PR !7, refs/tags/v1 → v1. */
export function shortRef(ref: string): string {
    const pr = /^refs\/pull\/(\d+)\/(merge|head)$/.exec(ref);
    if (pr) return `PR !${pr[1]}`;
    return ref.replace(/^refs\/(heads|tags)\//, '');
}

/** First name only (lists): "Mohammed Ataullah Khan" → "Mohammed". */
export const firstName = (n?: string) => (n ?? '').trim().split(/\s+/)[0] ?? '';
