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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRepo, buildGraph } from './test-repo';
import * as cp from 'child_process';

describe('TestRepo', () => {
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
    });

    afterEach(() => {
        repo.dispose();
    });

    it('basic operations', () => {
        repo.writeFile('file.txt', 'hello');
        repo.describe('initial commit');

        const content = repo.readFile('file.txt');
        expect(content).toBe('hello');

        const id = repo.getChangeId('@');
        expect(id).toBeTruthy();
    });

    it('buildGraph creates expected structure', async () => {
        // Create a simple A -> B -> C graph
        await buildGraph(repo, [
            {
                label: 'A',
                description: 'Commit A',
                files: { 'a.txt': 'content A' },
            },
            {
                label: 'B',
                description: 'Commit B',
                parents: ['A'], // Explicitly on top of A
                files: { 'b.txt': 'content B' },
            },
            {
                label: 'C',
                description: 'Commit C',
                parents: ['B'],
                files: { 'c.txt': 'content C' },
                isWorkingCopy: true,
            },
        ]);

        // Helper to check description without TestRepo needing a specific method for it
        const desc = (rev: string) =>
            cp.execSync(`jj log -r ${rev} -T description --no-graph`, { cwd: repo.path }).toString();

        // Verify C is current WC
        expect(desc('@')).toContain('Commit C');

        // Verify parents
        expect(desc('@-')).toContain('Commit B');

        // Verify files
        // A.txt should be visible in C (since C > B > A)
        const aContent = repo.getFileContent('@', 'a.txt');
        expect(aContent).toBe('content A');
    });

    it('buildGraph handles branching', async () => {
        // A -> B
        // A -> C
        const labels = await buildGraph(repo, [
            {
                label: 'A',
                description: 'Root',
                files: { 'root.txt': 'root' },
            },
            {
                label: 'B',
                parents: ['A'],
                description: 'Branch B',
                files: { 'b.txt': 'b' },
            },
            {
                label: 'C',
                parents: ['A'],
                description: 'Branch C',
                files: { 'c.txt': 'c' },
            },
        ]);

        const desc = (rev: string) =>
            cp.execSync(`jj log -r ${rev} -T description --no-graph`, { cwd: repo.path }).toString();
        const parentDesc = (rev: string) =>
            cp.execSync(`jj log -r ${rev}- -T description --no-graph`, { cwd: repo.path }).toString();

        // We ended on C.
        expect(desc('@')).toContain('Branch C');

        // Verify B exists and is child of A
        const bId = labels['B'].changeId;
        expect(desc(bId)).toContain('Branch B');
        expect(parentDesc(bId)).toContain('Root');
    });

    it('buildGraph respects isWorkingCopy', async () => {
        await buildGraph(repo, [
            {
                label: 'A',
                description: 'Commit A',
            },
            {
                label: 'B',
                description: 'Commit B',
                parents: ['A'],
                isWorkingCopy: true,
            },
        ]);

        const desc = (rev: string) =>
            cp.execSync(`jj log -r ${rev} -T description --no-graph`, { cwd: repo.path }).toString();

        // Verify we are on B
        expect(desc('@')).toContain('Commit B');
    });
});
