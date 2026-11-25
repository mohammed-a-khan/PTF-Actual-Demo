/**
 * Code snippets: the request as it is sent (values filled, sign-in applied) in other languages and tools, to share
 * with developers or paste into a bug: cURL (bash, Windows cmd, PowerShell), HTTPie, Python requests, JavaScript
 * fetch and axios, Node.js, Java HttpClient, C# HttpClient, Go net/http, PHP cURL, Ruby Net::HTTP, Kotlin OkHttp,
 * Swift URLSession. A body that is not text (a file upload) is described, not written.
 */
export interface SnippetRequest { method: string; url: string; headers: Record<string, string>; body?: string | Buffer }
export type SnippetLang = 'curl' | 'curl-cmd' | 'powershell' | 'httpie' | 'python' | 'fetch' | 'axios' | 'node' | 'java' | 'csharp' | 'go' | 'php' | 'ruby' | 'kotlin' | 'swift';

export const SNIPPET_LANGS: Array<{ id: SnippetLang; label: string; mode: string }> = [
    { id: 'curl', label: 'cURL (bash)', mode: 'shell' }, { id: 'curl-cmd', label: 'cURL (Windows cmd)', mode: 'shell' }, { id: 'powershell', label: 'PowerShell', mode: 'powershell' },
    { id: 'httpie', label: 'HTTPie', mode: 'shell' }, { id: 'python', label: 'Python (requests)', mode: 'python' }, { id: 'fetch', label: 'JavaScript (fetch)', mode: 'javascript' },
    { id: 'axios', label: 'JavaScript (axios)', mode: 'javascript' }, { id: 'node', label: 'Node.js (https)', mode: 'javascript' }, { id: 'java', label: 'Java (HttpClient)', mode: 'java' },
    { id: 'csharp', label: 'C# (HttpClient)', mode: 'csharp' }, { id: 'go', label: 'Go (net/http)', mode: 'go' }, { id: 'php', label: 'PHP (cURL)', mode: 'php' },
    { id: 'ruby', label: 'Ruby (Net::HTTP)', mode: 'ruby' }, { id: 'kotlin', label: 'Kotlin (OkHttp)', mode: 'kotlin' }, { id: 'swift', label: 'Swift (URLSession)', mode: 'swift' },
];

/** Headers the client sets itself. */
const SKIP = /^(content-length|host|connection|accept-encoding)$/i;

const js = (s: string) => JSON.stringify(s);
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
const cmdq = (s: string) => `"${s.replace(/"/g, '""').replace(/%/g, '%%')}"`;
const php = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const rb = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const javaStr = (s: string) => js(s);
const goStr = (s: string) => (s.includes('`') ? js(s) : `\`${s}\``);
const kt = (s: string) => `"""${s.replace(/\$/g, '${"$"}').replace(/"""/g, '""\\"')}"""`;
const swift = (s: string) => `#"""\n${s}\n"""#`;
const py = (s: string) => (s.includes('\n') ? `'''${s.replace(/\\/g, '\\\\').replace(/'''/g, "\\'\\'\\'")}'''` : js(s));

export function snippet(lang: SnippetLang, r: SnippetRequest): string {
    const method = r.method.toUpperCase();
    const headers = Object.entries(r.headers).filter(([k]) => !SKIP.test(k));
    const binary = Buffer.isBuffer(r.body);
    const body = binary ? undefined : (r.body as string | undefined);
    const note = binary ? `A ${(r.body as Buffer).length}-byte body (a file upload) is not written here: add it in your code.` : '';
    const comment = (c: string) => (note ? `${c} ${note}\n` : '');
    const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
    switch (lang) {
        case 'curl': return `${comment('#')}curl -X ${method} ${sq(r.url)}${headers.map(([k, v]) => ` \\\n  -H ${sq(`${k}: ${v}`)}`).join('')}${body !== undefined ? ` \\\n  --data-raw ${sq(body)}` : ''}`;
        case 'curl-cmd': return `${comment('REM')}curl -X ${method} ${cmdq(r.url)}${headers.map(([k, v]) => ` ^\n  -H ${cmdq(`${k}: ${v}`)}`).join('')}${body !== undefined ? ` ^\n  --data-raw ${cmdq(body.replace(/\r?\n/g, ' '))}` : ''}`;
        case 'powershell': return `${comment('#')}$headers = @{\n${headers.map(([k, v]) => `    ${ps(k)} = ${ps(v)}`).join('\n')}\n}\n${body !== undefined ? `$body = @'\n${body}\n'@\n` : ''}$response = Invoke-WebRequest -Uri ${ps(r.url)} -Method ${method[0] + method.slice(1).toLowerCase()} -Headers $headers${body !== undefined ? ' -Body $body' : ''}${ct ? ` -ContentType ${ps(ct)}` : ''}\n$response.StatusCode\n$response.Content`;
        case 'httpie': return `${comment('#')}${body !== undefined ? `printf '%s' ${sq(body)} | ` : ''}http ${method} ${sq(r.url)}${headers.map(([k, v]) => ` ${sq(`${k}:${v}`)}`).join('')}`;
        case 'python': return `${comment('#')}import requests\n\nurl = ${js(r.url)}\nheaders = {\n${headers.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n}\n${body !== undefined ? `data = ${py(body)}\n` : ''}\nresponse = requests.request(${js(method)}, url, headers=headers${body !== undefined ? ', data=data.encode("utf-8")' : ''}, timeout=30)\nprint(response.status_code)\nprint(response.text)`;
        case 'fetch': return `${comment('//')}const response = await fetch(${js(r.url)}, {\n  method: ${js(method)},\n  headers: {\n${headers.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n  },${body !== undefined ? `\n  body: ${js(body)},` : ''}\n});\nconsole.log(response.status);\nconsole.log(await response.text());`;
        case 'axios': return `${comment('//')}import axios from 'axios';\n\nconst response = await axios.request({\n  method: ${js(method.toLowerCase())},\n  url: ${js(r.url)},\n  headers: {\n${headers.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n  },${body !== undefined ? `\n  data: ${js(body)},` : ''}\n  validateStatus: () => true,\n  transformResponse: (x) => x,\n});\nconsole.log(response.status);\nconsole.log(response.data);`;
        case 'node': {
            const u = (() => { try { return new URL(r.url); } catch { return null; } })();
            const mod = u?.protocol === 'http:' ? 'http' : 'https';
            return `${comment('//')}const ${mod} = require('${mod}');\n\nconst req = ${mod}.request(${js(r.url)}, {\n  method: ${js(method)},\n  headers: {\n${headers.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n  },\n}, (res) => {\n  let data = '';\n  res.on('data', (chunk) => (data += chunk));\n  res.on('end', () => { console.log(res.statusCode); console.log(data); });\n});\nreq.on('error', (e) => console.error(e));\n${body !== undefined ? `req.write(${js(body)});\n` : ''}req.end();`;
        }
        case 'java': return `${comment('//')}import java.net.URI;\nimport java.net.http.HttpClient;\nimport java.net.http.HttpRequest;\nimport java.net.http.HttpResponse;\n\npublic class Main {\n    public static void main(String[] args) throws Exception {\n        HttpClient client = HttpClient.newHttpClient();\n        HttpRequest request = HttpRequest.newBuilder()\n            .uri(URI.create(${javaStr(r.url)}))\n${headers.map(([k, v]) => `            .header(${javaStr(k)}, ${javaStr(v)})\n`).join('')}            .method(${javaStr(method)}, ${body !== undefined ? `HttpRequest.BodyPublishers.ofString(${javaStr(body)})` : 'HttpRequest.BodyPublishers.noBody()'})\n            .build();\n        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());\n        System.out.println(response.statusCode());\n        System.out.println(response.body());\n    }\n}`;
        case 'csharp': {
            const content = headers.filter(([k]) => /^content-/i.test(k));
            const others = headers.filter(([k]) => !/^content-/i.test(k));
            return `${comment('//')}using var client = new HttpClient();\nvar request = new HttpRequestMessage(new HttpMethod(${js(method)}), ${js(r.url)});\n${others.map(([k, v]) => `request.Headers.TryAddWithoutValidation(${js(k)}, ${js(v)});\n`).join('')}${body !== undefined ? `request.Content = new StringContent(${js(body)});\n${content.map(([k, v]) => `request.Content.Headers.Remove(${js(k)});\nrequest.Content.Headers.TryAddWithoutValidation(${js(k)}, ${js(v)});\n`).join('')}` : ''}var response = await client.SendAsync(request);\nConsole.WriteLine((int)response.StatusCode);\nConsole.WriteLine(await response.Content.ReadAsStringAsync());`;
        }
        case 'go': return `${comment('//')}package main\n\nimport (\n\t"fmt"\n\t"io"\n\t"net/http"\n${body !== undefined ? '\t"strings"\n' : ''})\n\nfunc main() {\n\treq, err := http.NewRequest(${js(method)}, ${js(r.url)}, ${body !== undefined ? `strings.NewReader(${goStr(body)})` : 'nil'})\n\tif err != nil {\n\t\tpanic(err)\n\t}\n${headers.map(([k, v]) => `\treq.Header.Set(${js(k)}, ${js(v)})\n`).join('')}\tres, err := http.DefaultClient.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer res.Body.Close()\n\tdata, _ := io.ReadAll(res.Body)\n\tfmt.Println(res.StatusCode)\n\tfmt.Println(string(data))\n}`;
        case 'php': return `<?php\n${comment('//')}$ch = curl_init(${php(r.url)});\ncurl_setopt_array($ch, [\n    CURLOPT_CUSTOMREQUEST => ${php(method)},\n    CURLOPT_RETURNTRANSFER => true,\n    CURLOPT_HTTPHEADER => [\n${headers.map(([k, v]) => `        ${php(`${k}: ${v}`)},`).join('\n')}\n    ],${body !== undefined ? `\n    CURLOPT_POSTFIELDS => ${php(body)},` : ''}\n]);\n$body = curl_exec($ch);\necho curl_getinfo($ch, CURLINFO_RESPONSE_CODE), "\\n", $body, "\\n";\ncurl_close($ch);`;
        case 'ruby': {
            const cls = { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete', HEAD: 'Head', OPTIONS: 'Options' }[method];
            return `${comment('#')}require 'net/http'\nrequire 'uri'\n\nuri = URI(${rb(r.url)})\nhttp = Net::HTTP.new(uri.host, uri.port)\nhttp.use_ssl = uri.scheme == 'https'\nrequest = ${cls ? `Net::HTTP::${cls}.new(uri)` : `Net::HTTPGenericRequest.new(${rb(method)}, true, true, uri)`}\n${headers.map(([k, v]) => `request[${rb(k)}] = ${rb(v)}\n`).join('')}${body !== undefined ? `request.body = ${rb(body)}\n` : ''}response = http.request(request)\nputs response.code\nputs response.body`;
        }
        case 'kotlin': return `${comment('//')}import okhttp3.OkHttpClient\nimport okhttp3.Request\nimport okhttp3.RequestBody.Companion.toRequestBody\n\nval client = OkHttpClient()\nval request = Request.Builder()\n    .url(${js(r.url)})\n${headers.map(([k, v]) => `    .addHeader(${js(k)}, ${js(v)})\n`).join('')}    .method(${js(method)}, ${body !== undefined ? `${kt(body)}.toRequestBody()` : 'null'})\n    .build()\nclient.newCall(request).execute().use { response ->\n    println(response.code)\n    println(response.body?.string())\n}`;
        case 'swift': return `${comment('//')}import Foundation\n\nvar request = URLRequest(url: URL(string: ${js(r.url)})!)\nrequest.httpMethod = ${js(method)}\n${headers.map(([k, v]) => `request.setValue(${js(v)}, forHTTPHeaderField: ${js(k)})\n`).join('')}${body !== undefined ? `request.httpBody = ${swift(body)}.data(using: .utf8)\n` : ''}let (data, response) = try await URLSession.shared.data(for: request)\nprint((response as! HTTPURLResponse).statusCode)\nprint(String(decoding: data, as: UTF8.self))`;
    }
}
