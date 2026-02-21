/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { JjService } from '../jj-service';
import { TestRepo, buildGraph } from './test-repo';

describe('JjService Unit Tests', () => {
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

    test('getLog returns valid log entry', async () => {
        const [log] = await jjService.getLog({ revision: '@' });
        expect(log.change_id).toBeTruthy();
        expect(log.commit_id).toBeTruthy();
    });

    test('getWorkingCopyChanges detects added file', async () => {
        repo.writeFile('new-file.txt', 'content');

        const changes = await jjService.getWorkingCopyChanges();
        expect(changes.length).toBe(1);
        expect(changes[0].path).toBe('new-file.txt');
        expect(changes[0].status).toBe('added');
    });

    test('getWorkingCopyChanges detects modified file', async () => {
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'initial' } },
            { parents: ['initial'], files: { 'file.txt': 'modified' }, isWorkingCopy: true },
        ]);

        const changes = await jjService.getWorkingCopyChanges();
        expect(changes.length).toBe(1);
        expect(changes[0].path).toBe('file.txt');
        expect(changes[0].status).toBe('modified');
    });

    test('getWorkingCopyChanges handles empty working copy', async () => {
        repo.snapshot();
        const changes = await jjService.getWorkingCopyChanges();
        expect(changes.length).toBe(0);
    });

    describe('new command', () => {
        test('creates a new change', async () => {
            const oldChangeId = repo.getChangeId('@');

            await jjService.new({ message: 'message' });

            const newChangeId = repo.getChangeId('@');
            const description = repo.getDescription('@');
            const parents = repo.getParents('@');

            expect(newChangeId).not.toBe(oldChangeId);
            expect(description).toContain('message');
            // Default `jj new` creates a child of the current working copy
            expect(parents[0]).toBe(oldChangeId);
        });

        test('creates a new change with parent', async () => {
            // Create a specific parent to anchor on
            repo.describe('target parent');
            const parentChangeId = repo.getChangeId('@');

            // Move somewhere else first to ensure we are jumping
            repo.new(['root()'], 'unrelated');

            await jjService.new({ parents: [parentChangeId] });

            const parents = repo.getParents('@');
            expect(parents[0]).toBe(parentChangeId);
        });

        test('creates a new change with message and parent', async () => {
            repo.describe('target parent');
            const parentChangeId = repo.getChangeId('@');

            await jjService.new({ message: 'custom message', parents: [parentChangeId] });

            const description = repo.getDescription('@');
            const parents = repo.getParents('@');

            expect(description).toContain('custom message');
            expect(parents[0]).toBe(parentChangeId);
        });

        test('creates change inserted before', async () => {
            // Setup: Parent -> Child
            const ids = await buildGraph(repo, [
                {
                    label: 'Parent',
                    description: 'Parent',
                },
                {
                    label: 'Child',
                    parents: ['Parent'],
                    description: 'Child',
                    isWorkingCopy: true,
                },
            ]);
            // Insert 'Middle' before 'Child'
            // Expected: Parent -> Middle -> Child
            await jjService.new({ message: 'Middle', insertBefore: [ids['Child'].changeId] });

            // Child(@) should now have Middle as parent
            const childParents = repo.getParents(ids['Child'].changeId);
            // We need to find the ID of the newly created Middle commit.
            // Since we inserted it, it should be the parent of Child.
            // And Middle's parent should be Parent.

            const middleId = childParents[0];
            const middleDescription = repo.getDescription(middleId);
            const middleParents = repo.getParents(middleId);

            expect(middleDescription).toContain('Middle');
            expect(middleParents[0]).toBe(ids['Parent'].changeId);
        });

        test('creates a new change with multiple parents (merge)', async () => {
            // Setup:
            // Parent1
            // Parent2
            const ids = await buildGraph(repo, [
                { label: 'p1', description: 'parent 1' },
                { label: 'p2', description: 'parent 2', isWorkingCopy: true },
            ]);

            const p1Id = ids['p1'].changeId;
            const p2Id = ids['p2'].changeId;

            // Create merge commit on top of p1 and p2
            await jjService.new({ message: 'merge commit', parents: [p1Id, p2Id] });

            const description = repo.getDescription('@');
            const parents = repo.getParents('@');

            expect(description).toContain('merge commit');
            expect(parents.length).toBe(2);

            // Verify parent IDs
            expect(parents).toContain(p1Id);
            expect(parents).toContain(p2Id);
        });

        test('creates change inserted before multiple revisions', async () => {
             // Setup: Parent -> Child1
             //               -> Child2
            const ids = await buildGraph(repo, [
                { label: 'parent', description: 'parent' },
                { label: 'child1', parents: ['parent'], description: 'child1' },
                { label: 'child2', parents: ['parent'], description: 'child2' },
            ]);
            
            // Insert 'Middle' before Child1 and Child2
            // Expected: Parent -> Middle -> Child1
            //                            -> Child2
            await jjService.new({ 
                message: 'Middle', 
                insertBefore: [ids['child1'].changeId, ids['child2'].changeId] 
            });

            const userLog = await jjService.getLog();
            const middle = userLog.find(l => l.description.includes('Middle'));
            expect(middle).toBeDefined();

            const c1Parents = repo.getParents(ids['child1'].changeId);
            const c2Parents = repo.getParents(ids['child2'].changeId);

            expect(c1Parents[0]).toBe(middle!.change_id);
            expect(c2Parents[0]).toBe(middle!.change_id);
        });

        test('creates change with parents AND insertBefore', async () => {
            // Setup: Root -> Parent -> Child
            // We want to insert 'Middle' between Parent and Child, but also have 'Root' as a parent (merge)
            // Expected: (Root, Parent) -> Middle -> Child
            const ids = await buildGraph(repo, [
                { label: 'root', description: 'root' },
                { label: 'parent', parents: ['root'], description: 'parent' },
                { label: 'child', parents: ['parent'], description: 'child' },
            ]);

            await jjService.new({
                message: 'Middle',
                parents: [ids['root'].changeId, ids['parent'].changeId],
                insertBefore: [ids['child'].changeId]
            });

            const userLog = await jjService.getLog();
            const middle = userLog.find(l => l.description.includes('Middle'));
            expect(middle).toBeDefined();

            // Check parents of Middle
            const middleParents = repo.getParents(middle!.change_id);
            expect(middleParents).toHaveLength(2);
            expect(middleParents).toContain(ids['root'].changeId);
            expect(middleParents).toContain(ids['parent'].changeId);

            // Check parent of Child (should be Middle)
            const childParents = repo.getParents(ids['child'].changeId);
            expect(childParents[0]).toBe(middle!.change_id);
        });
    });

    test('new command creates a new change (integration)', async () => {
        const logBeforeChangeId = repo.getChangeId('@');
        await jjService.new({ message: 'test new change' });
        const logAfterChangeId = repo.getChangeId('@');

        expect(logAfterChangeId).not.toBe(logBeforeChangeId);
    });

    test('new command with parent creates change on parent (integration)', async () => {
        repo.describe('root');
        const rootChangeId = repo.getChangeId('@');

        // Create child 1
        repo.new(['@'], 'child1');

        // Create child 2 on root (fork)
        await jjService.new({ message: 'child2', parents: [rootChangeId] });

        const child2Parents = repo.getParents('@');
        const child2Desc = repo.getDescription('@');

        // Verify child2 parent is root
        expect(child2Parents[0]).toBe(rootChangeId);
        // Verify we switched to child2
        expect(child2Desc.trim()).toBe('child2');
    });

    test('describe command updates description', async () => {
        const description = 'test description update';
        await jjService.describe(description);

        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe(description);
    });

    test('cat command returns file content', async () => {
        await buildGraph(repo, [
            { label: 'v1', description: 'v1', files: { 'file.txt': 'version 1' } },
            { parents: ['v1'], files: { 'file.txt': 'version 2' }, isWorkingCopy: true },
        ]);

        // cat @- should return "version 1"
        const content = await jjService.cat('file.txt', '@-');
        expect(content).toBe('version 1');
    });

    test('cat command preserves trailing newline', async () => {
        repo.writeFile('newline.txt', 'line\n');
        repo.describe('newline');
        
        const content = await jjService.cat('newline.txt', '@');
        expect(content).toBe('line\n');
    });

    test('restore command reverts changes', async () => {
        const filePath = path.join(repo.path, 'file.txt');
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'initial' } },
            { parents: ['initial'], files: { 'file.txt': 'modified' }, isWorkingCopy: true },
        ]);
        await jjService.restore([filePath]);

        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toBe('initial');
    });

    test('squash command moves changes to parent', async () => {
        const filePath = path.join(repo.path, 'file.txt');
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { 'file.txt': 'parent content' } },
            { parents: ['parent'], files: { 'file.txt': 'child content' }, isWorkingCopy: true },
        ]);

        // Squash changes back to parent
        await jjService.squash([filePath]);

        // Parent should now have "child content"
        const parentContent = repo.getFileContent('@-', 'file.txt');
        expect(parentContent).toBe('child content');

        // Working copy should be clean (or same as parent)
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toBe('child content');
    });

    test('squash command with revision moves changes to specified parent', async () => {
        // Setup: Root -> Parent -> Child
        const filePath = path.join(repo.path, 'squash-rev.txt');
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root', files: { 'squash-rev.txt': 'root' } },
            { label: 'parent', parents: ['root'], description: 'parent', files: { 'squash-rev.txt': 'parent' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { 'squash-rev.txt': 'child' },
                isWorkingCopy: true,
            },
        ]);
        const parentId = ids['parent'].changeId;
        const childId = ids['child'].changeId;

        // Squash "child" revision into "parent" explicitly
        await jjService.squash([filePath], childId);

        // Verify parent now has child content
        const parentContent = repo.getFileContent(parentId, 'squash-rev.txt');
        expect(parentContent).toBe('child');
    });

    test('squash command --from --into moves changes between arbitrary commits', async () => {
        // Setup: Root -> A -> B
        const newFileName = 'squash-new.txt';
        const newFilePath = path.join(repo.path, newFileName);

        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'A', parents: ['root'], description: 'A' },
            {
                label: 'B',
                parents: ['A'],
                description: 'B',
                files: { [newFileName]: 'new content' },
                isWorkingCopy: true,
            },
        ]);
        const rootId = ids['root'].changeId;
        const bId = ids['B'].changeId;

        // Squash 'new content' from B into Root directly
        await jjService.squash([newFilePath], bId, rootId);

        // Root should now have the new file
        const rootContent = repo.getFileContent(rootId, newFileName);
        expect(rootContent).toBe('new content');
    });

    test('squash without paths squashes entire commit', async () => {
        // Setup: Parent -> Child
        await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { 'f1.txt': 'child1', 'f2.txt': 'child2' },
                isWorkingCopy: true,
            },
        ]);

        // Squash everything into parent
        await jjService.squash([]);

        const content1 = repo.getFileContent('@-', 'f1.txt');
        const content2 = repo.getFileContent('@-', 'f2.txt');

        expect(content1).toBe('child1');
        expect(content2).toBe('child2');
    });

    test('absorb command moves changes to mutable parent', async () => {
        const fileName = 'absorb.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'line1\nline2\n' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                // Modify line 2. jj absorb should figure out it belongs to parent
                files: { [fileName]: 'line1\nline2 modified\n' },
                isWorkingCopy: true,
            },
        ]);

        // Absorb changes from working copy into parent
        await jjService.absorb();

        // Verify parent has the change
        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe('line1\nline2 modified\n');

        // Verify working copy is clean (same as parent)
        const childContent = repo.readFile(fileName);
        expect(childContent).toBe('line1\nline2 modified\n');
    });

    test('absorb command from specific revision', async () => {
        const fileName = 'absorb-rev.txt';
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root', files: { [fileName]: 'base\n' } },
            {
                label: 'A', // Mutable parent
                parents: ['root'],
                description: 'A',
                files: { [fileName]: 'base\nlineA\n' },
            },
            {
                label: 'B', // Source of change
                parents: ['A'],
                description: 'B',
                files: { [fileName]: 'base\nlineA modified\n' },
            },
            {
                label: 'C', // Working copy
                parents: ['B'],
                description: 'C',
                isWorkingCopy: true,
            },
        ]);

        // Absorb changes from B into A
        // B modifies lineA which was introduced in A.
        await jjService.absorb({ fromRevision: ids['B'].changeId });

        // Verify A has the change
        const contentA = repo.getFileContent(ids['A'].changeId, fileName);
        expect(contentA).toBe('base\nlineA modified\n');

        // B should be empty of changes but still exist as it has a description
        const contentB = repo.getFileContent(ids['B'].changeId, fileName);
        expect(contentB).toBe('base\nlineA modified\n');
    });

    test('getChildren returns correct children', async () => {
        // Setup: Parent -> Child1
        //                -> Child2
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child1', parents: ['parent'], description: 'child1' },
            {
                label: 'child2',
                parents: ['parent'],
                description: 'child2',
            },
        ]);
        const parentId = ids['parent'].changeId;

        const children = await jjService.getChildren(parentId);
        expect(children.length).toBe(2);
    });

    test('getLog parses parents correctly', async () => {
        // Create a parent commit
        repo.describe('parent');
        repo.new(['@'], 'child');

        const [logEntry] = await jjService.getLog({ revision: '@' });
        expect(logEntry.parents).toBeDefined();
        expect(Array.isArray(logEntry.parents)).toBe(true);
        expect(logEntry.parents.length).toBeGreaterThan(0);

        // Check stricture of parents
        const parent = logEntry.parents[0];

        // Update JjLogEntry if needed based on this
        if (typeof parent === 'object' && parent !== null) {
            // jj json(self) returns objects for parents: { commit_id: "...", change_id: "..." }
            expect(parent).toHaveProperty('commit_id');
        } else {
            expect(typeof parent).toBe('string');
        }
    });

    test('moveToChild moves changes to child', async () => {
        const filePath = path.join(repo.path, 'file.txt');
        await buildGraph(repo, [
            { label: 'grandparent', description: 'grandparent', files: { 'file.txt': 'base\n' } },
            {
                label: 'parent',
                parents: ['grandparent'],
                description: 'parent',
                files: { 'file.txt': 'modified in parent' },
            },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                isWorkingCopy: true,
            },
        ]);

        await jjService.moveChanges([filePath], '@-', '@');

        const parentContent = repo.getFileContent('@-', 'file.txt');
        expect(parentContent.trim()).toBe('base');

        const childContent = repo.getFileContent('@', 'file.txt');
        expect(childContent).toBe('modified in parent');
    }, 30000);

    test('getLog without revisions returns multiple entries', async () => {
        repo.describe('c1');
        repo.new([], 'c2');
        repo.new([], 'c3');

        const logs = await jjService.getLog();
        expect(logs.length).toBeGreaterThanOrEqual(3);
    });

    test('getLog parses extended fields', async () => {
        repo.describe('test fields');
        const [log] = await jjService.getLog({ revision: '@' });

        expect(log.change_id_shortest).toBeDefined();
        expect(log.is_immutable).toBeDefined();
        expect(log.is_empty).toBeDefined();

        expect(log.is_immutable).toBe(false);
        expect(log.is_empty).toBe(true);

        expect(log.change_id.startsWith(log.change_id_shortest!)).toBe(true);
        expect(log.change_id_shortest!.length).toBeGreaterThan(0);
        expect(log.change_id_shortest!.length).toBeLessThan(log.change_id.length);
    });

    test('getLog detects empty status correctly', async () => {
        const filePath = path.join(repo.path, 'not-empty.txt');
        fs.writeFileSync(filePath, 'content');

        repo.describe('not empty');
        const [log] = await jjService.getLog({ revision: '@' });
        expect(log.is_empty).toBe(false);

        repo.new(['@'], 'empty child');
        const [emptyLog] = await jjService.getLog({ revision: '@' });
        expect(emptyLog.is_empty).toBe(true);
    });

    test('getLog parses parents_immutable correctly', async () => {
        repo.describe('child of root');
        const [child] = await jjService.getLog({ revision: '@' });

        expect(child.parents_immutable).toBeDefined();
        expect(child.parents_immutable!.length).toBeGreaterThan(0);
        expect(child.parents_immutable![0]).toBe(true);

        repo.new(['@'], 'grandchild');
        const [grandchild] = await jjService.getLog({ revision: '@' });

        expect(grandchild.parents_immutable).toBeDefined();
        expect(grandchild.parents_immutable![0]).toBe(false);
    });

    test('getLog parses author and committer with full details', async () => {
        repo.describe('author test');
        const [log] = await jjService.getLog({ revision: '@' });

        // Verify author structure (values may come from global jj config, not repo-local)
        expect(typeof log.author).toBe('object');
        expect(typeof log.author.name).toBe('string');
        expect(log.author.name.length).toBeGreaterThan(0);
        expect(log.author.email).toContain('@');

        // Verify committer has correct values (from TestRepo repo-local config)
        expect(log.committer?.name).toBe('Test User');
        expect(log.committer?.email).toBe('test@example.com');

        // Verify timestamps are valid ISO 8601 format and parseable
        const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
        expect(log.author.timestamp).toMatch(isoPattern);
        expect(log.committer.timestamp).toMatch(isoPattern);

        // Verify timestamps are actual parseable dates
        const authorDate = new Date(log.author.timestamp);
        const committerDate = new Date(log.committer.timestamp);
        expect(authorDate.getTime()).not.toBeNaN();
        expect(committerDate.getTime()).not.toBeNaN();
    });

    test('duplicate command creates copy', async () => {
        repo.describe('original');
        const originalChangeId = repo.getChangeId('@');

        await jjService.duplicate(originalChangeId);

        const logs = repo.getLogOutput('change_id ++ " " ++ description').split('\n');
        const duplicates = logs.filter((l) => l.includes('original'));
        expect(duplicates.length).toBeGreaterThanOrEqual(2);
    });

    test('abandon command removes revision', async () => {
        repo.describe('to-abandon');
        const changeId = repo.getChangeId('@');
        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe('to-abandon');

        await jjService.abandon('@');

        const newChangeId = repo.getChangeId('@');
        expect(newChangeId).not.toBe(changeId);
        const log = repo.getLogOutput('change_id');
        expect(log).not.toContain(changeId);
    });

    test('Button Action Simulation (New, Squash, Duplicate, Abandon)', async () => {
        repo.describe('initial');
        const initialChangeId = repo.getChangeId('@');

        const childId = await jjService.new({ parents: [initialChangeId] });

        const childParents = repo.getParents(childId);
        expect(childParents[0]).toBe(initialChangeId);

        repo.writeFile('file.txt', 'child content');

        const grandchildId = await jjService.new({ parents: [childId] });
        const grandchildParents = repo.getParents(grandchildId);
        expect(grandchildParents[0]).toBe(childId);

        repo.writeFile('file.txt', 'grandchild content');

        const grandchildChangeId = repo.getChangeId(grandchildId);
        await jjService.squash([], grandchildChangeId);

        const content = repo.getFileContent('@', 'file.txt');
        expect(content).toBe('grandchild content');

        await jjService.duplicate('@');

        const log = repo.getLogOutput('change_id');
        const lines = log.trim().split('\n');
        expect(lines.length).toBeGreaterThanOrEqual(2);

        await jjService.abandon('@');
    }, 30000);

    test('showDetails returns string signature', async () => {
        repo.describe('details test');
        const output = await jjService.showDetails('@');
        expect(output).toContain('details test');
        expect(typeof output).toBe('string');
    });

    test('getLog handles complex graph (forks)', async () => {
        await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'parent', parents: ['root'], description: 'parent' },
            { label: 'child1', parents: ['parent'], description: 'child1' },
            { label: 'child2', parents: ['parent'], description: 'child2', isWorkingCopy: true },
        ]);

        const logs = await jjService.getLog();

        expect(logs.length).toBeGreaterThanOrEqual(4);

        const child1Log = logs.find((l) => l.description.trim() === 'child1');
        const child2Log = logs.find((l) => l.description.trim() === 'child2');
        const parentLog = logs.find((l) => l.description.trim() === 'parent');

        expect(child1Log).toBeDefined();
        expect(child2Log).toBeDefined();
        expect(parentLog).toBeDefined();

        expect(child1Log!.parents[0]).toBe(parentLog!.commit_id);
        expect(child2Log!.parents[0]).toBe(parentLog!.commit_id);
    }, 30000);

    test('Complex Replay (Reproduce User Scenario) with return IDs', async () => {
        const { Initial, FakeTS, CC, Cool, VPM, Orcs, HEAD } = await buildGraph(repo, [
            {
                label: 'Initial',
                description: 'initial commit',
            },
            {
                label: 'FakeTS',
                parents: ['Initial'],
                description: 'Added a fake ts file',
            },
            {
                label: 'CC',
                parents: ['FakeTS'],
                description: 'cc file and stuff',
            },
            {
                label: 'Cool',
                parents: ['Initial'],
                description: "It's pretty cool I guess",
            },
            {
                label: 'VPM',
                parents: ['Cool'],
                description: 'vpmososp',
            },
            {
                label: 'Orcs',
                parents: ['Cool'],
                description: 'Orcs are coming',
            },
            {
                label: 'HEAD',
                parents: ['VPM'],
                description: 'tqlynzyq',
                isWorkingCopy: true,
            },
        ]);

        const headId = HEAD.changeId;

        repo.edit(headId);
        const logs = await jjService.getLog();

        const getDesc = (id: string) => logs.find((l) => l.change_id === id)?.description.trim();
        const getParents = (id: string) => {
            const entry = logs.find((l) => l.change_id === id);
            if (!entry) {
                return [];
            }
            return entry.parents
                .map((p: string) => {
                    const parentLog = logs.find((l) => l.commit_id === p);
                    return parentLog ? parentLog.change_id : undefined;
                })
                .filter(Boolean);
        };

        const initialId = Initial.changeId;
        const fakeTSId = FakeTS.changeId;
        const ccId = CC.changeId;
        const coolId = Cool.changeId;
        const vpmId = VPM.changeId;
        const orcsId = Orcs.changeId;
        const headChangeId = HEAD.changeId;

        expect(getDesc(initialId)).toContain('initial commit');
        expect(getDesc(fakeTSId)).toContain('Added a fake ts file');
        expect(getDesc(ccId)).toContain('cc file');
        expect(getDesc(coolId)).toContain('pretty cool');
        expect(getDesc(vpmId)).toContain('vpmososp');
        expect(getDesc(headChangeId)).toContain('tqlynzyq');
        expect(getDesc(orcsId)).toContain('Orcs');

        expect(getParents(fakeTSId)).toContain(initialId);
        expect(getParents(coolId)).toContain(initialId);
        expect(getParents(ccId)).toContain(fakeTSId);
        expect(getParents(vpmId)).toContain(coolId);
        expect(getParents(orcsId)).toContain(coolId);
        expect(getParents(headChangeId)).toContain(vpmId);
    }, 30000);

    test('describe with revision updates specific commit', async () => {
        const jj = new JjService(repo.path);
        repo.new([], 'parent');
        const parentId = repo.getChangeId('@');
        repo.new([], 'child');

        await jj.describe('updated parent', parentId);

        const parentLog = repo.getDescription(parentId);
        expect(parentLog.trim()).toBe('updated parent');
    });

    test('getDescription fetches full description', async () => {
        repo.describe('multiline\ndescription\ntest');
        const desc = await jjService.getDescription('@');
        expect(desc.trim()).toBe('multiline\ndescription\ntest');
    });

    test('getDiff for merge commit shows combined diff', async () => {
        const filePath = path.join(repo.path, 'conflict.txt');
        fs.writeFileSync(filePath, 'base\n');
        repo.describe('parent');
        repo.new();

        repo.writeFile('conflict.txt', 'initial\nadded\n');

        const output = await jjService.getDiff('@', 'conflict.txt');
        expect(output).toContain('diff --git');
        expect(output).toContain('+added');
    });

    test('getDiff returns git formatted diff', async () => {
        repo.writeFile('diff-test.txt', 'initial\n');
        repo.describe('diff-base');
        repo.new();

        repo.writeFile('diff-test.txt', 'initial\nadded\n');

        const output = await jjService.getDiff('@', 'diff-test.txt');
        expect(output).toContain('diff --git');
        expect(output).toContain('+added');
    });

    test('getFileContent returns content at specific revision', async () => {
        repo.writeFile('content-test.txt', 'v1');
        repo.describe('v1');
        const v1ChangeId = repo.getChangeId('@');

        repo.new();
        repo.writeFile('content-test.txt', 'v2');

        const contentV1 = await jjService.getFileContent('content-test.txt', v1ChangeId);
        expect(contentV1).toBe('v1');

        const contentV2 = await jjService.getFileContent('content-test.txt', '@');
        expect(contentV2).toBe('v2');
    });

    test('setFileContent writes content to a specific revision', async () => {
        repo.writeFile('edit-me.txt', 'original content');
        repo.describe('parent');
        const parentId = repo.getChangeId('@');

        // Create a child commit on top
        repo.new();
        repo.writeFile('child-file.txt', 'child');

        // Edit the file in the parent revision
        await jjService.setFileContent(parentId, 'edit-me.txt', 'updated content');

        // Verify the parent revision has the new content
        const parentContent = repo.getFileContent(parentId, 'edit-me.txt');
        expect(parentContent).toBe('updated content');
    });

    test('setFilesContent writes multiple files to a specific revision atomically', async () => {
        repo.writeFile('file1.txt', 'old1');
        repo.writeFile('file2.txt', 'old2');
        repo.describe('parent');
        const parentId = repo.getChangeId('@');

        repo.new();
        repo.writeFile('child.txt', 'child');

        const files = new Map([
            ['file1.txt', 'new1'],
            ['file2.txt', 'new2'],
        ]);
        await jjService.setFilesContent(parentId, files);

        expect(repo.getFileContent(parentId, 'file1.txt')).toBe('new1');
        expect(repo.getFileContent(parentId, 'file2.txt')).toBe('new2');
    });

    test('movePartialToParent handles new files (not in parent)', async () => {
        const fileName = 'new-file.txt';
        const filePath = path.join(repo.path, fileName);

        repo.new();

        const content = 'line1\nline2\n';
        repo.writeFile(fileName, content);

        const ranges = [{ startLine: 0, endLine: 1 }];

        await jjService.movePartialToParent(fileName, ranges);

        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe(content);

        const diskContent = fs.readFileSync(filePath, 'utf8');
        expect(diskContent).toBe(content);

        const diff = await jjService.getDiff('@', fileName);
        expect(diff).toBe('');
    });

    test('movePartialToChild moves changes to child', async () => {
        const fileName = 'child-move.txt';
        const filePath = path.join(repo.path, fileName);

        await buildGraph(repo, [
            { label: 'grandparent', description: 'grandparent', files: { [fileName]: 'base\n' } },
            {
                label: 'parent',
                parents: ['grandparent'],
                description: 'parent',
                files: { [fileName]: 'base\nchange\n' },
            },
            { label: 'child', parents: ['parent'], description: 'child', isWorkingCopy: true },
        ]);

        expect(fs.readFileSync(filePath, 'utf8')).toBe('base\nchange\n');

        const ranges = [{ startLine: 1, endLine: 1 }];

        await jjService.movePartialToChild(fileName, ranges);

        const parentContent = await jjService.getFileContent(fileName, '@-');
        expect(parentContent).toBe('base\n');

        const childContent = fs.readFileSync(filePath, 'utf8');
        expect(childContent).toBe('base\nchange\n');

        const diff = await jjService.getDiff('@', fileName);
        expect(diff).toContain('+change');
    });

    test('movePartialToParent moves subset of changes', async () => {
        const fileName = 'partial.txt';

        repo.writeFile(fileName, 'line1\nline2\nline3\n');
        repo.describe('parent');
        repo.new();
        // Change line1 -> mod1
        // Change line3 -> mod3
        repo.writeFile(fileName, 'mod1\nline2\nmod3\n');

        // We want to move ONLY 'mod1' to parent.
        // Parent should become: 'mod1\nline2\nline3\n'
        // Child should become: 'mod1\nline2\nmod3\n'

        // Select 'mod1' (line 1, index 0)
        const ranges = [{ startLine: 0, endLine: 0 }];

        await jjService.movePartialToParent(fileName, ranges);

        // Verify Parent Content
        const parentContent = await jjService.getFileContent(fileName, '@-');
        expect(parentContent).toBe('mod1\nline2\nline3\n');

        // Verify Child Content (should remain same)
        const childContent = repo.readFile(fileName);
        expect(childContent).toBe('mod1\nline2\nmod3\n');
    });

    test('movePartialToChild leaves unselected changes in parent', async () => {
        const fileName = 'partial-child.txt';

        // Setup: Grandparent
        repo.writeFile(fileName, 'A\nB\nB2\nB3\nB4\nC\n');
        repo.describe('grandparent');

        // Parent: Modify A->ModA, C->ModC
        repo.new([], 'parent');
        repo.writeFile(fileName, 'ModA\nB\nModC\n');

        // Child: Inherits ModA, ModC
        repo.new([], 'child');

        // We want to move 'ModC' to Child.
        // Parent should revert 'ModC' -> 'C'.
        // Parent keeps 'ModA'.

        // We select Hunk 2 (Lines corresponding to ModC in Parent).
        // Range covers 'ModC' (Line 3, index 2).
        const ranges = [{ startLine: 2, endLine: 2 }];

        await jjService.movePartialToChild(fileName, ranges);

        // Verify Parent: Has ModA, but C reverted to C
        const parentContent = await jjService.getFileContent(fileName, '@-');
        expect(parentContent).toBe('ModA\nB\nB2\nB3\nB4\nC\n');

        // Verify Child: Still has ModA, ModC
        const childContent = repo.readFile(fileName);
        expect(childContent).toBe('ModA\nB\nModC\n');
    });

    test('movePartialToParent moves deletion', async () => {
        const fileName = 'deletion.txt';

        // Parent
        repo.writeFile(fileName, 'keep\ndelete\n');
        repo.describe('parent');
        repo.new();

        // Child deletes 'delete'
        repo.writeFile(fileName, 'keep\n');

        // Select the deletion (approximate range covering the area)
        const ranges = [{ startLine: 1, endLine: 2 }];

        await jjService.movePartialToParent(fileName, ranges);

        // Parent should now have deleted the line
        const parentContent = await jjService.getFileContent(fileName, '@-');
        expect(parentContent).toBe('keep\n');
    });

    test('getConflictedFiles returns conflicted paths', async () => {
        await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'conflict.txt': 'base\n' } },
            { label: 'left', parents: ['base'], description: 'left', files: { 'conflict.txt': 'left\n' } },
            { label: 'right', parents: ['base'], description: 'right', files: { 'conflict.txt': 'right\n' } },
            { label: 'merge', parents: ['left', 'right'], description: 'merge', isWorkingCopy: true },
        ]);

        const conflictedFiles = await jjService.getConflictedFiles();
        expect(conflictedFiles).toEqual(['conflict.txt']);
    });

    test('getConflictParts returns correct parts', async () => {
        const fileName = 'conflict.txt';
        await buildGraph(repo, [
            { label: 'base', description: 'base', files: { [fileName]: 'base content\n' } },
            { label: 'left', parents: ['base'], description: 'left', files: { [fileName]: 'left content\n' } },
            { label: 'right', parents: ['base'], description: 'right', files: { [fileName]: 'right content\n' } },
            { label: 'merge', parents: ['left', 'right'], description: 'merge', isWorkingCopy: true },
        ]);

        // Now we have a conflict in conflict.txt
        const parts = await jjService.getConflictParts(fileName);

        expect(parts.base).toBe('base content\n');
        expect(parts.left).toBe('left content\n');
        expect(parts.right).toBe('right content\n');
    });

    test('getLog returns file changes with statuses', async () => {
        await buildGraph(repo, [
            {
                label: 'setup',
                description: 'setup',
                files: { 'modified.txt': 'initial', 'deleted.txt': 'to delete' },
            },
            { parents: ['setup'], isWorkingCopy: true },
        ]);

        // Operations
        repo.writeFile('added.txt', 'new'); // Added
        repo.writeFile('modified.txt', 'modified'); // Modified
        repo.deleteFile('deleted.txt'); // Deleted

        const [log] = await jjService.getLog({ revision: '@' });
        expect(log.changes).toBeDefined();
        const changes = log.changes!;

        const added = changes.find((c) => c.path === 'added.txt');
        const modified = changes.find((c) => c.path === 'modified.txt');
        const deleted = changes.find((c) => c.path === 'deleted.txt');

        expect(added).toBeDefined();
        expect(added?.status).toBe('added');

        expect(modified).toBeDefined();
        expect(modified?.status).toBe('modified');

        expect(deleted).toBeDefined();
        expect(deleted?.status).toBe('removed');
    });

    test('moveBookmark moves bookmark to revision', async () => {
        // Setup: Create a bookmark on initial commit
        repo.bookmark('test-bookmark', '@');

        // Create a new commit (child)
        await jjService.new({ message: 'child' });
        const [child] = await jjService.getLog({ revision: '@' });

        // Move bookmark to child
        await jjService.moveBookmark('test-bookmark', child.change_id);

        // Verify bookmark moved
        const [childLog] = await jjService.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'test-bookmark' })]),
        );
    });

    test('rebase command supports source and revision modes with children', async () => {
        // Setup: Root -> Target
        //       -> Grandparent -> Parent -> Child
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'target', parents: ['root'], description: 'target' },
            { label: 'grandparent', parents: ['root'], description: 'grandparent' },
            { label: 'parent', parents: ['grandparent'], description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isWorkingCopy: true },
        ]);
        const rootId = ids['root'].changeId;
        const targetId = ids['target'].changeId;
        const grantparentId = ids['grandparent'].changeId;
        const parentId = ids['parent'].changeId;
        const childId = ids['child'].changeId;

        // 1. Rebase -r check (Revision Mode)
        // Scenario: Move "Parent" (-r) to "Target". Child should stay on Grandparent.

        await jjService.rebase(parentId, targetId, 'revision');

        const [parentLog] = await jjService.getLog({ revision: parentId });
        const [targetLog] = await jjService.getLog({ revision: targetId });
        const [childLog] = await jjService.getLog({ revision: childId });
        const [grandparentLog] = await jjService.getLog({ revision: grantparentId });

        // Parent is child of Target
        expect(parentLog.parents[0]).toBe(targetLog.commit_id);

        // Child is NOW child of Grandparent (orphaned from moved Parent)
        expect(childLog.parents[0]).toBe(grandparentLog.commit_id);

        // 2. Rebase -s check (Source Mode)
        // Scenario: Move Grandparent (-s) to Root. Child should follow.

        await jjService.rebase(grantparentId, rootId, 'source');

        const [grandparentLogAfter] = await jjService.getLog({ revision: grantparentId });
        const [childLogAfter] = await jjService.getLog({ revision: childId });
        const [rootLog] = await jjService.getLog({ revision: rootId });

        // Grandparent is child of Root
        expect(grandparentLogAfter.parents[0]).toBe(rootLog.commit_id);

        // Child is child of Grandparent
        expect(childLogAfter.parents[0]).toBe(grandparentLogAfter.commit_id);
    });

    test('getWorkingCopyChanges detects renamed file', async () => {
        const oldFile = 'old-rename.txt';
        const newFile = 'new-rename.txt';
        const content = 'line1\nline2\nline3\nline4\nline5\n'.repeat(10); // Sufficient content for similarity
        
        // Create file in parent
        repo.writeFile(oldFile, content);
        repo.describe('parent');
        
        // Start new change
        await jjService.new();
        
        repo.moveFile(oldFile, newFile);
        
        const changes = await jjService.getWorkingCopyChanges();
        
        // We expect jj to detect this as a rename because content is identical and large enough
        expect(changes.length).toBe(1);
        expect(changes[0].status).toBe('renamed');
        expect(changes[0].path).toBe(newFile);
        expect(changes[0].oldPath).toBe(oldFile);
    });

    test('getWorkingCopyChanges detects renamed file', async () => {
        const oldFile = 'old-rename.txt';
        const newFile = 'new-rename.txt';
        const content = 'line1\nline2\nline3\nline4\nline5\n'.repeat(10); // Sufficient content for similarity
        
        // Create file in parent
        repo.writeFile(oldFile, content);
        repo.describe('parent');
        
        await jjService.new();
        
        // Move file
        repo.moveFile(oldFile, newFile);
        
        const changes = await jjService.getWorkingCopyChanges();
        
        // We expect jj to detect this as a rename because content is identical and large enough
        expect(changes.length).toBe(1);
        expect(changes[0].status).toBe('renamed');
        expect(changes[0].path).toBe(newFile);
        expect(changes[0].oldPath).toBe(oldFile);
    });

    test('getLog includes oldPath for renamed files', async () => {
        const oldFile = 'old-log-rename.txt';
        const newFile = 'new-log-rename.txt';
        repo.writeFile(oldFile, 'log rename content');
        repo.describe('parent');
        await jjService.new();
        repo.moveFile(oldFile, newFile);
        
        const [logEntry] = await jjService.getLog({ revision: '@' });
        expect(logEntry).toBeDefined();
        
        const changes = logEntry.changes || [];
        const renameEntry = changes.find(c => c.path === newFile);
        expect(renameEntry).toBeDefined();
        expect(renameEntry?.status).toBe('renamed');
        expect(renameEntry?.oldPath).toBe(oldFile);
    });

    test('commit runs jj commit', async () => {
        // Setup state: Make a change
        repo.writeFile('file.txt', 'content');
        
        await jjService.commit('my commit message');

        // Verification:
        // 1. Current working copy (@) should be empty/new
        // 2. Parent (@-) should have the message "my commit message"
        
        const [head] = await jjService.getLog({ revision: '@' });
        const [parent] = await jjService.getLog({ revision: '@-' });

        expect(head.description).toBe('');
        expect(parent.description.trim()).toBe('my commit message');
    });

    test('getBookmarks returns bookmark names', async () => {
        repo.bookmark('feature-a', '@');
        repo.bookmark('feature-b', '@');
        
        const bookmarks = await jjService.getBookmarks();
        
        expect(bookmarks).toContain('feature-a');
        expect(bookmarks).toContain('feature-b');
        // We expect unique names. 
        // Note: We cannot easily simulate duplicates (remote vs local) in this simple test setup 
        // without valid remote fetching, but the implementation uses Set to guarantee uniqueness.
        const uniqueBookmarks = new Set(bookmarks);
        expect(bookmarks.length).toBe(uniqueBookmarks.size);
    });

    test('getGitBlobHashes returns correct blob hashes', async () => {
        const fileName = 'blob.txt';
        const fileContent = 'blob content';
        
        // Create a file and commit it
        repo.writeFile(fileName, fileContent);
        repo.describe('blob test');
        const commitId = repo.getCommitId('@');
        
        // Calculate expected Git hash
        // Git blob hash is SHA-1 of "blob <size>\0<content>"
        // For 'blob content', size is 12.
        // echo -n "blob content" | git hash-object --stdin
        // We can use the repo's git command to get the hash of the file content
        const expectedHash = cp.execFileSync('git', ['hash-object', path.join(repo.path, fileName)], { cwd: repo.path }).toString().trim();
        
        const hashes = await jjService.getGitBlobHashes(commitId, [fileName]);
        
        expect(hashes.size).toBe(1);
        expect(hashes.get(fileName)).toBe(expectedHash);
    });

    test('getDiffForRevision handles thundering herd concurrently', async () => {
        repo.writeFile('test.txt', 'content');
        repo.describe('thundering herd test');
        const commitId = repo.getCommitId('@');
        
        // Spy on run to count diffedit calls
        const runSpy = vi.spyOn(jjService as unknown as Record<'run', (...args: unknown[]) => Promise<unknown>>, 'run');
        
        // Trigger multiple concurrent requests
        const results = await Promise.all([
            jjService.getDiffForRevision(commitId),
            jjService.getDiffForRevision(commitId),
            jjService.getDiffForRevision(commitId),
        ]);
        
        // Verify they all returned the same thing (same tempDir)
        expect(results[0].tempDir).toBe(results[1].tempDir);
        expect(results[1].tempDir).toBe(results[2].tempDir);
        
        // Verify it was only called ONCE for diffedit bulk capture
        const diffeditCalls = runSpy.mock.calls.filter((call: unknown[]) => call[0] === 'diffedit');
        expect(diffeditCalls.length).toBe(1);
    });
});
