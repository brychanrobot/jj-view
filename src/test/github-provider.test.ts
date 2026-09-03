/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CodeForgeAuthManager } from '../core/code-forge-auth';
import type { AuthManageItem, ChangeStatusRequest, StackCommitNode } from '../core/code-forge-provider';
import { GitHubProvider } from '../core/github-provider';
import type { HostSecrets } from '../core/host/host-environment';
import { JjService } from '../core/jj-service';
import type { CodeForgeChangeInfo } from '../core/jj-types';
import { FakeGitHubServer } from './helpers/fake-github-server';
import { TestRepo } from './test-repo';
import {
    accessPrivate,
    createMock,
    createMockLogOutputChannel,
    exposePrivate,
    FakeConfigStore,
    setPrivate,
} from './test-utils';

const fakeConfigStore = new FakeConfigStore();

// Mock VS Code
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => fakeConfigStore.toWorkspaceConfiguration(),
        onDidChangeConfiguration: vi.fn(),
    },
    window: {
        showWarningMessage: vi.fn(),
        showInputBox: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
    authentication: {
        getSession: vi.fn(),
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

describe('GitHubProvider', () => {
    let provider: GitHubProvider;
    let mockOutputChannel: vscode.LogOutputChannel;
    let mockAuthManager: CodeForgeAuthManager;
    let originalEnv: string | undefined;
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalEnv = process.env.JJ_VIEW_GITHUB_TOKEN;
        originalFetch = global.fetch;
        mockOutputChannel = createMockLogOutputChannel({ appendLine: vi.fn() });
        mockAuthManager = createMock<CodeForgeAuthManager>({
            isAuthSkipped: vi.fn().mockReturnValue(false),
            hasPromptedThisSession: vi.fn().mockReturnValue(false),
            markPromptedThisSession: vi.fn(),
            setAuthSkipped: vi.fn(),
            registerProvider: vi.fn(),
            getSessionToken: vi.fn().mockResolvedValue('test-token'),
            hasOAuthSession: vi.fn().mockResolvedValue(false),
            performOAuthSignIn: vi.fn(),
            getAuthManageItems: vi.fn(),
            promptForPat: vi.fn(),
            secrets: createMock<HostSecrets>({
                get: vi.fn(),
                store: vi.fn(),
                delete: vi.fn(),
            }),
        });
        provider = new GitHubProvider(mockAuthManager, mockOutputChannel);
        vi.mocked(vscode.window.showWarningMessage).mockReset();
    });

    afterEach(() => {
        process.env.JJ_VIEW_GITHUB_TOKEN = originalEnv;
        global.fetch = originalFetch;
    });

    test('parseGitHubUrl correctly parses standard and dotted repo URLs', () => {
        const priv = exposePrivate<{
            parseGitHubUrl(url: string): { owner: string; repo: string } | undefined;
        }>(provider);
        const parseUrl = priv.parseGitHubUrl.bind(provider);

        expect(parseUrl('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
        expect(parseUrl('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
        expect(parseUrl('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
        expect(parseUrl('https://github.com/owner/my.repo.git')).toEqual({ owner: 'owner', repo: 'my.repo' });
        expect(parseUrl('https://github.com/owner/my.repo')).toEqual({ owner: 'owner', repo: 'my.repo' });
        // Trailing slash should not bleed into the repo name
        expect(parseUrl('https://github.com/owner/repo/')).toEqual({ owner: 'owner', repo: 'repo' });
        expect(parseUrl('invalid-url')).toBeUndefined();
    });

    test('detect cleans up old state first', async () => {
        // Set initial state
        setPrivate(provider, 'owner', 'old-owner');
        setPrivate(provider, 'repo', 'old-repo');

        const remotes = [{ name: 'origin', url: 'https://github.com/new-owner/new-repo.git' }];
        const result = await provider.detect('/root', remotes);

        expect(result).toBe(true);
        expect(accessPrivate(provider, 'owner')).toBe('new-owner');
        expect(accessPrivate(provider, 'repo')).toBe('new-repo');

        // Now run detect with invalid remote, it should clean up state
        const invalidRemotes = [{ name: 'origin', url: 'https://notgithub.com/some/repo.git' }];
        const result2 = await provider.detect('/root', invalidRemotes);

        expect(result2).toBe(false);
        expect(accessPrivate(provider, 'owner')).toBeUndefined();
        expect(accessPrivate(provider, 'repo')).toBeUndefined();
    });

    test('detect prioritizes upstream remote over origin', async () => {
        const remotes = [
            { name: 'origin', url: 'https://github.com/fork-owner/fork-repo.git' },
            { name: 'upstream', url: 'https://github.com/mainline-owner/mainline-repo.git' },
        ];
        const result = await provider.detect('/root', remotes);

        expect(result).toBe(true);
        expect(accessPrivate(provider, 'owner')).toBe('mainline-owner');
        expect(accessPrivate(provider, 'repo')).toBe('mainline-repo');
    });

    test('detect clears cache on owner/repo change, but preserves it if unchanged', async () => {
        const cache = accessPrivate<Map<string, unknown>>(provider, 'cache');
        cache.set('some-key', { status: 'NEW' });

        // Run detect with same repository
        setPrivate(provider, 'owner', 'my-owner');
        setPrivate(provider, 'repo', 'my-repo');
        const remotes = [{ name: 'origin', url: 'https://github.com/my-owner/my-repo.git' }];
        const result1 = await provider.detect('/root', remotes);

        expect(result1).toBe(true);
        expect(cache.has('some-key')).toBe(true); // preserved

        // Run detect with different repository
        const newRemotes = [{ name: 'origin', url: 'https://github.com/new-owner/new-repo.git' }];
        const result2 = await provider.detect('/root', newRemotes);

        expect(result2).toBe(true);
        expect(cache.has('some-key')).toBe(false); // cleared
    });

    test('parseGitHubPr calculates submittable correctly based on mergeable, reviewDecision, and statusCheckRollup', () => {
        interface MockGitHubPr {
            id: string;
            number: number;
            state: string;
            mergeable: string;
            reviewDecision?: string | null;
            url: string;
            commits?: {
                nodes?: {
                    commit?: {
                        oid: string;
                        message: string;
                        statusCheckRollup?: {
                            state: string;
                        } | null;
                    };
                }[];
            };
        }
        const priv = exposePrivate<{
            parseGitHubPr(pr: MockGitHubPr): { submittable: boolean } | undefined;
        }>(provider);
        const parsePr = priv.parseGitHubPr.bind(provider);

        // Scenario 1: Mergeable, approved, status checks success
        expect(
            parsePr({
                id: 'pr-1',
                number: 1,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                url: 'url-1',
                commits: {
                    nodes: [
                        {
                            commit: {
                                oid: 'sha-1',
                                message: 'msg',
                                statusCheckRollup: { state: 'SUCCESS' },
                            },
                        },
                    ],
                },
            })?.submittable,
        ).toBe(true);

        // Scenario 2: Mergeable, null review, null status checks
        expect(
            parsePr({
                id: 'pr-2',
                number: 2,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'url-2',
                commits: {
                    nodes: [
                        {
                            commit: {
                                oid: 'sha-2',
                                message: 'msg',
                            },
                        },
                    ],
                },
            })?.submittable,
        ).toBe(true);

        // Scenario 3: Conflicting, approved, status checks success
        expect(
            parsePr({
                id: 'pr-3',
                number: 3,
                state: 'OPEN',
                mergeable: 'CONFLICTING',
                reviewDecision: 'APPROVED',
                url: 'url-3',
                commits: {
                    nodes: [
                        {
                            commit: {
                                oid: 'sha-3',
                                message: 'msg',
                                statusCheckRollup: { state: 'SUCCESS' },
                            },
                        },
                    ],
                },
            })?.submittable,
        ).toBe(false);

        // Scenario 4: Mergeable, review required, status checks success
        expect(
            parsePr({
                id: 'pr-4',
                number: 4,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                reviewDecision: 'REVIEW_REQUIRED',
                url: 'url-4',
                commits: {
                    nodes: [
                        {
                            commit: {
                                oid: 'sha-4',
                                message: 'msg',
                                statusCheckRollup: { state: 'SUCCESS' },
                            },
                        },
                    ],
                },
            })?.submittable,
        ).toBe(false);

        // Scenario 5: Mergeable, approved, status checks failure
        expect(
            parsePr({
                id: 'pr-5',
                number: 5,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                url: 'url-5',
                commits: {
                    nodes: [
                        {
                            commit: {
                                oid: 'sha-5',
                                message: 'msg',
                                statusCheckRollup: { state: 'FAILURE' },
                            },
                        },
                    ],
                },
            })?.submittable,
        ).toBe(false);
    });

    test('fetchStatuses chunks requests using BATCH_SIZE of 20', async () => {
        setPrivate(provider, 'owner', 'my-owner');
        setPrivate(provider, 'repo', 'my-repo');

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
                        displayLabel: 'PR #1',
                        providerName: 'GitHub',
                        status: 'NEW',
                        submittable: true,
                        url: 'url',
                        currentRevision: 'sha',
                    });
                }
                return results;
            });

        const changes: ChangeStatusRequest[] = [];
        for (let i = 1; i <= 45; i++) {
            changes.push({
                commitId: `sha-${i}`,
                bookmarks: [`bm-${i}`],
            });
        }

        const testRepo = new TestRepo();

        testRepo.init();
        const jj = new JjService(testRepo.path, {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        });
        const result = await provider.fetchStatuses(changes, jj);
        expect(result).toBe(true);

        expect(fetchBatchSpy).toHaveBeenCalledTimes(3);
        expect(fetchBatchSpy.mock.calls[0][0].length).toBe(20);
        expect(fetchBatchSpy.mock.calls[1][0].length).toBe(20);
        expect(fetchBatchSpy.mock.calls[2][0].length).toBe(5);
    });

    test('fetchStatuses preserves cache on transient fetchBatchFromNetwork error', async () => {
        setPrivate(provider, 'owner', 'my-owner');
        setPrivate(provider, 'repo', 'my-repo');

        // Populate cache
        const cache = accessPrivate<Map<string, unknown>>(provider, 'cache');
        cache.set('bm-1', {
            id: 'id-1',
            number: 1,
            displayLabel: 'PR #1',
            providerName: 'GitHub',
            status: 'NEW',
            submittable: true,
            url: 'url',
            currentRevision: 'sha-1',
        });

        // Mock fetchBatchFromNetwork to throw
        vi.spyOn(
            exposePrivate<{
                fetchBatchFromNetwork(bookmarkNames: string[]): Promise<Map<string, unknown>>;
            }>(provider),
            'fetchBatchFromNetwork',
        ).mockRejectedValue(new Error('Transient network error'));

        const changes: ChangeStatusRequest[] = [
            {
                commitId: 'sha-1',
                bookmarks: ['bm-1'],
            },
        ];

        const testRepo = new TestRepo();

        testRepo.init();
        const jj = new JjService(testRepo.path, {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        });
        const result = await provider.fetchStatuses(changes, jj);
        expect(result).toBe(false); // No cache changes were registered

        // Verify cache was preserved (not deleted)
        expect(cache.get('bm-1')).toBeDefined();
        const cachedEntry = cache.get('bm-1') as { status: string } | undefined;
        expect(cachedEntry?.status).toBe('NEW');
    });

    test('getSessionToken delegates to authManager.getSessionToken', async () => {
        vi.mocked(mockAuthManager.getSessionToken).mockResolvedValue('delegated-token');
        const getSession = exposePrivate<{ getSessionToken(): Promise<string | undefined> }>(
            provider,
        ).getSessionToken.bind(provider);
        const token = await getSession();
        expect(token).toBe('delegated-token');
        expect(mockAuthManager.getSessionToken).toHaveBeenCalledWith('github', {
            scopes: ['repo'],
            envTokenKey: 'JJ_VIEW_GITHUB_TOKEN',
            secretTokenKey: 'github_token',
            promptMessage: 'GitHub authentication is required to fetch PR status.',
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            alternativeChoice: expect.any(Object),
        });
    });

    test('hasAuth returns true if environment variable JJ_VIEW_GITHUB_TOKEN is set', async () => {
        process.env.JJ_VIEW_GITHUB_TOKEN = 'test-token';
        const hasAuth = await provider.hasAuth();
        expect(hasAuth).toBe(true);
    });

    test('hasAuth returns true if stored token is found, false otherwise', async () => {
        delete process.env.JJ_VIEW_GITHUB_TOKEN;
        vi.mocked(mockAuthManager.secrets.get).mockResolvedValue('stored-pat');
        let hasAuth = await provider.hasAuth();
        expect(hasAuth).toBe(true);
        expect(mockAuthManager.secrets.get).toHaveBeenCalledWith('github_token');

        vi.mocked(mockAuthManager.secrets.get).mockResolvedValue(undefined);
        vi.mocked(mockAuthManager.hasOAuthSession).mockResolvedValue(true);
        hasAuth = await provider.hasAuth();
        expect(hasAuth).toBe(true);
        expect(mockAuthManager.hasOAuthSession).toHaveBeenCalledWith('github', ['repo']);

        vi.mocked(mockAuthManager.hasOAuthSession).mockResolvedValue(false);
        hasAuth = await provider.hasAuth();
        expect(hasAuth).toBe(false);
    });

    test('getAuthManageItems delegates to authManager.getAuthManageItems', async () => {
        const expectedItems = [{ label: 'test-item', execute: vi.fn() }] as AuthManageItem[];
        vi.mocked(mockAuthManager.getAuthManageItems).mockResolvedValue(expectedItems);

        const items = await provider.getAuthManageItems();
        expect(items).toBe(expectedItems);
        expect(mockAuthManager.getAuthManageItems).toHaveBeenCalledWith(
            'github',
            expect.objectContaining({
                displayName: 'GitHub',
                scopes: ['repo'],
                envTokenKey: 'JJ_VIEW_GITHUB_TOKEN',
                secretTokenKey: 'github_token',
                hasAuth: expect.any(Function),
                clearCache: expect.any(Function),
                promptForPat: expect.any(Function),
            }),
        );
    });

    test('promptForPat delegates to authManager.promptForPat', async () => {
        const expectedResult = { status: 'success', token: 'mock-token' } as const;
        vi.mocked(mockAuthManager.promptForPat).mockResolvedValue(expectedResult);

        const result = await provider.promptForPat();
        expect(result).toBe(expectedResult);
        expect(mockAuthManager.promptForPat).toHaveBeenCalledWith(
            expect.objectContaining({
                providerId: 'github',
                displayName: 'GitHub',
                secretTokenKey: 'github_token',
                prompt: "Enter your GitHub Personal Access Token (PAT). Requires 'repo' scope.",
                placeHolder: 'ghp_...',
                clearCache: expect.any(Function),
            }),
        );
    });

    test('fetchBatchFromNetwork handles parent repository for forks', async () => {
        setPrivate(provider, 'owner', 'fork-owner');
        setPrivate(provider, 'repo', 'fork-repo');

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                data: {
                    repository: {
                        parent: {
                            pr_0: {
                                nodes: [
                                    {
                                        id: 'parent-pr-id',
                                        number: 42,
                                        state: 'OPEN',
                                        mergeable: 'MERGEABLE',
                                        url: 'https://github.com/parent-owner/parent-repo/pull/42',
                                        commits: {
                                            nodes: [
                                                {
                                                    commit: {
                                                        oid: 'sha-parent',
                                                        message: 'msg',
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                ],
                            },
                        },
                        pr_0: {
                            nodes: [],
                        },
                    },
                },
            }),
        });
        global.fetch = fetchMock;

        const fetchBatch = exposePrivate<{
            fetchBatchFromNetwork(
                bookmarkNames: string[],
                bookmarkToCommitId: Map<string, string>,
            ): Promise<Map<string, CodeForgeChangeInfo>>;
        }>(provider).fetchBatchFromNetwork.bind(provider);

        const results = await fetchBatch(['my-feature-branch'], new Map([['my-feature-branch', 'sha-parent']]));
        expect(results.size).toBe(1);
        const pr = results.get('my-feature-branch');
        expect(pr).toBeDefined();
        expect(pr?.id).toBe('parent-pr-id');
        expect(pr?.number).toBe(42);
        expect(pr?.url).toBe('https://github.com/parent-owner/parent-repo/pull/42');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
        expect(requestBody.query).toContain('parent {');
    });

    test('fetchBatchFromNetwork prefers OPEN PR over CLOSED/ABANDONED PR on the same bookmark', async () => {
        setPrivate(provider, 'owner', 'my-owner');
        setPrivate(provider, 'repo', 'my-repo');
        const allowedOwners = accessPrivate<Set<string>>(provider, 'allowedOwners');
        allowedOwners.clear();
        allowedOwners.add('my-owner');

        const origFetch = global.fetch;
        try {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    data: {
                        repository: {
                            pr_0: {
                                nodes: [
                                    {
                                        id: 'pr-closed-id',
                                        number: 3,
                                        state: 'CLOSED',
                                        mergeable: 'UNKNOWN',
                                        url: 'https://github.com/my-owner/my-repo/pull/3',
                                        headRefName: 'push-feature',
                                        headRepository: {
                                            owner: { login: 'my-owner' },
                                        },
                                    },
                                    {
                                        id: 'pr-open-id',
                                        number: 4,
                                        state: 'OPEN',
                                        mergeable: 'MERGEABLE',
                                        url: 'https://github.com/my-owner/my-repo/pull/4',
                                        headRefName: 'push-feature',
                                        headRepository: {
                                            owner: { login: 'my-owner' },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                }),
            });
            global.fetch = fetchMock;

            const fetchBatch = exposePrivate<{
                fetchBatchFromNetwork(
                    bookmarkNames: string[],
                    bookmarkToCommitId: Map<string, string>,
                ): Promise<Map<string, CodeForgeChangeInfo>>;
            }>(provider).fetchBatchFromNetwork.bind(provider);

            const results = await fetchBatch(['push-feature'], new Map([['push-feature', 'sha-1']]));
            expect(results.size).toBe(1);
            const pr = results.get('push-feature');
            expect(pr).toBeDefined();
            expect(pr?.id).toBe('pr-open-id');
            expect(pr?.number).toBe(4);
            expect(pr?.status).toBe('NEW');
            expect(pr?.displayLabel).toBe('PR #4');

            const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
            expect(requestBody.query).toContain('orderBy: { field: CREATED_AT, direction: DESC }');
        } finally {
            global.fetch = origFetch;
        }
    });

    test('fetchStatuses matches closed/merged PRs even if local commit ID differs', async () => {
        setPrivate(provider, 'owner', 'my-owner');
        setPrivate(provider, 'repo', 'my-repo');
        const allowedOwners = accessPrivate<Set<string>>(provider, 'allowedOwners');
        allowedOwners.clear();
        allowedOwners.add('my-owner');

        vi.spyOn(
            exposePrivate<{
                fetchBatchFromNetwork(
                    bookmarkNames: string[],
                    bookmarkToCommitId: Map<string, string>,
                ): Promise<Map<string, CodeForgeChangeInfo>>;
            }>(provider),
            'fetchBatchFromNetwork',
        ).mockResolvedValue(
            new Map([
                [
                    'my-feature-merged',
                    {
                        id: 'pr-1',
                        number: 1,
                        displayLabel: 'PR #1',
                        providerName: 'GitHub',
                        status: 'MERGED',
                        submittable: true,
                        url: 'url-1',
                        unresolvedComments: 0,
                        currentRevision: 'sha-merged',
                    },
                ],
            ]),
        );

        const cache = accessPrivate<Map<string, CodeForgeChangeInfo>>(provider, 'cache');

        const changes: ChangeStatusRequest[] = [{ commitId: 'sha-local-differs', bookmarks: ['my-feature-merged'] }];
        const testRepo = new TestRepo();

        testRepo.init();
        const jj = new JjService(testRepo.path, {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        });
        await provider.fetchStatuses(changes, jj);

        // my-feature-merged SHOULD be cached even though local commit ID doesn't match
        expect(cache.get('my-feature-merged')).toBeDefined();
        expect(cache.get('my-feature-merged')?.contentSynced).toBe(false);
    });

    describe('Comments API', () => {
        let server: FakeGitHubServer;
        let originalApiUrl: string | undefined;

        beforeEach(async () => {
            server = new FakeGitHubServer();
            await server.start();
            originalApiUrl = process.env.JJ_VIEW_GITHUB_API_URL;
            process.env.JJ_VIEW_GITHUB_API_URL = server.url;
            setPrivate(provider, 'owner', 'test-owner');
            setPrivate(provider, 'repo', 'test-repo');
        });

        afterEach(async () => {
            await server.stop();
            process.env.JJ_VIEW_GITHUB_API_URL = originalApiUrl;
        });

        test('getCommentThreads fetches threads from GitHub', async () => {
            server.registerReviewThreads('pr_node_id_123', [
                {
                    id: 'thread-1',
                    isResolved: false,
                    path: 'file.txt',
                    line: 10,
                    comments: [
                        {
                            id: 'c-1',
                            body: 'Nice change!',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: { login: 'reviewer-user' },
                        },
                    ],
                },
            ]);

            const threads = await provider.getCommentThreads('pr_node_id_123');
            expect(threads).toHaveLength(1);
            expect(threads[0].id).toBe('thread-1');
            expect(threads[0].filePath).toBe('file.txt');
            expect(threads[0].line).toBe(10);
            expect(threads[0].isResolved).toBe(false);
            expect(threads[0].comments[0].body).toBe('Nice change!');
        });

        test('getCommentThreads handles threads with no comments', async () => {
            server.registerReviewThreads('pr_node_id_123', [
                {
                    id: 'thread-empty-comments',
                    isResolved: false,
                    path: 'file.txt',
                    line: 5,
                    comments: [],
                },
            ]);

            const threads = await provider.getCommentThreads('pr_node_id_123');

            expect(threads).toEqual([
                {
                    id: 'thread-empty-comments',
                    isResolved: false,
                    filePath: 'file.txt',
                    line: 5,
                    comments: [],
                },
            ]);
        });

        test('getCommentThreads defaults author name to "Unknown" when author/login is missing', async () => {
            const rawThreads: unknown = [
                {
                    id: 'thread-null-author',
                    isResolved: false,
                    path: 'file.txt',
                    line: 7,
                    comments: [
                        {
                            id: 'c-null-author',
                            body: 'Comment with null author',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: null,
                        },
                    ],
                },
                {
                    id: 'thread-missing-login',
                    isResolved: false,
                    path: 'file2.txt',
                    line: 8,
                    comments: [
                        {
                            id: 'c-missing-login',
                            body: 'Comment with missing login',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: {
                                login: undefined,
                            },
                        },
                    ],
                },
            ];
            server.registerReviewThreads(
                'pr_node_id_123',
                rawThreads as import('./helpers/fake-github-server').FakeReviewThread[],
            );

            const threads = await provider.getCommentThreads('pr_node_id_123');

            expect(threads).toEqual([
                {
                    id: 'thread-null-author',
                    isResolved: false,
                    filePath: 'file.txt',
                    line: 7,
                    comments: [
                        {
                            id: 'c-null-author',
                            body: 'Comment with null author',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: {
                                name: 'Unknown',
                                username: undefined,
                                avatarUrl: undefined,
                            },
                        },
                    ],
                },
                {
                    id: 'thread-missing-login',
                    isResolved: false,
                    filePath: 'file2.txt',
                    line: 8,
                    comments: [
                        {
                            id: 'c-missing-login',
                            body: 'Comment with missing login',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: {
                                name: 'Unknown',
                                username: undefined,
                                avatarUrl: undefined,
                            },
                        },
                    ],
                },
            ]);
        });

        test('getCommentThreads omits line when null and handles empty path', async () => {
            server.registerReviewThreads('pr_node_id_123', [
                {
                    id: 'thread-null-line',
                    isResolved: false,
                    path: 'file.txt',
                    line: null,
                    comments: [
                        {
                            id: 'c-null-line',
                            body: 'Comment with null line',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: {
                                login: 'reviewer2',
                            },
                        },
                    ],
                },
                {
                    id: 'thread-empty-path',
                    isResolved: true,
                    path: '',
                    line: 12,
                    comments: [
                        {
                            id: 'c-empty-path',
                            body: 'Comment with empty path',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: {
                                login: 'reviewer3',
                            },
                        },
                    ],
                },
            ]);

            const threads = await provider.getCommentThreads('pr_node_id_123');

            expect(threads).toEqual([
                {
                    id: 'thread-null-line',
                    isResolved: false,
                    filePath: 'file.txt',
                    line: undefined,
                    comments: [
                        {
                            id: 'c-null-line',
                            body: 'Comment with null line',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: {
                                name: 'reviewer2',
                                username: 'reviewer2',
                                avatarUrl: undefined,
                            },
                        },
                    ],
                },
                {
                    id: 'thread-empty-path',
                    isResolved: true,
                    filePath: '',
                    line: 12,
                    comments: [
                        {
                            id: 'c-empty-path',
                            body: 'Comment with empty path',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: {
                                name: 'reviewer3',
                                username: 'reviewer3',
                                avatarUrl: undefined,
                            },
                        },
                    ],
                },
            ]);
        });

        test('replyToCommentThread posts a reply', async () => {
            server.registerReviewThreads('pr_node_id_123', [
                {
                    id: 'thread-1',
                    isResolved: false,
                    path: 'file.txt',
                    line: 10,
                    comments: [
                        {
                            id: 'c-1',
                            body: 'Nice change!',
                            createdAt: '2026-06-30T12:00:00Z',
                            author: { login: 'reviewer-user' },
                        },
                    ],
                },
            ]);

            const thread = { id: 'thread-1', isResolved: false, comments: [] };
            const reply = await provider.replyToCommentThread('pr_node_id_123', thread, 'Thanks!');
            expect(reply.body).toBe('Thanks!');
            expect(reply.author.name).toBe('replier-login');
        });

        test('resolveCommentThread resolves/unresolves a thread', async () => {
            server.registerReviewThreads('pr_node_id_123', [
                {
                    id: 'thread-1',
                    isResolved: false,
                    path: 'file.txt',
                    line: 10,
                    comments: [],
                },
            ]);

            const thread = { id: 'thread-1', isResolved: false, comments: [] };
            await provider.resolveCommentThread('pr_node_id_123', thread, true);
            let threads = await provider.getCommentThreads('pr_node_id_123');
            expect(threads[0].isResolved).toBe(true);

            await provider.resolveCommentThread('pr_node_id_123', thread, false);
            threads = await provider.getCommentThreads('pr_node_id_123');
            expect(threads[0].isResolved).toBe(false);
        });
    });

    describe('syncStackedChanges', () => {
        let server: FakeGitHubServer;
        let originalApiUrl: string | undefined;

        beforeEach(async () => {
            server = new FakeGitHubServer();
            await server.start();
            originalApiUrl = process.env.JJ_VIEW_GITHUB_API_URL;
            process.env.JJ_VIEW_GITHUB_API_URL = server.url;
            setPrivate(provider, 'owner', 'test-owner');
            setPrivate(provider, 'repo', 'test-repo');
        });

        afterEach(async () => {
            await server.stop();
            process.env.JJ_VIEW_GITHUB_API_URL = originalApiUrl;
        });

        test('creates chained PRs when none exist', async () => {
            const stack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1\n\nBody 1', bookmark: 'bm-1' },
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2\n\nBody 2', bookmark: 'bm-2' },
                { commitId: 'c3', changeId: 'ch3', description: 'Commit 3\n\nBody 3', bookmark: 'bm-3' },
            ];

            const result = await provider.syncStackedChanges(stack);

            expect(result.created.length).toBe(3);
            expect(result.created[0]).toMatchObject({
                changeId: 'ch1',
                base: 'main',
                head: 'bm-1',
            });
            expect(result.created[1]).toMatchObject({
                changeId: 'ch2',
                base: 'bm-1',
                head: 'bm-2',
            });
            expect(result.created[2]).toMatchObject({
                changeId: 'ch3',
                base: 'bm-2',
                head: 'bm-3',
            });
            expect(result.retargeted.length).toBe(0);
            expect(result.unchanged.length).toBe(0);
            expect(server.createdPrs.length).toBe(3);
        });

        test('retargets PR base when intermediate commit is inserted or reordered', async () => {
            // Suppose bm-2 already had a PR targeting 'main'
            server.registerPR('bm-2', {
                id: 'pr_node_2',
                number: 102,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/102',
                baseRefName: 'main',
            });

            // Now the stack is: main <- bm-1 <- bm-2
            const stack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'bm-1' },
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2', bookmark: 'bm-2' },
            ];

            const result = await provider.syncStackedChanges(stack);

            expect(result.created.length).toBe(1);
            expect(result.created[0].head).toBe('bm-1');

            expect(result.retargeted.length).toBe(1);
            expect(result.retargeted[0]).toMatchObject({
                changeId: 'ch2',
                prNumber: 102,
                oldBase: 'main',
                newBase: 'bm-1',
            });
            expect(server.retargetedPrs.length).toBe(1);
            expect(server.retargetedPrs[0]).toEqual({
                pullRequestId: 'pr_node_2',
                baseRefName: 'bm-1',
            });
        });

        test('reports unchanged when PRs exist and have correct base', async () => {
            server.registerPR('bm-1', {
                id: 'pr_node_1',
                number: 101,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/101',
                baseRefName: 'main',
            });
            server.registerPR('bm-2', {
                id: 'pr_node_2',
                number: 102,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/102',
                baseRefName: 'bm-1',
            });

            const stack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'bm-1' },
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2', bookmark: 'bm-2' },
            ];

            const result = await provider.syncStackedChanges(stack);

            expect(result.created.length).toBe(0);
            expect(result.retargeted.length).toBe(0);
            expect(result.unchanged.length).toBe(2);
        });

        test('prepareStackedChanges retargets inverted PR to defaultBranch before push', async () => {
            // Suppose bm-a had PR 1 (base: main)
            server.registerPR('bm-a', {
                id: 'pr_node_1',
                number: 101,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/101',
                baseRefName: 'main',
            });
            // bm-b had PR 2 (base: bm-a)
            server.registerPR('bm-b', {
                id: 'pr_node_2',
                number: 102,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/102',
                baseRefName: 'bm-a',
            });

            // The stack has been reordered: bm-b is now before bm-a
            const reorderedStack: StackCommitNode[] = [
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2', bookmark: 'bm-b' },
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'bm-a' },
            ];

            await provider.prepareStackedChanges(reorderedStack);

            // PR 2 (bm-b) had base bm-a, which is now placed AFTER bm-b. It should be retargeted to 'main'.
            expect(server.retargetedPrs).toContainEqual({
                pullRequestId: 'pr_node_2',
                baseRefName: 'main',
            });
        });

        test('prepareStackedChanges ignores PRs whose base is not inverted', async () => {
            server.registerPR('bm-a', {
                id: 'pr_node_1',
                number: 101,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/101',
                baseRefName: 'main',
            });
            server.registerPR('bm-b', {
                id: 'pr_node_2',
                number: 102,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/102',
                baseRefName: 'bm-a',
            });

            // Normal topological order: bm-a is before bm-b
            const normalStack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'bm-a' },
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2', bookmark: 'bm-b' },
            ];

            await provider.prepareStackedChanges(normalStack);

            expect(server.retargetedPrs.length).toBe(0);
        });

        test('syncStackedChanges continues processing remaining commits even if one PR fails', async () => {
            // Stack with 2 commits, both unbookmarked previously, needing new PRs
            const stack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'fail-bm' },
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2', bookmark: 'success-bm' },
            ];

            // Simulate createPullRequest error for 'fail-bm'
            const origFetch = global.fetch;
            try {
                global.fetch = async (input, init) => {
                    const body = String(init?.body || '');
                    if (body.includes('createPullRequest') && body.includes('"headRefName":"fail-bm"')) {
                        return new Response(
                            JSON.stringify({
                                errors: [{ message: 'A pull request already exists for owner:fail-bm.' }],
                            }),
                            { status: 200, headers: { 'Content-Type': 'application/json' } },
                        );
                    }
                    return origFetch(input, init);
                };

                const result = await provider.syncStackedChanges(stack);

                // 'fail-bm' failed, but 'success-bm' was successfully created
                expect(result.created.length).toBe(1);
                expect(result.created[0].head).toBe('success-bm');
                // Native stack registration must be omitted if any PR failed
                expect(server.createdStacks).toHaveLength(0);
            } finally {
                global.fetch = origFetch;
            }
        });

        test('syncStackedChanges automatically registers native GitHub stack for multi-PR stacks', async () => {
            const stack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'bm-1' },
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2', bookmark: 'bm-2' },
            ];

            const result = await provider.syncStackedChanges(stack);

            expect(result.created.length).toBe(2);
            expect(server.createdStacks).toEqual([
                { pull_requests: [result.created[0].prNumber, result.created[1].prNumber] },
            ]);
        });

        test('syncStackedChanges gracefully skips native stack registration when API returns 404', async () => {
            server.stacksResponseStatus = 404;
            const stack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'bm-1' },
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2', bookmark: 'bm-2' },
            ];

            const result = await provider.syncStackedChanges(stack);

            expect(result.created.length).toBe(2);
            expect(server.createdStacks).toHaveLength(1);
        });

        test('syncStackedChanges appends new PR to existing native stack when 422 is returned', async () => {
            // Suppose PR 101 and 102 are already in stack #5 on GitHub
            server.stacks = [
                {
                    id: 5,
                    number: 5,
                    pull_requests: [{ number: 101 }, { number: 102 }],
                },
            ];
            server.stacksResponseStatus = 422;

            // Register existing PRs for bm-1 and bm-2
            server.registerPR('bm-1', {
                id: 'pr_node_101',
                number: 101,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/101',
                baseRefName: 'main',
            });
            server.registerPR('bm-2', {
                id: 'pr_node_102',
                number: 102,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/102',
                baseRefName: 'bm-1',
            });

            // Now we sync a stack with bm-1, bm-2, and new commit bm-3
            const stack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'bm-1' },
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2', bookmark: 'bm-2' },
                { commitId: 'c3', changeId: 'ch3', description: 'Commit 3', bookmark: 'bm-3' },
            ];

            const result = await provider.syncStackedChanges(stack);

            expect(result.created).toHaveLength(1);
            expect(result.created[0].head).toBe('bm-3');
            const newPrNumber = result.created[0].prNumber;

            // Verify that it looked up the stack and called POST /stacks/5/add with the new PR
            expect(server.addedToStacks).toEqual([
                {
                    stackNumber: 5,
                    pull_requests: [newPrNumber],
                },
            ]);
        });

        test('syncStackedChanges does not call add endpoint if all PRs already belong to existing stack on 422', async () => {
            server.stacks = [
                {
                    id: 5,
                    number: 5,
                    pull_requests: [{ number: 101 }, { number: 102 }],
                },
            ];
            server.stacksResponseStatus = 422;

            server.registerPR('bm-1', {
                id: 'pr_node_101',
                number: 101,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/101',
                baseRefName: 'main',
            });
            server.registerPR('bm-2', {
                id: 'pr_node_102',
                number: 102,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/owner/repo/pull/102',
                baseRefName: 'bm-1',
            });

            const stack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'bm-1' },
                { commitId: 'c2', changeId: 'ch2', description: 'Commit 2', bookmark: 'bm-2' },
            ];

            const result = await provider.syncStackedChanges(stack);

            expect(result.created).toHaveLength(0);
            expect(server.addedToStacks).toHaveLength(0);
        });

        test('single commit stack does not invoke native stack registration', async () => {
            const stack: StackCommitNode[] = [
                { commitId: 'c1', changeId: 'ch1', description: 'Commit 1', bookmark: 'bm-single' },
            ];

            const result = await provider.syncStackedChanges(stack);

            expect(result.created.length).toBe(1);
            expect(server.createdStacks).toHaveLength(0);
        });

        test('fetchStatuses with FakeGitHubServer prefers OPEN PR over older CLOSED PR on same bookmark', async () => {
            const allowedOwners = accessPrivate<Set<string>>(provider, 'allowedOwners');
            allowedOwners.clear();
            allowedOwners.add('test-owner');

            server.registerPR('feature-bm', {
                id: 'pr_node_3',
                number: 3,
                state: 'CLOSED',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/test-owner/test-repo/pull/3',
                headOwner: 'test-owner',
            });
            server.registerPR('feature-bm', {
                id: 'pr_node_4',
                number: 4,
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                url: 'https://github.com/test-owner/test-repo/pull/4',
                headOwner: 'test-owner',
            });

            const testRepo = new TestRepo();
            testRepo.init();
            try {
                const jj = new JjService(testRepo.path, {
                    info: () => {},
                    warn: () => {},
                    error: () => {},
                    debug: () => {},
                });

                const changed = await provider.fetchStatuses([{ commitId: 'c1', bookmarks: ['feature-bm'] }], jj);

                expect(changed).toBe(true);
                const cached = provider.getCachedChangeInfo(undefined, undefined, ['feature-bm']);
                expect(cached).toBeDefined();
                expect(cached?.number).toBe(4);
                expect(cached?.displayLabel).toBe('PR #4');
                expect(cached?.status).toBe('NEW');
            } finally {
                testRepo.dispose();
            }
        });
    });
});
