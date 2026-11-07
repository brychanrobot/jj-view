// @vitest-environment happy-dom
/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import esbuild from 'esbuild';
import sveltePlugin from 'esbuild-svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';

interface BaseProps {
    changeId: string;
    commitId: string;
    description: string;
    files: [];
    isImmutable: boolean;
    onSave: () => void;
    onOpenDiff: () => void;
    onOpenMultiDiff: () => void;
    onDescriptionChange?: (description: string, selectionStart: number, selectionEnd: number) => void;
}

const baseProps: BaseProps = {
    changeId: 'krsyowswxmxnqznrtlpuyutskyzrpunp',
    commitId: 'abcdef1234567890abcdef1234567890abcdef12',
    description: 'Initial description',
    files: [],
    isImmutable: false,
    onSave: () => {},
    onOpenDiff: () => {},
    onOpenMultiDiff: () => {},
};

let ssrHtml = '';
let clientMod: {
    hydrateDetails: (target: Element, props: BaseProps) => () => void;
};

beforeAll(async () => {
    // Vitest resolves Svelte with Node/server conditions by default, where `hydrate()` is
    // unavailable. Compile tiny SSR and client helpers with the exact esbuild-svelte configs
    // used in production (`esbuild.js`) and run the client helper against happy-dom.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-commit-details-hydration-'));
    const ssrOut = path.join(tmpDir, 'ssr.cjs');
    const clientOut = path.join(tmpDir, 'client.cjs');
    const repoRoot = path.resolve(__dirname, '../..');
    const componentPath = path.resolve(__dirname, '../core/webview/commit-details/CommitDetails.svelte');
    const bridgePath = path.resolve(__dirname, '../core/webview/transport/bridge.svelte.ts');

    try {
        await Promise.all([
            esbuild.build({
                absWorkingDir: repoRoot,
                stdin: {
                    contents: `import { render } from 'svelte/server';
import CommitDetails from ${JSON.stringify(componentPath)};
export function renderSsr(props: Record<string, unknown>): string {
    return render(CommitDetails, { props }).body;
}
`,
                    resolveDir: repoRoot,
                    loader: 'ts',
                },
                bundle: true,
                format: 'cjs',
                platform: 'node',
                outfile: ssrOut,
                logLevel: 'silent',
                plugins: [
                    sveltePlugin({
                        compilerOptions: {
                            dev: false,
                            generate: 'server',
                        },
                    }),
                ],
            }),
            esbuild.build({
                absWorkingDir: repoRoot,
                stdin: {
                    contents: `import { flushSync, hydrate, unmount } from 'svelte';
import { initBridge } from ${JSON.stringify(bridgePath)};
import CommitDetails from ${JSON.stringify(componentPath)};
export function hydrateDetails(target: Element, props: Record<string, unknown>): () => void {
    initBridge({ postMessage: () => {}, onMessage: () => () => {} });
    const instance = hydrate(CommitDetails, { target, props });
    flushSync();
    return () => {
        void unmount(instance);
    };
}
`,
                    resolveDir: repoRoot,
                    loader: 'ts',
                },
                bundle: true,
                format: 'cjs',
                platform: 'browser',
                outfile: clientOut,
                logLevel: 'silent',
                plugins: [
                    sveltePlugin({
                        compilerOptions: {
                            dev: false,
                            css: 'external',
                        },
                    }),
                ],
            }),
        ]);

        const savedWindow = globalThis.window;
        try {
            Reflect.deleteProperty(globalThis, 'window');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const ssrMod = require(ssrOut) as { renderSsr: (props: BaseProps) => string };
            ssrHtml = ssrMod.renderSsr(baseProps);
        } finally {
            globalThis.window = savedWindow;
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        clientMod = require(clientOut) as typeof clientMod;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

describe('CommitDetails hydration', () => {
    it('forwards a description typed into the server-rendered textarea before hydration', () => {
        const target = document.createElement('div');
        target.innerHTML = ssrHtml;
        document.body.appendChild(target);

        const textarea = target.querySelector('textarea');
        expect(textarea).not.toBeNull();
        if (!textarea) {
            return;
        }

        // Simulate the user (or Playwright fill()) typing before hydration runs.
        textarea.value = 'Typed before hydration';
        textarea.selectionStart = 5;
        textarea.selectionEnd = 5;

        const onDescriptionChange = vi.fn();
        const dispose = clientMod.hydrateDetails(target, {
            ...baseProps,
            onDescriptionChange,
        });

        expect(onDescriptionChange).toHaveBeenCalledTimes(1);
        expect(onDescriptionChange).toHaveBeenCalledWith('Typed before hydration', 5, 5);

        dispose();
        target.remove();
    });

    it('does not report a change when nothing was typed before hydration', () => {
        const target = document.createElement('div');
        target.innerHTML = ssrHtml;
        document.body.appendChild(target);

        const onDescriptionChange = vi.fn();
        const dispose = clientMod.hydrateDetails(target, {
            ...baseProps,
            onDescriptionChange,
        });

        expect(onDescriptionChange).not.toHaveBeenCalled();

        dispose();
        target.remove();
    });
});
