import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import './support/browser-stub';
import { tagNews } from '../src/datagit-common';
import { staleDetail } from '../src/components/ChangedElsewhere';
import { settingsKeeps } from '../src/pages/NetworkSettings';

test('Fetch names the tags that are new, moved or deleted on the remote', () => {
    assert.deepEqual(tagNews({}).filter(Boolean), []);
    assert.deepEqual(tagNews({ tagsAdded: ['qa7-mate-tag'], tagsChanged: ['qa7-clash'], tagsRemoved: ['a', 'b', 'c', 'd'] }).filter(Boolean),
        ['1 new tag (qa7-mate-tag)', '1 tag changed on the remote (qa7-clash)', '4 tags deleted on the remote (a, b, c, …)']);
});

test('a stale-save question does not repeat its title in its first sentence', () => {
    assert.equal(staleDetail('Changed in another tab or by someone else: reload to see it.'), '');
    assert.equal(staleDetail('QA_URL in common.env changed in another tab or by someone else: reload to see it.'), '');
    assert.equal(staleDetail('Changed in another tab or by someone else since you opened it. Saved by Ann at 10:02.'), 'Saved by Ann at 10:02.');
    assert.equal(staleDetail('The file is read-only.'), 'The file is read-only.');
});

test('Settings: Back/Forward between its tabs keeps what is typed (no question); another screen still asks', () => {
    assert.equal(settingsKeeps(['settings', 'ado']), true);
    assert.equal(settingsKeeps(['settings', 'network', 'git']), true);
    assert.equal(settingsKeeps(['secrets']), false);
});
