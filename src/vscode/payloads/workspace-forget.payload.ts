/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { extractWorkspaceName } from '../../core/commands/command-utils';
import type { WorkspaceForgetPayload } from '../../core/commands/workspace-forget';

export function createWorkspaceForgetPayload(args: unknown[]): WorkspaceForgetPayload {
    const workspaceName = extractWorkspaceName(args);
    return workspaceName !== undefined ? { workspaceName } : {};
}
