/** Load generators of a scenario (computers running `cs-test-studio agent`) and their health while running. */
export interface GeneratorDef {
    name: string;
    /** The agent's address, e.g. https://loadgen-eu1.example.com:4720 */
    url: string;
    /** Where it runs (a region, a data centre, a branch office): shown with its numbers. */
    zone?: string;
    /** The agent's token: {env:NAME} or {config:KEY} (never the token itself in the file). */
    token: string;
}

export interface GeneratorHealth {
    name: string; zone?: string; url: string;
    state: 'starting' | 'waiting' | 'running' | 'stopping' | 'finished' | 'error' | 'unreachable';
    users?: number; requests?: number; errors?: number; cpu?: number; memory?: number; error?: string; lastSeen?: string;
}

export function validGenerator(g: GeneratorDef): string | null {
    if (!g || typeof g.name !== 'string' || !/^[\w .-]{1,60}$/.test(g.name)) return 'a load generator needs a name';
    if (typeof g.url !== 'string' || !/^https?:\/\/[^\s/]+(:\d+)?\/?$/i.test(g.url.trim())) return `${g.name}: the address is http(s)://host:port`;
    if (g.zone !== undefined && (typeof g.zone !== 'string' || g.zone.length > 60)) return `${g.name}: the zone`;
    if (typeof g.token !== 'string' || !/^\{(env|config):[\w.-]+\}$/.test(g.token.trim())) return `${g.name}: the token is {env:NAME} or {config:KEY}, not the token itself`;
    return null;
}

