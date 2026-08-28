/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Uri } from '../uri-utils';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import { JjEditFsService } from '../jj-edit-fs-service';
import { JjRepositoryManager } from '../jj-repository-manager';
import { VsCodeEditFsProvider } from '../vscode/providers/vscode-edit-fs-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('VsCodeEditFsProvider', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let provider: VsCodeEditFsProvider;
    let onDidChangeFileFired: vscode.FileChangeEvent[][] = [];

    function getUri(filename: string, revision: string | null = '@') {
        const relPath = filename.startsWith('/') ? filename : `/${filename}`;
        const fragmentParams = new URLSearchParams();
        fragmentParams.set('root', repo.path);
        if (revision) {
            fragmentParams.set('revision', revision);
        }
        return Uri.from({
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
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        repoManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, host);

        // Register the real repository
        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        const service = new JjEditFsService(repoManager);
        provider = new VsCodeEditFsProvider(service);
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
        await repoManager?.dispose();
        repo?.dispose();
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
        const outsideUri = Uri.parse('jj-edit:///outside/file.txt#root=/outside&revision=@');
        await expect(provider.readFile(outsideUri)).rejects.toThrowError('No Jujutsu repository found');
    });

    it('writeFile throws FileSystemError.Unavailable when no repository is found', async () => {
        const outsideUri = Uri.parse('jj-edit:///outside/file.txt#root=/outside&revision=@');
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
        const relUri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=@`,
        });

        const content = await provider.readFile(relUri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello\n');
    });

    function generateLargeFileContent(lineCount = 5500): string {
        const lines: string[] = [
            '// Copyright 2026 The Chromium Authors',
            '// Use of this source code is governed by a BSD-style license that can be',
            '// found in the LICENSE file.',
            '',
            '#include <iostream>',
            '#include <memory>',
            '#include <string>',
            '#include <vector>',
            '#include <map>',
            '',
            'namespace chrome::glic::testing {',
            '',
        ];

        let currentClass = 0;
        while (lines.length < lineCount) {
            currentClass++;
            lines.push(`class GlicApiHostHandler_${currentClass} {`);
            lines.push(' public:');
            lines.push(`  explicit GlicApiHostHandler_${currentClass}(int id) : id_(id) {}`);
            lines.push(`  virtual ~GlicApiHostHandler_${currentClass}() = default;`);
            lines.push('');
            lines.push(`  int GetHandlerId() const { return id_; }`);
            lines.push(`  std::string ComputeSignature(const std::string& input) const {`);
            lines.push(`    return "handler_" + std::to_string(id_) + "_" + input;`);
            lines.push('  }');
            lines.push('');
            lines.push(' protected:');
            lines.push(`  void HandleMessage(const std::string& type, const std::vector<uint8_t>& payload) {`);
            lines.push(`    // Processing message type: ${currentClass}`);
            lines.push('    if (type.empty()) {');
            lines.push('      return;');
            lines.push('    }');
            lines.push('    payload_cache_[type] = payload;');
            lines.push('  }');
            lines.push('');
            lines.push(' private:');
            lines.push('  int id_;');
            lines.push('  std::map<std::string, std::vector<uint8_t>> payload_cache_;');
            lines.push('};');
            lines.push('');
        }

        lines.push('} // namespace chrome::glic::testing');
        return lines.join('\n');
    }

    it('handles large file editing and saving in non-@ revision with descendants', async () => {
        const originalContent = generateLargeFileContent(5500);
        const lines = originalContent.split('\n');
        lines[1000] = '// MODIFIED LINE AT 1000 IN COMMIT1';
        const c1Content = lines.join('\n');

        lines[3000] = '// MODIFIED LINE AT 3000 IN COMMIT2';
        const c2Content = lines.join('\n');

        lines[4000] = '// MODIFIED LINE AT 4000 IN WC';
        const wcContent = lines.join('\n');

        const filename = 'chrome/browser/glic/host/glic_api_browsertest.cc';
        const ids = await buildGraph(repo, [
            { label: 'base', files: { [filename]: originalContent } },
            { label: 'commit1', parents: ['base'], files: { [filename]: c1Content } },
            { label: 'commit2', parents: ['commit1'], files: { [filename]: c2Content } },
            { label: 'wc', parents: ['commit2'], isCurrentWorkingCopy: true, files: { [filename]: wcContent } },
        ]);

        const uri = getUri(filename, ids.commit1.changeId);
        const readContent = await provider.readFile(uri);
        expect(Buffer.from(readContent).toString('utf8')).toBe(c1Content);

        // Edit commit1
        const c1Lines = c1Content.split('\n');
        c1Lines[500] = '// USER SAVED IN DIFF EDITOR AT 500';
        const userSaved = c1Lines.join('\n');
        await provider.writeFile(uri, Buffer.from(userSaved, 'utf8'));

        expect(repo.getFileContent(ids.commit1.changeId, filename)).toBe(userSaved);

        // Verify descendant commit2 and working copy preserved rebased changes
        const commit2Content = repo.getFileContent(ids.commit2.changeId, filename);
        const commit2Lines = commit2Content.split('\n');
        expect(commit2Lines[500]).toBe('// USER SAVED IN DIFF EDITOR AT 500');
        expect(commit2Lines[1000]).toBe('// MODIFIED LINE AT 1000 IN COMMIT1');
        expect(commit2Lines[3000]).toBe('// MODIFIED LINE AT 3000 IN COMMIT2');

        const wcSavedContent = repo.getFileContent(ids.wc.changeId, filename);
        const wcLines = wcSavedContent.split('\n');
        expect(wcLines[500]).toBe('// USER SAVED IN DIFF EDITOR AT 500');
        expect(wcLines[1000]).toBe('// MODIFIED LINE AT 1000 IN COMMIT1');
        expect(wcLines[3000]).toBe('// MODIFIED LINE AT 3000 IN COMMIT2');
        expect(wcLines[4000]).toBe('// MODIFIED LINE AT 4000 IN WC');

        // Also check read back from provider
        const reRead = await provider.readFile(uri);
        expect(Buffer.from(reRead).toString('utf8')).toBe(userSaved);
    });

    it('exhaustively verifies file content integrity across multi-hunk edits on a large file', async () => {
        const lineCount = 6000;
        const baseContent = generateLargeFileContent(lineCount);
        const filename = 'chrome/browser/glic/host/glic_api_browsertest.cc';

        const c1Lines = baseContent.split('\n');
        c1Lines[100] = '// INITIAL COMMIT 1 MODIFICATION';
        const c1Content = c1Lines.join('\n');

        const ids = await buildGraph(repo, [
            { label: 'base', files: { [filename]: baseContent } },
            { label: 'commit1', parents: ['base'], files: { [filename]: c1Content } },
            { label: 'commit2', parents: ['commit1'], files: { [filename]: c1Content } },
            { label: 'wc', parents: ['commit2'], isCurrentWorkingCopy: true, files: { [filename]: c1Content } },
        ]);

        const uri = getUri(filename, ids.commit1.changeId);

        // Make multi-line edits in 5 dispersed locations across the 6,000-line file
        const lines = c1Content.split('\n');
        lines[15] = '#include <utility> // INJECTED HEADER';
        lines[850] =
            '    // INJECTED CONSTRUCTOR LOGIC: line 850 with very long string literal https://example.com/very/long/url/that/could/risk/wrapping/if/pager/was/active';
        lines[2400] =
            '  void InjectedCustomMethod_2400() {\n    int count = 42;\n    std::cout << "Custom count: " << count << std::endl;\n  }';
        lines[4100] = '    payload_cache_["custom_key_4100"] = {0x01, 0x02, 0x03, 0x04};';
        lines[5800] = '// TRAILING MODIFICATION AT LINE 5800';

        const expectedContent = lines.join('\n');
        const expectedLines = expectedContent.split('\n');

        // Save via provider
        await provider.writeFile(uri, Buffer.from(expectedContent, 'utf8'));

        // 1. Check direct readFile from provider
        const providerRead = await provider.readFile(uri);
        const providerReadStr = Buffer.from(providerRead).toString('utf8');
        expect(providerReadStr).toBe(expectedContent);

        // 2. Check repo.getFileContent at commit1
        const actualContent = repo.getFileContent(ids.commit1.changeId, filename);
        expect(actualContent).toBe(expectedContent);
        expect(actualContent.length).toBe(expectedContent.length);

        // 3. Exhaustively verify every line matches with zero wrapping or truncation
        const actualLines = actualContent.split('\n');
        expect(actualLines.length).toBe(expectedLines.length);
        for (let i = 0; i < expectedLines.length; i++) {
            if (actualLines[i] !== expectedLines[i]) {
                throw new Error(
                    `Mismatch at line ${i + 1}:\nExpected: "${expectedLines[i]}"\nActual:   "${actualLines[i]}"`,
                );
            }
        }

        // 4. Verify diff content against base
        const repository = repoManager.getRepositoryForUri(uri);
        expect(repository).toBeDefined();
        if (repository) {
            const diff = await repository.jj.getDiffContent(ids.commit1.changeId, filename);
            expect(diff.left).toBe(baseContent);
            expect(diff.right).toBe(expectedContent);

            // 5. Verify no unintended files were created or modified
            const changes = await repository.jj.getChanges(ids.commit1.changeId);
            expect(changes.length).toBe(1);
            expect(changes[0].path).toBe(filename);
        }
    });

    it('returns pending write content when reading before or during flush', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'file.txt': 'initial\n' } },
            { label: 'commit1', parents: ['base'], files: { 'file.txt': 'commit1\n' } },
        ]);

        const uri = getUri('file.txt', ids.commit1.changeId);

        // Start write
        const writePromise = provider.writeFile(uri, Buffer.from('new edited content\n', 'utf8'));

        // Immediately read before write finishes
        const readImmediately = await provider.readFile(uri);
        expect(Buffer.from(readImmediately).toString('utf8')).toBe('new edited content\n');

        await writePromise;

        const readAfter = await provider.readFile(uri);
        expect(Buffer.from(readAfter).toString('utf8')).toBe('new edited content\n');
    });

    it('handles rapid sequential writes on large file in ancestor revision', async () => {
        const originalContent = generateLargeFileContent(5500);
        const filename = 'chrome/browser/glic/host/glic_api_browsertest.cc';

        const lines = originalContent.split('\n');
        lines[1000] = '// COMMIT 1 MOD';
        const c1Content = lines.join('\n');

        lines[3000] = '// COMMIT 2 MOD';
        const c2Content = lines.join('\n');

        lines[4000] = '// WC MOD';
        const wcContent = lines.join('\n');

        const ids = await buildGraph(repo, [
            { label: 'base', files: { [filename]: originalContent } },
            { label: 'commit1', parents: ['base'], files: { [filename]: c1Content } },
            { label: 'commit2', parents: ['commit1'], files: { [filename]: c2Content } },
            { label: 'wc', parents: ['commit2'], isCurrentWorkingCopy: true, files: { [filename]: wcContent } },
        ]);

        const uri = getUri(filename, ids.commit1.changeId);

        // Simulate typing/saving multiple times in rapid succession
        const c1Lines1 = c1Content.split('\n');
        c1Lines1[100] = '// EDIT 1';
        const edit1 = c1Lines1.join('\n');

        const c1Lines2 = c1Content.split('\n');
        c1Lines2[100] = '// EDIT 1';
        c1Lines2[200] = '// EDIT 2';
        const edit2 = c1Lines2.join('\n');

        const p1 = provider.writeFile(uri, Buffer.from(edit1, 'utf8'));
        // Wait 120ms so first debounce fires and starts diffedit
        await new Promise((r) => setTimeout(r, 120));
        // While first diffedit is running, write edit 2
        const p2 = provider.writeFile(uri, Buffer.from(edit2, 'utf8'));

        await Promise.all([p1, p2]);

        const finalContent = repo.getFileContent(ids.commit1.changeId, filename);
        expect(finalContent).toBe(edit2);
    });

    it('cancels pending timers and rejects pending writes on dispose', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'file.txt': 'initial\n' } },
            { label: 'commit1', parents: ['base'], files: { 'file.txt': 'commit1\n' } },
        ]);

        const uri = getUri('file.txt', ids.commit1.changeId);
        const writePromise = provider.writeFile(uri, Buffer.from('unflushed edit\n', 'utf8'));

        // Dispose immediately while debounce timer is active
        provider.dispose();

        await expect(writePromise).rejects.toThrow('JjEditFsService disposed');
    });

    it('handles reading and writing in a subfolder workspace', async () => {
        const subDir = path.join(repo.path, 'nested', 'pkg');
        fs.mkdirSync(subDir, { recursive: true });

        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'nested/pkg/file.txt': 'sub initial\n' } },
            { label: 'commit1', parents: ['base'], files: { 'nested/pkg/file.txt': 'sub commit1\n' } },
        ]);

        const fragmentParams = new URLSearchParams();
        fragmentParams.set('root', subDir);
        fragmentParams.set('revision', ids.commit1.changeId);

        const subUri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: fragmentParams.toString(),
        });

        // Read through provider
        const readData = await provider.readFile(subUri);
        expect(Buffer.from(readData).toString('utf8')).toBe('sub commit1\n');

        // Write through provider
        await provider.writeFile(subUri, Buffer.from('sub updated\n', 'utf8'));

        const savedContent = repo.getFileContent(ids.commit1.changeId, 'nested/pkg/file.txt');
        expect(savedContent).toBe('sub updated\n');
    });
});
