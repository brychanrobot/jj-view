// @vitest-environment happy-dom
/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import esbuild from 'esbuild';
import sveltePlugin from 'esbuild-svelte';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { LogViewController } from '../core/controllers/log-view-controller';
import type { HostWatcher, ProcessExecOptions, ProcessResult } from '../core/host/host-system';
import { NodeHostProcess, NodeHostSystem } from '../core/host/node-host-system';
import type { WebviewPostMessageLike } from '../core/host/webview-rpc-dispatcher';
import { JjRepository } from '../core/jj-repository';
import { Uri } from '../core/uri-utils';
import { MockWebviewTransport } from '../core/webview/transport/mock-transport';
import type { WebviewTransport } from '../core/webview/transport/types';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

function createTestBridge(handler: (message: unknown) => Promise<unknown> | unknown): {
    messenger: WebviewPostMessageLike;
    transport: WebviewTransport;
    dispose: () => void;
} {
    const inner = new MockWebviewTransport();
    const messenger: WebviewPostMessageLike = {
        postMessage: (message: unknown) => {
            inner.simulateIncomingMessage(message);
        },
    };
    const transport: WebviewTransport = {
        postMessage: (message: unknown) => {
            void handler(message);
        },
        onMessage: (listener) => inner.onMessage(listener),
        dispose: () => inner.dispose(),
    };
    return {
        messenger,
        transport,
        dispose: () => inner.dispose(),
    };
}

interface ClientModule {
    mountLogApp: (target: Element, transport: WebviewTransport) => () => void;
}

let clientMod: ClientModule;
let buildTmpDir = '';

beforeAll(async () => {
    buildTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-log-app-component-'));
    const clientOut = path.join(buildTmpDir, 'client.cjs');
    const repoRoot = path.resolve(__dirname, '../..');
    const componentPath = path.resolve(__dirname, '../core/webview/log/LogApp.svelte');
    const bridgePath = path.resolve(__dirname, '../core/webview/transport/bridge.svelte.ts');
    const transportTypesPath = path.resolve(__dirname, '../core/webview/transport/types.ts');

    await esbuild.build({
        absWorkingDir: repoRoot,
        stdin: {
            contents: `import { flushSync, mount, unmount } from 'svelte';
import { initBridge } from ${JSON.stringify(bridgePath)};
import type { WebviewTransport } from ${JSON.stringify(transportTypesPath)};
import LogApp from ${JSON.stringify(componentPath)};
export function mountLogApp(target: Element, transport: WebviewTransport): () => void {
    initBridge(transport);
    const instance = mount(LogApp, { target });
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
    });

    const requireCjs = Module.createRequire(__filename);
    clientMod = requireCjs(clientOut) as ClientModule;
});

afterAll(() => {
    if (buildTmpDir) {
        fs.rmSync(buildTmpDir, { recursive: true, force: true });
    }
});

describe('LogApp Client Component Lifecycle with LogViewController', () => {
    it('transitions from loading -> no-repo -> error -> loaded commits -> no-repo', async () => {
        const brokenRepo = new TestRepo();
        const validRepo = new TestRepo();
        const target = document.createElement('div');
        document.body.appendChild(target);

        let controller: LogViewController | undefined;
        let brokenJjRepo: JjRepository | undefined;
        let validJjRepo: JjRepository | undefined;
        let unmountApp: (() => void) | undefined;

        const bridge = createTestBridge(async (msg) => {
            if (controller) {
                await controller.handleMessage(msg);
            }
        });

        try {
            brokenRepo.init();
            validRepo.init();
            validRepo.writeFile('readme.md', '# hello\n');
            validRepo.describe('feat: live component commit');

            const fakeHost = new FakeHostEnvironment();
            const registry = new CodeForgeRegistry();
            const outputChannel = createMockLogOutputChannel({
                appendLine: () => {},
            });

            brokenJjRepo = new JjRepository(
                Uri.file(brokenRepo.path),
                path.join(brokenRepo.path, '.jj', 'repo'),
                registry,
                outputChannel,
                fakeHost,
                '/non/existent/jj-binary',
            );
            await brokenJjRepo.watcher.dispose();

            validJjRepo = new JjRepository(
                Uri.file(validRepo.path),
                path.join(validRepo.path, '.jj', 'repo'),
                registry,
                outputChannel,
                fakeHost,
            );
            await validJjRepo.watcher.dispose();

            // 1. Start with no repository (undefined)
            controller = new LogViewController(undefined, fakeHost, {
                messenger: bridge.messenger,
                logger: outputChannel,
            });

            unmountApp = clientMod.mountLogApp(target, bridge.transport);

            // Wait for webviewLoaded -> refresh -> no-repo state
            await expect
                .poll(() => target.querySelector('[data-testid="log-no-repo-state"]')?.textContent ?? '')
                .toContain('No Jujutsu repository found in this workspace.');
            expect(target.querySelector('.loading-state')).toBeNull();

            // 2. Attach broken repository whose jj binary fails -> error state, exits loading
            controller.repository = brokenJjRepo;

            await expect
                .poll(() => target.querySelector('[data-testid="log-error-state"]')?.textContent ?? '')
                .toContain('Unable to load Jujutsu log');
            expect(target.querySelector('[data-testid="log-no-repo-state"]')).toBeNull();
            expect(target.querySelector('.loading-state')).toBeNull();

            // 3. Attach valid TestRepo -> clears error state and renders commit graph
            controller.repository = validJjRepo;

            await expect.poll(() => target.textContent ?? '').toContain('feat: live component commit');
            expect(target.querySelector('[data-testid="log-error-state"]')).toBeNull();
            expect(target.querySelector('[data-testid="log-no-repo-state"]')).toBeNull();
            expect(target.querySelector('.commit-graph')).not.toBeNull();

            // 4. Detach repository -> returns cleanly to no-repo empty state
            controller.repository = undefined;

            await expect
                .poll(() => target.querySelector('[data-testid="log-no-repo-state"]')?.textContent ?? '')
                .toContain('No Jujutsu repository found in this workspace.');
            expect(target.querySelector('.commit-graph')).toBeNull();
        } finally {
            unmountApp?.();
            bridge.dispose();
            controller?.dispose();
            await brokenJjRepo?.dispose();
            await validJjRepo?.dispose();
            await brokenRepo.dispose();
            await validRepo.dispose();
            target.remove();
        }
    });

    it('keeps loading state visible until initial attached-repo refresh settles without flashing empty CommitGraph', async () => {
        const target = document.createElement('div');
        document.body.appendChild(target);

        let validRepo: TestRepo | undefined;
        let validJjRepo: JjRepository | undefined;
        let controller: LogViewController | undefined;
        let unmountApp: (() => void) | undefined;
        let releaseLogExec: (() => void) | undefined;

        const bridge = createTestBridge(async (msg) => {
            if (controller) {
                await controller.handleMessage(msg);
            }
        });

        try {
            validRepo = new TestRepo();
            validRepo.init();
            validRepo.writeFile('readme.md', '# deferred\n');
            validRepo.describe('feat: deferred settled commit');

            let notifyLogStarted!: () => void;
            const logStarted = new Promise<void>((resolve) => {
                notifyLogStarted = resolve;
            });
            const deferredLogExec = new Promise<void>((resolve) => {
                releaseLogExec = resolve;
            });
            let blockNextLog = true;

            class DeferredLogProcess extends NodeHostProcess {
                override async execFile(
                    file: string,
                    args: readonly string[],
                    options?: ProcessExecOptions,
                ): Promise<ProcessResult> {
                    if (blockNextLog && args.includes('log')) {
                        blockNextLog = false;
                        notifyLogStarted();
                        await deferredLogExec;
                    }
                    return super.execFile(file, args, options);
                }
            }

            const noopWatcher: HostWatcher = {
                watch: async () => ({ unsubscribe: async () => {} }),
            };
            const deferredHost = new FakeHostEnvironment(
                new NodeHostSystem({
                    process: new DeferredLogProcess(),
                    watcher: noopWatcher,
                }),
            );
            const registry = new CodeForgeRegistry();
            const outputChannel = createMockLogOutputChannel({
                appendLine: () => {},
            });

            validJjRepo = new JjRepository(
                Uri.file(validRepo.path),
                path.join(validRepo.path, '.jj', 'repo'),
                registry,
                outputChannel,
                deferredHost,
            );
            await validJjRepo.watcher.dispose();

            const postedUpdates: unknown[] = [];
            const trackedMessenger: WebviewPostMessageLike = {
                postMessage: (message: unknown) => {
                    if (
                        typeof message === 'object' &&
                        message !== null &&
                        'type' in message &&
                        message.type === 'update'
                    ) {
                        postedUpdates.push(message);
                    }
                    bridge.messenger.postMessage(message);
                },
            };

            controller = new LogViewController(validJjRepo, deferredHost, {
                messenger: trackedMessenger,
                logger: outputChannel,
            });

            unmountApp = clientMod.mountLogApp(target, bridge.transport);

            // Wait until initial refresh reaches jj log (after webviewLoaded/getState + isValid)
            await logStarted;

            // Unsettled initial refresh must keep loading-state visible without an empty CommitGraph flash
            expect(postedUpdates).toEqual([]);
            expect(target.querySelector('.loading-state')).not.toBeNull();
            expect(target.querySelector('.commit-graph')).toBeNull();
            expect(target.querySelector('[data-testid="log-no-repo-state"]')).toBeNull();

            releaseLogExec?.();
            await expect.poll(() => target.textContent ?? '').toContain('feat: deferred settled commit');
            expect(target.querySelector('.loading-state')).toBeNull();
            expect(target.querySelector('.commit-graph')).not.toBeNull();
            expect(postedUpdates).toHaveLength(1);
        } finally {
            releaseLogExec?.();
            unmountApp?.();
            bridge.dispose();
            controller?.dispose();
            await validJjRepo?.dispose();
            await validRepo?.dispose();
            target.remove();
        }
    });
});
