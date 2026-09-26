/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '..');
const stubsDir = path.resolve(currentDir, 'src/stubs');

const backendPort = process.env.JJ_VIEW_BACKEND_PORT || '8080';

const browserShimsVitePlugin: Plugin = {
    name: 'browser-shims-vite',
    enforce: 'pre',
    resolveId(id) {
        if (id.startsWith('@parcel/watcher')) {
            return path.join(stubsDir, 'parcel-watcher.ts');
        }
        if (id.includes('node-host-system')) {
            return path.join(stubsDir, 'node-host-system.ts');
        }
        if (id.includes('binary-utils')) {
            return path.join(stubsDir, 'binary-utils.ts');
        }
        if (id === 'detect-libc' || /^(node:)?(fs|child_process|os|path)(\/promises)?$/.test(id)) {
            return path.join(stubsDir, 'empty-stub.ts');
        }
        return null;
    },
};

const htmlDevTransformPlugin: Plugin = {
    name: 'html-dev-transform',
    transformIndexHtml(html) {
        return html
            .replace('<link rel="stylesheet" href="/dist/app.css">', '')
            .replace('<script src="/dist/app.js"></script>', '<script type="module" src="/src/main.ts"></script>');
    },
};

export default defineConfig({
    root: currentDir,
    plugins: [browserShimsVitePlugin, svelte(), htmlDevTransformPlugin],
    define: {
        'process.env.NODE_ENV': '"development"',
    },
    server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: false,
        fs: {
            allow: [rootDir],
        },
        proxy: {
            '/ws/system': {
                target: `http://127.0.0.1:${backendPort}`,
                ws: true,
                changeOrigin: true,
            },
            '/api': {
                target: `http://127.0.0.1:${backendPort}`,
                changeOrigin: true,
            },
        },
    },
});
