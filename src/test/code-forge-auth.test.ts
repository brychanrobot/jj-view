/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import * as vscode from 'vscode';
import { type AuthResult, CodeForgeAuthManager } from '../code-forge-auth';
import { createMock } from './test-utils';

// Mock VS Code
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: vi.fn(),
        }),
    },
    window: {
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showInputBox: vi.fn(),
    },
    authentication: {
        getSession: vi.fn(),
    },
    extensions: {
        getExtension: vi.fn(),
    },
    commands: {
        executeCommand: vi.fn(),
    },
    Disposable: class {
        static from = vi.fn();
        dispose() {}
    },
}));

describe('CodeForgeAuthManager', () => {
    let context: vscode.ExtensionContext;
    let outputChannel: vscode.OutputChannel;
    let authManager: CodeForgeAuthManager;
    let globalStateMap: Map<string, unknown>;

    beforeEach(() => {
        globalStateMap = new Map<string, unknown>();
        context = createMock<vscode.ExtensionContext>({
            globalState: createMock<vscode.Memento & { setKeysForSync(keys: readonly string[]): void }>({
                get: vi.fn().mockImplementation((key: string, defaultValue: unknown) => {
                    return globalStateMap.has(key) ? globalStateMap.get(key) : defaultValue;
                }),
                update: vi.fn().mockImplementation(async (key: string, value: unknown) => {
                    globalStateMap.set(key, value);
                }),
                setKeysForSync: vi.fn(),
            }),
            secrets: createMock<vscode.SecretStorage>({
                get: vi.fn(),
                store: vi.fn(),
                delete: vi.fn(),
            }),
        });

        outputChannel = createMock<vscode.OutputChannel>({
            appendLine: vi.fn(),
        });

        authManager = new CodeForgeAuthManager(context, outputChannel);
        vi.mocked(vscode.window.showWarningMessage).mockReset();
        vi.mocked(vscode.authentication.getSession).mockReset();
        vi.mocked(vscode.extensions.getExtension).mockReset();
    });

    test('isAuthSkipped and setAuthSkipped persistent states', async () => {
        expect(authManager.isAuthSkipped('github')).toBe(false);
        await authManager.setAuthSkipped('github', true);
        expect(authManager.isAuthSkipped('github')).toBe(true);

        expect(authManager.isAuthSkipped('gitlab')).toBe(false);
        await authManager.setAuthSkipped('gitlab', true);
        expect(authManager.isAuthSkipped('gitlab')).toBe(true);
    });

    test('prompt session tracking and resetAllChoices', async () => {
        expect(authManager.hasPromptedThisSession('github')).toBe(false);
        authManager.markPromptedThisSession('github');
        expect(authManager.hasPromptedThisSession('github')).toBe(true);

        authManager.setProviderUnavailable('github', true);
        expect(authManager.isProviderUnavailable('github')).toBe(true);

        await authManager.resetAllChoices();
        expect(authManager.hasPromptedThisSession('github')).toBe(false);
        expect(authManager.isProviderUnavailable('github')).toBe(false);
        expect(authManager.isAuthSkipped('github')).toBe(false);
    });

    test('getSessionToken checks environment variables first', async () => {
        process.env.TEST_GITHUB_ENV_KEY = 'env-token-123';
        try {
            const token = await authManager.getSessionToken('github', {
                scopes: ['repo'],
                envTokenKey: 'TEST_GITHUB_ENV_KEY',
                promptMessage: 'test',
                prompt: false,
            });
            expect(token).toBe('env-token-123');
        } finally {
            delete process.env.TEST_GITHUB_ENV_KEY;
        }
    });

    test('getSessionToken checks stored token in secrets', async () => {
        vi.mocked(context.secrets.get).mockResolvedValue('stored-secret-pat');
        const token = await authManager.getSessionToken('gitlab', {
            scopes: ['api'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            secretTokenKey: 'gitlab_token',
            promptMessage: 'test',
            prompt: false,
        });
        expect(token).toBe('stored-secret-pat');
        expect(context.secrets.get).toHaveBeenCalledWith('gitlab_token');
    });

    test('getSessionToken returns undefined if auth is skipped', async () => {
        await authManager.setAuthSkipped('github', true);
        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'test',
            prompt: true,
        });
        expect(token).toBeUndefined();
        expect(vscode.authentication.getSession).not.toHaveBeenCalled();
    });

    test('getSessionToken silent mode success', async () => {
        vi.mocked(vscode.authentication.getSession).mockResolvedValue({ accessToken: 'silent-oauth-token' } as never);
        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'test',
            prompt: false,
        });
        expect(token).toBe('silent-oauth-token');
        expect(vscode.authentication.getSession).toHaveBeenCalledWith('github', ['repo'], { silent: true });
        expect(authManager.isProviderUnavailable('github')).toBe(false);
    });

    test('getSessionToken silent mode handles unregistered provider error and sets state', async () => {
        vi.mocked(vscode.authentication.getSession).mockRejectedValue(new Error('No authentication provider found'));
        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'test',
            prompt: false,
        });
        expect(token).toBeUndefined();
        expect(authManager.isProviderUnavailable('github')).toBe(true);
    });

    test('getSessionToken prompt mode warning flow choosing OAuth Sign In', async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Sign In' as never);
        vi.mocked(vscode.authentication.getSession)
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ accessToken: 'oauth-token' } as never);

        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitHub authentication required',
            signInLabel: 'Sign In',
            prompt: true,
        });

        expect(token).toBe('oauth-token');
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            'GitHub authentication required',
            'Sign In',
            "Don't Sign In (Skip)",
        );
        expect(vscode.authentication.getSession).toHaveBeenNthCalledWith(1, 'github', ['repo'], { silent: true });
        expect(vscode.authentication.getSession).toHaveBeenNthCalledWith(2, 'github', ['repo'], { createIfNone: true });
    });

    test('getSessionToken prompt mode warning flow choosing alternative choice', async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Enter PAT' as never);
        const alternativeExecute = vi.fn().mockResolvedValue({ status: 'success', token: 'custom-pat-token' });

        const token = await authManager.getSessionToken('gitlab', {
            scopes: ['api'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitLab authentication required',
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            alternativeChoice: {
                label: 'Enter PAT',
                execute: alternativeExecute,
            },
        });

        expect(token).toBe('custom-pat-token');
        expect(alternativeExecute).toHaveBeenCalled();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            'GitLab authentication required',
            'Sign In (OAuth)',
            'Enter PAT',
            "Don't Sign In (Skip)",
        );
    });

    test('getSessionToken prompt mode warning flow choosing Skip', async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Don't Sign In (Skip)" as never);

        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitHub authentication required',
            signInLabel: 'Sign In',
            prompt: true,
        });

        expect(token).toBeUndefined();
        expect(authManager.isAuthSkipped('github')).toBe(true);
    });

    test('getSessionToken skip prompt check', async () => {
        vi.mocked(vscode.authentication.getSession).mockRejectedValue(new Error('No authentication provider found'));
        authManager.setProviderUnavailable('gitlab', true);
        vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined); // GitLab workflow extension not installed

        const token = await authManager.getSessionToken('gitlab', {
            scopes: ['api'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitLab authentication required',
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            shouldSkipPrompt: () => {
                const hasGitLabExtension = !!vscode.extensions.getExtension('GitLab.gitlab-workflow');
                return authManager.isProviderUnavailable('gitlab') && !hasGitLabExtension;
            },
        });

        expect(token).toBeUndefined();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    test('handleAuthError cancelled sign-in silently returns undefined', async () => {
        const result = await authManager.handleAuthError('github', new Error('User cancelled the sign-in flow'));
        expect(result).toBeUndefined();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    test('handleAuthError unregistered provider shows error message and installs extension', async () => {
        vi.mocked(vscode.window.showErrorMessage).mockResolvedValue('Install GitLab Extension' as never);
        const result = await authManager.handleAuthError('gitlab', new Error('No authentication provider found'), {
            extensionInstaller: {
                extensionId: 'GitLab.gitlab-workflow',
                extensionName: 'GitLab Workflow',
                providerName: 'GitLab',
            },
        });
        expect(result).toBeUndefined();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            "GitLab authentication provider is not available. Please install the official 'GitLab Workflow' extension or configure a Personal Access Token (PAT).",
            'Install GitLab Extension',
        );
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.extensions.search',
            'GitLab.gitlab-workflow',
        );
    });

    test('handleAuthError unregistered provider with alternativeChoice execute option', async () => {
        vi.mocked(vscode.window.showErrorMessage).mockResolvedValue('Enter PAT' as never);
        const alternativeExecute = vi.fn().mockResolvedValue({ status: 'success', token: 'test-pat' });
        const result = await authManager.handleAuthError('gitlab', new Error('No authentication provider found'), {
            extensionInstaller: {
                extensionId: 'GitLab.gitlab-workflow',
                extensionName: 'GitLab Workflow',
                providerName: 'GitLab',
            },
            alternativeChoice: {
                label: 'Enter PAT',
                execute: alternativeExecute,
            },
        });
        expect(result).toBe('test-pat');
        expect(alternativeExecute).toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            "GitLab authentication provider is not available. Please install the official 'GitLab Workflow' extension or configure a Personal Access Token (PAT).",
            'Install GitLab Extension',
            'Enter PAT',
        );
    });

    test('handleAuthError fallback generic error display', async () => {
        const result = await authManager.handleAuthError('github', new Error('Some API error'));
        expect(result).toBeUndefined();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            'Authentication failed for github: Error: Some API error',
        );
    });

    describe('performOAuthSignIn', () => {
        test('successful sign-in calls clearCache and shows information message', async () => {
            vi.mocked(vscode.extensions.getExtension).mockReturnValue({} as never);
            vi.mocked(vscode.authentication.getSession).mockResolvedValue({ accessToken: 'valid-token' } as never);
            vi.mocked(vscode.window.showInformationMessage);
            const clearCache = vi.fn();

            await authManager.performOAuthSignIn('gitlab', ['api'], {
                hasOAuth: false,
                clearCache,
                extensionInstaller: {
                    extensionId: 'GitLab.gitlab-workflow',
                    extensionName: 'GitLab Workflow',
                    providerName: 'GitLab',
                },
            });

            expect(vscode.authentication.getSession).toHaveBeenCalledWith('gitlab', ['api'], {
                createIfNone: true,
                forceNewSession: undefined,
            });
            expect(clearCache).toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Successfully authenticated with GitLab.',
            );
        });

        test('aborts and calls handleAuthError when required extension is missing', async () => {
            vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined);
            const clearCache = vi.fn();
            const handleAuthErrorSpy = vi.spyOn(authManager, 'handleAuthError').mockResolvedValue(undefined);

            await authManager.performOAuthSignIn('gitlab', ['api'], {
                hasOAuth: false,
                clearCache,
                extensionInstaller: {
                    extensionId: 'GitLab.gitlab-workflow',
                    extensionName: 'GitLab Workflow',
                    providerName: 'GitLab',
                },
            });

            expect(vscode.extensions.getExtension).toHaveBeenCalledWith('GitLab.gitlab-workflow');
            expect(vscode.authentication.getSession).not.toHaveBeenCalled();
            expect(clearCache).not.toHaveBeenCalled();
            expect(handleAuthErrorSpy).toHaveBeenCalledWith(
                'gitlab',
                expect.any(Error),
                expect.objectContaining({
                    extensionInstaller: expect.any(Object),
                }),
            );
        });

        test('delegates to handleAuthError when getSession throws an error', async () => {
            vi.mocked(vscode.extensions.getExtension).mockReturnValue({} as never);
            vi.mocked(vscode.authentication.getSession).mockRejectedValue(new Error('Auth failed'));
            const clearCache = vi.fn();
            const handleAuthErrorSpy = vi.spyOn(authManager, 'handleAuthError').mockResolvedValue(undefined);

            await authManager.performOAuthSignIn('gitlab', ['api'], {
                hasOAuth: false,
                clearCache,
                extensionInstaller: {
                    extensionId: 'GitLab.gitlab-workflow',
                    extensionName: 'GitLab Workflow',
                    providerName: 'GitLab',
                },
            });

            expect(vscode.authentication.getSession).toHaveBeenCalled();
            expect(clearCache).not.toHaveBeenCalled();
            expect(handleAuthErrorSpy).toHaveBeenCalledWith(
                'gitlab',
                expect.any(Error),
                expect.objectContaining({
                    extensionInstaller: expect.any(Object),
                }),
            );
        });
    });

    describe('getAuthManageItems', () => {
        let hasAuthMock: Mock<() => Promise<boolean>>;
        let clearCacheMock: Mock<() => void>;
        let promptForPatMock: Mock<() => Promise<AuthResult>>;

        beforeEach(() => {
            hasAuthMock = vi.fn().mockResolvedValue(false);
            clearCacheMock = vi.fn();
            promptForPatMock = vi.fn().mockResolvedValue({ status: 'success', token: 'pat-token' });
            vi.mocked(context.secrets.get).mockResolvedValue(undefined);
            delete process.env.JJ_VIEW_TEST_TOKEN;
        });

        test('returns items for unauthenticated user (no PAT, no Env, no OAuth)', async () => {
            const items = await authManager.getAuthManageItems('test-provider', {
                displayName: 'TestProvider',
                scopes: ['test-scope'],
                envTokenKey: 'JJ_VIEW_TEST_TOKEN',
                secretTokenKey: 'test_token',
                hasAuth: hasAuthMock,
                clearCache: clearCacheMock,
                promptForPat: promptForPatMock,
            });

            expect(items.length).toBe(2);
            expect(items[0].label).toBe('$(sign-in) Sign In (OAuth)');
            expect(items[0].description).toBe('Authenticate with TestProvider using OAuth');
            expect(items[1].label).toBe('$(key) Enter Personal Access Token (PAT)');
            expect(items[1].description).toBe('Configure a personal access token for TestProvider');
        });

        test('returns items for OAuth authenticated user', async () => {
            hasAuthMock.mockResolvedValue(true);
            const items = await authManager.getAuthManageItems('test-provider', {
                displayName: 'TestProvider',
                scopes: ['test-scope'],
                envTokenKey: 'JJ_VIEW_TEST_TOKEN',
                secretTokenKey: 'test_token',
                hasAuth: hasAuthMock,
                clearCache: clearCacheMock,
                promptForPat: promptForPatMock,
            });

            expect(items.length).toBe(2);
            expect(items[0].label).toBe('$(sign-in) Sign In Again (OAuth)');
            expect(items[0].description).toBe('Authenticate again or switch TestProvider accounts');
        });

        test('returns items when PAT is configured', async () => {
            vi.mocked(context.secrets.get).mockResolvedValue('existing-pat');
            const items = await authManager.getAuthManageItems('test-provider', {
                displayName: 'TestProvider',
                scopes: ['test-scope'],
                envTokenKey: 'JJ_VIEW_TEST_TOKEN',
                secretTokenKey: 'test_token',
                hasAuth: hasAuthMock,
                clearCache: clearCacheMock,
                promptForPat: promptForPatMock,
            });

            expect(items.length).toBe(3);
            expect(items[0].label).toBe('$(sign-in) Sign In (OAuth)');
            expect(items[1].label).toBe('$(key) Update Personal Access Token (PAT)');
            expect(items[2].label).toBe('$(trash) Clear Personal Access Token (PAT)');
        });

        test('OAuth item execution triggers performOAuthSignIn', async () => {
            const performOAuthSignInSpy = vi.spyOn(authManager, 'performOAuthSignIn').mockResolvedValue(undefined);
            const items = await authManager.getAuthManageItems('test-provider', {
                displayName: 'TestProvider',
                scopes: ['test-scope'],
                envTokenKey: 'JJ_VIEW_TEST_TOKEN',
                secretTokenKey: 'test_token',
                hasAuth: hasAuthMock,
                clearCache: clearCacheMock,
                promptForPat: promptForPatMock,
            });

            await items[0].execute();
            expect(performOAuthSignInSpy).toHaveBeenCalledWith(
                'test-provider',
                ['test-scope'],
                expect.objectContaining({
                    hasOAuth: false,
                    clearCache: clearCacheMock,
                    alternativeChoice: expect.objectContaining({
                        label: 'Enter PAT',
                    }),
                }),
            );
        });

        test('PAT item execution triggers promptForPat', async () => {
            const items = await authManager.getAuthManageItems('test-provider', {
                displayName: 'TestProvider',
                scopes: ['test-scope'],
                envTokenKey: 'JJ_VIEW_TEST_TOKEN',
                secretTokenKey: 'test_token',
                hasAuth: hasAuthMock,
                clearCache: clearCacheMock,
                promptForPat: promptForPatMock,
            });

            await items[1].execute();
            expect(promptForPatMock).toHaveBeenCalled();
        });

        test('Clear PAT item execution deletes secret, shows info message and clears cache', async () => {
            vi.mocked(context.secrets.get).mockResolvedValue('existing-pat');
            const items = await authManager.getAuthManageItems('test-provider', {
                displayName: 'TestProvider',
                scopes: ['test-scope'],
                envTokenKey: 'JJ_VIEW_TEST_TOKEN',
                secretTokenKey: 'test_token',
                hasAuth: hasAuthMock,
                clearCache: clearCacheMock,
                promptForPat: promptForPatMock,
            });

            await items[2].execute();
            expect(context.secrets.delete).toHaveBeenCalledWith('test_token');
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Successfully cleared stored TestProvider Personal Access Token.',
            );
            expect(clearCacheMock).toHaveBeenCalled();
        });
    });

    describe('promptForPat', () => {
        let clearCacheMock: Mock<() => void>;

        beforeEach(() => {
            clearCacheMock = vi.fn();
            vi.mocked(vscode.window.showInputBox).mockReset();
            vi.mocked(context.secrets.store).mockReset();
        });

        test('returns success and stores token when valid token is entered', async () => {
            vi.mocked(vscode.window.showInputBox).mockResolvedValue('my-new-token');
            vi.mocked(context.secrets.store).mockResolvedValue(undefined);

            const result = await authManager.promptForPat({
                providerId: 'test-provider',
                displayName: 'TestProvider',
                secretTokenKey: 'test_token',
                prompt: 'Enter token',
                placeHolder: 'token...',
                clearCache: clearCacheMock,
            });

            expect(result).toEqual({ status: 'success', token: 'my-new-token' });
            expect(vscode.window.showInputBox).toHaveBeenCalledWith(
                expect.objectContaining({
                    prompt: 'Enter token',
                    placeHolder: 'token...',
                    password: true,
                    ignoreFocusOut: true,
                }),
            );
            expect(context.secrets.store).toHaveBeenCalledWith('test_token', 'my-new-token');
            expect(clearCacheMock).toHaveBeenCalled();
            expect(outputChannel.appendLine).toHaveBeenCalledWith(
                '[TestProviderProvider] Personal Access Token saved successfully',
            );
        });

        test('returns cancelled and does not store if input is cancelled (undefined)', async () => {
            vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

            const result = await authManager.promptForPat({
                providerId: 'test-provider',
                displayName: 'TestProvider',
                secretTokenKey: 'test_token',
                prompt: 'Enter token',
                placeHolder: 'token...',
                clearCache: clearCacheMock,
            });

            expect(result).toEqual({ status: 'cancelled' });
            expect(context.secrets.store).not.toHaveBeenCalled();
            expect(clearCacheMock).not.toHaveBeenCalled();
        });

        test('returns cancelled and does not store if input is empty string', async () => {
            vi.mocked(vscode.window.showInputBox).mockResolvedValue('   ');

            const result = await authManager.promptForPat({
                providerId: 'test-provider',
                displayName: 'TestProvider',
                secretTokenKey: 'test_token',
                prompt: 'Enter token',
                placeHolder: 'token...',
                clearCache: clearCacheMock,
            });

            expect(result).toEqual({ status: 'cancelled' });
            expect(context.secrets.store).not.toHaveBeenCalled();
            expect(clearCacheMock).not.toHaveBeenCalled();
        });

        test('returns failure if secrets storage fails', async () => {
            vi.mocked(vscode.window.showInputBox).mockResolvedValue('my-new-token');
            const error = new Error('Secret storage write error');
            vi.mocked(context.secrets.store).mockRejectedValue(error);

            const result = await authManager.promptForPat({
                providerId: 'test-provider',
                displayName: 'TestProvider',
                secretTokenKey: 'test_token',
                prompt: 'Enter token',
                placeHolder: 'token...',
                clearCache: clearCacheMock,
            });

            expect(result).toEqual({ status: 'failure', error });
            expect(clearCacheMock).not.toHaveBeenCalled();
            expect(outputChannel.appendLine).toHaveBeenCalledWith(
                '[TestProviderProvider] Secrets storage is not available to save PAT: Error: Secret storage write error',
            );
        });
    });
});
