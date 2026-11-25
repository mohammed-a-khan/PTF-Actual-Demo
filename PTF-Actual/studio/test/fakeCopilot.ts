/**
 * A fake Copilot runtime package (@github/copilot-sdk's shape) for tests: GitHub's side of the sign-in
 * (code, Enterprise host, account choice, keychain consent), the account, quota and models.
 * scenario: device (plain) | accounts (two accounts to choose from) | consent (no keychain) | fail.
 */
import * as fs from 'fs';
import * as path from 'path';

export function writeFakeCopilotSdk(runtimeDir: string, o: { version?: string; scenario?: string; delayMs?: number } = {}) {
    const dir = path.join(runtimeDir, 'node_modules', '@github', 'copilot-sdk');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@github/copilot-sdk', version: o.version ?? '9.9.9', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), `
const st = global.__fakeCopilot = global.__fakeCopilot || { signedIn: false, login: null, host: 'https://github.com', scenario: ${JSON.stringify(o.scenario ?? 'device')}, delay: ${o.delayMs ?? 30}, flows: {}, n: 0, cancelled: 0 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (login, host) => { st.signedIn = true; st.login = login; st.host = host; return { kind: 'completed', result: { status: 'completed', login, host } }; };
class Session {
  constructor() {
    this.sessionId = 'fake-' + (++st.n);
    this.rpc = {
      accounts: {
        login: {
          begin: async ({ kind, method }) => {
            const flowId = 'flow-' + (++st.n);
            st.flows[flowId] = { kind, method, stage: kind === 'proxima' ? 'host' : 'auth', host: 'https://github.com' };
            if (kind === 'proxima') return { flowId, step: { kind: 'input-required', prompt: 'Enter your GitHub Enterprise Cloud host (e.g. https://your-tenant.ghe.com)' } };
            return { flowId, step: firstStep(method, 'https://github.com') };
          },
          advance: async ({ flowId, input }) => {
            const f = st.flows[flowId];
            if (!f) throw new Error('Request session.accounts.login.advance failed with message: unknown flow');
            if (f.stage === 'host') { if (!/^https:\\/\\/[\\w-]+\\.ghe\\.com$/.test(input || '')) return { kind: 'error', message: 'Not a GitHub Enterprise Cloud host: ' + input }; f.host = input; f.stage = 'auth'; return firstStep(f.method, input); }
            if (f.stage === 'auth') {
              await wait(st.delay);
              if (f.cancelled) throw new Error('cancelled');
              if (st.scenario === 'fail') return { kind: 'error', message: 'The device code expired.' };
              if (st.scenario === 'accounts') { f.stage = 'choose'; return { kind: 'completed', result: { status: 'needs-account-selection', accounts: [{ selectionId: 'sel-work', host: f.host, login: 'akhan-work', kind: 'github' }, { selectionId: 'sel-home', host: f.host, login: 'akhan', kind: 'github' }] } }; }
              if (st.scenario === 'consent') { f.stage = 'consent'; return { kind: 'completed', result: { status: 'needs-plaintext-consent' } }; }
              return done('akhan', f.host);
            }
            if (f.stage === 'choose') return done(input === 'sel-work' ? 'akhan-work' : 'akhan', f.host);
            if (f.stage === 'consent') return input === 'allow' ? done('akhan', f.host) : { kind: 'completed', result: { status: 'declined' } };
            return { kind: 'error', message: 'bad stage' };
          },
          cancel: async ({ flowId }) => { if (st.flows[flowId]) st.flows[flowId].cancelled = true; st.cancelled++; },
        },
        set: async ({ command }) => { if (command.kind === 'switchActive') { st.login = command.selectionId === 'sel-work' ? 'akhan-work' : 'akhan'; } return { ok: true }; },
      },
    };
  }
  on(h) { (st.handlers = st.handlers || []).push(h); return () => {}; }
  async disconnect() {}
}
function firstStep(method, host) {
  return method === 'device-code'
    ? { kind: 'device-code', userCode: 'ABCD-1234', verificationUri: host + '/login/device', expiresIn: 900, interval: 5 }
    : { kind: 'open-url', url: host + '/login/oauth/authorize?client_id=fake&state=x' };
}
class CopilotClient {
  constructor(o) { this.o = o; this.rpc = { account: {
    getQuota: async () => ({ quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 300, usedRequests: 42, remainingPercentage: 86, overage: 0, overageAllowedWithExhaustedQuota: false, usageAllowedWithExhaustedQuota: false, resetDate: '2026-12-01T00:00:00Z' } } }),
    getAllUsers: async () => st.signedIn ? [{ selectionId: 'sel-home', authInfo: { type: 'user', host: st.host, login: 'akhan' }, token: 'never-shown' }, { selectionId: 'sel-work', authInfo: { type: 'user', host: st.host, login: 'akhan-work' }, token: 'never-shown' }] : [],
    logout: async () => { st.signedIn = false; st.login = null; return { hasMoreUsers: false }; },
  } }; }
  async start() {}
  async stop() {}
  async getAuthStatus() { return st.signedIn ? { isAuthenticated: true, authType: 'user', login: st.login, host: st.host } : { isAuthenticated: false, statusMessage: 'Not authenticated' }; }
  async listModels() { return [{ id: 'gpt-mini', name: 'GPT mini', billing: { multiplier: 0 } }, { id: 'big-model', name: 'Big model', billing: { multiplier: 1 } }, { id: 'off-model', name: 'Off model', policy: { state: 'disabled', terms: '' } }]; }
  async createSession(c) { st.lastConfig = c; return new Session(); }
  async resumeSession() { return new Session(); }
}
module.exports = { CopilotClient };
`);
    return dir;
}

/** A fake npm: installs the fake SDK (ok), or fails like a registry refusal (e401) or a missing package (e404). */
export function writeFakeNpm(file: string, mode: 'ok' | 'e401' | 'e404') {
    fs.writeFileSync(file, `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
console.log('npm install ' + args[1]);
if (${JSON.stringify(mode)} === 'e401') { console.error('npm error code E401'); console.error('npm error Unable to authenticate, need: Basic realm="Artifactory"'); process.exit(1); }
if (${JSON.stringify(mode)} === 'e404') { console.error('npm error code E404'); console.error('npm error 404 Not Found - GET https://registry.example/@github%2fcopilot-sdk'); process.exit(1); }
const v = args[1].split('@').pop() === 'latest' ? '2.0.0' : args[1].split('@').pop();
const d = path.join(prefix, 'node_modules', '@github', 'copilot-sdk');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: '@github/copilot-sdk', version: v }));
console.log('added 2 packages in 1s');
`);
}
