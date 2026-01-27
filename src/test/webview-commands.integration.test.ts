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
import { JjScmProvider } from '../jj-scm-provider';
import { JjLogWebviewProvider } from '../jj-log-webview-provider';
import { abandonCommand } from '../commands/abandon';
import { squashCommand } from '../commands/squash';
import { TestRepo } from './test-repo';
import { createMock, asSinonStub } from './test-utils';

suite('Webview Commands End-to-End Integration Test', function () {
    this.timeout(20000);

    let jj: JjService;
    let scm: JjScmProvider;
    let provider: JjLogWebviewProvider;
    let messageHandler: (m: unknown) => Promise<void>;
    let repo: TestRepo;
    let disposables: vscode.Disposable[] = [];
    let executeCommandStub: sinon.SinonStub;

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
        await repo.init(); // Init repo

        // Services
        jj = new JjService(repo.path);
        const outputChannel = vscode.window.createOutputChannel('JJ View Test');
        disposables.push(outputChannel);

        // We need a context for the provider, but we can mock it
        // We need a context for the provider, but we can mock it
        const mockContext = createMock<vscode.ExtensionContext>({
            subscriptions: [],
            extensionUri: vscode.Uri.file(__dirname),
            environmentVariableCollection: createMock<vscode.GlobalEnvironmentVariableCollection>({
                getScoped: () => createMock<vscode.EnvironmentVariableCollection>({}),
            }),
            extensionMode: vscode.ExtensionMode.Test,
            // Add other props if needed by JjScmProvider constructor
        });

        scm = new JjScmProvider(mockContext, jj, repo.path, outputChannel);
        disposables.push(scm);

        const extensionUri = vscode.Uri.file(__dirname);
        provider = new JjLogWebviewProvider(extensionUri, jj);

        // Mock 'vscode.commands.executeCommand'
        executeCommandStub = sinon.stub(vscode.commands, 'executeCommand');
        executeCommandStub.callsFake(async (command: string, ...args: unknown[]) => {
            if (command === 'jj-view.abandon') {
                return abandonCommand(scm, jj, args);
            }
            if (command === 'jj-view.squash') {
                return squashCommand(scm, jj, args);
            }
            if (command === 'jj-view.refresh') {
                // In test, we can treat refresh as no-op or call scm.refresh if needed for internal state
                // But for black-box testing of JJ state effects, we don't strictly need VS Code UI refresh
                return;
            }
            return asSinonStub(executeCommandStub).wrappedMethod.call(vscode.commands, command, ...args);
        });

        // Webview Provider
        provider.resolveWebviewView(
            mockWebviewView,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );

        // Wait for setup
        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    teardown(async () => {
        if (executeCommandStub) {
            executeCommandStub.restore();
        }
        disposables.forEach((d) => d.dispose());
        disposables = [];
        await repo.dispose();
    });

    test('Abandon command flows from Webview -> Command -> JJ CLI', async () => {
        repo.new();
        repo.describe('Commit to abandon');
        const commitToAbandonId = repo.getChangeId('@');

        // 2. Simulate Webview Message
        await messageHandler({
            type: 'abandon',
            payload: {
                commitId: commitToAbandonId,
            },
        });

        await new Promise((r) => setTimeout(r, 500));

        // After abandon, the working copy should involve a new commit (or parent)
        const newHeadId = repo.getChangeId('@');
        assert.notStrictEqual(newHeadId, commitToAbandonId, 'Working copy should not be the abandoned commit');

        // Verify it's truly gone
        try {
            repo.getChangeId(commitToAbandonId);
            assert.fail('Abandoned commit should not verify');
        } catch (e) {
            // Expected
        }
    });

    test('New command creates a new change', async () => {
        const initialHead = repo.getChangeId('@');

        await messageHandler({
            type: 'new',
            payload: {},
        });

        await new Promise((r) => setTimeout(r, 500));

        const newHead = repo.getChangeId('@');
        assert.notStrictEqual(newHead, initialHead, 'Should have a new head');

        const parents = repo.getParents('@');
        assert.ok(parents.includes(initialHead), 'New head should have old head as parent');
    });

    test('New Child command creates a change with specific parent', async () => {
        repo.describe('Parent Commit');
        const parentId = repo.getChangeId('@');

        await messageHandler({
            type: 'newChild',
            payload: { commitId: parentId },
        });

        await new Promise((r) => setTimeout(r, 500));

        const childId = repo.getChangeId('@');
        assert.notStrictEqual(childId, parentId);

        const parents = repo.getParents('@');
        assert.ok(parents.includes(parentId), 'New child should have specified parent');
    });

    test('Edit command updates working copy', async () => {
        // Create a commit
        repo.new();
        repo.describe('Target Commit');
        const targetId = repo.getChangeId('@');

        // Create another commit so we aren't already editing target
        repo.new();
        repo.describe('Current Head');

        // Verify we are NOT editing target
        const currentId = repo.getChangeId('@');
        assert.notStrictEqual(currentId, targetId);

        // Send Edit
        await messageHandler({
            type: 'edit',
            payload: { commitId: targetId },
        });

        await new Promise((r) => setTimeout(r, 500));

        // Verify working copy is now targetId
        const newWcId = repo.getChangeId('@');
        assert.strictEqual(newWcId, targetId, 'Working copy should match target ID');
    });

    test('Undo command reverts changes', async () => {
        repo.new();
        repo.describe('State 1');
        const id1 = repo.getChangeId('@');

        repo.new();
        // State 2
        const id2 = repo.getChangeId('@');

        assert.notStrictEqual(id1, id2);

        // Undo
        await messageHandler({
            type: 'undo',
            payload: {},
        });

        await new Promise((r) => setTimeout(r, 1000));

        const wcId = repo.getChangeId('@');
        assert.strictEqual(wcId, id1, 'Should undo back to first commit');
    });

    test('Squash command squashes into parent', async () => {
        repo.new(['root()']);
        repo.describe('Parent');
        // 2. Setup: Child (Working Copy) with changes
        repo.new();
        repo.writeFile('file.txt', 'changes');
        repo.track('file.txt');

        const childId = repo.getChangeId('@');

        // Force snapshot of working copy changes
        repo.snapshot();

        await messageHandler({
            type: 'squash',
            payload: { commitId: childId },
        });

        const parentContent = repo.getFileContent('@-', 'file.txt');
        assert.strictEqual(parentContent, 'changes', 'Parent (@-) should contain squashed changes');
    });

    test('Move Bookmark moves bookmark', async () => {
        // 1. Create commit A and B
        repo.describe('Commit A');
        const commitA = repo.getChangeId('@');

        repo.new();
        repo.describe('Commit B');
        const commitB = repo.getChangeId('@');

        repo.bookmark('my-bookmark', commitA);

        let bookmarksA = repo.getBookmarks(commitA);
        assert.ok(bookmarksA.includes('my-bookmark'), 'Bookmark should be on A');

        await messageHandler({
            type: 'moveBookmark',
            payload: {
                bookmark: 'my-bookmark',
                targetCommitId: commitB,
            },
        });

        await new Promise((r) => setTimeout(r, 500));

        bookmarksA = repo.getBookmarks(commitA);
        assert.strictEqual(bookmarksA.includes('my-bookmark'), false, 'Bookmark should NOT be on A');

        const bookmarksB = repo.getBookmarks(commitB);
        assert.ok(bookmarksB.includes('my-bookmark'), 'Bookmark should be on B');
    });

    test('Rebase commit rebases correctly', async () => {
        // Setup graph:
        // Root -> A
        // Root -> B
        // We want to rebase B onto A.

        repo.describe('A');
        const idA = repo.getChangeId('@');

        repo.new(['root()']);
        repo.describe('B');
        const idB = repo.getChangeId('@');

        await messageHandler({
            type: 'rebaseCommit',
            payload: {
                sourceCommitId: idB,
                targetCommitId: idA,
                mode: 'source',
            },
        });

        await new Promise((r) => setTimeout(r, 1000));

        // 4. Verify B's parent is now A
        const parents = repo.getParents(idB);
        assert.strictEqual(parents[0], idA, 'B should be rebased onto A');
    });
});
