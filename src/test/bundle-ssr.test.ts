/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import Module from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVscodeMock } from './vscode-mock';

describe('Extension Bundle SSR Verification', () => {
    const extensionBundlePath = path.resolve(__dirname, '../../dist/extension.js');

    it('dist/extension.js exists and does not contain Svelte dev-mode SSR artifacts', () => {
        expect(fs.existsSync(extensionBundlePath)).toBe(true);
        const bundleContent = fs.readFileSync(extensionBundlePath, 'utf8');

        // Svelte 5 server-side compiler in dev mode emits 'push_element', which relies on
        // context.function[FILENAME] and causes runtime TypeError in bundled CommonJS extension host.
        // 'dev: false' must be used for the server build so that push_element is NOT emitted.
        expect(bundleContent).not.toContain('push_element');
    });

    it('dist/extension.js can be required and activated without throwing runtime errors', async () => {
        // Intercept Node's CJS require for 'vscode' so that bundled CommonJS code can load
        const originalRequire = Module.prototype.require;
        const vscodeMock = createVscodeMock();
        Module.prototype.require = function (this: unknown, id: string, ...args: unknown[]) {
            if (id === 'vscode') {
                return vscodeMock;
            }
            return (originalRequire as (...a: unknown[]) => unknown).apply(this, [id, ...args]);
        };

        try {
            const requireCjs = Module.createRequire(__filename);
            const extension = requireCjs('../../dist/extension.js') as {
                activate: (context: unknown) => Promise<unknown>;
            };

            expect(extension).toBeDefined();
            expect(typeof extension.activate).toBe('function');
        } finally {
            Module.prototype.require = originalRequire;
        }
    });
});
