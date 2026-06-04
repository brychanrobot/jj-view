/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { CodeForgeProvider, GitRemote } from './code-forge-provider';

export class CodeForgeRegistry implements vscode.Disposable {
    private providers = new Map<string, CodeForgeProvider>();
    private activeProvider: CodeForgeProvider | undefined;
    private _onDidActiveProviderChange = new vscode.EventEmitter<CodeForgeProvider | undefined>();
    public readonly onDidActiveProviderChange = this._onDidActiveProviderChange.event;

    private _onDidProvidersChange = new vscode.EventEmitter<void>();
    public readonly onDidProvidersChange = this._onDidProvidersChange.event;

    public register(provider: CodeForgeProvider): vscode.Disposable {
        if (this.providers.has(provider.id)) {
            throw new Error(`Provider with id '${provider.id}' is already registered.`);
        }
        this.providers.set(provider.id, provider);
        this._onDidProvidersChange.fire();

        return new vscode.Disposable(() => {
            if (this.activeProvider?.id === provider.id) {
                this.activeProvider.deactivate();
                this.activeProvider = undefined;
                this._onDidActiveProviderChange.fire(undefined);
            }
            this.providers.delete(provider.id);
            this._onDidProvidersChange.fire();
        });
    }

    public async autoDetect(workspaceRoot: string, remotes: GitRemote[]): Promise<void> {
        const preferredId = vscode.workspace.getConfiguration('jj-view').get<string>('codeForge.provider');
        if (preferredId) {
            const provider = this.providers.get(preferredId);
            if (provider) {
                if (await provider.detect(workspaceRoot, remotes)) {
                    this.setActive(provider);
                } else {
                    this.setActive(undefined);
                }
                return;
            }
        }

        // Otherwise auto-detect
        for (const provider of this.providers.values()) {
            if (await provider.detect(workspaceRoot, remotes)) {
                this.setActive(provider);
                return;
            }
        }
        this.setActive(undefined);
    }

    private setActive(provider: CodeForgeProvider | undefined) {
        if (this.activeProvider?.id === provider?.id) {
            return;
        }
        this.activeProvider?.deactivate();
        this.activeProvider = provider;
        this.activeProvider?.activate();
        this._onDidActiveProviderChange.fire(provider);
    }

    public getActive(): CodeForgeProvider | undefined {
        return this.activeProvider;
    }

    public getProvider(id: string): CodeForgeProvider | undefined {
        return this.providers.get(id);
    }

    public getRegisteredProviders(): CodeForgeProvider[] {
        return Array.from(this.providers.values());
    }

    public dispose() {
        this._onDidActiveProviderChange.dispose();
        this._onDidProvidersChange.dispose();
    }
}
