/**
 * A cURL command → a request (what "Copy as cURL" gives in browsers, API clients and API docs).
 * Handles bash quoting ('…', "…", $'…', \ line ends) and Windows cmd (^ line ends, ^" quotes).
 * Options: -X/--request, -H/--header, -d/--data/--data-raw/--data-binary/--data-ascii,
 * --data-urlencode, --json, -u/--user, -b/--cookie, -G/--get, -I/--head, --url, -F/--form (multipart: text
 * fields and file fields). Options that only affect curl itself (-s, -k, -L, --compressed, …) are ignored.
 */
import { ApiRequest, httpMethod, KV, MultipartPart, newRequest } from './model';

export function tokenize(cmd: string): string[] {
    // Windows cmd: ^ escapes, "^" line continuations.
    let s = cmd.replace(/\r\n?/g, '\n');
    if (/\^\n/.test(s) || /\^"/.test(s)) s = s.replace(/\^\n/g, ' ').replace(/\^(.)/g, '$1');
    s = s.replace(/\\\n/g, ' ');
    const out: string[] = [];
    let cur = '', inTok = false, i = 0;
    const push = () => { if (inTok) out.push(cur); cur = ''; inTok = false; };
    while (i < s.length) {
        const ch = s[i];
        if (/\s/.test(ch)) { push(); i++; continue; }
        inTok = true;
        if (ch === "'") { const j = s.indexOf("'", i + 1); if (j < 0) throw new Error('A quote (\') is not closed.'); cur += s.slice(i + 1, j); i = j + 1; continue; }
        if (ch === '$' && s[i + 1] === "'") {
            let j = i + 2;
            while (j < s.length && s[j] !== "'") { if (s[j] === '\\') { const n = s[j + 1]; cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n; j += 2; } else cur += s[j++]; }
            i = j + 1; continue;
        }
        if (ch === '"') {
            let j = i + 1;
            while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && /["\\$`]/.test(s[j + 1])) { cur += s[j + 1]; j += 2; } else cur += s[j++]; }
            if (j >= s.length) throw new Error('A quote (") is not closed.');
            i = j + 1; continue;
        }
        if (ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
        cur += ch; i++;
    }
    push();
    return out;
}

export function parseCurl(cmd: string): { request: ApiRequest; warnings: string[] } {
    const t = tokenize(cmd.trim());
    if (!t.length || !/^curl(\.exe)?$/i.test(t[0])) throw new Error('This does not start with "curl".');
    const r = newRequest('Imported from cURL');
    r.checks = [{ kind: 'statusBetween', min: 200, max: 299 }];
    const warnings: string[] = [];
    let method: string | null = null, url = '', get = false, head = false, json = false;
    const data: string[] = [];
    const urlencoded: string[] = [];
    const form: MultipartPart[] = [];
    const takesValue = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json', '-u', '--user', '-b', '--cookie', '--url', '-F', '--form', '--form-string', '-A', '--user-agent', '-e', '--referer', '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--cacert', '--cert', '--key', '-w', '--write-out', '-c', '--cookie-jar', '--retry']);
    for (let i = 1; i < t.length; i++) {
        let a = t[i];
        let v: string | undefined;
        const eq = /^(--[\w-]+)=(.*)$/s.exec(a);
        if (eq) { a = eq[1]; v = eq[2]; }
        else if (/^-[A-Za-z]./.test(a) && takesValue.has(a.slice(0, 2))) { v = a.slice(2); a = a.slice(0, 2); }
        if (takesValue.has(a) && v === undefined) v = t[++i] ?? '';
        switch (a) {
            case '-X': case '--request': method = (v ?? '').toUpperCase(); break;
            case '-H': case '--header': {
                const m = /^([^:]+):\s?(.*)$/s.exec(v ?? '');
                if (m) r.headers.push({ key: m[1].trim(), value: m[2] });
                break;
            }
            case '-d': case '--data': case '--data-raw': case '--data-binary': case '--data-ascii':
                if ((v ?? '').startsWith('@') && a !== '--data-raw') warnings.push(`The body is read from a file (${v}); paste the file's content into the body.`);
                data.push(v ?? ''); break;
            case '--json': data.push(v ?? ''); json = true; break;
            case '--data-urlencode': {
                const m = /^([^=]*)=(.*)$/s.exec(v ?? '');
                urlencoded.push(m ? `${m[1]}=${encodeURIComponent(m[2])}` : encodeURIComponent(v ?? ''));
                break;
            }
            case '-u': case '--user': { const [u, ...p] = (v ?? '').split(':'); r.auth = { type: 'basic', username: u, password: p.join(':') }; break; }
            case '-b': case '--cookie': if (!(v ?? '').includes('=')) warnings.push('Cookies read from a file are not imported.'); else r.headers.push({ key: 'Cookie', value: v ?? '' }); break;
            case '-A': case '--user-agent': r.headers.push({ key: 'User-Agent', value: v ?? '' }); break;
            case '-e': case '--referer': r.headers.push({ key: 'Referer', value: v ?? '' }); break;
            case '--form-string': {
                // Taken as written: a value starting with @ or < is text, not a file.
                const m = /^([^=]+)=(.*)$/s.exec(v ?? '');
                if (m) form.push({ key: m[1], value: m[2], type: 'text' }); else if (v) warnings.push(`The form field "${v}" has no "=" and is not imported.`);
                break;
            }
            case '-F': case '--form': {
                const m = /^([^=]+)=(.*)$/s.exec(v ?? '');
                if (m && m[2].startsWith('<')) {
                    // <file: the part's text is read from that file.
                    const file = m[2].slice(1).split(';')[0];
                    form.push({ key: m[1], value: '', type: 'text' });
                    warnings.push(`The form field "${m[1]}" takes its text from ${file}: paste the text into the part.`);
                } else if (m && m[2].startsWith('@')) {
                    // A file: the part is kept; the file itself is chosen from the project (a payload file).
                    const file = m[2].slice(1).split(';')[0].replace(/^"(.*)"$/s, '$1');
                    form.push({ key: m[1], value: /^([a-zA-Z]:|[\\/~])/.test(file) || file.split(/[\\/]/).includes('..') ? file.split(/[\\/]/).pop() ?? file : file.replace(/\\/g, '/'), type: 'file' });
                    warnings.push(`The file field "${m[1]}" (${file}): put the file in the project's payload folder and choose it in the body (multipart).`);
                } else if (m) {
                    // name=value;type=…;filename=…: curl's options for the part, not part of the value.
                    const val = m[2].replace(/^"(.*)"$/s, '$1').replace(/;(type|filename|headers|encoder)=[^;]*$/i, '').replace(/;(type|filename|headers|encoder)=[^;]*$/i, '');
                    form.push({ key: m[1], value: val, type: 'text' });
                }
                else if (v) warnings.push(`The form field "${v}" has no "=" and is not imported.`);
                break;
            }
            case '-G': case '--get': get = true; break;
            case '-I': case '--head': head = true; break;
            case '--url': url = v ?? ''; break;
            default:
                if (takesValue.has(a)) break; // ignored option with its value
                if (a.startsWith('-')) break; // ignored flag (-s, -k, -L, --compressed, …)
                if (!url) url = a;
        }
    }
    if (!url) throw new Error('No URL found in the cURL command.');
    const body = [...data, ...urlencoded].join('&');
    const q = url.indexOf('?');
    r.url = q >= 0 ? url.slice(0, q) : url;
    if (q >= 0) r.query = parseQuery(url.slice(q + 1));
    // curl refuses -G with -F (a form cannot go in the address): the form is kept, -G is left out.
    if (get && form.length) { warnings.push('-G (send the data in the address) cannot be used with -F (a form): the form is sent as the body and -G is left out.'); get = false; }
    if (get && body) { r.query.push(...parseQuery(body)); }
    else if (form.length) {
        // -F is multipart/form-data, sent with POST (curl sets the content type and its boundary).
        r.body = { mode: 'multipart', parts: form };
        r.headers = r.headers.filter((h) => !/^multipart\//i.test(h.value) || h.key.toLowerCase() !== 'content-type');
        if (body) warnings.push('Both -F and -d are given (curl refuses this); the -d data is not imported.');
    }
    else if (body) {
        const ct = r.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
        if (json || /json/i.test(ct) || (!ct && /^\s*[[{]/.test(body))) {
            r.body = { mode: 'json', text: body };
            if (json && !ct) r.headers.push({ key: 'Content-Type', value: 'application/json' }, { key: 'Accept', value: 'application/json' });
        } else if (/xml/i.test(ct)) r.body = { mode: 'xml', text: body };
        else if (/x-www-form-urlencoded/i.test(ct) || (!ct && /^[\w.%-]+=/.test(body))) {
            r.body = { mode: 'form', form: parseQuery(body) };
            r.headers = r.headers.filter((h) => h.key.toLowerCase() !== 'content-type');
        } else r.body = { mode: 'text', text: body };
    }
    const asked = method ?? (head ? 'HEAD' : (body || form.length) && !get ? 'POST' : 'GET');
    const m = httpMethod(asked);
    if (!m) throw new Error(`"${asked}" is not an HTTP method.`);
    r.method = m;
    // A name from the method and the last part of the path.
    try { const p = new URL(r.url.replace(/\{\{[^}]+\}\}/g, 'x')).pathname.split('/').filter(Boolean); r.name = `${m} ${p.slice(-2).join('/') || new URL(r.url).host}`; } catch { r.name = `${m} request`; }
    return { request: r, warnings };
}

function parseQuery(s: string): KV[] {
    const dec = (x: string) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
    return s.split('&').filter(Boolean).map((p) => { const [k, v = ''] = p.split(/=(.*)/s); return { key: dec(k), value: dec(v) }; });
}
