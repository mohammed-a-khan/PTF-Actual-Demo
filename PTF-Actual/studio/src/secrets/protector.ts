/**
 * Encrypts secret values at rest.
 *
 *  - Windows: DPAPI (CurrentUser scope) through the built-in PowerShell. The OS ties the key to the
 *    user's Windows login; nothing extra is stored. Same protection Git Credential Manager relies on.
 *  - Elsewhere (and as a fallback): AES-256-GCM with a random 32-byte key in a file only the user
 *    can read (mode 0600) inside the Studio's private data directory.
 *
 * Values are passed to PowerShell on stdin (never on the command line, which other processes can see).
 */
import { spawnSync } from 'child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensurePrivateDir, writeFileAtomic } from '../core/paths';

export interface Protector {
    readonly kind: 'dpapi' | 'aes-gcm-keyfile';
    protect(plain: Buffer): string;
    unprotect(sealed: string): Buffer;
    /** Decrypt many at once (DPAPI: one PowerShell launch instead of one per secret). */
    unprotectMany?(sealed: string[]): Buffer[];
}

export class KeyFileProtector implements Protector {
    readonly kind = 'aes-gcm-keyfile' as const;
    private key: Buffer | null = null;
    constructor(private readonly keyFile: string) {}

    private getKey(): Buffer {
        if (this.key) return this.key;
        if (fs.existsSync(this.keyFile)) {
            const k = fs.readFileSync(this.keyFile);
            if (k.length !== 32) throw new Error(`Secret key file is damaged: ${this.keyFile}`);
            this.key = k;
        } else {
            ensurePrivateDir(path.dirname(this.keyFile));
            const k = randomBytes(32);
            // 'wx' fails if another process created it first; then use theirs.
            try { fs.writeFileSync(this.keyFile, k, { mode: 0o600, flag: 'wx' }); this.key = k; }
            catch { this.key = fs.readFileSync(this.keyFile); }
        }
        return this.key!;
    }

    protect(plain: Buffer): string {
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', this.getKey(), iv);
        const ct = Buffer.concat([c.update(plain), c.final()]);
        return ['g1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
    }

    unprotect(sealed: string): Buffer {
        const [ver, iv, tag, ct] = sealed.split(':');
        if (ver !== 'g1' || !iv || !tag || ct === undefined) throw new Error('Unrecognised secret format.');
        const d = createDecipheriv('aes-256-gcm', this.getKey(), Buffer.from(iv, 'base64'));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
    }
}

/** Absolute path of a Windows system tool — never searched for in the current folder or repository. */
export function systemTool(name: 'powershell.exe' | 'taskkill.exe'): string {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return name === 'powershell.exe'
        ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : path.join(root, 'System32', 'taskkill.exe');
}

// Many values in one call: base64 inputs separated by newlines, outputs likewise.
const PS_MANY = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$lines = [Console]::In.ReadToEnd().Split([char]10) | Where-Object { $_.Trim() -ne '' }
$out = foreach ($l in $lines) {
  $b = [Convert]::FromBase64String($l.Trim())
  [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::%OP%($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
}
[Console]::Out.Write(($out -join [char]10))
`;

const PS_PROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($in)
$out = [System.Security.Cryptography.ProtectedData]::%OP%($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

export class DpapiProtector implements Protector {
    readonly kind = 'dpapi' as const;
    constructor(private readonly powershell = systemTool('powershell.exe')) {}

    private run(op: 'Protect' | 'Unprotect', b64: string): string {
        const r = spawnSync(this.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PROTECT.replace('%OP%', op)], {
            input: b64, encoding: 'utf8', windowsHide: true, timeout: 30_000, cwd: path.dirname(this.powershell),
        });
        if (r.error) throw new Error(`Windows data protection is not available: ${r.error.message}`);
        if (r.status !== 0) throw new Error(`Windows data protection failed: ${(r.stderr || '').trim().split('\n')[0]}`);
        return r.stdout.trim();
    }

    protect(plain: Buffer): string {
        return 'd1:' + this.run('Protect', plain.toString('base64'));
    }

    unprotect(sealed: string): Buffer {
        if (!sealed.startsWith('d1:')) throw new Error('Unrecognised secret format.');
        return Buffer.from(this.run('Unprotect', sealed.slice(3)), 'base64');
    }

    unprotectMany(sealed: string[]): Buffer[] {
        if (sealed.length === 0) return [];
        if (sealed.some((x) => !x.startsWith('d1:'))) throw new Error('Unrecognised secret format.');
        const r = spawnSync(this.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_MANY.replace('%OP%', 'Unprotect')], {
            input: sealed.map((x) => x.slice(3)).join('\n'), encoding: 'utf8', windowsHide: true, timeout: 60_000, cwd: path.dirname(this.powershell),
        });
        if (r.error) throw new Error(`Windows data protection is not available: ${r.error.message}`);
        if (r.status !== 0) throw new Error(`Windows data protection failed: ${(r.stderr || '').trim().split('\n')[0]}`);
        const outs = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
        if (outs.length !== sealed.length) throw new Error('Windows data protection returned an unexpected result.');
        return outs.map((o) => Buffer.from(o, 'base64'));
    }
}

/** DPAPI on Windows; key file elsewhere. CS_STUDIO_PROTECTOR=keyfile forces the key file. */
export function defaultProtector(home: string, env: NodeJS.ProcessEnv = process.env): Protector {
    if (process.platform === 'win32' && env.CS_STUDIO_PROTECTOR !== 'keyfile') return new DpapiProtector();
    return new KeyFileProtector(path.join(home, 'keys', 'secrets.key'));
}

export { writeFileAtomic };
