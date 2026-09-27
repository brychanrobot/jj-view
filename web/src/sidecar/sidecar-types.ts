/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type SidecarPaneMode = 'auxiliary-pane' | 'full-pane' | 'editor-tab' | 'floating';
export type AgentExecutionStatus = 'idle' | 'busy' | 'streaming' | 'offline';
export type SidecarThemeKind = 'dark' | 'light' | 'high-contrast';

export interface SidecarWorkspaceInfo {
    readonly uri: string;
    readonly name: string;
    readonly rootPath: string;
}

export interface ConversationMetadata {
    readonly conversationId: string;
    readonly workspace?: SidecarWorkspaceInfo;
    readonly sidecarMode?: SidecarPaneMode;
    readonly theme?: SidecarThemeKind;
    readonly agentStatus?: AgentExecutionStatus;
}

export interface AgentContextAttachment {
    readonly type: 'file' | 'diff' | 'commit' | 'conflict' | 'range';
    readonly path?: string;
    readonly changeId?: string;
    readonly commitId?: string;
    readonly content?: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly metadata?: Record<string, string | number | boolean>;
}

export interface AgentMessagePayload {
    readonly text: string;
    readonly attachments?: readonly AgentContextAttachment[];
    readonly actionTag?: string;
}

export interface AgentMessageResponse {
    readonly messageId?: string;
    readonly conversationId?: string;
    readonly response?: string;
    readonly status: 'delivered' | 'queued' | 'rejected';
    readonly error?: string;
}

export interface NewConversationOptions {
    readonly title: string;
    readonly message: string;
    readonly attachments?: readonly AgentContextAttachment[];
    readonly projectId?: string;
}

export interface NewConversationResult {
    readonly conversationId: string;
    readonly status?: 'created' | 'active' | 'failed';
    readonly error?: string;
}

export interface SidecarAgentBridge {
    sendMessage(message: string, convId?: string): Promise<AgentMessageResponse>;
    startConversation(message: string, title?: string): Promise<NewConversationResult>;
    getConversationMetadata(conversationId?: string): Promise<ConversationMetadata>;
}

export interface SidecarUiBridge {
    toggleAuxPane(request?: { readonly mode?: SidecarPaneMode; readonly focus?: boolean } | unknown): void;
    toggleConversation(conversationId: string): void;
}

export interface SidecarBridge {
    readonly conversationId?: string;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    getWorkspaceUris(): Promise<string[]>;
    onWorkspaceChange(listener: (workspaceUris: string[]) => void): () => void;
    readonly agent?: SidecarAgentBridge;
    readonly ui?: SidecarUiBridge;
}

declare global {
    interface Window {
        sidecar?: SidecarBridge;
    }
}
