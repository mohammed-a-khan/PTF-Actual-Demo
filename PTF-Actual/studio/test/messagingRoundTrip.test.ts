/**
 * Socket.IO, MQTT, gRPC (and Kafka when CS_KAFKA_BROKER is set) requests of the Studio, written as a feature, run on
 * the real framework (its messaging steps) with the same verdicts as the Studio's Send: values saved from one
 * message used in the next, and a request that must fail.
 *
 *   CS_FRAMEWORK_PROJECT=/path/to/demo-project [CS_KAFKA_BROKER=127.0.0.1:9092] npx tsx --test test/messagingRoundTrip.test.ts
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import { broker as amqpBroker, mcpServer } from './protocolLab';
import * as path from 'path';
import { execFile } from 'child_process';
import { apiTestPlan } from '../src/api/codegen/plan';
import { ApiCollection, ApiRequest, newCollection, newRequest, allRequests } from '../src/api/model';
import { prepare } from '../src/api/send';
import { runExchange } from '../src/api/messaging';

const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
const PROTO = `syntax = "proto3";
package shop.v1;
message OrderRequest { string id = 1; }
message Order { string id = 1; double total = 2; string status = 3; }
service Orders { rpc GetOrder (OrderRequest) returns (Order); rpc Watch (OrderRequest) returns (stream Order); }`;

function run(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((res) => execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, timeout: 300_000 }, (_e, o, e2) => res(`${o}\n${e2}`)));
}
function scenarioResults(out: string): Record<string, boolean> {
    const r: Record<string, boolean> = {};
    for (const m of out.replace(/\x1b\[[0-9;]*m/g, '').matchAll(/\[(PASS|FAIL)\] Test completed: (.+?)\s*$/gm)) r[m[2]] = m[1] === 'PASS';
    return r;
}

test('messaging requests run on the framework with the Studio\'s verdicts (Socket.IO, MQTT, gRPC, Kafka, AMQP, MCP, SQL)', { timeout: 400_000 }, async (t) => {
    const projectDir = process.env.CS_FRAMEWORK_PROJECT;
    if (!projectDir || !fs.existsSync(path.join(projectDir, 'node_modules'))) { t.skip('CS_FRAMEWORK_PROJECT is not set'); return; }
    // Servers.
    const { Server } = await import('socket.io');
    const h = http.createServer();
    const io = new Server(h);
    io.on('connection', (s) => s.on('order:create', (o: { item: string }) => s.emit('order:created', { id: `o-${o.item}`, by: s.handshake.headers['x-team'] ?? '' })));
    const ioPort = await listen(h);
    type Broker = { handle: (s: net.Socket) => void; close: (cb?: () => void) => void };
    const mod = await import('aedes') as unknown as { createBroker?: () => Promise<Broker>; default: { createBroker: () => Promise<Broker> } };
    const broker = await (mod.createBroker ?? mod.default.createBroker)();
    const mq = net.createServer(broker.handle);
    const mqPort = await listen(mq);
    const grpc = await import('@grpc/grpc-js');
    const loader = await import('@grpc/proto-loader');
    const project = `mrt${process.pid}`;
    const made = [path.join(projectDir, 'config', project), path.join(projectDir, 'test', project)];
    fs.mkdirSync(path.join(projectDir, 'test', project, 'protos'), { recursive: true });
    const protoRel = `test/${project}/protos/shop.proto`;
    fs.writeFileSync(path.join(projectDir, protoRel), PROTO);
    const def = loader.loadSync(path.join(projectDir, protoRel), { keepCase: true, defaults: true });
    const gs = new grpc.Server();
    gs.addService((grpc.loadPackageDefinition(def) as unknown as { shop: { v1: { Orders: { service: import('@grpc/grpc-js').ServiceDefinition } } } }).shop.v1.Orders.service, {
        GetOrder: (call: { request: { id: string } }, cb: (e: unknown, r?: unknown) => void) => cb(null, { id: call.request.id, total: 42, status: 'OPEN' }),
        Watch: (call: { request: { id: string }; write: (x: unknown) => void; end: () => void }) => { for (const st of ['OPEN', 'PAID']) call.write({ id: call.request.id, status: st }); call.end(); },
    } as never);
    const amqp = await amqpBroker().catch((e) => { io.close(); h.close(); mq.close(); broker.close(); throw e; });
    const mcp = await mcpServer().catch((e) => { io.close(); h.close(); mq.close(); broker.close(); amqp.close(); throw e; });
    const pg = process.env.CS_LAB_PG ? /^([^:]+):(\d+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(process.env.CS_LAB_PG) : null;
    const dbConfig: Record<string, string> = pg ? { DB_SHOP_TYPE: 'postgresql', DB_SHOP_HOST: pg[1], DB_SHOP_PORT: pg[2], DB_SHOP_DATABASE: pg[3], DB_SHOP_USERNAME: pg[4], DB_SHOP_PASSWORD: pg[5] } : {};
    if (pg) {
        const { sqlOpener } = await import('../src/api/sqlAction');
        const db = await sqlOpener({ config: dbConfig, environment: 'dev', timeoutMs: 5000 })('SHOP');
        await db.query('DROP TABLE IF EXISTS rt_orders; CREATE TABLE rt_orders(id text primary key, total int)');
        await db.close();
    }
    const gPort = await new Promise<number>((res, rej) => gs.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
    try {
        const c: ApiCollection = { ...newCollection('Messaging'), baseUrl: `http://127.0.0.1:${ioPort}`, variables: [{ key: 'item', value: 'book' }] };
        const req = (name: string, url: string, ws: ApiRequest['ws']): ApiRequest => ({ ...newRequest(name), id: name, url, checks: [], ws });
        c.items = [
            req('Socket order', '/', { protocol: 'socketio', steps: [
                { kind: 'send', text: '{"item":"{{item}}"}', topic: 'order:create' },
                { kind: 'expect', text: 'o-book', topic: 'order:created', save: { path: '$.id', variable: 'orderId' }, timeoutMs: 10000 }] }),
            req('MQTT event', `mqtt://127.0.0.1:${mqPort}`, { protocol: 'mqtt', options: { subscribe: ['shop/#'], qos: 1 }, steps: [
                { kind: 'send', text: '{"orderId":"{{orderId}}","state":"created"}', topic: 'shop/eu/orders' },
                { kind: 'expect', text: '"orderId":"o-book"', topic: 'shop/+/orders', timeoutMs: 10000 }] }),
            req('gRPC order', `grpc://127.0.0.1:${gPort}`, { protocol: 'grpc', options: { protoFile: protoRel, service: 'shop.v1.Orders', method: 'GetOrder' }, steps: [
                { kind: 'send', text: '{"id":"{{orderId}}"}' },
                { kind: 'expect', text: '"total":42', save: { path: '$.status', variable: 'status' }, timeoutMs: 10000 }] }),
            req('gRPC watch', `grpc://127.0.0.1:${gPort}`, { protocol: 'grpc', options: { protoFile: protoRel, service: 'shop.v1.Orders', method: 'Watch' }, steps: [
                { kind: 'send', text: '{"id":"w-1"}' }, { kind: 'expect', text: 'OPEN', timeoutMs: 10000 }, { kind: 'expect', text: 'PAID', timeoutMs: 10000 }] }),
            req('MQTT wrong topic', `mqtt://127.0.0.1:${mqPort}`, { protocol: 'mqtt', options: { subscribe: ['shop/#'] }, steps: [
                { kind: 'send', text: 'x', topic: 'shop/us/orders' }, { kind: 'expect', text: 'x', topic: 'shop/eu/orders', timeoutMs: 2000 }] }),
        ];
        // AMQP (Service Bus style sign-in), MCP, and SQL on the lab database (CS_LAB_PG=host:port/db/user/password).
        c.items.push(
            req('AMQP order', `amqp://RootManageSharedAccessKey:k3y%3D@127.0.0.1:${amqp.port}`, { protocol: 'amqp', options: { subscribe: ['orders'] }, steps: [
                { kind: 'send', text: '{"orderId":"{{orderId}}"}', topic: 'orders', key: 'created' }, { kind: 'expect', text: 'o-book', topic: 'orders', save: { path: '$.orderId', variable: 'queued' }, timeoutMs: 10000 }] }),
            req('MCP tool', mcp.url, { protocol: 'mcp', steps: [
                { kind: 'send', text: '{"tool":"add","arguments":{"a":40,"b":2}}' }, { kind: 'expect', text: '"result"', topic: 'tools/call', save: { path: '$.result.content[0].text', variable: 'sum' }, timeoutMs: 10000 }] }),
        );
        if (pg) c.items.push(req('SQL order row', 'db://SHOP', { protocol: 'sql', steps: [
            { kind: 'send', text: "DELETE FROM rt_orders WHERE id = 'o-1'" },
            { kind: 'send', text: "INSERT INTO rt_orders(id, total) VALUES ('o-1', {{sum}})" }, { kind: 'expect', text: '"affected":1', timeoutMs: 10000 },
            { kind: 'send', text: "SELECT total FROM rt_orders WHERE id = 'o-1'" }, { kind: 'expect', text: '"total":42', timeoutMs: 10000 }] }));
        if (process.env.CS_KAFKA_BROKER) {
            const topic = `rt-${Date.now()}`;
            c.items.push(req('Kafka event', `kafka://${process.env.CS_KAFKA_BROKER}`, { protocol: 'kafka', options: { subscribe: [topic] }, steps: [
                { kind: 'send', text: '{"orderId":"{{orderId}}"}', topic, key: '{{orderId}}' }, { kind: 'expect', text: 'o-book', topic, timeoutMs: 30000 }] }));
        }
        // Studio verdicts, in order (values saved by one request used by the next).
        const values = { vars: { item: 'book' } as Record<string, string>, config: dbConfig, env: {} };
        const studio: Record<string, boolean> = {};
        for (const r of allRequests(c.items).map((x) => x.request)) {
            const p = prepare(c, r, values);
            const w = await runExchange(r.ws!, p, values, 30000, undefined, projectDir);
            Object.assign(values.vars, w.saved);
            studio[r.name] = !w.error;
            if (r.name !== 'MQTT wrong topic') assert.equal(w.error, undefined, `${r.name}: ${w.error}`);
        }
        assert.equal(studio['MQTT wrong topic'], false);
        // The framework.
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
        const name = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).find((d) => /cs-playwright-test-framework|cs-test-automation-framework/.test(d))!;
        const env = path.join(projectDir, 'config', project);
        fs.mkdirSync(path.join(env, 'common'), { recursive: true });
        fs.mkdirSync(path.join(env, 'environments'), { recursive: true });
        fs.writeFileSync(path.join(env, 'common', 'common.env'), [`PROJECT_NAME=${project}`, 'PROJECT_TYPE=api', 'DEFAULT_BROWSER=none', 'BROWSER_LAUNCH_REQUIRED=false', 'HEADLESS=true',
            'BROWSER_VIDEO=off', 'HAR_CAPTURE_MODE=never', 'TRACE_CAPTURE_MODE=never', 'SCREENSHOT_ON_FAILURE=false', 'RETRY_COUNT=0', `STEP_DEFINITIONS_PATH=test/${project}/steps;node_modules/${name}/dist/steps/api`, ''].join('\n'));
        fs.writeFileSync(path.join(env, 'environments', 'dev.env'), ['ENVIRONMENT=dev', ...Object.entries(dbConfig).map(([k, v]) => `${k}=${v}`), ''].join('\n'));
        const plan = apiTestPlan(c, { project, featureFolder: `test/${project}/features`, stepsFolder: `test/${project}/steps`, pkg: name, config: {}, msgSteps: true,
            read: (rel) => { try { return fs.readFileSync(path.join(projectDir, rel), 'utf8'); } catch { return null; } } });
        assert.deepEqual(plan.warnings, []);
        for (const f of plan.files) { fs.mkdirSync(path.dirname(path.join(projectDir, f.path)), { recursive: true }); fs.writeFileSync(path.join(projectDir, f.path), f.text); }
        const out = await run(process.execPath, [path.join(projectDir, 'node_modules', name, 'dist', 'index.js'), `--project=${project}`, '--env=dev', `--features=${plan.feature}`, '--headless=true'], projectDir);
        if (process.env.CS_ROUNDTRIP_LOG) fs.writeFileSync(process.env.CS_ROUNDTRIP_LOG, `${plan.files.map((x) => `---- ${x.path}\n${x.text}`).join('\n')}\n\n==== framework ====\n${out}`);
        const fw = scenarioResults(out);
        const scenarioOf = (r: string) => Object.keys(fw).find((n) => n.split(', then ').includes(r));
        for (const r of Object.keys(studio)) {
            const sc = scenarioOf(r);
            assert.ok(sc, `the framework did not report "${r}": ${JSON.stringify(fw)}\n${out.slice(-3000)}`);
            const expected = Object.keys(studio).filter((x) => scenarioOf(x) === sc).every((x) => studio[x]);
            assert.equal(fw[sc], expected, `${sc}: framework ${fw[sc]}, Studio ${expected}\n${out.slice(-4000)}`);
        }
    } finally {
        io.close(); h.close(); mq.close(); broker.close(); gs.forceShutdown(); amqp.close(); mcp.close();
        for (const d of made) fs.rmSync(d, { recursive: true, force: true });
    }
});
