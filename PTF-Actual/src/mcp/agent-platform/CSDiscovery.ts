/**
 * Agentic Test Platform — Legacy Project Discovery (Rebuild M5)
 *
 * Walks a legacy project tree (Java + TestNG, Java + BDD/Cucumber, or
 * mixed) and produces a structured `LegacyInventory` of every test file,
 * page object, helper, base class, data file, properties file, and
 * runner config (testng.xml / cucumber.xml). The analyzer (M6) consumes
 * this inventory to drive recursive call-tree resolution.
 *
 * Privacy-by-design: file paths are recorded verbatim (the inventory is
 * a per-run artefact, not shipped over the wire). Class names + method
 * names are preserved as-is so the analyzer can reason about them.
 *
 * @module agent-platform/CSDiscovery
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Public Types
// ============================================================================

export interface LegacyInventory {
    rootPath: string;
    rootStyle: 'maven' | 'gradle' | 'flat' | 'unknown';
    /** Detected language: most legacy suites are 'java'. */
    language: 'java' | 'csharp' | 'mixed' | 'unknown';
    files: LegacyFile[];
    /** Files classified — pointers into `files` for fast lookup. */
    tests: string[];          // paths
    pages: string[];          // paths
    helpers: string[];        // paths
    baseClasses: string[];    // paths
    dataFiles: string[];      // paths (XLS, XML, CSV, JSON, properties)
    propertiesFiles: string[]; // paths (*.properties only)
    runnerConfigs: string[];  // paths (testng.xml, cucumber*.xml, qaf-config*.xml)
    feature: string[];        // .feature files (BDD suites)
    /** When the entry path is a single file, this points at it. */
    entryFile?: string;
    /** Counts surfaced for quick summary. */
    counts: {
        files: number;
        tests: number;
        pages: number;
        helpers: number;
        baseClasses: number;
        dataFiles: number;
        runnerConfigs: number;
        features: number;
    };
}

export interface LegacyFile {
    /** Absolute path. */
    path: string;
    /** Workspace-relative path (relative to rootPath). */
    relativePath: string;
    extension: string;
    sizeBytes: number;
    /** Coarse classification — 'test' / 'page' / 'helper' / 'base' / 'data' / 'config' / 'feature' / 'unknown'. */
    kind: LegacyFileKind;
    /** Class name when extractable from filename / first lines of source. */
    className?: string;
    /** Java/C# package or namespace, when detectable. */
    packageName?: string;
}

export type LegacyFileKind =
    | 'test'
    | 'page'
    | 'helper'
    | 'base'
    | 'data'
    | 'config'
    | 'feature'
    | 'unknown';

// ============================================================================
// CSDiscovery
// ============================================================================

export class CSDiscovery {
    /** Default ignore patterns. Skip generated + dependency dirs. */
    private static readonly IGNORE_DIRS = new Set([
        'node_modules', 'target', 'build', 'dist', 'out', 'bin',
        '.git', '.gradle', '.idea', '.vscode', 'tmp', 'temp',
    ]);

    /** Source extensions worth analysing. */
    private static readonly SOURCE_EXTS = new Set([
        '.java', '.kt', '.scala', '.cs', '.fs',
    ]);

    /** Data file extensions. */
    private static readonly DATA_EXTS = new Set([
        '.xls', '.xlsx', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
    ]);

    /**
     * Discover everything reachable from `rootPath`. If `rootPath` points
     * at a single file, the inventory still walks the file's containing
     * project (cap at 5 directories up looking for a project marker).
     */
    public static discover(rootPath: string, opts?: { entryFile?: string }): LegacyInventory {
        const stat = fs.statSync(rootPath);
        const root = stat.isDirectory() ? rootPath : path.dirname(rootPath);
        const projectRoot = CSDiscovery.findProjectRoot(root);
        const inv: LegacyInventory = {
            rootPath: projectRoot,
            rootStyle: CSDiscovery.detectRootStyle(projectRoot),
            language: 'unknown',
            files: [],
            tests: [],
            pages: [],
            helpers: [],
            baseClasses: [],
            dataFiles: [],
            propertiesFiles: [],
            runnerConfigs: [],
            feature: [],
            entryFile: opts?.entryFile ?? (stat.isFile() ? rootPath : undefined),
            counts: {
                files: 0, tests: 0, pages: 0, helpers: 0,
                baseClasses: 0, dataFiles: 0, runnerConfigs: 0, features: 0,
            },
        };

        const langCounts: Record<string, number> = {};
        CSDiscovery.walk(projectRoot, projectRoot, (abs, rel, dirent) => {
            if (!dirent.isFile()) return;
            const ext = path.extname(abs).toLowerCase();
            if (!CSDiscovery.SOURCE_EXTS.has(ext)
                && !CSDiscovery.DATA_EXTS.has(ext)
                && ext !== '.properties' && ext !== '.feature') {
                return;
            }
            let size = 0;
            try { size = fs.statSync(abs).size; } catch { /* ignore */ }
            const kind = CSDiscovery.classifyFile(abs, rel, ext);
            const file: LegacyFile = {
                path: abs,
                relativePath: rel,
                extension: ext,
                sizeBytes: size,
                kind,
            };
            // Cheap header sniff for class + package
            if (CSDiscovery.SOURCE_EXTS.has(ext)) {
                langCounts[ext] = (langCounts[ext] ?? 0) + 1;
                const head = CSDiscovery.safeReadHead(abs, 4 * 1024);
                if (head) {
                    file.packageName = CSDiscovery.extractPackage(head);
                    file.className = CSDiscovery.extractClassName(head, abs);
                }
            }
            inv.files.push(file);
            switch (kind) {
                case 'test': inv.tests.push(abs); break;
                case 'page': inv.pages.push(abs); break;
                case 'helper': inv.helpers.push(abs); break;
                case 'base': inv.baseClasses.push(abs); break;
                case 'data': inv.dataFiles.push(abs); break;
                case 'config': inv.runnerConfigs.push(abs); break;
                case 'feature': inv.feature.push(abs); break;
                default: break;
            }
            if (ext === '.properties') {
                inv.propertiesFiles.push(abs);
            }
        });

        if ((langCounts['.java'] ?? 0) > 0 && (langCounts['.cs'] ?? 0) === 0) inv.language = 'java';
        else if ((langCounts['.cs'] ?? 0) > 0 && (langCounts['.java'] ?? 0) === 0) inv.language = 'csharp';
        else if ((langCounts['.java'] ?? 0) > 0 && (langCounts['.cs'] ?? 0) > 0) inv.language = 'mixed';

        inv.counts.files = inv.files.length;
        inv.counts.tests = inv.tests.length;
        inv.counts.pages = inv.pages.length;
        inv.counts.helpers = inv.helpers.length;
        inv.counts.baseClasses = inv.baseClasses.length;
        inv.counts.dataFiles = inv.dataFiles.length;
        inv.counts.runnerConfigs = inv.runnerConfigs.length;
        inv.counts.features = inv.feature.length;
        return inv;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private static walk(
        root: string,
        current: string,
        visitor: (abs: string, rel: string, dirent: fs.Dirent) => void,
    ): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const abs = path.join(current, e.name);
            const rel = path.relative(root, abs);
            if (e.isDirectory()) {
                if (CSDiscovery.IGNORE_DIRS.has(e.name)) continue;
                if (e.name.startsWith('.')) continue;
                CSDiscovery.walk(root, abs, visitor);
                continue;
            }
            visitor(abs, rel, e);
        }
    }

    private static classifyFile(
        abs: string,
        rel: string,
        ext: string,
    ): LegacyFileKind {
        const base = path.basename(abs);
        const baseLower = base.toLowerCase();
        const relLower = rel.toLowerCase();

        if (ext === '.feature') return 'feature';
        if (ext === '.properties') return 'config';

        if (CSDiscovery.DATA_EXTS.has(ext)) {
            // testng.xml / cucumber*.xml / qaf-config.xml are runner configs
            if (ext === '.xml') {
                if (/testng[-_a-z0-9]*\.xml$/.test(baseLower)) return 'config';
                if (/cucumber[-_a-z0-9]*\.xml$/.test(baseLower)) return 'config';
                if (/qaf[-_a-z0-9]*\.xml$/.test(baseLower)) return 'config';
                if (/suite[-_a-z0-9]*\.xml$/.test(baseLower)) return 'config';
            }
            return 'data';
        }

        // Java / C# heuristics
        if (CSDiscovery.SOURCE_EXTS.has(ext)) {
            // Look at filename + path hints
            if (/test\.java$|tests\.java$|test\.cs$|tests\.cs$/i.test(baseLower)) return 'test';
            if (/page\.java$|page\.cs$/i.test(baseLower)) return 'page';
            if (/basetest|abstracttest|basetestcase/i.test(baseLower)) return 'base';
            if (/helper\.java$|helper\.cs$|util\.java$|util\.cs$|utility\.java$|utility\.cs$|support\.java$|support\.cs$/i.test(baseLower)) return 'helper';
            if (/\/(testsuites?|tests?)\//i.test(relLower) || /testsuites?[\\\/]/i.test(relLower)) return 'test';
            if (/\/(pages?)\//i.test(relLower)) return 'page';
            if (/\/(helpers?|utils?|utilities|support|common)\//i.test(relLower)) return 'helper';
            // Sniff content for @Test annotation as fallback
            const head = CSDiscovery.safeReadHead(abs, 4096);
            if (head) {
                if (/@Test\b|\[Test\]|\[TestCase[\(\]]/.test(head)) return 'test';
                if (/extends\s+(?:Abstract\w*)?(?:Base\w*Test\w*|\w*BaseTest\w*|\w*TestCase\b|TestNGCucumberTests|CucumberTestCase)/.test(head)) return 'test';
                if (/extends\s+(?:WebDriverTestCase|BasePage|AbstractPage)/.test(head)) return 'page';
            }
            return 'unknown';
        }
        return 'unknown';
    }

    private static safeReadHead(p: string, bytes: number): string | null {
        try {
            const fd = fs.openSync(p, 'r');
            const buf = Buffer.alloc(bytes);
            const n = fs.readSync(fd, buf, 0, bytes, 0);
            fs.closeSync(fd);
            return buf.slice(0, n).toString('utf-8');
        } catch {
            return null;
        }
    }

    private static extractPackage(head: string): string | undefined {
        const m = head.match(/^\s*package\s+([\w.]+)\s*;/m);
        return m ? m[1] : undefined;
    }

    private static extractClassName(head: string, abs: string): string | undefined {
        const m = head.match(/(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/);
        if (m) return m[1];
        const base = path.basename(abs, path.extname(abs));
        return base;
    }

    private static findProjectRoot(start: string): string {
        let cur = start;
        for (let i = 0; i < 5; i++) {
            const candidates = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json', '*.csproj'];
            for (const c of candidates) {
                if (c.includes('*')) {
                    try {
                        const ents = fs.readdirSync(cur);
                        if (ents.some((e) => e.endsWith('.csproj'))) return cur;
                    } catch { /* ignore */ }
                } else {
                    if (fs.existsSync(path.join(cur, c))) return cur;
                }
            }
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
        return start;
    }

    private static detectRootStyle(root: string): LegacyInventory['rootStyle'] {
        if (fs.existsSync(path.join(root, 'pom.xml'))) return 'maven';
        if (fs.existsSync(path.join(root, 'build.gradle'))
            || fs.existsSync(path.join(root, 'build.gradle.kts'))) return 'gradle';
        if (fs.existsSync(path.join(root, 'src'))) return 'flat';
        return 'unknown';
    }
}
