// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { JjService } from '../jj-service';
import { JjLogWebviewProvider } from '../jj-log-webview-provider';
import { TestRepo } from './test-repo';
import { createMock, asSinonStub } from './test-utils';

suite('Webview Selection Integration Test', function () {
    this.timeout(20000);

    let jj: JjService;
    let provider: JjLogWebviewProvider;
    let messageHandler: (m: unknown) => Promise<void>;
    let executeCommandStub: sinon.SinonStub;
    let repo: TestRepo;

    // Mock Webview
    const mockWebview = createMock<vscode.Webview>({
        options: {},
        html: '',
        onDidReceiveMessage: (handler: (m: unknown) => Promise<void>) => {
            messageHandler = handler;
            return { dispose: () => {} };
        },
        asWebviewUri: (uri: vscode.Uri) => uri,
        cspSource: '',
        postMessage: async () => {
            return true;
        },
    });

    const mockWebviewView = createMock<vscode.WebviewView>({
        webview: mockWebview,
        viewType: 'jj-view.logView',
        onDidChangeVisibility: () => {
            return { dispose: () => {} };
        },
        onDidDispose: () => {
            return { dispose: () => {} };
        },
        visible: true,
    });

    setup(async () => {
        repo = new TestRepo();
        repo.init();

        jj = new JjService(repo.path);
        const extensionUri = vscode.Uri.file(__dirname); // Mock URI
        provider = new JjLogWebviewProvider(extensionUri, jj);

        // Spy on vscode.commands.executeCommand
        // Only call through for setContext; stub out jj-view.* commands to avoid "not found" errors
        executeCommandStub = sinon.stub(vscode.commands, 'executeCommand');
        executeCommandStub.callsFake(async (command: string, ...args: unknown[]) => {
            if (command === 'setContext') {
                // Call through to real setContext
                return asSinonStub(executeCommandStub).wrappedMethod.call(vscode.commands, command, ...args);
            }
            // For jj-view.* commands, just record the call (don't execute)
            return undefined;
        });

        // Initialize provider
        provider.resolveWebviewView(
            mockWebviewView,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );
        // Wait for potential initial refresh
        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    teardown(() => {
        if (executeCommandStub) {
            executeCommandStub.restore();
        }
        repo.dispose();
    });

    test('Selection Change updates Context Keys', async () => {
        // user selects 1 item, immutable=false
        await messageHandler({
            type: 'selectionChange',
            payload: {
                commitIds: ['commit-1'],
                hasImmutableSelection: false,
            },
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
        await messageHandler({
            type: 'selectionChange',
            payload: {
                commitIds: ['commit-1', 'commit-2'],
                hasImmutableSelection: false,
            },
        });

        // Verify jj.selection.allowAbandon -> true
        calls = getContextCalls('jj.selection.allowAbandon');
        assert.strictEqual(calls.at(-1)?.args[2], true, 'allowAbandon should be true for multi-mutable');

        // Verify jj.selection.allowMerge -> true
        calls = getContextCalls('jj.selection.allowMerge');
        assert.strictEqual(calls.at(-1)?.args[2], true, 'allowMerge should be true (count > 1)');

        // Test Immutable Selection
        await messageHandler({
            type: 'selectionChange',
            payload: {
                commitIds: ['commit-1'],
                hasImmutableSelection: true,
            },
        });

        // Verify jj.selection.allowAbandon -> false
        calls = getContextCalls('jj.selection.allowAbandon');
        assert.strictEqual(calls.at(-1)?.args[2], false, 'allowAbandon should be false for immutable selection');
    });

    test('Abandon command from webview triggers extension command', async () => {
        const payload = { commitId: 'commit-to-abandon' };
        await messageHandler({
            type: 'abandon',
            payload,
        });

        // It should call 'jj-view.abandon' with the payload
        const calls = executeCommandStub.getCalls().filter((call) => call.args[0] === 'jj-view.abandon');
        assert.ok(calls.length > 0, 'Should execute jj-view.abandon command');
        assert.deepStrictEqual(calls[0].args[1], payload, 'Should pass payload to command');
    });
});
