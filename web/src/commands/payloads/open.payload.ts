/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractUriFromArgs } from '../../../../src/core/commands/command-utils';
import type { OpenChangesPayload, OpenFilePayload } from '../../../../src/core/commands/open';
import type { JjResourceState } from '../../../../src/core/scm-resource-state';
import type { Uri } from '../../../../src/core/uri-utils';

export function createOpenFilePayload(args: unknown[]): OpenFilePayload {
    const resourceUri = extractUriFromArgs(args);
    return { resourceUri };
}

export function createOpenChangesPayload(args: unknown[]): OpenChangesPayload {
    const first = args[0];
    if (first && typeof first === 'object') {
        if ('resourceUri' in first) {
            return { resourceState: first as JjResourceState };
        }
        if ('scheme' in first && args[1] && typeof args[1] === 'object' && 'scheme' in args[1]) {
            const leftUri = first as Uri;
            const rightUri = args[1] as Uri;
            const diffTitle = typeof args[2] === 'string' ? args[2] : rightUri.fsPath;
            return {
                resourceState: {
                    resourceUri: rightUri,
                    leftUri,
                    rightUri,
                    diffTitle,
                    command: { command: 'vscode.diff', title: 'Open Changes' },
                    contextValue: '',
                    revision: '@',
                },
            };
        }
    }
    return {};
}
