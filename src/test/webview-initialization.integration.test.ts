/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { CodeForgeService } from '../code-forge-service';
import type { JjRepository } from '../jj-repository';
import { Uri } from '../uri-utils';
import { VsCodeLogWebviewProvider } from '../vscode/providers/vscode-log-webview-provider';
import { createTestRepositoryContext } from './integration-test-utils';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

function createMockWebviewView() {
    let visibilityListener!: (e: undefined) => void;

    const mockWebview = createMock<vscode.Webview>({
        options: {},
        html: '',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        asWebviewUri: (uri: Uri) => uri,
        cspSource: '',
        postMessage: async () => true,
    });

    const mockWebviewView = createMock<vscode.WebviewView>({
        webview: mockWebview,
        viewType: 'jj-view.logView',
        onDidChangeVisibility: (listener: (e: undefined) => void) => {
            visibilityListener = listener;
            return { dispose: () => {} };
        },
        onDidDispose: () => ({ dispose: () => {} }),
        visible: true,
    });

    return {
        view: mockWebviewView,
        webview: mockWebview,
        triggerVisibilityChange: () => visibilityListener(undefined),
    };
}

suite('Webview Initialization Integration Test', () => {
    let provider: VsCodeLogWebviewProvider;
    let repo: TestRepo;
    let disposables: vscode.Disposable[] = [];
    let testContext: Awaited<ReturnType<typeof createTestRepositoryContext>>;
    let extensionUri: Uri;
    let outputChannel: ReturnType<typeof createMockLogOutputChannel>;

    setup(async () => {
        repo = new TestRepo();
        await repo.init();

        outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        extensionUri = Uri.file(__dirname);
        testContext = await createTestRepositoryContext(repo.path, outputChannel);
        disposables.push(testContext);

        provider = new VsCodeLogWebviewProvider(
            extensionUri,
            testContext.repository,
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
        for (const d of disposables) {
            await d.dispose();
        }
        disposables = [];
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('resolveWebviewView sets up webview options and loads script without HTML data injection', async () => {
        // Setup repo with one commit
        repo.new();
        repo.describe('Test Commit 1');

        // 1. Initial Resolve & Refresh
        const { view: initialView, webview: initialWebview } = createMockWebviewView();
        provider.resolveWebviewView(
            initialView,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );
        await provider.controller.refresh();

        // 2. Verify HTML is clean and points to webview bundle
        const html = initialWebview.html;
        assert.ok(html.includes('dist/webview/index.js'), 'HTML should reference webview bundle');
        assert.ok(!html.includes('window.vscodeInitialData'), 'HTML should not contain initial data script injection');
    });

    test('repository getter returns undefined until updateRepository is called', async () => {
        const unattachedProvider = new VsCodeLogWebviewProvider(
            extensionUri,
            /* repo */ undefined,
            /* onSelectionChange */ () => {},
            createMock<vscode.ExtensionContext>({
                globalState: createMock<vscode.ExtensionContext['globalState']>({
                    get: () => [],
                    update: () => Promise.resolve(),
                    setKeysForSync: () => {},
                }),
            }),
            outputChannel,
        );

        assert.strictEqual(unattachedProvider.repository, undefined, 'repository should initially be undefined');

        await unattachedProvider.updateRepository(testContext.repository);
        assert.strictEqual(
            unattachedProvider.repository,
            testContext.repository,
            'repository should be updated after updateRepository call',
        );
    });

    test('updateRepository does not block on pending CodeForge detection', async () => {
        let resolveDetection!: (value: boolean) => void;
        const pendingDetection = new Promise<boolean>((resolve) => {
            resolveDetection = resolve;
        });

        const mockRepo = createMock<JjRepository>({
            rootUri: Uri.file('/tmp/slow-repo'),
            isValid: async () => true,
            jj: testContext.repository.jj,
            codeForge: createMock<CodeForgeService>({
                onDidUpdate: () => ({ dispose: () => {} }),
                detectActiveProvider: () => pendingDetection,
            }),
        });

        const unattachedProvider = new VsCodeLogWebviewProvider(
            extensionUri,
            /* repo */ undefined,
            /* onSelectionChange */ () => {},
            createMock<vscode.ExtensionContext>({
                globalState: createMock<vscode.ExtensionContext['globalState']>({
                    get: () => [],
                    update: () => Promise.resolve(),
                    setKeysForSync: () => {},
                }),
            }),
            outputChannel,
        );

        let completed = false;
        const updatePromise = unattachedProvider.updateRepository(mockRepo).then(() => {
            completed = true;
        });

        await updatePromise;
        assert.strictEqual(completed, true, 'updateRepository should complete without awaiting detectActiveProvider');
        assert.strictEqual(unattachedProvider.repository, mockRepo);

        resolveDetection(false);
    });

    test('updateRepository logs and ignores detectActiveProvider errors', async () => {
        const rejectingDetectionError = new Error('cf failed');
        let loggedError: unknown;
        const mockOutputChannel = createMockLogOutputChannel({
            error: (msg: string) => {
                loggedError = msg;
            },
        });

        const mockRepo = createMock<JjRepository>({
            rootUri: Uri.file('/tmp/reject-repo'),
            isValid: async () => true,
            jj: testContext.repository.jj,
            codeForge: createMock<CodeForgeService>({
                onDidUpdate: () => ({ dispose: () => {} }),
                detectActiveProvider: () => Promise.reject(rejectingDetectionError),
            }),
        });

        const unattachedProvider = new VsCodeLogWebviewProvider(
            extensionUri,
            /* repo */ undefined,
            /* onSelectionChange */ () => {},
            createMock<vscode.ExtensionContext>({
                globalState: createMock<vscode.ExtensionContext['globalState']>({
                    get: () => [],
                    update: () => Promise.resolve(),
                    setKeysForSync: () => {},
                }),
            }),
            mockOutputChannel,
        );

        await unattachedProvider.updateRepository(mockRepo);
        // Allow microtasks to execute the background catch handler
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.strictEqual(unattachedProvider.repository, mockRepo);
        assert.ok(
            typeof loggedError === 'string' && loggedError.includes('Code forge detection failed'),
            'outputChannel.error should be called when detectActiveProvider rejects',
        );
    });
});
