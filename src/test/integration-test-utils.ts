/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeForgeRegistry } from '../code-forge-registry';
import type { JjRepository } from '../jj-repository';
import { JjRepositoryManager } from '../jj-repository-manager';
import { createMock } from './test-utils';

export interface TestRepositoryContext {
    codeForgeRegistry: CodeForgeRegistry;
    repository: JjRepository;
    repositoryManager: JjRepositoryManager;
    workspaceState: vscode.Memento;
}

async function updateWorkspaceFoldersWithRetry(
    start: number,
    deleteCount: number | undefined | null,
    ...workspaceFoldersToAdd: { uri: vscode.Uri; name?: string }[]
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
    outputChannel: vscode.OutputChannel,
): Promise<TestRepositoryContext> {
    const originalFolders = vscode.workspace.workspaceFolders || [];
    const uri = vscode.Uri.file(repoPath);

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

    const codeForgeRegistry = new CodeForgeRegistry();
    const store = new Map<string, unknown>();
    const workspaceState = createMock<vscode.Memento>({
        get: (key: string) => store.get(key),
        update: (key: string, value: unknown) => {
            store.set(key, value);
            return Promise.resolve();
        },
        keys: () => Array.from(store.keys()),
    });
    const repositoryManager = new JjRepositoryManager(codeForgeRegistry, outputChannel, workspaceState);
    const repository = await repositoryManager.maybeRegisterRepositoryContainingUri(
        vscode.Uri.file(path.join(repoPath, 'placeholder.txt')),
    );
    if (!repository) {
        throw new Error(`Failed to dynamically register repository at ${repoPath}`);
    }

    // Intercept dispose to remove the workspace folder and release locks
    const originalDispose = repositoryManager.dispose.bind(repositoryManager);
    repositoryManager.dispose = async () => {
        await originalDispose();
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
        }
    };

    return {
        codeForgeRegistry,
        repository,
        repositoryManager,
        workspaceState,
    };
}
