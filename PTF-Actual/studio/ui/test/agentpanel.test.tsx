import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { tokens, toItems } from '../src/agentEvents';
import type { AgentEventDef } from '../src/api';

const ev = (seq: number, e: Record<string, unknown>) => ({ seq, at: seq, ...e }) as AgentEventDef;

test('agent events become the conversation: streamed text joined, tools paired, approvals answered', () => {
    const items = toItems([
        ev(1, { type: 'user', text: 'Automate login' }),
        ev(2, { type: 'delta', text: 'I will ' }), ev(3, { type: 'delta', text: 'start.' }),
        ev(4, { type: 'tool-start', id: 't1', tool: 'browser_open', args: '{"url":"x"}' }),
        ev(5, { type: 'approval', id: 'a1', title: 'Save the test', detail: '+ a.feature', kind: 'code' }),
        ev(6, { type: 'tool-end', id: 't1', ok: true, result: 'opened' }),
        ev(7, { type: 'approval-done', id: 'a1', decision: 'session' }),
        ev(8, { type: 'delta', text: 'Do' }), ev(9, { type: 'assistant', text: 'Done.' }),
        ev(10, { type: 'error', text: 'boom' }), ev(11, { type: 'idle' }),
    ]);
    assert.deepEqual(items.map((i) => i.kind), ['user', 'assistant', 'tool', 'approval', 'assistant', 'note']);
    assert.equal((items[1] as { text: string }).text, 'I will start.');
    assert.deepEqual((items[2] as { done?: unknown }).done, { ok: true, result: 'opened' });
    assert.equal((items[3] as { decided?: string }).decided, 'session');
    assert.deepEqual([(items[4] as { text: string }).text, (items[4] as { streaming: boolean }).streaming], ['Done.', false]);
    assert.equal((items[5] as { error?: boolean }).error, true);
});

test('tokens: exact below 1000, then k and M', () => {
    assert.equal(tokens(0), 'no token count');
    assert.equal(tokens(640), '640 tokens');
    assert.equal(tokens(1234), '1.2k tokens');
    assert.equal(tokens(35400), '35k tokens');
    assert.equal(tokens(1250000), '1.3M tokens');
});
