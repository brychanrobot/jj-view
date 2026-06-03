/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type * as vscode from 'vscode';
import type { CodeForgeProvider } from './code-forge-provider';

export interface CodeForgeProviderFactory {
    readonly id: string;
    create(outputChannel?: vscode.OutputChannel): CodeForgeProvider;
}
