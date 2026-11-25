/**
 * Protocol users: AMQP 1.0 (Azure Service Bus, JMS brokers), MCP servers over streamable HTTP and SQL statements as
 * actions, in Send / the runner (msgExchange) and under load (the engine). A small AMQP broker (rhea) and MCP server
 * run in the test; SQL runs on a lab PostgreSQL when CS_LAB_PG is set (host:port/database/user/password).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { broker, mcpServer } from './protocolLab';
import { amqpTarget, mcpCall, msgExchange } from '../src/api/messaging';
import { sqlAlias } from '../src/api/sqlAction';
import { LoadEngine } from '../src/load/engine';
import { newScenario } from '../src/load/scenario';
import { ApiRequest, newRequest, WsStep } from '../src/api/model';

const V = { vars: {}, config: {}, env: {} };
const basic = (u: string, p: string) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });

test('addresses: AMQP (Azure Service Bus sb://, credentials), MCP calls, database aliases', () => {
    assert.deepEqual(amqpTarget('sb://shop-lab.servicebus.windows.net', basic('RootManageSharedAccessKey', 'a/b=')), { host: 'shop-lab.servicebus.windows.net', port: 5671, tls: true, username: 'RootManageSharedAccessKey', password: 'a/b=' });
    assert.deepEqual(amqpTarget('amqp://app:p%40ss@mq.lab:5673', {}), { host: 'mq.lab', port: 5673, tls: false, username: 'app', password: 'p@ss' });
    assert.throws(() => amqpTarget('http://x', {}), /An AMQP address/);
    assert.deepEqual(mcpCall('{"tool":"add","arguments":{"a":1}}'), { method: 'tools/call', params: { name: 'add', arguments: { a: 1 } } });
    assert.deepEqual(mcpCall('{"method":"tools/list"}'), { method: 'tools/list' });
    assert.throws(() => mcpCall('{"x":1}'), /has a "method"/);
    assert.equal(sqlAlias('db://orders'), 'ORDERS');
    assert.throws(() => sqlAlias('db://a b'), /db:\/\/ALIAS/);
});

test('AMQP: SASL sign-in, send to a queue, receive it, save a value; a wrong key is refused', async () => {
    const b = await broker();
    try {
        const steps: WsStep[] = [
            { kind: 'send', text: '{"orderId":"A-17","total":42}', topic: 'orders', key: 'created' },
            { kind: 'expect', text: '"orderId"', topic: 'orders', timeoutMs: 3000, save: { variable: 'orderId', path: '$.orderId' } },
        ];
        const ok = await msgExchange('amqp', { url: `amqp://127.0.0.1:${b.port}`, headers: basic('RootManageSharedAccessKey', 'k3y='), options: { subscribe: ['orders'] }, timeoutMs: 3000 }, steps, V);
        assert.equal(ok.error, undefined, JSON.stringify(ok.log));
        assert.deepEqual(ok.saved, { orderId: 'A-17' });
        assert.deepEqual(b.received, ['orders#created']);
        const bad = await msgExchange('amqp', { url: `amqp://RootManageSharedAccessKey:wr0ng@127.0.0.1:${b.port}`, headers: {}, options: {}, timeoutMs: 3000 }, steps.slice(0, 1), V);
        assert.match(bad.error ?? '', /Could not connect to amqp:\/\/RootManageSharedAccessKey:\*\*\*@/);
        assert.ok(!JSON.stringify(bad).includes('wr0ng'), 'the password in the address is hidden');
    } finally { b.close(); }
});

test('MCP: initialize with a session, call a tool (event stream), list tools, errors come back as messages, session ended', async () => {
    const m = await mcpServer();
    try {
        const r = await msgExchange('mcp', { url: m.url, headers: {}, options: {}, timeoutMs: 3000 }, [
            { kind: 'send', text: '{"tool":"add","arguments":{"a":2,"b":3}}' },
            { kind: 'expect', text: '"result"', topic: 'tools/call', timeoutMs: 3000, save: { variable: 'sum', path: '$.result.content[0].text' } },
            { kind: 'send', text: '{"method":"tools/list"}' },
            { kind: 'expect', text: '"add"', topic: 'tools/list', timeoutMs: 3000 },
            { kind: 'send', text: '{"method":"nope/x"}' },
            { kind: 'expect', text: 'Unknown method', timeoutMs: 3000 },
        ], V);
        assert.equal(r.error, undefined, JSON.stringify(r.log));
        assert.deepEqual(r.saved, { sum: '5' });
        assert.ok(r.log.some((l) => /lab-tools 1\.2/.test(l.text)));
        assert.ok(r.log.some((l) => /notifications\/progress/.test(l.text)), 'server notifications are received too');
        assert.deepEqual(m.deleted, ['s1']);
    } finally { m.close(); }
});

test('under load: AMQP, MCP (and SQL on the lab database) as requests of a user path', async () => {
    const b = await broker(), m = await mcpServer();
    const pg = process.env.CS_LAB_PG ? /^([^:]+):(\d+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(process.env.CS_LAB_PG) : null;
    try {
        const req = (id: string, url: string, ws: ApiRequest['ws']): ApiRequest => ({ ...newRequest(id, id), url, checks: [], ws });
        const requests = [
            req('amqp', `amqp://RootManageSharedAccessKey:k3y%3D@127.0.0.1:${b.port}`, { protocol: 'amqp', options: { subscribe: ['jobs'] }, steps: [{ kind: 'send', text: '{"job":"nightly"}', topic: 'jobs' }, { kind: 'expect', text: '"job"', topic: 'jobs', timeoutMs: 3000 }] }),
            req('mcp', m.url, { protocol: 'mcp', steps: [{ kind: 'send', text: '{"tool":"add","arguments":{"a":1,"b":1}}' }, { kind: 'expect', text: '"text":"2"', timeoutMs: 3000 }] }),
            ...(pg ? [req('sql', 'db://SHOP', { protocol: 'sql', steps: [
                { kind: 'send', text: "INSERT INTO lab_orders(name) VALUES ('load')" }, { kind: 'expect', text: '"affected":1', timeoutMs: 3000 },
                { kind: 'send', text: 'SELECT count(*)::int AS n FROM lab_orders' }, { kind: 'expect', text: '"n"', timeoutMs: 3000 },
            ] })] : []),
        ];
        const config: Record<string, string> = pg ? { DB_SHOP_TYPE: 'postgresql', DB_SHOP_HOST: pg[1], DB_SHOP_PORT: pg[2], DB_SHOP_DATABASE: pg[3], DB_SHOP_USERNAME: pg[4], DB_SHOP_PASSWORD: pg[5] } : {};
        if (pg) {
            const r = await msgExchange('sql', { url: 'db://SHOP', headers: {}, options: {}, timeoutMs: 3000, config, environment: 'qa' }, [{ kind: 'send', text: 'DROP TABLE IF EXISTS lab_orders; CREATE TABLE lab_orders(id serial primary key, name text)' }], V);
            assert.equal(r.error, undefined);
            // A production-like environment only reads.
            const prod = await msgExchange('sql', { url: 'db://SHOP', headers: {}, options: {}, timeoutMs: 3000, config, environment: 'prod' }, [{ kind: 'send', text: "DELETE FROM lab_orders WHERE name = 'x'" }], V);
            assert.match(prod.error ?? '', /Only reads run here: "prod" looks like a production environment/);
        }
        const r = await new LoadEngine({ // credentials in the address are not shown in samples

            scenario: { ...newScenario('p', 'test/p/api/a.collection.json'), thinkTime: { min: 0, max: 0 }, slas: [], policy: { type: 'constant', users: 3, duration: 2 } },
            collection: { baseUrl: '', auth: { type: 'none' } }, requests, values: { vars: {}, config, env: {} }, rows: [], environment: 'qa',
        }).run();
        const tx = Object.fromEntries(r.transactions.map((t) => [t.name, t]));
        assert.equal(r.total.errors, 0, JSON.stringify(r.transactions.filter((t) => t.errors).map((t) => [t.name, t.topErrors])));
        assert.ok(tx.amqp.count >= 3 && tx.mcp.count >= 3, JSON.stringify(Object.keys(tx)));
        assert.ok(b.received.length >= tx.amqp.count, 'every user sent its message through the broker');
        assert.ok(m.sessions.size >= 3, 'each exchange has its own MCP session');
        if (pg) assert.ok(tx.sql.count >= 3);
        assert.ok(!JSON.stringify(r).includes('k3y'), 'the AMQP password is hidden');
    } finally { b.close(); m.close(); }
});
