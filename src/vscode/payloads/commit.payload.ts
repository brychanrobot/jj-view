/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommitPayload } from '../../commands/commit';
import type { CommitPromptPayload } from '../../commands/commit-prompt';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

export function createCommitPayload(_args: unknown[], scmProvider?: VsCodeScmProvider): CommitPayload {
    const description = scmProvider?.inputBoxValue.trim();
    return { description };
}

export function createCommitPromptPayload(_args: unknown[], scmProvider?: VsCodeScmProvider): CommitPromptPayload {
    const initialValue = scmProvider?.inputBoxValue;
    return { initialValue };
}
