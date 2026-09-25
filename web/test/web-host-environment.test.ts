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
        it('executes withProgress task directly', async () => {
            const ui = new WebHostUi();
            const res = await ui.withProgress('Progress title', async () => 'done');
            expect(res).toBe('done');
        });

        it('shows notifications without throwing', async () => {
            const ui = new WebHostUi();
            await expect(ui.showInformation('info')).resolves.toBeUndefined();
            await expect(ui.showWarning('warn')).resolves.toBeUndefined();
        });
    });
});
