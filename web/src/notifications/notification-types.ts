/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type NotificationSeverity = 'info' | 'warning' | 'error';

export type NotificationPosition = 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left';

export interface NotificationItem {
    id: string;
    severity: NotificationSeverity;
    message: string;
    actions: string[];
    timestamp: number;
    timeoutMs?: number;
    resolve: (action?: string) => void;
    dismiss: () => void;
}
