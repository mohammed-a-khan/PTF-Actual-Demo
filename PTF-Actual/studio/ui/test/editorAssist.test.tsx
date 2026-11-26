import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { completionText, editBetween, ghostOf, inlineFits, needsDetails, nextWordLength, parseSnippet, snippetAfterEdit } from '../src/editor/assist';

test('snippets: text and tab stops ($1, ${1:name}, $0, escapes)', () => {
    const r = parseSnippet('replace(${1:searchValue}, ${2:replaceValue})$0');
    assert.equal(r.text, 'replace(searchValue, replaceValue)');
    assert.deepEqual(r.stops, [{ index: 1, start: 8, end: 19 }, { index: 2, start: 21, end: 33 }, { index: 0, start: 34, end: 34 }]);
    assert.deepEqual(parseSnippet('toUpperCase($0)'), { text: 'toUpperCase()', stops: [{ index: 0, start: 12, end: 12 }] });
    assert.deepEqual(parseSnippet('a\\$b\\}'), { text: 'a$b}', stops: [{ index: 0, start: 4, end: 4 }] }, 'no $0: the end');
    assert.deepEqual(parseSnippet('f($2, $1)').stops.map((s) => s.index), [1, 2, 0], 'visited in number order, $0 last');
});

test('snippet mode follows edits: typing in a placeholder grows it, later stops move, an edit outside ends it', () => {
    const m = { stops: [{ index: 1, start: 108, end: 119 }, { index: 2, start: 121, end: 133 }, { index: 0, start: 134, end: 134 }], cur: 0, start: 100, end: 134 };
    // "searchValue" selected, "'a'" typed over it.
    const a = snippetAfterEdit(m, 108, 11, 3)!;
    assert.deepEqual(a.stops, [{ index: 1, start: 108, end: 111 }, { index: 2, start: 113, end: 125 }, { index: 0, start: 126, end: 126 }]);
    assert.equal(a.end, 126);
    // Typing at the end of the current placeholder belongs to it.
    const b = snippetAfterEdit({ ...a, cur: 0 }, 111, 0, 2)!;
    assert.deepEqual(b.stops[0], { index: 1, start: 108, end: 113 });
    assert.deepEqual(b.stops[1], { index: 2, start: 115, end: 127 });
    assert.equal(snippetAfterEdit(m, 50, 0, 1), null, 'before the snippet');
    assert.equal(snippetAfterEdit(m, 135, 0, 1), null, 'after it');
    assert.deepEqual(editBetween('abc', 'abXc'), { at: 2, removed: 0, inserted: 1 });
    assert.deepEqual(editBetween('abc', 'ac'), { at: 1, removed: 1, inserted: 0 });
    assert.equal(editBetween('a', 'a'), null);
});

test('what a completion inserts: calls with parentheses and placeholders, names for the rest', () => {
    const method = { name: 'replace', kind: 'method' };
    const ctx = { nextChar: '', lineBefore: '        value.' };
    assert.deepEqual(completionText(method, { snippet: 'replace(${1:searchValue}, ${2:replaceValue})$0' }, ctx), { text: 'replace(${1:searchValue}, ${2:replaceValue})$0', snippet: true });
    assert.deepEqual(completionText({ name: 'toUpperCase', kind: 'method' }, null, ctx), { text: 'toUpperCase($0)', snippet: true }, 'no signature yet: the caret between the parentheses');
    assert.deepEqual(completionText(method, { snippet: 'replace($0)' }, { ...ctx, nextChar: '(' }), { text: 'replace', snippet: false }, 'a "(" follows already');
    assert.deepEqual(completionText({ name: 'readFile', kind: 'function' }, { snippet: 'readFile(${1:p})$0' }, { nextChar: '', lineBefore: 'import { ' }), { text: 'readFile', snippet: false }, 'an import list');
    assert.deepEqual(completionText({ name: 'length', kind: 'property' }, null, ctx), { text: 'length', snippet: false });
    assert.deepEqual(completionText({ name: 'const', kind: 'keyword' }, null, ctx), { text: 'const', snippet: false });
    assert.deepEqual(completionText({ name: 'x-y', kind: 'property', insertText: '["x-y"]' }, null, ctx), { text: '["x-y"]', snippet: false }, 'the language service\'s own text');
    assert.deepEqual(completionText({ name: 'm', kind: 'method', insertText: 'm(${1:a})', isSnippet: true }, null, ctx), { text: 'm(${1:a})', snippet: true });
    assert.equal(needsDetails(method), true);
    assert.equal(needsDetails({ name: 'length', kind: 'property' }), false);
});

test('ghost text: the part not typed yet, the suffix after the caret, gone when it no longer fits', () => {
    const doc = "    value.\n}";
    const caret = 10;
    const s = { id: 'c1', text: '    value.toUpperCase();', start: 0, end: caret };
    assert.deepEqual(ghostOf(s, doc, caret), { ghost: 'toUpperCase();', replaceEnd: caret, suffix: '' });
    // Typing what it shows: the rest.
    const doc2 = "    value.toU\n}";
    assert.equal(ghostOf(s, doc2, 13)!.ghost, 'pperCase();');
    // Typing something else, or moving before its start: none.
    assert.equal(ghostOf(s, "    value.x\n}", 11), null);
    assert.equal(ghostOf({ ...s, start: 5 }, doc, 4), null);
    // Typed it all: nothing left to show.
    assert.equal(ghostOf(s, '    value.toUpperCase();\n}', 24), null);
    // A ")" after the caret the suggestion ends with: shown once.
    const d3 = 'run(|)'.replace('|', '');
    const g = ghostOf({ id: 'c2', text: 'run(page, 3)', start: 0, end: 5 }, d3, 4)!;
    assert.deepEqual(g, { ghost: 'page, 3', replaceEnd: 5, suffix: ')' });
    // Multi-line.
    assert.equal(ghostOf({ id: 'c3', text: '    a();\n    b();', start: 0, end: 0 }, '\n', 0)!.ghost, '    a();\n    b();');
});

test('Ctrl+→ takes the next word; suggestions only at a line end or before closers', () => {
    assert.equal(nextWordLength('toUpperCase();'), 'toUpperCase'.length);
    assert.equal(nextWordLength(' page, 3)'), ' page'.length);
    assert.equal(nextWordLength('();'), 3, 'a run of punctuation');
    assert.equal(nextWordLength('\n    return x;'), '\n    return'.length, 'over the line break to the next word');
    assert.equal(nextWordLength("'Hello, world';"), "'Hello".length, 'a quote and the word');
    assert.equal(nextWordLength(", world';"), 1);
    assert.equal(nextWordLength(''), 0);
    assert.ok(inlineFits(''));
    assert.ok(inlineFits(');'));
    assert.ok(inlineFits('  '));
    assert.ok(!inlineFits('foo'));
});
