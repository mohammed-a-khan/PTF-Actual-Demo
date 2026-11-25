/**
 * Git's own network settings (the Studio runs the installed Git, so Fetch/Pull/Push use these):
 * http.proxy, http.sslBackend (Windows: "schannel" = the Windows certificate store, where IT
 * installs a company root), http.sslCAInfo (a PEM file) and http.sslVerify.
 *
 * Changes are made to the user's GLOBAL Git configuration, one `git config --global` command each,
 * shown to the user before they are applied. Turning certificate checks off is never offered; if it
 * is already off, the Studio says so and offers to turn it back on.
 */
import * as fs from 'fs';
import { runGit } from './run';
import { UserError } from '../core/errors';

export const GIT_NET_KEYS = ['http.proxy', 'https.proxy', 'http.sslBackend', 'http.sslCAInfo', 'http.sslVerify'] as const;
export type GitNetKey = typeof GIT_NET_KEYS[number];

export interface GitNetworkState {
    global: Partial<Record<GitNetKey, string>>;
    /** Value Git actually uses in this repository and where it comes from (global, repository, system…). */
    effective: Partial<Record<GitNetKey, { value: string; origin: string }>>;
    environment: { HTTPS_PROXY?: string; HTTP_PROXY?: string; NO_PROXY?: string; GIT_SSL_NO_VERIFY?: string };
    platform: NodeJS.Platform;
    gitVersion: string;
}

/** The address as configured, with any user name/password replaced by *** (unchanged otherwise). */
const noCreds = (v: string) => { try { const u = new URL(v); if (!u.username && !u.password) return v; u.username = u.username ? '***' : ''; u.password = u.password ? '***' : ''; return u.href; } catch { return v; } };

export async function gitNetworkState(repo: string, env: NodeJS.ProcessEnv = process.env): Promise<GitNetworkState> {
    const global: GitNetworkState['global'] = {};
    const effective: GitNetworkState['effective'] = {};
    for (const k of GIT_NET_KEYS) {
        const g = await runGit(['config', '--global', '--get', k], { cwd: repo, allowFailure: true });
        if (g.code === 0) global[k] = k.endsWith('proxy') ? noCreds(g.stdout.trim()) : g.stdout.trim();
        const e = await runGit(['config', '--show-origin', '--get', k], { cwd: repo, allowFailure: true });
        if (e.code === 0) {
            const m = /^(\S+)\t(.*)$/.exec(e.stdout.trim());
            if (m) effective[k] = { origin: m[1].replace(/^file:/, ''), value: k.endsWith('proxy') ? noCreds(m[2]) : m[2] };
        }
    }
    const v = await runGit(['--version'], { cwd: repo, allowFailure: true });
    const pick = (a: string) => env[a] ?? env[a.toLowerCase()];
    return {
        global, effective, platform: process.platform, gitVersion: v.stdout.trim().replace(/^git version /, ''),
        environment: {
            ...(pick('HTTPS_PROXY') ? { HTTPS_PROXY: noCreds(pick('HTTPS_PROXY')!) } : {}),
            ...(pick('HTTP_PROXY') ? { HTTP_PROXY: noCreds(pick('HTTP_PROXY')!) } : {}),
            ...(pick('NO_PROXY') ? { NO_PROXY: pick('NO_PROXY') } : {}),
            ...(env.GIT_SSL_NO_VERIFY ? { GIT_SSL_NO_VERIFY: env.GIT_SSL_NO_VERIFY } : {}),
        },
    };
}

export interface GitNetworkChange { proxy?: string | null; sslBackend?: 'schannel' | 'openssl' | null; sslCAInfo?: string | null; restoreSslVerify?: boolean }

/** The exact commands a change runs (shown to the user first). Validates the values. */
export function gitNetworkCommands(c: GitNetworkChange): string[][] {
    const cmds: string[][] = [];
    if (c.proxy !== undefined) {
        if (c.proxy === null || c.proxy === '') cmds.push(['config', '--global', '--unset-all', 'http.proxy']);
        else {
            let u: URL;
            try { u = new URL(c.proxy); } catch { throw new UserError('Proxy address must look like http://proxy.company.com:8080'); }
            if (!/^(https?|socks5h?):$/.test(u.protocol)) throw new UserError('Git proxy addresses start with http://, https:// or socks5://');
            if (u.password) throw new UserError('Do not put the proxy password in the address: Git stores it in plain text in .gitconfig. Leave it out; Git (Git Credential Manager) asks for the proxy login when needed.');
            cmds.push(['config', '--global', 'http.proxy', c.proxy.trim()]);
        }
    }
    if (c.sslBackend !== undefined) {
        if (c.sslBackend === null) cmds.push(['config', '--global', '--unset-all', 'http.sslBackend']);
        else if (c.sslBackend === 'schannel' || c.sslBackend === 'openssl') {
            if (c.sslBackend === 'schannel' && process.platform !== 'win32') throw new UserError('"schannel" (the Windows certificate store) is only available in Git for Windows.');
            cmds.push(['config', '--global', 'http.sslBackend', c.sslBackend]);
        } else throw new UserError('Unknown SSL backend.');
    }
    if (c.sslCAInfo !== undefined) {
        if (c.sslCAInfo === null || c.sslCAInfo === '') cmds.push(['config', '--global', '--unset-all', 'http.sslCAInfo']);
        else {
            const f = c.sslCAInfo.trim();
            if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new UserError(`The certificate file ${f} does not exist.`);
            if (!/-----BEGIN CERTIFICATE-----/.test(fs.readFileSync(f, 'utf8').slice(0, 2 * 1024 * 1024))) throw new UserError('That file has no PEM certificate (-----BEGIN CERTIFICATE-----).');
            cmds.push(['config', '--global', 'http.sslCAInfo', f]);
        }
    }
    if (c.restoreSslVerify) cmds.push(['config', '--global', '--unset-all', 'http.sslVerify']);
    return cmds;
}

export async function applyGitNetwork(repo: string, c: GitNetworkChange): Promise<string[]> {
    const cmds = gitNetworkCommands(c);
    for (const a of cmds) {
        const r = await runGit(a, { cwd: repo, allowFailure: true });
        // --unset-all on a key that is not set exits 5: nothing to do.
        if (r.code !== 0 && !(a.includes('--unset-all') && r.code === 5)) throw new UserError(`git ${a.join(' ')} failed: ${r.stderr.trim()}`);
    }
    return cmds.map((a) => `git ${a.join(' ')}`);
}

export interface GitConnectionCheck { ok: boolean; stage: 'proxy' | 'certificate' | 'dns' | 'connect' | 'auth' | 'remote' | 'ok'; message: string; remote?: string; detail?: string }

/** `git ls-remote` to the remote (no changes), explained. */
export async function checkGitConnection(repo: string, remote = 'origin'): Promise<GitConnectionCheck> {
    const url = await runGit(['remote', 'get-url', remote], { cwd: repo, allowFailure: true });
    if (url.code !== 0) return { ok: false, stage: 'remote', message: `This repository has no remote "${remote}".` };
    const shown = noCreds(url.stdout.trim());
    const r = await runGit(['ls-remote', '--heads', remote], { cwd: repo, allowFailure: true, timeoutMs: 45_000 });
    const err = r.stderr.trim();
    if (r.code === 0) return { ok: true, stage: 'ok', remote: shown, message: `Git reached ${shown}.` };
    const tail = err.split('\n').filter(Boolean).slice(-3).join('\n');
    if (/SSL certificate problem|certificate verify failed|unable to get local issuer|self.signed certificate/i.test(err)) {
        return { ok: false, stage: 'certificate', remote: shown, detail: tail, message: process.platform === 'win32'
            ? 'Git does not trust the certificate (company HTTPS inspection). Use the Windows certificate store: set "SSL backend" to schannel.'
            : 'Git does not trust the certificate (company HTTPS inspection). Set "Certificate file" (http.sslCAInfo) to the company root certificate.' };
    }
    if (/407|Proxy Authentication Required/i.test(err)) return { ok: false, stage: 'proxy', remote: shown, detail: tail, message: 'The proxy asks for a login (407). Git Credential Manager can store it, or ask IT which login the proxy expects.' };
    if (/Could not resolve proxy|Failed to connect to .* port .*(proxy)?|Connection refused|Connection timed out/i.test(err)) {
        return { ok: false, stage: /proxy/i.test(err) ? 'proxy' : 'connect', remote: shown, detail: tail, message: /proxy/i.test(err) ? 'Git could not reach the proxy. Check the proxy address and port.' : 'Git could not connect. On a company network, set the proxy.' };
    }
    if (/Could not resolve host/i.test(err)) return { ok: false, stage: 'dns', remote: shown, detail: tail, message: 'Git could not find the server (DNS). On a company network you may need the proxy.' };
    if (/Authentication failed|could not read Username|403|401/i.test(err)) return { ok: false, stage: 'auth', remote: shown, detail: tail, message: 'The network works, but the server refused the login. Sign in with Git Credential Manager (run a fetch in a terminal once) or update your token.' };
    return { ok: false, stage: 'connect', remote: shown, detail: tail, message: 'Git could not reach the remote.' };
}
