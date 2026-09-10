/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Temporary Vitest global setup for the host abstraction retrofit.
 *
 * This provides a global mock for 'vscode' so that host-agnostic tests can run in Node
 * without crashing on transitive imports into modules (such as ChangeDetectionManager,
 * GitColocation, and DiffTabCleaner) that are still in the process of being decoupled.
 *
 * Once all domain and manager modules are completely host-decoupled across the commit stack,
 * this temporary setup file can be removed.
 */
import { vi } from 'vitest';
import { createVscodeMock } from './vscode-mock';
import './vitest-utils';

import { recordCommandTrace } from './perf-trace';

vi.mock('vscode', () => createVscodeMock());

declare global {
    var __JJ_VIEW_COMMAND_HOOK__: ((command: string, args: string[], durationMs: number) => void) | undefined;
}

globalThis.__JJ_VIEW_COMMAND_HOOK__ = (command, args, durationMs) => {
    recordCommandTrace('JjService', [command, ...args], durationMs);
};
