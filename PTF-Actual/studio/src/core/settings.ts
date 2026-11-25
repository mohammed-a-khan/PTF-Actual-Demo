/**
 * Personal Studio settings, stored on this computer (never in a repository, so a cloned repo can
 * never change them): trusted Azure DevOps hosts, which secret holds the ADO token, start-up
 * preferences. File: <studio home>/settings.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensurePrivateDir, writeFileAtomic } from './paths';
import { UserError } from './errors';
import { DEFAULT_NETWORK, NetworkSettings, validateNetwork } from './network';

/** Network settings from the file, field by field (anything unexpected falls back to the default). */
function readNetwork(v: unknown): NetworkSettings {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const str = (x: unknown, d: string) => (typeof x === 'string' ? x : d);
    return {
        proxyMode: o.proxyMode === 'environment' || o.proxyMode === 'manual' || o.proxyMode === 'system' || o.proxyMode === 'pac' ? o.proxyMode : 'off',
        proxyUrl: str(o.proxyUrl, ''),
        proxyUser: str(o.proxyUser, ''),
        bypass: Array.isArray(o.bypass) ? o.bypass.filter((x): x is string => typeof x === 'string') : [...DEFAULT_NETWORK.bypass],
        useSystemCerts: o.useSystemCerts === true,
        caFile: str(o.caFile, ''),
        certsForTestRuns: o.certsForTestRuns !== false,
        ...(typeof o.pacUrl === 'string' ? { pacUrl: o.pacUrl } : {}),
        ...(o.proxyAuth === 'ntlm' || o.proxyAuth === 'digest' || o.proxyAuth === 'basic' ? { proxyAuth: o.proxyAuth } : {}),
        ...(typeof o.proxyDomain === 'string' ? { proxyDomain: o.proxyDomain } : {}),
        ...(Array.isArray(o.clientCerts) ? { clientCerts: o.clientCerts.filter((c): c is NonNullable<NetworkSettings['clientCerts']>[number] => !!c && typeof c === 'object' && typeof (c as { host?: unknown }).host === 'string') } : {}),
    };
}

export interface PersonalSettings {
    /** Extra Azure DevOps Server hosts the user trusts (dev.azure.com and *.visualstudio.com always are). */
    trustedAdoHosts: string[];
    /** Name of the secret that holds the user's ADO personal access token. */
    adoPatSecret: string;
    /** How the Studio signs in to Azure DevOps: a PAT (default), or Entra ID (Azure CLI sign-in / service principal / managed identity). */
    adoAuth?: 'pat' | 'entra';
    /** Open the browser when the Studio starts. */
    openBrowser: boolean;
    /** Preferred port (a fixed port keeps bookmarks working); 0 = any free port. */
    port: number;
    /** Repositories whose program-running .git/config entries the user accepted (digest of them). */
    trustedRepoConfigs: string[];
    /** How the Studio reaches Azure DevOps: proxy and trusted certificates (off by default). */
    network: NetworkSettings;
    /** The Studio's MCP server (/mcp) for assistants outside the Studio: off until turned on. */
    mcpEnabled: boolean;
    /** The team's shared folder for load-test results (a network share or synced folder); none: results stay on this computer. */
    loadTeamFolder?: string;
}

export const DEFAULT_SETTINGS: PersonalSettings = { trustedAdoHosts: [], adoPatSecret: 'ADO_PAT', openBrowser: true, port: 4719, trustedRepoConfigs: [], network: { ...DEFAULT_NETWORK }, mcpEnabled: false };

export class SettingsStore {
    private readonly file: string;
    constructor(home: string) { this.file = path.join(home, 'settings.json'); }

    get(): PersonalSettings {
        try {
            const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            return {
                trustedAdoHosts: Array.isArray(d.trustedAdoHosts) ? d.trustedAdoHosts.filter((h: unknown) => typeof h === 'string' && HOST_RE.test(h)) : [],
                adoPatSecret: typeof d.adoPatSecret === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(d.adoPatSecret) ? d.adoPatSecret : DEFAULT_SETTINGS.adoPatSecret,
                ...(d.adoAuth === 'entra' ? { adoAuth: 'entra' as const } : {}),
                openBrowser: typeof d.openBrowser === 'boolean' ? d.openBrowser : DEFAULT_SETTINGS.openBrowser,
                port: Number.isInteger(d.port) && d.port >= 0 && d.port < 65536 ? d.port : DEFAULT_SETTINGS.port,
                network: readNetwork(d.network),
                mcpEnabled: d.mcpEnabled === true,
                ...(typeof d.loadTeamFolder === 'string' && d.loadTeamFolder.trim() ? { loadTeamFolder: d.loadTeamFolder.trim() } : {}),
                trustedRepoConfigs: Array.isArray(d.trustedRepoConfigs) ? d.trustedRepoConfigs.filter((h: unknown) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)).slice(-200) : [],
            };
        } catch { return { ...DEFAULT_SETTINGS }; }
    }

    update(patch: Partial<PersonalSettings>): PersonalSettings {
        const next = { ...this.get(), ...patch };
        if (!next.trustedAdoHosts.every((h) => HOST_RE.test(h))) throw new UserError('Trusted hosts must be plain host names such as tfs.mycompany.com.');
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(next.adoPatSecret)) throw new UserError('The token secret name uses capital letters, digits and _.');
        if (!Number.isInteger(next.port) || next.port < 0 || next.port > 65535) throw new UserError('Port must be between 0 and 65535.');
        if (patch.network) next.network = validateNetwork({ ...this.get().network, ...patch.network });
        if (next.loadTeamFolder !== undefined && (typeof next.loadTeamFolder !== 'string' || next.loadTeamFolder.length > 500 || /[\0\r\n]/.test(next.loadTeamFolder))) throw new UserError('The team results folder is a folder path.');
        if (next.loadTeamFolder === '') delete next.loadTeamFolder;
        ensurePrivateDir(path.dirname(this.file));
        writeFileAtomic(this.file, JSON.stringify(next, null, 2) + '\n');
        return next;
    }
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Hosts the Studio may send an ADO token to. */
export function isTrustedAdoHost(host: string, extra: string[]): boolean {
    const h = host.toLowerCase();
    return h === 'dev.azure.com' || h.endsWith('.visualstudio.com') || extra.map((x) => x.toLowerCase()).includes(h);
}
