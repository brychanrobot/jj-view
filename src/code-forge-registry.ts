/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import type { CodeForgeProviderFactory } from './code-forge-provider-factory';

export class CodeForgeRegistry implements vscode.Disposable {
    private factories = new Map<string, CodeForgeProviderFactory>();
    private _onDidRegisterFactory = new vscode.EventEmitter<CodeForgeProviderFactory>();
    public readonly onDidRegisterFactory = this._onDidRegisterFactory.event;

    public register(factory: CodeForgeProviderFactory): vscode.Disposable {
        if (this.factories.has(factory.id)) {
            throw new Error(`Factory with id '${factory.id}' is already registered.`);
        }
        this.factories.set(factory.id, factory);
        this._onDidRegisterFactory.fire(factory);

        return new vscode.Disposable(() => {
            this.factories.delete(factory.id);
        });
    }

    public getFactories(): CodeForgeProviderFactory[] {
        return Array.from(this.factories.values());
    }

    public dispose() {
        this._onDidRegisterFactory.dispose();
    }
}
