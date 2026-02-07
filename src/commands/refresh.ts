/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { JjScmProvider } from '../jj-scm-provider';
import { getErrorMessage } from './command-utils';

export async function refreshCommand(scmProvider: JjScmProvider) {
    try {
        await scmProvider.refresh({ reason: 'manual refresh command', forceSnapshot: true });
    } catch (err: unknown) {
        vscode.window.showErrorMessage(`Error refreshing: ${getErrorMessage(err)}`);
    }
}
