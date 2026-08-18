import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, AdoHttpError } from './_helpers/ado_http_client';
import { LruCache } from './_helpers/ado_lru_cache';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

// Sprint / iteration auto-discovery — replaces "please tell me the current
// sprint" prompts with a single HTTP call, cached across the whole invocation.
//
// Verbs:
//   - get-current        current iteration for team, plus default area path
//   - get-by-name        find an iteration by name (substring, case-insensitive)
//   - list               recent iterations for the team
//   - resolve-team       infer / list teams — used for auto-detect
//
// Cache: 5-minute LRU keyed by orgUrl|project|team|kind. `refresh: true` bypasses.

interface CachedIteration {
    fetchedAt: number;
    payload: unknown;
}

// Module-level cache — persists across tool invocations in the same server process.
// Cache is intentionally small (max 100) because sprint queries are per-team.
const iterationCache = new LruCache<string, CachedIteration>({ maxSize: 100, ttlMs: 5 * 60 * 1000 });
// Separate cache for default-team lookups. Team assignment is stable per project;
// we cache both hits ('name') and misses ('__none__') so failed lookups don't
// re-hit the server every invocation either.
const defaultTeamCache = new LruCache<string, string | null>({ maxSize: 50, ttlMs: 5 * 60 * 1000 });

interface TeamSetting {
    orgUrl: string;
    project: string;
    team: string;
    pat: string;
}

async function fetchDefaultTeam(client: AdoHttpClient, orgUrl: string, project: string, refresh: boolean): Promise<string | null> {
    const key = `${orgUrl}|${project}`;
    if (!refresh) {
        const cached = defaultTeamCache.get(key);
        if (cached !== undefined) return cached;
    }
    try {
        // /_apis/projects/{project}?includeCapabilities=false — returns defaultTeam
        const data = await client.get<{ defaultTeam?: { name?: string } }>(
            `_apis/projects/${encodeURIComponent(project)}?api-version=7.1`,
            { scopeToProject: false },
        );
        const name = data?.defaultTeam?.name ?? null;
        defaultTeamCache.set(key, name);
        return name;
    } catch {
        defaultTeamCache.set(key, null);
        return null;
    }
}

async function listTeams(client: AdoHttpClient, project: string): Promise<Array<{ id: string; name: string }>> {
    try {
        const data = await client.get<{ value?: Array<{ id: string; name: string }> }>(
            `_apis/projects/${encodeURIComponent(project)}/teams?api-version=7.1`,
            { scopeToProject: false },
        );
        return data?.value ?? [];
    } catch {
        return [];
    }
}

interface IterationEntry {
    id: string;
    name: string;
    path: string;
    attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
}

async function fetchTeamIterations(client: AdoHttpClient, team: TeamSetting, timeframe?: 'current'): Promise<IterationEntry[]> {
    const timeframeQs = timeframe === 'current' ? '&$timeframe=current' : '';
    // The team-context path is /{project}/{team}/_apis/work/teamsettings/iterations.
    // We bypass scopeToProject and build the URL explicitly to include the team segment.
    const pathAndQuery = `${encodeURIComponent(team.project)}/${encodeURIComponent(team.team)}/_apis/work/teamsettings/iterations?api-version=7.1${timeframeQs}`;
    const data = await client.get<{ value?: IterationEntry[] }>(pathAndQuery, { scopeToProject: false });
    return data?.value ?? [];
}

async function fetchTeamFieldValues(client: AdoHttpClient, team: TeamSetting): Promise<{ defaultAreaPath?: string; areaPaths?: string[] }> {
    try {
        const pathAndQuery = `${encodeURIComponent(team.project)}/${encodeURIComponent(team.team)}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`;
        const data = await client.get<{ defaultValue?: string; values?: Array<{ value: string }> }>(pathAndQuery, { scopeToProject: false });
        return {
            defaultAreaPath: data?.defaultValue,
            areaPaths: (data?.values ?? []).map((v) => v.value),
        };
    } catch {
        return {};
    }
}

function shapeIteration(entry: IterationEntry | undefined, extras: { teamName: string; defaultAreaPath?: string }) {
    if (!entry) return null;
    return {
        iterationId: entry.id,
        iterationName: entry.name,
        iterationPath: entry.path,
        startDate: entry.attributes?.startDate,
        finishDate: entry.attributes?.finishDate,
        timeFrame: entry.attributes?.timeFrame,
        teamName: extras.teamName,
        defaultAreaPath: extras.defaultAreaPath,
    };
}

registerPrimitive({
    name: 'cs_qa_ado_sprint_context',
    description: 'Auto-discover the current ADO iteration (sprint) for a team — no more "which sprint am I in?" prompts. Verbs: get-current (current iteration + team default area path — cached 5min), get-by-name (find iteration by case-insensitive substring; returns candidates on ambiguity), list (recent iterations for the team), resolve-team (auto-detect the default team, or list all teams in the project). Inputs default via cs_qa_ado_config six-tier cascade. Set refresh:true to bypass the LRU cache.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('get-current'),
            team: z.string().optional().describe('Team name; when omitted, uses ado.defaultTeam from workspace config or the project default team.'),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
            refresh: z.boolean().optional().describe('Force refetch even if a fresh entry exists in the LRU cache.'),
        }),
        z.object({
            verb: z.literal('get-by-name'),
            name: z.string().min(1).describe('Iteration name substring (case-insensitive). e.g. "Sprint 42" or "Q3".'),
            team: z.string().optional(),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
            refresh: z.boolean().optional(),
        }),
        z.object({
            verb: z.literal('list'),
            team: z.string().optional(),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
            refresh: z.boolean().optional(),
        }),
        z.object({
            verb: z.literal('resolve-team'),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
        }),
    ]),
    outputSchema: z.object({
        ok: z.boolean(),
        verb: z.string(),
        cached: z.boolean().optional(),
        data: z.any().optional(),
        candidates: z.array(z.any()).optional(),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_ado_sprint_context', { workspaceRoot: ctx.workspaceRoot });
        const resolved = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: (input as { orgUrl?: string }).orgUrl,
            project: (input as { project?: string }).project,
        });
        if (!resolved.creds) {
            logger.error('ado not configured', { note: resolved.diagnostic });
            return { ok: false, verb: input.verb, note: resolved.diagnostic };
        }
        const cfg = resolved.creds;
        const client = new AdoHttpClient(cfg);

        // resolve-team ALWAYS refetches — it's the diagnostic verb, callers use it
        // when they distrust the cache.
        if (input.verb === 'resolve-team') {
            try {
                const [defaultTeam, teams] = await Promise.all([
                    fetchDefaultTeam(client, cfg.orgUrl, cfg.project, true),
                    listTeams(client, cfg.project),
                ]);
                logger.info('teams resolved', { count: teams.length, defaultTeam });
                return {
                    ok: true,
                    verb: input.verb,
                    data: { defaultTeam, teams },
                    note: defaultTeam
                        ? `Default team: ${defaultTeam}. ${teams.length} team(s) in project.`
                        : `${teams.length} team(s) available; no explicit default.`,
                };
            } catch (e) {
                const err = e as AdoHttpError | Error;
                logger.error('resolve-team failed', { error: err.message });
                return { ok: false, verb: input.verb, note: `Failed to list teams: ${err.message}` };
            }
        }

        // Determine team name for the other verbs.
        const wantedTeam = (input as { team?: string }).team;
        const refresh = (input as { refresh?: boolean }).refresh === true;
        let team = wantedTeam;
        if (!team) {
            team = (await fetchDefaultTeam(client, cfg.orgUrl, cfg.project, refresh)) ?? undefined;
        }
        if (!team) {
            return { ok: false, verb: input.verb, note: `No team specified and could not auto-detect a default team for project ${cfg.project}. Try verb=resolve-team.` };
        }

        const teamSetting: TeamSetting = { orgUrl: cfg.orgUrl, project: cfg.project, team, pat: cfg.pat };
        const cacheKey = `${cfg.orgUrl}|${cfg.project}|${team}|${input.verb === 'get-current' ? 'current' : 'all'}`;

        // get-current — cached
        if (input.verb === 'get-current') {
            if (!refresh) {
                const cached = iterationCache.get(cacheKey);
                if (cached) {
                    return { ok: true, verb: input.verb, cached: true, data: cached.payload };
                }
            }
            try {
                const [iters, areaInfo] = await Promise.all([
                    fetchTeamIterations(client, teamSetting, 'current'),
                    fetchTeamFieldValues(client, teamSetting),
                ]);
                const shaped = shapeIteration(iters[0], { teamName: team, defaultAreaPath: areaInfo.defaultAreaPath });
                if (!shaped) {
                    return { ok: false, verb: input.verb, note: `No current iteration for team ${team}. Team may have no iterations dated to today.` };
                }
                iterationCache.set(cacheKey, { fetchedAt: Date.now(), payload: shaped });
                logger.info('current iteration fetched', { team, iterationName: shaped.iterationName });
                return { ok: true, verb: input.verb, cached: false, data: shaped };
            } catch (e) {
                const err = e as Error;
                logger.error('get-current failed', { error: err.message, team });
                return { ok: false, verb: input.verb, note: err.message };
            }
        }

        // list / get-by-name — share a full iteration list, cached under 'all'
        try {
            let entries: IterationEntry[] | null = null;
            if (!refresh) {
                const cached = iterationCache.get(cacheKey);
                if (cached && Array.isArray((cached.payload as { entries?: IterationEntry[] })?.entries)) {
                    entries = (cached.payload as { entries: IterationEntry[] }).entries;
                }
            }
            let areaInfo: { defaultAreaPath?: string } | null = null;
            if (!entries) {
                const [i, a] = await Promise.all([
                    fetchTeamIterations(client, teamSetting),
                    fetchTeamFieldValues(client, teamSetting),
                ]);
                entries = i;
                areaInfo = a;
                iterationCache.set(cacheKey, { fetchedAt: Date.now(), payload: { entries, areaInfo } });
            } else {
                const cached = iterationCache.get(cacheKey);
                areaInfo = (cached?.payload as { areaInfo?: { defaultAreaPath?: string } })?.areaInfo ?? null;
            }

            if (input.verb === 'list') {
                logger.info('iterations listed', { team, count: entries.length });
                return {
                    ok: true, verb: input.verb, cached: false,
                    data: {
                        teamName: team,
                        defaultAreaPath: areaInfo?.defaultAreaPath,
                        iterations: entries.map((e) => shapeIteration(e, { teamName: team!, defaultAreaPath: areaInfo?.defaultAreaPath })),
                    },
                };
            }

            // get-by-name
            const needle = (input as { name: string }).name.toLowerCase();
            const matches = entries.filter((e) => e.name.toLowerCase().includes(needle));
            if (matches.length === 0) {
                return { ok: false, verb: input.verb, note: `No iteration matching "${(input as { name: string }).name}" for team ${team}. ${entries.length} iterations searched.` };
            }
            if (matches.length > 1) {
                return {
                    ok: false,
                    verb: input.verb,
                    candidates: matches.map((e) => shapeIteration(e, { teamName: team!, defaultAreaPath: areaInfo?.defaultAreaPath })),
                    note: `Ambiguous — ${matches.length} iterations matched. Refine the substring or pick one from the candidates list.`,
                };
            }
            return {
                ok: true,
                verb: input.verb,
                cached: false,
                data: shapeIteration(matches[0], { teamName: team, defaultAreaPath: areaInfo?.defaultAreaPath }),
            };
        } catch (e) {
            const err = e as Error;
            logger.error('sprint list failed', { error: err.message, team });
            return { ok: false, verb: input.verb, note: err.message };
        }
    },
});

/** For tests + debugging — clears both module-level caches. */
export function _clearSprintCacheForTests(): void {
    iterationCache.clear();
    defaultTeamCache.clear();
}
