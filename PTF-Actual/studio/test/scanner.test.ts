/**
 * Scanner rule tests. Fake secrets are assembled at runtime so this file itself never contains a
 * token-shaped literal (it must pass its own scan and hosting-provider push protection).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scanLines, scanPath, toPublic, findingsDigest } from '../src/scanner/scanner';
import { fingerprint, isPlaceholder, maskSecret } from '../src/scanner/util';
import { ScanLine } from '../src/scanner/types';

const rnd = (n: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => {
    let s = '';
    let x = 12345 + n;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += alphabet[x % alphabet.length]; }
    return s;
};
const L = (text: string, file = 'src/config.ts', line = 1): ScanLine => ({ file, line, text });
const ids = (lines: ScanLine[]) => scanLines(lines).map((f) => f.ruleId);

test('detects high-confidence token formats', () => {
    const gh = 'gh' + 'p_' + rnd(36);
    const ghFine = 'github' + '_pat_' + rnd(82, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_');
    const ado = rnd(76) + 'AZ' + 'DO' + rnd(4);
    const aws = 'AK' + 'IA' + rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    assert.deepEqual(ids([L(`const t = "${gh}";`)]), ['github-token']);
    assert.deepEqual(ids([L(`x=${ghFine}`)]), ['github-fine-grained-token']);
    assert.ok(ids([L(`adoToken: ${ado}`)]).includes('azure-devops-pat'));
    assert.deepEqual(ids([L(`aws ${aws} here`)]), ['aws-access-key']);
    assert.deepEqual(ids([L('-----BEGIN RSA ' + 'PRIVATE KEY-----')]), ['private-key']);
});

test('detects connection strings, URLs and webhooks', () => {
    const key = rnd(86) + '==';
    assert.deepEqual(ids([L(`DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${key};EndpointSuffix=core.windows.net`)]), ['azure-storage-key']);
    assert.deepEqual(ids([L('Server=db1;Database=app;User Id=qa;Password=Q4!zr7Lm;')]), ['connection-string-password']);
    assert.deepEqual(ids([L('https://qa_user:S3cr3tPw@host.example.com/path')]), ['url-basic-auth']);
    assert.deepEqual(ids([L('url = "https://hooks.slack.com/services/' + rnd(9) + '/' + rnd(9) + '/' + rnd(24) + '"')]), ['webhook-url']);
});

test('detects config, code and Gherkin secrets', () => {
    assert.deepEqual(ids([L('DB_PASSWORD=Q4!zr7Lm-x', 'config/qa/.env')]), ['env-secret-assignment']);
    assert.deepEqual(ids([L('const login = { password: "Tr0ub4dor&3" };')]), ['code-secret-assignment']);
    assert.deepEqual(ids([L('When I enter "Welcome@123" into the "Password" field', 'features/login.feature')]), ['step-password-literal']);
    // The more specific explanation wins for ENCRYPTED: values.
    assert.deepEqual(ids([L('ADO_PAT=ENCRYPTED:' + rnd(40), 'config/global.env')]), ['legacy-encrypted-value']);
    assert.deepEqual(ids([L('APP_KEY_VALUE ENCRYPTED:' + rnd(40))]), ['legacy-encrypted-value']);
    // Encrypted with the team's own key (CS_ENCRYPTION_KEY: its id in the value): protected, nothing to report.
    const teamValue = 'ENCRYPTED:' + Buffer.from(JSON.stringify({ encrypted: rnd(24), iv: rnd(24), tag: rnd(24), kid: '3f9a01bc77de' })).toString('base64');
    assert.deepEqual(ids([L(`ADO_PAT=${teamValue}`, 'config/global.env')]), []);
});

test('ignores placeholders, references and dummy values', () => {
    const clean = [
        L('DB_PASSWORD=${DB_PASSWORD}', 'config/.env'),
        L('DB_PASSWORD={secret:DB_PASSWORD}', 'config/.env'),
        L('API_TOKEN=<your-token>', 'config/.env'),
        L('password: "changeme"'),
        L('const password = "{{password}}";'),
        L('When I enter "{secret:QA_PASSWORD}" into the "Password" field', 'features/login.feature'),
        L('Server=db1;Password=%DB_PWD%;'),
        L('const token = process.env.TOKEN;'),
        L('await page.fill("#password", user.password);'),
        L('// the password field must be masked'),
        L('const passwordSelector = "input[type=password]";'),
    ];
    assert.deepEqual(scanLines(clean), []);
});

test('Gherkin rule only applies to step files', () => {
    assert.deepEqual(ids([L('When I enter "Welcome@123" into the "Password" field', 'docs/readme.md')]), []);
});

test('known secrets are matched exactly and win over pattern rules', () => {
    const gh = 'gh' + 'p_' + rnd(36);
    const f = scanLines([L(`token=${gh}`)], { knownSecrets: [{ name: 'GH_TOKEN', value: gh }] });
    assert.equal(f.length, 1);
    assert.equal(f[0].ruleId, 'known-secret-value');
    assert.match(f[0].reason, /GH_TOKEN/);
    // A value nobody could pattern-match is still found because it is a stored secret.
    const plain = scanLines([L('notes: the qa login is bluehorse')], { knownSecrets: [{ name: 'QA_PWD', value: 'bluehorse' }] });
    assert.equal(plain.length, 1);
    assert.equal(plain[0].column, 'notes: the qa login is '.length + 1);
});

test('allowlisted fingerprints are suppressed', () => {
    const line = L('const login = { password: "Tr0ub4dor&3" };');
    const [f] = scanLines([line]);
    assert.equal(f.fingerprint, fingerprint('code-secret-assignment', 'Tr0ub4dor&3'));
    assert.deepEqual(scanLines([line], { allowlist: { size: 1, has: (_r, _v, fp) => fp === f.fingerprint } }), []);
});

test('file rules', () => {
    assert.deepEqual(scanPath('certs/client.pfx', undefined).map((f) => f.ruleId), ['certificate-or-key-file']);
    assert.deepEqual(scanPath('x/y.har', undefined).map((f) => f.ruleId), ['har-file']);
    assert.deepEqual(scanPath('config/.env.local', undefined).map((f) => f.ruleId), ['personal-env-file']);
    assert.deepEqual(scanPath('config/qa.env', undefined), []);
    assert.deepEqual(scanPath('a/cert.pem', '-----BEGIN CERTIFICATE-----').map((f) => f.ruleId), []);
    assert.deepEqual(scanPath('a/key.pem', '-----BEGIN ' + 'PRIVATE KEY-----').map((f) => f.ruleId), ['pem-private-key-file']);
    const state = JSON.stringify({ cookies: [], origins: [] });
    assert.deepEqual(scanPath('.auth/user.json', state).map((f) => f.ruleId), ['browser-session-file']);
    assert.deepEqual(scanPath('test-data/storageState.json', state).map((f) => f.ruleId), ['browser-session-file']);
    assert.deepEqual(scanPath('test-data/users.json', state), []);
});

test('public findings never contain the raw value', () => {
    const secret = 'Tr0ub4dor&3';
    const [f] = scanLines([L(`password: "${secret}"`)]);
    const p = toPublic(f, 'f1');
    assert.ok(!JSON.stringify(p).includes(secret));
    assert.equal(p.preview, maskSecret(secret));
    assert.equal(maskSecret('short'), '•••••');
});

test('digest is order independent and content bound', () => {
    const a = scanLines([L('password: "Tr0ub4dor&3"', 'a.ts', 1), L('password: "Xy9!kk22"', 'b.ts', 4)]);
    assert.equal(findingsDigest(a), findingsDigest([...a].reverse()));
    const b = scanLines([L('password: "Tr0ub4dor&3"', 'a.ts', 2), L('password: "Xy9!kk22"', 'b.ts', 4)]);
    assert.notEqual(findingsDigest(a), findingsDigest(b));
});

test('isPlaceholder', () => {
    for (const v of ['${X}', '{{x}}', '{secret:A}', '<token>', '%X%', '$X', '***', 'xxxx', 'changeme', 'your_password']) assert.ok(isPlaceholder(v), v);
    for (const v of ['Tr0ub4dor&3', 'bluehorse1']) assert.ok(!isPlaceholder(v), v);
});

test('very long minified lines are bounded', () => {
    const t0 = Date.now();
    scanLines([L('a'.repeat(5_000_000))]);
    assert.ok(Date.now() - t0 < 2000);
});

// Regression cases from scanning the real framework repository (all must stay quiet).
test('no false positives on real framework code patterns', () => {
    const quiet: ScanLine[] = [
        L('  token: string;', 'src/auth/CSTokenManager.ts'),
        L('    refreshToken: response.data.refresh_token,', 'src/api/auth/CSPingAuthHandler.ts'),
        L('    personalAccessToken: z.string().optional(),', 'src/mcp/v6/tools/ado_config_tool.ts'),
        L('STEP_DEFINITIONS_PATH=test/steps;src/steps', 'config/global.env'),
        L('REPORT_NAME_PATTERN=test-report-{timestamp}', 'config/global.env'),
        L('SECRET_MASKING_PATTERNS=password,token,secret', 'config/global.env'),
        L('    SYSTEM_ACCESSTOKEN: $(System.AccessToken)', 'pipelines/build.yml'),
        L('    npmAuthToken: ${{ secrets.NPM_TOKEN }}', 'pipelines/build.yml'),
        L('  _authToken=#{NPM_TOKEN}#', 'README.md'),
        L('        const password = await CSValueResolver.resolve(\'{config:APP_PASSWORD}\', context);', 'src/steps/x.ts'),
        L('        config.password = this.config.get(`DB_${alias}_PASSWORD`) || fail();', 'src/database/CSDatabaseManager.ts'),
        L('    /-----BEGIN PRIVATE KEY-----[\\s\\S]*?-----END PRIVATE KEY-----/,', 'src/api/client/CSAuthenticationHandler.ts'),
        L("    out = out.replace(RE, '-----BEGIN PRIVATE KEY-----***REDACTED***-----END PRIVATE KEY-----');", 'src/x.ts'),
        L('Given user connects with connection string "mysql://user:pass@host:3306/db"', 'README.md'),
        L('DB_PASSWORD=ENCRYPTED:U2FsdGVkX1+abc123...', 'README.md'),
        L("    'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here',", 'src/mcp/v6/tools/ado_config_tool.ts'),
        L('    "password": "Admin@12345",', 'docs/USER_GUIDE.md'),
        L("    password: 'input[name=\"password\"]',", 'test-exploration.ts'),
        L("    credentials: { username: 'bob', password: 'env:PERF_PASSWORD' }", 'src/x.test.ts'),
        L('    lines.push(`  --broker-token="\\${PACT_BROKER_TOKEN}"`);', 'src/pact_builder.ts'),
        L('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'docs/aws.md'),
    ];
    assert.deepEqual(scanLines(quiet).map((f) => `${f.ruleId} ${f.file}:${f.line}`), []);
});

test('true positives from the real repository stay detected', () => {
    assert.deepEqual(ids([L('DB_PRACTICE_MYSQL_PASSWORD=Secr3tPractice!x', 'config/global.env')]), ['env-secret-assignment']);
    assert.deepEqual(ids([L('PASSWORD=admin123', 'config/orangehrm/orangehrm.env')]), ['env-secret-assignment']);
    assert.deepEqual(ids([L('db.pwd=hunter2pw', 'resources/sit/env.properties')]), ['env-secret-assignment']);
    assert.deepEqual(ids([L('  dbPassword: s3cr3t!pw', 'config/app.yaml')]), ['yaml-secret-assignment']);
    assert.deepEqual(ids([L("const rB = await client.post(url, { username: 'admin', password: 'default-admin-pw-2024' });", 'src/x.ts')]), ['code-secret-assignment']);
    assert.deepEqual(ids([L('Server=db1;Database=app;User Id=qa;Password=Q4!zr7Lm;')]), ['connection-string-password']);
    assert.deepEqual(ids([L('-----BEGIN PRIVATE KEY-----', 'certs/key.txt')]), ['private-key']);
    assert.deepEqual(ids([L('const k = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA";', 'src/k.ts')]), ['private-key']);
});

test('suggested secret names come from the key', async () => {
    const { suggestName } = await import('../src/scanner/scanner');
    assert.equal(suggestName('DB_PASSWORD='), 'DB_PASSWORD');
    assert.equal(suggestName('const login = { password: "'), 'PASSWORD');
    assert.equal(suggestName('  "apiKey": "'), 'API_KEY');
    assert.equal(suggestName('db.pwd='), 'DB_PWD');
    assert.equal(suggestName('When I enter "'), undefined);
    const [f] = scanLines([L('QA_DB_PASSWORD=Q4!zr7Lm-x', 'config/qa.env')]);
    assert.equal(toPublic(f, 'f1').suggestedName, 'QA_DB_PASSWORD');
});

test('review fixes: exact column, selectors, pin, camelCase, long lines, short stored values', () => {
    // Column of the captured value, not the first occurrence of the same text.
    const [u] = scanLines([L('const url = "https://admin:admin@example.com/x";')]).filter((f) => f.value === 'admin');
    if (u) assert.equal(u.column, 'const url = "https://admin:'.length + 1);
    // Locators are not secrets.
    for (const v of ['#password-input', '.login__password', 'data-testid=token-field', '//input[@name="pwd"]'])
        assert.deepEqual(scanLines([L(`const passwordSelector = { password: '${v}' };`)]).filter((f) => f.value === v), [], v);
    // "pin" only as a word: "Shipping" is not a PIN field.
    assert.equal(scanLines([{ file: 'a.feature', line: 1, text: 'When I enter "221B Baker St" in the "Shipping address" field' }]).length, 0);
    assert.equal(scanLines([{ file: 'a.feature', line: 1, text: 'When I enter "4831" in the "PIN" field' }]).length, 1);
    // camelCase names.
    assert.equal(scanLines([L('const adminPassword = "Zq8!vT3kLw";')]).length, 1);
    assert.equal(scanLines([L('const passwordField = "input-password-x";')]).length, 0);
    // A secret after 30k characters on one line is still found, once.
    const long = 'x'.repeat(30_000) + ' token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"';
    const lf = scanLines([L(long)]);
    assert.ok(lf.length >= 1);
    assert.equal(new Set(lf.map((f) => `${f.column}`)).size, lf.length);
    // Short stored values ("admin") are not flagged everywhere; stored values match whole tokens only.
    assert.equal(scanLines([L('role: admin')], { knownSecrets: [{ name: 'U', value: 'admin' }] }).length, 0);
    assert.equal(scanLines([L('id: bluehorses2')], { knownSecrets: [{ name: 'P', value: 'bluehorse' }] }).length, 0);
});

test('allowlist v2 stores a salted hash and refuses stored secrets', async () => {
    const fs = await import('fs'); const os = await import('os'); const path = await import('path');
    const { addToAllowlist, allowlistSet } = await import('../src/scanner/allowlist');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));
    addToAllowlist(dir, { ruleId: 'code-secret-assignment', value: 'Tr0ub4dor&3', file: 'a.ts', reason: 'demo', addedBy: 'T', addedAt: 'now' });
    const text = fs.readFileSync(path.join(dir, '.cs-studio/secret-allowlist.json'), 'utf8');
    assert.ok(!text.includes('Tr0ub4dor') && !text.includes(fingerprint('code-secret-assignment', 'Tr0ub4dor&3')));
    const m = allowlistSet(dir);
    assert.ok(m.has('code-secret-assignment', 'Tr0ub4dor&3', 'x'));
    assert.ok(!m.has('code-secret-assignment', 'other', 'x'));
    assert.throws(() => addToAllowlist(dir, { ruleId: 'known-secret-value', value: 'v', file: 'a', reason: 'r', addedBy: 'T', addedAt: 'now' }));
});

test('a line only re-written by Git (newline added at the end of the file, or moved) is not new', async () => {
    const { parseAddedLines } = await import('../src/git/parse');
    const diff = [
        'diff --git a/dev.env b/dev.env', '--- a/dev.env', '+++ b/dev.env', '@@ -38 +38,2 @@',
        '-ORANGEHRM_PASSWORD=ENCRYPTED:abc', '\\ No newline at end of file', '+ORANGEHRM_PASSWORD=ENCRYPTED:abc', '+NEW_PASSWORD=Xq7!vR2#mK9pL4wZ',
    ].join('\n');
    assert.deepEqual(parseAddedLines(diff)[0].added.map((a) => [a.line, a.text]), [[39, 'NEW_PASSWORD=Xq7!vR2#mK9pL4wZ']]);
});
