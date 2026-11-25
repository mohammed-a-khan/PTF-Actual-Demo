/**
 * Minimal, defensive ZIP reader (no third-party library): reads the central directory and extracts
 * stored (0) and deflated (8) entries with Node's zlib. Used for pipeline artifacts (test reports).
 *
 * Safety: paths are checked to stay inside the target folder ("zip slip"); absolute paths, "..",
 * drive letters and NUL are refused; symbolic links are not created; total size, entry count and
 * compression ratio are limited (zip bombs); CRC-32 of every file is verified.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { UserError } from './errors';

export interface ZipLimits { maxEntries: number; maxTotalBytes: number; maxEntryBytes: number; maxRatio: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 20_000, maxTotalBytes: 2 * 1024 ** 3, maxEntryBytes: 1024 ** 3, maxRatio: 200 };

export interface ZipEntry { name: string; compressedSize: number; size: number; method: number; offset: number; crc: number; isDir: boolean; isSymlink: boolean }

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
export function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Entries from the central directory (ZIP64 sizes/offsets supported). */
export function listZip(buf: Buffer): ZipEntry[] {
    // End of central directory: last 22..(22+65535) bytes.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new UserError('Not a ZIP file.');
    let count = buf.readUInt16LE(eocd + 10);
    let cdOffset = buf.readUInt32LE(eocd + 16);
    // ZIP64 end of central directory locator, just before the EOCD.
    if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
        const z64 = Number(buf.readBigUInt64LE(eocd - 20 + 8));
        if (buf.readUInt32LE(z64) !== 0x06064b50) throw new UserError('Damaged ZIP64 directory.');
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
    const out: ZipEntry[] = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new UserError('Damaged ZIP directory.');
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        let compressedSize = buf.readUInt32LE(p + 20);
        let size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
        const madeBy = buf.readUInt16LE(p + 4) >> 8;
        const extAttr = buf.readUInt32LE(p + 38);
        let offset = buf.readUInt32LE(p + 42);
        const flags = buf.readUInt16LE(p + 8);
        const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
        const name = (flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1'));
        // ZIP64 extra field (id 1): the 0xffffffff values, in order.
        let e = p + 46 + nameLen;
        const eEnd = e + extraLen;
        while (e + 4 <= eEnd) {
            const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
            if (id === 1) {
                let q = e + 4;
                if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
                if (compressedSize === 0xffffffff) { compressedSize = Number(buf.readBigUInt64LE(q)); q += 8; }
                if (offset === 0xffffffff) { offset = Number(buf.readBigUInt64LE(q)); }
            }
            e += 4 + len;
        }
        const unixMode = madeBy === 3 ? (extAttr >>> 16) & 0xffff : 0;
        out.push({ name, compressedSize, size, method, offset, crc, isDir: name.endsWith('/'), isSymlink: (unixMode & 0o170000) === 0o120000 });
        p = eEnd + commentLen;
    }
    return out;
}

/** Safe relative path for an entry, or null to skip it (never throws on a hostile name: skips). */
export function safeEntryPath(name: string): string | null {
    if (!name || name.includes('\0')) return null;
    const n = name.replace(/\\/g, '/');
    if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
    const parts = n.split('/').filter((s) => s !== '' && s !== '.');
    if (!parts.length || parts.some((s) => s === '..' || /[<>:"|?*]/.test(s) || /[. ]$/.test(s))) return null;
    return parts.join('/');
}

/** Extract every safe entry under `dir`. Returns the files written (relative paths). */
export function extractZip(buf: Buffer, dir: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): { files: string[]; skipped: string[] } {
    const entries = listZip(buf);
    if (entries.length > limits.maxEntries) throw new UserError(`The archive has too many entries (${entries.length}).`);
    const root = path.resolve(dir);
    fs.mkdirSync(root, { recursive: true });
    const files: string[] = [], skipped: string[] = [];
    let total = 0;
    for (const en of entries) {
        const rel = safeEntryPath(en.name);
        if (!rel || en.isSymlink) { skipped.push(en.name); continue; }
        const target = path.resolve(root, rel);
        const r = path.relative(root, target);
        if (!r || r.startsWith('..') || path.isAbsolute(r)) { skipped.push(en.name); continue; }
        if (en.isDir) { fs.mkdirSync(target, { recursive: true }); continue; }
        if (en.size > limits.maxEntryBytes) throw new UserError(`${rel} is too large to extract.`);
        if (en.compressedSize > 0 && en.size / en.compressedSize > limits.maxRatio && en.size > 10 * 1024 * 1024) throw new UserError(`${rel} expands suspiciously (possible zip bomb).`);
        total += en.size;
        if (total > limits.maxTotalBytes) throw new UserError('The archive is too large to extract.');
        // Local header: its own name/extra lengths decide where the data starts.
        const lh = en.offset;
        if (buf.readUInt32LE(lh) !== 0x04034b50) throw new UserError(`Damaged ZIP entry ${rel}.`);
        const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
        const raw = buf.subarray(start, start + en.compressedSize);
        let data: Buffer;
        if (en.method === 0) data = Buffer.from(raw);
        else if (en.method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, en.size) + 1 });
        else { skipped.push(en.name); continue; }
        if (data.length !== en.size) throw new UserError(`Damaged ZIP entry ${rel} (size).`);
        if (crc32(data) !== en.crc) throw new UserError(`Damaged ZIP entry ${rel} (checksum).`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Never write through an existing link.
        try { if (fs.lstatSync(target).isSymbolicLink()) { skipped.push(en.name); continue; } } catch { /* new file */ }
        fs.writeFileSync(target, data);
        files.push(rel);
    }
    return { files, skipped };
}
