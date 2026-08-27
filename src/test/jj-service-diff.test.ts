/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService Diff Tests', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    test('getChangesBetween correctly calculates net changes across complex diamond merge graph', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'root',
                files: {
                    'shared.txt': 'root shared\n',
                    'common.txt': 'root common\n',
                    'deleted_in_merge.txt': 'to be deleted\n',
                    'nested/deep_file.txt': 'original deep\n',
                },
            },
            {
                label: 'featureA',
                parents: ['root'],
                files: { 'common.txt': 'featureA common\n', 'feature_a.txt': 'added in A\n' },
            },
            {
                label: 'featureA2',
                parents: ['featureA'],
                files: { 'shared.txt': 'featureA2 shared\n' },
            },
            {
                label: 'featureB',
                parents: ['root'],
                files: {
                    'common.txt': 'featureB common\n',
                    'feature_b.txt': 'added in B\n',
                    'path with space/file.txt': 'space file\n',
                },
            },
            {
                label: 'featureB2',
                parents: ['featureB'],
                files: { 'path with space/file.txt': 'space file modified\n' },
            },
            {
                label: 'merge',
                parents: ['featureA2', 'featureB2'],
                files: { 'common.txt': 'resolved common\n' },
            },
        ]);

        repo.edit(ids.featureA2.changeId);
        repo.deleteFile('deleted_in_merge.txt');

        // 1. Compare root vs merge across the diamond graph
        const changesVsRoot = await jjService.getChangesBetween(ids.root.changeId, ids.merge.changeId);
        changesVsRoot.sort((a, b) => a.path.localeCompare(b.path));

        expect(changesVsRoot).toEqual([
            { path: 'common.txt', status: 'modified', conflicted: false },
            { path: 'deleted_in_merge.txt', status: 'deleted', conflicted: false },
            { path: 'feature_a.txt', status: 'added', conflicted: false },
            { path: 'feature_b.txt', status: 'added', conflicted: false },
            { path: 'path with space/file.txt', status: 'added', conflicted: false },
            { path: 'shared.txt', status: 'modified', conflicted: false },
        ]);

        // 2. Compare divergent sibling branches (featureA vs featureB2)
        const changesDivergent = await jjService.getChangesBetween(ids.featureA.changeId, ids.featureB2.changeId);
        changesDivergent.sort((a, b) => a.path.localeCompare(b.path));

        expect(changesDivergent).toEqual([
            { path: 'common.txt', status: 'modified', conflicted: false },
            { path: 'feature_a.txt', status: 'deleted', conflicted: false },
            { path: 'feature_b.txt', status: 'added', conflicted: false },
            { path: 'path with space/file.txt', status: 'added', conflicted: false },
        ]);
    });

    test('getChangesBetween compares ancestor against multi-level stacked commits leading to @', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'base',
                files: { 'file_a.txt': 'a1\n', 'file_b.txt': 'b1\n', 'file_c.txt': 'c1\n', 'dir/file_d.txt': 'd1\n' },
            },
            { label: 'step1', parents: ['base'], files: { 'file_a.txt': 'a2\n', 'step1.txt': 'step1\n' } },
            { label: 'step2', parents: ['step1'], files: { 'dir/file_d.txt': 'd2\n' } },
            { label: 'step3', parents: ['step2'], files: { 'file with spaces in path/data.json': '{"key": "val"}\n' } },
            { label: 'step4', parents: ['step3'], files: { 'step1.txt': 'step1 modified\n', 'file_a.txt': 'a3\n' } },
            { label: 'wc', parents: ['step4'], files: { 'dir/file_d.txt': 'd3\n' } },
        ]);

        repo.edit(ids.step2.changeId);
        repo.deleteFile('file_b.txt');

        repo.edit(ids.wc.changeId);
        repo.deleteFile('file_c.txt');

        const changes = await jjService.getChangesBetween(ids.base.changeId, '@');
        changes.sort((a, b) => a.path.localeCompare(b.path));

        expect(changes).toEqual([
            { path: 'dir/file_d.txt', status: 'modified', conflicted: false },
            { path: 'file with spaces in path/data.json', status: 'added', conflicted: false },
            { path: 'file_a.txt', status: 'modified', conflicted: false },
            { path: 'file_b.txt', status: 'deleted', conflicted: false },
            { path: 'file_c.txt', status: 'deleted', conflicted: false },
            { path: 'step1.txt', status: 'added', conflicted: false },
        ]);
    });

    test('getChangesBetween correctly detects conflict status across multi-parent merge', async () => {
        const ids = await buildGraph(repo, [
            { label: 'root', files: { 'conflict.txt': 'base content\n' } },
            { label: 'branch1', parents: ['root'], files: { 'conflict.txt': 'branch1 content\n' } },
            { label: 'branch2', parents: ['root'], files: { 'conflict.txt': 'branch2 content\n' } },
            { label: 'merge', parents: ['branch1', 'branch2'] },
        ]);

        const changes = await jjService.getChangesBetween(ids.root.changeId, ids.merge.changeId);

        expect(changes).toEqual([
            {
                path: 'conflict.txt',
                status: 'modified',
                conflicted: true,
            },
        ]);
    });

    test('getChangesBetween returns empty array when comparing identical revisions', async () => {
        const ids = await buildGraph(repo, [{ label: 'v1', files: { 'file.txt': 'content\n' } }]);

        const changes = await jjService.getChangesBetween(ids.v1.changeId, ids.v1.changeId);

        expect(changes).toEqual([]);
    });

    test('getChangesBetween caches range results and deduplicates concurrent calls', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'a.txt': 'base\n' } },
            { label: 'child', parents: ['base'], files: { 'a.txt': 'child\n' } },
        ]);

        const [changes1, changes2] = await Promise.all([
            jjService.getChangesBetween(ids.base.changeId, ids.child.changeId),
            jjService.getChangesBetween(ids.base.changeId, ids.child.changeId),
        ]);

        expect(changes1).toEqual(changes2);
        expect(changes1).toEqual([
            {
                path: 'a.txt',
                status: 'modified',
                conflicted: false,
            },
        ]);
    });

    test('getChanges correctly identifies files with spaces in their names', async () => {
        const ids = await buildGraph(repo, [{ label: 'v1', files: { 'file with a space.txt': 'hello\n' } }]);

        const changes = await jjService.getChanges(ids.v1.changeId);

        expect(changes).toEqual([
            {
                path: 'file with a space.txt',
                status: 'added',
                conflicted: false,
                additions: 1,
                deletions: 0,
            },
        ]);
    });

    test('getChanges handles additions, modifications, deletions, and line counts accurately', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'modified.txt': 'line1\nline2\n', 'deleted.txt': 'goodbye\n' } },
            {
                label: 'child',
                parents: ['base'],
                files: {
                    'added.txt': 'new line 1\nnew line 2\n',
                    'modified.txt': 'line1\nmodified line 2\nline3\n',
                },
            },
        ]);

        repo.edit(ids.child.changeId);
        repo.deleteFile('deleted.txt');

        const changes = await jjService.getChanges(ids.child.changeId);
        changes.sort((a, b) => a.path.localeCompare(b.path));

        expect(changes).toEqual([
            {
                path: 'added.txt',
                status: 'added',
                conflicted: false,
                additions: 2,
                deletions: 0,
            },
            {
                path: 'deleted.txt',
                status: 'deleted',
                conflicted: false,
                additions: 0,
                deletions: 1,
            },
            {
                path: 'modified.txt',
                status: 'modified',
                conflicted: false,
                additions: 2,
                deletions: 1,
            },
        ]);
    });

    test('getChanges correctly calculates additions and deletions for renamed files', async () => {
        const oldFile = 'old_name.txt';
        const newFile = 'new_name.txt';
        const baseContent = 'line1\nline2\nline3\nline4\nline5\n'.repeat(10);
        const modifiedContent = `${baseContent}line_added_1\nline_added_2\n`;

        const ids = await buildGraph(repo, [
            { label: 'base', files: { [oldFile]: baseContent } },
            {
                label: 'child',
                parents: ['base'],
            },
        ]);

        repo.edit(ids.child.changeId);
        repo.moveFile(oldFile, newFile);
        repo.writeFile(newFile, modifiedContent);

        const changes = await jjService.getChanges(ids.child.changeId);

        const renamedEntry = changes.find((c) => c.path === newFile);
        expect(renamedEntry).toBeDefined();
        expect(renamedEntry).toMatchObject({
            path: newFile,
            status: 'renamed',
            oldPath: oldFile,
            additions: 2,
            deletions: 0,
        });
    });

    test('getChanges calculates additions and deletions for files in renamed directories', async () => {
        const oldDir = 'old_dir/nested/file.txt';
        const newDir = 'new_dir/nested/file.txt';
        const baseContent = 'line1\nline2\n';
        const modifiedContent = 'line1\nline2\nline3\n';

        const ids = await buildGraph(repo, [
            { label: 'base', files: { [oldDir]: baseContent } },
            { label: 'child', parents: ['base'] },
        ]);

        repo.edit(ids.child.changeId);
        repo.moveFile(oldDir, newDir);
        repo.writeFile(newDir, modifiedContent);

        const changes = await jjService.getChanges(ids.child.changeId);

        const renamedEntry = changes.find((c) => c.path === newDir);
        expect(renamedEntry).toBeDefined();
        expect(renamedEntry).toMatchObject({
            path: newDir,
            status: 'renamed',
            oldPath: oldDir,
            additions: 1,
            deletions: 0,
        });
    });

    test('getDiffForRevision handles thundering herd concurrently', async () => {
        const ids = await buildGraph(repo, [{ label: 'base', files: { 'test.txt': 'content' } }]);
        const { commitId } = ids.base;

        const results = await Promise.all([
            jjService.getDiffForRevision(commitId),
            jjService.getDiffForRevision(commitId),
            jjService.getDiffForRevision(commitId),
        ]);

        // All concurrent calls must resolve to the same tempDir, proving the
        // in-flight deduplication coalesced them into a single diffedit run.
        expect(results[0].tempDir).toBe(results[1].tempDir);
        expect(results[1].tempDir).toBe(results[2].tempDir);
    });

    test('getDiffForRevision populates temp directory with complex multi-file changes', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'base',
                files: {
                    'mod.txt': 'old\n',
                    'del.txt': 'gone\n',
                    'keep.txt': 'same\n',
                    'dir/sub.txt': 'sub-old\n',
                },
            },
            {
                label: 'child',
                parents: ['base'],
                files: {
                    'mod.txt': 'new\n',
                    'add.txt': 'fresh\n',
                    'dir/sub.txt': 'sub-new\n',
                    'dir/another.txt': 'another\n',
                },
            },
        ]);

        // Delete file in child (buildGraph doesn't support deletion via 'files' map easily yet,
        // it just overwrites or adds. But it uses repo.new() and then writes files.
        // Wait, TestRepo.deleteFile(path) exists. I'll do it after buildGraph for now.)
        repo.edit(ids.child.changeId);
        repo.deleteFile('del.txt');
        const commitId = repo.getCommitId('@');

        const cache = await jjService.getDiffForRevision(commitId);

        expect(cache.tempDir).toBeDefined();

        // Check contents in cache
        const left = (p: string) => fsSync.readFileSync(path.join(cache.tempDir, 'left', p), 'utf8');
        const right = (p: string) => fsSync.readFileSync(path.join(cache.tempDir, 'right', p), 'utf8');
        const exists = (dir: 'left' | 'right', p: string) => fsSync.existsSync(path.join(cache.tempDir, dir, p));

        expect(left('mod.txt')).toBe('old\n');
        expect(right('mod.txt')).toBe('new\n');

        expect(exists('left', 'add.txt')).toBe(false);
        expect(right('add.txt')).toBe('fresh\n');

        expect(left('del.txt')).toBe('gone\n');
        expect(exists('right', 'del.txt')).toBe(false);

        expect(left('dir/sub.txt')).toBe('sub-old\n');
        expect(right('dir/sub.txt')).toBe('sub-new\n');

        expect(exists('left', 'dir/another.txt')).toBe(false);
        expect(right('dir/another.txt')).toBe('another\n');

        // Unchanged file should NOT be in the cache (diffedit only shows changes)
        expect(exists('left', 'keep.txt')).toBe(false);
        expect(exists('right', 'keep.txt')).toBe(false);
    });

    test('getDiffContent handles multiple files and nested paths', async () => {
        const ids = await buildGraph(repo, [
            { label: 'v1', files: { 'a.txt': 'a1\n', 'b/c.txt': 'c1\n' } },
            { label: 'v2', parents: ['v1'], files: { 'a.txt': 'a2\n', 'b/c.txt': 'c2\n', 'd.txt': 'd1\n' } },
        ]);
        const commitId = ids.v2.commitId;

        const a = await jjService.getDiffContent(commitId, 'a.txt');
        expect(a.left).toBe('a1\n');
        expect(a.right).toBe('a2\n');

        const c = await jjService.getDiffContent(commitId, 'b/c.txt');
        expect(c.left).toBe('c1\n');
        expect(c.right).toBe('c2\n');

        const d = await jjService.getDiffContent(commitId, 'd.txt');
        expect(d.left).toBe('');
        expect(d.right).toBe('d1\n');
    });

    test('getDiffContent handles files with spaces in their names and nested directories with spaces', async () => {
        const ids = await buildGraph(repo, [
            { label: 'v1', files: { 'my folder with space/my file with space.txt': 'original line\n' } },
            {
                label: 'v2',
                parents: ['v1'],
                files: { 'my folder with space/my file with space.txt': 'original line\nmodified line\n' },
            },
        ]);

        const diff = await jjService.getDiffContent(ids.v2.commitId, 'my folder with space/my file with space.txt');
        expect(diff.left).toBe('original line\n');
        expect(diff.right).toBe('original line\nmodified line\n');
    });

    test('getDiffContent works on an immutable revision', async () => {
        const ids = await buildGraph(repo, [{ label: 'ice', files: { 'fixed.txt': 'frozen\n' } }]);
        const commitId = ids.ice.commitId;

        // Mark this commit as immutable by configuring immutable_heads()
        repo.config('revset-aliases."immutable_heads()"', commitId);

        // Sanity check using TestRepo's helper
        expect(repo.isImmutable(commitId)).toBe(true);

        // Verify it works (reading doesn't care about immutability)
        const content = await jjService.getDiffContent(commitId, 'fixed.txt');
        expect(content.right).toBe('frozen\n');
    });

    test('getDiffContent returns identical content for unchanged file (fallback)', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'steady.txt': 'steady\n' } },
            { label: 'child', parents: ['base'] },
        ]);
        const childId = ids.child.changeId;

        const content = await jjService.getDiffContent(childId, 'steady.txt');
        expect(content.left).toBe('steady\n');
        expect(content.right).toBe('steady\n');
    });

    test('getDiffContent returns empty strings for non-existent file', async () => {
        const content = await jjService.getDiffContent('@', 'ghost.txt');
        expect(content.left).toBe('');
        expect(content.right).toBe('');
    });

    test('getChanges caches results and deduplicates concurrent in-flight requests', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'file1.txt': 'initial\n' } },
            { label: 'child', parents: ['base'], files: { 'file1.txt': 'updated\n', 'file2.txt': 'created\n' } },
        ]);
        const commitId = ids.child.commitId;

        // Concurrent calls (thundering herd)
        const [changes1, changes2] = await Promise.all([
            jjService.getChanges(commitId),
            jjService.getChanges(commitId),
        ]);

        expect(changes1).toEqual(changes2);
        expect(changes1.length).toBe(2);

        // Subsequent cached call
        const changes3 = await jjService.getChanges(commitId);
        expect(changes3).toEqual(changes1);
    });

    test('getChanges invalidates cache on clearCache or mutation', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'test.txt': 'v1\n' } },
            { label: 'child', parents: ['base'], files: { 'test.txt': 'v2\n' } },
        ]);

        const initialChanges = await jjService.getChanges(ids.child.changeId);
        expect(initialChanges.length).toBe(1);
        expect(initialChanges[0].path).toBe('test.txt');

        // Make mutation in child commit using repo
        repo.edit(ids.child.changeId);
        await repo.writeFiles({ 'extra.txt': 'new\n' });

        // Before clearCache / mutation, calling getChanges with cached key without clearCache would return old entries
        // Running status (which is a mutation in JjService) or explicit clearCache invalidates the cache
        await jjService.clearCache();

        const updatedChanges = await jjService.getChanges(ids.child.changeId);
        expect(updatedChanges.length).toBe(2);
        const paths = updatedChanges.map((c) => c.path).sort();
        expect(paths).toEqual(['extra.txt', 'test.txt']);
    });

    function generateRealisticCppSource(lineCount = 5500): string {
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

    test('large file diff and setFilesContent', async () => {
        const originalContent = generateRealisticCppSource(5500);
        const lines = originalContent.split('\n');
        lines[1500] = '  // MODIFIED IN CHILD AT 1500: Updated signature algorithm';
        lines[3500] = '    // MODIFIED IN CHILD AT 3500: Added payload validation check';
        const modifiedContent = lines.join('\n');

        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'large_file.cc': originalContent } },
            { label: 'child', parents: ['base'], files: { 'large_file.cc': modifiedContent } },
        ]);

        const diff = await jjService.getDiffContent(ids.child.commitId, 'large_file.cc');
        expect(diff.left).toBe(originalContent);
        expect(diff.right).toBe(modifiedContent);

        // Now modify and setFilesContent
        lines[2500] = '  // MODIFIED VIA SETFILESCONTENT: Injected telemetry handler';
        const newContent = lines.join('\n');
        await jjService.setFilesContent(ids.child.changeId, new Map([['large_file.cc', newContent]]));

        const saved = repo.getFileContent(ids.child.changeId, 'large_file.cc');
        expect(saved).toBe(newContent);
    });

    test('setFilesContent works in a subfolder workspace', async () => {
        const subDir = path.join(repo.path, 'subfolder');
        fsSync.mkdirSync(subDir, { recursive: true });

        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'subfolder/file.txt': 'initial sub' } },
            { label: 'child', parents: ['base'], files: { 'subfolder/file.txt': 'mod sub' } },
        ]);

        const subfolderJjService = new JjService(subDir, NO_OP_LOGGER);
        await subfolderJjService.setFilesContent(
            ids.child.changeId,
            new Map([['file.txt', 'updated from subfolder service']]),
        );

        const saved = repo.getFileContent(ids.child.changeId, 'subfolder/file.txt');
        expect(saved).toBe('updated from subfolder service');
    });

    test('getDiffForRevision throws and does not cache when revision is invalid or diff extraction fails', async () => {
        await expect(jjService.getDiffForRevision('non-existent-rev-12345')).rejects.toThrow();

        // Ensure invalid cache entry was not stored
        const invalidCache = await jjService.getDiffForRevision('non-existent-rev-12345').catch(() => null);
        expect(invalidCache).toBeNull();
    });

    test('setFilesContent handles file paths with potential temp slug collisions', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'a/b_c.txt': 'initial 1', 'a_b/c.txt': 'initial 2' } },
            { label: 'child', parents: ['base'], files: { 'a/b_c.txt': 'child 1', 'a_b/c.txt': 'child 2' } },
        ]);

        const filesToEdit = new Map([
            ['a/b_c.txt', 'updated a/b_c'],
            ['a_b/c.txt', 'updated a_b/c'],
        ]);

        await jjService.setFilesContent(ids.child.changeId, filesToEdit);

        expect(repo.getFileContent(ids.child.changeId, 'a/b_c.txt')).toBe('updated a/b_c');
        expect(repo.getFileContent(ids.child.changeId, 'a_b/c.txt')).toBe('updated a_b/c');
    });

    test('setFilesContent with empty map is a no-op', async () => {
        const ids = await buildGraph(repo, [{ label: 'base', files: { 'file.txt': 'hello' } }]);

        await expect(jjService.setFilesContent(ids.base.changeId, new Map())).resolves.toBeUndefined();
    });

    test('mutation automatically invalidates diff and changes cache', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'file.txt': 'initial' } },
            { label: 'child', parents: ['base'], files: { 'file.txt': 'child v1' } },
        ]);

        // 1. Warm diff cache
        const cache1 = await jjService.getDiffForRevision(ids.child.changeId);
        const rightFile1 = path.join(cache1.tempDir, 'right', 'file.txt');
        expect(await fs.readFile(rightFile1, 'utf8')).toBe('child v1');

        // 2. Perform a mutation via setFilesContent
        await jjService.setFilesContent(ids.child.changeId, new Map([['file.txt', 'child v2']]));

        // 3. Next getDiffForRevision should return new cache with updated content
        const cache2 = await jjService.getDiffForRevision(ids.child.changeId);
        const rightFile2 = path.join(cache2.tempDir, 'right', 'file.txt');
        expect(await fs.readFile(rightFile2, 'utf8')).toBe('child v2');
    });

    test('batch-diff script does not create .complete marker when copy fails', async () => {
        const scriptPath = path.resolve(__dirname, '../../scripts/batch-diff.sh');
        if (process.platform === 'win32') {
            return; // Unix shell script test
        }

        const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-diff-test-'));
        try {
            const leftDir = path.join(tempBase, 'left');
            const rightDir = path.join(tempBase, 'right');
            const outLeft = path.join(tempBase, 'outLeft');
            const outRight = path.join(tempBase, 'outRight');

            await fs.mkdir(leftDir, { recursive: true });
            await fs.mkdir(rightDir, { recursive: true });
            await fs.writeFile(path.join(rightDir, 'test.txt'), 'content');

            // Make outRight a read-only file (not directory) so mkdir/cp fails
            await fs.writeFile(outRight, 'blocker', { mode: 0o444 });

            const result = cp.spawnSync('bash', [scriptPath, leftDir, rightDir, outLeft, outRight]);
            expect(result.status).toBe(1);

            // .complete marker should NOT exist
            const completeMarker = path.join(outRight, '.complete');
            await expect(fs.access(completeMarker)).rejects.toThrow();
        } finally {
            await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
        }
    });

    test('batch-diff script successfully copies clean directory structure and writes .complete marker', async () => {
        const scriptPath = path.resolve(__dirname, '../../scripts/batch-diff.sh');
        if (process.platform === 'win32') {
            return; // Unix shell script test
        }

        const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-diff-success-'));
        try {
            const leftDir = path.join(tempBase, 'left');
            const rightDir = path.join(tempBase, 'right');
            const outLeft = path.join(tempBase, 'outLeft');
            const outRight = path.join(tempBase, 'outRight');

            await fs.mkdir(path.join(leftDir, 'nested'), { recursive: true });
            await fs.mkdir(path.join(rightDir, 'nested'), { recursive: true });
            await fs.writeFile(path.join(leftDir, 'nested', 'left.txt'), 'left content');
            await fs.writeFile(path.join(rightDir, 'nested', 'right.txt'), 'right content');

            const result = cp.spawnSync('bash', [scriptPath, leftDir, rightDir, outLeft, outRight]);
            expect(result.status).toBe(1); // Exits 1 intentionally

            // .complete marker must exist
            const completeMarker = path.join(outRight, '.complete');
            await expect(fs.access(completeMarker)).resolves.toBeUndefined();

            // Content must match
            expect(await fs.readFile(path.join(outLeft, 'nested', 'left.txt'), 'utf8')).toBe('left content');
            expect(await fs.readFile(path.join(outRight, 'nested', 'right.txt'), 'utf8')).toBe('right content');

            // Must NOT have copied parent directory contents
            expect(await fs.access(path.join(outRight, 'right')).catch(() => false)).toBe(false);
            expect(await fs.access(path.join(outRight, 'left')).catch(() => false)).toBe(false);
        } finally {
            await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
        }
    });
});
