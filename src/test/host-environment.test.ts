/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { JjRepository } from '../jj-repository';
import { Uri } from '../uri-utils';
import {
    FakeCommandContext,
    FakeHostAuth,
    FakeHostCommands,
    FakeHostConfig,
    FakeHostDocuments,
    FakeHostEnvironment,
    FakeHostNavigation,
    FakeHostSecrets,
    FakeHostStorage,
    FakeHostUi,
    FakeHostViews,
} from './fake-host-environment';

describe('FakeHostEnvironment', () => {
    describe('FakeHostUi', () => {
        it('handles input box and quick pick responses', async () => {
            const ui = new FakeHostUi();
            ui.setNextInputBoxResponse('test-input');
            expect(await ui.showInputBox()).toBe('test-input');
            expect(await ui.showInputBox()).toBeUndefined();

            ui.setNextQuickPickResponse({ label: 'option1', value: 123 });
            const pick = await ui.showQuickPick([{ label: 'option1', value: 123 }]);
            expect(pick).toEqual({ label: 'option1', value: 123 });

            ui.setNextQuickPickResponse([{ label: 'multi1' }]);
            const multiPick = await ui.showMultiQuickPick([{ label: 'multi1' }]);
            expect(multiPick).toEqual([{ label: 'multi1' }]);
        });

        it('records messages, warnings, and errors', async () => {
            const ui = new FakeHostUi();
            await ui.showInformation('info msg');
            await ui.showWarning('warn msg');
            ui.setNextErrorResponse('Action1');
            const result = await ui.showErrorMessage('err msg', 'Action1', 'Action2');

            expect(result).toBe('Action1');
            expect(ui.infoMessages).toContain('info msg');
            expect(ui.warningMessages).toContain('warn msg');
            expect(ui.errorMessages).toContain('err msg');
        });

        it('handles withProgress and status bar messages', async () => {
            const ui = new FakeHostUi();
            const result = await ui.withProgress('Loading...', async () => 'done');
            expect(result).toBe('done');
            expect(ui.progressTitles).toContain('Loading...');

            ui.setStatusBarMessage('status', 1000);
            expect(ui.statusBarMessages).toEqual([{ message: 'status', timeoutMs: 1000 }]);
        });
    });

    describe('FakeHostNavigation', () => {
        it('records navigation, diffs, and clipboard actions', async () => {
            const nav = new FakeHostNavigation();
            const leftUri = Uri.file('/left.txt');
            const rightUri = Uri.file('/right.txt');

            await nav.openDiff(leftUri, rightUri, 'My Diff');
            expect(nav.diffsOpened).toEqual([{ leftUri, rightUri, title: 'My Diff' }]);

            await nav.openMultiDiff('Multi Diff', [{ leftUri, rightUri, label: 'item' }]);
            expect(nav.multiDiffsOpened).toHaveLength(1);

            await nav.openMergeEditor(leftUri);
            expect(nav.mergeEditorsOpened).toContain(leftUri);

            await nav.openFile(leftUri);
            expect(nav.filesOpened).toContain(leftUri);

            await nav.openFolder(leftUri, true);
            expect(nav.foldersOpened).toEqual([{ folderUri: leftUri, forceNewWindow: true }]);

            const extUri = Uri.parse('https://example.com');
            await nav.openExternal(extUri);
            expect(nav.externalUrisOpened).toContain(extUri);

            await nav.copyToClipboard('copied');
            expect(nav.clipboardText).toBe('copied');

            await nav.openSettings('setting.id');
            expect(nav.settingsOpened).toContain('setting.id');

            await nav.focusScmInput();
            expect(nav.focusScmInputCallCount).toBe(1);

            await nav.closeTab(leftUri);
            expect(nav.closedTabs).toContain(leftUri);

            const rootUri = Uri.file('/root');
            await nav.openCommitDetails(rootUri, 'change123', 'c12', false, 0);
            expect(nav.commitDetailsOpened).toEqual([
                {
                    repoRoot: rootUri,
                    changeId: 'change123',
                    shortestChangeId: 'c12',
                    isDivergent: false,
                    changeIdOffset: 0,
                },
            ]);
        });
    });

    describe('FakeHostConfig', () => {
        it('manages configuration values', async () => {
            const config = new FakeHostConfig();
            expect(config.get('key', 'defaultVal')).toBe('defaultVal');
            expect(config.get('key')).toBeUndefined();

            config.set('key', 'customVal');
            expect(config.get('key')).toBe('customVal');

            await config.update('key2', 42);
            expect(config.get('key2')).toBe(42);
        });
    });

    describe('FakeHostDocuments', () => {
        it('reads and replaces line ranges in virtual documents', async () => {
            const docs = new FakeHostDocuments();
            const uri = Uri.file('/test.txt');
            docs.setDocumentText(uri, 'line 1\nline 2\nline 3\nline 4');

            const text = await docs.readLineRangeText(uri, 2, 3);
            expect(text).toBe('line 2\nline 3');

            await docs.replaceLineRangeAndSave(
                uri,
                { startLine1Based: 2, endLine1Based: 3 },
                'replaced line 2\nreplaced line 3',
            );
            expect(docs.getOpenDocumentText(uri)).toBe('line 1\nreplaced line 2\nreplaced line 3\nline 4');
            expect(docs.savedUris).toContain(uri);

            await docs.saveIfDirty(uri);
            expect(docs.savedUris).toHaveLength(2);
        });
    });

    describe('FakeHostStorage, FakeHostSecrets, FakeHostAuth, FakeHostCommands, FakeHostViews', () => {
        it('manages storage and secrets', async () => {
            const storage = new FakeHostStorage();
            expect(storage.get('item', 'def')).toBe('def');
            await storage.update('item', 'val');
            expect(storage.get('item')).toBe('val');

            const secrets = new FakeHostSecrets();
            expect(await secrets.get('token')).toBeUndefined();
            await secrets.store('token', 'secret123');
            expect(await secrets.get('token')).toBe('secret123');
            await secrets.delete('token');
            expect(await secrets.get('token')).toBeUndefined();
        });

        it('manages auth sessions', async () => {
            const auth = new FakeHostAuth();
            auth.setSession('github', {
                id: 'sess1',
                accessToken: 'gh_token',
                account: { label: 'user', id: '1' },
                scopes: ['repo'],
            });
            const sess = await auth.getSession('github', ['repo']);
            expect(sess?.accessToken).toBe('gh_token');
        });

        it('registers and executes commands and context keys', async () => {
            const commands = new FakeHostCommands();
            const spy = vi.fn().mockResolvedValue('command-result');
            const disp = commands.registerCommand('test.cmd', spy);

            const result = await commands.executeCommand('test.cmd', 'arg1');
            expect(result).toBe('command-result');
            expect(spy).toHaveBeenCalledWith('arg1');
            expect(commands.executedCommands).toEqual([{ commandId: 'test.cmd', args: ['arg1'] }]);

            await commands.setContextKey('my.key', true);
            expect(commands.contextKeys.get('my.key')).toBe(true);

            disp.dispose();
            expect(await commands.executeCommand('test.cmd')).toBeUndefined();
        });

        it('manages host views', () => {
            const views = new FakeHostViews();
            const d1 = views.registerWebviewViewProvider('view1', {});
            expect(views.registeredViews.has('webview:view1')).toBe(true);
            d1.dispose();
            expect(views.registeredViews.has('webview:view1')).toBe(false);
        });
    });

    describe('FakeCommandContext', () => {
        it('bundles repo, host environment, log, and services', () => {
            const fakeRepo = { rootUri: Uri.file('/repo') } as JjRepository;
            const host = new FakeHostEnvironment();
            const ctx = new FakeCommandContext(fakeRepo, host);

            expect(ctx.repo).toBe(fakeRepo);
            expect(ctx.host).toBe(host);
            expect(ctx.log).toBeDefined();
            expect(ctx.services).toBeDefined();
        });
    });
});
