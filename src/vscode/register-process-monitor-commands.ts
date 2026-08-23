/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import type { JjProcessTracker } from '../jj-process-tracker';

export function registerProcessMonitorCommands(
    context: vscode.ExtensionContext,
    processTracker: JjProcessTracker,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.showProcessMonitor', async () => {
            await vscode.commands.executeCommand('jj-view.processMonitorView.focus');
        }),
        vscode.commands.registerCommand('jj-view.killProcess', (opId?: number) => {
            if (typeof opId === 'number') {
                processTracker.cancelProcess(opId);
            }
        }),
        vscode.commands.registerCommand('jj-view.killAllProcesses', () => {
            processTracker.cancelAllProcesses();
        }),
        vscode.commands.registerCommand('jj-view.clearProcessHistory', () => {
            processTracker.clearHistory();
        }),
    );
}
