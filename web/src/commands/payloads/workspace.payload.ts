/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractWorkspaceName } from '../../../../src/core/commands/command-utils';
import type { WorkspaceDeletePayload } from '../../../../src/core/commands/workspace-delete';
import type { WorkspaceForgetPayload } from '../../../../src/core/commands/workspace-forget';
import type {
    WorkspaceOpenInCurrentWindowPayload,
    WorkspaceOpenInNewWindowPayload,
} from '../../../../src/core/commands/workspace-open';

function createWorkspaceNamePayload(args: unknown[]): { workspaceName?: string } {
    const workspaceName = extractWorkspaceName(args);
    return workspaceName !== undefined ? { workspaceName } : {};
}

export function createWorkspaceForgetPayload(args: unknown[]): WorkspaceForgetPayload {
    return createWorkspaceNamePayload(args);
}

export function createWorkspaceDeletePayload(args: unknown[]): WorkspaceDeletePayload {
    return createWorkspaceNamePayload(args);
}

export function createWorkspaceOpenInCurrentWindowPayload(args: unknown[]): WorkspaceOpenInCurrentWindowPayload {
    return createWorkspaceNamePayload(args);
}

export function createWorkspaceOpenInNewWindowPayload(args: unknown[]): WorkspaceOpenInNewWindowPayload {
    return createWorkspaceNamePayload(args);
}
