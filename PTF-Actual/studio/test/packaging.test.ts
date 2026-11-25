import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { builtinModules } from 'module';

/**
 * The Studio ships inside the framework package (studio/dist/src, bin cs-test-studio): every library its code loads must
 * be installed with the framework — a dependency, or an optional peer the code loads only when that feature is used.
 * Found on a real pipeline agent: `npx cs-test-studio` failed with "Cannot find module 'graphql'".
 */
// Loaded only when used, from the project (the browser, Kerberos sign-in for the corporate proxy).
const FROM_THE_PROJECT = new Set(['playwright', 'kerberos']);

test('packaging: every library the shipped Studio code loads is installed with the framework package', (t) => {
    const fwPkg = path.resolve(__dirname, '..', '..', '..', 'package.json');
    const fw = fs.existsSync(fwPkg) ? JSON.parse(fs.readFileSync(fwPkg, 'utf8')) : null;
    if (!fw?.bin?.['cs-test-studio']) { t.skip('not inside the framework repository'); return; }
    const installed = new Set([...Object.keys(fw.dependencies ?? {}), ...Object.keys(fw.peerDependencies ?? {})]);
    const missing = new Map<string, string>();
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (p.endsWith('.js')) {
                for (const m of fs.readFileSync(p, 'utf8').matchAll(/require\(["']([^."'$`][^"'`]*)["']\)/g)) {
                    const n = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
                    if (n.startsWith('node:') || builtinModules.includes(n) || FROM_THE_PROJECT.has(n) || installed.has(n)) continue;
                    missing.set(n, path.relative(path.resolve(__dirname, '..'), p));
                }
            }
        }
    };
    walk(path.resolve(__dirname, '..', 'src'));
    assert.deepEqual([...missing].map(([n, f]) => `${n} (${f})`), [], 'add these to the framework package.json dependencies');
});
