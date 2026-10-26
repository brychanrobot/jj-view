/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { CodeForgeService } from '../core/code-forge-service';
import { uploadCommand } from '../core/commands/upload';
import type { CustomCliForgeProvider } from '../core/custom-cli-forge-provider';
import type { JjRepository } from '../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { FakeCommandContext, FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMock } from './test-utils';

describe('CustomCliForgeProvider and CodeForge Integration', () => {
    let tempDir: string;
    let adapterScriptPath: string;
    let adapterStatePath: string;
    let testRepo: TestRepo;
    let jjService: JjService;
    let host: FakeHostEnvironment;
    let registry: CodeForgeRegistry;
    let codeForgeService: CodeForgeService;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-cli-test-'));
        adapterScriptPath = path.join(tempDir, 'adapter.mjs');
        adapterStatePath = path.join(tempDir, 'adapter-state.json');

        const scriptContent = `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const subcommand = args[0];
const stateFile = process.env.TEST_ADAPTER_STATE_FILE;

let state = {};
if (stateFile && fs.existsSync(stateFile)) {
    try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
        state = {};
    }
}

if (subcommand === 'detect') {
    console.log(JSON.stringify({
        detected: true,
        id: 'custom-forge',
        displayName: 'Custom Forge',
        changeTerm: 'Change',
        uploadModel: 'revision',
        managedBookmarkPattern: '^change/(\\\\d+)$'
    }));
    process.exit(0);
}

if (subcommand === 'statuses') {
    const revisionsIndex = args.indexOf('--revisions');
    const revisions = revisionsIndex !== -1 ? args.slice(revisionsIndex + 1) : [];
    const rows = revisions.map((rev) => {
        if (state[rev] !== undefined) {
            return {
                commitId: rev,
                changeId: state[rev]?.changeId ?? ('change-' + rev.substring(0, 8)),
                info: state[rev]?.info
            };
        }
        return {
            commitId: rev,
            changeId: 'change-' + rev.substring(0, 8),
            info: {
                id: '12345',
                number: 12345,
                url: 'https://review.example.com/change/12345',
                status: 'NEW',
                currentRevision: rev,
                contentSynced: true,
                parentSynced: true,
                synced: true,
                submittable: true,
                unresolvedComments: 1
            }
        };
    });
    console.log(JSON.stringify(rows));
    process.exit(0);
}

if (subcommand === 'upload') {
    const revIdx = args.indexOf('--revision');
    const rev = revIdx !== -1 ? args[revIdx + 1] : 'unknown';
    if (stateFile) {
        state.lastUploadedRevision = rev;
        fs.writeFileSync(stateFile, JSON.stringify(state));
    }
    console.log('Uploaded CL 12345 (revision ' + rev + ')');
    process.exit(0);
}

if (subcommand === 'list-comments') {
    if (stateFile) {
        state.lastListCommentsCwd = process.cwd();
        state.listCommentsCalls = (state.listCommentsCalls ?? 0) + 1;
        fs.writeFileSync(stateFile, JSON.stringify(state));
    }
    if (state.customThreads) {
        console.log(JSON.stringify(state.customThreads));
        process.exit(0);
    }
    console.log(JSON.stringify([
        {
            id: 'thread-1',
            filePath: 'foo.txt',
            line: 2,
            isResolved: false,
            comments: [
                {
                    id: 'c1',
                    author: { name: 'Reviewer' },
                    body: 'Please check this line',
                    createdAt: '2026-10-20T12:00:00Z'
                }
            ]
        },
        {
            id: 'thread-2',
            filePath: '',
            isResolved: true,
            comments: [
                {
                    id: 'c2',
                    author: { name: 'Reviewer' },
                    body: 'Change-level review comment',
                    createdAt: '2026-10-20T12:05:00Z'
                }
            ]
        }
    ]));
    process.exit(0);
}

if (subcommand === 'reply-comment') {
    if (stateFile) {
        state.lastReplyCommentCwd = process.cwd();
        fs.writeFileSync(stateFile, JSON.stringify(state));
    }
    const bodyIdx = args.indexOf('--body');
    const body = bodyIdx !== -1 ? args[bodyIdx + 1] : '';
    console.log(JSON.stringify({
        id: 'reply-1',
        author: { name: 'Me' },
        body: body,
        createdAt: '2026-10-20T12:10:00Z'
    }));
    process.exit(0);
}

if (subcommand === 'resolve-comment') {
    if (stateFile) {
        state.lastResolveCommentCwd = process.cwd();
        fs.writeFileSync(stateFile, JSON.stringify(state));
    }
    process.exit(0);
}

console.error('Unknown subcommand: ' + subcommand);
process.exit(1);
`;
        fs.writeFileSync(adapterScriptPath, scriptContent, { mode: 0o755 });
        fs.writeFileSync(adapterStatePath, JSON.stringify({}));
        process.env.TEST_ADAPTER_STATE_FILE = adapterStatePath;

        testRepo = new TestRepo();
        testRepo.init();
        jjService = new JjService(testRepo.path, NO_OP_LOGGER);

        host = new FakeHostEnvironment();
        host.config.set('codeForge.adapterCommand', adapterScriptPath);

        registry = new CodeForgeRegistry();
        codeForgeService = new CodeForgeService(testRepo.path, jjService, registry, host, NO_OP_LOGGER);
    });

    afterEach(async () => {
        delete process.env.TEST_ADAPTER_STATE_FILE;
        codeForgeService.dispose();
        registry.dispose();
        await testRepo.dispose();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    test('detect activates Custom Forge provider with configured schema and settings', async () => {
        const detected = await codeForgeService.detectActiveProvider(true);
        expect(detected).toBe(true);

        const activeProvider = codeForgeService.activeProvider;
        expect(activeProvider).toBeDefined();
        expect(activeProvider?.id).toBe('custom-forge');
        expect(activeProvider?.displayName).toBe('Custom Forge');
        expect(activeProvider?.changeTerm).toBe('Change');
        expect(activeProvider?.uploadModel).toBe('revision');
        expect(activeProvider?.isManagedBookmark?.('change/12345')).toBe(true);
        expect(activeProvider?.isManagedBookmark?.('change/999999')).toBe(true);
        expect(activeProvider?.isManagedBookmark?.('my-feature')).toBe(false);
    });

    test('UI-level bookmark filtering hides managed bookmarks while JjService returns raw bookmarks', async () => {
        await codeForgeService.detectActiveProvider(true);

        const ids = await buildGraph(testRepo, [
            {
                label: 'commitA',
                description: 'first commit',
                files: { 'file.txt': 'line 1\n' },
                bookmarks: ['change/12345', 'my-feature'],
            },
        ]);

        // JjService.getBookmarks() returns raw repository bookmarks (unfiltered)
        const bookmarks = await jjService.getBookmarks();
        const bookmarkNames = bookmarks.map((b) => b.name);
        expect(bookmarkNames).toContain('my-feature');
        expect(bookmarkNames).toContain('change/12345');

        // JjService.getLog() returns raw commit bookmarks (unfiltered)
        const logEntries = await jjService.getLog({ revision: ids.commitA.commitId });
        expect(logEntries).toHaveLength(1);
        expect((logEntries[0].bookmarks ?? []).map((b) => b.name)).toEqual(
            expect.arrayContaining(['change/12345', 'my-feature']),
        );

        // CodeForgeService.populateCodeForgeInfo filters out managed bookmarks for UI display
        codeForgeService.populateCodeForgeInfo(logEntries);
        expect((logEntries[0].bookmarks ?? []).map((b) => b.name)).toEqual(['my-feature']);
    });

    test('fetchStatuses and populateCodeForgeInfo handle sync and local amendment needsUpload transition', async () => {
        await codeForgeService.detectActiveProvider(true);

        const ids = await buildGraph(testRepo, [
            {
                label: 'commitA',
                description: 'commit for status test',
                files: { 'file.txt': 'initial content\n' },
            },
        ]);
        const commitId = ids.commitA.commitId;
        const changeId = ids.commitA.changeId;

        // Configure adapter state with synced status
        const initialState = {
            [commitId]: {
                changeId,
                info: {
                    id: '12345',
                    number: 12345,
                    url: 'https://review.example.com/change/12345',
                    status: 'NEW',
                    currentRevision: commitId,
                    contentSynced: true,
                    parentSynced: true,
                    synced: true,
                    submittable: true,
                    unresolvedComments: 0,
                },
            },
        };
        fs.writeFileSync(adapterStatePath, JSON.stringify(initialState));

        const updated = await codeForgeService.ensureFreshStatuses([{ commitId, changeId }]);
        expect(updated).toBe(true);

        const entries = await jjService.getLog({ revision: commitId });
        expect(entries).toHaveLength(1);
        codeForgeService.populateCodeForgeInfo(entries);

        expect(entries[0].codeForgeNeedsUpload).toBe(false);
        expect(entries[0].codeForgeChange?.contentSynced).toBe(true);
        expect(entries[0].codeForgeChange?.synced).toBe(true);

        // Amend the commit locally so commitId changes while changeId remains the same
        testRepo.describe('updated commit message', changeId);
        const amendedCommitId = testRepo.getCommitId(changeId);
        expect(amendedCommitId).not.toBe(commitId);

        const amendedEntries = await jjService.getLog({ revision: amendedCommitId });
        expect(amendedEntries).toHaveLength(1);
        codeForgeService.populateCodeForgeInfo(amendedEntries);

        // Immediate transition to codeForgeNeedsUpload: true before next background poll
        expect(amendedEntries[0].codeForgeNeedsUpload).toBe(true);
        expect(amendedEntries[0].codeForgeChange?.contentSynced).toBe(false);
        expect(amendedEntries[0].codeForgeChange?.synced).toBe(false);
    });

    test('uploadCommand invokes adapter upload --revision via runExternalMutation', async () => {
        await codeForgeService.detectActiveProvider(true);

        const ids = await buildGraph(testRepo, [
            {
                label: 'commitA',
                description: 'commit to upload',
                files: { 'file.txt': 'uploaded file\n' },
            },
        ]);
        const commitId = ids.commitA.commitId;

        const mockRepo = createMock<JjRepository>({
            jj: jjService,
            codeForge: codeForgeService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });

        const ctx = new FakeCommandContext(mockRepo, host);
        await uploadCommand(ctx, { revision: commitId });

        // Verify adapter received upload --revision
        const savedState = JSON.parse(fs.readFileSync(adapterStatePath, 'utf8')) as {
            lastUploadedRevision?: string;
        };
        expect(savedState.lastUploadedRevision).toBe(commitId);
        expect(ctx.host.ui.infoMessages).toContain('Upload successful');
        expect(mockRepo.refresh).toHaveBeenCalled();
    });

    test('comments integration and getCommitDiffHunks computation across commits', async () => {
        await codeForgeService.detectActiveProvider(true);
        const provider = codeForgeService.activeProvider as CustomCliForgeProvider;
        expect(provider).toBeDefined();

        // 1. Comment threads (including file-level and change-level)
        const threads = await provider.getCommentThreads('change-123');
        expect(threads).toHaveLength(2);
        expect(threads[0].filePath).toBe('foo.txt');
        expect(threads[0].line).toBe(2);
        expect(threads[1].filePath).toBe('');

        // 2. Reply to comment
        const reply = await provider.replyToCommentThread('change-123', threads[0], 'Acknowledged', true);
        expect(reply.id).toBe('reply-1');
        expect(reply.body).toBe('Acknowledged');

        // 3. Resolve comment
        await expect(provider.resolveCommentThread('change-123', threads[0], true)).resolves.toBeUndefined();

        // Verify cwd was passed to list-comments, reply-comment, and resolve-comment
        const expectedCwd = fs.realpathSync(testRepo.path);
        const savedState = JSON.parse(fs.readFileSync(adapterStatePath, 'utf8')) as {
            lastListCommentsCwd?: string;
            lastReplyCommentCwd?: string;
            lastResolveCommentCwd?: string;
        };
        expect(fs.realpathSync(savedState.lastListCommentsCwd ?? '')).toBeSameFsPath(expectedCwd);
        expect(fs.realpathSync(savedState.lastReplyCommentCwd ?? '')).toBeSameFsPath(expectedCwd);
        expect(fs.realpathSync(savedState.lastResolveCommentCwd ?? '')).toBeSameFsPath(expectedCwd);

        // 4. JjService.getCommitDiffHunks using jj diff --git --context=0
        const ids = await buildGraph(testRepo, [
            {
                label: 'base',
                description: 'base version',
                files: { 'foo.txt': 'line 1\nline 2\nline 3\nline 4\nline 5\n' },
            },
            {
                label: 'second',
                parents: ['base'],
                description: 'second version',
                files: { 'foo.txt': 'line 1\nline 2 modified\nline 3\nline 4\nline 5\nline 6\n' },
            },
        ]);

        const diffHunksMap = await jjService.getCommitDiffHunks(ids.base.commitId, ids.second.commitId, ['foo.txt']);
        expect(diffHunksMap).toBeDefined();
        expect(diffHunksMap?.has('foo.txt')).toBe(true);

        const fooHunks = diffHunksMap?.get('foo.txt');
        expect(fooHunks).toBeDefined();
        expect(fooHunks?.length).toBeGreaterThan(0);
    });

    test('draft comment metrics, upload cache invalidation, and populateCodeForgeInfo bookmark filtering', async () => {
        const ids = await buildGraph(testRepo, [
            {
                label: 'commitA',
                description: 'commit with drafts and managed bookmark',
                files: { 'file.txt': 'content\n' },
                bookmarks: ['change/12345', 'user-branch'],
            },
        ]);
        const commitId = ids.commitA.commitId;
        const changeId = ids.commitA.changeId;

        // Fetch log BEFORE detectActiveProvider runs (simulating startup race)
        const preDetectEntries = await jjService.getLog({ revision: commitId });
        expect((preDetectEntries[0]?.bookmarks ?? []).map((b) => b.name)).toContain('change/12345');

        await codeForgeService.detectActiveProvider(true);
        const provider = codeForgeService.activeProvider as CustomCliForgeProvider;

        const stateWithDrafts = {
            [commitId]: {
                changeId,
                info: {
                    id: '12345',
                    number: 12345,
                    url: 'https://review.example.com/change/12345',
                    status: 'NEW',
                    currentRevision: commitId,
                    contentSynced: true,
                    parentSynced: true,
                    synced: true,
                    submittable: false,
                    unresolvedComments: 1,
                    hasDraftComments: true,
                },
            },
            customThreads: [
                {
                    id: 'thread-unresolved',
                    filePath: 'file.txt',
                    line: 1,
                    isResolved: false,
                    comments: [
                        {
                            id: 'c1',
                            author: { name: 'Reviewer' },
                            body: 'Fix this',
                            createdAt: '2026-10-20T12:00:00Z',
                            isDraft: false,
                        },
                        {
                            id: 'r1',
                            author: { name: 'Author' },
                            body: 'Done (draft)',
                            createdAt: '2026-10-20T12:05:00Z',
                            isDraft: true,
                        },
                    ],
                },
                {
                    id: 'thread-draft-root',
                    filePath: 'file.txt',
                    line: 2,
                    isResolved: false,
                    comments: [
                        {
                            id: 'c2',
                            author: { name: 'Author' },
                            body: 'Self-review draft note',
                            createdAt: '2026-10-20T12:06:00Z',
                            isDraft: true,
                        },
                    ],
                },
            ],
        };
        fs.writeFileSync(adapterStatePath, JSON.stringify(stateWithDrafts));

        await codeForgeService.ensureFreshStatuses([{ commitId, changeId }]);

        // populateCodeForgeInfo filters out managed change/12345 even on pre-detect log entries
        codeForgeService.populateCodeForgeInfo(preDetectEntries);
        expect((preDetectEntries[0]?.bookmarks ?? []).map((b) => b.name)).toEqual(['user-branch']);
        expect(preDetectEntries[0]?.codeForgeChange?.draftComments).toBe(1);

        // Fetching comment threads refines draftComments, draftResponses, and addressedThreads
        const threads = await provider.getCommentThreads('12345');
        expect(threads).toHaveLength(2);

        const updatedInfo = provider.getCachedChangeInfo(changeId, undefined, undefined, commitId);
        expect(updatedInfo?.draftComments).toBe(1);
        expect(updatedInfo?.draftResponses).toBe(1);
        expect(updatedInfo?.addressedThreads).toBe(1);
        expect(updatedInfo?.hasDraftResponses).toBe(true);

        // Second call to getCommentThreads('12345') hits cache
        await provider.getCommentThreads('12345');
        let currentState = JSON.parse(fs.readFileSync(adapterStatePath, 'utf8')) as { listCommentsCalls?: number };
        expect(currentState.listCommentsCalls).toBe(1);

        // Uploading by commitId invalidates commentsCache for '12345'
        await provider.uploadRevision(commitId, jjService);
        await provider.getCommentThreads('12345');
        currentState = JSON.parse(fs.readFileSync(adapterStatePath, 'utf8')) as { listCommentsCalls?: number };
        expect(currentState.listCommentsCalls).toBe(2);
    });
});
