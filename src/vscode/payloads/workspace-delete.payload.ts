/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkspaceDeletePayload } from '../../commands/workspace-delete';

export function createWorkspaceDeletePayload(args: unknown[]): WorkspaceDeletePayload {
    const arg = args[0];
    if (typeof arg === 'string') {
        return { workspaceName: arg };
    }
    if (arg && typeof arg === 'object') {
        const obj = arg as Record<string, unknown>;
        if (typeof obj.workspaceName === 'string') {
            return { workspaceName: obj.workspaceName };
        }
        if (typeof obj.name === 'string') {
            return { workspaceName: obj.name };
        }
    }
    return {};
}
