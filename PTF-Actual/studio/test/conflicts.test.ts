import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseConflicts, resolveConflicts } from '../src/git/conflicts';

const file = ['A=1', '<<<<<<< HEAD', 'TIMEOUT=45000', '=======', 'TIMEOUT=60000', '>>>>>>> feature/t', 'B=2', '<<<<<<< HEAD', 'X=ours', '||||||| base', 'X=base', '=======', 'X=theirs', 'Y=theirs', '>>>>>>> feature/t', ''].join('\r\n');

test('parse conflict blocks (incl. diff3 base) and keep CRLF', () => {
    const p = parseConflicts(file);
    assert.equal(p.conflicts, 2);
    assert.equal(p.eol, '\r\n');
    const c = p.segments.filter((s) => s.kind === 'conflict');
    assert.deepEqual(c.map((s) => s.kind === 'conflict' && [s.ours, s.theirs, s.base, s.theirsLabel, s.startLine]), [
        [['TIMEOUT=45000'], ['TIMEOUT=60000'], null, 'feature/t', 2],
        [['X=ours'], ['X=theirs', 'Y=theirs'], ['X=base'], 'feature/t', 8],
    ]);
});

test('resolve per block', () => {
    const p = parseConflicts(file);
    assert.equal(resolveConflicts(p, ['theirs', 'both']), ['A=1', 'TIMEOUT=60000', 'B=2', 'X=ours', 'X=theirs', 'Y=theirs', ''].join('\r\n'));
    assert.equal(resolveConflicts(p, ['ours', { custom: 'X=merged' }]), ['A=1', 'TIMEOUT=45000', 'B=2', 'X=merged', ''].join('\r\n'));
    assert.throws(() => resolveConflicts(p, ['ours']));
});

test('malformed markers stay as text; no final newline preserved', () => {
    const p = parseConflicts('a\n<<<<<<< HEAD\nb\nc');
    assert.equal(p.conflicts, 0);
    assert.equal(resolveConflicts(p, []), 'a\n<<<<<<< HEAD\nb\nc');
});

test('three panes stay aligned row for row', async () => {
    const { alignPanes } = await import('../src/git/conflicts');
    const p = parseConflicts(file);
    const a = alignPanes(p, [undefined, 'both']);
    assert.equal(a.theirs.length, a.mine.length);
    assert.equal(a.mine.length, a.merged.length);
    // block 0 undecided: merged shows one "unresolved" row, padded to the taller side
    const b0 = a.merged.filter((r) => r.block === 0);
    assert.ok(b0.every((r) => r.unresolved));
    // block 1 'both' = ours (1) + theirs (2) = 3 merged rows; theirs padded to 3, mine padded to 3
    assert.deepEqual(a.merged.filter((r) => r.block === 1).map((r) => r.text), ['X=ours', 'X=theirs', 'Y=theirs']);
    assert.equal(a.mine.filter((r) => r.block === 1 && r.filler).length, 2);
    assert.equal(a.theirs.filter((r) => r.block === 1 && r.filler).length, 1);
    // line numbers continue correctly after a block
    assert.equal(a.mine.find((r) => r.text === 'B=2')!.line, 3);
    assert.equal(a.theirs.find((r) => r.text === 'B=2')!.line, 3);
    assert.equal(resolveConflicts(p, ['theirs-first', 'ours']).split('\r\n')[1], 'TIMEOUT=60000');
});

test('non-default conflict marker size (conflict-marker-size=10)', () => {
    const text = ['a', '<<<<<<<<<< HEAD', 'ours', '<<<<<<< not a marker', '==========', '=======', '>>>>>>>>>> topic', 'b', ''].join('\n');
    const p = parseConflicts(text);
    assert.equal(p.conflicts, 1);
    const c = p.segments.find((s) => s.kind === 'conflict');
    assert.ok(c && c.kind === 'conflict');
    assert.deepEqual([c.ours, c.theirs, c.oursLabel, c.theirsLabel], [['ours', '<<<<<<< not a marker'], ['======='], 'HEAD', 'topic']);
    assert.equal(resolveConflicts(p, ['theirs']), 'a\n=======\nb\n');
});
