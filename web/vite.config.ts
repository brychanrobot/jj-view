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
    optimizeDeps: {
        include: [
            '@pierre/diffs',
            '@pierre/theme',
            'shiki',
            '@shikijs/themes/github-dark',
            '@shikijs/themes/github-dark-dimmed',
            '@shikijs/themes/catppuccin-mocha',
            '@shikijs/themes/catppuccin-macchiato',
            '@shikijs/themes/catppuccin-frappe',
            '@shikijs/themes/dracula',
            '@shikijs/themes/dracula-soft',
            '@shikijs/themes/tokyo-night',
            '@shikijs/themes/nord',
            '@shikijs/themes/one-dark-pro',
            '@shikijs/themes/solarized-dark',
            '@shikijs/themes/monokai',
            '@shikijs/themes/ayu-dark',
            '@shikijs/themes/ayu-mirage',
            '@shikijs/themes/vesper',
            '@shikijs/themes/poimandres',
            '@shikijs/themes/rose-pine',
            '@shikijs/themes/rose-pine-moon',
            '@shikijs/themes/everforest-dark',
            '@shikijs/themes/gruvbox-dark-medium',
            '@shikijs/themes/kanagawa-wave',
            '@shikijs/themes/night-owl',
            '@shikijs/themes/github-light',
            '@shikijs/themes/github-light-default',
            '@shikijs/themes/catppuccin-latte',
            '@shikijs/themes/one-light',
            '@shikijs/themes/solarized-light',
            '@shikijs/themes/rose-pine-dawn',
            '@shikijs/themes/everforest-light',
            '@shikijs/themes/gruvbox-light-medium',
            '@shikijs/themes/vitesse-light',
            '@shikijs/themes/light-plus',
            '@shikijs/langs/typescript',
            '@shikijs/langs/javascript',
            '@shikijs/langs/json',
            '@shikijs/langs/jsonc',
            '@shikijs/langs/go',
            '@shikijs/langs/rust',
            '@shikijs/langs/python',
            '@shikijs/langs/html',
            '@shikijs/langs/css',
            '@shikijs/langs/markdown',
            '@shikijs/langs/yaml',
            '@shikijs/langs/toml',
            '@shikijs/langs/shellscript',
            '@shikijs/langs/diff',
            '@shikijs/langs/c',
            '@shikijs/langs/cpp',
            '@shikijs/langs/csharp',
            '@shikijs/langs/java',
            '@shikijs/langs/dockerfile',
            '@shikijs/langs/xml',
            '@shikijs/langs/sql',
        ],
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
