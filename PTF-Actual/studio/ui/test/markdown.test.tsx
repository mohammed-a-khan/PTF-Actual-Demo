/**
 * The Markdown shown for pull request comments and descriptions (ui/src/components/Markdown.tsx).
 * Bundled with esbuild (installed with Vite) and run with node --test: see "test:ui".
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/components/Markdown';
const html = (t: string) => renderToStaticMarkup(<Markdown text={t} />);
const check = (name: string, fn: () => void) => test(`Markdown: ${name}`, fn);
check('headings, bold, code', () => {
    const h = html('### ❌ Test results\nTested at `a78bf33b` with **13 scenarios**.');
    assert.match(h, /<h5 class="md-h">❌ Test results<\/h5>/);
    assert.match(h, /<code class="md-code">a78bf33b<\/code>/);
    assert.match(h, /<strong>13 scenarios<\/strong>/);
});
check('table with an escaped pipe in a cell', () => {
    const h = html('| | Scenario | Time |\n|---|---|---|\n| ✅ | Login \\| works | 1.2 s |\n| ❌ | Dash | 9 s |');
    assert.match(h, /<table class="md-table">/);
    assert.match(h, /<td>Login \| works<\/td>/);
    assert.equal((h.match(/<tr>/g) ?? []).length, 3);
});
check('lists and code blocks', () => {
    const h = html('- **A**: first\n- second\n\n```\nnpm run build\n| not a table |\n```');
    assert.match(h, /<ul class="md-list"><li><strong>A<\/strong>: first<\/li><li>second<\/li><\/ul>/);
    assert.match(h, /<pre class="md-pre">npm run build\n\| not a table \|<\/pre>/);
});
check('links: https only; javascript: and data: stay text', () => {
    const h = html('[report](https://dev.azure.com/acme) and [x](javascript:alert(1)) and [y](data:text/html,hi) https://example.com/a?b=1');
    assert.match(h, /<a href="https:\/\/dev.azure.com\/acme" target="_blank" rel="noreferrer noopener">report<\/a>/);
    assert.doesNotMatch(h, /href="javascript/);
    assert.doesNotMatch(h, /href="data:/);
    assert.match(h, /<a href="https:\/\/example.com\/a\?b=1"/);
});
check('HTML in a comment is text, never markup', () => {
    const h = html('<img src=x onerror=alert(1)> <script>alert(1)</script> **<b>x</b>**');
    assert.doesNotMatch(h, /<img|<script|<b>x/);
    assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
check('plain lines keep their line breaks; empty text is fine', () => {
    assert.match(html('line one\nline two'), /<p class="md-p">line one<br\/>line two<\/p>/);
    assert.equal(html(''), '<div class="md"></div>');
});
