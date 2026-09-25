/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractRevision } from '../../../../src/core/commands/command-utils';
import type { WorkspaceDeletePayload } from '../../../../src/core/commands/workspace-delete';
import type { WorkspaceForgetPayload } from '../../../../src/core/commands/workspace-forget';
import type {
    WorkspaceOpenInCurrentWindowPayload,
    WorkspaceOpenInNewWindowPayload,
} from '../../../../src/core/commands/workspace-open';

export function createWorkspaceForgetPayload(args: unknown[]): WorkspaceForgetPayload {
    const first = args[0] as { name?: string } | undefined;
    const workspaceName = typeof first?.name === 'string' ? first.name : extractRevision(args);
    return { workspaceName };
}

export function createWorkspaceDeletePayload(args: unknown[]): WorkspaceDeletePayload {
    const first = args[0] as { name?: string } | undefined;
    const workspaceName = typeof first?.name === 'string' ? first.name : extractRevision(args);
    return { workspaceName };
}

export function createWorkspaceOpenInCurrentWindowPayload(args: unknown[]): WorkspaceOpenInCurrentWindowPayload {
    const first = args[0] as { name?: string } | undefined;
    const workspaceName = typeof first?.name === 'string' ? first.name : extractRevision(args);
    return { workspaceName };
}

export function createWorkspaceOpenInNewWindowPayload(args: unknown[]): WorkspaceOpenInNewWindowPayload {
    const first = args[0] as { name?: string } | undefined;
    const workspaceName = typeof first?.name === 'string' ? first.name : extractRevision(args);
    return { workspaceName };
}
