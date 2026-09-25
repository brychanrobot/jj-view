/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommitPayload } from '../../../../src/core/commands/commit';
import type { CommitPromptPayload } from '../../../../src/core/commands/commit-prompt';
import type { ScmModel } from '../../../../src/core/scm-model';

export function createCommitPayload(args: unknown[], scmModel?: ScmModel): CommitPayload {
    let description: string | undefined;
    const first = args[0];
    if (typeof first === 'string') {
        description = first.trim();
    } else if (
        first &&
        typeof first === 'object' &&
        'description' in first &&
        typeof (first as { description: unknown }).description === 'string'
    ) {
        description = (first as { description: string }).description.trim();
    } else {
        description = scmModel?.snapshot?.description?.trim();
    }
    return { description };
}

export function createCommitPromptPayload(_args: unknown[], scmModel?: ScmModel): CommitPromptPayload {
    const initialValue = scmModel?.snapshot?.description;
    return { initialValue };
}
