/**
 * Settings in a repository's own .git/config that make Git run a program: a filter, a diff
 * textconv, an ssh command, a hooks folder, an fsmonitor… `git clone` never copies .git/config,
 * so these were set on this computer — by you or a tool you ran (git lfs install --local) — or the
 * folder was copied from someone else (a zip, a shared drive). The Studio runs Git constantly in the
 * background, so on first open of such a repository it lists them and asks before starting.
 */
import { createHash } from 'crypto';
import { runGit } from './run';

const RUNS_PROGRAM = [
    /^core\.(fsmonitor|sshcommand|askpass|gitproxy|hookspath|editor|pager)$/,
    /^(diff|merge)\.[^.]+\.(textconv|command|driver)$/,
    /^diff\.external$/,
    /^(mergetool|difftool)\.[^.]+\.(cmd|path)$/,
    /^filter\.[^.]+\.(clean|smudge|process)$/,
    /^credential(\..+)?\.helper$/,
    /^(gpg(\.[^.]+)?\.program|sequence\.editor|uploadpack\.packobjectshook|alias\..+)$/,
];

export interface RepoConfigEntry { key: string; value: string }

/** Entries of the repository-local config (.git/config only) that run programs. */
export async function programsInRepoConfig(repoRoot: string): Promise<RepoConfigEntry[]> {
    const r = await runGit(['config', '--local', '--null', '--list'], { cwd: repoRoot, allowFailure: true });
    if (r.code !== 0) return [];
    const out: RepoConfigEntry[] = [];
    for (const item of r.stdout.split('\0').filter(Boolean)) {
        const nl = item.indexOf('\n');
        const key = (nl < 0 ? item : item.slice(0, nl)).toLowerCase();
        const value = nl < 0 ? '' : item.slice(nl + 1);
        if (key === 'core.fsmonitor' && /^(false|true|0|1|no|yes|off|on)?$/i.test(value)) continue; // built-in / off
        if (key.startsWith('alias.') && !value.startsWith('!')) continue; // only shell aliases run programs
        if (RUNS_PROGRAM.some((re) => re.test(key))) out.push({ key, value });
    }
    return out;
}

/** Fingerprint of the entries the user accepted (a change asks again). */
export function entriesDigest(repoRoot: string, entries: RepoConfigEntry[]): string {
    return createHash('sha256').update(repoRoot + '\0' + entries.map((e) => `${e.key}=${e.value}`).sort().join('\0')).digest('hex');
}
