import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { variableScopes, scriptSets } from '../src/api/scopes';
import { prepare } from '../src/api/send';
import { withGlobals } from '../src/api/scripts';
import type { ApiCollection, ApiRequest } from '../src/api/model';

const req = (id: string, url: string, extra: Partial<ApiRequest> = {}): ApiRequest => ({ kind: 'request', id, name: id, method: 'GET', url, query: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' } as ApiRequest['auth'], checks: [], extract: [], ...extra });

test('variable scopes: the scope each value comes from, what it hides, who uses and sets it; globals are the lowest scope of {{name}}', () => {
    const c: ApiCollection = { format: 'cs-studio-api/1', name: 'Orders', baseUrl: '{config:API_URL}', auth: { type: 'bearer', token: '{{token}}' } as ApiCollection['auth'],
        variables: [{ key: 'region', value: 'eu' }, { key: 'token', value: 'from-collection' }, { key: 'apiKey', value: '{env:PARTNER_KEY}', secret: true }, { key: 'unused', value: 'x' }],
        scripts: { pre: "pm.globals.set('traceId', 'g-1');" },
        items: [
            req('Login', '/login', { extract: [{ variable: 'token', from: 'json', path: '$.token' }], scripts: { test: "pm.environment.set('userId', '7'); postman.setGlobalVariable('tenant', 't1');" } }),
            req('Order', '/orders/{{orderId}}?r={{region}}&u={{userId}}&t={{traceId}}', { headers: [{ key: 'X-Key', value: '{{apiKey}}' }, { key: 'X-Env', value: '{env:HOME_DIR}' }] }),
        ] };
    const values = { vars: { region: 'eu', token: 'from-collection', apiKey: 'k-secret', unused: 'x' }, config: { API_URL: 'https://api.test' }, env: { PARTNER_KEY: 'k-secret' } };
    const e = Object.fromEntries(variableScopes(c, values, { token: 'tok-live', userId: '7' }, { traceId: 'g-1', region: 'us' }, ['PARTNER_KEY']).map((x) => [x.ref, x]));
    assert.equal(e['{{token}}'].from, 'saved');
    assert.deepEqual(e['{{token}}'].shadowed, [{ from: 'collection', value: 'from-collection' }]);
    assert.deepEqual(e['{{token}}'].usedBy, ['Collection auth']);
    assert.deepEqual(e['{{token}}'].setBy, ['Login (saved from the response)']);
    assert.deepEqual([e['{{region}}'].from, e['{{region}}'].value, e['{{region}}'].shadowed], ['collection', 'eu', [{ from: 'global', value: 'us' }]]);
    assert.deepEqual([e['{{traceId}}'].from, e['{{traceId}}'].setBy], ['global', ['Collection script (global)']]);
    assert.deepEqual([e['{{orderId}}'].from, e['{{orderId}}'].usedBy], ['missing', ['Order']]);
    assert.deepEqual(e['{{userId}}'].setBy, ['Login (script)']);
    assert.deepEqual(e['{{tenant}}'].setBy, ['Login (script, global)']);
    assert.equal(e['{{apiKey}}'].secret, true);
    assert.deepEqual([e['{config:API_URL}'].from, e['{config:API_URL}'].usedBy], ['config', ['Base URL']]);
    assert.equal(e['{env:PARTNER_KEY}'].secret, true);
    assert.equal(e['{env:HOME_DIR}'].from, 'missing');
    assert.deepEqual(e['{{unused}}'].usedBy, []);
    assert.deepEqual(scriptSets("pm.variables.set(\"a\", 1); pm.collectionVariables.set(`b`, 2)").map((x) => x.name), ['a', 'b']);
    // {{traceId}} only in the globals: the request still gets it; a collection value wins over a global.
    const p = prepare(c, c.items[1] as ApiRequest, withGlobals({ ...values, vars: { ...values.vars, orderId: '5', userId: '7' } }, { traceId: 'g-1', region: 'us' }));
    assert.equal(p.url, 'https://api.test/orders/5?r=eu&u=7&t=g-1');
});
