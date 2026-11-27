import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { hoverExpression } from '../src/debugHover';

const at = (src: string, word: string, nth = 0) => { let i = -1; for (let k = 0; k <= nth; k++) i = src.indexOf(word, i + 1); return hoverExpression(src, i + 1); };

test('the expression under the mouse while paused: the name with its chain, never a call, keywords or strings', () => {
    const src = [
        'async verifyNavigationMenu(): Promise<void> {',
        '    const menuItems = await this.dashboardPage.getMenuItems();',
        '    const first = menuItems[0].trim();',
        '    const n = this.loginPage?.url.length; // count url',
        "    log('menuItems are here', rows['a b'].x, rows[i]);",
        '}',
    ].join('\n');
    assert.equal(at(src, 'menuItems'), 'menuItems');
    assert.equal(at(src, 'dashboardPage'), 'this.dashboardPage');
    assert.equal(at(src, 'this'), 'this');
    assert.equal(at(src, 'getMenuItems'), 'this.dashboardPage.getMenuItems', 'the method itself (shown as a function), not its call');
    assert.equal(at(src, 'menuItems', 1), 'menuItems');
    assert.equal(at(src, 'trim'), 'menuItems[0].trim');
    assert.equal(hoverExpression('const v = page.title().length;', 'const v = page.title().length;'.indexOf('length') + 1), null, 'reached through a call: not evaluated');
    assert.equal(at(src, 'length'), 'this.loginPage?.url.length');
    assert.equal(at(src, 'url', 1), null, 'in a comment');
    assert.equal(at(src, 'are'), null, 'in a string');
    assert.equal(at(src, '.x') === null ? null : hoverExpression(src, src.indexOf('.x') + 1), "rows['a b'].x");
    assert.equal(hoverExpression(src, src.indexOf('rows[i]') + 1), 'rows');
    assert.equal(at(src, 'const'), null);
    assert.equal(at(src, 'await'), null);
    assert.equal(hoverExpression(src, src.indexOf('verifyNavigationMenu') + 2), 'verifyNavigationMenu');
    assert.equal(hoverExpression('a  b', 2), null, 'between words');
});
