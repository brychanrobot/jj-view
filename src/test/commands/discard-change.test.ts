/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMock } from '../test-utils';
import * as path from 'path';
import * as fs from 'fs';
import { discardChangeCommand } from '../../commands/discard-change';
import { TestRepo } from '../test-repo';
import { JjScmProvider } from '../../jj-scm-provider';
import * as vscode from 'vscode';

// Track created documents for mocking
const mockDocuments = new Map<string, { getText: () => string; lineAt: (line: number) => { rangeIncludingLineBreak: { end: vscode.Position } }; save: () => Promise<boolean> }>();

vi.mock('vscode', () => ({
    Uri: {
        file: (filePath: string) => ({
            fsPath: filePath,
            toString: () => `file://${filePath}`,
            with: (params: { scheme: string; query: string }) => ({
                scheme: params.scheme,
                query: params.query,
                fsPath: filePath,
                toString: () => `${params.scheme}://${filePath}?${params.query}`,
            }),
        }),
    },
    Position: class {
        constructor(public line: number, public character: number) {}
    },
    Range: class {
        constructor(
            public startLine: number | vscode.Position,
            public startChar: number | vscode.Position,
            public endLine?: number,
            public endChar?: number,
        ) {}
    },
    window: {
        showErrorMessage: vi.fn(),
    },
    workspace: {
        openTextDocument: vi.fn().mockImplementation((uri: { fsPath: string; scheme?: string }) => {
            const doc = mockDocuments.get(uri.toString?.() ?? uri.fsPath);
            if (doc) return Promise.resolve(doc);
            // Fallback: read from filesystem
            const content = fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, 'utf-8') : '';
            const lines = content.split('\n');
            return Promise.resolve({
                getText: (range?: { startLine: number; startChar: number }) => {
                    if (!range) return content;
                    // Simplified range extraction
                    return content;
                },
                lineAt: (line: number) => ({
                    rangeIncludingLineBreak: {
                        end: { line, character: (lines[line] || '').length + 1 },
                    },
                }),
                save: vi.fn().mockResolvedValue(true),
            });
        }),
        applyEdit: vi.fn().mockResolvedValue(true),
    },
    WorkspaceEdit: class {
        private edits: Array<{ uri: vscode.Uri; range: vscode.Range; text: string }> = [];
        replace(uri: vscode.Uri, range: vscode.Range, text: string) {
            this.edits.push({ uri, range, text });
        }
        getEdits() {
            return this.edits;
        }
    },
}));

describe('discardChangeCommand', () => {
    let repo: TestRepo;
    let scmProvider: JjScmProvider;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        scmProvider = createMock<JjScmProvider>({
            provideOriginalResource: (uri: vscode.Uri) =>
                uri.with({ scheme: 'jj-view', query: 'base=@&side=left' }),
        });
        mockDocuments.clear();
    });

    afterEach(() => {
        repo.dispose();
        vi.clearAllMocks();
    });

    test('returns early with invalid arguments', async () => {
        const fileName = 'invalid.txt';
        repo.writeFile(fileName, 'content\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // Test with null uri
        await discardChangeCommand(scmProvider, null as unknown as vscode.Uri, [], 0);
        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();

        // Test with invalid index
        await discardChangeCommand(scmProvider, fileUri, [], 0);
        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();

        // Test with non-array changes
        await discardChangeCommand(scmProvider, fileUri, 'invalid', 0);
        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    });

    test('validates LineChange structure', async () => {
        const fileName = 'validate.txt';
        repo.writeFile(fileName, 'content\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // Invalid change object (missing properties)
        const invalidChanges = [{ originalStartLineNumber: 1 }];
        await discardChangeCommand(scmProvider, fileUri, invalidChanges, 0);
        expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    });

    test('calls provideOriginalResource for parent content', async () => {
        const fileName = 'discard.txt';

        repo.writeFile(fileName, 'original\n');
        repo.describe('parent');
        repo.new();
        repo.writeFile(fileName, 'modified\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        const provideOriginalResourceMock = vi.fn().mockImplementation((uri: vscode.Uri) =>
            uri.with({ scheme: 'jj-view', query: 'base=@&side=left' }),
        );
        scmProvider = createMock<JjScmProvider>({
            provideOriginalResource: provideOriginalResourceMock,
        });

        const changes = [
            {
                originalStartLineNumber: 1,
                originalEndLineNumber: 1,
                modifiedStartLineNumber: 1,
                modifiedEndLineNumber: 1,
            },
        ];

        await discardChangeCommand(scmProvider, fileUri, changes, 0);

        expect(provideOriginalResourceMock).toHaveBeenCalledWith(fileUri);
    });

    test('shows error message on failure', async () => {
        const fileName = 'error.txt';
        repo.writeFile(fileName, 'content\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // Mock provideOriginalResource to return null
        scmProvider = createMock<JjScmProvider>({
            provideOriginalResource: () => null,
        });

        const changes = [
            {
                originalStartLineNumber: 1,
                originalEndLineNumber: 1,
                modifiedStartLineNumber: 1,
                modifiedEndLineNumber: 1,
            },
        ];

        await discardChangeCommand(scmProvider, fileUri, changes, 0);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining('Failed to discard change'),
        );
    });

    test('handles deletion discard (empty modified range)', async () => {
        const fileName = 'deletion.txt';
        repo.writeFile(fileName, 'keep\ndelete\n');
        repo.describe('parent');
        repo.new();
        repo.writeFile(fileName, 'keep\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // LineChange for a deletion: modifiedEndLineNumber < modifiedStartLineNumber
        const changes = [
            {
                originalStartLineNumber: 2,
                originalEndLineNumber: 2,
                modifiedStartLineNumber: 2,
                modifiedEndLineNumber: 0,
            },
        ];

        await discardChangeCommand(scmProvider, fileUri, changes, 0);

        // Should attempt to apply an edit
        expect(vscode.workspace.applyEdit).toHaveBeenCalled();
    });

    test('handles addition discard (empty original range)', async () => {
        const fileName = 'addition.txt';
        repo.writeFile(fileName, 'line1\n');
        repo.describe('parent');
        repo.new();
        repo.writeFile(fileName, 'line1\nline2\n');

        const fileUri = vscode.Uri.file(path.join(repo.path, fileName));

        // LineChange for an addition: originalEndLineNumber < originalStartLineNumber
        const changes = [
            {
                originalStartLineNumber: 2,
                originalEndLineNumber: 0,
                modifiedStartLineNumber: 2,
                modifiedEndLineNumber: 2,
            },
        ];

        await discardChangeCommand(scmProvider, fileUri, changes, 0);

        expect(vscode.workspace.applyEdit).toHaveBeenCalled();
    });
});
