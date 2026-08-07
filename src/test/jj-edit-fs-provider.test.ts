/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjEditFileSystemProvider } from '../jj-edit-fs-provider';
import { JjRepositoryManager } from '../jj-repository-manager';
import { buildGraph, TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('JjEditFileSystemProvider', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let provider: JjEditFileSystemProvider;
    let onDidChangeFileFired: vscode.FileChangeEvent[][] = [];

    function getUri(filename: string, revision: string | null = '@') {
        const relPath = filename.startsWith('/') ? filename : `/${filename}`;
        const fragmentParams = new URLSearchParams();
        fragmentParams.set('root', repo.path);
        if (revision) {
            fragmentParams.set('revision', revision);
        }
        return vscode.Uri.from({
            scheme: 'jj-edit',
            path: relPath,
            fragment: fragmentParams.toString(),
        });
    }

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        const codeForgeRegistry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const workspaceState = createMock<vscode.Memento>({
            get: vi.fn().mockReturnValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        });

        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, workspaceState);

        // Register the real repository
        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
            uri: vscode.Uri.file(repo.path),
        });
        await repoManager.maybeRegisterRepositoryContainingUri(vscode.Uri.file(repo.path));

        provider = new JjEditFileSystemProvider(repoManager);
        provider.onDidChangeFile((events) => {
            onDidChangeFileFired.push(events);
        });
        onDidChangeFileFired = [];

        await buildGraph(repo, [
            {
                label: 'base',
                isCurrentWorkingCopy: true,
                description: 'base commit',
                files: { 'file.txt': 'hello\n', 'other.txt': 'hello other\n' },
            },
        ]);
    });

    afterEach(async () => {
        await repoManager.dispose();
    });

    it('stat returns a default file stat', async () => {
        const uri = getUri('file.txt');
        const stat = await provider.stat(uri);
        expect(stat.type).toBe(vscode.FileType.File);
        expect(stat.size).toBe(0); // It just returns a default object
    });

    it('readFile reads content from a specific revision', async () => {
        const uri = getUri('file.txt');
        const content = await provider.readFile(uri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello\n');
        expect(Buffer.from(content).toString('utf8')).toBe(repo.getFileContent('@', 'file.txt'));
    });

    it('readFile throws for missing file in revision', async () => {
        const uri = getUri('nonexistent.txt');
        await expect(provider.readFile(uri)).rejects.toThrow();
    });

    it('readFile throws for missing revision query param', async () => {
        const uri = getUri('file.txt', null);
        await expect(provider.readFile(uri)).rejects.toThrow('Missing revision');
    });

    it('writeFile modifies file in specific revision', async () => {
        const uri = getUri('file.txt');

        let writeTriggered = false;
        provider.onDidWrite = () => {
            writeTriggered = true;
        };

        const newContent = Buffer.from('hello world!\n', 'utf8');
        await provider.writeFile(uri, newContent);

        // writeFile resolves once flushWrites completes
        expect(writeTriggered).toBe(true);

        const content = await provider.readFile(uri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello world!\n');

        // Verify the repository itself has the updated content in the revision
        expect(repo.getFileContent('@', 'file.txt')).toBe('hello world!\n');

        expect(onDidChangeFileFired.length).toBeGreaterThan(0);
        const lastBatch = onDidChangeFileFired[onDidChangeFileFired.length - 1];
        expect(lastBatch.length).toBe(1);
        expect(lastBatch[0].uri.toString()).toBe(uri.toString());
        expect(lastBatch[0].type).toBe(vscode.FileChangeType.Changed);
    });

    it('writeFile resolves after batching multiple writes', async () => {
        const uri1 = getUri('file.txt');
        const uri2 = getUri('other.txt');

        const newContent1 = Buffer.from('mod1', 'utf8');
        const newContent2 = Buffer.from('mod2', 'utf8');

        // Fire both writes roughly simultaneously
        const writePromise1 = provider.writeFile(uri1, newContent1);
        const writePromise2 = provider.writeFile(uri2, newContent2);

        await Promise.all([writePromise1, writePromise2]);

        const content1 = await provider.readFile(uri1);
        const content2 = await provider.readFile(uri2);

        expect(Buffer.from(content1).toString('utf8')).toBe('mod1');
        expect(Buffer.from(content2).toString('utf8')).toBe('mod2');

        // Verify the repository itself has the updated content in the revision
        expect(repo.getFileContent('@', 'file.txt')).toBe('mod1');
        expect(repo.getFileContent('@', 'other.txt')).toBe('mod2');

        expect(onDidChangeFileFired.length).toBe(1); // They should be batched together
        const batch = onDidChangeFileFired[0];
        expect(batch.length).toBe(2);

        const uris = batch.map((e) => e.uri.toString());
        expect(uris.some((u) => u.includes('file.txt'))).toBe(true);
        expect(uris.some((u) => u.includes('other.txt'))).toBe(true);
    });

    it('invalidateCache triggers onDidChangeFile for known URIs', async () => {
        const uri1 = getUri('file.txt');
        const uri2 = getUri('other.txt');

        // Reading files adds them to known URIs
        const content1 = await provider.readFile(uri1);
        expect(Buffer.from(content1).toString('utf8')).toBe('hello\n');

        const content2 = await provider.readFile(uri2);
        expect(Buffer.from(content2).toString('utf8')).toBe('hello other\n');

        expect(onDidChangeFileFired.length).toBe(0);

        provider.invalidateCache();

        expect(onDidChangeFileFired.length).toBe(1);
        const batch = onDidChangeFileFired[0];
        expect(batch.length).toBe(2);

        const uris = batch.map((e) => e.uri.toString());
        expect(uris.some((u) => u.includes('file.txt'))).toBe(true);
        expect(uris.some((u) => u.includes('other.txt'))).toBe(true);

        // A second invalidation should not refire, as known URIs are cleared
        provider.invalidateCache();
        expect(onDidChangeFileFired.length).toBe(1);
    });

    it('watch returns a disposable', () => {
        const disposable = provider.watch();
        expect(disposable).toHaveProperty('dispose');
    });

    it('readFile throws FileSystemError.Unavailable when no repository is found', async () => {
        const outsideUri = vscode.Uri.parse('jj-edit:///outside/file.txt#root=/outside&revision=@');
        await expect(provider.readFile(outsideUri)).rejects.toThrowError('No Jujutsu repository found');
    });

    it('writeFile throws FileSystemError.Unavailable when no repository is found', async () => {
        const outsideUri = vscode.Uri.parse('jj-edit:///outside/file.txt#root=/outside&revision=@');
        await expect(provider.writeFile(outsideUri, Buffer.from('content'))).rejects.toThrowError(
            'No Jujutsu repository found',
        );
    });

    it('unsupported operations throw', () => {
        expect(() => provider.readDirectory()).toThrow('jj-edit is file-only');
        expect(() => provider.createDirectory()).toThrow('jj-edit is file-only');
        expect(() => provider.delete()).toThrow('jj-edit does not support delete');
        expect(() => provider.rename()).toThrow('jj-edit does not support rename');
    });

    it('readFile for revision @ reads from disk when present and falls back to jj content when missing', async () => {
        const uri = getUri('file.txt', '@');

        // Write directly to disk without committing
        const diskPath = path.join(repo.path, 'file.txt');
        fs.writeFileSync(diskPath, 'uncommitted disk text\n', 'utf-8');

        const diskContent = await provider.readFile(uri);
        expect(Buffer.from(diskContent).toString('utf8')).toBe('uncommitted disk text\n');

        // Remove file from disk to test fallback to jj.getFileContent
        fs.unlinkSync(diskPath);
        const fallbackContent = await provider.readFile(uri);
        expect(Buffer.from(fallbackContent).toString('utf8')).toBe('hello\n');
    });

    it('writeFile for revision @ writes directly to filesystem on disk', async () => {
        const uri = getUri('file.txt', '@');
        const diskPath = path.join(repo.path, 'file.txt');

        await provider.writeFile(uri, Buffer.from('written to disk directly\n', 'utf-8'));

        expect(fs.readFileSync(diskPath, 'utf-8')).toBe('written to disk directly\n');
    });

    it('reconstructs absolute path from relative path URI with root fragment', async () => {
        const relUri = vscode.Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=@`,
        });

        const content = await provider.readFile(relUri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello\n');
    });
});
