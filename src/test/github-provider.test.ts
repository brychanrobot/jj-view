/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CodeForgeAuthManager } from '../code-forge-auth';
import type { AuthManageItem, ChangeStatusRequest } from '../code-forge-provider';
import { GitHubProvider } from '../github-provider';
import { accessPrivate, createMock, exposePrivate, setPrivate } from './test-utils';

// Mock VS Code
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: vi.fn(),
        }),
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
    let mockOutputChannel: vscode.OutputChannel;
    let mockAuthManager: CodeForgeAuthManager;

    beforeEach(() => {
        mockOutputChannel = createMock<vscode.OutputChannel>({ appendLine: vi.fn() });
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
            secrets: createMock<vscode.SecretStorage>({
                get: vi.fn(),
                store: vi.fn(),
                delete: vi.fn(),
            }),
        });
        provider = new GitHubProvider(mockAuthManager, mockOutputChannel);
        vi.mocked(vscode.window.showWarningMessage).mockReset();
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

        const result = await provider.fetchStatuses(changes);
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

        const result = await provider.fetchStatuses(changes);
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
        const originalEnv = process.env.JJ_VIEW_GITHUB_TOKEN;
        try {
            process.env.JJ_VIEW_GITHUB_TOKEN = 'test-token';
            const hasAuth = await provider.hasAuth();
            expect(hasAuth).toBe(true);
        } finally {
            process.env.JJ_VIEW_GITHUB_TOKEN = originalEnv;
        }
    });

    test('hasAuth returns true if stored token is found, false otherwise', async () => {
        const originalEnv = process.env.JJ_VIEW_GITHUB_TOKEN;
        delete process.env.JJ_VIEW_GITHUB_TOKEN;
        try {
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
        } finally {
            process.env.JJ_VIEW_GITHUB_TOKEN = originalEnv;
        }
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
});
