import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import './support/browser-stub';
import { tagFinalName, tagNameProblem } from '../src/pages/Branches';
import { swapSides } from '../src/components/ConflictView';
import { askChangedElsewhere } from '../src/components/ChangedElsewhere';
import { parseConflicts, resolveConflicts } from '../../src/git/conflicts';
import { ApiError } from '../src/api';

test('tag name: spaces become "-" (shown before it is created), and the rules apply to that name', () => {
    assert.equal(tagFinalName(' a b '), 'a-b');
    assert.equal(tagFinalName('v1.0'), 'v1.0');
    assert.equal(tagNameProblem(tagFinalName('a b'), [], []), null);
    assert.match(tagNameProblem(tagFinalName('a b'), [], ['a-b'])!, /exists already/);
});

test('a pull whose edits clashed: sides shown the other way round, the written text unchanged', () => {
    const text = 'x\n<<<<<<< Updated upstream\npulled\n=======\nmine\n>>>>>>> Stashed changes\ny\n';
    const p = swapSides(parseConflicts(text));
    const seg = p.segments[1] as { ours: string[]; theirs: string[]; oursLabel: string; theirsLabel: string };
    assert.deepEqual(seg.ours, ['mine']);
    assert.deepEqual(seg.theirs, ['pulled']);
    assert.equal(seg.theirsLabel, 'Updated upstream');
    assert.equal(resolveConflicts(p, ['ours']), 'x\nmine\ny\n');
    assert.equal(resolveConflicts(p, ['theirs']), 'x\npulled\ny\n');
});

test('changed elsewhere: Keep editing says the next Save replaces the other version; a second question is not stacked', () => {
    const shown: Array<{ title: string; content: unknown }> = [];
    let closeFirst: (() => void) | undefined;
    const modal = { confirm: (c: { title: string; content: unknown; afterClose?: () => void }) => { shown.push(c); closeFirst ??= c.afterClose; return { destroy: () => c.afterClose?.(), update: () => undefined }; } } as unknown as Parameters<typeof askChangedElsewhere>[0];
    const e = new ApiError('Changed in another tab', 409, 'stale');
    const o = { reload: () => undefined, overwrite: () => undefined, keepEditing: () => undefined, keepOverwrites: true };
    askChangedElsewhere(modal, e, 'The query q.sql', o);
    askChangedElsewhere(modal, e, 'The query q.sql', o);
    assert.equal(shown.length, 1, 'a double click on Save asks once');
    const flat = (n: unknown): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(flat).join('') : n && typeof n === 'object' && 'props' in n ? flat((n as { props: { children?: unknown } }).props.children) : '';
    assert.match(flat(shown[0].content), /your next Save will replace the version saved elsewhere/);
    closeFirst!();
    askChangedElsewhere(modal, e, 'The query q.sql', { reload: () => undefined, overwrite: () => undefined });
    assert.equal(shown.length, 2, 'asked again once the first question is closed');
    assert.doesNotMatch(flat(shown[1].content), /next Save will replace/);
});
