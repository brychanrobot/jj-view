/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { extractWorkspaceName } from '../../core/commands/command-utils';
import type { WorkspaceDeletePayload } from '../../core/commands/workspace-delete';

export function createWorkspaceDeletePayload(args: unknown[]): WorkspaceDeletePayload {
    const workspaceName = extractWorkspaceName(args);
    return workspaceName !== undefined ? { workspaceName } : {};
}
