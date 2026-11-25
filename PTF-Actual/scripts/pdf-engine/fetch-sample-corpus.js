#!/usr/bin/env node
/**
 * Fetch the reference PDFs (all producers, features, languages — see test/pdf/corpus/README.md)
 * listed in test/pdf/corpus/manifest.csv from the public SafeDocs corpus
 * (CC-MAIN-2021-31-PDF-UNTRUNCATED, https://digitalcorpora.org/cc-main-2021-31-pdf-untruncated/).
 *
 * Each PDF lives inside a 1-3 GB zip on S3. Instead of downloading whole zips we read the zip's
 * central directory and then only the one member we need, using HTTP Range requests.
 *
 * Node built-ins only (https, zlib, fs, crypto). Downloaded PDFs are untrusted data: they are
 * written to disk and hash-checked, never executed.
 *
 * Usage:
 *   node scripts/pdf-engine/fetch-sample-corpus.js [--manifest test/pdf/corpus/manifest.csv]
 *        [--out test/pdf/corpus/files] [--group SSRS|Crystal|...] [--limit N] [--concurrency 6]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const BASE = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/CC-MAIN-2021-31-PDF-UNTRUNCATED/zipfiles';

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : def;
}

const root = path.resolve(__dirname, '..', '..');
const manifestPath = path.resolve(root, arg('manifest', 'test/pdf/corpus/manifest.csv'));
const outDir = path.resolve(root, arg('out', 'test/pdf/corpus/files'));
const groupFilter = arg('group', null);
const limit = Number(arg('limit', '0')) || Infinity;
const concurrency = Number(arg('concurrency', '6'));

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes). */
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') q = false;
            else field += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const [header, ...body] = rows.filter((r) => r.length > 1);
    return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function request(url, { method = 'GET', range } = {}, attempt = 1) {
    return new Promise((resolve, reject) => {
        const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
        const req = https.request(url, { method, headers, timeout: 120000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(request(res.headers.location, { method, range }, attempt));
            }
            if (res.statusCode !== 200 && res.statusCode !== 206) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    }).catch(async (err) => {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        return request(url, { method, range }, attempt + 1);
    });
}

function zipUrl(fileName) {
    const z = Math.floor(Number(fileName.slice(0, 7)) / 1000);
    const lo = Math.floor(z / 1000) * 1000;
    const pad = (n) => String(n).padStart(4, '0');
    return `${BASE}/${pad(lo)}-${pad(lo + 999)}/${pad(z)}.zip`;
}

const u64 = (b, o) => Number(b.readBigUInt64LE(o));

async function readCentralDirectory(url) {
    const total = Number((await request(url, { method: 'HEAD' })).headers['content-length']);
    const tailLen = Math.min(total, 70000);
    const tail = (await request(url, { range: [total - tailLen, total - 1] })).body;
    const eocd = tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
    if (eocd < 0) throw new Error('zip end-of-central-directory not found');
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff) {
        const loc = tail.lastIndexOf(Buffer.from('PK\x06\x07', 'latin1'));
        const z64 = u64(tail, loc + 8);
        const rec = (await request(url, { range: [z64, z64 + 55] })).body;
        cdSize = u64(rec, 40);
        cdOff = u64(rec, 48);
    }
    const cd = (await request(url, { range: [cdOff, cdOff + cdSize - 1] })).body;
    const entries = new Map();
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
        const method = cd.readUInt16LE(p + 10);
        let csize = cd.readUInt32LE(p + 20);
        let usize = cd.readUInt32LE(p + 24);
        const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
        let loff = cd.readUInt32LE(p + 42);
        const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
        const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
        for (let q = 0; q + 4 <= extra.length;) {
            const id = extra.readUInt16LE(q), len = extra.readUInt16LE(q + 2);
            if (id === 1) {
                let k = q + 4;
                if (usize === 0xffffffff) { usize = u64(extra, k); k += 8; }
                if (csize === 0xffffffff) { csize = u64(extra, k); k += 8; }
                if (loff === 0xffffffff) { loff = u64(extra, k); k += 8; }
            }
            q += 4 + len;
        }
        entries.set(path.basename(name), { method, csize, usize, loff });
        p += 46 + nlen + xlen + clen;
    }
    return entries;
}

async function extractMember(url, e) {
    const hdr = (await request(url, { range: [e.loff, e.loff + 29] })).body;
    const start = e.loff + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28);
    const data = e.csize ? (await request(url, { range: [start, start + e.csize - 1] })).body : Buffer.alloc(0);
    if (e.method === 0) return data;
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${e.method}`);
}

async function main() {
    let rows = parseCsv(fs.readFileSync(manifestPath, 'utf8'));
    if (groupFilter) rows = rows.filter((r) => r.group === groupFilter);
    rows = rows.slice(0, limit);
    fs.mkdirSync(outDir, { recursive: true });

    const byZip = new Map();
    for (const r of rows) {
        if (fs.existsSync(path.join(outDir, r.file_name))) continue;
        const u = zipUrl(r.file_name);
        if (!byZip.has(u)) byZip.set(u, []);
        byZip.get(u).push(r);
    }
    const jobs = [...byZip.entries()];
    let ok = 0, failed = 0;
    console.log(`${rows.length} in manifest selection, ${rows.length - jobs.flatMap((j) => j[1]).length} already present, fetching from ${jobs.length} zips…`);

    async function worker() {
        while (jobs.length) {
            const [url, members] = jobs.shift();
            try {
                const cd = await readCentralDirectory(url);
                for (const r of members) {
                    const entry = cd.get(r.file_name);
                    if (!entry) throw new Error(`${r.file_name} not in ${url}`);
                    const data = await extractMember(url, entry);
                    const sha = crypto.createHash('sha256').update(data).digest('hex');
                    if (r.sha256 && sha !== r.sha256) throw new Error(`${r.file_name} sha256 mismatch`);
                    fs.writeFileSync(path.join(outDir, r.file_name), data);
                    ok++;
                    console.log(`ok  ${r.file_name}  ${data.length} bytes  [${r.category} / ${r.group}]`);
                }
            } catch (err) {
                failed += members.length;
                console.error(`ERR ${members.map((m) => m.file_name).join(',')}: ${err.message}`);
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(`done: ${ok} fetched, ${failed} failed → ${outDir}`);
    if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
