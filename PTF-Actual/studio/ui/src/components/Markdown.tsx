/**
 * The Markdown Azure DevOps comments and descriptions use: headings, paragraphs, **bold**,
 * *italic*, `code`, code blocks, lists, tables and links. Rendered with React elements only (no
 * HTML strings), so nothing in a comment can run in the Studio. Links open only http(s) addresses.
 */
import React from 'react';

function inline(text: string, key: string): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    // `code`, **bold**, *italic* / _italic_, [text](https://…), bare https:// links
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+)/g;
    let last = 0, m: RegExpExecArray | null, i = 0;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const k = `${key}-${i++}`;
        if (m[1]) out.push(<code key={k} className="md-code">{m[1].slice(1, -1)}</code>);
        else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
        else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>);
        else if (m[4]) out.push(<a key={k} href={m[5]} target="_blank" rel="noreferrer noopener">{m[4].slice(1, m[4].indexOf(']'))}</a>);
        else if (m[6]) out.push(<a key={k} href={m[6]} target="_blank" rel="noreferrer noopener">{m[6]}</a>);
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());

export function Markdown({ text }: { text: string }) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const blocks: React.ReactNode[] = [];
    let i = 0, b = 0;
    while (i < lines.length) {
        const l = lines[i];
        const key = `b${b++}`;
        if (/^```/.test(l)) {
            const body: string[] = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
            i++;
            blocks.push(<pre key={key} className="md-pre">{body.join('\n')}</pre>);
            continue;
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(l);
        if (h) { const Tag = `h${Math.min(6, h[1].length + 2)}` as 'h3'; blocks.push(<Tag key={key} className="md-h">{inline(h[2], key)}</Tag>); i++; continue; }
        if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
            const head = cells(l);
            i += 2;
            const rows: string[][] = [];
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
            blocks.push(<table key={key} className="md-table"><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${key}h${j}`)}</th>)}</tr></thead>
                <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>)}</tr>)}</tbody></table>);
            continue;
        }
        if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
            const ordered = /^\s*\d+\./.test(l);
            const items: string[] = [];
            while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
            const List = ordered ? 'ol' : 'ul';
            blocks.push(<List key={key} className="md-list">{items.map((it, j) => <li key={j}>{inline(it, `${key}i${j}`)}</li>)}</List>);
            continue;
        }
        if (!l.trim()) { i++; continue; }
        const para: string[] = [];
        while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s+)/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
        blocks.push(<p key={key} className="md-p">{para.map((p, j) => <React.Fragment key={j}>{j > 0 && <br />}{inline(p, `${key}p${j}`)}</React.Fragment>)}</p>);
    }
    return <div className="md">{blocks}</div>;
}
