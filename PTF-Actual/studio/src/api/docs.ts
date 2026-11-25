/**
 * Documentation of a collection: every request (grouped as the folders are) with its description, method and address,
 * parameters, headers, body, sign-in, what it is expected to answer (its checks) and its saved examples. A
 * self-contained HTML page (nothing loaded from elsewhere; a pipeline artifact to open in a browser) and Markdown
 * (an Azure DevOps wiki page, a README). Secret values never appear: the collection holds references only ({env:NAME}).
 */
import { ApiAuth, ApiCollection, ApiItem, ApiRequest } from './model';
import { expectedText } from './feature';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const anchor = (s: string) => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const on = <T extends { enabled?: boolean; key: string }>(a: T[] | undefined) => (a ?? []).filter((x) => x.enabled !== false && x.key);

function authText(a: ApiAuth, c: ApiCollection): string {
    const x = a.type === 'inherit' ? c.auth : a;
    switch (x.type) {
        case 'none': case 'inherit': return 'None';
        case 'basic': return 'Basic (user name and password)';
        case 'bearer': return 'Bearer token';
        case 'apikey': return `API key in the ${x.in === 'query' ? 'query parameter' : 'header'} ${x.key ?? ''}`;
        case 'oauth2': return `OAuth 2.0 (${(x.grant ?? 'client_credentials').replace(/_/g, ' ')}${x.scope ? `, scope ${x.scope}` : ''})`;
        case 'aws': return `AWS Signature v4 (${x.service ?? ''} in ${x.region ?? ''})`;
        case 'negotiate': return 'Kerberos (Windows sign-in)';
        default: return x.type.toUpperCase();
    }
}

const bodyText = (r: ApiRequest): { lang: string; text: string } | null => {
    const b = r.body;
    if (b.mode === 'graphql') return { lang: 'graphql', text: `${b.graphql?.query ?? ''}${b.graphql?.variables?.trim() ? `\n\n# variables\n${b.graphql.variables}` : ''}` };
    if (b.mode === 'form') return { lang: 'text', text: on(b.form).map((f) => `${f.key}=${f.value}`).join('&') };
    if (b.mode === 'multipart') return { lang: 'text', text: (b.parts ?? []).filter((p) => p.enabled !== false).map((p) => `${p.key}: ${p.type === 'file' ? `(file ${p.value})` : p.value}`).join('\n') };
    if (b.mode === 'file') return { lang: 'text', text: `(payload template ${b.file ?? ''})` };
    if (b.mode === 'none' || !b.text?.trim()) return null;
    let t = b.text;
    if (b.mode === 'json') { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch { /* {{vars}} */ } }
    return { lang: b.mode, text: t };
};

const checkText = (ch: ApiRequest['checks'][number]): string => {
    if (ch.kind === 'status') return `Status ${ch.value}`;
    if (ch.kind === 'script') return `Script: ${ch.target ?? ''}`;
    const t = ch.target ?? '', v = ch.value ?? '';
    switch (ch.kind) {
        case 'statusBetween': return `Status ${ch.min ?? 200}–${ch.max ?? 299}`;
        case 'jsonExists': return `${t || '$'} is present`;
        case 'jsonEquals': return `${t || '$'} is ${v}`;
        case 'jsonNotContains': return `${t || '$'} does not contain "${v}"`;
        case 'bodyContains': return `The body contains "${v}"`;
        case 'bodyNotContains': return `The body does not contain "${v}"`;
        case 'bodyEmpty': return 'The body is empty';
        case 'headerExists': return `Header ${t} is present`;
        case 'headerEquals': return `Header ${t} is "${v}"`;
        case 'headerContains': return `Header ${t} contains "${v}"`;
        case 'timeBelow': return `Answers within ${v} ms`;
        case 'schema': return ch.schemaFile ? `The body matches the schema ${ch.schemaFile}` : 'The body matches a JSON schema';
        case 'dbItems': return 'Each item matches the database rows';
        default: break;
    }
    const e = (ch as { expected?: unknown }).expected;
    return `${ch.kind}${ch.target ? ` ${ch.target}` : ''}${ch.value ? ` ${ch.value}` : ''}${e ? ` ${expectedText(e as never)}` : ''}`.trim();
};

interface Entry { r: ApiRequest; path: string[] }
const flatten = (items: ApiItem[], path: string[] = []): Entry[] => items.flatMap((x) => (x.kind === 'folder' ? flatten(x.items, [...path, x.name]) : [{ r: x, path }]));
const urlOf = (r: ApiRequest) => {
    const q = on(r.query);
    return `${r.url}${q.length ? `${r.url.includes('?') ? '&' : '?'}${q.map((x) => `${x.key}=${x.value}`).join('&')}` : ''}`;
};
const methodOf = (r: ApiRequest) => (r.ws ? (r.ws.protocol ?? 'websocket').toUpperCase().replace('WEBSOCKET', 'WS').replace('SOCKETIO', 'SOCKET.IO') : r.method);

export function collectionMarkdown(c: ApiCollection): string {
    const all = flatten(c.items);
    const out: string[] = [`# ${c.name}`, ''];
    if (c.description) out.push(c.description, '');
    out.push(`**Base URL:** \`${c.baseUrl || '(each request has its own)'}\`  `, `**Sign-in:** ${authText({ type: 'inherit' }, c)}  `, `**Requests:** ${all.length}`, '');
    if (c.variables.length) out.push('| Variable | Value |', '|---|---|', ...c.variables.filter((v) => v.enabled !== false).map((v) => `| \`{{${v.key}}}\` | ${v.secret ? '(secret)' : `\`${v.value.replace(/\|/g, '\\|')}\``} |`), '');
    out.push('## Contents', '', ...all.map((e) => `- ${e.path.length ? `${e.path.join(' / ')} / ` : ''}[${e.r.name}](#${anchor(e.r.name)})`), '');
    let folderShown = '';
    for (const { r, path } of all) {
        const f = path.join(' / ');
        if (f && f !== folderShown) { out.push(`## ${f}`, ''); folderShown = f; }
        out.push(`### ${r.name}`, '', `\`${methodOf(r)} ${urlOf(r)}\``, '');
        if (r.description) out.push(r.description, '');
        const hs = on(r.headers);
        if (hs.length) out.push('| Header | Value |', '|---|---|', ...hs.map((h) => `| ${h.key} | \`${h.value.replace(/\|/g, '\\|')}\` |`), '');
        if (r.auth.type !== 'inherit') out.push(`**Sign-in:** ${authText(r.auth, c)}`, '');
        const b = bodyText(r);
        if (b) out.push('**Body**', '', `\`\`\`${b.lang}`, b.text, '```', '');
        if (r.ws) out.push('**Messages**', '', ...r.ws.steps.map((s, i) => `${i + 1}. ${s.kind === 'send' ? 'Send' : 'Expect'}${s.topic ? ` (${s.topic})` : ''}: \`${s.text || '(any message)'}\``), '');
        if (r.checks.length) out.push('**Expected**', '', ...r.checks.map((ch) => `- ${checkText(ch)}`), '');
        if (r.extract.length) out.push(`**Saves** ${r.extract.map((e) => `\`{{${e.variable}}}\` from ${e.from} ${e.path}`).join(', ')}`, '');
        for (const ex of r.examples ?? []) {
            out.push(`**Example: ${ex.name}** (${ex.status}${ex.when?.query ? `, for ${Object.entries(ex.when.query).map(([k, v]) => `${k}=${v}`).join('&')}` : ''})`, '');
            if (ex.body) { let t = ex.body; try { t = JSON.stringify(JSON.parse(t), null, 2); } catch { /* text */ } out.push('```', t.length > 4000 ? `${t.slice(0, 4000)}\n…` : t, '```', ''); }
        }
    }
    return out.join('\n');
}

export function collectionHtml(c: ApiCollection): string {
    const all = flatten(c.items);
    const color: Record<string, string> = { GET: '#1a7f37', POST: '#9a6700', PUT: '#0969da', PATCH: '#8250df', DELETE: '#cf222e' };
    const nav = all.map((e) => `<a href="#${anchor(e.r.name)}"><b style="color:${color[methodOf(e.r)] ?? '#57606a'}">${esc(methodOf(e.r))}</b> ${esc(e.r.name)}${e.path.length ? `<i>${esc(e.path.join(' / '))}</i>` : ''}</a>`).join('');
    const sections = all.map(({ r, path }) => {
        const hs = on(r.headers), b = bodyText(r);
        return `<section id="${anchor(r.name)}">
<h2>${esc(r.name)}</h2>${path.length ? `<div class="folder">${esc(path.join(' / '))}</div>` : ''}
<div class="url"><b style="background:${color[methodOf(r)] ?? '#57606a'}">${esc(methodOf(r))}</b><code>${esc(urlOf(r))}</code></div>
${r.description ? `<p>${esc(r.description).replace(/\n/g, '<br>')}</p>` : ''}
${hs.length ? `<h4>Headers</h4><table>${hs.map((h) => `<tr><td>${esc(h.key)}</td><td><code>${esc(h.value)}</code></td></tr>`).join('')}</table>` : ''}
${r.auth.type !== 'inherit' ? `<h4>Sign-in</h4><p>${esc(authText(r.auth, c))}</p>` : ''}
${b ? `<h4>Body</h4><pre>${esc(b.text)}</pre>` : ''}
${r.ws ? `<h4>Messages</h4><ol>${r.ws.steps.map((s) => `<li>${s.kind === 'send' ? 'Send' : 'Expect'}${s.topic ? ` <i>(${esc(s.topic)})</i>` : ''}: <code>${esc(s.text || '(any message)')}</code></li>`).join('')}</ol>` : ''}
${r.checks.length ? `<h4>Expected</h4><ul>${r.checks.map((ch) => `<li>${esc(checkText(ch))}</li>`).join('')}</ul>` : ''}
${r.extract.length ? `<h4>Saves</h4><ul>${r.extract.map((e) => `<li><code>{{${esc(e.variable)}}}</code> from ${esc(e.from)} ${esc(e.path)}</li>`).join('')}</ul>` : ''}
${(r.examples ?? []).map((ex) => { let t = ex.body ?? ''; try { t = JSON.stringify(JSON.parse(t), null, 2); } catch { /* text */ } return `<h4>Example: ${esc(ex.name)} <span class="st">${ex.status}</span></h4>${t ? `<pre>${esc(t.length > 8000 ? `${t.slice(0, 8000)}\n…` : t)}</pre>` : ''}`; }).join('')}
</section>`;
    }).join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.name)} — API</title><style>
:root{--fg:#1f2328;--mute:#57606a;--line:#d0d7de;--bg:#fff;--code:#f6f8fa}@media(prefers-color-scheme:dark){:root{--fg:#e6edf3;--mute:#8d96a0;--line:#30363d;--bg:#0d1117;--code:#161b22}}
*{box-sizing:border-box}body{margin:0;font:14px/1.55 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:var(--fg);background:var(--bg);display:flex}
nav{position:sticky;top:0;height:100vh;overflow:auto;width:300px;flex:none;border-right:1px solid var(--line);padding:16px}nav a{display:block;padding:4px 6px;color:var(--fg);text-decoration:none;border-radius:4px;font-size:13px}nav a:hover{background:var(--code)}nav i{display:block;color:var(--mute);font-size:11px;font-style:normal}
main{flex:1;min-width:0;padding:24px 32px;max-width:1000px}h1{margin:0 0 4px}section{border-top:1px solid var(--line);padding:18px 0}h2{margin:0 0 4px;font-size:19px}h4{margin:14px 0 4px;font-size:13px;text-transform:uppercase;color:var(--mute)}
.folder{color:var(--mute);font-size:12px}.url{display:flex;gap:8px;align-items:center;margin:8px 0}.url b{color:#fff;border-radius:4px;padding:1px 7px;font-size:12px}code,pre{font:12px ui-monospace,Consolas,monospace;background:var(--code)}code{padding:1px 4px;border-radius:4px;word-break:break-all}
pre{padding:10px;border-radius:6px;overflow:auto;max-height:420px}table{border-collapse:collapse}td{border:1px solid var(--line);padding:4px 8px;vertical-align:top}.st{background:var(--code);border-radius:4px;padding:0 6px;font-size:12px}.meta{color:var(--mute)}
@media(max-width:760px){body{display:block}nav{position:static;height:auto;width:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:16px}}</style></head><body>
<nav><b>${esc(c.name)}</b>${nav}</nav><main><h1>${esc(c.name)}</h1>
<p class="meta">Base URL <code>${esc(c.baseUrl || '(each request has its own)')}</code> · Sign-in: ${esc(authText({ type: 'inherit' }, c))} · ${all.length} request${all.length === 1 ? '' : 's'}</p>
${c.description ? `<p>${esc(c.description).replace(/\n/g, '<br>')}</p>` : ''}
${c.variables.length ? `<h4>Variables</h4><table>${c.variables.filter((v) => v.enabled !== false).map((v) => `<tr><td><code>{{${esc(v.key)}}}</code></td><td>${v.secret ? '<i>(secret)</i>' : `<code>${esc(v.value)}</code>`}</td></tr>`).join('')}</table>` : ''}
${sections}</main></body></html>`;
}

