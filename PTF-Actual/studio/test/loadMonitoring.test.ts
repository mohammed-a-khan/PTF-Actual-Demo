/**
 * Server monitoring of a load run: Linux over SSH, Windows performance counters (typeperf output), JMX through
 * Jolokia, a database's counters; warning / critical levels raise alerts while running (webhook, stop the run);
 * requests are tagged for APM tools (traceparent, Dynatrace's test header, a header of your own).
 * SSH runs against a lab sshd when CS_LAB_SSH is set (user@host:port,identity file,known hosts file); SQL against a
 * lab PostgreSQL when CS_LAB_PG is set (host:port/database/user/password).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as net from 'net';
import { jolokiaValue, MonitorDef, Monitors, perfmonValue, sshHost, sshValue, validMonitor } from '../src/load/monitor';
import { apmHeaders } from '../src/load/apm';
import { LoadEngine } from '../src/load/engine';
import { newScenario, validScenario } from '../src/load/scenario';
import { newRequest } from '../src/api/model';

const V = { vars: {}, config: {}, env: {} };
const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

test('readings: /proc and df over SSH, typeperf CSV, Jolokia values; addresses and definitions checked', () => {
    const a = sshValue('cpu', 'cpu  100 0 100 800 0 0 0 0 0 0');
    assert.equal(a.value, null, 'the first CPU reading only starts the measure');
    assert.equal(sshValue('cpu', 'cpu  150 0 150 900 0 0 0 0 0 0', a.raw).value, 50);
    assert.equal(sshValue('memory', 'MemTotal:       16000000 kB\nMemAvailable:    4000000 kB\n').value, 75);
    assert.equal(sshValue('load', '0.93 0.66 0.50 1/228 13917').value, 0.93);
    assert.equal(sshValue('disk', '/dev/sda1  41152736 30864552 8174652  79% /').value, 79);
    assert.equal(sshValue(undefined, 'connections: 42\n').value, 42);
    assert.equal(perfmonValue('\r\n"(PDH-CSV 4.0)","\\\\WEB01\\Processor(_Total)\\% Processor Time"\r\n"11/23/2026 10:00:01.123","37.5"\r\nExiting, please wait...\r\n'), 37.5);
    assert.equal(perfmonValue('"(PDH-CSV 4.0)","\\\\x\\y"\r\n"11/23/2026 10:00:01.123"," "\r\n'), null);
    assert.equal(jolokiaValue({ 'java.lang:name=G1 Young,type=GarbageCollector': { CollectionTime: 120 }, 'java.lang:name=G1 Old,type=GarbageCollector': { CollectionTime: 30 } }), 150);
    assert.equal(jolokiaValue(5.5), 5.5);
    assert.deepEqual(sshHost('ops@web01.lab:2222'), { user: 'ops', host: 'web01.lab', port: 2222 });
    assert.equal(sshHost('-oProxyCommand=sh'), null, 'no ssh options through the address');
    assert.equal(sshHost('a;rm -rf x'), null);
    const def = (m: Partial<MonitorDef>): MonitorDef => ({ name: 'm', kind: 'ssh', url: '', ...m });
    assert.match(validMonitor(def({ host: 'x@h' }))!, /a measure/);
    assert.equal(validMonitor(def({ host: 'x@h', preset: 'cpu', warn: 70, max: 90 })), null);
    assert.match(validMonitor(def({ host: 'x@h', preset: 'cpu', warn: 95, max: 90 }))!, /warning level is above/);
    assert.equal(validMonitor(def({ kind: 'perfmon', counter: '\\Processor(_Total)\\% Processor Time', host: 'web01' })), null);
    assert.match(validMonitor(def({ kind: 'perfmon', counter: 'Processor' }))!, /a counter such as/);
    assert.equal(validMonitor(def({ kind: 'jolokia', url: 'http://app:8778/jolokia', mbean: 'java.lang:type=Memory', attribute: 'HeapMemoryUsage', innerPath: 'used' })), null);
    assert.equal(validMonitor(def({ kind: 'sql', connection: 'ORDERS', query: 'SELECT 1' })), null);
    assert.throws(() => validScenario({ ...newScenario('x', 'test/p/api/a.collection.json'), alerting: { webhook: 'ftp://x' } }), /alert webhook/);
    assert.throws(() => validScenario({ ...newScenario('x', 'test/p/api/a.collection.json'), apm: { header: { name: 'X Load', value: 'a' } } }), /APM header name/);
});

test('APM tags: a new W3C trace per request, Dynatrace test header, a header of your own', () => {
    const a = apmHeaders({ traceparent: true, dynatrace: true, header: { name: 'X-Load-Test', value: '{scenario}/{transaction}/u{user}' } }, { scenario: 'Checkout', transaction: 'Pay; now', user: 2, run: 'run-1' });
    assert.match(a.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.equal(a.headers.traceparent.slice(3, 35), a.trace);
    assert.equal(a.headers['x-dynatrace-test'], 'VU=3;SI=CS Test Studio;TSN=Pay  now;LSN=Checkout;LTN=run-1');
    assert.equal(a.headers['X-Load-Test'], 'Checkout/Pay; now/u3');
    assert.notEqual(apmHeaders({ traceparent: true }, { scenario: 's', transaction: 't', user: 0, run: 'r' }).trace, a.trace);
});

test('monitors: Linux over SSH, JMX through Jolokia, database counters', async (t) => {
    const jol = http.createServer((q, r) => {
        let b = '';
        q.on('data', (c) => (b += c));
        q.on('end', () => {
            const x = JSON.parse(b);
            r.writeHead(200, { 'Content-Type': 'application/json' });
            if (x.mbean === 'java.lang:type=Memory') r.end(JSON.stringify({ status: 200, value: x.path === 'used' ? 268435456 : { used: 268435456, max: 1073741824 } }));
            else if (x.mbean === 'java.lang:type=GarbageCollector,name=*') r.end(JSON.stringify({ status: 200, value: { 'java.lang:name=Young,type=GarbageCollector': { CollectionTime: 40 }, 'java.lang:name=Old,type=GarbageCollector': { CollectionTime: 2 } } }));
            else r.end(JSON.stringify({ status: 404, error: 'javax.management.InstanceNotFoundException : x\n at ...' }));
        });
    });
    const port = await listen(jol);
    const ssh = process.env.CS_LAB_SSH?.split(',');
    const pg = process.env.CS_LAB_PG ? /^([^:]+):(\d+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(process.env.CS_LAB_PG) : null;
    const defs: MonitorDef[] = [
        { name: 'Heap used', kind: 'jolokia', url: `http://127.0.0.1:${port}/jolokia`, mbean: 'java.lang:type=Memory', attribute: 'HeapMemoryUsage', innerPath: 'used', scale: 1 / 1048576, unit: 'MB' },
        { name: 'GC time', kind: 'jolokia', url: `http://127.0.0.1:${port}/jolokia`, mbean: 'java.lang:type=GarbageCollector,name=*', attribute: 'CollectionTime' },
        { name: 'Missing bean', kind: 'jolokia', url: `http://127.0.0.1:${port}/jolokia`, mbean: 'x:type=Nope', attribute: 'A' },
        { name: 'Windows CPU', kind: 'perfmon', url: '', counter: '\\Processor(_Total)\\% Processor Time' },
        ...(ssh ? (['cpu', 'memory', 'load', 'disk'] as const).map((preset): MonitorDef => ({ name: `Linux ${preset}`, kind: 'ssh', url: '', host: ssh[0], identity: ssh[1], knownHosts: ssh[2], preset })) : []),
        ...(ssh ? [{ name: 'Processes', kind: 'ssh' as const, url: '', host: ssh[0], identity: ssh[1], knownHosts: ssh[2], command: 'ls /proc | grep -c "^[0-9]"' }] : []),
        ...(pg ? [{ name: 'DB sessions', kind: 'sql' as const, url: '', connection: 'shop', query: 'SELECT count(*) FROM pg_stat_activity' }, { name: 'DB commits/s', kind: 'sql' as const, url: '', connection: 'SHOP', query: 'SELECT sum(xact_commit) FROM pg_stat_database', rate: true }] : []),
    ];
    for (const d of defs) assert.equal(validMonitor(d), null, d.name);
    const config: Record<string, string> = pg ? { DB_SHOP_TYPE: 'postgresql', DB_SHOP_HOST: pg[1], DB_SHOP_PORT: pg[2], DB_SHOP_DATABASE: pg[3], DB_SHOP_USERNAME: pg[4], DB_SHOP_PASSWORD: pg[5] } : {};
    const m = new Monitors(defs, { ...V, config }, undefined, 8000, { environment: 'qa' });
    try {
        await m.sample(0);
        await new Promise((r) => setTimeout(r, 1100));
        await m.sample(1.1);
        const s = Object.fromEntries(m.snapshot().map((x) => [x.name, x]));
        assert.deepEqual(s['Heap used'].points.map((p) => p.v), [256, 256]);
        assert.equal(s['GC time'].points[0].v, 42, 'a wildcard MBean sums its values');
        assert.equal(s['Missing bean'].error, 'javax.management.InstanceNotFoundException : x');
        if (process.platform !== 'win32') assert.match(s['Windows CPU'].error ?? '', /typeperf on a Windows load generator/);
        if (ssh) {
            assert.equal(s['Linux cpu'].points.length, 1, `CPU from the second reading: ${s['Linux cpu'].error}`);
            for (const k of ['cpu', 'memory', 'disk']) { const v = s[`Linux ${k}`].points.at(-1)!.v; assert.ok(v >= 0 && v <= 100, `${k}: ${v}`); assert.equal(s[`Linux ${k}`].unit, '%'); }
            assert.ok(s['Linux load'].points.length === 2 && s.Processes.points.at(-1)!.v > 5, JSON.stringify([s['Linux load'], s.Processes]));
        } else t.diagnostic('SSH monitors not run: set CS_LAB_SSH');
        if (pg) {
            assert.ok(s['DB sessions'].points.at(-1)!.v >= 1, JSON.stringify(s['DB sessions']));
            assert.equal(s['DB commits/s'].points.length, 1, `a rate from the second reading: ${s['DB commits/s'].error}`);
        } else t.diagnostic('SQL monitors not run: set CS_LAB_PG');
    } finally { m.close(); jol.close(); }
});

test('alerts while running: warning then critical to the webhook; a critical one stops the run; requests carry APM tags', async () => {
    let reads = 0;
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const hooks: Array<{ text: string; alert: { level: string } }> = [];
    const app = http.createServer((q, r) => {
        if (q.url === '/metrics') { reads++; r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ queue: reads === 1 ? 10 : reads === 2 ? 60 : 120 })); return; }
        if (q.url === '/hook') { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { hooks.push(JSON.parse(b)); r.end('ok'); }); return; }
        seen.push(q.headers); r.writeHead(200); r.end('{}');
    });
    const port = await listen(app);
    try {
        const sc = { ...newScenario('Checkout', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], policy: { type: 'constant' as const, users: 2, duration: 20 }, monitorEvery: 1,
            monitors: [{ name: 'Queue', kind: 'json' as const, url: `http://127.0.0.1:${port}/metrics`, path: '$.queue', warn: 50, max: 100 }],
            alerting: { webhook: '{config:ALERT_HOOK}', stopOnCritical: true }, apm: { traceparent: true, dynatrace: true, header: { name: 'X-Load-Test', value: '{scenario}/{transaction}' } } };
        validScenario(sc);
        const r = await new LoadEngine({ scenario: sc, collection: { baseUrl: `http://127.0.0.1:${port}`, auth: { type: 'none' } }, requests: [{ ...newRequest('Pay', 'pay'), url: '/pay', checks: [] }],
            values: { vars: {}, config: { ALERT_HOOK: `http://127.0.0.1:${port}/hook` }, env: {} }, rows: [] }).run();
        assert.equal(r.stopReason, 'alert');
        assert.equal(r.passed, false);
        assert.ok(r.elapsed < 10, `stopped early: ${r.elapsed}`);
        assert.deepEqual(r.alerts.map((a) => a.level), ['warning', 'critical']);
        assert.match(r.alerts[1].message, /Queue is at 120, over its maximum of 100/);
        await new Promise((res) => setTimeout(res, 300));
        assert.deepEqual(hooks.map((h) => h.alert.level), ['warning', 'critical']);
        assert.match(hooks[1].text, /^🔴 Load test "Checkout" at \d+ s: Queue is at 120/);
        assert.ok(seen.length > 2);
        const traces = new Set(seen.map((h) => String(h.traceparent).slice(3, 35)));
        assert.equal(traces.size, seen.length, 'a new trace per request');
        assert.ok(seen.every((h) => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(String(h.traceparent)) && /^VU=\d;SI=CS Test Studio;TSN=Pay;LSN=Checkout;LTN=run-/.test(String(h['x-dynatrace-test'])) && h['x-load-test'] === 'Checkout/Pay'), JSON.stringify(seen[0]));
    } finally { app.close(); }
});
