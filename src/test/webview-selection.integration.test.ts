/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    type LogViewHostToWebviewMessage,
    LogViewHostToWebviewMessageSchema,
    type LogViewToHostMessage,
    LogViewToHostMessageSchema,
} from '../core/host/ipc/log-view-schemas';
import { Uri } from '../core/uri-utils';
import { VsCodeLogWebviewProvider } from '../vscode/providers/vscode-log-webview-provider';
import { createTestRepositoryContext, type TestRepositoryContext } from './integration-test-utils';
import { createMockWebviewClient, type MockWebviewClient } from './mock-webview-client';
import { TestRepo } from './test-repo';
import { asSinonStub, createMock, createMockLogOutputChannel } from './test-utils';

suite('Webview Selection Integration Test', () => {
    let provider: VsCodeLogWebviewProvider;
    let client: MockWebviewClient<LogViewToHostMessage, LogViewHostToWebviewMessage>;
    let executeCommandStub: sinon.SinonStub;
    let repo: TestRepo;
    let contextHelper: TestRepositoryContext;

    setup(async () => {
        repo = new TestRepo();
        repo.init();

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

        // Spy on vscode.commands.executeCommand; stub jj-view.* to avoid errors
        executeCommandStub = sinon.stub(vscode.commands, 'executeCommand');
        executeCommandStub.callsFake(async (command: string, ...args: unknown[]) => {
            if (command === 'setContext') {
                // Call through to real setContext
                return asSinonStub(executeCommandStub).wrappedMethod.call(vscode.commands, command, ...args);
            }
            // For jj-view.* commands, just record the call (don't execute)
            return undefined;
        });

        client = createMockWebviewClient({
            toHostSchema: LogViewToHostMessageSchema,
            hostToWebviewSchema: LogViewHostToWebviewMessageSchema,
        });

        // Initialize provider
        provider.resolveWebviewView(
            client.view,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );
    });

    teardown(async () => {
        client.dispose();
        if (executeCommandStub) {
            executeCommandStub.restore();
        }
        if (contextHelper) {
            await contextHelper.dispose();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('Selection Change updates Context Keys', async () => {
        // user selects 1 item, immutable=false
        await client.sender.selectionChange({
            commitIds: ['commit-1'],
            hasImmutableSelection: false,
        });

        const getContextCalls = (key: string) =>
            executeCommandStub.getCalls().filter((call) => call.args[0] === 'setContext' && call.args[1] === key);

        // Verify jj.selection.allowAbandon -> true
        let calls = getContextCalls('jj.selection.allowAbandon');
        assert.strictEqual(calls.at(-1)?.args[2], true, 'allowAbandon should be true for mutable selection');

        // Verify jj.selection.allowMerge -> false
        calls = getContextCalls('jj.selection.allowMerge');
        assert.strictEqual(calls.at(-1)?.args[2], false, 'allowMerge should be false (count=1)');

        // Test Multi-Selection (2 items)
        await client.sender.selectionChange({
            commitIds: ['commit-1', 'commit-2'],
            hasImmutableSelection: false,
        });

        // Verify jj.selection.allowAbandon -> true
        calls = getContextCalls('jj.selection.allowAbandon');
        assert.strictEqual(calls.at(-1)?.args[2], true, 'allowAbandon should be true for multi-mutable');

        // Verify jj.selection.allowMerge -> true
        calls = getContextCalls('jj.selection.allowMerge');
        assert.strictEqual(calls.at(-1)?.args[2], true, 'allowMerge should be true (count > 1)');

        // Test Immutable Selection
        await client.sender.selectionChange({
            commitIds: ['commit-1'],
            hasImmutableSelection: true,
        });

        // Verify jj.selection.allowAbandon -> false
        calls = getContextCalls('jj.selection.allowAbandon');
        assert.strictEqual(calls.at(-1)?.args[2], false, 'allowAbandon should be false for immutable selection');

        // Verify jj.selection.allowNewBefore -> false
        calls = getContextCalls('jj.selection.allowNewBefore');
        assert.strictEqual(calls.at(-1)?.args[2], false, 'allowNewBefore should be false for immutable selection');
    });

    test('Abandon command from webview triggers extension command', async () => {
        const payload = { changeId: 'commit-to-abandon' };
        await client.sender.abandon(payload);

        // It should call 'jj-view.abandon' with the payload
        const calls = executeCommandStub.getCalls().filter((call) => call.args[0] === 'jj-view.abandon');
        assert.ok(calls.length > 0, 'Should execute jj-view.abandon command');
        assert.deepStrictEqual(calls[0].args[1], payload, 'Should pass payload to command');
    });
});
