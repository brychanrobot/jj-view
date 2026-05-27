/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { AuthManageItem } from './code-forge-provider';

export type AuthToken = string;

export interface ExtensionInstaller {
    extensionId: string;
    extensionName: string;
    providerName: string;
}

export type AuthResult =
    | { status: 'success'; token: AuthToken }
    | { status: 'cancelled' }
    | { status: 'failure'; error: unknown };

export interface AlternativeChoice {
    label: string;
    /**
     * Executes the alternative choice action.
     * Should return an AuthResult indicating success, cancellation, or failure.
     */
    execute: () => Promise<AuthResult>;
}

export class CodeForgeAuthManager {
    private promptedThisSession = new Set<string>();
    private unavailableProviders = new Set<string>();
    private registeredProviderIds = new Set<string>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly outputChannel?: vscode.OutputChannel,
    ) {}

    public registerProvider(providerId: string): void {
        this.registeredProviderIds.add(providerId);
    }

    public get secrets(): vscode.SecretStorage {
        return this.context.secrets;
    }

    public isAuthSkipped(providerId: string): boolean {
        this.registerProvider(providerId);
        return this.context.globalState.get<boolean>(`jj-view.auth.skipped.${providerId}`, false);
    }

    public async setAuthSkipped(providerId: string, skipped: boolean): Promise<void> {
        this.registerProvider(providerId);
        await this.context.globalState.update(`jj-view.auth.skipped.${providerId}`, skipped);
        if (!skipped) {
            this.promptedThisSession.delete(providerId);
        }
        this.outputChannel?.appendLine(
            `[CodeForgeAuthManager] Auth skipped state for '${providerId}' set to: ${skipped}`,
        );
    }

    public hasPromptedThisSession(providerId: string): boolean {
        this.registerProvider(providerId);
        return this.promptedThisSession.has(providerId);
    }

    public markPromptedThisSession(providerId: string): void {
        this.registerProvider(providerId);
        this.promptedThisSession.add(providerId);
    }

    public isProviderUnavailable(providerId: string): boolean {
        this.registerProvider(providerId);
        return this.unavailableProviders.has(providerId);
    }

    public setProviderUnavailable(providerId: string, unavailable: boolean): void {
        this.registerProvider(providerId);
        if (unavailable) {
            this.unavailableProviders.add(providerId);
        } else {
            this.unavailableProviders.delete(providerId);
        }
    }

    public async resetAllChoices(): Promise<void> {
        this.promptedThisSession.clear();
        this.unavailableProviders.clear();
        const promises = Array.from(this.registeredProviderIds).map((id) => this.setAuthSkipped(id, false));
        await Promise.all(promises);
        this.outputChannel?.appendLine(`[CodeForgeAuthManager] Reset all authentication choices.`);
    }

    /**
     * Checks whether an active OAuth session exists for the given provider.
     * Uses a short timeout (500ms) so callers stay responsive (e.g., UI menus).
     * Also updates the `isProviderUnavailable` cache so subsequent calls are instant.
     */
    public async hasOAuthSession(providerId: string, scopes: string[]): Promise<boolean> {
        if (this.isProviderUnavailable(providerId)) {
            return false;
        }
        try {
            const session = await this.withTimeout(
                Promise.resolve(vscode.authentication.getSession(providerId, scopes, { silent: true })),
                500,
                `${providerId} session check timed out`,
            );
            if (session) {
                // Only clear the unavailable flag when we actually get a session back.
                // If getSession returns undefined it could mean "provider registered but
                // not signed in" OR "provider not registered" — we can't distinguish.
                this.setProviderUnavailable(providerId, false);
                return true;
            }
            return false;
        } catch (e) {
            const errorStr = String(e);
            // Treat both "not registered" errors AND timeouts as "provider unavailable".
            // A timeout means the provider extension is likely missing or not yet activated.
            const isUnregistered =
                errorStr.includes('not registered') ||
                errorStr.includes('No authentication provider') ||
                errorStr.includes('session check timed out');
            if (isUnregistered) {
                this.setProviderUnavailable(providerId, true);
            }
            return false;
        }
    }

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, rejectReason: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(rejectReason)), timeoutMs);
        });
        // Attach a no-op catch handler to prevent unhandled promise rejections if
        // the timeout triggers first and the caller's promise rejects in the background.
        promise.catch(() => {});
        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    public async getSessionToken(
        providerId: string,
        options: {
            scopes: string[];
            envTokenKey: string;
            secretTokenKey?: string;
            promptMessage: string;
            signInLabel?: string;
            prompt?: boolean;
            alternativeChoice?: AlternativeChoice;
            shouldSkipPrompt?: () => boolean;
            extensionInstaller?: ExtensionInstaller;
        },
    ): Promise<AuthToken | undefined> {
        this.registerProvider(providerId);

        // 1. Check environment variables
        if (process.env[options.envTokenKey]) {
            return process.env[options.envTokenKey];
        }

        // 2. Check stored token in secrets
        if (options.secretTokenKey) {
            try {
                const storedToken = await this.secrets.get(options.secretTokenKey);
                if (storedToken) {
                    return storedToken;
                }
            } catch (err) {
                this.outputChannel?.appendLine(
                    `[CodeForgeAuthManager] Failed to read token from secrets for '${providerId}': ${err}`,
                );
            }
        }

        // 3. Check if auth is skipped
        if (this.isAuthSkipped(providerId)) {
            return undefined;
        }

        const prompt = options.prompt ?? true;

        // Always try silently first to see if an active session exists
        try {
            const silentPromise = Promise.resolve(
                vscode.authentication.getSession(providerId, options.scopes, { silent: true }),
            );
            const session = await this.withTimeout(
                silentPromise,
                1000,
                `${providerId} authentication silent check timed out`,
            );
            this.setProviderUnavailable(providerId, false);
            if (session) {
                return session.accessToken;
            }
        } catch (e) {
            const errorStr = String(e);
            const isUnregistered =
                errorStr.includes('not registered') || errorStr.includes('No authentication provider');

            if (isUnregistered) {
                this.setProviderUnavailable(providerId, true);
                this.outputChannel?.appendLine(
                    `[CodeForgeAuthManager] ${providerId} authentication provider is not available in VS Code. Using unauthenticated requests only.`,
                );
                return undefined;
            } else {
                this.outputChannel?.appendLine(
                    `[CodeForgeAuthManager] Failed to get OAuth token silently for ${providerId}: ${errorStr}`,
                );
            }
        }

        if (!prompt) {
            return undefined;
        }

        // Check if provider-specific checks indicate we should skip the prompt
        if (options.shouldSkipPrompt?.()) {
            return undefined;
        }

        // Prompting flow
        if (this.hasPromptedThisSession(providerId)) {
            return undefined;
        }
        this.markPromptedThisSession(providerId);

        const signInLabel = options.signInLabel ?? 'Sign In';
        const skipLabel = "Don't Sign In (Skip)";
        const choices = [signInLabel];
        if (options.alternativeChoice) {
            choices.push(options.alternativeChoice.label);
        }
        choices.push(skipLabel);

        try {
            const choice = await vscode.window.showWarningMessage(options.promptMessage, ...choices);
            if (choice === signInLabel) {
                if (
                    options.extensionInstaller &&
                    !vscode.extensions.getExtension(options.extensionInstaller.extensionId)
                ) {
                    return this.promptInstallOrPat(options.extensionInstaller, options.alternativeChoice);
                }
                const session = await vscode.authentication.getSession(providerId, options.scopes, {
                    createIfNone: true,
                });
                return session?.accessToken;
            } else if (options.alternativeChoice && choice === options.alternativeChoice.label) {
                const result = await options.alternativeChoice.execute();
                return result.status === 'success' ? result.token : undefined;
            } else if (choice === skipLabel) {
                await this.setAuthSkipped(providerId, true);
            }
        } catch (e) {
            this.outputChannel?.appendLine(
                `[CodeForgeAuthManager] Failed to prompt or sign in for ${providerId}: ${e}`,
            );
            return (await this.handleAuthError(providerId, e, {
                extensionInstaller: options.extensionInstaller,
                alternativeChoice: options.alternativeChoice,
            })) as string | undefined;
        }

        return undefined;
    }

    /**
     * Helper to perform an OAuth sign in flow.
     * Checks if the required extension is installed (if extensionInstaller is provided).
     * Attempts to acquire the OAuth session.
     * On success, invokes the success callback (e.g. to clear cache).
     * On error, delegates to handleAuthError.
     */
    public async performOAuthSignIn(
        providerId: string,
        scopes: string[],
        options: {
            hasOAuth: boolean;
            clearCache: () => void;
            extensionInstaller?: ExtensionInstaller;
            alternativeChoice?: AlternativeChoice;
        },
    ): Promise<void> {
        if (options.extensionInstaller && !vscode.extensions.getExtension(options.extensionInstaller.extensionId)) {
            await this.promptInstallOrPat(options.extensionInstaller, options.alternativeChoice);
            return;
        }
        try {
            const session = await vscode.authentication.getSession(providerId, scopes, {
                createIfNone: true,
                forceNewSession: options.hasOAuth ? true : undefined,
            });
            if (session) {
                const providerName =
                    options.extensionInstaller?.providerName ||
                    providerId.charAt(0).toUpperCase() + providerId.slice(1);
                vscode.window.showInformationMessage(`Successfully authenticated with ${providerName}.`);
                options.clearCache();
            }
        } catch (e) {
            await this.handleAuthError(providerId, e, {
                extensionInstaller: options.extensionInstaller,
                alternativeChoice: options.alternativeChoice,
            });
        }
    }

    /**
     * Prompts the user to install the missing authentication provider extension or configure a PAT.
     */
    private async promptInstallOrPat(
        extensionInstaller: ExtensionInstaller,
        alternativeChoice?: AlternativeChoice,
    ): Promise<AuthToken | undefined> {
        const { providerName, extensionName, extensionId } = extensionInstaller;
        const installAction = `Install ${providerName} Extension`;
        const patAction = alternativeChoice ? alternativeChoice.label : 'Enter PAT';
        const choices = [installAction];
        if (alternativeChoice) {
            choices.push(patAction);
        }

        const message = alternativeChoice
            ? `${providerName} authentication provider is not available. Please install the official '${extensionName}' extension or configure a Personal Access Token (PAT).`
            : `${providerName} authentication provider is not available. Please install the official '${extensionName}' extension.`;

        const choice = await vscode.window.showErrorMessage(message, ...choices);
        if (choice === installAction) {
            vscode.commands.executeCommand('workbench.extensions.search', extensionId);
        } else if (alternativeChoice && choice === patAction) {
            const result = await alternativeChoice.execute();
            return result.status === 'success' ? result.token : undefined;
        }
        return undefined;
    }

    public async handleAuthError(
        providerId: string,
        error: unknown,
        options?: {
            extensionInstaller?: ExtensionInstaller;
            alternativeChoice?: AlternativeChoice;
        },
    ): Promise<AuthToken | undefined> {
        const errorStr = String(error);
        const isCancelled = errorStr.toLowerCase().includes('cancelled') || errorStr.toLowerCase().includes('canceled');
        if (isCancelled) {
            return undefined;
        }

        const isUnregistered =
            errorStr.includes('not registered') ||
            errorStr.includes('timed out waiting') ||
            errorStr.includes('No authentication provider');

        if (isUnregistered && options?.extensionInstaller) {
            return this.promptInstallOrPat(options.extensionInstaller, options.alternativeChoice);
        } else {
            vscode.window.showErrorMessage(`Authentication failed for ${providerId}: ${error}`);
        }
        return undefined;
    }

    /**
     * Generates custom authentication management items for a provider.
     * Consolidates condition checking, item mapping, and action executions for OAuth,
     * entering/updating PATs, and clearing PATs.
     */
    public async getAuthManageItems(
        providerId: string,
        options: {
            displayName: string;
            scopes: string[];
            envTokenKey: string;
            secretTokenKey: string;
            hasAuth: () => Promise<boolean>;
            clearCache: () => void;
            promptForPat: () => Promise<AuthResult>;
            extensionInstaller?: ExtensionInstaller;
        },
    ): Promise<AuthManageItem[]> {
        let hasPat = false;
        try {
            hasPat = !!(await this.secrets.get(options.secretTokenKey));
        } catch {}
        const hasEnv = !!process.env[options.envTokenKey];
        const hasOAuth = !hasPat && !hasEnv && (await options.hasAuth());
        const items: AuthManageItem[] = [];

        items.push({
            label: hasOAuth ? '$(sign-in) Sign In Again (OAuth)' : '$(sign-in) Sign In (OAuth)',
            description: hasOAuth
                ? `Authenticate again or switch ${options.displayName} accounts`
                : `Authenticate with ${options.displayName} using OAuth`,
            execute: async () => {
                await this.performOAuthSignIn(providerId, options.scopes, {
                    hasOAuth,
                    clearCache: options.clearCache,
                    extensionInstaller: options.extensionInstaller,
                    alternativeChoice: {
                        label: 'Enter PAT',
                        execute: options.promptForPat,
                    },
                });
            },
        });

        items.push({
            label: hasPat ? '$(key) Update Personal Access Token (PAT)' : '$(key) Enter Personal Access Token (PAT)',
            description: hasPat
                ? 'Update configured Personal Access Token'
                : `Configure a personal access token for ${options.displayName}`,
            execute: async () => {
                await options.promptForPat();
            },
        });

        if (hasPat) {
            items.push({
                label: '$(trash) Clear Personal Access Token (PAT)',
                description: 'Delete the configured Personal Access Token',
                execute: async () => {
                    try {
                        await this.secrets.delete(options.secretTokenKey);
                        vscode.window.showInformationMessage(
                            `Successfully cleared stored ${options.displayName} Personal Access Token.`,
                        );
                        options.clearCache();
                    } catch (e) {
                        vscode.window.showErrorMessage(
                            `Failed to clear ${options.displayName} Personal Access Token: ${e}`,
                        );
                    }
                },
            });
        }

        return items;
    }

    /**
     * Clears a stored PAT from SecretStorage when a 401 Unauthorized response is received,
     * provided the token in use matches the stored one. This prevents the extension from
     * repeatedly retrying with a known-invalid token. Tokens supplied via environment
     * variables are never deleted (the env var would take precedence on the next request).
     */
    public async clearInvalidToken(options: {
        providerId: string;
        secretTokenKey: string;
        currentToken: string;
        envTokenKey: string;
    }): Promise<void> {
        if (process.env[options.envTokenKey]) {
            // The token came from an env var — don't touch SecretStorage.
            return;
        }
        try {
            const storedToken = await this.secrets.get(options.secretTokenKey);
            if (storedToken === options.currentToken) {
                this.outputChannel?.appendLine(
                    `[CodeForgeAuthManager] Clearing invalid stored PAT for '${options.providerId}'...`,
                );
                await this.secrets.delete(options.secretTokenKey);
            }
        } catch (err) {
            this.outputChannel?.appendLine(
                `[CodeForgeAuthManager] Failed to delete token for '${options.providerId}': ${err}`,
            );
        }
    }

    /**
     * Prompts the user to enter a Personal Access Token (PAT), stores it in secrets storage,
     * logs success/failure, clears the provider's cache, and returns the result.
     */
    public async promptForPat(options: {
        providerId: string;
        displayName: string;
        secretTokenKey: string;
        prompt: string;
        placeHolder: string;
        clearCache: () => void;
    }): Promise<AuthResult> {
        const token = await vscode.window.showInputBox({
            prompt: options.prompt,
            placeHolder: options.placeHolder,
            password: true,
            ignoreFocusOut: true,
        });

        if (token === undefined || token.trim() === '') {
            return { status: 'cancelled' };
        }

        try {
            await this.secrets.store(options.secretTokenKey, token.trim());
            this.outputChannel?.appendLine(`[${options.displayName}Provider] Personal Access Token saved successfully`);
            options.clearCache();
            return { status: 'success', token: token.trim() };
        } catch (err) {
            this.outputChannel?.appendLine(
                `[${options.displayName}Provider] Secrets storage is not available to save PAT: ${err}`,
            );
            return { status: 'failure', error: err };
        }
    }
}
