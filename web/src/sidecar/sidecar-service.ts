/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Disposable, type Event, EventEmitter } from '../../../src/core/host/events';
import type {
    AgentMessageResponse,
    ConversationMetadata,
    NewConversationResult,
    SidecarBridge,
    SidecarPaneMode,
} from './sidecar-types';

export class SidecarService implements Disposable {
    private _bridge: SidecarBridge | null = null;
    private readonly _onDidChangeWorkspace = new EventEmitter<string[]>();
    private _unsubscribeWorkspace: (() => void) | null = null;
    private _cachedMetadata: ConversationMetadata | null = null;

    public readonly onDidChangeWorkspace: Event<string[]> = this._onDidChangeWorkspace.event;

    constructor(bridge?: SidecarBridge) {
        if (bridge) {
            this._bridge = bridge;
        } else if (typeof window !== 'undefined' && window.sidecar) {
            this._bridge = window.sidecar;
        }

        if (this._bridge?.onWorkspaceChange) {
            this._unsubscribeWorkspace = this._bridge.onWorkspaceChange((uris) => {
                this._onDidChangeWorkspace.fire(uris);
            });
        }
    }

    private _getBridge(): SidecarBridge | null {
        if (this._bridge) {
            return this._bridge;
        }
        if (typeof window !== 'undefined' && window.sidecar) {
            this._bridge = window.sidecar;
            if (this._bridge?.onWorkspaceChange && !this._unsubscribeWorkspace) {
                this._unsubscribeWorkspace = this._bridge.onWorkspaceChange((uris) => {
                    this._onDidChangeWorkspace.fire(uris);
                });
            }
        }
        return this._bridge;
    }

    public get isAvailable(): boolean {
        return this._getBridge() !== null;
    }

    public async getWorkspaceUris(): Promise<string[]> {
        const bridge = this._getBridge();
        if (!bridge?.getWorkspaceUris) {
            return [];
        }
        return bridge.getWorkspaceUris();
    }

    public async getMetadata(conversationId?: string, forceRefresh = false): Promise<ConversationMetadata | null> {
        const bridge = this._getBridge();
        if (!bridge?.agent?.getConversationMetadata) {
            return null;
        }
        if (this._cachedMetadata && !conversationId && !forceRefresh) {
            return this._cachedMetadata;
        }
        const meta = await bridge.agent.getConversationMetadata(conversationId);
        if (!conversationId) {
            this._cachedMetadata = meta;
        }
        return meta;
    }

    public clearMetadataCache(): void {
        this._cachedMetadata = null;
    }

    public async sendMessage(message: string, convId?: string): Promise<AgentMessageResponse | null> {
        const bridge = this._getBridge();
        if (!bridge?.agent?.sendMessage) {
            return null;
        }
        return bridge.agent.sendMessage(message, convId);
    }

    public async startConversation(message: string, title?: string): Promise<NewConversationResult | null> {
        const bridge = this._getBridge();
        if (!bridge?.agent?.startConversation) {
            return null;
        }
        return bridge.agent.startConversation(message, title);
    }

    public toggleAuxPane(request?: { readonly mode?: SidecarPaneMode; readonly focus?: boolean } | unknown): void {
        this._getBridge()?.ui?.toggleAuxPane(request);
    }

    public toggleConversation(conversationId: string): void {
        this._getBridge()?.ui?.toggleConversation(conversationId);
    }

    public dispose(): void {
        if (this._unsubscribeWorkspace) {
            this._unsubscribeWorkspace();
            this._unsubscribeWorkspace = null;
        }
        this._onDidChangeWorkspace.dispose();
    }
}
