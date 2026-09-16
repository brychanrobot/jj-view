/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodeForgeRegistry } from '../core/code-forge-registry';
import { LogViewController } from '../core/controllers/log-view-controller';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import type { JjLogEntry } from '../core/jj-types';
import { Uri } from '../core/uri-utils';
import { findMatchingCommit } from '../core/webview/log/utils/commit-utils';
import { VsCodeHostNavigation } from '../vscode/vscode-host-environment';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('QuickPick Commit Highlight', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let registry: CodeForgeRegistry;
    let controller: LogViewController;
    let postedMessages: { type: string; [key: string]: unknown }[];

    beforeEach(async () => {
        vi.clearAllMocks();
        postedMessages = [];
        testRepo = new TestRepo();
        testRepo.init();

        registry = new CodeForgeRegistry();
        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        fakeHost = new FakeHostEnvironment();
        fakeHost.workspace.addFolder(Uri.file(testRepo.path));

        repositoryManager = new JjRepositoryManager(registry, outputChannel, fakeHost);
        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        controller = new LogViewController(repo, fakeHost, {
            messenger: {
                postMessage: (m) => postedMessages.push(m as { type: string; [key: string]: unknown }),
            },
        });
    });

    afterEach(async () => {
        controller.dispose();
        await repositoryManager.dispose();
    });

    test('LogViewController dispatches setHighlight IPC and tracks highlightedCommitId', () => {
        expect(controller.highlightedCommitId).toBeUndefined();

        controller.setHighlightedCommit('kkmpptxz');
        expect(controller.highlightedCommitId).toBe('kkmpptxz');
        expect(postedMessages).toContainEqual({
            type: 'setHighlight',
            payload: { changeId: 'kkmpptxz' },
        });

        // Repeating identical value should not re-dispatch
        const count = postedMessages.length;
        controller.setHighlightedCommit('kkmpptxz');
        expect(postedMessages.length).toBe(count);

        // Clearing highlight
        controller.setHighlightedCommit(undefined);
        expect(controller.highlightedCommitId).toBeUndefined();
        expect(postedMessages).toContainEqual({
            type: 'setHighlight',
            payload: { changeId: undefined },
        });
    });

    test('VsCodeHostNavigation routes highlightCommit through setHighlightDelegate', () => {
        const nav = new VsCodeHostNavigation();
        const calls: { repoRoot: Uri; changeId: string | undefined }[] = [];

        // No delegate registered: safe no-op
        expect(() => nav.highlightCommit(Uri.file('/repo'), 'rev1')).not.toThrow();

        nav.setHighlightDelegate((repoRoot, changeId) => {
            calls.push({ repoRoot, changeId });
        });

        const repoUri = Uri.file(testRepo.path);
        nav.highlightCommit(repoUri, 'rev123');
        expect(calls).toEqual([{ repoRoot: repoUri, changeId: 'rev123' }]);

        nav.highlightCommit(repoUri, undefined);
        expect(calls).toEqual([
            { repoRoot: repoUri, changeId: 'rev123' },
            { repoRoot: repoUri, changeId: undefined },
        ]);
    });

    test('Delegate forwards to matching LogViewController and ignores other repositories', () => {
        const nav = new VsCodeHostNavigation();
        const repoUri = Uri.file(testRepo.path);
        const otherUri = Uri.file('/different/repo');

        nav.setHighlightDelegate((repoRoot, changeId) => {
            if (repoRoot.fsPath === controller.repository?.rootUri.fsPath) {
                controller.setHighlightedCommit(changeId);
            }
        });

        // Call with mismatched repo
        nav.highlightCommit(otherUri, 'c1');
        expect(controller.highlightedCommitId).toBeUndefined();

        // Call with matching repo
        nav.highlightCommit(repoUri, 'c1');
        expect(controller.highlightedCommitId).toBe('c1');

        // Clear highlight
        nav.highlightCommit(repoUri, undefined);
        expect(controller.highlightedCommitId).toBeUndefined();
    });

    test('findMatchingCommit resolves various revision formats to visible graph commits', () => {
        const dummyCommits: JjLogEntry[] = [
            createMock<JjLogEntry>({
                change_id: 'kkmpptxz',
                commit_id: '87a53fdd11112222333344445555666677778888',
                change_id_shortest: 'k',
                is_current_working_copy: true,
                parents: [
                    {
                        change_id: 'qutpskpt',
                        commit_id: '1111222233334444555566667777888899990000',
                        is_immutable: false,
                    },
                ],
                bookmarks: [
                    { name: 'main', remote: null },
                    { name: 'feature', remote: 'origin' },
                ],
                tags: ['v1.0.0'],
            }),
            createMock<JjLogEntry>({
                change_id: 'qutpskpt/0',
                commit_id: '1111222233334444555566667777888899990000',
                change_id_shortest: 'q',
                is_current_working_copy: false,
                parents: [],
                bookmarks: [{ name: 'old-main', remote: null }],
                tags: [],
            }),
        ];

        // Exact change_id
        expect(findMatchingCommit(dummyCommits, 'kkmpptxz')?.change_id).toBe('kkmpptxz');
        // Change ID without divergent offset
        expect(findMatchingCommit(dummyCommits, 'qutpskpt')?.change_id).toBe('qutpskpt/0');
        // Change ID prefix
        expect(findMatchingCommit(dummyCommits, 'kkm')?.change_id).toBe('kkmpptxz');
        expect(findMatchingCommit(dummyCommits, 'qut')?.change_id).toBe('qutpskpt/0');
        // Exact commit SHA and prefix
        expect(findMatchingCommit(dummyCommits, '87a53fdd11112222333344445555666677778888')?.change_id).toBe(
            'kkmpptxz',
        );
        expect(findMatchingCommit(dummyCommits, '87a5')?.change_id).toBe('kkmpptxz');
        expect(findMatchingCommit(dummyCommits, '1111')?.change_id).toBe('qutpskpt/0');
        // Bookmark name and remote bookmark (exact and prefix)
        expect(findMatchingCommit(dummyCommits, 'main')?.change_id).toBe('kkmpptxz');
        expect(findMatchingCommit(dummyCommits, 'feature@origin')?.change_id).toBe('kkmpptxz');
        expect(findMatchingCommit(dummyCommits, 'feature@orig')?.change_id).toBe('kkmpptxz');
        expect(findMatchingCommit(dummyCommits, 'feat')?.change_id).toBe('kkmpptxz');
        expect(findMatchingCommit(dummyCommits, 'old-main')?.change_id).toBe('qutpskpt/0');
        expect(findMatchingCommit(dummyCommits, 'old-m')?.change_id).toBe('qutpskpt/0');
        // Tag name
        expect(findMatchingCommit(dummyCommits, 'v1.0.0')?.change_id).toBe('kkmpptxz');
        // Working copy @ and parent @-
        expect(findMatchingCommit(dummyCommits, '@')?.change_id).toBe('kkmpptxz');
        expect(findMatchingCommit(dummyCommits, '@-')?.change_id).toBe('qutpskpt/0');
        // Non-matching / empty
        expect(findMatchingCommit(dummyCommits, 'nonexistent')).toBeUndefined();
        expect(findMatchingCommit(dummyCommits, '')).toBeUndefined();
        expect(findMatchingCommit(dummyCommits, undefined)).toBeUndefined();
    });
});
