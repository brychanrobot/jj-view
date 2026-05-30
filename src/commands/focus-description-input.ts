/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';

export async function focusDescriptionInputCommand() {
    await vscode.commands.executeCommand('workbench.view.scm');
    await vscode.commands.executeCommand('list.focusFirst');
    await vscode.commands.executeCommand('list.select');
}
