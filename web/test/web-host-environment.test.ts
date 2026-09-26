/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { HostFs } from '../../src/core/host/host-system';
import type { RemoteHostSystem } from '../../src/core/host/remote-host-system';
import { Uri } from '../../src/core/uri-utils';
import {
    type ContextKeySetter,
    WebHostAuth,
    WebHostCommands,
    WebHostConfig,
    WebHostDocuments,
    WebHostEnvironment,
    WebHostNavigation,
    WebHostSecrets,
    WebHostStorage,
    WebHostUi,
    WebHostViews,
    WebHostWorkspace,
} from '../src/host/web-host-environment';
import { NotificationService } from '../src/notifications/notification-service';
import { StatusBarService } from '../src/status/status-bar-service';
import { createMock } from './test-mock';

describe('WebHostEnvironment', () => {
    const mockRemoteHost = createMock<RemoteHostSystem>({
        fs: createMock<HostFs>({
            readTextFile: vi.fn(),
            writeTextFile: vi.fn(),
        }),
        platform: 'linux',
    });

    it('initializes all host sub-services correctly and handles trailing slashes', () => {
        const env = new WebHostEnvironment(mockRemoteHost, '/path/to/my-repo/');
        expect(env.system).toBe(mockRemoteHost);
        expect(env.workspace.workspaceFolders?.length).toBe(1);
        expect(env.workspace.workspaceFolders?.[0]?.name).toBe('my-repo');
        expect(env.workspace.workspaceFolders?.[0]?.uri.path).toBe('/path/to/my-repo/');
        expect(env.ui).toBeInstanceOf(WebHostUi);
        expect(env.notifications).toBeInstanceOf(NotificationService);
        expect(env.statusBar).toBeInstanceOf(StatusBarService);
        expect(env.nav).toBeInstanceOf(WebHostNavigation);
        expect(env.config).toBeInstanceOf(WebHostConfig);
        expect(env.documents).toBeInstanceOf(WebHostDocuments);
        expect(env.storage).toBeInstanceOf(WebHostStorage);
        expect(env.secrets).toBeInstanceOf(WebHostSecrets);
        expect(env.auth).toBeInstanceOf(WebHostAuth);
        expect(env.commands).toBeInstanceOf(WebHostCommands);
        expect(env.views).toBeInstanceOf(WebHostViews);
        expect(env.workspace).toBeInstanceOf(WebHostWorkspace);
        expect(env.extensions.hasExtension('any')).toBe(false);
    });

    describe('WebHostConfig', () => {
        it('gets, sets, returns default config values, and fires onDidChangeConfiguration', async () => {
            const config = new WebHostConfig();
            const changeListener = vi.fn();
            config.onDidChangeConfiguration(changeListener);

            expect(config.get('missingKey')).toBeUndefined();
            expect(config.get('missingKey', 'defaultVal')).toBe('defaultVal');

            await config.update('jj-view.fileWatcherMode', 'watch');
            expect(config.get('jj-view.fileWatcherMode')).toBe('watch');
            expect(config.get('jj-view.fileWatcherMode', 'polling')).toBe('watch');

            expect(changeListener).toHaveBeenCalledTimes(1);
            const event = changeListener.mock.calls[0][0];
            expect(event.affectsConfiguration('jj-view')).toBe(true);
            expect(event.affectsConfiguration('other')).toBe(false);
        });
    });

    describe('WebHostStorage', () => {
        it('stores, retrieves, and returns defaults', async () => {
            const storage = new WebHostStorage();
            expect(storage.get('unknown')).toBeUndefined();
            expect(storage.get('unknown', 'def')).toBe('def');

            await storage.update('myKey', { foo: 'bar' });
            expect(storage.get('myKey')).toEqual({ foo: 'bar' });
        });
    });

    describe('WebHostSecrets', () => {
        it('stores, retrieves, and deletes secrets', async () => {
            const secrets = new WebHostSecrets();
            expect(await secrets.get('token')).toBeUndefined();

            await secrets.store('token', 'secret-val');
            expect(await secrets.get('token')).toBe('secret-val');

            await secrets.delete('token');
            expect(await secrets.get('token')).toBeUndefined();
        });
    });

    describe('WebHostCommands', () => {
        it('registers, executes, and disposes commands', async () => {
            const commands = new WebHostCommands();
            const fn = vi.fn((x: number) => x * 2);

            const disposable = commands.registerCommand('test.double', fn);
            const result = await commands.executeCommand<number>('test.double', 21);
            expect(result).toBe(42);
            expect(fn).toHaveBeenCalledWith(21);

            disposable.dispose();
            const missingResult = await commands.executeCommand('test.double', 21);
            expect(missingResult).toBeUndefined();
        });

        it('forwards context key updates to ContextKeySetter', async () => {
            const commands = new WebHostCommands();
            const mockSetter = createMock<ContextKeySetter>({
                set: vi.fn(),
            });

            commands.setContextKeySetter(mockSetter);
            await commands.setContextKey('jj.parentMutable', true);
            expect(mockSetter.set).toHaveBeenCalledWith('jj.parentMutable', true);
        });
    });

    describe('WebHostNavigation', () => {
        it('calls navigation callbacks when provided and updated via setCallbacks', async () => {
            const onOpenDiff = vi.fn();
            const onOpenFile = vi.fn();
            const nav = new WebHostNavigation({ onOpenDiff, onOpenFile });

            const left = Uri.file('/left.txt');
            const right = Uri.file('/right.txt');
            await nav.openDiff(left, right, 'Diff Title');
            expect(onOpenDiff).toHaveBeenCalledWith(left, right, 'Diff Title');

            await nav.openFile(right);
            expect(onOpenFile).toHaveBeenCalledWith(right);

            const newOpenDiff = vi.fn();
            nav.setCallbacks({ onOpenDiff: newOpenDiff });
            await nav.openDiff(left, right, 'Diff Title 2');
            expect(newOpenDiff).toHaveBeenCalledWith(left, right, 'Diff Title 2');
        });

        it('routes highlightCommit to onHighlightCommit callback and setHighlightDelegate', () => {
            const onHighlightCommit = vi.fn();
            const nav = new WebHostNavigation({ onHighlightCommit });
            const repoRoot = Uri.file('/path/to/repo');

            // Calls callback
            nav.highlightCommit(repoRoot, 'change-abc');
            expect(onHighlightCommit).toHaveBeenCalledWith(repoRoot, 'change-abc');

            // Calls delegate when registered (priority over callbacks)
            const delegate = vi.fn();
            nav.setHighlightDelegate(delegate);
            nav.highlightCommit(repoRoot, 'change-xyz');
            expect(delegate).toHaveBeenCalledWith(repoRoot, 'change-xyz');
            expect(onHighlightCommit).toHaveBeenCalledTimes(1);

            // Clear highlight with undefined
            nav.highlightCommit(repoRoot, undefined);
            expect(delegate).toHaveBeenCalledWith(repoRoot, undefined);

            // Does not throw when no delegate or callback is set
            const bareNav = new WebHostNavigation();
            expect(() => bareNav.highlightCommit(repoRoot, 'rev')).not.toThrow();
        });
    });

    describe('WebHostDocuments', () => {
        it('reads line ranges and clamps start index safely', async () => {
            const fileContent = 'line 1\nline 2\nline 3\nline 4\nline 5';
            const readTextFile = vi.fn().mockResolvedValue(fileContent);
            const hostSystem = createMock<RemoteHostSystem>({
                fs: createMock<HostFs>({ readTextFile, writeTextFile: vi.fn() }),
            });

            const docs = new WebHostDocuments(hostSystem);
            const rangeText = await docs.readLineRangeText(Uri.file('/test.txt'), 2, 4);
            expect(rangeText).toBe('line 2\nline 3\nline 4');

            // startLine1Based <= 0 must clamp to 0 instead of negative index slice
            const startClamped = await docs.readLineRangeText(Uri.file('/test.txt'), 0, 2);
            expect(startClamped).toBe('line 1\nline 2');
        });

        it('replaces line ranges with multi-line text', async () => {
            const fileContent = 'line 1\nline 2\nline 3\nline 4\nline 5';
            const readTextFile = vi.fn().mockResolvedValue(fileContent);
            const writeTextFile = vi.fn().mockResolvedValue(undefined);
            const hostSystem = createMock<RemoteHostSystem>({
                fs: createMock<HostFs>({ readTextFile, writeTextFile }),
            });

            const docs = new WebHostDocuments(hostSystem);
            await docs.replaceLineRangeAndSave(
                Uri.file('/test.txt'),
                { startLine1Based: 2, endLine1Based: 3 },
                'new 2\nnew 3',
            );
            expect(writeTextFile).toHaveBeenCalledWith(
                expect.stringContaining('test.txt'),
                'line 1\nnew 2\nnew 3\nline 4\nline 5',
            );
        });

        it('handles pure deletion (discarding additions) without inserting empty lines', async () => {
            const fileContent = 'line 1\nline 2\nline 3\nline 4';
            const readTextFile = vi.fn().mockResolvedValue(fileContent);
            const writeTextFile = vi.fn().mockResolvedValue(undefined);
            const hostSystem = createMock<RemoteHostSystem>({
                fs: createMock<HostFs>({ readTextFile, writeTextFile }),
            });

            const docs = new WebHostDocuments(hostSystem);
            await docs.replaceLineRangeAndSave(Uri.file('/test.txt'), { startLine1Based: 2, endLine1Based: 3 }, '');
            expect(writeTextFile).toHaveBeenCalledWith(expect.stringContaining('test.txt'), 'line 1\nline 4');
        });

        it('handles pure insertion (restoring deletions) at line 0 and intermediate lines', async () => {
            const fileContent = 'line 1\nline 2';
            const readTextFile = vi.fn().mockResolvedValue(fileContent);
            const writeTextFile = vi.fn().mockResolvedValue(undefined);
            const hostSystem = createMock<RemoteHostSystem>({
                fs: createMock<HostFs>({ readTextFile, writeTextFile }),
            });

            const docs = new WebHostDocuments(hostSystem);
            await docs.replaceLineRangeAndSave(
                Uri.file('/test.txt'),
                { startLine1Based: 0, endLine1Based: 0 },
                'header',
            );
            expect(writeTextFile).toHaveBeenCalledWith(expect.stringContaining('test.txt'), 'header\nline 1\nline 2');
        });

        it('preserves CRLF line endings', async () => {
            const fileContent = 'line 1\r\nline 2\r\nline 3';
            const readTextFile = vi.fn().mockResolvedValue(fileContent);
            const writeTextFile = vi.fn().mockResolvedValue(undefined);
            const hostSystem = createMock<RemoteHostSystem>({
                fs: createMock<HostFs>({ readTextFile, writeTextFile }),
            });

            const docs = new WebHostDocuments(hostSystem);
            await docs.replaceLineRangeAndSave(
                Uri.file('/test.txt'),
                { startLine1Based: 2, endLine1Based: 2 },
                'updated 2',
            );
            expect(writeTextFile).toHaveBeenCalledWith(
                expect.stringContaining('test.txt'),
                'line 1\r\nupdated 2\r\nline 3',
            );
        });
    });

    describe('WebHostUi', () => {
        it('executes withProgress task directly when no service is set', async () => {
            const ui = new WebHostUi();
            const res = await ui.withProgress('Progress title', async () => 'done');
            expect(res).toBe('done');
        });

        it('shows notifications without throwing when no service is set', async () => {
            const ui = new WebHostUi();
            await expect(ui.showInformation('info')).resolves.toBeUndefined();
            await expect(ui.showWarning('warn')).resolves.toBeUndefined();
        });

        it('delegates notifications to NotificationService', async () => {
            const notifService = new NotificationService();
            const ui = new WebHostUi(undefined, notifService);

            const promise = ui.showInformation('Test Info', 'Action 1');
            expect(notifService.items).toHaveLength(1);
            expect(notifService.items[0].message).toBe('Test Info');

            notifService.triggerAction(notifService.items[0].id, 'Action 1');
            const action = await promise;
            expect(action).toBe('Action 1');
        });

        it('delegates status messages and progress to StatusBarService', async () => {
            const statusBarService = new StatusBarService();
            const ui = new WebHostUi(undefined, undefined, statusBarService);

            ui.setStatusBarMessage('Working...', 5000);
            expect(statusBarService.state.statusMessage?.text).toBe('Working...');

            const res = await ui.withProgress('In Flight', async () => {
                expect(statusBarService.state.progress.title).toBe('In Flight');
                return 42;
            });
            expect(res).toBe(42);
            expect(statusBarService.state.progress.active).toBe(false);
        });

        it('tracks active and focused window state and fires change events', () => {
            const ui = new WebHostUi();
            expect(ui.isActive).toBe(true);
            expect(ui.isFocused).toBe(true);

            const activeEvents: boolean[] = [];
            const focusEvents: boolean[] = [];

            const d1 = ui.onDidChangeActive((active) => activeEvents.push(active));
            const d2 = ui.onDidChangeFocus((focused) => focusEvents.push(focused));

            // Change to inactive / blurred
            ui.setActiveState(false);
            expect(ui.isActive).toBe(false);
            expect(ui.isFocused).toBe(false);
            expect(activeEvents).toEqual([false]);
            expect(focusEvents).toEqual([false]);

            // Redundant call should not emit
            ui.setActiveState(false);
            expect(activeEvents).toEqual([false]);
            expect(focusEvents).toEqual([false]);

            // Change back to active
            ui.setActiveState(true);
            expect(ui.isActive).toBe(true);
            expect(ui.isFocused).toBe(true);
            expect(activeEvents).toEqual([false, true]);
            expect(focusEvents).toEqual([false, true]);

            d1.dispose();
            d2.dispose();
            ui.dispose();
        });

        it('cleans up window and document listeners on dispose', () => {
            const addWindowListener = vi.fn();
            const removeWindowListener = vi.fn();
            const addDocListener = vi.fn();
            const removeDocListener = vi.fn();

            const originalWindow = globalThis.window;
            const originalDoc = globalThis.document;

            try {
                globalThis.window = createMock<Window & typeof globalThis>({
                    addEventListener: addWindowListener,
                    removeEventListener: removeWindowListener,
                });
                globalThis.document = createMock<Document>({
                    hidden: false,
                    hasFocus: () => true,
                    addEventListener: addDocListener,
                    removeEventListener: removeDocListener,
                });

                const ui = new WebHostUi();
                expect(addWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
                expect(addWindowListener).toHaveBeenCalledWith('blur', expect.any(Function));
                expect(addDocListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

                ui.dispose();
                expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
                expect(removeWindowListener).toHaveBeenCalledWith('blur', expect.any(Function));
                expect(removeDocListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
            } finally {
                globalThis.window = originalWindow;
                globalThis.document = originalDoc;
            }
        });

        it('updates active state on window and document focus, blur, and visibility events', () => {
            const handlers = new Map<string, () => void>();
            const addWindowListener = vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
                if (typeof handler === 'function') {
                    handlers.set(`window:${event}`, handler as () => void);
                }
            });
            const addDocListener = vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
                if (typeof handler === 'function') {
                    handlers.set(`doc:${event}`, handler as () => void);
                }
            });

            const originalWindow = globalThis.window;
            const originalDoc = globalThis.document;

            let isHidden = false;
            let hasFocus = true;

            try {
                globalThis.window = createMock<Window & typeof globalThis>({
                    addEventListener: addWindowListener,
                    removeEventListener: vi.fn(),
                });
                globalThis.document = createMock<Document>({
                    get hidden() {
                        return isHidden;
                    },
                    hasFocus: () => hasFocus,
                    addEventListener: addDocListener,
                    removeEventListener: vi.fn(),
                });

                const ui = new WebHostUi();
                expect(ui.isActive).toBe(true);

                // Simulate blur
                hasFocus = false;
                handlers.get('window:blur')?.();
                expect(ui.isActive).toBe(false);

                // Simulate focus
                hasFocus = true;
                handlers.get('window:focus')?.();
                expect(ui.isActive).toBe(true);

                // Simulate tab hidden
                isHidden = true;
                handlers.get('doc:visibilitychange')?.();
                expect(ui.isActive).toBe(false);

                // Simulate tab visible
                isHidden = false;
                handlers.get('doc:visibilitychange')?.();
                expect(ui.isActive).toBe(true);

                ui.dispose();
            } finally {
                globalThis.window = originalWindow;
                globalThis.document = originalDoc;
            }
        });
    });
});
