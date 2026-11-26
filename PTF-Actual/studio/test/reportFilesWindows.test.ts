/** Report files in sub-folders (videos/, screenshots/) are served when the path came from Windows (backslashes). */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { urlPathOf } from '../src/server/server';

test('urlPathOf: a Windows relative path becomes a URL path', () => {
    assert.equal(urlPathOf('videos\\page@8a19.webm', '\\'), 'videos/page@8a19.webm');
    assert.equal(urlPathOf('screenshots\\a b\\x.png', '\\'), 'screenshots/a b/x.png');
    assert.equal(urlPathOf('index.html', '\\'), 'index.html');
    assert.equal(urlPathOf('videos/page.webm', '/'), 'videos/page.webm');
});

test('the static file server refuses a backslash path (the Windows "Forbidden") and serves the URL form', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rep-win-'));
    fs.mkdirSync(path.join(root, 'videos'));
    fs.writeFileSync(path.join(root, 'videos', 'page@8a19.webm'), 'webm-bytes');
    const app = Fastify();
    await app.register(fastifyStatic, { root, serve: false });
    app.get('/raw', (_req, reply) => reply.sendFile('videos\\page@8a19.webm', root));
    app.get('/fixed', (_req, reply) => reply.sendFile(urlPathOf('videos\\page@8a19.webm', '\\'), root));
    try {
        assert.equal((await app.inject('/raw')).statusCode, 403, 'what happened on Windows before the fix');
        const ok = await app.inject('/fixed');
        assert.equal(ok.statusCode, 200);
        assert.equal(ok.body, 'webm-bytes');
    } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
