/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(currentDir, '..');

describe('Vite Dev Server Integration & Module Resolution', () => {
    let server: ViteDevServer;

    beforeAll(async () => {
        server = await createServer({
            configFile: path.join(webDir, 'vite.config.ts'),
            server: {
                middlewareMode: true,
                watch: null,
            },
            optimizeDeps: {
                noDiscovery: true,
            },
            appType: 'spa',
        });
    });

    afterAll(async () => {
        await server.watcher?.close();
        await server.ws?.close();
        await server.close();
    });

    it('transforms index.html and injects main.ts module entrypoint', async () => {
        const rawHtml =
            '<html><head><link rel="stylesheet" href="/dist/app.css"></head><body><script src="/dist/app.js"></script></body></html>';
        const transformed = await server.transformIndexHtml('/', rawHtml);
        expect(transformed).toContain('<script type="module" src="/src/main.ts"></script>');
        expect(transformed).not.toContain('/dist/app.css');
    });

    it('resolves and transforms src/main.ts without import failures', async () => {
        const result = await server.transformRequest('/src/main.ts');
        expect(result).toBeDefined();
        expect(result?.code).toBeDefined();
        expect(result?.code.length).toBeGreaterThan(0);
    });

    it('resolves node-host-system stub when importing core jj-service', async () => {
        const plugin = server.config.plugins.find((p) => p.name === 'browser-shims-vite');
        expect(plugin).toBeDefined();

        const resolvedNodeHost = await server.pluginContainer.resolveId(
            './host/node-host-system',
            path.join(webDir, '../src/core/jj-service.ts'),
        );
        expect(resolvedNodeHost?.id).toContain('stubs/node-host-system.ts');
    });

    it('resolves binary-utils stub when importing core directory-watcher', async () => {
        const resolvedBinaryUtils = await server.pluginContainer.resolveId(
            '../utils/binary-utils',
            path.join(webDir, '../src/core/directory-watcher.ts'),
        );
        expect(resolvedBinaryUtils?.id).toContain('stubs/binary-utils.ts');
    });

    it('resolves @parcel/watcher stub', async () => {
        const resolvedParcel = await server.pluginContainer.resolveId(
            '@parcel/watcher',
            path.join(webDir, '../src/core/directory-watcher.ts'),
        );
        expect(resolvedParcel?.id).toContain('stubs/parcel-watcher.ts');
    });

    it('resolves Node builtins to empty-stub', async () => {
        const resolvedFs = await server.pluginContainer.resolveId('fs', path.join(webDir, '../src/core/fs.ts'));
        expect(resolvedFs?.id).toContain('stubs/empty-stub.ts');

        const resolvedChildProcess = await server.pluginContainer.resolveId(
            'child_process',
            path.join(webDir, '../src/core/process.ts'),
        );
        expect(resolvedChildProcess?.id).toContain('stubs/empty-stub.ts');
    });

    it('transforms Svelte components without compiler errors', async () => {
        const result = await server.transformRequest('/src/App.svelte');
        expect(result).toBeDefined();
        expect(result?.code).toBeDefined();
    });
});
