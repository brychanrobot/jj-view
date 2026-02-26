/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { JjService } from '../jj-service';
import { TestRepo, buildGraph } from './test-repo';

describe('JjService Diff Tests', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path);
    });

    afterEach(() => {
        repo.dispose();
    });

    test('getDiffForRevision handles thundering herd concurrently', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'test.txt': 'content' } }
        ]);
        const commitId = ids.base.commitId;
        
        const runSpy = vi.spyOn(jjService as unknown as Record<'run', (...args: unknown[]) => Promise<unknown>>, 'run');
        
        const results = await Promise.all([
            jjService.getDiffForRevision(commitId),
            jjService.getDiffForRevision(commitId),
            jjService.getDiffForRevision(commitId),
        ]);
        
        expect(results[0].tempDir).toBe(results[1].tempDir);
        expect(results[1].tempDir).toBe(results[2].tempDir);
        
        const diffeditCalls = runSpy.mock.calls.filter((call: unknown[]) => call[0] === 'diffedit');
        expect(diffeditCalls.length).toBe(1);
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
        const left = (p: string) => fs.readFileSync(path.join(cache.tempDir, 'left', p), 'utf8');
        const right = (p: string) => fs.readFileSync(path.join(cache.tempDir, 'right', p), 'utf8');
        const exists = (dir: 'left' | 'right', p: string) => fs.existsSync(path.join(cache.tempDir, dir, p));

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

    test('getDiffContent works on an immutable revision', async () => {
        const ids = await buildGraph(repo, [
            { label: 'ice', files: { 'fixed.txt': 'frozen\n' } }
        ]);
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
            { label: 'child', parents: ['base'] }
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
});
