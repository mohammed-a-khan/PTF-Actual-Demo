/**
 * Sign-in types in collection files: export → import gives the same auth; in Postman's runner (Newman) the exported
 * requests are signed exactly as the Studio signs them (a server verifies each signature).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { exportReport } from '../src/api/collectionExport';
import { importCollection } from '../src/api/collectionImport';
import { ApiAuth, ApiRequest, newCollection, newRequest, allRequests } from '../src/api/model';
import { edgegridHeader, hawkHeader, oauth1Header } from '../src/api/moreAuth';
import { sigv4 } from '../src/api/httpAuth';

const AUTHS: Array<[string, ApiAuth]> = [
    ['aws', { type: 'aws', accessKey: 'AKIDEXAMPLE', secretKey: 'aws-secret-1', region: 'eu-west-1', service: 'execute-api' }],
    ['oauth1', { type: 'oauth1', consumerKey: 'ck', consumerSecret: 'cs-1', token: 'tk', tokenSecret: 'ts-1', signatureMethod: 'HMAC-SHA1' }],
    ['hawk', { type: 'hawk', hawkId: 'hawk-id', hawkKey: 'hawk-key-1', algorithm: 'sha256' }],
    ['edgegrid', { type: 'edgegrid', clientToken: 'ct-1', clientSecret: 'eg-secret', accessToken: 'at-1' }],
    ['jwt', { type: 'jwt', algorithm: 'HS256', secret: 'jwt-secret-1', payload: '{"sub":"qa-user","role":"tester"}' }],
];

/** Verifies each scheme with the same keys, from what the request itself carries (its nonce, time). */
function verifier() {
    return http.createServer((q, r) => {
        let body = ''; q.on('data', (c) => (body += c));
        q.on('end', () => {
            const kind = (q.url!.split('/')[2] ?? '').split('?')[0];
            const a = String(q.headers.authorization ?? '');
            const url = `http://${q.headers.host}${q.url}`;
            const attr = (n: string) => new RegExp(`${n}="([^"]*)"`).exec(a)?.[1] ?? '';
            let valid = false;
            try {
                if (kind === 'aws') {
                    const d = String(q.headers['x-amz-date']);
                    const again = sigv4({ method: q.method!, url, headers: { 'X-Amz-Date': d }, body, accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'aws-secret-1', region: 'eu-west-1', service: 'execute-api', date: new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`) });
                    // Same key, scope and signature over the same request (signed header lists may differ by client).
                    const sig = (x: string) => /Signature=([0-9a-f]+)/.exec(x)?.[1];
                    const signed = /SignedHeaders=([^,]+)/.exec(a)?.[1] ?? '';
                    const hdrs: Record<string, string> = {};
                    for (const h of signed.split(';')) if (h !== 'host') hdrs[h] = String(q.headers[h] ?? '');
                    const exact = sigv4({ method: q.method!, url, headers: hdrs, body, accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'aws-secret-1', region: 'eu-west-1', service: 'execute-api', date: new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`) });
                    valid = sig(a) === sig(exact.Authorization) || sig(a) === sig(again.Authorization);
                } else if (kind === 'oauth1') {
                    valid = decodeURIComponent(attr('oauth_signature')) === decodeURIComponent(/oauth_signature="([^"]*)"/.exec(oauth1Header({ method: q.method!, url, consumerKey: 'ck', consumerSecret: 'cs-1', token: 'tk', tokenSecret: 'ts-1', nonce: decodeURIComponent(attr('oauth_nonce')), timestamp: attr('oauth_timestamp') }))![1]);
                } else if (kind === 'hawk') {
                    valid = attr('mac') === /mac="([^"]*)"/.exec(hawkHeader({ method: q.method!, url, id: 'hawk-id', key: 'hawk-key-1', ts: Number(attr('ts')), nonce: attr('nonce'), ext: attr('ext') || undefined }))![1];
                } else if (kind === 'edgegrid') {
                    const f = Object.fromEntries(a.replace(/^EG1-HMAC-SHA256 /, '').split(';').filter(Boolean).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
                    valid = a === edgegridHeader({ method: q.method!, url, clientToken: 'ct-1', clientSecret: 'eg-secret', accessToken: 'at-1', timestamp: f.timestamp, nonce: f.nonce, body });
                } else if (kind === 'jwt') {
                    const [h, c, s] = a.replace(/^Bearer /, '').split('.');
                    valid = crypto.createHmac('sha256', 'jwt-secret-1').update(`${h}.${c}`).digest('base64url') === s && JSON.parse(Buffer.from(c, 'base64url').toString()).role === 'tester';
                }
            } catch { valid = false; }
            r.writeHead(200, { 'Content-Type': 'application/json' });
            r.end(JSON.stringify({ valid, kind, auth: a.slice(0, 40) }));
        });
    });
}

test('sign-in types: export → import keeps them; Newman signs the exported requests the way the Studio does', async () => {
    const s = verifier();
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-exp-auth-'));
    try {
        const c = newCollection('Signed');
        c.baseUrl = `http://127.0.0.1:${port}`;
        for (const [kind, auth] of AUTHS) {
            const r: ApiRequest = { ...newRequest(`Signed ${kind}`, kind), url: `/signed/${kind}?b=2&a=1`, auth, checks: [
                { kind: 'status', value: '200' },
                { kind: 'rule', source: 'json', target: '$.valid', op: 'equals', expected: { from: 'text', value: 'true' } } as never,
            ], extract: [] };
            c.items.push(r);
        }
        c.items.push({ ...newRequest('Kerberos', 'kerberos'), url: '/x', auth: { type: 'negotiate' } });
        const { collection: out, warnings } = exportReport(c, {});
        assert.deepEqual(warnings, ['"Kerberos": Kerberos (Negotiate) sign-in has no equivalent in this format: the request is exported without it.']);
        const back = allRequests(importCollection(JSON.parse(JSON.stringify(out))).collection.items).map((x) => x.request);
        for (const [i, [, auth]] of AUTHS.entries()) assert.deepEqual(back[i].auth, auth, `${auth.type} round trip`);

        if (process.env.CS_EXPORT_KEEP) fs.writeFileSync(process.env.CS_EXPORT_KEEP, JSON.stringify(out));
        const newman = process.env.CS_NEWMAN;
        if (!newman || !fs.existsSync(newman)) return;
        const file = path.join(dir, 'c.json'), report = path.join(dir, 'r.json');
        fs.writeFileSync(file, JSON.stringify(out));
        await new Promise<void>((res) => execFile(newman, ['run', file, '-r', 'json', '--reporter-json-export', report, '--timeout-request', '5000'], () => res()));
        const run = JSON.parse(fs.readFileSync(report, 'utf8')).run;
        const verdicts = Object.fromEntries(run.executions.map((e: { item: { name: string }; assertions?: Array<{ error?: unknown }> }) => [e.item.name, (e.assertions ?? []).every((a) => !a.error)]));
        for (const [kind] of AUTHS) assert.equal(verdicts[`Signed ${kind}`], true, `Postman's ${kind} signature was not accepted: ${JSON.stringify(run.executions.find((e: { item: { name: string } }) => e.item.name === `Signed ${kind}`)?.response?.stream ? Buffer.from(run.executions.find((e: { item: { name: string } }) => e.item.name === `Signed ${kind}`).response.stream.data).toString() : '')}`);
    } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
