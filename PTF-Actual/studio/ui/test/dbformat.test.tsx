/** Database results as text (ui/src/dbFormat.ts): CSV that spreadsheets open safely. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cellString, csvText } from '../src/dbFormat';

test('CSV: quoting, NULL as empty, dates/JSON/binary as text', () => {
    const t = csvText([{ name: 'id', type: 'integer' }, { name: 'note', type: 'string' }, { name: 'at', type: 'date' }, { name: 'raw', type: 'binary' }],
        [[1, 'a, "b"\nc', { $t: 'date', v: '2026-01-02T00:00:00.000Z' }, { $t: 'bin', v: 'ff00', n: 2 }], [2, null, null, null]]);
    assert.equal(t, 'id,note,at,raw\r\n1,"a, ""b""\nc",2026-01-02T00:00:00.000Z,0xff00\r\n2,,,');
    assert.equal(cellString({ $t: 'text', v: 'abc', n: 99999 }), 'abc');
});

test('CSV: text a spreadsheet would run as a formula is prefixed with \', numbers are not', () => {
    const t = csvText([{ name: 'v', type: 'string' }], [['=HYPERLINK("http://x","click")'], ['+cmd|x'], ['-2+3'], ['@SUM(A1)'], ['\t=1'], ['-12.5'], ['+3'], [-7], ['plain']]);
    assert.deepEqual(t.split('\r\n').slice(1), ['"\'=HYPERLINK(""http://x"",""click"")"', "'+cmd|x", "'-2+3", "'@SUM(A1)", "'\t=1", '-12.5', '+3', '-7', 'plain']);
});
