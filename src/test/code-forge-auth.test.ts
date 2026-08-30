/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import { type AuthResult, CodeForgeAuthManager } from '../core/code-forge-auth';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMockLogOutputChannel } from './test-utils';

describe('CodeForgeAuthManager', () => {
    let host: FakeHostEnvironment;
    let outputChannel: ReturnType<typeof createMockLogOutputChannel>;
    let authManager: CodeForgeAuthManager;

    beforeEach(() => {
        host = new FakeHostEnvironment();
        outputChannel = createMockLogOutputChannel({
            appendLine: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        });
        authManager = new CodeForgeAuthManager(host, outputChannel);
    });

    afterEach(() => {
        delete process.env.TEST_GITHUB_ENV_KEY;
        delete process.env.JJ_VIEW_TEST_TOKEN;
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
        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'TEST_GITHUB_ENV_KEY',
            promptMessage: 'test',
            prompt: false,
        });
        expect(token).toBe('env-token-123');
    });

    test('getSessionToken checks stored token in secrets', async () => {
        await host.secrets.store('gitlab_token', 'stored-secret-pat');
        const token = await authManager.getSessionToken('gitlab', {
            scopes: ['api'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            secretTokenKey: 'gitlab_token',
            promptMessage: 'test',
            prompt: false,
        });
        expect(token).toBe('stored-secret-pat');
    });

    test('getSessionToken returns undefined if auth is skipped', async () => {
        await authManager.setAuthSkipped('github', true);
        const getSessionSpy = vi.spyOn(host.auth, 'getSession');
        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'test',
            prompt: true,
        });
        expect(token).toBeUndefined();
        expect(getSessionSpy).not.toHaveBeenCalled();
    });

    test('getSessionToken silent mode success', async () => {
        host.auth.setSession('github', {
            id: '1',
            accessToken: 'silent-oauth-token',
            account: { id: 'user1', label: 'User 1' },
            scopes: ['repo'],
        });
        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'test',
            prompt: false,
        });
        expect(token).toBe('silent-oauth-token');
        expect(authManager.isProviderUnavailable('github')).toBe(false);
    });

    test('getSessionToken silent mode handles unregistered provider error and sets state', async () => {
        vi.spyOn(host.auth, 'getSession').mockRejectedValue(new Error('No authentication provider found'));
        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'test',
            prompt: false,
        });
        expect(token).toBeUndefined();
        expect(authManager.isProviderUnavailable('github')).toBe(true);
    });

    test('getSessionToken silent mode handles session check timed out error without permanently disabling provider', async () => {
        vi.spyOn(host.auth, 'getSession').mockRejectedValue(new Error('github session check timed out'));
        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'test',
            prompt: false,
        });
        expect(token).toBeUndefined();
        expect(authManager.isProviderUnavailable('github')).toBe(false);
    });

    test('hasOAuthSession handles session check timed out error without permanently disabling provider', async () => {
        vi.spyOn(host.auth, 'getSession').mockRejectedValue(new Error('github session check timed out'));
        const hasSession = await authManager.hasOAuthSession('github', ['repo']);
        expect(hasSession).toBe(false);
        expect(authManager.isProviderUnavailable('github')).toBe(false);
    });

    test('getSessionToken prompt mode warning flow choosing OAuth Sign In', async () => {
        const showWarningSpy = vi.spyOn(host.ui, 'showWarning').mockResolvedValue('Sign In');
        const getSessionSpy = vi
            .spyOn(host.auth, 'getSession')
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({
                id: '1',
                accessToken: 'oauth-token',
                account: { id: 'user1', label: 'User' },
                scopes: ['repo'],
            });

        const authEventPromise = new Promise<string>((resolve) => {
            authManager.onDidAuthenticate(resolve);
        });

        const token = await authManager.getSessionToken('github', {
            scopes: ['repo'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitHub authentication required',
            signInLabel: 'Sign In',
            prompt: true,
        });

        expect(token).toBeUndefined(); // detached prompt returns undefined immediately

        const providerId = await authEventPromise;
        expect(providerId).toBe('github');

        expect(showWarningSpy).toHaveBeenCalledWith(
            'GitHub authentication required',
            'Sign In',
            "Don't Sign In (Skip)",
        );
        expect(getSessionSpy).toHaveBeenNthCalledWith(1, 'github', ['repo'], { silent: true });
        expect(getSessionSpy).toHaveBeenNthCalledWith(2, 'github', ['repo'], { createIfNone: true });
    });

    test('getSessionToken prompt mode warning flow choosing alternative choice', async () => {
        vi.spyOn(host.ui, 'showWarning').mockResolvedValue('Enter PAT');
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

        expect(token).toBeUndefined();

        // Allow detached prompt flow microtask to run
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(alternativeExecute).toHaveBeenCalled();
    });

    test('promptForPat fires onDidAuthenticate exactly once', async () => {
        host.ui.setNextInputBoxResponse('pat-token-123');

        const authEvents: string[] = [];
        authManager.onDidAuthenticate((providerId) => {
            authEvents.push(providerId);
        });

        const result = await authManager.promptForPat({
            providerId: 'github',
            displayName: 'GitHub',
            secretTokenKey: 'github_token',
            prompt: 'Enter token',
            placeHolder: 'token...',
            clearCache: vi.fn(),
        });

        expect(result.status).toBe('success');
        expect(authEvents).toEqual(['github']);
        expect(await host.secrets.get('github_token')).toBe('pat-token-123');
    });

    test('getSessionToken prompt mode warning flow choosing Skip', async () => {
        vi.spyOn(host.ui, 'showWarning').mockResolvedValue("Don't Sign In (Skip)");

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

    test('getSessionToken prompt mode warning flow choosing OAuth Sign In with missing extension installer prompts to install extension', async () => {
        vi.spyOn(host.ui, 'showWarning').mockResolvedValue('Sign In (OAuth)');
        vi.spyOn(host.ui, 'showErrorMessage').mockResolvedValue('Install GitLab Extension');

        const token = await authManager.getSessionToken('gitlab', {
            scopes: ['api'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitLab authentication required',
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            extensionInstaller: {
                extensionId: 'gitlab.gitlab-workflow',
                extensionName: 'GitLab Workflow',
                providerName: 'GitLab',
            },
        });

        expect(token).toBeUndefined();

        // Allow detached prompt flow microtask to run
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(host.extensions?.searchedExtensions).toContain('gitlab.gitlab-workflow');
    });

    test('getSessionToken on host without extension support directly falls back to PAT', async () => {
        host.extensions = undefined;
        vi.spyOn(host.ui, 'showWarning').mockResolvedValue('Sign In (OAuth)');
        vi.spyOn(host.auth, 'getSession')
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('No authentication provider found'));
        const alternativeExecute = vi.fn().mockResolvedValue({ status: 'success', token: 'fallback-pat' });

        const token = await authManager.getSessionToken('gitlab', {
            scopes: ['api'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitLab authentication required',
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            extensionInstaller: {
                extensionId: 'gitlab.gitlab-workflow',
                extensionName: 'GitLab Workflow',
                providerName: 'GitLab',
            },
            alternativeChoice: {
                label: 'Enter PAT',
                execute: alternativeExecute,
            },
        });

        expect(token).toBeUndefined();

        // Allow detached prompt flow microtask to run
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(alternativeExecute).toHaveBeenCalled();
        expect(host.extensions).toBeUndefined();
    });

    test('getSessionToken on host without extensions and no alternativeChoice returns undefined', async () => {
        host.extensions = undefined;
        vi.spyOn(host.ui, 'showWarning').mockResolvedValue('Sign In (OAuth)');
        vi.spyOn(host.auth, 'getSession')
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('No authentication provider found'));

        const token = await authManager.getSessionToken('gitlab', {
            scopes: ['api'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitLab authentication required',
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            extensionInstaller: {
                extensionId: 'gitlab.gitlab-workflow',
                extensionName: 'GitLab Workflow',
                providerName: 'GitLab',
            },
        });

        expect(token).toBeUndefined();
    });

    test('getSessionToken prompt mode warning flow choosing OAuth Sign In with missing extension falls back to PAT', async () => {
        vi.spyOn(host.ui, 'showWarning').mockResolvedValue('Sign In (OAuth)');
        vi.spyOn(host.ui, 'showErrorMessage').mockResolvedValue('Enter PAT');
        const alternativeExecute = vi.fn().mockResolvedValue({ status: 'success', token: 'fallback-pat' });

        const token = await authManager.getSessionToken('gitlab', {
            scopes: ['api'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitLab authentication required',
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            extensionInstaller: {
                extensionId: 'gitlab.gitlab-workflow',
                extensionName: 'GitLab Workflow',
                providerName: 'GitLab',
            },
            alternativeChoice: {
                label: 'Enter PAT',
                execute: alternativeExecute,
            },
        });

        expect(token).toBeUndefined();

        // Allow detached prompt flow microtask to run
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(alternativeExecute).toHaveBeenCalled();
    });

    test('getSessionToken skip prompt check', async () => {
        vi.spyOn(host.auth, 'getSession').mockRejectedValue(new Error('No authentication provider found'));
        authManager.setProviderUnavailable('gitlab', true);

        const showWarningSpy = vi.spyOn(host.ui, 'showWarning');

        const token = await authManager.getSessionToken('gitlab', {
            scopes: ['api'],
            envTokenKey: 'NON_EXISTENT_ENV_KEY',
            promptMessage: 'GitLab authentication required',
            signInLabel: 'Sign In (OAuth)',
            prompt: true,
            shouldSkipPrompt: () => {
                const hasGitLabExtension = host.extensions?.hasExtension('gitlab.gitlab-workflow');
                return authManager.isProviderUnavailable('gitlab') && !hasGitLabExtension;
            },
        });

        expect(token).toBeUndefined();
        expect(showWarningSpy).not.toHaveBeenCalled();
    });

    test('handleAuthError cancelled sign-in silently returns undefined', async () => {
        const showErrorMessageSpy = vi.spyOn(host.ui, 'showErrorMessage');
        const result = await authManager.handleAuthError('github', new Error('User cancelled the sign-in flow'));
        expect(result).toBeUndefined();
        expect(showErrorMessageSpy).not.toHaveBeenCalled();
    });

    test('handleAuthError unregistered provider shows error message and installs extension', async () => {
        vi.spyOn(host.ui, 'showErrorMessage').mockResolvedValue('Install GitLab Extension');
        const result = await authManager.handleAuthError('gitlab', new Error('No authentication provider found'), {
            extensionInstaller: {
                extensionId: 'gitlab.gitlab-workflow',
                extensionName: 'GitLab Workflow',
                providerName: 'GitLab',
            },
        });
        expect(result).toBeUndefined();
        expect(host.extensions?.searchedExtensions).toContain('gitlab.gitlab-workflow');
    });

    test('handleAuthError unregistered provider with alternativeChoice execute option', async () => {
        vi.spyOn(host.ui, 'showErrorMessage').mockResolvedValue('Enter PAT');
        const alternativeExecute = vi.fn().mockResolvedValue({ status: 'success', token: 'test-pat' });
        const result = await authManager.handleAuthError('gitlab', new Error('No authentication provider found'), {
            extensionInstaller: {
                extensionId: 'gitlab.gitlab-workflow',
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
    });

    test('handleAuthError fallback generic error display', async () => {
        const showErrorMessageSpy = vi.spyOn(host.ui, 'showErrorMessage');
        const result = await authManager.handleAuthError('github', new Error('Some API error'));
        expect(result).toBeUndefined();
        expect(showErrorMessageSpy).toHaveBeenCalledWith('Authentication failed for github: Error: Some API error');
    });

    describe('performOAuthSignIn', () => {
        test('successful sign-in calls clearCache, shows information message, and fires onDidAuthenticate', async () => {
            host.extensions?.installedExtensions.add('gitlab.gitlab-workflow');
            host.auth.setSession('gitlab', {
                id: '1',
                accessToken: 'valid-token',
                account: { id: 'user1', label: 'User 1' },
                scopes: ['api'],
            });
            const showInfoSpy = vi.spyOn(host.ui, 'showInformation');
            const clearCache = vi.fn();
            const authEventPromise = new Promise<string>((resolve) => {
                authManager.onDidAuthenticate(resolve);
            });

            await authManager.performOAuthSignIn('gitlab', ['api'], {
                hasOAuth: false,
                clearCache,
                extensionInstaller: {
                    extensionId: 'gitlab.gitlab-workflow',
                    extensionName: 'GitLab Workflow',
                    providerName: 'GitLab',
                },
            });

            expect(clearCache).toHaveBeenCalled();
            expect(showInfoSpy).toHaveBeenCalledWith('Successfully authenticated with GitLab.');
            const providerId = await authEventPromise;
            expect(providerId).toBe('gitlab');
        });

        test('aborts and prompts to install when required extension is missing', async () => {
            vi.spyOn(host.ui, 'showErrorMessage').mockResolvedValue('Install GitLab Extension');
            const clearCache = vi.fn();

            await authManager.performOAuthSignIn('gitlab', ['api'], {
                hasOAuth: false,
                clearCache,
                extensionInstaller: {
                    extensionId: 'gitlab.gitlab-workflow',
                    extensionName: 'GitLab Workflow',
                    providerName: 'GitLab',
                },
            });

            expect(clearCache).not.toHaveBeenCalled();
            expect(host.extensions?.searchedExtensions).toContain('gitlab.gitlab-workflow');
        });

        test('performs OAuth sign-in directly when host does not support extensions', async () => {
            host.extensions = undefined;
            host.auth.setSession('gitlab', {
                id: '1',
                accessToken: 'valid-token',
                account: { id: 'user1', label: 'User 1' },
                scopes: ['api'],
            });
            const clearCache = vi.fn();
            const showInfoSpy = vi.spyOn(host.ui, 'showInformation');

            await authManager.performOAuthSignIn('gitlab', ['api'], {
                hasOAuth: false,
                clearCache,
                extensionInstaller: {
                    extensionId: 'gitlab.gitlab-workflow',
                    extensionName: 'GitLab Workflow',
                    providerName: 'GitLab',
                },
            });

            expect(clearCache).toHaveBeenCalled();
            expect(showInfoSpy).toHaveBeenCalledWith('Successfully authenticated with GitLab.');
        });

        test('delegates to handleAuthError when getSession throws an error', async () => {
            host.extensions?.installedExtensions.add('gitlab.gitlab-workflow');
            const getSessionSpy = vi.spyOn(host.auth, 'getSession').mockRejectedValue(new Error('Auth failed'));
            const clearCache = vi.fn();
            const handleAuthErrorSpy = vi.spyOn(authManager, 'handleAuthError').mockResolvedValue(undefined);

            await authManager.performOAuthSignIn('gitlab', ['api'], {
                hasOAuth: false,
                clearCache,
                extensionInstaller: {
                    extensionId: 'gitlab.gitlab-workflow',
                    extensionName: 'GitLab Workflow',
                    providerName: 'GitLab',
                },
            });

            expect(getSessionSpy).toHaveBeenCalled();
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
            await host.secrets.store('test_token', 'existing-pat');
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
            await host.secrets.store('test_token', 'existing-pat');
            const showInfoSpy = vi.spyOn(host.ui, 'showInformation');
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
            expect(await host.secrets.get('test_token')).toBeUndefined();
            expect(showInfoSpy).toHaveBeenCalledWith('Successfully cleared stored TestProvider Personal Access Token.');
            expect(clearCacheMock).toHaveBeenCalled();
        });
    });

    describe('promptForPat', () => {
        let clearCacheMock: Mock<() => void>;

        beforeEach(() => {
            clearCacheMock = vi.fn();
        });

        test('returns success and stores token when valid token is entered', async () => {
            host.ui.setNextInputBoxResponse('my-new-token');

            const authEventPromise = new Promise<string>((resolve) => {
                authManager.onDidAuthenticate(resolve);
            });

            const result = await authManager.promptForPat({
                providerId: 'test-provider',
                displayName: 'TestProvider',
                secretTokenKey: 'test_token',
                prompt: 'Enter token',
                placeHolder: 'token...',
                clearCache: clearCacheMock,
            });

            expect(result).toEqual({ status: 'success', token: 'my-new-token' });
            expect(await host.secrets.get('test_token')).toBe('my-new-token');
            expect(clearCacheMock).toHaveBeenCalled();
            expect(outputChannel.info).toHaveBeenCalledWith(
                '[TestProviderProvider] Personal Access Token saved successfully',
            );

            const providerId = await authEventPromise;
            expect(providerId).toBe('test-provider');
            expect(authManager.isProviderUnavailable('test-provider')).toBe(false);
        });

        test('returns cancelled and does not store if input is cancelled (undefined)', async () => {
            host.ui.setNextInputBoxResponse(undefined);

            const result = await authManager.promptForPat({
                providerId: 'test-provider',
                displayName: 'TestProvider',
                secretTokenKey: 'test_token',
                prompt: 'Enter token',
                placeHolder: 'token...',
                clearCache: clearCacheMock,
            });

            expect(result).toEqual({ status: 'cancelled' });
            expect(await host.secrets.get('test_token')).toBeUndefined();
            expect(clearCacheMock).not.toHaveBeenCalled();
        });

        test('returns cancelled and does not store if input is empty string', async () => {
            host.ui.setNextInputBoxResponse('   ');

            const result = await authManager.promptForPat({
                providerId: 'test-provider',
                displayName: 'TestProvider',
                secretTokenKey: 'test_token',
                prompt: 'Enter token',
                placeHolder: 'token...',
                clearCache: clearCacheMock,
            });

            expect(result).toEqual({ status: 'cancelled' });
            expect(await host.secrets.get('test_token')).toBeUndefined();
            expect(clearCacheMock).not.toHaveBeenCalled();
        });

        test('returns failure if secrets storage fails', async () => {
            host.ui.setNextInputBoxResponse('my-new-token');
            const error = new Error('Secret storage write error');
            vi.spyOn(host.secrets, 'store').mockRejectedValue(error);

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
            expect(outputChannel.info).toHaveBeenCalledWith(
                '[TestProviderProvider] Secrets storage is not available to save PAT: Error: Secret storage write error',
            );
        });
    });

    describe('dispose', () => {
        test('disposes event emitter', () => {
            expect(() => authManager.dispose()).not.toThrow();
        });
    });
});
