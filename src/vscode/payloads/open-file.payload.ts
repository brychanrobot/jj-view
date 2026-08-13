/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { extractFileUri } from '../../commands/command-utils';
import type { OpenFilePayload } from '../../commands/open';

export function createOpenFilePayload(args: unknown[]): OpenFilePayload {
    const resourceUri = extractFileUri(args) ?? vscode.window.activeTextEditor?.document.uri;
    return { resourceUri };
}
