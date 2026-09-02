/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as vscode from 'vscode';
import {
    type LogViewHostToWebviewMessage,
    LogViewHostToWebviewMessageSchema,
    type LogViewToHostMessage,
    LogViewToHostMessageSchema,
} from '../core/host/ipc/log-view-schemas';
import type { JjLogEntry } from '../core/jj-types';
import { Uri } from '../core/uri-utils';
import { VsCodeLogWebviewProvider } from '../vscode/providers/vscode-log-webview-provider';
import { createTestRepositoryContext, type TestRepositoryContext } from './integration-test-utils';
import { createMockWebviewClient } from './mock-webview-client';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

suite('Log Webview Visibility Integration Test', () => {
    let provider: VsCodeLogWebviewProvider;
    let repo: TestRepo;
    let disposables: vscode.Disposable[] = [];
    let contextHelper: TestRepositoryContext;

    setup(async () => {
        repo = new TestRepo();
        await repo.init();

        const extensionUri = Uri.file(__dirname);
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        contextHelper = await createTestRepositoryContext(repo.path, outputChannel);

        provider = new VsCodeLogWebviewProvider(
            extensionUri,
            contextHelper.repository,
            () => {},
            createMock<vscode.ExtensionContext>({
                globalState: createMock<vscode.ExtensionContext['globalState']>({
                    get: () => [],
                    update: () => Promise.resolve(),
                    setKeysForSync: () => {},
                }),
            }),
            outputChannel,
        );
    });

    teardown(async () => {
        disposables.forEach((d) => {
            d.dispose();
        });
        disposables = [];
        if (contextHelper) {
            await contextHelper.dispose();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('webview re-renders when becoming visible', async () => {
        // 1. Initial setup with one commit
        repo.describe('Initial Commit');

        const client = createMockWebviewClient<LogViewToHostMessage, LogViewHostToWebviewMessage>({
            toHostSchema: LogViewToHostMessageSchema,
            hostToWebviewSchema: LogViewHostToWebviewMessageSchema,
        });

        provider.resolveWebviewView(
            client.view,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );

        await provider.controller.refresh();
        const updateMessages = client.receivedMessages.filter((m) => m.type === 'update');
        assert.ok(updateMessages.length >= 1, 'Should have sent initial update message');
        const initialCommits = updateMessages[updateMessages.length - 1].payload.commits;
        assert.ok(
            initialCommits.some((c: JjLogEntry) => c.description.includes('Initial Commit')),
            'Should contain initial description',
        );

        // 2. Hide the webview
        client.triggerVisibilityChange(false);

        // 3. Perform a change while hidden
        repo.describe('Updated Commit while hidden');
        await provider.controller.refresh();

        const messagesCountWhileHidden = client.receivedMessages.filter((m) => m.type === 'update').length;
        assert.ok(messagesCountWhileHidden >= 1);

        // 4. Show the webview
        client.triggerVisibilityChange(true);
        await new Promise((resolve) => setTimeout(resolve, 50));

        // 5. Verify that a new message was sent
        const messagesAfterVisible = client.receivedMessages.filter((m) => m.type === 'update');
        assert.ok(
            messagesAfterVisible.length > messagesCountWhileHidden,
            'Should have sent an additional message when becoming visible',
        );
        const lastMessage = messagesAfterVisible[messagesAfterVisible.length - 1];
        assert.strictEqual(lastMessage.type, 'update');
        assert.ok(
            lastMessage.payload.commits.some((c: JjLogEntry) => c.description.includes('Updated Commit while hidden')),
            'Last message should contain updated data',
        );

        client.dispose();
    });
});
