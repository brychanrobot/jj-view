/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as React from 'react';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { getWebviewTransport } from './registry';
import type { WebviewTransport } from './types';

const BridgeContext = createContext<WebviewTransport | null>(null);

export interface BridgeProviderProps {
    transport?: WebviewTransport;
    children: React.ReactNode;
}

export const BridgeProvider: React.FC<BridgeProviderProps> = ({ transport, children }) => {
    const activeTransport = useMemo(() => transport ?? getWebviewTransport(), [transport]);

    return <BridgeContext.Provider value={activeTransport}>{children}</BridgeContext.Provider>;
};

export function useBridge(): WebviewTransport {
    const context = useContext(BridgeContext);
    if (!context) {
        return getWebviewTransport();
    }
    return context;
}

export function useMessageListener<T = unknown>(handler: (message: T) => void): void {
    const bridge = useBridge();
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        const unsubscribe = bridge.onMessage((msg) => {
            handlerRef.current(msg as T);
        });
        return () => {
            unsubscribe();
        };
    }, [bridge]);
}
