import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

// Builds the Studio UI into dist/ui, which the local server serves.
export default defineConfig({
    root: __dirname,
    plugins: [react()],
    build: {
        outDir: path.resolve(__dirname, '../dist/ui'),
        emptyOutDir: true,
        sourcemap: false,
        chunkSizeWarningLimit: 2500,
    },
    server: {
        // `npm run dev:ui` against a running `cs-test-studio start --port 47123`
        proxy: { '/api': 'http://127.0.0.1:47123' },
    },
});
