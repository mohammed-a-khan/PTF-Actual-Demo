import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { codeTarget } from '../src/codeRoute';

test('a Code address with plain slashes names the same file as the encoded one', () => {
    assert.deepEqual(codeTarget(['test/qa5/x.feature']), { path: 'test/qa5/x.feature', typed: false });
    assert.deepEqual(codeTarget(['test/qa5/x.feature', '12']), { path: 'test/qa5/x.feature', line: 12, typed: false });
    assert.deepEqual(codeTarget(['test', 'qa5', 'x.feature']), { path: 'test/qa5/x.feature', typed: true });
    assert.deepEqual(codeTarget(['test', 'qa5', 'x.feature', '7']), { path: 'test/qa5/x.feature', line: 7, typed: true });
    assert.deepEqual(codeTarget(['README.md']), { path: 'README.md', typed: false });
    assert.deepEqual(codeTarget(['docs', 'a.md']), { path: 'docs/a.md', typed: true });
    assert.deepEqual(codeTarget([]), { path: '', typed: false });
});
