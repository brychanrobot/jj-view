/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { extractWorkspaceName } from '../../core/commands/command-utils';
import type {
    WorkspaceOpenInCurrentWindowPayload,
    WorkspaceOpenInNewWindowPayload,
} from '../../core/commands/workspace-open';

export function createWorkspaceOpenInCurrentWindowPayload(args: unknown[]): WorkspaceOpenInCurrentWindowPayload {
    return extractWorkspacePayload(args);
}

export function createWorkspaceOpenInNewWindowPayload(args: unknown[]): WorkspaceOpenInNewWindowPayload {
    return extractWorkspacePayload(args);
}

function extractWorkspacePayload(args: unknown[]): { workspaceName?: string } {
    const workspaceName = extractWorkspaceName(args);
    return workspaceName !== undefined ? { workspaceName } : {};
}
