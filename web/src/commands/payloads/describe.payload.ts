/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevisions } from '../../../../src/core/commands/command-utils';
import type { SetDescriptionPayload } from '../../../../src/core/commands/describe';
import type { DescribePromptPayload } from '../../../../src/core/commands/describe-prompt';
import type { ScmModel } from '../../../../src/core/scm-model';

export function createSetDescriptionPayload(args: unknown[], scmModel?: ScmModel): SetDescriptionPayload {
    const first = args[0];
    let description: string | undefined;
    if (typeof first === 'string') {
        description = first;
    } else if (
        first &&
        typeof first === 'object' &&
        'description' in first &&
        typeof (first as { description: unknown }).description === 'string'
    ) {
        description = (first as { description: string }).description;
    }
    const revisionArgs = typeof first === 'string' ? args.slice(1) : args;
    const revision =
        (typeof first === 'string' && typeof args[1] === 'string' ? args[1] : undefined) ??
        extractRevisions(revisionArgs)[0] ??
        '@';

    if (description === undefined && revision === '@') {
        description = scmModel?.snapshot?.description;
    }

    return { description, revision };
}

export function createDescribePromptPayload(_args: unknown[], scmModel?: ScmModel): DescribePromptPayload {
    const initialValue = scmModel?.snapshot?.description;
    return { initialValue };
}
