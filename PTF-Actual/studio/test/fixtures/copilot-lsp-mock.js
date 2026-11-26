#!/usr/bin/env node
/**
 * A stand-in for GitHub's Copilot language server (@github/copilot-language-server), for tests and
 * browser checks: LSP over stdio, no network. Point the Studio at it with
 *   CS_STUDIO_COPILOT_LSP=/path/to/copilot-lsp-mock.js
 * It implements initialize, checkStatus, signIn (device flow, finished through
 * workspace/executeCommand github.copilot.finishDeviceFlow), signOut, auth/listAvailableTokens,
 * auth/useExistingToken, textDocument/didOpen|didChange (incremental)|didClose|didFocus,
 * textDocument/inlineCompletion (canned suggestions) and the telemetry notifications.
 * Environment:
 *   MOCK_COPILOT_STATE   a JSON file kept across restarts: { "signedIn": true, "user": "..." }
 *   MOCK_COPILOT_LOG     a file: one JSON line per message the client sent (for assertions)
 *   MOCK_COPILOT_DELAY   milliseconds before an inline completion answer (default 30)
 *   MOCK_COPILOT_EXISTING  "1": offer an existing sign-in from "another editor"
 *   MOCK_COPILOT_CRASH   "1": exit when asked for an inline completion whose line contains "crash"
 */
const fs = require('fs');

const stateFile = process.env.MOCK_COPILOT_STATE;
const logFile = process.env.MOCK_COPILOT_LOG;
const delay = Number(process.env.MOCK_COPILOT_DELAY ?? 30);
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { signedIn: false }; } };
const writeState = (s) => { if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(s)); };
let state = readState();
const docs = new Map();
const pendingTimers = new Map();
let nextId = 1;
const waiting = new Map();

function log(entry) { if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\n'); }
function send(msg) { const b = Buffer.from(JSON.stringify(msg), 'utf8'); process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`); process.stdout.write(b); }
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
function ask(method, params) { const id = `s${nextId++}`; send({ jsonrpc: '2.0', id, method, params }); return new Promise((r) => waiting.set(id, r)); }

function offsetAt(text, pos) {
    let off = 0;
    for (let l = 0; l < pos.line; l++) { const n = text.indexOf('\n', off); if (n < 0) return text.length; off = n + 1; }
    return Math.min(text.length, off + pos.character);
}

function suggestions(text, pos) {
    const off = offsetAt(text, pos);
    const lineStart = text.lastIndexOf('\n', off - 1) + 1;
    const before = text.slice(lineStart, off);
    const indent = /^\s*/.exec(before)[0];
    const range = { start: { line: pos.line, character: 0 }, end: pos };
    const item = (insertText, id) => ({ insertText, range, command: { title: 'Completion accepted', command: 'github.copilot.didAcceptCompletionItem', arguments: [id] } });
    if (/value\.$/.test(before)) return [item(`${before}toUpperCase();`, 'mock-upper'), item(`${before}trim();`, 'mock-trim')];
    if (/\/\/ copilot: multi\s*$/.test(before) || /^\s*$/.test(before) && /\/\/ copilot: multi\s*\n\s*$/.test(text.slice(0, off))) {
        return [item(`${indent}const total = items.length;\n${indent}console.log('total', total);\n${indent}return total;`, 'mock-multi')];
    }
    if (/const greeting = $/.test(before)) return [item(`${before}'Hello, world';`, 'mock-greet'), item(`${before}\`Hello, \${name}\`;`, 'mock-greet2')];
    if (/^\s*$/.test(before)) return [item(`${indent}await page.waitForLoadState('networkidle');`, 'mock-wait')];
    return [];
}

async function handle(msg) {
    const { id, method, params } = msg;
    if (method === undefined && id !== undefined) { const r = waiting.get(id); if (r) { waiting.delete(id); r(msg.result); } return; }
    log({ method, params });
    switch (method) {
        case 'initialize':
            return reply(id, { capabilities: { textDocumentSync: { openClose: true, change: 2 }, inlineCompletionProvider: {}, workspace: { workspaceFolders: { supported: true } } }, serverInfo: { name: 'copilot-lsp-mock', version: '0.0.1' } });
        case 'initialized': case 'workspace/didChangeConfiguration': case 'textDocument/didFocus': case '$/setTrace': return;
        case 'shutdown': return reply(id, null);
        case 'exit': return process.exit(0);
        case 'checkStatus':
            state = readState();
            return reply(id, state.signedIn ? { status: 'OK', user: state.user ?? 'mock-user' } : { status: 'NotSignedIn' });
        case 'signIn': case 'signInInitiate':
            if (state.signedIn) return reply(id, { status: 'AlreadySignedIn', user: state.user ?? 'mock-user' });
            return reply(id, { status: 'PromptUserDeviceFlow', userCode: 'MOCK-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5, command: { command: 'github.copilot.finishDeviceFlow', title: 'Sign in with GitHub', arguments: [] } });
        case 'signOut': state = { signedIn: false }; writeState(state); notify('didChangeStatus', { kind: 'Error', message: 'You are not signed into GitHub.', busy: false }); return reply(id, { status: 'NotSignedIn' });
        case 'auth/listAvailableTokens': return reply(id, { tokens: process.env.MOCK_COPILOT_EXISTING === '1' && !state.signedIn ? [{ tokenId: 7, authAuthority: 'https://github.com', userLogin: 'other-editor-user', isCurrent: false }] : [] });
        case 'auth/useExistingToken': state = { signedIn: true, user: 'other-editor-user' }; writeState(state); return reply(id, null);
        case 'workspace/executeCommand':
            if (params.command === 'github.copilot.finishDeviceFlow') {
                await ask('window/showDocument', { uri: 'https://github.com/login/device', external: true });
                const wait = Number(process.env.MOCK_COPILOT_SIGNIN_MS ?? 300);
                await new Promise((r) => setTimeout(r, wait));
                state = { signedIn: true, user: 'mock-user' }; writeState(state);
                notify('didChangeStatus', { kind: 'Normal', message: '', busy: false });
                return reply(id, { status: 'OK', user: 'mock-user' });
            }
            return reply(id, null);
        case 'textDocument/didOpen': docs.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version }); return;
        case 'textDocument/didChange': {
            const d = docs.get(params.textDocument.uri);
            if (!d) return;
            for (const c of params.contentChanges) {
                if (!c.range) { d.text = c.text; continue; }
                const s = offsetAt(d.text, c.range.start), e = offsetAt(d.text, c.range.end);
                d.text = d.text.slice(0, s) + c.text + d.text.slice(e);
            }
            d.version = params.textDocument.version;
            log({ method: 'mock/text', params: { uri: params.textDocument.uri, version: d.version, text: d.text } });
            return;
        }
        case 'textDocument/didClose': docs.delete(params.textDocument.uri); return;
        case 'textDocument/didShowCompletion': case 'textDocument/didPartiallyAcceptCompletion': return;
        case '$/cancelRequest': {
            const t = pendingTimers.get(params.id);
            if (t) { clearTimeout(t.timer); pendingTimers.delete(params.id); fail(params.id, -32800, 'Request cancelled'); }
            return;
        }
        case 'textDocument/inlineCompletion': {
            if (!state.signedIn) return fail(id, 1000, 'Not signed in');
            const d = docs.get(params.textDocument.uri);
            if (!d) return reply(id, { items: [] });
            const lineText = d.text.split('\n')[params.position.line] ?? '';
            if (process.env.MOCK_COPILOT_CRASH === '1' && lineText.includes('crash')) process.exit(3);
            // Cancel-previous, like the real server.
            for (const [pid, t] of pendingTimers) { clearTimeout(t.timer); fail(pid, -32800, 'Request cancelled'); pendingTimers.delete(pid); }
            const timer = setTimeout(() => {
                pendingTimers.delete(id);
                let items = suggestions(d.text, params.position);
                if (params.context?.triggerKind !== 1) items = items.slice(0, 1);
                reply(id, { items });
            }, delay);
            pendingTimers.set(id, { timer });
            return;
        }
        default:
            if (id !== undefined) return fail(id, -32601, `Unhandled method ${method}`);
    }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
        const h = buf.indexOf('\r\n\r\n');
        if (h < 0) return;
        const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, h).toString())[1]);
        if (buf.length < h + 4 + len) return;
        const body = buf.subarray(h + 4, h + 4 + len).toString('utf8');
        buf = buf.subarray(h + 4 + len);
        handle(JSON.parse(body)).catch((e) => process.stderr.write(String(e && e.stack || e) + '\n'));
    }
});
process.stdin.on('end', () => process.exit(0));
