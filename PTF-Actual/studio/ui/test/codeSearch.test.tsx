import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { countText, groupByFile, NEW_SEARCH, previewLine, searchesFile, withOpenTabs } from '../src/codeSearch';
import { installReloadGuard, reloadKeyOf } from '../src/reloadKeys';
import type { TextSearchResult } from '../src/api';

test('results grouped by file, in order', () => {
    const g = groupByFile([{ path: 'b.ts', line: 1 }, { path: 'a.ts', line: 2 }, { path: 'b.ts', line: 3 }]);
    assert.deepEqual(g.map((x) => [x.path, x.items.map((i) => i.line)]), [['b.ts', [1, 3]], ['a.ts', [2]]]);
    assert.equal(countText(1, 1), '1 match in 1 file');
    assert.equal(countText(12, 3), '12 matches in 3 files');
});

test('open tabs with unsaved edits are searched in their editor text; scope and ignored folders apply', () => {
    const s = { ...NEW_SEARCH, q: 'enterUsername', case: true };
    const disk: TextSearchResult = {
        hits: [{ path: 'test/pages/Login.ts', line: 9, column: 18, length: 13, text: 'public async enterUsername() {' }, { path: 'test/steps/a.steps.ts', line: 5, column: 30, length: 13, text: 'await this.loginPage.enterUsername(u);' }],
        files: [{ path: 'test/pages/Login.ts', count: 1 }, { path: 'test/steps/a.steps.ts', count: 1 }], total: 2, limited: false, truncated: false, scanned: 10,
    };
    const tabs = [
        { path: 'test/steps/a.steps.ts', content: 'x\nenterUsername enterUsername\n', dirty: true },
        { path: 'test/pages/Login.ts', content: 'nothing', dirty: false },
        { path: 'dist/a.js', content: 'enterUsername', dirty: true },
    ];
    const r = withOpenTabs(disk, s, tabs, null);
    assert.deepEqual(r.files, [{ path: 'test/pages/Login.ts', count: 1 }, { path: 'test/steps/a.steps.ts', count: 2 }]);
    assert.equal(r.total, 3);
    assert.deepEqual(r.hits.map((h) => `${h.path}:${h.line}:${h.column}`), ['test/pages/Login.ts:9:18', 'test/steps/a.steps.ts:2:1', 'test/steps/a.steps.ts:2:15']);
    assert.equal(searchesFile('dist/a.js', s, null), false);
    assert.equal(searchesFile('dist/a.js', { ...s, ignored: true }, null), true);
    assert.equal(searchesFile('test/steps/a.steps.ts', { ...s, scope: 'folder', folder: 'test\\pages' }, null), false);
    assert.equal(searchesFile('test/pages/Login.ts', { ...s, scope: 'folder', folder: 'test\\pages' }, null), true);
    assert.equal(searchesFile('test/pages/Login.ts', { ...s, scope: 'file' }, 'test/pages/Login.ts'), true);
    assert.equal(searchesFile('test/steps/a.steps.ts', { ...s, scope: 'file' }, 'test/pages/Login.ts'), false);
});

test('a result line split around its match, and what the replacement makes of it (regex groups)', () => {
    const h = { path: 'a.ts', line: 1, column: 12, length: 23, text: 'await this.loginPage.enterUsername(u);' };
    assert.deepEqual(previewLine(h, { ...NEW_SEARCH, q: 'loginPage.enterUsername' }), { before: 'await this.', match: 'loginPage.enterUsername', after: '(u);' });
    const p = previewLine(h, { ...NEW_SEARCH, q: 'loginPage\\.enter(\\w+)', regex: true, showReplace: true, replace: 'signIn.type$1' });
    assert.equal(p.replaced, 'signIn.typeUsername');
    assert.equal(previewLine(h, { ...NEW_SEARCH, q: 'loginPage.enterUsername', showReplace: true, replace: '$1' }).replaced, '$1');
});

test('the browser\'s reload keys: F5, Shift+F5, Ctrl+R and Ctrl+F5 are held back; Ctrl+Shift+R is not', () => {
    const k = (key: string, o: Partial<{ ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean; code: string }> = {}) =>
        reloadKeyOf({ key, code: o.code ?? '', ctrlKey: !!o.ctrlKey, shiftKey: !!o.shiftKey, metaKey: !!o.metaKey, altKey: !!o.altKey });
    assert.equal(k('F5'), 'f5');
    assert.equal(k('F5', { shiftKey: true }), 'f5');
    assert.equal(k('F5', { ctrlKey: true }), 'ctrl-f5');
    assert.equal(k('r', { ctrlKey: true }), 'ctrl-r');
    assert.equal(k('R', { metaKey: true }), 'ctrl-r');
    assert.equal(k('к', { ctrlKey: true, code: 'KeyR' }), 'ctrl-r', 'another keyboard layout');
    assert.equal(k('R', { ctrlKey: true, shiftKey: true }), null, 'hard reload stays');
    assert.equal(k('r'), null);
    assert.equal(k('F10'), null);
});

test('the reload guard: the page never reloads; the hint only when no screen used the key (F5 = Continue while debugging)', async () => {
    const listeners: Array<(e: KeyboardEvent) => void> = [];
    const target = { addEventListener: (_t: string, l: EventListener) => { listeners.push(l as never); }, removeEventListener: () => undefined };
    const hints: string[] = [];
    const off = installReloadGuard((key) => hints.push(key), target as never);
    const press = (key: string, screenUses: boolean) => {
        let prevented = false;
        const e = { key, code: key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, preventDefault() { prevented = true; } } as unknown as KeyboardEvent;
        for (const l of listeners) l(e);
        // A screen's own handler (e.g. the Debug panel) runs after the guard, on the same event.
        if (screenUses) e.preventDefault();
        return () => prevented;
    };
    const p1 = press('F5', false);
    const p2 = press('F5', true);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(p1(), true);
    assert.equal(p2(), true);
    assert.deepEqual(hints, ['f5'], 'one hint: the second F5 was Continue');
    off();
});
