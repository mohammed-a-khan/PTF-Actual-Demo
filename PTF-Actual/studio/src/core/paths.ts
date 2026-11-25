/**
 * Where the Studio keeps per-user data on this machine (never inside a repository).
 *   Windows: %LOCALAPPDATA%\CsTestStudio
 *   macOS:   ~/Library/Application Support/CsTestStudio
 *   Linux:   $XDG_DATA_HOME/cs-test-studio (default ~/.local/share/cs-test-studio)
 * CS_STUDIO_HOME overrides all of these (used by tests and portable installs).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function studioHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
    if (env.CS_STUDIO_HOME) return path.resolve(env.CS_STUDIO_HOME);
    const home = os.homedir();
    if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CsTestStudio');
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'CsTestStudio');
    return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'cs-test-studio');
}

/** Create a directory readable only by the current user (POSIX mode; on Windows the profile ACL applies). */
export function ensurePrivateDir(dir: string): string {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    return dir;
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600): void {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
}
