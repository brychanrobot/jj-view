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

import type { JjStatusEntry } from '../core/jj-types';

interface BaseProps {
    changeId: string;
    commitId: string;
    description: string;
    files: JjStatusEntry[];
    isImmutable: boolean;
    onSave: () => void;
    onOpenDiff: (file: JjStatusEntry, isImmutable: boolean) => void;
    onOpenMultiDiff: () => void;
    onDescriptionChange?: (description: string, selectionStart: number, selectionEnd: number) => void;
    onSplitFiles?: (paths: string[], placement: 'before' | 'after') => void;
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
    mountDetails: (target: Element, props: BaseProps) => () => void;
    flush: () => void;
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
                    contents: `import { flushSync, hydrate, mount, unmount } from 'svelte';
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
export function mountDetails(target: Element, props: Record<string, unknown>): () => void {
    initBridge({ postMessage: () => {}, onMessage: () => () => {} });
    const instance = mount(CommitDetails, { target, props });
    flushSync();
    return () => {
        void unmount(instance);
    };
}
export function flush(): void {
    flushSync();
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

    it('supports Ctrl/Shift multi-selection, Escape clear, context menu split, and immutable guard', () => {
        const sampleFiles: JjStatusEntry[] = [
            { path: 'a.txt', status: 'modified' },
            { path: 'b.txt', status: 'added' },
            { path: 'c.txt', status: 'modified' },
        ];
        const target = document.createElement('div');
        document.body.appendChild(target);
        const onOpenDiff = vi.fn();
        const onSplitFiles = vi.fn();

        const dispose = clientMod.mountDetails(target, {
            ...baseProps,
            files: sampleFiles,
            onOpenDiff,
            onSplitFiles,
        });

        try {
            const rows = Array.from(target.querySelectorAll<HTMLButtonElement>('.file-row'));
            expect(rows).toHaveLength(3);

            // Plain click selects row 0 and opens diff
            rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
            clientMod.flush();
            expect(onOpenDiff).toHaveBeenCalledTimes(1);
            expect(rows[0].dataset.selected).toBe('true');

            // Shift+click on row 2 selects 0..2 without opening diff
            rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
            clientMod.flush();
            expect(onOpenDiff).toHaveBeenCalledTimes(1);
            expect(rows.map((r) => r.dataset.selected)).toEqual(['true', 'true', 'true']);

            // Ctrl+click on row 1 toggles row 1 off without opening diff
            rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
            clientMod.flush();
            expect(onOpenDiff).toHaveBeenCalledTimes(1);
            expect(rows.map((r) => r.dataset.selected)).toEqual(['true', 'false', 'true']);

            // Right-clicking selected row 0 opens menu preserving selection {'a.txt', 'c.txt'}
            rows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }));
            clientMod.flush();
            const menu = target.querySelector<HTMLElement>('[data-testid="commit-details-file-context-menu"]');
            expect(menu).not.toBeNull();

            // Escape closes menu first while preserving selection
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            clientMod.flush();
            expect(target.querySelector('[data-testid="commit-details-file-context-menu"]')).toBeNull();
            expect(rows.map((r) => r.dataset.selected)).toEqual(['true', 'false', 'true']);

            // Escape outside textarea clears selection
            rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            clientMod.flush();
            expect(rows.map((r) => r.dataset.selected)).toEqual(['false', 'false', 'false']);

            // Right-clicking row 1 selects row 1 and ArrowDown + ArrowDown + Enter triggers Split After
            rows[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }));
            clientMod.flush();
            expect(rows[1].dataset.selected).toBe('true');
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            clientMod.flush();
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            clientMod.flush();
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            clientMod.flush();
            expect(onSplitFiles).toHaveBeenCalledWith(['b.txt'], 'after');
        } finally {
            dispose();
            target.remove();
        }

        // Immutable commit must not open split context menu
        const immTarget = document.createElement('div');
        document.body.appendChild(immTarget);
        const immDispose = clientMod.mountDetails(immTarget, {
            ...baseProps,
            files: sampleFiles,
            isImmutable: true,
            onSplitFiles,
        });
        try {
            const immRow = immTarget.querySelector<HTMLButtonElement>('.file-row');
            immRow?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
            clientMod.flush();
            expect(immTarget.querySelector('[data-testid="commit-details-file-context-menu"]')).toBeNull();
        } finally {
            immDispose();
            immTarget.remove();
        }
    });
});
