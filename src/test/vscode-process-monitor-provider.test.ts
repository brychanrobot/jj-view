/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, vi } from 'vitest';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import { JjProcessTracker } from '../core/jj-process-tracker';
import { Uri } from '../core/uri-utils';
import { VsCodeProcessMonitorProvider } from '../vscode/providers/vscode-process-monitor-provider';
import { createMock } from './test-utils';

describe('VsCodeProcessMonitorProvider Unit Tests', () => {
    test('instantiates and disposes cleanly', () => {
        const tracker = new JjProcessTracker();
        const context = createMock<import('vscode').ExtensionContext>({
            globalState: createMock<import('vscode').ExtensionContext['globalState']>({
                get: () => undefined,
                update: () => Promise.resolve(),
                setKeysForSync: () => {},
            }),
            secrets: createMock<import('vscode').SecretStorage>({
                get: () => Promise.resolve(undefined),
                store: () => Promise.resolve(),
                delete: () => Promise.resolve(),
            }),
        });
        const provider = new VsCodeProcessMonitorProvider(Uri.file('/mock/ext'), tracker, context);

        expect(provider).toBeDefined();
        provider.dispose();
    });
});
