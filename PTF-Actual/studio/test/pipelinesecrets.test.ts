import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { featureReferences, NOT_SECRETS, usedLines } from '../src/ado/pipelineSecrets';

test('secret names come from steps, tables and doc strings only (not comments, descriptions or titles)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ps-'));
    fs.mkdirSync(path.join(root, 'test/a/features'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test/a/features/x.feature'), [
        'Feature: Interpolation {env:IN_TITLE}',
        '  Supports {env:IN_DESCRIPTION}',
        '  # comment {env:IN_COMMENT}',
        '  Scenario: Uses {env:IN_SCENARIO_TITLE}',
        '    Given the token "{env:API_TOKEN}"',
        '      | user | {env:TABLE_USER} |',
        '    And the body',
        '      """',
        '      {"key": "{env:DOC_KEY}"}',
        '      """',
        '    And my home is "{env:HOME}" and the build "{env:BUILD_BUILDID}"',
    ].join('\n'));
    assert.deepEqual(featureReferences(root).map((r) => [r.name, r.usedBy[0].line]), [['API_TOKEN', 5], ['TABLE_USER', 6], ['DOC_KEY', 9]]);
    assert.equal(usedLines('Feature: f\n  Scenario: s\n    * step\n').length, 1);
    for (const n of ['HOME', 'PATH', 'HTTP_PROXY', 'BUILD_BUILDID', 'SYSTEM_ACCESSTOKEN', 'AGENT_TEMPDIRECTORY']) assert.match(n, NOT_SECRETS);
    for (const n of ['API_TOKEN', 'DB_PASSWORD', 'BUILDER_KEY']) assert.doesNotMatch(n, NOT_SECRETS);
    fs.rmSync(root, { recursive: true, force: true });
});
