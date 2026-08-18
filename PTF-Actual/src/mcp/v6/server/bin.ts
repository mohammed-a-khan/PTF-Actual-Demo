#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
try {
    const mod = require('./index');
    mod.startV6Server().catch((e: Error) => {
        process.stderr.write(`[cs-qa-v6] startV6Server failed: ${e.stack ?? e.message}\n`);
        process.exit(1);
    });
} catch (e) {
    const err = e as Error;
    process.stderr.write(`[cs-qa-v6] bin.js load failed: ${err.stack ?? err.message}\n`);
    process.exit(1);
}
