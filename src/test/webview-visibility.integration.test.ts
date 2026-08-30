/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { JjLogEntry } from '../core/jj-types';
import { Uri } from '../core/uri-utils';
import { VsCodeLogWebviewProvider } from '../vscode/providers/vscode-log-webview-provider';
import { createTestRepositoryContext, type TestRepositoryContext } from './integration-test-utils';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

interface UpdateMessage {
    type: 'update';
    payload: {
        commits: JjLogEntry[];
    };
}

function createMockWebviewView() {
    let visibilityListener!: (e: undefined) => void;
    const sentMessages: UpdateMessage[] = [];

    const mockWebview = createMock<vscode.Webview>({
        options: {},
        html: '',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: (message: unknown) => {
            if (typeof message === 'object' && message !== null && 'type' in message) {
                const msg = message as { type: string };
                if (msg.type === 'update') {
                    sentMessages.push(message as UpdateMessage);
                }
            }
            return Promise.resolve(true);
        },
        asWebviewUri: (uri: vscode.Uri) => uri,
        cspSource: 'https://*.vscode-cdn.net',
    });

    const mockWebviewView = createMock<vscode.WebviewView>({
        webview: mockWebview,
        visible: true,
        onDidChangeVisibility: (listener: (e: undefined) => void) => {
            visibilityListener = listener;
            return { dispose: () => {} };
        },
        onDidDispose: () => ({ dispose: () => {} }),
        show: () => {},
    });

    return {
        view: mockWebviewView,
        webview: mockWebview,
        sentMessages,
        triggerVisibilityChange: () => visibilityListener(undefined),
    };
}

suite('Webview Visibility Integration Test', () => {
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

        const { view, sentMessages, triggerVisibilityChange } = createMockWebviewView();
        provider.resolveWebviewView(
            view,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );

        await provider.controller.refresh();
        assert.ok(sentMessages.length >= 1, 'Should have sent initial update message');
        const initialCommits = sentMessages[sentMessages.length - 1].payload.commits;
        assert.ok(
            initialCommits.some((c: JjLogEntry) => c.description.includes('Initial Commit')),
            'Should contain initial description',
        );

        // 2. Hide the webview
        Object.defineProperty(view, 'visible', { get: () => false });
        triggerVisibilityChange();

        // 3. Perform a change while hidden
        repo.describe('Updated Commit while hidden');
        await provider.controller.refresh();

        // provider.refresh() calls _renderCommits, so it will postMessage
        const messagesCountWhileHidden = sentMessages.length;
        assert.ok(messagesCountWhileHidden >= 1);

        // 4. Show the webview
        Object.defineProperty(view, 'visible', { get: () => true });
        triggerVisibilityChange();

        // 5. Verify that a new message was sent
        assert.ok(
            sentMessages.length > messagesCountWhileHidden,
            'Should have sent an additional message when becoming visible',
        );
        const lastMessage = sentMessages[sentMessages.length - 1];
        assert.strictEqual(lastMessage.type, 'update');
        assert.ok(
            lastMessage.payload.commits.some((c: JjLogEntry) => c.description.includes('Updated Commit while hidden')),
            'Last message should contain updated data',
        );
    });
});
