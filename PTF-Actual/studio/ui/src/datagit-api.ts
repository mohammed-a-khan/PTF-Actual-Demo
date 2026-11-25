/**
 * The saves of the data / settings screens that send back the version the screen read (api.ts does not send it
 * yet): the server refuses a save over a change made since (another tab, someone else) with 409 and code "stale".
 * The same request as api.ts: the tab's Studio key, ApiError with the server's message.
 */
import { ApiError, NetworkSettings, NotifyChannelDef, NotifyDef, StudioSettings } from './api';

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
        throw new ApiError(o.error !== undefined ? String(o.error) : `Request failed (${res.status})`, res.status, typeof o.code === 'string' ? o.code : undefined);
    }
    return data as T;
}

/** The version a screen read, sent back with its save. */
export type Versioned<T> = T & { version?: string };

/** A save refused because what it would replace changed since the screen read it. */
export function isStale(e: unknown): boolean {
    return e instanceof ApiError && e.status === 409 && (e.code === 'stale' || /another tab/i.test(e.message));
}

export const datagitApi = {
    saveNotifications: (channels: NotifyChannelDef[], webhooks: Record<string, string>, version?: string) =>
        call<Versioned<NotifyDef>>('PUT', '/api/notifications', { channels, webhooks, version }),
    setPipelineSettings: (variableGroup: string, version?: string) =>
        call<Versioned<{ variableGroup: string }>>('PUT', '/api/pipeline/settings', { variableGroup, version }),
    saveNetwork: (n: NetworkSettings, version?: string) =>
        call<StudioSettings & { networkVersion?: string }>('PUT', '/api/settings/network', { ...n, version }),
};
