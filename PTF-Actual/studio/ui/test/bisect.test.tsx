import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { baseScenarioName, locateFailed } from '../src/bisectLocate';

test('Which commit broke it: failed scenarios found in the feature files even when the run evidence does not say', () => {
    assert.equal(baseScenarioName('Verify navigation to each module_Iteration-3'), 'Verify navigation to each module');
    assert.equal(baseScenarioName('Add <qty> items (Example 2)'), 'Add <qty> items');
    const catalog = [
        { path: 'test/akhan/features/login.feature', name: 'Login and Navigation', scenarios: [{ name: 'Standard user login' }, { name: 'Verify navigation to each module' }] },
        { path: 'test/orangehrm/features/login.feature', name: 'Login and Navigation', scenarios: [{ name: 'Standard user login' }, { name: 'Verify navigation to each module' }] },
    ];
    const r = locateFailed([
        { name: 'Standard user login', feature: 'Login and Navigation' },
        { name: 'Verify navigation to each module_Iteration-3', feature: 'Login and Navigation' },
        { name: 'Verify navigation to each module_Iteration-4', feature: 'Login and Navigation' },
        { name: 'Gone scenario', feature: 'Login and Navigation' },
    ], 'orangehrm', [], catalog);
    assert.deepEqual(r, [
        { name: 'Standard user login', file: 'test/orangehrm/features/login.feature' },
        { name: 'Verify navigation to each module', file: 'test/orangehrm/features/login.feature' },
        { name: 'Gone scenario' },
    ], 'the copy under the run\'s project; iterations as one scenario; a scenario no longer there has no file');
    const fromEvidence = locateFailed([{ name: 'Standard user login', feature: 'Login and Navigation' }], 'orangehrm', [{ name: 'Standard user login', feature: 'Login and Navigation', location: { file: 'test/akhan/features/login.feature' } }], catalog);
    assert.equal(fromEvidence[0].file, 'test/akhan/features/login.feature', 'the run evidence wins');
});
