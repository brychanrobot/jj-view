/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as vscode from 'vscode';
import { JjEditFileSystemProvider } from '../jj-edit-fs-provider';
import { JjService } from '../jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjEditFileSystemProvider', () => {
    let repo: TestRepo;
    let jj: JjService;
    let provider: JjEditFileSystemProvider;
    let onDidChangeFileFired: vscode.FileChangeEvent[][] = [];

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path);

        provider = new JjEditFileSystemProvider(jj);
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

    afterEach(() => {
        repo.dispose();
    });

    it('stat returns a default file stat', async () => {
        const uri = vscode.Uri.parse(`jj-edit://${repo.path.replace(/\\/g, '/')}/file.txt?revision=@`);
        const stat = await provider.stat(uri);
        expect(stat.type).toBe(vscode.FileType.File);
        expect(stat.size).toBe(0); // It just returns a default object
    });

    it('readFile reads content from a specific revision', async () => {
        const uri = vscode.Uri.parse(`jj-edit://${repo.path.replace(/\\/g, '/')}/file.txt?revision=@`);
        const content = await provider.readFile(uri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello\n');
    });

    it('readFile throws for missing file in revision', async () => {
        const uri = vscode.Uri.parse(`jj-edit://${repo.path.replace(/\\/g, '/')}/nonexistent.txt?revision=@`);
        await expect(provider.readFile(uri)).rejects.toThrow();
    });

    it('readFile throws for missing revision query param', async () => {
        const uri = vscode.Uri.parse(`jj-edit://${repo.path.replace(/\\/g, '/')}/file.txt`);
        await expect(provider.readFile(uri)).rejects.toThrow('Missing revision');
    });

    it('writeFile modifies file in specific revision', async () => {
        const uri = vscode.Uri.parse(`jj-edit://${repo.path.replace(/\\/g, '/')}/file.txt?revision=@`);

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

        expect(onDidChangeFileFired.length).toBeGreaterThan(0);
        const lastBatch = onDidChangeFileFired[onDidChangeFileFired.length - 1];
        expect(lastBatch.length).toBe(1);
        expect(lastBatch[0].uri.toString()).toBe(uri.toString());
        expect(lastBatch[0].type).toBe(vscode.FileChangeType.Changed);
    });

    it('writeFile resolves after batching multiple writes', async () => {
        const uri1 = vscode.Uri.parse(`jj-edit://${repo.path.replace(/\\/g, '/')}/file.txt?revision=@`);
        const uri2 = vscode.Uri.parse(`jj-edit://${repo.path.replace(/\\/g, '/')}/other.txt?revision=@`);

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

        expect(onDidChangeFileFired.length).toBe(1); // They should be batched together
        const batch = onDidChangeFileFired[0];
        expect(batch.length).toBe(2);

        const uris = batch.map((e) => e.uri.toString());
        expect(uris.some((u) => u.includes('file.txt'))).toBe(true);
        expect(uris.some((u) => u.includes('other.txt'))).toBe(true);
    });

    it('invalidateCache triggers onDidChangeFile for known URIs', async () => {
        const uri1 = vscode.Uri.parse(`jj-edit://${repo.path.replace(/\\/g, '/')}/file.txt?revision=@`);
        const uri2 = vscode.Uri.parse(`jj-edit://${repo.path.replace(/\\/g, '/')}/other.txt?revision=@`);

        // Reading files adds them to known URIs
        await provider.readFile(uri1);
        // readFile will throw for other.txt, but it still adds it to known URIs before doing so
        try {
            await provider.readFile(uri2);
        } catch {}

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

    it('unsupported operations throw', () => {
        expect(() => provider.readDirectory()).toThrow('jj-edit is file-only');
        expect(() => provider.createDirectory()).toThrow('jj-edit is file-only');
        expect(() => provider.delete()).toThrow('jj-edit does not support delete');
        expect(() => provider.rename()).toThrow('jj-edit does not support rename');
    });
});
