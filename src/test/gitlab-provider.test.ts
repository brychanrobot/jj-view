/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CodeForgeAuthManager } from '../code-forge-auth';
import type { AuthManageItem, ChangeStatusRequest } from '../code-forge-provider';
import { GitLabProvider } from '../gitlab-provider';
import { accessPrivate, createMock, exposePrivate, setPrivate } from './test-utils';

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
    extensions: {
        getExtension: vi.fn(),
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
    let mockAuthManager: CodeForgeAuthManager;

    beforeEach(() => {
        mockOutputChannel = createMock<vscode.OutputChannel>({ appendLine: vi.fn() });
        mockAuthManager = createMock<CodeForgeAuthManager>({
            isAuthSkipped: vi.fn().mockReturnValue(false),
            hasPromptedThisSession: vi.fn().mockReturnValue(false),
            markPromptedThisSession: vi.fn(),
            setAuthSkipped: vi.fn(),
            isProviderUnavailable: vi.fn().mockReturnValue(false),
            setProviderUnavailable: vi.fn(),
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
        provider = new GitLabProvider(mockAuthManager, mockOutputChannel);
        vi.mocked(vscode.window.showWarningMessage).mockReset();
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

    test('getSessionToken delegates to authManager.getSessionToken', async () => {
        vi.mocked(mockAuthManager.getSessionToken).mockResolvedValue('delegated-gitlab-token');
        const getSession = exposePrivate<{ getSessionToken(prompt?: boolean): Promise<string | undefined> }>(
            provider,
        ).getSessionToken.bind(provider);

        // Test default call (silent)
        const tokenDefault = await getSession();
        expect(tokenDefault).toBe('delegated-gitlab-token');
        expect(mockAuthManager.getSessionToken).toHaveBeenLastCalledWith('gitlab', {
            scopes: ['api'],
            envTokenKey: 'JJ_VIEW_GITLAB_TOKEN',
            secretTokenKey: 'gitlab_token',
            promptMessage: expect.any(String),
            signInLabel: 'Sign In (OAuth)',
            prompt: false,
            alternativeChoice: expect.any(Object),
            shouldSkipPrompt: expect.any(Function),
            extensionInstaller: expect.any(Object),
        });

        // Test with prompting
        const tokenPrompt = await getSession(true);
        expect(tokenPrompt).toBe('delegated-gitlab-token');
        expect(mockAuthManager.getSessionToken).toHaveBeenLastCalledWith('gitlab', {
            scopes: ['api'],
            envTokenKey: 'JJ_VIEW_GITLAB_TOKEN',
            secretTokenKey: 'gitlab_token',
            promptMessage: expect.any(String),
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            alternativeChoice: expect.any(Object),
            shouldSkipPrompt: expect.any(Function),
            extensionInstaller: expect.any(Object),
        });
    });

    test('handle403Warning triggers warning on 403 Forbidden', () => {
        const response = createMock<Response>({
            status: 403,
            headers: createMock<Headers>({
                get: vi.fn().mockReturnValue(null),
            }),
        });

        exposePrivate<{ handle403Warning(r: Response): void }>(provider).handle403Warning(response);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('GitLab request failed (403 Forbidden)'),
        );
    });

    test('handle403Warning triggers warning with scopes if x-oauth-scopes present', () => {
        const response = createMock<Response>({
            status: 403,
            headers: createMock<Headers>({
                get: vi.fn().mockImplementation((name: string) => {
                    if (name === 'x-oauth-scopes') {
                        return 'read_user, read_repository';
                    }
                    return null;
                }),
            }),
        });

        exposePrivate<{ handle403Warning(r: Response): void }>(provider).handle403Warning(response);

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining(
                "The provided token has scopes [read_user, read_repository] but requires 'Merge Request' read/write permissions or 'api' scope",
            ),
        );
    });

    test('hasAuth returns true if environment variable JJ_VIEW_GITLAB_TOKEN is set', async () => {
        const originalEnv = process.env.JJ_VIEW_GITLAB_TOKEN;
        try {
            process.env.JJ_VIEW_GITLAB_TOKEN = 'test-token';
            const hasAuth = await provider.hasAuth();
            expect(hasAuth).toBe(true);
        } finally {
            process.env.JJ_VIEW_GITLAB_TOKEN = originalEnv;
        }
    });

    test('hasAuth returns true if stored token is found, false otherwise', async () => {
        const originalEnv = process.env.JJ_VIEW_GITLAB_TOKEN;
        delete process.env.JJ_VIEW_GITLAB_TOKEN;
        try {
            vi.mocked(mockAuthManager.secrets.get).mockResolvedValue('stored-pat');
            let hasAuth = await provider.hasAuth();
            expect(hasAuth).toBe(true);
            expect(mockAuthManager.secrets.get).toHaveBeenCalledWith('gitlab_token');

            vi.mocked(mockAuthManager.secrets.get).mockResolvedValue(undefined);
            vi.mocked(mockAuthManager.hasOAuthSession).mockResolvedValue(true);
            hasAuth = await provider.hasAuth();
            expect(hasAuth).toBe(true);
            expect(mockAuthManager.hasOAuthSession).toHaveBeenCalledWith('gitlab', ['api']);

            vi.mocked(mockAuthManager.hasOAuthSession).mockResolvedValue(false);
            hasAuth = await provider.hasAuth();
            expect(hasAuth).toBe(false);
        } finally {
            process.env.JJ_VIEW_GITLAB_TOKEN = originalEnv;
        }
    });

    test('getAuthManageItems delegates to authManager.getAuthManageItems', async () => {
        const expectedItems = [{ label: 'test-item', execute: vi.fn() }] as AuthManageItem[];
        vi.mocked(mockAuthManager.getAuthManageItems).mockResolvedValue(expectedItems);

        const items = await provider.getAuthManageItems();
        expect(items).toBe(expectedItems);
        expect(mockAuthManager.getAuthManageItems).toHaveBeenCalledWith(
            'gitlab',
            expect.objectContaining({
                displayName: 'GitLab',
                scopes: ['api'],
                envTokenKey: 'JJ_VIEW_GITLAB_TOKEN',
                secretTokenKey: 'gitlab_token',
                hasAuth: expect.any(Function),
                clearCache: expect.any(Function),
                promptForPat: expect.any(Function),
                extensionInstaller: expect.objectContaining({
                    extensionId: 'GitLab.gitlab-workflow',
                    extensionName: 'GitLab Workflow',
                    providerName: 'GitLab',
                }),
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
                providerId: 'gitlab',
                displayName: 'GitLab',
                secretTokenKey: 'gitlab_token',
                prompt: "Enter your GitLab Personal Access Token (PAT). Requires 'Merge Request' read/write permissions or 'api' scope.",
                placeHolder: 'glpat-...',
                clearCache: expect.any(Function),
            }),
        );
    });
});
