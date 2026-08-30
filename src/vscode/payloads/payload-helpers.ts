/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { extractFileUri, extractRevision } from '../../core/commands/command-utils';
import type { Uri } from '../../core/uri-utils';

export interface FileAndRevisionPayload {
    fileUri?: Uri;
    revision?: string;
}

import { isLineChangeArray, type LineChange } from '../../core/commands/command-utils';

export type { LineChange };
export { isLineChangeArray };

/**
 * Extracts a file URI (falling back to the active text editor document) and an optional revision.
 */
export function extractFileUriAndRevision(args: unknown[]): FileAndRevisionPayload {
    const fileUri = extractFileUri(args) ?? vscode.window.activeTextEditor?.document.uri;
    const revision = extractRevision(args);
    return { fileUri, revision };
}

/**
 * Extracts an active resource URI (falling back to the active text editor document).
 */
export function extractActiveResourceUri(args: unknown[]): { resourceUri?: Uri } {
    const resourceUri = extractFileUri(args) ?? vscode.window.activeTextEditor?.document.uri;
    return { resourceUri };
}
