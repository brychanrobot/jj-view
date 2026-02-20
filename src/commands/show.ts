/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjService } from '../jj-service';
import { showJjError } from './command-utils';

export async function showCurrentChangeCommand(jj: JjService, outputChannel: vscode.OutputChannel) {
    try {
        const [logEntry] = await jj.getLog({ revision: '@' });
        if (logEntry) {
            vscode.window.showInformationMessage(`Current Change ID: ${logEntry.change_id}`);
        } else {
            vscode.window.showErrorMessage('No log entry found for current revision.');
        }
    } catch (err: unknown) {
        showJjError(err, 'Error getting jj log', outputChannel);
    }
}
