/**
 * The saves of the data / settings screens that send back the version the screen read (api.ts does not send it
 * yet): the server refuses a save over a change made since (another tab, someone else) with 409 and code "stale".
 * The same request as api.ts: the tab's Studio key, ApiError with the server's message.
 */
import { ApiError, NetworkSettings, NotifyChannelDef, NotifyDef, SecretMeta, StudioSettings } from './api';

const TOKEN_KEY = 'cs-studio-token';
function token(): string {
    for (const get of [() => localStorage, () => sessionStorage]) {
        try { const v = get().getItem(TOKEN_KEY); if (v) return v; } catch { /* blocked: try the next */ }
    }
    return '';
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) {
        const o = data && typeof data === 'object' ? data as { error?: unknown; code?: unknown } : {};
        const err = new ApiError(o.error !== undefined ? String(o.error) : `Request failed (${res.status})`, res.status, typeof o.code === 'string' ? o.code : undefined);
        // A stale save says the version saved now: "Keep editing" sends it with the next save.
        const v = (o as { version?: unknown }).version;
        if (typeof v === 'string') (err as ApiError & { current?: string }).current = v;
        throw err;
    }
    return data as T;
}

/** The version a screen read, sent back with its save. */
export type Versioned<T> = T & { version?: string };

/** A save refused because what it would replace changed since the screen read it. */
export function isStale(e: unknown): boolean {
    return e instanceof ApiError && e.status === 409 && (e.code === 'stale' || /another tab/i.test(e.message));
}

/** The version saved now, sent with a stale-save refusal (undefined when the server did not say). */
export function staleVersion(e: unknown): string | undefined {
    return e instanceof ApiError ? (e as ApiError & { current?: string }).current : undefined;
}

const qs = (o: Record<string, string | undefined>) => {
    const p = Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`);
    return p.length ? `?${p.join('&')}` : '';
};
const forced = (force?: boolean) => (force ? { force: true } : {});

export const datagitApi = {
    /** force: the person chose Overwrite after a refusal. */
    saveNotifications: (channels: NotifyChannelDef[], webhooks: Record<string, string>, version?: string, force?: boolean) =>
        call<Versioned<NotifyDef>>('PUT', '/api/notifications', { channels, webhooks, version, ...forced(force) }),
    setPipelineSettings: (variableGroup: string, version?: string, force?: boolean) =>
        call<Versioned<{ variableGroup: string }>>('PUT', '/api/pipeline/settings', { variableGroup, version, ...forced(force) }),
    saveNetwork: (n: NetworkSettings, version?: string, force?: boolean) =>
        call<StudioSettings & { networkVersion?: string }>('PUT', '/api/settings/network', { ...n, version, ...forced(force) }),
    /** A saved database query with the version it was read at. */
    dbQueryFile: (file: string) => call<{ file: string; text: string; connection: string | null; version?: string }>('GET', '/api/db/query-file' + qs({ file })),
    dbSaveQuery: (b: { project: string; text: string; file?: string; name?: string; overwrite?: boolean; version?: string; force?: boolean }) =>
        call<{ file: string; version?: string }>('PUT', '/api/db/query-file', b),
    /** was: the value the screen showed in this file (null: not set there); changed since → refused (409). */
    envSet: (file: string, key: string, value: string, was: string | null | undefined, force?: boolean) =>
        call<{ line: number }>('PUT', '/api/env/value', { file, key, value, was, ...forced(force) }),
    envRemove: (file: string, key: string, was?: string, force?: boolean) =>
        call<{ removed: number }>('DELETE', '/api/env/value' + qs({ file, key, was, force: force ? 'true' : undefined })),
    envSecret: (b: { file: string; key: string; secretName: string; value: string; env?: string; was?: string | null; force?: boolean }) =>
        call<{ reference: string }>('POST', '/api/env/secret', b),
    /** expect: "new" (Add) or "existing" (Replace), what the list showed; otherwise refused (409). Absent: saved as asked. */
    setSecret: (name: string, value: string, env: string | undefined, scope: 'all-projects' | undefined, expect?: 'new' | 'existing') =>
        call<SecretMeta>('PUT', '/api/secrets', { name, value, env, scope, expect }),
};
