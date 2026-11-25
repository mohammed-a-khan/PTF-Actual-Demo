/**
 * The few calls of the Agents group's screens that api.ts does not have (yet): the same request, with the tab's
 * Studio key, and the same errors (ApiError with the server's message).
 */
import { AgentBuilderDef, AgentSettingsDef, AgentStatus, AgentTriggerDef, ApiError, EvalCaseDef, EvalRunDef, EvalRunSummaryDef, EvalsDef, KnowledgeSourceDef, KnowledgeStatusDef, MissionsDef, TeamAgentDef, ToolServerDef, ToolServerRow, ToolServersView } from './api';

/** The Studio key as api.ts keeps it: this browser's localStorage, else this tab's sessionStorage. */
const token = () => {
    for (const get of [() => localStorage, () => sessionStorage]) { try { const v = get().getItem('cs-studio-token'); if (v) return v; } catch { /* blocked */ } }
    return '';
};

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

/** What the screens read, with the version each whole-file save sends back (409 when it changed since). */
export type AgentBuilderView = AgentBuilderDef & { versions?: Record<string, string> };
export type AgentStatusView = AgentStatus & { settingsVersion?: string };
export type ToolServerRowView = ToolServerRow & { version?: string };
/** A knowledge source as the screen shows it: `warning` when its folder is not there (only that source is affected). */
export type KnowledgeStatusView = KnowledgeStatusDef & { warning?: string };
/** A mission agent's own trigger (set in Agent builder), listed under Missions › Triggers. */
export type AgentTriggerView = AgentTriggerDef & { agent: string; name: string };
export type MissionsView = MissionsDef & { agentTriggers?: AgentTriggerView[] };
/** An evaluation run with the models that actually answered (older runs: not recorded). */
export type EvalRunSummaryView = EvalRunSummaryDef & { models?: string[] };
export type EvalRunView = EvalRunDef & { models?: string[] };
/** An agent's evaluations with the version of its cases file (a save over a newer one is refused: 409). */
export type EvalsView = Omit<EvalsDef, 'runs'> & { runs: EvalRunSummaryView[]; version?: string };
/** A save made on purpose over a version changed elsewhere (after "Overwrite"). */
const v = (version: string | undefined, force?: boolean) => ({ ...(version !== undefined ? { version } : {}), ...(force ? { force: true } : {}) });

export const agentsApi = {
    saveTeamAgent: (agent: TeamAgentDef, isNew: boolean, version?: string, force = false) =>
        call<AgentBuilderView & { agent: TeamAgentDef }>('PUT', `/api/agent-builder/${encodeURIComponent(agent.id)}`, { agent, isNew, ...v(isNew ? undefined : version, force) }),
    saveKnowledgeSources: (sources: KnowledgeSourceDef[], version?: string, force = false) =>
        call<{ sources: KnowledgeStatusView[]; version: string }>('PUT', '/api/knowledge/sources', { sources, ...v(version, force) }),
    teamNotes: () => call<{ file: string; text: string; version: string }>('GET', '/api/missions-memory'),
    saveTeamNotes: (text: string, version?: string, force = false) => call<{ ok: boolean; version: string }>('PUT', '/api/missions-memory', { text, ...v(version, force) }),
    saveAgentSettings: (settings: AgentSettingsDef, keys: { providerKey?: string; copilotToken?: string }, version?: string, force = false) =>
        call<AgentStatusView>('PUT', '/api/agents/settings', { settings, ...keys, ...v(version, force) }),
    saveToolServer: (b: { scope: 'team' | 'personal'; name: string; from?: string; values?: Record<string, string>; server?: ToolServerDef; editing?: string }, version?: string, force = false) =>
        call<ToolServersView>('PUT', '/api/agents/tool-servers', { ...b, ...v(b.editing ? version : undefined, force) }),
    missions: () => call<MissionsView>('GET', '/api/missions'),
    evals: (agent: string) => call<EvalsView>('GET', `/api/evals/${encodeURIComponent(agent)}`),
    saveEvals: (agent: string, suite: { cases: EvalCaseDef[] }, version?: string, force = false) =>
        call<{ suite: { cases: EvalCaseDef[] }; version: string }>('PUT', `/api/evals/${encodeURIComponent(agent)}`, { suite, ...v(version, force) }),
    evalRun: (agent: string, id: string) => call<EvalRunView>('GET', `/api/evals/${encodeURIComponent(agent)}/runs/${encodeURIComponent(id)}`),
    /** Delete a finished mission (its copy, screenshots and branch too, unless a pull request uses the branch). */
    deleteMission: (id: string) => call<{ ok: boolean }>('DELETE', `/api/missions/${encodeURIComponent(id)}`, { confirm: true }),
    /** Remove an entry of the knowledge file that is not right; the other entries stay as written. */
    removeInvalidKnowledgeSource: (index: number) => call<{ sources: KnowledgeStatusDef[] }>('POST', '/api/knowledge/sources/remove-invalid', { index }),
    /** Remove a tool server; withSecrets: the Studio secrets its pasted configuration made go too. */
    removeToolServer: (name: string, scope: 'team' | 'personal', withSecrets: boolean) =>
        call<ToolServersView & { removedSecrets: string[] }>('DELETE', `/api/agents/tool-servers/${encodeURIComponent(name)}?scope=${scope}${withSecrets ? '&secrets=remove' : ''}`),
};
