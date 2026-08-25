/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommitPayload } from '../../commands/commit';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createCommitPayload(_args: unknown[], scmProvider?: VsCodeScmProvider): CommitPayload {
    const description = scmProvider?.sourceControl.inputBox.value.trim();
    return { description };
}
