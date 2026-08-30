/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { CodeForgeRegistry } from '../core/code-forge-registry';
import type { CommentsManager } from '../core/comments-manager';
import type { HostStorage } from '../core/host/host-environment';
import type { JjRepository } from '../core/jj-repository';
import type { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import type { Api } from '../vscode/extension';
import type { VsCodeScmProvider } from '../vscode/providers/vscode-scm-provider';
import { VSCodeCommandContext } from '../vscode/vscode-command-context';
import { VsCodeHostEnvironment } from '../vscode/vscode-host-environment';
import { createMock } from './test-utils';

export interface TestRepositoryContext {
    codeForgeRegistry: CodeForgeRegistry;
    repository: JjRepository;
    repositoryManager: JjRepositoryManager;
    workspaceState: HostStorage;
    scmProvider: VsCodeScmProvider;
    dispose(): Promise<void>;
}

async function updateWorkspaceFoldersWithRetry(
    start: number,
    deleteCount: number | undefined | null,
    ...workspaceFoldersToAdd: { uri: Uri; name?: string }[]
): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        let eventDisposable: vscode.Disposable | undefined;
        const changePromise = new Promise<void>((resolve) => {
            eventDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
                resolve();
            });
        });

        const success = vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...workspaceFoldersToAdd);

        if (success) {
            await Promise.race([changePromise, new Promise((resolve) => setTimeout(resolve, 200))]);
            eventDisposable?.dispose();
            return true;
        } else {
            eventDisposable?.dispose();
        }
    }
    return false;
}

export async function createTestRepositoryContext(
    repoPath: string,
    outputChannel: vscode.LogOutputChannel,
): Promise<TestRepositoryContext> {
    void outputChannel;
    const originalFolders = vscode.workspace.workspaceFolders || [];
    const uri = Uri.file(repoPath);

    // Add repoPath as a workspace folder if not already present
    const isPresent = originalFolders.some((f) => f.uri.fsPath === uri.fsPath);
    if (!isPresent) {
        if ('onDidChangeWorkspaceFolders' in vscode.workspace) {
            const success = await updateWorkspaceFoldersWithRetry(originalFolders.length, 0, {
                uri,
                name: path.basename(repoPath),
            });
            if (!success) {
                throw new Error(`Failed to add workspace folder: ${repoPath}`);
            }
        } else if ('updateWorkspaceFolders' in vscode.workspace) {
            vscode.workspace.updateWorkspaceFolders(originalFolders.length, 0, {
                uri,
                name: path.basename(repoPath),
            });
        }
    }

    // Get the global extension API
    const extension = vscode.extensions.getExtension<Api>('jj-view.jj-view');
    if (!extension) {
        throw new Error('Extension jj-view.jj-view not found');
    }
    const api = await extension.activate();
    const repositoryManager = api.repositoryManager;

    // Wait for the repository to be registered by the global manager's scan
    const realRoot = await fs.realpath(repoPath);

    let repository = repositoryManager.getRepositoryForUri(Uri.file(realRoot));
    if (!repository) {
        await new Promise<void>((resolve, reject) => {
            const disposable = repositoryManager.onDidChangeRepositories(() => {
                repository = repositoryManager.getRepositoryForUri(Uri.file(realRoot));
                if (repository) {
                    disposable.dispose();
                    resolve();
                }
            });
            repositoryManager.scanForRepositories();
            setTimeout(() => {
                disposable.dispose();
                reject(new Error(`Timed out waiting for repository registration: ${realRoot}`));
            }, 10000);
        });
    }
    if (!repository) {
        throw new Error(`Repository not found at path: ${realRoot}`);
    }
    const finalRepo = repository;

    const scmProvider = api.scmProviders.get(finalRepo.rootUri.fsPath);
    if (!scmProvider) {
        throw new Error(`SCM provider not found for registered repository: ${finalRepo.rootUri.fsPath}`);
    }

    const testContext: TestRepositoryContext = {
        codeForgeRegistry: repositoryManager.codeForgeRegistry,
        repository: finalRepo,
        repositoryManager,
        workspaceState: repositoryManager.workspaceState,
        scmProvider,
        dispose: async () => {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await waitUntil(
                () => {
                    return vscode.window.tabGroups.all.every((group) => group.tabs.length === 0);
                },
                /*timeoutMs=*/ 2000,
                /*intervalMs=*/ 50,
            );
            const normalizedTarget = path.normalize(realRoot).toLowerCase();
            // Wait for the repository to be closed by the manager after removing the workspace folder
            const closePromise = new Promise<void>((resolve) => {
                const disposable = repositoryManager.onDidCloseRepository((r) => {
                    if (path.normalize(r.rootUri.fsPath).toLowerCase() === normalizedTarget) {
                        disposable.dispose();
                        resolve();
                    }
                });
                // Safety timeout
                setTimeout(() => {
                    disposable.dispose();
                    resolve();
                }, 10000);
            });

            if (!isPresent) {
                const currentFolders = vscode.workspace.workspaceFolders || [];
                const index = currentFolders.findIndex((f) => f.uri.fsPath === uri.fsPath);
                if (index !== -1) {
                    if ('onDidChangeWorkspaceFolders' in vscode.workspace) {
                        await updateWorkspaceFoldersWithRetry(index, 1);
                    } else if ('updateWorkspaceFolders' in vscode.workspace) {
                        vscode.workspace.updateWorkspaceFolders(index, 1);
                    }
                }
                await closePromise;
            }
        },
    };

    return testContext;
}

/**
 * Polls the given condition until it returns true or the timeout is reached.
 * Returns true if the condition was met, false if it timed out.
 */
export async function waitUntil(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 2000,
    intervalMs = 50,
): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        if (await condition()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return await condition();
}

/**
 * Stubs specific configuration keys on the vscode.workspace.getConfiguration API.
 * Delegates all other configuration queries to the original implementation.
 */
export function stubConfig(sandbox: sinon.SinonSandbox, configs: Record<string, unknown>): sinon.SinonStub {
    const original = vscode.workspace.getConfiguration;
    const configMock = createMock<vscode.WorkspaceConfiguration>({
        get: (key: string, defaultValue?: unknown) => {
            if (key in configs) {
                return configs[key];
            }
            const originalConfig = original('jj-view');
            return originalConfig.get(key, defaultValue);
        },
        has: (key: string) => {
            if (key in configs) {
                return true;
            }
            const originalConfig = original('jj-view');
            return originalConfig.has(key);
        },
        inspect: (key: string) => {
            const originalConfig = original('jj-view');
            return originalConfig.inspect(key);
        },
        update: (key: string, value: unknown, target?: vscode.ConfigurationTarget | boolean | null) => {
            const originalConfig = original('jj-view');
            return originalConfig.update(key, value, target);
        },
    });

    return sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?, scope?) => {
        if (section === 'jj-view') {
            return configMock;
        }
        return original(section, scope);
    });
}

/**
 * Stubs a specific VS Code command execution handler, automatically delegating all
 * other command executions to the original vscode.commands.executeCommand.
 */
export function stubCommand(
    sandbox: sinon.SinonSandbox,
    commandId: string,
    handler: (...args: unknown[]) => unknown,
): sinon.SinonStub {
    const original = vscode.commands.executeCommand;
    return sandbox
        .stub(vscode.commands, 'executeCommand')
        .callsFake(<T>(command: string, ...args: unknown[]): Thenable<T> => {
            if (command === commandId) {
                const result = handler(...args);
                return Promise.resolve(result as never);
            }
            return original(command, ...args);
        });
}

/**
 * Creates a valid VSCodeCommandContext with a VsCodeHostEnvironment for integration tests.
 */
export function createIntegrationCommandContext(
    scmProvider: VsCodeScmProvider,
    comments?: CommentsManager,
): VSCodeCommandContext {
    const context = createMock<vscode.ExtensionContext>({
        globalState: createMock<vscode.ExtensionContext['globalState']>({
            get: () => undefined,
            update: () => Promise.resolve(),
            setKeysForSync: () => {},
        }),
        secrets: createMock<vscode.SecretStorage>({
            get: () => Promise.resolve(undefined),
            store: () => Promise.resolve(),
            delete: () => Promise.resolve(),
        }),
    });
    const host = new VsCodeHostEnvironment({
        context,
    });
    return new VSCodeCommandContext(scmProvider.repo, host, scmProvider.outputChannel, comments);
}
