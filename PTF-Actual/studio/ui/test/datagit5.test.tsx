import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import './support/browser-stub';
import { branchFinalName, renameProblem } from '../src/pages/Branches';
import { parsePdfRoute } from '../src/pages/PdfChecks';
import { portProblem } from '../src/pages/Settings';
import { staleVersion } from '../src/datagit-api';
import { ApiError } from '../src/api';

test('port: said as typed; digits of other scripts count; 1e3 and low ports refused', () => {
    assert.equal(portProblem('4719'), null);
    assert.equal(portProblem('٤٧١٩'), null);
    assert.equal(portProblem('0'), null);
    assert.match(portProblem('1e3')!, /Digits only/);
    assert.match(portProblem('80')!, /below 1024/);
    assert.match(portProblem('70000')!, /At most 65535/);
    assert.match(portProblem('')!, /Give a port/);
});

test('rename: the name git gets, and a name in use is said before Rename', () => {
    assert.equal(branchFinalName(' my branch~1 '), 'my-branch1');
    assert.equal(renameProblem('main', 'feature', ['main', 'feature']), 'A branch named "main" exists already: choose another name.');
    assert.equal(renameProblem('bad name', 'feature', ['main', 'bad-name']), 'A branch named "bad-name" exists already: choose another name.');
    assert.equal(renameProblem('feature', 'feature', ['main', 'feature']), null);
    assert.equal(renameProblem('new-one', 'feature', ['main', 'feature']), null);
});

test('PDF address: the file (encoded or as folders) and the tab after it', () => {
    assert.deepEqual(parsePdfRoute(['pdf', 'test/orders/data/pdf/invoice.pdf', 'read']), { file: 'test/orders/data/pdf/invoice.pdf', tab: 'read' });
    assert.deepEqual(parsePdfRoute(['pdf', 'test', 'orders', 'invoice.pdf']), { file: 'test/orders/invoice.pdf', tab: null });
    assert.deepEqual(parsePdfRoute(['pdf', 'test', 'orders', 'invoice.pdf', 'view']), { file: 'test/orders/invoice.pdf', tab: 'view' });
    assert.deepEqual(parsePdfRoute(['pdf']), { file: null, tab: null });
});

test('a stale-save refusal carries the version saved now', () => {
    const e = Object.assign(new ApiError('Changed in another tab', 409, 'stale'), { current: 'abc' });
    assert.equal(staleVersion(e), 'abc');
    assert.equal(staleVersion(new Error('x')), undefined);
});
