/**
 * Socket.IO, MQTT, Kafka and gRPC exchanges against real servers: a Socket.IO server, an MQTT broker (aedes), a
 * gRPC server (unary, server / client / bidirectional streaming; with the .proto and with server reflection) and,
 * when CS_KAFKA_BROKER is set (host:port), a Kafka broker.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { msgExchange, runExchange, topicMatches, grpcReflect, grpcServicesOf, loadProto, sampleMessage } from '../src/api/messaging';
import type { WsStep } from '../src/api/model';

const V = { vars: { who: 'qa' }, config: {}, env: {} };
const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

test('MQTT topic filters', () => {
    assert.ok(topicMatches('orders/+/created', 'orders/eu/created'));
    assert.ok(topicMatches('orders/#', 'orders/eu/created'));
    assert.ok(!topicMatches('orders/+', 'orders/eu/created'));
    assert.ok(!topicMatches('orders/eu', 'orders/us'));
});

test('Socket.IO: events sent as objects, expected by event, values saved; the request headers reach the server', async () => {
    const { Server } = await import('socket.io');
    const h = http.createServer();
    const io = new Server(h);
    let header = '';
    io.on('connection', (s) => {
        header = String(s.handshake.headers['x-team']);
        s.on('order:create', (o: { item: string }) => s.emit('order:created', { id: 'o-1', item: o.item, by: s.handshake.headers['x-team'] }));
        s.emit('welcome', 'hello');
    });
    const port = await listen(h);
    try {
        const steps: WsStep[] = [
            { kind: 'expect', text: 'hello', topic: 'welcome' },
            { kind: 'send', text: '{"item":"book-{{who}}"}', topic: 'order:create' },
            { kind: 'expect', text: '"item":"book-qa"', topic: 'order:created', save: { path: '$.id', variable: 'orderId' } },
        ];
        const r = await runExchange({ protocol: 'socketio', steps }, { url: `http://127.0.0.1:${port}`, headers: { 'X-Team': 'payments' } }, V, 5000);
        assert.equal(r.error, undefined, JSON.stringify(r));
        assert.deepEqual(r.saved, { orderId: 'o-1' });
        assert.equal(header, 'payments');
        const bad = await msgExchange('socketio', { url: `http://127.0.0.1:${port}`, headers: {}, options: {}, timeoutMs: 600 }, [{ kind: 'expect', text: 'never', topic: 'welcome' }], V);
        assert.match(bad.error!, /No message on welcome containing "never" within 600 ms/);
    } finally { io.close(); h.close(); }
});

test('MQTT: subscribed topics, publish with QoS 1, wildcard expectations, sign-in with the request\'s basic credentials', async () => {
    type Broker = { handle: (s: net.Socket) => void; close: (cb?: () => void) => void; authenticate: unknown };
    const mod = await import('aedes') as unknown as { createBroker?: () => Promise<Broker>; default: { createBroker: () => Promise<Broker> } };
    const createBroker = mod.createBroker ?? mod.default.createBroker;
    const broker = await createBroker();
    broker.authenticate = (_c: unknown, user: string, pass: Buffer, done: (e: Error | null, ok: boolean) => void) => done(null, user === 'qa' && String(pass) === 'pw');
    const s = net.createServer(broker.handle);
    const port = await listen(s);
    try {
        const basic = { Authorization: 'Basic ' + Buffer.from('qa:pw').toString('base64') };
        const steps: WsStep[] = [
            { kind: 'send', text: '{"orderId":"o-7","status":"created"}', topic: 'shop/eu/orders' },
            { kind: 'expect', text: '"status":"created"', topic: 'shop/+/orders', save: { path: '$.orderId', variable: 'id' } },
        ];
        const r = await runExchange({ protocol: 'mqtt', steps, options: { subscribe: ['shop/#'], qos: 1 } }, { url: `mqtt://127.0.0.1:${port}`, headers: basic }, V, 5000);
        assert.equal(r.error, undefined, JSON.stringify(r));
        assert.deepEqual(r.saved, { id: 'o-7' });
        assert.ok(r.log.some((l) => l.dir === 'in' && l.text.startsWith('[shop/eu/orders]')));
        const refused = await runExchange({ protocol: 'mqtt', steps: [], options: {} }, { url: `mqtt://127.0.0.1:${port}`, headers: { Authorization: 'Basic ' + Buffer.from('qa:nope').toString('base64') } }, V, 3000);
        assert.match(refused.error!, /Could not connect/);
    } finally { s.close(); broker.close(); }
});

const PROTO = `syntax = "proto3";
package shop.v1;
message OrderRequest { string id = 1; }
message Order { string id = 1; double total = 2; repeated string items = 3; int64 placed = 4; }
message Item { string sku = 1; int32 qty = 2; }
message Summary { int32 count = 1; int32 units = 2; }
service Orders {
  rpc GetOrder (OrderRequest) returns (Order);
  rpc Watch (OrderRequest) returns (stream Order);
  rpc AddItems (stream Item) returns (Summary);
  rpc Chat (stream Item) returns (stream Item);
}`;

test('gRPC: unary, server / client / bidirectional streaming with the .proto; metadata; status errors; server reflection', async () => {
    const grpc = await import('@grpc/grpc-js');
    const loader = await import('@grpc/proto-loader');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-grpc-'));
    fs.mkdirSync(path.join(dir, 'protos'));
    fs.writeFileSync(path.join(dir, 'protos', 'shop.proto'), PROTO);
    const def = loader.loadSync(path.join(dir, 'protos', 'shop.proto'), { keepCase: true, longs: String, defaults: true });
    const svc = (grpc.loadPackageDefinition(def) as unknown as { shop: { v1: { Orders: { service: import('@grpc/grpc-js').ServiceDefinition } } } }).shop.v1.Orders.service;
    const server = new grpc.Server();
    let seenTeam = '';
    server.addService(svc, {
        GetOrder: (call: { request: { id: string }; metadata: import('@grpc/grpc-js').Metadata }, cb: (e: unknown, r?: unknown) => void) => {
            seenTeam = String(call.metadata.get('x-team')[0] ?? '');
            if (call.request.id === 'missing') return cb({ code: grpc.status.NOT_FOUND, details: 'no order missing' });
            cb(null, { id: call.request.id, total: 12.5, items: ['a', 'b'], placed: '1700000000000' });
        },
        Watch: (call: { request: { id: string }; write: (x: unknown) => void; end: () => void }) => { for (const st of ['created', 'paid', 'shipped']) call.write({ id: `${call.request.id}:${st}` }); call.end(); },
        AddItems: (call: { on: (e: string, f: (x?: { qty: number }) => void) => void }, cb: (e: unknown, r?: unknown) => void) => { let count = 0, units = 0; call.on('data', (x) => { count++; units += x!.qty; }); call.on('end', () => cb(null, { count, units })); },
        Chat: (call: { on: (e: string, f: (x?: { sku: string; qty: number }) => void) => void; write: (x: unknown) => void; end: () => void }) => { call.on('data', (x) => call.write({ sku: `echo-${x!.sku}`, qty: x!.qty * 2 })); call.on('end', () => call.end()); },
    } as never);
    const { ReflectionService } = await import('@grpc/reflection');
    new ReflectionService(def).addToServer(server);
    const port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
    const url = `grpc://127.0.0.1:${port}`;
    const ex = (method: string, steps: WsStep[], extra: object = {}) => runExchange({ protocol: 'grpc', steps, options: { protoFile: 'protos/shop.proto', service: 'shop.v1.Orders', method, ...extra } }, { url, headers: { 'X-Team': 'payments' } }, V, 5000, undefined, dir);
    try {
        let r = await ex('GetOrder', [{ kind: 'send', text: '{"id":"o-{{who}}"}' }, { kind: 'expect', text: '"total":12.5', save: { path: '$.placed', variable: 'placed' } }]);
        assert.equal(r.error, undefined, JSON.stringify(r));
        assert.deepEqual(r.saved, { placed: '1700000000000' }, 'int64 as a string, as protobuf JSON writes it');
        assert.equal(seenTeam, 'payments', 'request headers go as metadata');
        r = await ex('GetOrder', [{ kind: 'send', text: '{"id":"missing"}' }, { kind: 'expect', text: '' }]);
        assert.match(r.error!, /gRPC status 5 NOT_FOUND: no order missing/);
        r = await ex('Watch', [{ kind: 'send', text: '{"id":"o-1"}' }, { kind: 'expect', text: 'created' }, { kind: 'expect', text: 'paid' }, { kind: 'expect', text: 'shipped' }]);
        assert.equal(r.error, undefined, JSON.stringify(r));
        r = await ex('AddItems', [{ kind: 'send', text: '{"sku":"a","qty":2}' }, { kind: 'send', text: '{"sku":"b","qty":3}' }, { kind: 'expect', text: '"count":2' }]);
        assert.equal(r.error, undefined, JSON.stringify(r));
        assert.ok(r.log.some((l) => l.text.includes('"units":5')));
        r = await ex('Chat', [{ kind: 'send', text: '{"sku":"x","qty":1}' }, { kind: 'expect', text: 'echo-x' }, { kind: 'send', text: '{"sku":"y","qty":4}' }, { kind: 'expect', text: '"qty":8' }]);
        assert.equal(r.error, undefined, JSON.stringify(r));
        r = await ex('GetOrder', [{ kind: 'send', text: 'not json' }]);
        assert.match(r.error!, /A gRPC message is JSON/);
        // Reflection: the services, then a call without the .proto.
        const refl = await grpcReflect(url, undefined, 5000);
        assert.deepEqual(refl.services, ['shop.v1.Orders']);
        r = await runExchange({ protocol: 'grpc', steps: [{ kind: 'send', text: '{"id":"r-1"}' }, { kind: 'expect', text: '"id":"r-1"' }], options: { reflection: true, service: 'shop.v1.Orders', method: 'GetOrder' } }, { url, headers: {} }, V, 5000);
        assert.equal(r.error, undefined, JSON.stringify(r));
        // For the editor: methods of the file and a sample message.
        const pd = await loadProto(dir, 'protos/shop.proto');
        const list = await grpcServicesOf(pd);
        assert.deepEqual(list[0].methods.map((m) => [m.name, m.requestStream, m.responseStream]), [['GetOrder', false, false], ['Watch', false, true], ['AddItems', true, false], ['Chat', true, true]]);
        assert.deepEqual(JSON.parse(sampleMessage(pd, 'shop.v1.Orders', 'AddItems')), { sku: '', qty: 0 });
        await assert.rejects(loadProto(dir, '../outside.proto'), /must be in the project/);
    } finally { server.forceShutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Kafka: a consumer from the end of the topic, a producer with keys, messages expected by topic', async (t) => {
    const broker = process.env.CS_KAFKA_BROKER;
    if (!broker) { t.skip('CS_KAFKA_BROKER is not set'); return; }
    const topic = `orders-${Date.now()}`;
    const steps: WsStep[] = [
        { kind: 'send', text: '{"orderId":"k-1","state":"created"}', topic, key: 'k-1' },
        { kind: 'expect', text: '"state":"created"', topic, save: { path: '$.orderId', variable: 'id' }, timeoutMs: 20000 },
        { kind: 'send', text: '{"orderId":"k-1","state":"paid"}', topic },
        { kind: 'expect', text: 'paid', topic, timeoutMs: 20000 },
    ];
    const r = await runExchange({ protocol: 'kafka', steps, options: { subscribe: [topic] } }, { url: `kafka://${broker}`, headers: {} }, V, 30000);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.deepEqual(r.saved, { id: 'k-1' });
    // A second exchange starts at the end: the earlier messages are not received again.
    const again = await runExchange({ protocol: 'kafka', steps: [{ kind: 'expect', text: 'created', topic, timeoutMs: 3000 }], options: { subscribe: [topic] } }, { url: `kafka://${broker}`, headers: {} }, V, 30000);
    assert.match(again.error!, /No message on/);
    const begin = await runExchange({ protocol: 'kafka', steps: [{ kind: 'expect', text: 'created', topic, timeoutMs: 20000 }], options: { subscribe: [topic], fromBeginning: true } }, { url: `kafka://${broker}`, headers: {} }, V, 30000);
    assert.equal(begin.error, undefined, JSON.stringify(begin));
});
