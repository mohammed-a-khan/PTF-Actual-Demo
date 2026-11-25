/**
 * Recording sessions: Playwright's recorder (`playwright codegen`) from the repository's own installed
 * Playwright and browsers, opened on the tester's computer. It writes the recorded script to a file
 * after every action; the Studio reads it while recording (live preview) and when the browser is closed.
 * Scripts are kept in the repository's Git folder (never in the working tree) until saved as tests.
 */
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StudioRecorder } from './studioRecorder';
import { UserError } from '../core/errors';

/** An address typed without a scheme: a host gets one (http for this computer, https otherwise); others stay as typed. */
export function withScheme(u: string): string {
    if (!u || (/^[a-z][a-z\d+.-]*:/i.test(u) && !/^(localhost|[\w.-]+\.[a-z]{2,}|\d{1,3}(\.\d{1,3}){3}):\d+/i.test(u))) return u;
    return `${/^(localhost|127\.|\[?::1|\d{1,3}(\.\d{1,3}){3})/i.test(u) ? 'http' : 'https'}://${u}`;
}

export interface RecordOptions {
    url: string;
    browser?: 'chromium' | 'firefox' | 'webkit' | 'msedge' | 'chrome';
    /** Attribute the application uses for test ids (data-testid, data-qa…). */
    testIdAttribute?: string;
    device?: string;
    viewport?: { width: number; height: number };
    /** The project's locator policy (regular expression sources: ids and classes never used to find an element). */
    policy?: { ignoreId?: string; ignoreClass?: string };
    ignoreHttpsErrors?: boolean;
    /** Studio's proxy (manual setting), for the recorded browser. */
    proxy?: { server: string; bypass?: string };
    /** In-Studio recording in a visible browser window on this computer (instead of the picture). */
    window?: boolean;
}

export interface Recording {
    id: string;
    url: string;
    state: 'recording' | 'finished' | 'failed';
    startedAt: string;
    endedAt?: string;
    error?: string;
    testIdAttribute: string;
    /** studio: recorded inside the Studio (its own browser, shown live); playwright: Playwright's recorder window. */
    engine?: 'studio' | 'playwright';
    /** In-Studio recording in a visible browser window on this computer. */
    window?: boolean;
    /** Its details could not be saved (the disk is full, the folder is read only): shown, so nobody relies on them. */
    saveProblem?: string;
    /** The name it was saved under, and the feature written (opened again, it keeps them). */
    name?: string;
    savedAs?: string;
}

const ID = /^[a-z0-9]{8,32}$/;

/** The Playwright command line installed in the repository (as the framework uses it). */
export function playwrightCli(repoRoot: string): string | null {
    // The packages' exports do not include cli.js: look in node_modules from the repository folder up
    // (as Node resolves packages; covers hoisted workspaces).
    for (let dir = path.resolve(repoRoot); ; dir = path.dirname(dir)) {
        for (const m of ['@playwright/test', 'playwright']) {
            const cli = path.join(dir, 'node_modules', m, 'cli.js');
            if (fs.existsSync(cli)) return cli;
        }
        if (path.dirname(dir) === dir) return null;
    }
}

export function codegenArgs(file: string, o: RecordOptions): string[] {
    const a = ['codegen', '--target', 'playwright-test', '--output', file];
    if (o.browser === 'firefox' || o.browser === 'webkit') a.push('--browser', o.browser);
    else if (o.browser === 'msedge' || o.browser === 'chrome') a.push('--channel', o.browser);
    if (o.testIdAttribute && o.testIdAttribute !== 'data-testid') a.push('--test-id-attribute', o.testIdAttribute);
    if (o.device) a.push('--device', o.device);
    if (o.viewport) a.push('--viewport-size', `${o.viewport.width},${o.viewport.height}`);
    if (o.ignoreHttpsErrors) a.push('--ignore-https-errors');
    if (o.proxy?.server) { a.push('--proxy-server', o.proxy.server); if (o.proxy.bypass) a.push('--proxy-bypass', o.proxy.bypass); }
    a.push(o.url);
    return a;
}

export class RecorderSessions {
    private procs = new Map<string, { child: ChildProcess; rec: Recording; stderr: string; stopped: boolean }>();
    private studio = new Map<string, { rec: Recording; recorder: StudioRecorder }>();

    constructor(private readonly o: { repoRoot: string; dir: string; env?: () => Record<string, string> }) {}

    private file(id: string) { return path.join(this.o.dir, `${id}.spec.ts`); }
    /** Files the tester uploaded while recording (copied to the project's data folder when the test is saved). */
    uploadDir(id: string) { return ID.test(id) ? path.join(this.o.dir, `${id}-files`) : ''; }
    uploads(id: string): string[] { try { return fs.readdirSync(this.uploadDir(id)).filter((f) => fs.statSync(path.join(this.uploadDir(id), f)).isFile()).sort(); } catch { return []; } }
    private meta(id: string) { return path.join(this.o.dir, `${id}.json`); }

    /** Record inside the Studio (one at a time: a new recording ends the one before). */
    async startStudio(opts: RecordOptions): Promise<Recording> {
        let u: URL;
        try { u = new URL(withScheme(String(opts.url ?? '').trim())); } catch { throw new Error('Enter the address to start recording at (https://…).'); }
        if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses can be recorded.');
        if (opts.testIdAttribute && !/^[\w-]{1,60}$/.test(opts.testIdAttribute)) throw new Error('Test id attribute: letters, digits, - and _ only.');
        for (const id of [...this.studio.keys()]) await this.stopStudio(id);
        fs.mkdirSync(this.o.dir, { recursive: true });
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const file = this.file(id);
        fs.writeFileSync(file, '');
        const rec: Recording = { id, url: u.toString(), state: 'recording', startedAt: new Date().toISOString(), testIdAttribute: opts.testIdAttribute || 'data-testid', engine: 'studio', ...(opts.window ? { window: true } : {}) };
        const recorder = new StudioRecorder({
            repoRoot: this.o.repoRoot, file, uploadDir: this.uploadDir(id), testIdAttribute: rec.testIdAttribute, proxy: opts.proxy, ignoreHttpsErrors: opts.ignoreHttpsErrors, viewport: opts.viewport, window: !!opts.window, policy: opts.policy,
            onClosed: () => { if (rec.state === 'recording') { rec.state = 'finished'; rec.endedAt = new Date().toISOString(); this.save(rec); } if (this.studio.get(id)?.rec === rec) this.studio.delete(id); },
        });
        this.studio.set(id, { rec, recorder });
        this.save(rec);
        try { await recorder.start(u.toString()); }
        catch (e) {
            rec.state = 'failed'; rec.endedAt = new Date().toISOString();
            const m = (e as Error).message.split('\n')[0];
            rec.error = /ERR_[A-Z_]+/.test(m) ? `The start address could not be opened (${/ERR_[A-Z_]+/.exec(m)?.[0]}): ${rec.url}. Check the address, the network or proxy, or turn on "Ignore certificate errors" for a test server.` : m;
            this.save(rec);
            if (this.studio.get(id)?.rec === rec) this.studio.delete(id);
            await recorder.close().catch(() => undefined);
        }
        return rec;
    }

    /**
     * Record more in a finished in-Studio recording, from one of its steps (an action index, as the review numbers
     * them): its steps up to that one are done again in the Studio's browser, then new steps go after it.
     */
    async continueStudio(id: string, upTo: number, opts: Omit<RecordOptions, 'url'>): Promise<Recording> {
        const had = this.get(id);
        if (!had) throw new Error('No such recording.');
        if (had.engine !== 'studio') throw new Error('Only a recording made in the Studio can be continued.');
        if (this.studio.has(id) || had.state === 'recording') throw new Error('This recording is running.');
        if (!had.script.trim()) throw new Error('This recording has no steps.');
        for (const other of [...this.studio.keys()]) await this.stopStudio(other);
        const { script, ...meta } = had;
        const rec: Recording = { ...meta, state: 'recording', endedAt: undefined, error: undefined };
        const recorder = new StudioRecorder({
            repoRoot: this.o.repoRoot, file: this.file(id), uploadDir: this.uploadDir(id), testIdAttribute: rec.testIdAttribute, proxy: opts.proxy, ignoreHttpsErrors: opts.ignoreHttpsErrors, viewport: opts.viewport, window: !!rec.window, policy: opts.policy,
            onClosed: () => { if (rec.state === 'recording') { rec.state = 'finished'; rec.endedAt = new Date().toISOString(); this.save(rec); } if (this.studio.get(id)?.rec === rec) this.studio.delete(id); },
        });
        this.studio.set(id, { rec, recorder });
        this.save(rec);
        try { await recorder.resume(script, upTo); }
        catch (e) {
            // The recording is as it was.
            fs.writeFileSync(this.file(id), script);
            rec.state = 'finished'; rec.endedAt = new Date().toISOString(); this.save(rec);
            if (this.studio.get(id)?.rec === rec) this.studio.delete(id);
            await recorder.close().catch(() => undefined);
            throw e;
        }
        return rec;
    }

    /** The in-Studio recorder of a recording that is running. */
    studioOf(id: string): StudioRecorder | null { return this.studio.get(id)?.recorder ?? null; }

    /** Stop and wait until the recording's last steps are written. */
    async stopAndWait(id: string): Promise<boolean> { return this.studio.has(id) ? this.stopStudio(id) : this.stop(id); }

    private async stopStudio(id: string) {
        const s = this.studio.get(id);
        if (!s) return false;
        await s.recorder.close().catch(() => undefined);
        if (s.rec.state === 'recording') { s.rec.state = 'finished'; s.rec.endedAt = new Date().toISOString(); this.save(s.rec); }
        this.studio.delete(id);
        return true;
    }

    start(opts: RecordOptions): Recording {
        let u: URL;
        try { u = new URL(withScheme(String(opts.url ?? '').trim())); } catch { throw new Error('Enter the address to start recording at (https://…).'); }
        if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses can be recorded.');
        if (opts.testIdAttribute && !/^[\w-]{1,60}$/.test(opts.testIdAttribute)) throw new Error('Test id attribute: letters, digits, - and _ only.');
        if (opts.device && !/^[\w .()-]{1,60}$/.test(opts.device)) throw new Error('Unknown device name.');
        const cli = playwrightCli(this.o.repoRoot);
        if (!cli) throw new Error('Playwright is not installed in this repository (the framework installs it): run npm install.');
        fs.mkdirSync(this.o.dir, { recursive: true });
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const file = this.file(id);
        fs.writeFileSync(file, '');
        const rec: Recording = { id, url: u.toString(), state: 'recording', startedAt: new Date().toISOString(), testIdAttribute: opts.testIdAttribute || 'data-testid' };
        const child = spawn(process.execPath, [cli, ...codegenArgs(file, { ...opts, url: u.toString() })], {
            cwd: this.o.repoRoot, env: { ...process.env, ...(this.o.env?.() ?? {}) }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false,
        });
        const entry = { child, rec, stderr: '', stopped: false };
        child.stderr?.on('data', (d: Buffer) => { entry.stderr = (entry.stderr + d.toString()).slice(-6000); });
        const done = (code: number | null, signal: NodeJS.Signals | null, err?: Error) => {
            if (rec.state !== 'recording') return;
            rec.endedAt = new Date().toISOString();
            // Closing the browser ends the recorder normally; Stop ends it with a signal. Anything else
            // is a failure (the script so far is kept).
            if (err || (!entry.stopped && !signal && code !== null && code !== 0)) {
                rec.state = 'failed';
                // The message without Node's stack lines and box drawing.
                const lines = entry.stderr.split('\n').map((l) => l.replace(/[║╔╗╚╝═]/g, '').trim())
                    .filter((l) => l && !/^at |^node:internal|triggerUncaughtException|^\^$|^Node\.js v|^log: |^name: |^}$|^\{$/.test(l));
                rec.error = (err?.message ?? lines.slice(0, 8).join('\n')) || `The recorder ended (exit code ${code}).`;
                if (/Executable doesn't exist|browserType\.launch/i.test(rec.error)) rec.error += '\nThe browser is not installed for this repository\'s Playwright: run npx playwright install chromium (or choose another browser).';
                if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CERT/i.test(rec.error)) rec.error = `The start address could not be opened (${/ERR_[A-Z_]+/.exec(rec.error)?.[0]}): ${rec.url}\nUse an address that opens a page (for example the login page), check the network or proxy, or turn on "Ignore certificate errors" for a test server.`;
                if (/Missing X server|DISPLAY/i.test(rec.error)) rec.error += '\nRecording opens a browser window: run the Studio on a computer with a desktop (not a server without a display).';
            } else rec.state = 'finished';
            this.procs.delete(id);
            this.save(rec);
        };
        child.on('exit', (code, signal) => done(code, signal));
        child.on('error', (e) => done(null, null, e));
        this.procs.set(id, entry);
        this.save(rec);
        return rec;
    }

    /** The recording's details, written whole (a temporary file renamed): a failure is kept on it and shown. */
    private save(rec: Recording) {
        const file = this.meta(rec.id), tmp = `${file}.${process.pid}.tmp`;
        try { const { saveProblem, ...keep } = rec; void saveProblem; fs.writeFileSync(tmp, JSON.stringify(keep)); fs.renameSync(tmp, file); delete rec.saveProblem; }
        catch (e) { rec.saveProblem = `The recording's details could not be saved: ${(e as Error).message}`; try { fs.unlinkSync(tmp); } catch { /* none */ } }
    }

    get(id: string): (Recording & { script: string }) | null {
        if (!ID.test(id)) return null;
        const live = this.procs.get(id)?.rec ?? this.studio.get(id)?.rec;
        let rec = live;
        if (!rec) { try { rec = JSON.parse(fs.readFileSync(this.meta(id), 'utf8')) as Recording; } catch { return null; } }
        // A recording still marked as running but with no process (the Studio restarted) is finished.
        if (rec.state === 'recording' && !live) rec = { ...rec, state: 'finished' };
        return { ...rec, script: this.script(id) };
    }

    /** A finished recording changed in review: its steps (a mis-recorded one deleted), the name it was saved under. */
    update(id: string, u: { script?: string; name?: string; savedAs?: string }): Recording & { script: string } {
        const rec = this.get(id);
        if (!rec) throw new UserError('This recording is not there any more.');
        if (rec.state === 'recording') throw new UserError('Stop the recording first.');
        if (u.script !== undefined) fs.writeFileSync(this.file(id), u.script);
        const { script: _s, ...meta } = rec; void _s;
        const next: Recording = { ...meta, ...(u.name !== undefined ? { name: u.name.slice(0, 80) } : {}), ...(u.savedAs !== undefined ? { savedAs: u.savedAs } : {}) };
        this.save(next);
        return { ...next, script: this.script(id) };
    }

    script(id: string): string {
        try { return fs.readFileSync(this.file(id), 'utf8'); } catch { return ''; }
    }

    /** Close the recorded browser (the script so far is kept). */
    stop(id: string): boolean {
        if (this.studio.has(id)) { void this.stopStudio(id); return true; }
        const p = this.procs.get(id);
        if (!p) return false;
        p.stopped = true;
        p.child.kill('SIGTERM');
        setTimeout(() => { if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL'); }, 5000).unref();
        return true;
    }

    list(): Recording[] {
        let names: string[] = [];
        try { names = fs.readdirSync(this.o.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
        return names.map((f) => this.get(f.replace(/\.json$/, ''))).filter((r): r is Recording & { script: string } => !!r)
            .map(({ script: _s, ...r }) => r).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
    }

    remove(id: string): boolean {
        if (!ID.test(id)) return false;
        this.stop(id);
        let removed = false;
        for (const f of [this.file(id), this.meta(id)]) { try { fs.rmSync(f); removed = true; } catch { /* gone */ } }
        fs.rmSync(this.uploadDir(id), { recursive: true, force: true });
        return removed;
    }

    stopAll() { for (const id of [...this.procs.keys(), ...this.studio.keys()]) this.stop(id); }
}
