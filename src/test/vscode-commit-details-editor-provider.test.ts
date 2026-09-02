/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import { CodeForgeRegistry } from '../core/code-forge-registry';
import {
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
    type CommitDetailsPayload,
    CommitDetailsToHostMessageSchema,
} from '../core/host/ipc/commit-details-schemas';
import type { RpcReceiverHandlers } from '../core/host/webview-rpc-dispatcher';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { createCommitDetailsUri, Uri } from '../core/uri-utils';
import {
    JjCommitDocument,
    VsCodeCommitDetailsEditorProvider,
} from '../vscode/providers/vscode-commit-details-editor-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMockWebviewClient } from './mock-webview-client';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

function createCommitDetailsClient(handlers?: Partial<RpcReceiverHandlers<CommitDetailsHostToWebviewMessage, 'type'>>) {
    const receivedUpdates: CommitDetailsPayload[] = [];
    const client = createMockWebviewClient({
        toHostSchema: CommitDetailsToHostMessageSchema,
        hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        handlers: {
            update: (payload) => {
                receivedUpdates.push(payload);
            },
            ...handlers,
        },
    });

    return {
        ...client,
        receivedUpdates,
    };
}

describe('VsCodeCommitDetailsEditorProvider Unit & Concurrency Tests', () => {
    let testRepo: TestRepo;
    let testRepo2: TestRepo | undefined;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let provider: VsCodeCommitDetailsEditorProvider;
    let extensionContext: vscode.ExtensionContext;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();
        testRepo.writeFile('file.txt', 'initial content\n');
        testRepo.describe('initial commit');

        fakeHost = new FakeHostEnvironment();
        fakeHost.workspace.addFolder(Uri.file(testRepo.path));

        const registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        repositoryManager = new JjRepositoryManager(registry, outputChannel, fakeHost);
        await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));

        extensionContext = createMock<vscode.ExtensionContext>({
            subscriptions: [],
        });

        provider = new VsCodeCommitDetailsEditorProvider(
            Uri.file('/extension/path'),
            repositoryManager,
            extensionContext,
        );
    });

    afterEach(async () => {
        provider.dispose();
        await repositoryManager.dispose();
        testRepo.dispose();
        testRepo2?.dispose();
        testRepo2 = undefined;
    });

    test('switching/reopening tabs preserves controller lifecycle and delivers commit details to new webview', async () => {
        const changeId = testRepo.getChangeId('@');
        const repoRoot = Uri.file(testRepo.path);
        const docUri = createCommitDetailsUri({
            repoRoot: testRepo.path,
            changeId,
            title: `Commit: ${changeId}`,
        });
        const document = new JjCommitDocument(docUri, changeId, repoRoot);
        const cancellationToken = createMock<vscode.CancellationToken>({
            isCancellationRequested: false,
        });

        // 1. First tab opens and loads details
        const client1 = createCommitDetailsClient();
        await provider.resolveCustomEditor(document, client1.panel, cancellationToken);
        await client1.sender.webviewLoaded();

        // Verify client1 received the commit update
        expect(client1.receivedUpdates.length).toBeGreaterThanOrEqual(1);

        // 2. User switches commits or re-opens commit -> second tab opens for the same commit
        const client2 = createCommitDetailsClient();
        const resolvePromise = provider.resolveCustomEditor(document, client2.panel, cancellationToken);

        // 3. The first tab is closed (e.g. by closeOtherCommitDetailsTabs or user closing tab)
        client1.dispose();

        await resolvePromise;

        // 4. Client 2 finishes rendering HTML and sends webviewLoaded
        await client2.sender.webviewLoaded();

        // 5. Check if client2 receives the commit details payload
        expect(client2.receivedUpdates.length).toBeGreaterThanOrEqual(1);
        expect(client2.receivedUpdates[0]).toEqual(
            expect.objectContaining({
                changeId,
            }),
        );
    });

    test('concurrent refresh during custom editor resolution does not dispose the webview panel', async () => {
        const changeId = testRepo.getChangeId('@');
        const repoRoot = Uri.file(testRepo.path);
        const docUri = createCommitDetailsUri({
            repoRoot: testRepo.path,
            changeId,
            title: `Commit: ${changeId}`,
        });
        const document = new JjCommitDocument(docUri, changeId, repoRoot);
        const cancellationToken = createMock<vscode.CancellationToken>({
            isCancellationRequested: false,
        });

        const client = createCommitDetailsClient();
        const disposeSpy = vi.spyOn(client.panel, 'dispose');
        const resolvePromise = provider.resolveCustomEditor(document, client.panel, cancellationToken);

        // Concurrent background refresh occurs while load() is in flight
        await provider.refresh();

        await resolvePromise;

        // Panel should NOT have been disposed
        expect(disposeSpy).not.toHaveBeenCalled();

        await client.sender.webviewLoaded();
        expect(client.receivedUpdates.length).toBeGreaterThanOrEqual(1);
    });

    test('isolates controllers across different repository roots in multi-root workspaces', async () => {
        testRepo2 = new TestRepo();
        testRepo2.init();
        testRepo2.writeFile('file2.txt', 'repo2 content\n');
        testRepo2.describe('repo2 commit');

        fakeHost.workspace.addFolder(Uri.file(testRepo2.path));
        await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo2.path));

        const cancellationToken = createMock<vscode.CancellationToken>({
            isCancellationRequested: false,
        });

        // Use '@' for both repos
        const doc1 = new JjCommitDocument(
            createCommitDetailsUri({ repoRoot: testRepo.path, changeId: '@', title: 'Commit: @' }),
            '@',
            Uri.file(testRepo.path),
        );
        const doc2 = new JjCommitDocument(
            createCommitDetailsUri({ repoRoot: testRepo2.path, changeId: '@', title: 'Commit: @' }),
            '@',
            Uri.file(testRepo2.path),
        );

        const client1 = createCommitDetailsClient();
        const client2 = createCommitDetailsClient();

        await provider.resolveCustomEditor(doc1, client1.panel, cancellationToken);
        await provider.resolveCustomEditor(doc2, client2.panel, cancellationToken);

        const controller1 = provider.getController('@', Uri.file(testRepo.path));
        const controller2 = provider.getController('@', Uri.file(testRepo2.path));

        expect(controller1).toBeDefined();
        expect(controller2).toBeDefined();
        expect(controller1).not.toBe(controller2);
        expect(controller1?.repo?.rootUri.fsPath).toBeSameFsPath(testRepo.path);
        expect(controller2?.repo?.rootUri.fsPath).toBeSameFsPath(testRepo2.path);

        client1.dispose();
        client2.dispose();
    });

    test('refresh() reloads all open controllers and pushes updated repository state to webviews', async () => {
        testRepo.writeFile('file1.txt', 'commit 1 content\n');
        testRepo.describe('commit 1');
        const changeId1 = testRepo.getChangeId('@');

        testRepo.new(['@'], 'commit 2');
        testRepo.writeFile('file2.txt', 'commit 2 content\n');
        const changeId2 = testRepo.getChangeId('@');

        const repoRoot = Uri.file(testRepo.path);
        const cancellationToken = createMock<vscode.CancellationToken>({ isCancellationRequested: false });

        const doc1 = new JjCommitDocument(
            createCommitDetailsUri({ repoRoot: testRepo.path, changeId: changeId1, title: `Commit: ${changeId1}` }),
            changeId1,
            repoRoot,
        );
        const doc2 = new JjCommitDocument(
            createCommitDetailsUri({ repoRoot: testRepo.path, changeId: changeId2, title: `Commit: ${changeId2}` }),
            changeId2,
            repoRoot,
        );

        const client1 = createCommitDetailsClient();
        const client2 = createCommitDetailsClient();

        await provider.resolveCustomEditor(doc1, client1.panel, cancellationToken);
        await provider.resolveCustomEditor(doc2, client2.panel, cancellationToken);

        // Initial webview handshake via typed RPC sender
        await client1.sender.webviewLoaded();
        await client2.sender.webviewLoaded();

        expect(client1.receivedUpdates[0]).toEqual(
            expect.objectContaining({
                changeId: changeId1,
                description: 'commit 1',
            }),
        );
        expect(client2.receivedUpdates[0]).toEqual(
            expect.objectContaining({
                changeId: changeId2,
                description: 'commit 2',
            }),
        );

        // 1. Modify both commits externally in Jujutsu
        testRepo.describe('commit 1 updated description', changeId1);
        testRepo.describe('commit 2 updated description', changeId2);

        // 2. Trigger provider.refresh()
        await provider.refresh();

        // 3. Verify both webviews received the updated state via RPC receiver
        expect(client1.receivedUpdates.length).toBeGreaterThanOrEqual(2);
        expect(client2.receivedUpdates.length).toBeGreaterThanOrEqual(2);

        const client1Latest = client1.receivedUpdates[client1.receivedUpdates.length - 1];
        const client2Latest = client2.receivedUpdates[client2.receivedUpdates.length - 1];

        expect(client1Latest).toEqual(
            expect.objectContaining({
                changeId: changeId1,
                description: 'commit 1 updated description',
            }),
        );
        expect(client2Latest).toEqual(
            expect.objectContaining({
                changeId: changeId2,
                description: 'commit 2 updated description',
            }),
        );

        client1.dispose();
        client2.dispose();
    });
});
