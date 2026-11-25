/**
 * A recording as framework code, built on what the project already has:
 *  - Test data: typed values (and checks that depend on them) go into a JSON data file
 *    (test/<project>/data/<name>.json, { "data": [ { testCaseId, description, runFlag, … } ] }) read by
 *    a Scenario Outline with the framework's external Examples (runFlag=Yes rows run). Each value can
 *    instead be fixed text in the feature, or a secret: an ENCRYPTED: value (the project's framework
 *    decrypts it) or a Studio secret ({env:NAME}).
 *  - Page objects: a page the project has (same class) is extended with only the elements it lacks;
 *    elements it has (same locator) are used as they are. New pages get new classes.
 *  - Steps: a feature line that an existing definition (project or framework) already matches uses it;
 *    only missing definitions are written, into the step file of that page (one per page, extended later).
 *  - Configuration: addresses are BASE_URL (or another …_URL key of the project) + the recorded path, so
 *    tests run in every environment; missing keys, a new project's configuration and the step folder in
 *    STEP_DEFINITIONS_PATH are added to the configuration files.
 * Locators are the recorded Playwright selectors (see convert.ts).
 */
import type * as TS from 'typescript';
import type { Action, Target } from './convert';
import { addStepFolder, ExistingPage, insertIntoClass, pageFieldOf, setEnvKey, stepClassOf } from '../framework/code';
import type { ProjectContext } from '../framework/model';
import { camel, kebab, pascal, quoted, snake, stepSafe, tsString, words } from '../framework/text';
import { formatOf, jsonRowsPath, Table, toCsv, writeJson } from '../data/tables';
import { alternativeOf, FwLocator, LINT_MIN_SCORE, LocatorPolicy, rankLocators } from '../framework/locators';

/** Options the framework's CSWebElement finds an element by (placeholder only as an alternative). */
const PRIMARY_KEYS = new Set(['testId', 'id', 'name', 'role', 'text']);

type Ts = typeof TS;

/** data: a column of the data file; fixed: in the feature; secret: encrypted or a Studio secret; unique: a new value in each run (typed values). */
export type ValueMode = 'data' | 'fixed' | 'secret' | 'unique' | 'date';
export interface Choices {
    /** Name of the recording (feature, data file). */
    name: string;
    /** Page names by the index of the action that starts the page (index 0 always starts one). */
    breaks?: Record<number, string>;
    /** Element names by element key (page class | frames | selector). */
    labels?: Record<string, string>;
    /** The locator the tester chose for an element (by element key): one of its framework locators confirmed while recording. */
    locators?: Record<string, { key: FwLocator['key']; value: string }>;
    /** The project's locator policy (common env: RECORDER_LOCATOR_ORDER, RECORDER_IGNORE_ID_PATTERN). */
    policy?: LocatorPolicy;
    /** How each action's value is written. */
    values?: Record<number, { mode?: ValueMode; column?: string; /** date: when ("today + 7 days") and the format the application shows (dd/MM/yyyy). */ when?: string; format?: string }>;
    /** Secrets as ENCRYPTED: values in the data file (default) or Studio secrets ({env:NAME}). */
    secretMode?: 'encrypted' | 'studio';
    /** The test data file: a new one in a format, or one the project has (its rows kept, the recording's columns added). */
    data?: DataChoice;
    /** Values read from a database in every run: by action index, the source's name and column. */
    fetched?: Record<number, { name: string; column: string }>;
    /** Those sources by name (written to <data folder>/test-data-sources.json). */
    sources?: Record<string, FetchSource>;
    /**
     * The sign-in: the steps up to this check (the index of a check that shows the user is signed in)
     * become one step that signs in, or reuses the saved session (AUTH_STORAGE_STATE_PATH).
     */
    signIn?: { marker: number };
    /** Values remembered while recording (name → the value then): later steps with the same value use the remembered one. */
    remembered?: Record<string, string>;
    /** Steps done only when their element is shown (e.g. a dialog that appears now and then), by action index. */
    optional?: Record<number, boolean>;
    /**
     * Reusable steps: the steps of actions from..to (inclusive) as one step the project's other tests can use
     * (`text`, its values as {string}/{int} in order; default: the name and "with {string} and …").
     */
    blocks?: Array<{ from: number; to: number; name: string; text?: string }>;
    pkg?: string;
}

/** A database query, stored procedure or API request the scenario reads its test data from (first row). */
export interface FetchSource { kind: 'query' | 'procedure' | 'api'; connection?: string; sql?: string; procedure?: string; params?: string[]; collection?: string; request?: string; path?: string }

export interface DataChoice {
    /** Format of a new data file (default json). */
    format?: 'json' | 'csv' | 'excel';
    /** A data file of the project to use instead (.json, .csv, .xlsx, .xls; .xml read only). */
    file?: string;
    /** Excel sheet (default: the file's first, "Data" for a new workbook). */
    sheet?: string;
    /** JSON: where the rows are (default $.data[*]). */
    path?: string;
    /** Rows that run (framework filter, e.g. runFlag=Yes;env=dev); default runFlag=Yes when the file has that column. */
    filter?: string;
    /** The file as it is now, read by the caller (plan() reads no files); absent: a new file. */
    existing?: Table;
    /** existing holds rows to write that the file does not have yet (e.g. copied from a database or an API). */
    fresh?: boolean;
}

export interface PlanFile { path: string; text: string; kind: 'feature' | 'data' | 'page' | 'steps' | 'config' | 'other'; change: 'new' | 'update'; encode?: { as: 'xlsx'; sheet: string }; shownBefore?: string | null }
export interface PlanRow {
    index: number; kind: Action['kind']; page: string; pageExisting: boolean;
    element?: string; elementKey?: string; elementReused?: boolean;
    /** A new element's framework locators confirmed while recording, the one written first (the picker). */
    locators?: FwLocator[]; locator?: { key: FwLocator['key']; value: string };
    line: string; stepReused: boolean;
    value?: string; mode?: ValueMode; column?: string; sensitive?: boolean;
    /** The value is read from a database in every run: its reference (name.column). */
    testData?: string;
    /** The step ends the sign-in (the steps before it are part of it). */
    signIn?: boolean;
    /** The value is one remembered earlier (its name). */
    remembered?: string;
    /** A date relative to the run (mode date): when and the format. */
    date?: { when: string; format: string };
    /** The recorded value reads as a date (the review offers "Date"). */
    dateLike?: boolean;
    /** The step is part of a reusable step (its text). */
    block?: string;
}
export interface Plan {
    files: PlanFile[];
    rows: PlanRow[];
    pages: Array<{ name: string; className: string; existing: boolean; file: string }>;
    /** Studio secrets to save (secretMode studio). */
    secrets: Array<{ name: string; value: string }>;
    /** Values to encrypt with the project's framework when saving: token in the data file → value. */
    encrypt: Array<{ token: string; value: string }>;
    warnings: string[];
    summary: { stepsReused: number; stepsNew: number; elementsReused: number; elementsNew: number };
}

export const SENSITIVE = /pass(word|code|phrase)?|pwd|secret|\bpin\b|otp|token|ssn|card.?number|cvv|security.?code/i;

const ROLE_SUFFIX: Record<string, string> = {
    button: 'Button', link: 'Link', textbox: 'Field', searchbox: 'Field', checkbox: 'Checkbox', radio: 'Radio', combobox: 'Dropdown', listbox: 'List',
    heading: 'Heading', img: 'Image', tab: 'Tab', menuitem: 'Menu Item', option: 'Option', cell: 'Cell', row: 'Row', listitem: 'Item', switch: 'Switch', slider: 'Slider', spinbutton: 'Field', dialog: 'Dialog',
};

/** The page name for an address: the last meaningful part of the path, or the host. */
export function pageNameFor(url: string): string {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter((p) => p && !/^\d+$/.test(p) && !/^[0-9a-f-]{16,}$/i.test(p)).map((p) => p.replace(/\.(html?|aspx?|jsp|php|do)$/i, ''));
        // Generic parts (index, web, default…) say nothing about the page: the last meaningful one names it.
        const GENERIC = /^(index|default|main|start|page|web|app|apps|ui|tmindex|welcome|pages|view|views)$/i;
        const named = [...parts].reverse().find((p) => !GENERIC.test(p) && pascal(p));
        const pick = named ?? parts[parts.length - 1];
        if (pick && pascal(pick)) {
            const n = pascal(pick);
            // viewSystemUsers → SystemUsers.
            const short = n.replace(/^(View|Show|Display|List)(?=[A-Z][a-z])/, '');
            return short.length >= 4 ? short : n;
        }
        const host = u.hostname.replace(/^www\./, '');
        return /^[\d.]+$|^localhost$/i.test(host) ? 'Home' : `${pascal(host.split('.')[0])}Home`;
    } catch { return 'Home'; }
}

/** Page changes the in-Studio recorder marked (// cs-page <address>): a new page object from the next action on. */
export function markedBreaks(script: string, actions: Action[]): Record<number, string> {
    const out: Record<number, string> = {};
    script.split('\n').forEach((l, i) => {
        const m = /^\s*\/\/ cs-page (\S+)/.exec(l);
        if (!m) return;
        const idx = actions.findIndex((a) => a.line > i + 1);
        if (idx > 0) out[idx] = pageNameFor(m[1]);
    });
    return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A typed date and its format (the format given, else read from the value): yyyy-MM-dd, dd/MM/yyyy
 * (MM/dd/yyyy when the first part cannot be a day… or the second cannot be a month), with / . or -,
 * d MMM yyyy, dd-MMM-yyyy, MMM d, yyyy. Null when it is not a date.
 */
export function dateOf(value: string, format?: string): { date: Date; format: string } | null {
    const v = value.trim();
    const mk = (y: number, m: number, d: number, f: string) => {
        if (y < 100) y += 2000;
        const date = new Date(y, m - 1, d, 12);
        return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? { date, format: f } : null;
    };
    const mon = (t: string) => MONTHS.findIndex((x) => x.toLowerCase().startsWith(t.toLowerCase()) && t.length >= 3) + 1;
    if (format) {
        // The tester's format: read the value with it.
        const parts: Record<string, number> = {};
        const re = new RegExp(`^${format.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d/g, (t) => `(?<${t[0] === 'y' ? 'y' : t[0] === 'd' ? 'd' : t.length >= 3 ? 'n' : 'm'}>${t.length >= 3 && t[0] === 'M' ? '[A-Za-z]+' : '\\d+'})`)}$`);
        const m = re.exec(v);
        if (!m?.groups) return null;
        parts.y = Number(m.groups.y); parts.d = Number(m.groups.d); parts.m = m.groups.n ? mon(m.groups.n) : Number(m.groups.m);
        return mk(parts.y, parts.m, parts.d, format);
    }
    let m: RegExpExecArray | null;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) return mk(+m[1], +m[2], +m[3], 'yyyy-MM-dd');
    if ((m = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(v))) {
        const a = +m[1], b = +m[3], sep = m[2], y = m[4].length === 2 ? 'yy' : 'yyyy';
        const dayFirst = a > 12 || b <= 12;
        const dd = (dayFirst ? m[1] : m[3]).length === 2 ? 'dd' : 'd', mm = (dayFirst ? m[3] : m[1]).length === 2 ? 'MM' : 'M';
        return dayFirst ? mk(+m[4], b, a, `${dd}${sep}${mm}${sep}${y}`) : mk(+m[4], a, b, `${mm}${sep}${dd}${sep}${y}`);
    }
    if ((m = /^(\d{1,2})([ -])([A-Za-z]{3,9})\2(\d{4})$/.exec(v)) && mon(m[3])) return mk(+m[4], mon(m[3]), +m[1], `${m[1].length === 2 ? 'dd' : 'd'}${m[2]}${m[3].length === 3 ? 'MMM' : 'MMMM'}${m[2]}yyyy`);
    if ((m = /^([A-Za-z]{3,9}) (\d{1,2}), (\d{4})$/.exec(v)) && mon(m[1])) return mk(+m[3], mon(m[1]), +m[2], `${m[1].length === 3 ? 'MMM' : 'MMMM'} d, yyyy`);
    return null;
}

/** The recorded date as "today", "today + 7 days" or "today - 2 days" (from the day of the recording). */
export function whenOf(date: Date, now = new Date()): string {
    const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
    const n = Math.round((day(date) - day(now)) / 86400000);
    return n === 0 ? 'today' : `today ${n > 0 ? '+' : '-'} ${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`;
}

/** The values remembered while recording (`const name = await ….textContent(); // = "value"`), by name. */
export function rememberedValues(script: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const l of script.split('\n')) {
        const m = /^\s*const ([A-Za-z_]\w*) = \(?await .*\.(?:textContent|innerText|inputValue)\(\)(?:\)\?\.match\(\/.*\/[a-z]*\)\?\.\[0\])?;\s*\/\/ = (".*")\s*$/.exec(l);
        if (m) { try { out[m[1]] = String(JSON.parse(m[2])); } catch { /* no value */ } }
    }
    return out;
}

/** A value the tester took from a test data source while recording (the line before the action). */
export interface DataBinding {
    /** The source's name in the feature ("customer"). */
    name: string;
    /** Its column. */
    column: string;
    /** run: read in every run (database); copy: its rows copied into the data file now; file: the file is the scenario's data. */
    mode: 'run' | 'copy' | 'file';
    /** The source as the Studio's data editor describes it. */
    source: Record<string, unknown>;
}

/** The `// cs-data {…}` marks of a recording, by the index of the action each comes before. */
export function dataBindings(script: string, actions: Action[]): Record<number, DataBinding> {
    const out: Record<number, DataBinding> = {};
    script.split('\n').forEach((l, i) => {
        const m = /^\s*\/\/ cs-data (\{.*\})\s*$/.exec(l);
        if (!m) return;
        let b: DataBinding;
        try { b = JSON.parse(m[1]) as DataBinding; } catch { return; }
        if (!b || typeof b.name !== 'string' || typeof b.column !== 'string' || !['run', 'copy', 'file'].includes(b.mode) || !b.source || typeof b.source !== 'object') return;
        const idx = actions.findIndex((a) => a.line > i + 1);
        if (idx >= 0) out[idx] = b;
    });
    return out;
}

const origin = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };

/** The configuration key an address belongs to and the rest of the address. */
export function addressFor(url: string, values: Record<string, string>): { key: string; path: string; newKey?: string } {
    const u = new URL(url);
    const rest = u.pathname + u.search + u.hash;
    if (values.BASE_URL && origin(values.BASE_URL) === u.origin) return { key: 'BASE_URL', path: rest };
    // Another address of the project on the same site (…_URL keys).
    const known = Object.entries(values).filter(([k, v]) => /_URL$/.test(k) && origin(v) === u.origin).sort((a, b) => a[1].length - b[1].length)[0];
    if (known) return { key: known[0], path: rest };
    if (!values.BASE_URL) return { key: 'BASE_URL', path: rest, newKey: 'BASE_URL' };
    const ip = /^[\d.]+$|^\[|^localhost$/i.test(u.hostname);
    const labels = ip ? [] : u.hostname.replace(/^www\./, '').split('.').filter((x) => !/^(com|org|net|io|co|gov|edu|local|internal|corp|[a-z]{2})$/i.test(x));
    let stem = snake(labels.slice(0, 2).join(' ')) || 'APP';
    if (!/^[A-Z]/.test(stem)) stem = `APP_${stem}`;
    let key = `${stem}_URL`;
    for (let i = 2; values[key] !== undefined && origin(values[key]) !== u.origin; i++) key = `${stem}_${i}_URL`;
    return { key, path: rest, newKey: key };
}

interface Page {
    name: string; title: string; className: string; id: string; file: string; existing?: ExistingPage;
    url?: string; elements: El[]; needs: Set<string>; field: string;
    /** A frame of a page (CSFramePage): the page that embeds it (@CSIframe), its frames as recorded (outermost first), its property there. */
    frame?: { host: Page; chain: string[]; prop: string; embedded: boolean };
    /** The frame pages this page embeds. */
    iframes: Page[];
}
/** via: the frame page property of the page the element is reached through (this.labPage.paymentFrame.cardNumber). */
interface El { prop: string; label: string; target: Target; kind: string; reused: boolean; key: string; base: string; via?: string }

/**
 * A recorded frame selector in the framework's frame form: { id }, { name }, { title } where the selector is what the
 * framework's CSFrameResolver makes of it, else { xpath } or { css }.
 */
export function frameSpec(sel: string): string {
    let m = /^#([A-Za-z][\w-]*)$/.exec(sel);
    if (m) return `{ id: ${tsString(m[1])} }`;
    m = /^iframe\[(name|title)="([^"\\]*)"\]$/.exec(sel);
    if (m) return `{ ${m[1]}: ${tsString(m[2])} }`;
    if (sel.startsWith('xpath=')) return `{ xpath: ${tsString(sel.slice(6))} }`;
    return `{ css: ${tsString(sel)} }`;
}
/** Words naming a frame from its selector (its name, id or title). */
const frameWords = (sel: string) => (/^#([\w-]+)$/.exec(sel)?.[1] ?? /\[(?:name|title)="([^"]*)"\]/.exec(sel)?.[1] ?? '').replace(/(frame|iframe)$/i, '').trim();
interface Def { text: string; method: string; params: string[]; body: string[]; page: Page; /** Other pages its body uses (a reusable step). */ pages?: Page[]; helper: boolean; upload: boolean; download?: boolean; testData?: boolean; memory?: boolean; number?: boolean; more?: string[] }

export function plan(ts: Ts, actions: Action[], ctx: ProjectContext, c: Choices): Plan {
    const warnings: string[] = [];
    const pkg = c.pkg ?? '@mdakhan.mak/cs-playwright-test-framework';
    // A name in any language is the title as written (only Latin words are split and recased).
    const recTitle = (/[^\x00-\x7f]/.test(c.name) ? '' : words(c.name).join(' ')) || c.name.replace(/[\r\n|#@]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Recorded';
    // A name without Latin letters (طلبات, 订单) keeps its own file: recording-<short hash of the name>.
    const slug = kebab(c.name) || `recording-${[...c.name].reduce((h, ch) => Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0, 2166136261).toString(36)}`;
    const takenIds = new Set(ctx.pages.map((p) => p.id));
    /** How steps reach an element: this.labPage.cardNumber, or through the frame page this.labPage.paymentFrame.cardNumber. */
    const refOf = (pg: Page, e: El) => `this.${pg.field}.${e.via ? `${e.via}.` : ''}${e.prop}`;
    const idOf = (e: El) => (e.via ? `${e.via}.${e.prop}` : e.prop);

    // 1. Pages: a name the project has is that page (extended); others are new.
    const pages: Page[] = [];
    const pageOfAction: Page[] = [];
    const pageFor = (name: string): Page => {
        const base = (pascal(name) || 'Page').replace(/Page$/, '') || 'Page';
        const className = `${base}Page`;
        const found = pages.find((p) => p.className === className);
        if (found) return found;
        const existing = ctx.pages.find((p) => p.className === className);
        let id = existing?.id ?? kebab(base);
        if (!existing) for (let i = 2; takenIds.has(id); i++) id = `${kebab(base)}-${i}`;
        takenIds.add(id);
        const p: Page = { name: base, title: words(base).join(' '), className, id, file: existing?.file ?? `${ctx.pagesFolder}/${className}.ts`, existing, elements: [], needs: new Set(), field: `${camel(base)}Page`, iframes: [] };
        pages.push(p);
        return p;
    };
    let current: Page | null = null;
    let onPage = 0;
    actions.forEach((a, i) => {
        const named = c.breaks?.[i]?.trim();
        if (!current || named || a.kind === 'goto') {
            const name = named || (a.kind === 'goto' && a.value ? pageNameFor(a.value) : 'Home');
            // A page started by hand and opened by the next action: one page.
            if (!(current && !named && a.kind === 'goto' && !onPage && current.url === undefined)) { current = pageFor(name); onPage = 0; }
        }
        if (a.kind === 'goto' && current.url === undefined) current.url = a.value;
        onPage++;
        pageOfAction.push(current);
    });

    // 2. Elements: the page's own (same locator) or new ones.
    const usedProps = (p: Page) => new Set([...(p.existing?.elements.map((e) => e.prop) ?? []), ...p.elements.map((e) => e.prop), ...(p.existing?.methods ?? []),
        ...(p.existing?.iframes?.map((x) => x.prop) ?? []), ...p.iframes.map((f) => f.frame!.prop),
        // In a frame page, not the frame's own name (this.labPage.outerFrame.outerFrame).
        ...(p.frame ? [p.frame.prop] : [])]);
    // 2a. Frames: the elements of a frame are on a page object of that frame (the framework's CSFramePage, its frames
    // outermost first), embedded in the page with @CSIframe; one the project has (the same frames) is used.
    const framePages: Page[] = [];
    const framePageFor = (host: Page, chain: string[]): Page => {
        const key = chain.join(' > ');
        const mine = host.iframes.find((f) => f.frame!.chain.join(' > ') === key);
        if (mine) return mine;
        const existing = ctx.pages.find((p) => p.frameChain?.join(' > ') === key);
        const named = frameWords(chain[chain.length - 1]);
        const base = `${host.className.replace(/Page$/, '')}${pascal(named) || 'Content'}Frame`;
        let className = existing?.className ?? `${base}Page`;
        const taken = (n: string) => ctx.pages.some((p) => p.className === n) || pages.some((p) => p.className === n) || framePages.some((p) => p.className === n);
        if (!existing) for (let i = 2; taken(className); i++) className = `${base}${i}Page`;
        const had = host.existing?.iframes?.find((x) => x.cls === className);
        let prop = had?.prop ?? `${camel(named) || 'content'}Frame`;
        if (!had) { const used = usedProps(host); const b = prop; for (let i = 2; used.has(prop); i++) prop = `${b}${i}`; }
        let id = existing?.id ?? kebab(className.replace(/Page$/, ''));
        if (!existing) { const b = id; for (let i = 2; takenIds.has(id); i++) id = `${b}-${i}`; }
        takenIds.add(id);
        const f: Page = { name: `${host.name} ${named || 'content'} frame`, title: `${words(named).join(' ') || 'Content'} frame of the ${host.title}`, className, id,
            file: existing?.file ?? `${ctx.pagesFolder}/${className}.ts`, existing, elements: [], needs: new Set(), field: host.field, frame: { host, chain, prop, embedded: !!had }, iframes: [] };
        host.iframes.push(f);
        framePages.push(f);
        return f;
    };
    const elementFor = (host: Page, t: Target, kind: Action['kind']): El => {
        const p = t.frames.length ? framePageFor(host, t.frames) : host;
        const key = `${p.className}|${t.frames.join(' > ')}|${t.selector}`;
        const mine = p.elements.find((e) => e.key === key);
        if (mine) return mine;
        const theirs = p.existing?.elements.find((e) => e.css === t.selector || (!!t.testId && e.testId === t.testId) || (!!e.id && t.selector === `#${e.id}`)
            // Or one of the framework locators confirmed while recording (the team's role / id / test id …).
            || (t.fw ?? []).some((x) => PRIMARY_KEYS.has(x.key) && (e as unknown as Record<string, string | undefined>)[x.key] === x.value));
        const nameText = (t.name ?? '').trim();
        const role = t.role ?? (kind === 'fill' ? 'textbox' : kind === 'select' ? 'combobox' : kind === 'check' || kind === 'uncheck' ? 'checkbox' : '');
        const suffix = ROLE_SUFFIX[role] ?? (kind === 'upload' ? 'Upload' : '');
        const coreWords = words(nameText).slice(0, 4);
        const derived = stepSafe([...coreWords, ...(suffix && !coreWords.map((w) => w.toLowerCase()).includes(suffix.toLowerCase()) ? [suffix.toLowerCase()] : [])].join(' ') || role || 'element');
        // An element the page has keeps the name its steps use: its description (without "(… page)"), else its property.
        const theirName = theirs ? (theirs.description?.replace(/\s*\([^)]*\bpage\)\s*$/i, '').trim() || words(theirs.prop).join(' ').toLowerCase()) : '';
        const label = stepSafe(c.labels?.[key] ?? (theirs ? theirName : derived)) || 'element';
        let prop = theirs?.prop ?? camel(label);
        if (!theirs) {
            if (!prop || /^\d/.test(prop)) prop = `el${pascal(label) || 'Element'}`;
            const used = usedProps(p);
            const base = prop;
            for (let i = 2; used.has(prop); i++) prop = `${base}${i}`;
        }
        const e: El = { prop, label, target: t, kind, reused: !!theirs, key, base: stepSafe(c.labels?.[key] ?? coreWords.join(' ')) || label, ...(p.frame ? { via: p.frame.prop } : {}) };
        p.elements.push(e);
        return e;
    };

    /**
     * An element's framework locators in the order they are written: the tester's choice first, then the project's
     * policy (preferred strategies, ids it ignores), then the framework linter's score.
     */
    const locatorsOf = (e: El): FwLocator[] => {
        const ranked = rankLocators(e.target.fw ?? [], c.policy);
        const chosen = c.locators?.[e.key];
        const i = chosen ? ranked.findIndex((x) => x.key === chosen.key && x.value === chosen.value && PRIMARY_KEYS.has(x.key)) : -1;
        return i > 0 ? [ranked[i], ...ranked.filter((_, n) => n !== i)] : ranked;
    };

    // 3. Values: data columns, fixed text or secrets.
    const columns: string[] = [];
    const row: Record<string, string> = {};
    const secrets: Array<{ name: string; value: string }> = [];
    const encrypt: Array<{ token: string; value: string }> = [];
    const typed: Array<{ value: string; column: string }> = [];
    const existingCols = c.data?.existing?.columns ?? [];
    const columnFor = (wanted: string) => {
        // A column of the data file the tester chose: its own name.
        if (existingCols.includes(wanted) && !columns.includes(wanted)) { columns.push(wanted); return wanted; }
        let col = camel(wanted) || 'value';
        if (['testCaseId', 'description', 'runFlag'].includes(col)) col = `${col}Value`;
        const base = col;
        for (let i = 2; columns.includes(col); i++) col = `${base}${i}`;
        columns.push(col);
        return col;
    };
    const secretValue = (value: string, label: string, page: Page) => {
        if (c.secretMode === 'studio') {
            let name = snake(`${page.name} ${label}`).slice(0, 60);
            const base = name;
            for (let i = 2; secrets.some((s) => s.name === name && s.value !== value); i++) name = `${base.slice(0, 56)}_${i}`;
            if (!secrets.some((s) => s.name === name)) secrets.push({ name, value });
            return `{env:${name}}`;
        }
        const token = `__CS_ENCRYPT_${encrypt.length + 1}__`;
        encrypt.push({ token, value });
        return token;
    };

    // 4. Steps: reuse a definition that already matches the line; write the others.
    const defs = new Map<string, Def>();
    const lines: string[] = [];
    const rows: PlanRow[] = [];
    let stepsReused = 0;
    const kwState: { k?: string } = {};
    const kw = (k: 'Given' | 'When' | 'Then') => { const out = kwState.k === k ? 'And' : k; kwState.k = k; return out; };
    const existingMatch = (concrete: string) => ctx.steps.some((s) => s.regex.test(concrete));
    /** Page-object steps as written (for reusable steps): the line, its definition's text, parameters, body and arguments. */
    const members: Array<{ idx: number; line: number; key: string; text: string; params: string[]; body: string[]; page: Page; args: string[]; flags: Partial<Def> }> = [];
    const keyUses = new Map<string, number>();
    let first = true;
    const fetchedTyped: Array<{ value: string; f: { name: string; column: string } }> = [];
    let dialogCheck: { page: Page; message: string; after: number } | null = null;
    /** Test data read by a check (where it is in the scenario), not at the start. */
    const checkReads: string[] = [];
    const browserSteps = new Set<string>();
    const rememberedNow: Array<{ name: string; value: string }> = [];
    const reads: string[] = [];

    // The sign-in block (steps 0..marker): one step, its values in the environment's configuration.
    const siMarker = c.signIn?.marker;
    const si = siMarker !== undefined && actions[0]?.kind === 'goto' && ['expectVisible', 'expectText', 'expectContains'].includes(actions[siMarker]?.kind) && !!actions[siMarker].target ? siMarker : undefined;
    if (c.signIn && si === undefined) warnings.push('The sign-in needs the recording to start by opening the application and a check of an element that shows the user is signed in.');
    const signIn = { open: '', body: [] as string[], pages: new Set<Page>(), keys: [] as Array<{ key: string; value: string; secret: boolean; label: string; page: Page }>, first: '', marker: '' };
    const signInKey = (e: El) => {
        const base = `SIGNIN_${snake(e.base || e.label).toUpperCase()}`.slice(0, 50);
        let key = base;
        for (let n = 2; signIn.keys.some((x) => x.key === key); n++) key = `${base}_${n}`;
        return key;
    };

    actions.forEach((a, i) => {
        if (si !== undefined && i <= si) {
            const pg = pageOfAction[i];
            signIn.pages.add(pg);
            const ex = (e: El) => refOf(pg, e);
            if (a.kind === 'goto') { pg.needs.add('open'); (i === 0 ? (v: string) => { signIn.open = v; } : (v: string) => signIn.body.push(v))(`await this.${pg.field}.open();`); }
            else if (i === si) signIn.marker = ex(elementFor(pg, a.target!, a.kind));
            else if (a.target) {
                const e = elementFor(pg, a.target, a.kind);
                if (!signIn.first && ['fill', 'select', 'click', 'check', 'press'].includes(a.kind)) signIn.first = ex(e);
                if (a.kind === 'fill' || a.kind === 'select') {
                    const key = signInKey(e);
                    const v = a.kind === 'fill' ? a.value ?? '' : (a.values ?? []).join(' | ');
                    signIn.keys.push({ key, value: v, secret: SENSITIVE.test(`${e.label} ${e.target.selector}`), label: e.label, page: pg });
                    signIn.body.push(a.kind === 'fill' ? `await ${ex(e)}.fill(setting(${tsString(key)}));` : `await ${ex(e)}.selectOption(setting(${tsString(key)}).split(' | '));`);
                } else if (['click', 'dblclick', 'check', 'uncheck', 'hover'].includes(a.kind)) signIn.body.push(`await ${ex(e)}.${a.kind}();`);
                else if (a.kind === 'press') signIn.body.push(`await ${ex(e)}.press(${tsString(a.value ?? '')});`);
                else if (a.kind === 'expectVisible') signIn.body.push(`await ${ex(e)}.waitForVisible(30000);`);
                else if (a.kind === 'upload') warnings.push('An upload in the sign-in steps is not repeated by the sign-in step.');
            }
            if (i === si) {
                const kword = kw('Given');
                const line = 'the user is signed in';
                const reused = existingMatch(line);
                if (reused) stepsReused++;
                lines.push(`${kword} ${line}`);
                first = false;
                rows.push({ index: i, kind: a.kind, page: pg.name, pageExisting: !!pg.existing, line: `${kword} ${line}`, stepReused: reused, signIn: true });
            }
            return;
        }
        let testDataDef = false, memoryDef = false, uniqueRow = false;
        let dateRow: { when: string; format: string } | undefined;
        let arg2 = '';
        let numberDef = false, tableDef = false;
        let fxRef: string | undefined, rememberedRef: string | undefined;
        const page = pageOfAction[i];
        const on = `on the ${page.title} page`;
        const choice = { ...(c.values?.[i] ?? {}) };
        let text = '', params: string[] = [], body: string[] = [], method = '', key = '', helper = false, upload = false, download = false, el: El | undefined;
        let value: string | undefined, sensitive = false, mode: ValueMode | undefined;
        let k: 'Given' | 'When' | 'Then' = first ? 'Given' : 'When';
        const elx = (e: El) => refOf(page, e);
        switch (a.kind) {
            case 'dialog': {
                // The answer to the dialog the next action opens (the framework's page dialog handlers).
                const act = a.attribute === 'dismiss' ? 'dismiss' : 'accept';
                const prompt = act === 'accept' ? a.values?.[0] : undefined;
                text = act === 'dismiss' ? `the user answers the next dialog with Cancel ${on}` : prompt !== undefined ? `the user answers the next dialog with {string} ${on}` : `the user answers the next dialog with OK ${on}`;
                params = prompt !== undefined ? ['answer: string'] : [];
                body = [`this.${page.field}.clearLastDialog();`, act === 'dismiss' ? `await this.${page.field}.dismissNextDialog();` : prompt !== undefined ? `await this.${page.field}.acceptNextDialogWithText(answer);` : `await this.${page.field}.acceptNextDialog();`];
                if (prompt !== undefined) value = prompt;
                method = `answer dialog ${page.name} ${act}${prompt !== undefined ? ' text' : ''}`; key = `dialog|${page.id}|${act}|${prompt !== undefined}`;
                dialogCheck = { page, message: a.value ?? '', after: i + 1 };
                break;
            }
            case 'dataCheck': {
                // A value of the application's data (a database row, an API answer) read now, after the steps before.
                const f = c.fetched?.[i];
                const name = f?.name ?? a.values?.[0] ?? 'data';
                if (!f) warnings.push(`Step ${i + 1}: the test data "${name}" has no source: the check is kept, add its source in ${ctx.dataFolder}/test-data-sources.json.`);
                if (f && !checkReads.includes(name)) checkReads.push(name);
                const t = `the test data ${quoted(name)} should have ${quoted(a.attribute ?? '')} equal to ${quoted(a.value ?? '')}`;
                const reused = existingMatch(t);
                if (reused) stepsReused++;
                const kword = kw('Then');
                lines.push(`${kword} ${t}`);
                first = false;
                rows.push({ index: i, kind: a.kind, page: page.name, pageExisting: !!page.existing, line: `${kword} ${t}`, stepReused: reused, value: a.value });
                return;
            }
            case 'pressKey': case 'closeTab': {
                // A key of the page (not of a field), closing the tab: shared steps.
                const t = a.kind === 'closeTab' ? 'the user closes the tab' : `the user presses ${quoted(a.value ?? '')}`;
                browserSteps.add(a.kind === 'closeTab' ? 'the user closes the tab' : 'the user presses {string}');
                const reused = existingMatch(t);
                if (reused) stepsReused++;
                const kword = kw('When');
                lines.push(`${kword} ${t}`);
                first = false;
                rows.push({ index: i, kind: a.kind, page: page.name, pageExisting: !!page.existing, line: `${kword} ${t}`, stepReused: reused, value: a.value });
                return;
            }
            case 'switchTab': {
                // Another tab (a link that opens one): the steps after act in it.
                const isNew = a.value === 'new';
                const t = isNew ? 'the user switches to the new tab' : `the user switches to tab ${Number(a.value) + 1}`;
                const shared = isNew ? 'the user switches to the new tab' : 'the user switches to tab {int}';
                browserSteps.add(shared);
                const reused = existingMatch(t);
                if (reused) stepsReused++;
                const kword = kw('When');
                lines.push(`${kword} ${t}`);
                first = false;
                rows.push({ index: i, kind: a.kind, page: page.name, pageExisting: !!page.existing, line: `${kword} ${t}`, stepReused: reused });
                return;
            }
            case 'goto':
                page.needs.add('open');
                text = `the user opens the ${page.title} page`; body = [`await this.${page.field}.open();`]; method = `open ${page.name}`; key = `open|${page.id}`;
                break;
            case 'expectUrl': case 'expectTitle': {
                const what = a.kind === 'expectUrl' ? 'address' : 'title';
                page.needs.add(a.kind === 'expectUrl' ? 'currentUrl' : 'currentTitle');
                text = `the ${page.title} page ${what} should match {string}`; params = ['expected: string']; helper = true;
                body = [`await eventually(() => this.${page.field}.${a.kind === 'expectUrl' ? 'currentUrl' : 'currentTitle'}(), expected, 'equals', 'The page ${what}');`];
                method = `check ${page.name} ${what}`; key = `${a.kind}|${page.id}`; k = 'Then';
                value = a.regex ? `/${a.value}/` : a.value ?? '';
                break;
            }
            case 'expectDownload':
                // The framework saves what the browser downloads; the check waits for a file by name or /pattern/.
                text = 'the file {string} should be downloaded'; params = ['expected: string']; download = true;
                body = ['await downloaded(expected);'];
                method = 'check download'; key = 'download'; k = 'Then';
                value = a.regex ? `/${a.value}/` : a.value ?? '';
                break;
            default: {
                el = elementFor(page, a.target!, a.kind);
                const e = el;
                switch (a.kind) {
                    case 'click': case 'dblclick': case 'hover': case 'check': case 'uncheck': {
                        const verb = { click: 'clicks', dblclick: 'double-clicks', hover: 'points at', check: 'checks', uncheck: 'unchecks' }[a.kind];
                        text = `the user ${verb} ${e.label} ${on}`; body = [`await ${elx(e)}.${a.kind}();`];
                        // Only when it is shown (a dialog that appears now and then): waits a little, else goes on.
                        if (c.optional?.[i] && a.kind !== 'hover') {
                            text = `the user ${verb} ${e.label} if it is shown ${on}`;
                            body = [`if (await ${elx(e)}.waitForVisible(5000).then(() => true, () => false)) await ${elx(e)}.${a.kind}();`];
                            key = '|optional';
                        }
                        break;
                    }
                    case 'expectColumn': {
                        // Every row of a table column: the same text, containing a text, or sorted.
                        k = 'Then'; helper = true;
                        const m = a.attribute ?? 'equals';
                        const lbl = e.label;
                        text = m === 'equals' ? `every ${lbl} should be {string} ${on}` : m === 'contains' ? `every ${lbl} should contain {string} ${on}` : `the ${lbl} should be sorted ${m === 'asc' ? 'ascending' : 'descending'} ${on}`;
                        params = m === 'equals' || m === 'contains' ? ['expected: string'] : [];
                        body = [`await checkColumn(() => ${elx(e)}.allTextContents(), '${m}', ${params.length ? 'expected' : "''"}, ${tsString(`The ${lbl}`)});`];
                        if (params.length) { value = a.value ?? ''; mode = 'fixed'; }
                        key = `|${m}`; tableDef = true;
                        break;
                    }
                    case 'waitFor': {
                        // Wait until the element shows a text (is shown, is gone), refreshing the page while waiting.
                        const m = a.attribute ?? 'contains';
                        const w = a.wait ?? { reload: false, seconds: 60 };
                        const how = `${w.reload ? ', refreshing the page,' : ''} for up to ${w.seconds} seconds`;
                        text = m === 'contains' ? `the user waits until ${e.label} shows {string}${how} ${on}` : `the user waits until ${e.label} is ${m === 'visible' ? 'shown' : 'gone'}${how} ${on}`;
                        params = m === 'contains' ? ['expected: string'] : [];
                        const read = m === 'contains' ? `async () => (await ${elx(e)}.textContent()) ?? ''` : `async () => String(await ${elx(e)}.isVisible())`;
                        body = [`await waitUntil(${read}, ${m === 'contains' ? "'contains', expected" : `'equals', '${m === 'visible' ? 'true' : 'false'}'`}, { reload: ${w.reload}, seconds: ${w.seconds} }, ${tsString(`${e.label}`)});`];
                        if (params.length) { value = a.value ?? ''; mode = 'fixed'; }
                        key = `|${m}|${w.reload ? 'r' : ''}${w.seconds}`; tableDef = true;
                        break;
                    }
                    case 'expectNumber': {
                        // A number shown, compared with a number or a remembered value (± an amount).
                        k = 'Then'; helper = true;
                        const op = a.attribute ?? 'eq';
                        const words = ({ eq: 'equal to', ne: 'different from', gt: 'greater than', ge: 'at least', lt: 'less than', le: 'at most' } as Record<string, string>)[op] ?? 'equal to';
                        const mv = /^@(\w+)([+-])(\d+(?:\.\d+)?)$/.exec(a.value ?? '');
                        const read = `() => ${elx(e)}.${'textContent'}()`;
                        if (mv) {
                            const off = Number(mv[3]) * (mv[2] === '-' ? -1 : 1);
                            text = off ? `${e.label} should be ${words} the remembered {string} plus {int} ${on}` : `${e.label} should be ${words} the remembered {string} ${on}`;
                            params = off ? ['name: string', 'plus: number'] : ['name: string'];
                            body = [`await eventuallyNumber(${read}, '${op}', Number(remembered(name)) + ${off ? 'plus' : '0'}, ${tsString(`The number of ${e.label}`)});`];
                            memoryDef = true; mode = 'fixed'; value = mv[1]; if (off) arg2 = String(off);
                            key = `|remembered${off ? '|plus' : ''}`;
                        } else {
                            text = `${e.label} should be ${words} {string} ${on}`; params = ['expected: string'];
                            body = [`await eventuallyNumber(${read}, '${op}', Number(expected), ${tsString(`The number of ${e.label}`)});`];
                            value = a.value ?? '0'; mode = 'fixed';
                        }
                        key = `|${op}${key}`;
                        numberDef = true;
                        break;
                    }
                    case 'rightclick':
                        text = `the user right-clicks ${e.label} ${on}`; body = [`await ${elx(e)}.rightClick();`];
                        break;
                    case 'drag': {
                        if (a.target2) {
                            // Drag and drop onto another element.
                            const e2 = elementFor(page, a.target2, 'click');
                            text = `the user drags ${e.label} onto ${e2.label} ${on}`; body = [`await ${elx(e)}.dragTo(${elx(e2)});`];
                            key = `|${idOf(e2)}`;
                        } else {
                            // Within the element (a slider): to a place given as shares of its size.
                            text = `the user drags ${e.label} to {string} ${on}`; params = ['where: string'];
                            body = ["const [across, down] = (where.match(/\\d+(\\.\\d+)?/g) ?? ['50', '50']).map(Number);", `const box = await ${elx(e)}.boundingBox();`, `if (!box) throw new Error('${e.label.replace(/'/g, '')} is not shown.');`, `await ${elx(e)}.dragToWithTargetPosition(box.width * across / 100, box.height * (down ?? 50) / 100, ${elx(e)});`];
                            value = `${Math.round((a.at?.x ?? 0.5) * 100)}% across, ${Math.round((a.at?.y ?? 0.5) * 100)}% down`; mode = 'fixed';
                            key = '|at';
                        }
                        break;
                    }
                    case 'remember': {
                        // A value of the page kept for later steps (an order number, a total).
                        const what = a.attribute === 'value' ? 'value' : 'text';
                        const read = `((await ${elx(e)}.${what === 'value' ? 'inputValue' : 'textContent'}()) ?? '').trim()`;
                        if (a.pattern) {
                            // Only the part that matches ("SO-1005" of "Order SO-1005 created").
                            text = `the user remembers the part of ${e.label} like {string} as {string} ${on}`; params = ['pattern: string', 'name: string'];
                            body = [`const found = new RegExp(pattern).exec(${read});`, `if (!found) throw new Error(\`Nothing like \${pattern} in ${e.label.replace(/[`\\$]/g, '')}.\`);`, 'remember(name, found[0]);'];
                            key = '|part'; arg2 = quoted(a.value ?? 'value'); value = a.pattern;
                        } else {
                            text = `the user remembers the ${what} of ${e.label} as {string} ${on}`; params = ['name: string'];
                            body = [`remember(name, ${read});`];
                            value = a.value ?? 'value';
                        }
                        memoryDef = true; mode = 'fixed';
                        const rname = a.value ?? 'value';
                        if (c.remembered?.[rname] !== undefined) rememberedNow.push({ name: rname, value: c.remembered[rname] });
                        break;
                    }
                    case 'fill': text = `the user enters {string} in ${e.label} ${on}`; params = ['value: string']; body = [`await ${elx(e)}.fill(value);`]; value = a.value ?? ''; break;
                    case 'press': text = `the user presses {string} in ${e.label} ${on}`; params = ['key: string']; body = [`await ${elx(e)}.press(key);`]; value = a.value ?? ''; break;
                    case 'select': text = `the user selects {string} in ${e.label} ${on}`; params = ['option: string']; body = [`// Several options are written as a | b.`, `await ${elx(e)}.selectOption(option.split(' | '));`]; value = (a.values ?? []).join(' | '); break;
                    case 'upload':
                        upload = true;
                        text = `the user uploads {string} to ${e.label} ${on}`; params = ['fileName: string'];
                        body = [`await ${elx(e)}.setInputFiles(uploadFiles(fileName));`];
                        value = (a.values ?? []).map((v) => v.split(/[\\/]/).pop() ?? v).join(' | ');
                        break;
                    case 'expectVisible': case 'expectHidden':
                        text = `${e.label} should be ${a.kind === 'expectVisible' ? 'visible' : 'hidden'} ${on}`; k = 'Then';
                        body = [`await ${elx(e)}.${a.kind === 'expectVisible' ? 'waitForVisible' : 'waitForHidden'}(10000);`];
                        break;
                    case 'expectEnabled': case 'expectDisabled': {
                        const st = a.kind === 'expectEnabled' ? 'enabled' : 'disabled';
                        k = 'Then'; helper = true;
                        text = `${e.label} should be ${st} ${on}`;
                        body = [`await eventually(() => ${elx(e)}.${a.kind === 'expectEnabled' ? 'isEnabled' : 'isDisabled'}().then(String), 'true', 'equals', ${tsString(`${e.label} ${st}`)});`];
                        break;
                    }
                    case 'expectAttribute': {
                        k = 'Then'; helper = true;
                        text = `${e.label} ${stepSafe(a.attribute ?? 'attribute')} attribute should be {string} ${on}`; params = ['expected: string'];
                        body = [`await eventually(() => ${elx(e)}.getAttribute(${tsString(a.attribute ?? '')}), expected, 'equals', ${tsString(`The ${a.attribute} attribute of ${e.label}`)});`];
                        value = a.regex ? `/${a.value}/` : a.value ?? '';
                        break;
                    }
                    case 'expectCount':
                        k = 'Then'; helper = true;
                        text = `there should be {string} ${/(row|item|element)$/.test(e.label) ? `${e.label}s` : `${e.label} items`} ${on}`; params = ['expected: string'];
                        body = [`await eventually(() => ${elx(e)}.count().then(String), expected, 'equals', ${tsString(`The number of ${e.label}`)});`];
                        value = a.value ?? '';
                        break;
                    case 'expectText': case 'expectContains': case 'expectValue': case 'expectChecked': {
                        k = 'Then'; helper = true;
                        const spec = {
                            expectText: { t: `${e.label} should show {string} ${on}`, read: `${elx(e)}.textContent()`, m: 'equals', what: `The text of ${e.label}` },
                            expectContains: { t: `${e.label} should contain {string} ${on}`, read: `${elx(e)}.textContent()`, m: 'contains', what: `The text of ${e.label}` },
                            expectValue: { t: `${e.label} should have the value {string} ${on}`, read: `${elx(e)}.inputValue()`, m: 'equals', what: `The value of ${e.label}` },
                            expectChecked: { t: `${e.label} should be checked ${on}`, read: `${elx(e)}.isChecked().then(String)`, m: 'equals', what: `${e.label} checked` },
                        }[a.kind];
                        text = spec.t; params = a.kind === 'expectChecked' ? [] : ['expected: string'];
                        body = [`await eventually(() => ${spec.read}, ${a.kind === 'expectChecked' ? "'true'" : 'expected'}, '${spec.m}', ${tsString(spec.what)});`];
                        if (a.kind !== 'expectChecked') value = a.regex ? `/${a.value}/` : a.value ?? '';
                        break;
                    }
                }
                method = `${a.kind === 'fill' ? 'enter' : a.kind.replace(/^expect/, 'check ')} ${page.name} ${e.via ? `${e.via} ` : ''}${e.prop}${a.attribute ? ` ${a.attribute}` : ''}${key === '|optional' ? ' if shown' : ''}`; key = `${a.kind}|${page.id}|${idOf(e)}${a.attribute ? `|${a.attribute}` : ''}${key}`;
            }
        }
        let arg = '';
        // A value remembered earlier (the same text; a check that contains it): the step uses the remembered one.
        const rmb = value !== undefined && el && choice.mode !== 'fixed' && ['fill', 'select', 'expectText', 'expectContains', 'expectValue'].includes(a.kind)
            ? [...rememberedNow].reverse().find((r) => r.value !== '' && (r.value === value || (a.kind === 'expectContains' && r.value.length > 1 && value!.includes(r.value)))) : undefined;
        if (rmb && el) {
            const ex = refOf(page, el);
            text = a.kind === 'expectValue' ? text.replace('the value {string}', 'the remembered value {string}') : text.replace('{string}', 'the remembered {string}');
            params = ['name: string']; helper = a.kind.startsWith('expect'); memoryDef = true;
            body = a.kind === 'fill' ? [`await ${ex}.fill(remembered(name));`] : a.kind === 'select' ? [`await ${ex}.selectOption(remembered(name));`] : ['const expected = remembered(name);', ...body];
            key += '|remembered'; method += ' remembered';
            mode = 'fixed'; value = rmb.name; sensitive = false; rememberedRef = rmb.name; arg = quoted(rmb.name);
        }
        // A date relative to the day of the run ("today + 7 days"), in the application's format; remembered.
        if (!rmb && !arg && a.kind === 'fill' && el && choice.mode === 'date' && value !== undefined) {
            const d = dateOf(value, choice.format);
            if (!d) warnings.push(`Step ${i + 1}: "${value}" is not a date the Studio reads (formats like dd/MM/yyyy, MM/dd/yyyy, yyyy-MM-dd, d MMM yyyy): it is written as recorded.`);
            else {
                const ex = refOf(page, el);
                let name = camel(el.base || el.label) || 'date';
                for (let n = 2; rememberedNow.some((r) => r.name === name); n++) name = `${camel(el.base || el.label) || 'date'}${n}`;
                const when = choice.when?.trim() || whenOf(d.date);
                text = text.replace('{string}', `the date {string}`).replace(/ in (.*) on the /, ` in $1 as ${d.format} on the `); params = ['when: string']; memoryDef = true;
                body = [`const value = dateFrom(when, ${tsString(d.format)});`, `await ${ex}.fill(value);`, `remember(${tsString(name)}, value);`];
                key += `|date|${d.format}`; method += ' date';
                rememberedNow.push({ name, value });
                mode = 'fixed'; dateRow = { when, format: d.format }; arg = quoted(when);
            }
        }
        // A unique value in each run (made from the recorded one), remembered for the later steps.
        if (!rmb && a.kind === 'fill' && el && choice.mode === 'unique' && value !== undefined) {
            const ex = refOf(page, el);
            let name = camel(el.base || el.label) || 'value';
            for (let n = 2; rememberedNow.some((r) => r.name === name); n++) name = `${camel(el.base || el.label) || 'value'}${n}`;
            text = text.replace('{string}', 'a unique value like {string}'); params = ['pattern: string']; memoryDef = true;
            body = ['const value = unique(pattern);', `await ${ex}.fill(value);`, `remember(${tsString(name)}, value);`];
            key += '|unique'; method += ' unique';
            rememberedNow.push({ name, value });
            mode = 'fixed'; uniqueRow = true; arg = quoted(value);
        }
        // A value read from a database in every run: the step takes the test data reference (name.column).
        const fx = c.fetched?.[i] ?? (a.kind.startsWith('expect') && value !== undefined ? fetchedTyped.find((t) => t.value === value)?.f : undefined);
        if (!arg && fx && el && value !== undefined && ['fill', 'select', 'expectText', 'expectContains', 'expectValue'].includes(a.kind)) {
            const ref = `${fx.name}.${fx.column}`;
            fxRef = ref;
            const ex = refOf(page, el);
            text = a.kind === 'expectValue' ? text.replace('the value {string}', 'the value of test data {string}') : text.replace('{string}', 'test data {string}');
            params = ['ref: string']; helper = a.kind.startsWith('expect'); testDataDef = true;
            body = a.kind === 'fill' ? [`await ${ex}.fill(testData(ref));`] : a.kind === 'select' ? [`await ${ex}.selectOption(testData(ref));`] : ['const expected = testData(ref);', ...body];
            key += '|testdata'; method += ' test data';
            mode = 'fixed'; arg = quoted(ref); sensitive = false;
            if (a.kind === 'fill' || a.kind === 'select') fetchedTyped.push({ value, f: fx });
            if (!reads.includes(fx.name)) reads.push(fx.name);
            choice.column = undefined;
        }
        // The value: in the data file, fixed, or a secret.
        if (!arg && value !== undefined && text.includes('{string}')) {
            sensitive = !!el && SENSITIVE.test(`${el.label} ${el.target.selector}`) && (a.kind === 'fill' || a.kind === 'expectValue');
            // The same text as a typed value (any length), or text that contains one ("Welcome, alice").
            const dependsOn = typed.find((t) => value!.length > 0 && (t.value === value || (t.value.length > 1 && value!.includes(t.value))));
            const deflt: ValueMode = sensitive ? 'secret' : a.kind === 'fill' || a.kind === 'select' || a.kind === 'dialog' ? 'data' : (a.kind.startsWith('expect') && a.kind !== 'expectUrl' && dependsOn) ? 'data' : 'fixed';
            mode = choice.mode ?? deflt;
            if (mode === 'fixed') arg = quoted(value);
            else {
                // A check of a typed value (or secret) uses the same column.
                const same = a.kind.startsWith('expect') ? typed.find((t) => t.value === value) : undefined;
                const col = same?.column ?? columnFor(choice.column || (a.kind.startsWith('expect') ? `expected ${el?.base ?? 'value'}` : el?.base ?? (a.kind === 'dialog' ? 'dialog answer' : 'value')));
                if (!same) row[col] = mode === 'secret' ? secretValue(value, el?.label ?? col, page) : value;
                if (a.kind === 'fill' || a.kind === 'select' || a.kind === 'dialog') typed.push({ value, column: col });
                arg = `"<${col}>"`;
                choice.column = col;
            }
        }
        let line = arg ? text.replace('{string}', arg) : text;
        if (arg2) line = line.replace(/\{string\}|\{int\}/, (t) => (t === '{int}' ? arg2.replace(/^"|"$/g, '') : arg2));
        const concrete = (text.includes('{string}') ? text.replace('{string}', quoted(mode === 'fixed' ? (value ?? '') : 'x')) : text).split('{string}').join('"x"').split('{int}').join('1');
        const reused = !defs.has(key) && existingMatch(concrete);
        if (reused) stepsReused++;
        else if (!defs.has(key)) {
            const used = new Set([...defs.values()].map((d) => d.method));
            let m = camel(method) || 'step';
            const base = m;
            for (let n = 2; used.has(m); n++) m = `${base}${n}`;
            defs.set(key, { text, method: m, params, body, page, helper, upload, download, testData: testDataDef, memory: memoryDef, number: numberDef || tableDef, more: [...new Set(body.flatMap((b) => ['checkColumn', 'waitUntil'].filter((n) => b.includes(`${n}(`))))] });
        }
        const kword = kw(k);
        lines.push(`${kword} ${line}`);
        members.push({ idx: i, line: lines.length - 1, key, text, params, body, page, args: [arg, arg2].filter(Boolean),
            flags: { helper, upload, download, testData: testDataDef, memory: memoryDef, number: numberDef || tableDef } });
        keyUses.set(key, (keyUses.get(key) ?? 0) + 1);
        first = false;
        // The dialog the action opened: its message is checked right after it.
        if (dialogCheck && i === dialogCheck.after) {
            const dp = dialogCheck.page;
            const dText = `the dialog should have said {string} on the ${dp.title} page`;
            const dKey = `dialogcheck|${dp.id}`;
            const dLine = dText.replace('{string}', quoted(dialogCheck.message));
            const dReused = !defs.has(dKey) && existingMatch(dLine);
            if (dReused) stepsReused++;
            else if (!defs.has(dKey)) {
                const used = new Set([...defs.values()].map((d) => d.method));
                let m = camel(`check dialog ${dp.name}`); const b0 = m; for (let n = 2; used.has(m); n++) m = `${b0}${n}`;
                defs.set(dKey, { text: dText, method: m, params: ['expected: string'], body: [`await eventually(async () => this.${dp.field}.getLastDialogMessage() ?? '', expected, 'contains', 'The dialog message');`], page: dp, helper: true, upload: false });
            }
            lines.push(`${kw('Then')} ${dLine}`);
            members.push({ idx: i, line: lines.length - 1, key: dKey, text: dText, params: ['expected: string'], body: [`await eventually(async () => this.${dp.field}.getLastDialogMessage() ?? '', expected, 'contains', 'The dialog message');`], page: dp, args: [quoted(dialogCheck.message)], flags: { helper: true, upload: false } });
            keyUses.set(dKey, (keyUses.get(dKey) ?? 0) + 1);
            dialogCheck = null;
        }
        rows.push({ index: i, kind: a.kind, page: page.name, pageExisting: !!page.existing, element: el?.label, elementKey: el?.key, elementReused: el?.reused,
            ...(el && !el.reused && el.target.fw?.length ? (() => { const l = locatorsOf(el); const first = l.find((x) => PRIMARY_KEYS.has(x.key)); return { locators: l, ...(first ? { locator: { key: first.key, value: first.value } } : {}) }; })() : {}),
            line: `${kword} ${line}`, stepReused: reused, value: sensitive ? '••••' : fxRef ?? value, mode: fxRef || rememberedRef || a.kind === 'remember' ? undefined : uniqueRow ? 'unique' : dateRow ? 'date' : mode, ...(dateRow ? { date: dateRow } : a.kind === 'fill' && value !== undefined && dateOf(value) ? { dateLike: true } : {}), ...(rememberedRef ? { remembered: rememberedRef } : {}), column: mode && mode !== 'fixed' ? choice.column : undefined, sensitive, ...(fxRef ? { testData: fxRef } : {}) });
    });

    // 4b. Reusable steps: the lines of a range of actions as one step, its definition made of theirs (each in its
    // own scope, its parameters bound to the reusable step's). The framework has no step that runs other steps
    // by their text, so the reusable step calls the page objects itself.
    const lineBlock: Array<string | undefined> = lines.map(() => undefined);
    for (const b of [...(c.blocks ?? [])].sort((x, y) => x.from - y.from)) {
        const name = b.name?.trim();
        const inRange = (i: number | undefined) => i !== undefined && i >= b.from && i <= b.to;
        const mine = members.filter((m) => inRange(m.idx));
        const lineIdx = rows.filter((r) => inRange(r.index)).length ? [...new Set(mine.map((m) => m.line))] : [];
        const firstLine = Math.min(...lineIdx), lastLine = Math.max(...lineIdx);
        if (!name || b.from > b.to || !mine.length) { warnings.push(`Reusable step "${name ?? ''}": choose a name and at least one step.`); continue; }
        // Only page-object steps: tab switches, page keys, data checks and the sign-in are steps of their own files.
        const others = rows.filter((r) => inRange(r.index) && !members.some((m) => m.idx === r.index));
        if (others.length || lastLine - firstLine + 1 !== lineIdx.length || lineIdx.some((l) => lineBlock[l] !== undefined)) {
            warnings.push(`Reusable step "${name}": steps ${b.from + 1}–${b.to + 1} include a step that cannot be part of it (a tab, a key of the page, a check of the test data, the sign-in) or another reusable step; it was not made.`);
            continue;
        }
        // Its parameters: every value of its steps, in order (a data column keeps its name).
        const params: string[] = [], args: string[] = [], scopes: string[] = [];
        const taken = new Set<string>();
        const paramName = (wanted: string) => { let n = camel(wanted) || 'value'; const b0 = n; for (let k = 2; taken.has(n); k++) n = `${b0}${k}`; taken.add(n); return n; };
        for (const m of mine) {
            const binds: string[] = [];
            m.params.forEach((p, k) => {
                const [own, type] = p.split(':').map((x) => x.trim());
                const a = m.args[k] ?? '""';
                const col = /^"<([^>]+)>"$/.exec(a)?.[1];
                const n = paramName(col ?? own);
                params.push(`${n}: ${type || 'string'}`);
                args.push(a);
                // The same name: the body uses the parameter itself (const x = x would not run).
                if (own !== n) binds.push(`const ${own} = ${n};`);
            });
            scopes.push(`// ${m.text.replace(/\{string\}|\{int\}/g, '…')}`, '{', ...binds.map((x) => `    ${x}`), ...m.body.map((x) => `    ${x}`), '}');
        }
        const holders = params.map((p) => (/:\s*number$/.test(p) ? '{int}' : '{string}'));
        let text = (b.text ?? '').trim();
        const count = (t: string) => (t.match(/\{string\}|\{int\}/g) ?? []).length;
        if (!text || count(text) !== params.length) {
            if (text) warnings.push(`Reusable step "${name}": its text needs ${params.length} value placeholder(s) ({string}); the Studio's text is used.`);
            text = params.length ? `${name} with ${holders.join(' and ')}` : name;
        }
        // The words around its placeholders as in other steps' texts (no quotes or line breaks).
        text = text.split(/(\{string\}|\{int\})/).map((part, k) => (k % 2 ? part : part.replace(/["'`\r\n]+/g, ' '))).join('').replace(/\s+/g, ' ').trim();
        let at = 0;
        const line = text.replace(/\{string\}|\{int\}/g, (h) => { const a = args[at++] ?? '""'; return h === '{int}' ? a.replace(/^"|"$/g, '') : a; });
        // The keyword of its first line (And continues the one before).
        let kType = '';
        for (let l = firstLine; l >= 0 && !kType; l--) { const w = /^(Given|When|Then)\b/.exec(lines[l]); if (w) kType = w[1]; }
        const concrete = line.replace(/"<[^>]+>"/g, '"x"');
        const reused = existingMatch(concrete) || [...defs.values()].some((d) => d.text === text);
        if (reused) stepsReused++;
        else {
            const used = new Set([...defs.values()].map((d) => d.method));
            let m0 = camel(name) || 'reusableStep'; const base = m0; for (let k = 2; used.has(m0); k++) m0 = `${base}${k}`;
            const pagesUsed = [...new Set(mine.map((m) => m.page))];
            const any = (f: keyof Def) => mine.some((m) => !!m.flags[f]);
            defs.set(`block|${text}`, { text, method: m0, params, body: scopes, page: pagesUsed[0], pages: pagesUsed.slice(1), helper: any('helper'), upload: any('upload'), download: any('download'), testData: any('testData'), memory: any('memory'), number: any('number'),
                more: [...new Set(scopes.flatMap((x) => ['checkColumn', 'waitUntil'].filter((n) => x.includes(`${n}(`))))] });
        }
        // Its steps' own definitions, when no other line uses them.
        for (const m of mine) {
            const left = (keyUses.get(m.key) ?? 1) - 1;
            keyUses.set(m.key, left);
            if (left <= 0) defs.delete(m.key);
        }
        lines.splice(firstLine, lastLine - firstLine + 1, `${kType || 'When'} ${line}`);
        lineBlock.splice(firstLine, lastLine - firstLine + 1, text);
        for (const m of members) if (m.line > lastLine) m.line -= lastLine - firstLine;
        for (const r of rows) if (inRange(r.index)) { r.block = text; r.line = `${kType || 'When'} ${line}`; r.stepReused = reused; }
    }
    // Keywords again (a reusable step may start or end a run of And).
    if (c.blocks?.length) {
        let prev = '';
        for (let l = 0; l < lines.length; l++) {
            const w = /^(Given|When|Then|And|But)\s+(.*)$/.exec(lines[l]);
            if (!w) continue;
            const type = w[1] === 'And' || w[1] === 'But' ? prev : w[1];
            lines[l] = `${type === prev && l > 0 ? 'And' : type} ${w[2]}`;
            prev = type;
        }
    }

    // 5. Configuration: addresses, a new project's files, the step folder.
    const files: PlanFile[] = [];
    const cfg = new Map<string, { text: string | null; original: string | null }>();
    const cfgText = (f: { path: string; text: string | null }) => { if (!cfg.has(f.path)) cfg.set(f.path, { text: f.text, original: f.text }); return cfg.get(f.path)!; };
    const values = { ...ctx.config.values };
    if (!ctx.config.exists) {
        const common = cfgText(ctx.config.common);
        common.text = setEnvKey(common.text, 'BROWSER', 'chromium', `Project ${ctx.project}: created by CS Test Studio for recorded tests`);
        common.text = setEnvKey(common.text, 'HEADLESS', 'false');
        // The shared default (global.env) usually loads test/<project>/steps already: then the project
        // keeps it (its own value would replace it, dropping shared step folders such as test/common/steps).
        if (!ctx.config.stepsLoaded) common.text = setEnvKey(common.text, 'STEP_DEFINITIONS_PATH', `${ctx.stepsFolder};${ctx.config.stepPath?.value ?? `node_modules/${pkg}/dist/steps`}`);
    }
    const addresses = new Map<Page, { key: string; path: string }>();
    for (const p of pages) {
        if (!p.url) continue;
        let a: ReturnType<typeof addressFor>;
        try { a = addressFor(p.url, values); } catch { warnings.push(`${p.url} is not an address: the ${p.title} page opens it as recorded.`); continue; }
        if (a.newKey) {
            const o = origin(p.url);
            values[a.newKey] = o;
            if (a.newKey === 'BASE_URL') { const f = cfgText(ctx.config.envFile); f.text = setEnvKey(f.text, 'BASE_URL', o, `Address of the application in ${ctx.env}`); }
            else {
                const f = cfgText(ctx.config.common);
                f.text = setEnvKey(f.text, a.newKey, o, `Address of ${new URL(p.url).hostname} (recorded); set it in environments/<env>.env where it differs`);
                warnings.push(`${a.newKey}=${o} is added to ${ctx.config.common.path}: set it in each environment's file where the address differs.`);
            }
        }
        addresses.set(p, a);
    }
    if (ctx.config.stepPath && !ctx.config.stepsLoaded) {
        const f = cfgText(ctx.config.stepPath.file);
        if (f.text) f.text = addStepFolder(f.text, ctx.stepsFolder);
    }
    // Sign-in values: per environment (they differ between environments); secrets encrypted or Studio secrets.
    const signInWritten = si !== undefined && !existingMatch('the user is signed in');
    if (signInWritten) {
        const env = cfgText(ctx.config.envFile);
        signIn.keys.forEach((x, n) => {
            const v = x.secret ? secretValue(x.value, x.label, x.page) : x.value;
            env.text = setEnvKey(env.text, x.key, v, n === 0 ? `Sign-in (CS Test Studio recording "${recTitle}")` : undefined);
        });
        // Where the signed-in session is kept between scenarios and runs (never in Git: it holds the session cookies).
        if (!values.AUTH_STORAGE_STATE_PATH) {
            const common = cfgText(ctx.config.common);
            common.text = setEnvKey(common.text, 'AUTH_STORAGE_STATE_PATH', `.auth/${ctx.project}-session.json`, 'The signed-in session, reused by the next scenarios (kept out of Git: .auth/ in .gitignore)');
            const gi = ctx.files['.gitignore'];
            if (gi === undefined || !/^\/?\.auth\/?\s*$/m.test(gi)) files.push({ path: '.gitignore', kind: 'other', change: gi === undefined ? 'new' : 'update', text: `${(gi ?? '').replace(/\s*$/, gi ? '\n' : '')}# Signed-in sessions of test runs (CS Test Studio)\n.auth/\n` });
        }
    }
    for (const [p, f] of cfg) if (f.text !== f.original && f.text !== null) files.push({ path: p, text: f.text, kind: 'config', change: f.original === null ? 'new' : 'update' });

    // 6. Data file: a new one (JSON, CSV or Excel), or one the project has; its rows are kept and the
    // recording's new columns added with the recorded value.
    const dc = c.data ?? {};
    const fmt = (dc.file ? formatOf(dc.file) : null) ?? (dc.format === 'csv' ? 'csv' : dc.format === 'excel' ? 'excel' : 'json');
    const dataPath = dc.file ?? `${ctx.dataFolder}/${slug}.${fmt === 'excel' ? 'xlsx' : fmt}`;
    const attached = !!dc.file;
    const sheet = fmt === 'excel' ? (dc.sheet || dc.existing?.sheets?.[0] || 'Data') : undefined;
    let dataColumns: string[] = [];
    if (columns.length) {
        const fresh: Record<string, string> = attached ? { ...row } : { testCaseId: 'TC01', description: `${recTitle} (recorded ${new Date().toISOString().slice(0, 10)})`, runFlag: 'Yes', ...row };
        let had: Table | undefined = dc.existing;
        // Plans made without the file read (JSON the model has).
        if (!had && fmt === 'json' && ctx.files[dataPath] !== undefined) {
            try {
                const j = JSON.parse(ctx.files[dataPath]) as Record<string, unknown>;
                let v: unknown = j; for (const k of jsonRowsPath(dc.path) ?? ['data']) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
                if (Array.isArray(v)) { const rows = v.filter((x) => x && typeof x === 'object').map((x) => Object.fromEntries(Object.entries(x as object).map(([k, y]) => [k, typeof y === 'string' ? y : JSON.stringify(y)]))); had = { columns: [...new Set(rows.flatMap((r) => Object.keys(r)))], rows }; }
            } catch { warnings.push(`${dataPath} is not valid JSON: it is replaced by the recorded row.`); }
        }
        dataColumns = [...(had?.columns ?? []), ...Object.keys(fresh).filter((k) => !(had?.columns ?? []).includes(k))];
        // Rows the team has stay; new columns get the recorded value.
        const rowsOut = had && had.rows.length ? had.rows.map((r) => { const out = { ...r }; for (const [k, v] of Object.entries(fresh)) if (!(k in out) || !had!.columns.includes(k)) out[k] = v; return out; }) : [fresh];
        const added = dataColumns.filter((k) => !(had?.columns ?? []).includes(k));
        if (had && !added.length && !dc.fresh) {
            // The file already has every column: it is used as it is.
        } else if (fmt === 'xml') {
            if (added.length) warnings.push(`${dataPath} is XML, which the Studio does not write: choose one of its columns for ${added.join(', ')}, or another file.`);
        } else {
            const change: PlanFile['change'] = (had && !dc.fresh) || ctx.files[dataPath] !== undefined ? 'update' : 'new';
            if (fmt === 'json') files.push({ path: dataPath, kind: 'data', change, text: writeJson(ctx.files[dataPath] ?? null, dc.path, dataColumns, rowsOut) });
            else if (fmt === 'csv') files.push({ path: dataPath, kind: 'data', change, text: toCsv(dataColumns, rowsOut) });
            else files.push({ path: dataPath, kind: 'data', change, text: toCsv(dataColumns, rowsOut), encode: { as: 'xlsx', sheet: sheet! }, shownBefore: had ? toCsv(had.columns, had.rows) : null });
            if (fmt === 'csv' && rowsOut.some((r) => Object.values(r).some((v) => /^\s|\s$/.test(v)))) warnings.push(`${dataPath}: the framework trims spaces at the start and end of CSV values.`);
            if (fmt === 'excel' && rowsOut.some((r) => Object.values(r).some((v) => v.startsWith('=')))) warnings.push(`${dataPath}: the framework evaluates Excel values that start with = as formulas.`);
        }
    }

    // 7. Page objects (new, or extended with what they lack).
    const elementCode = (p: Page, e: El) => {
        const opts: string[] = [];
        // In a frame page the element inherits the page's frames (CSFramePage).
        // The framework's locators confirmed while recording: the best (by the framework's locator linter) as the
        // locator, the others the linter accepts as alternativeLocators with selfHeal (as the team's pages do).
        const fw = locatorsOf(e);
        const primary = fw.find((x) => PRIMARY_KEYS.has(x.key));
        if (primary) opts.push(`${primary.key}: ${tsString(primary.value)}`);
        else if (e.target.testId) opts.push(`testId: ${tsString(e.target.testId)}`);
        else {
            opts.push(`css: ${tsString(e.target.selector)}`);
            // Only an id the project's policy ignores finds it: written (nothing else does), and said.
            const ids = [...e.target.selector.matchAll(/#([A-Za-z][\w-]*)/g)].map((m) => m[1]);
            if (c.policy?.ignoreId && ids.some((x) => c.policy!.ignoreId!.test(x))) warnings.push(`${p.className}.${e.prop}: only "${e.target.selector}" finds it, an id RECORDER_IGNORE_ID_PATTERN ignores; give the element a test id or record it again in the Studio.`);
        }
        // An id or name alternative could only be written as css: (the linter's css, 45): not written.
        const alts = fw.filter((x) => x !== primary && x.score >= LINT_MIN_SCORE && x.key !== 'id' && x.key !== 'name').slice(0, 3).map(alternativeOf);
        if (alts.length) opts.push('selfHeal: true', `alternativeLocators: [${alts.map(tsString).join(', ')}]`);
        opts.push(`description: ${tsString(`${e.label} (${p.title} page)`)}`);
        // Not "page.locator(…)": the framework's locator linter reports raw page.locator() calls, comments too.
        return `    // Recorded as ${e.target.source.replace(/\s+/g, ' ').replace(/\*\//g, '* /').replace(/\bpage\./g, '').slice(0, 180)}\n    @CSGetElement({ ${opts.join(', ')} })\n    public ${e.prop}!: CSWebElement;\n`;
    };
    const methodCode = (p: Page, m: string): string => {
        if (m === 'open') {
            const a = addresses.get(p);
            if (!a) return p.url ? `    /** Opens the page. */\n    public async open(): Promise<void> {\n        await this.navigate(${tsString(p.url)});\n    }\n` : '';
            return `    /** Opens the page: ${a.key} of the environment + the recorded path, so it works in every environment. */
    public async open(): Promise<void> {
        await this.navigate(new URL(${tsString(a.path)}, String(this.config.get(${tsString(a.key)}))).toString());
    }
`;
        }
        if (m === 'currentUrl') return `    public async currentUrl(): Promise<string> {\n        return this.page.url();\n    }\n`;
        if (m === 'currentTitle') return `    public async currentTitle(): Promise<string> {\n        return this.page.title();\n    }\n`;
        return '';
    };
    /** An import path from one repository file to another (without .ts). */
    const rel = (from: string, to: string) => {
        const a = from.split('/').slice(0, -1), b = to.split('/');
        let i = 0; while (i < a.length && a[i] === b[i]) i++;
        const r = [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/').replace(/\.ts$/, '');
        return r.startsWith('.') ? r : `./${r}`;
    };
    // A frame page embedded in its page (the framework's @CSIframe): the steps reach its elements through it.
    const iframeCode = (f: Page) => `    // The ${f.title} page: its elements are found inside the frame.\n    @CSIframe(${f.className})\n    public ${f.frame!.prop}!: ${f.className};\n`;
    let elementsReused = 0, elementsNew = 0;
    for (const p of [...pages, ...framePages]) {
        const fresh = p.elements.filter((e) => !e.reused);
        elementsReused += p.elements.length - fresh.length; elementsNew += fresh.length;
        const missingMethods = [...p.needs].filter((m) => !(p.existing?.methods ?? []).includes(m));
        const newFrames = p.iframes.filter((f) => !f.frame!.embedded);
        const frameImports = newFrames.map((f) => `import { ${f.className} } from '${rel(p.file, f.file)}';`);
        if (p.existing) {
            if (!fresh.length && !missingMethods.length && !newFrames.length) continue;
            const members = [...newFrames.map(iframeCode), ...fresh.map((e) => elementCode(p, e)), ...missingMethods.map((m) => methodCode(p, m))].filter(Boolean).join('\n');
            let text = insertIntoClass(ts, p.existing.text, p.className, `    // Added by CS Test Studio (recording "${recTitle}")\n${members}`);
            if (!text) { warnings.push(`${p.file}: the class ${p.className} could not be extended; its new elements were not added.`); continue; }
            const head = p.existing.text.split(/\n@CSPage|\nexport class/)[0];
            const imports: string[] = [];
            if (fresh.length && !/\bCSGetElement\b/.test(head)) imports.push(`import { CSGetElement } from '${pkg}/core';`);
            if (newFrames.length && !/\bCSIframe\b/.test(head)) imports.push(`import { CSIframe } from '${pkg}/core';`);
            if (fresh.length && !/\bCSWebElement\b/.test(head)) imports.push(`import { CSWebElement } from '${pkg}/element';`);
            imports.push(...frameImports.filter((x) => !head.includes(x)));
            if (imports.length) text = `${imports.join('\n')}\n${text}`;
            files.push({ path: p.file, kind: 'page', change: 'update', text });
            continue;
        }
        const els = p.elements.map((e) => elementCode(p, e)).join('\n');
        if (p.frame) {
            files.push({ path: p.file, kind: 'page', change: 'new', text: `import { CSFramePage, CSPage, CSGetElement } from '${pkg}/core';
import { CSWebElement } from '${pkg}/element';

/**
 * The ${p.title} page, recorded with CS Test Studio. Its elements are found inside the frame
 * (outermost first); the ${p.frame.host.className} embeds it as ${p.frame.prop}.
 */
@CSPage(${tsString(p.id)})
export class ${p.className} extends CSFramePage {
    protected frame = [${p.frame.chain.map(frameSpec).join(', ')}];

${els}}

export default ${p.className};
` });
            continue;
        }
        const methods = [...p.needs].map((m) => methodCode(p, m)).filter(Boolean).join('\n');
        const embeds = p.iframes.map(iframeCode).join('\n');
        files.push({ path: p.file, kind: 'page', change: 'new', text: `import { CSBasePage, CSPage, CSGetElement${p.iframes.length ? ', CSIframe' : ''} } from '${pkg}/core';
import { CSWebElement } from '${pkg}/element';
${frameImports.map((x) => `${x}\n`).join('')}
/**
 * ${p.title} page, recorded with CS Test Studio${p.url ? ` from ${p.url.replace(/\*\//g, '* /')}` : ''}.
 * Locators are Playwright selectors as recorded; replace them with more stable ones where the page has
 * them (test ids, ids).
 */
@CSPage(${tsString(p.id)})
export class ${p.className} extends CSBasePage {
${embeds ? `${embeds}\n` : ''}${els}
    protected initializeElements(): void {
        // Elements are created by @CSGetElement.
    }
${methods ? `\n${methods}` : ''}}

export default ${p.className};
` });
    }

    // 8. Step files: one per page, extended with the missing definitions.
    // Shared helpers of recorded steps: one module per project, imported by the step files. Not a step
    // file itself (the framework checks function names across step files: copies would clash).
    const supportFile = `${ctx.stepsFolder.split('/').slice(0, -1).join('/') || `test/${ctx.project}`}/support/recording-helpers.ts`;
    const HELPER = `
/** Checks that retry for up to 10 s (the page may still be loading), as Playwright's expect does. */
export async function eventually(read: () => Promise<string | null>, expected: string, mode: 'equals' | 'contains', what: string): Promise<void> {
    const re = /^\\/(.*)\\/([a-z]*)$/s.exec(expected);
    const ok = (v: string) => (re ? new RegExp(re[1], re[2]).test(v) : mode === 'contains' ? v.includes(expected) : v.trim() === expected.trim());
    let actual = '';
    const until = Date.now() + 10000;
    for (;;) {
        try { actual = (await read()) ?? ''; } catch (e) { actual = \`(\${(e as Error).message.split('\\n')[0]})\`; }
        if (ok(actual)) return;
        if (Date.now() > until) throw new Error(\`\${what}: expected \${mode === 'contains' ? 'to contain ' : ''}"\${expected}", but it was "\${actual}".\`);
        await new Promise((r) => setTimeout(r, 250));
    }
}
`;
    const UPLOADS = `
/** Files for upload steps (names separated by " | "), from the project's test data. */
export function uploadFiles(names: string): string[] {
    return names ? names.split(' | ').map((f) => path.resolve(${tsString(`${ctx.dataFolder}/uploads`)}, f)) : [];
}
`;
    const DOWNLOAD = `
/** Waits up to 15 s for a file the browser downloaded (the framework saves downloads), by name or /pattern/. */
export async function downloaded(expected: string): Promise<void> {
    const re = /^\\/(.*)\\/([a-z]*)$/s.exec(expected);
    const ok = (n: string) => (re ? new RegExp(re[1], re[2]).test(n) : n === expected);
    const until = Date.now() + 15000;
    for (;;) {
        const files = CSTestResultsManager.getInstance().getDownloadedFiles();
        if (files.some((f) => ok(f.suggestedName) || ok(f.fileName))) return;
        if (Date.now() > until) throw new Error(\`No downloaded file \${expected}; downloaded: \${files.map((f) => f.suggestedName).join(', ') || 'none'}.\`);
        await new Promise((r) => setTimeout(r, 300));
    }
}
`;
    const TESTDATA = `
/** Test data read in a run: the queries, procedures and API requests of ${ctx.dataFolder}/test-data-sources.json, by name (first row). */
export async function readTestData(name: string): Promise<void> {
    const sources = JSON.parse(fs.readFileSync(path.resolve(${tsString(`${ctx.dataFolder}/test-data-sources.json`)}), 'utf8')) as Record<string, TestDataSource>;
    const s = sources[name];
    if (!s) throw new Error(\`No test data "\${name}" in ${ctx.dataFolder}/test-data-sources.json.\`);
    const config = CSConfigurationManager.getInstance();
    // Parameters may use {config:KEY} / {env:NAME}, and {remembered:name} (a value remembered earlier in the scenario).
    const params = (s.params ?? []).map((p) => String(config.interpolate(p.replace(/\\{remembered:(\\w+)\\}/g, (_m, n: string) => String(CSScenarioContext.getInstance().get(\`remembered.\${n}\`) ?? '')))));
    let row: Record<string, unknown> | null | undefined;
    if (s.kind === 'api') row = (await readApiRows(s))[0];
    else {
        const { CSDBUtils } = await import(${tsString(`${pkg}/database-utils`)});
        if (s.kind === 'procedure') row = ((await CSDBUtils.executeStoredProcedure(s.connection ?? '', s.procedure ?? '', params)) as { rows?: Array<Record<string, unknown>> }).rows?.[0];
        else row = await CSDBUtils.executeSingleRowOrNull(s.connection ?? '', s.sql ?? '', params);
    }
    if (!row) throw new Error(\`The test data "\${name}" found no row.\`);
    CSScenarioContext.getInstance().set(\`testData.\${name}\`, row);
}

interface TestDataSource { kind: 'query' | 'procedure' | 'api'; connection?: string; sql?: string; procedure?: string; params?: string[]; collection?: string; request?: string; path?: string }
interface Pair { key: string; value: string; enabled?: boolean }
interface SavedAuth { type: string; username?: string; password?: string; token?: string; key?: string; value?: string; in?: string; grant?: string; tokenUrl?: string; clientId?: string; clientSecret?: string; scope?: string }
interface SavedRequest { kind: string; id: string; items?: SavedRequest[]; method: string; url: string; query: Pair[]; headers: Pair[]; body: { mode: string; text?: string; form?: Pair[]; parts?: Array<Pair & { type?: string }>; file?: string }; auth: SavedAuth }

/** The rows of an API response: the saved request of a Studio collection, sent through the framework's API client. */
async function readApiRows(s: TestDataSource): Promise<Array<Record<string, unknown>>> {
    const { CSAPIClient } = await import(${tsString(`${pkg}/api`)});
    const config = CSConfigurationManager.getInstance();
    const c = JSON.parse(fs.readFileSync(path.resolve(s.collection ?? ''), 'utf8')) as { baseUrl: string; variables: Pair[]; auth: SavedAuth; items: SavedRequest[] };
    const find = (xs: SavedRequest[]): SavedRequest | undefined => { for (const x of xs) { if (x.kind === 'request' && x.id === s.request) return x; const f = x.items ? find(x.items) : undefined; if (f) return f; } return undefined; };
    const r = find(c.items);
    if (!r) throw new Error(\`No request \${s.request} in \${s.collection}.\`);
    const vars: Record<string, string> = {};
    for (const v of c.variables ?? []) if (v.enabled !== false && v.key) vars[v.key] = v.value;
    // {{name}} (the collection's variables), {config:KEY} (the framework's configuration), {env:NAME} (Studio secrets in a run).
    const fill = (t: string, depth = 0): string => t
        .replace(/\\{\\{\\s*([\\w.-]+)\\s*\\}\\}/g, (m, n: string) => (n in vars && depth < 5 ? fill(vars[n], depth + 1) : String(CSScenarioContext.getInstance().get(\`remembered.\${n}\`) ?? m)))
        .replace(/\\{config:([\\w.-]+)\\}/g, (m, k: string) => { const x = config.get(k); return x === undefined || x === null ? m : String(x); })
        .replace(/\\{env:([\\w.-]+)\\}/g, (m, k: string) => process.env[k] ?? m);
    const on = (p: Pair) => p.enabled !== false && p.key.trim() !== '';
    let url = fill(r.url.trim());
    if (!/^https?:\\/\\//i.test(url)) url = fill(c.baseUrl.trim()).replace(/\\/+$/, '') + (url && !url.startsWith('/') && !url.startsWith('?') ? '/' : '') + url;
    const query = r.query.filter(on).map((q) => \`\${encodeURIComponent(fill(q.key))}=\${encodeURIComponent(fill(q.value))}\`);
    const headers: Record<string, string> = {};
    for (const h of r.headers.filter(on)) headers[fill(h.key)] = fill(h.value);
    const auth = r.auth.type === 'inherit' ? c.auth : r.auth;
    const client = new CSAPIClient();
    if (auth.type === 'basic') headers.Authorization = 'Basic ' + Buffer.from(\`\${fill(auth.username ?? '')}:\${fill(auth.password ?? '')}\`).toString('base64');
    else if (auth.type === 'bearer') headers.Authorization = \`Bearer \${fill(auth.token ?? '')}\`;
    else if (auth.type === 'apikey' && auth.key) { if (auth.in === 'query') query.push(\`\${encodeURIComponent(fill(auth.key))}=\${encodeURIComponent(fill(auth.value ?? ''))}\`); else headers[fill(auth.key)] = fill(auth.value ?? ''); }
    else if (auth.type === 'oauth2') {
        const form = [['grant_type', auth.grant ?? 'client_credentials'], ['client_id', auth.clientId], ['client_secret', auth.clientSecret], ['scope', auth.scope], ...(auth.grant === 'password' ? [['username', auth.username], ['password', auth.password]] : [])]
            .filter((x) => x[1]).map((x) => \`\${x[0]}=\${encodeURIComponent(fill(String(x[1])))}\`).join('&');
        const t = await client.request({ url: fill(auth.tokenUrl ?? ''), method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, validateStatus: () => true });
        const tb = (typeof t.body === 'string' ? JSON.parse(t.body) : t.body) as { access_token?: string };
        if (t.status >= 400 || !tb?.access_token) throw new Error(\`The OAuth2 token request failed (\${t.status}).\`);
        headers.Authorization = \`Bearer \${tb.access_token}\`;
    }
    if (query.length) url += (url.includes('?') ? '&' : '?') + query.join('&');
    let body: string | Buffer | undefined;
    const has = (n: string) => Object.keys(headers).some((k) => k.toLowerCase() === n);
    if (r.body.mode === 'form') { body = (r.body.form ?? []).filter(on).map((p) => \`\${encodeURIComponent(fill(p.key))}=\${encodeURIComponent(fill(p.value))}\`).join('&'); if (!has('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else if (r.body.mode === 'multipart') {
        // Fields and files (a file's path is the project's, as the Studio sends it).
        const boundary = \`----CSTestData\${Date.now().toString(36)}\${Math.random().toString(36).slice(2, 10)}\`;
        const MIME: Record<string, string> = { json: 'application/json', xml: 'application/xml', csv: 'text/csv', txt: 'text/plain', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
        const chunks: Buffer[] = [];
        for (const part of (r.body.parts ?? []).filter(on)) {
            const name = fill(part.key).replace(/"/g, '%22');
            if (part.type === 'file') {
                const rel = fill(part.value);
                const file = rel.split(/[\\\\/]/).pop()!.replace(/"/g, '%22');
                chunks.push(Buffer.from(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${name}"; filename="\${file}"\\r\\nContent-Type: \${MIME[file.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'}\\r\\n\\r\\n\`), fs.readFileSync(path.resolve(rel)), Buffer.from('\\r\\n'));
            } else chunks.push(Buffer.from(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${name}"\\r\\n\\r\\n\${fill(part.value)}\\r\\n\`));
        }
        chunks.push(Buffer.from(\`--\${boundary}--\\r\\n\`));
        body = Buffer.concat(chunks);
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
        headers['Content-Type'] = \`multipart/form-data; boundary=\${boundary}\`;
    }
    else if (r.body.mode === 'file' && r.body.file) {
        // A payload template of the project (PAYLOAD_BASE_PATH), filled like the other values.
        const base = String(config.get('PAYLOAD_BASE_PATH') || 'test-data/payloads').replace(/[\\\\/]+$/, '');
        const file = \`\${base}/\${r.body.file.trim()}\`;
        body = fill(fs.readFileSync(path.resolve(file), 'utf8'));
        if (!has('content-type')) headers['Content-Type'] = /\\.json$/i.test(file) ? 'application/json' : /\\.xml$/i.test(file) ? 'application/xml' : 'text/plain';
    }
    else if (r.body.mode !== 'none' && r.body.text !== undefined) { body = fill(r.body.text); if (!has('content-type')) headers['Content-Type'] = r.body.mode === 'json' ? 'application/json' : r.body.mode === 'xml' ? 'application/xml' : 'text/plain'; }
    const res = await client.request({ url, method: r.method as 'GET', headers, body, validateStatus: () => true });
    if (res.status >= 400) throw new Error(\`The test data request answered \${res.status} \${res.statusText}.\`);
    let data: unknown = res.body;
    if (Buffer.isBuffer(data)) data = data.toString('utf8');
    if (typeof data === 'string') data = JSON.parse(data);
    // The rows at the path ($, $.items, $.data.users[*], $.items[0]).
    for (const part of (s.path ?? '$').replace(/^\\$/, '').match(/\\.[\\w$-]+|\\[\\d+\\]|\\[\\*\\]/g) ?? []) {
        if (part === '[*]') continue;
        data = part.startsWith('[') ? (data as unknown[])?.[Number(part.slice(1, -1))] : (data as Record<string, unknown>)?.[part.slice(1)];
    }
    const rows = Array.isArray(data) ? data : data === undefined || data === null ? [] : [data];
    return rows.map((x) => (x && typeof x === 'object' ? x as Record<string, unknown> : { value: x }));
}

/** A value of the test data read in this scenario: "name.column". */
export function testData(ref: string): string {
    const [name, ...rest] = ref.split('.');
    const column = rest.join('.');
    const row = CSScenarioContext.getInstance().get(\`testData.\${name}\`) as Record<string, unknown> | undefined;
    if (!row) throw new Error(\`The test data "\${name}" has not been read in this scenario.\`);
    const key = Object.keys(row).find((k) => k === column) ?? Object.keys(row).find((k) => k.toLowerCase() === column.toLowerCase());
    if (key === undefined) throw new Error(\`The test data "\${name}" has no column \${column} (columns: \${Object.keys(row).join(', ')}).\`);
    const v = row[key];
    return v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
}
`;
    const MEMORY = `
/** A value kept for the later steps of the scenario (an order number, a typed unique value). */
export function remember(name: string, value: string): void {
    CSScenarioContext.getInstance().set(\`remembered.\${name}\`, value);
}

/** A value remembered earlier in the scenario. */
export function remembered(name: string): string {
    const v = CSScenarioContext.getInstance().get(\`remembered.\${name}\`) as string | undefined;
    if (v === undefined) throw new Error(\`Nothing remembered as "\${name}" in this scenario.\`);
    return v;
}

/** A value made unique for this run from an example ("alice@shop.test" → "alice_lq3x9k2a@shop.test"). */
export function unique(example: string): string {
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const at = example.indexOf('@');
    return at > 0 ? \`\${example.slice(0, at)}_\${stamp}\${example.slice(at)}\` : \`\${example}_\${stamp}\`;
}
`;
    const NUMBERS = `
/** A number shown on the page ("1,250.00 USD" → 1250), compared, retried for up to 10 s like the other checks. */
export async function eventuallyNumber(read: () => Promise<string | null>, op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le', expected: number, what: string): Promise<void> {
    const words = { eq: 'equal to', ne: 'different from', gt: 'greater than', ge: 'at least', lt: 'less than', le: 'at most' }[op];
    let text = '';
    const until = Date.now() + 10000;
    for (;;) {
        try { text = ((await read()) ?? '').trim(); } catch (e) { text = \`(\${(e as Error).message.split('\\n')[0]})\`; }
        const n = Number(text.replace(/[^\\d.-]/g, ''));
        const ok = text.replace(/[^\\d]/g, '') !== '' && (op === 'eq' ? n === expected : op === 'ne' ? n !== expected : op === 'gt' ? n > expected : op === 'ge' ? n >= expected : op === 'lt' ? n < expected : n <= expected);
        if (ok) return;
        if (Date.now() > until) throw new Error(\`\${what}: expected \${words} \${expected}, but it was "\${text}".\`);
        await new Promise((r) => setTimeout(r, 250));
    }
}
`;
    const COLUMNS = `
/** Every row of a table column: the same text, containing a text, or sorted (numbers as numbers); retried for 10 s. */
export async function checkColumn(read: () => Promise<string[]>, mode: 'equals' | 'contains' | 'asc' | 'desc', expected: string, what: string): Promise<void> {
    let cells: string[] = [];
    let problem = '';
    const until = Date.now() + 10000;
    for (;;) {
        try { cells = (await read()).map((c) => c.trim()); } catch (e) { cells = []; problem = (e as Error).message.split('\\n')[0]; }
        // Numbers as numbers (1,250.00 · -3 · 45%), other texts in natural order (SO-9 before SO-10).
        const num = (t: string) => { const m = /^\\s*([-+]?)\\s*[$€£₹]?\\s*([\\d,]*\\.?\\d+)\\s*[%$€£₹A-Za-z]{0,4}\\s*$/.exec(t); return m ? Number(m[1] + m[2].replace(/,/g, '')) : null; };
        const cmp = (a: string, b: string) => { const x = num(a), y = num(b); return x !== null && y !== null ? x - y : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); };
        const bad = mode === 'equals' ? cells.find((c) => c !== expected.trim())
            : mode === 'contains' ? cells.find((c) => !c.includes(expected))
            : cells.find((c, i) => i > 0 && (mode === 'asc' ? cmp(cells[i - 1], c) > 0 : cmp(cells[i - 1], c) < 0));
        if (cells.length && bad === undefined) return;
        if (Date.now() > until) throw new Error(\`\${what}: \${!cells.length ? \`no rows\${problem ? \` (\${problem})\` : ''}\` : mode === 'equals' || mode === 'contains' ? \`"\${bad}" is not \${mode === 'equals' ? '' : 'containing '}"\${expected}"\` : \`not sorted \${mode === 'asc' ? 'ascending' : 'descending'} at "\${bad}"\`} (\${cells.length} rows: \${cells.slice(0, 10).join(', ')}).\`);
        await new Promise((r) => setTimeout(r, 300));
    }
}
`;
    const WAITS = `
/** Wait until a text shows (or an element is shown / gone), refreshing the page every 5 s when asked (a job that finishes later). */
export async function waitUntil(read: () => Promise<string>, mode: 'contains' | 'equals', expected: string, o: { reload: boolean; seconds: number }, what: string): Promise<void> {
    const until = Date.now() + o.seconds * 1000;
    let now = '';
    for (;;) {
        try { now = (await read()).trim(); } catch { now = ''; }
        if (mode === 'contains' ? now.includes(expected) : now === expected) return;
        if (Date.now() > until) throw new Error(\`\${what}: waited \${o.seconds} s for \${mode === 'contains' ? \`"\${expected}"\` : expected === 'true' ? 'it to show' : 'it to go'}, last "\${now}".\`);
        if (o.reload) {
            await new Promise((r) => setTimeout(r, 5000));
            await CSBrowserManager.getInstance().getPage().reload({ waitUntil: 'domcontentloaded' });
        } else await new Promise((r) => setTimeout(r, 500));
    }
}
`;
    const DATES = `
/** A date relative to today ("today", "today + 7 days", "today - 1 month", "today + 2 weeks"), in a format (dd/MM/yyyy, MMM d, yyyy…). */
export function dateFrom(when: string, format: string): string {
    const m = /^\\s*today\\s*(?:([+-])\\s*(\\d+)\\s*(days?|weeks?|months?|years?))?\\s*$/i.exec(when);
    if (!m) throw new Error(\`A date like "today", "today + 7 days" or "today - 1 month", not "\${when}".\`);
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    const n = m[1] ? Number(m[2]) * (m[1] === '-' ? -1 : 1) : 0;
    const unit = (m[3] ?? 'day').toLowerCase();
    if (unit.startsWith('day')) d.setDate(d.getDate() + n);
    else if (unit.startsWith('week')) d.setDate(d.getDate() + 7 * n);
    else if (unit.startsWith('month')) d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const two = (x: number) => String(x).padStart(2, '0');
    return format.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d/g, (t) => ({ yyyy: String(d.getFullYear()), yy: two(d.getFullYear() % 100), MMMM: months[d.getMonth()], MMM: months[d.getMonth()].slice(0, 3), MM: two(d.getMonth() + 1), M: String(d.getMonth() + 1), dd: two(d.getDate()), d: String(d.getDate()) } as Record<string, string>)[t]);
}

`;
    const SETTING = `
/** A setting of the environment (config/<project>/…): decrypted (ENCRYPTED:) and filled ({env:NAME}) by the framework. */
export function setting(key: string): string {
    return String(CSConfigurationManager.getInstance().get(key) ?? '');
}
`;
    /** A definition in a step class; its pages' fields as the class names them (a reusable step uses several). */
    const defCode = (d: Def, field: string, fieldOf: (pg: Page) => string = (pg) => pg.field) => {
        const swap = (b: string) => [d.page, ...(d.pages ?? [])].reduce((t, pg) => t.split(`this.${pg.field}.`).join(`this.${pg === d.page ? field : fieldOf(pg)}.`), b);
        return `    @CSBDDStepDef(${tsString(d.text)})
    async ${d.method}(${d.params.join(', ')}): Promise<void> {
${d.body.map((b) => `        ${swap(b)}`).join('\n')}
    }
`;
    };
    const helpersUsed = new Set<string>();
    for (const p of pages) {
        const mine = [...defs.values()].filter((d) => d.page === p);
        if (!mine.length) continue;
        // The page's step file: one the project has that injects the page, else <page>.steps.ts.
        const injecting = Object.entries(ctx.files).find(([f, t]) => f.startsWith(`${ctx.stepsFolder}/`) && f.endsWith('.ts') && !!pageFieldOf(t, p.id));
        const file = injecting?.[0] ?? `${ctx.stepsFolder}/${kebab(p.name)}.steps.ts`;
        const old = injecting?.[1] ?? ctx.files[file];
        const needHelper = mine.some((d) => d.helper), needUpload = mine.some((d) => d.upload), needDownload = mine.some((d) => d.download), needData = mine.some((d) => d.testData);
        // Other pages reusable steps of this class use.
        const extra = [...new Set(mine.flatMap((d) => d.pages ?? []))].filter((x) => x !== p);
        const memNames = [...mine.filter((d) => d.memory).flatMap((d) => ['remember', 'remembered', 'unique', 'dateFrom'].filter((n) => d.body.some((b) => new RegExp(`\\b${n}\\(`).test(b)))), ...(mine.some((d) => d.body.some((b) => b.includes('eventuallyNumber('))) ? ['eventuallyNumber'] : []), ...mine.flatMap((d) => d.more ?? [])];
        if (old !== undefined) {
            const cls = stepClassOf(ts, old);
            if (!cls) { warnings.push(`${file} has no @StepDefinitions class: its new steps were not added.`); continue; }
            const existingMethods = new Set([...old.matchAll(/async\s+(\w+)\s*\(/g)].map((m) => m[1]));
            for (const d of mine) { const base = d.method; for (let n = 2; existingMethods.has(d.method); n++) d.method = `${base}${n}`; existingMethods.add(d.method); }
            let field = pageFieldOf(old, p.id);
            const members: string[] = [];
            if (!field) { field = p.field; members.push(`    @Page(${tsString(p.id)})\n    private ${field}!: ${p.className};\n`); }
            const fields = new Map(extra.map((x) => [x, pageFieldOf(old, x.id)]));
            for (const x of extra) if (!fields.get(x)) { fields.set(x, x.field); members.push(`    @Page(${tsString(x.id)})\n    private ${x.field}!: ${x.className};\n`); }
            members.push(...mine.map((d) => defCode(d, field!, (pg) => fields.get(pg) ?? pg.field)));
            let text = insertIntoClass(ts, old, cls, `    // Added by CS Test Studio (recording "${recTitle}")\n${members.join('\n')}`);
            if (!text) { warnings.push(`${file}: the class ${cls} could not be extended.`); continue; }
            const headText = old.split(/@StepDefinitions/)[0];
            const head: string[] = [];
            for (const x of [p, ...extra]) if (!new RegExp(`\\b${x.className}\\b`).test(headText)) head.push(`import { ${x.className} } from '${rel(file, x.file)}';`);
            if (!/\bPage\b/.test(headText)) head.push(`import { Page } from '${pkg}/bdd';`);
            // Helpers: from the shared module, unless the file has its own (recorded before the module existed).
            const names = [needHelper && !/\beventually\b/.test(headText) && 'eventually', needDownload && !/\bdownloaded\b/.test(headText) && 'downloaded', needUpload && !/\buploadFiles\b/.test(headText) && 'uploadFiles', needData && !/\btestData\b/.test(headText) && 'testData', ...[...new Set(memNames)].filter((n) => !new RegExp(`\\b${n}\\b`).test(headText))].filter((x): x is string => !!x);
            names.forEach((n) => helpersUsed.add(n));
            if (names.length) head.push(`import { ${names.join(', ')} } from '${rel(file, supportFile)}';`);
            if (head.length) text = `${head.join('\n')}\n${text}`;
            files.push({ path: file, kind: 'steps', change: 'update', text });
            continue;
        }
        const names = [needHelper && 'eventually', needDownload && 'downloaded', needUpload && 'uploadFiles', needData && 'testData', ...new Set(memNames)].filter((x): x is string => !!x);
        names.forEach((n) => helpersUsed.add(n));
        files.push({ path: file, kind: 'steps', change: 'new', text: `import { CSBDDStepDef, Page, StepDefinitions } from '${pkg}/bdd';
${[p, ...extra].map((x) => `import { ${x.className} } from '${rel(file, x.file)}';\n`).join('')}${names.length ? `import { ${names.join(', ')} } from '${rel(file, supportFile)}';\n` : ''}
/** Steps of the ${p.title} page (CS Test Studio recordings). */
@StepDefinitions
export class ${p.className.replace(/Page$/, '')}PageSteps {
    @Page(${tsString(p.id)})
    private ${p.field}!: ${p.className};
${extra.map((x) => `\n    @Page(${tsString(x.id)})\n    private ${x.field}!: ${x.className};\n`).join('')}
${mine.map((d) => defCode(d, p.field)).join('\n')}}
` });
    }

    // Test data read from a database in every run: its sources (by name), the step that reads one.
    const sourcesPath = `${ctx.dataFolder}/test-data-sources.json`;
    const allReads = [...new Set([...reads, ...checkReads])];
    if (allReads.length) {
        helpersUsed.add('readTestData');
        if (checkReads.length) helpersUsed.add('testData');
        let had: Record<string, unknown> = {};
        if (ctx.files[sourcesPath] !== undefined) { try { had = JSON.parse(ctx.files[sourcesPath]) as Record<string, unknown>; } catch { warnings.push(`${sourcesPath} is not valid JSON: it is replaced.`); } }
        const next = { ...had };
        for (const n of allReads) {
            const src = c.sources?.[n];
            if (!src) { warnings.push(`The test data "${n}" has no source.`); continue; }
            if (had[n] !== undefined && JSON.stringify(had[n]) !== JSON.stringify(src)) warnings.push(`The test data "${n}" in ${sourcesPath} is replaced by this recording's query.`);
            next[n] = src;
        }
        if (JSON.stringify(next) !== JSON.stringify(had)) files.push({ path: sourcesPath, kind: 'data', change: ctx.files[sourcesPath] !== undefined ? 'update' : 'new', text: `${JSON.stringify(next, null, 2)}\n` });
        const readsFile = `${ctx.stepsFolder}/test-data.steps.ts`;
        const readDef = `    @CSBDDStepDef('the test data {string} is read')
    async readTestDataSource(name: string): Promise<void> {
        await readTestData(name);
    }
`;
        // A check of the application's data: read again until it has the value (up to 10 s: it may be written a moment later).
        const checkDef = `    @CSBDDStepDef('the test data {string} should have {string} equal to {string}')
    async checkTestDataValue(name: string, column: string, expected: string): Promise<void> {
        let actual = '';
        const until = Date.now() + 10000;
        for (;;) {
            try { await readTestData(name); actual = testData(\`\${name}.\${column}\`); } catch (e) { actual = \`(\${(e as Error).message.split('\\n')[0]})\`; }
            if (actual.trim() === expected.trim()) return;
            if (Date.now() > until) throw new Error(\`The test data "\${name}" \${column}: expected "\${expected}", but it was "\${actual}".\`);
            await new Promise((r) => setTimeout(r, 500));
        }
    }
`;
        const wantRead = reads.length > 0 && !existingMatch('the test data "x" is read');
        const wantCheck = checkReads.length > 0 && !existingMatch('the test data "x" should have "y" equal to "z"');
        const oldReads = ctx.files[readsFile];
        if ((wantRead || wantCheck) && oldReads === undefined) {
            files.push({ path: readsFile, kind: 'steps', change: 'new', text: `import { CSBDDStepDef, StepDefinitions } from '${pkg}/bdd';
import { ${wantCheck ? 'readTestData, testData' : 'readTestData'} } from '${rel(readsFile, supportFile)}';

/** Test data of the application read in a run: databases and APIs (${sourcesPath}; CS Test Studio recordings). */
@StepDefinitions
export class TestDataSteps {
${[wantRead && readDef, wantCheck && checkDef].filter(Boolean).join('\n')}}
` });
        } else if ((wantRead || wantCheck) && oldReads !== undefined) {
            const cls = stepClassOf(ts, oldReads);
            let text = cls ? insertIntoClass(ts, oldReads, cls, [wantRead && !/is read'\)/.test(oldReads) && readDef, wantCheck && checkDef].filter(Boolean).join('\n')) : null;
            if (text && wantCheck && !/\btestData\b/.test(text.split('@StepDefinitions')[0])) text = text.replace(/import \{ readTestData \} from/, 'import { readTestData, testData } from');
            if (text) files.push({ path: readsFile, kind: 'steps', change: 'update', text });
        }
    }

    // The sign-in step: signs in, or finds the user signed in already (the saved session), then saves the session.
    if (signInWritten && signIn.marker) {
        helpersUsed.add('setting');
        const file = `${ctx.stepsFolder}/sign-in.steps.ts`;
        const pgs = [...signIn.pages];
        const imports = pgs.map((pg) => `import { ${pg.className} } from '${rel(file, pg.file)}';`).join('\n');
        const fields = pgs.map((pg) => `    @Page(${tsString(pg.id)})\n    private ${pg.field}!: ${pg.className};\n`).join('\n');
        const race = signIn.first
            ? `        // A saved session (AUTH_STORAGE_STATE_PATH) shows the application; otherwise the sign-in page (e.g. a company gateway).
        const state = await Promise.race([
            ${signIn.marker}.waitForVisible(60000).then(() => 'signed in', () => 'none'),
            ${signIn.first}.waitForVisible(60000).then(() => 'sign in', () => 'none'),
        ]);
        if (state === 'signed in') return;
        if (state === 'none') throw new Error('Neither the sign-in page nor the signed-in application appeared within 60 s.');
`
            : '';
        files.push({ path: file, kind: 'steps', change: ctx.files[file] !== undefined ? 'update' : 'new', text: `import { CSBDDStepDef, Page, StepDefinitions } from '${pkg}/bdd';
import { CSBrowserManager } from '${pkg}/browser';
${imports}
import { setting } from '${rel(file, supportFile)}';

/**
 * Signing in (CS Test Studio recording "${recTitle}"): the values are settings of the environment
 * (${ctx.config.envFile.path}: ${signIn.keys.map((x) => x.key).join(', ') || 'none'}); the signed-in session is saved
 * (AUTH_STORAGE_STATE_PATH) and the next scenarios start with it, until it expires.
 */
@StepDefinitions
export class SignInSteps {
${fields}
    @CSBDDStepDef('the user is signed in')
    async signInToTheApplication(): Promise<void> {
        ${signIn.open || '// (the application is open)'}
${race}${signIn.body.map((b) => `        ${b}`).join('\n')}
        await ${signIn.marker}.waitForVisible(60000);
        // Saved for the next scenarios and runs: they start signed in.
        if (setting('AUTH_STORAGE_STATE_PATH')) await CSBrowserManager.getInstance().saveStorageState();
    }
}
` });
    }

    // Tabs: shared steps (not of a page), the framework's browser manager switches the page the steps act on.
    if (browserSteps.size) {
        const file = `${ctx.stepsFolder}/browser.steps.ts`;
        const all: Record<string, string> = {
            'the user switches to the new tab': `    @CSBDDStepDef('the user switches to the new tab')
    async switchToNewTab(): Promise<void> {
        // The tab the last action opened: it may take a moment to appear (up to 10 s).
        const browser = CSBrowserManager.getInstance();
        const from = browser.getPage();
        for (let i = 0; i < 100; i++) {
            const pages = browser.getPages();
            if (pages.length > 1 && pages[pages.length - 1] !== from) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        if (browser.getPages()[browser.getPages().length - 1] === from) throw new Error('No new tab opened.');
        await browser.switchToLatestPage();
        await browser.getPage().waitForLoadState('domcontentloaded').catch(() => undefined);
    }
`,
            'the user presses {string}': `    @CSBDDStepDef('the user presses {string}')
    async pressKeyOfPage(key: string): Promise<void> {
        // A key or shortcut of the page (Escape, F2, Control+S), not typed into a field.
        await CSBrowserManager.getInstance().getPage().keyboard.press(key);
    }
`,
            'the user closes the tab': `    @CSBDDStepDef('the user closes the tab')
    async closeTheTab(): Promise<void> {
        // The steps after act in another tab (the next step switches to it).
        await CSBrowserManager.getInstance().getPage().close();
    }
`,
            'the user switches to tab {int}': `    @CSBDDStepDef('the user switches to tab {int}')\n    async switchToTab(tab: number): Promise<void> {\n        await CSBrowserManager.getInstance().switchToPage(tab - 1);\n    }\n`,
        };
        const want = [...browserSteps].filter((t) => !existingMatch(t.replace('{int}', '1').replace('{string}', '"x"')));
        const old = ctx.files[file];
        if (want.length && old === undefined) {
            files.push({ path: file, kind: 'steps', change: 'new', text: `import { CSBDDStepDef, StepDefinitions } from '${pkg}/bdd';\nimport { CSBrowserManager } from '${pkg}/browser';\n\n/** Tabs and windows (CS Test Studio recordings): the steps after a switch act in that tab. */\n@StepDefinitions\nexport class BrowserTabSteps {\n${want.map((t) => all[t]).join('\n')}}\n` });
        } else if (want.length && old !== undefined) {
            const cls = stepClassOf(ts, old);
            const text = cls ? insertIntoClass(ts, old, cls, want.map((t) => all[t]).join('\n')) : null;
            if (text) files.push({ path: file, kind: 'steps', change: 'update', text });
            else warnings.push(`${file}: the tab steps could not be added.`);
        }
    }

    // The shared helpers module: created, or extended with the helpers it does not have yet.
    if (helpersUsed.size) {
        if (helpersUsed.has('testData')) helpersUsed.add('readTestData');
        if (helpersUsed.has('remembered') || helpersUsed.has('unique') || helpersUsed.has('dateFrom')) helpersUsed.add('remember');
        const blocks: Record<string, string> = { eventually: HELPER, downloaded: DOWNLOAD, uploadFiles: UPLOADS, readTestData: TESTDATA, testData: '', setting: SETTING, remember: MEMORY, remembered: '', unique: '', dateFrom: DATES, eventuallyNumber: NUMBERS, checkColumn: COLUMNS, waitUntil: WAITS };
        const oldHelpers = ctx.files[supportFile];
        const missing = [...helpersUsed].filter((n) => blocks[n] !== '' && (!oldHelpers || !new RegExp(`export (async )?function ${n}\\(`).test(oldHelpers)));
        if (missing.length) {
            const imports = (t: string) => [
                missing.includes('uploadFiles') && !/import \* as path from 'path'/.test(t) && `import * as path from 'path';`,
                missing.includes('downloaded') && !/\bCSTestResultsManager\b/.test(t) && `import { CSTestResultsManager } from '${pkg}/reporter';`,
                missing.includes('readTestData') && !/import \* as path from 'path'/.test(t) && !missing.includes('uploadFiles') && `import * as path from 'path';`,
                missing.includes('readTestData') && !/import \* as fs from 'fs'/.test(t) && `import * as fs from 'fs';`,
                (missing.includes('readTestData') || missing.includes('remember')) && !/\bCSScenarioContext\b/.test(t) && `import { CSScenarioContext } from '${pkg}/bdd';`,
                (missing.includes('readTestData') || missing.includes('setting')) && !/\bCSConfigurationManager\b/.test(t) && `import { CSConfigurationManager } from '${pkg}/core';`,
                missing.includes('waitUntil') && !/\bCSBrowserManager\b/.test(t) && `import { CSBrowserManager } from '${pkg}/browser';`,
            ].filter(Boolean).join('\n');
            const body = missing.map((n) => blocks[n]).join('');
            if (oldHelpers === undefined) {
                files.push({ path: supportFile, kind: 'other', change: 'new', text: `/**\n * Helpers of the steps recorded with CS Test Studio, shared by the project's step files\n * (kept out of the step folder: it holds no steps).\n */\n${imports('')}\n${body}` });
            } else {
                const im = imports(oldHelpers);
                files.push({ path: supportFile, kind: 'other', change: 'update', text: `${im ? `${im}\n` : ''}${oldHelpers.replace(/\s*$/, '\n')}${body}` });
            }
        }
    }

    // 9. Feature.
    const outline = columns.length > 0;
    // Test data read from a database: first, before the steps that use it.
    if (reads.length) {
        if (lines[0]?.startsWith('Given ')) lines[0] = lines[0].replace(/^Given /, 'And ');
        lines.unshift(...reads.map((n, j) => `${j === 0 ? 'Given' : 'And'} the test data ${quoted(n)} is read`));
    }
    // The framework's external Examples for the file (CSBDDEngine / CSDataProvider options).
    const filter = dc.filter?.trim() || (dataColumns.includes('runFlag') ? 'runFlag=Yes' : '');
    const ex: Record<string, string> = { type: fmt, source: dataPath };
    if (fmt === 'json') ex.path = dc.path || '$.data[*]';
    if (sheet) ex.sheet = sheet;
    if (filter) ex.filter = filter;
    const examples = `{${Object.entries(ex).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ')}}`;
    const featurePath = `${ctx.featureFolder}/${slug}.feature`;
    const feature = `@recorded
Feature: ${recTitle}
  Recorded with CS Test Studio on ${new Date().toISOString().slice(0, 10)}.${outline ? `\n  Test data: ${dataPath} (${filter ? `rows with ${filter} run` : 'every row runs'}, one run per row).` : ''}

  ${outline ? `Scenario Outline: ${recTitle}${dataColumns.includes('testCaseId') ? ' - <testCaseId>' : ''}` : `Scenario: ${recTitle}`}
${lines.map((l) => `    ${l}`).join('\n')}
${outline ? `\n    Examples: ${examples}\n` : ''}`;
    files.unshift({ path: featurePath, kind: 'feature', change: ctx.files[featurePath] !== undefined ? 'update' : 'new', text: feature });

    if (!actions.length) warnings.push('Nothing recorded yet.');
    if (encrypt.length) warnings.push('Password-like values are written (to the data file or the environment\'s settings) as ENCRYPTED: values (the framework decrypts them). They keep passwords out of plain sight in Git, but the framework\'s key is in the package: for real secrets choose Studio secrets (and pipeline variables).');
    if (secrets.length) warnings.push(`Password-like values are Studio secrets (${secrets.map((s) => s.name).join(', ')}); in a pipeline, set them as pipeline variables.`);
    if ([...defs.values()].some((d) => d.upload)) warnings.push(`Upload steps read the files from ${ctx.dataFolder}/uploads: files uploaded while recording are copied there when the test is saved.`);
    return {
        files, rows, secrets, encrypt, warnings,
        pages: pages.map((p) => ({ name: p.name, className: p.className, existing: !!p.existing, file: p.file })),
        summary: { stepsReused, stepsNew: defs.size, elementsReused, elementsNew },
    };
}
