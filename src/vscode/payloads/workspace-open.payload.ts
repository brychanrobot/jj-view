/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
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
