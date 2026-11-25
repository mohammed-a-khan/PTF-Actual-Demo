/**
 * The few calls of the Agents group's screens that api.ts does not have (yet): the same request, with the tab's
 * Studio key, and the same errors (ApiError with the server's message).
 */
import { ApiError, KnowledgeStatusDef, ToolServersView } from './api';

const token = () => { try { return sessionStorage.getItem('cs-studio-token') ?? ''; } catch { return ''; } };

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) throw new ApiError(data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Request failed (${res.status})`, res.status);
    return data as T;
}

/** An entry of .cs-studio/knowledge.json the Studio leaves out (its place in the file, its name, why). */
export interface InvalidKnowledgeSource { index: number; id: string; name: string; problem: string }

export const agentsApi = {
    /** Remove an entry of the knowledge file that is not right; the other entries stay as written. */
    removeInvalidKnowledgeSource: (index: number) => call<{ sources: KnowledgeStatusDef[] }>('POST', '/api/knowledge/sources/remove-invalid', { index }),
    /** Remove a tool server; withSecrets: the Studio secrets its pasted configuration made go too. */
    removeToolServer: (name: string, scope: 'team' | 'personal', withSecrets: boolean) =>
        call<ToolServersView & { removedSecrets: string[] }>('DELETE', `/api/agents/tool-servers/${encodeURIComponent(name)}?scope=${scope}${withSecrets ? '&secrets=remove' : ''}`),
};
