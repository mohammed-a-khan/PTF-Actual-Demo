/**
 * Secret detection rules (in-house; no third-party scanner).
 *
 * Each content rule is a regular expression with ONE named group `v` holding the secret value,
 * plus an optional `accept` check (placeholder / entropy / context). Rules are deliberately
 * specific: generic "looks random" detection only fires next to a secret-ish keyword, which keeps
 * false positives low on test-automation code (selectors, ids, hashes in fixtures).
 */
import { Confidence } from './types';
import { isPlaceholder, shannonEntropy } from './util';
import { encryptedKeyId } from '../core/encrypted';

export interface ContentRule {
    id: string;
    type: string;
    confidence: Confidence;
    reason: string;
    re: RegExp; // must contain a named group `v`; must be global (g)
    /** Only apply to files whose repo path matches. */
    fileFilter?: RegExp;
    /** Return false to drop a match (placeholder, low entropy, etc.). */
    accept?: (value: string, lineText: string) => boolean;
}

const notPlaceholder = (v: string) => !isPlaceholder(v);

/** Files where `key = value` lines are configuration (not code or prose). */
const CONFIG_FILE = /(^|\/)(\.env[^/]*|[^/]*\.(env|properties|ini|cfg|conf|npmrc|sh|bash|zsh|ps1|psm1|bat|cmd))$/i;
const YAML_FILE = /\.ya?ml$/i;
/** Prose files: generic "looks like a password" rules are too noisy here (examples everywhere). */
const notProse = /^(?!.*\.(md|markdown|html?|txt|rst|adoc)$)/i;
/** A key NAME that holds a secret: the secret word must END the name (STEP_DEFINITIONS_PATH is not a PAT). */
const SECRET_KEY_NAME = '[A-Za-z0-9_.-]*?(?:PASSWORD|PASSWD|PWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SIGNING_?KEY|_PAT|CREDENTIALS?)(?:_?\d+)?';
/** Values that are code or references, not literals. */
const looksLikeLiteral = (v: string) => !(v.startsWith('ENCRYPTED:') && encryptedKeyId(v)) && !/^[{(\[$<&\\]/.test(v) && !/\(\)?$/.test(v) && !v.includes('[') && !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(v)
    && !looksLikeSelector(v);
/** CSS/XPath/test-id locators such as '#password', '.login-form__password', 'data-testid=token-input'. */
const looksLikeSelector = (v: string) => /^[#.]?-?[A-Za-z_][\w-]*(?:__[\w-]+)?(?:--[\w-]+)?$/.test(v) && /^[#.]/.test(v)
    || /^\/\//.test(v) || /^(?:data-(?:test|qa|cy)[\w-]*|id|name|aria-label|role|text|css|xpath)=/.test(v);

export const CONTENT_RULES: ContentRule[] = [
    {
        id: 'private-key',
        type: 'Private key',
        confidence: 'high',
        reason: 'A private key block was found. Private keys must never be committed.',
        re: /(?<v>-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----)(?=\s*$|\\[rn]|["'`]?\s*$|\s*[A-Za-z0-9+/]{20})/g,
    },
    {
        id: 'github-token',
        type: 'GitHub token',
        confidence: 'high',
        reason: 'This looks like a GitHub access token.',
        re: /(?<v>\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b)/g,
    },
    {
        id: 'github-fine-grained-token',
        type: 'GitHub fine-grained token',
        confidence: 'high',
        reason: 'This looks like a GitHub fine-grained personal access token.',
        re: /(?<v>\bgithub_pat_[A-Za-z0-9_]{60,255}\b)/g,
    },
    {
        id: 'azure-devops-pat',
        type: 'Azure DevOps personal access token',
        confidence: 'high',
        reason: 'This looks like an Azure DevOps personal access token (new 84-character format).',
        re: /(?<v>\b[A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4}\b)/g,
    },
    {
        id: 'azure-devops-pat-legacy',
        type: 'Azure DevOps personal access token (legacy format)',
        confidence: 'medium',
        reason: 'A 52-character token next to a PAT/token keyword looks like a legacy Azure DevOps PAT.',
        re: /(?:pat|token|password|pwd|ado)[^\n]{0,40}?(?<v>\b[a-z2-7]{52}\b)/gi,
    },
    {
        id: 'aws-access-key',
        type: 'AWS access key ID',
        confidence: 'high',
        reason: 'This looks like an AWS access key ID.',
        re: /(?<v>\b(?:AKIA|ASIA)[A-Z0-9]{16}\b)/g,
        accept: (v) => !/EXAMPLE$/.test(v),
    },
    {
        id: 'azure-storage-key',
        type: 'Azure storage account key',
        confidence: 'high',
        reason: 'A connection string contains an Azure storage AccountKey.',
        re: /AccountKey=(?<v>[A-Za-z0-9+/]{60,}={0,2})/g,
    },
    {
        id: 'azure-shared-access-key',
        type: 'Azure shared access key',
        confidence: 'high',
        reason: 'A connection string contains a SharedAccessKey.',
        re: /SharedAccessKey=(?<v>[A-Za-z0-9+/]{30,}={0,2})/g,
    },
    {
        id: 'sas-signature',
        type: 'Shared access signature',
        confidence: 'medium',
        reason: 'A URL contains a SAS signature (sig=…), which grants access on its own.',
        re: /[?&]sig=(?<v>[A-Za-z0-9%+/]{30,}={0,2})/g,
    },
    {
        id: 'jwt',
        type: 'JSON Web Token',
        confidence: 'medium',
        reason: 'This looks like a JWT (signed token), which may grant access until it expires.',
        re: /(?<v>\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/g,
    },
    {
        id: 'npmrc-credential',
        type: 'npm registry credential',
        confidence: 'high',
        reason: 'An .npmrc-style credential (_authToken / _password / _auth) is set to a literal value.',
        re: /(?:^|[\s:])(?:_authToken|_password|_auth)\s*=\s*(?<v>[^\s'"]+)/g,
        accept: notPlaceholder,
    },
    {
        id: 'url-basic-auth',
        type: 'Password in URL',
        confidence: 'high',
        reason: 'A URL contains a username and password (user:password@host).',
        re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:(?<v>[^\s@/'"]+)@[^\s'"]+/gi,
        accept: (v) => notPlaceholder(v) && v.length >= 4 && looksLikeLiteral(v),
    },
    {
        id: 'connection-string-password',
        type: 'Password in connection string',
        confidence: 'high',
        reason: 'A connection string contains a literal Password/Pwd value.',
        re: /(?:^|[;"'\s])(?:Password|Pwd)\s*=\s*(?<v>[^;'"\s]+)/gi,
        // Must sit inside a real connection string (another key=value such as Server=/User Id=).
        accept: (v, line) => notPlaceholder(v) && looksLikeLiteral(v)
            && /(?:server|data source|host|user ?id|uid|database|initial catalog|provider|dsn)\s*=|jdbc:/i.test(line)
            && /;/.test(line),
    },
    {
        id: 'webhook-url',
        type: 'Webhook URL',
        confidence: 'high',
        reason: 'A Slack/Teams/Power Automate webhook URL lets anyone post messages.',
        re: /(?<v>https:\/\/(?:hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}|[a-z0-9.-]*webhook\.office\.com\/webhookb2\/[^\s'"]+|[a-z0-9.-]+\.logic\.azure\.com(?::443)?\/workflows\/[^\s'"]*sig=[^\s'"&]+))/g,
    },
    {
        id: 'legacy-encrypted-value',
        type: 'Framework ENCRYPTED: value',
        confidence: 'medium',
        reason: 'This ENCRYPTED: value uses the framework\'s built-in key, so anyone with the package can decrypt it. Move it to the secret store, or encrypt it again with the team\'s key (CS_ENCRYPTION_KEY).',
        // Whole value only; a value followed by "..." is a truncated documentation example.
        re: /(?<v>ENCRYPTED:[A-Za-z0-9+/=:_-]{16,})(?![A-Za-z0-9+/=:_-]|\.\.\.)/g,
        // Encrypted with the team's own key (its id in the value): protected, fine to commit.
        accept: (v) => !/paste|here|your|example|placeholder|xxx/i.test(v) && !encryptedKeyId(v),
    },
    {
        // KEY=value in .env / properties: the KEY name says it is a secret.
        id: 'env-secret-assignment',
        type: 'Secret in configuration',
        confidence: 'medium',
        reason: 'A configuration key that holds a secret is set to a literal value.',
        re: new RegExp(`^\\s*(?:export\\s+|set\\s+|\\$env:)?${SECRET_KEY_NAME}\\s*=\\s*['"]?(?<v>[^'"\\s#]{4,})`, 'gim'),
        fileFilter: CONFIG_FILE,
        accept: (v) => notPlaceholder(v) && looksLikeLiteral(v),
    },
    {
        // YAML: dbPassword: s3cret   (pipeline variables like $(X) / ${{ }} are references)
        id: 'yaml-secret-assignment',
        type: 'Secret in YAML',
        confidence: 'medium',
        reason: 'A YAML key that holds a secret is set to a literal value.',
        re: new RegExp(`^\\s*-?\\s*${SECRET_KEY_NAME}\\s*:\\s*['"]?(?<v>[^'"\\s#]{4,})`, 'gim'),
        fileFilter: YAML_FILE,
        accept: (v) => notPlaceholder(v) && looksLikeLiteral(v),
    },
    {
        // code / JSON / YAML: password: "...", "apiKey": "...", token = '...', adminPassword = "..."
        // (camelCase/snake_case names count; passwordField / tokenType do not — the keyword must end the name)
        id: 'code-secret-assignment',
        type: 'Secret in code or data',
        confidence: 'medium',
        reason: 'A value assigned to a password/token/key field looks like a real secret.',
        re: /["']?\b[\w$]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|client[_-]?secret|access[_-]?key|private[_-]?key|auth[_-]?token)\b["']?\s*[:=]\s*["'`](?<v>[^"'`\s]{6,})["'`]/gi,
        fileFilter: notProse,
        accept: (v) => notPlaceholder(v) && looksLikeLiteral(v) && (shannonEntropy(v) >= 2.5 || /[^A-Za-z]/.test(v)),
    },
    {
        // Gherkin / step text: user enters "P@ssw0rd!" in "Password" field
        id: 'step-password-literal',
        type: 'Password in test step',
        confidence: 'medium',
        reason: 'A test step types a literal value into a password field. Store it as a secret and use {env:NAME} instead.',
        re: /(?:enters?|types?|fills?|inputs?|sets?)\s+"(?<v>[^"]{4,})"\s+(?:in|into|for)\s+(?:the\s+)?"[^"]*?(?:password|passwd|secret|\bpwd\b|\bpin\b)[^"]*"/gi,
        fileFilter: /\.(feature|ts|js)$/i,
        accept: notPlaceholder,
    },
];

export interface FileRule {
    id: string;
    type: string;
    confidence: Confidence;
    reason: string;
    re: RegExp; // tested against the repo-relative path
    /** Optional content check (for text files) — e.g. storageState JSON must contain cookies. */
    contentCheck?: (text: string) => boolean;
}

export const FILE_RULES: FileRule[] = [
    {
        id: 'certificate-or-key-file',
        type: 'Certificate or key file',
        confidence: 'high',
        reason: 'Certificate/key files (.pfx, .p12, .key, .jks, .keystore) contain private keys. Store them as secrets instead.',
        re: /\.(pfx|p12|key|jks|keystore)$/i,
    },
    {
        id: 'pem-private-key-file',
        type: 'PEM file with private key',
        confidence: 'high',
        reason: 'This .pem file contains a private key.',
        re: /\.pem$/i,
        contentCheck: (t) => /PRIVATE KEY-----/.test(t),
    },
    {
        id: 'har-file',
        type: 'HAR network recording',
        confidence: 'medium',
        reason: 'HAR files capture full requests, including cookies and Authorization headers.',
        re: /\.har$/i,
    },
    {
        id: 'browser-session-file',
        type: 'Saved browser session',
        confidence: 'high',
        reason: 'A saved Playwright storage state contains login cookies and tokens.',
        re: /(storage[-_]?state|auth[-_]?state|\.auth\/)[^/]*\.json$/i,
        contentCheck: (t) => /"cookies"\s*:/.test(t) && /"origins"\s*:/.test(t),
    },
    {
        id: 'personal-env-file',
        type: 'Personal environment file',
        confidence: 'high',
        reason: 'Personal override files (.env.local, *.local.env) hold your own credentials and should be git-ignored.',
        re: /(^|\/)(\.env\.local|[^/]*\.local\.env)$/i,
    },
];
