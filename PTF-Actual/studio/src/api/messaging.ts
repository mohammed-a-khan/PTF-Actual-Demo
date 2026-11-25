/**
 * Message exchanges over Socket.IO, MQTT, Kafka and gRPC, as WebSocket exchanges work (ws.ts): connect with the
 * request's address, headers and sign-in, then send messages and wait for expected ones (a text they contain,
 * from a topic / event), saving values from them. The result has the shape of a WebSocket exchange, so Send, the
 * runner, load tests and the response view show it the same way.
 *
 *  - Socket.IO: socket.io-client; a step's topic is the event (default "message"); JSON text is sent as an object.
 *  - MQTT: mqtt (mqtt://, mqtts://, ws://, wss://); the options' topics are subscribed on connect; sends publish.
 *  - Kafka: kafkajs (kafka://broker1:9092,broker2:9092, kafkas:// for TLS); a consumer for the subscribed topics
 *    that starts at the end of each partition (or the beginning), a producer for sends (topic, key).
 *  - gRPC: @grpc/grpc-js with the project's .proto (or the server's reflection); unary, server, client and
 *    bidirectional streaming: each send is a request message (JSON), each response message is received; the
 *    request's headers go as metadata. grpc:// plain, grpcs:// TLS.
 *  - AMQP 1.0: rhea (amqp://, amqps://; sb://namespace.servicebus.windows.net is Azure Service Bus over TLS, its
 *    shared access key name / key as the request's Basic sign-in); the JMS brokers speak it too (ActiveMQ, Artemis,
 *    IBM MQ's AMQP channel, Solace, Qpid). The options' queues / topic subscriptions are received from; a send goes
 *    to the step's address (queue or topic), its key is the message's subject.
 *  - MCP: a Model Context Protocol server over streamable HTTP (http(s)://…/mcp): initialized on connect, each send
 *    is a JSON-RPC call ({"method": "tools/list"} or the short {"tool": "name", "arguments": {…}}), each answer (or
 *    server notification) is received; the message's topic is the method.
 *  - SQL: db://ALIAS, a database connection of the project (sqlAction.ts): each send is a statement, each result a
 *    message { rows, rowCount, affected } on the topic "result".
 * Basic sign-in of the request: MQTT username / password, Kafka SASL, AMQP SASL PLAIN.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Values } from './send';
import { fill } from './send';
import type { MsgOptions, MsgProtocol, WsStep } from './model';
import { readPath } from './jsonPath';
import type { Connection } from '../core/network';
import { McpClient } from '../mcp/client';
import type { WsLogEntry, WsResult } from './ws';
import { SqlOpener, sqlAlias, sqlOpener } from './sqlAction';
import * as http from 'http';
import * as https from 'https';

export interface Incoming { topic?: string; text: string }

/** One protocol: connect, send a step's message, close; messages and the end reported through the callbacks. */
interface Transport {
    connect(): Promise<void>;
    send(text: string, step: WsStep): Promise<void>;
    /** Before the first expected message (gRPC client streaming: no more requests). */
    beforeExpect?(): void;
    close(): Promise<void>;
}
interface Sink { message(m: Incoming): void; closed(why: string): void; info(text: string): void }

const MAX_LOG = 500, MAX_TEXT = 20_000;
const shown = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}… (${t.length - MAX_TEXT} more characters)` : t);
const asJson = (t: string): unknown => { try { return JSON.parse(t); } catch { return t; } };
const text = (x: unknown) => (typeof x === 'string' ? x : Buffer.isBuffer(x) ? x.toString('utf8') : JSON.stringify(x));

/** An address with its password hidden (amqp://user:***@host), for logs and samples. */
export const redactUrl = (u: string) => u.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/]+):[^@/]*@/i, '$1:***@');

/** MQTT topic filter (+ one level, # the rest). */
export function topicMatches(filter: string, topic: string): boolean {
    const f = filter.split('/'), t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
        if (f[i] === '#') return true;
        if (i >= t.length) return false;
        if (f[i] !== '+' && f[i] !== t[i]) return false;
    }
    return f.length === t.length;
}

/** Username and password of the request's Basic sign-in (MQTT, Kafka SASL). */
function basicOf(headers: Record<string, string>): { username: string; password: string } | undefined {
    const h = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    if (!h || !/^Basic /i.test(h)) return undefined;
    const d = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = d.indexOf(':');
    return { username: d.slice(0, i), password: d.slice(i + 1) };
}

/** Headers a client sets itself (left out of metadata / extra headers). */
const own = /^(host|connection|upgrade|sec-websocket-.*|content-type|content-length|te|user-agent)$/i;

export interface MsgContext {
    url: string; headers: Record<string, string>; options: MsgOptions; timeoutMs: number; conn?: Connection;
    /** Reads a file of the project (.proto files); the database drivers of SQL actions. */
    projectRoot?: string;
    /** SQL: the project's configuration (DB_<ALIAS>_* settings, secrets filled in) and environment name, or an opener of its own. */
    config?: Record<string, string>;
    environment?: string;
    sqlOpen?: SqlOpener;
}

// ---- Socket.IO
async function socketio(c: MsgContext, sink: Sink): Promise<Transport> {
    const { io } = await import('socket.io-client');
    const u = new URL(c.url.replace(/^ws(s?):/i, 'http$1:'));
    const extraHeaders = Object.fromEntries(Object.entries(c.headers).filter(([k]) => !own.test(k)));
    const agent = c.conn?.agentFor(u.href);
    const s = io(u.origin + (u.pathname === '/' ? '' : u.pathname), { path: c.options.path || '/socket.io', extraHeaders, reconnection: false, timeout: c.timeoutMs, transports: ['websocket', 'polling'], forceNew: true,
        ...(agent ? { agent: agent as unknown as string } : {}), ...(c.conn?.ca ? { ca: c.conn.ca } : {}) } as Parameters<typeof io>[1]);
    s.onAny((event: string, ...args: unknown[]) => sink.message({ topic: event, text: args.length === 1 ? text(args[0]) : JSON.stringify(args) }));
    s.on('disconnect', (why) => sink.closed(`disconnected (${why})`));
    return {
        connect: () => new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', (e) => rej(new Error(e.message))); }),
        send: async (t, step) => { s.emit(step.topic || 'message', asJson(t)); },
        close: async () => { s.removeAllListeners(); s.disconnect(); },
    };
}

// ---- MQTT
async function mqttT(c: MsgContext, sink: Sink): Promise<Transport> {
    const mqtt = await import('mqtt');
    const basic = basicOf(c.headers);
    const qos = c.options.qos ?? 0;
    let client: import('mqtt').MqttClient | undefined;
    return {
        connect: async () => {
            client = await mqtt.connectAsync(c.url, { ...(basic ? basic : {}), clientId: c.options.clientId || `cs-studio-${Math.random().toString(16).slice(2, 10)}`, connectTimeout: c.timeoutMs, reconnectPeriod: 0, ...(c.conn?.ca ? { ca: c.conn.ca } : {}) });
            client.on('message', (topic, payload) => sink.message({ topic, text: payload.toString('utf8') }));
            client.on('close', () => sink.closed('connection closed'));
            const subs = (c.options.subscribe ?? []).filter((x) => x.trim());
            if (subs.length) { await client.subscribeAsync(subs, { qos }); sink.info(`Subscribed to ${subs.join(', ')}`); }
        },
        send: async (t, step) => {
            if (!step.topic?.trim()) throw new Error('An MQTT message needs a topic.');
            await client!.publishAsync(step.topic, t, { qos });
        },
        close: async () => { if (client) { client.removeAllListeners('close'); await client.endAsync(true).catch(() => undefined); } },
    };
}

// ---- Kafka
async function kafkaT(c: MsgContext, sink: Sink): Promise<Transport> {
    const { Kafka, logLevel } = await import('kafkajs');
    const m = /^kafka(s?):\/\/([^/?#]+)/i.exec(c.url);
    if (!m) throw new Error(`A Kafka address is kafka://broker:9092[,broker2:9092] (kafkas:// for TLS); got ${c.url}.`);
    const basic = basicOf(c.headers);
    const kafka = new Kafka({
        clientId: 'cs-studio', brokers: m[2].split(','), connectionTimeout: c.timeoutMs, logLevel: logLevel.NOTHING, retry: { retries: 2 },
        ...(m[1] ? { ssl: c.conn?.ca ? { ca: c.conn.ca } : true } : {}),
        ...(basic ? { sasl: { mechanism: c.options.sasl ?? 'plain', username: basic.username, password: basic.password } as never } : {}),
    });
    const producer = kafka.producer({ allowAutoTopicCreation: true });
    const topics = (c.options.subscribe ?? []).filter((x) => x.trim());
    const consumer = topics.length ? kafka.consumer({ groupId: c.options.groupId || `cs-studio-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }) : undefined;
    return {
        connect: async () => {
            await producer.connect();
            if (!consumer) return;
            // Where each partition ends now: messages sent from here on are received (or all, from the beginning).
            const admin = kafka.admin();
            await admin.connect();
            const ends: Array<{ topic: string; partition: number; offset: string }> = [];
            try {
                await admin.createTopics({ topics: topics.map((topic) => ({ topic })), waitForLeaders: true }).catch(() => undefined);
                for (const topic of topics) for (const p of await admin.fetchTopicOffsets(topic)) ends.push({ topic, partition: p.partition, offset: c.options.fromBeginning ? p.low : p.high });
            } finally { await admin.disconnect(); }
            await consumer.connect();
            await consumer.subscribe({ topics, fromBeginning: true });
            const joined = new Promise<void>((res) => consumer.on(consumer.events.GROUP_JOIN, () => res()));
            await consumer.run({ eachMessage: async ({ topic, message }) => sink.message({ topic, text: message.value ? message.value.toString('utf8') : '' }) });
            for (const e of ends) consumer.seek(e);
            await joined;
            sink.info(`Receiving from ${topics.join(', ')}`);
        },
        send: async (t, step) => {
            if (!step.topic?.trim()) throw new Error('A Kafka message needs a topic.');
            await producer.send({ topic: step.topic, messages: [{ value: t, ...(step.key ? { key: step.key } : {}) }] });
        },
        close: async () => { await Promise.allSettled([producer.disconnect(), consumer?.disconnect()]); },
    };
}

// ---- gRPC
/** The server reflection protocol (v1 and v1alpha), enough to read the services and their files. */
const reflectionJson = (pkg: string) => ({ nested: { grpc: { nested: { reflection: { nested: { [pkg]: { nested: {
    ServerReflection: { methods: { ServerReflectionInfo: { requestType: 'ServerReflectionRequest', requestStream: true, responseType: 'ServerReflectionResponse', responseStream: true } } },
    ServerReflectionRequest: { oneofs: { messageRequest: { oneof: ['fileByFilename', 'fileContainingSymbol', 'listServices'] } }, fields: { host: { type: 'string', id: 1 }, fileByFilename: { type: 'string', id: 3 }, fileContainingSymbol: { type: 'string', id: 4 }, listServices: { type: 'string', id: 7 } } },
    ServerReflectionResponse: { oneofs: { messageResponse: { oneof: ['fileDescriptorResponse', 'listServicesResponse', 'errorResponse'] } }, fields: { validHost: { type: 'string', id: 1 }, fileDescriptorResponse: { type: 'FileDescriptorResponse', id: 4 }, listServicesResponse: { type: 'ListServiceResponse', id: 6 }, errorResponse: { type: 'ErrorResponse', id: 7 } } },
    FileDescriptorResponse: { fields: { fileDescriptorProto: { rule: 'repeated', type: 'bytes', id: 1 } } },
    ListServiceResponse: { fields: { service: { rule: 'repeated', type: 'ServiceResponse', id: 1 } } },
    ServiceResponse: { fields: { name: { type: 'string', id: 1 } } },
    ErrorResponse: { fields: { errorCode: { type: 'int32', id: 1 }, errorMessage: { type: 'string', id: 2 } } },
} } } } } } } });

const LOADER = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true } as const;

function grpcTarget(url: string): { target: string; tls: boolean } {
    const m = /^(grpcs?|https?):\/\/([^/?#]+)/i.exec(url);
    if (!m) throw new Error(`A gRPC address is grpc://host:port (grpcs:// for TLS); got ${url}.`);
    return { target: m[2], tls: /^(grpcs|https)$/i.test(m[1]) };
}

async function grpcCredentials(url: string, conn?: Connection) {
    const grpc = await import('@grpc/grpc-js');
    const { tls } = grpcTarget(url);
    return tls ? grpc.credentials.createSsl(conn?.ca ? Buffer.from(Array.isArray(conn.ca) ? conn.ca.join('\n') : String(conn.ca)) : undefined) : grpc.credentials.createInsecure();
}

/** The services the server offers and the package definition of the file of a symbol, by reflection. */
export async function grpcReflect(url: string, symbol: string | undefined, timeoutMs: number, conn?: Connection, metadata: Record<string, string> = {}): Promise<{ services: string[]; definition?: import('@grpc/proto-loader').PackageDefinition }> {
    const grpc = await import('@grpc/grpc-js');
    const loader = await import('@grpc/proto-loader');
    const creds = await grpcCredentials(url, conn);
    const { target } = grpcTarget(url);
    const md = new grpc.Metadata();
    for (const [k, v] of Object.entries(metadata)) if (!own.test(k)) md.set(k.toLowerCase(), v);
    let lastError: Error | undefined;
    for (const version of ['v1', 'v1alpha']) {
        const def = loader.fromJSON(reflectionJson(version) as unknown as Parameters<typeof loader.fromJSON>[0], LOADER);
        const Svc = grpc.makeGenericClientConstructor(def[`grpc.reflection.${version}.ServerReflection`] as import('@grpc/grpc-js').ServiceDefinition, 'ServerReflection');
        const client = new Svc(target, creds);
        try {
            const ask = (req: Record<string, string>) => new Promise<Record<string, unknown>>((res, rej) => {
                const call = (client as unknown as { ServerReflectionInfo: (m: import('@grpc/grpc-js').Metadata, o: object) => import('@grpc/grpc-js').ClientDuplexStream<object, Record<string, unknown>> }).ServerReflectionInfo(md, { deadline: Date.now() + timeoutMs });
                call.on('data', (d) => { res(d); call.end(); });
                call.on('error', rej);
                call.write(req);
            });
            const list = await ask({ listServices: '*' });
            if (list.errorResponse) throw new Error(String((list.errorResponse as { errorMessage: string }).errorMessage));
            const services = ((list.listServicesResponse as { service: Array<{ name: string }> })?.service ?? []).map((s) => s.name).filter((n) => !n.startsWith('grpc.reflection.'));
            if (!symbol) return { services };
            const files = await ask({ fileContainingSymbol: symbol });
            if (files.errorResponse) throw new Error(`The server does not know ${symbol}: ${(files.errorResponse as { errorMessage: string }).errorMessage}`);
            const fds = ((files.fileDescriptorResponse as { fileDescriptorProto: Buffer[] })?.fileDescriptorProto ?? []);
            // A FileDescriptorSet: field 1 (length-delimited) per file.
            const parts: Buffer[] = [];
            for (const f of fds) {
                const len: number[] = [];
                let n = f.length;
                do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; len.push(b); } while (n);
                parts.push(Buffer.from([0x0a, ...len]), Buffer.from(f));
            }
            return { services, definition: loader.loadFileDescriptorSetFromBuffer(Buffer.concat(parts), LOADER) };
        } catch (e) {
            lastError = e as Error;
            if (!/unimplemented|12 UNIMPLEMENTED/i.test(lastError.message)) break;
        } finally { client.close(); }
    }
    throw new Error(`Server reflection failed: ${lastError?.message ?? 'no answer'}. Choose the service's .proto file instead.`);
}

/** The services and methods of a .proto file of the project (for the editor). */
export async function grpcServicesOf(definition: import('@grpc/proto-loader').PackageDefinition): Promise<Array<{ service: string; methods: Array<{ name: string; requestStream: boolean; responseStream: boolean; request: string; response: string }> }>> {
    const out: Array<{ service: string; methods: Array<{ name: string; requestStream: boolean; responseStream: boolean; request: string; response: string }> }> = [];
    for (const [name, d] of Object.entries(definition)) {
        if ((d as { format?: string }).format) continue;
        const methods = Object.entries(d as Record<string, { requestStream: boolean; responseStream: boolean; requestType?: { type?: { name?: string } }; responseType?: { type?: { name?: string } } }>)
            .map(([m, x]) => ({ name: m, requestStream: x.requestStream, responseStream: x.responseStream, request: x.requestType?.type?.name ?? '', response: x.responseType?.type?.name ?? '' }));
        if (methods.length && !name.startsWith('grpc.reflection.')) out.push({ service: name, methods });
    }
    return out;
}

export async function loadProto(projectRoot: string, rel: string): Promise<import('@grpc/proto-loader').PackageDefinition> {
    const loader = await import('@grpc/proto-loader');
    const root = path.resolve(projectRoot);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) throw new Error('The .proto file must be in the project.');
    if (!fs.existsSync(file)) throw new Error(`No file ${rel}.`);
    return loader.load(file, { ...LOADER, includeDirs: [path.dirname(file), root] });
}

/** A sample request message (JSON) for a method: the fields of its request type with default values. */
export function sampleMessage(definition: import('@grpc/proto-loader').PackageDefinition, service: string, method: string): string {
    const d = (definition[service] as Record<string, { requestType?: { type?: { field?: Array<{ name: string; type: string; label?: string; typeName?: string }> } } }> | undefined)?.[method];
    const fields = d?.requestType?.type?.field ?? [];
    const v = (f: { type: string; label?: string }) => {
        const x = /TYPE_(U?INT|SINT|FIXED|SFIXED)(32|64)|TYPE_(DOUBLE|FLOAT)/.test(f.type) ? 0 : f.type === 'TYPE_BOOL' ? false : f.type === 'TYPE_MESSAGE' ? {} : '';
        return f.label === 'LABEL_REPEATED' ? [] : x;
    };
    return JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, v(f)])), null, 2);
}

async function grpcT(c: MsgContext, sink: Sink): Promise<Transport> {
    const grpc = await import('@grpc/grpc-js');
    const o = c.options;
    if (!o.service || !o.method) throw new Error('Choose the gRPC service and method.');
    let def: import('@grpc/proto-loader').PackageDefinition;
    const metadata = Object.fromEntries(Object.entries(c.headers).filter(([k]) => !own.test(k)));
    if (o.protoFile?.trim()) def = await loadProto(c.projectRoot ?? process.cwd(), o.protoFile);
    else if (o.reflection) { const r = await grpcReflect(c.url, o.service, c.timeoutMs, c.conn, metadata); def = r.definition!; }
    else throw new Error('Choose the .proto file of the service, or use the server\'s reflection.');
    const svc = def[o.service] as Record<string, { path: string; requestStream: boolean; responseStream: boolean; requestSerialize: (x: unknown) => Buffer; responseDeserialize: (b: Buffer) => unknown }> | undefined;
    if (!svc) throw new Error(`No service ${o.service} (${Object.keys(def).filter((k) => !(def[k] as { format?: string }).format).join(', ') || 'none'}).`);
    const m = svc[o.method];
    if (!m) throw new Error(`${o.service} has no method ${o.method} (${Object.keys(svc).join(', ')}).`);
    const { target } = grpcTarget(c.url);
    const client = new grpc.Client(target, await grpcCredentials(c.url, c.conn));
    const md = new grpc.Metadata();
    for (const [k, v] of Object.entries(metadata)) md.set(k.toLowerCase(), v);
    const kind = m.requestStream ? (m.responseStream ? 'bidi' : 'client') : (m.responseStream ? 'server' : 'unary');
    type Call = { write?: (x: unknown) => void; end?: () => void; cancel: () => void };
    let call: Call | undefined;
    let ended = false;
    const ser = (x: unknown) => m.requestSerialize(x), des = (b: Buffer) => m.responseDeserialize(b);
    const opts = { deadline: Date.now() + Math.max(c.timeoutMs, 1000) * 4 };
    const fail = (e: import('@grpc/grpc-js').ServiceError) => sink.closed(`gRPC status ${e.code} ${grpc.status[e.code] ?? ''}${e.details ? `: ${e.details}` : ''}`);
    const status = (s: import('@grpc/grpc-js').StatusObject) => { if (s.code === grpc.status.OK) sink.info('gRPC status 0 OK'); };
    const streaming = (s: import('@grpc/grpc-js').ClientReadableStream<unknown> | import('@grpc/grpc-js').ClientDuplexStream<unknown, unknown>) => {
        s.on('data', (d) => sink.message({ text: JSON.stringify(d) }));
        s.on('error', (e) => fail(e as import('@grpc/grpc-js').ServiceError));
        s.on('status', status);
        s.on('end', () => sink.closed('the server ended the stream'));
    };
    const start = (first?: unknown) => {
        if (kind === 'unary') {
            const u = client.makeUnaryRequest(m.path, ser, des, first, md, opts, (e, r) => { if (e) fail(e); else { sink.message({ text: JSON.stringify(r) }); sink.closed('the call finished'); } });
            u.on('status', status);
            call = u;
        } else if (kind === 'server') { const s = client.makeServerStreamRequest(m.path, ser, des, first, md, opts); streaming(s); call = s; }
        else if (kind === 'client') {
            const s = client.makeClientStreamRequest(m.path, ser, des, md, opts, (e, r) => { if (e) fail(e); else { sink.message({ text: JSON.stringify(r) }); sink.closed('the call finished'); } });
            s.on('status', status);
            call = s;
        } else { const s = client.makeBidiStreamRequest(m.path, ser, des, md, opts); streaming(s); call = s; }
    };
    return {
        connect: () => new Promise<void>((res, rej) => client.waitForReady(Date.now() + c.timeoutMs, (e) => (e ? rej(new Error(`Could not reach ${target}: ${e.message}`)) : res()))),
        send: async (t) => {
            let msg: unknown;
            try { msg = JSON.parse(t); } catch { throw new Error('A gRPC message is JSON (the fields of the request message).'); }
            if (kind === 'unary' || kind === 'server') {
                if (call) throw new Error(`${o.method} takes one request message.`);
                start(msg); return;
            }
            if (!call) start();
            if (ended) throw new Error('The requests were already ended (an expected message came first).');
            call!.write!(msg);
        },
        beforeExpect: () => { if (kind === 'client' && !ended) { if (!call) start(); call!.end!(); ended = true; } },
        close: async () => { try { if (kind === 'bidi' && call && !ended) call.end!(); } catch { /* closed */ } client.close(); },
    };
}

// ---- AMQP 1.0 (Azure Service Bus, JMS brokers)
/** Host, port, TLS and SASL credentials of an AMQP address (sb:// is Azure Service Bus: TLS on 5671). */
export function amqpTarget(url: string, headers: Record<string, string>): { host: string; port: number; tls: boolean; username?: string; password?: string } {
    const m = /^(amqps?|sb):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]+)(?::(\d+))?/i.exec(url.trim());
    if (!m) throw new Error(`An AMQP address is amqp://host:5672 (amqps:// for TLS, sb://namespace.servicebus.windows.net for Azure Service Bus); got ${url}.`);
    const tls = /^(amqps|sb)$/i.test(m[1]);
    const basic = basicOf(headers);
    const user = m[2] ? decodeURIComponent(m[2]) : basic?.username, pass = m[3] ? decodeURIComponent(m[3]) : basic?.password;
    return { host: m[4], port: m[5] ? Number(m[5]) : tls ? 5671 : 5672, tls, ...(user ? { username: user, password: pass ?? '' } : {}) };
}

function amqpBody(body: unknown): string {
    if (body && typeof body === 'object' && 'content' in (body as object) && Buffer.isBuffer((body as { content: unknown }).content)) return (body as { content: Buffer }).content.toString('utf8');
    return text(body ?? '');
}

async function amqpT(c: MsgContext, sink: Sink): Promise<Transport> {
    const mod = await import('rhea') as unknown as typeof import('rhea') & { default?: typeof import('rhea') };
    const rhea = typeof mod.create_container === 'function' ? mod : mod.default!;
    const t = amqpTarget(c.url, c.headers);
    const container = rhea.create_container({ id: `cs-studio-${Math.random().toString(16).slice(2, 10)}` });
    let conn: import('rhea').Connection | undefined;
    const senders = new Map<string, import('rhea').Sender>();
    const subs = (c.options.subscribe ?? []).map((x) => x.trim()).filter(Boolean);
    const opened = <T extends import('rhea').Sender | import('rhea').Receiver>(link: T, what: string) => new Promise<T>((res, rej) => {
        link.once(what === 'sender' ? 'sender_open' : 'receiver_open', () => res(link));
        link.once(what === 'sender' ? 'sender_error' : 'receiver_error', (ctx: import('rhea').EventContext) => rej(new Error(`${what === 'sender' ? 'Cannot send to' : 'Cannot receive from'} ${link.name}: ${(ctx as unknown as Record<string, { error?: { description?: string } } | undefined>)[what]?.error?.description ?? 'refused'}`)));
    });
    return {
        connect: () => new Promise<void>((res, rej) => {
            conn = container.connect({ host: t.host, port: t.port, hostname: t.host, reconnect: false, ...(t.username ? { username: t.username, password: t.password } : {}),
                ...(t.tls ? { transport: 'tls', servername: t.host, ...(c.conn?.ca ? { ca: c.conn.ca } : {}) } : {}) } as import('rhea').ConnectionOptions);
            conn.once('connection_open', async () => {
                try {
                    for (const a of subs) await opened(conn!.open_receiver({ source: { address: a }, name: a, autoaccept: true }), 'receiver');
                    if (subs.length) sink.info(`Receiving from ${subs.join(', ')}`);
                    res();
                } catch (e) { rej(e); }
            });
            conn.once('connection_error', (ctx) => rej(new Error(ctx.connection.error ? String((ctx.connection.error as { description?: string }).description ?? ctx.connection.error) : 'refused')));
            conn.once('disconnected', (ctx) => { rej(new Error((ctx as { error?: Error }).error?.message ?? 'disconnected')); sink.closed('disconnected'); });
            conn.on('message', (ctx) => sink.message({ topic: ctx.receiver?.source?.address, text: amqpBody(ctx.message?.body) }));
        }),
        send: async (body, step) => {
            const address = step.topic?.trim();
            if (!address) throw new Error('An AMQP message needs an address (the queue or topic).');
            let s = senders.get(address);
            if (!s) { s = await opened(conn!.open_sender({ target: { address }, name: `to-${address}` }), 'sender'); senders.set(address, s); }
            const json = (() => { try { JSON.parse(body); return true; } catch { return false; } })();
            await new Promise<void>((res, rej) => {
                const d = s!.send({ body: rhea.message.data_section(Buffer.from(body, 'utf8')), content_type: json ? 'application/json' : 'text/plain', message_id: rhea.generate_uuid(), ...(step.key ? { subject: step.key } : {}) } as import('rhea').Message);
                const done = (ctx: import('rhea').EventContext) => { if (ctx.delivery !== d) return; s!.removeListener('accepted', done); s!.removeListener('rejected', bad); s!.removeListener('released', bad); res(); };
                const bad = (ctx: import('rhea').EventContext) => { if (ctx.delivery !== d) return; s!.removeListener('accepted', done); s!.removeListener('rejected', bad); s!.removeListener('released', bad); rej(new Error(`The broker did not take the message (${(ctx.delivery?.remote_state as { error?: { description?: string } } | undefined)?.error?.description ?? 'rejected'})`)); };
                s!.on('accepted', done); s!.on('rejected', bad); s!.on('released', bad);
            });
        },
        close: async () => {
            if (!conn) return;
            const cn = conn;
            cn.removeAllListeners('disconnected');
            await new Promise<void>((res) => { const t2 = setTimeout(res, 2000); cn.once('connection_close', () => { clearTimeout(t2); res(); }); cn.once('disconnected', () => { clearTimeout(t2); res(); }); try { cn.close(); } catch { clearTimeout(t2); res(); } });
        },
    };
}

// ---- MCP (streamable HTTP)

/** The JSON-RPC call of a send: {"method": …, "params": …} as written, or {"tool": name, "arguments": {…}} as tools/call. */
export function mcpCall(textIn: string): { method: string; params?: unknown } {
    let x: Record<string, unknown>;
    try { x = JSON.parse(textIn); } catch { throw new Error('An MCP message is JSON: {"method": "tools/list"} or {"tool": "name", "arguments": {…}}.'); }
    if (typeof x.tool === 'string') return { method: 'tools/call', params: { name: x.tool, arguments: x.arguments ?? {} } };
    if (typeof x.method === 'string') return { method: x.method, ...(x.params !== undefined ? { params: x.params } : {}) };
    throw new Error('An MCP message has a "method" (tools/list, tools/call, resources/read, prompts/get …) or a "tool".');
}

async function mcpT(c: MsgContext, sink: Sink): Promise<Transport> {
    const u = new URL(c.url);
    if (!/^https?:$/.test(u.protocol)) throw new Error(`An MCP server address is http(s)://…/mcp (streamable HTTP); got ${c.url}.`);
    const headers = Object.fromEntries(Object.entries(c.headers).filter(([k]) => !own.test(k)));
    const agent = c.conn?.agentFor(u.href) as import('http').Agent | undefined;
    let client: McpClient | undefined;
    let ready = false;
    const timeoutMs = Math.max(c.timeoutMs, 1000) * 4;
    return {
        connect: async () => {
            // What the server sends on its own (notifications, its requests) is a message too, once connected.
            client = await McpClient.connect({ kind: 'http', url: c.url, headers, ...(agent ? { agent } : {}), ...(c.conn?.ca ? { ca: c.conn.ca } : {}) },
                { timeoutMs, onMessage: (m) => { if (ready && typeof m.method === 'string') sink.message({ topic: m.method, text: JSON.stringify(m) }); } });
            ready = true;
            sink.info(`MCP server ${client.serverLabel} (protocol ${client.server.protocol})`.replace(/\s+/g, ' '));
        },
        send: async (body) => {
            const call = mcpCall(body);
            // The answer arrives as a message (expected by the next step); errors of the call too.
            client!.requestMessage(call, timeoutMs).then((m) => sink.message({ topic: call.method, text: JSON.stringify(m) }),
                (e: Error) => sink.message({ topic: call.method, text: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: e.message } }) }));
        },
        close: async () => { await client?.close(); },
    };
}

// ---- SQL (a statement as an action)
async function sqlT(c: MsgContext, sink: Sink): Promise<Transport> {
    const alias = sqlAlias(c.url);
    const open = c.sqlOpen ?? sqlOpener({ config: c.config ?? {}, environment: c.environment, projectRoot: c.projectRoot, timeoutMs: c.timeoutMs });
    let conn: Awaited<ReturnType<SqlOpener>> | undefined;
    return {
        connect: async () => { conn = await open(alias); },
        send: async (sql) => { const r = await conn!.query(sql); sink.message({ topic: 'result', text: JSON.stringify(r) }); },
        close: async () => { await conn?.close(); },
    };
}

const TRANSPORTS: Record<Exclude<MsgProtocol, 'websocket'>, (c: MsgContext, s: Sink) => Promise<Transport>> = { socketio, mqtt: mqttT, kafka: kafkaT, grpc: grpcT, amqp: amqpT, mcp: mcpT, sql: sqlT };

/**
 * A connection in one of the protocols, driven step by step (the framework's steps use it; msgExchange runs a
 * request's steps with it): open, send, expect a message (text it contains, topic / event), close. Every message is
 * logged with its time.
 */
export class MsgSession {
    readonly log: WsLogEntry[] = [];
    private readonly inbox: Incoming[] = [];
    private wake: (() => void) | null = null;
    private closedWhy: string | null = null;
    private tr?: Transport;
    private readonly t0 = performance.now();
    constructor(readonly protocol: Exclude<MsgProtocol, 'websocket'>, private readonly c: MsgContext) {}
    get closed(): string | null { return this.closedWhy; }
    elapsed(): number { return Math.round(performance.now() - this.t0); }
    private add(dir: WsLogEntry['dir'], t: string) { if (this.log.length < MAX_LOG) this.log.push({ dir, t: this.elapsed(), text: shown(t) }); }
    async open(): Promise<void> {
        const sink: Sink = {
            message: (m) => { this.inbox.push(m); this.add('in', m.topic ? `[${m.topic}] ${m.text}` : m.text); this.wake?.(); },
            closed: (why) => { this.closedWhy = this.closedWhy ?? why; this.add('info', why); this.wake?.(); },
            info: (t) => this.add('info', t),
        };
        try {
            this.tr = await TRANSPORTS[this.protocol](this.c, sink);
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([this.tr.connect(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`no connection within ${this.c.timeoutMs} ms`)), this.c.timeoutMs); })]).finally(() => clearTimeout(timer));
        } catch (e) { await this.close(); throw new Error(`Could not connect to ${redactUrl(this.c.url)}: ${(e as Error).message}`); }
        this.add('info', `Connected to ${redactUrl(this.c.url)}`);
    }
    async send(body: string, step: Pick<WsStep, 'topic' | 'key'> = {}): Promise<void> {
        if (!this.tr) throw new Error('Cannot send: not connected');
        if (this.closedWhy) throw new Error(`Cannot send: ${this.closedWhy}`);
        try { await this.tr.send(body, { kind: 'send', text: body, ...step }); }
        catch (e) { throw new Error(`Cannot send: ${(e as Error).message}`); }
        this.add('out', step.topic ? `[${step.topic}] ${body}` : body);
    }
    /** The first message not taken by an earlier expectation that contains the text (from the topic / event). */
    async expect(body: string, topic: string | undefined, timeoutMs: number): Promise<Incoming> {
        this.tr?.beforeExpect?.();
        const match = (m: Incoming) => m.text.includes(body) && (!topic || (m.topic !== undefined && (this.protocol === 'mqtt' ? topicMatches(topic, m.topic) : m.topic === topic)));
        let found = -1;
        const ok = await new Promise<boolean>((resolve) => {
            const test = () => (found = this.inbox.findIndex(match)) >= 0;
            if (test() || this.closedWhy) return resolve(test());
            const timer = setTimeout(() => { this.wake = null; resolve(test()); }, timeoutMs);
            this.wake = () => { if (test() || this.closedWhy) { clearTimeout(timer); this.wake = null; resolve(test()); } };
        });
        if (!ok) throw new Error(`No message${topic ? ` on ${topic}` : ''}${body ? ` containing "${body}"` : ''} within ${timeoutMs} ms${this.closedWhy ? ` (${this.closedWhy})` : ''}`);
        const msg = this.inbox[found];
        this.inbox.splice(0, found + 1);
        return msg;
    }
    async close(): Promise<void> { try { await this.tr?.close(); } catch { /* closed */ } this.tr = undefined; }
}

/** A value of a JSON message (JSON path), as text. */
export function messageValue(m: Incoming, jsonPath: string): string | undefined {
    let value: unknown;
    try { value = readPath(JSON.parse(m.text), jsonPath); } catch { value = undefined; }
    if (value === undefined || value === null) return undefined;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

export async function msgExchange(protocol: Exclude<MsgProtocol, 'websocket'>, c: MsgContext, steps: WsStep[], v: Values): Promise<WsResult> {
    const session = new MsgSession(protocol, c);
    const res: WsResult = { connected: false, timeMs: 0, log: session.log, steps: [], saved: {} };
    const done = async () => { await session.close(); res.timeMs = session.elapsed(); return res; };
    try { await session.open(); } catch (e) { res.error = (e as Error).message; return done(); }
    res.connected = true;
    const vals: Values = { ...v, vars: { ...v.vars } };
    const stepFail = async (i: number, why: string) => { res.steps.push({ step: i + 1, pass: false, message: why }); res.error = why; return done(); };
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const missing = new Set<string>();
        const body = fill(s.text, vals, missing);
        const topic = s.topic ? fill(s.topic, vals, missing) : undefined;
        const key = s.key ? fill(s.key, vals, missing) : undefined;
        if (missing.size) return stepFail(i, `Not filled in: ${[...missing].join(', ')}`);
        if (s.kind === 'send') {
            try { await session.send(body, { topic, key }); } catch (e) { return stepFail(i, (e as Error).message); }
            res.steps.push({ step: i + 1, pass: true, message: topic ? `Sent to ${topic}` : 'Sent' });
            continue;
        }
        let msg: Incoming;
        try { msg = await session.expect(body, topic, s.timeoutMs ?? c.timeoutMs); } catch (e) { return stepFail(i, (e as Error).message); }
        if (s.save?.variable && s.save.path) {
            const str = messageValue(msg, s.save.path);
            if (str === undefined) return stepFail(i, `The message has no ${s.save.path} to save as ${s.save.variable}`);
            res.saved[s.save.variable] = str; vals.vars[s.save.variable] = str;
        }
        res.steps.push({ step: i + 1, pass: true, message: `Received a message${topic ? ` on ${msg.topic}` : ''}${body ? ` containing "${body}"` : ''}` });
    }
    return done();
}

/** A request's message exchange in its protocol (WebSocket by default). */
export async function runExchange(x: import('./model').WsExchange, p: { url: string; headers: Record<string, string> }, v: Values, timeoutMs: number, conn?: Connection, projectRoot?: string, more: { environment?: string; sqlOpen?: SqlOpener } = {}): Promise<WsResult> {
    const protocol = x.protocol ?? 'websocket';
    if (protocol === 'websocket') { const { wsExchange } = await import('./ws'); return wsExchange(p, x.steps, v, timeoutMs, conn); }
    return msgExchange(protocol, { url: p.url, headers: p.headers, options: x.options ?? {}, timeoutMs, conn, projectRoot, config: v.config, ...more }, x.steps, v);
}

export { PROTOCOL_LABEL } from './model';
