/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { JjDecoration, JjDecorationModel } from '../../jj-decoration-model';
import type { JjStatusEntry } from '../../jj-types';
import type { Uri } from '../../uri-utils';

/**
 * Thin VS Code FileDecorationProvider translating domain decorations to VS Code FileDecoration.
 */
export class VsCodeDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<Uri | Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<Uri | Uri[] | undefined> = this._onDidChangeFileDecorations.event;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _pendingPromises = new Map<string, Promise<vscode.FileDecoration | undefined>>();

    constructor(public readonly model: JjDecorationModel) {
        this._disposables.push(
            this.model.onDidChangeDecorations((e) => {
                this._onDidChangeFileDecorations.fire(e);
            }),
        );
    }

    provideFileDecoration(uri: Uri, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
        const key = uri.toString();
        const pending = this._pendingPromises.get(key);
        if (pending) {
            return pending;
        }

        const result = this.model.getDecoration(uri);
        if (!result) {
            return undefined;
        }
        if (result instanceof Promise) {
            const promise = result
                .then((dec) => {
                    this._pendingPromises.delete(key);
                    return this._mapToVsCodeDecoration(dec);
                })
                .catch((err: unknown) => {
                    this._pendingPromises.delete(key);
                    throw err;
                });
            this._pendingPromises.set(key, promise);
            return promise;
        }
        return this._mapToVsCodeDecoration(result);
    }

    private _mapToVsCodeDecoration(dec: JjDecoration | undefined): vscode.FileDecoration | undefined {
        if (!dec) {
            return undefined;
        }
        const fileDec = new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(dec.colorKey));
        if (dec.strikethrough) {
            fileDec.propagate = false;
        }
        return fileDec;
    }

    updateScmAndTrackedStatus(scmStatusDecorations: Map<string, JjStatusEntry>): void {
        this.model.updateScmAndTrackedStatus(scmStatusDecorations);
    }

    clearIgnoredFileDecorationsCache(): void {
        this._pendingPromises.clear();
        this.model.clearIgnoredFileDecorationsCache();
    }

    dispose(): void {
        this.model.dispose();
        this._onDidChangeFileDecorations.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
