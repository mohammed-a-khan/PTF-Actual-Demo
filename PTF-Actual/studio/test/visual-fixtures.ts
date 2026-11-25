/** Test fixtures: PNG files and a visual folder as the framework leaves it. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/** A tiny RGBA PNG of one colour (like a screenshot file). */
export function png(w: number, h: number, rgb: [number, number, number]): Buffer {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type: string, body: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = 255; }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** A visual folder as the framework leaves it: baseline/, actual/, diff/ (smart-result.json, diff.png). */
export function visualFixture(root: string, dir: string, name: string, o: { baseline: Buffer; actual?: Buffer; result?: Record<string, unknown> }): void {
    const d = path.join(root, dir);
    for (const s of ['baseline', 'actual', 'diff']) fs.mkdirSync(path.join(d, s), { recursive: true });
    fs.writeFileSync(path.join(d, 'baseline', `${name}.png`), o.baseline);
    fs.writeFileSync(path.join(d, 'baseline', `${name}.pixel-hash`), sha(o.baseline));
    fs.writeFileSync(path.join(d, 'baseline', `${name}.structural.json`), '{"v":"old"}');
    if (o.actual) {
        fs.writeFileSync(path.join(d, 'actual', `${name}.png`), o.actual);
        fs.writeFileSync(path.join(d, 'actual', `${name}.structural.json`), '{"v":"new"}');
        if (sha(o.actual) !== sha(o.baseline)) fs.writeFileSync(path.join(d, 'diff', `${name}.diff.png`), o.actual);
    }
    if (o.result) fs.writeFileSync(path.join(d, 'diff', `${name}.smart-result.json`), JSON.stringify(o.result));
}
