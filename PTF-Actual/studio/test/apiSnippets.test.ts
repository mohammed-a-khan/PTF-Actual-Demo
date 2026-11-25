/**
 * Code snippets run as they are written: cURL, Python requests, JavaScript fetch, Node.js, Java, Go, PHP and Ruby
 * (those installed here) send the same request (method, path, headers, body with quotes, line breaks and $) to an
 * echo server; the others are checked for their shape.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { snippet, SnippetLang, SNIPPET_LANGS } from '../src/api/snippets';

const has = (cmd: string) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'pipe' }); return true; } catch { return false; } };
const run = (cmd: string, args: string[], cwd: string) => new Promise<string>((res, rej) => execFile(cmd, args, { cwd, timeout: 120_000, env: { ...process.env, GOFLAGS: '-mod=mod', GOCACHE: path.join(os.tmpdir(), 'cs-go-cache') } }, (e, o, er) => (e ? rej(new Error(`${cmd}: ${e.message}\n${er}`)) : res(o))));

test('snippets send the same request as the Studio', { timeout: 300_000 }, async () => {
    const got: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    const s = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { got.push({ method: q.method!, url: q.url!, headers: q.headers, body: b }); r.writeHead(201, { 'Content-Type': 'application/json' }); r.end('{"ok":true}'); }); });
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-snip-'));
    const body = '{\n  "note": "it\'s a \\"quote\\" & $HOME `tick` 100%",\n  "n": 1\n}';
    const req = { method: 'PATCH', url: `http://127.0.0.1:${port}/orders/7?expand=lines&q=a%20b`, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t0k$en', 'X-Note': "it's \"x\"", 'Content-Length': '99' }, body };
    const check = (lang: string) => {
        const g = got.shift();
        assert.ok(g, `${lang}: no request arrived`);
        assert.equal(g.method, 'PATCH', lang);
        assert.equal(g.url, '/orders/7?expand=lines&q=a%20b', lang);
        assert.equal(g.headers.authorization, 'Bearer t0k$en', lang);
        assert.equal(g.headers['x-note'], "it's \"x\"", lang);
        assert.match(String(g.headers['content-type']), /^application\/json/, lang);
        assert.equal(g.body, body, `${lang}: the body unchanged`);
    };
    try {
        const ran: string[] = [];
        const write = (f: string, text: string) => { fs.writeFileSync(path.join(dir, f), text); return path.join(dir, f); };
        if (has('curl')) { await run('sh', [write('a.sh', snippet('curl', req))], dir); check('curl'); ran.push('curl'); }
        if (has('python3')) { try { execFileSync('python3', ['-c', 'import requests']); await run('python3', [write('a.py', snippet('python', req))], dir); check('python'); ran.push('python'); } catch (e) { if (!/No module named/.test(String(e))) throw e; } }
        await run(process.execPath, [write('a.mjs', snippet('fetch', req))], dir); check('fetch'); ran.push('fetch');
        await run(process.execPath, [write('b.cjs', snippet('node', req))], dir); check('node'); ran.push('node');
        if (has('java')) { await run('java', [write('Main.java', snippet('java', req))], dir); check('java'); ran.push('java'); }
        if (has('go')) { const d = path.join(dir, 'g'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'main.go'), snippet('go', req)); await run('go', ['run', 'main.go'], d); check('go'); ran.push('go'); }
        if (has('php') && execFileSync('php', ['-m']).toString().includes('curl')) { await run('php', [write('a.php', snippet('php', req))], dir); check('php'); ran.push('php'); }
        if (has('ruby')) { await run('ruby', [write('a.rb', snippet('ruby', req))], dir); check('ruby'); ran.push('ruby'); }
        assert.ok(ran.length >= 4, `ran: ${ran.join(', ')}`);
        if (process.env.CS_SNIPPETS_LOG) console.log(`snippets ran: ${ran.join(', ')}`);
        // Every language writes something that names the URL; headers the client sets itself are left out.
        for (const l of SNIPPET_LANGS) {
            const t = snippet(l.id as SnippetLang, req);
            assert.ok(t.includes('/orders/7'), l.id);
            assert.ok(!/Content-Length/i.test(t), `${l.id} leaves Content-Length to the client`);
        }
        assert.match(snippet('curl', { ...req, body: Buffer.from([1, 2, 3]) }), /^# A 3-byte body \(a file upload\) is not written here/);
    } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
