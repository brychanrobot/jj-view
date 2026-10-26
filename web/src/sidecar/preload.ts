/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
    AgentMessageResponse,
    ConversationMetadata,
    NewConversationResult,
    SidecarAgentBridge,
    SidecarBridge,
    SidecarPaneMode,
    SidecarUiBridge,
} from './sidecar-types';

let currentWorkspaceUris: string[] = [];
let hasInitialWorkspace = false;
const workspaceListeners = new Set<(workspaceUris: string[]) => void>();

let resolveInitialWorkspace: () => void = () => {};
const initialWorkspacePromise = new Promise<void>((resolve) => {
    resolveInitialWorkspace = resolve;
});

function areUriArraysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function notifyWorkspaceListener(listener: (workspaceUris: string[]) => void): void {
    try {
        listener([...currentWorkspaceUris]);
    } catch (err) {
        console.error('workspace-change listener failed:', err);
    }
}

function handleHostMessage(event: MessageEvent): void {
    if (window.parent !== window) {
        if (event.source !== window.parent) {
            return;
        }
    } else if (event.source !== window && event.source !== null) {
        return;
    }

    if (event.data?.type === 'theme-change') {
        const vars = (event.data.payload?.cssVariables as Record<string, string> | undefined) ?? {};
        for (const [key, value] of Object.entries(vars)) {
            document.documentElement.style.setProperty(key, value);
        }
        return;
    }

    if (event.data?.type === 'workspace-change') {
        const payload = event.data.payload as { readonly workspaceUris?: readonly string[] } | undefined;
        const nextWorkspaceUris = Array.isArray(payload?.workspaceUris) ? [...payload.workspaceUris] : [];
        const isFirstPush = !hasInitialWorkspace;
        const hasChanged = isFirstPush || !areUriArraysEqual(currentWorkspaceUris, nextWorkspaceUris);

        currentWorkspaceUris = nextWorkspaceUris;
        hasInitialWorkspace = true;
        resolveInitialWorkspace();

        if (!hasChanged) {
            return;
        }

        for (const listener of workspaceListeners) {
            notifyWorkspaceListener(listener);
        }
    }
}

function applyBodyStyles(): void {
    if (typeof document === 'undefined' || !document.body) {
        return;
    }
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.background = 'var(--background, var(--vscode-editor-background, #171717))';
    document.body.style.color = 'var(--foreground, var(--vscode-foreground, #d4d4d4))';
    document.body.style.fontFamily =
        'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)';
}

function createSecureFetch(token: string): (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> {
    return (url: RequestInfo | URL, options: RequestInit = {}): Promise<Response> => {
        const headers = new Headers(options.headers || {});
        headers.set('Content-Type', 'application/json');
        if (token) {
            headers.set('X-Sidecar-Token', token);
        }
        return fetch(url, { ...options, headers });
    };
}

async function resolveProjectId(
    secureFetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response>,
    conversationId: string,
): Promise<string> {
    if (!conversationId) {
        return '';
    }
    try {
        const res = await secureFetch('/_sidecar/get-conversation-metadata', {
            method: 'POST',
            body: JSON.stringify({ conversationId }),
        });
        if (!res.ok) {
            console.error(`Failed to resolve project ID for conversation ${conversationId}:`, await res.text());
            return '';
        }
        const data = (await res.json()) as {
            readonly error?: string;
            readonly response?: {
                readonly conversationMetadata?: {
                    readonly metadata?: { readonly projectId?: string; readonly project_id?: string };
                };
                readonly conversation_metadata?: {
                    readonly metadata?: { readonly projectId?: string; readonly project_id?: string };
                };
            };
        };
        if (data?.error) {
            console.error('agentapi returned error resolving project ID:', data.error);
            return '';
        }
        const metaEvent = data?.response?.conversationMetadata || data?.response?.conversation_metadata;
        const meta = metaEvent?.metadata;
        return meta?.projectId || meta?.project_id || '';
    } catch (err) {
        console.error(`Failed to resolve project ID for conversation ${conversationId}:`, err);
        return '';
    }
}

async function getWorkspaceUris(): Promise<string[]> {
    if (typeof window !== 'undefined' && window.parent === window) {
        return [];
    }
    await initialWorkspacePromise;
    return [...currentWorkspaceUris];
}

function onWorkspaceChange(listener: (workspaceUris: string[]) => void): () => void {
    if (typeof listener !== 'function') {
        return () => {};
    }
    workspaceListeners.add(listener);
    if (hasInitialWorkspace) {
        queueMicrotask(() => {
            if (workspaceListeners.has(listener)) {
                notifyWorkspaceListener(listener);
            }
        });
    }
    return () => {
        workspaceListeners.delete(listener);
    };
}

function createAgentBridge(
    secureFetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response>,
    projectIdPromise: Promise<string>,
    conversationId: string,
): SidecarAgentBridge {
    return {
        async sendMessage(message: string, convId?: string): Promise<AgentMessageResponse> {
            const resolvedProjectId = await projectIdPromise;
            const res = await secureFetch('/_sidecar/send-message', {
                method: 'POST',
                body: JSON.stringify({
                    conversationId: convId || conversationId,
                    message,
                    projectId: resolvedProjectId,
                }),
            });
            if (!res.ok) {
                throw new Error(await res.text());
            }
            return (await res.json()) as AgentMessageResponse;
        },

        async startConversation(message: string, title?: string): Promise<NewConversationResult> {
            const resolvedProjectId = await projectIdPromise;
            const res = await secureFetch('/_sidecar/new-conversation', {
                method: 'POST',
                body: JSON.stringify({ message, title, projectId: resolvedProjectId }),
            });
            if (!res.ok) {
                throw new Error(await res.text());
            }
            return (await res.json()) as NewConversationResult;
        },

        async getConversationMetadata(targetConvId?: string): Promise<ConversationMetadata> {
            const res = await secureFetch('/_sidecar/get-conversation-metadata', {
                method: 'POST',
                body: JSON.stringify({ conversationId: targetConvId || conversationId }),
            });
            if (!res.ok) {
                throw new Error(await res.text());
            }
            return (await res.json()) as ConversationMetadata;
        },
    };
}

function createUiBridge(): SidecarUiBridge {
    return {
        toggleAuxPane(request?: { readonly mode?: SidecarPaneMode; readonly focus?: boolean } | unknown): void {
            if (typeof window === 'undefined') {
                return;
            }
            window.parent.postMessage(
                {
                    type: 'toggle-aux-pane',
                    payload: request,
                },
                '*',
            );
        },

        toggleConversation(targetConvId: string): void {
            if (typeof window === 'undefined') {
                return;
            }
            window.parent.postMessage(
                {
                    type: 'toggle-conversation',
                    payload: { conversationId: targetConvId },
                },
                '*',
            );
        },
    };
}

function initSidecarBridge(): void {
    if (typeof window === 'undefined') {
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') ?? '';
    const conversationId = params.get('conversationId') ?? '';

    window.addEventListener('message', handleHostMessage);

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyBodyStyles);
        } else {
            applyBodyStyles();
        }
    }

    const secureFetch = createSecureFetch(token);
    const projectIdPromise = resolveProjectId(secureFetch, conversationId);

    const bridge: SidecarBridge = {
        conversationId,
        fetch: secureFetch,
        getWorkspaceUris,
        onWorkspaceChange,
        agent: createAgentBridge(secureFetch, projectIdPromise, conversationId),
        ui: createUiBridge(),
    };

    if (!window.sidecar) {
        window.sidecar = bridge;
        return;
    }

    // If window.sidecar was already mock-injected (e.g. in test fixtures), preserve its custom methods
    const existing = window.sidecar;
    window.sidecar = {
        conversationId: existing.conversationId || bridge.conversationId,
        fetch: existing.fetch || bridge.fetch,
        getWorkspaceUris: existing.getWorkspaceUris || bridge.getWorkspaceUris,
        onWorkspaceChange: existing.onWorkspaceChange || bridge.onWorkspaceChange,
        agent: existing.agent || bridge.agent,
        ui: existing.ui || bridge.ui,
    };
}

initSidecarBridge();
