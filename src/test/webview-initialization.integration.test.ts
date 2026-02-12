/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { JjService } from '../jj-service';
import { JjLogWebviewProvider } from '../jj-log-webview-provider';
import { GerritService } from '../gerrit-service';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

function createMockWebviewView() {
    let visibilityListener: (e: void) => void | undefined;
    
    const mockWebview = createMock<vscode.Webview>({
        options: {},
        html: '',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        asWebviewUri: (uri: vscode.Uri) => uri,
        cspSource: '',
        postMessage: async () => true,
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
        triggerVisibilityChange: () => visibilityListener?.() 
    };
}

suite('Webview Initialization Integration Test', function () {
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
        provider = new JjLogWebviewProvider(extensionUri, jj, gerritService, () => {});
    });

    teardown(async () => {
        disposables.forEach((d) => d.dispose());
        disposables = [];
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('resolveWebviewView injects cached commits into HTML', async () => {
        // Setup repo with one commit
        repo.new();
        repo.describe('Test Commit 1');
        const id1 = repo.getChangeId('@');
        
        // 1. Initial Resolve & Refresh to populate cache
        const { view: initialView } = createMockWebviewView();
        provider.resolveWebviewView(
            initialView,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );
        await provider.refresh();

        // 2. Simulate Refocus: Create NEW view and resolve it
        const { view: newView, webview: newWebview } = createMockWebviewView();
        provider.resolveWebviewView(
            newView,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );

        // 3. Verify HTML contains cached data
        const html = newWebview.html;
        assert.ok(html.includes('window.vscodeInitialData ='), 'HTML should contain initial data injection');
        assert.ok(html.includes(id1), 'HTML should contain the commit ID from the cache');
        assert.ok(html.includes('Test Commit 1'), 'HTML should contain the description from the cache');
    });

    test('webview.html is updated when view becomes hidden', async () => {
        // Setup repo with one commit
        repo.new();
        repo.describe('Test Commit 2');
        const id2 = repo.getChangeId('@');

        // Setup View
        const { view, webview, triggerVisibilityChange } = createMockWebviewView();
        provider.resolveWebviewView(
            view,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );
        
        // Populate cache
        await provider.refresh();
        const htmlBefore = webview.html;

        // Simulate Hiding
        Object.defineProperty(view, 'visible', { get: () => false });
        triggerVisibilityChange();

        // Verify HTML updated
        const htmlAfter = webview.html;
        assert.notStrictEqual(htmlAfter, htmlBefore, 'HTML should be updated when view becomes hidden');
        assert.ok(htmlAfter.includes('window.vscodeInitialData ='), 'HTML should contain initial data');
        assert.ok(htmlAfter.includes(id2), 'HTML should contain the commit ID from the cache');
        assert.ok(htmlAfter.includes('Test Commit 2'), 'HTML should contain the description from the cache');
    });
});
