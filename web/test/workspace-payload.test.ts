/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { extractWorkspaceName } from '../../src/core/commands/command-utils';
import {
    createWorkspaceDeletePayload,
    createWorkspaceForgetPayload,
    createWorkspaceOpenInCurrentWindowPayload,
    createWorkspaceOpenInNewWindowPayload,
} from '../src/commands/payloads/workspace.payload';

describe('workspace payload extraction', () => {
    const mergedWorkspaceContext = {
        webviewSection: 'workspace',
        workspaceName: 'pr-656',
        changeId: 'lokozmtrmvovywkyrupxqurmplzwtmxo',
        commitId: '0123456789abcdef',
        preventDefaultContextMenuItems: true,
    };

    it('extractWorkspaceName prefers workspaceName over name and never falls back to changeId', () => {
        expect(extractWorkspaceName([mergedWorkspaceContext])).toBe('pr-656');
        expect(extractWorkspaceName([{ name: 'legacy', changeId: 'lokozmtr' }])).toBe('legacy');
        expect(extractWorkspaceName(['  ws-1  '])).toBe('ws-1');
        expect(extractWorkspaceName([{ changeId: 'lokozmtrmvovywkyrupxqurmplzwtmxo' }])).toBeUndefined();
        expect(extractWorkspaceName([{ workspaceName: '   ', changeId: 'lokozmtr' }])).toBeUndefined();
        expect(extractWorkspaceName([])).toBeUndefined();
    });

    it('all web workspace payload creators extract workspaceName from merged WorkspacePill + CommitNode context', () => {
        expect(createWorkspaceDeletePayload([mergedWorkspaceContext])).toEqual({ workspaceName: 'pr-656' });
        expect(createWorkspaceForgetPayload([mergedWorkspaceContext])).toEqual({ workspaceName: 'pr-656' });
        expect(createWorkspaceOpenInCurrentWindowPayload([mergedWorkspaceContext])).toEqual({
            workspaceName: 'pr-656',
        });
        expect(createWorkspaceOpenInNewWindowPayload([mergedWorkspaceContext])).toEqual({ workspaceName: 'pr-656' });
    });

    it('all web workspace payload creators support legacy { name } and string args and ignore commit-only context', () => {
        for (const createPayload of [
            createWorkspaceDeletePayload,
            createWorkspaceForgetPayload,
            createWorkspaceOpenInCurrentWindowPayload,
            createWorkspaceOpenInNewWindowPayload,
        ]) {
            expect(createPayload([{ name: 'legacy-ws' }])).toEqual({ workspaceName: 'legacy-ws' });
            expect(createPayload(['ws-direct'])).toEqual({ workspaceName: 'ws-direct' });
            expect(createPayload([{ changeId: 'lokozmtrmvovywkyrupxqurmplzwtmxo' }])).toEqual({});
            expect(createPayload([])).toEqual({});
            expect(createPayload([{ workspaceName: '   ' }])).toEqual({});
        }
    });
});
