/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GerritService } from '../gerrit-service';
import { JjCommitDetailsEditorProvider } from '../jj-commit-details-editor-provider';
import { JjLogWebviewProvider } from '../jj-log-webview-provider';
import { JjService } from '../jj-service';
import { JjLogEntry } from '../jj-types';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

interface UpdateMessage {
    type: 'update';
    commits: JjLogEntry[];
}

function createMockWebviewView() {
    let visibilityListener: (e: void) => void | undefined;
    const sentMessages: UpdateMessage[] = [];

    const mockWebview = createMock<vscode.Webview>({
        options: {},
        html: '',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        asWebviewUri: (uri: vscode.Uri) => uri,
        cspSource: '',
        postMessage: async (message: unknown) => {
            sentMessages.push(message as UpdateMessage);
            return true;
        },
    });

    const mockWebviewView = createMock<vscode.WebviewView>({
        webview: mockWebview,
        viewType: 'jj-view.logView',
        onDidChangeVisibility: (listener: (e: void) => void) => {
            visibilityListener = listener;
            return { dispose: () => {} };
        },
        onDidDispose: () => ({ dispose: () => {} }),
        visible: true,
    });

    return {
        view: mockWebviewView,
        webview: mockWebview,
        sentMessages,
        triggerVisibilityChange: () => visibilityListener?.(),
    };
}

suite('Webview Visibility Integration Test', function () {
    let jj: JjService;
    let provider: JjLogWebviewProvider;
    let repo: TestRepo;
    let disposables: vscode.Disposable[] = [];

    setup(async () => {
        repo = new TestRepo();
        await repo.init();

        jj = new JjService(repo.path);

        const extensionUri = vscode.Uri.file(__dirname);
        const gerritService = createMock<GerritService>({
            onDidUpdate: () => ({ dispose: () => {} }),
            isEnabled: false,
            startPolling: () => {},
            stopPolling: () => {},
            dispose: () => {},
        });
        const outputChannel = createMock<vscode.OutputChannel>({
            appendLine: (msg) => console.log(`[OutputChannel] ${msg}`),
        });
        const commitDetailsProvider = new JjCommitDetailsEditorProvider(extensionUri, jj);
        provider = new JjLogWebviewProvider(
            extensionUri,
            jj,
            gerritService,
            commitDetailsProvider,
            () => {},
            outputChannel,
        );
    });

    teardown(async () => {
        disposables.forEach((d) => d.dispose());
        disposables = [];
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        repo.dispose();
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

        await provider.refresh();
        assert.strictEqual(sentMessages.length, 1, 'Should have sent initial update message');
        const initialCommits = sentMessages[0].commits;
        assert.ok(
            initialCommits.some((c: JjLogEntry) => c.description.includes('Initial Commit')),
            'Should contain initial description',
        );

        // 2. Hide the webview
        Object.defineProperty(view, 'visible', { get: () => false });
        triggerVisibilityChange();

        // 3. Perform a change while hidden
        repo.describe('Updated Commit while hidden');
        await provider.refresh();

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
            lastMessage.commits.some((c: JjLogEntry) => c.description.includes('Updated Commit while hidden')),
            'Last message should contain updated data',
        );
    });
});
