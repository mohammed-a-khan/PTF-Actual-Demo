import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { secretUsage } from '../src/secrets/usage';

test('secret usage: configuration per environment, features, API collections, load scenarios, tool servers; age; names read but not stored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secuse-'));
    try {
        const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
        w('config/shop/common/common.env', 'PROJECT=shop\n');
        w('config/shop/environments/qa.env', 'DB_PASSWORD={env:QA_DB_PASSWORD}\nAPI_KEY={env:SHOP_API_KEY}\n');
        w('config/shop/environments/uat.env', 'DB_PASSWORD={env:UAT_DB_PASSWORD}\n');
        w('test/shop/features/login.feature', 'Feature: L\n  Scenario: S\n    Given I sign in with "{env:SHOP_USER_PASSWORD}"\n  # {env:IN_A_COMMENT}\n');
        w('test/shop/api/shop.collection.json', '{\n "auth": { "token": "{secret:SHOP_API_KEY}" }\n}\n');
        w('test/shop/load/checkout.load.json', '{\n "headers": "{env:LOAD_TOKEN}"\n}\n');
        w('.cs-studio/mcp-servers.json', '{ "servers": { "db": { "env": { "PW": "{secret:MCP_DB_PW}" } } } }\n');
        w('node_modules/x/y.collection.json', '{ "a": "{env:NOT_THIS}" }');
        const old = new Date(Date.now() - 120 * 86_400_000).toISOString(), recent = new Date().toISOString();
        const r = secretUsage(dir, [
            { name: 'QA_DB_PASSWORD', env: 'qa', createdAt: old, updatedAt: old, length: 8 },
            { name: 'SHOP_API_KEY', createdAt: recent, updatedAt: recent, length: 8 },
            { name: 'UNUSED_TOKEN', createdAt: recent, updatedAt: recent, length: 8 },
        ]);
        const by = Object.fromEntries(r.secrets.map((s) => [s.name, s]));
        assert.deepEqual(by.QA_DB_PASSWORD.uses.map((u) => [u.where, u.file, u.env, u.key]), [['config', 'config/shop/environments/qa.env', 'qa', 'DB_PASSWORD']]);
        assert.equal(by.QA_DB_PASSWORD.rotate, true);
        assert.equal(by.QA_DB_PASSWORD.ageDays, 120);
        assert.deepEqual(by.SHOP_API_KEY.uses.map((u) => `${u.where}:${u.file}:${u.line}`).sort(), ['api:test/shop/api/shop.collection.json:2', 'config:config/shop/environments/qa.env:2']);
        assert.equal(by.SHOP_API_KEY.rotate, false);
        assert.deepEqual(by.UNUSED_TOKEN.uses, []);
        assert.deepEqual(r.missing.map((m) => m.name), ['LOAD_TOKEN', 'MCP_DB_PW', 'SHOP_USER_PASSWORD', 'UAT_DB_PASSWORD']);
        assert.equal(r.missing.find((m) => m.name === 'SHOP_USER_PASSWORD')!.uses[0].line, 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
