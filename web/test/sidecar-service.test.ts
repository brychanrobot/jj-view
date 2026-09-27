/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test, vi } from 'vitest';
import { SidecarService } from '../src/sidecar/sidecar-service';
import type { SidecarAgentBridge, SidecarBridge } from '../src/sidecar/sidecar-types';
import { createMock } from './test-mock';

describe('SidecarService', () => {
    test('reports isAvailable as false when window.sidecar is not defined', () => {
        const service = new SidecarService();
        expect(service.isAvailable).toBe(false);
    });

    test('reports isAvailable as true when bridge is provided', () => {
        const bridge = createMock<SidecarBridge>({
            getWorkspaceUris: vi.fn().mockResolvedValue(['file:///home/user/project']),
        });
        const service = new SidecarService(bridge);
        expect(service.isAvailable).toBe(true);
    });

    test('getWorkspaceUris returns URIs from bridge', async () => {
        const bridge = createMock<SidecarBridge>({
            getWorkspaceUris: vi
                .fn()
                .mockResolvedValue(['file:///home/user/workspace1', 'file:///home/user/workspace2']),
        });
        const service = new SidecarService(bridge);
        const uris = await service.getWorkspaceUris();
        expect(uris).toEqual(['file:///home/user/workspace1', 'file:///home/user/workspace2']);
    });

    test('getWorkspaceUris returns empty array if bridge does not have getWorkspaceUris', async () => {
        const service = new SidecarService();
        const uris = await service.getWorkspaceUris();
        expect(uris).toEqual([]);
    });

    test('notifies onDidChangeWorkspace when bridge triggers onWorkspaceChange', async () => {
        let listener: ((uris: string[]) => void) | undefined;
        const bridge = createMock<SidecarBridge>({
            onWorkspaceChange: vi.fn().mockImplementation((fn: (uris: string[]) => void) => {
                listener = fn;
                return () => {};
            }),
        });

        const service = new SidecarService(bridge);
        const received: string[][] = [];
        service.onDidChangeWorkspace((uris) => {
            received.push(uris);
        });

        expect(listener).toBeDefined();
        listener?.(['file:///new/workspace']);

        expect(received).toEqual([['file:///new/workspace']]);
    });

    test('sendMessage delegates to bridge agent', async () => {
        const agent = createMock<SidecarAgentBridge>({
            sendMessage: vi.fn().mockResolvedValue({
                messageId: 'msg-1',
                response: 'Commit description generated.',
                status: 'delivered',
            }),
        });
        const bridge = createMock<SidecarBridge>({ agent });

        const service = new SidecarService(bridge);
        const res = await service.sendMessage('Draft message');
        expect(agent.sendMessage).toHaveBeenCalledWith('Draft message', undefined);
        expect(res).toEqual({
            messageId: 'msg-1',
            response: 'Commit description generated.',
            status: 'delivered',
        });
    });

    test('startConversation delegates to bridge agent', async () => {
        const agent = createMock<SidecarAgentBridge>({
            startConversation: vi.fn().mockResolvedValue({
                conversationId: 'conv-123',
            }),
        });
        const bridge = createMock<SidecarBridge>({ agent });

        const service = new SidecarService(bridge);
        const res = await service.startConversation('Explain commit', 'Commit Explanation');
        expect(agent.startConversation).toHaveBeenCalledWith('Explain commit', 'Commit Explanation');
        expect(res).toEqual({ conversationId: 'conv-123' });
    });

    test('getMetadata caches initial call without conversationId', async () => {
        const getMetaMock = vi.fn().mockResolvedValue({
            conversationId: 'conv-abc',
            title: 'Active Session',
        });
        const agent = createMock<SidecarAgentBridge>({
            getConversationMetadata: getMetaMock,
        });
        const bridge = createMock<SidecarBridge>({ agent });

        const service = new SidecarService(bridge);
        const meta1 = await service.getMetadata();
        const meta2 = await service.getMetadata();

        expect(meta1).toEqual({ conversationId: 'conv-abc', title: 'Active Session' });
        expect(meta2).toEqual({ conversationId: 'conv-abc', title: 'Active Session' });
        expect(getMetaMock).toHaveBeenCalledTimes(1);

        // forceRefresh bypasses cache
        const meta3 = await service.getMetadata(undefined, true);
        expect(meta3).toEqual({ conversationId: 'conv-abc', title: 'Active Session' });
        expect(getMetaMock).toHaveBeenCalledTimes(2);

        // clearMetadataCache resets cache
        service.clearMetadataCache();
        await service.getMetadata();
        expect(getMetaMock).toHaveBeenCalledTimes(3);
    });

    test('dynamically binds to window.sidecar if attached after instantiation', () => {
        const service = new SidecarService();
        expect(service.isAvailable).toBe(false);

        const bridge = createMock<SidecarBridge>({
            getWorkspaceUris: vi.fn().mockResolvedValue(['file:///delayed/workspace']),
        });
        (globalThis as { window?: { sidecar?: SidecarBridge } }).window = { sidecar: bridge };

        expect(service.isAvailable).toBe(true);

        delete (globalThis as { window?: { sidecar?: SidecarBridge } }).window;
    });

    test('dispose unsubscribes workspace listener and disposes event emitter', () => {
        const unsubscribeMock = vi.fn();
        const bridge = createMock<SidecarBridge>({
            onWorkspaceChange: vi.fn().mockReturnValue(unsubscribeMock),
        });

        const service = new SidecarService(bridge);
        service.dispose();

        expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    });
});
