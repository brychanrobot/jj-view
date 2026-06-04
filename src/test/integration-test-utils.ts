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

export async function createTestRepositoryContext(
    repoPath: string,
    outputChannel: vscode.OutputChannel,
): Promise<TestRepositoryContext> {
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
    const repository = await repositoryManager.checkAndRegisterUri(
        vscode.Uri.file(path.join(repoPath, 'placeholder.txt')),
    );
    if (!repository) {
        throw new Error(`Failed to dynamically register repository at ${repoPath}`);
    }

    return {
        codeForgeRegistry,
        repository,
        repositoryManager,
        workspaceState,
    };
}
