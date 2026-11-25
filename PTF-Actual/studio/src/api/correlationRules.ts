/**
 * Correlation rules for the frameworks web applications are built with: the values a page hands to the next request
 * that change for every user and visit (view state, anti-forgery tokens, session ids in links). Each rule finds the
 * value in a response (HTML, headers) as a regular expression whose first group is the value; the HAR import and
 * recordings use them besides the JSON and header values they find on their own.
 *   ASP.NET Web Forms: __VIEWSTATE, __EVENTVALIDATION, __VIEWSTATEGENERATOR, __PREVIOUSPAGE
 *   ASP.NET MVC / Core: __RequestVerificationToken
 *   JSF / Jakarta Faces: javax.faces.ViewState, jakarta.faces.ViewState
 *   Spring Security: _csrf (form field, meta tag)
 *   Oracle ADF: _adf.ctrl-state, Adf-Window-Id
 *   Siebel: SWEC, _sn (session number), SWETS
 *   SAP Fiori / OData: x-csrf-token (header), sap-contextid
 *   Django / Rails / Laravel: csrfmiddlewaretoken, authenticity_token, _token
 *   Any hidden form field
 * A left / right boundary (the text just before and just after a value) is the same as a rule of its own.
 */
export interface FoundValue { rule: string; key: string; value: string; kind: 'regex' | 'header'; path: string }
interface Rule { id: string; framework: string; find: (body: string, headers: Array<{ name: string; value: string }>) => FoundValue[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A regular expression for the text between `left` and `right` (the value is the first group). */
export function boundaryRegex(left: string, right: string): string {
    if (!left) throw new Error('A left boundary is needed.');
    return `${esc(left)}([\\s\\S]*?)${right ? esc(right) : '$'}`;
}

/** Input fields with a name and a value (attributes in any order, either quote). */
function inputs(body: string): Array<{ name: string; id?: string; value: string; type?: string }> {
    const out: Array<{ name: string; id?: string; value: string; type?: string }> = [];
    for (const m of body.matchAll(/<input\b([^>]*)>/gi)) {
        const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(m[1]);
        const name = attr('name'), value = attr('value');
        if (!name || !value) continue;
        out.push({ name: name[1] ?? name[2], value: value[1] ?? value[2], ...(attr('id') ? { id: attr('id')![1] ?? attr('id')![2] } : {}), ...(attr('type') ? { type: (attr('type')![1] ?? attr('type')![2]).toLowerCase() } : {}) });
    }
    return out;
}

/** A regex for a field's value by its name, whatever the order of its attributes. */
const fieldRegex = (name: string) => `<input\\b(?=[^>]*\\bname\\s*=\\s*["']${esc(name)}["'])[^>]*\\bvalue\\s*=\\s*["']([^"']*)["']`;
const named = (framework: string, names: RegExp, key: (n: string) => string): Rule => ({
    id: framework, framework,
    find: (body) => inputs(body).filter((i) => names.test(i.name)).map((i) => ({ rule: framework, key: key(i.name), value: i.value, kind: 'regex' as const, path: fieldRegex(i.name) })),
});

export const CORRELATION_RULES: Rule[] = [
    named('ASP.NET Web Forms', /^__(VIEWSTATE|EVENTVALIDATION|VIEWSTATEGENERATOR|PREVIOUSPAGE|VIEWSTATEENCRYPTED)$/, (n) => n.replace(/^__/, '').toLowerCase()),
    named('ASP.NET anti-forgery', /^__RequestVerificationToken$/, () => 'requestVerificationToken'),
    named('JSF view state', /^(javax|jakarta)\.faces\.ViewState$/, () => 'facesViewState'),
    named('Spring Security CSRF', /^_csrf$/, () => 'csrf'),
    named('Django / Rails / Laravel CSRF', /^(csrfmiddlewaretoken|authenticity_token|_token)$/, (n) => (n === '_token' ? 'laravelToken' : n === 'authenticity_token' ? 'authenticityToken' : 'csrfToken')),
    named('Oracle ADF', /^(_adf\.ctrl-state|Adf-Window-Id|javax\.faces\.ViewState)$/, (n) => (n.startsWith('_adf') ? 'adfCtrlState' : 'adfWindowId')),
    {
        id: 'Meta CSRF token', framework: 'CSRF meta tag',
        find: (body) => [...body.matchAll(/<meta\b(?=[^>]*\bname\s*=\s*["'](_csrf|csrf-token|csrf_token|X-CSRF-TOKEN)["'])[^>]*\bcontent\s*=\s*["']([^"']+)["']/gi)]
            .map((m) => ({ rule: 'CSRF meta tag', key: 'csrfToken', value: m[2], kind: 'regex' as const, path: `<meta\\b(?=[^>]*\\bname\\s*=\\s*["']${esc(m[1])}["'])[^>]*\\bcontent\\s*=\\s*["']([^"']+)["']` })),
    },
    {
        id: 'Siebel', framework: 'Siebel',
        find: (body) => {
            const out: FoundValue[] = [];
            for (const [re, key] of [[/[?&]SWEC=(\d+)/, 'swec'], [/[?&]_sn=([^&"'\s]+)/, 'siebelSession'], [/[?&]SWETS=(\d+)/, 'swets']] as const) {
                const m = re.exec(body);
                if (m) out.push({ rule: 'Siebel', key, value: m[1], kind: 'regex', path: re.source });
            }
            return out;
        },
    },
    {
        id: 'SAP Fiori', framework: 'SAP Fiori / OData',
        find: (body, headers) => [
            ...headers.filter((h) => /^x-csrf-token$/i.test(h.name) && !/^(fetch|required)$/i.test(h.value)).map((h) => ({ rule: 'SAP Fiori / OData', key: 'sapCsrfToken', value: h.value, kind: 'header' as const, path: h.name })),
            ...[...body.matchAll(/sap-contextid=([^;&"'\s]+)/g)].slice(0, 1).map((m) => ({ rule: 'SAP Fiori / OData', key: 'sapContextId', value: m[1], kind: 'regex' as const, path: 'sap-contextid=([^;&"\'\\s]+)' })),
        ],
    },
    {
        id: 'Hidden fields', framework: 'Hidden form field',
        find: (body) => inputs(body).filter((i) => i.type === 'hidden' && i.value.length >= 6 && !/^(true|false|\d{1,3})$/i.test(i.value)).map((i) => ({ rule: 'Hidden form field', key: i.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'hidden', value: i.value, kind: 'regex' as const, path: fieldRegex(i.name) })),
    },
];

/** Every value the rules find in a response (a value found by two rules: the more specific one). */
export function findByRules(body: string, headers: Array<{ name: string; value: string }>): FoundValue[] {
    const out: FoundValue[] = [];
    for (const r of CORRELATION_RULES) for (const f of r.find(body, headers)) if (!out.some((x) => x.value === f.value)) out.push(f);
    return out;
}
