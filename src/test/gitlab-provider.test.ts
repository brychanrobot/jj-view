/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ChangeStatusRequest } from '../code-forge-provider';
import { GitLabProvider } from '../gitlab-provider';
import { accessPrivate, createMock, exposePrivate, setPrivate } from './test-utils';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: vi.fn(),
        }),
        onDidChangeConfiguration: vi.fn(),
    },
    Disposable: class {
        static from = vi.fn();
        dispose() {}
    },
    EventEmitter: class {
        event = vi.fn();
        fire = vi.fn();
        dispose = vi.fn();
    },
}));

describe('GitLabProvider', () => {
    let provider: GitLabProvider;
    let mockOutputChannel: vscode.OutputChannel;

    beforeEach(() => {
        mockOutputChannel = createMock<vscode.OutputChannel>({ appendLine: vi.fn() });
        provider = new GitLabProvider(mockOutputChannel);
    });

    test('parseGitLabUrl correctly parses standard, subgroup, and configured host URLs', () => {
        const priv = exposePrivate<{
            parseGitLabUrl(url: string, configuredHost?: string): { host: string; projectPath: string } | undefined;
        }>(provider);
        const parseUrl = priv.parseGitLabUrl.bind(provider);

        // Standard gitlab.com URLs
        expect(parseUrl('https://gitlab.com/owner/repo.git')).toEqual({
            host: 'https://gitlab.com',
            projectPath: 'owner/repo',
        });
        expect(parseUrl('git@gitlab.com:owner/repo.git')).toEqual({
            host: 'https://gitlab.com',
            projectPath: 'owner/repo',
        });
        expect(parseUrl('https://gitlab.com/group/subgroup/repo')).toEqual({
            host: 'https://gitlab.com',
            projectPath: 'group/subgroup/repo',
        });

        // Self-hosted domain auto-detection
        expect(parseUrl('https://mygitlab.org/owner/repo.git')).toEqual({
            host: 'https://mygitlab.org',
            projectPath: 'owner/repo',
        });
        expect(parseUrl('git@mygitlab.org:owner/repo.git')).toEqual({
            host: 'https://mygitlab.org',
            projectPath: 'owner/repo',
        });

        // Configured host (matching self-hosted GitLab)
        expect(parseUrl('https://gitlab.example.com/owner/repo.git', 'https://gitlab.example.com')).toEqual({
            host: 'https://gitlab.example.com',
            projectPath: 'owner/repo',
        });
        // Configured host with path prefix
        expect(
            parseUrl('https://gitlab.example.com/gitlab/owner/repo.git', 'https://gitlab.example.com/gitlab'),
        ).toEqual({
            host: 'https://gitlab.example.com/gitlab',
            projectPath: 'owner/repo',
        });

        // Configured host with SSH port URL
        expect(parseUrl('ssh://git@gitlab.example.com:2222/owner/repo.git', 'https://gitlab.example.com')).toEqual({
            host: 'https://gitlab.example.com',
            projectPath: 'owner/repo',
        });

        // Strict host matching (preventing substring matching, e.g. mygitlab.example.com vs gitlab.example.com)
        expect(parseUrl('https://mygitlab.example.com/owner/repo.git', 'https://gitlab.example.com')).toBeUndefined();
        expect(
            parseUrl('https://gitlab.example.com.suffix/owner/repo.git', 'https://gitlab.example.com'),
        ).toBeUndefined();
    });

    test('detect cleans up old state first', async () => {
        setPrivate(provider, 'gitlabHost', 'https://gitlab.old');
        setPrivate(provider, 'projectPath', 'old-owner/old-repo');

        const remotes = [{ name: 'origin', url: 'https://gitlab.com/new-owner/new-repo.git' }];
        const result = await provider.detect('/root', remotes);

        expect(result).toBe(true);
        expect(accessPrivate(provider, 'gitlabHost')).toBe('https://gitlab.com');
        expect(accessPrivate(provider, 'projectPath')).toBe('new-owner/new-repo');

        const invalidRemotes = [{ name: 'origin', url: 'https://github.com/some/repo.git' }];
        const result2 = await provider.detect('/root', invalidRemotes);

        expect(result2).toBe(false);
        expect(accessPrivate(provider, 'gitlabHost')).toBeUndefined();
        expect(accessPrivate(provider, 'projectPath')).toBeUndefined();
    });

    test('clearCache resets tokenRequested state', () => {
        setPrivate(provider, 'tokenRequested', true);
        provider.clearCache();
        expect(accessPrivate(provider, 'tokenRequested')).toBe(false);
    });

    test('parseGitLabMr calculates submittable correctly based on draft, merge_status, and blocking_discussions_resolved', () => {
        interface MockGitLabMr {
            id: number;
            iid: number;
            state: string;
            title: string;
            web_url: string;
            draft: boolean;
            merge_status: string;
            detailed_merge_status?: string;
            blocking_discussions_resolved?: boolean;
            sha: string;
            user_notes_count?: number;
        }

        const priv = exposePrivate<{
            parseGitLabMr(mr: MockGitLabMr): { submittable: boolean; unresolvedComments: number } | undefined;
        }>(provider);
        const parseMr = priv.parseGitLabMr.bind(provider);

        // 1. Fully mergeable, not draft, discussions resolved
        expect(
            parseMr({
                id: 1,
                iid: 1,
                state: 'opened',
                title: 'title',
                web_url: 'url',
                draft: false,
                merge_status: 'can_be_merged',
                blocking_discussions_resolved: true,
                sha: 'sha-1',
            })?.submittable,
        ).toBe(true);

        // 2. Draft
        expect(
            parseMr({
                id: 2,
                iid: 2,
                state: 'opened',
                title: 'title',
                web_url: 'url',
                draft: true,
                merge_status: 'can_be_merged',
                blocking_discussions_resolved: true,
                sha: 'sha-2',
            })?.submittable,
        ).toBe(false);

        // 3. Cannot be merged (conflicts)
        expect(
            parseMr({
                id: 3,
                iid: 3,
                state: 'opened',
                title: 'title',
                web_url: 'url',
                draft: false,
                merge_status: 'cannot_be_merged',
                blocking_discussions_resolved: true,
                sha: 'sha-3',
            })?.submittable,
        ).toBe(false);

        // 4. Unresolved discussions
        const result = parseMr({
            id: 4,
            iid: 4,
            state: 'opened',
            title: 'title',
            web_url: 'url',
            draft: false,
            merge_status: 'can_be_merged',
            blocking_discussions_resolved: false,
            sha: 'sha-4',
            user_notes_count: 5,
        });
        expect(result?.submittable).toBe(false);
        expect(result?.unresolvedComments).toBe(5);

        // 5. Blocked by CI pipeline
        expect(
            parseMr({
                id: 5,
                iid: 5,
                state: 'opened',
                title: 'title',
                web_url: 'url',
                draft: false,
                merge_status: 'can_be_merged',
                detailed_merge_status: 'ci_must_pass',
                blocking_discussions_resolved: true,
                sha: 'sha-5',
            })?.submittable,
        ).toBe(false);

        // 6. Blocked by unresolved discussions via detailed_merge_status
        const result2 = parseMr({
            id: 6,
            iid: 6,
            state: 'opened',
            title: 'title',
            web_url: 'url',
            draft: false,
            merge_status: 'can_be_merged',
            detailed_merge_status: 'discussions_not_resolved',
            blocking_discussions_resolved: true,
            sha: 'sha-6',
            user_notes_count: 3,
        });
        expect(result2?.submittable).toBe(false);
        expect(result2?.unresolvedComments).toBe(3);
    });

    test('fetchStatuses chunks requests using BATCH_SIZE of 10', async () => {
        setPrivate(provider, 'gitlabHost', 'https://gitlab.com');
        setPrivate(provider, 'projectPath', 'my-owner/my-repo');

        const fetchBatchSpy = vi
            .spyOn(
                exposePrivate<{
                    fetchBatchFromNetwork(bookmarkNames: string[]): Promise<Map<string, unknown>>;
                }>(provider),
                'fetchBatchFromNetwork',
            )
            .mockImplementation(async (bookmarkNames: string[]) => {
                const results = new Map<string, unknown>();
                for (const name of bookmarkNames) {
                    results.set(name, {
                        id: `id-${name}`,
                        number: 1,
                        displayLabel: 'MR !1',
                        providerName: 'GitLab',
                        status: 'NEW',
                        submittable: true,
                        url: 'url',
                        currentRevision: 'sha',
                    });
                }
                return results;
            });

        const changes: ChangeStatusRequest[] = [];
        for (let i = 1; i <= 25; i++) {
            changes.push({
                commitId: `sha-${i}`,
                bookmarks: [`bm-${i}`],
            });
        }

        const result = await provider.fetchStatuses(changes);
        expect(result).toBe(true);

        expect(fetchBatchSpy).toHaveBeenCalledTimes(3);
        expect(fetchBatchSpy.mock.calls[0][0].length).toBe(10);
        expect(fetchBatchSpy.mock.calls[1][0].length).toBe(10);
        expect(fetchBatchSpy.mock.calls[2][0].length).toBe(5);
    });
});
