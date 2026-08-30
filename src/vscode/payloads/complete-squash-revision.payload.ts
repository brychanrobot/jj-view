/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type CompleteSquashRevisionPayload, getSquashStorageDir } from '../../core/commands/squash-revision';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createCompleteSquashRevisionPayload(
    args: unknown[],
    scmProvider?: VsCodeScmProvider,
): CompleteSquashRevisionPayload {
    if (typeof args[0] === 'string') {
        return { message: args[0] };
    }

    if (scmProvider) {
        const storageDir = getSquashStorageDir(scmProvider.repo.rootUri.fsPath);
        const msgPath = path.join(storageDir, 'SQUASH_MSG');
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === msgPath);
        if (doc) {
            return { message: doc.getText() };
        }
    }

    return {};
}
