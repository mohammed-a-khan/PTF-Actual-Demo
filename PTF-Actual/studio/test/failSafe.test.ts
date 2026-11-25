import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTriage, signatureTag, TRIAGE_PATH, writeTriage } from '../src/quality/triage';
import { overrideRefusal, POLICY_PATH, readPolicy } from '../src/scanner/policy';

const tmpRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cs-failsafe-'));
const put = (root: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

test('triage: a file that cannot be read is shown as empty but never overwritten (the team keeps its entries)', () => {
    const root = tmpRepo();
    try {
        const a = signatureTag('a'), b = signatureTag('b');
        writeTriage(root, a, { signature: 'a', verdict: 'product-bug' });
        writeTriage(root, b, { signature: 'b', note: 'flaky on Mondays' });
        const good = fs.readFileSync(path.join(root, TRIAGE_PATH), 'utf8');
        // Two branches triaged: a merge conflict in the file.
        const broken = `<<<<<<< HEAD\n${good}=======\n{}\n>>>>>>> other\n`;
        put(root, TRIAGE_PATH, broken);
        assert.deepEqual(readTriage(root), {}, 'reading for display: empty');
        assert.throws(() => writeTriage(root, a, { signature: 'a', verdict: 'test-issue' }), /triage\.json cannot be read .*fix it \(a merge conflict\?\) before triaging/);
        assert.equal(fs.readFileSync(path.join(root, TRIAGE_PATH), 'utf8'), broken, 'the file is left as it was');
        // No file yet: a first save works.
        fs.rmSync(path.join(root, TRIAGE_PATH));
        assert.deepEqual(Object.keys(writeTriage(root, a, { signature: 'a', verdict: 'test-issue' })), [a]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('secret-scan policy: comments allowed; a policy that cannot be read is strict, never the permissive default', () => {
    const root = tmpRepo();
    try {
        assert.equal(readPolicy(root).allowOverride, true, 'no policy file: the default');
        // As the documented example, with comments.
        put(root, POLICY_PATH, '{\n  "secretScan": {\n    "allowOverride": false,   // no committing past findings\n    "scanOnPush": true\n  }\n}\n');
        assert.deepEqual(readPolicy(root), { allowOverride: false, overrideHighConfidence: true, scanOnPush: true });
        put(root, POLICY_PATH, '{ "secretScan": { "allowOverride": false,, } ');
        const p = readPolicy(root);
        assert.deepEqual([p.allowOverride, p.overrideHighConfidence, p.scanOnPush], [false, false, true]);
        assert.match(overrideRefusal(p, []) ?? '', /^\.cs-studio\/policy\.json cannot be read .*: until it is fixed, committing with secret-scan findings is not allowed\.$/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
